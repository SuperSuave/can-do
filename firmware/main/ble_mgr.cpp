#include "ble_mgr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "cJSON.h"
#include <cstdio>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <algorithm>
#include <sys/stat.h>

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "host/ble_uuid.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_store.h"

static const char* TAG = "BLE_MGR";
static const char* BLE_CONFIG_FILE = "/spiffs/ble_config.json";

static std::mutex s_ble_mutex;
static bool s_ble_enabled = false;
static bool s_ble_scanning = false;
static uint32_t s_scan_start_ms = 0;
static uint32_t s_scan_duration_ms = 15000;

static std::vector<BleDeviceInfo> s_discovered_devices;
static std::vector<BleDeviceInfo> s_paired_devices;
static BleDeviceInfo s_connected_device;
static bool s_has_connected_device = false;

static std::vector<BleButtonCallback> s_event_callbacks;
static uint16_t s_last_consumer_code = 0;
static uint8_t s_last_keycode = 0;

// Forward declarations for external integrations
#include "api.h"
extern void can_engine_trigger_ble_event(const BleButtonEvent& event);
extern void mqtt_mgr_publish_ble_event(const BleButtonEvent& event);

// Forward declarations for HID parsers
void ble_mgr_handle_consumer_report(const uint8_t* data, size_t len, const std::string& addr, const std::string& name);
void ble_mgr_handle_keyboard_report(const uint8_t* data, size_t len, const std::string& addr, const std::string& name);

const char* ble_hid_consumer_code_to_name(uint16_t usage_code) {
    switch (usage_code) {
        case 0x00E9: return "volume_up";
        case 0x00EA: return "volume_down";
        case 0x00E2: return "mute";
        case 0x00CD: return "play_pause";
        case 0x00B5: return "next_track";
        case 0x00B6: return "prev_track";
        case 0x00B7: return "stop";
        case 0x0030: return "power";
        case 0x0040: return "menu";
        case 0x0223: return "home";
        case 0x0224: return "back";
        case 0x018A: return "media_select";
        case 0x00B8: return "eject";
        default:     return nullptr;
    }
}

const char* ble_hid_keyboard_code_to_name(uint8_t keycode) {
    switch (keycode) {
        case 0x1E: return "key_1";
        case 0x1F: return "key_2";
        case 0x20: return "key_3";
        case 0x21: return "key_4";
        case 0x22: return "key_5";
        case 0x23: return "key_6";
        case 0x24: return "key_7";
        case 0x25: return "key_8";
        case 0x26: return "key_9";
        case 0x27: return "key_0";
        case 0x28: return "key_enter";
        case 0x29: return "key_escape";
        case 0x2A: return "key_backspace";
        case 0x2B: return "key_tab";
        case 0x2C: return "key_space";
        case 0x4F: return "arrow_right";
        case 0x50: return "arrow_left";
        case 0x51: return "arrow_down";
        case 0x52: return "arrow_up";
        case 0x59: return "numpad_1";
        case 0x5A: return "numpad_2";
        case 0x5B: return "numpad_3";
        case 0x5C: return "numpad_4";
        case 0x5D: return "numpad_5";
        case 0x5E: return "numpad_6";
        case 0x5F: return "numpad_7";
        case 0x60: return "numpad_8";
        case 0x61: return "numpad_9";
        case 0x62: return "numpad_0";
        default:   return nullptr;
    }
}

static void save_paired_devices_to_fs(void) {
    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_AddArrayToObject(root, "paired");
    for (const auto& dev : s_paired_devices) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "name", dev.name.c_str());
        cJSON_AddStringToObject(item, "address", dev.address.c_str());
        cJSON_AddNumberToObject(item, "addr_type", dev.addr_type);
        cJSON_AddItemToArray(arr, item);
    }
    char *out = cJSON_PrintUnformatted(root);
    if (out) {
        FILE *f = fopen(BLE_CONFIG_FILE, "w");
        if (f) {
            fputs(out, f);
            fclose(f);
            ESP_LOGI(TAG, "Saved %d paired BLE device(s)", (int)s_paired_devices.size());
        }
        free(out);
    }
    cJSON_Delete(root);
}

