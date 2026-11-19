import type { ByteMap, Catalog, Command, CommandOption, Vehicle } from '../types/catalog.js';
import {
  buildRangeActionPayload,
  cleanToByteMap,
  isRangeCommand,
  physicalToRawByte,
  resolveRangeSteps,
  resolveVariant,
} from './catalogUtils.js';

export interface DashboardCommandStepPayload {
  type?: string;
  can_id?: string;
  bus?: number;
  repeat?: number;
  delay_ms?: number;
  payload?: ByteMap | string;
}

export interface DashboardCommandPayload {
  entity: string;
  command: string;
  can_id?: string;
  bus?: number;
  delay_ms?: number;
  repeat?: number;
  payload?: ByteMap | string;
  steps?: DashboardCommandStepPayload[];
}

function getLabelMatchScore(optLabel: string, cmdLower: string): number {
  const optLower = optLabel.trim().toLowerCase();
  if (!optLower || !cmdLower) return 0;
  if (optLower === cmdLower) return 1000;

  if (cmdLower === 'lock' || cmdLower === 'locked' || cmdLower === 'secure') {
    return optLower.includes('lock') && !optLower.includes('unlock') ? 900 : 0;
  }
  if (cmdLower === 'unlock' || cmdLower === 'unlocked') {
    return optLower.includes('unlock') ? 900 : 0;
  }
  if (cmdLower === 'open' || cmdLower === 'opened') {
    return optLower.includes('open') && !optLower.includes('close') ? 900 : 0;
  }
  if (cmdLower === 'close' || cmdLower === 'closed' || cmdLower === 'shut') {
    return optLower.includes('close') || optLower.includes('shut') ? 900 : 0;
  }
  if (cmdLower === 'on' || cmdLower === '1' || cmdLower === 'true' || cmdLower === 'enable') {
    if (/\boff\b|inactive|disable/.test(optLower)) return 0;
    return /\bon\b|active|enable/.test(optLower) ? 850 : 0;
  }
  if (cmdLower === 'off' || cmdLower === '0' || cmdLower === 'false' || cmdLower === 'disable') {
    return /\boff\b|inactive|disable/.test(optLower) ? 850 : 0;
  }

  if (optLower.startsWith(cmdLower)) {
    return 700 - (optLower.length - cmdLower.length);
  }
  if (optLower.includes(cmdLower)) {
    return 600 - (optLower.length - cmdLower.length);
  }
  if (cmdLower.includes(optLower)) {
    // Prefer longer option matches so 'Brightness Level 1' does not shadow 'Brightness Level 10'
    return 400 + optLower.length;
  }
  return 0;
}

export function findOptionForDashboardCommand(
  options: CommandOption[] | undefined,
  commandLabel: string
): CommandOption | undefined {
  if (!options || options.length === 0) return undefined;
  const cmdLower = commandLabel.trim().toLowerCase();
  if (!cmdLower) return options.length === 1 ? options[0] : undefined;

  let bestOpt: CommandOption | undefined;
  let bestScore = 0;

  for (const opt of options) {
    const score = getLabelMatchScore(opt.label || '', cmdLower);
    if (score > bestScore) {
      bestScore = score;
      bestOpt = opt;
    }
  }

  return bestOpt;
}

function normalizeStepPayload(rawPayload: string | ByteMap | undefined): string | ByteMap | undefined {
  if (rawPayload === undefined) return undefined;
  if (typeof rawPayload === 'string') {
    const trimmed = rawPayload.trim();
    if (!trimmed) return undefined;
    if (!trimmed.includes('*') && !trimmed.includes('?') && !trimmed.includes(' ')) {
      return trimmed.toUpperCase();
    }
    return cleanToByteMap(trimmed);
  }
  const cleanMap = cleanToByteMap(rawPayload);
  return Object.keys(cleanMap).length > 0 ? cleanMap : undefined;
}

function serializeActionSteps(
  steps: any[],
  defaultCanId: string | undefined,
  defaultBus: number
): DashboardCommandStepPayload[] {
  return steps
    .map((s) => {
      const stepCanId: string | undefined = s.can_id || s.action_can_id || defaultCanId;
      const stepBus: number = s.bus !== undefined ? Number(s.bus) : defaultBus;
      const stepDelay = s.delay_ms ?? s.dwell_ms;
      const normalizedPayload = s.type === 'delay' ? undefined : normalizeStepPayload(s.payload);

      return {
        ...(s.type ? { type: s.type } : {}),
        ...(stepCanId ? { can_id: stepCanId } : {}),
        bus: stepBus,
        repeat: s.repeat !== undefined ? Number(s.repeat) : 1,
        ...(stepDelay !== undefined ? { delay_ms: Number(stepDelay) } : {}),
        ...(normalizedPayload !== undefined ? { payload: normalizedPayload } : {}),
      };
    })
    .filter((s) => s.type === 'delay' || s.payload !== undefined);
}

