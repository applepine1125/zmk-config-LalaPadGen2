'use strict';

const fs = require('fs');
const path = require('path');

function readDefines(text) {
  const map = new Map();
  const re = /^#define\s+(\w+)\s+\(?0x([0-9A-Fa-f]+)\)?/gm;
  let m;
  while ((m = re.exec(text))) map.set(m[1], parseInt(m[2], 16));
  return map;
}

function joinContinuations(text) {
  const lines = text.split('\n');
  const out = [];
  let acc = '';
  for (const line of lines) {
    const joined = acc ? acc + line.replace(/^\s+/, ' ') : line;
    if (/\\\s*$/.test(joined)) {
      acc = joined.replace(/\\\s*$/, '');
    } else {
      out.push(joined);
      acc = '';
    }
  }
  if (acc) out.push(acc);
  return out.join('\n');
}

const RE_LS_USAGE = /^#define\s+(\w+)\s+\(LS\(ZMK_HID_USAGE\((\w+),\s*(\w+|0x[0-9A-Fa-f]+)\)\)\)\s*(?:\/\/.*)?$/;
const RE_USAGE = /^#define\s+(\w+)\s+\(ZMK_HID_USAGE\((\w+),\s*(\w+|0x[0-9A-Fa-f]+)\)\)\s*(?:\/\/.*)?$/;
const RE_ALIAS = /^#define\s+(\w+)\s+\((\w+)\)\s*(?:\/\/.*)?$/;

function parseKeysHeader(text, pageConsts, usageIds) {
  const joined = joinContinuations(text);
  const env = new Map(); // name -> value
  const isPrimary = new Set();
  const primaryInfo = new Map(); // name -> { value, page, id, mods }
  const aliasTarget = new Map();

  function resolveId(pageName, idRef) {
    if (/^0x[0-9A-Fa-f]+$/.test(idRef)) return parseInt(idRef, 16);
    if (usageIds.has(idRef)) return usageIds.get(idRef);
    throw new Error('未解決の usage id です: ' + idRef);
  }

  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('#define')) continue;

    let m = RE_LS_USAGE.exec(line);
    if (m) {
      const [, name, pageName, idRef] = m;
      if (!pageConsts.has(pageName)) throw new Error('未解決の page です: ' + pageName);
      const page = pageConsts.get(pageName);
      const id = resolveId(pageName, idRef);
      const mods = 0x02; // MOD_LSFT
      const value = (mods * 0x1000000 + page * 0x10000 + id) >>> 0;
      env.set(name, value);
      isPrimary.add(name);
      primaryInfo.set(name, { value, page, id, mods });
      continue;
    }

    m = RE_USAGE.exec(line);
    if (m) {
      const [, name, pageName, idRef] = m;
      if (!pageConsts.has(pageName)) throw new Error('未解決の page です: ' + pageName);
      const page = pageConsts.get(pageName);
      const id = resolveId(pageName, idRef);
      const value = (page * 0x10000 + id) >>> 0;
      env.set(name, value);
      isPrimary.add(name);
      primaryInfo.set(name, { value, page, id, mods: 0 });
      continue;
    }

    m = RE_ALIAS.exec(line);
    if (m) {
      const [, name, target] = m;
      if (!env.has(target)) throw new Error('未解決の別名参照です: ' + name + ' -> ' + target);
      env.set(name, env.get(target));
      aliasTarget.set(name, target);
      continue;
    }

    throw new Error('パースできない #define です: ' + line);
  }

  function canonicalOf(name) {
    if (isPrimary.has(name)) return name;
    const target = aliasTarget.get(name);
    if (target === undefined) throw new Error('未知の識別子です: ' + name);
    return canonicalOf(target);
  }

  const aliasesOf = new Map();
  for (const name of aliasTarget.keys()) {
    const canonical = canonicalOf(name);
    if (!aliasesOf.has(canonical)) aliasesOf.set(canonical, []);
    aliasesOf.get(canonical).push(name);
  }

  return { primaryInfo, aliasesOf };
}

// NUMBER_1..NUMBER_9,NUMBER_0 は N1..N9,N0 の方が ZMK キーマップでの通称のため、
// こちらを正規名にし NUMBER_x/NUM_x は別名に回す(ブリーフの例に合わせた明示的な入れ替え)。
const CANONICAL_OVERRIDE = {
  NUMBER_1: 'N1', NUMBER_2: 'N2', NUMBER_3: 'N3', NUMBER_4: 'N4', NUMBER_5: 'N5',
  NUMBER_6: 'N6', NUMBER_7: 'N7', NUMBER_8: 'N8', NUMBER_9: 'N9', NUMBER_0: 'N0',
};

const MOD_LABELS = { LC: '⌃', LS: '⇧', LA: '⌥', LG: '⌘', RC: '⌃', RS: '⇧', RA: '⌥', RG: '⌘' };

