/**
 * catalogUtils.ts
 * Shared utility for resolving catalog command variants to a specific vehicle.
 *
 * Usage:
 *   import { resolveVariant } from '../utils/catalogUtils';
 *   const resolved = resolveVariant(command, selectedVehicle);
 *   // resolved.network and resolved.options now reflect the correct variant.
 */

import { Command, CommandOption, Vehicle } from '../types/catalog';

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
      ? (Object.values(named.match)[0] as string)?.toLowerCase()
      : undefined;
    const idx = matchHex !== undefined
      ? generated.findIndex(g =>
          (Object.values(g.match ?? {})[0] as string)?.toLowerCase() === matchHex)
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
