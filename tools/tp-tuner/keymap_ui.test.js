const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('./keymap_ui.js');
const K = require('./keycodes.js');

test('layoutBounds は回転なしのキー群から外接矩形をキー単位で計算する', () => {
  const keys = [
    { x: 0, y: 0, width: 100, height: 100, r: 0, rx: 0, ry: 0 },
    { x: 100, y: 0, width: 100, height: 100, r: 0, rx: 0, ry: 0 },
  ];
  assert.deepEqual(U.layoutBounds(keys), { minX: 0, minY: 0, maxX: 2, maxY: 1, width: 2, height: 1 });
});

test('layoutBounds はキーが無いとき全て0を返す', () => {
  assert.deepEqual(U.layoutBounds([]), { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 });
});

test('layoutBounds は90度回転したキーの外接矩形を回転後の座標で計算する', () => {
  const keys = [{ x: 0, y: 0, width: 200, height: 100, r: 9000, rx: 0, ry: 0 }];
  const b = U.layoutBounds(keys);
  assert.ok(Math.abs(b.width - 1) < 1e-9);
  assert.ok(Math.abs(b.height - 2) < 1e-9);
});

test('keyRect はキー単位の値を scale 倍した px 座標に変換する', () => {
  const key = { x: 150, y: 50, width: 100, height: 100, r: 9000, rx: 150, ry: 50 };
  assert.deepEqual(U.keyRect(key, 40), { x: 60, y: 20, width: 40, height: 40, angle: 90, cx: 60, cy: 20 });
});

test('paramDescKind は nil/constant/range/hidUsage/layerId を判定する', () => {
  assert.equal(U.paramDescKind({ name: '', nil: true }), 'nil');
  assert.equal(U.paramDescKind({ name: '', constant: 3 }), 'constant');
  assert.equal(U.paramDescKind({ name: '', range: { min: 0, max: 9 } }), 'range');
  assert.equal(U.paramDescKind({ name: '', hidUsage: { keyboardMax: 1, consumerMax: 1 } }), 'hidUsage');
  assert.equal(U.paramDescKind({ name: '', layerId: true }), 'layerId');
  assert.equal(U.paramDescKind(undefined), null);
});

test('describeParamSlot は空配列なら none、単一種別ならその種別を返す', () => {
  assert.deepEqual(U.describeParamSlot([]), { kind: 'none' });
  assert.deepEqual(U.describeParamSlot(undefined), { kind: 'none' });
  assert.deepEqual(U.describeParamSlot([{ name: '', nil: true }]), { kind: 'nil' });
  assert.deepEqual(
    U.describeParamSlot([{ name: '', range: { min: 0, max: 9 } }]),
    { kind: 'range', range: { min: 0, max: 9 } },
  );
  assert.deepEqual(
    U.describeParamSlot([{ name: '', hidUsage: { keyboardMax: 1, consumerMax: 0 } }]),
    { kind: 'hidUsage', hidUsage: { keyboardMax: 1, consumerMax: 0 } },
  );
  assert.deepEqual(U.describeParamSlot([{ name: '', layerId: true }]), { kind: 'layerId' });
});

test('describeParamSlot は複数の constant 候補を名前つき選択肢としてまとめる', () => {
  const slot = U.describeParamSlot([
    { name: 'CMD_A', constant: 1 },
    { name: 'CMD_B', constant: 2 },
  ]);
  assert.deepEqual(slot, { kind: 'constant', options: [{ name: 'CMD_A', value: 1 }, { name: 'CMD_B', value: 2 }] });
});

test('valueFitsSlot は各種別ごとに値が候補に収まるか判定する', () => {
  assert.equal(U.valueFitsSlot({ kind: 'none' }, 0), true);
  assert.equal(U.valueFitsSlot({ kind: 'none' }, 1), false);
  assert.equal(U.valueFitsSlot({ kind: 'range', range: { min: 1, max: 5 } }, 5), true);
  assert.equal(U.valueFitsSlot({ kind: 'range', range: { min: 1, max: 5 } }, 6), false);
  assert.equal(U.valueFitsSlot({ kind: 'constant', options: [{ name: 'A', value: 2 }] }, 2), true);
  assert.equal(U.valueFitsSlot({ kind: 'constant', options: [{ name: 'A', value: 2 }] }, 3), false);
  const layers = [{ id: 0 }, { id: 5 }];
  assert.equal(U.valueFitsSlot({ kind: 'layerId' }, 5, layers), true);
  assert.equal(U.valueFitsSlot({ kind: 'layerId' }, 9, layers), false);
});

test('findMatchingSetIndex は現在の param 値に合う metadata セットを選ぶ', () => {
  const behavior = {
    metadata: [
      { param1: [{ name: '', constant: 1 }], param2: [] },
      { param1: [{ name: '', range: { min: 0, max: 100 } }], param2: [] },
    ],
  };
  assert.equal(U.findMatchingSetIndex(behavior, { param1: 1, param2: 0 }, []), 0);
  assert.equal(U.findMatchingSetIndex(behavior, { param1: 50, param2: 0 }, []), 1);
  assert.equal(U.findMatchingSetIndex(behavior, { param1: -1, param2: 0 }, []), 0);
});

