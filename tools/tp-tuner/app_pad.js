(function (root) {
  'use strict';
  const T = globalThis.TpTuner;
  if (!T) return;
  const Link = root.TpAppLink;
  if (!Link) return;

  const $ = (id) => document.getElementById(id);

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const KEEP_MS = 60000;
  const ATTEMPT_IDLE_MS = 400;
  const SUMMARY_WAIT_MS = 600;
  const PROCESS_INTERVAL_MS = 250;
  const STATE_STALE_MS = 600;
  const LIVE_ENABLED_KEY = 'tp-tuner.live.enabled';
  // 右手は Mac への BLE、左手は split リンク経由なので控えめにする
  const LIVE_RATE = { R: 60, L: 15 };
  const PAD_COLOR = { blue: '#38bdf8', green: '#34d399', orange: '#fb923c', purple: '#c084fc' };
  const PAD_H = 200;
  const PAD_W = Math.round(PAD_H * (2457 / 3072));
  const OPS_LOG_MAX = 30;
  const WHEEL_BURST_GAP_MS = 300;

  const rec = {
    R: { frames: [], fw: [] }, L: { frames: [], fw: [] },
    host: { btn: [], move: [], wheel: [] },
  };
  const processedStarts = { R: new Set(), L: new Set() };
  const pendingSummaries = { R: [], L: [] };
  let liveEnabled = true;
  const lastFrame = { R: null, L: null };
  const padTrail = { R: [], L: [] };
  const padFlash = { R: 0, L: 0 };
  const lastObs = { R: null, L: null };
  const lastKind = { R: null, L: null };
  const lastObsAt = { R: 0, L: 0 };
  const lastWheelOpAt = { R: -Infinity, L: -Infinity };
  const opsLog = [];
  let activeTab = 'trackpad';

  function readLiveEnabledPref() {
    try {
      const v = localStorage.getItem(LIVE_ENABLED_KEY);
      return v === null ? true : v === '1';
    } catch (e) {
      return true;
    }
  }

  function writeLiveEnabledPref(enabled) {
    try {
      localStorage.setItem(LIVE_ENABLED_KEY, enabled ? '1' : '0');
    } catch (e) { /* localStorage が使えない環境では無視 */ }
  }

  async function sendLiveCommands() {
    if (!Link.isConnected() || Link.getTransportKind() !== 'ble' || trackpadQuiet) return;
    const sides = Link.activeSides();
    if (!sides.length) return;
    for (const c of T.liveCommands(sides, LIVE_RATE, liveEnabled)) {
      await Link.runSimpleOnSide(c.side, c.cmd);
    }
  }

  /*
   * キー設定タブでは Studio の応答(数 KB の indicate)と tp-tuner の送信(ライブ・要約)が
   * 同じ BLE リンクを取り合って応答が途切れるため、タブの間は tp-tuner 側を黙らせる
   */
  let trackpadQuiet = false;
  async function setTrackpadQuiet(quiet) {
    if (trackpadQuiet === quiet) return;
    trackpadQuiet = quiet;
    if (!Link.isConnected() || Link.getTransportKind() !== 'ble') return;
    const sides = Link.activeSides();
    if (quiet) {
      for (const s of sides) {
        await Link.runSimpleOnSide(s, 'tp live off');
        await Link.runSimpleOnSide(s, 'tp summary off');
      }
      await new Promise((r) => setTimeout(r, 300));
    } else {
      for (const s of sides) await Link.runSimpleOnSide(s, 'tp summary on');
      await sendLiveCommands();
    }
  }

  function resetTrackpadQuiet() {
    trackpadQuiet = false;
  }

  function tailMsFor(sideKey) {
    return Math.max(500, T.paramValue(root.TpAppParams.paramsForSuggest(sideKey), '1f_tapdrag_gap_max_ms') + 300);
  }

  function formatOpTime(perfMs) {
    const d = new Date(Date.now() - performance.now() + perfMs);
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  }

  function pushOp(sideKey, label, text, t) {
    const last = opsLog[0];
    if (last && last.side === sideKey && last.label === label && last.text === text) {
      last.count++;
      last.t = t;
    } else {
      opsLog.unshift({ side: sideKey, label, text, t, count: 1 });
      if (opsLog.length > OPS_LOG_MAX) opsLog.length = OPS_LOG_MAX;
    }
    renderOpsLog();
  }

  function renderOpsLog() {
    const ul = $('opsLog');
    ul.innerHTML = '';
    if (!opsLog.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'まだ操作が検知されていません';
      ul.appendChild(li);
      return;
    }
    for (const e of opsLog) {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'optime';
      time.textContent = formatOpTime(e.t);
      const side = document.createElement('span');
      side.className = 'opside';
      side.textContent = Link.SIDE_LABEL[e.side];
      const label = document.createElement('span');
      label.className = 'oplabel';
      label.textContent = e.label + (e.count > 1 ? ` ×${e.count}` : '');
      const text = document.createElement('span');
      text.className = 'optext';
      text.textContent = e.text;
      li.append(time, side, label, text);
      ul.appendChild(li);
    }
  }

  function onRecognized(sideKey, obs) {
    markPadDirty();
    const t = performance.now();
    lastObs[sideKey] = obs;
    lastKind[sideKey] = T.inferKind(obs, root.TpAppParams.paramsForSuggest(sideKey));
    lastObsAt[sideKey] = t;
    pushOp(sideKey, T.kindLabel(lastKind[sideKey]),
           T.recognitionText(lastKind[sideKey], obs, root.TpAppParams.paramsForSuggest(sideKey)), t);
  }

  function processAttemptsForSide(sideKey) {
    // BLE のライブフレームは間引き・受信時刻基準なので試行の組み立てには使わず、要約だけで判定する
    if (Link.getTransportKind() === 'ble') return;
    const now = performance.now();
    const attempts = T.segmentAttempts(rec[sideKey].frames, { idleMs: ATTEMPT_IDLE_MS, now });
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (!a.closed || processedStarts[sideKey].has(a.start)) continue;
      const next = attempts[i + 1];
      const tail = next ? Math.min(tailMsFor(sideKey), next.start - a.end) : tailMsFor(sideKey);
      if (now < a.end + Math.max(tail, SUMMARY_WAIT_MS)) continue;
      processedStarts[sideKey].add(a.start);
      const obs = T.observeAttempt(a, rec[sideKey].fw, rec.host, { tailMs: tail });
      onRecognized(sideKey, obs);
    }
  }

  function nextKnownStartAfter(sideKey, afterT) {
    let best = null;
    const attempts = T.segmentAttempts(rec[sideKey].frames, { idleMs: ATTEMPT_IDLE_MS, now: performance.now() });
    for (const a of attempts) {
      if (a.start > afterT && (best === null || a.start < best)) best = a.start;
    }
    for (const p of pendingSummaries[sideKey]) {
      if (p.start > afterT && (best === null || p.start < best)) best = p.start;
    }
    return best;
  }

  function handleSummary(sideKey, tr) {
    const offset = Link.getClockOffset(sideKey);
    const start = tr.startMs + offset;
    if (processedStarts[sideKey].has(start)) return;
    pendingSummaries[sideKey].push({ tr, start, end: tr.endMs + offset });
    processPendingSummariesForSide(sideKey);
  }

  function processPendingSummariesForSide(sideKey) {
    const now = performance.now();
    const queue = pendingSummaries[sideKey];
    for (let i = queue.length - 1; i >= 0; i--) {
      const p = queue[i];
      if (processedStarts[sideKey].has(p.start)) { queue.splice(i, 1); continue; }
      const nextStart = nextKnownStartAfter(sideKey, p.end);
      // 要約はファームが指を離して 400ms 待ってから出すので、ホスト側のイベントは届き済み。追加で待たない
      const tail = Math.min(tailMsFor(sideKey), Math.max(0, now - p.end));
      const { ready, tailMs } = T.summaryHostWindow(p.end, nextStart, now, tail);
      if (!ready) continue;
      processedStarts[sideKey].add(p.start);
      queue.splice(i, 1);
      const obs = T.observationFromSummary(p.tr, rec.host, Link.getClockOffset(sideKey), { tailMs });
      onRecognized(sideKey, obs);
    }
  }

  function handleTrace(tr, sideKey) {
    if (!sideKey) return;
    if (tr.type === 'S') { handleSummary(sideKey, tr); return; }
    const isBleFrame = tr.type === 'F' && Link.getTransportKind() === 'ble';
    const t = isBleFrame ? performance.now() : tr.ms + Link.getClockOffset(sideKey);
    if (tr.type === 'F') {
      const frame = { ...tr, t };
      rec[sideKey].frames.push(frame);
      lastFrame[sideKey] = frame;
      markPadDirty(STATE_STALE_MS + 400);
      for (const pt of T.frameToPadPoints(frame, PAD_W, PAD_H)) padTrail[sideKey].push({ ...pt, t });
    } else {
      rec[sideKey].fw.push({ ...tr, t });
      if (tr.kind === 'K') {
        if (tr.value !== 0) padFlash[sideKey] = performance.now();
        markPadDirty();
        const label = T.BTN_NAMES[tr.code] || String(tr.code);
        pushOp(sideKey, `${label}ボタン ${tr.value ? '押す' : '離す'}`, '', t);
      } else if (tr.kind === 'R' && (tr.code === T.REL.WHEEL || tr.code === T.REL.HWHEEL)) {
        if (t - lastWheelOpAt[sideKey] > WHEEL_BURST_GAP_MS) pushOp(sideKey, 'スクロール開始', '', t);
        lastWheelOpAt[sideKey] = t;
      }
    }
  }

  function hasLiveFrame(sideKey) {
    const last = lastFrame[sideKey];
    return !!last && performance.now() - last.t <= STATE_STALE_MS;
  }

  function currentActionText(sideKey) {
    if (!Link.isSideActive(sideKey)) return Link.isConnected() ? 'USB では接続側のみ' : '未接続';
    if (hasLiveFrame(sideKey)) return T.describeState(lastFrame[sideKey]);
    // ライブフレームが途絶えたら指は離れている(離したフレームが落ちても要約の操作名に戻さない)
    if (lastFrame[sideKey]) return '待機';
    if (lastObs[sideKey]) return T.kindLabel(lastKind[sideKey]);
    return '待機';
  }

  function renderNow(sideKey) {
    $(`now${sideKey}`).textContent = currentActionText(sideKey);
  }

  function renderPadStatus(sideKey) {
    const el = $(`padStatus${sideKey}`);
    if (!Link.isConnected()) { el.textContent = '未接続'; return; }
    if (!Link.isSideActive(sideKey)) {
      el.textContent = Link.getTransportKind() === 'usb' ? 'USB では接続側のみ' : '応答なし';
      return;
    }
    el.textContent = '';
  }

  function drawPad(sideKey) {
    const cv = $(`pad${sideKey}`);
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(PAD_W * dpr) || cv.height !== Math.round(PAD_H * dpr)) {
      cv.width = Math.round(PAD_W * dpr);
      cv.height = Math.round(PAD_H * dpr);
      cv.style.width = PAD_W + 'px';
      cv.style.height = PAD_H + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PAD_W, PAD_H);
    const grad = ctx.createLinearGradient(0, 0, 0, PAD_H);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(1, '#0b1120');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, PAD_W, PAD_H);
    const now = performance.now();
    const trail = padTrail[sideKey];
    while (trail.length && now - trail[0].t > 300) trail.shift();
    const last = lastFrame[sideKey];
    const fresh = last && now - last.t <= STATE_STALE_MS;
    const st = T.padStateFromFrame(fresh ? last : null);
    const card = $(`padCard${sideKey}`);
    card.dataset.state = st.color;
    card.dataset.dragging = st.dragging ? '1' : '0';
    const color = PAD_COLOR[st.color] || cssVar('--pad-idle');
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    for (const pt of trail) {
      const age = now - pt.t;
      const alpha = Math.max(0, 1 - age / 300);
      ctx.globalAlpha = alpha;
      ctx.shadowBlur = 10 * alpha;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    if (padFlash[sideKey] && now - padFlash[sideKey] < 150) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, 0, PAD_W, PAD_H);
    }
    ctx.fillStyle = 'rgba(226,232,240,.85)';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText(st.state, 8, 18);
  }

  function recordPointer(type, e) {
    const t = performance.now();
    if (type === 'pointermove') {
      if (e.movementX === 0 && e.movementY === 0) return;
      rec.host.move.push({ t, dx: e.movementX, dy: e.movementY });
    } else {
      rec.host.btn.push({ t, buttons: e.buttons });
    }
  }

  function recordWheel(e) {
    rec.host.wheel.push({ t: performance.now(), deltaX: e.deltaX, deltaY: e.deltaY });
  }

  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel']) {
    document.addEventListener(type, (e) => recordPointer(type, e));
  }
  document.addEventListener('wheel', (e) => recordWheel(e), { passive: true });

  const captureOverlay = $('captureOverlay');
  const captureMsg = $('captureMsg');
  const CAPTURE_MSG = 'ポインタロック中: クリック・スクロールは Mac に効きません。Esc で解除';
  const CAPTURE_MSG_FALLBACK = 'この環境ではポインタロックできません。クリック・スクロールの既定動作だけ止めています(カーソルは動きます)。Esc で解除';
  let captureMode = false;

  function blockOverlayDefault(e) { e.preventDefault(); }

  function startCapture() {
    if (captureMode) return;
    captureMode = true;
    captureMsg.textContent = CAPTURE_MSG;
    captureOverlay.hidden = false;
    captureOverlay.addEventListener('mousedown', blockOverlayDefault);
    captureOverlay.addEventListener('contextmenu', blockOverlayDefault);
    captureOverlay.addEventListener('wheel', blockOverlayDefault, { passive: false });
    captureOverlay.addEventListener('auxclick', blockOverlayDefault);
    if (typeof captureOverlay.requestPointerLock !== 'function') {
      captureMsg.textContent = CAPTURE_MSG_FALLBACK;
      return;
    }
    try {
      const r = captureOverlay.requestPointerLock();
      if (r && typeof r.catch === 'function') {
        r.catch(() => { if (captureMode) captureMsg.textContent = CAPTURE_MSG_FALLBACK; });
      }
    } catch (e) {
      captureMsg.textContent = CAPTURE_MSG_FALLBACK;
    }
  }

  function stopCapture() {
    if (!captureMode) return;
    captureMode = false;
    captureOverlay.hidden = true;
    captureOverlay.removeEventListener('mousedown', blockOverlayDefault);
    captureOverlay.removeEventListener('contextmenu', blockOverlayDefault);
    captureOverlay.removeEventListener('wheel', blockOverlayDefault);
    captureOverlay.removeEventListener('auxclick', blockOverlayDefault);
    if (document.pointerLockElement === captureOverlay) document.exitPointerLock();
  }

  document.addEventListener('pointerlockchange', () => {
    if (captureMode && document.pointerLockElement !== captureOverlay) stopCapture();
  });
  document.addEventListener('pointerlockerror', () => {
    if (captureMode) captureMsg.textContent = CAPTURE_MSG_FALLBACK;
  });
  document.addEventListener('keydown', (e) => {
    if (captureMode && e.key === 'Escape') stopCapture();
  });
  $('btnCapture').onclick = () => { startCapture(); };

  function prune() {
    const cut = performance.now() - KEEP_MS;
    for (const s of ['R', 'L']) {
      for (const key of ['frames', 'fw']) {
        const arr = rec[s][key];
        let i = 0;
        while (i < arr.length && arr[i].t < cut) i++;
        if (i) arr.splice(0, i);
      }
      for (const v of [...processedStarts[s]]) if (v < cut) processedStarts[s].delete(v);
      for (let i = pendingSummaries[s].length - 1; i >= 0; i--) if (pendingSummaries[s][i].end < cut) pendingSummaries[s].splice(i, 1);
      let j = 0;
      while (j < padTrail[s].length && padTrail[s][j].t < cut) j++;
      if (j) padTrail[s].splice(0, j);
    }
    for (const key of ['move', 'wheel']) {
      const arr = rec.host[key];
      let i = 0;
      while (i < arr.length && arr[i].t < cut) i++;
      if (i) arr.splice(0, i);
    }
    let i = 0;
    while (i < rec.host.btn.length - 1 && rec.host.btn[i + 1].t < cut) i++;
    if (i) rec.host.btn.splice(0, i);
  }

  setInterval(() => {
    prune();
    for (const s of ['R', 'L']) {
      processPendingSummariesForSide(s);
      processAttemptsForSide(s);
    }
  }, PROCESS_INTERVAL_MS);

  // 常時 60fps で描くと WKWebView の CPU を食い Mac 全体が重くなるので、
  // 何かが変わった直後(軌跡が消えるまでの間)だけ描き直す
  let padDirtyUntil = performance.now() + 1000;
  function markPadDirty(ms) {
    padDirtyUntil = Math.max(padDirtyUntil, performance.now() + (ms || 600));
  }
  (function loop() {
    try {
      if (activeTab === 'trackpad' && performance.now() < padDirtyUntil) {
        for (const s of ['R', 'L']) { drawPad(s); renderNow(s); renderPadStatus(s); }
      }
    } catch (e) { /* keep the loop alive */ }
    requestAnimationFrame(loop);
  })();

  $('chkLive').onchange = () => {
    liveEnabled = $('chkLive').checked;
    writeLiveEnabledPref(liveEnabled);
    sendLiveCommands();
  };

  renderOpsLog();
  liveEnabled = readLiveEnabledPref();
  $('chkLive').checked = liveEnabled;

  function setActiveTab(tab) {
    activeTab = tab;
  }

  const api = {
    handleTrace, sendLiveCommands, setTrackpadQuiet, resetTrackpadQuiet,
    markPadDirty, renderPadStatus, setActiveTab,
  };
  root.TpAppPad = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
