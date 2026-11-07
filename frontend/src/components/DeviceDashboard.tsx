import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Tabs, Switch, Button, ButtonGroup, Chip, Badge, Card, Alert, ProgressBar, Spinner, Slider } from '@heroui/react';
import { isRunningOnDevice, getDefaultDeviceHost, resolveDeviceBaseUrl } from '../utils/hostUtils';
import { deviceWs, DeviceWsMessage } from '../services/deviceWs';
import {
  Cpu,
  Wifi,
  Radio,
  Activity,
  RefreshCw,
  Play,
  Pause,
  Trash2,
  Upload,
  Download,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Sliders,
  Layers,
  Search,
  ArrowDownToLine,
  ArrowUpFromLine,
  Shield,
  ShieldAlert,
  Server,
  Zap,
  Globe,
  Settings2,
  Copy,
  Check,
  Plus,
  ExternalLink,
  Car,
  Clock,
  HardDrive,
  Filter,
  FileCode,
  Signal,
  SignalHigh,
  SignalMedium,
  SignalLow,
  SignalZero,
  Lock,
  Unlock,
  Info,
  Bluetooth,
  Sparkles,
  Bell,
  Battery,
  Moon,
  RotateCcw
} from 'lucide-react';
import { Catalog, Command } from '../types/catalog';
import { AutomationRule, AutomationTrigger } from '../types/automation';
import { UserPreferences, getUserPreferences, saveUserPreferences, DEFAULT_USER_PREFERENCES, UpdatePolicy } from '../types/settings';
import { checkForUpdates, executeUpdateSequence, UpdateCheckResult, UpdateStage } from '../services/updateService';
import { MdiIcon } from './MdiIcon';
import { BluetoothManager } from './BluetoothManager';
import { DeviceRebootModal } from './DeviceRebootModal';
import { STANDARD_TIMEZONES, detectBrowserTimezone, getTimezoneLabel } from '../utils/timezone';

export interface SystemStatus {
  device?: string;
  device_id: string;
  automations_enabled: boolean;
  sniffer_mode: boolean;
  hardware_listen_only: boolean;
  gvret_clients: number;
  twai_state: string;
  tx_error_counter: number;
  rx_error_counter: number;
  rx_missed_count: number;
  rx_overrun_count: number;
  bus_error_count: number;
  can_do_version?: string;
  free_heap?: number;
  uptime_sec?: number;
  time_synced?: boolean;
  system_time?: string;
  epoch_time?: number;
  ntp_server?: string;
  timezone?: string;
}

export interface WifiStatus {
  sta_connected: boolean;
  sta_ssid: string;
  sta_ip: string;
  sta_gw: string;
  sta_mask: string;
  sta_rssi: number;
  ap_active: boolean;
  ap_ssid: string;
  ap_ip: string;
  ap_clients: number;
  ap_mode: number;
}

export interface KnownNetwork {
  ssid: string;
  password?: string;
  priority: number;
}

export interface WifiScanResult {
  ssid: string;
  rssi: number;
  authmode: number;
  in_known_list: boolean;
}

export interface CanFrame {
  id: string;
  dlc: number;
  data: string;
  previousData?: string;
  count: number;
  timestamp: string;
  lastIntervalMs?: number;
  lastSeen: number;
}

export interface MqttConfig {
  enabled: boolean;
  ha_discovery?: boolean;
  broker_url: string;
  username: string;
  has_password?: boolean;
  connected?: boolean;
}

export interface AutomationDiag {
  id: string;
  name: string;
  enabled: boolean;
  trigger_count?: number;
  last_fired?: string;
  conditions_met?: boolean;
  exec_mode?: string;
  cooldown_ms?: number;
  last_exec_ms?: number;
  last_exec_sec_ago?: number;
  triggers?: any[];
  conditions?: any[];
  all_conditions_passed?: boolean;
  actions?: any[];
}

export interface DeviceDashboardProps {
  catalog?: Catalog;
  automationRules?: AutomationRule[];
  preferences?: UserPreferences;
  onUpdatePreferences?: (prefs: Partial<UserPreferences>) => void;
  onRerunOnboarding?: () => void;
  onSyncAutomationsToDevice?: () => Promise<void>;
  onPullAutomationsFromDevice?: (silent?: boolean) => Promise<void>;
  onNavigateToCatalog?: (searchQuery?: string) => void;
  onNavigateToAutomations?: () => void;
  onCreateCommandFromCanId?: (canId: string, sampleData?: string) => void;
  onCreateAutomationFromFrame?: (canId: string, sampleData?: string) => void;
  onCreateAutomationWithTrigger?: (trigger: AutomationTrigger) => void;
}

const PRESET_ENDPOINTS = [
  { label: 'Auto (Current Host)', value: 'auto' },
  { label: 'CAN Do SoftAP (192.168.4.1)', value: 'http://192.168.4.1' }
];

