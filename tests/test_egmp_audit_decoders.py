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
    OPENING = "opening"
    OCCUPANCY = "occupancy"
    WINDOW = "window"


ha_bs.BinarySensorEntity = BinarySensorEntity
ha_bs.BinarySensorDeviceClass = BinarySensorDeviceClass

ha_event = _reg_mod("homeassistant.components.event")


class EventEntity:
    def _trigger_event(self, event_type, event_data=None):
        if not hasattr(self, "triggered_events"):
            self.triggered_events = []
        self.triggered_events.append((event_type, event_data))


ha_event.EventEntity = EventEntity

ha_climate = _reg_mod("homeassistant.components.climate")
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

    @property
    def name(self):
        return getattr(self, "_attr_name", None)

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
from custom_components.can_do.climate import CanDoClimateEntity
from custom_components.can_do.coordinator import CanDoDataCoordinator
from custom_components.can_do.event import CanDoEventEntity
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
        """Verify cond_charging resolves to 0x326 on E-GMP."""
        cmd = self.commands_by_id.get("cond_charging")
        self.assertIsNotNone(cmd, "cond_charging must exist in catalog")
        self.assertEqual(cmd.get("state_can_id"), "0x326")

        # Resolve for E-GMP
        resolved_egmp = resolve_variant(cmd, "kia_ev6")
        self.assertEqual(resolved_egmp["network"]["state_can_id"], "0x326")
        self.assertEqual(resolved_egmp.get("state_can_id"), "0x326")

    def test_ev_charge_type_active_catalog_variants(self):
        """Verify ev_charge_type_active resolves to 0x30B on E-GMP."""
        cmd = self.commands_by_id.get("ev_charge_type_active")
        self.assertIsNotNone(cmd, "ev_charge_type_active must exist in catalog")
        self.assertEqual(cmd.get("state_can_id"), "0x30B")

        # Resolve for E-GMP
        resolved_egmp = resolve_variant(cmd, "all_egmp")
        self.assertEqual(resolved_egmp["network"]["state_can_id"], "0x30B")
        self.assertEqual(resolved_egmp.get("state_can_id"), "0x30B")

    def test_tpms_catalog_variants(self):
        """Verify TPMS entities resolve to 0x3A1/0x3A2 on E-GMP."""
        for wheel in ("fl", "fr", "rl", "rr"):
            cid = f"tpms_low_pressure_{wheel}"
            cmd = self.commands_by_id.get(cid)
            self.assertIsNotNone(cmd, f"{cid} must exist")
            self.assertEqual(cmd.get("state_can_id"), "0x3A1")

            resolved_egmp = resolve_variant(cmd, "kia_ev6")
            self.assertEqual(resolved_egmp["network"]["state_can_id"], "0x3A1")

        warn_lamp = self.commands_by_id.get("tpms_warning_lamp")
        self.assertIsNotNone(warn_lamp)
        self.assertEqual(warn_lamp.get("state_can_id"), "0x3A2")
        self.assertEqual(resolve_variant(warn_lamp, "kia_ev6")["network"]["state_can_id"], "0x3A2")

    def test_epb_and_climate_variants(self):
        """Verify EPB resolves to 0x1F1 and Climate Fan to 0x384 on E-GMP."""
        epb = self.commands_by_id.get("electric_parking_brake_status")
        self.assertIsNotNone(epb)
        self.assertEqual(resolve_variant(epb, "kia_ev6")["network"]["state_can_id"], "0x1F1")

        fan = self.commands_by_id.get("climate_blower_fan_status")
        self.assertIsNotNone(fan)
        self.assertEqual(resolve_variant(fan, "kia_ev6")["network"]["state_can_id"], "0x384")

    def test_monitored_can_ids_egmp_vs_gen2(self):
        """Verify monitored CAN IDs reflect native Gen 3 on E-GMP."""
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

    def test_cond_charging_decoding(self):
        """Test CanDoSensorEntity decoding for cond_charging from 0x326 (E-GMP)."""
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

    def test_ev_charge_type_active_decoding(self):
        """Test CanDoSensorEntity decoding for ev_charge_type_active from 0x30B (E-GMP)."""
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

    def test_epb_binary_sensor_decoding(self):
        """Test CanDoBinarySensorEntity decoding for EPB 0x1F1 frame (E-GMP)."""
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

    def test_remaining_charge_time_catalog_variants_and_decoding(self):
        """Verify remaining charge times resolve to 0x327/0x25C/0x328 on E-GMP."""
        # AC Remaining Time
        ac_egmp = resolve_variant(self.commands_by_id["remaining_charge_time_ac"], "kia_ev6")
        self.assertEqual(ac_egmp["network"]["state_can_id"], "0x327")

        # DC Remaining Time
        dc_egmp = resolve_variant(self.commands_by_id["remaining_charge_time_dc"], "kia_ev6")
        self.assertEqual(dc_egmp["network"]["state_can_id"], "0x25C")

        # 120V Level 1 Remaining Time
        l1_egmp = resolve_variant(self.commands_by_id["remaining_charge_time_120v"], "kia_ev6")
        self.assertEqual(l1_egmp["network"]["state_can_id"], "0x328")

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

    def test_direct_bms_and_12v_float_priority_over_raw_frames(self):
        """Direct BMS (0x7EC) and 12V (vbat/0x1CF) float telemetry must not be shadowed by raw frames."""
        soc_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["bms_display_soc"])
        hv_v_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["bms_hv_voltage"])
        v12_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["cond_aux_12v_battery"])

        # Raw 0x7EC ISO-TP frame and 0x1CF regen paddle frame present on bus
        self.coordinator.can_states["0x7ec"] = [0x03, 0x7F, 0x22, 0x12, 0x00, 0x00, 0x00, 0xC8]
        self.coordinator.can_states["0x1cf"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

        # Even before direct float arrives, bms_display_soc must not misread 0x7EC D8 (0xC8 -> 100%)
        self.assertIsNone(soc_sensor.native_value)

        # Once direct float telemetry arrives (via aliases or entity_id), it takes precedence
        self.coordinator.can_states["bms_display_soc"] = 78.4
        self.coordinator.can_states["bms_hv_v"] = 742.6
        self.coordinator.can_states["vbat"] = 13.8

        self.assertEqual(soc_sensor.native_value, 78.4)
        self.assertEqual(hv_v_sensor.native_value, 742.6)
        self.assertEqual(v12_sensor.native_value, 13.8)

    def test_fan_speed_speed_limit_and_bms_extremes_sensors(self):
        """Verify 0x31B fan speed discrete matching, 0x1FA state_class omission, and 0x5D6/0x5D7 decoding."""
        # 1. climate_fan_speed_level (0x31B D4 low nibble with high-nibble airflow bits 0x20 set)
        fan_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["climate_fan_speed_level"])
        self.coordinator.can_states["0x31b"] = [0x00, 0x00, 0x00, 0x24, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(fan_sensor.native_value, "Speed 3")

        # 2. camera_speed_limit_sign (0x1FA) returns string and must not set MEASUREMENT state_class
        cam_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["camera_speed_limit_sign"])
        self.assertFalse(hasattr(cam_sensor, "_attr_state_class"))
        self.coordinator.can_states["0x1fa"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x69, 0x00, 0x00]
        self.assertEqual(cam_sensor.native_value, "Speed Limit 65 mph / 105 km/h")

        # 3. bms_cell_extremes_voltage (0x5D6): D1=0xC0 (192 * 0.02 = 3.84V), D3=0xBC (188 * 0.02 = 3.76V)
        cell_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["bms_cell_extremes_voltage"])
        self.coordinator.can_states["0x5d6"] = [0xC0, 0x00, 0xBC, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(cell_sensor.native_value, 3.84)
        cell_attrs = cell_sensor.extra_state_attributes
        self.assertEqual(cell_attrs["max_cell_voltage_v"], 3.84)
        self.assertEqual(cell_attrs["min_cell_voltage_v"], 3.76)

        # 4. bms_module_extremes_temp (0x5D7): D1=0x3F (63 - 40 = 23C), D2=0x3D (61 - 40 = 21C)
        mod_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["bms_module_extremes_temp"])
        self.coordinator.can_states["0x5d7"] = [0x3F, 0x3D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(mod_sensor.native_value, 23.0)
        mod_attrs = mod_sensor.extra_state_attributes
        self.assertEqual(mod_attrs["max_module_temp_c"], 23)
        self.assertEqual(mod_attrs["min_module_temp_c"], 21)

    def test_multi_door_and_word_boundary_binary_sensors(self):
        """Any open door on 0x411 must keep doors_status ON, and ready/unbuckled/illuminated labels work."""
        doors_bs = CanDoBinarySensorEntity(self.coordinator, self.commands_by_id["doors_status"])

        # Driver door closed (D4=0x00), Passenger door open (D5=0x04)
        self.coordinator.can_states["0x411"] = [0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]
        self.assertTrue(doors_bs.is_on)

        # Driver door closed (D4=0x00), Rear Left door open (D7=0x10)
        self.coordinator.can_states["0x411"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00]
        self.assertTrue(doors_bs.is_on)

        # All doors closed
        self.coordinator.can_states["0x411"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertFalse(doors_bs.is_on)

        # Ready / Unbuckled / Illuminated direct & CAN option matching
        car_ready = CanDoBinarySensorEntity(self.coordinator, self.commands_by_id["car_ready_state"])
        self.coordinator.can_states["car_ready_state"] = "Vehicle Ready"
        self.assertTrue(car_ready.is_on)
        self.coordinator.can_states["car_ready_state"] = "Vehicle Awake Not Ready"
        self.assertFalse(car_ready.is_on)

        ev_ready = CanDoBinarySensorEntity(self.coordinator, self.commands_by_id["ev_system_ready"])
        self.coordinator.can_states["ev_system_ready"] = "EV Ready (Drive Mode)"
        self.assertTrue(ev_ready.is_on)
        self.coordinator.can_states["ev_system_ready"] = "EV Not Ready (Standby/Off)"
        self.assertFalse(ev_ready.is_on)

        seatbelts = CanDoBinarySensorEntity(self.coordinator, self.commands_by_id["seatbelts_status"])
        self.coordinator.can_states["seatbelts_status"] = "Driver Unbuckled"
        self.assertTrue(seatbelts.is_on)
        self.coordinator.can_states["seatbelts_status"] = "Driver Buckled"
        self.assertFalse(seatbelts.is_on)

        mlu_status = CanDoBinarySensorEntity(self.coordinator, self.commands_by_id["mlu_ambient_light_status"])
        self.coordinator.can_states["mlu_ambient_light_status"] = "Illuminated"
        self.assertTrue(mlu_status.is_on)
        self.coordinator.can_states["mlu_ambient_light_status"] = "Off"
        self.assertFalse(mlu_status.is_on)

    def test_event_entity_fires_all_non_idle_options(self):
        """Multi-option event entities must fire rising-edge events for all options and ignore Idle."""
        # 1. sw_volume (Volume Up = opt 0, Volume Down = opt 1)
        vol_cmd = self.commands_by_id["sw_volume"]
        vol_ev = CanDoEventEntity(self.coordinator, vol_cmd)
        vol_down_opt = next(o for o in vol_cmd["options"] if "down" in o["label"].lower())
        vol_down_match = vol_down_opt["match"]
        # Build matching 8-byte payload for Volume Down on 0x448
        frame = [0] * 8
        for k, v in vol_down_match.items():
            frame[int(k[1:]) - 1] = int(v, 16)
        self.coordinator.can_states["0x448"] = frame
        vol_ev._handle_can_update()
        self.assertEqual(len(getattr(vol_ev, "triggered_events", [])), 1)
        self.assertEqual(vol_ev.triggered_events[0], ("press", {"option": vol_down_opt["label"]}))

        # Repeated identical frame must not re-fire
        vol_ev._handle_can_update()
        self.assertEqual(len(vol_ev.triggered_events), 1)

        # 2. steering_paddles (Left = opt 0, Right = opt 1)
        pad_cmd = self.commands_by_id["steering_paddles"]
        pad_ev = CanDoEventEntity(self.coordinator, pad_cmd)
        right_opt = next(o for o in pad_cmd["options"] if "right" in o["label"].lower())
        p_frame = [0] * 8
        for k, v in right_opt["match"].items():
            p_frame[int(k[1:]) - 1] = int(v, 16)
        self.coordinator.can_states["0x1cf"] = p_frame
        pad_ev._handle_can_update()
        self.assertEqual(pad_ev.triggered_events, [("press", {"option": right_opt["label"]})])

        # 3. cluster_brightness (Idle = opt 0, Brightness Up (+) = opt 1)
        bri_cmd = self.commands_by_id["cluster_brightness"]
        bri_ev = CanDoEventEntity(self.coordinator, bri_cmd)
        idle_opt = next(o for o in bri_cmd["options"] if o["label"] == "Idle")
        up_opt = next(o for o in bri_cmd["options"] if "up" in o["label"].lower())

        idle_frame = [0] * 8
        for k, v in idle_opt["match"].items():
            idle_frame[int(k[1:]) - 1] = int(v, 16)
        self.coordinator.can_states["0x474"] = idle_frame
        bri_ev._handle_can_update()
        self.assertEqual(getattr(bri_ev, "triggered_events", []), [])

        up_frame = [0] * 8
        for k, v in up_opt["match"].items():
            up_frame[int(k[1:]) - 1] = int(v, 16)
        self.coordinator.can_states["0x474"] = up_frame
        bri_ev._handle_can_update()
        self.assertEqual(bri_ev.triggered_events, [("press", {"option": up_opt["label"]})])

    def test_outdoor_temperature_0x31c_and_fallbacks(self):
        """Verify 0x31C primary outdoor temp, 0x227/0x226 fallbacks, and 0xFF 419°F suppression."""
        out_cmd = resolve_variant(self.commands_by_id["outdoor_temperature"], "kia_ev6")
        self.assertEqual(out_cmd["network"]["state_can_id"], "0x31C")
        self.assertIn("0x31c", get_monitored_can_ids("kia_ev6"))

        # 1. Real US EV6 0x226 (D4=0xFF) must return None (NOT 215°C / 419°F) and no Warm threshold
        sensor = CanDoSensorEntity(self.coordinator, out_cmd)
        self.coordinator.can_states["0x226"] = [0x06, 0xDD, 0x71, 0xFF, 0x62, 0x20, 0x08, 0x42]
        self.assertIsNone(sensor.native_value)
        self.assertNotIn("threshold", sensor.extra_state_attributes)

        # 2. Real EV6 0x31C (D1=0x79 -> 19.5°C) + F-mode climate entity (67.1°F)
        self.hass.config.units.temperature_unit = ha_const.UnitOfTemperature.FAHRENHEIT
        climate_ent = CanDoClimateEntity(
            self.coordinator, resolve_variant(self.commands_by_id["climate_driver_temp"], "kia_ev6"), self.hass
        )
        self.coordinator.can_states["0x31c"] = [0x79, 0x7A, 0xFF, 0x00, 0x00, 0x5C, 0x09, 0x00]
        sensor._handle_can_update()
        self.assertEqual(sensor.native_value, 19.5)
        self.assertEqual(sensor.extra_state_attributes.get("threshold"), "Comfortable (15-25°C / 59-77°F)")
        self.assertEqual(climate_ent.current_temperature, 67.1)

        # Invalid sentinel 0x00 / 0xFF on 0x31C preserves last valid value on cached sensor, None on fresh sensor
        self.coordinator.can_states["0x31c"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(sensor.native_value, 19.5)
        fresh_sensor = CanDoSensorEntity(self.coordinator, out_cmd)
        self.assertIsNone(fresh_sensor.native_value)
        self.coordinator.can_states["0x31c"] = [0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertIsNone(fresh_sensor.native_value)

        # 3. 0x227 US °F fallback when 0x31C absent (67°F = 19.44°C), IGN-OFF 0xFF rejected
        self.coordinator.can_states.pop("0x31c", None)
        self.coordinator.can_states["0x227"] = [0x02, 0x4A, 0xE0, 0x0C, 0x00, 0xF1, 0x5F, 0x03]
        self.assertEqual(fresh_sensor.native_value, 19.4)
        self.assertEqual(climate_ent.current_temperature, 67.0)

        self.coordinator.can_states["0x227"] = [0x02, 0xA9, 0x79, 0x0D, 0x00, 0xF0, 0xFF, 0x07]
        self.assertIsNone(fresh_sensor.native_value)

        # 4. 0x226 Metric fallback when 0x31C and 0x227 are absent/invalid (0x3C -> 20.0°C)
        self.coordinator.can_states.pop("0x227", None)
        self.coordinator.can_states["0x226"] = [0x00, 0x00, 0x00, 0x3C, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(fresh_sensor.native_value, 20.0)

        # 5. 0x31C takes precedence over both 0x227 and 0x226
        self.coordinator.can_states["0x227"] = [0x02, 0x4A, 0xE0, 0x0C, 0x00, 0xF1, 0x5F, 0x03]
        self.coordinator.can_states["0x31c"] = [0x8A, 0x84, 0xFF, 0x01, 0x02, 0x60, 0x32, 0x00]
        self.assertEqual(fresh_sensor.native_value, 28.0)

        # 6. 0x31C is in firmware s_default_monitored_ids
        mqtt_mgr_path = Path(__file__).resolve().parent.parent / "firmware" / "main" / "net" / "mqtt_mgr.cpp"
        mqtt_mgr_src = mqtt_mgr_path.read_text(encoding="utf-8")
        self.assertIn("0x31C", mqtt_mgr_src)

    def test_sensor_ha_metadata_and_discrete_options(self):
        """Verify sensor.py honors ha_metadata, supports min/bar, and omits numeric metadata on discrete text options."""
        # 1. vehicle_odometer: honors ha_metadata (distance / total_increasing / mi) and converts 0x227 km -> mi
        odo_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["vehicle_odometer"])
        self.assertEqual(odo_sensor._attr_device_class, SensorDeviceClass.DISTANCE)
        self.assertEqual(odo_sensor._attr_state_class, SensorStateClass.TOTAL_INCREASING)
        self.assertEqual(odo_sensor._attr_native_unit_of_measurement, ha_const.UnitOfLength.MILES)
        # Raw 871417 (0x0D4BF9) = 87141.7 km = 54147.3 mi
        self.coordinator.can_states["0x227"] = [0x9F, 0xF9, 0x4B, 0x0D, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(odo_sensor.native_value, 54147.3)

        # 2. v2l_discharge_remaining_time & remaining_charge_time_ac: DURATION + min (NOT BATTERY / %)
        v2l_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["v2l_discharge_remaining_time"])
        self.assertEqual(v2l_sensor._attr_device_class, SensorDeviceClass.DURATION)
        self.assertEqual(v2l_sensor._attr_state_class, SensorStateClass.MEASUREMENT)
        self.assertEqual(v2l_sensor._attr_native_unit_of_measurement, "min")

        ac_time_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["remaining_charge_time_ac"])
        self.assertEqual(ac_time_sensor._attr_device_class, SensorDeviceClass.DURATION)
        self.assertEqual(ac_time_sensor._attr_native_unit_of_measurement, "min")

        # 3. master_cylinder_brake_pressure: network.unit == "bar" -> PRESSURE + bar
        brake_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["master_cylinder_brake_pressure"])
        self.assertEqual(brake_sensor._attr_device_class, "pressure")
        self.assertEqual(brake_sensor._attr_state_class, SensorStateClass.MEASUREMENT)
        self.assertEqual(brake_sensor._attr_native_unit_of_measurement, "bar")

        # 4. hv_battery_temperatures: discrete text options -> NO numeric device_class/state_class/unit
        hv_temp_sensor = CanDoSensorEntity(self.coordinator, self.commands_by_id["hv_battery_temperatures"])
        self.assertFalse(hasattr(hv_temp_sensor, "_attr_device_class"))
        self.assertFalse(hasattr(hv_temp_sensor, "_attr_state_class"))
        self.assertFalse(hasattr(hv_temp_sensor, "_attr_native_unit_of_measurement"))
        self.coordinator.can_states["hv_battery_temperatures"] = "Cold Battery (Min Temp < 15C / 59F)"
        self.assertEqual(hv_temp_sensor.native_value, "Cold Battery (Min Temp < 15C / 59F)")

        # 5. battery_preconditioning_state & climate_fan_speed_level: discrete text options -> no numeric state_class/unit
        for discrete_id in ("battery_preconditioning_state", "climate_fan_speed_level", "camera_speed_limit_sign"):
            ent = CanDoSensorEntity(self.coordinator, self.commands_by_id[discrete_id])
            self.assertFalse(hasattr(ent, "_attr_state_class"), f"{discrete_id} must not set state_class")
            self.assertFalse(hasattr(ent, "_attr_native_unit_of_measurement"), f"{discrete_id} must not set unit")

    def test_network_state_mask_fallback_entities(self):
        """Verify HA sensor and binary_sensor entities honor network.state_mask fallback when option.mask is absent."""
        # PDW front (D2 & 0x07) and rear (D2 & 0x38) sharing byte D2 with upper noise bits
        front_pdw = CanDoSensorEntity(self.coordinator, self.commands_by_id["pdw_sensor_front_center"])
        rear_pdw = CanDoSensorEntity(self.coordinator, self.commands_by_id["pdw_sensor_rear_center"])
        self.coordinator.can_states["0x436"] = [0x00, 0xDA, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]  # 0xC0 noise | 0x18 rear Z3 | 0x02 front Z2
        self.assertEqual(front_pdw.native_value, "Zone 2 (Mid ~60cm)")
        self.assertEqual(rear_pdw.native_value, "Zone 3 (Close ~30cm / Critical)")

        # PTGM tailgate status (0x3A6 D1 & 0x0F) with high nibble noise
        ptgm = CanDoSensorEntity(self.coordinator, self.commands_by_id["ptgm_tailgate_status"])
        self.coordinator.can_states["0x3a6"] = [0xF3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(ptgm.native_value, "Opening in Motion")

        # Blind spot warnings left/right (0x1BA D4/D5 & 0x03) with upper bits set
        bsw_l = CanDoSensorEntity(self.coordinator, self.commands_by_id["blind_spot_warning_left"])
        bsw_r = CanDoSensorEntity(self.coordinator, self.commands_by_id["blind_spot_warning_right"])
        self.coordinator.can_states["0x1ba"] = [0x00, 0x00, 0x00, 0xFC, 0xFD, 0x00, 0x00, 0x00]
        self.assertEqual(bsw_l.native_value, "Clear")
        self.assertEqual(bsw_r.native_value, "Vehicle Detected (Mirror LED Solid)")

        # Smart key proximity welcome binary_sensor (0x553 D8 & 0x01) with upper bits set
        smk = CanDoBinarySensorEntity(self.coordinator, self.commands_by_id["smart_key_proximity_welcome"])
        self.coordinator.can_states["0x553"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFE]
        self.assertFalse(smk.is_on)
        self.coordinator.can_states["0x553"] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF]
        self.assertTrue(smk.is_on)


if __name__ == "__main__":
    unittest.main()
