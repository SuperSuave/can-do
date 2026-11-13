/**
 * catalogUtils.ts
 * Shared utility for resolving catalog command variants to a specific vehicle.
 *
 * Usage:
 *   import { resolveVariant } from '../utils/catalogUtils';
 *   const resolved = resolveVariant(command, selectedVehicle);
 *   // resolved.network and resolved.options now reflect the correct variant.
 */

import { Command, CommandNetwork, CommandOption, Vehicle, ByteMap, Catalog } from '../types/catalog';

/**
 * Normalize a byte identifier (e.g. 'D2', 'd2', '2', 2) to canonical 1-based 'D1'..'D8'.
 */
export function normalizeByteKey(byteKey?: string | number | null): string {
  if (byteKey === undefined || byteKey === null) return 'D1';
  const s = String(byteKey).trim();
  const dMatch = s.match(/^D(\d+)$/i);
  if (dMatch) {
    const n = Math.max(1, Math.min(8, parseInt(dMatch[1], 10)));
    return `D${n}`;
  }
  if (/^\d+$/.test(s)) {
    const n = Math.max(1, Math.min(8, parseInt(s, 10)));
    return `D${n}`;
  }
  return s || 'D1';
}

/**
 * Determine whether a command represents a continuous/stepped numeric range without explicit discrete options.
 */
export function isRangeCommand(cmd?: Command | null): boolean {
  if (!cmd) return false;
  if (Array.isArray(cmd.options) && cmd.options.length > 0) return false;
  return Boolean(
    cmd.type === 'param_range' ||
    cmd.type === 'linear_scale' ||
    (cmd.network?.min !== undefined && cmd.network?.max !== undefined) ||
    cmd.network?.factor !== undefined
  );
}

function isPositiveCenteredOffset(net: CommandNetwork): boolean {
  return (
    net.min !== undefined &&
    net.min < 0 &&
    net.offset !== undefined &&
    net.offset > 0 &&
    net.min + net.offset >= 0
  );
}

/**
 * Convert raw byte integer to physical floating point representation based on catalog network schema.
 */
export function rawByteToPhysical(raw: number, net?: CommandNetwork): { val: number; unit: string } {
  if (!net) return { val: raw, unit: '' };
  const unit = net.unit || '';

  if (net.raw_min !== undefined && net.min !== undefined) {
    const rawMin = typeof net.raw_min === 'string' ? parseInt(net.raw_min, 16) || 0 : Number(net.raw_min);
    const step = net.step ?? net.factor ?? 1;
    const phys = net.min + (raw - rawMin) * step;
    return { val: phys, unit };
  }

  const factor = net.factor !== undefined ? net.factor : 1;
  if (isPositiveCenteredOffset(net)) {
    const phys = raw * factor - (net.offset ?? 0);
    return { val: phys, unit };
  }

  const offset = net.offset !== undefined ? net.offset : 0;
  const phys = raw * factor + offset;
  return { val: phys, unit };
}

/**
 * Convert physical representation back to integer raw byte for ESP32 CAN comparison/transmission.
 */
export function physicalToRawByte(phys: number, net?: CommandNetwork): number {
  if (!net) return Math.max(0, Math.min(255, Math.round(phys)));

  if (net.raw_min !== undefined && net.min !== undefined) {
    const rawMin = typeof net.raw_min === 'string' ? parseInt(net.raw_min, 16) || 0 : Number(net.raw_min);
    const step = net.step ?? net.factor ?? 1;
    const raw = Math.round(rawMin + (phys - net.min) / step);
    return Math.max(0, Math.min(255, raw));
  }

  const factor = net.factor !== undefined && net.factor !== 0 ? net.factor : 1;
  if (isPositiveCenteredOffset(net)) {
    const raw = Math.round((phys + (net.offset ?? 0)) / factor);
    return Math.max(0, Math.min(255, raw));
  }

  const offset = net.offset !== undefined ? net.offset : 0;
  const raw = Math.round((phys - offset) / factor);
  return Math.max(0, Math.min(255, raw));
}

/**
 * Compute a sensible default physical setpoint/threshold for a range command.
 */
