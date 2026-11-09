#include "serial_cli.h"
#include "network_mgr.h"
#include "can_engine.h"
#include "ble_mgr.h"
#include "mcp2518fd.h"
#include "cJSON.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>

extern std::string g_device_id;

static std::vector<std::string> tokenize(const std::string& input) {
    std::vector<std::string> tokens;
    std::string current;
    bool in_quotes = false;

    for (size_t i = 0; i < input.size(); i++) {
        char c = input[i];
        if (c == '"') {
            in_quotes = !in_quotes;
        } else if (!in_quotes && (c == ' ' || c == '\t')) {
            if (!current.empty()) {
                tokens.push_back(current);
                current.clear();
            }
        } else {
            current += c;
        }
    }
    if (!current.empty()) {
        tokens.push_back(current);
    }
    return tokens;
}

static void print_banner(void) {
    printf("\r\n============================= CAN Do Serial CLI =============================\r\n");
    printf("  wifi \"<ssid>\" \"<pass>\" [prio] : Save Wi-Fi credentials & connect\r\n");
    printf("  wifi status                   : Show Wi-Fi, IP, and SoftAP status\r\n");
    printf("  wifi scan                     : Scan 2.4GHz channels and list networks\r\n");
    printf("  wifi clear                    : Clear all saved Wi-Fi networks\r\n");
    printf("  wifi delete \"<ssid>\"          : Delete a saved Wi-Fi network\r\n");
    printf("  wifi ap \"<ssid>\" \"<pass>\"     : Change SoftAP SSID and password\r\n");
    printf("  status                        : Full system status (CAN, Heap, Net)\r\n");
    printf("  can status                    : Show dual-CAN MCP2518FD status\r\n");
    printf("  ble scan                      : Start BLE discovery scan (10s)\r\n");
    printf("  ble status                    : Show BLE central/observer status\r\n");
    printf("  reboot                        : Restart the ESP32-S3\r\n");
    printf("  {...}                         : JSON command (e.g. {\"type\":\"wifi_save\"})\r\n");
    printf("=============================================================================\r\n\r\n");
}

void serial_cli_init(void) {
    printf("\r\n[CLI] CAN Do Serial Console ready. Type 'help' or 'status' for commands.\r\n");
}

