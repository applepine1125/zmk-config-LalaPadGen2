# tp-tuner BT 対応・ネイティブアプリ化 設計

作成日: 2026-09-09

## 目的

tp-tuner を「キーボードが BT でつながっているときに開けば左右どちらの設定も変えられ、即座に反映され、そのまま使い続けられる」設定アプリにする。現状は USB CDC のシェル前提で、調整したい側に USB を挿す必要があり、値は再起動で消える。

## 前提(確認済み)

- macOS では HID 接続中の BLE デバイスにブラウザ(Web Bluetooth)から GATT アクセスできない。ZMK Studio も BLE 接続中の変更は「Linux の Web アプリとネイティブアプリのみ」(zmk docs/features/studio.md)。ネイティブアプリが必要
- 左手(peripheral)は右手(central)にしかつながっていない。左手の設定は右手経由で転送する
- 左手 → 右手の split BLE リンクは負荷に弱い(トラックパッドの通知でキー入力が詰まった実績)。フレーム単位のトレースを流してはいけない。パラメータ変更(数バイト)と試行ごとの要約(数十バイト)なら問題ない

## 段階

### 第 1 段: 値の永続化(NVS)
- ドライバに Zephyr settings ハンドラ `iqs9151` を追加。キー `iqs9151/params` に構造体を 1 ブロブで保存(先頭にバージョンとパラメータ数、続いて各値を int32 の配列。読み込み時に数が合わなければ無視して Kconfig 既定を使う)
- 保存は明示操作 `tp save`(自動保存はしない: 調整中に何十回も書くと flash を消耗する)。`tp reset` は Kconfig 既定に戻し、保存ブロブも削除する
- 起動時: `settings_load()` 後にハンドラの `set` が呼ばれ、`iqs9151_dev_param_set` で各値を適用する(IC 系は保留ビットに積まれ次フレームで書かれる)。ZMK の settings 読み込みタイミングはドライバ init(POST_KERNEL)より後なので、デバイスは存在する
- Kconfig `INPUT_IQS9151_SETTINGS`(depends on SETTINGS、default y if SETTINGS)
- tp-tuner: 「この値をファームに保存」ボタンと「未保存の変更あり」表示。`tp info` の応答に `saved=<yes|no>`(保存済みブロブの有無)を追加

### 第 2 段: 試行要約イベント
- ドライバが試行(指の接触が始まってから、離して 400ms 何も触れないまで)ごとに要約を 1 件作る。内容: 開始/終了時刻、接触回数、最大指本数、1 回目の押下時間、2 回目までの間隔、移動量合計(1 本指 rel の |x|+|y| 和)、2 本指の重心移動と距離変化、2F モード(なし/スクロール/ピンチ)、送ったボタン(押し/離しビット)、wheel 件数と合計、REL 送信件数、`input_report` 失敗件数、ホールド(deferred-click)が起きたか
- 出力: USB では `T S <start_ms> <end_ms> <contacts> <fingers_max> <down_ms> <gap_ms> <move_sum> <centroid_move> <dist_delta> <mode2f> <btn_press_bits> <btn_release_bits> <wheel_count> <wheel_sum> <rel_count> <drops> <hold>` の 1 行(トレース ON/OFF に関係なく、要約は常時出す設定 `tp summary on|off`、既定 on)。第 3 段では同じ内容を GATT 通知で送る
- tp-tuner: `T S` を受け取ったらその試行の観測としてページ側の `observeAttempt` の代わりに使う(フレーム単位のトレースが無くても認識文が出る)。両方あるときは要約を優先

### 第 3 段: GATT サービスと左手への転送
- 右手(central)に独自 GATT サービスを追加(zmk-config のモジュールとして実装、ドライバ API を呼ぶ)。キャラクタリスティック: `command`(write: `<side> <tp コマンド文字列>`)、`response`(notify: 応答行)、`summary`(notify: 試行要約)
- 左手向けのコマンドは、ZMK の split 経由で peripheral 上で実行される behavior(locality global)として転送する: `&tp_param <param_index> <value>`。応答は「送った」までで、値の読み戻しは左手からの要約通知に現在値を添えることで代替する(要検討)
- 左手の要約は split の入力イベント経路(`zmk,input-split`)に予約コードで相乗りさせるか、ZMK の split 拡張(sensor イベント)を使うか、実装時に選ぶ。1 試行 1 件なので負荷は無視できる

### 第 4 段: Mac ネイティブアプリ
- 今の HTML/JS をそのまま画面として抱える(Swift + WKWebView、または Tauri)。アプリ側に CoreBluetooth(`retrieveConnectedPeripherals` で HID 接続中のキーボードを取得し独自サービスに接続)と USB シリアルの両方を持ち、ページとはローカル WebSocket または `postMessage` でやり取りする。ページ側は「接続方式: USB / BT」を選ぶだけ
- 起動したら自動で BT の LalaPad を探して接続し、左右を選べる

## 検討した代替案

| 案 | 却下理由 |
| --- | --- |
| Web Bluetooth で直接接続 | macOS では HID 接続中のデバイスに GATT アクセスできない |
| ZMK Studio RPC を拡張 | Studio の protobuf/RPC 実装とクライアントを両方拡張する必要があり規模が大きい。ネイティブアプリも Studio 側のもの |
| 左手のフレームトレースを split 経由で流す | split BLE リンクの負荷でキー入力が詰まる |
| 変更のたびに自動保存 | flash 消耗。調整は「試して戻す」の繰り返しなので明示保存が適切 |
