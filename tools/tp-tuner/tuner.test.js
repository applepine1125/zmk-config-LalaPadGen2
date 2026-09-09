const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./tuner.js');

test('tp list の1行をパースすると名前と値と範囲と種別が取れる', () => {
  assert.deepEqual(T.parseListLine('1f_tap_max_ms 250 1 1000 driver 250'), {
    name: '1f_tap_max_ms', value: 250, min: 1, max: 1000, kind: 'driver', def: 250,
  });
  assert.equal(T.parseListLine('uart:~$ '), null);
  assert.equal(T.parseListLine(''), null);
});

test('tp info の行をパースすると側と uptime が取れる', () => {
  assert.deepEqual(T.parseInfoLine('side=central uptime_ms=12345 params=50'),
    { side: 'central', uptimeMs: 12345, params: 50, saved: null });
  assert.equal(T.parseInfoLine('OK reset'), null);
});

test('tp info の行に saved= が付くと真偽値としてパースされる', () => {
  assert.deepEqual(T.parseInfoLine('side=central uptime_ms=12345 params=50 saved=yes'),
    { side: 'central', uptimeMs: 12345, params: 50, saved: true });
  assert.deepEqual(T.parseInfoLine('side=peripheral uptime_ms=1 params=10 saved=no'),
    { side: 'peripheral', uptimeMs: 1, params: 10, saved: false });
});

test('ログ接頭辞つきの T F 行をパースするとフレームになる', () => {
  const line = '[00:00:12.345,678] <inf> iqs9151: T F 12345 1 3 -2 1000 1500 0 0 0110 0 0 1';
  assert.deepEqual(T.parseTraceLine(line), {
    type: 'F', ms: 12345, fingers: 1, relX: 3, relY: -2, f1x: 1000, f1y: 1500,
    f2x: 0, f2y: 0, flags: 0x0110, hold: 0, mode2f: 0, pending: 1,
  });
});

test('T E 行をパースするとキー報告と戻り値になる', () => {
  assert.deepEqual(T.parseTraceLine('T E 500 K 272 0 -12'),
    { type: 'E', ms: 500, kind: 'K', code: 272, value: 0, ret: -12 });
  assert.deepEqual(T.parseTraceLine('T E 501 R 8 -3 0'),
    { type: 'E', ms: 501, kind: 'R', code: 8, value: -3, ret: 0 });
  assert.equal(T.parseTraceLine('OK trace=on'), null);
});

test('T S 行をパースすると試行要約になる', () => {
  const line = 'T S 1000 1200 1 1 120 -1 5 0 0 0 1 1 0 0 3 0 0';
  assert.deepEqual(T.parseTraceLine(line), {
    type: 'S', startMs: 1000, endMs: 1200, contacts: 1, fingersMax: 1, downMs: 120, gapMs: -1,
    moveSum: 5, centroidMove: 0, distDelta: 0, mode2f: 0, btnPressBits: 1, btnReleaseBits: 1,
    wheelCount: 0, wheelSum: 0, relCount: 3, drops: 0, hold: 0,
  });
});

test('ログ接頭辞つきの T S 行もパースできる', () => {
  const line = '[00:00:12.345,678] <inf> iqs9151: T S 1000 1200 1 1 120 -1 5 0 0 0 1 1 0 0 3 0 0';
  assert.deepEqual(T.parseTraceLine(line), {
    type: 'S', startMs: 1000, endMs: 1200, contacts: 1, fingersMax: 1, downMs: 120, gapMs: -1,
    moveSum: 5, centroidMove: 0, distDelta: 0, mode2f: 0, btnPressBits: 1, btnReleaseBits: 1,
    wheelCount: 0, wheelSum: 0, relCount: 3, drops: 0, hold: 0,
  });
});

test('フィールド数が合わない T S 行は null になる', () => {
  assert.equal(T.parseTraceLine('T S 1000 1200 1'), null);
});

test('ANSI エスケープを除去してプロンプトを判定できる', () => {
  assert.equal(T.stripAnsi('\x1b[1;32muart:~$ \x1b[0m'), 'uart:~$ ');
  assert.equal(T.isPrompt('uart:~$ '), true);
  assert.equal(T.isPrompt('OK reset'), false);
});

test('カーソル保存・復元の 2 バイトエスケープも除去できる', () => {
  assert.equal(T.stripAnsi('\x1b7uart:~$ \x1b8'), 'uart:~$ ');
  assert.equal(T.stripAnsi('\x1b[2K\x1b7T E 1 K 272 0 0\x1b8'), 'T E 1 K 272 0 0');
});

test('プロンプトとエコーが同じ行にあるとき、プロンプト接頭辞を除くとコマンドだけになる', () => {
  assert.equal(T.stripPromptPrefix('uart:~$ tp info'), 'tp info');
});

test('エコーだけの行はプロンプト接頭辞の除去で変わらない', () => {
  assert.equal(T.stripPromptPrefix('tp info'), 'tp info');
});

