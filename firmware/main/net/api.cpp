#include "api.h"
#include "ble_mgr.h"
#include "esp_littlefs.h"
#include <dirent.h>
#include "parser.h"
#include "can_engine.h"
#include "can.h"
#include "mcp2518fd.h"
#include "network_mgr.h"
#include "gvret_server.h"
#include "mqtt_mgr.h"
#include "track_popup.h"
#include "config_server.h"
#include "hud_nav.h"
#include "vbat_sensor.h"
#include "uds_engine.h"
#include "power_mgr.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_system.h"
#include "esp_sleep.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "driver/twai.h"
#include "esp_sntp.h"
#include "timezone_mgr.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <cmath>
#include <algorithm>
#include <new>
#include <utility>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <mutex>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "psram_alloc.h"

static const char* TAG = "WEB_API";
extern std::string g_device_id;
#define DEVICE_ID g_device_id

httpd_handle_t global_web_server = nullptr;
static vprintf_like_t original_log_vprintf = nullptr;
static std::atomic<int> s_active_static_transfers{0};

struct StaticTransferGuard {
    StaticTransferGuard() {
        s_active_static_transfers.fetch_add(1, std::memory_order_relaxed);
    }
    ~StaticTransferGuard() {
        s_active_static_transfers.fetch_sub(1, std::memory_order_relaxed);
    }
    StaticTransferGuard(const StaticTransferGuard&) = delete;
    StaticTransferGuard& operator=(const StaticTransferGuard&) = delete;
};

struct CatalogReloadGuard {
    CatalogReloadGuard() {
        g_catalog_reloading.store(true, std::memory_order_release);
    }
    ~CatalogReloadGuard() {
        g_catalog_reloading.store(false, std::memory_order_release);
    }
    CatalogReloadGuard(const CatalogReloadGuard&) = delete;
    CatalogReloadGuard& operator=(const CatalogReloadGuard&) = delete;
};

struct PsramBuf {
    char *ptr = nullptr;
    size_t len = 0;

    explicit PsramBuf(size_t size) : len(size) {
        if (size > 0) {
#if CONFIG_SPIRAM
            ptr = static_cast<char *>(heap_caps_malloc_prefer(
                size, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
#else
            ptr = static_cast<char *>(std::malloc(size));
#endif
        }
    }
    ~PsramBuf() {
        if (ptr) {
            std::free(ptr);
        }
    }
    PsramBuf(const PsramBuf&) = delete;
    PsramBuf& operator=(const PsramBuf&) = delete;
    explicit operator bool() const { return ptr != nullptr; }
    char *data() { return ptr; }
    const char *data() const { return ptr; }
    size_t size() const { return len; }
};

static constexpr size_t kMaxAutomationsBytes = 128 * 1024;
static constexpr size_t kMaxPreferencesBytes = 8 * 1024;
static constexpr int kMaxStreamTimeoutRetries = 5;
static constexpr int kMaxOtaTimeoutRetries = 10;

static std::mutex s_crash_diag_mutex;
static std::string s_cached_crash_diag_json;
static bool s_crash_diag_loaded = false;

static void load_crash_diag_cache_once(void) {
    std::lock_guard<std::mutex> lock(s_crash_diag_mutex);
    if (s_crash_diag_loaded) return;
    s_crash_diag_loaded = true;
    FILE *diag_f = fopen("/spiffs/crash_diag.json", "r");
    if (!diag_f) return;
    PsramBuf diag_buf(1024);
    if (!diag_buf) {
        fclose(diag_f);
        return;
    }
    size_t n = fread(diag_buf.data(), 1, diag_buf.size() - 1, diag_f);
    fclose(diag_f);
    diag_buf.data()[n] = '\0';
    if (n > 0) {
        cJSON *cj_persisted = cJSON_Parse(diag_buf.data());
        if (cj_persisted) {
            char *normalized = cJSON_PrintUnformatted(cj_persisted);
            cJSON_Delete(cj_persisted);
            if (normalized) {
                s_cached_crash_diag_json.assign(normalized);
                free(normalized);
            }
        }
    }
}

bool is_serving_static_page(void) {
    return s_active_static_transfers.load() > 0;
}

struct ws_msg_t {
    int fd;
    std::string payload;
};

static constexpr int kMaxPendingWsMsgs = 32;
static std::atomic<int> s_pending_ws_msgs{0};

static void ws_async_send(void *arg) {
    ws_msg_t *msg = static_cast<ws_msg_t*>(arg);
    if (!msg) return;

    if (global_web_server &&
        httpd_ws_get_fd_info(global_web_server, msg->fd) == HTTPD_WS_CLIENT_WEBSOCKET) {
        httpd_ws_frame_t ws_pkt;
        memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
        ws_pkt.payload = reinterpret_cast<uint8_t*>(const_cast<char*>(msg->payload.c_str()));
        ws_pkt.len = msg->payload.length();
        ws_pkt.type = HTTPD_WS_TYPE_TEXT;

        httpd_ws_send_frame_async(global_web_server, msg->fd, &ws_pkt);
    }
    delete msg;
    s_pending_ws_msgs.fetch_sub(1, std::memory_order_acq_rel);
}

bool has_active_websocket_clients(void) {
    if (!global_web_server) return false;
    size_t max_clients = 8;
    int client_fds[8];
    size_t clients = max_clients;
    if (httpd_get_client_list(global_web_server, &clients, client_fds) == ESP_OK) {
        for (size_t i = 0; i < clients; ++i) {
            if (httpd_ws_get_fd_info(global_web_server, client_fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
                return true;
            }
        }
    }
    return false;
}

void broadcast_ws_raw(const std::string& json_str) {
    if (!global_web_server || is_serving_static_page()) return;
    size_t max_clients = 8;
    int client_fds[8];
    size_t clients = max_clients;

    if (httpd_get_client_list(global_web_server, &clients, client_fds) == ESP_OK) {
        for (size_t i = 0; i < clients; ++i) {
            if (httpd_ws_get_fd_info(global_web_server, client_fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
                int cur = s_pending_ws_msgs.load(std::memory_order_relaxed);
                while (cur < kMaxPendingWsMsgs &&
                       !s_pending_ws_msgs.compare_exchange_weak(
                           cur, cur + 1, std::memory_order_acq_rel, std::memory_order_relaxed)) {
                }
                if (cur >= kMaxPendingWsMsgs) {
                    return; // Drop update when WS async queue is saturated
                }

                ws_msg_t *msg = new (std::nothrow) ws_msg_t{client_fds[i], json_str};
                if (!msg) {
                    s_pending_ws_msgs.fetch_sub(1, std::memory_order_acq_rel);
                    return;
                }
                if (httpd_queue_work(global_web_server, ws_async_send, msg) != ESP_OK) {
                    delete msg;
                    s_pending_ws_msgs.fetch_sub(1, std::memory_order_acq_rel);
                }
            }
        }
    }
}

static PsramUnorderedMap<std::string, std::string> s_live_state_cache;
static std::mutex s_state_cache_mutex;
static std::atomic<bool> s_has_ws_clients_cached{false};

PsramUnorderedMap<std::string, std::string> get_live_state_cache(void) {
    std::lock_guard<std::mutex> lock(s_state_cache_mutex);
    return s_live_state_cache;
}

static void append_json_escaped(std::string& out, const char* data, size_t len) {
    for (size_t i = 0; i < len; ++i) {
        char ch = data[i];
        if (ch == '"') out += "\\\"";
        else if (ch == '\\') out += "\\\\";
        else if (ch == '\n') out += "\\n";
        else if (ch == '\r') out += "\\r";
        else if (ch == '\t') out += "\\t";
        else if (static_cast<uint8_t>(ch) >= 0x20) out += ch;
    }
}

static void append_json_escaped(std::string& out, const std::string& val) {
    append_json_escaped(out, val.data(), val.size());
}

static std::string build_ws_state_json(const std::string& entity_id, const std::string& state) {
    std::string out = "{\"type\":\"state\",\"entity\":\"";
    out.reserve(entity_id.length() + state.length() + 40);
    append_json_escaped(out, entity_id);
    out += "\",\"state\":\"";
    append_json_escaped(out, state);
    out += "\"}";
    return out;
}

void broadcast_ws_state(const std::string& entity_id, const std::string& state) {
    {
        std::lock_guard<std::mutex> lock(s_state_cache_mutex);
        auto it = s_live_state_cache.find(entity_id);
        if (it != s_live_state_cache.end() && it->second == state) {
            return; // Deduplicate identical state updates
        }
        s_live_state_cache[entity_id] = state;
    }
    if (!s_has_ws_clients_cached.load(std::memory_order_relaxed)) return;
    broadcast_ws_raw(build_ws_state_json(entity_id, state));
}

void broadcast_ws_automation_event(const std::string& id, const std::string& name) {
    if (!s_has_ws_clients_cached.load(std::memory_order_relaxed)) return;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    std::string out = "{\"type\":\"automation_fired\",\"id\":\"";
    out.reserve(id.length() + name.length() + 64);
    append_json_escaped(out, id);
    out += "\",\"name\":\"";
    append_json_escaped(out, name);
    char ts_buf[32];
    snprintf(ts_buf, sizeof(ts_buf), "\",\"ts\":%lu}", (unsigned long)now_ms);
    out += ts_buf;
    broadcast_ws_raw(out);
}

struct ws_log_item_t {
    char text[192];
};
static constexpr UBaseType_t kWsLogQueueLen = 16;
static QueueHandle_t s_ws_log_queue = nullptr;
#if CONFIG_SPIRAM
static StaticQueue_t s_ws_log_queue_struct;
static uint8_t *s_ws_log_queue_storage = nullptr;
#endif

static void ws_log_worker_task(void *arg) {
    ws_log_item_t item;
    while (true) {
        bool has_clients = has_active_websocket_clients();
        s_has_ws_clients_cached.store(has_clients, std::memory_order_relaxed);

        if (!has_clients) {
            // When no WS client is connected, sleep to avoid spinning
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }

        // Wait up to 200ms for queued log lines; on timeout, loop to re-verify client connection
        if (xQueueReceive(s_ws_log_queue, &item, pdMS_TO_TICKS(200)) == pdTRUE) {
            if (!global_web_server || is_serving_static_page()) {
                continue;
            }
            size_t len = strnlen(item.text, sizeof(item.text));
            while (len > 0 && (item.text[len - 1] == '\n' || item.text[len - 1] == '\r')) {
                --len;
            }
            if (len == 0) continue;

            std::string json = "{\"type\":\"log\",\"msg\":\"";
            json.reserve(len + 32);
            append_json_escaped(json, item.text, len);
            json += "\"}";
            broadcast_ws_raw(json);
        }
    }
}

int custom_websocket_logger(const char *fmt, va_list args) {
    static std::atomic<bool> s_in_logger{false};

    // Atomic re-entrancy guard + non-blocking queueing (0-tick drop on queue full)
    // NEVER calls httpd functions, takes locks, or allocates dynamic memory in logger context!
    if (!s_in_logger.exchange(true, std::memory_order_acquire)) {
        if (s_ws_log_queue && global_web_server && !is_serving_static_page() && s_has_ws_clients_cached.load(std::memory_order_relaxed)) {
            ws_log_item_t item;
            va_list args_copy;
            va_copy(args_copy, args);
            int len = vsnprintf(item.text, sizeof(item.text), fmt, args_copy);
            va_end(args_copy);

            if (len > 0) {
                // Non-blocking enqueue with 0 tick wait: drops immediately if queue is full
                xQueueSend(s_ws_log_queue, &item, 0);
            }
        }
        s_in_logger.store(false, std::memory_order_release);
    }

    if (original_log_vprintf) {
        return original_log_vprintf(fmt, args);
    }
    return 0;
}

static esp_err_t send_reboot_json_response(httpd_req_t *req, const char *json_body, uint32_t delay_ms = 1200) {
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Connection", "close");
    httpd_resp_sendstr(req, json_body);
    power_mgr_schedule_restart(delay_ms);
    return ESP_OK;
}

static esp_err_t set_content_type_from_file(httpd_req_t *req, const char *filepath) {
    if (strstr(filepath, ".html")) return httpd_resp_set_type(req, "text/html");
    if (strstr(filepath, ".json")) return httpd_resp_set_type(req, "application/json");
    if (strstr(filepath, ".js")) return httpd_resp_set_type(req, "application/javascript");
    if (strstr(filepath, ".css")) return httpd_resp_set_type(req, "text/css");
    if (strstr(filepath, ".svg")) return httpd_resp_set_type(req, "image/svg+xml");
    if (strstr(filepath, ".png")) return httpd_resp_set_type(req, "image/png");
    if (strstr(filepath, ".ico")) return httpd_resp_set_type(req, "image/x-icon");
    if (strstr(filepath, ".woff2")) return httpd_resp_set_type(req, "font/woff2");
    return httpd_resp_set_type(req, "text/plain");
}

static void set_cors_headers(httpd_req_t *req);

static esp_err_t static_file_handler(httpd_req_t *req) {
    PsramBuf filepath_buf(600);
    PsramBuf gz_filepath_buf(610);
    if (!filepath_buf || !gz_filepath_buf) {
        set_cors_headers(req);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        return ESP_OK;
    }
    char *filepath = filepath_buf.data();
    char *gz_filepath = gz_filepath_buf.data();

    // Determine candidate file path
    if (strcmp(req->uri, "/") == 0) {
        snprintf(filepath, filepath_buf.size(), "/spiffs/www/index.html");
    } else if (strncmp(req->uri, "/catalog.json", 13) == 0 || strstr(req->uri, "can_do_catalog.json")) {
        // Look for catalog in root first (/spiffs/catalog.json), then under /spiffs/www/
        struct stat st_test;
        if (stat("/spiffs/catalog.json", &st_test) == 0 || stat("/spiffs/catalog.json.gz", &st_test) == 0) {
            snprintf(filepath, filepath_buf.size(), "/spiffs/catalog.json");
        } else if (stat("/spiffs/can_do_catalog.json", &st_test) == 0) {
            snprintf(filepath, filepath_buf.size(), "/spiffs/can_do_catalog.json");
        } else {
            snprintf(filepath, filepath_buf.size(), "/spiffs/www%s", req->uri);
        }
    } else if (strncmp(req->uri, "/automations.json", 17) == 0) {
        snprintf(filepath, filepath_buf.size(), "/spiffs/automations.json");
    } else {
        snprintf(filepath, filepath_buf.size(), "/spiffs/www%s", req->uri);
    }

    // Strip any query parameters
    char *query = strchr(filepath, '?');
    if (query) *query = '\0';

    snprintf(gz_filepath, gz_filepath_buf.size(), "%s.gz", filepath);

    struct stat file_stat;
    bool is_gz = false;
    int fd = -1;

    // 1. Check if a pre-gzipped version exists (.gz)
    if (stat(gz_filepath, &file_stat) == 0) {
        fd = open(gz_filepath, O_RDONLY, 0);
        is_gz = true;
    } else if (stat(filepath, &file_stat) == 0) {
        fd = open(filepath, O_RDONLY, 0);
    } else {
        // 2. SPA Fallback: serve index.html or index.html.gz for client-side routing (never for /api/)
        const char *dot = strrchr(req->uri, '.');
        if (strncmp(req->uri, "/api/", 5) != 0 && (!dot || strcmp(dot, ".html") == 0)) {
            snprintf(gz_filepath, gz_filepath_buf.size(), "/spiffs/www/index.html.gz");
            if (stat(gz_filepath, &file_stat) == 0) {
                fd = open(gz_filepath, O_RDONLY, 0);
                is_gz = true;
                snprintf(filepath, filepath_buf.size(), "/spiffs/www/index.html");
            } else if (stat("/spiffs/www/index.html", &file_stat) == 0) {
                fd = open("/spiffs/www/index.html", O_RDONLY, 0);
                snprintf(filepath, filepath_buf.size(), "/spiffs/www/index.html");
            }
        }
    }

    if (fd == -1) {
        if (strcmp(req->uri, "/") == 0 || strcmp(req->uri, "/index.html") == 0) {
            static const char* FALLBACK_HTML = 
                "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                "<title>CAN Do Setup</title><style>"
                "body{font-family:system-ui,sans-serif;max-width:440px;margin:2rem auto;padding:1rem;background:#0f172a;color:#f8fafc}"
                ".card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;box-shadow:0 10px 15px -3px rgba(0,0,0,0.5)}"
                "h1{font-size:1.4rem;margin:0 0 0.5rem;color:#38bdf8}h2{font-size:1rem;color:#94a3b8;margin:1rem 0 0.5rem}"
                "label{display:block;margin:0.75rem 0 0.25rem;font-size:0.85rem;color:#cbd5e1}"
                "input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:0.6rem;background:#334155;border:1px solid #475569;border-radius:6px;color:#fff}"
                "button{width:100%;padding:0.75rem;margin-top:1.25rem;background:#2563eb;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer}"
                "button:hover{background:#1d4ed8}.badge{display:inline-block;padding:0.2rem 0.5rem;background:#065f46;color:#a7f3d0;border-radius:4px;font-size:0.75rem;font-weight:600}"
                "#msg{margin-top:1rem;font-size:0.9rem;color:#38bdf8}"
                "</style></head><body><div class=\"card\">"
                "<h1>CAN Do ESP32-S3</h1><span class=\"badge\">SoftAP Mode</span>"
                "<h2>Connect to Local Wi-Fi</h2>"
                "<form id=\"wf\" onsubmit=\"submitWifi(event)\">"
                "<label>Wi-Fi Network Name (SSID)</label><input type=\"text\" id=\"ssid\" required>"
                "<label>Wi-Fi Password</label><input type=\"password\" id=\"pwd\">"
                "<button type=\"submit\" id=\"btn\">Save &amp; Connect</button></form>"
                "<div id=\"msg\"></div>"
                "<p style=\"font-size:0.8rem;color:#64748b;margin-top:1.5rem\">Tip: You can also configure credentials via Serial console using: <code>wifi \"SSID\" \"PASSWORD\"</code></p>"
                "</div><script>"
                "async function submitWifi(e){e.preventDefault();const btn=document.getElementById('btn');const msg=document.getElementById('msg');"
                "btn.disabled=true;btn.innerText='Connecting...';msg.innerText='Saving network credentials...';"
                "try{const res=await fetch('/api/wifi/networks',{method:'POST',headers:{'Content-Type':'application/json'},"
                "body:JSON.stringify({ssid:document.getElementById('ssid').value,password:document.getElementById('pwd').value,priority:100})});"
                "if(res.ok){msg.innerText='Credentials saved! Connecting to Wi-Fi... Check Serial monitor for assigned IP.';}"
                "else{msg.innerText='Error saving credentials.';btn.disabled=false;btn.innerText='Retry';}}"
                "catch(err){msg.innerText='Failed: '+err;btn.disabled=false;btn.innerText='Retry';}}"
                "</script></body></html>";
            set_cors_headers(req);
            httpd_resp_set_type(req, "text/html");
            httpd_resp_sendstr(req, FALLBACK_HTML);
            return ESP_OK;
        }

        set_cors_headers(req);
        httpd_resp_send_404(req);
        return ESP_OK;
    }

    // 3. Set headers (CORS, MIME type, Content-Encoding: gzip)
    set_cors_headers(req);
    set_content_type_from_file(req, filepath);
    if (is_gz) {
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    }

    // Cache control: immutable for hashed assets, no-cache for index.html
    if (strstr(filepath, ".js") || strstr(filepath, ".css") || strstr(filepath, ".woff2") || strstr(filepath, ".png") || strstr(filepath, ".svg")) {
        httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");
    } else {
        httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    }

    // 4. Stream file out in 2KB chunks using PSRAM-preferring buffer to keep httpd stack lean
    // Mark transfer as active to prevent WebSocket streaming from overloading Wi-Fi/LwIP during page load
    StaticTransferGuard transfer_guard;

    PsramBuf file_chunk(2048);
    if (!file_chunk) {
        close(fd);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        return ESP_OK;
    }

    ssize_t read_bytes;
    while ((read_bytes = read(fd, file_chunk.data(), file_chunk.size())) > 0) {
        if (httpd_resp_send_chunk(req, file_chunk.data(), read_bytes) != ESP_OK) {
            ESP_LOGW(TAG, "Chunk send failed for %s", filepath);
            close(fd);
            return ESP_FAIL;
        }
    }

    close(fd);
    httpd_resp_send_chunk(req, nullptr, 0); // Terminate chunked response
    return ESP_OK;
}

static void set_cors_headers(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
    httpd_resp_set_hdr(req, "Access-Control-Max-Age", "86400");
}

static esp_err_t options_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_status(req, "204 No Content");
    httpd_resp_send(req, nullptr, 0);
    return ESP_OK;
}

static esp_err_t send_cjson_response(httpd_req_t *req, cJSON *root) {
    if (!root) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of Memory");
        return ESP_OK;
    }
    char *str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!str) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of Memory");
        return ESP_OK;
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_sendstr(req, str);
    free(str);
    return err;
}

static esp_err_t send_payload_too_large(httpd_req_t *req, const char *msg) {
    httpd_resp_set_status(req, "413 Payload Too Large");
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_set_hdr(req, "Connection", "close");
    httpd_resp_sendstr(req, msg);
    return ESP_FAIL;
}

static esp_err_t send_err_with_body_check(httpd_req_t *req, httpd_err_code_t code, const char *msg, bool body_consumed) {
    if (!body_consumed && req->content_len > 0) {
        httpd_resp_set_hdr(req, "Connection", "close");
        httpd_resp_send_err(req, code, msg);
        return ESP_FAIL;
    }
    httpd_resp_send_err(req, code, msg);
    return ESP_OK;
}

static bool read_req_body(httpd_req_t *req, size_t max_len, std::string &out, esp_err_t *out_err) {
    out.clear();
    if (out_err) *out_err = ESP_OK;
    if (req->content_len == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty request body");
        if (out_err) *out_err = ESP_OK;
        return false;
    }
    if (req->content_len > max_len) {
        esp_err_t err = send_payload_too_large(req, "Request body too large");
        if (out_err) *out_err = err;
        return false;
    }

    out.resize(req->content_len);
    size_t total_read = 0;
    int timeout_retries = 0;

    while (total_read < req->content_len) {
        int r = httpd_req_recv(req, &out[total_read], req->content_len - total_read);
        if (r > 0) {
            total_read += static_cast<size_t>(r);
            timeout_retries = 0;
        } else if (r == HTTPD_SOCK_ERR_TIMEOUT) {
            if (++timeout_retries > kMaxStreamTimeoutRetries) {
                out.clear();
                httpd_resp_set_hdr(req, "Connection", "close");
                httpd_resp_send_err(req, HTTPD_408_REQ_TIMEOUT, "Request body timeout");
                if (out_err) *out_err = ESP_FAIL;
                return false;
            }
            continue;
        } else {
            out.clear();
            if (out_err) *out_err = ESP_FAIL;
            return false;
        }
    }
    return true;
}

static esp_err_t api_states_handler(httpd_req_t *req) {
    set_cors_headers(req);
    PsramUnorderedMap<std::string, std::string> cache_snapshot = get_live_state_cache();
    PsramVector<std::pair<std::string, std::string>> catalog_snapshot;

    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        catalog_snapshot.reserve(global_catalog.size());
        for (const auto& entity : global_catalog) {
            catalog_snapshot.emplace_back(entity.id, entity.current_state);
        }
    }

