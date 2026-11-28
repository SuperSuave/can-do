"""Regression tests for Home Assistant coordinator telemetry sync and entity command dispatch."""

import asyncio
import importlib.machinery
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call, patch


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
if not hasattr(ha_const, "UnitOfElectricCurrent"):
    ha_const.UnitOfElectricCurrent = MagicMock()
    ha_const.UnitOfElectricCurrent.AMPERE = "A"
if not hasattr(ha_const, "UnitOfElectricPotential"):
    ha_const.UnitOfElectricPotential = MagicMock()
    ha_const.UnitOfElectricPotential.VOLT = "V"
    ha_const.UnitOfElectricPotential.MILLIVOLT = "mV"
if not hasattr(ha_const, "UnitOfLength"):
    ha_const.UnitOfLength = MagicMock()
    ha_const.UnitOfLength.KILOMETERS = "km"
    ha_const.UnitOfLength.MILES = "mi"
if not hasattr(ha_const, "UnitOfPower"):
    ha_const.UnitOfPower = MagicMock()
    ha_const.UnitOfPower.KILO_WATT = "kW"
    ha_const.UnitOfPower.WATT = "W"
if not hasattr(ha_const, "UnitOfSpeed"):
    ha_const.UnitOfSpeed = MagicMock()
    ha_const.UnitOfSpeed.KILOMETERS_PER_HOUR = "km/h"
    ha_const.UnitOfSpeed.MILES_PER_HOUR = "mph"
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
if not hasattr(ha_device, "async_get"):
    ha_device.async_get = MagicMock(return_value=MagicMock())

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

ha_sensor = _ensure_mod("homeassistant.components.sensor")
if not hasattr(ha_sensor, "SensorEntity"):
    class SensorEntity:
        pass

    class SensorDeviceClass:
        POWER = "power"
        VOLTAGE = "voltage"
        BATTERY = "battery"
        CURRENT = "current"
        SPEED = "speed"
        TEMPERATURE = "temperature"
        DISTANCE = "distance"
        DURATION = "duration"
        SIGNAL_STRENGTH = "signal_strength"
        ENUM = "enum"

    class SensorStateClass:
        MEASUREMENT = "measurement"
        TOTAL = "total"
        TOTAL_INCREASING = "total_increasing"

    ha_sensor.SensorEntity = SensorEntity
    ha_sensor.SensorDeviceClass = SensorDeviceClass
    ha_sensor.SensorStateClass = SensorStateClass

ha_event = _ensure_mod("homeassistant.components.event")
if not hasattr(ha_event, "EventEntity"):
    class EventEntity:
        def _trigger_event(self, event_type, event_data=None):
            if not hasattr(self, "triggered_events"):
                self.triggered_events = []
            self.triggered_events.append((event_type, event_data))

    ha_event.EventEntity = EventEntity

ha_notify = _ensure_mod("homeassistant.components.notify")
if not hasattr(ha_notify, "NotifyEntity"):
    class NotifyEntity:
        pass

    ha_notify.NotifyEntity = NotifyEntity

ha_number = _ensure_mod("homeassistant.components.number")
if not hasattr(ha_number, "NumberEntity"):
    class NumberEntity:
        pass

    ha_number.NumberEntity = NumberEntity

try:
    import yaml
except ImportError:
    yaml = None
import custom_components.can_do.catalog_loader as catalog_loader_mod
import custom_components.can_do.const as const_mod
from custom_components.can_do.binary_sensor import (
    CanDoBinarySensorEntity,
    CanDoBleBeaconPresenceSensor,
    CanDoBleDeviceConnectedSensor,
)
from custom_components.can_do.button import CanDoButtonEntity
from custom_components.can_do.catalog_loader import get_vehicle_commands
from custom_components.can_do.climate import CanDoClimateEntity
from custom_components.can_do.coordinator import CanDoDataCoordinator
from custom_components.can_do.cover import CanDoCoverEntity
from custom_components.can_do.event import CanDoBleButtonEventEntity
from custom_components.can_do.light import CanDoLightEntity
from custom_components.can_do.lock import CanDoLockEntity
from custom_components.can_do.notify import (
    CanDoClusterMasterNotifyEntity,
    CanDoNotifyEntity,
    async_setup_entry as notify_async_setup_entry,
)
from custom_components.can_do.number import CanDoNumberEntity
from custom_components.can_do.select import CanDoSelectEntity
from custom_components.can_do.sensor import (
    CanDoBleBeaconRssiSensor,
    CanDoBleDeviceRssiSensor,
    CanDoBleLastButtonSensor,
    CanDoSensorEntity,
)
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


