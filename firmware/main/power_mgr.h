#pragma once

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    POWER_TIER_ACTIVE = 0,   // Full power (driving/charging, CAN active, active polling)
    POWER_TIER_STANDBY = 1,  // Wi-Fi Modem Sleep (~18mA, car parked, instant response)
    POWER_TIER_DEEP_SLEEP = 2 // Deep Sleep (<1mA, Quiet Hours or 12V low, instant wake on CAN RX)
} power_tier_t;

void power_mgr_init(void);
void power_mgr_set_tier(power_tier_t tier);
power_tier_t power_mgr_get_tier(void);
void power_mgr_enter_deep_sleep(uint32_t sleep_duration_sec);

#ifdef __cplusplus
}
#endif
