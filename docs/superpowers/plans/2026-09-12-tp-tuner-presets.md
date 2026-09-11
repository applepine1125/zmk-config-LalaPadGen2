# tp-tuner プリセット・共通操作行・パラメータ検索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tp-tuner にタッチパッド + キー設定をまとめたプリセット(選択・新規作成・上書き保存・削除・差分表示)と、タブ共通の操作行、パラメータ検索、ON/OFF 表示を入れ、キー設定タブから十字キーとトラックパッドの割り当てを隠す。

**Architecture:** 差分計算・スナップショット・保存形式は依存なしの純粋関数モジュール `presets.js` に置いて node でテストする。画面側は既存の IIFE モジュール(`app_params.js` / `app_keymap.js`)にスナップショット取得・反映・差分の印の API を足し、新規 `app_presets.js` がプリセット行を、`app_main.js` が共通操作行を受け持つ。保存は Mac アプリの橋渡し(`presetsLoad` / `presetsSave`)で Application Support の JSON に書き、ブラウザでは localStorage に書く。

**Tech Stack:** 素の JavaScript(IIFE、`root.TpXxx` + `module.exports`)、`node --test`、Swift(WKWebView 橋渡し)。

**Spec:** `docs/superpowers/specs/2026-09-12-tp-tuner-presets-design.md`

## Global Constraints

