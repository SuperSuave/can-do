"""Light platform for CAN Do integration (Ambient Mood Lighting)."""

import json
import logging
import math
from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_EFFECT,
    ATTR_RGB_COLOR,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import build_action_steps
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)

# Preset colors mapped to RGB references for color wheel snapping and distance matching
PRESET_RGB_MAP: dict[str, tuple[int, int, int]] = {
    # Factory Themes
    "Golden Insight / Orange Delight": (255, 140, 0),
    "Blue Flight": (79, 41, 54),
    "Peaceful Forest": (127, 105, 166),
    "Dreamy Purple": (107, 105, 85),
    "Violet Cloud": (167, 137, 245),
    "Refreshing Sea": (50, 105, 230),
    # Primary Wheel Colors
    "Cyan / Aqua Wave": (0, 255, 255),
    "Pure Cyan / Aqua Wave": (0, 255, 255),
    "Electric Blue": (0, 120, 255),
    "Deep Purple / Violet": (180, 0, 255),
    "Magenta / Neon Pink": (255, 20, 147),
    "Crimson Red": (255, 0, 0),
    "Warm Sunset / Amber": (255, 140, 0),
    "Lime / Mint Glow": (0, 255, 100),
    "Warm White / Champagne": (255, 240, 220),
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do light entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[LightEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "light":
            entities.append(CanDoLightEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoLightEntity(CanDoEntity, LightEntity):
    """Light entity controlling vehicle ambient mood lighting."""

    _attr_color_mode = ColorMode.RGB
    _attr_supported_color_modes = {ColorMode.RGB}
    _attr_supported_features = LightEntityFeature.EFFECT

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize light entity."""
        super().__init__(coordinator, command)
        self._attr_color_mode = ColorMode.RGB
        self._attr_supported_color_modes = {ColorMode.RGB}
        self._is_on: bool = False
        self._rgb_color: tuple[int, int, int] = (180, 0, 255)  # Default Deep Purple
        self._brightness: int = 255
        self._effect: str | None = "Deep Purple / Violet"

        # Build effect list from catalog options (excluding generic 'Changed' markers)
        raw_options = self.command.get("options", [])
        self._options_by_label: dict[str, dict[str, Any]] = {}
        effects: list[str] = []

        for opt in raw_options:
            label = opt.get("label", "")
            if label and "changed" not in label.lower() and "off" not in label.lower():
                self._options_by_label[label] = opt
                effects.append(label)

        self._attr_effect_list = effects if effects else list(PRESET_RGB_MAP.keys())

    @property
    def is_on(self) -> bool:
        """Return True if light is on."""
        # 1. Check live CAN frame 0x410 status if available (Byte D4 bits 6-7)
        raw_410 = self.coordinator.get_can_payload("0x410")
        if raw_410 and len(raw_410) >= 4:
            mood_bits = raw_410[3] & 0xC0
            if mood_bits == 0x40:
                return True
            elif mood_bits == 0x00:
                return False

        # 2. Fall back to optimistic state
        return self._is_on

    @property
    def rgb_color(self) -> tuple[int, int, int] | None:
        """Return the current RGB color value."""
        return self._rgb_color

    @property
    def effect(self) -> str | None:
        """Return current effect preset."""
        return self._effect

    @property
    def brightness(self) -> int | None:
        """Return the brightness of this light."""
        return self._brightness

    def _find_closest_preset(self, r: int, g: int, b: int) -> dict[str, Any] | None:
        """Find the closest preset option in the catalog using Euclidean RGB distance."""
        best_label = None
        min_dist = float("inf")

        for label, (pr, pg, pb) in PRESET_RGB_MAP.items():
            dist = math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2)
            if dist < min_dist:
                min_dist = dist
                best_label = label

        if best_label and best_label in self._options_by_label:
            return self._options_by_label[best_label]

        # Fallback to first available option
        if self._options_by_label:
            return next(iter(self._options_by_label.values()))
        return None

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the ambient lighting on."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x4AD")
        delay_ms = net.get("delay_ms", 25)

        target_opt = None
        r, g, b = self._rgb_color

        if ATTR_RGB_COLOR in kwargs:
            r, g, b = kwargs[ATTR_RGB_COLOR]
            self._rgb_color = (r, g, b)
            target_opt = self._find_closest_preset(r, g, b)
            if target_opt:
                self._effect = target_opt.get("label")

            # 1. Send RGB payload to ambient mood lamp command
            rgb_payload = json.dumps({"r": r, "g": g, "b": b, "mode": 1})
            _LOGGER.info("Sending Ambient Light RGB (%d, %d, %d) to coordinator", r, g, b)
            await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", rgb_payload)

        elif ATTR_EFFECT in kwargs:
            effect_name = kwargs[ATTR_EFFECT]
            self._effect = effect_name
            target_opt = self._options_by_label.get(effect_name)
            if effect_name in PRESET_RGB_MAP:
                self._rgb_color = PRESET_RGB_MAP[effect_name]

            _LOGGER.info("Selecting Ambient Light effect preset '%s'", effect_name)
            await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", effect_name)

        else:
            # Simple turn on: use current effect / RGB preset
            if self._effect and self._effect in self._options_by_label:
                target_opt = self._options_by_label[self._effect]
            elif self._options_by_label:
                target_opt = next(iter(self._options_by_label.values()))
                self._effect = target_opt.get("label")

            cmd_name = self._effect or "Pure Cyan (R:0, G:255, B:255)"
            _LOGGER.info("Turning on Ambient Light with default preset '%s'", cmd_name)
            await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", cmd_name)

        if ATTR_BRIGHTNESS in kwargs:
            self._brightness = kwargs[ATTR_BRIGHTNESS]

        # 2. Transmit 0x4AD CAN burst for the matching preset
        if target_opt:
            steps = build_action_steps(self.command, target_opt)
            if steps:
                for s in steps:
                    if s.get("repeat", 1) < 3:
                        s["repeat"] = 3
                    s["delay_ms"] = delay_ms
                _LOGGER.info("Sending 0x4AD 2-stage CAN burst (%d steps) for ambient light", len(steps))
                await self.coordinator.async_send_action(action_can_id, delay_ms, steps)

        self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the ambient lighting off."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x4AD")
        delay_ms = net.get("delay_ms", 25)

        _LOGGER.info("Turning off ambient mood lighting")
        # 1. Send ambient light off command
        await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", "off")

        # 2. Transmit 0x4AD 2-stage CAN burst to power off lamps
        off_steps = [
            {"payload": "0000000000000000", "repeat": 3, "delay_ms": delay_ms},
            {"payload": "0002082000000000", "repeat": 3, "delay_ms": delay_ms},
        ]
        await self.coordinator.async_send_action(action_can_id, delay_ms, off_steps)

        self._is_on = False
        self.async_write_ha_state()
