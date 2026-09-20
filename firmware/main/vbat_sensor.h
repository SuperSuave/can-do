#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// Initialize MeatPi WiCAN-OBD 12V Battery ADC on GPIO 4
void vbat_sensor_init(void);

// Read calibrated 12V Battery Voltage (in Volts, e.g. 12.6V)
float vbat_sensor_read(void);

// Get the latest cached battery voltage reading
float vbat_sensor_get_last(void);
const char* vbat_sensor_get_last_str(void);

#ifdef __cplusplus
}
#endif
