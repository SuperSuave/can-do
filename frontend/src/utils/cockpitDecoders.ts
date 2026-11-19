import { CommandOption } from '../types/catalog';

export type CockpitSeatLevel =
  | 'off'
  | 'heat_low'
  | 'heat_med'
  | 'heat_high'
  | 'cool_low'
  | 'cool_med'
  | 'cool_high';

export type CockpitAirflowMode = 'auto' | 'face' | 'face_feet' | 'feet' | 'defrost';

export const AIRFLOW_MODE_COMMAND_LABELS: Record<CockpitAirflowMode, string> = {
  auto: 'Auto',
  face: 'Body / Face Vents',
  face_feet: 'Body & Legs',
  feet: 'Legs / Floor Vents',
  defrost: 'Legs & Windshield Defrost',
};

const KM_TO_MI = 0.621371192;

const NEGATIVE_STATE_RE =
  /\b(inactive|not\s+charging|disconnected|unplugged|off|false|no|none|unknown|disabled|released|closed|stop|stopped)\b/;
const CHARGING_POSITIVE_RE = /\b(true|on|active|charging|plugged)\b/;
const BOOLEAN_POSITIVE_RE = /\b(true|on|active|engaged|start|started|high|low|med|medium)\b/;

/**
 * Normalizes a hex CAN ID string (e.g. "0x0326" -> "326") without decimal coercion.
 */
export function normalizeHexCanId(canId: string | undefined | null): string {
  if (!canId) return '';
  return canId.trim().toLowerCase().replace(/^0x/, '').replace(/^0+(?=[0-9a-f])/, '');
}

/**
 * Parses a live entity state string for boolean-like cockpit switches and indicators,
 * checking negative tokens before positive tokens so "Inactive" or "Stopped" never evaluate true.
 */
export function parseBooleanEntityState(stateStr: string): boolean {
  const norm = stateStr.trim().toLowerCase();
  if (!norm || norm === '0' || NEGATIVE_STATE_RE.test(norm)) {
    return false;
  }
  if (norm === '1') {
    return true;
  }
  return BOOLEAN_POSITIVE_RE.test(norm);
}

/**
 * Parses a live entity state string for `cond_charging`, ensuring "Inactive",
 * "Not Charging / Disconnected", and "Unplugged" evaluate to false.
 */
export function parseChargingEntityState(stateStr: string): boolean {
  const norm = stateStr.trim().toLowerCase();
  if (!norm || norm === '0' || NEGATIVE_STATE_RE.test(norm)) {
    return false;
  }
  if (norm === '1') {
    return true;
  }
  return CHARGING_POSITIVE_RE.test(norm);
}

/**
 * Checks whether a raw CAN payload satisfies a catalog option's 1-based D1..D8 match and mask.
 */
export function matchesCatalogByteSpec(bytes: number[], opt: CommandOption): boolean {
  if (!opt.match || typeof opt.match !== 'object') return false;
  const entries = Object.entries(opt.match);
  if (entries.length === 0) return false;

  for (const [dKey, rawTarget] of entries) {
    const matchKey = dKey.match(/^D(\d+)$/i);
    if (!matchKey) return false;
    const idx = parseInt(matchKey[1], 10) - 1;
    if (idx < 0 || idx >= bytes.length) return false;

    const targetStr = String(rawTarget).trim();
    const negated = targetStr.startsWith('!');
    const targetVal = parseInt(negated ? targetStr.slice(1) : targetStr, 16);
    if (Number.isNaN(targetVal)) return false;

    let maskVal = 0xFF;
    if (typeof opt.mask === 'string') {
      const parsed = parseInt(opt.mask, 16);
      if (!Number.isNaN(parsed)) maskVal = parsed;
    } else if (opt.mask && typeof opt.mask === 'object') {
      const byteMask = (opt.mask as Record<string, string>)[dKey];
      if (byteMask !== undefined) {
        const parsed = parseInt(String(byteMask), 16);
        if (!Number.isNaN(parsed)) maskVal = parsed;
      }
    }

    const matches = (bytes[idx] & maskVal) === (targetVal & maskVal);
    if (negated ? matches : !matches) return false;
  }
  return true;
}

