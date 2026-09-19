"""Lock platform for CAN Do integration."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.lock import LockEntity
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
    """Set up CAN Do lock entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[LockEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "lock":
            entities.append(CanDoLockEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoLockEntity(CanDoEntity, LockEntity):
    """Lock entity representing vehicle door locks."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize lock entity."""
        super().__init__(coordinator, command)

    @property
    def is_locked(self) -> Optional[bool]:
        """Return True if the vehicle is locked."""
        if not self.state_can_id:
            return None

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return None

        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            match_spec = opt.get("match") or opt.get("payload")
            if not match_spec:
                continue

            if "unlocked" in label and check_match(payload, match_spec, opt.get("mask")):
                return False
            elif "locked" in label and check_match(payload, match_spec, opt.get("mask")):
                return True

        return None

    async def async_lock(self, **kwargs: Any) -> None:
        """Send lock CAN burst to the vehicle."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x000")
        delay_ms = net.get("delay_ms", 20)

        target_opt = None
        for opt in self.command.get("options", []):
            if "locked" in opt.get("label", "").lower():
                target_opt = opt
                break

        steps = build_action_steps(self.command, target_opt)
        if steps:
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

    async def async_unlock(self, **kwargs: Any) -> None:
        """Send unlock CAN burst to the vehicle."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x000")
        delay_ms = net.get("delay_ms", 20)

        target_opt = None
        for opt in self.command.get("options", []):
            if "unlocked" in opt.get("label", "").lower():
                target_opt = opt
                break

        steps = build_action_steps(self.command, target_opt)
        if steps:
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)
