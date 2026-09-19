import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Cpu,
  Wifi,
  Radio,
  Activity,
  Terminal,
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
  Settings2
} from 'lucide-react';

interface SystemStatus {
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
  free_heap?: number;
  uptime_sec?: number;
}

interface WifiStatus {
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

interface KnownNetwork {
  ssid: string;
  password?: string;
  priority: number;
}

interface WifiScanResult {
  ssid: string;
  rssi: number;
  authmode: number;
  in_known_list: boolean;
}

interface CanFrame {
  id: string;
  dlc: number;
  data: string;
  count: number;
  timestamp: string;
  lastIntervalMs?: number;
  lastSeen: number;
}

interface AutomationDiag {
  id: string;
  name: string;
  enabled: boolean;
  trigger_count: number;
  last_fired?: string;
  conditions_met?: boolean;
}

interface DeviceDashboardProps {
  onSyncAutomationsToDevice?: () => Promise<void>;
  onPullAutomationsFromDevice?: () => Promise<void>;
}

export const DeviceDashboard: React.FC<DeviceDashboardProps> = ({
  onSyncAutomationsToDevice,
  onPullAutomationsFromDevice
}) => {
  // Device endpoint config (local storage for dev mode)
  const isEmbedded = !window.location.port || window.location.port !== '3000';
  const [deviceHost, setDeviceHost] = useState<string>(() => {
    return localStorage.getItem('cando_device_host') || (isEmbedded ? window.location.origin : 'http://192.168.107.50');
  });

  const getApiUrl = useCallback((endpoint: string) => {
    const base = deviceHost.replace(/\/$/, '');
    return `${base}${endpoint}`;
  }, [deviceHost]);

  // Connection state
  const [connected, setConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [wifi, setWifi] = useState<WifiStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'sniffer' | 'automations' | 'wifi' | 'console' | 'ota'>('sniffer');

  // Sniffer state
  const [snifferFrames, setSnifferFrames] = useState<Map<string, CanFrame>>(new Map());
  const [snifferPaused, setSnifferPaused] = useState<boolean>(false);
  const [snifferFilter, setSnifferFilter] = useState<string>('');
  const framesRef = useRef<Map<string, CanFrame>>(new Map());
  const isPausedRef = useRef<boolean>(false);
  isPausedRef.current = snifferPaused;

  // Automations diag state
  const [automations, setAutomations] = useState<AutomationDiag[]>([]);
  const [automationsLoading, setAutomationsLoading] = useState<boolean>(false);
  const [actionNotice, setActionNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Wi-Fi manager state
  const [networks, setNetworks] = useState<KnownNetwork[]>([]);
  const [scanResults, setScanResults] = useState<WifiScanResult[]>([]);
  const [scanning, setScanning] = useState<boolean>(false);
  const [newSsid, setNewSsid] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newPriority, setNewPriority] = useState<number>(50);

  // Console terminal state
  const [logs, setLogs] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // OTA state
  const [otaFile, setOtaFile] = useState<File | null>(null);
  const [otaUploading, setOtaUploading] = useState<boolean>(false);
  const [otaProgress, setOtaProgress] = useState<number>(0);
  const [otaStatus, setOtaStatus] = useState<string>('');

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);

  // Show temporary action banner
  const showNotice = (message: string, type: 'success' | 'error' = 'success') => {
    setActionNotice({ message, type });
    setTimeout(() => setActionNotice(null), 4000);
  };

  // Connect WebSocket
  const connectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    let wsUrl: string;
    try {
      const parsed = new URL(deviceHost);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProto}//${parsed.host}/ws`;
    } catch {
      wsUrl = 'ws://192.168.4.1/ws';
    }

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        fetchStatus();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'log') {
            setLogs((prev) => [...prev.slice(-300), data.msg || JSON.stringify(data)]);
          } else if (data.type === 'can_frame') {
            if (!isPausedRef.current) {
              const now = Date.now();
              const idKey = data.id.toUpperCase();
              const existing = framesRef.current.get(idKey);
              const interval = existing ? now - existing.lastSeen : undefined;

              const updated: CanFrame = {
                id: idKey,
                dlc: data.dlc ?? 8,
                data: data.data || '',
                count: (existing?.count || 0) + 1,
                timestamp: new Date().toLocaleTimeString(),
                lastIntervalMs: interval,
                lastSeen: now
              };

              framesRef.current.set(idKey, updated);
              setSnifferFrames(new Map(framesRef.current));
            }
          } else if (data.type === 'automation_fired') {
            showNotice(`Automation Triggered: ${data.rule_id || data.id || 'Rule'}`, 'success');
            fetchAutomationsDiag();
          }
        } catch {
          setLogs((prev) => [...prev.slice(-300), event.data]);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setTimeout(connectWs, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setConnected(false);
    }
  }, [deviceHost]);

  // REST: Fetch system status
  const fetchStatus = async () => {
    try {
      const res = await fetch(getApiUrl('/api/system/status'));
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        setConnected(true);
      }
    } catch {
      setConnected(false);
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
        setNetworks(data || []);
      }
    } catch {}
  };

  // REST: Fetch automation diagnostics
  const fetchAutomationsDiag = async () => {
    setAutomationsLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/automations/diagnostics'));
      if (res.ok) {
        const data = await res.json();
        setAutomations(data || []);
      }
    } catch {
    } finally {
      setAutomationsLoading(false);
    }
  };

  useEffect(() => {
    connectWs();
    fetchStatus();
    fetchWifi();
    const interval = setInterval(() => {
      fetchStatus();
    }, 4000);

    return () => {
      clearInterval(interval);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs]);

  useEffect(() => {
    if (activeTab === 'automations') fetchAutomationsDiag();
    if (activeTab === 'wifi') {
      fetchWifi();
      fetchNetworks();
    }
  }, [activeTab]);

  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

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
        showNotice(`Automations ${!status.automations_enabled ? 'ENABLED' : 'DISABLED'}`);
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
        showNotice(`Sniffer mode ${!status.sniffer_mode ? 'ACTIVATED (Tx Blocked)' : 'DEACTIVATED'}`);
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
        showNotice(`Hardware listen-only ${!status.hardware_listen_only ? 'ENABLED (Zero PHY ACKs)' : 'DISABLED'}`);
      }
    } catch (e: any) {
      showNotice(`Failed to toggle listen-only: ${e.message}`, 'error');
    }
  };

  // Wi-Fi: Scan
  const handleScanWifi = async () => {
    setScanning(true);
    try {
      const res = await fetch(getApiUrl('/api/wifi/scan'));
      if (res.ok) {
        const data = await res.json();
        setScanResults(data || []);
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
        showNotice(`Saved network '${newSsid}'`);
      }
    } catch (e: any) {
      showNotice(`Failed to save network: ${e.message}`, 'error');
    }
  };

  // Wi-Fi: Delete Network
  const handleDeleteNetwork = async (ssid: string) => {
    try {
      const res = await fetch(getApiUrl(`/api/wifi/networks?ssid=${encodeURIComponent(ssid)}`), {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchNetworks();
        showNotice(`Removed network '${ssid}'`);
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
        setOtaStatus('Firmware uploaded successfully! Device is rebooting into the new version...');
        showNotice('Firmware flashed! Device rebooting in 5s.', 'success');
        setOtaFile(null);
      } else {
        setOtaStatus(`Update failed: ${xhr.responseText || xhr.statusText}`);
      }
      setOtaUploading(false);
    };

    xhr.onerror = () => {
      setOtaStatus('Network error during OTA upload');
      setOtaUploading(false);
    };

    xhr.send(otaFile);
  };

  // Filtered sniffer frames
  const filteredFrames = Array.from(snifferFrames.values()).filter((f) => {
    if (!snifferFilter) return true;
    const q = snifferFilter.toUpperCase();
    return f.id.includes(q) || f.data.toUpperCase().includes(q);
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Top Banner & Target Host Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-md shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white tracking-tight">CAN Do Edge Engine Console</h1>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
                  connected
                    ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/80'
                    : 'bg-rose-950/80 text-rose-300 border border-rose-800/80'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-ping' : 'bg-rose-400'}`} />
                {connected ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <div className="text-xs text-slate-400 font-mono mt-0.5">
              ID: <span className="text-cyan-300 font-semibold">{status?.device_id || 'Connecting...'}</span>
              {status?.gvret_clients !== undefined && (
                <span className="ml-3 text-slate-500">
                  GVRET TCP Clients: <span className="text-slate-300 font-bold">{status.gvret_clients}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Device target input for dev / remote mode */}
        <div className="flex items-center gap-2 text-xs">
          <Globe className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={deviceHost}
            onChange={(e) => {
              setDeviceHost(e.target.value);
              localStorage.setItem('cando_device_host', e.target.value);
            }}
            placeholder="http://192.168.107.50"
            className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono text-xs w-48 focus:outline-none focus:border-cyan-500"
            title="Device URL or IP. On the device itself, this defaults to the origin."
          />
          <button
            type="button"
            onClick={() => {
              connectWs();
              fetchStatus();
            }}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
            title="Reconnect"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Action Notification Alert */}
      {actionNotice && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all ${
            actionNotice.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-800 text-emerald-200'
              : 'bg-rose-950/80 border-rose-800 text-rose-200'
          }`}
        >
          <span>{actionNotice.message}</span>
          <button type="button" onClick={() => setActionNotice(null)} className="text-slate-400 hover:text-white ml-4">
            ✕
          </button>
        </div>
      )}

      {/* Quick Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Metric 1: Automations */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Automations</span>
            <Zap className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div
            className={`text-lg font-bold font-mono ${
              status?.automations_enabled ? 'text-emerald-400' : 'text-slate-500'
            }`}
          >
            {status?.automations_enabled ? 'ACTIVE' : 'DISABLED'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Rule execution engine</div>
        </div>

        {/* Metric 2: TWAI CAN State */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>CAN Controller</span>
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <div className="text-lg font-bold font-mono text-cyan-300 uppercase">
            {status?.twai_state || '--'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {status?.hardware_listen_only ? 'Listen-Only (No ACK)' : 'Normal Mode'}
          </div>
        </div>

        {/* Metric 3: Wi-Fi Signal */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Wi-Fi Link</span>
            <Wifi className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div className="text-base font-bold text-slate-200 truncate font-mono">
            {wifi?.sta_ssid || 'No STA'}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono">
            {wifi?.sta_ip || '192.168.4.1'} {wifi?.sta_rssi ? `(${wifi.sta_rssi} dBm)` : ''}
          </div>
        </div>

        {/* Metric 4: Sniffer Protection */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Passive Sniffer</span>
            <Shield className="w-3.5 h-3.5 text-orange-400" />
          </div>
          <div
            className={`text-lg font-bold font-mono ${
              status?.sniffer_mode ? 'text-amber-400' : 'text-slate-500'
            }`}
          >
            {status?.sniffer_mode ? 'BLOCKING TX' : 'OFF'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {status?.sniffer_mode ? 'Zero Tx Interference' : 'Bi-Directional Tx Allowed'}
          </div>
        </div>
      </div>

      {/* Engine Controls Section */}
      <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-xl space-y-4">
        <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <Sliders className="w-4 h-4 text-cyan-400" />
          Engine Hardware & Software Controls
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Toggle 1: Automations */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition">
            <div className="space-y-0.5">
              <div className="text-xs font-semibold text-white">Rule Execution</div>
              <div className="text-[11px] text-slate-400">Trigger/condition evaluation</div>
            </div>
            <button
              type="button"
              onClick={handleToggleAutomations}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                status?.automations_enabled
                  ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {status?.automations_enabled ? 'ENABLED' : 'DISABLED'}
            </button>
          </div>

          {/* Toggle 2: Passive Sniffer */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition">
            <div className="space-y-0.5">
              <div className="text-xs font-semibold text-white">Passive Sniffer</div>
              <div className="text-[11px] text-slate-400">Block all manual & auto Tx</div>
            </div>
            <button
              type="button"
              onClick={handleToggleSniffer}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                status?.sniffer_mode
                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-lg shadow-amber-500/20'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {status?.sniffer_mode ? 'ACTIVE' : 'OFF'}
            </button>
          </div>

          {/* Toggle 3: Hardware Listen Only */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition">
            <div className="space-y-0.5">
              <div className="text-xs font-semibold text-white">Hardware Listen-Only</div>
              <div className="text-[11px] text-slate-400">Zero PHY ACK bits on bus</div>
            </div>
            <button
              type="button"
              onClick={handleToggleListenOnly}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                status?.hardware_listen_only
                  ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow-lg shadow-cyan-500/20'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {status?.hardware_listen_only ? 'STEALTH' : 'NORMAL'}
            </button>
          </div>
        </div>

        {/* Warning Banner if Sniffer is active */}
        {status?.sniffer_mode && (
          <div className="p-3 rounded-xl bg-amber-950/70 border border-amber-800 text-amber-200 text-xs font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Passive Sniffer Mode is active: Outgoing CAN packets are strictly silenced to protect bus diagnostics.</span>
          </div>
        )}
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2 text-xs font-semibold">
        <button
          type="button"
          onClick={() => setActiveTab('sniffer')}
          className={`px-3 py-2 rounded-xl transition flex items-center gap-2 ${
            activeTab === 'sniffer'
              ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 shadow'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Activity className="w-4 h-4" />
          Live Bus Sniffer ({snifferFrames.size})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('automations')}
          className={`px-3 py-2 rounded-xl transition flex items-center gap-2 ${
            activeTab === 'automations'
              ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 shadow'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Zap className="w-4 h-4" />
          Automations Diagnostics
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('wifi')}
          className={`px-3 py-2 rounded-xl transition flex items-center gap-2 ${
            activeTab === 'wifi'
              ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 shadow'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Wifi className="w-4 h-4" />
          Wi-Fi & SoftAP
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('console')}
          className={`px-3 py-2 rounded-xl transition flex items-center gap-2 ${
            activeTab === 'console'
              ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 shadow'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Terminal className="w-4 h-4" />
          Live Console Log
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('ota')}
          className={`px-3 py-2 rounded-xl transition flex items-center gap-2 ${
            activeTab === 'ota'
              ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 shadow'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Cpu className="w-4 h-4" />
          Firmware OTA
        </button>
      </div>

      {/* TAB 1: Live Bus Sniffer */}
      {activeTab === 'sniffer' && (
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={snifferFilter}
                onChange={(e) => setSnifferFilter(e.target.value)}
                placeholder="Filter by CAN ID (e.g. 0x226) or Hex Data..."
                className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSnifferPaused(!snifferPaused)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                  snifferPaused
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-slate-800 text-slate-300 hover:text-white'
                }`}
              >
                {snifferPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                {snifferPaused ? 'Resume' : 'Pause'}
              </button>

              <button
                type="button"
                onClick={() => {
                  framesRef.current.clear();
                  setSnifferFrames(new Map());
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60 max-h-[500px]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3">CAN ID</th>
                  <th className="py-2.5 px-3">DLC</th>
                  <th className="py-2.5 px-3">Data Bytes (Hex)</th>
                  <th className="py-2.5 px-3">Count</th>
                  <th className="py-2.5 px-3">Interval (ms)</th>
                  <th className="py-2.5 px-3">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredFrames.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-slate-500">
                      {connected
                        ? 'Listening for vehicle CAN frames on TWAI bus...'
                        : 'Connect to CAN Do device to view live telemetry.'}
                    </td>
                  </tr>
                ) : (
                  filteredFrames.map((frame) => (
                    <tr key={frame.id} className="hover:bg-slate-900/60 transition-colors">
                      <td className="py-2 px-3 font-bold text-cyan-400">{frame.id}</td>
                      <td className="py-2 px-3 text-slate-400">{frame.dlc}</td>
                      <td className="py-2 px-3 font-mono text-emerald-300 tracking-wider">
                        {frame.data.match(/.{1,2}/g)?.join(' ') || frame.data}
                      </td>
                      <td className="py-2 px-3 text-slate-300 font-semibold">{frame.count}</td>
                      <td className="py-2 px-3 text-slate-400">{frame.lastIntervalMs ?? '--'}</td>
                      <td className="py-2 px-3 text-slate-500">{frame.timestamp}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: Automations & Diagnostics */}
      {activeTab === 'automations' && (
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-white">Live Edge Automations Diagnostics</h3>
              <p className="text-xs text-slate-400">Rules loaded on device storage executing at microsecond latency</p>
            </div>
            <div className="flex items-center gap-2">
              {onSyncAutomationsToDevice && (
                <button
                  type="button"
                  onClick={async () => {
                    await onSyncAutomationsToDevice();
                    showNotice('Synchronized active rules to device storage');
                    fetchAutomationsDiag();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow"
                >
                  <ArrowUpFromLine className="w-3.5 h-3.5" />
                  Deploy Rules to Device
                </button>
              )}
              {onPullAutomationsFromDevice && (
                <button
                  type="button"
                  onClick={async () => {
                    await onPullAutomationsFromDevice();
                    showNotice('Pulled device automations into editor');
                  }}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs flex items-center gap-1.5"
                >
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  Pull from Device
                </button>
              )}
              <button
                type="button"
                onClick={fetchAutomationsDiag}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {automations.length === 0 ? (
              <div className="col-span-2 text-center py-10 text-slate-500 border border-dashed border-slate-800 rounded-xl">
                {automationsLoading ? 'Fetching diagnostics...' : 'No active automation rules on device.'}
              </div>
            ) : (
              automations.map((rule) => (
                <div key={rule.id} className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-white truncate">{rule.name || rule.id}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                        rule.enabled ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {rule.enabled ? 'ACTIVE' : 'MUTED'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-2 border-t border-slate-800/60 text-slate-400">
                    <div>
                      Triggers Fired:{' '}
                      <span className="text-amber-300 font-semibold">{rule.trigger_count || 0}</span>
                    </div>
                    <div>
                      Last Fired: <span className="text-slate-300">{rule.last_fired || 'Never'}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Wi-Fi & SoftAP Manager */}
      {activeTab === 'wifi' && (
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-6">
          {/* Active Connection Information */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Wi-Fi Connection Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-slate-500">STA Status</div>
                <div className="text-slate-200 font-bold mt-0.5">{wifi?.sta_connected ? 'CONNECTED' : 'DISCONNECTED'}</div>
              </div>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-slate-500">IP Address</div>
                <div className="text-cyan-300 font-bold mt-0.5">{wifi?.sta_ip || '--'}</div>
              </div>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-slate-500">Gateway</div>
                <div className="text-slate-300 mt-0.5">{wifi?.sta_gw || '--'}</div>
              </div>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-slate-500">SoftAP SSID</div>
                <div className="text-slate-300 mt-0.5 font-bold">{wifi?.ap_ssid || 'CAN Do'}</div>
              </div>
            </div>
          </div>

          {/* Add Known Network Form */}
          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <h4 className="text-xs font-bold text-slate-300">Add Wi-Fi Network (Auto-Roaming)</h4>
            <form onSubmit={handleAddNetwork} className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
              <input
                type="text"
                value={newSsid}
                onChange={(e) => setNewSsid(e.target.value)}
                placeholder="Network SSID"
                required
                className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-cyan-500"
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Password (optional for open)"
                className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-cyan-500"
              />
              <input
                type="number"
                value={newPriority}
                onChange={(e) => setNewPriority(Number(e.target.value))}
                placeholder="Priority (1-100)"
                className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-cyan-500"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold transition shadow"
              >
                Save Network
              </button>
            </form>
          </div>

          {/* Known Networks List */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Configured Roaming Networks</h4>
            <div className="divide-y divide-slate-800/60 rounded-xl border border-slate-800 bg-slate-950">
              {networks.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">No known networks saved on device.</div>
              ) : (
                networks.map((net) => (
                  <div key={net.ssid} className="p-3 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Wifi className="w-4 h-4 text-cyan-400" />
                      <span className="font-bold text-slate-200">{net.ssid}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                        Priority: {net.priority}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteNetwork(net.ssid)}
                      className="text-rose-400 hover:text-rose-300 text-xs font-semibold p-1"
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
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Nearby Wi-Fi Networks</h4>
              <button
                type="button"
                onClick={handleScanWifi}
                disabled={scanning}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? 'Scanning...' : 'Scan Networks'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {scanResults.map((res, i) => (
                <div
                  key={`${res.ssid}-${i}`}
                  onClick={() => setNewSsid(res.ssid)}
                  className="p-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-cyan-500/40 cursor-pointer transition text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200 truncate">{res.ssid}</span>
                    <span className="text-slate-400 font-mono text-[10px]">{res.rssi} dBm</span>
                  </div>
                  <div className="text-[10px] text-slate-500">Click to fill SSID</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Live Console / Terminal */}
      {activeTab === 'console' && (
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">ESP32 Firmware Log Stream</h3>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900"
                />
                Auto-scroll
              </label>
              <button
                type="button"
                onClick={() => setLogs([])}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-slate-300 h-96 overflow-y-auto space-y-1 border border-slate-800/80">
            {logs.length === 0 ? (
              <div className="text-slate-600">Waiting for log stream via WebSocket...</div>
            ) : (
              logs.map((line, idx) => (
                <div key={idx} className="leading-relaxed hover:bg-slate-900/40 px-1 rounded">
                  {line}
                </div>
              ))
            )}
            <div ref={terminalEndRef} />
          </div>
        </div>
      )}

      {/* TAB 5: Firmware OTA Update */}
      {activeTab === 'ota' && (
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Over-The-Air (OTA) Firmware Upgrade</h3>
            <p className="text-xs text-slate-400">Flash new firmware directly to the active partition without cables</p>
          </div>

          <form onSubmit={handleOtaUpload} className="space-y-4 max-w-lg">
            <div className="p-6 rounded-2xl border-2 border-dashed border-slate-800 hover:border-cyan-500/50 transition-colors text-center bg-slate-950">
              <Upload className="w-8 h-8 text-cyan-400 mx-auto mb-2" />
              <div className="text-xs font-semibold text-slate-300">
                {otaFile ? otaFile.name : 'Select firmware binary (.bin)'}
              </div>
              <input
                type="file"
                accept=".bin"
                onChange={(e) => setOtaFile(e.target.files?.[0] || null)}
                className="mt-3 block w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-cyan-300 hover:file:bg-slate-700"
              />
            </div>

            {otaUploading && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono text-slate-400">
                  <span>Uploading...</span>
                  <span>{otaProgress}%</span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                  <div className="bg-cyan-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${otaProgress}%` }} />
                </div>
              </div>
            )}

            {otaStatus && <div className="text-xs font-mono text-cyan-300">{otaStatus}</div>}

            <button
              type="submit"
              disabled={!otaFile || otaUploading}
              className="w-full py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold text-xs transition shadow-lg shadow-cyan-600/20"
            >
              {otaUploading ? 'Flashing Firmware...' : 'Upload & Flash Firmware'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
