import React, { useState, useRef, useCallback, useContext, createContext } from 'react';
import mqtt from 'mqtt';
import { Switch, Button, ButtonGroup, Slider } from '@heroui/react';
import {
  AutomationRule,
  AutomationSettings,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  AutomationActionStep,
  ChoiceBranch,
  CycleEntityAction,
  ClipboardBlockType,
  AutomationClipboardItem
} from '../types/automation';
import { Catalog, Command, CommandOption } from '../types/catalog';
import {
  exportToCandoJson,
  commandToTrigger,
  commandToCondition,
  commandToAction,
  compileToByteMap,
  resolveCatalogCommandForTrigger,
  resolveCatalogCommandForCondition,
  resolveCatalogCommandForAction,
  applyOptionToTrigger,
  applyOptionToCondition,
  applyOptionsToCondition,
  applyOptionToAction,
  regenerateActionIds,
  regenerateConditionIds,
  regenerateTriggerIds,
  regenerateBranchIds,
  cloneRuleWithNewIds,
  convertTriggerToCondition,
  convertConditionToTrigger,
  deepClone,
  normalizeCanId,
  formatCanId
} from '../utils/automationConverters';
import { getDefaultEspIp, resolveDeviceBaseUrl, isRunningOnDevice } from '../utils/hostUtils';
import { deviceWs } from '../services/deviceWs';
import { BleButtonComboPicker } from './BleButtonComboPicker';
import { BleDeviceSelect, BleBeaconSelect } from './BleSelects';
import {
  Zap,
  Shield,
  Send,
  Plus,
  Trash2,
  Copy,
  CopyPlus,
  Check,
  CheckSquare,
  Download,
  Upload,
  Play,
  RotateCw,
  Sliders,
  Sparkles,
  Layers,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
  Search,
  ExternalLink,
  Code,
  FileJson,
  RefreshCcw,
  RefreshCw,
  Eye,
  Info,
  Car,
  GitFork,
  Split,
  Clock,
  MessageSquare,
  Thermometer,
  Radio,
  Wifi,
  Bluetooth,
  Signal,
  SignalHigh,
  SignalMedium,
  SignalLow,
  X,
  Share2,
  Users,
  HelpCircle,
  XCircle,
  Clipboard,
  ClipboardCopy,
  ClipboardPaste,
  ClipboardCheck,
  Tag
} from 'lucide-react';
import { AddElementModal, AddElementTarget } from './AddElementModal';
import { CommunityAutomationsModal } from './CommunityAutomationsModal';
import { AutomationImportModal } from './AutomationImportModal';
import { HaToggleSwitch } from './automation/HaToggleSwitch';
import { AutomationActionMenu } from './automation/AutomationActionMenu';
import { AutomationMoreInfoModal } from './automation/AutomationMoreInfoModal';
import { AutomationCategoryModal } from './automation/AutomationCategoryModal';
import { AutomationSettingsModal } from './automation/AutomationSettingsModal';

interface AutomationBuilderProps {
  catalog: Catalog;
  rules: AutomationRule[];
  onUpdateRules: (newRules: AutomationRule[]) => void;
  settings: AutomationSettings;
  onUpdateSettings: (newSettings: AutomationSettings) => void;
  onBackToCatalog?: () => void;
  onNavigateToCatalog?: () => void;
  initialSelectedCommandIds?: string[];
  // If items were selected from the catalog to pull into an automation
  pulledCommands?: { command: Command; option?: CommandOption; role?: 'trigger' | 'condition' | 'action' }[];
  onClearPulledCommands?: () => void;
}

import {
  AutomationClipboardContext,
  CLIPBOARD_STORAGE_KEY,
  AutomationClipboardContextType
} from './automation/AutomationClipboardContext';
import {
  LiveWifiStatus,
  LiveBleItem,
  OptionGridGroup,
  ConditionValidityState,
  EvaluatedConditionResult,
  groupOptionsIntoGridRows,
  parseHexPayload,
  isOptionCurrentlyValid,
  evaluateConditionState
} from './automation/liveEvaluator';
import { DayOfWeekPicker } from './automation/DayOfWeekPicker';
import { SwipeableRuleItem } from './automation/SwipeableRuleItem';
import { TriggerNodeEditor } from './automation/TriggerNodeEditor';
import { ConditionNodeEditor, ConditionListEditor } from './automation/ConditionNodeEditor';
import { ActionNodeEditor, ActionListEditor } from './automation/ActionNodeEditor';

