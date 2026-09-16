# CAN Do: Home Assistant MQTT Integration

CAN Do features native, zero-code Home Assistant integration via **MQTT Auto-Discovery**. 

Because the ESP32 acts as an autonomous edge engine, Home Assistant serves as an optional UI view and remote command dispatch. No custom HACS components or custom Python classes (`WiCANVehicleClimateEntity`, etc.) are needed.

---

## ⚡ How It Works

1. **Boot Announcement**: When the ESP32 connects to Wi-Fi and the MQTT broker, it reads the local `can_do_catalog.json` and dynamically publishes an Auto-Discovery configuration payload for every entity defined in the catalog.
2. **Unified Device Registry**: Every entity includes a common `device` block with matching `identifiers`:
   ```json
   "device": {
     "identifiers": ["cando_kia_ev6"],
     "name": "Kia EV6",
     "manufacturer": "CAN Do",
     "model": "EV6 GT-Line"
   }
   ```
   This automatically bundles seat comfort, heated steering wheel, door locks, ambient lighting, and cluster notifications under a single, unified **Vehicle Device** page in Home Assistant (`Settings -> Devices & Services -> MQTT`).
3. **Bi-Directional Decoupled Topics**:
   - **Command Topic (`cando/set/{entity_id}`)**: Home Assistant publishes friendly string states (e.g. `Medium Cool`, `High Heat`, `Off`). The ESP32 router intercepts the string, translates it to the binary CAN burst mask, and executes the physical button injection.
   - **State Topic (`cando/state/{entity_id}`)**: Only updated when the ESP32's TWAI RX task detects a physical state confirmation frame on the vehicle bus (e.g. `0x496`). Published with `QoS 1, Retain = true` so states survive Home Assistant server reboots without state desyncs.

---

## 📡 Topic Architecture

| Direction | Topic Format | Payload Example | Description |
|-----------|--------------|-----------------|-------------|
| ESP32 -> HA | `homeassistant/{domain}/cando_{vehicle}/{entity_id}/config` | JSON | Discovery manifest declaring entity name, icon, options, and topics |
| HA -> ESP32 | `cando/set/{entity_id}` | `Medium Cool` | Friendly string command published from HA UI or HA automation |
| ESP32 -> HA | `cando/state/{entity_id}` | `Medium Cool` | Verified physical state parsed from CAN bus |

---

## 📋 Included Reference Files

- [`lovelace_dashboard.yaml`](lovelace_dashboard.yaml): Complete dashboard layout with seat comfort, climate, and steering wheel controls.
- [`sample_automations.yaml`](sample_automations.yaml): HA automations demonstrating Android Auto profile triggers and preconditioning schedules.
