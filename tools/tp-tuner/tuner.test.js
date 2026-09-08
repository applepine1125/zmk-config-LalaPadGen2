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

function observe(fr, fw, host) {
  return T.observeAttempt(T.segmentAttempts(fr)[0], fw || [], host || HOST0, { tailMs: 500 });
}
const marks = (r) => r.stages.map((s) => (s.ok === true ? 'o' : s.ok === false ? 'x' : '-')).join('');

const TAP1_OK = {
  fr: frames(0, 120, 1).concat(frames(130, 290, 0, { hold: 272, pending: 1 }), frames(300, 700, 0)),
  fw: [K(125, 272, 1), K(290, 272, 0)],
  host: { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [], wheel: [] },
};

test('試行を観測すると押下時間・移動量・ボタン報告・ホストの down/up が事実として取れる', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host);
  assert.equal(o.fingersMax, 1);
  assert.equal(o.downMs, 120);
  assert.equal(o.moveSum, 0);
  assert.equal(o.gapMs, null);
  assert.equal(o.touches.length, 1);
  assert.deepEqual(o.buttonsPressed, [272]);
  assert.deepEqual(o.buttonsReleased, [272]);
  assert.deepEqual(o.keys, [{ t: 125, code: 272, value: 1 }, { t: 290, code: 272, value: 0 }]);
  assert.deepEqual(o.host, { down: [1], up: [1], moveCount: 0, wheelCount: 0, stuckBits: [] });
});

test('2 回接触した試行を観測すると 2 回目の間隔・移動量・保持していたボタンが取れる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 210, 0, { hold: 272, pending: 1 }), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const o = observe(fr, [K(125, 272, 1), K(805, 272, 0)]);
  assert.equal(o.touches.length, 2);
  assert.equal(o.gapMs, 100);
  assert.equal(o.touches[1].moveSum, 177);
  assert.deepEqual(o.touches[1].holds, [272]);
  assert.deepEqual(o.touches[0].holds, []);
});

test('2 本指の試行を観測すると 2 本指時の移動量・距離変化・mode2f・wheel 数が取れる', () => {
  const fr = frames(0, 100, 2, { relY: 4, f1x: 100, f1y: 100, f2x: 200, f2y: 100 })
    .concat(frames(110, 300, 2, { relY: 4, mode2f: 1, f1x: 100, f1y: 100, f2x: 240, f2y: 100 }), frames(310, 800, 0));
  const host = { btn: [], move: [], wheel: [{ t: 150, deltaX: 0, deltaY: 24 }] };
  const o = observe(fr, [R(120, 8, -1), R(170, 8, -1)], host);
  assert.equal(o.fingersMax, 2);
  assert.equal(o.moveSum2, 31 * 4);
  assert.equal(o.distDelta, 40);
  assert.deepEqual(o.mode2fSeen, [1]);
  assert.deepEqual(o.wheel, { count: 2, sum: -2 });
  assert.equal(o.host.wheelCount, 1);
});

test('ドライバが離した後もホストのボタンが立ったままなら stuckBits に載る', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, { btn: [{ t: 132, buttons: 1 }], move: [], wheel: [] });
  assert.deepEqual(o.host.stuckBits, [1]);
});

test('観測からジェスチャ種別を参考推定できる', () => {
  assert.equal(T.inferKind(observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host), PARAMS), 'tap1');
  const drag = frames(0, 120, 1).concat(frames(130, 210, 0), frames(220, 800, 1, { relX: 3 }), frames(810, 1400, 0));
  assert.equal(T.inferKind(observe(drag), PARAMS), 'tapdrag');
  const scroll = frames(0, 500, 2, { relY: 4, mode2f: 1 }).concat(frames(510, 1000, 0));
  assert.equal(T.inferKind(observe(scroll), PARAMS), 'scroll2');
  const pinch = frames(0, 300, 2, { mode2f: 2 }).concat(frames(310, 800, 0));
  assert.equal(T.inferKind(observe(pinch), PARAMS), 'pinch');
  const tap2 = frames(0, 100, 2).concat(frames(110, 600, 0));
  assert.equal(T.inferKind(observe(tap2), PARAMS), 'tap2');
  const tap3 = frames(0, 100, 3).concat(frames(110, 600, 0));
  assert.equal(T.inferKind(observe(tap3), PARAMS), 'tap3');
  const move = frames(0, 600, 1, { relX: 5 }).concat(frames(610, 1100, 0));
  assert.equal(T.inferKind(observe(move), PARAMS), 'move');
});

