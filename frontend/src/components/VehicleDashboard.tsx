import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Catalog, Command, Vehicle } from '../types/catalog';
import { isRunningOnDevice, resolveDeviceBaseUrl } from '../utils/hostUtils';
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
  Radio,
  CheckCircle2,
  ChevronRight,
  Info,
  Maximize2
} from 'lucide-react';
import {
  EgmpModel,
  SunroofConfig,
  EGMP_MODELS,
  VehicleSilhouette
} from './VehicleOutlines';

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
export type SteeringHeatLevel = 'off' | 'low' | 'high';
export type GearMode = 'P' | 'R' | 'N' | 'D';
export type LightMode = 'off' | 'parking' | 'low' | 'high' | 'auto';
export type AirflowMode = 'auto' | 'face' | 'face_feet' | 'feet' | 'defog';
export type ViewPerspective = 'exterior' | 'interior' | 'powertrain';

interface DecodedCanMessage {
  id: string;
  name: string;
  decoded: string;
  raw: string;
  timestamp: string;
}

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
  const [odometer, setOdometer] = useState<number>(18420);
  const [ambientTempC, setAmbientTempC] = useState<number>(22.0); // 71.6°F
  const [tempUnit, setTempUnit] = useState<'F' | 'C'>(() => (unitSystem === 'metric' ? 'C' : 'F'));

  useEffect(() => {
    if (unitSystem) {
      setTempUnit(unitSystem === 'metric' ? 'C' : 'F');
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

  // High Voltage Battery
  const [soc, setSoc] = useState<number>(78.5);
  const [isCharging, setIsCharging] = useState(false);
  const [chargeRateKw, setChargeRateKw] = useState<number>(0);
  const [chargeLimit, setChargeLimit] = useState<number>(80);
  const [batteryMinTempC, setBatteryMinTempC] = useState<number>(23.0);
  const [batteryMaxTempC, setBatteryMaxTempC] = useState<number>(24.5);
  const [aux12V, setAux12V] = useState<number>(13.8);

  // Climate & Comfort
  const [hvacPower, setHvacPower] = useState(true);
  const [hvacAuto, setHvacAuto] = useState(true);
  const [driverTemp, setDriverTemp] = useState<number>(70); // in F or C depending on tempUnit
  const [passengerTemp, setPassengerTemp] = useState<number>(70);
  const [fanSpeed, setFanSpeed] = useState<number>(3); // 1-8
  const [airflow, setAirflow] = useState<AirflowMode>('face');
  const [recirc, setRecirc] = useState(false);
  const [rearDefrost, setRearDefrost] = useState(false);
  const [frontDefrost, setFrontDefrost] = useState(false);
  const [driverSeat, setDriverSeat] = useState<SeatLevel>('off');
  const [passengerSeat, setPassengerSeat] = useState<SeatLevel>('off');
  const [steeringWheelHeat, setSteeringWheelHeat] = useState<SteeringHeatLevel>('off');
  const [climateSync, setClimateSync] = useState(true);

  // TPMS (PSI)
  const [tpms, setTpms] = useState({
    fl: 36,
    fr: 36,
    rl: 35,
    rr: 36
  });

  // UI / Perspective State
  const [perspective, setPerspective] = useState<ViewPerspective>('exterior');
  const [isSimulating, setIsSimulating] = useState<boolean>(true);
  const [recentCanLogs, setRecentCanLogs] = useState<DecodedCanMessage[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<boolean>(false);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  // Calculated ambient temp display
  const displayAmbient = useMemo(() => {
    if (tempUnit === 'F') {
      return `${Math.round(ambientTempC * 1.8 + 32)}°F`;
    }
    return `${ambientTempC.toFixed(1)}°C`;
  }, [ambientTempC, tempUnit]);

  // Ambient threshold assessment
  const ambientThreshold = useMemo(() => {
    if (ambientTempC <= 0) return { label: 'Freezing', color: 'text-sky-400 bg-sky-950/60 border-sky-800/60' };
    if (ambientTempC < 15) return { label: 'Cold', color: 'text-blue-400 bg-blue-950/60 border-blue-800/60' };
    if (ambientTempC > 26) return { label: 'Warm', color: 'text-amber-400 bg-amber-950/60 border-amber-800/60' };
    return { label: 'Comfortable', color: 'text-emerald-400 bg-emerald-950/60 border-emerald-800/60' };
  }, [ambientTempC]);

  // Estimated driving range based on SOC (approx 310 mi EPA for 100%)
  const estimatedRangeMiles = useMemo(() => {
    return Math.round((soc / 100) * 310);
  }, [soc]);

  // Temporary feedback toast
  const triggerNotice = (msg: string) => {
    setFeedbackNotice(msg);
    setTimeout(() => {
      setFeedbackNotice(null);
    }, 2800);
  };

  // Model switching handler with vehicle catalog synchronization
  const handleSelectModel = (newModel: EgmpModel) => {
    setSelectedModel(newModel);
    const spec = EGMP_MODELS[newModel];
    triggerNotice(`Model Architecture: ${spec.brand} ${spec.name} (${spec.category})`);

    if (onSelectVehicle && catalog?.vehicles) {
      const match = catalog.vehicles.find(v => {
        const s = `${v.id || ''} ${v.name || ''} ${v.model || ''} ${v.make || ''}`.toLowerCase();
        if (newModel === 'ev6' && s.includes('ev6')) return true;
        if (newModel === 'ioniq5' && (s.includes('ioniq 5') || s.includes('hi5'))) return true;
        if (newModel === 'ioniq6' && (s.includes('ioniq 6') || s.includes('hi6'))) return true;
        if (newModel === 'gv60' && s.includes('gv60')) return true;
        return false;
      });
      if (match) {
        onSelectVehicle(match.id);
      }
    }
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
  };

  const toggleSunshade = () => {
    setSunroof(prev => {
      const nextShade = prev.sunshade === 'open' ? 'closed' : 'open';
      triggerNotice(`Power Sunshade: ${nextShade === 'open' ? 'Retracted' : 'Closed'}`);
      return { ...prev, sunshade: nextShade };
    });
  };

  // Hardware command dispatcher (sends to CAN Do ESP32 device if connected)
  const dispatchCommand = async (entity: string, cmd: string, fallbackDesc: string) => {
    triggerNotice(fallbackDesc);
    try {
      const baseUrl = resolveDeviceBaseUrl();
      await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity, command: cmd })
      });
    } catch {
      // Offline / standalone browser preview mode - visual state reflects immediately
    }
  };

  // 2. Real-time WebSocket connection to physical CAN Do device (if online)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;

    const connect = () => {
      try {
        const baseUrl = resolveDeviceBaseUrl();
        const parsed = new URL(baseUrl);
        const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProto}//${parsed.host}/ws`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setConnectedDevice(true);
          setIsSimulating(false);
          triggerNotice('Connected to live CAN Do device telemetry');
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'can_frame') {
              handleIncomingCanFrame(data.id, data.data || '');
            }
          } catch {
            // Ignore non-json frames
          }
        };

        ws.onclose = () => {
          setConnectedDevice(false);
          reconnectTimeout = setTimeout(connect, 6000);
        };

        ws.onerror = () => {
          setConnectedDevice(false);
          ws?.close();
        };
      } catch {
        setConnectedDevice(false);
      }
    };

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, []);

  // 3. CAN Frame Decoder
  const handleIncomingCanFrame = (idStr: string, hexPayload: string) => {
    const normId = idStr.toLowerCase().replace(/^0x/, '');
    const bytes = hexPayload.trim().split(/\s+/).map(h => parseInt(h, 16));
    const now = new Date().toLocaleTimeString();

    // 0x226: Ambient Outdoor Temperature ([B3] / D4 = raw - 40 deg C)
    if (normId === '226' && bytes.length >= 4) {
      const raw = bytes[3];
      if (raw > 0 && raw < 255) {
        const c = raw - 40;
        setAmbientTempC(c);
        recordLog('0x226', 'Ambient Temp', `${c}°C (${Math.round(c * 1.8 + 32)}°F)`, hexPayload, now);
      }
    }

    // 0x2FC: HV Battery SOC ([B7] / D8 * 0.5%)
    else if (normId === '2fc' && bytes.length >= 8) {
      const raw = bytes[7];
      const newSoc = Math.round(raw * 0.5 * 10) / 10;
      setSoc(newSoc);
      recordLog('0x2FC', 'Traction Battery SOC', `${newSoc}%`, hexPayload, now);
    }

    // 0x227: Odometer (Bytes D2-D4, 24-bit LE)
    else if (normId === '227' && bytes.length >= 4) {
      const odo = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16);
      if (odo > 0) {
        setOdometer(odo);
        recordLog('0x227', 'Odometer', `${odo.toLocaleString()} km`, hexPayload, now);
      }
    }

    // 0x380: Cabin Target Temperatures (D2 Driver, D3 Passenger)
    else if (normId === '380' && bytes.length >= 3) {
      const rawD = bytes[1];
      const rawP = bytes[2];
      if (rawD >= 0x06 && rawD <= 0x1A) {
        const dF = 62 + (rawD - 0x06);
        setDriverTemp(dF);
      }
      if (rawP >= 0x06 && rawP <= 0x1A) {
        const pF = 62 + (rawP - 0x06);
        setPassengerTemp(pF);
      }
      recordLog('0x380', 'Cabin Target Temp', `Driver: ${bytes[1]} / Pass: ${bytes[2]}`, hexPayload, now);
    }

    // 0x541: Rear Defroster (D1 bit 0)
    else if (normId === '541' && bytes.length >= 1) {
      const def = Boolean(bytes[0] & 0x01);
      setRearDefrost(def);
      recordLog('0x541', 'Rear Defroster', def ? 'ON' : 'OFF', hexPayload, now);
    }

    // 0x418: Heated Steering Wheel (D1 bit 0..1)
    else if (normId === '418' && bytes.length >= 1) {
      const val = bytes[0] & 0x03;
      const levels: SteeringHeatLevel[] = ['off', 'low', 'high'];
      const lvl = levels[val] || 'off';
      setSteeringWheelHeat(lvl);
      recordLog('0x418', 'Steering Wheel Heat', lvl.toUpperCase(), hexPayload, now);
    }

    // 0x496: Driver Seat Comfort (D1)
    else if (normId === '496' && bytes.length >= 1) {
      const b = bytes[0];
      let lvl: SeatLevel = 'off';
      if (b === 0x0E) lvl = 'heat_low';
      else if (b === 0x0A) lvl = 'heat_med';
      else if (b === 0x02) lvl = 'heat_high';
      else if (b === 0x14) lvl = 'cool_low';
      else if (b === 0x12) lvl = 'cool_med';
      else if (b === 0x10) lvl = 'cool_high';
      setDriverSeat(lvl);
      recordLog('0x496', 'Driver Seat Comfort', lvl, hexPayload, now);
    }

    // 0x31B: Blower Fan Speed & Airflow (D4)
    else if (normId === '31b' && bytes.length >= 4) {
      const fanRaw = bytes[3] & 0x0F;
      const speed = fanRaw >= 2 && fanRaw <= 9 ? fanRaw - 1 : 0;
      setFanSpeed(speed);
      if (bytes.length >= 5) {
        setRecirc(Boolean(bytes[4] & 0x40));
      }
      recordLog('0x31B', 'HVAC Blower / Vents', `Fan ${speed}, Recirc ${recirc ? 'ON' : 'OFF'}`, hexPayload, now);
    }
  };

  const recordLog = (id: string, name: string, decoded: string, raw: string, timestamp: string) => {
    setRecentCanLogs(prev => [
      { id, name, decoded, raw, timestamp },
      ...prev.slice(0, 19)
    ]);
  };

  // 4. Live Simulation Loop (for instant visual demonstration & interactive testing)
  useEffect(() => {
    if (!isSimulating) return;

    const interval = setInterval(() => {
      // Realistic micro-fluctuations in driving / telemetry
      if (gear === 'D') {
        setSpeedMph(prev => Math.min(74, Math.max(55, prev + (Math.random() * 2 - 1))));
        setSoc(prev => Math.max(12, Number((prev - 0.01).toFixed(2))));
        setOdometer(prev => prev + 1);
      } else if (isCharging) {
        setSoc(prev => Math.min(chargeLimit, Number((prev + 0.08).toFixed(2))));
        setChargeRateKw(prev => Math.min(175, Math.max(120, prev + (Math.random() * 4 - 2))));
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [isSimulating, gear, isCharging, chargeLimit]);

  // Turn signal hazard blinker timer
  const [blinkState, setBlinkState] = useState(false);
  useEffect(() => {
    if (hazards || turnSignal !== 'off') {
      const t = setInterval(() => setBlinkState(b => !b), 400);
      return () => clearInterval(t);
    }
    setBlinkState(false);
  }, [hazards, turnSignal]);

  // Scenario Presets
  const applyScenario = (name: 'parked' | 'charging' | 'cruising' | 'cold_weather') => {
    if (name === 'parked') {
      setGear('P');
      setSpeedMph(0);
      setIsCharging(false);
      setChargePortOpen(false);
      setLights('off');
      setLocked(true);
      setDoors({ frontLeft: false, frontRight: false, rearLeft: false, rearRight: false });
      setHoodOpen(false);
      setTrunkOpen(false);
      setHvacPower(false);
      setDriverSeat('off');
      setPassengerSeat('off');
      setSteeringWheelHeat('off');
      triggerNotice('Preset: Parked & Secured');
    } else if (name === 'charging') {
      setGear('P');
      setSpeedMph(0);
      setIsCharging(true);
      setChargeRateKw(148);
      setChargePortOpen(true);
      setDoors({ frontLeft: false, frontRight: false, rearLeft: false, rearRight: false });
      setHvacPower(true);
      setDriverTemp(70);
      triggerNotice('Preset: 150 kW DC Fast Charging');
    } else if (name === 'cruising') {
      setGear('D');
      setSpeedMph(65);
      setIsCharging(false);
      setChargePortOpen(false);
      setLights('low');
      setLocked(true);
      setDoors({ frontLeft: false, frontRight: false, rearLeft: false, rearRight: false });
      setHoodOpen(false);
      setTrunkOpen(false);
      setHvacPower(true);
      setFanSpeed(3);
      setAirflow('face');
      triggerNotice('Preset: Highway Cruise at 65 mph');
    } else if (name === 'cold_weather') {
      setGear('P');
      setAmbientTempC(-2.5); // 27.5°F
      setHvacPower(true);
      setDriverTemp(75);
      setPassengerTemp(75);
      setFanSpeed(6);
      setFrontDefrost(true);
      setRearDefrost(true);
      setDriverSeat('heat_high');
      setPassengerSeat('heat_high');
      setSteeringWheelHeat('high');
      triggerNotice('Preset: Cold Morning Pre-Conditioning');
    }
  };

  // Seat toggle helper
  const cycleSeat = (current: SeatLevel, isDriver: boolean) => {
    const cycle: SeatLevel[] = ['off', 'heat_low', 'heat_med', 'heat_high', 'cool_low', 'cool_med', 'cool_high'];
    const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
    const next = cycle[nextIdx];
    if (isDriver) {
      setDriverSeat(next);
      dispatchCommand('driver_seat_comfort', next, `Driver Seat: ${next.replace('_', ' ').toUpperCase()}`);
    } else {
      setPassengerSeat(next);
      triggerNotice(`Passenger Seat: ${next.replace('_', ' ').toUpperCase()}`);
    }
  };

  const cycleSteeringHeat = () => {
    const next: SteeringHeatLevel = steeringWheelHeat === 'off' ? 'low' : steeringWheelHeat === 'low' ? 'high' : 'off';
    setSteeringWheelHeat(next);
    dispatchCommand('heated_steering_wheel', next, `Heated Steering Wheel: ${next.toUpperCase()}`);
  };

  const adjustTemp = (isDriver: boolean, delta: number) => {
    if (isDriver) {
      const next = Math.max(62, Math.min(82, driverTemp + delta));
      setDriverTemp(next);
      if (climateSync) setPassengerTemp(next);
      dispatchCommand('climate_driver_temp', `${next}`, `Driver Target Temp: ${next}°${tempUnit}`);
    } else {
      const next = Math.max(62, Math.min(82, passengerTemp + delta));
      setPassengerTemp(next);
      setClimateSync(false);
      dispatchCommand('climate_passenger_temp', `${next}`, `Passenger Target Temp: ${next}°${tempUnit}`);
    }
  };

  const toggleDoor = (key: keyof typeof doors) => {
    setDoors(prev => ({ ...prev, [key]: !prev[key] }));
    const label = key.replace(/([A-Z])/g, ' $1').toLowerCase();
    triggerNotice(`${label} ${!doors[key] ? 'Opened' : 'Closed'}`);
  };

  return (
    <div id="vehicle-live-dashboard" className="space-y-5 select-none animate-fadeIn">
      {/* 1. Header Toolbar: Vehicle ID, Gear Selector, Simulation Banner */}
      <header className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-slate-800/90 border border-slate-700/80 flex items-center justify-center text-cyan-400 shrink-0 shadow-inner">
            <Car className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base sm:text-lg font-bold text-white tracking-tight">
                {EGMP_MODELS[selectedModel].brand} {EGMP_MODELS[selectedModel].name}
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium tracking-wide text-cyan-300 bg-cyan-950/80 border border-cyan-800/60">
                {EGMP_MODELS[selectedModel].badge}
              </span>
              <button
                type="button"
                onClick={toggleSunroofEquipped}
                title="Click to toggle between Sunroof and Solid Roof"
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono border transition-all cursor-pointer ${
                  sunroof.equipped
                    ? 'text-sky-300 bg-sky-950/70 border-sky-800/70 hover:bg-sky-900/80'
                    : 'text-slate-400 bg-slate-800/60 border-slate-700/60 hover:text-slate-200'
                }`}
              >
                {sunroof.equipped
                  ? selectedModel === 'ev6' || selectedModel === 'ioniq6'
                    ? `Glass Sunroof (${sunroof.state.toUpperCase()})`
                    : `Vision Roof (${sunroof.sunshade === 'open' ? 'SHADE OPEN' : 'SHADED'})`
                  : 'Solid Steel Roof'}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 mt-0.5 text-xs text-slate-400">
              <span className="font-mono">{odometer.toLocaleString()} mi</span>
              <span>•</span>
              <span className="inline-flex items-center gap-1">
                <Thermometer className="w-3 h-3 text-slate-400" />
                <span>{displayAmbient}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded font-medium border ${ambientThreshold.color}`}>
                  {ambientThreshold.label}
                </span>
              </span>
              <span>•</span>
              <span className="font-mono text-slate-300">{speedMph} MPH</span>
            </div>
          </div>
        </div>

        {/* Gear Selector & Live Feed Indicator */}
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 w-full lg:w-auto justify-between lg:justify-end">
          {/* Gear Shifter Buttons */}
          <div className="flex items-center p-1 rounded-xl bg-slate-900/90 border border-slate-800/80 shadow-inner">
            {(['P', 'R', 'N', 'D'] as GearMode[]).map((g) => {
              const active = gear === g;
              return (
                <button
                  key={g}
                  id={`gear-btn-${g}`}
                  type="button"
                  onClick={() => {
                    setGear(g);
                    if (g === 'D') setSpeedMph(prev => (prev === 0 ? 35 : prev));
                    if (g === 'P') setSpeedMph(0);
                    triggerNotice(`Shifted to ${g}`);
                  }}
                  className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${
                    active
                      ? 'bg-cyan-500 text-slate-950 shadow-md scale-105'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  {g}
                </button>
              );
            })}
          </div>

          {/* Perspective Selector */}
          <div
            id="perspective-selector-group"
            className="flex items-center p-1 rounded-xl bg-slate-900/90 border border-slate-800/80 text-xs shadow-inner"
          >
            <button
              type="button"
              id="perspective-exterior"
              onClick={() => {
                setPerspective('exterior');
                triggerNotice('View: Exterior Shell & Closures');
              }}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                perspective === 'exterior'
                  ? 'bg-slate-800 text-cyan-300 font-semibold shadow-sm scale-[1.02]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Exterior
            </button>
            <button
              type="button"
              id="perspective-interior"
              onClick={() => {
                setPerspective('interior');
                triggerNotice('View: Cabin Interior & Seating');
              }}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                perspective === 'interior'
                  ? 'bg-slate-800 text-cyan-300 font-semibold shadow-sm scale-[1.02]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Cabin
            </button>
            <button
              type="button"
              id="perspective-powertrain"
              onClick={() => {
                setPerspective('powertrain');
                triggerNotice('View: HV Battery & Inverter Pack');
              }}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                perspective === 'powertrain'
                  ? 'bg-slate-800 text-cyan-300 font-semibold shadow-sm scale-[1.02]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              HV Battery
            </button>
          </div>

          {/* Simulator / Live HW Toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              id="feed-source-toggle"
              onClick={() => {
                setIsSimulating(prev => !prev);
                triggerNotice(!isSimulating ? 'Switched to Live Simulation Feed' : 'Switched to Physical CAN Do Feed');
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 border transition-all ${
                connectedDevice
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60'
                  : isSimulating
                  ? 'bg-indigo-950/80 text-indigo-300 border-indigo-700/60'
                  : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${connectedDevice ? 'bg-emerald-400 animate-pulse' : isSimulating ? 'bg-indigo-400' : 'bg-slate-500'}`} />
              <span>{connectedDevice ? 'CAN Do Online' : isSimulating ? 'Live Simulator' : 'HW Standby'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Toast Notice */}
      {feedbackNotice && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900/95 border border-cyan-500/50 text-cyan-200 text-xs shadow-xl animate-slideUp">
          <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="font-medium">{feedbackNotice}</span>
        </div>
      )}

      {/* 2. Main 3-Column Cockpit Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        
        {/* Left Column (3 cols): Powertrain, Battery & Closures Quick Toggles */}
        <div className="lg:col-span-3 space-y-4">
          
          {/* HV Battery Status Card */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BatteryCharging className={`w-4 h-4 ${isCharging ? 'text-emerald-400 animate-pulse' : 'text-cyan-400'}`} />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Traction Battery</h3>
              </div>
              <span className="text-xs font-mono font-bold text-white">{soc.toFixed(1)}%</span>
            </div>

            {/* Battery Progress Meter */}
            <div className="space-y-1.5">
              <div className="h-3.5 w-full rounded-full bg-slate-950/80 p-0.5 border border-slate-800/80 relative overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    soc > 20 ? 'bg-gradient-to-r from-cyan-500 to-emerald-400' : 'bg-red-500'
                  }`}
                  style={{ width: `${soc}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>0%</span>
                <span className="text-cyan-300 font-medium">Est. {estimatedRangeMiles} mi Range</span>
                <span>Limit: {chargeLimit}%</span>
              </div>
            </div>

            {/* Charging & Power Stats */}
            <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
              <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60">
                <span className="text-[10px] uppercase text-slate-400 block font-semibold">Charge Status</span>
                <span className={`font-mono font-bold ${isCharging ? 'text-emerald-400' : 'text-slate-300'}`}>
                  {isCharging ? `${chargeRateKw} kW DC` : 'Standby'}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60">
                <span className="text-[10px] uppercase text-slate-400 block font-semibold">12V Aux Battery</span>
                <span className="font-mono font-bold text-slate-300">{aux12V.toFixed(1)} V (OK)</span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60">
                <span className="text-[10px] uppercase text-slate-400 block font-semibold">Pack Min Temp</span>
                <span className="font-mono font-bold text-slate-300">{batteryMinTempC}°C</span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60">
                <span className="text-[10px] uppercase text-slate-400 block font-semibold">Pack Max Temp</span>
                <span className="font-mono font-bold text-slate-300">{batteryMaxTempC}°C</span>
              </div>
            </div>

            {/* Charge Port Quick Toggle */}
            <div className="pt-2 flex items-center justify-between border-t border-slate-800/60">
              <span className="text-xs text-slate-400">Charge Port Door</span>
              <button
                type="button"
                id="charge-port-toggle-btn"
                onClick={() => {
                  setChargePortOpen(prev => !prev);
                  if (!chargePortOpen) setIsCharging(true);
                  else setIsCharging(false);
                  triggerNotice(chargePortOpen ? 'Charge Port Closed' : 'Charge Port Opened');
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  chargePortOpen
                    ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60'
                    : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                {chargePortOpen ? 'Open / Plugged' : 'Closed'}
              </button>
            </div>
          </div>

          {/* Closures & Security Card */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Closures & Security</h3>
              </div>
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
                  triggerNotice(next ? 'All Doors Locked & Secured' : 'Vehicle Unlocked');
                }}
                className={`p-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 border transition-colors ${
                  locked
                    ? 'bg-slate-900 text-emerald-400 border-slate-800'
                    : 'bg-amber-950/60 text-amber-300 border-amber-800/60'
                }`}
              >
                {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                <span>{locked ? 'Locked' : 'Unlocked'}</span>
              </button>
            </div>

            {/* Doors & Latches Matrix */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                id="toggle-fl-door"
                onClick={() => toggleDoor('frontLeft')}
                className={`p-2 rounded-xl text-left border transition-all ${
                  doors.frontLeft
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/70 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block opacity-70">Driver Door</span>
                <span className="font-semibold">{doors.frontLeft ? 'AJAR' : 'Closed'}</span>
              </button>

              <button
                type="button"
                id="toggle-fr-door"
                onClick={() => toggleDoor('frontRight')}
                className={`p-2 rounded-xl text-left border transition-all ${
                  doors.frontRight
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/70 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block opacity-70">Pass. Door</span>
                <span className="font-semibold">{doors.frontRight ? 'AJAR' : 'Closed'}</span>
              </button>

              <button
                type="button"
                id="toggle-rl-door"
                onClick={() => toggleDoor('rearLeft')}
                className={`p-2 rounded-xl text-left border transition-all ${
                  doors.rearLeft
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/70 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block opacity-70">Rear Left</span>
                <span className="font-semibold">{doors.rearLeft ? 'AJAR' : 'Closed'}</span>
              </button>

              <button
                type="button"
                id="toggle-rr-door"
                onClick={() => toggleDoor('rearRight')}
                className={`p-2 rounded-xl text-left border transition-all ${
                  doors.rearRight
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/70 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block opacity-70">Rear Right</span>
                <span className="font-semibold">{doors.rearRight ? 'AJAR' : 'Closed'}</span>
              </button>

              <button
                type="button"
                id="toggle-hood"
                onClick={() => {
                  setHoodOpen(prev => !prev);
                  triggerNotice(hoodOpen ? 'Front Trunk Closed' : 'Front Trunk / Hood Unlatched');
                }}
                className={`p-2 rounded-xl text-left border transition-all ${
                  hoodOpen
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/70'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block opacity-70">Frunk / Hood</span>
                <span className="font-semibold">{hoodOpen ? 'OPEN' : 'Closed'}</span>
              </button>

              <button
                type="button"
                id="toggle-trunk"
                onClick={() => {
                  setTrunkOpen(prev => !prev);
                  dispatchCommand('trunk_open_toggle', 'toggle', trunkOpen ? 'Trunk Closed' : 'Trunk Liftgate Opened');
                }}
                className={`p-2 rounded-xl text-left border transition-all ${
                  trunkOpen
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/70'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block opacity-70">Liftgate / Trunk</span>
                <span className="font-semibold">{trunkOpen ? 'OPEN' : 'Closed'}</span>
              </button>
            </div>

            {/* Roof & Sunroof Controls */}
            <div id="closures-roof-panel" className="pt-3 border-t border-slate-800/80 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-slate-300 block">Roof Configuration</span>
                  <span className="text-[10px] text-slate-400">
                    {sunroof.equipped ? EGMP_MODELS[selectedModel].roofType : 'Solid Steel Stamping'}
                  </span>
                </div>
                <button
                  type="button"
                  id="toggle-sunroof-equipped-btn"
                  onClick={toggleSunroofEquipped}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                    sunroof.equipped
                      ? 'bg-sky-950/80 text-sky-300 border-sky-700/80 shadow-sm'
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {sunroof.equipped ? 'Glass Equipped' : 'Solid Roof'}
                </button>
              </div>

              {sunroof.equipped && (
                <div className="p-2 rounded-xl bg-slate-900/70 border border-slate-800/80 space-y-1.5 text-xs">
                  {selectedModel === 'ev6' || selectedModel === 'ioniq6' ? (
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-400">Tilt / Slide Position</span>
                      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-950 border border-slate-800">
                        {(['closed', 'vent', 'open'] as const).map(pos => (
                          <button
                            key={pos}
                            type="button"
                            id={`sunroof-pos-${pos}`}
                            onClick={() => {
                              setSunroof(prev => ({ ...prev, state: pos }));
                              triggerNotice(`Sunroof: ${pos === 'vent' ? 'Tilt Vent' : pos === 'open' ? 'Fully Open' : 'Closed'}`);
                            }}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-colors ${
                              sunroof.state === pos
                                ? 'bg-sky-600 text-white shadow-sm'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {pos}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-[11px] text-slate-300 block">Vision Roof Blind</span>
                        <span className="text-[10px] text-slate-400">
                          {sunroof.sunshade === 'open' ? 'Glass Exposed to Cabin' : 'Fabric Shade Closed'}
                        </span>
                      </div>
                      <button
                        type="button"
                        id="toggle-vision-shade-btn"
                        onClick={toggleSunshade}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                          sunroof.sunshade === 'open'
                            ? 'bg-sky-950 text-sky-300 border-sky-800'
                            : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                        }`}
                      >
                        {sunroof.sunshade === 'open' ? 'Retracted' : 'Closed'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Test Scenarios & Presets Card */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Scenario Presets</span>
              <span className="text-[10px] text-slate-400">1-Click Test</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                id="preset-parked"
                onClick={() => applyScenario('parked')}
                className="p-2 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors text-left"
              >
                <span className="font-semibold block">Parked</span>
                <span className="text-[10px] text-slate-400">Locked & Idle</span>
              </button>
              <button
                type="button"
                id="preset-charging"
                onClick={() => applyScenario('charging')}
                className="p-2 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors text-left"
              >
                <span className="font-semibold block text-emerald-400">Charging</span>
                <span className="text-[10px] text-slate-400">150 kW DC Fast</span>
              </button>
              <button
                type="button"
                id="preset-cruising"
                onClick={() => applyScenario('cruising')}
                className="p-2 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors text-left"
              >
                <span className="font-semibold block text-cyan-400">Cruising</span>
                <span className="text-[10px] text-slate-400">65 mph Highway</span>
              </button>
              <button
                type="button"
                id="preset-cold"
                onClick={() => applyScenario('cold_weather')}
                className="p-2 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors text-left"
              >
                <span className="font-semibold block text-blue-400">Winter Defrost</span>
                <span className="text-[10px] text-slate-400">Seats & Wheel High</span>
              </button>
            </div>
          </div>

        </div>

        {/* Center Column (6 cols): The Refined Modern Vehicle Architectural Illustration */}
        <div className="lg:col-span-6 space-y-4">
          
          {/* Model Silhouette Architecture Selector */}
          <div id="egmp-model-selector" className="p-3 sm:p-4 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] shadow-sm space-y-2.5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Car className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200">E-GMP Vehicle Architecture Outlines</span>
              </div>
              <div className="flex items-center gap-2.5 text-[11px] text-slate-400 font-mono">
                <span className="text-cyan-300">Drag: Cd {EGMP_MODELS[selectedModel].cd}</span>
                <span>•</span>
                <span>WB: {EGMP_MODELS[selectedModel].wheelbaseMm}mm</span>
                <span>•</span>
                <span className="text-sky-300">
                  {sunroof.equipped ? EGMP_MODELS[selectedModel].roofType : 'Solid Steel Roof'}
                </span>
              </div>
            </div>

            {/* 4 Model Selection Pills: EV6, Ioniq 5, Ioniq 6, GV60 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['ev6', 'ioniq5', 'ioniq6', 'gv60'] as EgmpModel[]).map((mKey) => {
                const spec = EGMP_MODELS[mKey];
                const isSelected = selectedModel === mKey;
                return (
                  <button
                    key={mKey}
                    id={`model-btn-${mKey}`}
                    type="button"
                    onClick={() => handleSelectModel(mKey)}
                    className={`p-2.5 rounded-xl border text-left transition-all relative overflow-hidden ${
                      isSelected
                        ? 'bg-slate-800/95 border-cyan-500 text-white shadow-md shadow-cyan-950/50 ring-1 ring-cyan-500/50'
                        : 'bg-slate-900/60 border-slate-800/80 text-slate-400 hover:text-slate-200 hover:border-slate-700 hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase font-bold tracking-wider opacity-75">{spec.brand}</span>
                      <span className={`w-2 h-2 rounded-full ${isSelected ? 'bg-cyan-400 shadow-[0_0_8px_#22d3ee]' : 'bg-slate-700'}`} />
                    </div>
                    <div className="text-sm font-bold tracking-tight text-white mt-1">{spec.name}</div>
                    <div className="text-[10px] text-slate-400 truncate mt-0.5">{spec.category}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative p-4 sm:p-6 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] overflow-hidden shadow-md flex flex-col items-center justify-center min-h-[580px]">
            
            {/* Top Overlay Bar inside diagram: Lighting, Hazards, Mirrors & Roof */}
            <div className="w-full flex flex-wrap items-center justify-between gap-2.5 mb-4 z-10">
              {/* Lighting controls */}
              <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/80 border border-slate-800 text-xs">
                {(['off', 'parking', 'low', 'high', 'auto'] as LightMode[]).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    id={`light-btn-${mode}`}
                    onClick={() => {
                      setLights(mode);
                      triggerNotice(`Headlights: ${mode.toUpperCase()}`);
                    }}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium uppercase transition-colors ${
                      lights === mode
                        ? 'bg-slate-700 text-cyan-300 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>

              {/* Hazards, Mirrors & Quick Sunroof Toggle */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  id="hazard-btn"
                  onClick={() => {
                    setHazards(h => !h);
                    triggerNotice(hazards ? 'Hazard Lights Deactivated' : 'Hazard Lights Blinking');
                  }}
                  className={`p-2 rounded-xl border transition-colors ${
                    hazards
                      ? 'bg-amber-950 text-amber-300 border-amber-600 animate-pulse'
                      : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                  title="Hazard Flashers"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  id="mirror-fold-btn"
                  onClick={() => {
                    setMirrorsFolded(m => !m);
                    triggerNotice(mirrorsFolded ? 'Mirrors Extended' : 'Mirrors Folded');
                  }}
                  className={`px-2.5 py-1.5 rounded-xl border transition-colors text-[11px] font-medium ${
                    mirrorsFolded
                      ? 'bg-indigo-950 text-indigo-300 border-indigo-700'
                      : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {mirrorsFolded ? 'Mirrors Folded' : 'Fold Mirrors'}
                </button>

                {/* Quick Roof Button */}
                <button
                  type="button"
                  id="quick-sunroof-btn"
                  onClick={cycleSunroofState}
                  title={sunroof.equipped ? 'Click to toggle sunroof position or shade' : 'Click to equip glass roof'}
                  className={`px-2.5 py-1.5 rounded-xl border transition-colors text-[11px] font-medium flex items-center gap-1.5 cursor-pointer ${
                    sunroof.equipped
                      ? 'bg-sky-950/90 text-sky-300 border-sky-700/80 shadow-sm hover:bg-sky-900/90'
                      : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${sunroof.equipped ? 'bg-sky-400' : 'bg-slate-600'}`} />
                  <span>
                    {sunroof.equipped
                      ? selectedModel === 'ev6' || selectedModel === 'ioniq6'
                        ? `Sunroof: ${sunroof.state.toUpperCase()}`
                        : `Vision Roof: ${sunroof.sunshade === 'open' ? 'GLASS' : 'SHADE'}`
                      : 'Solid Roof'}
                  </span>
                </button>
              </div>
            </div>

            {/* Front Headlight Light Beams (Cast on floor) */}
            <div className="relative w-full flex justify-center items-center">
              
              {/* Headlight beam projections (visible when low or high) */}
              {(lights === 'low' || lights === 'high' || (lights === 'auto' && gear === 'D')) && (
                <div
                  className={`absolute -top-16 w-64 h-36 bg-gradient-to-t from-cyan-400/20 via-cyan-300/5 to-transparent pointer-events-none blur-xl transition-opacity duration-500 ${
                    lights === 'high' ? 'opacity-80 scale-125' : 'opacity-40'
                  }`}
                  style={{ clipPath: 'polygon(20% 100%, 80% 100%, 100% 0%, 0% 0%)' }}
                />
              )}

              {/* Model-Specific Architectural Vector Silhouette */}
              <VehicleSilhouette
                model={selectedModel}
                perspective={perspective}
                sunroof={sunroof}
                doors={doors}
                hoodOpen={hoodOpen}
                trunkOpen={trunkOpen}
                chargePortOpen={chargePortOpen}
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
                onToggleHood={() => {
                  setHoodOpen(h => !h);
                  triggerNotice(hoodOpen ? 'Front Trunk Closed' : 'Front Trunk Unlatched');
                }}
                onToggleTrunk={() => {
                  setTrunkOpen(t => !t);
                  dispatchCommand('trunk_open_toggle', 'toggle', trunkOpen ? 'Trunk Closed' : 'Liftgate Opened');
                }}
                onToggleChargePort={() => {
                  setChargePortOpen(c => !c);
                  triggerNotice(chargePortOpen ? 'Charge Door Closed' : 'Charge Door Opened');
                }}
                onToggleSunroof={cycleSunroofState}
                onCycleDriverSeat={() => cycleSeat(driverSeat, true)}
                onCyclePassengerSeat={() => cycleSeat(passengerSeat, false)}
                onCycleSteeringHeat={cycleSteeringHeat}
              />

              {/* TPMS Floating Badges (Anchored beside each tire) */}
              <div className="absolute top-24 left-2 sm:left-4 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">FL TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.fl} PSI</span>
              </div>

              <div className="absolute top-24 right-2 sm:right-4 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">FR TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.fr} PSI</span>
              </div>

              <div className="absolute bottom-28 left-2 sm:left-4 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">RL TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.rl} PSI</span>
              </div>

              <div className="absolute bottom-28 right-2 sm:right-4 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">RR TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.rr} PSI</span>
              </div>
            </div>

            {/* Bottom Quick Action Hints */}
            <div className="w-full mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <span>Click doors, seats, or frunk to toggle live state</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-300">
                  {doors.frontLeft || doors.frontRight || doors.rearLeft || doors.rearRight ? (
                    <span className="text-amber-400 font-bold">Door Ajar</span>
                  ) : (
                    <span className="text-emerald-400">All Doors Latched</span>
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column (3 cols): Dual-Zone Climate & Real-Time CAN Bus Decoder */}
        <div className="lg:col-span-3 space-y-4">
          
          {/* Dual-Zone Climate Control Suite */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wind className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Cabin Climate</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="hvac-power-toggle"
                  onClick={() => {
                    const next = !hvacPower;
                    setHvacPower(next);
                    triggerNotice(next ? 'Cabin Climate Activated' : 'Cabin Climate Turned OFF');
                  }}
                  className={`px-2 py-0.5 rounded-md text-xs font-bold transition-colors ${
                    hvacPower
                      ? 'bg-cyan-500 text-slate-950 shadow-sm'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {hvacPower ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            {/* Dual Temperature Setpoint Dials */}
            <div className="grid grid-cols-2 gap-3">
              {/* Driver Temp */}
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 flex flex-col items-center">
                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">Driver</span>
                <span className="text-2xl font-bold font-mono text-white tracking-tight">
                  {driverTemp}°{tempUnit}
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    id="driver-temp-down"
                    onClick={() => adjustTemp(true, -1)}
                    className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center font-bold text-sm"
                  >
                    -
                  </button>
                  <button
                    type="button"
                    id="driver-temp-up"
                    onClick={() => adjustTemp(true, 1)}
                    className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center font-bold text-sm"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Passenger Temp */}
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 flex flex-col items-center">
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Pass.</span>
                  <button
                    type="button"
                    id="climate-sync-btn"
                    onClick={() => {
                      const next = !climateSync;
                      setClimateSync(next);
                      if (next) setPassengerTemp(driverTemp);
                      triggerNotice(next ? 'Dual Climate Synced' : 'Dual Climate Independent');
                    }}
                    className={`text-[9px] px-1 rounded font-mono ${climateSync ? 'bg-cyan-900 text-cyan-200' : 'text-slate-500'}`}
                  >
                    SYNC
                  </button>
                </div>
                <span className="text-2xl font-bold font-mono text-white tracking-tight">
                  {passengerTemp}°{tempUnit}
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    id="pass-temp-down"
                    onClick={() => adjustTemp(false, -1)}
                    className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center font-bold text-sm"
                  >
                    -
                  </button>
                  <button
                    type="button"
                    id="pass-temp-up"
                    onClick={() => adjustTemp(false, 1)}
                    className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center font-bold text-sm"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Blower Fan Speed Stepper */}
            <div className="space-y-1.5 pt-1">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-1">
                  <Fan className={`w-3.5 h-3.5 ${fanSpeed > 0 && hvacPower ? 'text-cyan-400 animate-spin' : 'text-slate-500'}`} style={{ animationDuration: `${Math.max(0.4, 2.5 - fanSpeed * 0.25)}s` }} />
                  <span>Fan Speed</span>
                </span>
                <span className="font-mono font-bold text-slate-200">{fanSpeed === 0 ? 'Off' : `Level ${fanSpeed}`}</span>
              </div>
              <div className="grid grid-cols-8 gap-1">
                {[1, 2, 3, 4, 5, 6, 7, 8].map(step => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => {
                      setFanSpeed(step);
                      triggerNotice(`Fan Speed: Level ${step}`);
                    }}
                    className={`h-6 rounded text-[10px] font-mono font-bold transition-colors ${
                      fanSpeed >= step && hvacPower
                        ? 'bg-cyan-500 text-slate-950'
                        : 'bg-slate-900 text-slate-500 hover:bg-slate-800'
                    }`}
                  >
                    {step}
                  </button>
                ))}
              </div>
            </div>

            {/* Airflow Direction Modes */}
            <div className="grid grid-cols-4 gap-1.5 pt-1 text-xs">
              {(['auto', 'face', 'face_feet', 'defog'] as AirflowMode[]).map(mode => (
                <button
                  key={mode}
                  type="button"
                  id={`airflow-btn-${mode}`}
                  onClick={() => {
                    setAirflow(mode);
                    triggerNotice(`Airflow Mode: ${mode.replace('_', ' ').toUpperCase()}`);
                  }}
                  className={`py-1.5 rounded-lg text-[10px] font-medium uppercase border transition-colors ${
                    airflow === mode
                      ? 'bg-slate-800 text-cyan-300 border-cyan-700/60 font-bold'
                      : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {mode.replace('_', ' ')}
                </button>
              ))}
            </div>

            {/* Quick Climate Toggles (Defrost, Recirc, Wheel) */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/60 text-xs">
              <button
                type="button"
                id="front-defrost-btn"
                onClick={() => {
                  setFrontDefrost(f => !f);
                  triggerNotice(frontDefrost ? 'Front Defrost Off' : 'Front Defrost MAX Active');
                }}
                className={`p-2 rounded-xl border text-center transition-colors ${
                  frontDefrost
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-700'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block font-semibold">Front Defrost</span>
                <span className="text-[11px] font-bold">{frontDefrost ? 'ON' : 'Off'}</span>
              </button>

              <button
                type="button"
                id="rear-defrost-btn"
                onClick={() => {
                  const next = !rearDefrost;
                  setRearDefrost(next);
                  dispatchCommand('rear_defroster', next ? 'on' : 'off', next ? 'Rear Defrost Activated' : 'Rear Defrost Deactivated');
                }}
                className={`p-2 rounded-xl border text-center transition-colors ${
                  rearDefrost
                    ? 'bg-red-950 text-red-300 border-red-700'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block font-semibold">Rear Defrost</span>
                <span className="text-[11px] font-bold">{rearDefrost ? 'ON' : 'Off'}</span>
              </button>

              <button
                type="button"
                id="steering-wheel-heat-btn"
                onClick={cycleSteeringHeat}
                className={`p-2 rounded-xl border text-center transition-colors ${
                  steeringWheelHeat !== 'off'
                    ? 'bg-amber-950 text-amber-300 border-amber-700'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block font-semibold">Heated Wheel</span>
                <span className="text-[11px] font-bold uppercase">{steeringWheelHeat}</span>
              </button>
            </div>

            {/* Seat Comfort Steppers */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800/60 text-xs">
              <button
                type="button"
                id="driver-seat-comfort-btn"
                onClick={() => cycleSeat(driverSeat, true)}
                className={`p-2.5 rounded-xl border text-left transition-colors ${
                  driverSeat.startsWith('heat')
                    ? 'bg-red-950/70 text-red-300 border-red-700/80'
                    : driverSeat.startsWith('cool')
                    ? 'bg-sky-950/70 text-sky-300 border-sky-700/80'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block font-semibold opacity-75">Driver Seat</span>
                <span className="font-bold font-mono">{driverSeat.replace('_', ' ').toUpperCase()}</span>
              </button>

              <button
                type="button"
                id="pass-seat-comfort-btn"
                onClick={() => cycleSeat(passengerSeat, false)}
                className={`p-2.5 rounded-xl border text-left transition-colors ${
                  passengerSeat.startsWith('heat')
                    ? 'bg-red-950/70 text-red-300 border-red-700/80'
                    : passengerSeat.startsWith('cool')
                    ? 'bg-sky-950/70 text-sky-300 border-sky-700/80'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                <span className="text-[10px] block font-semibold opacity-75">Pass. Seat</span>
                <span className="font-bold font-mono">{passengerSeat.replace('_', ' ').toUpperCase()}</span>
              </button>
            </div>
          </div>

          {/* Live CAN Telemetry Inspector Stream */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-emerald-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Live CAN Telemetry</h3>
              </div>
              <span className="text-[10px] font-mono text-slate-400">E-GMP Bus 0</span>
            </div>

            {/* Decoded CAN Stream */}
            <div className="h-56 overflow-y-auto space-y-2 pr-1 font-mono text-xs">
              {recentCanLogs.length === 0 ? (
                <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/60 text-slate-400 text-center text-xs">
                  Awaiting live CAN frames...
                  <div className="mt-1 text-[11px] text-slate-500">
                    {isSimulating ? 'Generating simulated TWAI bus packets' : 'Listening on /ws'}
                  </div>
                </div>
              ) : (
                recentCanLogs.map((log, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-xl bg-slate-900/70 border border-slate-800/80 text-[11px] space-y-1 hover:border-slate-700 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-cyan-300">{log.id}</span>
                      <span className="text-[10px] text-slate-400">{log.name}</span>
                    </div>
                    <div className="text-slate-200 font-sans font-medium">{log.decoded}</div>
                    <div className="text-[10px] text-slate-400 truncate">
                      Hex: <span className="text-slate-300">{log.raw}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Quick Catalog Link */}
            {onNavigateToCatalog && (
              <button
                type="button"
                onClick={() => onNavigateToCatalog('climate')}
                className="w-full py-2 px-3 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 flex items-center justify-center gap-1.5 transition-colors"
              >
                <span>Browse CAN Messages in Catalog</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

        </div>

      </div>
    </div>
  );
};
