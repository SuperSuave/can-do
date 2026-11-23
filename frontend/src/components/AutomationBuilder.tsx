import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import mqtt from 'mqtt';
import {
  Switch,
  Button,
  CloseButton,
  ButtonGroup,
  Slider,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter
} from '@heroui/react';
import {
  AutomationRule,
  AutomationSettings,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  ClipboardBlockType,
  AutomationClipboardItem
} from '../types/automation';
import { Catalog } from '../types/catalog';
import {
  exportToCandoJson,
  commandToAction,
  compileToByteMap,
  resolveCatalogCommandForAction,
  regenerateTriggerIds,
  cloneRuleWithNewIds,
  deepClone,
  normalizeCanId,
  decompileAutomationRule,
  decompileAutomationRules,
  compileActionList,
  MAX_AUTOMATIONS_PAYLOAD_BYTES,
  getPayloadByteLength
} from '../utils/automationConverters';
import { getDefaultEspIp, resolveDeviceBaseUrl } from '../utils/hostUtils';
import { deviceWs } from '../services/deviceWs';
import {
  Zap,
  Shield,
  Send,
  Plus,
  Trash2,
  Check,
  CheckSquare,
  Download,
  Upload,
  Play,
  Sparkles,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
  Search,
  RefreshCw,
  X,
  HelpCircle,
  ClipboardPaste,
  ClipboardCheck,
  Tag,
  Ban,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { AddElementModal, AddElementTarget } from './AddElementModal';
import { CommunityAutomationsModal } from './CommunityAutomationsModal';
import { AutomationImportModal } from './AutomationImportModal';
import { HaToggleSwitch } from './automation/HaToggleSwitch';
import { AutomationActionMenu } from './automation/AutomationActionMenu';
import { AutomationMoreInfoModal } from './automation/AutomationMoreInfoModal';
import { AutomationCategoryModal } from './automation/AutomationCategoryModal';
import { AutomationSettingsModal } from './automation/AutomationSettingsModal';
import { PrePushValidationModal } from './automation/PrePushValidationModal';
import { RuleSimulatorModal } from './automation/RuleSimulatorModal';
import { RuleFireRecord } from '../utils/ruleSimulator';
import { matchesRuleSearch } from '../utils/ruleSummaries';
import { validateAutomationRules, AutomationValidationReport } from '../utils/canValidator';
import {
  arrayMove,
  canAcceptGlobalPasteTarget,
  canReadSystemClipboard,
  ClipboardReadPermissionState,
  getActiveScopedDrag,
  parseClipboardText,
  queryClipboardReadPermission,
  resolveClipboardPaste,
  serializeClipboardEnvelope,
  setActiveScopedDrag
} from '../utils/automationClipboard';
import {
  AutomationClipboardContext,
  CLIPBOARD_STORAGE_KEY
} from './automation/AutomationClipboardContext';
import {
  LiveWifiStatus,
  LiveBleItem,
  evaluateConditionState
} from './automation/liveEvaluator';
import { SwipeableRuleItem } from './automation/SwipeableRuleItem';
import { TriggerNodeEditor } from './automation/TriggerNodeEditor';
import { ConditionListEditor } from './automation/ConditionNodeEditor';
import { ActionListEditor } from './automation/ActionNodeEditor';

interface AutomationBuilderProps {
  catalog: Catalog;
  rules: AutomationRule[];
  onUpdateRules: React.Dispatch<React.SetStateAction<AutomationRule[]>>;
  settings: AutomationSettings;
  onUpdateSettings: (newSettings: AutomationSettings) => void;
}

interface MqttRemoteConfig {
  wsUrl: string;
  deviceId: string;
  user: string;
  pass: string;
}

interface MqttSessionContext {
  client: mqtt.MqttClient;
  deviceId: string;
  isSettled: () => boolean;
  finish: (statusMsg?: string, clearAfterMs?: number, onSettled?: () => void) => void;
}

const EMPTY_LIVE_FRAMES = new Map<string, { data: string }>();

const mapWifi = (wData: any): LiveWifiStatus => ({
  sta_connected: !!wData.sta_connected,
  sta_ssid: wData.sta_ssid || '',
  sta_ip: wData.sta_ip || '',
  sta_rssi: typeof wData.sta_rssi === 'number' ? wData.sta_rssi : -65,
  ap_active: !!wData.ap_active,
  ap_clients: typeof wData.ap_clients === 'number' ? wData.ap_clients : 0
});

const upsertBle = (
  map: Map<string, LiveBleItem>,
  item: LiveBleItem,
  options?: { overwrite?: boolean; extraKeys?: string[] }
) => {
  const overwrite = options?.overwrite ?? true;
  const keys = [item.uuid, item.mac, item.address, item.name, ...(options?.extraKeys || [])];
  for (const rawKey of keys) {
    const key = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : '';
    if (!key) continue;
    if (overwrite || !map.has(key)) {
      map.set(key, item);
    }
  }
};

const createEmptyRule = (ruleNumber = 1, id = `rule_${Date.now().toString(36)}`): AutomationRule => ({
  id,
  name: `New Automation Rule #${ruleNumber}`,
  enabled: true,
  ha_expose: true,
  ha_icon: 'mdi:car-cog',
  exec_mode: 'one_shot',
  trigger_mode: 'any',
  cooldown_ms: 0,
  timeout_reset_ms: 0,
  triggers: [],
  conditions: [],
  actions: []
});

interface PushFabProps {
  syncing: boolean;
  ruleCount: number;
  onPush: () => void;
  onDismiss: () => void;
}

const PushFab: React.FC<PushFabProps> = ({ syncing, ruleCount, onPush, onDismiss }) => (
  <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
    <Button
      variant="primary"
      size="sm"
      isDisabled={syncing}
      onPress={onPush}
      className="ha-save-fab dirty !bg-warning !text-warning-foreground shadow-lg shadow-warning/25"
      aria-label="Push unsaved automation changes to device"
    >
      {syncing ? (
        <>
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>Pushing Changes...</span>
        </>
      ) : (
        <>
          <ArrowUp className="w-4 h-4" />
          <span>Push Changes ({ruleCount} Rule{ruleCount !== 1 ? 's' : ''})</span>
        </>
      )}
    </Button>
    <CloseButton
      aria-label="Dismiss push changes FAB"
      onPress={onDismiss}
      className="size-8 rounded-full bg-surface-secondary/90 hover:bg-surface-tertiary border border-border text-muted hover:text-foreground shadow-overlay backdrop-blur transition flex items-center justify-center shrink-0 cursor-pointer pointer-events-auto"
    />
  </div>
);

let triggerClientIdCounter = 0;

const createTriggerClientId = (hint?: string): string => {
  triggerClientIdCounter += 1;
  return `trig_client_${hint || triggerClientIdCounter}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
};

const ensureTriggerClientId = (trig: AutomationTrigger): AutomationTrigger =>
  trig._clientId ? trig : { ...trig, _clientId: createTriggerClientId(trig.id) };

const ensureRuleTriggerClientIds = (rule: AutomationRule): AutomationRule => {
  const triggers = rule.triggers || [];
  if (triggers.every(t => Boolean(t._clientId))) return rule;
  return {
    ...rule,
    triggers: triggers.map(ensureTriggerClientId)
  };
};

const ensureRulesTriggerClientIds = (ruleList: AutomationRule[]): AutomationRule[] => {
  let changed = false;
  const next = ruleList.map(rule => {
    const ensured = ensureRuleTriggerClientIds(rule);
    if (ensured !== rule) changed = true;
    return ensured;
  });
  return changed ? next : ruleList;
};

const serializeRulesForDirtyCheck = (ruleList: AutomationRule[]): string =>
  JSON.stringify(ruleList, (key, value) => (key === '_clientId' ? undefined : value));

const getInitialEspIp = (): string => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('cando_device_host') : null;
    const trimmed = (saved || '').trim();
    if (trimmed && trimmed !== 'auto') {
      return trimmed;
    }
  } catch {}
  return getDefaultEspIp();
};

const createTimedAbortSignal = (
  parentSignal: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } => {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.any === 'function' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return {
      signal: AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]),
      cleanup: () => {}
    };
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  };
};

export const AutomationBuilder: React.FC<AutomationBuilderProps> = ({
  catalog,
  rules,
  onUpdateRules,
  settings,
  onUpdateSettings
}) => {
  const [selectedRuleId, setSelectedRuleId] = useState<string>(
    rules.length > 0 ? rules[0].id : ''
  );
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedRuleIdsForDelete, setSelectedRuleIdsForDelete] = useState<Set<string>>(new Set());
  const [ruleSearchQuery, setRuleSearchQuery] = useState('');
  const [showBulkCategoryInput, setShowBulkCategoryInput] = useState(false);
  const [bulkCategoryValue, setBulkCategoryValue] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [addElementTarget, setAddElementTarget] = useState<AddElementTarget | null>(null);
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [showCommunityModal, setShowCommunityModal] = useState(false);
  const [ruleFireStats, setRuleFireStats] = useState<Record<string, RuleFireRecord>>({});
  const [recentlyFiredIds, setRecentlyFiredIds] = useState<Set<string>>(new Set());
  const [relativeTimeTick, setRelativeTimeTick] = useState<number>(() => Date.now());
  const [espIp, setEspIp] = useState<string>(() => getInitialEspIp());
  const [espIpDraft, setEspIpDraft] = useState<string>(() => getInitialEspIp());
  const espIpRef = useRef<string>(espIp);
  espIpRef.current = espIp;
  const espIpDraftRef = useRef<string>(espIpDraft);
  espIpDraftRef.current = espIpDraft;
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [communityModalTab, setCommunityModalTab] = useState<'browse' | 'share'>('browse');
  const [moreInfoRule, setMoreInfoRule] = useState<AutomationRule | null>(null);
  const [editingCategoryRule, setEditingCategoryRule] = useState<AutomationRule | null>(null);
  const [editingSettingsRule, setEditingSettingsRule] = useState<AutomationRule | null>(null);
  const [prePushReport, setPrePushReport] = useState<AutomationValidationReport | null>(null);
  const [pendingPullConfirmation, setPendingPullConfirmation] = useState<{
    rules: AutomationRule[];
    settings?: AutomationSettings;
    sourceLabel: string;
    hasUnpushedChanges: boolean;
    isEmptyDeviceOverwrite: boolean;
  } | null>(null);

  const isMountedRef = useRef<boolean>(true);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMqttClientsRef = useRef<Set<mqtt.MqttClient>>(new Set());
  const mqttTimeoutTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const latestRulesRef = useRef<AutomationRule[]>(rules);
  latestRulesRef.current = rules;

  const rulesJson = useMemo(() => serializeRulesForDirtyCheck(rules), [rules]);
  const [lastPushedJson, setLastPushedJson] = useState<string>(() => rulesJson);
  const lastPushedJsonRef = useRef<string>(lastPushedJson);
  lastPushedJsonRef.current = lastPushedJson;
  const hasUnpushedChanges = useMemo(
    () => lastPushedJson !== rulesJson,
    [lastPushedJson, rulesJson]
  );

  const markRulesAsSynced = useCallback((snapshotJson: string) => {
    lastPushedJsonRef.current = snapshotJson;
    if (isMountedRef.current) {
      setLastPushedJson(snapshotJson);
    }
  }, []);

  const commitEspIp = useCallback((rawValue?: string): string => {
    const candidate = (rawValue !== undefined ? rawValue : espIpDraftRef.current).trim();
    const nextHost = candidate || getDefaultEspIp();
    espIpDraftRef.current = nextHost;
    espIpRef.current = nextHost;
    setEspIpDraft(nextHost);
    setEspIp(prev => (prev === nextHost ? prev : nextHost));
    deviceWs.setHost(nextHost);
    return nextHost;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleHostStorage = (e: StorageEvent) => {
      if (e.key !== 'cando_device_host') return;
      const synced = getInitialEspIp();
      espIpDraftRef.current = synced;
      espIpRef.current = synced;
      setEspIpDraft(synced);
      setEspIp(prev => (prev === synced ? prev : synced));
    };
    window.addEventListener('storage', handleHostStorage);
    return () => window.removeEventListener('storage', handleHostStorage);
  }, []);

  // Ensure loaded rules have stable _clientId values on triggers without mutating during render
  useEffect(() => {
    if (!rules.some(r => (r.triggers || []).some(t => !t._clientId))) return;
    onUpdateRules(prev => ensureRulesTriggerClientIds(prev));
  }, [rules, onUpdateRules]);

  const [mounted, setMounted] = useState(false);
  const [isPushFabDismissed, setIsPushFabDismissed] = useState(false);
  const prevRulesJsonRef = useRef<string>(rulesJson);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (lastPushedJson === rulesJson) {
      setIsPushFabDismissed(false);
    } else if (rulesJson !== prevRulesJsonRef.current) {
      // Re-surface FAB on new edits
      setIsPushFabDismissed(false);
    }
    prevRulesJsonRef.current = rulesJson;
  }, [rulesJson, lastPushedJson]);

  const portalTarget = mounted && typeof document !== 'undefined' ? document.getElementById('ha-fab-stack') : null;


  const [actionTestToast, setActionTestToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const triggerListId = useId();
  const [triggerDragIdx, setTriggerDragIdx] = useState<number | null>(null);
  const [triggerDragOverIdx, setTriggerDragOverIdx] = useState<number | null>(null);

  const clearToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    if (isMountedRef.current) {
      setActionTestToast(null);
    }
  }, []);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' | 'info', autoClearMs?: number) => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (!isMountedRef.current) return;
      setActionTestToast({ message, type });
      if (autoClearMs && autoClearMs > 0) {
        toastTimerRef.current = setTimeout(() => {
          toastTimerRef.current = null;
          if (isMountedRef.current) {
            setActionTestToast(null);
          }
        }, autoClearMs);
      }
    },
    []
  );

  const showSyncStatus = useCallback((message: string | null, autoClearMs?: number) => {
    if (syncStatusTimerRef.current !== null) {
      clearTimeout(syncStatusTimerRef.current);
      syncStatusTimerRef.current = null;
    }
    if (!isMountedRef.current) return;
    setSyncStatus(message);
    if (message !== null && autoClearMs && autoClearMs > 0) {
      syncStatusTimerRef.current = setTimeout(() => {
        syncStatusTimerRef.current = null;
        if (isMountedRef.current) {
          setSyncStatus(null);
        }
      }, autoClearMs);
    }
  }, []);

  const showClipboardToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    showToast(message, type, 3200);
  }, [showToast]);

  const persistClipboardStorage = useCallback((item: AutomationClipboardItem | null) => {
    try {
      if (item) {
        const serialized = JSON.stringify(item);
        localStorage.setItem(CLIPBOARD_STORAGE_KEY, serialized);
        sessionStorage.setItem(CLIPBOARD_STORAGE_KEY, serialized);
      } else {
        localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
        sessionStorage.removeItem(CLIPBOARD_STORAGE_KEY);
      }
    } catch {
      // Storage quota or disabled
    }
  }, []);

  // Global Automation Clipboard state (synced across tabs via localStorage + OS clipboard when granted / on Ctrl+V)
  const [clipboard, setClipboard] = useState<AutomationClipboardItem | null>(() => {
    try {
      const saved = localStorage.getItem(CLIPBOARD_STORAGE_KEY) || sessionStorage.getItem(CLIPBOARD_STORAGE_KEY);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === 'object' && parsed.type && parsed.payload ? parsed : null;
    } catch {
      return null;
    }
  });
  const clipboardOriginRef = useRef<'app' | 'system' | 'paste' | null>(clipboard ? 'app' : null);
  const osClipboardSyncedRef = useRef(false);
  const clipboardPermissionRef = useRef<ClipboardReadPermissionState>('prompt');

  const copyToClipboard = useCallback((type: ClipboardBlockType, payload: any, label: string) => {
    const item: AutomationClipboardItem = {
      type,
      payload: deepClone(payload),
      timestamp: Date.now(),
      label
    };
    clipboardOriginRef.current = 'app';
    osClipboardSyncedRef.current = false;
    setClipboard(item);
    persistClipboardStorage(item);

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(serializeClipboardEnvelope(item))
        .then(() => {
          osClipboardSyncedRef.current = true;
          showClipboardToast(`Copied "${label}" to system clipboard.`, 'success');
        })
        .catch(() => {
          showClipboardToast(`Copied "${label}" (in-app clipboard).`, 'info');
        });
    } else {
      showClipboardToast(`Copied "${label}" (in-app clipboard).`, 'info');
    }
  }, [persistClipboardStorage, showClipboardToast]);

  const clearClipboard = useCallback(() => {
    clipboardOriginRef.current = null;
    osClipboardSyncedRef.current = false;
    setClipboard(null);
    persistClipboardStorage(null);
  }, [persistClipboardStorage]);

  const syncFromSystemClipboard = useCallback(async () => {
    if (!canReadSystemClipboard()) return;
    if (clipboardPermissionRef.current !== 'granted') return;
    try {
      const rawText = await navigator.clipboard.readText();
      const parsed = parseClipboardText(rawText);
      if (parsed) {
        setClipboard(prev => {
          const prevPayload = prev ? JSON.stringify(prev.payload) : '';
          const nextPayload = JSON.stringify(parsed.payload);
          if (prev && prev.type === parsed.type && prev.label === parsed.label && prevPayload === nextPayload) {
            return prev;
          }
          clipboardOriginRef.current = 'system';
          osClipboardSyncedRef.current = true;
          persistClipboardStorage(parsed);
          return parsed;
        });
      } else if (clipboardOriginRef.current === 'system' || osClipboardSyncedRef.current) {
        // OS clipboard now holds non-CAN-Do content (plain text, URL, etc.) -> hide stale Paste pills
        clipboardOriginRef.current = null;
        osClipboardSyncedRef.current = false;
        setClipboard(null);
        persistClipboardStorage(null);
      }
    } catch {
      // Document may not be focused or permission revoked; keep existing state
    }
  }, [persistClipboardStorage]);

  // 1. Cross-tab clipboard sync via localStorage storage events
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== CLIPBOARD_STORAGE_KEY) return;
      if (!e.newValue) {
        clipboardOriginRef.current = null;
        osClipboardSyncedRef.current = false;
        setClipboard(null);
        return;
      }
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && typeof parsed === 'object' && parsed.type && parsed.payload) {
          clipboardOriginRef.current = 'app';
          setClipboard(parsed);
        }
      } catch {
        // Ignore malformed storage payload
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // 2. Silent OS clipboard inspection when 'clipboard-read' permission is already granted
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let active = true;
    let permStatus: PermissionStatus | null = null;

    const refreshClipboard = () => {
      if (!active) return;
      if (clipboardPermissionRef.current === 'granted') {
        void syncFromSystemClipboard();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshClipboard();
      }
    };

    const initPermissionWatcher = async () => {
      const state = await queryClipboardReadPermission();
      if (!active) return;
      clipboardPermissionRef.current = state;
      if (state === 'granted') {
        void syncFromSystemClipboard();
      }
      if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
        try {
          permStatus = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
          if (!active) return;
          permStatus.onchange = () => {
            if (!active || !permStatus) return;
            clipboardPermissionRef.current = permStatus.state as ClipboardReadPermissionState;
            if (permStatus.state === 'granted') {
              void syncFromSystemClipboard();
            } else if (permStatus.state === 'denied' && clipboardOriginRef.current === 'system') {
              clearClipboard();
            }
          };
        } catch {
          // Browser doesn't support clipboard-read permission query (e.g. Firefox/Safari)
        }
      }
    };

    void initPermissionWatcher();
    window.addEventListener('focus', refreshClipboard);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      if (permStatus) permStatus.onchange = null;
      window.removeEventListener('focus', refreshClipboard);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [clearClipboard, syncFromSystemClipboard]);

  // 3. Zero-permission Ctrl+V / Cmd+V global paste detection (only outside form inputs/modals)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleWindowPaste = (e: ClipboardEvent) => {
      if (!canAcceptGlobalPasteTarget(e.target)) return;
      const rawText = e.clipboardData?.getData('text/plain') || '';
      if (!rawText) return;
      const parsed = parseClipboardText(rawText);
      if (!parsed) return;
      e.preventDefault();
      clipboardOriginRef.current = 'paste';
      osClipboardSyncedRef.current = true;
      setClipboard(parsed);
      persistClipboardStorage(parsed);
      const friendlyType =
        parsed.type === 'choice_branch' || parsed.type === 'branch'
          ? 'Choice Branch'
          : parsed.type.charAt(0).toUpperCase() + parsed.type.slice(1);
      showClipboardToast(
        `Loaded ${friendlyType} "${parsed.label}" from clipboard — click Paste in the matching section.`,
        'info'
      );
    };
    window.addEventListener('paste', handleWindowPaste);
    return () => window.removeEventListener('paste', handleWindowPaste);
  }, [persistClipboardStorage, showClipboardToast]);

  const pastePayload = useCallback((targetType?: ClipboardBlockType): any | null => {
    if (!clipboard) return null;
    const res = resolveClipboardPaste(clipboard, targetType || clipboard.type);
    return res.ok ? res.data : null;
  }, [clipboard]);

  const pasteFromClipboard = useCallback(async (targetType: ClipboardBlockType): Promise<any | null> => {
    // 1. If OS clipboard read permission is already granted, read fresh OS clipboard first
    if (clipboardPermissionRef.current === 'granted' && canReadSystemClipboard()) {
      try {
        const rawText = await navigator.clipboard.readText();
        const parsedSystemItem = parseClipboardText(rawText);
        if (parsedSystemItem) {
          const res = resolveClipboardPaste(parsedSystemItem, targetType);
          if (res.ok) {
            clipboardOriginRef.current = 'system';
            osClipboardSyncedRef.current = true;
            setClipboard(parsedSystemItem);
            persistClipboardStorage(parsedSystemItem);
            showClipboardToast(
              res.convertedFrom
                ? `Pasted & converted "${parsedSystemItem.label}" from system clipboard.`
                : `Pasted "${parsedSystemItem.label}" from system clipboard.`,
              'success'
            );
            return res.data;
          }
          if ('reason' in res) {
            showClipboardToast(res.reason, 'error');
          }
          return null;
        }
      } catch {
        // Fall through to cached clipboard item
      }
    }

    // 2. Use cached in-app / cross-tab / Ctrl+V clipboard item without prompting for OS permissions
    if (clipboard) {
      const res = resolveClipboardPaste(clipboard, targetType);
      if (res.ok) {
        return res.data;
      }
      if ('reason' in res) {
        showClipboardToast(res.reason, 'error');
      }
      return null;
    }

    showClipboardToast('Clipboard does not contain a valid CAN Do block JSON.', 'info');
    return null;
  }, [clipboard, persistClipboardStorage, showClipboardToast]);

  const [useMqttSync, setUseMqttSync] = useState(false);
  const [mqttRemoteConfig, setMqttRemoteConfig] = useState({
    wsUrl: 'wss://broker:port',
    deviceId: 'my_device',
    user: '',
    pass: ''
  });
  const updateMqttConfig = (patch: any) => {
    setMqttRemoteConfig(prev => ({ ...prev, ...patch }));
  };

  // Section collapse states
  const [collapsedTriggers, setCollapsedTriggers] = useState(false);
  const [collapsedConditions, setCollapsedConditions] = useState(false);
  const [collapsedActions, setCollapsedActions] = useState(false);

  // Live Entity states for real-time condition validity evaluation
  const [entityStates, setEntityStates] = useState<Map<string, string>>(new Map());

  // Live Wi-Fi & BLE status for condition validity & threshold auto-population
  const [liveWifiStatus, setLiveWifiStatus] = useState<LiveWifiStatus | null>(null);
  const [liveBleMap, setLiveBleMap] = useState<Map<string, LiveBleItem>>(new Map());
  const bleMapRef = useRef<Map<string, LiveBleItem>>(new Map());

  const entityStatesRef = useRef<Map<string, string>>(new Map());
  const pingPongDirRef = useRef<Map<string, number>>(new Map());
  const fireTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clean up all timers and active MQTT clients on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (syncStatusTimerRef.current !== null) {
        clearTimeout(syncStatusTimerRef.current);
        syncStatusTimerRef.current = null;
      }
      fireTimersRef.current.forEach(timer => clearTimeout(timer));
      fireTimersRef.current.clear();
      mqttTimeoutTimersRef.current.forEach(timer => clearTimeout(timer));
      mqttTimeoutTimersRef.current.clear();
      activeMqttClientsRef.current.forEach(client => {
        try {
          client.end(true);
        } catch {}
      });
      activeMqttClientsRef.current.clear();
    };
  }, []);

  const recordRuleFired = useCallback((ruleId: string) => {
    if (!ruleId || !isMountedRef.current) return;
    const now = Date.now();
    setRelativeTimeTick(now);
    setRuleFireStats(prev => {
      const existing = prev[ruleId];
      // Guard against duplicate WS + HTTP echo within 400ms
      if (existing && now - existing.lastFiredAt < 400) {
        return prev;
      }
      return {
        ...prev,
        [ruleId]: {
          lastFiredAt: now,
          count: (existing?.count || 0) + 1
        }
      };
    });
    setRecentlyFiredIds(prev => {
      const next = new Set(prev);
      next.add(ruleId);
      return next;
    });
    const prevTimer = fireTimersRef.current.get(ruleId);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      fireTimersRef.current.delete(ruleId);
      if (!isMountedRef.current) return;
      setRecentlyFiredIds(prev => {
        if (!prev.has(ruleId)) return prev;
        const next = new Set(prev);
        next.delete(ruleId);
        return next;
      });
    }, 2500);
    fireTimersRef.current.set(ruleId, timer);
  }, []);

  // Periodic tick to keep "Just now" -> "Xs ago" -> "Xm ago" -> "Xh ago" badges fresh
  useEffect(() => {
    if (Object.keys(ruleFireStats).length === 0) return;
    const interval = setInterval(() => {
      setRelativeTimeTick(Date.now());
    }, 5000);
    return () => clearInterval(interval);
  }, [ruleFireStats]);

  // WebSocket connection & background polling for live telemetry
  useEffect(() => {
    let isCancelled = false;
    let pollInFlight = false;
    let hadWsConnection = false;
    const effectAbortController = new AbortController();

    // Clear previous device telemetry whenever the committed host changes
    entityStatesRef.current.clear();
    bleMapRef.current.clear();
    setEntityStates(new Map());
    setLiveBleMap(new Map());
    setLiveWifiStatus(null);

    // Ensure deviceWs and localStorage.cando_device_host target the same ESP32 as REST fetches
    deviceWs.setHost(espIp);

    let statesDirty = false;
    let bleDirty = false;
    let wsFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPendingWsFlush = () => {
      if (wsFlushTimer !== null) {
        clearTimeout(wsFlushTimer);
        wsFlushTimer = null;
      }
      statesDirty = false;
      bleDirty = false;
    };

    const flushWsUpdates = () => {
      wsFlushTimer = null;
      if (isCancelled) return;
      if (statesDirty) {
        statesDirty = false;
        setEntityStates(new Map(entityStatesRef.current));
      }
      if (bleDirty) {
        bleDirty = false;
        setLiveBleMap(new Map(bleMapRef.current));
      }
    };

    const scheduleWsFlush = () => {
      if (isCancelled || wsFlushTimer !== null) return;
      wsFlushTimer = setTimeout(flushWsUpdates, 150);
    };

    // Fetch initial entity states via REST
    const fetchInitialStates = async () => {
      const { signal, cleanup } = createTimedAbortSignal(effectAbortController.signal, 3000);
      try {
        const base = resolveDeviceBaseUrl(espIp);
        const res = await fetch(`${base}/api/states`, { signal });
        if (isCancelled || !res.ok) return;
        const data = await res.json();
        if (isCancelled || !Array.isArray(data)) return;
        for (const item of data) {
          if (item && typeof item.entity === 'string' && item.state !== undefined) {
            entityStatesRef.current.set(item.entity.toLowerCase(), String(item.state));
          }
        }
        setEntityStates(new Map(entityStatesRef.current));
      } catch {
        // Device not connected or running in simulator mode
      } finally {
        cleanup();
      }
    };

    // Fetch live Wi-Fi and BLE status (in-flight guarded, separate try blocks, 3s timeout per request)
    const fetchLiveNetworkAndBle = async () => {
      if (pollInFlight || isCancelled) return;
      pollInFlight = true;
      const base = resolveDeviceBaseUrl(espIp);

      try {
        // Wi-Fi Status
        const wifiSignal = createTimedAbortSignal(effectAbortController.signal, 3000);
        try {
          const wifiRes = await fetch(`${base}/api/wifi/status`, { signal: wifiSignal.signal });
          if (!isCancelled && wifiRes.ok) {
            const wData = await wifiRes.json();
            if (!isCancelled && wData && typeof wData === 'object') {
              setLiveWifiStatus(mapWifi(wData));
            }
          }
        } catch {
          // Offline / Wi-Fi JSON failure must not skip BLE poll
        } finally {
          wifiSignal.cleanup();
        }

        if (isCancelled) return;

        // BLE Status
        const bleSignal = createTimedAbortSignal(effectAbortController.signal, 3000);
        try {
          const bleRes = await fetch(`${base}/api/ble/status`, { signal: bleSignal.signal });
          if (!isCancelled && bleRes.ok) {
            const bData = await bleRes.json();
            if (!isCancelled && bData && typeof bData === 'object') {
              // Rebuild from scratch on each poll so disconnected devices and removed beacons do not linger
              const nextBleMap = new Map<string, LiveBleItem>();
              if (Array.isArray(bData.beacon_targets)) {
                for (const b of bData.beacon_targets) {
                  upsertBle(nextBleMap, {
                    name: b.name,
                    uuid: b.uuid,
                    mac: b.mac,
                    major: typeof b.major === 'number' ? b.major : undefined,
                    minor: typeof b.minor === 'number' ? b.minor : undefined,
                    rssi: typeof b.rssi === 'number' ? b.rssi : undefined,
                    is_present: Boolean(b.is_present),
                    connected: false
                  });
                }
              }
              if (Array.isArray(bData.discovered_beacons)) {
                for (const b of bData.discovered_beacons) {
                  upsertBle(
                    nextBleMap,
                    {
                      name: b.name,
                      uuid: b.uuid,
                      mac: b.mac,
                      major: typeof b.major === 'number' ? b.major : undefined,
                      minor: typeof b.minor === 'number' ? b.minor : undefined,
                      rssi: typeof b.rssi === 'number' ? b.rssi : undefined,
                      is_present: true,
                      connected: false
                    },
                    { overwrite: false }
                  );
                }
              }
              if (bData.connected_device) {
                const cd = bData.connected_device;
                upsertBle(
                  nextBleMap,
                  {
                    name: cd.name,
                    address: cd.address,
                    mac: cd.address,
                    rssi: cd.rssi,
                    is_present: true,
                    connected: true
                  },
                  { extraKeys: ['connected_device'] }
                );
              }
              bleMapRef.current = nextBleMap;
              bleDirty = false;
              setLiveBleMap(new Map(nextBleMap));
            }
          }
        } catch {
          // Offline / simulator mode
        } finally {
          bleSignal.cleanup();
        }
      } finally {
        pollInFlight = false;
      }
    };

    void fetchInitialStates();
    void fetchLiveNetworkAndBle();
    const pollInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void fetchLiveNetworkAndBle();
    }, 4000);

    const unsubscribeConn = deviceWs.onConnectionChange((connected) => {
      if (isCancelled) return;
      if (connected) {
        hadWsConnection = true;
      } else if (hadWsConnection) {
        // WebSocket dropped: mark live telemetry unknown/stale so condition gates don't show stale data
        clearPendingWsFlush();
        entityStatesRef.current.clear();
        bleMapRef.current.clear();
        setEntityStates(new Map());
        setLiveBleMap(new Map());
        setLiveWifiStatus(null);
      }
    });

    const unsubscribeMsgs = deviceWs.subscribe((msg) => {
      if (isCancelled) return;
      if (msg.type === 'state' && (msg as any).entity) {
        entityStatesRef.current.set(String((msg as any).entity).toLowerCase(), String((msg as any).state || ''));
        statesDirty = true;
        scheduleWsFlush();
      } else if (msg.type === 'automation_fired') {
        const firedRuleId = String((msg as any).id || '').trim();
        if (firedRuleId) {
          recordRuleFired(firedRuleId);
        }
      } else if (msg.type === 'ble_beacon') {
        const raw = msg as any;
        const evt = typeof raw.event === 'string' ? raw.event.toLowerCase() : '';
        const isExit = evt === 'exit' || evt === 'away';
        const isPresent = typeof raw.is_present === 'boolean'
          ? raw.is_present
          : evt === 'enter' || evt === 'proximity' || evt === 'present'
            ? true
            : false;
        const item: LiveBleItem = {
          name: raw.name,
          uuid: raw.uuid,
          mac: raw.mac || raw.address,
          major: typeof raw.major === 'number' ? raw.major : undefined,
          minor: typeof raw.minor === 'number' ? raw.minor : undefined,
          rssi: isExit ? undefined : raw.rssi,
          is_present: isPresent,
          connected: false
        };
        upsertBle(bleMapRef.current, item);
        bleDirty = true;
        scheduleWsFlush();
      }
    });

    return () => {
      isCancelled = true;
      effectAbortController.abort();
      clearPendingWsFlush();
      clearInterval(pollInterval);
      unsubscribeConn();
      unsubscribeMsgs();
    };
  }, [espIp, recordRuleFired]);

  // Formats any raw payload or ByteMap into clean 8-byte space-separated hex.
  // Returns null when payload is undefined, empty, or unresolved so callers never emit an all-zero CAN frame.
  const formatPayloadForApi = (payload: string | any): string | null => {
    if (payload === undefined || payload === null) {
      return null;
    }
    const byteMap = compileToByteMap(payload);
    if (Object.keys(byteMap).length === 0) {
      return null;
    }
    const hexBytes: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const key = `D${i}`;
      const rawVal = byteMap[key] || '0x00';
      const hexVal = String(rawVal).replace(/^0x/i, '').padStart(2, '0').slice(-2).toUpperCase();
      hexBytes.push(hexVal);
    }
    return hexBytes.join(' ');
  };

  // Handler for testing an individual action manually across all command types and structures
  const handleTestSingleAction = async (act: AutomationAction): Promise<{ ok: boolean; error?: string }> => {
    try {
      const base = resolveDeviceBaseUrl(espIpRef.current);

      // Flow 1: Delay
      if (act.type === 'delay') {
        const ms = act.delay_ms || act.ms || 1000;
        showToast(`Testing delay: waiting ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}...`, 'info');
        await new Promise(r => setTimeout(r, Math.min(ms, 3000)));
        showToast(`Delay test completed (${ms}ms)`, 'success', 3500);
        return { ok: true };
      }

      // Flow 2: Wait For Condition
      if (act.type === 'wait_for') {
        const condList = act.conditions && act.conditions.length > 0 ? act.conditions : (act.condition ? [act.condition] : []);
        if (condList.length === 0) {
          showToast('Wait-for action has no target condition (will proceed immediately)', 'info', 4000);
          return { ok: true };
        }
        const results = condList.map(c => evaluateConditionState(c, undefined, entityStates, undefined, catalog, liveWifiStatus, liveBleMap));
        const matchedResult = results.find(r => r.state === 'valid') || results[0];
        const isMatched = matchedResult.state === 'valid';
        showToast(
          `Wait-for condition: ${isMatched ? 'MATCHED' : matchedResult.state === 'invalid' ? 'NOT MET' : 'Awaiting telemetry'} (${matchedResult.reason || 'live state'})`,
          isMatched ? 'success' : 'info',
          4500
        );
        return { ok: true };
      }

      // Flow 2b: Repeat Until (Loop) - preview 1 safe iteration when stop condition is not yet met
      if (act.type === 'repeat_until') {
        const condList = act.conditions && act.conditions.length > 0 ? act.conditions : (act.condition ? [act.condition] : []);
        const seq = act.sequence || [];
        if (condList.length > 0) {
          const results = condList.map(c => evaluateConditionState(c, undefined, entityStates, undefined, catalog, liveWifiStatus, liveBleMap));
          const met = results.some(r => r.state === 'valid');
          if (met) {
            showToast(
              'Repeat-Until stop condition is ALREADY MET; loop skipped.',
              'success',
              4000
            );
            return { ok: true };
          }
        }
        if (seq.length === 0) {
          showToast('Repeat-Until has no loop body actions to execute.', 'info', 3500);
          return { ok: true };
        }
        showToast(
          `Repeat-Until: Running 1 preview pass (${seq.length} action${seq.length !== 1 ? 's' : ''})...`,
          'info'
        );
        for (const subAct of seq) {
          const subRes = await handleTestSingleAction(subAct);
          if (!subRes.ok) return subRes;
        }
        return { ok: true };
      }

      // Flow 3: IF-THEN-ELSE
      if (act.type === 'if_then') {
        const condList = act.conditions || [];
        const passed = condList.length === 0 || condList.every(c => evaluateConditionState(c, undefined, entityStates, undefined, catalog, liveWifiStatus, liveBleMap).state === 'valid');
        const branchActs = passed ? (act.then || []) : (act.else || []);
        showToast(
          `IF-THEN evaluated to ${passed ? 'TRUE' : 'FALSE'}. ${branchActs.length > 0 ? `Testing ${branchActs.length} action(s) in ${passed ? 'THEN' : 'ELSE'} branch` : `Empty ${passed ? 'THEN' : 'ELSE'} branch`}`,
          'info',
          branchActs.length > 0 ? undefined : 4000
        );
        if (branchActs.length > 0) {
          for (const subAct of branchActs) {
            const subRes = await handleTestSingleAction(subAct);
            if (!subRes.ok) return subRes;
          }
        }
        return { ok: true };
      }

      // Flow 4: CHOOSE
      if (act.type === 'choose') {
        const choices = act.choices || [];
        let matchedBranch: AutomationAction[] | null = null;
        let matchedIdx = -1;
        for (let i = 0; i < choices.length; i++) {
          const ch = choices[i];
          const conds = ch.conditions || [];
          if (conds.length === 0 || conds.every(c => evaluateConditionState(c, undefined, entityStates, undefined, catalog, liveWifiStatus, liveBleMap).state === 'valid')) {
            matchedBranch = ch.sequence || [];
            matchedIdx = i;
            break;
          }
        }
        if (!matchedBranch) {
          matchedBranch = act.default || [];
        }
        showToast(
          `CHOOSE branch: ${matchedIdx >= 0 ? `Branch #${matchedIdx + 1}` : 'DEFAULT'}. ${matchedBranch.length > 0 ? `Testing ${matchedBranch.length} action(s)` : 'Empty sequence'}`,
          'info',
          matchedBranch.length > 0 ? undefined : 4000
        );
        if (matchedBranch.length > 0) {
          for (const subAct of matchedBranch) {
            const subRes = await handleTestSingleAction(subAct);
            if (!subRes.ok) return subRes;
          }
        }
        return { ok: true };
      }

      // Flow 5: Legacy Webhook (not supported on offline ESP32 firmware)
      if (act.type === 'webhook') {
        const errMsg = 'Webhook actions are not supported on offline ESP32 firmware.';
        showToast(errMsg, 'error', 4500);
        return { ok: false, error: errMsg };
      }

      // Flow 6: Cluster Notification Popup
      if (act.type === 'track_popup' || act.type === 'popup') {
        const msg = act.text || act.popup_message || 'Test cluster notification';
        let res: Response;
        try {
          res = await fetch(`${base}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, level: act.level || 'info' })
          });
        } catch {
          showToast(
            `Simulated cluster popup (device unreachable): "${msg}"`,
            'info',
            4000
          );
          return { ok: true };
        }
        if (res.ok) {
          showToast(`Triggered cluster popup: "${msg}"`, 'success', 4000);
          return { ok: true };
        }
        const errBody = (await res.text().catch(() => '')).trim();
        const errMsg = `Cluster popup failed (HTTP ${res.status}): ${errBody || res.statusText || 'Request rejected'}`;
        showToast(errMsg, 'error', 5000);
        return { ok: false, error: errMsg };
      }

      // Flow 6b: HUD / Cluster Turn-by-Turn Navigation Guidance
      if (act.type === 'hud_nav' || act.type === 'nav') {
        const navMode = (act.nav_action || act.action || 'update') === 'clear' ? 'clear' : 'update';
        const distMeters = act.distance_meters ?? act.distance ?? 200;
        const navPayload =
          navMode === 'clear'
            ? { action: 'clear' }
            : {
                action: 'update',
                icon: act.icon ?? 1,
                direction_deg: act.direction_deg ?? 0,
                distance_meters: distMeters,
                bars: act.bars ?? 4,
                speed_limit: act.speed_limit ?? 0,
                camera_alert: !!act.camera_alert,
                street: act.street || '',
                ...(act.num_lanes || act.lanes
                  ? {
                      num_lanes: act.num_lanes ?? act.lanes,
                      lane_directions: act.lane_directions || [],
                      lane_recommended: act.lane_recommended || []
                    }
                  : {})
              };
        let res: Response;
        try {
          res = await fetch(`${base}/api/nav`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(navPayload)
          });
        } catch {
          showToast(
            navMode === 'clear'
              ? 'Simulated HUD navigation clear (device unreachable)'
              : `Simulated HUD guidance (device unreachable)${act.street ? `: "${act.street}"` : ''} (${Math.round(distMeters * 3.28084)} ft / ${distMeters}m)`,
            'info',
            4000
          );
          return { ok: true };
        }
        if (res.ok) {
          showToast(
            navMode === 'clear'
              ? 'Cleared HUD navigation guidance'
              : `Projected HUD guidance${act.street ? `: "${act.street}"` : ''}`,
            'success',
            4000
          );
          return { ok: true };
        }
        const errBody = (await res.text().catch(() => '')).trim();
        const errMsg = `HUD navigation failed (HTTP ${res.status}): ${errBody || res.statusText || 'Request rejected'}`;
        showToast(errMsg, 'error', 5000);
        return { ok: false, error: errMsg };
      }

      // Flow: Cycle Entity State Stepper (must run before generic CAN / multi-step flows!)
      if (act.type === 'cycle_entity') {
        const entId = act.entity_id || act.target_command_id || 'drivers_seat_comfort';
        const { command: cycleCmd } = catalog
          ? resolveCatalogCommandForAction({ ...act, entity_id: entId }, catalog)
          : { command: undefined };
        const defaultStates =
          cycleCmd?.options && cycleCmd.options.length > 0
            ? cycleCmd.options.map(o => o.label)
            : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
        const states = act.states && act.states.length > 0 ? act.states : defaultStates;
        const curState =
          entityStatesRef.current.get(entId.toLowerCase()) ||
          entityStatesRef.current.get(entId) ||
          entityStates.get(entId.toLowerCase()) ||
          entityStates.get(entId) ||
          states[0];
        const curIdx = states.findIndex(s => s.toLowerCase() === curState.toLowerCase());
        const dir = act.direction || 'forward';

        let nextState: string | null = null;
        if (curIdx < 0) {
          const fb = act.fallback_state || '__first__';
          if (fb === '__none__') {
            showToast(
              `Cycle ${entId}: current state "${curState}" is outside sequence (Fallback: Do Nothing)`,
              'info',
              4000
            );
            return { ok: true };
          }
          nextState = fb === '__first__' ? states[0] : fb;
          if (dir === 'ping_pong') {
            pingPongDirRef.current.set(act.id || entId, 1);
          }
        } else if (dir === 'ping_pong') {
          const ppKey = act.id || entId;
          let ppDir = pingPongDirRef.current.get(ppKey) ?? 1;
          if (curIdx === 0) ppDir = 1;
          else if (curIdx === states.length - 1) ppDir = -1;
          const nextIdx = Math.max(0, Math.min(states.length - 1, curIdx + ppDir));
          nextState = states[nextIdx];
          if (ppDir > 0 && nextIdx >= states.length - 1) {
            pingPongDirRef.current.set(ppKey, -1);
          } else if (ppDir < 0 && nextIdx <= 0) {
            pingPongDirRef.current.set(ppKey, 1);
          } else {
            pingPongDirRef.current.set(ppKey, ppDir);
          }
        } else if (dir === 'forward') {
          let nextIdx = curIdx + 1;
          if (nextIdx >= states.length) {
            nextIdx = act.wrap !== false ? 0 : states.length - 1;
          }
          nextState = states[nextIdx];
        } else {
          let nextIdx = curIdx - 1;
          if (nextIdx < 0) {
            nextIdx = act.wrap !== false ? states.length - 1 : 0;
          }
          nextState = states[nextIdx];
        }

        const nextOpt = cycleCmd?.options?.find(
          o => o.label.toLowerCase() === nextState!.toLowerCase() || o.id === nextState
        );
        if (cycleCmd && nextOpt) {
          const syntheticAct = commandToAction(cycleCmd, nextOpt);
          const stepRes = await handleTestSingleAction(syntheticAct);
          if (!stepRes.ok) return stepRes;
        }

        // Update local entity state map so consecutive Test clicks step cleanly through the sequence
        entityStatesRef.current.set(entId.toLowerCase(), nextState);
        entityStatesRef.current.set(entId, nextState);
        if (cycleCmd?.id) {
          entityStatesRef.current.set(cycleCmd.id.toLowerCase(), nextState);
          entityStatesRef.current.set(cycleCmd.id, nextState);
        }
        if (isMountedRef.current) {
          setEntityStates(new Map(entityStatesRef.current));
        }

        showToast(
          `Cycle ${entId}: ${curState} ➔ ${nextState} (${dir}${dir === 'ping_pong' ? ' bounce' : `, wrap=${act.wrap !== false}`})`,
          'success',
          4000
        );
        return { ok: true };
      }

      // Flow 7: Resolve Command & Option Details from Catalog if available
      const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForAction(act, catalog) : { command: undefined, matchedOption: undefined };

      // Never fall back to state_can_id for TX frames
      const rawTargetCanId = act.can_id || catalogCmd?.network?.action_can_id || catalogCmd?.action_can_id;
      const targetCanId =
        rawTargetCanId && normalizeCanId(rawTargetCanId) !== '0x0' && normalizeCanId(rawTargetCanId) !== '0x000'
          ? rawTargetCanId
          : undefined;
      const targetEntityId = act.entity_id || act.source_command_id || catalogCmd?.id;
      const rawActPayload =
        (typeof act.payload === 'object' && act.payload && Object.keys(act.payload).length > 0
          ? act.payload
          : typeof act.payload === 'string' && act.payload.trim() !== ''
          ? act.payload
          : undefined);
      const targetCommand =
        act.command ||
        act.option_label ||
        matchedOption?.label ||
        (!rawActPayload && catalogCmd?.options && catalogCmd.options[0]?.label) ||
        undefined;
      const rawPayload = rawActPayload || matchedOption?.payload || (matchedOption?.steps && matchedOption.steps[0]?.payload) || catalogCmd?.payload;
      const cleanPayloadStr = formatPayloadForApi(rawPayload);
      const targetRepeat = act.repeat || matchedOption?.repeat || (matchedOption?.steps && matchedOption.steps[0]?.repeat) || 1;
      const targetDelay = act.delay_ms || (matchedOption?.steps && matchedOption.steps[0]?.delay_ms) || catalogCmd?.network?.delay_ms || catalogCmd?.delay_ms || 20;
      const targetBus = act.bus ?? catalogCmd?.network?.bus ?? catalogCmd?.action_bus ?? 0;
      const normBus = typeof targetBus === 'string' && !isNaN(Number(targetBus)) ? Number(targetBus) : targetBus;
      const targetSteps = act.steps && act.steps.length > 0 ? act.steps : matchedOption?.steps;

      // Special Flow 8: Battery Preconditioning
      if (act.type === 'precondition' || targetEntityId === 'battery_preconditioning' || targetEntityId === 'precondition') {
        const preconMode = act.precon_mode || (matchedOption as any)?.precon_mode || 'persistent';
        const preconAction = act.precon_action || (preconMode === 'cancel' || preconMode === 'off' ? 'stop' : 'start');
        
        const preconSteps = targetSteps || (preconAction === 'stop' ? [{ payload: '00 00 00 00 00 00 00 00', repeat: 3 }] : [
          { payload: { D4: '0x40', D5: '0x03' }, repeat: 3 },
          { payload: { D4: '0xE0', D5: '0x07' }, repeat: 3 }
        ]);

        let sent = false;
        try {
          const res = await fetch(`${base}/api/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              entity: 'battery_preconditioning',
              command: targetCommand || preconMode,
              mode: preconMode,
              action: preconAction,
              can_id: targetCanId || '0x0C7',
              ...(cleanPayloadStr ? { payload: cleanPayloadStr } : {}),
              repeat: 3
            })
          });
          if (res.ok) sent = true;
        } catch {}

        if (!sent && preconSteps.length > 0) {
          for (let sIdx = 0; sIdx < preconSteps.length; sIdx++) {
            const s = preconSteps[sIdx];
            const sStr = formatPayloadForApi(s.payload);
            if (!sStr) {
              throw new Error(`Preconditioning step #${sIdx + 1} has no valid CAN payload`);
            }
            const stepRes = await fetch(`${base}/api/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                can_id: targetCanId || '0x0C7',
                payload: sStr,
                repeat: s.repeat || 3,
                delay_ms: 25,
                bus: normBus
              })
            });
            if (!stepRes.ok) {
              const errBody = (await stepRes.text().catch(() => '')).trim();
              throw new Error(`HTTP ${stepRes.status}: ${errBody || stepRes.statusText}`);
            }
            if (sIdx < preconSteps.length - 1) {
              await new Promise(r => setTimeout(r, 25));
            }
          }
        }

        showToast(
          `Action tested: Triggered Battery Preconditioning (${preconMode} - ${preconAction})`,
          'success',
          4000
        );
        return { ok: true };
      }

      // Special Flow 9: Climate Target
      if (act.type === 'climate_target' || targetEntityId === 'remote_climate') {
        const targetTemp = act.target_temp_c ?? 22.0;
        const targetZone = act.zone || 'driver';
        const res = await fetch(`${base}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity: 'remote_climate',
            command: JSON.stringify({ action: 'start', temp: targetTemp, zone: targetZone, sync: act.sync_on !== false }),
            can_id: targetCanId || '0x4A0',
            ...(cleanPayloadStr ? { payload: cleanPayloadStr } : {}),
            repeat: targetRepeat,
            delay_ms: targetDelay,
            bus: normBus
          })
        });
        if (!res.ok) {
          const errBody = (await res.text().catch(() => '')).trim();
          throw new Error(`HTTP ${res.status}: ${errBody || res.statusText}`);
        }
        showToast(
          `Action tested: Set Climate Target ${targetTemp}°C (${targetZone})`,
          'success',
          4000
        );
        return { ok: true };
      }

      // Special Flow 9.5: Ambient Mood Lighting (executes hardware-timed 2-stage burst on 0x4AD)
      if (targetEntityId === 'ambient_light_colors' || targetEntityId === 'ambient_mood_lighting' || (targetCanId && targetCanId.toUpperCase() === '0X4AD')) {
        let dispatchedViaEntity = false;
        if (targetCommand) {
          try {
            const res = await fetch(`${base}/api/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entity: targetEntityId || 'ambient_light_colors',
                command: targetCommand
              })
            });
            if (res.ok) {
              dispatchedViaEntity = true;
            }
          } catch {}
        }

        if (dispatchedViaEntity) {
          showToast(
            `Action tested: Ambient Mood Lighting ➔ ${targetCommand} (0x4AD)`,
            'success',
            4000
          );
          return { ok: true };
        }
      }

      // Flow 10 (prioritized): Entity Command Dispatch — try before raw-frame TX whenever an entity command is available
      if (targetEntityId && targetCommand) {
        const res = await fetch(`${base}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity: targetEntityId,
            command: targetCommand
          })
        });

        if (res.ok) {
          showToast(
            `Dispatched command to ${targetEntityId}: ${targetCommand}`,
            'success',
            4000
          );
          return { ok: true };
        }

        const hasRawFallback = Boolean(
          (targetSteps && targetSteps.length > 1) || (targetCanId && cleanPayloadStr)
        );
        if (res.status !== 404 || !hasRawFallback) {
          const errBody = (await res.text().catch(() => '')).trim();
          throw new Error(`HTTP ${res.status}: ${errBody || res.statusText || 'Command failed'}`);
        }
      }

      // Flow 11: Multi-Step Action Execution (e.g. ambient lighting burst + latch commit, seat comfort 2-stage)
      if (targetSteps && targetSteps.length > 1) {
        for (let sIdx = 0; sIdx < targetSteps.length; sIdx++) {
          const stepItem = targetSteps[sIdx];
          if ((stepItem as any).type === 'delay') {
            const waitMs = (stepItem as any).delay_ms || (stepItem as any).ms || 0;
            if (waitMs > 0) {
              await new Promise(r => setTimeout(r, Math.min(waitMs, 2000)));
            }
            continue;
          }
          const stepPayloadMap = compileToByteMap(stepItem.payload);
          const resolvedStepPayload =
            Object.keys(stepPayloadMap).length > 0
              ? stepPayloadMap
              : matchedOption?.steps?.[sIdx]?.payload || stepItem.payload;
          const sStr = formatPayloadForApi(resolvedStepPayload);
          const sRepeat = stepItem.repeat || targetRepeat;
          const sDelay = stepItem.delay_ms || targetDelay;
          const sCid = stepItem.can_id || targetCanId;
          const sBus = stepItem.bus ?? normBus;
          if (!sCid || !sStr) {
            throw new Error(`Step #${sIdx + 1} is missing a valid CAN ID or payload`);
          }
          const stepRes = await fetch(`${base}/api/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              can_id: sCid,
              payload: sStr,
              repeat: sRepeat,
              delay_ms: sDelay,
              bus: sBus
            })
          });
          if (!stepRes.ok) {
            const errBody = (await stepRes.text().catch(() => '')).trim();
            throw new Error(`HTTP ${stepRes.status}: ${errBody || stepRes.statusText}`);
          }
          if (sIdx < targetSteps.length - 1 && sDelay > 0) {
            await new Promise(r => setTimeout(r, Math.min(sDelay, 2000)));
          }
        }
        showToast(
          `Action tested: Transmitted sequence (${targetSteps.length} steps) on ${targetCanId || 'CAN'}${targetCommand ? ` (${targetCommand})` : ''}`,
          'success',
          4000
        );
        return { ok: true };
      }

      // Flow 12: Direct CAN Frame Dispatch (for commands with explicit TX CAN ID & non-empty payload)
      if (targetCanId && cleanPayloadStr) {
        const res = await fetch(`${base}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            can_id: targetCanId,
            payload: cleanPayloadStr,
            repeat: targetRepeat,
            delay_ms: targetDelay,
            bus: normBus
          })
        });

        if (!res.ok) {
          const errBody = (await res.text().catch(() => '')).trim();
          throw new Error(`HTTP ${res.status}: ${errBody || res.statusText}`);
        }

        const labelText = targetCommand ? ` (${targetCommand})` : '';
        showToast(
          `Action tested: Transmitted CAN ${targetCanId} [${cleanPayloadStr}]${labelText}`,
          'success',
          4000
        );
        return { ok: true };
      }

      // Guard unresolved CAN/entity actions instead of simulating or transmitting zeros
      if (act.type === 'can_tx' || act.type === 'entity_command') {
        const errMsg = !targetCanId
          ? `Cannot test action "${targetEntityId || act.type}": no TX CAN ID or firmware entity command available.`
          : `Cannot test CAN action ${targetCanId}: payload is empty or unresolved.`;
        showToast(errMsg, 'error', 5000);
        return { ok: false, error: errMsg };
      }

      // Fallback
      showToast(`Simulated action test for: ${act.type || targetEntityId || 'unknown'}`, 'info', 4000);
      return { ok: true };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      showToast(`Action test failed: ${errMsg}`, 'error', 5000);
      return { ok: false, error: errMsg };
    }
  };

  const activeRule = rules.find(r => r.id === selectedRuleId) || rules[0];
  const activeRuleId = activeRule?.id;

  const handleUpdateActiveRule = useCallback(
    (updated: Partial<AutomationRule> | ((rule: AutomationRule) => AutomationRule)) => {
      if (!activeRuleId) return;
      onUpdateRules(prev =>
        prev.map(r => {
          if (r.id !== activeRuleId) return r;
          return typeof updated === 'function' ? updated(r) : { ...r, ...updated };
        })
      );
    },
    [activeRuleId, onUpdateRules]
  );

  const handleUpdateRule = useCallback(
    (ruleId: string, updated: Partial<AutomationRule> | ((rule: AutomationRule) => AutomationRule)) => {
      onUpdateRules(prev =>
        prev.map(r => {
          if (r.id !== ruleId) return r;
          return typeof updated === 'function' ? updated(r) : { ...r, ...updated };
        })
      );
    },
    [onUpdateRules]
  );

  const handleRunAllRuleActions = async (targetRule: AutomationRule) => {
    const acts = targetRule.actions || [];
    if (acts.length === 0) {
      showToast(`Rule "${targetRule.name}" has no actions configured.`, 'info', 3000);
      return;
    }
    showToast(`Executing ${acts.length} action(s) for "${targetRule.name}"...`, 'info');
    try {
      const compiledActions = compileActionList(acts, catalog);
      const base = resolveDeviceBaseUrl(espIpRef.current);
      let handledByDevice = false;
      let deviceError: string | null = null;
      try {
        const res = await fetch(`${base}/api/automations/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: targetRule.id,
            mode: 'live_fire',
            actions: compiledActions
          })
        });
        if (res.ok) {
          handledByDevice = true;
        } else if (res.status !== 404) {
          const errBody = (await res.text().catch(() => '')).trim();
          deviceError = `HTTP ${res.status}: ${errBody || res.statusText}`;
        }
      } catch {
        // Offline / preview sandbox fallback
      }

      if (deviceError) {
        showToast(
          `Failed to execute "${targetRule.name}" on ESP32: ${deviceError}`,
          'error',
          5000
        );
        return;
      }

      if (!handledByDevice) {
        for (let i = 0; i < acts.length; i++) {
          const result = await handleTestSingleAction(acts[i]);
          if (!result.ok) {
            showToast(
              `Action #${i + 1} of "${targetRule.name}" failed: ${result.error || 'Unknown error'}`,
              'error',
              5000
            );
            return;
          }
        }
      }

      recordRuleFired(targetRule.id);
      showToast(
        handledByDevice
          ? `ESP32 executed "${targetRule.name}" actions!`
          : `Executed actions for "${targetRule.name}" locally!`,
        'success',
        4000
      );
    } catch (err: any) {
      showToast(`Error running actions: ${err?.message || err}`, 'error', 4000);
    }
  };

  const queryHardwareDryRun = async (targetRule: AutomationRule): Promise<{ passed: boolean; message: string } | null> => {
    try {
      const base = resolveDeviceBaseUrl(espIpRef.current);
      const res = await fetch(`${base}/api/automations/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: targetRule.id, mode: 'dry_run' }),
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        return {
          passed: Boolean(data.passed),
          message: data.message || (data.passed ? 'PASSED (Rule armed on ESP32)' : 'FAILED / INACTIVE on ESP32')
        };
      }
      if (res.status === 404) {
        return {
          passed: false,
          message: 'Rule not found on ESP32 (not pushed yet — push automations first).'
        };
      }
      const errBody = (await res.text().catch(() => '')).trim();
      return {
        passed: false,
        message: `ESP32 returned HTTP ${res.status}: ${errBody || res.statusText || 'Dry-run check failed'}`
      };
    } catch {
      // Offline / unreachable
    }
    return null;
  };

  const handleSimulateRule = (targetRule?: AutomationRule) => {
    const target = targetRule || activeRule;
    if (!target) return;
    if (targetRule) {
      setSelectedRuleId(targetRule.id);
    }
    setShowSimulateModal(true);
  };

  const handleAddRule = () => {
    const newId = `rule_${Date.now().toString(36)}`;
    onUpdateRules(prev => [...prev, createEmptyRule(prev.length + 1, newId)]);
    setSelectedRuleId(newId);
  };

  const handleDuplicateRule = (ruleToDup: AutomationRule) => {
    const duplicated = ensureRuleTriggerClientIds(cloneRuleWithNewIds(ruleToDup));
    onUpdateRules(prev => [...prev, duplicated]);
    setSelectedRuleId(duplicated.id);
  };

  const handleDeleteRule = (ruleId: string) => {
    const fallbackId = `rule_${Date.now().toString(36)}`;
    let nextSelectedId: string | null = null;
    onUpdateRules(prev => {
      const remaining = prev.filter(r => r.id !== ruleId);
      if (remaining.length === 0) {
        nextSelectedId = fallbackId;
        return [createEmptyRule(1, fallbackId)];
      }
      if (selectedRuleId === ruleId) {
        nextSelectedId = remaining[0].id;
      }
      return remaining;
    });
    if (nextSelectedId) {
      setSelectedRuleId(nextSelectedId);
    }
  };

  const handleToggleCheckForDelete = (ruleId: string) => {
    setSelectedRuleIdsForDelete(prev => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  };

  const handleBatchDelete = () => {
    if (selectedRuleIdsForDelete.size === 0) return;
    const idsToDelete = new Set(selectedRuleIdsForDelete);
    const fallbackId = `rule_${Date.now().toString(36)}`;
    let nextSelectedId: string | null = null;
    onUpdateRules(prev => {
      const remaining = prev.filter(r => !idsToDelete.has(r.id));
      if (remaining.length === 0) {
        nextSelectedId = fallbackId;
        return [createEmptyRule(1, fallbackId)];
      }
      if (idsToDelete.has(selectedRuleId)) {
        nextSelectedId = remaining[0].id;
      }
      return remaining;
    });
    if (nextSelectedId) {
      setSelectedRuleId(nextSelectedId);
    }
    setSelectedRuleIdsForDelete(new Set());
    setIsSelectMode(false);
    setShowBulkCategoryInput(false);
  };

  const handleBatchEnable = (enabled: boolean) => {
    if (selectedRuleIdsForDelete.size === 0) return;
    const idsToUpdate = new Set(selectedRuleIdsForDelete);
    onUpdateRules(prev =>
      prev.map(r => (idsToUpdate.has(r.id) ? { ...r, enabled } : r))
    );
  };

  const handleBatchAssignCategory = () => {
    if (selectedRuleIdsForDelete.size === 0) return;
    const idsToUpdate = new Set(selectedRuleIdsForDelete);
    const trimmed = bulkCategoryValue.trim();
    onUpdateRules(prev =>
      prev.map(r => (idsToUpdate.has(r.id) ? { ...r, category: trimmed } : r))
    );
    setShowBulkCategoryInput(false);
    setBulkCategoryValue('');
  };

  const handleBatchExportSelected = () => {
    if (selectedRuleIdsForDelete.size === 0) return;
    const selected = rules.filter(r => selectedRuleIdsForDelete.has(r.id));
    if (selected.length === 0) return;
    const jsonStr = exportToCandoJson(selected, settings, catalog);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `automations-selected-${selected.length}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    const content = exportToCandoJson(rules, settings, catalog);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'automations.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const buildAndCheckPushPayload = (): { payload: string; bytes: number } | null => {
    const payload = exportToCandoJson(rules, settings, catalog, null, { minify: true });
    const bytes = getPayloadByteLength(payload);
    if (bytes > MAX_AUTOMATIONS_PAYLOAD_BYTES) {
      const kb = (bytes / 1024).toFixed(1);
      showSyncStatus(
        `Push blocked: automations.json is ${kb} KB (${bytes.toLocaleString()} bytes), exceeding the 128 KB (${MAX_AUTOMATIONS_PAYLOAD_BYTES.toLocaleString()} byte) ESP32 limit.`
      );
      return null;
    }
    return { payload, bytes };
  };

  const commitPulledAutomations = (
    decompiled: AutomationRule[],
    pulledSettings: AutomationSettings | undefined,
    sourceLabel: string
  ) => {
    const hydrated = ensureRulesTriggerClientIds(decompiled);
    markRulesAsSynced(serializeRulesForDirtyCheck(hydrated));
    onUpdateRules(hydrated);
    if (pulledSettings) onUpdateSettings(pulledSettings);
    if (hydrated[0]?.id) setSelectedRuleId(hydrated[0].id);
    showSyncStatus(`Imported ${hydrated.length} rule(s)${sourceLabel}!`, 6000);
  };

  const applyPulledAutomations = (data: any, sourceLabel: string) => {
    let rawRules: any[] | null = null;
    let pulledSettings: AutomationSettings | undefined;
    if (data && data.rules && Array.isArray(data.rules)) {
      rawRules = data.rules;
      if (data.settings) pulledSettings = data.settings;
    } else if (Array.isArray(data)) {
      rawRules = data;
    }

    if (!rawRules) {
      showSyncStatus('No rules array found in device response.', 6000);
      return;
    }

    const decompiled = ensureRulesTriggerClientIds(decompileAutomationRules(rawRules, catalog));
    const localRules = latestRulesRef.current;
    const currentHasUnpushed = lastPushedJsonRef.current !== serializeRulesForDirtyCheck(localRules);
    const isEmptyDeviceOverwrite = decompiled.length === 0 && localRules.length > 0;

    if (currentHasUnpushed || isEmptyDeviceOverwrite) {
      setPendingPullConfirmation({
        rules: decompiled,
        settings: pulledSettings,
        sourceLabel,
        hasUnpushedChanges: currentHasUnpushed,
        isEmptyDeviceOverwrite
      });
      showSyncStatus(
        isEmptyDeviceOverwrite
          ? 'Pull paused: device returned 0 rules — confirm overwrite.'
          : 'Pull paused: unpushed local edits — confirm overwrite.'
      );
      return;
    }

    commitPulledAutomations(decompiled, pulledSettings, sourceLabel);
  };

  const withMqttClient = (
    cfg: MqttRemoteConfig,
    options: { connectingMessage: string; timeoutMessage: string; timeoutMs?: number },
    fn: (ctx: MqttSessionContext) => void
  ) => {
    showSyncStatus(options.connectingMessage);
    try {
      const { wsUrl, deviceId, user, pass } = cfg;
      if (!wsUrl || !deviceId) throw new Error('Broker URL and Device ID required');

      const client = mqtt.connect(wsUrl, {
        username: user || undefined,
        password: pass || undefined,
        connectTimeout: 5000
      });
      activeMqttClientsRef.current.add(client);

      let settled = false;
      const timeoutTimer = setTimeout(() => {
        finish(options.timeoutMessage);
      }, options.timeoutMs ?? 15000);
      mqttTimeoutTimersRef.current.add(timeoutTimer);

      const finish = (statusMsg?: string, clearAfterMs?: number, onSettled?: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        mqttTimeoutTimersRef.current.delete(timeoutTimer);
        activeMqttClientsRef.current.delete(client);
        try {
          client.end(true);
        } catch {}
        if (isMountedRef.current) {
          if (statusMsg !== undefined) {
            showSyncStatus(statusMsg, clearAfterMs);
          }
          if (onSettled) onSettled();
          setSyncing(false);
        }
      };

      client.on('error', (err) => {
        finish(`MQTT Connection Error: ${err.message}`);
      });

      fn({
        client,
        deviceId,
        isSettled: () => settled || !isMountedRef.current,
        finish
      });
    } catch (err: any) {
      showSyncStatus(`MQTT Init Error: ${err.message}`);
      if (isMountedRef.current) setSyncing(false);
    }
  };

  const executePushToEsp = async () => {
    const built = buildAndCheckPushPayload();
    if (!built) return;
    const { payload } = built;
    const rulesSnapshotJson = serializeRulesForDirtyCheck(latestRulesRef.current);

    setSyncing(true);

    if (useMqttSync) {
      withMqttClient(
        mqttRemoteConfig,
        {
          connectingMessage: 'Connecting to MQTT Broker...',
          timeoutMessage: 'MQTT push timed out waiting for ESP32 acknowledgment.'
        },
        ({ client, deviceId, isSettled, finish }) => {
          const statusTopic = `cando/${deviceId}/config/automations/status`;
          const setTopic = `cando/${deviceId}/config/automations/set`;

          client.once('connect', () => {
            if (isSettled()) return;
            showSyncStatus('Subscribing to ESP32 push status...');
            client.subscribe(statusTopic, (subErr) => {
              if (isSettled()) return;
              if (subErr) {
                finish(`MQTT subscribe failed: ${subErr.message}`);
                return;
              }
              showSyncStatus('Publishing automations to device topic...');
              client.publish(setTopic, payload, { qos: 1 }, (pubErr) => {
                if (isSettled()) return;
                if (pubErr) {
                  finish(`Publish failed: ${pubErr.message}`);
                  return;
                }
                showSyncStatus('Waiting for ESP32 confirmation...');
              });
            });
          });

          client.on('message', (topic, message, packet) => {
            if (isSettled() || topic !== statusTopic) return;
            if (packet?.retain) return;
            const rawText = message.toString().trim();
            try {
              const ack = JSON.parse(rawText);
              if (ack?.status === 'ok' || ack?.status === 'success') {
                markRulesAsSynced(rulesSnapshotJson);
                finish(`Success: ${ack.message || 'Automations saved and hot-reloaded via MQTT!'}`, 6000);
              } else {
                finish(`MQTT push rejected by ESP32: ${ack?.message || rawText || 'Unknown error'}`);
              }
            } catch {
              if (rawText.toLowerCase() === 'ok') {
                markRulesAsSynced(rulesSnapshotJson);
                finish('Success: Automations saved and hot-reloaded via MQTT!', 6000);
              } else {
                finish(`MQTT push error from ESP32: ${rawText || 'Malformed status reply'}`);
              }
            }
          });
        }
      );
      return;
    }

    const activeHost = commitEspIp();
    showSyncStatus('Pushing automations.json to ESP32...');

    try {
      const base = resolveDeviceBaseUrl(activeHost);
      const url = `${base}/api/automations`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        const msg = (await res.text().catch(() => '')).trim();
        if (res.status === 413) {
          throw new Error(`Payload too large (HTTP 413): ${msg || 'Exceeds 128 KB ESP32 limit.'}`);
        }
        if (res.status === 408) {
          throw new Error(`Upload timed out (HTTP 408): ${msg || 'ESP32 timed out receiving payload.'}`);
        }
        throw new Error(`HTTP ${res.status}: ${msg || res.statusText || 'Request failed'}`);
      }
      const data = await res.json().catch(() => ({}));
      markRulesAsSynced(rulesSnapshotJson);
      showSyncStatus(`Success: ${data?.message || 'Automations saved and hot-reloaded.'}`, 6000);
    } catch (err: any) {
      const displayMsg =
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? 'Request timed out after 10s (ESP32 did not respond).'
          : err?.message || String(err);
      showSyncStatus(`Push failed: ${displayMsg}`);
    } finally {
      if (isMountedRef.current) setSyncing(false);
    }
  };

  const handlePushToEsp = () => {
    if (!buildAndCheckPushPayload()) {
      return;
    }
    const report = validateAutomationRules(rules, catalog);
    if (report.errors.length > 0 || report.warnings.length > 0) {
      setPrePushReport(report);
      return;
    }
    void executePushToEsp();
  };

  const handlePullFromEsp = async () => {
    setSyncing(true);

    if (useMqttSync) {
      withMqttClient(
        mqttRemoteConfig,
        {
          connectingMessage: 'Connecting to MQTT broker for pull...',
          timeoutMessage: 'MQTT pull timed out (no live response from device).'
        },
        ({ client, deviceId, isSettled, finish }) => {
          const stateTopic = `cando/${deviceId}/config/automations/state`;
          const getTopic = `cando/${deviceId}/config/automations/get`;

          client.once('connect', () => {
            if (isSettled()) return;
            showSyncStatus('Requesting automations from device...');
            client.subscribe(stateTopic, (err) => {
              if (isSettled()) return;
              if (!err) {
                client.publish(getTopic, '', { qos: 1 });
              } else {
                finish(`Subscribe Error: ${err.message}`);
              }
            });
          });

          client.on('message', (topic, message, packet) => {
            if (isSettled() || topic !== stateTopic) return;
            // Ignore stale retained broker state; wait for live reply to config/automations/get
            if (packet?.retain) return;
            finish(undefined, undefined, () => {
              try {
                const data = JSON.parse(message.toString());
                applyPulledAutomations(data, ' via MQTT');
              } catch (e: any) {
                showSyncStatus(`Pull failed: ${e.message}`, 6000);
              }
            });
          });
        }
      );
      return;
    }

    const activeHost = commitEspIp();
    showSyncStatus('Pulling automations.json from ESP32...');

    try {
      const base = resolveDeviceBaseUrl(activeHost);
      const url = `${base}/api/automations`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        const msg = (await res.text().catch(() => '')).trim();
        throw new Error(`HTTP ${res.status}: ${msg || res.statusText || 'Request failed'}`);
      }
      const data = await res.json();
      if (isMountedRef.current) {
        applyPulledAutomations(data, '');
      }
    } catch (err: any) {
      const displayMsg =
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? 'Request timed out after 10s (ESP32 did not respond).'
          : err?.message || String(err);
      showSyncStatus(`Pull failed: ${displayMsg}`);
    } finally {
      if (isMountedRef.current) setSyncing(false);
    }
  };

  const handleApplyImport = (
    importedRules: AutomationRule[],
    importedSettings?: AutomationSettings
  ) => {
    const hydrated = ensureRulesTriggerClientIds(importedRules);
    onUpdateRules(hydrated);
    if (importedSettings) {
      onUpdateSettings({ ...settings, ...importedSettings });
    }
    if (hydrated.length > 0 && hydrated[0]?.id) {
      setSelectedRuleId(hydrated[0].id);
    }
  };

  const openAddTriggerDialog = (onAdd: (t: AutomationTrigger) => void) => {
    setAddElementTarget({
      type: 'trigger',
      title: 'Add Trigger (When...)',
      contextHint: 'Select an event, gesture, sensor transition, or schedule to trigger this automation.',
      onAdd: (item) => onAdd(item as AutomationTrigger)
    });
  };

  const openAddConditionDialog = (onAdd: (c: AutomationCondition) => void) => {
    setAddElementTarget({
      type: 'condition',
      title: 'Add Condition (And If...)',
      contextHint: 'Select states, logical gates (AND/OR/NOT), or time windows required for the rule to proceed.',
      onAdd: (item) => onAdd(item as AutomationCondition)
    });
  };

  const openAddActionDialog = (onAdd: (a: AutomationAction) => void) => {
    setAddElementTarget({
      type: 'action',
      title: 'Add Action (Then Do...)',
      contextHint: 'Select vehicle actuators, cluster popups, delays, or branching logic (IF/CHOOSE) to execute.',
      onAdd: (item) => onAdd(item as AutomationAction)
    });
  };

  return (
    <AutomationClipboardContext.Provider value={{ clipboard, copyToClipboard, clearClipboard, pastePayload, pasteFromClipboard }}>
      <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-4 sm:space-y-6 min-w-0">
      {/* Main Builder Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-w-0">
        {/* Left Column: Active Rule Editor (8 cols = ~2/3 of area on desktop) */}
        {activeRule ? (
          <div className="order-2 lg:order-1 lg:col-span-8 space-y-4 min-w-0">
            {/* Active Rule Action Strip & Properties */}
            <div className="p-2.5 sm:p-3.5 rounded-xl bg-surface border border-border shadow-sm space-y-3 min-w-0">
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      activeRule.enabled ? 'bg-success' : 'bg-muted/40'
                    }`}
                  />
                  <input
                    type="text"
                    value={activeRule.name}
                    onChange={e => handleUpdateActiveRule({ name: e.target.value })}
                    placeholder="Automation Name"
                    className="bg-transparent text-sm font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-focus rounded px-1.5 py-0.5 w-full min-w-0 truncate"
                  />
                  {activeRule.category ? (
                    <button
                      type="button"
                      onClick={() => setEditingCategoryRule(activeRule)}
                      className="hidden sm:inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-accent-soft text-accent-soft-foreground border border-accent/30 hover:opacity-90 transition flex-shrink-0"
                      title="Edit category"
                    >
                      <Tag className="w-2.5 h-2.5" />
                      <span>{activeRule.category}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingCategoryRule(activeRule)}
                      className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] text-muted hover:text-accent hover:bg-default-hover transition flex-shrink-0"
                      title="Add category"
                    >
                      <Tag className="w-2.5 h-2.5" />
                      <span>+ Category</span>
                    </button>
                  )}
                </div>

                {/* Right side: Emulate the screenshot with HaToggleSwitch + 3-dots Dropdown Menu */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <HaToggleSwitch
                    checked={activeRule.enabled}
                    onChange={(enabled) => handleUpdateActiveRule({ enabled })}
                    ariaLabel="Toggle automation enabled state"
                  />

                  <AutomationActionMenu
                    rule={activeRule}
                    buttonSize="md"
                    align="right"
                    onToggleEnabled={(enabled) => handleUpdateActiveRule({ enabled })}
                    onDuplicate={() => handleDuplicateRule(activeRule)}
                    onDelete={() => handleDeleteRule(activeRule.id)}
                    onRunActions={() => handleRunAllRuleActions(activeRule)}
                    onShowTraces={() => handleSimulateRule(activeRule)}
                    onMoreInfo={() => setMoreInfoRule(activeRule)}
                    onEditSettings={() => setEditingSettingsRule(activeRule)}
                    onEditCategory={() => setEditingCategoryRule(activeRule)}
                  />
                </div>
              </div>

              {/* Automation Properties Bar */}
              <div className="pt-3 border-t border-separator grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[10px] font-medium text-muted">Cooldown</label>
                    <span className="text-[10px] text-accent font-mono">
                      {activeRule.cooldown_ms || 0}ms
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Slider
                      minValue={0}
                      maxValue={5000}
                      step={100}
                      value={activeRule.cooldown_ms || 0}
                      onChange={val => {
                        const num = typeof val === 'number' ? val : val[0];
                        handleUpdateActiveRule({ cooldown_ms: num });
                      }}
                      aria-label="Cooldown in milliseconds"
                      className="flex-1"
                    >
                      <Slider.Track className="h-1.5 bg-surface-tertiary rounded-full cursor-pointer relative">
                        <Slider.Fill className="bg-accent rounded-full h-full" />
                        <Slider.Thumb className="w-3.5 h-3.5 bg-accent border-2 border-surface rounded-full shadow cursor-grab active:cursor-grabbing focus:outline-none" />
                      </Slider.Track>
                    </Slider>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={activeRule.cooldown_ms !== undefined ? activeRule.cooldown_ms : 0}
                      onChange={e => handleUpdateActiveRule({ cooldown_ms: parseInt(e.target.value) || 0 })}
                      placeholder="0"
                      className="w-16 bg-surface-secondary border border-border rounded px-1.5 py-0.5 text-foreground font-mono text-xs focus:outline-none focus:border-focus text-right"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-medium text-muted mb-1">Home Assistant Icon</label>
                  <input
                    type="text"
                    value={activeRule.ha_icon || ''}
                    onChange={e => handleUpdateActiveRule({ ha_icon: e.target.value })}
                    placeholder="mdi:car-cog"
                    className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground text-xs focus:outline-none focus:border-focus"
                  />
                </div>

                <div className="flex flex-col justify-end gap-1.5">
                  <Switch
                    isSelected={activeRule.ha_expose ?? true}
                    onChange={(isSelected) => handleUpdateActiveRule({ ha_expose: isSelected })}
                    size="sm"
                    aria-label="Expose to Home Assistant"
                    className="p-1.5 rounded-lg bg-surface-secondary border border-border hover:border-border-secondary transition"
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <span className="text-[11px] font-medium text-foreground">Expose to HA</span>
                    </Switch.Content>
                  </Switch>
                  {(activeRule.hold_beep || activeRule.triggers?.some(t => t.type === 'ble_button' || t.type === 'ble_key' || (t.source === 'ble' && t.ble_button))) && (
                    <Switch
                      isSelected={activeRule.hold_beep ?? false}
                      onChange={(isSelected) => handleUpdateActiveRule({ hold_beep: isSelected })}
                      size="sm"
                      aria-label="Beep on 1-second Bluetooth hold ticks"
                      className="p-1.5 rounded-lg bg-surface-secondary border border-border hover:border-border-secondary transition"
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-[11px] font-medium text-foreground">Hold Beep (1/s)</span>
                      </Switch.Content>
                    </Switch>
                  )}
                </div>
              </div>
            </div>

            {/* SECTION 1: TRIGGERS */}
            <div className="can-do-section-box trig-section space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCollapsedTriggers(!collapsedTriggers)}
                    className="text-muted hover:text-foreground transition p-0.5"
                    title={collapsedTriggers ? "Expand triggers" : "Collapse triggers"}
                  >
                    {collapsedTriggers ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <span className="p-1 rounded-lg bg-warning-soft text-warning">
                    <Zap className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                    Triggers
                  </span>

                  </div>
              </div>

              {!collapsedTriggers && (
                <>
                  {activeRule.triggers.length === 0 ? (
                    <div className="p-3 rounded-xl bg-surface-secondary border border-dashed border-border text-center text-xs text-muted italic">
                      No triggers defined. Automation will never fire.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {activeRule.triggers.map((trig, tIdx) => {
                        const stableKey = trig._clientId || trig.id || `trig_fallback_${tIdx}`;
                        return (
                          <TriggerNodeEditor
                            key={stableKey}
                            trig={trig}
                            tIdx={tIdx}
                            catalog={catalog}
                            liveWifiStatus={liveWifiStatus}
                            liveBleMap={liveBleMap}
                            onUpdate={updated => {
                              handleUpdateActiveRule(r => {
                                const next = [...r.triggers];
                                const existingClientId = updated._clientId || r.triggers[tIdx]?._clientId || createTriggerClientId(updated.id);
                                next[tIdx] = { ...updated, _clientId: existingClientId };
                                return { ...r, triggers: next };
                              });
                            }}
                            onDelete={() => {
                              handleUpdateActiveRule(r => ({
                                ...r,
                                triggers: r.triggers.filter((_, i) => i !== tIdx)
                              }));
                            }}
                            onDuplicate={() => {
                              handleUpdateActiveRule(r => {
                                const target = r.triggers[tIdx] || trig;
                                const dup = ensureTriggerClientId(regenerateTriggerIds(target));
                                const next = [...r.triggers];
                                next.splice(tIdx + 1, 0, dup);
                                return { ...r, triggers: next };
                              });
                            }}
                            onMoveUp={tIdx > 0 ? () => {
                              handleUpdateActiveRule(r => ({
                                ...r,
                                triggers: arrayMove(r.triggers, tIdx, tIdx - 1)
                              }));
                            } : undefined}
                            onMoveDown={tIdx < activeRule.triggers.length - 1 ? () => {
                              handleUpdateActiveRule(r => ({
                                ...r,
                                triggers: arrayMove(r.triggers, tIdx, tIdx + 1)
                              }));
                            } : undefined}
                            isFirst={tIdx === 0}
                            isLast={tIdx === activeRule.triggers.length - 1}
                            dragConfig={
                              activeRule.triggers.length > 1
                                ? {
                                    onDragStart: e => {
                                      e.stopPropagation();
                                      e.dataTransfer.effectAllowed = 'move';
                                      e.dataTransfer.setData('text/plain', `${triggerListId}:${tIdx}`);
                                      setActiveScopedDrag({ listId: triggerListId, index: tIdx });
                                      setTriggerDragIdx(tIdx);
                                    },
                                    onDragOver: e => {
                                      const active = getActiveScopedDrag();
                                      if (active?.listId !== triggerListId) return;
                                      e.preventDefault();
                                      e.stopPropagation();
                                      e.dataTransfer.dropEffect = 'move';
                                      if (triggerDragOverIdx !== tIdx) {
                                        setTriggerDragOverIdx(tIdx);
                                      }
                                    },
                                    onDrop: e => {
                                      const active = getActiveScopedDrag();
                                      if (active?.listId !== triggerListId) return;
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (active.index !== tIdx) {
                                        const fromIdx = active.index;
                                        handleUpdateActiveRule(r => ({
                                          ...r,
                                          triggers: arrayMove(r.triggers, fromIdx, tIdx)
                                        }));
                                      }
                                      setActiveScopedDrag(null);
                                      setTriggerDragIdx(null);
                                      setTriggerDragOverIdx(null);
                                    },
                                    onDragEnd: () => {
                                      setActiveScopedDrag(null);
                                      setTriggerDragIdx(null);
                                      setTriggerDragOverIdx(null);
                                    },
                                    isDragging: triggerDragIdx === tIdx,
                                    isDragOver: triggerDragOverIdx === tIdx && triggerDragIdx !== tIdx
                                  }
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap mt-2">
                    <button
                      type="button"
                      onClick={() =>
                        openAddTriggerDialog(newTrig =>
                          handleUpdateActiveRule(r => ({
                            ...r,
                            triggers: [...r.triggers, ensureTriggerClientId(newTrig)]
                          }))
                        )
                      }
                      className="ha-section-add-btn accent-trig"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add Trigger</span>
                    </button>

                    {clipboard?.type === 'trigger' && (
                      <button
                        type="button"
                        onClick={() => {
                          const targetRuleId = activeRule.id;
                          void (async () => {
                            const pasted = await pasteFromClipboard('trigger');
                            if (pasted) {
                              const ensured = ensureTriggerClientId(pasted);
                              handleUpdateRule(targetRuleId, r => ({
                                ...r,
                                triggers: [...r.triggers, ensured]
                              }));
                            }
                          })();
                        }}
                        className="ha-section-paste-btn bg-warning-soft hover:opacity-90 text-warning-soft-foreground border border-warning/40"
                        aria-label={`Paste copied trigger "${clipboard.label}"`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-warning" />
                        <span>Paste Trigger ({clipboard.label})</span>
                      </button>
                    )}

                    {clipboard?.type === 'condition' && (
                      <button
                        type="button"
                        onClick={() => {
                          const targetRuleId = activeRule.id;
                          void (async () => {
                            const pasted = await pasteFromClipboard('trigger');
                            if (pasted) {
                              const ensured = ensureTriggerClientId(pasted);
                              handleUpdateRule(targetRuleId, r => ({
                                ...r,
                                triggers: [...r.triggers, ensured]
                              }));
                            }
                          })();
                        }}
                        className="ha-section-paste-btn bg-accent-soft hover:opacity-90 text-accent-soft-foreground border border-accent/40"
                        aria-label={`Convert & paste copied condition "${clipboard.label}" as trigger`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-accent" />
                        <span>Paste as Trigger ({clipboard.label})</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Toast notification for single action tests */}
            {actionTestToast && (
              <div
                className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border text-xs font-medium shadow-overlay animate-in fade-in slide-in-from-top-2 duration-200 ${
                  actionTestToast.type === 'success'
                    ? 'bg-success-soft border-success/40 text-success-soft-foreground'
                    : actionTestToast.type === 'error'
                    ? 'bg-danger-soft border-danger/40 text-danger-soft-foreground'
                    : 'bg-accent-soft border-accent/40 text-accent-soft-foreground'
                }`}
              >
                <span>{actionTestToast.message}</span>
                <button
                  type="button"
                  onClick={clearToast}
                  className="p-1 hover:bg-default-hover rounded transition text-muted hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* SECTION 2: CONDITIONS */}
            <div className="can-do-section-box cond-section space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCollapsedConditions(!collapsedConditions)}
                    className="text-muted hover:text-foreground transition p-0.5"
                    title={collapsedConditions ? "Expand conditions" : "Collapse conditions"}
                  >
                    {collapsedConditions ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <span className="p-1 rounded-lg bg-accent-soft text-accent">
                    <Shield className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                    Conditions
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Real-time Overall Gate Status Badge */}
                  {(() => {
                    const conds = activeRule.conditions || [];
                    if (conds.length === 0) {
                      return (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-success-soft text-success-soft-foreground border border-success/30">
                          <Check className="w-3 h-3 text-success" />
                          <span>Gate Open (Unconditional)</span>
                        </span>
                      );
                    }
                    const gateEval = evaluateConditionState(
                      { id: 'gate_root', logic: 'and', conditions: conds },
                      undefined,
                      entityStates,
                      undefined,
                      catalog,
                      liveWifiStatus,
                      liveBleMap
                    );
                    if (gateEval.state === 'valid') {
                      return (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-success-soft text-success-soft-foreground border border-success/40 shadow-sm"
                          title="All conditions currently evaluate as TRUE based on live CAN bus/entity state"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                          <Check className="w-3 h-3 text-success" />
                          <span>Gate Open: Valid</span>
                        </span>
                      );
                    }
                    if (gateEval.state === 'invalid') {
                      return (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-danger-soft text-danger-soft-foreground border border-danger/40 shadow-sm"
                          title={gateEval.reason || "Conditions currently block execution"}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-danger" />
                          <X className="w-3 h-3 text-danger" />
                          <span>Gate Closed: Blocked</span>
                        </span>
                      );
                    }
                    return (
                      <span
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-surface-secondary text-muted border border-border"
                        title={gateEval.reason || "Waiting for live frame or state telemetry"}
                      >
                        <HelpCircle className="w-3 h-3 text-muted" />
                        <span>Gate State: Unknown</span>
                      </span>
                    );
                  })()}
                </div>
              </div>

              {!collapsedConditions && (
                <ConditionListEditor
                  conditions={activeRule.conditions}
                  depth={0}
                  availableTriggers={activeRule.triggers}
                  catalog={catalog}
                  entityStates={entityStates}
                  liveWifiStatus={liveWifiStatus}
                  liveBleMap={liveBleMap}
                  emptyText="No conditions set. Rule will always execute when triggers match."
                  onUpdate={conds => handleUpdateActiveRule({ conditions: conds })}
                  onOpenAddConditionDialog={openAddConditionDialog}
                />
              )}
            </div>

            {/* SECTION 3: ACTIONS */}
            <div className="can-do-section-box act-section space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCollapsedActions(!collapsedActions)}
                    className="text-muted hover:text-foreground transition p-0.5"
                    title={collapsedActions ? "Expand actions" : "Collapse actions"}
                  >
                    {collapsedActions ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <span className="p-1 rounded-lg bg-success-soft text-success">
                    <Send className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                    Actions
                  </span>
                </div>
              </div>

              {!collapsedActions && (
                <ActionListEditor
                  actions={activeRule.actions}
                  depth={0}
                  availableTriggers={activeRule.triggers}
                  catalog={catalog}
                  entityStates={entityStates}
                  liveWifiStatus={liveWifiStatus}
                  liveBleMap={liveBleMap}
                  emptyText="No actions defined."
                  onUpdate={acts => handleUpdateActiveRule({ actions: acts })}
                  onOpenAddConditionDialog={openAddConditionDialog}
                  onOpenAddActionDialog={openAddActionDialog}
                  onTestSingleAction={handleTestSingleAction}
                />
              )}
            </div>

          </div>
        ) : (
          <div className="order-2 lg:order-1 lg:col-span-8 flex items-center justify-center p-12 rounded-2xl bg-surface border border-border text-muted text-sm">
            Select or create an automation rule to start editing.
          </div>
        )}

        {/* Right Column: Automations List & JSON Inspector (contents on mobile, 4 cols sidebar on desktop) */}
        <div className="contents lg:block lg:order-2 lg:col-span-4 lg:space-y-4">
          {/* Card 1: Automations List (Appears at top on single-column mobile) */}
          <div className="order-1 lg:order-none p-4 rounded-2xl bg-surface border border-border shadow-sm space-y-3">
            {!isSelectMode ? (
              <div className="space-y-2.5">
                {/* Header Top Row: Title + Primary Action */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted">
                    Automations ({rules.length})
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    onPress={handleAddRule}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-accent-soft text-accent-soft-foreground hover:bg-accent hover:text-accent-foreground border border-accent/40 transition shadow-sm shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>New Rule</span>
                  </Button>
                </div>

                {/* Secondary Action Toolbar: Community, Dry Run, Select, Import, Export (Left-justified) */}
                <div className="flex flex-wrap items-center justify-start gap-1.5 pt-2.5 border-t border-separator">
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => { setCommunityModalTab('browse'); setShowCommunityModal(true); }}
                    aria-label="Explore Community Automations"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-warning-soft text-warning-soft-foreground hover:opacity-90 border border-warning/40 transition shadow-sm"
                  >
                    <Sparkles className="w-3 h-3 text-warning" />
                    <span>Community</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => handleSimulateRule()}
                    aria-label="Dry run active rule simulation"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-surface-secondary hover:bg-default-hover text-accent border border-border transition"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>Dry Run</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      setIsSelectMode(true);
                      setSelectedRuleIdsForDelete(new Set());
                    }}
                    aria-label="Select automations to delete"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-surface-secondary hover:bg-default-hover text-foreground border border-border transition"
                  >
                    <CheckSquare className="w-3 h-3 text-accent" />
                    <span>Select</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => setShowImportModal(true)}
                    aria-label="Import automations from file or paste JSON"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-surface-secondary hover:bg-default-hover text-foreground border border-border transition"
                  >
                    <Upload className="w-3 h-3 text-accent" />
                    <span className="hidden sm:inline">Import</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={handleDownloadJson}
                    aria-label="Export and download automations.json"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-surface-secondary hover:bg-default-hover text-foreground border border-border transition"
                  >
                    <Download className="w-3 h-3 text-accent" />
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 bg-surface-secondary -m-1 p-2.5 rounded-xl border border-border">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-accent">
                      Select ({selectedRuleIdsForDelete.size})
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const visibleIds = rules
                          .filter(r => matchesRuleSearch(r, ruleSearchQuery, catalog))
                          .map(r => r.id);
                        const allVisibleSelected =
                          visibleIds.length > 0 && visibleIds.every(id => selectedRuleIdsForDelete.has(id));
                        if (allVisibleSelected) {
                          setSelectedRuleIdsForDelete(new Set());
                        } else {
                          setSelectedRuleIdsForDelete(new Set(visibleIds));
                        }
                      }}
                      className="text-[11px] text-muted hover:text-accent transition underline underline-offset-2 cursor-pointer"
                    >
                      {selectedRuleIdsForDelete.size > 0 && selectedRuleIdsForDelete.size >= rules.filter(r => matchesRuleSearch(r, ruleSearchQuery, catalog)).length
                        ? 'Deselect All'
                        : 'Select All'}
                    </button>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      setIsSelectMode(false);
                      setSelectedRuleIdsForDelete(new Set());
                      setShowBulkCategoryInput(false);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-surface-tertiary hover:bg-default-hover text-foreground border border-border transition"
                  >
                    <span>Done</span>
                  </Button>
                </div>

                {selectedRuleIdsForDelete.size > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-1.5 border-t border-separator">
                    <button
                      type="button"
                      onClick={() => handleBatchEnable(true)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-success-soft text-success border border-success/30 hover:opacity-90 transition cursor-pointer"
                      title="Enable selected rules"
                    >
                      <CheckCircle2 className="w-3 h-3" />
                      <span>Enable</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleBatchEnable(false)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-surface-tertiary text-muted hover:text-foreground border border-border transition cursor-pointer"
                      title="Disable selected rules"
                    >
                      <Ban className="w-3 h-3" />
                      <span>Disable</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowBulkCategoryInput(v => !v)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${
                        showBulkCategoryInput
                          ? 'bg-accent-soft text-accent border-accent/40'
                          : 'bg-surface-tertiary text-foreground border-border hover:bg-default-hover'
                      }`}
                      title="Assign category to selected rules"
                    >
                      <Tag className="w-3 h-3 text-accent" />
                      <span>Category</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleBatchExportSelected}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-surface-tertiary text-foreground border border-border hover:bg-default-hover transition cursor-pointer"
                      title="Export selected rules to JSON"
                    >
                      <Download className="w-3 h-3 text-accent" />
                      <span>Export</span>
                    </button>
                    <Button
                      variant="danger"
                      size="sm"
                      onPress={handleBatchDelete}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-danger hover:bg-danger-hover text-danger-foreground transition ml-auto"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Delete ({selectedRuleIdsForDelete.size})</span>
                    </Button>
                  </div>
                )}

                {selectedRuleIdsForDelete.size > 0 && showBulkCategoryInput && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="text"
                      value={bulkCategoryValue}
                      onChange={(e) => setBulkCategoryValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleBatchAssignCategory();
                      }}
                      placeholder="Category name (blank clears)..."
                      className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-surface border border-border text-xs text-foreground focus:outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={handleBatchAssignCategory}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-accent text-accent-foreground hover:bg-accent-hover transition cursor-pointer"
                    >
                      Apply
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Device Sync Toolbar */}
            <div className="p-2 rounded-xl bg-surface-secondary border border-border space-y-1.5">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <select
                    value={useMqttSync ? 'mqtt' : 'rest'}
                    onChange={e => setUseMqttSync(e.target.value === 'mqtt')}
                    className="px-1.5 py-1 text-[10px] font-mono rounded-lg bg-surface-tertiary border border-border text-accent focus:outline-none focus:border-focus"
                    title="Sync Method"
                  >
                    <option value="rest">Local (REST)</option>
                    <option value="mqtt">MQTT (Cloud)</option>
                  </select>

                  {!useMqttSync ? (
                    <input
                      type="text"
                      value={espIpDraft}
                      onChange={e => {
                        espIpDraftRef.current = e.target.value;
                        setEspIpDraft(e.target.value);
                      }}
                      onBlur={() => {
                        commitEspIp();
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          commitEspIp();
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder={getDefaultEspIp()}
                      title="Device IP address or hostname (press Enter or leave field to apply)"
                      className="min-w-0 flex-1 px-2 py-0.5 text-xs font-mono rounded-lg bg-surface-tertiary border border-border text-accent placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                    />
                  ) : (
                    <span className="text-[11px] font-mono text-muted truncate flex-1">
                      {mqttRemoteConfig.deviceId || 'mqtt-device'}
                    </span>
                  )}
                </div>

                <ButtonGroup size="sm" className="flex-shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    isDisabled={syncing}
                    onPress={handlePullFromEsp}
                    aria-label="Pull automations from vehicle device"
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-surface-tertiary hover:bg-default-hover text-foreground border border-border transition disabled:opacity-50"
                  >
                    <ArrowDown className="w-3 h-3 text-accent" />
                    <span>Pull</span>
                  </Button>
                  <Button
                    variant={hasUnpushedChanges ? 'primary' : 'secondary'}
                    size="sm"
                    isDisabled={syncing}
                    onPress={handlePushToEsp}
                    aria-label={hasUnpushedChanges ? "Unpushed changes - click to push to vehicle" : "Automations in sync with vehicle"}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-50 shadow-sm ${
                      hasUnpushedChanges
                        ? 'bg-warning hover:bg-warning-hover text-warning-foreground ring-2 ring-warning/40'
                        : 'bg-accent hover:bg-accent-hover text-accent-foreground'
                    }`}
                  >
                    <ArrowUp className="w-3 h-3" />
                    <span>{hasUnpushedChanges ? 'Push *' : 'Push'}</span>
                  </Button>
                </ButtonGroup>
              </div>

              {/* MQTT Expanded Credentials if in MQTT mode */}
              {useMqttSync && (
                <div className="grid grid-cols-2 gap-1.5 pt-1.5 border-t border-separator animate-in fade-in">
                  <input
                    type="text"
                    value={mqttRemoteConfig.wsUrl}
                    onChange={e => updateMqttConfig({ wsUrl: e.target.value })}
                    placeholder="wss://broker:port"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-surface-tertiary border border-border text-accent focus:outline-none focus:border-focus"
                    title="Broker WS URL (Must be wss:// if on HTTPS domain)"
                  />
                  <input
                    type="text"
                    value={mqttRemoteConfig.deviceId}
                    onChange={e => updateMqttConfig({ deviceId: e.target.value })}
                    placeholder="Device ID (e.g. my_device)"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-surface-tertiary border border-border text-accent focus:outline-none focus:border-focus"
                  />
                  <input
                    type="text"
                    value={mqttRemoteConfig.user}
                    onChange={e => updateMqttConfig({ user: e.target.value })}
                    placeholder="Username (optional)"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-surface-tertiary border border-border text-accent focus:outline-none focus:border-focus"
                  />
                  <input
                    type="password"
                    value={mqttRemoteConfig.pass}
                    onChange={e => updateMqttConfig({ pass: e.target.value })}
                    placeholder="Password (optional)"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-surface-tertiary border border-border text-accent focus:outline-none focus:border-focus"
                  />
                </div>
              )}

              {syncStatus && (
                <div className="text-[10px] font-mono text-accent-soft-foreground bg-accent-soft border border-accent/30 rounded-md px-2 py-0.5 flex items-center justify-between">
                  <span className="truncate">{syncStatus}</span>
                  {syncing && <RefreshCw className="w-3 h-3 text-accent animate-spin flex-shrink-0 ml-1" />}
                </div>
              )}
            </div>

            {/* Compact Rule Search Bar (Option B) */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={ruleSearchQuery}
                onChange={(e) => setRuleSearchQuery(e.target.value)}
                placeholder="Search rules, CAN IDs, entities..."
                aria-label="Filter automations"
                className="w-full pl-8 pr-7 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
              {ruleSearchQuery && (
                <button
                  type="button"
                  onClick={() => setRuleSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted hover:text-foreground rounded cursor-pointer"
                  aria-label="Clear rule search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {(() => {
                const filteredRules = rules.filter(r => matchesRuleSearch(r, ruleSearchQuery, catalog));
                if (filteredRules.length === 0) {
                  return (
                    <div className="p-4 text-center rounded-xl border border-dashed border-border text-xs text-muted space-y-1.5">
                      <div>No rules match &ldquo;{ruleSearchQuery.trim()}&rdquo;.</div>
                      {ruleSearchQuery && (
                        <button
                          type="button"
                          onClick={() => setRuleSearchQuery('')}
                          className="text-accent hover:underline font-semibold cursor-pointer"
                        >
                          Clear search
                        </button>
                      )}
                    </div>
                  );
                }
                return filteredRules.map((rule, idx) => (
                  <SwipeableRuleItem
                    key={rule.id}
                    rule={rule}
                    idx={idx}
                    isSelected={rule.id === activeRule?.id}
                    isSelectMode={isSelectMode}
                    isCheckedForDelete={selectedRuleIdsForDelete.has(rule.id)}
                    fireRecord={ruleFireStats[rule.id]}
                    isRecentlyFired={recentlyFiredIds.has(rule.id)}
                    nowMs={relativeTimeTick}
                    onToggleCheck={handleToggleCheckForDelete}
                    onSelect={setSelectedRuleId}
                    onDuplicate={handleDuplicateRule}
                    onDelete={handleDeleteRule}
                    onToggleEnabled={(id, enabled) => handleUpdateRule(id, { enabled })}
                    onRunActions={handleRunAllRuleActions}
                    onShowTraces={handleSimulateRule}
                    onMoreInfo={(r) => setMoreInfoRule(r)}
                    onEditSettings={(r) => setEditingSettingsRule(r)}
                    onEditCategory={(r) => setEditingCategoryRule(r)}
                  />
                ));
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: Add Element (HA-style Categorized Selector) */}
      {addElementTarget && (
        <AddElementModal
          target={addElementTarget}
          catalog={catalog}
          onClose={() => setAddElementTarget(null)}
        />
      )}

      {/* MODAL: Community Automations */}
      {showCommunityModal && (
        <CommunityAutomationsModal
          catalog={catalog}
          initialTab={communityModalTab}
          currentRules={rules}
          activeRule={activeRule}
          onInstallRule={(newRule) => {
            const decompiledRule = ensureRuleTriggerClientIds(decompileAutomationRule(newRule, catalog));
            const fallbackId = `rule_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
            let installedId = decompiledRule.id;
            onUpdateRules(prev => {
              const existing = prev.find(r => r.id === decompiledRule.id);
              const ruleToInstall = existing
                ? { ...decompiledRule, id: fallbackId }
                : decompiledRule;
              installedId = ruleToInstall.id;
              return [ruleToInstall, ...prev];
            });
            setSelectedRuleId(installedId);
          }}
          onClose={() => setShowCommunityModal(false)}
        />
      )}

      {/* MODAL: Import Automations */}
      {showImportModal && (
        <AutomationImportModal
          isOpen={showImportModal}
          existingRules={rules}
          catalog={catalog}
          onClose={() => setShowImportModal(false)}
          onImport={handleApplyImport}
        />
      )}

      {/* MODAL: Interactive Offline Rule Dry-Run Simulator */}
      <RuleSimulatorModal
        rule={activeRule || null}
        isOpen={showSimulateModal}
        onClose={() => setShowSimulateModal(false)}
        catalog={catalog}
        liveFrames={EMPTY_LIVE_FRAMES}
        entityStates={entityStates}
        liveWifiStatus={liveWifiStatus}
        liveBleMap={liveBleMap}
        onQueryHardwareDryRun={queryHardwareDryRun}
      />

      {/* MODAL: Automation More Info */}
      <AutomationMoreInfoModal
        rule={moreInfoRule}
        isOpen={Boolean(moreInfoRule)}
        onClose={() => setMoreInfoRule(null)}
        onToggleEnabled={(id, enabled) => handleUpdateRule(id, { enabled })}
        onRunActions={handleRunAllRuleActions}
        onShowTraces={handleSimulateRule}
        onEditCategory={(r) => setEditingCategoryRule(r)}
        onEditSettings={(r) => setEditingSettingsRule(r)}
      />

      {/* MODAL: Edit Category */}
      <AutomationCategoryModal
        rule={editingCategoryRule}
        isOpen={Boolean(editingCategoryRule)}
        onClose={() => setEditingCategoryRule(null)}
        onSaveCategory={(id, category) => handleUpdateRule(id, { category })}
      />

      {/* MODAL: Automation Settings */}
      <AutomationSettingsModal
        rule={editingSettingsRule}
        isOpen={Boolean(editingSettingsRule)}
        onClose={() => setEditingSettingsRule(null)}
        onSaveSettings={(id, updates) => handleUpdateRule(id, updates)}
      />

      {/* MODAL: Pre-Push Validation Check */}
      <PrePushValidationModal
        report={prePushReport}
        isOpen={Boolean(prePushReport)}
        onClose={() => setPrePushReport(null)}
        onJumpToRule={(ruleId) => {
          if (ruleId && ruleId !== '(missing-id)') {
            setSelectedRuleId(ruleId);
          }
          setPrePushReport(null);
        }}
        onPushAnyway={() => {
          setPrePushReport(null);
          void executePushToEsp();
        }}
      />

      {/* MODAL: Confirm Overwriting Local Rules on Pull */}
      {pendingPullConfirmation && (
        <Modal
          isOpen={true}
          onOpenChange={(open) => {
            if (!open) {
              setPendingPullConfirmation(null);
              showSyncStatus('Pull cancelled — local rules preserved.', 4000);
            }
          }}
        >
          <ModalBackdrop className="bg-backdrop backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
            <ModalContainer className="w-full max-w-md">
              <ModalDialog className="relative bg-overlay border border-border rounded-2xl shadow-overlay overflow-hidden p-0 flex flex-col">
                <ModalHeader className="px-5 py-4 border-b border-separator bg-surface">
                  <div className="flex items-start gap-3 pr-8">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border bg-warning-soft text-warning border-warning/30">
                      <AlertTriangle className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <ModalHeading className="text-base font-bold text-foreground">
                        {pendingPullConfirmation.isEmptyDeviceOverwrite
                          ? 'Device Returned 0 Automations'
                          : 'Overwrite Unpushed Local Edits?'}
                      </ModalHeading>
                      <p className="text-xs text-muted mt-0.5">
                        Confirm before replacing your current workspace rules.
                      </p>
                    </div>
                  </div>
                </ModalHeader>
                <ModalBody className="p-5 space-y-2.5 text-sm text-foreground">
                  {pendingPullConfirmation.isEmptyDeviceOverwrite && (
                    <p className="text-xs leading-relaxed text-danger bg-danger-soft/50 border border-danger/30 rounded-xl p-3">
                      The ESP32 returned <strong>0 rules</strong>, while you currently have{' '}
                      <strong>{rules.length}</strong> local rule{rules.length !== 1 ? 's' : ''}. Proceeding will clear
                      all local rules in the editor.
                    </p>
                  )}
                  {pendingPullConfirmation.hasUnpushedChanges && (
                    <p className="text-xs leading-relaxed text-foreground/90">
                      You have <strong>unpushed local changes</strong> that have not been sent to the ESP32. Replacing
                      them with the {pendingPullConfirmation.rules.length} rule
                      {pendingPullConfirmation.rules.length !== 1 ? 's' : ''} pulled
                      {pendingPullConfirmation.sourceLabel} will discard those local edits.
                    </p>
                  )}
                </ModalBody>
                <ModalFooter className="px-5 py-3 border-t border-separator bg-surface flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      setPendingPullConfirmation(null);
                      showSyncStatus('Pull cancelled — local rules preserved.', 4000);
                    }}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition cursor-pointer"
                  >
                    Keep Local Rules
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onPress={() => {
                      const pending = pendingPullConfirmation;
                      setPendingPullConfirmation(null);
                      commitPulledAutomations(pending.rules, pending.settings, pending.sourceLabel);
                    }}
                    className="px-4 py-1.5 rounded-xl text-xs font-bold bg-danger hover:bg-danger/90 text-white transition cursor-pointer"
                  >
                    Overwrite Local Rules
                  </Button>
                </ModalFooter>
              </ModalDialog>
            </ModalContainer>
          </ModalBackdrop>
        </Modal>
      )}

      {/* Floating Clipboard Indicator */}
      {clipboard && (
        <div className="fixed bottom-5 right-5 z-40 max-w-sm flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-overlay text-overlay-foreground border border-accent/40 shadow-overlay backdrop-blur-md text-xs animate-in fade-in slide-in-from-bottom-2">
          <div className="p-1.5 rounded-lg bg-accent-soft text-accent shrink-0">
            <ClipboardCheck className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-muted uppercase tracking-wider font-semibold">
              Clipboard ({clipboard.type})
            </div>
            <div className="text-foreground font-medium truncate" title={clipboard.label}>
              {clipboard.label}
            </div>
          </div>
          <button
            type="button"
            onClick={clearClipboard}
            className="p-1 text-muted hover:text-danger rounded transition shrink-0"
            title="Clear clipboard"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Floating Action Button (FAB) for Unpushed Automation Edits */}
      {hasUnpushedChanges && !isPushFabDismissed && (
        portalTarget ? (
          createPortal(
            <PushFab
              syncing={syncing}
              ruleCount={rules.length}
              onPush={handlePushToEsp}
              onDismiss={() => setIsPushFabDismissed(true)}
            />,
            portalTarget
          )
        ) : (
          <div className="ha-fab-stack">
            <PushFab
              syncing={syncing}
              ruleCount={rules.length}
              onPush={handlePushToEsp}
              onDismiss={() => setIsPushFabDismissed(true)}
            />
          </div>
        )
      )}
    </div>
    </AutomationClipboardContext.Provider>
  );
};