export function getDefaultPhysicalValue(net?: CommandNetwork): number {
  if (!net) return 0;
  const min = net.min ?? 0;
  const max = net.max ?? 100;
  const step = net.step ?? 1;
  const unit = net.unit || '';

  if (unit === '°F' && min <= 70 && max >= 70) return 70;
  if (unit === '°C' && min <= 20 && max >= 20) return 20;
  if (min < 0 && max > 0) return 0;

  const rawMid = (min + max) / 2;
  const snapped = Math.round((rawMid - min) / step) * step + min;
  return Math.max(min, Math.min(max, Number(snapped.toFixed(4))));
}

/**
 * Build a 1-based ByteMap payload for a range TX action, merging network.base_payload when provided.
 */
export function buildRangeActionPayload(hexVal: string, net?: CommandNetwork): ByteMap {
  const actionByte = normalizeByteKey(net?.action_byte || net?.state_byte || net?.byte || 'D1');
  const normHex = `0x${parseInt(String(hexVal).replace(/^0x/i, ''), 16).toString(16).toUpperCase().padStart(2, '0')}`;
  const payloadObj: ByteMap = {};

  if (Array.isArray(net?.base_payload)) {
    net.base_payload.forEach((b, idx) => {
      if (idx < 8) {
        const parsed = typeof b === 'string' ? parseInt(b.replace(/^0x/i, ''), 16) : Number(b);
        const byteHex = isNaN(parsed) ? '0x00' : `0x${parsed.toString(16).toUpperCase().padStart(2, '0')}`;
        payloadObj[`D${idx + 1}`] = byteHex;
      }
    });
  }

  payloadObj[actionByte] = isNaN(parseInt(normHex, 16)) ? hexVal : normHex;
  return payloadObj;
}

/**
 * Resolve a param_range command's template `steps` (e.g. command burst + latch frame) for a
 * concrete raw byte. Any `{value}` placeholder (string payload token or ByteMap value) is
 * replaced with the 2-digit hex byte. Returns undefined when the command has no steps.
 */
export function resolveRangeSteps(cmd: Command, hexVal: string): any[] | undefined {
  if (!cmd.steps || cmd.steps.length === 0) return undefined;
  const byteHex = String(hexVal).replace(/^0x/i, '').toUpperCase().padStart(2, '0');
  const sub = (p: any): any => {
    if (typeof p === 'string') return p.replace(/\{value\}/gi, byteHex);
    if (p && typeof p === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(p)) {
        out[k] = typeof v === 'string' && v.trim().toLowerCase() === '{value}' ? `0x${byteHex}` : v;
      }
      return out;
    }
    return p;
  };
  const resolved = cmd.steps.map(s => (s.payload ? { ...s, payload: sub(s.payload) } : { ...s }));

  // No {value} placeholder anywhere: treat `steps` as follow-up frames (e.g. latch/commit) and
  // lead with the command frame built from network.base_payload + the range byte.
  const hasPlaceholder = JSON.stringify(cmd.steps).toLowerCase().includes('{value}');
  if (!hasPlaceholder) {
    const net = cmd.network;
    return [
      { payload: buildRangeActionPayload(hexVal, net), repeat: cmd.repeat ?? 3, delay_ms: net?.delay_ms ?? 25 },
      ...resolved
    ];
  }
  return resolved;
}

/**
 * Friendly display name mappings for common platform family slugs.
 */
const KNOWN_FAMILY_DISPLAY_NAMES: Record<string, string> = {
  all_egmp: 'All E-GMP',
  kia_ev6: 'EV6',
  hyundai_ioniq5: 'Ioniq 5',
  hyundai_ioniq6: 'Ioniq 6',
  genesis_gv60: 'GV60',
  kia_ev9: 'EV9',
  genesis_gv70: 'GV70',
  genesis_gv80: 'GV80',
  genesis_g80: 'G80',
};

/**
 * Format a platform family slug into a friendly human-readable name.
 * e.g. 'kia_ev6' -> 'EV6', 'hyundai_ioniq5' -> 'Ioniq 5', 'all_egmp' -> 'All E-GMP'.
 */
