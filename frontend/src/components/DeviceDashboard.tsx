import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  Moon
} from 'lucide-react';
import { Catalog, Command } from '../types/catalog';
import { AutomationRule, AutomationTrigger } from '../types/automation';
import { UserPreferences, getUserPreferences, saveUserPreferences, DEFAULT_USER_PREFERENCES, UpdatePolicy } from '../types/settings';
import { checkForUpdates, executeUpdateSequence, UpdateCheckResult, UpdateStage, uploadFirmwareOta } from '../services/updateService';
import { MdiIcon } from './MdiIcon';
import { BluetoothManager } from './BluetoothManager';

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
  onPullAutomationsFromDevice?: () => Promise<void>;
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
      onPullAutomationsFromDevice().catch(() => {});
    }
  }, [onPullAutomationsFromDevice]);

  // Connection & Telemetry state
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [restConnected, setRestConnected] = useState<boolean>(false);
  const connected = wsConnected || restConnected;
  const [lastPingMs, setLastPingMs] = useState<number | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [wifi, setWifi] = useState<WifiStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'automations' | 'mqtt' | 'wifi' | 'ota'>('automations');
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

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
      const currentFront = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ !== 'unknown') ? __APP_VERSION__ : (status?.can_do_version || catalog?.can_do_version || '');
      const currentFw = status?.can_do_version || currentFront;
      const currentCat = catalog?.can_do_version || currentFront;
      const targetDev = isAtomBridge ? 'atom' : 'esp32c3';
      const res = await checkForUpdates(currentCat, currentFw, currentFront, targetDev);
      setUpdateResult(res);
      if (res.has_update) {
        showNotice(`Update available: ${res.release_name || res.version}`);
      } else {
        showNotice(`All components are up to date (${currentFw || 'Current'})`);
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
      await executeUpdateSequence(
        deviceHost,
        localPrefs.update_components,
        updateResult,
        (stage, pct, msg) => {
          setUpdateStage(stage);
          setUpdateProgressPct(pct);
          setUpdateMessage(msg);
        },
        isAtomBridge ? 'atom' : 'esp32c3'
      );
      setUpdateStage('complete');
      setUpdateProgressPct(100);
      setUpdateMessage('Updates completed successfully! Rebooting device...');
      showNotice('Updates applied successfully! Device is restarting...', 'success');
      // Keep completion card visible for 5 seconds so the user clearly sees the result
      await new Promise((r) => setTimeout(r, 5000));
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

  const handleManualBinaryUpload = async (file: File) => {
    if (!file) return;
    setIsExecutingUpdate(true);
    setUpdateStage('firmware');
    setUpdateProgressPct(5);
    setUpdateMessage(`Reading ${file.name}...`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (arrayBuffer.byteLength < 100000) {
        throw new Error('Selected file is too small to be a valid ESP32 firmware binary.');
      }
      const u8 = new Uint8Array(arrayBuffer);
      if (u8[0] !== 0xE9) {
        throw new Error('Invalid ESP32 binary format (missing 0xE9 magic byte). Please ensure this is an application .bin file.');
      }

      setUpdateMessage('Flashing firmware binary to ESP32 OTA partition...');
      const targetHost = resolveDeviceBaseUrl(deviceHost);
      await uploadFirmwareOta(targetHost, arrayBuffer, (pct) => {
        setUpdateProgressPct(pct);
        setUpdateMessage(`Flashing firmware: ${pct}%`);
      });

      setUpdateStage('rebooting');
      setUpdateProgressPct(100);
      setUpdateMessage('Firmware flashed successfully! Device is restarting...');
      showNotice('Firmware flashed successfully! Restarting...', 'success');
      await new Promise((r) => setTimeout(r, 6000));
      fetchStatus();
      handleCheckForUpdates();
    } catch (err: any) {
      setUpdateStage('error');
      setUpdateMessage(`Manual flash failed: ${err.message || err}`);
      showNotice(`Flash error: ${err.message || err}`, 'error');
      await new Promise((r) => setTimeout(r, 4000));
    } finally {
      setIsExecutingUpdate(false);
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
  const handleToggleAutomations = async () => {
    if (!status) return;
    try {
      const res = await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle_automations' })
      });
      if (res.ok) {
        fetchStatus();
        showNotice(`Automations Engine ${!status.automations_enabled ? 'ENABLED' : 'MUTED'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle automations: ${e.message}`, 'error');
    }
  };

  // Controls: Sniffer Mode Toggle
  const handleToggleSniffer = async () => {
    if (!status) return;
    try {
      const res = await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle_sniffer' })
      });
      if (res.ok) {
        fetchStatus();
        showNotice(`Passive Sniffer ${!status.sniffer_mode ? 'ACTIVATED (All Tx Blocked)' : 'DEACTIVATED (Tx Enabled)'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle sniffer: ${e.message}`, 'error');
    }
  };

  // Controls: Hardware Listen Only
  const handleToggleListenOnly = async () => {
    if (!status) return;
    try {
      const res = await fetch(getApiUrl('/api/system/control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_hardware_listen_only',
          enabled: !status.hardware_listen_only
        })
      });
      if (res.ok) {
        fetchStatus();
        showNotice(`Hardware Listen-Only Mode ${!status.hardware_listen_only ? 'ENABLED (Zero PHY ACKs)' : 'DISABLED'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle listen-only: ${e.message}`, 'error');
    }
  };

  // System: Sync Time from Browser
  const handleSyncTime = async () => {
    try {
      const epoch = Math.floor(Date.now() / 1000);
      const res = await fetch(getApiUrl('/api/system/time'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch })
      });
      if (res.ok) {
        showNotice('Device clock synced with browser time', 'success');
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
        setOtaProgress(100);
        setOtaStatus('Firmware flashed successfully! Device is rebooting into the new image...');
        showNotice('Firmware flashed! Device rebooting in 5 seconds.', 'success');
        setOtaFile(null);
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
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  connected
                    ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/80'
                    : 'bg-rose-950/40 text-rose-300 border-rose-800/80'
                }`}
              >
                <span className={`status-dot ${connected ? 'green' : 'red'}`} />
                <span>{connected ? (wsConnected ? 'ONLINE' : 'ONLINE (HTTP)') : 'OFFLINE'}</span>
              </span>
              {connected && (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                    wsConnected
                      ? 'bg-cyan-950/40 text-cyan-300 border-cyan-800/80'
                      : 'bg-amber-950/40 text-amber-300 border-amber-800/80'
                  }`}
                  title={wsConnected ? 'WebSocket live CAN/log stream active' : `Connecting WebSocket to ${currentWsUrl}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-cyan-400 animate-pulse' : 'bg-amber-400 animate-ping'}`} />
                  {wsConnected ? 'WS Stream Active' : 'WS Connecting...'}
                </span>
              )}
              {lastPingMs !== null && (
                <span className="text-[11px] font-mono text-[var(--text-muted)]">
                  {lastPingMs}ms latency
                </span>
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
                    ? `NTP Synchronized (${status?.ntp_server || 'pool.ntp.org'})\nEpoch: ${status?.epoch_time || 0}\nClick to re-sync from browser`
                    : (status?.time_synced === false
                      ? 'NTP sync in progress with pool.ntp.org\nClick to force sync from browser'
                      : 'Firmware 2026.10.3-b004 running (OTA update required to read NTP state)\nClick to sync from browser')
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
                  <span className="text-amber-300">GVRET TCP: {status.gvret_clients}</span>
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

          <button
            type="button"
            onClick={() => {
              connectWs();
              fetchStatus();
              fetchWifi();
            }}
            className="dash-outline-btn text-xs py-1 px-2.5 inline-flex items-center gap-1 text-[var(--text-heading)]"
            title="Reconnect WebSocket & Poll Status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Connect</span>
          </button>

          {/* Quick Deploy / Pull Buttons */}
          {onSyncAutomationsToDevice && (
            <button
              type="button"
              onClick={handleDeploy}
              disabled={isDeployingRules}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold text-xs shadow transition"
              title="Push current local automations down to device LittleFS"
            >
              <ArrowUpFromLine className={`w-3.5 h-3.5 ${isDeployingRules ? 'animate-bounce' : ''}`} />
              <span>Deploy</span>
            </button>
          )}

          {onPullAutomationsFromDevice && (
            <button
              type="button"
              onClick={handlePull}
              disabled={isPullingRules}
              className="dash-outline-btn text-xs py-1.5 px-3 inline-flex items-center gap-1.5 text-slate-300 hover:text-white"
              title="Load automations saved on device into the web builder"
            >
              <ArrowDownToLine className={`w-3.5 h-3.5 ${isPullingRules ? 'animate-bounce' : ''}`} />
              <span className="hidden sm:inline">Pull</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
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
            title="Download device session log as .txt"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Logs .txt</span>
          </button>
        </div>
      </div>

      {/* Global Action Feedback Alert */}
      {actionNotice && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all ${
            actionNotice.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-800 text-emerald-200'
              : actionNotice.type === 'error'
              ? 'bg-rose-950/80 border-rose-800 text-rose-200'
              : 'bg-cyan-950/80 border-cyan-800 text-cyan-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {actionNotice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : actionNotice.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            ) : (
              <Info className="w-4 h-4 text-cyan-400 shrink-0" />
            )}
            <span>{actionNotice.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-slate-400 hover:text-white ml-3 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Primary Metrics Deck (4 Cards) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* Metric 1: Automations Rule Engine */}
        <div className="can-do-card p-4 flex flex-col justify-between">
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
            <button
              type="button"
              onClick={handleToggleAutomations}
              className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
            >
              Toggle
            </button>
          </div>
        </div>

        {/* Metric 2: TWAI CAN State */}
        <div className="can-do-card p-4 flex flex-col justify-between">
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
        </div>

        {/* Metric 3: Wi-Fi Link */}
        <div className="can-do-card p-4 flex flex-col justify-between">
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
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 font-mono truncate">
            {wifi?.sta_ip || wifi?.ap_ip || '192.168.4.1'} {wifi?.sta_rssi ? `(${wifi.sta_rssi} dBm)` : ''}
          </div>
        </div>

        {/* Metric 4: Passive Sniffer Protection */}
        <div className="can-do-card p-4 flex flex-col justify-between">
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
            <button
              type="button"
              onClick={handleToggleSniffer}
              className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
            >
              Toggle
            </button>
          </div>
        </div>
      </div>

      {/* Hardware & Engine Safety Controls */}
      <div className="can-do-card p-4 sm:p-5 space-y-3.5">
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
            <button
              type="button"
              onClick={handleToggleAutomations}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0 ${
                status?.automations_enabled
                  ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-sm'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {status?.automations_enabled ? 'ENABLED' : 'MUTED'}
            </button>
          </div>

          {/* Toggle 2: Passive Sniffer */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
            <div className="space-y-0.5 min-w-0 pr-2">
              <div className="text-xs font-semibold text-[var(--text-heading)]">Passive Sniffer</div>
              <div className="text-[11px] text-[var(--text-muted)]">Silence all CAN Tx transmission</div>
            </div>
            <button
              type="button"
              onClick={handleToggleSniffer}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0 ${
                status?.sniffer_mode
                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-sm'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {status?.sniffer_mode ? 'ACTIVE' : 'OFF'}
            </button>
          </div>

          {/* Toggle 3: Hardware Listen Only */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
            <div className="space-y-0.5 min-w-0 pr-2">
              <div className="text-xs font-semibold text-[var(--text-heading)]">Listen-Only (Stealth)</div>
              <div className="text-[11px] text-[var(--text-muted)]">Zero PHY ACK bits sent to bus</div>
            </div>
            <button
              type="button"
              onClick={handleToggleListenOnly}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0 ${
                status?.hardware_listen_only
                  ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow-sm'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {status?.hardware_listen_only ? 'STEALTH' : 'NORMAL'}
            </button>
          </div>
        </div>

        {/* Advisory banner when sniffer mode is active */}
        {status?.sniffer_mode && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/80 text-amber-200 text-xs font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Passive Sniffer Mode is active: Outgoing CAN packets are strictly silenced to protect diagnostic stability on sensitive vehicle buses.
            </span>
          </div>
        )}
      </div>

      {/* Sub-Navigation Segmented Tabs Bar */}
      <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3">
        <nav
          className="inline-flex items-center p-1 rounded-xl bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] text-xs font-medium overflow-x-auto no-scrollbar"
          aria-label="Device Console Tabs"
        >


          {/* Tab 2: Automations Diagnostics */}
          <button
            type="button"
            onClick={() => setActiveTab('automations')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors shrink-0 ${
              activeTab === 'automations'
                ? 'bg-slate-800 text-white font-semibold shadow-sm'
                : 'text-[var(--text-muted)] hover:text-white'
            }`}
          >
            <Zap className={`w-3.5 h-3.5 ${activeTab === 'automations' ? 'text-amber-400' : 'text-slate-500'}`} />
            <span>Diagnostics</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-900 text-amber-300 border border-slate-700/60">
              {automations.length > 0 ? automations.length : automationRules.length}
            </span>
          </button>

          {/* Tab 3: Home Assistant & MQTT */}
          <button
            type="button"
            onClick={() => setActiveTab('mqtt')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors shrink-0 ${
              activeTab === 'mqtt'
                ? 'bg-slate-800 text-white font-semibold shadow-sm'
                : 'text-[var(--text-muted)] hover:text-white'
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${activeTab === 'mqtt' ? 'text-amber-400' : 'text-slate-500'}`} />
            <span>Home Assistant & MQTT</span>
            {mqttConfig.enabled && (
              <span
                className={`w-2 h-2 rounded-full ${
                  mqttConfig.connected ? 'bg-emerald-400' : 'bg-amber-400/80 animate-pulse'
                }`}
                title={mqttConfig.connected ? 'MQTT Connected' : 'Connecting / Disconnected'}
              />
            )}
          </button>

          {/* Tab 4: Wi-Fi & SoftAP */}
          <button
            type="button"
            onClick={() => setActiveTab('wifi')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors shrink-0 ${
              activeTab === 'wifi'
                ? 'bg-slate-800 text-white font-semibold shadow-sm'
                : 'text-[var(--text-muted)] hover:text-white'
            }`}
          >
            <Wifi className={`w-3.5 h-3.5 ${activeTab === 'wifi' ? 'text-sky-400' : 'text-slate-500'}`} />
            <span>Wi-Fi & AP</span>
          </button>


          {/* Tab 5: System & Updates */}
          <button
            type="button"
            onClick={() => setActiveTab('ota')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors shrink-0 ${
              activeTab === 'ota'
                ? 'bg-slate-800 text-white font-semibold shadow-sm'
                : 'text-[var(--text-muted)] hover:text-white'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${activeTab === 'ota' ? 'text-cyan-400' : 'text-slate-500'}`} />
            <span>System & Updates</span>
            {updateResult?.has_update && (
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            )}
          </button>
        </nav>
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
                <button
                  type="button"
                  onClick={handleDeploy}
                  disabled={isDeployingRules}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 shadow"
                >
                  <ArrowUpFromLine className="w-3.5 h-3.5" />
                  <span>Deploy to Device</span>
                </button>
              )}

              {onPullAutomationsFromDevice && (
                <button
                  type="button"
                  onClick={handlePull}
                  disabled={isPullingRules}
                  className="dash-outline-btn text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  <span>Pull into Builder</span>
                </button>
              )}

              <button
                type="button"
                onClick={fetchAutomationsDiag}
                disabled={automationsLoading}
                className="dash-outline-btn text-xs p-1.5"
                title="Refresh diagnostics"
              >
                <RefreshCw className={`w-4 h-4 ${automationsLoading ? 'animate-spin' : ''}`} />
              </button>
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
                  <button
                    type="button"
                    onClick={onNavigateToAutomations}
                    className="dash-outline-btn text-xs py-1.5 px-4 font-semibold text-cyan-300"
                  >
                    Open Automation Builder
                  </button>
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
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                  mqttConfig.connected
                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/80'
                    : mqttConfig.enabled
                    ? 'bg-amber-950/60 text-amber-300 border-amber-800/80'
                    : 'bg-slate-800 text-slate-400 border-slate-700/60'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
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
              </span>

              <button
                type="button"
                onClick={fetchMqtt}
                disabled={mqttLoading}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                title="Refresh MQTT Status"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${mqttLoading ? 'animate-spin text-cyan-400' : ''}`} />
              </button>
            </div>
          </div>

          {/* Configuration Form */}
          <form onSubmit={handleSaveMqtt} className="space-y-5 max-w-2xl">
            {/* Toggle Enable */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
              <div>
                <label className="text-xs font-bold text-[var(--text-heading)] block cursor-pointer" htmlFor="chk-mqtt-en">
                  Enable MQTT Client
                </label>
                <span className="text-[11px] text-[var(--text-muted)]">
                  Connect to MQTT broker and stream real-time vehicle telemetry states
                </span>
              </div>
              <input
                id="chk-mqtt-en"
                type="checkbox"
                checked={mqttConfig.enabled}
                onChange={(e) => setMqttConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500/30 bg-slate-800 border-slate-700 cursor-pointer"
              />
            </div>

            {/* Toggle HA Generic Discovery */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
              <div>
                <label className="text-xs font-bold text-[var(--text-heading)] block cursor-pointer" htmlFor="chk-mqtt-disco">
                  Broadcast Generic MQTT Auto-Discovery
                </label>
                <span className="text-[11px] text-[var(--text-muted)]">
                  Publish legacy <code className="text-cyan-400 font-mono">homeassistant/.../config</code> topics. <strong className="text-amber-400 font-semibold">Leave disabled (recommended)</strong> when using the native CAN Do Home Assistant integration to avoid duplicate entities.
                </span>
              </div>
              <input
                id="chk-mqtt-disco"
                type="checkbox"
                checked={!!mqttConfig.ha_discovery}
                onChange={(e) => setMqttConfig((prev) => ({ ...prev, ha_discovery: e.target.checked }))}
                className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500/30 bg-slate-800 border-slate-700 cursor-pointer"
              />
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

              <button
                type="submit"
                disabled={mqttSaving}
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
              </button>
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
                <div className="text-base font-bold text-cyan-300 mt-0.5">
                  {wifi?.sta_ip || '--'}
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
                <div className="text-[11px] text-[var(--text-muted)] mt-1">
                  AP IP: {wifi?.ap_ip || '192.168.4.1'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)]">
                <div className="text-[var(--text-muted)]">Signal & Clients</div>
                <div className="text-base font-bold text-[var(--text-heading)] mt-0.5 flex items-center gap-1.5">
                  {wifi?.sta_rssi ? (
                    <>
                      {getSignalIcon(wifi.sta_rssi)}
                      <span>{wifi.sta_rssi} dBm</span>
                    </>
                  ) : (
                    '--'
                  )}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] mt-1">
                  Connected clients: {wifi?.ap_clients ?? 0}
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
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold transition shadow"
              >
                Save Roaming Network
              </button>
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
                    <button
                      type="button"
                      onClick={() => handleDeleteNetwork(net.ssid)}
                      className="text-rose-400 hover:text-rose-300 text-xs font-semibold p-1 hover:underline"
                    >
                      Delete
                    </button>
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
              <button
                type="button"
                onClick={handleScanWifi}
                disabled={scanning}
                className="dash-outline-btn text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                <span>{scanning ? 'Scanning Airwaves...' : 'Scan Networks'}</span>
              </button>
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
                    <span className="text-[var(--text-muted)] font-mono text-[10px] shrink-0">
                      {res.rssi} dBm
                    </span>
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
          TAB 4: System & Software Updates
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
              <button
                type="button"
                onClick={handleCheckForUpdates}
                disabled={isCheckingUpdate || isExecutingUpdate}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 text-white text-xs font-bold transition shadow-md shadow-cyan-600/20"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdate ? 'animate-spin' : ''}`} />
                <span>{isCheckingUpdate ? 'Checking...' : 'Check for Updates'}</span>
              </button>

              {onRerunOnboarding && (
                <button
                  type="button"
                  onClick={onRerunOnboarding}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
                  title="Re-run the initial vehicle & unit setup wizard"
                >
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Setup Wizard</span>
                </button>
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
                  <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />
                  <span>{updateMessage || 'Applying Updates...'}</span>
                </span>
                <span className="font-mono text-cyan-300">{updateProgressPct}%</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-cyan-500 to-teal-400 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${updateProgressPct}%` }}
                />
              </div>
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
                  <button
                    type="button"
                    onClick={handleInstallCloudUpdates}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 text-slate-950 text-xs font-bold transition shadow-lg shadow-cyan-950/50 shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{updateResult.is_rebuild ? 'Re-sync & Update Now' : 'Install Updates Now'}</span>
                  </button>
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

          {/* Direct Firmware Binary (.bin) Upload Card */}
          <div className="can-do-card p-4 sm:p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="text-xs sm:text-sm font-bold text-[var(--text-heading)] flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-cyan-400" />
                  Manual Firmware Flashing (.bin)
                </h4>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Flash a pre-compiled firmware image directly to the ESP32 OTA partition over local Wi-Fi without cloud reliance
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

            <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-700/80 hover:border-cyan-500/60 rounded-xl bg-slate-900/40 hover:bg-slate-900/60 cursor-pointer transition group">
              <Upload className="w-6 h-6 text-slate-400 group-hover:text-cyan-400 transition mb-1.5" />
              <span className="text-xs font-semibold text-slate-200 group-hover:text-white transition">
                Select or Drop .bin Firmware File to Flash
              </span>
              <span className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {isAtomBridge
                  ? 'Accepts can-do-atom-bridge-*.bin (application binary)'
                  : 'Accepts can-do-esp32c3-*.bin or can-do.bin (application binary)'}
              </span>
              <input
                type="file"
                accept=".bin"
                disabled={isExecutingUpdate}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleManualBinaryUpload(file);
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />
            </label>
          </div>

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
                    <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={localPrefs.update_components.frontend}
                        onChange={(e) =>
                          handleSavePreferences({
                            update_components: { ...localPrefs.update_components, frontend: e.target.checked },
                          })
                        }
                        className="rounded border-slate-700 text-cyan-500 focus:ring-0"
                      />
                      <span>Web Front-End</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={localPrefs.update_components.catalog}
                        onChange={(e) =>
                          handleSavePreferences({
                            update_components: { ...localPrefs.update_components, catalog: e.target.checked },
                          })
                        }
                        className="rounded border-slate-700 text-cyan-500 focus:ring-0"
                      />
                      <span>Message Catalog</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={localPrefs.update_components.firmware}
                        onChange={(e) =>
                          handleSavePreferences({
                            update_components: { ...localPrefs.update_components, firmware: e.target.checked },
                          })
                        }
                        className="rounded border-slate-700 text-cyan-500 focus:ring-0"
                      />
                      <span>Firmware Binary</span>
                    </label>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-cyan-400" />
                      Off-Hours Scheduled Time:
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        handleSavePreferences({
                          update_schedule: { ...localPrefs.update_schedule, enabled: !localPrefs.update_schedule.enabled },
                        })
                      }
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        localPrefs.update_schedule.enabled ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {localPrefs.update_schedule.enabled ? 'ENABLED' : 'DISABLED'}
                    </button>
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
                <div className="flex items-center gap-3 pt-1">
                  <input
                    type="range"
                    min="11.5"
                    max="12.8"
                    step="0.1"
                    value={localPrefs.min_12v_gate_voltage ?? 12.2}
                    onChange={(e) =>
                      handleSavePreferences({ min_12v_gate_voltage: parseFloat(e.target.value) })
                    }
                    className="w-full accent-amber-400 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
                  />
                </div>
              </div>

              {/* Quiet / Offline Hours */}
              <div className="p-3.5 rounded-xl border border-slate-700/60 bg-slate-800/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Moon className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-semibold text-white">Quiet / Offline Hours</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      handleSavePreferences({ quiet_hours_enabled: !localPrefs.quiet_hours_enabled })
                    }
                    className={`text-[10px] px-2 py-0.5 rounded font-bold transition ${
                      localPrefs.quiet_hours_enabled
                        ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                        : 'bg-slate-700/50 text-slate-400 border border-slate-600'
                    }`}
                  >
                    {localPrefs.quiet_hours_enabled ? 'ENABLED' : 'DISABLED'}
                  </button>
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

          {/* Manual Binary Upload (Legacy / Custom Dev Builds) */}
          <div className="can-do-card p-4 sm:p-5 space-y-4">
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-[var(--text-heading)] flex items-center gap-2">
                <Upload className="w-4 h-4 text-slate-400" />
                Manual Firmware Binary Flash (Custom Builds)
              </h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Flash a custom-compiled ESP32 binary directly without a USB cable
              </p>
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

              <button
                type="submit"
                disabled={!otaFile || otaUploading}
                className="w-full py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold text-xs transition shadow-md shadow-cyan-600/20"
              >
                {otaUploading ? 'Flashing Firmware...' : 'Flash Firmware Binary'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