    cJSON *root = cJSON_CreateArray();
    if (!root) {
        return send_cjson_response(req, nullptr);
    }
    PsramUnorderedSet<std::string> included;

    for (const auto& entry : catalog_snapshot) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", entry.first.c_str());
        std::string st = entry.second;
        auto it = cache_snapshot.find(entry.first);
        if (it != cache_snapshot.end()) {
            st = it->second;
        }
        cJSON_AddStringToObject(item, "state", st.empty() ? "Unknown" : st.c_str());
        cJSON_AddItemToArray(root, item);
        included.insert(entry.first);
    }

    for (const auto& pair : cache_snapshot) {
        if (included.find(pair.first) == included.end()) {
            cJSON *item = cJSON_CreateObject();
            cJSON_AddStringToObject(item, "entity", pair.first.c_str());
            cJSON_AddStringToObject(item, "state", pair.second.c_str());
            cJSON_AddItemToArray(root, item);
            included.insert(pair.first);
        }
    }

    // Always include live hardware ADC 12V battery reading
    if (included.find("cond_aux_12v_battery") == included.end()) {
        char vbat_buf[16];
        vbat_sensor_get_last_str_copy(vbat_buf, sizeof(vbat_buf));
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", "cond_aux_12v_battery");
        cJSON_AddStringToObject(item, "state", vbat_buf);
        cJSON_AddItemToArray(root, item);
    }

    return send_cjson_response(req, root);
}

static esp_err_t api_command_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 8192, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *target_entity = cJSON_GetObjectItem(root, "entity");
    cJSON *target_cmd = cJSON_GetObjectItem(root, "command");
    cJSON *target_can_id = cJSON_GetObjectItem(root, "can_id");

    if (cJSON_IsString(target_entity)) {
        std::string cmd_str = cJSON_IsString(target_cmd) ? target_cmd->valuestring : "";
        cJSON *mode_item = cJSON_GetObjectItem(root, "mode");
        cJSON *action_item = cJSON_GetObjectItem(root, "action");
        const bool has_mode = cJSON_IsString(mode_item) && mode_item->valuestring[0] != '\0';
        const bool has_action = cJSON_IsString(action_item) && action_item->valuestring[0] != '\0';
        const bool is_precon_entity =
            (strcmp(target_entity->valuestring, "battery_preconditioning") == 0 ||
             strcmp(target_entity->valuestring, "precondition") == 0);
        if ((has_mode || has_action) && (is_precon_entity || cmd_str.empty()) &&
            (cmd_str.empty() || cmd_str[0] != '{')) {
            cJSON *fwd = cJSON_CreateObject();
            if (fwd) {
                if (has_mode) cJSON_AddStringToObject(fwd, "mode", mode_item->valuestring);
                if (has_action) cJSON_AddStringToObject(fwd, "action", action_item->valuestring);
                char *fwd_str = cJSON_PrintUnformatted(fwd);
                cJSON_Delete(fwd);
                if (fwd_str) {
                    cmd_str = fwd_str;
                    free(fwd_str);
                }
            }
        }
        if (queue_entity_command(target_entity->valuestring, cmd_str)) {
            cJSON_Delete(root);
            httpd_resp_set_type(req, "application/json");
            httpd_resp_sendstr(req, "{\"status\": \"queued\"}");
            return ESP_OK;
        }
    }

    uint32_t cid = 0;
    if (cJSON_IsString(target_can_id)) {
        cid = strtoul(target_can_id->valuestring, nullptr, 0);
    } else if (cJSON_IsNumber(target_can_id)) {
        cid = (uint32_t)target_can_id->valuedouble;
    }

    cJSON *bus_item = cJSON_GetObjectItem(root, "bus");
    uint8_t top_bus = 0;
    if (cJSON_IsNumber(bus_item)) {
        top_bus = (uint8_t)bus_item->valuedouble;
    } else if (cJSON_IsString(bus_item)) {
        top_bus = (uint8_t)strtoul(bus_item->valuestring, nullptr, 0);
    }

    cJSON *delay_item = cJSON_GetObjectItem(root, "delay_ms");
    uint32_t top_delay_ms = (cJSON_IsNumber(delay_item) && delay_item->valuedouble >= 0)
        ? (uint32_t)delay_item->valuedouble
        : 20;

    // Multi-step CAN sequence fallback (e.g. door_locks, seat comfort, charging limits, airflow, press/release bursts)
    cJSON *steps_item = cJSON_GetObjectItem(root, "steps");
    if (cJSON_IsArray(steps_item) && cJSON_GetArraySize(steps_item) > 0) {
        PsramVector<ActionStep> parsed_steps;
        cJSON *s_item = nullptr;
        cJSON_ArrayForEach(s_item, steps_item) {
            ActionStep step;
            if (parse_action_step(s_item, step)) {
                if (step.type == ActionType::TRANSMIT_FRAME && step.can_id == 0) {
                    step.can_id = cid;
                }
                if (!cJSON_GetObjectItem(s_item, "bus")) {
                    step.bus = top_bus;
                }
                if (step.type != ActionType::TRANSMIT_FRAME || step.can_id != 0) {
                    parsed_steps.push_back(std::move(step));
                }
            }
        }
        uint32_t burst_cid = cid;
        if (burst_cid == 0) {
            for (const auto& st : parsed_steps) {
                if (st.type == ActionType::TRANSMIT_FRAME && st.can_id != 0) {
                    burst_cid = st.can_id;
                    break;
                }
            }
        }
        if (!parsed_steps.empty() && queue_action_steps(burst_cid, top_delay_ms, parsed_steps)) {
            cJSON_Delete(root);
            httpd_resp_set_type(req, "application/json");
            httpd_resp_sendstr(req, "{\"status\": \"queued\"}");
            return ESP_OK;
        }
    }

    // Single-frame direct CAN fallback (or fallback if entity was not resolved in catalog / param_range)
    if (cid != 0) {
        cJSON *payload_item = cJSON_GetObjectItem(root, "payload");
        cJSON *repeat_item = cJSON_GetObjectItem(root, "repeat");

        ActionStep step = {};
        step.type = ActionType::TRANSMIT_FRAME;
        step.can_id = cid;
        int rep_val = cJSON_IsNumber(repeat_item) ? (int)repeat_item->valuedouble : 1;
        step.repeat = (uint8_t)std::max(1, std::min(255, rep_val));
        step.delay_ms = (cJSON_IsNumber(delay_item) && delay_item->valuedouble >= 0) ? (uint32_t)delay_item->valuedouble : 0;
        step.mask = 0xFF;
        step.bus = top_bus;

        if (cJSON_IsString(payload_item)) {
            // Hex string e.g. "01 02 03 04" or "01020304"
            const char* pstr = payload_item->valuestring;
            std::string clean = "";
            for (size_t i = 0; pstr[i]; i++) {
                if (isxdigit((unsigned char)pstr[i])) clean += pstr[i];
            }
            for (size_t i = 0; i < 8 && (i * 2 + 1) < clean.length(); i++) {
                std::string bhex = clean.substr(i * 2, 2);
                step.payload[i] = (uint8_t)strtoul(bhex.c_str(), nullptr, 16);
            }
        } else if (cJSON_IsObject(payload_item)) {
            for (int i = 0; i < 8; i++) {
                char k[4];
                snprintf(k, sizeof(k), "D%d", i + 1);
                cJSON *b = cJSON_GetObjectItem(payload_item, k);
                if (b && cJSON_IsString(b)) {
                    step.payload[i] = (uint8_t)strtoul(b->valuestring, nullptr, 0);
                } else if (b && cJSON_IsNumber(b) && std::isfinite(b->valuedouble)) {
                    double v = b->valuedouble;
                    if (v < 0.0) v = 0.0;
                    else if (v > 255.0) v = 255.0;
                    step.payload[i] = static_cast<uint8_t>(v);
                }
            }
        }

        PsramVector<ActionStep> steps = { step };
        if (queue_action_steps(cid, top_delay_ms, steps)) {
            cJSON_Delete(root);
            httpd_resp_set_type(req, "application/json");
            httpd_resp_sendstr(req, "{\"status\": \"queued\"}");
            return ESP_OK;
        }
    }

    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Entity/Command not found");
    return ESP_OK;
}

static const char* condition_op_to_str(ConditionOperator op) {
    switch (op) {
        case ConditionOperator::NOT_EQUAL:             return "!=";
        case ConditionOperator::LESS_THAN:             return "<";
        case ConditionOperator::LESS_THAN_OR_EQUAL:    return "<=";
        case ConditionOperator::GREATER_THAN:          return ">";
        case ConditionOperator::GREATER_THAN_OR_EQUAL: return ">=";
        case ConditionOperator::EQUAL:
        default:                                       return "==";
    }
}

static bool eval_byte_operator(uint8_t actual, uint8_t target, ConditionOperator op) {
    switch (op) {
        case ConditionOperator::NOT_EQUAL:             return actual != target;
        case ConditionOperator::LESS_THAN:             return actual < target;
        case ConditionOperator::LESS_THAN_OR_EQUAL:    return actual <= target;
        case ConditionOperator::GREATER_THAN:          return actual > target;
        case ConditionOperator::GREATER_THAN_OR_EQUAL: return actual >= target;
        case ConditionOperator::EQUAL:
        default:                                       return actual == target;
    }
}

static std::string format_failed_condition_msg(const AutomationCondition& cond) {
    char tmp[128];
    if (cond.logic == ConditionLogic::AND_GROUP) {
        return "Condition failed on AND group";
    } else if (cond.logic == ConditionLogic::OR_GROUP) {
        return "Condition failed on OR group";
    } else if (cond.logic == ConditionLogic::NOT_GROUP) {
        return "Condition failed on NOT group";
    } else if (cond.type == "time_condition") {
        snprintf(tmp, sizeof(tmp), "Condition failed on time window %02d:%02d-%02d:%02d",
                 cond.start_time_min / 60, cond.start_time_min % 60,
                 cond.end_time_min / 60, cond.end_time_min % 60);
    } else if (cond.type == "triggered_by") {
        snprintf(tmp, sizeof(tmp), "Condition failed on triggered_by '%s'", cond.trigger_id.c_str());
    } else if (cond.type == "device_state" || cond.type == "wifi_condition" || cond.type == "wifi") {
        snprintf(tmp, sizeof(tmp), "Condition failed on device/wifi property '%s'",
                 cond.device_property.empty() ? "unknown" : cond.device_property.c_str());
    } else if (cond.type == "ble_button" || cond.type == "ble" || cond.type == "bluetooth") {
        const std::string& btn = !cond.ble_button.empty() ? cond.ble_button : cond.target_string;
        snprintf(tmp, sizeof(tmp), "Condition failed on BLE button '%s'",
                 btn.empty() ? "any" : btn.c_str());
    } else if (cond.type == "ble_beacon" || cond.type == "beacon") {
        const std::string& id = !cond.beacon_uuid.empty() ? cond.beacon_uuid
                                : (!cond.ble_device.empty() ? cond.ble_device : cond.target_string);
        snprintf(tmp, sizeof(tmp), "Condition failed on BLE beacon '%s'",
                 id.empty() ? "any" : id.c_str());
    } else if (cond.type == "ble_device" || cond.type == "ble_presence") {
        const std::string& dev = !cond.ble_device.empty() ? cond.ble_device
                                 : (!cond.beacon_uuid.empty() ? cond.beacon_uuid : cond.target_string);
        snprintf(tmp, sizeof(tmp), "Condition failed on BLE device '%s'",
                 dev.empty() ? "any" : dev.c_str());
    } else if (cond.type == "voltage" || cond.type == "vbat") {
        snprintf(tmp, sizeof(tmp), "Condition failed on battery voltage (%s %.2fV)",
                 condition_op_to_str(cond.op), cond.target_float);
    } else {
        snprintf(tmp, sizeof(tmp), "Condition failed on CAN ID 0x%03lX", (unsigned long)cond.can_id);
    }
    return std::string(tmp);
}

static cJSON* serialize_condition_diag(const AutomationCondition& cond, bool *out_passed = nullptr, int depth = 0) {
    bool passed = evaluate_condition_readonly(cond);
    if (out_passed) *out_passed = passed;

    cJSON *c_obj = cJSON_CreateObject();
    if (!c_obj) return nullptr;

    if (cond.logic != ConditionLogic::LEAF) {
        const char* logic_str = (cond.logic == ConditionLogic::AND_GROUP) ? "AND"
                                : (cond.logic == ConditionLogic::OR_GROUP) ? "OR"
                                : "NOT";
        cJSON_AddStringToObject(c_obj, "type", logic_str);
        cJSON_AddStringToObject(c_obj, "logic", logic_str);
        cJSON_AddBoolToObject(c_obj, "passed", passed);
        cJSON *subs_arr = cJSON_CreateArray();
        if (depth < 8) {
            for (const auto& sub : cond.sub_conditions) {
                cJSON *sub_obj = serialize_condition_diag(sub, nullptr, depth + 1);
                if (sub_obj) cJSON_AddItemToArray(subs_arr, sub_obj);
            }
        }
        cJSON_AddItemToObject(c_obj, "conditions", subs_arr);
        return c_obj;
    }

    cJSON_AddStringToObject(c_obj, "type", cond.type.c_str());
    cJSON_AddBoolToObject(c_obj, "passed", passed);

    if (cond.type == "time_condition") {
        char t_window[32];
        snprintf(t_window, sizeof(t_window), "%02d:%02d-%02d:%02d",
                 cond.start_time_min / 60, cond.start_time_min % 60,
                 cond.end_time_min / 60, cond.end_time_min % 60);
        cJSON_AddStringToObject(c_obj, "time_window", t_window);
        cJSON_AddNumberToObject(c_obj, "weekdays_mask", cond.weekdays_mask);
    } else if (cond.type == "triggered_by") {
        cJSON_AddStringToObject(c_obj, "trigger_id", cond.trigger_id.c_str());
    } else if (cond.type == "device_state" || cond.type == "wifi_condition" || cond.type == "wifi") {
        cJSON_AddStringToObject(c_obj, "device_property", cond.device_property.c_str());
        if (!cond.target_string.empty()) {
            cJSON_AddStringToObject(c_obj, "target_string", cond.target_string.c_str());
        }
        cJSON_AddBoolToObject(c_obj, "target_bool", cond.target_bool);
        cJSON_AddStringToObject(c_obj, "op", condition_op_to_str(cond.op));
        if (cond.target_rssi != 0 ||
            cond.device_property == "wifi_rssi" ||
            cond.device_property == "wifi_station_rssi" ||
            cond.device_property == "sta_rssi" ||
            cond.device_property == "ap_client_rssi") {
            cJSON_AddNumberToObject(c_obj, "target_rssi", cond.target_rssi);
        }
    } else if (cond.type == "ble_button" || cond.type == "ble" || cond.type == "bluetooth") {
        const std::string& btn = !cond.ble_button.empty() ? cond.ble_button : cond.target_string;
        cJSON_AddStringToObject(c_obj, "ble_button", btn.c_str());
        cJSON_AddStringToObject(c_obj, "ble_action", cond.ble_action.c_str());
        if (!cond.ble_device.empty()) {
            cJSON_AddStringToObject(c_obj, "ble_device", cond.ble_device.c_str());
        }
    } else if (cond.type == "ble_beacon" || cond.type == "beacon" ||
               (cond.type == "ble_presence" && (!cond.beacon_uuid.empty() ||
                                                cond.device_property == "beacon_present" ||
                                                cond.device_property == "present" ||
                                                cond.device_property == "away"))) {
        const std::string& uuid = !cond.beacon_uuid.empty() ? cond.beacon_uuid
                                  : (!cond.ble_device.empty() ? cond.ble_device : cond.target_string);
        cJSON_AddStringToObject(c_obj, "beacon_uuid", uuid.c_str());
        if (!cond.device_property.empty()) {
            cJSON_AddStringToObject(c_obj, "device_property", cond.device_property.c_str());
        }
        cJSON_AddBoolToObject(c_obj, "target_bool", cond.target_bool);
        cJSON_AddNumberToObject(c_obj, "target_rssi", cond.target_rssi);
        cJSON_AddStringToObject(c_obj, "op", condition_op_to_str(cond.op));
    } else if (cond.type == "ble_device" || cond.type == "ble_presence") {
        const std::string& dev = !cond.ble_device.empty() ? cond.ble_device : cond.target_string;
        cJSON_AddStringToObject(c_obj, "ble_device", dev.c_str());
        if (!cond.device_property.empty()) {
            cJSON_AddStringToObject(c_obj, "device_property", cond.device_property.c_str());
        }
        cJSON_AddBoolToObject(c_obj, "target_bool", cond.target_bool);
        cJSON_AddNumberToObject(c_obj, "target_rssi", cond.target_rssi);
        cJSON_AddStringToObject(c_obj, "op", condition_op_to_str(cond.op));
    } else if (cond.type == "voltage" || cond.type == "vbat") {
        cJSON_AddStringToObject(c_obj, "op", condition_op_to_str(cond.op));
        cJSON_AddNumberToObject(c_obj, "target_voltage", cond.target_float);
        cJSON_AddNumberToObject(c_obj, "current_voltage", vbat_sensor_get_last());
    } else {
        char hex_id[16];
        snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)cond.can_id);
        cJSON_AddStringToObject(c_obj, "can_id", hex_id);
        cJSON_AddNumberToObject(c_obj, "bus", cond.bus);
        cJSON_AddNumberToObject(c_obj, "byte_index", cond.byte_index);
        if (cond.byte_index < 8) {
            char bname[8];
            snprintf(bname, sizeof(bname), "D%d", cond.byte_index + 1);
            cJSON_AddStringToObject(c_obj, "byte_name", bname);
        }

        char hex_mask[8];
        snprintf(hex_mask, sizeof(hex_mask), "0x%02X", cond.byte_mask);
        cJSON_AddStringToObject(c_obj, "byte_mask", hex_mask);

        cJSON_AddStringToObject(c_obj, "op", condition_op_to_str(cond.op));

        char hex_target[8];
        snprintf(hex_target, sizeof(hex_target), "0x%02X", cond.target_value);
        cJSON_AddStringToObject(c_obj, "target_val", hex_target);

        uint8_t cached_bytes[8] = {0};
        bool frame_seen = (cond.can_id != 0) && get_cached_can_frame(cond.can_id, cached_bytes, nullptr, cond.bus, !cond.has_bus);
        cJSON_AddBoolToObject(c_obj, "frame_seen", frame_seen);

        if (frame_seen && cond.byte_index < 8) {
            uint8_t cur_val = cached_bytes[cond.byte_index];
            char hex_byte[8];
            snprintf(hex_byte, sizeof(hex_byte), "0x%02X", cur_val);
            cJSON_AddStringToObject(c_obj, "current_byte", hex_byte);

            char hex_masked[8];
            snprintf(hex_masked, sizeof(hex_masked), "0x%02X", cur_val & cond.byte_mask);
            cJSON_AddStringToObject(c_obj, "current_masked", hex_masked);
        }
    }
    return c_obj;
}

