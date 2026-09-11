const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./presets.js');

function preset(overrides) {
  return {
    id: 'p-1', name: 'A', createdAt: 't0', updatedAt: 't0',
    trackpad: null, keymap: null,
    ...overrides,
  };
}

test('emptyStore は version 1 の空プリセット一覧になる', () => {
  assert.deepEqual(P.emptyStore(), { version: 1, selectedId: null, presets: [] });
});

test('parseStore は null / undefined / 空文字なら空 store を返す', () => {
  assert.deepEqual(P.parseStore(null), { ok: true, store: P.emptyStore() });
  assert.deepEqual(P.parseStore(undefined), { ok: true, store: P.emptyStore() });
  assert.deepEqual(P.parseStore(''), { ok: true, store: P.emptyStore() });
});

test('壊れた JSON を parseStore すると ok:false になる', () => {
  const r = P.parseStore('{ 壊れてる');
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});

test('version が 1 以外を parseStore すると ok:false になる', () => {
  const r = P.parseStore(JSON.stringify({ version: 2, selectedId: null, presets: [] }));
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});

test('presets が配列でない store を parseStore すると ok:false になる', () => {
  const r = P.parseStore(JSON.stringify({ version: 1, selectedId: null, presets: {} }));
  assert.equal(r.ok, false);
});

test('オブジェクトでない JSON を parseStore すると ok:false になる', () => {
  const r = P.parseStore(JSON.stringify([1, 2, 3]));
  assert.equal(r.ok, false);
});

test('id か name が文字列でない要素は parseStore で捨てられる', () => {
  const raw = JSON.stringify({
    version: 1,
    selectedId: null,
    presets: [preset({ id: 'p-1', name: 'A' }), { id: 1, name: 'B' }, { id: 'p-2', name: 2 }],
  });
  const r = P.parseStore(raw);
  assert.equal(r.ok, true);
  assert.equal(r.store.presets.length, 1);
  assert.equal(r.store.presets[0].id, 'p-1');
});

test('存在しない selectedId を parseStore すると null になる', () => {
  const raw = JSON.stringify({ version: 1, selectedId: 'nope', presets: [preset()] });
  const r = P.parseStore(raw);
  assert.equal(r.store.selectedId, null);
});

test('存在する selectedId は parseStore でそのまま残る', () => {
  const raw = JSON.stringify({ version: 1, selectedId: 'p-1', presets: [preset()] });
  const r = P.parseStore(raw);
  assert.equal(r.store.selectedId, 'p-1');
});

test('trackpad / keymap が欠落した要素は parseStore で null にそろう', () => {
  const raw = JSON.stringify({
    version: 1, selectedId: null,
    presets: [{ id: 'p-1', name: 'A', createdAt: 't0', updatedAt: 't0' }],
  });
  const r = P.parseStore(raw);
  assert.equal(r.store.presets[0].trackpad, null);
  assert.equal(r.store.presets[0].keymap, null);
});

test('serializeStore で末尾改行付きにしても parseStore すると同じ内容に戻る', () => {
  const store = { version: 1, selectedId: 'p-1', presets: [preset()] };
  const text = P.serializeStore(store);
  assert.equal(text.endsWith('\n'), true);
  const r = P.parseStore(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.store, store);
});

test('findPreset は該当する id のプリセットを返し、無ければ null になる', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1' }), preset({ id: 'p-2', name: 'B' })] };
  assert.equal(P.findPreset(store, 'p-2').name, 'B');
  assert.equal(P.findPreset(store, 'p-9'), null);
});

test('空白だけの名前を validateName するとエラーになる', () => {
  const store = { version: 1, selectedId: null, presets: [] };
  assert.deepEqual(P.validateName(store, '   '), { ok: false, error: '名前を入力してください' });
});

test('同名のプリセットがあると validateName はエラーになる', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1', name: 'A' })] };
  assert.deepEqual(P.validateName(store, 'A'), { ok: false, error: '同じ名前のプリセットがあります' });
});

test('exceptId 自身と同じ名前は validateName で通る', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1', name: 'A' })] };
  assert.deepEqual(P.validateName(store, 'A', 'p-1'), { ok: true, name: 'A' });
});

test('前後の空白を trim して validateName する', () => {
  const store = { version: 1, selectedId: null, presets: [] };
  assert.deepEqual(P.validateName(store, '  A  '), { ok: true, name: 'A' });
});

