CAN Do: Master Architecture Document

1. The Prime Directive

Edge-First Execution: The ESP32 operates entirely offline. It does not rely on Wi-Fi or MQTT to process local CAN triggers.

Single Source of Truth: The JSON/YAML Catalog dictates everything. If a feature isn't in the Catalog, the ESP32 C++ backend does not know about it.

1-Based Indexing Law: All CAN frame payload bytes are strictly represented using 1-based indexing (D1 through D8), where D1 is the first byte.

2. The Trigger / Condition / Action Engine

Triggers: What initiates an event. This can be a local CAN frame (e.g., driver door opens) or an external MQTT payload from Home Assistant (e.g., Android Auto connected).

Conditions: The state checks required before firing (e.g., is the ignition on? Is the gear in Park?).

Actions: The execution sequence. This defines the exact payload bursts, timing intervals, and sequence order to inject onto the CAN bus.

3. The Home Assistant Bridge (Optional)

When connected to Wi-Fi, the ESP32 translates the Catalog's device classes into Home Assistant MQTT Auto-Discovery JSON payloads.

State changes on the CAN bus are parsed based on the Catalog and published to MQTT purely for history tracking and UI updates.

# CAN Do Architecture Reference for AI Assistants

This document defines the core architecture, constraints, and data flows for **CAN Do**, an edge-first CAN bus automation engine for Hyundai, Kia, and Genesis (E-GMP) vehicles.

When generating code, refactoring, or assisting with this repository, you must adhere strictly to the rules and patterns outlined below.

---

## 🏛️ Core Axioms & Design Rules

1. **Single Source of Truth (`/catalog/can_do_catalog.js`):**
   - All vehicle entities, commands, and automation rules must originate from `/catalog/can_do_catalog.js`.
   - Never hardcode entity lists, command payloads, or automation logic directly into the C++ firmware.

2. **No Wildcards on the Edge (ESP32):**
   - The ESP32 C++ engine **does not** parse or evaluate wildcard strings (e.g., shell-style globs like `* * * * * * 1*`).
   - All UI-level filters or wildcard patterns must be compiled at build time into explicit numerical byte indices, target values, and bitmask state transitions (`byte_index`, `from_value`, `to_value`), which follows this catalog schema:

```json
    {
      "id": "drivers_seat_comfort",
      "ha_metadata": {
        "name": "Driver Seat Comfort",
        "domain": "select",
        "icon": "mdi:car-seat-heater"
      },
      "category": "Seats & Steering Wheel Comfort",
      "subcategory": "Seat Comfort",
      "roles": ["trigger", "condition", "action"],
      "network": {
        "bus": 0,
        "type": "can_tx",
        "state_can_id": "0x496",
        "action_can_id": "0x4A2",
        "delay_ms": 20
      },
      "tags": ["all_egmp"],
      "popup_message": "",
      "contributor": {
        "name": "Electroniq Buttons Community",
        "github": "",
        "notes": "Consolidated driver seat heat and ventilation states"
      },
      "options": [
        {
          "label": "Off",
          "popup": "Driver Seat: Off",
          "match": { "D1": "0x16" },
          "default": true,
          "steps": [
            { "payload": { "D5": "0x2F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        },
        {
          "label": "Low Heat",
          "popup": "Driver Seat: Heat Low",
          "requires_feature": "heated_seats",
          "match": { "D1": "0x36" },
          "steps": [
            { "payload": { "D5": "0x6F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        },
        {
          "label": "Medium Heat",
          "popup": "Driver Seat: Heat Med",
          "requires_feature": "heated_seats",
          "match": { "D1": "0x4E" },
          "steps": [
            { "payload": { "D5": "0x7F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        },
        {
          "label": "High Heat",
          "popup": "Driver Seat: Heat High",
          "requires_feature": "heated_seats",
          "match": { "D1": "0x46" },
          "steps": [
            { "payload": { "D5": "0x8F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        },
        {
          "label": "Low Cool",
          "popup": "Driver Seat: Cool Low",
          "requires_feature": "ventilated_seats",
          "match": { "D1": "0x1E" },
          "steps": [
            { "payload": { "D5": "0x3F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        },
        {
          "label": "Medium Cool",
          "popup": "Driver Seat: Cool Med",
          "requires_feature": "ventilated_seats",
          "match": { "D1": "0x26" },
          "steps": [
            { "payload": { "D5": "0x4F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        },
        {
          "label": "High Cool",
          "popup": "Driver Seat: Cool High",
          "requires_feature": "ventilated_seats",
          "match": { "D1": "0x2E" },
          "steps": [
            { "payload": { "D5": "0x5F" }, "repeat": 3 },
            { "payload": { "D5": "0xFF" }, "repeat": 3 }
          ]
        }
      ]
    }
```

