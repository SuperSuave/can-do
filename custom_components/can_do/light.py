"""Light platform for CAN Do integration (Ambient Mood Lighting)."""

import logging
from typing import Any, Dict, List

from homeassistant.components.light import ColorMode, LightEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import build_action_steps
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do light entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[LightEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "light":
            entities.append(CanDoLightEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoLightEntity(CanDoEntity, LightEntity):
    """Light entity controlling vehicle ambient mood lighting."""

    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize light entity."""
        super().__init__(coordinator, command)
        self._is_on: bool = False

    @property
    def is_on(self) -> bool:
        """Return True if light is on."""
        return self._is_on

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the ambient lighting on."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x4AD")
        delay_ms = net.get("delay_ms", 20)

        steps = build_action_steps(self.command)
        if steps:
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the ambient lighting off."""
        self._is_on = False
        self.async_write_ha_state()
