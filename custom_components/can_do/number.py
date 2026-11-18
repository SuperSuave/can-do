"""Number platform for CAN Do integration (Audio balance, fader, levels)."""

import logging
from typing import Any

from homeassistant.components.number import NumberEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import resolve_base_payload
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
    entities: list[NumberEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "number":
            entities.append(CanDoNumberEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoNumberEntity(CanDoEntity, NumberEntity):
    """Number entity controlling numeric vehicle settings."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
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
    def native_value(self) -> float | None:
        """Return the current number value."""
        direct = self.coordinator.get_can_state(self.entity_id_str)
        if direct is not None:
            if isinstance(direct, (int, float)):
                self._value = max(self._attr_native_min_value, min(self._attr_native_max_value, float(direct)))
                return self._value
            if isinstance(direct, str):
                import re
                m = re.search(r"[-+]?\d*\.?\d+", direct)
                if m:
                    try:
                        self._value = max(self._attr_native_min_value, min(self._attr_native_max_value, float(m.group(0))))
                        return self._value
                    except ValueError:
                        pass

        if not self.state_can_id:
            return self._value

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload or not isinstance(payload, list):
            return self._value

        idx = get_d_index(self.byte_str)
        if 0 <= idx < len(payload):
            raw = payload[idx]
            val = float(raw - self.offset)
            self._value = max(self._attr_native_min_value, min(self._attr_native_max_value, val))

        return self._value

    async def async_set_native_value(self, value: float) -> None:
        """Set new numeric value on CAN bus."""
        raw_val = round(value + self.offset) & 0xFF
        idx = get_d_index(self.byte_str)

        # Preserve latest known CAN frame (only when state/action IDs match) or fall back to neutral base payload
        data = (
            resolve_base_payload(
                self.coordinator, self.command, self.action_can_id, self.state_can_id
            )
            or [0] * 8
        )

        if 0 <= idx < 8:
            data[idx] = raw_val

        hex_payload = "".join(f"{b:02X}" for b in data)
        steps = [{"payload": hex_payload, "repeat": 1, "delay_ms": 20}]
        bus = self.command.get("network", {}).get("bus")

        _LOGGER.info("Setting %s to %.0f (raw 0x%02X)", self.name, value, raw_val)
        await self.coordinator.async_send_action(self.action_can_id, 20, steps, bus=bus)

        self._value = value
        self.async_write_ha_state()
