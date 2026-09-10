const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./studio.js');

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function fromHex(str) {
  return Uint8Array.from(str.split(' ').map((h) => parseInt(h, 16)));
}

test('varint は 1 バイトと 2 バイトの境界(127/128)を正しく符号化・復号する', () => {
  for (const n of [0, 1, 127, 128, 16383, 16384]) {
    const bytes = S._encodeVarint(n);
    const { value, next } = S._decodeVarint(Uint8Array.from(bytes), 0);
    assert.equal(value, n);
    assert.equal(next, bytes.length);
  }
});

test('varint は uint32 の最大値(2^32-1)まで正しく往復する', () => {
  const n = 0xffffffff;
  const bytes = S._encodeVarint(n);
  assert.equal(bytes.length, 5);
  const { value } = S._decodeVarint(Uint8Array.from(bytes), 0);
  assert.equal(value, n);
});

test('zigzag は正負の境界値(0/-1/1/-2)を正しく符号化・復号する', () => {
  const cases = [[0, 0], [-1, 1], [1, 2], [-2, 3], [2, 4]];
  for (const [n, z] of cases) {
    assert.equal(S._zigzagEncode(n), z);
    assert.equal(S._zigzagDecode(z), n);
  }
});

test('フレーミングは本体中の SOF/ESC/EOF をエスケープして往復する', () => {
  const body = Uint8Array.from([0x01, S.FRAMING.SOF, 0x02, S.FRAMING.ESC, 0x03, S.FRAMING.EOF, 0x04]);
  const framed = S.frameEncode(body);
  assert.equal(hex(framed), 'ab 01 ac ab 02 ac ac 03 ac ad 04 ad');
  const decoder = S.createFrameDecoder();
  const frames = decoder.push(framed);
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]), Array.from(body));
});

test('1 本のフレームが 3 つのチャンクに分割されて届いても正しく再組み立てされる', () => {
  const body = Uint8Array.from([0x10, 0x20, 0x30, 0x40, 0x50]);
  const framed = S.frameEncode(body);
  const decoder = S.createFrameDecoder();
  const c1 = framed.slice(0, 2);
  const c2 = framed.slice(2, 5);
  const c3 = framed.slice(5);
  assert.deepEqual(decoder.push(c1), []);
  assert.deepEqual(decoder.push(c2), []);
  const frames = decoder.push(c3);
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]), Array.from(body));
});

test('本体中に無断の SOF が来て ERR 状態になっても次の SOF から復帰する', () => {
  const decoder = S.createFrameDecoder();
  const bad = Uint8Array.from([S.FRAMING.SOF, 0x01, 0x02, S.FRAMING.SOF]); // 2つ目の SOF で ERR へ
  assert.deepEqual(decoder.push(bad), []);
  const good = S.frameEncode(Uint8Array.from([0x09, 0x08]));
  const frames = decoder.push(good);
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]), [0x09, 0x08]);
});

test('encodeRequest は {requestId, core:{getDeviceInfo}} を手計算どおりのバイト列にする', () => {
  // requestId: tag=(1<<3)|0=0x08, val=1 -> 08 01
  // core: tag=(3<<3)|2=0x1a, len=2, 内側 core.Request{getDeviceInfo:true}: tag=(1<<3)|0=0x08, val=1 -> 08 01
  const bytes = S.encodeRequest({ requestId: 1, core: { getDeviceInfo: true } });
  assert.equal(hex(bytes), '08 01 1a 02 08 01');
});

test('encodeRequest は keymap.getKeymap の oneof を手計算どおりのバイト列にする', () => {
  // requestId: 08 05
  // keymap: tag=(5<<3)|2=0x2a, len=2, 内側 keymap.Request{getKeymap:true}: 08 01
  const bytes = S.encodeRequest({ requestId: 5, keymap: { getKeymap: true } });
  assert.equal(hex(bytes), '08 05 2a 02 08 01');
});

test('encodeRequest は behaviors.listAllBehaviors の oneof を手計算どおりのバイト列にする', () => {
  // requestId: 08 02
  // behaviors: tag=(4<<3)|2=0x22, len=2, 内側 behaviors.Request{listAllBehaviors:true}: 08 01
  const bytes = S.encodeRequest({ requestId: 2, behaviors: { listAllBehaviors: true } });
  assert.equal(hex(bytes), '08 02 22 02 08 01');
});

