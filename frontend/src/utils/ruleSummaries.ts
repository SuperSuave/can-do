import {
  AutomationRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';
import { Catalog } from '../types/catalog';
import {
  formatCanId,
  compileToByteMap,
  resolveCatalogCommandForTrigger,
  resolveCatalogCommandForCondition,
  resolveCatalogCommandForAction,
  findMatchingEffectForAction
} from './automationConverters';

function collectTextTokens(values: unknown[], out: string[]) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) {
      out.push(val.toLowerCase());
    } else if (typeof val === 'number') {
      out.push(String(val));
    }
  }
}

function collectConditionSearchTokens(cond: AutomationCondition, catalog: Catalog | undefined, out: string[]) {
  if (!cond) return;
  const resolved = catalog ? resolveCatalogCommandForCondition(cond, catalog) : {};
  collectTextTokens(
    [
      cond.can_id,
      cond.source_command_id,
      cond.source_command_name,
      cond.option_label,
      cond.target_string,
      cond.ble_button,
      cond.ble_device,
      cond.beacon_uuid,
      cond.ssid,
      cond.device_property,
      resolved.command?.name,
      resolved.matchedOption?.label,
      ...(cond.selected_options || [])
    ],
    out
  );
  const children = [
    ...(cond.conditions || []),
    ...(cond.and || []),
    ...(cond.or || []),
    ...(Array.isArray(cond.not) ? cond.not : cond.not ? [cond.not] : [])
  ];
  children.forEach(c => collectConditionSearchTokens(c, catalog, out));
}

function collectActionSearchTokens(act: AutomationAction, catalog: Catalog | undefined, out: string[]) {
  if (!act) return;
  const resolved = catalog ? resolveCatalogCommandForAction(act, catalog) : {};
  collectTextTokens(
    [
      act.type,
      act.can_id,
      act.entity_id,
      act.source_command_id,
      act.source_command_name,
      act.target_command_id,
      act.command,
      act.option_label,
      act.text,
      act.popup_message,
      act.street,
      act.direction !== undefined ? String(act.direction) : undefined,
      resolved.command?.name,
      resolved.matchedOption?.label,
      ...(act.states || [])
    ],
    out
  );
  (act.steps || []).forEach(s => {
    collectTextTokens([s.can_id, s.action_can_id], out);
  });
  (act.conditions || []).forEach(c => collectConditionSearchTokens(c, catalog, out));
  if (act.condition) collectConditionSearchTokens(act.condition, catalog, out);
  (act.then || []).forEach(a => collectActionSearchTokens(a, catalog, out));
  (act.else || []).forEach(a => collectActionSearchTokens(a, catalog, out));
  (act.choices || []).forEach(ch => {
    collectTextTokens([ch.label], out);
    (ch.conditions || []).forEach(c => collectConditionSearchTokens(c, catalog, out));
    (ch.sequence || []).forEach(a => collectActionSearchTokens(a, catalog, out));
  });
  (act.default || []).forEach(a => collectActionSearchTokens(a, catalog, out));
  (act.sequence || []).forEach(a => collectActionSearchTokens(a, catalog, out));
}

/**
 * Matches a rule against a user search string across name, ID, category,
 * description, triggers, conditions, actions, CAN IDs, and entity labels.
 */
export function matchesRuleSearch(rule: AutomationRule, query: string, catalog?: Catalog): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const tokens: string[] = [];
  collectTextTokens([rule.id, rule.name, rule.category, rule.description, ...(rule.tags || [])], tokens);

  for (const t of rule.triggers || []) {
    const resolved = catalog ? resolveCatalogCommandForTrigger(t, catalog) : {};
    collectTextTokens(
      [
        t.name,
        t.command_name,
        t.can_id,
        t.source_command_id,
        t.source_command_name,
        t.option_label,
        t.ble_button,
        t.ble_device,
        t.beacon_uuid,
        t.wifi_event,
        t.ssid,
        t.mqtt_topic,
        resolved.command?.name,
        resolved.matchedOption?.label
      ],
      tokens
    );
  }

  for (const c of rule.conditions || []) {
    collectConditionSearchTokens(c, catalog, tokens);
  }

  for (const a of rule.actions || []) {
    collectActionSearchTokens(a, catalog, tokens);
  }

  return tokens.some(tok => tok.includes(q));
}