const MOD_NAMES = new Set([
  'LEFT_CONTROL', 'LEFT_SHIFT', 'LEFT_ALT', 'LEFT_GUI',
  'RIGHT_CONTROL', 'RIGHT_SHIFT', 'RIGHT_ALT', 'RIGHT_GUI',
]);
const NAV_NAMES = new Set([
  'RIGHT_ARROW', 'LEFT_ARROW', 'UP_ARROW', 'DOWN_ARROW', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'INSERT',
]);
const EDIT_NAMES = new Set([
  'BACKSPACE', 'DELETE', 'RETURN', 'SPACE', 'TAB', 'K_CUT', 'K_COPY', 'K_PASTE', 'K_UNDO', 'K_AGAIN',
  'K_FIND', 'K_SELECT', 'K_STOP', 'K_EXECUTE', 'K_HELP', 'K_MENU', 'K_CANCEL', 'CLEAR', 'ALT_ERASE', 'SYSREQ',
]);
const FUNC_NAMES = new Set([
  'ESCAPE', 'CAPSLOCK', 'PRINTSCREEN', 'SCROLLLOCK', 'PAUSE_BREAK',
  'LOCKING_CAPS', 'LOCKING_NUM', 'LOCKING_SCROLL', 'K_APPLICATION', 'K_POWER',
]);
const MEDIA_NAMES = new Set([
  'K_PLAY_PAUSE', 'K_STOP2', 'K_PREVIOUS', 'K_NEXT', 'K_EJECT', 'K_VOLUME_UP2', 'K_VOLUME_DOWN2',
  'K_MUTE2', 'K_WWW', 'K_BACK', 'K_FORWARD', 'K_STOP3', 'K_FIND2', 'K_SCROLL_UP', 'K_SCROLL_DOWN',
  'K_EDIT', 'K_SLEEP', 'K_LOCK', 'K_REFRESH', 'K_CALCULATOR', 'K_VOLUME_UP', 'K_VOLUME_DOWN', 'K_MUTE',
]);
const SYMBOL_NAMES = new Set([
  'MINUS', 'EQUAL', 'LEFT_BRACKET', 'RIGHT_BRACKET', 'BACKSLASH', 'SEMICOLON',
  'SINGLE_QUOTE', 'GRAVE', 'COMMA', 'PERIOD', 'SLASH', 'NON_US_HASH', 'NON_US_BACKSLASH',
]);

const LABEL_OVERRIDE = {
  LEFT_CONTROL: '⌃', LEFT_SHIFT: '⇧', LEFT_ALT: '⌥', LEFT_GUI: '⌘',
  RIGHT_CONTROL: '⌃', RIGHT_SHIFT: '⇧', RIGHT_ALT: '⌥', RIGHT_GUI: '⌘',
  RETURN: '⏎', ESCAPE: 'Esc', BACKSPACE: '⌫', TAB: '⇥', SPACE: 'Space', CAPSLOCK: '⇪',
  DELETE: '⌦', HOME: 'Home', END: 'End', PAGE_UP: 'PgUp', PAGE_DOWN: 'PgDn', INSERT: 'Ins',
  RIGHT_ARROW: '→', LEFT_ARROW: '←', UP_ARROW: '↑', DOWN_ARROW: '↓',
  PRINTSCREEN: 'PrtSc', SCROLLLOCK: 'ScrLk', PAUSE_BREAK: 'Pause',
  MINUS: '-', EQUAL: '=', LEFT_BRACKET: '[', RIGHT_BRACKET: ']', BACKSLASH: '\\',
  SEMICOLON: ';', SINGLE_QUOTE: "'", GRAVE: '`', COMMA: ',', PERIOD: '.', SLASH: '/',
  NON_US_HASH: '#', NON_US_BACKSLASH: '\\',
  EXCLAMATION: '!', AT_SIGN: '@', HASH: '#', DOLLAR: '$', PERCENT: '%', CARET: '^',
  AMPERSAND: '&', ASTERISK: '*', LEFT_PARENTHESIS: '(', RIGHT_PARENTHESIS: ')',
  UNDERSCORE: '_', PLUS: '+', LEFT_BRACE: '{', RIGHT_BRACE: '}', PIPE: '|',
  TILDE: '~', TILDE2: '~', COLON: ':', DOUBLE_QUOTES: '"', LESS_THAN: '<',
  GREATER_THAN: '>', QUESTION: '?', CLEAR2: 'Clear', PIPE2: '|',
  K_VOLUME_UP: 'Vol+', K_VOLUME_DOWN: 'Vol-', K_MUTE: 'Mute', K_PLAY_PAUSE: '⏯',
  K_PREVIOUS: '⏮', K_NEXT: '⏭', K_EJECT: '⏏',
  C_VOLUME_UP: 'Vol+', C_VOLUME_DOWN: 'Vol-', C_MUTE: 'Mute', C_PLAY_PAUSE: '⏯',
  C_NEXT: '⏭', C_PREVIOUS: '⏮', C_EJECT: '⏏',
  C_BRIGHTNESS_INC: 'Bri+', C_BRIGHTNESS_DEC: 'Bri-',
};