test('findMatchingSetIndex は metadata が空なら -1 を返す', () => {
  assert.equal(U.findMatchingSetIndex({ metadata: [] }, { param1: 0, param2: 0 }, []), -1);
  assert.equal(U.findMatchingSetIndex(null, { param1: 0, param2: 0 }, []), -1);
});

test('formatHidUsageLabel はカタログに一致する値をそのラベルで表示する', () => {
  const excl = K.KEYS.find((k) => k.name === 'EXCLAMATION');
  assert.equal(U.formatHidUsageLabel(excl.value), '!');
});

test('formatHidUsageLabel はカタログにない修飾の組み合わせに ⌃⇧⌥⌘ を前置する', () => {
  const a = K.KEYS.find((k) => k.name === 'A');
  const lcA = K.encodeUsage(a.page, a.id, K.MODS.LC);
  assert.equal(U.formatHidUsageLabel(lcA), '⌃A');
  const lcsA = K.encodeUsage(a.page, a.id, K.MODS.LC | K.MODS.LS | K.MODS.LG);
  assert.equal(U.formatHidUsageLabel(lcsA), '⌃⇧⌘A');
});

test('formatHidUsageLabel は未知の usage を page:id 表示にフォールバックする', () => {
  const v = K.encodeUsage(99, 999, 0);
  assert.equal(U.formatHidUsageLabel(v), '99:999');
});

test('bindingLabel は Transparent と None を短い記号にする', () => {
  const behaviors = [
    { id: 1, displayName: 'Transparent', metadata: [] },
    { id: 2, displayName: 'None', metadata: [] },
  ];
  assert.equal(U.bindingLabel({ behaviorId: 1, param1: 0, param2: 0 }, behaviors, []), '▽');
  assert.equal(U.bindingLabel({ behaviorId: 2, param1: 0, param2: 0 }, behaviors, []), '×');
});

test('bindingLabel は kp を修飾つきキーコード表示にする', () => {
  const a = K.KEYS.find((k) => k.name === 'A');
  const behaviors = [{
    id: 3,
    displayName: 'Key Press',
    metadata: [{ param1: [{ name: '', hidUsage: { keyboardMax: 65535, consumerMax: 65535 } }], param2: [] }],
  }];
  const usage = K.encodeUsage(a.page, a.id, K.MODS.LG);
  assert.equal(U.bindingLabel({ behaviorId: 3, param1: usage, param2: 0 }, behaviors, []), '⌘A');
});

test('bindingLabel は Momentary Layer を L<index> 表示にする', () => {
  const behaviors = [{
    id: 4,
    displayName: 'Momentary Layer',
    metadata: [{ param1: [{ name: '', layerId: true }], param2: [] }],
  }];
  const layers = [{ id: 10, name: 'Default' }, { id: 20, name: 'Fn' }];
  assert.equal(U.bindingLabel({ behaviorId: 4, param1: 20, param2: 0 }, behaviors, layers), 'L1');
});

test('bindingLabel は未知の behaviorId に ? を返す', () => {
  assert.equal(U.bindingLabel({ behaviorId: 999, param1: 0, param2: 0 }, [], []), '?');
});

test('bindingLabel は metadata が無い behavior を短縮名で表示する', () => {
  const behaviors = [{ id: 5, displayName: 'Zip Dynamic Scale', metadata: [] }];
  assert.equal(U.bindingLabel({ behaviorId: 5, param1: 3, param2: 0 }, behaviors, []), 'ZDS');
});

test('filterKeycodes は名前・ラベル・別名の部分一致で絞り込む', () => {
  const keys = [
    { name: 'N1', label: '1', aliases: ['NUMBER_1', 'NUM_1'], group: '数字' },
    { name: 'A', label: 'A', aliases: [], group: '文字' },
  ];
  assert.deepEqual(U.filterKeycodes(keys, 'num'), [keys[0]]);
  assert.deepEqual(U.filterKeycodes(keys, ''), keys);
  assert.deepEqual(U.filterKeycodes(keys, 'a'), [keys[1]]);
});

test('groupKeycodes はグループ名ごとに配列へまとめる', () => {
  const keys = [
    { name: 'A', group: '文字' },
    { name: 'B', group: '文字' },
    { name: 'N1', group: '数字' },
  ];
  assert.deepEqual(U.groupKeycodes(keys), {
    文字: [keys[0], keys[1]],
    数字: [keys[2]],
  });
});

test('modsFromFlags と flagsFromMods は往復できる', () => {
  const flags = { LC: true, LS: false, LA: true, LG: false, RC: false, RS: false, RA: false, RG: true };
  const mods = U.modsFromFlags(flags);
  assert.equal(mods, K.MODS.LC | K.MODS.LA | K.MODS.RG);
  assert.deepEqual(U.flagsFromMods(mods), flags);
});
