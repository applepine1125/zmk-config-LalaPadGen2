# tp-tuner Mac ネイティブアプリ

LalaPad Gen2 のトラックパッド設定を、macOS のネイティブアプリとして BLE または USB で調整するためのアプリです。`tools/tp-tuner/index.html` と `tuner.js` を WKWebView で表示し、Bluetooth(CoreBluetooth)と USB シリアル(POSIX)への橋渡しをネイティブ側が行います。

macOS では HID 接続中の BLE デバイスにブラウザ(Web Bluetooth)から GATT アクセスできないため、BLE 経由での調整にはこのアプリが必要です。

## 使い方

1. `/Applications` にインストールします。

   ```sh
   ./build.sh --install
   ```

   `build/TpTuner.app` を直接起動して試すだけなら `./build.sh --run` でも構いません。

2. 初回起動時、Gatekeeper が「開発元を確認できません」と表示して起動をブロックすることがあります。Finder で `/Applications/TpTuner.app` を右クリックして「開く」を選び、表示されるダイアログでもう一度「開く」を選んでください(以降はダブルクリックで起動できます)。
3. Bluetooth の使用許可を求めるダイアログが表示されるので、許可してください。許可しないと BLE 経由の接続ができません(USB のみ使用可能)。
4. アプリの画面で対象デバイスを選び「接続」を押します。候補が 1 つだけの場合は自動接続されることがあります。

## 更新の仕組み

起動から数秒後と、メニューの「TpTuner > 更新を確認…」で GitHub Releases(タグ `tp-tuner-b<ビルド番号>`)を確認し、手元より新しいビルドがあれば通知します。「更新する」を選ぶと zip をダウンロードして展開し、隔離属性を外したうえで自分自身のアプリバンドルを置き換えて再起動します。`main` への push で `.github/workflows/tp-tuner-app.yml` がビルドしてリリースを作成するため、通常は何もしなくても新しいビルドが検知されます。

手元でビルドしたもの(`--build` を省略、ビルド番号 0)は起動時の自動確認をしません。メニューからの手動確認は常に行えます。

## BLE で使うための条件

- 右手(central)側のファームウェアが tp-tuner の GATT サービス(第 3 段対応)を持っていること。古いファームでは「tp-tuner サービスがありません(ファームが古い)」と表示されるので、ファームウェアを更新してください。
- Mac と右手キーボードが Bluetooth でボンド済みであること(HID として通常利用できる状態)。
- 左手側の設定も、右手経由のコマンド転送によってこのアプリから切り替えられます。左手を直接 USB 接続する必要はありません。

## USB で使う

USB シリアル(`/dev/cu.usbmodem*`)接続でも同じ画面から調整できます。USB ケーブルで Mac とキーボードを接続すると、候補一覧に表示されます。

## トラブルシューティング

- **「tp-tuner サービスがありません(ファームが古い)」と表示される**: 右手のファームウェアを、GATT サービス(第 3 段)対応版に更新してください。
- **Bluetooth の許可ダイアログを誤って拒否した**: 「システム設定 > プライバシーとセキュリティ > Bluetooth」でこのアプリ(tp-tuner)を有効にしてから再起動してください。
- **候補が一覧に出てこない**: キーボードが Mac とボンド済みか、USB の場合はケーブルが正しく接続されているかを確認してください。

## メッセージ一覧(ページ ↔ ネイティブ)

JS からは `window.webkit.messageHandlers.tpTuner.postMessage(...)`、ネイティブからは `window.tpTunerNative.onEvent(...)` で JSON を送受信します。

JS → ネイティブ:

- `listDevices` — 接続候補の再列挙を要求する
- `connect {id}` — BLE(`identifier.uuidString`)または USB(`/dev/...` パス)へ接続する
- `disconnect` — 現在の接続(tp-tuner 用)を切断する
- `write {text}` — tp-tuner のコマンド文字列を送信する
- `studioWrite {b64}` — ZMK Studio RPC のバイト列(base64)を送信する。接続種別(BLE/USB)は tp-tuner 用の接続に従う
- `studioOpen {id}` — USB の Studio 用ポート(2 つ目のシリアル、tp-tuner 用ポートと同時に開く)を開く
- `studioClose` — USB の Studio 用ポートを閉じる

ネイティブ → JS:

- `devices {devices}` — 接続候補一覧
- `connected {id, kind, name}` — tp-tuner 用の接続に成功した
- `data {text}` — tp-tuner の受信データ
- `disconnected {reason}` — tp-tuner 用の接続が切断された
- `status {text}` — 状態メッセージ(Bluetooth の権限・書き込み失敗など)
- `studioReady {available}` — ZMK Studio RPC キャラクタリスティック/ポートの利用可否
- `studioData {b64}` — ZMK Studio RPC の受信バイト列(base64)。フレーミングの組み立てはページ側で行う
- `studioClosed {reason}` — ZMK Studio RPC の接続が終了した