test('エコーでない行はプロンプト接頭辞の除去で変わらない', () => {
  assert.equal(T.stripPromptPrefix('side=central uptime_ms=1 params=50'), 'side=central uptime_ms=1 params=50');
  assert.equal(T.stripPromptPrefix('OK trace=off'), 'OK trace=off');
});

test('送信したコマンドと一致する行だけをエコーと判定する', () => {
  assert.equal(T.isEcho('uart:~$ tp info', 'tp info'), true);
  assert.equal(T.isEcho('tp info', 'tp info'), true);
  assert.equal(T.isEcho('side=central uptime_ms=1 params=50', 'tp info'), false);
  assert.equal(T.isEcho('uart:~$ ', 'tp info'), false);
  assert.equal(T.isEcho('OK trace=off', 'tp trace off'), false);
  assert.equal(T.isEcho('tp info', ''), false);
});

test('往復時間の半分を補正した時刻オフセットを計算できる', () => {
  assert.equal(T.clockOffset(1000, 1020, 500), 510);
});

test('R または L で始まる行から側と残りを取り出せる', () => {
  assert.deepEqual(T.splitSidePrefix('R OK a=1'), { side: 'R', rest: 'OK a=1' });
  assert.deepEqual(T.splitSidePrefix('L .'), { side: 'L', rest: '.' });
});

test('側の接頭辞がない行は splitSidePrefix が null を返す', () => {
  assert.equal(T.splitSidePrefix('OK a=1'), null);
  assert.equal(T.splitSidePrefix(''), null);
});

test('bleCommand は tp を外して側を前置する', () => {
  assert.equal(T.bleCommand('L', 'tp set a 1'), 'L set a 1');
  assert.equal(T.bleCommand('R', 'tp info'), 'R info');
});

test('bleCommand は tp 接頭辞がなくてもそのまま前置する', () => {
  assert.equal(T.bleCommand('R', 'info'), 'R info');
});

test('isEndMarker はピリオド1文字だけを終端行と判定する', () => {
  assert.equal(T.isEndMarker('.'), true);
  assert.equal(T.isEndMarker('OK .'), false);
  assert.equal(T.isEndMarker(''), false);
});

test('orderDevices は BLE を先頭に USB を列挙順のまま後ろへ並べる', () => {
  const usb1 = { id: 'u1', kind: 'usb', name: 'usbmodem1' };
  const usb2 = { id: 'u2', kind: 'usb', name: 'usbmodem2' };
  const ble = { id: 'b1', kind: 'ble', name: 'LalapadGen2' };
  assert.deepEqual(T.orderDevices([usb1, ble, usb2]), [ble, usb1, usb2]);
});

test('orderDevices は候補が空なら空配列を返す', () => {
  assert.deepEqual(T.orderDevices([]), []);
  assert.deepEqual(T.orderDevices(undefined), []);
});

test('lastInfo が null のとき pickPortOrder は元の順序のまま返す', () => {
  const a = { getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) };
  const b = { getInfo: () => ({ usbVendorId: 3, usbProductId: 4 }) };
  assert.deepEqual(T.pickPortOrder([a, b], null), [a, b]);
});

test('lastInfo に一致するポートが先頭に来るよう並べ替える', () => {
  const a = { getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) };
  const b = { getInfo: () => ({ usbVendorId: 3, usbProductId: 4 }) };
  const c = { getInfo: () => ({ usbVendorId: 3, usbProductId: 4 }) };
  assert.deepEqual(T.pickPortOrder([a, b, c], { usbVendorId: 3, usbProductId: 4 }), [b, c, a]);
});

test('lastInfo に一致するポートがなければ pickPortOrder は元の順序のまま返す', () => {
  const a = { getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) };
  const b = { getInfo: () => ({ usbVendorId: 3, usbProductId: 4 }) };
  assert.deepEqual(T.pickPortOrder([a, b], { usbVendorId: 9, usbProductId: 9 }), [a, b]);
});

test('getInfo を持たないポートが混ざっていても pickPortOrder は例外を投げず元の順序を保つ', () => {
  const a = { getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) };
  const b = {};
  assert.deepEqual(T.pickPortOrder([a, b], { usbVendorId: 1, usbProductId: 2 }), [a, b]);
});

test('パラメータ名を CONFIG 名に変換できる', () => {
  assert.equal(T.toConfName('1f_tap_max_ms'), 'CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS');
});

test('差分だけを .conf 行にすると bool は y/n になり変更のない行は出ない', () => {
  const params = [
    { name: '1f_tap_max_ms', value: 200, def: 250, kind: 'driver' },
    { name: '1f_tap_enable', value: 0, def: 1, kind: 'driver_bool' },
    { name: '1f_tap_move', value: 50, def: 50, kind: 'driver' },
  ];
  assert.equal(T.exportConf(params, { diffOnly: true }),
    'CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS=200\nCONFIG_INPUT_IQS9151_1F_TAP_ENABLE=n\n');
  assert.equal(T.exportConf(params, { diffOnly: false }).split('\n').filter(Boolean).length, 3);
});

