const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./keymap_export.js');
const K = require('./keycodes.js');

function key(x, y) {
  return { x, y, width: 100, height: 100, r: 0, rx: 0, ry: 0 };
}

const KEY_PRESS = {
  id: 1,
  displayName: 'Key Press',
  metadata: [{
    param1: [{ name: 'keycode', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }],
    param2: [{ name: 'unused', nil: true }],
  }],
};
const MOD_TAP2 = {
  id: 2,
  displayName: 'mod_tap2',
  metadata: [{
    param1: [{ name: 'hold', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }],
    param2: [{ name: 'tap', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }],
  }],
};
const MOMENTARY_LAYER = {
  id: 3,
  displayName: 'Momentary Layer',
  metadata: [{
    param1: [{ name: 'layer', layerId: true }],
    param2: [{ name: 'unused', nil: true }],
  }],
};
const MOUSE_KEY_PRESS = {
  id: 4,
  displayName: 'Mouse Key Press',
  metadata: [{
    param1: [
      { name: 'LCLK', constant: 0 },
      { name: 'RCLK', constant: 1 },
      { name: 'MCLK', constant: 2 },
      { name: 'MB4', constant: 3 },
      { name: 'MB5', constant: 4 },
    ],
    param2: [{ name: 'unused', nil: true }],
  }],
};
const NONE = { id: 5, displayName: 'None', metadata: [{ param1: [], param2: [] }] };
const TRANSPARENT = { id: 6, displayName: 'Transparent', metadata: [{ param1: [], param2: [] }] };
const OUTPUT_SELECTION = {
  id: 7,
  displayName: 'Output Selection',
  metadata: [{
    param1: [
      { name: 'Toggle Outputs', constant: 0 },
      { name: 'USB Output', constant: 1 },
      { name: 'BLE Output', constant: 2 },
    ],
    param2: [{ name: 'unused', nil: true }],
  }],
};
const BLUETOOTH = {
  id: 8,
  displayName: 'Bluetooth',
  metadata: [
    { param1: [{ name: 'Select Profile', constant: 0 }], param2: [{ name: 'profile', range: { min: 0, max: 4 } }] },
    {
      param1: [
        { name: 'Disconnect Profile', constant: 1 },
        { name: 'Next Profile', constant: 2 },
        { name: 'Previous Profile', constant: 3 },
        { name: 'Clear All Profiles', constant: 4 },
        { name: 'Clear Selected Profile', constant: 5 },
      ],
      param2: [{ name: 'unused', nil: true }],
    },
  ],
};
const RESET = { id: 9, displayName: 'Reset', metadata: [{ param1: [], param2: [] }] };
const BOOTLOADER = { id: 10, displayName: 'Bootloader', metadata: [{ param1: [], param2: [] }] };
const ZIP_DYN_SCALE = { id: 11, displayName: 'zip_dyn_scale', metadata: [] };
const ZIP_DYN_SCALE_SET = { id: 12, displayName: 'zip_dyn_scale_set', metadata: [] };
const TAP_DANCE = { id: 13, displayName: 'tap_dance_layer_1and2', metadata: [{ param1: [], param2: [] }] };
const CUSTOM_UNKNOWN = {
  id: 14,
  displayName: 'Some Weird! Behavior',
  metadata: [{ param1: [{ name: 'x', range: { min: 0, max: 1 } }], param2: [] }],
};

const BEHAVIORS = [
  KEY_PRESS, MOD_TAP2, MOMENTARY_LAYER, MOUSE_KEY_PRESS, NONE, TRANSPARENT,
  OUTPUT_SELECTION, BLUETOOTH, RESET, BOOTLOADER, ZIP_DYN_SCALE, ZIP_DYN_SCALE_SET, TAP_DANCE, CUSTOM_UNKNOWN,
];

const Q = K.findByValue(K.encodeUsage(7, 20, 0)).value;
const A = K.findByValue(K.encodeUsage(7, 4, 0)).value;
const TAB = K.findByValue(K.encodeUsage(7, 43, 0)).value;
const D = K.findByValue(K.encodeUsage(7, 7, 0)).value;
const UP_LC = K.encodeUsage(7, 82, K.MODS.LC);
const A_LC_LS = K.encodeUsage(7, 4, K.MODS.LC | K.MODS.LS);