export function formatDurationMsCompact(ms?: number): string {
  if (!ms || ms <= 0) return '0ms';
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  return `${ms}ms`;
}

export function formatTriggerSummary(trig: AutomationTrigger, catalog?: Catalog): string {
  if (trig.type === 'time_schedule' || trig.source === 'time') {
    const days = trig.days && trig.days.length > 0 && trig.days.length < 7
      ? trig.days.map(d => d.slice(0, 3)).join(', ')
      : 'Daily';
    if (trig.interval_sec && !trig.time) {
      return `Every ${trig.interval_sec}s`;
    }
    return `${days} at ${trig.time || '08:00'}`;
  }

  if (trig.type === 'ble_button' || trig.type === 'ble_key' || (trig.source === 'ble' && trig.ble_button !== undefined)) {
    const btn = trig.ble_button || 'any button';
    const act = trig.ble_action || 'press';
    const clicks = trig.click_count && trig.click_count > 1 ? ` · ${trig.click_count}x` : '';
    const dev = trig.ble_device ? ` · ${trig.ble_device}` : '';
    return `BLE ${btn} (${act}${clicks})${dev}`;
  }

  if (
    trig.type === 'ble_presence' ||
    trig.type === 'ble_device_event' ||
    trig.type === 'ble_device' ||
    trig.type === 'ble_beacon' ||
    trig.type === 'beacon' ||
    (!trig.type && trig.source === 'ble')
  ) {
    const ev = trig.ble_event || 'present';
    const filter = trig.beacon_uuid || trig.ble_device;
    const rssi = trig.target_rssi !== undefined ? ` (>= ${trig.target_rssi} dBm)` : '';
    return `BLE ${ev}${filter ? ` · ${filter}` : ''}${rssi}`;
  }

  if (trig.type === 'wifi' || trig.type === 'wifi_event' || trig.source === 'wifi') {
    const ev = trig.wifi_event || 'wifi_connected';
    const extra = trig.ssid ? ` · "${trig.ssid}"` : trig.client_mac ? ` · ${trig.client_mac}` : '';
    return `Wi-Fi ${ev}${extra}`;
  }

  if (trig.source === 'voltage' || trig.type === 'voltage') {
    return `Battery ${trig.voltage_dir === 'below' ? '<' : '>='} ${trig.voltage_val || '12.4'}V`;
  }

  if (trig.source === 'mqtt' || trig.type === 'mqtt') {
    return `MQTT: ${trig.mqtt_topic || '#'}`;
  }

  // CAN Trigger
  const resolved = catalog ? resolveCatalogCommandForTrigger(trig, catalog) : {};
  const cid = formatCanId(trig.can_id || resolved.command?.state_can_id || '0x000');
  const byteKey = trig.byte || trig.evaluate?.byte || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : 'D1');
  const sustainedMs = trig.for_ms ?? (trig.for_sec ? trig.for_sec * 1000 : 0);
  const sustained = sustainedMs > 0 ? ` · hold ${formatDurationMsCompact(sustainedMs)}` : '';
  const clicks = trig.click_count && trig.click_count > 1 ? ` · ${trig.click_count}x press` : '';
  const opt = trig.option_label || resolved.matchedOption?.label;

  if (trig.type === 'byte_transition' || (trig.from !== undefined && trig.to !== undefined)) {
    const fromVal = trig.from || '*';
    const toVal = trig.to || trig.value || '*';
    return `CAN ${cid} · ${byteKey}: ${fromVal} ➔ ${toVal}${opt ? ` (${opt})` : ''}${sustained}${clicks}`;
  }

  if (opt) {
    return `CAN ${cid} · ${opt}${sustained}${clicks}`;
  }

  const targetVal = trig.value || trig.evaluate?.value;
  if (targetVal) {
    return `CAN ${cid} · ${byteKey} == ${targetVal}${sustained}${clicks}`;
  }

  return `CAN ${cid} (Bus ${trig.bus ?? 0})${sustained}${clicks}`;
}