static void load_paired_devices_from_fs(void) {
    FILE *f = fopen(BLE_CONFIG_FILE, "r");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) {
        fclose(f);
        return;
    }

    char *buf = (char*)malloc(sz + 1);
    if (!buf) {
        fclose(f);
        return;
    }

    size_t read_bytes = fread(buf, 1, sz, f);
    buf[read_bytes] = '\0';
    fclose(f);

    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (!root) return;

    cJSON *arr = cJSON_GetObjectItem(root, "paired");
    if (cJSON_IsArray(arr)) {
        s_paired_devices.clear();
        int count = cJSON_GetArraySize(arr);
        for (int i = 0; i < count; i++) {
            cJSON *item = cJSON_GetArrayItem(arr, i);
            cJSON *name_item = cJSON_GetObjectItem(item, "name");
            cJSON *addr_item = cJSON_GetObjectItem(item, "address");
            cJSON *type_item = cJSON_GetObjectItem(item, "addr_type");
            if (addr_item && cJSON_IsString(addr_item)) {
                BleDeviceInfo dev;
                dev.address = addr_item->valuestring;
                dev.name = (name_item && cJSON_IsString(name_item)) ? name_item->valuestring : "BLE Controller";
                dev.addr_type = (type_item && cJSON_IsNumber(type_item)) ? type_item->valueint : 1; // Default to BLE_ADDR_RANDOM (1)
                dev.bonded = true;
                dev.connected = false;
                s_paired_devices.push_back(dev);
            }
        }
        ESP_LOGI(TAG, "Loaded %d paired BLE device(s) from storage", (int)s_paired_devices.size());
    }
    cJSON_Delete(root);
}

static void dispatch_button_event(const BleButtonEvent& evt) {
    ESP_LOGI(TAG, "BLE Button Event: %s (%s) from '%s' [%s]",
             evt.button_name.c_str(), evt.action.c_str(), evt.device_name.c_str(), evt.device_address.c_str());

    // 1. Notify internal callbacks
    for (const auto& cb : s_event_callbacks) {
        if (cb) cb(evt);
    }

    // 2. Trigger CAN Do automation rules
    can_engine_trigger_ble_event(evt);

    // 3. Publish to Home Assistant via MQTT
    mqtt_mgr_publish_ble_event(evt);

    // 4. Broadcast live to Web Dashboard via WebSocket
    char ws_buf[256];
    snprintf(ws_buf, sizeof(ws_buf),
             "{\"type\":\"ble_event\",\"device\":\"%s\",\"address\":\"%s\",\"button\":\"%s\",\"action\":\"%s\",\"keycode\":%d,\"ts\":%lu}",
             evt.device_name.c_str(), evt.device_address.c_str(), evt.button_name.c_str(),
             evt.action.c_str(), (int)evt.key_code, (unsigned long)evt.timestamp_ms);
    broadcast_ws_raw(ws_buf);
}

static void ble_mgr_on_reset(int reason) {
    ESP_LOGE(TAG, "NimBLE host reset, reason: %d", reason);
}

static void ble_mgr_on_sync(void) {
    ESP_LOGI(TAG, "NimBLE host synced");
}

static void ble_mgr_host_task(void *param) {
    ESP_LOGI(TAG, "NimBLE host task started");
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static esp_err_t ble_mgr_start_stack(void) {
    if (s_ble_enabled) return ESP_OK;

    ESP_LOGI(TAG, "Starting Native BLE HID Controller stack... (free heap: %lu bytes)",
             (unsigned long)esp_get_free_heap_size());

    esp_err_t ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize NimBLE port: %d", ret);
        return ret;
    }

    ble_hs_cfg.reset_cb = ble_mgr_on_reset;
    ble_hs_cfg.sync_cb = ble_mgr_on_sync;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;

    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 0;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

    nimble_port_freertos_init(ble_mgr_host_task);

    s_ble_enabled = true;
    ESP_LOGI(TAG, "BLE HID Controller initialized successfully");
    return ESP_OK;
}

