"""Unit tests for E-GMP Charge & Discharge Remaining Times end-to-end pipeline."""

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# Setup package mock for custom_components.can_do if not already registered
can_do_dir = Path(__file__).resolve().parent.parent / "custom_components" / "can_do"
if "custom_components" not in sys.modules:
    sys.modules["custom_components"] = types.ModuleType("custom_components")
if "custom_components.can_do" not in sys.modules:
    pkg = types.ModuleType("custom_components.can_do")
    pkg.__path__ = [str(can_do_dir)]
    pkg.__file__ = str(can_do_dir / "__init__.py")
    sys.modules["custom_components.can_do"] = pkg

def _reg_mod(name):
    if name in sys.modules:
        return sys.modules[name]
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
    DURATION = "duration"
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
ha_const.UnitOfTime = MagicMock()
ha_const.UnitOfTime.MINUTES = "min"

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
ha_device.DeviceInfo = MagicMock

ha_plat = _reg_mod("homeassistant.helpers.entity_platform")
ha_plat.AddEntitiesCallback = MagicMock

from custom_components.can_do.coordinator import CanDoDataCoordinator
from custom_components.can_do.catalog_loader import get_monitored_can_ids, get_vehicle_commands
from custom_components.can_do.sensor import CanDoSensorEntity


