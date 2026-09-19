"""Button platform for CAN Do integration."""

import logging
from typing import Any, Dict, List

from homeassistant.components.button import ButtonEntity
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
    """Set up CAN Do button entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[ButtonEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "button":
            entities.append(CanDoButtonEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoButtonEntity(CanDoEntity, ButtonEntity):
    """Button entity executing momentary CAN pulses or commands."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize button entity."""
        super().__init__(coordinator, command)

    async def async_press(self) -> None:
        """Handle button press by dispatching CAN action burst."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x000")
        delay_ms = net.get("delay_ms", 20)

        # Use default option if present, else first option
        default_opt = None
        for opt in self.command.get("options", []):
            if opt.get("default"):
                default_opt = opt
                break
        if not default_opt and self.command.get("options"):
            default_opt = self.command["options"][0]

        steps = build_action_steps(self.command, default_opt)
        if steps:
            _LOGGER.info("Pressing button '%s' (ID %s, %d steps)", self.name, action_can_id, len(steps))
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)
        else:
            _LOGGER.warning("Button '%s' has no valid action steps defined", self.name)