esp_err_t ble_mgr_init(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (s_ble_enabled) return ESP_OK;

    load_paired_devices_from_fs();
    if (s_paired_devices.empty()) {
        ESP_LOGI(TAG, "No paired BLE devices configured. Keeping BLE stack dormant to reclaim ~70KB RAM for Web & Wi-Fi.");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Found %d paired BLE device(s). Initializing BLE stack...", (int)s_paired_devices.size());
    return ble_mgr_start_stack();
}

bool ble_mgr_is_enabled(void) {
    return s_ble_enabled;
}

bool ble_mgr_is_scanning(void) {
    if (!s_ble_scanning) return false;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    if (now_ms - s_scan_start_ms >= s_scan_duration_ms) {
        s_ble_scanning = false;
    }
    return s_ble_scanning;
}

static int ble_mgr_gap_event(struct ble_gap_event *event, void *arg);

static void parse_adv_data(const uint8_t *data, uint8_t length, std::string &name) {
    uint8_t index = 0;
    while (index < length) {
        uint8_t field_len = data[index];
        if (field_len == 0 || index + 1 + field_len > length) break;
        uint8_t field_type = data[index + 1];
        if (field_type == 0x08 || field_type == 0x09 || field_type == BLE_HS_ADV_TYPE_COMP_NAME || field_type == BLE_HS_ADV_TYPE_INCOMP_NAME) {
            if (field_len > 1) {
                name.assign((const char *)&data[index + 2], field_len - 1);
                size_t end = name.find_last_not_of("\0 \n\r\t");
                if (end != std::string::npos) {
                    name = name.substr(0, end + 1);
                } else {
                    name.clear();
                }
            }
        }
        index += field_len + 1;
    }
}

esp_err_t ble_mgr_start_scan(uint32_t duration_sec) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (!s_ble_enabled) {
        esp_err_t start_ret = ble_mgr_start_stack();
        if (start_ret != ESP_OK) return start_ret;
    }

    // Guard against scanning when heap is critically low — BLE scan itself allocates
    // internal buffers and a busy RF environment can add dozens of discovered entries.
    uint32_t free_heap = esp_get_free_heap_size();
    ESP_LOGI(TAG, "BLE scan requested — free heap: %lu bytes", (unsigned long)free_heap);
    if (free_heap < 20000) {
        ESP_LOGW(TAG, "Low heap (%lu bytes) — refusing BLE scan to prevent crash", (unsigned long)free_heap);
        return ESP_ERR_NO_MEM;
    }

    s_discovered_devices.clear();
    s_ble_scanning = true;
    s_scan_start_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    s_scan_duration_ms = duration_sec * 1000;

    struct ble_gap_disc_params disc_params;
    memset(&disc_params, 0, sizeof(disc_params));
    disc_params.filter_duplicates = 1;
    disc_params.passive = 0; // Active scan to get scan responses (device names)
    disc_params.itvl = 0;
    disc_params.window = 0;
    disc_params.filter_policy = 0;
    disc_params.limited = 0;

    uint8_t own_addr_type;
    int rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "Failed to infer own address type; rc=%d", rc);
        s_ble_scanning = false;
        return ESP_FAIL;
    }

    rc = ble_gap_disc(own_addr_type, duration_sec * 1000, &disc_params, ble_mgr_gap_event, nullptr);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error initiating GAP discovery procedure; rc=%d", rc);
        s_ble_scanning = false;
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Started BLE HID discovery scan (timeout: %lu sec)", (unsigned long)duration_sec);
    return ESP_OK;
}

esp_err_t ble_mgr_stop_scan(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (s_ble_scanning) {
        ble_gap_disc_cancel();
        s_ble_scanning = false;
        ESP_LOGI(TAG, "Stopped BLE HID discovery scan");
    }
    return ESP_OK;
}

static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;

static int parse_mac_address(const std::string& address, uint8_t* addr_val) {
    int v[6];
    if (sscanf(address.c_str(), "%x:%x:%x:%x:%x:%x",
               &v[5], &v[4], &v[3], &v[2], &v[1], &v[0]) == 6) {
        for (int i = 0; i < 6; i++) {
            addr_val[i] = (uint8_t)v[i];
        }
        return 0;
    }
    return -1;
}

