# トラックパッド調整ツール(tp-tuner)設計

作成日: 2026-09-07

## 目的

LalaPad Gen2 のトラックパッド(Azoteq IQS9151)で起きている「ダブルタップでのドラッグが効かない・効きっぱなしになる」「2 本指スクロールがたまに反応しない」といった症状を、**ビルドとフラッシュを挟まずに**「観察 → パラメータ変更 → 再観察」できるようにする。

現状は全パラメータが Kconfig のコンパイル時定数で、1 サイクルに GitHub Actions のビルド待ちと両手のフラッシュが必要になっている。

## ゴールと非ゴール

ゴール:

- USB ケーブル 1 本で接続し、ドライバのジェスチャ判定値と IC の感度レジスタをその場で変更できる
- ドライバが「何を送ったか」とホストが「何を受け取ったか」を同じ時間軸で見られる
- 確定した値を `CONFIG_…=` 行として書き出し、`.conf` に貼ってビルドに反映できる
- ビルド不要・インストール不要で、HTML を開いて接続ボタンを押すだけで使い始められる

非ゴール:

- 無線(BLE)経由での調整
- 変更値のファーム内永続化(再起動で Kconfig 既定値に戻る)
- 座標系に関わる設定(解像度・回転)のランタイム変更

## 全体構成

変更は 3 か所に分かれる。

| 場所 | 内容 |
| --- | --- |
| ドライバフォーク `applepine1125/zmk-driver-iqs9151` | 新ブランチ `runtime-tuning`。`hold-release-forever`(b771211)と `sensitivity-kconfig`(af9c0c1)を統合した上に、パラメータのランタイム化・`tp` シェルコマンド・トレース出力を実装 |
| このリポジトリ | `config/lalapadgen2.conf` にシェル/USB CDC/ログの設定を追加、`config/west.yml` を新ブランチのコミット SHA に更新、`tools/tp-tuner/` にホストアプリと README を追加 |
| ホスト(macOS) | Chrome の Web Serial でファームのシェルに接続する単一 HTML |

ホストとの接続経路:

```
Chrome(tools/tp-tuner/index.html)
   │ Web Serial
   ▼
USB CDC ACM(board 既定の usb_cdc_acm_uart ノード)
   │ Zephyr shell
   ▼
tp コマンド ──► iqs9151 ドライバのパラメータ構造体 ──► (IC 系は I2C 書き込み)
                 ドライバのトレース ──► LOG(deferred) ──► shell ログバックエンド ──► 同じ CDC
```

シェル・トレース機能は日常ファームに常時組み込む。build.yaml のアーティファクト構成は変えない。

## ドライバ: パラメータのランタイム化

### 現状

ジェスチャ判定値・慣性パラメータは `#define` 経由で `CONFIG_INPUT_IQS9151_…` を直接参照している(`drivers/input/iqs9151.c:39-83`)。有効/無効フラグは `IS_ENABLED(CONFIG_…)` で参照している。慣性パラメータは `static const` 構造体に固定されている(同 497-528 行)。IC の感度レジスタは `sensitivity-kconfig` ブランチで 13 レジスタがアドレス定義・書き込み関数化されている(`iqs9151_apply_sensitivity_overrides`)。

### 変更

- `struct iqs9151_params` を新設し `struct iqs9151_data` に持たせる。`iqs9151_init` で Kconfig 値から初期化する
- マクロ・`IS_ENABLED` の参照箇所をすべて `params->…` 参照に置き換える。慣性パラメータ構造体は `iqs9151_data` 内の可変コピーにする。**この段階では挙動を変えない**
- 定義テーブル `iqs9151_param_defs[]` を新設し、シェル・リセット・IC 書き込みはすべてこのテーブル駆動にする