test('戻り値が 0 でない報告をドロップとして検出できる', () => {
  const ev = [
    { t: 10, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 20, type: 'E', kind: 'K', code: 272, value: 0, ret: -12 },
  ];
  assert.deepEqual(T.detectDrops(ev), [{ t: 20, code: 272, kind: 'K' }]);
});

test('ドライバが離した後にホストのボタンが押されたままなら stuck として検出できる', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }, { t: 700, buttons: 1 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), [{ t: 300, code: 272 }]);
});

test('ドライバが離した後にホストも離していれば stuck にならない', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }, { t: 310, buttons: 0 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), []);
});

test('離してから holdMs が経っていないときは now を渡すと stuck と判定しない', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300, now: 500 }), []);
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300, now: 600 }), [{ t: 300, code: 272 }]);
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), [{ t: 300, code: 272 }]);
});

test('ドライバが wheel を送ったのにホストに wheel が届かなければ検出できる', () => {
  const fw = [{ t: 100, type: 'E', kind: 'R', code: 8, value: 2, ret: 0 }];
  assert.deepEqual(T.detectMissingWheel(fw, [], { windowMs: 200 }), [{ t: 100 }]);
  assert.deepEqual(T.detectMissingWheel(fw, [{ t: 150, deltaY: 4 }], { windowMs: 200 }), []);
});

test('2本指で動いているのにドライバが wheel を出さなければ検出できる', () => {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    frames.push({ t: i * 10, type: 'F', fingers: 2, relX: 0, relY: 3 });
  }
  assert.deepEqual(T.detectTwoFingerNoScroll(frames, [], { minMove: 30, windowMs: 200 }),
    [{ t: 0 }]);
  const fw = [{ t: 120, type: 'E', kind: 'R', code: 8, value: 1, ret: 0 }];
  assert.deepEqual(T.detectTwoFingerNoScroll(frames, fw, { minMove: 30, windowMs: 200 }), []);
});

const PARAMS = {
  '1f_tap_max_ms': 250, '1f_tap_move': 50, '1f_tapdrag_gap_max_ms': 160,
  '2f_tap_max_ms': 250, '2f_tap_move': 50, '2f_scroll_start_move': 15, '2f_pinch_start_distance': 30,
  '3f_tap_max_ms': 200, '3f_tap_move': 35,
};

function frames(from, to, fingers, extra) {
  const out = [];
  for (let t = from; t <= to; t += 10) {
    out.push({ type: 'F', t, fingers, relX: 0, relY: 0, f1x: 0, f1y: 0, f2x: 0, f2y: 0, hold: 0, mode2f: 0, pending: 0, ...(extra || {}) });
  }
  return out;
}
const K = (t, code, value) => ({ t, type: 'E', kind: 'K', code, value, ret: 0 });
const R = (t, code, value) => ({ t, type: 'E', kind: 'R', code, value, ret: 0 });
const HOST0 = { btn: [], move: [], wheel: [] };

test('指の接触が idleMs 以上離れていれば別の試行に分かれる', () => {
  const fr = frames(0, 100, 1).concat(frames(110, 600, 0), frames(610, 700, 1), frames(710, 1200, 0));
  const a = T.segmentAttempts(fr, { idleMs: 400 });
  assert.equal(a.length, 2);
  assert.equal(a[0].start, 0);
  assert.equal(a[0].end, 100);
  assert.equal(a[0].closed, true);
  assert.equal(a[1].start, 610);
  assert.equal(a[1].end, 700);
  assert.equal(a[1].closed, true);
});

test('タップ後すぐの再接触は同じ試行にまとまる', () => {
  const fr = frames(0, 100, 1).concat(frames(110, 200, 0), frames(210, 500, 1), frames(510, 1000, 0));
  const a = T.segmentAttempts(fr, { idleMs: 400 });
  assert.equal(a.length, 1);
  assert.equal(a[0].start, 0);
  assert.equal(a[0].end, 500);
  assert.equal(a[0].frames.length, 51);
});

test('離した後に idleMs 経っていない試行は closed にならず、now を渡せば時間経過で closed になる', () => {
  const fr = frames(0, 100, 1);
  assert.equal(T.segmentAttempts(fr, { idleMs: 400 })[0].closed, false);
  assert.equal(T.segmentAttempts(fr, { idleMs: 400, now: 300 })[0].closed, false);
  assert.equal(T.segmentAttempts(fr, { idleMs: 400, now: 500 })[0].closed, true);
});

test('直近フレームから現在の認識状態の文言を作れる', () => {
  assert.equal(T.describeState({ fingers: 0, hold: 0, mode2f: 0, pending: 0 }), '待機');
  assert.equal(T.describeState({ fingers: 1, hold: 0, mode2f: 0, pending: 0, relX: 3, relY: 0 }), '指 1 本 移動中');
  assert.equal(T.describeState({ fingers: 1, hold: 0, mode2f: 0, pending: 0, relX: 0, relY: 0 }), '指 1 本 接触中');
  assert.equal(T.describeState({ fingers: 1, hold: 272, mode2f: 0, pending: 0, relX: 2, relY: 0 }), 'ボタン押下中(左) ドラッグ');
  assert.equal(T.describeState({ fingers: 0, hold: 272, mode2f: 0, pending: 1 }), 'タップ後 2 回目の接触待ち(左ボタン保持中)');
  assert.equal(T.describeState({ fingers: 2, hold: 0, mode2f: 1, pending: 0 }), '2 本指 スクロール中');
  assert.equal(T.describeState({ fingers: 2, hold: 0, mode2f: 2, pending: 0 }), 'ピンチ中');
  assert.equal(T.describeState({ fingers: 2, hold: 0, mode2f: 0, pending: 0 }), '2 本指 接触中');
  assert.equal(T.describeState({ fingers: 3, hold: 0, mode2f: 0, pending: 0 }), '3 本指 接触中');
  assert.equal(T.describeState(null), '待機');
});

