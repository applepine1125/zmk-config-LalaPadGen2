(function (root) {
  'use strict';

  const BTN = { 0: 0x110, 1: 0x111, 2: 0x112, 7: 0x117 };
  const REL = { X: 0, Y: 1, HWHEEL: 6, WHEEL: 8 };
  const CONF_PREFIX = 'CONFIG_INPUT_IQS9151_';
  const ANSI_RE = /\x1b(\[[0-9;?]*[ -/]*[@-~]|[0-Z\\-~])/g;
  const PROMPT_PREFIX_RE = /^[^\s$]*:~\$ /;

  function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
  }

  function isPrompt(text) {
    return /\$ $/.test(text);
  }

  function stripPromptPrefix(line) {
    return line.replace(PROMPT_PREFIX_RE, '');
  }

  function isEcho(line, cmd) {
    if (!cmd) return false;
    const s = stripPromptPrefix(line).trim();
    return s === cmd || s.endsWith(cmd);
  }

  function parseListLine(line) {
    const m = /^([a-z0-9_]+) (-?\d+) (-?\d+) (-?\d+) (ic_u8|ic_u16|driver|driver_bool) (-?\d+)$/
      .exec(line.trim());
    if (!m) return null;
    return {
      name: m[1], value: Number(m[2]), min: Number(m[3]), max: Number(m[4]),
      kind: m[5], def: Number(m[6]),
    };
  }

  function parseInfoLine(line) {
    const m = /^side=(central|peripheral) uptime_ms=(\d+) params=(\d+)$/.exec(line.trim());
    if (!m) return null;
    return { side: m[1], uptimeMs: Number(m[2]), params: Number(m[3]) };
  }

  function parseTraceLine(line) {
    const idx = line.indexOf('T ');
    if (idx < 0) return null;
    const parts = line.slice(idx).trim().split(/\s+/);
    if (parts[0] !== 'T') return null;
    if (parts[1] === 'F' && parts.length === 14) {
      const n = parts.slice(2).map((s, i) => (i === 8 ? parseInt(s, 16) : Number(s)));
      if (n.some(Number.isNaN)) return null;
      return {
        type: 'F', ms: n[0], fingers: n[1], relX: n[2], relY: n[3], f1x: n[4], f1y: n[5],
        f2x: n[6], f2y: n[7], flags: n[8], hold: n[9], mode2f: n[10], pending: n[11],
      };
    }
    if (parts[1] === 'E' && parts.length === 7 && (parts[3] === 'K' || parts[3] === 'R')) {
      const ms = Number(parts[2]);
      const code = Number(parts[4]);
      const value = Number(parts[5]);
      const ret = Number(parts[6]);
      if ([ms, code, value, ret].some(Number.isNaN)) return null;
      return { type: 'E', ms, kind: parts[3], code, value, ret };
    }
    return null;
  }

  function clockOffset(hostSentMs, hostRecvMs, uptimeMs) {
    return (hostSentMs + hostRecvMs) / 2 - uptimeMs;
  }

  function toConfName(name) {
    return CONF_PREFIX + name.toUpperCase();
  }

  function exportConf(params, opts) {
    const diffOnly = !!(opts && opts.diffOnly);
    let out = '';
    for (const p of params) {
      if (diffOnly && p.value === p.def) continue;
      const v = p.kind === 'driver_bool' ? (p.value ? 'y' : 'n') : String(p.value);
      out += toConfName(p.name) + '=' + v + '\n';
    }
    return out;
  }

  function detectDrops(fwEvents) {
    return fwEvents
      .filter((e) => e.type === 'E' && e.ret !== 0)
      .map((e) => ({ t: e.t, code: e.code, kind: e.kind }));
  }

  function hostButtonsAt(samples, t) {
    let buttons = 0;
    for (const s of samples) {
      if (s.t > t) break;
      buttons = s.buttons;
    }
    return buttons;
  }

  function hostBitForCode(code) {
    if (code === BTN[0]) return 1;
    if (code === BTN[1]) return 2;
    if (code === BTN[2]) return 4;
    return 0;
  }

  function detectStuckButton(fwEvents, hostButtonSamples, opts) {
    const holdMs = (opts && opts.holdMs) || 300;
    const now = opts && typeof opts.now === 'number' ? opts.now : null;
    const out = [];
    const keys = fwEvents.filter((e) => e.type === 'E' && e.kind === 'K');
    for (let i = 0; i < keys.length; i++) {
      const e = keys[i];
      if (e.value !== 0) continue;
      const bit = hostBitForCode(e.code);
      if (!bit) continue;
      const nextPress = keys.slice(i + 1).find((k) => k.code === e.code && k.value === 1);
      const checkT = e.t + holdMs;
      if (now !== null && checkT > now) continue;
      if (nextPress && nextPress.t <= checkT) continue;
      if (hostButtonsAt(hostButtonSamples, checkT) & bit) {
        out.push({ t: e.t, code: e.code });
      }
    }
    return out;
  }

  function detectMissingWheel(fwEvents, hostWheelEvents, opts) {
    const windowMs = (opts && opts.windowMs) || 200;
    const out = [];
    const wheels = fwEvents.filter(
      (e) => e.type === 'E' && e.kind === 'R' && (e.code === REL.WHEEL || e.code === REL.HWHEEL));
    let lastFlagged = -Infinity;
    for (const w of wheels) {
      const received = hostWheelEvents.some((h) => h.t >= w.t && h.t <= w.t + windowMs);
      if (!received && w.t - lastFlagged > windowMs) {
        out.push({ t: w.t });
        lastFlagged = w.t;
      }
    }
    return out;
  }

  function detectTwoFingerNoScroll(frames, fwEvents, opts) {
    const minMove = (opts && opts.minMove) || 30;
    const windowMs = (opts && opts.windowMs) || 200;
    const out = [];
    const wheels = fwEvents.filter(
      (e) => e.type === 'E' && e.kind === 'R' && (e.code === REL.WHEEL || e.code === REL.HWHEEL));
    let start = null;
    let move = 0;
    const flush = (endT) => {
      if (start === null) return;
      const hadWheel = wheels.some((w) => w.t >= start && w.t <= endT);
      if (move >= minMove && endT - start >= windowMs && !hadWheel) out.push({ t: start });
      start = null;
      move = 0;
    };
    for (const f of frames) {
      if (f.type !== 'F') continue;
      if (f.fingers === 2) {
        if (start === null) start = f.t;
        move += Math.abs(f.relX) + Math.abs(f.relY);
      } else {
        flush(f.t);
      }
    }
    if (frames.length) flush(frames[frames.length - 1].t);
    return out;
  }

  const BTN_NAMES = { [BTN[0]]: '左', [BTN[1]]: '右', [BTN[2]]: '中', [BTN[7]]: 'ピンチ' };
  const DEFAULT_PARAMS = {
    '1f_tap_max_ms': 250, '1f_tap_move': 50, '1f_tapdrag_gap_max_ms': 160,
    '2f_tap_max_ms': 250, '2f_tap_move': 50, '2f_scroll_start_move': 15, '2f_pinch_start_distance': 30,
    '3f_tap_max_ms': 200, '3f_tap_move': 35,
  };
  const GESTURES = [
    { kind: 'tap1', title: '1本指タップ', instruction: '指 1 本で軽く 1 回叩く', expect: '左クリック',
      params: [{ name: '1f_tap_max_ms', loosen: 50 }, { name: '1f_tap_move', loosen: 10 }] },
    { kind: 'tapdrag', title: 'タップドラッグ', instruction: '1 回叩いてすぐに触れ直し、そのまま動かしてから離す', expect: 'ドラッグ',
      params: [{ name: '1f_tapdrag_gap_max_ms', loosen: 40 }] },
    { kind: 'scroll2', title: '2本指スクロール', instruction: '指 2 本を揃えて上下に動かす', expect: 'スクロール',
      params: [{ name: '2f_scroll_start_move', loosen: -5 }] },
    { kind: 'tap2', title: '2本指タップ', instruction: '指 2 本で同時に軽く叩く', expect: '右クリック',
      params: [{ name: '2f_tap_max_ms', loosen: 50 }, { name: '2f_tap_move', loosen: 10 }] },
    { kind: 'pinch', title: 'ピンチ', instruction: '指 2 本の間隔を広げる / 狭める', expect: 'ピンチ',
      params: [{ name: '2f_pinch_start_distance', loosen: -10 }] },
    { kind: 'tap3', title: '3本指タップ', instruction: '指 3 本で同時に軽く叩く', expect: '中クリック',
      params: [{ name: '3f_tap_max_ms', loosen: 50 }, { name: '3f_tap_move', loosen: 10 }] },
  ];

  function paramValue(params, name) {
    let v;
    if (Array.isArray(params)) {
      const p = params.find((x) => x.name === name);
      v = p ? p.value : undefined;
    } else if (params && typeof params === 'object') {
      const p = params[name];
      v = p && typeof p === 'object' ? p.value : p;
    }
    return typeof v === 'number' ? v : DEFAULT_PARAMS[name];
  }

  function stepParam(p, delta) {
    return Math.min(p.max, Math.max(p.min, p.value + delta));
  }

  function segmentAttempts(frames, opts) {
    const idleMs = (opts && opts.idleMs) || 400;
    const now = opts && typeof opts.now === 'number' ? opts.now : null;
    const out = [];
    let cur = null;
    let keep = 0;
    for (const f of frames) {
      if (f.type && f.type !== 'F') continue;
      if (f.fingers > 0) {
        if (!cur) cur = { start: f.t, end: f.t, frames: [], closed: false };
        cur.frames.push(f);
        cur.end = f.t;
        keep = cur.frames.length;
      } else if (cur) {
        if (f.t - cur.end >= idleMs) {
          cur.frames = cur.frames.slice(0, keep);
          cur.closed = true;
          out.push(cur);
          cur = null;
        } else {
          cur.frames.push(f);
        }
      }
    }
    if (cur) {
      cur.frames = cur.frames.slice(0, keep);
      cur.closed = now !== null && now - cur.end >= idleMs;
      out.push(cur);
    }
    return out;
  }

  function touchRuns(frames) {
    const runs = [];
    let cur = null;
    for (const f of frames) {
      if (f.fingers > 0) {
        if (!cur) {
          cur = { start: f.t, end: f.t, downMs: 0, moveSum: 0, fingersMax: 0, frames: [] };
          runs.push(cur);
        }
        cur.end = f.t;
        cur.downMs = cur.end - cur.start;
        cur.moveSum += Math.abs(f.relX || 0) + Math.abs(f.relY || 0);
        cur.fingersMax = Math.max(cur.fingersMax, f.fingers);
        cur.frames.push(f);
      } else {
        cur = null;
      }
    }
    return runs;
  }

  function observeAttempt(attempt, fwEvents, host, opts) {
    const tailMs = (opts && opts.tailMs) || 500;
    const start = attempt.start;
    const end = attempt.end;
    const windowEnd = end + tailMs;
    const touches = touchRuns(attempt.frames).map((r) => ({
      start: r.start, end: r.end, downMs: r.downMs, moveSum: r.moveSum, fingersMax: r.fingersMax,
      holds: [...new Set(r.frames.map((f) => f.hold).filter((h) => h > 0))],
    }));
    const first = touches[0];
    const second = touches[1];
    const fingersMax = touches.reduce((m, t) => Math.max(m, t.fingersMax), 0);
    const moveSum = touches.reduce((s, t) => s + t.moveSum, 0);
    const twoFingerFrames = attempt.frames.filter((f) => f.fingers === 2);
    const moveSum2 = twoFingerFrames.reduce((s, f) => s + Math.abs(f.relX || 0) + Math.abs(f.relY || 0), 0);
    let distDelta = 0;
    if (twoFingerFrames.length) {
      const dist = (f) => Math.hypot((f.f2x || 0) - (f.f1x || 0), (f.f2y || 0) - (f.f1y || 0));
      const d0 = dist(twoFingerFrames[0]);
      for (const f of twoFingerFrames) distDelta = Math.max(distDelta, Math.abs(dist(f) - d0));
    }
    distDelta = Math.round(distDelta);
    const mode2fSeen = [...new Set(attempt.frames.map((f) => f.mode2f).filter((m) => m > 0))].sort();

    const ev = (fwEvents || []).filter((e) => e.type === 'E' && e.t >= start && e.t <= windowEnd);
    const keys = ev.filter((e) => e.kind === 'K').map((e) => ({ t: e.t, code: e.code, value: e.value }));
    const buttonsPressed = [...new Set(keys.filter((k) => k.value !== 0).map((k) => k.code))];
    const buttonsReleased = [...new Set(keys.filter((k) => k.value === 0).map((k) => k.code))];
    const wheels = ev.filter((e) => e.kind === 'R' && (e.code === REL.WHEEL || e.code === REL.HWHEEL));
    const wheel = { count: wheels.length, sum: wheels.reduce((s, w) => s + w.value, 0) };

    const hostBtn = (host && host.btn) || [];
    const down = [];
    const up = [];
    let prev = hostButtonsAt(hostBtn, start);
    for (const s of hostBtn) {
      if (s.t <= start || s.t > windowEnd) continue;
      for (const bit of [1, 2, 4]) {
        if ((s.buttons & bit) && !(prev & bit) && !down.includes(bit)) down.push(bit);
        if (!(s.buttons & bit) && (prev & bit) && !up.includes(bit)) up.push(bit);
      }
      prev = s.buttons;
    }
    const inWindow = (x) => x.t >= start && x.t <= windowEnd;
    const moveCount = ((host && host.move) || []).filter(inWindow).length;
    const wheelCount = ((host && host.wheel) || []).filter(inWindow).length;
    const hostAtEnd = hostButtonsAt(hostBtn, windowEnd);
    const stuckBits = buttonsReleased.map(hostBitForCode).filter((bit) => bit && (hostAtEnd & bit));

    return {
      start, end, windowEnd, touches, fingersMax,
      downMs: first ? first.downMs : 0, moveSum,
      gapMs: second ? second.start - first.end : null,
      moveSum2, distDelta, mode2fSeen, keys, buttonsPressed, buttonsReleased, wheel,
      host: { down, up, moveCount, wheelCount, stuckBits },
    };
  }

  function inferKind(o, params) {
    const P = (name) => paramValue(params, name);
    const first = o.touches[0];
    const second = o.touches[1];
    if (!first) return 'unknown';
    if (o.fingersMax >= 3) {
      return o.buttonsPressed.includes(BTN[2]) || first.moveSum <= 2 * P('3f_tap_move') ? 'tap3' : 'move';
    }
    if (o.fingersMax === 2) {
      if (o.mode2fSeen.includes(2)) return 'pinch';
      if (o.mode2fSeen.includes(1) || o.wheel.count > 0) return 'scroll2';
      if (o.buttonsPressed.includes(BTN[1])) return 'tap2';
      if (o.distDelta > 0 && o.distDelta >= o.moveSum2) return 'pinch';
      if (first.downMs > P('2f_tap_max_ms') || first.moveSum > P('2f_tap_move')) return 'scroll2';
      return 'tap2';
    }
    if (second && second.moveSum > P('1f_tap_move')) return 'tapdrag';
    if (o.buttonsPressed.includes(BTN[0]) || first.moveSum <= 2 * P('1f_tap_move')) return 'tap1';
    return 'move';
  }

  const HOST_CHECK = '(テストモード中か・出力先が USB か確認)';

  function fingersStage(o, n) {
    if (!o.touches.length) return { ok: false, detail: '接触なし', stop: true };
    if (o.fingersMax !== n) return { ok: false, detail: `指 ${o.fingersMax} 本で認識されました`, stop: true };
    return { ok: true, detail: `指 ${n} 本` };
  }

  function atMost(actual, name, max, unit, delta) {
    if (actual <= max) return { ok: true, detail: `実測 ${actual}${unit}` };
    return { ok: false, detail: `実測 ${actual}${unit} > ${name}=${max}`, suggest: [{ name, delta }] };
  }

  function pressedStage(o, code, hint) {
    if (o.buttonsPressed.includes(code)) return { ok: true, detail: `K${code} 1 の報告あり` };
    return { ok: false, detail: `K${code} 1 の報告なし` + (hint ? `(${hint})` : '') };
  }

  function releasedStage(o, code) {
    if (o.buttonsReleased.includes(code)) return { ok: true, detail: `K${code} 0 の報告あり` };
    return { ok: false, detail: `K${code} 0 の報告なし(ドライバが離していない)` };
  }

  function hostClickStage(o, bit, label) {
    if (o.host.stuckBits.includes(bit)) return { ok: false, detail: `ホストで${label}ボタンが押されたまま(タップ後ドラッグ残り)` };
    if (o.host.down.includes(bit) && o.host.up.includes(bit)) return { ok: true, detail: 'down→up' };
    return { ok: false, host: true, detail: `ホスト側で${label}ボタンが観測されていない${HOST_CHECK}` };
  }

  function tapStages(prefix, n, code, bit, click) {
    const label = BTN_NAMES[code];
    const maxMsName = `${prefix}_tap_max_ms`;
    const maxMoveName = `${prefix}_tap_move`;
    return [
      { label: () => `指 ${n} 本で接触`, eval: (o) => fingersStage(o, n) },
      { label: (P) => `押下時間 ≤ ${maxMsName}(${P(maxMsName)}ms)`, eval: (o, P) => atMost(o.touches[0].downMs, maxMsName, P(maxMsName), 'ms', 50) },
      { label: (P) => `移動量 ≤ ${maxMoveName}(${P(maxMoveName)})`, eval: (o, P) => atMost(o.touches[0].moveSum, maxMoveName, P(maxMoveName), '', 10) },
      { label: () => `ドライバが${label}ボタンを押した(K${code} 1)`,
        eval: (o, P, st) => pressedStage(o, code, st[1].ok && st[2].ok ? `${prefix}_tap_enable を確認` : '') },
      { label: () => `離した(K${code} 0)`, eval: (o, P, st) => (st[3].ok ? releasedStage(o, code) : null) },
      { label: () => `ホストが${click}を受けた(down→up)`, eval: (o, P, st) => (st[3].ok ? hostClickStage(o, bit, label) : null) },
    ];
  }

  const TAPDRAG_STAGES = [
    { label: (P) => `1 本目の接触がタップ条件を満たす(押下 ≤ 1f_tap_max_ms(${P('1f_tap_max_ms')}ms)、移動 ≤ 1f_tap_move(${P('1f_tap_move')}))`,
      eval: (o, P) => {
        const f = fingersStage(o, 1);
        if (!f.ok) return f;
        const t = o.touches[0];
        const bad = [];
        const suggest = [];
        if (t.downMs > P('1f_tap_max_ms')) { bad.push(`押下 ${t.downMs}ms > 1f_tap_max_ms=${P('1f_tap_max_ms')}`); suggest.push({ name: '1f_tap_max_ms', delta: 50 }); }
        if (t.moveSum > P('1f_tap_move')) { bad.push(`移動 ${t.moveSum} > 1f_tap_move=${P('1f_tap_move')}`); suggest.push({ name: '1f_tap_move', delta: 10 }); }
        if (bad.length) return { ok: false, detail: bad.join('、'), suggest };
        return { ok: true, detail: `押下 ${t.downMs}ms 移動 ${t.moveSum}` };
      } },
    { label: () => 'ドライバが左ボタンを押した(K272 1)', eval: (o, P, st) => pressedStage(o, BTN[0], st[0].ok ? '1f_tap_enable を確認' : '') },
    { label: (P) => `2 本目の接触が 1f_tapdrag_gap_max_ms(${P('1f_tapdrag_gap_max_ms')}ms)以内`,
      eval: (o, P) => {
        if (!o.touches[1]) return { ok: false, detail: '2 本目の接触なし' };
        return atMost(o.gapMs, '1f_tapdrag_gap_max_ms', P('1f_tapdrag_gap_max_ms'), 'ms', 40);
      } },
    { label: () => '2 本目の接触中も押したまま(hold=272)で移動あり',
      eval: (o) => {
        const second = o.touches[1];
        if (!second) return null;
        if (!second.holds.includes(BTN[0])) {
          const releasedBefore = o.keys.some((k) => k.code === BTN[0] && k.value === 0 && k.t < second.start);
          return { ok: false, detail: releasedBefore ? `2 本目の接触前(間隔 ${o.gapMs}ms)にドライバが左ボタンを離した` : 'hold=272 のフレームなし' };
        }
        if (second.moveSum === 0) return { ok: false, detail: 'hold=272 はあるが移動なし' };
        return { ok: true, detail: `hold=272 あり、移動 ${second.moveSum}` };
      } },
    { label: () => '離したら左ボタン離し(K272 0)',
      eval: (o, P, st) => {
        if (!st[1].ok) return null;
        const last = o.touches[o.touches.length - 1];
        const released = o.keys.some((k) => k.code === BTN[0] && k.value === 0 && k.t >= last.end - 30);
        return released ? { ok: true, detail: 'K272 0 の報告あり' } : { ok: false, detail: 'ドラッグ終了後もドライバが左ボタンを離していない' };
      } },
    { label: () => 'ホストで down→move→up',
      eval: (o, P, st) => {
        if (!st[1].ok) return null;
        const h = o.host;
        if (h.stuckBits.includes(1)) return { ok: false, detail: 'ホストで左ボタンが押されたまま(タップ後ドラッグ残り)' };
        if (h.down.includes(1) && h.moveCount > 0 && h.up.includes(1)) return { ok: true, detail: `down→move ${h.moveCount} 回→up` };
        return { ok: false, host: true, detail: `down ${h.down.includes(1) ? 'あり' : 'なし'} / move ${h.moveCount} 回 / up ${h.up.includes(1) ? 'あり' : 'なし'}${HOST_CHECK}` };
      } },
  ];

  const SCROLL2_STAGES = [
    { label: () => '指 2 本で接触', eval: (o) => fingersStage(o, 2) },
    { label: (P) => `移動量が 2f_scroll_start_move(${P('2f_scroll_start_move')})を超えてスクロール判定(mode2f=1)`,
      eval: (o, P) => {
        if (o.mode2fSeen.includes(1)) return { ok: true, detail: `2 本指移動量 ${o.moveSum2}、スクロール判定あり` };
        const startMove = P('2f_scroll_start_move');
        if (o.moveSum2 < startMove) return { ok: false, detail: `2 本指移動量 ${o.moveSum2} < 2f_scroll_start_move=${startMove}`, suggest: [{ name: '2f_scroll_start_move', delta: -5 }] };
        return { ok: false, detail: `2 本指移動量 ${o.moveSum2} はあるがスクロール判定なし(scroll_x_enable / scroll_y_enable を確認)` };
      } },
    { label: () => 'wheel 報告あり(R8 / R6)', eval: (o) => (o.wheel.count > 0 ? { ok: true, detail: `wheel ${o.wheel.count} 回` } : { ok: false, detail: 'wheel 報告なし' }) },
    { label: () => 'ホストが wheel を受けた',
      eval: (o, P, st) => {
        if (!st[2].ok) return null;
        if (o.host.wheelCount > 0) return { ok: true, detail: `wheel ${o.host.wheelCount} 回` };
        return { ok: false, host: true, detail: `wheel がホストに届いていない${HOST_CHECK}` };
      } },
  ];

  const PINCH_STAGES = [
    { label: () => '指 2 本で接触', eval: (o) => fingersStage(o, 2) },
    { label: (P) => `距離変化が 2f_pinch_start_distance(${P('2f_pinch_start_distance')})を超えてピンチ判定(mode2f=2)`,
      eval: (o, P) => {
        if (o.mode2fSeen.includes(2)) return { ok: true, detail: `距離変化 ${o.distDelta}、ピンチ判定あり` };
        const startDist = P('2f_pinch_start_distance');
        if (o.distDelta < startDist) return { ok: false, detail: `距離変化 ${o.distDelta} < 2f_pinch_start_distance=${startDist}`, suggest: [{ name: '2f_pinch_start_distance', delta: -10 }] };
        return { ok: false, detail: `距離変化 ${o.distDelta} はあるがピンチ判定なし(2f_pinch_enable を確認)` };
      } },
    { label: () => 'BTN_7 押し(K279 1)', eval: (o, P, st) => (st[1].ok ? pressedStage(o, BTN[7], '') : null) },
  ];

  const STAGE_SPECS = {
    tap1: tapStages('1f', 1, BTN[0], 1, '左クリック'),
    tapdrag: TAPDRAG_STAGES,
    scroll2: SCROLL2_STAGES,
    tap2: tapStages('2f', 2, BTN[1], 2, '右クリック'),
    pinch: PINCH_STAGES,
    tap3: tapStages('3f', 3, BTN[2], 4, '中クリック'),
  };

  function judgeAttempt(kind, o, params) {
    const spec = STAGE_SPECS[kind];
    if (!spec) return null;
    const P = (name) => paramValue(params, name);
    const stages = [];
    let stop = false;
    for (const s of spec) {
      const st = { label: s.label(P), ok: null, detail: '', host: false, suggest: [] };
      if (o && !stop) {
        const r = s.eval(o, P, stages);
        if (r) {
          st.ok = r.ok;
          st.detail = r.detail || '';
          st.host = !!r.host;
          st.suggest = r.suggest || [];
          if (r.stop) stop = true;
        }
      }
      stages.push(st);
    }
    const failIndex = o ? stages.findIndex((s) => s.ok !== true) : -1;
    const fail = failIndex >= 0 ? stages[failIndex] : null;
    let verdict = 'none';
    if (o) verdict = !fail ? 'pass' : fail.host ? 'partial' : 'fail';
    return {
      kind, stages, verdict, failIndex,
      reason: fail ? `${fail.label}: ${fail.detail}` : '',
      suggest: fail ? fail.suggest : [],
    };
  }

  function describeState(frame) {
    if (!frame) return '待機';
    const hold = frame.hold ? (BTN_NAMES[frame.hold] || String(frame.hold)) : null;
    if (!frame.fingers) {
      if (frame.pending && hold) return `タップ後 2 回目の接触待ち(${hold}ボタン保持中)`;
      if (frame.pending) return 'タップ後 2 回目の接触待ち';
      if (hold) return `ボタン押下中(${hold})`;
      return '待機';
    }
    const moving = !!(frame.relX || frame.relY);
    if (frame.fingers >= 2 && frame.mode2f === 2) return 'ピンチ中';
    if (frame.fingers >= 2 && frame.mode2f === 1) return '2 本指 スクロール中';
    if (hold) return `ボタン押下中(${hold})` + (moving ? ' ドラッグ' : '');
    const n = frame.fingers === 1 ? '指 1 本' : `${frame.fingers} 本指`;
    return `${n} ${moving ? '移動中' : '接触中'}`;
  }


  const HOST_BIT_NAMES = { 1: '左', 2: '右', 4: '中' };

  function observationText(o) {
    const first = o.touches[0];
    if (!first) return '接触なし';
    const parts = [`指 ${o.fingersMax} 本`, `押下 ${first.downMs}ms`, `移動 ${first.moveSum}`];
    const second = o.touches[1];
    if (second) parts.push(`2 本目 間隔 ${o.gapMs}ms 移動 ${second.moveSum}`);
    if (o.mode2fSeen.includes(1)) parts.push(`スクロール判定 wheel ${o.wheel.count} 回`);
    if (o.mode2fSeen.includes(2)) parts.push(`ピンチ判定 距離変化 ${o.distDelta}`);
    if (o.buttonsPressed.length === 0) {
      parts.push('ボタン報告なし');
    } else {
      for (const code of o.buttonsPressed) {
        const label = BTN_NAMES[code] ? `(${BTN_NAMES[code]})` : '';
        parts.push(`ボタン ${code}${label} ` + (o.buttonsReleased.includes(code) ? '押→離' : '押(離しなし)'));
      }
    }
    return parts.join(' / ');
  }

  function hostText(o) {
    const parts = [];
    for (const bit of [1, 2, 4]) {
      if (o.host.down.includes(bit)) {
        parts.push(`${HOST_BIT_NAMES[bit]}クリック(` + (o.host.up.includes(bit) ? 'down→up)' : 'down のみ、up なし)'));
      }
    }
    if (o.host.moveCount > 0) parts.push(`移動 ${o.host.moveCount} 回`);
    if (o.host.wheelCount > 0) parts.push(`wheel ${o.host.wheelCount} 回`);
    return parts.length ? parts.join('、') : 'ホスト側の受信なし';
  }

  const api = {
    BTN, REL, BTN_NAMES, GESTURES, DEFAULT_PARAMS,
    stripAnsi, isPrompt, stripPromptPrefix, isEcho, parseListLine, parseInfoLine, parseTraceLine,
    clockOffset, toConfName, exportConf, detectDrops, detectStuckButton,
    detectMissingWheel, detectTwoFingerNoScroll,
    paramValue, stepParam, segmentAttempts, observeAttempt, inferKind, judgeAttempt, describeState,
    observationText, hostText,
  };
  root.TpTuner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
