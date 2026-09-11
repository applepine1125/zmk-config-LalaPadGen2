(function (root) {
  'use strict';
  const T = globalThis.TpTuner;
  if (!T) return;

  const $ = (id) => document.getElementById(id);

  const CMD_TIMEOUT_MS = 5000;
  const BLE_LIST_TIMEOUT_MS = 8000;
  const PROBE_TIMEOUT_MS = 1500;
  const SETTLE_MS = 200;
  const RECONNECT_SETTLE_MS = 1000;
  const AUTOCONNECT_KEY = 'tp-tuner.autoconnect';
  const LASTPORT_KEY = 'tp-tuner.lastPort';
  const PRESETS_KEY = 'tp-tuner.presets';
  const DISCONNECTED_MSG = '切断されました。再接続を待っています';
  const SIDE_LABEL = { R: '右手', L: '左手' };

  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  const hasNativeBridge = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tpTuner);
  const link = { pending: null, lines: [], queue: [] };
  let transport = null;
  let connected = false;
  let buffer = '';
  let usbSide = null;
  let bleLeftAvailable = false;
  let awaitingDevicePick = false;
  let lastDevices = [];
  let lastFailedDeviceSetKey = null;
  const clock = { offset: { R: 0, L: 0 } };
  const connInfo = { R: null, L: null };
  let busyConnecting = false;
  let autoConnectEnabled = true;
  let connectedDeviceId = null;
  let pendingSaveFile = null;
  const pendingLoadPresets = [];
  const pendingSavePresets = [];

  const hooks = {
    onLog: null, onTrace: null, onStatus: null, onUiChange: null, onReady: null,
    onStudioReady: null, onStudioData: null, onStudioClosed: null, onUnsupported: null,
  };

  function isConnected() {
    return !!(transport && connected);
  }

  function activeSides() {
    if (!isConnected()) return [];
    if (transport.kind === 'ble') return bleLeftAvailable ? ['R', 'L'] : ['R'];
    return usbSide ? [usbSide] : [];
  }

  function isSideActive(sideKey) {
    return activeSides().includes(sideKey);
  }

  function setStatus(msg, isError) {
    if (hooks.onStatus) hooks.onStatus(msg, isError);
  }

  function log(text) {
    if (hooks.onLog) hooks.onLog(text);
  }

  function handleUsbLine(raw) {
    const line = T.stripPromptPrefix(raw);
    const trace = T.parseTraceLine(line);
    if (trace) {
      if (hooks.onTrace) hooks.onTrace(trace, usbSide);
      return;
    }
    const p = link.pending;
    if (p) {
      if (!p.seen) {
        if (T.isEcho(line, p.cmd)) p.seen = true;
      } else if (line.trim() !== '') {
        link.lines.push(line);
      }
    }
    log(line);
  }

  function handleBleLine(line) {
    const parsed = T.splitSidePrefix(line);
    if (parsed) {
      const trace = T.parseTraceLine(parsed.rest);
      if (trace) {
        if (hooks.onTrace) hooks.onTrace(trace, parsed.side);
      } else if (link.pending && parsed.side === link.pending.side) {
        if (T.isEndMarker(parsed.rest)) finishPending(null, link.lines);
        else if (parsed.rest.trim() !== '') link.lines.push(parsed.rest);
      }
    }
    log(line);
  }

  function onRawData(text) {
    if (!transport) return;
    buffer += text;
    if (transport.kind === 'ble') {
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleBleLine(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    } else {
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleUsbLine(T.stripAnsi(buffer.slice(0, nl)).replace(/\r/g, ''));
        buffer = buffer.slice(nl + 1);
      }
      const tail = T.stripAnsi(buffer).replace(/\r/g, '');
      if (T.isPrompt(tail)) {
        buffer = '';
        if (link.pending && link.pending.seen) finishPending(null, link.lines);
      }
    }
  }

  function finishPending(err, lines) {
    const p = link.pending;
    if (!p) return;
    link.pending = null;
    clearTimeout(p.timer);
    link.lines = [];
    if (err) p.reject(err); else p.resolve(lines);
    pump();
  }

  function createWebSerialTransport() {
    let port = null, reader = null, writer = null, loopDone = null;
    const t = { kind: 'usb', onData: null, onClose: null };
    async function readLoop(p) {
      const decoder = new TextDecoderStream();
      const closed = p.readable.pipeTo(decoder.writable).catch(() => {});
      reader = decoder.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (t.onData) t.onData(value);
        }
      } catch (e) {
        if (port === p) log('読み取りエラー: ' + errText(e));
      } finally {
        try { reader.releaseLock(); } catch (e) { /* already released */ }
        await closed;
      }
    }
    t.connect = async (target) => {
      await target.open({ baudRate: 115200 });
      port = target;
      writer = port.writable.getWriter();
      port.addEventListener('disconnect', () => { if (port === target) { port = null; if (t.onClose) t.onClose(DISCONNECTED_MSG); } });
      loopDone = readLoop(target);
      loopDone.then(() => { if (port === target) { port = null; if (t.onClose) t.onClose(DISCONNECTED_MSG); } });
    };
    t.disconnect = async () => {
      const p = port;
      if (!p) return;
      port = null;
      try { if (writer) writer.releaseLock(); } catch (e) { /* ignore */ }
      writer = null;
      try { if (reader) await reader.cancel(); } catch (e) { /* ignore */ }
      try { await loopDone; } catch (e) { /* ignore */ }
      reader = null;
      loopDone = null;
      try { await p.close(); } catch (e) { log('ポートを閉じられません: ' + errText(e)); }
    };
    t.write = (text) => {
      if (!writer) return Promise.reject(new Error('未接続です'));
      return writer.write(new TextEncoder().encode(text + '\r\n'));
    };
    t.getPort = () => port;
    return t;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function createNativeTransport() {
    const bridge = window.webkit.messageHandlers.tpTuner;
    const t = {
      kind: 'usb', isNative: true, onData: null, onClose: null, onDevices: null, onConnected: null, onStatus: null,
      onStudioReady: null, onStudioData: null, onStudioClosed: null,
    };
    t.listDevices = () => { bridge.postMessage({ type: 'listDevices' }); };
    t.studioWrite = (bytes) => {
      bridge.postMessage({ type: 'studioWrite', b64: bytesToBase64(bytes) });
      return Promise.resolve();
    };
    t.studioOpen = (id) => { bridge.postMessage({ type: 'studioOpen', id }); };
    t.studioClose = () => { bridge.postMessage({ type: 'studioClose' }); };
    t.connect = (id) => new Promise((resolve, reject) => {
      const savedOnConnected = t.onConnected;
      const savedOnClose = t.onClose;
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        t.onConnected = savedOnConnected;
        t.onClose = savedOnClose;
        fn(arg);
      };
      t.onConnected = (evt) => { t.kind = evt.kind; finish(resolve, evt); };
      t.onClose = (reason) => finish(reject, new Error(reason || '接続に失敗しました'));
      bridge.postMessage({ type: 'connect', id });
    });
    t.disconnect = () => {
      bridge.postMessage({ type: 'disconnect' });
      return Promise.resolve();
    };
    t.write = (text) => {
      bridge.postMessage({ type: 'write', text: t.kind === 'usb' ? text + '\r\n' : text });
      return Promise.resolve();
    };
    window.tpTunerNative = {
      onEvent(evt) {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'devices') { if (t.onDevices) t.onDevices(evt.devices || []); }
        else if (evt.type === 'connected') { t.kind = evt.kind; if (t.onConnected) t.onConnected(evt); }
        else if (evt.type === 'data') { if (t.onData) t.onData(evt.text); }
        else if (evt.type === 'disconnected') { if (t.onClose) t.onClose(evt.reason); }
        else if (evt.type === 'status') { if (t.onStatus) t.onStatus(evt.text); }
        else if (evt.type === 'studioReady') { if (t.onStudioReady) t.onStudioReady(!!evt.available); }
        else if (evt.type === 'studioData') { if (t.onStudioData) t.onStudioData(evt.b64); }
        else if (evt.type === 'studioClosed') { if (t.onStudioClosed) t.onStudioClosed(evt.reason); }
        else if (evt.type === 'fileSaved') { if (pendingSaveFile) { const r = pendingSaveFile; pendingSaveFile = null; r(evt); } }
        else if (evt.type === 'presetsLoaded') { if (pendingLoadPresets.length) pendingLoadPresets.shift()({ ok: evt.ok, text: evt.text, error: evt.error }); }
        else if (evt.type === 'presetsSaved') { if (pendingSavePresets.length) pendingSavePresets.shift()({ ok: evt.ok, error: evt.error }); }
      },
    };
    return t;
  }

  function attachTransportHandlers(t) {
    t.onData = onRawData;
    t.onClose = (reason) => { if (transport === t) disconnect(reason || DISCONNECTED_MSG, true); };
    if ('onDevices' in t) t.onDevices = handleNativeDevices;
    if ('onStatus' in t) t.onStatus = (text) => setStatus(text);
    if ('onStudioReady' in t) t.onStudioReady = (available) => { if (hooks.onStudioReady) hooks.onStudioReady(available); };
    if ('onStudioData' in t) t.onStudioData = (b64) => { if (hooks.onStudioData) hooks.onStudioData(base64ToBytes(b64)); };
    if ('onStudioClosed' in t) t.onStudioClosed = (reason) => { if (hooks.onStudioClosed) hooks.onStudioClosed(reason); };
  }

  function pump() {
    if (link.pending || link.queue.length === 0) return;
    if (!isConnected()) {
      for (const q of link.queue.splice(0)) q.reject(new Error('未接続です'));
      return;
    }
    const p = link.queue.shift();
    link.pending = p;
    link.lines = [];
    p.timer = setTimeout(() => {
      if (link.pending === p) finishPending(new Error('タイムアウト: ' + p.cmd));
    }, p.timeoutMs);
    const wireText = transport.kind === 'ble' ? T.bleCommand(p.side || 'R', p.cmd) : p.cmd;
    transport.write(wireText).catch((e) => {
      if (link.pending === p) finishPending(new Error('送信失敗: ' + errText(e)));
    });
  }

  function defaultTimeoutFor(cmd) {
    if (transport && transport.kind === 'ble' && cmd === 'tp list') return BLE_LIST_TIMEOUT_MS;
    return CMD_TIMEOUT_MS;
  }

  function send(cmd, opts) {
    const side = opts && opts.side;
    const timeoutMs = (opts && opts.timeoutMs) || defaultTimeoutFor(cmd);
    return new Promise((resolve, reject) => {
      if (!isConnected()) return reject(new Error('未接続です: ' + cmd));
      link.queue.push({ cmd, side: side || null, resolve, reject, timer: null, seen: false, timeoutMs });
      pump();
    });
  }

  function sendTo(sideKey, cmd, timeoutMs) {
    if (transport && transport.kind === 'ble') return send(cmd, { side: sideKey, timeoutMs });
    return send(cmd, { timeoutMs });
  }

  async function runSimpleOnSide(sideKey, cmd) {
    try {
      const lines = await sendTo(sideKey, cmd);
      const ok = lines.some((l) => l.startsWith('OK'));
      log(`[${sideKey}] ` + lines.join('\n'));
      return ok;
    } catch (e) {
      log(`[${sideKey}] ` + errText(e));
      return false;
    }
  }

  function saveFile(name, text) {
    if (hasNativeBridge) {
      return new Promise((resolve) => {
        pendingSaveFile = resolve;
        window.webkit.messageHandlers.tpTuner.postMessage({ type: 'saveFile', name, text });
      });
    }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return Promise.resolve({ ok: true });
  }

  function loadPresetsText() {
    if (hasNativeBridge) {
      return new Promise((resolve) => {
        pendingLoadPresets.push(resolve);
        window.webkit.messageHandlers.tpTuner.postMessage({ type: 'presetsLoad' });
      });
    }
    try {
      const text = localStorage.getItem(PRESETS_KEY);
      return Promise.resolve(text === null ? { ok: true } : { ok: true, text });
    } catch (e) {
      return Promise.resolve({ ok: false, error: errText(e) });
    }
  }

  function savePresetsText(text) {
    if (hasNativeBridge) {
      return new Promise((resolve) => {
        pendingSavePresets.push(resolve);
        window.webkit.messageHandlers.tpTuner.postMessage({ type: 'presetsSave', text });
      });
    }
    try {
      localStorage.setItem(PRESETS_KEY, text);
      return Promise.resolve({ ok: true });
    } catch (e) {
      return Promise.resolve({ ok: false, error: errText(e) });
    }
  }

  function updateConnectedState(isConn) {
    if (!isConn) {
      connInfo.R = null; connInfo.L = null;
      usbSide = null;
      bleLeftAvailable = false;
      hideDevicePanel();
      lastFailedDeviceSetKey = null;
      connectedDeviceId = null;
    }
    if (hooks.onUiChange) hooks.onUiChange(isConn);
  }

  function readLastPort() {
    try {
      const raw = localStorage.getItem(LASTPORT_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.usbVendorId === 'number' && typeof obj.usbProductId === 'number') return obj;
    } catch (e) { /* localStorage が使えない・壊れた JSON */ }
    return null;
  }

  function rememberPort(port, info) {
    if (!info) return;
    try {
      const pi = port.getInfo ? port.getInfo() : null;
      if (pi && typeof pi.usbVendorId === 'number' && typeof pi.usbProductId === 'number') {
        localStorage.setItem(LASTPORT_KEY, JSON.stringify({ usbVendorId: pi.usbVendorId, usbProductId: pi.usbProductId }));
      }
    } catch (e) { /* localStorage が使えない環境では無視 */ }
  }

  async function establishUsb(target) {
    buffer = '';
    await transport.connect(target);
    connected = true;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    buffer = '';
    let info = null;
    try {
      await send('tp trace off', { timeoutMs: PROBE_TIMEOUT_MS });
      for (let attempt = 0; attempt < 2 && !info; attempt++) {
        const before = performance.now();
        const infoLines = await send('tp info', { timeoutMs: PROBE_TIMEOUT_MS });
        const after = performance.now();
        info = infoLines.map(T.parseInfoLine).find(Boolean);
        if (info) {
          usbSide = info.side === 'central' ? 'R' : 'L';
          clock.offset[usbSide] = T.clockOffset(before, after, info.uptimeMs);
        }
      }
    } catch (e) {
      log('接続確認に失敗: ' + errText(e));
    }
    if (!info) throw new Error('このポートは tp コマンドに応答しません。もう一方のポートを選んでください');
    connInfo[usbSide] = info;
    sendTo(usbSide, 'tp trace on').catch((e) => log('trace on に失敗: ' + errText(e)));
    return info;
  }

  async function establishBle(target) {
    buffer = '';
    await transport.connect(target);
    connected = true;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    buffer = '';
    let infoR = null;
    for (let attempt = 0; attempt < 2 && !infoR; attempt++) {
      const before = performance.now();
      const lines = await send('tp info', { side: 'R', timeoutMs: PROBE_TIMEOUT_MS });
      const after = performance.now();
      infoR = lines.map(T.parseInfoLine).find(Boolean);
      if (infoR) clock.offset.R = T.clockOffset(before, after, infoR.uptimeMs);
    }
    if (!infoR) throw new Error('右手(central)が tp コマンドに応答しません');
    connInfo.R = infoR;
    bleLeftAvailable = false;
    try {
      const before = performance.now();
      const lines = await send('tp info', { side: 'L', timeoutMs: PROBE_TIMEOUT_MS });
      const after = performance.now();
      const infoL = lines.map(T.parseInfoLine).find(Boolean);
      if (infoL) {
        connInfo.L = infoL;
        clock.offset.L = T.clockOffset(before, after, infoL.uptimeMs);
        bleLeftAvailable = true;
      }
    } catch (e) {
      log('左手が応答しません(' + errText(e) + ')。右手だけで続行します');
    }
    return infoR;
  }

  function finalizeConnected(target, isNativeTarget) {
    if (!isNativeTarget && transport.kind !== 'ble') rememberPort(target, connInfo[usbSide]);
    updateConnectedState(true);
  }

  async function connectReady() {
    if (hooks.onReady) await hooks.onReady();
  }

  async function connectWebSerial() {
    if (!navigator.serial) {
      setStatus('このブラウザは Web Serial に対応していません。Chrome / Edge で開いてください', true);
      return;
    }
    let port;
    try {
      port = await navigator.serial.requestPort();
    } catch (e) {
      setStatus('ポートが選択されませんでした', false);
      return;
    }
    busyConnecting = true;
    try {
      transport = createWebSerialTransport();
      attachTransportHandlers(transport);
      setStatus('接続中...');
      await establishUsb(port);
      finalizeConnected(port, false);
      setStatus('接続しました');
      await connectReady();
      setStatus('');
    } catch (e) {
      setStatus(errText(e), true);
      log('接続失敗: ' + errText(e));
      await disconnect(null, true);
    } finally {
      busyConnecting = false;
    }
  }

  function connectNative() {
    awaitingDevicePick = true;
    lastFailedDeviceSetKey = null;
    setStatus('機器を検索しています...');
    renderDevicePanel([]);
    transport.listDevices();
  }

  async function connectToDevice(device) {
    if (isConnected() || busyConnecting) return;
    busyConnecting = true;
    hideDevicePanel();
    try {
      setStatus(`接続中... (${device.kind === 'ble' ? 'BT' : 'USB'}: ${device.name})`);
      if (device.kind === 'ble') await establishBle(device.id); else await establishUsb(device.id);
      connectedDeviceId = device.id;
      finalizeConnected(device.id, true);
      setStatus('接続しました');
      await connectReady();
      setStatus('');
    } catch (e) {
      setStatus(errText(e), true);
      log('接続失敗: ' + errText(e));
      await disconnect(null, true);
    } finally {
      busyConnecting = false;
    }
  }

  function renderDevicePanel(devices) {
    const panel = $('devicePanel');
    const sel = $('selDevice');
    sel.innerHTML = '';
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = (d.kind === 'ble' ? 'BT: ' : 'USB: ') + d.name;
      sel.appendChild(o);
    }
    panel.hidden = devices.length === 0;
    $('btnConnectDevice').disabled = devices.length === 0;
  }

  function hideDevicePanel() {
    awaitingDevicePick = false;
    $('devicePanel').hidden = true;
  }

  function deviceSetKey(devices) {
    return devices.map((d) => d.id).sort().join(',');
  }

  async function tryAutoConnectNative(devices, key) {
    busyConnecting = true;
    try {
      const ordered = T.orderDevices(devices);
      for (const device of ordered) {
        if (isConnected()) return;
        try {
          setStatus(`自動接続を試しています... (${device.kind === 'ble' ? 'BT' : 'USB'}: ${device.name})`);
          if (device.kind === 'ble') await establishBle(device.id); else await establishUsb(device.id);
          connectedDeviceId = device.id;
          finalizeConnected(device.id, true);
          setStatus(`自動接続しました(${device.kind === 'ble' ? 'BT' : 'USB'}: ${device.name})`);
          await connectReady();
          setStatus('');
          return;
        } catch (e) {
          log('自動接続の候補が応答しませんでした: ' + errText(e));
          await disconnect(null, true);
        }
      }
      lastFailedDeviceSetKey = key;
      setStatus('自動接続できませんでした。「接続」で機器を選んでください', true);
    } finally {
      busyConnecting = false;
    }
  }

  function handleNativeDevices(devices) {
    lastDevices = devices;
    if (awaitingDevicePick) {
      if (devices.length === 1) {
        awaitingDevicePick = false;
        hideDevicePanel();
        connectToDevice(devices[0]);
      } else {
        renderDevicePanel(devices);
      }
    } else if (autoConnectEnabled && !isConnected() && !busyConnecting) {
      const key = deviceSetKey(devices);
      if (devices.length && key !== lastFailedDeviceSetKey) tryAutoConnectNative(devices, key);
    }
  }

  async function connect() {
    if (isConnected() || busyConnecting) return;
    if (hasNativeBridge) connectNative();
    else await connectWebSerial();
  }

  function readAutoConnectPref() {
    try {
      const v = localStorage.getItem(AUTOCONNECT_KEY);
      return v === null ? true : v === '1';
    } catch (e) {
      return true;
    }
  }

  function writeAutoConnectPref(enabled) {
    try {
      localStorage.setItem(AUTOCONNECT_KEY, enabled ? '1' : '0');
    } catch (e) { /* localStorage が使えない環境では無視 */ }
  }

  async function tryAutoConnect() {
    if (!navigator.serial || !autoConnectEnabled) return;
    if (isConnected() || busyConnecting) return;
    busyConnecting = true;
    try {
      const ports = await navigator.serial.getPorts();
      if (!ports.length) return;
      const ordered = T.pickPortOrder(ports, readLastPort());
      for (const port of ordered) {
        try {
          setStatus('自動接続を試しています...');
          transport = createWebSerialTransport();
          attachTransportHandlers(transport);
          await establishUsb(port);
          finalizeConnected(port, false);
          const pi = port.getInfo ? port.getInfo() : {};
          setStatus(`自動接続しました(vendorId=${pi.usbVendorId ?? '?'} productId=${pi.usbProductId ?? '?'})`);
          await connectReady();
          setStatus('');
          return;
        } catch (e) {
          log('自動接続の候補ポートが応答しませんでした: ' + errText(e));
          await disconnect(null, true);
        }
      }
      setStatus('自動接続できませんでした。「接続」でポートを選んでください', true);
    } finally {
      busyConnecting = false;
    }
  }

  async function disconnect(msg, isError) {
    if (!transport || !connected) {
      if (msg) setStatus(msg, !!isError);
      return;
    }
    connected = false;
    for (const q of link.queue.splice(0)) q.reject(new Error('切断されました'));
    finishPending(new Error('切断されました'));
    try {
      await transport.disconnect();
    } catch (e) {
      log('切断に失敗しました: ' + errText(e));
    }
    if (!transport.isNative) transport = null;
    buffer = '';
    updateConnectedState(false);
    if (msg) setStatus(msg, !!isError);
    else if (!isError) setStatus('切断しました');
  }

  function studioWrite(bytes) {
    if (!transport || typeof transport.studioWrite !== 'function') return Promise.reject(new Error('未接続です'));
    return transport.studioWrite(bytes);
  }

  function studioOpen(id) {
    if (transport && typeof transport.studioOpen === 'function') transport.studioOpen(id);
  }

  function studioClose() {
    if (transport && typeof transport.studioClose === 'function') transport.studioClose();
  }

  $('btnConnectDevice').onclick = () => {
    const id = $('selDevice').value;
    const device = lastDevices.find((d) => d.id === id);
    if (device) { hideDevicePanel(); connectToDevice(device); }
  };

  if (!hasNativeBridge && navigator.serial) {
    navigator.serial.addEventListener('connect', () => {
      if (!autoConnectEnabled || isConnected()) return;
      setTimeout(() => { tryAutoConnect(); }, RECONNECT_SETTLE_MS);
    });
    navigator.serial.addEventListener('disconnect', (e) => {
      if (transport && transport.getPort && transport.getPort() === e.target) disconnect(DISCONNECTED_MSG, true);
    });
  }

  function init(h) {
    Object.assign(hooks, h);
    autoConnectEnabled = readAutoConnectPref();
    $('chkAutoConnect').checked = autoConnectEnabled;
    $('chkAutoConnect').onchange = () => {
      autoConnectEnabled = $('chkAutoConnect').checked;
      writeAutoConnectPref(autoConnectEnabled);
      if (autoConnectEnabled) { if (hasNativeBridge) transport.listDevices(); else tryAutoConnect(); }
    };
    updateConnectedState(false);
    if (hasNativeBridge) {
      transport = createNativeTransport();
      attachTransportHandlers(transport);
      setStatus('「接続」を押して機器を選んでください');
      if (autoConnectEnabled) transport.listDevices();
    } else if (!navigator.serial) {
      if (hooks.onUnsupported) hooks.onUnsupported();
    } else {
      setStatus('「接続」を押してトラックパッド側の USB シリアルポートを選んでください');
      if (autoConnectEnabled) tryAutoConnect();
    }
  }

  const api = {
    hasNativeBridge, SIDE_LABEL,
    init, connect, disconnect,
    send, sendTo, runSimpleOnSide, saveFile, loadPresetsText, savePresetsText,
    isConnected, activeSides, isSideActive,
    studioWrite, studioOpen, studioClose,
    getTransportKind: () => (transport ? transport.kind : null),
    getUsbSide: () => usbSide,
    getBleLeftAvailable: () => bleLeftAvailable,
    getClockOffset: (sideKey) => clock.offset[sideKey] || 0,
    getConnInfo: (sideKey) => connInfo[sideKey],
    setConnInfo: (sideKey, info) => { connInfo[sideKey] = info; },
    getConnectedDeviceId: () => connectedDeviceId,
    getLastDevices: () => lastDevices,
  };
  root.TpAppLink = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
