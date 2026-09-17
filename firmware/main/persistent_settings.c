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
