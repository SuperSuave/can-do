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
 * Compiles an AutomationCondition into a structured logic block (and/or/not) or masked leaf
 */
export function compileCondition(cond: AutomationCondition): any {
  if (cond.logic === 'and' || cond.type === 'and_group') {
    return {
      logic: 'and',
      conditions: (cond.conditions || []).map(compileCondition)
    };
  }
  if (cond.logic === 'or' || cond.type === 'or_group') {
    return {
      logic: 'or',
      conditions: (cond.conditions || []).map(compileCondition)
    };
  }
  if (cond.logic === 'not' || cond.type === 'not_group') {
    return {
      logic: 'not',
      conditions: (cond.conditions || []).map(compileCondition)
    };
  }

  // Leaf condition
  const match = compileToByteMap(cond.match || cond.match_payload);
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
 * Compiles an AutomationAction into an entity_command, transmit, delay, if_then, or choose block
 */
export function compileAction(act: AutomationAction): any {
  if (act.type === 'if_then') {
    return {
      type: 'if_then',
      conditions: (act.conditions || []).map(compileCondition),
      then: (act.then || []).map(compileAction),
      else: (act.else || []).map(compileAction)
    };
  }

  if (act.type === 'choose') {
    return {
      type: 'choose',
      choices: (act.choices || []).map(c => ({
        conditions: (c.conditions || []).map(compileCondition),
        sequence: (c.sequence || []).map(compileAction)
      })),
      default: (act.default || []).map(compileAction)
    };
  }

  if (act.type === 'delay') {
    return {
      type: 'delay',
      ms: act.delay_ms || act.ms || 500
    };
  }

  if (act.type === 'entity_command' || act.entity_id) {
    return {
      type: 'entity_command',
      entity_id: act.entity_id || act.source_command_id || 'drivers_seat_comfort',
      command: act.command || act.option_label || 'Medium Cool'
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
 * Compiles a single AutomationRule into a clean, wildcard-free schema conforming strictly
 * to docs/architecture.md and the exact outcome format.
 */
export function compileAutomationRule(rule: AutomationRule): any {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled ?? true,
    ha_expose: rule.ha_expose ?? true,
    ha_icon: rule.ha_icon || 'mdi:car-cog',
    exec_mode: rule.exec_mode || 'one_shot',
    cooldown_ms: rule.cooldown_ms ?? 500,
    triggers: (rule.triggers || []).map(trig => {
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
    actions: (rule.actions || []).map(compileAction)
  };
}

/**
 * Generate standard WiCAN / CAN Do format strictly matching the exact architecture outcome
 */
export function exportToCandoJson(
  rules: AutomationRule[],
  settings: AutomationSettings = {}
): string {
  const exportPayload = {
    settings: {
      vehicle_model: settings.vehicle_model || 'all_egmp',
      unit_system: settings.unit_system || 'imperial',
      firmware_version: settings.firmware_version || '2.0.0'
    },
    rules: rules.map(compileAutomationRule)
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
  const cleanAutomations = rules.map(compileAutomationRule);

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
  settings: AutomationSettings = {}
): string {
  const modeMap: Record<string, number> = {
    one_shot: 0,
    toggle: 1,
    continuous_hold: 2,
    on_change: 3,
    poll_verify: 4
  };

  const firmwareRules: Esp32FirmwareRule[] = rules.map(r => {
    const compiled = compileAutomationRule(r);
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

  return {
    id: trigId,
    type: 'byte_transition',
    source: 'can',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    byte: targetByte,
    mask: '0xF0',
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

  return {
    id: condId,
    type: 'can_state',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    match: cleanMatch,
    evaluate: {
      byte: dKey,
      byte_index: isNaN(byteIdx) ? 0 : byteIdx,
      operator: 'equal',
      value: targetVal
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