- リポジトリ: `/Users/takashi.matsuyuki.001/go/src/github.com/applepine1125/zmk-config-LalaPadGen2`、ブランチ `trackpad-tuner` に直接コミットする(worktree は作らない)
- git は `git -C <repo> ...` 形式で実行する(`cd <path> && git` は禁止)
- ページは外部依存なし・ES modules なし。新規 JS も既存と同じ IIFE 形式 `(function (root) { 'use strict'; ... root.TpXxx = api; if (typeof module !== 'undefined' && module.exports) module.exports = api; })(typeof globalThis !== 'undefined' ? globalThis : this);`
- UI 文言は日本語
- テスト名は日本語で「<前提>のとき、<操作>すると<結果>になる」形式(不自然なら自然な表現)
- 自明なコメントは書かない。既存コードの書き方(命名・コメント密度)に合わせる
- すべてのファイルは最終行に改行、行末空白なし
- テスト: `node --test tools/tp-tuner/`(全件緑を保つ)
- Mac アプリのビルド: `tools/tp-tuner-mac/build.sh`(`--install` はコントローラーが最後に行う)
- コミットメッセージは日本語。末尾に次の 2 行を付ける:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01GMExPaFdu87DUnqeQRRdxZ
  ```
- zsh は noclobber(上書きリダイレクトは `>|`)、`rm` は `trash` のエイリアス
- 実装者は subagent を起動しない

---

### Task 1: 純粋関数(presets.js 新規、tuner.js / keymap_ui.js 追加)

**Files:**
- Create: `tools/tp-tuner/presets.js`
- Create: `tools/tp-tuner/presets.test.js`
- Modify: `tools/tp-tuner/tuner.js`(`formatParamValue`、`paramMatchesQuery` を追加し `api` に載せる)
- Modify: `tools/tp-tuner/tuner.test.js`
- Modify: `tools/tp-tuner/keymap_ui.js`(`HIDDEN_KEY_POSITIONS`、`isKeyHidden` を追加し `api` に載せる)
- Modify: `tools/tp-tuner/keymap_ui.test.js`
- Modify: `tools/tp-tuner/index.html`(`<script src="presets.js"></script>` を `keymap_export.js` の次に追加)

**Interfaces:**
- Produces(`TpTuner`):
  - `formatParamValue(kind, value)` → `kind === 'driver_bool'` なら `value ? 'ON' : 'OFF'`、それ以外は `String(value)`
  - `paramMatchesQuery(name, help, query)` → `query` を trim して小文字化。空なら `true`。`name` か `help`(未定義可)を小文字化して部分一致なら `true`
- Produces(`TpKeymapUi`):
  - `HIDDEN_KEY_POSITIONS` → `[42, 43, ..., 67]`(26 要素、十字キー 42〜51 とトラックパッド割り当て 52〜67)
  - `isKeyHidden(pos)` → `HIDDEN_KEY_POSITIONS` に含まれれば `true`
- Produces(`TpPresets`、`presets.js`。node では `require('./keymap_ui.js')` で `TpKeymapUi` を得る。ブラウザでは `root.TpKeymapUi`):
  - `STORE_VERSION` = `1`
  - `emptyStore()` → `{ version: 1, selectedId: null, presets: [] }`
  - `parseStore(text)` → `text` が `null` / `undefined` / 空文字なら `{ ok: true, store: emptyStore() }`。JSON として読めない、オブジェクトでない、`version !== 1`、`presets` が配列でないときは `{ ok: false, error: '<日本語の理由>' }`。`id` と `name` が文字列でない要素は捨てる。`selectedId` はどのプリセットの `id` とも一致しなければ `null`。各プリセットの `trackpad` / `keymap` は無ければ `null` にそろえる
  - `serializeStore(store)` → `JSON.stringify(store, null, 2) + '\n'`
  - `findPreset(store, id)` → 該当プリセットか `null`
  - `validateName(store, name, exceptId)` → trim した名前が空なら `{ ok: false, error: '名前を入力してください' }`、`exceptId` 以外に同名があれば `{ ok: false, error: '同じ名前のプリセットがあります' }`、それ以外は `{ ok: true, name: <trim 済み> }`
  - `createPreset(store, { name, trackpad, keymap }, { id, now })` → 名前検証に失敗したら `{ ok: false, error }`。成功なら `{ ok: true, store: <新しい store>, preset }`。新プリセットは `{ id, name, createdAt: now, updatedAt: now, trackpad: trackpad || null, keymap: keymap || null }` で末尾に追加、`selectedId = id`。元の `store` は変更しない
  - `updatePreset(store, id, { trackpad, keymap }, now)` → 新しい store を返す。`trackpad` が非 null なら側ごとにマージ(渡された側だけ置き換え、渡されなかった側は既存を残す。既存が null なら渡された内容そのもの)。`keymap` が非 null なら置き換え、null なら既存を残す。`updatedAt = now`。該当 id が無ければ store をそのまま返す
  - `deletePreset(store, id)` → 該当を除いた新しい store。`selectedId === id` なら `null`
  - `selectPreset(store, id)` → `id` が `null` か存在する id なら `selectedId` を差し替えた新しい store。存在しない id なら `selectedId: null`
  - `trackpadScreenValues(paramsBySide, pending)` → `paramsBySide` は `{ R: [{ name, value, ... }], L: [...] }`(`tp list` のパース結果)。`pending` は `{ common: {}, R: {}, L: {} }`。戻り値は `{ R?: { name: value }, L?: { name: value } }` で、パラメータ配列が空の側はキー自体を持たない。値の優先順は `pending[side][name]` → `pending.common[name]` → キーボードの値
  - `trackpadDiff(presetTrackpad, screen)` → `presetTrackpad` が null なら `[]`。`R` → `L` の順、同じ側の中は `screen[side]` のキー順で、プリセットと画面の両方に名前がありかつ値が違うものを `{ side, name, preset, screen }` で返す
  - `trackpadPendingFromPreset(presetTrackpad, paramsBySide)` → `{ common, R, L }`。対象はパラメータが読めている側。名前ごとに、読めている全側でプリセットに値があり、それらが同じ値なら、キーボード値がどれか 1 側でも違うとき `common[name] = v`。そうでなければ側ごとに、プリセットに値がありキーボード値と違うとき `side[name] = v`。`presetTrackpad` が null なら全て空
  - `keymapSnapshot(keymap, behaviors, hiddenPositions)` → `{ layers: [{ name, bindings: [entry | null] }] }`。`keymap` は Studio の `{ layers: [{ id, name, bindings: [{ behaviorId, param1, param2 }] }] }`、`behaviors` は `[{ id, displayName, metadata }]`。`hiddenPositions` に含まれる位置は `null`。entry は `{ behavior: displayName, param1, param2 }`。`TpKeymapUi.findMatchingSetIndex(behavior, binding, keymap.layers)` で決めたパラメータセットの `describeParamSlot(...).kind === 'layerId'` のスロットは、値(レイヤー ID)を `{ layer: <そのレイヤーの番号> }` に置き換える(該当レイヤーが無ければ数値のまま)。behavior が見つからない binding は `{ behavior: null, param1, param2 }`
  - `entriesEqual(a, b)` → behavior 名と param1 / param2 が等しい(`{ layer }` 同士はレイヤー番号で比較)なら `true`。どちらかが null なら `a === b`
  - `keymapDiff(presetKeymap, screenSnapshot)` → どちらかが null なら `{ layerCount: null, keys: [] }`。レイヤー数が違えば `layerCount: { preset, screen }`、同じなら `null`。`keys` は共通のレイヤー番号の範囲で、両方の entry が非 null かつ `entriesEqual` でない位置を `{ layer, pos, preset, screen }` で返す
  - `diffCount(trackpadDiffList, keymapDiffResult)` → `trackpadDiffList.length + keys.length + (layerCount ? 1 : 0)`(引数は null 可)
  - `resolveEntry(entry, behaviors, layers)` → `{ behaviorId, param1, param2 }` か `null`。behavior は `displayName` の完全一致で引き、無ければ `null`。`{ layer: i }` は `layers[i].id` に直し、範囲外なら `null`
  - `layerCountAdjust(presetKeymap, keymap)` → `{ add: max(0, preset 層数 - 現層数), remove: max(0, 現層数 - preset 層数) }`
  - `planKeymapBindings(presetKeymap, keymap, behaviors)` → `{ ops: [{ layerIndex, layerId, pos, binding }], skipped: [{ layer, pos, behavior }] }`。共通のレイヤー番号の範囲で、プリセットの entry が非 null かつ現在の keymap(`keymapSnapshot(keymap, behaviors, [])`)の entry と `entriesEqual` でない位置を対象にし、`resolveEntry` できれば `ops`、できなければ `skipped` に入れる

- [ ] **Step 1: `tuner.test.js` / `keymap_ui.test.js` に追加関数のテストを書き、失敗を確認する**

  最低限のケース:
  - `formatParamValue('driver_bool', 1)` → `'ON'`、`('driver_bool', 0)` → `'OFF'`、`('ic_u16', 250)` → `'250'`
  - `paramMatchesQuery('cursor_inertia_decay', '慣性の減衰', '慣性')` → true、`('cursor_inertia_decay', '', 'INERTIA')` → true、`('1f_tap_max_ms', 'タップ', 'scroll')` → false、空クエリは true
  - `HIDDEN_KEY_POSITIONS` の長さ 26・先頭 42・末尾 67、`isKeyHidden(41)` false、`isKeyHidden(42)` true、`isKeyHidden(67)` true、`isKeyHidden(68)` false

  Run: `node --test tools/tp-tuner/` → 新規テストが FAIL

- [ ] **Step 2: tuner.js / keymap_ui.js に実装して緑にする**

- [ ] **Step 3: `presets.test.js` を書き、失敗を確認する**

  最低限のケース(各関数の上記仕様を網羅すること):
  - `parseStore`: 空文字 / null → 空 store、壊れた JSON → ok:false、version 2 → ok:false、id の無い要素が捨てられる、存在しない selectedId が null になる、trackpad 欠落が null にそろう
  - `serializeStore` → 末尾改行付きで `parseStore` に戻すと同じ
  - `validateName`: 空白だけ → エラー、同名 → エラー、`exceptId` 自身の名前は通る、前後空白が trim される
  - `createPreset`: 追加され `selectedId` が新 id、元 store は変わらない、同名はエラー
  - `updatePreset`: trackpad の `{ R }` だけ渡すと L は既存のまま、keymap null なら既存のまま、`updatedAt` が更新され `createdAt` は変わらない
  - `deletePreset`: 選択中を消すと `selectedId` null、選択外を消すと `selectedId` 維持
  - `selectPreset`: null / 存在 / 非存在
  - `trackpadScreenValues`: pending の側別 > 共通 > キーボード値の優先順、パラメータの無い側はキーを持たない
  - `trackpadDiff`: 値の違う名前だけ・R → L 順・片方にしかない名前は出ない・null で空
  - `trackpadPendingFromPreset`: 両側同値でキーボードの片側だけ違う → common、両側で違う値 → R / L 別、キーボードと同じ値 → 何も入らない、読めていない側(params 空)は無視、プリセットに無い名前は無視
  - `keymapSnapshot`: Key Press はそのまま、Momentary Layer(metadata の param1 が `layerId`)の param1 が `{ layer: index }` になる、hidden 位置が null、未知 behaviorId は `behavior: null`
  - `keymapDiff`: 同一なら空、1 キー違い → 1 件、hidden(null)位置は比較しない、レイヤー数違い → layerCount と共通範囲の keys
  - `diffCount`
  - `resolveEntry`: 名前から ID、`{ layer }` を ID に、未知 behavior → null、範囲外レイヤー → null
  - `layerCountAdjust`
  - `planKeymapBindings`: 違う位置だけ ops、未知 behavior は skipped、同じ位置は出ない

  テスト用の behaviors は metadata を Studio の形(`{ param1: [{ hidUsage: {...} }], param2: [] }`、`{ param1: [{ layerId: {} }], param2: [] }`、Transparent は `[]`)で作る。`TpKeymapUi.describeParamSlot` / `paramDescKind` の判定条件(`keymap_ui.js:51-103`)に合わせること

  Run: `node --test tools/tp-tuner/` → presets のテストが FAIL

- [ ] **Step 4: `presets.js` を実装して緑にする**

  Run: `node --test tools/tp-tuner/` → 全件 PASS

- [ ] **Step 5: index.html に script タグを追加してコミット**

  ```bash
  git -C <repo> add tools/tp-tuner/presets.js tools/tp-tuner/presets.test.js tools/tp-tuner/tuner.js tools/tp-tuner/tuner.test.js tools/tp-tuner/keymap_ui.js tools/tp-tuner/keymap_ui.test.js tools/tp-tuner/index.html
  git -C <repo> commit -m "プリセットの差分・スナップショット・保存形式の純粋関数を追加する"
  ```

---

### Task 2: プリセットの保存先(橋渡し・Swift・模擬)

**Files:**
- Modify: `tools/tp-tuner/app_link.js`
- Modify: `tools/tp-tuner-mac/Sources/WebBridge.swift`
- Modify: `tools/tp-tuner/dev/fake-native.js`

**Interfaces:**
- Produces(`TpAppLink`):
  - `loadPresetsText()` → `Promise<{ ok: boolean, text?: string, error?: string }>`。ネイティブ橋渡しがあれば `{ type: 'presetsLoad' }` を送り `presetsLoaded` イベントで解決する。無ければ `localStorage.getItem('tp-tuner.presets')`(例外時は `{ ok: false, error }`)
  - `savePresetsText(text)` → `Promise<{ ok: boolean, error?: string }>`。ネイティブなら `{ type: 'presetsSave', text }` → `presetsSaved`。無ければ `localStorage.setItem`
  - 同時に複数呼ばれても取り違えないよう、要求ごとに待ち行列で順に解決する(既存 `pendingSaveFile` と同様の考え方。load / save それぞれ FIFO でよい)
- Swift(`WebBridge.swift`):
  - `presetsLoad`: `FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("TpTuner/presets.json")` を読む。ファイルが無ければ `send(type: "presetsLoaded", payload: ["ok": true])`、読めたら `["ok": true, "text": <内容>]`、失敗なら `["ok": false, "error": <localizedDescription>]`
  - `presetsSave`: `TpTuner` ディレクトリを作成(`withIntermediateDirectories: true`)し、`Data(text.utf8).write(to:options: .atomic)` で書く。結果を `presetsSaved`(`ok` / `error`)で返す
- `fake-native.js`: `presetsLoad` / `presetsSave` をメモリ上の文字列(初期値 null)で模擬し、同じイベントを返す

- [ ] **Step 1: app_link.js に API を追加し、`window.tpTunerNative.onEvent` で `presetsLoaded` / `presetsSaved` を処理する**
- [ ] **Step 2: WebBridge.swift の `handlePageMessage` に 2 メッセージを追加する**
- [ ] **Step 3: fake-native.js に模擬を追加する**
- [ ] **Step 4: 確認**

  Run: `node --test tools/tp-tuner/`(既存が緑のまま)、`tools/tp-tuner-mac/build.sh`(ビルド成功)

- [ ] **Step 5: コミット** `プリセットの保存先(Application Support / localStorage)を読み書きできるようにする`

---

### Task 3: パラメータ画面(ON/OFF・検索・プリセット差分・スナップショット API)

**Files:**
- Modify: `tools/tp-tuner/app_params.js`
- Modify: `tools/tp-tuner/index.html`(検索欄と差分の印の CSS)

**Interfaces:**
- Consumes: `TpTuner.formatParamValue`、`TpTuner.paramMatchesQuery`、`TpPresets.trackpadScreenValues` / `trackpadDiff` / `trackpadPendingFromPreset`
- Produces(`TpAppParams`、既存 API に追加):
  - `screenTrackpad()` → `TpPresets.trackpadScreenValues({ R: params.R, L: params.L }, pending)`
  - `setPresetTrackpad(presetTrackpadOrNull)` → 差分の印の比較対象を設定して再描画
  - `presetDiff()` → `TpPresets.trackpadDiff(presetTrackpad, screenTrackpad())`
  - `applyPresetTrackpad(presetTrackpad)` → `pending = TpPresets.trackpadPendingFromPreset(presetTrackpad, { R: params.R, L: params.L })`、再描画、`root.TpAppMain.renderHeader()`
  - `write()` → 既存 `writeAll` の確認なし版。`Promise<{ written: number, failed: number, total: number }>`(ステータス表示はしない。未接続・変更なしは `total: 0`)
  - `reload()` → 確認なしで pending を捨てて読み直す。`Promise<number>`(読み込んだ件数)
  - `resetToDefault()` → 確認なしで `tp reset` と読み直し。`Promise<boolean>`(全側成功なら true)
  - 既存の `btnWrite` / `btnReload` / `btnResetAll` / `btnExport` のハンドラ登録と `setButtonsEnabled` は削除し、`exportConf()`(既存 `exportConfNow`)を API に出す(ボタンの登録は Task 5 で `app_main.js` が行う)

- [ ] **Step 1: ON/OFF 表示**

  `pendingmark`(`app_params.js:202`, `255`, `276`)、左右差の説明(`302`)を `T.formatParamValue(p.kind, v)` で表示する。`updateRowMark` は `p.kind` を知らないので、行の要素(`row.classList.contains('bool')`)か `mergedByName[name].kind` から kind を得る

- [ ] **Step 2: 左右共通表示で側ごとの pending を画面の値として扱う**

  - 共通表示で左右差の説明を出す条件と値を、キーボード値(`p.valueR` / `p.valueL`)ではなく `sideGetValue('R', name)` / `sideGetValue('L', name)` にする(両側が読めているときだけ)
  - 共通表示のエディタの初期値は `pending.common` → 両側の画面値が同じならその値 → キーボード値
  - 共通表示で値を変えたら `pending.R[name]` / `pending.L[name]` を消してから `pending.common` を設定する(`setPendingCommon`)。側ごとの pending が残っていた行は、変更後に行を再描画して印をそろえる
  - 共通表示で側ごとの pending がある行にも未書き込みの印(`row.changed`)が付くようにする

- [ ] **Step 3: 検索欄**

  - index.html の `#secParams .toolbar` に、`chkDetail` のラベルより前(上)に `<input type="search" id="paramSearch" placeholder="パラメータを検索(名前・説明)">` を置く。同じ toolbar 内で縦に並べる(`.toolbar` を `flex-direction: column; align-items: stretch` にするか検索欄だけ 1 行占有させる)
  - `renderParams` で `T.paramMatchesQuery(p.name, helpText(p.name), query)` に一致しない行を作らない。該当行が 0 のグループ(fieldset)は出さない。全体で 0 件なら `<span class="legend">一致するパラメータがありません</span>`
  - `input` イベントで再描画する(入力中のフォーカスは検索欄にあるので再描画の影響を受けない)

