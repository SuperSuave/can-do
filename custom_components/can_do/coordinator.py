"""Coordinator for CAN Do integration communicating purely over MQTT."""

import asyncio
import json
import logging
import math
import re
from collections.abc import Callable
from typing import Any

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback

from .catalog_loader import get_monitored_can_ids, get_vehicle_commands, normalize_can_id
from .const import (
    CONF_BASE_TOPIC,
    CONF_DEVICE_ID,
    CONF_ENABLED_CATEGORIES,
    CONF_FILTER_ACTIVE_IDS,
    CONF_VEHICLE_ID,
    DEFAULT_BASE_TOPIC,
    DEFAULT_FILTER_ACTIVE_IDS,
    DEFAULT_VEHICLE_ID,
)

_LOGGER = logging.getLogger(__name__)

_BMS_ALIASES: dict[str, list[str]] = {
    "bms_hv_v": ["bms_hv_voltage"],
    "bms_hv_voltage": ["bms_hv_v"],
    "bms_hv_a": ["bms_hv_current"],
    "bms_hv_current": ["bms_hv_a"],
    "bms_hv_kw": ["bms_hv_power_kw"],
    "bms_hv_power_kw": ["bms_hv_kw"],
}

_CRC_CAN_IDS: set[str] = {
    "0x0a2", "0x130", "0x152", "0x1ac", "0x226", "0x2ad", "0x30e", "0x380", "0x31b", "0x39b", "0x476", "0x448", "0x4ce"
}

_NUMERIC_SCALAR_RE = re.compile(
    r"^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:%|km/h|kph|mph|°c|°f|kw|w|mv|v|a|km|mi|bar|psi|kpa|min)?\s*$",
    re.IGNORECASE,
)


