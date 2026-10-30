#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "isotp_tx.h"
#include "hud_nav.h"
#include "utf8_utf16_converter.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define TAG "hud_nav"

#define HUD_NAV_ISOTP_TX_ID     0x6E2U
#define HUD_NAV_ISOTP_FC_ID     0x6C0U
#define HUD_NAV_TARGET_BUS      CAN_BUS_0
#define HUD_NAV_SOURCE_BUS      CAN_BUS_1

#define HUD_MAX_STREET_CHARS    32U
#define HUD_CLEAR_FRAME_COUNT   5U   // 5 x 100ms = 500ms clear settle frames

static hud_platform_type_t s_platform = HUD_PLATFORM_EGMP_CANFD;
static uint32_t s_hud_frame_id = 0x29BU;
static bool s_nav_active = false;
static uint8_t s_clear_frames_remaining = 0U;
static uint8_t s_alive_counter = 0U;

static hud_nav_instruction_t s_current_instruction = {0};
static char s_active_street_name[HUD_MAX_STREET_CHARS * 4] = {0};
static char s_pending_street_name[HUD_MAX_STREET_CHARS * 4] = {0};
static bool s_has_pending_street = false;
static SemaphoreHandle_t s_lock = NULL;

static isotp_tx_t s_street_isotp;

/**
 * Compute 4-bit HKMC longitudinal checksum across bytes 0-6 and low nibble of byte 7.
 */
static uint8_t calc_hud_checksum(const uint8_t *data) {
    uint8_t sum = 0;
    for (int i = 0; i < 7; i++) {
        sum += (data[i] & 0x0F) + (data[i] >> 4);
    }
    sum += (data[7] & 0x0F);
    return (~sum + 1) & 0x0F;
}

static void try_send_street_name(const char *name) {
    if (!name || name[0] == '\0') {
        return;
    }
    if (isotp_tx_busy(&s_street_isotp)) {
        strncpy(s_pending_street_name, name, sizeof(s_pending_street_name) - 1);
        s_pending_street_name[sizeof(s_pending_street_name) - 1] = '\0';
        s_has_pending_street = true;
        return;
    }

    utf16_t utf16[HUD_MAX_STREET_CHARS];
    size_t utf16_size = utf8_to_utf16((const utf8_t *)name,
                                      strlen(name),
                                      utf16,
                                      HUD_MAX_STREET_CHARS);
    if (utf16_size > 0) {
        uint8_t payload[HUD_MAX_STREET_CHARS * 2];
        for (size_t i = 0; i < utf16_size; i++) {
            payload[i * 2] = (uint8_t)(utf16[i] & 0xFF);
            payload[i * 2 + 1] = (uint8_t)(utf16[i] >> 8);
        }
        if (isotp_tx_start(&s_street_isotp, payload, utf16_size * 2)) {
            strncpy(s_active_street_name, name, sizeof(s_active_street_name) - 1);
            s_active_street_name[sizeof(s_active_street_name) - 1] = '\0';
            s_has_pending_street = false;
            ESP_LOGI(TAG, "Transmitted new street name: %s", s_active_street_name);
        } else {
            strncpy(s_pending_street_name, name, sizeof(s_pending_street_name) - 1);
            s_pending_street_name[sizeof(s_pending_street_name) - 1] = '\0';
            s_has_pending_street = true;
        }
    }
}

void hud_nav_init(hud_platform_type_t platform) {
    s_platform = platform;
    s_hud_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? 0x562U : 0x29BU;
    s_nav_active = false;
    s_clear_frames_remaining = 0U;
    s_alive_counter = 0U;
    s_has_pending_street = false;
    memset(&s_current_instruction, 0, sizeof(s_current_instruction));

    if (s_lock == NULL) {
        s_lock = xSemaphoreCreateMutex();
    }

    const isotp_tx_config_t cfg = {
        .bus = HUD_NAV_TARGET_BUS,
        .tx_id = HUD_NAV_ISOTP_TX_ID,
        .flow_control_id = HUD_NAV_ISOTP_FC_ID,
        .flow_control_timeout_us = 1000000U,
        .can_send_wait_ticks = 1,
        .max_wait_frames = 3,
        .padding_byte = 0x00U,
    };
    isotp_tx_init(&s_street_isotp, "hud-street-isotp", &cfg);
    isotp_tx_start_worker(&s_street_isotp, "hud_street_isotp", 2048, 5);

    ESP_LOGI(TAG, "HUD Navigation initialized (platform=%d, frame_id=0x%03X)", (int)s_platform, (unsigned int)s_hud_frame_id);
}

void hud_nav_set_platform(hud_platform_type_t platform) {
    if (s_lock && xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) == pdTRUE) {
        s_platform = platform;
        s_hud_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? 0x562U : 0x29BU;
        xSemaphoreGive(s_lock);
    } else {
        s_platform = platform;
        s_hud_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? 0x562U : 0x29BU;
    }
    ESP_LOGI(TAG, "Switched HUD platform to %d (frame_id=0x%03X)", (int)s_platform, (unsigned int)s_hud_frame_id);
}

