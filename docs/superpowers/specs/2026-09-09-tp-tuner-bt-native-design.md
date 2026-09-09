# tp-tuner BT 対応・ネイティブアプリ化 設計

作成日: 2026-09-09

## 目的

tp-tuner を「キーボードが BT でつながっているときに開けば左右どちらの設定も変えられ、即座に反映され、そのまま使い続けられる」設定アプリにする。現状は USB CDC のシェル前提で、調整したい側に USB を挿す必要があり、値は再起動で消える。

## 前提(確認済み)

- macOS では HID 接続中の BLE デバイスにブラウザ(Web Bluetooth)から GATT アクセスできない。ZMK Studio も BLE 接続中の変更は「Linux の Web アプリとネイティブアプリのみ」(zmk docs/features/studio.md)。ネイティブアプリが必要
- 左手(peripheral)は右手(central)にしかつながっていない。左手の設定は右手経由で転送する
- 左手 → 右手の split BLE リンクは負荷に弱い(トラックパッドの通知でキー入力が詰まった実績)。フレーム単位のトレースを流してはいけない。パラメータ変更(数バイト)と試行ごとの要約(数十バイト)なら問題ない
- ZMK v0.3.0 の split 転送(`app/include/zmk/split/transport/types.h`)で使えるのは、central → peripheral が behavior 呼び出し(`zmk_split_central_invoke_behavior`: behavior 名 + `param1`/`param2` 各 32bit)、peripheral → central が入力イベント(`zmk_split_peripheral_report_event`: `reg`/`type`/`code`(16bit)/`value`(32bit)/`sync`。central 側は `zmk,input-split` ノードの `reg` で振り分け)。どちらも ZMK 本体を改変せずモジュールから呼べる
- peripheral 側で split 経由の behavior は BT RX スレッド上で同期的に実行される(`app/src/split/bluetooth/service.c` `split_svc_run_behavior`)。時間のかかる処理や複数の通知送信は work に逃がす

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

#### ドライバ側の共通化(zmk-driver-iqs9151)
- `tp` シェルの処理本体を `iqs9151_cmd_exec_argv(dev, argc, argv, out, ctx)` / `iqs9151_cmd_exec(dev, line, out, ctx)`(`out(ctx, "1 行")` に出力)として `drivers/input/iqs9151_cmd.c` に切り出す。シェルは同じ関数を `shell_print` で包んで呼ぶ。GATT からも同じ関数を呼ぶので、USB と BT で応答文字列が一致する
- 要約のコーデック `iqs9151_summary_pack/unpack`(10 個の uint32 語)と `iqs9151_summary_format`(`T S …` の 17 値の 1 行)を `drivers/input/iqs9151_summary_codec.c` に置く。ドライバ内の LOG 出力もこの format を使う
- 語の割り当て: 0 `start_ms`、1 `end_ms`、2 `contacts | fingers_max<<8 | mode2f<<16 | hold<<24`、3 `min(down_ms,65535) | min(gap_ms,65535)<<16`、4 `move_sum`、5 `centroid_move`、6 `dist_delta`(int32 をそのまま)、7 `btn_press_bits | btn_release_bits<<8 | wheel_count<<16`、8 `wheel_sum`(int32)、9 `rel_count | drops<<16`
- ドライバの CMake で `drivers/input` を include パスに公開し、zmk-config のモジュールから `iqs9151_params.h` / `iqs9151_cmd.h` を取り込めるようにする

#### 右手(central)の GATT サービス(zmk-config `src/tp_tuner_central.c`)
- 128bit UUID。サービス `2c28159e-1502-4858-8409-d7206655fd84`、`command`(write / write without response、`BT_GATT_PERM_WRITE_ENCRYPT`)`2c28159e-1502-4858-8409-d7206655fd85`、`stream`(notify、CCC は `READ_ENCRYPT | WRITE_ENCRYPT`)`2c28159e-1502-4858-8409-d7206655fd86`。ボンド済みホスト以外からは操作できない
- `command` の値は UTF-8 テキスト `<side> <tp の引数…>`(最大 64 バイト)。`side` は `R`(右手、ローカル)または `L`(左手、split 転送)。例: `R set 1f_tap_max_ms 200`、`L list`、`L info`。書き込みコールバックはコマンドをキュー(深さ 4)に積むだけで、実行は work で行う
- `stream` は改行区切りのテキストストリーム。各行は `R ` / `L ` で始まる。1 コマンドの応答は `iqs9151_cmd_exec` の出力行(側の接頭辞つき)に続けて終端行 `<side> .` で終わる。試行要約は `<side> T S …` の行として応答と同じストリームに流す(行単位で原子的に追記するので混ざらない)。応答と要約を 1 本にしたのは、順序保証とチャンク再組み立てを 1 か所にするため
- ストリームは 4096 バイトのリングバッファに行単位で追記し、work が `bt_gatt_get_mtu(conn) - 3` バイトずつ購読中の接続へ通知する(`bt_conn_foreach` で `bt_gatt_is_subscribed` な接続を探す)。`bt_gatt_notify` が `-ENOMEM` などで失敗したら 5ms 後に同じ位置から再送する。購読者がいないときは追記しない。満杯なら行を捨てて LOG_WRN
- 右手自身の要約: ドライバの `iqs9151_dev_set_summary_callback` に登録し、購読中なら `R T S …` を追記する