- [ ] **Step 4: プリセット差分の印**

  - `presetTrackpad`(`setPresetTrackpad` で設定、初期 null)と画面値の比較で、差のある行に `presetmark` 要素を付ける。共通表示では行の desc の前に `プリセット: 20` か、左右でプリセット値が違う・片側だけ差がある場合は `プリセット: 右 20 / 左 30`。詳細表示では該当セルに `プリセット: 20`。値は `formatParamValue` で整形
  - 行に `presetdiff` クラスを付けて左端に色帯を出す(CSS: `.param.presetdiff { box-shadow: inset 3px 0 0 var(--accent); }`、`.presetmark { color: var(--accent); font-size: 11px; font-weight: 600; white-space: nowrap; }`)
  - 値を変えたとき(`setPendingCommon` / `setPendingSide`)は、その行の差分の印も更新する(行の再描画でよい)

- [ ] **Step 5: API の追加と旧ボタン処理の削除**(上記 Interfaces どおり)。この時点では index.html の旧ボタンは残っているが、ハンドラが無くなる。Task 5 で行ごと置き換えるので、ここではボタン要素を消さない。`app_main.js` の `Params.setButtonsEnabled(isConn)` 呼び出しと `renderHeader` の `btnWrite` 参照は、Task 5 まで壊れないよう `setButtonsEnabled` を空関数で残すか、`app_main.js` から呼び出しを消す(どちらかを選び、ページがエラーなく読み込めること)

