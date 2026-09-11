(function (root) {
  'use strict';
  const Presets = root.TpPresets;
  if (!Presets) return;
  const Link = root.TpAppLink;
  const Params = root.TpAppParams;
  const Keymap = root.TpAppKeymap;
  if (!Link || !Params || !Keymap) return;

  const $ = (id) => document.getElementById(id);

  let store = Presets.emptyStore();
  let loaded = false;
  let lastOptionsKey = null;
  let pendingCreateName = null;

  function selectedPreset() {
    return Presets.findPreset(store, store.selectedId);
  }

  function applyCompareTargets() {
    const preset = selectedPreset();
    Params.setPresetTrackpad(preset ? preset.trackpad : null);
    Keymap.setPresetKeymap(preset ? preset.keymap : null);
  }

  function diffCount() {
    if (!store.selectedId) return 0;
    return Presets.diffCount(Params.presetDiff(), Keymap.presetDiff());
  }

  async function persistAndReport(successMsg) {
    if (!loaded) {
      root.TpAppMain.setStatus('プリセットの読み込みに失敗しているため保存できません(壊れたファイルを上書きしないための措置です)', true);
      return false;
    }
    const res = await Link.savePresetsText(Presets.serializeStore(store));
    if (!res.ok) {
      root.TpAppMain.setStatus('プリセットを保存できませんでした: ' + (res.error || ''), true);
      return false;
    }
    if (successMsg !== undefined) root.TpAppMain.setStatus(successMsg);
    return true;
  }

  function screenTrackpadOrNull() {
    const screen = Params.screenTrackpad();
    return (screen.R || screen.L) ? screen : null;
  }

  function renderOptions() {
    const key = store.presets.map((p) => p.id + ':' + p.name).join('|') + '#' + (store.selectedId || '');
    if (key === lastOptionsKey) return;
    lastOptionsKey = key;
    const sel = $('selPreset');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '無し';
    sel.appendChild(none);
    for (const p of store.presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.value = store.selectedId || '';
  }

  function render() {
    renderOptions();
    const busy = root.TpAppMain ? root.TpAppMain.isBusy() : false;
    const conn = Link.isConnected();
    const selected = !!store.selectedId;
    const hasTrackpad = !!screenTrackpadOrNull();
    $('selPreset').disabled = busy;
    $('btnPresetNew').disabled = busy || !conn || !(hasTrackpad || Keymap.isReady());
    $('btnPresetSave').disabled = busy || !selected;
    $('btnPresetDelete').disabled = busy || !selected;
    const ind = $('presetDiffIndicator');
    if (selected && conn) {
      const n = diffCount();
      ind.hidden = false;
      ind.textContent = n > 0 ? `プリセットとの差分 ${n} 件` : 'プリセットと一致';
    } else {
      ind.hidden = true;
    }
  }

  async function init() {
    const res = await Link.loadPresetsText();
    if (res.ok) {
      const parsed = Presets.parseStore(res.text);
      if (parsed.ok) {
        loaded = true;
        store = parsed.store;
      } else {
        loaded = false;
        store = Presets.emptyStore();
        root.TpAppMain.setStatus('プリセットを読み込めませんでした: ' + parsed.error, true);
      }
    } else {
      loaded = false;
      store = Presets.emptyStore();
      root.TpAppMain.setStatus('プリセットを読み込めませんでした: ' + (res.error || ''), true);
    }
    applyCompareTargets();
    render();
  }

  async function onSelectChange() {
    const sel = $('selPreset');
    const newId = sel.value || null;
    const prevId = store.selectedId;
    if (newId === prevId) return;
    if (newId === null) {
      root.TpAppMain.setBusy(true);
      try {
        store = Presets.selectPreset(store, null);
        applyCompareTargets();
        await persistAndReport();
      } finally {
        root.TpAppMain.setBusy(false);
      }
      return;
    }
    const preset = Presets.findPreset(store, newId);
    if (!preset) { sel.value = prevId || ''; return; }
    const hasPending = Params.pendingCount() > 0 || Keymap.isDirty();
    if (hasPending) {
      const ok = window.confirm(`書き込んでいない変更を捨てて、プリセット「${preset.name}」の内容を画面に反映します。よろしいですか?`);
      if (!ok) { sel.value = prevId || ''; return; }
    }
    root.TpAppMain.setBusy(true);
    try {
      if (!Link.isConnected()) {
        store = Presets.selectPreset(store, newId);
        applyCompareTargets();
        await persistAndReport('接続すると差分を表示します');
        return;
      }
      store = Presets.selectPreset(store, newId);
      applyCompareTargets();
      Params.applyPresetTrackpad(preset.trackpad);
      let skippedNote = '';
      let layerErrorNote = '';
      let keymapNote = '';
      if (preset.keymap) {
        const ready = await Keymap.ensureLoaded();
        if (ready) {
          if (Keymap.isDirty()) await Keymap.reload();
          const result = await Keymap.applyPresetKeymap(preset.keymap);
          if (result.skipped > 0) skippedNote = `(割り当てできなかったキー ${result.skipped} 件)`;
          if (result.layerError) layerErrorNote = `(${result.layerError})`;
        } else {
          keymapNote = '(キー設定は Studio が使えないため反映していません)';
        }
      } else if (Keymap.isDirty()) {
        await Keymap.reload();
      }
      const msg = `プリセット「${preset.name}」を画面に反映しました。「書き込み」でキーボードに書き込みます`
        + skippedNote + layerErrorNote + keymapNote;
      await persistAndReport(msg);
    } finally {
      root.TpAppMain.setBusy(false);
    }
  }

  async function createPresetFlow(name) {
    root.TpAppMain.setBusy(true);
    try {
      await Keymap.ensureLoaded();
      const trackpad = screenTrackpadOrNull();
      const keymapSnap = Keymap.snapshot();
      const id = 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const now = new Date().toISOString();
      const result = Presets.createPreset(store, { name, trackpad, keymap: keymapSnap }, { id, now });
      if (!result.ok) {
        root.TpAppMain.setStatus('プリセットを作成できませんでした: ' + result.error, true);
        return;
      }
      store = result.store;
      applyCompareTargets();
      const successMsg = keymapSnap
        ? `プリセット「${name}」を作成しました`
        : `プリセット「${name}」を作成しました(キー設定は含まれていません)`;
      await persistAndReport(successMsg);
    } finally {
      root.TpAppMain.setBusy(false);
    }
  }

  async function savePresetFlow() {
    const preset = selectedPreset();
    if (!preset) return;
    if (!window.confirm(`プリセット「${preset.name}」を今の画面の状態で上書きします。よろしいですか?`)) return;
    root.TpAppMain.setBusy(true);
    try {
      const trackpad = screenTrackpadOrNull();
      const keymapSnap = Keymap.snapshot();
      const now = new Date().toISOString();
      store = Presets.updatePreset(store, preset.id, { trackpad, keymap: keymapSnap }, now);
      applyCompareTargets();
      await persistAndReport(`プリセット「${preset.name}」を上書きしました`);
    } finally {
      root.TpAppMain.setBusy(false);
    }
  }

  async function deletePresetFlow() {
    const preset = selectedPreset();
    if (!preset) return;
    if (!window.confirm(`プリセット「${preset.name}」を削除します。よろしいですか?`)) return;
    root.TpAppMain.setBusy(true);
    try {
      store = Presets.deletePreset(store, preset.id);
      applyCompareTargets();
      await persistAndReport(`プリセット「${preset.name}」を削除しました`);
    } finally {
      root.TpAppMain.setBusy(false);
    }
  }

  function openCreateDialog() {
    const input = $('presetNameInput');
    input.value = '';
    $('presetNameError').hidden = true;
    $('presetNameDialog').showModal();
    input.focus();
  }

  function submitCreateDialog() {
    const v = Presets.validateName(store, $('presetNameInput').value);
    if (!v.ok) {
      $('presetNameError').textContent = v.error;
      $('presetNameError').hidden = false;
      return;
    }
    pendingCreateName = v.name;
    $('presetNameDialog').close('ok');
  }

  $('presetNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreateDialog(); }
  });
  $('presetNameOk').onclick = (e) => { e.preventDefault(); submitCreateDialog(); };
  $('presetNameDialog').addEventListener('close', () => {
    if ($('presetNameDialog').returnValue === 'ok' && pendingCreateName) {
      const name = pendingCreateName;
      pendingCreateName = null;
      createPresetFlow(name);
    }
  });

  $('btnPresetNew').onclick = () => { openCreateDialog(); };
  $('btnPresetSave').onclick = () => { savePresetFlow(); };
  $('btnPresetDelete').onclick = () => { deletePresetFlow(); };
  $('selPreset').onchange = () => { onSelectChange(); };

  const api = { init, diffCount, render, onKeymapLoaded: render };
  root.TpAppPresets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
