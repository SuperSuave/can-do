import {
  AutomationRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';
import { Catalog, Command, CommandOption } from '../types/catalog';
import {
  normalizeCanId,
  formatCanId,
  compileToByteMap,
  resolveCatalogCommandForCondition,
  resolveCatalogCommandForAction,
  resolveCatalogCommandForTrigger,
  formatDefaultTriggerName
} from './automationConverters';
import {
  evaluateConditionState,
  LiveWifiStatus,
  LiveBleItem,
  parseHexPayload
} from '../components/automation/liveEvaluator';

export interface RuleFireRecord {
  lastFiredAt: number;
  count: number;
}

/**
 * Formats a timestamp into a human-friendly relative badge label
 * that transitions from "Just now" -> "Xs ago" -> "Xm ago" -> "Xh ago" -> "Xd ago".
 */
export function formatRelativeFiredTime(lastFiredAtMs: number, nowMs: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - lastFiredAtMs) / 1000));
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export interface DiscoveredEntityInput {
  entityId: string;
  name: string;
  canId?: string;
  options: CommandOption[];
  usedIn: ('condition' | 'cycle_entity')[];
}

export interface DiscoveredRawCanInput {
  canId: string;
  defaultBytes: string; // 8 space-separated hex bytes e.g. "00 00 00 00 00 00 00 00"
  samplePassBytes: string; // 8 space-separated hex bytes that satisfy the first condition on this CAN ID
  description: string;
}

export interface DiscoveredRuleInputs {
  entities: DiscoveredEntityInput[];
  rawCanFrames: DiscoveredRawCanInput[];
  usesVoltage: boolean;
  usesTime: boolean;
  usesWifi: boolean;
  usesBle: boolean;
}

export interface SimulationTraceItem {
  phase: 'trigger' | 'condition' | 'branch' | 'action' | 'summary';
  status: 'pass' | 'fail' | 'info' | 'skip' | 'tx';
  title: string;
  detail?: string;
  indent?: number;
}

export interface RuleSimulationContext {
  catalog?: Catalog;
  firedTriggerId?: string;
  multiTriggerWindowSatisfied?: boolean;
  entityStates: Map<string, string>;
  liveFrames: Map<string, { data: string }>;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  pingPongDirections?: Map<string, number>;
}

export interface RuleSimulationResult {
  passed: boolean;
  traces: SimulationTraceItem[];
  nextEntityStates: Map<string, string>;
  nextPingPongDirections: Map<string, number>;
  plannedTxCount: number;
}

