# トラックパッド調整ツール(tp-tuner)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IQS9151 ドライバのジェスチャ判定値と IC 感度レジスタを USB シリアル経由でその場で変更し、ドライバの送信内容とホストの受信内容を同じ時間軸で見られる調整ツールを作る。

**Architecture:** ドライバフォーク(`applepine1125/zmk-driver-iqs9151`、ブランチ `runtime-tuning`)にパラメータ構造体・`tp` シェルコマンド・トレース出力を追加する。zmk-config 側は Kconfig でシェルと USB CDC を有効化し、`tools/tp-tuner/` に Web Serial で接続する単一 HTML と純粋関数モジュール、Node テストを置く。

**Tech Stack:** Zephyr 3.5(ZMK v0.3.0)、C、ztest、Zephyr shell、Zephyr LOG(deferred)、Web Serial API、vanilla JS、`node --test`(Node 20)、Docker(`zmkfirmware/zmk-build-arm:3.5`)、GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-07-trackpad-tuner-design.md`

## Global Constraints

- 会話・コミットメッセージ・コメント・README は日本語。テストケース名も日本語(「<given>のとき、<when>すると<then>になる」形式)
- 全ファイルの末尾に改行を入れる。行末の空白は残さない
- 自明なコードコメントは書かない
- コミットメッセージ末尾に必ず付ける:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
  ```
- `cd <path> && git ...` は使わず `git -C <path> ...` を使う
- ドライバフォークの作業ディレクトリ: `~/go/src/github.com/applepine1125/zmk-driver-iqs9151`(以下 `$DRV`)
- zmk-config の作業ディレクトリ: `~/go/src/github.com/applepine1125/zmk-config-LalaPadGen2`(以下 `$CFG`)。ブランチ `trackpad-tuner` に切り替え済み
- ローカルに west / Zephyr SDK はない。ドライバの ztest はフォークの GitHub Actions(Task 1 で追加)で回す。Docker(`zmkfirmware/zmk-build-arm:3.5`)でのローカル実行スクリプトも用意するが、Apple Silicon 上では x86_64 エミュレーションになるため動かなければ CI を正とする
- パラメータ名は Kconfig 名 `CONFIG_INPUT_IQS9151_<NAME>` の `<NAME>` を小文字化したもの(例 `1f_tap_max_ms`)。構造体フィールド名は先頭が数字にならないよう `1F`→`f1`、`2F`→`f2`、`3F`→`f3` に置き換える(例 `f1_tap_max_ms`)
- パラメータ定義テーブルは **IC 系 16 個を先頭**に並べる。その index(0..15)を保留ビットに使う
- `tp` コマンドの応答書式は spec のとおり。エラーは `ERR <reason>` 1 行
- トレース行の書式は spec のとおり(`T F …` / `T E …`)。時刻は `(uint32_t)k_uptime_get()` を `%u` で出す

---

## ファイル構成

### ドライバフォーク(`$DRV`、ブランチ `runtime-tuning`)

| ファイル | 責務 |
| --- | --- |
| `west.yml`(新規) | テスト用 west ワークスペースのマニフェスト。ZMK v0.3.0 を import する |
| `tests/run.sh`(新規) | Docker で ztest を回すスクリプト |
| `.github/workflows/test.yml`(新規) | GitHub Actions で ztest を回す |
| `drivers/input/iqs9151_params.h`(新規) | `struct iqs9151_params`、種別 enum、定義テーブル API、デバイス API の宣言 |
| `drivers/input/iqs9151_params.c`(新規) | 定義テーブル、初期化、範囲チェック付き get/set(デバイス非依存の純粋ロジック) |
| `drivers/input/iqs9151.c`(変更) | パラメータ構造体の保持と参照、IC 書き込みの保留・適用、トレース出力、デバイス API |
| `drivers/input/iqs9151_shell.c`(新規) | `tp` シェルコマンド |
| `drivers/input/iqs9151_test.h`(変更) | テストフック追加 |
| `drivers/input/Kconfig`(変更) | `INPUT_IQS9151_SHELL` 追加 |
| `drivers/input/CMakeLists.txt`(変更) | 新規ソース追加 |
| `tests/iqs9151_params/`(新規) | パラメータロジックの ztest |
| `tests/iqs9151_work_cb/`(変更) | 既存テストに params ソース追加、ランタイム変更のテスト追加 |
| `documents/iqs9151_kconfig_reference.md`(変更) | シェル Kconfig とパラメータ名の対応を追記 |

### zmk-config(`$CFG`、ブランチ `trackpad-tuner`)

| ファイル | 責務 |
| --- | --- |
| `config/lalapadgen2.conf`(変更) | シェル・USB CDC・LOG の有効化 |
| `config/west.yml`(変更) | フォークの `runtime-tuning` コミット SHA を参照 |
| `tools/tp-tuner/tuner.js`(新規) | 純粋関数: `tp list`/`tp info`/トレース行のパース、時刻合わせ、診断、`.conf` 生成 |
| `tools/tp-tuner/tuner.test.js`(新規) | `node --test` のテスト |
| `tools/tp-tuner/index.html`(新規) | UI(接続、パラメータパネル、テストパッド、タイムライン、診断、エクスポート) |
| `tools/tp-tuner/README.md`(新規) | 立ち上げ手順と注意 |

---

### Task 1: ドライバフォークの作業ブランチとテスト CI

**Files:**
- Create: `$DRV/west.yml`
- Create: `$DRV/tests/run.sh`
- Create: `$DRV/.github/workflows/test.yml`

**Interfaces:**
- Produces: ブランチ `runtime-tuning`(`hold-release-forever` + `sensitivity-kconfig` を統合済み)、`tests/run.sh`(ローカル実行)、GitHub Actions `test`(push ごとに ztest 実行)

- [ ] **Step 1: フォークを clone し、統合ブランチを作る**

```bash
git clone https://github.com/applepine1125/zmk-driver-iqs9151 ~/go/src/github.com/applepine1125/zmk-driver-iqs9151
DRV=~/go/src/github.com/applepine1125/zmk-driver-iqs9151
git -C $DRV checkout -b runtime-tuning origin/hold-release-forever
git -C $DRV merge --no-edit origin/sensitivity-kconfig
git -C $DRV log --oneline -4
```

Expected: マージがコンフリクトなしで完了し、`b771211`(hold-release)と `af9c0c1`(sensitivity)の両方が履歴に含まれる。コンフリクトした場合は `drivers/input/iqs9151.c` の `iqs9151_apply_kconfig_overrides` 付近のみのはずなので、両方の変更を残す形で解消する。

- [ ] **Step 2: テスト用 west マニフェストを追加**

`$DRV/west.yml`:

```yaml
# ztest 実行用の west ワークスペース定義。
# このリポジトリを <ws>/modules/zmk-driver-iqs9151 に置き、<ws> で
# `west init -l modules/zmk-driver-iqs9151 && west update` する。
manifest:
  remotes:
    - name: zmkfirmware
      url-base: https://github.com/zmkfirmware
  projects:
    - name: zmk
      remote: zmkfirmware
      revision: v0.3.0
      import: app/west.yml
  self:
    path: modules/zmk-driver-iqs9151
```

`tests/iqs9151_work_cb/CMakeLists.txt` の `ZMK_APP_DIR` は `${CMAKE_CURRENT_LIST_DIR}/../../../../zmk/app` なので、この配置で `<ws>/zmk/app` を指す。

- [ ] **Step 3: Docker 実行スクリプトを追加**

`$DRV/tests/run.sh`:

```bash
#!/usr/bin/env bash
# ZMK の CI コンテナで ztest を実行する。
# 使い方: tests/run.sh [テストディレクトリ名...]   (省略時は tests/ 配下すべて)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="docker.io/zmkfirmware/zmk-build-arm:3.5"
VOLUME="zmk-driver-iqs9151-west"
BOARD="native_sim_64"

if [ "$#" -eq 0 ]; then
  set -- $(cd "$REPO_DIR/tests" && ls -d */ | tr -d /)
fi

docker volume create "$VOLUME" >/dev/null
docker run --rm \
  -v "$VOLUME:/ws" \
  -v "$REPO_DIR:/ws/modules/zmk-driver-iqs9151" \
  -w /ws \
  "$IMAGE" bash -ec '
    if [ ! -d .west ]; then
      west init -l modules/zmk-driver-iqs9151
    fi
    west update --fetch-opt=--filter=tree:0
    west zephyr-export
    status=0
    for t in "$@"; do
      echo "=== $t ==="
      west build -p always -b '"$BOARD"' -d "build/$t" "modules/zmk-driver-iqs9151/tests/$t" -t run || status=1
    done
    exit $status
  ' _ "$@"
```

```bash
chmod +x $DRV/tests/run.sh
```

- [ ] **Step 4: GitHub Actions を追加**

`$DRV/.github/workflows/test.yml`:

```yaml
name: Test

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  ztest:
    runs-on: ubuntu-latest
    container:
      image: docker.io/zmkfirmware/zmk-build-arm:3.5
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: modules/zmk-driver-iqs9151

      - name: Cache west modules
        uses: actions/cache@v4
        with:
          path: |
            zmk
            zephyr
            modules/hal
            modules/lib
            modules/crypto
            modules/debug
            modules/fs
            tools
          key: ${{ runner.os }}-west-${{ hashFiles('modules/zmk-driver-iqs9151/west.yml') }}

      - name: Initialize workspace
        run: west init -l modules/zmk-driver-iqs9151

      - name: Update modules
        run: west update --fetch-opt=--filter=tree:0

      - name: Export Zephyr CMake package
        run: west zephyr-export

      - name: Run tests
        run: |
          status=0
          for t in $(ls modules/zmk-driver-iqs9151/tests | grep -v '\.sh$'); do
            echo "=== $t ==="
            west build -p always -b native_sim_64 -d "build/$t" "modules/zmk-driver-iqs9151/tests/$t" -t run || status=1
          done
          exit $status
```

- [ ] **Step 5: コミットして push し、CI が既存テストで green になることを確認**

```bash
git -C $DRV add west.yml tests/run.sh .github/workflows/test.yml
git -C $DRV commit -m "$(cat <<'EOF'
ztest を CI と Docker で実行できるようにする

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $DRV push -u origin runtime-tuning
gh run watch --repo applepine1125/zmk-driver-iqs9151 --exit-status $(gh run list --repo applepine1125/zmk-driver-iqs9151 --branch runtime-tuning --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: `Run tests` ステップで `PROJECT EXECUTION SUCCESSFUL` が出て job が成功する。失敗したら `gh run view --repo applepine1125/zmk-driver-iqs9151 --log-failed` でログを見る。よくある原因: `native_sim_64` が無い(→ `native_sim` に変える)、`west update` のキャッシュパス不足(→ ログの `west update` 出力にあるパスをキャッシュに足す)。ローカルでも `tests/run.sh iqs9151_work_cb` を一度試し、動いたかどうかを記録する(動かなくてもこの Task は CI green で完了とする)。

---

### Task 2: パラメータ定義テーブルと純粋ロジック

**Files:**
- Create: `$DRV/drivers/input/iqs9151_params.h`
- Create: `$DRV/drivers/input/iqs9151_params.c`
- Create: `$DRV/tests/iqs9151_params/CMakeLists.txt`, `prj.conf`, `testcase.yaml`, `src/main.c`
- Modify: `$DRV/drivers/input/CMakeLists.txt`

**Interfaces:**
- Produces:
  - `struct iqs9151_params`(全 50 フィールド、`int32_t`)
  - `enum iqs9151_param_kind { IQS9151_PARAM_IC_U8, IQS9151_PARAM_IC_U16, IQS9151_PARAM_DRIVER, IQS9151_PARAM_DRIVER_BOOL }`
  - `struct iqs9151_param_def { const char *name; uint16_t offset; int32_t min; int32_t max; int32_t def; enum iqs9151_param_kind kind; uint16_t reg; }`
  - `size_t iqs9151_param_count(void)`
  - `const struct iqs9151_param_def *iqs9151_param_def_at(size_t idx)`
  - `const struct iqs9151_param_def *iqs9151_param_find(const char *name)`(見つからなければ NULL)
  - `void iqs9151_params_init(struct iqs9151_params *p)`(全フィールドを既定値に)
  - `int iqs9151_params_set(struct iqs9151_params *p, const struct iqs9151_param_def *def, int32_t value)`(範囲外は `-ERANGE`)
  - `int32_t iqs9151_params_get(const struct iqs9151_params *p, const struct iqs9151_param_def *def)`
  - `bool iqs9151_param_is_ic(const struct iqs9151_param_def *def)`
  - `const char *iqs9151_param_kind_str(enum iqs9151_param_kind kind)`(`ic_u8` / `ic_u16` / `driver` / `driver_bool`)
  - `#define IQS9151_PARAM_IC_COUNT 16`

- [ ] **Step 1: ヘッダを書く**

`$DRV/drivers/input/iqs9151_params.h`:

