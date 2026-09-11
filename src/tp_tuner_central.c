/*
 * tp-tuner 右手(central)側。"R ..." はローカルの iqs9151_cmd_exec で実行する。
 * GATT サービスと stream 通知は tp_tuner_gatt.c、"L ..." の左手転送と応答ハンドラは
 * tp_tuner_left.c を参照。この分割の共有宣言は tp_tuner_internal.h に置く。
 */

#include <zephyr/init.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/ring_buffer.h>

#include <iqs9151_cmd.h>
#include <iqs9151_params.h>

#include "tp_tuner_internal.h"

LOG_MODULE_REGISTER(tp_tuner, CONFIG_ZMK_LOG_LEVEL);

/* ---- ローカル(右手)コマンド ---- */

static void local_out(void *ctx, const char *line) {
    ARG_UNUSED(ctx);
    stream_put_line('R', line);
    if (ring_buf_size_get(&stream_rb) >= TP_TUNER_STREAM_SIZE / 2) {
        stream_flush();
    }
}

void run_local(const char *args) {
    (void)iqs9151_cmd_exec(NULL, args, local_out, NULL);
    stream_put_line('R', ".");
}

/* ---- 右手自身の要約・ライブフレーム ---- */

static void local_summary_cb(const struct iqs9151_attempt_summary *summary, void *user_data) {
    char buf[TP_TUNER_LINE_MAX];

    ARG_UNUSED(user_data);
    if (!stream_subscribed || !iqs9151_dev_summary_enabled()) {
        return;
    }
    (void)iqs9151_summary_format(summary, buf, sizeof(buf));
    stream_put_line('R', buf);
}

static void local_frame_cb(const struct iqs9151_frame_info *finfo, void *user_data) {
    char buf[TP_TUNER_LINE_MAX];

    ARG_UNUSED(user_data);
    if (!stream_subscribed) {
        return;
    }
    (void)iqs9151_frame_format(finfo, buf, sizeof(buf));
    stream_put_frame('R', buf, finfo->fingers == 0);
}

static int tp_tuner_central_init(void) {
    iqs9151_dev_set_summary_callback(local_summary_cb, NULL);
    iqs9151_dev_set_frame_callback(local_frame_cb, NULL);
    return 0;
}

SYS_INIT(tp_tuner_central_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
