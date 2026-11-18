import {
  AutomationClipboardItem,
  ClipboardBlockType,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  ChoiceBranch
} from '../types/automation';
import {
  deepClone,
  regenerateTriggerIds,
  regenerateConditionIds,
  regenerateActionIds,
  regenerateBranchIds,
  convertTriggerToCondition,
  convertConditionToTrigger
} from './automationConverters';

export const CANDO_CLIPBOARD_MAGIC = 1;

export interface ClipboardEnvelope {
  __cando_clipboard: number;
  type: ClipboardBlockType;
  label: string;
  timestamp: number;
  payload: any;
}

export interface ScopedDragPayload {
  listId: string;
  index: number;
}

let activeScopedDrag: ScopedDragPayload | null = null;

export function setActiveScopedDrag(payload: ScopedDragPayload | null): void {
  activeScopedDrag = payload;
}

export function getActiveScopedDrag(): ScopedDragPayload | null {
  return activeScopedDrag;
}

/**
 * Pure immutable array reorder helper with bounds validation.
 */
export function arrayMove<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Checks whether navigator.clipboard.readText is available in the current environment.
 */
export function canReadSystemClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.clipboard) &&
    typeof navigator.clipboard.readText === 'function'
  );
}

export type ClipboardReadPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * Safely queries clipboard-read permission without prompting the user.
 */
export async function queryClipboardReadPermission(): Promise<ClipboardReadPermissionState> {
  if (!canReadSystemClipboard()) return 'unsupported';
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return 'unsupported';
  }
  try {
    const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state;
    }
    return 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Checks whether a clipboard item can be pasted into the requested slot type.
 */
export function isClipboardCompatibleWithTarget(
  item: AutomationClipboardItem | null | undefined,
  targetType: ClipboardBlockType
): boolean {
  if (!item || !item.payload) return false;
  const sourceType: ClipboardBlockType = item.type === 'branch' ? 'choice_branch' : item.type;
  const normalizedTarget: ClipboardBlockType = targetType === 'branch' ? 'choice_branch' : targetType;
  if (sourceType === normalizedTarget) return true;
  if (
    (sourceType === 'trigger' && normalizedTarget === 'condition') ||
    (sourceType === 'condition' && normalizedTarget === 'trigger')
  ) {
    return true;
  }
  return false;
}

/**
 * Avoid hijacking native Ctrl+V / Cmd+V when typing inside inputs, textareas, selects, or editable content.
 */
export function canAcceptGlobalPasteTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return true;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') {
    return false;
  }
  if (el.isContentEditable) {
    return false;
  }
  if (typeof el.closest === 'function' && el.closest('[role="dialog"]')) {
    return false;
  }
  return true;
}

/**
 * Serializes an AutomationClipboardItem into a portable JSON string for OS clipboard transfer.
 */
export function serializeClipboardEnvelope(item: AutomationClipboardItem): string {
  const envelope: ClipboardEnvelope = {
    __cando_clipboard: CANDO_CLIPBOARD_MAGIC,
    type: item.type,
    label: item.label || 'Block',
    timestamp: item.timestamp || Date.now(),
    payload: item.payload
  };
  return JSON.stringify(envelope, null, 2);
}

const VALID_BLOCK_TYPES = new Set<ClipboardBlockType>([
  'trigger',
  'condition',
  'action',
  'choice_branch',
  'branch'
]);

const KNOWN_ACTION_TYPES = new Set([
  'can_tx',
  'transmit',
  'entity_command',
  'delay',
  'precondition',
  'climate_target',
  'hud_nav',
  'webhook',
  'choose',
  'if_then',
  'track_popup',
  'popup',
  'repeat_until',
  'wait_for',
  'cycle_entity'
]);

const KNOWN_CONDITION_TYPES = new Set([
  'can_state',
  'byte_value',
  'time_condition',
  'time',
  'param_range',
  'voltage',
  'and',
  'or',
  'not',
  'and_group',
  'or_group',
  'not_group',
  'triggered_by',
  'trigger',
  'device_state',
  'wifi',
  'wifi_condition',
  'ble_presence',
  'ble_beacon',
  'beacon',
  'ble_device'
]);

const KNOWN_TRIGGER_TYPES = new Set([
  'byte_transition',
  'time_schedule',
  'can_rx',
  'mqtt',
  'wifi_event',
  'device_event',
  'ble_device_event'
]);

function inferBlockTypeFromRawObject(obj: Record<string, any>): ClipboardBlockType | null {
  // Reject full rules exported as whole automation rules
  if (Array.isArray(obj.triggers) && Array.isArray(obj.actions)) {
    return null;
  }

  // Choice branch
  if (
    Array.isArray(obj.conditions) &&
    Array.isArray(obj.sequence) &&
    obj.type !== 'if_then' &&
    obj.type !== 'repeat_until'
  ) {
    return 'choice_branch';
  }

  const rawType = typeof obj.type === 'string' ? obj.type : '';

  if (KNOWN_ACTION_TYPES.has(rawType)) {
    return 'action';
  }

  if (KNOWN_CONDITION_TYPES.has(rawType)) {
    return 'condition';
  }

  if (KNOWN_TRIGGER_TYPES.has(rawType)) {
    return 'trigger';
  }

  // Shared ble_button / ble_key / wifi types: distinguish by trigger source/event fields
  if (rawType === 'ble_button' || rawType === 'ble_key' || rawType === 'wifi') {
    if (
      typeof obj.source === 'string' ||
      obj.click_count !== undefined ||
      obj.wifi_event !== undefined ||
      obj.ble_event !== undefined
    ) {
      return 'trigger';
    }
    return 'condition';
  }

  // Fallback heuristics for minimal raw JSON objects
  if (obj.logic === 'and' || obj.logic === 'or' || obj.logic === 'not' || obj.logic === 'leaf' || obj.start_time || obj.end_time || Array.isArray(obj.and) || Array.isArray(obj.or)) {
    return 'condition';
  }

  if (
    typeof obj.source === 'string' &&
    ['can', 'ble', 'wifi', 'time', 'voltage', 'mqtt', 'preset'].includes(obj.source)
  ) {
    return 'trigger';
  }

  if (obj.from !== undefined || obj.to !== undefined || obj.from_payload !== undefined || obj.to_payload !== undefined) {
    return 'trigger';
  }

  if (Array.isArray(obj.steps) || (obj.can_id && obj.payload !== undefined && obj.operator === undefined)) {
    return 'action';
  }

  if (obj.can_id && (obj.operator !== undefined || obj.value !== undefined || obj.match !== undefined)) {
    return 'condition';
  }

  return null;
}