/**
 * Decodes EV charging status from a raw CAN frame.
 * - E-GMP Gen 3 (0x326 BMS_06_100ms_1): D5 (bytes[4]) bits 0:1 (mask 0x03) === 0x01
 * - Legacy Gen 2 (0x594 BMS1): D2 (bytes[1]) bit 1 (mask 0x02) !== 0
 * - Catalog-driven options when `mappedChargingCanId` matches the frame ID
 * Returns `null` if the frame ID does not match charging telemetry or lacks required bytes.
 */
export function decodeChargingCanFrame(
  canId: string,
  bytes: number[],
  catalogOptions?: CommandOption[],
  mappedChargingCanId?: string
): boolean | null {
  const normId = normalizeHexCanId(canId);
  const mappedNorm = normalizeHexCanId(mappedChargingCanId);
  if (!normId) return null;

  const isKnownChargingId =
    normId === '326' || normId === '594' || (mappedNorm !== '' && normId === mappedNorm);
  if (!isKnownChargingId) return null;

  if (normId === mappedNorm && catalogOptions && catalogOptions.length > 0) {
    for (const opt of catalogOptions) {
      if (matchesCatalogByteSpec(bytes, opt)) {
        return parseChargingEntityState(opt.label || '');
      }
    }
  }

  if (normId === '326') {
    if (bytes.length < 5) return null;
    return (bytes[4] & 0x03) === 0x01;
  }

  if (normId === '594') {
    if (bytes.length < 2) return null;
    return (bytes[1] & 0x02) !== 0;
  }

  return null;
}

/**
 * Parses an odometer entity state string (firmware emits km without units) into kilometers.
 */
export function parseOdometerStateToKm(stateStr: string): number | null {
  const cleaned = stateStr.replace(/,/g, '');
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (Number.isNaN(val) || val < 0) return null;
  if (/\bmi\b|\bmiles?\b/i.test(stateStr)) {
    return val / KM_TO_MI;
  }
  return val;
}

/**
 * Formats an odometer kilometer reading for imperial (mi) or metric (km) display.
 */
export function formatOdometerFromKm(km: number, unitSystem: 'imperial' | 'metric'): number {
  return unitSystem === 'metric' ? Math.round(km) : Math.round(km * KM_TO_MI);
}

/**
 * Converts a Fahrenheit cabin setpoint to display units ('F' or nearest 0.5 'C').
 */
export function fahrenheitToDisplayTemp(tempF: number, tempUnit: 'F' | 'C'): number {
  if (tempUnit === 'C') {
    return Math.round(((tempF - 32) / 1.8) * 2) / 2;
  }
  return Math.round(tempF);
}

/**
 * Converts a displayed cabin setpoint ('F' or 'C') back to Fahrenheit integer.
 */
export function displayTempToFahrenheit(val: number, tempUnit: 'F' | 'C'): number {
  return tempUnit === 'C' ? Math.round(val * 1.8 + 32) : Math.round(val);
}

function parseTempTokenToF(token: string, unitHint: string): number | null {
  const num = parseFloat(token);
  if (Number.isNaN(num)) return null;
  const hasExplicitC = /°?\s*c\b/i.test(unitHint);
  const hasExplicitF = /°?\s*f\b/i.test(unitHint);
  if (hasExplicitC || (!hasExplicitF && num <= 40)) {
    return Math.round(num * 1.8 + 32);
  }
  return Math.round(num);
}

/**
 * Parses a single cabin setpoint state string (e.g. "72°F", "22°C", or "72") into Fahrenheit.
 */
export function parseSingleCabinTempToF(stateStr: string): number | null {
  const match = stateStr.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return parseTempTokenToF(match[1], stateStr);
}

/**
 * Parses a dual cabin setpoint state string (e.g. "72 / 72" emitted by firmware 0x380 decoder) into Fahrenheit.
 */