/**
 * Resolves a dashboard control invocation (`entityId` + `commandLabel`) against the loaded
 * catalog and active vehicle variant so POST `/api/command` carries both high-level entity metadata
 * (supporting ESP32 native subsystems like remote_climate_tmu / ambient_light_colors / HA sync)
 * AND complete direct CAN fallback frames or multi-step `steps` (supporting param_range commands
 * like cabin temperatures or firmwares without `/spiffs/catalog.json`).
 */
export function resolveDashboardCommandRequest(
  entityId: string,
  commandLabel: string,
  catalog?: Catalog | null,
  activeVehicle?: Vehicle | null
): DashboardCommandPayload {
  const base: DashboardCommandPayload = {
    entity: entityId,
    command: commandLabel,
  };

  const list = (catalog?.commands || (catalog as any)?.features || []) as Command[];
  const rawCmd = list.find((c) => c.id === entityId);
  if (!rawCmd) {
    return base;
  }

  const cmd = resolveVariant(rawCmd, activeVehicle);
  const net = cmd.network;
  const defaultCanId =
    net?.action_can_id ||
    (cmd as any).action_can_id ||
    net?.state_can_id ||
    (cmd as any).state_can_id;
  const defaultBus = net?.bus ?? cmd.bus ?? 0;
  const defaultDelayMs = net?.delay_ms ?? cmd.delay_ms ?? 20;

  // Stateful firmware subsystems handle their own CAN wakeups, ISO-TP sequences, or LED animations
  if (entityId === 'remote_climate_tmu' || entityId === 'battery_preconditioning') {
    return base;
  }

  if (cmd.effects && cmd.effects.length > 0) {
    const cmdLower = commandLabel.trim().toLowerCase();
    const matchedEffect = cmd.effects.find(
      (e) =>
        e.label.trim().toLowerCase() === cmdLower ||
        (e.name && e.name.trim().toLowerCase() === cmdLower)
    );
    if (matchedEffect) {
      return {
        entity: entityId,
        command: matchedEffect.label,
      };
    }
  }

  const matchedOption = findOptionForDashboardCommand(cmd.options, commandLabel);
  if (matchedOption) {
    const canonicalCommand = matchedOption.label || commandLabel;
    if (matchedOption.steps && matchedOption.steps.length > 0) {
      const steps = serializeActionSteps(matchedOption.steps, defaultCanId, defaultBus);
      if (steps.length > 0) {
        return {
          entity: entityId,
          command: canonicalCommand,
          ...(defaultCanId ? { can_id: defaultCanId } : {}),
          bus: defaultBus,
          delay_ms: defaultDelayMs,
          steps,
        };
      }
    }

    const rawOptPayload = matchedOption.payload || matchedOption.to_payload;
    if (rawOptPayload) {
      const normalized = normalizeStepPayload(rawOptPayload);
      if (normalized !== undefined) {
        return {
          entity: entityId,
          command: canonicalCommand,
          ...(defaultCanId ? { can_id: defaultCanId } : {}),
          bus: defaultBus,
          delay_ms: defaultDelayMs,
          repeat: cmd.repeat ?? 1,
          payload: normalized,
        };
      }
    }

    return {
      ...base,
      command: canonicalCommand,
    };
  }

  // Range / numeric scale resolution (e.g. climate_driver_temp, climate_passenger_temp, ambient_light_brightness)
  const hasRangeMeta =
    isRangeCommand(cmd) ||
    ((cmd.type === 'param_range' || cmd.type === 'linear_scale') &&
      net?.min !== undefined &&
      net?.max !== undefined);

  if (hasRangeMeta && net && defaultCanId) {
    const numMatch = commandLabel.match(/-?\d+(\.\d+)?/);
    if (numMatch) {
      let phys = parseFloat(numMatch[0]);
      if (net.min !== undefined) phys = Math.max(net.min, phys);
      if (net.max !== undefined) phys = Math.min(net.max, phys);
      const raw = physicalToRawByte(phys, net);
      const hexVal = `0x${raw.toString(16).toUpperCase().padStart(2, '0')}`;

      if (cmd.steps && cmd.steps.length > 0) {
        const rangeSteps = resolveRangeSteps(cmd, hexVal);
        if (rangeSteps && rangeSteps.length > 0) {
          return {
            entity: entityId,
            command: commandLabel,
            can_id: defaultCanId,
            bus: defaultBus,
            delay_ms: defaultDelayMs,
            steps: serializeActionSteps(rangeSteps, defaultCanId, defaultBus),
          };
        }
      }

      const payload = buildRangeActionPayload(hexVal, net);
      return {
        entity: entityId,
        command: commandLabel,
        can_id: defaultCanId,
        bus: defaultBus,
        delay_ms: defaultDelayMs,
        repeat: cmd.repeat ?? 1,
        payload,
      };
    }
  }

  return base;
}
