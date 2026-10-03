#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "beep.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "isotp_tx.h"
#include "call_popup.h"
#include "utf8_utf16_converter.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#define TAG "call_popup"

// ********************* CAN & Transport Configuration *********************

// Handsfree / Telematics Call Trigger Frame (CLU15 / AVN Telematics state)
#define CALL_POPUP_STATE_FRAME_ID       0x52AU
#define CALL_POPUP_FALLBACK_FRAME_ID    0x4CEU

// Phone / Handsfree ISO-TP Channel
#define CALL_POPUP_ISOTP_TX_ID          0x6D4U
#define CALL_POPUP_ISOTP_FC_ID          0x6B4U

#define CALL_POPUP_TARGET_BUS           CAN_BUS_0
#define CALL_POPUP_SOURCE_BUS           CAN_BUS_1

#define CALL_POPUP_TRIGGER_FRAME_COUNT  3U
#define CALL_POPUP_TRIGGER_SETTLE_US    5000U
#define CALL_POPUP_TRIGGER_TIMEOUT_US   2000000U
#define CALL_POPUP_DEFAULT_HOLD_US      5000000U

#define CALL_POPUP_MAX_TEXT_BYTES       (CALL_POPUP_MAX_TEXT_CODE_UNITS * sizeof(utf16_t))
#define CALL_POPUP_QUEUE_DEPTH          2U

#define CALL_POPUP_ISOTP_FC_TIMEOUT_US  1000000U
#define CALL_POPUP_ISOTP_MAX_WAIT_FRAMES 3U
#define CALL_POPUP_ISOTP_STACK_SIZE     (2U * 1024U)
#define CALL_POPUP_ISOTP_PRIORITY       6U

// ********************* State Machine Data Types *********************

typedef struct {
    size_t size;
    uint8_t data[CALL_POPUP_MAX_TEXT_BYTES * 2]; // Line 1 (Caller) + Line 2 (Message)
    uint8_t beep_count;
    uint32_t hold_us;
} call_popup_request_t;

typedef struct {
    sm_t sm;
    QueueHandle_t queue;
    isotp_tx_t isotp;
    call_popup_request_t pending_request;
    bool dialog_active;
} call_popup_t;

typedef struct {
    call_popup_request_t request;
    uint8_t trigger_frames_remaining;
    int64_t requested_at_us;
    int64_t trigger_forwarded_at_us;
} call_trigger_ctx_t;

static call_popup_t call_service;
static call_trigger_ctx_t trigger_ctx;

static const sm_state_t S_IDLE, S_TRIGGER, S_SENDING, S_ACTIVE_HOLD, S_DISMISS;

static inline call_popup_t *owner(sm_t *sm) {
    return (call_popup_t *)sm;
}

// ********************* UTF-16LE Text Formatting *********************

/**
 * Format caller_id and message into a combined UTF-16LE payload for the cluster dialog.
 */
static bool encode_call_text(const char *caller, const char *msg, call_popup_request_t *out) {
    if (!caller && !msg) return false;
    char combined[CALL_POPUP_MAX_TEXT_UTF8_BYTES * 2 + 4];
    
    if (caller && msg && msg[0] != '\0') {
        snprintf(combined, sizeof(combined), "%s\n%s", caller, msg);
    } else if (caller) {
        snprintf(combined, sizeof(combined), "%s", caller);
    } else {
        snprintf(combined, sizeof(combined), "%s", msg);
    }

    const utf8_t *utf8 = (const utf8_t *)combined;
    size_t utf8_len = strlen(combined);
    utf16_t utf16[CALL_POPUP_MAX_TEXT_CODE_UNITS * 2];
    size_t capacity = sizeof(utf16) / sizeof(utf16[0]);
    size_t utf16_size = utf8_to_utf16(utf8, utf8_len, NULL, 0U);

    if (utf16_size == 0U || utf16_size > capacity ||
        utf8_to_utf16(utf8, utf8_len, utf16, capacity) != utf16_size) {
        return false;
    }

    for (size_t i = 0; i < utf16_size; i++) {
        out->data[i * 2] = (uint8_t)(utf16[i] & 0xFFU);
        out->data[i * 2 + 1] = (uint8_t)(utf16[i] >> 8U);
    }
    out->size = utf16_size * sizeof(utf16_t);
    return true;
}

// ********************* State Machine Handlers *********************

// IDLE STATE
static void idle_enter(sm_t *sm) {
    owner(sm)->dialog_active = false;
}

