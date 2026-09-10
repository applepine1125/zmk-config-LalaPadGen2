(function (root) {
  'use strict';

  const TpKeycodes = (typeof module !== 'undefined' && module.exports) ? require('./keycodes.js') : root.TpKeycodes;

  const MOD_ORDER = ['LC', 'LS', 'LA', 'LG', 'RC', 'RS', 'RA', 'RG'];

  function cornersOf(key) {
    const x = key.x / 100;
    const y = key.y / 100;
    const w = key.width / 100;
    const h = key.height / 100;
    const rx = (key.rx || 0) / 100;
    const ry = (key.ry || 0) / 100;
    const angle = ((key.r || 0) / 100) * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => {
      const dx = px - rx;
      const dy = py - ry;
      return { x: rx + dx * cos - dy * sin, y: ry + dx * sin + dy * cos };
    });
  }

  function layoutBounds(keys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const key of keys || []) {
      for (const c of cornersOf(key)) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x > maxX) maxX = c.x;
        if (c.y > maxY) maxY = c.y;
      }
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function keyRect(key, scale) {
    return {
      x: (key.x / 100) * scale,
      y: (key.y / 100) * scale,
      width: (key.width / 100) * scale,
      height: (key.height / 100) * scale,
      angle: (key.r || 0) / 100,
      cx: ((key.rx || 0) / 100) * scale,
      cy: ((key.ry || 0) / 100) * scale,
    };
  }

  function paramDescKind(desc) {
    if (!desc) return null;
    if (desc.nil) return 'nil';
    if (desc.constant !== undefined) return 'constant';
    if (desc.range !== undefined) return 'range';
    if (desc.hidUsage !== undefined) return 'hidUsage';
    if (desc.layerId) return 'layerId';
    return null;
  }

  function describeParamSlot(arr) {
    const list = arr || [];
    if (list.length === 0) return { kind: 'none' };
    const kinds = list.map(paramDescKind);
    if (kinds.includes('hidUsage')) {
      const d = list.find((x) => paramDescKind(x) === 'hidUsage');
      return { kind: 'hidUsage', hidUsage: d.hidUsage };
    }
    if (kinds.includes('layerId')) return { kind: 'layerId' };
    if (kinds.includes('range')) {
      const d = list.find((x) => paramDescKind(x) === 'range');
      return { kind: 'range', range: d.range };
    }
    const options = list
      .filter((x) => paramDescKind(x) === 'constant')
      .map((x) => ({ name: x.name, value: x.constant }));
    if (options.length) return { kind: 'constant', options };
    if (kinds.includes('nil')) return { kind: 'nil' };
    return { kind: 'none' };
  }

  function layerIndexById(layers, id) {
    return (layers || []).findIndex((l) => l.id === id);
  }

  function valueFitsSlot(slot, value, layers) {
    switch (slot.kind) {
      case 'none': return value === 0;
      case 'nil': return value === 0;
      case 'hidUsage': return true;
      case 'layerId': return layerIndexById(layers, value) !== -1;
      case 'range': return value >= slot.range.min && value <= slot.range.max;
      case 'constant': return slot.options.some((o) => o.value === value);
      default: return true;
    }
  }

  function findMatchingSetIndex(behavior, binding, layers) {
    const sets = (behavior && behavior.metadata) || [];
    for (let i = 0; i < sets.length; i++) {
      const s1 = describeParamSlot(sets[i].param1);
      const s2 = describeParamSlot(sets[i].param2);
      if (valueFitsSlot(s1, binding.param1, layers) && valueFitsSlot(s2, binding.param2, layers)) return i;
    }
    return sets.length ? 0 : -1;
  }

  function modLabelPrefix(mods) {
    const m = mods || 0;
    let out = '';
    if (m & (TpKeycodes.MODS.LC | TpKeycodes.MODS.RC)) out += '⌃';
    if (m & (TpKeycodes.MODS.LS | TpKeycodes.MODS.RS)) out += '⇧';
    if (m & (TpKeycodes.MODS.LA | TpKeycodes.MODS.RA)) out += '⌥';
    if (m & (TpKeycodes.MODS.LG | TpKeycodes.MODS.RG)) out += '⌘';
    return out;
  }

  function baseKeyForPageId(page, id) {
    for (const k of TpKeycodes.KEYS) {
      const d = TpKeycodes.decodeUsage(k.value);
      if (d.mods === 0 && d.page === page && d.id === id) return k;
    }
    return null;
  }

  function formatHidUsageLabel(value) {
    const v = value >>> 0;
    const exact = TpKeycodes.findByValue(v);
    if (exact) return exact.label;
    const d = TpKeycodes.decodeUsage(v);
    const base = baseKeyForPageId(d.page, d.id);
    const prefix = modLabelPrefix(d.mods);
    if (base) return prefix + base.label;
    return prefix + d.page + ':' + d.id;
  }

  function findBehavior(behaviors, id) {
    return (behaviors || []).find((b) => b.id === id) || null;
  }

  function shortBehaviorName(displayName) {
    if (!displayName) return '?';
    const words = displayName.trim().split(/\s+/);
    if (words.length === 1) return words[0].slice(0, 4);
    return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  }

  function describeSlotValue(slot, value, layers) {
    switch (slot.kind) {
      case 'none':
      case 'nil':
        return null;
      case 'hidUsage':
        return formatHidUsageLabel(value);
      case 'layerId': {
        const idx = layerIndexById(layers, value);
        return 'L' + (idx >= 0 ? idx : value);
      }
      default:
        return String(value);
    }
  }

  function bindingLabel(binding, behaviors, layers) {
    if (!binding) return '';
    const behavior = findBehavior(behaviors, binding.behaviorId);
    if (!behavior) return '?';
    const name = behavior.displayName || '';
    if (/^transparent$/i.test(name)) return '▽';
    if (/^none$/i.test(name)) return '×';
    const setIdx = findMatchingSetIndex(behavior, binding, layers);
    const set = setIdx >= 0 ? behavior.metadata[setIdx] : null;
    const slot1 = set ? describeParamSlot(set.param1) : { kind: 'none' };
    const slot2 = set ? describeParamSlot(set.param2) : { kind: 'none' };
    const p1 = describeSlotValue(slot1, binding.param1, layers);
    const p2 = describeSlotValue(slot2, binding.param2, layers);
    const parts = [p1, p2].filter((s) => s !== null && s !== '');
    if (parts.length) return parts.join(' ');
    return shortBehaviorName(name);
  }

  function filterKeycodes(keys, query) {
    const q = (query || '').trim().toUpperCase();
    if (!q) return keys;
    return keys.filter((k) => {
      if (k.name.toUpperCase().includes(q)) return true;
      if (k.label && k.label.toUpperCase().includes(q)) return true;
      return (k.aliases || []).some((a) => a.toUpperCase().includes(q));
    });
  }

  function groupKeycodes(keys) {
    const out = {};
    for (const k of keys) (out[k.group] || (out[k.group] = [])).push(k);
    return out;
  }

  function modsFromFlags(flags) {
    let out = 0;
    for (const key of MOD_ORDER) if (flags && flags[key]) out |= TpKeycodes.MODS[key];
    return out;
  }

  function flagsFromMods(mods) {
    const out = {};
    for (const key of MOD_ORDER) out[key] = !!((mods || 0) & TpKeycodes.MODS[key]);
    return out;
  }

  const api = {
    MOD_ORDER,
    layoutBounds, keyRect,
    paramDescKind, describeParamSlot, valueFitsSlot, findMatchingSetIndex,
    layerIndexById, modLabelPrefix, formatHidUsageLabel, bindingLabel,
    filterKeycodes, groupKeycodes, modsFromFlags, flagsFromMods,
  };
  root.TpKeymapUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
