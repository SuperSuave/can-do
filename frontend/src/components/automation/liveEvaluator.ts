import { AutomationCondition, AutomationTrigger } from '../../types/automation';
import { Catalog, CommandOption, ByteMap } from '../../types/catalog';
import { normalizeCanId } from '../../utils/automationConverters';

export interface OptionGridGroup {
  key?: string;
  items: {
    opt: CommandOption;
    origIndex: number;
  }[];
}

export type ConditionValidityState = 'valid' | 'invalid' | 'unknown';

export interface EvaluatedConditionResult {
  state: ConditionValidityState;
  reason?: string;
}

export interface LiveWifiStatus {
  sta_connected: boolean;
  sta_ssid: string;
  sta_rssi: number;
  sta_ip?: string;
  ap_active?: boolean;
  ap_clients: number;
}

export interface LiveBleItem {
  address?: string;
  uuid?: string;
  mac?: string;
  name?: string;
  rssi?: number;
  connected?: boolean;
  is_present?: boolean;
}

/**
 * Groups command options into rows/grids based on common words (e.g. "Heat", "Cool", "Vent", "Front", "Rear").
 */
export function groupOptionsIntoGridRows(options?: CommandOption[]): OptionGridGroup[] {
  if (!options || options.length === 0) return [];
  if (options.length <= 1) {
    return [{ items: options.map((opt, origIndex) => ({ opt, origIndex })) }];
  }

  const parsed = options.map((opt, origIndex) => {
    const rawLabel = opt.label || '';
    const cleaned = rawLabel.replace(/\([^)]*\)/g, '').trim();
    const words = cleaned.split(/[\s\-_/]+/).filter(Boolean);
    const firstWord = words.length > 0 ? words[0].toLowerCase() : '';
    const lastWord = words.length > 1 ? words[words.length - 1].toLowerCase() : '';
    return {
      opt,
      origIndex,
      words,
      firstWord,
      lastWord,
      isSingleWord: words.length <= 1
    };
  });

  const suffixCounts = new Map<string, number>();
  parsed.forEach(p => {
    if (p.lastWord) {
      suffixCounts.set(p.lastWord, (suffixCounts.get(p.lastWord) || 0) + 1);
    }
  });

  const prefixCounts = new Map<string, number>();
  parsed.forEach(p => {
    if (p.firstWord && !p.isSingleWord) {
      prefixCounts.set(p.firstWord, (prefixCounts.get(p.firstWord) || 0) + 1);
    }
  });

  let maxSuffixCount = 0;
  for (const count of suffixCounts.values()) {
    if (count > maxSuffixCount) maxSuffixCount = count;
  }

  let maxPrefixCount = 0;
  for (const count of prefixCounts.values()) {
    if (count > maxPrefixCount) maxPrefixCount = count;
  }

  const useSuffix = maxSuffixCount >= 2 && maxSuffixCount >= maxPrefixCount;
  const usePrefix = !useSuffix && maxPrefixCount >= 2;

  if (useSuffix || usePrefix) {
    const keyMap = new Map<string, { opt: CommandOption; origIndex: number }[]>();
    const ungrouped: { opt: CommandOption; origIndex: number }[] = [];

    parsed.forEach(p => {
      const k = useSuffix ? p.lastWord : p.firstWord;
      const count = useSuffix ? (suffixCounts.get(p.lastWord) || 0) : (prefixCounts.get(p.firstWord) || 0);

      if (k && count >= 2) {
        if (!keyMap.has(k)) {
          keyMap.set(k, []);
        }
        keyMap.get(k)!.push({ opt: p.opt, origIndex: p.origIndex });
      } else {
        ungrouped.push({ opt: p.opt, origIndex: p.origIndex });
      }
    });

    const isOffLike = (lbl: string) => /^(off|none|idle|auto|normal|cancel|stop|released)/i.test(lbl.trim());
    const offLike = ungrouped.filter(u => isOffLike(u.opt.label || ''));
    const nonOffUngrouped = ungrouped.filter(u => !isOffLike(u.opt.label || ''));

    const result: OptionGridGroup[] = [];

    if (offLike.length > 0) {
      result.push({ key: 'off', items: offLike });
    }

    for (const [key, items] of keyMap.entries()) {
      result.push({ key, items });
    }

    if (nonOffUngrouped.length > 0) {
      result.push({ items: nonOffUngrouped });
    }

    if (result.length > 0) {
      return result;
    }
  }

  if (options.length <= 4) {
    return [{ items: options.map((opt, origIndex) => ({ opt, origIndex })) }];
  }

  const chunked: OptionGridGroup[] = [];
  const chunkSize = options.length === 6 ? 3 : options.length <= 8 ? 4 : 3;
  for (let i = 0; i < options.length; i += chunkSize) {
    chunked.push({
      items: options.slice(i, i + chunkSize).map((opt, idx) => ({ opt, origIndex: i + idx }))
    });
  }
  return chunked;
}

