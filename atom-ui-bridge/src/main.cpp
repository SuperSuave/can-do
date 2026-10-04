#include <Arduino.h>
#include <WiFi.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <NimBLEDevice.h>
#include <map>
#include <vector>

// ============================================================================
// Hardware Pin Definitions (M5Stack Atom Lite)
// ============================================================================
#define LED_PIN         27      // SK6812 Single RGB LED
#define BUTTON_PIN      39      // Onboard user button (active LOW)
#define GROVE_RX_PIN    26      // Connect to WiCAN IO1 (TX)
#define GROVE_TX_PIN    32      // Connect to WiCAN IO5 (RX)
#define UART_BAUD       921600  // High-speed UART link

CRGB leds[1];

// ============================================================================
// Web Server & WebSocket
// ============================================================================
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// State Cache (mirrors latest states from WiCAN)
std::map<String, String> g_state_cache;
unsigned long g_last_wican_rx_ms = 0;
bool g_wican_online = false;

// ============================================================================
// BLE Subsystem (NimBLE)
// ============================================================================
bool g_ble_scanning = false;
unsigned long g_ble_scan_start_ms = 0;
const unsigned long BLE_SCAN_DURATION_MS = 10000;

struct DiscoveredDevice {
    String address;
    String name;
    int rssi;
    bool is_connectable;
};

std::vector<DiscoveredDevice> g_discovered_devices;
std::vector<String> g_paired_devices;

// Forward Declarations
void set_led_color(CRGB color);
void send_to_wican(const String& line);
void handle_wican_message(const String& line);

// ============================================================================
// NimBLE Scan Callbacks
// ============================================================================
class AdvertisedDeviceCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        String addr = advertisedDevice->getAddress().toString().c_str();
        String name = advertisedDevice->getName().c_str();
        if (name.isEmpty()) name = "Unknown Device";
        int rssi = advertisedDevice->getRSSI();

        // Check if already in scan list
        bool exists = false;
        for (auto& dev : g_discovered_devices) {
            if (dev.address.equalsIgnoreCase(addr)) {
                dev.rssi = rssi;
                exists = true;
                break;
            }
        }
        if (!exists) {
            g_discovered_devices.push_back({addr, name, rssi, true});
        }

        // Check if device is paired and triggered
        for (const auto& paired_addr : g_paired_devices) {
            if (paired_addr.equalsIgnoreCase(addr)) {
                // Button click detected from paired beacon / remote!
                set_led_color(CRGB::Purple);
                Serial.printf("[BLE] Paired button trigger from %s (%s)\n", addr.c_str(), name.c_str());

                // Broadcast to frontend WebSocket
                String event_json = "{\"type\":\"ble_event\",\"address\":\"" + addr + "\",\"name\":\"" + name + "\"}";
                ws.textAll(event_json);

                // Send trigger to WiCAN
                send_to_wican("{\"type\":\"trigger\",\"action\":\"precon_toggle\"}");
                break;
            }
        }
    }
};

// ============================================================================
// Helper Functions
// ============================================================================
void set_led_color(CRGB color) {
    leds[0] = color;
    FastLED.show();
}

void send_to_wican(const String& line) {
    Serial2.print(line);
    if (!line.endsWith("\n")) {
        Serial2.print("\n");
    }
}

void update_led_status() {
    if (!g_wican_online) {
        set_led_color(CRGB::Red);
    } else if (ws.count() > 0) {
        set_led_color(CRGB::Blue); // Web browser client active
    } else {
        set_led_color(CRGB::Green); // Normal idle ready
    }
}

// ============================================================================
// WebSocket Event Handler
// ============================================================================
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WS] Client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
        
        // Dump current cached states to new client
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        for (const auto& pair : g_state_cache) {
            JsonObject item = arr.add<JsonObject>();
            item["entity"] = pair.first;
            item["state"] = pair.second;
        }
        String out;
        serializeJson(doc, out);
        client->text(out);

        // Request fresh state sync from WiCAN
        send_to_wican("{\"type\":\"get_states\"}");
        update_led_status();

    } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WS] Client #%u disconnected\n", client->id());
        update_led_status();

    } else if (type == WS_EVT_DATA) {
        AwsFrameInfo *info = (AwsFrameInfo*)arg;
        if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
            String msg = "";
            for (size_t i = 0; i < len; i++) {
                msg += (char)data[i];
            }
            // Transparently forward client commands to WiCAN
            send_to_wican(msg);
        }
    }
}

