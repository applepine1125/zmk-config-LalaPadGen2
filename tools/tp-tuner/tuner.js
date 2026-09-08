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

  function describeAttempt(attempt, fwEvents, host, params, opts) {
    const tailMs = (opts && opts.tailMs) || 500;
    const P = (name) => paramValue(params, name);
    const start = attempt.start;
    const end = attempt.end;
    const windowEnd = end + tailMs;
    const touches = touchRuns(attempt.frames).map((r) => ({
      start: r.start, end: r.end, downMs: r.downMs, moveSum: r.moveSum, fingersMax: r.fingersMax, frames: r.frames,
    }));
    const first = touches[0];
    const second = touches[1];
    const last = touches[touches.length - 1];
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
    const keys = ev.filter((e) => e.kind === 'K');
    const buttonsPressed = [...new Set(keys.filter((k) => k.value !== 0).map((k) => k.code))];
    const buttonsReleased = [...new Set(keys.filter((k) => k.value === 0).map((k) => k.code))];
    const wheels = ev.filter((e) => e.kind === 'R' && (e.code === REL.WHEEL || e.code === REL.HWHEEL));
    const wheel = { count: wheels.length, sum: wheels.reduce((s, w) => s + w.value, 0) };

    const hostBtn = (host && host.btn) || [];
    const hostDown = [];
    const hostUp = [];
    let prev = hostButtonsAt(hostBtn, start);
    for (const s of hostBtn) {
      if (s.t <= start || s.t > windowEnd) continue;
      for (const bit of [1, 2, 4]) {
        if ((s.buttons & bit) && !(prev & bit) && !hostDown.includes(bit)) hostDown.push(bit);
        if (!(s.buttons & bit) && (prev & bit) && !hostUp.includes(bit)) hostUp.push(bit);
      }
      prev = s.buttons;
    }
    const inWindow = (x) => x.t >= start && x.t <= windowEnd;
    const hostMoveCount = ((host && host.move) || []).filter(inWindow).length;
    const hostWheelCount = ((host && host.wheel) || []).filter(inWindow).length;
    const hostAtEnd = hostButtonsAt(hostBtn, windowEnd);
    const stuckBits = buttonsReleased.map(hostBitForCode).filter((bit) => bit && (hostAtEnd & bit));

    let kind = 'unknown';
    if (!first) {
      kind = 'unknown';
    } else if (fingersMax >= 3) {
      kind = buttonsPressed.includes(BTN[2]) || first.moveSum <= 2 * P('3f_tap_move') ? 'tap3' : 'move';
    } else if (fingersMax === 2) {
      if (mode2fSeen.includes(2)) kind = 'pinch';
      else if (mode2fSeen.includes(1) || wheel.count > 0) kind = 'scroll2';
      else if (buttonsPressed.includes(BTN[1])) kind = 'tap2';
      else if (distDelta > 0 && distDelta >= moveSum2) kind = 'pinch';
      else if (first.downMs > P('2f_tap_max_ms') || first.moveSum > P('2f_tap_move')) kind = 'scroll2';
      else kind = 'tap2';
    } else if (second && second.moveSum > P('1f_tap_move')) {
      kind = 'tapdrag';
    } else if (buttonsPressed.includes(BTN[0]) || first.moveSum <= 2 * P('1f_tap_move')) {
      kind = 'tap1';
    } else {
      kind = 'move';
    }

    const reasons = [];
    const suggest = [];
    let verdict = 'fail';

    const tapFailReasons = (prefix, tch) => {
      const maxMs = P(prefix + '_tap_max_ms');
      const maxMove = P(prefix + '_tap_move');
      if (tch.downMs > maxMs) {
        reasons.push(`押下 ${tch.downMs}ms > ${prefix}_tap_max_ms=${maxMs}`);
        suggest.push({ name: prefix + '_tap_max_ms', delta: 50 });
      }
      if (tch.moveSum > maxMove) {
        reasons.push(`移動 ${tch.moveSum} > ${prefix}_tap_move=${maxMove}`);
        suggest.push({ name: prefix + '_tap_move', delta: 10 });
      }
      if (reasons.length === 0) {
        reasons.push(`押下 ${tch.downMs}ms・移動 ${tch.moveSum} は範囲内だがボタン報告なし(${prefix}_tap_enable を確認)`);
      }
    };
    const judgeTap = (prefix, code, bit) => {
      const label = BTN_NAMES[code];
      if (!buttonsPressed.includes(code)) { tapFailReasons(prefix, first); return 'fail'; }
      if (!buttonsReleased.includes(code)) { reasons.push(`ドライバが${label}ボタンを離していない`); return 'fail'; }
      if (stuckBits.includes(bit)) { reasons.push(`ホストで${label}ボタンが押されたまま(タップ後ドラッグ残り)`); return 'fail'; }
      if (!hostDown.includes(bit) || !hostUp.includes(bit)) {
        reasons.push(`ホスト側で${label}ボタンが観測されていない(テストモード中か・出力先が USB か確認)`);
        return 'partial';
      }
      return 'pass';
    };

    let gapMs = null;
    if (kind === 'tap1') verdict = judgeTap('1f', BTN[0], 1);
    else if (kind === 'tap2') verdict = judgeTap('2f', BTN[1], 2);
    else if (kind === 'tap3') verdict = judgeTap('3f', BTN[2], 4);
    else if (kind === 'tapdrag') {
      const gapMax = P('1f_tapdrag_gap_max_ms');
      gapMs = second.start - first.end;
      const press = keys.find((k) => k.code === BTN[0] && k.value !== 0);
      const releasedBefore2 = keys.find((k) => k.code === BTN[0] && k.value === 0 && k.t < second.start);
      const holdIn2 = second.frames.some((f) => f.hold === BTN[0]);
      const releasedAfter = keys.find((k) => k.code === BTN[0] && k.value === 0 && k.t >= last.end - 30);
      if (!press) {
        tapFailReasons('1f', first);
      } else if (releasedBefore2) {
        if (gapMs > gapMax) {
          reasons.push(`2 回目の接触が 1f_tapdrag_gap_max_ms=${gapMax} より遅い(実測 ${gapMs}ms)`);
          suggest.push({ name: '1f_tapdrag_gap_max_ms', delta: 40 });
        } else {
          reasons.push(`2 回目の接触前(実測 gap ${gapMs}ms)にドライバが左ボタンを離した`);
        }
      } else if (!holdIn2) {
        reasons.push('2 回目の接触中にボタン保持(hold=272)が見られない');
      } else if (!releasedAfter) {
        reasons.push('ドラッグ終了後もドライバが左ボタンを離していない');
      } else if (stuckBits.includes(1)) {
        reasons.push('ホストで左ボタンが押されたまま(タップ後ドラッグ残り)');
      } else if (!hostDown.includes(1) || hostMoveCount === 0 || !hostUp.includes(1)) {
        reasons.push('ホスト側で down→move→up が揃っていない(テストモード中か・出力先が USB か確認)');
        verdict = 'partial';
      } else {
        verdict = 'pass';
      }
    } else if (kind === 'scroll2') {
      if (!mode2fSeen.includes(1)) {
        const startMove = P('2f_scroll_start_move');
        if (moveSum2 < startMove) {
          reasons.push(`2 本指移動量 ${moveSum2} < 2f_scroll_start_move=${startMove}`);
          suggest.push({ name: '2f_scroll_start_move', delta: -5 });
        } else {
          reasons.push(`2 本指移動量 ${moveSum2} はあるがスクロール判定なし(scroll_x_enable / scroll_y_enable を確認)`);
        }
      } else if (wheel.count === 0) {
        reasons.push('スクロール判定はあるが wheel 報告なし');
      } else if (hostWheelCount === 0) {
        reasons.push('wheel がホストに届いていない');
      } else {
        verdict = 'pass';
      }
    } else if (kind === 'pinch') {
      if (!mode2fSeen.includes(2)) {
        const startDist = P('2f_pinch_start_distance');
        if (distDelta < startDist) {
          reasons.push(`距離変化 ${distDelta} < 2f_pinch_start_distance=${startDist}`);
          suggest.push({ name: '2f_pinch_start_distance', delta: -10 });
        } else {
          reasons.push(`距離変化 ${distDelta} はあるがピンチ判定なし(2f_pinch_enable を確認)`);
        }
      } else if (!buttonsPressed.includes(BTN[7])) {
        reasons.push('ピンチ判定はあるが BTN_7(279) の報告なし');
        verdict = 'partial';
      } else {
        verdict = 'pass';
      }
    } else {
      verdict = 'partial';
    }

    return {
      kind,
      start,
      end,
      touches: touches.map((t) => ({ start: t.start, end: t.end, downMs: t.downMs, moveSum: t.moveSum })),
      fw: {
        fingersMax, downMs: first ? first.downMs : 0, moveSum, gapMs, distDelta,
        buttonsPressed, buttonsReleased, wheel, mode2fSeen, stuck: stuckBits.length > 0,
      },
      host: { down: hostDown, up: hostUp, moveCount: hostMoveCount, wheelCount: hostWheelCount },
      verdict,
      reasons,
      suggest,
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

  function attemptTexts(d) {
    const g = GESTURES.find((x) => x.kind === d.kind);
    const title = g ? g.title : (d.kind === 'move' ? '移動' : '不明');
    const btnText = (code) => {
      const label = BTN_NAMES[code] || String(code);
      if (d.fw.buttonsPressed.includes(code)) {
        return `${label}ボタン ` + (d.fw.buttonsReleased.includes(code) ? '押し→離し' : '押し(離しなし)');
      }
      return 'ボタン報告なし';
    };
    let core;
    let fw;
    if (d.kind === 'tapdrag') {
      const t1 = d.touches[0];
      const t2 = d.touches[1];
      core = `タップ ${t1.downMs}ms → 間隔 ${d.fw.gapMs}ms → ドラッグ 移動 ${t2 ? t2.moveSum : 0}`;
      fw = `${core} → ${btnText(BTN[0])}`;
    } else if (d.kind === 'scroll2') {
      core = `2 本指 押下 ${d.fw.downMs}ms 移動 ${d.fw.moveSum}`;
      fw = `${core} → ${d.fw.mode2fSeen.includes(1) ? 'スクロール判定' : 'スクロール判定なし'}、wheel ${d.fw.wheel.count} 回`;
    } else if (d.kind === 'pinch') {
      core = `2 本指 距離変化 ${d.fw.distDelta}`;
      fw = `${core} → ${d.fw.mode2fSeen.includes(2) ? 'ピンチ判定' : 'ピンチ判定なし'}` + (d.fw.buttonsPressed.includes(BTN[7]) ? ' + BTN_7' : '');
    } else if (d.kind === 'tap1' || d.kind === 'tap2' || d.kind === 'tap3') {
      const code = d.kind === 'tap1' ? BTN[0] : d.kind === 'tap2' ? BTN[1] : BTN[2];
      core = `押下 ${d.fw.downMs}ms 移動 ${d.fw.moveSum}`;
      fw = `${core} → ${btnText(code)}`;
    } else {
      core = `指 ${d.fw.fingersMax} 本 押下 ${d.fw.downMs}ms 移動 ${d.fw.moveSum}`;
      fw = `${core}(カード対象外)`;
    }
    const parts = [];
    for (const bit of [1, 2, 4]) {
      if (d.host.down.includes(bit)) {
        parts.push(`${HOST_BIT_NAMES[bit]}クリック(` + (d.host.up.includes(bit) ? 'down→up)' : 'down のみ、up なし)'));
      }
    }
    if (d.host.moveCount > 0) parts.push(`移動 ${d.host.moveCount} 回`);
    if (d.host.wheelCount > 0) parts.push(`wheel ${d.host.wheelCount} 回`);
    const host = parts.length ? parts.join('、') : 'ホスト側の受信なし';
    const badge = d.verdict === 'pass' ? '✔' : d.verdict === 'fail' ? '✘' : '△';
    const result = d.verdict === 'pass' && g ? g.expect : (d.reasons[0] || host);
    const oneLine = `${title}: ${core} → ${result} ${badge}`;
    return { title, fw, host, oneLine };
  }

  const api = {
    BTN, REL, BTN_NAMES, GESTURES, DEFAULT_PARAMS,
    stripAnsi, isPrompt, stripPromptPrefix, isEcho, parseListLine, parseInfoLine, parseTraceLine,
    clockOffset, toConfName, exportConf, detectDrops, detectStuckButton,
    detectMissingWheel, detectTwoFingerNoScroll,
    paramValue, stepParam, segmentAttempts, describeAttempt, describeState, attemptTexts,
  };
  root.TpTuner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