- [ ] **Step 6: 確認**

  - `node --test tools/tp-tuner/` 緑
  - 構文確認: `node -e "require('vm'); new (require('vm').Script)(require('fs').readFileSync('tools/tp-tuner/app_params.js','utf8'))"`

- [ ] **Step 7: コミット** `パラメータの ON/OFF 表示・検索・プリセット差分の印を追加する`

---

### Task 4: キー設定画面(非表示キー・タブ非依存の読み込み・プリセット差分・スナップショット API)

**Files:**
- Modify: `tools/tp-tuner/app_keymap.js`
- Modify: `tools/tp-tuner/index.html`(差分の印の CSS、レイヤー数差の表示枠)

**Interfaces:**
- Consumes: `TpKeymapUi.HIDDEN_KEY_POSITIONS` / `isKeyHidden`、`TpPresets.keymapSnapshot` / `keymapDiff` / `resolveEntry` / `layerCountAdjust` / `planKeymapBindings`
- Produces(`TpAppKeymap`、既存 API に追加):
  - `isReady()` → Studio クライアントがあり keymap を読めていれば true
  - `ensureLoaded()` → `Promise<boolean>`。読めていれば即 true。Studio が使えない(ネイティブ橋渡し無し・未接続・USB 左・Studio 未確認)なら false。読み込み中なら完了を待つ
  - `isDirty()` → `studioDirty`
  - `snapshot()` → 読めていれば `TpPresets.keymapSnapshot(keymapData, behaviors, TpKeymapUi.HIDDEN_KEY_POSITIONS)`、なければ null
  - `setPresetKeymap(presetKeymapOrNull)` → 差分の比較対象を設定して再描画
  - `presetDiff()` → `TpPresets.keymapDiff(presetKeymap, snapshot())`(どちらか null なら `{ layerCount: null, keys: [] }`)
  - `applyPresetKeymap(presetKeymap)` → `Promise<{ applied: number, skipped: number, layerError: string | null }>`。`layerCountAdjust` に従い `addLayer` を add 回(`availableLayers` を超えたら止めて `layerError` に理由)、`removeLayer(末尾の番号)` を remove 回。その後 `planKeymapBindings` の ops を順に `setLayerBinding` し、成功した分を `keymapData` に反映する。最後に `studioDirty` を Studio の `checkUnsavedChanges` で更新し、再描画と `root.TpAppMain.renderHeader()`
  - `save()` → `saveChanges`。`Promise<void>`(失敗は throw)
  - `reload()` → 確認なし。dirty なら `discardChanges` してから読み直す。`Promise<boolean>`(読めたら true)
  - `resetToDefault()` → 確認なしで `resetSettings` → 読み直し。`Promise<void>`(失敗は throw)
  - `exportKeymap()`(既存 `exportKeymapNow`)
  - 旧 `btnStudioSave` / `btnStudioReload` / `btnStudioReset` / `btnKeymapExport` のハンドラと `renderStudioHeader` のボタン操作は削除する(状態が変わったら `root.TpAppMain.renderHeader()` を呼ぶ)