// ============================================================================
// Incoming WiCAN Message Handler
// ============================================================================
void handle_wican_message(const String& line) {
    g_last_wican_rx_ms = millis();
    if (!g_wican_online) {
        g_wican_online = true;
        Serial.println("[UART] WiCAN link established!");
        update_led_status();
    }

    // Forward raw JSON directly to connected WebSockets
    if (ws.count() > 0) {
        ws.textAll(line);
    }

    // Inspect for state caching
    if (line.indexOf("\"type\":\"state\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            const char* entity = doc["entity"];
            const char* state = doc["state"];
            if (entity && state) {
                g_state_cache[String(entity)] = String(state);
            }
        }
    } else if (line.indexOf("\"type\":\"states_dump\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            JsonArray arr = doc["data"].as<JsonArray>();
            for (JsonObject item : arr) {
                const char* entity = item["entity"];
                const char* state = item["state"];
                if (entity && state) {
                    g_state_cache[String(entity)] = String(state);
                }
            }
            Serial.printf("[CACHE] Cached %u vehicle states from WiCAN\n", g_state_cache.size());
        }
    }
}

// ============================================================================
// Setup
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("\n==========================================");
    Serial.println("  CAN-Do M5Stack Atom Lite UI & BLE Bridge");
    Serial.println("==========================================");

    // 1. Initialize RGB LED
    FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, 1);
    set_led_color(CRGB::Orange);

    // 2. Button setup
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // 3. Hardware Serial2 link to WiCAN (IO1 -> G26 RX, IO5 -> G32 TX)
    Serial2.begin(UART_BAUD, SERIAL_8N1, GROVE_RX_PIN, GROVE_TX_PIN);
    Serial.printf("[UART] Serial2 initialized at %d baud (RX: %d, TX: %d)\n", UART_BAUD, GROVE_RX_PIN, GROVE_TX_PIN);

    // 4. Mount LittleFS for Frontend SPA assets
    if (!LittleFS.begin(true)) {
        Serial.println("[FS] ERROR: LittleFS mount failed!");
        set_led_color(CRGB::Red);
    } else {
        Serial.printf("[FS] LittleFS mounted successfully. Total: %u KB, Used: %u KB\n",
                      LittleFS.totalBytes() / 1024, LittleFS.usedBytes() / 1024);
    }

    // 5. Initialize Wi-Fi Access Point (CAN-Do / 192.168.4.1)
    WiFi.mode(WIFI_AP);
    WiFi.softAP("CAN-Do", "");
    IPAddress apIP(192, 168, 4, 1);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
    Serial.printf("[WIFI] Access Point 'CAN-Do' active at IP: %s\n", WiFi.softAPIP().toString().c_str());

    // 6. Setup NimBLE
    NimBLEDevice::init("CAN-Do-Bridge");
    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(new AdvertisedDeviceCallbacks(), false);
    pScan->setActiveScan(true);
    pScan->setInterval(97);
    pScan->setWindow(67);
    pScan->setMaxResults(0); // Do not store in internal cache, handled in callback

    // 7. Configure Web Server Routes
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "*");

    ws.onEvent(onWsEvent);
    server.addHandler(&ws);

    // REST: GET /api/states
    server.on("/api/states", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        for (const auto& pair : g_state_cache) {
            JsonObject item = arr.add<JsonObject>();
            item["entity"] = pair.first;
            item["state"] = pair.second;
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
        // Request fresh sync from WiCAN
        send_to_wican("{\"type\":\"get_states\"}");
    });

    // REST: POST /api/command
    server.on("/api/command", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            
            // Forward command to WiCAN
            send_to_wican(body);
            request->send(200, "application/json", "{\"status\":\"queued\"}");
        }
    );

    // REST: GET /api/system/status
    server.on("/api/system/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["device"] = "M5Stack Atom Lite UI Bridge";
        doc["wican_online"] = g_wican_online;
        doc["free_heap"] = ESP.getFreeHeap();
        doc["uptime_s"] = millis() / 1000;
        doc["ws_clients"] = ws.count();
        doc["ble_paired_count"] = g_paired_devices.size();
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: BLE API for BluetoothManager.tsx
    server.on("/api/ble/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["scanning"] = g_ble_scanning;
        JsonArray paired = doc["paired_devices"].to<JsonArray>();
        for (const auto& addr : g_paired_devices) paired.add(addr);
        
        JsonArray discovered = doc["discovered_devices"].to<JsonArray>();
        for (const auto& dev : g_discovered_devices) {
            JsonObject obj = discovered.add<JsonObject>();
            obj["address"] = dev.address;
            obj["name"] = dev.name;
            obj["rssi"] = dev.rssi;
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    server.on("/api/ble/scan", HTTP_POST, [](AsyncWebServerRequest *request) {
        g_discovered_devices.clear();
        NimBLEDevice::getScan()->start(BLE_SCAN_DURATION_MS / 1000, false);
        g_ble_scanning = true;
        g_ble_scan_start_ms = millis();
        request->send(200, "application/json", "{\"status\":\"scanning_started\"}");
    });

    server.on("/api/ble/pair", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                const char* addr = doc["address"];
                if (addr) {
                    g_paired_devices.push_back(String(addr));
                    request->send(200, "application/json", "{\"status\":\"paired\"}");
                    return;
                }
            }
            request->send(400, "application/json", "{\"error\":\"invalid_payload\"}");
        }
    );

    // Serve Static SPA files from LittleFS
    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html").setCacheControl("max-age=600");

    // SPA Fallback for client-side routing
    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() == HTTP_OPTIONS) {
            request->send(204);
        } else if (LittleFS.exists("/index.html.gz")) {
            AsyncWebServerResponse *response = request->beginResponse(LittleFS, "/index.html.gz", "text/html");
            response->addHeader("Content-Encoding", "gzip");
            request->send(response);
        } else if (LittleFS.exists("/index.html")) {
            request->send(LittleFS, "/index.html", "text/html");
        } else {
            request->send(404, "text/plain", "CAN-Do Web Assets Not Found. Flash LittleFS data partition.");
        }
    });

    server.begin();
    Serial.println("[HTTP] Web server started on port 80");

    // Initial ping to WiCAN
    send_to_wican("{\"type\":\"ping\"}");
    send_to_wican("{\"type\":\"get_states\"}");

    update_led_status();
}

