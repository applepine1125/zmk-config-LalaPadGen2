/*
 * 起動が止まる原因を調べるための一時的な診断コード(diag-boot ブランチ専用)。
 * 起動の各段階を再起動をまたいで残る RAM に記録し、USB シリアルと LED に出す。
 * クラッシュしたら理由とアドレスを記録して再起動する。
 */
#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <zephyr/fatal.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/linker/section_tags.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/logging/log.h>

#include <string.h>

LOG_MODULE_REGISTER(boot_diag, LOG_LEVEL_INF);

#define BOOT_DIAG_MAGIC 0xB007D1A6u
#define BOOT_DIAG_HOLD_MS 8000

enum boot_stage {
    STAGE_NONE = 0,
    STAGE_POST_KERNEL_EARLY = 1,
    STAGE_AFTER_USB = 2,
    STAGE_AFTER_TRACKPAD = 3,
    STAGE_APP_HOLD = 4,
    STAGE_SETTINGS_LOAD = 5,
    STAGE_SETTINGS_DONE = 6,
    STAGE_RUNNING = 7,
};

struct boot_diag_record {
    uint32_t magic;
    uint32_t boots;
    uint32_t stage;
    uint32_t crashes;
    uint32_t crash_reason;
    uint32_t crash_pc;
    uint32_t crash_lr;
    uint32_t crash_stage;
    char crash_thread[16];
};

static __noinit struct boot_diag_record rec;
static struct boot_diag_record prev;

static const struct gpio_dt_spec led_r = GPIO_DT_SPEC_GET(DT_NODELABEL(led0), gpios);
static const struct gpio_dt_spec led_g = GPIO_DT_SPEC_GET(DT_NODELABEL(led1), gpios);
static const struct gpio_dt_spec led_b = GPIO_DT_SPEC_GET(DT_NODELABEL(led2), gpios);

static void led_show(uint32_t stage) {
    static const uint8_t colors[] = {
        [STAGE_NONE] = 0,
        [STAGE_POST_KERNEL_EARLY] = 0x4, /* 赤 */
        [STAGE_AFTER_USB] = 0x6,         /* 黄 */
        [STAGE_AFTER_TRACKPAD] = 0x2,    /* 緑 */
        [STAGE_APP_HOLD] = 0x1,          /* 青 */
        [STAGE_SETTINGS_LOAD] = 0x5,     /* 紫 */
        [STAGE_SETTINGS_DONE] = 0x3,     /* 水色 */
        [STAGE_RUNNING] = 0x7,           /* 白 */
    };
    const uint8_t c = stage < ARRAY_SIZE(colors) ? colors[stage] : 0;

    gpio_pin_set_dt(&led_r, (c & 0x4) != 0);
    gpio_pin_set_dt(&led_g, (c & 0x2) != 0);
    gpio_pin_set_dt(&led_b, (c & 0x1) != 0);
}

static void set_stage(uint32_t stage) {
    rec.stage = stage;
    if (stage <= STAGE_SETTINGS_DONE) {
        led_show(stage);
    }
}

static void print_status(void) {
    printk("[diag] boot=%u stage=%u uptime=%u | prev: stage=%u crashes=%u reason=%u pc=0x%08x "
           "lr=0x%08x crash_stage=%u thread=%s\n",
           rec.boots, rec.stage, k_uptime_get_32(), prev.stage, prev.crashes, prev.crash_reason,
           prev.crash_pc, prev.crash_lr, prev.crash_stage, prev.crash_thread);
    LOG_WRN("boot=%u stage=%u | prev stage=%u crashes=%u reason=%u pc=0x%08x lr=0x%08x "
            "crash_stage=%u",
            rec.boots, rec.stage, prev.stage, prev.crashes, prev.crash_reason, prev.crash_pc,
            prev.crash_lr, prev.crash_stage);
}

static void diag_thread_fn(void *a, void *b, void *c) {
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);
    for (int i = 0; i < 120; i++) {
        print_status();
        k_msleep(1000);
    }
}

K_THREAD_STACK_DEFINE(diag_stack, 1024);
static struct k_thread diag_thread;

void k_sys_fatal_error_handler(unsigned int reason, const z_arch_esf_t *esf) {
    rec.crashes++;
    rec.crash_reason = reason;
    rec.crash_stage = rec.stage;
    rec.crash_pc = esf ? esf->basic.pc : 0;
    rec.crash_lr = esf ? esf->basic.lr : 0;
    const char *name = k_thread_name_get(k_current_get());
    strncpy(rec.crash_thread, name ? name : "?", sizeof(rec.crash_thread) - 1);
    rec.crash_thread[sizeof(rec.crash_thread) - 1] = '\0';
    sys_reboot(SYS_REBOOT_WARM);
}

static int diag_early(void) {
    if (rec.magic != BOOT_DIAG_MAGIC) {
        memset(&rec, 0, sizeof(rec));
        rec.magic = BOOT_DIAG_MAGIC;
    }
    prev = rec;
    rec.boots++;
    gpio_pin_configure_dt(&led_r, GPIO_OUTPUT_INACTIVE);
    gpio_pin_configure_dt(&led_g, GPIO_OUTPUT_INACTIVE);
    gpio_pin_configure_dt(&led_b, GPIO_OUTPUT_INACTIVE);
    set_stage(STAGE_POST_KERNEL_EARLY);
    k_thread_create(&diag_thread, diag_stack, K_THREAD_STACK_SIZEOF(diag_stack), diag_thread_fn,
                    NULL, NULL, NULL, K_PRIO_PREEMPT(1), 0, K_NO_WAIT);
    k_thread_name_set(&diag_thread, "boot_diag");
    return 0;
}
SYS_INIT(diag_early, POST_KERNEL, 1);

static int diag_after_usb(void) {
    set_stage(STAGE_AFTER_USB);
    return 0;
}
SYS_INIT(diag_after_usb, POST_KERNEL, 92);

static int diag_after_trackpad(void) {
    set_stage(STAGE_AFTER_TRACKPAD);
    return 0;
}
SYS_INIT(diag_after_trackpad, POST_KERNEL, 99);

static int diag_app_hold(void) {
    set_stage(STAGE_APP_HOLD);
    k_msleep(BOOT_DIAG_HOLD_MS);
    set_stage(STAGE_SETTINGS_LOAD);
    return 0;
}
SYS_INIT(diag_app_hold, APPLICATION, 99);

static void diag_running(struct k_work *work) {
    ARG_UNUSED(work);
    set_stage(STAGE_RUNNING);
}
static K_WORK_DELAYABLE_DEFINE(diag_running_work, diag_running);

static int diag_settings_commit(void) {
    set_stage(STAGE_SETTINGS_DONE);
    k_work_schedule(&diag_running_work, K_SECONDS(10));
    return 0;
}
SETTINGS_STATIC_HANDLER_DEFINE(boot_diag, "bootdiag", NULL, NULL, diag_settings_commit, NULL);
