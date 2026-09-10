/*
 * tp-tuner 左手(peripheral)側。
 * central から behavior "tp_param" で届いた要求を実行し、応答・試行要約・ライブフレームを
 * 左トラックパッド用 zmk,input-split(reg 1)の入力イベントとして central へ送る。
 */

#include <zephyr/device.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>

#include <zmk/event_manager.h>
#include <zmk/events/split_peripheral_status_changed.h>
#include <zmk/split/peripheral.h>
#include <zmk/split/transport/types.h>

#include <iqs9151_params.h>

#include "lalapad_diag.h"
#include "tp_tuner_proto.h"

LOG_MODULE_REGISTER(tp_tuner, CONFIG_ZMK_LOG_LEVEL);

#define TP_TUNER_QUEUE_DEPTH 4
#define TP_TUNER_RETRY_MS 10
#define TP_TUNER_RETRY_MAX 50
/*
 * central の peripheral_event_msgq(左手のキー入力とも共用)を溢れさせないよう、
 * 1 回の work で送る通知数を絞って PACE_MS 空ける
 */
#define TP_TUNER_BURST_MAX 2
#define TP_TUNER_PACE_MS 10

struct tp_tuner_request {
    uint32_t op;
    uint32_t value;
};

enum tp_tuner_job_kind {
    TP_TUNER_JOB_NONE,
    TP_TUNER_JOB_SUMMARY,
    TP_TUNER_JOB_REQUEST,
};

/* 送信中のジョブ。send_work(システムワークキュー)だけが触る */
static struct {
    enum tp_tuner_job_kind kind;
    uint32_t words[IQS9151_SUMMARY_WORDS];
    struct tp_tuner_request req;
    int ret;
    uint32_t stats[TP_TUNER_STAT_COUNT];
    size_t pos;
    size_t total;
    int retries;
} job;

/* 最新のライブフレーム 1 件。上書きし、送れなければ捨てる */
struct tp_tuner_live_event {
    uint8_t type;
    uint16_t code;
    uint32_t value;
    uint16_t hold;
};
static struct {
    bool valid;
    struct tp_tuner_live_event ev;
} live_slot;
static struct k_spinlock live_lock;
/* central に知らせた hold 中のボタン。send_work だけが触る */
static uint16_t live_hold_sent;

/* central が stream を購読している間だけ要約を転送する(SUMMARY オペコードで切り替え) */
static bool forward_summary;

K_MSGQ_DEFINE(tp_tuner_summary_msgq, sizeof(uint32_t) * IQS9151_SUMMARY_WORDS,
              TP_TUNER_QUEUE_DEPTH, 4);
K_MSGQ_DEFINE(tp_tuner_request_msgq, sizeof(struct tp_tuner_request), TP_TUNER_QUEUE_DEPTH, 4);

static void send_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(send_work, send_work_cb);

static const struct device *const trackpad = DEVICE_DT_GET_ANY(azoteq_iqs9151);

static void live_clear(void) {
    k_spinlock_key_t key = k_spin_lock(&live_lock);

    live_slot.valid = false;
    k_spin_unlock(&live_lock, key);
}

static bool live_pending(void) {
    k_spinlock_key_t key = k_spin_lock(&live_lock);
    bool valid = live_slot.valid;

    k_spin_unlock(&live_lock, key);
    return valid;
}

static bool live_take(struct tp_tuner_live_event *out) {
    k_spinlock_key_t key = k_spin_lock(&live_lock);
    bool valid = live_slot.valid;

    if (valid) {
        *out = live_slot.ev;
        live_slot.valid = false;
    }
    k_spin_unlock(&live_lock, key);
    return valid;
}

static void live_restore(const struct tp_tuner_live_event *ev) {
    k_spinlock_key_t key = k_spin_lock(&live_lock);

    if (!live_slot.valid) {
        live_slot.ev = *ev;
        live_slot.valid = true;
    }
    k_spin_unlock(&live_lock, key);
}

static int report_input(uint8_t type, uint16_t code, uint32_t value) {
    struct zmk_split_transport_peripheral_event ev = {
        .type = ZMK_SPLIT_TRANSPORT_PERIPHERAL_EVENT_TYPE_INPUT_EVENT,
        .data = {.input_event = {
                     .reg = TP_TUNER_SPLIT_REG,
                     .sync = 0,
                     .type = type,
                     .code = code,
                     .value = (int32_t)value,
                 }}};

    return zmk_split_peripheral_report_event(&ev);
}

