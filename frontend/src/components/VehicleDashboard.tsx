import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Tabs,
  Card,
  Tooltip,
  ProgressBar,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter
} from '@heroui/react';
import { Catalog, Command, Vehicle } from '../types/catalog';
import { isRunningOnDevice, resolveDeviceBaseUrl } from '../utils/hostUtils';
import { resolveVariant } from '../utils/catalogUtils';
import {
  decodeAirflowCanByte,
  decodeAirflowEntityState,
  decodeChargePortCanFrame,
  decodeChargingCanFrame,
  decodeDriverOnlyCanFrame,
  decodeRearSeatEntityUpdate,
  decodeSeatComfortByte,
  decodeSeatLevel,
  decodeSunroofEntityState,
  decodeAmbientCanFrame,
  getAmbientColorHex,
  AMBIENT_PALETTE_64,
  AMBIENT_QUICK_COLORS,
  displayTempToFahrenheit,
  fahrenheitToDisplayTemp,
  formatOdometerFromKm,
  parseBooleanEntityState,
  parseChargingEntityState,
  parseDualCabinTempToF,
  parseOdometerStateToKm,
  parseSingleCabinTempToF,
  AIRFLOW_MODE_COMMAND_LABELS,
} from '../utils/cockpitDecoders';
import { deviceWs } from '../services/deviceWs';
import {
  BatteryCharging,
  Fan,
  Wind,
  Flame,
  Snowflake,
  Lock,
  Unlock,
  AlertTriangle,
  Sun,
  CheckCircle2,
  Link2,
  User,
  Sparkles,
  Palette,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  PlugZap,
  Minus,
  Plus,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  EgmpModel,
  SunroofConfig,
  EGMP_MODELS,
  VehicleSilhouette,
  FrontFasciaHeadlightSignature,
  VehicleSideChargingProfile
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
  demoTelemetryEnabled?: boolean;
  ambientColor?: string | null;
  ambientBrightness?: number | null;
  onAmbientColorChange?: (colorLabel: string) => void;
  onAmbientBrightnessChange?: (brightness: number) => void;
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
  demoTelemetryEnabled = false,
  ambientColor: externalAmbientColor,
  ambientBrightness: externalAmbientBrightness,
  onAmbientColorChange,
  onAmbientBrightnessChange,
  onNavigateToCatalog,
  onNavigateToAutomations
}) => {
  // 0. Model Architecture & Sunroof State
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
  const [autoFoldEnabled, setAutoFoldEnabled] = useState(true);
  const autoFoldEnabledRef = useRef(true);

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
  const [driverOnly, setDriverOnly] = useState<boolean | null>(null);
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

  // Remote Climate Hold-to-Toggle + Kia Startup Animation (prevents accidental activation)
  const REMOTE_CLIMATE_HOLD_MS = 1400;
  const [climateStartAnim, setClimateStartAnim] = useState<'idle' | 'starting' | 'stopping'>('idle');
  const [climateAnimKey, setClimateAnimKey] = useState<number>(0);
  const [climateHoldProgress, setClimateHoldProgress] = useState<number>(0);
  const [climateTab, setClimateTab] = useState<'comfort' | 'vents'>('comfort');
  const startAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStartRef = useRef<number | null>(null);
  const holdRafRef = useRef<number | null>(null);
  const holdTriggeredRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      if (startAnimTimerRef.current) clearTimeout(startAnimTimerRef.current);
      if (holdRafRef.current !== null) cancelAnimationFrame(holdRafRef.current);
    };
  }, []);

  const executeRemoteClimateToggle = () => {
    const next = hvacPower === true ? false : true;
    setHvacPower(next);
    if (next && driverTemp === null) {
      const def = tempUnit === 'C' ? 22 : 72;
      setDriverTemp(def);
      setPassengerTemp(def);
      driverTempFRef.current = 72;
      passengerTempFRef.current = 72;
    }
    if (next && fanSpeed === null) {
      setFanSpeed(3);
    }
    if (startAnimTimerRef.current) clearTimeout(startAnimTimerRef.current);
    setClimateAnimKey(k => k + 1);
    setClimateStartAnim(next ? 'starting' : 'stopping');
    startAnimTimerRef.current = setTimeout(() => {
      setClimateStartAnim('idle');
    }, next ? 1650 : 800);
    dispatchCommand(
      'remote_climate_tmu',
      next ? 'Remote Climate On' : 'Remote Climate Off',
      next ? 'Cabin Climate Activated' : 'Cabin Climate Turned OFF',
      0
    );
  };

  const cancelClimateHold = (showHint = false) => {
    if (holdRafRef.current !== null) {
      cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    const startedAt = holdStartRef.current;
    const wasTriggered = holdTriggeredRef.current;
    holdStartRef.current = null;
    holdTriggeredRef.current = false;
    setClimateHoldProgress(0);
    if (showHint && startedAt !== null && !wasTriggered && performance.now() - startedAt >= 40) {
      triggerNotice('Hold EV button to start or stop climate');
    }
  };

  const startClimateHold = () => {
    if (holdStartRef.current !== null) return;
    holdTriggeredRef.current = false;
    const startTs = performance.now();
    holdStartRef.current = startTs;

    const step = (now: number) => {
      if (holdStartRef.current === null) return;
      const pct = Math.min(100, ((now - startTs) / REMOTE_CLIMATE_HOLD_MS) * 100);
      setClimateHoldProgress(pct);
      if (pct >= 100) {
        holdTriggeredRef.current = true;
        holdStartRef.current = null;
        holdRafRef.current = null;
        setClimateHoldProgress(0);
        executeRemoteClimateToggle();
        return;
      }
      holdRafRef.current = requestAnimationFrame(step);
    };
    holdRafRef.current = requestAnimationFrame(step);
  };

  // Ambient Mood Lighting
  const [ambientBrightness, setAmbientBrightnessState] = useState<number | null>(() => {
    if (externalAmbientBrightness !== undefined) return externalAmbientBrightness;
    try {
      const saved = localStorage.getItem('cando_ambient_brightness');
      if (saved !== null) return parseInt(saved, 10);
    } catch {}
    return 7;
  });
  const [ambientColor, setAmbientColorState] = useState<string | null>(() => {
    if (externalAmbientColor !== undefined && externalAmbientColor !== null) return externalAmbientColor;
    try {
      const saved = localStorage.getItem('cando_ambient_color');
      if (saved) return saved;
    } catch {}
    return 'Color 24: Deep Purple / Violet';
  });
  const [ambientPaletteExpanded, setAmbientPaletteExpanded] = useState<boolean>(false);

  useEffect(() => {
    if (externalAmbientColor !== undefined && externalAmbientColor !== null && externalAmbientColor !== ambientColor) {
      setAmbientColorState(externalAmbientColor);
    }
  }, [externalAmbientColor]);

  useEffect(() => {
    if (externalAmbientBrightness !== undefined && externalAmbientBrightness !== null && externalAmbientBrightness !== ambientBrightness) {
      setAmbientBrightnessState(externalAmbientBrightness);
    }
  }, [externalAmbientBrightness]);

  const setAmbientColor = (nextColor: string | null) => {
    setAmbientColorState(nextColor);
    if (nextColor) {
      try { localStorage.setItem('cando_ambient_color', nextColor); } catch {}
      onAmbientColorChange?.(nextColor);
    }
  };

  const setAmbientBrightness = (nextBrightness: number | null) => {
    setAmbientBrightnessState(nextBrightness);
    if (nextBrightness !== null) {
      try { localStorage.setItem('cando_ambient_brightness', String(nextBrightness)); } catch {}
      onAmbientBrightnessChange?.(nextBrightness);
    }
  };

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

  // UI / Perspective & Rivian-Style State-Driven Vehicle Stage + Overlay Sheets
  type HeroViewMode = 'auto' | 'nose' | 'side' | 'topdown';
  type CockpitOverlay = 'climate' | 'charging' | 'ambient' | null;

  const [perspective, setPerspective] = useState<ViewPerspective>('exterior');
  const [heroViewMode, setHeroViewMode] = useState<HeroViewMode>('auto');
  const [activeOverlay, setActiveOverlay] = useState<CockpitOverlay>(null);
  const [hasReceivedFrames, setHasReceivedFrames] = useState<boolean>(false);
  const [speedKph, setSpeedKph] = useState<number>(0);
  const [connectedDevice, setConnectedDevice] = useState<boolean>(false);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  const appliedDemoRef = useRef<boolean>(false);

  const openClosureLabels = [
    doors.frontLeft ? 'Driver Door' : null,
    doors.frontRight ? 'Pass. Door' : null,
    doors.rearLeft ? 'Rear Left Door' : null,
    doors.rearRight ? 'Rear Right Door' : null,
    hoodOpen ? 'Frunk' : null,
    trunkOpen ? 'Liftgate' : null,
  ].filter(Boolean) as string[];

  const openClosureCount = openClosureLabels.length;
  const hasClosureAlert = openClosureCount > 0 || chargePortOpen || isCharging;
  const effectiveHeroView: 'nose' | 'side' | 'topdown' =
    heroViewMode === 'auto' ? (isCharging ? 'side' : 'nose') : heroViewMode;

  const toggleTopDownView = () => {
    setHeroViewMode(prev => (prev === 'topdown' ? 'auto' : 'topdown'));
  };

  const cycleLightsPreview = () => {
    runPreviewOrReadOnly('Headlight Signature', () => {
      const order: LightMode[] = ['auto', 'parking', 'low', 'high', 'off'];
      setLights(prev => {
        const next = order[(order.indexOf(prev) + 1) % order.length];
        const label =
          next === 'auto'
            ? 'Auto'
            : next === 'parking'
              ? 'DRL / Parking'
              : next === 'low'
                ? 'Low Beam'
                : next === 'high'
                  ? 'High Beam'
                  : 'Off';
        triggerNotice(`Lights Preview: ${label}`);
        return next;
      });
    });
  };

  // Sync optional Settings > Demo Telemetry preference cleanly without a dashboard button
  useEffect(() => {
    if (connectedDevice && hasReceivedFrames) return;
    if (demoTelemetryEnabled && !appliedDemoRef.current) {
      appliedDemoRef.current = true;
      setSoc(78);
      setAmbientTempC(20);
      driverTempFRef.current = 72;
      passengerTempFRef.current = 72;
      setDriverTemp(fahrenheitToDisplayTemp(72, tempUnit));
      setPassengerTemp(fahrenheitToDisplayTemp(72, tempUnit));
      setClimateSync(true);
      setFanSpeed(3);
      setAirflow('auto');
      setBatteryMinTempC(21);
      setBatteryMaxTempC(24);
      setAux12V(12.9);
      setHvVoltage(742);
      setTpms({ fl: 38, fr: 38, rl: 38, rr: 38 });
      setAcChargeLimit(80);
      setDcChargeLimit(80);
    } else if (!demoTelemetryEnabled && appliedDemoRef.current) {
      appliedDemoRef.current = false;
      setSoc(null);
      setAmbientTempC(null);
      setDriverTemp(null);
      setPassengerTemp(null);
      setFanSpeed(null);
      setBatteryMinTempC(null);
      setBatteryMaxTempC(null);
      setAux12V(null);
      setHvVoltage(null);
      setTpms({ fl: null, fr: null, rl: null, rr: null });
      setAcChargeLimit(null);
      setDcChargeLimit(null);
      setIsCharging(false);
      setChargeRateKw(0);
    }
  }, [demoTelemetryEnabled, connectedDevice, hasReceivedFrames, tempUnit]);

  // Calculated ambient temp display
  const displayAmbient = useMemo(() => {
    if (ambientTempC === null) return '--';
    if (tempUnit === 'F') {
      return `${Math.round(ambientTempC * 1.8 + 32)}°F`;
    }
    return `${ambientTempC.toFixed(1)}°C`;
  }, [ambientTempC, tempUnit]);

  const activeColorHex = useMemo(() => {
    return getAmbientColorHex(ambientColor);
  }, [ambientColor]);

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
      ambientTemp: getCanId('outdoor_temperature', getCanId('cond_ambient_temperature', '226')),
      ambientTempName: findCmd('outdoor_temperature')?.ha_metadata?.name || findCmd('cond_ambient_temperature')?.ha_metadata?.name || 'Outdoor Temperature',
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
      defrost: getCanId('climate_rear_defrost', getCanId('climate_rear_defog', '541')),
      defrostName: findCmd('climate_rear_defrost')?.ha_metadata?.name || findCmd('climate_rear_defog')?.ha_metadata?.name || 'Rear Defroster',
      hazards: getCanId('hazard_lights', '413'),
      hazardsName: findCmd('hazard_lights')?.ha_metadata?.name || 'Hazard Flashers',
      welcomeMirrors: getCanId('cgw_welcome_mirror_light', '410'),
      welcomeMirrorsName: findCmd('cgw_welcome_mirror_light')?.ha_metadata?.name || 'Welcome Mirror Auto-Fold',
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
      driverOnly: getCanId('climate_driver_only_toggle', '465'),
      driverOnlyName: findCmd('climate_driver_only_toggle')?.ha_metadata?.name || 'Driver Only Climate Zone',
      heatToggle: getCanId('climate_heat_toggle', '41d'),
      heatToggleName: findCmd('climate_heat_toggle')?.ha_metadata?.name || 'Climate Heat Toggle',
      acToggle: getCanId('climate_ac_toggle', '49f'),
      acToggleName: findCmd('climate_ac_toggle')?.ha_metadata?.name || 'Climate A/C Toggle',
      airflow: getCanId('climate_airflow_direction', '31b'),
      airflowName: findCmd('climate_airflow_direction')?.ha_metadata?.name || 'Climate Airflow Direction',
      ambientLight: getCanId('ambient_light_colors', '455'),
      ambientLightName: findCmd('ambient_light_colors')?.ha_metadata?.name || 'Ambient Mood Lighting',
      ambientLightOptions: findCmd('ambient_light_colors')?.options || [],
      ambientBrightness: getCanId('ambient_light_brightness', '455'),
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

  // Bench preview cycler for outdoor ambient temperature
  const cycleAmbientTempPreview = () => {
    runPreviewOrReadOnly('Outdoor Temperature', () => {
      const presets = [-5, 10, 21.5, 32];
      setAmbientTempC(prev => {
        if (prev === null) return presets[0];
        const nextIdx = (presets.findIndex(p => Math.round(p) === Math.round(prev)) + 1) % presets.length;
        const nextC = presets[nextIdx];
        const f = Math.round(nextC * 1.8 + 32);
        triggerNotice(`Outdoor Temp Preview: ${tempUnit === 'F' ? `${f}°F` : `${nextC}°C`}`);
        return nextC;
      });
    });
  };

  // Sunroof toggles
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

  const setDirectAcLimit = (next: number) => {
    setAcChargeLimit(next);
    dispatchCommand('ac_charging_limit', `${next}%`, `AC Charge Limit: ${next}%`);
  };

  const setDirectDcLimit = (next: number) => {
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
    } else if (entity === 'cgw_welcome_mirror_light' || entity === 'power_mirrors' || entity === 'mirrors') {
      const isEnabled = normState.includes('approach') || normState.includes('enable') || normState.includes('on') || (!normState.includes('disable') && !normState.includes('off'));
      setAutoFoldEnabled(isEnabled);
      autoFoldEnabledRef.current = isEnabled;
      if (isEnabled && locked) {
        setMirrorsFolded(true);
      } else if (!locked) {
        setMirrorsFolded(false);
      }
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
    } else if (entity === 'climate_rear_defrost' || entity === 'climate_rear_defog') {
      setRearDefrost(parseBooleanEntityState(stateStr));
    } else if (entity === 'front_defrost') {
      setFrontDefrost(parseBooleanEntityState(stateStr));
    } else if (entity === 'climate_fan_speed_level' || entity === 'fan_speed') {
      const match = stateStr.match(/(\d+)/);
      if (match) setFanSpeed(parseInt(match[1], 10));
    } else if (entity === 'climate_airflow_direction' || entity === 'airflow_direction') {
      const decodedAf = decodeAirflowEntityState(stateStr);
      if (decodedAf) setAirflow(decodedAf);
    } else if (entity === 'climate_driver_only_toggle' || entity === 'driver_only') {
      setDriverOnly(parseBooleanEntityState(stateStr) || normState.includes('on') || normState.includes('driver only on'));
    } else if (entity === 'climate_heat_toggle' || entity === 'heat_toggle' || entity === 'cabin_heat') {
      setHeatActive(parseBooleanEntityState(stateStr) || normState.includes('on') || normState.includes('heat on'));
    } else if (entity === 'climate_ac_toggle' || entity === 'ac_toggle' || entity === 'cabin_ac') {
      setAcActive(parseBooleanEntityState(stateStr) || normState.includes('on') || normState.includes('a/c on'));
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
    } else if (entity === 'outdoor_temperature' || entity === 'cond_ambient_temperature' || entity === 'ambient_temperature') {
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
    } else if (entity === 'ambient_light_colors' || entity === 'ambient_mood_lighting') {
      setAmbientColor(stateStr);
    } else if (entity === 'ambient_light_brightness') {
      const match = stateStr.match(/(\d+)/);
      if (match) {
        setAmbientBrightness(parseInt(match[1], 10));
      } else if (stateStr.toLowerCase().includes('off')) {
        setAmbientBrightness(0);
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
      if (raw >= 0 && raw < 255) {
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
      if (autoFoldEnabledRef.current) {
        setMirrorsFolded(isLocked);
      }
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

    // Exterior Power Mirrors Setting & Approach Light (0x410: CGW_USM1 Byte D3 bits 0-1)
    else if ((normId === canMappings.welcomeMirrors || normId === '410') && bytes.length >= 3) {
      const wlight = bytes[2] & 0x03;
      const isEnabled = wlight === 0x02;
      setAutoFoldEnabled(isEnabled);
      autoFoldEnabledRef.current = isEnabled;
      if (isEnabled && locked) {
        setMirrorsFolded(true);
      } else if (!locked) {
        setMirrorsFolded(false);
      }
      recordLog(idFormatted, canMappings.welcomeMirrorsName, isEnabled ? 'Auto-Fold on Lock: ENABLED' : 'Auto-Fold on Lock: DISABLED', hexPayload, now);
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
      const decodedAf = decodeAirflowCanByte(bytes[3]);
      if (decodedAf) setAirflow(decodedAf);
      if (bytes.length >= 5) {
        setRecirc(Boolean(bytes[4] & 0x40));
      }
      recordLog(idFormatted, canMappings.fanBlowerName, `Fan ${speed}`, hexPayload, now);
    }

    // Driver-Only Climate Zone (0x465 Byte D7: 0x04=On, 0x0C=Off)
    else if ((normId === canMappings.driverOnly || normId === '465') && bytes.length >= 7) {
      const isDo = decodeDriverOnlyCanFrame(bytes);
      if (isDo !== null) {
        setDriverOnly(isDo);
        recordLog(idFormatted, canMappings.driverOnlyName, isDo ? 'Driver Only On' : 'Driver Only Off', hexPayload, now);
      }
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

    // Ambient Mood Lighting (0x455 / M-CAN: D1=Brightness, D3..D6=Color signature)
    else if ((normId === canMappings.ambientLight || normId === '455') && bytes.length >= 6) {
      const decoded = decodeAmbientCanFrame(bytes, canMappings.ambientLightOptions);
      if (decoded) {
        setAmbientBrightness(decoded.brightness);
        if (decoded.activeOptionLabel) {
          setAmbientColor(decoded.activeOptionLabel);
        }
        recordLog(
          idFormatted,
          canMappings.ambientLightName,
          `Level ${decoded.brightness} (${decoded.activeOptionLabel || 'Custom'})`,
          hexPayload,
          now
        );
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

  const setPresetTemp = (displayVal: number) => {
    const targetF = Math.max(62, Math.min(82, displayTempToFahrenheit(displayVal, tempUnit)));
    setDriverTemp(displayVal);
    driverTempFRef.current = targetF;
    if (climateSync !== false) {
      setClimateSync(true);
      setPassengerTemp(displayVal);
      passengerTempFRef.current = targetF;
    }
    dispatchCommand('climate_driver_temp', `${targetF}°F`, `Cabin Target Temp: ${displayVal}°${tempUnit}`);
  };

  const isThermalBannerActive = hvacPower === true || climateStartAnim === 'starting';
  const isCoolingBanner = acActive === true && heatActive !== true;
  const isSyncedMode = climateSync !== false;
  const displayTargetTemp =
    driverTemp !== null
      ? `${driverTemp}°${tempUnit}`
      : tempUnit === 'C'
        ? '22°C'
        : '72°F';

  const seatLevelLabel = (lvl: SeatLevel | null) => {
    if (!lvl || lvl === 'off') return 'Off';
    return lvl.replace('_', ' ').replace(/\b\w/g, ch => ch.toUpperCase());
  };

  const formatChargeSummary = () => {
    if (isCharging) return `Charging${chargeRateKw > 0 ? ` +${chargeRateKw} kW` : ''}`;
    if (gear === 'P') return 'Parked';
    if (gear === 'R') return 'Reverse';
    if (gear === 'N') return 'Neutral';
    if (gear === 'D') return 'Drive';
    return `Gear ${gear}`;
  };

  const chargeLimitPresets = [60, 70, 80, 90, 100];
  const tempPresets = tempUnit === 'C' ? [19, 21, 22, 24] : [68, 70, 72, 74];

  return (
    <div id="vehicle-live-dashboard" className="space-y-5 select-none animate-fadeIn">

      {/* Toast Notice */}
      {feedbackNotice && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-overlay border border-accent/40 text-overlay-foreground text-xs shadow-overlay animate-slideUp">
          <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
          <span className="font-medium">{feedbackNotice}</span>
        </div>
      )}

      {/* Rivian-Style Main Cockpit Canvas */}
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="space-y-4">
          {/* HERO VEHICLE STAGE & QUICK ACTIONS CARD */}
          <Card
            id="unified-vehicle-cockpit-card"
            className="overflow-hidden rounded-3xl bg-surface border border-border shadow-surface"
          >
            {/* Dynamic Thermal Banner (Slides open when Remote Climate / HVAC is running, Rivian 3.0 style) */}
            {isThermalBannerActive && (
              <div
                id="climate-running-banner"
                className="px-5 py-5 text-white transition-all duration-300"
                style={{
                  background: isCoolingBanner
                    ? 'linear-gradient(135deg, #135582 0%, #1d70a6 100%)'
                    : 'linear-gradient(135deg, #c84b28 0%, #e0633c 100%)'
                }}
              >
                <div className="flex flex-col items-center text-center gap-1.5">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/90">
                    <Fan className="w-4 h-4 animate-spin" style={{ animationDuration: '1.8s' }} />
                    <span>{isCoolingBanner ? 'Cooling Cabin' : 'Conditioning Cabin'}</span>
                  </div>

                  {/* Direct In-Banner Temp Stepper */}
                  <div className="flex items-center justify-center gap-4 mt-1">
                    <button
                      type="button"
                      onClick={() => adjustTemp(true, -1)}
                      aria-label="Decrease target cabin temperature"
                      className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <div className="text-4xl sm:text-5xl font-bold font-mono tabular-nums tracking-tight leading-none min-w-[110px]">
                      {displayTargetTemp}
                    </div>
                    <button
                      type="button"
                      onClick={() => adjustTemp(true, 1)}
                      aria-label="Increase target cabin temperature"
                      className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  <p className="text-sm font-semibold mt-0.5">Climate is running</p>
                  <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-white/85">
                    <span>
                      Target {displayTargetTemp}
                      {ambientTempC !== null ? ` · Outside ${displayAmbient}` : ''}
                      {driverOnly === true ? ' · Driver Only' : ''}
                    </span>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={executeRemoteClimateToggle}
                      className="underline font-semibold hover:text-white cursor-pointer"
                    >
                      Turn Off
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="p-5 sm:p-6 space-y-5">
              {/* Centered Rivian 3.0 Range Hero Anchor */}
              <div className="flex flex-col items-center text-center space-y-1.5 pt-1">
                <div className="flex items-baseline justify-center gap-2">
                  <span className="text-5xl sm:text-6xl font-bold tracking-tight text-foreground font-mono tabular-nums leading-none">
                    {estimatedRangeMiles !== null ? estimatedRangeMiles : '--'}
                  </span>
                  <span className="text-xl sm:text-2xl font-semibold text-muted">
                    {unitSystem === 'metric' ? 'km' : 'mi'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted">
                  <span className="font-mono tabular-nums font-semibold text-foreground">
                    {soc !== null ? `${soc}%` : '--%'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={isCharging ? 'text-success font-semibold' : ''}>
                    {formatChargeSummary()}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-foreground">
                    {unitSystem === 'metric' ? `${speedKph} km/h` : `${speedMph} MPH`}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={locked ? 'text-foreground' : 'text-warning font-semibold'}>
                    {locked ? 'Secured' : 'Unlocked'}
                  </span>
                  {odometer !== null && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {odometer.toLocaleString()} {unitSystem === 'metric' ? 'km' : 'mi'}
                      </span>
                    </>
                  )}
                </div>

                {/* Compact Centered SoC Progress Bar */}
                <div className="w-full max-w-sm pt-1.5">
                  <ProgressBar
                    value={soc ?? 0}
                    aria-label="HV Traction Battery State of Charge"
                    className="w-full"
                  >
                    <ProgressBar.Track className="w-full bg-surface-secondary rounded-full h-1.5 overflow-hidden border border-border/50">
                      <ProgressBar.Fill
                        className={`${
                          soc !== null && soc <= 20
                            ? 'bg-danger'
                            : isCharging
                              ? 'bg-success'
                              : 'bg-accent'
                        } h-1.5 rounded-full transition-all duration-300`}
                      />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              </div>

              {/* Contextual Closure / Charging Alert Strip */}
              {hasClosureAlert && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-surface-secondary border border-border text-xs">
                  <div className="flex items-center gap-2 text-foreground min-w-0">
                    <AlertTriangle className={`w-4 h-4 shrink-0 ${isCharging && openClosureCount === 0 ? 'text-success' : 'text-warning'}`} />
                    <span className="font-medium truncate">
                      {openClosureCount > 0
                        ? `${openClosureLabels.join(' · ')} open`
                        : isCharging
                          ? `Charging active${chargeRateKw > 0 ? ` · +${chargeRateKw} kW` : ''}`
                          : 'Charge port door open'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={toggleTopDownView}
                    className="text-accent font-semibold hover:underline cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {effectiveHeroView === 'topdown' ? 'Compact View' : 'Top-Down View'}
                  </button>
                </div>
              )}

              {/* State-Driven Rivian Hero Stage: Front Nose (Idle), Side View (Charging / Toggle), or Top-Down */}
              <div className="space-y-3">
                {effectiveHeroView === 'side' && (
                  <div className="py-1 flex flex-col items-center justify-center px-2">
                    <div className="w-full max-w-[400px] space-y-1.5">
                      <VehicleSideChargingProfile
                        model={selectedModel}
                        soc={soc}
                        chargeRateKw={chargeRateKw}
                        lights={lights}
                        gear={gear}
                        trunkOpen={trunkOpen}
                        hoodOpen={hoodOpen}
                        onClick={() => setActiveOverlay('charging')}
                      />
                      <div className="flex items-center justify-center gap-2 text-[11px] text-muted font-mono tabular-nums">
                        <span className={isCharging ? 'text-success font-semibold' : 'text-foreground/80 font-medium'}>
                          {isCharging
                            ? chargeRateKw > 0
                              ? `+${chargeRateKw} kW Charging`
                              : 'Charging Active'
                            : 'Side Charging Preview'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {soc !== null ? `${soc}%` : '--%'} → {acChargeLimit ?? 80}% limit
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {effectiveHeroView === 'nose' && (
                  <div className="py-2 flex flex-col items-center justify-center px-2">
                    <div className="w-full max-w-[360px] space-y-1.5">
                      <FrontFasciaHeadlightSignature
                        model={selectedModel}
                        lights={lights}
                        gear={gear}
                        hazards={hazards}
                        turnSignal={turnSignal}
                        blinkState={blinkState}
                        hoodOpen={hoodOpen}
                        onClick={cycleLightsPreview}
                      />
                      <div className="flex items-center justify-center gap-2 text-[11px] text-muted">
                        <span>
                          {EGMP_MODELS[selectedModel].brand} {EGMP_MODELS[selectedModel].name}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Lights {lights === 'auto' ? (gear !== 'P' ? 'Active' : 'Auto') : lights.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {effectiveHeroView === 'topdown' && (
                  <div className="space-y-3 pt-1">
                    <div className="relative py-1 overflow-hidden flex flex-col items-center justify-center">
                      {(lights === 'low' || lights === 'high' || (lights === 'auto' && gear === 'D')) && (
                        <div
                          className={`absolute -top-6 w-56 h-24 bg-gradient-to-t from-accent/20 via-accent/5 to-transparent pointer-events-none blur-xl transition-opacity duration-500 ${
                            lights === 'high' ? 'opacity-80 scale-125' : 'opacity-40'
                          }`}
                          style={{ clipPath: 'polygon(20% 100%, 80% 100%, 100% 0%, 0% 0%)' }}
                        />
                      )}
                      <div className="w-full max-w-[205px] sm:max-w-[225px]">
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
                    </div>

                    <div className="flex justify-center">
                      <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-secondary border border-border">
                        {(['exterior', 'interior', 'powertrain'] as ViewPerspective[]).map(p => (
                          <button
                            key={p}
                            type="button"
                            id={`perspective-tab-${p}`}
                            onClick={() => setPerspective(p)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              perspective === p
                                ? 'bg-surface text-foreground shadow-sm border border-border/60'
                                : 'text-muted hover:text-foreground'
                            }`}
                          >
                            {p === 'powertrain' ? '800V Powertrain' : p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Compact View Switcher: Auto / Front Nose / Side View / Top-Down */}
                <div className="flex justify-center">
                  <div
                    role="group"
                    aria-label="Vehicle stage view mode"
                    className="inline-flex items-center gap-1 p-1 rounded-xl bg-surface-secondary border border-border text-xs"
                  >
                    {([
                      { id: 'auto', label: 'Auto' },
                      { id: 'nose', label: 'Front Nose' },
                      { id: 'side', label: 'Side View' },
                      { id: 'topdown', label: 'Top-Down' },
                    ] as const).map(opt => {
                      const active = heroViewMode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          id={opt.id === 'side' ? 'hero-view-side-btn' : `hero-view-${opt.id}-btn`}
                          onClick={() => setHeroViewMode(opt.id)}
                          className={`px-2.5 sm:px-3 py-1.5 rounded-lg font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                            active
                              ? 'bg-surface text-foreground shadow-sm border border-border/60'
                              : 'text-muted hover:text-foreground'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Rivian-Style Quick Actions Dock + Zero-Friction Single-Tap EV Start Button */}
              <div
                className={`relative py-3.5 px-3 rounded-2xl border overflow-hidden transition-colors duration-300 ${
                  climateStartAnim === 'starting'
                    ? 'bg-zinc-950/95 border-border shadow-inner'
                    : 'bg-surface-secondary/50 border-border'
                }`}
              >
                {/* Kia "Opposites United" Geometric Lattice + Neon Light-Streak Stage */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-300"
                  style={{
                    opacity:
                      climateStartAnim === 'starting'
                        ? 1
                        : hvacPower === true
                          ? 0.2
                          : 0
                  }}
                >
                  <div
                    className="absolute inset-0 opacity-25"
                    style={{
                      backgroundImage:
                        'linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)',
                      backgroundSize: '22px 22px'
                    }}
                  />

                  <svg
                    key={`kia-stage-${climateAnimKey}`}
                    viewBox="0 0 400 100"
                    preserveAspectRatio="none"
                    className="absolute inset-0 w-full h-full"
                  >
                    <defs>
                      <filter id="kiaLaserGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="2.2" result="blur" />
                        <feMerge>
                          <feMergeNode in="blur" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
                      </filter>
                    </defs>

                    <path
                      d="M 0 50 L 90 50 L 122 26 L 200 50"
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      filter="url(#kiaLaserGlow)"
                      className={climateStartAnim === 'starting' ? 'kia-streak-active' : ''}
                    />

                    <path
                      d="M 400 50 L 310 50 L 278 74 L 200 50"
                      fill="none"
                      stroke={activeColorHex}
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      filter="url(#kiaLaserGlow)"
                      className={climateStartAnim === 'starting' ? 'kia-streak-active' : ''}
                    />

                    <line
                      x1="128"
                      y1="96"
                      x2="272"
                      y2="4"
                      stroke="#7dd3fc"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      filter="url(#kiaLaserGlow)"
                      className={climateStartAnim === 'starting' ? 'kia-streak-active' : ''}
                    />
                    <line
                      x1="272"
                      y1="96"
                      x2="128"
                      y2="4"
                      stroke="#fb7185"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      filter="url(#kiaLaserGlow)"
                      className={climateStartAnim === 'starting' ? 'kia-streak-active' : ''}
                    />

                    {climateStartAnim === 'starting' && (
                      <g className="kia-crosshair-active">
                        <line x1="150" y1="50" x2="250" y2="50" stroke="#e0f2fe" strokeWidth="1.4" filter="url(#kiaLaserGlow)" />
                        <line x1="200" y1="10" x2="200" y2="90" stroke={activeColorHex} strokeWidth="1.4" filter="url(#kiaLaserGlow)" />
                        <circle cx="200" cy="50" r="14" fill={activeColorHex} opacity="0.35" filter="url(#kiaLaserGlow)" />
                      </g>
                    )}
                  </svg>
                </div>

                {/* Subtle horizontal EV6 dashboard trim line behind quick actions */}
                <div
                  className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2px] opacity-30 transition-colors duration-300"
                  style={{
                    background: `linear-gradient(90deg, transparent 0%, ${activeColorHex} 22%, ${activeColorHex} 78%, transparent 100%)`
                  }}
                />

                <div className="relative z-10 grid grid-cols-4 items-start justify-items-center gap-2">
                  {/* 1. Lock / Unlock */}
                  <div className="flex flex-col items-center gap-1.5">
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
                        if (autoFoldEnabledRef.current) {
                          setMirrorsFolded(next);
                        }
                        dispatchCommand('door_locks', next ? 'lock' : 'unlock', next ? 'All Doors Locked & Secured' : 'Vehicle Unlocked');
                      }}
                      className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center transition-all cursor-pointer border active:scale-95 ${
                        locked
                          ? 'bg-foreground text-background border-foreground shadow-sm hover:opacity-90'
                          : 'bg-warning-soft text-warning-soft-foreground border-warning/50 hover:bg-warning/20'
                      }`}
                      title={locked ? 'Tap to Unlock Vehicle' : 'Tap to Lock Vehicle'}
                    >
                      {locked ? <Lock className="w-5 h-5" /> : <Unlock className="w-5 h-5" />}
                    </button>
                    <span className="text-[11px] font-medium text-foreground whitespace-nowrap">
                      {locked ? 'Locked' : 'Unlocked'}
                    </span>
                  </div>

                  {/* 2. Centerpiece: Hold-to-Toggle Kia EV6 Power Button (Sole Climate Start Control) */}
                  <div className="flex flex-col items-center gap-1.5">
                    <Tooltip>
                      <Tooltip.Trigger>
                        <div className="relative flex items-center justify-center">
                          {/* Press-and-Hold Radial Progress Ring */}
                          {climateHoldProgress > 0 && (
                            <svg
                              viewBox="0 0 76 76"
                              aria-hidden="true"
                              className="pointer-events-none absolute -inset-1.5 w-[calc(100%+12px)] h-[calc(100%+12px)] -rotate-90"
                            >
                              <circle
                                cx="38"
                                cy="38"
                                r="34"
                                fill="none"
                                stroke="rgba(255,255,255,0.18)"
                                strokeWidth="3.5"
                              />
                              <circle
                                cx="38"
                                cy="38"
                                r="34"
                                fill="none"
                                stroke={activeColorHex}
                                strokeWidth="3.5"
                                strokeLinecap="round"
                                strokeDasharray={2 * Math.PI * 34}
                                strokeDashoffset={2 * Math.PI * 34 * (1 - climateHoldProgress / 100)}
                                style={{ filter: `drop-shadow(0 0 6px ${activeColorHex})` }}
                              />
                            </svg>
                          )}

                          {climateStartAnim === 'starting' && (
                            <span
                              key={`ignite-ring-${climateAnimKey}`}
                              aria-hidden="true"
                              className="kia-ring-ignite-active pointer-events-none absolute inset-0 rounded-full border-2"
                              style={{
                                borderColor: activeColorHex,
                                boxShadow: `0 0 18px ${activeColorHex}, 0 0 8px #7dd3fc`
                              }}
                            />
                          )}

                          <button
                            type="button"
                            id="hvac-power-toggle"
                            aria-label={
                              hvacPower === true
                                ? 'Remote Climate Active — Press and hold to stop'
                                : 'Press and hold to start Remote Climate'
                            }
                            aria-pressed={hvacPower === true}
                            onPointerDown={startClimateHold}
                            onPointerUp={() => cancelClimateHold(true)}
                            onPointerLeave={() => cancelClimateHold(false)}
                            onPointerCancel={() => cancelClimateHold(false)}
                            onKeyDown={(e) => {
                              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                                e.preventDefault();
                                startClimateHold();
                              }
                            }}
                            onKeyUp={(e) => {
                              if (e.key === ' ' || e.key === 'Enter') {
                                e.preventDefault();
                                cancelClimateHold(true);
                              }
                            }}
                            onContextMenu={(e) => e.preventDefault()}
                            style={{
                              borderColor: activeColorHex,
                              boxShadow:
                                climateStartAnim === 'starting' || climateHoldProgress > 0
                                  ? `0 0 26px ${activeColorHex}, 0 0 14px #38bdf8, inset 0 0 10px rgba(0,0,0,0.9)`
                                  : hvacPower === true
                                    ? `0 0 18px ${activeColorHex}, 0 0 6px ${activeColorHex}, inset 0 0 8px rgba(0,0,0,0.85)`
                                    : ambientBrightness === null || ambientBrightness > 0
                                      ? `0 0 10px color-mix(in oklab, ${activeColorHex} 45%, transparent), inset 0 1px 2px rgba(255,255,255,0.2)`
                                      : 'inset 0 1px 2px rgba(255,255,255,0.15)'
                            }}
                            className="group relative w-14 h-14 sm:w-16 sm:h-16 rounded-full border-2 p-1 cursor-pointer select-none touch-none transition-all duration-200 focus:outline-none bg-gradient-to-b from-zinc-800 via-zinc-950 to-black flex items-center justify-center active:scale-95"
                          >
                            <span
                              className="w-full h-full rounded-full p-[3px] flex items-center justify-center transition-transform duration-200 group-hover:scale-[1.02]"
                              style={{
                                background:
                                  'linear-gradient(135deg, #f4f4f6 0%, #a1a1aa 28%, #52525b 55%, #d4d4d8 82%, #71717a 100%)',
                                boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.65), 0 2px 5px rgba(0,0,0,0.8)'
                              }}
                            >
                              <span
                                className="relative w-full h-full rounded-full flex items-center justify-center overflow-hidden"
                                style={{
                                  background:
                                    'radial-gradient(circle at 35% 28%, #3f3f46 0%, #18181b 48%, #09090b 85%, #000000 100%)',
                                  boxShadow:
                                    'inset 0 3px 6px rgba(0,0,0,0.85), inset 0 -1px 3px rgba(255,255,255,0.12)'
                                }}
                              >
                                <span
                                  className="pointer-events-none absolute -top-1 -left-1 w-8 h-5 rounded-full opacity-25 blur-[1px] -rotate-12"
                                  style={{
                                    background: 'linear-gradient(180deg, rgba(255,255,255,0.75) 0%, transparent 100%)'
                                  }}
                                />

                                {climateStartAnim === 'starting' && (
                                  <span
                                    key={`cap-flare-${climateAnimKey}`}
                                    aria-hidden="true"
                                    className="kia-cap-flare-active pointer-events-none absolute inset-0 w-16 h-2.5 my-auto"
                                    style={{
                                      background:
                                        'linear-gradient(90deg, transparent 0%, rgba(125,211,252,0.85) 45%, rgba(255,255,255,0.98) 50%, rgba(251,113,133,0.85) 55%, transparent 100%)',
                                      filter: 'blur(1px)'
                                    }}
                                  />
                                )}

                                <svg
                                  viewBox="0 0 64 64"
                                  className={`w-8 h-8 sm:w-9 sm:h-9 transition-all duration-300 ${
                                    climateStartAnim === 'starting' || climateHoldProgress > 0 ? 'scale-105' : ''
                                  }`}
                                  style={{
                                    filter:
                                      climateStartAnim === 'starting' || hvacPower === true || climateHoldProgress > 0
                                        ? `drop-shadow(0 0 7px ${activeColorHex}) drop-shadow(0 0 3px #ffffff)`
                                        : 'drop-shadow(0 0 2px rgba(255,255,255,0.35))'
                                  }}
                                  aria-hidden="true"
                                >
                                  <line
                                    x1="32"
                                    y1="10"
                                    x2="32"
                                    y2="23"
                                    stroke={hvacPower === true || climateHoldProgress > 0 ? '#ffffff' : '#e4e4e7'}
                                    strokeWidth="4.2"
                                    strokeLinecap="round"
                                  />
                                  <path
                                    d="M 22.5 15.2 A 19 19 0 1 0 41.5 15.2"
                                    fill="none"
                                    stroke={hvacPower === true || climateHoldProgress > 0 ? '#ffffff' : '#e4e4e7'}
                                    strokeWidth="4.2"
                                    strokeLinecap="round"
                                  />
                                  <text
                                    x="32"
                                    y="37.5"
                                    textAnchor="middle"
                                    fill={hvacPower === true || climateHoldProgress > 0 ? '#ffffff' : '#e4e4e7'}
                                    fontSize="13.5"
                                    fontWeight="800"
                                    letterSpacing="0.8"
                                    fontFamily="system-ui, -apple-system, sans-serif"
                                  >
                                    EV
                                  </text>
                                </svg>
                              </span>
                            </span>
                          </button>
                        </div>
                      </Tooltip.Trigger>
                      <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-overlay border border-border text-overlay-foreground shadow-overlay z-50">
                        {`Remote Climate (${hvacPower === true ? 'Active — Hold to Stop' : 'Hold to Start'})`}
                      </Tooltip.Content>
                    </Tooltip>

                    <span className="text-[11px] font-semibold text-foreground whitespace-nowrap">
                      {climateHoldProgress > 0
                        ? hvacPower === true
                          ? 'Stopping...'
                          : 'Holding...'
                        : climateStartAnim === 'starting'
                          ? 'Starting...'
                          : hvacPower === true
                            ? 'Climate ON'
                            : 'Hold Climate'}
                    </span>
                  </div>

                  {/* 3. Liftgate / Trunk */}
                  <div className="flex flex-col items-center gap-1.5">
                    <button
                      type="button"
                      id="quick-trunk-btn"
                      onClick={handleToggleTrunk}
                      className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center transition-all cursor-pointer border active:scale-95 ${
                        trunkOpen
                          ? 'bg-warning-soft text-warning-soft-foreground border-warning/60 shadow-sm'
                          : 'bg-surface text-foreground border-border hover:bg-surface-tertiary'
                      }`}
                      title="Toggle Power Liftgate / Trunk"
                    >
                      <ChevronUp className={`w-5 h-5 transition-transform ${trunkOpen ? 'rotate-180' : ''}`} />
                    </button>
                    <span className="text-[11px] font-medium text-muted whitespace-nowrap">
                      {trunkOpen ? 'Trunk Open' : 'Liftgate'}
                    </span>
                  </div>

                  {/* 4. Charge Port */}
                  <div className="flex flex-col items-center gap-1.5">
                    <button
                      type="button"
                      id="quick-charge-port-btn"
                      onClick={() => {
                        const next = !chargePortOpen;
                        setChargePortOpen(next);
                        dispatchCommand(
                          'charge_port',
                          next ? 'Opened / Open' : 'Closed / Shut',
                          next ? 'Charge Port Opened' : 'Charge Port Closed'
                        );
                      }}
                      className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center transition-all cursor-pointer border active:scale-95 ${
                        isCharging
                          ? 'bg-success-soft text-success-soft-foreground border-success/60 shadow-sm'
                          : chargePortOpen
                            ? 'bg-warning-soft text-warning-soft-foreground border-warning/60 shadow-sm'
                            : 'bg-surface text-foreground border-border hover:bg-surface-tertiary'
                      }`}
                      title="Toggle Charge Port Door"
                    >
                      <PlugZap className="w-5 h-5" />
                    </button>
                    <span className="text-[11px] font-medium text-muted whitespace-nowrap">
                      {isCharging ? 'Charging' : chargePortOpen ? 'Port Open' : 'Port'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* RIVIAN-STYLE 2-UP SQUARES: CLIMATE (LEFT) & CHARGING (RIGHT) */}
          <div className="grid grid-cols-2 gap-3.5 sm:gap-4">
            {/* LEFT SQUARE: CLIMATE (Tap opens full Climate overlay) */}
            <div
              id="climate-summary-square"
              className="rounded-3xl bg-surface border border-border hover:border-accent/50 transition-all duration-200 shadow-surface flex flex-col justify-between p-4 sm:p-5 min-h-[176px]"
            >
              <button
                type="button"
                onClick={() => setActiveOverlay('climate')}
                className="w-full text-left space-y-2.5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${
                        hvacPower === true
                          ? isCoolingBanner
                            ? 'bg-accent text-accent-foreground border-accent'
                            : 'bg-warning text-warning-foreground border-warning'
                          : 'bg-surface-secondary text-muted border-border'
                      }`}
                    >
                      <Wind className="w-4 h-4" />
                    </span>
                    <span className="text-sm font-bold text-foreground truncate">Climate</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted shrink-0" />
                </div>

                <div>
                  <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums tracking-tight text-foreground leading-none">
                    {driverTemp !== null
                      ? isSyncedMode || passengerTemp === null || passengerTemp === driverTemp
                        ? `${driverTemp}°${tempUnit}`
                        : `${driverTemp}° / ${passengerTemp}°`
                      : '--'}
                  </div>
                  <p className="text-xs text-muted mt-1.5 truncate">
                    {[
                      hvacPower === true ? 'Running' : 'Standby',
                      ambientTempC !== null ? `Outside ${displayAmbient}` : null,
                      heatActive === true ? 'Heat' : acActive === true ? 'A/C' : null,
                      driverSeat && driverSeat !== 'off' ? 'Seat' : null,
                      steeringWheelHeat && steeringWheelHeat !== 'off' ? 'Wheel' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </button>

              <div className="pt-3 mt-2 border-t border-separator flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => adjustTemp(true, -1)}
                    aria-label="Decrease target temperature"
                    className="w-10 h-10 rounded-full bg-surface-secondary hover:bg-surface-tertiary border border-border flex items-center justify-center text-foreground transition-colors cursor-pointer"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustTemp(true, 1)}
                    aria-label="Increase target temperature"
                    className="w-10 h-10 rounded-full bg-surface-secondary hover:bg-surface-tertiary border border-border flex items-center justify-center text-foreground transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveOverlay('climate')}
                  className="text-xs font-semibold text-accent hover:underline cursor-pointer whitespace-nowrap px-1 py-2"
                >
                  Open
                </button>
              </div>
            </div>

            {/* RIGHT SQUARE: CHARGING & ENERGY (Tap opens full Charging overlay) */}
            <div
              id="energy-summary-square"
              className="rounded-3xl bg-surface border border-border hover:border-success/50 transition-all duration-200 shadow-surface flex flex-col justify-between p-4 sm:p-5 min-h-[176px]"
            >
              <button
                type="button"
                onClick={() => setActiveOverlay('charging')}
                className="w-full text-left space-y-2.5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${
                        isCharging
                          ? 'bg-success text-success-foreground border-success'
                          : 'bg-success-soft text-success border-success/30'
                      }`}
                    >
                      <BatteryCharging className="w-4 h-4" />
                    </span>
                    <span className="text-sm font-bold text-foreground truncate">Charging</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted shrink-0" />
                </div>

                <div>
                  <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums tracking-tight text-foreground leading-none">
                    {soc !== null ? `${soc}%` : '--%'}
                  </div>
                  <p className="text-xs text-muted mt-1.5 font-mono tabular-nums truncate">
                    {[
                      isCharging ? (chargeRateKw > 0 ? `+${chargeRateKw} kW` : 'Active') : `AC ${acChargeLimit ?? 80}%`,
                      `DC ${dcChargeLimit ?? 80}%`,
                      aux12V !== null ? `12V ${aux12V.toFixed(1)}V` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </button>

              <div className="pt-3 mt-2 border-t border-separator space-y-2">
                <div className="relative w-full h-1.5 rounded-full bg-surface-secondary overflow-hidden border border-border/50">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${isCharging ? 'bg-success' : 'bg-accent'}`}
                    style={{ width: `${Math.min(100, Math.max(0, soc ?? 0))}%` }}
                  />
                  <span
                    aria-hidden="true"
                    className="absolute top-0 bottom-0 w-0.5 bg-foreground/60"
                    style={{ left: `${Math.min(99, acChargeLimit ?? 80)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted font-mono tabular-nums truncate">
                    {batteryMinTempC !== null && batteryMaxTempC !== null
                      ? `${batteryMinTempC}–${batteryMaxTempC}°C`
                      : '800V Pack'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveOverlay('charging')}
                    className="text-xs font-semibold text-accent hover:underline cursor-pointer whitespace-nowrap"
                  >
                    Open
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* RIVIAN-STYLE SECONDARY ROWS BELOW THE 2 SQUARES */}
          <div className="rounded-3xl bg-surface border border-border shadow-surface divide-y divide-separator overflow-hidden">
            {/* Ambient Mood Lighting Row (Opens Overlay) */}
            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5">
              <button
                type="button"
                id="ambient-lighting-row-btn"
                onClick={() => setActiveOverlay('ambient')}
                className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl py-0.5"
              >
                <span
                  className="w-9 h-9 rounded-full border border-border flex items-center justify-center shrink-0 bg-surface-secondary"
                  style={{
                    boxShadow: ambientBrightness && ambientBrightness > 0 ? `0 0 10px ${activeColorHex}` : 'none'
                  }}
                >
                  <span
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: activeColorHex }}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-foreground">Ambient Lighting</div>
                  <div className="text-xs text-muted truncate">
                    {ambientColor ? ambientColor.replace(/^Color \d+:\s*/i, '') : 'Default'} ·{' '}
                    {ambientBrightness === null ? '--' : ambientBrightness === 0 ? 'Off' : `${ambientBrightness * 10}%`}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted shrink-0" />
              </button>

              <button
                type="button"
                id="ambient-light-power-toggle"
                onClick={() => {
                  const isCurrentlyOff = ambientBrightness === 0;
                  const nextLvl = isCurrentlyOff ? 7 : 0;
                  setAmbientBrightness(nextLvl);
                  const cmdLabel = nextLvl === 0 ? 'Off' : `Brightness Level ${nextLvl}`;
                  dispatchCommand('ambient_light_brightness', cmdLabel, nextLvl === 0 ? 'Ambient Light Turned OFF' : `Ambient Light: Level ${nextLvl}`);
                }}
                className={`px-3.5 min-h-[38px] rounded-xl text-xs font-bold transition-colors cursor-pointer border shrink-0 ${
                  ambientBrightness !== null && ambientBrightness > 0
                    ? 'bg-accent text-accent-foreground border-accent shadow-sm'
                    : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                }`}
              >
                {ambientBrightness !== null && ambientBrightness > 0 ? 'On' : 'Off'}
              </button>
            </div>

            {/* Closures & Tire Pressure Summary Row */}
            <button
              type="button"
              onClick={() => setHeroViewMode(prev => (prev === 'topdown' ? 'auto' : 'topdown'))}
              className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 text-left hover:bg-surface-secondary/50 transition-colors cursor-pointer"
            >
              <div className="min-w-0">
                <div className="text-sm font-bold text-foreground">Closures & Chassis</div>
                <div className="text-xs text-muted truncate font-mono tabular-nums">
                  {openClosureCount > 0 ? `${openClosureLabels.join(' · ')} open` : 'All doors & latches closed'}
                  {tpms.fl !== null ? ` · TPMS ${tpms.fl}/${tpms.fr}/${tpms.rl}/${tpms.rr} PSI` : ''}
                </div>
              </div>
              <span className="text-xs font-semibold text-accent whitespace-nowrap shrink-0">
                {effectiveHeroView === 'topdown' ? 'Hide Top-Down' : 'Top-Down View'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* RIVIAN-STYLE FULL OVERLAY MODAL FOR CLIMATE / CHARGING / AMBIENT */}
      <Modal
        isOpen={activeOverlay !== null}
        onOpenChange={open => {
          if (!open) setActiveOverlay(null);
        }}
      >
        <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
          <ModalContainer placement="center" scroll="inside" className="p-2 sm:p-6 justify-end sm:justify-center items-center">
            <ModalDialog className="relative w-full max-w-xl rounded-t-3xl sm:rounded-3xl border border-border bg-surface text-foreground shadow-overlay overflow-hidden my-0 sm:my-auto p-0 flex flex-col max-h-[88vh]">
              <ModalHeader className="px-5 py-4 pr-16 border-b border-separator bg-surface-secondary/60 flex flex-row items-center gap-3 shrink-0">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                      activeOverlay === 'charging'
                        ? isCharging
                          ? 'bg-success text-success-foreground border-success'
                          : 'bg-success-soft text-success border-success/30'
                        : activeOverlay === 'climate'
                          ? hvacPower === true
                            ? isCoolingBanner
                              ? 'bg-accent text-accent-foreground border-accent'
                              : 'bg-warning text-warning-foreground border-warning'
                            : 'bg-accent-soft text-accent border-accent/30'
                          : 'bg-accent-soft text-accent border-accent/30'
                    }`}
                  >
                    {activeOverlay === 'charging' ? (
                      <BatteryCharging className="w-5 h-5" />
                    ) : activeOverlay === 'climate' ? (
                      <Wind className="w-5 h-5" />
                    ) : (
                      <Sparkles className="w-5 h-5" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <ModalHeading className="text-base font-bold text-foreground truncate">
                      {activeOverlay === 'charging'
                        ? 'Energy & Charging'
                        : activeOverlay === 'climate'
                          ? 'Cabin Climate & Comfort'
                          : 'Ambient Mood Lighting'}
                    </ModalHeading>
                    <p className="text-xs text-muted truncate">
                      {activeOverlay === 'charging'
                        ? isCharging
                          ? `Active HV Grid Charge${chargeRateKw > 0 ? ` · +${chargeRateKw} kW` : ''}`
                          : '800V E-GMP Pack & 12V Aux'
                        : activeOverlay === 'climate'
                          ? `Outside ${displayAmbient} · ${hvacPower === true ? 'Climate Running' : 'Standby'}`
                          : ambientColor
                            ? ambientColor.replace(/^Color \d+:\s*/i, '')
                            : 'OEM Cabin Illumination'}
                    </p>
                  </div>
                </div>
              </ModalHeader>

              <button
                type="button"
                onClick={() => setActiveOverlay(null)}
                aria-label="Close overlay"
                className="absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-surface hover:bg-surface-tertiary border border-border flex items-center justify-center text-muted hover:text-foreground transition-colors cursor-pointer shrink-0 shadow-sm"
              >
                <X className="w-4 h-4" />
              </button>

              <ModalBody className="m-0 p-0 overflow-y-auto">
                {activeOverlay === 'charging' && (
                  <div id="energy-charging-card">
                    <div className="p-5 space-y-4">
              {/* Clean Hairline Telemetry Row */}
              <div className="grid grid-cols-4 gap-3 pb-3.5 border-b border-separator text-xs">
                <div>
                  <span className="text-muted block">HV State</span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground mt-0.5 block">
                    {soc !== null ? `${soc}%` : '--%'}
                  </span>
                </div>
                <div>
                  <span className="text-muted block">12V Aux</span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground mt-0.5 block">
                    {aux12V !== null ? `${aux12V.toFixed(1)}V` : '--V'}
                  </span>
                </div>
                <div>
                  <span className="text-muted block">Pack Temp</span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground mt-0.5 block">
                    {batteryMinTempC !== null && batteryMaxTempC !== null
                      ? `${batteryMinTempC}–${batteryMaxTempC}°C`
                      : '--°C'}
                  </span>
                </div>
                <div>
                  <span className="text-muted block">HV Bus</span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground mt-0.5 block">
                    {hvVoltage !== null
                      ? `${Math.round(hvVoltage)}V`
                      : cellDeltaMv !== null
                        ? `Δ${cellDeltaMv}mV`
                        : '--'}
                  </span>
                </div>
              </div>

              {/* Direct 1-Tap AC & DC Charge Limit Selectors (Replaces 5-click cycling) */}
              <div className="space-y-3 text-xs">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-muted">AC Charge Limit</span>
                    <span className="font-mono tabular-nums font-bold text-foreground">
                      {acChargeLimit !== null ? `${acChargeLimit}%` : '80%'}
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 p-1 rounded-xl bg-surface-secondary border border-border">
                    {chargeLimitPresets.map(pct => {
                      const active = (acChargeLimit ?? 80) === pct;
                      return (
                        <button
                          key={`ac-${pct}`}
                          type="button"
                          id={pct === 80 ? 'cycle-ac-limit-btn' : `ac-limit-${pct}`}
                          onClick={() => setDirectAcLimit(pct)}
                          className={`py-2 rounded-lg font-mono tabular-nums font-semibold transition-colors cursor-pointer ${
                            active
                              ? 'bg-success text-success-foreground shadow-sm'
                              : 'text-muted hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          {pct}%
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-muted">DC Fast Charge Limit</span>
                    <span className="font-mono tabular-nums font-bold text-foreground">
                      {dcChargeLimit !== null ? `${dcChargeLimit}%` : '80%'}
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 p-1 rounded-xl bg-surface-secondary border border-border">
                    {chargeLimitPresets.map(pct => {
                      const active = (dcChargeLimit ?? 80) === pct;
                      return (
                        <button
                          key={`dc-${pct}`}
                          type="button"
                          id={pct === 80 ? 'cycle-dc-limit-btn' : `dc-limit-${pct}`}
                          onClick={() => setDirectDcLimit(pct)}
                          className={`py-2 rounded-lg font-mono tabular-nums font-semibold transition-colors cursor-pointer ${
                            active
                              ? 'bg-accent text-accent-foreground shadow-sm'
                              : 'text-muted hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          {pct}%
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
                  </div>
                )}

                {activeOverlay === 'climate' && (
                  <div id="cabin-climate-card">
                    <div className="px-5 pt-4 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        id="cabin-outdoor-temp-btn"
                        onClick={cycleAmbientTempPreview}
                        title="Outdoor Ambient Temperature (Click in bench mode to preview)"
                        className="text-xs font-mono tabular-nums text-muted hover:text-foreground transition-colors cursor-pointer text-left"
                      >
                        Outside {displayAmbient}
                      </button>
                      <button
                        type="button"
                        onClick={executeRemoteClimateToggle}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                          hvacPower === true
                            ? 'bg-warning-soft text-warning border-warning/50'
                            : 'bg-surface-secondary text-foreground border-border hover:bg-surface-tertiary'
                        }`}
                      >
                        {hvacPower === true ? 'Turn Climate Off' : 'Start Remote Climate'}
                      </button>
                    </div>

                    <div className="p-5 space-y-4">
              {/* Unified or Split Temperature Dial + Quick Presets */}
              {isSyncedMode ? (
                <div className="p-3.5 rounded-2xl bg-surface-secondary border border-border space-y-3">
                  <div className="flex items-center justify-center gap-4">
                    <button
                      type="button"
                      id="driver-temp-down"
                      onClick={() => adjustTemp(true, -1)}
                      aria-label="Decrease cabin temperature"
                      className="w-10 h-10 rounded-full bg-surface hover:bg-surface-tertiary text-foreground border border-border flex items-center justify-center transition-colors cursor-pointer shrink-0"
                    >
                      <Minus className="w-4 h-4" />
                    </button>

                    <div className="text-center min-w-[116px]">
                      <span className="text-[11px] font-medium text-muted block">Cabin Target (Synced)</span>
                      <span className="text-3xl font-bold font-mono tabular-nums text-foreground tracking-tight leading-tight">
                        {driverTemp !== null ? `${driverTemp}°${tempUnit}` : '--'}
                      </span>
                    </div>

                    <button
                      type="button"
                      id="driver-temp-up"
                      onClick={() => adjustTemp(true, 1)}
                      aria-label="Increase cabin temperature"
                      className="w-10 h-10 rounded-full bg-surface hover:bg-surface-tertiary text-foreground border border-border flex items-center justify-center transition-colors cursor-pointer shrink-0"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  {/* 1-Tap Temperature Quick Presets */}
                  <div className="grid grid-cols-4 gap-1.5 text-xs">
                    {tempPresets.map(tVal => {
                      const active = driverTemp === tVal;
                      return (
                        <button
                          key={tVal}
                          type="button"
                          onClick={() => setPresetTemp(tVal)}
                          className={`py-1.5 rounded-lg font-mono tabular-nums font-semibold border transition-colors cursor-pointer ${
                            active
                              ? 'bg-accent text-accent-foreground border-accent shadow-sm'
                              : 'bg-surface text-muted border-border hover:text-foreground'
                          }`}
                        >
                          {tVal}°{tempUnit}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-2xl bg-surface-secondary border border-border flex flex-col items-center">
                    <span className="text-[11px] text-muted font-semibold mb-1.5">Driver</span>
                    <div className="flex items-center justify-center gap-2.5">
                      <button
                        type="button"
                        id="driver-temp-down"
                        aria-label="Decrease driver temperature"
                        onClick={() => adjustTemp(true, -1)}
                        className="w-9 h-9 rounded-full bg-surface hover:bg-surface-tertiary text-foreground border border-border flex items-center justify-center transition-colors cursor-pointer shrink-0"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-2xl font-bold font-mono tabular-nums text-foreground tracking-tight min-w-[68px] text-center">
                        {driverTemp !== null ? `${driverTemp}°${tempUnit}` : '--'}
                      </span>
                      <button
                        type="button"
                        id="driver-temp-up"
                        aria-label="Increase driver temperature"
                        onClick={() => adjustTemp(true, 1)}
                        className="w-9 h-9 rounded-full bg-surface hover:bg-surface-tertiary text-foreground border border-border flex items-center justify-center transition-colors cursor-pointer shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="p-3 rounded-2xl bg-surface-secondary border border-border flex flex-col items-center">
                    <span className="text-[11px] text-muted font-semibold mb-1.5">Passenger</span>
                    <div className="flex items-center justify-center gap-2.5">
                      <button
                        type="button"
                        id="pass-temp-down"
                        aria-label="Decrease passenger temperature"
                        onClick={() => adjustTemp(false, -1)}
                        className="w-9 h-9 rounded-full bg-surface hover:bg-surface-tertiary text-foreground border border-border flex items-center justify-center transition-colors cursor-pointer shrink-0"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-2xl font-bold font-mono tabular-nums text-foreground tracking-tight min-w-[68px] text-center">
                        {passengerTemp !== null ? `${passengerTemp}°${tempUnit}` : '--'}
                      </span>
                      <button
                        type="button"
                        id="pass-temp-up"
                        aria-label="Increase passenger temperature"
                        onClick={() => adjustTemp(false, 1)}
                        className="w-9 h-9 rounded-full bg-surface hover:bg-surface-tertiary text-foreground border border-border flex items-center justify-center transition-colors cursor-pointer shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Zone & Sub-Tab Controls */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  id="driver-only-toggle-btn"
                  onClick={() => {
                    const next = !(driverOnly === true);
                    setDriverOnly(next);
                    dispatchCommand(
                      'climate_driver_only_toggle',
                      next ? 'Driver Only On' : 'Driver Only Off',
                      next ? 'Driver-Only Climate Activated' : 'Driver-Only Climate Inactive'
                    );
                  }}
                  className={`px-3 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center justify-center gap-1.5 cursor-pointer border ${
                    driverOnly === true
                      ? 'bg-accent-soft text-accent-soft-foreground border-accent/50 shadow-sm'
                      : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                  }`}
                >
                  <User className={`w-3.5 h-3.5 shrink-0 ${driverOnly === true ? 'text-accent' : 'text-muted'}`} />
                  <span>Driver Only</span>
                </button>

                <button
                  type="button"
                  id="climate-sync-toggle-btn"
                  onClick={() => {
                    const next = !isSyncedMode;
                    setClimateSync(next);
                    if (next && driverTemp !== null) {
                      setPassengerTemp(driverTemp);
                      passengerTempFRef.current = driverTempFRef.current;
                    }
                    dispatchCommand(
                      'climate_sync_toggle',
                      next ? 'Sync Passenger to Driver' : 'Dual Split / Sync Off',
                      next ? 'Dual Climate Synced' : 'Dual Climate Split'
                    );
                  }}
                  className={`px-3 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center justify-center gap-1.5 cursor-pointer border ${
                    isSyncedMode
                      ? 'bg-accent-soft text-accent-soft-foreground border-accent/50 shadow-sm'
                      : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                  }`}
                >
                  <Link2 className={`w-3.5 h-3.5 shrink-0 ${isSyncedMode ? 'text-accent' : 'text-muted'}`} />
                  <span>{isSyncedMode ? 'Zones Synced' : 'Split Zones'}</span>
                </button>
              </div>

              {/* Clean Segmented Switch: Comfort vs Fan & Vents (Reduces visual overload) */}
              <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-surface-secondary border border-border text-xs">
                <button
                  type="button"
                  onClick={() => setClimateTab('comfort')}
                  className={`py-2 px-3 rounded-lg font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    climateTab === 'comfort'
                      ? 'bg-surface text-foreground shadow-sm border border-border/60'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  Comfort & Seats
                </button>
                <button
                  type="button"
                  onClick={() => setClimateTab('vents')}
                  className={`py-2 px-3 rounded-lg font-semibold transition-colors cursor-pointer whitespace-nowrap flex items-center justify-center gap-1.5 ${
                    climateTab === 'vents'
                      ? 'bg-surface text-foreground shadow-sm border border-border/60'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Fan & Vents</span>
                </button>
              </div>

              {climateTab === 'comfort' ? (
                <div className="space-y-4">
                  {/* Heat / A/C Toggles */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      id="hvac-heat-toggle"
                      onClick={() => {
                        const next = !(heatActive === true);
                        setHeatActive(next);
                        dispatchCommand(
                          'climate_heat_toggle',
                          next ? 'Heat On' : 'Heat Off',
                          next ? 'Cabin Heat Activated' : 'Cabin Heat Turned Off'
                        );
                      }}
                      aria-pressed={heatActive === true}
                      className={`h-12 px-3 rounded-xl border font-bold tracking-wide transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                        heatActive === true
                          ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <Flame className={`w-4 h-4 ${heatActive === true ? 'text-warning' : 'text-muted'}`} />
                      <span>Heat</span>
                    </button>

                    <button
                      type="button"
                      id="hvac-ac-toggle"
                      onClick={() => {
                        const next = !(acActive === true);
                        setAcActive(next);
                        dispatchCommand(
                          'climate_ac_toggle',
                          next ? 'A/C On' : 'A/C Off',
                          next ? 'Cabin A/C Activated' : 'Cabin A/C Turned Off'
                        );
                      }}
                      aria-pressed={acActive === true}
                      className={`h-12 px-3 rounded-xl border font-bold tracking-wide transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                        acActive === true
                          ? 'bg-accent-soft text-accent border-accent/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <Snowflake className={`w-4 h-4 ${acActive === true ? 'text-accent' : 'text-muted'}`} />
                      <span>A/C</span>
                    </button>
                  </div>

                  {/* Driver & Passenger Seat Comfort with Explicit Labels */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between px-0.5">
                        <span className="font-semibold text-foreground">Driver Seat</span>
                        <span className="text-[11px] text-muted">{seatLevelLabel(driverSeat)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          id="driver-seat-heat-btn"
                          onClick={() => cycleSeatHeat(driverSeat, true)}
                          title="Driver Seat Heating (Off/Low/Med/High)"
                          className={`flex-1 h-12 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                            getSeatHeatLevel(driverSeat) > 0
                              ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                              : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          <Flame className={`w-4 h-4 ${getSeatHeatLevel(driverSeat) > 0 ? 'text-warning' : 'text-muted'}`} />
                          <div className="flex gap-1">
                            {[1, 2, 3].map(i => (
                              <span
                                key={i}
                                className={`w-2 h-1 rounded-full ${
                                  i <= getSeatHeatLevel(driverSeat) ? 'bg-warning' : 'bg-surface-tertiary border border-border'
                                }`}
                              />
                            ))}
                          </div>
                        </button>

                        <button
                          type="button"
                          id="driver-seat-cool-btn"
                          onClick={() => cycleSeatCool(driverSeat, true)}
                          title="Driver Seat Ventilation (Off/Low/Med/High)"
                          className={`flex-1 h-12 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                            getSeatCoolLevel(driverSeat) > 0
                              ? 'bg-accent-soft text-accent border-accent/50 shadow-sm'
                              : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          <Snowflake className={`w-4 h-4 ${getSeatCoolLevel(driverSeat) > 0 ? 'text-accent' : 'text-muted'}`} />
                          <div className="flex gap-1">
                            {[1, 2, 3].map(i => (
                              <span
                                key={i}
                                className={`w-2 h-1 rounded-full ${
                                  i <= getSeatCoolLevel(driverSeat) ? 'bg-accent' : 'bg-surface-tertiary border border-border'
                                }`}
                              />
                            ))}
                          </div>
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between px-0.5">
                        <span className="font-semibold text-foreground">Pass. Seat</span>
                        <span className="text-[11px] text-muted">{seatLevelLabel(passengerSeat)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          id="pass-seat-heat-btn"
                          onClick={() => cycleSeatHeat(passengerSeat, false)}
                          title="Passenger Seat Heating (Off/Low/Med/High)"
                          className={`flex-1 h-12 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                            getSeatHeatLevel(passengerSeat) > 0
                              ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                              : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          <Flame className={`w-4 h-4 ${getSeatHeatLevel(passengerSeat) > 0 ? 'text-warning' : 'text-muted'}`} />
                          <div className="flex gap-1">
                            {[1, 2, 3].map(i => (
                              <span
                                key={i}
                                className={`w-2 h-1 rounded-full ${
                                  i <= getSeatHeatLevel(passengerSeat) ? 'bg-warning' : 'bg-surface-tertiary border border-border'
                                }`}
                              />
                            ))}
                          </div>
                        </button>

                        <button
                          type="button"
                          id="pass-seat-cool-btn"
                          onClick={() => cycleSeatCool(passengerSeat, false)}
                          title="Passenger Seat Ventilation (Off/Low/Med/High)"
                          className={`flex-1 h-12 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                            getSeatCoolLevel(passengerSeat) > 0
                              ? 'bg-accent-soft text-accent border-accent/50 shadow-sm'
                              : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          <Snowflake className={`w-4 h-4 ${getSeatCoolLevel(passengerSeat) > 0 ? 'text-accent' : 'text-muted'}`} />
                          <div className="flex gap-1">
                            {[1, 2, 3].map(i => (
                              <span
                                key={i}
                                className={`w-2 h-1 rounded-full ${
                                  i <= getSeatCoolLevel(passengerSeat) ? 'bg-accent' : 'bg-surface-tertiary border border-border'
                                }`}
                              />
                            ))}
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Quick Comfort Toggles: Heated Wheel, Rear Defrost, Front Defrost */}
                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-separator text-xs">
                    <button
                      type="button"
                      id="steering-wheel-heat-btn"
                      aria-pressed={Boolean(steeringWheelHeat && steeringWheelHeat !== 'off')}
                      onClick={cycleSteeringHeat}
                      className={`min-h-[62px] py-2 px-1 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                        steeringWheelHeat && steeringWheelHeat !== 'off'
                          ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <HeatedWheelIcon className="w-auto max-w-full h-[30px]" />
                      <span className="text-[11px] font-medium whitespace-nowrap">Wheel</span>
                    </button>

                    <button
                      type="button"
                      id="rear-defrost-btn"
                      aria-pressed={rearDefrost === true}
                      onClick={() => {
                        const next = rearDefrost === true ? false : true;
                        setRearDefrost(next);
                        dispatchCommand(
                          'climate_rear_defrost',
                          next ? 'Defroster & Mirrors On' : 'Defroster & Mirrors Off',
                          next ? 'Rear Defrost Activated' : 'Rear Defrost Deactivated'
                        );
                      }}
                      className={`min-h-[62px] py-2 px-1 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                        rearDefrost === true
                          ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <RearDefrostIcon className="w-auto max-w-full h-[30px]" />
                      <span className="text-[11px] font-medium whitespace-nowrap">Rear Defrost</span>
                    </button>

                    <button
                      type="button"
                      id="front-defrost-btn"
                      aria-pressed={frontDefrost === true}
                      onClick={() => {
                        const nextF = frontDefrost === true ? false : true;
                        runPreviewOrReadOnly('Front Defrost', () => {
                          setFrontDefrost(nextF);
                          triggerNotice(nextF ? 'Front Defrost MAX Preview' : 'Front Defrost Off (Preview)');
                        });
                      }}
                      className={`min-h-[62px] py-2 px-1 rounded-xl border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                        frontDefrost === true
                          ? 'bg-warning-soft text-warning border-warning/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <FrontDefrostIcon className="w-auto max-w-full h-[30px]" />
                      <span className="text-[11px] font-medium whitespace-nowrap">Front Defrost</span>
                    </button>
                  </div>

                  {/* Rear Heated Seats Comfort */}
                  <div className="grid grid-cols-2 gap-2 pt-3 border-t border-separator text-xs">
                    <button
                      type="button"
                      id="rear-left-seat-comfort-btn"
                      onClick={() => cycleRearSeat(true)}
                      className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                        rearLeftSeat?.startsWith('heat')
                          ? 'bg-warning-soft text-warning-soft-foreground border-warning/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <span className="text-[11px] block font-medium">Rear Left Seat</span>
                      <span className="font-bold font-mono text-foreground mt-0.5 block">
                        {rearLeftSeat === null ? 'Off' : seatLevelLabel(rearLeftSeat)}
                      </span>
                    </button>

                    <button
                      type="button"
                      id="rear-right-seat-comfort-btn"
                      onClick={() => cycleRearSeat(false)}
                      className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                        rearRightSeat?.startsWith('heat')
                          ? 'bg-warning-soft text-warning-soft-foreground border-warning/50 shadow-sm'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <span className="text-[11px] block font-medium">Rear Right Seat</span>
                      <span className="font-bold font-mono text-foreground mt-0.5 block">
                        {rearRightSeat === null ? 'Off' : seatLevelLabel(rearRightSeat)}
                      </span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Blower Fan Speed Stepper */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-muted flex items-center gap-1.5">
                        <Fan
                          className={`w-3.5 h-3.5 ${fanSpeed !== null && fanSpeed > 0 && hvacPower ? 'text-accent animate-spin' : 'text-muted'}`}
                          style={{ animationDuration: `${Math.max(0.4, 2.5 - (fanSpeed || 0) * 0.25)}s` }}
                        />
                        <span>Fan Speed</span>
                      </span>
                      <span className="font-mono tabular-nums font-bold text-foreground">
                        {fanSpeed === null ? '--' : fanSpeed === 0 ? 'Off' : `Level ${fanSpeed}`}
                      </span>
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
                          className={`h-9 rounded-lg text-xs font-mono tabular-nums font-bold transition-colors cursor-pointer ${
                            fanSpeed !== null && fanSpeed >= step
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
                      setAirflow(mode);
                      const cmdLabel = AIRFLOW_MODE_COMMAND_LABELS[mode] || 'Auto';
                      dispatchCommand(
                        'climate_airflow_direction',
                        cmdLabel,
                        `Airflow: ${AIRFLOW_MODE_LABELS[mode]}`
                      );
                    }}
                    aria-label="Airflow Direction Modes"
                    className="w-full"
                  >
                    <Tabs.ListContainer className="p-1 rounded-xl bg-default border border-border text-xs w-full">
                      <Tabs.List className="!grid grid-cols-5 gap-1 !w-full !min-w-0 !p-0">
                        {(['auto', 'face', 'face_feet', 'feet', 'defrost'] as AirflowMode[]).map(mode => {
                          const label = AIRFLOW_MODE_LABELS[mode];
                          const shortLabel = mode === 'face_feet' ? 'Mix' : mode === 'feet' ? 'Floor' : mode.charAt(0).toUpperCase() + mode.slice(1);
                          const isSelected = (airflow || 'auto') === mode;
                          const activeColorClass = heatActive === true ? 'text-warning' : 'text-accent';
                          const indicatorClass = heatActive === true ? 'bg-warning-soft border-warning/50' : 'bg-accent-soft border-accent/50';
                          return (
                            <Tabs.Tab
                              key={mode}
                              id={mode}
                              data-testid={`airflow-btn-${mode}`}
                              aria-label={`Airflow: ${label}`}
                              className={`relative !min-w-0 w-full px-0.5 py-1.5 min-h-[58px] rounded-lg transition-colors cursor-pointer text-center flex flex-col items-center justify-center gap-0.5 ${
                                isSelected ? activeColorClass : 'text-muted hover:text-foreground'
                              }`}
                            >
                              <span title={label} className="relative z-10 w-full flex items-center justify-center">
                                <AirflowDirectionIcon mode={mode} className="w-[44px] max-w-full h-[32px]" />
                              </span>
                              <span className="relative z-10 text-[10px] font-semibold leading-none">{shortLabel}</span>
                              <Tabs.Indicator className={`rounded-lg border ${indicatorClass} shadow-sm`} />
                            </Tabs.Tab>
                          );
                        })}
                      </Tabs.List>
                    </Tabs.ListContainer>
                  </Tabs>
                </div>
              )}
                    </div>
                  </div>
                )}

                {activeOverlay === 'ambient' && (
                  <div id="ambient-lighting-card" className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {ambientColor && (
                          <span className="inline-flex items-center gap-2 text-xs text-muted">
                            <span
                              className="w-3 h-3 rounded-full ring-1 ring-border shrink-0"
                              style={{
                                backgroundColor: activeColorHex,
                                boxShadow: ambientBrightness && ambientBrightness > 0 ? `0 0 8px ${activeColorHex}` : 'none'
                              }}
                            />
                            <span className="font-semibold text-foreground">
                              {ambientColor.replace(/^Color \d+:\s*/i, '')}
                            </span>
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          const isCurrentlyOff = ambientBrightness === 0;
                          const nextLvl = isCurrentlyOff ? 7 : 0;
                          setAmbientBrightness(nextLvl);
                          const cmdLabel = nextLvl === 0 ? 'Off' : `Brightness Level ${nextLvl}`;
                          dispatchCommand('ambient_light_brightness', cmdLabel, nextLvl === 0 ? 'Ambient Light Turned OFF' : `Ambient Light: Level ${nextLvl}`);
                        }}
                        className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer border ${
                          ambientBrightness !== null && ambientBrightness > 0
                            ? 'bg-accent text-accent-foreground border-accent shadow-sm'
                            : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                        }`}
                      >
                        {ambientBrightness !== null && ambientBrightness > 0 ? 'Turn Off' : 'Turn On'}
                      </button>
                    </div>

            {/* Smooth Brightness Slider + Steppers (Replaces 11 cramped boxes) */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="text-muted flex items-center gap-1.5">
                  <Sun className="w-3.5 h-3.5 text-muted" />
                  <span>Brightness</span>
                </span>
                <span className="font-mono tabular-nums font-bold text-foreground">
                  {ambientBrightness === null ? '--' : ambientBrightness === 0 ? 'Off' : `${ambientBrightness * 10}%`}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  aria-label="Decrease ambient brightness"
                  onClick={() => {
                    const next = Math.max(0, (ambientBrightness ?? 7) - 1);
                    setAmbientBrightness(next);
                    const cmdLabel = next === 0 ? 'Off' : `Brightness Level ${next}`;
                    dispatchCommand('ambient_light_brightness', cmdLabel, next === 0 ? 'Ambient Light Turned OFF' : `Ambient Light: Level ${next}`);
                  }}
                  className="w-9 h-9 rounded-xl bg-surface-secondary hover:bg-surface-tertiary border border-border flex items-center justify-center text-foreground cursor-pointer shrink-0"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  aria-label="Ambient lighting brightness level"
                  value={ambientBrightness ?? 7}
                  onChange={e => {
                    const step = parseInt(e.target.value, 10);
                    setAmbientBrightness(step);
                    const cmdLabel = step === 0 ? 'Off' : step === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${step}`;
                    dispatchCommand('ambient_light_brightness', cmdLabel, step === 0 ? 'Ambient Light Turned OFF' : `Ambient Light: Level ${step}`);
                  }}
                  className="w-full h-2 accent-current cursor-pointer"
                  style={{ accentColor: activeColorHex }}
                />
                <button
                  type="button"
                  aria-label="Increase ambient brightness"
                  onClick={() => {
                    const next = Math.min(10, (ambientBrightness ?? 7) + 1);
                    setAmbientBrightness(next);
                    const cmdLabel = next === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${next}`;
                    dispatchCommand('ambient_light_brightness', cmdLabel, `Ambient Light: Level ${next}`);
                  }}
                  className="w-9 h-9 rounded-xl bg-surface-secondary hover:bg-surface-tertiary border border-border flex items-center justify-center text-foreground cursor-pointer shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Popular Colors */}
            <div className="space-y-1.5 pt-2 border-t border-separator">
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="font-semibold">Quick Colors</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {AMBIENT_QUICK_COLORS.map(c => {
                  const isSelected = ambientColor === c.label;
                  return (
                    <button
                      key={c.label}
                      type="button"
                      id={`ambient-quick-${c.name.toLowerCase().replace(/\s+/g, '-')}`}
                      onClick={() => {
                        setAmbientColor(c.label);
                        if (ambientBrightness === 0) setAmbientBrightness(7);
                        dispatchCommand('ambient_light_colors', c.label, `Color: ${c.name}`);
                      }}
                      title={`${c.name} (${c.label})`}
                      className={`group relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-accent-soft text-accent border-accent/60 shadow-sm font-bold'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full shadow-sm ring-1 ring-black/20"
                        style={{
                          backgroundColor: c.hex,
                          boxShadow: isSelected ? `0 0 8px ${c.hex}` : 'none'
                        }}
                      />
                      <span className="text-[11px]">{c.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Collapsible 64-Color OEM Palette */}
            <div className="pt-2 border-t border-separator">
              <button
                type="button"
                id="ambient-palette-toggle-btn"
                onClick={() => setAmbientPaletteExpanded(prev => !prev)}
                className="w-full flex items-center justify-between py-1.5 text-xs text-muted hover:text-foreground transition-colors cursor-pointer"
              >
                <span className="font-semibold text-[11px] flex items-center gap-1.5">
                  <Palette className="w-3.5 h-3.5 text-accent" />
                  <span>Full OEM Palette (64 Colors)</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] text-muted font-mono">
                  <span>{ambientPaletteExpanded ? 'Collapse' : 'Expand'}</span>
                  {ambientPaletteExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </span>
              </button>

              {ambientPaletteExpanded && (
                <div className="mt-2.5 p-2 rounded-xl bg-surface-secondary border border-border space-y-2">
                  <div className="grid grid-cols-8 gap-1.5 max-h-[190px] overflow-y-auto p-1 scrollbar-thin">
                    {AMBIENT_PALETTE_64.map(p => {
                      const isSelected = ambientColor === p.label;
                      return (
                        <Tooltip key={p.step}>
                          <Tooltip.Trigger>
                            <button
                              type="button"
                              id={`ambient-palette-step-${p.step}`}
                              onClick={() => {
                                setAmbientColor(p.label);
                                if (ambientBrightness === 0) setAmbientBrightness(7);
                                dispatchCommand('ambient_light_colors', p.label, `Color: ${p.name}`);
                              }}
                              className={`w-full aspect-square rounded-md transition-all cursor-pointer relative flex items-center justify-center border ${
                                isSelected
                                  ? 'ring-2 ring-accent scale-110 border-white z-10'
                                  : 'border-border/60 hover:scale-105 hover:border-foreground/40'
                              }`}
                              style={{
                                backgroundColor: p.hex,
                                boxShadow: isSelected ? `0 0 8px ${p.hex}` : 'none'
                              }}
                              aria-label={p.label}
                            />
                          </Tooltip.Trigger>
                          <Tooltip.Content className="px-2 py-1 text-[11px] rounded bg-overlay border border-border text-overlay-foreground shadow-overlay z-50">
                            {p.label}
                          </Tooltip.Content>
                        </Tooltip>
                      );
                    })}
                  </div>
                  <div className="flex justify-between items-center text-[10px] text-muted px-1 font-mono">
                    <span>1: Lime Mint</span>
                    <span>32: Pink</span>
                    <span>64: Warm White</span>
                  </div>
                </div>
              )}
                    </div>
                  </div>
                )}
              </ModalBody>

              <ModalFooter className="px-5 py-3.5 border-t border-separator bg-surface-secondary/40 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setActiveOverlay(null)}
                  className="px-5 py-2 rounded-xl bg-foreground text-background text-xs font-bold hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Done
                </button>
              </ModalFooter>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </div>
  );
};
