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
