import {
  AutomationRule,
  AutomationSettings,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  AutomationActionStep,
  ChoiceBranch,
  PopupLevel
} from '../types/automation';
import { Command, CommandEffect, CommandOption, Catalog, ByteMap, Vehicle } from '../types/catalog';
import { DEFAULT_CATALOG } from '../data/defaultCatalog';
import {
  resolveVariant,
  isRangeCommand,
  physicalToRawByte,
  getDefaultPhysicalValue,
  buildRangeActionPayload,
  resolveRangeSteps,
  normalizeByteKey
} from './catalogUtils';

/**
 * Converts any numeric integer or hex/decimal string into canonical 2-digit uppercase hex (e.g. "0xFF", "0x00", "0x3F").
 * When `allowNegated` is true, also preserves firmware-valid negated match bytes (e.g. "!0x00").
 * Returns undefined for wildcards, empty values, or invalid inputs.
 */
export function formatHexByte(val: unknown, allowNegated = false): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val < 0 || val > 255) return undefined;
    return `0x${(Math.trunc(val) & 0xFF).toString(16).padStart(2, '0').toUpperCase()}`;
  }
  const str = String(val).trim();
  if (!str || str === '*' || str === '**' || str === '?' || str === '??') return undefined;

  // Negated byte syntax ("!0x00", "!FF") used in firmware match/condition rules
  if (str.startsWith('!')) {
    if (!allowNegated) return undefined;
    const inner = formatHexByte(str.slice(1).trim(), false);
    return inner !== undefined ? `!${inner}` : undefined;
  }

  // Hex prefixed with 0x / 0X (strict 1-2 hex digits)
  if (/^0x/i.test(str)) {
    const hexMatch = str.match(/^0x([0-9a-fA-F]{1,2})$/i);
    if (!hexMatch) return undefined;
    return `0x${hexMatch[1].padStart(2, '0').toUpperCase()}`;
  }

  // Pure decimal digits
  if (/^\d+$/.test(str)) {
    const num = parseInt(str, 10);
    if (!isNaN(num) && num >= 0 && num <= 255) {
      if (str.length >= 3) {
        return `0x${num.toString(16).padStart(2, '0').toUpperCase()}`;
      }
      if (str.length === 1) {
        return `0x0${str}`;
      }
      // 2 digits: standard in CAN payloads as 2 hex chars
      return `0x${str.toUpperCase()}`;
    }
  }

  // Bare hex string (1-2 chars e.g. "3F", "FF", "a")
  if (/^[0-9a-fA-F]{1,2}$/.test(str)) {
    return `0x${str.padStart(2, '0').toUpperCase()}`;
  }

  return undefined;
}

/**
 * Cleanly compiles any payload, ByteMap, byte array, wrapper object, or string into a strict 1-based ByteMap ({ D1: "0x.." }).
 * Supports hex ("0xFF", "3F"), numeric decimal integers (255, 63, 0), byte arrays ([0x10, 0x20]), and { hex | data | raw } objects.
 */
export function compileToByteMap(
  input: string | ByteMap | Record<string, unknown> | unknown[] | undefined,
  allowNegated = false
): ByteMap {
  if (!input) return {};

  if (Array.isArray(input)) {
    const cleanMap: ByteMap = {};
    const limit = Math.min(input.length, 8);
    for (let i = 0; i < limit; i++) {
      const formatted = formatHexByte(input[i], allowNegated);
      if (formatted !== undefined) {
        cleanMap[`D${i + 1}`] = formatted;
      }
    }
    return cleanMap;
  }

  if (typeof input === 'object') {
    const cleanMap: ByteMap = {};
    for (const [k, v] of Object.entries(input)) {
      const match = k.match(/^D?([1-8])$/i);
      if (!match) continue;
      const dKey = `D${match[1]}`;
      const formatted = formatHexByte(v, allowNegated);
      if (formatted !== undefined) {
        cleanMap[dKey] = formatted;
      }
    }
    if (Object.keys(cleanMap).length > 0) {
      return cleanMap;
    }
    const obj = input as Record<string, unknown>;
    const wrapped = obj.hex ?? obj.data ?? obj.raw;
    if (typeof wrapped === 'string' || Array.isArray(wrapped)) {
      return compileToByteMap(wrapped, allowNegated);
    }
    return cleanMap;
  }

  const trimmed = String(input).trim();
  if (!trimmed) return {};

  // If string starts with JSON object or array, parse it
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsedObj = JSON.parse(trimmed);
      if (parsedObj && typeof parsedObj === 'object') {
        return compileToByteMap(parsedObj, allowNegated);
      }
    } catch {
      // Fall through to whitespace splitting
    }
  }

  // Support continuous hex string e.g. "D0C1751500000000" or "0xD0C1751500000000"
  const continuousHex = trimmed.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{2,16}$/.test(continuousHex) && continuousHex.length % 2 === 0 && !/\s/.test(trimmed)) {
    const result: ByteMap = {};
    const byteCount = Math.min(8, continuousHex.length / 2);
    for (let i = 0; i < byteCount; i++) {
      result[`D${i + 1}`] = `0x${continuousHex.slice(i * 2, i * 2 + 2).toUpperCase()}`;
    }
    return result;
  }

  const parts = trimmed.split(/\s+/);
  const result: ByteMap = {};

  parts.forEach((part, idx) => {
    if (idx >= 8) return;
    const dKey = `D${idx + 1}`;
    const clean = part.trim();
    if (!clean || clean === '*' || clean === '**' || clean === '??' || clean === '?') return;

    const hexClean = clean.replace(/\*/g, '0');
    const formatted = formatHexByte(hexClean, allowNegated);
    if (formatted !== undefined) {
      result[dKey] = formatted;
    }
  });

  return result;
}

/**
 * Resolves the effective CAN transmit bus (0 or 1) for a catalog command's action frames,
 * honoring dual-CAN `network.action_bus` before root `action_bus` and state `bus`.
 */
export function resolveActionBus(cmd?: Command | null, fallbackBus?: number): 0 | 1 {
  const raw =
    cmd?.network?.action_bus ??
    cmd?.action_bus ??
    cmd?.network?.bus ??
    cmd?.bus ??
    fallbackBus ??
    0;
  const num = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return num >= 1 ? 1 : 0;
}

const MAX_STEP_REPEAT = 50;
const MAX_DELAY_MS = 3600000;
const MAX_COOLDOWN_MS = 86400000;
const MAX_SUSTAINED_MS = 86400000;
const MAX_SUSTAINED_SEC = 86400;
const MAX_DECOMPILE_DEPTH = 16;

function isPlainObject(val: unknown): val is Record<string, any> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function asString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val === undefined || val === null) return '';
  return String(val);
}

function isTransmitActionType(type: unknown): boolean {
  return type === 'transmit' || type === 'transmit_frame' || type === 'can_tx';
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  if (val === undefined || val === null || val === '') return fallback;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

function clampRssi(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return undefined;
  const truncated = Math.trunc(n);
  if (truncated < -127) return -127;
  if (truncated > 0) return 0;
  return truncated;
}

function resolveByteKeyWithIndexFallback(
  explicitByte: unknown,
  fallbackByte: unknown,
  byteIndex: unknown,
  defaultByte: string
): string {
  if (explicitByte !== undefined && explicitByte !== null && asString(explicitByte).trim() !== '') {
    return normalizeByteKey(asString(explicitByte));
  }
  if (fallbackByte !== undefined && fallbackByte !== null && asString(fallbackByte).trim() !== '') {
    return normalizeByteKey(asString(fallbackByte));
  }
  if (byteIndex !== undefined && byteIndex !== null && byteIndex !== '') {
    const idx = Number(byteIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx <= 7) {
      return `D${idx + 1}`;
    }
  }
  return defaultByte;
}

function byteKeyToIndex(byteKey: unknown, fallback = 0): number {
  const match = asString(byteKey).trim().match(/^D?([1-8])$/i);
  if (!match) return fallback;
  return parseInt(match[1], 10) - 1;
}

function resolveMaskForMatch(
  rawMask: unknown,
  matchKeys: string[],
  singleByteKey?: string,
  defaultMask = '0xFF',
  forceSingle = false
): string | ByteMap {
  const isMultiByte = !forceSingle && matchKeys.length > 1;
  if (isMultiByte) {
    const mObj: ByteMap = {};
    if (isPlainObject(rawMask)) {
      const normalizedMaskMap = compileToByteMap(rawMask);
      for (const k of matchKeys) {
        mObj[k] = normalizedMaskMap[k] || (typeof rawMask[k] === 'string' && rawMask[k].trim() ? rawMask[k].trim() : defaultMask);
      }
    } else {
      const defM =
        formatHexByte(rawMask) ||
        (typeof rawMask === 'string' && rawMask.trim() ? rawMask.trim() : defaultMask);
      for (const k of matchKeys) {
        mObj[k] = defM;
      }
    }
    return mObj;
  }

  const key = singleByteKey || matchKeys[0] || 'D1';
  if (isPlainObject(rawMask)) {
    const normalizedMaskMap = compileToByteMap(rawMask);
    return normalizedMaskMap[key] || (typeof rawMask[key] === 'string' && rawMask[key].trim() ? rawMask[key].trim() : defaultMask);
  }
  return (
    formatHexByte(rawMask) ||
    (typeof rawMask === 'string' && rawMask.trim() ? rawMask.trim() : defaultMask)
  );
}

function clampTransmitDelayMs(delayMs: unknown): number {
  const n = typeof delayMs === 'number' ? delayMs : Number(delayMs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(Math.round(n), 0), 60000);
}

function resolvePreconditionModeAndAction(
  act: any,
  matchedOpt?: CommandOption,
  cmd?: Command
): { mode: string; action: string } {
  const explicitMode = act?.precon_mode || act?.mode;
  const optionMode = (matchedOpt as any)?.precon_mode;
  const labelHint = `${act?.command || ''} ${act?.option_label || ''} ${matchedOpt?.label || ''}`.toLowerCase();
  const labelIndicatesStop = /\b(stop|cancel|off)\b/.test(labelHint);

  let mode = explicitMode || optionMode;
  if (!mode) {
    if (labelIndicatesStop) {
      mode = 'cancel';
    } else if (labelHint.includes('continuous')) {
      mode = 'continuous';
    } else if (labelHint.includes('once') || labelHint.includes('single')) {
      mode = 'once';
    } else {
      mode = (cmd as any)?.precon_mode || 'persistent';
    }
  }

  const modeLower = String(mode).toLowerCase().trim();
  const modeIndicatesStop = modeLower === 'cancel' || modeLower === 'off';
  const explicitAction = act?.precon_action || act?.action;
  const explicitActionLower = explicitAction ? String(explicitAction).toLowerCase().trim() : '';

  let action: string;
  if (modeIndicatesStop || labelIndicatesStop) {
    action = explicitActionLower === 'toggle' ? 'toggle' : 'stop';
    if (!explicitMode && labelIndicatesStop) {
      mode = 'cancel';
    }
  } else if (explicitActionLower) {
    action = explicitActionLower;
  } else {
    action = 'start';
  }

  return {
    mode: String(mode).toLowerCase().trim() || 'persistent',
    action
  };
}

const ALL_SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const WEEKDAY_SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
const WEEKEND_SCHEDULE_DAYS = ['sat', 'sun'] as const;
const SCHEDULE_DAY_NUMBER_MAP: Record<number, string> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun'
};
const SCHEDULE_DAY_NAME_MAP: Record<string, string> = {
  sun: 'sun',
  sunday: 'sun',
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat'
};

function expandScheduleDays(rawDays: unknown): string[] {
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    return [...ALL_SCHEDULE_DAYS];
  }
  const seen = new Set<string>();
  for (const entry of rawDays) {
    if (typeof entry === 'number' && Number.isInteger(entry)) {
      const mapped = SCHEDULE_DAY_NUMBER_MAP[entry];
      if (mapped) seen.add(mapped);
    } else if (typeof entry === 'string') {
      const lower = entry.trim().toLowerCase();
      if (lower === 'all' || lower === 'everyday' || lower === 'daily') {
        ALL_SCHEDULE_DAYS.forEach(d => seen.add(d));
      } else if (lower === 'weekdays') {
        WEEKDAY_SCHEDULE_DAYS.forEach(d => seen.add(d));
      } else if (lower === 'weekends') {
        WEEKEND_SCHEDULE_DAYS.forEach(d => seen.add(d));
      } else if (/^\d+$/.test(lower)) {
        const mapped = SCHEDULE_DAY_NUMBER_MAP[parseInt(lower, 10)];
        if (mapped) seen.add(mapped);
      } else if (SCHEDULE_DAY_NAME_MAP[lower]) {
        seen.add(SCHEDULE_DAY_NAME_MAP[lower]);
      }
    }
  }
  if (seen.size === 0) {
    return [...ALL_SCHEDULE_DAYS];
  }
  return ALL_SCHEDULE_DAYS.filter(d => seen.has(d));
}

function normalizeConditionGroupLogic(val: unknown): 'and' | 'or' | 'not' | undefined {
  if (typeof val !== 'string') return undefined;
  const lower = val.trim().toLowerCase();
  if (lower === 'and' || lower === 'and_group') return 'and';
  if (lower === 'or' || lower === 'or_group') return 'or';
  if (lower === 'not' || lower === 'not_group') return 'not';
  return undefined;
}

function isHoldDurationBleAction(action?: string): boolean {
  return typeof action === 'string' && /^hold_\d+s$/i.test(action.trim());
}

function normalizeBleButtonAction(
  rawAction: unknown,
  rawClickCount?: unknown
): { ble_action?: string; click_count?: number } {
  let clickCount: number | undefined;
  if (rawClickCount !== undefined && rawClickCount !== null && rawClickCount !== '') {
    clickCount = clampInt(rawClickCount, 1, 5, 1);
  }

  let action = typeof rawAction === 'string' ? rawAction.trim() : undefined;
  const lower = action ? action.toLowerCase() : '';

  if (lower === 'single_press') {
    action = 'press';
  } else if (lower === 'double_press') {
    action = 'press';
    if (!clickCount || clickCount <= 1) {
      clickCount = 2;
    }
  } else if (lower === 'triple_press') {
    action = 'press';
    if (!clickCount || clickCount <= 1) {
      clickCount = 3;
    }
  }

  if (isHoldDurationBleAction(action) && clickCount !== undefined && clickCount > 1) {
    clickCount = 1;
  }

  return { ble_action: action || undefined, click_count: clickCount };
}

const RELATIONAL_OR_INEQUALITY_OPS = new Set([
  'less_than',
  'less_than_or_equal',
  'greater_than',
  'greater_than_or_equal',
  'not_equal',
  'less',
  'greater',
  'not_equals',
  '<',
  '<=',
  '>',
  '>=',
  '!='
]);

function pickSustainedFields(node: { for_sec?: unknown; for_s?: unknown; for_ms?: unknown }): { for_sec?: number; for_ms?: number } {
  if (!node || typeof node !== 'object') return {};
  const result: { for_sec?: number; for_ms?: number } = {};
  if (node.for_ms !== undefined && node.for_ms !== null && node.for_ms !== '') {
    const ms = Number(node.for_ms);
    if (Number.isFinite(ms) && ms > 0) {
      const rounded = Math.round(ms);
      if (rounded > 0) {
        result.for_ms = Math.min(rounded, MAX_SUSTAINED_MS);
      }
    }
  }
  const rawSec = node.for_sec !== undefined ? node.for_sec : node.for_s;
  if (rawSec !== undefined && rawSec !== null && rawSec !== '') {
    const sec = Number(rawSec);
    if (Number.isFinite(sec) && sec > 0) {
      result.for_sec = Math.min(sec, MAX_SUSTAINED_SEC);
    }
  }
  return result;
}

/**
 * Compiles a condition into standard CAN Do schema
 */
export function compileCondition(
  cond: AutomationCondition,
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null
): any {
  if (!isPlainObject(cond)) return undefined;
  const sustained = pickSustainedFields(cond as any);
  const groupLogic: 'and' | 'or' | 'not' | undefined =
    normalizeConditionGroupLogic(cond.logic) ||
    normalizeConditionGroupLogic(cond.type) ||
    (Array.isArray(cond.and) ? 'and' : undefined) ||
    (Array.isArray(cond.or) ? 'or' : undefined) ||
    (cond.not !== undefined && cond.not !== null ? 'not' : undefined);

  if (groupLogic) {
    let rawChildren: AutomationCondition[] = [];
    if (Array.isArray(cond.conditions) && cond.conditions.length > 0) {
      rawChildren = cond.conditions;
    } else if (groupLogic === 'and' && Array.isArray(cond.and)) {
      rawChildren = cond.and;
    } else if (groupLogic === 'or' && Array.isArray(cond.or)) {
      rawChildren = cond.or;
    } else if (groupLogic === 'not' && cond.not !== undefined && cond.not !== null) {
      rawChildren = Array.isArray(cond.not) ? cond.not : [cond.not];
    } else if (Array.isArray(cond.conditions)) {
      rawChildren = cond.conditions;
    }

    const subConds = rawChildren
      .filter(isPlainObject)
      .map(c => compileCondition(c as AutomationCondition, catalog, vehicle))
      .filter((c): c is NonNullable<typeof c> => c !== undefined && c !== null);

    if (groupLogic === 'and') return { and: subConds, ...sustained };
    if (groupLogic === 'or') return { or: subConds, ...sustained };
    if (groupLogic === 'not') {
      if (subConds.length === 0) return undefined;
      return { not: subConds.length === 1 ? subConds[0] : subConds, ...sustained };
    }
  }

  // Multi-option state check: if multiple options on the same entity touch the same byte, desugar to OR group
  if (cond.source_command_id && cond.selected_options && cond.selected_options.length > 1) {
    const rawCmd = catalog.commands?.find(c => c.id === cond.source_command_id);
    const cmd = rawCmd ? resolveVariant(rawCmd, vehicle) : undefined;
    if (cmd && cmd.options) {
      const matchedOpts = cmd.options.filter(o =>
        cond.selected_options!.some(sel => asString(sel).toLowerCase() === asString(o.label).toLowerCase())
      );
      if (matchedOpts.length > 1) {
        const byteMapSeen: Record<string, string> = {};
        let hasConflict = false;
        for (const opt of matchedOpts) {
          const m = compileToByteMap(opt.match || opt.payload, true);
          for (const [k, v] of Object.entries(m)) {
            if (byteMapSeen[k] !== undefined && byteMapSeen[k] !== v) {
              hasConflict = true;
              break;
            }
            byteMapSeen[k] = v;
          }
          if (hasConflict) break;
        }
        if (hasConflict) {
          const subConds = matchedOpts.map(opt =>
            compileCondition(commandToCondition(cmd, opt, vehicle), catalog, vehicle)
          );
          return {
            or: subConds,
            ...(cond.id ? { id: cond.id } : {}),
            source_command_id: cond.source_command_id,
            ...(cond.source_command_name ? { source_command_name: cond.source_command_name } : {}),
            ...(cond.option_label ? { option_label: cond.option_label } : {}),
            selected_options: cond.selected_options,
            ...sustained
          };
        }
      }
    }
  }

  if (cond.type === 'triggered_by' || cond.type === 'trigger' || cond.trigger_id !== undefined) {
    return {
      type: 'triggered_by',
      trigger_id: cond.trigger_id || '',
      ...(cond.source_command_id ? { source_command_id: cond.source_command_id } : {}),
      ...(cond.source_command_name ? { source_command_name: cond.source_command_name } : {}),
      ...(cond.option_label ? { option_label: cond.option_label } : {})
    };
  }

  if (cond.type === 'time_condition' || cond.type === 'time') {
    return {
      type: 'time_condition',
      start_time: cond.start_time || '08:00',
      end_time: cond.end_time || '18:00',
      days: expandScheduleDays(cond.days)
    };
  }

  if (cond.type === 'device_state' || cond.type === 'wifi' || cond.type === 'wifi_condition') {
    const rawAny = cond as any;
    const deviceProperty = cond.device_property || 'wifi_ssid';
    const resolvedTargetString = cond.target_string || rawAny.ssid || rawAny.client_mac;
    const clampedRssi = clampRssi(cond.target_rssi);
    const hasNonZeroRssi = clampedRssi !== undefined && clampedRssi !== 0;
    const isRssiCapableWifiProp =
      deviceProperty === 'wifi_connected' ||
      deviceProperty === 'wifi_rssi' ||
      deviceProperty === 'ap_client_rssi';
    const effectiveOp =
      cond.operator || (hasNonZeroRssi && isRssiCapableWifiProp ? 'greater_than_or_equal' : undefined);
    return {
      type: 'device_state',
      device_property: deviceProperty,
      ...(resolvedTargetString ? { target_string: resolvedTargetString } : {}),
      ...(effectiveOp ? { operator: effectiveOp } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {}),
      ...sustained
    };
  }

  if (cond.type === 'ble_button' || cond.type === 'ble_key' || cond.type === 'ble') {
    const normalizedBle = normalizeBleButtonAction(cond.ble_action);
    return {
      type: 'ble_button',
      ble_button: cond.ble_button || cond.target_string || 'volume_up',
      ble_action: normalizedBle.ble_action || 'press',
      ...(cond.ble_device ? { ble_device: cond.ble_device } : {})
    };
  }

  if (
    cond.type === 'ble_beacon' ||
    cond.type === 'beacon' ||
    (cond.type === 'ble_presence' &&
      (Boolean(cond.beacon_uuid) ||
        Boolean(cond.beacon_major || cond.beacon_minor) ||
        cond.device_property === 'beacon_present' ||
        cond.device_property === 'beacon_rssi' ||
        cond.device_property === 'present' ||
        cond.device_property === 'away'))
  ) {
    const resolvedBeaconUuid = cond.beacon_uuid || cond.target_string;
    const clampedRssi = clampRssi(cond.target_rssi);
    const hasNonZeroRssi = clampedRssi !== undefined && clampedRssi !== 0;
    const effectiveOp = cond.operator || (hasNonZeroRssi ? 'greater_than_or_equal' : undefined);
    return {
      type: 'ble_beacon',
      device_property: cond.device_property || (cond.target_bool === false ? 'away' : 'present'),
      ...(resolvedBeaconUuid ? { beacon_uuid: resolvedBeaconUuid } : {}),
      ...(cond.beacon_major ? { beacon_major: cond.beacon_major } : {}),
      ...(cond.beacon_minor ? { beacon_minor: cond.beacon_minor } : {}),
      ...(cond.ble_device ? { ble_device: cond.ble_device } : {}),
      ...(cond.target_string ? { target_string: cond.target_string } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {}),
      ...(effectiveOp ? { operator: effectiveOp } : {}),
      ...sustained
    };
  }

  if (cond.type === 'ble_device' || cond.type === 'ble_presence') {
    const resolvedBleDevice = cond.ble_device || cond.target_string;
    const clampedRssi = clampRssi(cond.target_rssi);
    const hasNonZeroRssi = clampedRssi !== undefined && clampedRssi !== 0;
    const effectiveOp = cond.operator || (hasNonZeroRssi ? 'greater_than_or_equal' : undefined);
    return {
      type: 'ble_device',
      device_property: cond.device_property || 'connected',
      ...(resolvedBleDevice ? { ble_device: resolvedBleDevice } : {}),
      ...(cond.target_string ? { target_string: cond.target_string } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {}),
      ...(effectiveOp ? { operator: effectiveOp } : {}),
      ...sustained
    };
  }

  if (cond.type === 'voltage') {
    const rawVal = cond.value ?? cond.voltage_val ?? '12.4';
    const numVal = parseFloat(String(rawVal)) || 12.4;
    return {
      type: 'voltage',
      operator: cond.operator || (cond.voltage_dir === 'below' ? 'less' : 'greater'),
      value: numVal,
      ...sustained
    };
  }

  const match = compileToByteMap(cond.match || (cond as any).evaluate?.match || (cond as any).payload || cond.match_payload, true);
  const baseOp = cond.operator || cond.evaluate?.operator || 'equal';
  const op =
    cond.invert === true
      ? baseOp === 'equal'
        ? 'not_equal'
        : baseOp === 'not_equal'
          ? 'equal'
          : baseOp
      : baseOp;

  const matchKeys = Object.keys(match);
  if (matchKeys.length > 1) {
    const fullMask = resolveMaskForMatch(cond.mask ?? cond.evaluate?.mask, matchKeys);
    return {
      can_id: cond.can_id || '0x000',
      bus: cond.bus ?? 0,
      match,
      mask: fullMask,
      operator: op,
      ...(cond.source_command_id ? { source_command_id: cond.source_command_id } : {}),
      ...(cond.source_command_name ? { source_command_name: cond.source_command_name } : {}),
      ...(cond.option_label ? { option_label: cond.option_label } : {}),
      ...(cond.selected_options && cond.selected_options.length > 0 ? { selected_options: cond.selected_options } : {}),
      ...sustained
    };
  }

  const dKey = resolveByteKeyWithIndexFallback(
    cond.byte || cond.evaluate?.byte,
    matchKeys[0],
    cond.byte_index ?? cond.evaluate?.byte_index,
    'D1'
  );
  const targetVal = cond.value || cond.evaluate?.value || match[dKey] || '0x01';
  const maskVal = resolveMaskForMatch(cond.mask ?? cond.evaluate?.mask, matchKeys, dKey, '0xFF', true);

  return {
    can_id: cond.can_id || '0x000',
    bus: cond.bus ?? 0,
    byte: dKey,
    mask: maskVal,
    operator: op,
    value: targetVal,
    ...(cond.source_command_id ? { source_command_id: cond.source_command_id } : {}),
    ...(cond.source_command_name ? { source_command_name: cond.source_command_name } : {}),
    ...(cond.option_label ? { option_label: cond.option_label } : {}),
    ...(cond.selected_options && cond.selected_options.length > 0 ? { selected_options: cond.selected_options } : {}),
    ...sustained
  };
}

