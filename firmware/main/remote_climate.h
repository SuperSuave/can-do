#pragma once

#include <cstdint>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Initialize the remote climate subsystem and spawn background FreeRTOS task.
 */
void remote_climate_init(void);

/**
 * @brief Start E-GMP remote climate via TMU (0x039B) and UDS TesterPresent (0x07DF).
 * 
 * @param target_temp_c Target cabin temperature in Celsius (e.g. 22.0).
 * @param defrost Enable windshield max defroster if true.
 * @param duration_sec Session duration in seconds (default 900 = 15 minutes).
 * @return esp_err_t ESP_OK on success.
 */
esp_err_t remote_climate_start(float target_temp_c, bool defrost, uint32_t duration_sec);

/**
 * @brief Stop active remote climate session and send 5 release bursts (AirconCtr=0).
 * 
 * @return esp_err_t ESP_OK on success.
 */
esp_err_t remote_climate_stop(void);

/**
 * @brief Check if remote climate is currently actively transmitting.
 */
bool remote_climate_is_active(void);

/**
 * @brief Get status of remote climate session.
 */
void remote_climate_get_status(bool* active, float* target_temp, bool* defrost, uint32_t* remaining_sec);

#ifdef __cplusplus
}
#endif
