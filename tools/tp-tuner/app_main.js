(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const T = globalThis.TpTuner;
  if (!T) {
    $('notice').textContent = 'tuner.js が読み込めません。index.html と同じフォルダに tuner.js を置いてください';
    $('notice').hidden = false;
    return;
  }
  const Link = root.TpAppLink;
  const Params = root.TpAppParams;
  const Pad = root.TpAppPad;
  const Keymap = root.TpAppKeymap;
  if (!Link || !Params || !Pad || !Keymap) {
    $('notice').textContent = 'モジュールが読み込めません。index.html と同じフォルダに app_*.js を置いてください';
    $('notice').hidden = false;
    return;
  }

  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function showNotice(msg) {
    const el = $('notice');
    el.textContent = msg;
    el.hidden = !msg;
  }

  const logLines = [];
  function log(text) {
    if (text === undefined || text === null || text === '') return;
    for (const l of String(text).split('\n')) logLines.push(l);
    while (logLines.length > 300) logLines.shift();
    const el = $('log');
    el.textContent = logLines.join('\n');
    el.scrollTop = el.scrollHeight;
  }

  async function readStats() {
    const sides = Link.activeSides();
    if (!sides.length) { setStatus('未接続です', true); return; }
    $('logbox').open = true;
    for (const side of sides) {
      try {
        const lines = await Link.sendTo(side, 'tp stats');
        log(`[${side}] ` + lines.join('\n'));
        console.log(`stats[${side}] ` + lines.join(' | '));
      } catch (e) {
        log(`[${side}] ` + errText(e));
      }
    }
  }

  function sideStatusText(sideKey, info, unavailable) {
    const label = Link.SIDE_LABEL[sideKey];
    if (unavailable) return `${label} ✗応答なし`;
    if (!info) return `${label} -`;
    return `${label} ✓`;
  }

  function renderHeader() {
    let text = '未接続';
    if (Link.isConnected()) {
      const modeText = Link.getTransportKind() === 'ble' ? 'BT' : 'USB';
      const parts = Link.getTransportKind() === 'ble'
        ? [sideStatusText('R', Link.getConnInfo('R')), sideStatusText('L', Link.getConnInfo('L'), !Link.getBleLeftAvailable())]
        : [sideStatusText(Link.getUsbSide(), Link.getConnInfo(Link.getUsbSide()))];
      text = `${modeText}: ${parts.join(' ／ ')}`;
    }
    $('connStatus').textContent = text;
    const n = Params.pendingCount();
    $('dirtyIndicator').hidden = n === 0;
    $('dirtyIndicator').textContent = `未書き込みの変更 ${n} 件`;
    $('btnWrite').disabled = !Link.isConnected() || n === 0;
  }

  function setConnectedUi(isConn) {
    Pad.markPadDirty();
    $('btnConnect').disabled = isConn || (!navigator.serial && !Link.hasNativeBridge);
    $('btnDisconnect').disabled = !isConn;
    Params.setButtonsEnabled(isConn);
    if (!isConn) {
      Pad.resetTrackpadQuiet();
      Params.reset();
      Keymap.disconnectCleanup();
    }
    renderHeader();
    Params.render();
    for (const s of ['R', 'L']) Pad.renderPadStatus(s);
    Keymap.updateAvailability();
  }

  function setActiveTab(tab) {
    Pad.markPadDirty();
    $('tabTrackpad').hidden = tab !== 'trackpad';
    $('tabKeymap').hidden = tab !== 'keymap';
    $('trackpadActions').hidden = tab !== 'trackpad';
    $('keymapActions').hidden = tab !== 'keymap';
    $('tabBtnTrackpad').classList.toggle('active', tab === 'trackpad');
    $('tabBtnKeymap').classList.toggle('active', tab === 'keymap');
    Pad.setActiveTab(tab);
    Keymap.setActiveTab(tab);
    if (tab === 'keymap') Keymap.updateAvailability();
    else Pad.setTrackpadQuiet(false);
  }

  $('tabBtnTrackpad').onclick = () => setActiveTab('trackpad');
  $('tabBtnKeymap').onclick = () => setActiveTab('keymap');
  $('btnConnect').onclick = () => { Link.connect(); };
  $('btnDisconnect').onclick = () => { Link.disconnect(); };
  $('btnStats').onclick = (e) => { e.preventDefault(); e.stopPropagation(); readStats(); };
  $('btnLogCopy').onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    try { await navigator.clipboard.writeText(logLines.join('\n')); setStatus('ログをコピーしました'); }
    catch (err) { setStatus('クリップボードに書き込めません: ' + errText(err), true); }
  };
  window.addEventListener('beforeunload', () => { if (Link.isConnected()) Link.disconnect(null, true); });

  const api = { setStatus, showNotice, log, renderHeader };
  root.TpAppMain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  setActiveTab('trackpad');
  Link.init({
    onLog: log,
    onTrace: Pad.handleTrace,
    onStatus: setStatus,
    onUiChange: setConnectedUi,
    onReady: async () => { await Params.loadAllParams(); await Pad.sendLiveCommands(); },
    onStudioReady: Keymap.handleStudioReady,
    onStudioData: Keymap.handleStudioData,
    onStudioClosed: Keymap.handleStudioClosed,
    onUnsupported: () => showNotice('このブラウザは Web Serial API に対応していません。Google Chrome または Microsoft Edge で開いてください'),
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
