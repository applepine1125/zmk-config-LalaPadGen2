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
  let studioBusy = false;
  let studioUsbOpenTried = false;
  let studioUsbWaitTimer = null;
  let physicalLayout = null;
  let behaviors = [];
  let keymapData = null;
  let selectedLayerIndex = 0;
  let selectedKeyPos = null;
  let activeTab = 'trackpad';

  function setStudioNotice(text) {
    const el = $('studioNotice');
    el.textContent = text;
    el.hidden = !text;
  }

  function renderStudioHeader() {
    const hasData = !!keymapData;
    $('btnStudioSave').disabled = !hasData || !studioDirty;
    $('btnStudioReload').disabled = !studioClient;
    $('btnStudioReset').disabled = !hasData;
    $('btnKeymapExport').disabled = !hasData || !physicalLayout;
    $('studioDirtyIndicator').hidden = !studioDirty;
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
    renderStudioHeader();
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
        renderStudioHeader();
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

  function updateStudioAvailability() {
    if (activeTab !== 'keymap') return;
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
    if (!keymapData) loadKeymapData(); else renderKeymapWorkspace();
  }

  async function loadKeymapData() {
    if (studioBusy || !studioClient) return;
    studioBusy = true;
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
      renderStudioHeader();
    } catch (e) {
      setStudioNotice('キー設定の読み込みに失敗しました: ' + errText(e) + '(「再読み込み」でやり直せます)');
    } finally {
      studioBusy = false;
      renderStudioHeader();
    }
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
    keymapData.layers.forEach((layer, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layer-btn' + (i === selectedLayerIndex ? ' active' : '');
      b.textContent = layer.name || `Layer ${i}`;
      b.onclick = () => { selectedLayerIndex = i; selectedKeyPos = null; renderKeymapWorkspace(); };
      wrap.appendChild(b);
    });
    $('btnLayerAdd').disabled = !studioClient || keymapData.availableLayers <= 0;
    $('btnLayerRemove').disabled = !studioClient || keymapData.layers.length < 2;
  }

  function renderKeymapSvg() {
    const wrap = $('keymapSvgWrap');
    wrap.innerHTML = '';
    const layout = physicalLayout.layouts[physicalLayout.activeLayoutIndex];
    if (!layout || !layout.keys.length) return;
    const bounds = TpKeymapUi.layoutBounds(layout.keys);
    const scale = bounds.width > 0 ? 1200 / bounds.width : 40;
    const pad = 10;
    const svgW = bounds.width * scale + pad * 2;
    const svgH = bounds.height * scale + pad * 2;
    const layer = keymapData.layers[selectedLayerIndex];
    const bindings = (layer && layer.bindings) || [];
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    layout.keys.forEach((key, idx) => {
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
      rect.setAttribute('class', 'keycap' + (idx === selectedKeyPos ? ' selected' : ''));
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
    try {
      const code = await studioClient.setLayerBinding(targetLayer.id, pos, newBinding);
      if (code) {
        targetLayer.bindings[pos] = prevBinding;
        renderKeymapSvg();
        if (isStillSelected()) renderKeyEditor();
        root.TpAppMain.setStatus('キーの設定に失敗しました: ' + TpKeymapUi.setBindingErrorText(code), true);
      } else {
        studioDirty = true;
        renderStudioHeader();
      }
    } catch (e) {
      targetLayer.bindings[pos] = prevBinding;
      renderKeymapSvg();
      if (isStillSelected()) renderKeyEditor();
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

  function renderKeyEditor() {
    const panel = $('keyEditor');
    const body = $('keyEditorBody');
    body.innerHTML = '';
    if (selectedKeyPos === null) { panel.hidden = true; return; }
    panel.hidden = false;
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

  async function exportKeymapNow() {
    if (!keymapData || !physicalLayout) return;
    const layout = physicalLayout.layouts[physicalLayout.activeLayoutIndex] || { keys: [] };
    const text = TpKeymapExport.exportKeymap({ keymap: keymapData, behaviors, layout });
    await saveExportedFile('lalapadgen2.keymap', text);
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
  }

  $('btnStudioSave').onclick = async () => {
    if (!studioClient) return;
    try {
      await studioClient.saveChanges();
      studioDirty = false;
      renderStudioHeader();
      root.TpAppMain.setStatus('キー設定を書き込みました');
    } catch (e) {
      root.TpAppMain.setStatus('書き込みに失敗しました: ' + errText(e), true);
    }
  };
  // 再読み込み: 書き込み前の変更を捨て、キーボードに保存されている状態を読み直す
  $('btnStudioReload').onclick = async () => {
    if (!studioClient) { updateStudioAvailability(); return; }
    try {
      if (studioDirty && !window.confirm('書き込んでいない変更を捨てて、キーボードに保存されている状態に戻します。よろしいですか?')) return;
      if (studioDirty) { await studioClient.discardChanges(); studioDirty = false; }
      await loadKeymapData();
      if (keymapData) root.TpAppMain.setStatus('キー設定を再読み込みしました');
    } catch (e) {
      root.TpAppMain.setStatus('再読み込みに失敗しました: ' + errText(e), true);
    }
  };
  // デフォルトに戻す: 保存済みの変更も消して、ファームに組み込まれたキーマップ(リポジトリの .keymap)に戻す
  $('btnStudioReset').onclick = async () => {
    if (!studioClient) return;
    if (!window.confirm('キー設定をデフォルト(ファームに組み込まれたキーマップ)に戻しますか? 書き込み済みの変更もすべて消えます。')) return;
    try {
      const ok = await studioClient.resetSettings();
      if (!ok) throw new Error('ファームが拒否しました');
      studioDirty = false;
      await loadKeymapData();
      root.TpAppMain.setStatus('キー設定をデフォルトに戻しました');
    } catch (e) {
      root.TpAppMain.setStatus('デフォルトに戻せませんでした: ' + errText(e), true);
    }
  };
  $('btnKeymapExport').onclick = () => { exportKeymapNow(); };
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
      renderStudioHeader();
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
      renderStudioHeader();
    } catch (e) {
      root.TpAppMain.setStatus('レイヤーの削除に失敗しました: ' + errText(e), true);
    }
  };

  const api = {
    setActiveTab, updateAvailability: updateStudioAvailability, teardownStudio, disconnectCleanup,
    handleStudioReady, handleStudioData, handleStudioClosed,
  };
  root.TpAppKeymap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