export function formatPlatformFamily(
  family: string | null | undefined,
  catalog?: { vehicles?: Vehicle[] } | null
): string {
  if (!family || family === 'all') return 'All Platform Families';

  // 1. Check known dictionary
  if (KNOWN_FAMILY_DISPLAY_NAMES[family]) {
    return KNOWN_FAMILY_DISPLAY_NAMES[family];
  }

  // 2. Check catalog vehicles for a clean model name matching this family
  if (catalog?.vehicles && Array.isArray(catalog.vehicles)) {
    const matching = catalog.vehicles.filter(v => v.family === family && v.family !== 'all_egmp');
    if (matching.length > 0) {
      const model = matching.find(v => Boolean(v.model))?.model;
      if (model) return model;
    }
  }

  // 3. Fallback heuristic: strip make prefixes (kia_, hyundai_, genesis_, etc.)
  const stripped = family.replace(/^(kia|hyundai|genesis|universal)_/i, '');

  // If it's an alphanumeric model code like ev6, gv60, g80, ev9, etc., uppercase it
  if (/^[a-z]{1,3}\d+[a-z]?$/i.test(stripped)) {
    return stripped.toUpperCase();
  }

  // Otherwise title-case words separated by underscores or dashes
  return stripped
    .split(/[_-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve a command's `variants` for the given vehicle, returning a new
 * command object with the matching variant's `network` and `options` merged in.
 *
 * - If the command has no `variants`, it is returned as-is (no allocation).
 * - Matching priority: vehicle.id first, then vehicle.family.
 * - If no variant matches, a console.warn is emitted once per
 *   (command.id, vehicle.id) pair and the first variant is used as a fallback.
 */

const _warnedVariants = new Set<string>();

export function resolveVariant(command: Command, vehicle: Vehicle | null | undefined): Command {
  const { variants } = command;
  if (!variants || variants.length === 0) return command;

  const vehicleId = vehicle?.id ?? '';
  const family = vehicle?.family ?? '';

  for (const variant of variants) {
    const targets = variant.targets ?? [];
    if (targets.includes(vehicleId) || (family && targets.includes(family))) {
      return {
        ...command,
        ...(variant.network !== undefined ? { network: variant.network } : {}),
        ...(variant.options !== undefined ? { options: variant.options } : {}),
      };
    }
  }

  // No match — warn once, then fall back to the first variant
  const warnKey = `${command.id}::${vehicleId}`;
  if (!_warnedVariants.has(warnKey)) {
    _warnedVariants.add(warnKey);
    console.warn(
      `[CAN Do] Command "${command.id}" has variants but none match vehicle ` +
      `"${vehicleId}" (family: "${family}"). Falling back to first variant as best-guess.`
    );
  }

  const fallback = variants[0];
  return {
    ...command,
    ...(fallback.network !== undefined ? { network: fallback.network } : {}),
    ...(fallback.options !== undefined ? { options: fallback.options } : {}),
  };
}

/**
 * Resolve variants for all commands in a list given a vehicle.
 * Convenience wrapper over resolveVariant() for bulk use.
 */
export function resolveAllVariants(commands: Command[], vehicle: Vehicle | null | undefined): Command[] {
  return commands.map(cmd => resolveVariant(cmd, vehicle));
}

// ---------------------------------------------------------------------------
// Linear scale option expansion
// ---------------------------------------------------------------------------

/**
 * Synthesize a full CommandOption[] for a `linear_scale` command by computing
 * every valid step from the `network` range metadata.
 *
 * Named options in `cmd.options` are overlaid on top of the generated list —
 * their label, default flag, popup, and mask are preserved.
 * Options with `evaluate` (range comparisons) are appended at the end so they
 * remain available as condition chips in the automation builder.
 *
 * If the command lacks range metadata, the original `cmd.options` are returned unchanged.
 */
export function expandLinearScaleOptions(cmd: Command): CommandOption[] {
  const net = cmd.network;
  if ((cmd.type !== 'linear_scale' && cmd.type !== 'param_range') || !net) {
    return cmd.options ?? [];
  }

  const rawMinStr = net.raw_min !== undefined ? String(net.raw_min) : undefined;
  const rawMaxStr = net.raw_max !== undefined ? String(net.raw_max) : undefined;
  const hasRawBounds = Boolean(rawMinStr && rawMaxStr);
  const hasPhysBounds = net.min !== undefined && net.max !== undefined;

  if (!hasRawBounds && !hasPhysBounds) {
    return cmd.options ?? [];
  }

  const unit: string = net.unit ?? '';
  const stateByte: string = normalizeByteKey(net.state_byte ?? net.byte ?? 'D1');
  const displayStep: number = net.step ?? 1;
  const generated: CommandOption[] = [];

  if (hasRawBounds) {
    const rawMin = parseInt(rawMinStr!.replace(/^0x/i, ''), 16);
    const rawMax = parseInt(rawMaxStr!.replace(/^0x/i, ''), 16);
    const displayMin: number = net.min ?? rawMin;

    for (let raw = rawMin; raw <= rawMax; raw++) {
      const display = displayMin + (raw - rawMin) * displayStep;
      const hexVal = `0x${raw.toString(16).toUpperCase().padStart(2, '0')}`;
      generated.push({
        label: `${display}${unit}`,
        match: { [stateByte]: hexVal },
        payload: buildRangeActionPayload(hexVal, net),
        mask: net.state_mask || net.mask || '0xFF',
      });
    }
  } else {
    const min = net.min!;
    const max = net.max!;
    for (let val = min; val <= max + 1e-9; val += displayStep) {
      const display = Number(val.toFixed(4));
      const raw = physicalToRawByte(display, net);
      const hexVal = `0x${raw.toString(16).toUpperCase().padStart(2, '0')}`;
      generated.push({
        label: `${display}${unit}`,
        match: { [stateByte]: hexVal },
        payload: buildRangeActionPayload(hexVal, net),
        mask: net.state_mask || net.mask || '0xFF',
      });
    }
  }

  // Collect evaluate-type named options to append at the end
  const evaluateOptions: CommandOption[] = [];

  // Overlay named catalog options: match/default/label/popup win
  for (const named of (cmd.options ?? [])) {
    if ((named as any).evaluate) {
      evaluateOptions.push(named);
      continue;
    }
    const matchHex = named.match
      ? String(Object.values(named.match)[0] ?? '').toLowerCase()
      : undefined;
    const idx = matchHex !== undefined
      ? generated.findIndex(g =>
          String(Object.values(g.match ?? {})[0] ?? '').toLowerCase() === matchHex)
      : -1;

    if (idx >= 0) {
      // Merge: named option wins on label, default, popup, mask
      generated[idx] = { ...generated[idx], ...named };
    } else {
      // Unmatched named option — append (e.g. out-of-range sentinel)
      generated.push(named);
    }
  }

  return [...generated, ...evaluateOptions];
}

/**
 * Get the effective options for a command, expanding linear_scale / param_range ranges
 * if applicable. This is the single entry point consumers should use
 * instead of reading `cmd.options` directly.
 */
export function getEffectiveOptions(cmd: Command): CommandOption[] {
  return (cmd.type === 'linear_scale' || cmd.type === 'param_range')
    ? expandLinearScaleOptions(cmd)
    : (cmd.options ?? []);
}

/**
  * Safely converts any space-separated or ByteMap payload into a strict D1..D8 ByteMap.
  */
export function cleanToByteMap(input: string | ByteMap | undefined): ByteMap {
  if (!input) return {};
  if (typeof input === 'object') {
    if ('hex' in input) {
      return { hex: String(input.hex).replace(/^0x/i, '').replace(/\s+/g, '').toUpperCase() };
    }
    const cleanMap: ByteMap = {};
    for (const [k, v] of Object.entries(input)) {
      if (v && typeof v === 'string' && v.trim().toLowerCase() === '{value}') {
        cleanMap[k] = '{value}';
      } else if (v && typeof v === 'string' && !v.includes('*') && v !== '?') {
        const cleanHex = v.replace(/^0x/i, '').trim().toUpperCase();
        cleanMap[k] = cleanHex ? `0x${cleanHex}` : v;
      }
    }
    return cleanMap;
  }

  const trimmed = input.trim();
  const noPrefix = trimmed.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{4,16}$/.test(noPrefix) && noPrefix.length % 2 === 0 && !trimmed.includes(' ')) {
    const hexResult: ByteMap = {};
    for (let i = 0; i < noPrefix.length && i < 16; i += 2) {
      const byteIdx = Math.floor(i / 2) + 1;
      hexResult[`D${byteIdx}`] = `0x${noPrefix.slice(i, i + 2).toUpperCase()}`;
    }
    return hexResult;
  }

  const parts = trimmed.split(/\s+/);
  const result: ByteMap = {};

  parts.forEach((part, idx) => {
    if (idx >= 8) return;
    const dKey = `D${idx + 1}`;
    const clean = part.trim();
    if (clean.toLowerCase() === '{value}') {
      result[dKey] = '{value}';
      return;
    }
    if (!clean || clean === '*' || clean === '**' || clean === '??') return;

    const hexClean = clean.replace(/\*/g, '0');
    if (hexClean) {
      const cleanHex = hexClean.replace(/^0x/i, '').trim().toUpperCase();
      result[dKey] = cleanHex ? `0x${cleanHex}` : hexClean;
    }
  });

  return result;
}

/**
 * Cleanly formats a Command into the standard production catalog schema (can_do_catalog.json).
 *
 * Ensures:
 * - Proper nested `network` configuration with bus, type, state_can_id, action_can_id
 * - Proper nested `ha_metadata` configuration (name, domain, icon)
 * - Strict 1-based ByteMap representation ({ "D1": "0x.." }) for all match and payload fields
 * - Completely strips deprecated legacy fields: from_payload, to_payload, match_payload, wildcard strings
 * - Cleans option definitions and steps to native ByteMaps
 */
export function formatCommandForCatalog(cmd: Command): Command {
  const name = cmd.ha_metadata?.name || cmd.name || cmd.id;
  const isAction = cmd.roles.includes('action') && !cmd.roles.includes('trigger');
  const defaultDomain = isAction ? 'button' : 'sensor';
  const domain = cmd.ha_metadata?.domain || cmd.ha_domain || defaultDomain;
  const iconRaw = cmd.ha_metadata?.icon || cmd.icon || cmd.mdi || 'mdi:car-info';
  const icon = iconRaw.startsWith('mdi:') ? iconRaw : `mdi:${iconRaw}`;

  const ha_metadata = {
    name,
    domain,
    icon
  };

  const bus = cmd.network?.bus ?? cmd.bus ?? 0;
  const stateCanId = cmd.network?.state_can_id || cmd.state_can_id;
  const actionCanId = cmd.network?.action_can_id || cmd.action_can_id;
  const delayMs = cmd.network?.delay_ms ?? cmd.delay_ms;
  const netType = cmd.network?.type || (actionCanId && !stateCanId ? 'can_tx' : 'can_rx');

  const network: any = {
    bus,
    type: netType,
    ...(stateCanId ? { state_can_id: stateCanId } : {}),
    ...(actionCanId ? { action_can_id: actionCanId } : {}),
    ...(cmd.network?.byte ? { byte: cmd.network.byte } : {}),
    ...(cmd.network?.state_byte ? { state_byte: cmd.network.state_byte } : {}),
    ...(cmd.network?.action_byte ? { action_byte: cmd.network.action_byte } : {}),
    ...(cmd.network?.mask ? { mask: cmd.network.mask } : {}),
    ...(cmd.network?.state_mask ? { state_mask: cmd.network.state_mask } : {}),
    ...(cmd.network?.action_mask ? { action_mask: cmd.network.action_mask } : {}),
    ...(cmd.network?.min !== undefined ? { min: cmd.network.min } : {}),
    ...(cmd.network?.max !== undefined ? { max: cmd.network.max } : {}),
    ...(cmd.network?.step !== undefined ? { step: cmd.network.step } : {}),
    ...(cmd.network?.factor !== undefined ? { factor: cmd.network.factor } : {}),
    ...(cmd.network?.offset !== undefined ? { offset: cmd.network.offset } : {}),
    ...(cmd.network?.unit !== undefined ? { unit: cmd.network.unit } : {}),
    ...(cmd.network?.raw_min !== undefined ? { raw_min: cmd.network.raw_min } : {}),
    ...(cmd.network?.raw_max !== undefined ? { raw_max: cmd.network.raw_max } : {}),
    ...(Array.isArray(cmd.network?.base_payload) ? { base_payload: cmd.network.base_payload } : {}),
    ...(delayMs !== undefined ? { delay_ms: delayMs } : {})
  };

  // Convert root match from match or match_payload / to_payload
  let cleanMatch: ByteMap | undefined = undefined;
  if (cmd.match && typeof cmd.match === 'object') {
    cleanMatch = cleanToByteMap(cmd.match);
  }
  if (!cleanMatch || Object.keys(cleanMatch).length === 0) {
    if (cmd.match_payload || cmd.to_payload) {
      cleanMatch = cleanToByteMap(cmd.match_payload || cmd.to_payload);
    }
  }
  if (cleanMatch && Object.keys(cleanMatch).length === 0) {
    cleanMatch = undefined;
  }

  // Convert root payload from payload or to_payload
  let cleanPayload: ByteMap | undefined = undefined;
  if (cmd.payload && typeof cmd.payload === 'object') {
    cleanPayload = cleanToByteMap(cmd.payload);
  } else if (cmd.to_payload) {
    cleanPayload = cleanToByteMap(cmd.to_payload);
  }
  if (cleanPayload && Object.keys(cleanPayload).length === 0) {
    cleanPayload = undefined;
  }

  // Convert root steps
  let cleanSteps: any[] | undefined = undefined;
  if (cmd.steps && cmd.steps.length > 0) {
    cleanSteps = cmd.steps.map(st => {
      const isDelay = st.type === 'delay';
      return {
        ...(st.type ? { type: st.type } : {}),
        ...(!isDelay && st.payload ? { payload: cleanToByteMap(st.payload) } : {}),
        ...(st.repeat && st.repeat > 1 ? { repeat: st.repeat } : {}),
        ...((st as any).can_id ? { can_id: (st as any).can_id } : {}),
        ...((st as any).action_can_id ? { can_id: (st as any).action_can_id } : {}),
        ...((st as any).delay_ms !== undefined ? { delay_ms: (st as any).delay_ms } : {}),
        ...((st as any).dwell_ms !== undefined ? { dwell_ms: (st as any).dwell_ms } : {}),
        ...((st as any).ms !== undefined ? { ms: (st as any).ms } : {}),
        ...((st as any).bus !== undefined ? { bus: (st as any).bus } : {})
      };
    });
  }

  // Derive mask
  let mask = cmd.mask;
  if (!mask && cmd.from_payload && cmd.to_payload) {
    const toTokens = cmd.to_payload.trim().split(/\s+/);
    for (const t of toTokens) {
      if (t.endsWith('*')) mask = '0xF0';
      else if (t.startsWith('*') && t.length === 2) mask = '0x0F';
    }
    if (!mask) mask = '0xFF';
  } else if (!mask && cleanMatch) {
    mask = '0xFF';
  }

  // Format options
  let formattedOptions: CommandOption[] | undefined = undefined;
  if (cmd.options && cmd.options.length > 0) {
    formattedOptions = cmd.options.map(opt => {
      const optClean: CommandOption = {
        label: opt.label
      };
      if (opt.popup || opt.popup_message) {
        optClean.popup = opt.popup || opt.popup_message;
      }
      if (opt.requires_feature) {
        optClean.requires_feature = opt.requires_feature;
      }

      // Option match
      let optMatch: ByteMap | undefined = undefined;
      if (opt.match && typeof opt.match === 'object') {
        optMatch = cleanToByteMap(opt.match);
      } else if (opt.match_payload) {
        optMatch = cleanToByteMap(opt.match_payload);
      }
      if (optMatch && Object.keys(optMatch).length > 0) {
        optClean.match = optMatch;
      }

      // Option payload / steps
      if (opt.steps && opt.steps.length > 0) {
        optClean.steps = opt.steps.map(st => {
          const isDelay = st.type === 'delay';
          return {
            ...(st.type ? { type: st.type } : {}),
            ...(!isDelay && st.payload ? { payload: cleanToByteMap(st.payload) } : {}),
            ...(st.repeat && st.repeat > 1 ? { repeat: st.repeat } : {}),
            ...((st as any).can_id ? { can_id: (st as any).can_id } : {}),
            ...((st as any).action_can_id ? { can_id: (st as any).action_can_id } : {}),
            ...((st as any).delay_ms !== undefined ? { delay_ms: (st as any).delay_ms } : {}),
            ...((st as any).dwell_ms !== undefined ? { dwell_ms: (st as any).dwell_ms } : {}),
            ...((st as any).ms !== undefined ? { ms: (st as any).ms } : {}),
            ...((st as any).bus !== undefined ? { bus: (st as any).bus } : {})
          };
        });
      } else {
        let optPayload: ByteMap | undefined = undefined;
        if (opt.payload) {
          optPayload = cleanToByteMap(opt.payload);
        } else if (opt.to_payload) {
          optPayload = cleanToByteMap(opt.to_payload);
        }
        if (optPayload && Object.keys(optPayload).length > 0) {
          optClean.payload = optPayload;
        }
      }

      if (opt.mask) {
        optClean.mask = opt.mask;
      }
      if (opt.default) {
        optClean.default = true;
      }

      return optClean;
    });
  }

  // Format variants
  let formattedVariants: any[] | undefined = undefined;
  if (cmd.variants && cmd.variants.length > 0) {
    formattedVariants = cmd.variants.map(v => ({
      targets: v.targets,
      ...(v.network ? { network: v.network } : {}),
      ...(v.options ? {
        options: v.options.map(opt => {
          const optClean: any = { label: opt.label };
          if (opt.match) optClean.match = cleanToByteMap(opt.match);
          if (opt.payload) optClean.payload = cleanToByteMap(opt.payload);
          if (opt.mask) optClean.mask = opt.mask;
          if (opt.default) optClean.default = true;
          if (opt.steps) {
            optClean.steps = opt.steps.map(s => {
              const isDelay = s.type === 'delay';
              return {
                ...(s.type ? { type: s.type } : {}),
                ...(!isDelay && s.payload ? { payload: cleanToByteMap(s.payload) } : {}),
                ...(s.repeat && s.repeat > 1 ? { repeat: s.repeat } : {}),
                ...((s as any).can_id ? { can_id: (s as any).can_id } : {}),
                ...((s as any).action_can_id ? { can_id: (s as any).action_can_id } : {}),
                ...((s as any).delay_ms !== undefined ? { delay_ms: (s as any).delay_ms } : {}),
                ...((s as any).dwell_ms !== undefined ? { dwell_ms: (s as any).dwell_ms } : {}),
                ...((s as any).ms !== undefined ? { ms: (s as any).ms } : {}),
                ...((s as any).bus !== undefined ? { bus: (s as any).bus } : {})
              };
            });
          }
          return optClean;
        })
      } : {})
    }));
  }

  const result: any = {
    id: cmd.id,
    ha_metadata,
    ...(cmd.type ? { type: cmd.type } : {}),
    tags: cmd.tags && cmd.tags.length > 0 ? cmd.tags : ['all_egmp'],
    category: cmd.category,
    ...(cmd.subcategory ? { subcategory: cmd.subcategory } : {}),
    roles: cmd.roles,
    network,
    ...(cleanMatch ? { match: cleanMatch } : {}),
    ...(cleanPayload ? { payload: cleanPayload } : {}),
    ...(cleanSteps ? { steps: cleanSteps } : {}),
    ...(cmd.repeat && cmd.repeat > 1 ? { repeat: cmd.repeat } : {}),
    ...(mask ? { mask } : {}),
    ...(formattedOptions ? { options: formattedOptions } : {}),
    ...(formattedVariants ? { variants: formattedVariants } : {}),
    contributor: cmd.contributor || (cmd.contributors && cmd.contributors[0]) || { name: 'Community', github: '' }
  };

  return result as Command;
}
