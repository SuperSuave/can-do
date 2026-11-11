import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Tabs, Chip, Card, Tooltip, ProgressBar } from '@heroui/react';
import { Catalog, Command, Vehicle } from '../types/catalog';
import { isRunningOnDevice, resolveDeviceBaseUrl } from '../utils/hostUtils';
import { resolveVariant } from '../utils/catalogUtils';
import {
  decodeChargePortCanFrame,
  decodeChargingCanFrame,
  decodeRearSeatEntityUpdate,
  decodeSeatComfortByte,
  decodeSeatLevel,
  decodeSunroofEntityState,
  displayTempToFahrenheit,
  fahrenheitToDisplayTemp,
  formatOdometerFromKm,
  parseBooleanEntityState,
  parseChargingEntityState,
  parseDualCabinTempToF,
  parseOdometerStateToKm,
  parseSingleCabinTempToF,
} from '../utils/cockpitDecoders';
import { deviceWs } from '../services/deviceWs';
import {
  Car,
  BatteryCharging,
  Battery,
  Thermometer,
  Fan,
  Wind,
  Flame,
  Snowflake,
  Lock,
  Unlock,
  Gauge,
  Zap,
  Shield,
  ShieldCheck,
  AlertTriangle,
  RotateCw,
  Eye,
  Sliders,
  Play,
  Pause,
  Sun,
  Moon,
  Compass,
  ArrowUpRight,
  CheckCircle2,
  Info,
  Maximize2,
  Activity,
  Link2
} from 'lucide-react';
import {
  EgmpModel,
  SunroofConfig,
  EGMP_MODELS,
  VehicleSilhouette
} from './VehicleOutlines';
import {
  AirflowDirectionIcon,
  AIRFLOW_MODE_LABELS,
  FrontDefrostIcon,
  RearDefrostIcon,
  HeatedWheelIcon
} from './AirflowIcons';

export interface VehicleDashboardProps {
  catalog: Catalog;
  activeVehicle?: Vehicle;
  unitSystem?: 'imperial' | 'metric';
  onSelectVehicle?: (vehicleId: string) => void;
  onNavigateToCatalog?: (searchQuery?: string) => void;
  onNavigateToAutomations?: () => void;
}

// Seat comfort level
export type SeatLevel = 'off' | 'heat_low' | 'heat_med' | 'heat_high' | 'cool_low' | 'cool_med' | 'cool_high';
export type SteeringHeatLevel = 'off' | 'on' | 'low' | 'high';
export type GearMode = 'P' | 'R' | 'N' | 'D';
export type LightMode = 'off' | 'parking' | 'low' | 'high' | 'auto';
export type AirflowMode = 'auto' | 'face' | 'face_feet' | 'feet' | 'defrost';
export type ViewPerspective = 'exterior' | 'interior' | 'powertrain';

function detectEgmpModel(vehicle?: Vehicle): EgmpModel {
  if (!vehicle) return 'ev6';
  const str = `${vehicle.id || ''} ${vehicle.name || ''} ${vehicle.model || ''} ${vehicle.make || ''}`.toLowerCase();
  if (str.includes('ev6')) return 'ev6';
  if (str.includes('ioniq 6') || str.includes('hi6')) return 'ioniq6';
  if (str.includes('gv60')) return 'gv60';
  return 'ioniq5';
}

function detectHasSunroof(vehicle?: Vehicle): boolean {
  if (!vehicle) return true;
  if (Array.isArray(vehicle.features)) {
    return vehicle.features.includes('sunroof');
  }
  return true;
}

function getSeatHeatLevel(state: SeatLevel | null): number {
  if (!state || !state.startsWith('heat_')) return 0;
  if (state === 'heat_low') return 1;
  if (state === 'heat_med') return 2;
  if (state === 'heat_high') return 3;
  return 0;
}

function getSeatCoolLevel(state: SeatLevel | null): number {
  if (!state || !state.startsWith('cool_')) return 0;
  if (state === 'cool_low') return 1;
  if (state === 'cool_med') return 2;
  if (state === 'cool_high') return 3;
  return 0;
}

