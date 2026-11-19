---
name: esp32-memory-guardrails
description: >-
  Enforces ESP32-S3 and ESP32-C3 internal DRAM vs. PSRAM memory guardrails for CAN Do firmware.
  Activate whenever modifying firmware/main/ (types.h, parser.cpp, main.cpp, FreeRTOS tasks or queues),
  editing sdkconfig.defaults*, adding catalog fields/structs, or debugging MQTT connection failures
  ("Error create mqtt task"), SNTP/mDNS failures, Cloud OTA failures, or low internal_free_heap.
---

# ESP32 Internal DRAM & PSRAM Memory Guardrails

## Why This Matters (`ALWAYSINTERNAL=4096` Trap)

On ESP32-S3 (`sdkconfig.defaults.esp32s3`):
- `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096` routes **every** standard `malloc()` / `new` `<= 4096` bytes into **internal SRAM** until free internal SRAM drops to `CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL=32768`.
- `esp_get_free_heap_size()` sums internal DRAM + 2 MB PSRAM (~1.5 MB+), so checking only `esp_get_free_heap_size()` hides complete internal DRAM starvation.
- When small C++ containers (`std::vector`, `std::unordered_map`, `std::string` > 15 chars, oversized structs like `ActionStep`) fill internal DRAM down to the 32 KB reserve, FreeRTOS task stacks and SPI/Wi-Fi DMA drain the reserve, causing:
  - `mqtt_client: Error create mqtt task` (MQTT stays `connected: false` permanently)
  - `network_ready_task` failure (SNTP stays `Unsynchronized`, mDNS never starts)
  - `cloud_ota_task` failure (`10240`-byte internal stack unavailable)

## Pre-Merge Firmware Checklist

1. **Bulk Containers Must Prefer PSRAM**:
   - Use `PsramVector`, `PsramList`, `PsramUnorderedMap`, or `PsramAllocator` (`firmware/main/core/psram_alloc.h`) for long-lived catalog, index, or rule-lookup containers (`global_catalog`, `catalog_by_can_id`, `s_mitm_rules`, `s_dynamic_entities`).
2. **Keep Per-Option / Per-Entity Structs Compact**:
   - Never embed `ActionStep` (~730 B) inside `EntityOption` or catalog-wide structs. Use `CatalogStep` (~24 B) and expand via `catalog_steps_to_action_steps()` only when executing a command.
   - Omit UI/discovery-only strings (like `ha_icon`) when caching `global_catalog`; `stream_catalog_entities()` parses them on-demand during HA discovery.
3. **Large Non-ISR FreeRTOS Queues (> 2 KB) Must Use PSRAM**:
   - Allocate storage with `heap_caps_malloc_prefer(len * item_sz, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT)` and create with `xQueueCreateStatic()` on `#if CONFIG_SPIRAM` (only for queues never posted to from ISRs, e.g., `s_mqtt_pub_queue`, `s_mqtt_cmd_queue`, `s_gvret_queue`).
4. **Flash/SPI Safety for Task Stacks**:
   - **Never** enable PSRAM stacks for tasks that call `fopen`/LittleFS/NVS or disable cache (`esp_mqtt_task` with `CONFIG_MQTT_TASK_STACK_ON_EXTERNAL_MEMORY`, `mqtt_cmd`, `httpd`). Keep those stacks in internal DRAM and reclaim DRAM from heap data instead.
5. **Check Internal Heap Explicitly & Log Failures**:
   - Always check `heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)` before large boot loads and log failures on `xTaskCreate()`, `esp_mqtt_client_init()`, and `esp_mqtt_client_start()`.

## Live Verification & Recovery

1. **Verify healthy internal DRAM & services on a running device**:
   - `curl -s http://<DEVICE_IP>/api/system/status`: confirm `internal_free_heap >= 49152` (48 KB+) and `time_synced: true`.
   - `curl -s http://<DEVICE_IP>/api/mqtt`: confirm `connected: true` (when `enabled: true` and broker is reachable).
   - Connect to `ws://<DEVICE_IP>/ws`: confirm no `Error create mqtt task` or `Failed to create net_ready task` logs.
2. **Recovery if a flashed build already exhausted internal DRAM**:
   - Cloud OTA (`cloud_ota_task`, 10 KB stack) will fail with low internal DRAM. Flash via **direct upload OTA** (`POST /api/ota`, handled directly on the existing `httpd` task) or USB serial (`idf.py -p <PORT> flash`).
