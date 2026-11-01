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
        """Verify 0x30E is in the catalog and monitored CAN IDs for E-GMP."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmds = [c for c in commands if c.get("id") == "ev_charging_power"]
        self.assertEqual(len(chg_cmds), 1, "ev_charging_power entity must exist in catalog")
        
        chg_cmd = chg_cmds[0]
        net = chg_cmd.get("network", {})
        self.assertEqual(net.get("state_can_id"), "0x30E")
        self.assertEqual(net.get("state_byte"), "D7")
        self.assertEqual(net.get("unit"), "kW")

        monitored_ids = get_monitored_can_ids("kia_ev6")
        self.assertIn("0x30e", monitored_ids, "0x30e must be in monitored CAN IDs list")

    def test_crc_can_ids_contains_30e(self):
        """Verify 0x30e is in _CRC_CAN_IDS to filter out rolling counter byte 7."""
        self.assertIn("0x30e", _CRC_CAN_IDS)

    def test_sensor_decode_from_raw_can_payload(self):
        """Verify sensor decodes Byte 6 (D7) from raw 8-byte frame."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmd = next(c for c in commands if c.get("id") == "ev_charging_power")
        sensor = CanDoSensorEntity(self.coordinator, chg_cmd)

        # 1. Level 2 AC Charging at 7 kW: 00 00 28 05 21 00 07 FE (Byte 6 = 0x07)
        self.coordinator.can_states["0x30e"] = [0x00, 0x00, 0x28, 0x05, 0x21, 0x00, 0x07, 0xFE]
        self.assertEqual(sensor.native_value, 7)

        # 2. DC Fast Charging at 150 kW: 00 00 28 05 21 00 96 10 (Byte 6 = 0x96 = 150)
        self.coordinator.can_states["0x30e"] = [0x00, 0x00, 0x28, 0x05, 0x21, 0x00, 150, 0x10]
        self.assertEqual(sensor.native_value, 150)

        # 3. Idle / 0 kW: 00 00 28 05 21 00 00 04
        self.coordinator.can_states["0x30e"] = [0x00, 0x00, 0x28, 0x05, 0x21, 0x00, 0x00, 0x04]
        self.assertEqual(sensor.native_value, 0)

    def test_sensor_decode_from_emitted_entity_state(self):
        """Verify sensor handles direct numeric state published from edge firmware."""
        commands = get_vehicle_commands("kia_ev6")
        chg_cmd = next(c for c in commands if c.get("id") == "ev_charging_power")
        sensor = CanDoSensorEntity(self.coordinator, chg_cmd)

        # Edge device publishes 11 kW directly
        self.coordinator.can_states["0x30e"] = None
        self.coordinator.can_states["ev_charging_power"] = 11.0
        self.assertEqual(sensor.native_value, 11)

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
