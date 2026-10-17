"""Select platform for CAN Do integration."""

import logging
from typing import Any

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
    entities: list[SelectEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "select":
            entities.append(CanDoSelectEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoSelectEntity(CanDoEntity, SelectEntity):
    """Select entity representing multi-state CAN options (modes, comfort levels)."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize select entity."""
        super().__init__(coordinator, command)
        self._attr_options = [
            opt["label"] for opt in self.command.get("options", []) if "label" in opt
        ]
        self._current_option: str | None = (
            self._attr_options[0] if self._attr_options else None
        )

    @property
    def current_option(self) -> str | None:
        """Return the selected entity option."""
        # 1. Raw CAN payload matching from vehicle bus (Ground Truth)
        if self.state_can_id:
            payload = self.coordinator.get_can_payload(self.state_can_id)
            if isinstance(payload, list):
                for opt in self.command.get("options", []):
                    match_spec = opt.get("match") or opt.get("payload")
                    if match_spec and check_match(payload, match_spec, opt.get("mask")):
                        return opt.get("label")

                # Fallback for E-GMP charging limits (0x1F9: Byte 2 = AC limit, Byte 3 = DC limit)
                if self.state_can_id.lower() == "0x1f9" and len(payload) >= 4:
                    idx = 2 if "ac" in self.entity_id_str.lower() else 3
                    raw = payload[idx]
                    val_pct = round(raw * 0.5)
                    lbl = f"{val_pct}%"
                    if lbl in self.options:
                        return lbl

                # Fallback for E-GMP seat comfort (0x496 Driver, 0x475 Passenger)
                if self.state_can_id.lower() in ("0x496", "0x475") and len(payload) >= 1:
                    b = payload[0]
                    if b in (0x46, 0x02):
                        return "High Heat"
                    if b in (0x4E, 0x0A):
                        return "Medium Heat"
                    if b in (0x36, 0x0E):
                        return "Low Heat"
                    if b in (0x2E, 0x10):
                        return "High Cool"
                    if b in (0x26, 0x12):
                        return "Medium Cool"
                    if b in (0x1E, 0x14):
                        return "Low Cool"
                    return "Off"

            # Direct string payload on state_can_id
            if isinstance(payload, str) and payload in self.options:
                return payload

        # 2. Direct decoded entity state from coordinator (e.g. from WiCAN / ESP32 emit_live_entity_state)
        entity_val = self.coordinator.get_can_payload(self.entity_id_str)
        if entity_val and isinstance(entity_val, str) and entity_val in self.options:
            return entity_val

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

        base_payload = self.coordinator.get_can_payload(action_can_id)
        if not base_payload and self.state_can_id and self.state_can_id.lower() == action_can_id.lower():
            base_payload = self.coordinator.get_can_payload(self.state_can_id)
        steps = build_action_steps(self.command, target_opt, base_payload)
        if self.entity_id_str == "ambient_mood_lamp_color" or net.get("type") == "isotp":
            _LOGGER.info("Sending ambient lamp entity command '%s' for '%s'", option, self.name)
            await self.coordinator.async_send_entity_command(self.entity_id_str, option)

            # Map ambient mood lamp presets to corresponding 0x4AD 2-stage frame bursts
            hex_map: dict[str, str] = {
                "golden": "D0C1751500000000",
                "orange delight": "D0C1751500000000",
                "blue flight": "4F29361C00000000",
                "peaceful forest": "7F69A61700000000",
                "dreamy purple": "6B69551900000000",
                "violet cloud": "A789F51700000000",
                "refreshing sea": "3269E61900000000",
                "cyan": "0064530F00000000",
                "aqua": "0064530F00000000",
                "amber": "FF50720700000000",
                "sunset": "FF50720700000000",
                "orange": "FF50720700000000",
                "violet": "8000F00F00000000",
                "purple": "8000F00F00000000",
                "white": "FEB4530A00000000",
                "champagne": "FEB4530A00000000",
                "red": "FE88000000000000",
                "crimson": "FE88000000000000",
                "green": "F7FC630B00000000",
                "mint": "F7FC630B00000000",
                "lime": "F7FC630B00000000",
                "blue": "0054F10F00000000",
                "pink": "FF00100F00000000",
                "magenta": "FF00100F00000000",
                "off": "0000000000000000",
            }
            opt_lower = option.lower()
            matched_hex = None
            for key, hx in hex_map.items():
                if key in opt_lower:
                    matched_hex = hx
                    break

            if matched_hex:
                burst_steps = [
                    {"payload": matched_hex, "repeat": 3, "delay_ms": 25},
                    {"payload": "0002082000000000", "repeat": 3, "delay_ms": 25},
                ]
                await self.coordinator.async_send_action("0x4AD", 25, burst_steps)
        elif steps:
            _LOGGER.info("Selecting option '%s' for '%s'", option, self.name)
            await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        self._current_option = option
        self.async_write_ha_state()
