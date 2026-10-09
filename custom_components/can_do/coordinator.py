"""Coordinator for CAN Do integration communicating purely over MQTT."""

import json
import logging
from collections.abc import Callable
from typing import Any

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback

from .catalog_loader import get_monitored_can_ids, get_vehicle_commands
from .const import (
    CONF_BASE_TOPIC,
    CONF_DEVICE_ID,
    CONF_VEHICLE_ID,
    DEFAULT_BASE_TOPIC,
    DEFAULT_VEHICLE_ID,
)

_LOGGER = logging.getLogger(__name__)

_BMS_ALIASES: dict[str, list[str]] = {
    "bms_soc": ["bms_display_soc", "cond_hv_battery_soc"],
    "bms_display_soc": ["bms_soc"],
    "bms_hv_v": ["bms_hv_voltage"],
    "bms_hv_voltage": ["bms_hv_v"],
    "bms_hv_a": ["bms_hv_current"],
    "bms_hv_current": ["bms_hv_a"],
    "bms_hv_kw": ["bms_hv_power_kw"],
    "bms_hv_power_kw": ["bms_hv_kw"],
    "bms_cell_delta_mv": ["bms_cell_delta_mv"],
}


class CanDoDataCoordinator:
    """Coordinates state updates and commands for CAN Do via Home Assistant MQTT."""

    def __init__(self, hass: HomeAssistant, entry_data: dict[str, Any]) -> None:
        """Initialize the CAN Do coordinator."""
        self.hass = hass
        self.device_id: str = entry_data.get(CONF_DEVICE_ID, "auto")
        self.vehicle_id: str = entry_data.get(CONF_VEHICLE_ID, DEFAULT_VEHICLE_ID)
        self.base_topic: str = entry_data.get(CONF_BASE_TOPIC, DEFAULT_BASE_TOPIC)
        self.active_device_id: str | None = None if self.device_id in ("auto", "*", "") else self.device_id

        self.available: bool = True
        self.can_states: dict[str, list[int]] = {}
        self._listeners: dict[str, list[Callable[[], None]]] = {}
        self._unsub_list: list[Callable[[], None]] = []

        self.commands = get_vehicle_commands(self.vehicle_id)
        self.monitored_can_ids = get_monitored_can_ids(self.vehicle_id)

    @property
    def effective_device_id(self) -> str:
        """Return the active or configured device ID."""
        return self.active_device_id or (self.device_id if self.device_id not in ("auto", "*", "") else "can-do")

    @property
    def status_topic(self) -> str:
        """Return MQTT LWT status topic wildcard."""
        return f"{self.base_topic}/+/status"

    @property
    def state_wildcard_topic(self) -> str:
        """Return wildcard topic for CAN state reception."""
        return f"{self.base_topic}/+/state/+"

    @property
    def direct_state_topic(self) -> str:
        """Return direct state topic for entity state reception."""
        return f"{self.base_topic}/state/+"

    @property
    def tx_topic(self) -> str:
        """Return MQTT raw action burst topic."""
        return f"{self.base_topic}/{self.effective_device_id}/tx"

    @property
    def notify_topic(self) -> str:
        """Return MQTT cluster notification topic."""
        return f"{self.base_topic}/{self.effective_device_id}/notify"

    @property
    def sub_ids_topic(self) -> str:
        """Return MQTT dynamic monitored CAN IDs topic."""
        return f"{self.base_topic}/{self.effective_device_id}/subscribe_ids"

    async def async_start(self) -> None:
        """Subscribe to MQTT topics and request vehicle telemetry IDs."""
        _LOGGER.info(
            "Starting CAN Do coordinator for device '%s' (vehicle: %s)",
            self.effective_device_id,
            self.vehicle_id,
        )

        # 1. Subscribe to LWT status topic wildcard (e.g. cando/+/status)
        unsub_status = await mqtt.async_subscribe(
            self.hass, self.status_topic, self._handle_status_message, qos=1
        )
        self._unsub_list.append(unsub_status)

        # 2. Subscribe to raw CAN state updates and entity state updates
        unsub_states = await mqtt.async_subscribe(
            self.hass, self.state_wildcard_topic, self._handle_can_state_message, qos=1
        )
        self._unsub_list.append(unsub_states)
        unsub_direct = await mqtt.async_subscribe(
            self.hass, self.direct_state_topic, self._handle_can_state_message, qos=1
        )
        self._unsub_list.append(unsub_direct)

        # 3. Inform ESP32 edge device of the state CAN IDs we want it to publish
        if self.monitored_can_ids:
            await self.async_publish_monitored_ids()
            # Also publish to known hardware MAC topic if different
            if self.effective_device_id != "can-do-6C84":
                try:
                    await mqtt.async_publish(
                        self.hass,
                        f"{self.base_topic}/can-do-6C84/subscribe_ids",
                        json.dumps(self.monitored_can_ids),
                        qos=1,
                        retain=True,
                    )
                except Exception as err:
                    _LOGGER.warning("Could not publish initial subscribe_ids: %s", err)

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
        if self.sub_ids_topic != f"{self.base_topic}/subscribe_ids":
            await mqtt.async_publish(self.hass, f"{self.base_topic}/subscribe_ids", payload, qos=1, retain=True)

    @callback
    def _handle_status_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle LWT online/offline transition."""
        parts = msg.topic.split("/")
        if len(parts) >= 3:
            dev_id = parts[1]
            if dev_id != "+":
                if self.active_device_id and dev_id != self.active_device_id:
                    # Ignore messages from other devices if we are already bound
                    return
                elif not self.active_device_id:
                    self.active_device_id = dev_id
                    _LOGGER.info("CAN Do coordinator bound to active device ID '%s'", dev_id)

        status = msg.payload.strip().lower()
        new_avail = status == "online"
        if new_avail != self.available:
            self.available = new_avail
            _LOGGER.info("CAN Do device '%s' status changed: %s", self.effective_device_id, status)
            self._notify_all_listeners()

        if new_avail and self.monitored_can_ids:
            self.hass.async_create_task(self.async_publish_monitored_ids())

    @callback
    def _handle_can_state_message(self, msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming raw CAN state frame."""
        # Topic format: cando/{device_id}/state/0x4CE
        parts = msg.topic.split("/")
        if len(parts) >= 4 and parts[2] == "state":
            dev_id = parts[1]
            can_id = parts[3].lower()
        elif len(parts) >= 3 and parts[1] == "state":
            dev_id = "+"
            can_id = parts[2].lower()
        else:
            return

        if dev_id != "+":
            if self.active_device_id and dev_id != self.active_device_id:
                # Ignore messages from other devices if we are already bound
                return
            elif not self.active_device_id:
                self.active_device_id = dev_id
                _LOGGER.info("CAN Do coordinator bound to active device ID '%s'", dev_id)

        # Receiving live CAN states indicates the edge device is online
        if not self.available:
            self.available = True
            self._notify_all_listeners()

        hex_payload = msg.payload.strip()
        if not hex_payload:
            return

        # Handle direct decimal float telemetry (e.g. MeatPi WiCAN 12V battery ADC: "12.6", BMS telemetry)
        if can_id in ("vbat", "cond_aux_12v_battery", "0x1cf") or can_id.startswith("bms_") or "." in hex_payload:
            try:
                clean_num = hex_payload.split()[0]
                val = float(clean_num)
                prev_val = self.can_states.get(can_id)
                self.can_states[can_id] = val
                if prev_val is None or abs(prev_val - val) >= 0.05:
                    self._notify_can_listeners(can_id)
                    if can_id in ("vbat", "cond_aux_12v_battery", "0x1cf"):
                        for k in ("vbat", "cond_aux_12v_battery", "0x1cf"):
                            self.can_states[k] = val
                            self._notify_can_listeners(k)
                    elif can_id.startswith("bms_"):
                        for alias in _BMS_ALIASES.get(can_id, []):
                            self.can_states[alias] = val
                            self._notify_can_listeners(alias)
                return
            except ValueError:
                pass

        if len(hex_payload) < 2:
            return

        # Check if payload is a raw hex CAN frame (even length, <=16 chars, valid hex)
        is_hex = (len(hex_payload) % 2 == 0) and len(hex_payload) <= 16 and all(c in "0123456789abcdefABCDEF" for c in hex_payload)
        if is_hex:
            try:
                byte_vals = [
                    int(hex_payload[i : i + 2], 16) for i in range(0, len(hex_payload), 2)
                ]
                prev_vals = self.can_states.get(can_id)
                self.can_states[can_id] = byte_vals

                # Skip duplicate identical frames
                if prev_vals is not None and prev_vals == byte_vals:
                    return

                # Filter out alive counter / checksum changes (E-GMP Byte 7 / D8)
                if prev_vals is not None and len(prev_vals) == len(byte_vals) == 8:
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

    def get_can_payload(self, can_id: str | None) -> list[int] | None:
        """Retrieve current cached 8-byte payload for a CAN ID."""
        if not can_id:
            return None
        return self.can_states.get(can_id.lower())

    async def async_send_action(
        self, can_id: str, delay_ms: int, steps: list[dict[str, Any]]
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
        if self.tx_topic != f"{self.base_topic}/tx":
            await mqtt.async_publish(self.hass, f"{self.base_topic}/tx", json_payload, qos=1)

    async def async_send_entity_command(self, entity_id: str, command: str) -> None:
        """Send high-level entity command (e.g. lock/unlock) to ESP32 edge device over MQTT."""
        topic = f"{self.base_topic}/{self.effective_device_id}/set/{entity_id}"
        await mqtt.async_publish(self.hass, topic, command, qos=1)
        if topic != f"{self.base_topic}/set/{entity_id}":
            await mqtt.async_publish(self.hass, f"{self.base_topic}/set/{entity_id}", command, qos=1)

    async def async_send_notification(
        self,
        message: str,
        level: str = "info",
        caller: str | None = None,
        popup_type: str | None = None,
        hold_ms: int | None = None,
    ) -> None:
        """Send cluster notification (track popup or call popup) to ESP32 edge device over MQTT."""
        payload_obj: dict[str, Any] = {
            "message": message,
            "level": level,
        }
        if caller is not None:
            payload_obj["caller"] = caller
        if popup_type is not None:
            payload_obj["type"] = popup_type
        if hold_ms is not None:
            payload_obj["hold_ms"] = hold_ms
        json_payload = json.dumps(payload_obj)
        _LOGGER.info("Sending cluster notification to %s: %s", self.notify_topic, json_payload)
        await mqtt.async_publish(self.hass, self.notify_topic, json_payload, qos=1)
        if self.notify_topic != f"{self.base_topic}/notify":
            await mqtt.async_publish(self.hass, f"{self.base_topic}/notify", json_payload, qos=1)

    async def async_send_hud_nav(
        self,
        icon: int = 1,
        distance_meters: int = 0,
        bars: int = 0,
        street: str | None = None,
        speed_limit_kph: int = 0,
        camera_alert: bool = False,
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

        json_payload = json.dumps(payload_obj)
        nav_topic = f"{self.base_topic}/nav/set"
        _LOGGER.info("Sending HUD navigation instruction to %s: %s", nav_topic, json_payload)
        await mqtt.async_publish(self.hass, nav_topic, json_payload, qos=1)

    async def async_clear_hud_nav(self) -> None:
        """Clear active HUD navigation guidance on ESP32 edge device."""
        payload_obj = {"action": "clear"}
        json_payload = json.dumps(payload_obj)
        nav_topic = f"{self.base_topic}/nav/set"
        _LOGGER.info("Clearing HUD navigation on %s", nav_topic)
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
            target_can_id = (
                "0x60C"
                if "egmp" in self.vehicle_id
                or self.vehicle_id.startswith("hi5")
                or self.vehicle_id.startswith("ev6")
                or self.vehicle_id.startswith("gv60")
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
        _LOGGER.info("Sending Audio DSP command to %s: %s", target_can_id, hex_payload)
        await self.async_send_action(target_can_id, 20, steps)


