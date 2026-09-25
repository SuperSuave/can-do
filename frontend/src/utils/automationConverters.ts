import {
  AutomationRule,
  AutomationSettings,
  CandoRulesExport,
  Esp32FirmwareConfig,
  Esp32FirmwareRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';
import { Command, CommandOption, Catalog, ByteMap, Vehicle } from '../types/catalog';
import { DEFAULT_CATALOG } from '../data/defaultCatalog';
import { resolveVariant, getEffectiveOptions } from './catalogUtils';

/**
 * Cleanly compiles any payload or glob into a strict 1-based ByteMap ({ D1: "0x.." })
 */
export function compileToByteMap(input: string | ByteMap | undefined): ByteMap {
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
 * Compiles a condition into standard CAN Do schema
 */
export function compileCondition(cond: AutomationCondition): any {
  if (cond.logic === 'and' || cond.logic === 'or' || cond.logic === 'not') {
    const subConds = (cond.conditions || []).map(compileCondition);
    if (cond.logic === 'and') return { and: subConds };
    if (cond.logic === 'or') return { or: subConds };
    if (cond.logic === 'not') return { not: subConds[0] || {} };
  }

  if (cond.type === 'time_condition' || cond.type === 'time') {
    return {
      type: 'time_condition',
      start_time: cond.start_time || '08:00',
      end_time: cond.end_time || '18:00',
      days: cond.days && cond.days.length > 0 ? cond.days : ['mon', 'tue', 'wed', 'thu', 'fri']
    };
  }

  if (cond.type === 'param_range' || cond.type === 'voltage') {
    return {
      type: 'param_range',
      can_id: cond.can_id || '0x100',
      operator: cond.operator || (cond.voltage_dir === 'above' ? 'greater' : 'less'),
      value: cond.value || cond.voltage_val || '50'
    };
  }

  const match = compileToByteMap(cond.match || (cond as any).evaluate?.match || (cond as any).payload || cond.match_payload);
  const dKey = cond.byte || cond.evaluate?.byte || Object.keys(match)[0] || 'D1';
  const targetVal = cond.value || cond.evaluate?.value || match[dKey] || '0x01';
  const maskVal = cond.mask || cond.evaluate?.mask || '0xFF';
  const op = cond.operator || cond.evaluate?.operator || (cond.invert ? 'not_equal' : 'equal');

  return {
    can_id: cond.can_id || '0x000',
    bus: cond.bus ?? 0,
    byte: dKey,
    mask: maskVal,
    operator: op,
    value: targetVal
  };
}

/**
 * Compiles an AutomationAction into an inlined transmit sequence, delay, if_then, choose, popup, or climate target
 */
export function compileAction(act: AutomationAction, catalog: Catalog = DEFAULT_CATALOG): any | any[] {
  if (act.type === 'if_then') {
    return {
      type: 'if_then',
      conditions: (act.conditions || []).map(compileCondition),
      then: compileActionList(act.then || [], catalog),
      else: compileActionList(act.else || [], catalog)
    };
  }

  if (act.type === 'choose') {
    return {
      type: 'choose',
      choices: (act.choices || []).map(c => ({
        conditions: (c.conditions || []).map(compileCondition),
        sequence: compileActionList(c.sequence || [], catalog)
      })),
      default: compileActionList(act.default || [], catalog)
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

  if (act.type === 'climate_target') {
    const isPass = act.zone === 'passenger';
    const tempC = act.target_temp_c ?? act.target_c ?? 21.0;
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

  if (act.type === 'precondition') {
    return {
      type: 'precondition',
      mode: act.precon_mode || 'persistent',
      action: act.precon_action || (act.precon_mode === 'cancel' ? 'stop' : 'start')
    };
  }

  // Handle entity_command: Inline catalog command definition into native CAN transmit bursts
  if (act.type === 'entity_command' || act.entity_id || act.source_command_id) {
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

      // Case A: Option defines multi-step burst (e.g. heated/cooled seat sequence)
      if (opt?.steps && opt.steps.length > 0) {
        const inlinedSteps: any[] = [];
        opt.steps.forEach((step: any, idx: number) => {
          const stepPayload = compileToByteMap(step.payload);
          inlinedSteps.push({
            type: 'transmit',
            can_id: step.can_id || canId,
            bus: step.bus ?? bus,
            payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
            repeat: step.repeat || 1
          });
          if (idx < opt.steps.length - 1 && delayMs > 0) {
            inlinedSteps.push({
              type: 'delay',
              ms: delayMs
            });
          }
        });
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
          repeat: opt.repeat || 1
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
            repeat: step.repeat || 1
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
          repeat: cmd.repeat || 1
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
        repeat: act.repeat || 1
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
  return result;
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
    cooldown_ms: rule.cooldown_ms ?? 500,
    triggers: (rule.triggers || []).map(trig => {
      if (trig.type === 'time_schedule' || trig.source === 'time' || trig.time) {
        return {
          type: 'time_schedule',
          time: trig.time || '07:30',
          days: trig.days && trig.days.length > 0 ? trig.days : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
        };
      }

      const targetByte = trig.byte || (trig.match ? Object.keys(trig.match)[0] : undefined) || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : 'D7');
      const fromHex = trig.from || (trig.from_value !== undefined ? `0x${trig.from_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x00');
      const toHex = trig.to || (trig.match && trig.match[targetByte]) || (trig.to_value !== undefined ? `0x${trig.to_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x10');
      const maskHex = trig.mask || '0xF0';

      return {
        type: 'byte_transition',
        can_id: trig.can_id || '',
        bus: trig.bus ?? 0,
        byte: targetByte || '',
        mask: maskHex || '',
        from: fromHex || '',
        to: toHex || ''
      };
    }),
    conditions: (rule.conditions || []).map(compileCondition),
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
      firmware_version: settings.firmware_version || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2026.9.5'),
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
 * Generate compact ESP32 firmware-ready JSON structure (flat, numeric, memory-optimized for C)
 */
export function exportToEsp32FirmwareJson(
  rules: AutomationRule[],
  settings: AutomationSettings = {},
  catalog: Catalog = DEFAULT_CATALOG
): string {
  const modeMap: Record<string, number> = {
    one_shot: 0,
    toggle: 1,
    continuous_hold: 2,
    on_change: 3,
    poll_verify: 4
  };

  const firmwareRules: Esp32FirmwareRule[] = rules.map(r => {
    const compiled = compileAutomationRule(r, catalog);
    return {
      id: compiled.id,
      name: compiled.name,
      en: compiled.enabled ? 1 : 0,
      mode: modeMap[compiled.exec_mode] ?? 0,
      trig_op: r.trigger_mode === 'all' ? 1 : 0,
      cd_ms: compiled.cooldown_ms || 500,
      trigs: compiled.triggers.map((t: any) => ({
        id: `trig_${t.can_id}`,
        can_id: t.can_id || '0x000',
        bus: t.bus ?? 0,
        byte: t.byte,
        mask: t.mask || '0xF0',
        from: t.from,
        to: t.to
      })),
      conds: compiled.conditions,
      acts: compiled.actions
    };
  });

  const payload: Esp32FirmwareConfig = {
    v: 2,
    vehicle: settings.vehicle_model || 'all_egmp',
    rules: firmwareRules
  };

  return JSON.stringify(payload, null, 2);
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
  const match = compileToByteMap(chosenOpt?.match || cmd.match || chosenOpt?.payload || cmd.payload);
  const cleanMatch = Object.keys(match).length > 0 ? match : { D1: '0x01' };
  const dKey = Object.keys(cleanMatch)[0] || 'D1';
  const targetVal = cleanMatch[dKey] || '0x01';
  const byteIdx = parseInt(dKey.replace(/\D/g, ''), 10) - 1;

  const rawMask = chosenOpt?.mask || cmd.mask;
  let targetMask = '0xFF';
  if (typeof rawMask === 'string') {
    targetMask = rawMask;
  } else if (rawMask && typeof rawMask === 'object') {
    targetMask = (rawMask as ByteMap)[dKey] || '0xFF';
  }

  return {
    id: condId,
    type: 'can_state',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    match: cleanMatch,
    byte: dKey,
    mask: targetMask,
    operator: 'equal',
    value: targetVal,
    evaluate: {
      byte: dKey,
      byte_index: isNaN(byteIdx) ? 0 : byteIdx,
      operator: 'equal',
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

  if ((cmd.options && cmd.options.length > 0) || chosenOpt?.label) {
    const payload = compileToByteMap(chosenOpt?.payload || (chosenOpt?.steps && chosenOpt?.steps[0]?.payload) || cmd.payload);
    return {
      id: actId,
      type: 'entity_command',
      entity_id: cmd.id,
      command: chosenOpt?.label || 'Toggle',
      can_id: canId,
      bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
      payload: Object.keys(payload).length > 0 ? payload : undefined,
      popup_message: chosenOpt?.popup || `${cmdDisplayName} - ${chosenOpt?.label || 'Toggle'}`,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: chosenOpt?.label
    };
  }

  const payload = compileToByteMap(chosenOpt?.payload || cmd.payload || (cmd.steps && cmd.steps[0]?.payload));
  return {
    id: actId,
    type: 'can_tx',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
    repeat: chosenOpt?.repeat || 1,
    delay_ms: 50,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    option_label: chosenOpt?.label
  };
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

  // 1. Direct ID match
  if (trig.source_command_id) {
    const rawCmd = catalog.commands.find(c => c.id === trig.source_command_id);
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
      const swMenu = catalog.commands.find(c => c.id === 'sw_menu');
      if (swMenu) {
        const cmd = resolveVariant(swMenu, null);
        const opt = findMatchingOptionForTrigger(cmd, trig);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 3. Match by CAN ID
  if (trig.can_id) {
    const normCanId = trig.can_id.toLowerCase();
    const candidateCmds = catalog.commands.filter(c => {
      const stateId = (c.network?.state_can_id || c.state_can_id || '').toLowerCase();
      const actionId = (c.network?.action_can_id || c.action_can_id || '').toLowerCase();
      return stateId === normCanId || actionId === normCanId;
    });

    if (candidateCmds.length === 1) {
      const cmd = resolveVariant(candidateCmds[0], null);
      const opt = findMatchingOptionForTrigger(cmd, trig);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      // Find candidate whose options match byte/value
      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
        const opt = findMatchingOptionForTrigger(cmd, trig);
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
      const cmd = resolveVariant(candidateCmds[0], null);
      return { command: cmd, matchedOption: cmd.options?.[0] };
    }
  }

  return {};
}

function findMatchingOptionForTrigger(cmd: Command, trig: AutomationTrigger): CommandOption | undefined {
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
  const trigValHex = trig.to
    ? (trig.to.startsWith('0x') ? trig.to : `0x${trig.to}`).toLowerCase()
    : trig.to_value !== undefined
    ? `0x${trig.to_value.toString(16).padStart(2, '0')}`.toLowerCase()
    : undefined;

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
  return cmd.options.find(o => o.default) || cmd.options[0];
}

/**
 * Resolves the catalog command and matched option for an action.
 */
export function resolveCatalogCommandForAction(
  act: AutomationAction,
  catalog: Catalog
): { command?: Command; matchedOption?: CommandOption } {
  if (!catalog?.commands) return {};

  const targetId = act.source_command_id || act.entity_id;
  if (targetId) {
    const rawCmd = catalog.commands.find(c => c.id === targetId);
    if (rawCmd) {
      const cmd = resolveVariant(rawCmd, null);
      const opt = findMatchingOptionForAction(cmd, act);
      return { command: cmd, matchedOption: opt };
    }
  }

  if (act.can_id) {
    const normCanId = act.can_id.toLowerCase();
    const candidateCmds = catalog.commands.filter(c => {
      const actionId = (c.network?.action_can_id || c.action_can_id || '').toLowerCase();
      const stateId = (c.network?.state_can_id || c.state_can_id || '').toLowerCase();
      return actionId === normCanId || stateId === normCanId;
    });

    if (candidateCmds.length === 1) {
      const cmd = resolveVariant(candidateCmds[0], null);
      const opt = findMatchingOptionForAction(cmd, act);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
        const opt = findMatchingOptionForAction(cmd, act);
        if (opt) return { command: cmd, matchedOption: opt };
      }
      const cmd = resolveVariant(candidateCmds[0], null);
      return { command: cmd, matchedOption: cmd.options?.[0] };
    }
  }

  return {};
}

function findMatchingOptionForAction(cmd: Command, act: AutomationAction): CommandOption | undefined {
  if (!cmd.options || cmd.options.length === 0) return undefined;
  const labelToMatch = act.option_label || act.command;
  if (labelToMatch) {
    const target = labelToMatch.toLowerCase().trim();
    const byExact = cmd.options.find(o => o.label.toLowerCase().trim() === target);
    if (byExact) return byExact;
    const byPartial = cmd.options.find(o => {
      const l = o.label.toLowerCase().trim();
      return l === target || l.startsWith(target) || target.startsWith(l);
    });
    if (byPartial) return byPartial;
  }
  if (act.payload && typeof act.payload === 'object') {
    for (const opt of cmd.options) {
      const optMap = compileToByteMap(opt.payload || (opt.steps && opt.steps[0]?.payload) || opt.match);
      const optKeys = Object.keys(optMap);
      if (optKeys.length > 0 && optKeys.every(k => {
        const aVal = String((act.payload as any)[k] || '').toLowerCase();
        const oVal = String(optMap[k] || '').toLowerCase();
        return aVal === oVal;
      })) {
        return opt;
      }
    }
    // If we tried to match a payload and none matched perfectly, don't guess the default option.
    // This prevents trailing sequence steps (like D5: 0xFF) from falsely rendering as "Off".
    return undefined;
  }
  return cmd.options.find(o => o.default) || cmd.options[0];
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

  // 1. Direct ID match
  if (cond.source_command_id) {
    const rawCmd = catalog.commands.find(c => c.id === cond.source_command_id);
    if (rawCmd) {
      const cmd = resolveVariant(rawCmd, null);
      const opt = findMatchingOptionForCondition(cmd, cond);
      return { command: cmd, matchedOption: opt };
    }
  }

  // 2. ID name hint match (e.g. cond_gear_drive -> gear_selector)
  if (cond.id) {
    const lowerId = cond.id.toLowerCase();
    for (const c of catalog.commands) {
      if (lowerId.includes(c.id.toLowerCase())) {
        const cmd = resolveVariant(c, null);
        const opt = findMatchingOptionForCondition(cmd, cond);
        return { command: cmd, matchedOption: opt };
      }
    }
  }

  // 3. Match by CAN ID
  if (cond.can_id) {
    const normCanId = cond.can_id.toLowerCase();
    const candidateCmds = catalog.commands.filter(c => {
      const stateId = (c.network?.state_can_id || c.state_can_id || '').toLowerCase();
      const actionId = (c.network?.action_can_id || c.action_can_id || '').toLowerCase();
      return stateId === normCanId || actionId === normCanId;
    });

    if (candidateCmds.length === 1) {
      const cmd = resolveVariant(candidateCmds[0], null);
      const opt = findMatchingOptionForCondition(cmd, cond);
      return { command: cmd, matchedOption: opt };
    }

    if (candidateCmds.length > 1) {
      for (const raw of candidateCmds) {
        const cmd = resolveVariant(raw, null);
        const opt = findMatchingOptionForCondition(cmd, cond);
        if (opt) return { command: cmd, matchedOption: opt };
      }
      const cmd = resolveVariant(candidateCmds[0], null);
      return { command: cmd, matchedOption: cmd.options?.[0] };
    }
  }

  return {};
}

function findMatchingOptionForCondition(cmd: Command, cond: AutomationCondition): CommandOption | undefined {
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
  const targetHex = targetVal
    ? (targetVal.startsWith('0x') || targetVal.startsWith('0X') ? targetVal : `0x${targetVal}`).toLowerCase()
    : undefined;

  if (byteKey && targetHex) {
    for (const opt of cmd.options) {
      const match = compileToByteMap(opt.match || opt.payload);
      if (match[byteKey] && match[byteKey].toLowerCase() === targetHex) {
        return opt;
      }
    }
  }

  return cmd.options.find(o => o.default) || cmd.options[0];
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
  const payload = compileToByteMap(opt.payload || (opt.steps && opt.steps[0]?.payload) || cmd.payload);

  if (act.type === 'entity_command' || (cmd.options && cmd.options.length > 0)) {
    return {
      ...act,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      entity_id: cmd.id,
      command: opt.label,
      option_label: opt.label,
      can_id: canId,
      bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? act.bus ?? 0,
      payload: Object.keys(payload).length > 0 ? payload : act.payload,
      popup_message: opt.popup || `${cmdDisplayName} - ${opt.label}`
    };
  }

  return {
    ...act,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    command: opt.label,
    option_label: opt.label,
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? act.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : act.payload,
    popup_message: opt.popup || act.popup_message
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
  let targetMask = '0xFF';
  if (typeof rawMask === 'string') {
    targetMask = rawMask;
  } else if (rawMask && typeof rawMask === 'object') {
    targetMask = (rawMask as ByteMap)[dKey] || '0xFF';
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