class TestRemainingChargeTimePipeline(unittest.TestCase):
    """Test full pipeline for E-GMP Charge & Discharge Remaining Times."""

    def setUp(self):
        self.hass = MagicMock()
        self.entry_data = {
            "device_id": "test_device",
            "vehicle_id": "kia_ev6",
            "base_topic": "cando",
        }
        self.coordinator = CanDoDataCoordinator(self.hass, self.entry_data)
        self.commands = get_vehicle_commands("kia_ev6")

    def test_catalog_can_ids_and_metadata(self):
        """Verify CAN IDs and duration metadata in catalog for all charge time entities."""
        monitored_ids = get_monitored_can_ids("kia_ev6")

        # 1. AC Normal Charge Remaining Time (0x327)
        ac_cmd = next(c for c in self.commands if c.get("id") == "remaining_charge_time_ac")
        self.assertEqual(ac_cmd["network"]["state_can_id"], "0x327")
        self.assertEqual(ac_cmd["network"]["unit"], "min")
        self.assertEqual(ac_cmd["ha_metadata"]["device_class"], "duration")
        self.assertIn("0x327", monitored_ids)

        # 2. DC Fast Charge Remaining Time (0x25C)
        dc_cmd = next(c for c in self.commands if c.get("id") == "remaining_charge_time_dc")
        self.assertEqual(dc_cmd["network"]["state_can_id"], "0x25C")
        self.assertEqual(dc_cmd["network"]["unit"], "min")
        self.assertEqual(dc_cmd["ha_metadata"]["device_class"], "duration")
        self.assertIn("0x25c", monitored_ids)

        # 3. Level 1 120V Charge Remaining Time (0x328)
        l1_cmd = next(c for c in self.commands if c.get("id") == "remaining_charge_time_120v")
        self.assertEqual(l1_cmd["network"]["state_can_id"], "0x328")
        self.assertEqual(l1_cmd["network"]["unit"], "min")
        self.assertEqual(l1_cmd["ha_metadata"]["device_class"], "duration")
        self.assertIn("0x328", monitored_ids)

        # 4. V2L Discharge Remaining Time (0x324)
        v2l_cmd = next(c for c in self.commands if c.get("id") == "v2l_discharge_remaining_time")
        self.assertEqual(v2l_cmd["network"]["state_can_id"], "0x324")
        self.assertEqual(v2l_cmd["network"]["unit"], "min")
        self.assertEqual(v2l_cmd["ha_metadata"]["device_class"], "duration")
        self.assertIn("0x324", monitored_ids)

    def test_ac_charging_time_decode(self):
        """Verify 0x327 AC Level 2 decoding from raw frames and live emission."""
        ac_cmd = next(c for c in self.commands if c.get("id") == "remaining_charge_time_ac")
        sensor = CanDoSensorEntity(self.coordinator, ac_cmd)

        # Actively charging: 75 minutes = 0x004B (D1=0x4B, D2=0x00)
        self.coordinator.can_states["0x327"] = [0x4B, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 75)

        # Inactive / not charging: 0xFFFF (D1=0xFF, D2=0xFF) -> returns 0
        self.coordinator.can_states["0x327"] = [0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 0)

        # Live telemetry string from edge firmware: "125"
        self.coordinator.can_states["0x327"] = None
        self.coordinator.can_states["remaining_charge_time_ac"] = "125"
        self.assertEqual(sensor.native_value, 125)

    def test_dc_fast_charging_time_decode(self):
        """Verify 0x25C DC Fast Charge decoding from raw frames and live emission."""
        dc_cmd = next(c for c in self.commands if c.get("id") == "remaining_charge_time_dc")
        sensor = CanDoSensorEntity(self.coordinator, dc_cmd)

        # Actively DC fast charging: 20 minutes = 0x0014 (D3=0x14, D4=0x00)
        self.coordinator.can_states["0x25c"] = [0x4B, 0x14, 0x14, 0x00, 0x14, 0x14, 0xFF, 0xFF]
        self.assertEqual(sensor.native_value, 20)

        # Inactive: D3=0xFF, D4=0xFF -> returns 0
        self.coordinator.can_states["0x25c"] = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
        self.assertEqual(sensor.native_value, 0)

        # Live telemetry string from edge firmware: "18"
        self.coordinator.can_states["0x25c"] = None
        self.coordinator.can_states["remaining_charge_time_dc"] = "18"
        self.assertEqual(sensor.native_value, 18)

    def test_120v_trickle_charging_time_decode(self):
        """Verify 0x328 Level 1 (120V) decoding from raw frames and live emission."""
        l1_cmd = next(c for c in self.commands if c.get("id") == "remaining_charge_time_120v")
        sensor = CanDoSensorEntity(self.coordinator, l1_cmd)

        # 14 hours = 840 minutes = 0x0348 (D1=0x48, D2=0x03)
        self.coordinator.can_states["0x328"] = [0x48, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 840)

        # Inactive: 0xFFFF -> returns 0
        self.coordinator.can_states["0x328"] = [0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 0)

    def test_v2l_discharge_runtime_decode(self):
        """Verify 0x324 V2L runtime remaining decoding from raw frames and live emission."""
        v2l_cmd = next(c for c in self.commands if c.get("id") == "v2l_discharge_remaining_time")
        sensor = CanDoSensorEntity(self.coordinator, v2l_cmd)

        # 5 hours = 300 minutes = 0x012C (D7=0x2C, D8=0x01)
        self.coordinator.can_states["0x324"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2C, 0x01]
        self.assertEqual(sensor.native_value, 300)

        # Inactive / not discharging: 0xFFFF -> returns 0
        self.coordinator.can_states["0x324"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF]
        self.assertEqual(sensor.native_value, 0)

    def test_gen2_remaining_charge_time_decode(self):
        """Verify Gen 2 legacy 0x597 (AC/DC) and 0x4E2 (120V) decoding."""
        kona_cmds = get_vehicle_commands("hyundai_kona_ev")

        # 1. AC on 0x597 (Bytes 1-2 LE)
        ac_cmd = next(c for c in kona_cmds if c.get("id") == "remaining_charge_time_ac")
        self.assertEqual(ac_cmd["network"]["state_can_id"], "0x597")
        ac_sensor = CanDoSensorEntity(self.coordinator, ac_cmd)
        # 120 minutes = 0x0078 (D2=0x78, D3=0x00)
        self.coordinator.can_states["0x597"] = [0x00, 0x78, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(ac_sensor.native_value, 120)

        # Inactive 0xFFFF -> returns 0
        self.coordinator.can_states["0x597"] = [0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(ac_sensor.native_value, 0)

        # 2. DC on 0x597 (Bytes 3-4 LE)
        dc_cmd = next(c for c in kona_cmds if c.get("id") == "remaining_charge_time_dc")
        self.assertEqual(dc_cmd["network"]["state_can_id"], "0x597")
        dc_sensor = CanDoSensorEntity(self.coordinator, dc_cmd)
        # 45 minutes = 0x002D (D4=0x2D, D5=0x00)
        self.coordinator.can_states["0x597"] = [0x00, 0x00, 0x00, 0x2D, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(dc_sensor.native_value, 45)

        # 3. 120V on 0x4E2 (Bytes 2-3 LE)
        l1_cmd = next(c for c in kona_cmds if c.get("id") == "remaining_charge_time_120v")
        self.assertEqual(l1_cmd["network"]["state_can_id"], "0x4E2")
        l1_sensor = CanDoSensorEntity(self.coordinator, l1_cmd)
        # 600 minutes = 0x0258 (D3=0x58, D4=0x02)
        self.coordinator.can_states["0x4e2"] = [0x00, 0x00, 0x58, 0x02, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(l1_sensor.native_value, 600)


if __name__ == "__main__":
    unittest.main()


