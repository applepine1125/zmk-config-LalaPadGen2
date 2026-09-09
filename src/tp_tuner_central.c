/*
 * tp-tuner 右手(central)側。
 * ボンド済みホスト向けの GATT サービス(command 書き込み / stream 通知)を提供し、
 * "R ..." はローカルの iqs9151_cmd_exec、"L ..." は behavior "tp_param" で左手へ転送する。
 * 左手からの応答・要約は左トラックパッド用 zmk,input-split(reg 1)に相乗りした
 * ベンダ type の入力イベントで受ける(トラックパッド本来のイベントは無視する)。
 */

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/device.h>
#include <zephyr/init.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/ring_buffer.h>

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zmk/behavior.h>
#include <zmk/split/central.h>

#include <iqs9151_cmd.h>
#include <iqs9151_params.h>

#include "tp_tuner_proto.h"

LOG_MODULE_REGISTER(tp_tuner, CONFIG_ZMK_LOG_LEVEL);

#define TP_TUNER_UUID_SERVICE                                                                      \
    BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x2c28159e, 0x1502, 0x4858, 0x8409, 0xd7206655fd84))
#define TP_TUNER_UUID_COMMAND                                                                      \
    BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x2c28159e, 0x1502, 0x4858, 0x8409, 0xd7206655fd85))
#define TP_TUNER_UUID_STREAM                                                                       \
    BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x2c28159e, 0x1502, 0x4858, 0x8409, 0xd7206655fd86))

#define TP_TUNER_CMD_MAX 64
#define TP_TUNER_CMD_QUEUE_DEPTH 4
#define TP_TUNER_SUB_QUEUE_DEPTH 8
#define TP_TUNER_CMD_MAX_TOKENS 3
#define TP_TUNER_LINE_MAX 160
#define TP_TUNER_STREAM_SIZE 4096
#define TP_TUNER_NOTIFY_MAX 244
#define TP_TUNER_NOTIFY_MIN 20
#define TP_TUNER_NOTIFY_RETRY_MS 5
#define TP_TUNER_NOTIFY_RETRY_MAX 200
#define TP_TUNER_LEFT_TIMEOUT_MS 1000
/* タイムアウト後に遅れて届いた応答を次のコマンドに誤帰属しないよう、次の L コマンドを待たせる時間 */
#define TP_TUNER_LEFT_COOLDOWN_MS 200

/* ---- 出力ストリーム(リングバッファ → stream 通知) ---- */

RING_BUF_DECLARE(stream_rb, TP_TUNER_STREAM_SIZE);
static struct k_spinlock stream_lock;
static bool stream_subscribed;
static int stream_retries;

static void stream_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(stream_work, stream_work_cb);

static void stream_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value);
static ssize_t command_write(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf,
                             uint16_t len, uint16_t offset, uint8_t flags);

BT_GATT_SERVICE_DEFINE(tp_tuner_svc, BT_GATT_PRIMARY_SERVICE(TP_TUNER_UUID_SERVICE),
                       BT_GATT_CHARACTERISTIC(TP_TUNER_UUID_COMMAND,
                                              BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
                                              BT_GATT_PERM_WRITE_ENCRYPT, NULL, command_write,
                                              NULL),
                       BT_GATT_CHARACTERISTIC(TP_TUNER_UUID_STREAM, BT_GATT_CHRC_NOTIFY,
                                              BT_GATT_PERM_READ_ENCRYPT, NULL, NULL, NULL),
                       BT_GATT_CCC(stream_ccc_changed,
                                   BT_GATT_PERM_READ_ENCRYPT | BT_GATT_PERM_WRITE_ENCRYPT));

/* attrs: 0 service, 1/2 command 宣言/値, 3/4 stream 宣言/値, 5 CCC */
#define TP_TUNER_STREAM_ATTR (&tp_tuner_svc.attrs[4])

static void stream_reset(void) {
    k_spinlock_key_t key = k_spin_lock(&stream_lock);

    ring_buf_reset(&stream_rb);
    k_spin_unlock(&stream_lock, key);
}

