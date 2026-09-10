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

/*
 * ワークキューの遅れが閾値を超えたとき、直前の 10ms でどのスレッドが CPU を使っていたかを記録する。
 * どのスレッドにも時間が付かず idle も増えていなければ、フラッシュ消去などで CPU 自体が止まっていたと分かる
 */
#if defined(CONFIG_THREAD_RUNTIME_STATS) && defined(CONFIG_THREAD_MONITOR)
#define DIAG_THREAD_MAX 24
#define DIAG_NAME_MAX 24

struct thread_snap {
    k_tid_t tid;
    uint64_t cycles;
};

static struct thread_snap snap_prev[DIAG_THREAD_MAX];
static struct thread_snap snap_cur[DIAG_THREAD_MAX];
static int snap_prev_n;
static int snap_cur_n;
static char late_top_name[DIAG_NAME_MAX];
static uint32_t late_top_us;
static uint32_t late_idle_us;
static uint32_t late_event_us;

static void snap_cb(const struct k_thread *thread, void *user_data) {
    int *n = user_data;
    k_thread_runtime_stats_t rt;

    if (*n >= DIAG_THREAD_MAX || k_thread_runtime_stats_get((k_tid_t)thread, &rt) != 0) {
        return;
    }
    snap_cur[*n].tid = (k_tid_t)thread;
    snap_cur[*n].cycles = rt.execution_cycles;
    (*n)++;
}

static bool prev_cycles_of(k_tid_t tid, uint64_t *cycles) {
    for (int i = 0; i < snap_prev_n; i++) {
        if (snap_prev[i].tid == tid) {
            *cycles = snap_prev[i].cycles;
            return true;
        }
    }
    return false;
}

static void attribute_late(uint32_t late_us) {
    k_tid_t top = NULL;
    uint64_t top_delta = 0;
    uint64_t idle_delta = 0;

    for (int i = 0; i < snap_cur_n; i++) {
        uint64_t prev;
        uint64_t delta;
        const char *name;

        if (!prev_cycles_of(snap_cur[i].tid, &prev) || snap_cur[i].cycles < prev) {
            continue;
        }
        delta = snap_cur[i].cycles - prev;
        name = k_thread_name_get(snap_cur[i].tid);
        if (name != NULL && strncmp(name, "idle", 4) == 0) {
            idle_delta += delta;
            continue;
        }
        if (delta > top_delta) {
            top_delta = delta;
            top = snap_cur[i].tid;
        }
    }
    if (late_us <= late_event_us) {
        return;
    }
    late_event_us = late_us;
    late_top_us = k_cyc_to_us_floor32((uint32_t)MIN(top_delta, UINT32_MAX));
    late_idle_us = k_cyc_to_us_floor32((uint32_t)MIN(idle_delta, UINT32_MAX));
    if (top != NULL && k_thread_name_get(top) != NULL) {
        strncpy(late_top_name, k_thread_name_get(top), sizeof(late_top_name) - 1);
        late_top_name[sizeof(late_top_name) - 1] = 0;
    } else {
        strcpy(late_top_name, "?");
    }
}

static void snapshot_threads(uint32_t late_us) {
    snap_cur_n = 0;
    k_thread_foreach_unlocked(snap_cb, &snap_cur_n);
    if (late_us > DIAG_LATE_THRESHOLD_US) {
        attribute_late(late_us);
    }
    memcpy(snap_prev, snap_cur, sizeof(struct thread_snap) * snap_cur_n);
    snap_prev_n = snap_cur_n;
}

static void format_late_attribution(iqs9151_cmd_out_t out, void *ctx, bool reset) {
    char line[DIAG_LINE_MAX];

    snprintf(line, sizeof(line), "late_event_us=%u late_top=%s:%u late_idle_us=%u",
             (unsigned)late_event_us, late_top_name[0] ? late_top_name : "-", (unsigned)late_top_us,
             (unsigned)late_idle_us);
    out(ctx, line);
    if (reset) {
        late_event_us = 0;
        late_top_us = 0;
        late_idle_us = 0;
        late_top_name[0] = 0;
    }
}
#else
static void snapshot_threads(uint32_t late_us) { ARG_UNUSED(late_us); }
static void format_late_attribution(iqs9151_cmd_out_t out, void *ctx, bool reset) {
    ARG_UNUSED(out);
    ARG_UNUSED(ctx);
    ARG_UNUSED(reset);
}
#endif

static int64_t probe_due_ticks;

static void probe_cb(struct k_work *work) {
    int64_t now = k_uptime_ticks();
    int64_t late = now - probe_due_ticks;
    k_spinlock_key_t key;

    uint32_t late_us = late > 0 ? k_ticks_to_us_floor32((uint32_t)MIN(late, UINT32_MAX)) : 0U;

    ARG_UNUSED(work);

    snapshot_threads(late_us);
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
    format_late_attribution(out, ctx, reset);
    bt_conn_foreach(BT_CONN_TYPE_LE, link_cb, &walk);
}

static int lalapad_diag_init(void) {
    iqs9151_cmd_set_stats_hook(lalapad_diag_format);
    probe_due_ticks = k_uptime_ticks() + k_ms_to_ticks_ceil64(DIAG_PROBE_PERIOD_MS);
    (void)k_work_schedule(&probe_work, K_TIMEOUT_ABS_TICKS(probe_due_ticks));
    return 0;
}

SYS_INIT(lalapad_diag_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