```c
#ifndef ZEPHYR_DRIVERS_INPUT_IQS9151_PARAMS_H_
#define ZEPHYR_DRIVERS_INPUT_IQS9151_PARAMS_H_

#include <zephyr/device.h>
#include <zephyr/sys/util.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iqs9151_regs.h"

enum iqs9151_param_kind {
    IQS9151_PARAM_IC_U8,
    IQS9151_PARAM_IC_U16,
    IQS9151_PARAM_DRIVER,
    IQS9151_PARAM_DRIVER_BOOL,
};

/*
 * X(field, name, default, min, max, kind, reg)
 * IC 系 16 個を先頭に置く。index を IC 書き込みの保留ビットに使う。
 */
#define IQS9151_PARAM_LIST(X)                                                                   \
    X(touch_set_threshold, "touch_set_threshold", CONFIG_INPUT_IQS9151_TOUCH_SET_THRESHOLD,     \
      0, 255, IQS9151_PARAM_IC_U8, IQS9151_ADDR_TOUCH_SET_THRESHOLD)                            \
    X(touch_clear_threshold, "touch_clear_threshold",                                           \
      CONFIG_INPUT_IQS9151_TOUCH_CLEAR_THRESHOLD, 0, 255, IQS9151_PARAM_IC_U8,                  \
      IQS9151_ADDR_TOUCH_CLEAR_THRESHOLD)                                                       \
    X(alp_set_debounce, "alp_set_debounce", CONFIG_INPUT_IQS9151_ALP_SET_DEBOUNCE, 0, 255,      \
      IQS9151_PARAM_IC_U8, IQS9151_ADDR_ALP_SET_DEBOUNCE)                                       \
    X(alp_clear_debounce, "alp_clear_debounce", CONFIG_INPUT_IQS9151_ALP_CLEAR_DEBOUNCE, 0,     \
      255, IQS9151_PARAM_IC_U8, IQS9151_ADDR_ALP_CLEAR_DEBOUNCE)                                \
    X(stationary_touch_mov_threshold, "stationary_touch_mov_threshold",                         \
      CONFIG_INPUT_IQS9151_STATIONARY_TOUCH_MOV_THRESHOLD, 0, 255, IQS9151_PARAM_IC_U8,         \
      IQS9151_ADDR_STATIONARY_TOUCH_MOV_THRESHOLD)                                              \
    X(jitter_filter_delta, "jitter_filter_delta", CONFIG_INPUT_IQS9151_JITTER_FILTER_DELTA, 0,  \
      255, IQS9151_PARAM_IC_U8, IQS9151_ADDR_JITTER_FILTER_DELTA)                               \
    X(finger_confidence_threshold, "finger_confidence_threshold",                               \
      CONFIG_INPUT_IQS9151_FINGER_CONFIDENCE_THRESHOLD, 0, 255, IQS9151_PARAM_IC_U8,            \
      IQS9151_ADDR_FINGER_CONFIDENCE_THRESHOLD)                                                 \
    X(dynamic_filter_bottom_beta, "dynamic_filter_bottom_beta",                                 \
      CONFIG_INPUT_IQS9151_DYNAMIC_FILTER_BOTTOM_BETA, 0, 255, IQS9151_PARAM_IC_U8,             \
      IQS9151_ADDR_XY_DYNAMIC_FILTER_BOTTOM_BETA)                                               \
    X(active_mode_sampling_period_ms, "active_mode_sampling_period_ms",                         \
      CONFIG_INPUT_IQS9151_ACTIVE_MODE_SAMPLING_PERIOD_MS, 1, 65535, IQS9151_PARAM_IC_U16,      \
      IQS9151_ADDR_ACTIVE_MODE_SAMPLING_PERIOD)                                                 \
    X(idle_touch_mode_sampling_period_ms, "idle_touch_mode_sampling_period_ms",                 \
      CONFIG_INPUT_IQS9151_IDLE_TOUCH_MODE_SAMPLING_PERIOD_MS, 1, 65535, IQS9151_PARAM_IC_U16,  \
      IQS9151_ADDR_IDLE_TOUCH_MODE_SAMPLING_PERIOD)                                             \
    X(idle_mode_sampling_period_ms, "idle_mode_sampling_period_ms",                             \
      CONFIG_INPUT_IQS9151_IDLE_MODE_SAMPLING_PERIOD_MS, 1, 65535, IQS9151_PARAM_IC_U16,        \
      IQS9151_ADDR_IDLE_MODE_SAMPLING_PERIOD)                                                   \
    X(lp1_mode_sampling_period_ms, "lp1_mode_sampling_period_ms",                               \
      CONFIG_INPUT_IQS9151_LP1_MODE_SAMPLING_PERIOD_MS, 1, 65535, IQS9151_PARAM_IC_U16,         \
      IQS9151_ADDR_LP1_MODE_SAMPLING_PERIOD)                                                    \
    X(lp2_mode_sampling_period_ms, "lp2_mode_sampling_period_ms",                               \
      CONFIG_INPUT_IQS9151_LP2_MODE_SAMPLING_PERIOD_MS, 1, 65535, IQS9151_PARAM_IC_U16,         \
      IQS9151_ADDR_LP2_MODE_SAMPLING_PERIOD)                                                    \
    X(active_mode_timeout_ms, "active_mode_timeout_ms",                                         \
      CONFIG_INPUT_IQS9151_ACTIVE_MODE_TIMEOUT_MS, 0, 65535, IQS9151_PARAM_IC_U16,              \
      IQS9151_ADDR_ACTIVE_MODE_TIMEOUT)                                                         \
    X(ati_targetcount, "ati_targetcount", CONFIG_INPUT_IQS9151_ATI_TARGETCOUNT, 0, 1000,        \
      IQS9151_PARAM_IC_U16, IQS9151_ADDR_TRACKPAD_ATI_TARGET)                                   \
    X(dynamic_filter_bottom_speed, "dynamic_filter_bottom_speed",                               \
      CONFIG_INPUT_IQS9151_DYNAMIC_FILTER_BOTTOM_SPEED, 0, 2047, IQS9151_PARAM_IC_U16,          \
      IQS9151_ADDR_XY_DYNAMIC_FILTER_BOTTOM_SPEED)                                              \
    X(dynamic_filter_top_speed, "dynamic_filter_top_speed",                                     \
      CONFIG_INPUT_IQS9151_DYNAMIC_FILTER_TOP_SPEED, 0, 2047, IQS9151_PARAM_IC_U16,             \
      IQS9151_ADDR_XY_DYNAMIC_FILTER_TOP_SPEED)                                                 \
    /* ここまで IC 系 16 個 */                                                                   \
    X(f1_tap_enable, "1f_tap_enable", IS_ENABLED(CONFIG_INPUT_IQS9151_1F_TAP_ENABLE), 0, 1,     \
      IQS9151_PARAM_DRIVER_BOOL, 0)                                                             \
    X(f1_tap_max_ms, "1f_tap_max_ms", CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS, 1, 1000,              \
      IQS9151_PARAM_DRIVER, 0)                                                                  \
    X(f1_tap_move, "1f_tap_move", CONFIG_INPUT_IQS9151_1F_TAP_MOVE, 1, 1000,                    \
      IQS9151_PARAM_DRIVER, 0)                                                                  \
    X(f1_presshold_enable, "1f_presshold_enable",                                               \
      IS_ENABLED(CONFIG_INPUT_IQS9151_1F_PRESSHOLD_ENABLE), 0, 1, IQS9151_PARAM_DRIVER_BOOL, 0) \
    X(f1_tapdrag_gap_max_ms, "1f_tapdrag_gap_max_ms",                                           \
      CONFIG_INPUT_IQS9151_1F_TAPDRAG_GAP_MAX_MS, 1, 1000, IQS9151_PARAM_DRIVER, 0)             \
    X(f2_tap_enable, "2f_tap_enable", IS_ENABLED(CONFIG_INPUT_IQS9151_2F_TAP_ENABLE), 0, 1,     \
      IQS9151_PARAM_DRIVER_BOOL, 0)                                                             \
    X(f2_tap_max_ms, "2f_tap_max_ms", CONFIG_INPUT_IQS9151_2F_TAP_MAX_MS, 1, 1000,              \
      IQS9151_PARAM_DRIVER, 0)                                                                  \
    X(f2_tap_move, "2f_tap_move", CONFIG_INPUT_IQS9151_2F_TAP_MOVE, 1, 1000,                    \
      IQS9151_PARAM_DRIVER, 0)                                                                  \
    X(f2_presshold_enable, "2f_presshold_enable",                                               \
      IS_ENABLED(CONFIG_INPUT_IQS9151_2F_PRESSHOLD_ENABLE), 0, 1, IQS9151_PARAM_DRIVER_BOOL, 0) \
    X(f2_tapdrag_gap_max_ms, "2f_tapdrag_gap_max_ms",                                           \
      CONFIG_INPUT_IQS9151_2F_TAPDRAG_GAP_MAX_MS, 1, 1000, IQS9151_PARAM_DRIVER, 0)             \
    X(scroll_x_enable, "scroll_x_enable", IS_ENABLED(CONFIG_INPUT_IQS9151_SCROLL_X_ENABLE), 0,  \
      1, IQS9151_PARAM_DRIVER_BOOL, 0)                                                          \
    X(scroll_y_enable, "scroll_y_enable", IS_ENABLED(CONFIG_INPUT_IQS9151_SCROLL_Y_ENABLE), 0,  \
      1, IQS9151_PARAM_DRIVER_BOOL, 0)                                                          \
    X(f2_scroll_start_move, "2f_scroll_start_move",                                             \
      CONFIG_INPUT_IQS9151_2F_SCROLL_START_MOVE, 1, 2000, IQS9151_PARAM_DRIVER, 0)              \
    X(f2_pinch_enable, "2f_pinch_enable", IS_ENABLED(CONFIG_INPUT_IQS9151_2F_PINCH_ENABLE), 0,  \
      1, IQS9151_PARAM_DRIVER_BOOL, 0)                                                          \
    X(f2_pinch_start_distance, "2f_pinch_start_distance",                                       \
      CONFIG_INPUT_IQS9151_2F_PINCH_START_DISTANCE, 1, 2000, IQS9151_PARAM_DRIVER, 0)           \
    X(f2_pinch_wheel_gain_x10, "2f_pinch_wheel_gain_x10",                                       \
      CONFIG_INPUT_IQS9151_2F_PINCH_WHEEL_GAIN_X10, 1, 100, IQS9151_PARAM_DRIVER, 0)            \
    X(f3_tap_enable, "3f_tap_enable", IS_ENABLED(CONFIG_INPUT_IQS9151_3F_TAP_ENABLE), 0, 1,     \
      IQS9151_PARAM_DRIVER_BOOL, 0)                                                             \
    X(f3_tap_max_ms, "3f_tap_max_ms", CONFIG_INPUT_IQS9151_3F_TAP_MAX_MS, 1, 1000,              \
      IQS9151_PARAM_DRIVER, 0)                                                                  \
    X(f3_tap_move, "3f_tap_move", CONFIG_INPUT_IQS9151_3F_TAP_MOVE, 1, 1000,                    \
      IQS9151_PARAM_DRIVER, 0)                                                                  \
    X(f3_presshold_enable, "3f_presshold_enable",                                               \
      IS_ENABLED(CONFIG_INPUT_IQS9151_3F_PRESSHOLD_ENABLE), 0, 1, IQS9151_PARAM_DRIVER_BOOL, 0) \
    X(f3_tapdrag_gap_max_ms, "3f_tapdrag_gap_max_ms",                                           \
      CONFIG_INPUT_IQS9151_3F_TAPDRAG_GAP_MAX_MS, 1, 1000, IQS9151_PARAM_DRIVER, 0)             \
    X(f3_swipe_threshold, "3f_swipe_threshold", CONFIG_INPUT_IQS9151_3F_SWIPE_THRESHOLD, 0,     \
      1000, IQS9151_PARAM_DRIVER, 0)                                                            \
    X(cursor_inertia_enable, "cursor_inertia_enable",                                           \
      IS_ENABLED(CONFIG_INPUT_IQS9151_CURSOR_INERTIA_ENABLE), 0, 1, IQS9151_PARAM_DRIVER_BOOL,  \
      0)                                                                                        \
    X(cursor_inertia_decay, "cursor_inertia_decay", CONFIG_INPUT_IQS9151_CURSOR_INERTIA_DECAY,  \
      0, 1000, IQS9151_PARAM_DRIVER, 0)                                                         \
    X(cursor_inertia_recent_window_ms, "cursor_inertia_recent_window_ms",                       \
      CONFIG_INPUT_IQS9151_CURSOR_INERTIA_RECENT_WINDOW_MS, 1, 500, IQS9151_PARAM_DRIVER, 0)    \
    X(cursor_inertia_stale_gap_ms, "cursor_inertia_stale_gap_ms",                               \
      CONFIG_INPUT_IQS9151_CURSOR_INERTIA_STALE_GAP_MS, 1, 500, IQS9151_PARAM_DRIVER, 0)        \
    X(cursor_inertia_min_samples, "cursor_inertia_min_samples",                                 \
      CONFIG_INPUT_IQS9151_CURSOR_INERTIA_MIN_SAMPLES, 1, 12, IQS9151_PARAM_DRIVER, 0)          \
    X(cursor_inertia_min_avg_speed, "cursor_inertia_min_avg_speed",                             \
      CONFIG_INPUT_IQS9151_CURSOR_INERTIA_MIN_AVG_SPEED, 1, 500, IQS9151_PARAM_DRIVER, 0)       \
    X(scroll_inertia_enable, "scroll_inertia_enable",                                           \
      IS_ENABLED(CONFIG_INPUT_IQS9151_SCROLL_INERTIA_ENABLE), 0, 1, IQS9151_PARAM_DRIVER_BOOL,  \
      0)                                                                                        \
    X(scroll_inertia_decay, "scroll_inertia_decay", CONFIG_INPUT_IQS9151_SCROLL_INERTIA_DECAY,  \
      0, 1000, IQS9151_PARAM_DRIVER, 0)                                                         \
    X(scroll_inertia_recent_window_ms, "scroll_inertia_recent_window_ms",                       \
      CONFIG_INPUT_IQS9151_SCROLL_INERTIA_RECENT_WINDOW_MS, 1, 500, IQS9151_PARAM_DRIVER, 0)    \
    X(scroll_inertia_stale_gap_ms, "scroll_inertia_stale_gap_ms",                               \
      CONFIG_INPUT_IQS9151_SCROLL_INERTIA_STALE_GAP_MS, 1, 500, IQS9151_PARAM_DRIVER, 0)        \
    X(scroll_inertia_min_samples, "scroll_inertia_min_samples",                                 \
      CONFIG_INPUT_IQS9151_SCROLL_INERTIA_MIN_SAMPLES, 1, 12, IQS9151_PARAM_DRIVER, 0)          \
    X(scroll_inertia_min_avg_speed, "scroll_inertia_min_avg_speed",                             \
      CONFIG_INPUT_IQS9151_SCROLL_INERTIA_MIN_AVG_SPEED, 1, 500, IQS9151_PARAM_DRIVER, 0)

#define IQS9151_PARAM_IC_COUNT 16

struct iqs9151_params {
#define IQS9151_PARAM_FIELD(field, name, def, min, max, kind, reg) int32_t field;
    IQS9151_PARAM_LIST(IQS9151_PARAM_FIELD)
#undef IQS9151_PARAM_FIELD
};

struct iqs9151_param_def {
    const char *name;
    uint16_t offset;
    int32_t min;
    int32_t max;
    int32_t def;
    enum iqs9151_param_kind kind;
    uint16_t reg;
};

/* デバイス非依存の純粋ロジック(iqs9151_params.c) */
size_t iqs9151_param_count(void);
const struct iqs9151_param_def *iqs9151_param_def_at(size_t idx);
const struct iqs9151_param_def *iqs9151_param_find(const char *name);
bool iqs9151_param_is_ic(const struct iqs9151_param_def *def);
const char *iqs9151_param_kind_str(enum iqs9151_param_kind kind);
void iqs9151_params_init(struct iqs9151_params *p);
int iqs9151_params_set(struct iqs9151_params *p, const struct iqs9151_param_def *def,
                       int32_t value);
int32_t iqs9151_params_get(const struct iqs9151_params *p,
                           const struct iqs9151_param_def *def);

/* デバイス API(iqs9151.c)。Task 3〜5 で実装する */
int iqs9151_dev_param_set(const struct device *dev, const char *name, int32_t value);
int iqs9151_dev_param_get(const struct device *dev, const char *name, int32_t *value);
int iqs9151_dev_param_reset(const struct device *dev);
int iqs9151_dev_request_reati(const struct device *dev);
void iqs9151_dev_trace_enable(bool enable);
bool iqs9151_dev_trace_enabled(void);

#endif /* ZEPHYR_DRIVERS_INPUT_IQS9151_PARAMS_H_ */
```

- [ ] **Step 2: テストを書く(先に失敗させる)**