static esp_err_t api_test_automation_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 16384, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *id_item = cJSON_GetObjectItem(root, "id");
    cJSON *mode_item = cJSON_GetObjectItem(root, "mode");
    cJSON *inline_actions_item = cJSON_GetObjectItem(root, "actions");
    const char* req_id = cJSON_IsString(id_item) ? id_item->valuestring : "";
    const char* mode = cJSON_IsString(mode_item) ? mode_item->valuestring : "dry_run";
    bool is_dry_run = (strcmp(mode, "dry_run") == 0);
    bool is_live_fire = (!is_dry_run && (strcmp(mode, "live_fire") == 0 || strcmp(mode, "run_actions") == 0));

    bool found = false;
    bool dry_passed = true;
    std::string debug_msg = "All conditions passed";
    std::string fired_name = req_id;
    PsramVector<ActionStep> inline_steps;
    bool has_inline_steps = false;

    if (is_live_fire && cJSON_IsArray(inline_actions_item) && cJSON_GetArraySize(inline_actions_item) > 0) {
        cJSON *a_sub = nullptr;
        cJSON_ArrayForEach(a_sub, inline_actions_item) {
            ActionStep step;
            if (parse_action_step(a_sub, step)) {
                inline_steps.push_back(std::move(step));
            }
        }
        has_inline_steps = !inline_steps.empty();
    }

    if (is_dry_run || is_live_fire) {
        PsramVector<ActionStep> matched_steps;
        std::shared_ptr<std::atomic<bool>> matched_running;
        PsramVector<AutomationCondition> dry_conditions;
        if (has_inline_steps) {
            found = true;
        }
        {
            std::lock_guard<std::mutex> lock(g_automations_mutex);
            for (const auto& rule : global_automations) {
                if (rule.id == req_id) {
                    found = true;
                    fired_name = rule.name.empty() ? rule.id : rule.name;
                    if (is_dry_run) {
                        dry_conditions = rule.conditions;
                    } else if (!has_inline_steps) {
                        // Bypass rule.enabled and rule.cooldown_ms for manual test execution
                        matched_steps = rule.actions;
                        matched_running = rule.is_running;
                    }
                    break;
                }
            }
        }

        if (is_dry_run && found) {
            for (const auto& cond : dry_conditions) {
                if (!evaluate_condition_readonly(cond)) {
                    dry_passed = false;
                    debug_msg = format_failed_condition_msg(cond);
                    break;
                }
            }
        }

        if (is_live_fire && found) {
            if (has_inline_steps) {
                queue_action_steps(0, 20, inline_steps, "manual_test");
            } else if (!matched_steps.empty()) {
                queue_action_steps(0, 20, matched_steps, "manual_test", matched_running);
            }
            if (req_id[0] != '\0') {
                broadcast_ws_automation_event(req_id, fired_name);
            }
        }
    }

    cJSON_Delete(root);
    if (found) {
        httpd_resp_set_type(req, "application/json");
        if (is_dry_run) {
            cJSON *resp_obj = cJSON_CreateObject();
            cJSON_AddStringToObject(resp_obj, "status", "ok");
            cJSON_AddBoolToObject(resp_obj, "passed", dry_passed);
            cJSON_AddStringToObject(resp_obj, "message", debug_msg.c_str());
            char *resp_str = cJSON_PrintUnformatted(resp_obj);
            cJSON_Delete(resp_obj);
            if (resp_str) {
                httpd_resp_sendstr(req, resp_str);
                free(resp_str);
            } else {
                httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
            }
        } else {
            httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Live fire actions queued\"}");
        }
        return ESP_OK;
    }

    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Automation rule not found");
    return ESP_OK;
}

static esp_err_t api_automations_diagnostics_handler(httpd_req_t *req) {
    set_cors_headers(req);

    struct DiagTriggerSnapshot {
        std::string type;
        uint32_t can_id = 0;
        uint8_t bus = 0;
        int byte_index = -1;
        uint8_t byte_mask = 0xFF;
        bool has_from_value = false;
        uint8_t from_value = 0;
        uint8_t to_value = 0;
        ConditionOperator op = ConditionOperator::EQUAL;
        uint16_t schedule_time_min = 0;
        uint8_t weekdays_mask = 0x7F;
        std::string beacon_uuid;
        std::string ble_event;
        int8_t target_rssi = 0;
    };

    struct DiagActionSnapshot {
        ActionType type = ActionType::TRANSMIT_FRAME;
        uint32_t can_id = 0;
        uint8_t repeat = 1;
        uint32_t delay_ms = 0;
        uint8_t payload[8] = {0};
        std::string popup_level;
        std::string popup_message;
        float target_temp_c = 21.0f;
        std::string zone;
        std::string entity_id;
        std::string command;
        std::string precon_mode;
        std::string precon_action;
        std::string cycle_direction;
        bool cycle_wrap = true;
        size_t cycle_state_count = 0;
        std::string nav_action;
        uint8_t nav_icon = 0;
        uint16_t nav_distance_meters = 0xFFFF;
    };

    struct DiagRuleSnapshot {
        std::string id;
        std::string name;
        bool enabled = true;
        bool ha_expose = true;
        std::string ha_icon;
        std::string exec_mode;
        std::string trigger_mode;
        uint32_t trigger_window_ms = 0;
        uint32_t cooldown_ms = 0;
        uint32_t last_exec_time_ms = 0;
        PsramVector<DiagTriggerSnapshot> triggers;
        PsramVector<AutomationCondition> conditions;
        PsramVector<DiagActionSnapshot> actions;
    };

    PsramVector<DiagRuleSnapshot> rules_snapshot;
    {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        rules_snapshot.reserve(global_automations.size());
        for (const auto& rule : global_automations) {
            DiagRuleSnapshot rs;
            rs.id = rule.id;
            rs.name = rule.name;
            rs.enabled = rule.enabled;
            rs.ha_expose = rule.ha_expose;
            rs.ha_icon = rule.ha_icon;
            rs.exec_mode = rule.exec_mode;
            rs.trigger_mode = rule.trigger_mode;
            rs.trigger_window_ms = rule.trigger_window_ms;
            rs.cooldown_ms = rule.cooldown_ms;
            rs.last_exec_time_ms = rule.last_exec_time_ms;

            rs.triggers.reserve(rule.triggers.size());
            for (const auto& trig : rule.triggers) {
                DiagTriggerSnapshot ts;
                ts.type = trig.type;
                ts.can_id = trig.can_id;
                ts.bus = trig.bus;
                ts.byte_index = trig.byte_index;
                ts.byte_mask = trig.byte_mask;
                ts.has_from_value = trig.has_from_value;
                ts.from_value = trig.from_value;
                ts.to_value = trig.to_value;
                ts.op = trig.op;
                ts.schedule_time_min = trig.schedule_time_min;
                ts.weekdays_mask = trig.weekdays_mask;
                ts.beacon_uuid = trig.beacon_uuid;
                ts.ble_event = trig.ble_event;
                ts.target_rssi = trig.target_rssi;
                rs.triggers.push_back(std::move(ts));
            }

            rs.conditions = rule.conditions;

            rs.actions.reserve(rule.actions.size());
            for (const auto& act : rule.actions) {
                DiagActionSnapshot as;
                as.type = act.type;
                as.can_id = act.can_id;
                as.repeat = act.repeat;
                as.delay_ms = act.delay_ms;
                memcpy(as.payload, act.payload, sizeof(as.payload));
                as.popup_level = act.popup_level;
                as.popup_message = act.popup_message;
                as.target_temp_c = act.target_temp_c;
                as.zone = act.zone;
                as.entity_id = act.entity_id;
                as.command = act.command;
                as.precon_mode = act.precon_mode;
                as.precon_action = act.precon_action;
                as.cycle_direction = act.cycle_direction;
                as.cycle_wrap = act.cycle_wrap;
                as.cycle_state_count = act.cycle_states.size();
                as.nav_action = act.nav_action;
                as.nav_icon = act.nav_icon;
                as.nav_distance_meters = act.nav_distance_meters;
                rs.actions.push_back(std::move(as));
            }

            rules_snapshot.push_back(std::move(rs));
        }
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"automations_enabled\":true,\"rules\":[]}");
        return ESP_OK;
    }
    cJSON_AddBoolToObject(root, "automations_enabled", g_automations_enabled.load());
    cJSON *rules_arr = cJSON_CreateArray();
    cJSON_AddItemToObject(root, "rules", rules_arr);

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    for (const auto& rule : rules_snapshot) {
        cJSON *rule_obj = cJSON_CreateObject();
        cJSON_AddStringToObject(rule_obj, "id", rule.id.c_str());
        cJSON_AddStringToObject(rule_obj, "name", rule.name.c_str());
        cJSON_AddBoolToObject(rule_obj, "enabled", rule.enabled);
        cJSON_AddBoolToObject(rule_obj, "ha_expose", rule.ha_expose);
        cJSON_AddStringToObject(rule_obj, "ha_icon", rule.ha_icon.c_str());
        cJSON_AddStringToObject(rule_obj, "exec_mode", rule.exec_mode.c_str());
        cJSON_AddStringToObject(rule_obj, "trigger_mode", rule.trigger_mode.c_str());
        cJSON_AddNumberToObject(rule_obj, "trigger_window_ms", rule.trigger_window_ms);
        cJSON_AddNumberToObject(rule_obj, "cooldown_ms", rule.cooldown_ms);
        cJSON_AddNumberToObject(rule_obj, "last_exec_ms", rule.last_exec_time_ms);
        if (rule.last_exec_time_ms > 0 && now_ms >= rule.last_exec_time_ms) {
            cJSON_AddNumberToObject(rule_obj, "last_exec_sec_ago", (now_ms - rule.last_exec_time_ms) / 1000);
        } else {
            cJSON_AddNumberToObject(rule_obj, "last_exec_sec_ago", -1);
        }

        // Triggers
        cJSON *trigs_arr = cJSON_CreateArray();
        cJSON_AddItemToObject(rule_obj, "triggers", trigs_arr);
        for (const auto& trig : rule.triggers) {
            cJSON *t_obj = cJSON_CreateObject();
            cJSON_AddStringToObject(t_obj, "type", trig.type.c_str());
            if (trig.can_id != 0) {
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)trig.can_id);
                cJSON_AddStringToObject(t_obj, "can_id", hex_id);
            }
            cJSON_AddNumberToObject(t_obj, "bus", trig.bus);
            cJSON_AddNumberToObject(t_obj, "byte_index", trig.byte_index);
            if (trig.byte_index >= 0 && trig.byte_index < 8) {
                char bname[8];
                snprintf(bname, sizeof(bname), "D%d", trig.byte_index + 1);
                cJSON_AddStringToObject(t_obj, "byte_name", bname);
            }

            char hex_mask[8];
            snprintf(hex_mask, sizeof(hex_mask), "0x%02X", trig.byte_mask);
            cJSON_AddStringToObject(t_obj, "byte_mask", hex_mask);

            if (trig.has_from_value) {
                char hex_from[8];
                snprintf(hex_from, sizeof(hex_from), "0x%02X", trig.from_value);
                cJSON_AddStringToObject(t_obj, "from_val", hex_from);
            }
            char hex_to[8];
            snprintf(hex_to, sizeof(hex_to), "0x%02X", trig.to_value);
            cJSON_AddStringToObject(t_obj, "to_val", hex_to);
            cJSON_AddStringToObject(t_obj, "op", condition_op_to_str(trig.op));

            if (trig.type == "time_schedule") {
                char sched_buf[16];
                snprintf(sched_buf, sizeof(sched_buf), "%02d:%02d", trig.schedule_time_min / 60, trig.schedule_time_min % 60);
                cJSON_AddStringToObject(t_obj, "schedule_time", sched_buf);
                cJSON_AddNumberToObject(t_obj, "weekdays_mask", trig.weekdays_mask);
            } else if (trig.type == "ble_beacon" || trig.type == "beacon") {
                cJSON_AddStringToObject(t_obj, "beacon_uuid", trig.beacon_uuid.c_str());
                cJSON_AddStringToObject(t_obj, "ble_event", trig.ble_event.c_str());
                cJSON_AddNumberToObject(t_obj, "target_rssi", trig.target_rssi);
            }

            // Live state from cache
            uint8_t cached_bytes[8] = {0};
            bool frame_seen = (trig.can_id != 0) && get_cached_can_frame(trig.can_id, cached_bytes, nullptr, trig.bus, false);
            cJSON_AddBoolToObject(t_obj, "frame_seen", frame_seen);
            if (frame_seen) {
                char hex_payload[17] = {0};
                for (int i = 0; i < 8; i++) snprintf(&hex_payload[i * 2], 3, "%02X", cached_bytes[i]);
                cJSON_AddStringToObject(t_obj, "current_payload", hex_payload);

                if (trig.byte_index >= 0 && trig.byte_index < 8) {
                    uint8_t cur_val = cached_bytes[trig.byte_index];
                    char hex_byte[8];
                    snprintf(hex_byte, sizeof(hex_byte), "0x%02X", cur_val);
                    cJSON_AddStringToObject(t_obj, "current_byte", hex_byte);

                    uint8_t masked_cur = cur_val & trig.byte_mask;
                    uint8_t masked_target = trig.to_value & trig.byte_mask;
                    cJSON_AddBoolToObject(t_obj, "matches_target",
                                          eval_byte_operator(masked_cur, masked_target, trig.op));
                }
            }
            cJSON_AddItemToArray(trigs_arr, t_obj);
        }

        // Conditions (read-only evaluation outside g_automations_mutex)
        cJSON *conds_arr = cJSON_CreateArray();
        cJSON_AddItemToObject(rule_obj, "conditions", conds_arr);
        bool all_conds_pass = true;

        for (const auto& cond : rule.conditions) {
            bool passed = false;
            cJSON *c_obj = serialize_condition_diag(cond, &passed);
            if (!passed) all_conds_pass = false;
            if (c_obj) {
                cJSON_AddItemToArray(conds_arr, c_obj);
            }
        }
        cJSON_AddBoolToObject(rule_obj, "all_conditions_passed", all_conds_pass);

        // Actions summary
        cJSON *acts_arr = cJSON_CreateArray();
        cJSON_AddItemToObject(rule_obj, "actions", acts_arr);
        for (const auto& act : rule.actions) {
            cJSON *a_obj = cJSON_CreateObject();
            if (act.type == ActionType::TRANSMIT_FRAME) {
                cJSON_AddStringToObject(a_obj, "type", "transmit");
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)act.can_id);
                cJSON_AddStringToObject(a_obj, "can_id", hex_id);
                cJSON_AddNumberToObject(a_obj, "repeat", act.repeat);
                cJSON_AddNumberToObject(a_obj, "delay_ms", act.delay_ms);
                char hex_payload[17] = {0};
                for (int i = 0; i < 8; i++) snprintf(&hex_payload[i * 2], 3, "%02X", act.payload[i]);
                cJSON_AddStringToObject(a_obj, "payload", hex_payload);
            } else if (act.type == ActionType::TRACK_POPUP) {
                cJSON_AddStringToObject(a_obj, "type", "track_popup");
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)act.can_id);
                cJSON_AddStringToObject(a_obj, "can_id", hex_id);
                cJSON_AddStringToObject(a_obj, "level", act.popup_level.c_str());
                cJSON_AddStringToObject(a_obj, "message", act.popup_message.c_str());
            } else if (act.type == ActionType::CLIMATE_TARGET) {
                cJSON_AddStringToObject(a_obj, "type", "climate_target");
                cJSON_AddNumberToObject(a_obj, "target_temp_c", act.target_temp_c);
                cJSON_AddStringToObject(a_obj, "zone", act.zone.c_str());
            } else if (act.type == ActionType::ENTITY_COMMAND) {
                cJSON_AddStringToObject(a_obj, "type", "entity_command");
                cJSON_AddStringToObject(a_obj, "entity_id", act.entity_id.c_str());
                cJSON_AddStringToObject(a_obj, "command", act.command.c_str());
            } else if (act.type == ActionType::DELAY) {
                cJSON_AddStringToObject(a_obj, "type", "delay");
                cJSON_AddNumberToObject(a_obj, "delay_ms", act.delay_ms);
            } else if (act.type == ActionType::PRECONDITION) {
                cJSON_AddStringToObject(a_obj, "type", "precondition");
                cJSON_AddStringToObject(a_obj, "mode", act.precon_mode.c_str());
                cJSON_AddStringToObject(a_obj, "action", act.precon_action.c_str());
            } else if (act.type == ActionType::CYCLE_ENTITY) {
                cJSON_AddStringToObject(a_obj, "type", "cycle_entity");
                cJSON_AddStringToObject(a_obj, "entity_id", act.entity_id.c_str());
                cJSON_AddStringToObject(a_obj, "direction", act.cycle_direction.c_str());
                cJSON_AddBoolToObject(a_obj, "wrap", act.cycle_wrap);
                cJSON_AddNumberToObject(a_obj, "state_count", (double)act.cycle_state_count);
            } else if (act.type == ActionType::HUD_NAV) {
                cJSON_AddStringToObject(a_obj, "type", "hud_nav");
                cJSON_AddStringToObject(a_obj, "action", act.nav_action.empty() ? "update" : act.nav_action.c_str());
                cJSON_AddNumberToObject(a_obj, "icon", act.nav_icon);
                cJSON_AddNumberToObject(a_obj, "distance_meters", act.nav_distance_meters);
            } else {
                cJSON_AddStringToObject(a_obj, "type", "other");
            }
            cJSON_AddItemToArray(acts_arr, a_obj);
        }

        cJSON_AddItemToArray(rules_arr, rule_obj);
    }

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    httpd_resp_set_type(req, "application/json");
    if (json_str) {
        httpd_resp_sendstr(req, json_str);
        free(json_str);
    } else {
        httpd_resp_sendstr(req, "{\"automations_enabled\":true,\"rules\":[]}");
    }
    return ESP_OK;
}