test('encodeRequest は setLayerBinding のネストした sint32/int32/uint32 を手計算どおりのバイト列にする', () => {
  // requestId: 08 01
  // keymap: tag=(5<<3)|2=0x2a
  //   setLayerBinding: tag=(2<<3)|2=0x12
  //     layerId(uint32=2): tag=08, val=2 -> 08 02
  //     keyPosition(int32=3): tag=(2<<3)|0=0x10, val=3 -> 10 03
  //     binding: tag=(3<<3)|2=0x1a
  //       behaviorId(sint32=-1): zigzag(-1)=1, tag=08, val=1 -> 08 01
  //       param1(uint32=10): tag=0x10, val=10(0x0a) -> 10 0a
  //       param2(uint32=0): tag=0x18, val=0 -> 18 00
  //     binding 本体 = 08 01 10 0a 18 00 (6 バイト) -> 1a 06 [本体]
  //   setLayerBinding 本体 = 08 02 10 03 1a 06 08 01 10 0a 18 00 (12 バイト) -> 12 0c [本体]
  //   keymap 本体 = 12 0c [本体](14 バイト) -> 2a 0e [本体]
  const bytes = S.encodeRequest({
    requestId: 1,
    keymap: {
      setLayerBinding: {
        layerId: 2,
        keyPosition: 3,
        binding: { behaviorId: -1, param1: 10, param2: 0 },
      },
    },
  });
  assert.equal(hex(bytes), '08 01 2a 0e 12 0c 08 02 10 03 1a 06 08 01 10 0a 18 00');
});

test('int32 の負値は 64 ビット符号拡張した 10 バイトの varint で符号化・復号される', () => {
  // BehaviorParameterValueDescriptionRange.min(int32) に -1 を渡す
  const bytes = S._encodeMessage('zmk.behaviors.BehaviorParameterValueDescriptionRange', { min: -1, max: 5 });
  // min: tag=08, 値-1の64ビット符号拡張varintは既知のプロトコルバッファ仕様どおり ff*9 01 の10バイト
  // max: tag=0x10, val=5 -> 10 05
  assert.equal(hex(bytes), '08 ff ff ff ff ff ff ff ff ff 01 10 05');
  const decoded = S._decodeMessage('zmk.behaviors.BehaviorParameterValueDescriptionRange', bytes);
  assert.deepEqual(decoded, { min: -1, max: 5 });
});

test('decodeResponse は requestResponse.core.getDeviceInfo を復号する', () => {
  const bytes = S._encodeMessage('zmk.studio.Response', {
    requestResponse: { requestId: 9, core: { getDeviceInfo: { name: 'LalaPad', serialNumber: Uint8Array.from([1, 2, 3]) } } },
  });
  const decoded = S.decodeResponse(bytes);
  assert.equal(decoded.requestResponse.requestId, 9);
  assert.equal(decoded.requestResponse.core.getDeviceInfo.name, 'LalaPad');
  assert.deepEqual(Array.from(decoded.requestResponse.core.getDeviceInfo.serialNumber), [1, 2, 3]);
});

test('decodeResponse は requestResponse.behaviors.listAllBehaviors の packed uint32 を復号する', () => {
  const bytes = S._encodeMessage('zmk.studio.Response', {
    requestResponse: { requestId: 3, behaviors: { listAllBehaviors: { behaviors: [1, 2, 300] } } },
  });
  const decoded = S.decodeResponse(bytes);
  assert.deepEqual(decoded.requestResponse.behaviors.listAllBehaviors.behaviors, [1, 2, 300]);
});

test('decodeResponse は requestResponse.meta.simpleError を復号する', () => {
  const bytes = S._encodeMessage('zmk.studio.Response', {
    requestResponse: { requestId: 4, meta: { simpleError: 1 } },
  });
  const decoded = S.decodeResponse(bytes);
  assert.equal(decoded.requestResponse.meta.simpleError, 1);
});

test('decodeResponse は notification.keymap.unsavedChangesStatusChanged を復号する', () => {
  const bytes = S._encodeMessage('zmk.studio.Response', {
    notification: { keymap: { unsavedChangesStatusChanged: true } },
  });
  const decoded = S.decodeResponse(bytes);
  assert.equal(decoded.notification.keymap.unsavedChangesStatusChanged, true);
});