export function parseDualCabinTempToF(
  stateStr: string
): { driverF: number | null; passengerF: number | null } {
  const parts = stateStr.split('/');
  if (parts.length >= 2) {
    return {
      driverF: parseSingleCabinTempToF(parts[0]),
      passengerF: parseSingleCabinTempToF(parts[1]),
    };
  }
  const single = parseSingleCabinTempToF(stateStr);
  return { driverF: single, passengerF: null };
}

/**
 * Decodes front or rear seat comfort text labels ("Off", "Low Heat", "High Cool", etc.).
 */
export function decodeSeatLevel(stateStr: string): CockpitSeatLevel {
  const norm = stateStr.trim().toLowerCase();
  if (norm.includes('high heat')) return 'heat_high';
  if (norm.includes('medium heat') || norm.includes('med heat')) return 'heat_med';
  if (norm.includes('low heat')) return 'heat_low';
  if (norm.includes('high cool')) return 'cool_high';
  if (norm.includes('medium cool') || norm.includes('med cool')) return 'cool_med';
  if (norm.includes('low cool')) return 'cool_low';
  return 'off';
}

/**
 * Decodes front seat comfort from raw 0x496 (driver) or 0x475/0x49C (passenger) byte D1.
 */
export function decodeSeatComfortByte(byte0: number): CockpitSeatLevel {
  if (byte0 === 0x46 || byte0 === 0x02) return 'heat_high';
  if (byte0 === 0x4e || byte0 === 0x0a) return 'heat_med';
  if (byte0 === 0x36 || byte0 === 0x0e) return 'heat_low';
  if (byte0 === 0x2e || byte0 === 0x10) return 'cool_high';
  if (byte0 === 0x26 || byte0 === 0x12) return 'cool_med';
  if (byte0 === 0x1e || byte0 === 0x14) return 'cool_low';
  return 'off';
}

/**
 * Routes rear seat entity updates so left and right states never clobber each other.
 */
export function decodeRearSeatEntityUpdate(
  entity: string,
  stateStr: string
): { left?: CockpitSeatLevel; right?: CockpitSeatLevel } {
  const lvl = decodeSeatLevel(stateStr);
  const normEntity = entity.trim().toLowerCase();
  if (normEntity === 'rear_left_seat_comfort') {
    return { left: lvl };
  }
  if (normEntity === 'rear_right_seat_comfort') {
    return { right: lvl };
  }
  const normState = stateStr.toLowerCase();
  if (normState.includes('rear left')) return { left: lvl };
  if (normState.includes('rear right')) return { right: lvl };
  return {};
}

/**
 * Decodes charge port door open/closed state from catalog options or 0x3AA Byte D4 (bytes[3]).
 */
export function decodeChargePortCanFrame(
  canId: string,
  bytes: number[],
  catalogOptions?: CommandOption[],
  mappedChargePortCanId?: string
): boolean | null {
  const normId = normalizeHexCanId(canId);
  const mappedNorm = normalizeHexCanId(mappedChargePortCanId);
  if (!normId || (normId !== '3aa' && (!mappedNorm || normId !== mappedNorm))) {
    return null;
  }

  if (catalogOptions && catalogOptions.length > 0) {
    for (const opt of catalogOptions) {
      if (matchesCatalogByteSpec(bytes, opt)) {
        const lbl = (opt.label || '').toLowerCase();
        return lbl.includes('open') && !lbl.includes('close') && !lbl.includes('shut');
      }
    }
  }

  if (bytes.length < 4) return null;
  if (bytes[3] === 0x01) return true;
  if (bytes[3] === 0x02) return false;
  return null;
}

/**
 * Separates sunroof glass position updates from power sunshade cover updates.
 */
export function decodeSunroofEntityState(stateStr: string): {
  glassState?: 'closed' | 'vent' | 'open';
  sunshade?: 'open' | 'closed';
} {
  const norm = stateStr.trim().toLowerCase();
  if (norm.includes('cover') || norm.includes('shade')) {
    if (norm.includes('open') || norm.includes('retract')) return { sunshade: 'open' };
    if (norm.includes('close')) return { sunshade: 'closed' };
    return {};
  }
  if (norm.includes('open')) return { glassState: 'open' };
  if (norm.includes('vent') || norm.includes('tilt')) return { glassState: 'vent' };
  if (norm.includes('closed') || norm.includes('close')) return { glassState: 'closed' };
  return {};
}

