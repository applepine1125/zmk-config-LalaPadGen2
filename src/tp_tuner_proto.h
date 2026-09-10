/*
 * tp-tuner の左右間プロトコル定義。
 * central → peripheral は behavior "tp_param" の param1(index / オペコード)と param2(値)、
 * peripheral → central は左トラックパッド用の zmk,input-split(reg 1)に相乗りした入力イベント。
 * 専用の特性を増やすと ZMK v0.3.0 の central が購読に失敗する(探索が応答内の属性順に依存する)ため、
 * 既存チャネルをベンダ範囲の type(0xF0〜)で共用し、sync は常に 0 にして
 * central のリスナーがマウスレポートを送らないようにする。
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#define TP_TUNER_SPLIT_REG 1

#define TP_TUNER_EV_FIRST 0xF0
#define TP_TUNER_EV_SUMMARY 0xF0
#define TP_TUNER_EV_PARAM 0xF1
#define TP_TUNER_EV_ACK 0xF2
#define TP_TUNER_EV_STATUS 0xF3

/* ライブフレーム(第 5b 段)。指本数・hold・2F モードを type に畳み、座標を code/value に詰める */
#define TP_TUNER_EV_LIVE_FIRST 0xF4
#define TP_TUNER_EV_LIVE_0F 0xF4
#define TP_TUNER_EV_LIVE_1F 0xF5
#define TP_TUNER_EV_LIVE_1F_HOLD 0xF6
#define TP_TUNER_EV_LIVE_2F 0xF7
#define TP_TUNER_EV_LIVE_2F_SCROLL 0xF8
#define TP_TUNER_EV_LIVE_2F_PINCH 0xF9
#define TP_TUNER_EV_LIVE_2F_HOLD 0xFA
#define TP_TUNER_EV_LIVE_3F 0xFB
#define TP_TUNER_EV_LIVE_3F_HOLD 0xFC
#define TP_TUNER_EV_LIVE_LAST 0xFC
/*
 * hold 中のボタン(code = INPUT_BTN_*)。type は指本数から hold コードを復元するため、
 * 1 本指ドラッグに 2 本目を置いたときなどドライバの hold_button と食い違う。
 * ボタンが変わったフレームの直前に 1 件送り、central はこれを優先する
 */
#define TP_TUNER_EV_LIVE_HOLD 0xFD

/* stats 応答(STATS オペコード)。code = 項目 id(下記)、value = 値。id 0 で終端 */
#define TP_TUNER_EV_STATS 0xFE

#define TP_TUNER_OP_BASE 0x8000
#define TP_TUNER_OP_RESET 0x8000
#define TP_TUNER_OP_REATI 0x8001
#define TP_TUNER_OP_SAVE 0x8002
#define TP_TUNER_OP_SUMMARY 0x8003
#define TP_TUNER_OP_DUMP 0x8004
#define TP_TUNER_OP_INFO 0x8005
/* param2 = hz、0 で off */
#define TP_TUNER_OP_LIVE 0x8006
/* 計測値を STATS イベントで返す */
#define TP_TUNER_OP_STATS 0x8007

enum tp_tuner_stat_id {
    TP_TUNER_STAT_END = 0,
    TP_TUNER_STAT_FRAME_N,
    TP_TUNER_STAT_FRAME_MAX_US,
    TP_TUNER_STAT_FRAME_AVG_US,
    TP_TUNER_STAT_FRAME_GAP_MAX_MS,
    TP_TUNER_STAT_I2C_ERR,
    TP_TUNER_STAT_I2C_MAX_US,
    TP_TUNER_STAT_RESET_N,
    TP_TUNER_STAT_CPU_MAX_US,
    TP_TUNER_STAT_WQ_LATE_MAX_US,
    TP_TUNER_STAT_WQ_LATE_OVER3,
    TP_TUNER_STAT_POS_LOCAL,
    TP_TUNER_STAT_POS_REMOTE,
    TP_TUNER_STAT_NOTIFY_FAIL,
    TP_TUNER_STAT_LINK_INT_US,
    TP_TUNER_STAT_LINK_LAT,
    TP_TUNER_STAT_LINK_TO_MS,
    TP_TUNER_STAT_LINK_TX_LEN,
    TP_TUNER_STAT_COUNT,
};