`$DRV/tests/iqs9151_params/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(iqs9151_params_test)

target_sources(app PRIVATE
    src/main.c
    ../../drivers/input/iqs9151_params.c
)

target_include_directories(app PRIVATE
    ../../drivers/input
)

target_compile_definitions(app PRIVATE
    CONFIG_INPUT_IQS9151_TOUCH_SET_THRESHOLD=30
    CONFIG_INPUT_IQS9151_TOUCH_CLEAR_THRESHOLD=26
    CONFIG_INPUT_IQS9151_ALP_SET_DEBOUNCE=2
    CONFIG_INPUT_IQS9151_ALP_CLEAR_DEBOUNCE=2
    CONFIG_INPUT_IQS9151_STATIONARY_TOUCH_MOV_THRESHOLD=5
    CONFIG_INPUT_IQS9151_JITTER_FILTER_DELTA=2
    CONFIG_INPUT_IQS9151_FINGER_CONFIDENCE_THRESHOLD=20
    CONFIG_INPUT_IQS9151_DYNAMIC_FILTER_BOTTOM_BETA=10
    CONFIG_INPUT_IQS9151_ACTIVE_MODE_SAMPLING_PERIOD_MS=10
    CONFIG_INPUT_IQS9151_IDLE_TOUCH_MODE_SAMPLING_PERIOD_MS=50
    CONFIG_INPUT_IQS9151_IDLE_MODE_SAMPLING_PERIOD_MS=50
    CONFIG_INPUT_IQS9151_LP1_MODE_SAMPLING_PERIOD_MS=50
    CONFIG_INPUT_IQS9151_LP2_MODE_SAMPLING_PERIOD_MS=50
    CONFIG_INPUT_IQS9151_ACTIVE_MODE_TIMEOUT_MS=1500
    CONFIG_INPUT_IQS9151_ATI_TARGETCOUNT=400
    CONFIG_INPUT_IQS9151_DYNAMIC_FILTER_BOTTOM_SPEED=20
    CONFIG_INPUT_IQS9151_DYNAMIC_FILTER_TOP_SPEED=511
    CONFIG_INPUT_IQS9151_1F_TAP_ENABLE=1
    CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS=120
    CONFIG_INPUT_IQS9151_1F_TAP_MOVE=25
    CONFIG_INPUT_IQS9151_1F_PRESSHOLD_ENABLE=1
    CONFIG_INPUT_IQS9151_1F_TAPDRAG_GAP_MAX_MS=230
    CONFIG_INPUT_IQS9151_2F_TAP_ENABLE=1
    CONFIG_INPUT_IQS9151_2F_TAP_MAX_MS=130
    CONFIG_INPUT_IQS9151_2F_TAP_MOVE=30
    CONFIG_INPUT_IQS9151_2F_PRESSHOLD_ENABLE=1
    CONFIG_INPUT_IQS9151_2F_TAPDRAG_GAP_MAX_MS=200
    CONFIG_INPUT_IQS9151_SCROLL_X_ENABLE=1
    CONFIG_INPUT_IQS9151_SCROLL_Y_ENABLE=1
    CONFIG_INPUT_IQS9151_2F_SCROLL_START_MOVE=50
    CONFIG_INPUT_IQS9151_2F_PINCH_ENABLE=1
    CONFIG_INPUT_IQS9151_2F_PINCH_START_DISTANCE=80
    CONFIG_INPUT_IQS9151_2F_PINCH_WHEEL_GAIN_X10=40
    CONFIG_INPUT_IQS9151_3F_TAP_ENABLE=1
    CONFIG_INPUT_IQS9151_3F_TAP_MAX_MS=180
    CONFIG_INPUT_IQS9151_3F_TAP_MOVE=30
    CONFIG_INPUT_IQS9151_3F_PRESSHOLD_ENABLE=1
    CONFIG_INPUT_IQS9151_3F_TAPDRAG_GAP_MAX_MS=230
    CONFIG_INPUT_IQS9151_3F_SWIPE_THRESHOLD=300
    CONFIG_INPUT_IQS9151_CURSOR_INERTIA_DECAY=970
    CONFIG_INPUT_IQS9151_CURSOR_INERTIA_RECENT_WINDOW_MS=60
    CONFIG_INPUT_IQS9151_CURSOR_INERTIA_STALE_GAP_MS=35
    CONFIG_INPUT_IQS9151_CURSOR_INERTIA_MIN_SAMPLES=2
    CONFIG_INPUT_IQS9151_CURSOR_INERTIA_MIN_AVG_SPEED=10
    CONFIG_INPUT_IQS9151_SCROLL_INERTIA_ENABLE=1
    CONFIG_INPUT_IQS9151_SCROLL_INERTIA_DECAY=985
    CONFIG_INPUT_IQS9151_SCROLL_INERTIA_RECENT_WINDOW_MS=60
    CONFIG_INPUT_IQS9151_SCROLL_INERTIA_STALE_GAP_MS=35
    CONFIG_INPUT_IQS9151_SCROLL_INERTIA_MIN_SAMPLES=1
    CONFIG_INPUT_IQS9151_SCROLL_INERTIA_MIN_AVG_SPEED=4
)
```

`CONFIG_INPUT_IQS9151_CURSOR_INERTIA_ENABLE` はわざと定義しない(未定義 bool の既定値が 0 になることを検証する)。

`$DRV/tests/iqs9151_params/prj.conf`:

```
CONFIG_ZTEST=y
CONFIG_ZTEST_NEW_API=y
```

`$DRV/tests/iqs9151_params/testcase.yaml`:

```yaml
tests:
  iqs9151.params:
    tags:
      - iqs9151
      - input
    platform_allow:
      - native_sim
      - native_sim_64
```

`$DRV/tests/iqs9151_params/src/main.c`:

```c
#include <zephyr/ztest.h>

#include "iqs9151_params.h"

#include <errno.h>
#include <string.h>

ZTEST_SUITE(iqs9151_params, NULL, NULL, NULL, NULL, NULL);

ZTEST(iqs9151_params, test_定義テーブルは50個でIC系16個が先頭にある) {
    zassert_equal(iqs9151_param_count(), 50U, "count=%u",
                  (unsigned int)iqs9151_param_count());
    for (size_t i = 0; i < iqs9151_param_count(); i++) {
        const struct iqs9151_param_def *def = iqs9151_param_def_at(i);

        zassert_equal(iqs9151_param_is_ic(def), i < IQS9151_PARAM_IC_COUNT,
                      "%s の種別が位置と合わない", def->name);
    }
}

ZTEST(iqs9151_params, test_初期化するとKconfigの値が入る) {
    struct iqs9151_params p;

    memset(&p, 0xff, sizeof(p));
    iqs9151_params_init(&p);

    zassert_equal(p.f1_tap_max_ms, 120, NULL);
    zassert_equal(p.touch_set_threshold, 30, NULL);
    zassert_equal(p.scroll_inertia_enable, 1, NULL);
    zassert_equal(p.cursor_inertia_enable, 0, "未定義の bool は 0 になる");
}

ZTEST(iqs9151_params, test_名前で検索できて未知の名前はNULLになる) {
    const struct iqs9151_param_def *def = iqs9151_param_find("1f_tap_max_ms");

    zassert_not_null(def, NULL);
    zassert_equal(def->kind, IQS9151_PARAM_DRIVER, NULL);
    zassert_equal(def->min, 1, NULL);
    zassert_equal(def->max, 1000, NULL);
    zassert_equal(def->def, 120, NULL);
    zassert_is_null(iqs9151_param_find("no_such_param"), NULL);
}

ZTEST(iqs9151_params, test_範囲内の値をsetするとgetで返り範囲外はERANGEになる) {
    struct iqs9151_params p;
    const struct iqs9151_param_def *def = iqs9151_param_find("1f_tap_max_ms");

    iqs9151_params_init(&p);
    zassert_equal(iqs9151_params_set(&p, def, 1000), 0, NULL);
    zassert_equal(iqs9151_params_get(&p, def), 1000, NULL);
    zassert_equal(p.f1_tap_max_ms, 1000, NULL);
    zassert_equal(iqs9151_params_set(&p, def, 1001), -ERANGE, NULL);
    zassert_equal(iqs9151_params_set(&p, def, 0), -ERANGE, NULL);
    zassert_equal(p.f1_tap_max_ms, 1000, "範囲外のときは値が変わらない");
}

ZTEST(iqs9151_params, test_IC系の定義にはレジスタアドレスが入っている) {
    const struct iqs9151_param_def *def = iqs9151_param_find("touch_set_threshold");

    zassert_equal(def->kind, IQS9151_PARAM_IC_U8, NULL);
    zassert_equal(def->reg, 0x11CC, NULL);
    zassert_equal(iqs9151_param_find("ati_targetcount")->reg, 0x1196, NULL);
    zassert_equal(iqs9151_param_find("ati_targetcount")->kind, IQS9151_PARAM_IC_U16, NULL);
}

ZTEST(iqs9151_params, test_種別文字列はシェル用の固定文字列になる) {
    zassert_str_equal(iqs9151_param_kind_str(IQS9151_PARAM_IC_U8), "ic_u8");
    zassert_str_equal(iqs9151_param_kind_str(IQS9151_PARAM_IC_U16), "ic_u16");
    zassert_str_equal(iqs9151_param_kind_str(IQS9151_PARAM_DRIVER), "driver");
    zassert_str_equal(iqs9151_param_kind_str(IQS9151_PARAM_DRIVER_BOOL), "driver_bool");
}
```

- [ ] **Step 3: テストが失敗(リンクエラー)することを確認**

`iqs9151_params.c` が無い状態で push して CI を見る、または `tests/run.sh iqs9151_params` を実行する。

Expected: `iqs9151_params.c` が見つからず CMake または リンクで失敗する。

- [ ] **Step 4: 実装を書く**

`$DRV/drivers/input/iqs9151_params.c`:

```c
#include "iqs9151_params.h"

#include <errno.h>
#include <string.h>

static const struct iqs9151_param_def iqs9151_param_table[] = {
#define IQS9151_PARAM_ENTRY(field, pname, pdef, pmin, pmax, pkind, preg)                      \
    {                                                                                       \
        .name = pname,                                                                      \
        .offset = offsetof(struct iqs9151_params, field),                                   \
        .min = pmin,                                                                        \
        .max = pmax,                                                                        \
        .def = pdef,                                                                        \
        .kind = pkind,                                                                      \
        .reg = preg,                                                                        \
    },
    IQS9151_PARAM_LIST(IQS9151_PARAM_ENTRY)
#undef IQS9151_PARAM_ENTRY
};

size_t iqs9151_param_count(void) {
    return ARRAY_SIZE(iqs9151_param_table);
}

const struct iqs9151_param_def *iqs9151_param_def_at(size_t idx) {
    if (idx >= ARRAY_SIZE(iqs9151_param_table)) {
        return NULL;
    }
    return &iqs9151_param_table[idx];
}

const struct iqs9151_param_def *iqs9151_param_find(const char *name) {
    for (size_t i = 0; i < ARRAY_SIZE(iqs9151_param_table); i++) {
        if (strcmp(iqs9151_param_table[i].name, name) == 0) {
            return &iqs9151_param_table[i];
        }
    }
    return NULL;
}

bool iqs9151_param_is_ic(const struct iqs9151_param_def *def) {
    return def->kind == IQS9151_PARAM_IC_U8 || def->kind == IQS9151_PARAM_IC_U16;
}

const char *iqs9151_param_kind_str(enum iqs9151_param_kind kind) {
    switch (kind) {
    case IQS9151_PARAM_IC_U8:
        return "ic_u8";
    case IQS9151_PARAM_IC_U16:
        return "ic_u16";
    case IQS9151_PARAM_DRIVER:
        return "driver";
    case IQS9151_PARAM_DRIVER_BOOL:
        return "driver_bool";
    default:
        return "unknown";
    }
}

static int32_t *iqs9151_param_slot(struct iqs9151_params *p,
                                   const struct iqs9151_param_def *def) {
    return (int32_t *)((uint8_t *)p + def->offset);
}

void iqs9151_params_init(struct iqs9151_params *p) {
    for (size_t i = 0; i < ARRAY_SIZE(iqs9151_param_table); i++) {
        *iqs9151_param_slot(p, &iqs9151_param_table[i]) = iqs9151_param_table[i].def;
    }
}

int iqs9151_params_set(struct iqs9151_params *p, const struct iqs9151_param_def *def,
                       int32_t value) {
    if (value < def->min || value > def->max) {
        return -ERANGE;
    }
    *iqs9151_param_slot(p, def) = value;
    return 0;
}

int32_t iqs9151_params_get(const struct iqs9151_params *p,
                           const struct iqs9151_param_def *def) {
    return *iqs9151_param_slot((struct iqs9151_params *)p, def);
}
```

`$DRV/drivers/input/CMakeLists.txt` を次にする:

```cmake
zephyr_library_amend()

zephyr_library_sources_ifdef(CONFIG_INPUT_IQS9151 iqs9151.c)
zephyr_library_sources_ifdef(CONFIG_INPUT_IQS9151 iqs9151_params.c)
```

- [ ] **Step 5: テストが通ることを確認**

```bash
git -C $DRV add drivers/input/iqs9151_params.h drivers/input/iqs9151_params.c drivers/input/CMakeLists.txt tests/iqs9151_params
git -C $DRV commit -m "$(cat <<'EOF'
ランタイム変更用のパラメータ定義テーブルを追加

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $DRV push
gh run watch --repo applepine1125/zmk-driver-iqs9151 --exit-status $(gh run list --repo applepine1125/zmk-driver-iqs9151 --branch runtime-tuning --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: `iqs9151_params` と `iqs9151_work_cb` の両方が `PROJECT EXECUTION SUCCESSFUL`。

---

### Task 3: ドライバ本体をパラメータ構造体参照に切り替える(挙動不変)

**Files:**
- Modify: `$DRV/drivers/input/iqs9151.c`(マクロ定義 39-83 行、慣性パラメータ 497-528 行、各 update 関数、init、テストフック)
- Modify: `$DRV/drivers/input/iqs9151_test.h`
- Modify: `$DRV/tests/iqs9151_work_cb/CMakeLists.txt`、`src/main.c`

**Interfaces:**
- Consumes: Task 2 の `struct iqs9151_params`、`iqs9151_params_init`、`iqs9151_params_set`、`iqs9151_param_find`
- Produces:
  - `struct iqs9151_data` に `struct iqs9151_params params;` と `struct iqs9151_inertia_params scroll_params, cursor_params;` `struct iqs9151_inertia_gate_params scroll_gate, cursor_gate;`
  - `static void iqs9151_sync_inertia_params(struct iqs9151_data *data)`
  - テストフック `struct iqs9151_params *iqs9151_test_params(void *ctx)` と `void iqs9151_test_sync_params(void *ctx)`

- [ ] **Step 1: ランタイム変更が効くことを検証するテストを追加(先に失敗させる)**

`$DRV/tests/iqs9151_work_cb/CMakeLists.txt` の `target_sources` に `../../drivers/input/iqs9151_params.c` を追加する:

```cmake
target_sources(app PRIVATE
    src/main.c
    ../../drivers/input/iqs9151.c
    ../../drivers/input/iqs9151_params.c
)
```

`$DRV/tests/iqs9151_work_cb/src/main.c` の末尾に追加する。既存テストの `make_frame` と `fixture` を使う(1F タップは「指 1 本が `CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS`=120ms 以内に離れる」と BTN_0 の press が出る。既存の 1F タップテストがどう組み立てているかを `grep -n 'one_finger_tap' src/main.c` で確認し、同じフレーム列を使うこと):

```c
ZTEST_F(iqs9151_work_cb, test_1f_tap_max_msを50に下げると100msのタップがタップにならない) {
    struct iqs9151_params *params = iqs9151_test_params(fixture->ctx);
    const struct iqs9151_param_def *def = iqs9151_param_find("1f_tap_max_ms");
    const struct iqs9151_test_frame down =
        make_frame(1U, IQS9151_TP_FINGER1_CONFIDENCE | 1U, 0, 0, 0, 1000, 1000, 0, 0);
    const struct iqs9151_test_frame up = make_frame(0U, 0U, 0, 0, 0, 0, 0, 0, 0);

    zassert_equal(iqs9151_params_set(params, def, 50), 0, NULL);
    iqs9151_test_sync_params(fixture->ctx);

    iqs9151_test_process_frame(fixture->ctx, &down, 0);
    iqs9151_test_process_frame(fixture->ctx, &up, 100);

    zassert_equal(fixture->log.count, 0U, "100ms のタップはタップ判定されない(events=%u)",
                  (unsigned int)fixture->log.count);
}

