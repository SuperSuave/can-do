#include "mood_light.h"
#include "isotp_tx.h"
#include "esp_log.h"
#include <string.h>

#define TAG "mood_light"

#define MOOD_LIGHT_ISOTP_TIMEOUT_US 1000000U // 1000ms timeout for Flow Control across gateway domains
#define MOOD_LIGHT_ISOTP_STACK_SIZE (2U * 1024U)
#define MOOD_LIGHT_ISOTP_PRIORITY   5U

static isotp_tx_t mood_isotp;
static bool s_initialized = false;

void mood_light_init(void) {
    if (s_initialized) return;

    const isotp_tx_config_t config = {
        .bus = CAN_BUS_0,
        .tx_id = MOOD_LIGHT_ISOTP_TX_ID,
        .flow_control_id = MOOD_LIGHT_ISOTP_FC_ID,
        .flow_control_timeout_us = MOOD_LIGHT_ISOTP_TIMEOUT_US,
        .can_send_wait_ticks = 1,
        .max_wait_frames = 5U,
        .padding_byte = 0x00U,
    };

    isotp_tx_init(&mood_isotp, "mood-light-isotp", &config);
    bool worker_started = isotp_tx_start_worker(&mood_isotp, "mood_isotp",
                                                MOOD_LIGHT_ISOTP_STACK_SIZE,
                                                MOOD_LIGHT_ISOTP_PRIORITY);
    if (!worker_started) {
        ESP_LOGE(TAG, "Failed to start mood_light ISO-TP worker task");
        return;
    }

    s_initialized = true;
    ESP_LOGI(TAG, "Ambient Mood Lighting ISO-TP initialized (TX: 0x%03X, FC: 0x%03X, timeout: %u ms)",
             MOOD_LIGHT_ISOTP_TX_ID, MOOD_LIGHT_ISOTP_FC_ID, (unsigned int)(MOOD_LIGHT_ISOTP_TIMEOUT_US / 1000U));
}

void mood_light_rx(const twai_message_t *msg, can_bus_t rx_bus) {
    if (!s_initialized || msg == NULL) return;
    isotp_tx_rx(&mood_isotp, msg, rx_bus);
}

bool mood_light_send_raw(const uint8_t *payload, size_t size) {
    if (!s_initialized || payload == NULL || size == 0) return false;
    ESP_LOGI(TAG, "Queueing ISO-TP mood lamp payload (%u bytes)", (unsigned int)size);

    // Send single-shot Tester Present to ensure diagnostic server on 0x7A0 is active
    twai_message_t tp = {0};
    tp.identifier = MOOD_LIGHT_ISOTP_TX_ID;
    tp.data_length_code = 8;
    tp.ss = 1;
    tp.data[0] = 0x02; // DLC = 2
    tp.data[1] = 0x3E; // TesterPresent (0x3E)
    tp.data[2] = 0x80; // Suppress positive response
    can_send(CAN_BUS_0, &tp, 1);

    return isotp_tx_start(&mood_isotp, payload, size);
}

bool mood_light_set_rgb(uint16_t red, uint16_t green, uint16_t blue, uint8_t mode) {
    uint8_t payload[9] = {
        0x64,                                 // 100 dec = MLMALL command mode
        (uint8_t)((red >> 8) & 0xFF),   (uint8_t)(red & 0xFF),
        (uint8_t)((green >> 8) & 0xFF), (uint8_t)(green & 0xFF),
        (uint8_t)((blue >> 8) & 0xFF),  (uint8_t)(blue & 0xFF),
        mode,                                 // 0=Off, 1=Normal, 2=Welcome, 3=DriveMode
        0x00                                  // Reserved
    };
    return mood_light_send_raw(payload, sizeof(payload));
}

bool mood_light_set_ambient(uint16_t red, uint16_t green, uint16_t blue,
                           uint8_t brightness, uint8_t dimmed_driving,
                           uint8_t drive_mode_sync, uint8_t fade_in_out) {
    uint8_t payload[10] = {
        (uint8_t)((red >> 8) & 0xFF),   (uint8_t)(red & 0xFF),
        (uint8_t)((green >> 8) & 0xFF), (uint8_t)(green & 0xFF),
        (uint8_t)((blue >> 8) & 0xFF),  (uint8_t)(blue & 0xFF),
        brightness,
        (uint8_t)(dimmed_driving ? 1 : 0),
        (uint8_t)(drive_mode_sync ? 1 : 0),
        (uint8_t)(fade_in_out ? 1 : 0)
    };
    return mood_light_send_raw(payload, sizeof(payload));
}