function observe(fr, fw, host) {
  return T.observeAttempt(T.segmentAttempts(fr)[0], fw || [], host || HOST0, { tailMs: 500 });
}

const TAP1_OK = {
  fr: frames(0, 120, 1).concat(frames(130, 290, 0, { hold: 272, pending: 1 }), frames(300, 700, 0)),
  fw: [K(125, 272, 1), K(290, 272, 0)],
  host: { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [], wheel: [] },
};

test('試行を観測すると押下時間・移動量・ボタン報告・ホストの down/up が事実として取れる', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host);
  assert.equal(o.fingersMax, 1);
  assert.equal(o.downMs, 120);
  assert.equal(o.moveSum, 0);
  assert.equal(o.gapMs, null);
  assert.equal(o.touches.length, 1);
  assert.deepEqual(o.buttonsPressed, [272]);
  assert.deepEqual(o.buttonsReleased, [272]);
  assert.deepEqual(o.keys, [{ t: 125, code: 272, value: 1 }, { t: 290, code: 272, value: 0 }]);
  assert.deepEqual(o.host, { down: [1], up: [1], moveCount: 0, wheelCount: 0, stuckBits: [] });
});

test('2 回接触した試行を観測すると 2 回目の間隔・移動量・保持していたボタンが取れる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 210, 0, { hold: 272, pending: 1 }), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const o = observe(fr, [K(125, 272, 1), K(805, 272, 0)]);
  assert.equal(o.touches.length, 2);
  assert.equal(o.gapMs, 100);
  assert.equal(o.touches[1].moveSum, 177);
  assert.deepEqual(o.touches[1].holds, [272]);
  assert.deepEqual(o.touches[0].holds, []);
});

test('2 本指の試行を観測すると 2 本指時の移動量・距離変化・mode2f・wheel 数が取れる', () => {
  const fr = frames(0, 100, 2, { relY: 4, f1x: 100, f1y: 100, f2x: 200, f2y: 100 })
    .concat(frames(110, 300, 2, { relY: 4, mode2f: 1, f1x: 100, f1y: 100, f2x: 240, f2y: 100 }), frames(310, 800, 0));
  const host = { btn: [], move: [], wheel: [{ t: 150, deltaX: 0, deltaY: 24 }] };
  const o = observe(fr, [R(120, 8, -1), R(170, 8, -1)], host);
  assert.equal(o.fingersMax, 2);
  assert.equal(o.moveSum2, 31 * 4);
  assert.equal(o.distDelta, 40);
  assert.deepEqual(o.mode2fSeen, [1]);
  assert.deepEqual(o.wheel, { count: 2, sum: -2 });
  assert.equal(o.host.wheelCount, 1);
});

test('ドライバが離した後もホストのボタンが立ったままなら stuckBits に載る', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, { btn: [{ t: 132, buttons: 1 }], move: [], wheel: [] });
  assert.deepEqual(o.host.stuckBits, [1]);
});

test('1本指タップの要約から observeAttempt と同じ形の観測が作れ、tap1 の全段階が成立する', () => {
  const s = T.parseTraceLine('T S 1000 1120 1 1 120 -1 0 0 0 0 1 1 0 0 0 0 0');
  const host = { btn: [{ t: 1007, buttons: 1 }, { t: 1127, buttons: 0 }], move: [], wheel: [] };
  const o = T.observationFromSummary(s, host, 0);
  assert.equal(o.fingersMax, 1);
  assert.equal(o.downMs, 120);
  assert.equal(o.gapMs, null);
  assert.equal(o.touches.length, 1);
  assert.deepEqual(o.buttonsPressed, [272]);
  assert.deepEqual(o.buttonsReleased, [272]);
  assert.deepEqual(o.host, { down: [1], up: [1], moveCount: 0, wheelCount: 0, stuckBits: [] });
});

test('タップドラッグの要約から観測が作れ、hold ビットが 2 回目の接触の holds に載りタップドラッグの全段階が成立する', () => {
  const s = T.parseTraceLine('T S 1000 1500 2 1 120 80 150 0 0 0 1 1 0 0 10 0 1');
  const host = { btn: [{ t: 1005, buttons: 1 }, { t: 1505, buttons: 0 }], move: [{ t: 1300, dx: 3, dy: 0 }], wheel: [] };
  const o = T.observationFromSummary(s, host, 0);
  assert.equal(o.touches.length, 2);
  assert.equal(o.gapMs, 80);
  assert.deepEqual(o.touches[1].holds, [272]);
});