/* ボタンが変わったら HOLD を先に送る。どちらも送れなければ捨てて再試行しない */
static int send_live(const struct tp_tuner_live_event *live) {
    int ret;

    if (live->hold == 0) {
        live_hold_sent = 0;
    } else if (live->hold != live_hold_sent) {
        ret = report_input(TP_TUNER_EV_LIVE_HOLD, live->hold, 0);
        if (ret != 0) {
            return ret;
        }
        live_hold_sent = live->hold;
    }
    return report_input(live->type, live->code, live->value);
}

static void collect_stats(uint32_t *vals) {
    struct iqs9151_stats drv;
    struct lalapad_diag_stats diag;

    iqs9151_dev_stats_get(&drv, true);
    lalapad_diag_snapshot(&diag, true);
    vals[TP_TUNER_STAT_END] = 0;
    vals[TP_TUNER_STAT_FRAME_N] = drv.frame_count;
    vals[TP_TUNER_STAT_FRAME_MAX_US] = drv.frame_max_us;
    vals[TP_TUNER_STAT_FRAME_AVG_US] = drv.frame_avg_us;
    vals[TP_TUNER_STAT_FRAME_GAP_MAX_MS] = drv.frame_gap_max_ms;
    vals[TP_TUNER_STAT_I2C_ERR] = drv.i2c_errors;
    vals[TP_TUNER_STAT_I2C_MAX_US] = drv.i2c_max_us;
    vals[TP_TUNER_STAT_RESET_N] = drv.show_reset_count;
    vals[TP_TUNER_STAT_CPU_MAX_US] = drv.frame_cpu_max_us;
    vals[TP_TUNER_STAT_RDY_MISS] = drv.rdy_miss;
    vals[TP_TUNER_STAT_ISR_N] = drv.isr_count;
    vals[TP_TUNER_STAT_ISR_RDY_LOW] = drv.isr_rdy_low;
    vals[TP_TUNER_STAT_ISR_TO_READ_MAX_US] = drv.isr_to_read_max_us;
    vals[TP_TUNER_STAT_I2C_AVG_US] = drv.i2c_avg_us;
    vals[TP_TUNER_STAT_WQ_LATE_MAX_US] = diag.wq_late_max_us;
    vals[TP_TUNER_STAT_WQ_LATE_OVER3] = diag.wq_late_over3;
    vals[TP_TUNER_STAT_POS_LOCAL] = diag.pos_local;
    vals[TP_TUNER_STAT_POS_REMOTE] = diag.pos_remote;
    vals[TP_TUNER_STAT_NOTIFY_FAIL] = diag.notify_fail;
    vals[TP_TUNER_STAT_LINK_INT_US] = diag.link_int_us;
    vals[TP_TUNER_STAT_LINK_LAT] = diag.link_lat;
    vals[TP_TUNER_STAT_LINK_TO_MS] = diag.link_to_ms;
    vals[TP_TUNER_STAT_LINK_TX_LEN] = diag.link_tx_len;
}

static int exec_request(const struct tp_tuner_request *req) {
    if (req->op < TP_TUNER_OP_BASE) {
        const struct iqs9151_param_def *def = iqs9151_param_def_at(req->op);

        if (def == NULL) {
            return -ENOENT;
        }
        return iqs9151_dev_param_set(trackpad, def->name, (int32_t)req->value);
    }

    switch (req->op) {
    case TP_TUNER_OP_RESET: {
        int ret = iqs9151_dev_param_reset(trackpad);
        int clear_ret = iqs9151_settings_clear();

        if (clear_ret != 0) {
            LOG_WRN("settings clear failed (%d)", clear_ret);
        }
        return ret;
    }
    case TP_TUNER_OP_REATI:
        return iqs9151_dev_request_reati(trackpad);
    case TP_TUNER_OP_SAVE:
        return iqs9151_settings_save(trackpad);
    case TP_TUNER_OP_SUMMARY:
        forward_summary = req->value != 0;
        if (!forward_summary) {
            k_msgq_purge(&tp_tuner_summary_msgq);
        }
        return 0;
    case TP_TUNER_OP_LIVE: {
        int ret = iqs9151_dev_live_enable(req->value != 0, (uint16_t)req->value);

        live_clear();
        live_hold_sent = 0;
        return ret;
    }
    case TP_TUNER_OP_STATS:
        collect_stats(job.stats);
        return 0;
    case TP_TUNER_OP_DUMP:
    case TP_TUNER_OP_INFO:
        return 0;
    default:
        return -ENOTSUP;
    }
}

