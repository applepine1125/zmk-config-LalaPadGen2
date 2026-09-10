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

## 実機の計測結果(2026-09-10、第 1 段ファーム)

アプリを BT 接続し、ライブ表示 ON で数分使ったあとの `stats`(右手 = central、左手 = peripheral)。

| 項目 | 右 | 左 |
| --- | --- | --- |
| frame_avg_us | 5181 | 4236 |
| frame_max_us | 302551 | 8087 |
| frame_gap_max_ms | 302 | 9 |
| i2c_err | 0 | 0 |
| wq_late_max_us | 3629211 | 244 |
| wq_late_over3 | 9 | 0 |
| notify_fail | 1430 | 0 |
| リンク | Mac 向け 2 本(int 15ms, lat 0)+ 左手向け 1 本(int 7.5ms) | 右手向け 1 本(int 7.5ms) |

読み取り:

- 左手は健全。専用ワークキュー化後、キースキャンを載せた syswq の遅れは最大 0.24ms。
- 右手の syswq は最大 3.6 秒止まっていた。原因は ZMK Studio の GATT 転送で、indicate が送信バッファ不足で失敗すると syswq 上で `k_sleep(200ms)` を繰り返す(zmk `app/src/studio/gatt_rpc_transport.c:162-168`)。送信バッファ不足を起こしていたのは tp-tuner の stream 通知(`notify_fail` 1430 回 = syswq からの K_NO_WAIT 失敗)。
- 「アプリを開くとトラックパッドが重い」の経路: Mac リンクは LL データ長 27 バイトのまま(ZMK は `BT_USER_DATA_LEN_UPDATE` を select しつつ更新要求を出さない。Studio の indicate が 27 バイト刻みだったことと一致)。244 バイトの stream 通知は LL パケット 10 個に分かれ、同じ接続の送信キューで HID レポートがその後ろに並ぶ。ライブ表示 ON では通知が連続するため、カーソルとキーの両方が遅れる。
- 右の frame_max/gap 302ms は Studio の sleep 中にドライバスレッドが待たされた時間(プリエンプト)で、I2C や処理時間ではない。frame_avg 4〜5ms は 400kHz でも変わらず、I2C 以外(ジェスチャ処理とコールバック)が主。要再計測: I2C 読み出し単体の時間。

対処(652fbd3 で実装):

- ホスト接続確立時に LE データ長の更新を要求する(e868da9 の再適用。以前の revert 理由だった右手の再起動は、外しても再発したため無関係と判断)。
- stream 通知は 1 件ずつ 8ms 間隔で送り、DLE 未交渉(tx_max_len < 100)のときは 20 バイト(LL 1 パケット)に収める。ライブ行は未送信 512 バイトを超えたら捨てる。
- `stats` の link 行に tx_len / rx_len を追加。Mac が DLE を受け入れたかはここで確認する。

### 2 回目以降の計測(DLE 適用後)

| 項目 | 右 | 左 |
| --- | --- | --- |
| wq_late_max_us / over3 | 81〜87ms / 3〜6 回(3〜10 分) | 0.3〜1.4ms / 0 |
| late_top(停止直前 10ms の CPU) | `BT RX`:91ms、idle 0 | – |
| frame_max_us / i2c_max_us | 293ms / 293ms | 277〜309ms / 15〜29ms |
| cpu_max_us | 0.7ms | 0.6ms |
| rdy_miss | = frame_n(100%) | = frame_n(100%) |
| notify_fail | 0〜1 | 0 |
| Mac リンク tx_len | 251 | – |

読み取り:

- DLE 適用と stream ペーシングで `notify_fail` は 1430 → 0〜1、右の syswq 停止は 3.6 秒 → 87ms になった。体感でも「軽くなった」「キー設定タブで固まらなくなった」。
- 残る右の 83〜87ms 停止は、直前 10ms の CPU が `BT RX`(Zephyr BT ホストの RX ワークキュー。`K_PRIO_COOP(CONFIG_BT_RX_PRIO)` の協調スレッドなので走っている間は syswq もドライバも動けない。zephyr `subsys/bluetooth/host/hci_core.c:4009-4012`)に付いた。`CONFIG_SOC_FLASH_NRF_PARTIAL_ERASE=y` でも変わらなかったので、NVS のページ消去ではない可能性が高い。BT RX が 90ms 走る処理は未特定(候補: 設定書き込みのフラッシュ待ちを BT RX 実行中として数えている、ECC 計算)。停止の時刻履歴(`late[i]`)で周期性を見る。
- フレーム処理の 300ms は計算ではなく(cpu_max 0.7ms)I2C の待ち。読み出し開始時に RDY が非アクティブなフレームが 100%(`rdy_miss`)。IQS9150/9151 データシート 12.5/12.8: RDY は通信窓の間 LOW を保ち、Force Comms Method=0(ドライバ既定)では窓の外で通信を始めるとクロックストレッチで次の窓まで待たされる。ドライバの IC 設定は Active 10ms・Idle 系 50ms(`iqs9151_init.h:98-106`)、I2C Timeout 100ms(`:120`)。平均フレーム時間 4〜5ms は「毎回次の窓まで待っている(0〜10ms の一様分布)」と一致し、300ms は LP2 の Auto-Prox Cycles(32 周期)相当と推測。割り込み時点の RDY と ISR→読み出しの遅れを次の計測で分ける。
- 左のキー 474 件を右が 474 件受信。split 経路のキー欠けは無い。

