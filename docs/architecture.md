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

This document gives your AI a strict set of boundaries. Whenever you start a new coding task, you feed it this document first so it doesn't try to build a conflicting architecture.