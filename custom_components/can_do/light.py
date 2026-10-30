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

# Ground-truth 64 vehicle palette colors + RGB coordinates + factory themes
PALETTE_64_RGB_MAP: dict[str, tuple[int, int, int]] = {
    # 64-Step Continuous Vehicle Spectrum
    "Color 1: Lime / Mint Glow": (70, 255, 70),
    "Color 2: Spring Lime": (85, 255, 95),
    "Color 3: Fresh Grass": (100, 255, 120),
    "Color 4: Pastel Mint": (115, 255, 150),
    "Color 5: Light Aqua": (80, 255, 180),
    "Color 6: Bright Turquoise": (40, 255, 210),
    "Color 7: Deep Turquoise": (10, 255, 235),
    "Color 8: Pure Cyan / Aqua Wave": (0, 255, 255),
    "Color 9: Sky Blue Light": (0, 235, 255),
    "Color 10: Sky Blue": (0, 215, 255),
    "Color 11: Glacier Blue": (0, 195, 255),
    "Color 12: Cerulean": (0, 175, 255),
    "Color 13: Cobalt Light": (0, 155, 255),
    "Color 14: Pacific Blue": (0, 135, 255),
    "Color 15: Electric Blue": (0, 120, 255),
    "Color 16: Royal Blue": (20, 90, 255),
    "Color 17: Deep Blue": (50, 60, 255),
    "Color 18: Indigo Blue": (80, 40, 255),
    "Color 19: Blue Violet": (105, 30, 255),
    "Color 20: Lavender Violet": (130, 20, 255),
    "Color 21: Grape Purple": (150, 15, 255),
    "Color 22: Electric Purple": (165, 10, 255),
    "Color 23: Bright Violet": (175, 5, 255),
    "Color 24: Deep Purple / Violet": (180, 0, 255),
    "Color 25: Amethyst": (190, 0, 250),
    "Color 26: Royal Purple": (205, 0, 240),
    "Color 27: Purple Orchid": (220, 0, 230),
    "Color 28: Purple Magenta": (230, 0, 215),
    "Color 29: Bright Magenta": (240, 0, 200),
    "Color 30: Deep Fuchsia": (245, 5, 180),
    "Color 31: Hot Fuchsia": (250, 10, 160),
    "Color 32: Neon Pink": (255, 15, 140),
    "Color 33: Magenta / Neon Pink": (255, 20, 147),
    "Color 34: Deep Rose Pink": (255, 15, 120),
    "Color 35: Crimson Pink": (255, 10, 100),
    "Color 36: Bright Rose Red": (255, 10, 80),
    "Color 37: Ruby Red": (255, 10, 60),
    "Color 38: Cherry Red": (255, 10, 45),
    "Color 39: Scarlet": (255, 10, 35),
    "Color 40: Carmine Red": (255, 10, 25),
    "Color 41: Pure Red Bright": (255, 5, 15),
    "Color 42: Pure Red Strong": (255, 0, 10),
    "Color 43: Deep Crimson": (255, 0, 5),
    "Color 44: Blood Red": (255, 0, 0),
    "Color 45: Burnt Red": (255, 20, 0),
    "Color 46: Crimson Red": (255, 0, 0),
    "Color 47: Vermilion Red-Orange": (255, 45, 0),
    "Color 48: Deep Orange": (255, 65, 0),
    "Color 49: Bright Orange": (255, 80, 0),
    "Color 50: Tangerine": (255, 95, 0),
    "Color 51: Sunrise Orange": (255, 110, 0),
    "Color 52: Golden Orange": (255, 125, 0),
    "Color 53: Amber Gold": (255, 135, 0),
    "Color 54: Warm Amber": (255, 140, 0),
    "Color 55: Deep Marigold": (255, 145, 0),
    "Color 56: Marigold Orange": (255, 150, 0),
    "Color 57: Warm Sunset / Amber": (255, 140, 0),
    "Color 58: Peach Amber": (255, 165, 10),
    "Color 59: Golden Peach": (255, 180, 30),
    "Color 60: Champagne Gold": (255, 195, 60),
    "Color 61: Soft Gold": (255, 210, 100),
    "Color 62: Vanilla Gold": (255, 225, 140),
    "Color 63: Warm Ivory": (255, 235, 180),
    "Color 64: Warm White / Champagne": (255, 240, 220),
    # Common Aliases & Legacy Presets
    "Lime / Mint Glow": (70, 255, 70),
    "Pure Cyan / Aqua Wave": (0, 255, 255),
    "Cyan / Aqua Wave": (0, 255, 255),
    "Electric Blue": (0, 120, 255),
    "Deep Purple / Violet": (180, 0, 255),
    "Magenta / Neon Pink": (255, 20, 147),
    "Crimson Red": (255, 0, 0),
    "Warm Sunset / Amber": (255, 140, 0),
    "Warm White / Champagne": (255, 240, 220),
    # Factory Dual-Color Themes
    "Golden Insight / Orange Delight": (255, 140, 0),
    "Blue Flight": (79, 41, 54),
    "Peaceful Forest": (127, 105, 166),
    "Dreamy Purple": (107, 105, 85),
    "Violet Cloud": (167, 137, 245),
    "Refreshing Sea": (50, 105, 230),
    # Holiday 2-Tone Presets
    "Christmas Dual-Tone (Red Dash / Green Doors)": (255, 0, 0),
    "Halloween Dual-Tone (Orange Dash / Purple Doors)": (255, 140, 0),
    "Valentine's Dual-Tone (Pink Dash / Red Doors)": (255, 20, 147),
    "4th of July Dual-Tone (Red Dash / Blue Doors)": (0, 120, 255),
}