- [ ] **Step 1: 非表示キー**

  `renderKeymapSvg` で `TpKeymapUi.isKeyHidden(idx)` の位置を描かない。`layoutBounds` は表示するキーだけで計算する。`selectedKeyPos` が非表示位置になることはない

- [ ] **Step 2: タブに関係ない読み込み**

  - `updateStudioAvailability` の `activeTab !== 'keymap'` での早期 return をやめる。お知らせ(`setStudioNotice`)の表示はキー設定タブ用の要素なのでそのまま出してよい
  - 接続して Studio が使えるようになったら(`handleStudioReady(true)` / USB 右で Studio ポート確認後)、タブに関係なくクライアントを作って `loadKeymapData` する
  - `loadKeymapData` はトラックパッドのライブ表示を止めて読み、終わったら(成功・失敗とも)キー設定タブでなければ `Pad.setTrackpadQuiet(false)` で戻す
  - 読み込み完了時に `root.TpAppMain.renderHeader()` と、プリセット側への通知として `root.TpAppPresets && root.TpAppPresets.onKeymapLoaded && root.TpAppPresets.onKeymapLoaded()` を呼ぶ(Task 5 で実装される。無くても動くこと)

- [ ] **Step 3: プリセット差分の印**

  - 差のあるキーキャップの rect に `presetdiff` クラス(CSS: `.keycap.presetdiff { stroke: var(--warn); stroke-width: 2.5; stroke-dasharray: 5 3; }`、選択中の `.selected` と併用可)
  - 差のあるキーを含むレイヤーボタンに印(`layer-btn` に `presetdiff` クラス、CSS で右上に小さな点。例 `.layer-btn.presetdiff::after { content: '●'; color: var(--warn); font-size: 9px; margin-left: 4px; }`)
  - レイヤー数が違うとき、`#layerList` の下に `プリセットはレイヤー N 個(今は M 個)` を出す(`<div id="presetLayerNote" class="legend">`)
  - キー編集パネルで、選択中のキーに差があれば先頭に `プリセット: <ラベル>` を出す。ラベルは `TpPresets.resolveEntry(entry, behaviors, keymapData.layers)` できれば `TpKeymapUi.bindingLabel(...)`、できなければ `entry.behavior`(null なら `不明な behavior`)
  - `commitBinding` 成功後・レイヤー追加削除後・読み込み後に印を更新し、`root.TpAppMain.renderHeader()` を呼ぶ