static void stream_put(char side, const char *text, bool warn_on_full) {
    char line[TP_TUNER_LINE_MAX];
    int len;
    bool stored;
    k_spinlock_key_t key;

    if (!stream_subscribed) {
        return;
    }
    len = snprintf(line, sizeof(line), "%c %s\n", side, text);
    if (len < 0) {
        return;
    }
    if (len >= (int)sizeof(line)) {
        LOG_WRN("stream line truncated (%d bytes)", len);
        len = sizeof(line) - 1;
        line[len - 1] = '\n';
    }

    key = k_spin_lock(&stream_lock);
    stored = ring_buf_space_get(&stream_rb) >= (uint32_t)len &&
             ring_buf_put(&stream_rb, (const uint8_t *)line, len) == (uint32_t)len;
    k_spin_unlock(&stream_lock, key);

    if (!stored) {
        if (warn_on_full) {
            LOG_WRN("stream full, line dropped");
        }
        return;
    }
    (void)k_work_schedule(&stream_work, K_NO_WAIT);
}

static void stream_put_line(char side, const char *text) {
    stream_put(side, text, true);
}

/* ライブフレーム用。次のフレームで追いつくので、満杯なら黙って捨てる */
static void stream_put_line_lossy(char side, const char *text) {
    stream_put(side, text, false);
}

static void find_subscribed_conn(struct bt_conn *conn, void *data) {
    struct bt_conn **out = data;

    if (*out == NULL && bt_gatt_is_subscribed(conn, TP_TUNER_STREAM_ATTR, BT_GATT_CCC_NOTIFY)) {
        *out = bt_conn_ref(conn);
    }
}

/* システムワークキュー上でのみ呼ぶ(stream_work と cmd_work は同じスレッドで直列) */
static void stream_flush(void) {
    struct bt_conn *conn = NULL;
    uint16_t mtu;
    uint32_t chunk;

    bt_conn_foreach(BT_CONN_TYPE_LE, find_subscribed_conn, &conn);
    if (conn == NULL) {
        stream_reset();
        return;
    }

    mtu = bt_gatt_get_mtu(conn);
    chunk = mtu > TP_TUNER_NOTIFY_MIN + 3 ? MIN(mtu - 3, TP_TUNER_NOTIFY_MAX) : TP_TUNER_NOTIFY_MIN;

    while (true) {
        uint8_t *data;
        uint32_t size;
        int ret;
        k_spinlock_key_t key;

        key = k_spin_lock(&stream_lock);
        size = ring_buf_get_claim(&stream_rb, &data, chunk);
        k_spin_unlock(&stream_lock, key);
        if (size == 0) {
            break;
        }

        ret = bt_gatt_notify(conn, TP_TUNER_STREAM_ATTR, data, size);

        key = k_spin_lock(&stream_lock);
        (void)ring_buf_get_finish(&stream_rb, ret == 0 ? size : 0);
        k_spin_unlock(&stream_lock, key);

        if (ret == 0) {
            stream_retries = 0;
            continue;
        }
        if (ret == -ENOTCONN || ret == -EINVAL) {
            LOG_WRN("stream subscriber gone (%d), buffer dropped", ret);
            stream_retries = 0;
            stream_reset();
            break;
        }
        if (++stream_retries > TP_TUNER_NOTIFY_RETRY_MAX) {
            LOG_WRN("stream notify keeps failing (%d), buffer dropped", ret);
            stream_retries = 0;
            stream_reset();
            break;
        }
        (void)k_work_reschedule(&stream_work, K_MSEC(TP_TUNER_NOTIFY_RETRY_MS));
        break;
    }

    bt_conn_unref(conn);
}

static void stream_work_cb(struct k_work *work) {
    ARG_UNUSED(work);
    stream_flush();
}

/* ---- command 書き込み → コマンドキュー ---- */

K_MSGQ_DEFINE(tp_tuner_cmd_msgq, TP_TUNER_CMD_MAX + 1, TP_TUNER_CMD_QUEUE_DEPTH, 1);

/*
 * 購読の開始/終了で左手へ送る内部コマンド。ホストのコマンドより先に処理し、
 * 応答は stream に出さない(ホストが自分のコマンドの応答と取り違えないように)
 */
K_MSGQ_DEFINE(tp_tuner_sub_msgq, TP_TUNER_CMD_MAX + 1, TP_TUNER_SUB_QUEUE_DEPTH, 1);

static void cmd_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(cmd_work, cmd_work_cb);
static int64_t left_cooldown_until;