export const DeviceDashboard: React.FC<DeviceDashboardProps> = ({
  catalog,
  automationRules = [],
  preferences,
  onUpdatePreferences,
  onRerunOnboarding,
  onSyncAutomationsToDevice,
  onPullAutomationsFromDevice,
  onNavigateToCatalog,
  onNavigateToAutomations,
  onCreateCommandFromCanId,
  onCreateAutomationFromFrame,
  onCreateAutomationWithTrigger
}) => {
  // Device endpoint config (persisted in localStorage)
  const [deviceHost, setDeviceHost] = useState<string>(() => {
    // When the frontend is served directly from the device, always use 'auto' so
    // it resolves to window.location.origin — the current STA or AP IP the page
    // was loaded from. This prevents stale IPs saved from a previous network from
    // breaking the connection when the device gets a new DHCP address.
    if (isRunningOnDevice()) {
      return 'auto';
    }
    const saved = localStorage.getItem('cando_device_host');
    if (saved && saved !== 'http://192.168.107.50' && saved !== '192.168.107.50') {
      return saved;
    }
    return getDefaultDeviceHost();
  });

  const getApiUrl = useCallback((endpoint: string) => {
    const base = resolveDeviceBaseUrl(deviceHost);
    return `${base}${endpoint}`;
  }, [deviceHost]);

  // Auto-pull automations if running directly on device
  const hasAutoPulled = useRef(false);
  useEffect(() => {
    if (isRunningOnDevice() && onPullAutomationsFromDevice && !hasAutoPulled.current) {
      hasAutoPulled.current = true;
      onPullAutomationsFromDevice(true).catch(() => {});
    }
  }, [onPullAutomationsFromDevice]);

  // Connection & Telemetry state
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [restConnected, setRestConnected] = useState<boolean>(false);
  const connected = wsConnected || restConnected;
  const [lastPingMs, setLastPingMs] = useState<number | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [wifi, setWifi] = useState<WifiStatus | null>(null);

  // Active tab state persisted in localStorage
  const [activeTab, setActiveTab] = useState<'automations' | 'mqtt' | 'wifi' | 'bluetooth' | 'ota'>(() => {
    try {
      const saved = localStorage.getItem('cando_device_active_tab');
      if (saved && ['automations', 'mqtt', 'wifi', 'bluetooth', 'ota'].includes(saved)) {
        return saved as 'automations' | 'mqtt' | 'wifi' | 'bluetooth' | 'ota';
      }
    } catch {}
    return 'automations';
  });
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    try {
      localStorage.setItem('cando_device_active_tab', activeTab);
    } catch {}
  }, [activeTab]);

  // Reboot Popup State
  const [isRebootModalOpen, setIsRebootModalOpen] = useState<boolean>(false);
  const [rebootModalInfo, setRebootModalInfo] = useState<{ title?: string; message?: string }>({});

  // Automations diag state
  const [automations, setAutomations] = useState<AutomationDiag[]>([]);
  const [automationsLoading, setAutomationsLoading] = useState<boolean>(false);
  const [actionNotice, setActionNotice] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isDeployingRules, setIsDeployingRules] = useState<boolean>(false);
  const [isPullingRules, setIsPullingRules] = useState<boolean>(false);

  // MQTT state
  const [mqttConfig, setMqttConfig] = useState<MqttConfig>({
    enabled: true,
    broker_url: 'mqtt://homeassistant.local:1883',
    username: '',
    has_password: false,
    connected: false
  });
  const [mqttLoading, setMqttLoading] = useState<boolean>(false);
  const [mqttSaving, setMqttSaving] = useState<boolean>(false);
  const [mqttPasswordInput, setMqttPasswordInput] = useState<string>('');
  const [mqttSaveStatus, setMqttSaveStatus] = useState<string>('');

  // Wi-Fi manager state
  const [networks, setNetworks] = useState<KnownNetwork[]>([]);
  const [scanResults, setScanResults] = useState<WifiScanResult[]>([]);
  const [scanning, setScanning] = useState<boolean>(false);
  const [newSsid, setNewSsid] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newPriority, setNewPriority] = useState<number>(50);

  // Background log buffer for Download .txt functionality
  const [logs, setLogs] = useState<string[]>([]);

  // OTA & Cloud Update state
  const [otaFile, setOtaFile] = useState<File | null>(null);
  const [otaUploading, setOtaUploading] = useState<boolean>(false);
  const [otaProgress, setOtaProgress] = useState<number>(0);
  const [otaStatus, setOtaStatus] = useState<string>('');

  // Staged Cloud Update state
  const [localPrefs, setLocalPrefs] = useState<UserPreferences>(() => preferences || getUserPreferences());
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState<boolean>(false);
  const [isExecutingUpdate, setIsExecutingUpdate] = useState<boolean>(false);
  const [updateStage, setUpdateStage] = useState<UpdateStage>('idle');
  const [updateProgressPct, setUpdateProgressPct] = useState<number>(0);
  const [updateMessage, setUpdateMessage] = useState<string>('');

  const isAtomBridge = Boolean(status?.device && (status.device.toLowerCase().includes('atom') || status.device.toLowerCase().includes('bridge')));

  useEffect(() => {
    if (preferences) {
      setLocalPrefs(preferences);
    }
  }, [preferences]);

  const handleCheckForUpdates = async () => {
    setIsCheckingUpdate(true);
    try {
      let liveStatus = status;
      if (!liveStatus) {
        try {
          const stRes = await fetch(getApiUrl('/api/system/status'), { cache: 'no-cache' });
          if (stRes.ok) {
            liveStatus = await stRes.json();
            setStatus(liveStatus);
          }
        } catch {}
      }
      const currentFront = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ !== 'unknown') ? __APP_VERSION__ : (liveStatus?.can_do_version || catalog?.can_do_version || '');
      const currentFw = liveStatus?.can_do_version || '';
      const currentCat = catalog?.can_do_version || currentFront;
      const devName = (liveStatus?.device || '').toLowerCase();
      const targetDev = (devName.includes('atom') || devName.includes('bridge')) ? 'atom' : 'esp32c3';
      const res = await checkForUpdates(currentCat, currentFw, currentFront, targetDev);
      setUpdateResult(res);
      if (res.has_update) {
        showNotice(`Update available: ${res.release_name || res.version}`);
      } else {
        showNotice(`All components are up to date (${currentFw || currentFront || 'Current'})`);
      }
    } catch (e: any) {
      showNotice(`Failed to check updates: ${e.message || e}`, 'error');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  // Automatically check updates once when entering the Updates tab
  useEffect(() => {
    if (activeTab === 'ota' && !updateResult && !isCheckingUpdate) {
      handleCheckForUpdates();
    }
  }, [activeTab]);

  const handleInstallCloudUpdates = async () => {
    if (!updateResult) {
      showNotice('No update metadata loaded. Please click "Check for Updates" first.', 'info');
      return;
    }
    setIsExecutingUpdate(true);
    setUpdateProgressPct(10);
    setUpdateStage('checking');
    setUpdateMessage('Initiating update sequence...');

    try {
      const effectiveComponents = {
        ...localPrefs.update_components,
        firmware: localPrefs.update_components.firmware || Boolean(updateResult.components.firmware),
      };
      await executeUpdateSequence(
        deviceHost,
        effectiveComponents,
        updateResult,
        (stage, pct, msg) => {
          setUpdateStage(stage);
          setUpdateProgressPct(pct);
          setUpdateMessage(msg);
          if (stage === 'rebooting') {
            setRebootModalInfo({
              title: 'Updates Applied! Device Rebooting',
              message: 'Web front-end, catalog, and firmware updates have been installed to flash memory. Hardware is rebooting into the new image...'
            });
            setIsRebootModalOpen(true);
          }
        },
        isAtomBridge ? 'atom' : 'esp32c3'
      );
      setUpdateStage('complete');
      setUpdateProgressPct(100);
      setUpdateMessage('Updates completed successfully! Rebooting device...');
      showNotice('Updates applied successfully! Device is restarting...', 'success');
      // Trigger the reboot popup to guide the user through reconnection
      setRebootModalInfo({
        title: 'Updates Applied! Device Rebooting',
        message: 'All selected updates have been committed to flash memory. Hardware is restarting and reconnecting...'
      });
      setIsRebootModalOpen(true);
      fetchStatus();
      handleCheckForUpdates();
    } catch (e: any) {
      setUpdateStage('error');
      setUpdateMessage(`Update failed: ${e.message || e}`);
      showNotice(`Update error: ${e.message || e}`, 'error');
      await new Promise((r) => setTimeout(r, 4000));
    } finally {
      setIsExecutingUpdate(false);
    }
  };

  const handleManualReboot = async () => {
    if (!window.confirm('Are you sure you want to restart the CAN Do hardware processor?')) return;
    setRebootModalInfo({
      title: 'Manual Reboot Initiated',
      message: 'Reboot command sent to processor. Waiting for system re-initialization and Wi-Fi handshake...'
    });
    setIsRebootModalOpen(true);
    try {
      await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reboot: true }),
      });
    } catch (e: any) {
      console.warn('Reboot request sent (network disconnect expected as device powers cycles):', e);
    }
  };

  const handleSavePreferences = (updated: Partial<UserPreferences>) => {
    const next = saveUserPreferences(updated);
    setLocalPrefs(next);
    if (onUpdatePreferences) {
      onUpdatePreferences(updated);
    }
    showNotice('Update preferences saved');
  };

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);

  // Notice helper
  const showNotice = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setActionNotice({ message, type });
    setTimeout(() => setActionNotice(null), 4500);
  };

  // Helper: Normalize Hex ID
  const normalizeHexId = (raw: string): string => {
    if (!raw) return '';
    const clean = raw.trim().toLowerCase().replace(/^0x/, '');
    return `0x${clean.toUpperCase()}`;
  };



  // Resolve active WebSocket endpoint
  const currentWsUrl = useMemo(() => deviceWs.getWsUrl(), [deviceHost]);

  // Connect WebSocket via singleton service
  const connectWs = useCallback(() => {
    deviceWs.reconnect();
  }, []);

  // REST: Fetch system status & measure ping
  const fetchStatus = async () => {
    const start = performance.now();
    try {
      const res = await fetch(getApiUrl('/api/system/status'), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        setRestConnected(true);
        setLastPingMs(Math.round(performance.now() - start));
      } else {
        setRestConnected(false);
      }
    } catch {
      setRestConnected(false);
      setLastPingMs(null);
    }
  };

  // REST: Fetch Wi-Fi status
  const fetchWifi = async () => {
    try {
      const res = await fetch(getApiUrl('/api/wifi/status'));
      if (res.ok) {
        const data = await res.json();
        setWifi(data);
      }
    } catch {}
  };

  // REST: Fetch known networks
  const fetchNetworks = async () => {
    try {
      const res = await fetch(getApiUrl('/api/wifi/networks'));
      if (res.ok) {
        const data = await res.json();
        setNetworks(Array.isArray(data) ? data : (data?.networks || []));
      }
    } catch {
      setNetworks([]);
    }
  };

  // REST: Fetch automation diagnostics
  const fetchAutomationsDiag = async () => {
    setAutomationsLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/automations/diagnostics'));
      if (res.ok) {
        const data = await res.json();
        const rulesList = Array.isArray(data) ? data : (data?.rules || []);
        setAutomations(rulesList);
      }
    } catch {
      setAutomations([]);
    } finally {
      setAutomationsLoading(false);
    }
  };

  // REST: Fetch MQTT config & connection status
  const fetchMqtt = async () => {
    setMqttLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/mqtt'));
      if (res.ok) {
        const data = await res.json();
        setMqttConfig({
          enabled: data.enabled !== false,
          ha_discovery: data.ha_discovery === true,
          broker_url: data.broker_url || 'mqtt://homeassistant.local:1883',
          username: data.username || '',
          has_password: !!data.has_password,
          connected: !!data.connected
        });
      }
    } catch {
      // keep current state
    } finally {
      setMqttLoading(false);
    }
  };

  // REST: Save MQTT settings
  const handleSaveMqtt = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setMqttSaving(true);
    setMqttSaveStatus('Saving...');
    try {
      const payload: any = {
        enabled: mqttConfig.enabled,
        ha_discovery: !!mqttConfig.ha_discovery,
        broker_url: mqttConfig.broker_url.trim(),
        username: mqttConfig.username.trim()
      };
      if (mqttPasswordInput) {
        payload.password = mqttPasswordInput;
      } else if (mqttConfig.has_password) {
        payload.keep_password = true;
      }

      const res = await fetch(getApiUrl('/api/mqtt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setMqttPasswordInput('');
        setMqttSaveStatus('Saved successfully');
        showNotice('MQTT / Home Assistant settings saved', 'success');
        setTimeout(() => {
          fetchMqtt();
          setMqttSaveStatus('');
        }, 1500);
      } else {
        setMqttSaveStatus('Failed to save');
        showNotice('Failed to save MQTT settings', 'error');
      }
    } catch (err: any) {
      setMqttSaveStatus(`Error: ${err.message}`);
      showNotice(`Failed to save MQTT: ${err.message}`, 'error');
    } finally {
      setMqttSaving(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchWifi();

    const unsubscribeConn = deviceWs.onConnectionChange((conn) => {
      setWsConnected(conn);
      if (conn) {
        fetchStatus();
      }
    });

    const unsubscribeMsgs = deviceWs.subscribe((data, raw) => {
      if (data.type === 'log') {
        const line = (data.msg || raw || '').trim();
        if (line) {
          const formatted = `[${new Date().toLocaleTimeString()}] ${line}`;
          setLogs((prev) => [...prev.slice(-150), formatted]);
        }
      } else if (data.type === 'automation_fired') {
        showNotice(`Rule Fired: ${data.rule_id || data.id || 'Automation'}`, 'info');
        fetchAutomationsDiag();
      } else if (data.type === 'state' && data.entity === 'system_time') {
        setStatus((prev) => prev ? { ...prev, time_synced: true, system_time: String(data.state) } : prev);
      }
    });

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchStatus();
    }, 4000);

    return () => {
      clearInterval(interval);
      unsubscribeConn();
      unsubscribeMsgs();
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'automations') fetchAutomationsDiag();
    if (activeTab === 'mqtt') fetchMqtt();
    if (activeTab === 'wifi') {
      fetchWifi();
      fetchNetworks();
    }
  }, [activeTab]);

  // Controls: Master Automations Toggle
  const handleToggleAutomations = async (nextVal?: boolean) => {
    if (!status) return;
    const target = typeof nextVal === 'boolean' ? nextVal : !status.automations_enabled;
    try {
      const res = await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle_automations', automations_enabled: target })
      });
      if (res.ok) {
        fetchStatus();
        showNotice(`Automations Engine ${target ? 'ENABLED' : 'MUTED'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle automations: ${e.message}`, 'error');
    }
  };

  // Controls: Sniffer Mode Toggle
  const handleToggleSniffer = async (nextVal?: boolean) => {
    if (!status) return;
    const target = typeof nextVal === 'boolean' ? nextVal : !status.sniffer_mode;
    try {
      const res = await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle_sniffer', sniffer_mode: target })
      });
      if (res.ok) {
        fetchStatus();
        showNotice(`Passive Sniffer ${target ? 'ACTIVATED (All Tx Blocked)' : 'DEACTIVATED (Tx Enabled)'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle sniffer: ${e.message}`, 'error');
    }
  };

  // Controls: Hardware Listen Only
  const handleToggleListenOnly = async (nextVal?: boolean) => {
    if (!status) return;
    const target = typeof nextVal === 'boolean' ? nextVal : !status.hardware_listen_only;
    try {
      const res = await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_hardware_listen_only',
          enabled: target
        })
      });
      if (res.ok) {
        fetchStatus();
        showNotice(`Hardware Listen-Only Mode ${target ? 'ENABLED (Zero PHY ACKs)' : 'DISABLED'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle listen-only: ${e.message}`, 'error');
    }
  };

  // System: Sync Time & Timezone from Browser
  const handleSyncTime = async () => {
    try {
      const epoch = Math.floor(Date.now() / 1000);
      const tz = localPrefs.timezone || detectBrowserTimezone();
      const res = await fetch(getApiUrl('/api/system/time'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch, timezone: tz })
      });
      if (res.ok) {
        showNotice(`Device clock & timezone (${getTimezoneLabel(tz)}) synced`, 'success');
        fetchStatus();
      } else {
        showNotice('NTP is managed on device (update firmware for browser sync push)', 'info');
      }
    } catch (e: any) {
      showNotice(`Sync request failed: ${e.message}`, 'error');
    }
  };

  // Wi-Fi: Scan
  const handleScanWifi = async () => {
    setScanning(true);
    try {
      const res = await fetch(getApiUrl('/api/wifi/scan'));
      if (res.ok) {
        const data = await res.json();
        setScanResults(Array.isArray(data) ? data : (data?.results || data?.networks || []));
      }
    } catch (e: any) {
      showNotice(`Wi-Fi scan failed: ${e.message}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  // Wi-Fi: Add Network
  const handleAddNetwork = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSsid.trim()) return;
    try {
      const res = await fetch(getApiUrl('/api/wifi/networks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssid: newSsid.trim(),
          password: newPassword,
          priority: newPriority
        })
      });
      if (res.ok) {
        setNewSsid('');
        setNewPassword('');
        fetchNetworks();
        showNotice(`Saved roaming network '${newSsid}'`);
      }
    } catch (e: any) {
      showNotice(`Failed to save network: ${e.message}`, 'error');
    }
  };

  // Wi-Fi: Delete Network
  const handleDeleteNetwork = async (ssid: string) => {
    try {
      const res = await fetch(getApiUrl('/api/wifi/networks'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === 'ok') {
        setNetworks((prev) => (Array.isArray(prev) ? prev.filter((net) => net.ssid !== ssid) : []));
        fetchNetworks();
        showNotice(`Removed network '${ssid}'`);
      } else {
        showNotice(`Failed to remove network '${ssid}': ${data.message || data.status || 'Not found'}`, 'error');
      }
    } catch (e: any) {
      showNotice(`Failed to remove network: ${e.message}`, 'error');
    }
  };

  // OTA Upload
  const handleOtaUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otaFile) return;

    setOtaUploading(true);
    setOtaProgress(0);
    setOtaStatus('Uploading firmware binary...');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', getApiUrl('/api/ota'));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setOtaProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const respText = (xhr.responseText || '').trim();
        if (respText.startsWith('<') || respText.toLowerCase().includes('<!doctype') || respText.toLowerCase().includes('<html')) {
          setOtaStatus('Update failed: Device served web page instead of OTA handler. Flash firmware via USB to enable OTA.');
          showNotice('OTA upload failed: Device returned web page', 'error');
          setOtaUploading(false);
          return;
        }
        setOtaProgress(100);
        setOtaStatus('Firmware flashed successfully! Device is rebooting into the new image...');
        showNotice('Firmware flashed! Device rebooting in 5 seconds.', 'success');
        setOtaFile(null);
        setRebootModalInfo({
          title: 'Firmware Uploaded Successfully',
          message: 'The binary image was written to the OTA partition. Hardware is restarting into the new image...'
        });
        setIsRebootModalOpen(true);
      } else {
        setOtaStatus(`Update failed: ${xhr.responseText || xhr.statusText}`);
        showNotice('OTA upload failed', 'error');
      }
      setOtaUploading(false);
    };

    xhr.onerror = () => {
      setOtaStatus('Network error during OTA upload');
      setOtaUploading(false);
      showNotice('Network error during OTA upload', 'error');
    };

    xhr.send(otaFile);
  };

  // Deploy handler wrapper
  const handleDeploy = async () => {
    if (!onSyncAutomationsToDevice) return;
    setIsDeployingRules(true);
    try {
      await onSyncAutomationsToDevice();
      showNotice('Successfully deployed active automations to device storage');
      fetchAutomationsDiag();
    } catch {
      // Alert handled upstream
    } finally {
      setIsDeployingRules(false);
    }
  };

  // Pull handler wrapper
  const handlePull = async () => {
    if (!onPullAutomationsFromDevice) return;
    setIsPullingRules(true);
    try {
      await onPullAutomationsFromDevice();
      showNotice('Successfully loaded device automations into editor');
    } catch {
      // Alert handled upstream
    } finally {
      setIsPullingRules(false);
    }
  };



  // Format uptime
  const formatUptime = (sec?: number) => {
    if (sec === undefined || sec === null) return '--';
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h ${min % 60}m`;
  };

  // Format heap
  const formatHeap = (bytes?: number) => {
    if (!bytes) return '--';
    return `${Math.round(bytes / 1024)} KB free`;
  };

  // RSSI Icon helper
  const getSignalIcon = (rssi: number) => {
    if (rssi >= -60) return <SignalHigh className="w-3.5 h-3.5 text-emerald-400" />;
    if (rssi >= -75) return <SignalMedium className="w-3.5 h-3.5 text-cyan-400" />;
    if (rssi >= -85) return <SignalLow className="w-3.5 h-3.5 text-amber-400" />;
    return <SignalZero className="w-3.5 h-3.5 text-rose-400" />;
  };

  return (
    <div className="space-y-5 sm:space-y-6 max-w-7xl mx-auto min-w-0">
      {/* Top Device Status Bar & Target Host Controller */}
      <div className="can-do-card p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        {/* Device Identity & Connection state */}
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="h-11 w-11 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 flex items-center justify-center shrink-0 shadow-inner">
            <Radio className="w-6 h-6 animate-pulse" />
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base sm:text-lg font-bold text-[var(--text-heading)] tracking-tight">
                CAN Do Edge Engine
              </h1>
              <Badge
                size="sm"
                color={connected ? 'success' : 'danger'}
                variant="soft"
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  connected
                    ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/80'
                    : 'bg-rose-950/40 text-rose-300 border-rose-800/80'
                }`}
              >
                <span className={`status-dot mr-1 ${connected ? 'green' : 'red'}`} />
                <span>{connected ? (wsConnected ? 'ONLINE' : 'ONLINE (HTTP)') : 'OFFLINE'}</span>
              </Badge>
              {connected && (
                <Chip
                  size="sm"
                  color={wsConnected ? 'accent' : 'warning'}
                  variant="soft"
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                    wsConnected
                      ? 'bg-cyan-950/40 text-cyan-300 border-cyan-800/80'
                      : 'bg-amber-950/40 text-amber-300 border-amber-800/80'
                  }`}
                  title={wsConnected ? 'WebSocket live CAN/log stream active' : `Connecting WebSocket to ${currentWsUrl}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full mr-1 ${wsConnected ? 'bg-cyan-400 animate-pulse' : 'bg-amber-400 animate-ping'}`} />
                  {wsConnected ? 'WS Stream Active' : 'WS Connecting...'}
                </Chip>
              )}
              {lastPingMs !== null && (
                <Chip size="sm" variant="secondary" className="text-[11px] font-mono text-[var(--text-muted)]">
                  {lastPingMs}ms latency
                </Chip>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)] font-mono mt-1">
              <span>
                Node: <strong className="text-cyan-300 font-bold">{status?.device_id || 'esp32-node'}</strong>
              </span>
              <span>•</span>
              <span>Uptime: <strong className="text-[var(--text-heading)]">{formatUptime(status?.uptime_sec)}</strong></span>
              <span>•</span>
              <span>Heap: <strong className="text-[var(--text-heading)]">{formatHeap(status?.free_heap)}</strong></span>
              <span>•</span>
              <button
                type="button"
                onClick={handleSyncTime}
                className="inline-flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition group text-left"
                title={
                  status?.time_synced
                    ? `Synchronized (${status?.ntp_server || 'pool.ntp.org'})\nTimezone: ${getTimezoneLabel(status?.timezone || localPrefs.timezone)}\nEpoch: ${status?.epoch_time || 0}\nClick to re-sync from browser`
                    : (status?.time_synced === false
                      ? `NTP sync in progress\nTimezone: ${getTimezoneLabel(status?.timezone || localPrefs.timezone)}\nClick to force sync from browser`
                      : 'Firmware update required to read NTP state\nClick to sync from browser')
                }
              >
                <Clock className={`w-3.5 h-3.5 ${status?.time_synced ? 'text-emerald-400' : 'text-amber-400 animate-pulse'}`} />
                <span className={status?.time_synced ? 'text-[var(--text-heading)] group-hover:underline' : 'text-amber-300 font-semibold group-hover:underline'}>
                  {status?.time_synced ? (status?.system_time || 'NTP Synced') : (status?.time_synced === false ? 'NTP Pending' : 'Sync Clock')}
                </span>
              </button>
              {status?.gvret_clients !== undefined && status.gvret_clients > 0 && (
                <>
                  <span>•</span>
                  <Chip size="sm" color="warning" variant="soft" className="text-amber-300 bg-amber-950/40 border border-amber-800/80 text-[11px] font-mono">
                    GVRET TCP: {status.gvret_clients}
                  </Chip>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: Host Connection Config & Quick Sync Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Host Endpoint Selector */}
          <div className="flex items-center gap-1.5 bg-[var(--input-bg)] px-2 py-1 rounded-lg border border-[var(--border-color)]">
            <Globe className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
            <select
              value={
                deviceHost === 'auto' || deviceHost === (typeof window !== 'undefined' ? window.location.origin : '')
                  ? 'auto'
                  : PRESET_ENDPOINTS.some(p => p.value === deviceHost)
                  ? deviceHost
                  : 'custom'
              }
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'auto') {
                  setDeviceHost('auto');
                  localStorage.setItem('cando_device_host', 'auto');
                } else if (val !== 'custom') {
                  setDeviceHost(val);
                  localStorage.setItem('cando_device_host', val);
                }
              }}
              className="bg-transparent text-xs font-mono text-[var(--text-heading)] focus:outline-none cursor-pointer pr-1"
              title="Quick select device endpoint"
            >
              <option value="auto" className="bg-slate-900 text-slate-100">Auto (Current Host)</option>
              <option value="http://192.168.4.1" className="bg-slate-900 text-slate-100">CAN Do SoftAP (192.168.4.1)</option>
              <option value="custom" className="bg-slate-900 text-slate-100">Custom IP / URL...</option>
            </select>
          </div>

          {/* Custom Host Input */}
          <input
            type="text"
            value={deviceHost === 'auto' ? (typeof window !== 'undefined' ? window.location.origin : 'auto') : deviceHost}
            onChange={(e) => {
              setDeviceHost(e.target.value);
              localStorage.setItem('cando_device_host', e.target.value);
            }}
            placeholder="http://192.168.4.1"
            className="px-2.5 py-1 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] font-mono text-xs w-36 sm:w-44 focus:outline-none focus:border-[var(--md-sys-color-primary)] transition"
            title="Device IP or mDNS hostname"
          />

          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              connectWs();
              fetchStatus();
              fetchWifi();
            }}
            className="dash-outline-btn text-xs py-1 px-2.5 inline-flex items-center gap-1 text-[var(--text-heading)]"
            aria-label="Reconnect WebSocket & Poll Status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Connect</span>
          </Button>

          {/* Quick Deploy / Pull Buttons */}
          {(onSyncAutomationsToDevice || onPullAutomationsFromDevice) && (
            <ButtonGroup size="sm">
              {onSyncAutomationsToDevice && (
                <Button
                  variant="primary"
                  size="sm"
                  onPress={handleDeploy}
                  isDisabled={isDeployingRules}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold text-xs shadow transition"
                  aria-label="Push current local automations down to device LittleFS"
                >
                  <ArrowUpFromLine className={`w-3.5 h-3.5 ${isDeployingRules ? 'animate-bounce' : ''}`} />
                  <span>Deploy</span>
                </Button>
              )}
              {onPullAutomationsFromDevice && (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handlePull}
                  isDisabled={isPullingRules}
                  className="dash-outline-btn text-xs py-1.5 px-3 inline-flex items-center gap-1.5 text-slate-300 hover:text-white"
                  aria-label="Load automations saved on device into the web builder"
                >
                  <ArrowDownToLine className={`w-3.5 h-3.5 ${isPullingRules ? 'animate-bounce' : ''}`} />
                  <span className="hidden sm:inline">Pull</span>
                </Button>
              )}
            </ButtonGroup>
          )}

          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              const content = logs.length > 0
                ? logs.join('\n')
                : `[${new Date().toLocaleString()}] CAN Do Device ID: ${status?.device_id || 'unknown'}\nFirmware: ${status?.can_do_version || 'unknown'}\nWi-Fi IP: ${wifi?.sta_ip || 'N/A'}\n(No active log events captured in current session)`;
              const blob = new Blob([content], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `cando-logs-${Date.now()}.txt`;
              a.click();
              URL.revokeObjectURL(url);
              showNotice('Logs downloaded as .txt', 'info');
            }}
            className="dash-outline-btn text-xs py-1.5 px-2.5 inline-flex items-center gap-1 text-[var(--text-heading)] hover:text-cyan-300"
            aria-label="Download device session log as .txt"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Logs .txt</span>
          </Button>
        </div>
      </div>

      {/* Global Action Feedback Alert */}
      {actionNotice && (
        <Alert
          status={actionNotice.type === 'success' ? 'success' : actionNotice.type === 'error' ? 'danger' : 'accent'}
          className="p-3 rounded-xl border text-xs font-semibold flex items-center justify-between"
        >
          <Alert.Indicator />
          <Alert.Content className="flex items-center justify-between w-full">
            <Alert.Description>{actionNotice.message}</Alert.Description>
            <button
              type="button"
              onClick={() => setActionNotice(null)}
              className="text-slate-400 hover:text-white ml-3 text-xs"
            >
              ✕
            </button>
          </Alert.Content>
        </Alert>
      )}

      {/* Primary Metrics Deck (4 Cards) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* Metric 1: Automations Rule Engine */}
        <Card className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span>Automations Engine</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span
              className={`text-lg font-bold font-mono ${
                status?.automations_enabled ? 'text-emerald-400' : 'text-slate-500'
              }`}
            >
              {status?.automations_enabled ? 'ACTIVE' : 'MUTED'}
            </span>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              ({automations.length > 0 ? automations.length : automationRules.length} rules)
            </span>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center justify-between">
            <span>Edge evaluation loop</span>
            <Switch
              isSelected={status?.automations_enabled ?? false}
              onChange={handleToggleAutomations}
              size="sm"
              aria-label="Toggle Automations"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </Card>

        {/* Metric 2: TWAI CAN State */}
        <Card className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span>CAN Controller</span>
            <Activity className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-lg font-bold font-mono text-cyan-300 uppercase">
              {status?.twai_state || (connected ? 'RUNNING' : 'STOPPED')}
            </span>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 font-mono truncate">
            {status?.hardware_listen_only ? 'Stealth Listen-Only' : 'Normal PHY ACK'}
            {status?.bus_error_count ? ` • ${status.bus_error_count} errs` : ''}
          </div>
        </Card>

        {/* Metric 3: Wi-Fi Link */}
        <Card className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span>Wi-Fi Connection</span>
            <div className="flex items-center gap-1">
              {wifi?.sta_rssi ? getSignalIcon(wifi.sta_rssi) : <Wifi className="w-4 h-4 text-sky-400" />}
            </div>
          </div>
          <div className="mt-1">
            <div className="text-base font-bold text-[var(--text-heading)] truncate font-mono">
              {wifi?.sta_connected ? wifi.sta_ssid : (wifi?.ap_active ? 'CAN Do SoftAP' : 'No Link')}
            </div>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 font-mono truncate flex items-center gap-1.5">
            <span>{wifi?.sta_ip || wifi?.ap_ip || '192.168.4.1'}</span>
            {wifi?.sta_rssi ? (
              <Badge size="sm" variant="secondary" className="font-mono text-[10px]">
                {wifi.sta_rssi} dBm
              </Badge>
            ) : null}
          </div>
        </Card>

        {/* Metric 4: Passive Sniffer Protection */}
        <Card className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span>Bus Protection</span>
            <Shield className={`w-4 h-4 ${status?.sniffer_mode ? 'text-amber-400' : 'text-emerald-400'}`} />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span
              className={`text-lg font-bold font-mono ${
                status?.sniffer_mode ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {status?.sniffer_mode ? 'PASSIVE (No Tx)' : 'BIDIRECTIONAL'}
            </span>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center justify-between">
            <span>{status?.sniffer_mode ? 'Zero bus collision risk' : 'Transmit commands active'}</span>
            <Switch
              isSelected={status?.sniffer_mode ?? false}
              onChange={handleToggleSniffer}
              size="sm"
              aria-label="Toggle Passive Sniffer"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </Card>
      </div>

      {/* Hardware & Engine Safety Controls */}
      <Card className="can-do-card p-4 sm:p-5 space-y-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
            <Sliders className="w-4 h-4 text-cyan-400" />
            Hardware & Firmware Engine Controls
          </h2>
          <span className="text-[11px] text-[var(--text-muted)]">
            Instant ESP32 hardware register switching
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Toggle 1: Automations */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
            <div className="space-y-0.5 min-w-0 pr-2">
              <div className="text-xs font-semibold text-[var(--text-heading)]">Rule Execution</div>
              <div className="text-[11px] text-[var(--text-muted)]">Local triggers & condition evaluation</div>
            </div>
            <Switch
              isSelected={status?.automations_enabled ?? false}
              onChange={handleToggleAutomations}
              size="sm"
              aria-label="Rule Execution"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="text-xs font-bold text-[var(--text-heading)]">
                  {status?.automations_enabled ? 'ENABLED' : 'MUTED'}
                </span>
              </Switch.Content>
            </Switch>
          </div>

          {/* Toggle 2: Passive Sniffer */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
            <div className="space-y-0.5 min-w-0 pr-2">
              <div className="text-xs font-semibold text-[var(--text-heading)]">Passive Sniffer</div>
              <div className="text-[11px] text-[var(--text-muted)]">Silence all CAN Tx transmission</div>
            </div>
            <Switch
              isSelected={status?.sniffer_mode ?? false}
              onChange={handleToggleSniffer}
              size="sm"
              aria-label="Passive Sniffer"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="text-xs font-bold text-[var(--text-heading)]">
                  {status?.sniffer_mode ? 'ACTIVE' : 'OFF'}
                </span>
              </Switch.Content>
            </Switch>
          </div>

          {/* Toggle 3: Hardware Listen Only */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
            <div className="space-y-0.5 min-w-0 pr-2">
              <div className="text-xs font-semibold text-[var(--text-heading)]">Listen-Only (Stealth)</div>
              <div className="text-[11px] text-[var(--text-muted)]">Zero PHY ACK bits sent to bus</div>
            </div>
            <Switch
              isSelected={status?.hardware_listen_only ?? false}
              onChange={handleToggleListenOnly}
              size="sm"
              aria-label="Hardware Listen Only"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="text-xs font-bold text-[var(--text-heading)]">
                  {status?.hardware_listen_only ? 'STEALTH' : 'NORMAL'}
                </span>
              </Switch.Content>
            </Switch>
          </div>
        </div>

        {/* Advisory banner when sniffer mode is active */}
        {status?.sniffer_mode && (
          <Alert status="warning" className="p-3 rounded-xl border text-xs font-medium">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Passive Sniffer Mode is active: Outgoing CAN packets are strictly silenced to protect diagnostic stability on sensitive vehicle buses.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Card>

      {/* Sub-Navigation Segmented Tabs Bar */}
      <div className="flex items-center justify-center border-b border-slate-800/80 pb-3 overflow-x-auto no-scrollbar">
        <Tabs
          selectedKey={activeTab}
          onSelectionChange={key => setActiveTab(key as 'automations' | 'mqtt' | 'wifi' | 'bluetooth' | 'ota')}
          aria-label="Device Console Tabs"
        >
          <Tabs.ListContainer className="bg-slate-900/90 border border-slate-800/80 shadow-inner rounded-xl overflow-x-auto no-scrollbar">
            <Tabs.List className="gap-1 p-1">
              <Tabs.Tab
                id="automations"
                className={`relative flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                  activeTab === 'automations' ? 'text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Zap className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeTab === 'automations' ? 'text-amber-400' : 'text-slate-400'}`} />
                <span>Diagnostics</span>
                <Tabs.Indicator className="rounded-lg bg-slate-800 border border-slate-700/80 shadow-sm" />
              </Tabs.Tab>

              <Tabs.Tab
                id="mqtt"
                className={`relative flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                  activeTab === 'mqtt' ? 'text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Radio className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeTab === 'mqtt' ? 'text-amber-400' : 'text-slate-400'}`} />
                <span>Home Assistant & MQTT</span>
                {mqttConfig.enabled && (
                  <span
                    className={`w-2 h-2 rounded-full ${
                      mqttConfig.connected ? 'bg-emerald-400' : 'bg-amber-400/80 animate-pulse'
                    }`}
                    title={mqttConfig.connected ? 'MQTT Connected' : 'Connecting / Disconnected'}
                  />
                )}
                <Tabs.Indicator className="rounded-lg bg-slate-800 border border-slate-700/80 shadow-sm" />
              </Tabs.Tab>

              <Tabs.Tab
                id="wifi"
                className={`relative flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                  activeTab === 'wifi' ? 'text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Wifi className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeTab === 'wifi' ? 'text-sky-400' : 'text-slate-400'}`} />
                <span>Wi-Fi & AP</span>
                <Tabs.Indicator className="rounded-lg bg-slate-800 border border-slate-700/80 shadow-sm" />
              </Tabs.Tab>

              <Tabs.Tab
                id="bluetooth"
                className={`relative flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                  activeTab === 'bluetooth' ? 'text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Bluetooth className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeTab === 'bluetooth' ? 'text-blue-400' : 'text-slate-400'}`} />
                <span>Bluetooth</span>
                <Tabs.Indicator className="rounded-lg bg-slate-800 border border-slate-700/80 shadow-sm" />
              </Tabs.Tab>

              <Tabs.Tab
                id="ota"
                className={`relative flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                  activeTab === 'ota' ? 'text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <RefreshCw className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeTab === 'ota' ? 'text-cyan-400' : 'text-slate-400'}`} />
                <span>System & Updates</span>
                {updateResult?.has_update && (
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                )}
                <Tabs.Indicator className="rounded-lg bg-slate-800 border border-slate-700/80 shadow-sm" />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {/* =========================================================================
          TAB 2: Automations Diagnostics (Edge Execution Diagnostics)
         ========================================================================= */}
      {activeTab === 'automations' && (
        <div className="can-do-card p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-[var(--text-heading)]">
                Edge Automations Diagnostics
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                Real-time trigger counters, execution latencies, and condition states running on ESP32 LittleFS
              </p>
            </div>

            <div className="flex items-center gap-2">
              {onSyncAutomationsToDevice && (
                <Button
                  variant="primary"
                  size="sm"
                  onPress={handleDeploy}
                  isDisabled={isDeployingRules}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 shadow"
                >
                  <ArrowUpFromLine className="w-3.5 h-3.5" />
                  <span>Deploy to Device</span>
                </Button>
              )}

              {onPullAutomationsFromDevice && (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handlePull}
                  isDisabled={isPullingRules}
                  className="dash-outline-btn text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  <span>Pull into Builder</span>
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                isIconOnly
                onPress={fetchAutomationsDiag}
                isDisabled={automationsLoading}
                className="dash-outline-btn text-xs p-1.5"
                aria-label="Refresh diagnostics"
              >
                <RefreshCw className={`w-4 h-4 ${automationsLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {(!Array.isArray(automations) || automations.length === 0) ? (
              <div className="col-span-2 text-center py-12 text-[var(--text-muted)] border border-dashed border-[var(--border-color)] rounded-xl">
                <Zap className="w-8 h-8 text-amber-500/50 mx-auto mb-2" />
                <h4 className="text-sm font-semibold text-[var(--text-heading)]">
                  {automationsLoading ? 'Querying device diagnostic endpoint...' : 'No active automation rules on device'}
                </h4>
                <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto mt-1 mb-4">
                  Deploy your rules from the web automation builder or check connection status.
                </p>
                {onNavigateToAutomations && (
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={onNavigateToAutomations}
                    className="dash-outline-btn text-xs py-1.5 px-4 font-semibold text-cyan-300"
                  >
                    Open Automation Builder
                  </Button>
                )}
              </div>
            ) : (
              automations.map((rule) => (
                <div
                  key={rule.id}
                  className="p-4 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Zap className="w-4 h-4 text-amber-400 shrink-0" />
                      <span className="font-bold text-xs text-[var(--text-heading)] truncate" title={rule.name || rule.id}>
                        {rule.name || rule.id}
                      </span>
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase shrink-0 ${
                        rule.enabled
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {rule.enabled ? 'ACTIVE' : 'MUTED'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-2 border-t border-[var(--border-color)]/60 text-[var(--text-muted)]">
                    <div>
                      Mode: <strong className="text-cyan-300 uppercase">{rule.exec_mode || 'one_shot'}</strong>
                    </div>
                    <div>
                      Cooldown: <strong className="text-slate-300">{rule.cooldown_ms ?? 500}ms</strong>
                    </div>
                    <div>
                      Triggers: <strong className="text-amber-300">{rule.triggers?.length || 0}</strong>
                    </div>
                    <div>
                      Actions: <strong className="text-amber-300">{rule.actions?.length || 0}</strong>
                    </div>
                    <div>
                      Last Fired:{' '}
                      <strong className="text-[var(--text-heading)]">
                        {rule.last_exec_sec_ago !== undefined && rule.last_exec_sec_ago >= 0
                          ? `${rule.last_exec_sec_ago}s ago`
                          : rule.last_fired || 'Never'}
                      </strong>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB: Home Assistant & MQTT Integration
         ========================================================================= */}
      {activeTab === 'mqtt' && (
        <div className="can-do-card p-4 sm:p-5 space-y-6">
          {/* Header & Status */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--border-color)]">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-[var(--text-heading)] flex items-center gap-2">
                <Radio className="w-4 h-4 text-amber-400" />
                Home Assistant & MQTT Integration
              </h3>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Integrates CAN Do directly into Home Assistant using MQTT Auto-Discovery. Vehicle entities appear automatically.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Chip
                size="sm"
                color={mqttConfig.connected ? 'success' : mqttConfig.enabled ? 'warning' : 'default'}
                variant="soft"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                  mqttConfig.connected
                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/80'
                    : mqttConfig.enabled
                    ? 'bg-amber-950/60 text-amber-300 border-amber-800/80'
                    : 'bg-slate-800 text-slate-400 border-slate-700/60'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full mr-1.5 ${
                    mqttConfig.connected
                      ? 'bg-emerald-400'
                      : mqttConfig.enabled
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-slate-500'
                  }`}
                />
                {mqttConfig.connected
                  ? 'Connected to Broker'
                  : mqttConfig.enabled
                  ? 'Disconnected / Connecting'
                  : 'Disabled'}
              </Chip>

              <Button
                variant="outline"
                size="sm"
                isIconOnly
                onPress={fetchMqtt}
                isDisabled={mqttLoading}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                aria-label="Refresh MQTT Status"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${mqttLoading ? 'animate-spin text-cyan-400' : ''}`} />
              </Button>
            </div>
          </div>

          {/* Configuration Form */}
          <form onSubmit={handleSaveMqtt} className="space-y-5 max-w-2xl">
            {/* Toggle Enable */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
              <div>
                <span className="text-xs font-bold text-[var(--text-heading)] block">
                  Enable MQTT Client
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">
                  Connect to MQTT broker and stream real-time vehicle telemetry states
                </span>
              </div>
              <Switch
                id="chk-mqtt-en"
                isSelected={mqttConfig.enabled}
                onChange={(isSelected) => setMqttConfig((prev) => ({ ...prev, enabled: isSelected }))}
                size="sm"
                aria-label="Enable MQTT Client"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </div>

            {/* Toggle HA Generic Discovery */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
              <div>
                <span className="text-xs font-bold text-[var(--text-heading)] block">
                  Broadcast Generic MQTT Auto-Discovery
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">
                  Publish legacy <code className="text-cyan-400 font-mono">homeassistant/.../config</code> topics. <strong className="text-amber-400 font-semibold">Leave disabled (recommended)</strong> when using the native CAN Do Home Assistant integration to avoid duplicate entities.
                </span>
              </div>
              <Switch
                id="chk-mqtt-disco"
                isSelected={!!mqttConfig.ha_discovery}
                onChange={(isSelected) => setMqttConfig((prev) => ({ ...prev, ha_discovery: isSelected }))}
                size="sm"
                aria-label="Broadcast Generic MQTT Auto-Discovery"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </div>

            {/* Broker Fields */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--text-heading)] mb-1">
                  Broker URL (URI)
                </label>
                <input
                  type="text"
                  value={mqttConfig.broker_url}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, broker_url: e.target.value }))}
                  placeholder="mqtt://homeassistant.local:1883 or mqtt://192.168.1.100:1883"
                  className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-cyan-500/80 font-mono"
                  required
                />
                <span className="text-[10px] text-[var(--text-muted)] mt-1 block">
                  Supported formats: <code className="text-cyan-400">mqtt://host:1883</code> or <code className="text-cyan-400">mqtts://host:8883</code>
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-[var(--text-heading)] mb-1">
                    Username <span className="text-[10px] font-normal text-[var(--text-muted)]">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={mqttConfig.username}
                    onChange={(e) => setMqttConfig((prev) => ({ ...prev, username: e.target.value }))}
                    placeholder="homeassistant"
                    className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-cyan-500/80 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-[var(--text-heading)] mb-1">
                    Password {mqttConfig.has_password && <span className="text-emerald-400 text-[10px] font-normal">(Password set)</span>}
                  </label>
                  <input
                    type="password"
                    value={mqttPasswordInput}
                    onChange={(e) => setMqttPasswordInput(e.target.value)}
                    placeholder={mqttConfig.has_password ? '•••••••• (leave blank to keep)' : 'Enter broker password'}
                    className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-cyan-500/80 font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Info Callout */}
            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 text-[11px] text-[var(--text-muted)] space-y-1.5">
              <div className="flex items-center gap-1.5 font-bold text-slate-200">
                <Info className="w-3.5 h-3.5 text-cyan-400" />
                <span>Home Assistant MQTT Auto-Discovery</span>
              </div>
              <p>
                When enabled and connected, CAN Do publishes telemetry and discovery topics under <code className="text-cyan-300 font-mono">homeassistant/sensor/cando/...</code> and commands to <code className="text-cyan-300 font-mono">cando/set/...</code>.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <span className={`text-xs font-medium ${mqttSaveStatus.includes('Error') || mqttSaveStatus.includes('Failed') ? 'text-rose-400' : 'text-emerald-400'}`}>
                {mqttSaveStatus}
              </span>

              <Button
                type="submit"
                variant="primary"
                size="sm"
                isDisabled={mqttSaving}
                className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold text-xs transition shadow-md shadow-cyan-600/20 inline-flex items-center gap-2"
              >
                {mqttSaving ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Save & Connect</span>
                  </>
                )}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* =========================================================================
          TAB 3: Wi-Fi & SoftAP Manager
         ========================================================================= */}
      {activeTab === 'wifi' && (
        <div className="can-do-card p-4 sm:p-5 space-y-6">
          {/* Active Connection Information */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Active Network Interfaces
            </h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
                <div className="text-[var(--text-muted)]">Station Status</div>
                <div className="text-base font-bold text-[var(--text-heading)] mt-0.5">
                  {wifi?.sta_connected ? 'CONNECTED' : 'STANDALONE'}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] mt-1 truncate">
                  SSID: {wifi?.sta_ssid || 'None'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
                <div className="text-[var(--text-muted)]">Station IP</div>
                <div className="mt-1">
                  <Chip size="sm" color="accent" variant="soft" className="font-mono text-cyan-300 font-bold text-sm px-2 py-0.5">
                    {wifi?.sta_ip || '--'}
                  </Chip>
                </div>
                <div className="text-[11px] text-[var(--text-muted)] mt-1 truncate">
                  Gateway: {wifi?.sta_gw || '--'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
                <div className="text-[var(--text-muted)]">Access Point (SoftAP)</div>
                <div className="text-base font-bold text-[var(--text-heading)] mt-0.5">
                  {wifi?.ap_ssid || 'CAN Do'}
                </div>
                <div className="mt-1">
                  <Chip size="sm" variant="secondary" className="font-mono text-[11px] text-[var(--text-muted)]">
                    AP IP: {wifi?.ap_ip || '192.168.4.1'}
                  </Chip>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
                <div className="text-[var(--text-muted)]">Signal & Clients</div>
                <div className="mt-1 flex items-center gap-1.5">
                  {wifi?.sta_rssi ? (
                    <Badge size="sm" color="accent" variant="soft" className="inline-flex items-center gap-1.5 font-bold font-mono text-cyan-300">
                      {getSignalIcon(wifi.sta_rssi)}
                      <span>{wifi.sta_rssi} dBm</span>
                    </Badge>
                  ) : (
                    <span className="text-base font-bold text-[var(--text-heading)]">--</span>
                  )}
                </div>
                <div className="mt-1">
                  <Chip size="sm" variant="secondary" className="text-[10.5px]">
                    Connected clients: {wifi?.ap_clients ?? 0}
                  </Chip>
                </div>
              </div>
            </div>
          </div>

          {/* Add Known Network Form */}
          <div className="p-4 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] space-y-3">
            <h4 className="text-xs font-bold text-[var(--text-heading)]">
              Add Vehicle / Home Wi-Fi Network (Auto-Roaming)
            </h4>
            <form onSubmit={handleAddNetwork} className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
              <input
                type="text"
                value={newSsid}
                onChange={(e) => setNewSsid(e.target.value)}
                placeholder="Network SSID"
                required
                className="px-3 py-2 rounded-lg bg-[var(--md-sys-color-surface-container-lowest)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition"
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Password (optional for open networks)"
                className="px-3 py-2 rounded-lg bg-[var(--md-sys-color-surface-container-lowest)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition"
              />
              <input
                type="number"
                value={newPriority}
                onChange={(e) => setNewPriority(Number(e.target.value))}
                placeholder="Priority (1-100)"
                className="px-3 py-2 rounded-lg bg-[var(--md-sys-color-surface-container-lowest)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold transition shadow"
              >
                Save Roaming Network
              </Button>
            </form>
          </div>

          {/* Known Networks List */}
          <div className="space-y-2.5">
            <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Saved Roaming Profiles
            </h4>
            <div className="divide-y divide-[var(--border-color)]/60 rounded-xl border border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-lowest)]">
              {(!Array.isArray(networks) || networks.length === 0) ? (
                <div className="p-4 text-center text-xs text-[var(--text-muted)]">
                  No known roaming networks configured on device LittleFS.
                </div>
              ) : (
                networks.map((net) => (
                  <div key={net.ssid} className="p-3 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2.5">
                      <Wifi className="w-4 h-4 text-cyan-400" />
                      <span className="font-bold text-[var(--text-heading)]">{net.ssid}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                        Priority: {net.priority}
                      </span>
                    </div>
                    <Button
                      variant="danger-soft"
                      size="sm"
                      onPress={() => handleDeleteNetwork(net.ssid)}
                      className="text-rose-400 hover:text-rose-300 text-xs font-semibold p-1 h-auto"
                    >
                      Delete
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Wi-Fi Scanner */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
                Nearby Wi-Fi Airwaves
              </h4>
              <Button
                variant="outline"
                size="sm"
                isDisabled={scanning}
                onPress={handleScanWifi}
                className="dash-outline-btn text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                <span>{scanning ? 'Scanning Airwaves...' : 'Scan Networks'}</span>
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(!Array.isArray(scanResults) || scanResults.length === 0) ? (
                <div className="col-span-full p-4 text-center text-xs text-[var(--text-muted)] border border-dashed border-[var(--border-color)] rounded-xl">
                  {scanning ? 'Scanning nearby channels...' : 'No networks scanned yet. Click "Scan Networks" to search airwaves.'}
                </div>
              ) : (
                scanResults.map((res, i) => (
                <div
                  key={`${res.ssid}-${i}`}
                  onClick={() => setNewSsid(res.ssid)}
                  className="p-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] hover:border-cyan-500/50 cursor-pointer transition text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0 pr-1">
                      {getSignalIcon(res.rssi)}
                      <span className="font-bold text-[var(--text-heading)] truncate">{res.ssid}</span>
                    </div>
                    <Badge size="sm" variant="secondary" className="text-[var(--text-muted)] font-mono text-[10px] shrink-0">
                      {res.rssi} dBm
                    </Badge>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] flex items-center justify-between">
                    <span>{res.authmode === 0 ? 'Open (No password)' : 'WPA2/WPA3 Secured'}</span>
                    <span className="text-cyan-400">Click to fill</span>
                  </div>
                </div>
              ))
            )}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB: Bluetooth BLE HID Controllers & Automations (Atom Bridge)
         ========================================================================= */}
      {activeTab === 'bluetooth' && (
        <div className="space-y-4">
          {!isAtomBridge && connected && status?.device && (
            <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-800/60 text-xs text-amber-200 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-amber-300">
                  Notice: Bluetooth (BLE HID) is currently supported on M5Stack Atom Lite Bridge firmware.
                </p>
                <p className="text-[11px] text-amber-400/80 leading-relaxed">
                  The currently connected device reports as <span className="font-mono text-white font-bold">{status.device}</span>. Wireless steering wheel buttons, BLE media controllers, and macro keypads communicate via the Atom Bridge BLE subsystem.
                </p>
              </div>
            </div>
          )}

          <BluetoothManager
            deviceHost={deviceHost}
            onSelectTriggerForAutomation={(trigger) => {
              if (onCreateAutomationWithTrigger) {
                onCreateAutomationWithTrigger(trigger);
              } else if (onNavigateToAutomations) {
                onNavigateToAutomations();
              }
            }}
          />
        </div>
      )}

      {/* =========================================================================
          TAB 5: System & Software Updates
         ========================================================================= */}
      {activeTab === 'ota' && (
        <div className="space-y-6">
          {/* Header */}
          <div className="can-do-card p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-[var(--text-heading)] flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-cyan-400" />
                System & Software Updates
              </h3>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Manage OTA firmware upgrades, vehicle message catalog sync, and web dashboard updates without requiring a PC
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                isDisabled={isCheckingUpdate || isExecutingUpdate}
                onPress={handleCheckForUpdates}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 text-white text-xs font-bold transition shadow-md shadow-cyan-600/20"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdate ? 'animate-spin' : ''}`} />
                <span>{isCheckingUpdate ? 'Checking...' : 'Check for Updates'}</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onPress={handleManualReboot}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-medium transition border border-slate-700/60"
                aria-label="Restart CAN Do hardware processor"
              >
                <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                <span>Reboot</span>
              </Button>

              {onRerunOnboarding && (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={onRerunOnboarding}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
                  aria-label="Re-run the initial vehicle & unit setup wizard"
                >
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Setup Wizard</span>
                </Button>
              )}
            </div>
          </div>

          {/* 3-Card Version Deck */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Card 1: Firmware */}
            <div className="p-4 rounded-2xl bg-[var(--input-bg)] border border-[var(--border-color)] space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-white">
                  <Cpu className="w-4 h-4 text-cyan-400" />
                  <span>ESP32 Firmware</span>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-950/60 text-cyan-300 border border-cyan-800/40">
                  {status?.can_do_version || (status ? 'unknown' : 'Loading...')}
                </span>
              </div>
              <div className="text-xs text-[var(--text-muted)] space-y-1">
                <div>Device ID: <span className="font-mono text-slate-200">{status?.device_id || 'ESP32-C3'}</span></div>
                <div>TWAI Driver: <span className="font-mono text-emerald-400">{status?.twai_state || 'Active'}</span></div>
              </div>
            </div>

            {/* Card 2: Catalog */}
            <div className="p-4 rounded-2xl bg-[var(--input-bg)] border border-[var(--border-color)] space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-white">
                  <HardDrive className="w-4 h-4 text-teal-400" />
                  <span>Message Catalog</span>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-teal-950/60 text-teal-300 border border-teal-800/40">
                  {catalog?.can_do_version || 'Loading...'}
                </span>
              </div>
              <div className="text-xs text-[var(--text-muted)] space-y-1">
                <div>Vehicle Decoders: <span className="font-mono text-slate-200">{catalog?.commands?.length || 0} CAN Signals</span></div>
                <div>Supported Models: <span className="font-mono text-slate-200">{catalog?.vehicles?.length || 0} Trims</span></div>
              </div>
            </div>

            {/* Card 3: Web Dashboard */}
            <div className="p-4 rounded-2xl bg-[var(--input-bg)] border border-[var(--border-color)] space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-white">
                  <Globe className="w-4 h-4 text-indigo-400" />
                  <span>Web Front-End</span>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-950/60 text-indigo-300 border border-indigo-800/40">
                  {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'}
                </span>
              </div>
              <div className="text-xs text-[var(--text-muted)] space-y-1">
                <div>Serving Mode: <span className="font-mono text-slate-200">{isRunningOnDevice() ? 'Embedded Device' : 'Cloud / Dev'}</span></div>
                <div>Storage Health: <span className="font-mono text-emerald-400">Optimized</span></div>
              </div>
            </div>
          </div>

          {/* Staged Execution Progress Banner */}
          {isExecutingUpdate && (
            <div className="p-4 rounded-2xl bg-cyan-950/40 border border-cyan-800/80 space-y-3 animate-fade-in">
              <div className="flex items-center justify-between text-xs font-bold text-white">
                <span className="flex items-center gap-2">
                  <Spinner size="sm" className="text-cyan-400" />
                  <span>{updateMessage || 'Applying Updates...'}</span>
                </span>
                <span className="font-mono text-cyan-300">{updateProgressPct}%</span>
              </div>
              <ProgressBar
                value={updateProgressPct}
                minValue={0}
                maxValue={100}
                aria-label="Firmware Update Progress"
                className="w-full"
              >
                <ProgressBar.Track className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden relative">
                  <ProgressBar.Fill className="bg-gradient-to-r from-cyan-500 to-teal-400 h-2.5 rounded-full transition-all duration-300" />
                </ProgressBar.Track>
              </ProgressBar>
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>1. Clean & Front-End</span>
                <span>2. Message Catalog</span>
                <span>3. Firmware Binary</span>
              </div>
            </div>
          )}

          {/* Available Update Notification Card */}
          {updateResult?.has_update && !isExecutingUpdate && (
            <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-cyan-950/50 via-slate-900 to-teal-950/50 border border-cyan-500/50 space-y-3 animate-fade-in">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs sm:text-sm font-bold text-white flex items-center gap-2">
                      <span>{updateResult.release_name || updateResult.version}</span>
                      {updateResult.is_rebuild && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                          Rebuilt Build Available
                        </span>
                      )}
                    </h4>
                    <p className="text-[11px] text-slate-300 mt-0.5">
                      {updateResult.is_rebuild
                        ? 'A newer build was published under the current release tag.'
                        : (updateResult.notes || 'Verified stability and vehicle definition enhancements.')}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {updateResult.assets.firmware_url && (
                    <a
                      href={updateResult.assets.firmware_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-800/60 text-xs font-bold transition shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{isAtomBridge ? 'Download Atom .bin' : 'Download WiCAN .bin'}</span>
                    </a>
                  )}
                  <Button
                    variant="primary"
                    size="md"
                    onPress={handleInstallCloudUpdates}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 text-slate-950 text-xs font-bold transition shadow-lg shadow-cyan-950/50 shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{updateResult.is_rebuild ? 'Re-sync & Update Now' : 'Install Updates Now'}</span>
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1 text-[10px]">
                <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  Execution: Front-End &rarr; Catalog &rarr; Firmware
                </span>
                {updateResult.components.frontend && (
                  <span className="px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
                    Web Dashboard
                  </span>
                )}
                {updateResult.components.catalog && (
                  <span className="px-2 py-0.5 rounded-full bg-teal-950 text-teal-300 border border-teal-800">
                    Message Catalog
                  </span>
                )}
                {updateResult.components.firmware && (
                  <span className="px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800">
                    Firmware Binary
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Up to date state with manual re-sync button */}
          {updateResult && !updateResult.has_update && !isExecutingUpdate && (
            <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5 text-xs text-slate-300">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Device is up to date on version <strong className="text-white font-mono">{updateResult.version}</strong></span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setUpdateResult({
                    ...updateResult,
                    has_update: true,
                    is_rebuild: true,
                    components: { frontend: true, catalog: true, firmware: !!updateResult.assets.firmware_url }
                  });
                }}
                className="text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 underline underline-offset-2 shrink-0 transition"
              >
                Force Re-sync Current Version
              </button>
            </div>
          )}

          {/* Update Policy & Off-Hours Schedule Settings */}
          <div className="can-do-card p-4 sm:p-5 space-y-4">
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-[var(--text-heading)] flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                Update Preferences & Scheduling
              </h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Configure whether updates install automatically, prompt you first, or run on an overnight schedule
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Option 1: Auto */}
              <button
                type="button"
                onClick={() => handleSavePreferences({ update_policy: 'auto' })}
                className={`p-3 rounded-xl border text-left transition ${
                  localPrefs.update_policy === 'auto'
                    ? 'bg-cyan-950/40 border-cyan-500 text-white'
                    : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800'
                }`}
              >
                <div className="flex justify-between items-center text-xs font-bold">
                  <span>Full Auto</span>
                  {localPrefs.update_policy === 'auto' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Automatic overnight installs</div>
              </button>

              {/* Option 2: Prompt */}
              <button
                type="button"
                onClick={() => handleSavePreferences({ update_policy: 'prompt' })}
                className={`p-3 rounded-xl border text-left transition ${
                  localPrefs.update_policy === 'prompt'
                    ? 'bg-cyan-950/40 border-cyan-500 text-white'
                    : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800'
                }`}
              >
                <div className="flex justify-between items-center text-xs font-bold">
                  <span>Prompt Me</span>
                  {localPrefs.update_policy === 'prompt' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Notify in dashboard before updating</div>
              </button>

              {/* Option 3: Manual */}
              <button
                type="button"
                onClick={() => handleSavePreferences({ update_policy: 'manual' })}
                className={`p-3 rounded-xl border text-left transition ${
                  localPrefs.update_policy === 'manual'
                    ? 'bg-cyan-950/40 border-cyan-500 text-white'
                    : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800'
                }`}
              >
                <div className="flex justify-between items-center text-xs font-bold">
                  <span>Manual Only</span>
                  {localPrefs.update_policy === 'manual' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Never check automatically</div>
              </button>
            </div>

            {/* Granular Component Toggles & Schedule Time */}
            {localPrefs.update_policy !== 'manual' && (
              <div className="pt-2 border-t border-[var(--border-color)] grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <span className="text-[11px] font-semibold text-slate-300">Active Update Components:</span>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <Switch
                      isSelected={localPrefs.update_components.frontend}
                      onChange={(isSelected) =>
                        handleSavePreferences({
                          update_components: { ...localPrefs.update_components, frontend: isSelected },
                        })
                      }
                      size="sm"
                      aria-label="Web Front-End"
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-slate-300">Web Front-End</span>
                      </Switch.Content>
                    </Switch>

                    <Switch
                      isSelected={localPrefs.update_components.catalog}
                      onChange={(isSelected) =>
                        handleSavePreferences({
                          update_components: { ...localPrefs.update_components, catalog: isSelected },
                        })
                      }
                      size="sm"
                      aria-label="Message Catalog"
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-slate-300">Message Catalog</span>
                      </Switch.Content>
                    </Switch>

                    <Switch
                      isSelected={localPrefs.update_components.firmware}
                      onChange={(isSelected) =>
                        handleSavePreferences({
                          update_components: { ...localPrefs.update_components, firmware: isSelected },
                        })
                      }
                      size="sm"
                      aria-label="Firmware Binary"
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-slate-300">Firmware Binary</span>
                      </Switch.Content>
                    </Switch>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-cyan-400" />
                      Off-Hours Scheduled Time:
                    </span>
                    <Switch
                      isSelected={localPrefs.update_schedule.enabled}
                      onChange={(isSelected) =>
                        handleSavePreferences({
                          update_schedule: { ...localPrefs.update_schedule, enabled: isSelected },
                        })
                      }
                      size="sm"
                      aria-label="Off-Hours Scheduled Time"
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-[10px] font-bold text-slate-300">
                          {localPrefs.update_schedule.enabled ? 'ENABLED' : 'DISABLED'}
                        </span>
                      </Switch.Content>
                    </Switch>
                  </div>
                  {localPrefs.update_schedule.enabled && (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={localPrefs.update_schedule.time}
                        onChange={(e) =>
                          handleSavePreferences({
                            update_schedule: { ...localPrefs.update_schedule, time: e.target.value },
                          })
                        }
                        className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white font-mono"
                      />
                      <span className="text-[10px] text-slate-400">(Device local time)</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Smart Low-Power & 12V Battery Gate */}
          <div className="can-do-card p-4 sm:p-5 space-y-4">
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-[var(--text-heading)] flex items-center gap-2">
                <Battery className="w-4 h-4 text-emerald-400" />
                Power Management & 12V Protection Gate
              </h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Protect your 12V auxiliary battery, throttle Wi-Fi power when vehicle is silent, and configure quiet hours
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* 12V Battery Cutoff Gate */}
              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-semibold text-white">12V Cutoff Gate</span>
                  </div>
                  <span className="text-xs font-mono font-bold text-amber-400">
                    {(localPrefs.min_12v_gate_voltage ?? 12.2).toFixed(1)} V
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  Halts all active UDS diagnostic requests and suspends wake cycles if 12V drops below this voltage.
                </p>
                <div className="pt-1">
                  <Slider
                    minValue={11.5}
                    maxValue={12.8}
                    step={0.1}
                    value={localPrefs.min_12v_gate_voltage ?? 12.2}
                    onChange={val => {
                      const num = typeof val === 'number' ? val : val[0];
                      handleSavePreferences({ min_12v_gate_voltage: num });
                    }}
                    aria-label="12V Cutoff Gate Voltage"
                    className="w-full"
                  >
                    <Slider.Track className="h-1.5 bg-slate-700 rounded-full cursor-pointer relative">
                      <Slider.Fill className="bg-amber-400 rounded-full h-full" />
                      <Slider.Thumb className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-900 rounded-full shadow cursor-grab active:cursor-grabbing focus:outline-none" />
                    </Slider.Track>
                  </Slider>
                </div>
              </div>

              {/* Quiet / Offline Hours */}
              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Moon className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-semibold text-white">Quiet / Offline Hours</span>
                  </div>
                  <Switch
                    isSelected={localPrefs.quiet_hours_enabled}
                    onChange={(isSelected) =>
                      handleSavePreferences({ quiet_hours_enabled: isSelected })
                    }
                    size="sm"
                    aria-label="Quiet / Offline Hours"
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <span className="text-[10px] font-bold text-slate-300">
                        {localPrefs.quiet_hours_enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </Switch.Content>
                  </Switch>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  Suspends all active vehicle polling overnight and optimizes low-power modem sleep.
                </p>
                {localPrefs.quiet_hours_enabled && (
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="time"
                      value={localPrefs.quiet_hours_start || '22:00'}
                      onChange={(e) => handleSavePreferences({ quiet_hours_start: e.target.value })}
                      className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-white font-mono"
                    />
                    <span className="text-xs text-slate-400">to</span>
                    <input
                      type="time"
                      value={localPrefs.quiet_hours_end || '07:00'}
                      onChange={(e) => handleSavePreferences({ quiet_hours_end: e.target.value })}
                      className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-white font-mono"
                    />
                  </div>
                )}
              </div>

              {/* Inactivity Sleep Delay */}
              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Car-Off Sleep Timeout</span>
                  <span className="text-xs font-mono font-bold text-cyan-400">
                    {localPrefs.uds_sleep_delay_sec ?? 10}s
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  Delay after CAN traffic stops before halting UDS and entering modem sleep.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="range"
                    min="5"
                    max="60"
                    step="5"
                    value={localPrefs.uds_sleep_delay_sec ?? 10}
                    onChange={(e) =>
                      handleSavePreferences({ uds_sleep_delay_sec: parseInt(e.target.value, 10) })
                    }
                    className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
                  />
                </div>
              </div>

              {/* Awake Polling Interval */}
              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Awake Polling Interval</span>
                  <span className="text-xs font-mono font-bold text-cyan-400">
                    {localPrefs.uds_awake_interval_sec ?? 15}s
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  Frequency of high-voltage BMS queries while driving or charging.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="range"
                    min="5"
                    max="60"
                    step="5"
                    value={localPrefs.uds_awake_interval_sec ?? 15}
                    onChange={(e) =>
                      handleSavePreferences({ uds_awake_interval_sec: parseInt(e.target.value, 10) })
                    }
                    className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* System Timezone & Clock Configuration */}
          <div className="can-do-card p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h4 className="text-xs sm:text-sm font-bold text-[var(--text-heading)] flex items-center gap-2">
                  <Clock className="w-4 h-4 text-cyan-400" />
                  System Timezone & Clock
                </h4>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Controls scheduled automations, quiet hours evaluation, and live device timestamps
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onPress={handleSyncTime}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-cyan-950/40 text-cyan-300 border border-cyan-800/80 hover:bg-cyan-900/40 transition w-fit"
                aria-label="Synchronize time and timezone from your browser"
              >
                <Clock className="w-3.5 h-3.5 text-cyan-400" />
                <span>Sync Time from Browser</span>
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 space-y-2">
                <label className="block text-xs font-semibold text-white">Device Timezone</label>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  Used by the ESP32 coprocessor for local daylight savings and time schedule rules.
                </p>
                <select
                  value={localPrefs.timezone || status?.timezone || 'US/Pacific'}
                  onChange={(e) => {
                    const newTz = e.target.value;
                    handleSavePreferences({ timezone: newTz });
                    fetch(getApiUrl('/api/system/time'), {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ epoch: Math.floor(Date.now() / 1000), timezone: newTz })
                    }).then(() => fetchStatus());
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-white focus:outline-none focus:border-cyan-500"
                >
                  {STANDARD_TIMEZONES.map((tz) => (
                    <option key={tz.id} value={tz.id}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 flex flex-col justify-center text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Device Clock:</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${status?.time_synced ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}`}>
                    {status?.time_synced ? 'SYNCHRONIZED' : 'PENDING'}
                  </span>
                </div>
                <div className="font-mono text-cyan-300 font-bold text-sm">
                  {status?.system_time || 'Unsynchronized'}
                </div>
                <div className="text-[10px] text-slate-400">
                  Active Zone: <strong className="text-slate-200">{getTimezoneLabel(status?.timezone || localPrefs.timezone)}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Manual Binary Upload */}
          <div className="can-do-card p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="text-xs sm:text-sm font-bold text-[var(--text-heading)] flex items-center gap-2">
                  <Upload className="w-4 h-4 text-cyan-400" />
                  Manual Firmware Binary Flash
                </h4>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Flash a custom or release ESP32 binary directly over Wi-Fi without a USB cable
                </p>
              </div>

              {updateResult?.assets.firmware_url && (
                <a
                  href={updateResult.assets.firmware_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-800/60 text-xs font-semibold shrink-0 transition"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{isAtomBridge ? 'Download Latest Atom .bin' : 'Download Latest WiCAN .bin'}</span>
                </a>
              )}
            </div>

            <form onSubmit={handleOtaUpload} className="space-y-4 max-w-lg">
              <div className="p-4 rounded-xl border-2 border-dashed border-[var(--border-color)] hover:border-cyan-500/50 transition-colors text-center bg-[var(--input-bg)]">
                <Upload className="w-6 h-6 text-cyan-400 mx-auto mb-1.5" />
                <div className="text-xs font-semibold text-[var(--text-heading)]">
                  {otaFile ? otaFile.name : 'Select firmware binary (.bin)'}
                </div>
                {otaFile && (
                  <div className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
                    Size: {Math.round(otaFile.size / 1024)} KB
                  </div>
                )}
                <input
                  type="file"
                  accept=".bin"
                  onChange={(e) => setOtaFile(e.target.files?.[0] || null)}
                  className="mt-2 block w-full text-xs text-[var(--text-muted)] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-cyan-300 hover:file:bg-slate-700 cursor-pointer"
                />
              </div>

              {otaUploading && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-mono text-[var(--text-muted)]">
                    <span>Uploading Image...</span>
                    <span>{otaProgress}%</span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-cyan-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${otaProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {otaStatus && (
                <div className="text-xs font-mono text-cyan-300 bg-cyan-950/30 p-2.5 rounded-lg border border-cyan-800/50">
                  {otaStatus}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="md"
                isDisabled={!otaFile || otaUploading}
                className="w-full py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold text-xs transition shadow-md shadow-cyan-600/20"
              >
                {otaUploading ? 'Flashing Firmware...' : 'Flash Firmware Binary'}
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* Rebooting Popup Modal */}
      <DeviceRebootModal
        isOpen={isRebootModalOpen}
        deviceHost={deviceHost}
        isAtomBridge={isAtomBridge}
        version={updateResult?.version}
        customTitle={rebootModalInfo.title}
        customMessage={rebootModalInfo.message}
        onClose={() => setIsRebootModalOpen(false)}
        onReconnected={() => {
          fetchStatus();
          handleCheckForUpdates();
        }}
      />
    </div>
  );
};

export default DeviceDashboard;