static void idle_tick(sm_t *sm) {
    call_popup_t *svc = owner(sm);
    if (xQueueReceive(svc->queue, &svc->pending_request, 0) == pdTRUE) {
        if (svc->pending_request.beep_count > 0) {
            beep_play(svc->pending_request.beep_count);
        }
        sm_transition(sm, &S_TRIGGER);
    }
}

// TRIGGER STATE (Pulse 0x52A or 0x4CE with state = 0x01 Incoming Alert)
static void trigger_enter(sm_t *sm) {
    call_popup_t *svc = owner(sm);
    trigger_ctx.request = svc->pending_request;
    trigger_ctx.trigger_frames_remaining = CALL_POPUP_TRIGGER_FRAME_COUNT;
    trigger_ctx.requested_at_us = sm_now(sm);
    svc->dialog_active = true;

    // Send initial trigger frame directly
    twai_message_t trig = {
        .identifier = CALL_POPUP_STATE_FRAME_ID,
        .data_length_code = 8,
        .data = { 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 } // Phone Call Incoming
    };
    can_send(CALL_POPUP_TARGET_BUS, &trig, pdMS_TO_TICKS(10));
    trigger_ctx.trigger_frames_remaining--;
    trigger_ctx.trigger_forwarded_at_us = sm_now(sm);
    ESP_LOGI(TAG, "Sent incoming alert trigger pulse");
}

static void trigger_tick(sm_t *sm) {
    call_popup_t *svc = owner(sm);
    if (trigger_ctx.trigger_frames_remaining == 0U &&
        sm_now(sm) - trigger_ctx.trigger_forwarded_at_us >= CALL_POPUP_TRIGGER_SETTLE_US) {
        if (isotp_tx_start(&svc->isotp, trigger_ctx.request.data, trigger_ctx.request.size)) {
            sm_transition(sm, &S_SENDING);
        } else {
            ESP_LOGW(TAG, "ISO-TP transmitter busy, aborting call alert");
            sm_transition(sm, &S_IDLE);
        }
    } else if (sm_now(sm) - trigger_ctx.requested_at_us >= CALL_POPUP_TRIGGER_TIMEOUT_US) {
        ESP_LOGW(TAG, "Timed out waiting to send call popup trigger");
        sm_transition(sm, &S_IDLE);
    }
}

// SENDING STATE (ISO-TP multi-frame text transmission)
static void sending_tick(sm_t *sm) {
    call_popup_t *svc = owner(sm);
    if (isotp_tx_busy(&svc->isotp)) return;

    isotp_tx_result_t res = isotp_tx_result(&svc->isotp);
    if (res == ISOTP_TX_RESULT_SUCCESS) {
        ESP_LOGI(TAG, "Call alert text successfully delivered to cluster");
        sm_transition(sm, &S_ACTIVE_HOLD);
    } else {
        ESP_LOGW(TAG, "ISO-TP call text delivery failed (%d)", res);
        sm_transition(sm, &S_IDLE);
    }
}

static void sending_rx(sm_t *sm, const twai_message_t *msg, can_bus_t rx_bus) {
    isotp_tx_rx(&owner(sm)->isotp, msg, rx_bus);
}

// ACTIVE HOLD STATE (Displaying the alert modal for the configured hold time)
static void hold_tick(sm_t *sm) {
    call_popup_t *svc = owner(sm);
    if (sm_time_in_us(sm, &S_ACTIVE_HOLD) >= svc->pending_request.hold_us) {
        sm_transition(sm, &S_DISMISS);
    }
}

// DISMISS STATE (Send Call Ended / Dismiss code 0x03 to cleanly close dialog)
static void dismiss_enter(sm_t *sm) {
    twai_message_t dismiss_frame = {
        .identifier = CALL_POPUP_STATE_FRAME_ID,
        .data_length_code = 8,
        .data = { 0x10, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 } // Call Ended
    };
    can_send(CALL_POPUP_TARGET_BUS, &dismiss_frame, pdMS_TO_TICKS(10));
    ESP_LOGI(TAG, "Sent clean alert dismissal frame");
}

static void dismiss_tick(sm_t *sm) {
    if (sm_time_in_us(sm, &S_DISMISS) >= 100000U) { // 100ms settle
        sm_transition(sm, &S_IDLE);
    }
}

