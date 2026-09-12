(function (root) {
  'use strict';
  const T = globalThis.TpTuner;
  if (!T) return;
  const Link = root.TpAppLink;
  if (!Link) return;
  const Presets = root.TpPresets;
  if (!Presets) return;

  const $ = (id) => document.getElementById(id);

  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  const GROUPS = [
    { title: '1本指タップ / タップドラッグ', names: ['1f_tap_enable', '1f_tap_max_ms', '1f_tap_move', '1f_presshold_enable', '1f_tapdrag_gap_max_ms'] },
    { title: '2本指タップ / スクロール / ピンチ', names: ['2f_tap_enable', '2f_tap_max_ms', '2f_tap_move', '2f_presshold_enable', '2f_tapdrag_gap_max_ms', 'scroll_x_enable', 'scroll_y_enable', '2f_scroll_start_move', '2f_pinch_enable', '2f_pinch_start_distance', '2f_pinch_ratio_x10', '2f_pinch_wheel_gain_x10'] },
    { title: '3本指', names: ['3f_tap_enable', '3f_tap_max_ms', '3f_tap_move', '3f_presshold_enable', '3f_tapdrag_gap_max_ms', '3f_swipe_threshold'] },
    { title: '慣性', names: ['cursor_inertia_enable', 'cursor_inertia_decay', 'cursor_inertia_recent_window_ms', 'cursor_inertia_stale_gap_ms', 'cursor_inertia_min_samples', 'cursor_inertia_min_avg_speed', 'scroll_inertia_enable', 'scroll_inertia_decay', 'scroll_inertia_recent_window_ms', 'scroll_inertia_stale_gap_ms', 'scroll_inertia_min_samples', 'scroll_inertia_min_avg_speed'] },
    { title: '送信レート(BLE 対策)', names: ['cursor_report_interval_ms', 'scroll_report_interval_ms'] },
    { title: 'IC 感度 / タッチ判定', ic: true, names: ['touch_set_threshold', 'touch_clear_threshold', 'finger_confidence_threshold', 'alp_set_debounce', 'alp_clear_debounce'] },
    { title: 'IC 座標フィルタ(手ぶれ・なめらかさ)', ic: true, names: ['stationary_touch_mov_threshold', 'jitter_filter_delta', 'dynamic_filter_bottom_speed', 'dynamic_filter_top_speed', 'dynamic_filter_bottom_beta'] },
    { title: 'IC サンプリング周期 / 省電力', ic: true, names: ['active_mode_sampling_period_ms', 'idle_touch_mode_sampling_period_ms', 'idle_mode_sampling_period_ms', 'lp1_mode_sampling_period_ms', 'lp2_mode_sampling_period_ms', 'active_mode_timeout_ms', 'idle_touch_mode_timeout_s', 'idle_mode_timeout_s', 'lp1_mode_timeout_s'] },
    { title: 'ATI(基準の自動校正)', ic: true, reati: true, names: ['ati_targetcount'] },
  ];
  const PARAM_HELP = {
    '1f_tap_enable': { what: '1 本指タップを左クリックにする', on: 'タップでクリックする', off: 'タップでクリックしない' },
    '1f_tap_max_ms': { what: 'タップと見なす押下時間の上限(ms)', up: '長めのタップも拾うが短い押し込みもクリックになる', down: '素早いタップだけ拾う' },
    '1f_tap_move': { what: 'タップ中に許す指の移動量', up: '指がぶれてもタップになる', down: '少しの動きでカーソル移動扱いになる' },
    '1f_presshold_enable': { what: 'タップ後にボタンを押したまま 2 回目の接触を待ち、ドラッグにつなげる(タップドラッグ)', on: 'タップ→触れ直しでドラッグできる', off: 'タップドラッグしない' },
    '1f_tapdrag_gap_max_ms': { what: 'タップ後に 2 回目の接触を待つ時間(ms)', up: 'ゆっくりのダブルタップでもドラッグに入るがシングルクリックの確定が遅れる', down: 'クリックの確定は速いが素早く触れ直さないとドラッグに入らない' },
    '2f_tap_enable': { what: '2 本指タップを右クリックにする', on: '2 本指タップでクリックする', off: '2 本指タップでクリックしない' },
    '2f_tap_max_ms': { what: '2 本指タップと見なす押下時間の上限(ms)', up: '長めのタップも拾うが短い押し込みもクリックになる', down: '素早いタップだけ拾う' },
    '2f_tap_move': { what: '2 本指タップ中に許す移動量', up: '指がぶれてもタップになる', down: '少しの動きでスクロール扱いになる' },
    '2f_presshold_enable': { what: '2 本指タップ後にボタンを押したまま 2 回目の接触を待つ', on: '2 本指のタップドラッグができる', off: 'しない' },
    '2f_tapdrag_gap_max_ms': { what: '2 本指タップ後に 2 回目の接触を待つ時間(ms)', up: 'ゆっくりでもドラッグに入るが右クリックの確定が遅れる', down: '確定は速いがドラッグに入りにくい' },
    '3f_tap_enable': { what: '3 本指タップを中クリックにする', on: '3 本指タップでクリックする', off: '3 本指タップでクリックしない' },
    '3f_tap_max_ms': { what: '3 本指タップと見なす押下時間の上限(ms)', up: '長めのタップも拾うが短い押し込みもクリックになる', down: '素早いタップだけ拾う' },
    '3f_tap_move': { what: '3 本指タップ中に許す移動量', up: '指がぶれてもタップになる', down: '少しの動きでスワイプ扱いになる' },
    '3f_presshold_enable': { what: '3 本指タップ後にボタンを押したまま 2 回目の接触を待つ', on: '3 本指のタップドラッグができる', off: 'しない' },
    '3f_tapdrag_gap_max_ms': { what: '3 本指タップ後に 2 回目の接触を待つ時間(ms)', up: 'ゆっくりでもドラッグに入るが中クリックの確定が遅れる', down: '確定は速いがドラッグに入りにくい' },
    '3f_swipe_threshold': { what: '3 本指スワイプと見なす移動量', up: '大きく動かさないとスワイプにならない', down: '小さな動きでスワイプになる' },
    scroll_x_enable: { what: '横の 2 本指スクロール', on: '横スクロールする', off: '横スクロールしない' },
    scroll_y_enable: { what: '縦の 2 本指スクロール', on: '縦スクロールする', off: '縦スクロールしない' },
    '2f_scroll_start_move': { what: '2 本指の移動をスクロールと判定し始める移動量', up: 'スクロールの始まりが重くなる', down: '小さな動きで始まる(2 本指タップがスクロール扱いになりやすい)' },
    '2f_pinch_enable': { what: '2 本指ピンチ', on: 'ピンチする', off: 'ピンチしない' },
    '2f_pinch_start_distance': { what: '指の間隔の変化がこれを超えるとピンチ', up: '大きく開閉しないとピンチにならない', down: '敏感になる(スクロールがピンチに化けやすい)' },
    '2f_pinch_ratio_x10': { what: 'スクロールかピンチかを決める比率(×0.1)。指の間隔の変化が重心の移動のこの倍率以上ならピンチ。動き出しの最小量は 2f_scroll_start_move / 2f_pinch_start_distance', up: 'ピンチになりにくくなる(スクロール寄り)', down: 'ピンチになりやすくなる' },
    '2f_pinch_wheel_gain_x10': { what: 'ピンチで送るホイール量の倍率(10 = 1.0 倍)', up: '同じ開閉で大きく拡大縮小する', down: '小さく拡大縮小する' },
    cursor_inertia_enable: { what: '指を離した後もカーソルが滑る慣性', on: '離した後に滑る', off: '離すと止まる' },
    cursor_inertia_decay: { what: '慣性の減衰(1000 に近いほど長く滑る)', up: '長く滑る', down: '早く止まる' },
    cursor_inertia_recent_window_ms: { what: '離す直前の速度を見る時間幅(ms)', up: '長い区間の平均速度で判断する', down: '離す直前の速度だけで判断する' },
    cursor_inertia_stale_gap_ms: { what: '最後の移動から離すまでがこれを超えると慣性を出さない(ms)', up: '止めてから離しても滑る', down: '止めてから離すと滑らない' },
    cursor_inertia_min_samples: { what: '慣性を出すのに必要な直近の移動サンプル数', up: '短い動きでは滑らない', down: '短い動きでも滑る' },
    cursor_inertia_min_avg_speed: { what: 'この速度以上で離したときだけ慣性を出す', up: '滑りにくくなる', down: 'ゆっくり離しても滑る' },
    scroll_inertia_enable: { what: '指を離した後もスクロールが続く慣性', on: '離した後に滑る', off: '離すと止まる' },
    scroll_inertia_decay: { what: 'スクロール慣性の減衰(1000 に近いほど長く滑る)', up: '長く滑る', down: '早く止まる' },
    scroll_inertia_recent_window_ms: { what: '離す直前の速度を見る時間幅(ms)', up: '長い区間の平均速度で判断する', down: '離す直前の速度だけで判断する' },
    scroll_inertia_stale_gap_ms: { what: '最後の移動から離すまでがこれを超えると慣性を出さない(ms)', up: '止めてから離しても滑る', down: '止めてから離すと滑らない' },
    scroll_inertia_min_samples: { what: '慣性を出すのに必要な直近の移動サンプル数', up: '短い動きでは滑らない', down: '短い動きでも滑る' },
    scroll_inertia_min_avg_speed: { what: 'この速度以上で離したときだけ慣性を出す', up: '滑りにくくなる', down: 'ゆっくり離しても滑る' },
    cursor_report_interval_ms: { what: 'カーソル移動の報告をまとめて送る間隔(ms)。0 でフレームごと(約 100Hz)。BLE で動かし続けると遅くなる場合は 16〜25 にすると送信量が半分〜1/3 になる', up: '送信は減るが最大その ms だけ遅れる', down: '遅れは減るが送信量が増える' },
    scroll_report_interval_ms: { what: '2 本指スクロールの報告をまとめて送る間隔(ms)。考え方はカーソルと同じ', up: '送信は減るが最大その ms だけ遅れる', down: '遅れは減るが送信量が増える' },
    touch_set_threshold: { what: '触れたと判定するタッチ強度のしきい値', up: '軽いタッチを拾いにくくなる', down: '軽いタッチを拾うが誤反応も増える' },
    touch_clear_threshold: { what: '離れたと判定するタッチ強度のしきい値(touch_set_threshold より小さくする)', up: 'set との差が縮まり離し判定が遅れやすい', down: 'set との差が広がり離し判定が早まる' },
    alp_set_debounce: { what: '低消費電力モードから復帰するために必要な連続検出回数', up: '誤起動が減るが復帰が遅くなる', down: '復帰は速いが誤起動が増える' },
    alp_clear_debounce: { what: '低消費電力モードへ戻るために必要な連続非検出回数', up: '戻りにくくなる', down: 'すぐ低消費電力モードへ戻る' },
    stationary_touch_mov_threshold: { what: 'これ以下の移動量は指が止まっていると見なすしきい値。止まったままが続くと省電力の Idle-Touch モードへ移る', up: '大きく動いても止まっている扱いになりやすい', down: '小さな動きでも止まっていないと判定されやすい' },
    jitter_filter_delta: { what: '指を止めているときの細かい揺れ(ジッタ)を消す幅', up: '大きな揺れまで消せるが細かい動きも消えやすい', down: '細かい動きは拾えるが震えも出やすい' },
    finger_confidence_threshold: { what: '指として認識するために必要な確からしさの下限', up: '誤検出は減るが指を拾いにくくなる', down: '拾いやすくなるが誤検出が増える' },
    dynamic_filter_bottom_speed: { what: '指の動きが遅いほど座標を強く滑らかにし、速いほど弱くする仕組みの下限速度。これより遅い動きは一律で最も強く滑らかになる', up: '最も強く滑らかにする範囲が速い動きまで広がる(ゆっくりした操作がより滑らかになるが遅れやすくなる)', down: '最も強く滑らかにする範囲が遅い動きだけに狭まる(ゆっくりした操作でも追従しやすくなる)' },
    dynamic_filter_top_speed: { what: '同じ仕組みの上限速度。これより速い動きは滑らかにせず生の座標をそのまま使う', up: '滑らかにする速度域が広がり、速い動きも少し滑らかになる', down: '滑らかにする速度域が狭まり、速い動きはすぐ生の座標になる' },
    dynamic_filter_bottom_beta: { what: '下限速度以下(いちばん遅い)のときの滑らかさの強さ', up: '遅い動きがより滑らかになるが追従が遅れる', down: '遅い動きの追従は良くなるが震えが出やすい' },
    ati_targetcount: { what: '各電極の基準カウントの目標値。変更したら Re-ATI が必要', up: '基準が高くなる', down: '基準が低くなる' },
    active_mode_sampling_period_ms: { what: '触れて操作している Active モードでのサンプリング周期(ms)', up: '反応は遅くなるが電池は持つ', down: '反応は速くなるが電池を使う' },
    idle_touch_mode_sampling_period_ms: { what: '指を触れたまま動かしていない Idle-Touch モードでのサンプリング周期(ms)', up: '再び動かしたときの反応が遅れるが電池は持つ', down: '反応は速いが電池を使う' },
    idle_mode_sampling_period_ms: { what: '指が触れていない Idle モードでのサンプリング周期(ms)', up: '触れたときの初動が遅れるが電池は持つ', down: '初動は速いが電池を使う' },
    lp1_mode_sampling_period_ms: { what: 'より省電力な LP1 モードでのサンプリング周期(ms)', up: '初動が遅れるが電池は持つ', down: '初動は速いが電池を使う' },
    lp2_mode_sampling_period_ms: { what: '最も省電力な LP2 モードでのサンプリング周期(ms)', up: '初動が遅れるが電池は持つ', down: '初動は速いが電池を使う' },
    active_mode_timeout_ms: { what: '指を離してから、Active モードを抜けて次の省電力モードへ落ちるまでの時間(ms)', up: 'Active モードを維持する時間が延びる(電池を使う)', down: '早く省電力モードへ落ちる' },
    idle_touch_mode_timeout_s: { what: '指を触れたまま動かさない状態が続いたとき、次の省電力モードへ落ちるまでの時間(秒)', up: '置いたままでも反応が落ちにくいが電池を使う', down: '早く省電力になる' },
    idle_mode_timeout_s: { what: '指が触れていない状態が続いたとき、さらに省電力な LP1 モードへ落ちるまでの時間(秒)', up: '手を離した後も反応が速いままの時間が延びるが電池を使う', down: '早く省電力になり、次に触れたときの反応が遅れやすい' },
    lp1_mode_timeout_s: { what: '省電力の LP1 モードが続いたとき、さらに省電力な LP2 モードへ落ちるまでの時間(秒)', up: '長い放置後も復帰が速いままの時間が延びるが電池を使う', down: '早く最も省電力なモードになる' },
  };

  function helpFor(name) {
    return PARAM_HELP[name] || null;
  }

  function effectText(help) {
    if (help.on) return `ON: ${help.on} / OFF: ${help.off}`;
    return `上げると${help.up} / 下げると${help.down}`;
  }

  function helpSearchText(help) {
    return help ? `${help.what} ${effectText(help)}` : '';
  }

  function appendEffectAndName(container, p, help) {
    container.appendChild(document.createTextNode(effectText(help) + ' ・ '));
    const nameSpan = document.createElement('span');
    nameSpan.className = 'paramname';
    nameSpan.textContent = p.name;
    container.appendChild(nameSpan);
  }

  const params = { R: [], L: [] };
  let pending = { common: {}, R: {}, L: {} };
  let detailMode = false;
  let query = '';
  let presetTrackpad = null;
  let mergedByName = {};
  const DEPENDENT_ON = (() => {
    const map = {};
    for (const [name, dep] of Object.entries(T.PARAM_DEPENDS)) {
      const names = Array.isArray(dep) ? dep : (dep.any || dep.all);
      for (const req of names) (map[req] || (map[req] = [])).push(name);
    }
    return map;
  })();

  function emptyPending() {
    return { common: {}, R: {}, L: {} };
  }

  function pendingCount() {
    return new Set([...Object.keys(pending.common), ...Object.keys(pending.R), ...Object.keys(pending.L)]).size;
  }

  function updateUndoButton() {
    const btn = $('btnParamsUndo');
    if (btn) btn.disabled = pendingCount() === 0;
  }

  function notifyHeaderChanged() {
    root.TpAppMain.renderHeader();
    updateUndoButton();
  }

  function paramsForSuggest(sideKey) {
    return params[sideKey] && params[sideKey].length ? params[sideKey] : T.DEFAULT_PARAMS;
  }

  async function loadParamsForSide(sideKey) {
    const lines = await Link.sendTo(sideKey, 'tp list');
    params[sideKey] = lines.map(T.parseListLine).filter(Boolean);
  }

  async function refreshInfoForSide(sideKey) {
    try {
      const lines = await Link.sendTo(sideKey, 'tp info');
      const info = lines.map(T.parseInfoLine).find(Boolean);
      if (info) Link.setConnInfo(sideKey, info);
    } catch (e) {
      root.TpAppMain.log(`[${sideKey}] ` + errText(e));
    }
  }

  async function loadAllParams() {
    let count = 0;
    for (const s of Link.activeSides()) {
      await loadParamsForSide(s);
      count += params[s].length;
    }
    renderParams();
    if (root.TpAppPresets && root.TpAppPresets.onParamsLoaded) root.TpAppPresets.onParamsLoaded();
    return count;
  }

  function screenTrackpad() {
    return Presets.trackpadScreenValues({ R: params.R, L: params.L }, pending);
  }

  function setPresetTrackpad(presetTrackpadOrNull) {
    presetTrackpad = presetTrackpadOrNull || null;
    renderParams();
  }

  function presetDiff() {
    return Presets.trackpadDiff(presetTrackpad, screenTrackpad());
  }

  function presetDiffSummary() {
    const diff = presetDiff();
    return { count: diff.length, items: new Set(diff.map((d) => d.name)).size };
  }

  function applyPresetTrackpad(trackpad) {
    pending = Presets.trackpadPendingFromPreset(trackpad, { R: params.R, L: params.L });
    renderParams();
    notifyHeaderChanged();
  }

  function defaultTrackpad() {
    const out = {};
    for (const side of ['R', 'L']) {
      if (!params[side] || !params[side].length) continue;
      const vals = {};
      for (const p of params[side]) vals[p.name] = p.def;
      out[side] = vals;
    }
    return out;
  }

  function applyDefaults() {
    const target = defaultTrackpad();
    presetTrackpad = target;
    pending = Presets.trackpadPendingFromPreset(target, { R: params.R, L: params.L });
    renderParams();
    notifyHeaderChanged();
  }

  function presetDiffForName(name, screen) {
    if (!presetTrackpad) return null;
    const pr = presetTrackpad.R;
    const pl = presetTrackpad.L;
    const sr = screen.R;
    const sl = screen.L;
    const rHas = !!(pr && Object.prototype.hasOwnProperty.call(pr, name));
    const lHas = !!(pl && Object.prototype.hasOwnProperty.call(pl, name));
    const rReadable = !!(sr && Object.prototype.hasOwnProperty.call(sr, name));
    const lReadable = !!(sl && Object.prototype.hasOwnProperty.call(sl, name));
    const rDiff = rHas && rReadable && pr[name] !== sr[name];
    const lDiff = lHas && lReadable && pl[name] !== sl[name];
    if (!rDiff && !lDiff) return null;
    return { rDiff, lDiff, presetR: rHas ? pr[name] : undefined, presetL: lHas ? pl[name] : undefined };
  }

  function presetMarkTextCommon(kind, info) {
    if (info.rDiff && info.lDiff && info.presetR === info.presetL) {
      return `プリセット: ${T.formatParamValue(kind, info.presetR)}`;
    }
    const rTxt = info.presetR !== undefined ? T.formatParamValue(kind, info.presetR) : '-';
    const lTxt = info.presetL !== undefined ? T.formatParamValue(kind, info.presetL) : '-';
    return `プリセット: 右 ${rTxt} / 左 ${lTxt}`;
  }

  function commonGetValue(name) {
    if (Object.prototype.hasOwnProperty.call(pending.common, name)) return pending.common[name];
    const p = mergedByName[name];
    return p ? p.value : undefined;
  }

  function sideGetValue(sideKey, name) {
    const bucket = pending[sideKey];
    if (Object.prototype.hasOwnProperty.call(bucket, name)) return bucket[name];
    if (Object.prototype.hasOwnProperty.call(pending.common, name)) return pending.common[name];
    const p = mergedByName[name];
    if (!p) return undefined;
    return sideKey === 'R' ? p.valueR : p.valueL;
  }

  function commonScreenValue(p) {
    if (Object.prototype.hasOwnProperty.call(pending.common, p.name)) return pending.common[p.name];
    const vals = [];
    if (p.valueR !== null) vals.push(sideGetValue('R', p.name));
    if (p.valueL !== null) vals.push(sideGetValue('L', p.name));
    if (vals.length && vals.every((v) => v === vals[0])) return vals[0];
    return p.value;
  }

  function rowHasPending(name) {
    return pending.common[name] !== undefined || pending.R[name] !== undefined || pending.L[name] !== undefined;
  }

  function isRowActiveCommon(name) {
    return T.isParamActive(name, commonGetValue);
  }

  function isRowActiveSide(name, sideKey) {
    return T.isParamActive(name, (n) => sideGetValue(sideKey, n));
  }

  function setInputsDisabled(cell, disabled) {
    for (const el of cell.querySelectorAll('input')) el.disabled = disabled;
    const num = cell.querySelector('input[type=number]');
    for (const btn of cell.querySelectorAll('button.stepbtn')) {
      if (disabled) { btn.disabled = true; continue; }
      if (!num) { btn.disabled = false; continue; }
      const v = Number(num.value);
      btn.disabled = btn.dataset.dir === 'down' ? v <= Number(num.min) : v >= Number(num.max);
    }
  }

  function refreshDependentRows(changedName) {
    const deps = DEPENDENT_ON[changedName];
    if (!deps) return;
    for (const depName of deps) {
      const row = document.querySelector(`.param[data-name="${CSS.escape(depName)}"]`);
      if (!row) continue;
      if (detailMode) {
        for (const sideKey of ['R', 'L']) {
          const cell = row.querySelector(`.cell[data-side="${sideKey}"]`);
          if (!cell) continue;
          const active = isRowActiveSide(depName, sideKey);
          cell.classList.toggle('inactive', !active);
          setInputsDisabled(cell, !active);
        }
      } else {
        const cell = row.querySelector('.cell');
        const active = isRowActiveCommon(depName);
        row.classList.toggle('inactive', !active);
        if (cell) setInputsDisabled(cell, !active);
      }
    }
  }

  function applyRowVisuals(row, p, screen, help) {
    const presetInfo = presetDiffForName(p.name, screen);
    row.classList.toggle('presetdiff', !!presetInfo);
    row.classList.toggle('changed', rowHasPending(p.name));
    if (detailMode) {
      for (const sideKey of ['R', 'L']) {
        const cell = row.querySelector(`.cell[data-side="${sideKey}"]`);
        if (!cell) continue;
        const old = cell.querySelector('.presetmark');
        if (old) old.remove();
        const diff = sideKey === 'R' ? (presetInfo && presetInfo.rDiff) : (presetInfo && presetInfo.lDiff);
        if (diff) {
          const val = sideKey === 'R' ? presetInfo.presetR : presetInfo.presetL;
          const pm = document.createElement('span');
          pm.className = 'presetmark';
          pm.textContent = `プリセット: ${T.formatParamValue(p.kind, val)}`;
          cell.appendChild(pm);
        }
      }
      let descDiv = row.querySelector('.desc');
      if (help) {
        if (!descDiv) { descDiv = document.createElement('div'); descDiv.className = 'desc'; row.appendChild(descDiv); }
        descDiv.innerHTML = '';
        appendEffectAndName(descDiv, p, help);
      } else if (descDiv) {
        descDiv.remove();
      }
      return;
    }
    const bothReadable = p.valueR !== null && p.valueL !== null;
    const rVal = bothReadable ? sideGetValue('R', p.name) : null;
    const lVal = bothReadable ? sideGetValue('L', p.name) : null;
    const differs = bothReadable && rVal !== lVal;
    const presetText = presetInfo ? presetMarkTextCommon(p.kind, presetInfo) : '';
    const differsText = differs ? `左右で違う(右 ${T.formatParamValue(p.kind, rVal)} / 左 ${T.formatParamValue(p.kind, lVal)})` : '';
    let descDiv = row.querySelector('.desc');
    if (presetText || differsText || help) {
      if (!descDiv) { descDiv = document.createElement('div'); descDiv.className = 'desc'; row.appendChild(descDiv); }
      descDiv.innerHTML = '';
      if (presetText) {
        const pm = document.createElement('span');
        pm.className = 'presetmark';
        pm.textContent = presetText;
        descDiv.appendChild(pm);
      }
      if (differsText) {
        if (presetText) descDiv.appendChild(document.createTextNode(' ・ '));
        descDiv.appendChild(document.createTextNode(differsText));
      }
      if (help) {
        if (presetText || differsText) descDiv.appendChild(document.createTextNode(' ・ '));
        appendEffectAndName(descDiv, p, help);
      }
    } else if (descDiv) {
      descDiv.remove();
    }
  }

  function refreshRowVisuals(name) {
    const row = document.querySelector(`.param[data-name="${CSS.escape(name)}"]`);
    if (!row) return;
    const p = mergedByName[name];
    if (!p) return;
    applyRowVisuals(row, p, screenTrackpad(), helpFor(name));
  }

  function updateRowMark(nameKey, bucket, originalValue) {
    const row = document.querySelector(`.param[data-name="${CSS.escape(nameKey)}"]`);
    if (!row) return;
    const p = mergedByName[nameKey];
    const cell = bucket === 'common' ? row.querySelector('.cell') : row.querySelector(`.cell[data-side="${bucket}"]`);
    if (!cell) return;
    const mark = cell.querySelector('.pendingmark');
    if (mark) mark.remove();
    const value = bucket === 'common' ? pending.common[nameKey] : pending[bucket][nameKey];
    if (value !== undefined) {
      const m = document.createElement('span');
      m.className = 'pendingmark';
      m.textContent = `← ${T.formatParamValue(p ? p.kind : undefined, originalValue)}`;
      cell.appendChild(m);
    }
  }

  function setPendingCommon(p, value) {
    delete pending.R[p.name];
    delete pending.L[p.name];
    if (value === p.value) delete pending.common[p.name]; else pending.common[p.name] = value;
    updateRowMark(p.name, 'common', p.value);
    refreshRowVisuals(p.name);
    refreshDependentRows(p.name);
    notifyHeaderChanged();
  }

  function setPendingSide(p, sideKey, value) {
    const current = sideKey === 'R' ? p.valueR : p.valueL;
    if (value === current) delete pending[sideKey][p.name]; else pending[sideKey][p.name] = value;
    updateRowMark(p.name, sideKey, current);
    refreshRowVisuals(p.name);
    refreshDependentRows(p.name);
    notifyHeaderChanged();
  }

  function stepButton(text, title, dir) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stepbtn';
    b.textContent = text;
    b.title = title;
    b.dataset.dir = dir;
    return b;
  }

  const STEP_SMALL = 1;
  const STEP_LARGE = 10;

  function buildEditor(kind, name, min, max, value, onChange) {
    const wrap = document.createElement('span');
    wrap.className = 'cell';
    if (kind === 'driver_bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.onchange = () => onChange(cb.checked ? 1 : 0);
      wrap.appendChild(cb);
      return wrap;
    }
    const range = T.practicalRange(name, min, max, value);
    const rMin = range.min;
    const rMax = range.max;
    const num = document.createElement('input');
    num.type = 'number'; num.min = rMin; num.max = rMax; num.value = value;
    const slider = document.createElement('input');
    slider.type = 'range'; slider.className = 'paramslider';
    slider.min = rMin; slider.max = rMax; slider.step = 1; slider.value = value;
    const btnMinusMinus = stepButton('−−', `${STEP_LARGE} 減らす`, 'down');
    const btnMinus = stepButton('−', `${STEP_SMALL} 減らす`, 'down');
    const btnPlus = stepButton('+', `${STEP_SMALL} 増やす`, 'up');
    const btnPlusPlus = stepButton('++', `${STEP_LARGE} 増やす`, 'up');
    const clamp = (v) => Math.min(rMax, Math.max(rMin, v));
    const updateButtons = (v) => {
      btnMinusMinus.disabled = v <= rMin;
      btnMinus.disabled = v <= rMin;
      btnPlus.disabled = v >= rMax;
      btnPlusPlus.disabled = v >= rMax;
    };
    const commit = (v) => {
      num.value = v;
      slider.value = v;
      updateButtons(v);
      onChange(v);
    };
    btnMinusMinus.onclick = () => commit(clamp(Math.round(Number(num.value) || 0) - STEP_LARGE));
    btnMinus.onclick = () => commit(clamp(Math.round(Number(num.value) || 0) - STEP_SMALL));
    btnPlus.onclick = () => commit(clamp(Math.round(Number(num.value) || 0) + STEP_SMALL));
    btnPlusPlus.onclick = () => commit(clamp(Math.round(Number(num.value) || 0) + STEP_LARGE));
    num.onchange = () => commit(clamp(Math.round(Number(num.value) || 0)));
    slider.oninput = () => commit(clamp(Math.round(Number(slider.value) || 0)));
    updateButtons(value);
    wrap.append(btnMinusMinus, btnMinus, slider, num, btnPlus, btnPlusPlus);
    return wrap;
  }

  function renderCommonCell(p, active) {
    const displayValue = commonScreenValue(p);
    const wrap = buildEditor(p.kind, p.name, p.min, p.max, displayValue, (v) => setPendingCommon(p, v));
    if (!active) setInputsDisabled(wrap, true);
    if (rowHasPending(p.name)) {
      const m = document.createElement('span');
      m.className = 'pendingmark';
      m.textContent = `← ${T.formatParamValue(p.kind, p.value)}`;
      wrap.appendChild(m);
    }
    return wrap;
  }

  function renderSideCell(p, sideKey, active) {
    const has = sideKey === 'R' ? p.valueR !== null : p.valueL !== null;
    const wrap = document.createElement('span');
    wrap.className = 'cell';
    wrap.dataset.side = sideKey;
    if (!has) { wrap.textContent = '-'; return wrap; }
    const current = sideKey === 'R' ? p.valueR : p.valueL;
    const bucket = pending[sideKey];
    const displayValue = Object.prototype.hasOwnProperty.call(bucket, p.name) ? bucket[p.name] : current;
    const editor = buildEditor(p.kind, p.name, p.min, p.max, displayValue, (v) => setPendingSide(p, sideKey, v));
    wrap.append(...editor.childNodes);
    if (!active) { setInputsDisabled(wrap, true); wrap.classList.add('inactive'); }
    if (Object.prototype.hasOwnProperty.call(bucket, p.name)) {
      const m = document.createElement('span');
      m.className = 'pendingmark';
      m.textContent = `← ${T.formatParamValue(p.kind, current)}`;
      wrap.appendChild(m);
    }
    return wrap;
  }

  function renderParamRow(p, screen, help) {
    const row = document.createElement('div');
    row.className = 'param' + (p.kind === 'driver_bool' ? ' bool' : '') + (detailMode ? ' detail' : '');
    row.dataset.name = p.name;
    const label = document.createElement('label');
    label.textContent = help ? help.what : p.name;
    label.title = `[${p.kind}] 範囲 ${p.min}..${p.max} 既定 ${p.def}`;
    row.appendChild(label);
    if (detailMode) {
      row.appendChild(renderSideCell(p, 'R', isRowActiveSide(p.name, 'R')));
      row.appendChild(renderSideCell(p, 'L', isRowActiveSide(p.name, 'L')));
    } else {
      const active = isRowActiveCommon(p.name);
      row.classList.toggle('inactive', !active);
      row.appendChild(renderCommonCell(p, active));
    }
    applyRowVisuals(row, p, screen, help);
    return row;
  }

  function renderDetailHeader() {
    const header = document.createElement('div');
    header.className = 'param detail paramheader';
    header.appendChild(document.createElement('span'));
    const r = document.createElement('span');
    r.className = 'headcell';
    r.textContent = '右手';
    header.appendChild(r);
    const l = document.createElement('span');
    l.className = 'headcell';
    l.textContent = '左手';
    header.appendChild(l);
    return header;
  }

  function renderParams() {
    updateUndoButton();
    const root2 = $('params');
    root2.innerHTML = '';
    const merged = T.mergeParams(params.R, params.L);
    if (merged.length === 0) {
      mergedByName = {};
      root2.innerHTML = '<span class="legend">接続すると tp list の内容がここに表示されます</span>';
      return;
    }
    if (detailMode) root2.appendChild(renderDetailHeader());
    const seen = new Set();
    const known = new Set(GROUPS.flatMap((g) => g.names));
    const groups = GROUPS.concat([{ title: 'その他', names: merged.map((p) => p.name).filter((n) => !known.has(n)) }]);
    mergedByName = Object.fromEntries(merged.map((p) => [p.name, p]));
    const byName = mergedByName;
    const screen = screenTrackpad();
    let totalRows = 0;
    for (const g of groups) {
      const box = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = g.title;
      box.appendChild(legend);
      if (g.ic) {
        const note = document.createElement('div');
        note.className = 'groupnote';
        note.textContent = '書き込んだあと、パッドに一度触れると反映されます'
          + (g.reati ? '。この値を変えたら Re-ATI が必要です' : '');
        box.appendChild(note);
      }
      if (g.reati) {
        const b = document.createElement('button');
        b.textContent = 'Re-ATI';
        b.disabled = Link.activeSides().length === 0;
        b.onclick = async () => {
          for (const s of Link.activeSides()) await Link.runSimpleOnSide(s, 'tp reati');
          root.TpAppMain.setStatus('Re-ATI を実行しました');
        };
        box.appendChild(b);
      }
      let rows = 0;
      for (const name of g.names) {
        const p = byName[name];
        if (!p || seen.has(name)) continue;
        seen.add(name);
        const help = helpFor(name);
        if (!T.paramMatchesQuery(p.name, helpSearchText(help), query)) continue;
        box.appendChild(renderParamRow(p, screen, help));
        rows++;
      }
      if (rows > 0) { root2.appendChild(box); totalRows += rows; }
    }
    if (totalRows === 0) {
      root2.innerHTML = '<span class="legend">一致するパラメータがありません</span>';
    }
  }

  function exportConfText() {
    const merged = T.mergeParams(params.R, params.L);
    if (merged.length === 0) return null;
    return T.exportConf(merged, { diffOnly: false });
  }

  function rebuildPendingFromFailures(failed) {
    const next = emptyPending();
    for (const f of failed) next[f.side][f.name] = f.value;
    return next;
  }

  async function write() {
    const sides = Link.activeSides();
    if (!sides.length) return { written: 0, failed: 0, total: 0 };
    const cmds = T.pendingCommands(pending, sides);
    if (!cmds.length) return { written: 0, failed: 0, total: 0 };
    const failed = [];
    for (const c of cmds) {
      const parts = c.cmd.split(' ');
      const name = parts[2];
      const value = Number(parts[3]);
      const lines = await Link.sendTo(c.side, c.cmd).catch((e) => { root.TpAppMain.log(`[${c.side}] ` + errText(e)); return []; });
      const ok = lines.some((l) => l.startsWith('OK'));
      if (!ok) failed.push({ side: c.side, name, value });
    }
    for (const s of sides) await Link.runSimpleOnSide(s, 'tp save');
    pending = rebuildPendingFromFailures(failed);
    for (const s of sides) {
      await loadParamsForSide(s);
      await refreshInfoForSide(s);
    }
    notifyHeaderChanged();
    renderParams();
    return { written: cmds.length - failed.length, failed: failed.length, total: cmds.length };
  }

  async function reload() {
    pending = emptyPending();
    const count = await loadAllParams();
    for (const s of Link.activeSides()) await refreshInfoForSide(s);
    notifyHeaderChanged();
    return count;
  }

  function undoPending() {
    pending = emptyPending();
    renderParams();
    notifyHeaderChanged();
  }

  function reset() {
    pending = emptyPending();
    params.R = []; params.L = [];
  }

  $('chkDetail').onchange = () => { detailMode = $('chkDetail').checked; renderParams(); };
  $('paramSearch').oninput = () => { query = $('paramSearch').value; renderParams(); };
  $('btnParamsUndo').onclick = () => undoPending();

  const api = {
    render: renderParams, reset, pendingCount, paramsForSuggest, loadAllParams, refreshInfoForSide,
    screenTrackpad, setPresetTrackpad, presetDiff, presetDiffSummary, applyPresetTrackpad,
    defaultTrackpad, applyDefaults,
    write, reload, undoPending, exportConfText,
  };
  root.TpAppParams = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