```c
enum iqs9151_param_kind { IQS9151_PARAM_DRIVER, IQS9151_PARAM_IC_U8, IQS9151_PARAM_IC_U16 };

struct iqs9151_param_def {
    const char *name;        /* 例: "1f_tap_max_ms"(Kconfig 名の接尾辞を小文字化) */
    uint16_t offset;         /* struct iqs9151_params 内のオフセット */
    int32_t min, max;        /* Kconfig の range と同じ */
    int32_t def;             /* Kconfig の値 */
    enum iqs9151_param_kind kind;
    uint16_t reg;            /* IC 系のみ */
};
```

- 公開 API(`drivers/input/iqs9151_params.h`):
  - `int iqs9151_param_set(const struct device *dev, const char *name, int32_t value)` … 範囲チェック → 構造体更新 → IC 系は I2C 書き込み
  - `int iqs9151_param_get(const struct device *dev, const char *name, int32_t *value)`
  - `const struct iqs9151_param_def *iqs9151_param_defs(size_t *count)`
  - `int iqs9151_param_reset(const struct device *dev)` … 全パラメータを既定値に戻し IC レジスタも書き戻す
  - `int iqs9151_param_reati(const struct device *dev)` … Re-ATI 実行(既存 `iqs9151_run_ati` + `iqs9151_wait_for_ati`)
  - `void iqs9151_trace_enable(const struct device *dev, bool enable)`
- IC 系の書き込みと Re-ATI は、シェルのスレッドから直接 I2C を叩かず、**保留キューに積んで次のフレーム処理(`iqs9151_work_cb`)の中で適用する**。理由は 2 つ。(1) IC はイベントモードで動いており、通信は RDY がアサートされた窓の中で行う前提になっている(init では書き込みごとに `iqs9151_wait_for_ready` を挟んでいる。`iqs9151.c:2603-2634`)。フレーム読み出し直後は確実に窓の中にいる。(2) 割り込み処理との I2C 競合を考えなくてよい。副作用として、IC 系の変更は次にパッドに触れたときに反映される。`tp set` の応答は即座に `OK` を返し、README に「IC 系の変更後はパッドに一度触れる」と明記する。DRIVER 系は構造体を書き換えるだけなので即時反映される(32bit 書き込みは atomic で、判定は次フレームから新しい値を使う)

### 対象パラメータ

| グループ | パラメータ(Kconfig 名の接尾辞) | 種別 |
| --- | --- | --- |
| 1F | `1F_TAP_ENABLE`, `1F_TAP_MAX_MS`, `1F_TAP_MOVE`, `1F_PRESSHOLD_ENABLE`, `1F_TAPDRAG_GAP_MAX_MS` | DRIVER |
| 2F | `2F_TAP_ENABLE`, `2F_TAP_MAX_MS`, `2F_TAP_MOVE`, `2F_PRESSHOLD_ENABLE`, `2F_TAPDRAG_GAP_MAX_MS`, `SCROLL_X_ENABLE`, `SCROLL_Y_ENABLE`, `2F_SCROLL_START_MOVE`, `2F_PINCH_ENABLE`, `2F_PINCH_START_DISTANCE`, `2F_PINCH_WHEEL_GAIN_X10` | DRIVER |
| 3F | `3F_TAP_ENABLE`, `3F_TAP_MAX_MS`, `3F_TAP_MOVE`, `3F_PRESSHOLD_ENABLE`, `3F_TAPDRAG_GAP_MAX_MS`, `3F_SWIPE_THRESHOLD` | DRIVER |
| 慣性 | `CURSOR_INERTIA_ENABLE`, `CURSOR_INERTIA_DECAY`, `CURSOR_INERTIA_RECENT_WINDOW_MS`, `CURSOR_INERTIA_STALE_GAP_MS`, `CURSOR_INERTIA_MIN_SAMPLES`, `CURSOR_INERTIA_MIN_AVG_SPEED`, `SCROLL_INERTIA_*`(同 6 種) | DRIVER |
| IC 感度 | `TOUCH_SET_THRESHOLD`, `TOUCH_CLEAR_THRESHOLD`, `ALP_SET_DEBOUNCE`, `ALP_CLEAR_DEBOUNCE`, `STATIONARY_TOUCH_MOV_THRESHOLD`, `JITTER_FILTER_DELTA`, `FINGER_CONFIDENCE_THRESHOLD` | IC_U8 |
| IC 周期 | `ACTIVE_MODE_SAMPLING_PERIOD_MS`, `IDLE_TOUCH_MODE_SAMPLING_PERIOD_MS`, `IDLE_MODE_SAMPLING_PERIOD_MS`, `LP1_MODE_SAMPLING_PERIOD_MS`, `LP2_MODE_SAMPLING_PERIOD_MS`, `ACTIVE_MODE_TIMEOUT_MS` | IC_U16 |
| IC フィルタ | `ATI_TARGETCOUNT`, `DYNAMIC_FILTER_BOTTOM_SPEED`, `DYNAMIC_FILTER_TOP_SPEED` | IC_U16 |
| IC フィルタ | `DYNAMIC_FILTER_BOTTOM_BETA` | IC_U8 |

