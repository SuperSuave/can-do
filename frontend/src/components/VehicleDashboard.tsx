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
  Maximize2,
  Activity
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
  const [odometer, setOdometer] = useState<number>(() => (unitSystem === 'metric' ? 87147 : 54147));
  const [ambientTempC, setAmbientTempC] = useState<number>(22.0); // 71.6°F
  const [tempUnit, setTempUnit] = useState<'F' | 'C'>(() => (unitSystem === 'metric' ? 'C' : 'F'));

  const prevUnitRef = useRef(unitSystem);
  useEffect(() => {
    if (unitSystem) {
      setTempUnit(unitSystem === 'metric' ? 'C' : 'F');
      if (prevUnitRef.current && prevUnitRef.current !== unitSystem) {
        if (unitSystem === 'metric') {
          setOdometer(prev => Math.round(prev * 1.609344));
        } else {
          setOdometer(prev => Math.round(prev * 0.621371192));
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
  const [soc, setSoc] = useState<number>(() => {
    const saved = localStorage.getItem('cando_last_soc');
    return saved ? parseFloat(saved) : 78.5;
  });
  const [isCharging, setIsCharging] = useState(false);
  const [chargeRateKw, setChargeRateKw] = useState<number>(0);
  const [chargeLimit, setChargeLimit] = useState<number>(80);
  const [batteryMinTempC, setBatteryMinTempC] = useState<number>(23.0);
  const [batteryMaxTempC, setBatteryMaxTempC] = useState<number>(24.5);
  const [aux12V, setAux12V] = useState<number>(() => {
    const saved = localStorage.getItem('cando_last_aux12v');
    return saved ? parseFloat(saved) : 13.8;
  });

  // Deep BMS Telemetry (Safe UDS Engine)
  const [hvPowerKw, setHvPowerKw] = useState<number | null>(null);
  const [hvVoltage, setHvVoltage] = useState<number | null>(null);
  const [hvCurrent, setHvCurrent] = useState<number | null>(null);
  const [cellDeltaMv, setCellDeltaMv] = useState<number | null>(null);

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
  const [framesCount, setFramesCount] = useState<number>(0);
  const [lastRxTimestamp, setLastRxTimestamp] = useState<string | null>(null);
  const [speedKph, setSpeedKph] = useState<number>(0);
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

  // Estimated driving range dynamically calculated based on active vehicle's battery pack & SOC
  const estimatedRangeMiles = useMemo(() => {
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

    const gearCmd = findCmd('selected_gear');
    const gearOptions = gearCmd?.options || [];

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
      gear: getCanId('selected_gear', '2c0'),
      gearName: gearCmd?.ha_metadata?.name || 'Gear Selector',
      gearOptions,
      doors: getCanId('doors_status', '411'),
      doorsName: findCmd('doors_status')?.ha_metadata?.name || 'Body Closures & Doors',
      locks: getCanId('doors_lock_state', '411'),
      locksName: findCmd('doors_lock_state')?.ha_metadata?.name || 'Door Locks & Security',
      trunk: getCanId('trunk', '414'),
      trunkName: findCmd('trunk')?.ha_metadata?.name || 'Power Liftgate / Trunk',
      hood: getCanId('hood', '411'),
      hoodName: findCmd('hood')?.ha_metadata?.name || 'Frunk / Hood Latch',
      chargePort: getCanId('charge_port', '3aa'),
      chargePortName: findCmd('charge_port')?.ha_metadata?.name || 'Charge Port Door',
      charging: getCanId('cond_charging', '594'),
      chargingName: findCmd('cond_charging')?.ha_metadata?.name || 'EV Charging Status',
      odometer: getCanId('vehicle_odometer', '227'),
      odometerName: findCmd('vehicle_odometer')?.ha_metadata?.name || 'Odometer',
      climateTarget: getCanId('climate_dual_cabin_temp', '380'),
      climateTargetName: findCmd('climate_dual_cabin_temp')?.ha_metadata?.name || 'Cabin Target Temp',
      defrost: getCanId('climate_rear_defog', '541'),
      defrostName: findCmd('climate_rear_defog')?.ha_metadata?.name || 'Rear Defroster',
      hazards: getCanId('hazard_lights', '541'),
      hazardsName: findCmd('hazard_lights')?.ha_metadata?.name || 'Hazard Flashers',
      steeringHeat: getCanId('heated_steering_wheel_toggle', '418'),
      steeringHeatName: findCmd('heated_steering_wheel_toggle')?.ha_metadata?.name || 'Steering Wheel Heat',
      driverSeat: getCanId('drivers_seat_comfort', '496'),
      driverSeatName: findCmd('drivers_seat_comfort')?.ha_metadata?.name || 'Driver Seat Comfort',
      passengerSeat: getCanId('passengers_seat_comfort', '475'),
      passengerSeatName: findCmd('passengers_seat_comfort')?.ha_metadata?.name || 'Passenger Seat Comfort',
      fanBlower: getCanId('climate_fan_speed_level', '31b'),
      fanBlowerName: findCmd('climate_fan_speed_level')?.ha_metadata?.name || 'HVAC Blower / Vents',
      tpms: getCanId('wheel_speeds', '593'),
      tpmsName: findCmd('wheel_speeds')?.ha_metadata?.name || 'TPMS Tire Pressures',
      sunroof: getCanId('sunroof_extended', '442'),
      sunroofName: findCmd('sunroof_extended')?.ha_metadata?.name || 'Sunroof Glass & Cover',
    };
  }, [catalog]);

  // Temporary feedback toast
  const triggerNotice = (msg: string) => {
    setFeedbackNotice(msg);
    setTimeout(() => {
      setFeedbackNotice(null);
    }, 2800);
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
      dispatchCommand('sunroof_extended', nextShade, `Power Sunshade: ${nextShade === 'open' ? 'Retracted' : 'Closed'}`);
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
      // Offline / standalone browser preview mode
    }
  };

  const recordLog = (id: string, name: string, decoded: string, raw: string, timestamp: string) => {
    setRecentCanLogs(prev => [
      { id, name, decoded, raw, timestamp },
      ...prev.slice(0, 19)
    ]);
  };

  // Parser for high-level catalog entity states (broadcast via WebSocket or fetched via /api/states)
  const handleIncomingEntityState = (entity: string, stateStr: string) => {
    const normState = stateStr.toLowerCase();
    if (entity === 'doors_status') {
      if (normState.includes('driver door opened')) setDoors(d => ({ ...d, frontLeft: true }));
      else if (normState.includes('driver door closed')) setDoors(d => ({ ...d, frontLeft: false }));
      if (normState.includes('passenger door opened')) setDoors(d => ({ ...d, frontRight: true }));
      else if (normState.includes('passenger door closed')) setDoors(d => ({ ...d, frontRight: false }));
      if (normState.includes('rear left door opened')) setDoors(d => ({ ...d, rearLeft: true }));
      else if (normState.includes('rear left door closed')) setDoors(d => ({ ...d, rearLeft: false }));
      if (normState.includes('rear right door opened')) setDoors(d => ({ ...d, rearRight: true }));
      else if (normState.includes('rear right door closed')) setDoors(d => ({ ...d, rearRight: false }));
    } else if (entity === 'doors_lock_state') {
      setLocked(normState.includes('lock') && !normState.includes('unlock'));
    } else if (entity === 'trunk') {
      setTrunkOpen(normState.includes('open'));
    } else if (entity === 'hood') {
      setHoodOpen(normState.includes('open'));
    } else if (entity === 'charge_port') {
      setChargePortOpen(normState.includes('open'));
    } else if (entity === 'selected_gear') {
      if (normState.includes('park') || normState === 'p') setGear('P');
      else if (normState.includes('reverse') || normState === 'r') setGear('R');
      else if (normState.includes('neutral') || normState === 'n') setGear('N');
      else if (normState.includes('drive') || normState === 'd') setGear('D');
    } else if (entity === 'cond_charging') {
      setIsCharging(normState.includes('true') || normState.includes('on') || normState.includes('active') || normState.includes('charging') || normState.includes('plugged'));
    } else if (entity === 'drivers_seat_comfort') {
      if (normState.includes('high heat')) setDriverSeat('heat_high');
      else if (normState.includes('medium heat')) setDriverSeat('heat_med');
      else if (normState.includes('low heat')) setDriverSeat('heat_low');
      else if (normState.includes('high cool')) setDriverSeat('cool_high');
      else if (normState.includes('medium cool')) setDriverSeat('cool_med');
      else if (normState.includes('low cool')) setDriverSeat('cool_low');
      else setDriverSeat('off');
    } else if (entity === 'passengers_seat_comfort') {
      if (normState.includes('high heat')) setPassengerSeat('heat_high');
      else if (normState.includes('medium heat')) setPassengerSeat('heat_med');
      else if (normState.includes('low heat')) setPassengerSeat('heat_low');
      else if (normState.includes('high cool')) setPassengerSeat('cool_high');
      else if (normState.includes('medium cool')) setPassengerSeat('cool_med');
      else if (normState.includes('low cool')) setPassengerSeat('cool_low');
      else setPassengerSeat('off');
    } else if (entity === 'heated_steering_wheel_toggle' || entity === 'heated_wheel_btn') {
      if (normState.includes('high')) setSteeringWheelHeat('high');
      else if (normState.includes('low')) setSteeringWheelHeat('low');
      else setSteeringWheelHeat('off');
    } else if (entity === 'hazard_lights') {
      setHazards(normState.includes('active') || normState.includes('on'));
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
      setRearDefrost(normState.includes('active') || normState.includes('on'));
    } else if (entity === 'cond_hv_battery_soc' || entity.includes('battery_soc')) {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) {
        const s = parseFloat(match[1]);
        if (s >= 0 && s <= 100) {
          setSoc(s);
          try { localStorage.setItem('cando_last_soc', String(s)); } catch {}
        }
      }
    } else if (entity === 'cond_aux_12v_battery' || entity.includes('12v') || entity === 'aux_12v') {
      const match = stateStr.match(/(\d+(\.\d+)?)/);
      if (match) {
        const v = parseFloat(match[1]);
        if (v >= 8 && v <= 16.5) {
          setAux12V(v);
          try { localStorage.setItem('cando_last_aux12v', String(v)); } catch {}
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
      const match = stateStr.match(/(\d+)/);
      if (match) setOdometer(parseInt(match[1], 10));
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
    }
  };

  // 1. Initial State Synchronization via /api/states REST endpoint
  useEffect(() => {
    let cancelled = false;
    const fetchCurrentStates = async () => {
      try {
        const baseUrl = resolveDeviceBaseUrl();
        const res = await fetch(`${baseUrl}/api/states`);
        if (res.ok && !cancelled) {
          const states: Array<{ entity: string; state: string }> = await res.json();
          if (Array.isArray(states)) {
            states.forEach(item => {
              if (item?.entity && item?.state) {
                handleIncomingEntityState(item.entity, item.state);
              }
            });
          }
        }
      } catch {
        // Device offline or standalone browser preview
      }
    };
    fetchCurrentStates();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Real-time WebSocket connection to physical CAN Do device
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
          triggerNotice('Connected to live CAN Do vehicle telemetry stream');
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'can_frame') {
              handleIncomingCanFrame(data.id, data.data || '');
            } else if (data.type === 'state' && data.entity && data.state) {
              handleIncomingEntityState(data.entity, data.state);
            }
          } catch {
            // Ignore non-json frames
          }
        };

        ws.onclose = () => {
          setConnectedDevice(false);
          reconnectTimeout = setTimeout(connect, 5000);
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

  // Smooth simulation loop when in preview/bench mode and no live vehicle CAN traffic
  useEffect(() => {
    if (connectedDevice && framesCount > 0) return;
    if (gear !== 'D') return;

    const interval = setInterval(() => {
      setSpeedMph(prev => Math.min(75, Math.max(35, prev + Math.floor(Math.random() * 3 - 1))));
      setSpeedKph(prev => Math.min(120, Math.max(56, prev + Math.floor(Math.random() * 5 - 2))));
    }, 1200);

    return () => clearInterval(interval);
  }, [connectedDevice, framesCount, gear]);

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
      setSpeedKph(kph);
      setSpeedMph(mph);
      recordLog(idFormatted, canMappings.speedName, `${kph} km/h (${mph} mph)`, hexPayload, now);
    } else if ((normId === canMappings.wheelSpeeds || normId === '0a2' || normId === 'a2') && bytes.length >= 2) {
      const rawW1 = bytes[0] | (bytes[1] << 8);
      const kph = Math.round(rawW1 * 0.03125 * 10) / 10;
      const mph = Math.round(kph * 0.621371);
      setSpeedKph(kph);
      setSpeedMph(mph);
      recordLog(idFormatted, 'Wheel Speed Telemetry', `${kph} km/h (${mph} mph)`, hexPayload, now);
    } else if (normId === '1a0' && bytes.length >= 2) {
      const kph = Math.round(((bytes[0] | (bytes[1] << 8)) * 0.03125) * 10) / 10;
      const mph = Math.round(kph * 0.621371);
      setSpeedKph(kph);
      setSpeedMph(mph);
      recordLog(idFormatted, 'ESC Road Speed', `${kph} km/h (${mph} mph)`, hexPayload, now);
    }

    // Ambient Outdoor Temperature (Dynamically mapped from catalog, e.g. 0x226)
    else if ((normId === canMappings.ambientTemp || normId === '226') && bytes.length >= 4) {
      const raw = bytes[3];
      if (raw > 0 && raw < 255) {
        const c = raw - 40;
        setAmbientTempC(c);
        recordLog(idFormatted, canMappings.ambientTempName, `${c}°C (${Math.round(c * 1.8 + 32)}°F)`, hexPayload, now);
      }
    }

    // HV Traction Battery SOC (Dynamically mapped from catalog, e.g. 0x2FC)
    else if ((normId === canMappings.hvSoc || normId === '2fc') && bytes.length >= 8) {
      const raw = bytes[7];
      const newSoc = Math.round(raw * 0.5 * 10) / 10;
      if (newSoc >= 0 && newSoc <= 100) {
        setSoc(newSoc);
        try { localStorage.setItem('cando_last_soc', String(newSoc)); } catch {}
        recordLog(idFormatted, canMappings.hvSocName, `${newSoc}%`, hexPayload, now);
      }
    }

    // 12V Aux Battery Voltage (Dynamically mapped from catalog e.g. 0x1CF Byte D6 [index 5] or 0x594 Byte D5 [index 4] = factor 0.1 V)
    else if ((normId === canMappings.aux12v || normId === '1cf' || normId === '594') && bytes.length >= 5) {
      const vByte = bytes.length >= 6 ? bytes[5] : bytes[4];
      const v = Math.round(vByte * 0.1 * 10) / 10;
      if (v >= 8.0 && v <= 16.5) {
        setAux12V(v);
        try { localStorage.setItem('cando_last_aux12v', String(v)); } catch {}
        recordLog(idFormatted, canMappings.aux12vName, `${v} V`, hexPayload, now);
      }
    }

    // BMS Module Min/Max Temperatures (Dynamically mapped from catalog, e.g. 0x152)
    else if ((normId === canMappings.hvTemps || normId === '152') && bytes.length >= 2) {
      const minT = bytes[0];
      const maxT = bytes[1];
      setBatteryMinTempC(minT);
      setBatteryMaxTempC(maxT);
      recordLog(idFormatted, canMappings.hvTempsName, `Min: ${minT}°C / Max: ${maxT}°C`, hexPayload, now);
    }

    // Transmission Gear Selection (Dynamically mapped from catalog, e.g. 0x2C0, 0x220, 0x316, 0x321)
    else if ((normId === canMappings.gear || normId === '2c0' || normId === '220' || normId === '316' || normId === '321') && bytes.length >= 1) {
      let detectedGear: GearMode | null = null;
      if (canMappings.gearOptions && canMappings.gearOptions.length > 0) {
        for (const opt of canMappings.gearOptions) {
          const lbl = (opt.label || '').toLowerCase();
          let targetGear: GearMode | null = null;
          if (lbl.includes('(p)') || lbl.includes('park')) targetGear = 'P';
          else if (lbl.includes('(r)') || lbl.includes('reverse')) targetGear = 'R';
          else if (lbl.includes('(n)') || lbl.includes('neutral')) targetGear = 'N';
          else if (lbl.includes('(d)') || lbl.includes('drive')) targetGear = 'D';

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

      const finalGear: GearMode = detectedGear || 'P';
      setGear(finalGear);
      if (finalGear === 'P') {
        setSpeedMph(0);
        setSpeedKph(0);
      }
      recordLog(idFormatted, canMappings.gearName, `Position: ${finalGear}`, hexPayload, now);
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
      recordLog(idFormatted, canMappings.doorsName, `Doors: ${fl || fr || rl || rr ? 'Ajar' : 'Latched'}, Locks: ${isLocked ? 'Locked' : 'Unlocked'}`, hexPayload, now);
    }

    // Tailgate / Trunk Status (Dynamically mapped from catalog, e.g. 0x414)
    else if ((normId === canMappings.trunk || normId === '414') && bytes.length >= 4) {
      const tr = Boolean(bytes[3] & 0x01);
      setTrunkOpen(tr);
      recordLog(idFormatted, canMappings.trunkName, tr ? 'OPEN' : 'Closed', hexPayload, now);
    }

    // EV Charge Port Door (Dynamically mapped from catalog, e.g. 0x3AA)
    else if ((normId === canMappings.chargePort || normId === '3aa') && bytes.length >= 5) {
      const cp = Boolean(bytes[4] & 0x02);
      setChargePortOpen(cp);
      recordLog(idFormatted, canMappings.chargePortName, cp ? 'OPEN' : 'Closed', hexPayload, now);
    }

    // EV Charging Status & Grid Interconnect (Dynamically mapped from catalog, e.g. 0x594)
    else if ((normId === canMappings.charging || normId === '594') && bytes.length >= 3) {
      const charging = Boolean(bytes[2] & 0x01);
      setIsCharging(charging);
      if (!charging) setChargeRateKw(0);
      recordLog(idFormatted, canMappings.chargingName, charging ? 'ACTIVE / PLUGGED IN' : 'INACTIVE', hexPayload, now);
    }

    // Odometer (Dynamically mapped from catalog, e.g. 0x227: D2-D4 24-bit LE in 0.1 km units)
    else if ((normId === canMappings.odometer || normId === '227') && bytes.length >= 4) {
      const rawOdo = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16);
      if (rawOdo > 0) {
        const km = rawOdo * 0.1;
        const mi = Math.round(km * 0.621371192);
        const displayOdo = unitSystem === 'metric' ? Math.round(km) : mi;
        setOdometer(displayOdo);
        recordLog(idFormatted, canMappings.odometerName, `${displayOdo.toLocaleString()} ${unitSystem === 'metric' ? 'km' : 'mi'}`, hexPayload, now);
      }
    }

    // Cabin Target Temperatures (Dynamically mapped from catalog, e.g. 0x380)
    else if (normId === canMappings.climateTarget && bytes.length >= 3) {
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
      recordLog(idFormatted, canMappings.climateTargetName, `Driver: ${bytes[1]} / Pass: ${bytes[2]}`, hexPayload, now);
    }

    // Rear Defroster (Dynamically mapped from catalog, e.g. 0x541 with D5 match 0x10 mask 0xF0)
    else if (normId === canMappings.defrost && bytes.length >= 5) {
      const def = (bytes[4] & 0xF0) === 0x10;
      setRearDefrost(def);
      recordLog(idFormatted, canMappings.defrostName, def ? 'DEFROST ON' : 'DEFROST OFF', hexPayload, now);
    }

    // Hazard Flashers
    else if (normId === canMappings.hazards && bytes.length >= 5) {
      const haz = Boolean(bytes[4] & 0x20);
      setHazards(haz);
      recordLog(idFormatted, canMappings.hazardsName, haz ? 'HAZARDS ON' : 'HAZARDS OFF', hexPayload, now);
    }

    // Heated Steering Wheel (Dynamically mapped from catalog, e.g. 0x418)
    else if (normId === canMappings.steeringHeat && bytes.length >= 1) {
      const val = bytes[0] & 0x03;
      const levels: SteeringHeatLevel[] = ['off', 'low', 'high'];
      const lvl = levels[val] || 'off';
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
      setSunroof(prev => ({ ...prev, equipped: true, state: sState }));
      recordLog(idFormatted, canMappings.sunroofName, `Sunroof State: ${sState.toUpperCase()}`, hexPayload, now);
    }

    // Headlight & Turn Signal Stalk (Dynamically mapped from catalog, e.g. 0x3C1)
    else if ((normId === '3c1' || normId === 'turn_signal') && bytes.length >= 1) {
      const b0 = bytes[0];
      const leftBlink = Boolean(b0 & 0x01);
      const rightBlink = Boolean(b0 & 0x02);
      if (leftBlink && !rightBlink) setTurnSignal('left');
      else if (rightBlink && !leftBlink) setTurnSignal('right');
      else setTurnSignal('off');
      recordLog(idFormatted, 'Turn Signal & Light Stalk', `Turn Signal: ${leftBlink ? 'Left' : rightBlink ? 'Right' : 'Off'}`, hexPayload, now);
    }

    // Driver Seat Comfort (Dynamically mapped from catalog, e.g. 0x496)
    else if (normId === canMappings.driverSeat && bytes.length >= 1) {
      const b = bytes[0];
      let lvl: SeatLevel = 'off';
      if (b === 0x0E) lvl = 'heat_low';
      else if (b === 0x0A) lvl = 'heat_med';
      else if (b === 0x02) lvl = 'heat_high';
      else if (b === 0x14) lvl = 'cool_low';
      else if (b === 0x12) lvl = 'cool_med';
      else if (b === 0x10) lvl = 'cool_high';
      setDriverSeat(lvl);
      recordLog(idFormatted, canMappings.driverSeatName, lvl, hexPayload, now);
    }

    // Passenger Seat Comfort (Dynamically mapped from catalog, e.g. 0x475)
    else if (normId === canMappings.passengerSeat && bytes.length >= 1) {
      const b = bytes[0];
      let lvl: SeatLevel = 'off';
      if (b === 0x0E) lvl = 'heat_low';
      else if (b === 0x0A) lvl = 'heat_med';
      else if (b === 0x02) lvl = 'heat_high';
      else if (b === 0x14) lvl = 'cool_low';
      else if (b === 0x12) lvl = 'cool_med';
      else if (b === 0x10) lvl = 'cool_high';
      setPassengerSeat(lvl);
      recordLog(idFormatted, canMappings.passengerSeatName, lvl, hexPayload, now);
    }

    // HVAC Blower Fan Speed & Airflow (Dynamically mapped from catalog, e.g. 0x31B)
    else if (normId === canMappings.fanBlower && bytes.length >= 4) {
      const fanRaw = bytes[3] & 0x0F;
      const speed = fanRaw >= 2 && fanRaw <= 9 ? fanRaw - 1 : 0;
      setFanSpeed(speed);
      if (bytes.length >= 5) {
        setRecirc(Boolean(bytes[4] & 0x40));
      }
      recordLog(idFormatted, canMappings.fanBlowerName, `Fan ${speed}`, hexPayload, now);
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

    // Metrics counter
    setFramesCount(prev => prev + 1);
    setLastRxTimestamp(now);
  };

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
  const cycleSeat = (current: SeatLevel, isDriver: boolean) => {
    const hasHeat = equippedFeatures.has('heated_seats');
    const hasCool = equippedFeatures.has('ventilated_seats');

    if (!hasHeat && !hasCool) {
      triggerNotice('Seat heating / ventilation is not equipped on this trim');
      return;
    }

    let cycle: SeatLevel[] = ['off'];
    if (hasHeat) cycle = cycle.concat(['heat_low', 'heat_med', 'heat_high']);
    if (hasCool) cycle = cycle.concat(['cool_low', 'cool_med', 'cool_high']);

    const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
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

  const cycleSteeringHeat = () => {
    if (!equippedFeatures.has('heated_wheel')) {
      triggerNotice('Heated steering wheel is not equipped on this trim');
      return;
    }
    const next: SteeringHeatLevel = steeringWheelHeat === 'off' ? 'low' : steeringWheelHeat === 'low' ? 'high' : 'off';
    setSteeringWheelHeat(next);
    dispatchCommand('heated_steering_wheel_toggle', next === 'off' ? 'Off' : 'Toggle', `Heated Steering Wheel: ${next.toUpperCase()}`);
  };

  const adjustTemp = (isDriver: boolean, delta: number) => {
    const minT = tempUnit === 'C' ? 17 : 62;
    const maxT = tempUnit === 'C' ? 32 : 86;
    if (isDriver) {
      const next = Math.max(minT, Math.min(maxT, driverTemp + delta));
      setDriverTemp(next);
      if (climateSync) setPassengerTemp(next);
      dispatchCommand('climate_driver_temp', `${next}`, `Driver Target Temp: ${next}°${tempUnit}`);
    } else {
      const next = Math.max(minT, Math.min(maxT, passengerTemp + delta));
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
      {/* 1. Header Toolbar: Vehicle ID, Specs, Telemetry Status */}
      <header className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 p-4 sm:p-5 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-slate-800/90 border border-slate-700/80 flex items-center justify-center text-cyan-400 shrink-0 shadow-inner">
            <Car className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base sm:text-lg font-bold text-white tracking-tight">
                {activeVehicle ? `${activeVehicle.make} ${activeVehicle.model} ${activeVehicle.trim || ''}`.trim() : `${EGMP_MODELS[selectedModel].brand} ${EGMP_MODELS[selectedModel].name}`}
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium tracking-wide text-cyan-300 bg-cyan-950/80 border border-cyan-800/60">
                {activeVehicle?.region ? activeVehicle.region.toUpperCase() : EGMP_MODELS[selectedModel].badge}
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
              <span className="font-mono">{odometer.toLocaleString()} {unitSystem === 'metric' ? 'km' : 'mi'}</span>
              <span>•</span>
              <span className="inline-flex items-center gap-1">
                <Thermometer className="w-3 h-3 text-slate-400" />
                <span>{displayAmbient}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded font-medium border ${ambientThreshold.color}`}>
                  {ambientThreshold.label}
                </span>
              </span>
              <span>•</span>
              <span className="font-mono text-slate-300">
                {unitSystem === 'metric' ? `${speedKph} km/h` : `${speedMph} MPH`}
              </span>
            </div>
          </div>
        </div>

        {/* Perspective Selector & Live Telemetry Badge */}
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 w-full lg:w-auto justify-between lg:justify-end">
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

          {/* Live CAN Telemetry Connection Badge */}
          <div className="flex items-center gap-2">
            <div
              id="live-can-status-badge"
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-2 border transition-all ${
                connectedDevice
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60 shadow-sm'
                  : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${connectedDevice ? 'bg-emerald-400 animate-pulse' : 'bg-amber-500'}`} />
              <span>{connectedDevice ? 'Vehicle CAN Online' : 'Awaiting CAN Traffic'}</span>
              {framesCount > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-900/80 text-emerald-200 border border-emerald-700/50">
                  {framesCount.toLocaleString()} frames
                </span>
              )}
            </div>
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

      {/* 2. Main Cockpit Grid: Unified Vehicle Overview & Outlines + Climate & CAN Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        
        {/* Main Vehicle Column: Unified Vehicle Outline Card (HV Battery, Shifter, Closures & Diagram) */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-4">
          <div
            id="unified-vehicle-cockpit-card"
            className="relative p-4 sm:p-6 rounded-2xl bg-[var(--md-sys-color-surface-container)] border border-[var(--border-color)] shadow-sm space-y-5"
          >
            {/* Top Toolbar: Gear Selector, Lock/Unlock Security & Lighting Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-slate-800/80">
              {/* Transmission Gear Selector */}
              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/90 border border-slate-800 shadow-inner">
                  {(['P', 'R', 'N', 'D'] as GearMode[]).map((g) => {
                    const active = gear === g;
                    return (
                      <button
                        key={g}
                        id={`gear-selector-${g}`}
                        type="button"
                        onClick={() => {
                          setGear(g);
                          if (g === 'D') {
                            setSpeedMph(prev => (prev === 0 ? 35 : prev));
                            setSpeedKph(prev => (prev === 0 ? 56 : prev));
                          }
                          if (g === 'P') {
                            setSpeedMph(0);
                            setSpeedKph(0);
                          }
                          dispatchCommand('selected_gear', g, `Shifted Transmission to ${g}`);
                        }}
                        title={`Vehicle Transmission Gear: ${g} (CAN 0x${canMappings.gear.toUpperCase()})`}
                        className={`w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center transition-all ${
                          active
                            ? 'bg-cyan-500 text-slate-950 shadow-md ring-1 ring-cyan-300 font-extrabold scale-105'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                        }`}
                      >
                        {g}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Transmission</span>
                  <span className="text-xs font-mono font-semibold text-cyan-300">
                    {gear === 'P' ? 'Parked' : gear === 'R' ? 'Reverse' : gear === 'N' ? 'Neutral' : 'Drive'}
                  </span>
                </div>
              </div>

              {/* Security Lock Toggle & Exterior Lighting Controls */}
              <div className="flex flex-wrap items-center gap-2">
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
                    dispatchCommand('doors_lock_state', next ? 'lock' : 'unlock', next ? 'All Doors Locked & Secured' : 'Vehicle Unlocked');
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 border transition-colors ${
                    locked
                      ? 'bg-slate-900/90 text-emerald-400 border-slate-800 hover:bg-slate-800'
                      : 'bg-amber-950/70 text-amber-300 border-amber-800/80 shadow-sm'
                  }`}
                >
                  {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  <span>{locked ? 'Vehicle Locked' : 'Unlocked'}</span>
                </button>

                {/* Headlights Mode Selector */}
                <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs">
                  {(['off', 'parking', 'low', 'high', 'auto'] as LightMode[]).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      id={`light-btn-${mode}`}
                      onClick={() => {
                        setLights(mode);
                        dispatchCommand('headlight_mode', mode, `Headlights: ${mode.toUpperCase()}`);
                      }}
                      className={`px-2 py-1 rounded-lg text-[11px] font-medium uppercase transition-colors ${
                        lights === mode
                          ? 'bg-slate-700 text-cyan-300 font-bold shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>

                {/* Hazards & Mirrors */}
                <button
                  type="button"
                  id="hazard-btn"
                  onClick={() => {
                    const nextHaz = !hazards;
                    setHazards(nextHaz);
                    dispatchCommand('hazard_lights', nextHaz ? 'on' : 'off', nextHaz ? 'Hazard Lights Blinking' : 'Hazard Lights Deactivated');
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
                    const nextMirrors = !mirrorsFolded;
                    setMirrorsFolded(nextMirrors);
                    dispatchCommand('mirrors', nextMirrors ? 'fold' : 'extend', nextMirrors ? 'Mirrors Folded' : 'Mirrors Extended');
                  }}
                  className={`px-2.5 py-1.5 rounded-xl border transition-colors text-[11px] font-medium ${
                    mirrorsFolded
                      ? 'bg-indigo-950 text-indigo-300 border-indigo-700'
                      : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {mirrorsFolded ? 'Mirrors Folded' : 'Fold Mirrors'}
                </button>
              </div>
            </div>

            {/* HV Traction Battery Info & Power Sub-Section */}
            <div className="p-3.5 sm:p-4 rounded-xl bg-slate-900/60 border border-slate-800/70 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <BatteryCharging className={`w-4 h-4 ${isCharging ? 'text-emerald-400 animate-pulse' : 'text-cyan-400'}`} />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Traction Battery</span>
                  <span
                    title={`Dynamically resolved CAN ID: 0x${canMappings.hvSoc.toUpperCase()}`}
                    className="text-xs font-mono font-bold text-white px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60"
                  >
                    {soc.toFixed(1)}%
                  </span>
                  {activeVehicle?.battery_kwh && (
                    <span className="text-[10px] font-mono text-slate-400">
                      ({activeVehicle.battery_kwh} kWh pack)
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* Charge Port Quick Toggle */}
                  <button
                    type="button"
                    id="charge-port-toggle-btn"
                    onClick={() => {
                      const next = !chargePortOpen;
                      setChargePortOpen(next);
                      if (next) setIsCharging(true);
                      else setIsCharging(false);
                      dispatchCommand('charge_port', next ? 'open' : 'close', next ? 'Charge Port Opened' : 'Charge Port Closed');
                    }}
                    title={`Dynamically resolved CAN ID: 0x${canMappings.chargePort.toUpperCase()}`}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      chargePortOpen
                        ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60'
                        : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    {chargePortOpen ? 'Charge Port: Open / Plugged' : 'Charge Port: Closed'}
                  </button>
                </div>
              </div>

              {/* Battery Progress Meter Bar */}
              <div className="space-y-1">
                <div className="h-3 w-full rounded-full bg-slate-950/90 p-0.5 border border-slate-800/80 relative overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      soc > 20 ? 'bg-gradient-to-r from-cyan-500 to-emerald-400' : 'bg-red-500'
                    }`}
                    style={{ width: `${soc}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                  <span>0%</span>
                  <span className="text-cyan-300 font-medium">Est. {estimatedRangeMiles} {unitSystem === 'metric' ? 'km' : 'mi'} Range</span>
                  <span>Limit: {chargeLimit}%</span>
                </div>
              </div>

              {/* Compact Battery & Aux Telemetry Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
                <div
                  title={`Dynamically resolved CAN ID: 0x${canMappings.charging.toUpperCase()}`}
                  className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50"
                >
                  <span className="text-[10px] uppercase text-slate-400 block font-semibold">Charge Status</span>
                  <span className={`font-mono font-bold ${isCharging ? 'text-emerald-400' : 'text-slate-300'}`}>
                    {isCharging ? `${chargeRateKw} kW DC` : 'Standby'}
                  </span>
                </div>
                <div
                  title={`Dynamically resolved CAN ID: 0x${canMappings.aux12v.toUpperCase()}`}
                  className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50"
                >
                  <span className="text-[10px] uppercase text-slate-400 block font-semibold">12V Aux Battery</span>
                  <span className="font-mono font-bold text-slate-300">{aux12V.toFixed(1)} V (OK)</span>
                </div>
                <div
                  title={`Dynamically resolved CAN ID: 0x${canMappings.hvTemps.toUpperCase()}`}
                  className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50"
                >
                  <span className="text-[10px] uppercase text-slate-400 block font-semibold">Pack Min Temp</span>
                  <span className="font-mono font-bold text-slate-300">
                    {tempUnit === 'F' ? `${Math.round(batteryMinTempC * 1.8 + 32)}°F` : `${batteryMinTempC}°C`}
                  </span>
                </div>
                <div
                  title={`Dynamically resolved CAN ID: 0x${canMappings.hvTemps.toUpperCase()}`}
                  className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50"
                >
                  <span className="text-[10px] uppercase text-slate-400 block font-semibold">Pack Max Temp</span>
                  <span className="font-mono font-bold text-slate-300">
                    {tempUnit === 'F' ? `${Math.round(batteryMaxTempC * 1.8 + 32)}°F` : `${batteryMaxTempC}°C`}
                  </span>
                </div>
                {hvPowerKw !== null && (
                  <div className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50">
                    <span className="text-[10px] uppercase text-slate-400 block font-semibold">Live Pack Power</span>
                    <span className={`font-mono font-bold ${hvPowerKw < 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {hvPowerKw > 0 ? `+${hvPowerKw.toFixed(1)}` : hvPowerKw.toFixed(1)} kW
                    </span>
                  </div>
                )}
                {cellDeltaMv !== null && (
                  <div className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50">
                    <span className="text-[10px] uppercase text-slate-400 block font-semibold">Cell Delta</span>
                    <span className="font-mono font-bold text-cyan-300">{cellDeltaMv.toFixed(0)} mV</span>
                  </div>
                )}
                {hvVoltage !== null && (
                  <div className="p-2 rounded-lg bg-slate-950/50 border border-slate-800/50">
                    <span className="text-[10px] uppercase text-slate-400 block font-semibold">HV Bus Voltage</span>
                    <span className="font-mono font-bold text-slate-300">{hvVoltage.toFixed(0)} V {hvCurrent !== null ? `(${hvCurrent.toFixed(1)} A)` : ''}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Central Vehicle Silhouette Visual Stage with Projections & TPMS */}
            <div className="relative py-2 overflow-hidden flex flex-col items-center justify-center min-h-[500px]">
              {/* Headlight beam projections (visible when low or high or auto in Drive) */}
              {(lights === 'low' || lights === 'high' || (lights === 'auto' && gear === 'D')) && (
                <div
                  className={`absolute -top-12 w-64 h-36 bg-gradient-to-t from-cyan-400/20 via-cyan-300/5 to-transparent pointer-events-none blur-xl transition-opacity duration-500 ${
                    lights === 'high' ? 'opacity-80 scale-125' : 'opacity-40'
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
                  dispatchCommand('trunk', 'toggle', trunkOpen ? 'Trunk Closed' : 'Liftgate Opened');
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

              {/* TPMS Floating Badges Anchored Beside Tires */}
              <div className="absolute top-16 left-2 sm:left-6 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">FL TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.fl} PSI</span>
              </div>

              <div className="absolute top-16 right-2 sm:right-6 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">FR TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.fr} PSI</span>
              </div>

              <div className="absolute bottom-20 left-2 sm:left-6 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">RL TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.rl} PSI</span>
              </div>

              <div className="absolute bottom-20 right-2 sm:right-6 p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-center shadow-lg">
                <span className="text-slate-400 block text-[9px]">RR TIRE</span>
                <span className="font-bold text-emerald-400">{tpms.rr} PSI</span>
              </div>
            </div>

            {/* Closures, Security & Latches Grid + Roof Controls */}
            <div className="pt-4 border-t border-slate-800/80 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-indigo-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Closures & Security</h3>
                </div>
                <div className="text-[11px] font-mono text-slate-400">
                  {doors.frontLeft || doors.frontRight || doors.rearLeft || doors.rearRight ? (
                    <span className="text-amber-400 font-bold">Door Ajar</span>
                  ) : (
                    <span className="text-emerald-400">All Doors Latched</span>
                  )}
                </div>
              </div>

              {/* Doors & Latches Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
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
                    dispatchCommand('trunk', 'toggle', trunkOpen ? 'Trunk Closed' : 'Trunk Liftgate Opened');
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

              {/* Roof Configuration Row */}
              <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">Roof Configuration:</span>
                  <span className="font-medium text-slate-200">
                    {sunroof.equipped ? EGMP_MODELS[selectedModel].roofType : 'Solid Steel Stamping'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
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

                  {sunroof.equipped && (
                    selectedModel === 'ev6' || selectedModel === 'ioniq6' ? (
                      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-950 border border-slate-800">
                        {(['closed', 'vent', 'open'] as const).map(pos => (
                          <button
                            key={pos}
                            type="button"
                            id={`sunroof-pos-${pos}`}
                            onClick={() => {
                              setSunroof(prev => ({ ...prev, state: pos }));
                              dispatchCommand('sunroof_extended', pos, `Sunroof: ${pos === 'vent' ? 'Tilt Vent' : pos === 'open' ? 'Fully Open' : 'Closed'}`);
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
                    ) : (
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
                        {sunroof.sunshade === 'open' ? 'Vision Shade: Retracted' : 'Vision Shade: Closed'}
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Status Strip */}
            <div className="w-full pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Live CAN Telemetry: Sensor states reflect active vehicle broadcast (BCM, BMS, VMCU, FATC)</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-300">
                  {EGMP_MODELS[selectedModel].brand} {EGMP_MODELS[selectedModel].name}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column (Cabin Climate & Real-Time CAN Bus Decoder) */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-4">
          
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
                    dispatchCommand('remote_climate_start____seats___wheel_', next ? 'start' : 'off', next ? 'Cabin Climate Activated' : 'Cabin Climate Turned OFF');
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
                      dispatchCommand('climate_fan_speed_level', String(step), `Fan Speed: Level ${step}`);
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
                    dispatchCommand('climate_airflow_direction', mode, `Airflow Mode: ${mode === 'face_feet' ? 'Face / Feet' : mode.replace('_', ' ').toUpperCase()}`);
                  }}
                  className={`py-1.5 rounded-lg text-[10px] font-medium uppercase border transition-colors ${
                    airflow === mode
                      ? 'bg-slate-800 text-cyan-300 border-cyan-700/60 font-bold'
                      : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {mode === 'face_feet' ? 'Face / Feet' : mode}
                </button>
              ))}
            </div>

            {/* Quick Climate Toggles (Defrost, Recirc, Wheel) */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/60 text-xs">
              <button
                type="button"
                id="front-defrost-btn"
                onClick={() => {
                  const nextF = !frontDefrost;
                  setFrontDefrost(nextF);
                  dispatchCommand('front_defrost', nextF ? 'on' : 'off', nextF ? 'Front Defrost MAX Active' : 'Front Defrost Off');
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
                  dispatchCommand('climate_rear_defog', next ? 'on' : 'off', next ? 'Rear Defrost Activated' : 'Rear Defrost Deactivated');
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
                    {connectedDevice ? 'Monitoring live vehicle TWAI bus' : 'Listening on /ws endpoint for physical CAN packets'}
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
