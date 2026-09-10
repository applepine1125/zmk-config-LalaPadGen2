# 入力応答性(キー/トラックパッド)チューニング設計

## 目的

左右どちらのキー入力・トラックパッド操作も、詰まり(まとまって届く)・欠け・重さを起こさないようにする。
体感報告: 「キー入力がたまに欠ける、特に左。左は入力が若干詰まる」「tp-tuner のライブ表示中は左右とも重い」。

方針は「構造的な競合を先に取り除き、計測できる状態にしてから数値を詰める」。計測なしの conf 実験は、
過去に効果不明のまま残った設定(`CONFIG_BT_BUF_ACL_TX_COUNT` 等)を増やすだけなので行わない。

## 現状の経路と競合点(確認済みの事実)

参照は ZMK v0.3.0(`app/`)、zmkfirmware/zephyr `v3.5.0+zmk-fixes`、ドライバ `zmk-driver-iqs9151`(`drivers/input/iqs9151.c`)。

- システムワークキュー(syswq)は協調優先度 -1 で、1 つの work が終わるまで他の work は走らない(zephyr `kernel/Kconfig:656-663`)。
- キースキャンは syswq 上の delayable work(zmk `app/module/drivers/kscan/kscan_gpio_matrix.c:190,200`)。
- トラックパッドのフレーム処理も syswq(`iqs9151.c:2817` の `k_work_submit`)。1 フレームで 28 バイトの I2C 読み出し(`iqs9151.c:139,2430`)。
  I2C は `nordic,nrf-twi`(xiao_ble)で `clock-frequency` 未指定。nrfx twi ドライバは devicetree の値をそのまま使う(`drivers/i2c/i2c_nrfx_twi.c:273-279`)ので、既定は binding の 100kHz と推測(未確認: binding の default 値)。100kHz なら 1 フレームの I2C だけで約 3ms syswq を占有する。
- ATI・リセット・IC パラメータ反映は RDY 待ちで 1ms sleep をループする(`iqs9151.c:878-889`、呼び出し元 `2837-2968, 3108`)。これも syswq 上で動くため、その間キースキャンが止まる。
- 左(peripheral)のキー位置通知は専用スレッド `service_work_q`(優先度 5)+ キュー 10 で、満杯なら古いものを捨てる(zmk `app/src/split/bluetooth/service.c:214-246`)。
  トラックパッドの入力イベントは input thread(優先度 0)から直接 `bt_gatt_notify`(`service.c:329`)。syswq 以外から呼ぶと送信バッファ空きを無期限に待つ(zephyr `subsys/bluetooth/host/att.c:187,681`)。
- 右(central)は左からのキー/入力イベントをキュー 32 経由で syswq の work で処理する(zmk `app/src/split/bluetooth/central.c:146-151,204-205`)。
  HID は `hog_work_q`(優先度 5)で、キーボードキュー 20 が満杯なら古いレポートを捨てる(`app/src/hog.c:307,343`)。
- tp-tuner: 右の GATT stream は syswq から `bt_gatt_notify`(K_NO_WAIT、-ENOMEM は再試行)、左のイベントは syswq の send work で 2 件/10ms にペーシング。
- ZMK のログレベルは既定 4(DBG)(zmk `app/Kconfig:545`)。`CONFIG_LOG_DEFAULT_LEVEL=1` は ZMK モジュールには効かない。

## 仮説

- H1 syswq の直列化: トラックパッド処理(I2C 約 3ms + ジェスチャ処理、パラメータ反映時は最大数百 ms)がキースキャンと split イベント処理を遅らせる。左右両方に効き、パッドを触っているときにキーがまとまって届く症状と合う。
- H2 リンク競合: 同じ BLE リンクをキー・パッド・tp-tuner が取り合う(split リンク、Mac リンクの両方)。
- H3 Mac リンクの接続パラメータ(macOS が決める interval / latency)。
- H4 tp-tuner のライブ通知(Mac リンク・split リンク両方に乗る)。

## 第 1 段: 構造改善と計測

### 1. トラックパッド処理を専用ワークキューへ(ドライバ)

