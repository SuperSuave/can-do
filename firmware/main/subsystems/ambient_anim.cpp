#include "ambient_anim.h"
#include "driver/twai.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>

static const char* TAG = "AMBIENT_ANIM";

// Ground-truth 64-color palette captured directly on E-GMP CAN ID 0x4AD
static const uint8_t PALETTE_64[64][4] = {
    {0xF7, 0xFC, 0x63, 0x0B}, //  1: Lime / Mint Glow
    {0xE6, 0xF8, 0xA3, 0x0B}, //  2: Spring Lime
    {0xD2, 0xFC, 0xC3, 0x0B}, //  3: Fresh Grass
    {0xAF, 0xF8, 0xF3, 0x0B}, //  4: Pastel Mint
    {0x77, 0xF8, 0x43, 0x0C}, //  5: Light Aqua
    {0x3A, 0xFC, 0x63, 0x0C}, //  6: Bright Turquoise
    {0x0A, 0xFC, 0xB3, 0x0E}, //  7: Deep Turquoise
    {0x00, 0x64, 0x53, 0x0F}, //  8: Pure Cyan / Aqua Wave
    {0x00, 0xD0, 0xF2, 0x0F}, //  9: Sky Blue Light
    {0x00, 0x84, 0xF2, 0x0F}, // 10: Sky Blue
    {0x00, 0x30, 0xF2, 0x0F}, // 11: Glacier Blue
    {0x00, 0xF4, 0xF1, 0x0F}, // 12: Cerulean
    {0x00, 0xCC, 0xE1, 0x0F}, // 13: Cobalt Light
    {0x00, 0x8C, 0xF1, 0x0F}, // 14: Pacific Blue
    {0x00, 0x54, 0xF1, 0x0F}, // 15: Electric Blue
    {0x00, 0xF8, 0xF0, 0x0F}, // 16: Royal Blue
    {0x19, 0x00, 0xF0, 0x0F}, // 17: Deep Blue
    {0x37, 0x00, 0xF0, 0x0F}, // 18: Indigo Blue
    {0x51, 0x00, 0xF0, 0x0F}, // 19: Blue Violet
    {0x64, 0x00, 0xF0, 0x0F}, // 20: Lavender Violet
    {0x6D, 0xA8, 0xF0, 0x0F}, // 21: Grape Purple
    {0x7A, 0xD0, 0xF0, 0x0F}, // 22: Electric Purple
    {0x7D, 0x64, 0xF0, 0x0F}, // 23: Bright Violet
    {0x80, 0x00, 0xF0, 0x0F}, // 24: Deep Purple / Violet
    {0x82, 0x00, 0xF0, 0x0F}, // 25: Amethyst
    {0x8F, 0x00, 0xF0, 0x0F}, // 26: Royal Purple
    {0x9C, 0x00, 0xF0, 0x0F}, // 27: Purple Orchid
    {0xA7, 0x00, 0xF0, 0x0F}, // 28: Purple Magenta
    {0xB0, 0x00, 0xF0, 0x0F}, // 29: Bright Magenta
    {0xC3, 0x00, 0xE0, 0x0F}, // 30: Deep Fuchsia
    {0xCD, 0x00, 0xE0, 0x0F}, // 31: Hot Fuchsia
    {0xE8, 0x00, 0xE0, 0x0F}, // 32: Neon Pink
    {0xFF, 0x00, 0x10, 0x0F}, // 33: Magenta / Neon Pink
    {0xFF, 0x00, 0x30, 0x0C}, // 34: Deep Rose Pink
    {0xFF, 0x00, 0xE0, 0x09}, // 35: Crimson Pink
    {0xFF, 0x00, 0x90, 0x08}, // 36: Bright Rose Red
    {0xFF, 0x00, 0x50, 0x07}, // 37: Ruby Red
    {0xFF, 0x00, 0xF0, 0x06}, // 38: Cherry Red
    {0xFF, 0x00, 0xA0, 0x06}, // 39: Scarlet
    {0xFF, 0x00, 0x50, 0x06}, // 40: Carmine Red
    {0xFE, 0x00, 0xF0, 0x05}, // 41: Pure Red Bright
    {0xFF, 0x00, 0x80, 0x04}, // 42: Pure Red Strong
    {0xFE, 0x00, 0xA0, 0x03}, // 43: Deep Crimson
    {0xFE, 0x00, 0xE0, 0x01}, // 44: Blood Red
    {0xFF, 0x0C, 0xA0, 0x00}, // 45: Burnt Red
    {0xFE, 0x88, 0x00, 0x00}, // 46: Crimson Red
    {0xFF, 0xC0, 0x70, 0x01}, // 47: Vermilion Red-Orange
    {0xFF, 0xF0, 0xA0, 0x02}, // 48: Deep Orange
    {0xFF, 0x04, 0x11, 0x03}, // 49: Bright Orange
    {0xFF, 0x24, 0x91, 0x04}, // 50: Tangerine
    {0xFF, 0x60, 0x81, 0x05}, // 51: Sunrise Orange
    {0xFF, 0x80, 0xA1, 0x06}, // 52: Golden Orange
    {0xFF, 0xAC, 0x41, 0x07}, // 53: Amber Gold
    {0xFF, 0xC4, 0x11, 0x07}, // 54: Warm Amber
    {0xFF, 0xF4, 0x31, 0x07}, // 55: Deep Marigold
    {0xFF, 0x24, 0xB2, 0x06}, // 56: Marigold Orange
    {0xFF, 0x50, 0x72, 0x07}, // 57: Warm Sunset / Amber
    {0xFF, 0x80, 0xF2, 0x06}, // 58: Peach Amber
    {0xFF, 0xB0, 0x12, 0x07}, // 59: Golden Peach
    {0xFF, 0xC4, 0xC2, 0x06}, // 60: Champagne Gold
    {0xFF, 0xFC, 0xB2, 0x07}, // 61: Soft Gold
    {0xFE, 0x3C, 0xA3, 0x08}, // 62: Vanilla Gold
    {0xFF, 0x60, 0x33, 0x09}, // 63: Warm Ivory
    {0xFE, 0xB4, 0x53, 0x0A}  // 64: Warm White / Champagne
};

