/*
 * Adapted from L1Z3/wicant-i-precondition:
 * https://github.com/L1Z3/wicant-i-precondition
 *
 * Original authors: L1Z3, Tyler Harvey (@tylerharvey), and contributors
 * Upstream base: meatpiHQ/wican-fw (https://github.com/meatpiHQ/wican-fw)
 * License: GPL-3.0
 *
 * Modified and maintained in sync for CAN Do (https://github.com/SuperSuave/can-do).
 */

#ifndef __PERSISTENT_SETTINGS_H__
#define __PERSISTENT_SETTINGS_H__

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void persistent_settings_init(void);
bool persistent_settings_get_precon_enabled(void);
void persistent_settings_set_precon_enabled(bool enabled);

#ifdef __cplusplus
}
#endif

#endif // __PERSISTENT_SETTINGS_H__
