(function () {
  'use strict';
  const badUsbMode = /(?:^|[?&])fakeBadUsb=1(?:&|$)/.test(location.search);
  const DEVICES = badUsbMode
    ? [
      { id: 'usb-bad', kind: 'usb', name: 'usbmodem-bad' },
      { id: 'usb-good', kind: 'usb', name: 'usbmodem-good' },
    ]
    : [{ id: 'fake-ble-1', kind: 'ble', name: 'LalapadGen2' }];
  const PARAMS = [
    { name: '1f_tap_max_ms', value: 250, min: 1, max: 1000, kind: 'driver', def: 250 },
    { name: '1f_tap_move', value: 50, min: 0, max: 500, kind: 'driver', def: 50 },
  ];
  let connectedId = null;
  let summaryTimer = null;
  const startReal = Date.now();

  function elapsedMs() {
    return Date.now() - startReal;
  }

  function emit(evt) {
    if (window.tpTunerNative && typeof window.tpTunerNative.onEvent === 'function') {
      window.tpTunerNative.onEvent(evt);
    }
  }

  function responseLines(argv, sideLabel) {
    const sub = argv[0];
    if (sub === 'trace') return [`OK trace=${argv[1] || 'off'}`];
    if (sub === 'info') return [`side=${sideLabel} uptime_ms=${elapsedMs()} params=${PARAMS.length} saved=no`];
    if (sub === 'list') return PARAMS.map((p) => `${p.name} ${p.value} ${p.min} ${p.max} ${p.kind} ${p.def}`);
    if (sub === 'set') {
      const name = argv[1];
      const value = argv[2];
      const p = PARAMS.find((x) => x.name === name);
      if (p) p.value = Number(value);
      return [`OK ${name}=${value}`];
    }
    return [`OK ${sub}`];
  }

  function handleWriteBle(text) {
    const m = /^([RL])\s+(.*)$/.exec(String(text).trim());
    if (!m) return;
    const side = m[1];
    const sideLabel = side === 'R' ? 'central' : 'peripheral';
    const lines = responseLines(m[2].trim().split(/\s+/), sideLabel).concat(['.']);
    for (const l of lines) emit({ type: 'data', text: `${side} ${l}\n` });
  }

  function handleWriteUsb(text) {
    if (connectedId === 'usb-bad') return;
    const cmd = String(text).replace(/[\r\n]+$/, '');
    const argv = cmd.trim().split(/\s+/).slice(1);
    emit({ type: 'data', text: cmd + '\r\n' });
    for (const l of responseLines(argv, 'central')) emit({ type: 'data', text: l + '\r\n' });
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
    summaryTimer = setInterval(() => {
      const device = DEVICES.find((d) => d.id === connectedId);
      if (!device || device.kind !== 'ble') return;
      const end = elapsedMs();
      const start = Math.max(0, end - 100);
      const summary = `T S ${start} ${end} 1 1 100 -1 5 0 0 0 1 1 0 0 3 0 0`;
      emit({ type: 'data', text: `R ${summary}\n` });
    }, 3000);
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
      } else if (msg.type === 'disconnect') {
        connectedId = null;
        stopSummaryTimer();
        emit({ type: 'disconnected', reason: '切断されました' });
      } else if (msg.type === 'write') {
        handleWrite(msg.text);
      }
    },
  };
})();
