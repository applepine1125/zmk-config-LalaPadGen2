/*
 * tp-tuner 右手(central)側。ボンド済みホスト向けの GATT サービス(command 書き込み /
 * stream 通知)、stream リングバッファの通知処理、ホスト接続確立時の LE データ長更新要求を持つ。
 */

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/ring_buffer.h>

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <iqs9151_cmd.h>
#include <iqs9151_params.h>

#include "lalapad_diag.h"
#include "tp_tuner_internal.h"

LOG_MODULE_DECLARE(tp_tuner, CONFIG_ZMK_LOG_LEVEL);

#define TP_TUNER_UUID_SERVICE                                                                      \
    BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x2c28159e, 0x1502, 0x4858, 0x8409, 0xd7206655fd84))
#define TP_TUNER_UUID_COMMAND                                                                      \
    BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x2c28159e, 0x1502, 0x4858, 0x8409, 0xd7206655fd85))
#define TP_TUNER_UUID_STREAM                                                                       \
    BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x2c28159e, 0x1502, 0x4858, 0x8409, 0xd7206655fd86))

#define TP_TUNER_STREAM_RESERVE (TP_TUNER_STREAM_SIZE / 4)
#define TP_TUNER_NOTIFY_MAX 244
#define TP_TUNER_NOTIFY_MIN 20
#define TP_TUNER_NOTIFY_RETRY_MS 5
#define TP_TUNER_NOTIFY_RETRY_MAX 200
/*
 * 1 回の flush で送る通知数。ATT の TX メタ(BT_CONN_TX_MAX=10)を使い切ると
 * HID レポートがメタ待ちになるので、半分以上を常に残す
 */
#define TP_TUNER_NOTIFY_BURST 1
/* 通知 1 件ごとに空ける時間。HID レポート(hog スレッド)に送信バッファと接続イベントを譲る */
#define TP_TUNER_NOTIFY_PACE_MS 8
/* ライブ行を受け付ける未送信バイト数の上限。LL データ長 27 のときに表示が遅れて溜まらないようにする */
#define TP_TUNER_LOSSY_BACKLOG 512
/* LL データ長がこれ未満なら DLE 未交渉とみなし、通知を 1 パケットに収める */
#define TP_TUNER_DLE_MIN_LEN 100
/*
 * ライブ行は「最初の未送信行を追記してからこの時間」か「未送信分が 1 通知分(chunk)溜まった」の
 * 早い方で通知する。60Hz のフレームは 16.7ms 間隔なので短い待ちでは 1 行ずつしか溜まらない
 */
#define TP_TUNER_LIVE_BATCH_MS 50

/* ---- 出力ストリーム(リングバッファ → stream 通知) ---- */

RING_BUF_DECLARE(stream_rb, TP_TUNER_STREAM_SIZE);
static struct k_spinlock stream_lock;
bool stream_subscribed;
static int stream_retries;
/* 直近の flush で使った 1 通知の大きさ(MTU - 3、上限 244)。ライブ行のまとめ判定に使う */
static uint32_t stream_chunk = TP_TUNER_NOTIFY_MAX;
/* 前回の flush 以降に追記したライブ行のバイト数(stream_lock 下で更新) */
static uint32_t stream_lossy_pending;

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

/* 次に通知してよい時刻(stream_flush が更新) */
static int64_t stream_paced_until;

static void stream_put(char side, const char *text, bool lossy) {
    char line[TP_TUNER_LINE_MAX];
    int len;
    uint32_t need;
    bool stored;
    bool batch_full = false;
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
    need = (uint32_t)len + (lossy ? TP_TUNER_STREAM_RESERVE : 0);

    key = k_spin_lock(&stream_lock);
    stored = ring_buf_space_get(&stream_rb) >= need &&
             (!lossy || ring_buf_size_get(&stream_rb) < TP_TUNER_LOSSY_BACKLOG) &&
             ring_buf_put(&stream_rb, (const uint8_t *)line, len) == (uint32_t)len;
    if (stored && lossy) {
        stream_lossy_pending += (uint32_t)len;
        batch_full = stream_lossy_pending >= stream_chunk;
    }
    k_spin_unlock(&stream_lock, key);

    if (!stored) {
        if (!lossy) {
            LOG_WRN("stream full, line dropped");
        }
        return;
    }
    if (!lossy || batch_full) {
        int64_t wait = stream_paced_until - k_uptime_get();

        /* 直前の通知からの間隔は詰めない(HID に譲るためのペーシング) */
        (void)k_work_reschedule(&stream_work, wait > 0 ? K_MSEC(wait) : K_NO_WAIT);
    } else {
        (void)k_work_schedule(&stream_work, K_MSEC(TP_TUNER_LIVE_BATCH_MS));
    }
}

void stream_put_line(char side, const char *text) {
    stream_put(side, text, false);
}

