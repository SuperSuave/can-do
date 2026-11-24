"""Unit tests for Live EV Charging Power (0x30E) end-to-end pipeline."""

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# Setup package mock for custom_components.can_do
can_do_dir = Path(__file__).resolve().parent.parent / "custom_components" / "can_do"
if "custom_components" not in sys.modules:
    sys.modules["custom_components"] = types.ModuleType("custom_components")
pkg = types.ModuleType("custom_components.can_do")
pkg.__path__ = [str(can_do_dir)]
pkg.__file__ = str(can_do_dir / "__init__.py")
sys.modules["custom_components.can_do"] = pkg

# Helper to register module
def _reg_mod(name):
    m = types.ModuleType(name)
    m.__path__ = []
    sys.modules[name] = m
    return m

ha = _reg_mod("homeassistant")
ha_core = _reg_mod("homeassistant.core")
ha_core.HomeAssistant = MagicMock
ha_core.callback = lambda f: f

ha_comp = _reg_mod("homeassistant.components")
ha_mqtt = _reg_mod("homeassistant.components.mqtt")
ha_mqtt.ReceiveMessage = MagicMock
ha_mqtt.async_publish = MagicMock
ha_mqtt.async_subscribe = MagicMock

ha_sensor = _reg_mod("homeassistant.components.sensor")
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
    SIGNAL_STRENGTH = "signal_strength"
class SensorStateClass:
    MEASUREMENT = "measurement"
    TOTAL_INCREASING = "total_increasing"
ha_sensor.SensorEntity = SensorEntity
ha_sensor.SensorDeviceClass = SensorDeviceClass
ha_sensor.SensorStateClass = SensorStateClass

ha_const = _reg_mod("homeassistant.const")
ha_const.PERCENTAGE = "%"
ha_const.UnitOfElectricCurrent = MagicMock()
ha_const.UnitOfElectricCurrent.AMPERE = "A"
ha_const.UnitOfElectricPotential = MagicMock()
ha_const.UnitOfElectricPotential.VOLT = "V"
ha_const.UnitOfElectricPotential.MILLIVOLT = "mV"
ha_const.UnitOfLength = MagicMock()
ha_const.UnitOfLength.KILOMETERS = "km"
ha_const.UnitOfLength.MILES = "mi"
ha_const.UnitOfPower = MagicMock()
ha_const.UnitOfPower.KILO_WATT = "kW"
ha_const.UnitOfSpeed = MagicMock()
ha_const.UnitOfSpeed.KILOMETERS_PER_HOUR = "km/h"
ha_const.UnitOfSpeed.MILES_PER_HOUR = "mph"
ha_const.UnitOfTemperature = MagicMock()
ha_const.UnitOfTemperature.CELSIUS = "°C"
ha_const.UnitOfTemperature.FAHRENHEIT = "°F"

ha_exc = _reg_mod("homeassistant.exceptions")
ha_exc.HomeAssistantError = Exception

ha_cfg = _reg_mod("homeassistant.config_entries")
ha_cfg.ConfigEntry = MagicMock

ha_helpers = _reg_mod("homeassistant.helpers")
ha_update = _reg_mod("homeassistant.helpers.update_coordinator")
class DataUpdateCoordinator:
    def __init__(self, *args, **kwargs):
        pass
ha_update.DataUpdateCoordinator = DataUpdateCoordinator

ha_entity = _reg_mod("homeassistant.helpers.entity")
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
ha_entity.DeviceInfo = MagicMock

ha_device = _reg_mod("homeassistant.helpers.device_registry")
ha_device.DeviceEntryType = MagicMock()
ha_device.DeviceInfo = MagicMock()

ha_plat = _reg_mod("homeassistant.helpers.entity_platform")
ha_plat.AddEntitiesCallback = MagicMock

from custom_components.can_do.coordinator import CanDoDataCoordinator, _CRC_CAN_IDS
from custom_components.can_do.catalog_loader import get_monitored_can_ids, get_vehicle_commands
from custom_components.can_do.sensor import CanDoSensorEntity