### 全部入り計測の結果(2026-09-11、27 分の通常使用)

| 項目 | 右 | 左 |
| --- | --- | --- |
| wq_late(3ms 超え) | 2 回、いずれも起動直後(t=1〜2s、BT RX 85ms) | 0 |
| isr_late_max_us(CPU 停止検出) | 244 | – |
| isr_rdy_low / isr_n | 502291 / 502292 | 552798 / 552799 |
| rdy_miss / frame_n | 502275 / 502275 | 552782 / 552782 |
| isr_to_read_max_us | 8605 | 2166 |
| i2c_avg_us / i2c_all_max_us | 3222 / 313751 | 2929 / 310333 |
| conn_n / disc_n | 2(起動時のみ)/ 0 | – |
| syswq の 3ms 超え連続実行 | `iqs9151_settings_set`/`iqs9151_settings_decode`(アプリ接続時) | – |

確定したこと:

- 右の 85ms 停止は起動直後の 2 回だけ(BT ホストの初期化)。通常使用中の停止は無く、これまでの回数は毎回ファーム書き込み直後の起動分を含んでいた。ユーザー影響なし。
- CPU 自体の停止(フラッシュ消去)は起きていない(1ms 割り込みの遅れ最大 0.24ms)。`CONFIG_SOC_FLASH_NRF_PARTIAL_ERASE` は不要だが害もないので残す。
- BLE の切断は無い。キー欠けが切断由来である可能性は消えた。
- RDY 割り込みの時点では RDY はアクティブ(ピン読みは正しい)だが、直後の読み出し開始時には 100% 非アクティブ。つまり通信窓は割り込みから数十 µs 以内に閉じており、毎回の読み出しは次のサンプリング周期までクロックストレッチしている(平均 3ms、LP モードで 300ms)。データシート 12.6 の I2C Timeout(100ms)とは一致しない挙動だが、実測を優先する。
- 対処(ドライバ): Config Settings の Terminate Comms Window(bit 6)を立て、フレーム読み出しと IC パラメータ反映の後に 0xEEEE を書いて窓を閉じる(12.7)。効果は `rdy_miss` が 0 になること、`i2c_avg_us` が 1ms 程度に下がること、`i2c_all_max_us` から 300ms が消えることで確認する。
- 残件(軽微): アプリ接続時に `iqs9151_settings_set` が syswq で 3〜5ms 走る。誰が settings を再読込しているかは未確認。

### 通信窓保持後の計測(2026-09-11、5 分)

| 項目 | 右(前 → 後) | 左(前 → 後) |
| --- | --- | --- |
| rdy_miss / frame_n | 100% → 0 | 100% → 0 |
| i2c_avg_us | 3222 → 1176 | 2929 → 1176 |
| i2c_max_us / i2c_all_max_us | 313751 → 2227 / 5212 | 15077 → 1434 / 5122 |
| frame_max_us | 314453 → 5371 | 310363 → 5279 |
| フレーム数 | 305/s(常時) → 17/s(操作時のみ) | 同様 |
| end_err | 0 | 0 |

- 読み出し待ちの 300ms は消え、1 フレームの I2C は 1.2ms になった。
- 副産物: これまで IC が常時 300 フレーム/秒を出しており(イベントモードが効いていなかった)、左右とも I2C とドライバスレッドが常時動いていた。窓を保持するようにしたらイベント時だけになった。CPU と電池の両方に効く。
- 残る体感「たまにカーソルの反応が遅れる」は、IC の省電力モード遷移(Active→Idle 1.5 秒、Idle→LP1 5 秒、LP1→LP2 40 秒、Idle 系のサンプリング 50ms)が候補。Idle-Touch / Idle / LP1 のタイムアウトをランタイムパラメータに追加し(ドライバ 49182e8)、アプリの「IC サンプリング周期」から調整できるようにした。
- 1ms タイマのサンプラは `CONFIG_LALAPAD_DIAG_ISR_SAMPLER`(既定 n)に退避。

### タイムアウト調整後(2026-09-11)

右 `active_mode_timeout_ms=5000`・`idle_mode_sampling_period_ms=20`(左も同じ)で「たまにカーソルが遅れる」は体感で解消。stats は rdy_miss 0、end_err 0、I2C 平均 1.2ms、最大 1.5ms、フレーム最大 3ms。右の syswq 停止は起動時 2 回とアプリ接続時の 5.8ms(`iqs9151_settings_set`)のみ。

## 第 2 段(計測後の候補)

第 1 段の計測で主要因(syswq 直列化、Mac リンクの LL データ長、IC の通信窓)がすべて解消したため、以下は必要になったときに検討する。

- Mac リンク: `CONFIG_BT_PERIPHERAL_PREF_*`(要求値のみ。採否は macOS)。
- split リンク: `CONFIG_ZMK_SPLIT_BLE_PREF_INT` / `PREF_LATENCY`、DLE(251)の要否。
- HOG: キーボードキュー深さ、マウスレポートの間引き。
- tp-tuner: ライブ通知を HID 送信待ちがあるときに後回しにする、レート引き下げ。
- 第 1 段で効果不明と判明した既存 conf(`BT_BUF_ACL_TX_COUNT` など)の整理。

## 検討した代替案

- ZMK 本体のキュー/スレッド優先度を変える: モジュール外の改変が必要で、v0.3.0 更新時に追従コストが大きいため見送り。
- 計測なしで conf を変える: 効果の判定ができず、過去の実験設定が残っている現状を繰り返すため却下。
