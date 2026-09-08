const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./tuner.js');

test('tp list の1行をパースすると名前と値と範囲と種別が取れる', () => {
  assert.deepEqual(T.parseListLine('1f_tap_max_ms 250 1 1000 driver 250'), {
    name: '1f_tap_max_ms', value: 250, min: 1, max: 1000, kind: 'driver', def: 250,
  });
  assert.equal(T.parseListLine('uart:~$ '), null);
  assert.equal(T.parseListLine(''), null);
});

test('tp info の行をパースすると側と uptime が取れる', () => {
  assert.deepEqual(T.parseInfoLine('side=central uptime_ms=12345 params=50'),
    { side: 'central', uptimeMs: 12345, params: 50 });
  assert.equal(T.parseInfoLine('OK reset'), null);
});

test('ログ接頭辞つきの T F 行をパースするとフレームになる', () => {
  const line = '[00:00:12.345,678] <inf> iqs9151: T F 12345 1 3 -2 1000 1500 0 0 0110 0 0 1';
  assert.deepEqual(T.parseTraceLine(line), {
    type: 'F', ms: 12345, fingers: 1, relX: 3, relY: -2, f1x: 1000, f1y: 1500,
    f2x: 0, f2y: 0, flags: 0x0110, hold: 0, mode2f: 0, pending: 1,
  });
});

test('T E 行をパースするとキー報告と戻り値になる', () => {
  assert.deepEqual(T.parseTraceLine('T E 500 K 272 0 -12'),
    { type: 'E', ms: 500, kind: 'K', code: 272, value: 0, ret: -12 });
  assert.deepEqual(T.parseTraceLine('T E 501 R 8 -3 0'),
    { type: 'E', ms: 501, kind: 'R', code: 8, value: -3, ret: 0 });
  assert.equal(T.parseTraceLine('OK trace=on'), null);
});

test('ANSI エスケープを除去してプロンプトを判定できる', () => {
  assert.equal(T.stripAnsi('\x1b[1;32muart:~$ \x1b[0m'), 'uart:~$ ');
  assert.equal(T.isPrompt('uart:~$ '), true);
  assert.equal(T.isPrompt('OK reset'), false);
});

test('カーソル保存・復元の 2 バイトエスケープも除去できる', () => {
  assert.equal(T.stripAnsi('\x1b7uart:~$ \x1b8'), 'uart:~$ ');
  assert.equal(T.stripAnsi('\x1b[2K\x1b7T E 1 K 272 0 0\x1b8'), 'T E 1 K 272 0 0');
});

test('プロンプトとエコーが同じ行にあるとき、プロンプト接頭辞を除くとコマンドだけになる', () => {
  assert.equal(T.stripPromptPrefix('uart:~$ tp info'), 'tp info');
});

test('エコーだけの行はプロンプト接頭辞の除去で変わらない', () => {
  assert.equal(T.stripPromptPrefix('tp info'), 'tp info');
});

test('エコーでない行はプロンプト接頭辞の除去で変わらない', () => {
  assert.equal(T.stripPromptPrefix('side=central uptime_ms=1 params=50'), 'side=central uptime_ms=1 params=50');
  assert.equal(T.stripPromptPrefix('OK trace=off'), 'OK trace=off');
});

test('送信したコマンドと一致する行だけをエコーと判定する', () => {
  assert.equal(T.isEcho('uart:~$ tp info', 'tp info'), true);
  assert.equal(T.isEcho('tp info', 'tp info'), true);
  assert.equal(T.isEcho('side=central uptime_ms=1 params=50', 'tp info'), false);
  assert.equal(T.isEcho('uart:~$ ', 'tp info'), false);
  assert.equal(T.isEcho('OK trace=off', 'tp trace off'), false);
  assert.equal(T.isEcho('tp info', ''), false);
});

test('往復時間の半分を補正した時刻オフセットを計算できる', () => {
  assert.equal(T.clockOffset(1000, 1020, 500), 510);
});

test('パラメータ名を CONFIG 名に変換できる', () => {
  assert.equal(T.toConfName('1f_tap_max_ms'), 'CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS');
});