interface InlineStepsParams {
  steps: any[];
  act: AutomationAction;
  catalog: Catalog;
  vehicle: Vehicle | null;
  defaultCanId: string;
  formatStepCanId?: boolean;
  defaultBus: number;
  defaultInterStepDelayMs: number;
  defaultTxDelayFallbackMs: number;
  fallbackRepeat?: unknown;
  fallbackSteps?: any[];
  sourceId?: string;
  sourceName?: string;
  optionLabel?: string;
  preserveExplicitZeroDelay?: boolean;
}

function inlineSteps(params: InlineStepsParams): any[] {
  const {
    steps,
    act,
    catalog,
    vehicle,
    defaultCanId,
    formatStepCanId = false,
    defaultBus,
    defaultInterStepDelayMs,
    defaultTxDelayFallbackMs,
    fallbackRepeat,
    fallbackSteps,
    sourceId,
    sourceName,
    optionLabel,
    preserveExplicitZeroDelay = false
  } = params;

  const stepGroupId = steps.length > 1 ? (act.id || generateBlockId('grp')) : undefined;
  const inlinedSteps: any[] = [];

  steps.forEach((step: any, idx: number) => {
    if (step.type === 'delay') {
      inlinedSteps.push({
        type: 'delay',
        ms: clampInt(step.delay_ms ?? step.dwell_ms ?? step.ms, 0, MAX_DELAY_MS, 500),
        ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
      });
      return;
    }
    if (step.type === 'repeat_until' || step.type === 'wait_for') {
      const rawConds = Array.isArray(step.conditions) && step.conditions.length > 0
        ? step.conditions
        : (step.condition ? [step.condition] : []);
      const compiledConds = rawConds
        .filter(isPlainObject)
        .map((c: any) => compileCondition(c as AutomationCondition, catalog, vehicle))
        .filter(Boolean);
      inlinedSteps.push({
        type: step.type,
        interval_ms: clampInt(step.interval_ms, 0, MAX_DELAY_MS, step.type === 'wait_for' ? 50 : 1000),
        timeout_ms: clampInt(step.timeout_ms, 0, MAX_DELAY_MS, step.type === 'wait_for' ? 10000 : 30000),
        ...(compiledConds.length === 1 ? { condition: compiledConds[0] } : {}),
        ...(compiledConds.length > 1 ? { conditions: compiledConds } : {}),
        ...(step.sequence ? { sequence: compileActionList(step.sequence, catalog, vehicle) } : {}),
        ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
      });
      return;
    }

    let stepPayload = compileToByteMap(step.payload);
    if (Object.keys(stepPayload).length === 0 && fallbackSteps && fallbackSteps[idx]?.payload) {
      stepPayload = compileToByteMap(fallbackSteps[idx].payload);
    }

    const stepRepeat = clampInt(step.repeat ?? fallbackRepeat, 1, MAX_STEP_REPEAT, 1);
    const shouldEmitTxDelay = steps.length === 1 || stepRepeat > 1;
    const rawStepTxDelay = shouldEmitTxDelay
      ? (step.delay_ms !== undefined && step.delay_ms > 0
          ? step.delay_ms
          : (act.delay_ms !== undefined && act.delay_ms > 0 ? act.delay_ms : defaultTxDelayFallbackMs))
      : 0;
    const stepTxDelayMs = clampTransmitDelayMs(rawStepTxDelay);

    const rawCanId = step.can_id || defaultCanId;
    const resolvedCanId = formatStepCanId ? formatCanId(rawCanId) : rawCanId;

    inlinedSteps.push({
      type: 'transmit',
      can_id: resolvedCanId,
      bus: step.bus ?? defaultBus,
      payload: stepPayload,
      repeat: stepRepeat,
      ...(stepTxDelayMs > 0 ? { delay_ms: stepTxDelayMs } : {}),
      ...(stepGroupId ? { _step_group_id: stepGroupId } : {}),
      ...(idx === 0 ? {
        ...(sourceId ? { source_command_id: sourceId } : {}),
        ...(sourceName ? { source_command_name: sourceName } : {}),
        ...(optionLabel ? { option_label: optionLabel } : {}),
        ...(sourceId ? { entity_id: sourceId } : {})
      } : {})
    });

    if (idx < steps.length - 1 && steps[idx + 1]?.type !== 'delay') {
      const rawInterDelay = preserveExplicitZeroDelay
        ? (step.delay_ms ?? defaultInterStepDelayMs)
        : (step.delay_ms !== undefined && step.delay_ms > 0 ? step.delay_ms : defaultInterStepDelayMs);
      const interDelay = clampInt(rawInterDelay, 0, MAX_DELAY_MS, 0);
      if (interDelay > 0) {
        inlinedSteps.push({
          type: 'delay',
          ms: interDelay,
          ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
        });
      }
    }
  });

  return inlinedSteps;
}

/**
 * Compiles an AutomationAction into an inlined transmit sequence, delay, if_then, choose, popup, or climate target
 */
export function compileAction(
  act: AutomationAction,
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null
): any | any[] {
  if (!isPlainObject(act)) return undefined;

  if (act.type === 'if_then') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'if_then',
      conditions: (Array.isArray(act.conditions) ? act.conditions : [])
        .filter(isPlainObject)
        .map(c => compileCondition(c as AutomationCondition, catalog, vehicle))
        .filter(Boolean),
      then: compileActionList(act.then || [], catalog, vehicle),
      else: compileActionList(act.else || [], catalog, vehicle)
    };
  }

  if (act.type === 'choose') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'choose',
      choices: (Array.isArray(act.choices) ? act.choices : [])
        .filter(isPlainObject)
        .map(c => ({
          ...(c.label ? { label: c.label } : {}),
          conditions: (Array.isArray(c.conditions) ? c.conditions : [])
            .filter(isPlainObject)
            .map(cond => compileCondition(cond as AutomationCondition, catalog, vehicle))
            .filter(Boolean),
          sequence: compileActionList(c.sequence || [], catalog, vehicle)
        })),
      default: compileActionList(act.default || [], catalog, vehicle)
    };
  }

  if (act.type === 'repeat_until' || act.type === 'wait_for') {
    const rawConds = Array.isArray(act.conditions) && act.conditions.length > 0
      ? act.conditions
      : (act.condition ? [act.condition] : []);
    const compiledConds = rawConds
      .filter(isPlainObject)
      .map(c => compileCondition(c as AutomationCondition, catalog, vehicle))
      .filter(Boolean);
    return {
      ...(act.id ? { id: act.id } : {}),
      type: act.type,
      interval_ms: clampInt(act.interval_ms, 0, MAX_DELAY_MS, act.type === 'wait_for' ? 50 : 1000),
      timeout_ms: clampInt(act.timeout_ms, 0, MAX_DELAY_MS, act.type === 'wait_for' ? 10000 : 30000),
      ...(compiledConds.length === 1 ? { condition: compiledConds[0] } : {}),
      ...(compiledConds.length > 1 ? { conditions: compiledConds } : {}),
      ...(act.sequence ? { sequence: compileActionList(act.sequence, catalog, vehicle) } : {})
    };
  }

  if (act.type === 'delay') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'delay',
      ms: clampInt(act.delay_ms ?? act.ms, 0, MAX_DELAY_MS, 500)
    };
  }

  if (act.type === 'track_popup' || act.type === 'popup') {
    const rawAny = act as any;
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'track_popup',
      level: act.level || 'info',
      text: asString(act.text ?? rawAny.message ?? act.popup_message ?? rawAny.popup_text ?? '')
    };
  }

  if (act.type === 'climate_target' || act.type === 'remote_climate' || act.type === 'climate') {
    const rawAny = act as any;
    const rawTempC = act.target_temp_c ?? act.target_c ?? rawAny.target_temp ?? rawAny.temp;
    const rawTempF = rawAny.target_temp_f ?? rawAny.target_f ?? rawAny.temp_f;
    let tempC = 22.0;
    if (rawTempC !== undefined && rawTempC !== null && rawTempC !== '' && Number.isFinite(Number(rawTempC))) {
      tempC = Number(rawTempC);
    } else if (rawTempF !== undefined && rawTempF !== null && rawTempF !== '' && Number.isFinite(Number(rawTempF))) {
      tempC = ((Number(rawTempF) - 32) * 5) / 9;
    }
    const durationMinutes = clampInt(act.duration_minutes ?? rawAny.duration_min ?? rawAny.duration, 0, 1440, 10);
    const zone = act.zone || rawAny.climate_zone || 'driver';
    const rawSyncOn = act.sync_on !== undefined ? act.sync_on : rawAny.climate_sync_on;
    const rawDriverOnly = act.driver_only !== undefined ? act.driver_only : rawAny.climate_driver_only;
    const rawMonitor0x38 = act.monitor_0x38 !== undefined ? act.monitor_0x38 : rawAny.smart;
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'climate_target',
      target_temp_c: tempC,
      defrost: !!act.defrost,
      duration_minutes: durationMinutes,
      zone,
      ...(rawSyncOn !== undefined ? { sync_on: !!rawSyncOn } : {}),
      ...(rawDriverOnly !== undefined ? { driver_only: !!rawDriverOnly } : {}),
      ...(rawMonitor0x38 !== undefined ? { monitor_0x38: !!rawMonitor0x38 } : {})
    };
  }

  if (act.type === 'hud_nav' || act.type === 'nav') {
    const rawAny = act as any;
    const navAction = act.nav_action || act.action || 'update';
    if (navAction === 'clear') {
      return {
        ...(act.id ? { id: act.id } : {}),
        type: 'hud_nav',
        action: 'clear'
      };
    }

    const rawLaneDirs = Array.isArray(act.lane_directions) ? act.lane_directions : [];
    const rawLaneRecs = Array.isArray(act.lane_recommended)
      ? act.lane_recommended
      : Array.isArray(rawAny.lane_highlights)
        ? rawAny.lane_highlights
        : [];
    const inferredLaneCount = Math.max(rawLaneDirs.length, rawLaneRecs.length);
    const numLanes = clampInt(act.num_lanes ?? act.lanes ?? inferredLaneCount, 0, 8, 0);
    const laneDirections = Array.from({ length: numLanes }, (_, idx) => {
      const v = Number(rawLaneDirs[idx]);
      return Number.isFinite(v) ? Math.trunc(v) : 1;
    });
    const laneRecommended = Array.from({ length: numLanes }, (_, idx) => (rawLaneRecs[idx] ? 1 : 0));

    const distanceMeters = act.distance_meters ?? act.distance;
    const directionDeg =
      act.direction_deg ?? rawAny.heading ?? (typeof act.direction === 'number' ? act.direction : undefined);

    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'hud_nav',
      icon: act.icon ?? 1,
      ...(directionDeg !== undefined ? { direction_deg: directionDeg } : {}),
      ...(distanceMeters !== undefined ? { distance_meters: distanceMeters } : {}),
      ...(act.bars !== undefined ? { bars: act.bars } : {}),
      ...(act.speed_limit !== undefined ? { speed_limit: act.speed_limit } : {}),
      ...(act.camera_alert !== undefined ? { camera_alert: !!act.camera_alert } : {}),
      ...(act.street ? { street: act.street } : {}),
      ...(numLanes > 0
        ? {
            num_lanes: numLanes,
            lane_directions: laneDirections,
            lane_recommended: laneRecommended
          }
        : {})
    };
  }

  if (act.type === 'cycle_entity') {
    const entId = act.entity_id || act.target_command_id || 'drivers_seat_comfort';
    const cmd = catalog.commands?.find(c => c.id === entId || c.entity_id === entId);
    const defaultStates = cmd?.options && cmd.options.length > 0
      ? cmd.options.map(o => o.label)
      : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
    const states = act.states && act.states.length > 0 ? act.states : defaultStates;

    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'cycle_entity',
      entity_id: cmd?.id || entId,
      ...(act.target_command_id && act.target_command_id !== (cmd?.id || entId)
        ? { target_command_id: act.target_command_id }
        : {}),
      states,
      direction: act.direction || 'forward',
      wrap: act.wrap !== false,
      fallback_state: act.fallback_state || '__first__',
      show_popup: act.show_popup !== false,
      ...(act.popup_prefix !== undefined ? { popup_prefix: act.popup_prefix } : {}),
      level: act.level || 'info'
    };
  }

  if (act.type === 'precondition' || act.type === 'battery_preconditioning') {
    const preconCmd = catalog?.commands?.find(c => c.id === 'battery_preconditioning' || c.type === 'precondition');
    const matchedOpt = preconCmd ? findMatchingOptionForAction(preconCmd, act, false) : undefined;
    const { mode, action } = resolvePreconditionModeAndAction(act, matchedOpt, preconCmd);
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'precondition',
      mode,
      action
    };
  }

  // Handle explicit transmit, transmit_frame, or raw can_tx: inline multiple steps if defined, or return single transmit frame
  if (isTransmitActionType(act.type)) {
    const resolvedForFallback = catalog ? resolveCatalogCommandForAction(act, catalog, vehicle) : {};
    const fallbackCmd = resolvedForFallback.command;
    const matchedEffect = fallbackCmd ? findMatchingEffectForAction(fallbackCmd, act) : undefined;
    if (fallbackCmd && matchedEffect) {
      return {
        ...(act.id ? { id: act.id } : {}),
        type: 'entity_command',
        entity_id: fallbackCmd.id,
        command: matchedEffect.label,
        source_command_id: fallbackCmd.id,
        source_command_name: fallbackCmd.ha_metadata?.name || fallbackCmd.name || fallbackCmd.id,
        option_label: matchedEffect.label
      };
    }
    const fallbackOptSteps = Array.isArray(resolvedForFallback.matchedOption?.steps)
      ? resolvedForFallback.matchedOption!.steps.filter(isPlainObject)
      : undefined;
    const fallbackOpt = resolvedForFallback.matchedOption;

    // If act has no explicit steps yet, but resolves to a catalog option with multi-step burst, use those steps
    const validActSteps = Array.isArray(act.steps) ? act.steps.filter(isPlainObject) : undefined;
    const effectiveSteps =
      validActSteps && validActSteps.length > 1
        ? validActSteps
        : !act.steps && fallbackOptSteps && fallbackOptSteps.length > 1
          ? fallbackOptSteps
          : undefined;

    const resolvedSourceId = act.source_command_id || act.entity_id || fallbackCmd?.id;
    const resolvedSourceName = act.source_command_name || fallbackCmd?.ha_metadata?.name || fallbackCmd?.name;
    const resolvedOptLabel = act.option_label || act.command || fallbackOpt?.label;

    if (effectiveSteps && effectiveSteps.length > 1) {
      const defaultDelayMs = fallbackCmd?.network?.delay_ms ?? fallbackCmd?.delay_ms ?? act.delay_ms ?? 20;
      return inlineSteps({
        steps: effectiveSteps,
        act,
        catalog,
        vehicle,
        defaultCanId: act.can_id || fallbackCmd?.network?.action_can_id || fallbackCmd?.action_can_id || '0x000',
        formatStepCanId: true,
        defaultBus: act.bus ?? resolveActionBus(fallbackCmd),
        defaultInterStepDelayMs: defaultDelayMs,
        defaultTxDelayFallbackMs: defaultDelayMs,
        fallbackRepeat: act.repeat,
        fallbackSteps: fallbackOptSteps,
        sourceId: resolvedSourceId,
        sourceName: resolvedSourceName,
        optionLabel: resolvedOptLabel
      });
    }

    const payload = compileToByteMap(act.payload || act.to_payload);
    const txDelayMs = clampTransmitDelayMs(
      act.delay_ms ?? fallbackOpt?.delay_ms ?? fallbackCmd?.network?.delay_ms ?? fallbackCmd?.delay_ms ?? 0
    );
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'transmit',
      can_id: formatCanId(act.can_id || '0x000'),
      bus: act.bus ?? resolveActionBus(fallbackCmd),
      payload,
      repeat: clampInt(act.repeat, 1, MAX_STEP_REPEAT, 1),
      ...(txDelayMs > 0 ? { delay_ms: txDelayMs } : {}),
      ...(resolvedSourceId ? { source_command_id: resolvedSourceId } : {}),
      ...(resolvedSourceName ? { source_command_name: resolvedSourceName } : {}),
      ...(resolvedOptLabel ? { option_label: resolvedOptLabel } : {}),
      ...(resolvedSourceId ? { entity_id: resolvedSourceId } : {})
    };
  }

  // Handle entity_command: Inline catalog command definition into native CAN transmit bursts
  if (act.type === 'entity_command' || (!act.type && (act.entity_id || act.command))) {
    const entityId = act.entity_id || act.source_command_id;
    const commandLabel = act.command || act.option_label;
    const rawCmd = (catalog?.commands || []).find(c => c.id === entityId);
    const cmd = rawCmd ? resolveVariant(rawCmd, vehicle) : undefined;

    if (cmd) {
      const matchedEffect = findMatchingEffectForAction(cmd, act);
      if (matchedEffect) {
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'entity_command',
          entity_id: cmd.id,
          command: matchedEffect.label,
          source_command_id: cmd.id,
          source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
          option_label: matchedEffect.label
        };
      }

      if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
        const preconOpt = findMatchingOptionForAction(cmd, act, false);
        const { mode, action } = resolvePreconditionModeAndAction(act, preconOpt, cmd);
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'precondition',
          mode,
          action
        };
      }

      // Match designated option using robust matcher
      const opt = findMatchingOptionForAction(cmd, act);

      const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || act.can_id || '0x000';
      const bus = resolveActionBus(cmd, act.bus);
      const delayMs = cmd.network?.delay_ms ?? cmd.delay_ms ?? act.delay_ms ?? 20;
      const cmdTxDelayFallback = cmd.network?.delay_ms ?? cmd.delay_ms ?? 0;
      const cmdDisplayName = cmd.ha_metadata?.name || cmd.name || cmd.id;

      // Case A: Option defines multi-step burst (e.g. heated/cooled seat sequence or remote climate)
      const validOptSteps = Array.isArray(opt?.steps) ? opt!.steps.filter(isPlainObject) : [];
      if (validOptSteps.length > 0) {
        return inlineSteps({
          steps: validOptSteps,
          act,
          catalog,
          vehicle,
          defaultCanId: canId,
          defaultBus: bus,
          defaultInterStepDelayMs: delayMs,
          defaultTxDelayFallbackMs: cmdTxDelayFallback,
          sourceId: entityId,
          sourceName: cmdDisplayName,
          optionLabel: opt?.label || commandLabel
        });
      }

      // Case B: Option defines a single payload
      if (opt?.payload) {
        const p = compileToByteMap(opt.payload);
        const txDelayMs = clampTransmitDelayMs(opt.delay_ms ?? act.delay_ms ?? cmd.network?.delay_ms ?? cmd.delay_ms ?? 0);
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: canId,
          bus: bus,
          payload: p,
          repeat: clampInt(opt.repeat, 1, MAX_STEP_REPEAT, 1),
          ...(txDelayMs > 0 ? { delay_ms: txDelayMs } : {}),
          source_command_id: entityId,
          source_command_name: cmdDisplayName,
          option_label: opt?.label || commandLabel,
          entity_id: entityId
        };
      }

      // Case C: Command defines root steps
      if (cmd.steps && cmd.steps.length > 0) {
        let srcSteps: any[] = cmd.steps;
        let stepsLabel = opt?.label || commandLabel;
        if (isRangeCommand(cmd)) {
          // param_range with template steps (command burst + latch): substitute {value}
          const parsedPhys = commandLabel !== undefined ? parseFloat(String(commandLabel)) : (typeof act.target_temp_c === 'number' ? act.target_temp_c : NaN);
          const phys = !isNaN(parsedPhys) ? parsedPhys : getDefaultPhysicalValue(cmd.network);
          const hex = `0x${physicalToRawByte(phys, cmd.network).toString(16).toUpperCase().padStart(2, '0')}`;
          srcSteps = resolveRangeSteps(cmd, hex) || cmd.steps;
          if (!stepsLabel) stepsLabel = `${phys}${cmd.network?.unit || ''}`;
        }
        const validSrcSteps = srcSteps.filter(isPlainObject);
        return inlineSteps({
          steps: validSrcSteps,
          act,
          catalog,
          vehicle,
          defaultCanId: canId,
          defaultBus: bus,
          defaultInterStepDelayMs: delayMs,
          defaultTxDelayFallbackMs: cmdTxDelayFallback,
          sourceId: entityId,
          sourceName: cmdDisplayName,
          optionLabel: stepsLabel,
          preserveExplicitZeroDelay: true
        });
      }

      // Case D: Command defines root payload
      if (cmd.payload) {
        const p = compileToByteMap(cmd.payload);
        const txDelayMs = clampTransmitDelayMs(act.delay_ms ?? cmd.network?.delay_ms ?? cmd.delay_ms ?? 0);
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: canId,
          bus: bus,
          payload: p,
          repeat: clampInt(cmd.repeat, 1, MAX_STEP_REPEAT, 1),
          ...(txDelayMs > 0 ? { delay_ms: txDelayMs } : {}),
          source_command_id: entityId,
          source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
          option_label: opt?.label || commandLabel,
          entity_id: entityId
        };
      }

      // Case E: param_range / numeric range command without discrete options
      if (isRangeCommand(cmd)) {
        const existingPayload = compileToByteMap(act.payload || act.to_payload);
        let rangePayload = existingPayload;
        let labelOut = commandLabel;
        if (Object.keys(rangePayload).length === 0) {
          const parsedPhys = commandLabel !== undefined ? parseFloat(String(commandLabel)) : (typeof act.target_temp_c === 'number' ? act.target_temp_c : NaN);
          const targetPhys = !isNaN(parsedPhys) ? parsedPhys : getDefaultPhysicalValue(cmd.network);
          const rawByte = physicalToRawByte(targetPhys, cmd.network);
          const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
          rangePayload = buildRangeActionPayload(hexVal, cmd.network);
          if (!labelOut) {
            labelOut = `${targetPhys}${cmd.network?.unit || ''}`;
          }
        }
        const txDelayMs = clampTransmitDelayMs(act.delay_ms ?? cmd.network?.delay_ms ?? cmd.delay_ms ?? 0);
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: canId,
          bus: bus,
          payload: rangePayload,
          repeat: clampInt(act.repeat ?? cmd.repeat, 1, MAX_STEP_REPEAT, 1),
          ...(txDelayMs > 0 ? { delay_ms: txDelayMs } : {}),
          source_command_id: entityId,
          source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
          ...(labelOut ? { option_label: labelOut } : {}),
          entity_id: entityId
        };
      }
    }

    // Fallback: If can_id and payload provided, transmit it; otherwise entity_command
    if (act.can_id && act.payload) {
      const payload = compileToByteMap(act.payload || act.to_payload);
      const txDelayMs = clampTransmitDelayMs(act.delay_ms ?? 0);
      return {
        ...(act.id ? { id: act.id } : {}),
        type: 'transmit',
        can_id: act.can_id,
        bus: act.bus ?? 0,
        payload,
        repeat: clampInt(act.repeat, 1, MAX_STEP_REPEAT, 1),
        ...(txDelayMs > 0 ? { delay_ms: txDelayMs } : {}),
        ...(act.source_command_id ? { source_command_id: act.source_command_id } : {}),
        ...(act.source_command_name ? { source_command_name: act.source_command_name } : {}),
        ...(act.option_label ? { option_label: act.option_label } : {}),
        ...(act.entity_id ? { entity_id: act.entity_id } : {})
      };
    }

    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'entity_command',
      entity_id: entityId || '',
      command: commandLabel || ''
    };
  }

  if (act.type === 'webhook') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'webhook',
      ...(act.webhook_url ? { webhook_url: act.webhook_url } : {}),
      ...(act.webhook_method ? { webhook_method: act.webhook_method } : {})
    };
  }

  const payload = compileToByteMap(act.payload || act.to_payload);
  const txDelayMs = clampTransmitDelayMs(act.delay_ms ?? 0);
  return {
    ...(act.id ? { id: act.id } : {}),
    type: 'transmit',
    can_id: act.can_id || '',
    bus: act.bus ?? 0,
    payload,
    repeat: clampInt(act.repeat, 1, MAX_STEP_REPEAT, 1),
    ...(txDelayMs > 0 ? { delay_ms: txDelayMs } : {})
  };
}