static uint32_t status_word(void) {
    int64_t uptime_s = k_uptime_get() / 1000;
    uint32_t uptime_capped = (uint32_t)MIN(uptime_s, (int64_t)TP_TUNER_STATUS_UPTIME_MASK);

    return TP_TUNER_STATUS_ENCODE(iqs9151_settings_loaded(), forward_summary,
                                  iqs9151_param_count(), uptime_capped);
}

static bool start_next_job(void) {
    if (k_msgq_get(&tp_tuner_request_msgq, &job.req, K_NO_WAIT) == 0) {
        job.kind = TP_TUNER_JOB_REQUEST;
        job.ret = exec_request(&job.req);
        if (job.req.op == TP_TUNER_OP_DUMP) {
            job.total = iqs9151_param_count() + 1;
        } else if (job.req.op == TP_TUNER_OP_STATS) {
            job.total = TP_TUNER_STAT_COUNT;
        } else {
            job.total = 1;
        }
    } else if (k_msgq_get(&tp_tuner_summary_msgq, job.words, K_NO_WAIT) == 0) {
        job.kind = TP_TUNER_JOB_SUMMARY;
        job.total = IQS9151_SUMMARY_WORDS;
    } else {
        return false;
    }
    job.pos = 0;
    job.retries = 0;
    return true;
}

static void build_event(struct zmk_split_transport_peripheral_event *ev) {
    uint8_t type;
    uint16_t code = 0;
    uint32_t value;

    if (job.kind == TP_TUNER_JOB_SUMMARY) {
        type = TP_TUNER_EV_SUMMARY;
        code = job.pos;
        value = job.words[job.pos];
    } else if (job.req.op == TP_TUNER_OP_DUMP && job.pos + 1 < job.total) {
        int32_t current = 0;

        (void)iqs9151_dev_param_get(trackpad, iqs9151_param_def_at(job.pos)->name, &current);
        type = TP_TUNER_EV_PARAM;
        code = job.pos;
        value = (uint32_t)current;
    } else if (job.req.op == TP_TUNER_OP_STATS) {
        /* id 1..COUNT-1 を順に送り、最後に id 0 で終端 */
        uint16_t id = job.pos + 1 < TP_TUNER_STAT_COUNT ? (uint16_t)(job.pos + 1) : 0;

        type = TP_TUNER_EV_STATS;
        code = id;
        value = job.stats[id];
    } else if (job.req.op == TP_TUNER_OP_DUMP || job.req.op == TP_TUNER_OP_INFO) {
        type = TP_TUNER_EV_STATUS;
        value = status_word();
    } else {
        type = TP_TUNER_EV_ACK;
        code = job.req.op;
        value = (uint32_t)job.ret;
    }

    *ev = (struct zmk_split_transport_peripheral_event){
        .type = ZMK_SPLIT_TRANSPORT_PERIPHERAL_EVENT_TYPE_INPUT_EVENT,
        .data = {.input_event = {
                     .reg = TP_TUNER_SPLIT_REG,
                     .sync = 0,
                     .type = type,
                     .code = code,
                     .value = (int32_t)value,
                 }}};
}