test('観測なしで判定すると期待段階の一覧が閾値つきの未判定として返る', () => {
  const r = T.judgeAttempt('tap1', null, PARAMS);
  assert.equal(r.verdict, 'none');
  assert.equal(r.stages.length, 6);
  assert.ok(r.stages.every((s) => s.ok === null));
  assert.ok(r.stages[1].label.includes('1f_tap_max_ms(250ms)'));
  assert.ok(r.stages[2].label.includes('1f_tap_move(50)'));
});

test('1本指タップ待ちで短いタップをしドライバもホストも左クリックを出せば全段階 ✔ で合格になる', () => {
  const r = T.judgeAttempt('tap1', observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host), PARAMS);
  assert.equal(r.verdict, 'pass');
  assert.equal(marks(r), 'oooooo');
  assert.equal(r.stages[1].detail, '実測 120ms');
  assert.equal(r.reason, '');
  assert.deepEqual(r.suggest, []);
});

test('1本指タップ待ちで押下時間が 1f_tap_max_ms を超えると段階 ② が ✘ になり +50 の提案がつく', () => {
  const fr = frames(0, 320, 1).concat(frames(330, 800, 0));
  const r = T.judgeAttempt('tap1', observe(fr), PARAMS);
  assert.equal(r.verdict, 'fail');
  assert.equal(marks(r), 'oxox--');
  assert.equal(r.failIndex, 1);
  assert.equal(r.stages[1].detail, '実測 320ms > 1f_tap_max_ms=250');
  assert.deepEqual(r.suggest, [{ name: '1f_tap_max_ms', delta: 50 }]);
  assert.ok(r.reason.startsWith('押下時間'));
});

test('1本指タップ待ちで移動量が 1f_tap_move を超えると段階 ③ が ✘ になり +10 の提案がつく', () => {
  const fr = frames(0, 100, 1, { relX: 8 }).concat(frames(110, 600, 0));
  const r = T.judgeAttempt('tap1', observe(fr), PARAMS);
  assert.equal(marks(r), 'ooxx--');
  assert.equal(r.stages[2].detail, '実測 88 > 1f_tap_move=50');
  assert.deepEqual(r.suggest, [{ name: '1f_tap_move', delta: 10 }]);
});

test('1本指タップ待ちで条件内なのにボタン報告がなければ段階 ④ が ✘ になり tap_enable の確認を促す', () => {
  const fr = frames(0, 100, 1).concat(frames(110, 600, 0));
  const r = T.judgeAttempt('tap1', observe(fr), PARAMS);
  assert.equal(marks(r), 'ooox--');
  assert.ok(r.stages[3].detail.includes('1f_tap_enable'));
  assert.deepEqual(r.suggest, []);
});

test('1本指タップ待ちでドライバは離したのにホストの左ボタンが押されたままなら段階 ⑥ が ✘ で不合格になる', () => {
  const r = T.judgeAttempt('tap1', observe(TAP1_OK.fr, TAP1_OK.fw, { btn: [{ t: 132, buttons: 1 }], move: [], wheel: [] }), PARAMS);
  assert.equal(r.verdict, 'fail');
  assert.equal(marks(r), 'ooooox');
  assert.ok(r.stages[5].detail.includes('ホストで左ボタンが押されたまま'));
});

test('1本指タップ待ちでドライバは押して離したがホストで観測できなければ段階 ⑥ が ✘ の一部合格になる', () => {
  const r = T.judgeAttempt('tap1', observe(TAP1_OK.fr, TAP1_OK.fw, HOST0), PARAMS);
  assert.equal(r.verdict, 'partial');
  assert.equal(marks(r), 'ooooox');
  assert.ok(r.stages[5].detail.includes('ホスト側で左ボタンが観測されていない'));
});

test('1本指タップ待ちで指 2 本が認識されると段階 ① が ✘ になり残りは判定しない', () => {
  const fr = frames(0, 100, 2).concat(frames(110, 600, 0));
  const r = T.judgeAttempt('tap1', observe(fr), PARAMS);
  assert.equal(r.verdict, 'fail');
  assert.equal(marks(r), 'x-----');
  assert.equal(r.stages[0].detail, '指 2 本で認識されました');
});

test('接触のない試行を判定すると段階 ① が接触なしで ✘ になる', () => {
  const r = T.judgeAttempt('tap1', T.observeAttempt({ start: 0, end: 0, frames: [] }, [], HOST0), PARAMS);
  assert.equal(marks(r), 'x-----');
  assert.equal(r.stages[0].detail, '接触なし');
});