static inline const char *tp_tuner_stat_name(uint16_t id) {
    static const char *const names[TP_TUNER_STAT_COUNT] = {
        [TP_TUNER_STAT_END] = "end",
        [TP_TUNER_STAT_FRAME_N] = "frame_n",
        [TP_TUNER_STAT_FRAME_MAX_US] = "frame_max_us",
        [TP_TUNER_STAT_FRAME_AVG_US] = "frame_avg_us",
        [TP_TUNER_STAT_FRAME_GAP_MAX_MS] = "frame_gap_max_ms",
        [TP_TUNER_STAT_I2C_ERR] = "i2c_err",
        [TP_TUNER_STAT_I2C_MAX_US] = "i2c_max_us",
        [TP_TUNER_STAT_RESET_N] = "reset_n",
        [TP_TUNER_STAT_CPU_MAX_US] = "cpu_max_us",
        [TP_TUNER_STAT_WQ_LATE_MAX_US] = "wq_late_max_us",
        [TP_TUNER_STAT_WQ_LATE_OVER3] = "wq_late_over3",
        [TP_TUNER_STAT_POS_LOCAL] = "pos_local",
        [TP_TUNER_STAT_POS_REMOTE] = "pos_remote",
        [TP_TUNER_STAT_NOTIFY_FAIL] = "notify_fail",
        [TP_TUNER_STAT_LINK_INT_US] = "link_int_us",
        [TP_TUNER_STAT_LINK_LAT] = "link_lat",
        [TP_TUNER_STAT_LINK_TO_MS] = "link_to_ms",
        [TP_TUNER_STAT_LINK_TX_LEN] = "link_tx_len",
    };

    return id < TP_TUNER_STAT_COUNT ? names[id] : "?";
}

#define TP_TUNER_LIVE_HZ_DEFAULT_LEFT 30

/* hold は central 側の T F 行に出す INPUT_BTN_0..2 のコード */
#define TP_TUNER_LIVE_HOLD_1F 272
#define TP_TUNER_LIVE_HOLD_2F 273
#define TP_TUNER_LIVE_HOLD_3F 274

struct tp_tuner_live_frame {
    uint8_t fingers;
    uint16_t hold;
    uint8_t mode2f;
    uint16_t f1x, f1y, f2x, f2y;
};

static inline uint8_t tp_tuner_live_type(uint8_t fingers, bool hold, uint8_t mode2f) {
    if (fingers == 0) {
        return TP_TUNER_EV_LIVE_0F;
    }
    if (fingers == 1) {
        return hold ? TP_TUNER_EV_LIVE_1F_HOLD : TP_TUNER_EV_LIVE_1F;
    }
    if (fingers == 2) {
        if (hold) {
            return TP_TUNER_EV_LIVE_2F_HOLD;
        }
        if (mode2f == 1) {
            return TP_TUNER_EV_LIVE_2F_SCROLL;
        }
        if (mode2f == 2) {
            return TP_TUNER_EV_LIVE_2F_PINCH;
        }
        return TP_TUNER_EV_LIVE_2F;
    }
    return hold ? TP_TUNER_EV_LIVE_3F_HOLD : TP_TUNER_EV_LIVE_3F;
}

/*
 * code = (f1x & 0xFFF) | ((f1y >> 8) & 0xF) << 12
 * value = (f1y & 0xFF) | (f2x & 0xFFF) << 8 | (f2y & 0xFFF) << 20
 * 指が 1 本以下のときは f2 を、0 本のときは f1 も 0 にする
 */
static inline void tp_tuner_live_pack(const struct tp_tuner_live_frame *f, uint8_t *type,
                                      uint16_t *code, uint32_t *value) {
    uint16_t f1x = f->fingers >= 1 ? f->f1x : 0;
    uint16_t f1y = f->fingers >= 1 ? f->f1y : 0;
    uint16_t f2x = f->fingers >= 2 ? f->f2x : 0;
    uint16_t f2y = f->fingers >= 2 ? f->f2y : 0;

    *type = tp_tuner_live_type(f->fingers, f->hold != 0, f->mode2f);
    *code = (uint16_t)((f1x & 0xFFFU) | (((f1y >> 8) & 0xFU) << 12));
    *value = (uint32_t)(f1y & 0xFFU) | ((uint32_t)(f2x & 0xFFFU) << 8) |
             ((uint32_t)(f2y & 0xFFFU) << 20);
}