3. **Decoupled "Engine-as-Executor" Model:**
   - The ESP32 is a headless, lightning-fast execution engine. It does not host a dynamic visual rule-builder.
   - The C++ backend evaluates triggers, conditions, and actions in microseconds against a RAM-based state cache.

---

## 📂 Monorepo Structure

```text
/CAN-Do
│
├── /catalog                  
│   └── can_do_catalog.js     # PRIMARY SOURCE OF TRUTH (JS/TS data structure)
│
├── /frontend                 # Material Design 3 (MD3) Web Dashboard
│   ├── index.html
│   ├── main.js               # WebSocket manager & auto-reconnection loop
│   └── styles.css
│
└── /firmware                 # ESP-IDF C++ Engine
    ├── /main
    │   ├── main.cpp          # FreeRTOS tasks, OS hooks, and app entry
    │   ├── api.cpp           # REST endpoints (/api/upload, /api/states, /api/ota)
    │   ├── parser.cpp        # cJSON parser loading compiled catalog structures
    │   └── can_engine.cpp    # State cache, transition evaluator, and TX queue
    └── partitions.csv        # Custom 4MB layout (OTA A/B + LittleFS storage)
⚙️ Execution & Data Flow
1. The State Cache (std::unordered_map)
The FreeRTOS CAN RX task runs continuously at high priority.

Every incoming frame updates a RAM-based hash map (can_state_cache) linking a CAN ID to its raw 8-byte array.

This cache allows triggers and conditions to be evaluated instantly without waiting for a frame broadcast interval.

2. Rule Evaluation, Masking & Transitions
Rules are evaluated using explicit numerical checks rather than string matching or wildcards:

- **Triggers**: Monitor specific byte transitions with optional bitmasks:
  ```json
  {
    "type": "byte_transition",
    "can_id": "0x448",
    "bus": 0,
    "byte": "D7",
    "mask": "0xF0",
    "from": "0x00",
    "to": "0x10"
  }
  ```
  Masked byte evaluation logic: `(actual & mask) == (target & mask)`.

- **Structured Conditions (AND/OR/NOT)**:
  Conditions compile into explicit logic groups or leaf checks:
  ```json
  {
    "logic": "and",
    "conditions": [
      {
        "can_id": "0x120",
        "bus": 0,
        "byte": "D1",
        "mask": "0xFF",
        "operator": "equal",
        "value": "0x01"
      }
    ]
  }
  ```

- **Sequential Branching Actions (If-Then-Else & Choose)**:
  Actions execute sequentially and support branching:
  - **Entity Commands**: `{ "type": "entity_command", "entity_id": "drivers_seat_comfort", "command": "Medium Cool" }`
  - **Transmit Frames**: `{ "type": "transmit", "can_id": "0x524", "bus": 0, "payload": { "D1": "0x02" }, "repeat": 1 }`
  - **Delay**: `{ "type": "delay", "ms": 500 }`
  - **If-Then-Else**:
    ```json
    {
      "type": "if_then",
      "conditions": [ ... ],
      "then": [ ... ],
      "else": [ ... ]
    }
    ```
  - **Choose (Switch-Case)**:
    ```json
    {
      "type": "choose",
      "choices": [
        {
          "conditions": [ ... ],
          "sequence": [ ... ]
        }
      ],
      "default": [ ... ]
    }
    ```

3. Asynchronous Communication
WebSockets (/ws): Real-time state changes and system logs (esp_log hook output) are broadcast asynchronously to connected MD3 dashboards using httpd_queue_work.

MQTT Auto-Discovery: Publishes dynamic Home Assistant discovery configurations based on the loaded catalog. Command and state topics are strictly decoupled to prevent desyncs.

REST Endpoints:

POST /api/upload: Receives raw files (.json, web assets) with an X-File-Path header, writing directly to LittleFS.

POST /api/ota: Performs safe A/B partition firmware flashing.

GET /api/states: Dumps the current RAM state of all catalog entities as JSON.

🛠️ Development & Build Flow
Authoring: Update catalog entries and automation definitions inside /catalog/can_do_catalog.js.

Compilation: A build-time script flattens the JS catalog into a wildcard-free catalog.json and packs it into a LittleFS binary image alongside the frontend assets.

Flashing / Deployment: The binary is flashed via USB initially; subsequent updates are pushed wirelessly via the MD3 web dashboard (/api/upload or /api/ota).