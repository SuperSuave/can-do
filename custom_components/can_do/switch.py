"""Switch platform for CAN Do integration."""

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import build_action_steps
from .catalog_loader import check_match, parse_hex_val
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
        if not self.state_can_id:
            return self._is_on

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return self._is_on

        # Check options for "On" / "Active" / "Enabled"
        options = self.command.get("options", [])
        for opt in options:
            label = opt.get("label", "").lower()
            if any(k in label for k in ["on", "active", "enabled", "heat", "1"]):
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    return True
                if not match_spec and opt.get("default") and self._is_on:
                    return True

        # Check command-level match
        if "match" in self.command:
            return check_match(payload, self.command["match"], self.command.get("mask"))

        return self._is_on

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the switch on."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", self.state_can_id or "0x000")
        delay_ms = net.get("delay_ms", 20)

        # Look for "On" option or default steps
        target_opt = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if any(k in label for k in ["on", "active", "enabled", "start"]):
                target_opt = opt
                break

        # Resolve base_payload from live CAN state or command network defaults
        base_payload = None
        if self.state_can_id:
            curr = self.coordinator.get_can_payload(self.state_can_id)
            if curr and len(curr) == 8:
                base_payload = list(curr)
        if not base_payload:
            net_base = self.command.get("network", {}).get("base_payload")
            if isinstance(net_base, list) and len(net_base) == 8:
                base_payload = []
                for b in net_base:
                    val, _ = parse_hex_val(b) if isinstance(b, str) else (int(b), False)
                    base_payload.append(val & 0xFF)

        steps = build_action_steps(self.command, target_opt, base_payload)
        if steps:
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the switch off."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", self.state_can_id or "0x000")
        delay_ms = net.get("delay_ms", 20)

        target_opt = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if any(k in label for k in ["off", "inactive", "disabled", "stop"]):
                target_opt = opt
                break

        # Resolve base_payload from live CAN state or command network defaults
        base_payload = None
        if self.state_can_id:
            curr = self.coordinator.get_can_payload(self.state_can_id)
            if curr and len(curr) == 8:
                base_payload = list(curr)
        if not base_payload:
            net_base = self.command.get("network", {}).get("base_payload")
            if isinstance(net_base, list) and len(net_base) == 8:
                base_payload = []
                for b in net_base:
                    val, _ = parse_hex_val(b) if isinstance(b, str) else (int(b), False)
                    base_payload.append(val & 0xFF)

        steps = build_action_steps(self.command, target_opt, base_payload)
        if steps:
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        self._is_on = False
        self.async_write_ha_state()
