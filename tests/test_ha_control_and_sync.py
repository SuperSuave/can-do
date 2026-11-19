"""Regression tests for Home Assistant coordinator telemetry sync and entity command dispatch."""

import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call


def _ensure_mod(name: str) -> types.ModuleType:
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        mod.__path__ = []
        sys.modules[name] = mod
    return mod


can_do_dir = Path(__file__).resolve().parent.parent / "custom_components" / "can_do"
_ensure_mod("custom_components")
if "custom_components.can_do" not in sys.modules:
    pkg = types.ModuleType("custom_components.can_do")
    pkg.__path__ = [str(can_do_dir)]
    pkg.__file__ = str(can_do_dir / "__init__.py")
    sys.modules["custom_components.can_do"] = pkg

_ensure_mod("homeassistant")
ha_core = _ensure_mod("homeassistant.core")
if not hasattr(ha_core, "HomeAssistant"):
    ha_core.HomeAssistant = MagicMock
if not hasattr(ha_core, "callback"):
    ha_core.callback = lambda f: f

_ensure_mod("homeassistant.components")
ha_mqtt = _ensure_mod("homeassistant.components.mqtt")
if not hasattr(ha_mqtt, "ReceiveMessage"):
    ha_mqtt.ReceiveMessage = MagicMock
if not hasattr(ha_mqtt, "async_publish"):
    ha_mqtt.async_publish = AsyncMock()
if not hasattr(ha_mqtt, "async_subscribe"):
    ha_mqtt.async_subscribe = AsyncMock(return_value=lambda: None)

ha_const = _ensure_mod("homeassistant.const")
if not hasattr(ha_const, "PERCENTAGE"):
    ha_const.PERCENTAGE = "%"
if not hasattr(ha_const, "UnitOfTemperature"):
    ha_const.UnitOfTemperature = MagicMock()
    ha_const.UnitOfTemperature.CELSIUS = "°C"
    ha_const.UnitOfTemperature.FAHRENHEIT = "°F"

ha_cfg = _ensure_mod("homeassistant.config_entries")
if not hasattr(ha_cfg, "ConfigEntry"):
    ha_cfg.ConfigEntry = MagicMock

_ensure_mod("homeassistant.helpers")
ha_entity = _ensure_mod("homeassistant.helpers.entity")
if not hasattr(ha_entity, "Entity"):
    class Entity:
        def __init__(self, *args, **kwargs):
            pass

        async def async_added_to_hass(self):
            pass

        async def async_will_remove_from_hass(self):
            pass

        def async_write_ha_state(self):
            pass

    ha_entity.Entity = Entity

ha_device = _ensure_mod("homeassistant.helpers.device_registry")
if not hasattr(ha_device, "DeviceInfo"):
    ha_device.DeviceInfo = MagicMock

ha_plat = _ensure_mod("homeassistant.helpers.entity_platform")
if not hasattr(ha_plat, "AddEntitiesCallback"):
    ha_plat.AddEntitiesCallback = MagicMock

# Platform-specific stubs
ha_climate = _ensure_mod("homeassistant.components.climate")
if not hasattr(ha_climate, "ClimateEntity"):
    class ClimateEntity:
        @property
        def name(self):
            return getattr(self, "_attr_name", "")

        @property
        def temperature_unit(self):
            return getattr(self, "_attr_temperature_unit", "°F")

    class ClimateEntityFeature:
        TARGET_TEMPERATURE = 1

    class HVACAction:
        OFF = "off"
        HEATING = "heating"
        COOLING = "cooling"
        IDLE = "idle"

    class HVACMode:
        AUTO = "auto"
        HEAT_COOL = "heat_cool"
        OFF = "off"

    ha_climate.ClimateEntity = ClimateEntity
    ha_climate.ClimateEntityFeature = ClimateEntityFeature
    ha_climate.HVACAction = HVACAction
    ha_climate.HVACMode = HVACMode

ha_light = _ensure_mod("homeassistant.components.light")
if not hasattr(ha_light, "LightEntity"):
    class LightEntity:
        pass

    class ColorMode:
        RGB = "rgb"

    class LightEntityFeature:
        EFFECT = 4

    ha_light.ATTR_BRIGHTNESS = "brightness"
    ha_light.ATTR_EFFECT = "effect"
    ha_light.ATTR_RGB_COLOR = "rgb_color"
    ha_light.ColorMode = ColorMode
    ha_light.LightEntity = LightEntity
    ha_light.LightEntityFeature = LightEntityFeature

