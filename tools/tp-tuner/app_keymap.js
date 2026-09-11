(function (root) {
  'use strict';
  const T = globalThis.TpTuner;
  if (!T) return;
  const Link = root.TpAppLink;
  const Pad = root.TpAppPad;
  if (!Link || !Pad) return;

  const $ = (id) => document.getElementById(id);

  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  let studioClient = null;
  let studioAvailable = false;
  let studioLocked = false;
  let studioDirty = false;
  let loadPromise = null;
  let studioUsbOpenTried = false;
  let studioUsbWaitTimer = null;
  let physicalLayout = null;
  let behaviors = [];
  let keymapData = null;
  let presetKeymap = null;
  let selectedLayerIndex = 0;
  let selectedKeyPos = null;
  let activeTab = 'trackpad';

  function setStudioNotice(text) {
    const el = $('studioNotice');
    el.textContent = text;
    el.hidden = !text;
  }

  function teardownStudio() {
    if (studioClient) { studioClient.dispose(); studioClient = null; }
    studioLocked = false;
    studioDirty = false;
    keymapData = null;
    physicalLayout = null;
    behaviors = [];
    selectedLayerIndex = 0;
    selectedKeyPos = null;
    renderKeymapWorkspace();
    root.TpAppMain.renderHeader();
  }

  function disconnectCleanup() {
    if (studioUsbOpenTried && Link.getTransportKind() === 'usb') Link.studioClose();
    studioAvailable = false;
    studioUsbOpenTried = false;
    clearTimeout(studioUsbWaitTimer);
    teardownStudio();
  }

  function createStudioClient() {
    studioClient = TpStudio.createClient({
      send: (bytes) => Link.studioWrite(bytes),
      timeoutMs: 10000,
    });
    studioClient.onNotification = (n) => {
      if (n.keymap && n.keymap.unsavedChangesStatusChanged !== undefined) {
        studioDirty = n.keymap.unsavedChangesStatusChanged;
        root.TpAppMain.renderHeader();
      }
      if (n.core && n.core.lockStateChanged !== undefined) {
        studioLocked = n.core.lockStateChanged !== 0;
        if (studioLocked) setStudioNotice('Studio がロックされています');
        else updateStudioAvailability();
      }
    };
  }

  function requestStudioUsbOpen(otherId) {
    studioUsbOpenTried = true;
    Link.studioOpen(otherId);
    clearTimeout(studioUsbWaitTimer);
    studioUsbWaitTimer = setTimeout(() => {
      if (!studioAvailable) setStudioNotice('USB では右手の Studio ポートが要ります');
    }, 4000);
  }

  function isStudioUsable() {
    if (!Link.hasNativeBridge) return false;
    if (!Link.isConnected()) return false;
    if (Link.getTransportKind() === 'ble') return studioAvailable;
    return Link.getUsbSide() === 'R' && studioAvailable;
  }

  function updateStudioAvailability() {
    if (!Link.hasNativeBridge) { setStudioNotice('Studio 機能は Mac アプリでのみ使えます'); return; }
    if (!Link.isConnected()) { setStudioNotice('接続すると使えます'); return; }
    if (Link.getTransportKind() === 'ble') {
      if (!studioAvailable) { setStudioNotice('Studio 機能を確認しています...'); return; }
    } else {
      if (Link.getUsbSide() !== 'R') { setStudioNotice('USB では右手の Studio ポートが要ります'); return; }
      if (!studioAvailable) {
        if (!studioUsbOpenTried) {
          const other = Link.getLastDevices().find((d) => d.kind === 'usb' && d.id !== Link.getConnectedDeviceId());
          if (!other) { setStudioNotice('USB では右手の Studio ポートが要ります'); return; }
          requestStudioUsbOpen(other.id);
        }
        setStudioNotice('Studio 機能を確認しています...');
        return;
      }
    }
    setStudioNotice('');
    if (!studioClient) createStudioClient();
    if (!keymapData) {
      loadKeymapData();
    } else {
      if (activeTab === 'keymap') Pad.setTrackpadQuiet(true);
      renderKeymapWorkspace();
    }
  }

  function loadKeymapData() {
    if (loadPromise) return loadPromise;
    if (!studioClient) return Promise.resolve();
    loadPromise = (async () => {
      setStudioNotice('キー設定を読み込んでいます...');
      try {
        await Pad.setTrackpadQuiet(true);
        const lockState = await studioClient.getLockState();
        studioLocked = lockState !== 1;
        if (studioLocked) { setStudioNotice('Studio がロックされています'); keymapData = null; renderKeymapWorkspace(); return; }
        physicalLayout = await studioClient.getPhysicalLayouts();
        const ids = await studioClient.listBehaviors();
        const details = [];
        for (const id of ids) details.push(await studioClient.getBehaviorDetails(id));
        behaviors = details.sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'));
        keymapData = await studioClient.getKeymap();
        studioDirty = await studioClient.checkUnsavedChanges();
        if (selectedLayerIndex >= keymapData.layers.length) selectedLayerIndex = 0;
        selectedKeyPos = null;
        setStudioNotice('');
        renderKeymapWorkspace();
      } catch (e) {
        const torndown = (e && e.code === 'DISPOSED') || !studioClient;
        if (!torndown) setStudioNotice('キー設定の読み込みに失敗しました: ' + errText(e) + '(「再読み込み」でやり直せます)');
      } finally {
        if (activeTab !== 'keymap') await Pad.setTrackpadQuiet(false);
        loadPromise = null;
        root.TpAppMain.renderHeader();
        if (root.TpAppPresets && root.TpAppPresets.onKeymapLoaded) root.TpAppPresets.onKeymapLoaded();
      }
    })();
    return loadPromise;
  }

  function isReady() {
    return !!studioClient && !!keymapData;
  }

  async function ensureLoaded() {
    if (isReady()) return true;
    if (loadPromise) { await loadPromise; return isReady(); }
    if (!isStudioUsable()) return false;
    if (!studioClient) createStudioClient();
    await loadKeymapData();
    return isReady();
  }

  function isDirty() {
    return studioDirty;
  }

  function snapshot() {
    return keymapData ? TpPresets.keymapSnapshot(keymapData, behaviors, TpKeymapUi.HIDDEN_KEY_POSITIONS) : null;
  }

  function setPresetKeymap(next) {
    presetKeymap = next || null;
    renderKeymapWorkspace();
  }

  function presetDiff() {
    return TpPresets.keymapDiff(presetKeymap, snapshot());
  }

  function renderKeymapWorkspace() {
    const show = !!keymapData && !!physicalLayout;
    $('keymapWorkspace').hidden = !show;
    if (!show) return;
    renderLayerList();
    renderKeymapSvg();
    renderKeyEditor();
  }

  function renderLayerList() {
    const wrap = $('layerList');
    wrap.innerHTML = '';
    const diff = presetDiff();
    const diffLayers = new Set(diff.keys.map((k) => k.layer));
    keymapData.layers.forEach((layer, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layer-btn' + (i === selectedLayerIndex ? ' active' : '') + (diffLayers.has(i) ? ' presetdiff' : '');
      b.textContent = layer.name || `Layer ${i}`;
      b.onclick = () => { selectedLayerIndex = i; selectedKeyPos = null; renderKeymapWorkspace(); };
      wrap.appendChild(b);
    });
    $('btnLayerAdd').disabled = !studioClient || keymapData.availableLayers <= 0;
    $('btnLayerRemove').disabled = !studioClient || keymapData.layers.length < 2;
    const note = $('presetLayerNote');
    note.hidden = !diff.layerCount;
    note.textContent = diff.layerCount
      ? `プリセットはレイヤー ${diff.layerCount.preset} 個(今は ${diff.layerCount.screen} 個)`
      : '';
  }

  function renderKeymapSvg() {
    const wrap = $('keymapSvgWrap');
    wrap.innerHTML = '';
    const layout = physicalLayout.layouts[physicalLayout.activeLayoutIndex];
    if (!layout || !layout.keys.length) return;
    const visibleKeys = layout.keys.filter((_, idx) => !TpKeymapUi.isKeyHidden(idx));
    const bounds = TpKeymapUi.layoutBounds(visibleKeys);
    const scale = bounds.width > 0 ? 1200 / bounds.width : 40;
    const pad = 10;
    const svgW = bounds.width * scale + pad * 2;
    const svgH = bounds.height * scale + pad * 2;
    const layer = keymapData.layers[selectedLayerIndex];
    const bindings = (layer && layer.bindings) || [];
    const diff = presetDiff();
    const diffPos = new Set(diff.keys.filter((k) => k.layer === selectedLayerIndex).map((k) => k.pos));
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    layout.keys.forEach((key, idx) => {
      if (TpKeymapUi.isKeyHidden(idx)) return;
      const r = TpKeymapUi.keyRect(key, scale);
      const x = r.x - bounds.minX * scale + pad;
      const y = r.y - bounds.minY * scale + pad;
      const cx = r.cx - bounds.minX * scale + pad;
      const cy = r.cy - bounds.minY * scale + pad;
      const g = document.createElementNS(svgNS, 'g');
      if (r.angle) g.setAttribute('transform', `rotate(${r.angle} ${cx} ${cy})`);
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => { selectedKeyPos = idx; renderKeyEditor(); renderKeymapSvg(); });
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x + 2);
      rect.setAttribute('y', y + 2);
      rect.setAttribute('width', Math.max(1, r.width - 4));
      rect.setAttribute('height', Math.max(1, r.height - 4));
      rect.setAttribute('rx', 6);
      rect.setAttribute('class', 'keycap' + (idx === selectedKeyPos ? ' selected' : '') + (diffPos.has(idx) ? ' presetdiff' : ''));
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', x + r.width / 2);
      text.setAttribute('y', y + r.height / 2);
      const label = bindings[idx] ? TpKeymapUi.bindingLabel(bindings[idx], behaviors, keymapData.layers) : '';
      text.textContent = label;
      text.setAttribute('class', 'keycap-label' + ((label === '▽' || label === '×') ? ' placeholder' : ''));
      g.append(rect, text);
      svg.appendChild(g);
    });
    wrap.appendChild(svg);
  }

  async function commitBinding(newBinding) {
    if (!studioClient || selectedKeyPos === null) return;
    const targetLayer = keymapData.layers[selectedLayerIndex];
    const pos = selectedKeyPos;
    const prevBinding = targetLayer.bindings[pos];
    const isStillSelected = () => selectedKeyPos === pos
      && !!keymapData && keymapData.layers[selectedLayerIndex] === targetLayer;
    targetLayer.bindings[pos] = newBinding;
    renderKeymapSvg();
    renderKeyEditor();
    renderLayerList();
    try {
      const code = await studioClient.setLayerBinding(targetLayer.id, pos, newBinding);
      if (code) {
        targetLayer.bindings[pos] = prevBinding;
        renderKeymapSvg();
        if (isStillSelected()) renderKeyEditor();
        renderLayerList();
        root.TpAppMain.setStatus('キーの設定に失敗しました: ' + TpKeymapUi.setBindingErrorText(code), true);
      } else {
        studioDirty = true;
        root.TpAppMain.renderHeader();
      }
    } catch (e) {
      targetLayer.bindings[pos] = prevBinding;
      renderKeymapSvg();
      if (isStillSelected()) renderKeyEditor();
      renderLayerList();
      root.TpAppMain.setStatus('キーの設定に失敗しました: ' + errText(e), true);
    }
  }

  function renderNumberInput(value, min, max, onCommit) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.onchange = () => {
      const v = Math.min(max, Math.max(min, Math.round(Number(input.value) || 0)));
      input.value = String(v);
      onCommit(v);
    };
    return input;
  }

  function renderField(labelText, contentEl) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.className = 'fieldlabel';
    label.textContent = labelText;
    field.append(label, contentEl);
    return field;
  }

  function renderKeycodePicker(value, hidUsageLimits, onCommit) {
    const wrap = document.createElement('div');
    const decoded = TpKeycodes.decodeUsage(value >>> 0);
    let current = { page: decoded.page, id: decoded.id };
    const baseKeys = TpKeycodes.KEYS.filter((k) => TpKeymapUi.keycodeWithinHidUsage(k, hidUsageLimits));
    const modRow = document.createElement('div');
    modRow.className = 'modrow';
    const MOD_UI = [
      ['LC', '⌃左'], ['RC', '⌃右'], ['LS', '⇧左'], ['RS', '⇧右'],
      ['LA', '⌥左'], ['RA', '⌥右'], ['LG', '⌘左'], ['RG', '⌘右'],
    ];
    const checkboxes = {};
    const initFlags = TpKeymapUi.flagsFromMods(decoded.mods);
    for (const [key, text] of MOD_UI) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!initFlags[key];
      checkboxes[key] = cb;
      cb.onchange = () => { commitUsage(); renderList(); };
      lab.append(cb, document.createTextNode(text));
      modRow.appendChild(lab);
    }
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'kcsearch';
    search.placeholder = 'キーコード検索';
    const groupsWrap = document.createElement('div');
    groupsWrap.className = 'kcgroups';

    function currentMods() {
      const flags = {};
      for (const [key] of MOD_UI) flags[key] = checkboxes[key].checked;
      return TpKeymapUi.modsFromFlags(flags);
    }

    function commitUsage() {
      onCommit(TpKeycodes.encodeUsage(current.page, current.id, currentMods()) >>> 0);
    }

    function selectKey(k) {
      const d = TpKeycodes.decodeUsage(k.value);
      current = { page: d.page, id: d.id };
      const flags = TpKeymapUi.flagsFromMods(d.mods);
      for (const [key] of MOD_UI) checkboxes[key].checked = !!flags[key];
      commitUsage();
      renderList();
    }

    function renderList() {
      groupsWrap.innerHTML = '';
      const curValue = TpKeycodes.encodeUsage(current.page, current.id, currentMods()) >>> 0;
      const filtered = TpKeymapUi.filterKeycodes(baseKeys, search.value);
      const groups = TpKeymapUi.groupKeycodes(filtered);
      for (const groupName of Object.keys(groups)) {
        const title = document.createElement('div');
        title.className = 'kcgroup-title';
        title.textContent = groupName;
        groupsWrap.appendChild(title);
        const grid = document.createElement('div');
        grid.className = 'kcgrid';
        for (const k of groups[groupName]) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'kcbtn' + (k.value === curValue ? ' selected' : '');
          btn.textContent = k.label;
          btn.title = k.name;
          btn.onclick = () => selectKey(k);
          grid.appendChild(btn);
        }
        groupsWrap.appendChild(grid);
      }
    }
    search.oninput = renderList;
    renderList();
    wrap.append(modRow, search, groupsWrap);
    return wrap;
  }

  function renderSlotField(labelText, slot, value, onCommit) {
    if (slot.kind === 'none' || slot.kind === 'nil') return null;
    if (slot.kind === 'range') return renderField(labelText, renderNumberInput(value, slot.range.min, slot.range.max, onCommit));
    if (slot.kind === 'constant') {
      const sel = document.createElement('select');
      for (const opt of slot.options) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.name || String(opt.value);
        if (opt.value === value) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => onCommit(Number(sel.value));
      return renderField(labelText, sel);
    }
    if (slot.kind === 'layerId') {
      const sel = document.createElement('select');
      keymapData.layers.forEach((l, i) => {
        const o = document.createElement('option');
        o.value = String(l.id);
        o.textContent = `L${i}: ${l.name}`;
        if (l.id === value) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => onCommit(Number(sel.value));
      return renderField(labelText, sel);
    }
    if (slot.kind === 'hidUsage') return renderField(labelText, renderKeycodePicker(value, slot.hidUsage, onCommit));
    return renderField(labelText, renderNumberInput(value, 0, 0xffffffff, onCommit));
  }

  function renderParamInputs(set, binding, container) {
    container.innerHTML = '';
    const f1 = renderSlotField('param1', TpKeymapUi.describeParamSlot(set.param1), binding.param1,
      (v) => commitBinding({ ...binding, param1: v }));
    const f2 = renderSlotField('param2', TpKeymapUi.describeParamSlot(set.param2), binding.param2,
      (v) => commitBinding({ ...binding, param2: v }));
    if (f1) container.appendChild(f1);
    if (f2) container.appendChild(f2);
  }

  function presetEntryLabel(entry) {
    const resolved = TpPresets.resolveEntry(entry, behaviors, keymapData.layers);
    if (resolved) return TpKeymapUi.bindingLabel(resolved, behaviors, keymapData.layers);
    return entry.behavior || '不明な behavior';
  }

  function renderKeyEditor() {
    const panel = $('keyEditor');
    const body = $('keyEditorBody');
    body.innerHTML = '';
    if (selectedKeyPos === null) { panel.hidden = true; return; }
    panel.hidden = false;
    const diffEntry = presetDiff().keys.find((k) => k.layer === selectedLayerIndex && k.pos === selectedKeyPos);
    if (diffEntry) {
      const mark = document.createElement('div');
      mark.className = 'presetmark';
      mark.textContent = 'プリセット: ' + presetEntryLabel(diffEntry.preset);
      body.appendChild(mark);
    }
    const layer = keymapData.layers[selectedLayerIndex];
    const fallbackBehaviorId = behaviors.length ? behaviors[0].id : 0;
    const binding = layer.bindings[selectedKeyPos] || { behaviorId: fallbackBehaviorId, param1: 0, param2: 0 };

    const behSelect = document.createElement('select');
    for (const b of behaviors) {
      const o = document.createElement('option');
      o.value = String(b.id);
      o.textContent = b.displayName;
      if (b.id === binding.behaviorId) o.selected = true;
      behSelect.appendChild(o);
    }
    behSelect.onchange = () => {
      const next = behaviors.find((b) => b.id === Number(behSelect.value));
      const keyA = TpKeycodes.KEYS.find((k) => k.name === 'A');
      commitBinding(TpKeymapUi.defaultBindingFor(next, keyA ? keyA.value : 0));
    };
    body.appendChild(renderField('behavior', behSelect));

    const behavior = behaviors.find((b) => b.id === binding.behaviorId);
    if (!behavior) return;
    const sets = behavior.metadata || [];
    if (sets.length === 0) {
      body.appendChild(renderField('param1', renderNumberInput(binding.param1, 0, 0xffffffff,
        (v) => commitBinding({ ...binding, param1: v }))));
      body.appendChild(renderField('param2', renderNumberInput(binding.param2, 0, 0xffffffff,
        (v) => commitBinding({ ...binding, param2: v }))));
      return;
    }
    let setIdx = TpKeymapUi.findMatchingSetIndex(behavior, binding, keymapData.layers);
    if (setIdx < 0) setIdx = 0;
    const paramsContainer = document.createElement('div');
    if (sets.length > 1) {
      const setSelect = document.createElement('select');
      sets.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `セット ${i + 1}`;
        if (i === setIdx) o.selected = true;
        setSelect.appendChild(o);
      });
      setSelect.onchange = () => renderParamInputs(sets[Number(setSelect.value)], binding, paramsContainer);
      body.appendChild(renderField('パラメータの種類', setSelect));
    }
    body.appendChild(paramsContainer);
    renderParamInputs(sets[setIdx], binding, paramsContainer);
  }

  async function saveExportedFile(name, text) {
    try {
      const res = await Link.saveFile(name, text);
      if (res.cancelled) return;
      if (!res.ok) { root.TpAppMain.setStatus('保存に失敗しました: ' + (res.error || ''), true); return; }
      root.TpAppMain.setStatus((res.path || name) + ' に保存しました');
    } catch (e) {
      root.TpAppMain.setStatus('保存に失敗しました: ' + errText(e), true);
    }
  }

  async function exportKeymap() {
    if (!keymapData || !physicalLayout) { root.TpAppMain.setStatus('キー設定を読み込んでからエクスポートしてください', true); return; }
    const layout = physicalLayout.layouts[physicalLayout.activeLayoutIndex] || { keys: [] };
    const text = TpKeymapExport.exportKeymap({ keymap: keymapData, behaviors, layout });
    await saveExportedFile('lalapadgen2.keymap', text);
  }

  async function save() {
    if (!studioClient) throw new Error('Studio に接続されていません');
    await Pad.setTrackpadQuiet(true);
    try {
      await studioClient.saveChanges();
      studioDirty = false;
      root.TpAppMain.renderHeader();
    } finally {
      if (activeTab !== 'keymap') await Pad.setTrackpadQuiet(false);
    }
  }

  async function reload() {
    if (!isStudioUsable()) return false;
    if (!studioClient) createStudioClient();
    await Pad.setTrackpadQuiet(true);
    try {
      if (studioDirty) {
        try { await studioClient.discardChanges(); studioDirty = false; } catch (e) { /* 続けて読み直す */ }
      }
      await loadKeymapData();
      return isReady();
    } finally {
      if (activeTab !== 'keymap') await Pad.setTrackpadQuiet(false);
    }
  }

  async function resetToDefault() {
    if (!studioClient) throw new Error('Studio に接続されていません');
    await Pad.setTrackpadQuiet(true);
    try {
      const ok = await studioClient.resetSettings();
      if (!ok) throw new Error('ファームが拒否しました');
      studioDirty = false;
      await loadKeymapData();
    } finally {
      if (activeTab !== 'keymap') await Pad.setTrackpadQuiet(false);
    }
  }

  async function applyPresetKeymap(preset) {
    if (!studioClient || !keymapData) return { applied: 0, skipped: 0, layerError: 'キー設定を読み込んでから反映してください' };
    await Pad.setTrackpadQuiet(true);
    try {
      const adjust = TpPresets.layerCountAdjust(preset, keymapData);
      let layerError = null;
      for (let i = 0; i < adjust.add && !layerError; i++) {
        if (!keymapData || keymapData.availableLayers <= 0) { layerError = 'レイヤーをこれ以上追加できません'; break; }
        try {
          const res = await studioClient.addLayer();
          keymapData.layers.push(res.layer);
          keymapData.availableLayers = Math.max(0, keymapData.availableLayers - 1);
        } catch (e) {
          layerError = 'レイヤーの追加に失敗しました: ' + errText(e);
        }
      }
      for (let i = 0; i < adjust.remove && !layerError && keymapData && keymapData.layers.length > 1; i++) {
        const lastIndex = keymapData.layers.length - 1;
        try {
          await studioClient.removeLayer(lastIndex);
          keymapData.layers.splice(lastIndex, 1);
          keymapData.availableLayers += 1;
        } catch (e) {
          layerError = 'レイヤーの削除に失敗しました: ' + errText(e);
        }
      }
      if (studioClient && keymapData) {
        try {
          keymapData = await studioClient.getKeymap();
        } catch (e) {
          layerError = layerError || ('キー設定の再取得に失敗しました: ' + errText(e));
        }
      }
      if (!studioClient || !keymapData) {
        return { applied: 0, skipped: 0, layerError: layerError || 'キー設定の接続が切れました' };
      }
      let applied = 0;
      let skipped = 0;
      const plan = TpPresets.planKeymapBindings(preset, keymapData, behaviors);
      skipped += plan.skipped.length;
      for (let i = 0; i < plan.ops.length; i++) {
        if (!studioClient || !keymapData) { skipped += plan.ops.length - i; break; }
        const op = plan.ops[i];
        try {
          const code = await studioClient.setLayerBinding(op.layerId, op.pos, op.binding);
          if (code) { skipped++; continue; }
          keymapData.layers[op.layerIndex].bindings[op.pos] = op.binding;
          applied++;
        } catch (e) {
          skipped++;
        }
      }
      if (studioClient) {
        try { studioDirty = await studioClient.checkUnsavedChanges(); } catch (e) { /* 反映結果は返すので通知は諦める */ }
      }
      if (keymapData && selectedLayerIndex >= keymapData.layers.length) selectedLayerIndex = 0;
      renderKeymapWorkspace();
      root.TpAppMain.renderHeader();
      return { applied, skipped, layerError };
    } finally {
      if (activeTab !== 'keymap') await Pad.setTrackpadQuiet(false);
    }
  }

  function handleStudioReady(available) {
    clearTimeout(studioUsbWaitTimer);
    studioAvailable = available;
    updateStudioAvailability();
  }

  function handleStudioData(bytes) {
    if (studioClient) studioClient.onData(bytes);
  }

  function handleStudioClosed(reason) {
    studioAvailable = false;
    studioUsbOpenTried = false;
    teardownStudio();
    updateStudioAvailability();
    if (reason) root.TpAppMain.log('Studio 接続が終了しました: ' + reason);
  }

  function setActiveTab(tab) {
    activeTab = tab;
    if (tab === 'keymap' && isReady()) Pad.setTrackpadQuiet(true);
  }

  $('btnLayerAdd').onclick = async () => {
    if (!studioClient || keymapData.availableLayers <= 0) return;
    try {
      const res = await studioClient.addLayer();
      keymapData.layers.push(res.layer);
      keymapData.availableLayers = Math.max(0, keymapData.availableLayers - 1);
      selectedLayerIndex = keymapData.layers.length - 1;
      selectedKeyPos = null;
      studioDirty = true;
      renderKeymapWorkspace();
      root.TpAppMain.renderHeader();
    } catch (e) {
      root.TpAppMain.setStatus('レイヤーの追加に失敗しました: ' + errText(e), true);
    }
  };
  $('btnLayerRemove').onclick = async () => {
    if (!studioClient || keymapData.layers.length < 2) return;
    if (!window.confirm(`レイヤー「${keymapData.layers[selectedLayerIndex].name}」を削除します。よろしいですか?`)) return;
    try {
      await studioClient.removeLayer(selectedLayerIndex);
      keymapData.layers.splice(selectedLayerIndex, 1);
      keymapData.availableLayers += 1;
      selectedLayerIndex = 0;
      selectedKeyPos = null;
      studioDirty = true;
      renderKeymapWorkspace();
      root.TpAppMain.renderHeader();
    } catch (e) {
      root.TpAppMain.setStatus('レイヤーの削除に失敗しました: ' + errText(e), true);
    }
  };

  const api = {
    setActiveTab, updateAvailability: updateStudioAvailability, teardownStudio, disconnectCleanup,
    handleStudioReady, handleStudioData, handleStudioClosed,
    isReady, ensureLoaded, isDirty, snapshot, setPresetKeymap, presetDiff, applyPresetKeymap,
    save, reload, resetToDefault, exportKeymap,
  };
  root.TpAppKeymap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