test('createPreset するとプリセットが追加され selectedId が新 id になり、元の store は変わらない', () => {
  const store = { version: 1, selectedId: null, presets: [] };
  const r = P.createPreset(store, { name: 'A', trackpad: { R: { a: 1 } }, keymap: null }, { id: 'p-1', now: 't0' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.preset, { id: 'p-1', name: 'A', createdAt: 't0', updatedAt: 't0', trackpad: { R: { a: 1 } }, keymap: null });
  assert.equal(r.store.selectedId, 'p-1');
  assert.equal(r.store.presets.length, 1);
  assert.deepEqual(store, { version: 1, selectedId: null, presets: [] });
});

test('同名で createPreset するとエラーになり store は返らない', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1', name: 'A' })] };
  const r = P.createPreset(store, { name: 'A' }, { id: 'p-2', now: 't1' });
  assert.deepEqual(r, { ok: false, error: '同じ名前のプリセットがあります' });
});

test('updatePreset は trackpad の R だけ渡すと L は既存のまま残る', () => {
  const store = {
    version: 1, selectedId: null,
    presets: [preset({ id: 'p-1', trackpad: { R: { a: 1 }, L: { a: 2 } }, updatedAt: 't0' })],
  };
  const next = P.updatePreset(store, 'p-1', { trackpad: { R: { a: 9 } }, keymap: null }, 't1');
  assert.deepEqual(P.findPreset(next, 'p-1').trackpad, { R: { a: 9 }, L: { a: 2 } });
});

test('updatePreset は keymap が null なら既存のまま残る', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1', keymap: { layers: [] } })] };
  const next = P.updatePreset(store, 'p-1', { trackpad: null, keymap: null }, 't1');
  assert.deepEqual(P.findPreset(next, 'p-1').keymap, { layers: [] });
});

test('updatePreset すると updatedAt が更新され createdAt は変わらない', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1', createdAt: 't0', updatedAt: 't0' })] };
  const next = P.updatePreset(store, 'p-1', { trackpad: null, keymap: null }, 't1');
  const p = P.findPreset(next, 'p-1');
  assert.equal(p.createdAt, 't0');
  assert.equal(p.updatedAt, 't1');
});

test('該当 id が無ければ updatePreset は store をそのまま返す', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1' })] };
  assert.equal(P.updatePreset(store, 'nope', { trackpad: null, keymap: null }, 't1'), store);
});

test('選択中のプリセットを deletePreset すると selectedId が null になる', () => {
  const store = { version: 1, selectedId: 'p-1', presets: [preset({ id: 'p-1' })] };
  const next = P.deletePreset(store, 'p-1');
  assert.equal(next.selectedId, null);
  assert.equal(next.presets.length, 0);
});

test('選択外のプリセットを deletePreset すると selectedId は維持される', () => {
  const store = { version: 1, selectedId: 'p-1', presets: [preset({ id: 'p-1' }), preset({ id: 'p-2', name: 'B' })] };
  const next = P.deletePreset(store, 'p-2');
  assert.equal(next.selectedId, 'p-1');
  assert.equal(next.presets.length, 1);
});

test('selectPreset は null を渡すと選択を外す', () => {
  const store = { version: 1, selectedId: 'p-1', presets: [preset({ id: 'p-1' })] };
  assert.equal(P.selectPreset(store, null).selectedId, null);
});

test('存在する id を selectPreset すると選択される', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1' })] };
  assert.equal(P.selectPreset(store, 'p-1').selectedId, 'p-1');
});

test('存在しない id を selectPreset すると selectedId は null になる', () => {
  const store = { version: 1, selectedId: null, presets: [preset({ id: 'p-1' })] };
  assert.equal(P.selectPreset(store, 'nope').selectedId, null);
});

test('trackpadScreenValues は側ごとの保留 > 共通の保留 > キーボード値の優先順で画面値を作る', () => {
  const paramsBySide = {
    R: [{ name: 'a', value: 100 }, { name: 'b', value: 200 }],
    L: [{ name: 'a', value: 100 }],
  };
  const pending = { common: { a: 10 }, R: { b: 20 } };
  assert.deepEqual(P.trackpadScreenValues(paramsBySide, pending), {
    R: { a: 10, b: 20 },
    L: { a: 10 },
  });
});