- [ ] **Step 4: API の追加と旧ボタン処理の削除**(上記 Interfaces どおり。index.html のボタン要素は Task 5 で置き換えるまで残してよいが、ページがエラーなく読み込めること)

- [ ] **Step 5: 確認**

  - `node --test tools/tp-tuner/` 緑
  - 構文確認(Task 3 と同じ方法で `app_keymap.js`)

- [ ] **Step 6: コミット** `キー設定の十字キーとトラックパッド割り当てを隠し、プリセット差分の印と反映 API を追加する`

---

### Task 5: 共通操作行とプリセット行

**Files:**
- Create: `tools/tp-tuner/app_presets.js`
- Modify: `tools/tp-tuner/index.html`(操作行・プリセット行・名前入力 dialog・CSS、`<script src="app_presets.js">` を `app_keymap.js` の次、`app_main.js` の前に追加)
- Modify: `tools/tp-tuner/app_main.js`
- Modify: `tools/tp-tuner/README.md`(使い方にプリセット・共通操作行・検索・非表示キーを追記。注意書きは書かない)

**Interfaces:**
- Consumes: Task 2〜4 の API
- Produces(`TpAppPresets`):
  - `init()` → 起動時に `Link.loadPresetsText()` → `TpPresets.parseStore`。失敗時はステータスにエラーを出し、空 store で動く(保存はしない)。読めたら選択を復元してプルダウンを描画し、比較対象を `Params.setPresetTrackpad` / `Keymap.setPresetKeymap` に設定する
  - `diffCount()` → `TpPresets.diffCount(Params.presetDiff(), Keymap.presetDiff())`(未選択なら 0)
  - `render()` → プルダウン・ボタンの有効無効・差分件数の表示を更新
  - `onKeymapLoaded()` → 差分表示を更新(`render()`)

