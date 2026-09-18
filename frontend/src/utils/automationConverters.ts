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
import { Command, CommandOption, Catalog, ByteMap } from '../types/catalog';
import { DEFAULT_CATALOG } from '../data/defaultCatalog';

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

  const match = compileToByteMap(cond.match || cond.evaluate?.match || cond.payload);
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
    return {
      type: 'climate_target',
      target_c: act.target_temp_c ?? act.target_c ?? 21.0,
      zone: act.zone || 'driver',
      sync_on: act.sync_on ?? false,
      driver_only: act.driver_only ?? false
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
    const cmd = (catalog?.commands || []).find(c => c.id === entityId);

    if (cmd) {
      if (cmd.type === 'climate_target') {
        return {
          type: 'climate_target',
          target_c: act.target_temp_c ?? (cmd as any).target_temp_c ?? 21.0,
          zone: act.zone || (cmd as any).climate_zone || 'driver',
          sync_on: act.sync_on ?? (cmd as any).climate_sync_on ?? true,
          driver_only: act.driver_only ?? (cmd as any).climate_driver_only ?? false
        };
      }

      if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
        return {
          type: 'precondition',
          mode: act.precon_mode || (cmd as any).precon_mode || 'persistent',
          action: act.precon_action || (act.precon_mode === 'cancel' ? 'stop' : 'start')
        };
      }

      // Match designated option
      const opt = (cmd.options || []).find(
        o => o.label === commandLabel || (commandLabel && o.label?.toLowerCase() === commandLabel.toLowerCase())
      ) || (cmd.options || []).find(o => o.default) || (cmd.options || [])[0];

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
      entity_id: entityId || 'drivers_seat_comfort',
      command: commandLabel || 'Medium Cool'
    };
  }

  const payload = compileToByteMap(act.payload || act.to_payload);
  return {
    type: 'transmit',
    can_id: act.can_id || '0x000',
    bus: act.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
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
        can_id: trig.can_id || '0x448',
        bus: trig.bus ?? 0,
        byte: targetByte,
        mask: maskHex,
        from: fromHex,
        to: toHex
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
      firmware_version: settings.firmware_version || '2.0.0',
      ntp_server: settings.ntp_server || 'pool.ntp.org',
      timezone: settings.timezone || 'UTC'
    },
    rules: rules.map(r => compileAutomationRule(r, catalog))
  };

  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Generate full can_do_catalog.json with embedded automations array ready for ESP32 LittleFS
 */
export function exportToFullCatalogJson(
  catalog: Catalog,
  rules: AutomationRule[]
): string {
  const cleanAutomations = rules.map(r => compileAutomationRule(r, catalog));

  return JSON.stringify({
    ...catalog,
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
export function commandToTrigger(cmd: Command, opt?: CommandOption): AutomationTrigger {
  const trigId = `trig_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x448';
  const match = compileToByteMap(opt?.match || cmd.match || opt?.payload || cmd.payload);
  const targetByte = Object.keys(match)[0] || 'D7';
  const targetTo = match[targetByte] || '0x10';

  const rawMask = opt?.mask || cmd.mask;
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
    option_label: opt?.label
  };
}

/**
 * Convert a Catalog Command into an Automation Condition
 */
export function commandToCondition(cmd: Command, opt?: CommandOption): AutomationCondition {
  const condId = `cond_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x000';
  const match = compileToByteMap(opt?.match || cmd.match || opt?.payload || cmd.payload);
  const cleanMatch = Object.keys(match).length > 0 ? match : { D1: '0x01' };
  const dKey = Object.keys(cleanMatch)[0] || 'D1';
  const targetVal = cleanMatch[dKey] || '0x01';
  const byteIdx = parseInt(dKey.replace(/\D/g, ''), 10) - 1;

  const rawMask = opt?.mask || cmd.mask;
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
    evaluate: {
      byte: dKey,
      byte_index: isNaN(byteIdx) ? 0 : byteIdx,
      operator: 'equal',
      value: targetVal,
      mask: targetMask
    },
    invert: false,
    source_command_id: cmd.id,
    source_command_name: cmd.name || cmd.ha_metadata?.name || cmd.id,
    option_label: opt?.label
  };
}

/**
 * Convert a Catalog Command into an Automation Action
 */
export function commandToAction(cmd: Command, opt?: CommandOption): AutomationAction {
  const actId = `act_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || '0x000';
  const cmdDisplayName = cmd.name || cmd.ha_metadata?.name || cmd.id;

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
      precon_mode: (opt as any)?.precon_mode || 'persistent',
      precon_action: (opt as any)?.precon_mode === 'cancel' ? 'stop' : 'start',
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: opt?.label
    };
  }

  if ((cmd.options && cmd.options.length > 0) || opt?.label) {
    return {
      id: actId,
      type: 'entity_command',
      entity_id: cmd.id,
      command: opt?.label || 'Medium Cool',
      can_id: canId,
      bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
      popup_message: opt?.popup || `${cmdDisplayName} - ${opt?.label || 'Medium Cool'}`,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: opt?.label
    };
  }

  const payload = compileToByteMap(opt?.payload || cmd.payload || (cmd.steps && cmd.steps[0]?.payload));
  return {
    id: actId,
    type: 'can_tx',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
    repeat: opt?.repeat || 1,
    delay_ms: 50,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName
  };
}