bool 系は 0/1 の int として同じ枠組みで扱う。`RESOLUTION_X/Y`・`ROTATE_*` は対象外。

Re-ATI は `tp set` で自動実行しない。スライダ操作で連続して値が変わる間に ATI が連発するのを避けるため、ホストの「Re-ATI」ボタン(= `tp reati`)で明示的に実行する。

### 既存テストとの関係

`tests/iqs9151_work_cb/CMakeLists.txt` は `CONFIG_…` を `target_compile_definitions` で与えている。パラメータ初期値がそれらから来るので、既存テストは変更なしで通る見込み。テスト本体 `main.c` がマクロを直接参照していないことは実装時に確認する。

## ドライバ: `tp` シェルコマンド

新ファイル `drivers/input/iqs9151_shell.c`。Kconfig `INPUT_IQS9151_SHELL`(`depends on SHELL`, default n)で有効化する。デバイスは `DEVICE_DT_GET_ANY(azoteq_iqs9151)` で取得する(各半分に 1 個)。

応答は機械可読の固定書式。エラーは `ERR <reason>` の 1 行。

```
tp info                  -> side=central|peripheral uptime_ms=<n> params=<count>
tp list                  -> 1 行 1 パラメータ: <name> <value> <min> <max> <kind> <default>
tp get <name>            -> <name>=<value>
tp set <name> <value>    -> OK <name>=<value>
tp reset                 -> OK reset(IC 系の書き戻しは次のフレーム処理で実行)
tp reati                 -> OK reati(次のフレーム処理で実行)
tp trace on|off          -> OK trace=on|off
```

`side` は `CONFIG_ZMK_SPLIT_ROLE_CENTRAL` で判定する。

## ドライバ: トレース出力

- 出力経路は Zephyr LOG(deferred モード)+ シェルのログバックエンド。呼び出し側は引数をログバッファに積むだけなので入力処理をブロックしない。バッファがあふれた分は LOG が drop 件数を報告する
- ランタイムの bool(既定 off)で有効化する。ログレベルフィルタには依存しない
- 行形式は 2 種類。先頭の `T` で識別する

```
T F <ms> <fingers> <rel_x> <rel_y> <f1x> <f1y> <f2x> <f2y> <tp_flags_hex> <hold_btn> <2f_mode> <pending_bits>
T E <ms> K|R <code> <value> <ret>
```

- `T F` はフレーム処理(`iqs9151_process_frame`)ごとに 1 行。`pending_bits` は 1F/2F/3F の deferred-click 待ち状態のビット
- `T E` は `iqs9151_report_key_event` / `iqs9151_report_rel_event`(`iqs9151.c:244,263`)で 1 行。**`ret` は `input_report` の戻り値**で、input キュー満杯で捨てられたイベントが `ret≠0` として見える
- 帯域: アクティブ時 100 フレーム/s × 50 バイト程度で USB CDC には余裕がある
- ZMK 本体のログが混ざらないよう `CONFIG_LOG_DEFAULT_LEVEL=1`(ERR)にし、ドライバのモジュールだけ INF にする

