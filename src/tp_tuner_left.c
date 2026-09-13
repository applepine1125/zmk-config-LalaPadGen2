/*
 * tp-tuner 右手(central)側。"L ..." コマンドを behavior "tp_param" で左手へ転送し、
 * 左手からの応答・要約は左トラックパッド用 zmk,input-split(reg 1)に相乗りした
 * ベンダ type の入力イベントで受ける(トラックパッド本来のイベントは無視する)。
 */

#include <zephyr/device.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zmk/behavior.h>
#include <zmk/split/central.h>

#include <iqs9151_cmd.h>
#include <iqs9151_params.h>

#include "tp_tuner_internal.h"
#include "tp_tuner_proto.h"

LOG_MODULE_DECLARE(tp_tuner, CONFIG_ZMK_LOG_LEVEL);

#define TP_TUNER_CMD_QUEUE_DEPTH 4
#define TP_TUNER_SUB_QUEUE_DEPTH 8
#define TP_TUNER_CMD_MAX_TOKENS 3
#define TP_TUNER_LEFT_TIMEOUT_MS 1000
/* タイムアウト後に遅れて届いた応答を次のコマンドに誤帰属しないよう、次の L コマンドを待たせる時間 */
#define TP_TUNER_LEFT_COOLDOWN_MS 200

/* ---- command 書き込み → コマンドキュー ---- */

K_MSGQ_DEFINE(tp_tuner_cmd_msgq, TP_TUNER_CMD_MAX + 1, TP_TUNER_CMD_QUEUE_DEPTH, 1);

/*
 * 購読の開始/終了で左手へ送る内部コマンド。ホストのコマンドより先に処理し、
 * 応答は stream に出さない(ホストが自分のコマンドの応答と取り違えないように)
 */
K_MSGQ_DEFINE(tp_tuner_sub_msgq, TP_TUNER_CMD_MAX + 1, TP_TUNER_SUB_QUEUE_DEPTH, 1);

