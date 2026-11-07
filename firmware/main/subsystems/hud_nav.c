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

#define HUD_NAV_EGMP_FRAME_ID   0x29BU
#define HUD_NAV_EGMP_CFG_ID     0x29CU
#define HUD_NAV_GEN2_FRAME_ID   0x562U
#define HUD_NAV_GEN2_CFG_ID     0x542U

#define HUD_MAX_STREET_CHARS    32U
#define HUD_MAX_LANES           8U
#define HUD_CLEAR_FRAME_COUNT   5U   // 5 x 100ms = 500ms clear settle frames

static hud_platform_type_t s_platform = HUD_PLATFORM_EGMP_CANFD;
static uint32_t s_hud_frame_id = HUD_NAV_EGMP_FRAME_ID;
static uint32_t s_hud_cfg_frame_id = HUD_NAV_EGMP_CFG_ID;
static bool s_nav_active = false;
static uint8_t s_clear_frames_remaining = 0U;
static uint8_t s_alive_counter = 0U;

static hud_nav_instruction_t s_current_instruction = {0};
static char s_active_street_name[HUD_MAX_STREET_CHARS * 4] = {0};
static char s_pending_street_name[HUD_MAX_STREET_CHARS * 4] = {0};
static bool s_has_pending_street = false;

// Multi-lane guidance state
static uint8_t s_active_num_lanes = 0U;
static uint8_t s_active_lane_directions[HUD_MAX_LANES] = {0};
static uint8_t s_active_lane_recommended[HUD_MAX_LANES] = {0};
static uint8_t s_pending_num_lanes = 0U;
static uint8_t s_pending_lane_directions[HUD_MAX_LANES] = {0};
static uint8_t s_pending_lane_recommended[HUD_MAX_LANES] = {0};
static bool s_has_pending_lane = false;

static SemaphoreHandle_t s_lock = NULL;
static isotp_tx_t s_street_isotp;

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

static bool try_send_lane_guidance_unlocked(uint8_t num_lanes, const uint8_t *directions, const uint8_t *recommended) {
    if (num_lanes > HUD_MAX_LANES) {
        num_lanes = HUD_MAX_LANES;
    }

    if (isotp_tx_busy(&s_street_isotp)) {
        s_pending_num_lanes = num_lanes;
        memset(s_pending_lane_directions, 0, sizeof(s_pending_lane_directions));
        memset(s_pending_lane_recommended, 0, sizeof(s_pending_lane_recommended));
        if (directions && num_lanes > 0) {
            memcpy(s_pending_lane_directions, directions, num_lanes);
        }
        if (recommended && num_lanes > 0) {
            memcpy(s_pending_lane_recommended, recommended, num_lanes);
        }
        s_has_pending_lane = true;
        return true;
    }

    // 24-byte payload:
    // Byte 0: 0x17 (23 payload bytes follow)
    // Byte 1: 0xF1 (Multi-Lane Guidance opcode)
    // Byte 2: (num_lanes << 4)
    // Byte 3: 0x00
    // Bytes 4–11: direction shapes
    // Bytes 12–19: recommended highlight mask
    // Bytes 20–23: 0x00
    uint8_t payload[24] = {0};
    payload[0] = 0x17;
    payload[1] = 0xF1;
    payload[2] = (uint8_t)((num_lanes & 0x0F) << 4);
    payload[3] = 0x00;

    for (uint8_t i = 0; i < HUD_MAX_LANES; i++) {
        payload[4 + i] = (directions && i < num_lanes) ? directions[i] : 0x00;
        payload[12 + i] = (recommended && i < num_lanes) ? recommended[i] : 0x00;
    }

    if (isotp_tx_start(&s_street_isotp, payload, sizeof(payload))) {
        s_active_num_lanes = num_lanes;
        memset(s_active_lane_directions, 0, sizeof(s_active_lane_directions));
        memset(s_active_lane_recommended, 0, sizeof(s_active_lane_recommended));
        if (directions && num_lanes > 0) {
            memcpy(s_active_lane_directions, directions, num_lanes);
        }
        if (recommended && num_lanes > 0) {
            memcpy(s_active_lane_recommended, recommended, num_lanes);
        }
        s_has_pending_lane = false;
        ESP_LOGI(TAG, "Transmitted lane guidance: %u lanes", (unsigned int)num_lanes);
        return true;
    } else {
        s_pending_num_lanes = num_lanes;
        memset(s_pending_lane_directions, 0, sizeof(s_pending_lane_directions));
        memset(s_pending_lane_recommended, 0, sizeof(s_pending_lane_recommended));
        if (directions && num_lanes > 0) {
            memcpy(s_pending_lane_directions, directions, num_lanes);
        }
        if (recommended && num_lanes > 0) {
            memcpy(s_pending_lane_recommended, recommended, num_lanes);
        }
        s_has_pending_lane = true;
        return false;
    }
}