function isEqualAction(a: any, b: any): boolean {
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  if (a.type === 'delay' && b.type === 'delay') {
    return (a.ms ?? a.delay_ms) === (b.ms ?? b.delay_ms);
  }
  if (isTransmitActionType(a.type) && isTransmitActionType(b.type)) {
    if (asString(a.can_id).toLowerCase() !== asString(b.can_id).toLowerCase()) return false;
    if ((a.bus ?? 0) !== (b.bus ?? 0)) return false;
    return payloadsEqual(a.payload, b.payload);
  }
  return false;
}

function hasExplicitActionIdentity(act: any): boolean {
  return Boolean(act?._step_group_id || act?.id || act?.source_command_id || act?.entity_id);
}

function deduplicateActionSequence(actions: any[]): any[] {
  if (!Array.isArray(actions)) return [];
  const validActions = actions.filter(isPlainObject);
  if (validActions.length <= 1) return validActions;

  const deduped: any[] = [];
  for (let i = 0; i < validActions.length; i++) {
    const curr = validActions[i];

    // Merge consecutive delays by summing durations (clamped to MAX_DELAY_MS) instead of dropping distinct delays
    if (curr.type === 'delay' && deduped.length > 0 && deduped[deduped.length - 1].type === 'delay') {
      const prev = deduped[deduped.length - 1];
      if (prev._step_group_id === curr._step_group_id) {
        const prevMs = clampInt(prev.ms ?? prev.delay_ms, 0, MAX_DELAY_MS, 0);
        const currMs = clampInt(curr.ms ?? curr.delay_ms, 0, MAX_DELAY_MS, 0);
        deduped[deduped.length - 1] = {
          ...prev,
          ms: clampInt(prevMs + currMs, 0, MAX_DELAY_MS, prevMs)
        };
        continue;
      }
    }

    // Only deduplicate identical _step_group_id-free legacy [delay, transmit] pairs without explicit identity
    if (
      curr.type === 'delay' &&
      !hasExplicitActionIdentity(curr) &&
      i + 1 < validActions.length &&
      isTransmitActionType(validActions[i + 1].type) &&
      !hasExplicitActionIdentity(validActions[i + 1])
    ) {
      const nextAct = validActions[i + 1];
      if (deduped.length >= 2) {
        const prevDelay = deduped[deduped.length - 2];
        const prevTransmit = deduped[deduped.length - 1];
        if (
          !hasExplicitActionIdentity(prevDelay) &&
          !hasExplicitActionIdentity(prevTransmit) &&
          isEqualAction(curr, prevDelay) &&
          isEqualAction(nextAct, prevTransmit)
        ) {
          // Skip duplicate legacy [delay, transmit] pair
          i++; // skip nextAct
          continue;
        }
      }
    }

    deduped.push(curr);
  }
  return deduped;
}

/**
 * Compiles a list of actions, flattening inlined action sequences
 */
export function compileActionList(
  actions: AutomationAction[],
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null
): any[] {
  const normalizedActions = decompileActionList(actions, catalog, 0, vehicle);
  const result: any[] = [];
  for (const act of normalizedActions) {
    const compiled = compileAction(act, catalog, vehicle);
    if (Array.isArray(compiled)) {
      result.push(...compiled);
    } else if (compiled) {
      result.push(compiled);
    }
  }
  return deduplicateActionSequence(result);
}