class TestEvChargingPowerPipeline(unittest.TestCase):
    """Test full pipeline for 0x30E EV Charging Power."""

    def setUp(self):
        self.hass = MagicMock()
        self.entry_data = {
            "device_id": "test_device",
            "vehicle_id": "kia_ev6",
            "base_topic": "cando",
        }
        self.coordinator = CanDoDataCoordinator(self.hass, self.entry_data)

    def test_catalog_and_monitored_ids(self):
        """Verify 0x30E is in the catalog and 0x258/0x259/0x30E are monitored CAN IDs for E-GMP."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmds = [c for c in commands if c.get("id") == "ev_charging_power"]
        self.assertEqual(len(chg_cmds), 1, "ev_charging_power entity must exist in catalog")
        
        chg_cmd = chg_cmds[0]
        net = chg_cmd.get("network", {})
        self.assertEqual(net.get("state_can_id"), "0x30E")
        self.assertEqual(net.get("state_byte"), "D7")
        self.assertEqual(net.get("factor"), 1)
        self.assertEqual(net.get("offset"), 0)
        self.assertEqual(net.get("unit"), "kW")

        monitored_ids = get_monitored_can_ids("kia_ev6")
        self.assertIn("0x258", monitored_ids, "0x258 must be in monitored CAN IDs list")
        self.assertIn("0x259", monitored_ids, "0x259 must be in monitored CAN IDs list")
        self.assertIn("0x30e", monitored_ids, "0x30e must be in monitored CAN IDs list")

    def test_crc_can_ids_contains_30e(self):
        """Verify 0x30e is in _CRC_CAN_IDS to filter out rolling counter byte 7."""
        self.assertIn("0x30e", _CRC_CAN_IDS)

    def test_sensor_decode_from_obc_frames_primary(self):
        """Verify sensor decodes live SavvyLens OBC 0x258 (V) x 0x259 (A) power even when 0x30E D7 is 0."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmd = next(c for c in commands if c.get("id") == "ev_charging_power")
        sensor = CanDoSensorEntity(self.coordinator, chg_cmd)

        # 1. Real SavvyLens 11.0 kW AC charging capture:
        #    0x258: 00 05 1F 00 10 25 00 24 -> 0x1F05 = 7941 -> 794.1 V
        #    0x259: 38 05 86 3C 45 02 00 00 -> 0x0538 = 1336 -> 13.36 A -> 10.6 kW DC
        #    0x30E: 00 00 38 05 21 00 00 FE -> D7 = 0x00 (must NOT clobber OBC reading)
        self.coordinator.can_states["0x258"] = [0x00, 0x05, 0x1F, 0x00, 0x10, 0x25, 0x00, 0x24]
        self.coordinator.can_states["0x259"] = [0x38, 0x05, 0x86, 0x3C, 0x45, 0x02, 0x00, 0x00]
        self.coordinator.can_states["0x30e"] = [0x00, 0x00, 0x38, 0x05, 0x21, 0x00, 0x00, 0xFE]
        self.assertEqual(sensor.native_value, 10.6)
        attrs = sensor.extra_state_attributes
        self.assertEqual(attrs.get("obc_hv_voltage_v"), 794.1)
        self.assertEqual(attrs.get("obc_hv_current_a"), 13.36)

        # 2. Real SavvyLens ramp-down capture: 791.9 V (0x1EEF) x 10.03 A (0x03EB) = 7.9 kW
        self.coordinator.can_states["0x258"] = [0x00, 0xEF, 0x1E, 0x00, 0x10, 0x25, 0x00, 0x28]
        self.coordinator.can_states["0x259"] = [0xEB, 0x03, 0x13, 0x3C, 0x2D, 0x02, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 7.9)

        # 3. Real SavvyLens stopped capture: 0.0 V x 0.00 A = 0 kW
        self.coordinator.can_states["0x258"] = [0x00, 0x00, 0x00, 0x00, 0x10, 0x25, 0x00, 0x28]
        self.coordinator.can_states["0x259"] = [0x00, 0x00, 0x00, 0x3C, 0x01, 0x00, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 0)

    def test_sensor_decode_from_0x30e_fallback_and_bounds(self):
        """Verify 0x30E D7 acts as non-zero fallback (e.g. DCFC) and rejects invalid/SNA 0x258/0x259 values."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmd = next(c for c in commands if c.get("id") == "ev_charging_power")
        sensor = CanDoSensorEntity(self.coordinator, chg_cmd)

        # 1. DC Fast Charging at 150 kW (OBC off/absent, 0x30E D7 = 150)
        self.coordinator.can_states["0x30e"] = [0x00, 0x00, 0x28, 0x05, 0x21, 0x00, 150, 0x10]
        self.assertEqual(sensor.native_value, 150)

        # 2. Idle / 0 kW with only 0x30E present
        self.coordinator.can_states["0x30e"] = [0x00, 0x00, 0x28, 0x05, 0x21, 0x00, 0x00, 0x04]
        self.assertEqual(sensor.native_value, 0)

        # 3. SNA / 0xFFFF in 0x258 or 0x259 is ignored without corrupting fallback or returning garbage
        self.coordinator.can_states["0x258"] = [0x00, 0xFF, 0xFF, 0x00, 0x10, 0x25, 0x00, 0x24]
        self.coordinator.can_states["0x259"] = [0xFF, 0xFF, 0x86, 0x3C, 0x45, 0x02, 0x00, 0x00]
        self.coordinator.can_states["0x30e"] = None
        self.assertIsNone(sensor.native_value)

    def test_sensor_decode_from_emitted_entity_state(self):
        """Verify sensor handles direct numeric state published from edge firmware."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmd = next(c for c in commands if c.get("id") == "ev_charging_power")
        sensor = CanDoSensorEntity(self.coordinator, chg_cmd)

        # Edge device publishes 10.6 kW directly
        self.coordinator.can_states["0x30e"] = None
        self.coordinator.can_states["ev_charging_power"] = 10.6
        self.assertEqual(sensor.native_value, 10.6)

    def test_crc_filter_skips_alive_counter_updates(self):
        """Verify coordinator does not notify listeners when only rolling counter Byte 7 changes."""
        listener_mock = MagicMock()
        self.coordinator.register_listener("0x30e", listener_mock)

        # First message: 7 kW, Byte 7 = 0xFE
        msg1 = MagicMock()
        msg1.topic = "cando/test_device/state/0x30E"
        msg1.payload = "00002805210007FE"
        self.coordinator._handle_can_state_message(msg1)
        self.assertEqual(listener_mock.call_count, 1)

        # Second message: 7 kW, Byte 7 changed to 0x10 (alive counter increment)
        msg2 = MagicMock()
        msg2.topic = "cando/test_device/state/0x30E"
        msg2.payload = "0000280521000710"
        self.coordinator._handle_can_state_message(msg2)
        # Should NOT trigger listener again because bytes 0-6 are unchanged
        self.assertEqual(listener_mock.call_count, 1)

        # Third message: Power changed to 8 kW
        msg3 = MagicMock()
        msg3.topic = "cando/test_device/state/0x30E"
        msg3.payload = "0000280521000804"
        self.coordinator._handle_can_state_message(msg3)
        self.assertEqual(listener_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()