class CanDoDataCoordinator:
    """Coordinates state updates and commands for CAN Do via Home Assistant MQTT."""

    def __init__(self, hass: HomeAssistant, entry_data: dict[str, Any]) -> None:
        """Initialize the CAN Do coordinator."""
        self.hass = hass
        self.device_id: str = entry_data.get(CONF_DEVICE_ID, "auto")
        self.vehicle_id: str = entry_data.get(CONF_VEHICLE_ID, DEFAULT_VEHICLE_ID)
        self.base_topic: str = (
            str(entry_data.get(CONF_BASE_TOPIC) or DEFAULT_BASE_TOPIC).strip(" /")
            or DEFAULT_BASE_TOPIC
        )
        self.active_device_id: str | None = (
            None if self.device_id in ("auto", "*", "") else self.device_id
        )

        self.available: bool = True
        self.can_states: dict[str, list[int] | float | str] = {}
        self._listeners: dict[str, list[Callable[[], None]]] = {}
        self._unsub_list: list[Callable[[], None]] = []
        self._pub_ids_task: asyncio.Task[Any] | Any | None = None

        # BLE remote buttons, combos, and beacon presence state
        self.ble_beacons: dict[str, dict[str, Any]] = {}
        self.ble_devices: dict[str, dict[str, Any]] = {}
        self.last_ble_button: dict[str, Any] | None = None
        self.last_ble_beacon: dict[str, Any] | None = None
        self.last_ble_device: dict[str, Any] | None = None
        self._ble_button_listeners: list[Callable[[], None]] = []
        self._ble_beacon_listeners: list[Callable[[], None]] = []
        self._ble_device_listeners: list[Callable[[], None]] = []

        self.enabled_categories: list[str] | None = entry_data.get(CONF_ENABLED_CATEGORIES)
        self.filter_active_ids: bool = entry_data.get(CONF_FILTER_ACTIVE_IDS, DEFAULT_FILTER_ACTIVE_IDS)
        self.active_can_ids: set[str] = set()

        self.commands = get_vehicle_commands(self.vehicle_id, enabled_categories=self.enabled_categories)
        self.monitored_can_ids = get_monitored_can_ids(self.vehicle_id, enabled_categories=self.enabled_categories)

    @property
    def effective_device_id(self) -> str:
        """Return the active or configured device ID."""
        return self.active_device_id or (self.device_id if self.device_id not in ("auto", "*", "") else "can-do")

    def _sub_topic(self, suffix: str) -> str:
        """Return device-scoped subscription topic when bound, else '+' wildcard."""
        dev = self.active_device_id or "+"
        return f"{self.base_topic}/{dev}/{suffix}"

    def _split_device_topic(self, topic: str) -> tuple[str, str] | None:
        """Strip base_topic prefix and split into (device_id, suffix)."""
        if not isinstance(topic, str):
            return None
        prefix = f"{self.base_topic}/"
        if not topic.startswith(prefix):
            return None
        rel = topic[len(prefix):]
        if "/" not in rel:
            return None
        dev_id, suffix = rel.split("/", 1)
        return (dev_id, suffix) if dev_id and suffix else None

    @property
    def status_topic(self) -> str:
        """Return MQTT LWT status topic."""
        return self._sub_topic("status")

    @property
    def state_wildcard_topic(self) -> str:
        """Return topic for CAN state reception."""
        return self._sub_topic("state/+")

    @property
    def ble_button_topic(self) -> str:
        """Return MQTT BLE button event topic."""
        return self._sub_topic("ble_button")

    @property
    def ble_beacon_topic(self) -> str:
        """Return MQTT BLE beacon proximity event topic."""
        return self._sub_topic("ble_beacon")

    @property
    def ble_device_topic(self) -> str:
        """Return MQTT BLE device connection event topic."""
        return self._sub_topic("ble_device")

    def _device_topic(self, suffix: str) -> str:
        """Return device-scoped MQTT topic when bound, else base topic."""
        if self.active_device_id:
            return f"{self.base_topic}/{self.active_device_id}/{suffix}"
        return f"{self.base_topic}/{suffix}"

    @property
    def tx_topic(self) -> str:
        """Return MQTT raw action burst topic."""
        return self._device_topic("tx")

    @property
    def notify_topic(self) -> str:
        """Return MQTT cluster notification topic."""
        return self._device_topic("notify")

    @property
    def sub_ids_topic(self) -> str:
        """Return MQTT dynamic monitored CAN IDs topic."""
        return self._device_topic("subscribe_ids")

    @property
    def active_ids_topic(self) -> str:
        """Return MQTT active CAN IDs topic."""
        return self._sub_topic("active_ids")

    @property
    def climate_topic(self) -> str:
        """Return MQTT remote climate set topic."""
        return self._device_topic("set/remote_climate")

    @property
    def nav_topic(self) -> str:
        """Return MQTT HUD navigation set topic."""
        return self._device_topic("nav/set")

    async def async_start(self) -> None:
        """Subscribe to MQTT topics and request vehicle telemetry IDs."""
        _LOGGER.info(
            "Starting CAN Do coordinator for device '%s' (vehicle: %s)",
            self.effective_device_id,
            self.vehicle_id,
        )

        subscriptions = (
            (self.status_topic, self._handle_status_message),
            (self.state_wildcard_topic, self._handle_can_state_message),
            (self.ble_button_topic, self._handle_ble_button_message),
            (self.ble_beacon_topic, self._handle_ble_beacon_message),
            (self.ble_device_topic, self._handle_ble_device_message),
            (self.active_ids_topic, self._handle_active_ids_message),
        )
        try:
            for topic, handler in subscriptions:
                unsub = await mqtt.async_subscribe(self.hass, topic, handler, qos=1)
                self._unsub_list.append(unsub)

            # Inform ESP32 edge device of the state CAN IDs once device ID is known
            if self.active_device_id and self.monitored_can_ids:
                await self.async_publish_monitored_ids()
        except Exception:
            await self.async_stop()
            raise

    async def async_stop(self) -> None:
        """Cancel pending background tasks and unsubscribe all MQTT handlers."""
        if self._pub_ids_task is not None:
            if not (hasattr(self._pub_ids_task, "done") and self._pub_ids_task.done() is True):
                self._pub_ids_task.cancel()
            self._pub_ids_task = None
        for unsub in self._unsub_list:
            unsub()
        self._unsub_list.clear()

    def _schedule_publish_monitored_ids(self) -> None:
        """Schedule background publish of monitored CAN IDs and track the task."""
        if not self.monitored_can_ids or not self.active_device_id:
            return
        if self._pub_ids_task is not None and not (
            hasattr(self._pub_ids_task, "done") and self._pub_ids_task.done() is True
        ):
            self._pub_ids_task.cancel()
        self._pub_ids_task = self.hass.async_create_task(
            self.async_publish_monitored_ids()
        )

    def _bind_device_id(self, dev_id: str | None) -> bool:
        """Bind coordinator to the first seen device ID; ignore messages from other devices."""
        if not dev_id or dev_id == "+":
            return False
        if self.active_device_id and dev_id != self.active_device_id:
            return False
        if not self.active_device_id:
            self.active_device_id = dev_id
            _LOGGER.info("CAN Do coordinator bound to active device ID '%s'", dev_id)
            self._schedule_publish_monitored_ids()
        return True

    async def async_publish_monitored_ids(self) -> None:
        """Publish list of monitored CAN IDs to ESP32."""
        payload = json.dumps(self.monitored_can_ids)
        target_topic = self.sub_ids_topic
        _LOGGER.debug(
            "Publishing %d monitored CAN IDs to %s",
            len(self.monitored_can_ids),
            target_topic,
        )
        await mqtt.async_publish(self.hass, target_topic, payload, qos=1, retain=True)

    @callback
    def _handle_status_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle LWT online/offline transition."""
        parsed = self._split_device_topic(msg.topic)
        if not parsed or parsed[1] != "status":
            return

        was_bound = self.active_device_id is not None
        if not self._bind_device_id(parsed[0]):
            return
        just_bound = not was_bound and self.active_device_id is not None

        status = msg.payload.strip().lower()
        was_avail = self.available
        new_avail = status == "online"
        if new_avail != was_avail:
            self.available = new_avail
            _LOGGER.info("CAN Do device '%s' status changed: %s", self.effective_device_id, status)
            self._notify_all_listeners()

        if new_avail and not was_avail and not just_bound and self.monitored_can_ids:
            self._schedule_publish_monitored_ids()

    @callback
    def _handle_active_ids_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming active bus manifest from ESP32."""
        parsed = self._split_device_topic(msg.topic)
        if not parsed or parsed[1] != "active_ids" or not self._bind_device_id(parsed[0]):
            return

        payload = msg.payload.strip()
        if not payload:
            return
        try:
            raw_ids = json.loads(payload)
            if isinstance(raw_ids, list):
                new_active = {normalize_can_id(cid) for cid in raw_ids if cid}
                if new_active != self.active_can_ids:
                    self.active_can_ids = new_active
                    _LOGGER.debug(
                        "Updated active CAN IDs from %s: %d IDs detected",
                        msg.topic,
                        len(self.active_can_ids),
                    )
                    self._notify_all_listeners()
        except (json.JSONDecodeError, TypeError, ValueError) as ex:
            _LOGGER.debug("Failed parsing active_ids payload from %s: %s", msg.topic, ex)

    def is_can_id_active(self, can_id: str | None) -> bool:
        """Return True if CAN ID has been actively observed on the vehicle bus."""
        if not self.filter_active_ids or not can_id:
            return True
        norm = normalize_can_id(can_id)
        return norm in self.active_can_ids

    @callback
    def _handle_can_state_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming raw CAN state frame."""
        # Topic format: {base_topic}/{device_id}/state/0x4CE
        parsed = self._split_device_topic(msg.topic)
        if not parsed or not parsed[1].startswith("state/"):
            return

        dev_id = parsed[0]
        can_id = normalize_can_id(parsed[1][len("state/"):])
        if not can_id or not self._bind_device_id(dev_id):
            return

        # Receiving live (non-retained) CAN states indicates the edge device is online
        raw_retain = getattr(msg, "retain", False)
        is_retained = raw_retain is True or (isinstance(raw_retain, int) and bool(raw_retain))
        if not self.available and not is_retained:
            self.available = True
            self._notify_all_listeners()

        hex_payload = msg.payload.strip()
        if not hex_payload:
            return

        # Handle direct decimal/numeric telemetry on non-0x entity topics (never overwrite raw 0x... CAN ID byte arrays!)
        if not can_id.startswith("0x"):
            num_match = _NUMERIC_SCALAR_RE.fullmatch(hex_payload)
            if num_match:
                clean_num = num_match.group(1)
                try:
                    val = float(clean_num)
                    if math.isfinite(val):
                        prev_val = self.can_states.get(can_id)
                        self.can_states[can_id] = val
                        delta_thresh = (
                            0.05
                            if ("." in clean_num or can_id in ("vbat", "cond_aux_12v_battery") or can_id.startswith("bms_"))
                            else 0.001
                        )
                        if (
                            not isinstance(prev_val, (int, float))
                            or isinstance(prev_val, bool)
                            or abs(prev_val - val) >= delta_thresh
                        ):
                            self._notify_can_listeners(can_id)
                            if can_id in ("vbat", "cond_aux_12v_battery"):
                                for k in ("vbat", "cond_aux_12v_battery"):
                                    if k == can_id:
                                        continue
                                    self.can_states[k] = val
                                    self._notify_can_listeners(k)
                            elif can_id.startswith("bms_"):
                                for alias in _BMS_ALIASES.get(can_id, []):
                                    if alias == can_id:
                                        continue
                                    self.can_states[alias] = val
                                    self._notify_can_listeners(alias)
                        return
                except ValueError:
                    pass

        # Raw CAN frames come on 0x... topics (2-16 even hex chars). Entity string labels (e.g. "P", "D", "Low Heat")
        # must never be truncated or parsed as hex byte arrays.
        if can_id.startswith("0x"):
            if len(hex_payload) < 2:
                return
            is_hex = (len(hex_payload) % 2 == 0) and len(hex_payload) <= 16 and all(c in "0123456789abcdefABCDEF" for c in hex_payload)
        else:
            is_hex = False
        if is_hex:
            try:
                byte_vals = [
                    int(hex_payload[i : i + 2], 16) for i in range(0, len(hex_payload), 2)
                ]
                prev_vals = self.can_states.get(can_id)
                self.can_states[can_id] = byte_vals

                # Skip duplicate identical frames
                if isinstance(prev_vals, list) and prev_vals == byte_vals:
                    return

                # Filter out alive counter / checksum changes (E-GMP Byte 7 / D8) on known telemetry IDs
                if can_id in _CRC_CAN_IDS and isinstance(prev_vals, list) and len(prev_vals) == len(byte_vals) == 8:
                    if prev_vals[:7] == byte_vals[:7]:
                        return

                self._notify_can_listeners(can_id)
            except ValueError:
                self.can_states[can_id] = hex_payload
                self._notify_can_listeners(can_id)
        else:
            # String or label state (e.g. "Locked / Lock", "Unlocked / Unlock", "All Doors Closed")
            prev_val = self.can_states.get(can_id)
            self.can_states[can_id] = hex_payload
            if prev_val != hex_payload:
                self._notify_can_listeners(can_id)

    def register_listener(self, can_id: str, callback_fn: Callable[[], None]) -> Callable[[], None]:
        """Register entity callback for a specific state CAN ID."""
        norm_id = normalize_can_id(can_id)
        if not norm_id:
            return lambda: None

        if norm_id not in self._listeners:
            self._listeners[norm_id] = []
        if callback_fn not in self._listeners[norm_id]:
            self._listeners[norm_id].append(callback_fn)

        def remove_listener() -> None:
            if norm_id in self._listeners and callback_fn in self._listeners[norm_id]:
                self._listeners[norm_id].remove(callback_fn)

        return remove_listener

    def _resolve_and_bind_ble_device(
        self, msg: mqtt.ReceiveMessage, expected_suffix: str, payload: dict[str, Any]
    ) -> bool:
        """Extract device_id from BLE topic/payload and bind or filter against active_device_id."""
        topic = getattr(msg, "topic", None)
        topic_dev_id: str | None = None
        if isinstance(topic, str):
            parsed = self._split_device_topic(topic)
            if parsed is not None:
                if parsed[1] != expected_suffix:
                    return False
                topic_dev_id = parsed[0]
            elif topic not in (f"{self.base_topic}/{expected_suffix}", expected_suffix):
                return False

        raw_payload_dev_id = payload.get("device_id") if isinstance(payload, dict) else None
        payload_dev_id = str(raw_payload_dev_id).strip() if raw_payload_dev_id else None
        if topic_dev_id and payload_dev_id and topic_dev_id != payload_dev_id:
            return False

        dev_id = topic_dev_id or payload_dev_id or ""
        return self._bind_device_id(dev_id)

    @callback
    def _handle_ble_button_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming BLE remote button or combo chord event."""
        try:
            payload = json.loads(msg.payload)
            if not isinstance(payload, dict):
                return
        except (json.JSONDecodeError, TypeError, ValueError) as ex:
            raw = msg.payload.strip() if isinstance(msg.payload, str) else ""
            if not raw or raw.startswith(("{", "[")):
                _LOGGER.debug("Failed parsing ble_button payload from %s: %s", getattr(msg, "topic", ""), ex)
                return
            payload = {"button": raw, "action": "press"}

        if not self._resolve_and_bind_ble_device(msg, "ble_button", payload):
            return

        action_str = str(payload.get("action", "press"))
        raw_hold = payload.get("hold_seconds")
        hold_seconds = 0
        if raw_hold is not None:
            try:
                hold_seconds = max(0, int(raw_hold))
            except (TypeError, ValueError):
                hold_seconds = 0
        if not hold_seconds:
            m = re.match(r"^hold_(\d+)s$", action_str, re.IGNORECASE)
            if m:
                hold_seconds = int(m.group(1))
        payload["hold_seconds"] = hold_seconds

        self.last_ble_button = payload
        _LOGGER.debug("BLE button event received: %s", payload)

        event_data = {
            "device_id": self.effective_device_id,
            "address": payload.get("address", ""),
            "button": payload.get("button", ""),
            "action": payload.get("action", "press"),
            "combo": payload.get("combo", ""),
            "hold_seconds": hold_seconds,
        }
        self.hass.bus.async_fire("cando_ble_button_event", event_data)

        for listener in list(self._ble_button_listeners):
            try:
                listener()
            except Exception as err:
                _LOGGER.exception("Error in BLE button listener: %s", err)

    @callback
    def _handle_ble_beacon_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming BLE beacon / iBeacon proximity event."""
        try:
            payload = json.loads(msg.payload)
            if not isinstance(payload, dict):
                return
        except (json.JSONDecodeError, TypeError, ValueError) as ex:
            _LOGGER.debug("Failed parsing ble_beacon payload from %s: %s", getattr(msg, "topic", ""), ex)
            return

        if not self._resolve_and_bind_ble_device(msg, "ble_beacon", payload):
            return

        key = payload.get("uuid") or payload.get("mac") or payload.get("name")
        if not key:
            return

        evt = payload.get("event", "proximity")
        is_pres = payload.get("present") if "present" in payload else payload.get("is_present")
        if is_pres is None:
            is_pres = evt in ("enter", "proximity", "present")
        is_pres = bool(is_pres)
        payload["present"] = is_pres

        self.ble_beacons[key] = payload
        self.last_ble_beacon = payload
        _LOGGER.debug("BLE beacon event received: %s", payload)

        event_data = {
            "device_id": self.effective_device_id,
            "uuid": payload.get("uuid", ""),
            "mac": payload.get("mac", ""),
            "name": payload.get("name", ""),
            "event": evt,
            "rssi": payload.get("rssi", 0),
            "major": payload.get("major", 0),
            "minor": payload.get("minor", 0),
            "present": is_pres,
        }
        self.hass.bus.async_fire("cando_ble_beacon_event", event_data)

        for listener in list(self._ble_beacon_listeners):
            try:
                listener()
            except Exception as err:
                _LOGGER.exception("Error in BLE beacon listener: %s", err)

    @callback
    def _handle_ble_device_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming BLE device connection / presence event."""
        try:
            payload = json.loads(msg.payload)
            if not isinstance(payload, dict):
                return
        except (json.JSONDecodeError, TypeError, ValueError) as ex:
            _LOGGER.debug("Failed parsing ble_device payload from %s: %s", getattr(msg, "topic", ""), ex)
            return

        if not self._resolve_and_bind_ble_device(msg, "ble_device", payload):
            return

        address = payload.get("address")
        if not address:
            return

        is_conn = payload.get("connected") if "connected" in payload else (payload.get("event", "connected") == "connected")
        payload["connected"] = bool(is_conn)

        self.ble_devices[address] = payload
        self.last_ble_device = payload
        _LOGGER.debug("BLE device event received: %s", payload)

        event_data = {
            "device_id": self.effective_device_id,
            "address": address,
            "name": payload.get("name", ""),
            "event": payload.get("event", "connected"),
            "rssi": payload.get("rssi", 0),
            "connected": payload["connected"],
        }
        self.hass.bus.async_fire("cando_ble_device_event", event_data)

        for listener in list(self._ble_device_listeners):
            try:
                listener()
            except Exception as err:
                _LOGGER.exception("Error in BLE device listener: %s", err)

    def register_ble_button_listener(self, callback_fn: Callable[[], None]) -> Callable[[], None]:
        """Register entity callback for BLE remote button events."""
        self._ble_button_listeners.append(callback_fn)
        def remove_listener() -> None:
            if callback_fn in self._ble_button_listeners:
                self._ble_button_listeners.remove(callback_fn)
        return remove_listener

    def register_ble_beacon_listener(self, callback_fn: Callable[[], None]) -> Callable[[], None]:
        """Register entity callback for BLE beacon events."""
        self._ble_beacon_listeners.append(callback_fn)
        def remove_listener() -> None:
            if callback_fn in self._ble_beacon_listeners:
                self._ble_beacon_listeners.remove(callback_fn)
        return remove_listener

    def register_ble_device_listener(self, callback_fn: Callable[[], None]) -> Callable[[], None]:
        """Register entity callback for BLE device presence/connection events."""
        self._ble_device_listeners.append(callback_fn)
        def remove_listener() -> None:
            if callback_fn in self._ble_device_listeners:
                self._ble_device_listeners.remove(callback_fn)
        return remove_listener

    def _notify_can_listeners(self, can_id: str) -> None:
        """Notify listeners subscribed to a specific CAN ID."""
        can_id_norm = normalize_can_id(can_id)
        listeners = self._listeners.get(can_id_norm, [])
        for listener in list(listeners):
            try:
                listener()
            except Exception as err:
                _LOGGER.exception("Error in entity listener callback: %s", err)

    def _notify_all_listeners(self) -> None:
        """Notify all listeners across all CAN IDs."""
        seen = set()
        for listeners in self._listeners.values():
            for listener in listeners:
                if listener not in seen:
                    seen.add(listener)
                    try:
                        listener()
                    except Exception as err:
                        _LOGGER.exception("Error in availability listener: %s", err)

    def get_can_payload(self, can_id: str | None) -> list[int] | None:
        """Retrieve current cached 8-byte payload for a CAN ID."""
        if not can_id:
            return None
        norm = normalize_can_id(can_id)
        val = self.can_states.get(norm)
        if val is None:
            raw_lower = can_id.strip().lower()
            if raw_lower != norm:
                val = self.can_states.get(raw_lower)
        return val if isinstance(val, list) else None

    def get_can_state(self, key: str | None) -> Any:
        """Retrieve any cached state (list, float, str) for an entity or CAN ID."""
        if not key:
            return None
        norm = normalize_can_id(key)
        val = self.can_states.get(norm)
        if val is None:
            raw_lower = key.strip().lower()
            if raw_lower != norm:
                val = self.can_states.get(raw_lower)
        return val

    async def async_send_action(
        self,
        can_id: str,
        delay_ms: int,
        steps: list[dict[str, Any]],
        bus: int | None = None,
    ) -> None:
        """Send raw action burst to ESP32 edge device over MQTT."""
        payload_obj: dict[str, Any] = {
            "can_id": can_id,
            "delay_ms": delay_ms,
            "steps": steps,
        }
        if bus is not None:
            payload_obj["bus"] = bus
        json_payload = json.dumps(payload_obj)
        _LOGGER.debug("Sending CAN burst to %s: %s", self.tx_topic, json_payload)
        await mqtt.async_publish(self.hass, self.tx_topic, json_payload, qos=1)

    async def async_send_entity_command(self, entity_id: str, command: str) -> None:
        """Send high-level entity command (e.g. lock/unlock) to ESP32 edge device over MQTT."""
        topic = self._device_topic(f"set/{entity_id}")
        await mqtt.async_publish(self.hass, topic, command, qos=1)

    async def async_send_remote_climate(
        self,
        action: str = "start",
        target_temp: float = 22.0,
        defrost: bool = False,
        duration_sec: int = 900,
    ) -> None:
        """Send remote climate command to ESP32 edge device over MQTT."""
        payload_obj = {
            "action": action,
            "temp": target_temp,
            "defrost": defrost,
            "duration": duration_sec,
        }
        json_payload = json.dumps(payload_obj)
        topic = self.climate_topic
        _LOGGER.debug("Sending remote climate command to %s: %s", topic, json_payload)
        await mqtt.async_publish(self.hass, topic, json_payload, qos=1)

    async def async_send_notification(
        self,
        message: str,
        level: str = "info",
        hold_ms: int | None = None,
    ) -> None:
        """Send cluster notification (OSD track popup) to ESP32 edge device over MQTT."""
        if not message or not str(message).strip():
            return
        payload_obj: dict[str, Any] = {
            "message": message,
            "level": level,
        }
        if hold_ms is not None:
            payload_obj["hold_ms"] = hold_ms
        json_payload = json.dumps(payload_obj)
        _LOGGER.debug("Sending cluster notification to %s: %s", self.notify_topic, json_payload)
        await mqtt.async_publish(self.hass, self.notify_topic, json_payload, qos=1)

    async def async_send_hud_nav(
        self,
        icon: int = 1,
        distance_meters: int = 0,
        bars: int = 0,
        street: str | None = None,
        speed_limit_kph: int = 0,
        camera_alert: bool = False,
        direction: int | None = None,
        lanes: int | None = None,
        lane_directions: list[int] | None = None,
        lane_recommended: list[int | bool] | None = None,
        platform: str | None = None,
    ) -> None:
        """Send HUD turn-by-turn navigation instruction to ESP32 edge device over MQTT."""
        payload_obj: dict[str, Any] = {
            "icon": icon,
            "distance": distance_meters,
            "bars": bars,
        }
        if street:
            payload_obj["street"] = street
        if speed_limit_kph:
            payload_obj["speed_limit"] = speed_limit_kph
        if camera_alert:
            payload_obj["camera_alert"] = camera_alert
        if direction is not None:
            payload_obj["direction"] = direction
        if lanes is not None:
            payload_obj["lanes"] = lanes
        if lane_directions is not None:
            payload_obj["lane_directions"] = lane_directions
        if lane_recommended is not None:
            payload_obj["lane_recommended"] = lane_recommended
        if platform:
            payload_obj["platform"] = platform

        json_payload = json.dumps(payload_obj)
        nav_topic = self.nav_topic
        _LOGGER.debug("Sending HUD navigation instruction to %s: %s", nav_topic, json_payload)
        await mqtt.async_publish(self.hass, nav_topic, json_payload, qos=1)

    async def async_clear_hud_nav(self) -> None:
        """Clear active HUD navigation guidance on ESP32 edge device."""
        payload_obj = {"action": "clear"}
        json_payload = json.dumps(payload_obj)
        nav_topic = self.nav_topic
        _LOGGER.debug("Clearing HUD navigation on %s", nav_topic)
        await mqtt.async_publish(self.hass, nav_topic, json_payload, qos=1)

    async def async_send_audio_dsp(
        self,
        volume: int | None = None,
        fader: int | None = None,
        balance: int | None = None,
        bass: int | None = None,
        midrange: int | None = None,
        treble: int | None = None,
        quiet_mode: bool | None = None,
        kids_mode: bool | None = None,
        master_mute: bool | None = None,
        surround: bool | None = None,
        sdvc: bool | None = None,
        can_id: str | None = None,
    ) -> None:
        """Send DSP external amplifier audio control command on CAN 0x520 / 0x60C."""
        target_can_id = can_id
        if not target_can_id:
            vid = self.vehicle_id.lower()
            target_can_id = (
                "0x60C"
                if "egmp" in vid
                or vid.startswith(("hi5", "hi6", "ev6", "gv60"))
                or vid in ("hyundai_ioniq5", "hyundai_ioniq6", "kia_ev6", "genesis_gv60")
                else "0x520"
            )

        cached = self.get_can_payload(target_can_id)
        if cached and len(cached) == 8:
            data = list(cached)
        else:
            data = [0x19, 0x00, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x00]

        if volume is not None:
            data[0] = max(0, min(75, int(volume)))

        if fader is not None:
            data[2] = max(0, min(20, int(fader + 10)))

        if balance is not None:
            data[3] = max(0, min(20, int(balance + 10)))

        if bass is not None:
            data[4] = max(0, min(20, int(bass + 10)))

        if midrange is not None:
            data[5] = max(0, min(20, int(midrange + 10)))

        if treble is not None:
            data[6] = max(0, min(20, int(treble + 10)))

        if master_mute is not None:
            if master_mute:
                data[7] |= 0x01
            else:
                data[7] &= ~0x01

        if quiet_mode is not None:
            if quiet_mode:
                data[7] |= 0x02
                if data[0] > 25:
                    data[0] = 25
                data[2] = 0x00
            else:
                data[7] &= ~0x02

        if kids_mode is not None:
            if kids_mode:
                data[7] |= 0x04
                data[2] = 0x14
                if data[0] > 25:
                    data[0] = 25
            else:
                data[7] &= ~0x04

        if sdvc is not None:
            if sdvc:
                data[7] |= 0x08
            else:
                data[7] &= ~0x08

        if surround is not None:
            if surround:
                data[7] |= 0x10
            else:
                data[7] &= ~0x10

        hex_payload = "".join(f"{b:02X}" for b in data)
        steps = [{"payload": hex_payload, "repeat": 1, "delay_ms": 20}]
        _LOGGER.debug("Sending Audio DSP command to %s: %s", target_can_id, hex_payload)
        await self.async_send_action(target_can_id, 20, steps)