/**
 * Decodes HVAC vent airflow mode from 0x31B Byte D4 (high nibble).
 */
export function decodeAirflowCanByte(d4Byte: number): CockpitAirflowMode | null {
  const afRaw = d4Byte & 0xF0;
  switch (afRaw) {
    case 0x00: return 'auto';
    case 0x10: return 'face';
    case 0x20: return 'face_feet';
    case 0x30: return 'feet';
    case 0x40: return 'defrost';
    default: return null;
  }
}

/**
 * Decodes airflow mode from entity state text (e.g. "Body / Face Vents", "Body & Legs", "Defrost").
 */
export function decodeAirflowEntityState(stateStr: string): CockpitAirflowMode | null {
  const norm = stateStr.trim().toLowerCase();
  if (norm.includes('face_feet') || norm.includes('face / feet') || norm.includes('body & legs') || norm.includes('body / legs') || norm.includes('body&legs')) return 'face_feet';
  if (norm.includes('defrost') || norm.includes('defog')) return 'defrost';
  if (norm.includes('face') || norm.includes('body')) return 'face';
  if (norm.includes('feet') || norm.includes('legs')) return 'feet';
  if (norm.includes('auto')) return 'auto';
  return null;
}

/**
 * Decodes Driver-Only Climate Zone from 0x465 Byte D7.
 * 0x04 = Active / On, 0x0C = Inactive / Off.
 */
export function decodeDriverOnlyCanFrame(bytes: number[]): boolean | null {
  if (bytes.length < 7) return null;
  const val = bytes[6] & 0x0F;
  if (val === 0x04) return true;
  if (val === 0x0C) return false;
  return null;
}

export interface AmbientThemeOption {
  label: string;
  name: string;
  hex: string;
}

export const AMBIENT_LIGHT_THEMES: AmbientThemeOption[] = [
  { label: 'Golden Insight / Orange Delight', name: 'Golden Insight', hex: '#ff8c00' },
  { label: 'Blue Flight', name: 'Blue Flight', hex: '#0078d4' },
  { label: 'Peaceful Forest', name: 'Peaceful Forest', hex: '#107c41' },
  { label: 'Dreamy Purple', name: 'Dreamy Purple', hex: '#800080' },
  { label: 'Violet Cloud', name: 'Violet Cloud', hex: '#a789f5' },
  { label: 'Refreshing Sea', name: 'Refreshing Sea', hex: '#00bfff' },
];

export interface AmbientPaletteOption {
  step: number;
  label: string;
  name: string;
  hex: string;
}

