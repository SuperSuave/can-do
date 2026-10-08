#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "driver/twai.h"

#ifdef __cplusplus
extern "C" {
#endif

void remote_climate_init(void);
bool remote_climate_start(float target_temp_c, uint32_t duration_minutes);
bool remote_climate_start_ext(float target_temp_c, uint32_t duration_minutes, bool monitor_0x38);
bool remote_climate_start_dumb(float target_temp_c, uint32_t duration_minutes);
bool remote_climate_start_smart(float target_temp_c, uint32_t duration_minutes);
void remote_climate_stop(void);
void remote_climate_toggle(float target_temp_c, uint32_t duration_minutes, bool monitor_0x38);
bool remote_climate_is_active(void);
void remote_climate_on_can_rx(const twai_message_t* rx_msg);

#ifdef __cplusplus
}
#endif
