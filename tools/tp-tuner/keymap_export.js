(function (root) {
  'use strict';

  const TpKeycodes = (typeof module !== 'undefined' && module.exports) ? require('./keycodes.js') : root.TpKeycodes;
  const TpKeymapUi = (typeof module !== 'undefined' && module.exports) ? require('./keymap_ui.js') : root.TpKeymapUi;

  const BUILTIN_BEHAVIOR_LABELS = {
    'Key Press': 'kp',
    'Mod-Tap': 'mt',
    'Layer-Tap': 'lt',
    'Momentary Layer': 'mo',
    'Toggle Layer': 'tog',
    'To Layer': 'to',
    'Transparent': 'trans',
    'None': 'none',
    'Bluetooth': 'bt',
    'Output Selection': 'out',
    'Reset': 'sys_reset',
    'Bootloader': 'bootloader',
    'Mouse Key Press': 'mkp',
    'Sticky Key': 'sk',
    'Sticky Layer': 'sl',
    'Key Toggle': 'kt',
    'Key Repeat': 'key_repeat',
    'Caps Word': 'caps_word',
    'Grave/Escape': 'gresc',
    'Backlight': 'bl',
    'Underglow': 'rgb_ug',
    'External Power': 'ext_power',
    'Studio Unlock': 'studio_unlock',
  };

  const CUSTOM_NODE_LABELS = { mod_tap2: 'mt2' };
  const CUSTOM_SAME_LABEL_NAMES = ['zip_dyn_scale', 'zip_dyn_scale_set', 'tap_dance_layer_1and2'];

  const BT_CONST_LABELS = {
    'Select Profile': 'BT_SEL',
    'Disconnect Profile': 'BT_DISC',
    'Next Profile': 'BT_NXT',
    'Previous Profile': 'BT_PRV',
    'Clear All Profiles': 'BT_CLR_ALL',
    'Clear Selected Profile': 'BT_CLR',
  };
  const OUT_CONST_LABELS = {
    'Toggle Outputs': 'OUT_TOG',
    'USB Output': 'OUT_USB',
    'BLE Output': 'OUT_BLE',
  };

  // zmk-driver-iqs9151 の include/dt-bindings/zmk/zip_dynamic_scale.h に定義された値
  const ZDS_PARAM1_NAMES = { 0: 'ZDS_XY', 1: 'ZDS_SC', 2: 'ZDS_ALL' };
  const ZDS_PARAM2_NAMES = { 1: 'ZDS_INC', 2: 'ZDS_DEC', 3: 'ZDS_RST' };

  const MOD_WRAP_ORDER = ['LC', 'LS', 'LA', 'LG', 'RC', 'RS', 'RA', 'RG'];

  function escapeDisplayName(name) {
    return String(name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function baseKeyName(page, id) {
    for (const k of TpKeycodes.KEYS) {
      const d = TpKeycodes.decodeUsage(k.value);
      if (d.mods === 0 && d.page === page && d.id === id) return k.name;
    }
    return null;
  }

  function formatHidUsage(value) {
    const v = value >>> 0;
    const exact = TpKeycodes.findByValue(v);
    if (exact) return exact.name;
    const d = TpKeycodes.decodeUsage(v);
    const base = baseKeyName(d.page, d.id);
    if (!base) return '0x' + v.toString(16);
    let out = base;
    const order = MOD_WRAP_ORDER.slice().reverse();
    for (const mod of order) {
      if (d.mods & TpKeycodes.MODS[mod]) out = mod + '(' + out + ')';
    }
    return out;
  }

  function behaviorLabel(displayName, unresolved) {
    if (Object.prototype.hasOwnProperty.call(BUILTIN_BEHAVIOR_LABELS, displayName)) {
      return BUILTIN_BEHAVIOR_LABELS[displayName];
    }
    if (Object.prototype.hasOwnProperty.call(CUSTOM_NODE_LABELS, displayName)) {
      return CUSTOM_NODE_LABELS[displayName];
    }
    if (CUSTOM_SAME_LABEL_NAMES.includes(displayName)) return displayName;
    unresolved.add(displayName);
    return String(displayName || '').replace(/[^A-Za-z0-9_]/g, '_');
  }

  function formatConstant(displayName, options, value) {
    const opt = (options || []).find((o) => o.value === value);
    const table = displayName === 'Bluetooth' ? BT_CONST_LABELS
      : displayName === 'Output Selection' ? OUT_CONST_LABELS
        : null;
    if (opt && table && Object.prototype.hasOwnProperty.call(table, opt.name)) return table[opt.name];
    if (opt && /^[A-Za-z_][A-Za-z0-9_]*$/.test(opt.name)) return opt.name;
    return String(value);
  }

  function formatParam(slot, value, layers, displayName) {
    switch (slot.kind) {
      case 'nil':
      case 'none':
        return null;
      case 'hidUsage':
        return formatHidUsage(value);
      case 'layerId': {
        const idx = TpKeymapUi.layerIndexById(layers, value);
        return String(idx >= 0 ? idx : value);
      }
      case 'constant':
        return formatConstant(displayName, slot.options, value);
      case 'range':
        return String(value);
      default:
        return null;
    }
  }

  function zdsToken(table, value) {
    return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : String(value);
  }

  function bindingTokens(binding, behavior, layers, unresolved) {
    const label = behaviorLabel(behavior.displayName, unresolved);
    if (behavior.displayName === 'zip_dyn_scale' || behavior.displayName === 'zip_dyn_scale_set') {
      return ['&' + label, zdsToken(ZDS_PARAM1_NAMES, binding.param1), zdsToken(ZDS_PARAM2_NAMES, binding.param2)];
    }
    const setIdx = TpKeymapUi.findMatchingSetIndex(behavior, binding, layers);
    const set = setIdx >= 0 ? behavior.metadata[setIdx] : null;
    const slot1 = set ? TpKeymapUi.describeParamSlot(set.param1) : { kind: 'none' };
    const slot2 = set ? TpKeymapUi.describeParamSlot(set.param2) : { kind: 'none' };
    const p1 = formatParam(slot1, binding.param1, layers, behavior.displayName);
    const p2 = formatParam(slot2, binding.param2, layers, behavior.displayName);
    const tokens = ['&' + label];
    if (p1 !== null) tokens.push(p1);
    if (p2 !== null) tokens.push(p2);
    return tokens;
  }

  function renderBinding(binding, behaviors, layers, unresolved) {
    const behavior = (behaviors || []).find((b) => b.id === binding.behaviorId);
    if (!behavior) return '&none';
    return bindingTokens(binding, behavior, layers, unresolved).join(' ');
  }

  function keyRow(key) {
    return Math.round((key.y || 0) / 100);
  }

  function renderLayerBindings(bindingStrings, keys) {
    const maxLen = bindingStrings.reduce((m, s) => Math.max(m, s.length), 0);
    const padWidth = maxLen + 1;
    const lines = [];
    let currentRow = null;
    let currentLine = [];
    bindingStrings.forEach((str, i) => {
      const row = keys[i] ? keyRow(keys[i]) : currentRow;
      if (currentRow === null || row !== currentRow) {
        if (currentLine.length) lines.push(currentLine);
        currentLine = [];
        currentRow = row;
      }
      currentLine.push(str);
    });
    if (currentLine.length) lines.push(currentLine);
    return lines.map((line) => line.map((s) => s.padEnd(padWidth)).join('').replace(/\s+$/, '')).join('\n');
  }

  function renderLayer(layer, idx, behaviors, layers, keys, unresolved) {
    const bindingStrings = (layer.bindings || []).map((b) => renderBinding(b, behaviors, layers, unresolved));
    const bindingText = renderLayerBindings(bindingStrings, keys);
    return [
      '        layer_' + idx + ' {',
      '            display-name = "' + escapeDisplayName(layer.name) + '";',
      '            bindings = <',
      bindingText,
      '            >;',
      '        };',
    ].join('\n');
  }

  function exportKeymap(input) {
    const keymap = input && input.keymap;
    const behaviors = (input && input.behaviors) || [];
    const layout = input && input.layout;
    const layers = (keymap && keymap.layers) || [];
    const keys = (layout && layout.keys) || [];
    const unresolved = new Set();

    const layerBlocks = layers.map((layer, idx) => renderLayer(layer, idx, behaviors, layers, keys, unresolved));

    const header = [
      '// tp-tuner が書き出したキーマップ',
      '// config/lalapadgen2.keymap の keymap { ... } ブロックをこの内容で置き換える',
    ];
    if (unresolved.size) {
      header.push('// 要確認: 次の behavior はノード名から推定しました: ' + Array.from(unresolved).join(', '));
    }

    const body = [
      '/ {',
      '    keymap {',
      '        compatible = "zmk,keymap";',
      '',
      layerBlocks.join('\n\n'),
      '    };',
      '};',
    ].join('\n');

    return header.join('\n') + '\n' + body + '\n';
  }

  const api = { exportKeymap };
  root.TpKeymapExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
