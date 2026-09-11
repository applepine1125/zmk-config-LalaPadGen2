/*
 * tp-tuner 右手(central)側の内部インタフェース。
 * tp_tuner_gatt.c(GATT サービスと stream リング/通知/DLE 要求)、
 * tp_tuner_left.c(左手へのコマンド転送と応答ハンドラ)、
 * tp_tuner_central.c(右手ローカルコマンドと初期化)の間で共有する宣言を置く。
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include <zephyr/kernel.h>
#include <zephyr/sys/ring_buffer.h>

#define TP_TUNER_CMD_MAX 64
#define TP_TUNER_LINE_MAX 160
#define TP_TUNER_STREAM_SIZE 4096

/* tp_tuner_gatt.c が持つ stream の状態。central/left からは読み出しにのみ使う */
extern struct ring_buf stream_rb;
extern bool stream_subscribed;

void stream_put_line(char side, const char *text);
void stream_put_frame(char side, const char *text, bool released);
void stream_flush(void);

/* tp_tuner_left.c が持つコマンドキュー。gatt.c の command_write から積む */
extern struct k_msgq tp_tuner_cmd_msgq;
extern struct k_work_delayable cmd_work;

void sub_request(const char *args);

/*
 * tp_tuner_left.c が持つ summary on 再送要否の状態。gatt.c の CCC ハンドラ
 * (stream_ccc_changed)が購読の開始/終了のたびにリセットする
 */
extern bool sub_summary_wanted;
extern bool sub_summary_confirmed;
extern bool sub_summary_tried;

/* tp_tuner_central.c のローカル(右手)コマンド実行。left.c の cmd_work_cb から呼ぶ */
void run_local(const char *args);