test('2本指スクロールの要約から mode2f・wheel 件数・ホストの wheel 受信件数が観測になる', () => {
  const s = T.parseTraceLine('T S 2000 2500 1 2 500 -1 0 40 0 1 0 0 6 -24 6 0 0');
  const host = { btn: [], move: [], wheel: [{ t: 2100, deltaX: 0, deltaY: 4 }, { t: 3600, deltaX: 0, deltaY: 4 }] };
  const o = T.observationFromSummary(s, host, 0, { tailMs: 500 });
  assert.deepEqual(o.mode2fSeen, [1]);
  assert.deepEqual(o.wheel, { count: 6, sum: -24 });
  assert.equal(o.moveSum2, 40);
  assert.equal(o.host.wheelCount, 1);
});

test('ビットマスクから複数のボタンコードへ変換できる(ピンチの BTN_7 含む)', () => {
  const s = T.parseTraceLine('T S 0 300 1 2 300 -1 0 0 40 2 128 128 0 0 0 0 0');
  const o = T.observationFromSummary(s, HOST0, 0);
  assert.deepEqual(o.buttonsPressed, [279]);
  assert.deepEqual(o.buttonsReleased, [279]);
  assert.deepEqual(o.mode2fSeen, [2]);
  assert.equal(o.distDelta, 40);
});

test('clockOffset を渡すと観測の時刻がオフセット分ずれ、tail の分だけホスト取得窓が広がる', () => {
  const s = T.parseTraceLine('T S 1000 1120 1 1 120 -1 0 0 0 0 0 0 0 0 0 0 0');
  const o = T.observationFromSummary(s, HOST0, 50, { tailMs: 200 });
  assert.equal(o.start, 1050);
  assert.equal(o.end, 1170);
  assert.equal(o.windowEnd, 1370);
});

test('要約から作ったカーソル観測は approx フラグが立ち、認識文が要約のみである旨になる', () => {
  const s = T.parseTraceLine('T S 1000 1600 1 1 600 -1 234 0 0 0 0 0 0 0 57 0 0');
  const o = T.observationFromSummary(s, HOST0, 0);
  assert.equal(o.cursor.approx, true);
  assert.equal(T.recognitionText('cursor', o, PARAMS),
    '指 1 本 / 接触 600ms / 移動量 ファーム 234・ホスト 0 (要約のみ: 慣性・ふらつきの詳細はトレース ON で取得) → 移動 57 回送信 → ホスト受信なし');
});

test('summaryHostWindow: 次の試行開始が tail 内で分かっていれば tail をそこまでに縮め即座に ready になる', () => {
  assert.deepEqual(T.summaryHostWindow(1000, 1300, 1050, 500), { ready: true, tailMs: 300 });
});

test('summaryHostWindow: 次の試行開始が tail より先なら制約にならず tail いっぱいまで待つ', () => {
  assert.deepEqual(T.summaryHostWindow(1000, 2000, 1050, 500), { ready: false, tailMs: 500 });
  assert.deepEqual(T.summaryHostWindow(1000, 2000, 1500, 500), { ready: true, tailMs: 500 });
});

test('summaryHostWindow: 次の試行が分からなければ now が tail 経過するまで待つ', () => {
  assert.deepEqual(T.summaryHostWindow(1000, null, 1400, 500), { ready: false, tailMs: 500 });
  assert.deepEqual(T.summaryHostWindow(1000, null, 1500, 500), { ready: true, tailMs: 500 });
});

test('summaryHostWindow: 次の試行開始が既に過ぎていれば tail を 0 に切り詰めて即座に ready になる', () => {
  assert.deepEqual(T.summaryHostWindow(1000, 900, 1000, 500), { ready: true, tailMs: 0 });
});

test('観測からジェスチャ種別を参考推定できる', () => {
  assert.equal(T.inferKind(observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host), PARAMS), 'tap1');
  const drag = frames(0, 120, 1).concat(frames(130, 210, 0), frames(220, 800, 1, { relX: 3 }), frames(810, 1400, 0));
  assert.equal(T.inferKind(observe(drag), PARAMS), 'tapdrag');
  const scroll = frames(0, 500, 2, { relY: 4, mode2f: 1 }).concat(frames(510, 1000, 0));
  assert.equal(T.inferKind(observe(scroll), PARAMS), 'scroll2');
  const pinch = frames(0, 300, 2, { mode2f: 2 }).concat(frames(310, 800, 0));
  assert.equal(T.inferKind(observe(pinch), PARAMS), 'pinch');
  const tap2 = frames(0, 100, 2).concat(frames(110, 600, 0));
  assert.equal(T.inferKind(observe(tap2), PARAMS), 'tap2');
  const tap3 = frames(0, 100, 3).concat(frames(110, 600, 0));
  assert.equal(T.inferKind(observe(tap3), PARAMS), 'tap3');
  const move = frames(0, 600, 1, { relX: 5 }).concat(frames(610, 1100, 0));
  assert.equal(T.inferKind(observe(move), PARAMS), 'move');
});