export function formatConditionSummary(cond: AutomationCondition, catalog?: Catalog): string {
  const isGroup =
    cond.logic === 'and' ||
    cond.logic === 'or' ||
    cond.logic === 'not' ||
    cond.type === 'and_group' ||
    cond.type === 'or_group' ||
    cond.type === 'not_group';

  if (isGroup) {
    const logicLabel = (
      cond.logic ||
      (cond.type === 'and_group' ? 'and' : cond.type === 'or_group' ? 'or' : 'not')
    ).toUpperCase();
    const children = cond.conditions || [];
    if (children.length === 0) return `${logicLabel} Group (empty)`;
    const preview = children.slice(0, 2).map(c => formatConditionSummary(c, catalog)).join(', ');
    const more = children.length > 2 ? ` +${children.length - 2}` : '';
    return `${logicLabel} (${children.length}): ${preview}${more}`;
  }

  if (cond.type === 'triggered_by' || cond.type === 'trigger' || cond.trigger_id !== undefined) {
    return cond.trigger_id ? `Fired by trigger "${cond.trigger_id}"` : 'Triggered by (not selected)';
  }

  if (cond.type === 'time_condition' || cond.type === 'time') {
    const days = cond.days && cond.days.length > 0 && cond.days.length < 7
      ? ` (${cond.days.map(d => d.slice(0, 3)).join(', ')})`
      : '';
    return `${cond.start_time || '00:00'} – ${cond.end_time || '23:59'}${days}`;
  }

  if (cond.type === 'device_state' || cond.type === 'wifi' || cond.type === 'wifi_condition') {
    const prop = cond.device_property || 'wifi_ssid';
    if (prop === 'wifi_ssid') {
      return `Wi-Fi SSID ${cond.operator === 'not_equal' ? '!=' : '=='} "${cond.target_string || ''}"`;
    }
    if (prop === 'wifi_connected') {
      return `Wi-Fi ${cond.target_bool === false ? 'Disconnected' : 'Connected'}`;
    }
    if (prop === 'wifi_rssi') {
      return `Wi-Fi RSSI ${cond.operator === 'less_than' ? '<' : '>='} ${cond.target_rssi ?? -65} dBm`;
    }
    return `Wi-Fi (${prop})`;
  }

  if (cond.type === 'ble_presence' || cond.type === 'ble_beacon' || cond.type === 'beacon' || cond.type === 'ble_device') {
    const expected = (cond.device_property === 'away' || cond.device_property === 'disconnected')
      ? 'Absent'
      : cond.target_bool === false
      ? 'Absent'
      : 'Present';
    const filter = cond.beacon_uuid || cond.ble_device || 'Any Device';
    const rssi = cond.target_rssi !== undefined && cond.target_rssi !== 0 ? ` (>= ${cond.target_rssi} dBm)` : '';
    return `BLE ${filter}: ${expected}${rssi}`;
  }

  if (cond.type === 'ble_button' || cond.type === 'ble_key' || cond.type === 'ble') {
    return `BLE ${cond.ble_button || cond.target_string || 'any'} (${cond.ble_action || 'press'})`;
  }

  if (cond.type === 'voltage') {
    const dir = cond.voltage_dir === 'below' || cond.operator === 'less' ? '<' : '>=';
    return `12V Battery ${dir} ${cond.voltage_val || cond.value || '12.4'}V`;
  }

  // CAN condition
  const resolved = catalog ? resolveCatalogCommandForCondition(cond, catalog) : {};
  const cid = formatCanId(cond.can_id || resolved.command?.state_can_id || '0x000');
  const negated = cond.invert || cond.operator === 'not_equal' || cond.operator === '!=' ? 'NOT ' : '';

  if (cond.selected_options && cond.selected_options.length > 0) {
    return `CAN ${cid} · ${negated}${cond.selected_options.join(' / ')}`;
  }

  const opt = cond.option_label || resolved.matchedOption?.label;
  if (opt) {
    return `CAN ${cid} · ${negated}${opt}`;
  }

  const byteKey = cond.byte || cond.evaluate?.byte || (cond.byte_index !== undefined ? `D${cond.byte_index + 1}` : 'D1');
  const op = cond.operator || cond.evaluate?.operator || (cond.invert ? '!=' : '==');
  const val = cond.value || cond.evaluate?.value || '*';
  return `CAN ${cid} · ${byteKey} ${op} ${val}`;
}

