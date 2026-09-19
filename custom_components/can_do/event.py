"""Event platform for CAN Do integration (Steering wheel & console button events)."""

import logging
from typing import Any, Dict, List

from homeassistant.components.event import EventEntity
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
    """Set up CAN Do event entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[EventEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "event":
            entities.append(CanDoEventEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoEventEntity(CanDoEntity, EventEntity):
    """Event entity representing steering wheel and physical button press events."""

    _attr_event_types = ["press"]

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize event entity."""
        super().__init__(coordinator, command)
        self._last_matched: bool = False

    def _handle_can_update(self) -> None:
        """Evaluate if incoming CAN frame triggers the event."""
        if not self.state_can_id:
            return

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return

        is_now_match = False
        if "match" in self.command:
            is_now_match = check_match(payload, self.command["match"], self.command.get("mask"))
        elif self.command.get("options"):
            first_opt = self.command["options"][0]
            match_spec = first_opt.get("match") or first_opt.get("payload")
            if match_spec:
                is_now_match = check_match(payload, match_spec, first_opt.get("mask"))

        # Fire event on rising edge transition (unmatched -> matched)
        if is_now_match and not self._last_matched:
            _LOGGER.debug("Button event fired for '%s'", self.name)
            self._trigger_event("press")
            self.async_write_ha_state()

        self._last_matched = is_now_match
