/**
 * catalogUtils.ts
 * Shared utility for resolving catalog command variants to a specific vehicle.
 *
 * Usage:
 *   import { resolveVariant } from '../utils/catalogUtils';
 *   const resolved = resolveVariant(command, selectedVehicle);
 *   // resolved.network and resolved.options now reflect the correct variant.
 */

import { Command, CommandOption, Vehicle, ByteMap } from '../types/catalog';

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
 * If the command is not `type: "linear_scale"` or lacks range metadata, the
 * original `cmd.options` are returned unchanged.
 */
export function expandLinearScaleOptions(cmd: Command): CommandOption[] {
  const net = cmd.network;
  if (cmd.type !== 'linear_scale' || !net) {
    return cmd.options ?? [];
  }

  const rawMinStr = (net as any).raw_min as string | undefined;
  const rawMaxStr = (net as any).raw_max as string | undefined;

  // Need at least raw_min and raw_max to generate the sequence
  if (!rawMinStr || !rawMaxStr) {
    return cmd.options ?? [];
  }

  const rawMin = parseInt(rawMinStr.replace('0x', ''), 16);
  const rawMax = parseInt(rawMaxStr.replace('0x', ''), 16);
  const displayMin: number = (net as any).min ?? rawMin;
  const displayStep: number = (net as any).step ?? 1;
  const unit: string = (net as any).unit ?? '';
  const stateByte: string = (net as any).state_byte ?? (net as any).byte ?? 'D1';
  const actionByte: string = (net as any).action_byte ?? stateByte;

  // Generate one option per raw step value
  const generated: CommandOption[] = [];
  for (let raw = rawMin; raw <= rawMax; raw++) {
    const display = displayMin + (raw - rawMin) * displayStep;
    const hexVal = `0x${raw.toString(16).toUpperCase().padStart(2, '0')}`;
    generated.push({
      label: `${display}${unit}`,
      match: { [stateByte]: hexVal },
      payload: { [actionByte]: hexVal },
      mask: '0xFF',
    });
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
 * Get the effective options for a command, expanding linear_scale ranges
 * if applicable. This is the single entry point consumers should use
 * instead of reading `cmd.options` directly.
 */
export function getEffectiveOptions(cmd: Command): CommandOption[] {
  return cmd.type === 'linear_scale'
    ? expandLinearScaleOptions(cmd)
    : (cmd.options ?? []);
}

/**
  * Safely converts any space-separated or ByteMap payload into a strict D1..D8 ByteMap.
  */
export function cleanToByteMap(input: string | ByteMap | undefined): ByteMap {
  if (!input) return {};
  if (typeof input === 'object') {
    const cleanMap: ByteMap = {};
    for (const [k, v] of Object.entries(input)) {
      if (v && typeof v === 'string' && !v.includes('*') && v !== '?') {
        cleanMap[k] = v.startsWith('0x') || v.startsWith('0X') ? v : `0x${v.toUpperCase()}`;
      }
    }
    return cleanMap;
  }

  const parts = input.trim().split(/\s+/);
  const result: ByteMap = {};

  parts.forEach((part, idx) => {
    if (idx >= 8) return;
    const dKey = `D${idx + 1}`;
    const clean = part.trim();
    if (!clean || clean === '*' || clean === '**' || clean === '??') return;

    const hexClean = clean.replace(/\*/g, '0');
    if (hexClean) {
      const val = hexClean.startsWith('0x') || hexClean.startsWith('0X') ? hexClean : `0x${hexClean.toUpperCase()}`;
      result[dKey] = val;
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
    cleanSteps = cmd.steps.map(st => ({
      payload: cleanToByteMap(st.payload),
      ...(st.repeat && st.repeat > 1 ? { repeat: st.repeat } : {}),
      ...((st as any).can_id ? { can_id: (st as any).can_id } : {}),
      ...((st as any).bus !== undefined ? { bus: (st as any).bus } : {})
    }));
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
        optClean.steps = opt.steps.map(st => ({
          payload: cleanToByteMap(st.payload),
          ...(st.repeat && st.repeat > 1 ? { repeat: st.repeat } : {})
        }));
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
            optClean.steps = opt.steps.map(s => ({
              payload: cleanToByteMap(s.payload),
              ...(s.repeat && s.repeat > 1 ? { repeat: s.repeat } : {})
            }));
          }
          return optClean;
        })
      } : {})
    }));
  }

  const result: any = {
    id: cmd.id,
    ha_metadata,
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