test('差分だけを .conf 行にすると bool は y/n になり変更のない行は出ない', () => {
  const params = [
    { name: '1f_tap_max_ms', value: 200, def: 250, kind: 'driver' },
    { name: '1f_tap_enable', value: 0, def: 1, kind: 'driver_bool' },
    { name: '1f_tap_move', value: 50, def: 50, kind: 'driver' },
  ];
  assert.equal(T.exportConf(params, { diffOnly: true }),
    'CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS=200\nCONFIG_INPUT_IQS9151_1F_TAP_ENABLE=n\n');
  assert.equal(T.exportConf(params, { diffOnly: false }).split('\n').filter(Boolean).length, 3);
});

test('戻り値が 0 でない報告をドロップとして検出できる', () => {
  const ev = [
    { t: 10, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 20, type: 'E', kind: 'K', code: 272, value: 0, ret: -12 },
  ];
  assert.deepEqual(T.detectDrops(ev), [{ t: 20, code: 272, kind: 'K' }]);
});

test('ドライバが離した後にホストのボタンが押されたままなら stuck として検出できる', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }, { t: 700, buttons: 1 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), [{ t: 300, code: 272 }]);
});

test('ドライバが離した後にホストも離していれば stuck にならない', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }, { t: 310, buttons: 0 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), []);
});

test('離してから holdMs が経っていないときは now を渡すと stuck と判定しない', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300, now: 500 }), []);
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300, now: 600 }), [{ t: 300, code: 272 }]);
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), [{ t: 300, code: 272 }]);
});

test('ドライバが wheel を送ったのにホストに wheel が届かなければ検出できる', () => {
  const fw = [{ t: 100, type: 'E', kind: 'R', code: 8, value: 2, ret: 0 }];
  assert.deepEqual(T.detectMissingWheel(fw, [], { windowMs: 200 }), [{ t: 100 }]);
  assert.deepEqual(T.detectMissingWheel(fw, [{ t: 150, deltaY: 4 }], { windowMs: 200 }), []);
});

test('2本指で動いているのにドライバが wheel を出さなければ検出できる', () => {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    frames.push({ t: i * 10, type: 'F', fingers: 2, relX: 0, relY: 3 });
  }
  assert.deepEqual(T.detectTwoFingerNoScroll(frames, [], { minMove: 30, windowMs: 200 }),
    [{ t: 0 }]);
  const fw = [{ t: 120, type: 'E', kind: 'R', code: 8, value: 1, ret: 0 }];
  assert.deepEqual(T.detectTwoFingerNoScroll(frames, fw, { minMove: 30, windowMs: 200 }), []);
});

const PARAMS = {
  '1f_tap_max_ms': 250, '1f_tap_move': 50, '1f_tapdrag_gap_max_ms': 160,
  '2f_tap_max_ms': 250, '2f_tap_move': 50, '2f_scroll_start_move': 15, '2f_pinch_start_distance': 30,
  '3f_tap_max_ms': 200, '3f_tap_move': 35,
};

function frames(from, to, fingers, extra) {
  const out = [];
  for (let t = from; t <= to; t += 10) {
    out.push({ type: 'F', t, fingers, relX: 0, relY: 0, f1x: 0, f1y: 0, f2x: 0, f2y: 0, hold: 0, mode2f: 0, pending: 0, ...(extra || {}) });
  }
  return out;
}
const K = (t, code, value) => ({ t, type: 'E', kind: 'K', code, value, ret: 0 });
const R = (t, code, value) => ({ t, type: 'E', kind: 'R', code, value, ret: 0 });
const HOST0 = { btn: [], move: [], wheel: [] };

test('指の接触が idleMs 以上離れていれば別の試行に分かれる', () => {
  const fr = frames(0, 100, 1).concat(frames(110, 600, 0), frames(610, 700, 1), frames(710, 1200, 0));
  const a = T.segmentAttempts(fr, { idleMs: 400 });
  assert.equal(a.length, 2);
  assert.equal(a[0].start, 0);
  assert.equal(a[0].end, 100);
  assert.equal(a[0].closed, true);
  assert.equal(a[1].start, 610);
  assert.equal(a[1].end, 700);
  assert.equal(a[1].closed, true);
});

test('タップ後すぐの再接触は同じ試行にまとまる', () => {
  const fr = frames(0, 100, 1).concat(frames(110, 200, 0), frames(210, 500, 1), frames(510, 1000, 0));
  const a = T.segmentAttempts(fr, { idleMs: 400 });
  assert.equal(a.length, 1);
  assert.equal(a[0].start, 0);
  assert.equal(a[0].end, 500);
  assert.equal(a[0].frames.length, 51);
});

