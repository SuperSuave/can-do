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
import { Command, CommandOption, Catalog } from '../types/catalog';

/**
 * Generate standard WiCAN / CAN Do format compatible with SuperSuave/wicant-i-automate
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
    rules: rules.map(rule => ({
      ...rule,
      // Backward compatibility fields expected by legacy WiCAN engine
      trigger: rule.triggers[0] || { source: 'can' },
      condition: rule.conditions[0] || { type: 'none' },
      action: rule.actions[0] || { type: 'can_tx' },
      ...(rule.exec_mode === 'toggle' && rule.off_actions?.length
        ? { off_action: rule.off_actions[0] }
        : {})
    })) as any
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
  return JSON.stringify({
    ...catalog,
    automations: rules
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

  const firmwareRules: Esp32FirmwareRule[] = rules.map(r => ({
    id: r.id,
    name: r.name,
    en: r.enabled ? 1 : 0,
    mode: modeMap[r.exec_mode] ?? 0,
    trig_op: r.trigger_mode === 'all' ? 1 : 0,
    cd_ms: r.cooldown_ms || 500,
    trigs: r.triggers.map(t => ({
      id: t.id,
      can_id: t.can_id || '0x000',
      bus: t.bus ?? 0,
      clicks: t.click_count || 1,
      from: t.from_payload || '* * * * * * * *',
      to: t.to_payload || t.match_payload || '* * * * * * * *'
    })),
    conds: r.conditions.map(c => ({
      can_id: c.can_id || '0x000',
      bus: c.bus ?? 0,
      match: c.match_payload || '* * * * * * * *',
      inv: c.invert ? 1 : 0
    })),
    acts: r.actions.map(a => ({
      can_id: a.can_id || '0x000',
      bus: a.bus ?? 0,
      payload: a.payload || '00 00 00 00 00 00 00 00',
      rep: a.repeat || 1,
      delay: a.delay_ms || 0,
      ...(a.steps && a.steps.length > 0
        ? { steps: a.steps.map(s => ({ p: s.payload, r: s.repeat || 1, d: s.delay_ms || 0 })) }
        : {}),
      ...(a.popup_message ? { osd: a.popup_message } : {})
    })),
    ...(r.exec_mode === 'toggle' && r.off_actions?.length
      ? {
          off_acts: r.off_actions.map(oa => ({
            can_id: oa.can_id || '0x000',
            bus: oa.bus ?? 0,
            payload: oa.payload || '00 00 00 00 00 00 00 00',
            rep: oa.repeat || 1
          }))
        }
      : {})
  }));

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
  const canId = cmd.network?.state_can_id || cmd.state_can_id || cmd.network?.action_can_id || cmd.action_can_id || '0x000';
  const fromPayload = opt?.from_payload || cmd.from_payload || '* * * * * 0*';
  const toPayload = opt?.match || opt?.to_payload || opt?.payload || cmd.match || cmd.to_payload || cmd.match_payload || '* * * * * 1*';

  return {
    id: trigId,
    source: 'preset',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    click_count: 1,
    for_sec: 0,
    for_ms: 0,
    from_payload: fromPayload,
    to_payload: toPayload,
    match_payload: toPayload,
    match: typeof toPayload === 'object' ? toPayload : undefined,
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
  const matchPayload = opt?.match || opt?.match_payload || opt?.payload || opt?.to_payload || cmd.match || cmd.match_payload || '* * * * * * * *';

  return {
    id: condId,
    type: 'can_state',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.bus ?? 0,
    match_payload: matchPayload,
    match: typeof matchPayload === 'object' ? matchPayload : undefined,
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
  const payload = opt?.payload || opt?.to_payload || cmd.to_payload || '00 00 00 00 00 00 00 00';

  const sourceSteps = opt?.steps || cmd.steps;
  const steps = sourceSteps?.map(s => ({
    payload: s.payload,
    repeat: s.repeat || 1,
    delay_ms: 50
  })) || [{ payload, repeat: opt?.repeat || 1, delay_ms: 50 }];

  const cmdDisplayName = cmd.name || cmd.ha_metadata?.name || cmd.id;

  return {
    id: actId,
    type: 'can_tx',
    can_id: canId,
    bus: cmd.network?.bus ?? cmd.action_bus ?? cmd.bus ?? 0,
    payload,
    repeat: opt?.repeat || 1,
    delay_ms: 50,
    steps,
    popup_message: opt?.popup || `${cmdDisplayName}${opt?.label ? ` - ${opt.label}` : ''}`,
    source_command_id: cmd.id,
    source_command_name: cmdDisplayName,
    option_label: opt?.label
  };
}
