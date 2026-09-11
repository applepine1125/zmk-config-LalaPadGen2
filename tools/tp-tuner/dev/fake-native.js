(function () {
  'use strict';
  const badUsbMode = /(?:^|[?&])fakeBadUsb=1(?:&|$)/.test(location.search);
  const fakeLive = /(?:^|[?&])fakeLive=1(?:&|$)/.test(location.search);
  const fakeLeftDown = /(?:^|[?&])fakeLeftDown=1(?:&|$)/.test(location.search);
  const fakeStudioLocked = /(?:^|[?&])fakeStudioLocked=1(?:&|$)/.test(location.search);
  const DEVICES = badUsbMode
    ? [
      { id: 'usb-bad', kind: 'usb', name: 'usbmodem-bad' },
      { id: 'usb-good', kind: 'usb', name: 'usbmodem-good' },
    ]
    : [{ id: 'fake-ble-1', kind: 'ble', name: 'LalapadGen2' }];
  function makeParams(tapMaxMs) {
    return [
      { name: '1f_tap_enable', value: 1, min: 0, max: 1, kind: 'driver_bool', def: 1 },
      { name: '1f_tap_max_ms', value: tapMaxMs, min: 1, max: 1000, kind: 'driver', def: 250 },
      { name: '1f_tap_move', value: 50, min: 0, max: 500, kind: 'driver', def: 50 },
      { name: 'scroll_x_enable', value: 1, min: 0, max: 1, kind: 'driver_bool', def: 1 },
      { name: 'scroll_y_enable', value: 1, min: 0, max: 1, kind: 'driver_bool', def: 1 },
      { name: '2f_scroll_start_move', value: 15, min: 0, max: 200, kind: 'driver', def: 15 },
      { name: 'touch_set_threshold', value: 20, min: 1, max: 255, kind: 'ic_u8', def: 20 },
      { name: 'cursor_inertia_enable', value: 0, min: 0, max: 1, kind: 'driver_bool', def: 0 },
    ];
  }
  const PARAMS = { R: makeParams(250), L: makeParams(200) };
  let connectedId = null;
  let fakePresetsText = null;
  let summaryTimer = null;
  let summarySide = 'R';
  let liveTimer = null;
  let liveOn = false;
  const startReal = Date.now();

  const K = window.TpKeycodes;
  const KEY_UNIT = 100;
  const FAKE_LAYOUT_KEYS = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      FAKE_LAYOUT_KEYS.push({ width: KEY_UNIT, height: KEY_UNIT, x: col * KEY_UNIT, y: row * KEY_UNIT, r: 0, rx: 0, ry: 0 });
    }
  }
  const FAKE_BEHAVIORS = [
    {
      id: 1,
      displayName: 'Key Press',
      metadata: [{
        param1: [{ name: 'keycode', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }],
        param2: [{ name: 'unused', nil: {} }],
      }],
    },
    {
      id: 2,
      displayName: 'Momentary Layer',
      metadata: [{
        param1: [{ name: 'layer', layerId: {} }],
        param2: [{ name: 'unused', nil: {} }],
      }],
    },
    {
      id: 3,
      displayName: 'Transparent',
      metadata: [{
        param1: [{ name: 'unused', nil: {} }],
        param2: [{ name: 'unused', nil: {} }],
      }],
    },
  ];
  const FAKE_MAX_LAYERS = 4;
  let fakeNextLayerId = 2;
  let fakeStudioLayers = [
    {
      id: 0,
      name: 'Default',
      bindings: [
        { behaviorId: 1, param1: K.encodeUsage(7, 4, 0), param2: 0 },
        { behaviorId: 1, param1: K.encodeUsage(7, 5, 0), param2: 0 },
        { behaviorId: 1, param1: K.encodeUsage(7, 6, 0), param2: 0 },
        { behaviorId: 2, param1: 1, param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
      ],
    },
    {
      id: 1,
      name: 'Fn',
      bindings: [
        { behaviorId: 1, param1: K.encodeUsage(7, 58, 0), param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
        { behaviorId: 3, param1: 0, param2: 0 },
      ],
    },
  ];
  let fakeStudioDirty = false;
  let fakeStudioUsbReady = false;
  const studioDecoder = window.TpStudio ? window.TpStudio.createFrameDecoder() : null;

  function cloneFakeLayers(layers) {
    return layers.map((l) => ({ id: l.id, name: l.name, bindings: l.bindings.map((b) => ({ ...b })) }));
  }

  let fakeStudioSavedLayers = cloneFakeLayers(fakeStudioLayers);
  let fakeStudioSavedNextLayerId = fakeNextLayerId;

  function base64ToBytesLocal(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function bytesToBase64Local(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function sendStudioResponse(obj) {
    const bytes = window.TpStudio._encodeMessage('zmk.studio.Response', obj);
    const framed = window.TpStudio.frameEncode(bytes);
    emit({ type: 'studioData', b64: bytesToBase64Local(framed) });
  }

  function notifyUnsavedChanged() {
    sendStudioResponse({ notification: { keymap: { unsavedChangesStatusChanged: fakeStudioDirty } } });
  }

  function currentFakeKeymap() {
    return {
      layers: fakeStudioLayers,
      availableLayers: Math.max(0, FAKE_MAX_LAYERS - fakeStudioLayers.length),
      maxLayerNameLength: 12,
    };
  }

  function studioHandleRequest(reqObj) {
    const rr = { requestId: reqObj.requestId };
    if (reqObj.core) {
      rr.core = {};
      if (reqObj.core.getDeviceInfo) rr.core.getDeviceInfo = { name: 'LalapadGen2 (fake)', serialNumber: Uint8Array.from([1, 2, 3, 4]) };
      if (reqObj.core.getLockState !== undefined) rr.core.getLockState = fakeStudioLocked ? 0 : 1;
    }
    if (reqObj.behaviors) {
      rr.behaviors = {};
      if (reqObj.behaviors.listAllBehaviors) rr.behaviors.listAllBehaviors = { behaviors: FAKE_BEHAVIORS.map((b) => b.id) };
      if (reqObj.behaviors.getBehaviorDetails) {
        const id = reqObj.behaviors.getBehaviorDetails.behaviorId;
        const b = FAKE_BEHAVIORS.find((x) => x.id === id);
        rr.behaviors.getBehaviorDetails = b
          ? { id: b.id, displayName: b.displayName, metadata: b.metadata }
          : { id, displayName: '?', metadata: [] };
      }
    }
    if (reqObj.keymap) {
      rr.keymap = {};
      const km = reqObj.keymap;
      if (km.getKeymap) rr.keymap.getKeymap = currentFakeKeymap();
      if (km.getPhysicalLayouts) {
        rr.keymap.getPhysicalLayouts = {
          activeLayoutIndex: 0,
          layouts: [{ name: 'Fake Layout', keys: FAKE_LAYOUT_KEYS }],
        };
      }
      if (km.setLayerBinding) {
        const { layerId, keyPosition, binding } = km.setLayerBinding;
        const layer = fakeStudioLayers.find((l) => l.id === layerId);
        if (layer && keyPosition >= 0 && keyPosition < layer.bindings.length) {
          layer.bindings[keyPosition] = binding;
          fakeStudioDirty = true;
          rr.keymap.setLayerBinding = 0;
        } else {
          rr.keymap.setLayerBinding = 1;
        }
      }
      if (km.checkUnsavedChanges) rr.keymap.checkUnsavedChanges = fakeStudioDirty;
      if (km.saveChanges) {
        fakeStudioDirty = false;
        fakeStudioSavedLayers = cloneFakeLayers(fakeStudioLayers);
        fakeStudioSavedNextLayerId = fakeNextLayerId;
        rr.keymap.saveChanges = { ok: true };
      }
      if (km.discardChanges) {
        fakeStudioLayers = cloneFakeLayers(fakeStudioSavedLayers);
        fakeNextLayerId = fakeStudioSavedNextLayerId;
        fakeStudioDirty = false;
        rr.keymap.discardChanges = true;
      }
      if (km.addLayer) {
        if (fakeStudioLayers.length >= FAKE_MAX_LAYERS) {
          rr.keymap.addLayer = { err: 2 };
        } else {
          const layer = {
            id: fakeNextLayerId++,
            name: `Layer ${fakeStudioLayers.length}`,
            bindings: FAKE_LAYOUT_KEYS.map(() => ({ behaviorId: 3, param1: 0, param2: 0 })),
          };
          fakeStudioLayers.push(layer);
          fakeStudioDirty = true;
          rr.keymap.addLayer = { ok: { index: fakeStudioLayers.length - 1, layer } };
        }
      }
      if (km.removeLayer) {
        const idx = km.removeLayer.layerIndex;
        if (idx < 0 || idx >= fakeStudioLayers.length) {
          rr.keymap.removeLayer = { err: 2 };
        } else {
          fakeStudioLayers.splice(idx, 1);
          fakeStudioDirty = true;
          rr.keymap.removeLayer = { ok: {} };
        }
      }
    }
    return rr;
  }

  function handleStudioWrite(b64) {
    if (!window.TpStudio || !studioDecoder) return;
    const bytes = base64ToBytesLocal(b64);
    const frames = studioDecoder.push(bytes);
    for (const frame of frames) {
      let req;
      try {
        req = window.TpStudio._decodeMessage('zmk.studio.Request', frame);
      } catch (e) {
        continue;
      }
      const hadDirty = fakeStudioDirty;
      const rr = studioHandleRequest(req);
      sendStudioResponse({ requestResponse: rr });
      if (fakeStudioDirty !== hadDirty) notifyUnsavedChanged();
    }
  }

  function elapsedMs() {
    return Date.now() - startReal;
  }

  function emit(evt) {
    Promise.resolve().then(() => {
      if (window.tpTunerNative && typeof window.tpTunerNative.onEvent === 'function') {
        window.tpTunerNative.onEvent(evt);
      }
    });
  }

  function responseLines(argv, sideLabel, sideKey) {
    const sub = argv[0];
    if (sub === 'trace') return [`OK trace=${argv[1] || 'off'}`];
    if (sub === 'info') return [`side=${sideLabel} uptime_ms=${elapsedMs()} params=${PARAMS[sideKey].length} saved=no`];
    if (sub === 'list') return PARAMS[sideKey].map((p) => `${p.name} ${p.value} ${p.min} ${p.max} ${p.kind} ${p.def}`);
    if (sub === 'set') {
      const name = argv[1];
      const value = argv[2];
      const p = PARAMS[sideKey].find((x) => x.name === name);
      if (p) p.value = Number(value);
      return [`OK ${name}=${value}`];
    }
    if (sub === 'live') {
      if (argv[1] === 'on') return [`OK live=on hz=${argv[2] || ''}`];
      return ['OK live=off'];
    }
    return [`OK ${sub}`];
  }

  function handleWriteBle(text) {
    const m = /^([RL])\s+(.*)$/.exec(String(text).trim());
    if (!m) return;
    const side = m[1];
    if (side === 'L' && fakeLeftDown) {
      emit({ type: 'data', text: 'L ERR timeout\n' });
      emit({ type: 'data', text: 'L .\n' });
      return;
    }
    const argv = m[2].trim().split(/\s+/);
    if (side === 'R' && argv[0] === 'live') liveOn = argv[1] === 'on';
    const sideLabel = side === 'R' ? 'central' : 'peripheral';
    const lines = responseLines(argv, sideLabel, side).concat(['.']);
    for (const l of lines) emit({ type: 'data', text: `${side} ${l}\n` });
  }

  function handleWriteUsb(text) {
    if (connectedId === 'usb-bad') return;
    const cmd = String(text).replace(/[\r\n]+$/, '');
    const argv = cmd.trim().split(/\s+/).slice(1);
    emit({ type: 'data', text: cmd + '\r\n' });
    for (const l of responseLines(argv, 'central', 'R')) emit({ type: 'data', text: l + '\r\n' });
    emit({ type: 'data', text: 'uart:~$ ' });
  }

  function handleWrite(text) {
    const device = DEVICES.find((d) => d.id === connectedId);
    if (!device) return;
    if (device.kind === 'usb') handleWriteUsb(text); else handleWriteBle(text);
  }

  function stopSummaryTimer() {
    if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  }

  function startSummaryTimer() {
    stopSummaryTimer();
    summarySide = 'R';
    summaryTimer = setInterval(() => {
      const device = DEVICES.find((d) => d.id === connectedId);
      if (!device || device.kind !== 'ble') return;
      if (summarySide === 'L' && fakeLeftDown) { summarySide = 'R'; return; }
      const end = elapsedMs();
      const start = Math.max(0, end - 100);
      const summary = `T S ${start} ${end} 1 1 100 -1 5 0 0 0 1 1 0 0 3 0 0`;
      emit({ type: 'data', text: `${summarySide} ${summary}\n` });
      summarySide = summarySide === 'R' ? 'L' : 'R';
    }, 3000);
  }

  function stopLiveTimer() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function startLiveTimer() {
    stopLiveTimer();
    if (!fakeLive) return;
    const t0 = elapsedMs();
    const CX = 1200, CY = 1500, RADIUS = 500;
    const SCROLL_X1 = 1000, SCROLL_X2 = 1400;
    let prevX = CX + RADIUS, prevY = CY;
    liveTimer = setInterval(() => {
      const device = DEVICES.find((d) => d.id === connectedId);
      if (!device || device.kind !== 'ble' || !liveOn) return;
      const ms = elapsedMs();
      const phase = (ms - t0) % 6000;
      let fingers, f1x, f1y, f2x, f2y, mode2f, relX, relY;
      if (phase < 3000) {
        fingers = 1;
        mode2f = 0;
        const angle = (phase / 3000) * 2 * Math.PI;
        f1x = Math.round(CX + RADIUS * Math.cos(angle));
        f1y = Math.round(CY + RADIUS * Math.sin(angle));
        f2x = 0; f2y = 0;
        relX = f1x - prevX; relY = f1y - prevY;
        prevX = f1x; prevY = f1y;
      } else {
        fingers = 2;
        mode2f = 1;
        const t = phase - 3000;
        const y = Math.round(1000 + (t / 3000) * 1000);
        f1x = SCROLL_X1; f1y = y;
        f2x = SCROLL_X2; f2y = y;
        relX = 0; relY = 6;
        prevX = f1x; prevY = f1y;
      }
      const frame = `T F ${ms} ${fingers} ${relX} ${relY} ${f1x} ${f1y} ${f2x} ${f2y} 0000 0 ${mode2f} 0`;
      emit({ type: 'data', text: `R ${frame}\n` });
    }, 33);
  }

  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.tpTuner = {
    postMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'listDevices') {
        emit({ type: 'devices', devices: DEVICES });
      } else if (msg.type === 'connect') {
        const device = DEVICES.find((d) => d.id === msg.id) || DEVICES[0];
        connectedId = device.id;
        liveOn = false;
        fakeStudioUsbReady = false;
        emit({ type: 'connected', id: device.id, kind: device.kind, name: device.name });
        startSummaryTimer();
        startLiveTimer();
        if (device.kind === 'ble') {
          setTimeout(() => { if (connectedId === device.id) emit({ type: 'studioReady', available: true }); }, 150);
        }
      } else if (msg.type === 'disconnect') {
        connectedId = null;
        liveOn = false;
        fakeStudioUsbReady = false;
        stopSummaryTimer();
        stopLiveTimer();
        emit({ type: 'disconnected', reason: '切断されました' });
      } else if (msg.type === 'write') {
        handleWrite(msg.text);
      } else if (msg.type === 'studioOpen') {
        const other = DEVICES.find((d) => d.kind === 'usb' && d.id === msg.id);
        fakeStudioUsbReady = !!other;
        emit({ type: 'studioReady', available: fakeStudioUsbReady });
      } else if (msg.type === 'studioClose') {
        fakeStudioUsbReady = false;
      } else if (msg.type === 'studioWrite') {
        handleStudioWrite(msg.b64);
      } else if (msg.type === 'presetsLoad') {
        emit(fakePresetsText === null ? { type: 'presetsLoaded', ok: true } : { type: 'presetsLoaded', ok: true, text: fakePresetsText });
      } else if (msg.type === 'presetsSave') {
        fakePresetsText = msg.text;
        emit({ type: 'presetsSaved', ok: true });
      }
    },
  };
})();