test('離した後に idleMs 経っていない試行は closed にならず、now を渡せば時間経過で closed になる', () => {
  const fr = frames(0, 100, 1);
  assert.equal(T.segmentAttempts(fr, { idleMs: 400 })[0].closed, false);
  assert.equal(T.segmentAttempts(fr, { idleMs: 400, now: 300 })[0].closed, false);
  assert.equal(T.segmentAttempts(fr, { idleMs: 400, now: 500 })[0].closed, true);
});

test('1本指の短いタップでドライバが左を押して離しホストも受け取れば tap1 の pass になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 290, 0, { hold: 272, pending: 1 }), frames(300, 700, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [], wheel: [] };
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, host, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'tap1');
  assert.equal(d.verdict, 'pass');
  assert.equal(d.fw.downMs, 120);
  assert.deepEqual(d.fw.buttonsPressed, [272]);
  assert.deepEqual(d.fw.buttonsReleased, [272]);
  assert.deepEqual(d.host.down, [1]);
  assert.deepEqual(d.host.up, [1]);
  assert.deepEqual(d.reasons, []);
});

test('押下時間が 1f_tap_max_ms を超えてボタン報告がなければ tap1 の fail になり理由と提案が返る', () => {
  const fr = frames(0, 320, 1).concat(frames(330, 800, 0));
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], [], HOST0, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'tap1');
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(d.reasons, ['押下 320ms > 1f_tap_max_ms=250']);
  assert.deepEqual(d.suggest, [{ name: '1f_tap_max_ms', delta: 50 }]);
});

test('移動量が 1f_tap_move を超えてボタン報告がなければ tap1 の fail になり移動量が理由になる', () => {
  const fr = frames(0, 100, 1, { relX: 8 }).concat(frames(110, 600, 0));
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], [], HOST0, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'tap1');
  assert.equal(d.verdict, 'fail');
  assert.equal(d.fw.moveSum, 88);
  assert.deepEqual(d.reasons, ['移動 88 > 1f_tap_move=50']);
  assert.deepEqual(d.suggest, [{ name: '1f_tap_move', delta: 10 }]);
});

test('ドライバが離してもホストの左ボタンが押されたままなら tap1 の fail で stuck になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 700, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }], move: [], wheel: [] };
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, host, PARAMS, { tailMs: 500 });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.fw.stuck, true);
  assert.ok(d.reasons.some((r) => r.includes('ホストで左ボタンが押されたまま')));
  assert.deepEqual(d.suggest, []);
});

test('ドライバは押して離したがホストにボタンが届いていなければ tap1 は partial になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 700, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, HOST0, PARAMS, { tailMs: 500 });
  assert.equal(d.verdict, 'partial');
  assert.ok(d.reasons.some((r) => r.includes('ホスト側で左ボタンが観測されていない')));
});

test('2回目の接触が 1f_tapdrag_gap_max_ms より遅ければ tapdrag の fail になり実測 gap が理由になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 350, 0), frames(360, 900, 1, { relX: 3 }), frames(910, 1500, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [{ t: 400, dx: 3, dy: 0 }], wheel: [] };
  const attempts = T.segmentAttempts(fr);
  assert.equal(attempts.length, 1);
  const d = T.describeAttempt(attempts[0], fw, host, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'tapdrag');
  assert.equal(d.verdict, 'fail');
  assert.equal(d.fw.gapMs, 240);
  assert.deepEqual(d.reasons, ['2 回目の接触が 1f_tapdrag_gap_max_ms=160 より遅い(実測 240ms)']);
  assert.deepEqual(d.suggest, [{ name: '1f_tapdrag_gap_max_ms', delta: 40 }]);
});

test('タップ後 gap 内に再接触して移動し最後に離せば tapdrag の pass になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 210, 0, { hold: 272, pending: 1 }), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const fw = [K(125, 272, 1), K(805, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 812, buttons: 0 }], move: [{ t: 300, dx: 3, dy: 0 }], wheel: [] };
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, host, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'tapdrag');
  assert.equal(d.verdict, 'pass');
  assert.equal(d.fw.gapMs, 100);
  assert.deepEqual(d.reasons, []);
});