esp_err_t ble_mgr_connect(const std::string& address) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (!s_ble_enabled) {
        esp_err_t start_ret = ble_mgr_start_stack();
        if (start_ret != ESP_OK) return start_ret;
    }

    ble_addr_t peer_addr;
    peer_addr.type = BLE_ADDR_RANDOM; // Default to random as it is most common for HID devices

    std::string dev_name = "BLE Controller";

    // Check discovered devices for the correct address type
    bool found_type = false;
    for (auto& dev : s_discovered_devices) {
        if (dev.address == address) {
            dev_name = dev.name;
            peer_addr.type = dev.addr_type;
            found_type = true;
            break;
        }
    }

    if (!found_type) {
        for (auto& dev : s_paired_devices) {
            if (dev.address == address) {
                dev_name = dev.name;
                peer_addr.type = dev.addr_type;
                break;
            }
        }
    }

    if (parse_mac_address(address, peer_addr.val) != 0) {
        ESP_LOGE(TAG, "Invalid MAC address format: %s", address.c_str());
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t own_addr_type;
    int rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "Failed to infer own address type; rc=%d", rc);
        return ESP_FAIL;
    }

    rc = ble_gap_connect(own_addr_type, &peer_addr, 30000, nullptr, ble_mgr_gap_event, nullptr);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error initiating GAP connect procedure; rc=%d", rc);
        return ESP_FAIL;
    }

    s_connected_device.address = address;
    s_connected_device.name = dev_name;
    s_connected_device.addr_type = peer_addr.type;

    ESP_LOGI(TAG, "Initiated connection to BLE Device '%s' [%s]", dev_name.c_str(), address.c_str());
    return ESP_OK;
}

static std::unordered_map<uint16_t, std::string> s_report_map; // maps chr_val_handle -> "keyboard" or "consumer"

static int ble_mgr_on_report_ref_read(uint16_t conn_handle, const struct ble_gatt_error *error,
                                      struct ble_gatt_attr *attr, void *arg) {
    if (error->status == 0 && attr && attr->om) {
        uint16_t chr_val_handle = (uint16_t)(uintptr_t)arg;
        uint8_t data[2] = {0};
        uint16_t len = OS_MBUF_PKTLEN(attr->om);
        if (len > 2) len = 2;
        os_mbuf_copydata(attr->om, 0, len, data);

        if (len == 2) {
            uint8_t report_id = data[0];
            uint8_t report_type = data[1]; // 1 = Input
            if (report_type == 1) {
                // If ID is 1 or we map it somehow. Usually Keyboard is 1, Consumer is 2/3.
                // For safety we can still rely partially on the ID or heuristics later, but let's store it.
                if (report_id == 1) {
                    s_report_map[chr_val_handle] = "keyboard";
                } else {
                    s_report_map[chr_val_handle] = "consumer";
                }
                ESP_LOGI(TAG, "Mapped handle %d to Report ID %d", chr_val_handle, report_id);
            }
        }
    }
    return 0;
}

static int ble_mgr_on_dsc_disc(uint16_t conn_handle, const struct ble_gatt_error *error,
                               uint16_t chr_val_handle, const struct ble_gatt_dsc *dsc, void *arg) {
    if (error->status == 0 && dsc) {
        if (ble_uuid_u16(&dsc->uuid.u) == 0x2902) { // CCCD UUID
            ESP_LOGI(TAG, "Found CCCD descriptor at handle %d for char %d", dsc->handle, chr_val_handle);
            uint8_t value[2] = {1, 0}; // Enable notifications
            ble_gattc_write_flat(conn_handle, dsc->handle, value, sizeof(value), nullptr, nullptr);
        } else if (ble_uuid_u16(&dsc->uuid.u) == 0x2908) { // Report Reference UUID
            ble_gattc_read(conn_handle, dsc->handle, ble_mgr_on_report_ref_read, (void*)(uintptr_t)chr_val_handle);
        }
    }
    return 0;
}

static int ble_mgr_on_chr_disc(uint16_t conn_handle, const struct ble_gatt_error *error,
                               const struct ble_gatt_chr *chr, void *arg) {
    if (error->status == 0 && chr) {
        uint16_t end_handle = (uint16_t)(uintptr_t)arg;
        if (ble_uuid_u16(&chr->uuid.u) == 0x2A4D) { // HID Report UUID
            ESP_LOGI(TAG, "Found HID Report Characteristic at handle %d", chr->val_handle);
            ble_gattc_disc_all_dscs(conn_handle, chr->val_handle, end_handle, ble_mgr_on_dsc_disc, nullptr);
        }
    }
    return 0;
}