test('観測をドライバの見え方とホスト側の一文にできる', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host);
  assert.equal(T.observationText(o), '指 1 本 / 押下 120ms / 移動 0 / ボタン 272(左) 押→離');
  assert.equal(T.hostText(o), '左クリック 1 回');
  const drag = frames(0, 120, 1).concat(frames(130, 210, 0), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const od = observe(drag, [K(125, 272, 1)], { btn: [{ t: 132, buttons: 1 }], move: [{ t: 300, dx: 3, dy: 0 }], wheel: [] });
  assert.equal(T.observationText(od), '指 1 本 / 押下 120ms / 移動 0 / 2 本目 間隔 100ms 移動 177 / ボタン 272(左) 押(離しなし)');
  assert.equal(T.hostText(od), '左ボタン押されたまま、移動 1 回');
  assert.equal(T.hostText(observe(frames(0, 100, 1))), '受信なし');
  assert.equal(T.observationText(T.observeAttempt({ start: 0, end: 0, frames: [] }, [], HOST0)), '接触なし');
});

const TAP1_LONG = frames(0, 320, 1).concat(frames(330, 800, 0));

test('1本指タップの試行を認識文にすると指本数・押下・移動と送信したクリックとホストの受信が 1 行になる', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host);
  assert.equal(T.recognitionText('tap1', o, PARAMS),
    '指 1 本 / 押下 120ms / 移動 0 → タップと認識 → 左クリック 1 回送信 → ホストで左クリック 1 回受信');
});

test('1本指タップでドライバがボタンを出さなかった認識文には理由の候補が現在値つきで入る', () => {
  const o = observe(TAP1_LONG);
  assert.equal(T.recognitionText('tap1', o, PARAMS),
    '指 1 本 / 押下 320ms / 移動 0 → ボタン報告なし(押下 320ms > 1f_tap_max_ms=250) → ホスト受信なし');
});

test('1本指タップで条件内なのにボタンが出なかった認識文には tap_enable の確認が入る', () => {
  const o = observe(frames(0, 100, 1).concat(frames(110, 600, 0)));
  assert.ok(T.recognitionText('tap1', o, PARAMS).includes('ボタン報告なし(1f_tap_enable を確認)'));
});

test('タップドラッグで 2 回目の接触が遅かった認識文にはクリック確定と間隔の超過が入る', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 350, 0), frames(360, 900, 1, { relX: 3 }), frames(910, 1500, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [{ t: 400, dx: 3, dy: 0 }], wheel: [] };
  const text = T.recognitionText('tapdrag', observe(fr, fw, host), PARAMS);
  assert.ok(text.startsWith('指 1 本 / 押下 120ms / 移動 0 / 2 回目 間隔 240ms 移動 165 → '), text);
  assert.ok(text.includes('ドラッグにならず左クリック 1 回送信(間隔 240ms > 1f_tapdrag_gap_max_ms=160'), text);
  assert.ok(text.endsWith('→ ホストで左クリック 1 回、移動 1 回受信'), text);
});

test('タップドラッグが成立した認識文はドラッグと認識になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 210, 0, { hold: 272, pending: 1 }), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const fw = [K(125, 272, 1), K(805, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 812, buttons: 0 }], move: [{ t: 300, dx: 3, dy: 0 }], wheel: [] };
  assert.equal(T.recognitionText('tapdrag', observe(fr, fw, host), PARAMS),
    '指 1 本 / 押下 120ms / 移動 0 / 2 回目 間隔 100ms 移動 177 → タップドラッグと認識 → 左ボタン押し→保持→離し送信 → ホストで左クリック 1 回、移動 1 回受信');
});

test('2本指スクロールの認識文には 2 本指移動量と wheel の送受信回数が入る', () => {
  const fr = frames(0, 50, 2, { relY: 4 }).concat(frames(60, 500, 2, { relY: 4, mode2f: 1 }), frames(510, 1000, 0));
  const fw = [];
  const host = { btn: [], move: [], wheel: [] };
  for (let t = 100; t <= 500; t += 50) {
    fw.push(R(t, 8, -1));
    host.wheel.push({ t: t + 12, deltaX: 0, deltaY: 24 });
  }
  assert.equal(T.recognitionText('scroll2', observe(fr, fw, host), PARAMS),
    '指 2 本 / 接触 500ms / 2 本指移動 204 → スクロールと認識 → wheel 9 回送信 → ホストで wheel 9 回受信');
  const short = frames(0, 90, 2, { relY: 1 }).concat(frames(100, 300, 2), frames(310, 800, 0));
  assert.equal(T.recognitionText('scroll2', observe(short), PARAMS),
    '指 2 本 / 接触 300ms / 2 本指移動 10 → スクロール判定なし(2 本指移動量 10 < 2f_scroll_start_move=15) → ホスト受信なし');
});

