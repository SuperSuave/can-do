"""Number platform for CAN Do integration (Audio balance, fader, levels)."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.number import NumberEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import get_d_index
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do number entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[NumberEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "number":
            entities.append(CanDoNumberEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoNumberEntity(CanDoEntity, NumberEntity):
    """Number entity controlling numeric vehicle settings."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize number entity."""
        super().__init__(coordinator, command)
        net = command.get("network", {})
        self._attr_native_min_value = float(net.get("min", 0))
        self._attr_native_max_value = float(net.get("max", 100))
        self._attr_native_step = float(net.get("step", 1))

        self.byte_str = net.get("byte", "D1")
        self.offset = net.get("offset", 0)
        self.action_can_id = net.get("action_can_id", self.state_can_id or "0x000")
        self._value: float = self._attr_native_min_value

    @property
    def native_value(self) -> Optional[float]:
        """Return the current number value."""
        if not self.state_can_id:
            return self._value

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return self._value

        idx = get_d_index(self.byte_str)
        if 0 <= idx < len(payload):
            raw = payload[idx]
            self._value = float(raw - self.offset)

        return self._value

    async def async_set_native_value(self, value: float) -> None:
        """Set new numeric value on CAN bus."""
        raw_val = int(round(value + self.offset)) & 0xFF
        idx = get_d_index(self.byte_str)
        data = [0] * 8
        if 0 <= idx < 8:
            data[idx] = raw_val

        hex_payload = "".join(f"{b:02X}" for b in data)
        steps = [{"payload": hex_payload, "repeat": 1, "delay_ms": 20}]

        _LOGGER.info("Setting %s to %.0f (raw 0x%02X)", self.name, value, raw_val)
        await self.coordinator.async_send_action(self.action_can_id, 20, steps)

        self._value = value
        self.async_write_ha_state()
