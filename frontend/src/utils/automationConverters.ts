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
 * Cleanly compiles any payload or glob (e.g. "* * * * * * 1*") into a strict 1-based ByteMap ({ D1: "0x.." })
 * stripping all wildcard tokens.
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

    // Remove any wildcards from nibbles like 1* -> 10, or *1 -> 01
    const hexClean = clean.replace(/\*/g, '0');
    if (hexClean) {
      const val = hexClean.startsWith('0x') || hexClean.startsWith('0X') ? hexClean : `0x${hexClean.toUpperCase()}`;
      result[dKey] = val;
    }
  });

  return result;
}

/**
 * Derives numerical byte transition (byte_index, from_value, to_value) from from/to inputs
 */
export function compileByteTransition(
  fromInput: string | ByteMap | undefined,
  toInput: string | ByteMap | undefined
): { byte_index: number; from_value: number; to_value: number } | null {
  const toMap = compileToByteMap(toInput);
  const fromMap = compileToByteMap(fromInput);

  const changedKey = Object.keys(toMap)[0] || Object.keys(fromMap)[0];
  if (!changedKey) return null;

  const byteNum = parseInt(changedKey.replace(/\D/g, ''), 10);
  if (isNaN(byteNum) || byteNum < 1 || byteNum > 8) return null;

  const byteIndex = byteNum - 1; // 0-based for C engine
  const fromHex = fromMap[changedKey] || '0x00';
  const toHex = toMap[changedKey] || '0x01';

  return {
    byte_index: byteIndex,
    from_value: parseInt(fromHex, 16) || 0,
    to_value: parseInt(toHex, 16) || 0
  };
}

/**
 * Compiles a single AutomationRule into a clean, wildcard-free schema conforming strictly
 * to docs/architecture.md and the ESP32 C++ catalog engine.
 */
export function compileAutomationRule(rule: AutomationRule): any {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled ?? true,
    ha_expose: rule.ha_expose ?? true,
    ha_icon: rule.ha_icon || 'mdi:car-cog',
    exec_mode: rule.exec_mode || 'one_shot',
    cooldown_ms: rule.cooldown_ms || 500,
    triggers: (rule.triggers || []).map(trig => {
      const match = compileToByteMap(trig.match || trig.to_payload || trig.match_payload);
      const transition = compileByteTransition(trig.from_payload, trig.to_payload || trig.match_payload || trig.match);

      const compiledTrig: Record<string, any> = {
        type: trig.source === 'preset' ? 'can_rx' : (trig.type || 'can_rx'),
        can_id: trig.can_id || '0x000',
        bus: trig.bus ?? 0,
        match: Object.keys(match).length > 0 ? match : { D1: '0x01' }
      };

      if (transition) {
        compiledTrig.byte_index = transition.byte_index;
        compiledTrig.from_value = transition.from_value;
        compiledTrig.to_value = transition.to_value;
      }
      if (trig.click_count && trig.click_count > 1) {
        compiledTrig.click_count = trig.click_count;
      }
      return compiledTrig;
    }),
    conditions: (rule.conditions || []).map(cond => {
      const match = compileToByteMap(cond.match || cond.match_payload);
      const dKey = Object.keys(match)[0] || 'D1';
      const targetVal = match[dKey] || '0x01';
      const byteIdx = parseInt(dKey.replace(/\D/g, ''), 10) - 1;

      return {
        can_id: cond.can_id || '0x000',
        bus: cond.bus ?? 0,
        match: Object.keys(match).length > 0 ? match : { D1: '0x01' },
        evaluate: {
          byte: dKey,
          byte_index: isNaN(byteIdx) ? 0 : byteIdx,
          operator: cond.operator || 'equal',
          value: targetVal
        },
        invert: cond.invert ?? false
      };
    }),
    actions: (rule.actions || []).map(act => {
      if (act.type === 'entity_command' || act.entity_id) {
        return {
          type: 'entity_command',
          entity_id: act.entity_id || act.source_command_id || 'unspecified_entity',
          command: act.command || act.option_label || 'Active',
          ...(act.popup_message ? { popup_message: act.popup_message } : {})
        };
      }

      const payload = compileToByteMap(act.payload || act.to_payload);
      const steps = act.steps?.map(s => ({
        payload: compileToByteMap(s.payload),
        repeat: s.repeat || 1,
        delay_ms: s.delay_ms || 50
      })) || [
        {
          payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
          repeat: act.repeat || 1,
          delay_ms: act.delay_ms || 50
        }
      ];

      return {
        type: 'transmit',
        can_id: act.can_id || '0x000',
        bus: act.bus ?? 0,
        payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
        steps,
        ...(act.popup_message ? { popup_message: act.popup_message } : {})
      };
    }),
    ...(rule.exec_mode === 'toggle' && rule.off_actions?.length
      ? {
          off_actions: rule.off_actions.map(oa => ({
            type: 'transmit',
            can_id: oa.can_id || '0x000',
            bus: oa.bus ?? 0,
            payload: compileToByteMap(oa.payload || oa.to_payload),
            repeat: oa.repeat || 1
          }))
        }
      : {})
  };
}

/**
 * Generate standard WiCAN / CAN Do format strictly with compiled 1-based ByteMaps (no globs)
 */