## このリポジトリ側の変更

### `config/lalapadgen2.conf`

```
# トラックパッド調整用シェル(tools/tp-tuner)
CONFIG_USB_DEVICE_STACK=y
CONFIG_USB_CDC_ACM=y
CONFIG_SERIAL=y
CONFIG_UART_INTERRUPT_DRIVEN=y
CONFIG_UART_LINE_CTRL=y
CONFIG_SHELL=y
CONFIG_SHELL_BACKEND_SERIAL=y
CONFIG_LOG=y
CONFIG_LOG_MODE_DEFERRED=y
CONFIG_SHELL_LOG_BACKEND=y
CONFIG_LOG_DEFAULT_LEVEL=1
CONFIG_INPUT_IQS9151_LOG_LEVEL=3
CONFIG_INPUT_IQS9151_SHELL=y
```

- devicetree: XIAO BLE の board dts に `usb_cdc_acm_uart` ノードと `zephyr,shell-uart` の chosen が既にある(zmk v0.3.0 `seeeduino_xiao_ble.dts:15,180`)ため、overlay の追加は不要。右手は Studio 用スニペットの CDC と合わせて 2 ポート構成になる。**要検証**: この複合構成でのビルド通過と、macOS で 2 つの `/dev/cu.usbmodem*` が見えること
- 左手(peripheral)は `ZMK_USB` が central 限定(zmk `app/Kconfig` の `depends on`)だが、`USB_DEVICE_STACK` を直接有効化すれば `src/usb.c` がコンパイルされ `usb_enable` が呼ばれる(`app/CMakeLists.txt:101`)。`ZMK_USB_LOGGING` が peripheral で動くのと同じ仕組み
- 既存の `#Debug only` コメント内の `CONFIG_ZMK_USB_LOGGING` は `zephyr,console` を同じ CDC に向けるため、本機能と併用できない旨を注記する

### `config/west.yml`

`zmk-driver-iqs9151` の `revision` を `runtime-tuning` ブランチのコミット SHA に更新する。

## ホストアプリ `tools/tp-tuner/`

### 構成

- `index.html`: 単一ファイル。外部依存なし(vanilla JS)。`file://` で開く
- `tuner.js`: 純粋関数(トレース行パーサ、診断判定、`.conf` 生成、`tp list` パーサ)。`index.html` から通常の `<script src>` で読み込む(`file://` では ES モジュールが CORS で読めないため `type="module"` は使わない)。`globalThis.TpTuner` に関数を公開し、末尾で `module.exports` があれば同じものを代入して Node のテストからも読めるようにする
- `tuner.test.js`: `node --test` で動くテスト
- `README.md`: 立ち上げ手順(3 ステップ)と注意点

### 立ち上げ手順(README に記載)

1. 調整したい側の半分に USB を挿す
2. Chrome で `tools/tp-tuner/index.html` を開き「接続」を押す。ポート一覧から ZMK のポートを選ぶ(2 つ見える場合は、接続後にアプリが `tp info` で応答を確認し、応答がなければもう一方を選ぶよう案内する)
3. テストパッド領域でジェスチャを行い、タイムラインと診断を見ながらパラメータを変える

注意: USB を挿すと ZMK はマウス出力も USB HID に切り替える。BLE 固有の症状(HOG 送信キューの詰まり)を再現するときは、キーマップの `&out OUT_BLE` で出力を BLE に戻す。

### 画面