test('exportKeymap は DEFAULT_LAYER 相当の binding をキー位置順・行改行つきで書き出す', () => {
  const keymap = {
    layers: [{ id: 0, name: 'Default', bindings: [
      { behaviorId: KEY_PRESS.id, param1: Q, param2: 0 },
      { behaviorId: KEY_PRESS.id, param1: D, param2: 0 },
      { behaviorId: MOMENTARY_LAYER.id, param1: 0, param2: 0 },
      { behaviorId: MOD_TAP2.id, param1: TAB, param2: A },
      { behaviorId: MOUSE_KEY_PRESS.id, param1: 0, param2: 0 },
      { behaviorId: MOUSE_KEY_PRESS.id, param1: 3, param2: 0 },
      { behaviorId: KEY_PRESS.id, param1: UP_LC, param2: 0 },
      { behaviorId: NONE.id, param1: 0, param2: 0 },
    ] }],
  };
  const layout = { keys: [
    key(0, 0), key(100, 0), key(200, 0),
    key(0, 100),
    key(0, 200), key(100, 200),
    key(0, 300), key(100, 300),
  ] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  assert.match(text, /^\/\/ tp-tuner が書き出したキーマップ\n/);
  assert.ok(text.includes('layer_0 {'));
  assert.ok(text.includes('display-name = "Default";'));
  const lines = text.split('\n');
  const row0 = lines.find((l) => l.startsWith('&kp Q'));
  assert.match(row0, /^&kp Q\s+&kp D\s+&mo 0$/);
  const row1 = lines.find((l) => l.startsWith('&mt2'));
  assert.equal(row1, '&mt2 TAB A');
  const row2 = lines.find((l) => l.startsWith('&mkp'));
  assert.match(row2, /^&mkp LCLK\s+&mkp MB4$/);
  const row3 = lines.find((l) => l.startsWith('&kp LC'));
  assert.match(row3, /^&kp LC\(UP_ARROW\)\s+&none$/);
});

test('exportKeymap は SYSTEM_LAYER 相当の bt/out/sys_reset/bootloader/zip_dyn_scale/trans を変換する', () => {
  const keymap = {
    layers: [{ id: 0, name: 'system_layer', bindings: [
      { behaviorId: OUTPUT_SELECTION.id, param1: 0, param2: 0 },
      { behaviorId: BLUETOOTH.id, param1: 0, param2: 0 },
      { behaviorId: BLUETOOTH.id, param1: 4, param2: 0 },
      { behaviorId: RESET.id, param1: 0, param2: 0 },
      { behaviorId: BOOTLOADER.id, param1: 0, param2: 0 },
      { behaviorId: ZIP_DYN_SCALE.id, param1: 0, param2: 1 },
      { behaviorId: ZIP_DYN_SCALE.id, param1: 1, param2: 3 },
      { behaviorId: TRANSPARENT.id, param1: 0, param2: 0 },
    ] }],
  };
  const layout = { keys: Array.from({ length: 8 }, (_, i) => key(i * 100, 0)) };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  const line = text.split('\n').find((l) => l.startsWith('&out'));
  const tokens = line.trim().split(/\s+/);
  assert.deepEqual(tokens, [
    '&out', 'OUT_TOG',
    '&bt', 'BT_SEL', '0',
    '&bt', 'BT_CLR_ALL',
    '&sys_reset',
    '&bootloader',
    '&zip_dyn_scale', 'ZDS_XY', 'ZDS_INC',
    '&zip_dyn_scale', 'ZDS_SC', 'ZDS_RST',
    '&trans',
  ]);
});

test('exportKeymap はレイヤー参照を Studio の name ではなく keymap.layers 内のインデックスで出す', () => {
  const keymap = {
    layers: [
      { id: 10, name: 'Default', bindings: [{ behaviorId: MOMENTARY_LAYER.id, param1: 20, param2: 0 }] },
      { id: 20, name: 'secondary_layer', bindings: [{ behaviorId: MOMENTARY_LAYER.id, param1: 10, param2: 0 }] },
    ],
  };
  const layout = { keys: [key(0, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  assert.ok(text.includes('layer_0 {'));
  assert.ok(text.includes('layer_1 {'));
  const lines = text.split('\n');
  assert.equal(lines.find((l) => l.trim() === '&mo 1'), '&mo 1');
  assert.equal(lines.find((l) => l.trim() === '&mo 0'), '&mo 0');
});

test('exportKeymap は display-name の " と \\ をエスケープする', () => {
  const keymap = { layers: [{ id: 0, name: 'a"b\\c', bindings: [] }] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout: { keys: [] } });
  assert.ok(text.includes('display-name = "a\\"b\\\\c";'));
});

test('exportKeymap は未知の behavior をノード名から推定し、要確認コメントを重複なく出す', () => {
  const keymap = {
    layers: [{ id: 0, name: 'x', bindings: [
      { behaviorId: CUSTOM_UNKNOWN.id, param1: 0, param2: 0 },
      { behaviorId: CUSTOM_UNKNOWN.id, param1: 0, param2: 0 },
    ] }],
  };
  const layout = { keys: [key(0, 0), key(100, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  assert.ok(text.includes('// 要確認: 次の behavior はノード名から推定しました: Some Weird! Behavior\n'));
  assert.ok(text.includes('&Some_Weird__Behavior 0'));
  assert.equal((text.match(/要確認/g) || []).length, 1);
});

test('exportKeymap は同じ行内の binding を最長文字数+1で右パディングし行末の空白を残さない', () => {
  const keymap = { layers: [{ id: 0, name: 'x', bindings: [
    { behaviorId: KEY_PRESS.id, param1: A, param2: 0 },
    { behaviorId: MOD_TAP2.id, param1: TAB, param2: A },
  ] }] };
  const layout = { keys: [key(0, 0), key(100, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  const line = text.split('\n').find((l) => l.startsWith('&kp A'));
  assert.equal(line, '&kp A      &mt2 TAB A');
  assert.equal(line, line.replace(/\s+$/, ''));
});

test('exportKeymap は hidUsage の完全一致がない値を修飾キーで外側から包んで表す', () => {
  const keymap = { layers: [{ id: 0, name: 'x', bindings: [
    { behaviorId: KEY_PRESS.id, param1: A_LC_LS, param2: 0 },
  ] }] };
  const layout = { keys: [key(0, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  assert.ok(text.includes('&kp LC(LS(A))'));
});

test('exportKeymap は基底キーが見つからない hidUsage 値を16進数で表す', () => {
  const keymap = { layers: [{ id: 0, name: 'x', bindings: [
    { behaviorId: KEY_PRESS.id, param1: K.encodeUsage(99, 999, 0), param2: 0 },
  ] }] };
  const layout = { keys: [key(0, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  const expected = '0x' + (K.encodeUsage(99, 999, 0) >>> 0).toString(16);
  assert.ok(text.includes('&kp ' + expected));
});

test('exportKeymap は zip_dyn_scale の未定義値を数値のまま出す', () => {
  const keymap = { layers: [{ id: 0, name: 'x', bindings: [
    { behaviorId: ZIP_DYN_SCALE_SET.id, param1: 0, param2: 42 },
  ] }] };
  const layout = { keys: [key(0, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  assert.ok(text.includes('&zip_dyn_scale_set ZDS_XY 42'));
});

test('exportKeymap は tap_dance_layer_1and2 のような独自 behavior をラベルそのまま出す', () => {
  const keymap = { layers: [{ id: 0, name: 'x', bindings: [
    { behaviorId: TAP_DANCE.id, param1: 0, param2: 0 },
  ] }] };
  const layout = { keys: [key(0, 0)] };
  const text = E.exportKeymap({ keymap, behaviors: BEHAVIORS, layout });
  assert.ok(text.includes('&tap_dance_layer_1and2'));
  assert.ok(!text.includes('要確認'));
});