/**
 * Extracts 8-byte array from space-separated or compact hex string e.g. "00 12 34" or "001234"
 */
export function parseHexPayload(rawHex?: string): number[] | null {
  if (!rawHex) return null;
  const clean = rawHex.replace(/[^0-9a-fA-F]/g, '');
  if (!clean) return null;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length && bytes.length < 8; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  while (bytes.length < 8) bytes.push(0);
  return bytes;
}

/**
 * Evaluates whether a specific command option matches the current live CAN frame payload or entity state.
 */
export function isOptionCurrentlyValid(
  opt: CommandOption,
  canId?: string,
  liveFrames?: Map<string, { data: string }>,
  entityId?: string,
  entityStates?: Map<string, string>
): boolean {
  if (!opt) return false;

  // 1. Check live entity states if entityId provided
  if (entityId && entityStates && entityStates.has(entityId)) {
    const curState = (entityStates.get(entityId) || '').toLowerCase();
    const optLabel = (opt.label || '').toLowerCase();
    if (curState && (curState === optLabel || curState.includes(optLabel) || optLabel.includes(curState))) {
      return true;
    }
  }

  // 2. Check byte/payload match against live frame
  if (!canId || !liveFrames) return false;
  const cid = normalizeCanId(canId);
  if (!cid || !liveFrames.has(cid)) return false;

  const frame = liveFrames.get(cid)!;
  const bytes = parseHexPayload(frame.data);
  if (!bytes) return false;

  // Multi-byte match evaluation
  if (opt.match && typeof opt.match === 'object') {
    const rawMask = opt.mask;
    for (const [dKey, targetValStr] of Object.entries(opt.match)) {
      const m = dKey.match(/D(\d+)/i);
      const bIdx = m ? parseInt(m[1], 10) - 1 : 0;
      if (bIdx < 0 || bIdx >= 8) continue;
      let maskVal = 0xFF;
      if (typeof rawMask === 'object' && rawMask !== null) {
        maskVal = parseInt((rawMask as any)[dKey] || '0xFF', 16) || 0xFF;
      } else if (typeof rawMask === 'string') {
        maskVal = parseInt(rawMask, 16) || 0xFF;
      }
      const tVal = parseInt(String(targetValStr), 16) || 0;
      if ((bytes[bIdx] & maskVal) !== (tVal & maskVal)) {
        return false;
      }
    }
    return true;
  }

  // Single byte match evaluation
  const byteStr = opt.byte || 'D1';
  const m = byteStr.match(/D(\d+)/i);
  const byteIdx = m ? parseInt(m[1], 10) - 1 : 0;
  if (byteIdx < 0 || byteIdx >= 8) return false;

  const rawMaskVal = typeof opt.mask === 'string' ? opt.mask : '0xFF';
  const mask = parseInt(rawMaskVal, 16) || 0xFF;
  const targetVal = opt.value ? parseInt(opt.value, 16) || 0 : 0;

  return (bytes[byteIdx] & mask) === (targetVal & mask);
}

/**
 * Evaluates any condition node (group or leaf) against live CAN frames, entity states, system time, Wi-Fi status, or BLE beacons.
 */