static void ensure_parent_dirs(const char *filepath) {
    char temp[256];
    strncpy(temp, filepath, sizeof(temp) - 1);
    temp[sizeof(temp) - 1] = '\0';
    char *slash = strrchr(temp, '/');
    if (!slash) return;
    *slash = '\0';
    for (char *p = temp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(temp, 0755);
            *p = '/';
        }
    }
    mkdir(temp, 0755);
}

static bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static bool validate_json_file_streaming(const char *filepath, bool allow_array) {
    FILE *f = fopen(filepath, "r");
    if (!f) return false;

    struct BufferedByteReader {
        FILE *fp;
        PsramBuf buf;
        size_t pos = 0;
        size_t len = 0;
        int pushed = -2;
        size_t bytes_since_yield = 0;

        explicit BufferedByteReader(FILE *f_in) : fp(f_in), buf(1024) {}

        int next() {
            if (pushed != -2) {
                int c = pushed;
                pushed = -2;
                return c;
            }
            if (pos >= len) {
                len = fread(buf.data(), 1, buf.size(), fp);
                pos = 0;
                if (len == 0) return EOF;
                bytes_since_yield += len;
                if (bytes_since_yield >= 16384) {
                    bytes_since_yield = 0;
                    vTaskDelay(pdMS_TO_TICKS(1));
                }
            }
            return static_cast<unsigned char>(buf.data()[pos++]);
        }

        void unget(int c) {
            pushed = c;
        }
    } reader(f);

    if (!reader.buf) {
        fclose(f);
        return false;
    }

    auto skip_ws = [&]() -> int {
        int c;
        while ((c = reader.next()) != EOF) {
            if (!is_json_ws(static_cast<char>(c))) return c;
        }
        return EOF;
    };

    auto read_string = [&]() -> bool {
        while (true) {
            int c = reader.next();
            if (c == EOF) return false;
            if (c == '"') return true;
            if (c == '\\') {
                int esc = reader.next();
                if (esc == '"' || esc == '\\' || esc == '/' || esc == 'b' ||
                    esc == 'f' || esc == 'n' || esc == 'r' || esc == 't') {
                    continue;
                }
                if (esc == 'u') {
                    for (int i = 0; i < 4; ++i) {
                        int h = reader.next();
                        if (h == EOF || !std::isxdigit(static_cast<unsigned char>(h))) return false;
                    }
                    continue;
                }
                return false;
            }
            if (static_cast<unsigned char>(c) < 0x20) return false;
        }
    };

    auto read_number = [&](int first) -> bool {
        int c = first;
        if (c == '-') c = reader.next();
        if (c == '0') {
            c = reader.next();
        } else if (c >= '1' && c <= '9') {
            while ((c = reader.next()) >= '0' && c <= '9') {}
        } else {
            return false;
        }
        if (c == '.') {
            c = reader.next();
            if (c < '0' || c > '9') return false;
            while ((c = reader.next()) >= '0' && c <= '9') {}
        }
        if (c == 'e' || c == 'E') {
            c = reader.next();
            if (c == '+' || c == '-') c = reader.next();
            if (c < '0' || c > '9') return false;
            while ((c = reader.next()) >= '0' && c <= '9') {}
        }
        if (c != EOF) reader.unget(c);
        return true;
    };

    auto read_literal = [&](const char *rest) -> bool {
        for (const char *p = rest; *p; ++p) {
            if (reader.next() != static_cast<unsigned char>(*p)) return false;
        }
        return true;
    };

    enum class JsonState {
        EXPECT_VALUE,
        OBJ_FIRST_KEY_OR_END,
        OBJ_KEY,
        OBJ_COLON,
        ARR_FIRST_VAL_OR_END,
        AFTER_VALUE
    };

    JsonState state = JsonState::EXPECT_VALUE;
    char stack[64];
    int depth = 0;
    bool root_seen = false;
    bool valid = false;

    while (true) {
        if (state == JsonState::EXPECT_VALUE) {
            int c = skip_ws();
            if (!root_seen) {
                root_seen = true;
                if (c != '{' && !(allow_array && c == '[')) break;
            }
            if (c == '{') {
                if (depth >= static_cast<int>(sizeof(stack))) break;
                stack[depth++] = '{';
                state = JsonState::OBJ_FIRST_KEY_OR_END;
            } else if (c == '[') {
                if (depth >= static_cast<int>(sizeof(stack))) break;
                stack[depth++] = '[';
                state = JsonState::ARR_FIRST_VAL_OR_END;
            } else if (c == '"') {
                if (!read_string()) break;
                state = JsonState::AFTER_VALUE;
            } else if (c == 't') {
                if (!read_literal("rue")) break;
                state = JsonState::AFTER_VALUE;
            } else if (c == 'f') {
                if (!read_literal("alse")) break;
                state = JsonState::AFTER_VALUE;
            } else if (c == 'n') {
                if (!read_literal("ull")) break;
                state = JsonState::AFTER_VALUE;
            } else if (c == '-' || (c >= '0' && c <= '9')) {
                if (!read_number(c)) break;
                state = JsonState::AFTER_VALUE;
            } else {
                break;
            }
        } else if (state == JsonState::OBJ_FIRST_KEY_OR_END) {
            int c = skip_ws();
            if (c == '}') {
                depth--;
                state = JsonState::AFTER_VALUE;
            } else if (c == '"') {
                if (!read_string()) break;
                state = JsonState::OBJ_COLON;
            } else {
                break;
            }
        } else if (state == JsonState::OBJ_KEY) {
            int c = skip_ws();
            if (c == '"') {
                if (!read_string()) break;
                state = JsonState::OBJ_COLON;
            } else {
                break;
            }
        } else if (state == JsonState::OBJ_COLON) {
            int c = skip_ws();
            if (c == ':') {
                state = JsonState::EXPECT_VALUE;
            } else {
                break;
            }
        } else if (state == JsonState::ARR_FIRST_VAL_OR_END) {
            int c = skip_ws();
            if (c == ']') {
                depth--;
                state = JsonState::AFTER_VALUE;
            } else if (c == EOF) {
                break;
            } else {
                reader.unget(c);
                state = JsonState::EXPECT_VALUE;
            }
        } else { // AFTER_VALUE
            int c = skip_ws();
            if (depth == 0) {
                valid = (c == EOF);
                break;
            }
            if (stack[depth - 1] == '{') {
                if (c == ',') {
                    state = JsonState::OBJ_KEY;
                } else if (c == '}') {
                    depth--;
                } else {
                    break;
                }
            } else {
                if (c == ',') {
                    state = JsonState::EXPECT_VALUE;
                } else if (c == ']') {
                    depth--;
                } else {
                    break;
                }
            }
        }
    }

    if (ferror(f) != 0) {
        valid = false;
    }
    fclose(f);
    return valid;
}

static bool validate_json_file(const char *filepath, bool allow_array) {
    struct stat st;
    if (stat(filepath, &st) != 0 || st.st_size <= 0) {
        return false;
    }

    // Use cJSON for small/medium files; stream-validate large files (e.g. 338KB catalog.json) without OOM
    static constexpr size_t kMaxCjsonValidateBytes = 65536;
    size_t file_size = static_cast<size_t>(st.st_size);
    if (file_size <= kMaxCjsonValidateBytes) {
        FILE *f = fopen(filepath, "r");
        if (!f) return false;
#if CONFIG_SPIRAM
        char *buf = static_cast<char *>(heap_caps_malloc_prefer(file_size + 1, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
#else
        char *buf = static_cast<char *>(malloc(file_size + 1));
#endif
        if (buf) {
            size_t nread = fread(buf, 1, file_size, f);
            bool read_err = (ferror(f) != 0);
            fclose(f);
            if (read_err || nread != file_size) {
                free(buf);
                return false;
            }
            buf[file_size] = '\0';
            const char *parse_end = nullptr;
            cJSON *root = cJSON_ParseWithOpts(buf, &parse_end, false);
            bool ok = false;
            if (root && (cJSON_IsObject(root) || (allow_array && cJSON_IsArray(root)))) {
                ok = true;
                if (parse_end) {
                    while (*parse_end != '\0') {
                        if (!is_json_ws(*parse_end)) {
                            ok = false;
                            break;
                        }
                        ++parse_end;
                    }
                }
            }
            if (root) cJSON_Delete(root);
            free(buf);
            return ok;
        }
        fclose(f);
    }

    return validate_json_file_streaming(filepath, allow_array);
}

static esp_err_t api_file_upload_handler(httpd_req_t *req) {
    set_cors_headers(req);
    char filepath[128];
    if (httpd_req_get_hdr_value_str(req, "X-File-Path", filepath, sizeof(filepath)) != ESP_OK) {
        return send_err_with_body_check(req, HTTPD_400_BAD_REQUEST, "Missing X-File-Path header", false);
    }

    if (strncmp(filepath, "/spiffs/", 8) != 0 || filepath[8] == '\0') {
        return send_err_with_body_check(req, HTTPD_400_BAD_REQUEST, "Invalid path: must start with /spiffs/", false);
    }

    if (strstr(filepath + 8, "..") != nullptr) {
        return send_err_with_body_check(req, HTTPD_400_BAD_REQUEST, "Invalid path: directory traversal rejected", false);
    }

    if (req->content_len == 0) {
        StaticTransferGuard transfer_guard;
        if (strcmp(filepath, "/spiffs/automations.json") == 0) {
            std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
            unlink(filepath);
        } else {
            unlink(filepath);
        }
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"File deleted/truncated.\"}");
        return ESP_OK;
    }

    size_t total_bytes = 0, used_bytes = 0;
    if (esp_littlefs_info("storage", &total_bytes, &used_bytes) == ESP_OK) {
        size_t free_bytes = (total_bytes > used_bytes) ? (total_bytes - used_bytes) : 0;
        if (req->content_len > free_bytes) {
            ESP_LOGE(TAG, "Upload rejected for %s: %zu bytes exceeds LittleFS free space (%zu bytes)",
                     filepath, req->content_len, free_bytes);
            return send_payload_too_large(req, "File exceeds available LittleFS free space");
        }
    }

    bool is_automations = (strcmp(filepath, "/spiffs/automations.json") == 0);
    bool is_preferences = (strcmp(filepath, "/spiffs/preferences.json") == 0);
    bool is_catalog = (strcmp(filepath, "/spiffs/catalog.json") == 0);

    char tmp_filepath[144];
    if (is_automations) {
        snprintf(tmp_filepath, sizeof(tmp_filepath), "/spiffs/automations.json.http.tmp");
    } else {
        int n = snprintf(tmp_filepath, sizeof(tmp_filepath), "%s.tmp", filepath);
        if (n <= 0 || static_cast<size_t>(n) >= sizeof(tmp_filepath)) {
            return send_err_with_body_check(req, HTTPD_400_BAD_REQUEST, "File path too long", false);
        }
    }

    StaticTransferGuard transfer_guard;
    ensure_parent_dirs(filepath);

    FILE *fd = fopen(tmp_filepath, "w");
    if (!fd) {
        return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to open temp file for write", false);
    }

    PsramBuf buf(1024);
    if (!buf) {
        fclose(fd);
        unlink(tmp_filepath);
        return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory", false);
    }
    size_t remaining = req->content_len;
    int timeout_retries = 0;
    while (remaining > 0) {
        size_t to_read = std::min(remaining, buf.size());
        int recv_len = httpd_req_recv(req, buf.data(), to_read);
        if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) {
            if (++timeout_retries > kMaxStreamTimeoutRetries) {
                fclose(fd);
                unlink(tmp_filepath);
                return send_err_with_body_check(req, HTTPD_408_REQ_TIMEOUT, "File receive timed out", false);
            }
            continue;
        }
        if (recv_len <= 0) {
            fclose(fd);
            unlink(tmp_filepath);
            return ESP_FAIL;
        }
        timeout_retries = 0;
        size_t chunk_len = static_cast<size_t>(recv_len);
        size_t written = fwrite(buf.data(), 1, chunk_len, fd);
        if (written != chunk_len) {
            fclose(fd);
            unlink(tmp_filepath);
            size_t t_bytes = 0, u_bytes = 0;
            esp_littlefs_info("storage", &t_bytes, &u_bytes);
            ESP_LOGE(TAG, "fwrite failed for %s: written %zu of %zu (disk full? LittleFS total: %zu, used: %zu, free: %zu)",
                     tmp_filepath, written, chunk_len, t_bytes, u_bytes,
                     (t_bytes > u_bytes ? t_bytes - u_bytes : 0));
            return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "File write failed (disk full?)", remaining == chunk_len);
        }
        remaining -= chunk_len;
    }

    bool flush_ok = (fflush(fd) == 0);
    bool close_ok = (fclose(fd) == 0);
    if (!flush_ok || !close_ok) {
        unlink(tmp_filepath);
        ESP_LOGE(TAG, "Failed to flush/close temp upload file %s", tmp_filepath);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed finalizing uploaded file");
        return ESP_OK;
    }

    if (is_automations || is_preferences || is_catalog) {
        bool allow_array = is_automations;
        if (!validate_json_file(tmp_filepath, allow_array)) {
            unlink(tmp_filepath);
            ESP_LOGE(TAG, "Rejected invalid JSON upload for %s", filepath);
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON payload");
            return ESP_OK;
        }
    }

    int rename_res = -1;
    if (is_automations) {
        std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
        rename_res = rename(tmp_filepath, filepath);
    } else {
        rename_res = rename(tmp_filepath, filepath);
    }
    if (rename_res != 0) {
        unlink(tmp_filepath);
        ESP_LOGE(TAG, "Failed to atomically rename %s -> %s", tmp_filepath, filepath);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed committing uploaded file");
        return ESP_OK;
    }

    if (is_preferences) {
        uds_engine_load_preferences();
        can_engine_load_preferences();
        timezone_mgr_load_from_fs();
        config_server_load_preferences();
        power_mgr_load_preferences();
    }

    char no_reboot_hdr[16] = {0};
    bool skip_reboot = (httpd_req_get_hdr_value_str(req, "X-No-Reboot", no_reboot_hdr, sizeof(no_reboot_hdr)) == ESP_OK && strcmp(no_reboot_hdr, "1") == 0);

    if (is_catalog && !skip_reboot) {
        return send_reboot_json_response(req, "{\"status\":\"success\",\"message\":\"Catalog saved. Rebooting...\"}");
    } else {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"File saved successfully.\"}");
    }
    return ESP_OK;
}

struct CloudOtaTaskArgs {
    std::string url;
};

struct OtaState {
    std::atomic<bool> in_progress{false};
    std::atomic<int> progress_pct{0};
    std::atomic<int> bytes_read{0};
    std::atomic<bool> success{false};
    std::mutex error_mutex;
    char error_msg[128] = {0};

    void set_error(const char *msg) {
        std::lock_guard<std::mutex> lock(error_mutex);
        if (msg) {
            snprintf(error_msg, sizeof(error_msg), "%s", msg);
        } else {
            error_msg[0] = '\0';
        }
    }

    void set_error_if_empty(const char *msg) {
        std::lock_guard<std::mutex> lock(error_mutex);
        if (error_msg[0] == '\0' && msg) {
            snprintf(error_msg, sizeof(error_msg), "%s", msg);
        }
    }

    std::string get_error() {
        std::lock_guard<std::mutex> lock(error_mutex);
        return std::string(error_msg);
    }
};
static OtaState g_ota_state;

bool api_is_ota_in_progress(void) {
    return g_ota_state.in_progress.load();
}

static esp_err_t api_ota_handler(httpd_req_t *req) {
    set_cors_headers(req);
    if (g_ota_state.in_progress.exchange(true)) {
        httpd_resp_set_status(req, "409 Conflict");
        httpd_resp_set_type(req, "application/json");
        if (req->content_len > 0) {
            httpd_resp_set_hdr(req, "Connection", "close");
        }
        httpd_resp_sendstr(req, "{\"status\":\"error\",\"message\":\"OTA already in progress\"}");
        return (req->content_len > 0) ? ESP_FAIL : ESP_OK;
    }

    struct OtaInProgressGuard {
        ~OtaInProgressGuard() { g_ota_state.in_progress.store(false); }
    } ota_guard;

    g_ota_state.progress_pct = 0;
    g_ota_state.bytes_read = 0;
    g_ota_state.success = false;
    g_ota_state.set_error("");

    if (req->content_len == 0) {
        g_ota_state.set_error("Empty OTA payload");
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty OTA payload");
        return ESP_OK;
    }

    rtc_crash_record_event("ota_start");
    esp_ota_handle_t update_handle = 0;
    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(nullptr);
    if (!update_partition) {
        g_ota_state.set_error("No OTA partition found");
        return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "No OTA partition found", false);
    }

    if (req->content_len > update_partition->size) {
        ESP_LOGE(TAG, "OTA image too large: %zu bytes > partition size %lu bytes",
                 req->content_len, (unsigned long)update_partition->size);
        g_ota_state.set_error("Firmware image exceeds OTA partition size");
        return send_payload_too_large(req, "Firmware image exceeds OTA partition size");
    }

    {
        StaticTransferGuard transfer_guard;

        esp_err_t err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &update_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_begin failed: %s", esp_err_to_name(err));
            g_ota_state.set_error("OTA begin failed");
            return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OTA begin failed", false);
        }

        const size_t kChunkSize = 4096;
        PsramBuf buf(kChunkSize);
        if (!buf) {
            esp_ota_abort(update_handle);
            g_ota_state.set_error("Out of memory for OTA buffer");
            return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory for OTA buffer", false);
        }

        const size_t total_len = req->content_len;
        size_t written_total = 0;
        size_t remaining = req->content_len;
        int timeout_retries = 0;
        while (remaining > 0) {
            size_t to_read = std::min(remaining, kChunkSize);
            int recv_len = httpd_req_recv(req, buf.data(), to_read);
            if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) {
                if (++timeout_retries > kMaxOtaTimeoutRetries) {
                    esp_ota_abort(update_handle);
                    g_ota_state.set_error("OTA socket receive timed out");
                    ESP_LOGE(TAG, "OTA socket receive timed out (remaining=%zu)", remaining);
                    return send_err_with_body_check(req, HTTPD_408_REQ_TIMEOUT, "OTA receive timed out", false);
                }
                continue;
            }
            if (recv_len <= 0) {
                esp_ota_abort(update_handle);
                g_ota_state.set_error("OTA socket receive failed");
                ESP_LOGE(TAG, "OTA socket receive failed (remaining=%zu)", remaining);
                return ESP_FAIL;
            }
            timeout_retries = 0;
            size_t chunk_len = static_cast<size_t>(recv_len);
            err = esp_ota_write(update_handle, buf.data(), chunk_len);
            if (err != ESP_OK) {
                esp_ota_abort(update_handle);
                g_ota_state.set_error("OTA write failed");
                ESP_LOGE(TAG, "esp_ota_write failed: %s", esp_err_to_name(err));
                return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OTA write failed", remaining == chunk_len);
            }
            remaining -= chunk_len;
            written_total += chunk_len;
            g_ota_state.bytes_read = static_cast<int>(written_total);
            if (total_len > 0) {
                g_ota_state.progress_pct = static_cast<int>((static_cast<uint64_t>(written_total) * 100ULL) / total_len);
            }
        }

        if (esp_ota_end(update_handle) == ESP_OK && esp_ota_set_boot_partition(update_partition) == ESP_OK) {
            g_ota_state.progress_pct = 100;
            g_ota_state.success = true;
            return send_reboot_json_response(req, "{\"status\":\"success\",\"message\":\"Firmware flashed. Rebooting...\"}");
        }
    }

    g_ota_state.set_error("OTA flash failed");
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OTA flash failed");
    return ESP_OK;
}