bool hud_nav_send_lane_guidance(uint8_t num_lanes, const uint8_t *lane_directions, const uint8_t *lane_recommended) {
    if (s_lock == NULL) return false;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) != pdTRUE) {
        return false;
    }
    bool ok = try_send_lane_guidance_unlocked(num_lanes, lane_directions, lane_recommended);
    xSemaphoreGive(s_lock);
    return ok;
}

extern bool can_engine_is_bus_awake(uint32_t max_silence_ms);

void hud_nav_init(hud_platform_type_t platform) {
    s_platform = platform;
    s_hud_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? HUD_NAV_GEN2_FRAME_ID : HUD_NAV_EGMP_FRAME_ID;
    s_hud_cfg_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? HUD_NAV_GEN2_CFG_ID : HUD_NAV_EGMP_CFG_ID;
    s_nav_active = false;
    s_clear_frames_remaining = 0U;
    s_alive_counter = 0U;
    s_has_pending_street = false;
    s_has_pending_lane = false;
    s_active_num_lanes = 0U;
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
    isotp_tx_start_worker(&s_street_isotp, "hud_street_isotp", 3072, 5);

    ESP_LOGI(TAG, "HUD Navigation initialized (platform=%d, frame_id=0x%03X, cfg_id=0x%03X)",
             (int)s_platform, (unsigned int)s_hud_frame_id, (unsigned int)s_hud_cfg_frame_id);
}

void hud_nav_set_platform(hud_platform_type_t platform) {
    if (s_lock && xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) == pdTRUE) {
        s_platform = platform;
        s_hud_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? HUD_NAV_GEN2_FRAME_ID : HUD_NAV_EGMP_FRAME_ID;
        s_hud_cfg_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? HUD_NAV_GEN2_CFG_ID : HUD_NAV_EGMP_CFG_ID;
        xSemaphoreGive(s_lock);
    } else {
        s_platform = platform;
        s_hud_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? HUD_NAV_GEN2_FRAME_ID : HUD_NAV_EGMP_FRAME_ID;
        s_hud_cfg_frame_id = (platform == HUD_PLATFORM_GEN2_CCAN) ? HUD_NAV_GEN2_CFG_ID : HUD_NAV_EGMP_CFG_ID;
    }
    ESP_LOGI(TAG, "Switched HUD platform to %d (frame_id=0x%03X, cfg_id=0x%03X)",
             (int)s_platform, (unsigned int)s_hud_frame_id, (unsigned int)s_hud_cfg_frame_id);
}