ZTEST_F(iqs9151_work_cb, test_既定値のままなら100msのタップでBTN0が押される) {
    const struct iqs9151_test_frame down =
        make_frame(1U, IQS9151_TP_FINGER1_CONFIDENCE | 1U, 0, 0, 0, 1000, 1000, 0, 0);
    const struct iqs9151_test_frame up = make_frame(0U, 0U, 0, 0, 0, 0, 0, 0, 0);

    iqs9151_test_process_frame(fixture->ctx, &down, 0);
    iqs9151_test_process_frame(fixture->ctx, &up, 100);

    zassert_true(fixture->log.count >= 1U, "タップで press が出る");
    zassert_equal(fixture->log.events[0].type, IQS9151_TEST_EVENT_KEY, NULL);
    zassert_equal(fixture->log.events[0].code, INPUT_BTN_0, NULL);
    zassert_equal(fixture->log.events[0].value, 1, NULL);
}
```

`main.c` 先頭の include に `#include "iqs9151_params.h"` を足す。

`$DRV/drivers/input/iqs9151_test.h` の `#ifdef CONFIG_INPUT_IQS9151_TEST` ブロックに追加:

```c
struct iqs9151_params *iqs9151_test_params(void *ctx);
void iqs9151_test_sync_params(void *ctx);
```

(`iqs9151_test.h` の先頭に `#include "iqs9151_params.h"` を追加する)

- [ ] **Step 2: 失敗を確認**

push して CI、または `tests/run.sh iqs9151_work_cb`。

Expected: `iqs9151_test_params` 未定義でリンク失敗。

- [ ] **Step 3: `iqs9151.c` を書き換える**

3-a. include に `#include "iqs9151_params.h"` を追加。

3-b. 39-83 行のうち、以下のマクロ定義行を**削除**する(他の定数マクロは残す):
`SCROLL_INERTIA_DECAY_NUM`, `SCROLL_INERTIA_RECENT_WINDOW_MS`, `SCROLL_INERTIA_STALE_GAP_MS`, `SCROLL_INERTIA_MIN_SAMPLES`, `SCROLL_INERTIA_MIN_AVG_SPEED`, `CURSOR_INERTIA_DECAY_NUM`, `CURSOR_INERTIA_RECENT_WINDOW_MS`, `CURSOR_INERTIA_STALE_GAP_MS`, `CURSOR_INERTIA_MIN_SAMPLES`, `CURSOR_INERTIA_MIN_AVG_SPEED`, `ONE_FINGER_TAP_MAX_MS`, `TWO_FINGER_TAP_MAX_MS`, `ONE_FINGER_TAPDRAG_GAP_MAX_MS`, `ONE_FINGER_CLICK_HOLD_MAX_MS`, `TWO_FINGER_TAPDRAG_GAP_MAX_MS`, `TWO_FINGER_CLICK_HOLD_MAX_MS`, `THREE_FINGER_TAPDRAG_GAP_MAX_MS`, `THREE_FINGER_CLICK_HOLD_MAX_MS`, `THREE_FINGER_TAP_MAX_MS`, `THREE_FINGER_TAP_MOVE`, `ONE_FINGER_TAP_MOVE`, `TWO_FINGER_TAP_MOVE`, `TWO_FINGER_SCROLL_START_MOVE`, `TWO_FINGER_PINCH_START_DISTANCE`, `TWO_FINGER_PINCH_WHEEL_GAIN_X10`

3-c. `struct iqs9151_data` に追加:

```c
    struct iqs9151_params params;
    struct iqs9151_inertia_params scroll_params;
    struct iqs9151_inertia_gate_params scroll_gate;
    struct iqs9151_inertia_params cursor_params;
    struct iqs9151_inertia_gate_params cursor_gate;
```

3-d. 497-528 行の `static const` 4 つを削除し、代わりにこの関数を置く:

```c
static void iqs9151_sync_inertia_params(struct iqs9151_data *data) {
    const struct iqs9151_params *p = &data->params;

    data->scroll_params = (struct iqs9151_inertia_params){
        .interval_ms = SCROLL_INERTIA_INTERVAL_MS,
        .max_duration_ms = SCROLL_INERTIA_MAX_DURATION_MS,
        .decay_num = (uint16_t)p->scroll_inertia_decay,
        .decay_den = SCROLL_INERTIA_DECAY_DEN,
        .fp_shift = INERTIA_FP_SHIFT,
        .start_threshold = SCROLL_INERTIA_START_THRESHOLD,
        .min_velocity = SCROLL_INERTIA_MIN_VELOCITY,
        .ema_alpha = SCROLL_EMA_ALPHA,
    };
    data->scroll_gate = (struct iqs9151_inertia_gate_params){
        .recent_window_ms = (uint16_t)p->scroll_inertia_recent_window_ms,
        .stale_gap_ms = (uint16_t)p->scroll_inertia_stale_gap_ms,
        .min_samples = (uint8_t)p->scroll_inertia_min_samples,
        .min_avg_speed = (int16_t)p->scroll_inertia_min_avg_speed,
    };
    data->cursor_params = (struct iqs9151_inertia_params){
        .interval_ms = CURSOR_INERTIA_INTERVAL_MS,
        .max_duration_ms = CURSOR_INERTIA_MAX_DURATION_MS,
        .decay_num = (uint16_t)p->cursor_inertia_decay,
        .decay_den = CURSOR_INERTIA_DECAY_DEN,
        .fp_shift = INERTIA_FP_SHIFT,
        .start_threshold = CURSOR_INERTIA_START_THRESHOLD,
        .min_velocity = CURSOR_INERTIA_MIN_VELOCITY,
        .ema_alpha = CURSOR_EMA_ALPHA,
    };
    data->cursor_gate = (struct iqs9151_inertia_gate_params){
        .recent_window_ms = (uint16_t)p->cursor_inertia_recent_window_ms,
        .stale_gap_ms = (uint16_t)p->cursor_inertia_stale_gap_ms,
        .min_samples = (uint8_t)p->cursor_inertia_min_samples,
        .min_avg_speed = (int16_t)p->cursor_inertia_min_avg_speed,
    };
}
```

3-e. 慣性パラメータの参照(1798, 1822, 1855, 1879, 2124, 2141, 2151-2155, 2165-2169 行)を置き換える:
`iqs9151_scroll_params` → `data->scroll_params`、`iqs9151_scroll_gate_params` → `data->scroll_gate`、`iqs9151_cursor_params` → `data->cursor_params`、`iqs9151_cursor_gate_params` → `data->cursor_gate`(`&iqs9151_scroll_params` は `&data->scroll_params`)。

3-f. 削除したマクロの参照を置き換える。該当関数(`iqs9151_one_finger_update`, `iqs9151_two_finger_update`, `iqs9151_three_finger_update`, `iqs9151_update_gesture_sessions`)はいずれも `struct iqs9151_data *data` を引数に持つので、各関数の先頭に `const struct iqs9151_params *p = &data->params;` を置き、次の対応で置換する:

| 旧 | 新 |
| --- | --- |
| `ONE_FINGER_TAP_MAX_MS` | `p->f1_tap_max_ms` |
| `ONE_FINGER_TAP_MOVE` | `p->f1_tap_move` |
| `ONE_FINGER_CLICK_HOLD_MAX_MS`, `ONE_FINGER_TAPDRAG_GAP_MAX_MS` | `p->f1_tapdrag_gap_max_ms` |
| `TWO_FINGER_TAP_MAX_MS` | `p->f2_tap_max_ms` |
| `TWO_FINGER_TAP_MOVE` | `p->f2_tap_move` |
| `TWO_FINGER_CLICK_HOLD_MAX_MS`, `TWO_FINGER_TAPDRAG_GAP_MAX_MS` | `p->f2_tapdrag_gap_max_ms` |
| `TWO_FINGER_SCROLL_START_MOVE` | `p->f2_scroll_start_move` |
| `TWO_FINGER_PINCH_START_DISTANCE` | `p->f2_pinch_start_distance` |
| `TWO_FINGER_PINCH_WHEEL_GAIN_X10` | `p->f2_pinch_wheel_gain_x10` |
| `THREE_FINGER_TAP_MAX_MS` | `p->f3_tap_max_ms` |
| `THREE_FINGER_TAP_MOVE` | `p->f3_tap_move` |
| `THREE_FINGER_CLICK_HOLD_MAX_MS`, `THREE_FINGER_TAPDRAG_GAP_MAX_MS` | `p->f3_tapdrag_gap_max_ms` |
| `CONFIG_INPUT_IQS9151_3F_SWIPE_THRESHOLD` | `p->f3_swipe_threshold` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_1F_TAP_ENABLE)` | `(p->f1_tap_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_1F_PRESSHOLD_ENABLE)` | `(p->f1_presshold_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_2F_TAP_ENABLE)` | `(p->f2_tap_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_2F_PRESSHOLD_ENABLE)` | `(p->f2_presshold_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_SCROLL_X_ENABLE)` | `(p->scroll_x_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_SCROLL_Y_ENABLE)` | `(p->scroll_y_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_2F_PINCH_ENABLE)` | `(p->f2_pinch_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_3F_TAP_ENABLE)` | `(p->f3_tap_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_3F_PRESSHOLD_ENABLE)` | `(p->f3_presshold_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_CURSOR_INERTIA_ENABLE)`(`iqs9151_update_inertia_ema` 内) | `(data->params.cursor_inertia_enable != 0)` |
| `IS_ENABLED(CONFIG_INPUT_IQS9151_SCROLL_INERTIA_ENABLE)`(同上) | `(data->params.scroll_inertia_enable != 0)` |

`K_MSEC(ONE_FINGER_CLICK_HOLD_MAX_MS)` のような箇所は `K_MSEC(p->f1_tapdrag_gap_max_ms)` になる。置換後に `grep -n 'CONFIG_INPUT_IQS9151_\(1F\|2F\|3F\|SCROLL\|CURSOR\)' drivers/input/iqs9151.c` を実行し、`LOG_MODULE_REGISTER` 以外で残っていないことを確認する。

3-g. `iqs9151_init` の先頭(`data->dev = dev;` の直後)と `iqs9151_test_context_init` の `data->dev = dev;` の直後に追加:

```c
    iqs9151_params_init(&data->params);
    iqs9151_sync_inertia_params(data);
```

3-h. `CONFIG_INPUT_IQS9151_TEST` ブロック内にフックを追加:

```c
struct iqs9151_params *iqs9151_test_params(void *ctx) {
    struct iqs9151_data *data = (struct iqs9151_data *)ctx;

    return &data->params;
}

