#pragma once
#include <string>
#include <stddef.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize timezone manager from storage (/spiffs/preferences.json or automations.json)
 * and apply POSIX TZ to runtime.
 */
void timezone_mgr_init(void);

/**
 * Reload timezone from filesystem (/spiffs/preferences.json or /spiffs/automations.json)
 */
void timezone_mgr_load_from_fs(void);

/**
 * Set timezone using standard identifier (e.g. "US/Pacific", "America/New_York", "UTC")
 * or friendly alias, applying POSIX TZ to runtime and optionally saving to preferences.
 * Returns true if recognized or applied.
 */
bool timezone_mgr_set(const char* tz_id_or_name, bool persist = true);

/**
 * Get current timezone identifier (e.g. "US/Pacific")
 */
const char* timezone_mgr_get_id(void);

/**
 * Get current POSIX TZ string (e.g. "PST8PDT,M3.2.0,M11.1.0")
 */
const char* timezone_mgr_get_posix(void);

/**
 * Format timestamp in configured local timezone
 */
void timezone_mgr_format_local(time_t epoch, char* out_buf, size_t max_len);

#ifdef __cplusplus
}
#endif
