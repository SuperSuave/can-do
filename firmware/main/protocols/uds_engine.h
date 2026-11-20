#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "driver/twai.h"
#include "can.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool enabled;
    uint32_t awake_interval_sec;
    uint32_t sleep_delay_sec;
    float min_12v_gate_voltage;
    bool quiet_hours_enabled;
    uint16_t quiet_hours_start_min; // minutes from midnight (0..1439)
    uint16_t quiet_hours_end_min;
} uds_config_t;

typedef struct {
    float hv_voltage;       // Volts
    float hv_current;       // Amps (signed)
    float hv_power_kw;      // kW (signed: + discharging, - charging / regen)
    float bms_soc;          // %
    float cell_delta_mv;    // mV imbalance
    int8_t temp_min_c;      // °C
    int8_t temp_max_c;      // °C
    int64_t last_update_ms;
} bms_live_data_t;

void uds_engine_init(void);
void uds_engine_on_can_rx(const twai_message_t* msg, can_bus_t bus, bool from_physical_bus);
bool uds_engine_is_vehicle_awake(void);
void uds_engine_load_preferences(void);

#ifdef __cplusplus
}
#endif
