import React, { useState, useRef, useCallback, useContext, createContext } from 'react';
import mqtt from 'mqtt';
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
  ClipboardCheck
} from 'lucide-react';
import { AddElementModal, AddElementTarget } from './AddElementModal';
import { CommunityAutomationsModal } from './CommunityAutomationsModal';
import { AutomationImportModal } from './AutomationImportModal';

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
  const [isJsonInspectorOpen, setIsJsonInspectorOpen] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addElementTarget, setAddElementTarget] = useState<AddElementTarget | null>(null);
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [showCommunityModal, setShowCommunityModal] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  const [espIp, setEspIp] = useState<string>(() => getDefaultEspIp());
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [communityModalTab, setCommunityModalTab] = useState<'browse' | 'share'>('browse');
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

      // Flow 7: Resolve Command & Option Details from Catalog if available
      const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForAction(act, catalog) : { command: undefined, matchedOption: undefined };
      
      const targetCanId = act.can_id || catalogCmd?.network?.action_can_id || catalogCmd?.action_can_id || catalogCmd?.network?.state_can_id || catalogCmd?.state_can_id;
      const targetEntityId = act.entity_id || catalogCmd?.id;
      const targetCommand = act.command || act.option_label || matchedOption?.label || (catalogCmd?.options && catalogCmd.options[0]?.label);
      const rawPayload = act.payload || matchedOption?.payload || (matchedOption?.steps && matchedOption.steps[0]?.payload) || catalogCmd?.payload;
      const { str: cleanPayloadStr, obj: cleanPayloadObj } = formatPayloadForApi(rawPayload);
      const targetRepeat = act.repeat || matchedOption?.repeat || (matchedOption?.steps && matchedOption.steps[0]?.repeat) || 1;
      const targetDelay = act.delay_ms || (matchedOption?.steps && matchedOption.steps[0]?.delay_ms) || catalogCmd?.network?.delay_ms || catalogCmd?.delay_ms || 20;
      const targetBus = act.bus ?? catalogCmd?.network?.bus ?? catalogCmd?.action_bus ?? 0;
      const normBus = typeof targetBus === 'string' && !isNaN(Number(targetBus)) ? Number(targetBus) : targetBus;
      const targetSteps = act.steps || matchedOption?.steps;

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

      // Flow 10: Multi-Step Action Execution (e.g. ambient lighting burst + latch commit, seat comfort 2-stage)
      if (targetSteps && targetSteps.length > 1) {
        for (let sIdx = 0; sIdx < targetSteps.length; sIdx++) {
          const stepItem = targetSteps[sIdx];
          const { str: sStr } = formatPayloadForApi(stepItem.payload);
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
          message: `Action tested: Transmitted sequence (${targetSteps.length} steps) on ${targetCanId || 'CAN'}`,
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

      // Flow: Cycle Entity State Stepper
      if (act.type === 'cycle_entity') {
        const entId = act.entity_id || act.target_command_id || 'seat_heater_driver';
        const states = act.states && act.states.length > 0 ? act.states : ['off', 'low', 'medium', 'high'];
        const curState = entityStates.get(entId.toLowerCase()) || act.fallback_state || states[0];
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
        setActionTestToast({
          message: `Cycle ${entId}: ${curState} ➔ ${nextState} (${dir}, wrap=${act.wrap !== false})`,
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

  const handleCopyJson = () => {
    const textToCopy = exportToCandoJson(rules, settings, catalog);
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
            <div className="p-2.5 sm:p-3.5 rounded-xl bg-slate-900 border border-slate-800 shadow-sm space-y-3 min-w-0 overflow-hidden">
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      activeRule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                    }`}
                  />
                  <input
                    type="text"
                    value={activeRule.name}
                    onChange={e => handleUpdateActiveRule({ name: e.target.value })}
                    placeholder="Automation Name"
                    className="bg-transparent text-sm font-bold text-white focus:outline-none focus:ring-1 focus:ring-cyan-500/50 rounded px-1.5 py-0.5 w-full min-w-0 truncate"
                  />
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => { setCommunityModalTab('share'); setShowCommunityModal(true); }}
                    title="Share or contribute to Community Automations"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    <Share2 className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="hidden sm:inline">Share</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUpdateActiveRule({ enabled: !activeRule.enabled })}
                    className={`px-2 py-1 rounded-lg text-xs font-semibold border transition ${
                      activeRule.enabled
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {activeRule.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicateRule(activeRule)}
                    title="Duplicate active rule"
                    className="p-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    <Copy className="w-3.5 h-3.5 text-cyan-400" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteRule(activeRule.id)}
                    title="Delete active rule"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition active:scale-95"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                    <span className="hidden sm:inline">Delete</span>
                  </button>
                </div>
              </div>

              {/* Automation Properties Bar */}
              <div className="pt-2 border-t border-slate-800/80 grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">

                <div>
                  <label className="block text-[10px] font-medium text-slate-400 mb-1">Cooldown (ms)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={activeRule.cooldown_ms !== undefined ? activeRule.cooldown_ms : 0}
                    onChange={e => handleUpdateActiveRule({ cooldown_ms: parseInt(e.target.value) || 0 })}
                    placeholder="0"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-medium text-slate-400 mb-1">Home Assistant Icon</label>
                  <input
                    type="text"
                    value={activeRule.ha_icon || ''}
                    onChange={e => handleUpdateActiveRule({ ha_icon: e.target.value })}
                    placeholder="mdi:car-cog"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex flex-col justify-end">
                  <label className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-950 border border-slate-800/90 cursor-pointer hover:border-slate-700 transition">
                    <input
                      type="checkbox"
                      checked={activeRule.ha_expose ?? true}
                      onChange={e => handleUpdateActiveRule({ ha_expose: e.target.checked })}
                      className="rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-0 w-3.5 h-3.5"
                    />
                    <span className="text-[11px] font-medium text-slate-300">Expose to HA</span>
                  </label>
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
                    className="text-slate-400 hover:text-white transition p-0.5"
                    title={collapsedTriggers ? "Expand triggers" : "Collapse triggers"}
                  >
                    {collapsedTriggers ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <span className="p-1 rounded-lg bg-amber-500/20 text-amber-400">
                    <Zap className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Triggers
                  </span>

                  </div>
              </div>

              {!collapsedTriggers && (
                <>
                  {activeRule.triggers.length === 0 ? (
                    <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500 italic">
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
                    <button
                      type="button"
                      onClick={() =>
                        openAddTriggerDialog(newTrig =>
                          handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] })
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
                          const pasted = pastePayload('trigger');
                          if (pasted) {
                            handleUpdateActiveRule({ triggers: [...activeRule.triggers, pasted] });
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-950/60 hover:bg-amber-900/60 text-amber-200 border border-amber-700/60 transition cursor-pointer"
                        title={`Paste copied trigger "${clipboard.label}"`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-amber-300" />
                        <span>Paste Trigger ({clipboard.label})</span>
                      </button>
                    )}

                    {clipboard?.type === 'condition' && (
                      <button
                        type="button"
                        onClick={() => {
                          const pasted = pastePayload('trigger');
                          if (pasted) {
                            handleUpdateActiveRule({ triggers: [...activeRule.triggers, pasted] });
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-950/50 hover:bg-sky-900/50 text-sky-200 border border-sky-700/60 transition cursor-pointer"
                        title={`Convert & paste copied condition "${clipboard.label}" as trigger`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-sky-300" />
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
                className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border text-xs font-medium shadow-lg animate-in fade-in slide-in-from-top-2 duration-200 ${
                  actionTestToast.type === 'success'
                    ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-300 shadow-emerald-950/50'
                    : actionTestToast.type === 'error'
                    ? 'bg-rose-950/90 border-rose-500/40 text-rose-300 shadow-rose-950/50'
                    : 'bg-sky-950/90 border-sky-500/40 text-sky-300 shadow-sky-950/50'
                }`}
              >
                <span>{actionTestToast.message}</span>
                <button
                  type="button"
                  onClick={() => setActionTestToast(null)}
                  className="p-1 hover:bg-white/10 rounded transition text-slate-400 hover:text-white"
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
                    className="text-slate-400 hover:text-white transition p-0.5"
                    title={collapsedConditions ? "Expand conditions" : "Collapse conditions"}
                  >
                    {collapsedConditions ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <span className="p-1 rounded-lg bg-sky-500/20 text-sky-400">
                    <Shield className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Conditions
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Real-time Overall Gate Status Badge */}
                  {(() => {
                    const conds = activeRule.conditions || [];
                    if (conds.length === 0) {
                      return (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                          <Check className="w-3 h-3 text-emerald-400" />
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
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/20"
                          title="All conditions currently evaluate as TRUE based on live CAN bus/entity state"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span>Gate Open: Valid</span>
                        </span>
                      );
                    }
                    if (gateEval.state === 'invalid') {
                      return (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm shadow-rose-500/20"
                          title={gateEval.reason || "Conditions currently block execution"}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                          <X className="w-3 h-3 text-rose-400" />
                          <span>Gate Closed: Blocked</span>
                        </span>
                      );
                    }
                    return (
                      <span
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700"
                        title={gateEval.reason || "Waiting for live frame or state telemetry"}
                      >
                        <HelpCircle className="w-3 h-3 text-slate-400" />
                        <span>Gate State: Unknown</span>
                      </span>
                    );
                  })()}
                  <span className="text-[11px] text-slate-400 hidden sm:inline">
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
                    className="text-slate-400 hover:text-white transition p-0.5"
                    title={collapsedActions ? "Expand actions" : "Collapse actions"}
                  >
                    {collapsedActions ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <span className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400">
                    <Send className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Actions
                  </span>
                </div>
                <span className="text-[11px] text-slate-400">
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
          <div className="order-2 lg:order-1 lg:col-span-8 flex items-center justify-center p-12 rounded-2xl bg-slate-900 border border-slate-800 text-slate-500 text-sm">
            Select or create an automation rule to start editing.
          </div>
        )}

        {/* Right Column: Automations List & JSON Inspector (contents on mobile, 4 cols sidebar on desktop) */}
        <div className="contents lg:block lg:order-2 lg:col-span-4 lg:space-y-4">
          {/* Card 1: Automations List (Appears at top on single-column mobile) */}
          <div className="order-1 lg:order-none p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
            {!isSelectMode ? (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Automations ({rules.length})
                </span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => { setCommunityModalTab('browse'); setShowCommunityModal(true); }}
                    title="Explore Community Automations"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-gradient-to-r from-amber-500/20 to-cyan-500/20 text-amber-300 hover:from-amber-500/30 hover:to-cyan-500/30 border border-amber-500/30 transition shadow-sm"
                  >
                    <Sparkles className="w-3 h-3 text-amber-400" />
                    <span>Community</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsSelectMode(true);
                      setSelectedRuleIdsForDelete(new Set());
                    }}
                    title="Select automations to delete"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    <CheckSquare className="w-3 h-3 text-cyan-400" />
                    <span>Select</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSimulateRule}
                    title="Dry run active rule simulation"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700 transition"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>Dry Run</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowImportModal(true)}
                    title="Import automations from file or paste JSON"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    <Upload className="w-3 h-3 text-cyan-400" />
                    <span>Import</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadJson}
                    title="Export and download automations.json"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    <Download className="w-3 h-3 text-cyan-400" />
                    <span>Export</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleAddRule}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/40 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>New</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 flex-wrap bg-slate-950/80 -m-1 p-2 rounded-xl border border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-cyan-300">
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
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition underline underline-offset-2"
                  >
                    {selectedRuleIdsForDelete.size === rules.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {selectedRuleIdsForDelete.size > 0 && (
                    <button
                      type="button"
                      onClick={handleBatchDelete}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition shadow-sm animate-pulse"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete ({selectedRuleIdsForDelete.size})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setIsSelectMode(false);
                      setSelectedRuleIdsForDelete(new Set());
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                  >
                    <span>Done</span>
                  </button>
                </div>
              </div>
            )}

            {/* Device Sync Toolbar */}
            <div className="p-2 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-1.5">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <select
                    value={useMqttSync ? 'mqtt' : 'rest'}
                    onChange={e => setUseMqttSync(e.target.value === 'mqtt')}
                    className="px-1.5 py-1 text-[10px] font-mono rounded-lg bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
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
                      className="min-w-0 flex-1 px-2 py-0.5 text-xs font-mono rounded-lg bg-slate-900 border border-slate-700 text-cyan-300 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                    />
                  ) : (
                    <span className="text-[11px] font-mono text-slate-400 truncate flex-1">
                      {mqttRemoteConfig.deviceId || 'mqtt-device'}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handlePullFromEsp}
                    title="Pull automations from vehicle device"
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition disabled:opacity-50"
                  >
                    <ArrowDown className="w-3 h-3 text-cyan-400" />
                    <span>Pull</span>
                  </button>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handlePushToEsp}
                    title={hasUnpushedChanges ? "Unpushed changes - click to push to vehicle" : "Automations in sync with vehicle"}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg transition disabled:opacity-50 shadow-sm ${
                      hasUnpushedChanges
                        ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 ring-2 ring-amber-400/50 shadow-amber-500/20'
                        : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950'
                    }`}
                  >
                    <ArrowUp className="w-3 h-3" />
                    <span>{hasUnpushedChanges ? 'Push *' : 'Push'}</span>
                  </button>
                </div>
              </div>

              {/* MQTT Expanded Credentials if in MQTT mode */}
              {useMqttSync && (
                <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-slate-800/80 animate-in fade-in">
                  <input
                    type="text"
                    value={mqttRemoteConfig.wsUrl}
                    onChange={e => updateMqttConfig({ wsUrl: e.target.value })}
                    placeholder="wss://broker:port"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                    title="Broker WS URL (Must be wss:// if on HTTPS domain)"
                  />
                  <input
                    type="text"
                    value={mqttRemoteConfig.deviceId}
                    onChange={e => updateMqttConfig({ deviceId: e.target.value })}
                    placeholder="Device ID (e.g. my_device)"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                  <input
                    type="text"
                    value={mqttRemoteConfig.user}
                    onChange={e => updateMqttConfig({ user: e.target.value })}
                    placeholder="Username (optional)"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                  <input
                    type="password"
                    value={mqttRemoteConfig.pass}
                    onChange={e => updateMqttConfig({ pass: e.target.value })}
                    placeholder="Password (optional)"
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
              )}

              {syncStatus && (
                <div className="text-[10px] font-mono text-cyan-300 bg-cyan-950/50 border border-cyan-800/60 rounded-md px-2 py-0.5 flex items-center justify-between">
                  <span className="truncate">{syncStatus}</span>
                  {syncing && <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin flex-shrink-0 ml-1" />}
                </div>
              )}
            </div>

            <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
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
                />
              ))}
            </div>

            {/* Mobile swipe hint */}
            {!isSelectMode && rules.length > 0 && (
              <p className="text-[10px] text-slate-500 text-center pt-1 block sm:hidden">
                Swipe left to delete · Swipe right to duplicate
              </p>
            )}
          </div>

          {/* Card 2: Collapsible JSON Inspector & Export (Compact, order-3 on single-column) */}
          <div className="order-3 lg:order-none rounded-2xl bg-slate-900 border border-slate-800 shadow-lg overflow-hidden transition-all">
            <div className="flex items-center justify-between gap-2 p-3 bg-slate-950/60 border-b border-slate-800/80">
              <button
                type="button"
                onClick={() => setIsJsonInspectorOpen(!isJsonInspectorOpen)}
                className="flex items-center gap-2 text-left flex-1 min-w-0 group"
              >
                <FileJson className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                <span className="text-xs font-bold text-slate-200 group-hover:text-white transition truncate">
                  automations.json
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 flex-shrink-0">
                  {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
                </span>
                {isJsonInspectorOpen ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400 group-hover:text-white transition ml-auto" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-hover:text-white transition ml-auto" />
                )}
              </button>

              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={handleCopyJson}
                  title="Copy automations.json to clipboard"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition border border-slate-700"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 text-cyan-400" />
                      <span>Copy</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadJson}
                  title="Download automations.json file"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition border border-slate-700"
                >
                  <Download className="w-3 h-3 text-cyan-400" />
                  <span className="hidden sm:inline">Download</span>
                </button>
              </div>
            </div>

            {isJsonInspectorOpen && (
              <div className="p-3 space-y-2 animate-in fade-in">
                <div className="relative h-[220px] max-h-[220px] overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
                  <pre className="w-full h-full p-2.5 font-mono text-[11px] text-slate-300 overflow-auto leading-relaxed select-text">
                    <code>{exportToCandoJson(rules, settings, catalog)}</code>
                  </pre>
                </div>
                <div className="text-[11px] text-slate-400 flex items-center justify-between">
                  <span>Ready for ESP32 / LittleFS storage</span>
                  <button
                    type="button"
                    onClick={handleDownloadJson}
                    className="text-cyan-400 hover:underline font-semibold"
                  >
                    Download .json file
                  </button>
                </div>
              </div>
            )}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                  <Play className="w-4 h-4 fill-current" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Rule Simulation Dry-Run</h3>
                  <p className="text-[11px] text-slate-400">
                    Emulating ESP32 reactive rule evaluation pipeline
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSimulateModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-slate-950 font-mono text-xs text-emerald-400 space-y-1 max-h-80 overflow-y-auto leading-relaxed select-text">
              {simulationLog.map((line, idx) => (
                <div key={idx} className={line.startsWith('[Sim Ingress]') ? 'text-yellow-300' : line.startsWith('  ->') ? 'text-cyan-300 pl-2' : ''}>
                  {line}
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900/80 flex items-center justify-end">
              <button
                type="button"
                onClick={() => setShowSimulateModal(false)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
              >
                Close Log
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Clipboard Indicator */}
      {clipboard && (
        <div className="fixed bottom-5 right-5 z-40 max-w-sm flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-slate-900/95 border border-cyan-500/40 shadow-2xl backdrop-blur-md text-xs animate-in fade-in slide-in-from-bottom-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 shrink-0">
            <ClipboardCheck className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
              Clipboard ({clipboard.type})
            </div>
            <div className="text-white font-medium truncate" title={clipboard.label}>
              {clipboard.label}
            </div>
          </div>
          <button
            type="button"
            onClick={clearClipboard}
            className="p-1 text-slate-400 hover:text-rose-400 rounded transition shrink-0"
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