static void cmd_work_cb(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(cmd_work, cmd_work_cb);
static int64_t left_cooldown_until;

void sub_request(const char *args) {
    char line[TP_TUNER_CMD_MAX + 1];

    strncpy(line, args, sizeof(line) - 1);
    line[sizeof(line) - 1] = '\0';
    if (k_msgq_put(&tp_tuner_sub_msgq, line, K_NO_WAIT) != 0) {
        LOG_WRN("subscription command queue full, '%s' dropped", args);
        return;
    }
    (void)k_work_schedule(&cmd_work, K_NO_WAIT);
}

/*
 * 左手への summary on は購読開始時ではなく、購読中に最初のホスト L コマンドを処理する直前に送る。
 * ボンド済みホストの再接続では CCC が復元されて購読中扱いになるため、ホストが command を
 * 書くまで有効扱いにしない。左手から ACK が来るまでは未確認とし、ホスト L コマンドごとに送り直す
 */
bool sub_summary_wanted;
bool sub_summary_confirmed;
bool sub_summary_tried;

/* ---- 左手向けコマンドの待機状態 ---- */

enum left_cmd {
    LEFT_CMD_NONE,
    LEFT_CMD_SET,
    LEFT_CMD_LIST,
    LEFT_CMD_INFO,
    LEFT_CMD_RESET,
    LEFT_CMD_REATI,
    LEFT_CMD_SAVE,
    LEFT_CMD_SUMMARY,
    LEFT_CMD_LIVE,
    LEFT_CMD_STATS,
};

struct left_pending {
    enum left_cmd cmd;
    uint32_t op;
    int32_t value;
    const struct iqs9151_param_def *def;
    size_t received;
    bool silent;
};

static struct left_pending left;
static struct k_spinlock left_lock;

static void left_timeout_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(left_timeout_work, left_timeout_cb);

static bool left_take(struct left_pending *out) {
    k_spinlock_key_t key = k_spin_lock(&left_lock);
    bool active = left.cmd != LEFT_CMD_NONE;

    if (active) {
        *out = left;
        left.cmd = LEFT_CMD_NONE;
    }
    k_spin_unlock(&left_lock, key);
    return active;
}

static bool left_peek(struct left_pending *out) {
    k_spinlock_key_t key = k_spin_lock(&left_lock);
    bool active = left.cmd != LEFT_CMD_NONE;

    if (active) {
        *out = left;
    }
    k_spin_unlock(&left_lock, key);
    return active;
}

static void left_reply(const struct left_pending *p, const char *text) {
    if (!p->silent) {
        stream_put_line('L', text);
    }
}

static void left_finish(const struct left_pending *p) {
    left_reply(p, ".");
    (void)k_work_schedule(&cmd_work, K_NO_WAIT);
}

static void left_timeout_cb(struct k_work *work) {
    struct left_pending p;

    ARG_UNUSED(work);
    if (!left_take(&p)) {
        return;
    }
    left_cooldown_until = k_uptime_get() + TP_TUNER_LEFT_COOLDOWN_MS;
    sub_summary_confirmed = false;
    if (p.silent) {
        LOG_WRN("subscription command op 0x%x timed out", p.op);
    }
    left_reply(&p, "ERR timeout");
    left_finish(&p);
}

static void left_fail(const struct left_pending *p, const char *text) {
    left_reply(p, text);
    left_reply(p, ".");
}

/* cmd_work(システムワークキュー)からしか呼ばれないので、スタックを節約するためバッファは static */
static void left_failf(const struct left_pending *p, const char *fmt, ...) {
    static char buf[TP_TUNER_LINE_MAX];
    va_list ap;

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    left_fail(p, buf);
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

static int param_index(const struct iqs9151_param_def *def) {
    for (size_t i = 0; i < iqs9151_param_count(); i++) {
        if (iqs9151_param_def_at(i) == def) {
            return (int)i;
        }
    }
    return -ENOENT;
}

static int tokenize(char *buf, char **argv, int max) {
    int argc = 0;
    char *p = buf;

    while (*p != '\0') {
        while (*p == ' ' || *p == '\t') {
            p++;
        }
        if (*p == '\0') {
            break;
        }
        if (argc >= max) {
            return -E2BIG;
        }
        argv[argc++] = p;
        while (*p != '\0' && *p != ' ' && *p != '\t') {
            p++;
        }
        if (*p != '\0') {
            *p++ = '\0';
        }
    }
    return argc;
}

static void left_send(struct left_pending pending) {
    struct zmk_behavior_binding binding = {
        .behavior_dev = TP_TUNER_BEHAVIOR_NAME,
        .param1 = pending.op,
        .param2 = (uint32_t)pending.value,
    };
    struct zmk_behavior_binding_event event = {
        .position = 0,
        .timestamp = k_uptime_get(),
        .source = 0,
    };
    k_spinlock_key_t key;
    int ret;

    key = k_spin_lock(&left_lock);
    left = pending;
    k_spin_unlock(&left_lock, key);
    (void)k_work_reschedule(&left_timeout_work, K_MSEC(TP_TUNER_LEFT_TIMEOUT_MS));

    ret = zmk_split_central_invoke_behavior(0, &binding, event, true);
    if (ret < 0) {
        struct left_pending discard;

        (void)k_work_cancel_delayable(&left_timeout_work);
        (void)left_take(&discard);
        left_failf(&pending, "ERR split %d", ret);
    }
}

static void run_left(const char *args, bool silent) {
    char buf[TP_TUNER_CMD_MAX];
    char *argv[TP_TUNER_CMD_MAX_TOKENS];
    int argc;
    struct left_pending pending = {.cmd = LEFT_CMD_NONE, .silent = silent};

    strncpy(buf, args, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    argc = tokenize(buf, argv, TP_TUNER_CMD_MAX_TOKENS);
    if (argc == -E2BIG) {
        left_fail(&pending, "ERR too many args");
        return;
    }
    if (argc == 0) {
        left_fail(&pending, "ERR empty");
        return;
    }

    if (strcmp(argv[0], "set") == 0) {
        int32_t value;
        int index;

        if (argc != 3) {
            left_fail(&pending, "ERR usage: set <name> <value>");
            return;
        }
        pending.def = iqs9151_param_find(argv[1]);
        if (pending.def == NULL) {
            left_failf(&pending, "ERR unknown param %s", argv[1]);
            return;
        }
        if (parse_i32(argv[2], &value) != 0) {
            left_failf(&pending, "ERR invalid value %s", argv[2]);
            return;
        }
        if (value < pending.def->min || value > pending.def->max) {
            left_failf(&pending, "ERR out of range %d..%d", pending.def->min, pending.def->max);
            return;
        }
        index = param_index(pending.def);
        if (index < 0) {
            left_failf(&pending, "ERR unknown param %s", argv[1]);
            return;
        }
        pending.cmd = LEFT_CMD_SET;
        pending.op = (uint32_t)index;
        pending.value = value;
    } else if (strcmp(argv[0], "list") == 0) {
        if (argc != 1) {
            left_fail(&pending, "ERR usage: list");
            return;
        }
        pending.cmd = LEFT_CMD_LIST;
        pending.op = TP_TUNER_OP_DUMP;
    } else if (strcmp(argv[0], "info") == 0) {
        if (argc != 1) {
            left_fail(&pending, "ERR usage: info");
            return;
        }
        pending.cmd = LEFT_CMD_INFO;
        pending.op = TP_TUNER_OP_INFO;
    } else if (strcmp(argv[0], "reset") == 0) {
        if (argc != 1) {
            left_fail(&pending, "ERR usage: reset");
            return;
        }
        pending.cmd = LEFT_CMD_RESET;
        pending.op = TP_TUNER_OP_RESET;
    } else if (strcmp(argv[0], "reati") == 0) {
        if (argc != 1) {
            left_fail(&pending, "ERR usage: reati");
            return;
        }
        pending.cmd = LEFT_CMD_REATI;
        pending.op = TP_TUNER_OP_REATI;
    } else if (strcmp(argv[0], "save") == 0) {
        if (argc != 1) {
            left_fail(&pending, "ERR usage: save");
            return;
        }
        pending.cmd = LEFT_CMD_SAVE;
        pending.op = TP_TUNER_OP_SAVE;
    } else if (strcmp(argv[0], "summary") == 0) {
        if (argc != 2) {
            left_fail(&pending, "ERR usage: summary on|off");
            return;
        }
        if (strcmp(argv[1], "on") == 0) {
            pending.value = 1;
        } else if (strcmp(argv[1], "off") == 0) {
            pending.value = 0;
        } else {
            left_fail(&pending, "ERR expected on|off");
            return;
        }
        pending.cmd = LEFT_CMD_SUMMARY;
        pending.op = TP_TUNER_OP_SUMMARY;
    } else if (strcmp(argv[0], "live") == 0) {
        if (argc < 2 || argc > 3) {
            left_fail(&pending, "ERR usage: live on|off [hz]");
            return;
        }
        if (strcmp(argv[1], "on") == 0) {
            int32_t hz = TP_TUNER_LIVE_HZ_DEFAULT_LEFT;

            if (argc == 3 && (parse_i32(argv[2], &hz) != 0 || hz < 1 || hz > 100)) {
                left_fail(&pending, "ERR hz 1..100");
                return;
            }
            pending.value = hz;
        } else if (strcmp(argv[1], "off") == 0) {
            if (argc != 2) {
                left_fail(&pending, "ERR usage: live on|off [hz]");
                return;
            }
            pending.value = 0;
        } else {
            left_fail(&pending, "ERR expected on|off");
            return;
        }
        pending.cmd = LEFT_CMD_LIVE;
        pending.op = TP_TUNER_OP_LIVE;
    } else if (strcmp(argv[0], "stats") == 0) {
        if (argc != 1) {
            left_fail(&pending, "ERR usage: stats");
            return;
        }
        pending.cmd = LEFT_CMD_STATS;
        pending.op = TP_TUNER_OP_STATS;
    } else if (strcmp(argv[0], "get") == 0 || strcmp(argv[0], "trace") == 0) {
        left_fail(&pending, "ERR unsupported");
        return;
    } else {
        left_failf(&pending, "ERR unknown command %s", argv[0]);
        return;
    }

    left_send(pending);
}

static void cmd_work_cb(struct k_work *work) {
    char line[TP_TUNER_CMD_MAX + 1];
    struct left_pending pending;
    int64_t remaining = left_cooldown_until - k_uptime_get();

    ARG_UNUSED(work);

    if (remaining > 0) {
        (void)k_work_reschedule(&cmd_work, K_MSEC(remaining));
        return;
    }

    while (!left_peek(&pending)) {
        if (k_msgq_get(&tp_tuner_sub_msgq, line, K_NO_WAIT) == 0) {
            run_left(line, true);
            continue;
        }
        if (k_msgq_peek(&tp_tuner_cmd_msgq, line) != 0) {
            break;
        }
        if (strncmp(line, "L ", 2) == 0 && sub_summary_wanted && !sub_summary_confirmed &&
            !sub_summary_tried) {
            sub_summary_tried = true;
            run_left("summary on", true);
            continue;
        }
        (void)k_msgq_get(&tp_tuner_cmd_msgq, line, K_NO_WAIT);
        sub_summary_tried = false;
        if (strncmp(line, "R ", 2) == 0) {
            run_local(line + 2);
        } else if (strncmp(line, "L ", 2) == 0) {
            run_left(line + 2, false);
        } else {
            stream_put_line('R', "ERR bad side");
            stream_put_line('R', ".");
        }
    }
}

/* ---- 左手からのイベント(入力スレッド) ---- */

static uint32_t summary_words[IQS9151_SUMMARY_WORDS];
static size_t summary_next;

static void handle_summary(uint16_t code, uint32_t value) {
    if (code >= IQS9151_SUMMARY_WORDS) {
        return;
    }
    if (code != summary_next) {
        LOG_WRN("summary word %u out of order (expected %u)", code, (unsigned)summary_next);
        summary_next = 0;
        if (code != 0) {
            return;
        }
    }
    summary_words[code] = value;
    summary_next = code + 1;
    if (summary_next == IQS9151_SUMMARY_WORDS) {
        struct iqs9151_attempt_summary summary;
        char buf[TP_TUNER_LINE_MAX];

        iqs9151_summary_unpack(summary_words, &summary);
        (void)iqs9151_summary_format(&summary, buf, sizeof(buf));
        stream_put_line('L', buf);
        summary_next = 0;
    }
}

static void handle_param(uint16_t code, int32_t value) {
    struct left_pending p;
    const struct iqs9151_param_def *def;
    char buf[TP_TUNER_LINE_MAX];
    k_spinlock_key_t key;

    if (!left_peek(&p) || p.cmd != LEFT_CMD_LIST) {
        LOG_WRN("unexpected PARAM %u=%d", code, value);
        return;
    }
    def = iqs9151_param_def_at(code);
    if (def == NULL) {
        LOG_WRN("PARAM index %u out of table", code);
        return;
    }
    snprintf(buf, sizeof(buf), "%s %d %d %d %s %d", def->name, value, def->min, def->max,
             iqs9151_param_kind_str(def->kind), def->def);
    stream_put_line('L', buf);

    key = k_spin_lock(&left_lock);
    if (left.cmd == LEFT_CMD_LIST) {
        left.received++;
    }
    k_spin_unlock(&left_lock, key);
    (void)k_work_reschedule(&left_timeout_work, K_MSEC(TP_TUNER_LEFT_TIMEOUT_MS));
}

static void handle_status(uint32_t value) {
    struct left_pending p;
    char buf[TP_TUNER_LINE_MAX];

    if (!left_peek(&p) || (p.cmd != LEFT_CMD_LIST && p.cmd != LEFT_CMD_INFO)) {
        LOG_WRN("unexpected STATUS 0x%x", value);
        return;
    }
    if (!left_take(&p)) {
        return;
    }
    (void)k_work_cancel_delayable(&left_timeout_work);
    /* 左手が右手から切れて戻ると forward_summary は false に戻るので、STATUS から実状態を取り直す */
    sub_summary_confirmed = TP_TUNER_STATUS_SUMMARY_ON(value) != 0;

    if (p.cmd == LEFT_CMD_INFO) {
        snprintf(buf, sizeof(buf), "side=peripheral uptime_ms=%u params=%u saved=%s",
                 (unsigned)(TP_TUNER_STATUS_UPTIME_S(value) * 1000U),
                 (unsigned)TP_TUNER_STATUS_COUNT(value), TP_TUNER_STATUS_SAVED(value) ? "yes" : "no");
        stream_put_line('L', buf);
    } else if (TP_TUNER_STATUS_COUNT(value) != iqs9151_param_count()) {
        stream_put_line('L', "ERR param count mismatch");
    } else if (p.received != iqs9151_param_count()) {
        LOG_WRN("list received %u of %u params", (unsigned)p.received,
                (unsigned)iqs9151_param_count());
        stream_put_line('L', "ERR param missing");
    }
    left_finish(&p);
}

static void handle_ack(uint16_t code, int32_t ret) {
    struct left_pending p;
    char buf[TP_TUNER_LINE_MAX];

    if (!left_peek(&p) || p.cmd == LEFT_CMD_LIST || p.cmd == LEFT_CMD_INFO || p.cmd == LEFT_CMD_STATS ||
        p.op != code) {
        LOG_WRN("unexpected ACK op 0x%x ret %d", code, ret);
        return;
    }
    if (!left_take(&p)) {
        return;
    }
    (void)k_work_cancel_delayable(&left_timeout_work);

    switch (p.cmd) {
    case LEFT_CMD_SET:
        if (ret == 0) {
            snprintf(buf, sizeof(buf), "OK %s=%d", p.def->name, p.value);
        } else if (ret == -ERANGE) {
            snprintf(buf, sizeof(buf), "ERR out of range %d..%d", p.def->min, p.def->max);
        } else if (ret == -ENOENT) {
            snprintf(buf, sizeof(buf), "ERR unknown param");
        } else {
            snprintf(buf, sizeof(buf), "ERR %d", ret);
        }
        break;
    case LEFT_CMD_RESET:
        snprintf(buf, sizeof(buf), "OK reset");
        break;
    case LEFT_CMD_REATI:
        snprintf(buf, sizeof(buf), "OK reati");
        break;
    case LEFT_CMD_SAVE:
        if (ret == 0) {
            snprintf(buf, sizeof(buf), "OK saved");
        } else {
            snprintf(buf, sizeof(buf), "ERR %d", ret);
        }
        break;
    case LEFT_CMD_SUMMARY:
        snprintf(buf, sizeof(buf), "OK summary=%s", p.value ? "on" : "off");
        sub_summary_confirmed = p.value != 0;
        if (!p.silent) {
            sub_summary_wanted = p.value != 0;
        }
        break;
    case LEFT_CMD_LIVE:
        if (ret == 0 && p.value != 0) {
            snprintf(buf, sizeof(buf), "OK live=on hz=%d", p.value);
        } else if (ret == 0) {
            snprintf(buf, sizeof(buf), "OK live=off");
        } else if (ret == -ERANGE) {
            snprintf(buf, sizeof(buf), "ERR hz 1..100");
        } else {
            snprintf(buf, sizeof(buf), "ERR %d", ret);
        }
        break;
    default:
        snprintf(buf, sizeof(buf), "ERR %d", ret);
        break;
    }
    left_reply(&p, buf);
    left_finish(&p);
}

/* 左手の stats 応答を行にまとめる。left_event_handler(システムワークキュー)からしか触らない */
static char left_stats_line[TP_TUNER_LINE_MAX];
static uint32_t left_link_vals[4];

static void left_stats_flush(void) {
    if (left_stats_line[0] != 0) {
        stream_put_line('L', left_stats_line);
        left_stats_line[0] = 0;
    }
}

static void handle_stats(uint16_t code, uint32_t value) {
    struct left_pending p;
    char item[48];
    size_t used;

    if (!left_peek(&p) || p.cmd != LEFT_CMD_STATS) {
        LOG_WRN("unexpected STATS id %u", code);
        return;
    }
    if (code >= TP_TUNER_STAT_LINK_INT_US && code < TP_TUNER_STAT_COUNT) {
        left_link_vals[code - TP_TUNER_STAT_LINK_INT_US] = value;
        return;
    }
    if (code != TP_TUNER_STAT_END) {
        snprintf(item, sizeof(item), " %s=%u", tp_tuner_stat_name(code), (unsigned)value);
        used = strlen(left_stats_line);
        /* stream_put は "L " と改行を足すので、その分を残して折り返す */
        if (used == 0 || used + strlen(item) >= sizeof(left_stats_line) - 4) {
            left_stats_flush();
            strcpy(left_stats_line, "stats");
        }
        strcat(left_stats_line, item);
        return;
    }
    if (!left_take(&p)) {
        return;
    }
    (void)k_work_cancel_delayable(&left_timeout_work);
    left_stats_flush();
    snprintf(left_stats_line, sizeof(left_stats_line), "link0 role=peripheral int_us=%u lat=%u to_ms=%u tx_len=%u",
             (unsigned)left_link_vals[0], (unsigned)left_link_vals[1], (unsigned)left_link_vals[2],
             (unsigned)left_link_vals[3]);
    left_stats_flush();
    left_finish(&p);
}

/* 左手が直前に知らせた hold 中のボタン。hold の無いフレームで忘れる */
static uint16_t left_hold_button;

/* 左手のライブフレームを USB の trace と同じ T F 行にする(rel・flags・pending は持たないので 0) */
static void handle_live(uint8_t type, uint16_t code, uint32_t value) {
    struct tp_tuner_live_frame live;
    struct iqs9151_frame_info f = {0};
    char buf[TP_TUNER_LINE_MAX];

    if (!tp_tuner_live_unpack(type, code, value, &live)) {
        return;
    }
    if (live.hold == 0) {
        left_hold_button = 0;
    } else if (left_hold_button != 0) {
        live.hold = left_hold_button;
    }
    if (!stream_subscribed) {
        return;
    }
    f.ms = (uint32_t)k_uptime_get();
    f.fingers = live.fingers;
    f.f1x = live.f1x;
    f.f1y = live.f1y;
    f.f2x = live.f2x;
    f.f2y = live.f2y;
    f.hold = live.hold;
    f.mode2f = live.mode2f;
    (void)iqs9151_frame_format(&f, buf, sizeof(buf));
    stream_put_frame('L', buf, live.fingers == 0);
}

static void left_event_handler(struct input_event *evt) {
    if (evt->type < TP_TUNER_EV_FIRST) {
        return;
    }
    if (evt->type >= TP_TUNER_EV_LIVE_FIRST && evt->type <= TP_TUNER_EV_LIVE_LAST) {
        handle_live(evt->type, evt->code, (uint32_t)evt->value);
        return;
    }
    if (evt->type == TP_TUNER_EV_LIVE_HOLD) {
        left_hold_button = evt->code;
        return;
    }
    switch (evt->type) {
    case TP_TUNER_EV_SUMMARY:
        handle_summary(evt->code, (uint32_t)evt->value);
        break;
    case TP_TUNER_EV_PARAM:
        handle_param(evt->code, evt->value);
        break;
    case TP_TUNER_EV_ACK:
        handle_ack(evt->code, evt->value);
        break;
    case TP_TUNER_EV_STATUS:
        handle_status((uint32_t)evt->value);
        break;
    case TP_TUNER_EV_STATS:
        handle_stats(evt->code, (uint32_t)evt->value);
        break;
    default:
        LOG_WRN("unknown tp_tuner event type %u", evt->type);
        break;
    }
}

INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_NODELABEL(trackpad_split_l)), left_event_handler);