export const AMBIENT_PALETTE_64: AmbientPaletteOption[] = [
  { step: 1, label: 'Color 1: Lime / Mint Glow', name: 'Lime / Mint Glow', hex: '#46ff46' },
  { step: 2, label: 'Color 2: Spring Lime', name: 'Spring Lime', hex: '#55ff5f' },
  { step: 3, label: 'Color 3: Fresh Grass', name: 'Fresh Grass', hex: '#64ff78' },
  { step: 4, label: 'Color 4: Pastel Mint', name: 'Pastel Mint', hex: '#73ff96' },
  { step: 5, label: 'Color 5: Light Aqua', name: 'Light Aqua', hex: '#50ffb4' },
  { step: 6, label: 'Color 6: Bright Turquoise', name: 'Bright Turquoise', hex: '#28ffd2' },
  { step: 7, label: 'Color 7: Deep Turquoise', name: 'Deep Turquoise', hex: '#0affeb' },
  { step: 8, label: 'Color 8: Pure Cyan / Aqua Wave', name: 'Pure Cyan', hex: '#00ffff' },
  { step: 9, label: 'Color 9: Sky Blue Light', name: 'Sky Blue Light', hex: '#00ebff' },
  { step: 10, label: 'Color 10: Sky Blue', name: 'Sky Blue', hex: '#00d7ff' },
  { step: 11, label: 'Color 11: Glacier Blue', name: 'Glacier Blue', hex: '#00c3ff' },
  { step: 12, label: 'Color 12: Cerulean', name: 'Cerulean', hex: '#00afff' },
  { step: 13, label: 'Color 13: Cobalt Light', name: 'Cobalt Light', hex: '#009bff' },
  { step: 14, label: 'Color 14: Pacific Blue', name: 'Pacific Blue', hex: '#0087ff' },
  { step: 15, label: 'Color 15: Electric Blue', name: 'Electric Blue', hex: '#0078ff' },
  { step: 16, label: 'Color 16: Royal Blue', name: 'Royal Blue', hex: '#145aff' },
  { step: 17, label: 'Color 17: Deep Blue', name: 'Deep Blue', hex: '#323cff' },
  { step: 18, label: 'Color 18: Indigo Blue', name: 'Indigo Blue', hex: '#5028ff' },
  { step: 19, label: 'Color 19: Blue Violet', name: 'Blue Violet', hex: '#691eff' },
  { step: 20, label: 'Color 20: Lavender Violet', name: 'Lavender Violet', hex: '#8214ff' },
  { step: 21, label: 'Color 21: Grape Purple', name: 'Grape Purple', hex: '#960fff' },
  { step: 22, label: 'Color 22: Electric Purple', name: 'Electric Purple', hex: '#a50aff' },
  { step: 23, label: 'Color 23: Bright Violet', name: 'Bright Violet', hex: '#af05ff' },
  { step: 24, label: 'Color 24: Deep Purple / Violet', name: 'Deep Purple', hex: '#b400ff' },
  { step: 25, label: 'Color 25: Amethyst', name: 'Amethyst', hex: '#be00fa' },
  { step: 26, label: 'Color 26: Royal Purple', name: 'Royal Purple', hex: '#cd00f0' },
  { step: 27, label: 'Color 27: Purple Orchid', name: 'Purple Orchid', hex: '#dc00e6' },
  { step: 28, label: 'Color 28: Purple Magenta', name: 'Purple Magenta', hex: '#e600d7' },
  { step: 29, label: 'Color 29: Bright Magenta', name: 'Bright Magenta', hex: '#f000c8' },
  { step: 30, label: 'Color 30: Deep Fuchsia', name: 'Deep Fuchsia', hex: '#f505b4' },
  { step: 31, label: 'Color 31: Hot Fuchsia', name: 'Hot Fuchsia', hex: '#fa0aa0' },
  { step: 32, label: 'Color 32: Neon Pink', name: 'Neon Pink', hex: '#ff0f8c' },
  { step: 33, label: 'Color 33: Magenta / Neon Pink', name: 'Magenta Pink', hex: '#ff1493' },
  { step: 34, label: 'Color 34: Deep Rose Pink', name: 'Deep Rose Pink', hex: '#ff0f78' },
  { step: 35, label: 'Color 35: Crimson Pink', name: 'Crimson Pink', hex: '#ff0a64' },
  { step: 36, label: 'Color 36: Bright Rose Red', name: 'Bright Rose Red', hex: '#ff0a50' },
  { step: 37, label: 'Color 37: Ruby Red', name: 'Ruby Red', hex: '#ff0a3c' },
  { step: 38, label: 'Color 38: Cherry Red', name: 'Cherry Red', hex: '#ff0a2d' },
  { step: 39, label: 'Color 39: Scarlet', name: 'Scarlet', hex: '#ff0a23' },
  { step: 40, label: 'Color 40: Carmine Red', name: 'Carmine Red', hex: '#ff0a19' },
  { step: 41, label: 'Color 41: Pure Red Bright', name: 'Pure Red Bright', hex: '#ff050f' },
  { step: 42, label: 'Color 42: Pure Red Strong', name: 'Pure Red Strong', hex: '#ff000a' },
  { step: 43, label: 'Color 43: Deep Crimson', name: 'Deep Crimson', hex: '#ff0005' },
  { step: 44, label: 'Color 44: Blood Red', name: 'Blood Red', hex: '#ff0000' },
  { step: 45, label: 'Color 45: Burnt Red', name: 'Burnt Red', hex: '#ff1400' },
  { step: 46, label: 'Color 46: Crimson Red', name: 'Crimson Red', hex: '#ff0000' },
  { step: 47, label: 'Color 47: Vermilion Red-Orange', name: 'Vermilion', hex: '#ff2d00' },
  { step: 48, label: 'Color 48: Deep Orange', name: 'Deep Orange', hex: '#ff4100' },
  { step: 49, label: 'Color 49: Bright Orange', name: 'Bright Orange', hex: '#ff5000' },
  { step: 50, label: 'Color 50: Tangerine', name: 'Tangerine', hex: '#ff5f00' },
  { step: 51, label: 'Color 51: Sunrise Orange', name: 'Sunrise Orange', hex: '#ff6e00' },
  { step: 52, label: 'Color 52: Golden Orange', name: 'Golden Orange', hex: '#ff7d00' },
  { step: 53, label: 'Color 53: Amber Gold', name: 'Amber Gold', hex: '#ff8700' },
  { step: 54, label: 'Color 54: Warm Amber', name: 'Warm Amber', hex: '#ff8c00' },
  { step: 55, label: 'Color 55: Deep Marigold', name: 'Deep Marigold', hex: '#ff9100' },
  { step: 56, label: 'Color 56: Marigold Orange', name: 'Marigold Orange', hex: '#ff9600' },
  { step: 57, label: 'Color 57: Warm Sunset / Amber', name: 'Warm Sunset', hex: '#ff8c00' },
  { step: 58, label: 'Color 58: Peach Amber', name: 'Peach Amber', hex: '#ffa50a' },
  { step: 59, label: 'Color 59: Golden Peach', name: 'Golden Peach', hex: '#ffb41e' },
  { step: 60, label: 'Color 60: Champagne Gold', name: 'Champagne Gold', hex: '#ffc33c' },
  { step: 61, label: 'Color 61: Soft Gold', name: 'Soft Gold', hex: '#ffd264' },
  { step: 62, label: 'Color 62: Vanilla Gold', name: 'Vanilla Gold', hex: '#ffe18c' },
  { step: 63, label: 'Color 63: Warm Ivory', name: 'Warm Ivory', hex: '#ffebb4' },
  { step: 64, label: 'Color 64: Warm White / Champagne', name: 'Warm White', hex: '#fff0dc' },
];

