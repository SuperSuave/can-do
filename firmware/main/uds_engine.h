#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "driver/twai.h"

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
    float hv_power_kw;      // kW (signed: + charging, - driving)
    float bms_soc;          // %
    float cell_delta_mv;    // mV imbalance
    int8_t temp_min_c;      // °C
    int8_t temp_max_c;      // °C
    uint32_t last_update_ms;
} bms_live_data_t;

void uds_engine_init(void);
void uds_engine_on_can_rx(const twai_message_t* msg);
bool uds_engine_is_vehicle_awake(void);
bool uds_engine_is_gate_open(void);
bms_live_data_t uds_engine_get_bms_data(void);

#ifdef __cplusplus
}
#endif
