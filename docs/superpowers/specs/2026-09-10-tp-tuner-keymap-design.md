# tp-tuner キー設定タブ(ZMK Studio RPC クライアント)設計

作成日: 2026-09-10

## 目的

tp-tuner の Mac アプリで、BT 接続のままキーマップ(各レイヤーのキー割り当て、レイヤーの追加・削除)を変更してキーボードに保存できるようにする。画面はタブで「タッチパッド」「キー設定」を切り替える。

## 前提(確認済み)

- ZMK v0.3.0 の ZMK Studio 機能がキーマップの取得・変更・保存を RPC で提供する。この zmk-config は `CONFIG_ZMK_STUDIO=y`、`CONFIG_ZMK_STUDIO_LOCKING=n`(アンロック不要)。Studio を有効にすると `ZMK_KEYMAP_SETTINGS_STORAGE`(キーマップを settings に保存)と `ZMK_BEHAVIOR_METADATA`(behavior のパラメータ定義を返す)が select される(`zmk/app/src/studio/Kconfig`)
- BLE 転送は既定で有効(`ZMK_STUDIO_TRANSPORT_BLE`)。GATT サービス `00000000-0196-6107-c967-c5cfb1c2482a`、RPC キャラクタリスティック `00000001-0196-6107-c967-c5cfb1c2482a`(write + read + **indicate**、ENCRYPT)。要求は write、応答と通知は indicate で届く(`zmk/app/src/studio/gatt_rpc_transport.c`)。USB は右手の 2 つ目の CDC ポート(`studio-rpc-usb-uart` スニペット)
- メッセージは protobuf(`zmk-studio-messages` 6cb4c28: `zmk/studio.proto`、`core.proto`、`keymap.proto`、`behaviors.proto`、`meta.proto`)。フレーミングは `0xAB`(SOF)+ 本体 + `0xAD`(EOF)、本体中の `0xAB/0xAC/0xAD` は `0xAC` を前置してエスケープ(`msg_framing.c`、`rpc.c`)
- キーマップはレイヤー(`id`、`name`、`bindings[]` = `{behavior_id(sint32), param1, param2}`)の配列、物理レイアウト(`keys[]` = `{width, height, x, y, r, rx, ry}`、単位は 1/100 キー)、behavior は `list_all_behaviors` → `get_behavior_details`(`display_name` と `metadata[]`: `param1/param2` の候補 `nil | constant | range | hid_usage | layer_id`)。このキーボードの物理レイアウトは 68 キー
- 変更は `set_layer_binding` / `add_layer` / `remove_layer` / `move_layer` でキーボード側の作業状態に入り、`save_changes` で settings に保存、`discard_changes` で捨てる。未保存の有無は `check_unsaved_changes` と通知 `unsaved_changes_status_changed` で分かる
- macOS では Web Bluetooth が使えないので、既存の Mac アプリ(CoreBluetooth)に Studio サービスの橋渡しを足す

## 構成

### Mac アプリ(`tools/tp-tuner-mac`)
- 既存の BLE 接続(同じペリフェラル)で Studio サービスも探索し、RPC キャラクタリスティックの indicate を購読する。ページとの橋渡しに Studio 用のメッセージを足す: JS → `studioWrite {b64}`(バイト列を write with response で送る。MTU を超える場合は分割)、ネイティブ → `studioData {b64}`(indicate で届いたバイト列)、`studioReady {available: bool}`(サービスの有無)。既存の tp-tuner 用ストリームとは独立
- USB: 右手の Studio 用 CDC ポートを第 2 のシリアルとして開ける(`studioOpen {id}` / `studioClose`)。tp-tuner 用ポートと同時に開ける。ポートの見分けはページ側が「`tp info` に応答しない方」を Studio 用として試す