test('タップドラッグ待ちで 2 回目の接触が 1f_tapdrag_gap_max_ms より遅いと段階 ③ が ✘ になり実測 gap と +40 の提案がつく', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 350, 0), frames(360, 900, 1, { relX: 3 }), frames(910, 1500, 0));
  const fw = [K(125, 272, 1), K(290, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 297, buttons: 0 }], move: [{ t: 400, dx: 3, dy: 0 }], wheel: [] };
  const r = T.judgeAttempt('tapdrag', observe(fr, fw, host), PARAMS);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.failIndex, 2);
  assert.equal(r.stages[2].detail, '実測 240ms > 1f_tapdrag_gap_max_ms=160');
  assert.equal(r.stages[3].ok, false);
  assert.ok(r.stages[3].detail.includes('2 本目の接触前'));
  assert.deepEqual(r.suggest, [{ name: '1f_tapdrag_gap_max_ms', delta: 40 }]);
  assert.ok(r.reason.includes('1f_tapdrag_gap_max_ms'));
});

test('タップドラッグ待ちで gap 内に再接触し保持したまま動かして離せば全段階 ✔ で合格になる', () => {
  const fr = frames(0, 120, 1).concat(frames(130, 210, 0, { hold: 272, pending: 1 }), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const fw = [K(125, 272, 1), K(805, 272, 0)];
  const host = { btn: [{ t: 132, buttons: 1 }, { t: 812, buttons: 0 }], move: [{ t: 300, dx: 3, dy: 0 }], wheel: [] };
  const r = T.judgeAttempt('tapdrag', observe(fr, fw, host), PARAMS);
  assert.equal(r.verdict, 'pass');
  assert.equal(marks(r), 'oooooo');
  assert.equal(r.stages[2].detail, '実測 100ms');
});

test('タップドラッグ待ちで 1 回目の接触が長すぎると段階 ① が ✘ になり 1f_tap_max_ms の提案がつく', () => {
  const fr = frames(0, 400, 1).concat(frames(410, 500, 0), frames(510, 900, 1, { relX: 3 }), frames(910, 1500, 0));
  const r = T.judgeAttempt('tapdrag', observe(fr), PARAMS);
  assert.equal(r.failIndex, 0);
  assert.equal(r.stages[0].detail, '押下 400ms > 1f_tap_max_ms=250');
  assert.deepEqual(r.suggest, [{ name: '1f_tap_max_ms', delta: 50 }]);
});

test('タップドラッグ待ちで 2 回目の接触がなければ段階 ③ が ✘ になる', () => {
  const r = T.judgeAttempt('tapdrag', observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host), PARAMS);
  assert.equal(marks(r), 'oox-ox');
  assert.equal(r.stages[2].detail, '2 本目の接触なし');
});

test('2本指スクロール待ちでスクロール判定になり wheel がホストに届けば全段階 ✔ で合格になる', () => {
  const fr = frames(0, 50, 2, { relY: 4 }).concat(frames(60, 500, 2, { relY: 4, mode2f: 1 }), frames(510, 1000, 0));
  const fw = [];
  const host = { btn: [], move: [], wheel: [] };
  for (let t = 100; t <= 500; t += 50) {
    fw.push(R(t, 8, -1));
    host.wheel.push({ t: t + 12, deltaX: 0, deltaY: 24 });
  }
  const r = T.judgeAttempt('scroll2', observe(fr, fw, host), PARAMS);
  assert.equal(r.verdict, 'pass');
  assert.equal(marks(r), 'oooo');
  assert.equal(r.stages[2].detail, 'wheel 9 回');
});

test('2本指スクロール待ちで移動量が 2f_scroll_start_move に届かないと段階 ② が ✘ になり -5 の提案がつく', () => {
  const fr = frames(0, 90, 2, { relY: 1 }).concat(frames(100, 300, 2), frames(310, 800, 0));
  const r = T.judgeAttempt('scroll2', observe(fr), PARAMS);
  assert.equal(r.verdict, 'fail');
  assert.equal(marks(r), 'oxx-');
  assert.equal(r.stages[1].detail, '2 本指移動量 10 < 2f_scroll_start_move=15');
  assert.deepEqual(r.suggest, [{ name: '2f_scroll_start_move', delta: -5 }]);
});