export function evaluateConditionState(
  cond: AutomationCondition,
  liveFrames?: Map<string, { data: string }>,
  entityStates?: Map<string, string>,
  lastFiredTriggerId?: string,
  catalog?: Catalog,
  liveWifiStatus?: LiveWifiStatus | null,
  liveBleMap?: Map<string, LiveBleItem>
): EvaluatedConditionResult {
  const isGroup =
    cond.logic === 'and' ||
    cond.logic === 'or' ||
    cond.logic === 'not' ||
    cond.type === 'and_group' ||
    cond.type === 'or_group' ||
    cond.type === 'not_group';

  const groupLogic =
    cond.logic ||
    (cond.type === 'and_group' ? 'and' : cond.type === 'or_group' ? 'or' : cond.type === 'not_group' ? 'not' : 'leaf');

  if (isGroup) {
    const children = cond.conditions || [];
    if (children.length === 0) {
      return { state: 'unknown', reason: 'Empty condition group' };
    }

    const subResults = children.map(c =>
      evaluateConditionState(c, liveFrames, entityStates, lastFiredTriggerId, catalog, liveWifiStatus, liveBleMap)
    );

    if (groupLogic === 'and') {
      if (subResults.some(r => r.state === 'invalid')) {
        return { state: 'invalid', reason: 'One or more nested conditions failed' };
      }
      if (subResults.every(r => r.state === 'valid')) {
        return { state: 'valid', reason: 'All nested conditions passed' };
      }
      return { state: 'unknown', reason: 'Waiting for nested telemetry' };
    }

    if (groupLogic === 'or') {
      if (subResults.some(r => r.state === 'valid')) {
        return { state: 'valid', reason: 'At least one condition passed' };
      }
      if (subResults.every(r => r.state === 'invalid')) {
        return { state: 'invalid', reason: 'All nested conditions failed' };
      }
      return { state: 'unknown', reason: 'Waiting for telemetry' };
    }

    if (groupLogic === 'not') {
      if (subResults.some(r => r.state === 'valid')) {
        return { state: 'invalid', reason: 'Condition matched (NOT inverted to false)' };
      }
      if (subResults.every(r => r.state === 'invalid')) {
        return { state: 'valid', reason: 'Condition did not match (NOT inverted to true)' };
      }
      return { state: 'unknown', reason: 'Waiting for telemetry' };
    }
  }

  // Triggered by condition
  if (cond.type === 'triggered_by' || cond.type === 'trigger' || cond.trigger_id !== undefined) {
    if (!cond.trigger_id) return { state: 'valid', reason: 'Any trigger' };
    if (!lastFiredTriggerId) return { state: 'unknown', reason: 'No trigger fired yet' };
    return cond.trigger_id === lastFiredTriggerId
      ? { state: 'valid', reason: `Matched trigger: ${cond.trigger_id}` }
      : { state: 'invalid', reason: `Last fired trigger (${lastFiredTriggerId}) does not match` };
  }

  // Time window condition
  if (cond.type === 'time_condition' || cond.type === 'time') {
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();

    if (cond.days && cond.days.length > 0) {
      const daysOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const curDay = daysOfWeek[now.getDay()];
      if (!cond.days.map(d => d.toLowerCase()).includes(curDay)) {
        return { state: 'invalid', reason: `Not active on ${curDay.toUpperCase()}` };
      }
    }

    if (cond.start_time && cond.end_time) {
      const [sh, sm] = cond.start_time.split(':').map(Number);
      const [eh, em] = cond.end_time.split(':').map(Number);
      const startMin = (sh || 0) * 60 + (sm || 0);
      const endMin = (eh || 0) * 60 + (em || 0);

      const inWindow =
        startMin <= endMin
          ? curMin >= startMin && curMin <= endMin
          : curMin >= startMin || curMin <= endMin;

      return inWindow
        ? { state: 'valid', reason: `Current time is within ${cond.start_time} - ${cond.end_time}` }
        : { state: 'invalid', reason: `Current time is outside ${cond.start_time} - ${cond.end_time}` };
    }

    return { state: 'valid', reason: 'Time window guardrail active' };
  }

  // Wi-Fi and Device State condition
  if (cond.type === 'device_state' || cond.type === 'wifi' || cond.type === 'wifi_condition') {
    if (!liveWifiStatus) {
      return { state: 'unknown', reason: 'Waiting for Wi-Fi telemetry' };
    }
    const prop = cond.device_property || 'wifi_ssid';
    if (prop === 'wifi_ssid' || prop === 'ssid') {
      const isNot = cond.operator === 'not_equal';
      const matchesSsid = isNot
        ? liveWifiStatus.sta_ssid.toLowerCase() !== (cond.target_string || '').toLowerCase()
        : liveWifiStatus.sta_ssid.toLowerCase() === (cond.target_string || '').toLowerCase();
      if (!matchesSsid) {
        return { state: 'invalid', reason: `SSID '${liveWifiStatus.sta_ssid}' does not match '${cond.target_string}'` };
      }
      if (cond.target_rssi !== undefined && cond.target_rssi !== 0) {
        const op = cond.operator || 'greater_than';
        const passed = op === 'less_than' ? liveWifiStatus.sta_rssi < cond.target_rssi : liveWifiStatus.sta_rssi >= cond.target_rssi;
        return passed
          ? { state: 'valid', reason: `SSID matches and RSSI (${liveWifiStatus.sta_rssi} dBm) meets threshold` }
          : { state: 'invalid', reason: `RSSI (${liveWifiStatus.sta_rssi} dBm) does not meet threshold (${cond.target_rssi} dBm)` };
      }
      return { state: 'valid', reason: `SSID matches: ${liveWifiStatus.sta_ssid}` };
    }
    if (prop === 'wifi_connected' || prop === 'connected') {
      const expected = cond.target_bool !== false;
      if (liveWifiStatus.sta_connected !== expected) {
        return { state: 'invalid', reason: `Station is ${liveWifiStatus.sta_connected ? 'Connected' : 'Disconnected'} (expected ${expected ? 'Connected' : 'Disconnected'})` };
      }
      if (expected && cond.target_rssi !== undefined && cond.target_rssi !== 0) {
        const passed = liveWifiStatus.sta_rssi >= cond.target_rssi;
        return passed
          ? { state: 'valid', reason: `Connected with RSSI ${liveWifiStatus.sta_rssi} dBm >= ${cond.target_rssi} dBm` }
          : { state: 'invalid', reason: `Connected but RSSI (${liveWifiStatus.sta_rssi} dBm) < ${cond.target_rssi} dBm` };
      }
      return { state: 'valid', reason: `Station is ${expected ? 'Connected' : 'Disconnected'}` };
    }
    if (prop === 'wifi_rssi' || prop === 'wifi_station_rssi' || prop === 'sta_rssi') {
      if (!liveWifiStatus.sta_connected) {
        return { state: 'invalid', reason: 'Station is not connected' };
      }
      if (cond.target_string && liveWifiStatus.sta_ssid.toLowerCase() !== cond.target_string.toLowerCase()) {
        return { state: 'invalid', reason: `Connected to '${liveWifiStatus.sta_ssid}' (expected '${cond.target_string}')` };
      }
      const targetRssi = cond.target_rssi ?? -65;
      const op = cond.operator || 'greater_than';
      const passed = op === 'less_than' ? liveWifiStatus.sta_rssi < targetRssi : liveWifiStatus.sta_rssi >= targetRssi;
      return passed
        ? { state: 'valid', reason: `Station RSSI (${liveWifiStatus.sta_rssi} dBm) ${op === 'less_than' ? '<' : '>='} ${targetRssi} dBm` }
        : { state: 'invalid', reason: `Station RSSI (${liveWifiStatus.sta_rssi} dBm) failed threshold ${targetRssi} dBm` };
    }
    if (prop === 'wifi_mode' || prop === 'ap_mode') {
      if (cond.target_string === 'ap') {
        const ok = liveWifiStatus.ap_active && !liveWifiStatus.sta_connected;
        return ok ? { state: 'valid', reason: 'In standalone SoftAP mode' } : { state: 'invalid', reason: 'Not in standalone SoftAP mode' };
      }
      if (cond.target_string === 'sta') {
        const ok = liveWifiStatus.sta_connected && !liveWifiStatus.ap_active;
        return ok ? { state: 'valid', reason: 'In standalone Station mode' } : { state: 'invalid', reason: 'Not in standalone Station mode' };
      }
      if (cond.target_string === 'both' || cond.target_string === 'ap_sta') {
        const ok = liveWifiStatus.ap_active && liveWifiStatus.sta_connected;
        return ok ? { state: 'valid', reason: 'Both SoftAP and Station active' } : { state: 'invalid', reason: 'Both AP and STA not active' };
      }
      const expected = cond.target_bool !== false;
      return liveWifiStatus.ap_active === expected
        ? { state: 'valid', reason: `AP active: ${liveWifiStatus.ap_active}` }
        : { state: 'invalid', reason: `AP active is ${liveWifiStatus.ap_active} (expected ${expected})` };
    }
  }

  // Bluetooth Presence / Proximity condition
  if (cond.type === 'ble_presence' || cond.type === 'ble_beacon' || cond.type === 'beacon' || cond.type === 'ble_device') {
    if (!liveBleMap) {
      return { state: 'unknown', reason: 'Waiting for Bluetooth telemetry' };
    }
    const targetKey = (cond.beacon_uuid || cond.ble_device || cond.target_string || '').toLowerCase().trim();
    let matchedItem: LiveBleItem | undefined;
    if (targetKey) {
      for (const [k, v] of liveBleMap.entries()) {
        if (
          k.toLowerCase() === targetKey ||
          (v.mac && v.mac.toLowerCase() === targetKey) ||
          (v.uuid && v.uuid.toLowerCase() === targetKey) ||
          (v.name && v.name.toLowerCase() === targetKey)
        ) {
          matchedItem = v;
          break;
        }
      }
    } else {
      for (const v of liveBleMap.values()) {
        if (v.is_present || v.connected) {
          matchedItem = v;
          break;
        }
      }
    }

    const isPresent = Boolean(matchedItem?.is_present || matchedItem?.connected);
    const expected = cond.target_bool !== false;
    if (isPresent !== expected) {
      return {
        state: 'invalid',
        reason: `Target is ${isPresent ? 'Present' : 'Absent'} (expected ${expected ? 'Present' : 'Absent'})`
      };
    }

    if (expected && cond.target_rssi !== undefined && cond.target_rssi !== 0) {
      const curRssi = matchedItem?.rssi;
      if (curRssi === undefined) {
        return { state: 'unknown', reason: 'No live RSSI recorded for device' };
      }
      const op = cond.operator || 'greater_than';
      const passed = op === 'less_than' ? curRssi < cond.target_rssi : curRssi >= cond.target_rssi;
      return passed
        ? { state: 'valid', reason: `Present with RSSI ${curRssi} dBm ${op === 'less_than' ? '<' : '>='} ${cond.target_rssi} dBm` }
        : { state: 'invalid', reason: `Present but RSSI (${curRssi} dBm) failed threshold (${cond.target_rssi} dBm)` };
    }

    return { state: 'valid', reason: `Target is ${expected ? 'Present' : 'Absent'}` };
  }

  // 12V Battery Voltage Check condition
  if (cond.type === 'voltage') {
    const vbatStr = entityStates?.get('cond_aux_12v_battery') || entityStates?.get('vbat');
    if (!vbatStr) {
      return { state: 'unknown', reason: 'Waiting for 12V battery ADC' };
    }
    const curV = parseFloat(vbatStr);
    const targetV = parseFloat(cond.voltage_val || cond.value || '12.4') || 12.4;
    const isBelow = cond.voltage_dir === 'below' || cond.operator === 'less' || cond.operator === 'less_than';
    const passed = isBelow ? curV < targetV : curV >= targetV;
    return passed
      ? { state: 'valid', reason: `12V Battery (${curV.toFixed(1)}V) ${isBelow ? '<' : '>='} ${targetV}V` }
      : { state: 'invalid', reason: `12V Battery (${curV.toFixed(1)}V) failed threshold (${targetV}V)` };
  }

  // Leaf CAN / Catalog command condition
  const cid = normalizeCanId(cond.can_id);
  if (!cid) {
    return { state: 'unknown', reason: 'No CAN ID defined' };
  }

  // Check catalog entity state if condition is linked to a command (with proper negation check)
  const entityId = cond.source_command_id;
  if (entityId && entityStates && entityStates.has(entityId)) {
    const curState = (entityStates.get(entityId) || '').toLowerCase();
    const optLabel = (cond.option_label || '').toLowerCase();
    if (optLabel) {
      const match = (curState === optLabel || curState.includes(optLabel) || optLabel.includes(curState));
      const isNegated = cond.operator === 'not_equal' || cond.operator === '!=' || !!cond.invert;
      const passed = isNegated ? !match : match;
      if (passed) {
        return { state: 'valid', reason: `Entity state matches: ${curState}` };
      } else {
        return { state: 'invalid', reason: `Entity state (${curState}) failed match (expected ${isNegated ? 'NOT ' : ''}${optLabel})` };
      }
    }
  }

  // Check live CAN frame
  if (!liveFrames || !liveFrames.has(cid)) {
    return { state: 'unknown', reason: `Waiting for CAN frame ${cid}` };
  }

  const frame = liveFrames.get(cid)!;
  const bytes = parseHexPayload(frame.data);
  if (!bytes) {
    return { state: 'unknown', reason: `Invalid frame data for ${cid}` };
  }

  // Multi-byte condition checking (e.g. All Doors Closed / Opened)
  if (cond.match && Object.keys(cond.match).length > 1) {
    const rawMaskObj = cond.mask || cond.evaluate?.mask;
    for (const [dKey, targetValStr] of Object.entries(cond.match)) {
      const m = dKey.match(/D(\d+)/i);
      const bIdx = m ? parseInt(m[1], 10) - 1 : 0;
      if (bIdx < 0 || bIdx >= 8) continue;
      let maskVal = 0xFF;
      if (typeof rawMaskObj === 'object' && rawMaskObj !== null) {
        maskVal = parseInt((rawMaskObj as any)[dKey] || '0xFF', 16) || 0xFF;
      } else if (typeof rawMaskObj === 'string') {
        maskVal = parseInt(rawMaskObj, 16) || 0xFF;
      }
      const tVal = parseInt(String(targetValStr), 16) || 0;
      const actByte = bytes[bIdx];
      if ((actByte & maskVal) !== (tVal & maskVal)) {
        return { state: 'invalid', reason: `${dKey} failed mask match` };
      }
    }
    return { state: 'valid', reason: `All ${Object.keys(cond.match).length} bytes match` };
  }

  // Determine byte index
  let byteIndex = cond.byte_index;
  if (byteIndex === undefined || byteIndex < 0) {
    const bStr = cond.byte || cond.evaluate?.byte || '';
    const m = bStr.match(/D(\d+)/i);
    if (m) byteIndex = parseInt(m[1], 10) - 1;
    else byteIndex = 0;
  }

  if (byteIndex < 0 || byteIndex >= 8) {
    return { state: 'unknown', reason: `Byte index ${byteIndex} out of bounds` };
  }

  // Parse mask
  const rawMaskVal = cond.mask || cond.evaluate?.mask;
  const maskStr = typeof rawMaskVal === 'string' ? rawMaskVal : '0xFF';
  const mask = parseInt(maskStr, 16) || 0xFF;

  // Parse target value
  let targetValStr = cond.value ?? cond.evaluate?.value;
  if (targetValStr === undefined && cond.match) {
    const dKey = Object.keys(cond.match)[0];
    if (dKey) targetValStr = cond.match[dKey];
  }
  const targetVal = targetValStr !== undefined ? (parseInt(String(targetValStr), 16) || 0) : 0;

  const actualByte = bytes[byteIndex];
  const maskedActual = actualByte & mask;
  const maskedTarget = targetVal & mask;

  const op = cond.operator || cond.evaluate?.operator || (cond.invert ? 'not_equal' : 'equal');

  let passed = false;
  if (op === 'equal' || op === '==' || op === 'equals') {
    passed = maskedActual === maskedTarget;
  } else if (op === 'not_equal' || op === '!=' || op === 'not_equals') {
    passed = maskedActual !== maskedTarget;
  } else if (op === 'greater_than' || op === '>') {
    passed = maskedActual > maskedTarget;
  } else if (op === 'less_than' || op === '<') {
    passed = maskedActual < maskedTarget;
  } else if (op === 'greater_than_or_equal' || op === '>=') {
    passed = maskedActual >= maskedTarget;
  } else if (op === 'less_than_or_equal' || op === '<=') {
    passed = maskedActual <= maskedTarget;
  } else {
    passed = maskedActual === maskedTarget;
  }

  const hexActual = '0x' + actualByte.toString(16).toUpperCase().padStart(2, '0');
  const hexTarget = '0x' + targetVal.toString(16).toUpperCase().padStart(2, '0');
  return passed
    ? { state: 'valid', reason: `D${byteIndex + 1} (${hexActual} & 0x${mask.toString(16).toUpperCase()}) ${op} ${hexTarget}` }
    : { state: 'invalid', reason: `D${byteIndex + 1} (${hexActual} & 0x${mask.toString(16).toUpperCase()}) ${op} ${hexTarget} failed` };
}
