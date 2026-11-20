"""Switch platform for CAN Do integration."""

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import (
    build_action_steps,
    find_switch_option,
    is_off_option_label,
    is_on_option_label,
    option_matches,
    resolve_base_payload,
    resolve_effective_mask,
)
from .catalog_loader import check_match
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do switch entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SwitchEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "switch":
            entities.append(CanDoSwitchEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoSwitchEntity(CanDoEntity, SwitchEntity):
    """Switch entity representing toggleable CAN functions."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize switch entity."""
        super().__init__(coordinator, command)
        self._is_on: bool = False

    @property
    def is_on(self) -> bool:
        """Return True if switch is on."""
        # 1. Direct entity string/boolean/numeric state from coordinator (e.g. "ON" / "OFF" / 1.0)
        direct_str = self.coordinator.get_can_state(self.entity_id_str)
        if isinstance(direct_str, bool):
            return direct_str
        if isinstance(direct_str, (int, float)):
            return bool(direct_str != 0)
        if isinstance(direct_str, str):
            ds = direct_str.strip().upper()
            if is_off_option_label(direct_str) or ds in ("FALSE", "0"):
                return False
            if is_on_option_label(direct_str) or ds in ("TRUE", "1", "HEAT"):
                return True

        if not self.state_can_id:
            return self._is_on

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return self._is_on

        # Check options using word-boundary ON/OFF detection
        on_opt = find_switch_option(self.command, True)
        for opt in self.command.get("options", []):
            label = opt.get("label", "")
            match_spec = opt.get("match") or opt.get("payload")
            is_off = is_off_option_label(label)
            is_on = is_on_option_label(label) or (on_opt is opt and not is_off)
            if option_matches(payload, opt, self.command, fallback_to_payload=True):
                if is_off:
                    return False
                if is_on:
                    return True
            elif not match_spec and is_on and opt.get("default") and self._is_on:
                return True

        # Check command-level match
        if "match" in self.command:
            return check_match(payload, self.command["match"], resolve_effective_mask(self.command))

        return self._is_on

    async def _async_set_switch_state(self, turn_on: bool) -> None:
        """Turn the switch on or off."""
        if "remote_climate" in self.entity_id_str:
            await self.coordinator.async_send_remote_climate(
                action="start" if turn_on else "stop"
            )
            self._is_on = turn_on
            self.async_write_ha_state()
            return

        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", self.state_can_id or "0x000")
        delay_ms = net.get("delay_ms", 20)
        bus = net.get("bus")

        target_opt = find_switch_option(self.command, turn_on)
        base_payload = resolve_base_payload(
            self.coordinator, self.command, action_can_id, self.state_can_id
        )

        steps = build_action_steps(self.command, target_opt, base_payload)
        if steps:
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps, bus=bus)

        self._is_on = turn_on
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the switch on."""
        await self._async_set_switch_state(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the switch off."""
        await self._async_set_switch_state(False)