static void sub_request(const char *args) {
    char line[TP_TUNER_CMD_MAX + 1];

    strncpy(line, args, sizeof(line) - 1);
    line[sizeof(line) - 1] = '\0';
    if (k_msgq_put(&tp_tuner_sub_msgq, line, K_NO_WAIT) != 0) {
        LOG_WRN("subscription command queue full, '%s' dropped", args);
        return;
    }
    (void)k_work_schedule(&cmd_work, K_NO_WAIT);
}

static void stream_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value) {
    ARG_UNUSED(attr);
    stream_subscribed = value == BT_GATT_CCC_NOTIFY;
    LOG_INF("stream %s", stream_subscribed ? "subscribed" : "unsubscribed");
    if (stream_subscribed) {
        sub_request("summary on");
        return;
    }
    stream_reset();
    (void)iqs9151_dev_live_enable(false, 0);
    sub_request("summary off");
    sub_request("live off");
}

static ssize_t command_write(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf,
                             uint16_t len, uint16_t offset, uint8_t flags) {
    char line[TP_TUNER_CMD_MAX + 1];

    ARG_UNUSED(conn);
    ARG_UNUSED(attr);
    ARG_UNUSED(flags);

    if (offset != 0) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
    }
    if (len > TP_TUNER_CMD_MAX) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
    }

    memcpy(line, buf, len);
    line[len] = '\0';
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
        line[--len] = '\0';
    }

    if (k_msgq_put(&tp_tuner_cmd_msgq, line, K_NO_WAIT) != 0) {
        return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
    }
    (void)k_work_schedule(&cmd_work, K_NO_WAIT);
    return len;
}

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

static void left_failf(const struct left_pending *p, const char *fmt, ...) {
    char buf[TP_TUNER_LINE_MAX];
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
    } else if (strcmp(argv[0], "get") == 0 || strcmp(argv[0], "trace") == 0) {
        left_fail(&pending, "ERR unsupported");
        return;
    } else {
        left_failf(&pending, "ERR unknown command %s", argv[0]);
        return;
    }

    left_send(pending);
}

/* ---- ローカル(右手)コマンド ---- */

static void local_out(void *ctx, const char *line) {
    ARG_UNUSED(ctx);
    stream_put_line('R', line);
    if (ring_buf_size_get(&stream_rb) >= TP_TUNER_STREAM_SIZE / 2) {
        stream_flush();
    }
}

static void run_local(const char *args) {
    (void)iqs9151_cmd_exec(NULL, args, local_out, NULL);
    stream_put_line('R', ".");
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
        } else if (k_msgq_get(&tp_tuner_cmd_msgq, line, K_NO_WAIT) != 0) {
            break;
        } else if (strncmp(line, "R ", 2) == 0) {
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

    if (!left_peek(&p) || p.cmd == LEFT_CMD_LIST || p.cmd == LEFT_CMD_INFO || p.op != code) {
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

/* 左手のライブフレームを USB の trace と同じ T F 行にする(rel・flags・pending は持たないので 0) */
static void handle_live(uint8_t type, uint16_t code, uint32_t value) {
    struct tp_tuner_live_frame live;
    struct iqs9151_frame_info f = {0};
    char buf[TP_TUNER_LINE_MAX];

    if (!stream_subscribed || !tp_tuner_live_unpack(type, code, value, &live)) {
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
    stream_put_line_lossy('L', buf);
}

static void left_event_handler(struct input_event *evt) {
    if (evt->type < TP_TUNER_EV_FIRST) {
        return;
    }
    if (evt->type >= TP_TUNER_EV_LIVE_FIRST && evt->type <= TP_TUNER_EV_LIVE_LAST) {
        handle_live(evt->type, evt->code, (uint32_t)evt->value);
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
    default:
        LOG_WRN("unknown tp_tuner event type %u", evt->type);
        break;
    }
}

INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_NODELABEL(trackpad_split_l)), left_event_handler);

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
    stream_put_line_lossy('R', buf);
}

static int tp_tuner_central_init(void) {
    iqs9151_dev_set_summary_callback(local_summary_cb, NULL);
    iqs9151_dev_set_frame_callback(local_frame_cb, NULL);
    return 0;
}

SYS_INIT(tp_tuner_central_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
