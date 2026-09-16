# CAN Do: ESP32 Autonomous Vehicle Engine

CAN Do is an edge-first automotive CAN bus integration and automation platform designed primarily for Hyundai, Kia, and Genesis (E-GMP) vehicles. 

It transforms an ESP32 into a standalone, offline controller that evaluates network states and executes commands directly on the CAN bus, exposing bi-directional state synchronization via MQTT and WebSockets.

---

## 🏗️ System Architecture

1. **Edge-First Execution (ESP32)**: Operates 100% offline. Vehicle triggers, conditions, and actions execute locally without needing an active Wi-Fi or MQTT connection.
2. **Single Source of Truth (`catalog/`)**: All entity definitions, byte masks, and automation rules are defined in `catalog/can_do_catalog.json` using 1-based indexing (`D1`–`D8`).
3. **Storage & Packaging (LittleFS)**: The JSON catalog and web interface are bundled into a dedicated LittleFS flash partition (`storage`) alongside dual-OTA application slots.
4. **Boot Parser (cJSON)**: Deserializes the catalog into memory once at startup, building ultra-fast 0-indexed C++ bitmasks for sub-microsecond CAN frame evaluations.
5. **Execution Engine (FreeRTOS)**:
   - **`can_rx_task` (Priority 5)**: Real-time listener for incoming TWAI frames; updates the RAM `State Cache` (`std::unordered_map`) and dispatches state updates.
   - **`can_tx_task` (Priority 4)**: Consumes commands from `tx_command_queue` and transmits frame bursts without blocking network tasks.
6. **Home Assistant Bridge**: Publishes MQTT Auto-Discovery payloads dynamically upon Wi-Fi connection, grouping all entities under a unified vehicle device registry.
7. **Web Management & Real-time Logs**: Streams static files from LittleFS, provides REST endpoints (`/api/states`, `/api/command`, `/api/test_automation`, `/api/upload`, `/api/ota`), and pipes system logs over `/ws` using an `esp_log_set_vprintf` hook.

---

## 📂 Monorepo Structure

```text
/can-do
├── /catalog
│   └── can_do_catalog.json     # Single source of truth (D1-D8 byte maps, entities, automations)
│
├── /firmware                   # ESP-IDF C++ engine
│   ├── partitions.csv          # Custom 4MB partition table (dual OTA + LittleFS)
│   ├── CMakeLists.txt          # Top-level CMake
│   └── /main
│       ├── main.cpp            # Application entry, task scheduling, and HA discovery
│       ├── parser.cpp/.h       # cJSON catalog loader and bitmask generator
│       ├── can_engine.cpp/.h   # State cache, condition evaluation, and TX burst queue
│       ├── api.cpp/.h          # REST endpoints, WebSocket broadcaster, and log hook
│       ├── types.h             # Shared C++ data structures
│       ├── idf_component.yml   # LittleFS component dependency
│       └── CMakeLists.txt      # Automated LittleFS staging and image creation
│
├── /frontend                   # Catalog explorer and automation builder (React + Vite + TS)
│   ├── src/                    # Web application source
│   ├── package.json            # Scripts: dev, build, lint
│   └── vite.config.ts          # Vite configuration
│
├── /ha-integration             # Home Assistant integration assets & docs
└── /docs                       # Architecture specifications and reference docs
```

---

## 🚀 Getting Started

### 1. Catalog & Automation Builder (`frontend/`)

```bash
cd frontend
npm install
npm run dev     # Start catalog builder UI on http://localhost:3000
npm run build   # Build production web bundle
```

### 2. ESP32 Firmware (`firmware/`)

Requires [ESP-IDF v5.0+](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/):

```bash
cd firmware
idf.py set-target esp32c3   # Or esp32 / esp32s3
idf.py menuconfig           # Set Partition Table -> Custom partition table CSV (partitions.csv)
idf.py build
idf.py -p COMx flash monitor
```

The build system automatically copies `catalog/` and `frontend/` into a temporary staging folder and generates the LittleFS flash image simultaneously.

---

## 🔄 OTA & Diagnostic Features

- **Firmware OTA**: Upload `build/can-do.bin` via `POST /api/ota` directly from a browser.
- **Catalog Hot-Push**: Send updated JSON via `POST /api/upload` with header `X-File-Path: /spiffs/catalog/can_do_catalog.json` to reboot with new rules without re-flashing firmware.
- **Test Automation**: Test rules using `POST /api/test_automation` in either `dry_run` (evaluate conditions against current cache) or `live_fire` (force trigger actions).
- **Wireless Console**: Connect to `/ws` to stream real-time FreeRTOS system logs directly to your browser or mobile dashboard.