void iqs9151_test_sync_params(void *ctx) {
    iqs9151_sync_inertia_params((struct iqs9151_data *)ctx);
}
```

3-i. `iqs9151_apply_kconfig_overrides` と `iqs9151_apply_sensitivity_overrides`(sensitivity ブランチ由来)の IC 書き込みは、この Task では触らない(Task 4 でテーブル駆動に置き換える)。

- [ ] **Step 4: テストが通ることを確認**

```bash
git -C $DRV add -A drivers/input tests/iqs9151_work_cb
git -C $DRV commit -m "$(cat <<'EOF'
ジェスチャ判定値と慣性パラメータをランタイムの構造体から参照する

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $DRV push
gh run watch --repo applepine1125/zmk-driver-iqs9151 --exit-status $(gh run list --repo applepine1125/zmk-driver-iqs9151 --branch runtime-tuning --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: 既存テスト全件 + 新規 2 件が PASS。`fixture.ctx` のサイズ上限 `IQS9151_TEST_CTX_BUF_SIZE`(1536)を超えた場合は `main.c` の値を 2048 に上げる。

---

### Task 4: デバイス API(set/get/reset/reati)と IC 書き込みの保留・適用

**Files:**
- Modify: `$DRV/drivers/input/iqs9151.c`
- Modify: `$DRV/drivers/input/iqs9151_test.h`
- Modify: `$DRV/tests/iqs9151_work_cb/src/main.c`

**Interfaces:**
- Consumes: Task 2 の定義テーブル API、Task 3 の `data->params` と `iqs9151_sync_inertia_params`
- Produces(ヘッダは Task 2 で宣言済み):
  - `int iqs9151_dev_param_set(const struct device *dev, const char *name, int32_t value)` … `-ENOENT`(未知の名前)/`-ERANGE`/0。IC 系は保留ビットを立てる
  - `int iqs9151_dev_param_get(const struct device *dev, const char *name, int32_t *value)`
  - `int iqs9151_dev_param_reset(const struct device *dev)` … 全既定値 + IC 系全保留
  - `int iqs9151_dev_request_reati(const struct device *dev)`
  - `struct iqs9151_data` に `atomic_t ic_dirty;` `atomic_t reati_pending;`
  - テストフック `uint32_t iqs9151_test_ic_dirty(const void *ctx)`, `bool iqs9151_test_reati_pending(const void *ctx)`, `const struct device *iqs9151_test_fake_dev(void *ctx)`

- [ ] **Step 1: テストを書く**

`iqs9151_test.h` の TEST ブロックに追加:

```c
uint32_t iqs9151_test_ic_dirty(const void *ctx);
bool iqs9151_test_reati_pending(const void *ctx);
const struct device *iqs9151_test_fake_dev(void *ctx);
```

`iqs9151_test_fake_dev` は `dev->data == ctx` となる `struct device` をテスト用に返す(ドライバ側で static な `struct device` を 1 つ持ち、`data` を差し替える)。

`tests/iqs9151_work_cb/src/main.c` に追加:

```c
ZTEST_F(iqs9151_work_cb, test_driver系をsetすると即座に値が変わり保留ビットは立たない) {
    const struct device *dev = iqs9151_test_fake_dev(fixture->ctx);
    int32_t value = 0;

    zassert_equal(iqs9151_dev_param_set(dev, "2f_scroll_start_move", 15), 0, NULL);
    zassert_equal(iqs9151_dev_param_get(dev, "2f_scroll_start_move", &value), 0, NULL);
    zassert_equal(value, 15, NULL);
    zassert_equal(iqs9151_test_ic_dirty(fixture->ctx), 0U, NULL);
}

ZTEST_F(iqs9151_work_cb, test_慣性系をsetすると慣性パラメータにも反映される) {
    const struct device *dev = iqs9151_test_fake_dev(fixture->ctx);

    zassert_equal(iqs9151_dev_param_set(dev, "scroll_inertia_decay", 900), 0, NULL);
    zassert_equal(iqs9151_test_scroll_inertia_decay(fixture->ctx), 900, NULL);
}

ZTEST_F(iqs9151_work_cb, test_IC系をsetすると保留ビットが立つ) {
    const struct device *dev = iqs9151_test_fake_dev(fixture->ctx);
    const struct iqs9151_param_def *def = iqs9151_param_find("touch_set_threshold");
    size_t idx = 0;

    while (iqs9151_param_def_at(idx) != def) {
        idx++;
    }
    zassert_equal(iqs9151_dev_param_set(dev, "touch_set_threshold", 40), 0, NULL);
    zassert_equal(iqs9151_test_ic_dirty(fixture->ctx), BIT(idx), NULL);
}

ZTEST_F(iqs9151_work_cb, test_未知の名前と範囲外はエラーになる) {
    const struct device *dev = iqs9151_test_fake_dev(fixture->ctx);

    zassert_equal(iqs9151_dev_param_set(dev, "no_such", 1), -ENOENT, NULL);
    zassert_equal(iqs9151_dev_param_set(dev, "1f_tap_max_ms", 5000), -ERANGE, NULL);
}

ZTEST_F(iqs9151_work_cb, test_resetすると既定値に戻りIC系がすべて保留になる) {
    const struct device *dev = iqs9151_test_fake_dev(fixture->ctx);
    int32_t value = 0;

    zassert_equal(iqs9151_dev_param_set(dev, "1f_tap_max_ms", 500), 0, NULL);
    zassert_equal(iqs9151_dev_param_reset(dev), 0, NULL);
    zassert_equal(iqs9151_dev_param_get(dev, "1f_tap_max_ms", &value), 0, NULL);
    zassert_equal(value, CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS, NULL);
    zassert_equal(iqs9151_test_ic_dirty(fixture->ctx), BIT_MASK(IQS9151_PARAM_IC_COUNT), NULL);
}

ZTEST_F(iqs9151_work_cb, test_reatiを要求すると保留フラグが立つ) {
    const struct device *dev = iqs9151_test_fake_dev(fixture->ctx);

    zassert_false(iqs9151_test_reati_pending(fixture->ctx), NULL);
    zassert_equal(iqs9151_dev_request_reati(dev), 0, NULL);
    zassert_true(iqs9151_test_reati_pending(fixture->ctx), NULL);
}
```

`iqs9151_test_scroll_inertia_decay` もフックとして追加する(`iqs9151_test.h` に `uint16_t iqs9151_test_scroll_inertia_decay(const void *ctx);`、実装は `data->scroll_params.decay_num` を返す)。`main.c` に `#include <errno.h>` を足す。

- [ ] **Step 2: 失敗を確認**

Expected: 未定義シンボルでリンク失敗。

- [ ] **Step 3: 実装**

3-a. `iqs9151.c` の include に `#include <zephyr/sys/atomic.h>` を追加。`struct iqs9151_data` に追加:

```c
    atomic_t ic_dirty;
    atomic_t reati_pending;
```

3-b. デバイス API を `iqs9151_init` の前に追加:

```c
static void iqs9151_mark_ic_dirty(struct iqs9151_data *data,
                                  const struct iqs9151_param_def *def) {
    for (size_t i = 0; i < IQS9151_PARAM_IC_COUNT; i++) {
        if (iqs9151_param_def_at(i) == def) {
            atomic_or(&data->ic_dirty, BIT(i));
            return;
        }
    }
}

int iqs9151_dev_param_set(const struct device *dev, const char *name, int32_t value) {
    struct iqs9151_data *data = dev->data;
    const struct iqs9151_param_def *def = iqs9151_param_find(name);
    int ret;

    if (def == NULL) {
        return -ENOENT;
    }
    ret = iqs9151_params_set(&data->params, def, value);
    if (ret != 0) {
        return ret;
    }
    if (iqs9151_param_is_ic(def)) {
        iqs9151_mark_ic_dirty(data, def);
    } else {
        iqs9151_sync_inertia_params(data);
    }
    return 0;
}

int iqs9151_dev_param_get(const struct device *dev, const char *name, int32_t *value) {
    struct iqs9151_data *data = dev->data;
    const struct iqs9151_param_def *def = iqs9151_param_find(name);

    if (def == NULL) {
        return -ENOENT;
    }
    *value = iqs9151_params_get(&data->params, def);
    return 0;
}

int iqs9151_dev_param_reset(const struct device *dev) {
    struct iqs9151_data *data = dev->data;

    iqs9151_params_init(&data->params);
    iqs9151_sync_inertia_params(data);
    atomic_or(&data->ic_dirty, BIT_MASK(IQS9151_PARAM_IC_COUNT));
    return 0;
}

int iqs9151_dev_request_reati(const struct device *dev) {
    struct iqs9151_data *data = dev->data;

    atomic_set(&data->reati_pending, 1);
    return 0;
}
```

3-c. IC 書き込みの実体(1 パラメータ)と保留の適用。`iqs9151_write_u16` の後ろに追加:

```c
static int iqs9151_write_ic_param(const struct iqs9151_config *cfg,
                                  const struct iqs9151_params *params,
                                  const struct iqs9151_param_def *def) {
    const int32_t value = iqs9151_params_get(params, def);

    if (def->kind == IQS9151_PARAM_IC_U16) {
        return iqs9151_write_u16(cfg, def->reg, (uint16_t)value);
    }
    return iqs9151_i2c_write(cfg, def->reg, (const uint8_t[]){(uint8_t)value}, 1);
}

static void iqs9151_apply_pending_ic(const struct device *dev) {
    struct iqs9151_data *data = dev->data;
    const struct iqs9151_config *cfg = dev->config;
    const uint32_t dirty = (uint32_t)atomic_clear(&data->ic_dirty);

    for (size_t i = 0; i < IQS9151_PARAM_IC_COUNT; i++) {
        if ((dirty & BIT(i)) == 0U) {
            continue;
        }
        const struct iqs9151_param_def *def = iqs9151_param_def_at(i);
        const int ret = iqs9151_write_ic_param(cfg, &data->params, def);

        if (ret != 0) {
            LOG_ERR("IC param %s write failed (%d)", def->name, ret);
        }
    }

    if (atomic_clear(&data->reati_pending) != 0) {
        const int ret = iqs9151_run_ati(cfg);

        if (ret != 0) {
            LOG_ERR("Re-ATI request failed (%d)", ret);
        }
    }
}
```

`iqs9151_run_ati` は `iqs9151_apply_pending_ic` より後ろで定義されているので、前方宣言 `static int iqs9151_run_ati(const struct iqs9151_config *config);` を `iqs9151_apply_pending_ic` の前に置く。

3-d. `iqs9151_work_cb` を次にする(フレーム読み出しの直後に適用):

```c
static void iqs9151_work_cb(struct k_work *work) {
    struct iqs9151_data *data = CONTAINER_OF(work, struct iqs9151_data, work);
    const struct device *dev = data->dev;
    const struct iqs9151_config *cfg = dev->config;
    struct iqs9151_frame frame;
    int ret;
    const int64_t now_ms = k_uptime_get();

    ret = iqs9151_read_frame(cfg, &frame);
    if (ret != 0) {
        LOG_ERR("frame read failed (%d)", ret);
        return;
    }

    iqs9151_apply_pending_ic(dev);
    iqs9151_process_frame(data, &frame, now_ms);
}
```

3-e. init 時の IC 書き込みをテーブル駆動にする。`iqs9151_apply_kconfig_overrides` のうち、回転(`IQS9151_ADDR_TRACKPAD_SETTINGS` の update_bits)と解像度(`X_RESOLUTION`/`Y_RESOLUTION`)の書き込みは残し、`ATI_TARGET`・`DYNAMIC_FILTER_*` の直書きと `iqs9151_apply_sensitivity_overrides` の呼び出し(および関数本体・`iqs9151_sensitivity_overrides` テーブル)を削除して、末尾に次を置く:

```c
    for (size_t i = 0; i < IQS9151_PARAM_IC_COUNT; i++) {
        const struct iqs9151_param_def *def = iqs9151_param_def_at(i);

        iqs9151_wait_for_ready(dev, 100);
        ret = iqs9151_write_ic_param(cfg, &data->params, def);
        if (ret != 0) {
            LOG_ERR("IC param %s init write failed (%d)", def->name, ret);
            return ret;
        }
    }
```

(`struct iqs9151_data *data = dev->data;` を関数先頭に追加する)

3-f. テストフックを追加:

```c
uint32_t iqs9151_test_ic_dirty(const void *ctx) {
    const struct iqs9151_data *data = (const struct iqs9151_data *)ctx;

    return (uint32_t)atomic_get(&data->ic_dirty);
}

bool iqs9151_test_reati_pending(const void *ctx) {
    const struct iqs9151_data *data = (const struct iqs9151_data *)ctx;

    return atomic_get(&data->reati_pending) != 0;
}

uint16_t iqs9151_test_scroll_inertia_decay(const void *ctx) {
    const struct iqs9151_data *data = (const struct iqs9151_data *)ctx;

    return data->scroll_params.decay_num;
}

const struct device *iqs9151_test_fake_dev(void *ctx) {
    static struct device fake_dev;

    fake_dev.data = ctx;
    return &fake_dev;
}
```

`iqs9151_test_context_init` の `memset` 後に `atomic_clear(&data->ic_dirty); atomic_clear(&data->reati_pending);` を追加する(memset で 0 になるが意図を明示するため。不要と判断したら省いてよい)。

- [ ] **Step 4: テストが通ることを確認してコミット**

```bash
git -C $DRV add -A drivers/input tests/iqs9151_work_cb
git -C $DRV commit -m "$(cat <<'EOF'
パラメータのデバイスAPIを追加しICレジスタ書き込みをフレーム処理内で適用する

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $DRV push
gh run watch --repo applepine1125/zmk-driver-iqs9151 --exit-status $(gh run list --repo applepine1125/zmk-driver-iqs9151 --branch runtime-tuning --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: 全件 PASS。

---

### Task 5: トレース出力

**Files:**
- Modify: `$DRV/drivers/input/iqs9151.c`(`iqs9151_report_key_event`, `iqs9151_report_rel_event`, `iqs9151_process_frame`)
- Modify: `$DRV/tests/iqs9151_work_cb/src/main.c`

**Interfaces:**
- Consumes: Task 4 のデバイス API
- Produces: `void iqs9151_dev_trace_enable(bool enable)`, `bool iqs9151_dev_trace_enabled(void)`。トレース行(LOG_INF):
  - `T F <ms> <fingers> <rel_x> <rel_y> <f1x> <f1y> <f2x> <f2y> <tp_flags_hex4> <hold_btn> <2f_mode> <pending_bits>`
  - `T E <ms> K <code> <value> <ret>` / `T E <ms> R <code> <value> <ret>`

- [ ] **Step 1: テストを書く**

```c
ZTEST(iqs9151_work_cb, test_トレースは既定で無効で有効化と無効化ができる) {
    zassert_false(iqs9151_dev_trace_enabled(), NULL);
    iqs9151_dev_trace_enable(true);
    zassert_true(iqs9151_dev_trace_enabled(), NULL);
    iqs9151_dev_trace_enable(false);
    zassert_false(iqs9151_dev_trace_enabled(), NULL);
}
```

- [ ] **Step 2: 失敗を確認**

Expected: 未定義シンボルでリンク失敗。

- [ ] **Step 3: 実装**

3-a. `LOG_MODULE_REGISTER` の直後に追加:

```c
static bool iqs9151_trace_enabled;

void iqs9151_dev_trace_enable(bool enable) {
    iqs9151_trace_enabled = enable;
}

bool iqs9151_dev_trace_enabled(void) {
    return iqs9151_trace_enabled;
}
```

3-b. `iqs9151_report_key_event` の `return input_report_key(...)` を次にする(`iqs9151_report_rel_event` も同様に `R` で):

```c
    const int ret = input_report_key(dev, code, value, sync, timeout);

    if (iqs9151_trace_enabled) {
        LOG_INF("T E %u K %u %d %d", (uint32_t)k_uptime_get(), code, (int)!!value, ret);
    }
    return ret;
```

テストフック経路(`CONFIG_INPUT_IQS9151_TEST` でフックがあるとき)も `return 0;` の前に同じ LOG_INF を `ret=0` で出す。

3-c. `iqs9151_process_frame` の既存 `LOG_DBG("rel x=...")` の直前に追加:

```c
    if (iqs9151_trace_enabled) {
        const uint32_t pending_bits = (data->one_finger_click_pending ? BIT(0) : 0U) |
                                      (data->two_finger_click_pending ? BIT(1) : 0U) |
                                      (data->three_finger_click_pending ? BIT(2) : 0U);

        LOG_INF("T F %u %u %d %d %u %u %u %u %04x %u %u %u", (uint32_t)now_ms,
                frame->finger_count, frame->rel_x, frame->rel_y, frame->finger1_x,
                frame->finger1_y, frame->finger2_x, frame->finger2_y, frame->trackpad_flags,
                data->hold_button, (unsigned int)data->two_finger.mode, pending_bits);
    }
```

- [ ] **Step 4: テストを通してコミット**

```bash
git -C $DRV add -A drivers/input tests/iqs9151_work_cb
git -C $DRV commit -m "$(cat <<'EOF'
フレームと入力報告のトレース出力を追加

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $DRV push
gh run watch --repo applepine1125/zmk-driver-iqs9151 --exit-status $(gh run list --repo applepine1125/zmk-driver-iqs9151 --branch runtime-tuning --limit 1 --json databaseId -q '.[0].databaseId')
```

---

### Task 6: `tp` シェルコマンドと Kconfig、ドキュメント

**Files:**
- Create: `$DRV/drivers/input/iqs9151_shell.c`
- Modify: `$DRV/drivers/input/Kconfig`(`endif` の前)
- Modify: `$DRV/drivers/input/CMakeLists.txt`
- Modify: `$DRV/documents/iqs9151_kconfig_reference.md`

**Interfaces:**
- Consumes: Task 2〜5 のデバイス API と定義テーブル
- Produces: Kconfig `INPUT_IQS9151_SHELL`、シェルコマンド `tp info|list|get|set|reset|reati|trace`

このタスクはユニットテストなし。コンパイル確認は Task 7 の zmk-config CI で行う。

- [ ] **Step 1: Kconfig を追加**

`drivers/input/Kconfig` の `config INPUT_IQS9151_TEST` の前に追加:

```
config INPUT_IQS9151_SHELL
    bool "IQS9151 tp shell command"
    depends on SHELL
    default n
    help
      Add the "tp" shell command to inspect and change gesture and
      sensitivity parameters at runtime (used by tools/tp-tuner).
```

- [ ] **Step 2: CMake に追加**

```cmake
zephyr_library_sources_ifdef(CONFIG_INPUT_IQS9151_SHELL iqs9151_shell.c)
```

- [ ] **Step 3: シェルコマンドを書く**

`$DRV/drivers/input/iqs9151_shell.c`:

```c
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>

#include <stdlib.h>
#include <string.h>

#include "iqs9151_params.h"

#define DT_DRV_COMPAT azoteq_iqs9151

static const struct device *tp_device(const struct shell *sh) {
    const struct device *dev = DEVICE_DT_GET_ANY(azoteq_iqs9151);

    if (dev == NULL || !device_is_ready(dev)) {
        shell_print(sh, "ERR device not ready");
        return NULL;
    }
    return dev;
}

static int parse_i32(const char *text, int32_t *out) {
    char *end = NULL;
    long v = strtol(text, &end, 10);

    if (end == text || *end != '\0') {
        return -EINVAL;
    }
    *out = (int32_t)v;
    return 0;
}

static int cmd_tp_info(const struct shell *sh, size_t argc, char **argv) {
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(sh, "side=%s uptime_ms=%u params=%u",
                IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL) ? "central" : "peripheral",
                (uint32_t)k_uptime_get(), (unsigned int)iqs9151_param_count());
    return 0;
}

static int cmd_tp_list(const struct shell *sh, size_t argc, char **argv) {
    const struct device *dev = tp_device(sh);

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    if (dev == NULL) {
        return -ENODEV;
    }
    for (size_t i = 0; i < iqs9151_param_count(); i++) {
        const struct iqs9151_param_def *def = iqs9151_param_def_at(i);
        int32_t value = 0;

        (void)iqs9151_dev_param_get(dev, def->name, &value);
        shell_print(sh, "%s %d %d %d %s %d", def->name, value, def->min, def->max,
                    iqs9151_param_kind_str(def->kind), def->def);
    }
    return 0;
}