/*
 * ライブフレーム用。指ありのフレームは次のフレームで追いつくので余裕が無ければ黙って捨てるが、
 * 「離した」フレームはドライバが 1 回しか出さず、落ちると画面が指ありのまま残るので通常行として入れる
 */
void stream_put_frame(char side, const char *text, bool released) {
    stream_put(side, text, !released);
}

static void find_subscribed_conn(struct bt_conn *conn, void *data) {
    struct bt_conn **out = data;

    if (*out == NULL && bt_gatt_is_subscribed(conn, TP_TUNER_STREAM_ATTR, BT_GATT_CCC_NOTIFY)) {
        *out = bt_conn_ref(conn);
    }
}

/* システムワークキュー上でのみ呼ぶ(stream_work と cmd_work は同じスレッドで直列) */
void stream_flush(void) {
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
#if defined(CONFIG_BT_USER_DATA_LEN_UPDATE)
    {
        struct bt_conn_info info;

        /* DLE 前(27 バイト)は 244 バイトの通知が LL パケット 10 個に分かれ、HID レポートがその後ろで待つ */
        if (bt_conn_get_info(conn, &info) == 0 && info.le.data_len != NULL &&
            info.le.data_len->tx_max_len < TP_TUNER_DLE_MIN_LEN) {
            chunk = TP_TUNER_NOTIFY_MIN;
        }
    }
#endif
    {
        k_spinlock_key_t key = k_spin_lock(&stream_lock);

        stream_chunk = chunk;
        stream_lossy_pending = 0;
        k_spin_unlock(&stream_lock, key);
    }

    for (int sent = 0;; sent++) {
        uint8_t *data;
        uint32_t size;
        int ret;
        k_spinlock_key_t key;

        if (sent >= TP_TUNER_NOTIFY_BURST) {
            if (ring_buf_size_get(&stream_rb) > 0) {
                (void)k_work_reschedule(&stream_work, K_MSEC(TP_TUNER_NOTIFY_PACE_MS));
            }
            break;
        }

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
            stream_paced_until = k_uptime_get() + TP_TUNER_NOTIFY_PACE_MS;
            continue;
        }
        lalapad_diag_note_notify_fail();
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

/*
 * 左手への summary on は購読開始時ではなく、購読中に最初のホスト L コマンドを処理する直前に送る
 * (tp_tuner_left.c の cmd_work_cb)。ボンド済みホストの再接続では CCC が復元されて購読中扱いに
 * なるため、ホストが command を書くまで有効扱いにしない。sub_summary_* は left.c の状態
 */
static void stream_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value) {
    ARG_UNUSED(attr);
    stream_subscribed = value == BT_GATT_CCC_NOTIFY;
    LOG_INF("stream %s", stream_subscribed ? "subscribed" : "unsubscribed");
    sub_summary_confirmed = false;
    sub_summary_tried = false;
    sub_summary_wanted = stream_subscribed;
    if (stream_subscribed) {
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

/* ---- ホスト接続の LE データ長 ---- */

/*
 * ZMK は BT_USER_DATA_LEN_UPDATE を select したまま bt_conn_le_data_len_update を呼ばないため、
 * tx_max_len が 27 のままになり Studio の indicate と stream の通知が細かく分割される。
 * ホスト(Mac)向けの接続(自分が peripheral 側)が確立したら work から最大値を要求する
 */
static struct bt_conn *data_len_conn;
static struct k_spinlock data_len_lock;

static void data_len_work_cb(struct k_work *work) {
    struct bt_conn *conn;
    k_spinlock_key_t key;
    int ret;

    ARG_UNUSED(work);
    key = k_spin_lock(&data_len_lock);
    conn = data_len_conn;
    data_len_conn = NULL;
    k_spin_unlock(&data_len_lock, key);
    if (conn == NULL) {
        return;
    }

    ret = bt_conn_le_data_len_update(conn, BT_LE_DATA_LEN_PARAM_MAX);
    if (ret < 0 && ret != -EALREADY) {
        LOG_WRN("LE data length update failed (%d)", ret);
    }
    bt_conn_unref(conn);
}

static K_WORK_DEFINE(data_len_work, data_len_work_cb);

static void host_connected(struct bt_conn *conn, uint8_t err) {
    struct bt_conn_info info;
    k_spinlock_key_t key;
    bool stored = false;

    if (err != 0 || bt_conn_get_info(conn, &info) != 0 || info.type != BT_CONN_TYPE_LE ||
        info.role != BT_CONN_ROLE_PERIPHERAL) {
        return;
    }

    key = k_spin_lock(&data_len_lock);
    if (data_len_conn == NULL) {
        data_len_conn = bt_conn_ref(conn);
        stored = true;
    }
    k_spin_unlock(&data_len_lock, key);
    if (stored) {
        k_work_submit(&data_len_work);
    }
}

BT_CONN_CB_DEFINE(tp_tuner_conn_cb) = {
    .connected = host_connected,
};