export const VehicleDashboard: React.FC<VehicleDashboardProps> = ({
  catalog,
  activeVehicle,
  unitSystem = 'imperial',
  onSelectVehicle,
  onNavigateToCatalog,
  onNavigateToAutomations
}) => {
  // 0. Model Architecture and Sunroof State
  const [selectedModel, setSelectedModel] = useState<EgmpModel>(() => detectEgmpModel(activeVehicle));
  const [sunroof, setSunroof] = useState<SunroofConfig>(() => ({
    equipped: detectHasSunroof(activeVehicle),
    state: 'closed',
    sunshade: 'open'
  }));

  // Sync state when activeVehicle changes externally
  useEffect(() => {
    if (activeVehicle) {
      setSelectedModel(detectEgmpModel(activeVehicle));
      setSunroof(prev => ({
        ...prev,
        equipped: detectHasSunroof(activeVehicle)
      }));
    }
  }, [activeVehicle]);

  // 1. Vehicle Telemetry State
  const [gear, setGear] = useState<GearMode>('P');
  const [speedMph, setSpeedMph] = useState<number>(0);
  const [odometer, setOdometer] = useState<number | null>(null);
  const [ambientTempC, setAmbientTempC] = useState<number | null>(null);
  const [tempUnit, setTempUnit] = useState<'F' | 'C'>(() => (unitSystem === 'metric' ? 'C' : 'F'));
  const odometerKmRef = useRef<number | null>(null);
  const driverTempFRef = useRef<number | null>(null);
  const passengerTempFRef = useRef<number | null>(null);

  const prevUnitRef = useRef(unitSystem);
  useEffect(() => {
    if (unitSystem) {
      const nextUnit: 'F' | 'C' = unitSystem === 'metric' ? 'C' : 'F';
      setTempUnit(nextUnit);
      if (prevUnitRef.current && prevUnitRef.current !== unitSystem) {
        if (odometerKmRef.current !== null) {
          setOdometer(formatOdometerFromKm(odometerKmRef.current, unitSystem));
        } else {
          setOdometer(prev => {
            if (prev === null) return null;
            const km = unitSystem === 'metric' ? prev / 0.621371192 : prev;
            return formatOdometerFromKm(km, unitSystem);
          });
        }
        if (driverTempFRef.current !== null) {
          setDriverTemp(fahrenheitToDisplayTemp(driverTempFRef.current, nextUnit));
        } else {
          setDriverTemp(prev => {
            if (prev === null) return null;
            const f = displayTempToFahrenheit(prev, nextUnit === 'C' ? 'F' : 'C');
            return fahrenheitToDisplayTemp(f, nextUnit);
          });
        }
        if (passengerTempFRef.current !== null) {
          setPassengerTemp(fahrenheitToDisplayTemp(passengerTempFRef.current, nextUnit));
        } else {
          setPassengerTemp(prev => {
            if (prev === null) return null;
            const f = displayTempToFahrenheit(prev, nextUnit === 'C' ? 'F' : 'C');
            return fahrenheitToDisplayTemp(f, nextUnit);
          });
        }
      }
      prevUnitRef.current = unitSystem;
    }
  }, [unitSystem]);

  // Closures
  const [doors, setDoors] = useState({
    frontLeft: false,
    frontRight: false,
    rearLeft: false,
    rearRight: false,
  });
  const [hoodOpen, setHoodOpen] = useState(false);
  const [trunkOpen, setTrunkOpen] = useState(false);
  const [chargePortOpen, setChargePortOpen] = useState(false);
  const [locked, setLocked] = useState(true);
  const [mirrorsFolded, setMirrorsFolded] = useState(false);

  // Exterior Lighting
  const [lights, setLights] = useState<LightMode>('auto');
  const [hazards, setHazards] = useState(false);
  const [turnSignal, setTurnSignal] = useState<'off' | 'left' | 'right'>('off');

  // High Voltage Battery & 12V Auxiliary
  const [soc, setSoc] = useState<number | null>(() => {
    const saved = localStorage.getItem('cando_last_soc');
    return saved ? parseFloat(saved) : null;
  });
  const [isCharging, setIsCharging] = useState(false);
  const [chargeRateKw, setChargeRateKw] = useState<number>(0);
  const [acChargeLimit, setAcChargeLimit] = useState<number | null>(null);
  const [dcChargeLimit, setDcChargeLimit] = useState<number | null>(null);
  const [batteryMinTempC, setBatteryMinTempC] = useState<number | null>(null);
  const [batteryMaxTempC, setBatteryMaxTempC] = useState<number | null>(null);
  const [aux12V, setAux12V] = useState<number | null>(() => {
    const saved = localStorage.getItem('cando_last_aux12v');
    return saved ? parseFloat(saved) : null;
  });

  // Deep BMS Telemetry (Safe UDS Engine)
  const [hvPowerKw, setHvPowerKw] = useState<number | null>(null);
  const [hvVoltage, setHvVoltage] = useState<number | null>(null);
  const [hvCurrent, setHvCurrent] = useState<number | null>(null);
  const [cellDeltaMv, setCellDeltaMv] = useState<number | null>(null);

  // Climate & Comfort
  const [hvacPower, setHvacPower] = useState<boolean | null>(null);
  const [hvacAuto, setHvacAuto] = useState<boolean | null>(null);
  const [heatActive, setHeatActive] = useState<boolean | null>(null);
  const [acActive, setAcActive] = useState<boolean | null>(null);
  const [driverTemp, setDriverTemp] = useState<number | null>(null); // in F or C depending on tempUnit
  const [passengerTemp, setPassengerTemp] = useState<number | null>(null);
  const [fanSpeed, setFanSpeed] = useState<number | null>(null); // 1-8
  const [airflow, setAirflow] = useState<AirflowMode | null>(null);
  const [recirc, setRecirc] = useState<boolean | null>(null);
  const [rearDefrost, setRearDefrost] = useState<boolean | null>(null);
  const [frontDefrost, setFrontDefrost] = useState<boolean | null>(null);
  const [driverSeat, setDriverSeat] = useState<SeatLevel | null>(null);
  const [passengerSeat, setPassengerSeat] = useState<SeatLevel | null>(null);
  const [rearLeftSeat, setRearLeftSeat] = useState<SeatLevel | null>(null);
  const [rearRightSeat, setRearRightSeat] = useState<SeatLevel | null>(null);
  const [steeringWheelHeat, setSteeringWheelHeat] = useState<SteeringHeatLevel | null>(null);
  const [climateSync, setClimateSync] = useState<boolean | null>(null);
  const turnSignalTimeoutRef = useRef<any>(null);

  // TPMS (PSI)
  const [tpms, setTpms] = useState<{
    fl: number | null;
    fr: number | null;
    rl: number | null;
    rr: number | null;
  }>({
    fl: null,
    fr: null,
    rl: null,
    rr: null
  });

  // UI / Perspective State
  const [perspective, setPerspective] = useState<ViewPerspective>('exterior');
  const [hasReceivedFrames, setHasReceivedFrames] = useState<boolean>(false);
  const [speedKph, setSpeedKph] = useState<number>(0);
  const [connectedDevice, setConnectedDevice] = useState<boolean>(false);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  // Calculated ambient temp display
  const displayAmbient = useMemo(() => {
    if (ambientTempC === null) return '--';
    if (tempUnit === 'F') {
      return `${Math.round(ambientTempC * 1.8 + 32)}°F`;
    }
    return `${ambientTempC.toFixed(1)}°C`;
  }, [ambientTempC, tempUnit]);

  // Ambient threshold assessment
  const ambientThreshold = useMemo(() => {
    if (ambientTempC === null) return null;
    if (ambientTempC <= 0) return { label: 'Freezing', color: 'accent' as const };
    if (ambientTempC < 15) return { label: 'Cold', color: 'accent' as const };
    if (ambientTempC > 26) return { label: 'Warm', color: 'warning' as const };
    return { label: 'Comfortable', color: 'success' as const };
  }, [ambientTempC]);

  // Estimated driving range dynamically calculated based on active vehicle's battery pack & SOC
  const estimatedRangeMiles = useMemo(() => {
    if (soc === null) return null;
    const baseRangeMiles = activeVehicle?.epa_range_mi || (activeVehicle?.model?.includes('6') ? 342 : activeVehicle?.model?.includes('EV9') ? 304 : 303);
    const baseRangeKm = activeVehicle?.wltp_range_km || Math.round(baseRangeMiles * 1.60934);
    if (unitSystem === 'metric') {
      return Math.round((soc / 100) * baseRangeKm);
    }
    return Math.round((soc / 100) * baseRangeMiles);
  }, [soc, unitSystem, activeVehicle]);

  // Dynamically resolve equipped vehicle features from active onboard vehicle
  const equippedFeatures = useMemo(() => {
    if (activeVehicle && Array.isArray(activeVehicle.features)) {
      return new Set(activeVehicle.features);
    }
    return new Set(['heated_seats', 'ventilated_seats', 'heated_wheel', 'power_tailgate', 'camera_360', 'sunroof', 'preconditioning']);
  }, [activeVehicle]);

  // Dynamically resolve CAN message IDs, payload schemas, and entity names from active catalog definitions
  const canMappings = useMemo(() => {
    const list = (catalog?.commands || (catalog as any)?.features || []) as Command[];
    const findCmd = (id: string) => list.find(c => c.id === id);

    const getCanId = (id: string, fallbackHex: string): string => {
      const item = findCmd(id);
      const raw = item?.network?.state_can_id || item?.network?.action_can_id || item?.network?.trigger_frame_can_id;
      if (raw) {
        return raw.toLowerCase().replace(/^0x/, '');
      }
      return fallbackHex.toLowerCase().replace(/^0x/, '');
    };

    const gearCmd = findCmd('vehicle_gear_state') || findCmd('gear_shifter_dial') || findCmd('selected_gear');
    let gearOptions = gearCmd?.options || [];
    if (!gearOptions.length && (gearCmd as any)?.variants) {
      for (const v of (gearCmd as any).variants) {
        if (v.options) {
          gearOptions = gearOptions.concat(v.options);
        }
      }
    }

    const chargingRaw = findCmd('cond_charging');
    const chargingCmd = chargingRaw ? resolveVariant(chargingRaw, activeVehicle) : undefined;
    const chargingCanId = (
      chargingCmd?.network?.state_can_id ||
      chargingCmd?.network?.action_can_id ||
      chargingCmd?.network?.trigger_frame_can_id ||
      '326'
    ).toLowerCase().replace(/^0x/, '');
    const chargingOptions = chargingCmd?.options || [];

    const chargePortRaw = findCmd('charge_port');
    const chargePortCmd = chargePortRaw ? resolveVariant(chargePortRaw, activeVehicle) : undefined;
    const chargePortCanId = (
      chargePortCmd?.network?.state_can_id ||
      chargePortCmd?.network?.action_can_id ||
      '3aa'
    ).toLowerCase().replace(/^0x/, '');
    const chargePortOptions = chargePortCmd?.options || [];

    return {
      speed: getCanId('cluster_vehicle_speed', '1ac'),
      speedName: findCmd('cluster_vehicle_speed')?.ha_metadata?.name || 'Cluster Speedometer',
      wheelSpeeds: getCanId('wheel_speeds', '0a2'),
      ambientTemp: getCanId('cond_ambient_temperature', '226'),
      ambientTempName: findCmd('cond_ambient_temperature')?.ha_metadata?.name || 'Ambient Temperature',
      hvSoc: getCanId('cond_hv_battery_soc', '2fc'),
      hvSocName: findCmd('cond_hv_battery_soc')?.ha_metadata?.name || 'Traction Battery SOC',
      hvTemps: getCanId('hv_battery_temperatures', '152'),
      hvTempsName: findCmd('hv_battery_temperatures')?.ha_metadata?.name || 'HV Battery Module Temps',
      aux12v: getCanId('cond_aux_12v_battery', 'vbat'),
      aux12vName: findCmd('cond_aux_12v_battery')?.ha_metadata?.name || '12V Aux Battery Voltage',
      gear: getCanId('vehicle_gear_state', getCanId('gear_shifter_dial', '045')),
      gearName: gearCmd?.ha_metadata?.name || 'Gear Selector',
      gearOptions,
      doors: getCanId('doors_status', '411'),
      doorsName: findCmd('doors_status')?.ha_metadata?.name || 'Body Closures & Doors',
      locks: getCanId('door_locks', getCanId('doors_lock_state', '411')),
      locksName: findCmd('door_locks')?.ha_metadata?.name || findCmd('doors_lock_state')?.ha_metadata?.name || 'Door Locks & Security',
      trunk: getCanId('trunk', '414'),
      trunkName: findCmd('trunk')?.ha_metadata?.name || 'Power Liftgate / Trunk',
      tailgateStatus: getCanId('ptgm_tailgate_status', getCanId('telematics_remote_tailgate', '3a6')),
      hood: getCanId('hood', '411'),
      hoodName: findCmd('hood')?.ha_metadata?.name || 'Frunk / Hood Latch',
      chargePort: chargePortCanId,
      chargePortName: chargePortCmd?.ha_metadata?.name || 'Charge Port Door',
      chargePortOptions,
      charging: chargingCanId,
      chargingName: chargingCmd?.ha_metadata?.name || 'EV Charging Status',
      chargingOptions,
      acLimit: getCanId('ac_charging_limit', '1f9'),
      acLimitName: findCmd('ac_charging_limit')?.ha_metadata?.name || 'AC Charging Limit',
      dcLimit: getCanId('dc_charging_limit', '1f9'),
      dcLimitName: findCmd('dc_charging_limit')?.ha_metadata?.name || 'DC Fast Charging Limit',
      rearLeftSeat: getCanId('rear_left_seat_comfort', '438'),
      rearRightSeat: getCanId('rear_right_seat_comfort', '453'),
      rearSeats: getCanId('rear_left_seat_comfort', getCanId('rear_seats_comfort', '438')),
      rearSeatsName: findCmd('rear_left_seat_comfort')?.ha_metadata?.name || findCmd('rear_seats_comfort')?.ha_metadata?.name || 'Rear Seats Heat',
      odometer: getCanId('vehicle_odometer', '227'),
      odometerName: findCmd('vehicle_odometer')?.ha_metadata?.name || 'Odometer',
      climateTarget: getCanId('climate_driver_temp', getCanId('climate_dual_cabin_temp', '380')),
      climateTargetName: findCmd('climate_driver_temp')?.ha_metadata?.name || 'Cabin Target Temp',
      defrost: getCanId('climate_rear_defog', '541'),
      defrostName: findCmd('climate_rear_defog')?.ha_metadata?.name || 'Rear Defroster',
      hazards: getCanId('hazard_lights', '413'),
      hazardsName: findCmd('hazard_lights')?.ha_metadata?.name || 'Hazard Flashers',
      mirrors: getCanId('power_mirrors', '410'),
      mirrorsName: findCmd('power_mirrors')?.ha_metadata?.name || 'Exterior Power Mirrors',
      steeringHeat: getCanId('heated_steering_wheel_toggle', '418'),
      steeringHeatName: findCmd('heated_steering_wheel_toggle')?.ha_metadata?.name || 'Steering Wheel Heat',
      driverSeat: getCanId('drivers_seat_comfort', '496'),
      driverSeatName: findCmd('drivers_seat_comfort')?.ha_metadata?.name || 'Driver Seat Comfort',
      passengerSeat: getCanId('passengers_seat_comfort', '475'),
      passengerSeatName: findCmd('passengers_seat_comfort')?.ha_metadata?.name || 'Passenger Seat Comfort',
      fanBlower: getCanId('climate_fan_speed_level', '31b'),
      fanBlowerName: findCmd('climate_fan_speed_level')?.ha_metadata?.name || 'HVAC Blower / Vents',
      tpms: getCanId('tpms_warning_lamp', getCanId('wheel_speeds', '3a2')),
      tpmsName: findCmd('tpms_warning_lamp')?.ha_metadata?.name || findCmd('wheel_speeds')?.ha_metadata?.name || 'TPMS Tire Pressures',
      sunroof: getCanId('sunroof_extended', '442'),
      sunroofName: findCmd('sunroof_extended')?.ha_metadata?.name || 'Sunroof Glass & Cover',
    };
  }, [catalog, activeVehicle]);

  // Temporary feedback toast
  const triggerNotice = (msg: string) => {
    setFeedbackNotice(msg);
    setTimeout(() => {
      setFeedbackNotice(null);
    }, 2800);
  };

  // Bench preview helper for telemetry-only cockpit items that have no CAN TX actuator
  const runPreviewOrReadOnly = (label: string, previewFn: () => void) => {
    if (connectedDevice) {
      triggerNotice(`${label}: Read-only CAN telemetry (no TX actuator)`);
      return;
    }
    previewFn();
  };

  // Sunroof toggles
  const toggleSunroofEquipped = () => {
    setSunroof(prev => {
      const nextEquipped = !prev.equipped;
      const roofName = EGMP_MODELS[selectedModel].roofType;
      triggerNotice(nextEquipped ? `${roofName}: Glass Roof Equipped` : 'Roof: Solid Steel Stamping');
      return {
        ...prev,
        equipped: nextEquipped
      };
    });
  };

  const cycleSunroofState = () => {
    runPreviewOrReadOnly('Sunroof Position', () => {
      setSunroof(prev => {
        if (!prev.equipped) {
          triggerNotice(`${EGMP_MODELS[selectedModel].roofType}: Glass Roof Equipped`);
          return { ...prev, equipped: true };
        }
        if (selectedModel === 'ev6' || selectedModel === 'ioniq6') {
          const nextState: 'closed' | 'vent' | 'open' =
            prev.state === 'closed' ? 'vent' : prev.state === 'vent' ? 'open' : 'closed';
          triggerNotice(`Sunroof: ${nextState === 'vent' ? 'Tilt Vent Position' : nextState === 'open' ? 'Slide Open' : 'Closed'}`);
          return { ...prev, state: nextState };
        } else {
          const nextShade = prev.sunshade === 'open' ? 'closed' : 'open';
          triggerNotice(`Vision Roof Power Blind: ${nextShade === 'open' ? 'Retracted (Glass Exposed)' : 'Closed'}`);
          return { ...prev, sunshade: nextShade };
        }
      });
    });
  };

  const toggleSunshade = () => {
    runPreviewOrReadOnly('Power Sunshade', () => {
      setSunroof(prev => {
        const nextShade = prev.sunshade === 'open' ? 'closed' : 'open';
        triggerNotice(`Power Sunshade: ${nextShade === 'open' ? 'Retracted' : 'Closed'} (Preview)`);
        return { ...prev, sunshade: nextShade };
      });
    });
  };

  const cycleAcLimit = () => {
    const limits = [50, 60, 70, 80, 90, 100];
    const curr = acChargeLimit || 80;
    const next = limits[(limits.indexOf(curr) + 1) % limits.length];
    setAcChargeLimit(next);
    dispatchCommand('ac_charging_limit', `${next}%`, `AC Limit: ${next}%`);
  };

  const cycleDcLimit = () => {
    const limits = [50, 60, 70, 80, 90, 100];
    const curr = dcChargeLimit || 80;
    const next = limits[(limits.indexOf(curr) + 1) % limits.length];
    setDcChargeLimit(next);
    dispatchCommand('dc_charging_limit', `${next}%`, `DC Fast Charge Limit: ${next}%`);
  };

  const cycleRearSeat = (isLeft: boolean) => {
    const current = isLeft ? rearLeftSeat : rearRightSeat;
    const cycle: SeatLevel[] = ['off', 'heat_low', 'heat_high'];
    const currentEffective = current || 'off';
    const nextIdx = (cycle.indexOf(currentEffective) + 1) % cycle.length;
    const next = cycle[nextIdx];
    const optionCmd = next === 'heat_high' ? 'High Heat' : next === 'heat_low' ? 'Low Heat' : 'Off';
    if (isLeft) {
      setRearLeftSeat(next);
      dispatchCommand('rear_left_seat_comfort', optionCmd, `Rear Left Seat: ${optionCmd}`);
    } else {
      setRearRightSeat(next);
      dispatchCommand('rear_right_seat_comfort', optionCmd, `Rear Right Seat: ${optionCmd}`);
    }
  };

  // Hardware command dispatcher with per-entity debouncing (prevents slider/rapid-click HTTP flooding)
  const commandTimersRef = useRef<Record<string, any>>({});
  const dispatchCommand = (entity: string, cmd: string, fallbackDesc: string, debounceMs = 150) => {
    triggerNotice(fallbackDesc);
    if (commandTimersRef.current[entity]) {
      clearTimeout(commandTimersRef.current[entity]);
      delete commandTimersRef.current[entity];
    }
    const send = async () => {
      delete commandTimersRef.current[entity];
      try {
        const baseUrl = resolveDeviceBaseUrl(localStorage.getItem('cando_device_host'));
        await fetch(`${baseUrl}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity, command: cmd })
        });
      } catch {
        // Offline / standalone browser preview mode
      }
    };
    if (debounceMs > 0) {
      commandTimersRef.current[entity] = setTimeout(send, debounceMs);
    } else {
      send();
    }
  };

  const recordLog = (_id: string, _name: string, _decoded: string, _raw: string, _timestamp: string) => { };

  // Parser for high-level catalog entity states (broadcast via WebSocket or fetched via /api/states)
  const handleIncomingEntityState = (entity: string, stateStr: string) => {
    if (!hasReceivedFrames) {
      setHasReceivedFrames(true);
    }
    const normState = stateStr.toLowerCase();
    if (entity === 'doors_status') {
      if (normState.includes('all doors closed')) {
        setDoors({ frontLeft: false, frontRight: false, rearLeft: false, rearRight: false });
      } else if (normState.includes('all doors opened')) {
        setDoors({ frontLeft: true, frontRight: true, rearLeft: true, rearRight: true });
      } else {
        if (normState.includes('driver door opened')) setDoors(d => ({ ...d, frontLeft: true }));
        else if (normState.includes('driver door closed')) setDoors(d => ({ ...d, frontLeft: false }));
        if (normState.includes('passenger door opened')) setDoors(d => ({ ...d, frontRight: true }));
        else if (normState.includes('passenger door closed')) setDoors(d => ({ ...d, frontRight: false }));
        if (normState.includes('rear left door opened')) setDoors(d => ({ ...d, rearLeft: true }));
        else if (normState.includes('rear left door closed')) setDoors(d => ({ ...d, rearLeft: false }));
        if (normState.includes('rear right door opened')) setDoors(d => ({ ...d, rearRight: true }));
        else if (normState.includes('rear right door closed')) setDoors(d => ({ ...d, rearRight: false }));
      }
    } else if (entity === 'door_locks' || entity === 'doors_lock_state') {
      setLocked(normState.includes('lock') && !normState.includes('unlock'));
    } else if (entity === 'trunk' || entity === 'telematics_remote_tailgate' || entity === 'ptgm_tailgate_status') {
      setTrunkOpen(normState.includes('open') && !normState.includes('close'));
    } else if (entity === 'hood') {
      setHoodOpen(normState.includes('open') && !normState.includes('close'));
    } else if (entity === 'charge_port') {
      setChargePortOpen(normState.includes('open') && !normState.includes('close'));
    } else if (entity === 'vehicle_gear_state' || entity === 'gear_shifter_dial' || entity === 'selected_gear') {
      if (normState.includes('park') || normState === 'p' || normState.includes('(p)')) setGear('P');
      else if (normState.includes('reverse') || normState === 'r' || normState.includes('(r)')) setGear('R');
      else if (normState.includes('neutral') || normState === 'n' || normState.includes('(n)')) setGear('N');
      else if (normState.includes('drive') || normState === 'd' || normState.includes('(d)')) setGear('D');
    } else if (entity === 'cond_charging') {
      const charging = parseChargingEntityState(stateStr);
      setIsCharging(charging);
      if (!charging) setChargeRateKw(0);
    } else if (entity === 'ac_charging_limit') {
      const match = stateStr.match(/(\d+)/);
      if (match) setAcChargeLimit(parseInt(match[1], 10));
    } else if (entity === 'dc_charging_limit') {
      const match = stateStr.match(/(\d+)/);
      if (match) setDcChargeLimit(parseInt(match[1], 10));
    } else if (entity === 'drivers_seat_comfort') {
      setDriverSeat(decodeSeatLevel(stateStr));
    } else if (entity === 'passengers_seat_comfort') {
      setPassengerSeat(decodeSeatLevel(stateStr));
    } else if (entity === 'rear_seats_comfort' || entity === 'rear_left_seat_comfort' || entity === 'rear_right_seat_comfort') {
      const rearUpdate = decodeRearSeatEntityUpdate(entity, stateStr);
      if (rearUpdate.left !== undefined) setRearLeftSeat(rearUpdate.left);
      if (rearUpdate.right !== undefined) setRearRightSeat(rearUpdate.right);
    } else if (entity === 'climate_driver_temp') {
      const tempF = parseSingleCabinTempToF(stateStr);
      if (tempF !== null) {
        driverTempFRef.current = tempF;
        setDriverTemp(fahrenheitToDisplayTemp(tempF, tempUnit));
      }
    } else if (entity === 'climate_passenger_temp') {
      const tempF = parseSingleCabinTempToF(stateStr);
      if (tempF !== null) {
        passengerTempFRef.current = tempF;
        setPassengerTemp(fahrenheitToDisplayTemp(tempF, tempUnit));
      }
    } else if (entity === 'climate_dual_cabin_temp') {
      const { driverF, passengerF } = parseDualCabinTempToF(stateStr);
      if (driverF !== null) {
        driverTempFRef.current = driverF;
        setDriverTemp(fahrenheitToDisplayTemp(driverF, tempUnit));
      }
      if (passengerF !== null) {
        passengerTempFRef.current = passengerF;
        setPassengerTemp(fahrenheitToDisplayTemp(passengerF, tempUnit));
      }
    } else if (entity === 'heated_steering_wheel_toggle' || entity === 'heated_wheel_btn') {
      setSteeringWheelHeat(parseBooleanEntityState(stateStr) ? 'on' : 'off');
    } else if (entity === 'hazard_lights') {
      setHazards(parseBooleanEntityState(stateStr));
    } else if (entity === 'power_mirrors' || entity === 'mirrors') {
      setMirrorsFolded(normState.includes('fold') && !normState.includes('unfold') && !normState.includes('extend'));
    } else if (entity === 'turn_signal_left') {
      if (parseBooleanEntityState(stateStr)) setTurnSignal('left');
      else setTurnSignal(prev => prev === 'left' ? 'off' : prev);
    } else if (entity === 'turn_signal_right') {
      if (parseBooleanEntityState(stateStr)) setTurnSignal('right');
      else setTurnSignal(prev => prev === 'right' ? 'off' : prev);
    } else if (entity === 'headlight_mode' || entity === 'lights') {
      if (normState.includes('off')) setLights('off');
      else if (normState.includes('parking') || normState.includes('park')) setLights('parking');
      else if (normState.includes('high')) setLights('high');
      else if (normState.includes('low')) setLights('low');
      else if (normState.includes('auto')) setLights('auto');
    } else if (entity === 'turn_signal') {
      if (normState.includes('left')) setTurnSignal('left');
      else if (normState.includes('right')) setTurnSignal('right');
      else setTurnSignal('off');
    } else if (entity === 'climate_rear_defog') {
      setRearDefrost(parseBooleanEntityState(stateStr));
    } else if (entity === 'front_defrost') {
      setFrontDefrost(parseBooleanEntityState(stateStr));
    } else if (entity === 'climate_fan_speed_level' || entity === 'fan_speed') {
      const match = stateStr.match(/(\d+)/);
      if (match) setFanSpeed(parseInt(match[1], 10));
    } else if (entity === 'climate_airflow_direction' || entity === 'airflow_direction') {
      if (normState.includes('face_feet') || normState.includes('face / feet') || normState.includes('body & legs')) setAirflow('face_feet');
      else if (normState.includes('defrost') || normState.includes('defog')) setAirflow('defrost');
      else if (normState.includes('face') || normState.includes('body')) setAirflow('face');
      else if (normState.includes('feet') || normState.includes('legs')) setAirflow('feet');
      else if (normState.includes('auto')) setAirflow('auto');
    } else if (entity === 'climate_recirc_on') {
      setRecirc(parseBooleanEntityState(stateStr));
    } else if (entity === 'climate_sync_toggle') {
      setClimateSync(!normState.includes('off') && !normState.includes('split'));
    } else if (
      entity.includes('climate_start') ||
      entity === 'climate_power' ||
      entity === 'remote_climate_state' ||
      entity === 'remote_climate_tmu' ||
      entity === 'climate_fan_active'
    ) {
      setHvacPower(parseBooleanEntityState(stateStr));
    } else if (entity === 'cond_ambient_temperature' || entity === 'ambient_temperature') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) setAmbientTempC(parseFloat(match[1]));
    } else if (entity === 'wheel_speeds' || entity === 'tpms_tire_pressures' || entity === 'tpms') {
      const match = stateStr.match(/fl:\s*(\d+).*fr:\s*(\d+).*rl:\s*(\d+).*rr:\s*(\d+)/i);
      if (match) {
        setTpms({
          fl: parseInt(match[1], 10),
          fr: parseInt(match[2], 10),
          rl: parseInt(match[3], 10),
          rr: parseInt(match[4], 10),
        });
      }
    } else if (entity === 'cond_hv_battery_soc' || entity.includes('battery_soc')) {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) {
        const s = parseFloat(match[1]);
        if (s >= 0 && s <= 100) {
          setSoc(s);
          try { localStorage.setItem('cando_last_soc', String(s)); } catch { }
        }
      }
    } else if (entity === 'cond_aux_12v_battery' || entity.includes('12v') || entity === 'aux_12v') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) {
        const v = parseFloat(match[1]);
        if (v >= 8 && v <= 16.5) {
          setAux12V(v);
          try { localStorage.setItem('cando_last_aux12v', String(v)); } catch { }
        }
      }
    } else if (entity === 'hv_battery_temperatures') {
      const match = stateStr.match(/min:\s*(-?\d+(\.\d+)?).*max:\s*(-?\d+(\.\d+)?)/i);
      if (match) {
        setBatteryMinTempC(parseFloat(match[1]));
        setBatteryMaxTempC(parseFloat(match[3]));
      }
    } else if (entity === 'cluster_vehicle_speed' || entity === 'vehicle_speed') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) {
        const spd = parseFloat(match[1]);
        setSpeedKph(spd);
        setSpeedMph(Math.round(spd * 0.621371));
      }
    } else if (entity === 'vehicle_odometer') {
      const km = parseOdometerStateToKm(stateStr);
      if (km !== null) {
        odometerKmRef.current = km;
        setOdometer(formatOdometerFromKm(km, unitSystem));
      }
    } else if (entity === 'hv_power_kw' || entity === 'bms_hv_kw') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) setHvPowerKw(parseFloat(match[1]));
    } else if (entity === 'hv_battery_voltage' || entity === 'bms_hv_v') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) setHvVoltage(parseFloat(match[1]));
    } else if (entity === 'hv_battery_current' || entity === 'bms_hv_a') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) setHvCurrent(parseFloat(match[1]));
    } else if (entity === 'hv_cell_delta_mv' || entity === 'bms_cell_delta_mv') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) setCellDeltaMv(parseFloat(match[1]));
    } else if (entity === 'sunroof_extended' || entity === 'sunroof') {
      const roof = decodeSunroofEntityState(stateStr);
      if (roof.glassState !== undefined || roof.sunshade !== undefined) {
        setSunroof(prev => ({
          ...prev,
          equipped: true,
          ...(roof.glassState !== undefined ? { state: roof.glassState } : {}),
          ...(roof.sunshade !== undefined ? { sunshade: roof.sunshade } : {}),
        }));
      }
    }
  };

  const handleIncomingEntityStateRef = useRef(handleIncomingEntityState);
  handleIncomingEntityStateRef.current = handleIncomingEntityState;
  const handleIncomingCanFrameRef = useRef<(idStr: string, hexPayload: string) => void>(() => {});

  // 1. Initial State Synchronization & Fallback Polling via /api/states REST endpoint
  useEffect(() => {
    let cancelled = false;
    const fetchCurrentStates = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (deviceWs.getConnected()) return;
      try {
        const baseUrl = resolveDeviceBaseUrl(localStorage.getItem('cando_device_host'));
        const res = await fetch(`${baseUrl}/api/states`);
        if (res.ok && !cancelled) {
          const states: Array<{ entity: string; state: string }> = await res.json();
          if (Array.isArray(states)) {
            states.forEach(item => {
              if (item?.entity && item?.state) {
                handleIncomingEntityStateRef.current(item.entity, item.state);
              }
            });
          }
        }
      } catch {
        // Device offline or standalone browser preview
      }
    };
    fetchCurrentStates();
    // 3-second fallback synchronization to ensure connection renegotiation never leaves stale states
    const syncInterval = setInterval(fetchCurrentStates, 3000);
    return () => {
      cancelled = true;
      clearInterval(syncInterval);
    };
  }, []);

  // 2. Real-time WebSocket connection to physical CAN Do device via singleton
  useEffect(() => {
    const unsubscribeConn = deviceWs.onConnectionChange((conn) => {
      setConnectedDevice(conn);
      if (conn) {
        triggerNotice('Connected to live CAN Do vehicle telemetry stream');
      }
    });

    const unsubscribeMsgs = deviceWs.subscribe((data) => {
      if (data.type === 'state' && (data as any).entity && (data as any).state) {
        handleIncomingEntityStateRef.current((data as any).entity, (data as any).state);
      } else if (data.type === 'can_frame' && (data as any).id) {
        handleIncomingCanFrameRef.current((data as any).id, (data as any).data || '');
      }
    });

    return () => {
      unsubscribeConn();
      unsubscribeMsgs();
    };
  }, []);

  // Smooth simulation loop when in preview/bench mode and no live vehicle CAN traffic
  useEffect(() => {
    if (connectedDevice && hasReceivedFrames) return;
    if (gear !== 'D') return;

    const interval = setInterval(() => {
      setSpeedMph(prev => Math.min(75, Math.max(35, prev + Math.floor(Math.random() * 3 - 1))));
      setSpeedKph(prev => Math.min(120, Math.max(56, prev + Math.floor(Math.random() * 5 - 2))));
    }, 1200);

    return () => clearInterval(interval);
  }, [connectedDevice, hasReceivedFrames, gear]);

  // 3. Real-Time CAN Frame Decoder (Direct from vehicle TWAI bus, completely dynamic)
  const handleIncomingCanFrame = (idStr: string, hexPayload: string) => {
    const normId = idStr.toLowerCase().replace(/^0x/, '');
    const idFormatted = `0x${normId.toUpperCase()}`;
    const hexClean = hexPayload.trim().replace(/\s+/g, '');
    const bytes = (hexClean.match(/.{1,2}/g) || []).map(h => parseInt(h, 16));
    const now = new Date().toLocaleTimeString();

    // Road Speed (Cluster 0x1AC Byte 0 = kph, or Wheel Speeds 0x0A2 16-bit LE = factor 0.03125 kph, or 0x1A0)
    if ((normId === canMappings.speed || normId === '1ac') && bytes.length >= 1) {
      const kph = bytes[0];
      const mph = Math.round(kph * 0.621371);
      setSpeedKph(prev => (prev === kph ? prev : kph));
      setSpeedMph(prev => (prev === mph ? prev : mph));
      recordLog(idFormatted, canMappings.speedName, `${kph} km/h (${mph} mph)`, hexPayload, now);
    } else if ((normId === canMappings.wheelSpeeds || normId === '0a2' || normId === 'a2') && bytes.length >= 2) {
      const rawW1 = bytes[0] | (bytes[1] << 8);
      const kph = Math.round(rawW1 * 0.03125 * 10) / 10;
      const mph = Math.round(kph * 0.621371);
      setSpeedKph(prev => (prev === kph ? prev : kph));
      setSpeedMph(prev => (prev === mph ? prev : mph));
      recordLog(idFormatted, 'Wheel Speed Telemetry', `${kph} km/h (${mph} mph)`, hexPayload, now);
    } else if (normId === '1a0' && bytes.length >= 2) {
      const kph = Math.round(((bytes[0] | (bytes[1] << 8)) * 0.03125) * 10) / 10;
      const mph = Math.round(kph * 0.621371);
      setSpeedKph(prev => (prev === kph ? prev : kph));
      setSpeedMph(prev => (prev === mph ? prev : mph));
      recordLog(idFormatted, 'ESC Road Speed', `${kph} km/h (${mph} mph)`, hexPayload, now);
    }

    // Ambient Outdoor Temperature (Dynamically mapped from catalog, e.g. 0x226)
    else if ((normId === canMappings.ambientTemp || normId === '226') && bytes.length >= 4) {
      const raw = bytes[3];
      if (raw > 0 && raw < 255) {
        const c = raw - 40;
        setAmbientTempC(prev => (prev === c ? prev : c));
        recordLog(idFormatted, canMappings.ambientTempName, `${c}°C (${Math.round(c * 1.8 + 32)}°F)`, hexPayload, now);
      }
    }

    // HV Traction Battery SOC (Dynamically mapped from catalog, e.g. 0x2FC)
    else if ((normId === canMappings.hvSoc || normId === '2fc') && bytes.length >= 8) {
      const raw = bytes[7];
      const newSoc = Math.round(raw * 0.5 * 10) / 10;
      if (newSoc >= 0 && newSoc <= 100) {
        setSoc(prev => (prev === newSoc ? prev : newSoc));
        try { localStorage.setItem('cando_last_soc', String(newSoc)); } catch { }
        recordLog(idFormatted, canMappings.hvSocName, `${newSoc}%`, hexPayload, now);
      }
    }

    // 12V Aux Battery Voltage (Dynamically mapped from catalog e.g. 0x1CF Byte D6 [index 5] or 0x594 Byte D5 [index 4] = factor 0.1 V)
    else if ((normId === canMappings.aux12v || normId === '1cf' || normId === '594') && bytes.length >= 5) {
      const vByte = bytes.length >= 6 ? bytes[5] : bytes[4];
      const v = Math.round(vByte * 0.1 * 10) / 10;
      if (v >= 8.0 && v <= 16.5) {
        setAux12V(prev => (prev === v ? prev : v));
        try { localStorage.setItem('cando_last_aux12v', String(v)); } catch { }
        recordLog(idFormatted, canMappings.aux12vName, `${v} V`, hexPayload, now);
      }
    }

    // BMS Module Min/Max Temperatures (Dynamically mapped from catalog, e.g. 0x152)
    else if ((normId === canMappings.hvTemps || normId === '152') && bytes.length >= 2) {
      const minT = bytes[0];
      const maxT = bytes[1];
      setBatteryMinTempC(prev => (prev === minT ? prev : minT));
      setBatteryMaxTempC(prev => (prev === maxT ? prev : maxT));
      recordLog(idFormatted, canMappings.hvTempsName, `Min: ${minT}°C / Max: ${maxT}°C`, hexPayload, now);
    }

    // Transmission Gear Selection (0x045, 0x070, 0x130, 0x035, 0x2C0, 0x220)
    else if ((normId === canMappings.gear || normId === '045' || normId === '45' || normId === '070' || normId === '70' || normId === '130' || normId === '035' || normId === '35' || normId === '2c0' || normId === '220' || normId === '316' || normId === '321') && bytes.length >= 1) {
      let detectedGear: GearMode | null = null;
      if (normId === '130' && bytes.length >= 6) {
        // Rotary dial 0x130: D5 0x10=P, D6 0x50=D, D6 0x10=R (mask 0xF0)
        if ((bytes[4] & 0xF0) === 0x10) detectedGear = 'P';
        else if ((bytes[5] & 0xF0) === 0x50) detectedGear = 'D';
        else if ((bytes[5] & 0xF0) === 0x10) detectedGear = 'R';
      } else if ((normId === '45' || normId === '045') && bytes.length >= 6) {
        // EV6/GV60 0x045 D6 (bytes[5]): 0x00=P, 0x50=D, 0x60=N, 0x70=R (mask 0x70)
        const d6 = bytes[5] & 0x70;
        if (d6 === 0x00) detectedGear = 'P';
        else if (d6 === 0x50) detectedGear = 'D';
        else if (d6 === 0x60) detectedGear = 'N';
        else if (d6 === 0x70) detectedGear = 'R';
      } else if ((normId === '70' || normId === '070') && bytes.length >= 8) {
        // Ioniq 5/6 0x070 D8 (bytes[7]): 0x00=P, 0x50=D, 0x60=N, 0x70=R (mask 0x70)
        const d8 = bytes[7] & 0x70;
        if (d8 === 0x00) detectedGear = 'P';
        else if (d8 === 0x50) detectedGear = 'D';
        else if (d8 === 0x60) detectedGear = 'N';
        else if (d8 === 0x70) detectedGear = 'R';
      } else if (normId === '35' || normId === '035') {
        // CAN-FD 0x35
        for (const idx of [5, 6, 7, 2]) {
          if (bytes.length > idx) {
            const val = bytes[idx] & 0x70;
            if (val === 0x00) { detectedGear = 'P'; break; }
            if (val === 0x50) { detectedGear = 'D'; break; }
            if (val === 0x60) { detectedGear = 'N'; break; }
            if (val === 0x70) { detectedGear = 'R'; break; }
          }
        }
      }

      if (!detectedGear && canMappings.gearOptions && canMappings.gearOptions.length > 0) {
        for (const opt of canMappings.gearOptions) {
          const lbl = (opt.label || '').toLowerCase();
          let targetGear: GearMode | null = null;
          if (lbl.includes('(p)') || lbl.includes('park') || lbl === 'p') targetGear = 'P';
          else if (lbl.includes('(r)') || lbl.includes('reverse') || lbl === 'r') targetGear = 'R';
          else if (lbl.includes('(n)') || lbl.includes('neutral') || lbl === 'n') targetGear = 'N';
          else if (lbl.includes('(d)') || lbl.includes('drive') || lbl === 'd') targetGear = 'D';

          if (targetGear && opt.match && typeof opt.match === 'object') {
            const matched = Object.entries(opt.match).every(([byteKey, hexVal]) => {
              const m = byteKey.match(/\d+/);
              if (!m) return false;
              const idx = parseInt(m[0], 10) - (byteKey.toUpperCase().startsWith('D') ? 1 : 0);
              const exp = parseInt(hexVal as string, 16);
              return bytes[idx] === exp;
            });
            if (matched) {
              detectedGear = targetGear;
              break;
            }
          }
        }
      }

      if (!detectedGear) {
        for (const idx of [2, 1, 3, 0]) {
          if (bytes.length > idx) {
            const val = bytes[idx];
            if (val === 0x07 || val === 0x02) { detectedGear = 'R'; break; }
            if (val === 0x06 || val === 0x03) { detectedGear = 'N'; break; }
            if (val === 0x05 || val === 0x01 || val === 0x04) { detectedGear = 'D'; break; }
            if (val === 0x00 || val === 0x10 || val === 0x50) { detectedGear = 'P'; break; }
          }
        }
      }

      if (detectedGear) {
        setGear(detectedGear);
        if (detectedGear === 'P') {
          setSpeedMph(0);
          setSpeedKph(0);
        }
        recordLog(idFormatted, canMappings.gearName, `Position: ${detectedGear}`, hexPayload, now);
      }
    }

    // Body Closures & Locks (Dynamically mapped from catalog, e.g. 0x411)
    else if ((normId === canMappings.doors || normId === canMappings.locks || normId === canMappings.hood || normId === '411') && bytes.length >= 8) {
      const fl = Boolean(bytes[3] & 0x01); // Driver Door
      const fr = Boolean(bytes[4] & 0x04); // Passenger Door
      const hood = Boolean(bytes[5] & 0x10); // Hood / Frunk
      const rl = Boolean(bytes[6] & 0x10); // Rear Left Door
      const rr = Boolean(bytes[7] & 0x01); // Rear Right Door
      const isLocked = bytes.length >= 3 ? (bytes[2] === 0x00 || (bytes[2] & 0x40) === 0) : true;
      setDoors({ frontLeft: fl, frontRight: fr, rearLeft: rl, rearRight: rr });
      setHoodOpen(hood);
      setLocked(isLocked);
      recordLog(idFormatted, canMappings.doorsName, `Doors: ${fl || fr || rl || rr ? 'Open' : 'Closed'}, Locks: ${isLocked ? 'Locked' : 'Unlocked'}`, hexPayload, now);
    }

    // Tailgate / Trunk Status (0x414 BCM latch, 0x3A6 PTGM power tailgate)
    else if ((normId === canMappings.trunk || normId === '414') && bytes.length >= 4) {
      const tr = Boolean(bytes[3] & 0x01);
      setTrunkOpen(tr);
      recordLog(idFormatted, canMappings.trunkName, tr ? 'Open' : 'Closed', hexPayload, now);
    } else if ((normId === canMappings.tailgateStatus || normId === '3a6') && bytes.length >= 1) {
      const st = bytes[0] & 0x0F;
      if (st === 0x01 || st === 0x03) setTrunkOpen(true);
      else if (st === 0x02) setTrunkOpen(false);
    }

    // EV Charge Port Door (Catalog/MICOM 0x3AA Byte D4: 0x01=Open, 0x02=Closed)
    else if (normId === canMappings.chargePort || normId === '3aa') {
      const cp = decodeChargePortCanFrame(normId, bytes, canMappings.chargePortOptions, canMappings.chargePort);
      if (cp !== null) {
        setChargePortOpen(cp);
        recordLog(idFormatted, canMappings.chargePortName, cp ? 'Open' : 'Closed', hexPayload, now);
      }
    }

    // EV Charging Status & Grid Interconnect (Gen 3 0x326 Byte D5 bits 0:1, Legacy Gen 2 0x594 Byte D2 bit 1)
    else if (normId === canMappings.charging || normId === '326' || normId === '594') {
      const charging = decodeChargingCanFrame(normId, bytes, canMappings.chargingOptions, canMappings.charging);
      if (charging !== null) {
        setIsCharging(charging);
        if (!charging) setChargeRateKw(0);
        recordLog(idFormatted, canMappings.chargingName, charging ? 'ACTIVE / PLUGGED IN' : 'INACTIVE', hexPayload, now);
      }
    }

    // Odometer (Dynamically mapped from catalog, e.g. 0x227: D2-D4 24-bit LE in 0.1 km units)
    else if ((normId === canMappings.odometer || normId === '227') && bytes.length >= 4) {
      const rawOdo = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16);
      if (rawOdo > 0) {
        const km = rawOdo * 0.1;
        odometerKmRef.current = km;
        const displayOdo = formatOdometerFromKm(km, unitSystem);
        setOdometer(displayOdo);
        recordLog(idFormatted, canMappings.odometerName, `${displayOdo.toLocaleString()} ${unitSystem === 'metric' ? 'km' : 'mi'}`, hexPayload, now);
      }
    }

    // Cabin Target Temperatures (0x380: Driver on D2 or D5/D4, Passenger on D3 or D6/D7, values 0x06 to 0x1A)
    else if ((normId === canMappings.climateTarget || normId === '380') && bytes.length >= 2) {
      let rawD: number | null = null;
      for (const idx of [1, 4, 3]) {
        if (bytes.length > idx && bytes[idx] >= 0x06 && bytes[idx] <= 0x1A) {
          rawD = bytes[idx];
          break;
        }
      }
      if (rawD !== null) {
        const dF = 62 + (rawD - 0x06);
        driverTempFRef.current = dF;
        setDriverTemp(fahrenheitToDisplayTemp(dF, tempUnit));
      }

      let rawP: number | null = null;
      for (const idx of [2, 5, 6]) {
        if (bytes.length > idx && bytes[idx] >= 0x06 && bytes[idx] <= 0x1A) {
          rawP = bytes[idx];
          break;
        }
      }
      if (rawP !== null) {
        const pF = 62 + (rawP - 0x06);
        passengerTempFRef.current = pF;
        setPassengerTemp(fahrenheitToDisplayTemp(pF, tempUnit));
      }
      recordLog(idFormatted, canMappings.climateTargetName, `Driver: ${rawD !== null ? `${rawD} (0x${rawD.toString(16)})` : '--'} / Pass: ${rawP !== null ? `${rawP} (0x${rawP.toString(16)})` : '--'}`, hexPayload, now);
    }

    // Rear Defroster (Dynamically mapped from catalog, e.g. 0x541 with D5 match 0x10 mask 0xF0)
    else if (normId === canMappings.defrost && bytes.length >= 5) {
      const def = (bytes[4] & 0xF0) === 0x10;
      setRearDefrost(def);
      recordLog(idFormatted, canMappings.defrostName, def ? 'DEFROST ON' : 'DEFROST OFF', hexPayload, now);
    }

    // Heated Steering Wheel (Dynamically mapped from catalog, e.g. 0x418)
    else if (normId === canMappings.steeringHeat && bytes.length >= 1) {
      const val = bytes[0] & 0x03;
      const lvl: SteeringHeatLevel = val > 0 ? 'on' : 'off';
      setSteeringWheelHeat(lvl);
      recordLog(idFormatted, canMappings.steeringHeatName, lvl.toUpperCase(), hexPayload, now);
    }

    // Sunroof Glass & Cover (Dynamically mapped from catalog, e.g. 0x442)
    else if ((normId === canMappings.sunroof || normId === '442') && bytes.length >= 8) {
      const d7 = bytes[6];
      let sState: 'closed' | 'vent' | 'open' = 'closed';
      if (d7 === 0x60 || d7 === 0x20) sState = 'open';
      else if (d7 === 0x00) sState = 'vent';
      else if (d7 === 0x10) sState = 'closed';
      const d8 = bytes[7];
      setSunroof(prev => ({
        ...prev,
        equipped: true,
        state: sState,
        ...(d8 === 0x60 ? { sunshade: 'open' as const } : d8 === 0x30 ? { sunshade: 'closed' as const } : {}),
      }));
      recordLog(idFormatted, canMappings.sunroofName, `Sunroof State: ${sState.toUpperCase()}`, hexPayload, now);
    }

    // Exterior Power Mirrors & Approach Light (0x410: CGW_USM1 Byte D3 bits 0-1)
    else if ((normId === canMappings.mirrors || normId === '410') && bytes.length >= 3) {
      const wlight = bytes[2] & 0x03;
      if (wlight === 0x00) {
        setMirrorsFolded(true);
        recordLog(idFormatted, canMappings.mirrorsName, 'MIRRORS FOLDED', hexPayload, now);
      } else if (wlight === 0x02) {
        setMirrorsFolded(false);
        recordLog(idFormatted, canMappings.mirrorsName, 'MIRRORS UNFOLDED', hexPayload, now);
      }
    }

    // Lighting, Turn Signals & Hazards (0x413, 0x3C1)
    else if ((normId === '413' || normId === '3c1' || normId === canMappings.hazards || normId === 'turn_signal') && bytes.length >= 1) {
      if (normId === '413' || normId === canMappings.hazards) {
        let isHazNow = hazards;
        // Frame 0x413: D4 (bytes[3]) bit 2 = Hazards (0x04)
        if (bytes.length >= 4) {
          isHazNow = Boolean(bytes[3] & 0x04);
          setHazards(isHazNow);
          if (isHazNow) recordLog(idFormatted, 'Hazard Flashers', 'HAZARDS ACTIVE', hexPayload, now);
        }
        // Frame 0x413: D3 (bytes[2]) bit 4 = Left (0x10), bit 6 = Right (0x40)
        if (bytes.length >= 3) {
          const d3 = bytes[2];
          let dir: 'off' | 'left' | 'right' = 'off';
          if (d3 & 0x10) dir = 'left';
          else if (d3 & 0x40) dir = 'right';

          if (dir !== 'off') {
            setTurnSignal(dir);
            if (turnSignalTimeoutRef.current) clearTimeout(turnSignalTimeoutRef.current);
            turnSignalTimeoutRef.current = setTimeout(() => {
              setTurnSignal('off');
            }, 1200);
            recordLog(idFormatted, 'Turn Signal Telemetry (0x413)', `Active: ${dir.toUpperCase()}`, hexPayload, now);
          } else if (!isHazNow) {
            setTurnSignal('off');
            if (turnSignalTimeoutRef.current) clearTimeout(turnSignalTimeoutRef.current);
          }
        }
      } else if (normId === '3c1') {
        // Stalk 0x3C1: D5 (bytes[4]) 0x40 = left, 0x10 = right
        if (bytes.length >= 5) {
          const d5 = bytes[4];
          let dir: 'off' | 'left' | 'right' = 'off';
          if ((d5 & 0xF0) === 0x40) dir = 'left';
          else if ((d5 & 0xF0) === 0x10) dir = 'right';

          if (dir !== 'off') {
            setTurnSignal(dir);
            if (turnSignalTimeoutRef.current) clearTimeout(turnSignalTimeoutRef.current);
            turnSignalTimeoutRef.current = setTimeout(() => {
              setTurnSignal('off');
            }, 900);
            recordLog(idFormatted, 'Turn Signal Stalk (0x3C1)', `Active: ${dir.toUpperCase()}`, hexPayload, now);
          }
        }
      }
    }

    // Rear Seats Comfort (Frame 0x438 Left, 0x453 Right)
    else if ((normId === canMappings.rearLeftSeat || normId === canMappings.rearRightSeat || normId === '438' || normId === '453') && bytes.length >= 1) {
      const b = bytes[0];
      const lvl: SeatLevel = b === 0x41 ? 'heat_high' : b === 0x31 ? 'heat_low' : 'off';
      if (normId === canMappings.rearLeftSeat || normId === '438') {
        setRearLeftSeat(lvl);
        recordLog(idFormatted, 'Rear Left Seat Comfort', lvl, hexPayload, now);
      } else {
        setRearRightSeat(lvl);
        recordLog(idFormatted, 'Rear Right Seat Comfort', lvl, hexPayload, now);
      }
    }

    // Driver Seat Comfort (Dynamically mapped from catalog, e.g. 0x496 Byte D1)
    else if ((normId === canMappings.driverSeat || normId === '496') && bytes.length >= 1) {
      const lvl = decodeSeatComfortByte(bytes[0]);
      setDriverSeat(lvl);
      recordLog(idFormatted, canMappings.driverSeatName, lvl, hexPayload, now);
    }

    // Passenger Seat Comfort (0x475 empirical EV6 / 0x49C catalog Gen3 Byte D1)
    else if ((normId === canMappings.passengerSeat || normId === '475' || normId === '49c') && bytes.length >= 1) {
      const lvl = decodeSeatComfortByte(bytes[0]);
      setPassengerSeat(lvl);
      recordLog(idFormatted, canMappings.passengerSeatName, lvl, hexPayload, now);
    }

    // HVAC Blower Fan Speed & Airflow (Dynamically mapped from catalog, e.g. 0x31B)
    else if ((normId === canMappings.fanBlower || normId === '31b') && bytes.length >= 4) {
      const fanRaw = bytes[3] & 0x0F;
      const speed = fanRaw >= 2 && fanRaw <= 9 ? fanRaw - 1 : 0;
      setFanSpeed(speed);
      const afRaw = bytes[3] & 0xF0;
      const afMap: Record<number, AirflowMode> = {
        0x00: 'auto',
        0x10: 'face',
        0x20: 'face_feet',
        0x30: 'feet',
        0x40: 'defrost',
      };
      if (afRaw in afMap) setAirflow(afMap[afRaw]);
      if (bytes.length >= 5) {
        setRecirc(Boolean(bytes[4] & 0x40));
      }
      recordLog(idFormatted, canMappings.fanBlowerName, `Fan ${speed}`, hexPayload, now);
    }

    // Remote Climate Execution State (DATC_07 0x384 D4 == 0x0A)
    else if (normId === '384' && bytes.length >= 4) {
      const remoteActive = bytes[3] === 0x0A;
      setHvacPower(remoteActive);
    }

    // Charging Limits (Dynamically mapped from catalog, e.g. 0x1F9: AC limit Byte D3 [idx 2], DC limit Byte D4 [idx 3])
    else if ((normId === canMappings.acLimit || normId === canMappings.dcLimit || normId === '1f9') && bytes.length >= 4) {
      // AC Limit (catalog: D3): match 0x64=50%, 0x78=60%, 0x8C=70%, 0xA0=80%, 0xB4=90%, 0xC8=100%
      let ac: number | null = null;
      for (const idx of [2, 6, 7]) {
        if (bytes.length > idx) {
          const b = bytes[idx];
          if (b === 0x64) { ac = 50; break; }
          else if (b === 0x78 || b === 0xa0 && idx !== 2) { ac = 60; break; }
          else if (b === 0x8c || b === 0xc8 && idx !== 2) { ac = 70; break; }
          else if (b === 0xa0 && idx === 2 || b === 0xf5) { ac = 80; break; }
          else if (b === 0xb4 || b === 0x1d) { ac = 90; break; }
          else if (b === 0xc8 && idx === 2 || b === 0x4a) { ac = 100; break; }
        }
      }
      if (ac !== null) setAcChargeLimit(ac);

      // DC Fast Charging Limit (catalog: D4): match 0x64=50%, 0x78=60%, 0x8C=70%, 0xA0=80%, 0xB4=90%, 0xC8=100%
      let dc: number | null = null;
      for (const idx of [3, 4]) {
        if (bytes.length > idx) {
          const b = bytes[idx];
          if (b === 0x64) { dc = 50; break; }
          else if (b === 0x78) { dc = 60; break; }
          else if (b === 0x8c) { dc = 70; break; }
          else if (b === 0xa0) { dc = 80; break; }
          else if (b === 0xb4) { dc = 90; break; }
          else if (b === 0xc8) { dc = 100; break; }
        }
      }
      if (dc !== null) setDcChargeLimit(dc);

      recordLog(idFormatted, 'Charge Limits (AC / DC)', `AC: ${ac !== null ? `${ac}%` : '--'} | DC: ${dc !== null ? `${dc}%` : '--'}`, hexPayload, now);
    }

    // TPMS Tire Pressures (Dynamically mapped from catalog, e.g. 0x593 or 0x368)
    else if ((normId === canMappings.tpms || normId === '593' || normId === '368') && bytes.length >= 4) {
      const fl = Math.round(bytes[0] * 0.2 * 14.5038);
      const fr = Math.round(bytes[1] * 0.2 * 14.5038);
      const rl = Math.round(bytes[2] * 0.2 * 14.5038);
      const rr = Math.round(bytes[3] * 0.2 * 14.5038);
      if (fl > 20 && fl < 55) {
        setTpms({ fl, fr, rl, rr });
        recordLog(idFormatted, canMappings.tpmsName, `FL:${fl} FR:${fr} RL:${rl} RR:${rr} PSI`, hexPayload, now);
      }
    }

    // Metrics tracking
    if (!hasReceivedFrames) {
      setHasReceivedFrames(true);
    }
  };
  handleIncomingCanFrameRef.current = handleIncomingCanFrame;

  // Turn signal hazard blinker timer
  const [blinkState, setBlinkState] = useState(false);
  useEffect(() => {
    if (hazards || turnSignal !== 'off') {
      const t = setInterval(() => setBlinkState(b => !b), 400);
      return () => clearInterval(t);
    }
    setBlinkState(false);
  }, [hazards, turnSignal]);

  // Seat toggle helper - dynamically respects vehicle features (heated and/or ventilated seats)
  const cycleSeat = (current: SeatLevel | null, isDriver: boolean) => {
    const hasHeat = equippedFeatures.has('heated_seats');
    const hasCool = equippedFeatures.has('ventilated_seats');

    if (!hasHeat && !hasCool) {
      triggerNotice('Seat heating / ventilation is not equipped on this trim');
      return;
    }

    let cycle: SeatLevel[] = ['off'];
    if (hasHeat) cycle = cycle.concat(['heat_low', 'heat_med', 'heat_high']);
    if (hasCool) cycle = cycle.concat(['cool_low', 'cool_med', 'cool_high']);

    const currentEffective = current || 'off';
    const nextIdx = (cycle.indexOf(currentEffective) + 1) % cycle.length;
    const next = cycle[nextIdx];
    const seatOptionMap: Record<SeatLevel, string> = {
      off: 'Off',
      heat_low: 'Low Heat',
      heat_med: 'Medium Heat',
      heat_high: 'High Heat',
      cool_low: 'Low Cool',
      cool_med: 'Medium Cool',
      cool_high: 'High Cool',
    };
    const optionCmd = seatOptionMap[next] || next;
    if (isDriver) {
      setDriverSeat(next);
      dispatchCommand('drivers_seat_comfort', optionCmd, `Driver Seat: ${next.replace('_', ' ').toUpperCase()}`);
    } else {
      setPassengerSeat(next);
      dispatchCommand('passengers_seat_comfort', optionCmd, `Passenger Seat: ${next.replace('_', ' ').toUpperCase()}`);
    }
  };

  const cycleSeatHeat = (current: SeatLevel | null, isDriver: boolean) => {
    if (!equippedFeatures.has('heated_seats')) {
      triggerNotice('Seat heating is not equipped on this trim');
      return;
    }

    const cycle: SeatLevel[] = ['off', 'heat_low', 'heat_med', 'heat_high'];
    const currentEffective = (current && current.startsWith('heat')) ? current : 'off';
    const nextIdx = (cycle.indexOf(currentEffective) + 1) % cycle.length;
    const next = cycle[nextIdx];
    const seatOptionMap: Record<SeatLevel, string> = {
      off: 'Off',
      heat_low: 'Low Heat',
      heat_med: 'Medium Heat',
      heat_high: 'High Heat',
      cool_low: 'Low Cool',
      cool_med: 'Medium Cool',
      cool_high: 'High Cool',
    };
    const optionCmd = seatOptionMap[next] || next;
    if (isDriver) {
      setDriverSeat(next);
      dispatchCommand('drivers_seat_comfort', optionCmd, `Driver Seat Heat: ${next === 'off' ? 'OFF' : next.replace('heat_', '').toUpperCase()}`);
    } else {
      setPassengerSeat(next);
      dispatchCommand('passengers_seat_comfort', optionCmd, `Passenger Seat Heat: ${next === 'off' ? 'OFF' : next.replace('heat_', '').toUpperCase()}`);
    }
  };

  const cycleSeatCool = (current: SeatLevel | null, isDriver: boolean) => {
    if (!equippedFeatures.has('ventilated_seats')) {
      triggerNotice('Seat ventilation is not equipped on this trim');
      return;
    }

    const cycle: SeatLevel[] = ['off', 'cool_low', 'cool_med', 'cool_high'];
    const currentEffective = (current && current.startsWith('cool')) ? current : 'off';
    const nextIdx = (cycle.indexOf(currentEffective) + 1) % cycle.length;
    const next = cycle[nextIdx];
    const seatOptionMap: Record<SeatLevel, string> = {
      off: 'Off',
      heat_low: 'Low Heat',
      heat_med: 'Medium Heat',
      heat_high: 'High Heat',
      cool_low: 'Low Cool',
      cool_med: 'Medium Cool',
      cool_high: 'High Cool',
    };
    const optionCmd = seatOptionMap[next] || next;
    if (isDriver) {
      setDriverSeat(next);
      dispatchCommand('drivers_seat_comfort', optionCmd, `Driver Seat Vent: ${next === 'off' ? 'OFF' : next.replace('cool_', '').toUpperCase()}`);
    } else {
      setPassengerSeat(next);
      dispatchCommand('passengers_seat_comfort', optionCmd, `Passenger Seat Vent: ${next === 'off' ? 'OFF' : next.replace('cool_', '').toUpperCase()}`);
    }
  };

  const cycleSteeringHeat = () => {
    if (!equippedFeatures.has('heated_wheel')) {
      triggerNotice('Heated steering wheel is not equipped on this trim');
      return;
    }
    const isCurrentlyOn = steeringWheelHeat === 'on' || steeringWheelHeat === 'high' || steeringWheelHeat === 'low';
    const next: SteeringHeatLevel = isCurrentlyOn ? 'off' : 'on';
    setSteeringWheelHeat(next);
    dispatchCommand(
      'heated_steering_wheel_toggle',
      next === 'off' ? 'Heated Steering Wheel Off' : 'Heated Steering Wheel On',
      `Heated Steering Wheel: ${next.toUpperCase()}`
    );
  };

  const adjustTemp = (isDriver: boolean, delta: number) => {
    const minT = tempUnit === 'C' ? 17 : 62;
    const maxT = tempUnit === 'C' ? 27.5 : 82;
    const step = tempUnit === 'C' ? (delta > 0 ? 0.5 : -0.5) : delta;
    const baseDefault = tempUnit === 'C' ? 21 : 70;
    if (isDriver) {
      const cur = driverTemp !== null ? driverTemp : baseDefault;
      const next = Math.max(minT, Math.min(maxT, tempUnit === 'C' ? Math.round((cur + step) * 2) / 2 : cur + step));
      setDriverTemp(next);
      const targetF = Math.max(62, Math.min(82, displayTempToFahrenheit(next, tempUnit)));
      driverTempFRef.current = targetF;
      if (climateSync) {
        setPassengerTemp(next);
        passengerTempFRef.current = targetF;
      }
      dispatchCommand('climate_driver_temp', `${targetF}°F`, `Driver Target Temp: ${next}°${tempUnit}`);
    } else {
      const cur = passengerTemp !== null ? passengerTemp : baseDefault;
      const next = Math.max(minT, Math.min(maxT, tempUnit === 'C' ? Math.round((cur + step) * 2) / 2 : cur + step));
      setPassengerTemp(next);
      setClimateSync(false);
      const targetF = Math.max(62, Math.min(82, displayTempToFahrenheit(next, tempUnit)));
      passengerTempFRef.current = targetF;
      dispatchCommand('climate_passenger_temp', `${targetF}°F`, `Passenger Target Temp: ${next}°${tempUnit}`);
    }
  };

  const toggleDoor = (key: keyof typeof doors) => {
    const label = String(key).replace(/([A-Z])/g, ' $1').toLowerCase();
    runPreviewOrReadOnly(`Door (${label})`, () => {
      setDoors(prev => ({ ...prev, [key]: !prev[key] }));
      triggerNotice(`${label} ${!doors[key] ? 'Opened' : 'Closed'} (Preview)`);
    });
  };

  const handleToggleHood = () => {
    runPreviewOrReadOnly('Frunk / Hood', () => {
      setHoodOpen(prev => {
        const next = !prev;
        triggerNotice(next ? 'Front Trunk / Hood Unlatched (Preview)' : 'Front Trunk Closed (Preview)');
        return next;
      });
    });
  };

  const handleToggleTrunk = () => {
    const next = !trunkOpen;
    setTrunkOpen(next);
    dispatchCommand(
      'telematics_remote_tailgate',
      next ? 'Open Tailgate / Trunk' : 'Close Tailgate / Trunk',
      next ? 'Power Tailgate Opening' : 'Power Tailgate Closing'
    );
  };

  return (
    <div id="vehicle-live-dashboard" className="space-y-5 select-none animate-fadeIn">
      {/* 1. Header Toolbar: Vehicle ID & Telemetry Status Bar (Option 3: Unified Automotive Status Bar) */}
      <header className="p-4 sm:p-5 rounded-2xl bg-surface border border-border shadow-surface space-y-3">
        {/* Top Row: Vehicle Title & Identity (Left) vs CAN Status Badge (Right) */}
        <div className="flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-surface-secondary border border-border flex items-center justify-center text-accent shrink-0">
              <Car className="w-6 h-6" />
            </div>
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <h1 className="text-base sm:text-lg font-bold text-foreground tracking-tight truncate">
                {activeVehicle ? `${activeVehicle.make} ${activeVehicle.model} ${activeVehicle.trim || ''}`.trim() : `${EGMP_MODELS[selectedModel].brand} ${EGMP_MODELS[selectedModel].name}`}
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full font-mono text-[10px] font-medium tracking-wide text-accent-soft-foreground bg-accent-soft border border-accent/30 shrink-0">
                {activeVehicle?.region ? activeVehicle.region.toUpperCase() : EGMP_MODELS[selectedModel].badge}
              </span>
            </div>
          </div>

          {/* Live CAN Telemetry Connection Badge */}
          <span
            id="live-can-status-badge"
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all shrink-0 ml-auto ${connectedDevice
              ? 'bg-success-soft text-success-soft-foreground border-success/30 shadow-sm'
              : 'bg-surface-secondary text-foreground border-border shadow-sm'
              }`}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${connectedDevice ? 'bg-success animate-pulse' : 'bg-warning'}`} />
            <span>{connectedDevice ? 'Vehicle CAN Online' : 'Awaiting CAN Traffic'}</span>
          </span>
        </div>

        {/* Bottom Row: Integrated Vehicle Telemetry HUD Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-separator text-xs text-muted">
          {/* Left: Odometer, Ambient Temp, Speed */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 text-xs">
            <span className="font-mono text-foreground font-medium">
              {odometer !== null ? `${odometer.toLocaleString()} ${unitSystem === 'metric' ? 'km' : 'mi'}` : `-- ${unitSystem === 'metric' ? 'km' : 'mi'}`}
            </span>
            <span className="text-muted/60">•</span>
            <span className="inline-flex items-center gap-1">
              <Thermometer className="w-3.5 h-3.5 text-muted" />
              <span>{displayAmbient}</span>
              {ambientThreshold && (
                <Chip
                  size="sm"
                  color={ambientThreshold.color}
                  variant="soft"
                  className="text-[10px] px-1.5 py-0.2 rounded font-medium"
                >
                  {ambientThreshold.label}
                </Chip>
              )}
            </span>
            <span className="text-muted/60">•</span>
            <span className="font-mono text-foreground font-medium">
              {unitSystem === 'metric' ? `${speedKph} km/h` : `${speedMph} MPH`}
            </span>
          </div>

          {/* Right: Battery State of Charge (SoC) & Charging Status */}
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            <Tooltip>
              <Tooltip.Trigger>
                <div className="flex items-center gap-2">
                  <Chip
                    size="sm"
                    color={soc !== null && soc <= 20 ? 'danger' : isCharging ? 'success' : 'accent'}
                    variant="soft"
                    className="px-2.5 py-1 text-xs font-mono font-semibold inline-flex items-center gap-1.5 border border-current/20 shadow-sm cursor-help"
                  >
                    {isCharging ? (
                      <BatteryCharging className="w-3.5 h-3.5 text-success animate-pulse mr-1" />
                    ) : (
                      <Battery className="w-3.5 h-3.5 text-accent mr-1" />
                    )}
                    <span>{soc !== null ? `${soc}%` : '--%'}</span>
                    {estimatedRangeMiles !== null && (
                      <span className="text-[10px] opacity-75 ml-1">• {estimatedRangeMiles} {unitSystem === 'metric' ? 'km' : 'mi'}</span>
                    )}
                    {isCharging && (
                      <span className="text-[9px] uppercase tracking-wider font-bold bg-success/20 px-1 rounded text-success-soft-foreground ml-1">
                        Charging
                      </span>
                    )}
                  </Chip>
                  <div className="w-16 hidden sm:block">
                    <ProgressBar
                      value={soc ?? 0}
                      aria-label="HV Traction Battery State of Charge"
                      className="w-full flex flex-col gap-0.5"
                    >
                      <ProgressBar.Track className="w-full bg-surface-tertiary rounded-full h-1.5 overflow-hidden">
                        <ProgressBar.Fill className={`${soc !== null && soc <= 20 ? 'bg-danger' : isCharging ? 'bg-success' : 'bg-accent'} h-1.5 rounded-full transition-all duration-300`} />
                      </ProgressBar.Track>
                    </ProgressBar>
                  </div>
                </div>
              </Tooltip.Trigger>
              <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-overlay border border-border text-overlay-foreground shadow-overlay z-50">
                {isCharging ? `EV Traction Battery Charging: ${soc !== null ? `${soc}%` : '--%'}` : `HV Battery State of Charge: ${soc !== null ? `${soc}%` : '--%'}`}
              </Tooltip.Content>
            </Tooltip>
          </div>
        </div>
      </header>

      {/* Toast Notice */}
      {feedbackNotice && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-overlay border border-accent/40 text-overlay-foreground text-xs shadow-overlay animate-slideUp">
          <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
          <span className="font-medium">{feedbackNotice}</span>
        </div>
      )}

      {/* 2. Main Cockpit Grid: Unified Vehicle Overview & Outlines */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">

        {/* Main Vehicle Column: Unified Vehicle Outline Card */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-4">
          <Card
            id="unified-vehicle-cockpit-card"
            className="relative p-4 sm:p-6 rounded-2xl bg-surface border border-border shadow-surface space-y-5"
          >
            {/* Top Toolbar: Gear Selector, Lock/Unlock Security & Lighting Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-separator">
              {/* Transmission Gear Selector */}
              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-secondary border border-border">
                  {(['P', 'R', 'N', 'D'] as GearMode[]).map((g) => {
                    const active = gear === g;
                    return (
                      <Tooltip key={g}>
                        <Tooltip.Trigger>
                          <button
                            id={`gear-selector-${g}`}
                            type="button"
                            onClick={() => {
                              runPreviewOrReadOnly('Transmission Gear', () => {
                                setGear(g);
                                if (g === 'D') {
                                  setSpeedMph(prev => (prev === 0 ? 35 : prev));
                                  setSpeedKph(prev => (prev === 0 ? 56 : prev));
                                }
                                if (g === 'P') {
                                  setSpeedMph(0);
                                  setSpeedKph(0);
                                }
                                triggerNotice(`Transmission Preview: ${g}`);
                              });
                            }}
                            className="focus:outline-none"
                          >
                            <Chip
                              size="sm"
                              color={active ? 'accent' : 'default'}
                              variant={active ? 'primary' : 'secondary'}
                              className={`w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center transition-all cursor-pointer ${active
                                ? 'bg-accent text-accent-foreground shadow-sm ring-1 ring-accent/40 font-extrabold scale-105'
                                : 'bg-surface-tertiary text-muted hover:text-foreground hover:bg-default-hover'
                                }`}
                            >
                              {g}
                            </Chip>
                          </button>
                        </Tooltip.Trigger>
                        <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-overlay border border-border text-overlay-foreground shadow-overlay z-50">
                          {`Transmission Gear: ${g === 'P' ? 'Park' : g === 'R' ? 'Reverse' : g === 'N' ? 'Neutral' : 'Drive'} (CAN 0x${canMappings.gear.toUpperCase()})`}
                        </Tooltip.Content>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>

              {/* Security Lock Toggle & Exterior Lighting Controls */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Headlights Mode Selector */}
                <Tabs
                  selectedKey={lights || 'off'}
                  onSelectionChange={key => {
                    const mode = key as LightMode;
                    runPreviewOrReadOnly('Headlights Mode', () => {
                      setLights(mode);
                      triggerNotice(`Headlights Preview: ${mode.toUpperCase()}`);
                    });
                  }}
                  aria-label="Headlight Mode"
                >
                  <Tabs.ListContainer className="p-0.5 rounded-xl bg-surface-secondary border border-border text-xs">
                    <Tabs.List className="gap-0.5">
                      {(['off', 'parking', 'low', 'high', 'auto'] as LightMode[]).map(mode => (
                        <Tabs.Tab
                          key={mode}
                          id={mode}
                          data-testid={`light-btn-${mode}`}
                          className={`relative px-2 py-1 rounded-lg text-[11px] font-medium uppercase transition-colors cursor-pointer flex items-center ${lights === mode
                            ? 'text-accent font-bold'
                            : 'text-muted hover:text-foreground'
                            }`}
                        >
                          <span>{mode}</span>
                          <Tabs.Indicator className="rounded-lg bg-surface-tertiary shadow-sm" />
                        </Tabs.Tab>
                      ))}
                    </Tabs.List>
                  </Tabs.ListContainer>
                </Tabs>

                {/* Hazards & Mirrors */}
                <button
                  type="button"
                  id="hazard-btn"
                  onClick={() => {
                    const nextHaz = !hazards;
                    setHazards(nextHaz);
                    dispatchCommand('hazard_lights', nextHaz ? 'Turned ON / Active' : 'Turned OFF / Inactive', nextHaz ? 'Hazard Flashers Active' : 'Hazard Flashers Deactivated');
                  }}
                  className={`p-2 rounded-xl border transition-colors ${hazards
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/50 animate-pulse'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                  title="Hazard Flashers (CAN 0x413 / 0x587)"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                </button>

                {/* Turn Signals Controls */}
                <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-surface-secondary border border-border">
                  <button
                    type="button"
                    id="turn-left-btn"
                    onClick={() => {
                      const next = turnSignal === 'left' ? 'off' : 'left';
                      runPreviewOrReadOnly('Turn Signal', () => {
                        setTurnSignal(next);
                        triggerNotice(`Turn Signal Preview: ${next.toUpperCase()}`);
                      });
                    }}
                    title="Left Turn Signal Indicator (CAN 0x3C1 / 0x413)"
                    className={`px-2 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${(turnSignal === 'left' || hazards) && blinkState
                      ? 'bg-success text-success-foreground font-black shadow-sm scale-105'
                      : turnSignal === 'left'
                        ? 'bg-success-soft text-success-soft-foreground border border-success/40'
                        : 'text-muted hover:text-foreground'
                      }`}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    id="turn-right-btn"
                    onClick={() => {
                      const next = turnSignal === 'right' ? 'off' : 'right';
                      runPreviewOrReadOnly('Turn Signal', () => {
                        setTurnSignal(next);
                        triggerNotice(`Turn Signal Preview: ${next.toUpperCase()}`);
                      });
                    }}
                    title="Right Turn Signal Indicator (CAN 0x3C1 / 0x413)"
                    className={`px-2 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${(turnSignal === 'right' || hazards) && blinkState
                      ? 'bg-success text-success-foreground font-black shadow-sm scale-105'
                      : turnSignal === 'right'
                        ? 'bg-success-soft text-success-soft-foreground border border-success/40'
                        : 'text-muted hover:text-foreground'
                      }`}
                  >
                    ▶
                  </button>
                </div>

                <button
                  type="button"
                  id="mirror-fold-btn"
                  onClick={() => {
                    const nextMirrors = !mirrorsFolded;
                    setMirrorsFolded(nextMirrors);
                    dispatchCommand('power_mirrors', nextMirrors ? 'Fold' : 'Unfold', nextMirrors ? 'Mirrors Folded' : 'Mirrors Unfolded');
                  }}
                  className={`px-2.5 py-1.5 rounded-xl border transition-colors text-[11px] font-medium ${mirrorsFolded
                    ? 'bg-accent-soft text-accent-soft-foreground border-accent/40'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                  title="Exterior Power Mirrors (CAN 0x410 / 0x4A2)"
                >
                  {mirrorsFolded ? 'Mirrors Folded' : 'Fold Mirrors'}
                </button>
                {/* Vehicle Lock/Unlock Master Action */}
                <button
                  type="button"
                  id="lock-all-btn"
                  onClick={() => {
                    const next = !locked;
                    setLocked(next);
                    if (next) {
                      setDoors({ frontLeft: false, frontRight: false, rearLeft: false, rearRight: false });
                      setHoodOpen(false);
                      setTrunkOpen(false);
                    }
                    dispatchCommand('door_locks', next ? 'lock' : 'unlock', next ? 'All Doors Locked & Secured' : 'Vehicle Unlocked');
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 border transition-colors ${locked
                    ? 'bg-surface-secondary text-success border-border hover:bg-surface-tertiary'
                    : 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    }`}
                >
                  {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  <span>{locked ? 'Locked' : 'Unlocked'}</span>
                </button>
              </div>
            </div>



            {/* Central Vehicle Silhouette Visual Stage with Projections & TPMS */}
            <div className="relative py-2 overflow-hidden flex flex-col items-center justify-center min-h-[500px]">
              {/* Headlight beam projections (visible when low or high or auto in Drive) */}
              {(lights === 'low' || lights === 'high' || (lights === 'auto' && gear === 'D')) && (
                <div
                  className={`absolute -top-12 w-64 h-36 bg-gradient-to-t from-accent/20 via-accent/5 to-transparent pointer-events-none blur-xl transition-opacity duration-500 ${lights === 'high' ? 'opacity-80 scale-125' : 'opacity-40'
                    }`}
                  style={{ clipPath: 'polygon(20% 100%, 80% 100%, 100% 0%, 0% 0%)' }}
                />
              )}

              {/* Onboarding-Selected Vehicle Vector Silhouette */}
              <VehicleSilhouette
                model={selectedModel}
                perspective={perspective}
                sunroof={sunroof}
                doors={doors}
                hoodOpen={hoodOpen}
                trunkOpen={trunkOpen}
                chargePortOpen={chargePortOpen}
                isCharging={isCharging}
                mirrorsFolded={mirrorsFolded}
                lights={lights}
                rearDefrost={rearDefrost}
                hazards={hazards}
                turnSignal={turnSignal}
                blinkState={blinkState}
                gear={gear}
                speedMph={speedMph}
                driverSeat={driverSeat}
                passengerSeat={passengerSeat}
                steeringWheelHeat={steeringWheelHeat}
                onToggleDoor={toggleDoor}
                onToggleHood={handleToggleHood}
                onToggleTrunk={handleToggleTrunk}
                onToggleChargePort={() => {
                  const next = !chargePortOpen;
                  setChargePortOpen(next);
                  dispatchCommand(
                    'charge_port',
                    next ? 'Opened / Open' : 'Closed / Shut',
                    next ? 'Charge Port Opened' : 'Charge Port Closed'
                  );
                }}
                onToggleSunroof={cycleSunroofState}
                onCycleDriverSeat={() => cycleSeat(driverSeat, true)}
                onCyclePassengerSeat={() => cycleSeat(passengerSeat, false)}
                onCycleSteeringHeat={cycleSteeringHeat}
              />
            </div>

            {/* Closures, Security & Latches Grid + Roof Controls */}
            <div className="pt-4 border-t border-separator space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-accent" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Closures & Security</h3>
                </div>
              </div>

              {/* Doors & Latches Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
                <button
                  type="button"
                  id="toggle-fl-door"
                  onClick={() => toggleDoor('frontLeft')}
                  className={`p-2 rounded-xl text-left border transition-all ${doors.frontLeft
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <span className="text-[10px] block opacity-75">Driver Door</span>
                  <Chip
                    size="sm"
                    color={doors.frontLeft ? 'warning' : 'default'}
                    variant="soft"
                    className="mt-1 font-semibold text-[10px]"
                  >
                    {doors.frontLeft ? 'Opened' : 'Closed'}
                  </Chip>
                </button>

                <button
                  type="button"
                  id="toggle-fr-door"
                  onClick={() => toggleDoor('frontRight')}
                  className={`p-2 rounded-xl text-left border transition-all ${doors.frontRight
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <span className="text-[10px] block opacity-75">Pass. Door</span>
                  <Chip
                    size="sm"
                    color={doors.frontRight ? 'warning' : 'default'}
                    variant="soft"
                    className="mt-1 font-semibold text-[10px]"
                  >
                    {doors.frontRight ? 'Opened' : 'Closed'}
                  </Chip>
                </button>

                <button
                  type="button"
                  id="toggle-rl-door"
                  onClick={() => toggleDoor('rearLeft')}
                  className={`p-2 rounded-xl text-left border transition-all ${doors.rearLeft
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <span className="text-[10px] block opacity-75">Rear Left</span>
                  <Chip
                    size="sm"
                    color={doors.rearLeft ? 'warning' : 'default'}
                    variant="soft"
                    className="mt-1 font-semibold text-[10px]"
                  >
                    {doors.rearLeft ? 'Opened' : 'Closed'}
                  </Chip>
                </button>

                <button
                  type="button"
                  id="toggle-rr-door"
                  onClick={() => toggleDoor('rearRight')}
                  className={`p-2 rounded-xl text-left border transition-all ${doors.rearRight
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <span className="text-[10px] block opacity-75">Rear Right</span>
                  <Chip
                    size="sm"
                    color={doors.rearRight ? 'warning' : 'default'}
                    variant="soft"
                    className="mt-1 font-semibold text-[10px]"
                  >
                    {doors.rearRight ? 'Opened' : 'Closed'}
                  </Chip>
                </button>

                <button
                  type="button"
                  id="toggle-hood"
                  onClick={handleToggleHood}
                  className={`p-2 rounded-xl text-left border transition-all ${hoodOpen
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <span className="text-[10px] block opacity-75">Frunk / Hood</span>
                  <Chip
                    size="sm"
                    color={hoodOpen ? 'warning' : 'default'}
                    variant="soft"
                    className="mt-1 font-semibold text-[10px]"
                  >
                    {hoodOpen ? 'OPEN' : 'Closed'}
                  </Chip>
                </button>

                <button
                  type="button"
                  id="toggle-trunk"
                  onClick={handleToggleTrunk}
                  className={`p-2 rounded-xl text-left border transition-all ${trunkOpen
                    ? 'bg-warning-soft text-warning-soft-foreground border-warning/40 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <span className="text-[10px] block opacity-75">Liftgate / Trunk</span>
                  <Chip
                    size="sm"
                    color={trunkOpen ? 'warning' : 'default'}
                    variant="soft"
                    className="mt-1 font-semibold text-[10px]"
                  >
                    {trunkOpen ? 'OPEN' : 'Closed'}
                  </Chip>
                </button>
              </div>

              {/* Roof Configuration Row */}
              <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted">Roof Configuration:</span>
                  <span className="font-medium text-foreground">
                    {sunroof.equipped ? EGMP_MODELS[selectedModel].roofType : 'Solid Steel Stamping'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    id="toggle-sunroof-equipped-btn"
                    onClick={toggleSunroofEquipped}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${sunroof.equipped
                      ? 'bg-accent-soft text-accent-soft-foreground border-accent/40 shadow-sm'
                      : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                  >
                    {sunroof.equipped ? 'Glass Equipped' : 'Solid Roof'}
                  </button>

                  {sunroof.equipped && (
                    selectedModel === 'ev6' || selectedModel === 'ioniq6' ? (
                      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface-secondary border border-border">
                        {(['closed', 'vent', 'open'] as const).map(pos => (
                          <button
                            key={pos}
                            type="button"
                            id={`sunroof-pos-${pos}`}
                            onClick={() => {
                              runPreviewOrReadOnly('Sunroof Position', () => {
                                setSunroof(prev => ({ ...prev, state: pos }));
                                triggerNotice(`Sunroof Preview: ${pos === 'vent' ? 'Tilt Vent' : pos === 'open' ? 'Fully Open' : 'Closed'}`);
                              });
                            }}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-colors ${sunroof.state === pos
                              ? 'bg-accent text-accent-foreground shadow-sm'
                              : 'text-muted hover:text-foreground'
                              }`}
                          >
                            {pos}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <button
                        type="button"
                        id="toggle-vision-shade-btn"
                        onClick={toggleSunshade}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${sunroof.sunshade === 'open'
                          ? 'bg-accent-soft text-accent-soft-foreground border-accent/40'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                      >
                        {sunroof.sunshade === 'open' ? 'Vision Shade: Retracted' : 'Vision Shade: Closed'}
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Status Strip */}
            <div className="w-full pt-3 border-t border-separator flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-foreground">
                  {EGMP_MODELS[selectedModel].brand} {EGMP_MODELS[selectedModel].name}
                </span>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Column (Cabin Climate & Comfort Suite) */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-4">

          {/* Dual-Zone Climate Control Suite */}
          <Card className="p-4 sm:p-5 rounded-2xl bg-surface border border-border shadow-surface space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wind className="w-4 h-4 text-accent" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Cabin Climate</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="climate-sync-toggle-btn"
                  onClick={() => {
                    const next = !climateSync;
                    setClimateSync(next);
                    if (next && driverTemp !== null) {
                      setPassengerTemp(driverTemp);
                      passengerTempFRef.current = driverTempFRef.current;
                    }
                    dispatchCommand(
                      'climate_sync_toggle',
                      next ? 'Sync Passenger to Driver' : 'Dual Split / Sync Off',
                      next ? 'Dual Climate Synced' : 'Dual Climate Independent'
                    );
                  }}
                  title="Click to toggle Dual Climate Sync"
                  className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${climateSync
                    ? 'bg-accent-soft text-accent-soft-foreground border-accent/50 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                    }`}
                >
                  <Link2 className={`w-3.5 h-3.5 ${climateSync ? 'text-accent' : 'text-muted'}`} />
                  <span>SYNC</span>
                </button>
                <button
                  type="button"
                  id="hvac-power-toggle"
                  onClick={() => {
                    const next = hvacPower === true ? false : true;
                    setHvacPower(next);
                    dispatchCommand('remote_climate_tmu', next ? 'Remote Climate On' : 'Remote Climate Off', next ? 'Cabin Climate Activated' : 'Cabin Climate Turned OFF');
                  }}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors cursor-pointer border ${hvacPower === true
                    ? 'bg-accent text-accent-foreground border-accent shadow-sm'
                    : hvacPower === false
                      ? 'bg-surface-tertiary text-muted border-border hover:text-foreground'
                      : 'bg-surface-secondary text-muted border-border hover:text-foreground'
                    }`}
                >
                  {hvacPower === true ? 'ON' : hvacPower === false ? 'OFF' : '--'}
                </button>
              </div>
            </div>

            {/* Dual Temperature Setpoint Dials */}
            <div className="grid grid-cols-2 gap-3">
              {/* Driver Temp */}
              <div className="p-3 rounded-xl bg-surface-secondary border border-border flex flex-col items-center">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Driver</span>
                <span className="text-2xl font-bold font-mono text-foreground tracking-tight">
                  {driverTemp !== null ? `${driverTemp}°${tempUnit}` : '--'}
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    id="driver-temp-down"
                    onClick={() => adjustTemp(true, -1)}
                    className="w-7 h-7 rounded-lg bg-surface-tertiary hover:bg-default-hover text-foreground border border-border flex items-center justify-center font-bold text-sm transition-colors"
                  >
                    -
                  </button>
                  <button
                    type="button"
                    id="driver-temp-up"
                    onClick={() => adjustTemp(true, 1)}
                    className="w-7 h-7 rounded-lg bg-surface-tertiary hover:bg-default-hover text-foreground border border-border flex items-center justify-center font-bold text-sm transition-colors"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Passenger Temp */}
              <div className="p-3 rounded-xl bg-surface-secondary border border-border flex flex-col items-center">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Passenger</span>
                <span className="text-2xl font-bold font-mono text-foreground tracking-tight">
                  {passengerTemp !== null ? `${passengerTemp}°${tempUnit}` : '--'}
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    id="pass-temp-down"
                    onClick={() => adjustTemp(false, -1)}
                    className="w-7 h-7 rounded-lg bg-surface-tertiary hover:bg-default-hover text-foreground border border-border flex items-center justify-center font-bold text-sm transition-colors"
                  >
                    -
                  </button>
                  <button
                    type="button"
                    id="pass-temp-up"
                    onClick={() => adjustTemp(false, 1)}
                    className="w-7 h-7 rounded-lg bg-surface-tertiary hover:bg-default-hover text-foreground border border-border flex items-center justify-center font-bold text-sm transition-colors"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Blower Fan Speed Stepper */}
            <div className="space-y-1.5 pt-1">
              <div className="flex justify-between items-center text-xs">
                <span className="text-muted flex items-center gap-1">
                  <Fan className={`w-3.5 h-3.5 ${fanSpeed !== null && fanSpeed > 0 && hvacPower ? 'text-accent animate-spin' : 'text-muted'}`} style={{ animationDuration: `${Math.max(0.4, 2.5 - (fanSpeed || 0) * 0.25)}s` }} />
                  <span>Fan Speed</span>
                </span>
                <span className="font-mono font-bold text-foreground">{fanSpeed === null ? '--' : fanSpeed === 0 ? 'Off' : `Level ${fanSpeed}`}</span>
              </div>
              <div className="grid grid-cols-8 gap-1">
                {[1, 2, 3, 4, 5, 6, 7, 8].map(step => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => {
                      runPreviewOrReadOnly('Blower Fan Speed', () => {
                        setFanSpeed(step);
                        triggerNotice(`Fan Speed Preview: Level ${step}`);
                      });
                    }}
                    className={`h-6 rounded text-[10px] font-mono font-bold transition-colors ${fanSpeed !== null && fanSpeed >= step && hvacPower
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-surface-secondary text-muted border border-border hover:bg-surface-tertiary hover:text-foreground'
                      }`}
                  >
                    {step}
                  </button>
                ))}
              </div>
            </div>

            {/* Airflow Direction Modes */}
            <Tabs
              selectedKey={airflow || 'auto'}
              onSelectionChange={key => {
                const mode = key as AirflowMode;
                runPreviewOrReadOnly('Airflow Direction', () => {
                  setAirflow(mode);
                  triggerNotice(`Airflow Preview: ${AIRFLOW_MODE_LABELS[mode]}`);
                });
              }}
              aria-label="Airflow Direction Modes"
              className="w-full pt-1"
            >
              <Tabs.ListContainer className="p-1 rounded-xl bg-surface-secondary border border-border text-xs w-full">
                <Tabs.List className="!grid grid-cols-5 gap-1 !w-full !min-w-0 !p-0">
                  {(['auto', 'face', 'face_feet', 'feet', 'defrost'] as AirflowMode[]).map(mode => {
                    const label = AIRFLOW_MODE_LABELS[mode];
                    const isSelected = (airflow || 'auto') === mode;
                    const activeColorClass = heatActive === true
                      ? 'text-warning'
                      : acActive === true
                        ? 'text-accent'
                        : 'text-foreground';
                    const indicatorBorderClass = heatActive === true
                      ? 'border-warning/50'
                      : acActive === true
                        ? 'border-accent/50'
                        : 'border-border';
                    return (
                      <Tabs.Tab
                        key={mode}
                        id={mode}
                        data-testid={`airflow-btn-${mode}`}
                        aria-label={`Airflow: ${label}`}
                        className={`relative !min-w-0 w-full px-0.5 py-1.5 min-h-[54px] rounded-lg transition-colors cursor-pointer text-center flex items-center justify-center ${
                          isSelected
                            ? activeColorClass
                            : 'text-muted hover:text-foreground'
                        }`}
                      >
                        <span title={label} className="relative z-10 w-full flex items-center justify-center">
                          <AirflowDirectionIcon mode={mode} className="w-[52px] max-w-full h-[42px]" />
                        </span>
                        <Tabs.Indicator className={`rounded-lg bg-surface-tertiary border ${indicatorBorderClass} shadow-sm`} />
                      </Tabs.Tab>
                    );
                  })}
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>

            {/* Cabin Heat / A/C Toggles */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                id="hvac-heat-toggle"
                onClick={() => {
                  const next = !(heatActive === true);
                  runPreviewOrReadOnly('Cabin Heat Mode', () => {
                    setHeatActive(next);
                    if (next) setHvacPower(true);
                    triggerNotice(next ? 'Cabin Heat Active (Preview)' : 'Cabin Heat Off (Preview)');
                  });
                }}
                aria-pressed={heatActive === true}
                className={`h-[52px] px-3 rounded-xl border font-bold tracking-wide transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                  heatActive === true
                    ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                }`}
              >
                <Flame className={`w-5 h-5 ${heatActive === true ? 'text-warning' : 'text-muted'}`} />
                <span>HEAT</span>
              </button>

              <button
                type="button"
                id="hvac-ac-toggle"
                onClick={() => {
                  const next = !(acActive === true);
                  runPreviewOrReadOnly('Cabin A/C Mode', () => {
                    setAcActive(next);
                    if (next) setHvacPower(true);
                    triggerNotice(next ? 'Cabin A/C Active (Preview)' : 'Cabin A/C Off (Preview)');
                  });
                }}
                aria-pressed={acActive === true}
                className={`h-[52px] px-3 rounded-xl border font-bold tracking-wide transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                  acActive === true
                    ? 'bg-accent-soft text-accent border-accent/50 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                }`}
              >
                <Snowflake className={`w-5 h-5 ${acActive === true ? 'text-accent' : 'text-muted'}`} />
                <span>A/C</span>
              </button>
            </div>

            {/* Quick Climate Toggles (Front Defrost, Rear Defrost, Heated Wheel) */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-separator text-xs">
              <button
                type="button"
                id="front-defrost-btn"
                title="Front Defrost"
                aria-label="Front Defrost"
                aria-pressed={frontDefrost === true}
                onClick={() => {
                  const nextF = frontDefrost === true ? false : true;
                  runPreviewOrReadOnly('Front Defrost', () => {
                    setFrontDefrost(nextF);
                    triggerNotice(nextF ? 'Front Defrost MAX Preview' : 'Front Defrost Off (Preview)');
                  });
                }}
                className={`min-h-[60px] py-1.5 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                  frontDefrost === true
                    ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                }`}
              >
                <FrontDefrostIcon className="w-auto max-w-full h-[42px]" />
                <span
                  className={`w-4 h-1 rounded-full transition-colors ${
                    frontDefrost === true ? 'bg-warning' : 'bg-surface-tertiary border border-border'
                  }`}
                />
              </button>

              <button
                type="button"
                id="rear-defrost-btn"
                title="Rear Defrost & Heated Mirrors"
                aria-label="Rear Defrost"
                aria-pressed={rearDefrost === true}
                onClick={() => {
                  const next = rearDefrost === true ? false : true;
                  setRearDefrost(next);
                  dispatchCommand(
                    'climate_rear_defog',
                    next ? 'Defogger & Mirrors On' : 'Defogger & Mirrors Off',
                    next ? 'Rear Defrost Activated' : 'Rear Defrost Deactivated'
                  );
                }}
                className={`min-h-[60px] py-1.5 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                  rearDefrost === true
                    ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                }`}
              >
                <RearDefrostIcon className="w-auto max-w-full h-[42px]" />
                <span
                  className={`w-4 h-1 rounded-full transition-colors ${
                    rearDefrost === true ? 'bg-warning' : 'bg-surface-tertiary border border-border'
                  }`}
                />
              </button>

              <button
                type="button"
                id="steering-wheel-heat-btn"
                title="Heated Steering Wheel"
                aria-label="Heated Steering Wheel"
                aria-pressed={Boolean(steeringWheelHeat && steeringWheelHeat !== 'off')}
                onClick={cycleSteeringHeat}
                className={`min-h-[60px] py-1.5 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                  steeringWheelHeat && steeringWheelHeat !== 'off'
                    ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                }`}
              >
                <HeatedWheelIcon className="w-auto max-w-full h-[42px]" />
                <span
                  className={`w-4 h-1 rounded-full transition-colors ${
                    steeringWheelHeat && steeringWheelHeat !== 'off'
                      ? 'bg-warning'
                      : 'bg-surface-tertiary border border-border'
                  }`}
                />
              </button>
            </div>

            {/* Seat Comfort Controls */}
            <div className="pt-2 border-t border-separator text-xs">
              <div className="grid grid-cols-2 gap-2">
                {/* Driver Seat Controls */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-foreground block text-center">Driver Seat</span>
                  <div className="flex items-center gap-2">
                    {/* Heat Button */}
                    <button
                      type="button"
                      id="driver-seat-heat-btn"
                      onClick={() => cycleSeatHeat(driverSeat, true)}
                      title="Driver Seat Heating (Off/Low/Med/High)"
                      className={`flex-1 h-[52px] rounded-xl border flex flex-col items-center justify-center transition-all duration-200 ${getSeatHeatLevel(driverSeat) > 0
                        ? 'bg-warning-soft text-warning border-warning/50 shadow-sm scale-[1.01]'
                        : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                        }`}
                    >
                      <Flame className={`w-5 h-5 ${getSeatHeatLevel(driverSeat) > 0 ? 'animate-pulse text-warning' : 'text-muted'}`} />
                      <div className="flex gap-0.5 mt-0.5">
                        {[1, 2, 3].map(i => (
                          <span
                            key={i}
                            className={`w-1 h-1 rounded-full transition-all duration-200 ${i <= getSeatHeatLevel(driverSeat)
                              ? 'bg-warning'
                              : 'bg-surface-tertiary border border-border'
                              }`}
                          />
                        ))}
                      </div>
                    </button>

                    {/* Cool Button */}
                    <button
                      type="button"
                      id="driver-seat-cool-btn"
                      onClick={() => cycleSeatCool(driverSeat, true)}
                      title="Driver Seat Ventilation (Off/Low/Med/High)"
                      className={`flex-1 h-[52px] rounded-xl border flex flex-col items-center justify-center transition-all duration-200 ${getSeatCoolLevel(driverSeat) > 0
                        ? 'bg-accent-soft text-accent border-accent/50 shadow-sm scale-[1.01]'
                        : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                        }`}
                    >
                      <Snowflake className={`w-5 h-5 ${getSeatCoolLevel(driverSeat) > 0 ? 'text-accent' : 'text-muted'}`} />
                      <div className="flex gap-0.5 mt-0.5">
                        {[1, 2, 3].map(i => (
                          <span
                            key={i}
                            className={`w-1 h-1 rounded-full transition-all duration-200 ${i <= getSeatCoolLevel(driverSeat)
                              ? 'bg-accent'
                              : 'bg-surface-tertiary border border-border'
                              }`}
                          />
                        ))}
                      </div>
                    </button>
                  </div>
                </div>

                {/* Passenger Seat Controls */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-foreground block text-center">Passenger Seat</span>
                  <div className="flex items-center gap-2">
                    {/* Heat Button */}
                    <button
                      type="button"
                      id="pass-seat-heat-btn"
                      onClick={() => cycleSeatHeat(passengerSeat, false)}
                      title="Passenger Seat Heating (Off/Low/Med/High)"
                      className={`flex-1 h-[52px] rounded-xl border flex flex-col items-center justify-center transition-all duration-200 ${getSeatHeatLevel(passengerSeat) > 0
                        ? 'bg-warning-soft text-warning border-warning/50 shadow-sm scale-[1.01]'
                        : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                        }`}
                    >
                      <Flame className={`w-5 h-5 ${getSeatHeatLevel(passengerSeat) > 0 ? 'animate-pulse text-warning' : 'text-muted'}`} />
                      <div className="flex gap-0.5 mt-0.5">
                        {[1, 2, 3].map(i => (
                          <span
                            key={i}
                            className={`w-1 h-1 rounded-full transition-all duration-200 ${i <= getSeatHeatLevel(passengerSeat)
                              ? 'bg-warning'
                              : 'bg-surface-tertiary border border-border'
                              }`}
                          />
                        ))}
                      </div>
                    </button>

                    {/* Cool Button */}
                    <button
                      type="button"
                      id="pass-seat-cool-btn"
                      onClick={() => cycleSeatCool(passengerSeat, false)}
                      title="Passenger Seat Ventilation (Off/Low/Med/High)"
                      className={`flex-1 h-[52px] rounded-xl border flex flex-col items-center justify-center transition-all duration-200 ${getSeatCoolLevel(passengerSeat) > 0
                        ? 'bg-accent-soft text-accent border-accent/50 shadow-sm scale-[1.01]'
                        : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                        }`}
                    >
                      <Snowflake className={`w-5 h-5 ${getSeatCoolLevel(passengerSeat) > 0 ? 'text-accent' : 'text-muted'}`} />
                      <div className="flex gap-0.5 mt-0.5">
                        {[1, 2, 3].map(i => (
                          <span
                            key={i}
                            className={`w-1 h-1 rounded-full transition-all duration-200 ${i <= getSeatCoolLevel(passengerSeat)
                              ? 'bg-accent'
                              : 'bg-surface-tertiary border border-border'
                              }`}
                          />
                        ))}
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Rear Heated Seats Steppers */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-separator text-xs">
              <button
                type="button"
                id="rear-left-seat-comfort-btn"
                onClick={() => cycleRearSeat(true)}
                className={`p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${rearLeftSeat?.startsWith('heat')
                  ? 'bg-warning-soft text-warning-soft-foreground border-warning/50 shadow-sm'
                  : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                  }`}
              >
                <span className="text-[10px] block font-semibold opacity-75">Rear Left Seat</span>
                <span className="font-bold font-mono">
                  {rearLeftSeat === null ? '--' : rearLeftSeat.replace('_', ' ').toUpperCase()}
                </span>
              </button>

              <button
                type="button"
                id="rear-right-seat-comfort-btn"
                onClick={() => cycleRearSeat(false)}
                className={`p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${rearRightSeat?.startsWith('heat')
                  ? 'bg-warning-soft text-warning-soft-foreground border-warning/50 shadow-sm'
                  : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                  }`}
              >
                <span className="text-[10px] block font-semibold opacity-75">Rear Right Seat</span>
                <span className="font-bold font-mono">
                  {rearRightSeat === null ? '--' : rearRightSeat.replace('_', ' ').toUpperCase()}
                </span>
              </button>
            </div>
          </Card>

        </div>

      </div>
    </div>
  );
};
