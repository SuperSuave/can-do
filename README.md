# CAN Do: ESP32 Autonomous Vehicle Engine

**CAN Do** is an edge-first automotive CAN bus integration and automation platform designed primarily for Hyundai, Kia, and Genesis (E-GMP) vehicles.

It transforms an ESP32 (such as the WiCAN-OBD-C3 / WiCAN Pro or M5Stack Atom hardware) into a standalone, offline controller that evaluates network states and executes commands directly on the CAN bus, exposing bi-directional state synchronization via MQTT, WebSockets, UART, USB-CAN, and Home Assistant.

---

## 🏗 System Architecture

1. **Edge-First Execution (ESP32)**: Operates 100% offline. Vehicle triggers, conditions, and actions execute locally without needing an active Wi-Fi or MQTT connection.
2. **Single Source of Truth (`catalog/`)**: All entity definitions, byte masks, and automation rules are defined in `catalog/can_do_catalog.json` using 1-based indexing (`D1`–`D8`).
3. **Storage & Packaging (LittleFS)**: The JSON catalog, preferences, automations, and compressed web interface assets are bundled into a dedicated LittleFS flash partition (`storage`) alongside dual-OTA application slots.
4. **Boot Parser (cJSON)**: Deserializes the catalog into memory once at startup, building ultra-fast 0-indexed C++ bitmasks for sub-microsecond CAN frame evaluations.
5. **Execution Engine & Protocols (FreeRTOS)**:
   * **`can_rx_task` (Priority 5)**: Real-time listener for incoming TWAI frames; updates the RAM State Cache (`std::unordered_map`) and dispatches state updates.
   * **`can_tx_task` (Priority 4)**: Consumes commands from `tx_command_queue` and transmits single frames, frame bursts, ISO-TP multi-frame payloads, and UDS diagnostic sequences without blocking network tasks.
6. **Built-in Vehicle Subsystems**:
   * **Battery Preconditioning**: State-machine-driven manual and automated HV battery preconditioning.
   * **Cluster & Infotainment Feedback**: Media track popups (`track_popup`), HUD navigation cues (`hud_nav`), ambient lighting animations (`ambient_anim`), and audible vehicle chimes (`beep`).
   * **Remote Climate**: Wake and climate control state management (`remote_climate`). **This has not been fully implemented.**
7. **Multi-Interface Connectivity**:
   * **Home Assistant Bridge**: Native custom component (`custom_components/can_do`, HACS-ready) plus MQTT Auto-Discovery grouping all entities under a unified vehicle device registry.
   * **Diagnostic & UI Bridges**: Supports SavvyCAN via GVRET (`gvret_server`), USB-CAN (`usb_can`), and external display/controller hardware via `atom-ui-bridge` (`uart_bridge`).
   * **Web Management & Real-time Logs**: Streams static gzipped assets from LittleFS, provides REST endpoints (`/api/states`, `/api/command`, `/api/test_automation`, `/api/upload`, `/api/ota`), and pipes system logs over `/ws` using an `esp_log_set_vprintf` hook.

---

## 📂 Repo Structure

```text
/can-do
├── /catalog
│   └── can_do_catalog.json          # Single source of truth (D1-D8 byte maps, entities, automations)
│
├── /firmware                        # ESP-IDF C/C++ autonomous vehicle engine
│   ├── partitions.csv               # Custom 4MB partition table (dual OTA + LittleFS)
│   ├── sdkconfig.defaults           # Default ESP-IDF configuration
│   ├── upload_web.py                # Helper script for pushing web assets over HTTP
│   ├── version.txt                  # Firmware build version tracker
│   ├── /data                        # Default LittleFS staging (automations.json, preferences.json, /www)
│   └── /main
│       ├── main.cpp                 # Application entry, task scheduling, and initialization
│       ├── /core                    # Core CAN & catalog evaluation engine
│       │   ├── can_engine.cpp/.h    # State cache, condition evaluation, and TX burst queue
│       │   ├── parser.cpp/.h        # cJSON catalog loader and bitmask generator
│       │   ├── board_pins.h         # Hardware GPIO definitions
│       │   ├── can.h                # Low-level CAN interface definitions
│       │   └── types.h              # Shared C++ data structures
│       ├── /net                     # Network, API, and hardware bridge services
│       │   ├── api.cpp/.h           # REST endpoints, WebSocket broadcaster, and log hook
│       │   ├── config_server.c/.h   # Configuration compatibility layer
│       │   ├── gvret_server.cpp/.h  # GVRET server for SavvyCAN integration
│       │   ├── mqtt_mgr.cpp/.h      # MQTT client and Home Assistant Auto-Discovery
│       │   ├── network_mgr.cpp/.h   # Wi-Fi AP/STA connection manager
│       │   ├── uart_bridge.cpp/.h   # High-speed UART bridge to Atom UI hardware
│       │   └── usb_can.cpp/.h       # USB-CAN / SLCAN serial interface
│       ├── /platform                # Device power, NVS, and sensor management
│       │   ├── persistent_settings.c/.h # NVS settings storage
│       │   ├── power_mgr.cpp/.h     # Sleep mode and power state management
│       │   ├── timezone_mgr.cpp/.h  # NTP and POSIX timezone handling
│       │   └── vbat_sensor.cpp/.h   # 12V auxiliary battery voltage monitoring
│       ├── /protocols               # Transport layers and state machine frameworks
│       │   ├── hsm.c/.h             # Hierarchical State Machine (HSM) core
│       │   ├── isotp_tx.c/.h        # ISO-TP (ISO 15765-2) multi-frame CAN transmitter
│       │   ├── uds_engine.cpp/.h    # UDS diagnostic request/response engine
│       │   └── utf8_utf16_converter.c/.h # UTF-8 to UTF-16LE converter for CAN text payloads
│       └── /subsystems              # E-GMP vehicle feature modules
│           ├── ambient_anim.cpp/.h  # Dynamic ambient lighting animations
│           ├── beep.c/.h            # Vehicle cluster/head-unit chime generator
│           ├── hud_nav.c/.h         # Head-Up Display (HUD) navigation rendering
│           ├── precondition.c/.h    # HV battery preconditioning state machine
│           ├── remote_climate.cpp/.h# Remote climate and wake control
│           └── track_popup.c/.h     # Infotainment media track popup notifications
│
├── /frontend                        # Catalog explorer, visualizer & automation builder (React + Vite + TS)
│   ├── src/                         # Components, DBC converter, live evaluator, and WebSocket services
│   ├── package.json                 # Frontend dependencies and scripts
│   └── vite.config.ts               # Vite bundler configuration
│
├── /atom-ui-bridge                  # PlatformIO companion firmware for M5Stack Atom UI bridge
│   ├── src/main.cpp                 # Bridge firmware source
│   ├── data/                        # Synced web and catalog assets
│   ├── sync_web_assets.py           # Asset synchronization script
│   └── platformio.ini               # PlatformIO project configuration
│
├── /custom_components/can_do        # Home Assistant custom integration (HACS ready)
│   ├── manifest.json                # HA integration manifest
│   ├── brand/                       # Local HACS dark/light icons and logos
│   └── *.py                         # binary_sensor, button, climate, cover, event, light, lock, notify, number, select, sensor, switch
│
├── /scripts                         # Tooling: catalog optimizer, WiCAN log replay, and vehicle stress tests
├── /tests                           # Python unit test suites (can_utils, catalog_loader, remote_climate)
└── /docs                            # Architecture specs, E-GMP CAN reference, and MICOM filter tables

```

