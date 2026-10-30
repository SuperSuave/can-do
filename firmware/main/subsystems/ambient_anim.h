#ifndef __AMBIENT_ANIM_H__
#define __AMBIENT_ANIM_H__

#include <stdint.h>
#include <stdbool.h>
#include <string>

#ifdef __cplusplus
extern "C" {
#endif

#define AMBIENT_CAN_ID_DASH  0x4ADU // Front Crash Pad / Center Console (MLU_01)
#define AMBIENT_CAN_ID_DOORS 0x48FU // Door Panels / Rear Zone (MLU_02)

enum class AmbientEffect {
    NONE = 0,
    RAINBOW_WAVE,
    CHRISTMAS_WAVE,    // 🎄 Red & Green 2-Tone Alternating Swap
    HALLOWEEN_WAVE,    // 🎃 Orange & Purple 2-Tone Alternating Swap
    VALENTINE_WAVE,    // 💖 Neon Pink & Crimson Red 2-Tone Swap
    FOURTH_JULY_WAVE,  // 🎆 Red, White & Blue 3-Tone Patriotic Sweep
    POLICE_STROBE,     // 🚨 Rapid Red / Blue Alternating Strobe
    OCEAN_TIDE,        // 🌊 Cyan & Electric Blue Marine Flow
    SUNSET_GLOW,       // 🌅 Red, Amber & Warm Gold Sunset
    AURORA_BOREALIS,   // 🌲 Emerald Lime & Pure Cyan Northern Lights
    BREATHE            // 💓 Smooth Intensity Breathing
};

/**
 * @brief Initialize ambient lighting animation subsystem and spawn background FreeRTOS task.
 */
void ambient_anim_init(void);

/**
 * @brief Start a dynamic ambient lighting animation on the edge.
 * @param effect The effect enum to run.
 * @param step_interval_ms Custom step interval in ms (0 = effect default).
 */
void ambient_anim_start(AmbientEffect effect, uint32_t step_interval_ms = 0);

/**
 * @brief Start ambient animation by case-insensitive name / keyword.
 * Matches keywords like "rainbow", "christmas", "xmas", "halloween", "valentine",
 * "4th of july", "fourth of july", "police", "strobe", "ocean", "sunset", "aurora", "breathe".
 * @return true if an animation was matched and started, false otherwise.
 */
bool ambient_anim_start_by_name(const std::string& name);

/**
 * @brief Stop active animation task and hold current illumination.
 */
void ambient_anim_stop(void);

/**
 * @brief Return whether an animation is currently executing.
 */
bool ambient_anim_is_active(void);

/**
 * @brief Return the string name of the currently running effect, or "off".
 */
std::string ambient_anim_get_effect_name(void);

/**
 * @brief Transmit verified 2-stage ambient lighting burst (Stage 1 color + Stage 2 latch).
 * @param can_id Target CAN ID (0x4AD for Dash, 0x48F for Doors).
 * @param payload_4bytes 4-byte color definition [D1, D2, D3, D4].
 */
void ambient_anim_send_burst(uint32_t can_id, const uint8_t* payload_4bytes);

/**
 * @brief Transmit 2-stage burst to power off ambient lamps.
 * @param can_id Target CAN ID (0x4AD or 0x48F, or 0 for both).
 */
void ambient_anim_send_off(uint32_t can_id = 0);

/**
 * @brief Get 4-byte payload for palette color by 1-based index (1..64).
 * @param index 1..64
 * @param out_payload Array of 4 bytes to receive [D1, D2, D3, D4]
 * @return true if valid index
 */
bool ambient_anim_get_palette_color(uint8_t index, uint8_t* out_payload);

/**
 * @brief Map arbitrary RGB coordinates to closest verified vehicle palette color (1..64).
 * @param r Red (0-255)
 * @param g Green (0-255)
 * @param b Blue (0-255)
 * @return Closest palette 1-based index (1..64)
 */
uint8_t ambient_anim_find_closest_palette_index(uint8_t r, uint8_t g, uint8_t b);

#ifdef __cplusplus
}
#endif

#endif // __AMBIENT_ANIM_H__