ha_select = _ensure_mod("homeassistant.components.select")
if not hasattr(ha_select, "SelectEntity"):
    class SelectEntity:
        @property
        def name(self):
            return getattr(self, "_attr_name", "")

        @property
        def options(self):
            return getattr(self, "_attr_options", [])

    ha_select.SelectEntity = SelectEntity

ha_lock = _ensure_mod("homeassistant.components.lock")
if not hasattr(ha_lock, "LockEntity"):
    class LockEntity:
        pass

    ha_lock.LockEntity = LockEntity

ha_cover = _ensure_mod("homeassistant.components.cover")
if not hasattr(ha_cover, "CoverEntity"):
    class CoverEntity:
        pass

    class CoverDeviceClass:
        DOOR = "door"
        WINDOW = "window"
        GARAGE = "garage"
        GATE = "gate"

    class CoverEntityFeature:
        OPEN = 1
        CLOSE = 2
        OPEN_TILT = 16

    ha_cover.CoverDeviceClass = CoverDeviceClass
    ha_cover.CoverEntity = CoverEntity
    ha_cover.CoverEntityFeature = CoverEntityFeature

ha_button = _ensure_mod("homeassistant.components.button")
if not hasattr(ha_button, "ButtonEntity"):
    class ButtonEntity:
        @property
        def name(self):
            return getattr(self, "_attr_name", "")

    ha_button.ButtonEntity = ButtonEntity

ha_switch = _ensure_mod("homeassistant.components.switch")
if not hasattr(ha_switch, "SwitchEntity"):
    class SwitchEntity:
        pass

    ha_switch.SwitchEntity = SwitchEntity

ha_bs = _ensure_mod("homeassistant.components.binary_sensor")
if not hasattr(ha_bs, "BinarySensorEntity"):
    class BinarySensorEntity:
        pass

    class BinarySensorDeviceClass:
        DOOR = "door"
        OPENING = "opening"
        OCCUPANCY = "occupancy"
        LOCK = "lock"
        WINDOW = "window"
        PRESENCE = "presence"
        CONNECTIVITY = "connectivity"

    ha_bs.BinarySensorDeviceClass = BinarySensorDeviceClass
    ha_bs.BinarySensorEntity = BinarySensorEntity

from custom_components.can_do.binary_sensor import CanDoBinarySensorEntity
from custom_components.can_do.button import CanDoButtonEntity
from custom_components.can_do.catalog_loader import get_vehicle_commands
from custom_components.can_do.climate import CanDoClimateEntity
from custom_components.can_do.coordinator import CanDoDataCoordinator
from custom_components.can_do.cover import CanDoCoverEntity
from custom_components.can_do.light import CanDoLightEntity
from custom_components.can_do.lock import CanDoLockEntity
from custom_components.can_do.select import CanDoSelectEntity
from custom_components.can_do.switch import CanDoSwitchEntity


def _run(coro):
    return asyncio.run(coro)