export function applyOptionToHexFrame(
  existingHex: string | undefined,
  opt: CommandOption
): string {
  const bytes = parseHexPayload(existingHex) || [0, 0, 0, 0, 0, 0, 0, 0];

  const byteMap = compileToByteMap(opt.match || opt.payload);
  if (Object.keys(byteMap).length > 0) {
    for (const [dKey, valStr] of Object.entries(byteMap)) {
      const m = dKey.match(/^D([1-8])$/i);
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      const val = parseInt(String(valStr).replace(/^0x/i, ''), 16);
      if (!isNaN(val)) {
        bytes[idx] = val & 0xff;
      }
    }
  } else if (opt.byte && opt.value !== undefined) {
    const m = opt.byte.match(/^D([1-8])$/i);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      const val = parseInt(String(opt.value).replace(/^0x/i, ''), 16);
      if (!isNaN(val)) {
        bytes[idx] = val & 0xff;
      }
    }
  }

  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function buildPassBytesForCondition(
  cond: AutomationCondition,
  existingHex?: string
): string {
  const bytes = parseHexPayload(existingHex) || [0, 0, 0, 0, 0, 0, 0, 0];
  const matchMap = compileToByteMap(cond.match || cond.match_payload);
  if (Object.keys(matchMap).length > 0) {
    for (const [dKey, valStr] of Object.entries(matchMap)) {
      const m = dKey.match(/^D([1-8])$/i);
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      const val = parseInt(String(valStr).replace(/^0x/i, ''), 16);
      if (!isNaN(val)) {
        bytes[idx] = val & 0xff;
      }
    }
  } else {
    const bStr = cond.byte || cond.evaluate?.byte || (cond.byte_index !== undefined ? `D${cond.byte_index + 1}` : 'D1');
    const m = bStr.match(/^D([1-8])$/i);
    const idx = m ? parseInt(m[1], 10) - 1 : 0;
    const rawTarget = cond.value ?? cond.evaluate?.value ?? '0x01';
    const targetVal = parseInt(String(rawTarget).replace(/^0x/i, ''), 16) || 0;
    const op = cond.operator || cond.evaluate?.operator || (cond.invert ? 'not_equal' : 'equal');
    if (op === 'not_equal' || op === '!=' || op === 'not_equals') {
      bytes[idx] = (targetVal ^ 0x01) & 0xff;
    } else if (op === 'greater_than' || op === '>') {
      bytes[idx] = Math.min(255, targetVal + 1);
    } else if (op === 'less_than' || op === '<') {
      bytes[idx] = Math.max(0, targetVal - 1);
    } else {
      bytes[idx] = targetVal & 0xff;
    }
  }
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function discoverRuleSimulationInputs(
  rule: AutomationRule,
  catalog?: Catalog
): DiscoveredRuleInputs {
  const entityMap = new Map<string, DiscoveredEntityInput>();
  const rawCanMap = new Map<string, DiscoveredRawCanInput>();
  let usesVoltage = false;
  let usesTime = false;
  let usesWifi = false;
  let usesBle = false;

  const findCmd = (id?: string): Command | undefined => {
    if (!id || !catalog?.commands) return undefined;
    return catalog.commands.find(c => c.id === id || c.entity_id === id);
  };

  const addEntity = (cmd: Command, role: 'condition' | 'cycle_entity') => {
    const key = cmd.id;
    const existing = entityMap.get(key);
    if (existing) {
      if (!existing.usedIn.includes(role)) existing.usedIn.push(role);
      return;
    }
    if (cmd.options && cmd.options.length > 0) {
      entityMap.set(key, {
        entityId: cmd.id,
        name: cmd.ha_metadata?.name || cmd.name || cmd.id,
        canId: cmd.state_can_id || cmd.action_can_id,
        options: cmd.options,
        usedIn: [role]
      });
    }
  };

  const visitCondition = (cond: AutomationCondition) => {
    if (!cond) return;
    const children =
      cond.conditions ||
      cond.and ||
      cond.or ||
      (Array.isArray(cond.not) ? cond.not : cond.not ? [cond.not] : []);
    if (children.length > 0) {
      children.forEach(visitCondition);
      return;
    }

    const cType = cond.type || '';
    if (cType === 'voltage') {
      usesVoltage = true;
      return;
    }
    if (cType === 'time_condition' || cType === 'time') {
      usesTime = true;
      return;
    }
    if (cType === 'device_state' || cType === 'wifi' || cType === 'wifi_condition') {
      usesWifi = true;
      return;
    }
    if (
      cType === 'ble_presence' ||
      cType === 'ble_beacon' ||
      cType === 'beacon' ||
      cType === 'ble_device' ||
      cType === 'ble_button' ||
      cType === 'ble_key' ||
      cType === 'ble'
    ) {
      usesBle = true;
      return;
    }
    if (cType === 'triggered_by' || cType === 'trigger') {
      return;
    }

    const resolved = catalog ? resolveCatalogCommandForCondition(cond, catalog) : {};
    const cmd = resolved.command || findCmd(cond.source_command_id);
    if (cmd && cmd.options && cmd.options.length > 0) {
      addEntity(cmd, 'condition');
      return;
    }

    const cid = normalizeCanId(cond.can_id);
    if (cid && !rawCanMap.has(cid)) {
      const bStr = cond.byte || cond.evaluate?.byte || 'D1';
      const valStr = cond.value || cond.evaluate?.value || '0x01';
      rawCanMap.set(cid, {
        canId: formatCanId(cid),
        defaultBytes: '00 00 00 00 00 00 00 00',
        samplePassBytes: buildPassBytesForCondition(cond),
        description: `${cond.source_command_name || formatCanId(cid)} (${bStr} = ${valStr})`
      });
    }
  };

  const visitAction = (act: AutomationAction) => {
    if (!act) return;
    if (act.type === 'if_then') {
      (act.conditions || []).forEach(visitCondition);
      (act.then || []).forEach(visitAction);
      (act.else || []).forEach(visitAction);
      return;
    }
    if (act.type === 'choose') {
      (act.choices || []).forEach(branch => {
        (branch.conditions || []).forEach(visitCondition);
        (branch.sequence || []).forEach(visitAction);
      });
      (act.default || []).forEach(visitAction);
      return;
    }
    if (act.type === 'wait_for' || act.type === 'repeat_until') {
      if (act.condition) visitCondition(act.condition);
      (act.conditions || []).forEach(visitCondition);
      (act.sequence || []).forEach(visitAction);
      return;
    }
    if (act.type === 'cycle_entity') {
      const entId = act.entity_id || act.target_command_id;
      const cmd = findCmd(entId);
      if (cmd && cmd.options && cmd.options.length > 0) {
        addEntity(cmd, 'cycle_entity');
      } else if (entId) {
        const stateNames = act.states && act.states.length > 0 ? act.states : ['Off', 'On'];
        entityMap.set(entId, {
          entityId: entId,
          name: act.source_command_name || entId,
          options: stateNames.map(s => ({ label: s })),
          usedIn: ['cycle_entity']
        });
      }
    }
  };

  (rule.conditions || []).forEach(visitCondition);
  (rule.actions || []).forEach(visitAction);

  return {
    entities: Array.from(entityMap.values()),
    rawCanFrames: Array.from(rawCanMap.values()),
    usesVoltage,
    usesTime,
    usesWifi,
    usesBle
  };
}

export function describeTriggerForSim(trig: AutomationTrigger, idx: number, catalog?: Catalog): string {
  if (trig.name?.trim()) return trig.name.trim();
  if (trig.type === 'time_schedule' || trig.source === 'time') {
    return `Schedule (${trig.time || `${trig.interval_sec || 60}s`})`;
  }
  if (trig.type === 'ble_button' || trig.type === 'ble_key' || (trig.source === 'ble' && trig.ble_button)) {
    const clicks = trig.click_count && trig.click_count > 1 ? ` (${trig.click_count}x)` : '';
    return `BLE Button: ${trig.ble_button || 'any'}${clicks}`;
  }
  if (trig.type === 'ble_presence' || trig.type === 'ble_beacon' || trig.type === 'beacon') {
    return `BLE Presence (${trig.ble_event || 'enter'})`;
  }
  if (trig.type === 'wifi' || trig.type === 'wifi_event' || trig.source === 'wifi') {
    return `Wi-Fi Event (${trig.wifi_event || 'connected'})`;
  }
  const resolved = catalog ? resolveCatalogCommandForTrigger(trig, catalog) : {};
  const cmdName = resolved.command?.name || trig.source_command_name || (trig.can_id ? `CAN ${trig.can_id}` : `Trigger #${idx + 1}`);
  const optLabel = trig.option_label || resolved.matchedOption?.label;
  return formatDefaultTriggerName(cmdName, optLabel, trig.click_count || 1);
}

function describeConditionLabel(cond: AutomationCondition, idx: number, catalog?: Catalog): string {
  if (cond.logic === 'and' || cond.type === 'and_group') return `AND Group (#${idx + 1})`;
  if (cond.logic === 'or' || cond.type === 'or_group') return `OR Group (#${idx + 1})`;
  if (cond.logic === 'not' || cond.type === 'not_group') return `NOT Group (#${idx + 1})`;
  if (cond.type === 'triggered_by' || cond.type === 'trigger') {
    return `Triggered By '${cond.trigger_id || 'any'}'`;
  }
  if (cond.type === 'time_condition' || cond.type === 'time') {
    return `Time Window (${cond.start_time || '08:00'}–${cond.end_time || '18:00'})`;
  }
  if (cond.type === 'voltage') {
    return `12V Battery (${cond.voltage_dir === 'below' ? '<' : '>='} ${cond.voltage_val || cond.value || '12.4'}V)`;
  }
  if (cond.type === 'device_state' || cond.type === 'wifi' || cond.type === 'wifi_condition') {
    return `Wi-Fi / Device (${cond.device_property || 'wifi_connected'})`;
  }
  if (
    cond.type === 'ble_presence' ||
    cond.type === 'ble_beacon' ||
    cond.type === 'beacon' ||
    cond.type === 'ble_device'
  ) {
    return `BLE Proximity (${cond.beacon_uuid || cond.ble_device || 'Any Device'})`;
  }
  const resolved = catalog ? resolveCatalogCommandForCondition(cond, catalog) : {};
  const name = resolved.command?.name || cond.source_command_name || formatCanId(cond.can_id) || `Condition #${idx + 1}`;
  const opt = cond.option_label || resolved.matchedOption?.label;
  return opt ? `${name} = ${opt}` : name;
}

/**
 * Runs a full offline simulation of a rule (triggers, multi-trigger mode, guard conditions,
 * and recursive control-flow actions including if_then, choose, and cycle_entity) without
 * transmitting any real CAN frames.
 */
export function simulateAutomationRule(
  rule: AutomationRule,
  context: RuleSimulationContext
): RuleSimulationResult {
  const traces: SimulationTraceItem[] = [];
  const nextEntityStates = new Map<string, string>(context.entityStates);
  const nextFrames = new Map<string, { data: string }>(context.liveFrames);
  const nextPingPongDirections = new Map<string, number>(context.pingPongDirections || []);
  let plannedTxCount = 0;

  const trigs = rule.triggers || [];
  const conds = rule.conditions || [];
  const acts = rule.actions || [];
  const firedTriggerId = context.firedTriggerId ?? trigs[0]?.id;

  // 1. Trigger evaluation
  if (!rule.enabled) {
    traces.push({
      phase: 'trigger',
      status: 'info',
      title: `Rule "${rule.name}" is currently disabled`,
      detail: 'Simulating evaluation as if enabled (manual / test run bypasses disabled state).'
    });
  }

  if (trigs.length === 0) {
    traces.push({
      phase: 'trigger',
      status: 'pass',
      title: 'Manual / Direct Invocation',
      detail: 'Rule has 0 triggers configured; proceeding directly to guard conditions.'
    });
  } else {
    const firedIdx = Math.max(0, trigs.findIndex(t => t.id === firedTriggerId));
    const firedTrig = trigs[firedIdx] || trigs[0];
    const trigLabel = describeTriggerForSim(firedTrig, firedIdx, context.catalog);
    traces.push({
      phase: 'trigger',
      status: 'pass',
      title: `Simulated Trigger #${firedIdx + 1}: ${trigLabel}`,
      detail: `Trigger ID: ${firedTrig.id || `trig_${firedIdx + 1}`}`
    });

    const tMode = rule.trigger_mode || 'any';
    if (tMode !== 'any' && trigs.length >= 2) {
      const winSec = Math.round((rule.trigger_window_ms ?? rule.timeout_reset_ms ?? 8000) / 1000);
      const satisfied = context.multiTriggerWindowSatisfied !== false;
      if (!satisfied) {
        traces.push({
          phase: 'trigger',
          status: 'fail',
          title: `Multi-Trigger Mode (${tMode === 'sequence' ? 'Sequence' : 'All Triggers (AND)'}) Blocked`,
          detail: `Other required triggers did not complete within the ${winSec}s window. Execution halted.`
        });
        return {
          passed: false,
          traces,
          nextEntityStates,
          nextPingPongDirections,
          plannedTxCount
        };
      }
      traces.push({
        phase: 'trigger',
        status: 'pass',
        title: `Multi-Trigger Gate (${tMode === 'sequence' ? 'Sequence' : 'All Triggers (AND)'}) Satisfied`,
        detail: `All ${trigs.length} triggers satisfied within the ${winSec}s window.`
      });
    }
  }

  // 2. Top-level Guard Conditions
  if (conds.length === 0) {
    traces.push({
      phase: 'condition',
      status: 'pass',
      title: 'No Guard Conditions',
      detail: 'Rule has 0 top-level conditions; proceeding to actions.'
    });
  } else {
    let allPassed = true;
    conds.forEach((cond, idx) => {
      const res = evaluateConditionState(
        cond,
        nextFrames,
        nextEntityStates,
        firedTriggerId,
        context.catalog,
        context.liveWifiStatus,
        context.liveBleMap
      );
      const label = describeConditionLabel(cond, idx, context.catalog);
      const passed = res.state === 'valid';
      if (!passed) allPassed = false;
      traces.push({
        phase: 'condition',
        status: passed ? 'pass' : 'fail',
        title: `Condition #${idx + 1}: ${label} — ${res.state.toUpperCase()}`,
        detail: res.reason || (passed ? 'Condition matched' : 'Condition did not match')
      });
    });

    if (!allPassed) {
      traces.push({
        phase: 'summary',
        status: 'fail',
        title: 'Guard Conditions Failed — Actions Blocked',
        detail: 'Adjust the mock state controls above to test how this rule behaves when conditions pass.'
      });
      return {
        passed: false,
        traces,
        nextEntityStates,
        nextPingPongDirections,
        plannedTxCount
      };
    }
  }

  // 3. Action & Control-Flow Execution Trace
  const traceActionList = (actionList: AutomationAction[], indent: number) => {
    actionList.forEach((act, idx) => {
      traceSingleAction(act, idx, indent);
    });
  };

  const evaluateConditionArray = (list: AutomationCondition[]): { passed: boolean; reasons: string[] } => {
    if (!list || list.length === 0) return { passed: true, reasons: ['No conditions (always true)'] };
    let passed = true;
    const reasons: string[] = [];
    list.forEach((c, i) => {
      const r = evaluateConditionState(
        c,
        nextFrames,
        nextEntityStates,
        firedTriggerId,
        context.catalog,
        context.liveWifiStatus,
        context.liveBleMap
      );
      const lbl = describeConditionLabel(c, i, context.catalog);
      reasons.push(`${lbl}: ${r.state.toUpperCase()} (${r.reason || ''})`);
      if (r.state !== 'valid') passed = false;
    });
    return { passed, reasons };
  };

  const traceSingleAction = (act: AutomationAction, idx: number, indent: number) => {
    const aType = act.type;

    if (aType === 'if_then') {
      const evalRes = evaluateConditionArray(act.conditions || []);
      traces.push({
        phase: 'branch',
        status: evalRes.passed ? 'pass' : 'info',
        title: `Action #${idx + 1} [If / Then]: Condition is ${evalRes.passed ? 'TRUE → Taking THEN branch' : 'FALSE → Taking ELSE branch'}`,
        detail: evalRes.reasons.join(' | '),
        indent
      });
      if (evalRes.passed) {
        if (act.then && act.then.length > 0) {
          traceActionList(act.then, indent + 1);
        } else {
          traces.push({
            phase: 'branch',
            status: 'skip',
            title: 'THEN branch is empty (nothing to run)',
            indent: indent + 1
          });
        }
      } else {
        if (act.else && act.else.length > 0) {
          traceActionList(act.else, indent + 1);
        } else {
          traces.push({
            phase: 'branch',
            status: 'skip',
            title: 'ELSE branch is empty (nothing to run)',
            indent: indent + 1
          });
        }
      }
      return;
    }

    if (aType === 'choose') {
      const choices = act.choices || [];
      let matchedBranchIdx = -1;
      for (let bIdx = 0; bIdx < choices.length; bIdx++) {
        const branch = choices[bIdx];
        const bName = branch.label?.trim() || `Branch #${bIdx + 1}`;
        const evalRes = evaluateConditionArray(branch.conditions || []);
        if (evalRes.passed) {
          matchedBranchIdx = bIdx;
          traces.push({
            phase: 'branch',
            status: 'pass',
            title: `Action #${idx + 1} [Choose]: Matched ${bName}`,
            detail: evalRes.reasons.join(' | '),
            indent
          });
          traceActionList(branch.sequence || [], indent + 1);
          break;
        } else {
          traces.push({
            phase: 'branch',
            status: 'skip',
            title: `Action #${idx + 1} [Choose]: Skipped ${bName}`,
            detail: evalRes.reasons.join(' | '),
            indent
          });
        }
      }

      if (matchedBranchIdx === -1) {
        if (act.default && act.default.length > 0) {
          traces.push({
            phase: 'branch',
            status: 'info',
            title: `Action #${idx + 1} [Choose]: No branch matched → Running Default branch`,
            indent
          });
          traceActionList(act.default, indent + 1);
        } else {
          traces.push({
            phase: 'branch',
            status: 'skip',
            title: `Action #${idx + 1} [Choose]: No branch matched and Default is empty`,
            indent
          });
        }
      }
      return;
    }

    if (aType === 'cycle_entity') {
      const entId = (act.entity_id || act.target_command_id || '').trim();
      const cmd = context.catalog?.commands?.find(c => c.id === entId || c.entity_id === entId);
      const entityName = cmd?.ha_metadata?.name || cmd?.name || act.source_command_name || entId || 'Entity';
      const states =
        act.states && act.states.length > 0
          ? act.states
          : cmd?.options?.map(o => o.label) || ['Off', 'On'];

      const curStateRaw = nextEntityStates.get(entId) || nextEntityStates.get(entId.toLowerCase()) || '';
      const curIdx = states.findIndex(s => s.toLowerCase() === curStateRaw.toLowerCase());
      const directionMode = act.direction || 'forward';
      const wrap = act.wrap !== false;
      const fallback = act.fallback_state || '__first__';

      let targetState: string | null = null;
      let transitionNote = '';

      if (states.length === 0) {
        traces.push({
          phase: 'action',
          status: 'fail',
          title: `Action #${idx + 1} [Cycle Entity]: ${entityName} has 0 states`,
          indent
        });
        return;
      }

      if (curIdx === -1) {
        if (fallback === '__none__') {
          traces.push({
            phase: 'action',
            status: 'skip',
            title: `Action #${idx + 1} [Cycle Entity]: ${entityName} current state '${curStateRaw || 'Unknown'}' not in cycle list`,
            detail: 'Fallback is Do Nothing (__none__) — skipping action.',
            indent
          });
          return;
        } else if (fallback === '__first__') {
          targetState = states[0];
          transitionNote = `Current '${curStateRaw || 'Unknown'}' not in list → Fallback to first state '${targetState}'`;
        } else {
          targetState = states.find(s => s.toLowerCase() === fallback.toLowerCase()) || states[0];
          transitionNote = `Current '${curStateRaw || 'Unknown'}' not in list → Fallback to '${targetState}'`;
        }
      } else {
        const ppKey = act.id || `${rule.id}_cycle_${idx}`;
        let stepDir = directionMode === 'reverse' ? -1 : 1;
        if (directionMode === 'ping_pong') {
          stepDir = nextPingPongDirections.get(ppKey) ?? 1;
          if (curIdx + stepDir >= states.length) stepDir = -1;
          else if (curIdx + stepDir < 0) stepDir = 1;
        }

        let nextIdx = curIdx + stepDir;
        if (nextIdx >= states.length) {
          nextIdx = wrap ? 0 : states.length - 1;
        } else if (nextIdx < 0) {
          nextIdx = wrap ? states.length - 1 : 0;
        }

        if (directionMode === 'ping_pong') {
          if (nextIdx === states.length - 1) nextPingPongDirections.set(ppKey, -1);
          else if (nextIdx === 0) nextPingPongDirections.set(ppKey, 1);
          else nextPingPongDirections.set(ppKey, stepDir);
        }

        targetState = states[nextIdx];
        transitionNote = `${states[curIdx]} ➔ ${targetState} (${directionMode}${wrap ? ', wrap' : ', clamp'})`;
      }

      // Update simulated state & CAN frame
      nextEntityStates.set(entId, targetState);
      nextEntityStates.set(entId.toLowerCase(), targetState);
      const matchedOpt = cmd?.options?.find(o => o.label.toLowerCase() === targetState!.toLowerCase());
      const canId = cmd?.action_can_id || cmd?.state_can_id;
      let txDetail = '';
      if (cmd && matchedOpt && canId) {
        const cid = normalizeCanId(canId);
        const updatedHex = applyOptionToHexFrame(nextFrames.get(cid)?.data, matchedOpt);
        nextFrames.set(cid, { data: updatedHex });
        plannedTxCount++;
        txDetail = ` | CAN TX ${formatCanId(canId)}: [${updatedHex}]`;
      } else {
        plannedTxCount++;
      }

      let popupDetail = '';
      if (act.show_popup !== false) {
        const tmpl = act.popup_prefix?.trim() || '{entity}: {state}';
        const msg = tmpl.includes('{state}') || tmpl.includes('{entity}')
          ? tmpl.replace(/\{entity\}/gi, entityName).replace(/\{state\}/gi, targetState)
          : `${tmpl}: ${targetState}`;
        popupDetail = ` | Popup: "${msg}"`;
      }

      traces.push({
        phase: 'action',
        status: 'tx',
        title: `Action #${idx + 1} [Cycle Entity]: ${entityName} — ${transitionNote}`,
        detail: `States: [${states.join(' → ')}]${txDetail}${popupDetail}`,
        indent
      });
      return;
    }

    if (aType === 'wait_for' || aType === 'repeat_until') {
      const condList = act.conditions && act.conditions.length > 0 ? act.conditions : (act.condition ? [act.condition] : []);
      const evalRes = evaluateConditionArray(condList);
      const label = aType === 'wait_for' ? 'Wait For Condition' : 'Repeat Until Condition';
      traces.push({
        phase: 'action',
        status: evalRes.passed ? 'pass' : 'info',
        title: `Action #${idx + 1} [${label}]: Stop condition is currently ${evalRes.passed ? 'TRUE' : 'FALSE (would poll every ' + (act.interval_ms || (aType === 'wait_for' ? 50 : 1000)) + 'ms up to ' + (act.timeout_ms || 10000) + 'ms)'}`,
        detail: evalRes.reasons.join(' | '),
        indent
      });
      if (aType === 'repeat_until' && act.sequence && act.sequence.length > 0) {
        traceActionList(act.sequence, indent + 1);
      }
      return;
    }

    if (aType === 'delay') {
      const ms = act.delay_ms ?? act.ms ?? 500;
      traces.push({
        phase: 'action',
        status: 'info',
        title: `Action #${idx + 1} [Delay]: Pause ${ms} ms`,
        indent
      });
      return;
    }

    if (aType === 'track_popup' || aType === 'popup') {
      const text = act.text || act.popup_message || '';
      traces.push({
        phase: 'action',
        status: 'tx',
        title: `Action #${idx + 1} [Head Unit Popup]: "${text}" (${(act.level || 'info').toUpperCase()})`,
        indent
      });
      return;
    }

    if (aType === 'hud_nav' || aType === 'nav') {
      const mode = act.nav_action || act.action || 'update';
      plannedTxCount++;
      traces.push({
        phase: 'action',
        status: 'tx',
        title:
          mode === 'clear'
            ? `Action #${idx + 1} [HUD Navigation]: Clear Turn-by-Turn Display`
            : `Action #${idx + 1} [HUD Navigation]: Icon 0x${(act.icon ?? 1).toString(16).toUpperCase().padStart(2, '0')}, Dist ${act.distance_meters ?? act.distance ?? 200}m, Lanes: ${act.num_lanes ?? act.lanes ?? 0}`,
        detail: act.street ? `Street: "${act.street}"` : undefined,
        indent
      });
      return;
    }

    if (aType === 'climate_target' || aType === 'remote_climate') {
      const tempC = act.target_temp_c ?? act.target_c ?? 22;
      plannedTxCount++;
      traces.push({
        phase: 'action',
        status: 'tx',
        title: `Action #${idx + 1} [Climate Target]: ${tempC}°C (${Math.round((tempC * 9) / 5 + 32)}°F), Defrost: ${act.defrost ? 'On' : 'Off'}, Duration: ${act.duration_minutes || 15}m`,
        indent
      });
      return;
    }

    if (aType === 'precondition') {
      plannedTxCount++;
      traces.push({
        phase: 'action',
        status: 'tx',
        title: `Action #${idx + 1} [Battery Preconditioning]: ${(act.precon_action || 'start').toUpperCase()} (${act.precon_mode || 'persistent'})`,
        indent
      });
      return;
    }

    // Default: can_tx / transmit / entity_command
    const resolved = context.catalog ? resolveCatalogCommandForAction(act, context.catalog) : {};
    const cmd = resolved.command;
    const opt = resolved.matchedOption;
    const canId = formatCanId(act.can_id || cmd?.action_can_id || cmd?.state_can_id || '0x000');
    const label = cmd?.name || act.source_command_name || canId;
    const optLabel = act.option_label || act.command || opt?.label;
    const byteMap = compileToByteMap(act.payload || act.to_payload || opt?.payload || opt?.match);
    const bytePairs = Object.entries(byteMap)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    if (cmd && optLabel) {
      nextEntityStates.set(cmd.id, optLabel);
      nextEntityStates.set(cmd.id.toLowerCase(), optLabel);
    }

    plannedTxCount += act.steps && act.steps.length > 0 ? act.steps.length : 1;
    traces.push({
      phase: 'action',
      status: 'tx',
      title: `Action #${idx + 1} [CAN Transmit]: ${label}${optLabel ? ` → ${optLabel}` : ''}`,
      detail: `CAN ID: ${canId} (Bus ${act.bus ?? cmd?.action_bus ?? cmd?.bus ?? 0})${bytePairs ? ` | Payload: { ${bytePairs} }` : ''}${act.repeat && act.repeat > 1 ? ` | Repeat: ${act.repeat}×` : ''}${act.popup_message ? ` | Popup: "${act.popup_message}"` : ''}`,
      indent
    });
  };

  traceActionList(acts, 0);

  traces.push({
    phase: 'summary',
    status: 'pass',
    title: `Dry-Run Complete — ${plannedTxCount} simulated bus action${plannedTxCount !== 1 ? 's' : ''} traced (0 physical frames transmitted)`,
    detail: rule.cooldown_ms ? `Rule cooldown: ${rule.cooldown_ms} ms.` : undefined
  });

  return {
    passed: true,
    traces,
    nextEntityStates,
    nextPingPongDirections,
    plannedTxCount
  };
}