// Approximate RGB coordinates for color wheel Euclidean distance matching
static const uint8_t PALETTE_RGB[64][3] = {
    {70, 255, 70},   {85, 255, 95},   {100, 255, 120}, {115, 255, 150},
    {80, 255, 180},  {40, 255, 210},  {10, 255, 235},  {0, 255, 255},
    {0, 235, 255},   {0, 215, 255},   {0, 195, 255},   {0, 175, 255},
    {0, 155, 255},   {0, 135, 255},   {0, 120, 255},   {20, 90, 255},
    {50, 60, 255},   {80, 40, 255},   {105, 30, 255},  {130, 20, 255},
    {150, 15, 255},  {165, 10, 255},  {175, 5, 255},   {180, 0, 255},
    {190, 0, 250},   {205, 0, 240},   {220, 0, 230},   {230, 0, 215},
    {240, 0, 200},   {245, 5, 180},   {250, 10, 160},  {255, 15, 140},
    {255, 20, 147},  {255, 15, 120},  {255, 10, 100},  {255, 10, 80},
    {255, 10, 60},   {255, 10, 45},   {255, 10, 35},   {255, 10, 25},
    {255, 5, 15},    {255, 0, 10},    {255, 0, 5},     {255, 0, 0},
    {255, 20, 0},    {255, 0, 0},     {255, 45, 0},    {255, 65, 0},
    {255, 80, 0},    {255, 95, 0},    {255, 110, 0},   {255, 125, 0},
    {255, 135, 0},   {255, 140, 0},   {255, 145, 0},   {255, 150, 0},
    {255, 140, 0},   {255, 165, 10},  {255, 180, 30},  {255, 195, 60},
    {255, 210, 100}, {255, 225, 140}, {255, 235, 180}, {255, 240, 220}
};

static std::atomic<bool> s_running{false};
static std::atomic<AmbientEffect> s_current_effect{AmbientEffect::NONE};
static std::atomic<uint32_t> s_step_interval_ms{1500};
static TaskHandle_t s_anim_task_handle = nullptr;

