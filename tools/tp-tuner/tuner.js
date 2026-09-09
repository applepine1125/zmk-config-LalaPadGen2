(function (root) {
  'use strict';

  const BTN = { 0: 0x110, 1: 0x111, 2: 0x112, 7: 0x117 };
  const REL = { X: 0, Y: 1, HWHEEL: 6, WHEEL: 8 };
  const CONF_PREFIX = 'CONFIG_INPUT_IQS9151_';
  const PAD_RES_X = 2457;
  const PAD_RES_Y = 3072;
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
  const TAP_KINDS = {
    tap1: { prefix: '1f', n: 1, code: BTN[0], bit: 1, label: '左' },
    tap2: { prefix: '2f', n: 2, code: BTN[1], bit: 2, label: '右' },
    tap3: { prefix: '3f', n: 3, code: BTN[2], bit: 4, label: '中' },
  };
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

  const KIND_LABELS = {
    tap1: '1 本指タップ', tapdrag: 'タップドラッグ', tap2: '2 本指タップ', scroll2: '2 本指スクロール',
    pinch: 'ピンチ', tap3: '3 本指タップ', move: 'カーソル移動', cursor: 'カーソル移動',
  };

  function kindLabel(kind) {
    return KIND_LABELS[kind] || '不明な操作';
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

  function mergeParams(paramsR, paramsL) {
    const R = paramsR || [];
    const L = paramsL || [];
    const byNameL = new Map(L.map((p) => [p.name, p]));
    const seen = new Set();
    const out = [];
    for (const pr of R) {
      const pl = byNameL.get(pr.name);
      seen.add(pr.name);
      out.push({
        name: pr.name, min: pr.min, max: pr.max, kind: pr.kind, def: pr.def,
        value: pr.value, valueR: pr.value, valueL: pl ? pl.value : null,
        differs: !!pl && pl.value !== pr.value,
      });
    }
    for (const pl of L) {
      if (seen.has(pl.name)) continue;
      out.push({
        name: pl.name, min: pl.min, max: pl.max, kind: pl.kind, def: pl.def,
        value: pl.value, valueR: null, valueL: pl.value, differs: false,
      });
    }
    return out;
  }

  function pendingCommands(pending, sides) {
    const list = sides && sides.length ? sides : ['R', 'L'];
    const common = (pending && pending.common) || {};
    const out = [];
    for (const s of list) {
      const perSide = (pending && pending[s]) || {};
      const names = new Set([...Object.keys(common), ...Object.keys(perSide)]);
      for (const name of names) {
        const value = Object.prototype.hasOwnProperty.call(perSide, name) ? perSide[name] : common[name];
        out.push({ side: s, cmd: `tp set ${name} ${value}` });
      }
    }
    return out;
  }

  function liveCommands(sides, rates, on) {
    const list = sides || [];
    const out = [];
    for (const s of list) {
      if (on) {
        const hz = (rates && rates[s]) || 60;
        out.push({ side: s, cmd: `tp live on ${hz}` });
      } else {
        out.push({ side: s, cmd: 'tp live off' });
      }
    }
    return out;
  }

  function padStateFromFrame(frame) {
    if (!frame || !frame.fingers) return { fingers: 0, state: frame && frame.hold ? 'ドラッグ中' : '待機', color: 'idle', dragging: !!(frame && frame.hold) };
    const dragging = !!frame.hold;
    if (frame.fingers === 1) return { fingers: 1, state: dragging ? 'ドラッグ中' : '1 本指', color: 'blue', dragging };
    if (frame.fingers === 2) {
      if (dragging) return { fingers: 2, state: 'ドラッグ中', color: 'green', dragging };
      if (frame.mode2f === 2) return { fingers: 2, state: 'ピンチ', color: 'orange', dragging };
      if (frame.mode2f === 1) return { fingers: 2, state: 'スクロール', color: 'green', dragging };
      return { fingers: 2, state: '2 本指', color: 'green', dragging };
    }
    return { fingers: frame.fingers, state: dragging ? 'ドラッグ中' : '3 本指', color: 'purple', dragging };
  }

  function frameToPadPoints(frame, w, h) {
    if (!frame || !frame.fingers) return [];
    const scale = (x, y) => ({ x: (x / PAD_RES_X) * w, y: (y / PAD_RES_Y) * h });
    const pts = [scale(frame.f1x || 0, frame.f1y || 0)];
    if (frame.fingers >= 2) pts.push(scale(frame.f2x || 0, frame.f2y || 0));
    return pts;
  }

  const api = {
    BTN, REL, BTN_NAMES, DEFAULT_PARAMS,
    stripAnsi, isPrompt, stripPromptPrefix, isEcho, parseListLine, parseInfoLine, parseTraceLine,
    splitSidePrefix, bleCommand, isEndMarker, orderDevices,
    clockOffset, pickPortOrder, toConfName, exportConf, detectDrops, detectStuckButton,
    detectMissingWheel, detectTwoFingerNoScroll,
    paramValue, segmentAttempts, observeAttempt, observationFromSummary, summaryHostWindow, cursorMetrics, inferKind, whyNot, describeState,
    observationText, hostText, sentText, recognitionText, kindLabel,
    mergeParams, pendingCommands, liveCommands, padStateFromFrame, frameToPadPoints,
  };
  root.TpTuner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