- ドライバ内の全 work(フレーム処理、クリック/慣性/flush/summary の delayable)を専用キュー `iqs9151_work_q` に移す。1 スレッドで直列に動かすため、既存のデータ競合前提は変わらない。
- 優先度は Kconfig `INPUT_IQS9151_THREAD_PRIORITY`(既定 2、プリエンプト可)。syswq(-1)と input thread(0)より低く、HOG/split 送信スレッド(5)より高い。スタックは `INPUT_IQS9151_THREAD_STACK_SIZE`(既定 3072)。
- 効果: I2C 待ちや RDY 待ちの sleep 中も syswq が空くので、キースキャン・イベント処理が止まらない。

### 2. I2C を 400kHz に(config)

- `&xiao_i2c { clock-frequency = <I2C_BITRATE_FAST>; }`。IQS9151 は Fast-mode Plus(1MHz)まで対応(Azoteq 製品ページ https://www.azoteq.com/product/iqs9151/ 。datasheet https://www.azoteq.com/images/stories/pdf/IQS9150_IQS9151_datasheet.pdf は要確認)。
- 基板のプルアップ次第で通信エラーが出る可能性があるため、`stats` の I2C エラー数で確認し、問題があれば 250kHz か 100kHz に戻す。

### 3. ZMK ログレベルを WRN に(config)

- `CONFIG_ZMK_LOG_LEVEL=2`。DBG の整形コストをなくしつつ、キュー満杯などの WRN は USB シェルで見えるようにする。

### 4. 計測(`stats`)

両側で同じ項目を取り、読み取り時にリセットする。

| 項目 | 内容 | 取得元 |
| --- | --- | --- |
| frame_n / frame_max_us / frame_avg_us | フレーム work の回数・最大/平均処理時間 | ドライバ |
| frame_gap_max_ms | 指が乗っている間のフレーム間隔の最大 | ドライバ |
| i2c_err | I2C エラー回数 | ドライバ |
| wq_late_max_us / wq_late_over3 | syswq に 10ms 周期で積んだプローブの遅れの最大値(µs)と 3ms 超えの回数 | config(`src/lalapad_diag.c`) |
| pos_n / pos_gap_max_ms | キー位置イベント数と最大間隔(右は左由来も別カウント) | config |
| link_int_us / link_lat / link_to_ms | 接続ごとの interval・latency・timeout(BT で返す左手分は最初の接続のみ) | config(`bt_conn_foreach`) |
| notify_fail | tp-tuner の送信失敗回数 | config |

取得経路:

- USB シェル: `tp stats`(両側)。ドライバがドライバ項目を出力し、config 側が登録したフックで残りを追記する。
- BT: アプリから `R stats` / `L stats`。左は STATS イベント(type 0xFE、code = 項目 id、value = 値、id 0 で終端)で返し、右が `L stats <名前>=<値>` 行に整形する。
- アプリ: ログ欄に「統計」ボタン。両側の `stats` を送り、返ってきた行をログに出す。

### 5. 検証手順

1. 左右とも新ファームを書き込む。
2. アプリを起動せずに 10 分ほど普通に使う(キー入力とパッド操作を混ぜる)。
3. アプリを接続し、ログ欄の「統計」で両側の値を読む。`wq_late_max_us` が数千(数 ms)以下、`i2c_err` が 0、`frame_max_us` が 2ms 未満なら H1 は解消。
4. リンクの interval/latency を記録する(Mac リンクは macOS が決めるため、ここで初めて分かる)。
5. ライブ表示 ON で同じことを繰り返し、差分を見る(H4)。

## 第 2 段(計測後の候補)

- Mac リンク: `CONFIG_BT_PERIPHERAL_PREF_*`(要求値のみ。採否は macOS)。
- split リンク: `CONFIG_ZMK_SPLIT_BLE_PREF_INT` / `PREF_LATENCY`、DLE(251)の要否。
- HOG: キーボードキュー深さ、マウスレポートの間引き。
- tp-tuner: ライブ通知を HID 送信待ちがあるときに後回しにする、レート引き下げ。
- 第 1 段で効果不明と判明した既存 conf(`BT_BUF_ACL_TX_COUNT` など)の整理。

## 検討した代替案

- ZMK 本体のキュー/スレッド優先度を変える: モジュール外の改変が必要で、v0.3.0 更新時に追従コストが大きいため見送り。
- 計測なしで conf を変える: 効果の判定ができず、過去の実験設定が残っている現状を繰り返すため却下。