export function exportToCandoJson(
  rules: AutomationRule[],
  settings: AutomationSettings = {}
): string {
  const exportPayload: CandoRulesExport = {
    settings: {
      vehicle_model: settings.vehicle_model || 'all_egmp',
      unit_system: settings.unit_system || 'imperial',
      capture_mode: settings.capture_mode || 'auto',
      firmware_version: settings.firmware_version || '2.0.0'
    },
    rules: rules.map(rule => {
      const compiled = compileAutomationRule(rule);
      return {
        ...compiled,
        trigger: compiled.triggers[0] || { type: 'can_rx', can_id: '0x000', match: { D1: '0x01' } },
        condition: compiled.conditions[0] || { can_id: '0x000', match: {} },
        action: compiled.actions[0] || { type: 'transmit', can_id: '0x000', payload: { D1: '0x01' } }
      };
    }) as any
  };

  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Generate full can_do_catalog.json with embedded automations array ready for ESP32 LittleFS
 * Strictly with NO shell-style globs (* * * * * * 1*).
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
 * Explicit byte_index and transitions with zero string wildcards.
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
        id: t.id || `trig_${t.can_id}`,
        can_id: t.can_id || '0x000',
        bus: t.bus ?? 0,
        clicks: t.click_count || 1,
        match: t.match,
        ...(t.byte_index !== undefined ? {
          byte_index: t.byte_index,
          from_value: t.from_value,
          to_value: t.to_value
        } : {})
      })),
      conds: compiled.conditions.map((c: any) => ({
        can_id: c.can_id || '0x000',
        bus: c.bus ?? 0,
        match: c.match,
        byte_index: c.evaluate?.byte_index ?? 0,
        op: c.evaluate?.operator ?? 'equal',
        target_value: c.evaluate?.value ?? '0x01',
        inv: c.invert ? 1 : 0
      })),
      acts: compiled.actions.map((a: any) => {
        if (a.type === 'entity_command') {
          return {
            type: 'entity_command',
            entity_id: a.entity_id,
            command: a.command,
            ...(a.popup_message ? { osd: a.popup_message } : {})
          };
        }
        return {
          can_id: a.can_id || '0x000',
          bus: a.bus ?? 0,
          payload: a.payload,
          rep: a.repeat || 1,
          delay: a.delay_ms || 0,
          ...(a.steps && a.steps.length > 0
            ? { steps: a.steps.map((s: any) => ({ p: s.payload, r: s.repeat || 1, d: s.delay_ms || 0 })) }
            : {}),
          ...(a.popup_message ? { osd: a.popup_message } : {})
        };
      }),
      ...(compiled.off_actions?.length
        ? {
            off_acts: compiled.off_actions.map((oa: any) => ({
              can_id: oa.can_id || '0x000',
              bus: oa.bus ?? 0,
              payload: oa.payload,
              rep: oa.repeat || 1
            }))
          }
        : {})
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
 * Strict 1-based ByteMap, zero shell globs.
 */
export function commandToTrigger(cmd: Command, opt?: CommandOption): AutomationTrigger {
  const trigId = `trig_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x000';
  const match = compileToByteMap(opt?.match || cmd.match || opt?.payload || cmd.payload);
  const transition = compileByteTransition(opt?.from_payload || cmd.from_payload, opt?.match || cmd.match || opt?.payload || cmd.payload);

  return {
    id: trigId,
    source: 'can',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    click_count: 1,
    for_sec: 0,
    for_ms: 0,
    match: Object.keys(match).length > 0 ? match : { D1: '0x01' },
    ...(transition ? {
      byte_index: transition.byte_index,
      from_value: transition.from_value,
      to_value: transition.to_value
    } : {}),
    source_command_id: cmd.id,
    source_command_name: cmd.name || cmd.ha_metadata?.name || cmd.id,
    option_label: opt?.label
  };
}

/**
 * Convert a Catalog Command into an Automation Condition
 * Strict 1-based ByteMap and evaluate object, zero shell globs.
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
 * Uses entity_command or clean 1-based ByteMap steps.
 */
export function commandToAction(cmd: Command, opt?: CommandOption): AutomationAction {
  const actId = `act_${cmd.id}_${Date.now().toString(36).slice(-4)}`;
  const canId = cmd.network?.action_can_id || cmd.action_can_id || cmd.network?.state_can_id || cmd.state_can_id || '0x000';
  const cmdDisplayName = cmd.name || cmd.ha_metadata?.name || cmd.id;

  // If this command is an entity with options (e.g. drivers_seat_comfort), produce entity_command
  if (cmd.options && cmd.options.length > 0 && opt?.label) {
    return {
      id: actId,
      type: 'entity_command',
      entity_id: cmd.id,
      command: opt.label,
      can_id: canId,
      bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
      popup_message: opt?.popup || `${cmdDisplayName} - ${opt.label}`,
      source_command_id: cmd.id,
      source_command_name: cmdDisplayName,
      option_label: opt.label
    };
  }

  const payload = compileToByteMap(opt?.payload || cmd.payload || (cmd.steps && cmd.steps[0]?.payload));
  const sourceSteps = opt?.steps || cmd.steps;
  const steps = sourceSteps?.map(s => ({
    payload: compileToByteMap(s.payload),
    repeat: s.repeat || 1,
    delay_ms: 50
  })) || [{ payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' }, repeat: opt?.repeat || 1, delay_ms: 50 }];

  return {
    id: actId,
    type: 'can_tx',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
    payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
    repeat: opt?.repeat || 1,
    delay_ms: 50,
    steps,
    popup_message: opt?.popup || `${cmdDisplayName}${opt?.label ? ` - ${opt.label}` : ''}`,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    option_label: opt?.label
  };
}
