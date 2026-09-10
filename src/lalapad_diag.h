/*
 * 入力応答性の計測(設計書 docs/superpowers/specs/2026-09-10-input-latency-tuning-design.md)。
 * システムワークキューの遅れ、キー位置イベント数、BLE リンクの接続パラメータ、tp-tuner の送信失敗を数える。
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include <iqs9151_cmd.h>

struct lalapad_diag_stats {
    uint32_t wq_late_max_us;
    uint32_t wq_late_over3;
    uint32_t pos_local;
    uint32_t pos_remote;
    uint32_t notify_fail;
    /* 最初に見つかった接続(左手では split リンク)。未接続なら 0 */
    uint32_t link_int_us;
    uint32_t link_lat;
    uint32_t link_to_ms;
    uint32_t link_tx_len;
};

void lalapad_diag_note_notify_fail(void);
void lalapad_diag_snapshot(struct lalapad_diag_stats *out, bool reset);
/* `tp stats` の追記フック。stats 行と接続ごとの link 行を出す */
void lalapad_diag_format(iqs9151_cmd_out_t out, void *ctx, bool reset);