function payloadsEqual(a: any, b: any): boolean {
  const mapA = compileToByteMap(a);
  const mapB = compileToByteMap(b);
  const keysA = Object.keys(mapA);
  const keysB = Object.keys(mapB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (asString(mapA[k]).toLowerCase() !== asString(mapB[k]).toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * Decompiles a condition from automations.json back into a UI AutomationCondition,
 * coalescing multi-option OR groups when applicable.
 */
export function decompileCondition(
  rawCond: any,
  catalog: Catalog = DEFAULT_CATALOG,
  depth = 0,
  vehicle: Vehicle | null = null
): AutomationCondition {
  if (!isPlainObject(rawCond)) return rawCond;
  if (depth > MAX_DECOMPILE_DEPTH) {
    return { id: rawCond.id ? asString(rawCond.id) : generateBlockId('cond') };
  }

  const groupLogic: 'and' | 'or' | 'not' | undefined =
    normalizeConditionGroupLogic(rawCond.logic) ||
    normalizeConditionGroupLogic(rawCond.type) ||
    (Array.isArray(rawCond.and) ? 'and' : undefined) ||
    (Array.isArray(rawCond.or) ? 'or' : undefined) ||
    (rawCond.not !== undefined && rawCond.not !== null ? 'not' : undefined);

  if (groupLogic) {
    let rawChildren: any[] = [];
    if (Array.isArray(rawCond.conditions) && rawCond.conditions.length > 0) {
      rawChildren = rawCond.conditions;
    } else if (groupLogic === 'and' && Array.isArray(rawCond.and)) {
      rawChildren = rawCond.and;
    } else if (groupLogic === 'or' && Array.isArray(rawCond.or)) {
      rawChildren = rawCond.or;
    } else if (groupLogic === 'not' && rawCond.not !== undefined && rawCond.not !== null) {
      rawChildren = Array.isArray(rawCond.not) ? rawCond.not : [rawCond.not];
    } else if (Array.isArray(rawCond.conditions)) {
      rawChildren = rawCond.conditions;
    }

    const subConds = rawChildren
      .filter(isPlainObject)
      .map((c: any) => decompileCondition(c, catalog, depth + 1, vehicle));

    // Check if this is an OR group representing a multi-option state selection on a single entity
    if (groupLogic === 'or' && Array.isArray(rawCond.or) && subConds.length > 1 && !rawCond.logic) {
      const explicitCmdId = rawCond.source_command_id || subConds[0]?.source_command_id;
      const allSameSimpleCanLeaf =
        Boolean(explicitCmdId) &&
        subConds.every((sc: AutomationCondition) => {
          const isLeaf = !sc.logic || sc.logic === 'leaf';
          const isCanState = !sc.type || sc.type === 'can_state';
          const isEqualOp = (!sc.operator || sc.operator === 'equal') && !sc.invert;
          return (
            isLeaf &&
            isCanState &&
            isEqualOp &&
            Boolean(sc.source_command_id) &&
            sc.source_command_id === explicitCmdId
          );
        });

      if (allSameSimpleCanLeaf) {
        const rawCmd = (catalog?.commands || []).find(c => c.id === explicitCmdId);
        const cmd = rawCmd ? resolveVariant(rawCmd, vehicle) : undefined;
        const selectedOpts: string[] =
          Array.isArray(rawCond.selected_options) && rawCond.selected_options.length > 0
            ? rawCond.selected_options.map((s: unknown) => asString(s)).filter(Boolean)
            : subConds
                .map((sc: AutomationCondition) => {
                  if (sc.option_label) return asString(sc.option_label);
                  if (cmd) {
                    const resolved = resolveCatalogCommandForCondition(sc, catalog, vehicle);
                    return resolved.matchedOption?.label;
                  }
                  return undefined;
                })
                .filter((lbl: string | undefined): lbl is string => !!lbl);

        if (selectedOpts.length === subConds.length && selectedOpts.length > 1 && cmd && cmd.options) {
          const matchedOpts = cmd.options.filter(o =>
            selectedOpts.some(sel => asString(sel).toLowerCase() === asString(o.label).toLowerCase())
          );
          if (matchedOpts.length === selectedOpts.length) {
            const baseCond: AutomationCondition = {
              id: rawCond.id || subConds[0]?.id || generateBlockId('cond'),
              type: 'can_state',
              source_command_id: cmd.id,
              source_command_name: rawCond.source_command_name || cmd.ha_metadata?.name || cmd.name || cmd.id,
              ...pickSustainedFields(rawCond)
            };
            return applyOptionsToCondition(baseCond, cmd, matchedOpts, vehicle);
          }
        }
      }
    }

    const {
      and: _and,
      or: _or,
      not: _not,
      type: _type,
      conditions: _conds,
      for_s: _forS,
      for_sec: _forSec,
      for_ms: _forMs,
      ...rest
    } = rawCond;

    return {
      ...rest,
      id: rawCond.id || generateBlockId('cond'),
      logic: groupLogic,
      conditions: subConds,
      ...pickSustainedFields(rawCond)
    };
  }

  const { for_s: _leafForS, for_sec: _leafForSec, for_ms: _leafForMs, ...restLeaf } = rawCond;
  const clone: AutomationCondition = {
    ...restLeaf,
    ...pickSustainedFields(rawCond),
    id: rawCond.id || generateBlockId('cond')
  };

  if (clone.can_id !== undefined && clone.can_id !== null) {
    clone.can_id = formatCanId(clone.can_id);
  }
  if (clone.target_rssi !== undefined) {
    const clamped = clampRssi(clone.target_rssi);
    if (clamped !== undefined) {
      clone.target_rssi = clamped;
    } else {
      delete clone.target_rssi;
    }
  }
  if (clone.type === 'time_condition' || clone.type === 'time') {
    clone.type = 'time_condition';
    clone.days = expandScheduleDays(clone.days);
  }
  if (clone.type === 'ble_button' || clone.type === 'ble_key' || clone.type === 'ble') {
    const normalizedBle = normalizeBleButtonAction(clone.ble_action);
    if (normalizedBle.ble_action !== undefined) {
      clone.ble_action = normalizedBle.ble_action;
    }
  }
  if (clone.type === 'ble_beacon' || clone.type === 'beacon') {
    clone.type = 'ble_presence';
    if (!clone.device_property) {
      clone.device_property = clone.target_bool === false ? 'away' : 'present';
    }
  } else if (clone.type === 'ble_device') {
    clone.type = 'ble_presence';
  }
  if (!clone.type && clone.can_id) {
    clone.type = 'can_state';
  }

  return clone;
}

/**
 * Helper to check and consume trailing flattened steps in rawActions starting at `startIndex`
 * that match `expectedSteps.slice(1)`.
 */
function matchAndConsumeRemainingCatalogSteps(
  rawActions: any[],
  startIndex: number,
  catalogCmd: Command,
  expectedSteps: any[],
  defaultCanId: string,
  defaultBus: number,
  defaultDelayMs: number,
  catalog: Catalog = DEFAULT_CATALOG,
  depth = 0,
  vehicle: Vehicle | null = null
): { matched: boolean; nextIndex: number; extractedSteps?: AutomationActionStep[] } {
  let cursor = startIndex;
  const extractedSteps: AutomationActionStep[] = [];

  for (let sIdx = 1; sIdx < expectedSteps.length; sIdx++) {
    const expStep = expectedSteps[sIdx];
    if (!isPlainObject(expStep)) continue;

    if (expStep.type === 'delay') {
      const cand = rawActions[cursor];
      if (!isPlainObject(cand) || cand.type !== 'delay') {
        return { matched: false, nextIndex: startIndex };
      }
      extractedSteps.push({
        type: 'delay',
        delay_ms: clampInt(cand.ms ?? cand.delay_ms ?? expStep.delay_ms ?? expStep.ms, 0, MAX_DELAY_MS, 500)
      });
      cursor++;
      continue;
    }

    if (expStep.type === 'repeat_until' || expStep.type === 'wait_for') {
      if (isPlainObject(rawActions[cursor]) && rawActions[cursor].type === 'delay' && !rawActions[cursor].source_command_id) {
        cursor++;
      }
      const cand = rawActions[cursor];
      if (!isPlainObject(cand) || cand.type !== expStep.type) {
        return { matched: false, nextIndex: startIndex };
      }
      const rawConds = Array.isArray(cand.conditions) && cand.conditions.length > 0
        ? cand.conditions
        : (cand.condition ? [cand.condition] : []);
      const decompiledConds = rawConds
        .filter(isPlainObject)
        .map((c: any) => decompileCondition(c, catalog, depth + 1, vehicle));
      extractedSteps.push({
        ...cand,
        ...(decompiledConds[0] ? { condition: decompiledConds[0] } : {}),
        ...(decompiledConds.length > 0 ? { conditions: decompiledConds } : {}),
        sequence: Array.isArray(cand.sequence) ? decompileActionList(cand.sequence, catalog, depth + 1, vehicle) : undefined
      } as AutomationActionStep);
      cursor++;
      continue;
    }

    // Optional inter-step delay before this transmit step
    let interDelayMs = clampInt(expStep.delay_ms ?? defaultDelayMs, 0, MAX_DELAY_MS, 0);
    if (isPlainObject(rawActions[cursor]) && rawActions[cursor].type === 'delay' && !rawActions[cursor].source_command_id) {
      interDelayMs = clampInt(rawActions[cursor].ms ?? rawActions[cursor].delay_ms ?? interDelayMs, 0, MAX_DELAY_MS, interDelayMs);
      cursor++;
    }

    const cand = rawActions[cursor];
    if (!isPlainObject(cand) || !isTransmitActionType(cand.type)) {
      return { matched: false, nextIndex: startIndex };
    }
    // Must not belong to a different explicit catalog command
    if (cand.source_command_id && cand.source_command_id !== catalogCmd.id) {
      return { matched: false, nextIndex: startIndex };
    }

    const expCanId = formatCanId(expStep.can_id || expStep.action_can_id || defaultCanId);
    const candCanId = formatCanId(cand.can_id || defaultCanId);
    if (expCanId !== candCanId) {
      return { matched: false, nextIndex: startIndex };
    }

    if (!payloadsEqual(cand.payload, expStep.payload)) {
      return { matched: false, nextIndex: startIndex };
    }

    // Record the inter-step delay onto the previous step if applicable
    if (extractedSteps.length > 0 && extractedSteps[extractedSteps.length - 1].delay_ms === undefined) {
      extractedSteps[extractedSteps.length - 1].delay_ms = interDelayMs;
    }

    extractedSteps.push({
      can_id: candCanId,
      bus: cand.bus ?? expStep.bus ?? defaultBus,
      payload: compileToByteMap(cand.payload),
      repeat: clampInt(cand.repeat ?? expStep.repeat, 1, MAX_STEP_REPEAT, 1),
      delay_ms: clampInt(
        cand.delay_ms ?? expStep.delay_ms ?? (sIdx < expectedSteps.length - 1 ? defaultDelayMs : 0),
        0,
        MAX_DELAY_MS,
        0
      )
    });
    cursor++;
  }

  return { matched: true, nextIndex: cursor, extractedSteps };
}

/**
 * Reconstructs unified UI AutomationAction[] from a flattened automations.json action array.
 * Handles both explicit `_step_group_id` tags and heuristic catalog multi-step matching
 * (including cleanup of duplicate orphaned release/latch steps from prior push/pull cycles).
 */
export function decompileActionList(
  rawActions: any[],
  catalog: Catalog = DEFAULT_CATALOG,
  depth = 0,
  vehicle: Vehicle | null = null
): AutomationAction[] {
  if (!Array.isArray(rawActions) || rawActions.length === 0 || depth > MAX_DECOMPILE_DEPTH) return [];

  const result: AutomationAction[] = [];
  let i = 0;

  while (i < rawActions.length) {
    const raw = rawActions[i];
    if (!isPlainObject(raw)) {
      i++;
      continue;
    }

    // 1. Control-flow actions: cycle_entity (native Option B + legacy _cycle_entity restoration), choose, if_then, repeat_until, wait_for
    if (raw.type === 'cycle_entity') {
      const entId = raw.entity_id || raw.target_command_id || 'drivers_seat_comfort';
      const cmd = catalog.commands?.find(c => c.id === entId || c.entity_id === entId);
      const fallbackStates = cmd?.options && cmd.options.length > 0
        ? cmd.options.map(o => o.label)
        : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
      result.push({
        id: raw.id || generateBlockId('act'),
        type: 'cycle_entity',
        entity_id: entId,
        ...(raw.target_command_id ? { target_command_id: raw.target_command_id } : {}),
        states: Array.isArray(raw.states) && raw.states.length > 0 ? raw.states : fallbackStates,
        direction: raw.direction || 'forward',
        wrap: raw.wrap !== false,
        fallback_state: raw.fallback_state || '__first__',
        show_popup: raw.show_popup !== false,
        ...(raw.popup_prefix !== undefined ? { popup_prefix: raw.popup_prefix } : {}),
        level: raw.level || 'info'
      });
      i++;
      continue;
    }

    if (raw.type === 'choose') {
      if (isPlainObject(raw._cycle_entity)) {
        const ce = raw._cycle_entity;
        result.push({
          id: ce.id || raw.id || generateBlockId('act'),
          type: 'cycle_entity',
          entity_id: ce.entity_id || 'drivers_seat_comfort',
          ...(ce.target_command_id ? { target_command_id: ce.target_command_id } : {}),
          states: Array.isArray(ce.states) ? ce.states : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'],
          ...(ce.direction ? { direction: ce.direction } : {}),
          wrap: ce.wrap !== false,
          ...(ce.fallback_state ? { fallback_state: ce.fallback_state } : {}),
          show_popup: ce.show_popup !== false,
          ...(ce.popup_prefix !== undefined ? { popup_prefix: ce.popup_prefix } : {}),
          ...(ce.level ? { level: ce.level } : {})
        });
        i++;
        continue;
      }

      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'choose',
        choices: Array.isArray(raw.choices)
          ? raw.choices.filter(isPlainObject).map((ch: any) => ({
              ...ch,
              _clientId: ch._clientId || generateBlockId('branch'),
              conditions: Array.isArray(ch.conditions)
                ? ch.conditions.filter(isPlainObject).map((c: any) => decompileCondition(c, catalog, depth + 1, vehicle))
                : [],
              sequence: Array.isArray(ch.sequence)
                ? decompileActionList(ch.sequence, catalog, depth + 1, vehicle)
                : []
            }))
          : [],
        default: Array.isArray(raw.default) ? decompileActionList(raw.default, catalog, depth + 1, vehicle) : []
      });
      i++;
      continue;
    }

    if (raw.type === 'if_then') {
      const rawConds = Array.isArray(raw.conditions) ? raw.conditions : Array.isArray(raw.if) ? raw.if : [];
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'if_then',
        conditions: rawConds.filter(isPlainObject).map((c: any) => decompileCondition(c, catalog, depth + 1, vehicle)),
        then: Array.isArray(raw.then) ? decompileActionList(raw.then, catalog, depth + 1, vehicle) : [],
        else: Array.isArray(raw.else) ? decompileActionList(raw.else, catalog, depth + 1, vehicle) : []
      });
      i++;
      continue;
    }

    if (raw.type === 'repeat_until' || raw.type === 'wait_for') {
      const rawConds = Array.isArray(raw.conditions) && raw.conditions.length > 0
        ? raw.conditions
        : (raw.condition ? [raw.condition] : []);
      const decompiledConds = rawConds
        .filter(isPlainObject)
        .map((c: any) => decompileCondition(c, catalog, depth + 1, vehicle));
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: raw.type,
        ...(raw.interval_ms !== undefined
          ? { interval_ms: clampInt(raw.interval_ms, 0, MAX_DELAY_MS, raw.type === 'wait_for' ? 50 : 1000) }
          : {}),
        ...(raw.timeout_ms !== undefined
          ? { timeout_ms: clampInt(raw.timeout_ms, 0, MAX_DELAY_MS, raw.type === 'wait_for' ? 10000 : 30000) }
          : {}),
        condition: decompiledConds[0],
        ...(decompiledConds.length > 0 ? { conditions: decompiledConds } : {}),
        sequence: Array.isArray(raw.sequence) ? decompileActionList(raw.sequence, catalog, depth + 1, vehicle) : undefined
      });
      i++;
      continue;
    }

    // 2. Pass 1: Explicit `_step_group_id` coalescing
    if (raw._step_group_id) {
      const groupId = raw._step_group_id;
      const groupItems: any[] = [];
      while (i < rawActions.length && isPlainObject(rawActions[i]) && rawActions[i]._step_group_id === groupId) {
        groupItems.push(rawActions[i]);
        i++;
      }

      if (groupItems.length > 0) {
        const firstTx = groupItems.find(x => isTransmitActionType(x.type)) || groupItems[0];
        const steps: AutomationActionStep[] = [];

        for (let gIdx = 0; gIdx < groupItems.length; gIdx++) {
          const item = groupItems[gIdx];
          if (isTransmitActionType(item.type)) {
            const explicitTxDelay = item.delay_ms !== undefined && item.delay_ms > 0
              ? clampInt(item.delay_ms, 0, MAX_DELAY_MS, 0)
              : undefined;
            let stepDelayMs = explicitTxDelay ?? 0;
            if (gIdx + 1 < groupItems.length && groupItems[gIdx + 1].type === 'delay') {
              const nextDelayMs = clampInt(groupItems[gIdx + 1].ms ?? groupItems[gIdx + 1].delay_ms, 0, MAX_DELAY_MS, 20);
              if (explicitTxDelay === undefined || explicitTxDelay === nextDelayMs) {
                stepDelayMs = nextDelayMs;
                gIdx++; // consume matching inter-step delay
              }
            }
            steps.push({
              can_id: formatCanId(item.can_id || firstTx.can_id || '0x000'),
              bus: item.bus ?? firstTx.bus ?? 0,
              payload: compileToByteMap(item.payload),
              repeat: clampInt(item.repeat, 1, MAX_STEP_REPEAT, 1),
              delay_ms: stepDelayMs
            });
          } else if (item.type === 'delay') {
            steps.push({
              type: 'delay',
              delay_ms: clampInt(item.ms ?? item.delay_ms, 0, MAX_DELAY_MS, 500)
            });
          } else if (item.type === 'repeat_until' || item.type === 'wait_for') {
            const { _step_group_id: _sg, ...restItem } = item;
            const rawConds = Array.isArray(item.conditions) && item.conditions.length > 0
              ? item.conditions
              : (item.condition ? [item.condition] : []);
            const decompiledConds = rawConds
              .filter(isPlainObject)
              .map((c: any) => decompileCondition(c, catalog, depth + 1, vehicle));
            steps.push({
              ...restItem,
              ...(item.interval_ms !== undefined
                ? { interval_ms: clampInt(item.interval_ms, 0, MAX_DELAY_MS, item.type === 'wait_for' ? 50 : 1000) }
                : {}),
              ...(item.timeout_ms !== undefined
                ? { timeout_ms: clampInt(item.timeout_ms, 0, MAX_DELAY_MS, item.type === 'wait_for' ? 10000 : 30000) }
                : {}),
              ...(decompiledConds[0] ? { condition: decompiledConds[0] } : {}),
              ...(decompiledConds.length > 0 ? { conditions: decompiledConds } : {}),
              ...(Array.isArray(item.sequence)
                ? { sequence: decompileActionList(item.sequence, catalog, depth + 1, vehicle) }
                : {})
            } as AutomationActionStep);
          } else {
            const { _step_group_id: _sg, ...restItem } = item;
            steps.push(restItem);
          }
        }

        const candidateAction: AutomationAction = {
          id: firstTx.id || groupId,
          type: 'can_tx',
          can_id: formatCanId(firstTx.can_id || '0x000'),
          bus: firstTx.bus ?? 0,
          payload: steps[0]?.payload || compileToByteMap(firstTx.payload),
          repeat: clampInt(steps[0]?.repeat ?? firstTx.repeat, 1, MAX_STEP_REPEAT, 1),
          delay_ms: clampInt(steps[0]?.delay_ms ?? firstTx.delay_ms, 0, MAX_DELAY_MS, 20),
          ...(steps.length > 1 ? { steps } : {}),
          ...(firstTx.source_command_id ? { source_command_id: firstTx.source_command_id } : {}),
          ...(firstTx.source_command_name ? { source_command_name: firstTx.source_command_name } : {}),
          ...(firstTx.option_label ? { option_label: firstTx.option_label } : {}),
          ...(firstTx.entity_id ? { entity_id: firstTx.entity_id } : {}),
          ...(firstTx.command || firstTx.option_label ? { command: firstTx.command || firstTx.option_label } : {})
        };

        const resolved = resolveCatalogCommandForAction(candidateAction, catalog, vehicle);
        if (resolved.command) {
          candidateAction.source_command_id = candidateAction.source_command_id || resolved.command.id;
          candidateAction.entity_id = candidateAction.entity_id || resolved.command.id;
          candidateAction.source_command_name =
            candidateAction.source_command_name ||
            resolved.command.ha_metadata?.name ||
            resolved.command.name ||
            resolved.command.id;
          if (resolved.matchedOption) {
            candidateAction.option_label = candidateAction.option_label || resolved.matchedOption.label;
            candidateAction.command = candidateAction.command || resolved.matchedOption.label;
          }
        }

        result.push(candidateAction);
      }
      continue;
    }

    // 2.5 Preserve non-static / rule-targeting / dynamic effect entity_command actions, and normalize precondition commands
    if (raw.type === 'entity_command') {
      const entityAct: AutomationAction = {
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'entity_command',
      };
      const { command: effCmd, matchedOption: effOpt } = resolveCatalogCommandForAction(entityAct, catalog, vehicle);
      const matchedEff = findMatchingEffectForAction(effCmd, entityAct);
      if (effCmd && matchedEff) {
        const defaultCanId = formatCanId(
          effCmd.network?.action_can_id || effCmd.action_can_id || effCmd.network?.state_can_id || effCmd.state_can_id || '0x000'
        );
        const defaultBus = resolveActionBus(effCmd, raw.bus);
        const cmdDisplayName = effCmd.ha_metadata?.name || effCmd.name || effCmd.id;
        result.push({
          ...entityAct,
          type: 'entity_command',
          entity_id: effCmd.id,
          source_command_id: effCmd.id,
          source_command_name: cmdDisplayName,
          command: matchedEff.label,
          option_label: matchedEff.label,
          can_id: defaultCanId,
          bus: defaultBus,
        });
        i++;
        continue;
      }

      if (effCmd && (effCmd.type === 'precondition' || effCmd.id === 'battery_preconditioning')) {
        const preconOpt = findMatchingOptionForAction(effCmd, entityAct, false);
        const { mode, action } = resolvePreconditionModeAndAction(entityAct, preconOpt, effCmd);
        const cmdDisplayName = effCmd.ha_metadata?.name || effCmd.name || effCmd.id;
        result.push({
          ...entityAct,
          type: 'precondition',
          precon_mode: mode,
          precon_action: action,
          entity_id: effCmd.id,
          source_command_id: effCmd.id,
          source_command_name: cmdDisplayName,
          ...(preconOpt?.label || entityAct.option_label || entityAct.command
            ? {
                option_label: preconOpt?.label || entityAct.option_label || entityAct.command,
                command: preconOpt?.label || entityAct.command || entityAct.option_label,
              }
            : {}),
        });
        i++;
        continue;
      }

      const resolvesToStaticCan = Boolean(
        effCmd &&
        (
          (effOpt?.steps && effOpt.steps.length > 0) ||
          effOpt?.payload ||
          (effCmd.steps && effCmd.steps.length > 0) ||
          effCmd.payload ||
          isRangeCommand(effCmd)
        )
      );
      if (!resolvesToStaticCan) {
        result.push({
          ...entityAct,
          type: 'entity_command',
          entity_id: entityAct.entity_id || entityAct.source_command_id || '',
          command: entityAct.command || entityAct.option_label || '',
        });
        i++;
        continue;
      }
    }

    // 3. Pass 2: Heuristic catalog multi-step coalescing for untagged/legacy automations.json rules
    if (isTransmitActionType(raw.type) || raw.type === 'entity_command') {
      const normalizedRaw: AutomationAction = {
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'can_tx',
        ...(raw.can_id !== undefined && raw.can_id !== null ? { can_id: formatCanId(raw.can_id) } : {}),
        ...(raw.payload ? { payload: compileToByteMap(raw.payload) } : {}),
        ...(raw.repeat !== undefined ? { repeat: clampInt(raw.repeat, 1, MAX_STEP_REPEAT, 1) } : {}),
        ...(raw.delay_ms !== undefined ? { delay_ms: clampInt(raw.delay_ms, 0, MAX_DELAY_MS, 0) } : {})
      };

      const { command: catalogCmd, matchedOption } = resolveCatalogCommandForAction(normalizedRaw, catalog, vehicle);
      const expectedSteps =
        matchedOption?.steps && matchedOption.steps.length > 1
          ? matchedOption.steps
          : !matchedOption?.payload && catalogCmd?.steps && catalogCmd.steps.length > 1
            ? catalogCmd.steps
            : undefined;

      if (catalogCmd && expectedSteps && expectedSteps.length > 1) {
        const defaultCanId = formatCanId(
          catalogCmd.network?.action_can_id ||
            catalogCmd.action_can_id ||
            catalogCmd.network?.state_can_id ||
            catalogCmd.state_can_id ||
            normalizedRaw.can_id ||
            '0x000'
        );
        const defaultBus = resolveActionBus(catalogCmd, normalizedRaw.bus);
        const defaultDelayMs = clampInt(
          catalogCmd.network?.delay_ms ?? catalogCmd.delay_ms ?? normalizedRaw.delay_ms,
          0,
          MAX_DELAY_MS,
          20
        );

        // Consume one or more consecutive occurrences of the remaining flattened steps (healing prior duplicate push/pull cycles)
        let nextCursor = i + 1;
        let firstDelayMs = clampInt(
          normalizedRaw.delay_ms ?? expectedSteps[0]?.delay_ms ?? defaultDelayMs,
          0,
          MAX_DELAY_MS,
          defaultDelayMs
        );
        if (
          normalizedRaw.delay_ms === undefined &&
          isPlainObject(rawActions[nextCursor]) &&
          rawActions[nextCursor].type === 'delay' &&
          !rawActions[nextCursor].source_command_id
        ) {
          firstDelayMs = clampInt(rawActions[nextCursor].ms ?? rawActions[nextCursor].delay_ms, 0, MAX_DELAY_MS, firstDelayMs);
        }

        let matchedTailSteps: AutomationActionStep[] | undefined;
        while (nextCursor < rawActions.length) {
          const matchResult = matchAndConsumeRemainingCatalogSteps(
            rawActions,
            nextCursor,
            catalogCmd,
            expectedSteps,
            defaultCanId,
            defaultBus,
            defaultDelayMs,
            catalog,
            depth,
            vehicle
          );
          if (matchResult.matched) {
            if (!matchedTailSteps) {
              matchedTailSteps = matchResult.extractedSteps;
            }
            nextCursor = matchResult.nextIndex;
          } else {
            break;
          }
        }

        const validExplicitSteps = Array.isArray(normalizedRaw.steps)
          ? normalizedRaw.steps.filter(isPlainObject)
          : [];
        const hasExplicitMultiSteps = validExplicitSteps.length > 1;

        // Only replace with multi-step catalog sequence when trailing steps actually matched,
        // explicit multi-steps were already provided, or raw.type === 'entity_command'.
        // Customized single-frame can_tx actions must not be silently overwritten with expectedSteps.
        if (hasExplicitMultiSteps || Boolean(matchedTailSteps) || raw.type === 'entity_command') {
          const unifiedSteps: AutomationActionStep[] = hasExplicitMultiSteps
            ? validExplicitSteps.map((s: any) => ({
                ...s,
                ...(s.can_id ? { can_id: formatCanId(s.can_id) } : { can_id: defaultCanId }),
                bus: s.bus ?? defaultBus,
                ...(s.payload ? { payload: compileToByteMap(s.payload) } : {}),
                ...(s.repeat !== undefined ? { repeat: clampInt(s.repeat, 1, MAX_STEP_REPEAT, 1) } : {}),
                ...(s.delay_ms !== undefined ? { delay_ms: clampInt(s.delay_ms, 0, MAX_DELAY_MS, 0) } : {})
              }))
            : expectedSteps.filter(isPlainObject).map((s: any, idx: number) => {
                if (s.type === 'delay') {
                  return {
                    type: 'delay',
                    delay_ms: clampInt(s.delay_ms ?? s.dwell_ms ?? s.ms, 0, MAX_DELAY_MS, 500)
                  };
                }
                const tailOverride = idx >= 1 && matchedTailSteps ? matchedTailSteps[idx - 1] : undefined;
                if (s.type === 'repeat_until' || s.type === 'wait_for') {
                  if (tailOverride) return tailOverride;
                  return {
                    ...s,
                    ...(s.condition ? { condition: decompileCondition(s.condition, catalog, depth + 1, vehicle) } : {}),
                    ...(Array.isArray(s.sequence) ? { sequence: decompileActionList(s.sequence, catalog, depth + 1, vehicle) } : {})
                  };
                }
                return {
                  can_id: formatCanId(s.can_id || s.action_can_id || defaultCanId),
                  bus: tailOverride?.bus ?? s.bus ?? normalizedRaw.bus ?? defaultBus,
                  payload: compileToByteMap(s.payload),
                  repeat: clampInt(
                    idx === 0 ? (normalizedRaw.repeat ?? s.repeat) : (tailOverride?.repeat ?? s.repeat),
                    1,
                    MAX_STEP_REPEAT,
                    1
                  ),
                  delay_ms: clampInt(
                    idx === 0
                      ? firstDelayMs
                      : tailOverride?.delay_ms ?? s.delay_ms ?? (idx < expectedSteps.length - 1 ? defaultDelayMs : 0),
                    0,
                    MAX_DELAY_MS,
                    0
                  )
                };
              });

          const { _step_group_id: _sg, ...cleanRaw } = normalizedRaw as any;
          result.push({
            ...cleanRaw,
            id: cleanRaw.id || generateBlockId('act'),
            type: 'can_tx',
            can_id: defaultCanId,
            bus: cleanRaw.bus ?? defaultBus,
            payload: unifiedSteps[0]?.payload || cleanRaw.payload || compileToByteMap(expectedSteps[0]?.payload),
            repeat: clampInt(unifiedSteps[0]?.repeat ?? cleanRaw.repeat ?? expectedSteps[0]?.repeat, 1, MAX_STEP_REPEAT, 1),
            delay_ms: firstDelayMs,
            steps: unifiedSteps,
            source_command_id: catalogCmd.id,
            source_command_name:
              cleanRaw.source_command_name || catalogCmd.ha_metadata?.name || catalogCmd.name || catalogCmd.id,
            entity_id: catalogCmd.id,
            option_label: matchedOption?.label || cleanRaw.option_label || cleanRaw.command,
            command: matchedOption?.label || cleanRaw.command || cleanRaw.option_label
          });

          i = nextCursor;
          continue;
        }
      }

      // Single-step catalog or raw CAN transmit action
      const { _step_group_id: _sg, ...cleanSingle } = normalizedRaw as any;
      if (catalogCmd) {
        cleanSingle.source_command_id = cleanSingle.source_command_id || catalogCmd.id;
        cleanSingle.entity_id = cleanSingle.entity_id || catalogCmd.id;
        cleanSingle.source_command_name =
          cleanSingle.source_command_name || catalogCmd.ha_metadata?.name || catalogCmd.name || catalogCmd.id;
        if (matchedOption) {
          cleanSingle.option_label = cleanSingle.option_label || matchedOption.label;
          cleanSingle.command = cleanSingle.command || matchedOption.label;
        }
        if (raw.type === 'entity_command') {
          cleanSingle.can_id = cleanSingle.can_id || formatCanId(
            catalogCmd.network?.action_can_id || catalogCmd.action_can_id || catalogCmd.network?.state_can_id || catalogCmd.state_can_id || '0x000'
          );
          cleanSingle.bus = cleanSingle.bus ?? resolveActionBus(catalogCmd);
          if (!cleanSingle.payload || Object.keys(cleanSingle.payload).length === 0) {
            if (matchedOption?.payload) {
              cleanSingle.payload = compileToByteMap(matchedOption.payload);
            } else if (matchedOption?.steps?.length === 1) {
              cleanSingle.payload = compileToByteMap(matchedOption.steps[0].payload);
            } else if (catalogCmd.payload) {
              cleanSingle.payload = compileToByteMap(catalogCmd.payload);
            } else if (catalogCmd.steps?.length === 1) {
              cleanSingle.payload = compileToByteMap(catalogCmd.steps[0].payload);
            } else if (isRangeCommand(catalogCmd)) {
              const cmdLabel = cleanSingle.command || cleanSingle.option_label;
              const parsedPhys = cmdLabel !== undefined ? parseFloat(String(cmdLabel)) : NaN;
              const targetPhys = !isNaN(parsedPhys) ? parsedPhys : getDefaultPhysicalValue(catalogCmd.network);
              const rawByte = physicalToRawByte(targetPhys, catalogCmd.network);
              const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
              cleanSingle.payload = buildRangeActionPayload(hexVal, catalogCmd.network);
            }
          }
          cleanSingle.repeat = clampInt(cleanSingle.repeat ?? matchedOption?.repeat ?? catalogCmd.repeat, 1, MAX_STEP_REPEAT, 1);
        }
      }
      result.push(cleanSingle);
      i++;
      continue;
    }

    // 4. Other action types (delay, track_popup, climate_target, precondition, hud_nav, webhook, etc.)
    if (raw.type === 'delay') {
      const clampedDelay = clampInt(raw.delay_ms ?? raw.ms, 0, MAX_DELAY_MS, 500);
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'delay',
        delay_ms: clampedDelay,
        ms: clampedDelay
      });
      i++;
      continue;
    }

    if (raw.type === 'track_popup' || raw.type === 'popup') {
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'track_popup',
        level: raw.level || 'info',
        text: asString(raw.text ?? raw.message ?? raw.popup_message ?? raw.popup_text ?? '')
      });
      i++;
      continue;
    }

    if (raw.type === 'climate_target' || raw.type === 'remote_climate' || raw.type === 'climate') {
      const rawTempC = raw.target_temp_c ?? raw.target_c ?? raw.target_temp ?? raw.temp;
      const rawTempF = raw.target_temp_f ?? raw.target_f ?? raw.temp_f;
      let tempC = 22.0;
      if (rawTempC !== undefined && rawTempC !== null && rawTempC !== '' && Number.isFinite(Number(rawTempC))) {
        tempC = Number(rawTempC);
      } else if (rawTempF !== undefined && rawTempF !== null && rawTempF !== '' && Number.isFinite(Number(rawTempF))) {
        tempC = ((Number(rawTempF) - 32) * 5) / 9;
      }
      const durationMinutes = clampInt(raw.duration_minutes ?? raw.duration_min ?? raw.duration, 0, 1440, 10);
      const zone = raw.zone || raw.climate_zone || 'driver';
      const rawSyncOn = raw.sync_on !== undefined ? raw.sync_on : raw.climate_sync_on;
      const rawDriverOnly = raw.driver_only !== undefined ? raw.driver_only : raw.climate_driver_only;
      const rawMonitor0x38 = raw.monitor_0x38 !== undefined ? raw.monitor_0x38 : raw.smart;
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'climate_target',
        target_temp_c: tempC,
        defrost: !!raw.defrost,
        duration_minutes: durationMinutes,
        zone,
        ...(rawSyncOn !== undefined ? { sync_on: !!rawSyncOn } : {}),
        ...(rawDriverOnly !== undefined ? { driver_only: !!rawDriverOnly } : {}),
        ...(rawMonitor0x38 !== undefined ? { monitor_0x38: !!rawMonitor0x38 } : {})
      });
      i++;
      continue;
    }

    if (raw.type === 'precondition' || raw.type === 'battery_preconditioning') {
      const preconCmd = catalog?.commands?.find(c => c.id === 'battery_preconditioning' || c.type === 'precondition');
      const matchedOpt = preconCmd ? findMatchingOptionForAction(preconCmd, raw as AutomationAction, false) : undefined;
      const { mode, action } = resolvePreconditionModeAndAction(raw, matchedOpt, preconCmd);
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'precondition',
        precon_mode: mode,
        precon_action: action
      });
      i++;
      continue;
    }

    if (raw.type === 'hud_nav' || raw.type === 'nav') {
      const navAction = raw.nav_action || raw.action || 'update';
      const {
        source_command_id: _sci,
        source_command_name: _scn,
        entity_id: _eid,
        target_command_id: _tci,
        command: _cmd,
        option_label: _ol,
        can_id: _cid,
        payload: _pay,
        steps: _steps,
        ...cleanNavRaw
      } = raw as any;

      if (navAction === 'clear') {
        result.push({
          ...cleanNavRaw,
          id: raw.id || generateBlockId('act'),
          type: 'hud_nav',
          nav_action: 'clear',
          action: 'clear'
        });
        i++;
        continue;
      }

      const rawLaneDirs = Array.isArray(raw.lane_directions) ? raw.lane_directions : [];
      const rawLaneRecs = Array.isArray(raw.lane_recommended)
        ? raw.lane_recommended
        : Array.isArray(raw.lane_highlights)
          ? raw.lane_highlights
          : [];
      const inferredLaneCount = Math.max(rawLaneDirs.length, rawLaneRecs.length);
      const numLanes = clampInt(raw.num_lanes ?? raw.lanes ?? inferredLaneCount, 0, 8, 0);
      const laneDirections = Array.from({ length: numLanes }, (_, idx) => {
        const v = Number(rawLaneDirs[idx]);
        return Number.isFinite(v) ? Math.trunc(v) : 1;
      });
      const laneRecommended = Array.from({ length: numLanes }, (_, idx) => (rawLaneRecs[idx] ? 1 : 0));

      const distanceMeters = raw.distance_meters ?? raw.distance;
      const directionDeg =
        raw.direction_deg ?? raw.heading ?? (typeof raw.direction === 'number' ? raw.direction : undefined);

      result.push({
        ...cleanNavRaw,
        id: raw.id || generateBlockId('act'),
        type: 'hud_nav',
        nav_action: navAction,
        action: navAction,
        ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
        ...(directionDeg !== undefined ? { direction_deg: directionDeg } : {}),
        ...(distanceMeters !== undefined ? { distance_meters: distanceMeters } : {}),
        ...(raw.bars !== undefined ? { bars: raw.bars } : {}),
        ...(raw.speed_limit !== undefined ? { speed_limit: raw.speed_limit } : {}),
        ...(raw.camera_alert !== undefined ? { camera_alert: !!raw.camera_alert } : {}),
        ...(raw.street !== undefined ? { street: asString(raw.street) } : {}),
        num_lanes: numLanes,
        lane_directions: laneDirections,
        lane_recommended: laneRecommended
      });
      i++;
      continue;
    }

    result.push({
      ...(raw as AutomationAction),
      id: raw.id || generateBlockId('act')
    });
    i++;
  }

  return result;
}