static int ble_mgr_on_svc_disc(uint16_t conn_handle, const struct ble_gatt_error *error,
                               const struct ble_gatt_svc *service, void *arg) {
    if (error->status == 0 && service) {
        if (ble_uuid_u16(&service->uuid.u) == 0x1812) { // HID Service UUID
            ESP_LOGI(TAG, "Found HID Service from %d to %d", service->start_handle, service->end_handle);
            ble_gattc_disc_all_chrs(conn_handle, service->start_handle, service->end_handle, ble_mgr_on_chr_disc, (void*)(uintptr_t)service->end_handle);
        }
    }
    return 0;
}

static int ble_mgr_gap_event(struct ble_gap_event *event, void *arg) {
    std::string ws_msg_to_send;
    std::string notify_addr, notify_name;
    uint8_t notify_data[64];
    uint16_t notify_len = 0;
    bool is_keyboard_notify = false;
    bool is_consumer_notify = false;

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        switch (event->type) {
        case BLE_GAP_EVENT_DISC: {
            char addr_str[18];
            sprintf(addr_str, "%02X:%02X:%02X:%02X:%02X:%02X",
                    event->disc.addr.val[5], event->disc.addr.val[4], event->disc.addr.val[3],
                    event->disc.addr.val[2], event->disc.addr.val[1], event->disc.addr.val[0]);

            std::string name;
            parse_adv_data(event->disc.data, event->disc.length_data, name);

            // Try to update existing
            bool found = false;
            for (auto& dev : s_discovered_devices) {
                if (dev.address == addr_str) {
                    dev.rssi = event->disc.rssi;
                    if (!name.empty() && dev.name.empty()) {
                        dev.name = name;
                    }
                    found = true;
                    break;
                }
            }

            // Add new device (cap at 40 to prevent heap exhaustion in busy RF environments)
            if (!found && s_discovered_devices.size() < 40) {
                BleDeviceInfo dev;
                dev.address = addr_str;
                if (name.empty()) {
                    dev.name = std::string("BLE Device [") + (addr_str + 9) + "]";
                } else {
                    dev.name = name;
                }
                dev.rssi = event->disc.rssi;
                dev.addr_type = event->disc.addr.type;
                s_discovered_devices.push_back(dev);
            }
            break;
        }
        case BLE_GAP_EVENT_DISC_COMPLETE:
            s_ble_scanning = false;
            ESP_LOGI(TAG, "Discovery complete");
            break;

        case BLE_GAP_EVENT_CONNECT: {
            if (event->connect.status == 0) {
                ESP_LOGI(TAG, "Connection established");
                s_conn_handle = event->connect.conn_handle;

                s_connected_device.connected = true;
                s_connected_device.rssi = -60;
                s_has_connected_device = true;

                // Initiate security. GATT discovery must wait until the link is encrypted.
                int rc = ble_gap_security_initiate(event->connect.conn_handle);
                if (rc != 0) {
                    ESP_LOGE(TAG, "Failed to initiate security; rc=%d", rc);
                    ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
                }
            } else {
                ESP_LOGE(TAG, "Connection failed; status=%d", event->connect.status);
                s_has_connected_device = false;
            }
            break;
        }

        case BLE_GAP_EVENT_ENC_CHANGE: {
            if (event->enc_change.status == 0) {
                ESP_LOGI(TAG, "Connection encrypted, initiating GATT service discovery");
                s_connected_device.bonded = true;

                bool already_paired = false;
                for (auto& dev : s_paired_devices) {
                    if (dev.address == s_connected_device.address) {
                        dev.connected = true;
                        already_paired = true;
                        break;
                    }
                }
                if (!already_paired) {
                    s_paired_devices.push_back(s_connected_device);
                }
                save_paired_devices_to_fs();

                char ws_buf[256];
                snprintf(ws_buf, sizeof(ws_buf),
                         "{\"type\":\"ble_status\",\"connected\":true,\"device\":\"%s\",\"address\":\"%s\",\"rssi\":-60,\"battery\":95}",
                         s_connected_device.name.c_str(), s_connected_device.address.c_str());
                ws_msg_to_send = ws_buf;

                ble_gattc_disc_all_svcs(s_conn_handle, ble_mgr_on_svc_disc, nullptr);
            } else {
                ESP_LOGE(TAG, "Encryption failed; status=%d", event->enc_change.status);
                ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            }
            break;
        }

        case BLE_GAP_EVENT_DISCONNECT: {
            ESP_LOGI(TAG, "Disconnect; reason=%d", event->disconnect.reason);
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            if (s_has_connected_device) {
                std::string disc_addr = s_connected_device.address;
                std::string disc_name = s_connected_device.name;

                s_connected_device.connected = false;
                s_has_connected_device = false;

                for (auto& dev : s_paired_devices) {
                    if (dev.address == disc_addr) {
                        dev.connected = false;
                    }
                }

                char ws_buf[256];
                snprintf(ws_buf, sizeof(ws_buf),
                         "{\"type\":\"ble_status\",\"connected\":false,\"device\":\"%s\",\"address\":\"%s\"}",
                         disc_name.c_str(), disc_addr.c_str());
                ws_msg_to_send = ws_buf;
            }
            break;
        }

        case BLE_GAP_EVENT_NOTIFY_RX: {
            struct os_mbuf *om = event->notify_rx.om;
            notify_len = OS_MBUF_PKTLEN(om);
            if (notify_len > sizeof(notify_data)) notify_len = sizeof(notify_data);
            os_mbuf_copydata(om, 0, notify_len, notify_data);

            notify_addr = s_connected_device.address;
            notify_name = s_connected_device.name;

            uint16_t attr_handle = event->notify_rx.attr_handle;
            if (s_report_map.count(attr_handle)) {
                if (s_report_map[attr_handle] == "keyboard") {
                    is_keyboard_notify = true;
                } else if (s_report_map[attr_handle] == "consumer") {
                    is_consumer_notify = true;
                }
            } else {
                // Fallback heuristic if descriptor hasn't been read yet
                if (notify_len >= 8) {
                    is_keyboard_notify = true;
                } else if (notify_len >= 2) {
                    is_consumer_notify = true;
                }
            }
            break;
        }
        }
    }

    if (!ws_msg_to_send.empty()) {
        broadcast_ws_raw(ws_msg_to_send);
    }

    if (is_keyboard_notify) {
        ble_mgr_handle_keyboard_report(notify_data, notify_len, notify_addr, notify_name);
    } else if (is_consumer_notify) {
        ble_mgr_handle_consumer_report(notify_data, notify_len, notify_addr, notify_name);
    }

    return 0;
}

