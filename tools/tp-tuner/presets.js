(function (root) {
  'use strict';

  const TpKeymapUi = (typeof module !== 'undefined' && module.exports) ? require('./keymap_ui.js') : root.TpKeymapUi;

  const STORE_VERSION = 1;

  function emptyStore() {
    return { version: STORE_VERSION, selectedId: null, presets: [] };
  }

  function parseStore(text) {
    if (text === null || text === undefined || text === '') {
      return { ok: true, store: emptyStore() };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'JSON を解析できません' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'ストアの形式が不正です' };
    }
    if (data.version !== STORE_VERSION) {
      return { ok: false, error: '対応していない version です' };
    }
    if (!Array.isArray(data.presets)) {
      return { ok: false, error: 'presets が配列ではありません' };
    }
    const presets = data.presets
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        ...p,
        trackpad: p.trackpad || null,
        keymap: p.keymap || null,
      }));
    const selectedId = presets.some((p) => p.id === data.selectedId) ? data.selectedId : null;
    return { ok: true, store: { version: STORE_VERSION, selectedId, presets } };
  }

  function serializeStore(store) {
    return JSON.stringify(store, null, 2) + '\n';
  }

  function findPreset(store, id) {
    return store.presets.find((p) => p.id === id) || null;
  }

  function validateName(store, name, exceptId) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, error: '名前を入力してください' };
    const dup = store.presets.some((p) => p.id !== exceptId && p.name === trimmed);
    if (dup) return { ok: false, error: '同じ名前のプリセットがあります' };
    return { ok: true, name: trimmed };
  }

  function createPreset(store, { name, trackpad, keymap }, { id, now }) {
    const v = validateName(store, name);
    if (!v.ok) return { ok: false, error: v.error };
    const preset = {
      id, name: v.name, createdAt: now, updatedAt: now,
      trackpad: trackpad || null, keymap: keymap || null,
    };
    const newStore = {
      ...store,
      presets: [...store.presets, preset],
      selectedId: id,
    };
    return { ok: true, store: newStore, preset };
  }

  function mergeTrackpad(existing, next) {
    if (!next) return existing || null;
    return { ...(existing || {}), ...next };
  }

  function updatePreset(store, id, { trackpad, keymap }, now) {
    const idx = store.presets.findIndex((p) => p.id === id);
    if (idx === -1) return store;
    const preset = store.presets[idx];
    const newPreset = {
      ...preset,
      trackpad: trackpad ? mergeTrackpad(preset.trackpad, trackpad) : preset.trackpad,
      keymap: keymap ? keymap : preset.keymap,
      updatedAt: now,
    };
    const presets = store.presets.slice();
    presets[idx] = newPreset;
    return { ...store, presets };
  }

  function deletePreset(store, id) {
    const presets = store.presets.filter((p) => p.id !== id);
    const selectedId = store.selectedId === id ? null : store.selectedId;
    return { ...store, presets, selectedId };
  }

  function selectPreset(store, id) {
    if (id === null) return { ...store, selectedId: null };
    const exists = store.presets.some((p) => p.id === id);
    return { ...store, selectedId: exists ? id : null };
  }

  function trackpadScreenValues(paramsBySide, pending) {
    const out = {};
    const p = pending || {};
    const common = p.common || {};
    for (const side of ['R', 'L']) {
      const params = paramsBySide && paramsBySide[side];
      if (!params || !params.length) continue;
      const perSide = p[side] || {};
      const values = {};
      for (const param of params) {
        const name = param.name;
        let v;
        if (Object.prototype.hasOwnProperty.call(perSide, name)) v = perSide[name];
        else if (Object.prototype.hasOwnProperty.call(common, name)) v = common[name];
        else v = param.value;
        values[name] = v;
      }
      out[side] = values;
    }
    return out;
  }

  function trackpadDiff(presetTrackpad, screen) {
    if (!presetTrackpad) return [];
    const out = [];
    for (const side of ['R', 'L']) {
      const presetSide = presetTrackpad[side];
      const screenSide = screen && screen[side];
      if (!presetSide || !screenSide) continue;
      for (const name of Object.keys(screenSide)) {
        if (!Object.prototype.hasOwnProperty.call(presetSide, name)) continue;
        const presetVal = presetSide[name];
        const screenVal = screenSide[name];
        if (presetVal !== screenVal) out.push({ side, name, preset: presetVal, screen: screenVal });
      }
    }
    return out;
  }

  function keyboardValue(paramsBySide, side, name) {
    const params = paramsBySide && paramsBySide[side];
    if (!params) return undefined;
    const p = params.find((x) => x.name === name);
    return p ? p.value : undefined;
  }

  function trackpadPendingFromPreset(presetTrackpad, paramsBySide) {
    const out = { common: {}, R: {}, L: {} };
    if (!presetTrackpad) return out;
    const readableSides = ['R', 'L'].filter((s) => paramsBySide && Array.isArray(paramsBySide[s]) && paramsBySide[s].length > 0);
    const names = new Set();
    for (const s of readableSides) {
      const pt = presetTrackpad[s];
      if (pt) for (const n of Object.keys(pt)) names.add(n);
    }
    for (const name of names) {
      const presetSidesForName = ['R', 'L'].filter((s) => presetTrackpad[s] && Object.prototype.hasOwnProperty.call(presetTrackpad[s], name));
      const presetValues = presetSidesForName.map((s) => presetTrackpad[s][name]);
      const allSame = presetValues.every((v) => v === presetValues[0]);
      const coversReadable = readableSides.every((s) => presetSidesForName.includes(s));
      if (allSame && coversReadable) {
        const v = presetValues[0];
        const differs = readableSides.some((s) => keyboardValue(paramsBySide, s, name) !== v);
        if (differs) out.common[name] = v;
      } else {
        for (const s of readableSides) {
          const pv = presetTrackpad[s] ? presetTrackpad[s][name] : undefined;
          if (pv === undefined) continue;
          if (keyboardValue(paramsBySide, s, name) !== pv) out[s][name] = pv;
        }
      }
    }
    return out;
  }

  function paramForSnapshot(slot, value, layers) {
    if (slot.kind !== 'layerId') return value;
    const idx = TpKeymapUi.layerIndexById(layers, value);
    return idx >= 0 ? { layer: idx } : value;
  }

  function bindingToEntry(binding, behaviors, layers) {
    const behavior = (behaviors || []).find((b) => b.id === binding.behaviorId);
    if (!behavior) return { behavior: null, param1: binding.param1, param2: binding.param2 };
    const setIdx = TpKeymapUi.findMatchingSetIndex(behavior, binding, layers);
    const set = setIdx >= 0 ? behavior.metadata[setIdx] : null;
    const slot1 = set ? TpKeymapUi.describeParamSlot(set.param1) : { kind: 'none' };
    const slot2 = set ? TpKeymapUi.describeParamSlot(set.param2) : { kind: 'none' };
    return {
      behavior: behavior.displayName,
      param1: paramForSnapshot(slot1, binding.param1, layers),
      param2: paramForSnapshot(slot2, binding.param2, layers),
    };
  }

  function keymapSnapshot(keymap, behaviors, hiddenPositions) {
    const hidden = hiddenPositions || [];
    const layers = (keymap.layers || []).map((layer) => ({
      name: layer.name,
      bindings: (layer.bindings || []).map((binding, pos) => (
        hidden.includes(pos) ? null : bindingToEntry(binding, behaviors, keymap.layers)
      )),
    }));
    return { layers };
  }

  function entryParamEqual(x, y) {
    const lx = x && typeof x === 'object' ? x.layer : undefined;
    const ly = y && typeof y === 'object' ? y.layer : undefined;
    if (lx !== undefined || ly !== undefined) return lx === ly;
    return x === y;
  }

  function entriesEqual(a, b) {
    if (a === null || b === null) return a === b;
    return a.behavior === b.behavior && entryParamEqual(a.param1, b.param1) && entryParamEqual(a.param2, b.param2);
  }

  function keymapDiff(presetKeymap, screenSnapshot) {
    if (!presetKeymap || !screenSnapshot) return { layerCount: null, keys: [] };
    const presetLayers = presetKeymap.layers || [];
    const screenLayers = screenSnapshot.layers || [];
    const layerCount = presetLayers.length === screenLayers.length
      ? null
      : { preset: presetLayers.length, screen: screenLayers.length };
    const commonLayerCount = Math.min(presetLayers.length, screenLayers.length);
    const keys = [];
    for (let layer = 0; layer < commonLayerCount; layer++) {
      const presetBindings = presetLayers[layer].bindings || [];
      const screenBindings = screenLayers[layer].bindings || [];
      const commonPos = Math.min(presetBindings.length, screenBindings.length);
      for (let pos = 0; pos < commonPos; pos++) {
        const p = presetBindings[pos];
        const s = screenBindings[pos];
        if (p === null || s === null) continue;
        if (!entriesEqual(p, s)) keys.push({ layer, pos, preset: p, screen: s });
      }
    }
    return { layerCount, keys };
  }

  function diffCount(trackpadDiffList, keymapDiffResult) {
    const tp = trackpadDiffList ? trackpadDiffList.length : 0;
    const km = keymapDiffResult ? keymapDiffResult.keys.length : 0;
    const lc = keymapDiffResult && keymapDiffResult.layerCount ? 1 : 0;
    return tp + km + lc;
  }

  function resolveParam(value, layers) {
    if (value && typeof value === 'object' && typeof value.layer === 'number') {
      const layer = (layers || [])[value.layer];
      return layer ? layer.id : undefined;
    }
    return value;
  }

  function resolveEntry(entry, behaviors, layers) {
    if (!entry) return null;
    const behavior = (behaviors || []).find((b) => b.displayName === entry.behavior);
    if (!behavior) return null;
    const param1 = resolveParam(entry.param1, layers);
    const param2 = resolveParam(entry.param2, layers);
    if (param1 === undefined || param2 === undefined) return null;
    return { behaviorId: behavior.id, param1, param2 };
  }

  function layerCountAdjust(presetKeymap, keymap) {
    const presetCount = (presetKeymap && presetKeymap.layers) ? presetKeymap.layers.length : 0;
    const currentCount = (keymap && keymap.layers) ? keymap.layers.length : 0;
    return { add: Math.max(0, presetCount - currentCount), remove: Math.max(0, currentCount - presetCount) };
  }

  function planKeymapBindings(presetKeymap, keymap, behaviors) {
    const ops = [];
    const skipped = [];
    const current = keymapSnapshot(keymap, behaviors, []);
    const presetLayers = presetKeymap.layers || [];
    const currentLayers = current.layers || [];
    const commonLayerCount = Math.min(presetLayers.length, currentLayers.length);
    for (let layerIndex = 0; layerIndex < commonLayerCount; layerIndex++) {
      const presetBindings = presetLayers[layerIndex].bindings || [];
      const currentBindings = currentLayers[layerIndex].bindings || [];
      const commonPos = Math.min(presetBindings.length, currentBindings.length);
      for (let pos = 0; pos < commonPos; pos++) {
        const presetEntry = presetBindings[pos];
        const currentEntry = currentBindings[pos];
        if (presetEntry === null) continue;
        if (entriesEqual(presetEntry, currentEntry)) continue;
        const resolved = resolveEntry(presetEntry, behaviors, keymap.layers);
        if (resolved) {
          ops.push({ layerIndex, layerId: keymap.layers[layerIndex].id, pos, binding: resolved });
        } else {
          skipped.push({ layer: layerIndex, pos, behavior: presetEntry.behavior });
        }
      }
    }
    return { ops, skipped };
  }

  const api = {
    STORE_VERSION, emptyStore, parseStore, serializeStore, findPreset, validateName,
    createPreset, updatePreset, deletePreset, selectPreset,
    trackpadScreenValues, trackpadDiff, trackpadPendingFromPreset,
    keymapSnapshot, entriesEqual, keymapDiff, diffCount, resolveEntry, layerCountAdjust, planKeymapBindings,
  };
  root.TpPresets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
