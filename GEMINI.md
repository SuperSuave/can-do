# CAN Do: Assistant & Workspace Directives

Welcome to **CAN Do**, an edge-first automotive CAN bus integration and automation engine designed for Hyundai, Kia, and Genesis (E-GMP) vehicles (Ioniq 5/6, EV6, GV60, etc.).

This file (`GEMINI.md`) is automatically loaded as context into every conversation thread in this workspace.

---

## 🏛️ Core Architectural Axioms

1. **Edge-First Offline Execution**:
   - The ESP32 operates 100% offline. Vehicle triggers, conditions, and actions execute locally in microseconds without requiring active Wi-Fi or MQTT connections.
2. **Single Source of Truth (`catalog/can_do_catalog.json`)**:
   - All vehicle entities, byte masks, commands, and automation definitions strictly originate from `catalog/can_do_catalog.json`.
   - **Never** hardcode vehicle entity lists, byte masks, or command sequences directly into C++ firmware or UI components.
3. **The 1-Based Indexing Law**:
   - In catalog JSON specifications and UI representations, payload bytes are **strictly 1-based (`D1` through `D8`)**, where `D1` is the first byte.
   - Note: The C++ firmware engine (`firmware/main/parser.cpp`, `can_engine.cpp`) converts these into 0-indexed byte offsets internally at boot.
4. **No Wildcards on the Edge**:
   - The ESP32 C++ engine does not parse wildcard strings or regex globs.
   - Byte transition conditions evaluate numerically: `(actual & mask) == (target & mask)`.
5. **Synchronized Versioning**:
   - Project releases coordinate version tags across:
     - `firmware/version.txt`
     - `catalog/can_do_catalog.json` (`can_do_version`)
     - `frontend/package.json` (`version`)
     - `custom_components/can_do/manifest.json` (`version`) and `const.py` (`VERSION`)

---

## 📂 Monorepo Organization

```text
/can-do
├── catalog/
│   └── can_do_catalog.json       # PRIMARY TRUTH: Entities, D1-D8 byte masks, commands, automations
├── firmware/                     # ESP-IDF v5.x C++ engine (ESP32-C3 / S3 / vanilla ESP32)
│   ├── partitions.csv            # 4MB partition table (dual OTA A/B + LittleFS storage)
│   └── main/                     # FreeRTOS tasks (can_rx_task prio 5, can_tx_task prio 4, API, parser)
├── atom-ui-bridge/               # PlatformIO / Arduino project for M5Stack Atom Lite
│   ├── platformio.ini            # Espressif32 PlatformIO configuration (board = m5stack-atom)
│   ├── sync_web_assets.py        # Compresses & stages frontend/dist + catalog into LittleFS data/
│   └── data/                     # Staged LittleFS filesystem assets
├── frontend/                     # React 19 + Vite 6 + TypeScript + Tailwind 4 UI & Automation Builder
│   ├── src/                      # Catalog explorer, live logs, automation builder
│   └── dist/                     # Compiled web assets for LittleFS embedding
├── custom_components/can_do/     # Home Assistant Custom Component (HACS integration via MQTT / zeroconf)
└── docs/
    ├── architecture.md           # Master architecture specification & engine logic
    └── egmp_can_reference.md     # E-GMP CAN ID, ISO-TP, and payload reference
```

---

## 🛠️ Key Build & Development Commands

### Frontend (`frontend/`)
```bash
cd frontend
npm install
npm run dev        # Dev server on http://localhost:3000
npm run build      # Production build to frontend/dist
npm run lint       # Type check via tsc --noEmit
```

### Atom Lite Bridge (`atom-ui-bridge/`)
```bash
cd atom-ui-bridge
python sync_web_assets.py    # Sync and gzip frontend/dist into LittleFS data/
pio run                      # Build firmware
pio run -t buildfs           # Build LittleFS image
pio run -t upload            # Flash firmware to Atom Lite
```

### ESP-IDF Firmware (`firmware/`)
```bash
cd firmware
idf.py set-target esp32c3    # or esp32 / esp32s3
idf.py build
idf.py -p <PORT> flash monitor
```

---

## 💡 Guidelines for AI Assistants

1. **Strict E-GMP Focus (No Legacy Carryover)**:
   - This project strictly targets **E-GMP vehicles (Kia EV6, Hyundai Ioniq 5/6, Genesis GV60)**.
   - Discard older Gen 1 / Gen 2 / pre-E-GMP information (e.g., analog IG3 relays, older ICE/HEV/PHEV schemas) unless empirically verified to still apply to E-GMP.
2. **Strict Ground-Truth Verification (Do Not Trust Unverified Scripts)**:
   - **Never rely on unverified documentation, scratch scripts, or third-party snippets** outside of what we have directly verified and updated ourselves. Many older/community scripts in the workspace contain guesswork, non-working payloads, or incorrect assumptions.
   - Ground truth must come exclusively from:
     - Real, empirical E-GMP vehicle CAN bus logs (e.g., user-captured CSVs).
     - Verified Mobis STD5W Head Unit MICOM firmware disassembly (`dec_micom_sw.bin`).
     - Directly verified documentation ([`docs/egmp_can_reference.md`](file:///d:/Documents/can-do/docs/egmp_can_reference.md)) and test suite ([`tests/test_remote_climate.py`](file:///d:/Documents/can-do/tests/test_remote_climate.py)).
3. **Preserve Integrity & References**:
   - Check [`docs/architecture.md`](file:///d:/Documents/can-do/docs/architecture.md) and [`docs/egmp_can_reference.md`](file:///d:/Documents/can-do/docs/egmp_can_reference.md) before inventing CAN IDs, byte patterns, or altering state-machine conventions.
   - When adding entities or automations, adhere to existing schemas in [`catalog/can_do_catalog.json`](file:///d:/Documents/can-do/catalog/can_do_catalog.json).
4. **Flash Budget Awareness**:
   - Embedded LittleFS storage is constrained (e.g., 2MB on Atom Lite). Static frontend assets must remain lean and be gzip-compressed where appropriate.
5. **Thread Context Handoff**:
   - When finishing complex or multi-step tasks, summarize modified files, current state, and the logical next action so new threads can resume without loss of context.
