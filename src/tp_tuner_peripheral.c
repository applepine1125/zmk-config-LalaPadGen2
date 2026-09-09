/*
 * tp-tuner 左手(peripheral)側。
 * central から behavior "tp_param" で届いた要求を実行し、応答と試行要約を
 * zmk,input-split(reg 2)の入力イベントとして central へ送る。
 */

#define DT_DRV_COMPAT lalapad_tp_tuner_source

#include <zephyr/device.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <zmk/split/peripheral.h>
#include <zmk/split/transport/types.h>

#include <iqs9151_params.h>

#include "tp_tuner_proto.h"

LOG_MODULE_REGISTER(tp_tuner, CONFIG_ZMK_LOG_LEVEL);

#define TP_TUNER_QUEUE_DEPTH 4
#define TP_TUNER_RETRY_MS 10
#define TP_TUNER_RETRY_MAX 50

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
    size_t pos;
    size_t total;
    int retries;
} job;

K_MSGQ_DEFINE(tp_tuner_summary_msgq, sizeof(uint32_t) * IQS9151_SUMMARY_WORDS,
              TP_TUNER_QUEUE_DEPTH, 4);
K_MSGQ_DEFINE(tp_tuner_request_msgq, sizeof(struct tp_tuner_request), TP_TUNER_QUEUE_DEPTH, 4);

static void send_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(send_work, send_work_cb);

static const struct device *const trackpad = DEVICE_DT_GET_ANY(azoteq_iqs9151);

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
        iqs9151_dev_summary_enable(req->value != 0);
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

    return TP_TUNER_STATUS_ENCODE(iqs9151_settings_loaded(), iqs9151_dev_summary_enabled(),
                                  iqs9151_param_count(), uptime_capped);
}

static bool start_next_job(void) {
    if (k_msgq_get(&tp_tuner_request_msgq, &job.req, K_NO_WAIT) == 0) {
        job.kind = TP_TUNER_JOB_REQUEST;
        job.ret = exec_request(&job.req);
        job.total = job.req.op == TP_TUNER_OP_DUMP ? iqs9151_param_count() + 1 : 1;
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
    bool sync = true;

    if (job.kind == TP_TUNER_JOB_SUMMARY) {
        type = TP_TUNER_EV_SUMMARY;
        code = job.pos;
        value = job.words[job.pos];
        sync = job.pos + 1 == job.total;
    } else if (job.req.op == TP_TUNER_OP_DUMP && job.pos + 1 < job.total) {
        int32_t current = 0;

        (void)iqs9151_dev_param_get(trackpad, iqs9151_param_def_at(job.pos)->name, &current);
        type = TP_TUNER_EV_PARAM;
        code = job.pos;
        value = (uint32_t)current;
        sync = false;
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
                     .sync = sync ? 1 : 0,
                     .type = type,
                     .code = code,
                     .value = (int32_t)value,
                 }}};
}

static void send_work_cb(struct k_work *work) {
    ARG_UNUSED(work);

    while (true) {
        struct zmk_split_transport_peripheral_event ev;
        int ret;

        if (job.kind == TP_TUNER_JOB_NONE && !start_next_job()) {
            return;
        }

        build_event(&ev);
        ret = zmk_split_peripheral_report_event(&ev);
        if (ret == -ENOMEM || ret == -EAGAIN || ret == -ENOBUFS) {
            if (++job.retries > TP_TUNER_RETRY_MAX) {
                LOG_WRN("job %d dropped at %u/%u after %d retries", job.kind, (unsigned)job.pos,
                        (unsigned)job.total, TP_TUNER_RETRY_MAX);
                job.kind = TP_TUNER_JOB_NONE;
                continue;
            }
            (void)k_work_reschedule(&send_work, K_MSEC(TP_TUNER_RETRY_MS));
            return;
        }
        if (ret < 0) {
            LOG_WRN("job %d dropped at %u/%u (%d)", job.kind, (unsigned)job.pos,
                    (unsigned)job.total, ret);
            job.kind = TP_TUNER_JOB_NONE;
            continue;
        }

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
    if (!iqs9151_dev_summary_enabled()) {
        return;
    }
    iqs9151_summary_pack(summary, words);
    if (k_msgq_put(&tp_tuner_summary_msgq, words, K_NO_WAIT) != 0) {
        LOG_WRN("summary queue full, attempt dropped");
        return;
    }
    (void)k_work_schedule(&send_work, K_NO_WAIT);
}

static int tp_tuner_peripheral_init(void) {
    iqs9151_dev_set_summary_callback(summary_cb, NULL);
    return 0;
}

SYS_INIT(tp_tuner_peripheral_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);

/* tp_tuner_split_L の device に指す空デバイス。input_report はしない */
#if DT_HAS_COMPAT_STATUS_OKAY(DT_DRV_COMPAT)
DEVICE_DT_INST_DEFINE(0, NULL, NULL, NULL, NULL, POST_KERNEL, CONFIG_KERNEL_INIT_PRIORITY_DEFAULT,
                      NULL);
#endif