static int cmd_tp_get(const struct shell *sh, size_t argc, char **argv) {
    const struct device *dev = tp_device(sh);
    int32_t value = 0;

    ARG_UNUSED(argc);
    if (dev == NULL) {
        return -ENODEV;
    }
    if (iqs9151_dev_param_get(dev, argv[1], &value) != 0) {
        shell_print(sh, "ERR unknown param %s", argv[1]);
        return -ENOENT;
    }
    shell_print(sh, "%s=%d", argv[1], value);
    return 0;
}

static int cmd_tp_set(const struct shell *sh, size_t argc, char **argv) {
    const struct device *dev = tp_device(sh);
    int32_t value = 0;
    int ret;

    ARG_UNUSED(argc);
    if (dev == NULL) {
        return -ENODEV;
    }
    if (parse_i32(argv[2], &value) != 0) {
        shell_print(sh, "ERR invalid value %s", argv[2]);
        return -EINVAL;
    }
    ret = iqs9151_dev_param_set(dev, argv[1], value);
    if (ret == -ENOENT) {
        shell_print(sh, "ERR unknown param %s", argv[1]);
        return ret;
    }
    if (ret == -ERANGE) {
        const struct iqs9151_param_def *def = iqs9151_param_find(argv[1]);

        shell_print(sh, "ERR out of range %d..%d", def->min, def->max);
        return ret;
    }
    shell_print(sh, "OK %s=%d", argv[1], value);
    return 0;
}

static int cmd_tp_reset(const struct shell *sh, size_t argc, char **argv) {
    const struct device *dev = tp_device(sh);

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    if (dev == NULL) {
        return -ENODEV;
    }
    (void)iqs9151_dev_param_reset(dev);
    shell_print(sh, "OK reset");
    return 0;
}

static int cmd_tp_reati(const struct shell *sh, size_t argc, char **argv) {
    const struct device *dev = tp_device(sh);

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    if (dev == NULL) {
        return -ENODEV;
    }
    (void)iqs9151_dev_request_reati(dev);
    shell_print(sh, "OK reati");
    return 0;
}

