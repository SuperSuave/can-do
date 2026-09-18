"""Coordinator for CAN Do integration communicating purely over MQTT."""

import json
import logging
from typing import Any, Callable, Dict, List, Optional, Set

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback

from .catalog_loader import get_monitored_can_ids, get_vehicle_commands
from .const import CONF_BASE_TOPIC, CONF_DEVICE_ID, CONF_VEHICLE_ID, DEFAULT_BASE_TOPIC

_LOGGER = logging.getLogger(__name__)


class CanDoDataCoordinator:
    """Coordinates state updates and commands for CAN Do via Home Assistant MQTT."""

    def __init__(self, hass: HomeAssistant, entry_data: Dict[str, Any]) -> None:
        """Initialize the CAN Do coordinator."""
        self.hass = hass
        self.device_id: str = entry_data[CONF_DEVICE_ID]
        self.vehicle_id: str = entry_data[CONF_VEHICLE_ID]
        self.base_topic: str = entry_data.get(CONF_BASE_TOPIC, DEFAULT_BASE_TOPIC)

        self.available: bool = True
        self.can_states: Dict[str, List[int]] = {}
        self._listeners: Dict[str, List[Callable[[], None]]] = {}
        self._unsub_list: List[Callable[[], None]] = []

        self.commands = get_vehicle_commands(self.vehicle_id)
        self.monitored_can_ids = get_monitored_can_ids(self.vehicle_id)

    @property
    def status_topic(self) -> str:
        """Return MQTT LWT status topic."""
        return f"{self.base_topic}/{self.device_id}/status"

    @property
    def tx_topic(self) -> str:
        """Return MQTT raw action burst topic."""
        return f"{self.base_topic}/{self.device_id}/tx"

    @property
    def notify_topic(self) -> str:
        """Return MQTT cluster notification topic."""
        return f"{self.base_topic}/{self.device_id}/notify"

    @property
    def sub_ids_topic(self) -> str:
        """Return MQTT dynamic monitored CAN IDs topic."""
        return f"{self.base_topic}/{self.device_id}/subscribe_ids"

    @property
    def state_wildcard_topic(self) -> str:
        """Return wildcard topic for CAN state reception."""
        return f"{self.base_topic}/{self.device_id}/state/+"

    async def async_start(self) -> None:
        """Subscribe to MQTT topics and request vehicle telemetry IDs."""
        _LOGGER.info(
            "Starting CAN Do coordinator for device '%s' (vehicle: %s)",
            self.device_id,
            self.vehicle_id,
        )

        # 1. Subscribe to LWT status topic
        unsub_status = await mqtt.async_subscribe(
            self.hass, self.status_topic, self._handle_status_message, qos=1
        )
        self._unsub_list.append(unsub_status)

        # 2. Subscribe to raw CAN state updates
        unsub_states = await mqtt.async_subscribe(
            self.hass, self.state_wildcard_topic, self._handle_can_state_message, qos=1
        )
        self._unsub_list.append(unsub_states)

        # 3. Inform ESP32 edge device of the state CAN IDs we want it to publish
        if self.monitored_can_ids:
            await self.async_publish_monitored_ids()

    async def async_stop(self) -> None:
        """Unsubscribe all MQTT handlers."""
        for unsub in self._unsub_list:
            unsub()
        self._unsub_list.clear()

    async def async_publish_monitored_ids(self) -> None:
        """Publish list of monitored CAN IDs to ESP32."""
        payload = json.dumps(self.monitored_can_ids)
        _LOGGER.debug(
            "Publishing %d monitored CAN IDs to %s: %s",
            len(self.monitored_can_ids),
            self.sub_ids_topic,
            payload,
        )
        await mqtt.async_publish(self.hass, self.sub_ids_topic, payload, qos=1, retain=True)

    @callback
    def _handle_status_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle LWT online/offline transition."""
        status = msg.payload.strip().lower()
        new_avail = status == "online"
        if new_avail != self.available:
            self.available = new_avail
            _LOGGER.info("CAN Do device '%s' status changed: %s", self.device_id, status)
            self._notify_all_listeners()

    @callback
    def _handle_can_state_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming raw CAN state frame."""
        # Topic format: cando/{device_id}/state/0x4CE
        parts = msg.topic.split("/")
        if len(parts) < 4:
            return
        can_id = parts[3].lower()

        hex_payload = msg.payload.strip()
        if len(hex_payload) < 2:
            return

        try:
            byte_vals = [
                int(hex_payload[i : i + 2], 16) for i in range(0, len(hex_payload), 2)
            ]
            self.can_states[can_id] = byte_vals
            self._notify_can_listeners(can_id)
        except ValueError as err:
            _LOGGER.warning("Malformed hex payload on %s: %s (%s)", msg.topic, hex_payload, err)

    def register_listener(self, can_id: str, callback_fn: Callable[[], None]) -> Callable[[], None]:
        """Register entity callback for a specific state CAN ID."""
        can_id_norm = can_id.lower()
        if can_id_norm not in self._listeners:
            self._listeners[can_id_norm] = []
        self._listeners[can_id_norm].append(callback_fn)

        def remove_listener() -> None:
            if can_id_norm in self._listeners and callback_fn in self._listeners[can_id_norm]:
                self._listeners[can_id_norm].remove(callback_fn)

        return remove_listener

    def _notify_can_listeners(self, can_id: str) -> None:
        """Notify listeners subscribed to a specific CAN ID."""
        can_id_norm = can_id.lower()
        listeners = self._listeners.get(can_id_norm, [])
        for listener in listeners:
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

    def get_can_payload(self, can_id: Optional[str]) -> Optional[List[int]]:
        """Retrieve current cached 8-byte payload for a CAN ID."""
        if not can_id:
            return None
        return self.can_states.get(can_id.lower())

    async def async_send_action(
        self, can_id: str, delay_ms: int, steps: List[Dict[str, Any]]
    ) -> None:
        """Send raw action burst to ESP32 edge device over MQTT."""
        payload_obj = {
            "can_id": can_id,
            "delay_ms": delay_ms,
            "steps": steps,
        }
        json_payload = json.dumps(payload_obj)
        _LOGGER.debug("Sending CAN burst to %s: %s", self.tx_topic, json_payload)
        await mqtt.async_publish(self.hass, self.tx_topic, json_payload, qos=1)

    async def async_send_notification(self, message: str, level: str = "info") -> None:
        """Send cluster track popup notification to ESP32 edge device over MQTT."""
        payload_obj = {
            "message": message,
            "level": level,
        }
        json_payload = json.dumps(payload_obj)
        _LOGGER.info("Sending cluster notification to %s: %s", self.notify_topic, json_payload)
        await mqtt.async_publish(self.hass, self.notify_topic, json_payload, qos=1)
