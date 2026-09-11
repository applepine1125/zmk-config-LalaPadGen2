(function (root) {
  'use strict';
  const T = globalThis.TpTuner;
  if (!T) return;
  const Link = root.TpAppLink;
  if (!Link) return;

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
    { title: 'IC 感度(変更後にパッドへ一度触れると反映)', ic: true, names: ['touch_set_threshold', 'touch_clear_threshold', 'alp_set_debounce', 'alp_clear_debounce', 'stationary_touch_mov_threshold', 'jitter_filter_delta', 'finger_confidence_threshold'] },
    { title: 'IC サンプリング周期', ic: true, names: ['active_mode_sampling_period_ms', 'idle_touch_mode_sampling_period_ms', 'idle_mode_sampling_period_ms', 'lp1_mode_sampling_period_ms', 'lp2_mode_sampling_period_ms', 'active_mode_timeout_ms', 'idle_touch_mode_timeout_s', 'idle_mode_timeout_s', 'lp1_mode_timeout_s'] },
    { title: 'IC フィルタ / ATI(変更後は Re-ATI)', ic: true, names: ['ati_targetcount', 'dynamic_filter_bottom_speed', 'dynamic_filter_top_speed', 'dynamic_filter_bottom_beta'] },
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
    touch_set_threshold: { what: 'タッチと判定する強さの閾値', up: '軽いタッチを拾わなくなる', down: '軽いタッチを拾うが誤反応も増える' },
    touch_clear_threshold: { what: 'タッチ解除の閾値(set より小さくする)', up: 'set との差が小さくなり離し判定が遅れやすい', down: 'set との差が大きくなり離し判定が遅れにくい' },
    alp_set_debounce: { what: '低消費電力モードからの復帰に必要な連続検出回数', up: '誤起動が減るが初動が遅い', down: '初動が速いが誤起動が増える' },
    alp_clear_debounce: { what: '低消費電力モードへ戻るのに必要な連続非検出回数', up: '戻りにくい', down: 'すぐ戻る' },
    stationary_touch_mov_threshold: { what: 'これ以下の移動は静止と見なす', up: '小さなふらつきを無視する', down: '小さな動きも拾う' },
    jitter_filter_delta: { what: 'ジッタ(震え)フィルタの幅', up: '細かな震えを消すが細かい動きも消える', down: '細かい動きが通るが震えも出る' },
    finger_confidence_threshold: { what: '指と認める信頼度', up: '誤検出が減るが拾いにくい', down: '拾いやすいが誤検出が増える' },
    dynamic_filter_bottom_speed: { what: '速度に応じた平滑化の下限速度', up: '低速域が広がり遅い動きも強く平滑化する', down: '低速域が狭まる' },
    dynamic_filter_top_speed: { what: '速度に応じた平滑化の上限速度', up: '高速域まで平滑化が残る', down: '速い動きはすぐ生の座標になる' },
    dynamic_filter_bottom_beta: { what: '低速時の平滑化の強さ', up: '滑らかだが遅れる', down: '追従が速いが震えが出る' },
    ati_targetcount: { what: '感度の基準カウント。変えたら Re-ATI', up: '基準が高くなる', down: '基準が低くなる' },
    active_mode_sampling_period_ms: { what: 'アクティブモードのサンプリング周期(ms)', up: '電池は持つが反応が遅い', down: '反応が速いが電池を使う' },
    idle_touch_mode_sampling_period_ms: { what: '触れたまま静止しているときの周期(ms)', up: '電池は持つが反応が遅い', down: '反応が速いが電池を使う' },
    idle_mode_sampling_period_ms: { what: '待機中の周期(ms)', up: '電池は持つが初動が遅い', down: '初動が速いが電池を使う' },
    lp1_mode_sampling_period_ms: { what: '省電力 1 の周期(ms)', up: '電池は持つが初動が遅い', down: '初動が速いが電池を使う' },
    lp2_mode_sampling_period_ms: { what: '省電力 2 の周期(ms)', up: '電池は持つが初動が遅い', down: '初動が速いが電池を使う' },
    active_mode_timeout_ms: { what: 'アクティブモードから省電力へ落ちるまでの時間(ms)', up: '省電力に落ちにくい', down: 'すぐ省電力に落ちる' },
    idle_touch_mode_timeout_s: { what: '指を置いたまま動かさないときに Idle-Touch から Idle に落ちるまでの時間(秒)', up: '置いたままでも反応が落ちにくいが電池を使う', down: '早く省電力になる' },
    idle_mode_timeout_s: { what: '触れていないときに Idle から LP1(省電力)に落ちるまでの時間(秒)', up: '手を離した後も反応が速いままだが電池を使う', down: '早く省電力になり、次に触れたときの反応が遅れやすい' },
    lp1_mode_timeout_s: { what: 'LP1 から LP2(さらに省電力)に落ちるまでの時間(秒)', up: '長い放置後も復帰が速いが電池を使う', down: '早く省電力になる' },
  };

  function helpText(name) {
    const h = PARAM_HELP[name];
    if (!h) return '';
    if (h.on) return `${h.what}。ON: ${h.on}。OFF: ${h.off}`;
    return `${h.what}。上げると${h.up}。下げると${h.down}`;
  }

  const params = { R: [], L: [] };
  let pending = { common: {}, R: {}, L: {} };
  let detailMode = false;
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
    return count;
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

  function isRowActiveCommon(name) {
    return T.isParamActive(name, commonGetValue);
  }

  function isRowActiveSide(name, sideKey) {
    return T.isParamActive(name, (n) => sideGetValue(sideKey, n));
  }

  function setInputsDisabled(cell, disabled) {
    for (const el of cell.querySelectorAll('input')) el.disabled = disabled;
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

  function updateRowMark(nameKey, bucket, originalValue) {
    const row = document.querySelector(`.param[data-name="${CSS.escape(nameKey)}"]`);
    if (!row) return;
    const cell = bucket === 'common' ? row.querySelector('.cell') : row.querySelector(`.cell[data-side="${bucket}"]`);
    if (!cell) return;
    const mark = cell.querySelector('.pendingmark');
    if (mark) mark.remove();
    const value = bucket === 'common' ? pending.common[nameKey] : pending[bucket][nameKey];
    if (value !== undefined) {
      const m = document.createElement('span');
      m.className = 'pendingmark';
      m.textContent = `← ${originalValue}`;
      cell.appendChild(m);
    }
    const rowHasPending = pending.common[nameKey] !== undefined || pending.R[nameKey] !== undefined || pending.L[nameKey] !== undefined;
    row.classList.toggle('changed', rowHasPending);
  }

  function setPendingCommon(p, value) {
    if (value === p.value) delete pending.common[p.name]; else pending.common[p.name] = value;
    updateRowMark(p.name, 'common', p.value);
    refreshDependentRows(p.name);
    root.TpAppMain.renderHeader();
  }

  function setPendingSide(p, sideKey, value) {
    const current = sideKey === 'R' ? p.valueR : p.valueL;
    if (value === current) delete pending[sideKey][p.name]; else pending[sideKey][p.name] = value;
    updateRowMark(p.name, sideKey, current);
    refreshDependentRows(p.name);
    root.TpAppMain.renderHeader();
  }

  function buildEditor(kind, min, max, value, onChange) {
    const wrap = document.createElement('span');
    wrap.className = 'cell';
    if (kind === 'driver_bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.onchange = () => onChange(cb.checked ? 1 : 0);
      wrap.appendChild(cb);
    } else {
      const range = document.createElement('input');
      range.type = 'range'; range.min = min; range.max = max; range.value = value;
      const num = document.createElement('input');
      num.type = 'number'; num.min = min; num.max = max; num.value = value;
      range.oninput = () => { num.value = range.value; onChange(Number(range.value)); };
      num.onchange = () => {
        const v = Math.min(max, Math.max(min, Math.round(Number(num.value) || 0)));
        num.value = v; range.value = v; onChange(v);
      };
      wrap.append(range, num);
    }
    return wrap;
  }

  function renderCommonCell(p, active) {
    const displayValue = Object.prototype.hasOwnProperty.call(pending.common, p.name) ? pending.common[p.name] : p.value;
    const wrap = buildEditor(p.kind, p.min, p.max, displayValue, (v) => setPendingCommon(p, v));
    if (!active) setInputsDisabled(wrap, true);
    if (Object.prototype.hasOwnProperty.call(pending.common, p.name)) {
      const m = document.createElement('span');
      m.className = 'pendingmark';
      m.textContent = `← ${p.value}`;
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
    const editor = buildEditor(p.kind, p.min, p.max, displayValue, (v) => setPendingSide(p, sideKey, v));
    wrap.append(...editor.childNodes);
    if (!active) { setInputsDisabled(wrap, true); wrap.classList.add('inactive'); }
    if (Object.prototype.hasOwnProperty.call(bucket, p.name)) {
      const m = document.createElement('span');
      m.className = 'pendingmark';
      m.textContent = `← ${current}`;
      wrap.appendChild(m);
    }
    return wrap;
  }

  function renderParamRow(p) {
    const row = document.createElement('div');
    row.className = 'param' + (p.kind === 'driver_bool' ? ' bool' : '') + (detailMode ? ' detail' : '');
    row.dataset.name = p.name;
    const label = document.createElement('label');
    label.textContent = p.name;
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
    const help = helpText(p.name);
    if (help || (p.differs && !detailMode)) {
      const d = document.createElement('div');
      d.className = 'desc';
      const differsText = p.differs && !detailMode ? `左右で違う(右 ${p.valueR} / 左 ${p.valueL})` : '';
      d.textContent = [differsText, help].filter(Boolean).join(' ・ ');
      row.appendChild(d);
    }
    return row;
  }

  function renderParams() {
    const root2 = $('params');
    root2.innerHTML = '';
    const merged = T.mergeParams(params.R, params.L);
    if (merged.length === 0) {
      mergedByName = {};
      root2.innerHTML = '<span class="legend">接続すると tp list の内容がここに表示されます</span>';
      return;
    }
    const seen = new Set();
    const known = new Set(GROUPS.flatMap((g) => g.names));
    const groups = GROUPS.concat([{ title: 'その他', names: merged.map((p) => p.name).filter((n) => !known.has(n)) }]);
    mergedByName = Object.fromEntries(merged.map((p) => [p.name, p]));
    const byName = mergedByName;
    for (const g of groups) {
      const box = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = g.title;
      box.appendChild(legend);
      if (g.ic) {
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
        box.appendChild(renderParamRow(p));
        rows++;
      }
      if (rows > 0) root2.appendChild(box);
    }
  }

  async function saveExportedFile(name, text) {
    try {
      const res = await Link.saveFile(name, text);
      if (res.cancelled) return;
      if (!res.ok) { root.TpAppMain.setStatus('保存に失敗しました: ' + (res.error || ''), true); return; }
      root.TpAppMain.setStatus((res.path || name) + ' に保存しました');
    } catch (e) {
      root.TpAppMain.setStatus('保存に失敗しました: ' + errText(e), true);
    }
  }

  async function exportConfNow() {
    const merged = T.mergeParams(params.R, params.L);
    if (merged.length === 0) { root.TpAppMain.setStatus('パラメータが読み込まれていません', true); return; }
    const text = T.exportConf(merged, { diffOnly: false });
    await saveExportedFile('lalapadgen2.conf', text);
  }

  function rebuildPendingFromFailures(failed) {
    const next = emptyPending();
    for (const f of failed) next[f.side][f.name] = f.value;
    return next;
  }

  async function writeAll() {
    const sides = Link.activeSides();
    if (!sides.length) { root.TpAppMain.setStatus('未接続です', true); return; }
    const cmds = T.pendingCommands(pending, sides);
    if (!cmds.length) { root.TpAppMain.setStatus('書き込む変更がありません'); return; }
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
    root.TpAppMain.renderHeader();
    renderParams();
    root.TpAppMain.setStatus(failed.length
      ? `書き込み: ${cmds.length - failed.length}/${cmds.length} 件成功。失敗した行は保留のままです`
      : `${cmds.length} 件を書き込みました`, failed.length > 0);
  }

  async function reloadAll() {
    if (pendingCount() > 0 && !window.confirm('書き込んでいない変更を捨てて、キーボードに保存されている状態に戻します。よろしいですか?')) return;
    pending = emptyPending();
    try {
      const count = await loadAllParams();
      for (const s of Link.activeSides()) await refreshInfoForSide(s);
      root.TpAppMain.renderHeader();
      root.TpAppMain.setStatus(`パラメータ ${count} 件を再読み込みしました`);
    } catch (e) {
      root.TpAppMain.setStatus(errText(e), true);
    }
  }

  async function resetAll() {
    const sides = Link.activeSides();
    if (!sides.length) { root.TpAppMain.setStatus('未接続です', true); return; }
    if (!window.confirm('すべてのパラメータをファームのデフォルト値に戻します。保存済みの値も削除されます。よろしいですか?')) return;
    let allOk = true;
    for (const s of sides) allOk = (await Link.runSimpleOnSide(s, 'tp reset')) && allOk;
    pending = emptyPending();
    for (const s of sides) {
      await loadParamsForSide(s);
      await refreshInfoForSide(s);
    }
    root.TpAppMain.renderHeader();
    renderParams();
    root.TpAppMain.setStatus(allOk ? 'すべてデフォルトに戻しました' : '一部の側で失敗しました', !allOk);
  }

  function reset() {
    pending = emptyPending();
    params.R = []; params.L = [];
  }

  function setButtonsEnabled(isConn) {
    $('btnWrite').disabled = !isConn;
    $('btnReload').disabled = !isConn;
    $('btnResetAll').disabled = !isConn;
  }

  $('btnWrite').onclick = () => { writeAll(); };
  $('btnReload').onclick = () => { reloadAll(); };
  $('btnResetAll').onclick = () => { resetAll(); };
  $('btnExport').onclick = () => { exportConfNow(); };
  $('chkDetail').onchange = () => { detailMode = $('chkDetail').checked; renderParams(); };

  const api = {
    render: renderParams, reset, pendingCount, paramsForSuggest, loadAllParams, refreshInfoForSide,
    setButtonsEnabled,
  };
  root.TpAppParams = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
