"""Binary sensor platform for CAN Do integration."""

import logging
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
            return None

        # 1. Match against options if present
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if any(k in label for k in ["open", "active", "touched", "detected", "unlocked", "on", "yes", "true", "pressed"]):
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    return True
            elif any(k in label for k in ["closed", "inactive", "released", "locked", "off", "no", "false"]):
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    return False

        # 2. Check command-level match
        if "match" in self.command:
            return check_match(payload, self.command["match"], self.command.get("mask"))

        return False
