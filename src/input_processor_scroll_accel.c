/*
 * Scroll acceleration curve input processor.
 *
 * Applies a speed-dependent gain to scroll (wheel) events so that slow
 * scrolls keep their full resolution while fast flicks are compressed.
 * Gain is interpolated linearly between low-gain (at or below low-speed)
 * and high-gain (at or above high-speed), speed measured in input units
 * per second with an EMA smoother. Remainders are accumulated per code
 * so sub-unit output is not lost.
 */

#define DT_DRV_COMPAT zmk_input_processor_scroll_accel

#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <drivers/input_processor.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#define SCROLL_ACCEL_MAX_CODES 4
#define SCROLL_ACCEL_GAIN_DEN 1000
/* Gaps longer than this are treated as a new gesture: speed/remainder reset */
#define SCROLL_ACCEL_MAX_EVENT_GAP_MS 100
#define SCROLL_ACCEL_MIN_DT_MS 1
#define SCROLL_ACCEL_EMA_SHIFT 2

struct scroll_accel_channel {
    int64_t last_ts_ms;
    int32_t speed_ema;
    int32_t remainder;
};

struct scroll_accel_data {
    struct scroll_accel_channel channels[SCROLL_ACCEL_MAX_CODES];
};

struct scroll_accel_config {
    uint8_t type;
    int32_t low_speed;
    int32_t high_speed;
    int32_t low_gain;
    int32_t high_gain;
    size_t codes_len;
    uint16_t codes[];
};

static int32_t scroll_accel_gain(const struct scroll_accel_config *cfg, int32_t speed) {
    if (speed <= cfg->low_speed) {
        return cfg->low_gain;
    }
    if (speed >= cfg->high_speed) {
        return cfg->high_gain;
    }
    return cfg->low_gain + ((cfg->high_gain - cfg->low_gain) * (speed - cfg->low_speed)) /
                               (cfg->high_speed - cfg->low_speed);
}

static int scroll_accel_handle_event(const struct device *dev, struct input_event *event,
                                     uint32_t param1, uint32_t param2,
                                     struct zmk_input_processor_state *state) {
    ARG_UNUSED(param1);
    ARG_UNUSED(param2);
    ARG_UNUSED(state);

    const struct scroll_accel_config *cfg = dev->config;
    struct scroll_accel_data *data = dev->data;

    if (event->type != cfg->type) {
        return ZMK_INPUT_PROC_CONTINUE;
    }

    int code_idx = -1;
    for (int i = 0; i < cfg->codes_len; i++) {
        if (cfg->codes[i] == event->code) {
            code_idx = i;
            break;
        }
    }
    if (code_idx < 0 || event->value == 0) {
        return ZMK_INPUT_PROC_CONTINUE;
    }

    struct scroll_accel_channel *ch = &data->channels[code_idx];
    const int64_t now_ms = k_uptime_get();
    const int64_t gap_ms = now_ms - ch->last_ts_ms;
    ch->last_ts_ms = now_ms;

    const int32_t abs_value = event->value < 0 ? -event->value : event->value;
    const int32_t dt_ms =
        (int32_t)CLAMP(gap_ms, SCROLL_ACCEL_MIN_DT_MS, SCROLL_ACCEL_MAX_EVENT_GAP_MS);
    const int32_t inst_speed = (abs_value * 1000) / dt_ms;

    if (gap_ms > SCROLL_ACCEL_MAX_EVENT_GAP_MS) {
        ch->speed_ema = inst_speed;
        ch->remainder = 0;
    } else {
        ch->speed_ema += (inst_speed - ch->speed_ema) / (1 << SCROLL_ACCEL_EMA_SHIFT);
    }

    const int32_t gain = scroll_accel_gain(cfg, ch->speed_ema);
    const int32_t acc = event->value * gain + ch->remainder;
    const int32_t scaled = acc / SCROLL_ACCEL_GAIN_DEN;

    ch->remainder = acc - (scaled * SCROLL_ACCEL_GAIN_DEN);
    event->value = scaled;

    return ZMK_INPUT_PROC_CONTINUE;
}

static struct zmk_input_processor_driver_api scroll_accel_driver_api = {
    .handle_event = scroll_accel_handle_event,
};

#define SCROLL_ACCEL_INST(n)                                                                       \
    BUILD_ASSERT(DT_INST_PROP_LEN(n, codes) <= SCROLL_ACCEL_MAX_CODES,                             \
                 "scroll-accel supports up to 4 codes");                                           \
    static struct scroll_accel_data scroll_accel_data_##n = {};                                    \
    static const struct scroll_accel_config scroll_accel_config_##n = {                            \
        .type = DT_INST_PROP_OR(n, type, INPUT_EV_REL),                                            \
        .low_speed = DT_INST_PROP(n, low_speed),                                                   \
        .high_speed = DT_INST_PROP(n, high_speed),                                                 \
        .low_gain = DT_INST_PROP(n, low_gain_x1000),                                               \
        .high_gain = DT_INST_PROP(n, high_gain_x1000),                                             \
        .codes_len = DT_INST_PROP_LEN(n, codes),                                                   \
        .codes = DT_INST_PROP(n, codes),                                                           \
    };                                                                                             \
    DEVICE_DT_INST_DEFINE(n, NULL, NULL, &scroll_accel_data_##n, &scroll_accel_config_##n,         \
                          POST_KERNEL, CONFIG_KERNEL_INIT_PRIORITY_DEFAULT,                        \
                          &scroll_accel_driver_api);

DT_INST_FOREACH_STATUS_OKAY(SCROLL_ACCEL_INST)