test('trackpadScreenValues はパラメータが空の側のキーを持たない', () => {
  const paramsBySide = { R: [{ name: 'a', value: 1 }], L: [] };
  assert.deepEqual(P.trackpadScreenValues(paramsBySide, { common: {}, R: {}, L: {} }), { R: { a: 1 } });
  assert.deepEqual(P.trackpadScreenValues({ R: [], L: [] }, {}), {});
});

test('trackpadDiff は値の違う名前だけを R → L の順で返す', () => {
  const presetTrackpad = { R: { a: 1, b: 2 }, L: { a: 1 } };
  const screen = { R: { a: 9, b: 2 }, L: { a: 5 } };
  assert.deepEqual(P.trackpadDiff(presetTrackpad, screen), [
    { side: 'R', name: 'a', preset: 1, screen: 9 },
    { side: 'L', name: 'a', preset: 1, screen: 5 },
  ]);
});

test('trackpadDiff は片方にしかない名前を出さず、null なら空になる', () => {
  const presetTrackpad = { R: { a: 1 } };
  const screen = { R: { a: 1, b: 2 } };
  assert.deepEqual(P.trackpadDiff(presetTrackpad, screen), []);
  assert.deepEqual(P.trackpadDiff(null, screen), []);
});

test('trackpadPendingFromPreset は両側同値でキーボードの片側だけ違うとき common に入る', () => {
  const presetTrackpad = { R: { a: 50 }, L: { a: 50 } };
  const paramsBySide = { R: [{ name: 'a', value: 50 }], L: [{ name: 'a', value: 30 }] };
  assert.deepEqual(P.trackpadPendingFromPreset(presetTrackpad, paramsBySide), { common: { a: 50 }, R: {}, L: {} });
});

test('trackpadPendingFromPreset は両側で違う値なら R / L 別に入る', () => {
  const presetTrackpad = { R: { a: 10 }, L: { a: 20 } };
  const paramsBySide = { R: [{ name: 'a', value: 1 }], L: [{ name: 'a', value: 2 }] };
  assert.deepEqual(P.trackpadPendingFromPreset(presetTrackpad, paramsBySide), { common: {}, R: { a: 10 }, L: { a: 20 } });
});

test('trackpadPendingFromPreset はキーボードと同じ値なら何も入らない', () => {
  const presetTrackpad = { R: { a: 10 }, L: { a: 10 } };
  const paramsBySide = { R: [{ name: 'a', value: 10 }], L: [{ name: 'a', value: 10 }] };
  assert.deepEqual(P.trackpadPendingFromPreset(presetTrackpad, paramsBySide), { common: {}, R: {}, L: {} });
});

test('trackpadPendingFromPreset は読めていない側(params空)を無視する', () => {
  const presetTrackpad = { R: { a: 10 }, L: { a: 99 } };
  const paramsBySide = { R: [{ name: 'a', value: 1 }], L: [] };
  assert.deepEqual(P.trackpadPendingFromPreset(presetTrackpad, paramsBySide), { common: {}, R: { a: 10 }, L: {} });
});

test('trackpadPendingFromPreset はプリセットに無い名前を無視する', () => {
  const presetTrackpad = { R: { a: 10 } };
  const paramsBySide = { R: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }], L: [{ name: 'a', value: 10 }] };
  const result = P.trackpadPendingFromPreset(presetTrackpad, paramsBySide);
  assert.equal(Object.prototype.hasOwnProperty.call(result.common, 'b'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.R, 'b'), false);
});

test('trackpadPendingFromPreset は presetTrackpad が null なら全て空になる', () => {
  assert.deepEqual(P.trackpadPendingFromPreset(null, { R: [{ name: 'a', value: 1 }] }), { common: {}, R: {}, L: {} });
});

const KP_BEHAVIOR = { id: 1, displayName: 'Key Press', metadata: [{ param1: [{ hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }], param2: [] }] };
const MO_BEHAVIOR = { id: 2, displayName: 'Momentary Layer', metadata: [{ param1: [{ layerId: {} }], param2: [] }] };
const TRANS_BEHAVIOR = { id: 3, displayName: 'Transparent', metadata: [] };
const BEHAVIORS = [KP_BEHAVIOR, MO_BEHAVIOR, TRANS_BEHAVIOR];