- [ ] **Step 1: index.html の上段を置き換える**

  `#topbarRow1` の `trackpadActions` / `keymapActions` を 1 つの `<div id="actions">` にする:

  ```html
  <div id="actions">
    <button id="btnWrite" class="primary" disabled>書き込み</button>
    <span id="dirtyIndicator" hidden></span>
    <button id="btnReload" disabled>再読み込み</button>
    <button id="btnResetAll" disabled>デフォルトに戻す</button>
    <button id="btnExport">.conf をエクスポート</button>
    <button id="btnKeymapExport">.keymap をエクスポート</button>
  </div>
  ```

  `#topbar` に 2 行目としてプリセット行を追加する(既存のタブ行 `topbarRow2` の前):

  ```html
  <div id="presetRow">
    <label for="selPreset">プリセット</label>
    <select id="selPreset"></select>
    <button id="btnPresetNew">新規作成</button>
    <button id="btnPresetSave" disabled>保存</button>
    <button id="btnPresetDelete" disabled>削除</button>
    <span id="presetDiffIndicator" hidden></span>
  </div>
  ```

  名前入力用のページ内モーダル:

  ```html
  <dialog id="presetNameDialog">
    <form method="dialog">
      <h2>プリセットを新規作成</h2>
      <p class="legend">今の画面の状態(タッチパッド + キー設定)を保存します</p>
      <input type="text" id="presetNameInput" maxlength="40" placeholder="名前">
      <p id="presetNameError" class="error" hidden></p>
      <div class="dialogbuttons">
        <button value="cancel" formnovalidate>キャンセル</button>
        <button value="ok" id="presetNameOk" class="primary">作成</button>
      </div>
    </form>
  </dialog>
  ```

  CSS: `#actions` と `#presetRow` は既存 `#trackpadActions` と同じ横並び。`#presetDiffIndicator` はアクセント色の太字。dialog は `--surface` 背景・角丸・影、`::backdrop` は半透明。旧 `#trackpadActions` / `#keymapActions` / `#studioDirtyIndicator` の CSS は削除

- [ ] **Step 2: app_main.js に共通操作行を実装する**

  - `renderHeader()`:
    - `dirtyIndicator` に `未書き込み: パッド N 件 / キー設定あり` のように、あるものだけを `/` でつなげて出す(どちらも無ければ hidden)
    - `btnWrite` は接続中かつ(パッド pending > 0 または `Keymap.isDirty()`)で有効
    - `btnReload` / `btnResetAll` は接続中で有効
    - 最後に `root.TpAppPresets.render()` を呼ぶ
  - `setActiveTab` から `trackpadActions` / `keymapActions` の切り替えを消す
  - 書き込み: パッドは `Params.write()`、キー設定は `Keymap.isDirty()` なら `Keymap.save()`。結果をまとめてステータスに出す(例 `パッド 3 件とキー設定を書き込みました`、失敗があれば件数と「失敗した行は保留のままです」、キー設定の保存失敗は理由付き)
  - 再読み込み: `Params.pendingCount() > 0 || Keymap.isDirty()` なら `window.confirm('書き込んでいない変更を捨てて、キーボードに保存されている状態に戻します。よろしいですか?')`。`Params.reload()` と、`Keymap.ensureLoaded()` が true なら `Keymap.reload()`。ステータス `再読み込みしました`(キー設定を読めなかったら `(キー設定は Studio が使えないため読み込んでいません)` を付ける)
  - デフォルトに戻す: `window.confirm('タッチパッドのパラメータとキー設定をファームのデフォルトに戻します。キーボードに保存済みの値も削除されます。よろしいですか?')`。`Params.resetToDefault()` と、Studio が使えれば `Keymap.resetToDefault()`
  - `btnExport` → `Params.exportConf()`、`btnKeymapExport` → `Keymap.exportKeymap()`
  - 処理中は二重押しを防ぐ(操作中フラグで上段・プリセット行のボタンを無効化)
  - 既存の `Params.setButtonsEnabled` への依存が残っていれば消す
  - `TpAppPresets.init()` を `Link.init` の前に呼ぶ

