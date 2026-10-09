"""Lock platform for CAN Do integration."""

import logging
from typing import Any

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
    entities: list[LockEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "lock":
            entities.append(CanDoLockEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoLockEntity(CanDoEntity, LockEntity):
    """Lock entity representing vehicle door locks."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize lock entity."""
        super().__init__(coordinator, command)
        self._is_locked: bool | None = None

    @property
    def is_locked(self) -> bool | None:
        """Return True if the vehicle is locked."""
        # 1. Direct state (e.g. from cando/state/{entity_id} or edge engine string)
        direct_state = self.coordinator.can_states.get(self.entity_id_str.lower())
        if direct_state is not None:
            if isinstance(direct_state, bool):
                self._is_locked = direct_state
                return direct_state
            if isinstance(direct_state, str):
                s = direct_state.lower()
                if "unlock" in s:
                    self._is_locked = False
                    return False
                elif "lock" in s:
                    self._is_locked = True
                    return True

        # 2. Check if raw state_can_id has string label state
        if self.state_can_id:
            raw_state = self.coordinator.can_states.get(self.state_can_id.lower())
            if isinstance(raw_state, str):
                s = raw_state.lower()
                if "unlock" in s:
                    self._is_locked = False
                    return False
                elif "lock" in s:
                    self._is_locked = True
                    return True

        # 3. Check parsed raw CAN payload bytes against options
        if self.state_can_id:
            payload = self.coordinator.get_can_payload(self.state_can_id)
            if payload:
                for opt in self.command.get("options", []):
                    label = opt.get("label", "").lower()
                    match_spec = opt.get("match") or opt.get("payload")
                    if not match_spec:
                        continue

                    mask = opt.get("mask")
                    # Fallback mask for door_locks on 0x411 if mask is not explicitly configured
                    if not mask and self.state_can_id.lower() == "0x411":
                        mask = {"D3": "0x40"}

                    if "unlock" in label and check_match(payload, match_spec, mask):
                        self._is_locked = False
                        return False
                    elif "lock" in label and "unlock" not in label and check_match(payload, match_spec, mask):
                        self._is_locked = True
                        return True

        return self._is_locked

    async def async_lock(self, **kwargs: Any) -> None:
        """Send lock CAN burst and entity command to the vehicle."""
        self._is_locked = True
        self.async_write_ha_state()

        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x000")
        delay_ms = net.get("delay_ms", 20)

        target_opt = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if "lock" in label and "unlock" not in label:
                target_opt = opt
                break

        steps = build_action_steps(self.command, target_opt)
        if steps and action_can_id != "0x000":
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        # Dispatch high-level entity command to ESP32 edge engine
        await self.coordinator.async_send_entity_command(self.entity_id_str, "lock")

    async def async_unlock(self, **kwargs: Any) -> None:
        """Send unlock CAN burst and entity command to the vehicle."""
        self._is_locked = False
        self.async_write_ha_state()

        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x000")
        delay_ms = net.get("delay_ms", 20)

        target_opt = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if "unlock" in label:
                target_opt = opt
                break

        steps = build_action_steps(self.command, target_opt)
        if steps and action_can_id != "0x000":
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        # Dispatch high-level entity command to ESP32 edge engine
        await self.coordinator.async_send_entity_command(self.entity_id_str, "unlock")