esp_err_t ble_mgr_disconnect(const std::string& address) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (!s_has_connected_device || s_conn_handle == BLE_HS_CONN_HANDLE_NONE) return ESP_OK;

    int rc = ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    if (rc != 0) {
        ESP_LOGE(TAG, "Failed to terminate connection; rc=%d", rc);
        return ESP_FAIL;
    }

    // UI state updates will happen in BLE_GAP_EVENT_DISCONNECT
    ESP_LOGI(TAG, "Disconnect requested for BLE Device [%s]", address.c_str());
    return ESP_OK;
}

esp_err_t ble_mgr_unpair(const std::string& address) {
    // Cannot lock mutex here because ble_mgr_disconnect locks it as well.
    ble_mgr_disconnect(address);

    ble_addr_t peer_addr;
    bool found = false;

    std::unique_lock<std::mutex> lock(s_ble_mutex);
    auto it = std::remove_if(s_paired_devices.begin(), s_paired_devices.end(),
                             [&](const BleDeviceInfo& d) {
                                 if (address.empty() || d.address == address) {
                                     if (!found) {
                                         parse_mac_address(d.address, peer_addr.val);
                                         peer_addr.type = d.addr_type;
                                         found = true;
                                     }
                                     return true;
                                 }
                                 return false;
                             });

    if (it != s_paired_devices.end()) {
        s_paired_devices.erase(it, s_paired_devices.end());
        save_paired_devices_to_fs();
    }
    lock.unlock();

    if (found) {
        int rc = ble_store_util_delete_peer(&peer_addr);
        if (rc != 0) {
            ESP_LOGW(TAG, "Failed to delete peer from NimBLE store; rc=%d", rc);
        }
    }

    ESP_LOGI(TAG, "Unpaired BLE device [%s]", address.c_str());
    return ESP_OK;
}