static inline bool tp_tuner_live_unpack(uint8_t type, uint16_t code, uint32_t value,
                                        struct tp_tuner_live_frame *f) {
    switch (type) {
    case TP_TUNER_EV_LIVE_0F:
        f->fingers = 0;
        f->hold = 0;
        f->mode2f = 0;
        break;
    case TP_TUNER_EV_LIVE_1F:
    case TP_TUNER_EV_LIVE_1F_HOLD:
        f->fingers = 1;
        f->hold = type == TP_TUNER_EV_LIVE_1F_HOLD ? TP_TUNER_LIVE_HOLD_1F : 0;
        f->mode2f = 0;
        break;
    case TP_TUNER_EV_LIVE_2F:
    case TP_TUNER_EV_LIVE_2F_SCROLL:
    case TP_TUNER_EV_LIVE_2F_PINCH:
    case TP_TUNER_EV_LIVE_2F_HOLD:
        f->fingers = 2;
        f->hold = type == TP_TUNER_EV_LIVE_2F_HOLD ? TP_TUNER_LIVE_HOLD_2F : 0;
        f->mode2f = type == TP_TUNER_EV_LIVE_2F_SCROLL ? 1
                    : type == TP_TUNER_EV_LIVE_2F_PINCH ? 2
                                                        : 0;
        break;
    case TP_TUNER_EV_LIVE_3F:
    case TP_TUNER_EV_LIVE_3F_HOLD:
        f->fingers = 3;
        f->hold = type == TP_TUNER_EV_LIVE_3F_HOLD ? TP_TUNER_LIVE_HOLD_3F : 0;
        f->mode2f = 0;
        break;
    default:
        return false;
    }
    f->f1x = code & 0xFFFU;
    f->f1y = (uint16_t)((((code >> 12) & 0xFU) << 8) | (value & 0xFFU));
    f->f2x = (uint16_t)((value >> 8) & 0xFFFU);
    f->f2y = (uint16_t)((value >> 20) & 0xFFFU);
    return true;
}

/* STATUS の value: saved(bit0) | summary_on(bit1) | count<<8 | min(uptime_s,65535)<<16 */
#define TP_TUNER_STATUS_SAVED_BIT 0
#define TP_TUNER_STATUS_SUMMARY_ON_BIT 1
#define TP_TUNER_STATUS_COUNT_SHIFT 8
#define TP_TUNER_STATUS_COUNT_MASK 0xFFU
#define TP_TUNER_STATUS_UPTIME_SHIFT 16
#define TP_TUNER_STATUS_UPTIME_MASK 0xFFFFU

#define TP_TUNER_STATUS_ENCODE(saved, summary_on, count, uptime_s)                                \
    (((saved) ? (1U << TP_TUNER_STATUS_SAVED_BIT) : 0U) |                                         \
     ((summary_on) ? (1U << TP_TUNER_STATUS_SUMMARY_ON_BIT) : 0U) |                               \
     (((uint32_t)(count) & TP_TUNER_STATUS_COUNT_MASK) << TP_TUNER_STATUS_COUNT_SHIFT) |          \
     (((uint32_t)(uptime_s) & TP_TUNER_STATUS_UPTIME_MASK) << TP_TUNER_STATUS_UPTIME_SHIFT))
#define TP_TUNER_STATUS_SAVED(v) (((v) >> TP_TUNER_STATUS_SAVED_BIT) & 1U)
#define TP_TUNER_STATUS_SUMMARY_ON(v) (((v) >> TP_TUNER_STATUS_SUMMARY_ON_BIT) & 1U)
#define TP_TUNER_STATUS_COUNT(v) (((v) >> TP_TUNER_STATUS_COUNT_SHIFT) & TP_TUNER_STATUS_COUNT_MASK)
#define TP_TUNER_STATUS_UPTIME_S(v)                                                               \
    (((v) >> TP_TUNER_STATUS_UPTIME_SHIFT) & TP_TUNER_STATUS_UPTIME_MASK)

#define TP_TUNER_BEHAVIOR_NAME "tp_param"

/* peripheral で要求をキューに積んで送信 work を起こす。満杯なら -ENOMEM。central ビルドでは未定義 */
int tp_tuner_peripheral_request(uint32_t op, uint32_t value);
