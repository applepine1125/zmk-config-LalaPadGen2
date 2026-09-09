(function () {
  'use strict';
  const DEVICE = { id: 'fake-ble-1', kind: 'ble', name: 'LalapadGen2' };
  const PARAMS = [
    { name: '1f_tap_max_ms', value: 250, min: 1, max: 1000, kind: 'driver', def: 250 },
    { name: '1f_tap_move', value: 50, min: 0, max: 500, kind: 'driver', def: 50 },
  ];
  let isConnected = false;
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

  function sendLines(side, lines) {
    for (const l of lines) emit({ type: 'data', text: `${side} ${l}\n` });
  }

  function handleWrite(text) {
    const m = /^([RL])\s+(.*)$/.exec(String(text).trim());
    if (!m) return;
    const side = m[1];
    const cmd = m[2];
    if (cmd === 'info') {
      const label = side === 'R' ? 'central' : 'peripheral';
      sendLines(side, [`side=${label} uptime_ms=${elapsedMs()} params=${PARAMS.length} saved=no`, '.']);
    } else if (cmd === 'list') {
      sendLines(side, PARAMS.map((p) => `${p.name} ${p.value} ${p.min} ${p.max} ${p.kind} ${p.def}`).concat(['.']));
    } else if (cmd.startsWith('set ')) {
      const parts = cmd.split(/\s+/);
      const name = parts[1];
      const value = parts[2];
      const p = PARAMS.find((x) => x.name === name);
      if (p) p.value = Number(value);
      sendLines(side, [`OK ${name}=${value}`, '.']);
    } else {
      sendLines(side, [`OK ${cmd}`, '.']);
    }
  }

  function stopSummaryTimer() {
    if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  }

  function startSummaryTimer() {
    stopSummaryTimer();
    summaryTimer = setInterval(() => {
      if (!isConnected) return;
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
        emit({ type: 'devices', devices: [DEVICE] });
      } else if (msg.type === 'connect') {
        isConnected = true;
        emit({ type: 'connected', id: DEVICE.id, kind: DEVICE.kind, name: DEVICE.name });
        startSummaryTimer();
      } else if (msg.type === 'disconnect') {
        isConnected = false;
        stopSummaryTimer();
        emit({ type: 'disconnected', reason: '切断されました' });
      } else if (msg.type === 'write') {
        handleWrite(msg.text);
      }
    },
  };
})();