- [ ] **Step 3: app_presets.js を実装する**

  状態: `store`(`TpPresets` の store)、`loaded`(読み込み成否)。

  - プルダウン: 先頭に `無し`(value 空)、続けてプリセット名。`store.selectedId` を選択状態にする
  - 選択変更:
    - `無し` → `store = selectPreset(store, null)`、保存、比較対象を null に
    - プリセット → 未書き込みの変更(`Params.pendingCount() > 0 || Keymap.isDirty()`)があれば `window.confirm('書き込んでいない変更を捨てて、プリセット「<名前>」の内容を画面に反映します。よろしいですか?')`。キャンセルならプルダウンを元の選択に戻す
    - 反映: `Params.applyPresetTrackpad(preset.trackpad)`(trackpad が null なら何もしない)、`Keymap.ensureLoaded()` が true かつ `preset.keymap` があれば、dirty なら先に `Keymap.reload()` で捨ててから `Keymap.applyPresetKeymap(preset.keymap)`
    - `store = selectPreset(store, id)`、保存、比較対象を設定、`TpAppMain.renderHeader()`
    - ステータス例: `プリセット「普段使い」を画面に反映しました。「書き込み」でキーボードに書き込みます`。skipped があれば `(割り当てできなかったキー N 件)`、layerError があれば併記、キー設定を反映できなかったら `(キー設定は Studio が使えないため反映していません)`
    - 未接続でも選択はできる(比較対象の設定と保存だけ行い、反映はしない。ステータス `接続すると差分を表示します`)
  - 新規作成: 接続中でパラメータかキー設定のどちらかが読めているときだけ有効。`presetNameDialog` を `showModal()`。作成ボタンで `TpPresets.validateName` → エラーならダイアログ内に表示して閉じない。OK なら `Keymap.ensureLoaded()` を待ってから `createPreset(store, { name, trackpad: Params.screenTrackpad() (空オブジェクトなら null), keymap: Keymap.snapshot() }, { id: 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), now: new Date().toISOString() })`、保存、比較対象を設定。keymap が null ならステータス `プリセット「<名前>」を作成しました(キー設定は含まれていません)`
  - 保存: 選択中のときだけ有効。`window.confirm('プリセット「<名前>」を今の画面の状態で上書きします。よろしいですか?')` → `updatePreset(store, id, { trackpad: screenTrackpad or null, keymap: Keymap.snapshot() }, now)`、保存、比較対象を再設定
  - 削除: 選択中のときだけ有効。`window.confirm('プリセット「<名前>」を削除します。よろしいですか?')` → `deletePreset`、保存、比較対象を null
  - 保存(ファイル書き込み)は `Link.savePresetsText(TpPresets.serializeStore(store))`。失敗したらステータスにエラー(`プリセットを保存できませんでした: <理由>`)。起動時の読み込みに失敗していたら、壊れたファイルを消さないよう書き込みを拒否しステータスでその旨を出す
  - `render()`: プルダウンを描き直す(開いている最中の再描画を避けるため、内容が変わったときだけ options を作り直す)。`btnPresetSave` / `btnPresetDelete` は選択中かつ操作中でないとき有効。`presetDiffIndicator` は選択中かつ接続中なら `プリセットとの差分 N 件`(0 件なら `プリセットと一致`)、それ以外は hidden

- [ ] **Step 4: README.md を更新する**

  使い方の該当箇所に、共通操作行(書き込み / 再読み込み / デフォルトに戻す / エクスポート)、プリセット(選択で画面に反映・新規作成・保存・削除・差分表示・保存先 `~/Library/Application Support/TpTuner/presets.json`)、パラメータ検索、キー設定タブで十字キーとトラックパッド割り当て(位置 42〜67)を表示しないこと、`presets.js` の役割(開発の節)を書く

- [ ] **Step 5: 確認**

  - `node --test tools/tp-tuner/` 緑
  - 構文確認(`app_presets.js` / `app_main.js`)
  - `tools/tp-tuner-mac/build.sh` 成功

- [ ] **Step 6: コミット** `上段の操作をタブ共通にし、プリセット(選択・新規作成・保存・削除)を追加する`
