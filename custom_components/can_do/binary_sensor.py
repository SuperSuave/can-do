"""Binary sensor platform for CAN Do integration."""

import logging
import time
from typing import Any, Dict, List, Optional

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
    entities: List[BinarySensorEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "binary_sensor":
            entities.append(CanDoBinarySensorEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoBinarySensorEntity(CanDoEntity, BinarySensorEntity):
    """Binary sensor entity for doors, tailgate, seat occupancy, and touch sensors."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize binary sensor."""
        super().__init__(coordinator, command)
        self._attr_device_class = self._infer_device_class()
        self._is_turn_signal: bool = "turn_signal" in self.entity_id_str.lower() or "blinker" in self.entity_id_str.lower()
        self._last_active_time: float = 0.0

    def _infer_device_class(self) -> Optional[BinarySensorDeviceClass]:
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
    def is_on(self) -> Optional[bool]:
        """Return True if binary sensor is triggered / active."""
        if not self.state_can_id:
            return None

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            if self._is_turn_signal and (time.time() - self._last_active_time < 3.0):
                return True
            return None

        # 1. Match against options if present
        is_active: Optional[bool] = None
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
            if now - self._last_active_time < 3.0:
                return True
            return False

        return is_active