// ============================================================================
// Main Loop
// ============================================================================
void loop() {
    // 1. Clean up stale WebSocket clients
    ws.cleanupClients();

    // 2. Read incoming UART from WiCAN
    static String rx_line = "";
    while (Serial2.available()) {
        char c = (char)Serial2.read();
        if (c == '\n' || c == '\r') {
            if (rx_line.length() > 0) {
                handle_wican_message(rx_line);
                rx_line = "";
            }
        } else {
            if (rx_line.length() < 2048) {
                rx_line += c;
            } else {
                rx_line = ""; // Guard buffer overflow
            }
        }
    }

    // 3. Heartbeat / link check
    static unsigned long last_ping_ms = 0;
    if (millis() - last_ping_ms > 3000) {
        last_ping_ms = millis();
        if (millis() - g_last_wican_rx_ms > 6000) {
            if (g_wican_online) {
                g_wican_online = false;
                Serial.println("[UART] WiCAN link lost (no response)");
                update_led_status();
            }
        }
        send_to_wican("{\"type\":\"ping\"}");
    }

    // 4. BLE Scan Timer
    if (g_ble_scanning && (millis() - g_ble_scan_start_ms > BLE_SCAN_DURATION_MS)) {
        g_ble_scanning = false;
        NimBLEDevice::getScan()->stop();
        Serial.println("[BLE] Scan completed");
    }

    // 5. Onboard Atom Lite Button Check (Toggles Precondition on press)
    static bool last_btn_state = HIGH;
    bool btn_state = digitalRead(BUTTON_PIN);
    if (last_btn_state == HIGH && btn_state == LOW) {
        delay(50); // Debounce
        if (digitalRead(BUTTON_PIN) == LOW) {
            Serial.println("[BTN] Atom Lite button pressed -> sending preheat toggle to WiCAN");
            set_led_color(CRGB::White);
            send_to_wican("{\"type\":\"trigger\",\"action\":\"precon_toggle\"}");
            delay(200);
            update_led_status();
        }
    }
    last_btn_state = btn_state;
}
