"""Select platform for CAN Do integration."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import build_action_steps
from .catalog_loader import check_match
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do select entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[SelectEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "select":
            entities.append(CanDoSelectEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoSelectEntity(CanDoEntity, SelectEntity):
    """Select entity representing multi-state CAN options (modes, comfort levels)."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize select entity."""
        super().__init__(coordinator, command)
        self._attr_options = [
            opt["label"] for opt in self.command.get("options", []) if "label" in opt
        ]
        self._current_option: Optional[str] = (
            self._attr_options[0] if self._attr_options else None
        )

    @property
    def current_option(self) -> Optional[str]:
        """Return the selected entity option."""
        if not self.state_can_id:
            return self._current_option

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return self._current_option

        for opt in self.command.get("options", []):
            match_spec = opt.get("match") or opt.get("payload")
            if match_spec and check_match(payload, match_spec, opt.get("mask")):
                return opt.get("label")

        return self._current_option

    async def async_select_option(self, option: str) -> None:
        """Change the selected option."""
        if option not in self.options:
            _LOGGER.warning("Option '%s' not in valid options: %s", option, self.options)
            return

        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", self.state_can_id or "0x000")
        delay_ms = net.get("delay_ms", 20)

        target_opt = None
        for opt in self.command.get("options", []):
            if opt.get("label") == option:
                target_opt = opt
                break

        steps = build_action_steps(self.command, target_opt)
        if steps:
            _LOGGER.info("Selecting option '%s' for '%s'", option, self.name)
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        self._current_option = option
        self.async_write_ha_state()