static void send_raw_frame(uint32_t id, const uint8_t* data, uint8_t dlc) {
    twai_status_info_t info;
    if (twai_get_status_info(&info) != ESP_OK || info.state != TWAI_STATE_RUNNING || info.tx_error_counter >= 128) {
        return;
    }
    twai_message_t tx_msg = {};
    tx_msg.identifier = id;
    tx_msg.data_length_code = dlc;
    tx_msg.extd = 0;
    tx_msg.rtr = 0;
    tx_msg.ss = 1; // Single-Shot mode to avoid bus blocking
    memcpy(tx_msg.data, data, dlc);
    twai_transmit(&tx_msg, pdMS_TO_TICKS(20));
}

void ambient_anim_send_burst(uint32_t can_id, const uint8_t* payload_4bytes) {
    if (!payload_4bytes) return;

    // Stage 1: Active color burst (3 frames @ 25ms delay)
    uint8_t stage1[8] = {
        payload_4bytes[0], payload_4bytes[1], payload_4bytes[2], payload_4bytes[3],
        0x00, 0x00, 0x00, 0x00
    };
    for (int i = 0; i < 3; i++) {
        send_raw_frame(can_id, stage1, 8);
        vTaskDelay(pdMS_TO_TICKS(25));
    }

    // Stage 2: Latch commit frame (3 frames @ 25ms delay: 00 02 08 20 00 00 00 00)
    const uint8_t stage2[8] = { 0x00, 0x02, 0x08, 0x20, 0x00, 0x00, 0x00, 0x00 };
    for (int i = 0; i < 3; i++) {
        send_raw_frame(can_id, stage2, 8);
        vTaskDelay(pdMS_TO_TICKS(25));
    }
}

void ambient_anim_send_off(uint32_t can_id) {
    const uint8_t off_color[4] = { 0x00, 0x00, 0x00, 0x00 };
    if (can_id == 0 || can_id == AMBIENT_CAN_ID_DASH) {
        ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, off_color);
    }
    if (can_id == 0 || can_id == AMBIENT_CAN_ID_DOORS) {
        ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, off_color);
    }
}

bool ambient_anim_get_palette_color(uint8_t index, uint8_t* out_payload) {
    if (index < 1 || index > 64 || !out_payload) return false;
    memcpy(out_payload, PALETTE_64[index - 1], 4);
    return true;
}

uint8_t ambient_anim_find_closest_palette_index(uint8_t r, uint8_t g, uint8_t b) {
    uint8_t best_index = 1;
    uint32_t min_dist_sq = UINT32_MAX;

    for (uint8_t i = 0; i < 64; i++) {
        int dr = (int)r - (int)PALETTE_RGB[i][0];
        int dg = (int)g - (int)PALETTE_RGB[i][1];
        int db = (int)b - (int)PALETTE_RGB[i][2];
        uint32_t dist_sq = (uint32_t)(dr * dr + dg * dg + db * db);
        if (dist_sq < min_dist_sq) {
            min_dist_sq = dist_sq;
            best_index = i + 1; // 1-based index
        }
    }
    return best_index;
}