def _load_init_module():
    """Load custom_components/can_do/__init__.py for service lifecycle tests."""
    name = "custom_components.can_do._init_under_test"
    loader = importlib.machinery.SourceFileLoader(name, str(can_do_dir / "__init__.py"))
    spec = importlib.machinery.ModuleSpec(name, loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestMultiDeviceIsolationAndLifecycle(unittest.TestCase):
    """Regression tests for multi-device isolation, LWT availability, and lifecycle cleanup."""

    def _make_hass(self):
        hass = MagicMock()
        hass.data = {}
        hass.bus = MagicMock()
        hass.async_create_task = asyncio.create_task
        hass.async_add_executor_job = AsyncMock(side_effect=lambda fn, *args: fn(*args))
        hass.config_entries = MagicMock()
        hass.config_entries.async_forward_entry_setups = AsyncMock()
        hass.config_entries.async_unload_platforms = AsyncMock(return_value=True)

        services_reg = {}

        def _reg(domain, name, handler, *args, **kwargs):
            services_reg[(domain, name)] = handler

        def _rem(domain, name):
            services_reg.pop((domain, name), None)

        hass.services = MagicMock()
        hass.services.async_register = MagicMock(side_effect=_reg)
        hass.services.async_remove = MagicMock(side_effect=_rem)
        hass._services_reg = services_reg
        return hass

    def test_base_topic_normalization_and_scoped_subscriptions(self):
        """Multi-segment base_topic normalizes, 'can-do' is concrete, and 'auto' defers subscribe_ids."""
        async def _scenario():
            hass = self._make_hass()
            coord_auto = CanDoDataCoordinator(
                hass,
                {"device_id": "auto", "vehicle_id": "kia_ev6", "base_topic": " /fleet/garages/cando/ "},
            )
            self.assertEqual(coord_auto.base_topic, "fleet/garages/cando")
            self.assertIsNone(coord_auto.active_device_id)

            coord_cando = CanDoDataCoordinator(
                hass,
                {"device_id": "can-do", "vehicle_id": "kia_ev6", "base_topic": "/fleet/garages/cando/"},
            )
            self.assertEqual(coord_cando.active_device_id, "can-do")

            with (
                patch("custom_components.can_do.coordinator.mqtt.async_subscribe", new_callable=AsyncMock) as mock_sub,
                patch("custom_components.can_do.coordinator.mqtt.async_publish", new_callable=AsyncMock) as mock_pub,
            ):
                mock_sub.return_value = MagicMock()
                await coord_auto.async_start()
                auto_topics = [c.args[1] for c in mock_sub.await_args_list]
                self.assertEqual(
                    auto_topics,
                    [
                        "fleet/garages/cando/+/status",
                        "fleet/garages/cando/+/state/+",
                        "fleet/garages/cando/+/ble_button",
                        "fleet/garages/cando/+/ble_beacon",
                        "fleet/garages/cando/+/ble_device",
                        "fleet/garages/cando/+/active_ids",
                    ],
                )
                mock_pub.assert_not_awaited()

                mock_sub.reset_mock()
                mock_pub.reset_mock()
                await coord_cando.async_start()
                cando_topics = [c.args[1] for c in mock_sub.await_args_list]
                self.assertEqual(
                    cando_topics,
                    [
                        "fleet/garages/cando/can-do/status",
                        "fleet/garages/cando/can-do/state/+",
                        "fleet/garages/cando/can-do/ble_button",
                        "fleet/garages/cando/can-do/ble_beacon",
                        "fleet/garages/cando/can-do/ble_device",
                        "fleet/garages/cando/can-do/active_ids",
                    ],
                )
                mock_pub.assert_awaited_once()
                self.assertEqual(mock_pub.await_args.args[1], "fleet/garages/cando/can-do/subscribe_ids")

        _run(_scenario())

    def test_ble_device_isolation_and_multi_segment_topic_parsing(self):
        """BLE handlers bind on first seen device_id, reject cross-device messages, and publish subscribe_ids."""
        async def _scenario():
            hass = self._make_hass()
            coord = CanDoDataCoordinator(
                hass,
                {"device_id": "auto", "vehicle_id": "kia_ev6", "base_topic": "site/a/cando"},
            )
            with patch("custom_components.can_do.coordinator.mqtt.async_publish", new_callable=AsyncMock) as mock_pub:
                # 1. Bare topic without payload device_id must not bind or process
                bare_no_id = MagicMock()
                bare_no_id.topic = "site/a/cando/ble_button"
                bare_no_id.payload = json.dumps({"button": "A", "action": "press"})
                coord._handle_ble_button_message(bare_no_id)
                self.assertIsNone(coord.active_device_id)
                self.assertIsNone(coord.last_ble_button)

                # 2. First scoped BLE button binds to dev1 and schedules subscribe_ids publish
                btn_dev1 = MagicMock()
                btn_dev1.topic = "site/a/cando/dev1/ble_button"
                btn_dev1.payload = json.dumps({"button": "1", "action": "press"})
                coord._handle_ble_button_message(btn_dev1)
                self.assertEqual(coord.active_device_id, "dev1")
                self.assertEqual(coord.last_ble_button["button"], "1")
                await asyncio.sleep(0)
                mock_pub.assert_awaited_once()
                self.assertEqual(mock_pub.await_args.args[1], "site/a/cando/dev1/subscribe_ids")

                # 3. Messages from dev2 (BLE, state, active_ids, status) are ignored
                bcn_dev2 = MagicMock()
                bcn_dev2.topic = "site/a/cando/dev2/ble_beacon"
                bcn_dev2.payload = json.dumps({"uuid": "u2", "rssi": -60})
                coord._handle_ble_beacon_message(bcn_dev2)
                self.assertIsNone(coord.last_ble_beacon)

                dev_dev2 = MagicMock()
                dev_dev2.topic = "site/a/cando/dev2/ble_device"
                dev_dev2.payload = json.dumps({"address": "AA:BB", "rssi": -55})
                coord._handle_ble_device_message(dev_dev2)
                self.assertIsNone(coord.last_ble_device)

                st_dev2 = MagicMock()
                st_dev2.topic = "site/a/cando/dev2/state/0x418"
                st_dev2.payload = "0102030405060708"
                st_dev2.retain = False
                coord._handle_can_state_message(st_dev2)
                self.assertIsNone(coord.get_can_payload("0x418"))

                act_dev2 = MagicMock()
                act_dev2.topic = "site/a/cando/dev2/active_ids"
                act_dev2.payload = '["0x123"]'
                coord._handle_active_ids_message(act_dev2)
                self.assertEqual(coord.active_can_ids, set())

                # 4. Mismatched topic vs payload device_id is ignored
                mismatch = MagicMock()
                mismatch.topic = "site/a/cando/dev1/ble_beacon"
                mismatch.payload = json.dumps({"device_id": "dev2", "uuid": "u-bad", "rssi": -70})
                coord._handle_ble_beacon_message(mismatch)
                self.assertIsNone(coord.last_ble_beacon)

                # 5. Matching dev1 BLE beacon & device & state work
                bcn_dev1 = MagicMock()
                bcn_dev1.topic = "site/a/cando/dev1/ble_beacon"
                bcn_dev1.payload = json.dumps({"uuid": "u1", "rssi": -50})
                coord._handle_ble_beacon_message(bcn_dev1)
                self.assertEqual(coord.last_ble_beacon["uuid"], "u1")

                dev_dev1 = MagicMock()
                dev_dev1.topic = "site/a/cando/dev1/ble_device"
                dev_dev1.payload = json.dumps({"address": "11:22", "rssi": -48})
                coord._handle_ble_device_message(dev_dev1)
                self.assertEqual(coord.last_ble_device["address"], "11:22")

        _run(_scenario())

    def test_retained_state_respects_offline_lwt_and_ble_availability(self):
        """Retained state/* frames do not override LWT offline, and all 6 BLE entities track coordinator.available."""
        hass = self._make_hass()
        coord = CanDoDataCoordinator(
            hass,
            {"device_id": "ev6", "vehicle_id": "kia_ev6", "base_topic": "cando"},
        )
        ble_entities = [
            CanDoBleButtonEventEntity(coord),
            CanDoBleLastButtonSensor(coord),
            CanDoBleBeaconRssiSensor(coord),
            CanDoBleDeviceRssiSensor(coord),
            CanDoBleBeaconPresenceSensor(coord),
            CanDoBleDeviceConnectedSensor(coord),
        ]
        self.assertTrue(all(ent.available for ent in ble_entities))

        offline_msg = MagicMock()
        offline_msg.topic = "cando/ev6/status"
        offline_msg.payload = "offline"
        coord._handle_status_message(offline_msg)
        self.assertFalse(coord.available)
        self.assertTrue(all(not ent.available for ent in ble_entities))

        retained_state = MagicMock()
        retained_state.topic = "cando/ev6/state/0x418"
        retained_state.payload = "0000010000000000"
        retained_state.retain = True
        coord._handle_can_state_message(retained_state)
        self.assertEqual(coord.get_can_payload("0x418"), [0, 0, 1, 0, 0, 0, 0, 0])
        self.assertFalse(coord.available)
        self.assertTrue(all(not ent.available for ent in ble_entities))

        live_state = MagicMock()
        live_state.topic = "cando/ev6/state/0x418"
        live_state.payload = "0000020000000000"
        live_state.retain = False
        coord._handle_can_state_message(live_state)
        self.assertTrue(coord.available)
        self.assertTrue(all(ent.available for ent in ble_entities))

    def test_status_republish_dedup_task_cancel_and_start_rollback(self):
        """Only offline->online republishes subscribe_ids, async_stop cancels in-flight task, and start cleans up on error."""
        async def _scenario():
            hass = self._make_hass()
            coord = CanDoDataCoordinator(
                hass,
                {"device_id": "ev6", "vehicle_id": "kia_ev6", "base_topic": "cando"},
            )
            unsubs = [MagicMock(), MagicMock()]

            async def _sub_fail_on_third(*args, **kwargs):
                if len(coord._unsub_list) >= 2:
                    raise RuntimeError("broker disconnected")
                return unsubs[len(coord._unsub_list)]

            with patch("custom_components.can_do.coordinator.mqtt.async_subscribe", side_effect=_sub_fail_on_third):
                with self.assertRaises(RuntimeError):
                    await coord.async_start()
            self.assertEqual(coord._unsub_list, [])
            unsubs[0].assert_called_once()
            unsubs[1].assert_called_once()

            publish_gate = asyncio.Event()

            async def _slow_publish(*args, **kwargs):
                await publish_gate.wait()

            with (
                patch("custom_components.can_do.coordinator.mqtt.async_subscribe", new_callable=AsyncMock) as mock_sub,
                patch("custom_components.can_do.coordinator.mqtt.async_publish", new_callable=AsyncMock) as mock_pub,
            ):
                mock_sub.return_value = MagicMock()
                await coord.async_start()
                self.assertEqual(mock_pub.await_count, 1)

                # Retained/initial online while already available does not republish
                online_msg = MagicMock()
                online_msg.topic = "cando/ev6/status"
                online_msg.payload = "online"
                coord._handle_status_message(online_msg)
                await asyncio.sleep(0)
                self.assertEqual(mock_pub.await_count, 1)

                # offline -> online transition republishes once via tracked task
                offline_msg = MagicMock()
                offline_msg.topic = "cando/ev6/status"
                offline_msg.payload = "offline"
                coord._handle_status_message(offline_msg)
                coord._handle_status_message(online_msg)
                self.assertIsNotNone(coord._pub_ids_task)
                await asyncio.sleep(0)
                self.assertEqual(mock_pub.await_count, 2)

            # In-flight publish task is cancelled cleanly on async_stop()
            with patch("custom_components.can_do.coordinator.mqtt.async_publish", side_effect=_slow_publish):
                coord._handle_status_message(offline_msg)
                coord._handle_status_message(online_msg)
                task = coord._pub_ids_task
                self.assertIsNotNone(task)
                self.assertFalse(task.done())
                await coord.async_stop()
                self.assertIsNone(coord._pub_ids_task)
                await asyncio.sleep(0)
                self.assertTrue(task.cancelled())

        _run(_scenario())

    def test_multi_entry_service_targeting_notify_and_unload_cleanup(self):
        """Domain services target by device_id, notify entity avoids hardcoded entity_id, and unload cleans up."""
        async def _scenario():
            init_mod = _load_init_module()
            hass = self._make_hass()

            entry1 = MagicMock()
            entry1.entry_id = "entry_1"
            entry1.data = {"device_id": "ev6_a", "vehicle_id": "kia_ev6", "base_topic": "cando"}
            entry1.options = {}

            entry2 = MagicMock()
            entry2.entry_id = "entry_2"
            entry2.data = {"device_id": "ev6_b", "vehicle_id": "kia_ev6", "base_topic": "cando"}
            entry2.options = {}

            with (
                patch("custom_components.can_do.coordinator.mqtt.async_subscribe", new_callable=AsyncMock) as mock_sub,
                patch("custom_components.can_do.coordinator.mqtt.async_publish", new_callable=AsyncMock),
            ):
                mock_sub.return_value = MagicMock()
                self.assertTrue(await init_mod.async_setup_entry(hass, entry1))
                self.assertTrue(await init_mod.async_setup_entry(hass, entry2))

            coord1 = hass.data["can_do"]["entry_1"]
            coord2 = hass.data["can_do"]["entry_2"]

            # Master notify entity does not force notify.can_do, and notify.async_setup_entry registers no services
            master_ent = CanDoClusterMasterNotifyEntity(coord2)
            self.assertIsNone(getattr(master_ent, "entity_id", None))
            notify_hass = self._make_hass()
            notify_hass.data["can_do"] = {"entry_2": coord2}
            await notify_async_setup_entry(notify_hass, entry2, MagicMock())
            self.assertEqual(notify_hass._services_reg, {})

            # Domain services registered in __init__
            for svc in ("set_hud_nav", "clear_hud_nav", "set_audio_dsp", "start_remote_climate", "stop_remote_climate", "notify"):
                self.assertIn(("can_do", svc), hass._services_reg)

            coord1.async_send_notification = AsyncMock()
            coord2.async_send_notification = AsyncMock()
            coord1.async_send_hud_nav = AsyncMock()
            coord2.async_send_hud_nav = AsyncMock()

            # Targeted can_do.notify hits only ev6_b
            call_b = MagicMock()
            call_b.data = {"device_id": "ev6_b", "message": "Gate Open", "title": "Home", "level": "warning"}
            await hass._services_reg[("can_do", "notify")](call_b)
            coord1.async_send_notification.assert_not_awaited()
            coord2.async_send_notification.assert_awaited_once_with("Home: Gate Open", level="warning", hold_ms=None)

            # Untargeted can_do.notify broadcasts to both
            coord2.async_send_notification.reset_mock()
            call_all = MagicMock()
            call_all.data = {"message": "Hello"}
            await hass._services_reg[("can_do", "notify")](call_all)
            coord1.async_send_notification.assert_awaited_once()
            coord2.async_send_notification.assert_awaited_once()

            # Targeted set_hud_nav hits only ev6_a and forwards optional fields
            call_hud = MagicMock()
            call_hud.data = {
                "device_id": "ev6_a",
                "icon": 3,
                "distance": 200,
                "direction": 90,
                "lanes": 2,
                "lane_directions": [1, 3],
                "lane_recommended": [0, 1],
                "platform": "egmp",
            }
            await hass._services_reg[("can_do", "set_hud_nav")](call_hud)
            coord1.async_send_hud_nav.assert_awaited_once_with(
                icon=3,
                distance_meters=200,
                bars=0,
                street=None,
                speed_limit_kph=0,
                camera_alert=False,
                direction=90,
                lanes=2,
                lane_directions=[1, 3],
                lane_recommended=[0, 1],
                platform="egmp",
            )
            coord2.async_send_hud_nav.assert_not_awaited()

            # Unloading first entry preserves services; unloading last removes all domain services
            self.assertTrue(await init_mod.async_unload_entry(hass, entry1))
            self.assertIn(("can_do", "notify"), hass._services_reg)
            self.assertTrue(await init_mod.async_unload_entry(hass, entry2))
            self.assertEqual(hass._services_reg, {})

        _run(_scenario())

    def test_ble_contracts_multi_beacon_presence_and_json_errors(self):
        """Verify hold_Ns/hold_seconds, multi-beacon/device presence, rotating MACs, RSSI guards, and JSON error handling."""
        hass = self._make_hass()
        coord = CanDoDataCoordinator(
            hass,
            {"device_id": "ev6", "vehicle_id": "kia_ev6", "base_topic": "cando"},
        )
        btn_event_ent = CanDoBleButtonEventEntity(coord)
        btn_event_ent.async_write_ha_state = MagicMock()
        last_btn_ent = CanDoBleLastButtonSensor(coord)
        bcn_presence_ent = CanDoBleBeaconPresenceSensor(coord)
        bcn_rssi_ent = CanDoBleBeaconRssiSensor(coord)
        dev_conn_ent = CanDoBleDeviceConnectedSensor(coord)
        dev_rssi_ent = CanDoBleDeviceRssiSensor(coord)

        # 1. hold_Ns extraction, explicit hold_seconds precedence, and chord hold/release classification
        def _send_btn(payload_str: str):
            m = MagicMock()
            m.topic = "cando/ev6/ble_button"
            m.payload = payload_str
            coord._handle_ble_button_message(m)
            btn_event_ent._handle_ble_button()

        _send_btn(json.dumps({"button": "BTN_1", "action": "hold_3s", "address": "AA:11"}))
        self.assertEqual(coord.last_ble_button["hold_seconds"], 3)
        self.assertEqual(hass.bus.async_fire.call_args.args[0], "cando_ble_button_event")
        self.assertEqual(hass.bus.async_fire.call_args.args[1]["hold_seconds"], 3)
        self.assertEqual(btn_event_ent.triggered_events[-1][0], "hold")
        self.assertEqual(btn_event_ent.triggered_events[-1][1]["hold_seconds"], 3)
        self.assertEqual(last_btn_ent.extra_state_attributes["hold_seconds"], 3)

        # Chord hold_5s with explicit hold_seconds=7 must classify as "hold" (not "combo")
        _send_btn(json.dumps({"button": "BTN_1", "combo": "BTN_1+BTN_2", "action": "hold_5s", "hold_seconds": 7}))
        self.assertEqual(btn_event_ent.triggered_events[-1][0], "hold")
        self.assertEqual(btn_event_ent.triggered_events[-1][1]["hold_seconds"], 7)

        # Chord release must classify as "release" (not "combo")
        _send_btn(json.dumps({"button": "BTN_1", "combo": "BTN_1+BTN_2", "action": "release"}))
        self.assertEqual(btn_event_ent.triggered_events[-1][0], "release")
        self.assertEqual(btn_event_ent.triggered_events[-1][1]["hold_seconds"], 0)

        # Normal chord press classifies as "combo"
        _send_btn(json.dumps({"button": "BTN_1", "combo": "BTN_1+BTN_2", "action": "press"}))
        self.assertEqual(btn_event_ent.triggered_events[-1][0], "combo")

        # 2. Malformed JSON payloads starting with '{' or '[' are rejected, while plain strings still work
        prev_btn = coord.last_ble_button
        for bad_payload in ("{broken json", "[1, 2, 3"):
            bad_msg = MagicMock()
            bad_msg.topic = "cando/ev6/ble_button"
            bad_msg.payload = bad_payload
            coord._handle_ble_button_message(bad_msg)
            self.assertIs(coord.last_ble_button, prev_btn)

        _send_btn("PLAIN_BTN")
        self.assertEqual(coord.last_ble_button["button"], "PLAIN_BTN")
        self.assertEqual(coord.last_ble_button["action"], "press")
        self.assertEqual(coord.last_ble_button["hold_seconds"], 0)

        # Narrowed JSON except handling on active_ids, ble_beacon, ble_device, and ble_button
        for handler, topic, invalid_payloads in (
            (coord._handle_active_ids_message, "cando/ev6/active_ids", ("{not valid json", b"\xff")),
            (coord._handle_ble_beacon_message, "cando/ev6/ble_beacon", ("{not valid json", None, b"\xff")),
            (coord._handle_ble_device_message, "cando/ev6/ble_device", ("{not valid json", None, b"\xff")),
            (coord._handle_ble_button_message, "cando/ev6/ble_button", (None, b"\xff")),
        ):
            for bad_payload in invalid_payloads:
                bad = MagicMock()
                bad.topic = topic
                bad.payload = bad_payload
                handler(bad)
        self.assertEqual(coord.active_can_ids, set())
        self.assertIsNone(coord.last_ble_beacon)
        self.assertIsNone(coord.last_ble_device)
        self.assertEqual(coord.last_ble_button["button"], "PLAIN_BTN")

        # 3. Beacon is_present -> present, rotating MAC deduplication, multi-beacon presence, and exit RSSI
        def _send_bcn(payload_obj: dict):
            m = MagicMock()
            m.topic = "cando/ev6/ble_beacon"
            m.payload = json.dumps(payload_obj)
            coord._handle_ble_beacon_message(m)

        _send_bcn({
            "uuid": "UUID-A",
            "mac": "AA:BB:CC:00:00:01",
            "name": "Phone A",
            "event": "enter",
            "is_present": True,
            "rssi": -62,
            "major": 10,
            "minor": 20,
        })
        self.assertEqual(list(coord.ble_beacons.keys()), ["UUID-A"])
        self.assertTrue(coord.ble_beacons["UUID-A"]["present"])
        self.assertTrue(bcn_presence_ent.is_on)
        self.assertEqual(bcn_rssi_ent.native_value, -62)
        self.assertEqual(
            bcn_rssi_ent.extra_state_attributes,
            {"uuid": "UUID-A", "mac": "AA:BB:CC:00:00:01", "name": "Phone A", "major": 10, "minor": 20, "event": "enter", "present": True},
        )

        # Rotating MAC under same UUID does not grow ble_beacons dict
        _send_bcn({
            "uuid": "UUID-A",
            "mac": "AA:BB:CC:00:00:02",
            "name": "Phone A",
            "event": "proximity",
            "is_present": True,
            "rssi": -58,
            "major": 10,
            "minor": 20,
        })
        self.assertEqual(list(coord.ble_beacons.keys()), ["UUID-A"])

        # Second beacon enters then exits: presence stays True, exit RSSI becomes None
        _send_bcn({"uuid": "UUID-B", "mac": "BB:01", "event": "enter", "present": True, "rssi": -65})
        _send_bcn({"uuid": "UUID-B", "mac": "BB:01", "event": "exit", "is_present": False, "rssi": -95, "major": 1, "minor": 2})
        self.assertTrue(bcn_presence_ent.is_on)
        self.assertIsNone(bcn_rssi_ent.native_value)
        self.assertEqual(bcn_rssi_ent.extra_state_attributes["event"], "exit")
        self.assertFalse(bcn_rssi_ent.extra_state_attributes["present"])

        # Remaining beacon exits: presence becomes False
        _send_bcn({"uuid": "UUID-A", "mac": "AA:BB:CC:00:00:02", "event": "exit", "present": False, "rssi": -99})
        self.assertFalse(bcn_presence_ent.is_on)

        # Non-numeric RSSI is safely handled as None
        _send_bcn({"uuid": "UUID-A", "event": "proximity", "present": True, "rssi": "bad"})
        self.assertIsNone(bcn_rssi_ent.native_value)

        # 4. Multi-device connectivity & RSSI guard
        def _send_dev(payload_obj: dict):
            m = MagicMock()
            m.topic = "cando/ev6/ble_device"
            m.payload = json.dumps(payload_obj)
            coord._handle_ble_device_message(m)

        _send_dev({"address": "D1", "event": "connected", "connected": True, "rssi": -50})
        _send_dev({"address": "D2", "event": "connected", "connected": True, "rssi": -55})
        _send_dev({"address": "D2", "event": "disconnected", "connected": False, "rssi": "bad"})
        self.assertTrue(dev_conn_ent.is_on)
        self.assertIsNone(dev_rssi_ent.native_value)
        _send_dev({"address": "D1", "event": "disconnected", "connected": False, "rssi": 0})
        self.assertFalse(dev_conn_ent.is_on)
        self.assertIsNone(dev_rssi_ent.native_value)


class TestStateParsingAliasingAndCommands(unittest.TestCase):
    """Regression tests for BMS aliasing, CAN ID normalization, scalar/sensor guards, and outbound commands."""

    def setUp(self):
        self.hass = MagicMock()
        self.hass.config.units.temperature_unit = ha_const.UnitOfTemperature.CELSIUS
        self.coordinator = CanDoDataCoordinator(
            self.hass,
            {"device_id": "ev6", "vehicle_id": "kia_ev6", "base_topic": "cando"},
        )
        self.commands = {cmd["id"]: cmd for cmd in get_vehicle_commands("kia_ev6")}

    def test_bms_aliases_no_oscillation_no_dup_notify_and_norm_keys(self):
        """bms_display_soc does not touch cond_hv_battery_soc, aliases don't double-notify, and IDs normalize."""
        def _send_state(topic_id: str, payload: str):
            msg = MagicMock()
            msg.topic = f"cando/ev6/state/{topic_id}"
            msg.payload = payload
            msg.retain = False
            self.coordinator._handle_can_state_message(msg)

        # 1. bms_display_soc must not overwrite cond_hv_battery_soc
        _send_state("bms_display_soc", "78.5%")
        self.assertEqual(self.coordinator.get_can_state("bms_display_soc"), 78.5)
        self.assertIsNone(self.coordinator.get_can_state("cond_hv_battery_soc"))

        # 2. vbat & bms_hv_v update alias once without double-notifying self
        cb_vbat = MagicMock()
        cb_aux = MagicMock()
        cb_hv_v = MagicMock()
        cb_hv_voltage = MagicMock()
        self.coordinator.register_listener("vbat", cb_vbat)
        self.coordinator.register_listener("cond_aux_12v_battery", cb_aux)
        self.coordinator.register_listener("bms_hv_v", cb_hv_v)
        self.coordinator.register_listener("bms_hv_voltage", cb_hv_voltage)

        _send_state("vbat", "13.4 V")
        _send_state("bms_hv_v", "742.6 V")
        _send_state("bms_cell_delta_mv", "20 mV")
        self.assertEqual(cb_vbat.call_count, 1)
        self.assertEqual(cb_aux.call_count, 1)
        self.assertEqual(cb_hv_v.call_count, 1)
        self.assertEqual(cb_hv_voltage.call_count, 1)

        # 3. Canonical CAN ID keying in can_states & _listeners + CRC filtering on unpadded 0xA2
        cb_a2 = MagicMock()
        self.coordinator.register_listener("0xA2", cb_a2)
        self.assertEqual(list(k for k in self.coordinator._listeners if "a2" in k), ["0x0a2"])

        _send_state("0xA2", "0102030405060700")
        self.assertIn("0x0a2", self.coordinator.can_states)
        self.assertNotIn("0xa2", self.coordinator.can_states)
        self.assertEqual(cb_a2.call_count, 1)

        # Only Byte 7 (D8 alive/CRC) changed -> filtered
        _send_state("0xa2", "010203040506070F")
        self.assertEqual(cb_a2.call_count, 1)

    def test_upstream_scalar_and_downstream_sensor_number_guards(self):
        """Strict scalar parsing rejects multi-number/NaN strings; sensor/number guards block invalid returns."""
        def _send_state(topic_id: str, payload: str):
            msg = MagicMock()
            msg.topic = f"cando/ev6/state/{topic_id}"
            msg.payload = payload
            msg.retain = False
            self.coordinator._handle_can_state_message(msg)

        _send_state("vbat", "13.4 V")
        _send_state("bms_display_soc", "50%")
        _send_state("camera_speed_limit_sign", "65 mph / 105 km/h")
        _send_state("doors_status", "2 Doors Open")
        _send_state("outdoor_temperature", "nan")
        self.assertEqual(self.coordinator.get_can_state("vbat"), 13.4)
        self.assertEqual(self.coordinator.get_can_state("bms_display_soc"), 50.0)
        self.assertEqual(self.coordinator.get_can_state("camera_speed_limit_sign"), "65 mph / 105 km/h")
        self.assertEqual(self.coordinator.get_can_state("doors_status"), "2 Doors Open")
        self.assertEqual(self.coordinator.get_can_state("outdoor_temperature"), "nan")

        # Discrete text sensor must not regex-extract numbers from strings
        cam_ent = CanDoSensorEntity(self.coordinator, self.commands["camera_speed_limit_sign"])
        self.assertEqual(cam_ent.native_value, "Speed Limit 65 mph / 105 km/h")
        _send_state("camera_speed_limit_sign", "Zone 99 Custom")
        self.assertEqual(cam_ent.native_value, "Zone 99 Custom")

        # Numeric sensor returns cached/None (never raw string or "Active"/"Inactive"), even with state_can_id=None
        num_cmd = {
            "id": "custom_num_sensor",
            "category": "High Voltage & Charging",
            "network": {},
            "match": {"D1": "0x01"},
            "ha_metadata": {"domain": "sensor", "name": "Custom Num", "unit_of_measurement": "V", "state_class": "measurement"},
        }
        num_ent = CanDoSensorEntity(self.coordinator, num_cmd)
        self.coordinator.can_states["custom_num_sensor"] = "12.5 V"
        num_ent._handle_can_update()
        self.assertEqual(num_ent.native_value, 12.5)
        self.coordinator.can_states["custom_num_sensor"] = "Offline"
        self.assertEqual(num_ent.native_value, 12.5)
        # Numeric sensor with CAN list payload and match must not return "Active"
        num_cmd_can = {
            "id": "custom_num_can",
            "category": "High Voltage & Charging",
            "network": {"state_can_id": "0x111"},
            "match": {"D1": "0x01"},
            "ha_metadata": {"domain": "sensor", "name": "Custom Num CAN", "unit_of_measurement": "V", "state_class": "measurement"},
        }
        num_can_ent = CanDoSensorEntity(self.coordinator, num_cmd_can)
        self.coordinator.can_states["0x111"] = [0x01, 0, 0, 0, 0, 0, 0, 0]
        self.assertIsNone(num_can_ent.native_value)

        # NumberEntity coerces offset=None and ignores bool/NaN
        num_entity = CanDoNumberEntity(
            self.coordinator,
            {
                "id": "dsp_test",
                "category": "Audio",
                "network": {"state_can_id": "0x520", "offset": None, "min": 0, "max": 75},
                "ha_metadata": {"domain": "number", "name": "DSP Test"},
            },
        )
        self.assertEqual(num_entity.offset, 0.0)
        self.coordinator.can_states["dsp_test"] = 42.0
        self.assertEqual(num_entity.native_value, 42.0)
        self.coordinator.can_states["dsp_test"] = True
        self.assertEqual(num_entity.native_value, 42.0)
        self.coordinator.can_states["dsp_test"] = float("nan")
        self.assertEqual(num_entity.native_value, 42.0)

    def test_outbound_commands_services_switch_climate_and_cleanup(self):
        """Verify notify guard, extended hud_nav params, switch/climate remote_climate labels, and cleanups."""
        async def _scenario():
            with patch("custom_components.can_do.coordinator.mqtt.async_publish", new_callable=AsyncMock) as mock_pub:
                await self.coordinator.async_send_notification("   ")
                mock_pub.assert_not_awaited()

                await self.coordinator.async_send_hud_nav(
                    icon=3,
                    distance_meters=150,
                    bars=5,
                    direction=90,
                    lanes=4,
                    lane_directions=[1, 1, 3, 4],
                    lane_recommended=[0, 1, 1, 0],
                    platform="egmp",
                )
                mock_pub.assert_awaited_once()
                sent_payload = json.loads(mock_pub.await_args.args[2])
                self.assertEqual(sent_payload["direction"], 90)
                self.assertEqual(sent_payload["lanes"], 4)
                self.assertEqual(sent_payload["lane_directions"], [1, 1, 3, 4])
                self.assertEqual(sent_payload["lane_recommended"], [0, 1, 1, 0])
                self.assertEqual(sent_payload["platform"], "egmp")

        _run(_scenario())

        # services.yaml valid and includes critical level & new set_hud_nav fields (without unencoded speed_limit/camera_alert)
        svc_path = can_do_dir / "services.yaml"
        if yaml is not None:
            svc_data = yaml.safe_load(svc_path.read_text(encoding="utf-8"))
            level_opts = svc_data["notify"]["fields"]["level"]["selector"]["select"]["options"]
            self.assertIn("critical", [o["value"] for o in level_opts])
            for field in ("direction", "lanes", "lane_directions", "lane_recommended", "platform"):
                self.assertIn(field, svc_data["set_hud_nav"]["fields"])
            for dead_field in ("speed_limit", "camera_alert"):
                self.assertNotIn(dead_field, svc_data["set_hud_nav"]["fields"])
        else:
            svc_text = svc_path.read_text(encoding="utf-8")
            self.assertIn("critical", svc_text)
            for field in ("direction", "lanes", "lane_directions", "lane_recommended", "platform"):
                self.assertIn(f"{field}:", svc_text)
            for dead_field in ("speed_limit:", "camera_alert:"):
                self.assertNotIn(dead_field, svc_text)

        # Switch uses is_on_option_label / is_off_option_label for "Remote Climate On"/"Off"
        sw = CanDoSwitchEntity(self.coordinator, self.commands["remote_climate_tmu"])
        self.coordinator.can_states["remote_climate_tmu"] = "Remote Climate On"
        self.assertTrue(sw.is_on)
        self.coordinator.can_states["remote_climate_tmu"] = "Remote Climate Off"
        self.assertFalse(sw.is_on)

        # Climate checks remote_climate and remote_climate_tmu
        clim = CanDoClimateEntity(self.coordinator, self.commands["climate_driver_temp"], self.hass)
        self.assertFalse(clim._is_hvac_active())
        self.coordinator.can_states["remote_climate_tmu"] = "Remote Climate On"
        self.assertTrue(clim._is_hvac_active())
        self.coordinator.can_states.pop("remote_climate_tmu")
        self.coordinator.can_states["remote_climate"] = "ON"
        self.assertTrue(clim._is_hvac_active())

        # Unused constants and dead helper removed
        for sym in ("ATTR_CAN_ID", "ATTR_PAYLOAD", "ATTR_LEVEL"):
            self.assertFalse(hasattr(const_mod, sym))
        self.assertFalse(hasattr(catalog_loader_mod, "decode_network_state_value"))

    def test_manifest_notify_cover_tilt_and_climate_wake_guard(self):
        """Verify manifest discovery topics, notify filtering, cover steps tilt, and climate wake guard."""
        # 1. manifest.json keeps only cando/+/status (no dead ble_* discovery topics)
        manifest = json.loads((can_do_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest.get("mqtt"), ["cando/+/status"])

        # 2. notify.py creates CanDoNotifyEntity only for track_popup commands + master entity
        async def _check_notify():
            notify_hass = MagicMock()
            fake_coord = MagicMock()
            fake_coord.device_id = "ev6"
            fake_coord.effective_device_id = "ev6"
            fake_coord.vehicle_id = "kia_ev6"
            fake_coord.commands = [
                self.commands["cluster_track_popup_message"],
                {
                    "id": "cluster_nav_osd_countdown",
                    "category": "Cockpit & Controls",
                    "network": {"bus": 0, "type": "can_tx", "action_can_id": "0x4E8"},
                    "ha_metadata": {"domain": "notify", "name": "Fake Countdown"},
                },
            ]
            entry = MagicMock()
            entry.entry_id = "e_notify"
            notify_hass.data = {"can_do": {"e_notify": fake_coord}}
            added = []
            await notify_async_setup_entry(notify_hass, entry, added.extend)

            notify_ents = [e for e in added if isinstance(e, CanDoNotifyEntity)]
            master_ents = [e for e in added if isinstance(e, CanDoClusterMasterNotifyEntity)]
            self.assertEqual([e.entity_id_str for e in notify_ents], ["cluster_track_popup_message"])
            self.assertEqual(len(master_ents), 1)

            # Live catalog routes cluster_nav_osd_countdown (0x4E8) as select, not notify
            sel_ent = CanDoSelectEntity(self.coordinator, self.commands["cluster_nav_osd_countdown"])
            sel_ent.async_write_ha_state = MagicMock()
            self.coordinator.async_send_action = AsyncMock()
            await sel_ent.async_select_option(sel_ent.options[0])
            self.coordinator.async_send_action.assert_awaited_once()
            self.assertEqual(self.coordinator.async_send_action.await_args.args[0], "0x4E8")

        _run(_check_notify())

        # 3. cover.py enables OPEN_TILT for steps-only vent/tilt options and dispatches steps
        cover_steps_cmd = {
            "id": "test_sunroof_steps",
            "category": "Doors, Access & Security",
            "network": {"bus": 0, "state_can_id": "0x541", "action_can_id": "0x4A2", "delay_ms": 20},
            "ha_metadata": {"domain": "cover", "name": "Test Sunroof"},
            "options": [
                {"label": "Open", "payload": {"D1": "0x01"}},
                {"label": "Close", "payload": {"D1": "0x02"}},
                {"label": "Vent / Tilt", "steps": [{"payload": {"D1": "0x04"}, "repeat": 2, "delay_ms": 25}]},
            ],
        }
        cover_ent = CanDoCoverEntity(self.coordinator, cover_steps_cmd)
        features = getattr(cover_ent, "supported_features", None) or cover_ent._attr_supported_features
        self.assertTrue(features & ha_cover.CoverEntityFeature.OPEN_TILT)
        self.coordinator.async_send_action = AsyncMock()
        _run(cover_ent.async_open_cover_tilt())
        self.coordinator.async_send_action.assert_awaited_once_with(
            "0x4A2",
            20,
            [{"payload": "0400000000000000", "repeat": 2, "delay_ms": 25}],
            bus=0,
        )

        # 4. climate.py removes legacy climate_dual_cabin_temp and guards raw 0x4A0 burst when asleep
        climate_src = (can_do_dir / "climate.py").read_text(encoding="utf-8")
        self.assertNotIn("climate_dual_cabin_temp", climate_src)

        async def _check_climate():
            clim = CanDoClimateEntity(self.coordinator, self.commands["climate_driver_temp"], self.hass)
            clim.async_write_ha_state = MagicMock()
            self.coordinator.async_send_remote_climate = AsyncMock()
            self.coordinator.async_send_action = AsyncMock()

            # Asleep with stale 0x380 and explicit off 0x435 (D8=0xFF): start sends remote_climate only
            self.coordinator.can_states["0x380"] = [0x00, 0x0E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
            self.coordinator.can_states["0x435"] = [0x00] * 7 + [0xFF]

            await clim.async_set_hvac_mode(ha_climate.HVACMode.HEAT_COOL)
            self.coordinator.async_send_remote_climate.assert_awaited_once_with(action="start", target_temp=21.0)
            self.coordinator.async_send_action.assert_not_awaited()
            self.assertEqual(clim._hvac_mode, ha_climate.HVACMode.HEAT_COOL)

            self.coordinator.async_send_remote_climate.reset_mock()
            await clim.async_set_hvac_mode(ha_climate.HVACMode.AUTO)
            self.coordinator.async_send_remote_climate.assert_awaited_once_with(action="start", target_temp=21.0)
            self.coordinator.async_send_action.assert_not_awaited()

            # Awake via ignition 0x435 (D8=0x00): start sends remote_climate once AND 0x4A0 + 0xFF release burst
            self.coordinator.async_send_remote_climate.reset_mock()
            self.coordinator.async_send_action.reset_mock()
            self.coordinator.can_states["0x435"] = [0x00] * 8
            await clim.async_set_hvac_mode(ha_climate.HVACMode.AUTO)
            self.coordinator.async_send_remote_climate.assert_awaited_once_with(action="start", target_temp=21.0)
            self.coordinator.async_send_action.assert_awaited_once()
            self.assertEqual(self.coordinator.async_send_action.await_args.args[0].lower(), "0x4a0")
            self.assertEqual(self.coordinator.async_send_action.await_args.args[2][1]["payload"], "00FF000000000000")

            # Awake via HVAC 0x384: start also dispatches both remote_climate and 0x4A0 burst once
            self.coordinator.can_states.pop("0x435")
            self.coordinator.can_states["0x384"] = [0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x00]
            self.coordinator.async_send_remote_climate.reset_mock()
            self.coordinator.async_send_action.reset_mock()
            await clim.async_set_hvac_mode(ha_climate.HVACMode.AUTO)
            self.coordinator.async_send_remote_climate.assert_awaited_once_with(action="start", target_temp=21.0)
            self.coordinator.async_send_action.assert_awaited_once()

        _run(_check_climate())


if __name__ == "__main__":
    unittest.main()