test('ピンチの認識文には距離変化とピンチボタンの送信が入りホスト受信は対象外と書かれる', () => {
  const fr = frames(0, 300, 2, { mode2f: 2, f1x: 100, f1y: 100, f2x: 200, f2y: 100 }).concat(frames(310, 800, 0));
  assert.equal(T.recognitionText('pinch', observe(fr, [K(150, 279, 1), K(310, 279, 0)]), PARAMS),
    '指 2 本 / 接触 300ms / 距離変化 0 → ピンチと認識 → ピンチ(BTN_7) 1 回送信 → ホスト受信は判定対象外');
});

test('接触のない試行の認識文は指が認識されていないと出る', () => {
  const o = T.observeAttempt({ start: 0, end: 0, frames: [] }, [], HOST0);
  assert.equal(T.recognitionText('tap1', o, PARAMS), '接触なし(指が認識されていません)');
});

function cursorScenario() {
  const fr = frames(0, 30, 1).concat(frames(40, 400, 1, { relX: 1, relY: 1 }), frames(410, 600, 1, { relX: 8, relY: 0 }), frames(610, 1200, 0));
  const fw = [];
  for (let t = 40; t <= 600; t += 10) fw.push(R(t, 0, t < 410 ? 1 : 8));
  fw.push(R(620, 0, 4), R(640, 0, 2));
  const host = { btn: [], move: [], wheel: [] };
  for (let t = 45; t <= 605; t += 10) host.move.push({ t, dx: t < 415 ? 1 : 8, dy: t < 415 ? 1 : 0 });
  return { fr, fw, host };
}

test('カーソル移動の試行から動き出し遅延・移動量・フレーム間隔・微小動き割合・慣性の指標が取れる', () => {
  const { fr, fw, host } = cursorScenario();
  const m = T.cursorMetrics(T.segmentAttempts(fr)[0], fw, host, { tailMs: 500 });
  assert.equal(m.touchMs, 600);
  assert.equal(m.startDelayMs, 40);
  assert.equal(m.fwMove, 37 * 2 + 20 * 8);
  assert.equal(m.hostMove, 37 * 2 + 20 * 8);
  assert.equal(m.frameGapMs, 10);
  assert.equal(m.tinyRatio, Math.round((37 / 61) * 100));
  assert.equal(m.relCount, 57);
  assert.equal(m.inertiaCount, 2);
  assert.equal(m.inertiaMs, 40);
});

test('動きのない接触ではカーソル指標の動き出し遅延が null になり慣性は 0 になる', () => {
  const m = T.cursorMetrics(T.segmentAttempts(frames(0, 100, 1))[0], [], HOST0, { tailMs: 500 });
  assert.equal(m.startDelayMs, null);
  assert.equal(m.fwMove, 0);
  assert.equal(m.inertiaCount, 0);
  assert.equal(m.tinyRatio, 0);
});

test('カーソル移動の認識文には各指標とホストの移動受信回数が入る', () => {
  const { fr, fw, host } = cursorScenario();
  assert.equal(T.recognitionText('cursor', observe(fr, fw, host), PARAMS),
    '指 1 本 / 接触 600ms / 動き出し 40ms / 移動量 ファーム 234・ホスト 234 / フレーム間隔 10ms / 微小動き 61% / 慣性あり(2 回 40ms) → 移動 57 回送信 → ホストで移動 57 回受信');
});

test('mergeParams は右手の値を基準に左右の差分に印を付ける', () => {
  const R = [
    { name: '1f_tap_max_ms', value: 250, min: 1, max: 1000, kind: 'driver', def: 250 },
    { name: '1f_tap_move', value: 50, min: 0, max: 500, kind: 'driver', def: 50 },
  ];
  const L = [
    { name: '1f_tap_max_ms', value: 200, min: 1, max: 1000, kind: 'driver', def: 250 },
    { name: '1f_tap_move', value: 50, min: 0, max: 500, kind: 'driver', def: 50 },
  ];
  const merged = T.mergeParams(R, L);
  assert.deepEqual(merged, [
    { name: '1f_tap_max_ms', min: 1, max: 1000, kind: 'driver', def: 250, value: 250, valueR: 250, valueL: 200, differs: true },
    { name: '1f_tap_move', min: 0, max: 500, kind: 'driver', def: 50, value: 50, valueR: 50, valueL: 50, differs: false },
  ]);
});

test('mergeParams は右手にしかない行を右手の値のまま出し、左手にしかない行も末尾に含める', () => {
  const R = [{ name: 'a', value: 1, min: 0, max: 9, kind: 'driver', def: 0 }];
  const L = [{ name: 'b', value: 2, min: 0, max: 9, kind: 'driver', def: 0 }];
  assert.deepEqual(T.mergeParams(R, L), [
    { name: 'a', min: 0, max: 9, kind: 'driver', def: 0, value: 1, valueR: 1, valueL: null, differs: false },
    { name: 'b', min: 0, max: 9, kind: 'driver', def: 0, value: 2, valueR: null, valueL: 2, differs: false },
  ]);
});