---

## 🚀 Getting Started

### 1. Catalog & Automation Builder (`frontend/`)

```bash
cd frontend
npm install
npm run dev     # Start catalog builder UI on http://localhost:3000
npm run build   # Build production web bundle
npm test        # Run Vitest unit tests (DBC converter, validators, automation converters)

```

### 2. ESP32 Firmware (`firmware/`)

Requires [ESP-IDF v5.0+](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/):

```bash
cd firmware
idf.py set-target esp32c3   # Or esp32 / esp32s3
idf.py build
idf.py -p COMx flash monitor

```

### 3. Home Assistant Integration (`custom_components/can_do/`)

1. In Home Assistant, open **HACS** -> **Integrations** -> **Custom repositories**.
2. Add `https://github.com/SuperSuave/can-do` with category **Integration**.


3. Install **CAN Do**, restart Home Assistant, and add the integration via **Settings** -> **Devices & Services**.

---

## 🔄 OTA & Diagnostic Features

* **Firmware OTA**: Upload `can-do-esp32c3.bin` via `POST /api/ota` directly from the web dashboard.


* **Catalog & Web Hot-Push**: Push updated JSON or web assets via `POST /api/upload` (or `firmware/upload_web.py`) without re-flashing the application partition.


* **Test Automation**: Test rules using `POST /api/test_automation` in either `dry_run` (evaluate conditions against current cache) or `live_fire` (force trigger actions).


* **SavvyLens/SavvyCAN / GVRET**: Connect SavvyLens/SavvyCAN over Wi-Fi via the built-in GVRET server (`gvret_server`) to inspect live bus traffic.


* **Wireless Console**: Connect to `/ws` to stream real-time FreeRTOS system logs directly to your browser or mobile dashboard.



---

## 🙏 Acknowledgments & Credits

Portions of the E-GMP vehicle subsystem logic and transport protocols in `firmware/main/` are adapted and maintained in sync (with project-specific modifications) from **[L1Z3/wicant-i-precondition](https://github.com/L1Z3/wicant-i-precondition)** (developed by [@L1Z3](https://github.com/L1Z3), [@tylerharvey](https://github.com/tylerharvey), and contributors for the [Electroniq Buttons](https://electroniqbuttons.com/) / [Ioniq5_CAN](https://github.com/tylerharvey/Ioniq5_CAN) project, forked from [@meatpiHQ/wican-fw](https://github.com/meatpiHQ/wican-fw)):

* **`firmware/main/subsystems/precondition.c/.h`** — E-GMP HV battery preconditioning state machine and control logic


* **`firmware/main/subsystems/beep.c/.h`** — Audible vehicle chime/beep feedback generation over CAN


* **`firmware/main/subsystems/track_popup.c/.h`** — Infotainment media track popup notification rendering


* **`firmware/main/protocols/isotp_tx.c/.h`** — ISO-TP (ISO 15765-2) multi-frame CAN transport layer transmitter


* **`firmware/main/protocols/utf8_utf16_converter.c/.h`** — UTF-8 to UTF-16LE string encoding helper for CAN payloads


* **`firmware/main/protocols/hsm.c/.h`** — Hierarchical State Machine (HSM) core framework

* **`firmware/main/net/config_server.c/.h`** & **`firmware/main/platform/persistent_settings.c/.h`** - Interface compatibility with the upstream WiCAN / `wicant-i-precondition` modules.

Upstream code from `L1Z3/wicant-i-precondition` and `meatpiHQ/wican-fw` is licensed under the [GNU General Public License v3.0 (GPL-3.0)](https://github.com/L1Z3/wicant-i-precondition/blob/main/LICENSE).