void hud_nav_tick_100ms(void) {
    if (s_lock == NULL) {
        return;
    }

    if ((!s_nav_active && s_clear_frames_remaining == 0U) || (!can_engine_is_bus_awake(1500) && (s_nav_active = false, s_clear_frames_remaining = 0U, true))) {
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

    twai_message_t cfg_frame = {
        .identifier = s_hud_cfg_frame_id,
        .data_length_code = 8,
        .extd = 0,
        .rtr = 0,
    };

    s_alive_counter = (s_alive_counter + 1) & 0x0F;

    if (s_nav_active) {
        // Byte 0: TBT_Display_Type (Enum 0–46)
        frame.data[0] = (uint8_t)s_current_instruction.icon;

        // Bytes 1–2: Side_Street (0x0000 default)
        frame.data[1] = 0x00;
        frame.data[2] = 0x00;

        // Byte 3: TBT_Direction ((direction_deg % 360) / 7.5f)
        frame.data[3] = (uint8_t)((s_current_instruction.direction_deg % 360) / 7.5f);

        // Bytes 4–5: Distance_High & Distance_Low (16-bit Big-Endian meters; 0xFFFF when inactive)
        frame.data[4] = (uint8_t)(s_current_instruction.distance_meters >> 8);
        frame.data[5] = (uint8_t)(s_current_instruction.distance_meters & 0xFF);

        // Byte 6: (Scale_Unit << 4) | Combi_Side_Street (0x00 for meters)
        frame.data[6] = 0x00;

        // Byte 7: (Bar_Graph_Level << 4) | (alive_counter & 0x0F)
        // Bar graph: 0x0–0x8, or 0xF when >300m / inactive
        uint8_t bar = s_current_instruction.bar_graph;
        if (bar > 8 && bar != 0x0F) {
            bar = 8;
        }
        if (s_current_instruction.distance_meters == 0xFFFF ||
            (bar == 0 && s_current_instruction.distance_meters > 300)) {
            bar = 0x0F;
        }
        frame.data[7] = (uint8_t)((bar << 4) | s_alive_counter);

        // Active companion HUD Configuration & AR Mode frame (0x29C / 0x542)
        cfg_frame.data[0] = 0x31; // HUD_Mode_Status = 0x3 (AR Mode), HUD_Enable = 0x1
        cfg_frame.data[1] = 0x00; // AR Left/Right = 0, AR View = 0
        cfg_frame.data[2] = 0x0A; // Height = 10
        cfg_frame.data[3] = 0x0E; // Rotation = 0, Brightness = 14
        cfg_frame.data[4] = 0xFC; // Content mask: TurnByTurn, TrafficInfo, DrivingAssist, LaneSafety enabled
        cfg_frame.data[5] = 0x11; // Speed text size Large, Color White
        cfg_frame.data[6] = 0x00;
        cfg_frame.data[7] = s_alive_counter;
    } else {
        // Clear/release frame: inactive defaults
        frame.data[0] = 0x00;
        frame.data[1] = 0x00;
        frame.data[2] = 0x00;
        frame.data[3] = 0x00;
        frame.data[4] = 0xFF; // Distance 0xFFFF when inactive
        frame.data[5] = 0xFF;
        frame.data[6] = 0x00;
        frame.data[7] = (uint8_t)((0x0F << 4) | s_alive_counter); // Bar graph 0xF when inactive

        if (s_clear_frames_remaining > 0U) {
            s_clear_frames_remaining--;
        }
    }

    // Service pending ISO-TP transmissions
    if (!isotp_tx_busy(&s_street_isotp)) {
        if (s_has_pending_street) {
            try_send_street_name(s_pending_street_name);
        } else if (s_has_pending_lane) {
            try_send_lane_guidance_unlocked(s_pending_num_lanes, s_pending_lane_directions, s_pending_lane_recommended);
        }
    }

    bool send_cfg = s_nav_active;
    xSemaphoreGive(s_lock);

    can_send(HUD_NAV_TARGET_BUS, &frame, pdMS_TO_TICKS(10));
    if (send_cfg) {
        can_send(HUD_NAV_TARGET_BUS, &cfg_frame, pdMS_TO_TICKS(10));
    }
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
    // Block factory HUD configuration frame while active
    if (s_nav_active && fwd_bus == HUD_NAV_TARGET_BUS && msg->identifier == s_hud_cfg_frame_id) {
        return FWD_BLOCK;
    }
    // Block factory street name & lane guidance text
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
    s_current_instruction.street_name = s_active_street_name;
    s_nav_active = true;
    s_clear_frames_remaining = 0U;

    // If a new street name was provided, transmit or queue over ISO-TP
    if (instr->street_name && strcmp(instr->street_name, s_active_street_name) != 0) {
        try_send_street_name(instr->street_name);
        s_current_instruction.street_name = s_active_street_name;
    }

    // If multi-lane guidance was explicitly provided, transmit or queue over ISO-TP (opcode 0xF1)
    if (instr->has_lane_guidance) {
        bool lane_changed = false;
        if (instr->num_lanes != s_active_num_lanes) {
            lane_changed = true;
        } else if (instr->num_lanes > 0) {
            if (memcmp(instr->lane_directions, s_active_lane_directions, instr->num_lanes) != 0 ||
                memcmp(instr->lane_recommended, s_active_lane_recommended, instr->num_lanes) != 0) {
                lane_changed = true;
            }
        }
        if (lane_changed && (instr->num_lanes > 0 || s_active_num_lanes > 0)) {
            try_send_lane_guidance_unlocked(instr->num_lanes, instr->lane_directions, instr->lane_recommended);
        }
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
            s_active_num_lanes = 0U;
            memset(s_active_lane_directions, 0, sizeof(s_active_lane_directions));
            memset(s_active_lane_recommended, 0, sizeof(s_active_lane_recommended));
            s_pending_num_lanes = 0U;
            memset(s_pending_lane_directions, 0, sizeof(s_pending_lane_directions));
            memset(s_pending_lane_recommended, 0, sizeof(s_pending_lane_recommended));
            s_has_pending_lane = false;
            ESP_LOGI(TAG, "HUD Navigation clearing (queueing %u clean frames)", (unsigned int)HUD_CLEAR_FRAME_COUNT);
        }
        xSemaphoreGive(s_lock);
    }
}
