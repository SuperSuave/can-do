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
import { resolveDashboardCommandRequest } from '../utils/dashboardCommands';
import {
  decodeAirflowEntityState,
  decodeRearSeatEntityUpdate,
  decodeSeatLevel,
  decodeSunroofEntityState,
  getAmbientColorHex,
  isSameAmbientColor,
  OptimisticHoldTracker,
  AMBIENT_DYNAMIC_EFFECTS,
  AMBIENT_LIGHT_THEMES,
  AMBIENT_PALETTE_64,
  AMBIENT_QUICK_COLORS,
  isAmbientDynamicEffect,
  displayTempToFahrenheit,
  fahrenheitToDisplayTemp,
  formatOdometerFromKm,
  parseBooleanEntityState,
  parseChargingEntityState,
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
          const convertedDriver = fahrenheitToDisplayTemp(driverTempFRef.current, nextUnit);
          driverTempRef.current = convertedDriver;
          setDriverTemp(convertedDriver);
        } else {
          setDriverTemp(prev => {
            if (prev === null) return null;
            const f = displayTempToFahrenheit(prev, nextUnit === 'C' ? 'F' : 'C');
            const converted = fahrenheitToDisplayTemp(f, nextUnit);
            driverTempRef.current = converted;
            return converted;
          });
        }
        if (passengerTempFRef.current !== null) {
          const convertedPassenger = fahrenheitToDisplayTemp(passengerTempFRef.current, nextUnit);
          passengerTempRef.current = convertedPassenger;
          setPassengerTemp(convertedPassenger);
        } else {
          setPassengerTemp(prev => {
            if (prev === null) return null;
            const f = displayTempToFahrenheit(prev, nextUnit === 'C' ? 'F' : 'C');
            const converted = fahrenheitToDisplayTemp(f, nextUnit);
            passengerTempRef.current = converted;
            return converted;
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

  // Optimistic command hold tracker + synchronous refs so rapid taps & periodic CAN frames never clash
  const optimisticHoldRef = useRef(new OptimisticHoldTracker());
  const syncHold = (key: string, expectedValue: string, ttlMs = 1800) => {
    optimisticHoldRef.current.setHold(key, expectedValue, ttlMs);
  };
  const acceptTelemetry = (key: string, incomingValue: string): boolean => {
    return optimisticHoldRef.current.shouldAccept(key, incomingValue);
  };

  const driverSeatRef = useRef<SeatLevel | null>(null);
  const passengerSeatRef = useRef<SeatLevel | null>(null);
  const rearLeftSeatRef = useRef<SeatLevel | null>(null);
  const rearRightSeatRef = useRef<SeatLevel | null>(null);
  const steeringWheelHeatRef = useRef<SteeringHeatLevel | null>(null);
  const lockedRef = useRef<boolean>(true);
  const trunkOpenRef = useRef<boolean>(false);
  const chargePortOpenRef = useRef<boolean>(false);
  const driverOnlyRef = useRef<boolean | null>(null);
  const heatActiveRef = useRef<boolean | null>(null);
  const acActiveRef = useRef<boolean | null>(null);
  const rearDefrostRef = useRef<boolean | null>(null);
  const climateSyncRef = useRef<boolean | null>(null);
  const hvacPowerRef = useRef<boolean | null>(null);
  const driverTempRef = useRef<number | null>(null);
  const passengerTempRef = useRef<number | null>(null);
  const airflowRef = useRef<AirflowMode | null>(null);
  const acChargeLimitRef = useRef<number | null>(null);
  const dcChargeLimitRef = useRef<number | null>(null);

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
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      Object.values(commandTimersRef.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  const executeRemoteClimateToggle = () => {
    const next = hvacPowerRef.current === true ? false : true;
    hvacPowerRef.current = next;
    setHvacPower(next);
    syncHold('remote_climate', String(next));
    if (next && driverTempRef.current === null) {
      const def = tempUnit === 'C' ? 22 : 72;
      driverTempRef.current = def;
      passengerTempRef.current = def;
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
      0,
      'remote_climate'
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
  const ambientColorRef = useRef<string | null>(ambientColor);
  ambientColorRef.current = ambientColor;
  const lastStaticAmbientColorRef = useRef<string>(
    ambientColor && !isAmbientDynamicEffect(ambientColor)
      ? ambientColor
      : 'Color 24: Deep Purple / Violet'
  );
  const ambientBrightnessRef = useRef<number | null>(ambientBrightness);
  const prevAmbientBrightnessRef = useRef<number>(
    ambientBrightness !== null && ambientBrightness > 0 ? ambientBrightness : 7
  );

  useEffect(() => {
    if (externalAmbientColor !== undefined && externalAmbientColor !== null && externalAmbientColor !== ambientColor) {
      if (!acceptTelemetry('ambient_light_colors', externalAmbientColor.trim().toLowerCase())) {
        return;
      }
      ambientColorRef.current = externalAmbientColor;
      if (!isAmbientDynamicEffect(externalAmbientColor)) {
        lastStaticAmbientColorRef.current = externalAmbientColor;
      }
      setAmbientColorState(externalAmbientColor);
    }
  }, [externalAmbientColor]);

  useEffect(() => {
    if (externalAmbientBrightness !== undefined && externalAmbientBrightness !== null && externalAmbientBrightness !== ambientBrightness) {
      if (!acceptTelemetry('ambient_light_brightness', String(externalAmbientBrightness))) {
        return;
      }
      ambientBrightnessRef.current = externalAmbientBrightness;
      if (externalAmbientBrightness > 0) {
        prevAmbientBrightnessRef.current = externalAmbientBrightness;
      }
      setAmbientBrightnessState(externalAmbientBrightness);
    }
  }, [externalAmbientBrightness]);

  const setAmbientColor = (nextColor: string | null) => {
    ambientColorRef.current = nextColor;
    if (nextColor && !isAmbientDynamicEffect(nextColor)) {
      lastStaticAmbientColorRef.current = nextColor;
    }
    setAmbientColorState(nextColor);
    if (nextColor) {
      try { localStorage.setItem('cando_ambient_color', nextColor); } catch {}
      onAmbientColorChange?.(nextColor);
    }
  };

  const setAmbientBrightness = (nextBrightness: number | null) => {
    ambientBrightnessRef.current = nextBrightness;
    if (nextBrightness !== null && nextBrightness > 0) {
      prevAmbientBrightnessRef.current = nextBrightness;
    }
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
  const [connectedDevice, setConnectedDevice] = useState<boolean>(() => deviceWs.getConnected());
  const [feedbackNotice, setFeedbackNotice] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const appliedDemoRef = useRef<boolean>(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const activeVehicleRef = useRef(activeVehicle);
  activeVehicleRef.current = activeVehicle;
  const connectedDeviceRef = useRef(connectedDevice);
  connectedDeviceRef.current = connectedDevice;

  useEffect(() => {
    if (isRunningOnDevice()) {
      try {
        const currentHost = localStorage.getItem('cando_device_host');
        if (currentHost !== 'auto') {
          localStorage.setItem('cando_device_host', 'auto');
          deviceWs.reconnect();
        }
      } catch {}
    }
  }, []);

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

  // Resolve dynamic ambient light effects from active catalog definitions
  const ambientLightEffects = useMemo(() => {
    const list = (catalog?.commands || (catalog as any)?.features || []) as Command[];
    return list.find(c => c.id === 'ambient_light_colors')?.effects || AMBIENT_DYNAMIC_EFFECTS;
  }, [catalog]);

  // Temporary feedback toast
  const triggerNotice = (msg: string, type: 'success' | 'error' = 'success') => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    setFeedbackNotice({ msg, type });
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setFeedbackNotice(null);
    }, type === 'error' ? 4000 : 2800);
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
    acChargeLimitRef.current = next;
    setAcChargeLimit(next);
    syncHold('ac_charging_limit', String(next));
    dispatchCommand('ac_charging_limit', `${next}%`, `AC Charge Limit: ${next}%`);
  };

  const setDirectDcLimit = (next: number) => {
    dcChargeLimitRef.current = next;
    setDcChargeLimit(next);
    syncHold('dc_charging_limit', String(next));
    dispatchCommand('dc_charging_limit', `${next}%`, `DC Fast Charge Limit: ${next}%`);
  };

  const handleToggleChargePort = () => {
    const next = !chargePortOpenRef.current;
    chargePortOpenRef.current = next;
    setChargePortOpen(next);
    syncHold('charge_port', String(next));
    dispatchCommand(
      'charge_port',
      next ? 'Opened / Open' : 'Closed / Shut',
      next ? 'Charge Port Opened' : 'Charge Port Closed'
    );
  };

  const handleToggleAmbientPower = () => {
    const isCurrentlyOff = ambientBrightnessRef.current === null || ambientBrightnessRef.current === 0;
    const nextLvl = isCurrentlyOff ? prevAmbientBrightnessRef.current : 0;
    if (nextLvl === 0 && isAmbientDynamicEffect(ambientColorRef.current)) {
      setAmbientColor(lastStaticAmbientColorRef.current);
    }
    setAmbientBrightness(nextLvl);
    syncHold('ambient_light_brightness', String(nextLvl));
    const cmdLabel = nextLvl === 0 ? 'Off' : nextLvl === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${nextLvl}`;
    dispatchCommand('ambient_light_brightness', cmdLabel, nextLvl === 0 ? 'Ambient Light Turned OFF' : `Ambient Light: Level ${nextLvl}`);
  };

  const cycleRearSeat = (isLeft: boolean) => {
    const current = isLeft ? rearLeftSeatRef.current : rearRightSeatRef.current;
    const cycle: SeatLevel[] = ['off', 'heat_low', 'heat_high'];
    const currentEffective = current || 'off';
    const nextIdx = (cycle.indexOf(currentEffective) + 1) % cycle.length;
    const next = cycle[nextIdx];
    const optionCmd = next === 'heat_high' ? 'High Heat' : next === 'heat_low' ? 'Low Heat' : 'Off';
    if (isLeft) {
      rearLeftSeatRef.current = next;
      setRearLeftSeat(next);
      syncHold('rear_left_seat_comfort', next);
      dispatchCommand('rear_left_seat_comfort', optionCmd, `Rear Left Seat: ${optionCmd}`);
    } else {
      rearRightSeatRef.current = next;
      setRearRightSeat(next);
      syncHold('rear_right_seat_comfort', next);
      dispatchCommand('rear_right_seat_comfort', optionCmd, `Rear Right Seat: ${optionCmd}`);
    }
  };

  // Hardware command dispatcher with per-entity debouncing (prevents slider/rapid-click HTTP flooding)
  const dispatchCommand = (entity: string, cmd: string, fallbackDesc: string, debounceMs = 150, holdKey?: string) => {
    const requestPayload = resolveDashboardCommandRequest(
      entity,
      cmd,
      catalogRef.current,
      activeVehicleRef.current
    );
    const activeHoldKey = holdKey || entity;
    optimisticHoldRef.current.extendHold(activeHoldKey, 1800);

    if (!connectedDeviceRef.current) {
      triggerNotice(fallbackDesc, 'success');
    }

    if (commandTimersRef.current[entity]) {
      clearTimeout(commandTimersRef.current[entity]);
      delete commandTimersRef.current[entity];
    }
    const send = async () => {
      delete commandTimersRef.current[entity];
      optimisticHoldRef.current.extendHold(activeHoldKey, 1800);
      try {
        const baseUrl = resolveDeviceBaseUrl(localStorage.getItem('cando_device_host'));
        const res = await fetch(`${baseUrl}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestPayload)
        });
        if (!res.ok) {
          optimisticHoldRef.current.clearHold(activeHoldKey);
          let errDetail = `HTTP ${res.status}`;
          try {
            const txt = await res.text();
            if (txt && txt.length < 120) errDetail = txt;
          } catch {}
          triggerNotice(`Command failed (${errDetail}): ${fallbackDesc}`, 'error');
          return;
        }
        triggerNotice(fallbackDesc, 'success');
      } catch {
        optimisticHoldRef.current.clearHold(activeHoldKey);
        if (connectedDeviceRef.current) {
          triggerNotice(`Device unreachable: ${fallbackDesc}`, 'error');
        }
      }
    };
    if (debounceMs > 0) {
      commandTimersRef.current[entity] = setTimeout(send, debounceMs);
    } else {
      send();
    }
  };

  // Parser for high-level catalog entity states (broadcast via WebSocket or fetched via /api/states)
  const handleIncomingEntityState = (entity: string, stateStr: string) => {
    const trimmed = stateStr.trim();
    const normState = trimmed.toLowerCase();
    if (!trimmed || normState === 'unknown' || trimmed === '--') {
      return;
    }
    if (!hasReceivedFrames) {
      setHasReceivedFrames(true);
    }
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
    } else if (entity === 'door_locks') {
      if (normState.includes('unlock') || normState.includes('lock')) {
        const nextLocked = normState.includes('lock') && !normState.includes('unlock');
        if (acceptTelemetry('door_locks', String(nextLocked))) {
          lockedRef.current = nextLocked;
          setLocked(nextLocked);
          if (autoFoldEnabledRef.current) {
            setMirrorsFolded(nextLocked);
          }
        }
      }
    } else if (entity === 'trunk' || entity === 'telematics_remote_tailgate' || entity === 'ptgm_tailgate_status') {
      if (normState.includes('open') || normState.includes('close')) {
        const nextOpen = normState.includes('open') && !normState.includes('close');
        if (acceptTelemetry('trunk', String(nextOpen))) {
          trunkOpenRef.current = nextOpen;
          setTrunkOpen(nextOpen);
        }
      }
    } else if (entity === 'hood') {
      if (normState.includes('open') || normState.includes('close')) {
        setHoodOpen(normState.includes('open') && !normState.includes('close'));
      }
    } else if (entity === 'charge_port') {
      if (normState.includes('open') || normState.includes('close')) {
        const nextOpen = normState.includes('open') && !normState.includes('close');
        if (acceptTelemetry('charge_port', String(nextOpen))) {
          chargePortOpenRef.current = nextOpen;
          setChargePortOpen(nextOpen);
        }
      }
    } else if (entity === 'vehicle_gear_state' || entity === 'gear_shifter_dial' || entity === 'selected_gear') {
      if (normState.includes('park') || normState === 'p' || normState.includes('(p)')) setGear('P');
      else if (normState.includes('reverse') || normState === 'r' || normState.includes('(r)')) setGear('R');
      else if (normState.includes('neutral') || normState === 'n' || normState.includes('(n)')) setGear('N');
      else if (normState.includes('drive') || normState === 'd' || normState.includes('(d)')) setGear('D');
    } else if (entity === 'cond_charging') {
      const charging = parseChargingEntityState(stateStr);
      setIsCharging(charging);
      if (!charging) setChargeRateKw(0);
    } else if (entity === 'ev_charging_power') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) {
        const kw = parseFloat(match[1]);
        if (kw >= 0 && kw <= 400) setChargeRateKw(kw);
      }
    } else if (entity === 'ac_charging_limit') {
      const match = stateStr.match(/(\d+)/);
      if (match) {
        const val = parseInt(match[1], 10);
        if (acceptTelemetry('ac_charging_limit', String(val))) {
          acChargeLimitRef.current = val;
          setAcChargeLimit(val);
        }
      }
    } else if (entity === 'dc_charging_limit') {
      const match = stateStr.match(/(\d+)/);
      if (match) {
        const val = parseInt(match[1], 10);
        if (acceptTelemetry('dc_charging_limit', String(val))) {
          dcChargeLimitRef.current = val;
          setDcChargeLimit(val);
        }
      }
    } else if (entity === 'drivers_seat_comfort') {
      const lvl = decodeSeatLevel(stateStr);
      if (acceptTelemetry('drivers_seat_comfort', lvl)) {
        driverSeatRef.current = lvl;
        setDriverSeat(lvl);
      }
    } else if (entity === 'passengers_seat_comfort') {
      const lvl = decodeSeatLevel(stateStr);
      if (acceptTelemetry('passengers_seat_comfort', lvl)) {
        passengerSeatRef.current = lvl;
        setPassengerSeat(lvl);
      }
    } else if (entity === 'rear_seats_comfort' || entity === 'rear_left_seat_comfort' || entity === 'rear_right_seat_comfort') {
      const rearUpdate = decodeRearSeatEntityUpdate(entity, stateStr);
      if (rearUpdate.left !== undefined && acceptTelemetry('rear_left_seat_comfort', rearUpdate.left)) {
        rearLeftSeatRef.current = rearUpdate.left;
        setRearLeftSeat(rearUpdate.left);
      }
      if (rearUpdate.right !== undefined && acceptTelemetry('rear_right_seat_comfort', rearUpdate.right)) {
        rearRightSeatRef.current = rearUpdate.right;
        setRearRightSeat(rearUpdate.right);
      }
    } else if (entity === 'climate_driver_temp') {
      const tempF = parseSingleCabinTempToF(stateStr);
      if (tempF !== null && acceptTelemetry('climate_driver_temp', String(tempF))) {
        driverTempFRef.current = tempF;
        const disp = fahrenheitToDisplayTemp(tempF, tempUnit);
        driverTempRef.current = disp;
        setDriverTemp(disp);
      }
    } else if (entity === 'climate_passenger_temp') {
      const tempF = parseSingleCabinTempToF(stateStr);
      if (tempF !== null && acceptTelemetry('climate_passenger_temp', String(tempF))) {
        passengerTempFRef.current = tempF;
        const disp = fahrenheitToDisplayTemp(tempF, tempUnit);
        passengerTempRef.current = disp;
        setPassengerTemp(disp);
      }
    } else if (entity === 'heated_steering_wheel_toggle' || entity === 'heated_wheel_btn') {
      const lvl: SteeringHeatLevel = parseBooleanEntityState(stateStr) ? 'on' : 'off';
      if (acceptTelemetry('heated_steering_wheel_toggle', lvl)) {
        steeringWheelHeatRef.current = lvl;
        setSteeringWheelHeat(lvl);
      }
    } else if (entity === 'hazard_lights') {
      setHazards(parseBooleanEntityState(stateStr));
    } else if (entity === 'cgw_welcome_mirror_light' || entity === 'power_mirrors' || entity === 'mirrors') {
      if (normState.includes('approach') || normState.includes('enable') || normState.includes('on') || normState.includes('disable') || normState.includes('off')) {
        const isEnabled =
          (normState.includes('approach') || normState.includes('enable') || normState.includes('on')) &&
          !normState.includes('disable') &&
          !normState.includes('off');
        setAutoFoldEnabled(isEnabled);
        autoFoldEnabledRef.current = isEnabled;
        if (isEnabled && lockedRef.current) {
          setMirrorsFolded(true);
        } else if (!lockedRef.current) {
          setMirrorsFolded(false);
        }
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
      const nextDef = parseBooleanEntityState(stateStr);
      if (acceptTelemetry('climate_rear_defrost', String(nextDef))) {
        rearDefrostRef.current = nextDef;
        setRearDefrost(nextDef);
      }
    } else if (entity === 'front_defrost') {
      setFrontDefrost(parseBooleanEntityState(stateStr));
    } else if (entity === 'climate_fan_speed_level' || entity === 'fan_speed') {
      const match = stateStr.match(/(\d+)/);
      if (match) setFanSpeed(parseInt(match[1], 10));
    } else if (entity === 'climate_airflow_direction' || entity === 'airflow_direction') {
      const decodedAf = decodeAirflowEntityState(stateStr);
      if (decodedAf && acceptTelemetry('climate_airflow_direction', decodedAf)) {
        airflowRef.current = decodedAf;
        setAirflow(decodedAf);
      }
    } else if (entity === 'climate_driver_only_toggle' || entity === 'driver_only') {
      const isDo = parseBooleanEntityState(stateStr);
      if (acceptTelemetry('climate_driver_only_toggle', String(isDo))) {
        driverOnlyRef.current = isDo;
        setDriverOnly(isDo);
      }
    } else if (entity === 'climate_heat_toggle' || entity === 'heat_toggle' || entity === 'cabin_heat') {
      const isHeat = parseBooleanEntityState(stateStr);
      if (acceptTelemetry('climate_heat_toggle', String(isHeat))) {
        heatActiveRef.current = isHeat;
        setHeatActive(isHeat);
      }
    } else if (entity === 'climate_ac_toggle' || entity === 'ac_toggle' || entity === 'cabin_ac') {
      const isAc = parseBooleanEntityState(stateStr);
      if (acceptTelemetry('climate_ac_toggle', String(isAc))) {
        acActiveRef.current = isAc;
        setAcActive(isAc);
      }
    } else if (entity === 'climate_recirc_on') {
      setRecirc(parseBooleanEntityState(stateStr));
    } else if (entity === 'climate_sync_toggle') {
      if (normState.includes('sync') || normState.includes('split') || normState.includes('on') || normState.includes('off')) {
        const isSynced = !normState.includes('off') && !normState.includes('split');
        if (acceptTelemetry('climate_sync_toggle', String(isSynced))) {
          climateSyncRef.current = isSynced;
          setClimateSync(isSynced);
        }
      }
    } else if (
      entity.includes('climate_start') ||
      entity === 'climate_power' ||
      entity === 'remote_climate_state' ||
      entity === 'remote_climate_tmu' ||
      entity === 'climate_fan_active'
    ) {
      const active = parseBooleanEntityState(stateStr);
      if (acceptTelemetry('remote_climate', String(active))) {
        hvacPowerRef.current = active;
        setHvacPower(active);
      }
    } else if (entity === 'outdoor_temperature' || entity === 'cond_ambient_temperature' || entity === 'ambient_temperature') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (val >= -40 && val <= 60) setAmbientTempC(val);
      }
    } else if (entity === 'tpms_tire_pressures' || entity === 'tpms') {
      const match = stateStr.match(/fl:\s*(\d+).*fr:\s*(\d+).*rl:\s*(\d+).*rr:\s*(\d+)/i);
      if (match) {
        setTpms({
          fl: parseInt(match[1], 10),
          fr: parseInt(match[2], 10),
          rl: parseInt(match[3], 10),
          rr: parseInt(match[4], 10),
        });
      }
    } else if (entity === 'cond_hv_battery_soc' || entity === 'bms_display_soc' || entity.includes('battery_soc')) {
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
    } else if (entity === 'bms_temp_min_c') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (val >= -40 && val <= 100) setBatteryMinTempC(val);
      }
    } else if (entity === 'bms_temp_max_c') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (val >= -40 && val <= 100) setBatteryMaxTempC(val);
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
    } else if (entity === 'bms_hv_power_kw' || entity === 'bms_hv_kw') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) setHvPowerKw(parseFloat(match[1]));
    } else if (entity === 'bms_hv_voltage' || entity === 'bms_hv_v') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) setHvVoltage(parseFloat(match[1]));
    } else if (entity === 'bms_hv_current' || entity === 'bms_hv_a') {
      const match = stateStr.match(/(-?\d+(\.\d+)?)/);
      if (match) setHvCurrent(parseFloat(match[1]));
    } else if (entity === 'bms_cell_delta_mv') {
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
      const matched =
        AMBIENT_DYNAMIC_EFFECTS.find(e => isSameAmbientColor(e.label, trimmed)) ||
        AMBIENT_LIGHT_THEMES.find(t => isSameAmbientColor(t.label, trimmed)) ||
        AMBIENT_PALETTE_64.find(p => isSameAmbientColor(p.label, trimmed));
      const canonical = matched ? matched.label : trimmed;
      if (acceptTelemetry('ambient_light_colors', canonical.toLowerCase())) {
        setAmbientColor(canonical);
      }
    } else if (entity === 'ambient_light_brightness') {
      const match = stateStr.match(/(\d+)/);
      const lvl = match ? Math.max(0, Math.min(10, parseInt(match[1], 10))) : normState.includes('off') ? 0 : null;
      if (lvl !== null && acceptTelemetry('ambient_light_brightness', String(lvl))) {
        setAmbientBrightness(lvl);
      }
    }
  };

  const handleIncomingEntityStateRef = useRef(handleIncomingEntityState);
  handleIncomingEntityStateRef.current = handleIncomingEntityState;
  const fetchCurrentStatesRef = useRef<() => Promise<void>>(async () => {});

  // 1. Initial State Synchronization & Fallback Polling via /api/states REST endpoint
  useEffect(() => {
    let cancelled = false;
    const fetchCurrentStates = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
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
    fetchCurrentStatesRef.current = fetchCurrentStates;
    fetchCurrentStates();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fallback 3-second REST poll only while WebSocket is disconnected/reconnecting
  useEffect(() => {
    if (connectedDevice) return;
    const syncInterval = setInterval(() => {
      if (!deviceWs.getConnected()) {
        fetchCurrentStatesRef.current();
      }
    }, 3000);
    return () => {
      clearInterval(syncInterval);
    };
  }, [connectedDevice]);

  // 2. Real-time WebSocket connection to physical CAN Do device via singleton
  useEffect(() => {
    const unsubscribeConn = deviceWs.onConnectionChange((conn) => {
      setConnectedDevice(conn);
      if (conn) {
        triggerNotice('Connected to live CAN Do vehicle telemetry stream');
        fetchCurrentStatesRef.current();
      }
    });

    const unsubscribeMsgs = deviceWs.subscribe((data) => {
      if (data.type === 'state' && (data as any).entity && (data as any).state) {
        handleIncomingEntityStateRef.current((data as any).entity, (data as any).state);
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

  // Turn signal hazard blinker timer
  const [blinkState, setBlinkState] = useState(false);
  useEffect(() => {
    if (hazards || turnSignal !== 'off') {
      const t = setInterval(() => setBlinkState(b => !b), 400);
      return () => clearInterval(t);
    }
    setBlinkState(false);
  }, [hazards, turnSignal]);

  // Seat toggle helper - uses live synchronous refs so rapid taps step cleanly without reverting
  const cycleSeat = (_current: SeatLevel | null, isDriver: boolean) => {
    const hasHeat = equippedFeatures.has('heated_seats');
    const hasCool = equippedFeatures.has('ventilated_seats');

    if (!hasHeat && !hasCool) {
      triggerNotice('Seat heating / ventilation is not equipped on this trim');
      return;
    }

    let cycle: SeatLevel[] = ['off'];
    if (hasHeat) cycle = cycle.concat(['heat_low', 'heat_med', 'heat_high']);
    if (hasCool) cycle = cycle.concat(['cool_low', 'cool_med', 'cool_high']);

    const liveCurrent = isDriver ? driverSeatRef.current : passengerSeatRef.current;
    const currentEffective = liveCurrent || 'off';
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
      driverSeatRef.current = next;
      setDriverSeat(next);
      syncHold('drivers_seat_comfort', next);
      dispatchCommand('drivers_seat_comfort', optionCmd, `Driver Seat: ${next.replace('_', ' ').toUpperCase()}`);
    } else {
      passengerSeatRef.current = next;
      setPassengerSeat(next);
      syncHold('passengers_seat_comfort', next);
      dispatchCommand('passengers_seat_comfort', optionCmd, `Passenger Seat: ${next.replace('_', ' ').toUpperCase()}`);
    }
  };

  const cycleSeatHeat = (_current: SeatLevel | null, isDriver: boolean) => {
    if (!equippedFeatures.has('heated_seats')) {
      triggerNotice('Seat heating is not equipped on this trim');
      return;
    }

    const cycle: SeatLevel[] = ['off', 'heat_low', 'heat_med', 'heat_high'];
    const liveCurrent = isDriver ? driverSeatRef.current : passengerSeatRef.current;
    const currentEffective = (liveCurrent && liveCurrent.startsWith('heat')) ? liveCurrent : 'off';
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
      driverSeatRef.current = next;
      setDriverSeat(next);
      syncHold('drivers_seat_comfort', next);
      dispatchCommand('drivers_seat_comfort', optionCmd, `Driver Seat Heat: ${next === 'off' ? 'OFF' : next.replace('heat_', '').toUpperCase()}`);
    } else {
      passengerSeatRef.current = next;
      setPassengerSeat(next);
      syncHold('passengers_seat_comfort', next);
      dispatchCommand('passengers_seat_comfort', optionCmd, `Passenger Seat Heat: ${next === 'off' ? 'OFF' : next.replace('heat_', '').toUpperCase()}`);
    }
  };

  const cycleSeatCool = (_current: SeatLevel | null, isDriver: boolean) => {
    if (!equippedFeatures.has('ventilated_seats')) {
      triggerNotice('Seat ventilation is not equipped on this trim');
      return;
    }

    const cycle: SeatLevel[] = ['off', 'cool_low', 'cool_med', 'cool_high'];
    const liveCurrent = isDriver ? driverSeatRef.current : passengerSeatRef.current;
    const currentEffective = (liveCurrent && liveCurrent.startsWith('cool')) ? liveCurrent : 'off';
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
      driverSeatRef.current = next;
      setDriverSeat(next);
      syncHold('drivers_seat_comfort', next);
      dispatchCommand('drivers_seat_comfort', optionCmd, `Driver Seat Vent: ${next === 'off' ? 'OFF' : next.replace('cool_', '').toUpperCase()}`);
    } else {
      passengerSeatRef.current = next;
      setPassengerSeat(next);
      syncHold('passengers_seat_comfort', next);
      dispatchCommand('passengers_seat_comfort', optionCmd, `Passenger Seat Vent: ${next === 'off' ? 'OFF' : next.replace('cool_', '').toUpperCase()}`);
    }
  };

  const cycleSteeringHeat = () => {
    if (!equippedFeatures.has('heated_wheel')) {
      triggerNotice('Heated steering wheel is not equipped on this trim');
      return;
    }
    const cur = steeringWheelHeatRef.current;
    const isCurrentlyOn = cur === 'on' || cur === 'high' || cur === 'low';
    const next: SteeringHeatLevel = isCurrentlyOn ? 'off' : 'on';
    steeringWheelHeatRef.current = next;
    setSteeringWheelHeat(next);
    syncHold('heated_steering_wheel_toggle', next);
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
      const cur = driverTempRef.current !== null ? driverTempRef.current : baseDefault;
      const next = Math.max(minT, Math.min(maxT, tempUnit === 'C' ? Math.round((cur + step) * 2) / 2 : cur + step));
      driverTempRef.current = next;
      setDriverTemp(next);
      const targetF = Math.max(62, Math.min(82, displayTempToFahrenheit(next, tempUnit)));
      driverTempFRef.current = targetF;
      syncHold('climate_driver_temp', String(targetF));
      if (climateSyncRef.current !== false) {
        passengerTempRef.current = next;
        setPassengerTemp(next);
        passengerTempFRef.current = targetF;
        syncHold('climate_passenger_temp', String(targetF));
      }
      dispatchCommand('climate_driver_temp', `${targetF}°F`, `Driver Target Temp: ${next}°${tempUnit}`);
    } else {
      const cur = passengerTempRef.current !== null ? passengerTempRef.current : baseDefault;
      const next = Math.max(minT, Math.min(maxT, tempUnit === 'C' ? Math.round((cur + step) * 2) / 2 : cur + step));
      passengerTempRef.current = next;
      setPassengerTemp(next);
      climateSyncRef.current = false;
      setClimateSync(false);
      syncHold('climate_sync_toggle', 'false');
      const targetF = Math.max(62, Math.min(82, displayTempToFahrenheit(next, tempUnit)));
      passengerTempFRef.current = targetF;
      syncHold('climate_passenger_temp', String(targetF));
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
    const next = !trunkOpenRef.current;
    trunkOpenRef.current = next;
    setTrunkOpen(next);
    syncHold('trunk', String(next));
    dispatchCommand(
      'telematics_remote_tailgate',
      next ? 'Open Tailgate / Trunk' : 'Close Tailgate / Trunk',
      next ? 'Power Tailgate Opening' : 'Power Tailgate Closing',
      150,
      'trunk'
    );
  };

  const setPresetTemp = (displayVal: number) => {
    const targetF = Math.max(62, Math.min(82, displayTempToFahrenheit(displayVal, tempUnit)));
    driverTempRef.current = displayVal;
    setDriverTemp(displayVal);
    driverTempFRef.current = targetF;
    syncHold('climate_driver_temp', String(targetF));
    if (climateSyncRef.current !== false) {
      climateSyncRef.current = true;
      setClimateSync(true);
      passengerTempRef.current = displayVal;
      setPassengerTemp(displayVal);
      passengerTempFRef.current = targetF;
      syncHold('climate_passenger_temp', String(targetF));
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
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-overlay text-overlay-foreground text-xs shadow-overlay animate-slideUp border ${
            feedbackNotice.type === 'error'
              ? 'border-danger/60 text-danger'
              : 'border-accent/40'
          }`}
        >
          {feedbackNotice.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
          )}
          <span className="font-medium">{feedbackNotice.msg}</span>
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
                          onToggleChargePort={handleToggleChargePort}
                          onToggleSunroof={cycleSunroofState}
                          onCycleDriverSeat={() => cycleSeat(driverSeatRef.current, true)}
                          onCyclePassengerSeat={() => cycleSeat(passengerSeatRef.current, false)}
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
                        const next = !lockedRef.current;
                        lockedRef.current = next;
                        setLocked(next);
                        syncHold('door_locks', String(next));
                        if (next) {
                          setDoors({ frontLeft: false, frontRight: false, rearLeft: false, rearRight: false });
                          setHoodOpen(false);
                          trunkOpenRef.current = false;
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
                      onClick={handleToggleChargePort}
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
                onClick={handleToggleAmbientPower}
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
                    const next = !(driverOnlyRef.current === true);
                    driverOnlyRef.current = next;
                    setDriverOnly(next);
                    syncHold('climate_driver_only_toggle', String(next));
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
                    const next = !(climateSyncRef.current !== false);
                    climateSyncRef.current = next;
                    setClimateSync(next);
                    syncHold('climate_sync_toggle', String(next));
                    if (next && driverTempRef.current !== null) {
                      passengerTempRef.current = driverTempRef.current;
                      setPassengerTemp(driverTempRef.current);
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
                        const next = !(heatActiveRef.current === true);
                        heatActiveRef.current = next;
                        setHeatActive(next);
                        syncHold('climate_heat_toggle', String(next));
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
                        const next = !(acActiveRef.current === true);
                        acActiveRef.current = next;
                        setAcActive(next);
                        syncHold('climate_ac_toggle', String(next));
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
                        const next = !(rearDefrostRef.current === true);
                        rearDefrostRef.current = next;
                        setRearDefrost(next);
                        syncHold('climate_rear_defrost', String(next));
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
                      airflowRef.current = mode;
                      setAirflow(mode);
                      syncHold('climate_airflow_direction', mode);
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
                        onClick={handleToggleAmbientPower}
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
                    const next = Math.max(0, (ambientBrightnessRef.current ?? prevAmbientBrightnessRef.current) - 1);
                    setAmbientBrightness(next);
                    syncHold('ambient_light_brightness', String(next));
                    const cmdLabel = next === 0 ? 'Off' : next === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${next}`;
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
                    syncHold('ambient_light_brightness', String(step));
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
                    const next = Math.min(10, (ambientBrightnessRef.current ?? prevAmbientBrightnessRef.current) + 1);
                    setAmbientBrightness(next);
                    syncHold('ambient_light_brightness', String(next));
                    const cmdLabel = next === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${next}`;
                    dispatchCommand('ambient_light_brightness', cmdLabel, `Ambient Light: Level ${next}`);
                  }}
                  className="w-9 h-9 rounded-xl bg-surface-secondary hover:bg-surface-tertiary border border-border flex items-center justify-center text-foreground cursor-pointer shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Factory Themes (Single-Color OEM Presets) */}
            <div className="space-y-1.5 pt-2 border-t border-separator">
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="font-semibold">Factory Themes</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
                {AMBIENT_LIGHT_THEMES.map(t => {
                  const isSelected = isSameAmbientColor(ambientColor, t.label);
                  return (
                    <button
                      key={t.label}
                      type="button"
                      id={`ambient-theme-${t.name.toLowerCase().replace(/\s+/g, '-')}`}
                      onClick={() => {
                        setAmbientColor(t.label);
                        syncHold('ambient_light_colors', t.label.toLowerCase());
                        if (ambientBrightnessRef.current === null || ambientBrightnessRef.current === 0) {
                          const restoreLvl = Math.max(1, Math.min(10, prevAmbientBrightnessRef.current || 7));
                          setAmbientBrightness(restoreLvl);
                          syncHold('ambient_light_brightness', String(restoreLvl));
                          const restoreCmd = restoreLvl === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${restoreLvl}`;
                          dispatchCommand('ambient_light_brightness', restoreCmd, `Ambient Light: Level ${restoreLvl}`);
                        }
                        dispatchCommand('ambient_light_colors', t.label, `Theme: ${t.name}`);
                      }}
                      title={t.label}
                      className={`p-2 rounded-xl border flex items-center gap-2 transition-all cursor-pointer text-left ${
                        isSelected
                          ? 'bg-accent-soft text-accent border-accent/60 shadow-sm font-bold'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full flex-shrink-0 shadow-sm ring-1 ring-black/20"
                        style={{
                          backgroundColor: t.hex,
                          boxShadow: isSelected ? `0 0 8px ${t.hex}` : 'none'
                        }}
                      />
                      <span className="text-[11px] font-medium leading-tight truncate">{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Dynamic Effects (Offline Edge Animations) */}
            <div className="space-y-1.5 pt-2 border-t border-separator">
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-accent" />
                  <span>Dynamic Effects</span>
                </span>
                <span className="text-[10px] font-mono text-muted">Edge Offline</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
                {ambientLightEffects.map(eff => {
                  const isSelected = isSameAmbientColor(ambientColor, eff.label);
                  const effHex = eff.hex || '#00ffff';
                  const effName = eff.name || eff.label;
                  return (
                    <button
                      key={eff.label}
                      type="button"
                      id={`ambient-effect-${effName.toLowerCase().replace(/\s+/g, '-')}`}
                      onClick={() => {
                        setAmbientColor(eff.label);
                        syncHold('ambient_light_colors', eff.label.toLowerCase());
                        if (ambientBrightnessRef.current === null || ambientBrightnessRef.current === 0) {
                          const restoreLvl = Math.max(1, Math.min(10, prevAmbientBrightnessRef.current || 7));
                          setAmbientBrightness(restoreLvl);
                          syncHold('ambient_light_brightness', String(restoreLvl));
                          const restoreCmd = restoreLvl === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${restoreLvl}`;
                          dispatchCommand('ambient_light_brightness', restoreCmd, `Ambient Light: Level ${restoreLvl}`);
                        }
                        dispatchCommand('ambient_light_colors', eff.label, `Effect: ${effName}`);
                      }}
                      title={eff.description ? `${eff.label} — ${eff.description}` : eff.label}
                      className={`p-2 rounded-xl border flex items-center gap-2 transition-all cursor-pointer text-left ${
                        isSelected
                          ? 'bg-accent-soft text-accent border-accent/60 shadow-sm font-bold'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground hover:bg-surface-tertiary'
                      }`}
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full flex-shrink-0 shadow-sm ring-1 ring-black/20"
                        style={{
                          backgroundColor: effHex,
                          boxShadow: isSelected ? `0 0 8px ${effHex}` : 'none'
                        }}
                      />
                      <span className="text-[11px] font-medium leading-tight truncate">{effName}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Popular Colors */}
            <div className="space-y-1.5 pt-2 border-t border-separator">
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="font-semibold">Quick Colors</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {AMBIENT_QUICK_COLORS.map(c => {
                  const isSelected = isSameAmbientColor(ambientColor, c.label);
                  return (
                    <button
                      key={c.label}
                      type="button"
                      id={`ambient-quick-${c.name.toLowerCase().replace(/\s+/g, '-')}`}
                      onClick={() => {
                        setAmbientColor(c.label);
                        syncHold('ambient_light_colors', c.label.toLowerCase());
                        if (ambientBrightnessRef.current === null || ambientBrightnessRef.current === 0) {
                          const restoreLvl = Math.max(1, Math.min(10, prevAmbientBrightnessRef.current || 7));
                          setAmbientBrightness(restoreLvl);
                          syncHold('ambient_light_brightness', String(restoreLvl));
                          const restoreCmd = restoreLvl === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${restoreLvl}`;
                          dispatchCommand('ambient_light_brightness', restoreCmd, `Ambient Light: Level ${restoreLvl}`);
                        }
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
                      const isSelected = isSameAmbientColor(ambientColor, p.label);
                      return (
                        <Tooltip key={p.step}>
                          <Tooltip.Trigger>
                            <button
                              type="button"
                              id={`ambient-palette-step-${p.step}`}
                              onClick={() => {
                                setAmbientColor(p.label);
                                syncHold('ambient_light_colors', p.label.toLowerCase());
                                if (ambientBrightnessRef.current === null || ambientBrightnessRef.current === 0) {
                                  const restoreLvl = Math.max(1, Math.min(10, prevAmbientBrightnessRef.current || 7));
                                  setAmbientBrightness(restoreLvl);
                                  syncHold('ambient_light_brightness', String(restoreLvl));
                                  const restoreCmd = restoreLvl === 10 ? 'Brightness Level 10 (Max)' : `Brightness Level ${restoreLvl}`;
                                  dispatchCommand('ambient_light_brightness', restoreCmd, `Ambient Light: Level ${restoreLvl}`);
                                }
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