test('keymapSnapshot は Key Press をそのままの entry にする', () => {
  const keymap = { layers: [{ id: 10, name: 'Default', bindings: [{ behaviorId: 1, param1: 0x70004, param2: 0 }] }] };
  const snap = P.keymapSnapshot(keymap, BEHAVIORS, []);
  assert.deepEqual(snap, { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 0x70004, param2: 0 }] }] });
});

test('keymapSnapshot は Momentary Layer の param1 をレイヤー番号の { layer } にする', () => {
  const keymap = {
    layers: [
      { id: 10, name: 'Default', bindings: [{ behaviorId: 2, param1: 20, param2: 0 }] },
      { id: 20, name: 'Fn', bindings: [{ behaviorId: 3, param1: 0, param2: 0 }] },
    ],
  };
  const snap = P.keymapSnapshot(keymap, BEHAVIORS, []);
  assert.deepEqual(snap.layers[0].bindings[0], { behavior: 'Momentary Layer', param1: { layer: 1 }, param2: 0 });
});

test('keymapSnapshot は hidden 位置を null にする', () => {
  const keymap = { layers: [{ id: 10, name: 'Default', bindings: [{ behaviorId: 1, param1: 1, param2: 0 }, { behaviorId: 1, param1: 2, param2: 0 }] }] };
  const snap = P.keymapSnapshot(keymap, BEHAVIORS, [1]);
  assert.deepEqual(snap.layers[0].bindings, [{ behavior: 'Key Press', param1: 1, param2: 0 }, null]);
});

test('keymapSnapshot は未知の behaviorId を behavior: null にする', () => {
  const keymap = { layers: [{ id: 10, name: 'Default', bindings: [{ behaviorId: 999, param1: 1, param2: 2 }] }] };
  const snap = P.keymapSnapshot(keymap, BEHAVIORS, []);
  assert.deepEqual(snap.layers[0].bindings[0], { behavior: null, param1: 1, param2: 2 });
});

test('entriesEqual は behavior 名と param1 / param2 が等しいとき true になる', () => {
  assert.equal(P.entriesEqual({ behavior: 'Key Press', param1: 1, param2: 0 }, { behavior: 'Key Press', param1: 1, param2: 0 }), true);
  assert.equal(P.entriesEqual({ behavior: 'Key Press', param1: 1, param2: 0 }, { behavior: 'Key Press', param1: 2, param2: 0 }), false);
});

test('entriesEqual は { layer } 同士をレイヤー番号で比較する', () => {
  assert.equal(P.entriesEqual({ behavior: 'Momentary Layer', param1: { layer: 1 }, param2: 0 }, { behavior: 'Momentary Layer', param1: { layer: 1 }, param2: 0 }), true);
  assert.equal(P.entriesEqual({ behavior: 'Momentary Layer', param1: { layer: 1 }, param2: 0 }, { behavior: 'Momentary Layer', param1: { layer: 2 }, param2: 0 }), false);
});

test('entriesEqual はどちらかが null なら参照の一致で判定する', () => {
  assert.equal(P.entriesEqual(null, null), true);
  assert.equal(P.entriesEqual(null, { behavior: 'Key Press', param1: 1, param2: 0 }), false);
});

test('keymapDiff は同一なら空になる', () => {
  const snap = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 1, param2: 0 }] }] };
  assert.deepEqual(P.keymapDiff(snap, snap), { layerCount: null, keys: [] });
});

test('keymapDiff は 1 キー違うと 1 件返す', () => {
  const preset = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 1, param2: 0 }] }] };
  const screen = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 2, param2: 0 }] }] };
  assert.deepEqual(P.keymapDiff(preset, screen), {
    layerCount: null,
    keys: [{ layer: 0, pos: 0, preset: preset.layers[0].bindings[0], screen: screen.layers[0].bindings[0] }],
  });
});

test('keymapDiff は hidden(null)位置を比較しない', () => {
  const preset = { layers: [{ name: 'Default', bindings: [null] }] };
  const screen = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 1, param2: 0 }] }] };
  assert.deepEqual(P.keymapDiff(preset, screen), { layerCount: null, keys: [] });
});

test('keymapDiff はレイヤー数が違うと layerCount と共通範囲の keys を返す', () => {
  const preset = {
    layers: [
      { name: 'Default', bindings: [{ behavior: 'Key Press', param1: 1, param2: 0 }] },
      { name: 'Fn', bindings: [{ behavior: 'Key Press', param1: 2, param2: 0 }] },
    ],
  };
  const screen = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 9, param2: 0 }] }] };
  assert.deepEqual(P.keymapDiff(preset, screen), {
    layerCount: { preset: 2, screen: 1 },
    keys: [{ layer: 0, pos: 0, preset: preset.layers[0].bindings[0], screen: screen.layers[0].bindings[0] }],
  });
});

