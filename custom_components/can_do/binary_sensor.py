"""Binary sensor platform for CAN Do integration."""

import logging
import time
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import check_match
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do binary sensor entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[BinarySensorEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "binary_sensor":
            entities.append(CanDoBinarySensorEntity(coordinator, cmd))

    # Add BLE Beacon Presence & Device Connectivity sensors
    entities.append(CanDoBleBeaconPresenceSensor(coordinator))
    entities.append(CanDoBleDeviceConnectedSensor(coordinator))

    async_add_entities(entities)


class CanDoBleBeaconPresenceSensor(BinarySensorEntity):
    """Binary sensor representing BLE beacon / iBeacon presence."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "BLE Beacon Presence"
    _attr_icon = "mdi:radar"
    _attr_device_class = BinarySensorDeviceClass.PRESENCE

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize BLE beacon presence sensor."""
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.device_id}_ble_beacon_presence"
        self._unsub = None

    @property
    def available(self) -> bool:
        """Return True so entity stays active."""
        return True

    @property
    def device_info(self):
        """Link to parent CAN Do Bridge device."""
        from homeassistant.helpers.entity import DeviceInfo
        from .const import VERSION
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.effective_device_id)},
            name=f"CAN Do Bridge ({self.coordinator.effective_device_id})",
            manufacturer="CAN Do",
            model="ESP32 Bridge",
            sw_version=VERSION,
        )

    @property
    def is_on(self) -> bool | None:
        """Return True if beacon is currently present."""
        last = self.coordinator.last_ble_beacon
        if not last:
            return False
        if "present" in last:
            return bool(last["present"])
        return last.get("event") in ("enter", "proximity")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return beacon details."""
        last = self.coordinator.last_ble_beacon or {}
        return {
            "uuid": last.get("uuid", ""),
            "mac": last.get("mac", ""),
            "name": last.get("name", ""),
            "rssi": last.get("rssi", 0),
            "event": last.get("event", ""),
            "major": last.get("major", 0),
            "minor": last.get("minor", 0),
        }

    async def async_added_to_hass(self) -> None:
        """Register listener when added to hass."""
        await super().async_added_to_hass()
        self._unsub = self.coordinator.register_ble_beacon_listener(self.async_write_ha_state)

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe listener on remove."""
        if self._unsub:
            self._unsub()
        await super().async_will_remove_from_hass()


class CanDoBleDeviceConnectedSensor(BinarySensorEntity):
    """Binary sensor representing BLE device / remote connection state."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "BLE Remote Connected"
    _attr_icon = "mdi:bluetooth-connect"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize BLE device connected sensor."""
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.device_id}_ble_device_connected"
        self._unsub = None

    @property
    def available(self) -> bool:
        """Return True so entity stays active."""
        return True

    @property
    def device_info(self):
        """Link to parent CAN Do Bridge device."""
        from homeassistant.helpers.entity import DeviceInfo
        from .const import VERSION
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.effective_device_id)},
            name=f"CAN Do Bridge ({self.coordinator.effective_device_id})",
            manufacturer="CAN Do",
            model="ESP32 Bridge",
            sw_version=VERSION,
        )

    @property
    def is_on(self) -> bool | None:
        """Return True if device is connected."""
        last = self.coordinator.last_ble_device
        if not last:
            return False
        if "connected" in last:
            return bool(last["connected"])
        return last.get("event") == "connected"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return device details."""
        last = self.coordinator.last_ble_device or {}
        return {
            "address": last.get("address", ""),
            "name": last.get("name", ""),
            "rssi": last.get("rssi", 0),
            "event": last.get("event", ""),
        }

    async def async_added_to_hass(self) -> None:
        """Register listener when added to hass."""
        await super().async_added_to_hass()
        self._unsub = self.coordinator.register_ble_device_listener(self.async_write_ha_state)

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe listener on remove."""
        if self._unsub:
            self._unsub()
        await super().async_will_remove_from_hass()



class CanDoBinarySensorEntity(CanDoEntity, BinarySensorEntity):
    """Binary sensor entity for doors, tailgate, seat occupancy, and touch sensors."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize binary sensor."""
        super().__init__(coordinator, command)
        self._attr_device_class = self._infer_device_class()
        self._is_turn_signal: bool = "turn_signal" in self.entity_id_str.lower() or "blinker" in self.entity_id_str.lower()
        self._last_active_time: float = 0.0

    def _infer_device_class(self) -> BinarySensorDeviceClass | None:
        """Infer device class from icon or entity identifier."""
        cid = self.entity_id_str.lower()
        if "door" in cid:
            return BinarySensorDeviceClass.DOOR
        if "tailgate" in cid or "trunk" in cid:
            return BinarySensorDeviceClass.OPENING
        if "touch" in cid or "hod" in cid:
            return BinarySensorDeviceClass.OCCUPANCY
        if "lock" in cid:
            return BinarySensorDeviceClass.LOCK
        if "sunroof" in cid or "window" in cid:
            return BinarySensorDeviceClass.WINDOW
        return None

    @property
    def is_on(self) -> bool | None:
        """Return True if binary sensor is triggered / active."""
        # 0. Direct entity string state from coordinator (e.g. "Open" / "Closed" / "Active" / "Off")
        direct_str = self.coordinator.get_can_payload(self.entity_id_str)
        if isinstance(direct_str, str):
            ds = direct_str.lower()
            if any(k in ds for k in ["open", "active", "touched", "detected", "unlocked", "on", "yes", "true", "charging"]):
                return True
            if any(k in ds for k in ["closed", "inactive", "released", "locked", "off", "no", "false"]):
                return False

        if not self.state_can_id:
            return None

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            if self._is_turn_signal and (time.time() - self._last_active_time < 3.0):
                return True
            return None

        # 1. Match against options if present
        is_active: bool | None = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if any(k in label for k in ["open", "active", "touched", "detected", "unlocked", "on", "yes", "true", "pressed"]):
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    is_active = True
                    break
            elif any(k in label for k in ["closed", "inactive", "released", "locked", "off", "no", "false"]):
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    is_active = False
                    break

        # 2. Check command-level match
        if is_active is None and "match" in self.command:
            is_active = check_match(payload, self.command["match"], self.command.get("mask"))

        if is_active is None:
            is_active = False

        # 3. For turn signals, apply trailing-edge 3.0s hold timer across blink cycles
        if self._is_turn_signal:
            now = time.time()
            if is_active:
                self._last_active_time = now
                return True
            return now - self._last_active_time < 3.0

        return is_active