// BRIDGE FILTERING HOOK
static fwd_result_t call_popup_bridge_filter(sm_t *sm, twai_message_t *msg, can_bus_t fwd_bus) {
    call_popup_t *svc = owner(sm);
    if (!svc->dialog_active) return FWD_PASSTHROUGH;

    // Block factory head unit from sending competing phone state or text frames
    if (fwd_bus == CALL_POPUP_TARGET_BUS && 
       (msg->identifier == CALL_POPUP_STATE_FRAME_ID || msg->identifier == CALL_POPUP_ISOTP_TX_ID)) {
        return FWD_BLOCK;
    }
    // Block cluster's flow control from leaking back to factory head unit
    if (fwd_bus == CALL_POPUP_SOURCE_BUS && msg->identifier == CALL_POPUP_ISOTP_FC_ID) {
        return FWD_BLOCK;
    }
    return FWD_PASSTHROUGH;
}

// ********************* State Definitions *********************

static const sm_state_t S_IDLE = {
    .name = "idle",
    .enter = idle_enter,
    .tick = idle_tick,
};

static const sm_state_t S_TRIGGER = {
    .name = "trigger",
    .ctx = &trigger_ctx,
    .ctx_size = sizeof(trigger_ctx),
    .enter = trigger_enter,
    .tick = trigger_tick,
    .fwd = call_popup_bridge_filter,
};

static const sm_state_t S_SENDING = {
    .name = "sending",
    .tick = sending_tick,
    .rx = sending_rx,
    .fwd = call_popup_bridge_filter,
};

static const sm_state_t S_ACTIVE_HOLD = {
    .name = "hold",
    .tick = hold_tick,
    .fwd = call_popup_bridge_filter,
};

static const sm_state_t S_DISMISS = {
    .name = "dismiss",
    .enter = dismiss_enter,
    .tick = dismiss_tick,
    .fwd = call_popup_bridge_filter,
};

// ********************* Public Interface *********************

void call_popup_init(void) {
    memset(&call_service, 0, sizeof(call_service));
    call_service.queue = xQueueCreate(CALL_POPUP_QUEUE_DEPTH, sizeof(call_popup_request_t));
    configASSERT(call_service.queue != NULL);

    const isotp_tx_config_t config = {
        .bus = CALL_POPUP_TARGET_BUS,
        .tx_id = CALL_POPUP_ISOTP_TX_ID,
        .flow_control_id = CALL_POPUP_ISOTP_FC_ID,
        .flow_control_timeout_us = CALL_POPUP_ISOTP_FC_TIMEOUT_US,
        .can_send_wait_ticks = 1,
        .max_wait_frames = CALL_POPUP_ISOTP_MAX_WAIT_FRAMES,
        .padding_byte = 0x00U,
    };
    isotp_tx_init(&call_service.isotp, "call-popup-isotp", &config);
    bool worker_started = isotp_tx_start_worker(
        &call_service.isotp, "call_popup_isotp",
        CALL_POPUP_ISOTP_STACK_SIZE, CALL_POPUP_ISOTP_PRIORITY);
    configASSERT(worker_started);
    sm_init(&call_service.sm, "call-popup", &S_IDLE, NULL);
}

void call_popup_tick(void) {
    if (call_service.queue != NULL) {
        sm_tick(&call_service.sm);
    }
}

void call_popup_rx(const twai_message_t *msg, can_bus_t rx_bus) {
    if (call_service.queue != NULL) {
        sm_rx(&call_service.sm, msg, rx_bus);
    }
}

fwd_result_t call_popup_fwd(twai_message_t *msg, can_bus_t fwd_bus) {
    if (call_service.queue == NULL) {
        return FWD_PASSTHROUGH;
    }
    return sm_fwd(&call_service.sm, msg, fwd_bus);
}

bool call_popup_show(const char *caller_id, const char *message,
                     call_popup_severity_t severity, uint32_t hold_ms) {
    if (call_service.queue == NULL) return false;
    call_popup_request_t req = {
        .beep_count = (uint8_t)severity,
        .hold_us = hold_ms > 0 ? (hold_ms * 1000U) : CALL_POPUP_DEFAULT_HOLD_US,
    };
    if (!encode_call_text(caller_id, message, &req)) {
        return false;
    }
    return xQueueSend(call_service.queue, &req, 0) == pdTRUE;
}

void call_popup_dismiss(void) {
    if (call_service.dialog_active) {
        sm_transition(&call_service.sm, &S_DISMISS);
    }
}