test('decodeResponse は未知フィールドを読み飛ばして残りを復号する', () => {
  const known = S._encodeMessage('zmk.studio.RequestResponse', { requestId: 1, core: { getLockState: 1 } });
  const unknownField = Uint8Array.from([...S._encodeVarint((99 << 3) | 0), ...S._encodeVarint(123)]);
  const merged = Uint8Array.from([...unknownField, ...known]);
  const decoded = S._decodeMessage('zmk.studio.RequestResponse', merged);
  assert.equal(decoded.requestId, 1);
  assert.equal(decoded.core.getLockState, 1);
});

function makeClient() {
  const sent = [];
  const client = S.createClient({ send: (bytes) => sent.push(bytes), timeoutMs: 50 });
  return { client, sent };
}

function decodeSentRequest(framed) {
  const decoder = S.createFrameDecoder();
  const [body] = decoder.push(framed);
  return S._decodeMessage('zmk.studio.Request', body);
}

function respond(client, requestId, rrFields) {
  const bytes = S._encodeMessage('zmk.studio.Response', {
    requestResponse: Object.assign({ requestId }, rrFields),
  });
  client.onData(S.frameEncode(bytes));
}

test('クライアントは要求と応答を requestId で対応付けて Promise を解決する', async () => {
  const { client, sent } = makeClient();
  const p = client.getDeviceInfo();
  const req = decodeSentRequest(sent[0]);
  assert.equal(req.core.getDeviceInfo, true);
  respond(client, req.requestId, { core: { getDeviceInfo: { name: 'X', serialNumber: Uint8Array.from([]) } } });
  const info = await p;
  assert.equal(info.name, 'X');
});

test('クライアントは meta.simpleError を受け取ると日本語メッセージと code つきの Error で reject する', async () => {
  const { client, sent } = makeClient();
  const p = client.getLockState();
  const req = decodeSentRequest(sent[0]);
  respond(client, req.requestId, { meta: { simpleError: 2 } });
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 2);
    assert.match(err.message, /RPC/);
    return true;
  });
});

test('クライアントは応答が届かないまま timeoutMs を過ぎるとタイムアウトで reject する', async () => {
  const { client } = makeClient();
  const p = client.checkUnsavedChanges();
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'TIMEOUT');
    return true;
  });
});

test('クライアントは通知を onNotification に渡す', () => {
  const { client } = makeClient();
  const received = [];
  client.onNotification = (n) => received.push(n);
  const bytes = S._encodeMessage('zmk.studio.Response', {
    notification: { keymap: { unsavedChangesStatusChanged: true } },
  });
  client.onData(S.frameEncode(bytes));
  assert.equal(received.length, 1);
  assert.equal(received[0].keymap.unsavedChangesStatusChanged, true);
});

test('クライアントは addLayer が err を返すと code つきの Error で reject する', async () => {
  const { client, sent } = makeClient();
  const p = client.addLayer();
  const req = decodeSentRequest(sent[0]);
  respond(client, req.requestId, { keymap: { addLayer: { err: 2 } } });
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 2);
    return true;
  });
});

test('クライアントは addLayer が ok を返すと index とレイヤーを解決する', async () => {
  const { client, sent } = makeClient();
  const p = client.addLayer();
  const req = decodeSentRequest(sent[0]);
  respond(client, req.requestId, {
    keymap: { addLayer: { ok: { index: 2, layer: { id: 9, name: 'L2', bindings: [{ behaviorId: 1, param1: 0, param2: 0 }] } } } },
  });
  const result = await p;
  assert.deepEqual(result, { index: 2, layer: { id: 9, name: 'L2', bindings: [{ behaviorId: 1, param1: 0, param2: 0 }] } });
});

test('クライアントは setLayerBinding の応答コードをそのまま返す(0 で OK)', async () => {
  const { client, sent } = makeClient();
  const p = client.setLayerBinding(0, 3, { behaviorId: 1, param1: 2, param2: 0 });
  const req = decodeSentRequest(sent[0]);
  assert.deepEqual(req.keymap.setLayerBinding, { layerId: 0, keyPosition: 3, binding: { behaviorId: 1, param1: 2, param2: 0 } });
  respond(client, req.requestId, { keymap: { setLayerBinding: 0 } });
  assert.equal(await p, 0);
});