function deriveLabel(type: ClipboardBlockType, payload: Record<string, any>): string {
  if (typeof payload.name === 'string' && payload.name.trim()) return payload.name.trim();
  if (typeof payload.label === 'string' && payload.label.trim()) return payload.label.trim();
  if (typeof payload.source_command_name === 'string' && payload.source_command_name.trim()) {
    return payload.source_command_name.trim();
  }
  if (typeof payload.command_name === 'string' && payload.command_name.trim()) {
    return payload.command_name.trim();
  }
  if (typeof payload.entity_id === 'string' && payload.entity_id.trim()) {
    return payload.entity_id.trim();
  }
  if (typeof payload.can_id === 'string' && payload.can_id.trim()) {
    return payload.can_id.trim();
  }
  if (typeof payload.type === 'string' && payload.type.trim()) {
    return payload.type.trim();
  }
  return type === 'choice_branch' || type === 'branch' ? 'Branch' : type;
}

/**
 * Parses text read from the system clipboard.
 * Supports CAN Do clipboard envelopes and raw JSON trigger/condition/action/branch objects.
 */
export function parseClipboardText(rawText: string): AutomationClipboardItem | null {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{')) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  // Case 1: CAN Do envelope
  if (
    parsed.__cando_clipboard !== undefined &&
    typeof parsed.type === 'string' &&
    VALID_BLOCK_TYPES.has(parsed.type as ClipboardBlockType) &&
    parsed.payload &&
    typeof parsed.payload === 'object' &&
    !Array.isArray(parsed.payload)
  ) {
    const normalizedType: ClipboardBlockType =
      parsed.type === 'branch' ? 'choice_branch' : (parsed.type as ClipboardBlockType);
    return {
      type: normalizedType,
      payload: deepClone(parsed.payload),
      label:
        typeof parsed.label === 'string' && parsed.label.trim()
          ? parsed.label.trim()
          : deriveLabel(normalizedType, parsed.payload),
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now()
    };
  }

  // Case 2: Raw single block JSON object (e.g. copied from JSON Inspector or external doc)
  const inferred = inferBlockTypeFromRawObject(parsed);
  if (!inferred) return null;

  return {
    type: inferred,
    payload: deepClone(parsed),
    label: deriveLabel(inferred, parsed),
    timestamp: Date.now()
  };
}

export type PasteResolution =
  | {
      ok: true;
      data: AutomationTrigger | AutomationCondition | AutomationAction | ChoiceBranch;
      convertedFrom?: ClipboardBlockType;
    }
  | {
      ok: false;
      reason: string;
    };

function formatTypeName(type: ClipboardBlockType): string {
  switch (type) {
    case 'trigger':
      return 'Trigger';
    case 'condition':
      return 'Condition';
    case 'action':
      return 'Action';
    case 'branch':
    case 'choice_branch':
      return 'Choose Branch';
    default:
      return String(type);
  }
}

/**
 * Resolves a clipboard item against a target slot type, regenerating IDs
 * and handling safe trigger <-> condition conversion.
 */
export function resolveClipboardPaste(
  item: AutomationClipboardItem | null,
  targetType: ClipboardBlockType
): PasteResolution {
  if (!item || !item.payload) {
    return { ok: false, reason: 'Clipboard is empty or does not contain a valid CAN Do block.' };
  }

  const normalizedTarget: ClipboardBlockType =
    targetType === 'branch' ? 'choice_branch' : targetType;
  const sourceType: ClipboardBlockType =
    item.type === 'branch' ? 'choice_branch' : item.type;

  const cloned = deepClone(item.payload);

  if (sourceType === 'trigger') {
    if (normalizedTarget === 'trigger') {
      return { ok: true, data: regenerateTriggerIds(cloned) };
    }
    if (normalizedTarget === 'condition') {
      return {
        ok: true,
        data: regenerateConditionIds(convertTriggerToCondition(cloned)),
        convertedFrom: 'trigger'
      };
    }
  } else if (sourceType === 'condition') {
    if (normalizedTarget === 'condition') {
      return { ok: true, data: regenerateConditionIds(cloned) };
    }
    if (normalizedTarget === 'trigger') {
      return {
        ok: true,
        data: regenerateTriggerIds(convertConditionToTrigger(cloned)),
        convertedFrom: 'condition'
      };
    }
  } else if (sourceType === 'action' && normalizedTarget === 'action') {
    return { ok: true, data: regenerateActionIds(cloned) };
  } else if (sourceType === 'choice_branch' && normalizedTarget === 'choice_branch') {
    return { ok: true, data: regenerateBranchIds(cloned, true) };
  }

  return {
    ok: false,
    reason: `Clipboard holds a ${formatTypeName(sourceType)} block, which cannot be pasted into ${formatTypeName(normalizedTarget)}s.`
  };
}