#### 左手への転送
- central → peripheral: behavior `tp_param`(compatible `lalapad,behavior-tp-param`、`#binding-cells = <2>`、devicetree ノード名 `tp_param`)を `zmk_split_central_invoke_behavior(0, &binding, event, true)` で左手に送る。`param1` が 0x8000 未満ならパラメータ index(値は `param2` を int32 として解釈)、0x8000 以上はオペコード: `0x8000 reset`、`0x8001 reati`、`0x8002 save`、`0x8003 summary on|off`(`param2` 0/1)、`0x8004 dump`(全パラメータと状態を返す)、`0x8005 info`(状態のみ)。behavior は peripheral では要求をキューに積んで work を起こすだけ(BT RX スレッドを塞がない)。central で呼ばれても何もしない
- peripheral → central: `zmk_split_peripheral_report_event` の入力イベントを、左トラックパッド用の既存 `zmk,input-split` チャネル `trackpad_split_L@1`(`reg = 1`)に相乗りさせて送る。専用の特性を増やさないのは、ZMK v0.3.0 の central の GATT 探索が 1 応答内の属性順に依存していて、入力特性を 2 本にすると 2 本目を購読できない(実機で `-ENOTCONN` を確認)ため。イベントの `type` はベンダ範囲 `0xF0` 以降を使い、`sync` は常に 0 にする(central の `zmk,input-listener` は未知の type を無視し、入力プロセッサはすべて type で弾く。`sync` を立てないので空のマウスレポートも出ない)。central 側は同じデバイスに `INPUT_CALLBACK_DEFINE` した自前のハンドラで `type < 0xF0` を捨てて受ける:
  - `0xF0 SUMMARY`: `code` = 語 index 0..9、`value` = 語。語 9 で 1 件完成
  - `0xF1 PARAM`: `code` = パラメータ index、`value` = 現在値(dump のとき index 順に全件)
  - `0xF2 ACK`: `code` = 要求した `param1`、`value` = 実行結果(errno、0 で成功)
  - `0xF3 STATUS`: `value` = `saved(bit0) | summary_on(bit1) | count<<8 | min(uptime_s,65535)<<16`。dump/info の最後に送る
- peripheral 側の送信は work で行い、1 回の work で最大 2 イベントを送って 10ms 後に再スケジュールする(central の ZMK 受信キューを溢れさせないためのペーシング。要約 10 通知で約 50ms、dump 55 通知で約 280ms)。`-ENOMEM`/`-EAGAIN`/`-ENOBUFS` なら 10ms 後に同じ index から再試行する(最大 50 回)。要約はキュー(深さ 4)に積む。central 側は `CONFIG_ZMK_SPLIT_BLE_CENTRAL_POSITION_QUEUE_SIZE=32` で受信キューを広げる。要約と応答の送信は `summary on|off` の状態でゲートする(BT 経由の `summary off` を効かせる)
- central 側は左手向けコマンドを 1 つずつ処理する(処理中は次を待たせる)。`L set <name> <value>` は名前を index に解決し範囲を central でも検証してから送り、ACK を `L OK <name>=<value>` / `L ERR out of range <min>..<max>` に整形する。`L list` は dump を送り、PARAM を `L <name> <value> <min> <max> <kind> <default>`(名前・範囲・既定値は central 側の同じテーブルから)に整形し、STATUS で終端する。`L info` は STATUS を `L side=peripheral uptime_ms=<n> params=<n> saved=<yes|no>` に整形する。`L reset`/`reati`/`save`/`summary on|off` は ACK を `L OK …`/`L ERR <errno>` にする。`L get`/`L trace` は `L ERR unsupported`。1000ms 応答がなければ `L ERR timeout`(`list` は PARAM を受け取るたびに延長し、index の欠落があれば STATUS 到達時に `L ERR param missing` を出す)。タイムアウト後 200ms は次の `L` コマンドを待たせ、遅れて届いた応答を次のコマンドに誤って帰属させない。いずれも最後に `L .`
- 左手の要約(SUMMARY 10 語)は `iqs9151_summary_unpack` → `iqs9151_summary_format` で `L T S …` の行にしてストリームに流す

