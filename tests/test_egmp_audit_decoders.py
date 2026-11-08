"""Unit tests for E-GMP native vs legacy Gen 2 CAN ID audit, catalog variants, and decoders."""

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


def _reg_mod(name: str):
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

ha_bs = _reg_mod("homeassistant.components.binary_sensor")


class BinarySensorEntity:
    pass


class BinarySensorDeviceClass:
    PRESENCE = "presence"
    PROBLEM = "problem"
    SAFETY = "safety"
    CONNECTIVITY = "connectivity"
    DOOR = "door"
    LOCK = "lock"
    GARAGE_DOOR = "garage_door"
    BATTERY_CHARGING = "battery_charging"


ha_bs.BinarySensorEntity = BinarySensorEntity
ha_bs.BinarySensorDeviceClass = BinarySensorDeviceClass

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

from custom_components.can_do.binary_sensor import CanDoBinarySensorEntity
from custom_components.can_do.catalog_loader import (
    check_match,
    get_monitored_can_ids,
    get_vehicle_commands,
    load_catalog,
    resolve_variant,
)
from custom_components.can_do.coordinator import CanDoDataCoordinator
from custom_components.can_do.sensor import CanDoSensorEntity


class TestEgmpAuditDecoders(unittest.TestCase):
    """Test suite verifying E-GMP native vs legacy Gen 2 CAN IDs and decoding."""

    def setUp(self):
        self.catalog = load_catalog()
        self.commands_by_id = {c["id"]: c for c in self.catalog.get("commands", [])}

        self.hass = MagicMock()
        self.entry_data = {
            "device_id": "test_device",
            "vehicle_id": "kia_ev6",
            "base_topic": "cando",
        }
        self.coordinator = CanDoDataCoordinator(self.hass, self.entry_data)

    def test_cond_charging_catalog_variants(self):
        """Verify cond_charging resolves to 0x326 on E-GMP and 0x594 on Gen 2."""
        cmd = self.commands_by_id.get("cond_charging")
        self.assertIsNotNone(cmd, "cond_charging must exist in catalog")
        self.assertEqual(cmd.get("state_can_id"), "0x326")

        # Resolve for E-GMP
        resolved_egmp = resolve_variant(cmd, "kia_ev6")
        self.assertEqual(resolved_egmp["network"]["state_can_id"], "0x326")
        self.assertEqual(resolved_egmp.get("state_can_id"), "0x326")

        # Resolve for Gen 2
        resolved_gen2 = resolve_variant(cmd, "hyundai_kona_ev")
        self.assertEqual(resolved_gen2["network"]["state_can_id"], "0x594")
        self.assertEqual(resolved_gen2.get("state_can_id"), "0x594")

    def test_ev_charge_type_active_catalog_variants(self):
        """Verify ev_charge_type_active resolves to 0x30B on E-GMP and 0x595 on Gen 2."""
        cmd = self.commands_by_id.get("ev_charge_type_active")
        self.assertIsNotNone(cmd, "ev_charge_type_active must exist in catalog")
        self.assertEqual(cmd.get("state_can_id"), "0x30B")

        # Resolve for E-GMP
        resolved_egmp = resolve_variant(cmd, "all_egmp")
        self.assertEqual(resolved_egmp["network"]["state_can_id"], "0x30B")
        self.assertEqual(resolved_egmp.get("state_can_id"), "0x30B")

        # Resolve for Gen 2
        resolved_gen2 = resolve_variant(cmd, "all_gen2")
        self.assertEqual(resolved_gen2["network"]["state_can_id"], "0x595")
        self.assertEqual(resolved_gen2.get("state_can_id"), "0x595")

    def test_tpms_catalog_variants(self):
        """Verify TPMS entities resolve to 0x3A1/0x3A2 on E-GMP and 0x593 on Gen 2."""
        for wheel in ("fl", "fr", "rl", "rr"):
            cid = f"tpms_low_pressure_{wheel}"
            cmd = self.commands_by_id.get(cid)
            self.assertIsNotNone(cmd, f"{cid} must exist")
            self.assertEqual(cmd.get("state_can_id"), "0x3A1")

            resolved_egmp = resolve_variant(cmd, "kia_ev6")
            self.assertEqual(resolved_egmp["network"]["state_can_id"], "0x3A1")

            resolved_gen2 = resolve_variant(cmd, "hyundai_kona_ev")
            self.assertEqual(resolved_gen2["network"]["state_can_id"], "0x593")

        warn_lamp = self.commands_by_id.get("tpms_warning_lamp")
        self.assertIsNotNone(warn_lamp)
        self.assertEqual(warn_lamp.get("state_can_id"), "0x3A2")
        self.assertEqual(resolve_variant(warn_lamp, "kia_ev6")["network"]["state_can_id"], "0x3A2")
        self.assertEqual(resolve_variant(warn_lamp, "hyundai_kona_ev")["network"]["state_can_id"], "0x593")

    def test_epb_and_climate_variants(self):
        """Verify EPB resolves to 0x1F1 / 0x490 and Climate to 0x380 / 0x5F5."""
        epb = self.commands_by_id.get("electric_parking_brake_status")
        self.assertIsNotNone(epb)
        self.assertEqual(resolve_variant(epb, "kia_ev6")["network"]["state_can_id"], "0x1F1")
        self.assertEqual(resolve_variant(epb, "hyundai_kona_ev")["network"]["state_can_id"], "0x490")

        clim = self.commands_by_id.get("climate_telemetry_status")
        self.assertIsNotNone(clim)
        self.assertEqual(resolve_variant(clim, "kia_ev6")["network"]["state_can_id"], "0x380")
        self.assertEqual(resolve_variant(clim, "hyundai_kona_ev")["network"]["state_can_id"], "0x5F5")

        fan = self.commands_by_id.get("climate_blower_fan_status")
        self.assertIsNotNone(fan)
        self.assertEqual(resolve_variant(fan, "kia_ev6")["network"]["state_can_id"], "0x384")
        self.assertEqual(resolve_variant(fan, "hyundai_kona_ev")["network"]["state_can_id"], "0x5F7")

    def test_monitored_can_ids_egmp_vs_gen2(self):
        """Verify monitored CAN IDs reflect native Gen 3 on E-GMP and Gen 2 on Kona."""
        egmp_ids = get_monitored_can_ids("kia_ev6")
        self.assertIn("0x326", egmp_ids)
        self.assertIn("0x30b", egmp_ids)
        self.assertIn("0x3a1", egmp_ids)
        self.assertIn("0x3a2", egmp_ids)
        self.assertIn("0x1f1", egmp_ids)
        self.assertIn("0x380", egmp_ids)
        self.assertIn("0x384", egmp_ids)
        self.assertIn("0x327", egmp_ids)
        self.assertIn("0x25c", egmp_ids)
        self.assertIn("0x328", egmp_ids)
        self.assertIn("0x324", egmp_ids)

        gen2_ids = get_monitored_can_ids("hyundai_kona_ev")
        self.assertIn("0x594", gen2_ids)
        self.assertIn("0x595", gen2_ids)
        self.assertIn("0x593", gen2_ids)
        self.assertIn("0x490", gen2_ids)
        self.assertIn("0x5f5", gen2_ids)
        self.assertIn("0x5f7", gen2_ids)
        self.assertIn("0x597", gen2_ids)
        self.assertIn("0x4e2", gen2_ids)

    def test_cond_charging_decoding(self):
        """Test CanDoSensorEntity decoding for cond_charging from 0x326 (E-GMP) and 0x594 (Gen 2)."""
        # E-GMP (0x326)
        cmd_egmp = resolve_variant(self.commands_by_id["cond_charging"], "kia_ev6")
        sensor_egmp = CanDoSensorEntity(self.coordinator, cmd_egmp)

        # 0x326 D5 bit 0:1 == 1 -> Active charging
        self.coordinator.can_states["0x326"] = [0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_egmp.native_value, "Charging In Progress")

        # 0x326 D5 bit 0:1 == 0 -> Inactive / Disconnected
        self.coordinator.can_states["0x326"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_egmp.native_value, "Not Charging / Disconnected")

        # Direct string telemetry
        self.coordinator.can_states.pop("0x326", None)
        self.coordinator.can_states["cond_charging"] = "Charging"
        self.assertEqual(sensor_egmp.native_value, "Charging In Progress")
        self.coordinator.can_states["cond_charging"] = "Inactive"
        self.assertEqual(sensor_egmp.native_value, "Not Charging / Disconnected")

        # Gen 2 (0x594 BMS1 Byte D2 bit 1)
        cmd_gen2 = resolve_variant(self.commands_by_id["cond_charging"], "hyundai_kona_ev")
        sensor_gen2 = CanDoSensorEntity(self.coordinator, cmd_gen2)

        # 0x594 D2 = 0x02 (Bit 1 = 1) -> Active charging
        self.coordinator.can_states["0x594"] = [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_gen2.native_value, "Charging In Progress")

        # 0x594 D2 = 0x00 -> Inactive
        self.coordinator.can_states["0x594"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_gen2.native_value, "Not Charging / Disconnected")

    def test_ev_charge_type_active_decoding(self):
        """Test CanDoSensorEntity decoding for ev_charge_type_active from 0x30B (E-GMP) and 0x595 (Gen 2)."""
        # E-GMP (0x30B)
        cmd_egmp = resolve_variant(self.commands_by_id["ev_charge_type_active"], "kia_ev6")
        sensor_egmp = CanDoSensorEntity(self.coordinator, cmd_egmp)

        # D7 & 0x30 == 0x10 -> Level 2 AC
        self.coordinator.can_states["0x30b"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00]
        self.assertEqual(sensor_egmp.native_value, "Standard AC Charging (Level 2)")

        # D7 & 0x0C == 0x04 -> DC Fast Charging
        self.coordinator.can_states["0x30b"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00]
        self.assertEqual(sensor_egmp.native_value, "DC Fast Charging (CCS / 800V)")

        # D7 & 0x3C == 0x00 -> Not Charging / Disconnected
        self.coordinator.can_states["0x30b"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_egmp.native_value, "Not Charging / Disconnected")

        # Gen 2 (0x595 BMS2 Byte D1)
        cmd_gen2 = resolve_variant(self.commands_by_id["ev_charge_type_active"], "hyundai_kona_ev")
        sensor_gen2 = CanDoSensorEntity(self.coordinator, cmd_gen2)

        # D1 = 0x02 -> Level 2 AC
        self.coordinator.can_states["0x595"] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_gen2.native_value, "Standard AC Charging (Level 2)")

        # D1 = 0x04 -> DC Fast Charging
        self.coordinator.can_states["0x595"] = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_gen2.native_value, "DC Fast Charging (CCS / 800V)")

        # D1 = 0x08 -> Level 1 120V Trickle Charging
        self.coordinator.can_states["0x595"] = [0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_gen2.native_value, "120V Trickle Charging (Level 1)")

        # D1 = 0x00 -> Not Charging / Disconnected
        self.coordinator.can_states["0x595"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_gen2.native_value, "Not Charging / Disconnected")

    def test_tpms_binary_sensor_decoding(self):
        """Test CanDoBinarySensorEntity decoding for 0x3A1 low pressure/fault and 0x3A2 warning."""
        # FL Wheel Low Pressure on 0x3A1 (E-GMP)
        fl_cmd = resolve_variant(self.commands_by_id["tpms_low_pressure_fl"], "kia_ev6")
        fl_sensor = CanDoBinarySensorEntity(self.coordinator, fl_cmd)

        # Low Pressure: D4 = 0x01
        self.coordinator.can_states["0x3a1"] = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(fl_sensor.is_on)

        # Severe Low Pressure: D4 = 0x02
        self.coordinator.can_states["0x3a1"] = [0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(fl_sensor.is_on)

        # Sensor Fault: D4 = 0x03
        self.coordinator.can_states["0x3a1"] = [0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(fl_sensor.is_on)

        # Normal: D4 = 0x00
        self.coordinator.can_states["0x3a1"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertFalse(fl_sensor.is_on)

        # Master TPMS Warning Lamp on 0x3A2 (D1 bits 3:4)
        warn_cmd = resolve_variant(self.commands_by_id["tpms_warning_lamp"], "kia_ev6")
        warn_sensor = CanDoBinarySensorEntity(self.coordinator, warn_cmd)

        # 0x08 = Low Pressure Warning
        self.coordinator.can_states["0x3a2"] = [0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(warn_sensor.is_on)

        # 0x10 = Sensor Fault
        self.coordinator.can_states["0x3a2"] = [0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(warn_sensor.is_on)

        # 0x00 = Normal
        self.coordinator.can_states["0x3a2"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertFalse(warn_sensor.is_on)

        # Gen 2 TPMS (0x593 D1 bit 4 for FL)
        gen2_fl_cmd = resolve_variant(self.commands_by_id["tpms_low_pressure_fl"], "hyundai_kona_ev")
        gen2_fl_sensor = CanDoBinarySensorEntity(self.coordinator, gen2_fl_cmd)
        self.coordinator.can_states["0x593"] = [0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(gen2_fl_sensor.is_on)
        self.coordinator.can_states["0x593"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertFalse(gen2_fl_sensor.is_on)

    def test_epb_binary_sensor_decoding(self):
        """Test CanDoBinarySensorEntity decoding for EPB 0x1F1 frame (E-GMP) and 0x490 (Gen 2)."""
        epb_cmd = resolve_variant(self.commands_by_id["electric_parking_brake_status"], "kia_ev6")
        epb_sensor = CanDoBinarySensorEntity(self.coordinator, epb_cmd)

        # Real E-GMP vehicle log clamped frame from Logs/charging.csv: [0xFD, 0xEF, 0x6B, 0x01, 0x00, 0x00, 0x28, 0x00]
        self.coordinator.can_states["0x1f1"] = [0xFD, 0xEF, 0x6B, 0x01, 0x00, 0x00, 0x28, 0x00]
        self.assertTrue(epb_sensor.is_on)

        # Alternate clamped: D4 = 0x10
        self.coordinator.can_states["0x1f1"] = [0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(epb_sensor.is_on)

        # Released: D4 = 0x00
        self.coordinator.can_states["0x1f1"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertFalse(epb_sensor.is_on)

        # Legacy Gen 2 (0x490 D1 = 0x01)
        epb_gen2 = resolve_variant(self.commands_by_id["electric_parking_brake_status"], "hyundai_kona_ev")
        epb_gen2_sensor = CanDoBinarySensorEntity(self.coordinator, epb_gen2)
        self.coordinator.can_states["0x490"] = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(epb_gen2_sensor.is_on)
        self.coordinator.can_states["0x490"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertFalse(epb_gen2_sensor.is_on)

    def test_remaining_charge_time_catalog_variants_and_decoding(self):
        """Verify remaining charge times resolve to 0x327/0x25C/0x328 on E-GMP and 0x597/0x4E2 on Gen 2."""
        # AC Remaining Time
        ac_egmp = resolve_variant(self.commands_by_id["remaining_charge_time_ac"], "kia_ev6")
        self.assertEqual(ac_egmp["network"]["state_can_id"], "0x327")
        ac_gen2 = resolve_variant(self.commands_by_id["remaining_charge_time_ac"], "hyundai_kona_ev")
        self.assertEqual(ac_gen2["network"]["state_can_id"], "0x597")

        sensor_ac_gen2 = CanDoSensorEntity(self.coordinator, ac_gen2)
        # 0x597 Bytes 1-2 LE = 120 minutes (0x0078: D2=0x78, D3=0x00)
        self.coordinator.can_states["0x597"] = [0x00, 0x78, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_ac_gen2.native_value, 120)

        # DC Remaining Time
        dc_egmp = resolve_variant(self.commands_by_id["remaining_charge_time_dc"], "kia_ev6")
        self.assertEqual(dc_egmp["network"]["state_can_id"], "0x25C")
        dc_gen2 = resolve_variant(self.commands_by_id["remaining_charge_time_dc"], "hyundai_kona_ev")
        self.assertEqual(dc_gen2["network"]["state_can_id"], "0x597")

        sensor_dc_gen2 = CanDoSensorEntity(self.coordinator, dc_gen2)
        # 0x597 Bytes 3-4 LE = 35 minutes (0x0023: D4=0x23, D5=0x00)
        self.coordinator.can_states["0x597"] = [0x00, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_dc_gen2.native_value, 35)

        # 120V Level 1 Remaining Time
        l1_egmp = resolve_variant(self.commands_by_id["remaining_charge_time_120v"], "kia_ev6")
        self.assertEqual(l1_egmp["network"]["state_can_id"], "0x328")
        l1_gen2 = resolve_variant(self.commands_by_id["remaining_charge_time_120v"], "hyundai_kona_ev")
        self.assertEqual(l1_gen2["network"]["state_can_id"], "0x4E2")

        sensor_l1_gen2 = CanDoSensorEntity(self.coordinator, l1_gen2)
        # 0x4E2 Bytes 2-3 LE = 450 minutes (0x01C2: D3=0xC2, D4=0x01)
        self.coordinator.can_states["0x4e2"] = [0x00, 0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor_l1_gen2.native_value, 450)

    def test_wican_direct_entity_state_and_can_id_normalization(self):
        """Verify coordinator normalizes CAN IDs (0x45 vs 0x045) and entity platforms ingest WiCAN live states."""
        # 1. CAN ID Normalization in Coordinator
        self.coordinator.can_states["0x045"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00]
        # Querying with non-padded 0x45 should successfully retrieve 0x045 payload
        p = self.coordinator.get_can_payload("0x45")
        self.assertEqual(p, [0x00, 0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00])

        # 2. Direct string state handling in binary sensor (doors_status)
        cmd_doors = self.commands_by_id["doors_status"]
        bs = CanDoBinarySensorEntity(self.coordinator, cmd_doors)
        self.coordinator.can_states["doors_status"] = "All Doors Closed"
        self.assertFalse(bs.is_on)
        self.coordinator.can_states["doors_status"] = "Driver Door Open"
        self.assertTrue(bs.is_on)


if __name__ == "__main__":
    unittest.main()