test('2本指スクロール待ちでドライバは wheel を出したがホストに届かないと段階 ④ が ✘ の一部合格になる', () => {
  const fr = frames(0, 500, 2, { relY: 4, mode2f: 1 }).concat(frames(510, 1000, 0));
  const r = T.judgeAttempt('scroll2', observe(fr, [R(100, 8, -1), R(150, 8, -1)]), PARAMS);
  assert.equal(r.verdict, 'partial');
  assert.equal(marks(r), 'ooox');
  assert.ok(r.stages[3].detail.includes('wheel がホストに届いていない'));
});

test('2本指スクロール待ちで指 1 本しか認識されないと段階 ① が ✘ になる', () => {
  const r = T.judgeAttempt('scroll2', observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host), PARAMS);
  assert.equal(marks(r), 'x---');
  assert.equal(r.stages[0].detail, '指 1 本で認識されました');
});

test('2本指タップ待ちで短く叩きドライバが右を押して離しホストも右クリックを受ければ合格になる', () => {
  const fr = frames(0, 100, 2).concat(frames(110, 600, 0));
  const fw = [K(105, 273, 1), K(270, 273, 0)];
  const host = { btn: [{ t: 112, buttons: 2 }, { t: 277, buttons: 0 }], move: [], wheel: [] };
  const r = T.judgeAttempt('tap2', observe(fr, fw, host), PARAMS);
  assert.equal(r.verdict, 'pass');
  assert.equal(marks(r), 'oooooo');
  assert.ok(r.stages[3].label.includes('K273'));
  assert.ok(r.stages[5].label.includes('右クリック'));
});

test('3本指タップ待ちで 3f_tap_max_ms を超えると段階 ② が ✘ になり 3f_tap_max_ms の提案がつく', () => {
  const fr = frames(0, 260, 3).concat(frames(270, 800, 0));
  const r = T.judgeAttempt('tap3', observe(fr), PARAMS);
  assert.equal(r.failIndex, 1);
  assert.equal(r.stages[1].detail, '実測 260ms > 3f_tap_max_ms=200');
  assert.deepEqual(r.suggest, [{ name: '3f_tap_max_ms', delta: 50 }]);
});

test('ピンチ待ちでピンチ判定になり BTN_7 が報告されれば合格になる', () => {
  const fr = frames(0, 300, 2, { mode2f: 2 }).concat(frames(310, 800, 0));
  const r = T.judgeAttempt('pinch', observe(fr, [K(150, 279, 1), K(310, 279, 0)]), PARAMS);
  assert.equal(r.verdict, 'pass');
  assert.equal(marks(r), 'ooo');
});

test('ピンチ待ちで距離変化が 2f_pinch_start_distance に届かないと段階 ② が ✘ になり -10 の提案がつく', () => {
  const fr = frames(0, 300, 2, { f1x: 100, f1y: 100, f2x: 200, f2y: 100 }).concat(frames(310, 800, 0));
  const r = T.judgeAttempt('pinch', observe(fr), PARAMS);
  assert.equal(r.verdict, 'fail');
  assert.equal(marks(r), 'ox-');
  assert.equal(r.stages[1].detail, '距離変化 0 < 2f_pinch_start_distance=30');
  assert.deepEqual(r.suggest, [{ name: '2f_pinch_start_distance', delta: -10 }]);
});

test('観測をドライバの見え方とホスト側の一文にできる', () => {
  const o = observe(TAP1_OK.fr, TAP1_OK.fw, TAP1_OK.host);
  assert.equal(T.observationText(o), '指 1 本 / 押下 120ms / 移動 0 / ボタン 272(左) 押→離');
  assert.equal(T.hostText(o), '左クリック(down→up)');
  const drag = frames(0, 120, 1).concat(frames(130, 210, 0), frames(220, 800, 1, { relX: 3, hold: 272 }), frames(810, 1400, 0));
  const od = observe(drag, [K(125, 272, 1)], { btn: [{ t: 132, buttons: 1 }], move: [{ t: 300, dx: 3, dy: 0 }], wheel: [] });
  assert.equal(T.observationText(od), '指 1 本 / 押下 120ms / 移動 0 / 2 本目 間隔 100ms 移動 177 / ボタン 272(左) 押(離しなし)');
  assert.equal(T.hostText(od), '左クリック(down のみ、up なし)、移動 1 回');
  assert.equal(T.hostText(observe(frames(0, 100, 1))), 'ホスト側の受信なし');
  assert.equal(T.observationText(T.observeAttempt({ start: 0, end: 0, frames: [] }, [], HOST0)), '接触なし');
});