#### 設定
- Kconfig `LALAPAD_TP_TUNER`(depends on `INPUT_IQS9151 && ZMK_SPLIT`、`default y`)。central ではサービスと転送の受け側、peripheral では behavior の実行と要約送信をコンパイルする
- `lalapadgen2.conf` の `#TRACKPAD TUNER` ブロックに `CONFIG_LALAPAD_TP_TUNER=y` を明示する
- USB CDC の `tp` シェルは左右ともそのまま残す(BT が使えないときの予備)

### 第 4 段: Mac ネイティブアプリ(`tools/tp-tuner-mac`)
- Swift + AppKit + WKWebView。Xcode 不要で `swiftc` と Command Line Tools だけで `build.sh` がアプリバンドル `build/TpTuner.app` を作る(ad-hoc 署名、`Info.plist` に `NSBluetoothAlwaysUsageDescription`)。`tools/tp-tuner/index.html` と `tuner.js` をそのままバンドル内 `Contents/Resources/web/` に複製して表示する
- ページとアプリの橋渡し: JS → ネイティブは `window.webkit.messageHandlers.tpTuner.postMessage({type, …})`、ネイティブ → JS は `window.tpTunerNative.onEvent({type, …})` を `evaluateJavaScript` で呼ぶ。メッセージ種別:
  - JS → ネイティブ: `listDevices`、`connect {id}`、`disconnect`、`write {text}`
  - ネイティブ → JS: `devices {devices: [{id, kind: 'ble'|'usb', name}]}`、`connected {id, kind, name}`、`data {text}`(受信したバイト列をそのまま UTF-8 で。行分割はページ側)、`disconnected {reason}`、`status {text}`
- BLE: `CBCentralManager` が `poweredOn` になったら `retrieveConnectedPeripherals(withServices: [サービス UUID])`、見つからなければ HID サービス(0x1812)で取得して名前が `LalapadGen2` で始まるものを候補にする。接続後にサービスとキャラクタリスティックを探索し `stream` を購読、`command` には write without response(不可なら with response)で書く。切断されたら再探索する。未接続の間は 2 秒ごとに候補を再列挙して `devices` を送る
- USB: `/dev/cu.usbmodem*` を候補に列挙し、POSIX で 115200 8N1 raw で開き DTR を立てる。読み取りスレッドが `data` を送る。右手の 2 ポート問題はページ側の既存ロジック(`tp info` に応答したポートを採用)で扱う
- ページ側は接続方式を意識せず、`transport` 抽象(`connect`/`disconnect`/`write`/`onData`/`onClose`)の実装が Web Serial かネイティブ橋かで切り替わる。ネイティブ橋があるときは Web Serial を使わない
- ページの BT モード: 対象(右手/左手)を選ぶセレクタを出し、コマンドは `tp ` を外して側の文字を前置して送る。受信行は側の接頭辞で振り分け、選択中の側の行だけをコマンド応答・要約として扱う(もう一方の側の要約はログにだけ出す)。フレームトレース(`T F`/`T E`)は BT では流れないので trace ボタンを隠し、カードは要約だけで判定する。側を切り替えたらパラメータを読み直す
- 起動時に自動接続が有効なら BLE の候補を優先して接続し、無ければ USB の候補を順に試す

## 検討した代替案

| 案 | 却下理由 |
| --- | --- |
| Web Bluetooth で直接接続 | macOS では HID 接続中のデバイスに GATT アクセスできない |
| ZMK Studio RPC を拡張 | Studio の protobuf/RPC 実装とクライアントを両方拡張する必要があり規模が大きい。ネイティブアプリも Studio 側のもの |
| 左手のフレームトレースを split 経由で流す | split BLE リンクの負荷でキー入力が詰まる |
| 変更のたびに自動保存 | flash 消耗。調整は「試して戻す」の繰り返しなので明示保存が適切 |
| 応答と要約を別々の notify キャラクタリスティックにする | 2 本のチャンク再組み立てと順序の扱いが増える。行に側の接頭辞と `T S` があれば 1 本で振り分けられる |
| 左手の要約を split のセンサーイベントで送る | central 側にセンサーデバイスと keymap のセンサー定義が必要になる。入力イベントなら `zmk,input-split` ノード 1 つで受けられる |
| 左手のコマンドをテキストのまま split で送る | behavior の引数は 32bit × 2 しかなく、テキストは載らない。index + 値の 2 語で全コマンドを表せる |
| Tauri / Electron でネイティブ化 | Rust や Node のツールチェーンとビルド時間が増える。必要なのは WKWebView と CoreBluetooth だけで、`swiftc` 単体で足りる |