/**
 * Decompiles a single AutomationRule from automations.json or storage into a normalized UI AutomationRule
 * with multi-step commands coalesced into single AutomationAction items.
 */
export function decompileAutomationRule(
  rawRule: any,
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null
): AutomationRule {
  if (!isPlainObject(rawRule)) return rawRule;

  const triggers: AutomationTrigger[] = Array.isArray(rawRule.triggers)
    ? rawRule.triggers.filter(isPlainObject).map((trig: any) => {
        const { for_s: _forS, for_sec: _forSec, for_ms: _forMs, ...restTrig } = trig;
        const clone: AutomationTrigger = {
          ...restTrig,
          ...pickSustainedFields(trig),
          id: trig.id || generateBlockId('trig')
        };
        const normalizedBle = normalizeBleButtonAction(clone.ble_action, clone.click_count);
        if (normalizedBle.ble_action !== undefined) {
          clone.ble_action = normalizedBle.ble_action;
        }
        if (normalizedBle.click_count !== undefined) {
          clone.click_count = normalizedBle.click_count;
        }
        if ((clone.click_count ?? 1) > 1) {
          clone.for_sec = 0;
          clone.for_ms = 0;
        }
        if (clone.can_id !== undefined && clone.can_id !== null) {
          clone.can_id = formatCanId(clone.can_id);
        }
        if (clone.target_rssi !== undefined) {
          const clamped = clampRssi(clone.target_rssi);
          if (clamped !== undefined) {
            clone.target_rssi = clamped;
          } else {
            delete clone.target_rssi;
          }
        }
        if (clone.type === 'ble_beacon' || clone.type === 'beacon') {
          clone.type = 'ble_presence';
          clone.source = clone.source || 'ble';
          if (!clone.ble_event) {
            clone.ble_event = 'present';
          }
        } else if (clone.type === 'ble_device_event' || clone.type === 'ble_device') {
          clone.type = 'ble_presence';
          clone.source = clone.source || 'ble';
        } else if (clone.type === 'ble_button' || clone.type === 'ble_key') {
          clone.source = clone.source || 'ble';
        } else if (clone.type === 'wifi_event' || clone.type === 'wifi') {
          clone.source = clone.source || 'wifi';
        } else if (clone.type === 'time_schedule' || clone.type === 'time') {
          clone.type = 'time_schedule';
          clone.source = clone.source || 'time';
          clone.days = expandScheduleDays(clone.days);
        } else if (!clone.source) {
          clone.source = clone.source_command_id ? 'preset' : 'can';
        }
        return clone;
      })
    : [];

  const conditions: AutomationCondition[] = Array.isArray(rawRule.conditions)
    ? rawRule.conditions.filter(isPlainObject).map((c: any) => decompileCondition(c, catalog, 0, vehicle))
    : [];

  const actions: AutomationAction[] = Array.isArray(rawRule.actions)
    ? decompileActionList(rawRule.actions, catalog, 0, vehicle)
    : [];

  const offActions: AutomationAction[] | undefined = Array.isArray(rawRule.off_actions)
    ? decompileActionList(rawRule.off_actions, catalog, 0, vehicle)
    : undefined;

  const hasTriggerWindow =
    rawRule.trigger_window_ms !== undefined && rawRule.trigger_window_ms !== null
      ? true
      : rawRule.timeout_reset_ms !== undefined &&
          rawRule.timeout_reset_ms !== null &&
          Number(rawRule.timeout_reset_ms) > 0;
  const resolvedTriggerWindow = hasTriggerWindow
    ? clampInt(
        rawRule.trigger_window_ms !== undefined && rawRule.trigger_window_ms !== null
          ? rawRule.trigger_window_ms
          : rawRule.timeout_reset_ms,
        500,
        60000,
        5000
      )
    : undefined;

  return {
    ...rawRule,
    id: rawRule.id || generateBlockId('rule'),
    name: rawRule.name || 'Automation Rule',
    enabled: rawRule.enabled ?? true,
    ha_expose: rawRule.ha_expose ?? true,
    ...(rawRule.hold_beep ? { hold_beep: true } : {}),
    ha_icon: rawRule.ha_icon || 'mdi:car-cog',
    exec_mode: rawRule.exec_mode || 'one_shot',
    trigger_mode: rawRule.trigger_mode || 'any',
    ...(resolvedTriggerWindow !== undefined ? { trigger_window_ms: resolvedTriggerWindow } : {}),
    cooldown_ms: clampInt(rawRule.cooldown_ms, 0, MAX_COOLDOWN_MS, 500),
    triggers,
    conditions,
    actions,
    ...(offActions ? { off_actions: offActions } : {})
  };
}

/**
 * Decompiles an array of AutomationRules from automations.json or localStorage.
 */
export function decompileAutomationRules(
  rawRules: any[],
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null
): AutomationRule[] {
  if (!Array.isArray(rawRules)) return [];
  return rawRules.filter(isPlainObject).map(r => decompileAutomationRule(r, catalog, vehicle));
}

/**
 * Compiles a single AutomationRule into a clean, self-contained schema with inlined actions.
 */
export function compileAutomationRule(
  rule: AutomationRule,
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null
): any {
  const compiledTriggerWindow =
    rule.trigger_window_ms !== undefined && rule.trigger_window_ms !== null
      ? clampInt(rule.trigger_window_ms, 500, 60000, 5000)
      : undefined;
  const compiledTimeoutReset =
    rule.timeout_reset_ms !== undefined && rule.timeout_reset_ms !== null && Number(rule.timeout_reset_ms) > 0
      ? clampInt(rule.timeout_reset_ms, 500, 60000, 5000)
      : undefined;

  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled ?? true,
    ha_expose: rule.ha_expose ?? true,
    ...(rule.hold_beep ? { hold_beep: true } : {}),
    ha_icon: rule.ha_icon || 'mdi:car-cog',
    exec_mode: rule.exec_mode || 'one_shot',
    trigger_mode: rule.trigger_mode || 'any',
    ...(compiledTriggerWindow !== undefined ? { trigger_window_ms: compiledTriggerWindow } : {}),
    cooldown_ms: clampInt(rule.cooldown_ms, 0, MAX_COOLDOWN_MS, 500),
    ...(compiledTimeoutReset !== undefined ? { timeout_reset_ms: compiledTimeoutReset } : {}),
    ...(rule.category ? { category: rule.category } : {}),
    ...(rule.description ? { description: rule.description } : {}),
    triggers: (Array.isArray(rule.triggers) ? rule.triggers : []).filter(isPlainObject).map((trig: AutomationTrigger) => {
      const isTimeScheduleTrigger =
        trig.type === 'time_schedule' || trig.type === 'time' || trig.source === 'time' || Boolean(trig.time);
      const isBleButtonTrigger =
        trig.type === 'ble_button' ||
        trig.type === 'ble_key' ||
        (trig.source === 'ble' && Boolean(trig.ble_button));
      const normalizedBle = isBleButtonTrigger
        ? normalizeBleButtonAction(trig.ble_action, trig.click_count)
        : {
            ble_action: trig.ble_action,
            click_count:
              trig.click_count !== undefined && trig.click_count !== null
                ? clampInt(trig.click_count, 1, 5, 1)
                : undefined
          };
      const effectiveClickCount = normalizedBle.click_count;
      const isMultiClick = Boolean(effectiveClickCount && effectiveClickCount > 1);
      const sustainedFields =
        !isMultiClick && !isTimeScheduleTrigger && !isBleButtonTrigger
          ? pickSustainedFields(trig as any)
          : {};
      const baseTrigger = {
        id: trig.id,
        ...(trig.name ? { name: trig.name } : {}),
        ...(trig.source_command_id ? { source_command_id: trig.source_command_id } : {}),
        ...(trig.source_command_name ? { source_command_name: trig.source_command_name } : {}),
        ...(trig.option_label ? { option_label: trig.option_label } : {}),
        ...(isMultiClick ? { click_count: effectiveClickCount } : {}),
        ...sustainedFields
      };

      if (isTimeScheduleTrigger) {
        return {
          ...baseTrigger,
          type: 'time_schedule',
          time: trig.time || '07:30',
          days: expandScheduleDays(trig.days)
        };
      }

      if (isBleButtonTrigger) {
        return {
          ...baseTrigger,
          type: 'ble_button',
          ble_button: trig.ble_button || 'volume_up',
          ble_action: normalizedBle.ble_action || 'press',
          ...(trig.ble_device ? { ble_device: trig.ble_device } : {})
        };
      }

      if (
        trig.type === 'ble_beacon' ||
        trig.type === 'beacon' ||
        ((trig.type === 'ble_presence' || trig.source === 'ble') &&
          (Boolean(trig.beacon_uuid) ||
            Boolean(trig.beacon_major || trig.beacon_minor) ||
            ['enter', 'exit', 'present', 'away', 'proximity'].includes(trig.ble_event || '')))
      ) {
        const clampedRssi = clampRssi(trig.target_rssi);
        return {
          ...baseTrigger,
          type: 'ble_beacon',
          ble_event: trig.ble_event || 'present',
          ...(trig.beacon_uuid ? { beacon_uuid: trig.beacon_uuid } : {}),
          ...(trig.beacon_major ? { beacon_major: trig.beacon_major } : {}),
          ...(trig.beacon_minor ? { beacon_minor: trig.beacon_minor } : {}),
          ...(trig.ble_device ? { ble_device: trig.ble_device } : {}),
          ...(trig.client_mac ? { client_mac: trig.client_mac } : {}),
          ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {})
        };
      }

      if (
        trig.type === 'ble_device_event' ||
        trig.type === 'ble_device' ||
        trig.type === 'ble_presence' ||
        trig.source === 'ble'
      ) {
        const clampedRssi = clampRssi(trig.target_rssi);
        return {
          ...baseTrigger,
          type: 'ble_device_event',
          ble_event: trig.ble_event || 'connected',
          ...(trig.ble_device ? { ble_device: trig.ble_device } : {}),
          ...(trig.client_mac ? { client_mac: trig.client_mac } : {}),
          ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {})
        };
      }

      if (trig.type === 'wifi' || trig.type === 'wifi_event' || trig.source === 'wifi') {
        const clampedRssi = clampRssi(trig.target_rssi);
        return {
          ...baseTrigger,
          type: 'wifi_event',
          wifi_event: trig.wifi_event || 'ap_client_connected',
          ...(trig.ssid ? { ssid: trig.ssid } : {}),
          ...(trig.client_mac ? { client_mac: trig.client_mac } : {}),
          ...(clampedRssi !== undefined && clampedRssi !== 0 ? { target_rssi: clampedRssi } : {})
        };
      }

      const normalizedMatch = compileToByteMap(trig.match || trig.to_payload || trig.match_payload);
      const matchKeys = Object.keys(normalizedMatch);
      const hasExplicitSingleByte = Boolean(
        trig.type === 'byte_transition' || trig.byte || trig.evaluate?.byte || trig.byte_index !== undefined
      );

      if (trig.type === 'can_rx' || (matchKeys.length > 1 && !hasExplicitSingleByte)) {
        const rawMask: unknown = trig.mask ?? trig.evaluate?.mask;
        let fullMask: string | ByteMap;
        if (rawMask && typeof rawMask === 'object' && !Array.isArray(rawMask)) {
          const normalizedMaskMap = compileToByteMap(rawMask as Record<string, unknown>);
          if (matchKeys.length > 1) {
            const mObj: ByteMap = {};
            matchKeys.forEach(k => {
              mObj[k] = normalizedMaskMap[k] || '0xFF';
            });
            fullMask = mObj;
          } else if (Object.keys(normalizedMaskMap).length > 0) {
            fullMask = normalizedMaskMap;
          } else {
            fullMask = '0xFF';
          }
        } else {
          const formattedSingleMask = formatHexByte(rawMask) || '0xFF';
          if (matchKeys.length > 1) {
            const mObj: ByteMap = {};
            matchKeys.forEach(k => {
              mObj[k] = formattedSingleMask;
            });
            fullMask = mObj;
          } else {
            fullMask = formattedSingleMask;
          }
        }
        return {
          ...baseTrigger,
          type: 'can_rx',
          can_id: trig.can_id || '',
          bus: trig.bus ?? 0,
          match: normalizedMatch,
          mask: fullMask
        };
      }

      const targetByte = resolveByteKeyWithIndexFallback(
        trig.byte || trig.evaluate?.byte,
        matchKeys[0],
        trig.byte_index ?? trig.evaluate?.byte_index,
        'D7'
      );
      const trigOp = trig.operator || trig.evaluate?.operator;
      const isRelationalOrInequality = Boolean(
        trigOp && RELATIONAL_OR_INEQUALITY_OPS.has(String(trigOp).toLowerCase().trim())
      );
      const rawFrom =
        trig.from !== undefined && trig.from !== null
          ? String(trig.from).trim()
          : (trig.from_value !== undefined && trig.from_value !== null ? formatHexByte(trig.from_value) : undefined);
      const fromHex = !isRelationalOrInequality && rawFrom ? formatHexByte(rawFrom) : undefined;
      const toHex =
        trig.to ||
        trig.value ||
        trig.evaluate?.value ||
        normalizedMatch[targetByte] ||
        (trig.to_value !== undefined ? formatHexByte(trig.to_value) : undefined) ||
        '0x10';
      const rawMask = trig.mask ?? trig.evaluate?.mask;
      const maskHex =
        (typeof rawMask === 'object' && rawMask !== null
          ? formatHexByte((rawMask as Record<string, unknown>)[targetByte])
          : formatHexByte(rawMask)) ||
        (typeof rawMask === 'string' && rawMask.trim() ? rawMask.trim() : undefined) ||
        (trigOp || trig.value !== undefined ? '0xFF' : '0xF0');

      return {
        ...baseTrigger,
        type: 'byte_transition',
        can_id: trig.can_id || '',
        bus: trig.bus ?? 0,
        byte: targetByte || '',
        mask: maskHex || '',
        ...(fromHex ? { from: fromHex } : {}),
        to: toHex || '',
        ...(trigOp && trigOp !== 'equal' ? { operator: trigOp } : {})
      };
    }),
    conditions: (Array.isArray(rule.conditions) ? rule.conditions : [])
      .filter(isPlainObject)
      .map(c => compileCondition(c as AutomationCondition, catalog, vehicle))
      .filter(Boolean),
    actions: compileActionList(rule.actions || [], catalog, vehicle),
    ...(rule.off_actions && rule.off_actions.length > 0
      ? { off_actions: compileActionList(rule.off_actions, catalog, vehicle) }
      : {})
  };
}

export const MAX_AUTOMATIONS_PAYLOAD_BYTES = 131072; // 128 KB firmware limit

export function getPayloadByteLength(payload: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(payload).length;
  }
  return payload.length;
}

/**
 * Generate standard WiCAN / CAN Do format strictly matching the exact architecture outcome
 */
export function exportToCandoJson(
  rules: AutomationRule[],
  settings: AutomationSettings = {},
  catalog: Catalog = DEFAULT_CATALOG,
  vehicle: Vehicle | null = null,
  options?: { minify?: boolean }
): string {
  const exportPayload = {
    settings: {
      vehicle_model: settings.vehicle_model || 'all_egmp',
      unit_system: settings.unit_system || 'imperial',
      can_do_version: settings.can_do_version || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'),
      ntp_server: settings.ntp_server || 'pool.ntp.org',
      timezone: settings.timezone || 'UTC'
    },
    rules: (Array.isArray(rules) ? rules : []).filter(isPlainObject).map(r => compileAutomationRule(r, catalog, vehicle))
  };

  return options?.minify ? JSON.stringify(exportPayload) : JSON.stringify(exportPayload, null, 2);
}

