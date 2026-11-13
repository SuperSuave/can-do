import {
  AutomationRule,
  AutomationSettings,
  CandoRulesExport,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  AutomationActionStep,
  ChoiceBranch
} from '../types/automation';
import { Command, CommandOption, Catalog, ByteMap, Vehicle } from '../types/catalog';
import { DEFAULT_CATALOG } from '../data/defaultCatalog';
import {
  resolveVariant,
  getEffectiveOptions,
  isRangeCommand,
  rawByteToPhysical,
  physicalToRawByte,
  getDefaultPhysicalValue,
  buildRangeActionPayload,
  resolveRangeSteps,  normalizeByteKey
} from './catalogUtils';

/**
 * Converts any numeric integer or hex/decimal string into canonical 2-digit uppercase hex (e.g. "0xFF", "0x00", "0x3F").
 * Returns undefined for wildcards, empty values, or invalid inputs.
 */
export function formatHexByte(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') {
    if (isNaN(val)) return undefined;
    return `0x${(val & 0xFF).toString(16).padStart(2, '0').toUpperCase()}`;
  }
  const str = String(val).trim();
  if (!str || str === '*' || str === '**' || str === '?' || str === '??') return undefined;

  // Hex prefixed with 0x / 0X
  if (/^0x/i.test(str)) {
    const raw = str.slice(2).trim();
    if (!raw) return undefined;
    const num = parseInt(raw, 16);
    if (isNaN(num)) return undefined;
    return `0x${(num & 0xFF).toString(16).padStart(2, '0').toUpperCase()}`;
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
 * Cleanly compiles any payload, ByteMap, or string into a strict 1-based ByteMap ({ D1: "0x.." }).
 * Supports both hex ("0xFF", "3F") and numeric decimal integers (255, 63, 0) seamlessly.
 */
export function compileToByteMap(input: string | ByteMap | Record<string, unknown> | undefined): ByteMap {
  if (!input) return {};

  if (typeof input === 'object') {
    const cleanMap: ByteMap = {};
    for (const [k, v] of Object.entries(input)) {
      const match = k.match(/^D?([1-8])$/i);
      if (!match) continue;
      const dKey = `D${match[1]}`;
      const formatted = formatHexByte(v);
      if (formatted !== undefined) {
        cleanMap[dKey] = formatted;
      }
    }
    return cleanMap;
  }

  const trimmed = String(input).trim();
  if (!trimmed) return {};

  // If string starts with JSON object, parse it
  if (trimmed.startsWith('{')) {
    try {
      const parsedObj = JSON.parse(trimmed);
      if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
        return compileToByteMap(parsedObj);
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
    const formatted = formatHexByte(hexClean);
    if (formatted !== undefined) {
      result[dKey] = formatted;
    }
  });

  return result;
}

function pickSustainedFields(node: { for_sec?: number; for_ms?: number }): { for_sec?: number; for_ms?: number } {
  return {
    ...(node.for_ms ? { for_ms: node.for_ms } : {}),
    ...(node.for_sec ? { for_sec: node.for_sec } : {})
  };
}

/**
 * Compiles a condition into standard CAN Do schema
 */
export function compileCondition(cond: AutomationCondition, catalog: Catalog = DEFAULT_CATALOG): any {
  const sustained = pickSustainedFields(cond);
  if (cond.logic === 'and' || cond.logic === 'or' || cond.logic === 'not') {
    const subConds = (cond.conditions || []).map(c => compileCondition(c, catalog));
    if (cond.logic === 'and') return { and: subConds, ...sustained };
    if (cond.logic === 'or') return { or: subConds, ...sustained };
    if (cond.logic === 'not') return { not: subConds[0] || {}, ...sustained };
  }

  // Multi-option state check: if multiple options on the same entity touch the same byte, desugar to OR group
  if (cond.source_command_id && cond.selected_options && cond.selected_options.length > 1) {
    const cmd = catalog.commands?.find(c => c.id === cond.source_command_id);
    if (cmd && cmd.options) {
      const matchedOpts = cmd.options.filter(o => cond.selected_options!.some(sel => sel.toLowerCase() === o.label.toLowerCase()));
      if (matchedOpts.length > 1) {
        const byteMapSeen: Record<string, string> = {};
        let hasConflict = false;
        for (const opt of matchedOpts) {
          const m = compileToByteMap(opt.match || opt.payload);
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
          const subConds = matchedOpts.map(opt => compileCondition(commandToCondition(cmd, opt), catalog));
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
      days: cond.days && cond.days.length > 0 ? cond.days : ['mon', 'tue', 'wed', 'thu', 'fri']
    };
  }

  if (cond.type === 'device_state' || cond.type === 'wifi' || cond.type === 'wifi_condition') {
    return {
      type: 'device_state',
      device_property: cond.device_property || 'wifi_ssid',
      ...(cond.target_string ? { target_string: cond.target_string } : {}),
      ...(cond.operator ? { operator: cond.operator } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(cond.target_rssi !== undefined ? { target_rssi: cond.target_rssi } : {}),
      ...sustained
    };
  }

  if (cond.type === 'ble_button' || cond.type === 'ble_key' || cond.type === 'ble') {
    return {
      type: 'ble_button',
      ble_button: cond.ble_button || cond.target_string || 'volume_up',
      ble_action: cond.ble_action || 'press',
      ...(cond.ble_device ? { ble_device: cond.ble_device } : {})
    };
  }

  if (
    cond.type === 'ble_beacon' ||
    cond.type === 'beacon' ||
    (cond.type === 'ble_presence' &&
      (cond.beacon_uuid ||
        cond.device_property === 'beacon_present' ||
        cond.device_property === 'present' ||
        cond.device_property === 'away'))
  ) {
    return {
      type: 'ble_beacon',
      device_property: cond.device_property || (cond.target_bool === false ? 'away' : 'present'),
      ...(cond.beacon_uuid ? { beacon_uuid: cond.beacon_uuid } : {}),
      ...(cond.beacon_major ? { beacon_major: cond.beacon_major } : {}),
      ...(cond.beacon_minor ? { beacon_minor: cond.beacon_minor } : {}),
      ...(cond.ble_device ? { ble_device: cond.ble_device } : {}),
      ...(cond.target_string ? { target_string: cond.target_string } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(cond.target_rssi !== undefined ? { target_rssi: cond.target_rssi } : {}),
      ...(cond.operator ? { operator: cond.operator } : {}),
      ...sustained
    };
  }

  if (cond.type === 'ble_device' || cond.type === 'ble_presence') {
    return {
      type: 'ble_device',
      device_property: cond.device_property || 'connected',
      ...(cond.ble_device ? { ble_device: cond.ble_device } : {}),
      ...(cond.target_string ? { target_string: cond.target_string } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(cond.target_rssi !== undefined ? { target_rssi: cond.target_rssi } : {}),
      ...(cond.operator ? { operator: cond.operator } : {}),
      ...sustained
    };
  }

  if (cond.type === 'voltage') {
    const rawVal = cond.value || cond.voltage_val || '12.4';
    const numVal = parseFloat(String(rawVal)) || 12.4;
    return {
      type: 'voltage',
      operator: cond.operator || (cond.voltage_dir === 'below' ? 'less' : 'greater'),
      value: numVal,
      ...sustained
    };
  }

  const match = compileToByteMap(cond.match || (cond as any).evaluate?.match || (cond as any).payload || cond.match_payload);
  const op = cond.operator || cond.evaluate?.operator || (cond.invert ? 'not_equal' : 'equal');

  if (Object.keys(match).length > 1) {
    let fullMask: any = cond.mask || cond.evaluate?.mask;
    if (typeof fullMask !== 'object' || fullMask === null) {
      const defaultM = typeof fullMask === 'string' ? fullMask : '0xFF';
      const mObj: Record<string, string> = {};
      Object.keys(match).forEach(k => { mObj[k] = defaultM; });
      fullMask = mObj;
    }
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

  const dKey = cond.byte || cond.evaluate?.byte || Object.keys(match)[0] || 'D1';
  const targetVal = cond.value || cond.evaluate?.value || match[dKey] || '0x01';
  const maskVal = typeof cond.mask === 'object' && cond.mask !== null
    ? (cond.mask as any)[dKey] || '0xFF'
    : (cond.mask || cond.evaluate?.mask || '0xFF');

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

/**
 * Compiles an AutomationAction into an inlined transmit sequence, delay, if_then, choose, popup, or climate target
 */
export function compileAction(act: AutomationAction, catalog: Catalog = DEFAULT_CATALOG): any | any[] {
  if (act.type === 'if_then') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'if_then',
      conditions: (act.conditions || []).map(c => compileCondition(c, catalog)),
      then: compileActionList(act.then || [], catalog),
      else: compileActionList(act.else || [], catalog)
    };
  }

  if (act.type === 'choose') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'choose',
      choices: (act.choices || []).map(c => ({
        ...(c.label ? { label: c.label } : {}),
        conditions: (c.conditions || []).map(cond => compileCondition(cond, catalog)),
        sequence: compileActionList(c.sequence || [], catalog)
      })),
      default: compileActionList(act.default || [], catalog)
    };
  }

  if (act.type === 'repeat_until' || act.type === 'wait_for') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: act.type,
      interval_ms: act.interval_ms || 1000,
      timeout_ms: act.timeout_ms || 30000,
      condition: act.condition ? compileCondition(act.condition, catalog) : undefined,
      sequence: act.sequence ? compileActionList(act.sequence, catalog) : undefined
    };
  }

  if (act.type === 'delay') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'delay',
      ms: act.delay_ms || act.ms || 500
    };
  }

  if (act.type === 'track_popup' || act.type === 'popup') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'track_popup',
      level: act.level || 'info',
      text: act.text || act.popup_message || ''
    };
  }

  if (act.type === 'climate_target' || act.type === 'remote_climate') {
    const tempC = act.target_temp_c ?? act.target_c ?? 22.0;
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'climate_target',
      target_temp_c: tempC,
      defrost: !!act.defrost,
      duration_minutes: act.duration_minutes || 15,
      zone: act.zone || 'driver'
    };
  }

  if (act.type === 'cycle_entity') {
    const entId = act.entity_id || act.target_command_id || 'seat_heater_driver';
    const cmd = catalog.commands?.find(c => c.id === entId || c.entity_id === entId);
    const states = act.states && act.states.length > 0 ? act.states : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
    const isReverse = act.direction === 'reverse';
    const wrap = act.wrap !== false;

    const choices = states.map((state, idx) => {
      let nextIdx = isReverse ? idx - 1 : idx + 1;
      if (nextIdx >= states.length) nextIdx = wrap ? 0 : states.length - 1;
      if (nextIdx < 0) nextIdx = wrap ? states.length - 1 : 0;
      const nextState = states[nextIdx];

      const curOpt = cmd?.options?.find(o => o.label.toLowerCase() === state.toLowerCase() || o.id === state);
      const nextOpt = cmd?.options?.find(o => o.label.toLowerCase() === nextState.toLowerCase() || o.id === nextState);

      const cond: AutomationCondition = cmd && curOpt ? commandToCondition(cmd, curOpt) : {
        id: `cond_cycle_${idx}`,
        type: 'can_state',
        can_id: act.can_id || '0x000',
        bus: act.bus ?? 0,
        value: state
      };

      const seqActs: any[] = [];
      if (cmd && nextOpt) {
        seqActs.push(commandToAction(cmd, nextOpt));
      } else if (act.can_id) {
        seqActs.push({
          type: 'transmit',
          can_id: act.can_id,
          bus: act.bus ?? 0,
          payload: { D1: '0x01' },
          repeat: 1
        });
      }

      if (act.show_popup !== false) {
        seqActs.push({
          type: 'track_popup',
          level: 'info',
          text: `${act.popup_prefix !== undefined ? act.popup_prefix : 'Driver Seat: '}${nextOpt?.label || nextState}`
        });
      }

      return {
        conditions: [compileCondition(cond, catalog)],
        sequence: compileActionList(seqActs, catalog)
      };
    });

    const fallbackState = act.fallback_state || states[0];
    const fallbackOpt = cmd?.options?.find(o => o.label.toLowerCase() === fallbackState.toLowerCase() || o.id === fallbackState);
    const defaultActs: any[] = [];
    if (cmd && fallbackOpt) {
      defaultActs.push(commandToAction(cmd, fallbackOpt));
    }
    if (act.show_popup !== false) {
      defaultActs.push({
        type: 'track_popup',
        level: 'info',
        text: `${act.popup_prefix !== undefined ? act.popup_prefix : 'Driver Seat: '}${fallbackOpt?.label || fallbackState}`
      });
    }

    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'choose',
      choices,
      default: compileActionList(defaultActs, catalog),
      _cycle_entity: {
        ...(act.id ? { id: act.id } : {}),
        entity_id: entId,
        ...(act.target_command_id ? { target_command_id: act.target_command_id } : {}),
        states,
        ...(act.direction ? { direction: act.direction } : {}),
        wrap,
        ...(act.fallback_state ? { fallback_state: act.fallback_state } : {}),
        show_popup: act.show_popup !== false,
        ...(act.popup_prefix !== undefined ? { popup_prefix: act.popup_prefix } : {})
      }
    };
  }

  if (act.type === 'precondition') {
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'precondition',
      mode: act.precon_mode || 'persistent',
      action: act.precon_action || (act.precon_mode === 'cancel' ? 'stop' : 'start')
    };
  }

  // Helper to resolve dual-tone door payload (0x48F) for ambient_mood_lighting presets
  const getAmbientDoorPayload = (label: string | undefined, dashPayload: ByteMap): ByteMap => {
    const l = (label || '').toLowerCase();
    if (l.includes('christmas') || l.includes('xmas')) {
      return compileToByteMap('7AC2081500000000'); // Lime Green Doors
    }
    if (l.includes('halloween')) {
      return compileToByteMap('6703D51300000000'); // Deep Purple Doors
    }
    if (l.includes('valentine')) {
      return compileToByteMap('EB02371700000000'); // Crimson Red Doors
    }
    if (l.includes('4th') || l.includes('fourth') || l.includes('july') || l.includes('patriotic')) {
      return compileToByteMap('1E02861700000000'); // Electric Blue Doors
    }
    return dashPayload;
  };

  // Handle explicit transmit or raw can_tx: inline multiple steps if defined, or return single transmit frame
  if (act.type === 'transmit' || act.type === 'can_tx') {
    const isAmbient = (act.entity_id || act.source_command_id) === 'ambient_mood_lighting' || formatCanId(act.can_id) === '0x4AD';
    const resolvedForFallback = catalog ? resolveCatalogCommandForAction(act, catalog) : {};
    const fallbackOptSteps = resolvedForFallback.matchedOption?.steps;
    const fallbackCmd = resolvedForFallback.command;
    const fallbackOpt = resolvedForFallback.matchedOption;

    // If act has no explicit steps yet, but resolves to a catalog option with multi-step burst, use those steps
    const effectiveSteps =
      act.steps && act.steps.length > 1
        ? act.steps
        : !act.steps && fallbackOptSteps && fallbackOptSteps.length > 1
          ? fallbackOptSteps
          : undefined;

    if (effectiveSteps && effectiveSteps.length > 1) {
      const stepGroupId = act.id || generateBlockId('grp');
      const inlinedSteps: any[] = [];
      const defaultDelayMs = fallbackCmd?.network?.delay_ms ?? fallbackCmd?.delay_ms ?? act.delay_ms ?? 20;

      effectiveSteps.forEach((step: any, idx: number) => {
        if (step.type === 'delay') {
          inlinedSteps.push({
            type: 'delay',
            ms: step.delay_ms || step.dwell_ms || step.ms || 500,
            _step_group_id: stepGroupId
          });
          return;
        }
        if (step.type === 'repeat_until' || step.type === 'wait_for') {
          inlinedSteps.push({
            type: step.type,
            interval_ms: step.interval_ms || 1000,
            timeout_ms: step.timeout_ms || 30000,
            condition: step.condition ? compileCondition(step.condition, catalog) : undefined,
            sequence: step.sequence ? compileActionList(step.sequence, catalog) : undefined,
            _step_group_id: stepGroupId
          });
          return;
        }
        let stepPayload = compileToByteMap(step.payload);
        if (Object.keys(stepPayload).length === 0 && fallbackOptSteps && fallbackOptSteps[idx]?.payload) {
          stepPayload = compileToByteMap(fallbackOptSteps[idx].payload);
        }
        const resolvedSourceId = act.source_command_id || act.entity_id || fallbackCmd?.id;
        const resolvedSourceName = act.source_command_name || fallbackCmd?.ha_metadata?.name || fallbackCmd?.name;
        const resolvedOptLabel = act.option_label || act.command || fallbackOpt?.label;
        inlinedSteps.push({
          type: 'transmit',
          can_id: formatCanId(step.can_id || act.can_id || fallbackCmd?.network?.action_can_id || fallbackCmd?.action_can_id || '0x000'),
          bus: step.bus ?? act.bus ?? fallbackCmd?.network?.bus ?? 0,
          payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
          repeat: step.repeat ?? act.repeat ?? 1,
          _step_group_id: stepGroupId,
          ...(idx === 0 ? {
            ...(resolvedSourceId ? { source_command_id: resolvedSourceId } : {}),
            ...(resolvedSourceName ? { source_command_name: resolvedSourceName } : {}),
            ...(resolvedOptLabel ? { option_label: resolvedOptLabel } : {}),
            ...(resolvedSourceId ? { entity_id: resolvedSourceId } : {})
          } : {})
        });
        const delayBetween = (step.delay_ms !== undefined && step.delay_ms > 0) ? step.delay_ms : defaultDelayMs;
        if (idx < effectiveSteps.length - 1 && delayBetween > 0) {
          inlinedSteps.push({
            type: 'delay',
            ms: delayBetween,
            _step_group_id: stepGroupId
          });
        }
      });

      // If this is a 2-step 0x4AD ambient mood lighting sequence without 0x48F, also append the 0x48F door zone burst
      const has48F = inlinedSteps.some(s => s.type === 'transmit' && formatCanId(s.can_id) === '0x48F');
      if (isAmbient && !has48F && inlinedSteps.length >= 2 && inlinedSteps[0]?.type === 'transmit') {
        const dashStage1 = inlinedSteps[0].payload;
        const doorStage1 = getAmbientDoorPayload(act.option_label || act.command || resolvedForFallback.matchedOption?.label, dashStage1);
        const latchCommit = compileToByteMap('0002082000000000');
        const busVal = act.bus ?? 0;
        inlinedSteps.push(
          { type: 'delay', ms: 25, _step_group_id: stepGroupId, _auto_ambient_48f: true },
          { type: 'transmit', can_id: '0x48F', bus: busVal, payload: doorStage1, repeat: 2, _step_group_id: stepGroupId, _auto_ambient_48f: true },
          { type: 'delay', ms: 25, _step_group_id: stepGroupId, _auto_ambient_48f: true },
          { type: 'transmit', can_id: '0x48F', bus: busVal, payload: latchCommit, repeat: 2, _step_group_id: stepGroupId, _auto_ambient_48f: true }
        );
      }

      return inlinedSteps;
    }

    const payload = compileToByteMap(act.payload || act.to_payload);
    return {
      ...(act.id ? { id: act.id } : {}),
      type: 'transmit',
      can_id: formatCanId(act.can_id || '0x000'),
      bus: act.bus ?? 0,
      payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
      repeat: act.repeat || 1,
      ...(act.source_command_id ? { source_command_id: act.source_command_id } : {}),
      ...(act.source_command_name ? { source_command_name: act.source_command_name } : {}),
      ...(act.option_label ? { option_label: act.option_label } : {}),
      ...(act.entity_id ? { entity_id: act.entity_id } : {})
    };
  }

  // Handle entity_command: Inline catalog command definition into native CAN transmit bursts
  if (act.type === 'entity_command' || (!act.type && (act.entity_id || act.command))) {
    const entityId = act.entity_id || act.source_command_id;
    const commandLabel = act.command || act.option_label;
    const rawCmd = (catalog?.commands || []).find(c => c.id === entityId);
    const cmd = rawCmd ? resolveVariant(rawCmd, null) : undefined;

    if (cmd) {
      if (cmd.type === 'climate_target') {
        const isPass = act.zone === 'passenger';
        const tempC = act.target_temp_c ?? (cmd as any).target_temp_c ?? 21.0;
        const clamped = Math.max(17.0, Math.min(27.5, tempC));
        const rawVal = Math.min(0x1A, Math.max(0x06, 0x06 + Math.round((clamped - 17.0) * 2.0)));
        const hexVal = '0x' + rawVal.toString(16).toUpperCase().padStart(2, '0');
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: '0x4A0',
          bus: 0,
          payload: isPass ? { D8: hexVal } : { D2: hexVal },
          repeat: 1
        };
      }

      if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'precondition',
          mode: act.precon_mode || (cmd as any).precon_mode || 'persistent',
          action: act.precon_action || (act.precon_mode === 'cancel' ? 'stop' : 'start')
        };
      }

      // Match designated option using robust matcher
      const opt = findMatchingOptionForAction(cmd, act);

      const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || act.can_id || '0x000';
      const bus = cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? act.bus ?? 0;
      const delayMs = cmd.network?.delay_ms ?? cmd.delay_ms ?? act.delay_ms ?? 20;

      // Case A: Option defines multi-step burst (e.g. heated/cooled seat sequence or remote climate)
      if (opt?.steps && opt.steps.length > 0) {
        const stepGroupId = opt.steps.length > 1 ? (act.id || generateBlockId('grp')) : undefined;
        const inlinedSteps: any[] = [];
        opt.steps.forEach((step: any, idx: number) => {
          if (step.type === 'delay') {
            inlinedSteps.push({
              type: 'delay',
              ms: step.delay_ms || step.dwell_ms || step.ms || 500,
              ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
            });
            return;
          }
          if (step.type === 'repeat_until' || step.type === 'wait_for') {
            inlinedSteps.push({
              type: step.type,
              interval_ms: step.interval_ms || 1000,
              timeout_ms: step.timeout_ms || 30000,
              condition: step.condition ? compileCondition(step.condition, catalog) : undefined,
              sequence: step.sequence ? compileActionList(step.sequence, catalog) : undefined,
              ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
            });
            return;
          }
          const stepPayload = compileToByteMap(step.payload);
          inlinedSteps.push({
            type: 'transmit',
            can_id: step.can_id || canId,
            bus: step.bus ?? bus,
            payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
            repeat: step.repeat || 1,
            ...(stepGroupId ? { _step_group_id: stepGroupId } : {}),
            ...(idx === 0 ? {
              source_command_id: entityId,
              source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
              option_label: opt?.label || commandLabel,
              entity_id: entityId
            } : {})
          });
          if (step.delay_ms && step.delay_ms > 0) {
            inlinedSteps.push({
              type: 'delay',
              ms: step.delay_ms,
              ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
            });
          } else if (idx < opt.steps.length - 1 && delayMs > 0) {
            inlinedSteps.push({
              type: 'delay',
              ms: delayMs,
              ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
            });
          }
        });

        const has48F = inlinedSteps.some(s => s.type === 'transmit' && formatCanId(s.can_id) === '0x48F');
        if (entityId === 'ambient_mood_lighting' && !has48F && inlinedSteps.length >= 2 && inlinedSteps[0]?.type === 'transmit') {
          const dashStage1 = inlinedSteps[0].payload;
          const doorStage1 = getAmbientDoorPayload(opt?.label || commandLabel, dashStage1);
          const latchCommit = compileToByteMap('0002082000000000');
          inlinedSteps.push(
            { type: 'delay', ms: 25, ...(stepGroupId ? { _step_group_id: stepGroupId } : {}), _auto_ambient_48f: true },
            { type: 'transmit', can_id: '0x48F', bus: bus, payload: doorStage1, repeat: 2, ...(stepGroupId ? { _step_group_id: stepGroupId } : {}), _auto_ambient_48f: true },
            { type: 'delay', ms: 25, ...(stepGroupId ? { _step_group_id: stepGroupId } : {}), _auto_ambient_48f: true },
            { type: 'transmit', can_id: '0x48F', bus: bus, payload: latchCommit, repeat: 2, ...(stepGroupId ? { _step_group_id: stepGroupId } : {}), _auto_ambient_48f: true }
          );
        }

        return inlinedSteps;
      }

      // Case B: Option defines a single payload
      if (opt?.payload) {
        const p = compileToByteMap(opt.payload);
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: canId,
          bus: bus,
          payload: Object.keys(p).length > 0 ? p : { D1: '0x01' },
          repeat: opt.repeat || 1,
          source_command_id: entityId,
          source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
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
          const parsedPhys = commandLabel !== undefined ? parseFloat(String(commandLabel)) : NaN;
          const phys = !isNaN(parsedPhys) ? parsedPhys : getDefaultPhysicalValue(cmd.network);
          const hex = `0x${physicalToRawByte(phys, cmd.network).toString(16).toUpperCase().padStart(2, '0')}`;
          srcSteps = resolveRangeSteps(cmd, hex) || cmd.steps;
          if (!stepsLabel) stepsLabel = `${phys}${cmd.network?.unit || ''}`;
        }
        const stepGroupId = srcSteps.length > 1 ? (act.id || generateBlockId('grp')) : undefined;
        const inlinedSteps: any[] = [];
        srcSteps.forEach((step: any, idx: number) => {
          const stepPayload = compileToByteMap(step.payload);
          inlinedSteps.push({
            type: 'transmit',
            can_id: step.can_id || canId,
            bus: step.bus ?? bus,
            payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
            repeat: step.repeat || 1,
            ...(stepGroupId ? { _step_group_id: stepGroupId } : {}),
            ...(idx === 0 ? {
              source_command_id: entityId,
              source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
              option_label: stepsLabel,
              entity_id: entityId
            } : {})
          });
          const stepDelay = step.delay_ms ?? delayMs;
          if (idx < srcSteps.length - 1 && stepDelay > 0) {
            inlinedSteps.push({
              type: 'delay',
              ms: stepDelay,
              ...(stepGroupId ? { _step_group_id: stepGroupId } : {})
            });
          }
        });
        return inlinedSteps;
      }

      // Case D: Command defines root payload
      if (cmd.payload) {
        const p = compileToByteMap(cmd.payload);
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: canId,
          bus: bus,
          payload: Object.keys(p).length > 0 ? p : { D1: '0x01' },
          repeat: cmd.repeat || 1,
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
          const parsedPhys = commandLabel !== undefined ? parseFloat(String(commandLabel)) : NaN;
          const targetPhys = !isNaN(parsedPhys) ? parsedPhys : getDefaultPhysicalValue(cmd.network);
          const rawByte = physicalToRawByte(targetPhys, cmd.network);
          const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
          rangePayload = buildRangeActionPayload(hexVal, cmd.network);
          if (!labelOut) {
            labelOut = `${targetPhys}${cmd.network?.unit || ''}`;
          }
        }
        return {
          ...(act.id ? { id: act.id } : {}),
          type: 'transmit',
          can_id: canId,
          bus: bus,
          payload: rangePayload,
          repeat: act.repeat || cmd.repeat || 1,
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
      return {
        ...(act.id ? { id: act.id } : {}),
        type: 'transmit',
        can_id: act.can_id,
        bus: act.bus ?? 0,
        payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
        repeat: act.repeat || 1,
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

  const payload = compileToByteMap(act.payload || act.to_payload);
  return {
    ...(act.id ? { id: act.id } : {}),
    type: 'transmit',
    can_id: act.can_id || '',
    bus: act.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : {},
    repeat: act.repeat || 1
  };
}

function isEqualAction(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'delay') {
    return (a.ms ?? a.delay_ms) === (b.ms ?? b.delay_ms);
  }
  if (a.type === 'transmit') {
    if ((a.can_id || '').toLowerCase() !== (b.can_id || '').toLowerCase()) return false;
    if ((a.bus ?? 0) !== (b.bus ?? 0)) return false;
    const aPayload = JSON.stringify(a.payload || {});
    const bPayload = JSON.stringify(b.payload || {});
    return aPayload === bPayload;
  }
  return false;
}