static void ambient_anim_task(void* pvParameters) {
    ESP_LOGI(TAG, "Ambient lighting animation FreeRTOS worker started");

    uint32_t step_count = 0;

    // Anchor colors for holiday & dynamic modes
    const uint8_t* c_lime    = PALETTE_64[0];  // #1  Lime / Mint Glow
    const uint8_t* c_cyan    = PALETTE_64[7];  // #8  Pure Cyan
    const uint8_t* c_blue    = PALETTE_64[14]; // #15 Electric Blue
    const uint8_t* c_purple  = PALETTE_64[23]; // #24 Deep Purple / Violet
    const uint8_t* c_magenta = PALETTE_64[32]; // #33 Magenta / Neon Pink
    const uint8_t* c_red     = PALETTE_64[45]; // #46 Crimson Red
    const uint8_t* c_amber   = PALETTE_64[56]; // #57 Warm Sunset / Amber
    const uint8_t* c_white   = PALETTE_64[63]; // #64 Warm White / Champagne

    while (true) {
        if (!s_running.load()) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        AmbientEffect eff = s_current_effect.load();
        uint32_t interval = s_step_interval_ms.load();

        switch (eff) {
            case AmbientEffect::RAINBOW_WAVE: {
                // Smooth continuous 64-step progression around the color wheel
                uint8_t idx_dash = (step_count % 64);
                uint8_t idx_doors = ((step_count + 8) % 64); // 8 steps (~45 deg) offset for 2-tone wave

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, PALETTE_64[idx_dash]);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, PALETTE_64[idx_doors]);

                uint32_t delay_ms = interval > 0 ? interval : 600;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::CHRISTMAS_WAVE: {
                // 🎄 Alternate Crimson Red and Lime Green between Dash and Door panels
                bool swap = (step_count % 2 == 1);
                const uint8_t* dash_col = swap ? c_lime : c_red;
                const uint8_t* door_col = swap ? c_red : c_lime;

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, dash_col);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, door_col);

                uint32_t delay_ms = interval > 0 ? interval : 1500;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::HALLOWEEN_WAVE: {
                // 🎃 Alternate Pumpkin Amber and Witch Violet between Dash and Door panels
                bool swap = (step_count % 2 == 1);
                const uint8_t* dash_col = swap ? c_purple : c_amber;
                const uint8_t* door_col = swap ? c_amber : c_purple;

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, dash_col);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, door_col);

                uint32_t delay_ms = interval > 0 ? interval : 1500;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::VALENTINE_WAVE: {
                // 💖 Alternate Neon Pink and Crimson Red between Dash and Door panels
                bool swap = (step_count % 2 == 1);
                const uint8_t* dash_col = swap ? c_red : c_magenta;
                const uint8_t* door_col = swap ? c_magenta : c_red;

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, dash_col);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, door_col);

                uint32_t delay_ms = interval > 0 ? interval : 1500;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::FOURTH_JULY_WAVE: {
                // 🎆 3-stage patriotic rotation: Red, White, and Blue
                uint32_t phase = step_count % 3;
                const uint8_t* p_dash = (phase == 0) ? c_red : ((phase == 1) ? c_white : c_blue);
                const uint8_t* p_door = (phase == 0) ? c_blue : ((phase == 1) ? c_red : c_white);

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, p_dash);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, p_door);

                uint32_t delay_ms = interval > 0 ? interval : 1200;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::POLICE_STROBE: {
                // 🚨 Fast alternating strobe between Red and Blue
                bool swap = (step_count % 2 == 1);
                const uint8_t* p_dash = swap ? c_blue : c_red;
                const uint8_t* p_door = swap ? c_red : c_blue;

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, p_dash);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, p_door);

                uint32_t delay_ms = interval > 0 ? interval : 350;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::OCEAN_TIDE: {
                // 🌊 Swells through Cyan, Sky Blue, and Electric Blue
                uint8_t ocean_indices[4] = { 7, 9, 14, 11 };
                uint8_t cur = ocean_indices[step_count % 4];
                uint8_t nxt = ocean_indices[(step_count + 1) % 4];

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, PALETTE_64[cur]);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, PALETTE_64[nxt]);

                uint32_t delay_ms = interval > 0 ? interval : 1800;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::SUNSET_GLOW: {
                // 🌅 Warm embers flowing from Crimson Red to Warm Amber to Champagne Gold
                uint8_t sunset_indices[4] = { 45, 52, 56, 63 };
                uint8_t cur = sunset_indices[step_count % 4];
                uint8_t nxt = sunset_indices[(step_count + 1) % 4];

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, PALETTE_64[cur]);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, PALETTE_64[nxt]);

                uint32_t delay_ms = interval > 0 ? interval : 2000;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::AURORA_BOREALIS: {
                // 🌲 Shifting hues between Emerald Lime and Pure Cyan
                uint8_t aurora_indices[4] = { 0, 3, 5, 7 };
                uint8_t cur = aurora_indices[step_count % 4];
                uint8_t nxt = aurora_indices[(step_count + 2) % 4];

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, PALETTE_64[cur]);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, PALETTE_64[nxt]);

                uint32_t delay_ms = interval > 0 ? interval : 1800;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            case AmbientEffect::BREATHE: {
                // 💓 Modulate intensity level (D4) smoothly on active color
                uint8_t breathe_d4[6] = { 0x02, 0x05, 0x08, 0x0C, 0x08, 0x04 };
                uint8_t d4_val = breathe_d4[step_count % 6];

                uint8_t p_mod[4];
                memcpy(p_mod, c_cyan, 4);
                p_mod[3] = d4_val;

                ambient_anim_send_burst(AMBIENT_CAN_ID_DASH, p_mod);
                ambient_anim_send_burst(AMBIENT_CAN_ID_DOORS, p_mod);

                uint32_t delay_ms = interval > 0 ? interval : 1000;
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                break;
            }

            default:
                vTaskDelay(pdMS_TO_TICKS(100));
                break;
        }

        step_count++;
    }
}