void serial_cli_process_line(const char* raw_line, size_t len) {
    if (!raw_line || len == 0) return;

    // Strip leading / trailing whitespace
    size_t start = 0;
    while (start < len && (raw_line[start] == ' ' || raw_line[start] == '\t' || raw_line[start] == '\r' || raw_line[start] == '\n')) {
        start++;
    }
    size_t end = len;
    while (end > start && (raw_line[end - 1] == ' ' || raw_line[end - 1] == '\t' || raw_line[end - 1] == '\r' || raw_line[end - 1] == '\n')) {
        end--;
    }
    if (start >= end) return;

    std::string line(raw_line + start, end - start);

    // 1. JSON Fast-Path
    if (line.front() == '{') {
        cJSON* root = cJSON_Parse(line.c_str());
        if (root) {
            cJSON* type = cJSON_GetObjectItem(root, "type");
            cJSON* ssid = cJSON_GetObjectItem(root, "ssid");
            cJSON* pass = cJSON_GetObjectItem(root, "password");
            cJSON* prio = cJSON_GetObjectItem(root, "priority");

            const char* type_str = (type && cJSON_IsString(type)) ? type->valuestring : "";

            if (strcmp(type_str, "wifi_save") == 0 || (ssid && cJSON_IsString(ssid))) {
                std::string s = (ssid && cJSON_IsString(ssid)) ? ssid->valuestring : "";
                std::string p = (pass && cJSON_IsString(pass)) ? pass->valuestring : "";
                int pr = (prio && cJSON_IsNumber(prio)) ? prio->valueint : 100;
                if (!s.empty()) {
                    network_mgr_add_known_network(s, p, pr);
                    printf("{\"type\":\"ack\",\"status\":\"wifi_saved\",\"ssid\":\"%s\",\"priority\":%d}\r\n", s.c_str(), pr);
                } else {
                    printf("{\"type\":\"nack\",\"error\":\"empty_ssid\"}\r\n");
                }
            } else if (strcmp(type_str, "wifi_delete") == 0) {
                if (ssid && cJSON_IsString(ssid)) {
                    bool ok = network_mgr_remove_known_network(ssid->valuestring);
                    printf("{\"type\":\"ack\",\"status\":\"wifi_deleted\",\"result\":%s}\r\n", ok ? "true" : "false");
                }
            } else if (strcmp(type_str, "ping") == 0) {
                printf("{\"type\":\"pong\"}\r\n");
            } else if (strcmp(type_str, "lock") == 0 || strcmp(type_str, "unlock") == 0) {
                bool is_lock = (strcmp(type_str, "lock") == 0);
                bool ok = queue_entity_command("door_locks", is_lock ? "lock" : "unlock");
                if (!ok) ok = queue_entity_command("doors_lock_state", is_lock ? "lock" : "unlock");
                printf(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}\r\n" : "{\"type\":\"nack\",\"error\":\"lock_failed\"}\r\n");
            } else {
                printf("{\"type\":\"ack\",\"received\":\"json\"}\r\n");
            }
            cJSON_Delete(root);
        } else {
            printf("{\"type\":\"nack\",\"error\":\"invalid_json\"}\r\n");
        }
        return;
    }

    // 2. Tokenized CLI Command
    std::vector<std::string> tokens = tokenize(line);
    if (tokens.empty()) return;

    std::string cmd = tokens[0];
    std::transform(cmd.begin(), cmd.end(), cmd.begin(), ::tolower);

    if (cmd == "help" || cmd == "?") {
        print_banner();
    } else if (cmd == "reboot" || cmd == "restart") {
        printf("[SYS] Rebooting ESP32-S3 now...\r\n");
        vTaskDelay(pdMS_TO_TICKS(150));
        esp_restart();
    } else if (cmd == "status") {
        int64_t uptime_sec = esp_timer_get_time() / 1000000;
        uint32_t free_heap = esp_get_free_heap_size();
        uint32_t free_internal = esp_get_free_internal_heap_size();
        NetworkStatusInfo net = network_mgr_get_status();
        printf("\r\n==================== CAN Do System Status ====================\r\n");
        printf("  Device ID    : %s\r\n", g_device_id.c_str());
        printf("  Uptime       : %llds (%lldm %llds)\r\n", uptime_sec, uptime_sec / 60, uptime_sec % 60);
        printf("  Free Heap    : %lu bytes (Internal: %lu bytes)\r\n", (unsigned long)free_heap, (unsigned long)free_internal);
        printf("  Wi-Fi STA    : %s\r\n", net.sta_connected ? (net.sta_ssid + " (" + net.sta_ip + ", " + std::to_string(net.sta_rssi) + " dBm)").c_str() : "Disconnected");
        printf("  Wi-Fi SoftAP : %s\r\n", net.ap_active ? (net.ap_ssid + " (192.168.4.1, Clients: " + std::to_string(net.ap_clients) + ")").c_str() : "Inactive");
#if CONFIG_IDF_TARGET_ESP32S3
        printf("  Dual CAN 0   : %s (Standard CAN 500k)\r\n", dual_can_is_available(CAN_BUS_0) ? "ONLINE" : "OFFLINE");
        printf("  Dual CAN 1   : %s (CAN FD 500k/2M)\r\n", dual_can_is_available(CAN_BUS_1) ? "ONLINE" : "OFFLINE");
        printf("  BLE Engine   : %s\r\n", ble_mgr_is_enabled() ? "ACTIVE (NimBLE Central + Observer)" : "DISABLED");
#endif
        printf("==============================================================\r\n\r\n");
    } else if (cmd == "can") {
        printf("\r\n--- CAN Subsystem Status ---\r\n");
#if CONFIG_IDF_TARGET_ESP32S3
        mcp2518fd_t* dev0 = dual_can_get_device(CAN_BUS_0);
        mcp2518fd_t* dev1 = dual_can_get_device(CAN_BUS_1);
        printf("  CAN 0 (Classic 500k) : %s\r\n", (dev0 && dev0->initialized) ? "INITIALIZED (MCP2518FD)" : "NOT DETECTED");
        if (dev0 && dev0->initialized) {
            uint8_t tec = 0, rec = 0; bool bo = false;
            mcp2518fd_get_error_counts(dev0, &tec, &rec, &bo);
            printf("    TEC: %u, REC: %u, Bus-Off: %s, TX Fail: %lu, RX Overflow: %lu\r\n",
                   tec, rec, bo ? "YES" : "NO", (unsigned long)dev0->tx_fail_count, (unsigned long)dev0->rx_overflow_count);
        }
        printf("  CAN 1 (CAN FD 500k/2M): %s\r\n", (dev1 && dev1->initialized) ? "INITIALIZED (MCP2518FD)" : "NOT DETECTED");
        if (dev1 && dev1->initialized) {
            uint8_t tec = 0, rec = 0; bool bo = false;
            mcp2518fd_get_error_counts(dev1, &tec, &rec, &bo);
            printf("    TEC: %u, REC: %u, Bus-Off: %s, TX Fail: %lu, RX Overflow: %lu\r\n",
                   tec, rec, bo ? "YES" : "NO", (unsigned long)dev1->tx_fail_count, (unsigned long)dev1->rx_overflow_count);
        }
#else
        printf("  On-chip TWAI CAN active.\r\n");
#endif
        printf("----------------------------\r\n\r\n");
    } else if (cmd == "ble") {
        if (tokens.size() > 1 && tokens[1] == "scan") {
            printf("[BLE] Starting 10-second BLE discovery scan...\r\n");
            ble_mgr_start_scan(10);
        } else {
            printf("[BLE] Status:\r\n%s\r\n", ble_mgr_get_status_json().c_str());
        }
    } else if (cmd == "wifi") {
        if (tokens.size() == 1) {
            printf("[WIFI] Usage: wifi \"<SSID>\" \"<PASSWORD>\" [priority]\r\n");
            printf("              wifi status | wifi scan | wifi clear | wifi delete \"<SSID>\"\r\n");
            return;
        }

        std::string sub = tokens[1];
        std::transform(sub.begin(), sub.end(), sub.begin(), ::tolower);

        if (sub == "status") {
            NetworkStatusInfo st = network_mgr_get_status();
            printf("\r\n--- Wi-Fi Status ---\r\n");
            printf("  STA State     : %s\r\n", st.sta_connected ? "CONNECTED" : "DISCONNECTED");
            if (st.sta_connected) {
                printf("  STA SSID      : %s\r\n", st.sta_ssid.c_str());
                printf("  STA IP        : %s\r\n", st.sta_ip.c_str());
                printf("  STA Gateway   : %s\r\n", st.sta_gw.c_str());
                printf("  STA Netmask   : %s\r\n", st.sta_mask.c_str());
                printf("  STA Signal    : %d dBm\r\n", (int)st.sta_rssi);
            }
            printf("  SoftAP State  : %s\r\n", st.ap_active ? "ACTIVE" : "INACTIVE");
            if (st.ap_active) {
                printf("  SoftAP SSID   : %s\r\n", st.ap_ssid.c_str());
                printf("  SoftAP IP     : %s\r\n", st.ap_ip.c_str());
                printf("  SoftAP Pass   : candorules (default)\r\n");
                printf("  SoftAP Clients: %d\r\n", st.ap_clients);
            }
            auto known = network_mgr_get_known_networks();
            printf("  Known Networks (%d):\r\n", (int)known.size());
            for (size_t i = 0; i < known.size(); i++) {
                printf("    [%u] '%s' (Priority: %d)\r\n", (unsigned)(i + 1), known[i].ssid.c_str(), known[i].priority);
            }
            printf("--------------------\r\n\r\n");
        } else if (sub == "scan") {
            printf("[WIFI] Starting 2.4GHz Wi-Fi scan...\r\n");
            wifi_scan_config_t scan_cfg = {};
            scan_cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
            esp_err_t err = esp_wifi_scan_start(&scan_cfg, true);
            if (err == ESP_OK) {
                uint16_t ap_count = 0;
                esp_wifi_scan_get_ap_num(&ap_count);
                if (ap_count > 32) ap_count = 32;
                std::vector<wifi_ap_record_t> records(ap_count);
                if (ap_count > 0 && esp_wifi_scan_get_ap_records(&ap_count, records.data()) == ESP_OK) {
                    printf("[WIFI] Found %u networks:\r\n", (unsigned)ap_count);
                    for (uint16_t i = 0; i < ap_count; i++) {
                        char clean_ssid[33] = {0};
                        memcpy(clean_ssid, records[i].ssid, 32);
                        const char* auth_str = "OPEN";
                        switch (records[i].authmode) {
                            case WIFI_AUTH_WEP: auth_str = "WEP"; break;
                            case WIFI_AUTH_WPA_PSK: auth_str = "WPA-PSK"; break;
                            case WIFI_AUTH_WPA2_PSK: auth_str = "WPA2-PSK"; break;
                            case WIFI_AUTH_WPA_WPA2_PSK: auth_str = "WPA/WPA2"; break;
                            case WIFI_AUTH_WPA3_PSK: auth_str = "WPA3-PSK"; break;
                            default: break;
                        }
                        printf("  - %-32s | RSSI: %3d dBm | Auth: %s\r\n", clean_ssid, records[i].rssi, auth_str);
                    }
                } else {
                    printf("[WIFI] No networks found.\r\n");
                }
            } else {
                printf("[WIFI] Scan failed (err %d)\r\n", (int)err);
            }
        } else if (sub == "clear") {
            network_mgr_clear_known_networks();
            printf("[WIFI] All known networks cleared. SoftAP active on 192.168.4.1.\r\n");
        } else if (sub == "delete") {
            if (tokens.size() > 2) {
                bool ok = network_mgr_remove_known_network(tokens[2]);
                printf("[WIFI] Network '%s' %s.\r\n", tokens[2].c_str(), ok ? "removed" : "not found");
            } else {
                printf("[WIFI] Usage: wifi delete \"<SSID>\"\r\n");
            }
        } else if (sub == "ap") {
            if (tokens.size() > 2) {
                std::string ap_pass = (tokens.size() > 3) ? tokens[3] : "candorules";
                network_mgr_set_ap_credentials(tokens[2], ap_pass);
                printf("[WIFI] SoftAP credentials set: SSID='%s', Pass='%s'\r\n", tokens[2].c_str(), ap_pass.c_str());
            } else {
                printf("[WIFI] Usage: wifi ap \"<SSID>\" \"<PASSWORD>\"\r\n");
            }
        } else {
            // wifi [add|set] "<ssid>" "<pass>" [prio] OR wifi "<ssid>" "<pass>" [prio]
            size_t arg_idx = 1;
            if (sub == "add" || sub == "set") {
                arg_idx++;
            }
            if (arg_idx < tokens.size()) {
                std::string ssid = tokens[arg_idx++];
                std::string password = (arg_idx < tokens.size()) ? tokens[arg_idx++] : "";
                int priority = 100;
                if (arg_idx < tokens.size()) {
                    priority = atoi(tokens[arg_idx].c_str());
                    if (priority <= 0) priority = 100;
                }
                network_mgr_add_known_network(ssid, password, priority);
                printf("[WIFI] Saved network '%s' (Priority: %d).\r\n", ssid.c_str(), priority);
                printf("[WIFI] Connecting to '%s'...\r\n", ssid.c_str());
            } else {
                printf("[WIFI] Error: SSID required. Usage: wifi \"<SSID>\" \"<PASSWORD>\" [priority]\r\n");
            }
        }
    } else {
        printf("[CLI] Unknown command: '%s'. Type 'help' for available commands.\r\n", cmd.c_str());
    }
}