static void run_cloud_ota(const std::string &download_url) {
    g_ota_state.in_progress = true;
    g_ota_state.progress_pct = 0;
    g_ota_state.bytes_read = 0;
    g_ota_state.success = false;
    g_ota_state.set_error("");
    rtc_crash_record_event("cloud_ota_start");

    ESP_LOGI(TAG, "Starting Direct Cloud OTA Pull from: %s", download_url.c_str());
    broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] Connecting to Cloud Release Asset...\"}");

    esp_http_client_config_t config = {};
    config.url = download_url.c_str();
    config.cert_pem = nullptr; // Skip verification for github redirect assets
    config.skip_cert_common_name_check = true;
    config.crt_bundle_attach = esp_crt_bundle_attach;
    config.timeout_ms = 30000;
    config.buffer_size = 4096;
    config.buffer_size_tx = 2048;
    config.max_redirection_count = 10;
    config.keep_alive_enable = true;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        ESP_LOGE(TAG, "Failed to initialize HTTP client for Cloud OTA");
        g_ota_state.set_error("Failed to initialize HTTP client");
        g_ota_state.in_progress = false;
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] Failed to initialize HTTP client\"}");
        return;
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open HTTP connection: %s", esp_err_to_name(err));
        char err_buf[128];
        snprintf(err_buf, sizeof(err_buf), "Connection failed: %s", esp_err_to_name(err));
        g_ota_state.set_error(err_buf);
        g_ota_state.in_progress = false;
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] Connection to download URL failed\"}");
        esp_http_client_cleanup(client);
        return;
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    int status_code = esp_http_client_get_status_code(client);
    ESP_LOGI(TAG, "Cloud OTA HTTP Status: %d, Content-Length: %lld", status_code, (long long)content_length);

    // Follow redirect chain (GitHub releases redirect to S3/Azure Blob with long query parameters)
    int redirect_hops = 0;
    while ((status_code == 301 || status_code == 302 || status_code == 307 || status_code == 308) && redirect_hops < 5) {
        redirect_hops++;
        esp_err_t r_err = esp_http_client_set_redirection(client);
        if (r_err != ESP_OK) {
            ESP_LOGE(TAG, "esp_http_client_set_redirection failed: %s", esp_err_to_name(r_err));
            break;
        }
        esp_http_client_close(client);
        err = esp_http_client_open(client, 0);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to re-open redirected connection: %s", esp_err_to_name(err));
            break;
        }
        content_length = esp_http_client_fetch_headers(client);
        status_code = esp_http_client_get_status_code(client);
        ESP_LOGI(TAG, "Followed Redirect #%d -> Status: %d, Content-Length: %lld", redirect_hops, status_code, (long long)content_length);
    }

    if (status_code != 200) {
        ESP_LOGE(TAG, "Unexpected HTTP status: %d", status_code);
        char err_buf[128];
        snprintf(err_buf, sizeof(err_buf), "HTTP error %d from server", status_code);
        g_ota_state.set_error(err_buf);
        g_ota_state.in_progress = false;
        char err_msg[64];
        snprintf(err_msg, sizeof(err_msg), "{\"type\":\"log\",\"msg\":\"[OTA] [E] HTTP Error %d from cloud\"}", status_code);
        broadcast_ws_raw(err_msg);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return;
    }

    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(nullptr);
    if (!update_partition) {
        ESP_LOGE(TAG, "No OTA partition found");
        g_ota_state.set_error("No OTA partition found");
        g_ota_state.in_progress = false;
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] No active OTA partition available\"}");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return;
    }

    broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] Streaming binary directly into flash partition...\"}");

    int binary_file_length = 0;
    bool flash_succeeded = false;
    {
        // Pause WebSocket broadcasts while erasing/writing flash during Cloud OTA
        StaticTransferGuard transfer_guard;

        esp_ota_handle_t update_handle = 0;
        err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &update_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_begin failed (%s)", esp_err_to_name(err));
            char err_buf[128];
            snprintf(err_buf, sizeof(err_buf), "OTA begin failed: %s", esp_err_to_name(err));
            g_ota_state.set_error(err_buf);
            g_ota_state.in_progress = false;
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
        } else {
            PsramBuf upgrade_data_buf(2048);
            if (!upgrade_data_buf) {
                esp_ota_abort(update_handle);
                g_ota_state.set_error("Out of memory");
                g_ota_state.in_progress = false;
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
            } else {
                int data_read = 0;

                while (true) {
                    data_read = esp_http_client_read(client, upgrade_data_buf.data(), upgrade_data_buf.size());
                    if (data_read < 0) {
                        ESP_LOGE(TAG, "Error: SSL/HTTP data read error");
                        g_ota_state.set_error("Read error during binary download");
                        err = ESP_FAIL;
                        break;
                    } else if (data_read > 0) {
                        err = esp_ota_write(update_handle, (const void *)upgrade_data_buf.data(), data_read);
                        if (err != ESP_OK) {
                            ESP_LOGE(TAG, "esp_ota_write failed (%s)", esp_err_to_name(err));
                            char err_buf[128];
                            snprintf(err_buf, sizeof(err_buf), "Flash write error: %s", esp_err_to_name(err));
                            g_ota_state.set_error(err_buf);
                            break;
                        }
                        binary_file_length += data_read;
                        g_ota_state.bytes_read = binary_file_length;
                        if (content_length > 0) {
                            int pct = static_cast<int>((static_cast<int64_t>(binary_file_length) * 100LL) / content_length);
                            if (pct > 100) pct = 100;
                            g_ota_state.progress_pct = pct;
                        }
                    } else if (data_read == 0) {
                        // End of stream
                        break;
                    }
                }

                esp_http_client_close(client);
                esp_http_client_cleanup(client);

                bool ota_ended = false;
                if (err == ESP_OK && binary_file_length > 100000) {
                    ota_ended = true;
                    err = esp_ota_end(update_handle);
                    if (err == ESP_OK) {
                        err = esp_ota_set_boot_partition(update_partition);
                        if (err == ESP_OK) {
                            flash_succeeded = true;
                        }
                    }
                }

                if (!flash_succeeded && !ota_ended) {
                    esp_ota_abort(update_handle);
                }
            }
        }
    }

    if (flash_succeeded) {
        ESP_LOGI(TAG, "Direct Cloud OTA Succeeded! Total bytes: %d. Rebooting...", binary_file_length);
        g_ota_state.progress_pct = 100;
        g_ota_state.success = true;
        g_ota_state.in_progress = false;
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] Cloud flash 100% complete! Rebooting device in 2s...\"}");
        power_mgr_schedule_restart(1500);
        return;
    }

    ESP_LOGE(TAG, "Direct Cloud OTA Failed or incomplete");
    char err_buf[128];
    snprintf(err_buf, sizeof(err_buf), "OTA incomplete or corrupted (bytes: %d)", binary_file_length);
    g_ota_state.set_error_if_empty(err_buf);
    g_ota_state.in_progress = false;
    broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] Cloud OTA update failed to complete\"}");
}

static void cloud_ota_task(void *pvParameter) {
    CloudOtaTaskArgs *args = static_cast<CloudOtaTaskArgs*>(pvParameter);
    std::string download_url = args->url;
    delete args;

    run_cloud_ota(download_url);
    download_url.clear();
    download_url.shrink_to_fit();
    vTaskDelete(nullptr);
}

static esp_err_t api_ota_cloud_pull_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 1024, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *url_item = cJSON_GetObjectItem(root, "url");
    if (!url_item || !cJSON_IsString(url_item)) {
        cJSON_Delete(root);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing 'url' field");
        return ESP_OK;
    }

    std::string ota_url = url_item->valuestring;
    cJSON_Delete(root);

    const bool valid_scheme =
        (ota_url.rfind("https://", 0) == 0 && ota_url.size() > 8) ||
        (ota_url.rfind("http://", 0) == 0 && ota_url.size() > 7);
    if (!valid_scheme) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid 'url': must start with https:// or http://");
        return ESP_OK;
    }

    if (g_ota_state.in_progress.exchange(true)) {
        httpd_resp_set_status(req, "409 Conflict");
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"error\",\"message\":\"OTA already in progress\"}");
        return ESP_OK;
    }

    g_ota_state.progress_pct = 0;
    g_ota_state.bytes_read = 0;
    g_ota_state.success = false;
    g_ota_state.set_error("");

    CloudOtaTaskArgs *args = new (std::nothrow) CloudOtaTaskArgs{ota_url};
    if (!args) {
        ESP_LOGE(TAG, "Failed to allocate CloudOtaTaskArgs (internal_free_heap=%zu)",
                 heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        g_ota_state.set_error("Failed to spawn cloud OTA task");
        g_ota_state.in_progress.store(false);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to spawn cloud OTA task");
        return ESP_OK;
    }
    if (xTaskCreate(cloud_ota_task, "cloud_ota_task", 10240, args, 5, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "Failed to create cloud_ota_task (internal_free_heap=%zu)",
                 heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        delete args;
        g_ota_state.set_error("Failed to spawn cloud OTA task");
        g_ota_state.in_progress.store(false);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to spawn cloud OTA task");
        return ESP_OK;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"started\",\"message\":\"Cloud OTA download initiated on device\"}");
    return ESP_OK;
}

static esp_err_t api_ota_status_handler(httpd_req_t *req) {
    set_cors_headers(req);
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "in_progress", g_ota_state.in_progress.load());
    cJSON_AddNumberToObject(root, "progress", g_ota_state.progress_pct.load());
    cJSON_AddNumberToObject(root, "bytes", g_ota_state.bytes_read.load());
    cJSON_AddBoolToObject(root, "success", g_ota_state.success.load());
    std::string err_copy = g_ota_state.get_error();
    cJSON_AddStringToObject(root, "error", err_copy.c_str());

    return send_cjson_response(req, root);
}

static esp_err_t api_get_automations_handler(httpd_req_t *req) {
    set_cors_headers(req);
    const char *filepath = "/spiffs/automations.json";
    FILE *fd = fopen(filepath, "r");
    if (!fd) {
        httpd_resp_set_type(req, "application/json");
        const esp_app_desc_t *app_desc = esp_app_get_description();
        const char* fw_ver = (app_desc && app_desc->version[0] != '\0') ? app_desc->version : "unknown";
        char def_resp[256];
        snprintf(def_resp, sizeof(def_resp), "{\"settings\":{\"vehicle_model\":\"all_egmp\",\"unit_system\":\"imperial\",\"can_do_version\":\"%s\"},\"rules\":[]}", fw_ver);
        httpd_resp_sendstr(req, def_resp);
        return ESP_OK;
    }

    httpd_resp_set_type(req, "application/json");

    PsramBuf chunk(1024);
    if (!chunk) {
        fclose(fd);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        return ESP_OK;
    }
    size_t chunksize;
    do {
        chunksize = fread(chunk.data(), 1, chunk.size(), fd);
        if (chunksize > 0) {
            if (httpd_resp_send_chunk(req, chunk.data(), chunksize) != ESP_OK) {
                fclose(fd);
                return ESP_FAIL;
            }
        }
    } while (chunksize != 0);

    fclose(fd);
    httpd_resp_send_chunk(req, nullptr, 0);
    return ESP_OK;
}

static esp_err_t api_post_automations_handler(httpd_req_t *req) {
    set_cors_headers(req);
    if (req->content_len == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty payload");
        return ESP_OK;
    }
    if (req->content_len > kMaxAutomationsBytes) {
        return send_payload_too_large(req, "Automations payload exceeds 128KB limit");
    }

    const char *temp_filepath = "/spiffs/automations.json.http.tmp";
    const char *target_filepath = "/spiffs/automations.json";

    StaticTransferGuard transfer_guard;

    FILE *fd = fopen(temp_filepath, "w");
    if (!fd) {
        return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to open automations temp file for write", false);
    }

    PsramBuf buf(1024);
    if (!buf) {
        fclose(fd);
        remove(temp_filepath);
        return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory", false);
    }
    size_t remaining = req->content_len;
    int timeout_retries = 0;
    while (remaining > 0) {
        size_t to_read = std::min(remaining, buf.size());
        int recv_len = httpd_req_recv(req, buf.data(), to_read);
        if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) {
            if (++timeout_retries > kMaxStreamTimeoutRetries) {
                fclose(fd);
                remove(temp_filepath);
                return send_err_with_body_check(req, HTTPD_408_REQ_TIMEOUT, "Timed out receiving automation payload", false);
            }
            continue;
        }
        if (recv_len <= 0) {
            fclose(fd);
            remove(temp_filepath);
            return ESP_FAIL;
        }
        timeout_retries = 0;
        size_t chunk_len = static_cast<size_t>(recv_len);
        size_t written = fwrite(buf.data(), 1, chunk_len, fd);
        if (written != chunk_len) {
            fclose(fd);
            remove(temp_filepath);
            ESP_LOGE(TAG, "fwrite failed for %s: written %zu of %zu", temp_filepath, written, chunk_len);
            return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed writing automation payload", remaining == chunk_len);
        }
        remaining -= chunk_len;
    }

    bool flush_ok = (fflush(fd) == 0);
    bool close_ok = (fclose(fd) == 0);
    if (!flush_ok || !close_ok) {
        remove(temp_filepath);
        ESP_LOGE(TAG, "Failed to flush/close temp automations file");
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed finalizing automations file");
        return ESP_OK;
    }

    if (!validate_json_file(temp_filepath, true)) {
        remove(temp_filepath);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid automations JSON");
        return ESP_OK;
    }

    bool load_ok = false;
    bool commit_ok = false;
    {
        std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
        load_ok = load_automations_from_fs(temp_filepath);
        if (load_ok) {
            commit_ok = (rename(temp_filepath, target_filepath) == 0);
            if (!commit_ok) {
                remove(temp_filepath);
            }
        } else {
            remove(temp_filepath);
        }
    }

    if (!load_ok) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid automations JSON");
        return ESP_OK;
    }

    if (!commit_ok) {
        ESP_LOGE(TAG, "Failed to atomically rename temp automations file");
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed committing automations file");
        return ESP_OK;
    }

    mqtt_mgr_on_automations_reloaded();
    ESP_LOGI(TAG, "New automations.json written (%zu bytes) and hot-reloaded.", req->content_len);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"success\",\"hot_reloaded\":true,\"message\":\"Automations saved and hot-reloaded.\"}");
    return ESP_OK;
}

static esp_err_t api_get_preferences_handler(httpd_req_t *req) {
    set_cors_headers(req);
    const char *filepath = "/spiffs/preferences.json";
    FILE *fd = fopen(filepath, "r");
    if (!fd) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{}");
        return ESP_OK;
    }

    httpd_resp_set_type(req, "application/json");
    PsramBuf chunk(1024);
    if (!chunk) {
        fclose(fd);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        return ESP_OK;
    }
    size_t chunksize;
    do {
        chunksize = fread(chunk.data(), 1, chunk.size(), fd);
        if (chunksize > 0) {
            if (httpd_resp_send_chunk(req, chunk.data(), chunksize) != ESP_OK) {
                fclose(fd);
                return ESP_FAIL;
            }
        }
    } while (chunksize != 0);

    fclose(fd);
    httpd_resp_send_chunk(req, nullptr, 0);
    return ESP_OK;
}