export function formatActionSummary(act: AutomationAction, catalog?: Catalog): string {
  const aType = act.type;

  if (aType === 'if_then') {
    const cCount = (act.conditions || []).length;
    const tCount = (act.then || []).length;
    const eCount = (act.else || []).length;
    return `If ${cCount} cond${cCount !== 1 ? 's' : ''} ➔ Then (${tCount} action${tCount !== 1 ? 's' : ''})${eCount > 0 ? ` / Else (${eCount})` : ''}`;
  }

  if (aType === 'choose') {
    const bCount = (act.choices || []).length;
    const dCount = (act.default || []).length;
    return `${bCount} branch${bCount !== 1 ? 'es' : ''}${dCount > 0 ? ` + ${dCount} default` : ''}`;
  }

  if (aType === 'delay') {
    const ms = act.delay_ms ?? act.ms ?? 500;
    return `Delay ${formatDurationMsCompact(ms)}`;
  }

  if (aType === 'wait_for') {
    const conds = act.conditions && act.conditions.length > 0 ? act.conditions : (act.condition ? [act.condition] : []);
    const cSummary = conds[0] ? formatConditionSummary(conds[0], catalog) : 'Condition';
    return `Wait until ${cSummary} (timeout ${formatDurationMsCompact(act.timeout_ms || 10000)})`;
  }

  if (aType === 'repeat_until') {
    const sCount = (act.sequence || []).length;
    return `Repeat ${sCount} action${sCount !== 1 ? 's' : ''} every ${formatDurationMsCompact(act.interval_ms || 1000)}`;
  }

  if (aType === 'cycle_entity') {
    const entId = act.entity_id || act.target_command_id || '';
    const cmd = catalog?.commands?.find(c => c.id === entId || c.entity_id === entId);
    const name = cmd?.ha_metadata?.name || cmd?.name || act.source_command_name || entId || 'Entity';
    const states = act.states && act.states.length > 0 ? act.states.join(' ➔ ') : 'no states';
    const dir = act.direction === 'ping_pong' ? 'Ping-Pong' : act.direction === 'reverse' ? 'Reverse' : 'Forward';
    return `Cycle ${name}: ${states} (${dir})`;
  }

  if (aType === 'track_popup' || aType === 'popup') {
    const text = (act.text || act.popup_message || '').trim();
    return `Popup (${(act.level || 'info').toUpperCase()}): "${text || '...'}"`;
  }

  if (aType === 'hud_nav' || aType === 'nav') {
    if ((act.nav_action || act.action || 'update') === 'clear') {
      return 'HUD Navigation: Clear display';
    }
    const iconHex = `0x${(act.icon ?? 1).toString(16).toUpperCase().padStart(2, '0')}`;
    const dist = act.distance_meters ?? act.distance ?? 200;
    const street = act.street ? ` · ${act.street}` : '';
    return `HUD Nav ${iconHex} · ${dist}m${street}`;
  }

  if (aType === 'climate_target' || aType === 'remote_climate') {
    const temp = act.target_temp_c ?? act.target_c ?? 22;
    return `Remote Climate ${temp}°C · ${act.duration_minutes || 15}m${act.defrost ? ' · Defrost' : ''}`;
  }

  if (aType === 'precondition') {
    return `Battery Preconditioning: ${(act.precon_action || 'start').toUpperCase()} (${act.precon_mode || 'persistent'})`;
  }

  // CAN TX / Transmit / Entity command
  const resolved = catalog ? resolveCatalogCommandForAction(act, catalog) : {};
  const cmd = resolved.command;
  const opt = resolved.matchedOption;
  const eff = cmd ? findMatchingEffectForAction(cmd, act) : undefined;
  if (eff) {
    return `Ambient Effect · ${eff.label}`;
  }
  const cid = formatCanId(act.can_id || cmd?.action_can_id || cmd?.state_can_id || '0x000');

  if (act.steps && act.steps.length > 1) {
    const optLbl = act.option_label || act.command || opt?.label;
    return `CAN ${cid} · ${act.steps.length}-step burst${optLbl ? ` (${optLbl})` : ''}`;
  }

  const label = opt?.label || act.option_label || act.command;
  if (label) {
    return `CAN ${cid} · ${label}`;
  }

  const map = compileToByteMap(act.payload || act.to_payload);
  const pairs = Object.entries(map).map(([k, v]) => `${k}=${v}`).join(' ');
  return pairs ? `CAN ${cid} · ${pairs}` : `CAN ${cid}`;
}
