#include "lalapad_diag.h"

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>

#include <stdio.h>
#include <string.h>

#include <zmk/event_manager.h>
#include <zmk/events/position_state_changed.h>

LOG_MODULE_REGISTER(lalapad_diag, CONFIG_ZMK_LOG_LEVEL);

#define DIAG_PROBE_PERIOD_MS 10
#define DIAG_LATE_THRESHOLD_US 3000
#define DIAG_LINE_MAX 160

static struct lalapad_diag_stats counters;
static struct k_spinlock counters_lock;

static int64_t probe_due_ticks;

/* syswq に 10ms 周期で積んだプローブの遅れを測る。他の work が長く syswq を占有していないかの目安 */
static void probe_cb(struct k_work *work) {
    int64_t now = k_uptime_ticks();
    int64_t late = now - probe_due_ticks;
    k_spinlock_key_t key;

    uint32_t late_us = late > 0 ? k_ticks_to_us_floor32((uint32_t)MIN(late, UINT32_MAX)) : 0U;

    ARG_UNUSED(work);

    if (late > 0) {
        key = k_spin_lock(&counters_lock);
        if (late_us > counters.wq_late_max_us) {
            counters.wq_late_max_us = late_us;
        }
        if (late_us > DIAG_LATE_THRESHOLD_US) {
            counters.wq_late_over3++;
        }
        k_spin_unlock(&counters_lock, key);
    }

    probe_due_ticks += k_ms_to_ticks_ceil64(DIAG_PROBE_PERIOD_MS);
    if (probe_due_ticks <= now) {
        probe_due_ticks = now + k_ms_to_ticks_ceil64(DIAG_PROBE_PERIOD_MS);
    }
    (void)k_work_schedule(k_work_delayable_from_work(work), K_TIMEOUT_ABS_TICKS(probe_due_ticks));
}

static K_WORK_DELAYABLE_DEFINE(probe_work, probe_cb);

static int position_listener(const zmk_event_t *eh) {
    const struct zmk_position_state_changed *ev = as_zmk_position_state_changed(eh);
    k_spinlock_key_t key;

    if (ev == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    key = k_spin_lock(&counters_lock);
    if (ev->source == ZMK_POSITION_STATE_CHANGE_SOURCE_LOCAL) {
        counters.pos_local++;
    } else {
        counters.pos_remote++;
    }
    k_spin_unlock(&counters_lock, key);
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(lalapad_diag, position_listener);
ZMK_SUBSCRIPTION(lalapad_diag, zmk_position_state_changed);

void lalapad_diag_note_notify_fail(void) {
    k_spinlock_key_t key = k_spin_lock(&counters_lock);

    counters.notify_fail++;
    k_spin_unlock(&counters_lock, key);
}

struct link_walk {
    iqs9151_cmd_out_t out;
    void *ctx;
    struct lalapad_diag_stats *first;
    int index;
};

static void link_cb(struct bt_conn *conn, void *user_data) {
    struct link_walk *walk = user_data;
    struct bt_conn_info info;
    char line[DIAG_LINE_MAX];

    if (bt_conn_get_info(conn, &info) != 0 || info.type != BT_CONN_TYPE_LE) {
        return;
    }
    uint32_t tx_len = 0;
    uint32_t rx_len = 0;

#if defined(CONFIG_BT_USER_DATA_LEN_UPDATE)
    if (info.le.data_len != NULL) {
        tx_len = info.le.data_len->tx_max_len;
        rx_len = info.le.data_len->rx_max_len;
    }
#endif
    if (walk->first != NULL && walk->index == 0) {
        walk->first->link_int_us = info.le.interval * 1250U;
        walk->first->link_lat = info.le.latency;
        walk->first->link_to_ms = info.le.timeout * 10U;
        walk->first->link_tx_len = tx_len;
    }
    if (walk->out != NULL) {
        snprintf(line, sizeof(line), "link%d role=%s int_us=%u lat=%u to_ms=%u tx_len=%u rx_len=%u", walk->index,
                 info.role == BT_CONN_ROLE_CENTRAL ? "central" : "peripheral",
                 (unsigned)(info.le.interval * 1250U), (unsigned)info.le.latency,
                 (unsigned)(info.le.timeout * 10U), (unsigned)tx_len, (unsigned)rx_len);
        walk->out(walk->ctx, line);
    }
    walk->index++;
}

static void take_counters(struct lalapad_diag_stats *out, bool reset) {
    k_spinlock_key_t key = k_spin_lock(&counters_lock);

    *out = counters;
    if (reset) {
        counters.wq_late_max_us = 0;
        counters.wq_late_over3 = 0;
        counters.pos_local = 0;
        counters.pos_remote = 0;
        counters.notify_fail = 0;
    }
    k_spin_unlock(&counters_lock, key);
}

void lalapad_diag_snapshot(struct lalapad_diag_stats *out, bool reset) {
    struct link_walk walk = {.first = out};

    take_counters(out, reset);
    out->link_int_us = 0;
    out->link_lat = 0;
    out->link_to_ms = 0;
    out->link_tx_len = 0;
    bt_conn_foreach(BT_CONN_TYPE_LE, link_cb, &walk);
}

void lalapad_diag_format(iqs9151_cmd_out_t out, void *ctx, bool reset) {
    struct lalapad_diag_stats s;
    struct link_walk walk = {.out = out, .ctx = ctx};
    char line[DIAG_LINE_MAX];

    take_counters(&s, reset);
    snprintf(line, sizeof(line),
             "stats wq_late_max_us=%u wq_late_over3=%u pos_local=%u pos_remote=%u notify_fail=%u",
             (unsigned)s.wq_late_max_us, (unsigned)s.wq_late_over3, (unsigned)s.pos_local,
             (unsigned)s.pos_remote, (unsigned)s.notify_fail);
    out(ctx, line);
    bt_conn_foreach(BT_CONN_TYPE_LE, link_cb, &walk);
}

static int lalapad_diag_init(void) {
    iqs9151_cmd_set_stats_hook(lalapad_diag_format);
    probe_due_ticks = k_uptime_ticks() + k_ms_to_ticks_ceil64(DIAG_PROBE_PERIOD_MS);
    (void)k_work_schedule(&probe_work, K_TIMEOUT_ABS_TICKS(probe_due_ticks));
    return 0;
}

SYS_INIT(lalapad_diag_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