void hud_nav_tick_100ms(void) {
    if (s_lock == NULL) {
        return;
    }

    if (!s_nav_active && s_clear_frames_remaining == 0U) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(5)) != pdTRUE) {
        return;
    }

    twai_message_t frame = {
        .identifier = s_hud_frame_id,
        .data_length_code = 8,
        .extd = 0,
        .rtr = 0,
    };

    if (s_nav_active) {
        // Byte 0: Maneuver Icon Enum
        frame.data[0] = (uint8_t)s_current_instruction.icon;

        // Byte 1: Sub-maneuver / Lane indicator
        frame.data[1] = 0x00;

        // Byte 2-3: Distance to Maneuver (16-bit big endian in meters)
        frame.data[2] = (uint8_t)(s_current_instruction.distance_meters >> 8);
        frame.data[3] = (uint8_t)(s_current_instruction.distance_meters & 0xFF);

        // Byte 4: Proximity Countdown Bar (0 to 8 blocks)
        frame.data[4] = (s_current_instruction.bar_graph > 8) ? 8 : s_current_instruction.bar_graph;

        // Byte 5: Warnings & Camera Alerts (0x01 = Speed Camera)
        frame.data[5] = s_current_instruction.speed_camera_alert ? 0x01 : 0x00;

        // Byte 6: Speed Limit Indicator (km/h)
        frame.data[6] = s_current_instruction.speed_limit_kph;
    } else {
        // Clear/release frame: all guidance fields 0
        memset(frame.data, 0, 7);
        if (s_clear_frames_remaining > 0U) {
            s_clear_frames_remaining--;
        }
    }

    // Byte 7: 4-bit Alive Counter (0-15) + 4-bit Checksum
    s_alive_counter = (s_alive_counter + 1) & 0x0F;
    frame.data[7] = s_alive_counter;
    uint8_t cksum = calc_hud_checksum(frame.data);
    frame.data[7] |= (cksum << 4);

    // Retry sending pending street name if ISO-TP worker has finished
    if (s_has_pending_street && !isotp_tx_busy(&s_street_isotp)) {
        try_send_street_name(s_pending_street_name);
    }

    xSemaphoreGive(s_lock);

    can_send(HUD_NAV_TARGET_BUS, &frame, pdMS_TO_TICKS(10));
}

void hud_nav_rx(const twai_message_t *msg, can_bus_t rx_bus) {
    if (s_nav_active || isotp_tx_busy(&s_street_isotp)) {
        isotp_tx_rx(&s_street_isotp, msg, rx_bus);
    }
}

fwd_result_t hud_nav_fwd(twai_message_t *msg, can_bus_t fwd_bus) {
    if (!s_nav_active && s_clear_frames_remaining == 0U && !isotp_tx_busy(&s_street_isotp)) {
        return FWD_PASSTHROUGH;
    }

    // Suppress factory navigation frame from reaching the HUD / cluster
    if (fwd_bus == HUD_NAV_TARGET_BUS && msg->identifier == s_hud_frame_id) {
        return FWD_BLOCK;
    }
    // Block factory street name text
    if (fwd_bus == HUD_NAV_TARGET_BUS && msg->identifier == HUD_NAV_ISOTP_TX_ID) {
        return FWD_BLOCK;
    }
    if (fwd_bus == HUD_NAV_SOURCE_BUS && msg->identifier == HUD_NAV_ISOTP_FC_ID) {
        return FWD_BLOCK;
    }

    return FWD_PASSTHROUGH;
}

bool hud_nav_update(const hud_nav_instruction_t *instr) {
    if (!instr || s_lock == NULL) return false;

    if (instr->icon == HUD_MANEUVER_NONE) {
        hud_nav_clear();
        return true;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) != pdTRUE) {
        return false;
    }

    s_current_instruction = *instr;
    s_nav_active = true;
    s_clear_frames_remaining = 0U;

    // If a new street name was provided, transmit or queue over ISO-TP
    if (instr->street_name && strcmp(instr->street_name, s_active_street_name) != 0) {
        try_send_street_name(instr->street_name);
    }

    xSemaphoreGive(s_lock);
    return true;
}

void hud_nav_clear(void) {
    if (s_lock == NULL) return;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) == pdTRUE) {
        if (s_nav_active) {
            s_nav_active = false;
            s_clear_frames_remaining = HUD_CLEAR_FRAME_COUNT;
            memset(&s_current_instruction, 0, sizeof(s_current_instruction));
            s_active_street_name[0] = '\0';
            s_pending_street_name[0] = '\0';
            s_has_pending_street = false;
            ESP_LOGI(TAG, "HUD Navigation clearing (queueing %u clean frames)", (unsigned int)HUD_CLEAR_FRAME_COUNT);
        }
        xSemaphoreGive(s_lock);
    }
}