static void send_work_cb(struct k_work *work) {
    int sent = 0;

    ARG_UNUSED(work);

    while (true) {
        struct zmk_split_transport_peripheral_event ev;
        struct tp_tuner_live_event live;
        int ret;

        if (!live_pending() && job.kind == TP_TUNER_JOB_NONE && !start_next_job()) {
            return;
        }
        if (sent >= TP_TUNER_BURST_MAX) {
            (void)k_work_reschedule(&send_work, K_MSEC(TP_TUNER_PACE_MS));
            return;
        }

        /* ライブフレームは要約・応答より先に送り、送れなければ再試行せず捨てる */
        if (live_take(&live)) {
            ret = send_live(&live);
            if (ret == 0) {
                sent++;
                continue;
            }
            /*
             * 「離した」フレームはドライバが 1 回しか呼ばず、落ちると画面が指ありのまま残るので、
             * 一時的な失敗ならスロットへ戻して次の周期で再送する(新しいフレームが来れば上書きされる)
             */
            if (live.type == TP_TUNER_EV_LIVE_0F &&
                (ret == -ENOMEM || ret == -EAGAIN || ret == -ENOBUFS)) {
                live_restore(&live);
                (void)k_work_reschedule(&send_work, K_MSEC(TP_TUNER_PACE_MS));
                return;
            }
            LOG_DBG("live frame dropped (%d)", ret);
            lalapad_diag_note_notify_fail();
            continue;
        }

        build_event(&ev);
        ret = zmk_split_peripheral_report_event(&ev);
        if (ret == -ENOMEM || ret == -EAGAIN || ret == -ENOBUFS) {
            if (++job.retries > TP_TUNER_RETRY_MAX) {
                LOG_WRN("job %d dropped at %u/%u after %d retries", job.kind, (unsigned)job.pos,
                        (unsigned)job.total, TP_TUNER_RETRY_MAX);
                lalapad_diag_note_notify_fail();
                job.kind = TP_TUNER_JOB_NONE;
                continue;
            }
            (void)k_work_reschedule(&send_work, K_MSEC(TP_TUNER_RETRY_MS));
            return;
        }
        if (ret < 0) {
            if (ret == -ENOTCONN) {
                LOG_DBG("job %d dropped: central not connected", job.kind);
            } else {
                LOG_WRN("job %d dropped at %u/%u (%d)", job.kind, (unsigned)job.pos,
                        (unsigned)job.total, ret);
            }
            job.kind = TP_TUNER_JOB_NONE;
            continue;
        }

        sent++;
        job.retries = 0;
        if (++job.pos >= job.total) {
            job.kind = TP_TUNER_JOB_NONE;
        }
    }
}

int tp_tuner_peripheral_request(uint32_t op, uint32_t value) {
    struct tp_tuner_request req = {.op = op, .value = value};

    if (k_msgq_put(&tp_tuner_request_msgq, &req, K_NO_WAIT) != 0) {
        LOG_WRN("request queue full, op 0x%x dropped", op);
        return -ENOMEM;
    }
    (void)k_work_schedule(&send_work, K_NO_WAIT);
    return 0;
}

static void summary_cb(const struct iqs9151_attempt_summary *summary, void *user_data) {
    uint32_t words[IQS9151_SUMMARY_WORDS];

    ARG_UNUSED(user_data);
    if (!forward_summary) {
        return;
    }
    iqs9151_summary_pack(summary, words);
    if (k_msgq_put(&tp_tuner_summary_msgq, words, K_NO_WAIT) != 0) {
        LOG_WRN("summary queue full, attempt dropped");
        return;
    }
    (void)k_work_schedule(&send_work, K_NO_WAIT);
}

static void frame_cb(const struct iqs9151_frame_info *finfo, void *user_data) {
    struct tp_tuner_live_frame frame = {
        .fingers = finfo->fingers,
        .hold = finfo->hold,
        .mode2f = finfo->mode2f,
        .f1x = finfo->f1x,
        .f1y = finfo->f1y,
        .f2x = finfo->f2x,
        .f2y = finfo->f2y,
    };
    uint8_t type;
    uint16_t code;
    uint32_t value;
    k_spinlock_key_t key;

    ARG_UNUSED(user_data);
    tp_tuner_live_pack(&frame, &type, &code, &value);

    key = k_spin_lock(&live_lock);
    live_slot.ev.type = type;
    live_slot.ev.code = code;
    live_slot.ev.value = value;
    live_slot.ev.hold = finfo->hold;
    live_slot.valid = true;
    k_spin_unlock(&live_lock, key);

    (void)k_work_schedule(&send_work, K_NO_WAIT);
}

/* central との接続が切れたらライブと要約転送を止める(再購読時に central が on を送り直す) */
static int peripheral_status_listener(const zmk_event_t *eh) {
    const struct zmk_split_peripheral_status_changed *ev =
        as_zmk_split_peripheral_status_changed(eh);

    if (ev != NULL && !ev->connected) {
        (void)iqs9151_dev_live_enable(false, 0);
        live_clear();
        live_hold_sent = 0;
        forward_summary = false;
        k_msgq_purge(&tp_tuner_summary_msgq);
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(tp_tuner_peripheral, peripheral_status_listener);
ZMK_SUBSCRIPTION(tp_tuner_peripheral, zmk_split_peripheral_status_changed);

static int tp_tuner_peripheral_init(void) {
    iqs9151_dev_set_summary_callback(summary_cb, NULL);
    iqs9151_dev_set_frame_callback(frame_cb, NULL);
    return 0;
}

SYS_INIT(tp_tuner_peripheral_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