export function formatDefaultTriggerName(
  baseName?: string,
  optionLabel?: string,
  clickCount?: number
): string {
  const cleanBase = asString(baseName).trim();
  const cleanOpt = asString(optionLabel).trim();
  let result = cleanBase;
  if (cleanOpt && !cleanBase.toLowerCase().includes(cleanOpt.toLowerCase())) {
    result = cleanBase ? `${cleanBase} - ${cleanOpt}` : cleanOpt;
  } else if (!result) {
    result = cleanOpt || 'CAN Trigger';
  }
  if (clickCount && clickCount > 1) {
    result = `${result} (${clickCount}x Press)`;
  }
  return result;
}

/**
 * Convert a Catalog Command into an Automation Trigger
 */
export function commandToTrigger(
  rawCmd: Command,
  opt?: CommandOption,
  vehicle: Vehicle | null = null
): AutomationTrigger {
  const cmd = resolveVariant(rawCmd, vehicle);
  const trigId = `trig_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x448';
  const chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined);
  const cmdDisplayName = cmd.ha_metadata?.name || cmd.name || cmd.id;

  if (!chosenOpt && isRangeCommand(cmd)) {
    const net = cmd.network;
    const targetByte = normalizeByteKey(net?.state_byte || net?.byte || 'D1');
    const targetMask = net?.state_mask || net?.mask || (typeof cmd.mask === 'string' ? cmd.mask : undefined) || '0xFF';
    const defaultPhys = getDefaultPhysicalValue(net);
    const rawByte = physicalToRawByte(defaultPhys, net);
    const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
    const labelStr = `${defaultPhys}${net?.unit || ''}`;
    const byteIdx = byteKeyToIndex(targetByte);

    return {
      id: trigId,
      name: formatDefaultTriggerName(cmdDisplayName, labelStr, 1),
      type: 'byte_transition',
      source: 'can',
      can_id: canId,
      bus: net?.bus ?? cmd.bus ?? 0,
      byte: targetByte,
      mask: targetMask,
      operator: 'equal',
      value: hexVal,
      to: hexVal,
      to_value: rawByte,
      match: { [targetByte]: hexVal },
      evaluate: {
        byte: targetByte,
        byte_index: byteIdx,
        mask: targetMask,
        operator: 'equal',
        value: hexVal
      },
      click_count: 1,
      for_sec: 0,
      for_ms: 0,
      source_command_id: cmd.id,
      target_entity_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: labelStr
    };
  }

  const match = compileToByteMap(chosenOpt?.match || cmd.match || chosenOpt?.payload || cmd.payload, true);
  const matchKeys = Object.keys(match);
  const targetByte = matchKeys[0] || 'D7';
  const targetTo = match[targetByte] || '0x10';
  const targetMask = resolveMaskForMatch(chosenOpt?.mask ?? cmd.mask, matchKeys, targetByte, '0xFF', true) as string;

  return {
    id: trigId,
    name: formatDefaultTriggerName(cmdDisplayName, chosenOpt?.label, 1),
    type: 'byte_transition',
    source: 'can',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    byte: targetByte,
    mask: targetMask,
    to: targetTo,
    click_count: 1,
    for_sec: 0,
    for_ms: 0,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    option_label: chosenOpt?.label
  };
}

/**
 * Convert a Catalog Command into an Automation Condition
 */
export function commandToCondition(
  rawCmd: Command,
  opt?: CommandOption,
  vehicle: Vehicle | null = null
): AutomationCondition {
  const cmd = resolveVariant(rawCmd, vehicle);
  const chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined);
  const condId = `cond_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x000';

  if (!chosenOpt && isRangeCommand(cmd)) {
    const net = cmd.network;
    const dKey = normalizeByteKey(net?.state_byte || net?.byte || 'D1');
    const targetMask = net?.state_mask || net?.mask || (typeof cmd.mask === 'string' ? cmd.mask : undefined) || '0xFF';
    const defaultPhys = getDefaultPhysicalValue(net);
    const rawByte = physicalToRawByte(defaultPhys, net);
    const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
    const labelStr = `${defaultPhys}${net?.unit || ''}`;
    const byteIdx = byteKeyToIndex(dKey);

    return {
      id: condId,
      type: 'can_state',
      can_id: canId,
      bus: net?.bus ?? cmd.bus ?? 0,
      match: { [dKey]: hexVal },
      byte: dKey,
      mask: targetMask,
      operator: 'equal',
      value: hexVal,
      evaluate: {
        byte: dKey,
        byte_index: byteIdx,
        operator: 'equal',
        value: hexVal,
        mask: targetMask
      },
      invert: false,
      source_command_id: cmd.id,
      source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
      option_label: labelStr
    };
  }

  const optEval = typeof chosenOpt?.evaluate === 'object' ? chosenOpt.evaluate : (typeof cmd.evaluate === 'object' ? cmd.evaluate : undefined);
  const match = compileToByteMap(chosenOpt?.match || cmd.match || chosenOpt?.payload || cmd.payload, true);
  const dKey = optEval?.byte || chosenOpt?.byte || Object.keys(match)[0] || 'D1';
  const targetVal = optEval?.value !== undefined ? String(optEval.value) : (chosenOpt?.value || match[dKey] || '0x01');
  const targetOp = optEval?.operator || chosenOpt?.operator || 'equal';
  const cleanMatch = Object.keys(match).length > 0 ? match : { [dKey]: targetVal };
  const byteIdx = byteKeyToIndex(dKey);
  const targetMask = resolveMaskForMatch(
    optEval?.mask ?? chosenOpt?.mask ?? cmd.mask,
    Object.keys(cleanMatch),
    dKey
  );

  return {
    id: condId,
    type: 'can_state',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    match: cleanMatch,
    byte: dKey,
    mask: targetMask,
    operator: targetOp,
    value: targetVal,
    evaluate: {
      byte: dKey,
      byte_index: byteIdx,
      operator: targetOp,
      value: targetVal,
      mask: targetMask
    },
    invert: false,
    source_command_id: cmd.id,
    source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
    option_label: chosenOpt?.label
  };
}

/**
 * Convert a Catalog Command into an Automation Action
 */
