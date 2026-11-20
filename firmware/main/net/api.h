#pragma once

#include "esp_http_server.h"
#include "psram_alloc.h"
#include <string>
#include <cstdarg>

extern httpd_handle_t global_web_server;

void broadcast_ws_raw(const std::string& json_str);
void broadcast_ws_state(const std::string& entity_id, const std::string& state);
void broadcast_ws_automation_event(const std::string& id, const std::string& name);
int custom_websocket_logger(const char *fmt, va_list args);
bool is_serving_static_page(void);
bool has_active_websocket_clients(void);
PsramUnorderedMap<std::string, std::string> get_live_state_cache(void);

httpd_handle_t start_webserver(void);