function defaultLabel(name) {
  const n = name.replace(/^(KP_|K_|C_)/, '');
  const words = n.split('_').filter(Boolean);
  if (words.length === 1) return words[0].length <= 5 ? words[0] : words[0].slice(0, 4);
  const last = words[words.length - 1];
  if (/^\d+$/.test(last)) return (words.slice(0, -1).map((w) => w[0]).join('') + last).slice(0, 4);
  return words.map((w) => w[0]).join('').slice(0, 4).toUpperCase();
}

function labelFor(name) {
  if (LABEL_OVERRIDE[name] !== undefined) return LABEL_OVERRIDE[name];
  if (/^[A-Z]$/.test(name)) return name;
  if (/^N[0-9]$/.test(name)) return name[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(name)) return name;
  return defaultLabel(name);
}

function classify(name, page, mods) {
  if (MOD_NAMES.has(name)) return '修飾';
  if (/^[A-Z]$/.test(name)) return '文字';
  if (/^N[0-9]$/.test(name)) return '数字';
  if (NAV_NAMES.has(name)) return 'ナビ';
  if (EDIT_NAMES.has(name)) return '編集';
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(name) || FUNC_NAMES.has(name)) return '機能';
  if (page === 0x0c || MEDIA_NAMES.has(name)) return 'メディア';
  if (mods !== 0 || SYMBOL_NAMES.has(name)) return '記号';
  return 'その他';
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('使い方: node gen-keycodes.js <zmk の app/include/dt-bindings/zmk ディレクトリ>\n');
    process.exit(1);
  }

  const pagesText = fs.readFileSync(path.join(dir, 'hid_usage_pages.h'), 'utf8');
  const usageText = fs.readFileSync(path.join(dir, 'hid_usage.h'), 'utf8');
  const modifiersText = fs.readFileSync(path.join(dir, 'modifiers.h'), 'utf8');
  const keysText = fs.readFileSync(path.join(dir, 'keys.h'), 'utf8');

  const pageConsts = readDefines(pagesText);
  const usageIds = readDefines(usageText);
  const modConsts = readDefines(modifiersText);

  const MODS = {
    LC: modConsts.get('MOD_LCTL'), LS: modConsts.get('MOD_LSFT'),
    LA: modConsts.get('MOD_LALT'), LG: modConsts.get('MOD_LGUI'),
    RC: modConsts.get('MOD_RCTL'), RS: modConsts.get('MOD_RSFT'),
    RA: modConsts.get('MOD_RALT'), RG: modConsts.get('MOD_RGUI'),
  };
  for (const [k, v] of Object.entries(MODS)) {
    if (v === undefined) throw new Error('modifiers.h に見つかりません: ' + k);
  }

  const { primaryInfo, aliasesOf } = parseKeysHeader(keysText, pageConsts, usageIds);

  const keys = [];
  for (const [name, info] of primaryInfo) {
    const override = CANONICAL_OVERRIDE[name];
    const canonicalName = override || name;
    const aliases = (aliasesOf.get(name) || []).filter((a) => a !== override);
    if (override) aliases.push(name);
    keys.push({
      name: canonicalName,
      value: info.value,
      page: info.page,
      id: info.id,
      label: labelFor(canonicalName),
      group: classify(canonicalName, info.page, info.mods),
      aliases,
    });
  }
  keys.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));

  const lines = [];
  lines.push("(function (root) {");
  lines.push("  'use strict';");
  lines.push('');
  lines.push('  const MODS = ' + JSON.stringify(MODS) + ';');
  lines.push('  const MOD_LABELS = ' + JSON.stringify(MOD_LABELS) + ';');
  lines.push('');
  lines.push('  const KEYS = [');
  for (const k of keys) {
    lines.push('    ' + JSON.stringify(k) + ',');
  }
  lines.push('  ];');
  lines.push('');
  lines.push('  function encodeUsage(page, id, mods) {');
  lines.push('    return (((mods || 0) & 0xff) * 0x1000000 + (page & 0xff) * 0x10000 + (id & 0xffff)) >>> 0;');
  lines.push('  }');
  lines.push('');
  lines.push('  function decodeUsage(value) {');
  lines.push('    const v = value >>> 0;');
  lines.push('    return { page: (v >>> 16) & 0xff, id: v & 0xffff, mods: (v >>> 24) & 0xff };');
  lines.push('  }');
  lines.push('');
  lines.push('  function findByValue(value) {');
  lines.push('    for (const k of KEYS) if (k.value === value) return k;');
  lines.push('    return null;');
  lines.push('  }');
  lines.push('');
  lines.push('  const api = { KEYS, MODS, encodeUsage, decodeUsage, findByValue, MOD_LABELS };');
  lines.push('  root.TpKeycodes = api;');
  lines.push("  if (typeof module !== 'undefined' && module.exports) module.exports = api;");
  lines.push("})(typeof globalThis !== 'undefined' ? globalThis : this);");
  lines.push('');

  const outPath = path.join(__dirname, '..', 'keycodes.js');
  fs.writeFileSync(outPath, lines.join('\n'));
  process.stdout.write('生成しました: ' + outPath + ' (' + keys.length + ' 件)\n');
}

main();
