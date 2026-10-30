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
import { resolveVariant, getEffectiveOptions } from './catalogUtils';

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

/**
 * Compiles a condition into standard CAN Do schema
 */
export function compileCondition(cond: AutomationCondition, catalog: Catalog = DEFAULT_CATALOG): any {
  if (cond.logic === 'and' || cond.logic === 'or' || cond.logic === 'not') {
    const subConds = (cond.conditions || []).map(c => compileCondition(c, catalog));
    if (cond.logic === 'and') return { and: subConds };
    if (cond.logic === 'or') return { or: subConds };
    if (cond.logic === 'not') return { not: subConds[0] || {} };
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
          return { or: subConds };
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
      ...(cond.target_rssi !== undefined ? { target_rssi: cond.target_rssi } : {})
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

  if (cond.type === 'ble_device' || cond.type === 'ble_presence') {
    return {
      type: 'ble_device',
      device_property: cond.device_property || 'connected',
      ...(cond.ble_device ? { ble_device: cond.ble_device } : {}),
      ...(cond.target_bool !== undefined ? { target_bool: cond.target_bool } : {}),
      ...(cond.target_rssi !== undefined ? { target_rssi: cond.target_rssi } : {}),
      ...(cond.operator ? { operator: cond.operator } : {})
    };
  }

  if (cond.type === 'voltage') {
    const rawVal = cond.value || cond.voltage_val || '12.4';
    const numVal = parseFloat(String(rawVal)) || 12.4;
    return {
      type: 'voltage',
      operator: cond.operator || (cond.voltage_dir === 'below' ? 'less' : 'greater'),
      value: numVal
    };
  }

  if (cond.type === 'param_range') {
    return {
      type: 'param_range',
      can_id: cond.can_id || '0x100',
      operator: cond.operator || (cond.voltage_dir === 'above' ? 'greater' : 'less'),
      value: cond.value || cond.voltage_val || '50'
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
      ...(cond.option_label ? { option_label: cond.option_label } : {})
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
    ...(cond.option_label ? { option_label: cond.option_label } : {})
  };
}

/**
 * Compiles an AutomationAction into an inlined transmit sequence, delay, if_then, choose, popup, or climate target
 */
export function compileAction(act: AutomationAction, catalog: Catalog = DEFAULT_CATALOG): any | any[] {
  if (act.type === 'if_then') {
    return {
      type: 'if_then',
      conditions: (act.conditions || []).map(c => compileCondition(c, catalog)),
      then: compileActionList(act.then || [], catalog),
      else: compileActionList(act.else || [], catalog)
    };
  }

  if (act.type === 'choose') {
    return {
      type: 'choose',
      choices: (act.choices || []).map(c => ({
        conditions: (c.conditions || []).map(cond => compileCondition(cond, catalog)),
        sequence: compileActionList(c.sequence || [], catalog)
      })),
      default: compileActionList(act.default || [], catalog)
    };
  }

  if (act.type === 'repeat_until' || act.type === 'wait_for') {
    return {
      type: act.type,
      interval_ms: act.interval_ms || 1000,
      timeout_ms: act.timeout_ms || 30000,
      condition: act.condition ? compileCondition(act.condition, catalog) : undefined,
      sequence: act.sequence ? compileActionList(act.sequence, catalog) : undefined
    };
  }

  if (act.type === 'delay') {
    return {
      type: 'delay',
      ms: act.delay_ms || act.ms || 500
    };
  }

  if (act.type === 'track_popup' || act.type === 'popup') {
    return {
      type: 'track_popup',
      level: act.level || 'info',
      text: act.text || act.popup_message || ''
    };
  }

  if (act.type === 'climate_target' || act.type === 'remote_climate') {
    const tempC = act.target_temp_c ?? act.target_c ?? 22.0;
    return {
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
      type: 'choose',
      choices,
      default: compileActionList(defaultActs, catalog)
    };
  }

  if (act.type === 'precondition') {
    return {
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

    if (act.steps && act.steps.length > 1) {
      const inlinedSteps: any[] = [];
      act.steps.forEach((step: any, idx: number) => {
        if (step.type === 'delay') {
          inlinedSteps.push({
            type: 'delay',
            ms: step.delay_ms || step.dwell_ms || step.ms || 500
          });
          return;
        }
        let stepPayload = compileToByteMap(step.payload);
        if (Object.keys(stepPayload).length === 0 && fallbackOptSteps && fallbackOptSteps[idx]?.payload) {
          stepPayload = compileToByteMap(fallbackOptSteps[idx].payload);
        }
        inlinedSteps.push({
          type: 'transmit',
          can_id: formatCanId(step.can_id || act.can_id || '0x000'),
          bus: step.bus ?? act.bus ?? 0,
          payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
          repeat: step.repeat ?? act.repeat ?? 1,
          ...(idx === 0 ? {
            ...(act.source_command_id ? { source_command_id: act.source_command_id } : {}),
            ...(act.source_command_name ? { source_command_name: act.source_command_name } : {}),
            ...(act.option_label ? { option_label: act.option_label } : {}),
            ...(act.entity_id ? { entity_id: act.entity_id } : {})
          } : {})
        });
        const delayBetween = step.delay_ms ?? act.delay_ms ?? 0;
        if (idx < act.steps!.length - 1 && delayBetween > 0) {
          inlinedSteps.push({
            type: 'delay',
            ms: delayBetween
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
          { type: 'delay', ms: 25 },
          { type: 'transmit', can_id: '0x48F', bus: busVal, payload: doorStage1, repeat: 2 },
          { type: 'delay', ms: 25 },
          { type: 'transmit', can_id: '0x48F', bus: busVal, payload: latchCommit, repeat: 2 }
        );
      }

      return inlinedSteps;
    }

    const payload = compileToByteMap(act.payload || act.to_payload);
    return {
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
          type: 'transmit',
          can_id: '0x4A0',
          bus: 0,
          payload: isPass ? { D8: hexVal } : { D2: hexVal },
          repeat: 1
        };
      }

      if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
        return {
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
        const inlinedSteps: any[] = [];
        opt.steps.forEach((step: any, idx: number) => {
          if (step.type === 'delay') {
            inlinedSteps.push({
              type: 'delay',
              ms: step.delay_ms || step.dwell_ms || step.ms || 500
            });
            return;
          }
          if (step.type === 'repeat_until' || step.type === 'wait_for') {
            inlinedSteps.push({
              type: step.type,
              interval_ms: step.interval_ms || 1000,
              timeout_ms: step.timeout_ms || 30000,
              condition: step.condition ? compileCondition(step.condition) : undefined,
              sequence: step.sequence ? compileActionList(step.sequence, catalog) : undefined
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
              ms: step.delay_ms
            });
          } else if (idx < opt.steps.length - 1 && delayMs > 0) {
            inlinedSteps.push({
              type: 'delay',
              ms: delayMs
            });
          }
        });

        const has48F = inlinedSteps.some(s => s.type === 'transmit' && formatCanId(s.can_id) === '0x48F');
        if (entityId === 'ambient_mood_lighting' && !has48F && inlinedSteps.length >= 2 && inlinedSteps[0]?.type === 'transmit') {
          const dashStage1 = inlinedSteps[0].payload;
          const doorStage1 = getAmbientDoorPayload(opt?.label || commandLabel, dashStage1);
          const latchCommit = compileToByteMap('0002082000000000');
          inlinedSteps.push(
            { type: 'delay', ms: 25 },
            { type: 'transmit', can_id: '0x48F', bus: bus, payload: doorStage1, repeat: 2 },
            { type: 'delay', ms: 25 },
            { type: 'transmit', can_id: '0x48F', bus: bus, payload: latchCommit, repeat: 2 }
          );
        }

        return inlinedSteps;
      }

      // Case B: Option defines a single payload
      if (opt?.payload) {
        const p = compileToByteMap(opt.payload);
        return {
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
        const inlinedSteps: any[] = [];
        cmd.steps.forEach((step: any, idx: number) => {
          const stepPayload = compileToByteMap(step.payload);
          inlinedSteps.push({
            type: 'transmit',
            can_id: step.can_id || canId,
            bus: step.bus ?? bus,
            payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
            repeat: step.repeat || 1,
            ...(idx === 0 ? {
              source_command_id: entityId,
              source_command_name: cmd.ha_metadata?.name || cmd.name || cmd.id,
              option_label: opt?.label || commandLabel,
              entity_id: entityId
            } : {})
          });
          if (idx < cmd.steps.length - 1 && delayMs > 0) {
            inlinedSteps.push({
              type: 'delay',
              ms: delayMs
            });
          }
        });
        return inlinedSteps;
      }

      // Case D: Command defines root payload
      if (cmd.payload) {
        const p = compileToByteMap(cmd.payload);
        return {
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
    }

    // Fallback: If can_id and payload provided, transmit it; otherwise entity_command
    if (act.can_id && act.payload) {
      const payload = compileToByteMap(act.payload || act.to_payload);
      return {
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
      type: 'entity_command',
      entity_id: entityId || '',
      command: commandLabel || ''
    };
  }

  const payload = compileToByteMap(act.payload || act.to_payload);
  return {
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
  const result: any[] = [];
  for (const act of actions) {
    const compiled = compileAction(act, catalog);
    if (Array.isArray(compiled)) {
      result.push(...compiled);
    } else if (compiled) {
      result.push(compiled);
    }
  }
  return deduplicateActionSequence(result);
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
    ha_icon: rule.ha_icon || 'mdi:car-cog',
    exec_mode: rule.exec_mode || 'one_shot',
    trigger_mode: rule.trigger_mode || 'any',
    cooldown_ms: rule.cooldown_ms ?? 500,
    triggers: (rule.triggers || []).map(trig => {
      const baseTrigger = {
        id: trig.id,
        ...(trig.source_command_id ? { source_command_id: trig.source_command_id } : {}),
        ...(trig.source_command_name ? { source_command_name: trig.source_command_name } : {}),
        ...(trig.option_label ? { option_label: trig.option_label } : {})
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

      if (trig.type === 'ble_device_event' || trig.type === 'ble_device' || trig.type === 'ble_presence' || trig.source === 'ble') {
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

      const targetByte = trig.byte || (trig.match ? Object.keys(trig.match)[0] : undefined) || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : 'D7');
      const fromHex = trig.from || (trig.from_value !== undefined ? `0x${trig.from_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x00');
      const toHex = trig.to || (trig.match && trig.match[targetByte]) || (trig.to_value !== undefined ? `0x${trig.to_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x10');
      const maskHex = trig.mask || '0xF0';

      return {
        ...baseTrigger,
        type: 'byte_transition',
        can_id: trig.can_id || '',
        bus: trig.bus ?? 0,
        byte: targetByte || '',
        mask: maskHex || '',
        from: fromHex || '',
        to: toHex || ''
      };
    }),
    conditions: (rule.conditions || []).map(c => compileCondition(c, catalog)),
    actions: compileActionList(rule.actions || [], catalog)
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

  const rawSteps = chosenOpt?.steps || (chosenOpt?.payload ? undefined : cmd.steps);
  const cleanSteps: AutomationActionStep[] | undefined = rawSteps && rawSteps.length > 0
    ? rawSteps.map(s => ({
        can_id: s.can_id || canId,
        bus: s.bus ?? (cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0),
        payload: compileToByteMap(s.payload),
        repeat: s.repeat ?? 1,
        delay_ms: s.delay_ms ?? 0
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
  if (trig.source_command_id) {
    const rawCmd = index.byId.get(trig.source_command_id);
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
    const stateMatching = rawCands.filter(c => normalizeCanId(c.network?.state_can_id || c.state_can_id) === normCanId);
    const candidateCmds = stateMatching.length > 0 ? stateMatching : rawCands;

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
  const rawTargetId = act.source_command_id || act.entity_id;
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
  if (nameHint.trim()) {
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
    const actionMatching = rawCands.filter(c => normalizeCanId(c.network?.action_can_id || c.action_can_id) === normCanId);
    const candidateCmds = actionMatching.length > 0 ? actionMatching : rawCands;

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
  if (cond.id) {
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
    const stateMatching = rawCands.filter(c => normalizeCanId(c.network?.state_can_id || c.state_can_id) === normCanId);
    const candidateCmds = stateMatching.length > 0 ? stateMatching : rawCands;

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
  const cleanSteps: AutomationActionStep[] | undefined = rawSteps && rawSteps.length > 0
    ? rawSteps.map(s => ({
        can_id: s.can_id || canId,
        bus: s.bus ?? (cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? act.bus ?? 0),
        payload: compileToByteMap(s.payload),
        repeat: s.repeat ?? 1,
        delay_ms: s.delay_ms ?? 0
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
  return regenerateConditionIds({
    ...raw,
    type: raw.type === 'ble_button' ? 'ble_button' : (raw.type === 'wifi' || raw.type === 'wifi_event' ? 'wifi' : (raw.can_id ? 'can_state' : 'can_state')),
    operator: 'equal',
    value: raw.to ?? raw.value ?? raw.to_value ?? raw.match_payload,
    match: raw.to_payload ?? raw.match ?? raw.match_payload,
  } as AutomationCondition);
}

export function convertConditionToTrigger(condition: AutomationCondition): AutomationTrigger {
  const raw = deepClone(condition) as Record<string, any>;
  delete raw.id;
  delete raw._clientId;
  return regenerateTriggerIds({
    ...raw,
    source: raw.type === 'ble_button' ? 'ble' : (raw.type === 'wifi' ? 'wifi' : 'can'),
    type: raw.type === 'ble_button' ? 'ble_button' : 'byte_transition',
    to: raw.value ?? raw.state ?? (typeof raw.match === 'string' ? raw.match : undefined),
    to_payload: raw.match ?? raw.match_payload
  } as AutomationTrigger);
}