### ページ(`tools/tp-tuner`)
- `studio.js`(純粋、依存なし): (1) protobuf の最小コーデック(varint、length-delimited、sint32 の zigzag、oneof、repeated、埋め込みメッセージ)と、上記 5 つの .proto のうち使うメッセージのスキーマ定義(フィールド番号と型を手で写す)。(2) フレーミングの encode/decode(ストリームから 1 メッセージずつ取り出す状態機械)。(3) RPC クライアント: `request_id` を採番し応答を対応付ける Promise API(`getDeviceInfo`、`getLockState`、`listBehaviors`、`getBehaviorDetails(id)`、`getKeymap`、`getPhysicalLayouts`、`setLayerBinding(layerId, pos, binding)`、`addLayer`、`removeLayer(index)`、`moveLayer(from, to)`、`saveChanges`、`discardChanges`、`checkUnsavedChanges`)、通知のコールバック。`meta.simple_error` はエラーとして reject
- `keycodes.js`(生成物): ZMK の `dt-bindings/zmk/keys.h` から `dev/gen-keycodes.js` で生成したキー名 → HID usage(page/id)の表と、修飾キー(LC/LS/LA/LG と右側)のビット。表示用のグループ(文字・数字・記号・機能キー・ナビ・メディア・修飾)を持つ
- キー設定タブ: 上部にレイヤーの一覧(順序どおり、選択で切替、「追加」「削除」。名前変更はしない)。中央に物理レイアウトを SVG で描き、各キーに現在の割り当て(behavior の表示名 + パラメータの名前)を短く表示。キーを選ぶと右側の編集パネルに behavior の選択(`list_all_behaviors` の表示名)とパラメータ入力(metadata に従って: `hid_usage` はキーコードの検索付きピッカー + 修飾キーのチェック、`layer_id` はレイヤーの選択、`range` は数値、`constant` は選択肢、`nil` は入力なし。metadata が無い behavior は数値をそのまま編集)。変更は即座に `set_layer_binding` で送り(キーボードの作業状態に反映される。押して確かめられる)、ヘッダの「書き込む」が `save_changes`、「破棄」が `discard_changes`。未保存の状態はヘッダに出す
- タブ: ヘッダ直下に「タッチパッド」「キー設定」。タッチパッド側の既存 UI は変えない。ヘッダの操作ボタン群はタブごとに切り替える(タッチパッド: 書き込む/再読み込み/デフォルトに戻す/.conf をエクスポート、キー設定: 書き込む/破棄/再読み込み)
- 接続: BLE 接続時、Studio サービスがあればキー設定タブが有効になる。無ければタブに「このファームは Studio 非対応」と出す。USB 接続時は右手にのみ Studio ポートがある
- `dev/fake-native.js` に Studio の模擬(物理レイアウト 6 キー、レイヤー 2 つ、behavior 3 種の応答をフレーミング込みで返す)を足し、headless で確認できるようにする

### ファーム
- 変更なし(Studio は既に有効)。`CONFIG_ZMK_STUDIO_TRANSPORT_BLE_PREF_LATENCY` は既定のまま

## 制限・注意
- キーマップの変更はキーボードの flash に保存され、`config/lalapadgen2.keymap` は初期値になる。`settings_reset` を書き込むと消える。`.keymap` への書き出しは後で足す
- カスタム behavior(`zip_dyn_scale`、hold-tap の `mt2`、tap-dance など)は metadata の有無に応じて表示・編集の粒度が変わる。metadata の無いものは数値編集のみ
- Studio の応答は indicate なので、Mac 側の受信は順序保証される。応答が大きいとき(`get_keymap` は数 KB)は複数の indicate に分かれるので、ページ側でフレーミングの状態機械で再組み立てする
- 排他: 公式の ZMK Studio と同時には使わない(同じ RPC を取り合う)

## 検討した代替案

| 案 | 却下理由 |
| --- | --- |
| 公式 ZMK Studio の Web アプリを WKWebView で開く | Web Bluetooth / Web Serial に依存し、WKWebView では動かない |
| 独自のキーマップ転送プロトコルをファームに追加 | Studio が同じ機能を提供済み。二重実装になる |
| protobuf のライブラリ(protobufjs 等)を同梱 | 外部依存なしの方針に反し、必要なメッセージは少数なので手書きで足りる |

## 実機で確定した挙動と対処(2026-09-10)

- ZMK v0.3.0 の GATT 転送は、応答の終端 EOF(1 バイト)を送り残すことがある(本体は全部届く。取り残した分は次のメッセージ送信時にまとめて流れる)。ページ側は `zmk.studio.Response` が oneof の length-delimited 1 フィールドであることを使い、先頭のタグと長さから全長が揃った時点でフレーム完成とみなす(`studio.js` の `createFrameDecoder`)。遅れて届いた EOF は IDLE で無視される
- Studio の転送先は HID の出力先(`zmk_endpoints_selected().transport`)に追従する。右手に USB をつなぐと出力先が USB になり、BLE の Studio 要求は無視される(タイムアウトになる)。USB をつないだまま BLE で使うには system layer の `&out OUT_TOG` で出力先を BLE に戻す
- 応答は LE データ長 27 バイト刻みの indicate で届く(物理レイアウト約 0.9KB で 40 本、キーマップ約 1.6KB で 60 本)。ホスト接続時に `bt_conn_le_data_len_update` を要求する案は、右手の再起動と時期が重なったため取り下げた(原因未特定)
- キー設定タブを開いている間は、ページが両手へ `live off` と `summary off` を送って tp-tuner の送信を止め、タッチパッドタブに戻すと再開する(BLE リンクの取り合いを避ける)
- behavior を切り替えるときは新しい behavior の定義(最初のセット)に合う初期値を送る(hidUsage は `A`、layerId は 0、constant は先頭の候補、range は下限)。`param1/param2 = 0` のまま送ると `SET_LAYER_BINDING_RESP_INVALID_PARAMETERS`(3)になる
- proto3 は既定値のフィールドを省略するため、oneof を持たないメッセージは復号時に既定値(0 / false / 空)を補う(`activeLayoutIndex`、キーの `x`/`y`、レイヤー `id` など)
