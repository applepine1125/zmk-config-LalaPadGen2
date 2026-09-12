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

  let busy = false;

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

    const conn = Link.isConnected();
    const pendingN = Params.pendingCount();
    const keymapDirty = Keymap.isDirty();
    const resetOnWrite = Keymap.isResetOnWrite();
    const dirtyParts = [];
    if (pendingN > 0) dirtyParts.push(`パッド ${pendingN} 件`);
    if (keymapDirty) dirtyParts.push('キー設定あり');
    $('dirtyIndicator').hidden = dirtyParts.length === 0;
    $('dirtyIndicator').textContent = dirtyParts.length ? `未書き込み: ${dirtyParts.join(' / ')}` : '';

    $('btnWrite').disabled = busy || !conn || !(pendingN > 0 || keymapDirty || resetOnWrite);
    $('btnReload').disabled = busy || !conn;
    $('btnExport').disabled = busy;

    Keymap.updateUndoButton();
    if (root.TpAppPresets) root.TpAppPresets.render();
  }

  function setBusy(v) {
    busy = v;
    renderHeader();
  }

  function isBusy() {
    return busy;
  }

  function setConnectedUi(isConn) {
    Pad.markPadDirty();
    $('btnConnect').disabled = isConn || (!navigator.serial && !Link.hasNativeBridge);
    $('btnDisconnect').disabled = !isConn;
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
    $('tabBtnTrackpad').classList.toggle('active', tab === 'trackpad');
    $('tabBtnKeymap').classList.toggle('active', tab === 'keymap');
    Pad.setActiveTab(tab);
    Keymap.setActiveTab(tab);
    if (tab === 'keymap') Keymap.updateAvailability();
    else Pad.setTrackpadQuiet(false);
  }

  async function doWrite() {
    if (busy) return;
    const resetRequested = Keymap.isResetOnWrite();
    let resetConfirmed = false;
    if (resetRequested) {
      resetConfirmed = window.confirm('キー設定をファーム既定に戻します。キーボードに保存済みの変更も消えます。よろしいですか?');
    }
    setBusy(true);
    try {
      const pendingBefore = Params.pendingCount();
      const keymapDirtyBefore = Keymap.isDirty();
      const writeResult = pendingBefore > 0 ? await Params.write() : null;
      let keymapErr = null;
      let keymapAction = '';
      if (resetRequested && resetConfirmed) {
        try {
          await Keymap.resetToDefault();
          Keymap.setResetOnWrite(false);
          keymapAction = 'reset';
        } catch (e) { keymapErr = errText(e); }
      } else if (keymapDirtyBefore) {
        try { await Keymap.save(); keymapAction = 'save'; } catch (e) { keymapErr = errText(e); }
      }
      if (!(writeResult && writeResult.total > 0) && !keymapAction && !keymapErr) { setStatus('書き込む変更がありません'); return; }
      const parts = [];
      if (writeResult && writeResult.written > 0) parts.push(`パッド ${writeResult.written} 件`);
      if (keymapAction === 'save') parts.push('キー設定');
      const msgs = [];
      if (parts.length) msgs.push(parts.join('と') + 'を書き込みました');
      if (keymapAction === 'reset') msgs.push('キー設定をファーム既定に戻しました');
      if (writeResult && writeResult.failed > 0) msgs.push(`パッド ${writeResult.failed} 件の書き込みに失敗しました。失敗した行は保留のままです`);
      if (keymapErr) msgs.push('キー設定の書き込みに失敗しました: ' + keymapErr);
      setStatus(msgs.join('。'), !!keymapErr || (writeResult && writeResult.failed > 0));
    } finally {
      setBusy(false);
    }
  }

  async function doReload() {
    if (busy) return;
    if (Params.pendingCount() > 0 || Keymap.isDirty()) {
      if (!window.confirm('書き込んでいない変更を捨てて、キーボードに保存されている状態に戻します。よろしいですか?')) return;
    }
    setBusy(true);
    try {
      await Params.reload();
      let keymapNote = '';
      if (await Keymap.ensureLoaded()) await Keymap.reload();
      else keymapNote = '(キー設定は Studio が使えないため読み込んでいません)';
      setStatus('再読み込みしました' + keymapNote);
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    if (busy) return;
    const confText = Params.exportConfText();
    if (confText === null) { setStatus('パラメータが読み込まれていません', true); return; }
    const keymapText = Keymap.exportKeymapText();
    const files = [{ name: 'lalapadgen2.conf', text: confText }];
    if (keymapText !== null) files.push({ name: 'lalapadgen2.keymap', text: keymapText });
    setBusy(true);
    try {
      const res = await Link.saveFiles(files);
      if (res.cancelled) return;
      if (!res.ok) {
        const savedNote = res.dir && res.saved && res.saved.length ? `(${res.dir} に ${res.saved.length} 件保存済み)` : '';
        setStatus('保存に失敗しました: ' + (res.error || '') + savedNote, true);
        return;
      }
      if (keymapText === null) { setStatus('キー設定を読めていないため .conf だけ保存しました'); return; }
      setStatus(res.dir ? `${res.dir} に ${files.length} 件保存しました` : `${files.length} 件保存しました`);
    } finally {
      setBusy(false);
    }
  }

  $('tabBtnTrackpad').onclick = () => setActiveTab('trackpad');
  $('tabBtnKeymap').onclick = () => setActiveTab('keymap');
  $('btnConnect').onclick = () => { Link.connect(); };
  $('btnDisconnect').onclick = () => { Link.disconnect(); };
  $('btnWrite').onclick = () => { doWrite(); };
  $('btnReload').onclick = () => { doReload(); };
  $('btnExport').onclick = () => { doExport(); };
  $('btnStats').onclick = (e) => { e.preventDefault(); e.stopPropagation(); readStats(); };
  $('btnLogCopy').onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    try { await navigator.clipboard.writeText(logLines.join('\n')); setStatus('ログをコピーしました'); }
    catch (err) { setStatus('クリップボードに書き込めません: ' + errText(err), true); }
  };
  window.addEventListener('beforeunload', () => { if (Link.isConnected()) Link.disconnect(null, true); });

  const api = { setStatus, showNotice, log, renderHeader, isBusy, setBusy };
  root.TpAppMain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  setActiveTab('trackpad');
  if (root.TpAppPresets) root.TpAppPresets.init();
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
