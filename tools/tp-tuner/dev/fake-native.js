(function () {
  'use strict';
  const badUsbMode = /(?:^|[?&])fakeBadUsb=1(?:&|$)/.test(location.search);
  const fakeLive = /(?:^|[?&])fakeLive=1(?:&|$)/.test(location.search);
  const fakeLeftDown = /(?:^|[?&])fakeLeftDown=1(?:&|$)/.test(location.search);
  const DEVICES = badUsbMode
    ? [
      { id: 'usb-bad', kind: 'usb', name: 'usbmodem-bad' },
      { id: 'usb-good', kind: 'usb', name: 'usbmodem-good' },
    ]
    : [{ id: 'fake-ble-1', kind: 'ble', name: 'LalapadGen2' }];
  function makeParams(tapMaxMs) {
    return [
      { name: '1f_tap_max_ms', value: tapMaxMs, min: 1, max: 1000, kind: 'driver', def: 250 },
      { name: '1f_tap_move', value: 50, min: 0, max: 500, kind: 'driver', def: 50 },
      { name: '2f_scroll_start_move', value: 15, min: 0, max: 200, kind: 'driver', def: 15 },
      { name: 'touch_set_threshold', value: 20, min: 1, max: 255, kind: 'ic_u8', def: 20 },
      { name: 'cursor_inertia_enable', value: 0, min: 0, max: 1, kind: 'driver_bool', def: 0 },
    ];
  }
  const PARAMS = { R: makeParams(250), L: makeParams(200) };
  let connectedId = null;
  let summaryTimer = null;
  let summarySide = 'R';
  let liveTimer = null;
  const startReal = Date.now();

  function elapsedMs() {
    return Date.now() - startReal;
  }

  function emit(evt) {
    if (window.tpTunerNative && typeof window.tpTunerNative.onEvent === 'function') {
      window.tpTunerNative.onEvent(evt);
    }
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
    const sideLabel = side === 'R' ? 'central' : 'peripheral';
    const lines = responseLines(m[2].trim().split(/\s+/), sideLabel, side).concat(['.']);
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
      if (!device || device.kind !== 'ble') return;
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
        emit({ type: 'connected', id: device.id, kind: device.kind, name: device.name });
        startSummaryTimer();
        startLiveTimer();
      } else if (msg.type === 'disconnect') {
        connectedId = null;
        stopSummaryTimer();
        stopLiveTimer();
        emit({ type: 'disconnected', reason: '切断されました' });
      } else if (msg.type === 'write') {
        handleWrite(msg.text);
      }
    },
  };
})();