test('クライアントは getBehaviorDetails の metadata を desc の形に整形する', async () => {
  const { client, sent } = makeClient();
  const p = client.getBehaviorDetails(3);
  const req = decodeSentRequest(sent[0]);
  assert.equal(req.behaviors.getBehaviorDetails.behaviorId, 3);
  respond(client, req.requestId, {
    behaviors: {
      getBehaviorDetails: {
        id: 3,
        displayName: 'Key Press',
        metadata: [{
          param1: [{ name: 'keycode', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }],
          param2: [{ name: 'unused', nil: {} }],
        }],
      },
    },
  });
  const detail = await p;
  assert.deepEqual(detail, {
    id: 3,
    displayName: 'Key Press',
    metadata: [{
      param1: [{ name: 'keycode', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }],
      param2: [{ name: 'unused', nil: true }],
    }],
  });
});

test('クライアントは dispose すると保留中の要求をすべて reject する', async () => {
  const { client } = makeClient();
  const p1 = client.getLockState();
  const p2 = client.checkUnsavedChanges();
  client.dispose();
  await assert.rejects(p1, (err) => { assert.equal(err.code, 'DISPOSED'); return true; });
  await assert.rejects(p2, (err) => { assert.equal(err.code, 'DISPOSED'); return true; });
});

test('キーコード表の A は素の HID usage を、LC(A) 相当は modifier ビットを乗せた値になる', () => {
  const K = require('./keycodes.js');
  const a = K.KEYS.find((k) => k.name === 'A');
  assert.equal(a.value, K.encodeUsage(a.page, a.id, 0));
  const lcA = K.encodeUsage(a.page, a.id, K.MODS.LC);
  assert.deepEqual(K.decodeUsage(lcA), { page: a.page, id: a.id, mods: K.MODS.LC });
  assert.equal(K.findByValue(a.value).name, 'A');
  assert.equal(K.findByValue(lcA), null);
});

test('キーコード表は N1/NUMBER_1 のような別名を 1 つの項目に正規化する', () => {
  const K = require('./keycodes.js');
  const n1 = K.KEYS.find((k) => k.name === 'N1');
  assert.ok(n1);
  assert.ok(n1.aliases.includes('NUMBER_1'));
  assert.ok(!K.KEYS.some((k) => k.name === 'NUMBER_1'));
});

test('値 0 のフィールドが省略された物理レイアウト応答を復号すると、activeLayoutIndex とキーの x/y が 0 で補われる', () => {
  // Response{request_response{request_id=2, keymap{get_physical_layouts{layouts[{name:"D", keys[{width:100,height:100}]}]}}}}
  const keys = [0x08, 0xc8, 0x01, 0x10, 0xc8, 0x01];
  const layout = [0x0a, 0x01, 0x44, 0x12, keys.length, ...keys];
  const layouts = [0x12, layout.length, ...layout];
  const keymap = [0x32, layouts.length, ...layouts];
  const rr = [0x08, 0x02, 0x2a, keymap.length, ...keymap];
  const resp = Uint8Array.from([0x0a, rr.length, ...rr]);
  const d = S.decodeResponse(resp).requestResponse.keymap.getPhysicalLayouts;
  assert.equal(d.activeLayoutIndex, 0);
  assert.equal(d.layouts[0].keys[0].x, 0);
  assert.equal(d.layouts[0].keys[0].y, 0);
  assert.equal(d.layouts[0].keys[0].width, 100);
});

test('EOF が届かなくても、応答本体が先頭の長さぶん揃えばフレームとして完成する(遅れて来た EOF は無視)', () => {
  const body = [0x0a, 0x06, 0x08, 0x01, 0x1a, 0x02, 0x10, 0x01];
  const dec = S.createFrameDecoder();
  const first = dec.push(Uint8Array.from([0xab, ...body.slice(0, 5)]));
  assert.equal(first.length, 0);
  const rest = dec.push(Uint8Array.from(body.slice(5)));
  assert.equal(rest.length, 1);
  assert.deepEqual(Array.from(rest[0]), body);
  assert.equal(dec.push(Uint8Array.from([0xad])).length, 0);
  const next = dec.push(Uint8Array.from([0xab, ...body, 0xad]));
  assert.equal(next.length, 1);
});
