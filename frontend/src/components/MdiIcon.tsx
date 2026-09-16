import React from 'react';
import {
  Compass,
  Gauge,
  Thermometer,
  Car,
  DoorClosed,
  BatteryCharging,
  Battery,
  Power,
  Fan,
  Wind,
  ShieldAlert,
  Info,
  Sun,
  Flame,
  Sliders,
  Camera,
  Zap,
  Plug,
  Shield,
  Maximize2,
  RefreshCw,
  Home,
  Tag,
  Bell,
  MessageSquare,
  LucideProps
} from 'lucide-react';

export interface MdiIconProps extends LucideProps {
  icon?: string;
  fallback?: React.ComponentType<LucideProps>;
}

export const COMMON_HA_DOMAINS = [
  { id: 'notify', label: 'notify', description: 'OSD toasts, cluster popups & vehicle notifications' },
  { id: 'event', label: 'event', description: 'Button presses & discrete trigger events' },
  { id: 'binary_sensor', label: 'binary_sensor', description: 'Two-state readings (open/closed, on/off, alert)' },
  { id: 'sensor', label: 'sensor', description: 'Continuous metrics (speed, battery, voltage, temp)' },
  { id: 'switch', label: 'switch', description: 'Controllable on/off toggles' },
  { id: 'button', label: 'button', description: 'Momentary pulse actions (press to trigger)' },
  { id: 'select', label: 'select', description: 'Multi-option mode selection' },
  { id: 'climate', label: 'climate', description: 'HVAC cabin, preconditioning & seat heating' },
  { id: 'lock', label: 'lock', description: 'Door locks, hatch & tailgate lock state' },
  { id: 'light', label: 'light', description: 'Headlights, taillights & ambient lighting' },
  { id: 'number', label: 'number', description: 'Configurable numerical values' }
];

export const SUGGESTED_MDI_ICONS = [
  { id: 'mdi:message-badge', label: 'OSD Toast / Popup', category: 'Alerts' },
  { id: 'mdi:bell-badge', label: 'Alert / Notification', category: 'Alerts' },
  { id: 'mdi:steering', label: 'Steering Wheel Button', category: 'Controls' },
  { id: 'mdi:steering-wheel', label: 'Steering Wheel', category: 'Controls' },
  { id: 'mdi:thermostat', label: 'Climate / Temp', category: 'HVAC' },
  { id: 'mdi:car-door', label: 'Doors / Latch', category: 'Body' },
  { id: 'mdi:car-back', label: 'Tailgate / Trunk', category: 'Body' },
  { id: 'mdi:car-front', label: 'Hood / Front', category: 'Body' },
  { id: 'mdi:window-open', label: 'Windows', category: 'Body' },
  { id: 'mdi:car-battery', label: 'EV / 12V Battery', category: 'Power' },
  { id: 'mdi:ev-station', label: 'Charging Session', category: 'Power' },
  { id: 'mdi:ev-plug-type2', label: 'Charge Port / Door', category: 'Power' },
  { id: 'mdi:power', label: 'Power / Ignition', category: 'Power' },
  { id: 'mdi:speedometer', label: 'Speed / Drive State', category: 'Telemetry' },
  { id: 'mdi:car-info', label: 'Vehicle Info / Cluster', category: 'Cluster' },
  { id: 'mdi:car-seat-heater', label: 'Seat Heating/Cooling', category: 'Comfort' },
  { id: 'mdi:radiator', label: 'Preconditioning / Coolant', category: 'HVAC' },
  { id: 'mdi:car-light-dimmed', label: 'Exterior Lights', category: 'Lights' },
  { id: 'mdi:cctv', label: 'Surround Cameras / 360', category: 'Safety' },
  { id: 'mdi:car-brake-alert', label: 'Brakes / Auto-Hold', category: 'Safety' },
  { id: 'mdi:seatbelt', label: 'Seatbelt Status', category: 'Safety' },
  { id: 'mdi:car-shift-pattern', label: 'Gear / Drive Mode', category: 'Drive' },
  { id: 'mdi:wiper', label: 'Wipers / Washers', category: 'Controls' }
];

/**
 * Returns an appropriate Lucide icon component corresponding to the MDI identifier.
 */