export const AMBIENT_QUICK_COLORS = [
  { label: 'Color 64: Warm White / Champagne', name: 'White', hex: '#fff0dc' },
  { label: 'Color 8: Pure Cyan / Aqua Wave', name: 'Cyan', hex: '#00ffff' },
  { label: 'Color 15: Electric Blue', name: 'Electric Blue', hex: '#0078ff' },
  { label: 'Color 24: Deep Purple / Violet', name: 'Deep Purple', hex: '#b400ff' },
  { label: 'Color 46: Crimson Red', name: 'Crimson Red', hex: '#ff0000' },
  { label: 'Color 54: Warm Amber', name: 'Amber', hex: '#ff8c00' },
  { label: 'Color 1: Lime / Mint Glow', name: 'Lime Mint', hex: '#46ff46' },
];

export interface AmbientEffectOption {
  label: string;
  name: string;
  hex: string;
  description: string;
}

export const AMBIENT_DYNAMIC_EFFECTS: AmbientEffectOption[] = [
  { label: 'Rainbow Spectrum Wave', name: 'Rainbow Wave', hex: '#ff00ff', description: 'Smooth 64-color continuous spectrum sweep' },
  { label: '4th of July Patriotic Wave', name: 'Patriotic Wave', hex: '#0078ff', description: 'Rotating Red, Champagne White, and Electric Blue' },
  { label: 'Police Strobe', name: 'Police Strobe', hex: '#ff0000', description: 'Rapid Red and Electric Blue alternating strobe' },
  { label: 'Ocean Tide', name: 'Ocean Tide', hex: '#00d7ff', description: 'Slow surge across Cyan, Sky Blue, and Electric Blue' },
  { label: 'Sunset Glow', name: 'Sunset Glow', hex: '#ff8c00', description: 'Warm embers cycling Crimson, Amber, and Gold' },
  { label: 'Northern Lights Aurora', name: 'Aurora', hex: '#46ff46', description: 'Shifting Emerald Lime, Mint, and Pure Cyan hues' },
  { label: 'Ambient Breathe', name: 'Breathe', hex: '#00ffff', description: 'Smooth luminous intensity pulsing' },
];