test('2本指でスクロール判定になり wheel がホストに届けば scroll2 の pass になる', () => {
  const fr = frames(0, 50, 2, { relY: 4 }).concat(frames(60, 500, 2, { relY: 4, mode2f: 1 }), frames(510, 1000, 0));
  const fw = [];
  const host = { btn: [], move: [], wheel: [] };
  for (let t = 100; t <= 500; t += 50) {
    fw.push(R(t, 8, -1));
    host.wheel.push({ t: t + 12, deltaX: 0, deltaY: 24 });
  }
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, host, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'scroll2');
  assert.equal(d.verdict, 'pass');
  assert.equal(d.fw.wheel.count, 9);
  assert.equal(d.host.wheelCount, 9);
  assert.deepEqual(d.fw.mode2fSeen, [1]);
});

test('2本指の移動量が 2f_scroll_start_move に届かなければ scroll2 の fail になる', () => {
  const fr = frames(0, 90, 2, { relY: 1 }).concat(frames(100, 300, 2), frames(310, 800, 0));
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], [], HOST0, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'scroll2');
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(d.reasons, ['2 本指移動量 10 < 2f_scroll_start_move=15']);
  assert.deepEqual(d.suggest, [{ name: '2f_scroll_start_move', delta: -5 }]);
});

test('ドライバが wheel を出したのにホストに届いていなければ scroll2 の fail になる', () => {
  const fr = frames(0, 500, 2, { relY: 4, mode2f: 1 }).concat(frames(510, 1000, 0));
  const fw = [R(100, 8, -1), R(150, 8, -1)];
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, HOST0, PARAMS, { tailMs: 500 });
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(d.reasons, ['wheel がホストに届いていない']);
});

test('大きく動かした1本指の接触はカード対象外の move になる', () => {
  const fr = frames(0, 600, 1, { relX: 5 }).concat(frames(610, 1100, 0));
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], [], HOST0, PARAMS, { tailMs: 500 });
  assert.equal(d.kind, 'move');
});

test('直近フレームから現在の認識状態の文言を作れる', () => {
  assert.equal(T.describeState({ fingers: 0, hold: 0, mode2f: 0, pending: 0 }), '待機');
  assert.equal(T.describeState({ fingers: 1, hold: 0, mode2f: 0, pending: 0, relX: 3, relY: 0 }), '指 1 本 移動中');
  assert.equal(T.describeState({ fingers: 1, hold: 0, mode2f: 0, pending: 0, relX: 0, relY: 0 }), '指 1 本 接触中');
  assert.equal(T.describeState({ fingers: 1, hold: 272, mode2f: 0, pending: 0, relX: 2, relY: 0 }), 'ボタン押下中(左) ドラッグ');
  assert.equal(T.describeState({ fingers: 0, hold: 272, mode2f: 0, pending: 1 }), 'タップ後 2 回目の接触待ち(左ボタン保持中)');
  assert.equal(T.describeState({ fingers: 2, hold: 0, mode2f: 1, pending: 0 }), '2 本指 スクロール中');
  assert.equal(T.describeState({ fingers: 2, hold: 0, mode2f: 2, pending: 0 }), 'ピンチ中');
  assert.equal(T.describeState({ fingers: 2, hold: 0, mode2f: 0, pending: 0 }), '2 本指 接触中');
  assert.equal(T.describeState({ fingers: 3, hold: 0, mode2f: 0, pending: 0 }), '3 本指 接触中');
  assert.equal(T.describeState(null), '待機');
});

test('パラメータを 1 段階動かすと min/max でクランプされる', () => {
  assert.equal(T.stepParam({ value: 980, min: 1, max: 1000 }, 50), 1000);
  assert.equal(T.stepParam({ value: 10, min: 1, max: 1000 }, -20), 1);
  assert.equal(T.stepParam({ value: 250, min: 1, max: 1000 }, 50), 300);
});

test('試行の説明をドライバ側とホスト側の一文にできる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 700, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [], wheel: [] };
  const d = T.describeAttempt(T.segmentAttempts(fr)[0], fw, host, PARAMS, { tailMs: 500 });
  const txt = T.attemptTexts(d);
  assert.equal(txt.fw, '押下 120ms 移動 0 → 左ボタン 押し→離し');
  assert.equal(txt.host, '左クリック(down→up)');
  assert.equal(txt.oneLine, '1本指タップ: 押下 120ms 移動 0 → 左クリック ✔');
});
