#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Initialize MeatPi WiCAN-OBD 12V Battery ADC on GPIO 4
void vbat_sensor_init(void);

// Read calibrated 12V Battery Voltage (in Volts, e.g. 12.6V)
float vbat_sensor_read(void);

// Get the latest cached battery voltage reading (returns 0.0f if CAN-sourced reading is stale >10s)
float vbat_sensor_get_last(void);
bool vbat_sensor_is_fresh(void);
const char* vbat_sensor_get_last_str(void);
size_t vbat_sensor_get_last_str_copy(char *out, size_t len);
void vbat_sensor_set_from_can(float voltage);

#ifdef __cplusplus
}
#endif