function deduplicateActionSequence(actions: any[]): any[] {
  if (!actions || actions.length <= 1) return actions || [];

  const deduped: any[] = [];
  for (let i = 0; i < actions.length; i++) {
    const curr = actions[i];

    // Check if curr is an identical consecutive delay (e.g. delay 20 followed by delay 20)
    if (curr.type === 'delay' && deduped.length > 0 && deduped[deduped.length - 1].type === 'delay') {
      continue;
    }

    // Check if curr and next form a [delay, transmit] pair that is identical to the preceding [delay, transmit] pair
    if (curr.type === 'delay' && i + 1 < actions.length && actions[i + 1]?.type === 'transmit') {
      const nextAct = actions[i + 1];
      if (deduped.length >= 2) {
        const prevDelay = deduped[deduped.length - 2];
        const prevTransmit = deduped[deduped.length - 1];
        if (isEqualAction(curr, prevDelay) && isEqualAction(nextAct, prevTransmit)) {
          // Skip both this delay and the duplicate transmit
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
  catalog: Catalog = DEFAULT_CATALOG
): any[] {
  const normalizedActions = decompileActionList(actions, catalog);
  const result: any[] = [];
  for (const act of normalizedActions) {
    const compiled = compileAction(act, catalog);
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
    if ((mapA[k] || '').toLowerCase() !== (mapB[k] || '').toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * Decompiles a condition from automations.json back into a UI AutomationCondition,
 * coalescing multi-option OR groups when applicable.
 */
export function decompileCondition(rawCond: any, catalog: Catalog = DEFAULT_CATALOG): AutomationCondition {
  if (!rawCond || typeof rawCond !== 'object') return rawCond;

  // Check if this is an OR group representing a multi-option state selection on a single entity
  if (Array.isArray(rawCond.or) && rawCond.or.length > 0 && !rawCond.logic) {
    const subConds = rawCond.or.map((c: any) => decompileCondition(c, catalog));
    const explicitCmdId = rawCond.source_command_id || subConds[0]?.source_command_id;
    const allSameCommand =
      explicitCmdId &&
      subConds.every((sc: AutomationCondition) => (sc.source_command_id || explicitCmdId) === explicitCmdId);

    if (allSameCommand) {
      const cmd = (catalog?.commands || []).find(c => c.id === explicitCmdId);
      const selectedOpts: string[] =
        Array.isArray(rawCond.selected_options) && rawCond.selected_options.length > 0
          ? rawCond.selected_options
          : subConds
              .map((sc: AutomationCondition) => {
                if (sc.option_label) return sc.option_label;
                if (cmd) {
                  const resolved = resolveCatalogCommandForCondition(sc, catalog);
                  return resolved.matchedOption?.label;
                }
                return undefined;
              })
              .filter((lbl: string | undefined): lbl is string => !!lbl);

      if (selectedOpts.length > 1 && cmd && cmd.options) {
        const matchedOpts = cmd.options.filter(o =>
          selectedOpts.some(sel => sel.toLowerCase() === o.label.toLowerCase())
        );
        if (matchedOpts.length > 0) {
          const baseCond: AutomationCondition = {
            id: rawCond.id || subConds[0]?.id || generateBlockId('cond'),
            type: 'can_state',
            source_command_id: cmd.id,
            source_command_name: rawCond.source_command_name || cmd.ha_metadata?.name || cmd.name || cmd.id,
            ...pickSustainedFields(rawCond)
          };
          return applyOptionsToCondition(baseCond, cmd, matchedOpts);
        }
      }
    }

    return {
      ...rawCond,
      id: rawCond.id || generateBlockId('cond'),
      or: subConds
    };
  }

  const clone: AutomationCondition = {
    ...rawCond,
    id: rawCond.id || generateBlockId('cond')
  };

  if (Array.isArray(clone.conditions)) {
    clone.conditions = clone.conditions.map(c => decompileCondition(c, catalog));
  }
  if (Array.isArray(clone.and)) {
    clone.and = clone.and.map(c => decompileCondition(c, catalog));
  }
  if (Array.isArray(clone.or)) {
    clone.or = clone.or.map(c => decompileCondition(c, catalog));
  }
  if (Array.isArray(clone.not)) {
    clone.not = clone.not.map(c => decompileCondition(c, catalog));
  } else if (clone.not && typeof clone.not === 'object') {
    clone.not = decompileCondition(clone.not, catalog);
  }

  if (clone.can_id !== undefined && clone.can_id !== null) {
    clone.can_id = formatCanId(clone.can_id);
  }
  if (clone.type === 'ble_beacon' || clone.type === 'ble_device') {
    clone.type = 'ble_presence';
  }
  if (!clone.type && clone.can_id) {
    clone.type = 'can_state';
  }

  return clone;
}

/**
 * Helper to check and consume trailing flattened steps in rawActions starting at `startIndex`
 * that match `expectedSteps.slice(1)` (plus any auto-appended 0x48F ambient mood lighting frames).
 */
function matchAndConsumeRemainingCatalogSteps(
  rawActions: any[],
  startIndex: number,
  catalogCmd: Command,
  expectedSteps: any[],
  defaultCanId: string,
  defaultBus: number,
  defaultDelayMs: number
): { matched: boolean; nextIndex: number; extractedSteps?: AutomationActionStep[] } {
  let cursor = startIndex;
  const extractedSteps: AutomationActionStep[] = [];

  for (let sIdx = 1; sIdx < expectedSteps.length; sIdx++) {
    const expStep = expectedSteps[sIdx];

    if (expStep.type === 'delay') {
      const cand = rawActions[cursor];
      if (!cand || cand.type !== 'delay') {
        return { matched: false, nextIndex: startIndex };
      }
      extractedSteps.push({
        type: 'delay',
        delay_ms: cand.ms ?? cand.delay_ms ?? expStep.delay_ms ?? expStep.ms ?? 500
      });
      cursor++;
      continue;
    }

    if (expStep.type === 'repeat_until' || expStep.type === 'wait_for') {
      if (rawActions[cursor]?.type === 'delay' && !rawActions[cursor]?.source_command_id) {
        cursor++;
      }
      const cand = rawActions[cursor];
      if (!cand || cand.type !== expStep.type) {
        return { matched: false, nextIndex: startIndex };
      }
      extractedSteps.push({
        ...cand,
        condition: cand.condition ? decompileCondition(cand.condition) : undefined,
        sequence: Array.isArray(cand.sequence) ? decompileActionList(cand.sequence) : undefined
      });
      cursor++;
      continue;
    }

    // Optional inter-step delay before this transmit step
    let interDelayMs = expStep.delay_ms ?? defaultDelayMs;
    if (rawActions[cursor]?.type === 'delay' && !rawActions[cursor]?.source_command_id) {
      interDelayMs = rawActions[cursor].ms ?? rawActions[cursor].delay_ms ?? interDelayMs;
      cursor++;
    }

    const cand = rawActions[cursor];
    if (!cand || (cand.type !== 'transmit' && cand.type !== 'can_tx')) {
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
      repeat: cand.repeat ?? expStep.repeat ?? 1,
      delay_ms: expStep.delay_ms ?? (sIdx < expectedSteps.length - 1 ? defaultDelayMs : 0)
    });
    cursor++;
  }

  // If this is ambient_mood_lighting, also consume trailing auto-synthesized 0x48F door zone frames if present
  if (catalogCmd.id === 'ambient_mood_lighting' || formatCanId(defaultCanId) === '0x4AD') {
    while (cursor < rawActions.length) {
      let probe = cursor;
      if (rawActions[probe]?.type === 'delay' && !rawActions[probe]?.source_command_id) {
        probe++;
      }
      const frame1 = rawActions[probe];
      if (
        frame1 &&
        (frame1.type === 'transmit' || frame1.type === 'can_tx') &&
        !frame1.source_command_id &&
        formatCanId(frame1.can_id) === '0x48F'
      ) {
        cursor = probe + 1;
        continue;
      }
      break;
    }
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
  catalog: Catalog = DEFAULT_CATALOG
): AutomationAction[] {
  if (!Array.isArray(rawActions) || rawActions.length === 0) return [];

  const result: AutomationAction[] = [];
  let i = 0;

  while (i < rawActions.length) {
    const raw = rawActions[i];
    if (!raw || typeof raw !== 'object') {
      i++;
      continue;
    }

    // Skip standalone auto-generated 0x48F ambient frames if encountered directly
    if (raw._auto_ambient_48f) {
      i++;
      continue;
    }

    // 1. Control-flow actions: choose (including _cycle_entity restoration), if_then, repeat_until, wait_for
    if (raw.type === 'choose') {
      if (raw._cycle_entity && typeof raw._cycle_entity === 'object') {
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
          ...(ce.popup_prefix !== undefined ? { popup_prefix: ce.popup_prefix } : {})
        });
        i++;
        continue;
      }

      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'choose',
        choices: Array.isArray(raw.choices)
          ? raw.choices.map((ch: any) => ({
              ...ch,
              _clientId: ch._clientId || generateBlockId('branch'),
              conditions: Array.isArray(ch.conditions)
                ? ch.conditions.map((c: any) => decompileCondition(c, catalog))
                : [],
              sequence: Array.isArray(ch.sequence)
                ? decompileActionList(ch.sequence, catalog)
                : []
            }))
          : [],
        default: Array.isArray(raw.default) ? decompileActionList(raw.default, catalog) : []
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
        conditions: rawConds.map((c: any) => decompileCondition(c, catalog)),
        then: Array.isArray(raw.then) ? decompileActionList(raw.then, catalog) : [],
        else: Array.isArray(raw.else) ? decompileActionList(raw.else, catalog) : []
      });
      i++;
      continue;
    }

    if (raw.type === 'repeat_until' || raw.type === 'wait_for') {
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: raw.type,
        condition: raw.condition ? decompileCondition(raw.condition, catalog) : undefined,
        sequence: Array.isArray(raw.sequence) ? decompileActionList(raw.sequence, catalog) : undefined
      });
      i++;
      continue;
    }

    // 2. Pass 1: Explicit `_step_group_id` coalescing
    if (raw._step_group_id) {
      const groupId = raw._step_group_id;
      const groupItems: any[] = [];
      while (i < rawActions.length && rawActions[i]?._step_group_id === groupId) {
        if (!rawActions[i]._auto_ambient_48f) {
          groupItems.push(rawActions[i]);
        }
        i++;
      }

      if (groupItems.length > 0) {
        const firstTx = groupItems.find(x => x.type === 'transmit' || x.type === 'can_tx') || groupItems[0];
        const steps: AutomationActionStep[] = [];

        for (let gIdx = 0; gIdx < groupItems.length; gIdx++) {
          const item = groupItems[gIdx];
          if (item.type === 'transmit' || item.type === 'can_tx') {
            let stepDelayMs = item.delay_ms ?? 0;
            if (gIdx + 1 < groupItems.length && groupItems[gIdx + 1].type === 'delay') {
              stepDelayMs = groupItems[gIdx + 1].ms ?? groupItems[gIdx + 1].delay_ms ?? 20;
              gIdx++; // consume inter-step delay
            }
            steps.push({
              can_id: formatCanId(item.can_id || firstTx.can_id || '0x000'),
              bus: item.bus ?? firstTx.bus ?? 0,
              payload: compileToByteMap(item.payload),
              repeat: item.repeat ?? 1,
              delay_ms: stepDelayMs
            });
          } else if (item.type === 'delay') {
            steps.push({
              type: 'delay',
              delay_ms: item.ms ?? item.delay_ms ?? 500
            });
          } else {
            steps.push({ ...item });
          }
        }

        const candidateAction: AutomationAction = {
          id: firstTx.id || groupId,
          type: 'can_tx',
          can_id: formatCanId(firstTx.can_id || '0x000'),
          bus: firstTx.bus ?? 0,
          payload: steps[0]?.payload || compileToByteMap(firstTx.payload),
          repeat: steps[0]?.repeat ?? firstTx.repeat ?? 1,
          delay_ms: steps[0]?.delay_ms ?? 20,
          ...(steps.length > 1 ? { steps } : {}),
          ...(firstTx.source_command_id ? { source_command_id: firstTx.source_command_id } : {}),
          ...(firstTx.source_command_name ? { source_command_name: firstTx.source_command_name } : {}),
          ...(firstTx.option_label ? { option_label: firstTx.option_label } : {}),
          ...(firstTx.entity_id ? { entity_id: firstTx.entity_id } : {}),
          ...(firstTx.command || firstTx.option_label ? { command: firstTx.command || firstTx.option_label } : {})
        };

        const resolved = resolveCatalogCommandForAction(candidateAction, catalog);
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

    // 3. Pass 2: Heuristic catalog multi-step coalescing for untagged/legacy automations.json rules
    if (raw.type === 'transmit' || raw.type === 'can_tx' || raw.type === 'entity_command') {
      const normalizedRaw: AutomationAction = {
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'can_tx',
        ...(raw.can_id !== undefined && raw.can_id !== null ? { can_id: formatCanId(raw.can_id) } : {}),
        ...(raw.payload ? { payload: compileToByteMap(raw.payload) } : {})
      };

      const { command: catalogCmd, matchedOption } = resolveCatalogCommandForAction(normalizedRaw, catalog);
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
        const defaultBus = catalogCmd.network?.bus ?? catalogCmd.action_bus ?? catalogCmd.bus ?? normalizedRaw.bus ?? 0;
        const defaultDelayMs = catalogCmd.network?.delay_ms ?? catalogCmd.delay_ms ?? normalizedRaw.delay_ms ?? 20;

        // Consume one or more consecutive occurrences of the remaining flattened steps (healing prior duplicate push/pull cycles)
        let nextCursor = i + 1;
        let firstDelayMs = expectedSteps[0]?.delay_ms ?? defaultDelayMs;
        if (rawActions[nextCursor]?.type === 'delay' && !rawActions[nextCursor]?.source_command_id) {
          firstDelayMs = rawActions[nextCursor].ms ?? rawActions[nextCursor].delay_ms ?? firstDelayMs;
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
            defaultDelayMs
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

        // Build the unified steps array from expectedSteps (preserving custom bus/repeat/delays where matched)
        const unifiedSteps: AutomationActionStep[] =
          Array.isArray(normalizedRaw.steps) && normalizedRaw.steps.length > 1
            ? normalizedRaw.steps.map((s: any) => ({
                ...s,
                ...(s.can_id ? { can_id: formatCanId(s.can_id) } : { can_id: defaultCanId }),
                bus: s.bus ?? defaultBus,
                ...(s.payload ? { payload: compileToByteMap(s.payload) } : {})
              }))
            : expectedSteps.map((s: any, idx: number) => {
                if (s.type === 'delay') {
                  return {
                    type: 'delay',
                    delay_ms: s.delay_ms ?? s.dwell_ms ?? s.ms ?? 500
                  };
                }
                if (s.type === 'repeat_until' || s.type === 'wait_for') {
                  return { ...s };
                }
                const tailOverride = idx >= 1 && matchedTailSteps ? matchedTailSteps[idx - 1] : undefined;
                return {
                  can_id: formatCanId(s.can_id || s.action_can_id || defaultCanId),
                  bus: tailOverride?.bus ?? s.bus ?? normalizedRaw.bus ?? defaultBus,
                  payload: compileToByteMap(s.payload),
                  repeat: idx === 0 ? (normalizedRaw.repeat ?? s.repeat ?? 1) : (tailOverride?.repeat ?? s.repeat ?? 1),
                  delay_ms:
                    idx === 0
                      ? firstDelayMs
                      : tailOverride?.delay_ms ?? s.delay_ms ?? (idx < expectedSteps.length - 1 ? defaultDelayMs : 0)
                };
              });

        const { _step_group_id: _sg, _auto_ambient_48f: _af, ...cleanRaw } = normalizedRaw as any;
        result.push({
          ...cleanRaw,
          id: cleanRaw.id || generateBlockId('act'),
          type: 'can_tx',
          can_id: defaultCanId,
          bus: cleanRaw.bus ?? defaultBus,
          payload: unifiedSteps[0]?.payload || cleanRaw.payload || compileToByteMap(expectedSteps[0]?.payload),
          repeat: unifiedSteps[0]?.repeat ?? cleanRaw.repeat ?? expectedSteps[0]?.repeat ?? 1,
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

      // Single-step catalog or raw CAN transmit action
      const { _step_group_id: _sg, _auto_ambient_48f: _af, ...cleanSingle } = normalizedRaw as any;
      if (catalogCmd) {
        cleanSingle.source_command_id = cleanSingle.source_command_id || catalogCmd.id;
        cleanSingle.entity_id = cleanSingle.entity_id || catalogCmd.id;
        cleanSingle.source_command_name =
          cleanSingle.source_command_name || catalogCmd.ha_metadata?.name || catalogCmd.name || catalogCmd.id;
        if (matchedOption) {
          cleanSingle.option_label = cleanSingle.option_label || matchedOption.label;
          cleanSingle.command = cleanSingle.command || matchedOption.label;
        }
      }
      result.push(cleanSingle);
      i++;
      continue;
    }

    // 4. Other action types (delay, track_popup, climate_target, precondition, webhook, etc.)
    if (raw.type === 'delay') {
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'delay',
        delay_ms: raw.delay_ms ?? raw.ms ?? 500,
        ms: raw.ms ?? raw.delay_ms ?? 500
      });
      i++;
      continue;
    }

    if (raw.type === 'precondition') {
      result.push({
        ...raw,
        id: raw.id || generateBlockId('act'),
        type: 'precondition',
        precon_mode: raw.precon_mode || raw.mode || 'persistent',
        precon_action: raw.precon_action || raw.action || 'start'
      });
      i++;
      continue;
    }

    result.push({
      ...raw,
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
  catalog: Catalog = DEFAULT_CATALOG
): AutomationRule {
  if (!rawRule || typeof rawRule !== 'object') return rawRule;

  const triggers: AutomationTrigger[] = Array.isArray(rawRule.triggers)
    ? rawRule.triggers.map((trig: any) => {
        if (!trig || typeof trig !== 'object') return trig;
        const clone: AutomationTrigger = {
          ...trig,
          id: trig.id || generateBlockId('trig')
        };
        if (clone.can_id !== undefined && clone.can_id !== null) {
          clone.can_id = formatCanId(clone.can_id);
        }
        if (clone.type === 'ble_beacon') {
          clone.type = 'ble_presence';
          clone.source = clone.source || 'ble';
        } else if (clone.type === 'ble_button' || clone.type === 'ble_key' || clone.type === 'ble_device_event') {
          clone.source = clone.source || 'ble';
        } else if (clone.type === 'wifi_event' || clone.type === 'wifi') {
          clone.source = clone.source || 'wifi';
        } else if (clone.type === 'time_schedule') {
          clone.source = clone.source || 'time';
        } else if (!clone.source) {
          clone.source = clone.source_command_id ? 'preset' : 'can';
        }
        return clone;
      })
    : [];

  const conditions: AutomationCondition[] = Array.isArray(rawRule.conditions)
    ? rawRule.conditions.map((c: any) => decompileCondition(c, catalog))
    : [];

  const actions: AutomationAction[] = Array.isArray(rawRule.actions)
    ? decompileActionList(rawRule.actions, catalog)
    : [];

  const offActions: AutomationAction[] | undefined = Array.isArray(rawRule.off_actions)
    ? decompileActionList(rawRule.off_actions, catalog)
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
    cooldown_ms: rawRule.cooldown_ms ?? 500,
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
  catalog: Catalog = DEFAULT_CATALOG
): AutomationRule[] {
  if (!Array.isArray(rawRules)) return [];
  return rawRules.map(r => decompileAutomationRule(r, catalog));
}

/**
 * Compiles a single AutomationRule into a clean, self-contained schema with inlined actions.
 */
export function compileAutomationRule(
  rule: AutomationRule,
  catalog: Catalog = DEFAULT_CATALOG
): any {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled ?? true,
    ha_expose: rule.ha_expose ?? true,
    ...(rule.hold_beep ? { hold_beep: true } : {}),
    ha_icon: rule.ha_icon || 'mdi:car-cog',
    exec_mode: rule.exec_mode || 'one_shot',
    trigger_mode: rule.trigger_mode || 'any',
    cooldown_ms: rule.cooldown_ms ?? 500,
    ...(rule.timeout_reset_ms ? { timeout_reset_ms: rule.timeout_reset_ms } : {}),
    ...(rule.category ? { category: rule.category } : {}),
    ...(rule.description ? { description: rule.description } : {}),
    triggers: (rule.triggers || []).map(trig => {
      const baseTrigger = {
        id: trig.id,
        ...(trig.name ? { name: trig.name } : {}),
        ...(trig.source_command_id ? { source_command_id: trig.source_command_id } : {}),
        ...(trig.source_command_name ? { source_command_name: trig.source_command_name } : {}),
        ...(trig.option_label ? { option_label: trig.option_label } : {}),
        ...(trig.click_count && trig.click_count > 1 ? { click_count: trig.click_count } : {}),
        ...(trig.for_ms ? { for_ms: trig.for_ms } : {}),
        ...(trig.for_sec ? { for_sec: trig.for_sec } : {})
      };

      if (trig.type === 'time_schedule' || trig.source === 'time' || trig.time) {
        return {
          ...baseTrigger,
          type: 'time_schedule',
          time: trig.time || '07:30',
          days: trig.days && trig.days.length > 0 ? trig.days : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
        };
      }

      if (trig.type === 'ble_button' || trig.type === 'ble_key' || (trig.source === 'ble' && trig.ble_button)) {
        return {
          ...baseTrigger,
          type: 'ble_button',
          ble_button: trig.ble_button || 'volume_up',
          ble_action: trig.ble_action || 'press',
          ...(trig.ble_device ? { ble_device: trig.ble_device } : {})
        };
      }

      if (
        trig.type === 'ble_beacon' ||
        trig.type === 'beacon' ||
        ((trig.type === 'ble_presence' || trig.source === 'ble') &&
          (trig.beacon_uuid || ['enter', 'exit', 'present', 'away'].includes(trig.ble_event || '')))
      ) {
        return {
          ...baseTrigger,
          type: 'ble_beacon',
          ble_event: trig.ble_event || 'present',
          ...(trig.beacon_uuid ? { beacon_uuid: trig.beacon_uuid } : {}),
          ...(trig.beacon_major ? { beacon_major: trig.beacon_major } : {}),
          ...(trig.beacon_minor ? { beacon_minor: trig.beacon_minor } : {}),
          ...(trig.ble_device ? { ble_device: trig.ble_device } : {}),
          ...(trig.client_mac ? { client_mac: trig.client_mac } : {}),
          ...(trig.target_rssi !== undefined ? { target_rssi: trig.target_rssi } : {})
        };
      }

      if (
        trig.type === 'ble_device_event' ||
        trig.type === 'ble_device' ||
        trig.type === 'ble_presence' ||
        trig.source === 'ble'
      ) {
        return {
          ...baseTrigger,
          type: 'ble_device_event',
          ble_event: trig.ble_event || 'connected',
          ...(trig.ble_device ? { ble_device: trig.ble_device } : {}),
          ...(trig.client_mac ? { client_mac: trig.client_mac } : {}),
          ...(trig.target_rssi !== undefined ? { target_rssi: trig.target_rssi } : {})
        };
      }

      if (trig.type === 'wifi' || trig.type === 'wifi_event' || trig.source === 'wifi') {
        return {
          ...baseTrigger,
          type: 'wifi_event',
          wifi_event: trig.wifi_event || 'ap_client_connected',
          ...(trig.ssid ? { ssid: trig.ssid } : {}),
          ...(trig.client_mac ? { client_mac: trig.client_mac } : {}),
          ...(trig.target_rssi !== undefined && trig.target_rssi !== 0 ? { target_rssi: trig.target_rssi } : {})
        };
      }

      if (trig.type === 'can_rx' || (trig.match && Object.keys(trig.match).length > 1)) {
        let fullMask: any = trig.mask;
        if (trig.match && Object.keys(trig.match).length > 1) {
          if (typeof fullMask !== 'object' || fullMask === null) {
            const defM = typeof fullMask === 'string' ? fullMask : '0xFF';
            const mObj: Record<string, string> = {};
            Object.keys(trig.match).forEach(k => { mObj[k] = defM; });
            fullMask = mObj;
          }
        }
        return {
          ...baseTrigger,
          type: 'can_rx',
          can_id: trig.can_id || '',
          bus: trig.bus ?? 0,
          match: trig.match,
          mask: fullMask || '0xFF'
        };
      }

      const targetByte = trig.byte || trig.evaluate?.byte || (trig.match ? Object.keys(trig.match)[0] : undefined) || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : 'D7');
      const fromHex = trig.from || (trig.from_value !== undefined ? `0x${trig.from_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x00');
      const toHex = trig.to || trig.value || trig.evaluate?.value || (trig.match && trig.match[targetByte]) || (trig.to_value !== undefined ? `0x${trig.to_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x10');
      const trigOp = trig.operator || trig.evaluate?.operator;
      const maskHex = trig.mask || (typeof trig.evaluate?.mask === 'string' ? trig.evaluate.mask : undefined) || (trigOp || trig.value !== undefined ? '0xFF' : '0xF0');

      return {
        ...baseTrigger,
        type: 'byte_transition',
        can_id: trig.can_id || '',
        bus: trig.bus ?? 0,
        byte: targetByte || '',
        mask: maskHex || '',
        from: fromHex || '',
        to: toHex || '',
        ...(trigOp && trigOp !== 'equal' ? { operator: trigOp } : {})
      };
    }),
    conditions: (rule.conditions || []).map(c => compileCondition(c, catalog)),
    actions: compileActionList(rule.actions || [], catalog),
    ...(rule.off_actions && rule.off_actions.length > 0
      ? { off_actions: compileActionList(rule.off_actions, catalog) }
      : {})
  };
}

/**
 * Generate standard WiCAN / CAN Do format strictly matching the exact architecture outcome
 */
export function exportToCandoJson(
  rules: AutomationRule[],
  settings: AutomationSettings = {},
  catalog: Catalog = DEFAULT_CATALOG
): string {
  const exportPayload = {
    settings: {
      vehicle_model: settings.vehicle_model || 'all_egmp',
      unit_system: settings.unit_system || 'imperial',
      can_do_version: settings.can_do_version || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'),
      ntp_server: settings.ntp_server || 'pool.ntp.org',
      timezone: settings.timezone || 'UTC'
    },
    rules: rules.map(r => compileAutomationRule(r, catalog))
  };

  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Generate full can_do_catalog.json with embedded automations array ready for ESP32 LittleFS.
 *
 * When `vehicle` is provided, commands with `variants` are resolved to that
 * vehicle's family before serialization — the `variants` key is stripped from
 * the output so the firmware parser never sees it and needs no changes.
 * When `vehicle` is omitted the first variant is used as a best-guess fallback
 * (same behaviour as resolveVariant).
 */
export function exportToFullCatalogJson(
  catalog: Catalog,
  rules: AutomationRule[],
  vehicle?: Vehicle | null
): string {
  const cleanAutomations = rules.map(r => compileAutomationRule(r, catalog));

  // Flatten variants for each command so the ESP32 gets a clean, vehicle-specific catalog
  const resolvedCommands = catalog.commands.map(cmd => {
    const resolved = resolveVariant(cmd, vehicle ?? null);
    // Strip the variants key — the firmware has no use for it
    if (resolved.variants) {
      const { variants: _stripped, ...clean } = resolved;
      return clean as Command;
    }
    return resolved;
  });

  return JSON.stringify({
    ...catalog,
    commands: resolvedCommands,
    automations: cleanAutomations
  }, null, 2);
}

/**
 * Convert a Catalog Command into an Automation Trigger
 */
export function commandToTrigger(rawCmd: Command, opt?: CommandOption): AutomationTrigger {
  const cmd = resolveVariant(rawCmd, null);
  const trigId = `trig_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x448';
  const chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined);

  if (!chosenOpt && isRangeCommand(cmd)) {
    const net = cmd.network;
    const targetByte = normalizeByteKey(net?.state_byte || net?.byte || 'D1');
    const targetMask = net?.state_mask || net?.mask || (typeof cmd.mask === 'string' ? cmd.mask : undefined) || '0xFF';
    const defaultPhys = getDefaultPhysicalValue(net);
    const rawByte = physicalToRawByte(defaultPhys, net);
    const hexVal = `0x${rawByte.toString(16).toUpperCase().padStart(2, '0')}`;
    const labelStr = `${defaultPhys}${net?.unit || ''}`;
    const byteIdx = parseInt(targetByte.replace(/\D/g, ''), 10) - 1;

    return {
      id: trigId,
      type: 'byte_transition',
      source: 'can',
      can_id: canId,
      bus: net?.bus ?? cmd.bus ?? 0,
      byte: targetByte,
      mask: targetMask,
      operator: 'equal',
      value: hexVal,
      from: '0x00',
      to: hexVal,
      to_value: rawByte,
      match: { [targetByte]: hexVal },
      evaluate: {
        byte: targetByte,
        byte_index: isNaN(byteIdx) ? 0 : byteIdx,
        mask: targetMask,
        operator: 'equal',
        value: hexVal
      },
      click_count: 1,
      for_sec: 0,
      for_ms: 0,
      source_command_id: cmd.id,
      target_entity_id: cmd.id,
      source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
      option_label: labelStr
    };
  }

  const match = compileToByteMap(chosenOpt?.match || cmd.match || chosenOpt?.payload || cmd.payload);
  const targetByte = Object.keys(match)[0] || 'D7';
  const targetTo = match[targetByte] || '0x10';

  const rawMask = chosenOpt?.mask || cmd.mask;
  let targetMask = '0xFF';
  if (typeof rawMask === 'string') {
    targetMask = rawMask;
  } else if (rawMask && typeof rawMask === 'object') {
    targetMask = (rawMask as ByteMap)[targetByte] || '0xFF';
  }

  return {
    id: trigId,
    type: 'byte_transition',
    source: 'can',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    byte: targetByte,
    mask: targetMask,
    from: '0x00',
    to: targetTo,
    click_count: 1,
    for_sec: 0,
    for_ms: 0,
    source_command_id: cmd.id,
    source_command_name: cmd.name || cmd.ha_metadata?.name || cmd.id,
    option_label: chosenOpt?.label
  };
}

/**
 * Convert a Catalog Command into an Automation Condition
 */
export function commandToCondition(rawCmd: Command, opt?: CommandOption): AutomationCondition {
  const cmd = resolveVariant(rawCmd, null);
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
    const byteIdx = parseInt(dKey.replace(/\D/g, ''), 10) - 1;

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
        byte_index: isNaN(byteIdx) ? 0 : byteIdx,
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
  const match = compileToByteMap(chosenOpt?.match || cmd.match || chosenOpt?.payload || cmd.payload);
  const dKey = optEval?.byte || chosenOpt?.byte || Object.keys(match)[0] || 'D1';
  const targetVal = optEval?.value !== undefined ? String(optEval.value) : (chosenOpt?.value || match[dKey] || '0x01');
  const targetOp = optEval?.operator || chosenOpt?.operator || 'equal';
  const cleanMatch = Object.keys(match).length > 0 ? match : { [dKey]: targetVal };
  const byteIdx = parseInt(dKey.replace(/\D/g, ''), 10) - 1;

  const rawMask = optEval?.mask || chosenOpt?.mask || cmd.mask;
  const isMultiByte = Object.keys(cleanMatch).length > 1;
  let targetMask: string | ByteMap = '0xFF';

  if (isMultiByte) {
    if (rawMask && typeof rawMask === 'object') {
      const mObj: Record<string, string> = {};
      Object.keys(cleanMatch).forEach(k => {
        mObj[k] = (rawMask as ByteMap)[k] || '0xFF';
      });
      targetMask = mObj;
    } else {
      const defM = typeof rawMask === 'string' ? rawMask : '0xFF';
      const mObj: Record<string, string> = {};
      Object.keys(cleanMatch).forEach(k => {
        mObj[k] = defM;
      });
      targetMask = mObj;
    }
  } else {
    if (typeof rawMask === 'string') {
      targetMask = rawMask;
    } else if (rawMask && typeof rawMask === 'object') {
      targetMask = (rawMask as ByteMap)[dKey] || '0xFF';
    }
  }

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
      byte_index: isNaN(byteIdx) ? 0 : byteIdx,
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
export function commandToAction(rawCmd: Command, opt?: CommandOption): AutomationAction {
  const cmd = resolveVariant(rawCmd, null);
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
    return {
      id: actId,
      type: 'precondition',
      precon_mode: (chosenOpt as any)?.precon_mode || 'persistent',
      precon_action: (chosenOpt as any)?.precon_mode === 'cancel' ? 'stop' : 'start',
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: chosenOpt?.label
    };
  }

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
          bus: s.bus ?? (net?.bus ?? cmd.action_bus ?? cmd.bus ?? 0),
          payload: compileToByteMap(s.payload),
          repeat: s.repeat ?? 1,
          delay_ms: s.delay_ms ?? (idx < rangeSteps.length - 1 ? (delayMs || 20) : 0)
        }))
      : undefined;

    return {
      id: actId,
      type: 'can_tx',
      can_id: canId,
      bus: net?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
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
        bus: s.bus ?? (cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0),
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
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
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
 * Safely normalizes any CAN ID representation (number, hex string, decimal string)
 * into a standard lowercase representation (e.g. "0x4a2") for lookup and comparison.
 */
export function normalizeCanId(canId: unknown): string {
  if (canId === undefined || canId === null) return '';
  if (typeof canId === 'number') {
    if (isNaN(canId)) return '';
    return `0x${canId.toString(16).toUpperCase()}`.toLowerCase();
  }
  const str = String(canId).trim();
  if (!str) return '';
  if (/^0x/i.test(str)) {
    return str.toLowerCase();
  }
  // If pure decimal digits (e.g. "1186")
  if (/^\d+$/.test(str)) {
    const num = parseInt(str, 10);
    if (!isNaN(num)) {
      return `0x${num.toString(16).toUpperCase()}`.toLowerCase();
    }
  }
  // If bare hex string without 0x (e.g. "4A2" or "4a2")
  if (/^[0-9a-fA-F]+$/.test(str)) {
    return `0x${str.toUpperCase()}`.toLowerCase();
  }
  return str.toLowerCase();
}

/**
 * Formats a CAN ID into standard canonical representation (e.g. "0x4A2")
 */
export function formatCanId(canId: unknown): string {
  if (canId === undefined || canId === null) return '';
  if (typeof canId === 'number') {
    if (isNaN(canId)) return '';
    return `0x${canId.toString(16).toUpperCase()}`;
  }
  const str = String(canId).trim();
  if (!str) return '';
  if (/^0x/i.test(str)) {
    const hex = str.slice(2).toUpperCase();
    return `0x${hex}`;
  }
  if (/^\d+$/.test(str)) {
    const num = parseInt(str, 10);
    if (!isNaN(num)) {
      return `0x${num.toString(16).toUpperCase()}`;
    }
  }
  if (/^[0-9a-fA-F]+$/.test(str)) {
    return `0x${str.toUpperCase()}`;
  }
  return str;
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
      const stateId = normalizeCanId(cmd.network?.state_can_id || cmd.state_can_id);
      const actionId = normalizeCanId(cmd.network?.action_can_id || cmd.action_can_id);
      if (stateId) {
        let list = byCanId.get(stateId);
        if (!list) {
          list = [];
          byCanId.set(stateId, list);
        }
        list.push(cmd);
      }
      if (actionId && actionId !== stateId) {
        let list = byCanId.get(actionId);
        if (!list) {
          list = [];
          byCanId.set(actionId, list);
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
  catalog: Catalog
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const index = getCatalogCommandIndex(catalog.commands);

  // 1. Direct ID match
  const directTrigId = trig.source_command_id || trig.target_entity_id;
  if (directTrigId) {
    const rawCmd = index.byId.get(directTrigId);
    if (rawCmd) {
      const cmd = resolveVariant(rawCmd, null);
      const opt = findMatchingOptionForTrigger(cmd, trig);
      return { command: cmd, matchedOption: opt };
    }
  }

  // 2. ID name hint match (e.g. trig_menu_ok -> sw_menu)
  if (trig.id) {
    const lowerId = trig.id.toLowerCase();
    if (lowerId.includes('menu') || lowerId.includes('ok')) {
      const swMenu = index.byId.get('sw_menu');
      if (swMenu) {
        const cmd = resolveVariant(swMenu, null);
        const opt = findMatchingOptionForTrigger(cmd, trig);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 3. Match by CAN ID
  if (trig.can_id) {
    const normCanId = normalizeCanId(trig.can_id);
    const rawCands = index.byCanId.get(normCanId) ?? [];
    let candidateCmds = rawCands;
    if (rawCands.length > 1) {
      const stateMatching = rawCands.filter(c => normalizeCanId(c.network?.state_can_id || c.state_can_id) === normCanId);
      if (stateMatching.length > 0) candidateCmds = stateMatching;
    }

    if (candidateCmds.length === 1) {
      const cmd = resolveVariant(candidateCmds[0], null);
      const opt = findMatchingOptionForTrigger(cmd, trig, true);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      // Find candidate whose options match byte/value (strict - no blind fallback)
      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
        const opt = findMatchingOptionForTrigger(cmd, trig, false);
        if (opt) {
          return { command: cmd, matchedOption: opt };
        }
      }
      // Check command-level match
      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
        if (cmd.match && trig.byte && cmd.match[trig.byte]) {
          return { command: cmd, matchedOption: cmd.options?.[0] };
        }
      }
      // Disambiguate shared CAN ID range commands by state_byte / byte (e.g. 0x380 D2 driver vs D3 passenger)
      const trigByteKeyRaw = trig.byte || trig.evaluate?.byte || (trig.match ? Object.keys(trig.match)[0] : undefined);
      if (trigByteKeyRaw) {
        const normTrigByte = normalizeByteKey(trigByteKeyRaw);
        const rangeMatches = candidateCmds
          .map(raw => resolveVariant(raw, null))
          .filter(cmd => {
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

function toHexByte(val: any): string | undefined {
  const formatted = formatHexByte(val);
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
  rear_defog: 'climate_rear_defog',
  rear_defogger: 'climate_rear_defog',
  defogger: 'climate_rear_defog',
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
    const target = trig.option_label.toLowerCase().trim();
    const byLabel = cmd.options.find(o => o.label.toLowerCase().trim() === target);
    if (byLabel) return byLabel;
    const byPartial = cmd.options.find(o => {
      const l = o.label.toLowerCase().trim();
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
      const optVal = (opt.match[byteKey].startsWith('0x') ? opt.match[byteKey] : `0x${opt.match[byteKey]}`).toLowerCase();
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

  const rawLabel = act.option_label || act.command || '';
  const labelToMatch = rawLabel.toLowerCase().trim();

  for (const opt of cmd.options) {
    let score = 0;
    const optLabel = opt.label.toLowerCase().trim();

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

function findMatchingOptionForAction(cmd: Command, act: AutomationAction, allowFallback = true): CommandOption | undefined {
  if (!cmd.options || cmd.options.length === 0) return undefined;
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
  catalog: Catalog
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const index = getCatalogCommandIndex(catalog.commands);

  // 1. Direct ID or Alias match
  const rawTargetId = act.source_command_id || act.entity_id || act.target_command_id || (act as any).target_entity_id;
  if (rawTargetId) {
    const normTarget = rawTargetId.toLowerCase().trim();
    const resolvedId = index.byId.has(rawTargetId)
      ? rawTargetId
      : index.byId.has(normTarget)
      ? normTarget
      : ENTITY_ALIASES[normTarget];

    if (resolvedId) {
      const rawCmd = index.byId.get(resolvedId);
      if (rawCmd) {
        const cmd = resolveVariant(rawCmd, null);
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
          const cmd = resolveVariant(rawCmd, null);
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
    let candidateCmds = rawCands;
    if (rawCands.length > 1) {
      const actionMatching = rawCands.filter(c => normalizeCanId(c.network?.action_can_id || c.action_can_id) === normCanId);
      if (actionMatching.length > 0) candidateCmds = actionMatching;
    }

    if (candidateCmds.length === 1) {
      const cmd = resolveVariant(candidateCmds[0], null);
      const opt = findMatchingOptionForAction(cmd, act, true);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      const actPayload = extractActionPayload(act);
      let bestCandidate: { cmd: Command; opt: CommandOption; score: number } | null = null;

      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
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
        for (const raw of candidateCmds) {
          const cmd = resolveVariant(raw, null);
          const cName = (cmd.ha_metadata?.name || cmd.name || cmd.id).toLowerCase();
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
        for (const raw of candidateCmds) {
          const cmd = resolveVariant(raw, null);
          if (!isRangeCommand(cmd)) continue;
          const actionByte = normalizeByteKey(cmd.network?.action_byte || cmd.network?.state_byte || cmd.network?.byte || 'D1');
          const actHex = toHexByte(actPayload[actionByte]);
          if (!actHex) continue;

          let score = 0;
          if (Array.isArray(cmd.network?.base_payload)) {
            const baseArr = cmd.network.base_payload;
            const actionIdx = parseInt(actionByte.slice(1), 10) - 1;
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
  catalog: Catalog
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const index = getCatalogCommandIndex(catalog.commands);

  // 1. Direct ID match
  if (cond.source_command_id) {
    const rawCmd = index.byId.get(cond.source_command_id);
    if (rawCmd) {
      const cmd = resolveVariant(rawCmd, null);
      const opt = findMatchingOptionForCondition(cmd, cond, true);
      return { command: cmd, matchedOption: opt };
    }
  }

  // 2. ID name hint match (e.g. cond_gear_drive -> gear_selector)
  if (cond.id && cond.id.length >= 5) {
    const lowerId = cond.id.toLowerCase();
    for (const c of catalog.commands) {
      if (lowerId.includes(c.id.toLowerCase())) {
        const cmd = resolveVariant(c, null);
        const opt = findMatchingOptionForCondition(cmd, cond, true);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 3. Match by CAN ID
  if (cond.can_id) {
    const normCanId = normalizeCanId(cond.can_id);
    const rawCands = index.byCanId.get(normCanId) ?? [];
    let candidateCmds = rawCands;
    if (rawCands.length > 1) {
      const stateMatching = rawCands.filter(c => normalizeCanId(c.network?.state_can_id || c.state_can_id) === normCanId);
      if (stateMatching.length > 0) candidateCmds = stateMatching;
    }

    if (candidateCmds.length === 1) {
      const cmd = resolveVariant(candidateCmds[0], null);
      const opt = findMatchingOptionForCondition(cmd, cond, true);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
        const opt = findMatchingOptionForCondition(cmd, cond, false);
        if (opt) return { command: cmd, matchedOption: opt };
      }
      // Disambiguate shared CAN ID range commands by state_byte / byte (e.g. 0x380 D2 driver vs D3 passenger)
      const condByteRaw = cond.byte || cond.evaluate?.byte || (cond.match ? Object.keys(cond.match)[0] : undefined);
      if (condByteRaw) {
        const normCondByte = normalizeByteKey(condByteRaw);
        const rangeMatches = candidateCmds
          .map(raw => resolveVariant(raw, null))
          .filter(cmd => {
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
    const target = cond.option_label.toLowerCase().trim();
    const byLabel = cmd.options.find(o => o.label.toLowerCase().trim() === target);
    if (byLabel) return byLabel;
    const byPartial = cmd.options.find(o => {
      const l = o.label.toLowerCase().trim();
      return l.includes(target) || target.includes(l);
    });
    if (byPartial) return byPartial;
  }
  const byteKey = cond.byte || cond.evaluate?.byte || (cond.match ? Object.keys(cond.match)[0] : undefined);
  const targetVal = cond.value || cond.evaluate?.value || (byteKey && cond.match ? cond.match[byteKey] : undefined);
  const targetHex = toHexByte(targetVal);

  if (byteKey && targetHex) {
    for (const opt of cmd.options) {
      const match = compileToByteMap(opt.match || opt.payload);
      if (match[byteKey] && match[byteKey].toLowerCase() === targetHex) {
        return opt;
      }
    }
  }

  return allowFallback ? (cmd.options.find(o => o.default) || cmd.options[0]) : undefined;
}

/**
 * Apply a selected catalog option to a trigger
 */
export function applyOptionToTrigger(trig: AutomationTrigger, rawCmd: Command, opt: CommandOption): AutomationTrigger {
  const cmd = resolveVariant(rawCmd, null);
  const cleanMatch = compileToByteMap(opt.match || opt.payload || cmd.match || cmd.payload);
  const dKey = Object.keys(cleanMatch)[0] || 'D7';
  const targetTo = cleanMatch[dKey] || '0x10';
  const byteNum = parseInt(dKey.replace(/\D/g, ''), 10);
  const byteIdx = isNaN(byteNum) ? 6 : byteNum - 1;

  const rawMask = opt.mask || cmd.mask;
  let targetMask = '0xFF';
  if (typeof rawMask === 'string') {
    targetMask = rawMask;
  } else if (rawMask && typeof rawMask === 'object') {
    targetMask = (rawMask as ByteMap)[dKey] || '0xFF';
  }

  const toVal = parseInt(targetTo.replace('0x', ''), 16);
  const friendlyName = cmd.id === 'sw_menu' ? 'Menu / OK Button' : (cmd.ha_metadata?.name || cmd.name || cmd.id);

  const targetFrom = (trig.from && trig.from !== targetTo)
    ? trig.from
    : (targetTo === '0x00' ? targetMask : '0x00');
  const fromVal = parseInt(targetFrom.replace('0x', ''), 16);

  return {
    ...trig,
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
export function applyOptionToAction(act: AutomationAction, rawCmd: Command, opt: CommandOption): AutomationAction {
  const cmd = resolveVariant(rawCmd, null);
  const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || act.can_id || '0x000';
  const cmdDisplayName = cmd.ha_metadata?.name || cmd.name || cmd.id;
  const rawSteps = opt.steps || (opt.payload ? undefined : cmd.steps);
  const defaultStepDelay = cmd.network?.delay_ms ?? cmd.delay_ms ?? act.delay_ms ?? 20;
  const cleanSteps: AutomationActionStep[] | undefined = rawSteps && rawSteps.length > 0
    ? rawSteps.map((s, idx) => ({
        can_id: s.can_id || canId,
        bus: s.bus ?? (cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? act.bus ?? 0),
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
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? act.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : act.payload,
    repeat: repeat,
    delay_ms: delayMs,
    steps: cleanSteps && cleanSteps.length > 1 ? cleanSteps : undefined,
    popup_message: opt.popup || `${cmdDisplayName} - ${opt.label}`
  };
}

/**
 * Apply a selected catalog option to a condition
 */
export function applyOptionToCondition(
  cond: AutomationCondition,
  rawCmd: Command,
  opt: CommandOption
): AutomationCondition {
  const cmd = resolveVariant(rawCmd, null);
  const cleanMatch = compileToByteMap(opt.match || opt.payload || cmd.match || cmd.payload);
  const dKey = Object.keys(cleanMatch)[0] || cond.byte || 'D1';
  const targetVal = cleanMatch[dKey] || '0x01';
  const byteNum = parseInt(dKey.replace(/\D/g, ''), 10);
  const byteIdx = isNaN(byteNum) ? 0 : byteNum - 1;

  const rawMask = opt.mask || cmd.mask;
  const isMultiByte = Object.keys(cleanMatch).length > 1;
  let targetMask: string | ByteMap = '0xFF';

  if (isMultiByte) {
    if (rawMask && typeof rawMask === 'object') {
      const mObj: Record<string, string> = {};
      Object.keys(cleanMatch).forEach(k => {
        mObj[k] = (rawMask as ByteMap)[k] || '0xFF';
      });
      targetMask = mObj;
    } else {
      const defM = typeof rawMask === 'string' ? rawMask : '0xFF';
      const mObj: Record<string, string> = {};
      Object.keys(cleanMatch).forEach(k => {
        mObj[k] = defM;
      });
      targetMask = mObj;
    }
  } else {
    if (typeof rawMask === 'string') {
      targetMask = rawMask;
    } else if (rawMask && typeof rawMask === 'object') {
      targetMask = (rawMask as ByteMap)[dKey] || '0xFF';
    }
  }

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
  opts: CommandOption[]
): AutomationCondition {
  if (!opts || opts.length === 0) {
    return cond;
  }
  if (opts.length === 1) {
    const res = applyOptionToCondition(cond, rawCmd, opts[0]);
    return {
      ...res,
      selected_options: [opts[0].label]
    };
  }

  const cmd = resolveVariant(rawCmd, null);
  const friendlyName = cmd.ha_metadata?.name || cmd.name || cmd.id;
  const mergedMatch: ByteMap = {};
  const mergedMask: Record<string, string> = {};

  const byteSeen: Record<string, string> = {};
  let hasSameByteConflict = false;

  opts.forEach(opt => {
    const m = compileToByteMap(opt.match || opt.payload);
    for (const [k, v] of Object.entries(m)) {
      if (byteSeen[k] !== undefined && byteSeen[k] !== v) {
        hasSameByteConflict = true;
      }
      byteSeen[k] = v;
    }
    Object.assign(mergedMatch, m);

    const rawMask = opt.mask;
    if (typeof rawMask === 'string') {
      Object.keys(m).forEach(k => {
        mergedMask[k] = rawMask;
      });
    } else if (rawMask && typeof rawMask === 'object') {
      Object.assign(mergedMask, rawMask);
    } else {
      Object.keys(m).forEach(k => {
        if (!mergedMask[k]) mergedMask[k] = '0xFF';
      });
    }
  });

  const dKey = Object.keys(mergedMatch)[0] || 'D1';
  const targetVal = mergedMatch[dKey] || '0x01';
  const byteNum = parseInt(dKey.replace(/\D/g, ''), 10);
  const byteIdx = isNaN(byteNum) ? 0 : byteNum - 1;

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
    mask: Object.keys(mergedMask).length > 1 ? mergedMask : (mergedMask[dKey] || '0xFF'),
    match: mergedMatch,
    operator: 'equal',
    value: targetVal,
    evaluate: {
      byte: dKey,
      byte_index: byteIdx,
      operator: 'equal',
      value: targetVal,
      mask: Object.keys(mergedMask).length > 1 ? mergedMask : (mergedMask[dKey] || '0xFF')
    },
    invert: false
  };
}

/**
 * Generates a unique short ID with a given prefix (e.g. 'act_', 'cond_', 'trg_', 'br_')
 */
export function generateBlockId(prefix: string = 'blk'): string {
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
    clone.label = clone.label.endsWith('(Copy)') ? clone.label : `${clone.label} (Copy)`;
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

  // 2. Nested 'if_then' blocks
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
  const isBlePresence = raw.type === 'ble_presence' || raw.type === 'ble_beacon' || raw.type === 'beacon' || raw.type === 'ble_device' || raw.type === 'ble_device_event';
  const isBleButton = raw.type === 'ble_button';
  const isWifi = raw.type === 'wifi' || raw.type === 'wifi_event';

  return regenerateConditionIds({
    ...raw,
    type: isBleButton ? 'ble_button' : (isBlePresence ? 'ble_presence' : (isWifi ? 'wifi' : 'can_state')),
    device_property: isBlePresence ? (raw.ble_event === 'exit' || raw.ble_event === 'away' ? 'away' : (raw.ble_event === 'disconnected' ? 'disconnected' : 'present')) : raw.device_property,
    target_bool: isBlePresence ? !(raw.ble_event === 'exit' || raw.ble_event === 'away' || raw.ble_event === 'disconnected') : raw.target_bool,
    operator: 'equal',
    value: raw.to ?? raw.value ?? raw.to_value ?? raw.match_payload,
    match: raw.to_payload ?? raw.match ?? raw.match_payload,
  } as AutomationCondition);
}

export function convertConditionToTrigger(condition: AutomationCondition): AutomationTrigger {
  const raw = deepClone(condition) as Record<string, any>;
  delete raw.id;
  delete raw._clientId;
  const isBlePresence = raw.type === 'ble_presence' || raw.type === 'ble_beacon' || raw.type === 'beacon' || raw.type === 'ble_device';
  const isBleButton = raw.type === 'ble_button';
  const isWifi = raw.type === 'wifi' || raw.type === 'wifi_event' || raw.type === 'device_state';

  let trigType = 'byte_transition';
  let trigSource = 'can';
  if (isBleButton) {
    trigType = 'ble_button';
    trigSource = 'ble';
  } else if (isBlePresence) {
    trigType = 'ble_presence';
    trigSource = 'ble';
  } else if (isWifi) {
    trigType = 'wifi_event';
    trigSource = 'wifi';
  }

  return regenerateTriggerIds({
    ...raw,
    source: trigSource,
    type: trigType,
    ble_event: isBlePresence ? (raw.device_property === 'away' || raw.target_bool === false ? 'away' : 'present') : raw.ble_event,
    to: raw.value ?? raw.state ?? (typeof raw.match === 'string' ? raw.match : undefined),
    to_payload: raw.match ?? raw.match_payload
  } as AutomationTrigger);
}