1. **接続バー**: 接続/切断、`tp info` の結果(左右・uptime)、trace 切替、「BLE の症状を見るには `&out OUT_BLE`」の注意
2. **パラメータパネル**: `tp list` の結果からグループ別にスライダ+数値入力を生成する。表示名・説明・グループ分けは `index.html` 内の辞書に持ち、辞書にない名前は「その他」に出す。変更即 `tp set`、既定値との差分をハイライト、IC 系グループに「Re-ATI」ボタン、全体に「既定値に戻す」(= `tp reset`)
3. **テストパッド**: `pointerdown/up/move`・`wheel` を捕捉し、ホストが受けたボタン状態・移動量・ホイール量を表示する。右クリックメニューとページスクロールは抑止する
4. **タイムライン**(canvas): 上段ファーム(指本数レーン、ドライバのボタン報告、REL/WHEEL)、下段ホスト(ボタン状態、move、wheel)。時刻は `tp info` の `uptime_ms` とホスト `performance.now()` の差で整列する(往復時間の半分を補正)。一時停止・クリア・ズーム
5. **診断**: 検出した問題をタイムライン上に赤で表示し、一覧にも出す
   - ドライバが離し(`K <code> 0`)を送った、または `ret≠0` で失敗した後、ホストの `buttons` が一定時間(既定 300 ms)押されたまま
   - `T E` の `ret≠0`(ドロップ)
   - 指 2 本で `rel` が動いているのにホストへ `wheel` が一定時間(既定 200 ms)届かない
6. **エクスポート**: 既定値からの差分(または全部)を `CONFIG_INPUT_IQS9151_<NAME>=<value>` 行で生成しクリップボードへコピー。プロファイルの JSON 保存/読込(localStorage)

### シリアル処理

- 受信は行単位で分割し、`T ` 始まりはトレース、それ以外はコマンド応答として扱う。コマンドは 1 つずつ送り、応答の終端(シェルのプロンプト)で完了とみなす
- 接続直後に `tp trace off` → `tp info` → `tp list` の順で初期化する

## テスト

- ドライバ: 既存 ztest(`tests/iqs9151_work_cb`)が通ること。`iqs9151_param_set` の範囲チェック・未知の名前・IC 系の書き込み経路(テストフックで I2C をモック)のテストを追加する
- ホスト: `tuner.js` の各関数を `node --test` で検証する(トレース行のパース、`tp list` のパース、診断判定の正例/負例、`.conf` 生成)
- 実機(ユーザー): CI ビルド → 右手フラッシュ → Chrome 接続 → `tp list` 取得 → 値変更が反映される → ダブルタップドラッグと 2 本指スクロールをタイムラインで確認

## 実装順

1. ドライバ: `runtime-tuning` ブランチ作成(2 ブランチの統合)、パラメータ構造体化(挙動不変)、ztest 通過
2. ドライバ: `tp` シェル + トレース
3. このリポジトリ: `.conf` + `west.yml`、CI で両手のビルド確認
4. ホスト: `tools/tp-tuner/`
5. 実機検証(ユーザー)。結果に応じて診断条件の閾値を調整する

## 検討した代替案

| 案 | 却下理由 |
| --- | --- |
| ZMK Studio RPC にカスタムサブシステムを追加し Web Bluetooth で無線調整 | protobuf 定義・nanopb 生成・Studio の RPC フレーミングをブラウザ側で再実装する必要があり規模が 2〜3 倍。macOS の Web Bluetooth は不安定 |
| HID feature report(ベンダ usage)で設定を送り WebHID で操作 | ZMK の HID ディスクリプタ改変が必要で侵襲が大きい。トレース出力の帯域も足りない |
| ホスト側の可視化のみ(設定は `.conf` 編集 + CI ビルド) | 症状の観察はできるが、1 サイクルにビルドとフラッシュが残り目的を満たさない |
| 調整用ビルドを build.yaml で分ける | 日常ファームを無変更にできるが、調整のたびにフラッシュが 2 回必要になる。RAM/Flash の増分は数十 KB で nRF52840 には余裕がある |
| 変更値を NVS に永続化 | ビルドなしで値が残る一方、「今どの値で動いているか」が `.conf` と乖離しやすい。`.conf` 書き出しで代替する |
| Python CLI/TUI・ネイティブ macOS アプリ | ホスト受信イベントの取得にアクセシビリティ権限や HID 実装が要り、立ち上げが重い。ブラウザなら pointer/wheel イベントで足りる |