class TestHaControlAndSync(unittest.TestCase):
    """Verify HA telemetry parsing, attribute updates, and command dispatch."""

    def setUp(self):
        self.hass = MagicMock()
        self.hass.config.units.temperature_unit = ha_const.UnitOfTemperature.CELSIUS
        self.coordinator = CanDoDataCoordinator(
            self.hass,
            {"device_id": "test_device", "vehicle_id": "kia_ev6", "base_topic": "cando"},
        )
        self.commands = {cmd["id"]: cmd for cmd in get_vehicle_commands("kia_ev6")}

    def test_coordinator_parses_non_hex_scalars_and_1char_labels(self):
        """Non-0x integer scalars and 1-char gear strings must never be dropped or turned into hex bytes."""
        # Two-digit decimal scalar on non-0x topic should become float 10.0, NOT [0x10]
        msg_bright = MagicMock()
        msg_bright.topic = "cando/test_device/state/ambient_light_brightness"
        msg_bright.payload = "10"
        self.coordinator._handle_can_state_message(msg_bright)
        self.assertEqual(self.coordinator.get_can_state("ambient_light_brightness"), 10.0)
        self.assertIsNone(self.coordinator.get_can_payload("ambient_light_brightness"))

        # Single-digit scalar "1" / "0" must not be dropped by len < 2 check
        msg_one = MagicMock()
        msg_one.topic = "cando/test_device/state/climate_driver_only_toggle"
        msg_one.payload = "1"
        self.coordinator._handle_can_state_message(msg_one)
        self.assertEqual(self.coordinator.get_can_state("climate_driver_only_toggle"), 1.0)

        # Single-char non-numeric gear string "P" / "D" must be preserved as str
        msg_gear = MagicMock()
        msg_gear.topic = "cando/test_device/state/gear_state"
        msg_gear.payload = "P"
        self.coordinator._handle_can_state_message(msg_gear)
        self.assertEqual(self.coordinator.get_can_state("gear_state"), "P")

        # Raw 0x CAN topic still parses hex byte array
        msg_can = MagicMock()
        msg_can.topic = "cando/test_device/state/0x418"
        msg_can.payload = "0000010000000000"
        self.coordinator._handle_can_state_message(msg_can)
        self.assertEqual(self.coordinator.get_can_payload("0x418"), [0, 0, 1, 0, 0, 0, 0, 0])

    def test_switch_and_binary_sensor_handle_numeric_scalars(self):
        """Switch and BinarySensor entities accept 1.0 / 0.0 scalars from coordinator."""
        sw = CanDoSwitchEntity(self.coordinator, self.commands["climate_driver_only_toggle"])
        self.coordinator.can_states["climate_driver_only_toggle"] = 1.0
        self.assertTrue(sw.is_on)
        self.coordinator.can_states["climate_driver_only_toggle"] = 0.0
        self.assertFalse(sw.is_on)

        bs_cmd = {
            "id": "test_bs",
            "category": "Body",
            "network": {"state_can_id": "0x411"},
            "ha_metadata": {"domain": "binary_sensor", "name": "Test BS"},
        }
        bs = CanDoBinarySensorEntity(self.coordinator, bs_cmd)
        self.coordinator.can_states["test_bs"] = 1.0
        self.assertTrue(bs.is_on)
        self.coordinator.can_states["test_bs"] = 0.0
        self.assertFalse(bs.is_on)

    def test_climate_attributes_snapshot_updates_and_0x4a0_release(self):
        """Climate decodes D5 0x541, D3 0x418, 0x49C, 0x465 D7, triggers write on attr changes, and sends 0xFF release."""
        climate_cmd = self.commands["climate_driver_temp"]
        ent = CanDoClimateEntity(self.coordinator, climate_cmd, self.hass)
        ent.async_write_ha_state = MagicMock()

        # Populate telemetry frames
        self.coordinator.can_states["0x541"] = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00]  # D5 bit4 rear defrost on
        self.coordinator.can_states["0x418"] = [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]  # D3 bit0 heated wheel on
        self.coordinator.can_states["0x465"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00]  # D7 0x04 driver only on
        self.coordinator.can_states["0x49c"] = [0x4E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]  # Passenger Medium Heat
        self.coordinator.can_states["0x384"] = [0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x00]  # DATC active flag

        attrs = ent.extra_state_attributes
        self.assertTrue(attrs["rear_defrost"])
        self.assertEqual(attrs["heated_steering_wheel"], "On")
        self.assertTrue(attrs["driver_only"])
        self.assertEqual(attrs["passenger_seat_comfort"], "Medium Heat")
        self.assertTrue(ent._is_hvac_active())

        # Snapshot comparison must detect attribute-only change (e.g. passenger seat changes while target_temp unchanged)
        ent._handle_can_update()
        self.assertEqual(ent.async_write_ha_state.call_count, 1)
        ent._handle_can_update()  # identical state+attrs -> no duplicate write
        self.assertEqual(ent.async_write_ha_state.call_count, 1)
        self.coordinator.can_states["0x49c"] = [0x46, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]  # High Heat
        ent._handle_can_update()
        self.assertEqual(ent.async_write_ha_state.call_count, 2)

        # async_set_temperature sends temp step + 0xFF release step with bus
        self.coordinator.async_send_action = AsyncMock()
        self.coordinator.async_send_remote_climate = AsyncMock()
        _run(ent.async_set_temperature(temperature=22.0))
        self.coordinator.async_send_action.assert_awaited_once()
        args, kwargs = self.coordinator.async_send_action.await_args
        self.assertEqual(args[0].lower(), "0x4a0")
        steps = args[2]
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[1]["payload"], "00FF000000000000")
        self.assertEqual(kwargs.get("bus"), 0)

    def test_light_single_color_dispatch_and_fallbacks(self):
        """Light entity must not double-blast raw 0x4AD when using async_send_entity_command, and reads direct entity fallbacks."""
        light_cmd = self.commands["ambient_light_colors"]
        ent = CanDoLightEntity(self.coordinator, light_cmd)
        ent.async_write_ha_state = MagicMock()

        # Direct entity fallbacks when 0x455 is unavailable
        self.coordinator.can_states["ambient_light_brightness"] = 7.0
        self.coordinator.can_states["ambient_light_colors"] = "Color 8: Pure Cyan / Aqua Wave"
        self.assertTrue(ent.is_on)
        self.assertEqual(ent.effect, "Color 8: Pure Cyan / Aqua Wave")
        self.assertEqual(ent.brightness, round((7 / 10.0) * 255))

        # Selecting color while ON dispatches only async_send_entity_command with resolved preset label
        self.coordinator.async_send_entity_command = AsyncMock()
        self.coordinator.async_send_action = AsyncMock()
        _run(ent.async_turn_on(rgb_color=(0, 255, 255)))
        self.coordinator.async_send_entity_command.assert_awaited_once_with(
            "ambient_light_colors", "Color 8: Pure Cyan / Aqua Wave"
        )
        self.coordinator.async_send_action.assert_not_awaited()

        # Bug 5: Picking Dreamy Purple RGB (128, 0, 128) resolves OEM theme label instead of raw RGB JSON
        self.coordinator.async_send_entity_command.reset_mock()
        _run(ent.async_turn_on(rgb_color=(128, 0, 128)))
        self.coordinator.async_send_entity_command.assert_awaited_once_with(
            "ambient_light_colors", "Dreamy Purple"
        )
        self.coordinator.async_send_action.assert_not_awaited()

        # Turning off stops animations + sets brightness to Off strictly via /set entity commands (never raw /tx)
        self.coordinator.async_send_entity_command.reset_mock()
        _run(ent.async_turn_off())
        self.assertEqual(
            self.coordinator.async_send_entity_command.await_args_list,
            [
                call("ambient_light_colors", "off"),
                call("ambient_light_brightness", "Off"),
            ],
        )
        self.coordinator.async_send_action.assert_not_awaited()

        # Bug 3: Turning on from OFF with effect dispatches color then restored brightness via entity commands
        self.coordinator.can_states["ambient_light_brightness"] = "Off"
        self.assertFalse(ent.is_on)
        self.coordinator.async_send_entity_command.reset_mock()
        _run(ent.async_turn_on(effect="Dreamy Purple"))
        self.assertEqual(
            self.coordinator.async_send_entity_command.await_args_list,
            [
                call("ambient_light_colors", "Dreamy Purple"),
                call("ambient_light_brightness", "Brightness Level 7"),
            ],
        )
        self.coordinator.async_send_action.assert_not_awaited()

        # Fresh light entity starting OFF with default brightness=255 restores Brightness Level 10 (Max)
        fresh_ent = CanDoLightEntity(self.coordinator, light_cmd)
        fresh_ent.async_write_ha_state = MagicMock()
        self.assertFalse(fresh_ent.is_on)
        self.coordinator.async_send_entity_command.reset_mock()
        _run(fresh_ent.async_turn_on(effect="Dreamy Purple"))
        self.assertEqual(
            self.coordinator.async_send_entity_command.await_args_list,
            [
                call("ambient_light_colors", "Dreamy Purple"),
                call("ambient_light_brightness", "Brightness Level 10 (Max)"),
            ],
        )
        self.coordinator.async_send_action.assert_not_awaited()

        # Explicit HA brightness=178 maps to Brightness Level 7 via entity command
        self.coordinator.async_send_entity_command.reset_mock()
        _run(ent.async_turn_on(brightness=178))
        self.coordinator.async_send_entity_command.assert_awaited_once_with(
            "ambient_light_brightness", "Brightness Level 7"
        )
        self.coordinator.async_send_action.assert_not_awaited()

    def test_light_single_zone_effects_and_factory_themes(self):
        """Ambient light exposes 64 palette colors + 6 single-color factory themes + 7 single-zone animations (no dual-tone)."""
        light_cmd = self.commands["ambient_light_colors"]
        ent = CanDoLightEntity(self.coordinator, light_cmd)
        effects = getattr(ent, "effect_list", None) or ent._attr_effect_list

        self.assertEqual(len(effects), 77)
        for effect in effects:
            lower = effect.lower()
            self.assertNotIn("dual-tone", lower)
            self.assertNotIn("dual tone", lower)

        factory_themes = (
            "Golden Insight / Orange Delight",
            "Blue Flight",
            "Peaceful Forest",
            "Dreamy Purple",
            "Violet Cloud",
            "Refreshing Sea",
        )
        for theme in factory_themes:
            self.assertIn(theme, effects)

        catalog_effects = light_cmd.get("effects", [])
        self.assertEqual(len(catalog_effects), 7)
        for eff in catalog_effects:
            self.assertIn(eff["label"], effects)

        # Verify 0x455 Dreamy Purple telemetry decodes accurately
        self.coordinator.can_states["0x455"] = [0x4B, 0x00, 0x6B, 0x69, 0x55, 0x59, 0x00, 0x00]
        self.assertEqual(ent.effect, "Dreamy Purple")
        self.assertEqual(ent.rgb_color, (128, 0, 128))

    def test_select_lock_cover_button_bus_and_fallbacks(self):
        """Verify 0x49c select fallback, scalar match, bus forwarding on lock/cover/button, and button entity fallback."""
        pass_seat = CanDoSelectEntity(self.coordinator, self.commands["passengers_seat_comfort"])
        self.coordinator.can_states["0x49c"] = [0x4E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(pass_seat.current_option, "Medium Heat")

        # Scalar match on select (e.g. "80" or 80.0 matching "80%")
        ac_limit_cmd = {
            "id": "ac_charge_limit",
            "category": "EV Charging",
            "network": {"state_can_id": "0x1F9", "action_can_id": "0x1F9"},
            "options": [{"label": "80%"}, {"label": "90%"}],
            "ha_metadata": {"domain": "select", "name": "AC Charge Limit"},
        }
        sel_limit = CanDoSelectEntity(self.coordinator, ac_limit_cmd)
        self.coordinator.can_states["ac_charge_limit"] = 80.0
        self.assertEqual(sel_limit.current_option, "80%")

        # Lock passes bus
        lock_cmd = next(c for c in self.commands.values() if c.get("ha_metadata", {}).get("domain") == "lock")
        lock_ent = CanDoLockEntity(self.coordinator, lock_cmd)
        self.coordinator.async_send_action = AsyncMock()
        _run(lock_ent.async_lock())
        self.coordinator.async_send_action.assert_awaited_once()
        self.assertEqual(self.coordinator.async_send_action.await_args.kwargs.get("bus"), lock_cmd["network"].get("bus"))

        # Cover passes bus
        cover_cmd = next(c for c in self.commands.values() if c.get("ha_metadata", {}).get("domain") == "cover")
        cover_ent = CanDoCoverEntity(self.coordinator, cover_cmd)
        self.coordinator.async_send_action.reset_mock()
        _run(cover_ent.async_open_cover())
        if self.coordinator.async_send_action.await_count:
            self.assertEqual(self.coordinator.async_send_action.await_args.kwargs.get("bus"), cover_cmd["network"].get("bus"))

        # Button fallback when steps are missing
        btn_cmd = {
            "id": "custom_edge_btn",
            "category": "Custom",
            "network": {"bus": 1, "action_can_id": "0x000"},
            "options": [{"label": "Trigger"}],
            "ha_metadata": {"domain": "button", "name": "Custom Btn"},
        }
        btn_ent = CanDoButtonEntity(self.coordinator, btn_cmd)
        self.coordinator.async_send_entity_command = AsyncMock()
        _run(btn_ent.async_press())
        self.coordinator.async_send_entity_command.assert_awaited_once_with("custom_edge_btn", "press")


if __name__ == "__main__":
    unittest.main()