std::vector<BleDeviceInfo> ble_mgr_get_discovered_devices(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    return s_discovered_devices;
}

std::vector<BleDeviceInfo> ble_mgr_get_paired_devices(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    return s_paired_devices;
}

bool ble_mgr_get_connected_device(BleDeviceInfo* out_dev) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (s_has_connected_device && out_dev) {
        *out_dev = s_connected_device;
        return true;
    }
    return false;
}

void ble_mgr_register_event_cb(BleButtonCallback cb) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    s_event_callbacks.push_back(cb);
}

void ble_mgr_test_inject_event(const std::string& button_name, const std::string& action, uint8_t key_code) {
    BleButtonEvent evt;
    evt.button_name = button_name;
    evt.action = action;
    evt.key_code = key_code;
    evt.timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    if (s_has_connected_device) {
        evt.device_name = s_connected_device.name;
        evt.device_address = s_connected_device.address;
    } else {
        evt.device_name = "Virtual Controller (Test)";
        evt.device_address = "AA:BB:CC:11:22:33";
    }

    dispatch_button_event(evt);
}

// Native HID Report Parsers
void ble_mgr_handle_consumer_report(const uint8_t* data, size_t len, const std::string& addr, const std::string& name) {
    if (!data || len < 2) return;
    uint16_t code = data[0] | (data[1] << 8);

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    if (code != 0) {
        // Button Pressed
        const char* bname = ble_hid_consumer_code_to_name(code);
        char hex_code[16];
        if (!bname) {
            snprintf(hex_code, sizeof(hex_code), "consumer_0x%04X", code);
            bname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = bname;
        evt.action = "press";
        evt.key_code = (uint8_t)(code & 0xFF);
        evt.timestamp_ms = now_ms;
        s_last_consumer_code = code;
        dispatch_button_event(evt);
    } else if (s_last_consumer_code != 0) {
        // Button Released
        const char* bname = ble_hid_consumer_code_to_name(s_last_consumer_code);
        char hex_code[16];
        if (!bname) {
            snprintf(hex_code, sizeof(hex_code), "consumer_0x%04X", s_last_consumer_code);
            bname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = bname;
        evt.action = "release";
        evt.key_code = (uint8_t)(s_last_consumer_code & 0xFF);
        evt.timestamp_ms = now_ms;
        s_last_consumer_code = 0;
        dispatch_button_event(evt);
    }
}

void ble_mgr_handle_keyboard_report(const uint8_t* data, size_t len, const std::string& addr, const std::string& name) {
    // Standard HID keyboard report: [modifiers, reserved, key1, key2, key3, key4, key5, key6]
    if (!data || len < 3) return;

    uint8_t modifiers = data[0];
    uint8_t key = data[2]; // primary keycode
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    if (key != 0) {
        const char* kname = ble_hid_keyboard_code_to_name(key);
        char hex_code[16];
        if (!kname) {
            snprintf(hex_code, sizeof(hex_code), "key_0x%02X", key);
            kname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = kname;
        evt.action = "press";
        evt.key_code = key;
        evt.modifiers = modifiers;
        evt.timestamp_ms = now_ms;
        s_last_keycode = key;
        dispatch_button_event(evt);
    } else if (s_last_keycode != 0) {
        const char* kname = ble_hid_keyboard_code_to_name(s_last_keycode);
        char hex_code[16];
        if (!kname) {
            snprintf(hex_code, sizeof(hex_code), "key_0x%02X", s_last_keycode);
            kname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = kname;
        evt.action = "release";
        evt.key_code = s_last_keycode;
        evt.modifiers = modifiers;
        evt.timestamp_ms = now_ms;
        s_last_keycode = 0;
        dispatch_button_event(evt);
    }
}
