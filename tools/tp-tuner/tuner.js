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
    const m = /^side=(central|peripheral) uptime_ms=(\d+) params=(\d+)(?: saved=(yes|no))?$/.exec(line.trim());
    if (!m) return null;
    return {
      side: m[1], uptimeMs: Number(m[2]), params: Number(m[3]),
      saved: m[4] === undefined ? null : m[4] === 'yes',
    };
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
    if (parts[1] === 'S' && parts.length === 19) {
      const n = parts.slice(2).map(Number);
      if (n.some(Number.isNaN)) return null;
      const [startMs, endMs, contacts, fingersMax, downMs, gapMs, moveSum, centroidMove, distDelta,
        mode2f, btnPressBits, btnReleaseBits, wheelCount, wheelSum, relCount, drops, hold] = n;
      return {
        type: 'S', startMs, endMs, contacts, fingersMax, downMs, gapMs, moveSum, centroidMove, distDelta,
        mode2f, btnPressBits, btnReleaseBits, wheelCount, wheelSum, relCount, drops, hold,
      };
    }
    return null;
  }

  function clockOffset(hostSentMs, hostRecvMs, uptimeMs) {
    return (hostSentMs + hostRecvMs) / 2 - uptimeMs;
  }

  function splitSidePrefix(line) {
    if (line.startsWith('R ')) return { side: 'R', rest: line.slice(2) };
    if (line.startsWith('L ')) return { side: 'L', rest: line.slice(2) };
    return null;
  }

  function bleCommand(side, cmd) {
    const rest = cmd.startsWith('tp ') ? cmd.slice(3) : cmd;
    return `${side} ${rest}`;
  }

  function isEndMarker(rest) {
    return rest === '.';
  }

  function orderDevices(devices) {
    if (!devices || !devices.length) return [];
    const ble = devices.filter((d) => d.kind === 'ble');
    const usb = devices.filter((d) => d.kind === 'usb');
    return ble.concat(usb);
  }

  function pickDevice(devices) {
    const ordered = orderDevices(devices);
    return ordered.length ? ordered[0] : null;
  }

  function pickPortOrder(ports, lastInfo) {
    if (!lastInfo || typeof lastInfo !== 'object') return ports.slice();
    const matches = (port) => {
      const info = port && typeof port.getInfo === 'function' ? port.getInfo() : port;
      return !!info && info.usbVendorId === lastInfo.usbVendorId && info.usbProductId === lastInfo.usbProductId;
    };
    const preferred = ports.filter(matches);
    const rest = ports.filter((p) => !matches(p));
    return preferred.concat(rest);
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

  function bitsToCodes(bits) {
    const out = [];
    for (let n = 0; n < 32; n++) {
      if (bits & (1 << n)) out.push(272 + n);
    }
    return out;
  }

  function hostObservationWindow(start, windowEnd, host, buttonsReleased) {
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
    return { down, up, moveCount, wheelCount, stuckBits };
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
    '2f_tap_max_ms': 250, '2f_tap_move': 50, '2f_tapdrag_gap_max_ms': 200,
    '2f_scroll_start_move': 15, '2f_pinch_start_distance': 30, '2f_pinch_ratio_x10': 15, '2f_pinch_wheel_gain_x10': 60,
    '3f_tap_max_ms': 200, '3f_tap_move': 35, '3f_tapdrag_gap_max_ms': 200, '3f_swipe_threshold': 200,
    cursor_inertia_enable: 0, cursor_inertia_decay: 950, cursor_inertia_min_avg_speed: 10,
    scroll_inertia_enable: 1, scroll_inertia_decay: 980, scroll_inertia_min_avg_speed: 10,
    dynamic_filter_bottom_speed: 30, dynamic_filter_top_speed: 511, dynamic_filter_bottom_beta: 20,
    cursor_report_interval_ms: 0, scroll_report_interval_ms: 0,
  };
  const GESTURES = [
    { kind: 'cursor', title: 'カーソル移動', instruction: '指 1 本でパッド上をゆっくり 1 往復、続けて速く 1 往復する', expect: 'カーソルが指に追従',
      params: [{ name: 'touch_set_threshold', step: 2 }, { name: 'finger_confidence_threshold', step: 2 }, { name: 'alp_set_debounce', step: 1 },
        { name: 'stationary_touch_mov_threshold', step: 1 }, { name: 'jitter_filter_delta', step: 1 }, { name: 'dynamic_filter_bottom_beta', step: 5 },
        { name: 'cursor_inertia_enable' }, { name: 'cursor_inertia_decay', step: 10 }, { name: 'cursor_inertia_min_avg_speed', step: 2 }] },
    { kind: 'tap1', title: '1本指タップ', instruction: '指 1 本で軽く 1 回叩く', expect: '左クリック',
      params: [{ name: '1f_tap_enable' }, { name: '1f_tap_max_ms', step: 50 }, { name: '1f_tap_move', step: 10 }, { name: '1f_tapdrag_gap_max_ms', step: 40 }] },
    { kind: 'tapdrag', title: 'タップドラッグ', instruction: '1 回叩いてすぐに触れ直し、そのまま動かしてから離す', expect: 'ドラッグ',
      params: [{ name: '1f_presshold_enable' }, { name: '1f_tapdrag_gap_max_ms', step: 40 }, { name: '1f_tap_max_ms', step: 50 }, { name: '1f_tap_move', step: 10 }] },
    { kind: 'scroll2', title: '2本指スクロール', instruction: '指 2 本を揃えて上下に動かす', expect: 'スクロール',
      params: [{ name: 'scroll_y_enable' }, { name: 'scroll_x_enable' }, { name: '2f_scroll_start_move', step: 5 },
        { name: 'scroll_inertia_enable' }, { name: 'scroll_inertia_decay', step: 10 }, { name: 'scroll_inertia_min_avg_speed', step: 2 }] },
    { kind: 'tap2', title: '2本指タップ', instruction: '指 2 本で同時に軽く叩く', expect: '右クリック',
      params: [{ name: '2f_tap_enable' }, { name: '2f_tap_max_ms', step: 50 }, { name: '2f_tap_move', step: 10 }, { name: '2f_tapdrag_gap_max_ms', step: 40 }] },
    { kind: 'pinch', title: 'ピンチ', instruction: '指 2 本の間隔を広げる / 狭める', expect: 'ピンチ(拡大縮小)',
      params: [{ name: '2f_pinch_enable' }, { name: '2f_pinch_start_distance', step: 10 }, { name: '2f_scroll_start_move', step: 5 }, { name: '2f_pinch_wheel_gain_x10', step: 5 }] },
    { kind: 'tap3', title: '3本指タップ', instruction: '指 3 本で同時に軽く叩く', expect: '中クリック',
      params: [{ name: '3f_tap_enable' }, { name: '3f_tap_max_ms', step: 50 }, { name: '3f_tap_move', step: 10 }, { name: '3f_tapdrag_gap_max_ms', step: 40 }] },
  ];
  const TAP_KINDS = {
    tap1: { prefix: '1f', n: 1, code: BTN[0], bit: 1, label: '左' },
    tap2: { prefix: '2f', n: 2, code: BTN[1], bit: 2, label: '右' },
    tap3: { prefix: '3f', n: 3, code: BTN[2], bit: 4, label: '中' },
  };
  const IC_PARAMS = new Set([
    'touch_set_threshold', 'touch_clear_threshold', 'alp_set_debounce', 'alp_clear_debounce',
    'stationary_touch_mov_threshold', 'jitter_filter_delta', 'finger_confidence_threshold',
    'active_mode_sampling_period_ms', 'idle_touch_mode_sampling_period_ms', 'idle_mode_sampling_period_ms',
    'lp1_mode_sampling_period_ms', 'lp2_mode_sampling_period_ms', 'active_mode_timeout_ms',
    'ati_targetcount', 'dynamic_filter_bottom_speed', 'dynamic_filter_top_speed', 'dynamic_filter_bottom_beta',
  ]);
  const INERTIA_MARGIN_MS = 15;

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

  function relTimes(events) {
    return new Set(events.filter((e) => e.kind === 'R' && (e.code === REL.X || e.code === REL.Y)).map((e) => e.t)).size;
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
    const relCount = relTimes(ev.filter((e) => e.t <= end + INERTIA_MARGIN_MS));
    const drops = ev.filter((e) => e.ret !== 0).length;

    const hostObs = hostObservationWindow(start, windowEnd, host, buttonsReleased);

    return {
      start, end, windowEnd, touches, fingersMax, touchMs: end - start,
      downMs: first ? first.downMs : 0, moveSum,
      gapMs: second ? second.start - first.end : null,
      moveSum2, distDelta, mode2fSeen, keys, buttonsPressed, buttonsReleased, wheel, relCount, drops,
      host: hostObs,
      cursor: cursorMetrics(attempt, fwEvents, host, { tailMs }),
    };
  }

  function touchesFromSummary(s, buttonsPressed) {
    if (s.contacts <= 0) return [];
    const t0 = {
      start: s.startMs, end: s.startMs + s.downMs, downMs: s.downMs,
      moveSum: s.contacts >= 2 ? 0 : s.moveSum, fingersMax: s.fingersMax, holds: [],
    };
    if (s.contacts < 2) return [t0];
    const gap = s.gapMs >= 0 ? s.gapMs : 0;
    const t1Start = t0.end + gap;
    const t1 = {
      start: t1Start, end: s.endMs, downMs: Math.max(0, s.endMs - t1Start),
      moveSum: s.moveSum, fingersMax: s.fingersMax, holds: s.hold ? buttonsPressed.slice() : [],
    };
    return [t0, t1];
  }

  function keysFromSummary(s, buttonsPressed, buttonsReleased) {
    const keys = [];
    for (const code of buttonsPressed) keys.push({ t: s.startMs, code, value: 1 });
    const releaseT = s.hold ? s.endMs : s.startMs + s.downMs;
    for (const code of buttonsReleased) keys.push({ t: releaseT, code, value: 0 });
    return keys;
  }

  function observationFromSummary(s, host, clockOffsetMs, opts) {
    const tailMs = (opts && opts.tailMs) || 500;
    const start = s.startMs + clockOffsetMs;
    const end = s.endMs + clockOffsetMs;
    const windowEnd = end + tailMs;
    const buttonsPressed = bitsToCodes(s.btnPressBits);
    const buttonsReleased = bitsToCodes(s.btnReleaseBits);
    const touches = touchesFromSummary(s, buttonsPressed);
    const keys = keysFromSummary(s, buttonsPressed, buttonsReleased);
    const mode2fSeen = s.mode2f > 0 ? [s.mode2f] : [];
    const wheel = { count: s.wheelCount, sum: s.wheelSum };
    const hostObs = hostObservationWindow(start, windowEnd, host, buttonsReleased);
    const hostMoves = ((host && host.move) || []).filter((m) => m.t >= start && m.t <= windowEnd);

    return {
      start, end, windowEnd, touches, fingersMax: s.fingersMax, touchMs: end - start,
      downMs: s.downMs, moveSum: s.moveSum,
      gapMs: touches.length > 1 ? touches[1].start - touches[0].end : null,
      moveSum2: s.centroidMove, distDelta: s.distDelta, mode2fSeen, keys, buttonsPressed, buttonsReleased,
      wheel, relCount: s.relCount, drops: s.drops,
      host: hostObs,
      // 要約には毎フレームの rel が含まれないため、動き出し遅延・フレーム間隔・微小動き割合・
      // 慣性は算出できない(0 / null で代替)。カーソルカードの精密な指標にはトレースが必要。
      // approx: true でこの限界を表示側(factsText 等)に伝える。
      cursor: {
        touchMs: end - start,
        startDelayMs: null,
        fwMove: s.moveSum,
        hostMove: hostMoves.reduce((sum, m) => sum + Math.abs(m.dx || 0) + Math.abs(m.dy || 0), 0),
        frameGapMs: 0,
        tinyRatio: 0,
        relCount: s.relCount,
        inertiaCount: 0,
        inertiaMs: 0,
        approx: true,
      },
    };
  }

  function summaryHostWindow(end, nextStart, now, tail) {
    const cap = nextStart === null || nextStart === undefined ? Infinity : nextStart - end;
    const tailMs = Math.max(0, Math.min(tail, cap));
    const ready = (Number.isFinite(cap) && cap <= tail) || now >= end + tail;
    return { ready, tailMs };
  }

  function cursorMetrics(attempt, fwEvents, host, opts) {
    const tailMs = (opts && opts.tailMs) || 500;
    const start = attempt.start;
    const end = attempt.end;
    const windowEnd = end + tailMs;
    const touching = attempt.frames.filter((f) => f.fingers > 0);
    const mag = (f) => Math.abs(f.relX || 0) + Math.abs(f.relY || 0);
    const firstMove = touching.find((f) => mag(f) > 0);
    let gapSum = 0;
    for (let i = 1; i < touching.length; i++) gapSum += touching[i].t - touching[i - 1].t;
    const tiny = touching.filter((f) => mag(f) > 0 && mag(f) <= 2).length;
    const rels = (fwEvents || []).filter((e) => e.type === 'E' && e.t >= start && e.t <= windowEnd);
    const inertia = rels.filter((e) => e.t > end + INERTIA_MARGIN_MS);
    const inertiaCount = relTimes(inertia);
    const moves = ((host && host.move) || []).filter((m) => m.t >= start && m.t <= windowEnd);
    return {
      touchMs: end - start,
      startDelayMs: firstMove ? firstMove.t - start : null,
      fwMove: touching.reduce((s, f) => s + mag(f), 0),
      hostMove: moves.reduce((s, m) => s + Math.abs(m.dx || 0) + Math.abs(m.dy || 0), 0),
      frameGapMs: touching.length > 1 ? Math.round((gapSum / (touching.length - 1)) * 10) / 10 : 0,
      tinyRatio: touching.length ? Math.round((tiny / touching.length) * 100) : 0,
      relCount: relTimes(rels) - inertiaCount,
      inertiaCount,
      inertiaMs: inertiaCount ? inertia[inertia.length - 1].t - end : 0,
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

  function atMost(label, actual, name, max, unit) {
    if (actual <= max) return { ok: true, detail: `${label} ${actual}${unit}` };
    return { ok: false, detail: `${label} ${actual}${unit} > ${name}=${max}` };
  }

  function pressedStage(o, code, hint) {
    if (o.buttonsPressed.includes(code)) return { ok: true, detail: `K${code} 1 の報告あり` };
    return { ok: false, detail: `K${code} 1 の報告なし` + (hint ? `(${hint})` : ''), hint };
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
      { label: (P) => `押下時間 ≤ ${maxMsName}(${P(maxMsName)}ms)`, eval: (o, P) => atMost('押下', o.touches[0].downMs, maxMsName, P(maxMsName), 'ms') },
      { label: (P) => `移動量 ≤ ${maxMoveName}(${P(maxMoveName)})`, eval: (o, P) => atMost('移動', o.touches[0].moveSum, maxMoveName, P(maxMoveName), '') },
      { label: () => `ドライバが${label}ボタンを押した(K${code} 1)`, fact: true,
        eval: (o, P, st) => pressedStage(o, code, st[1].ok && st[2].ok ? `${prefix}_tap_enable を確認` : '') },
      { label: () => `離した(K${code} 0)`, fact: true, eval: (o, P, st) => (st[3].ok ? releasedStage(o, code) : null) },
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
        if (t.downMs > P('1f_tap_max_ms')) bad.push(`押下 ${t.downMs}ms > 1f_tap_max_ms=${P('1f_tap_max_ms')}`);
        if (t.moveSum > P('1f_tap_move')) bad.push(`移動 ${t.moveSum} > 1f_tap_move=${P('1f_tap_move')}`);
        if (bad.length) return { ok: false, detail: bad.join('、') };
        return { ok: true, detail: `押下 ${t.downMs}ms 移動 ${t.moveSum}` };
      } },
    { label: () => 'ドライバが左ボタンを押した(K272 1)', fact: true, eval: (o, P, st) => pressedStage(o, BTN[0], st[0].ok ? '1f_tap_enable を確認' : '') },
    { label: (P) => `2 本目の接触が 1f_tapdrag_gap_max_ms(${P('1f_tapdrag_gap_max_ms')}ms)以内`,
      eval: (o, P) => {
        if (!o.touches[1]) return { ok: false, detail: '2 本目の接触なし' };
        return atMost('間隔', o.gapMs, '1f_tapdrag_gap_max_ms', P('1f_tapdrag_gap_max_ms'), 'ms');
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
    { label: () => '離したら左ボタン離し(K272 0)', fact: true,
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
        if (o.moveSum2 < startMove) return { ok: false, detail: `2 本指移動量 ${o.moveSum2} < 2f_scroll_start_move=${startMove}` };
        return { ok: false, detail: `2 本指移動量 ${o.moveSum2} はあるがスクロール判定なし(scroll_x_enable / scroll_y_enable を確認)` };
      } },
    { label: () => 'wheel 報告あり(R8 / R6)', fact: true,
      eval: (o) => (o.wheel.count > 0 ? { ok: true, detail: `wheel ${o.wheel.count} 回` } : { ok: false, detail: 'wheel 報告なし', hint: 'スクロール判定はあるが wheel 送信なし。scroll_x_enable / scroll_y_enable を確認' }) },
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
        if (o.distDelta < startDist) return { ok: false, detail: `距離変化 ${o.distDelta} < 2f_pinch_start_distance=${startDist}` };
        return { ok: false, detail: `距離変化 ${o.distDelta} はあるがピンチ判定なし(2f_pinch_enable を確認)` };
      } },
    { label: () => 'BTN_7 押し(K279 1)', fact: true, eval: (o, P, st) => (st[1].ok ? pressedStage(o, BTN[7], '') : null) },
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
      const st = { label: s.label(P), ok: null, detail: '', host: false, fact: !!s.fact, hint: '' };
      if (o && !stop) {
        const r = s.eval(o, P, stages);
        if (r) {
          st.ok = r.ok;
          st.detail = r.detail || '';
          st.host = !!r.host;
          st.hint = r.hint || '';
          if (r.stop) stop = true;
        }
      }
      stages.push(st);
    }
    return { kind, stages, failIndex: o ? stages.findIndex((s) => s.ok !== true) : -1 };
  }

  function whyNot(kind, o, params) {
    const r = judgeAttempt(kind, o, params);
    if (!r) return '';
    const causes = r.stages.filter((s) => s.ok === false && !s.host && !s.fact).map((s) => s.detail);
    if (causes.length) return causes.join('、');
    const fact = r.stages.find((s) => s.ok === false && s.fact);
    if (fact) return fact.hint || fact.detail;
    return '理由不明';
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
      const name = HOST_BIT_NAMES[bit];
      if (o.host.stuckBits.includes(bit) || (o.host.down.includes(bit) && !o.host.up.includes(bit))) parts.push(`${name}ボタン押されたまま`);
      else if (o.host.down.includes(bit)) parts.push(`${name}クリック 1 回`);
    }
    if (o.host.moveCount > 0) parts.push(`移動 ${o.host.moveCount} 回`);
    if (o.host.wheelCount > 0) parts.push(`wheel ${o.host.wheelCount} 回`);
    return parts.length ? parts.join('、') : '受信なし';
  }

  function sentText(o) {
    const parts = [];
    for (const code of o.buttonsPressed) {
      if (code === BTN[7]) parts.push('ピンチ(BTN_7) 1 回');
      else parts.push(o.buttonsReleased.includes(code) ? `${BTN_NAMES[code] || code}クリック 1 回` : `${BTN_NAMES[code] || code}ボタン押したまま`);
    }
    for (const code of o.buttonsReleased) {
      if (!o.buttonsPressed.includes(code)) parts.push(`${BTN_NAMES[code] || code}ボタン離し`);
    }
    if (o.wheel.count > 0) parts.push(`wheel ${o.wheel.count} 回`);
    if (o.relCount > 0) parts.push(`移動 ${o.relCount} 回`);
    return parts.length ? parts.join('、') + '送信' : '';
  }

  function factsText(kind, o) {
    const first = o.touches[0];
    const second = o.touches[1];
    const fingers = `指 ${o.fingersMax} 本`;
    if (kind === 'cursor') {
      const m = o.cursor;
      if (m.approx) {
        return `${fingers} / 接触 ${m.touchMs}ms / 移動量 ファーム ${m.fwMove}・ホスト ${m.hostMove}`
          + ' (要約のみ: 慣性・ふらつきの詳細はトレース ON で取得)';
      }
      const inertia = m.inertiaCount ? `慣性あり(${m.inertiaCount} 回 ${m.inertiaMs}ms)` : '慣性なし';
      return `${fingers} / 接触 ${m.touchMs}ms / 動き出し ${m.startDelayMs === null ? 'なし' : m.startDelayMs + 'ms'}`
        + ` / 移動量 ファーム ${m.fwMove}・ホスト ${m.hostMove} / フレーム間隔 ${m.frameGapMs}ms / 微小動き ${m.tinyRatio}% / ${inertia}`;
    }
    if (kind === 'scroll2') return `${fingers} / 接触 ${o.touchMs}ms / 2 本指移動 ${o.moveSum2}`;
    if (kind === 'pinch') return `${fingers} / 接触 ${o.touchMs}ms / 距離変化 ${o.distDelta}`;
    let text = `${fingers} / 押下 ${first.downMs}ms / 移動 ${first.moveSum}`;
    if (second) text += ` / 2 回目 間隔 ${o.gapMs}ms 移動 ${second.moveSum}`;
    return text;
  }

  function recognitionText(kind, o, params) {
    if (!o.touches.length) return '接触なし(指が認識されていません)';
    const sent = sentText(o);
    const why = () => whyNot(kind, o, params);
    let mid;
    if (TAP_KINDS[kind]) {
      const k = TAP_KINDS[kind];
      if (o.buttonsPressed.includes(k.code)) mid = `タップと認識 → ${sent}`;
      else mid = `${sent || 'ボタン報告なし'}(${why()})`;
    } else if (kind === 'tapdrag') {
      const second = o.touches[1];
      if (second && second.holds.includes(BTN[0])) {
        mid = 'タップドラッグと認識 → 左ボタン押し→保持' + (o.buttonsReleased.includes(BTN[0]) ? '→離し送信' : '(離しなし)');
      } else if (o.buttonsPressed.includes(BTN[0])) {
        mid = `ドラッグにならず${sent}(${why()})`;
      } else {
        mid = `${sent || 'ボタン報告なし'}(${why()})`;
      }
    } else if (kind === 'scroll2') {
      mid = o.mode2fSeen.includes(1) ? `スクロールと認識 → ${sent || 'wheel 送信なし'}` : `スクロール判定なし${sent ? ' → ' + sent : ''}(${why()})`;
    } else if (kind === 'pinch') {
      mid = o.mode2fSeen.includes(2) ? `ピンチと認識 → ${sent || 'BTN_7 送信なし'}` : `ピンチ判定なし${sent ? ' → ' + sent : ''}(${why()})`;
    } else {
      mid = sent || '移動報告なし';
    }
    const h = hostText(o);
    const host = kind === 'pinch' ? 'ホスト受信は判定対象外' : h === '受信なし' ? 'ホスト受信なし' : `ホストで${/^[\x20-\x7e]/.test(h) ? ' ' : ''}${h}受信`;
    return `${factsText(kind, o)} → ${mid} → ${host}`;
  }

  const TAP_FEEDBACK = [
    { id: 'ok', label: '体感どおり' },
    { id: 'none', label: '反応しなかった' },
    { id: 'wrong', label: '意図と違う動作になった', sub: [
      { id: 'wrong:drag', label: 'ドラッグになった' },
      { id: 'wrong:other', label: '別のボタンになった' },
      { id: 'wrong:cursor', label: 'カーソルが動いた' },
      { id: 'wrong:double', label: '2 回クリックになった' },
    ] },
    { id: 'slow', label: '反応が鈍い・遅い' },
    { id: 'sensitive', label: '敏感すぎる(触れただけでクリック)' },
  ];
  const FEEDBACK = {
    tap1: TAP_FEEDBACK, tap2: TAP_FEEDBACK, tap3: TAP_FEEDBACK,
    tapdrag: [
      { id: 'ok', label: '体感どおり' },
      { id: 'nodrag', label: 'ドラッグに入らなかった' },
      { id: 'stuck', label: 'ドラッグが終わらない(掴んだまま)' },
      { id: 'slowclick', label: 'シングルクリックの確定が遅い' },
    ],
    scroll2: [
      { id: 'ok', label: '体感どおり' },
      { id: 'none', label: 'スクロールしなかった' },
      { id: 'heavy', label: '動き出しが遅い / 重い' },
      { id: 'fast', label: '速すぎる' },
      { id: 'slow', label: '遅すぎる' },
      { id: 'inertia_more', label: '離した後に滑りすぎる' },
      { id: 'inertia_less', label: '離した後に滑らない' },
      { id: 'diagonal', label: '斜めに暴れる' },
      { id: 'pinch', label: 'ピンチになってしまう' },
      { id: 'lag', label: 'だんだん遅くなる・引っかかる' },
    ],
    pinch: [
      { id: 'ok', label: '体感どおり' },
      { id: 'none', label: 'ピンチにならない' },
      { id: 'scroll', label: 'スクロールになってしまう' },
      { id: 'sensitive', label: '敏感すぎる' },
    ],
    cursor: [
      { id: 'ok', label: '体感どおり' },
      { id: 'start_slow', label: '動き出しが遅い' },
      { id: 'light_miss', label: '軽いタッチを拾わない' },
      { id: 'jitter', label: '震える・ふらつく' },
      { id: 'jump', label: '飛ぶ' },
      { id: 'fast', label: '速すぎる' },
      { id: 'slow', label: '遅すぎる' },
      { id: 'inertia_more', label: '離した後に滑る(滑りすぎ)' },
      { id: 'inertia_less', label: '離した後に滑らない' },
      { id: 'lag', label: '遅れて動く・だんだん遅くなる' },
    ],
  };

  function feedbackOptions(kind) {
    return FEEDBACK[kind] || [];
  }

  const SIDE = {
    touch_down: '軽いタッチを拾うが誤反応も増える',
    touch_up: '軽いタッチを拾わなくなる',
    battery: '電池を使う',
  };

  function suggestFor(kind, feedback, o, params) {
    const P = (name) => paramValue(params, name);
    const out = { suggestions: [], notes: [] };
    const note = (text) => { out.notes.push(text); };
    const add = (name, delta, reason, side) => {
      const from = P(name);
      let to = typeof from === 'number' ? from + delta : null;
      if (Array.isArray(params)) {
        const p = params.find((x) => x.name === name);
        if (p) to = stepParam(p, delta);
      }
      if (typeof from === 'number' && to === from) {
        note(`${name} は既に${delta > 0 ? '上限' : '下限'} ${from} のため動かせません`);
        return;
      }
      out.suggestions.push({ name, delta, from: typeof from === 'number' ? from : null, to, reason, side, ic: IC_PARAMS.has(name) });
    };
    const lowerIc = (reason) => {
      add('touch_set_threshold', -2, reason, SIDE.touch_down);
      add('finger_confidence_threshold', -2, reason, SIDE.touch_down);
    };
    const raiseIc = (reason) => {
      add('touch_set_threshold', 2, reason, SIDE.touch_up);
      add('finger_confidence_threshold', 2, reason, SIDE.touch_up);
    };
    const transport = (what) => {
      note(`ドライバは${what}を送信したがホストが受信していない(伝送で落ちている)。`
        + (o.drops ? `ret≠0 が ${o.drops} 件: input キューが詰まっている` : 'ret≠0 はなし。BLE なら接続間隔の問題の可能性。USB 出力とテストモード(カーソル固定)も確認'));
    };
    const fingersMismatch = (n) => {
      if (o.fingersMax === n) return false;
      if (o.fingersMax < n) {
        note(`指 ${o.fingersMax} 本と認識されています(期待 ${n} 本)。指の間隔を広げて同時に置く`);
        add('finger_confidence_threshold', -2, `指が ${n} 本認識されていない(認識 ${o.fingersMax} 本)`, SIDE.touch_down);
      } else {
        note(`指 ${o.fingersMax} 本と認識されています(期待 ${n} 本)`);
        add('finger_confidence_threshold', 2, `指 ${o.fingersMax} 本と認識された(期待 ${n} 本)`, SIDE.touch_up);
      }
      return true;
    };
    const first = o.touches[0];
    const second = o.touches[1];
    const tap = TAP_KINDS[kind] || TAP_KINDS.tap1;
    const pf = tap.prefix;
    const maxMs = P(`${pf}_tap_max_ms`);
    const maxMove = P(`${pf}_tap_move`);
    const gap = P(`${pf}_tapdrag_gap_max_ms`);
    const tapConditionFails = () => {
      let bad = false;
      if (first.downMs > maxMs) {
        add(`${pf}_tap_max_ms`, 50, `押下 ${first.downMs}ms が上限 ${maxMs}ms を超えた`, '短い押し込みもクリックになる');
        bad = true;
      }
      if (first.moveSum > maxMove) {
        add(`${pf}_tap_move`, 10, `移動 ${first.moveSum} が上限 ${maxMove} を超えた`, '指がぶれてもタップ扱いになり、カーソル移動の始まりが遅れる');
        bad = true;
      }
      return bad;
    };
    const keymapSpeed = (what, scaler, key) =>
      note(`${what}はキーマップの ${scaler} で決まり(ビルドが必要)、ここでは変えられない。システムレイヤー(レイヤー 1+2 同時押し)の ${key} で実行時に段階調整できる`);
    const reportLag = (name) => {
      const cur = P(name);
      add(name, cur === 0 ? 16 : 8, 'BLE 経路の送信が追いつかず溜まっている(右手を USB にすると消える症状)', '最大その ms だけ遅れる');
    };

    if (feedback === 'ok') {
      note('体感どおり。このまま次の操作へ進むか、別のカードを試してください');
      return out;
    }

    if (TAP_KINDS[kind]) {
      const { n, code, bit, label } = tap;
      if (feedback === 'none') {
        if (!first) lowerIc('指が認識されていない(接触フレームなし)');
        else if (!fingersMismatch(n) && !tapConditionFails()) {
          if (!o.buttonsPressed.includes(code)) note(`押下 ${first.downMs}ms・移動 ${first.moveSum} は条件内なのにボタン報告なし。${pf}_tap_enable を確認`);
          else if (!o.host.down.includes(bit)) transport(`${label}クリック`);
          else note(`ドライバもホストも${label}クリックを処理しています。OS 側の設定(クリック速度・カーソル位置)を確認`);
        }
      } else if (feedback === 'wrong:drag') {
        if (second && o.gapMs <= gap) {
          add(`${pf}_tapdrag_gap_max_ms`, -40, `2 回目の接触が ${o.gapMs}ms 後で待ち時間 ${gap}ms 内に入りドラッグに移行した`, '素早いダブルタップからのドラッグに入りにくくなる');
        } else if (first && o.host.stuckBits.includes(bit)) {
          transport(`${label}ボタンの離し`);
        }
      } else if (feedback === 'wrong:other') {
        if (first && !fingersMismatch(n)) note(`指本数は ${n} 本と認識され、送信は「${sentText(o) || 'なし'}」。パラメータでは絞れないので指の置き方(同時に置く・同時に離す)を確認`);
      } else if (feedback === 'wrong:cursor') {
        if (first && !tapConditionFails()) note(`押下 ${first.downMs}ms・移動 ${first.moveSum} はタップ条件内。移動として送られたなら内訳の移動報告を確認`);
      } else if (feedback === 'wrong:double') {
        note(`タップ後 ${pf}_tapdrag_gap_max_ms(${gap}ms)の間クリックを保留し、2 回目の接触がなければ 1 回のクリックとして確定する仕様。2 回叩けば 2 回クリックになるので、ダブルクリックが意図なら正常。1 回のつもりなら内訳の接触回数を確認`);
      } else if (feedback === 'slow') {
        add(`${pf}_tapdrag_gap_max_ms`, -40, `シングルクリックはタップ後 ${gap}ms 待ってから確定する`, 'ゆっくりのダブルタップがドラッグに入らなくなる');
      } else if (feedback === 'sensitive') {
        raiseIc('触れただけでクリックになる');
      }
    } else if (kind === 'tapdrag') {
      if (feedback === 'nodrag') {
        if (!first) lowerIc('指が認識されていない(接触フレームなし)');
        else if (!fingersMismatch(1) && !tapConditionFails()) {
          if (!o.buttonsPressed.includes(BTN[0])) note(`1 回目の押下 ${first.downMs}ms・移動 ${first.moveSum} は条件内なのにボタン報告なし。1f_tap_enable を確認`);
          else if (!second) note(`2 回目の接触が観測されていない。1 回目を離してから ${gap}ms 以内に触れ直す(試行は 0.4 秒空くと閉じる)`);
          else if (o.gapMs > gap) add('1f_tapdrag_gap_max_ms', 40, `2 回目の接触が ${o.gapMs}ms 後で待ち時間 ${gap}ms を超えた`, 'シングルクリックの確定が遅れる');
          else if (!second.holds.includes(BTN[0])) note(`2 回目の接触(間隔 ${o.gapMs}ms)中に左ボタンが保持されていない(hold=272 なし)。1f_presshold_enable を確認`);
          else if (second.moveSum === 0) note('保持中に移動がない。触れ直した指をそのまま動かす');
          else if (!o.host.down.includes(1) || o.host.moveCount === 0) transport('左ボタン押しと移動');
          else note('ツール上ではドラッグが成立しホストまで届いています。OS 側のドラッグ設定を確認');
        }
      } else if (feedback === 'stuck') {
        const stuck = o.host.stuckBits.includes(1) || (o.host.down.includes(1) && !o.host.up.includes(1));
        if (!o.buttonsReleased.includes(BTN[0])) note('ドライバが左ボタンを離していない。ドライバ側の不具合の可能性。シリアルログを保存して報告');
        else if (stuck) note(`ドライバは左ボタンを離したがホストは押したまま。伝送で離しが落ちている(${o.drops ? `ret≠0 が ${o.drops} 件: input キュー詰まり` : 'ret≠0 はなし。BLE の接続間隔かホスト側の取りこぼし'})`);
        else note('ツール上ではホストで離しを受信しています。OS 側の状態を確認');
      } else if (feedback === 'slowclick') {
        add('1f_tapdrag_gap_max_ms', -40, `シングルクリックはタップ後 ${gap}ms 待ってから確定する`, 'ゆっくりのダブルタップがドラッグに入らなくなる');
      }
    } else if (kind === 'scroll2') {
      const startMove = P('2f_scroll_start_move');
      if (feedback === 'none') {
        if (!first) lowerIc('指が認識されていない(接触フレームなし)');
        else if (o.fingersMax < 2) {
          note(`指 ${o.fingersMax} 本しか認識されていない。指の間隔を広げて同時に置く`);
          add('finger_confidence_threshold', -2, `2 本目の指が認識されていない(認識 ${o.fingersMax} 本)`, SIDE.touch_down);
        } else if (!o.mode2fSeen.includes(1)) {
          if (o.moveSum2 < startMove) add('2f_scroll_start_move', -5, `2 本指移動 ${o.moveSum2} が開始値 ${startMove} に届いていない`, '2 本指タップがスクロール扱いになりやすい');
          else note(`2 本指移動 ${o.moveSum2} はあるがスクロール判定なし。scroll_x_enable / scroll_y_enable を確認`);
        } else if (o.wheel.count === 0) note('スクロール判定はあるが wheel 送信なし。scroll_x_enable / scroll_y_enable と移動方向を確認');
        else if (o.host.wheelCount === 0) transport(`wheel ${o.wheel.count} 回`);
        else note('ツール上では wheel がホストまで届いています。カーソル位置(スクロール対象)を確認');
      } else if (feedback === 'heavy') {
        add('2f_scroll_start_move', -5, `スクロール開始まで 2 本指移動 ${startMove} が必要(今回 ${o.moveSum2})`, '2 本指タップがスクロール扱いになりやすい');
      } else if (feedback === 'fast' || feedback === 'slow') {
        keymapSpeed('スクロール速度', 'zip_vertical_scroll_scaler と zip_scroll_accel', 'ZDS_SC INC/DEC');
      } else if (feedback === 'inertia_more') {
        if (P('scroll_inertia_enable') === 0) note('スクロール慣性は OFF(scroll_inertia_enable=0)。滑るのは OS 側の慣性');
        else {
          add('scroll_inertia_decay', -10, '離した後の wheel 継続を短くする', '止めたいときの止まりは良くなるが滑りは短い');
          add('scroll_inertia_min_avg_speed', 2, '速く離したときだけ慣性を出す', 'ゆっくり離したときは滑らない');
        }
      } else if (feedback === 'inertia_less') {
        if (P('scroll_inertia_enable') === 0) add('scroll_inertia_enable', 1, 'スクロール慣性が OFF', '離した後も wheel が続く');
        else {
          add('scroll_inertia_decay', 10, '離した後の wheel 継続を長くする', '止めたいところで行き過ぎる');
          add('scroll_inertia_min_avg_speed', -2, 'ゆっくり離しても慣性を出す', '意図しない滑りが増える');
        }
      } else if (feedback === 'diagonal') {
        note('斜め移動の縦横固定はキーマップの zip_scroll_snap(ビルドが必要)で決まり、ここでは変えられない');
      } else if (feedback === 'pinch') {
        add('2f_pinch_ratio_x10', 5, `スクロール中の指の間隔変化(距離変化 ${o.distDelta}、重心移動 ${o.moveSum2})が比率を超えてピンチと判定された`, 'ピンチになりにくくなる(小さなピンチが効かなくなる)');
      } else if (feedback === 'lag') {
        reportLag('scroll_report_interval_ms');
      }
    } else if (kind === 'pinch') {
      const startDist = P('2f_pinch_start_distance');
      const startMove = P('2f_scroll_start_move');
      const scrollWon = () => {
        const ratioNow = P('2f_pinch_ratio_x10');
        const ratioReason = o.moveSum2 > 0
          ? `距離変化 ${o.distDelta} が重心移動 ${o.moveSum2} の ${(o.distDelta * 10 / o.moveSum2).toFixed(1)} 倍までしかなく、比率 ${ratioNow}(×0.1)に届かなかった`
          : `距離変化 ${o.distDelta} に対して重心移動がほぼなく、比率 ${ratioNow}(×0.1)を満たせなかった`;
        add('2f_pinch_ratio_x10', -3, ratioReason, 'スクロールがピンチに化けやすい');
        add('2f_scroll_start_move', 5, `2 本指移動 ${o.moveSum2} が先にスクロール開始 ${startMove} に達した(距離変化 ${o.distDelta}、ピンチ開始 ${startDist})`, '軽い 2 本指移動でスクロールが始まりにくくなる');
        add('2f_pinch_start_distance', -10, `距離変化 ${o.distDelta} がピンチ開始 ${startDist} より先に達するようにする`, 'スクロールがピンチに化けやすい');
      };
      if (feedback === 'none') {
        if (!first) lowerIc('指が認識されていない(接触フレームなし)');
        else if (o.fingersMax < 2) {
          note(`指 ${o.fingersMax} 本しか認識されていない。指の間隔を広げて同時に置く`);
          add('finger_confidence_threshold', -2, `2 本目の指が認識されていない(認識 ${o.fingersMax} 本)`, SIDE.touch_down);
        } else if (o.mode2fSeen.includes(1)) scrollWon();
        else if (o.distDelta < startDist) add('2f_pinch_start_distance', -10, `距離変化 ${o.distDelta} が開始値 ${startDist} に届いていない`, 'スクロールがピンチに化けやすい');
        else note(`距離変化 ${o.distDelta} はあるがピンチ判定なし。2f_pinch_enable を確認`);
      } else if (feedback === 'scroll') {
        scrollWon();
      } else if (feedback === 'sensitive') {
        add('2f_pinch_start_distance', 10, `距離変化 ${o.distDelta} でピンチに入った`, '小さなピンチが効かなくなる');
      }
    } else if (kind === 'cursor') {
      const m = o.cursor;
      if (feedback === 'start_slow') {
        const delay = m.startDelayMs === null ? '動き出しなし' : `動き出し遅延 ${m.startDelayMs}ms`;
        add('alp_set_debounce', -1, `${delay}。低消費電力モードからの復帰を速くする`, '誤起動が増える');
        add('stationary_touch_mov_threshold', -1, `${delay}。小さな動きも静止扱いにしない`, '静止時のふらつきを拾いやすくなる');
        add('idle_mode_sampling_period_ms', -10, `${delay}。待機中の周期を短くする`, SIDE.battery);
        add('lp1_mode_sampling_period_ms', -10, `${delay}。省電力中の周期を短くする`, SIDE.battery);
      } else if (feedback === 'light_miss') {
        lowerIc(`軽いタッチが拾われない(移動量 ファーム ${m.fwMove})`);
        note('Re-ATI は不要(ati_targetcount を変えた場合のみ必要)');
      } else if (feedback === 'jitter') {
        const ratio = `微小動き(|rel|≤2)の割合 ${m.tinyRatio}%`;
        add('jitter_filter_delta', 1, `${ratio}。細かな震えを消す`, '細かい動きも消える');
        add('stationary_touch_mov_threshold', 1, `${ratio}。小さなふらつきを静止扱いにする`, '動き出しが少し鈍る');
        add('dynamic_filter_bottom_beta', 5, `${ratio}。低速時の平滑化を強める`, '低速時の遅れが増える');
      } else if (feedback === 'jump') {
        add('finger_confidence_threshold', 2, '指の誤検出で座標が飛ぶ', SIDE.touch_up);
        add('touch_set_threshold', 2, '弱いタッチが混ざって座標が飛ぶ', SIDE.touch_up);
      } else if (feedback === 'fast' || feedback === 'slow') {
        keymapSpeed('ポインタ速度', 'zip_xy_scaler', 'ZDS_XY INC/DEC');
        if (feedback === 'fast') add('dynamic_filter_bottom_speed', -5, '低速時の追従を抑えて細かい操作をしやすくする', '低速の滑らかさが変わる');
        else add('dynamic_filter_bottom_speed', 5, '低速時の追従を上げる', '低速の滑らかさが変わる');
      } else if (feedback === 'inertia_more') {
        if (P('cursor_inertia_enable') === 0) note('カーソル慣性は OFF(cursor_inertia_enable=0)。滑るのは OS 側の設定');
        else {
          add('cursor_inertia_decay', -10, `離した後の移動継続 ${m.inertiaCount} 回 ${m.inertiaMs}ms を短くする`, '滑りが短くなる');
          add('cursor_inertia_min_avg_speed', 2, '速く離したときだけ慣性を出す', 'ゆっくり離したときは滑らない');
        }
      } else if (feedback === 'inertia_less') {
        if (P('cursor_inertia_enable') === 0) add('cursor_inertia_enable', 1, 'カーソル慣性が OFF', '離した後もカーソルが滑る');
        else {
          add('cursor_inertia_decay', 10, `離した後の移動継続 ${m.inertiaCount} 回 ${m.inertiaMs}ms を長くする`, '止めたいところで行き過ぎる');
          add('cursor_inertia_min_avg_speed', -2, 'ゆっくり離しても慣性を出す', '意図しない滑りが増える');
        }
      } else if (feedback === 'lag') {
        reportLag('cursor_report_interval_ms');
      }
    }

    if (!out.suggestions.length && !out.notes.length) note('観測からは原因を絞れません。内訳を見て手動で調整してください');
    if (out.suggestions.some((s) => s.ic)) note('IC 系は次にパッドへ触れたときに反映されます');
    return out;
  }

  const api = {
    BTN, REL, BTN_NAMES, GESTURES, DEFAULT_PARAMS,
    stripAnsi, isPrompt, stripPromptPrefix, isEcho, parseListLine, parseInfoLine, parseTraceLine,
    splitSidePrefix, bleCommand, isEndMarker, orderDevices, pickDevice,
    clockOffset, pickPortOrder, toConfName, exportConf, detectDrops, detectStuckButton,
    detectMissingWheel, detectTwoFingerNoScroll,
    paramValue, stepParam, segmentAttempts, observeAttempt, observationFromSummary, summaryHostWindow, cursorMetrics, inferKind, judgeAttempt, whyNot, describeState,
    observationText, hostText, sentText, recognitionText, feedbackOptions, suggestFor,
  };
  root.TpTuner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