export function commandToAction(
  rawCmd: Command,
  opt?: CommandOption,
  vehicle: Vehicle | null = null
): AutomationAction {
  const cmd = resolveVariant(rawCmd, vehicle);
  const chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined);
  const actId = `act_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || '0x000';
  const cmdDisplayName = cmd.ha_metadata?.name || cmd.name || cmd.id;

  if (cmd.type === 'climate_target') {
    return {
      id: actId,
      type: 'climate_target',
      target_temp_c: (cmd as any).target_temp_c ?? 21.0,
      zone: (cmd as any).climate_zone || 'driver',
      sync_on: (cmd as any).climate_sync_on ?? true,
      driver_only: (cmd as any).climate_driver_only ?? false,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName
    };
  }

  if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
    const { mode, action } = resolvePreconditionModeAndAction(
      { command: chosenOpt?.label, option_label: chosenOpt?.label },
      chosenOpt,
      cmd
    );
    return {
      id: actId,
      type: 'precondition',
      precon_mode: mode,
      precon_action: action,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: chosenOpt?.label
    };
  }

  if (cmd.network?.type === 'hud_nav' || (cmd as any).type === 'hud_nav' || cmd.id === 'hud_turn_by_turn_maneuver') {
    const matchD1 = chosenOpt?.match?.D1;
    const parsedIcon = matchD1 ? parseInt(String(matchD1), 16) : NaN;
    return {
      id: actId,
      type: 'hud_nav',
      nav_action: 'update',
      icon: !isNaN(parsedIcon) ? parsedIcon : 1,
      distance_meters: 200,
      bars: 4,
      speed_limit: 0,
      camera_alert: false,
      street: '',
      num_lanes: 0,
      lane_directions: [],
      lane_recommended: []
    };
  }

  if (cmd.network?.type === 'track_popup' || (cmd as any).type === 'track_popup' || cmd.id === 'cluster_track_popup_message') {
    return {
      id: actId,
      type: 'track_popup',
      level: ((chosenOpt as any)?.level as PopupLevel) || 'info',
      text: asString((chosenOpt as any)?.popup_message ?? chosenOpt?.popup ?? '')
    };
  }

  const effectiveActionBus = resolveActionBus(cmd);

  if (!chosenOpt && isRangeCommand(cmd)) {
    const net = cmd.network;
    const defaultPhys = getDefaultPhysicalValue(net);
    const rawByte = physicalToRawByte(defaultPhys, net);
    const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
    const payload = buildRangeActionPayload(hexVal, net);
    const labelStr = `${defaultPhys}${net?.unit || ''}`;
    const delayMs = net?.delay_ms ?? cmd.delay_ms ?? 0;
    const rangeSteps = resolveRangeSteps(cmd, hexVal);
    const cleanRangeSteps: AutomationActionStep[] | undefined = rangeSteps && rangeSteps.length > 1
      ? rangeSteps.map((s, idx) => ({
          can_id: s.can_id || canId,
          bus: s.bus ?? effectiveActionBus,
          payload: compileToByteMap(s.payload),
          repeat: s.repeat ?? 1,
          delay_ms: s.delay_ms ?? (idx < rangeSteps.length - 1 ? (delayMs || 20) : 0)
        }))
      : undefined;

    return {
      id: actId,
      type: 'can_tx',
      can_id: canId,
      bus: effectiveActionBus,
      payload: cleanRangeSteps ? cleanRangeSteps[0].payload : payload,
      ...(cleanRangeSteps ? { steps: cleanRangeSteps } : {}),
      repeat: cmd.repeat ?? 1,
      delay_ms: delayMs,
      entity_id: cmd.id,
      command: labelStr,
      option_label: labelStr,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      popup_message: `${cmdDisplayName} - ${labelStr}`
    };
  }

  const rawSteps = chosenOpt?.steps || (chosenOpt?.payload ? undefined : cmd.steps);
  const defaultStepDelay = cmd.network?.delay_ms ?? cmd.delay_ms ?? 20;
  const cleanSteps: AutomationActionStep[] | undefined = rawSteps && rawSteps.length > 0
    ? rawSteps.map((s, idx) => ({
        can_id: s.can_id || canId,
        bus: s.bus ?? effectiveActionBus,
        payload: compileToByteMap(s.payload),
        repeat: s.repeat ?? 1,
        delay_ms: s.delay_ms ?? (idx < rawSteps.length - 1 ? defaultStepDelay : 0)
      }))
    : undefined;

  const payload = compileToByteMap(chosenOpt?.payload || (chosenOpt?.steps && chosenOpt?.steps[0]?.payload) || cmd.payload);
  const repeat = chosenOpt?.repeat ?? (chosenOpt?.steps && chosenOpt?.steps[0]?.repeat) ?? cmd.repeat ?? 1;
  const delayMs = chosenOpt?.delay_ms ?? (chosenOpt?.steps && chosenOpt?.steps[0]?.delay_ms) ?? cmd.network?.delay_ms ?? cmd.delay_ms ?? 0;

  return {
    id: actId,
    type: 'can_tx',
    can_id: canId,
    bus: effectiveActionBus,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
    repeat: repeat,
    delay_ms: delayMs,
    ...(cleanSteps && cleanSteps.length > 1 ? { steps: cleanSteps } : {}),
    entity_id: cmd.id,
    command: chosenOpt?.label || 'Toggle',
    option_label: chosenOpt?.label,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    popup_message: chosenOpt?.popup || (chosenOpt?.label ? `${cmdDisplayName} - ${chosenOpt.label}` : cmdDisplayName)
  };
}

/**
 * Safely normalizes any CAN ID representation (number or hex string)
 * into a standard lowercase representation (e.g. "0x4a2") for lookup and comparison.
 */
export function normalizeCanId(canId: unknown): string {
  return formatCanId(canId).toLowerCase();
}

/**
 * Formats a CAN ID into standard canonical representation (e.g. "0x4A2").
 * Matches firmware `parser.cpp`: numbers are decimal integers (0..0x1FFFFFFF),
 * while strings are parsed as base-16 hex (with or without leading "0x").
 */
export function formatCanId(canId: unknown): string {
  if (canId === undefined || canId === null) return '';
  if (typeof canId === 'number') {
    if (!Number.isInteger(canId) || canId < 0 || canId > 0x1FFFFFFF) return '';
    return `0x${canId.toString(16).toUpperCase()}`;
  }
  const str = String(canId).trim();
  if (!str) return '';
  const hexMatch = str.match(/^(?:0x)?([0-9a-fA-F]+)$/i);
  if (hexMatch) {
    const num = parseInt(hexMatch[1], 16);
    if (!Number.isInteger(num) || num < 0 || num > 0x1FFFFFFF) return '';
    return `0x${hexMatch[1].toUpperCase()}`;
  }
  return '';
}

interface CatalogCommandIndex {
  byId: Map<string, Command>;
  byCanId: Map<string, Command[]>;
}

const _catalogIndexCache = new WeakMap<Command[], CatalogCommandIndex>();

function getCatalogCommandIndex(commands: Command[]): CatalogCommandIndex {
  let index = _catalogIndexCache.get(commands);
  if (!index) {
    const byId = new Map<string, Command>();
    const byCanId = new Map<string, Command[]>();

    for (const cmd of commands) {
      if (cmd.id) {
        byId.set(cmd.id, cmd);
      }
      const canIds = new Set<string>();
      const stateId = normalizeCanId(cmd.network?.state_can_id || cmd.state_can_id);
      const actionId = normalizeCanId(cmd.network?.action_can_id || cmd.action_can_id);
      if (stateId) canIds.add(stateId);
      if (actionId) canIds.add(actionId);
      if (Array.isArray(cmd.variants)) {
        for (const variant of cmd.variants) {
          const vStateId = normalizeCanId(variant?.network?.state_can_id);
          const vActionId = normalizeCanId(variant?.network?.action_can_id);
          if (vStateId) canIds.add(vStateId);
          if (vActionId) canIds.add(vActionId);
        }
      }
      for (const cid of canIds) {
        let list = byCanId.get(cid);
        if (!list) {
          list = [];
          byCanId.set(cid, list);
        }
        list.push(cmd);
      }
    }

    index = { byId, byCanId };
    _catalogIndexCache.set(commands, index);
  }
  return index;
}

/**
 * Resolves the catalog command and matched option for a trigger.
 * Handles explicit source_command_id, name patterns (e.g. trig_menu_ok -> sw_menu),
 * and reverse lookup by CAN ID & Byte/Mask match.
 */
export function resolveCatalogCommandForTrigger(
  trig: AutomationTrigger,
  catalog: Catalog,
  vehicle: Vehicle | null = null
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const index = getCatalogCommandIndex(catalog.commands);

  // 1. Direct ID match
  const directTrigId = trig.source_command_id || trig.target_entity_id;
  if (directTrigId) {
    const rawCmd = index.byId.get(directTrigId);
    if (rawCmd) {
      const cmd = resolveVariant(rawCmd, vehicle);
      const opt = findMatchingOptionForTrigger(cmd, trig);
      return { command: cmd, matchedOption: opt };
    }
  }

  // 2. ID name hint match (e.g. trig_menu_ok -> sw_menu)
  if (trig.id) {
    const lowerId = asString(trig.id).toLowerCase();
    if (lowerId.includes('menu') || lowerId.includes('ok')) {
      const swMenu = index.byId.get('sw_menu');
      if (swMenu) {
        const cmd = resolveVariant(swMenu, vehicle);
        const opt = findMatchingOptionForTrigger(cmd, trig);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 3. Match by CAN ID
  if (trig.can_id) {
    const normCanId = normalizeCanId(trig.can_id);
    const rawCands = index.byCanId.get(normCanId) ?? [];
    const resolvedCands = rawCands.map(raw => resolveVariant(raw, vehicle));
    let candidateCmds = resolvedCands;
    if (resolvedCands.length > 1) {
      const stateMatching = resolvedCands.filter(c => normalizeCanId(c.network?.state_can_id || c.state_can_id) === normCanId);
      if (stateMatching.length > 0) candidateCmds = stateMatching;
    }

    if (candidateCmds.length === 1) {
      const cmd = candidateCmds[0];
      const opt = findMatchingOptionForTrigger(cmd, trig, true);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      // Find candidate whose options match byte/value (strict - no blind fallback)
      for (const cmd of candidateCmds) {
        const opt = findMatchingOptionForTrigger(cmd, trig, false);
        if (opt) {
          return { command: cmd, matchedOption: opt };
        }
      }
      // Check command-level match
      for (const cmd of candidateCmds) {
        if (cmd.match && trig.byte && cmd.match[trig.byte]) {
          return { command: cmd, matchedOption: cmd.options?.[0] };
        }
      }
      // Disambiguate shared CAN ID range commands by state_byte / byte (e.g. 0x380 D2 driver vs D3 passenger)
      const trigByteKeyRaw = trig.byte || trig.evaluate?.byte || (trig.match ? Object.keys(trig.match)[0] : undefined);
      if (trigByteKeyRaw) {
        const normTrigByte = normalizeByteKey(trigByteKeyRaw);
        const rangeMatches = candidateCmds.filter(cmd => {
          if (!isRangeCommand(cmd)) return false;
          const cmdByte = cmd.network?.state_byte || cmd.network?.byte;
          return cmdByte ? normalizeByteKey(cmdByte) === normTrigByte : false;
        });
        if (rangeMatches.length === 1) {
          return { command: rangeMatches[0], matchedOption: undefined };
        }
      }
      return {};
    }
  }

  return {};
}

function toHexByte(val: any, allowNegated = false): string | undefined {
  const formatted = formatHexByte(val, allowNegated);
  return formatted ? formatted.toLowerCase() : undefined;
}

function isSignificantByte(byteHex: string | undefined): boolean {
  if (!byteHex) return false;
  const b = String(byteHex).toLowerCase().replace(/^0x/, '');
  return b !== 'ff' && b !== '00' && b !== '0';
}

/**
 * Common entity ID aliases and variations (e.g. singular vs plural, common shorthand)
 */
const ENTITY_ALIASES: Record<string, string> = {
  driver_seat_comfort: 'drivers_seat_comfort',
  driver_seat_heat: 'drivers_seat_comfort',
  driver_seat_heater: 'drivers_seat_comfort',
  driver_seat_warmer: 'drivers_seat_comfort',
  driver_seat_vent: 'drivers_seat_comfort',
  driver_seat_ventilation: 'drivers_seat_comfort',
  driver_seat_cool: 'drivers_seat_comfort',
  driver_seat: 'drivers_seat_comfort',
  drivers_seat: 'drivers_seat_comfort',
  drivers_seat_heat: 'drivers_seat_comfort',
  drivers_seat_heater: 'drivers_seat_comfort',
  drivers_seat_warmer: 'drivers_seat_comfort',
  drivers_seat_vent: 'drivers_seat_comfort',
  drivers_seat_cool: 'drivers_seat_comfort',
  seat_heat: 'drivers_seat_comfort',
  seat_heater: 'drivers_seat_comfort',
  seat_warmer: 'drivers_seat_comfort',
  seat_vent: 'drivers_seat_comfort',
  seat_ventilation: 'drivers_seat_comfort',
  passenger_seat_comfort: 'passengers_seat_comfort',
  passenger_seat_heat: 'passengers_seat_comfort',
  passenger_seat_heater: 'passengers_seat_comfort',
  passenger_seat_warmer: 'passengers_seat_comfort',
  passenger_seat_vent: 'passengers_seat_comfort',
  passenger_seat_cool: 'passengers_seat_comfort',
  passenger_seat: 'passengers_seat_comfort',
  passengers_seat: 'passengers_seat_comfort',
  passengers_seat_heat: 'passengers_seat_comfort',
  passengers_seat_heater: 'passengers_seat_comfort',
  passengers_seat_warmer: 'passengers_seat_comfort',
  passengers_seat_vent: 'passengers_seat_comfort',
  passengers_seat_cool: 'passengers_seat_comfort',
  rear_left_seat: 'rear_left_seat_comfort',
  rear_right_seat: 'rear_right_seat_comfort',
  steering_wheel_heat: 'heated_steering_wheel_toggle',
  heated_wheel: 'heated_steering_wheel_toggle',
  heated_steering_wheel: 'heated_steering_wheel_toggle',
  rear_defog: 'climate_rear_defrost',
  rear_defogger: 'climate_rear_defrost',
  defogger: 'climate_rear_defrost',
  rear_defrost: 'climate_rear_defrost',
  rear_defroster: 'climate_rear_defrost',
  defroster: 'climate_rear_defrost',
  ambient_mood_lighting: 'ambient_light_colors',
  ambient_mood_lamp_color: 'ambient_light_colors',
  mood_lighting: 'ambient_light_colors',
  ambient_light: 'ambient_light_colors',
};

function extractActionPayload(act: AutomationAction): ByteMap | undefined {
  // 1. Always prefer the first step's payload (Stage 1 command frame) so we don't accidentally
  // pick a Stage 2 commit latch frame (like 00 02 08 20) when Stage 1 is all 0x00 (e.g. Mood Light Off)
  if (Array.isArray(act.steps) && act.steps.length > 0) {
    const firstStep = act.steps[0];
    if (firstStep && firstStep.payload) {
      const map = compileToByteMap(firstStep.payload);
      if (Object.keys(map).length > 0) {
        return map;
      }
    }
    for (const step of act.steps) {
      if (step && step.payload) {
        const map = compileToByteMap(step.payload);
        if (Object.keys(map).length > 0 && Object.values(map).some(isSignificantByte)) {
          return map;
        }
      }
    }
    for (const step of act.steps) {
      if (step && step.payload) {
        const map = compileToByteMap(step.payload);
        if (Object.keys(map).length > 0) return map;
      }
    }
  }

  // 2. Fall back to act.payload
  if (act.payload) {
    const map = compileToByteMap(act.payload);
    if (Object.keys(map).length > 0) return map;
  }

  return undefined;
}

function findMatchingOptionForTrigger(cmd: Command, trig: AutomationTrigger, allowFallback = true): CommandOption | undefined {
  if (!cmd.options || cmd.options.length === 0) return undefined;
  if (trig.option_label) {
    const target = asString(trig.option_label).toLowerCase().trim();
    const byLabel = cmd.options.find(o => asString(o.label).toLowerCase().trim() === target);
    if (byLabel) return byLabel;
    const byPartial = cmd.options.find(o => {
      const l = asString(o.label).toLowerCase().trim();
      return l.includes(target) || target.includes(l);
    });
    if (byPartial) return byPartial;
  }
  const byteKey = trig.byte || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : undefined);
  const trigValHex = toHexByte(trig.to) ?? (trig.to_value !== undefined
    ? `0x${trig.to_value.toString(16).padStart(2, '0')}`.toLowerCase()
    : undefined);

  for (const opt of cmd.options) {
    if (opt.match && byteKey && opt.match[byteKey]) {
      const optMatchVal = asString(opt.match[byteKey]);
      const optVal = (optMatchVal.startsWith('0x') ? optMatchVal : `0x${optMatchVal}`).toLowerCase();
      if (trigValHex && optVal === trigValHex) return opt;
    }
  }
  if (trig.match && typeof trig.match === 'object') {
    for (const opt of cmd.options) {
      if (opt.match && typeof opt.match === 'object') {
        const matchKeys = Object.keys(trig.match);
        if (matchKeys.length > 0 && matchKeys.every(k => opt.match?.[k] === trig.match?.[k])) {
          return opt;
        }
      }
    }
  }
  return allowFallback ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined;
}

function findBestScoredOptionForAction(
  cmd: Command,
  act: AutomationAction,
  actPayload?: ByteMap
): { opt: CommandOption; score: number } | null {
  if (!cmd.options || cmd.options.length === 0) return null;

  let bestOpt: CommandOption | null = null;
  let highestScore = 0;

  const rawLabel = asString(act.option_label || act.command);
  const labelToMatch = rawLabel.toLowerCase().trim();

  for (const opt of cmd.options) {
    let score = 0;
    const optLabel = asString(opt.label).toLowerCase().trim();

    // 1. Label / Command matching
    if (labelToMatch) {
      if (optLabel === labelToMatch) {
        score += 100;
      } else if (optLabel.startsWith(labelToMatch) || labelToMatch.startsWith(optLabel)) {
        score += 60;
      } else if (optLabel.includes(labelToMatch) || labelToMatch.includes(optLabel)) {
        score += 40;
      }
    }

    // 2. Payload byte matching
    if (actPayload && Object.keys(actPayload).length > 0) {
      const optMap = compileToByteMap(opt.payload || (opt.steps && opt.steps[0]?.payload) || opt.match);
      const optKeys = Object.keys(optMap);
      const actKeys = Object.keys(actPayload);

      if (optKeys.length > 0) {
        let hasMismatch = false;
        let matchCount = 0;
        let significantMatchCount = 0;

        for (const k of actKeys) {
          if (optMap[k] !== undefined) {
            const aVal = String(actPayload[k]).toLowerCase();
            const oVal = String(optMap[k]).toLowerCase();
            if (aVal === oVal) {
              matchCount++;
              if (isSignificantByte(aVal)) {
                significantMatchCount++;
              }
            } else {
              hasMismatch = true;
              break;
            }
          }
        }

        if (hasMismatch) {
          // If overlapping bytes mismatch, this option cannot be active unless the label is an exact match
          if (!labelToMatch || optLabel !== labelToMatch) {
            score = 0;
          }
        } else if (significantMatchCount > 0) {
          // At least one non-idle/non-padding byte matched!
          score += matchCount * 25 + significantMatchCount * 50;
        } else if (matchCount > 0 && labelToMatch) {
          score += matchCount * 10;
        } else if (
          matchCount > 0 &&
          matchCount === optKeys.length &&
          matchCount === actKeys.length &&
          optKeys.every(k => String(optMap[k]).toLowerCase() === '0x00')
        ) {
          // Exact all-0x00 command payload (e.g. Hazard Lights Off / Mute Off / e-ASD Off),
          // while still rejecting partial 0xFF release/reset frames like { D5: '0xFF' }.
          score += matchCount * 15;
        }
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestOpt = opt;
    }
  }

  return bestOpt && highestScore > 0 ? { opt: bestOpt, score: highestScore } : null;
}

export function findMatchingEffectForAction(cmd: Command | undefined, act: AutomationAction): CommandEffect | undefined {
  if (!cmd?.effects || cmd.effects.length === 0) return undefined;
  const target = asString(act.option_label || act.command).trim().toLowerCase();
  if (!target) return undefined;
  return cmd.effects.find(
    (e) =>
      asString(e.label).trim().toLowerCase() === target ||
      (e.name && asString(e.name).trim().toLowerCase() === target)
  );
}

function findMatchingOptionForAction(cmd: Command, act: AutomationAction, allowFallback = true): CommandOption | undefined {
  if (!cmd.options || cmd.options.length === 0) return undefined;
  if (findMatchingEffectForAction(cmd, act)) return undefined;
  // Fast path: if no label, command, payload, or steps to match against, return default/first option immediately
  const hasCriteria = !!(act.option_label || act.command || act.payload || (act.steps && act.steps.length > 0));
  if (!hasCriteria) {
    return allowFallback ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined;
  }
  const actPayload = extractActionPayload(act);
  const scored = findBestScoredOptionForAction(cmd, act, actPayload);
  if (scored) return scored.opt;
  return allowFallback ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined;
}

/**
 * Resolves the catalog command and matched option for an action.
 * Handles explicit ID, common aliases (e.g. driver_seat_comfort -> drivers_seat_comfort),
 * name patterns, and multi-candidate CAN ID disambiguation without falsely collapsing to Defogger.
 */
export function resolveCatalogCommandForAction(
  act: AutomationAction,
  catalog: Catalog,
  vehicle: Vehicle | null = null
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const nonCatalogActionTypes = new Set([
    'hud_nav',
    'nav',
    'track_popup',
    'popup',
    'delay',
    'if_then',
    'choose',
    'wait_for',
    'repeat_until',
    'webhook'
  ]);
  if (act?.type && nonCatalogActionTypes.has(act.type)) {
    return {};
  }

  const index = getCatalogCommandIndex(catalog.commands);

  // 1. Direct ID or Alias match
  const rawTargetId = act.source_command_id || act.entity_id || act.target_command_id || (act as any).target_entity_id;
  if (rawTargetId) {
    const rawTargetStr = asString(rawTargetId);
    const normTarget = rawTargetStr.toLowerCase().trim();
    const resolvedId = index.byId.has(rawTargetStr)
      ? rawTargetStr
      : index.byId.has(normTarget)
      ? normTarget
      : ENTITY_ALIASES[normTarget];

    if (resolvedId) {
      const rawCmd = index.byId.get(resolvedId);
      if (rawCmd) {
        const cmd = resolveVariant(rawCmd, vehicle);
        const opt = findMatchingOptionForAction(cmd, act, true);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 2. Command Name / ID hint match (e.g. act.id contains 'drivers_seat_comfort', or source_command_name has 'Driver Seat')
  const nameHint = `${act.source_command_name || ''} ${act.id || ''}`.toLowerCase();
  if (nameHint.trim().length >= 5) {
    for (const [alias, canonicalId] of Object.entries(ENTITY_ALIASES)) {
      if (nameHint.includes(alias.replace(/_/g, ' ')) || nameHint.includes(alias)) {
        const rawCmd = index.byId.get(canonicalId);
        if (rawCmd) {
          const cmd = resolveVariant(rawCmd, vehicle);
          const opt = findMatchingOptionForAction(cmd, act, true);
          return { command: cmd, matchedOption: opt };
        }
      }
    }
  }

  // 3. Match by CAN ID
  if (act.can_id) {
    const normCanId = normalizeCanId(act.can_id);
    const rawCands = index.byCanId.get(normCanId) ?? [];
    const resolvedCands = rawCands.map(raw => resolveVariant(raw, vehicle));
    let candidateCmds = resolvedCands;
    if (resolvedCands.length > 1) {
      const actionMatching = resolvedCands.filter(c => normalizeCanId(c.network?.action_can_id || c.action_can_id) === normCanId);
      if (actionMatching.length > 0) candidateCmds = actionMatching;
    }

    if (candidateCmds.length === 1) {
      const cmd = candidateCmds[0];
      const opt = findMatchingOptionForAction(cmd, act, true);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      const actPayload = extractActionPayload(act);
      let bestCandidate: { cmd: Command; opt: CommandOption; score: number } | null = null;

      for (const cmd of candidateCmds) {
        const matchResult = findBestScoredOptionForAction(cmd, act, actPayload);
        if (matchResult && matchResult.score > (bestCandidate?.score ?? 0)) {
          bestCandidate = { cmd, opt: matchResult.opt, score: matchResult.score };
        }
      }

      if (bestCandidate && bestCandidate.score > 0) {
        return { command: bestCandidate.cmd, matchedOption: bestCandidate.opt };
      }

      // Check if candidate command name or id is mentioned in nameHint
      if (nameHint.trim()) {
        for (const cmd of candidateCmds) {
          const cName = asString(cmd.ha_metadata?.name || cmd.name || cmd.id).toLowerCase();
          if (nameHint.includes(cName) || (cName.length > 5 && nameHint.includes(cName.slice(0, 8)))) {
            const opt = findMatchingOptionForAction(cmd, act, false) || cmd.options?.[0];
            return { command: cmd, matchedOption: opt };
          }
        }
      }

      // Disambiguate shared CAN ID range commands by action_byte / base_payload (e.g. 0x4A0 D2 driver vs D8 passenger)
      if (actPayload && Object.keys(actPayload).length > 0) {
        let bestRange: { cmd: Command; score: number } | null = null;
        let tie = false;
        for (const cmd of candidateCmds) {
          if (!isRangeCommand(cmd)) continue;
          const actionByte = normalizeByteKey(cmd.network?.action_byte || cmd.network?.state_byte || cmd.network?.byte || 'D1');
          const actHex = toHexByte(actPayload[actionByte]);
          if (!actHex) continue;

          let score = 0;
          if (Array.isArray(cmd.network?.base_payload)) {
            const baseArr = cmd.network.base_payload;
            const actionIdx = byteKeyToIndex(actionByte);
            const baseActionHex = toHexByte(baseArr[actionIdx]);
            let headerMatch = 0;
            for (let b = 0; b < Math.min(baseArr.length, 8); b++) {
              if (b === actionIdx) continue;
              const expected = toHexByte(baseArr[b]);
              const actual = toHexByte(actPayload[`D${b + 1}`]);
              if (expected && actual && expected === actual) headerMatch++;
            }
            if (headerMatch > 0) {
              score = actHex !== baseActionHex ? 100 + headerMatch : 20 + headerMatch;
            }
          } else {
            score = Object.keys(actPayload).length === 1 ? 100 : 50;
          }

          if (score > 0) {
            if (!bestRange || score > bestRange.score) {
              bestRange = { cmd, score };
              tie = false;
            } else if (score === bestRange.score) {
              tie = true;
            }
          }
        }
        if (bestRange && !tie) {
          return { command: bestRange.cmd, matchedOption: undefined };
        }
      }

      // If multiple candidates share the CAN ID and none matched specifically,
      // DO NOT blindly return candidateCmds[0] (which is Defogger for 0x4A2).
      // Return empty so it renders faithfully as custom CAN transmit.
      return {};
    }
  }

  return {};
}

/**
 * Resolves the catalog command and matched option for a condition.
 * Handles explicit source_command_id, ID hints, and CAN ID/byte matching.
 */
export function resolveCatalogCommandForCondition(
  cond: AutomationCondition,
  catalog: Catalog,
  vehicle: Vehicle | null = null
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const index = getCatalogCommandIndex(catalog.commands);

  // 1. Direct ID match
  if (cond.source_command_id) {
    const rawCmd = index.byId.get(cond.source_command_id);
    if (rawCmd) {
      const cmd = resolveVariant(rawCmd, vehicle);
      const opt = findMatchingOptionForCondition(cmd, cond, true);
      return { command: cmd, matchedOption: opt };
    }
  }

  // 2. ID name hint match (e.g. cond_gear_drive -> gear_selector)
  const condIdStr = asString(cond.id);
  if (condIdStr.length >= 5) {
    const lowerId = condIdStr.toLowerCase();
    for (const c of catalog.commands) {
      if (lowerId.includes(asString(c.id).toLowerCase())) {
        const cmd = resolveVariant(c, vehicle);
        const opt = findMatchingOptionForCondition(cmd, cond, true);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 3. Match by CAN ID
  if (cond.can_id) {
    const normCanId = normalizeCanId(cond.can_id);
    const rawCands = index.byCanId.get(normCanId) ?? [];
    const resolvedCands = rawCands.map(raw => resolveVariant(raw, vehicle));
    let candidateCmds = resolvedCands;
    if (resolvedCands.length > 1) {
      const stateMatching = resolvedCands.filter(c => normalizeCanId(c.network?.state_can_id || c.state_can_id) === normCanId);
      if (stateMatching.length > 0) candidateCmds = stateMatching;
    }

    if (candidateCmds.length === 1) {
      const cmd = candidateCmds[0];
      const opt = findMatchingOptionForCondition(cmd, cond, true);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      for (const cmd of candidateCmds) {
        const opt = findMatchingOptionForCondition(cmd, cond, false);
        if (opt) return { command: cmd, matchedOption: opt };
      }
      // Disambiguate shared CAN ID range commands by state_byte / byte (e.g. 0x380 D2 driver vs D3 passenger)
      const condByteRaw = cond.byte || cond.evaluate?.byte || (cond.match ? Object.keys(cond.match)[0] : undefined);
      if (condByteRaw) {
        const normCondByte = normalizeByteKey(condByteRaw);
        const rangeMatches = candidateCmds.filter(cmd => {
          if (!isRangeCommand(cmd)) return false;
          const cmdByte = cmd.network?.state_byte || cmd.network?.byte;
          return cmdByte ? normalizeByteKey(cmdByte) === normCondByte : false;
        });
        if (rangeMatches.length === 1) {
          return { command: rangeMatches[0], matchedOption: undefined };
        }
      }
      return {};
    }
  }

  return {};
}

function findMatchingOptionForCondition(cmd: Command, cond: AutomationCondition, allowFallback = true): CommandOption | undefined {
  if (!cmd.options || cmd.options.length === 0) return undefined;
  if (cond.option_label) {
    const target = asString(cond.option_label).toLowerCase().trim();
    const byLabel = cmd.options.find(o => asString(o.label).toLowerCase().trim() === target);
    if (byLabel) return byLabel;
    const byPartial = cmd.options.find(o => {
      const l = asString(o.label).toLowerCase().trim();
      return l.includes(target) || target.includes(l);
    });
    if (byPartial) return byPartial;
  }
  const byteKey = cond.byte || cond.evaluate?.byte || (cond.match ? Object.keys(cond.match)[0] : undefined);
  const targetVal = cond.value || cond.evaluate?.value || (byteKey && cond.match ? cond.match[byteKey] : undefined);
  const targetHex = toHexByte(targetVal, true);

  if (byteKey && targetHex) {
    for (const opt of cmd.options) {
      const match = compileToByteMap(opt.match || opt.payload, true);
      if (match[byteKey] && asString(match[byteKey]).toLowerCase() === targetHex) {
        return opt;
      }
    }
  }

  return allowFallback ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined;
}

/**
 * Apply a selected catalog option to a trigger
 */
export function applyOptionToTrigger(
  trig: AutomationTrigger,
  rawCmd: Command,
  opt: CommandOption,
  vehicle: Vehicle | null = null
): AutomationTrigger {
  const cmd = resolveVariant(rawCmd, vehicle);
  const cleanMatch = compileToByteMap(opt.match || opt.payload || cmd.match || cmd.payload, true);
  const matchKeys = Object.keys(cleanMatch);
  const dKey = matchKeys[0] || 'D7';
  const targetTo = cleanMatch[dKey] || '0x10';
  const byteIdx = byteKeyToIndex(dKey, 6);
  const targetMask = resolveMaskForMatch(opt.mask ?? cmd.mask, matchKeys, dKey, '0xFF', true) as string;

  const toVal = parseInt(asString(targetTo).replace(/^0x/i, ''), 16);
  const friendlyName = cmd.id === 'sw_menu' ? 'Menu / OK Button' : (cmd.ha_metadata?.name || cmd.name || cmd.id);

  const targetFrom = (trig.from && trig.from !== targetTo)
    ? asString(trig.from)
    : (targetTo === '0x00' ? targetMask : '0x00');
  const fromVal = parseInt(asString(targetFrom).replace(/^0x/i, ''), 16);

  const prevCandidates = new Set<string>(
    [
      friendlyName,
      trig.source_command_name,
      cmd.name,
      cmd.ha_metadata?.name,
      trig.option_label,
      formatDefaultTriggerName(friendlyName, trig.option_label, trig.click_count),
      formatDefaultTriggerName(trig.source_command_name, trig.option_label, trig.click_count),
      formatDefaultTriggerName(cmd.name, trig.option_label, trig.click_count),
      formatDefaultTriggerName(friendlyName, trig.option_label, 1),
      formatDefaultTriggerName(cmd.name, trig.option_label, 1),
    ]
      .filter((s): s is string => Boolean(s))
      .map(s => asString(s).trim().toLowerCase())
  );

  const currentTrimmedName = asString(trig.name).trim();
  const shouldAutoUpdateName = !currentTrimmedName || prevCandidates.has(currentTrimmedName.toLowerCase());
  const nextName = shouldAutoUpdateName
    ? formatDefaultTriggerName(friendlyName, opt.label, trig.click_count)
    : trig.name;

  return {
    ...trig,
    name: nextName,
    source_command_id: cmd.id,
    source_command_name: friendlyName,
    option_label: opt.label,
    can_id: cmd.network?.state_can_id || cmd.state_can_id || trig.can_id || '0x448',
    bus: cmd.network?.bus ?? cmd.bus ?? trig.bus ?? 0,
    byte: dKey,
    byte_index: byteIdx,
    mask: targetMask,
    from: targetFrom,
    from_value: isNaN(fromVal) ? undefined : fromVal,
    to: targetTo,
    to_value: isNaN(toVal) ? undefined : toVal,
    match: cleanMatch,
    to_payload: cleanMatch
  };
}

/**
 * Apply a selected catalog option to an action
 */
export function applyOptionToAction(
  act: AutomationAction,
  rawCmd: Command,
  opt: CommandOption,
  vehicle: Vehicle | null = null
): AutomationAction {
  const cmd = resolveVariant(rawCmd, vehicle);
  const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || act.can_id || '0x000';
  const cmdDisplayName = cmd.ha_metadata?.name || cmd.name || cmd.id;

  if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
    const { mode, action } = resolvePreconditionModeAndAction(
      { command: opt.label, option_label: opt.label },
      opt,
      cmd
    );
    return {
      ...act,
      type: 'precondition',
      precon_mode: mode,
      precon_action: action,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      entity_id: cmd.id,
      command: opt.label,
      option_label: opt.label,
      can_id: undefined,
      payload: undefined,
      repeat: undefined,
      delay_ms: undefined,
      steps: undefined,
      popup_message: opt.popup || `${cmdDisplayName} - ${opt.label}`
    };
  }

  const effectiveActionBus = resolveActionBus(cmd, act.bus);
  const rawSteps = opt.steps || (opt.payload ? undefined : cmd.steps);
  const defaultStepDelay = cmd.network?.delay_ms ?? cmd.delay_ms ?? act.delay_ms ?? 20;
  const cleanSteps: AutomationActionStep[] | undefined = rawSteps && rawSteps.length > 0
    ? rawSteps.map((s, idx) => ({
        can_id: s.can_id || canId,
        bus: s.bus ?? effectiveActionBus,
        payload: compileToByteMap(s.payload),
        repeat: s.repeat ?? 1,
        delay_ms: s.delay_ms ?? (idx < rawSteps.length - 1 ? defaultStepDelay : 0)
      }))
    : undefined;

  const payload = compileToByteMap(opt.payload || (opt.steps && opt.steps[0]?.payload) || cmd.payload);
  const repeat = opt.repeat ?? (opt.steps && opt.steps[0]?.repeat) ?? cmd.repeat ?? act.repeat ?? 1;
  const delayMs = opt.delay_ms ?? (opt.steps && opt.steps[0]?.delay_ms) ?? cmd.network?.delay_ms ?? cmd.delay_ms ?? act.delay_ms ?? 0;

  return {
    ...act,
    type: 'can_tx',
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    entity_id: cmd.id,
    command: opt.label,
    option_label: opt.label,
    can_id: canId,
    bus: effectiveActionBus,
    payload: Object.keys(payload).length > 0 ? payload : act.payload,
    repeat: repeat,
    delay_ms: delayMs,
    steps: cleanSteps && cleanSteps.length > 1 ? cleanSteps : undefined,
    popup_message: opt.popup || `${cmdDisplayName} - ${opt.label}`
  };
}

/**
 * Apply a selected dynamic animation effect to an action as an edge entity_command.
 */
export function applyEffectToAction(
  act: AutomationAction,
  rawCmd: Command,
  eff: CommandEffect,
  vehicle: Vehicle | null = null
): AutomationAction {
  const cmd = resolveVariant(rawCmd, vehicle);
  const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || act.can_id || '0x000';
  const cmdDisplayName = cmd.ha_metadata?.name || cmd.name || cmd.id;
  const bus = resolveActionBus(cmd, act.bus);

  return {
    ...act,
    type: 'entity_command',
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    entity_id: cmd.id,
    command: eff.label,
    option_label: eff.label,
    can_id: canId,
    bus,
    payload: undefined,
    repeat: undefined,
    delay_ms: undefined,
    steps: undefined,
    popup_message: `${cmdDisplayName} - ${eff.name || eff.label}`,
  };
}

/**
 * Apply a selected catalog option to a condition
 */
export function applyOptionToCondition(
  cond: AutomationCondition,
  rawCmd: Command,
  opt: CommandOption,
  vehicle: Vehicle | null = null
): AutomationCondition {
  const cmd = resolveVariant(rawCmd, vehicle);
  const cleanMatch = compileToByteMap(opt.match || opt.payload || cmd.match || cmd.payload, true);
  const matchKeys = Object.keys(cleanMatch);
  const dKey = matchKeys[0] || cond.byte || 'D1';
  const targetVal = cleanMatch[dKey] || '0x01';
  const byteIdx = byteKeyToIndex(dKey);
  const targetMask = resolveMaskForMatch(opt.mask ?? cmd.mask, matchKeys, dKey);

  const friendlyName = cmd.ha_metadata?.name || cmd.name || cmd.id;

  return {
    ...cond,
    source_command_id: cmd.id,
    source_command_name: friendlyName,
    option_label: opt.label,
    can_id: cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || cond.can_id || '0x000',
    bus: cmd.network?.bus ?? cmd.bus ?? cond.bus ?? 0,
    byte: dKey,
    mask: targetMask,
    match: cleanMatch,
    operator: 'equal',
    value: targetVal,
    evaluate: {
      byte: dKey,
      byte_index: byteIdx,
      operator: 'equal',
      value: targetVal,
      mask: targetMask
    },
    invert: false
  };
}

/**
 * Apply multiple selected catalog options to a condition, merging their match bytes and masks
 */
export function applyOptionsToCondition(
  cond: AutomationCondition,
  rawCmd: Command,
  opts: CommandOption[],
  vehicle: Vehicle | null = null
): AutomationCondition {
  if (!opts || opts.length === 0) {
    return cond;
  }
  if (opts.length === 1) {
    const res = applyOptionToCondition(cond, rawCmd, opts[0], vehicle);
    return {
      ...res,
      selected_options: [opts[0].label]
    };
  }

  const cmd = resolveVariant(rawCmd, vehicle);
  const friendlyName = cmd.ha_metadata?.name || cmd.name || cmd.id;
  const mergedMatch: ByteMap = {};
  const mergedMask: Record<string, string> = {};

  const byteSeen: Record<string, string> = {};
  let hasSameByteConflict = false;

  opts.forEach(opt => {
    const m = compileToByteMap(opt.match || opt.payload, true);
    const optKeys = Object.keys(m);
    for (const [k, v] of Object.entries(m)) {
      if (byteSeen[k] !== undefined && byteSeen[k] !== v) {
        hasSameByteConflict = true;
      }
      byteSeen[k] = v;
    }
    Object.assign(mergedMatch, m);

    const optMask = resolveMaskForMatch(opt.mask ?? cmd.mask, optKeys, optKeys[0]);
    if (typeof optMask === 'string') {
      optKeys.forEach(k => {
        mergedMask[k] = optMask;
      });
    } else {
      Object.assign(mergedMask, optMask);
    }
  });

  const dKey = Object.keys(mergedMatch)[0] || 'D1';
  const targetVal = mergedMatch[dKey] || '0x01';
  const byteIdx = byteKeyToIndex(dKey);
  const finalMask = Object.keys(mergedMask).length > 1 ? mergedMask : (mergedMask[dKey] || '0xFF');

  const labels = opts.map(o => o.label);

  return {
    ...cond,
    source_command_id: cmd.id,
    source_command_name: friendlyName,
    option_label: labels.join(hasSameByteConflict ? ' or ' : ' + '),
    selected_options: labels,
    can_id: cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || cond.can_id || '0x000',
    bus: cmd.network?.bus ?? cmd.bus ?? cond.bus ?? 0,
    byte: dKey,
    mask: finalMask,
    match: mergedMatch,
    operator: 'equal',
    value: targetVal,
    evaluate: {
      byte: dKey,
      byte_index: byteIdx,
      operator: 'equal',
      value: targetVal,
      mask: finalMask
    },
    invert: false
  };
}

/**
 * Generates a unique short ID with a given prefix (e.g. 'act_', 'cond_', 'trg_', 'br_')
 */
function generateBlockId(prefix: string = 'blk'): string {
  const rand = Math.random().toString(36).substring(2, 8);
  const time = Date.now().toString(36).slice(-4);
  return `${prefix}_${time}${rand}`;
}

/**
 * Deep-clones an object without retaining references.
 */
export function deepClone<T>(obj: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // fallback
    }
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Recursively regenerates IDs for a Trigger node.
 */
export function regenerateTriggerIds(trigger: AutomationTrigger): AutomationTrigger {
  const clone = deepClone(trigger) as AutomationTrigger & { _clientId?: string; id?: string };
  clone._clientId = generateBlockId('trg');
  clone.id = generateBlockId('trg');
  return clone;
}

/**
 * Recursively regenerates IDs for a Condition node and any nested condition children.
 */
export function regenerateConditionIds(condition: AutomationCondition): AutomationCondition {
  const clone = deepClone(condition) as AutomationCondition & {
    _clientId?: string;
    id?: string;
    conditions?: AutomationCondition[];
    and?: AutomationCondition[];
    or?: AutomationCondition[];
    not?: AutomationCondition[] | AutomationCondition;
  };
  clone._clientId = generateBlockId('cond');
  clone.id = generateBlockId('cond');
  // Handle nested AND / OR / NOT condition groups if present
  if (Array.isArray(clone.conditions)) {
    clone.conditions = clone.conditions.map(c => regenerateConditionIds(c));
  }
  if (Array.isArray(clone.and)) {
    clone.and = clone.and.map(c => regenerateConditionIds(c));
  }
  if (Array.isArray(clone.or)) {
    clone.or = clone.or.map(c => regenerateConditionIds(c));
  }
  if (Array.isArray(clone.not)) {
    clone.not = clone.not.map(c => regenerateConditionIds(c));
  } else if (clone.not && typeof clone.not === 'object') {
    clone.not = regenerateConditionIds(clone.not as AutomationCondition);
  }
  return clone;
}

/**
 * Recursively regenerates IDs for a ChoiceBranch and all nested conditions/actions.
 */
export function regenerateBranchIds(branch: ChoiceBranch, markAsCopy = false): ChoiceBranch {
  const clone = deepClone(branch);
  clone._clientId = generateBlockId('br');
  if (markAsCopy && clone.label) {
    const labelStr = asString(clone.label);
    clone.label = labelStr.endsWith('(Copy)') ? labelStr : `${labelStr} (Copy)`;
  }
  clone.conditions = Array.isArray(clone.conditions)
    ? clone.conditions.map(c => regenerateConditionIds(c))
    : [];
  clone.sequence = Array.isArray(clone.sequence)
    ? clone.sequence.map(a => regenerateActionIds(a))
    : [];
  return clone;
}

/**
 * Recursively regenerates IDs for an Action node, including nested Choose branches,
 * If/Then/Else sequences, and Repeat blocks.
 */
export function regenerateActionIds(action: AutomationAction): AutomationAction {
  const clone = deepClone(action) as AutomationAction & {
    _clientId?: string;
    id?: string;
    choices?: ChoiceBranch[];
    default?: AutomationAction[];
    condition?: AutomationCondition;
    conditions?: AutomationCondition[];
    if?: AutomationCondition[];
    then?: AutomationAction[];
    else?: AutomationAction[];
    sequence?: AutomationAction[];
  };
  clone._clientId = generateBlockId('act');
  if (clone.id) {
    clone.id = generateBlockId('act');
  }

  // 1. Nested 'choose' branches & default sequence
  if (Array.isArray(clone.choices)) {
    clone.choices = clone.choices.map(b => regenerateBranchIds(b, false));
  }
  if (Array.isArray(clone.default)) {
    clone.default = clone.default.map(a => regenerateActionIds(a));
  }

  // 2. Nested 'if_then', 'repeat_until', and 'wait_for' conditions/branches
  if (clone.condition && isPlainObject(clone.condition)) {
    clone.condition = regenerateConditionIds(clone.condition);
  }
  if (Array.isArray(clone.conditions)) {
    clone.conditions = clone.conditions.map(c => regenerateConditionIds(c));
  }
  if (Array.isArray(clone.if)) {
    clone.if = clone.if.map(c => regenerateConditionIds(c));
  }
  if (Array.isArray(clone.then)) {
    clone.then = clone.then.map(a => regenerateActionIds(a));
  }
  if (Array.isArray(clone.else)) {
    clone.else = clone.else.map(a => regenerateActionIds(a));
  }

  // 3. Nested 'repeat' or group sequences
  if (Array.isArray(clone.sequence)) {
    clone.sequence = clone.sequence.map(a => regenerateActionIds(a));
  }

  return clone;
}

/**
 * Clones an entire AutomationRule with fresh IDs across all triggers, conditions, and actions.
 */
export function cloneRuleWithNewIds(rule: AutomationRule): AutomationRule {
  const clone = deepClone(rule);
  clone.id = generateBlockId('rule');
  clone.name = `${clone.name || 'Automation'} (Copy)`;
  if (Array.isArray(clone.triggers)) {
    clone.triggers = clone.triggers.map(t => regenerateTriggerIds(t));
  }
  if (Array.isArray(clone.conditions)) {
    clone.conditions = clone.conditions.map(c => regenerateConditionIds(c));
  }
  if (Array.isArray(clone.actions)) {
    clone.actions = clone.actions.map(a => regenerateActionIds(a));
  }
  if (Array.isArray(clone.off_actions)) {
    clone.off_actions = clone.off_actions.map(a => regenerateActionIds(a));
  }
  return clone;
}

/**
 * Converts a Trigger into a Condition (or vice-versa) when cross-pasting between
 * Trigger and Condition sections.
 */
export function convertTriggerToCondition(trigger: AutomationTrigger): AutomationCondition {
  const raw = deepClone(trigger) as Record<string, any>;
  delete raw.id;
  delete raw._clientId;

  const isTime = raw.type === 'time_schedule' || raw.type === 'time' || raw.source === 'time' || Boolean(raw.time);
  const isVoltage = raw.type === 'voltage' || raw.source === 'voltage';
  const isBleButton = raw.type === 'ble_button' || raw.type === 'ble_key';
  const isBlePresence =
    !isBleButton &&
    (raw.type === 'ble_presence' ||
      raw.type === 'ble_beacon' ||
      raw.type === 'beacon' ||
      raw.type === 'ble_device' ||
      raw.type === 'ble_device_event' ||
      raw.source === 'ble');
  const isWifi = raw.type === 'wifi' || raw.type === 'wifi_event' || raw.source === 'wifi';

  if (isTime) {
    return regenerateConditionIds({
      ...raw,
      type: 'time_condition',
      start_time: raw.start_time || raw.time || '08:00',
      end_time: raw.end_time || '18:00',
      days: expandScheduleDays(raw.days)
    } as AutomationCondition);
  }

  if (isVoltage) {
    const preservedOp = raw.operator || (raw.voltage_dir === 'below' ? 'less' : 'greater');
    const resolvedVal = raw.value !== undefined ? String(raw.value) : (raw.voltage_val !== undefined ? String(raw.voltage_val) : '12.4');
    const resolvedDir =
      raw.voltage_dir ||
      (preservedOp === 'less' || preservedOp === 'less_than' || preservedOp === 'less_than_or_equal' ? 'below' : 'above');
    return regenerateConditionIds({
      ...raw,
      type: 'voltage',
      operator: preservedOp,
      value: resolvedVal,
      voltage_val: resolvedVal,
      voltage_dir: resolvedDir
    } as AutomationCondition);
  }

  if (isBleButton) {
    const normalizedBle = normalizeBleButtonAction(raw.ble_action);
    return regenerateConditionIds({
      ...raw,
      type: 'ble_button',
      ble_button: raw.ble_button || raw.target_string || 'volume_up',
      ble_action: normalizedBle.ble_action || 'press',
      ...(raw.operator ? { operator: raw.operator } : {}),
      ...(raw.to !== undefined || raw.value !== undefined ? { value: raw.to ?? raw.value } : {})
    } as AutomationCondition);
  }

  if (isBlePresence) {
    const ev = asString(raw.ble_event).toLowerCase().trim();
    let deviceProperty = raw.device_property;
    let targetBool = raw.target_bool;
    if (ev === 'exit' || ev === 'away') {
      deviceProperty = 'away';
      targetBool = false;
    } else if (ev === 'disconnected') {
      deviceProperty = 'disconnected';
      targetBool = false;
    } else if (ev === 'connected') {
      deviceProperty = 'connected';
      targetBool = true;
    } else if (ev === 'proximity') {
      deviceProperty = 'beacon_rssi';
      targetBool = true;
    } else {
      deviceProperty = deviceProperty || 'present';
      targetBool = targetBool ?? true;
    }
    const targetString = raw.target_string || raw.beacon_uuid || raw.ble_device || raw.client_mac;
    const clampedRssi = clampRssi(raw.target_rssi);
    const preservedOp =
      raw.operator ||
      (clampedRssi !== undefined && clampedRssi !== 0 ? 'greater_than_or_equal' : undefined);
    return regenerateConditionIds({
      ...raw,
      type: 'ble_presence',
      device_property: deviceProperty,
      target_bool: targetBool,
      ...(targetString ? { target_string: targetString } : {}),
      ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {}),
      ...(preservedOp ? { operator: preservedOp } : {})
    } as AutomationCondition);
  }

  if (isWifi) {
    const ev = asString(raw.wifi_event).toLowerCase().trim();
    let deviceProperty = raw.device_property;
    let targetBool = raw.target_bool;
    let targetString = raw.target_string;
    if (ev === 'ap_client_connected' || ev === 'ap_client_disconnected') {
      deviceProperty = 'ap_client_connected';
      targetBool = ev === 'ap_client_connected';
      targetString = raw.client_mac || raw.target_string;
    } else if (ev === 'wifi_connected' || ev === 'wifi_disconnected') {
      deviceProperty = 'wifi_connected';
      targetBool = ev === 'wifi_connected';
      targetString = raw.ssid || raw.target_string;
    } else {
      deviceProperty = deviceProperty || (raw.client_mac ? 'ap_client_connected' : 'wifi_ssid');
      targetString = targetString || raw.ssid || raw.client_mac;
      targetBool = targetBool ?? true;
    }
    const clampedRssi = clampRssi(raw.target_rssi);
    const preservedOp =
      raw.operator ||
      (clampedRssi !== undefined && clampedRssi !== 0 ? 'greater_than_or_equal' : 'equal');
    return regenerateConditionIds({
      ...raw,
      type: 'device_state',
      device_property: deviceProperty,
      ...(targetString ? { target_string: targetString } : {}),
      ...(targetBool !== undefined ? { target_bool: targetBool } : {}),
      ...(clampedRssi !== undefined ? { target_rssi: clampedRssi } : {}),
      operator: preservedOp
    } as AutomationCondition);
  }

  const preservedOp = raw.operator || raw.evaluate?.operator || 'equal';
  return regenerateConditionIds({
    ...raw,
    type: 'can_state',
    operator: preservedOp,
    value: raw.to ?? raw.value ?? raw.evaluate?.value ?? raw.to_value ?? raw.match_payload,
    match: raw.to_payload ?? raw.match ?? raw.match_payload,
    ...(raw.evaluate && isPlainObject(raw.evaluate)
      ? { evaluate: { ...raw.evaluate, operator: preservedOp } }
      : {})
  } as AutomationCondition);
}

export function convertConditionToTrigger(condition: AutomationCondition): AutomationTrigger {
  const raw = deepClone(condition) as Record<string, any>;
  delete raw.id;
  delete raw._clientId;

  const isTime = raw.type === 'time_condition' || raw.type === 'time';
  const isVoltage = raw.type === 'voltage';
  const isBleButton = raw.type === 'ble_button' || raw.type === 'ble_key' || raw.type === 'ble';
  const isBlePresence =
    !isBleButton &&
    (raw.type === 'ble_presence' || raw.type === 'ble_beacon' || raw.type === 'beacon' || raw.type === 'ble_device');
  const isWifi =
    raw.type === 'wifi' || raw.type === 'wifi_event' || raw.type === 'wifi_condition' || raw.type === 'device_state';

  if (isTime) {
    return regenerateTriggerIds({
      ...raw,
      source: 'time',
      type: 'time_schedule',
      time: raw.time || raw.start_time || '07:30',
      days: expandScheduleDays(raw.days)
    } as AutomationTrigger);
  }

  if (isVoltage) {
    const preservedOp = raw.operator || (raw.voltage_dir === 'below' ? 'less' : 'greater');
    const resolvedVal = raw.voltage_val !== undefined ? String(raw.voltage_val) : (raw.value !== undefined ? String(raw.value) : '12.4');
    const resolvedDir =
      raw.voltage_dir ||
      (preservedOp === 'less' || preservedOp === 'less_than' || preservedOp === 'less_than_or_equal' ? 'below' : 'above');
    return regenerateTriggerIds({
      ...raw,
      source: 'voltage',
      type: 'voltage',
      operator: preservedOp,
      value: resolvedVal,
      voltage_val: resolvedVal,
      voltage_dir: resolvedDir
    } as AutomationTrigger);
  }

  if (isBleButton) {
    const normalizedBle = normalizeBleButtonAction(raw.ble_action);
    return regenerateTriggerIds({
      ...raw,
      source: 'ble',
      type: 'ble_button',
      ble_button: raw.ble_button || raw.target_string || 'volume_up',
      ble_action: normalizedBle.ble_action || 'press',
      ...(raw.value !== undefined || raw.to !== undefined ? { to: raw.value ?? raw.to } : {})
    } as AutomationTrigger);
  }

  if (isBlePresence) {
    const prop = asString(raw.device_property).toLowerCase().trim();
    let bleEvent = raw.ble_event;
    if (prop === 'away') {
      bleEvent = 'away';
    } else if (prop === 'disconnected') {
      bleEvent = 'disconnected';
    } else if (prop === 'connected') {
      bleEvent = raw.target_bool === false ? 'disconnected' : 'connected';
    } else if (prop === 'beacon_rssi' || prop === 'ble_rssi') {
      bleEvent = 'proximity';
    } else if (prop === 'present' || prop === 'beacon_present') {
      bleEvent = raw.target_bool === false ? 'away' : 'present';
    } else if (!bleEvent) {
      bleEvent = raw.target_bool === false ? 'away' : 'present';
    }
    const isBeaconLike = Boolean(
      raw.type === 'ble_beacon' ||
        raw.type === 'beacon' ||
        raw.beacon_uuid ||
        raw.beacon_major ||
        raw.beacon_minor ||
        ['present', 'away', 'beacon_present', 'beacon_rssi'].includes(prop)
    );
    const resolvedBeaconUuid = isBeaconLike ? (raw.beacon_uuid || (!raw.ble_device ? raw.target_string : undefined)) : raw.beacon_uuid;
    const resolvedBleDevice = !isBeaconLike ? (raw.ble_device || raw.target_string) : raw.ble_device;
    return regenerateTriggerIds({
      ...raw,
      source: 'ble',
      type: 'ble_presence',
      ble_event: bleEvent,
      ...(resolvedBeaconUuid ? { beacon_uuid: resolvedBeaconUuid } : {}),
      ...(resolvedBleDevice ? { ble_device: resolvedBleDevice } : {})
    } as AutomationTrigger);
  }

  if (isWifi) {
    const prop = asString(raw.device_property).toLowerCase().trim();
    let wifiEvent = raw.wifi_event;
    let ssid = raw.ssid;
    let clientMac = raw.client_mac;
    if (prop === 'ap_client_connected' || prop === 'ap_client_rssi') {
      wifiEvent = wifiEvent || (raw.target_bool === false ? 'ap_client_disconnected' : 'ap_client_connected');
      clientMac = clientMac || raw.target_string;
    } else {
      wifiEvent = wifiEvent || (raw.target_bool === false || raw.operator === 'not_equal' ? 'wifi_disconnected' : 'wifi_connected');
      if (prop !== 'wifi_mode') {
        ssid = ssid || raw.target_string;
      }
    }
    return regenerateTriggerIds({
      ...raw,
      source: 'wifi',
      type: 'wifi_event',
      wifi_event: wifiEvent,
      ...(ssid ? { ssid } : {}),
      ...(clientMac ? { client_mac: clientMac } : {})
    } as AutomationTrigger);
  }

  const rawOp = raw.operator || raw.evaluate?.operator;
  const effectiveOp =
    raw.invert === true
      ? rawOp === 'not_equal'
        ? 'equal'
        : rawOp === 'equal' || !rawOp
          ? 'not_equal'
          : rawOp
      : rawOp;

  return regenerateTriggerIds({
    ...raw,
    source: 'can',
    type: 'byte_transition',
    ...(effectiveOp ? { operator: effectiveOp } : {}),
    to: raw.value ?? raw.evaluate?.value ?? raw.state ?? (typeof raw.match === 'string' ? raw.match : undefined),
    to_payload: raw.match ?? raw.match_payload,
    ...(raw.evaluate && isPlainObject(raw.evaluate)
      ? { evaluate: { ...raw.evaluate, ...(effectiveOp ? { operator: effectiveOp } : {}) } }
      : {})
  } as AutomationTrigger);
}

