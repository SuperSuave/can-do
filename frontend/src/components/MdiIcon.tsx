import React from 'react';
import {
  Tag,
  Compass,
  Car,
  Zap,
  Radio,
  Sliders,
  Music,
  Volume2,
  Camera,
  Flame,
  Sun,
  AlertTriangle,
  Battery,
  Wind,
  Thermometer,
  Bell,
  MessageSquare,
  Clock,
  Gauge,
  Fan,
  Power,
  Shield,
  RefreshCw,
  LucideProps
} from 'lucide-react';

export interface MdiIconProps extends React.SVGProps<SVGSVGElement> {
  icon?: string;
  className?: string;
  size?: number | string;
  fallback?: React.ComponentType<LucideProps>;
}

// Map of supported Home Assistant MDI icon names to Lucide icons
const MDI_LUCIDE_MAP: Record<string, React.ComponentType<LucideProps>> = {
  'steering-wheel': Compass,
  'steering': Compass,
  'car-front': Car,
  'ev-plug-type2': Zap,
  'radio': Radio,
  'knob': Sliders,
  'music-box-outline': Music,
  'surround-sound': Volume2,
  'speaker': Volume2,
  'cctv': Camera,
  'car-seat-heater': Flame,
  'car-shift-pattern': Sliders,
  'car-light-dimmed': Sun,
  'car-brake-alert': AlertTriangle,
  'car-battery': Battery,
  'car-door': Car,
  'car-back': Car,
  'car-info': Car,
  'wiper': Wind,
  'window-open': Wind,
  'thermostat': Thermometer,
  'thermostat-box': Thermometer,
  'thermometer': Thermometer,
  'thermometer-alert': AlertTriangle,
  'message-badge': MessageSquare,
  'message-badge-outline': MessageSquare,
  'message-text': MessageSquare,
  'timer-outline': Clock,
  'ev-station': Zap,
  'speedometer': Gauge,
  'radiator': Fan,
  'power': Power,
  'seatbelt': Shield,
  'sync': RefreshCw,
  'bell-badge': Bell
};

/**
 * Resolves an MDI icon name (e.g. "mdi:steering", "mdi:car-shift-pattern")
 * to a Lucide icon component.
 */
export function getMdiComponent(iconStr?: string): React.ComponentType<LucideProps> | null {
  if (!iconStr) return null;
  const clean = iconStr.trim().replace(/^mdi:/i, '').toLowerCase();
  if (!clean) return null;

  if (MDI_LUCIDE_MAP[clean]) {
    return MDI_LUCIDE_MAP[clean];
  }

  // Check alias without hyphens or exact match
  const stripped = clean.replace(/[^a-z0-9]/g, '');
  for (const [key, comp] of Object.entries(MDI_LUCIDE_MAP)) {
    if (key.replace(/[^a-z0-9]/g, '') === stripped) {
      return comp;
    }
  }

  return null;
}

export const MdiIcon: React.FC<MdiIconProps> = ({
  icon,
  fallback: Fallback,
  className = 'w-4 h-4',
  size,
  ...props
}) => {
  const Component = getMdiComponent(icon) || Fallback || Tag;
  return <Component className={className} size={size as any} {...(props as any)} />;
};

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
