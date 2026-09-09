/*
 * tp-tuner の左右間プロトコル定義。
 * central → peripheral は behavior "tp_param" の param1(index / オペコード)と param2(値)、
 * peripheral → central は左トラックパッド用の zmk,input-split(reg 1)に相乗りした入力イベント。
 * 専用の特性を増やすと ZMK v0.3.0 の central が購読に失敗する(探索が応答内の属性順に依存する)ため、
 * 既存チャネルをベンダ範囲の type(0xF0〜)で共用し、sync は常に 0 にして
 * central のリスナーがマウスレポートを送らないようにする。
 */

#pragma once

#include <stdint.h>

#define TP_TUNER_SPLIT_REG 1

#define TP_TUNER_EV_FIRST 0xF0
#define TP_TUNER_EV_SUMMARY 0xF0
#define TP_TUNER_EV_PARAM 0xF1
#define TP_TUNER_EV_ACK 0xF2
#define TP_TUNER_EV_STATUS 0xF3

#define TP_TUNER_OP_BASE 0x8000
#define TP_TUNER_OP_RESET 0x8000
#define TP_TUNER_OP_REATI 0x8001
#define TP_TUNER_OP_SAVE 0x8002
#define TP_TUNER_OP_SUMMARY 0x8003
#define TP_TUNER_OP_DUMP 0x8004
#define TP_TUNER_OP_INFO 0x8005

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
