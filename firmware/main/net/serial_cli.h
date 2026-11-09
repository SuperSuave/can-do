#pragma once

#include <cstddef>

#ifdef __cplusplus
extern "C" {
#endif

void serial_cli_init(void);
void serial_cli_process_line(const char* line, size_t len);

#ifdef __cplusplus
}
#endif