### 第 5 段: 画面の作り直しとライブ表示

実機で第 3・4 段を使った結果、「調整の対象は左右共通でよい」「確認したい操作を先に選ぶ手順は使わない」「指の位置と判定をリアルタイムで見たい」が要件になった。第 5 段は画面を先に作り直し(5a)、それに合わせてファームのライブ表示を足す(5b)。

#### 5a: 画面(tools/tp-tuner、Mac アプリはそのまま抱える)
- レイアウト(上から): ヘッダ → パッド行(左右のパッドを模した角丸長方形 2 つ + 判定表示)→ パラメータ一覧 → タイムライン(10 秒固定、3 レーン)と診断 → ログ(折りたたみ)
- ヘッダは「接続方式と左右の接続状態(右手 ✓ / 左手 ✓、書き込み済みかどうか)」「未書き込みの変更 n 件」「接続/切断、自動接続」だけ。uptime やパラメータ数は出さない
- パッド: 縦横比は解像度(X 2457 × Y 3072)に合わせる。`T F` 行(指の本数、各指の座標、フラグ、hold、2F モード)から指の位置を点で描き、状態で色を変える(待機 / 1 本指 / 2 本指スクロール / 2 本指ピンチ / 3 本指 / ドラッグ中 / ボタン押下)。判定表示には「今の操作」(直近の `T F` と K イベントから)と「直近の試行」(要約からの認識文)を出す。認識文の横の「意図と違う」で本来の操作を選ぶと、関係パラメータの提案が 1 行出て「適用」で保留の変更に積める。`T F` が来ない側は「ライブ表示なし(要約のみ)」と示す
- パラメータは左右共通の 1 つの一覧。変更はすぐ送らず保留し、「書き込む」で左右両方に `set` → `save` → 読み直しを一度に行う。「再読み込み」は保留を捨てて読み直す。「全て既定に」は左右を `reset` して読み直す。「詳細: 左右別に設定」を開くと左右 2 列になり側ごとに保留できる。既定表示で左右の値が違う行には印を付け、その行を編集すると両側が同じ値になる
- エクスポートは「.conf をエクスポート」1 つ(全値の `CONFIG_…` 行をクリップボードへ + 表示)。書き出した値は `config/lalapadgen2.conf` に貼るビルド時の既定値で、アプリからの書き込み(NVS)はそれを上書きして動く
- タイムラインは幅 10 秒固定、レーンは「指の本数」「ファームが送った操作(クリック・移動・スクロール)」「Mac が受けた操作(アプリのウィンドウ上でのポインタ・ホイール)」の 3 本で、各レーンに説明を付ける。診断は残す
- 廃止: テストパッド(ポインタロック)、ジェスチャカード、プロファイルの保存/読込、差分/全部コピー、trace ボタン(USB ではライブ表示のため接続時に自動で `tp trace on`)、左右切り替えセレクタ(詳細設定の中に移す)
- USB で接続したときは接続した側だけを扱い、もう一方のパッドは「USB では接続側のみ」と示す

#### 5b: ファームのライブ表示(BT)
- 右手: ドライバのフレームごとのコールバックを 30 回/秒に間引き、`R T F …`(USB の trace と同じ書式)として `stream` に流す。ページのパッド表示のトグルが ON のときだけ(`R live on|off`)
- 左手: split リンクの負荷を抑えるため 15 回/秒に間引き、1 フレームを 1 入力イベントに詰める: `type` で指本数と 2F モード(`0xF4` 1 本、`0xF5` 2 本、`0xF6` 2 本スクロール、`0xF7` 2 本ピンチ、`0xF8` 3 本以上、`0xF9` 離した)、`code`(16bit)+`value`(32bit)の 48bit に指 1・2 の x/y を 12bit ずつ詰める(解像度は 12bit に収まる)。右手が `L T F …` の行に整形する。ページのトグルが ON のときだけ(`L live on|off` → behavior のオペコード `0x8006`)
- 送信は `tp live` の状態と `stream` の購読でゲートし、アプリが切断したら止める
