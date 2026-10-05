#pragma once

#include <cstdint>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void remote_climate_init(void);
bool remote_climate_start(float target_temp_c, uint32_t duration_minutes);
void remote_climate_stop(void);
void remote_climate_toggle(float target_temp_c, uint32_t duration_minutes);
bool remote_climate_is_active(void);

#ifdef __cplusplus
}
#endif