test('mergeParams は右手が無ければ左手の値だけで出す(USB で片側のみのとき)', () => {
  assert.deepEqual(T.mergeParams(null, [{ name: 'a', value: 3, min: 0, max: 9, kind: 'driver', def: 0 }]), [
    { name: 'a', min: 0, max: 9, kind: 'driver', def: 0, value: 3, valueR: null, valueL: 3, differs: false },
  ]);
  assert.deepEqual(T.mergeParams([], []), []);
});

test('pendingCommands は共通の保留値を左右両方に set コマンドとして展開する', () => {
  const pending = { common: { '1f_tap_max_ms': 300 } };
  assert.deepEqual(T.pendingCommands(pending, ['R', 'L']), [
    { side: 'R', cmd: 'tp set 1f_tap_max_ms 300' },
    { side: 'L', cmd: 'tp set 1f_tap_max_ms 300' },
  ]);
});

test('pendingCommands は側ごとの保留値を共通より優先し、USB では接続側だけを返す', () => {
  const pending = { common: { a: 1 }, R: { a: 2 } };
  assert.deepEqual(T.pendingCommands(pending, ['R']), [{ side: 'R', cmd: 'tp set a 2' }]);
  assert.deepEqual(T.pendingCommands(pending, ['L']), [{ side: 'L', cmd: 'tp set a 1' }]);
});

test('pendingCommands は保留がなければ空配列を返す', () => {
  assert.deepEqual(T.pendingCommands({}, ['R', 'L']), []);
  assert.deepEqual(T.pendingCommands(null, ['R', 'L']), []);
});

test('liveCommands は on のとき側ごとのレートで live on コマンドを返す', () => {
  assert.deepEqual(T.liveCommands(['R', 'L'], { R: 60, L: 30 }, true), [
    { side: 'R', cmd: 'tp live on 60' },
    { side: 'L', cmd: 'tp live on 30' },
  ]);
});

test('liveCommands は off のとき側ごとに live off コマンドを返す', () => {
  assert.deepEqual(T.liveCommands(['R', 'L'], { R: 60, L: 30 }, false), [
    { side: 'R', cmd: 'tp live off' },
    { side: 'L', cmd: 'tp live off' },
  ]);
});

test('liveCommands は対象の側だけを返し、レート未指定なら既定値を使う', () => {
  assert.deepEqual(T.liveCommands(['R'], {}, true), [{ side: 'R', cmd: 'tp live on 60' }]);
  assert.deepEqual(T.liveCommands([], { R: 60 }, true), []);
});

test('padStateFromFrame はフレームがなければ待機、指本数と mode2f で状態と色を返す', () => {
  assert.deepEqual(T.padStateFromFrame(null), { fingers: 0, state: '待機', color: 'idle', dragging: false });
  assert.deepEqual(T.padStateFromFrame({ fingers: 0, hold: 0 }), { fingers: 0, state: '待機', color: 'idle', dragging: false });
  assert.deepEqual(T.padStateFromFrame({ fingers: 1, hold: 0, mode2f: 0 }), { fingers: 1, state: '1 本指', color: 'blue', dragging: false });
  assert.deepEqual(T.padStateFromFrame({ fingers: 2, hold: 0, mode2f: 1 }), { fingers: 2, state: 'スクロール', color: 'green', dragging: false });
  assert.deepEqual(T.padStateFromFrame({ fingers: 2, hold: 0, mode2f: 2 }), { fingers: 2, state: 'ピンチ', color: 'orange', dragging: false });
  assert.deepEqual(T.padStateFromFrame({ fingers: 2, hold: 0, mode2f: 0 }), { fingers: 2, state: '2 本指', color: 'green', dragging: false });
  assert.deepEqual(T.padStateFromFrame({ fingers: 3, hold: 0, mode2f: 0 }), { fingers: 3, state: '3 本指', color: 'purple', dragging: false });
});

test('padStateFromFrame は hold が立っていれば指本数に関わらずドラッグ中として赤枠になる', () => {
  assert.deepEqual(T.padStateFromFrame({ fingers: 1, hold: 272, mode2f: 0 }), { fingers: 1, state: 'ドラッグ中', color: 'blue', dragging: true });
  assert.deepEqual(T.padStateFromFrame({ fingers: 0, hold: 272, mode2f: 0 }), { fingers: 0, state: 'ドラッグ中', color: 'idle', dragging: true });
});

test('frameToPadPoints は解像度 2457x3072 をパッドのピクセルへ線形変換する', () => {
  const frame = { fingers: 1, f1x: 2457, f1y: 3072, f2x: 0, f2y: 0 };
  assert.deepEqual(T.frameToPadPoints(frame, 200, 250), [{ x: 200, y: 250 }]);
});

test('frameToPadPoints は 2 本指なら 2 点、接触なしなら空配列を返す', () => {
  const frame = { fingers: 2, f1x: 0, f1y: 0, f2x: 2457, f2y: 3072 };
  assert.deepEqual(T.frameToPadPoints(frame, 100, 100), [{ x: 0, y: 0 }, { x: 100, y: 100 }]);
  assert.deepEqual(T.frameToPadPoints({ fingers: 0 }, 100, 100), []);
  assert.deepEqual(T.frameToPadPoints(null, 100, 100), []);
});
