(function (root) {
  'use strict';

  const FRAMING = { SOF: 0xab, ESC: 0xac, EOF: 0xad };

  function frameEncode(bytes) {
    const out = [FRAMING.SOF];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === FRAMING.SOF || b === FRAMING.ESC || b === FRAMING.EOF) out.push(FRAMING.ESC);
      out.push(b);
    }
    out.push(FRAMING.EOF);
    return Uint8Array.from(out);
  }

  function createFrameDecoder() {
    const ST = { IDLE: 0, DATA: 1, ESCAPED: 2, ERR: 3 };
    let state = ST.IDLE;
    let buf = [];

    function push(bytes) {
      const frames = [];
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (state === ST.IDLE) {
          if (b === FRAMING.SOF) { state = ST.DATA; buf = []; }
          continue;
        }
        if (state === ST.ERR) {
          if (b === FRAMING.EOF) state = ST.IDLE;
          else if (b === FRAMING.SOF) { state = ST.DATA; buf = []; }
          continue;
        }
        if (state === ST.ESCAPED) {
          buf.push(b);
          state = ST.DATA;
          continue;
        }
        // state === ST.DATA
        if (b === FRAMING.SOF) { state = ST.ERR; buf = []; }
        else if (b === FRAMING.ESC) state = ST.ESCAPED;
        else if (b === FRAMING.EOF) { frames.push(Uint8Array.from(buf)); buf = []; state = ST.IDLE; }
        else buf.push(b);
      }
      return frames;
    }

    return { push };
  }

  function zigzagEncode(n) {
    return n >= 0 ? n * 2 : (-n) * 2 - 1;
  }

  function zigzagDecode(v) {
    return v % 2 === 0 ? v / 2 : -((v + 1) / 2);
  }

  function encodeVarintBig(big) {
    const out = [];
    let v = big;
    while (v > 0x7fn) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return out;
  }

  function decodeVarintBig(buf, pos) {
    let result = 0n;
    let shift = 0n;
    let p = pos;
    for (;;) {
      if (p >= buf.length) throw new Error('varint がバッファの終端で途切れています');
      const b = buf[p++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return { value: result, next: p };
  }

  function encodeVarint(n) {
    return encodeVarintBig(BigInt(n));
  }

  function decodeVarint(buf, pos) {
    const r = decodeVarintBig(buf, pos);
    return { value: Number(r.value), next: r.next };
  }

  function utf8Encode(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  function utf8Decode(bytes) {
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }

  const WT = { VARINT: 0, LEN: 2 };

  function wireTypeOf(type) {
    return (type === 'message' || type === 'string' || type === 'bytes') ? WT.LEN : WT.VARINT;
  }

  function encodeScalarVarint(type, value) {
    if (type === 'bool') return encodeVarintBig(value ? 1n : 0n);
    if (type === 'sint32') return encodeVarint(zigzagEncode(value));
    if (type === 'int32') return encodeVarintBig(BigInt.asUintN(64, BigInt(value)));
    return encodeVarint(value); // uint32, enum
  }

  function decodeScalarVarint(type, big) {
    if (type === 'bool') return big !== 0n;
    if (type === 'sint32') return zigzagDecode(Number(big));
    if (type === 'int32') return Number(BigInt.asIntN(32, big));
    return Number(big); // uint32, enum
  }

  const MESSAGES = {
    'zmk.studio.Request': [
      { no: 1, name: 'requestId', type: 'uint32' },
      { no: 3, name: 'core', type: 'message', ref: 'zmk.core.Request' },
      { no: 4, name: 'behaviors', type: 'message', ref: 'zmk.behaviors.Request' },
      { no: 5, name: 'keymap', type: 'message', ref: 'zmk.keymap.Request' },
    ],
    'zmk.studio.Response': [
      { no: 1, name: 'requestResponse', type: 'message', ref: 'zmk.studio.RequestResponse' },
      { no: 2, name: 'notification', type: 'message', ref: 'zmk.studio.Notification' },
    ],
    'zmk.studio.RequestResponse': [
      { no: 1, name: 'requestId', type: 'uint32' },
      { no: 2, name: 'meta', type: 'message', ref: 'zmk.meta.Response' },
      { no: 3, name: 'core', type: 'message', ref: 'zmk.core.Response' },
      { no: 4, name: 'behaviors', type: 'message', ref: 'zmk.behaviors.Response' },
      { no: 5, name: 'keymap', type: 'message', ref: 'zmk.keymap.Response' },
    ],
    'zmk.studio.Notification': [
      { no: 2, name: 'core', type: 'message', ref: 'zmk.core.Notification' },
      { no: 5, name: 'keymap', type: 'message', ref: 'zmk.keymap.Notification' },
    ],
    'zmk.meta.Response': [
      { no: 1, name: 'noResponse', type: 'bool' },
      { no: 2, name: 'simpleError', type: 'enum' },
    ],
    'zmk.core.Request': [
      { no: 1, name: 'getDeviceInfo', type: 'bool' },
      { no: 2, name: 'getLockState', type: 'bool' },
      { no: 3, name: 'lock', type: 'bool' },
      { no: 4, name: 'resetSettings', type: 'bool' },
    ],
    'zmk.core.Response': [
      { no: 1, name: 'getDeviceInfo', type: 'message', ref: 'zmk.core.GetDeviceInfoResponse' },
      { no: 2, name: 'getLockState', type: 'enum' },
      { no: 4, name: 'resetSettings', type: 'bool' },
    ],
    'zmk.core.GetDeviceInfoResponse': [
      { no: 1, name: 'name', type: 'string' },
      { no: 2, name: 'serialNumber', type: 'bytes' },
    ],
    'zmk.core.Notification': [
      { no: 1, name: 'lockStateChanged', type: 'enum' },
    ],
    'zmk.behaviors.Request': [
      { no: 1, name: 'listAllBehaviors', type: 'bool' },
      { no: 2, name: 'getBehaviorDetails', type: 'message', ref: 'zmk.behaviors.GetBehaviorDetailsRequest' },
    ],
    'zmk.behaviors.GetBehaviorDetailsRequest': [
      { no: 1, name: 'behaviorId', type: 'uint32' },
    ],
    'zmk.behaviors.Response': [
      { no: 1, name: 'listAllBehaviors', type: 'message', ref: 'zmk.behaviors.ListAllBehaviorsResponse' },
      { no: 2, name: 'getBehaviorDetails', type: 'message', ref: 'zmk.behaviors.GetBehaviorDetailsResponse' },
    ],
    'zmk.behaviors.ListAllBehaviorsResponse': [
      { no: 1, name: 'behaviors', type: 'uint32', repeated: true, packed: true },
    ],
    'zmk.behaviors.GetBehaviorDetailsResponse': [
      { no: 1, name: 'id', type: 'uint32' },
      { no: 2, name: 'displayName', type: 'string' },
      { no: 3, name: 'metadata', type: 'message', ref: 'zmk.behaviors.BehaviorBindingParametersSet', repeated: true },
    ],
    'zmk.behaviors.BehaviorBindingParametersSet': [
      { no: 1, name: 'param1', type: 'message', ref: 'zmk.behaviors.BehaviorParameterValueDescription', repeated: true },
      { no: 2, name: 'param2', type: 'message', ref: 'zmk.behaviors.BehaviorParameterValueDescription', repeated: true },
    ],
    'zmk.behaviors.BehaviorParameterValueDescription': [
      { no: 1, name: 'name', type: 'string' },
      { no: 2, name: 'nil', type: 'message', ref: 'zmk.behaviors.BehaviorParameterNil' },
      { no: 3, name: 'constant', type: 'uint32' },
      { no: 4, name: 'range', type: 'message', ref: 'zmk.behaviors.BehaviorParameterValueDescriptionRange' },
      { no: 5, name: 'hidUsage', type: 'message', ref: 'zmk.behaviors.BehaviorParameterHidUsage' },
      { no: 6, name: 'layerId', type: 'message', ref: 'zmk.behaviors.BehaviorParameterLayerId' },
    ],
    'zmk.behaviors.BehaviorParameterNil': [],
    'zmk.behaviors.BehaviorParameterLayerId': [],
    'zmk.behaviors.BehaviorParameterValueDescriptionRange': [
      { no: 1, name: 'min', type: 'int32' },
      { no: 2, name: 'max', type: 'int32' },
    ],
    'zmk.behaviors.BehaviorParameterHidUsage': [
      { no: 1, name: 'keyboardMax', type: 'uint32' },
      { no: 2, name: 'consumerMax', type: 'uint32' },
    ],
    'zmk.keymap.Request': [
      { no: 1, name: 'getKeymap', type: 'bool' },
      { no: 2, name: 'setLayerBinding', type: 'message', ref: 'zmk.keymap.SetLayerBindingRequest' },
      { no: 3, name: 'checkUnsavedChanges', type: 'bool' },
      { no: 4, name: 'saveChanges', type: 'bool' },
      { no: 5, name: 'discardChanges', type: 'bool' },
      { no: 6, name: 'getPhysicalLayouts', type: 'bool' },
      { no: 7, name: 'setActivePhysicalLayout', type: 'uint32' },
      { no: 8, name: 'moveLayer', type: 'message', ref: 'zmk.keymap.MoveLayerRequest' },
      { no: 9, name: 'addLayer', type: 'message', ref: 'zmk.keymap.AddLayerRequest' },
      { no: 10, name: 'removeLayer', type: 'message', ref: 'zmk.keymap.RemoveLayerRequest' },
      { no: 11, name: 'restoreLayer', type: 'message', ref: 'zmk.keymap.RestoreLayerRequest' },
      { no: 12, name: 'setLayerProps', type: 'message', ref: 'zmk.keymap.SetLayerPropsRequest' },
    ],
    'zmk.keymap.Response': [
      { no: 1, name: 'getKeymap', type: 'message', ref: 'zmk.keymap.Keymap' },
      { no: 2, name: 'setLayerBinding', type: 'enum' },
      { no: 3, name: 'checkUnsavedChanges', type: 'bool' },
      { no: 4, name: 'saveChanges', type: 'message', ref: 'zmk.keymap.SaveChangesResponse' },
      { no: 5, name: 'discardChanges', type: 'bool' },
      { no: 6, name: 'getPhysicalLayouts', type: 'message', ref: 'zmk.keymap.PhysicalLayouts' },
      { no: 7, name: 'setActivePhysicalLayout', type: 'message', ref: 'zmk.keymap.SetActivePhysicalLayoutResponse' },
      { no: 8, name: 'moveLayer', type: 'message', ref: 'zmk.keymap.MoveLayerResponse' },
      { no: 9, name: 'addLayer', type: 'message', ref: 'zmk.keymap.AddLayerResponse' },
      { no: 10, name: 'removeLayer', type: 'message', ref: 'zmk.keymap.RemoveLayerResponse' },
      { no: 11, name: 'restoreLayer', type: 'message', ref: 'zmk.keymap.RestoreLayerResponse' },
      { no: 12, name: 'setLayerProps', type: 'enum' },
    ],
    'zmk.keymap.Notification': [
      { no: 1, name: 'unsavedChangesStatusChanged', type: 'bool' },
    ],
    'zmk.keymap.SaveChangesResponse': [
      { no: 1, name: 'ok', type: 'bool' },
      { no: 2, name: 'err', type: 'enum' },
    ],
    'zmk.keymap.SetActivePhysicalLayoutResponse': [
      { no: 1, name: 'ok', type: 'message', ref: 'zmk.keymap.Keymap' },
      { no: 2, name: 'err', type: 'enum' },
    ],
    'zmk.keymap.MoveLayerResponse': [
      { no: 1, name: 'ok', type: 'message', ref: 'zmk.keymap.Keymap' },
      { no: 2, name: 'err', type: 'enum' },
    ],
    'zmk.keymap.AddLayerResponse': [
      { no: 1, name: 'ok', type: 'message', ref: 'zmk.keymap.AddLayerResponseDetails' },
      { no: 2, name: 'err', type: 'enum' },
    ],
    'zmk.keymap.AddLayerResponseDetails': [
      { no: 1, name: 'index', type: 'uint32' },
      { no: 2, name: 'layer', type: 'message', ref: 'zmk.keymap.Layer' },
    ],
    'zmk.keymap.RemoveLayerResponse': [
      { no: 1, name: 'ok', type: 'message', ref: 'zmk.keymap.RemoveLayerOk' },
      { no: 2, name: 'err', type: 'enum' },
    ],
    'zmk.keymap.RemoveLayerOk': [],
    'zmk.keymap.RestoreLayerResponse': [
      { no: 1, name: 'ok', type: 'message', ref: 'zmk.keymap.Layer' },
      { no: 2, name: 'err', type: 'enum' },
    ],
    'zmk.keymap.SetLayerBindingRequest': [
      { no: 1, name: 'layerId', type: 'uint32' },
      { no: 2, name: 'keyPosition', type: 'int32' },
      { no: 3, name: 'binding', type: 'message', ref: 'zmk.keymap.BehaviorBinding' },
    ],
    'zmk.keymap.MoveLayerRequest': [
      { no: 1, name: 'startIndex', type: 'uint32' },
      { no: 2, name: 'destIndex', type: 'uint32' },
    ],
    'zmk.keymap.AddLayerRequest': [],
    'zmk.keymap.RemoveLayerRequest': [
      { no: 1, name: 'layerIndex', type: 'uint32' },
    ],
    'zmk.keymap.RestoreLayerRequest': [
      { no: 1, name: 'layerId', type: 'uint32' },
      { no: 2, name: 'atIndex', type: 'uint32' },
    ],
    'zmk.keymap.SetLayerPropsRequest': [
      { no: 1, name: 'layerId', type: 'uint32' },
      { no: 2, name: 'name', type: 'string' },
    ],
    'zmk.keymap.Keymap': [
      { no: 1, name: 'layers', type: 'message', ref: 'zmk.keymap.Layer', repeated: true },
      { no: 2, name: 'availableLayers', type: 'uint32' },
      { no: 3, name: 'maxLayerNameLength', type: 'uint32' },
    ],
    'zmk.keymap.Layer': [
      { no: 1, name: 'id', type: 'uint32' },
      { no: 2, name: 'name', type: 'string' },
      { no: 3, name: 'bindings', type: 'message', ref: 'zmk.keymap.BehaviorBinding', repeated: true },
    ],
    'zmk.keymap.BehaviorBinding': [
      { no: 1, name: 'behaviorId', type: 'sint32' },
      { no: 2, name: 'param1', type: 'uint32' },
      { no: 3, name: 'param2', type: 'uint32' },
    ],
    'zmk.keymap.PhysicalLayouts': [
      { no: 1, name: 'activeLayoutIndex', type: 'uint32' },
      { no: 2, name: 'layouts', type: 'message', ref: 'zmk.keymap.PhysicalLayout', repeated: true },
    ],
    'zmk.keymap.PhysicalLayout': [
      { no: 1, name: 'name', type: 'string' },
      { no: 2, name: 'keys', type: 'message', ref: 'zmk.keymap.KeyPhysicalAttrs', repeated: true },
    ],
    'zmk.keymap.KeyPhysicalAttrs': [
      { no: 1, name: 'width', type: 'sint32' },
      { no: 2, name: 'height', type: 'sint32' },
      { no: 3, name: 'x', type: 'sint32' },
      { no: 4, name: 'y', type: 'sint32' },
      { no: 5, name: 'r', type: 'sint32' },
      { no: 6, name: 'rx', type: 'sint32' },
      { no: 7, name: 'ry', type: 'sint32' },
    ],
  };

  function encodeMessage(ref, obj) {
    const schema = MESSAGES[ref];
    if (!schema) throw new Error('未知のメッセージ型です: ' + ref);
    const out = [];
    for (const field of schema) {
      if (!Object.prototype.hasOwnProperty.call(obj, field.name)) continue;
      const value = obj[field.name];
      if (value === undefined) continue;
      if (field.repeated && field.type !== 'message' && field.packed) {
        const packedTagBytes = encodeVarint((field.no << 3) | WT.LEN);
        const payload = [];
        for (const item of value) payload.push(...encodeScalarVarint(field.type, item));
        out.push(...packedTagBytes, ...encodeVarint(payload.length), ...payload);
        continue;
      }
      const wire = wireTypeOf(field.type);
      const tagBytes = encodeVarint((field.no << 3) | wire);
      const items = field.repeated ? value : [value];
      for (const item of items) {
        out.push(...tagBytes);
        if (field.type === 'message') {
          const nested = encodeMessage(field.ref, item);
          out.push(...encodeVarint(nested.length), ...nested);
        } else if (field.type === 'string') {
          const bytes = utf8Encode(item);
          out.push(...encodeVarint(bytes.length), ...bytes);
        } else if (field.type === 'bytes') {
          const bytes = Array.from(item);
          out.push(...encodeVarint(bytes.length), ...bytes);
        } else {
          out.push(...encodeScalarVarint(field.type, item));
        }
      }
    }
    return Uint8Array.from(out);
  }

  function fieldByNo(schema, no) {
    for (const field of schema) if (field.no === no) return field;
    return null;
  }

  function decodeMessage(ref, bytes) {
    const schema = MESSAGES[ref];
    if (!schema) throw new Error('未知のメッセージ型です: ' + ref);
    const obj = {};
    let pos = 0;
    while (pos < bytes.length) {
      const tag = decodeVarintBig(bytes, pos);
      pos = tag.next;
      const fieldNo = Number(tag.value >> 3n);
      const wireType = Number(tag.value & 7n);
      const field = fieldByNo(schema, fieldNo);
      if (wireType === WT.VARINT) {
        const v = decodeVarintBig(bytes, pos);
        pos = v.next;
        if (!field) continue;
        const value = decodeScalarVarint(field.type, v.value);
        if (field.repeated) (obj[field.name] || (obj[field.name] = [])).push(value);
        else obj[field.name] = value;
        continue;
      }
      if (wireType === WT.LEN) {
        const len = decodeVarintBig(bytes, pos);
        pos = len.next;
        const end = pos + Number(len.value);
        const slice = bytes.slice(pos, end);
        pos = end;
        if (!field) continue;
        if (field.type === 'message') {
          const value = decodeMessage(field.ref, slice);
          if (field.repeated) (obj[field.name] || (obj[field.name] = [])).push(value);
          else obj[field.name] = value;
        } else if (field.type === 'string') {
          obj[field.name] = utf8Decode(slice);
        } else if (field.type === 'bytes') {
          obj[field.name] = slice;
        } else if (field.repeated) {
          // packed scalar (uint32 想定)
          const arr = obj[field.name] || (obj[field.name] = []);
          let p = 0;
          while (p < slice.length) {
            const v = decodeVarintBig(slice, p);
            p = v.next;
            arr.push(decodeScalarVarint(field.type, v.value));
          }
        }
        continue;
      }
      throw new Error('未対応の wire type です: ' + wireType);
    }
    return obj;
  }

  function encodeRequest(obj) {
    return encodeMessage('zmk.studio.Request', obj);
  }

  function decodeResponse(bytes) {
    return decodeMessage('zmk.studio.Response', bytes);
  }

  const META_ERROR_MESSAGES = {
    0: '不明なエラーが発生しました',
    1: 'ロック解除が必要です',
    2: '対応する RPC が見つかりません',
    3: 'メッセージのデコードに失敗しました',
    4: 'メッセージのエンコードに失敗しました',
  };

  const SAVE_CHANGES_ERROR_MESSAGES = {
    1: '保存に失敗しました',
    2: 'この操作はサポートされていません',
    3: '空き容量が不足しています',
  };

  const ADD_LAYER_ERROR_MESSAGES = {
    1: 'レイヤーの追加に失敗しました',
    2: 'レイヤーを追加する空き容量がありません',
  };

  const REMOVE_LAYER_ERROR_MESSAGES = {
    1: 'レイヤーの削除に失敗しました',
    2: '指定したレイヤーが見つかりません',
  };

  const MOVE_LAYER_ERROR_MESSAGES = {
    1: 'レイヤーの移動に失敗しました',
    2: '移動元のレイヤーが不正です',
    3: '移動先が不正です',
  };

  function errorFromEnum(messages, code) {
    const err = new Error(messages[code] || ('不明なエラーコードです(' + code + ')'));
    err.code = code;
    return err;
  }

  function describeParam(d) {
    const out = { name: d.name };
    if (d.nil !== undefined) out.nil = true;
    else if (d.constant !== undefined) out.constant = d.constant;
    else if (d.range !== undefined) out.range = { min: d.range.min, max: d.range.max };
    else if (d.hidUsage !== undefined) {
      out.hidUsage = { keyboardMax: d.hidUsage.keyboardMax, consumerMax: d.hidUsage.consumerMax };
    } else if (d.layerId !== undefined) out.layerId = true;
    return out;
  }

  function mapLayer(l) {
    return {
      id: l.id,
      name: l.name,
      bindings: (l.bindings || []).map((b) => ({ behaviorId: b.behaviorId, param1: b.param1, param2: b.param2 })),
    };
  }

  function mapKeymap(k) {
    return {
      layers: (k.layers || []).map(mapLayer),
      availableLayers: k.availableLayers,
      maxLayerNameLength: k.maxLayerNameLength,
    };
  }

  function createClient(options) {
    const send = options.send;
    const timeoutMs = options.timeoutMs === undefined ? 3000 : options.timeoutMs;
    const decoder = createFrameDecoder();
    let nextId = 1;
    const pending = new Map();

    const client = { onNotification: function () {} };

    function sendRequest(fields) {
      const requestId = nextId++;
      const bytes = encodeRequest(Object.assign({ requestId }, fields));
      const framed = frameEncode(bytes);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          const err = new Error('タイムアウトしました');
          err.code = 'TIMEOUT';
          reject(err);
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        send(framed);
      });
    }

    client.onData = function (bytes) {
      const frames = decoder.push(bytes);
      for (const frame of frames) {
        let decoded;
        try {
          decoded = decodeResponse(frame);
        } catch (e) {
          continue;
        }
        if (decoded.notification) {
          client.onNotification(decoded.notification);
          continue;
        }
        const rr = decoded.requestResponse;
        if (!rr || rr.requestId === undefined) continue;
        const p = pending.get(rr.requestId);
        if (!p) continue;
        pending.delete(rr.requestId);
        clearTimeout(p.timer);
        if (rr.meta && rr.meta.simpleError !== undefined) {
          p.reject(errorFromEnum(META_ERROR_MESSAGES, rr.meta.simpleError));
          continue;
        }
        p.resolve(rr);
      }
    };

    client.getDeviceInfo = function () {
      return sendRequest({ core: { getDeviceInfo: true } }).then((rr) => {
        const r = rr.core.getDeviceInfo;
        return { name: r.name, serialNumber: r.serialNumber };
      });
    };

    client.getLockState = function () {
      return sendRequest({ core: { getLockState: true } }).then((rr) => rr.core.getLockState);
    };

    client.listBehaviors = function () {
      return sendRequest({ behaviors: { listAllBehaviors: true } })
        .then((rr) => rr.behaviors.listAllBehaviors.behaviors || []);
    };

    client.getBehaviorDetails = function (id) {
      return sendRequest({ behaviors: { getBehaviorDetails: { behaviorId: id } } }).then((rr) => {
        const r = rr.behaviors.getBehaviorDetails;
        return {
          id: r.id,
          displayName: r.displayName,
          metadata: (r.metadata || []).map((m) => ({
            param1: (m.param1 || []).map(describeParam),
            param2: (m.param2 || []).map(describeParam),
          })),
        };
      });
    };

    client.getKeymap = function () {
      return sendRequest({ keymap: { getKeymap: true } }).then((rr) => mapKeymap(rr.keymap.getKeymap));
    };

    client.getPhysicalLayouts = function () {
      return sendRequest({ keymap: { getPhysicalLayouts: true } }).then((rr) => {
        const p = rr.keymap.getPhysicalLayouts;
        return {
          activeLayoutIndex: p.activeLayoutIndex,
          layouts: (p.layouts || []).map((l) => ({
            name: l.name,
            keys: (l.keys || []).map((k) => ({
              width: k.width, height: k.height, x: k.x, y: k.y, r: k.r, rx: k.rx, ry: k.ry,
            })),
          })),
        };
      });
    };

    client.setLayerBinding = function (layerId, keyPosition, binding) {
      return sendRequest({
        keymap: {
          setLayerBinding: {
            layerId, keyPosition,
            binding: { behaviorId: binding.behaviorId, param1: binding.param1, param2: binding.param2 },
          },
        },
      }).then((rr) => rr.keymap.setLayerBinding);
    };

    client.addLayer = function () {
      return sendRequest({ keymap: { addLayer: {} } }).then((rr) => {
        const a = rr.keymap.addLayer;
        if (a.err !== undefined) throw errorFromEnum(ADD_LAYER_ERROR_MESSAGES, a.err);
        return { index: a.ok.index, layer: mapLayer(a.ok.layer) };
      });
    };

    client.removeLayer = function (layerIndex) {
      return sendRequest({ keymap: { removeLayer: { layerIndex } } }).then((rr) => {
        const r = rr.keymap.removeLayer;
        if (r.err !== undefined) throw errorFromEnum(REMOVE_LAYER_ERROR_MESSAGES, r.err);
        return undefined;
      });
    };

    client.moveLayer = function (start, dest) {
      return sendRequest({ keymap: { moveLayer: { startIndex: start, destIndex: dest } } }).then((rr) => {
        const r = rr.keymap.moveLayer;
        if (r.err !== undefined) throw errorFromEnum(MOVE_LAYER_ERROR_MESSAGES, r.err);
        return mapKeymap(r.ok);
      });
    };

    client.saveChanges = function () {
      return sendRequest({ keymap: { saveChanges: true } }).then((rr) => {
        const r = rr.keymap.saveChanges;
        if (r.err !== undefined) throw errorFromEnum(SAVE_CHANGES_ERROR_MESSAGES, r.err);
        return undefined;
      });
    };

    client.discardChanges = function () {
      return sendRequest({ keymap: { discardChanges: true } }).then((rr) => rr.keymap.discardChanges);
    };

    client.checkUnsavedChanges = function () {
      return sendRequest({ keymap: { checkUnsavedChanges: true } }).then((rr) => rr.keymap.checkUnsavedChanges);
    };

    client.dispose = function () {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        const err = new Error('クライアントが破棄されました');
        err.code = 'DISPOSED';
        p.reject(err);
      }
      pending.clear();
    };

    return client;
  }

  const api = {
    FRAMING, frameEncode, createFrameDecoder,
    encodeRequest, decodeResponse, createClient,
    _zigzagEncode: zigzagEncode, _zigzagDecode: zigzagDecode,
    _encodeVarint: encodeVarint, _decodeVarint: decodeVarint,
    _encodeMessage: encodeMessage, _decodeMessage: decodeMessage,
  };
  root.TpStudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