export const AutomationBuilder: React.FC<AutomationBuilderProps> = ({
  catalog,
  rules,
  onUpdateRules,
  settings,
  onUpdateSettings,
  onBackToCatalog,
  pulledCommands = [],
  onClearPulledCommands
}) => {
  const [selectedRuleId, setSelectedRuleId] = useState<string>(
    rules.length > 0 ? rules[0].id : ''
  );
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedRuleIdsForDelete, setSelectedRuleIdsForDelete] = useState<Set<string>>(new Set());
  const [showImportModal, setShowImportModal] = useState(false);
  const [addElementTarget, setAddElementTarget] = useState<AddElementTarget | null>(null);
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [showCommunityModal, setShowCommunityModal] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  const [espIp, setEspIp] = useState<string>(() => getDefaultEspIp());
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [communityModalTab, setCommunityModalTab] = useState<'browse' | 'share'>('browse');
  const [moreInfoRule, setMoreInfoRule] = useState<AutomationRule | null>(null);
  const [editingCategoryRule, setEditingCategoryRule] = useState<AutomationRule | null>(null);
  const [editingSettingsRule, setEditingSettingsRule] = useState<AutomationRule | null>(null);
  const lastPushedJsonRef = useRef<string>(JSON.stringify(rules));
  const hasUnpushedChanges = lastPushedJsonRef.current !== JSON.stringify(rules);


  // Global Automation Clipboard state
  const [clipboard, setClipboard] = useState<AutomationClipboardItem | null>(() => {
    try {
      const saved = sessionStorage.getItem(CLIPBOARD_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const copyToClipboard = useCallback((type: ClipboardBlockType, payload: any, label: string) => {
    const item: AutomationClipboardItem = {
      type,
      payload: deepClone(payload),
      timestamp: Date.now(),
      label
    };
    setClipboard(item);
    try {
      sessionStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(item));
    } catch {
      // Storage quota or disabled
    }
  }, []);

  const clearClipboard = useCallback(() => {
    setClipboard(null);
    try {
      sessionStorage.removeItem(CLIPBOARD_STORAGE_KEY);
    } catch {}
  }, []);

  const pastePayload = useCallback((targetType?: ClipboardBlockType): any | null => {
    if (!clipboard) return null;
    const cloned = deepClone(clipboard.payload);
    if (clipboard.type === 'trigger') {
      if (targetType === 'condition') {
        const cond = convertTriggerToCondition(cloned);
        return regenerateConditionIds(cond);
      }
      return regenerateTriggerIds(cloned);
    }
    if (clipboard.type === 'condition') {
      if (targetType === 'trigger') {
        const trig = convertConditionToTrigger(cloned);
        return regenerateTriggerIds(trig);
      }
      return regenerateConditionIds(cloned);
    }
    if (clipboard.type === 'action') {
      return regenerateActionIds(cloned);
    }
    if (clipboard.type === 'branch') {
      return regenerateBranchIds(cloned, true);
    }
    return cloned;
  }, [clipboard]);

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

  // Live CAN frames & Entity states for real-time condition validity evaluation
  const [liveFrames, setLiveFrames] = useState<Map<string, { data: string }>>(new Map());
  const [entityStates, setEntityStates] = useState<Map<string, string>>(new Map());
  const [lastFiredTriggerId, setLastFiredTriggerId] = useState<string | undefined>();
  const [actionTestToast, setActionTestToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Live Wi-Fi & BLE status for condition validity & threshold auto-population
  const [liveWifiStatus, setLiveWifiStatus] = useState<LiveWifiStatus | null>(null);
  const [liveBleMap, setLiveBleMap] = useState<Map<string, LiveBleItem>>(new Map());
  const bleMapRef = useRef<Map<string, LiveBleItem>>(new Map());

  const framesRef = useRef<Map<string, { data: string }>>(new Map());
  const entityStatesRef = useRef<Map<string, string>>(new Map());

  // WebSocket connection & background polling for live telemetry
  React.useEffect(() => {
    let isCancelled = false;

    // Fetch initial entity states via REST
    const fetchInitialStates = async () => {
      try {
        const base = resolveDeviceBaseUrl(espIp);
        const res = await fetch(`${base}/api/states`);
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
              entityStatesRef.current.set(k.toLowerCase(), String(v));
            }
            setEntityStates(new Map(entityStatesRef.current));
          }
        }
      } catch {
        // Device not connected or running in simulator mode
      }
    };

    // Fetch live Wi-Fi and BLE status
    const fetchLiveNetworkAndBle = async () => {
      try {
        const base = resolveDeviceBaseUrl(espIp);
        // Wi-Fi Status
        const wifiRes = await fetch(`${base}/api/wifi/status`);
        if (wifiRes.ok) {
          const wData = await wifiRes.json();
          if (wData && typeof wData === 'object') {
            setLiveWifiStatus({
              sta_connected: !!wData.sta_connected,
              sta_ssid: wData.sta_ssid || '',
              sta_ip: wData.sta_ip || '',
              sta_rssi: typeof wData.sta_rssi === 'number' ? wData.sta_rssi : -65,
              ap_clients: typeof wData.ap_clients === 'number' ? wData.ap_clients : 0
            });
          }
        }
        // BLE Status
        const bleRes = await fetch(`${base}/api/ble/status`);
        if (bleRes.ok) {
          const bData = await bleRes.json();
          if (bData && typeof bData === 'object') {
            if (Array.isArray(bData.beacons)) {
              for (const b of bData.beacons) {
                const item: LiveBleItem = {
                  name: b.name,
                  uuid: b.uuid,
                  mac: b.mac,
                  rssi: b.rssi,
                  is_present: b.is_present,
                  connected: false
                };
                if (b.uuid) bleMapRef.current.set(b.uuid.toLowerCase(), item);
                if (b.mac) bleMapRef.current.set(b.mac.toLowerCase(), item);
                if (b.name) bleMapRef.current.set(b.name.toLowerCase(), item);
              }
            }
            if (Array.isArray(bData.discovered_beacons)) {
              for (const b of bData.discovered_beacons) {
                const item: LiveBleItem = {
                  name: b.name,
                  uuid: b.uuid,
                  mac: b.mac,
                  rssi: b.rssi,
                  is_present: true,
                  connected: false
                };
                if (b.uuid && !bleMapRef.current.has(b.uuid.toLowerCase())) bleMapRef.current.set(b.uuid.toLowerCase(), item);
                if (b.mac && !bleMapRef.current.has(b.mac.toLowerCase())) bleMapRef.current.set(b.mac.toLowerCase(), item);
                if (b.name && !bleMapRef.current.has(b.name.toLowerCase())) bleMapRef.current.set(b.name.toLowerCase(), item);
              }
            }
            if (bData.connected_device) {
              const cd = bData.connected_device;
              const item: LiveBleItem = {
                name: cd.name,
                mac: cd.address,
                rssi: cd.rssi,
                is_present: true,
                connected: true
              };
              if (cd.address) bleMapRef.current.set(cd.address.toLowerCase(), item);
              if (cd.name) bleMapRef.current.set(cd.name.toLowerCase(), item);
              bleMapRef.current.set('connected_device', item);
            }
            setLiveBleMap(new Map(bleMapRef.current));
          }
        }
      } catch {
        // Offline / simulator mode
      }
    };

    fetchInitialStates();
    fetchLiveNetworkAndBle();
    const pollInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchLiveNetworkAndBle();
    }, 4000);

    const unsubscribeMsgs = deviceWs.subscribe((msg) => {
      if (isCancelled) return;
      if (msg.type === 'can_frame' && (msg as any).id) {
        const normId = String((msg as any).id).trim().toLowerCase();
        framesRef.current.set(normId, { data: (msg as any).data || '' });
        setLiveFrames(new Map(framesRef.current));
      } else if (msg.type === 'state' && (msg as any).entity) {
        entityStatesRef.current.set(String((msg as any).entity).toLowerCase(), String((msg as any).state || ''));
        setEntityStates(new Map(entityStatesRef.current));
      } else if (msg.type === 'automation_fired') {
        if ((msg as any).trigger_id) {
          setLastFiredTriggerId((msg as any).trigger_id);
        }
      } else if (msg.type === 'wifi_status') {
        const wData = msg as any;
        setLiveWifiStatus({
          sta_connected: !!wData.sta_connected,
          sta_ssid: wData.sta_ssid || '',
          sta_ip: wData.sta_ip || '',
          sta_rssi: typeof wData.sta_rssi === 'number' ? wData.sta_rssi : -65,
          ap_clients: typeof wData.ap_clients === 'number' ? wData.ap_clients : 0
        });
      } else if (msg.type === 'ble_beacon' || msg.type === 'ble_proximity') {
        const item: LiveBleItem = {
          name: (msg as any).name,
          uuid: (msg as any).uuid,
          mac: (msg as any).mac || (msg as any).address,
          rssi: (msg as any).rssi,
          is_present: (msg as any).is_present ?? true,
          connected: false
        };
        if (item.uuid) bleMapRef.current.set(item.uuid.toLowerCase(), item);
        if (item.mac) bleMapRef.current.set(item.mac.toLowerCase(), item);
        if (item.name) bleMapRef.current.set(item.name.toLowerCase(), item);
        setLiveBleMap(new Map(bleMapRef.current));
      }
    });

    return () => {
      isCancelled = true;
      clearInterval(pollInterval);
      unsubscribeMsgs();
    };
  }, [espIp]);

  // Formats any raw payload or ByteMap into clean 8-byte space-separated hex and ByteMap object
  const formatPayloadForApi = (payload: string | any): { str: string; obj: Record<string, string> } => {
    const byteMap = compileToByteMap(payload);
    const obj: Record<string, string> = {};
    const hexBytes: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const key = `D${i}`;
      const rawVal = byteMap[key] || '0x00';
      const hexVal = String(rawVal).replace(/^0x/i, '').padStart(2, '0').slice(-2).toUpperCase();
      obj[key] = `0x${hexVal}`;
      hexBytes.push(hexVal);
    }
    return { str: hexBytes.join(' '), obj };
  };

  // Handler for testing an individual action manually across all command types and structures
  const handleTestSingleAction = async (act: AutomationAction) => {
    try {
      const base = resolveDeviceBaseUrl(espIp);

      // Flow 1: Delay
      if (act.type === 'delay') {
        const ms = act.delay_ms || act.ms || 1000;
        setActionTestToast({ message: `Testing delay: waiting ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}...`, type: 'info' });
        await new Promise(r => setTimeout(r, Math.min(ms, 3000)));
        setActionTestToast({ message: `Delay test completed (${ms}ms)`, type: 'success' });
        setTimeout(() => setActionTestToast(null), 3500);
        return;
      }

      // Flow 2: Wait For Condition
      if (act.type === 'wait_for') {
        const condList = act.conditions || (act.condition ? [act.condition] : []);
        if (condList.length === 0) {
          setActionTestToast({ message: 'Wait-for action has no target condition (will proceed immediately)', type: 'info' });
          setTimeout(() => setActionTestToast(null), 4000);
          return;
        }
        const evalRes = evaluateConditionState(condList[0], liveFrames, entityStates, lastFiredTriggerId, catalog);
        const isMatched = evalRes.state === 'valid';
        setActionTestToast({
          message: `Wait-for condition: ${isMatched ? 'MATCHED' : evalRes.state === 'invalid' ? 'NOT MET' : 'Awaiting telemetry'} (${evalRes.reason || 'live state'})`,
          type: isMatched ? 'success' : 'info'
        });
        setTimeout(() => setActionTestToast(null), 4500);
        return;
      }

      // Flow 3: IF-THEN-ELSE
      if (act.type === 'if_then') {
        const condList = act.conditions || [];
        const passed = condList.length === 0 || condList.every(c => evaluateConditionState(c, liveFrames, entityStates, lastFiredTriggerId, catalog).state === 'valid');
        const branchActs = passed ? (act.then || []) : (act.else || []);
        setActionTestToast({
          message: `IF-THEN evaluated to ${passed ? 'TRUE' : 'FALSE'}. Testing ${branchActs.length > 0 ? `action in ${passed ? 'THEN' : 'ELSE'}` : `empty ${passed ? 'THEN' : 'ELSE'} branch`}`,
          type: 'info'
        });
        if (branchActs.length > 0) {
          await handleTestSingleAction(branchActs[0]);
        } else {
          setTimeout(() => setActionTestToast(null), 4000);
        }
        return;
      }

      // Flow 4: CHOOSE
      if (act.type === 'choose') {
        const choices = act.choices || [];
        let matchedBranch: AutomationAction[] | null = null;
        let matchedIdx = -1;
        for (let i = 0; i < choices.length; i++) {
          const ch = choices[i];
          const conds = ch.conditions || [];
          if (conds.length > 0 && conds.every(c => evaluateConditionState(c, liveFrames, entityStates, lastFiredTriggerId, catalog).state === 'valid')) {
            matchedBranch = ch.sequence || [];
            matchedIdx = i;
            break;
          }
        }
        if (!matchedBranch) {
          matchedBranch = act.default || [];
        }
        setActionTestToast({
          message: `CHOOSE branch: ${matchedIdx >= 0 ? `Branch #${matchedIdx + 1}` : 'DEFAULT'}. Testing ${matchedBranch.length > 0 ? 'action' : 'empty sequence'}`,
          type: 'info'
        });
        if (matchedBranch.length > 0) {
          await handleTestSingleAction(matchedBranch[0]);
        } else {
          setTimeout(() => setActionTestToast(null), 4000);
        }
        return;
      }

      // Flow 5: Webhook
      if (act.type === 'webhook' && act.webhook_url) {
        await fetch(act.webhook_url, {
          method: act.webhook_method || 'POST',
          mode: 'no-cors'
        });
        setActionTestToast({ message: `Webhook dispatched to ${act.webhook_url}`, type: 'success' });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
      }

      // Flow 6: Cluster Notification Popup
      if (act.type === 'track_popup' || act.type === 'popup') {
        const msg = act.text || act.popup_message || 'Test cluster notification';
        try {
          const res = await fetch(`${base}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, level: act.level || 'info' })
          });
          if (res.ok) {
            setActionTestToast({ message: `Triggered cluster popup: "${msg}"`, type: 'success' });
            setTimeout(() => setActionTestToast(null), 4000);
            return;
          }
        } catch {
          // If /api/notify endpoint is unavailable on device, fallback to /api/command below
        }
      }

      // Flow: Cycle Entity State Stepper (must run before generic CAN / multi-step flows!)
      if (act.type === 'cycle_entity') {
        const entId = act.entity_id || act.target_command_id || 'drivers_seat_comfort';
        const states = act.states && act.states.length > 0 ? act.states : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
        const curState = entityStates.get(entId.toLowerCase()) || entityStates.get(entId) || act.fallback_state || states[0];
        const curIdx = states.findIndex(s => s.toLowerCase() === curState.toLowerCase());
        const dir = act.direction || 'forward';
        let nextIdx = 0;
        if (dir === 'forward') {
          nextIdx = curIdx >= 0 ? curIdx + 1 : 0;
          if (nextIdx >= states.length) {
            nextIdx = act.wrap !== false ? 0 : states.length - 1;
          }
        } else {
          nextIdx = curIdx >= 0 ? curIdx - 1 : 0;
          if (nextIdx < 0) {
            nextIdx = act.wrap !== false ? states.length - 1 : 0;
          }
        }
        const nextState = states[nextIdx];
        const { command: cycleCmd } = catalog ? resolveCatalogCommandForAction({ ...act, entity_id: entId, option_label: nextState, command: nextState }, catalog) : { command: undefined };
        const nextOpt = cycleCmd?.options?.find(o => o.label.toLowerCase() === nextState.toLowerCase() || o.id === nextState);
        if (cycleCmd && nextOpt) {
          const syntheticAct = commandToAction(cycleCmd, nextOpt);
          await handleTestSingleAction(syntheticAct);
        }
        setActionTestToast({
          message: `Cycle ${entId}: ${curState} ➔ ${nextState} (${dir}, wrap=${act.wrap !== false})`,
          type: 'success'
        });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
      }

      // Flow 7: Resolve Command & Option Details from Catalog if available
      const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForAction(act, catalog) : { command: undefined, matchedOption: undefined };
      
      const targetCanId = act.can_id || catalogCmd?.network?.action_can_id || catalogCmd?.action_can_id || catalogCmd?.network?.state_can_id || catalogCmd?.state_can_id;
      const targetEntityId = act.entity_id || act.source_command_id || catalogCmd?.id;
      const targetCommand = act.command || act.option_label || matchedOption?.label || (catalogCmd?.options && catalogCmd.options[0]?.label);
      const rawActPayload =
        (typeof act.payload === 'object' && act.payload && Object.keys(act.payload).length > 0
          ? act.payload
          : typeof act.payload === 'string' && act.payload.trim() !== ''
          ? act.payload
          : undefined);
      const rawPayload = rawActPayload || matchedOption?.payload || (matchedOption?.steps && matchedOption.steps[0]?.payload) || catalogCmd?.payload;
      const { str: cleanPayloadStr } = formatPayloadForApi(rawPayload);
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
              payload: cleanPayloadStr,
              repeat: 3
            })
          });
          if (res.ok) sent = true;
        } catch {}

        if (!sent && preconSteps.length > 0) {
          for (let sIdx = 0; sIdx < preconSteps.length; sIdx++) {
            const s = preconSteps[sIdx];
            const { str: sStr } = formatPayloadForApi(s.payload);
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
            if (!stepRes.ok) throw new Error(`HTTP ${stepRes.status}: ${stepRes.statusText}`);
            if (sIdx < preconSteps.length - 1) {
              await new Promise(r => setTimeout(r, 25));
            }
          }
        }

        setActionTestToast({
          message: `Action tested: Triggered Battery Preconditioning (${preconMode} - ${preconAction})`,
          type: 'success'
        });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
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
            payload: cleanPayloadStr,
            repeat: targetRepeat,
            delay_ms: targetDelay,
            bus: normBus
          })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        setActionTestToast({
          message: `Action tested: Set Climate Target ${targetTemp}°C (${targetZone})`,
          type: 'success'
        });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
      }

      // Special Flow 9.5: Ambient Mood Lighting (executes hardware-timed 2-stage burst on both 0x4AD Dash + 0x48F Doors)
      if (targetEntityId === 'ambient_mood_lighting' || (targetCanId && targetCanId.toUpperCase() === '0X4AD')) {
        let dispatchedViaEntity = false;
        if (targetCommand) {
          try {
            const res = await fetch(`${base}/api/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entity: 'ambient_mood_lighting',
                command: targetCommand
              })
            });
            if (res.ok) {
              dispatchedViaEntity = true;
            }
          } catch {}
        }

        if (dispatchedViaEntity) {
          setActionTestToast({
            message: `Action tested: Ambient Mood Lighting ➔ ${targetCommand} (0x4AD Dash + 0x48F Doors)`,
            type: 'success'
          });
          setTimeout(() => setActionTestToast(null), 4000);
          return;
        }
      }

      // Flow 10: Multi-Step Action Execution (e.g. ambient lighting burst + latch commit, seat comfort 2-stage)
      if (targetSteps && targetSteps.length > 1) {
        for (let sIdx = 0; sIdx < targetSteps.length; sIdx++) {
          const stepItem = targetSteps[sIdx];
          const stepPayloadMap = compileToByteMap(stepItem.payload);
          const resolvedStepPayload =
            Object.keys(stepPayloadMap).length > 0
              ? stepPayloadMap
              : matchedOption?.steps?.[sIdx]?.payload || stepItem.payload;
          const { str: sStr } = formatPayloadForApi(resolvedStepPayload);
          const sRepeat = stepItem.repeat || targetRepeat;
          const sDelay = stepItem.delay_ms || targetDelay;
          const sCid = stepItem.can_id || targetCanId;
          const sBus = stepItem.bus ?? normBus;
          if (sCid) {
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
              throw new Error(`HTTP ${stepRes.status}: ${stepRes.statusText}`);
            }
            if (sIdx < targetSteps.length - 1 && sDelay > 0) {
              await new Promise(r => setTimeout(r, Math.min(sDelay, 2000)));
            }
          }
        }
        setActionTestToast({
          message: `Action tested: Transmitted sequence (${targetSteps.length} steps) on ${targetCanId || 'CAN'}${targetCommand ? ` (${targetCommand})` : ''}`,
          type: 'success'
        });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
      }

      // Flow 11: Direct CAN Frame Dispatch (for commands with known CAN ID & payload, e.g. windows, locks, seats)
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
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const labelText = targetCommand ? ` (${targetCommand})` : '';
        setActionTestToast({
          message: `Action tested: Transmitted CAN ${targetCanId} [${cleanPayloadStr}]${labelText}`,
          type: 'success'
        });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
      }

      // Flow 12: Entity Command Dispatch (for firmware-handled entities without raw CAN ID)
      if (targetEntityId && targetCommand) {
        const res = await fetch(`${base}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity: targetEntityId,
            command: targetCommand
          })
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        setActionTestToast({
          message: `Dispatched command to ${targetEntityId}: ${targetCommand}`,
          type: 'success'
        });
        setTimeout(() => setActionTestToast(null), 4000);
        return;
      }

      // Fallback
      setActionTestToast({ message: `Simulated action test for: ${act.type || targetEntityId || 'unknown'}`, type: 'info' });
      setTimeout(() => setActionTestToast(null), 4000);
    } catch (err: any) {
      setActionTestToast({ message: `Action test failed: ${err.message}`, type: 'error' });
      setTimeout(() => setActionTestToast(null), 5000);
    }
  };

  const activeRule = rules.find(r => r.id === selectedRuleId) || rules[0];

  // Handle incoming pulled commands from the catalog
  React.useEffect(() => {
    if (pulledCommands.length > 0 && activeRule) {
      const updatedRules = rules.map(r => {
        if (r.id === activeRule.id) {
          const newTriggers = [...r.triggers];
          const newConditions = [...r.conditions];
          const newActions = [...r.actions];

          pulledCommands.forEach(({ command, option, role }) => {
            const assignedRole = role || (command.roles.includes('trigger') ? 'trigger' : command.roles.includes('condition') ? 'condition' : 'action');
            if (assignedRole === 'trigger') {
              newTriggers.push(commandToTrigger(command, option));
            } else if (assignedRole === 'condition') {
              newConditions.push(commandToCondition(command, option));
            } else {
              newActions.push(commandToAction(command, option));
            }
          });

          return {
            ...r,
            triggers: newTriggers,
            conditions: newConditions,
            actions: newActions
          };
        }
        return r;
      });

      onUpdateRules(updatedRules);
      if (onClearPulledCommands) onClearPulledCommands();
    }
  }, [pulledCommands]);

  const handleUpdateActiveRule = (updated: Partial<AutomationRule>) => {
    if (!activeRule) return;
    const newRules = rules.map(r => (r.id === activeRule.id ? { ...r, ...updated } : r));
    onUpdateRules(newRules);
  };

  const handleUpdateRule = (ruleId: string, updated: Partial<AutomationRule>) => {
    const newRules = rules.map(r => (r.id === ruleId ? { ...r, ...updated } : r));
    onUpdateRules(newRules);
  };

  const handleRunAllRuleActions = async (targetRule: AutomationRule) => {
    const acts = targetRule.actions || [];
    if (acts.length === 0) {
      setActionTestToast({ message: `Rule "${targetRule.name}" has no actions configured.`, type: 'info' });
      setTimeout(() => setActionTestToast(null), 3000);
      return;
    }
    setActionTestToast({ message: `Executing ${acts.length} action(s) for "${targetRule.name}"...`, type: 'info' });
    try {
      for (const act of acts) {
        await handleTestSingleAction(act);
      }
      setActionTestToast({ message: `Executed actions for "${targetRule.name}" successfully!`, type: 'success' });
    } catch (err: any) {
      setActionTestToast({ message: `Error running actions: ${err?.message || err}`, type: 'error' });
    }
    setTimeout(() => setActionTestToast(null), 4000);
  };

  const handleSimulateRuleFor = async (targetRule: AutomationRule) => {
    setSelectedRuleId(targetRule.id);
    setShowSimulateModal(true);
    setSimulationLog([`[Dry Run / Trace Diagnostics] Rule: "${targetRule.name}" (${targetRule.id})...`]);

    try {
      const base = resolveDeviceBaseUrl(espIp);
      const res = await fetch(`${base}/api/automations/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: targetRule.id, mode: 'dry_run' })
      });
      if (res.ok) {
        const data = await res.json();
        const logs = [
          `[ESP32 Diagnostics] Target Rule: "${targetRule.name}" (${targetRule.id})`,
          `[Engine Evaluation] Result: ${data.passed ? 'PASSED (Rule armed)' : 'FAILED / INACTIVE'}`,
          `[Message] ${data.message || 'No additional details'}`
        ];
        setSimulationLog(logs);
        return;
      }
    } catch {
      // Offline fallback: evaluate locally
    }

    const trigs = targetRule.triggers || [];
    const conds = targetRule.conditions || [];
    const acts = targetRule.actions || [];
    const logs = [
      `[Local Evaluator] Rule: "${targetRule.name}"`,
      `[Trigger Engine] Monitoring ${trigs.length} trigger pattern(s)...`
    ];

    let allCondsPass = true;
    conds.forEach((cond, idx) => {
      const res = evaluateConditionState(cond, liveFrames, entityStates, lastFiredTriggerId, catalog, liveWifiStatus, liveBleMap);
      logs.push(`  [Condition #${idx + 1}] ${res.state.toUpperCase()}: ${res.reason || ''}`);
      if (res.state === 'invalid') allCondsPass = false;
    });

    if (allCondsPass) {
      logs.push(`[Condition Evaluator] ALL PASS: Rule conditions satisfied for ${acts.length} action(s).`);
    } else {
      logs.push(`[Condition Evaluator] CONDITIONS FAILED: Rule actions will NOT fire.`);
    }

    logs.push(`[Status] Cooldown configured for ${targetRule.cooldown_ms || 0}ms.`);
    setSimulationLog(logs);
  };

  const handleAddRule = () => {
    const newId = `rule_${Date.now().toString(36)}`;
    const newRule: AutomationRule = {
      id: newId,
      name: `New Automation Rule #${rules.length + 1}`,
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
    };

    onUpdateRules([...rules, newRule]);
    setSelectedRuleId(newId);
  };

  const handleDuplicateRule = (ruleToDup: AutomationRule) => {
    const duplicated = cloneRuleWithNewIds(ruleToDup);
    onUpdateRules([...rules, duplicated]);
    setSelectedRuleId(duplicated.id);
  };

  const handleDeleteRule = (ruleId: string) => {
    const newRules = rules.filter(r => r.id !== ruleId);
    if (newRules.length === 0) {
      const newId = `rule_${Date.now().toString(36)}`;
      const freshRule: AutomationRule = {
        id: newId,
        name: 'New Automation Rule #1',
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
      };
      onUpdateRules([freshRule]);
      setSelectedRuleId(newId);
    } else {
      onUpdateRules(newRules);
      if (selectedRuleId === ruleId) {
        setSelectedRuleId(newRules[0].id);
      }
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
    const remaining = rules.filter(r => !selectedRuleIdsForDelete.has(r.id));
    if (remaining.length === 0) {
      const newId = `rule_${Date.now().toString(36)}`;
      const freshRule: AutomationRule = {
        id: newId,
        name: 'New Automation Rule #1',
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
      };
      onUpdateRules([freshRule]);
      setSelectedRuleId(newId);
    } else {
      onUpdateRules(remaining);
      if (selectedRuleIdsForDelete.has(selectedRuleId)) {
        setSelectedRuleId(remaining[0].id);
      }
    }
    setSelectedRuleIdsForDelete(new Set());
    setIsSelectMode(false);
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

  const handlePushToEsp = async () => {
    setSyncing(true);

    if (useMqttSync) {
      setSyncStatus('Connecting to MQTT Broker...');
      try {
        const { wsUrl, deviceId, user, pass } = mqttRemoteConfig;
        if (!wsUrl || !deviceId) throw new Error('Broker URL and Device ID required');
        
        const client = mqtt.connect(wsUrl, {
          username: user || undefined,
          password: pass || undefined,
          connectTimeout: 5000
        });

        let timeoutTimer = setTimeout(() => {
          client.end();
          setSyncStatus('MQTT push timed out.');
          setSyncing(false);
        }, 10000);

        client.on('connect', () => {
          setSyncStatus('Publishing automations to device topic...');
          const payload = exportToCandoJson(rules, settings, catalog);
          client.publish(`cando/${deviceId}/config/automations/set`, payload, { qos: 1 }, (err) => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (err) {
              setSyncStatus(`Publish failed: ${err.message}`);
            } else {
              setSyncStatus('Success: Sent via MQTT!');
              setTimeout(() => setSyncStatus(null), 6000);
            }
            client.end();
            setSyncing(false);
          });
        });

        client.on('error', (err) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          setSyncStatus(`MQTT Connection Error: ${err.message}`);
          setSyncing(false);
          client.end();
        });
      } catch (err: any) {
        setSyncStatus(`MQTT Init Error: ${err.message}`);
        setSyncing(false);
      }
      return;
    }

    setSyncStatus('Pushing automations.json to ESP32...');

    try {
      const payload = exportToCandoJson(rules, settings, catalog);
      const base = resolveDeviceBaseUrl(espIp);
      const url = `${base}/api/automations`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      lastPushedJsonRef.current = JSON.stringify(rules);
      setSyncStatus(`Success: ${data.message || 'Saved. Rebooting ESP32...'}`);
      setTimeout(() => setSyncStatus(null), 6000);
    } catch (err: any) {
      setSyncStatus(`Push failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handlePullFromEsp = async () => {
    setSyncing(true);

    if (useMqttSync) {
      setSyncStatus('Connecting to MQTT broker for pull...');
      try {
        const { wsUrl, deviceId, user, pass } = mqttRemoteConfig;
        if (!wsUrl || !deviceId) throw new Error('Broker URL and Device ID required');
        
        const client = mqtt.connect(wsUrl, {
          username: user || undefined,
          password: pass || undefined,
          connectTimeout: 5000
        });

        let timeoutTimer = setTimeout(() => {
          client.end();
          setSyncStatus('MQTT pull timed out.');
          setSyncing(false);
        }, 15000);

        client.on('connect', () => {
          setSyncStatus('Requesting automations from device...');
          client.subscribe(`cando/${deviceId}/config/automations/state`, (err) => {
            if (!err) {
              client.publish(`cando/${deviceId}/config/automations/get`, '', { qos: 1 });
            } else {
              if (timeoutTimer) clearTimeout(timeoutTimer);
              setSyncStatus(`Subscribe Error: ${err.message}`);
              setSyncing(false);
              client.end();
            }
          });
        });

        client.on('message', (topic, message) => {
          if (topic === `cando/${deviceId}/config/automations/state`) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            try {
              const data = JSON.parse(message.toString());
              if (data.rules && Array.isArray(data.rules)) {
                onUpdateRules(data.rules);
                if (data.settings) onUpdateSettings(data.settings);
                if (data.rules[0]?.id) setSelectedRuleId(data.rules[0].id);
                setSyncStatus(`Imported ${data.rules.length} rule(s) via MQTT!`);
              } else if (Array.isArray(data)) {
                onUpdateRules(data);
                if (data[0]?.id) setSelectedRuleId(data[0].id);
                setSyncStatus(`Imported ${data.length} rule(s) via MQTT!`);
              } else {
                setSyncStatus('No rules array found in device response.');
              }
            } catch(e: any) {
              setSyncStatus(`Pull failed: ${e.message}`);
            }
            setSyncing(false);
            client.end();
            setTimeout(() => setSyncStatus(null), 6000);
          }
        });

        client.on('error', (err) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          setSyncStatus(`MQTT Connection Error: ${err.message}`);
          setSyncing(false);
          client.end();
        });
      } catch (err: any) {
        setSyncStatus(`MQTT Init Error: ${err.message}`);
        setSyncing(false);
      }
      return;
    }

    setSyncStatus('Pulling automations.json from ESP32...');

    try {
      const base = resolveDeviceBaseUrl(espIp);
      const url = `${base}/api/automations`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data.rules && Array.isArray(data.rules)) {
        onUpdateRules(data.rules);
        if (data.settings) onUpdateSettings(data.settings);
        if (data.rules[0]?.id) setSelectedRuleId(data.rules[0].id);
        setSyncStatus(`Imported ${data.rules.length} rule(s)!`);
      } else if (Array.isArray(data)) {
        onUpdateRules(data);
        if (data[0]?.id) setSelectedRuleId(data[0].id);
        setSyncStatus(`Imported ${data.length} rule(s)!`);
      } else {
        setSyncStatus('No rules array found in device response.');
      }
      setTimeout(() => setSyncStatus(null), 6000);
    } catch (err: any) {
      setSyncStatus(`Pull failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Automatically pull automations from device when running directly on-device
  const hasAutoPulled = useRef(false);
  React.useEffect(() => {
    if (isRunningOnDevice() && !hasAutoPulled.current) {
      hasAutoPulled.current = true;
      handlePullFromEsp();
    }
  }, []);

  const handleApplyImport = (
    importedRules: AutomationRule[],
    mode: 'merge' | 'replace',
    importedSettings?: AutomationSettings
  ) => {
    onUpdateRules(importedRules);
    if (importedSettings) {
      onUpdateSettings({ ...settings, ...importedSettings });
    }
    if (importedRules.length > 0 && importedRules[0]?.id) {
      setSelectedRuleId(importedRules[0].id);
    }
  };

  const handleSimulateRule = async () => {
    if (!activeRule) return;
    setShowSimulateModal(true);
    setSimulationLog(['[Dry Run] Querying device engine /api/automations/test...']);

    try {
      const base = resolveDeviceBaseUrl(espIp);
      const res = await fetch(`${base}/api/automations/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeRule.id, mode: 'dry_run' })
      });
      if (res.ok) {
        const data = await res.json();
        const logs = [
          `[ESP32 Diagnostics] Target Rule: "${activeRule.name}" (${activeRule.id})`,
          `[Engine Evaluation] Result: ${data.passed ? 'PASSED (Rule armed)' : 'FAILED / INACTIVE'}`,
          `[Message] ${data.message || 'No additional details'}`
        ];
        setSimulationLog(logs);
        return;
      }
    } catch {
      // Offline fallback: evaluate locally
    }

    const trigs = activeRule.triggers || [];
    const conds = activeRule.conditions || [];
    const acts = activeRule.actions || [];
    const logs = [
      `[Local Evaluator] Rule: "${activeRule.name}"`,
      `[Trigger Engine] Monitoring ${trigs.length} trigger pattern(s)...`
    ];

    let allCondsPass = true;
    conds.forEach((cond, idx) => {
      const res = evaluateConditionState(cond, liveFrames, entityStates, lastFiredTriggerId, catalog, liveWifiStatus, liveBleMap);
      logs.push(`  [Condition #${idx + 1}] ${res.state.toUpperCase()}: ${res.reason || ''}`);
      if (res.state === 'invalid') allCondsPass = false;
    });

    if (allCondsPass) {
      logs.push(`[Condition Evaluator] ALL PASS: Rule conditions satisfied for ${acts.length} action(s).`);
    } else {
      logs.push(`[Condition Evaluator] CONDITIONS FAILED: Rule actions will NOT fire.`);
    }

    logs.push(`[Status] Cooldown configured for ${activeRule.cooldown_ms || 0}ms.`);
    setSimulationLog(logs);
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
    <AutomationClipboardContext.Provider value={{ clipboard, copyToClipboard, clearClipboard, pastePayload }}>
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
                    onShowTraces={() => handleSimulateRuleFor(activeRule)}
                    onMoreInfo={() => setMoreInfoRule(activeRule)}
                    onEditSettings={() => setEditingSettingsRule(activeRule)}
                    onEditCategory={() => setEditingCategoryRule(activeRule)}
                  />
                </div>
              </div>

              {/* Automation Properties Bar */}
              <div className="pt-2 border-t border-separator grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">

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

                <div className="flex flex-col justify-end">
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
                        const stableKey = trig._clientId || (trig._clientId = `trig_client_${tIdx}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
                        return (
                          <TriggerNodeEditor
                            key={stableKey}
                            trig={trig}
                            tIdx={tIdx}
                            catalog={catalog}
                            liveWifiStatus={liveWifiStatus}
                            liveBleMap={liveBleMap}
                            onUpdate={updated => {
                              const next = [...activeRule.triggers];
                              next[tIdx] = { ...updated, _clientId: stableKey };
                              handleUpdateActiveRule({ triggers: next });
                            }}
                            onDelete={() => {
                              const next = activeRule.triggers.filter((_, i) => i !== tIdx);
                              handleUpdateActiveRule({ triggers: next });
                            }}
                            onDuplicate={() => {
                              const dup = regenerateTriggerIds(trig);
                              const next = [...activeRule.triggers];
                              next.splice(tIdx + 1, 0, dup);
                              handleUpdateActiveRule({ triggers: next });
                            }}
                            onMoveUp={tIdx > 0 ? () => {
                              const next = [...activeRule.triggers];
                              const temp = next[tIdx];
                              next[tIdx] = next[tIdx - 1];
                              next[tIdx - 1] = temp;
                              handleUpdateActiveRule({ triggers: next });
                            } : undefined}
                            onMoveDown={tIdx < activeRule.triggers.length - 1 ? () => {
                              const next = [...activeRule.triggers];
                              const temp = next[tIdx];
                              next[tIdx] = next[tIdx + 1];
                              next[tIdx + 1] = temp;
                              handleUpdateActiveRule({ triggers: next });
                            } : undefined}
                            isFirst={tIdx === 0}
                            isLast={tIdx === activeRule.triggers.length - 1}
                          />
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onPress={() =>
                        openAddTriggerDialog(newTrig =>
                          handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] })
                        )
                      }
                      className="ha-section-add-btn accent-trig"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add Trigger</span>
                    </Button>

                    {clipboard?.type === 'trigger' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onPress={() => {
                          const pasted = pastePayload('trigger');
                          if (pasted) {
                            handleUpdateActiveRule({ triggers: [...activeRule.triggers, pasted] });
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-warning-soft hover:opacity-90 text-warning-soft-foreground border border-warning/40 transition cursor-pointer"
                        aria-label={`Paste copied trigger "${clipboard.label}"`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-warning" />
                        <span>Paste Trigger ({clipboard.label})</span>
                      </Button>
                    )}

                    {clipboard?.type === 'condition' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onPress={() => {
                          const pasted = pastePayload('trigger');
                          if (pasted) {
                            handleUpdateActiveRule({ triggers: [...activeRule.triggers, pasted] });
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent-soft hover:opacity-90 text-accent-soft-foreground border border-accent/40 transition cursor-pointer"
                        aria-label={`Convert & paste copied condition "${clipboard.label}" as trigger`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-accent" />
                        <span>Paste as Trigger ({clipboard.label})</span>
                      </Button>
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
                  onClick={() => setActionTestToast(null)}
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
                      liveFrames,
                      entityStates,
                      lastFiredTriggerId,
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
                  <span className="text-[11px] text-muted hidden sm:inline">
                    Evaluated before actions run
                  </span>
                </div>
              </div>

              {!collapsedConditions && (
                <ConditionListEditor
                  conditions={activeRule.conditions}
                  depth={0}
                  availableTriggers={activeRule.triggers}
                  catalog={catalog}
                  liveFrames={liveFrames}
                  entityStates={entityStates}
                  lastFiredTriggerId={lastFiredTriggerId}
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
                <span className="text-[11px] text-muted">
                  Executed in sequence when triggers &amp; conditions match
                </span>
              </div>

              {!collapsedActions && (
                <ActionListEditor
                  actions={activeRule.actions}
                  depth={0}
                  availableTriggers={activeRule.triggers}
                  catalog={catalog}
                  liveFrames={liveFrames}
                  entityStates={entityStates}
                  lastFiredTriggerId={lastFiredTriggerId}
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
                <div className="flex flex-wrap items-center justify-start gap-1.5 pt-2 border-t border-separator">
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
                    onPress={handleSimulateRule}
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
              <div className="flex items-center justify-between gap-2 flex-wrap bg-surface-secondary -m-1 p-2 rounded-xl border border-border">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-accent">
                    Select Mode
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedRuleIdsForDelete.size === rules.length) {
                        setSelectedRuleIdsForDelete(new Set());
                      } else {
                        setSelectedRuleIdsForDelete(new Set(rules.map(r => r.id)));
                      }
                    }}
                    className="text-[11px] text-muted hover:text-accent transition underline underline-offset-2"
                  >
                    {selectedRuleIdsForDelete.size === rules.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {selectedRuleIdsForDelete.size > 0 && (
                    <Button
                      variant="danger"
                      size="sm"
                      onPress={handleBatchDelete}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-danger hover:bg-danger-hover text-danger-foreground transition shadow-sm animate-pulse"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete ({selectedRuleIdsForDelete.size})</span>
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      setIsSelectMode(false);
                      setSelectedRuleIdsForDelete(new Set());
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-surface-tertiary hover:bg-default-hover text-foreground border border-border transition"
                  >
                    <span>Done</span>
                  </Button>
                </div>
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
                      value={espIp}
                      onChange={e => setEspIp(e.target.value)}
                      placeholder={getDefaultEspIp()}
                      title="Device IP address or hostname"
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
                <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-separator animate-in fade-in">
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

            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {rules.map((rule, idx) => (
                <SwipeableRuleItem
                  key={rule.id}
                  rule={rule}
                  idx={idx}
                  isSelected={rule.id === activeRule?.id}
                  isSelectMode={isSelectMode}
                  isCheckedForDelete={selectedRuleIdsForDelete.has(rule.id)}
                  onToggleCheck={handleToggleCheckForDelete}
                  onSelect={setSelectedRuleId}
                  onDuplicate={handleDuplicateRule}
                  onDelete={handleDeleteRule}
                  onToggleEnabled={(id, enabled) => handleUpdateRule(id, { enabled })}
                  onRunActions={handleRunAllRuleActions}
                  onShowTraces={handleSimulateRuleFor}
                  onMoreInfo={(r) => setMoreInfoRule(r)}
                  onEditSettings={(r) => setEditingSettingsRule(r)}
                  onEditCategory={(r) => setEditingCategoryRule(r)}
                />
              ))}
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
            const existing = rules.find(r => r.id === newRule.id);
            const ruleToInstall = existing
              ? { ...newRule, id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}` }
              : newRule;
            onUpdateRules([ruleToInstall, ...rules]);
            setSelectedRuleId(ruleToInstall.id);
          }}
          onClose={() => setShowCommunityModal(false)}
        />
      )}

      {/* MODAL: Import Automations */}
      {showImportModal && (
        <AutomationImportModal
          isOpen={showImportModal}
          existingRules={rules}
          onClose={() => setShowImportModal(false)}
          onImport={handleApplyImport}
        />
      )}

      {/* MODAL: Rule Dry Run / Simulation Log */}
      {showSimulateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-backdrop backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-xl bg-overlay text-overlay-foreground border border-border rounded-2xl shadow-overlay overflow-hidden flex flex-col">
            <div className="p-4 border-b border-separator bg-surface flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-accent-soft text-accent flex items-center justify-center">
                  <Play className="w-4 h-4 fill-current" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">Rule Simulation Dry-Run</h3>
                  <p className="text-[11px] text-muted">
                    Emulating ESP32 reactive rule evaluation pipeline
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                onPress={() => setShowSimulateModal(false)}
                className="text-muted hover:text-foreground p-1 rounded-lg hover:bg-default-hover"
                aria-label="Close simulation modal"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="p-4 bg-surface-secondary font-mono text-xs text-success space-y-1 max-h-80 overflow-y-auto leading-relaxed select-text">
              {simulationLog.map((line, idx) => (
                <div key={idx} className={line.startsWith('[Sim Ingress]') ? 'text-warning' : line.startsWith('  ->') ? 'text-accent pl-2' : ''}>
                  {line}
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-separator bg-surface flex items-center justify-end">
              <Button
                variant="secondary"
                size="sm"
                onPress={() => setShowSimulateModal(false)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-default-hover text-foreground border border-border transition"
              >
                Close Log
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Automation More Info */}
      <AutomationMoreInfoModal
        rule={moreInfoRule}
        isOpen={Boolean(moreInfoRule)}
        onClose={() => setMoreInfoRule(null)}
        onToggleEnabled={(id, enabled) => handleUpdateRule(id, { enabled })}
        onRunActions={handleRunAllRuleActions}
        onShowTraces={handleSimulateRuleFor}
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
    </div>
    </AutomationClipboardContext.Provider>
  );
};