DYNAMIC_ANIMATIONS: list[str] = [
    "Rainbow Spectrum Wave",
    "Christmas Dual-Tone Wave",
    "Halloween Dual-Tone Wave",
    "Valentine's Dual-Tone Wave",
    "4th of July Patriotic Wave",
    "Police Strobe",
    "Ocean Tide",
    "Sunset Glow",
    "Northern Lights Aurora",
    "Ambient Breathe",
]


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
        self._effect: str | None = "Color 24: Deep Purple / Violet"

        # Build effect list: catalog options + dynamic edge animations
        raw_options = self.command.get("options", [])
        self._options_by_label: dict[str, dict[str, Any]] = {}
        effects: list[str] = []

        # Add dynamic edge animation presets first for convenient access
        for anim in DYNAMIC_ANIMATIONS:
            effects.append(anim)

        for opt in raw_options:
            label = opt.get("label", "")
            if label and "changed" not in label.lower() and "off" not in label.lower():
                self._options_by_label[label] = opt
                if label not in effects:
                    effects.append(label)

        self._attr_effect_list = effects if effects else list(PALETTE_64_RGB_MAP.keys())

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
        """Find the closest verified palette option using Euclidean RGB distance."""
        best_label = None
        min_dist = float("inf")

        for label, (pr, pg, pb) in PALETTE_64_RGB_MAP.items():
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

            # 1. Send RGB payload to edge engine
            rgb_payload = json.dumps({"r": r, "g": g, "b": b, "mode": 1})
            _LOGGER.info("Sending Ambient Light RGB (%d, %d, %d) to coordinator", r, g, b)
            await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", rgb_payload)

        elif ATTR_EFFECT in kwargs:
            effect_name = kwargs[ATTR_EFFECT]
            self._effect = effect_name
            target_opt = self._options_by_label.get(effect_name)
            if effect_name in PALETTE_64_RGB_MAP:
                self._rgb_color = PALETTE_64_RGB_MAP[effect_name]

            _LOGGER.info("Selecting Ambient Light effect preset '%s'", effect_name)
            await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", effect_name)

        else:
            # Simple turn on: use current effect / RGB preset
            if self._effect and self._effect in self._options_by_label:
                target_opt = self._options_by_label[self._effect]
            elif self._options_by_label:
                target_opt = next(iter(self._options_by_label.values()))
                self._effect = target_opt.get("label")

            cmd_name = self._effect or "Color 8: Pure Cyan / Aqua Wave"
            _LOGGER.info("Turning on Ambient Light with default preset '%s'", cmd_name)
            await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", cmd_name)

        if ATTR_BRIGHTNESS in kwargs:
            self._brightness = kwargs[ATTR_BRIGHTNESS]

        # 2. Transmit 2-stage CAN burst for target option to Dash (0x4AD) and Doors (0x48F)
        if target_opt:
            steps = build_action_steps(self.command, target_opt)
            if steps:
                for s in steps:
                    if s.get("repeat", 1) < 3:
                        s["repeat"] = 3
                    s["delay_ms"] = delay_ms
                _LOGGER.info("Sending 0x4AD and 0x48F 2-stage bursts (%d steps) for ambient light", len(steps))
                await self.coordinator.async_send_action(action_can_id, delay_ms, steps)
                # Also synchronize doors (0x48F)
                await self.coordinator.async_send_action("0x48F", delay_ms, steps)

        self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the ambient lighting off."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x4AD")
        delay_ms = net.get("delay_ms", 25)

        _LOGGER.info("Turning off ambient mood lighting")
        # 1. Send ambient light off command to edge engine
        await self.coordinator.async_send_entity_command("ambient_mood_lamp_color", "off")

        # 2. Transmit 2-stage CAN burst to power off both Dash (0x4AD) and Doors (0x48F)
        off_steps = [
            {"payload": "0000000000000000", "repeat": 3, "delay_ms": delay_ms},
            {"payload": "0002082000000000", "repeat": 3, "delay_ms": delay_ms},
        ]
        await self.coordinator.async_send_action(action_can_id, delay_ms, off_steps)
        await self.coordinator.async_send_action("0x48F", delay_ms, off_steps)

        self._is_on = False
        self.async_write_ha_state()