static int cmd_tp_trace(const struct shell *sh, size_t argc, char **argv) {
    ARG_UNUSED(argc);
    if (strcmp(argv[1], "on") == 0) {
        iqs9151_dev_trace_enable(true);
    } else if (strcmp(argv[1], "off") == 0) {
        iqs9151_dev_trace_enable(false);
    } else {
        shell_print(sh, "ERR expected on|off");
        return -EINVAL;
    }
    shell_print(sh, "OK trace=%s", argv[1]);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_tp,
    SHELL_CMD_ARG(info, NULL, "Show side and uptime", cmd_tp_info, 1, 0),
    SHELL_CMD_ARG(list, NULL, "List params: name value min max kind default", cmd_tp_list, 1, 0),
    SHELL_CMD_ARG(get, NULL, "get <name>", cmd_tp_get, 2, 0),
    SHELL_CMD_ARG(set, NULL, "set <name> <value>", cmd_tp_set, 3, 0),
    SHELL_CMD_ARG(reset, NULL, "Reset all params to Kconfig defaults", cmd_tp_reset, 1, 0),
    SHELL_CMD_ARG(reati, NULL, "Request Re-ATI on next frame", cmd_tp_reati, 1, 0),
    SHELL_CMD_ARG(trace, NULL, "trace on|off", cmd_tp_trace, 2, 0),
    SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(tp, &sub_tp, "IQS9151 trackpad tuning", NULL);
```

- [ ] **Step 4: ドキュメントを更新**

`documents/iqs9151_kconfig_reference.md` の末尾に節を追加:

```markdown
## ランタイム調整(INPUT_IQS9151_SHELL)

`CONFIG_INPUT_IQS9151_SHELL=y`(`CONFIG_SHELL=y` が必要)で `tp` シェルコマンドが使える。
パラメータ名は `CONFIG_INPUT_IQS9151_<NAME>` の `<NAME>` を小文字化したもの(例 `1f_tap_max_ms`)。
IC レジスタ系(`tp list` の kind が `ic_u8` / `ic_u16`)は次のフレーム処理時に書き込まれる。
変更は揮発性で、再起動すると Kconfig の値に戻る。

    tp info                  side=central|peripheral uptime_ms=<n> params=<count>
    tp list                  <name> <value> <min> <max> <kind> <default>
    tp get <name>
    tp set <name> <value>
    tp reset
    tp reati
    tp trace on|off          T F / T E 行を LOG(INF) に出す
```

- [ ] **Step 5: コミットして push(CI はコンパイル対象外なので green のまま)**

```bash
git -C $DRV add drivers/input/iqs9151_shell.c drivers/input/Kconfig drivers/input/CMakeLists.txt documents/iqs9151_kconfig_reference.md
git -C $DRV commit -m "$(cat <<'EOF'
tpシェルコマンドを追加

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $DRV push
git -C $DRV rev-parse HEAD
```

Expected: HEAD の SHA を控える(Task 7 で使う)。

---

### Task 7: zmk-config の設定変更と CI ビルド確認

**Files:**
- Modify: `$CFG/config/lalapadgen2.conf`
- Modify: `$CFG/config/west.yml`

**Interfaces:**
- Consumes: Task 6 の HEAD SHA
- Produces: 右手・左手ともシェル入り firmware が CI でビルドできる状態

- [ ] **Step 1: `.conf` を編集**

`config/lalapadgen2.conf` の `#STUDIO` ブロックの後ろに追加し、`#Debug only` ブロックのコメントを書き換える:

```
#TRACKPAD TUNER (tools/tp-tuner)
# USB CDC 上の Zephyr shell で tp コマンドを使う。ZMK_USB_LOGGING とは
# 同じ CDC(zephyr,console)を取り合うので併用しない
CONFIG_USB_DEVICE_STACK=y
CONFIG_USB_CDC_ACM=y
CONFIG_SERIAL=y
CONFIG_UART_INTERRUPT_DRIVEN=y
CONFIG_UART_LINE_CTRL=y
CONFIG_SHELL=y
CONFIG_SHELL_BACKEND_SERIAL=y
CONFIG_SHELL_VT100_COLORS=n
CONFIG_LOG=y
CONFIG_LOG_MODE_DEFERRED=y
CONFIG_LOG_DEFAULT_LEVEL=1
CONFIG_LOG_BACKEND_SHOW_COLOR=n
CONFIG_LOG_BUFFER_SIZE=4096
CONFIG_LOG_PROCESS_THREAD_SLEEP_MS=50
CONFIG_SHELL_LOG_BACKEND=y
CONFIG_INPUT_IQS9151_LOG_LEVEL=3
CONFIG_INPUT_IQS9151_SHELL=y

#Debug only (ZMK_USB_LOGGING は上の shell と排他)
#CONFIG_ZMK_USB_LOGGING=y
#CONFIG_INPUT_LOG_LEVEL_DBG=y
#CONFIG_LOG_PROCESS_THREAD_STARTUP_DELAY_MS=3000
```

- [ ] **Step 2: `west.yml` の SHA を更新**

`config/west.yml` の `zmk-driver-iqs9151` の `revision` を Task 6 の SHA に置き換える。

- [ ] **Step 3: コミットして push、CI を待つ**

```bash
git -C $CFG add config/lalapadgen2.conf config/west.yml
git -C $CFG commit -m "$(cat <<'EOF'
トラックパッド調整用のシェルとトレース出力を有効化

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $CFG push -u origin trackpad-tuner
gh pr create --repo applepine1125/zmk-config-LalaPadGen2 --draft --title "トラックパッド調整ツール(tp-tuner)を追加" --body "$(cat <<'EOF'
## What
IQS9151 のジェスチャ判定値と IC 感度レジスタを USB シリアル経由でその場で変更し、ドライバの送信内容とホストの受信内容を同じ時間軸で見られる調整ツールを追加する。

設計: docs/superpowers/specs/2026-09-07-trackpad-tuner-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
gh pr checks --repo applepine1125/zmk-config-LalaPadGen2 --watch --fail-fast --interval 30
```

Expected: 3 ターゲット(right, left, settings_reset)すべて成功。失敗時は `gh run view --log-failed` で確認する。想定される失敗と対処:
- `zephyr,shell-uart` が無い/`usb_cdc_acm_uart` が無効: `config/boards/shields/lalapadgen2/lalapadgen2.dtsi` に次を追加する
  ```
  / { chosen { zephyr,shell-uart = &usb_cdc_acm_uart; }; };
  &usb_cdc_acm_uart { status = "okay"; };
  ```
- 左手で `USB_DEVICE_STACK` に伴う `zmk_usb_*` 未定義: `lalapadgen2_left.conf` で該当 Kconfig を切り分ける
- RAM 不足: `CONFIG_LOG_BUFFER_SIZE=2048` に下げる

Draft PR は Task 10 で本 PR にする。

- [ ] **Step 4: 実機で疎通確認(ユーザー依頼)**

右手に UF2 を書き込み、`ls /dev/cu.usbmodem*` で 2 ポート見えること、`screen /dev/cu.usbmodemXXXX 115200` で `tp info` が応答することを確認してもらう。応答した側のポートを README に書く。ここで詰まった場合(ポートが 1 つしか出ない・応答しない)は Step 3 の対処に戻る。

---

### Task 8: ホスト側の純粋関数モジュールとテスト

**Files:**
- Create: `$CFG/tools/tp-tuner/tuner.js`
- Create: `$CFG/tools/tp-tuner/tuner.test.js`

**Interfaces:**
- Produces(`globalThis.TpTuner` および `module.exports`):
  - `parseListLine(line) -> {name, value, min, max, kind, def} | null`
  - `parseInfoLine(line) -> {side, uptimeMs, params} | null`
  - `parseTraceLine(line) -> {type:'F', ms, fingers, relX, relY, f1x, f1y, f2x, f2y, flags, hold, mode2f, pending} | {type:'E', ms, kind:'K'|'R', code, value, ret} | null`
  - `stripAnsi(text) -> string`
  - `isPrompt(text) -> boolean`(末尾が `~$ ` または `$ `)
  - `clockOffset(hostSentMs, hostRecvMs, uptimeMs) -> number`(host = uptime + offset)
  - `toConfName(name) -> string`
  - `exportConf(params, {diffOnly}) -> string`(bool は y/n)
  - `detectDrops(fwEvents) -> [{t, code, kind}]`
  - `detectStuckButton(fwEvents, hostButtonSamples, {holdMs}) -> [{t, code}]`
  - `detectMissingWheel(fwEvents, hostWheelEvents, {windowMs}) -> [{t}]`
  - `detectTwoFingerNoScroll(frames, fwEvents, {minMove, windowMs}) -> [{t}]`
  - 定数 `BTN = {0: 0x110, 1: 0x111, 2: 0x112, 7: 0x117}`, `REL = {X:0, Y:1, HWHEEL:6, WHEEL:8}`

- [ ] **Step 1: テストを書く**

`$CFG/tools/tp-tuner/tuner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./tuner.js');

test('tp list の1行をパースすると名前と値と範囲と種別が取れる', () => {
  assert.deepEqual(T.parseListLine('1f_tap_max_ms 250 1 1000 driver 250'), {
    name: '1f_tap_max_ms', value: 250, min: 1, max: 1000, kind: 'driver', def: 250,
  });
  assert.equal(T.parseListLine('uart:~$ '), null);
  assert.equal(T.parseListLine(''), null);
});

test('tp info の行をパースすると側と uptime が取れる', () => {
  assert.deepEqual(T.parseInfoLine('side=central uptime_ms=12345 params=50'),
    { side: 'central', uptimeMs: 12345, params: 50 });
  assert.equal(T.parseInfoLine('OK reset'), null);
});

test('ログ接頭辞つきの T F 行をパースするとフレームになる', () => {
  const line = '[00:00:12.345,678] <inf> iqs9151: T F 12345 1 3 -2 1000 1500 0 0 0110 0 0 1';
  assert.deepEqual(T.parseTraceLine(line), {
    type: 'F', ms: 12345, fingers: 1, relX: 3, relY: -2, f1x: 1000, f1y: 1500,
    f2x: 0, f2y: 0, flags: 0x0110, hold: 0, mode2f: 0, pending: 1,
  });
});

test('T E 行をパースするとキー報告と戻り値になる', () => {
  assert.deepEqual(T.parseTraceLine('T E 500 K 272 0 -12'),
    { type: 'E', ms: 500, kind: 'K', code: 272, value: 0, ret: -12 });
  assert.deepEqual(T.parseTraceLine('T E 501 R 8 -3 0'),
    { type: 'E', ms: 501, kind: 'R', code: 8, value: -3, ret: 0 });
  assert.equal(T.parseTraceLine('OK trace=on'), null);
});

test('ANSI エスケープを除去してプロンプトを判定できる', () => {
  assert.equal(T.stripAnsi('\x1b[1;32muart:~$ \x1b[0m'), 'uart:~$ ');
  assert.equal(T.isPrompt('uart:~$ '), true);
  assert.equal(T.isPrompt('OK reset'), false);
});

test('往復時間の半分を補正した時刻オフセットを計算できる', () => {
  assert.equal(T.clockOffset(1000, 1020, 500), 510);
});

test('パラメータ名を CONFIG 名に変換できる', () => {
  assert.equal(T.toConfName('1f_tap_max_ms'), 'CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS');
});

test('差分だけを .conf 行にすると bool は y/n になり変更のない行は出ない', () => {
  const params = [
    { name: '1f_tap_max_ms', value: 200, def: 250, kind: 'driver' },
    { name: '1f_tap_enable', value: 0, def: 1, kind: 'driver_bool' },
    { name: '1f_tap_move', value: 50, def: 50, kind: 'driver' },
  ];
  assert.equal(T.exportConf(params, { diffOnly: true }),
    'CONFIG_INPUT_IQS9151_1F_TAP_MAX_MS=200\nCONFIG_INPUT_IQS9151_1F_TAP_ENABLE=n\n');
  assert.equal(T.exportConf(params, { diffOnly: false }).split('\n').filter(Boolean).length, 3);
});

test('戻り値が 0 でない報告をドロップとして検出できる', () => {
  const ev = [
    { t: 10, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 20, type: 'E', kind: 'K', code: 272, value: 0, ret: -12 },
  ];
  assert.deepEqual(T.detectDrops(ev), [{ t: 20, code: 272, kind: 'K' }]);
});

test('ドライバが離した後にホストのボタンが押されたままなら stuck として検出できる', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }, { t: 700, buttons: 1 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), [{ t: 300, code: 272 }]);
});

test('ドライバが離した後にホストも離していれば stuck にならない', () => {
  const fw = [
    { t: 100, type: 'E', kind: 'K', code: 272, value: 1, ret: 0 },
    { t: 300, type: 'E', kind: 'K', code: 272, value: 0, ret: 0 },
  ];
  const host = [{ t: 105, buttons: 1 }, { t: 310, buttons: 0 }];
  assert.deepEqual(T.detectStuckButton(fw, host, { holdMs: 300 }), []);
});

test('ドライバが wheel を送ったのにホストに wheel が届かなければ検出できる', () => {
  const fw = [{ t: 100, type: 'E', kind: 'R', code: 8, value: 2, ret: 0 }];
  assert.deepEqual(T.detectMissingWheel(fw, [], { windowMs: 200 }), [{ t: 100 }]);
  assert.deepEqual(T.detectMissingWheel(fw, [{ t: 150, deltaY: 4 }], { windowMs: 200 }), []);
});

test('2本指で動いているのにドライバが wheel を出さなければ検出できる', () => {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    frames.push({ t: i * 10, type: 'F', fingers: 2, relX: 0, relY: 3 });
  }
  assert.deepEqual(T.detectTwoFingerNoScroll(frames, [], { minMove: 30, windowMs: 200 }),
    [{ t: 0 }]);
  const fw = [{ t: 120, type: 'E', kind: 'R', code: 8, value: 1, ret: 0 }];
  assert.deepEqual(T.detectTwoFingerNoScroll(frames, fw, { minMove: 30, windowMs: 200 }), []);
});
```

- [ ] **Step 2: 失敗を確認**

```bash
node --test $CFG/tools/tp-tuner/
```

Expected: `Cannot find module './tuner.js'` で失敗。

- [ ] **Step 3: 実装**

`$CFG/tools/tp-tuner/tuner.js`:

```js
(function (root) {
  'use strict';

  const BTN = { 0: 0x110, 1: 0x111, 2: 0x112, 7: 0x117 };
  const REL = { X: 0, Y: 1, HWHEEL: 6, WHEEL: 8 };
  const CONF_PREFIX = 'CONFIG_INPUT_IQS9151_';
  const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

  function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
  }

  function isPrompt(text) {
    return /\$ $/.test(text);
  }

  function parseListLine(line) {
    const m = /^([a-z0-9_]+) (-?\d+) (-?\d+) (-?\d+) (ic_u8|ic_u16|driver|driver_bool) (-?\d+)$/
      .exec(line.trim());
    if (!m) return null;
    return {
      name: m[1], value: Number(m[2]), min: Number(m[3]), max: Number(m[4]),
      kind: m[5], def: Number(m[6]),
    };
  }

  function parseInfoLine(line) {
    const m = /^side=(central|peripheral) uptime_ms=(\d+) params=(\d+)$/.exec(line.trim());
    if (!m) return null;
    return { side: m[1], uptimeMs: Number(m[2]), params: Number(m[3]) };
  }

  function parseTraceLine(line) {
    const idx = line.indexOf('T ');
    if (idx < 0) return null;
    const parts = line.slice(idx).trim().split(/\s+/);
    if (parts[0] !== 'T') return null;
    if (parts[1] === 'F' && parts.length === 14) {
      const n = parts.slice(2).map((s, i) => (i === 8 ? parseInt(s, 16) : Number(s)));
      if (n.some(Number.isNaN)) return null;
      return {
        type: 'F', ms: n[0], fingers: n[1], relX: n[2], relY: n[3], f1x: n[4], f1y: n[5],
        f2x: n[6], f2y: n[7], flags: n[8], hold: n[9], mode2f: n[10], pending: n[11],
      };
    }
    if (parts[1] === 'E' && parts.length === 7 && (parts[3] === 'K' || parts[3] === 'R')) {
      const ms = Number(parts[2]);
      const code = Number(parts[4]);
      const value = Number(parts[5]);
      const ret = Number(parts[6]);
      if ([ms, code, value, ret].some(Number.isNaN)) return null;
      return { type: 'E', ms, kind: parts[3], code, value, ret };
    }
    return null;
  }

  function clockOffset(hostSentMs, hostRecvMs, uptimeMs) {
    return (hostSentMs + hostRecvMs) / 2 - uptimeMs;
  }

  function toConfName(name) {
    return CONF_PREFIX + name.toUpperCase();
  }

  function exportConf(params, opts) {
    const diffOnly = !!(opts && opts.diffOnly);
    let out = '';
    for (const p of params) {
      if (diffOnly && p.value === p.def) continue;
      const v = p.kind === 'driver_bool' ? (p.value ? 'y' : 'n') : String(p.value);
      out += toConfName(p.name) + '=' + v + '\n';
    }
    return out;
  }

  function detectDrops(fwEvents) {
    return fwEvents
      .filter((e) => e.type === 'E' && e.ret !== 0)
      .map((e) => ({ t: e.t, code: e.code, kind: e.kind }));
  }

  function hostButtonsAt(samples, t) {
    let buttons = 0;
    for (const s of samples) {
      if (s.t > t) break;
      buttons = s.buttons;
    }
    return buttons;
  }

  function hostBitForCode(code) {
    if (code === BTN[0]) return 1;
    if (code === BTN[1]) return 2;
    if (code === BTN[2]) return 4;
    return 0;
  }

  function detectStuckButton(fwEvents, hostButtonSamples, opts) {
    const holdMs = (opts && opts.holdMs) || 300;
    const out = [];
    const keys = fwEvents.filter((e) => e.type === 'E' && e.kind === 'K');
    for (let i = 0; i < keys.length; i++) {
      const e = keys[i];
      if (e.value !== 0) continue;
      const bit = hostBitForCode(e.code);
      if (!bit) continue;
      const nextPress = keys.slice(i + 1).find((k) => k.code === e.code && k.value === 1);
      const checkT = e.t + holdMs;
      if (nextPress && nextPress.t <= checkT) continue;
      if (hostButtonsAt(hostButtonSamples, checkT) & bit) {
        out.push({ t: e.t, code: e.code });
      }
    }
    return out;
  }

  function detectMissingWheel(fwEvents, hostWheelEvents, opts) {
    const windowMs = (opts && opts.windowMs) || 200;
    const out = [];
    const wheels = fwEvents.filter(
      (e) => e.type === 'E' && e.kind === 'R' && (e.code === REL.WHEEL || e.code === REL.HWHEEL));
    let lastFlagged = -Infinity;
    for (const w of wheels) {
      const received = hostWheelEvents.some((h) => h.t >= w.t && h.t <= w.t + windowMs);
      if (!received && w.t - lastFlagged > windowMs) {
        out.push({ t: w.t });
        lastFlagged = w.t;
      }
    }
    return out;
  }

  function detectTwoFingerNoScroll(frames, fwEvents, opts) {
    const minMove = (opts && opts.minMove) || 30;
    const windowMs = (opts && opts.windowMs) || 200;
    const out = [];
    const wheels = fwEvents.filter(
      (e) => e.type === 'E' && e.kind === 'R' && (e.code === REL.WHEEL || e.code === REL.HWHEEL));
    let start = null;
    let move = 0;
    const flush = (endT) => {
      if (start === null) return;
      const hadWheel = wheels.some((w) => w.t >= start && w.t <= endT);
      if (move >= minMove && endT - start >= windowMs && !hadWheel) out.push({ t: start });
      start = null;
      move = 0;
    };
    for (const f of frames) {
      if (f.type !== 'F') continue;
      if (f.fingers === 2) {
        if (start === null) start = f.t;
        move += Math.abs(f.relX) + Math.abs(f.relY);
      } else {
        flush(f.t);
      }
    }
    if (frames.length) flush(frames[frames.length - 1].t);
    return out;
  }

  const api = {
    BTN, REL, stripAnsi, isPrompt, parseListLine, parseInfoLine, parseTraceLine,
    clockOffset, toConfName, exportConf, detectDrops, detectStuckButton,
    detectMissingWheel, detectTwoFingerNoScroll,
  };
  root.TpTuner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: テストを通す**

```bash
node --test $CFG/tools/tp-tuner/
```

Expected: 全件 pass。`detectTwoFingerNoScroll` の最初のケースは `frames` の最後(t=290)で `flush` され、`move=90 ≥ 30`、`290-0 ≥ 200`、wheel なしで検出される。

- [ ] **Step 5: コミット**

```bash
git -C $CFG add tools/tp-tuner/tuner.js tools/tp-tuner/tuner.test.js
git -C $CFG commit -m "$(cat <<'EOF'
tp-tuner のパース・診断・.conf生成ロジックを追加

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
```

---

### Task 9: ホストアプリの UI と README

**Files:**
- Create: `$CFG/tools/tp-tuner/index.html`
- Create: `$CFG/tools/tp-tuner/README.md`

**Interfaces:**
- Consumes: Task 8 の `TpTuner`(`<script src="tuner.js">`)、Task 6 の `tp` コマンド
- Produces: `file://` で開ける調整 UI

このタスクは Chrome での手動確認が主になる。実機がない間は「ダミーデータ」ボタンで検証する。

- [ ] **Step 1: index.html の骨格(接続・コマンド送受信)を書く**

`$CFG/tools/tp-tuner/index.html`。構成は上から順に: 接続バー、注意表示、2 カラム(左: パラメータパネル、右: テストパッド + タイムライン + 診断 + エクスポート)。外部依存なし。スタイルは最小限(システムフォント、幅 100%、`canvas` は横スクロールなし)。

シリアル層(`<script>` 内):

```js
const T = globalThis.TpTuner;
const serial = {
  port: null, reader: null, writer: null, buffer: '', pending: null, lines: [],
  onTrace: null, onLog: null,
};

async function connect() {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  serial.port = port;
  serial.writer = port.writable.getWriter();
  readLoop(port);
  await send('tp trace off');
  const info = (await send('tp info')).map(T.parseInfoLine).find(Boolean);
  if (!info) throw new Error('tp info に応答がありません。もう一方のポートを選んでください');
  return info;
}

async function readLoop(port) {
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable);
  serial.reader = decoder.readable.getReader();
  for (;;) {
    const { value, done } = await serial.reader.read();
    if (done) break;
    serial.buffer += value;
    let nl;
    while ((nl = serial.buffer.indexOf('\n')) >= 0) {
      handleLine(T.stripAnsi(serial.buffer.slice(0, nl)).replace(/\r$/, ''));
      serial.buffer = serial.buffer.slice(nl + 1);
    }
    const tail = T.stripAnsi(serial.buffer);
    if (T.isPrompt(tail) && serial.pending) {
      serial.buffer = '';
      const p = serial.pending; serial.pending = null;
      p.resolve(serial.lines); serial.lines = [];
    }
  }
}

function handleLine(line) {
  const trace = T.parseTraceLine(line);
  if (trace) { serial.onTrace && serial.onTrace(trace); return; }
  if (serial.pending && line !== serial.pending.cmd) serial.lines.push(line);
  serial.onLog && serial.onLog(line);
}

function send(cmd) {
  return new Promise((resolve, reject) => {
    if (serial.pending) return reject(new Error('前のコマンドが完了していません'));
    serial.pending = { cmd, resolve, reject };
    serial.lines = [];
    serial.writer.write(new TextEncoder().encode(cmd + '\r\n'));
    setTimeout(() => {
      if (serial.pending && serial.pending.cmd === cmd) {
        serial.pending = null; reject(new Error('タイムアウト: ' + cmd));
      }
    }, 3000);
  });
}
```

時刻合わせ: `send('tp info')` の前後で `performance.now()` を取り、`clock.offset = T.clockOffset(before, after, info.uptimeMs)`。ファームの `ms` はタイムライン上で `ms + clock.offset` に変換する。ホストイベントは `performance.now()` をそのまま使う。

- [ ] **Step 2: パラメータパネルを書く**

`tp list` の結果を `T.parseListLine` で配列にし、`GROUPS` 辞書でグループ分けして描画する:

```js
const GROUPS = [
  { title: '1本指タップ / タップドラッグ', names: ['1f_tap_enable', '1f_tap_max_ms', '1f_tap_move', '1f_presshold_enable', '1f_tapdrag_gap_max_ms'] },
  { title: '2本指タップ / スクロール / ピンチ', names: ['2f_tap_enable', '2f_tap_max_ms', '2f_tap_move', '2f_presshold_enable', '2f_tapdrag_gap_max_ms', 'scroll_x_enable', 'scroll_y_enable', '2f_scroll_start_move', '2f_pinch_enable', '2f_pinch_start_distance', '2f_pinch_wheel_gain_x10'] },
  { title: '3本指', names: ['3f_tap_enable', '3f_tap_max_ms', '3f_tap_move', '3f_presshold_enable', '3f_tapdrag_gap_max_ms', '3f_swipe_threshold'] },
  { title: '慣性', names: ['cursor_inertia_enable', 'cursor_inertia_decay', 'cursor_inertia_recent_window_ms', 'cursor_inertia_stale_gap_ms', 'cursor_inertia_min_samples', 'cursor_inertia_min_avg_speed', 'scroll_inertia_enable', 'scroll_inertia_decay', 'scroll_inertia_recent_window_ms', 'scroll_inertia_stale_gap_ms', 'scroll_inertia_min_samples', 'scroll_inertia_min_avg_speed'] },
  { title: 'IC 感度(変更後にパッドへ一度触れると反映)', ic: true, names: ['touch_set_threshold', 'touch_clear_threshold', 'alp_set_debounce', 'alp_clear_debounce', 'stationary_touch_mov_threshold', 'jitter_filter_delta', 'finger_confidence_threshold'] },
  { title: 'IC サンプリング周期', ic: true, names: ['active_mode_sampling_period_ms', 'idle_touch_mode_sampling_period_ms', 'idle_mode_sampling_period_ms', 'lp1_mode_sampling_period_ms', 'lp2_mode_sampling_period_ms', 'active_mode_timeout_ms'] },
  { title: 'IC フィルタ / ATI(変更後は Re-ATI)', ic: true, names: ['ati_targetcount', 'dynamic_filter_bottom_speed', 'dynamic_filter_top_speed', 'dynamic_filter_bottom_beta'] },
];
const DESCRIPTIONS = {
  '1f_tap_max_ms': 'タップと判定する最大押下時間',
  '1f_tap_move': 'タップと判定する最大移動量',
  '1f_tapdrag_gap_max_ms': 'タップ後にボタンを押したまま2回目の接触を待つ時間(タップドラッグ)',
  '2f_scroll_start_move': '2本指スクロールを開始する移動量',
  'touch_set_threshold': 'タッチ検出の閾値(小さいほど敏感)',
  'touch_clear_threshold': 'タッチ解除の閾値',
  'alp_set_debounce': '低消費電力モードからの復帰デバウンス(小さいほど立ち上がりが速い)',
  'ati_targetcount': 'ATI のターゲットカウント。変更後は Re-ATI',
};
```

各行: ラベル(名前 + 説明)、`driver_bool` はチェックボックス、それ以外は `<input type=range>` と `<input type=number>`(min/max は list の値)。変更時は 150ms デバウンスで `send('tp set <name> <value>')` を送り、応答が `OK` 以外ならその行を赤くする。既定値(`def`)と異なる行は背景を薄い黄色にし、行末に「既定に戻す」ボタン。IC グループには「Re-ATI」ボタン(`tp reati`)、パネル上部に「すべて既定に戻す」(`tp reset` のあと `tp list` を取り直す)。辞書にない名前は「その他」グループへ。

```js
let params = [];
const byName = () => Object.fromEntries(params.map((p) => [p.name, p]));

async function loadParams() {
  params = (await send('tp list')).map(T.parseListLine).filter(Boolean);
  renderParams();
}

function renderParams() {
  const root = document.getElementById('params');
  root.innerHTML = '';
  const seen = new Set();
  const groups = GROUPS.concat([{ title: 'その他', names: params.map((p) => p.name).filter((n) => !GROUPS.some((g) => g.names.includes(n))) }]);
  for (const g of groups) {
    const box = document.createElement('fieldset');
    box.innerHTML = `<legend>${g.title}</legend>`;
    if (g.ic) {
      const b = document.createElement('button');
      b.textContent = 'Re-ATI';
      b.onclick = () => send('tp reati').then(log);
      box.appendChild(b);
    }
    for (const name of g.names) {
      const p = byName()[name];
      if (!p || seen.has(name)) continue;
      seen.add(name);
      box.appendChild(renderParamRow(p));
    }
    if (box.children.length > 1) root.appendChild(box);
  }
}

function renderParamRow(p) {
  const row = document.createElement('div');
  row.className = 'param' + (p.value !== p.def ? ' changed' : '');
  row.dataset.name = p.name;
  const label = `<label title="${DESCRIPTIONS[p.name] || ''}">${p.name}</label>`;
  if (p.kind === 'driver_bool') {
    row.innerHTML = `${label}<input type="checkbox" ${p.value ? 'checked' : ''}>`;
    row.querySelector('input').onchange = (e) => setParam(p, e.target.checked ? 1 : 0);
  } else {
    row.innerHTML = `${label}<input type="range" min="${p.min}" max="${p.max}" value="${p.value}">` +
      `<input type="number" min="${p.min}" max="${p.max}" value="${p.value}">`;
    const [range, num] = row.querySelectorAll('input');
    range.oninput = () => { num.value = range.value; setParam(p, Number(range.value)); };
    num.onchange = () => { range.value = num.value; setParam(p, Number(num.value)); };
  }
  const reset = document.createElement('button');
  reset.textContent = '既定に戻す';
  reset.onclick = () => { setParam(p, p.def); renderParams(); };
  row.appendChild(reset);
  return row;
}

const setTimers = {};
function setParam(p, value) {
  clearTimeout(setTimers[p.name]);
  setTimers[p.name] = setTimeout(async () => {
    const lines = await send(`tp set ${p.name} ${value}`);
    const row = document.querySelector(`.param[data-name="${p.name}"]`);
    const ok = lines.some((l) => l.startsWith('OK '));
    row.classList.toggle('error', !ok);
    if (ok) { p.value = value; row.classList.toggle('changed', p.value !== p.def); }
    log(lines.join('\n'));
  }, 150);
}
```

CSS: `.param.changed { background: #fff6cc; } .param.error { background: #ffd6d6; }`。

- [ ] **Step 3: テストパッドとイベント記録を書く**

```js
const rec = { frames: [], fw: [], hostBtn: [], hostWheel: [], hostMove: [], paused: false };
const pad = document.getElementById('pad');
pad.addEventListener('contextmenu', (e) => e.preventDefault());
for (const type of ['pointerdown', 'pointerup', 'pointermove']) {
  pad.addEventListener(type, (e) => {
    if (rec.paused) return;
    const t = performance.now();
    if (type === 'pointermove') rec.hostMove.push({ t, dx: e.movementX, dy: e.movementY });
    else rec.hostBtn.push({ t, buttons: e.buttons });
    if (type === 'pointerdown') pad.setPointerCapture(e.pointerId);
  });
}
pad.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!rec.paused) rec.hostWheel.push({ t: performance.now(), deltaX: e.deltaX, deltaY: e.deltaY });
}, { passive: false });
serial.onTrace = (tr) => {
  if (rec.paused) return;
  const t = tr.ms + clock.offset;
  if (tr.type === 'F') rec.frames.push({ ...tr, t }); else rec.fw.push({ ...tr, t });
};
```

パッド上部に現在のホスト状態(`buttons`、直近 move、直近 wheel)を文字で表示する。

- [ ] **Step 4: タイムラインと診断を書く**

`requestAnimationFrame` で `canvas` を再描画する。横軸は直近 `viewMs`(既定 5000、ズームボタンで 2000/5000/10000)。レーン(上から): FW 指本数(0..3 を高さで)、FW ボタン(`K` の press〜release を code ごとに帯で。BTN_0=青、BTN_1=緑、BTN_2=橙、`ret≠0` は赤い×)、FW REL/WHEEL(点)、HOST ボタン(`buttons` ビットの帯)、HOST move(点)、HOST wheel(点)。診断結果は該当時刻に赤い縦線 + 一覧(`<ul>`)。

```js
const view = { ms: 5000 };
const LANES = ['FW 指', 'FW ボタン', 'FW REL/WHEEL', 'HOST ボタン', 'HOST move', 'HOST wheel'];
const BTN_COLOR = { [T.BTN[0]]: '#3b82f6', [T.BTN[1]]: '#22c55e', [T.BTN[2]]: '#f97316', [T.BTN[7]]: '#a855f7' };

function drawTimeline(diag) {
  const cv = document.getElementById('timeline');
  const ctx = cv.getContext('2d');
  const W = cv.width = cv.clientWidth;
  const H = cv.height = LANES.length * 40;
  const now = performance.now();
  const t0 = now - view.ms;
  const x = (t) => ((t - t0) / view.ms) * W;
  const laneY = (i) => i * 40;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px sans-serif';
  LANES.forEach((name, i) => {
    ctx.fillStyle = i % 2 ? '#f3f4f6' : '#ffffff';
    ctx.fillRect(0, laneY(i), W, 40);
    ctx.fillStyle = '#6b7280';
    ctx.fillText(name, 4, laneY(i) + 12);
  });
  ctx.strokeStyle = '#111827';
  ctx.beginPath();
  let prev = null;
  for (const f of rec.frames) {
    if (f.t < t0) continue;
    const y = laneY(0) + 36 - f.fingers * 10;
    if (prev) ctx.lineTo(x(f.t), y); else ctx.moveTo(x(f.t), y);
    prev = f;
  }
  ctx.stroke();
  const open = {};
  for (const e of rec.fw) {
    if (e.kind === 'K') {
      if (e.value) open[e.code] = e.t;
      else if (open[e.code] !== undefined) {
        ctx.fillStyle = BTN_COLOR[e.code] || '#9ca3af';
        ctx.fillRect(x(open[e.code]), laneY(1) + 14, Math.max(2, x(e.t) - x(open[e.code])), 20);
        delete open[e.code];
      }
      if (e.ret !== 0) { ctx.fillStyle = '#dc2626'; ctx.fillText('×', x(e.t) - 3, laneY(1) + 12); }
    } else if (e.t >= t0) {
      ctx.fillStyle = e.code === T.REL.WHEEL || e.code === T.REL.HWHEEL ? '#dc2626' : '#111827';
      ctx.fillRect(x(e.t), laneY(2) + 30 - Math.min(16, Math.abs(e.value)), 2, 2 + Math.min(16, Math.abs(e.value)));
    }
  }
  for (const code of Object.keys(open)) {
    ctx.fillStyle = BTN_COLOR[code] || '#9ca3af';
    ctx.fillRect(x(open[code]), laneY(1) + 14, W - x(open[code]), 20);
  }
  let last = { t: t0, buttons: 0 };
  for (const s of rec.hostBtn.concat([{ t: now, buttons: null }])) {
    if (s.t < t0) { last = s; continue; }
    if (last.buttons & 1) { ctx.fillStyle = BTN_COLOR[T.BTN[0]]; ctx.fillRect(x(last.t), laneY(3) + 14, x(s.t) - x(last.t), 8); }
    if (last.buttons & 2) { ctx.fillStyle = BTN_COLOR[T.BTN[1]]; ctx.fillRect(x(last.t), laneY(3) + 24, x(s.t) - x(last.t), 8); }
    if (s.buttons !== null) last = s;
  }
  ctx.fillStyle = '#111827';
  for (const m of rec.hostMove) if (m.t >= t0) ctx.fillRect(x(m.t), laneY(4) + 18, 2, 4);
  ctx.fillStyle = '#dc2626';
  for (const w of rec.hostWheel) if (w.t >= t0) ctx.fillRect(x(w.t), laneY(5) + 30 - Math.min(16, Math.abs(w.deltaY)), 2, 2 + Math.min(16, Math.abs(w.deltaY)));
  ctx.strokeStyle = '#dc2626';
  for (const d of diag) {
    if (d.t < t0) continue;
    ctx.beginPath(); ctx.moveTo(x(d.t), 0); ctx.lineTo(x(d.t), H); ctx.stroke();
  }
}

let diag = [];
setInterval(() => {
  if (rec.paused) return;
  diag = runDiagnostics();
  const ul = document.getElementById('diag');
  ul.innerHTML = diag.slice(-20).map((d) => `<li>${(d.t / 1000).toFixed(2)}s ${d.msg}</li>`).join('');
}, 500);
(function loop() { drawTimeline(diag); requestAnimationFrame(loop); })();
```

古いデータは `rec` の各配列を `t < now - 60000` で捨てて肥大化を防ぐ(`setInterval` 内で行う)。

診断は 500ms ごとに直近 `viewMs` のデータで再計算する:

```js
function runDiagnostics() {
  const items = [];
  for (const d of T.detectDrops(rec.fw)) items.push({ t: d.t, msg: `input_report が ${d.kind} ${d.code} を捨てた` });
  for (const d of T.detectStuckButton(rec.fw, rec.hostBtn, { holdMs: 300 })) items.push({ t: d.t, msg: `ドライバは離したがホストのボタン(${d.code})が押されたまま` });
  for (const d of T.detectMissingWheel(rec.fw, rec.hostWheel, { windowMs: 200 })) items.push({ t: d.t, msg: 'ドライバは wheel を送ったがホストに届いていない' });
  for (const d of T.detectTwoFingerNoScroll(rec.frames, rec.fw, { minMove: 30, windowMs: 200 })) items.push({ t: d.t, msg: '2本指で動いているがドライバが wheel を出していない' });
  return items.sort((a, b) => a.t - b.t);
}
```

「一時停止」「クリア」「ダミーデータ」ボタンを置く。ダミーデータは接続なしで UI を検証するためのもので、`rec` に固定シナリオ(1F タップ→ホールド→ホスト側は離さない)を投入して stuck 診断が赤く出ることを確認できるようにする。

- [ ] **Step 5: エクスポートとプロファイルを書く**

「差分を .conf でコピー」「すべて .conf でコピー」ボタン(`navigator.clipboard.writeText(T.exportConf(params, {diffOnly}))`)と、テキストエリアに同じ内容を表示する。「プロファイル保存」は名前を `prompt` で聞き `localStorage['tp-tuner.profiles']` に `{name: {param: value}}` で保存、「読込」は選択した値を順に `tp set` する。`localStorage` のアクセスは `try/catch` で囲む。

- [ ] **Step 6: Chrome で確認**

```bash
open -a "Google Chrome" $CFG/tools/tp-tuner/index.html
```

確認項目:
- 「ダミーデータ」でタイムラインに帯と点が描かれ、診断に stuck が 1 件出る
- 接続なしでも例外が出ない(DevTools の Console にエラーなし)
- 実機がある場合: 「接続」→ ポート選択 → 左右と uptime が表示され、パラメータ一覧が 50 行埋まる。スライダを動かすと `tp set` の `OK` が返る。trace を ON にしてパッドに触れるとフレームレーンが動く

- [ ] **Step 7: README を書く**

`$CFG/tools/tp-tuner/README.md`:

```markdown
# tp-tuner: トラックパッド調整ツール

IQS9151 ドライバのジェスチャ判定値と IC 感度レジスタを USB シリアル経由でその場で変更し、
ドライバが送ったイベントとホストが受け取ったイベントを同じ時間軸で見る。

## 立ち上げ

1. 調整したい側の半分に USB ケーブルを挿す(左右それぞれにシェルが入っている)
2. Chrome で `tools/tp-tuner/index.html` を開き「接続」を押す。ポート一覧に 2 つ見える場合はどちらかを選ぶ。
   `tp info` に応答がないと再選択を促すので、もう一方を選ぶ
3. 「trace ON」にしてテストパッド領域でジェスチャを行い、タイムラインと診断を見ながら左のパラメータを変える

## 使い方の要点

- 変更は即座にファームに送られる(揮発。再起動で `.conf` の値に戻る)
- IC 系(感度・サンプリング周期・ATI)は次のフレーム処理で書き込まれるので、変更後にパッドへ一度触れる。
  ATI ターゲットや動的フィルタを変えたら「Re-ATI」を押す
- 確定したら「差分を .conf でコピー」して `config/lalapadgen2.conf` に貼り、PR を作って CI でビルドする
- USB を挿すと ZMK はマウス出力も USB HID に切り替える。BLE 固有の症状(送信キュー詰まり)を見るときは
  キーマップの `&out OUT_BLE` で出力を BLE に戻す

## 診断の見方

- 「input_report が捨てた」: input キュー満杯でドライバのイベントがホストに届いていない
- 「ホストのボタンが押されたまま」: ドライバは離したのにホスト側でドラッグが残っている(タップ後ドラッグ残りの症状)
- 「wheel が届いていない」: ドライバはスクロールしたのに伝送で落ちている
- 「ドライバが wheel を出していない」: 2 本指移動が `2f_scroll_start_move` などの判定に達していない

## 開発

    node --test tools/tp-tuner/

ロジックは `tuner.js`(純粋関数)、UI は `index.html`。
```

- [ ] **Step 8: コミット**

```bash
git -C $CFG add tools/tp-tuner/index.html tools/tp-tuner/README.md
git -C $CFG commit -m "$(cat <<'EOF'
tp-tuner の調整UIとREADMEを追加

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
git -C $CFG push
```

---

### Task 10: 仕上げ(PR、メモリ更新)

**Files:**
- Modify: `~/.claude/projects/-Users-takashi-matsuyuki-001-go-src-github-com-applepine1125-zmk-config-LalaPadGen2/memory/lalapad-trackpad-magic-feel.md`
- Modify: 同 `MEMORY.md`

- [ ] **Step 1: zmk-config の PR を Draft から本 PR にし、本文を仕上げる**

```bash
gh pr ready --repo applepine1125/zmk-config-LalaPadGen2
gh pr edit --repo applepine1125/zmk-config-LalaPadGen2 --body "$(cat <<'EOF'
## What
IQS9151 のジェスチャ判定値と IC 感度レジスタを USB シリアル経由でその場で変更し、ドライバの送信内容とホストの受信内容を同じ時間軸で見られる調整ツール `tools/tp-tuner` を追加する。ファーム側はドライバフォーク(`runtime-tuning` ブランチ)の `tp` シェルコマンドとトレース出力を有効化する。

- 設計: docs/superpowers/specs/2026-09-07-trackpad-tuner-design.md
- 使い方: tools/tp-tuner/README.md

## 確認
- CI で right / left / settings_reset がビルドできること
- `node --test tools/tp-tuner/` が通ること
- 実機: 右手に USB を挿し Chrome で接続、`tp list` が取れてスライダ変更が反映されること(要実機)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01JqaiWYc1ji1GdPL8fBvmvo
EOF
)"
gh pr checks --repo applepine1125/zmk-config-LalaPadGen2 --watch --fail-fast --interval 30
```

- [ ] **Step 2: メモリを更新**

`lalapad-trackpad-magic-feel.md` に追記(spec に書いてあることは繰り返さない):
- 2026-09-07: ランタイム調整ツール tp-tuner を追加(PR 番号)。ドライバフォークのブランチは `runtime-tuning`(`hold-release-forever` と `sensitivity-kconfig` を統合済み。以後この 2 ブランチは使わない)
- ドライバの ztest はフォークの GitHub Actions(`.github/workflows/test.yml`)で回す。ローカルの `tests/run.sh`(Docker)が Apple Silicon で動いたかどうかの結果
- 実機検証の結果(Task 7 Step 4 と Task 9 Step 6 で分かったこと: ポート数、応答したポート、動かなかった点)

`MEMORY.md` の該当行の hook を「IQS9151 + ShiniNet ドライバの現状、段階的対応方針、tp-tuner によるランタイム調整」に更新する。

- [ ] **Step 3: 完了報告**

ユーザーに以下を報告する: PR の URL、フォークのブランチと SHA、実機で確認してほしい手順(README の立ち上げ 3 ステップ)、未検証事項(2 ポート構成の enumerate、左手の USB CDC、Docker ローカル実行)。