static esp_err_t api_post_preferences_handler(httpd_req_t *req) {
    set_cors_headers(req);
    if (req->content_len == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty payload");
        return ESP_OK;
    }
    if (req->content_len > kMaxPreferencesBytes) {
        return send_payload_too_large(req, "Preferences payload exceeds 8KB limit");
    }

    std::string incoming_body;
    incoming_body.reserve(req->content_len);
    PsramBuf buf(1024);
    if (!buf) {
        return send_err_with_body_check(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory", false);
    }
    size_t remaining = req->content_len;
    int timeout_retries = 0;
    while (remaining > 0) {
        size_t to_read = std::min(remaining, buf.size());
        int recv_len = httpd_req_recv(req, buf.data(), to_read);
        if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) {
            if (++timeout_retries > kMaxStreamTimeoutRetries) {
                return send_err_with_body_check(req, HTTPD_408_REQ_TIMEOUT, "Timed out receiving preferences payload", false);
            }
            continue;
        }
        if (recv_len <= 0) {
            return ESP_FAIL;
        }
        timeout_retries = 0;
        size_t chunk_len = static_cast<size_t>(recv_len);
        incoming_body.append(buf.data(), chunk_len);
        remaining -= chunk_len;
    }

    const char *parse_end = nullptr;
    cJSON *incoming = cJSON_ParseWithOpts(incoming_body.c_str(), &parse_end, false);
    bool valid_incoming = (incoming != nullptr && cJSON_IsObject(incoming));
    if (valid_incoming && parse_end) {
        while (*parse_end != '\0') {
            if (!is_json_ws(*parse_end)) {
                valid_incoming = false;
                break;
            }
            ++parse_end;
        }
    }
    if (!valid_incoming) {
        if (incoming) cJSON_Delete(incoming);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid preferences JSON object");
        return ESP_OK;
    }

    const char *temp_filepath = "/spiffs/preferences.json.tmp";
    const char *target_filepath = "/spiffs/preferences.json";

    StaticTransferGuard transfer_guard;

    // Merge incoming keys into existing preferences object so firmware-only keys (e.g. uds_enabled) are preserved
    cJSON *merged = nullptr;
    FILE *existing_fd = fopen(target_filepath, "r");
    if (existing_fd) {
        fseek(existing_fd, 0, SEEK_END);
        long existing_sz = ftell(existing_fd);
        fseek(existing_fd, 0, SEEK_SET);
        if (existing_sz > 0 && static_cast<size_t>(existing_sz) <= kMaxPreferencesBytes) {
            std::string existing_str(static_cast<size_t>(existing_sz), '\0');
            size_t nread = fread(&existing_str[0], 1, static_cast<size_t>(existing_sz), existing_fd);
            existing_str.resize(nread);
            cJSON *parsed_existing = cJSON_Parse(existing_str.c_str());
            if (parsed_existing && cJSON_IsObject(parsed_existing)) {
                merged = parsed_existing;
            } else if (parsed_existing) {
                cJSON_Delete(parsed_existing);
            }
        }
        fclose(existing_fd);
    }
    if (!merged) {
        merged = cJSON_CreateObject();
    }
    if (!merged) {
        cJSON_Delete(incoming);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        return ESP_OK;
    }

    cJSON *child = incoming->child;
    while (child) {
        cJSON *next = child->next;
        if (child->string) {
            std::string key(child->string);
            cJSON *detached = cJSON_DetachItemViaPointer(incoming, child);
            if (detached) {
                if (cJSON_GetObjectItemCaseSensitive(merged, key.c_str()) != nullptr) {
                    if (!cJSON_ReplaceItemInObjectCaseSensitive(merged, key.c_str(), detached)) {
                        cJSON_Delete(detached);
                    }
                } else {
                    cJSON_AddItemToObject(merged, key.c_str(), detached);
                }
            }
        }
        child = next;
    }
    cJSON_Delete(incoming);

    char *rendered = cJSON_PrintUnformatted(merged);
    cJSON_Delete(merged);
    if (!rendered) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed serializing preferences JSON");
        return ESP_OK;
    }

    size_t rendered_len = strlen(rendered);
    FILE *fd = fopen(temp_filepath, "w");
    if (!fd) {
        free(rendered);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to open preferences temp file for write");
        return ESP_OK;
    }

    size_t written = fwrite(rendered, 1, rendered_len, fd);
    free(rendered);
    bool write_ok = (written == rendered_len);
    bool flush_ok = write_ok && (fflush(fd) == 0);
    bool close_ok = (fclose(fd) == 0);
    if (!write_ok || !flush_ok || !close_ok) {
        remove(temp_filepath);
        ESP_LOGE(TAG, "Failed writing/finalizing temp preferences file");
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed writing preferences file");
        return ESP_OK;
    }

    if (rename(temp_filepath, target_filepath) != 0) {
        remove(temp_filepath);
        ESP_LOGE(TAG, "Failed to atomically rename temp preferences file");
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed committing preferences file");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "User preferences merged and saved to device (%zu bytes)", rendered_len);
    uds_engine_load_preferences();
    can_engine_load_preferences();
    timezone_mgr_load_from_fs();
    config_server_load_preferences();
    power_mgr_load_preferences();
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Preferences saved to device.\"}");
    return ESP_OK;
}

static esp_err_t api_system_status_handler(httpd_req_t *req) {
    set_cors_headers(req);
    cJSON *root = cJSON_CreateObject();
#if CONFIG_IDF_TARGET_ESP32S3
    bool bus0_ok = dual_can_is_available(CAN_BUS_0);
    bool bus1_ok = dual_can_is_available(CAN_BUS_1);
    bool any_dual_can = bus0_ok || bus1_ok;
    cJSON_AddStringToObject(root, "device", "WiCAN ESP32-S3 (Dual CAN FD)");
    cJSON_AddStringToObject(root, "target", "esp32s3");
    cJSON_AddBoolToObject(root, "dual_can", any_dual_can);
#else
    cJSON_AddStringToObject(root, "device", "WiCAN ESP32-C3");
    cJSON_AddStringToObject(root, "target", "esp32c3");
    cJSON_AddBoolToObject(root, "dual_can", false);
#endif
    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddBoolToObject(root, "automations_enabled", g_automations_enabled.load());
    cJSON_AddBoolToObject(root, "sniffer_mode", g_sniffer_mode.load());
    cJSON_AddBoolToObject(root, "hardware_listen_only", g_hardware_listen_only.load());
    cJSON_AddBoolToObject(root, "mitm_bridge_enabled", g_mitm_bridge_enabled.load());
    cJSON_AddNumberToObject(root, "gvret_clients", gvret_get_client_count());
    const esp_app_desc_t *app_desc = esp_app_get_description();
    const char* fw_ver = (app_desc && app_desc->version[0] != '\0') ? app_desc->version : "unknown";
    cJSON_AddStringToObject(root, "can_do_version", fw_ver);

    const char* tier_str = "active";
    switch (power_mgr_get_tier()) {
        case POWER_TIER_STANDBY: tier_str = "standby"; break;
        case POWER_TIER_DEEP_SLEEP: tier_str = "deep_sleep"; break;
        default: break;
    }
    cJSON_AddStringToObject(root, "power_tier", tier_str);
    cJSON_AddNumberToObject(root, "low_vbat_cutoff_volts", static_cast<double>(power_mgr_get_low_vbat_cutoff()));

    // Free heap and uptime
    cJSON_AddNumberToObject(root, "free_heap", esp_get_free_heap_size());
    cJSON_AddNumberToObject(root, "min_free_heap", esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(root, "internal_free_heap",
                            (double)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    cJSON_AddNumberToObject(root, "uptime_sec", (uint32_t)(esp_timer_get_time() / 1000000ULL));

    // Device system time & NTP synchronization status
    time_t now = time(nullptr);
    bool time_synced = (sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED) || (now >= 1704067200);
    cJSON_AddBoolToObject(root, "time_synced", time_synced);
    cJSON_AddNumberToObject(root, "epoch_time", (double)now);
    cJSON_AddStringToObject(root, "ntp_server", "pool.ntp.org");
    cJSON_AddStringToObject(root, "timezone", timezone_mgr_get_id());

    char time_str[64] = "Unsynchronized";
    if (time_synced) {
        timezone_mgr_format_local(now, time_str, sizeof(time_str));
    }
    cJSON_AddStringToObject(root, "system_time", time_str);

#if CONFIG_IDF_TARGET_ESP32S3
    uint32_t max_tec = 0, max_rec = 0, total_tx_fail = 0, total_rx_ovf = 0;
    bool any_bus_off = false;
    auto add_mcp_bus = [&](const char* key, can_bus_t bus, bool is_fd) {
        mcp2518fd_status_snapshot_t snap = {};
        dual_can_get_status_snapshot(bus, &snap);
        bool online = snap.initialized;
        uint8_t tec = snap.tec;
        uint8_t rec = snap.rec;
        bool bo = snap.bus_off;
        if (online) {
            if (tec > max_tec) max_tec = tec;
            if (rec > max_rec) max_rec = rec;
            if (bo) any_bus_off = true;
            total_tx_fail += snap.tx_fail_count;
            total_rx_ovf += snap.rx_overflow_count;
        }
        cJSON *bobj = cJSON_CreateObject();
        cJSON_AddBoolToObject(bobj, "online", online);
        cJSON_AddStringToObject(bobj, "driver", online ? "mcp2518fd" : "offline");
        cJSON_AddStringToObject(bobj, "mode", is_fd ? "can_fd_500k_2m" : "classic_500k");
        cJSON_AddBoolToObject(bobj, "listen_only", online ? snap.listen_only : false);
        cJSON_AddNumberToObject(bobj, "tec", tec);
        cJSON_AddNumberToObject(bobj, "rec", rec);
        cJSON_AddBoolToObject(bobj, "bus_off", bo);
        cJSON_AddNumberToObject(bobj, "tx_fail", online ? snap.tx_fail_count : 0);
        cJSON_AddNumberToObject(bobj, "rx_overflow", online ? snap.rx_overflow_count : 0);
        cJSON_AddItemToObject(root, key, bobj);
    };
    add_mcp_bus("can0", CAN_BUS_0, false);
    add_mcp_bus("can1", CAN_BUS_1, true);

    if (any_dual_can) {
        cJSON_AddStringToObject(root, "twai_state", any_bus_off ? "bus_off" : "running");
        cJSON_AddNumberToObject(root, "tx_error_counter", max_tec);
        cJSON_AddNumberToObject(root, "rx_error_counter", max_rec);
        cJSON_AddNumberToObject(root, "rx_missed_count", 0);
        cJSON_AddNumberToObject(root, "rx_overrun_count", total_rx_ovf);
        cJSON_AddNumberToObject(root, "bus_error_count", total_tx_fail);
    } else
#endif
    {
        twai_status_info_t twai_st;
        if (can_engine_get_status_info(&twai_st) == ESP_OK) {
            const char* state_str = "unknown";
            switch (twai_st.state) {
                case TWAI_STATE_STOPPED: state_str = "stopped"; break;
                case TWAI_STATE_RUNNING: state_str = "running"; break;
                case TWAI_STATE_BUS_OFF: state_str = "bus_off"; break;
                case TWAI_STATE_RECOVERING: state_str = "recovering"; break;
            }
            cJSON_AddStringToObject(root, "twai_state", state_str);
            cJSON_AddNumberToObject(root, "tx_error_counter", twai_st.tx_error_counter);
            cJSON_AddNumberToObject(root, "rx_error_counter", twai_st.rx_error_counter);
            cJSON_AddNumberToObject(root, "rx_missed_count", twai_st.rx_missed_count);
            cJSON_AddNumberToObject(root, "rx_overrun_count", twai_st.rx_overrun_count);
            cJSON_AddNumberToObject(root, "bus_error_count", twai_st.bus_error_count);
        } else {
            cJSON_AddStringToObject(root, "twai_state", "offline");
        }
    }

    esp_reset_reason_t reason = esp_reset_reason();
    const char* reason_str = "unknown";
    switch (reason) {
        case ESP_RST_POWERON: reason_str = "power_on"; break;
        case ESP_RST_EXT: reason_str = "external_pin"; break;
        case ESP_RST_SW: reason_str = "software_restart"; break;
        case ESP_RST_PANIC: reason_str = "panic_exception"; break;
        case ESP_RST_INT_WDT: reason_str = "interrupt_wdt"; break;
        case ESP_RST_TASK_WDT: reason_str = "task_wdt"; break;
        case ESP_RST_WDT: reason_str = "other_wdt"; break;
        case ESP_RST_DEEPSLEEP: reason_str = "deep_sleep"; break;
        case ESP_RST_BROWNOUT: reason_str = "brownout"; break;
        case ESP_RST_SDIO: reason_str = "sdio"; break;
        default: break;
    }
    cJSON_AddStringToObject(root, "reset_reason", reason_str);

    const char* wakeup_str = "none";
    if (reason == ESP_RST_DEEPSLEEP) {
        esp_sleep_source_t cause = esp_sleep_get_wakeup_cause();
        if (cause == ESP_SLEEP_WAKEUP_EXT1) wakeup_str = "ext1";
        else if (cause == ESP_SLEEP_WAKEUP_GPIO) wakeup_str = "gpio";
        else if (cause == ESP_SLEEP_WAKEUP_TIMER) wakeup_str = "timer";
        else wakeup_str = "other";
    }
    cJSON_AddStringToObject(root, "wakeup_cause", wakeup_str);

    const RtcCrashInfo* crash = get_rtc_crash_info();
    if (crash && crash->magic == RTC_CRASH_MAGIC) {
        cJSON *cj_crash = cJSON_CreateObject();
        char id_str[16];
        snprintf(id_str, sizeof(id_str), "0x%03lX", (unsigned long)crash->can_id);
        cJSON_AddStringToObject(cj_crash, "can_id", id_str);
        cJSON_AddNumberToObject(cj_crash, "dlc", crash->dlc);
        char hex[17] = {0};
        int dlc = crash->dlc > 8 ? 8 : crash->dlc;
        for (int i = 0; i < dlc; i++) {
            snprintf(&hex[i*2], 3, "%02X", crash->data[i]);
        }
        cJSON_AddStringToObject(cj_crash, "data", hex);
        cJSON_AddNumberToObject(cj_crash, "step_marker", crash->step_marker);
        cJSON_AddStringToObject(cj_crash, "last_decoder", crash->last_decoder);
        cJSON_AddNumberToObject(cj_crash, "uptime_sec", crash->uptime_sec);
        cJSON_AddNumberToObject(cj_crash, "free_heap", crash->free_heap);
        cJSON_AddNumberToObject(cj_crash, "min_free_heap", crash->min_free_heap);
        cJSON_AddNumberToObject(cj_crash, "internal_free_heap", crash->internal_free_heap);
        cJSON_AddNumberToObject(cj_crash, "can0_rx_overflow", crash->can0_rx_overflow);
        cJSON_AddNumberToObject(cj_crash, "can1_rx_overflow", crash->can1_rx_overflow);
        cJSON_AddBoolToObject(cj_crash, "twdt_triggered", crash->twdt_triggered != 0);
        cJSON_AddNumberToObject(cj_crash, "last_abnormal_reset_reason", crash->last_abnormal_reset_reason);
        cJSON_AddStringToObject(cj_crash, "cpu0_task", crash->cpu0_task);
        cJSON_AddStringToObject(cj_crash, "cpu1_task", crash->cpu1_task);
        cJSON_AddStringToObject(cj_crash, "last_event", crash->last_event);
        cJSON_AddItemToObject(root, "last_crash", cj_crash);
    }

    load_crash_diag_cache_once();
    {
        std::lock_guard<std::mutex> lock(s_crash_diag_mutex);
        if (!s_cached_crash_diag_json.empty()) {
            cJSON_AddRawToObject(root, "persisted_crash", s_cached_crash_diag_json.c_str());
        }
    }

    return send_cjson_response(req, root);
}

static esp_err_t api_system_set_time_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 512, body, &body_err)) {
        return body_err;
    }
    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *tz_item = cJSON_GetObjectItem(root, "timezone");
    if (tz_item && cJSON_IsString(tz_item) && tz_item->valuestring && strlen(tz_item->valuestring) > 0) {
        timezone_mgr_set(tz_item->valuestring);
    }

    cJSON *epoch_item = cJSON_GetObjectItem(root, "epoch");
    if (epoch_item && cJSON_IsNumber(epoch_item)) {
        time_t epoch_sec = (time_t)epoch_item->valuedouble;
        if (epoch_sec >= 1704067200) { // Valid timestamp >= year 2024
            struct timeval tv = {};
            tv.tv_sec = epoch_sec;
            tv.tv_usec = 0;
            settimeofday(&tv, nullptr);
            rtc_clock_anchor_update((uint64_t)epoch_sec);
            char strftime_buf[64];
            timezone_mgr_format_local(epoch_sec, strftime_buf, sizeof(strftime_buf));
            ESP_LOGI(TAG, "Device clock synchronized via HTTP: %s (%s)", strftime_buf, timezone_mgr_get_id());
            broadcast_ws_state("system_time", strftime_buf);
            cJSON_Delete(root);
            httpd_resp_set_type(req, "application/json");
            httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Clock and timezone updated\"}");
            return ESP_OK;
        }
    }
    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing or invalid epoch");
    return ESP_OK;
}

static void collect_spiffs_files_recursive(const char *dir_path, cJSON *arr, int depth = 0) {
    if (depth >= 6) {
        ESP_LOGW(TAG, "Skipping directory recursion beyond depth %d at %s", depth, dir_path);
        return;
    }
    DIR *d = opendir(dir_path);
    if (!d) return;
    PsramBuf subpath_buf(320);
    if (!subpath_buf) {
        closedir(d);
        return;
    }
    char *subpath = subpath_buf.data();
    struct dirent *de;
    while ((de = readdir(d)) != nullptr) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        snprintf(subpath, subpath_buf.size(), "%s/%s", dir_path, de->d_name);
        struct stat s;
        if (stat(subpath, &s) == 0) {
            cJSON *f_obj = cJSON_CreateObject();
            cJSON_AddStringToObject(f_obj, "name", de->d_name);
            cJSON_AddStringToObject(f_obj, "path", subpath);
            cJSON_AddNumberToObject(f_obj, "size", s.st_size);
            cJSON_AddBoolToObject(f_obj, "is_dir", S_ISDIR(s.st_mode));
            cJSON_AddItemToArray(arr, f_obj);
            if (S_ISDIR(s.st_mode)) {
                collect_spiffs_files_recursive(subpath, arr, depth + 1);
            }
        }
    }
    closedir(d);
}

