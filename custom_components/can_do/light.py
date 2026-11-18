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
            # Guard: ensure brightness slider commands are not registered as standalone light entities
            if cmd.get("id") in ("ambient_light_brightness", "ambient_mood_light_brightness"):
                continue
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

        # Build effect list & fast O(1) 4-byte color match map from catalog options
        raw_options = self.command.get("options", [])
        self._options_by_label: dict[str, dict[str, Any]] = {}
        self._color_bytes_to_label: dict[tuple[int, int, int, int], str] = {}
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

                # Precompute 4-byte match signature from command payload: (D3, D4, D5, D6)
                steps = opt.get("steps") or []
                if steps and "payload" in steps[0]:
                    p = steps[0]["payload"]
                    if isinstance(p, str) and len(p) >= 8:
                        try:
                            b1 = int(p[0:2], 16)
                            b2 = int(p[2:4], 16)
                            b3 = int(p[4:6], 16)
                            b4 = int(p[6:8], 16) | 0x40  # 0x40 bit is asserted on 0x455 Byte D6
                            self._color_bytes_to_label[(b1, b2, b3, b4)] = label
                        except ValueError:
                            pass

        self._attr_effect_list = effects if effects else list(PALETTE_64_RGB_MAP.keys())

    async def async_added_to_hass(self) -> None:
        """Register CAN state listeners for 0x455 (infotainment), 0x2DB (MLU hardware), and direct ambient entity states."""
        await super().async_added_to_hass()
        for can_id in ("0x455", "0x2db", "ambient_light_colors", "ambient_light_brightness", "ambient_mood_lighting"):
            if can_id != (self.state_can_id or "").lower():
                unsub = self.coordinator.register_listener(can_id, self._handle_can_update)
                self._unsub_listeners.append(unsub)

    @property
    def is_on(self) -> bool:
        """Return True if light is on."""
        # 1. Check live MLU hardware power frame 0x2DB (Byte D4: 0xFA = active, 0x00 = off)
        raw_2db = self.coordinator.get_can_payload("0x2DB")
        if raw_2db and len(raw_2db) >= 4:
            return raw_2db[3] > 0

        # 2. Check live infotainment status frame 0x455 (Byte D1: 0x41 = off, 0x42-0x4B = on)
        raw_455 = self.coordinator.get_can_payload("0x455")
        if raw_455 and len(raw_455) >= 1:
            return (raw_455[0] & 0x0F) > 1

        # 3. Check live CAN frame 0x410 status if available (Byte D4 bits 6-7)
        raw_410 = self.coordinator.get_can_payload("0x410")
        if raw_410 and len(raw_410) >= 4:
            mood_bits = raw_410[3] & 0xC0
            if mood_bits == 0x40:
                return True
            elif mood_bits == 0x00:
                return False

        # 3b. Check live entity state for ambient_light_brightness if emitted as scalar/label
        bright_direct = self.coordinator.get_can_state("ambient_light_brightness")
        if isinstance(bright_direct, (int, float)):
            return bright_direct > 0
        if isinstance(bright_direct, str):
            bs = bright_direct.strip().lower()
            if bs == "off" or bs == "0":
                return False
            if "brightness" in bs:
                return True

        # 4. Fall back to optimistic state
        return self._is_on

    @property
    def rgb_color(self) -> tuple[int, int, int] | None:
        """Return the current RGB color value."""
        # Synchronize from live 0x455 if available
        _ = self.effect
        return self._rgb_color

    @property
    def effect(self) -> str | None:
        """Return current effect preset decoded from live 0x455 telemetry or entity state."""
        raw_455 = self.coordinator.get_can_payload("0x455")
        if raw_455 and len(raw_455) >= 6:
            color_sig = (raw_455[2], raw_455[3], raw_455[4], raw_455[5])
            if color_sig in self._color_bytes_to_label:
                matched_label = self._color_bytes_to_label[color_sig]
                self._effect = matched_label
                if matched_label in PALETTE_64_RGB_MAP:
                    self._rgb_color = PALETTE_64_RGB_MAP[matched_label]
                return matched_label

        # Fallback to direct entity state published by ESP32 (e.g. animations or preset sync)
        for state_key in (self.entity_id_str, "ambient_light_colors", "ambient_mood_lighting"):
            direct = self.coordinator.get_can_state(state_key)
            if isinstance(direct, str) and direct and "off" not in direct.lower():
                if direct in self._options_by_label or direct in DYNAMIC_ANIMATIONS or direct in PALETTE_64_RGB_MAP:
                    self._effect = direct
                    if direct in PALETTE_64_RGB_MAP:
                        self._rgb_color = PALETTE_64_RGB_MAP[direct]
                    return direct

        return self._effect

    @property
    def brightness(self) -> int | None:
        """Return current brightness (0-255)."""
        raw_455 = self.coordinator.get_can_payload("0x455")
        if raw_455 and len(raw_455) >= 1:
            lvl = (raw_455[0] & 0x0F) - 1
            if lvl > 0:
                val = int(round((lvl / 10.0) * 255))
                self._brightness = val
                return val
            # When light is off, preserve last non-zero brightness so HA doesn't wipe slider
            return self._brightness

        bright_direct = self.coordinator.get_can_state("ambient_light_brightness")
        if isinstance(bright_direct, (int, float)) and bright_direct > 0:
            lvl = max(1, min(10, round(bright_direct)))
            val = int(round((lvl / 10.0) * 255))
            self._brightness = val
            return val
        if isinstance(bright_direct, str):
            import re
            m = re.search(r"level\s*(\d+)", bright_direct, re.IGNORECASE)
            if m:
                lvl = max(1, min(10, int(m.group(1))))
                val = int(round((lvl / 10.0) * 255))
                self._brightness = val
                return val

        return self._brightness

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return diagnostic attributes including hardware MLU and infotainment telemetry."""
        attrs = super().extra_state_attributes
        attrs["active_preset"] = self.effect
        raw_455 = self.coordinator.get_can_payload("0x455")
        if raw_455 and len(raw_455) >= 6:
            lvl = (raw_455[0] & 0x0F) - 1
            attrs["brightness_level"] = max(0, lvl)
            attrs["infotainment_color_hex"] = "".join(f"{b:02X}" for b in raw_455[2:6])
        raw_2db = self.coordinator.get_can_payload("0x2DB")
        if raw_2db and len(raw_2db) >= 4:
            attrs["mlu_pwm_duty"] = raw_2db[3]
            attrs["mlu_cie_xy"] = f"{raw_2db[0]:02X} {raw_2db[1]:02X}"
        return attrs

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
        """Turn the ambient lighting on, set color, effect, or brightness."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x4AD")
        delay_ms = net.get("delay_ms", 25)
        bus = net.get("bus")
        entity_cmd_id = self.entity_id_str or "ambient_light_colors"
        edge_managed = entity_cmd_id in (
            "ambient_mood_lamp_color",
            "ambient_mood_lighting",
            "ambient_light_colors",
            "mood_lighting",
            "ambient_light",
        )

        target_opt = None
        r, g, b = self._rgb_color
        color_changed = False

        if ATTR_RGB_COLOR in kwargs:
            r, g, b = kwargs[ATTR_RGB_COLOR]
            self._rgb_color = (r, g, b)
            target_opt = self._find_closest_preset(r, g, b)
            if target_opt:
                self._effect = target_opt.get("label")

            # Firmware queue_entity_command handles RGB -> closest 64-palette color + 2-stage 0x4AD TX + MQTT/WS sync
            rgb_payload = json.dumps({"r": r, "g": g, "b": b, "mode": 1})
            _LOGGER.info("Sending Ambient Light RGB (%d, %d, %d) to coordinator", r, g, b)
            await self.coordinator.async_send_entity_command(entity_cmd_id, rgb_payload)
            color_changed = True

        elif ATTR_EFFECT in kwargs:
            effect_name = kwargs[ATTR_EFFECT]
            self._effect = effect_name
            target_opt = self._options_by_label.get(effect_name)
            if effect_name in PALETTE_64_RGB_MAP:
                self._rgb_color = PALETTE_64_RGB_MAP[effect_name]

            _LOGGER.info("Selecting Ambient Light effect preset '%s'", effect_name)
            await self.coordinator.async_send_entity_command(entity_cmd_id, effect_name)
            color_changed = True

        elif ATTR_BRIGHTNESS not in kwargs:
            # Simple turn on: use current effect / RGB preset
            if self._effect and self._effect in self._options_by_label:
                target_opt = self._options_by_label[self._effect]
            elif self._options_by_label:
                target_opt = next(iter(self._options_by_label.values()))
                self._effect = target_opt.get("label")

            cmd_name = self._effect or "Color 8: Pure Cyan / Aqua Wave"
            _LOGGER.info("Turning on Ambient Light with default preset '%s'", cmd_name)
            await self.coordinator.async_send_entity_command(entity_cmd_id, cmd_name)
            color_changed = True

        # Only transmit fallback raw 0x4AD burst when entity ID is not natively handled by firmware queue_entity_command
        if color_changed and target_opt and not edge_managed:
            steps = build_action_steps(self.command, target_opt)
            if steps:
                for s in steps:
                    if s.get("repeat", 1) < 3:
                        s["repeat"] = 3
                    s["delay_ms"] = delay_ms
                _LOGGER.info("Sending 0x4AD 2-stage burst (%d steps) for ambient light color", len(steps))
                await self.coordinator.async_send_action(action_can_id, delay_ms, steps, bus=bus)

        # Transmit 2-stage CAN burst for brightness adjustment
        if ATTR_BRIGHTNESS in kwargs:
            brightness = kwargs[ATTR_BRIGHTNESS]
            self._brightness = brightness
            if brightness <= 0:
                await self.async_turn_off()
                return

            level = max(1, min(10, round((brightness / 255.0) * 10)))
            d4_byte = 0x20 if (level % 2 != 0) else 0xA0
            d5_byte = (level + 1) // 2
            brightness_steps = [
                {"payload": f"000208{d4_byte:02X}{d5_byte:02X}000000", "repeat": 3, "delay_ms": delay_ms},
                {"payload": "0002082000000000", "repeat": 3, "delay_ms": delay_ms},
            ]
            _LOGGER.info("Setting ambient light brightness to level %d (HA %d)", level, brightness)
            await self.coordinator.async_send_action(action_can_id, delay_ms, brightness_steps, bus=bus)
        elif not self.is_on:
            # If turning on from OFF without explicit brightness, restore last known brightness level (default 10)
            level = max(1, min(10, round((self._brightness / 255.0) * 10))) if self._brightness > 0 else 10
            d4_byte = 0x20 if (level % 2 != 0) else 0xA0
            d5_byte = (level + 1) // 2
            brightness_steps = [
                {"payload": f"000208{d4_byte:02X}{d5_byte:02X}000000", "repeat": 3, "delay_ms": delay_ms},
                {"payload": "0002082000000000", "repeat": 3, "delay_ms": delay_ms},
            ]
            _LOGGER.info("Activating ambient light at brightness level %d", level)
            await self.coordinator.async_send_action(action_can_id, delay_ms, brightness_steps, bus=bus)

        self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the ambient lighting off."""
        net = self.command.get("network", {})
        action_can_id = net.get("action_can_id", "0x4AD")
        delay_ms = net.get("delay_ms", 25)
        bus = net.get("bus")
        entity_cmd_id = self.entity_id_str or "ambient_light_colors"

        _LOGGER.info("Turning off ambient mood lighting")
        # 1. Stop any running animation & publish off state in edge engine
        await self.coordinator.async_send_entity_command(entity_cmd_id, "off")

        # 2. Transmit 2-stage CAN burst to set brightness to Off (0x41 on 0x455)
        off_steps = [
            {"payload": "000208A000000000", "repeat": 3, "delay_ms": delay_ms},
            {"payload": "0002082000000000", "repeat": 3, "delay_ms": delay_ms},
        ]
        await self.coordinator.async_send_action(action_can_id, delay_ms, off_steps, bus=bus)

        self._is_on = False
        self.async_write_ha_state()