export function isAmbientDynamicEffect(label?: string | null): boolean {
  if (!label) return false;
  const norm = label.trim().toLowerCase();
  return AMBIENT_DYNAMIC_EFFECTS.some(
    (e) => e.label.toLowerCase() === norm || e.name.toLowerCase() === norm
  );
}

/**
 * Resolves a hex color code from an ambient light option label or partial name.
 */
export function getAmbientColorHex(label?: string | null): string {
  if (!label) return '#00ffff';
  const norm = label.trim().toLowerCase();
  for (const e of AMBIENT_DYNAMIC_EFFECTS) {
    if (e.label.toLowerCase() === norm || e.name.toLowerCase() === norm) {
      return e.hex;
    }
  }
  for (const t of AMBIENT_LIGHT_THEMES) {
    if (t.label.toLowerCase() === norm || t.name.toLowerCase() === norm || norm.includes(t.name.toLowerCase())) {
      return t.hex;
    }
  }
  for (const p of AMBIENT_PALETTE_64) {
    if (p.label.toLowerCase() === norm || norm === `color ${p.step}` || norm.startsWith(`color ${p.step}:`)) {
      return p.hex;
    }
  }
  if (norm.includes('white') || norm.includes('champagne')) return '#fff0dc';
  if (norm.includes('cyan') || norm.includes('aqua')) return '#00ffff';
  if (norm.includes('blue')) return '#0078ff';
  if (norm.includes('purple') || norm.includes('violet')) return '#b400ff';
  if (norm.includes('red') || norm.includes('rose') || norm.includes('ruby')) return '#ff0000';
  if (norm.includes('amber') || norm.includes('orange') || norm.includes('gold')) return '#ff8c00';
  if (norm.includes('green') || norm.includes('lime') || norm.includes('mint')) return '#46ff46';
  return '#00ffff';
}

/**
 * Decodes ambient mood lamp status from 0x455 CAN frame.
 * - Byte D1 (index 0): 0x41 = 0 (Off), 0x42..0x4B = 1..10
 * - Bytes D3..D6 (indices 2..5): 4-byte color matching signature
 */
export function decodeAmbientCanFrame(
  bytes: number[],
  catalogOptions?: CommandOption[]
): { brightness: number; activeOptionLabel?: string; hexColor?: string } | null {
  if (bytes.length < 6) return null;
  const rawLvl = (bytes[0] & 0x0F) - 1;
  const brightness = Math.max(0, Math.min(10, rawLvl));

  let activeOptionLabel: string | undefined;
  if (catalogOptions && catalogOptions.length > 0) {
    for (const opt of catalogOptions) {
      if (matchesCatalogByteSpec(bytes, opt)) {
        activeOptionLabel = opt.label;
        break;
      }
    }
  }

  const hexColor = activeOptionLabel ? getAmbientColorHex(activeOptionLabel) : undefined;
  return { brightness, activeOptionLabel, hexColor };
}

/**
 * Decodes an unsigned 8-bit integer byte into signed two's complement (-128..127).
 */
export function decodeSignedInt8(byteVal: number): number {
  const b = byteVal & 0xff;
  return b > 127 ? b - 256 : b;
}

