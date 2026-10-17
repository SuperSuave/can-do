#ifndef __CALL_POPUP_H__
#define __CALL_POPUP_H__

#include <stdbool.h>
#include <stdint.h>
#include "can.h"
#include "hsm.h"

#define CALL_POPUP_MAX_TEXT_CODE_UNITS 50U
#define CALL_POPUP_MAX_TEXT_UTF8_BYTES (CALL_POPUP_MAX_TEXT_CODE_UNITS * 3U)

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    CALL_POPUP_SEV_INFO = 1,     // 1 beep, standard banner
    CALL_POPUP_SEV_WARNING = 2,  // 2 beeps, warning banner
    CALL_POPUP_SEV_CRITICAL = 3, // 3 beeps, critical alert banner
} call_popup_severity_t;

/**
 * Initialize the cluster call / alert popup subsystem.
 * Configures ISO-TP on the telematics / Bluetooth handsfree channel (0x6D4 / 0x6B4).
 */
void call_popup_init(void);

/**
 * State machine tick and frame hooks for integration into can_engine / precondition loop.
 */
void call_popup_tick(void);
void call_popup_rx(const twai_message_t *msg, can_bus_t rx_bus);
fwd_result_t call_popup_fwd(twai_message_t *msg, can_bus_t fwd_bus);

/**
 * Trigger an incoming alert / notification modal on the instrument cluster.
 * 
 * @param caller_id Header/Title (e.g. "Home Assistant", "Front Door", "Security")
 * @param message   Body/Message (e.g. "Garage Left Open", "Washer Finished")
 * @param severity  Alert severity (controls audio beeps and visual modal icon)
 * @param hold_ms   Duration to hold display before clean dismissal (default: 5000ms)
 * @return true if queued successfully
 */
bool call_popup_show(const char *caller_id, const char *message, 
                     call_popup_severity_t severity, uint32_t hold_ms);

/**
 * Manually dismiss any active alert modal on the cluster.
 */
void call_popup_dismiss(void);

#ifdef __cplusplus
}
#endif

#endif // __CALL_POPUP_H__