test('keymapDiff はどちらかが null なら空を返す', () => {
  assert.deepEqual(P.keymapDiff(null, { layers: [] }), { layerCount: null, keys: [] });
  assert.deepEqual(P.keymapDiff({ layers: [] }, null), { layerCount: null, keys: [] });
});

test('diffCount はパラメータ差分・キー差分・レイヤー数差分(1件)を合算する', () => {
  assert.equal(P.diffCount([{ side: 'R', name: 'a' }], { layerCount: { preset: 2, screen: 1 }, keys: [{}, {}] }), 4);
  assert.equal(P.diffCount([], { layerCount: null, keys: [] }), 0);
  assert.equal(P.diffCount(null, null), 0);
});

test('resolveEntry は behavior 名から ID を引き、{ layer } をレイヤー ID に直す', () => {
  const layers = [{ id: 10 }, { id: 20 }];
  assert.deepEqual(P.resolveEntry({ behavior: 'Key Press', param1: 5, param2: 0 }, BEHAVIORS, layers), { behaviorId: 1, param1: 5, param2: 0 });
  assert.deepEqual(P.resolveEntry({ behavior: 'Momentary Layer', param1: { layer: 1 }, param2: 0 }, BEHAVIORS, layers), { behaviorId: 2, param1: 20, param2: 0 });
});

test('resolveEntry は未知の behavior だと null になる', () => {
  assert.equal(P.resolveEntry({ behavior: 'Nope', param1: 0, param2: 0 }, BEHAVIORS, []), null);
});

test('resolveEntry は範囲外のレイヤーだと null になる', () => {
  assert.equal(P.resolveEntry({ behavior: 'Momentary Layer', param1: { layer: 5 }, param2: 0 }, BEHAVIORS, [{ id: 10 }]), null);
});

test('layerCountAdjust はプリセットの方が多ければ add、少なければ remove になる', () => {
  const preset2 = { layers: [{}, {}] };
  const keymap1 = { layers: [{}] };
  assert.deepEqual(P.layerCountAdjust(preset2, keymap1), { add: 1, remove: 0 });
  assert.deepEqual(P.layerCountAdjust(keymap1, preset2), { add: 0, remove: 1 });
  assert.deepEqual(P.layerCountAdjust(keymap1, keymap1), { add: 0, remove: 0 });
});

test('planKeymapBindings は違う位置だけを ops にする', () => {
  const keymap = { layers: [{ id: 10, bindings: [{ behaviorId: 1, param1: 1, param2: 0 }, { behaviorId: 1, param1: 2, param2: 0 }] }] };
  const presetKeymap = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 9, param2: 0 }, { behavior: 'Key Press', param1: 2, param2: 0 }] }] };
  const plan = P.planKeymapBindings(presetKeymap, keymap, BEHAVIORS);
  assert.deepEqual(plan, {
    ops: [{ layerIndex: 0, layerId: 10, pos: 0, binding: { behaviorId: 1, param1: 9, param2: 0 } }],
    skipped: [],
  });
});

test('planKeymapBindings は未知 behavior を skipped にする', () => {
  const keymap = { layers: [{ id: 10, bindings: [{ behaviorId: 1, param1: 1, param2: 0 }] }] };
  const presetKeymap = { layers: [{ name: 'Default', bindings: [{ behavior: 'Nope', param1: 0, param2: 0 }] }] };
  const plan = P.planKeymapBindings(presetKeymap, keymap, BEHAVIORS);
  assert.deepEqual(plan, { ops: [], skipped: [{ layer: 0, pos: 0, behavior: 'Nope' }] });
});

test('planKeymapBindings は同じ位置を ops に出さない', () => {
  const keymap = { layers: [{ id: 10, bindings: [{ behaviorId: 1, param1: 1, param2: 0 }] }] };
  const presetKeymap = { layers: [{ name: 'Default', bindings: [{ behavior: 'Key Press', param1: 1, param2: 0 }] }] };
  const plan = P.planKeymapBindings(presetKeymap, keymap, BEHAVIORS);
  assert.deepEqual(plan, { ops: [], skipped: [] });
});