static esp_err_t api_system_control_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 16384, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *action_item = cJSON_GetObjectItem(root, "action");
    bool should_reboot = false;
    bool handled_automations = false;
    bool handled_sniffer = false;
    bool handled_mitm = false;
    if (cJSON_IsString(action_item)) {
        const char *act = action_item->valuestring;
        if (strcmp(act, "restart") == 0 || strcmp(act, "reboot") == 0) {
            should_reboot = true;
        } else if (strcmp(act, "list_files") == 0) {
            size_t total_bytes = 0, used_bytes = 0;
            esp_littlefs_info("storage", &total_bytes, &used_bytes);
            cJSON *arr = cJSON_CreateArray();
            collect_spiffs_files_recursive("/spiffs", arr);
            cJSON *resp_obj = cJSON_CreateObject();
            cJSON_AddNumberToObject(resp_obj, "total", total_bytes);
            cJSON_AddNumberToObject(resp_obj, "used", used_bytes);
            cJSON_AddNumberToObject(resp_obj, "free", total_bytes > used_bytes ? total_bytes - used_bytes : 0);
            cJSON_AddItemToObject(resp_obj, "files", arr);
            cJSON_Delete(root);
            return send_cjson_response(req, resp_obj);
        } else if (strcmp(act, "clean_stale_web") == 0 || strcmp(act, "clean_www") == 0) {
            cJSON *keep_item = cJSON_GetObjectItem(root, "keep");
            std::unordered_set<std::string> keep_set;
            if (cJSON_IsArray(keep_item)) {
                int sz = cJSON_GetArraySize(keep_item);
                for (int i = 0; i < sz; i++) {
                    cJSON *ki = cJSON_GetArrayItem(keep_item, i);
                    if (cJSON_IsString(ki) && ki->valuestring) {
                        keep_set.insert(ki->valuestring);
                        const char *sl = strrchr(ki->valuestring, '/');
                        if (sl) keep_set.insert(sl + 1);
                    }
                }
            }

            int deleted_count = 0;
            size_t bytes_freed = 0;
            DIR *d = opendir("/spiffs/www");
            if (d) {
                struct dirent *de;
                while ((de = readdir(d)) != nullptr) {
                    if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
                    char subpath[320];
                    snprintf(subpath, sizeof(subpath), "/spiffs/www/%s", de->d_name);
                    struct stat s;
                    if (stat(subpath, &s) == 0 && !S_ISDIR(s.st_mode)) {
                        std::string fname = de->d_name;
                        if (keep_set.empty() || (keep_set.find(fname) == keep_set.end() && keep_set.find(subpath) == keep_set.end())) {
                            bytes_freed += s.st_size;
                            unlink(subpath);
                            deleted_count++;
                        }
                    }
                }
                closedir(d);
            }
            cJSON *resp_obj = cJSON_CreateObject();
            cJSON_AddStringToObject(resp_obj, "status", "ok");
            cJSON_AddNumberToObject(resp_obj, "deleted_count", deleted_count);
            cJSON_AddNumberToObject(resp_obj, "bytes_freed", bytes_freed);
            cJSON_Delete(root);
            return send_cjson_response(req, resp_obj);
        } else if (strcmp(act, "reload_catalog") == 0) {
            struct stat st;
            int stat_res = -1;
            bool ok = false;
            {
                StaticTransferGuard transfer_guard;
                CatalogReloadGuard reload_guard;
                stat_res = stat("/spiffs/catalog.json", &st);
                ok = load_catalog_from_fs("/spiffs/catalog.json");
            }
            size_t cat_cnt = 0;
            size_t auto_cnt = 0;
            {
                std::lock_guard<std::mutex> lock(g_catalog_mutex);
                cat_cnt = global_catalog.size();
            }
            {
                std::lock_guard<std::mutex> lock(g_automations_mutex);
                auto_cnt = global_automations.size();
            }
            char resp_buf[256];
            snprintf(resp_buf, sizeof(resp_buf), 
                     "{\"status\":\"%s\",\"stat_res\":%d,\"size\":%ld,\"entities\":%zu,\"automations\":%zu}",
                     ok ? "ok" : "fail", stat_res, stat_res == 0 ? (long)st.st_size : -1L,
                     cat_cnt, auto_cnt);
            cJSON_Delete(root);
            httpd_resp_set_type(req, "application/json");
            httpd_resp_sendstr(req, resp_buf);
            return ESP_OK;
        } else if (strcmp(act, "toggle_automations") == 0) {
            cJSON *en = cJSON_GetObjectItem(root, "automations_enabled");
            bool val = cJSON_IsBool(en) ? cJSON_IsTrue(en) : !g_automations_enabled.load();
            set_automations_enabled(val);
            handled_automations = true;
        } else if (strcmp(act, "toggle_sniffer") == 0) {
            cJSON *sn = cJSON_GetObjectItem(root, "sniffer_mode");
            cJSON *hw = cJSON_GetObjectItem(root, "hardware_listen_only");
            bool sniff_val = cJSON_IsBool(sn) ? cJSON_IsTrue(sn) : !g_sniffer_mode.load();
            bool hw_val = cJSON_IsBool(hw) ? cJSON_IsTrue(hw) : g_hardware_listen_only.load();
            set_sniffer_mode(sniff_val, hw_val);
            handled_sniffer = true;
        } else if (strcmp(act, "set_hardware_listen_only") == 0) {
            cJSON *en = cJSON_GetObjectItem(root, "enabled");
            if (!en) en = cJSON_GetObjectItem(root, "hardware_listen_only");
            bool val = cJSON_IsBool(en) ? cJSON_IsTrue(en) : !g_hardware_listen_only.load();
            set_sniffer_mode(g_sniffer_mode.load(), val);
            handled_sniffer = true;
        } else if (strcmp(act, "toggle_mitm_bridge") == 0) {
            cJSON *mb = cJSON_GetObjectItem(root, "mitm_bridge_enabled");
            bool val = cJSON_IsBool(mb) ? cJSON_IsTrue(mb) : !g_mitm_bridge_enabled.load();
            set_mitm_bridge_enabled(val);
            handled_mitm = true;
        } else if (strcmp(act, "disconnect_gvret") == 0 || strcmp(act, "reset_gvret") == 0) {
            gvret_disconnect_client();
        }
    }

    if (!handled_automations) {
        cJSON *auto_item = cJSON_GetObjectItem(root, "automations_enabled");
        if (cJSON_IsBool(auto_item)) {
            set_automations_enabled(cJSON_IsTrue(auto_item));
        }
    }

    if (!handled_mitm) {
        cJSON *mitm_item = cJSON_GetObjectItem(root, "mitm_bridge_enabled");
        if (cJSON_IsBool(mitm_item)) {
            set_mitm_bridge_enabled(cJSON_IsTrue(mitm_item));
        }
    }

    if (!handled_sniffer) {
        cJSON *sniff_item = cJSON_GetObjectItem(root, "sniffer_mode");
        cJSON *hw_item = cJSON_GetObjectItem(root, "hardware_listen_only");
        if (cJSON_IsBool(sniff_item)) {
            bool hw_listen = cJSON_IsBool(hw_item) ? cJSON_IsTrue(hw_item) : g_hardware_listen_only.load();
            set_sniffer_mode(cJSON_IsTrue(sniff_item), hw_listen);
        } else if (cJSON_IsBool(hw_item)) {
            set_sniffer_mode(g_sniffer_mode.load(), cJSON_IsTrue(hw_item));
        }
    }

    cJSON *reboot_item = cJSON_GetObjectItem(root, "reboot");
    if (should_reboot || (reboot_item && cJSON_IsTrue(reboot_item))) {
        cJSON_Delete(root);
        return send_reboot_json_response(req, "{\"status\":\"ok\",\"message\":\"Rebooting...\"}");
    }

    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
    return ESP_OK;
}

static esp_err_t api_wifi_status_handler(httpd_req_t *req) {
    set_cors_headers(req);
    NetworkStatusInfo st = network_mgr_get_status();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "sta_connected", st.sta_connected);
    cJSON_AddStringToObject(root, "sta_ssid", st.sta_ssid.c_str());
    cJSON_AddStringToObject(root, "sta_ip", st.sta_ip.c_str());
    cJSON_AddStringToObject(root, "sta_gw", st.sta_gw.c_str());
    cJSON_AddStringToObject(root, "sta_mask", st.sta_mask.c_str());
    cJSON_AddNumberToObject(root, "sta_rssi", st.sta_rssi);

    cJSON_AddBoolToObject(root, "ap_active", st.ap_active);
    cJSON_AddStringToObject(root, "ap_ssid", st.ap_ssid.c_str());
    cJSON_AddStringToObject(root, "ap_ip", st.ap_ip.c_str());
    cJSON_AddNumberToObject(root, "ap_clients", st.ap_clients);

    const char* ap_mode_str = "auto";
    if (st.ap_mode == AP_MODE_ALWAYS_ON) ap_mode_str = "always_on";
    else if (st.ap_mode == AP_MODE_DISABLED) ap_mode_str = "disabled";
    cJSON_AddStringToObject(root, "ap_mode", ap_mode_str);

    return send_cjson_response(req, root);
}

static esp_err_t api_wifi_get_networks_handler(httpd_req_t *req) {
    set_cors_headers(req);
    auto list = network_mgr_get_known_networks();
    cJSON *root = cJSON_CreateArray();
    for (const auto& net : list) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", net.ssid.c_str());
        cJSON_AddNumberToObject(item, "priority", net.priority);
        cJSON_AddItemToArray(root, item);
    }
    return send_cjson_response(req, root);
}

static esp_err_t api_wifi_post_networks_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 512, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
    cJSON *pass = cJSON_GetObjectItem(root, "password");
    cJSON *prio = cJSON_GetObjectItem(root, "priority");

    if (cJSON_IsString(ssid) && strlen(ssid->valuestring) > 0) {
        std::string password = cJSON_IsString(pass) ? pass->valuestring : "";
        int priority = cJSON_IsNumber(prio) ? prio->valueint : 50;
        network_mgr_add_known_network(ssid->valuestring, password, priority);
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Network saved\"}");
        return ESP_OK;
    }

    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing SSID");
    return ESP_OK;
}

static std::string url_decode(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size()) {
            auto hex2val = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            int v1 = hex2val(in[i + 1]);
            int v2 = hex2val(in[i + 2]);
            if (v1 >= 0 && v2 >= 0) {
                out.push_back(static_cast<char>((v1 << 4) | v2));
                i += 2;
                continue;
            }
        } else if (in[i] == '+') {
            out.push_back(' ');
            continue;
        }
        out.push_back(in[i]);
    }
    return out;
}

static esp_err_t api_wifi_delete_networks_handler(httpd_req_t *req) {
    set_cors_headers(req);

    std::string target_ssid;

    // 1. Prefer reading JSON body if available: {"ssid": "..."}
    if (req->content_len > 0) {
        std::string body;
        esp_err_t body_err = ESP_OK;
        if (!read_req_body(req, 512, body, &body_err)) {
            return body_err;
        }
        cJSON *root = cJSON_Parse(body.c_str());
        if (root) {
            cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
            if (cJSON_IsString(ssid) && ssid->valuestring && strlen(ssid->valuestring) > 0) {
                target_ssid = ssid->valuestring;
            }
            cJSON_Delete(root);
        }
    }

    // 2. Fallback to extracting SSID from query string: ?ssid=...
    if (target_ssid.empty()) {
        size_t query_len = httpd_req_get_url_query_len(req);
        if (query_len > 0) {
            char query_buf[128];
            if (httpd_req_get_url_query_str(req, query_buf, sizeof(query_buf)) == ESP_OK) {
                char ssid_val[64];
                if (httpd_query_key_value(query_buf, "ssid", ssid_val, sizeof(ssid_val)) == ESP_OK) {
                    target_ssid = url_decode(ssid_val);
                }
            }
        }
    }

    if (!target_ssid.empty()) {
        bool removed = network_mgr_remove_known_network(target_ssid);
        httpd_resp_set_type(req, "application/json");
        if (removed) {
            httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
        } else {
            httpd_resp_set_status(req, "404 Not Found");
            httpd_resp_sendstr(req, "{\"status\":\"not_found\",\"message\":\"Network not found\"}");
        }
        return ESP_OK;
    }

    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing SSID");
    return ESP_OK;
}

static esp_err_t api_wifi_scan_handler(httpd_req_t *req) {
    set_cors_headers(req);
    if (!network_mgr_is_scanning()) {
        network_mgr_start_scan();
    }

    auto results = network_mgr_get_scan_results();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "scanning", network_mgr_is_scanning());

    cJSON *arr = cJSON_AddArrayToObject(root, "results");
    for (const auto& res : results) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", res.ssid.c_str());
        cJSON_AddNumberToObject(item, "rssi", res.rssi);
        cJSON_AddNumberToObject(item, "authmode", res.authmode);
        cJSON_AddBoolToObject(item, "in_known_list", res.in_known_list);
        cJSON_AddItemToArray(arr, item);
    }

    return send_cjson_response(req, root);
}

static esp_err_t api_mqtt_get_handler(httpd_req_t *req) {
    set_cors_headers(req);
    MqttConfig cfg = mqtt_mgr_get_config();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "enabled", cfg.enabled);
    cJSON_AddBoolToObject(root, "ha_discovery", cfg.ha_discovery_enabled);
    cJSON_AddStringToObject(root, "broker_url", cfg.broker_url.c_str());
    cJSON_AddStringToObject(root, "username", cfg.username.c_str());
    cJSON_AddBoolToObject(root, "has_password", !cfg.password.empty());
    cJSON_AddBoolToObject(root, "connected", mqtt_mgr_is_connected());

    return send_cjson_response(req, root);
}

static esp_err_t api_mqtt_post_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 1024, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    MqttConfig cfg = mqtt_mgr_get_config();

    cJSON *en_item = cJSON_GetObjectItem(root, "enabled");
    if (cJSON_IsBool(en_item)) {
        cfg.enabled = cJSON_IsTrue(en_item);
    }

    cJSON *disco_item = cJSON_GetObjectItem(root, "ha_discovery");
    if (cJSON_IsBool(disco_item)) {
        cfg.ha_discovery_enabled = cJSON_IsTrue(disco_item);
    }

    cJSON *url_item = cJSON_GetObjectItem(root, "broker_url");
    if (cJSON_IsString(url_item) && strlen(url_item->valuestring) > 0) {
        cfg.broker_url = url_item->valuestring;
    }

    cJSON *user_item = cJSON_GetObjectItem(root, "username");
    if (cJSON_IsString(user_item)) {
        cfg.username = user_item->valuestring;
    }

    cJSON *pass_item = cJSON_GetObjectItem(root, "password");
    cJSON *keep_item = cJSON_GetObjectItem(root, "keep_password");
    if (cJSON_IsString(pass_item)) {
        if (strlen(pass_item->valuestring) > 0 || (keep_item && !cJSON_IsTrue(keep_item))) {
            cfg.password = pass_item->valuestring;
        }
    }

    cJSON_Delete(root);

    mqtt_mgr_save_config(cfg);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"MQTT settings saved\"}");
    return ESP_OK;
}

static esp_err_t api_can_monitored_ids_get_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::vector<uint32_t> ids = mqtt_mgr_get_monitored_ids();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "count", (double)ids.size());
    cJSON_AddBoolToObject(root, "customized", mqtt_mgr_is_monitored_ids_customized());
    cJSON *arr = cJSON_CreateArray();
    for (uint32_t id : ids) {
        char hex[16];
        snprintf(hex, sizeof(hex), "0x%03lX", (unsigned long)id);
        cJSON_AddItemToArray(arr, cJSON_CreateString(hex));
    }
    cJSON_AddItemToObject(root, "monitored_ids", arr);
    return send_cjson_response(req, root);
}

static esp_err_t api_can_monitored_ids_post_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 4096, body, &body_err)) {
        return body_err;
    }

    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *arr = cJSON_IsArray(root) ? root : cJSON_GetObjectItem(root, "monitored_ids");
    if (!arr || !cJSON_IsArray(arr)) {
        arr = cJSON_GetObjectItem(root, "ids");
    }

    if (!arr || !cJSON_IsArray(arr)) {
        cJSON_Delete(root);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Expected JSON array of CAN IDs");
        return ESP_OK;
    }

    std::vector<uint32_t> ids;
    int count = cJSON_GetArraySize(arr);
    for (int i = 0; i < count; i++) {
        cJSON *itm = cJSON_GetArrayItem(arr, i);
        if (itm && cJSON_IsString(itm)) {
            ids.push_back(strtoul(itm->valuestring, nullptr, 0));
        } else if (itm && cJSON_IsNumber(itm)) {
            ids.push_back((uint32_t)itm->valueint);
        }
    }
    cJSON_Delete(root);

    mqtt_mgr_set_monitored_ids(ids, true);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddStringToObject(resp, "status", "ok");
    cJSON_AddNumberToObject(resp, "count", (double)ids.size());
    return send_cjson_response(req, resp);
}

static esp_err_t api_can_monitored_ids_reset_handler(httpd_req_t *req) {
    set_cors_headers(req);
    mqtt_mgr_reset_monitored_ids();
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Restored default monitored CAN IDs\"}");
    return ESP_OK;
}

static esp_err_t api_can_active_ids_get_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::vector<uint32_t> active = can_engine_get_active_ids();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "count", (double)active.size());
    cJSON *arr = cJSON_CreateArray();
    for (uint32_t id : active) {
        char hex[16];
        snprintf(hex, sizeof(hex), "0x%03lX", (unsigned long)id);
        cJSON_AddItemToArray(arr, cJSON_CreateString(hex));
    }
    cJSON_AddItemToObject(root, "active_ids", arr);
    return send_cjson_response(req, root);
}

static esp_err_t api_notify_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 1024, body, &body_err)) {
        return body_err;
    }
    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }
    cJSON *msg_item = cJSON_GetObjectItem(root, "message");
    if (!msg_item) msg_item = cJSON_GetObjectItem(root, "text");
    if (!msg_item) msg_item = cJSON_GetObjectItem(root, "popup_message");
    std::string msg = (msg_item && cJSON_IsString(msg_item)) ? msg_item->valuestring : "";

    cJSON *lvl_item = cJSON_GetObjectItem(root, "level");
    std::string lvl = (lvl_item && cJSON_IsString(lvl_item)) ? lvl_item->valuestring : "info";

    int32_t hold_ms = 0;
    cJSON *hold_item = cJSON_GetObjectItem(root, "hold_ms");
    if (hold_item && cJSON_IsNumber(hold_item) && std::isfinite(hold_item->valuedouble)) {
        double v = hold_item->valuedouble;
        if (v > 0.0) {
            if (v < static_cast<double>(TRACK_POPUP_MIN_HOLD_MS)) {
                hold_ms = static_cast<int32_t>(TRACK_POPUP_MIN_HOLD_MS);
            } else if (v > static_cast<double>(TRACK_POPUP_MAX_HOLD_MS)) {
                hold_ms = static_cast<int32_t>(TRACK_POPUP_MAX_HOLD_MS);
            } else {
                hold_ms = static_cast<int32_t>(std::llround(v));
            }
        }
    }

    cJSON_Delete(root);

    if (msg.empty()) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing message");
        return ESP_OK;
    }

    bool sent = false;
    if (lvl == "warning") {
        sent = track_popup_show_warning_ex(msg.c_str(), hold_ms);
    } else if (lvl == "error" || lvl == "critical") {
        sent = track_popup_show_error_ex(msg.c_str(), hold_ms);
    } else {
        sent = track_popup_show_info_ex(msg.c_str(), hold_ms);
    }

    httpd_resp_set_type(req, "application/json");
    if (sent) {
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Notification queued for cluster\"}");
        return ESP_OK;
    } else {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to queue notification");
        return ESP_OK;
    }
}

