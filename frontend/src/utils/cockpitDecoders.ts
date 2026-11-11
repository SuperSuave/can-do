import { CommandOption } from '../types/catalog';

export type CockpitSeatLevel =
  | 'off'
  | 'heat_low'
  | 'heat_med'
  | 'heat_high'
  | 'cool_low'
  | 'cool_med'
  | 'cool_high';

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