/**
 * Compares two ambient color labels or palette names so catalog prefixes ("Color 8: Pure Cyan / Aqua Wave")
 * match simplified firmware/MQTT names ("Pure Cyan / Aqua Wave").
 */
export function isSameAmbientColor(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  const effA = AMBIENT_DYNAMIC_EFFECTS.find(
    (e) => e.label.toLowerCase() === na || e.name.toLowerCase() === na
  );
  const effB = AMBIENT_DYNAMIC_EFFECTS.find(
    (e) => e.label.toLowerCase() === nb || e.name.toLowerCase() === nb
  );
  if (effA && effB) return effA.label === effB.label;
  const themeA = AMBIENT_LIGHT_THEMES.find(
    (t) => t.label.toLowerCase() === na || t.name.toLowerCase() === na
  );
  const themeB = AMBIENT_LIGHT_THEMES.find(
    (t) => t.label.toLowerCase() === nb || t.name.toLowerCase() === nb
  );
  if (themeA && themeB) return themeA.label === themeB.label;
  const stripPrefix = (s: string) => s.replace(/^color\s+\d+\s*:\s*/i, '').trim();
  if (stripPrefix(na) === stripPrefix(nb)) return true;
  const matchA = AMBIENT_PALETTE_64.find(
    (p) => p.label.toLowerCase() === na || `color ${p.step}` === na || p.name.toLowerCase() === stripPrefix(na)
  );
  const matchB = AMBIENT_PALETTE_64.find(
    (p) => p.label.toLowerCase() === nb || `color ${p.step}` === nb || p.name.toLowerCase() === stripPrefix(nb)
  );
  return Boolean(matchA && matchB && matchA.step === matchB.step);
}

/**
 * Tracks short-lived optimistic holds after dispatching cockpit commands so periodic CAN frames
 * (e.g. 200ms 0x496 seat state) do not revert the UI mid-cycle before TX completes.
 */
export class OptimisticHoldTracker {
  private holds = new Map<string, { value: string; untilMs: number }>();

  setHold(key: string, expectedValue: string, ttlMs = 1800, nowMs = Date.now()): void {
    this.holds.set(key, { value: expectedValue, untilMs: nowMs + ttlMs });
  }

  extendHold(key: string, ttlMs = 1800, nowMs = Date.now()): void {
    const existing = this.holds.get(key);
    if (existing) {
      existing.untilMs = Math.max(existing.untilMs, nowMs + ttlMs);
    }
  }

  clearHold(key: string): void {
    this.holds.delete(key);
  }

  shouldAccept(key: string, incomingValue: string, nowMs = Date.now()): boolean {
    const entry = this.holds.get(key);
    if (!entry) return true;
    if (nowMs >= entry.untilMs) {
      this.holds.delete(key);
      return true;
    }
    if (entry.value === incomingValue) {
      // Car confirmed the commanded state; release hold immediately.
      this.holds.delete(key);
      return true;
    }
    return false;
  }
}

/**
 * Decodes E-GMP outdoor ambient temperature in °C from 0x31C (primary DATC_31_1000ms_2)
 * or 0x227 (CLU_02_100ms_2 °F) / 0x226 (CLU_02_100ms_1 °C) fallbacks.
 */
export function decodeOutdoorTempCanFrame(normId: string, bytes: number[]): number | null {
  const id = normId.toLowerCase().replace(/^0x/, '');
  if (id === '31c' && bytes.length >= 1) {
    const raw = bytes[0];
    if (raw >= 2 && raw <= 202) {
      return raw * 0.5 - 41;
    }
    return null;
  }
  if (id === '227' && bytes.length >= 8) {
    const rawF = ((bytes[7] & 0x07) << 5) | ((bytes[6] >> 3) & 0x1F);
    if (rawF > 0 && rawF <= 180) {
      return Math.round((((rawF - 40) - 32) / 1.8) * 10) / 10;
    }
    return null;
  }
  if (id === '226' && bytes.length >= 4) {
    const rawC = bytes[3];
    if (rawC > 0 && rawC <= 100) {
      return rawC - 40;
    }
    return null;
  }
  return null;
}
