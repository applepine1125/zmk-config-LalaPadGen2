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
