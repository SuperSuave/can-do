"""Sensor platform for CAN Do integration."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import check_match, get_d_index, parse_hex_val
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do sensor entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[SensorEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "sensor":
            entities.append(CanDoSensorEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoSensorEntity(CanDoEntity, SensorEntity):
    """Sensor entity decoding vehicle telemetry and status from CAN."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize sensor entity."""
        super().__init__(coordinator, command)

    @property
    def native_value(self) -> Optional[str]:
        """Return the current sensor state."""
        if not self.state_can_id:
            return None

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return None

        # 1. Match against options if present
        for opt in self.command.get("options", []):
            match_spec = opt.get("match")
            if match_spec and check_match(payload, match_spec, opt.get("mask")):
                return opt.get("label")

            evaluate = opt.get("evaluate")
            if evaluate:
                byte_str = evaluate.get("byte", "")
                op = evaluate.get("operator", "")
                val, _ = parse_hex_val(evaluate.get("value", 0))
                idx = get_d_index(byte_str)
                if 0 <= idx < len(payload):
                    actual = payload[idx]
                    if op == "greater_than" and actual > val:
                        return opt.get("label")
                    elif op == "less_than" and actual < val:
                        return opt.get("label")
                    elif op in ("equal", "eq") and actual == val:
                        return opt.get("label")

        # 2. Check command-level match
        if "match" in self.command:
            if check_match(payload, self.command["match"], self.command.get("mask")):
                return "Active"
            return "Inactive"

        # 3. If no match matched, return hex string of payload
        return "".join(f"{b:02X}" for b in payload)

    @property
    def extra_state_attributes(self) -> Dict[str, Any]:
        """Return raw CAN telemetry bytes as state attributes."""
        attrs: Dict[str, Any] = {}
        if self.state_can_id:
            payload = self.coordinator.get_can_payload(self.state_can_id)
            if payload:
                attrs["raw_hex"] = "".join(f"{b:02X}" for b in payload)
                for i, b in enumerate(payload):
                    attrs[f"D{i+1}"] = f"0x{b:02X}"
        return attrs
