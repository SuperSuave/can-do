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

#include "persistent_settings.h"

static bool s_precon_enabled = false;

void persistent_settings_init(void) {
    // Default initial state
    s_precon_enabled = false;
}

bool persistent_settings_get_precon_enabled(void) {
    return s_precon_enabled;
}

void persistent_settings_set_precon_enabled(bool enabled) {
    s_precon_enabled = enabled;
}