void ambient_anim_init(void) {
    if (s_anim_task_handle == nullptr) {
        xTaskCreate(ambient_anim_task, "AMBIENT_ANIM", 3072, nullptr, 4, &s_anim_task_handle);
        ESP_LOGI(TAG, "Ambient lighting animation subsystem initialized");
    }
}

void ambient_anim_start(AmbientEffect effect, uint32_t step_interval_ms) {
    if (effect == AmbientEffect::NONE) {
        ambient_anim_stop();
        return;
    }
    s_current_effect.store(effect);
    s_step_interval_ms.store(step_interval_ms);
    s_running.store(true);
    ESP_LOGI(TAG, "Started ambient animation effect %d (interval=%lu ms)", (int)effect, (unsigned long)step_interval_ms);
}

bool ambient_anim_start_by_name(const std::string& name) {
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

    if (lower.find("rainbow") != std::string::npos) {
        ambient_anim_start(AmbientEffect::RAINBOW_WAVE, 600);
        return true;
    }
    if (lower.find("christmas") != std::string::npos || lower.find("xmas") != std::string::npos) {
        ambient_anim_start(AmbientEffect::CHRISTMAS_WAVE, 1500);
        return true;
    }
    if (lower.find("halloween") != std::string::npos) {
        ambient_anim_start(AmbientEffect::HALLOWEEN_WAVE, 1500);
        return true;
    }
    if (lower.find("valentine") != std::string::npos) {
        ambient_anim_start(AmbientEffect::VALENTINE_WAVE, 1500);
        return true;
    }
    if (lower.find("4th") != std::string::npos || lower.find("fourth") != std::string::npos || lower.find("patriotic") != std::string::npos) {
        ambient_anim_start(AmbientEffect::FOURTH_JULY_WAVE, 1200);
        return true;
    }
    if (lower.find("police") != std::string::npos || lower.find("strobe") != std::string::npos) {
        ambient_anim_start(AmbientEffect::POLICE_STROBE, 350);
        return true;
    }
    if (lower.find("ocean") != std::string::npos) {
        ambient_anim_start(AmbientEffect::OCEAN_TIDE, 1800);
        return true;
    }
    if (lower.find("sunset") != std::string::npos) {
        ambient_anim_start(AmbientEffect::SUNSET_GLOW, 2000);
        return true;
    }
    if (lower.find("aurora") != std::string::npos || lower.find("northern") != std::string::npos) {
        ambient_anim_start(AmbientEffect::AURORA_BOREALIS, 1800);
        return true;
    }
    if (lower.find("breathe") != std::string::npos || lower.find("pulse") != std::string::npos) {
        ambient_anim_start(AmbientEffect::BREATHE, 1000);
        return true;
    }

    return false;
}

void ambient_anim_stop(void) {
    if (s_running.load()) {
        s_running.store(false);
        s_current_effect.store(AmbientEffect::NONE);
        ESP_LOGI(TAG, "Stopped ambient animation task");
    }
}

bool ambient_anim_is_active(void) {
    return s_running.load();
}

std::string ambient_anim_get_effect_name(void) {
    if (!s_running.load()) return "off";
    switch (s_current_effect.load()) {
        case AmbientEffect::RAINBOW_WAVE: return "Rainbow Spectrum Wave";
        case AmbientEffect::CHRISTMAS_WAVE: return "Christmas Dual-Tone Wave";
        case AmbientEffect::HALLOWEEN_WAVE: return "Halloween Dual-Tone Wave";
        case AmbientEffect::VALENTINE_WAVE: return "Valentine's Dual-Tone Wave";
        case AmbientEffect::FOURTH_JULY_WAVE: return "4th of July Patriotic Wave";
        case AmbientEffect::POLICE_STROBE: return "Police Strobe";
        case AmbientEffect::OCEAN_TIDE: return "Ocean Tide";
        case AmbientEffect::SUNSET_GLOW: return "Sunset Glow";
        case AmbientEffect::AURORA_BOREALIS: return "Northern Lights Aurora";
        case AmbientEffect::BREATHE: return "Ambient Breathe";
        default: return "custom_effect";
    }
}