export function getMdiComponent(iconStr?: string): React.ComponentType<LucideProps> {
  if (!iconStr) return Tag;
  const name = iconStr.toLowerCase().replace(/^mdi:/, '').trim();

  if (name.includes('message') || name.includes('toast') || name.includes('popup') || name.includes('chat')) return MessageSquare;
  if (name.includes('notify') || name.includes('bell')) return Bell;
  if (name.includes('steering')) return Compass;
  if (name.includes('thermostat') || name.includes('temp')) return Thermometer;
  if (name.includes('speed')) return Gauge;
  if (name.includes('battery')) return BatteryCharging;
  if (name.includes('door')) return DoorClosed;
  if (name.includes('window')) return Maximize2;
  if (name.includes('plug') || name.includes('station') || name.includes('ev-')) return Plug;
  if (name.includes('power')) return Power;
  if (name.includes('radiator') || name.includes('fan')) return Fan;
  if (name.includes('seat-heater') || name.includes('heat') || name.includes('flame')) return Flame;
  if (name.includes('wiper') || name.includes('wind')) return Wind;
  if (name.includes('light')) return Sun;
  if (name.includes('camera') || name.includes('cctv')) return Camera;
  if (name.includes('brake') || name.includes('alert')) return ShieldAlert;
  if (name.includes('seatbelt') || name.includes('shield')) return Shield;
  if (name.includes('shift') || name.includes('drive')) return Sliders;
  if (name.includes('info')) return Info;
  if (name.includes('car')) return Car;
  if (name.includes('home')) return Home;

  return Tag;
}

export const MdiIcon: React.FC<MdiIconProps> = ({ icon, fallback: Fallback, className, ...props }) => {
  const IconComp = getMdiComponent(icon) || Fallback || Tag;
  return <IconComp className={className} {...props} />;
};

/**
 * Styles badges for Home Assistant domains
 */
export function getHaDomainBadgeStyle(domain?: string): {
  bg: string;
  text: string;
  border: string;
  dot: string;
} {
  switch (domain?.toLowerCase()) {
    case 'notify':
      return {
        bg: 'bg-orange-950/60',
        text: 'text-orange-300',
        border: 'border-orange-800/60',
        dot: 'bg-orange-400'
      };
    case 'event':
      return {
        bg: 'bg-purple-950/60',
        text: 'text-purple-300',
        border: 'border-purple-800/60',
        dot: 'bg-purple-400'
      };
    case 'binary_sensor':
      return {
        bg: 'bg-teal-950/60',
        text: 'text-teal-300',
        border: 'border-teal-800/60',
        dot: 'bg-teal-400'
      };
    case 'sensor':
      return {
        bg: 'bg-sky-950/60',
        text: 'text-sky-300',
        border: 'border-sky-800/60',
        dot: 'bg-sky-400'
      };
    case 'switch':
      return {
        bg: 'bg-emerald-950/60',
        text: 'text-emerald-300',
        border: 'border-emerald-800/60',
        dot: 'bg-emerald-400'
      };
    case 'button':
      return {
        bg: 'bg-amber-950/60',
        text: 'text-amber-300',
        border: 'border-amber-800/60',
        dot: 'bg-amber-400'
      };
    case 'climate':
      return {
        bg: 'bg-rose-950/60',
        text: 'text-rose-300',
        border: 'border-rose-800/60',
        dot: 'bg-rose-400'
      };
    case 'select':
      return {
        bg: 'bg-indigo-950/60',
        text: 'text-indigo-300',
        border: 'border-indigo-800/60',
        dot: 'bg-indigo-400'
      };
    case 'lock':
      return {
        bg: 'bg-red-950/60',
        text: 'text-red-300',
        border: 'border-red-800/60',
        dot: 'bg-red-400'
      };
    case 'light':
      return {
        bg: 'bg-yellow-950/60',
        text: 'text-yellow-300',
        border: 'border-yellow-800/60',
        dot: 'bg-yellow-400'
      };
    default:
      return {
        bg: 'bg-slate-900/80',
        text: 'text-cyan-300',
        border: 'border-slate-700/80',
        dot: 'bg-cyan-400'
      };
  }
}