static esp_err_t api_nav_handler(httpd_req_t *req) {
    set_cors_headers(req);
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 2048, body, &body_err)) {
        return body_err;
    }
    cJSON *root = cJSON_Parse(body.c_str());
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_OK;
    }

    cJSON *act = cJSON_GetObjectItem(root, "action");
    if (act && cJSON_IsString(act) && strcmp(act->valuestring, "clear") == 0) {
        hud_nav_clear();
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"HUD navigation cleared\"}");
        return ESP_OK;
    }

    hud_nav_instruction_t instr = {};
    instr.distance_meters = 0xFFFF; // Inactive default
    auto clamp_u16 = [](cJSON *item, uint16_t max_val, uint16_t fallback) -> uint16_t {
        if (!item || !cJSON_IsNumber(item) || !std::isfinite(item->valuedouble)) return fallback;
        double v = item->valuedouble;
        if (v < 0.0) return 0;
        if (v > static_cast<double>(max_val)) return max_val;
        return static_cast<uint16_t>(v);
    };

    cJSON *icon_item = cJSON_GetObjectItem(root, "icon");
    if (icon_item && cJSON_IsNumber(icon_item) && std::isfinite(icon_item->valuedouble)) {
        instr.icon = static_cast<hud_maneuver_icon_t>(clamp_u16(icon_item, 255, HUD_MANEUVER_STRAIGHT));
    } else {
        instr.icon = HUD_MANEUVER_STRAIGHT;
    }

    cJSON *dir_item = cJSON_GetObjectItem(root, "direction");
    if (!dir_item) dir_item = cJSON_GetObjectItem(root, "direction_deg");
    if (!dir_item) dir_item = cJSON_GetObjectItem(root, "heading");
    if (dir_item && cJSON_IsNumber(dir_item) && std::isfinite(dir_item->valuedouble)) {
        instr.direction_deg = clamp_u16(dir_item, 65535, 0);
    }

    cJSON *dist_item = cJSON_GetObjectItem(root, "distance");
    if (!dist_item) dist_item = cJSON_GetObjectItem(root, "distance_meters");
    if (dist_item && cJSON_IsNumber(dist_item) && std::isfinite(dist_item->valuedouble)) {
        instr.distance_meters = clamp_u16(dist_item, 65535, 0xFFFF);
    }

    cJSON *bars_item = cJSON_GetObjectItem(root, "bars");
    if (bars_item && cJSON_IsNumber(bars_item) && std::isfinite(bars_item->valuedouble)) {
        instr.bar_graph = static_cast<uint8_t>(clamp_u16(bars_item, 255, 0));
    }

    cJSON *spd_item = cJSON_GetObjectItem(root, "speed_limit");
    if (spd_item && cJSON_IsNumber(spd_item) && std::isfinite(spd_item->valuedouble)) {
        instr.speed_limit_kph = static_cast<uint8_t>(clamp_u16(spd_item, 255, 0));
    }

    cJSON *cam_item = cJSON_GetObjectItem(root, "camera_alert");
    if (cam_item && cJSON_IsBool(cam_item)) instr.speed_camera_alert = cJSON_IsTrue(cam_item);

    cJSON *street_item = cJSON_GetObjectItem(root, "street");
    if (street_item && cJSON_IsString(street_item)) instr.street_name = street_item->valuestring;

    cJSON *lanes_item = cJSON_GetObjectItem(root, "lanes");
    if (!lanes_item) lanes_item = cJSON_GetObjectItem(root, "num_lanes");
    if (lanes_item && cJSON_IsNumber(lanes_item) && std::isfinite(lanes_item->valuedouble)) {
        int lanes_val = static_cast<int>(lanes_item->valuedouble);
        if (lanes_val < 0) lanes_val = 0;
        else if (lanes_val > 8) lanes_val = 8;
        instr.num_lanes = static_cast<uint8_t>(lanes_val);
    }

    cJSON *lane_dirs = cJSON_GetObjectItem(root, "lane_directions");
    if (lane_dirs && cJSON_IsArray(lane_dirs)) {
        int n = cJSON_GetArraySize(lane_dirs);
        if (instr.num_lanes == 0 && n > 0) {
            instr.num_lanes = static_cast<uint8_t>(std::min(n, 8));
        }
        for (int i = 0; i < n && i < 8; i++) {
            cJSON *elem = cJSON_GetArrayItem(lane_dirs, i);
            if (elem && cJSON_IsNumber(elem) && std::isfinite(elem->valuedouble)) {
                instr.lane_directions[i] = static_cast<uint8_t>(clamp_u16(elem, 255, 0));
            }
        }
    }

    cJSON *lane_recs = cJSON_GetObjectItem(root, "lane_recommended");
    if (!lane_recs) lane_recs = cJSON_GetObjectItem(root, "lane_highlights");
    if (lane_recs && cJSON_IsArray(lane_recs)) {
        int n = cJSON_GetArraySize(lane_recs);
        if (instr.num_lanes == 0 && n > 0) {
            instr.num_lanes = static_cast<uint8_t>(std::min(n, 8));
        }
        for (int i = 0; i < n && i < 8; i++) {
            cJSON *elem = cJSON_GetArrayItem(lane_recs, i);
            if (elem) {
                if (cJSON_IsBool(elem)) {
                    instr.lane_recommended[i] = cJSON_IsTrue(elem) ? 1 : 0;
                } else if (cJSON_IsNumber(elem) && std::isfinite(elem->valuedouble)) {
                    instr.lane_recommended[i] = static_cast<uint8_t>(clamp_u16(elem, 255, 0));
                }
            }
        }
    }

    instr.has_lane_guidance = (instr.num_lanes > 0);

    cJSON *platform_item = cJSON_GetObjectItem(root, "platform");
    if (platform_item && cJSON_IsString(platform_item)) {
        if (strcmp(platform_item->valuestring, "gen2") == 0 || strcmp(platform_item->valuestring, "ccan") == 0) {
            hud_nav_set_platform(HUD_PLATFORM_GEN2_CCAN);
        } else if (strcmp(platform_item->valuestring, "egmp") == 0 || strcmp(platform_item->valuestring, "canfd") == 0) {
            hud_nav_set_platform(HUD_PLATFORM_EGMP_CANFD);
        }
    }

    bool updated = hud_nav_update(&instr);
    cJSON_Delete(root);

    httpd_resp_set_type(req, "application/json");
    if (updated) {
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"HUD navigation updated\"}");
        return ESP_OK;
    } else {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to update HUD navigation");
        return ESP_OK;
    }
}

static void ws_send_initial_snapshot(void *arg) {
    int *fd_ptr = static_cast<int*>(arg);
    if (!fd_ptr) return;
    int fd = *fd_ptr;
    delete fd_ptr;

    if (!global_web_server || httpd_ws_get_fd_info(global_web_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
        return;
    }

    PsramUnorderedMap<std::string, std::string> merged = get_live_state_cache();
    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        for (const auto& entity : global_catalog) {
            if (!entity.current_state.empty() && entity.current_state != "Unknown") {
                if (merged.find(entity.id) == merged.end()) {
                    merged[entity.id] = entity.current_state;
                }
            }
        }
    }
    if (merged.find("cond_aux_12v_battery") == merged.end()) {
        char vbat_buf[16];
        vbat_sensor_get_last_str_copy(vbat_buf, sizeof(vbat_buf));
        std::string vbat(vbat_buf);
        if (!vbat.empty() && vbat != "Unknown") {
            merged["cond_aux_12v_battery"] = vbat;
        }
    }

    for (const auto& pair : merged) {
        if (pair.second.empty() || pair.second == "Unknown") continue;
        std::string json = build_ws_state_json(pair.first, pair.second);
        httpd_ws_frame_t ws_pkt = {};
        ws_pkt.payload = reinterpret_cast<uint8_t*>(const_cast<char*>(json.c_str()));
        ws_pkt.len = json.length();
        ws_pkt.type = HTTPD_WS_TYPE_TEXT;
        if (httpd_ws_send_frame_async(global_web_server, fd, &ws_pkt) != ESP_OK) {
            break;
        }
    }
}

static esp_err_t ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        int sockfd = httpd_req_to_sockfd(req);
        ESP_LOGI(TAG, "WebSocket client connected on fd %d", sockfd);
        struct timeval tv;
        tv.tv_sec = 0;
        tv.tv_usec = 200000; // 200ms send timeout so a suspended or stalled browser tab never blocks httpd
        setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        s_has_ws_clients_cached.store(true, std::memory_order_relaxed);
        int *fd_copy = new (std::nothrow) int(sockfd);
        if (fd_copy && httpd_queue_work(global_web_server, ws_send_initial_snapshot, fd_copy) != ESP_OK) {
            delete fd_copy;
        }
        return ESP_OK;
    }

    httpd_ws_frame_t ws_pkt;
    memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
    ws_pkt.type = HTTPD_WS_TYPE_TEXT;

    esp_err_t ret = httpd_ws_recv_frame(req, &ws_pkt, 0);
    if (ret != ESP_OK) {
        return ret;
    }

    if (ws_pkt.len) {
        uint8_t rx_buf[128];
        if (ws_pkt.len >= sizeof(rx_buf)) {
            ESP_LOGW(TAG, "Closing WS fd %d: oversized frame (%zu bytes > %zu)",
                     httpd_req_to_sockfd(req), ws_pkt.len, sizeof(rx_buf) - 1);
            httpd_ws_frame_t close_pkt = {};
            close_pkt.type = HTTPD_WS_TYPE_CLOSE;
            httpd_ws_send_frame(req, &close_pkt);
            return ESP_FAIL;
        }
        ws_pkt.payload = rx_buf;
        ret = httpd_ws_recv_frame(req, &ws_pkt, ws_pkt.len);
        if (ret != ESP_OK) {
            return ret;
        }
        rx_buf[ws_pkt.len] = '\0';
        if (ws_pkt.type == HTTPD_WS_TYPE_TEXT) {
            cJSON *msg = cJSON_Parse(reinterpret_cast<const char*>(rx_buf));
            if (msg) {
                cJSON *type_item = cJSON_GetObjectItem(msg, "type");
                if (type_item && cJSON_IsString(type_item) && strcmp(type_item->valuestring, "ble_learn") == 0) {
                    cJSON *active_item = cJSON_GetObjectItem(msg, "active");
                    cJSON *dur_item = cJSON_GetObjectItem(msg, "duration_ms");
                    bool active = cJSON_IsTrue(active_item);
                    uint32_t dur = (dur_item && cJSON_IsNumber(dur_item) && dur_item->valueint > 0)
                                       ? (uint32_t)dur_item->valueint
                                       : 30000;
                    can_engine_set_ble_learn_mode(active, dur);
                }
                cJSON_Delete(msg);
            }
        }
    }

    return ESP_OK;
}

static esp_err_t api_ble_status_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    std::string status_json = ble_mgr_get_status_json();
    httpd_resp_sendstr(req, status_json.c_str());
    return ESP_OK;
}

static esp_err_t api_ble_scan_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    int dur = 10;
    char query[32] = {0};
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        char val[16] = {0};
        if (httpd_query_key_value(query, "duration", val, sizeof(val)) == ESP_OK) {
            dur = atoi(val);
            if (dur <= 0 || dur > 60) dur = 10;
        }
    }
    ble_mgr_start_scan(dur);
    httpd_resp_sendstr(req, "{\"status\":\"scanning_started\"}");
    return ESP_OK;
}

static esp_err_t api_ble_pair_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 512, body, &body_err)) {
        return body_err;
    }
    cJSON *root = cJSON_Parse(body.c_str());
    if (root) {
        cJSON *addr = cJSON_GetObjectItem(root, "mac");
        if (!addr) addr = cJSON_GetObjectItem(root, "address");
        cJSON *name = cJSON_GetObjectItem(root, "name");
        if (addr && cJSON_IsString(addr) && addr->valuestring[0] != '\0') {
            std::string addr_str = addr->valuestring;
            std::string name_str = (name && cJSON_IsString(name)) ? name->valuestring : "";
            ble_mgr_pair_device(addr_str, name_str);
            cJSON_Delete(root);
            httpd_resp_sendstr(req, "{\"status\":\"pairing_requested\"}");
            return ESP_OK;
        }
        cJSON_Delete(root);
    }
    httpd_resp_set_status(req, "400 Bad Request");
    httpd_resp_sendstr(req, "{\"status\":\"error\",\"message\":\"missing_address\"}");
    return ESP_OK;
}

static esp_err_t api_ble_unpair_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    std::string addr_str = "";
    if (req->content_len > 0) {
        std::string body;
        esp_err_t body_err = ESP_OK;
        if (!read_req_body(req, 512, body, &body_err)) {
            return body_err;
        }
        cJSON *root = cJSON_Parse(body.c_str());
        if (root) {
            cJSON *addr = cJSON_GetObjectItem(root, "mac");
            if (!addr) addr = cJSON_GetObjectItem(root, "address");
            if (addr && cJSON_IsString(addr)) {
                addr_str = addr->valuestring;
            }
            cJSON_Delete(root);
        }
    }
    ble_mgr_unpair_device(addr_str);
    httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
    return ESP_OK;
}

static esp_err_t api_ble_test_event_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    std::string btn_str = "volume_up";
    std::string act_str = "press";
    if (req->content_len > 0) {
        std::string body;
        esp_err_t body_err = ESP_OK;
        if (!read_req_body(req, 512, body, &body_err)) {
            return body_err;
        }
        cJSON *root = cJSON_Parse(body.c_str());
        if (root) {
            cJSON *btn = cJSON_GetObjectItem(root, "button");
            cJSON *act = cJSON_GetObjectItem(root, "action");
            if (btn && cJSON_IsString(btn)) btn_str = btn->valuestring;
            if (act && cJSON_IsString(act)) act_str = act->valuestring;
            cJSON_Delete(root);
        }
    }
    ble_mgr_inject_test_event(btn_str, act_str);
    httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
    return ESP_OK;
}

static esp_err_t api_ble_clear_events_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    ble_mgr_clear_events();
    httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
    return ESP_OK;
}

static esp_err_t api_ble_beacons_post_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 1024, body, &body_err)) {
        return body_err;
    }
    cJSON *root = cJSON_Parse(body.c_str());
    if (root) {
        cJSON *uuid = cJSON_GetObjectItem(root, "uuid");
        cJSON *mac = cJSON_GetObjectItem(root, "mac");
        if (!mac) mac = cJSON_GetObjectItem(root, "address");
        cJSON *name = cJSON_GetObjectItem(root, "name");
        cJSON *enter_rssi = cJSON_GetObjectItem(root, "enter_rssi");
        cJSON *exit_timeout = cJSON_GetObjectItem(root, "exit_timeout_s");
        if (!exit_timeout) exit_timeout = cJSON_GetObjectItem(root, "exit_timeout");

        std::string uuid_str = (uuid && cJSON_IsString(uuid)) ? uuid->valuestring : "";
        std::string mac_str = (mac && cJSON_IsString(mac)) ? mac->valuestring : "";
        std::string name_str = (name && cJSON_IsString(name)) ? name->valuestring : "Phone Beacon";
        int r_val = (enter_rssi && cJSON_IsNumber(enter_rssi)) ? enter_rssi->valueint : -75;
        int t_val = (exit_timeout && cJSON_IsNumber(exit_timeout)) ? exit_timeout->valueint : 20;

        bool ok = ble_mgr_set_beacon(uuid_str, mac_str, name_str, r_val, t_val);
        cJSON_Delete(root);
        if (ok) {
            httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
            return ESP_OK;
        }
    }
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid beacon JSON");
    return ESP_OK;
}

static esp_err_t api_ble_beacons_delete_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    std::string body;
    esp_err_t body_err = ESP_OK;
    if (!read_req_body(req, 512, body, &body_err)) {
        return body_err;
    }
    cJSON *root = cJSON_Parse(body.c_str());
    if (root) {
        cJSON *uuid = cJSON_GetObjectItem(root, "uuid");
        cJSON *mac = cJSON_GetObjectItem(root, "mac");
        if (!mac) mac = cJSON_GetObjectItem(root, "address");

        std::string uuid_str = (uuid && cJSON_IsString(uuid)) ? uuid->valuestring : "";
        std::string mac_str = (mac && cJSON_IsString(mac)) ? mac->valuestring : "";

        bool ok = ble_mgr_delete_beacon(uuid_str, mac_str);
        cJSON_Delete(root);
        if (ok) {
            httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
            return ESP_OK;
        }
    }
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid beacon delete JSON");
    return ESP_OK;
}

httpd_handle_t start_webserver(void) {
    load_crash_diag_cache_once();
    httpd_handle_t server = nullptr;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 8192;
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.max_uri_handlers = 48;
    config.lru_purge_enable = true;
    config.keep_alive_enable = true;
    config.keep_alive_idle = 10;
    config.send_wait_timeout = 25; // 25s send wait timeout for large asset streaming
    config.recv_wait_timeout = 15;
    config.max_open_sockets = 7; // allow sufficient sockets for parallel assets + WebSocket stream

    esp_err_t err = httpd_start(&server, &config);
    if (err == ESP_OK) {
        auto reg_uri = [&](const char* uri, httpd_method_t method, esp_err_t (*handler)(httpd_req_t*), bool is_ws = false) {
            httpd_uri_t u = {};
            u.uri = uri;
            u.method = method;
            u.handler = handler;
            u.user_ctx = nullptr;
#ifdef CONFIG_HTTPD_WS_SUPPORT
            u.is_websocket = is_ws;
#endif
            httpd_register_uri_handler(server, &u);
        };

        reg_uri("/api/states", HTTP_GET, api_states_handler);
        reg_uri("/api/command", HTTP_POST, api_command_handler);
        reg_uri("/api/notify", HTTP_POST, api_notify_handler);
        reg_uri("/api/nav", HTTP_POST, api_nav_handler);
        reg_uri("/api/test_automation", HTTP_POST, api_test_automation_handler);
        reg_uri("/api/automations/test", HTTP_POST, api_test_automation_handler);
        reg_uri("/api/automations/diagnostics", HTTP_GET, api_automations_diagnostics_handler);
        reg_uri("/api/automations", HTTP_GET, api_get_automations_handler);
        reg_uri("/api/automations", HTTP_POST, api_post_automations_handler);
        reg_uri("/api/preferences", HTTP_GET, api_get_preferences_handler);
        reg_uri("/api/preferences", HTTP_POST, api_post_preferences_handler);
        reg_uri("/api/system/status", HTTP_GET, api_system_status_handler);
        reg_uri("/api/system/control", HTTP_POST, api_system_control_handler);
        reg_uri("/api/system/time", HTTP_POST, api_system_set_time_handler);
        reg_uri("/api/wifi/status", HTTP_GET, api_wifi_status_handler);
        reg_uri("/api/wifi/networks", HTTP_GET, api_wifi_get_networks_handler);
        reg_uri("/api/wifi/networks", HTTP_POST, api_wifi_post_networks_handler);
        reg_uri("/api/wifi/networks", HTTP_DELETE, api_wifi_delete_networks_handler);
        reg_uri("/api/wifi/scan", HTTP_GET, api_wifi_scan_handler);
        reg_uri("/api/ble/status", HTTP_GET, api_ble_status_handler);
        reg_uri("/api/ble/scan", HTTP_POST, api_ble_scan_handler);
        reg_uri("/api/ble/pair", HTTP_POST, api_ble_pair_handler);
        reg_uri("/api/ble/unpair", HTTP_POST, api_ble_unpair_handler);
        reg_uri("/api/ble/test_event", HTTP_POST, api_ble_test_event_handler);
        reg_uri("/api/ble/clear_events", HTTP_POST, api_ble_clear_events_handler);
        reg_uri("/api/ble/beacons", HTTP_POST, api_ble_beacons_post_handler);
        reg_uri("/api/ble/beacons", HTTP_DELETE, api_ble_beacons_delete_handler);
        reg_uri("/api/mqtt", HTTP_GET, api_mqtt_get_handler);
        reg_uri("/api/mqtt", HTTP_POST, api_mqtt_post_handler);
        reg_uri("/api/can/monitored_ids", HTTP_GET, api_can_monitored_ids_get_handler);
        reg_uri("/api/can/monitored_ids", HTTP_POST, api_can_monitored_ids_post_handler);
        reg_uri("/api/can/monitored_ids/reset", HTTP_POST, api_can_monitored_ids_reset_handler);
        reg_uri("/api/can/active_ids", HTTP_GET, api_can_active_ids_get_handler);
        reg_uri("/api/upload", HTTP_POST, api_file_upload_handler);
        reg_uri("/api/ota", HTTP_POST, api_ota_handler);
        reg_uri("/api/ota/cloud_pull", HTTP_POST, api_ota_cloud_pull_handler);
        reg_uri("/api/ota/status", HTTP_GET, api_ota_status_handler);
        reg_uri("/ws", HTTP_GET, ws_handler, true);
        reg_uri("/*", HTTP_OPTIONS, options_handler);
        reg_uri("/*", HTTP_GET, static_file_handler);

        global_web_server = server;
        if (!s_ws_log_queue) {
#if CONFIG_SPIRAM
            if (!s_ws_log_queue_storage) {
                s_ws_log_queue_storage = static_cast<uint8_t*>(
                    heap_caps_malloc_prefer(kWsLogQueueLen * sizeof(ws_log_item_t), 2,
                                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
            }
            if (s_ws_log_queue_storage) {
                s_ws_log_queue = xQueueCreateStatic(kWsLogQueueLen, sizeof(ws_log_item_t),
                                                    s_ws_log_queue_storage, &s_ws_log_queue_struct);
            }
#endif
            if (!s_ws_log_queue) {
                s_ws_log_queue = xQueueCreate(kWsLogQueueLen, sizeof(ws_log_item_t));
            }
            if (s_ws_log_queue) {
                xTaskCreate(ws_log_worker_task, "ws_log_wkr", 3584, nullptr, 2, nullptr);
            }
        }
        if (!original_log_vprintf) {
            original_log_vprintf = esp_log_set_vprintf(custom_websocket_logger);
        }
        ESP_LOGI(TAG, "Embedded Web Server started successfully on port %d", config.server_port);
    } else {
        ESP_LOGE(TAG, "Failed starting HTTP web server: %s", esp_err_to_name(err));
    }
    return server;
}

