import React, { useState, useEffect } from 'react';
import {
  Bluetooth,
  Radio,
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Smartphone,
  Keyboard,
  Volume2,
  VolumeX,
  Play,
  SkipForward,
  SkipBack,
  Camera,
  Plus,
  Trash2,
  Signal,
  SignalHigh,
  SignalMedium,
  SignalLow,
  ExternalLink,
  Zap,
  Info
} from 'lucide-react';
import { BleStatus, BleDeviceInfo, BleButtonEvent, BeaconTarget, DiscoveredBeacon } from '../types/ble';
import { AutomationTrigger } from '../types/automation';
import { deviceWs } from '../services/deviceWs';

interface BluetoothManagerProps {
  deviceHost: string;
  onSelectTriggerForAutomation?: (trigger: AutomationTrigger) => void;
}

export const BluetoothManager: React.FC<BluetoothManagerProps> = ({
  deviceHost,
  onSelectTriggerForAutomation
}) => {
  const [status, setStatus] = useState<BleStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSecondsLeft, setScanSecondsLeft] = useState(0);
  const [recentEvents, setRecentEvents] = useState<BleButtonEvent[]>([]);
  const [activePressedButton, setActivePressedButton] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Beacon & Phone Proximity state
  const [beaconName, setBeaconName] = useState('My Phone');
  const [beaconUuid, setBeaconUuid] = useState('');
  const [beaconEnterRssi, setBeaconEnterRssi] = useState(-75);
  const [beaconExitTimeout, setBeaconExitTimeout] = useState(45);
  const [savingBeacon, setSavingBeacon] = useState(false);

  const resolveUrl = (path: string) => {
    const cleanHost = (deviceHost === 'auto' || !deviceHost)
      ? (typeof window !== 'undefined' ? window.location.origin : 'http://192.168.4.1')
      : deviceHost.replace(/\/+$/, '');
    return `${cleanHost}${path.startsWith('/') ? path : `/${path}`}`;
  };

  const showNotice = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotice({ message, type });
    setTimeout(() => setNotice(null), 5000);
  };

  // Poll BLE status
  const fetchStatus = async () => {
    try {
      const res = await fetch(resolveUrl('/api/ble/status'));
      if (res.ok) {
        const data: BleStatus = await res.json();
        setStatus(data);
        if (data.scanning) {
          setScanning(true);
        }
        if (data.recent_events && data.recent_events.length > 0) {
          setRecentEvents(data.recent_events);
        } else if (data.last_event) {
          setRecentEvents(prev => {
            if (prev.length === 0 || prev[0].timestamp_ms !== data.last_event?.timestamp_ms) {
              return [data.last_event!, ...prev.slice(0, 49)];
            }
            return prev;
          });
        }
      }
    } catch {
      // Offline / not reachable
    }
  };

  // Subscribe to real-time WebSocket events from WiCAN / Atom Lite
  useEffect(() => {
    const unsub = deviceWs.subscribe((msg: any) => {
      if (msg && msg.type === 'ble_event') {
        const btn = msg.button_name || msg.button || 'button';
        const act = (msg.action || 'press') as 'press' | 'release' | 'hold';
        if (act === 'press') {
          setActivePressedButton(btn);
          setTimeout(() => setActivePressedButton(null), 600);
        }
        const eventItem: BleButtonEvent = {
          button_name: btn,
          action: act,
          device_name: msg.name || status?.connected_device?.name || 'BLE Device',
          device_address: msg.address || status?.connected_device?.address || '',
          timestamp_ms: Date.now()
        };
        setRecentEvents(prev => [eventItem, ...prev.slice(0, 49)]);
      } else if (msg && msg.type === 'ble_beacon') {
        setStatus(prev => {
          if (!prev || !prev.beacon_targets) return prev;
          const updatedTargets = prev.beacon_targets.map(tgt => {
            const matchUuid = msg.uuid && tgt.uuid && tgt.uuid.toLowerCase() === msg.uuid.toLowerCase();
            const matchMac = msg.mac && tgt.mac && tgt.mac.toLowerCase() === msg.mac.toLowerCase();
            if (matchUuid || matchMac) {
              return {
                ...tgt,
                is_present: msg.event === 'enter' || msg.event === 'proximity',
                rssi: typeof msg.rssi === 'number' ? msg.rssi : tgt.rssi,
                mac: msg.mac || tgt.mac,
                major: msg.major || tgt.major,
                minor: msg.minor || tgt.minor,
                last_seen_ms: Date.now()
              };
            }
            return tgt;
          });
          return { ...prev, beacon_targets: updatedTargets };
        });
      }
    });
    return () => unsub();
  }, [status]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [deviceHost]);

  // Start BLE scan
  const handleStartScan = async () => {
    setScanning(true);
    setScanSecondsLeft(10);
    try {
      const res = await fetch(resolveUrl('/api/ble/scan?duration=10'), { method: 'POST' });
      if (res.ok) {
        showNotice('Scanning for nearby Bluetooth buttons and keyboards...', 'info');
      } else {
        showNotice('Failed to initiate BLE scan', 'error');
      }
    } catch (e: any) {
      showNotice(`Scan error: ${e.message}`, 'error');
    }
  };

  // Scan countdown timer
  useEffect(() => {
    if (!scanning || scanSecondsLeft <= 0) {
      if (scanning && scanSecondsLeft <= 0) {
        setScanning(false);
        fetchStatus();
      }
      return;
    }
    const timer = setTimeout(() => {
      setScanSecondsLeft(prev => prev - 1);
      fetchStatus();
    }, 1000);
    return () => clearTimeout(timer);
  }, [scanning, scanSecondsLeft]);

  // Connect / Pair
  const handlePair = async (address: string) => {
    setLoading(true);
    try {
      const res = await fetch(resolveUrl('/api/ble/pair'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mac: address })
      });
      if (res.ok) {
        showNotice(`Connecting to ${address}...`, 'success');
        fetchStatus();
      } else {
        showNotice('Pairing failed', 'error');
      }
    } catch (e: any) {
      showNotice(`Pairing error: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Disconnect / Unpair
  const handleUnpair = async () => {
    setLoading(true);
    try {
      const res = await fetch(resolveUrl('/api/ble/unpair'), { method: 'POST' });
      if (res.ok) {
        showNotice('Bluetooth device disconnected', 'info');
        fetchStatus();
      }
    } catch (e: any) {
      showNotice(`Unpair error: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Test event injection directly into ESP32 engine
  const handleTestEvent = async (buttonName: string, action: 'press' | 'release' = 'press') => {
    setActivePressedButton(buttonName);
    setTimeout(() => setActivePressedButton(null), 600);

    // Add to local event log
    const eventItem: BleButtonEvent = {
      button_name: buttonName,
      action,
      device_name: status?.connected_device?.name || 'Virtual Simulator',
      device_address: status?.connected_device?.address || '00:00:00:00:00:00',
      timestamp_ms: Date.now()
    };
    setRecentEvents(prev => [eventItem, ...prev.slice(0, 49)]);

    try {
      await fetch(resolveUrl('/api/ble/test_event'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ button: buttonName, action })
      });
    } catch {
      // Ignored for simulation
    }
  };

  const handleCreateAutomationForButton = (button: string) => {
    if (onSelectTriggerForAutomation) {
      onSelectTriggerForAutomation({
        id: `trig_ble_${button}_${Date.now().toString(36)}`,
        source: 'ble',
        type: 'ble_button',
        ble_button: button,
        ble_action: 'press',
        ble_device: status?.connected_device?.address || ''
      });
      showNotice(`Created trigger for button '${button}'! Switch to Automations tab to complete rule.`, 'success');
    }
  };

  const handleAddBeacon = async () => {
    if (!beaconUuid.trim()) {
      showNotice('Please enter a Beacon UUID or MAC address', 'error');
      return;
    }
    setSavingBeacon(true);
    try {
      const isMac = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(beaconUuid.trim());
      const payload = {
        name: beaconName.trim() || 'Phone Beacon',
        uuid: isMac ? '' : beaconUuid.trim(),
        mac: isMac ? beaconUuid.trim() : '',
        enter_rssi: beaconEnterRssi,
        exit_timeout_s: beaconExitTimeout
      };
      const res = await fetch(resolveUrl('/api/ble/beacons'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showNotice(`Beacon target '${payload.name}' saved!`, 'success');
        setBeaconUuid('');
        fetchStatus();
      } else {
        showNotice('Failed to save beacon target', 'error');
      }
    } catch {
      showNotice('Error connecting to device', 'error');
    } finally {
      setSavingBeacon(false);
    }
  };

  const handleDeleteBeacon = async (uuid: string, mac: string) => {
    try {
      await fetch(resolveUrl('/api/ble/beacons'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, mac })
      });
      showNotice('Beacon target removed', 'info');
      fetchStatus();
    } catch {
      showNotice('Failed to delete beacon', 'error');
    }
  };

  const handleCalibrateBeacon = async (beacon: BeaconTarget, newRssi: number) => {
    try {
      const payload = {
        name: beacon.name,
        uuid: beacon.uuid || '',
        mac: beacon.mac || '',
        enter_rssi: newRssi,
        exit_timeout_s: beacon.exit_timeout_s || 45
      };
      const res = await fetch(resolveUrl('/api/ble/beacons'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showNotice(`Calibrated '${beacon.name}' threshold to ${newRssi} dBm!`, 'success');
        fetchStatus();
      } else {
        showNotice('Failed to calibrate beacon threshold', 'error');
      }
    } catch {
      showNotice('Error connecting to device', 'error');
    }
  };

  const handleCreateAutomationForBeacon = (beacon: BeaconTarget) => {
    if (onSelectTriggerForAutomation) {
      onSelectTriggerForAutomation({
        id: `trig_beacon_${Date.now().toString(36)}`,
        source: 'ble',
        type: 'ble_beacon',
        ble_event: 'enter',
        beacon_uuid: beacon.uuid || beacon.mac,
        target_rssi: beacon.enter_rssi
      });
      showNotice(`Created proximity trigger for '${beacon.name}'! Switch to Automations tab to complete rule.`, 'success');
    }
  };

  const handleCreateAutomationForDevice = (device: BleDeviceInfo) => {
    if (onSelectTriggerForAutomation) {
      onSelectTriggerForAutomation({
        id: `trig_ble_${Date.now().toString(36)}`,
        source: 'ble',
        type: 'ble_presence',
        ble_event: 'connected',
        ble_device: device.address,
        target_rssi: device.rssi || -75
      });
      showNotice(`Created proximity trigger for '${device.name || device.address}' (${device.rssi || -75} dBm)!`, 'success');
    }
  };

  const handleCreateAutomationForDiscoveredBeacon = (beacon: DiscoveredBeacon) => {
    if (onSelectTriggerForAutomation) {
      onSelectTriggerForAutomation({
        id: `trig_beacon_${Date.now().toString(36)}`,
        source: 'ble',
        type: 'ble_beacon',
        ble_event: 'enter',
        beacon_uuid: beacon.uuid || beacon.mac,
        target_rssi: beacon.rssi || -75
      });
      showNotice(`Created proximity trigger for iBeacon (${beacon.rssi} dBm)! Switch to Automations tab to complete rule.`, 'success');
    }
  };

  const getSignalIcon = (rssi?: number) => {
    if (!rssi) return <Signal className="w-3.5 h-3.5 text-slate-500" />;
    if (rssi >= -60) return <SignalHigh className="w-3.5 h-3.5 text-emerald-400" />;
    if (rssi >= -75) return <SignalMedium className="w-3.5 h-3.5 text-cyan-400" />;
    return <SignalLow className="w-3.5 h-3.5 text-amber-400" />;
  };

  const mediaButtons = [
    { id: 'volume_up', label: 'Volume Up (+)', icon: Volume2 },
    { id: 'volume_down', label: 'Volume Down (-)', icon: Volume2 },
    { id: 'play_pause', label: 'Play / Pause', icon: Play },
    { id: 'next_track', label: 'Next Track (>>)', icon: SkipForward },
    { id: 'prev_track', label: 'Prev Track (<<)', icon: SkipBack },
    { id: 'mute', label: 'Mute', icon: VolumeX },
    { id: 'shutter', label: 'Camera Shutter (Enter)', icon: Camera }
  ];

  const keypadButtons = [
    { id: 'key_1', label: '1' },
    { id: 'key_2', label: '2' },
    { id: 'key_3', label: '3' },
    { id: 'key_4', label: '4' },
    { id: 'key_5', label: '5' },
    { id: 'key_6', label: '6' },
    { id: 'key_7', label: '7' },
    { id: 'key_8', label: '8' },
    { id: 'key_9', label: '9' },
    { id: 'key_0', label: '0' }
  ];

  const connectedDev = status?.connected_device;

  return (
    <div className="space-y-5 select-none">
      {/* Action Notification Banner */}
      {notice && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all ${
            notice.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-800 text-emerald-200'
              : notice.type === 'error'
              ? 'bg-rose-950/80 border-rose-800 text-rose-200'
              : 'bg-cyan-950/80 border-cyan-800 text-cyan-200'
          }`}
        >
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white ml-2">✕</button>
        </div>
      )}

      {/* Header & Connection Status Deck */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
        {/* Status Card */}
        <div className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span className="font-semibold">Bluetooth</span>
            <Bluetooth className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-lg font-bold font-mono text-blue-300">
              {status?.enabled ? 'CENTRAL ACTIVE' : 'INITIALIZING'}
            </span>
          </div>
        </div>

        {/* Connected Controller Card */}
        <div className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span className="font-semibold">Paired Device</span>
            <Radio className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span
              className={`text-lg font-bold font-mono ${
                connectedDev ? 'text-emerald-400' : 'text-slate-500'
              }`}
            >
              {connectedDev ? (connectedDev.name || 'CONNECTED') : 'NO DEVICE'}
            </span>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center justify-between">
            <span className="font-mono">{connectedDev?.address || 'Ready for pairing'}</span>
            {connectedDev && (
              <button
                type="button"
                onClick={handleUnpair}
                disabled={loading}
                className="text-[11px] text-rose-400 hover:text-rose-300 font-semibold"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Signal & Battery Card */}
        <div className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span className="font-semibold">Link Quality</span>
            {getSignalIcon(connectedDev?.rssi)}
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-lg font-bold font-mono text-slate-200">
              {connectedDev && connectedDev.rssi ? `${connectedDev.rssi} dBm` : '--'}
            </span>
            {connectedDev?.battery_pct !== undefined && connectedDev.battery_pct >= 0 && (
              <span className="text-xs font-mono text-emerald-400">
                ({connectedDev.battery_pct}% batt)
              </span>
            )}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center justify-between flex-wrap gap-1">
            <span>Automations Hook</span>
            {connectedDev && onSelectTriggerForAutomation ? (
              <button
                type="button"
                onClick={() => handleCreateAutomationForDevice(connectedDev)}
                className="text-purple-300 hover:text-purple-200 bg-purple-950/60 hover:bg-purple-900 border border-purple-800/60 rounded px-1.5 py-0.5 text-[10px] font-semibold transition flex items-center gap-1 cursor-pointer"
                title="Create an automation triggered by this connected controller / keypad"
              >
                + Proximity Rule ({connectedDev.rssi || -75} dBm)
              </button>
            ) : (
              <span className="text-cyan-400 font-mono text-[10px]">HA Auto-Discovery Ready</span>
            )}
          </div>
        </div>
      </div>

      {/* Device Discovery & Scanner Bar */}
      <div className="can-do-card p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
              <Search className="w-4 h-4 text-blue-400" />
              Discover Nearby Bluetooth Controllers
            </h2>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Put your steering wheel button, macro keyboard, or phone in pairing mode and scan
            </p>
          </div>

          <button
            type="button"
            onClick={handleStartScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs shadow transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            <span>{scanning ? `Scanning (${scanSecondsLeft}s)...` : 'Scan for Devices'}</span>
          </button>
        </div>

        {/* Discovered Devices List */}
        {status?.discovered_devices && status.discovered_devices.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-2">
            {status.discovered_devices.map(device => {
              const isCurrent = connectedDev?.address === device.address;
              return (
                <div
                  key={device.address}
                  className={`p-3 rounded-xl border flex items-center justify-between transition-all ${
                    isCurrent
                      ? 'bg-blue-950/40 border-blue-600/80 shadow-sm'
                      : 'bg-[var(--input-bg)] border-[var(--border-color)] hover:border-slate-700'
                  }`}
                >
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-white truncate">
                        {device.name || `BLE Device [${device.address.slice(-8)}]`}
                      </span>
                      {getSignalIcon(device.rssi)}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                      {device.address} • {device.rssi} dBm
                    </div>
                  </div>

                  {isCurrent ? (
                    <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 text-[10px] font-semibold border border-emerald-800">
                      Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handlePair(device.address)}
                      disabled={loading}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition"
                    >
                      Pair
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-slate-950/50 border border-dashed border-slate-800 text-center text-xs text-slate-500">
            {scanning
              ? 'Listening for BLE advertisements...'
              : 'No Bluetooth devices detected in the last scan. Hold the pairing button on your remote and click Scan.'}
          </div>
        )}
      </div>

      {/* Button Simulation & Live Testing Panel */}
      <div className="can-do-card p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Interactive Button Tester & Automation Creator
            </h2>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Press any button on your physical remote or click below to simulate triggering automations
            </p>
          </div>
        </div>

        {/* Media / Shutter Buttons */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            Media & Steering Remote Buttons
          </span>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
            {mediaButtons.map(btn => {
              const Icon = btn.icon;
              const isPressed = activePressedButton === btn.id;
              return (
                <div key={btn.id} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => handleTestEvent(btn.id, 'press')}
                    className={`p-2.5 rounded-xl border text-center flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
                      isPressed
                        ? 'bg-blue-500 text-white border-blue-400 scale-95 shadow-md shadow-blue-900/50 ring-2 ring-blue-400'
                        : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${isPressed ? 'text-white' : 'text-blue-400'}`} />
                    <span className="text-[10px] font-semibold leading-tight line-clamp-1">{btn.label}</span>
                  </button>

                  {onSelectTriggerForAutomation && (
                    <button
                      type="button"
                      onClick={() => handleCreateAutomationForButton(btn.id)}
                      className="text-[9px] text-slate-500 hover:text-cyan-300 text-center transition"
                      title="Use in automation rule"
                    >
                      + Rule
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Macro Keypad (1 - 9) */}
        <div className="space-y-1.5 pt-2 border-t border-slate-800">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            Macro Keyboard Keypad (Keys 1 - 9)
          </span>
          <div className="grid grid-cols-3 sm:grid-cols-9 gap-2">
            {keypadButtons.map(btn => {
              const isPressed = activePressedButton === btn.id;
              return (
                <div key={btn.id} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => handleTestEvent(btn.id, 'press')}
                    className={`py-2 px-1 rounded-xl border text-center font-mono font-bold text-sm transition-all cursor-pointer ${
                      isPressed
                        ? 'bg-amber-500 text-slate-950 border-amber-400 scale-95 shadow-md ring-2 ring-amber-400'
                        : 'bg-slate-900 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                    }`}
                  >
                    {btn.label}
                  </button>
                  {onSelectTriggerForAutomation && (
                    <button
                      type="button"
                      onClick={() => handleCreateAutomationForButton(btn.id)}
                      className="text-[9px] text-slate-500 hover:text-amber-300 text-center transition"
                    >
                      + Rule
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* BLE Beacon & Phone Proximity Manager Card */}
      <div className="can-do-card p-4 sm:p-5 space-y-4 border border-purple-800/40 bg-slate-900/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-purple-400" />
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                BLE Beacons & Phone Proximity (iBeacon / Key Fobs)
                <span className="px-2 py-0.5 rounded-full bg-purple-950 text-purple-300 border border-purple-800 text-[10px] font-mono">
                  Walk-Up / Walk-Away
                </span>
              </h2>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Automatically trigger automations when your phone or BLE key fob enters or leaves vehicle range without pairing
              </p>
            </div>
          </div>
        </div>

        {/* Add Beacon Target Form */}
        {(() => {
          const heardBeacon = beaconUuid.trim() ? (
            status?.discovered_beacons?.find(b =>
              (b.uuid && b.uuid.toLowerCase() === beaconUuid.trim().toLowerCase()) ||
              (b.mac && b.mac.toLowerCase() === beaconUuid.trim().toLowerCase())
            ) ||
            status?.beacon_targets?.find(t =>
              (t.uuid && t.uuid.toLowerCase() === beaconUuid.trim().toLowerCase()) ||
              (t.mac && t.mac.toLowerCase() === beaconUuid.trim().toLowerCase())
            ) ||
            status?.paired_devices?.find(d =>
              d.address && d.address.toLowerCase() === beaconUuid.trim().toLowerCase()
            ) ||
            (status?.connected_device && status.connected_device.address?.toLowerCase() === beaconUuid.trim().toLowerCase()
              ? status.connected_device
              : undefined)
          ) : undefined;
          const liveHeardRssi = heardBeacon?.rssi;

          return (
            <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-bold text-purple-300 uppercase tracking-wider block">
                  Add or Track a Phone Beacon / Key Fob
                </span>
                {liveHeardRssi !== undefined && liveHeardRssi !== 0 && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-950 text-purple-300 border border-purple-800 animate-pulse">
                    <Signal className="w-3 h-3 text-purple-400" />
                    Live Heard: {liveHeardRssi} dBm
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 text-xs">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Friendly Name</label>
                  <input
                    type="text"
                    value={beaconName}
                    onChange={e => setBeaconName(e.target.value)}
                    placeholder="e.g. My iPhone"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-white"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[10px] text-slate-400 mb-1">
                    iBeacon UUID (Phone) or BLE MAC (Fob)
                  </label>
                  <input
                    type="text"
                    value={beaconUuid}
                    onChange={e => setBeaconUuid(e.target.value)}
                    placeholder="e.g. 2F234454-CF6D-4A0F-ADF2-F4911BA9FFA6"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-white font-mono text-[11px]"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[10px] text-slate-400">Enter Threshold (RSSI)</label>
                    {liveHeardRssi !== undefined && liveHeardRssi !== 0 && (
                      <button
                        type="button"
                        onClick={() => setBeaconEnterRssi(liveHeardRssi)}
                        className="text-[10px] text-purple-300 hover:text-purple-200 underline font-mono flex items-center gap-0.5 cursor-pointer"
                        title="Auto-fill with live RSSI"
                      >
                        📍 Use {liveHeardRssi} dBm
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={beaconEnterRssi}
                      onChange={e => setBeaconEnterRssi(parseInt(e.target.value) || -75)}
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-white font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleAddBeacon}
                      disabled={savingBeacon}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs whitespace-nowrap transition cursor-pointer"
                    >
                      {savingBeacon ? 'Saving...' : 'Add'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Stand-and-Calibrate Banner */}
              {liveHeardRssi !== undefined && liveHeardRssi !== 0 && (
                <div className="p-2.5 rounded-lg bg-purple-950/40 border border-purple-800/60 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <Signal className="w-4 h-4 text-purple-400 animate-pulse shrink-0" />
                    <div>
                      <div className="text-purple-200 font-semibold text-[11px]">
                        Live Signal Strength: <strong className="font-mono text-white text-xs">{liveHeardRssi} dBm</strong>
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Stand where you want the beacon to trigger, then click Auto-Populate.
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBeaconEnterRssi(liveHeardRssi)}
                    className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 active:scale-95 text-white font-bold text-xs shrink-0 transition flex items-center gap-1.5 shadow-sm cursor-pointer"
                  >
                    <span>📍 Auto-Populate</span>
                    <span className="font-mono text-[11px] opacity-90">({liveHeardRssi} dBm)</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Configured Target Beacons List */}
        <div className="space-y-2">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">
            Configured Beacon Targets ({status?.beacon_targets?.length || 0})
          </span>
          {(!status?.beacon_targets || status.beacon_targets.length === 0) ? (
            <div className="p-3 rounded-xl bg-slate-950/40 border border-slate-800 text-slate-500 text-xs italic text-center">
              No beacon targets saved yet. Add your phone's Home Assistant UUID or click one of the detected beacons below.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {status.beacon_targets.map((tgt, i) => (
                <div key={i} className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3 text-xs">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white truncate">{tgt.name}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-mono border ${
                        tgt.is_present
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                          : 'bg-slate-900 text-slate-500 border-slate-800'
                      }`}>
                        {tgt.is_present ? 'NEAR CAR' : 'AWAY'}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-slate-400 truncate">
                      {tgt.uuid ? `UUID: ${tgt.uuid}` : `MAC: ${tgt.mac}`}
                    </div>
                    <div className="text-[10px] text-slate-500 flex items-center gap-2 flex-wrap">
                      <span>Threshold: {tgt.enter_rssi} dBm</span>
                      {tgt.rssi && tgt.rssi !== -100 ? (
                        <span className={`font-bold flex items-center gap-1 font-mono ${
                          tgt.is_present ? 'text-emerald-400' : 'text-amber-400'
                        }`}>
                          <Signal className={`w-3 h-3 ${tgt.is_present ? 'animate-pulse' : ''}`} />
                          {tgt.is_present ? `Live: ${tgt.rssi} dBm` : `Last Heard: ${tgt.rssi} dBm ${tgt.rssi < tgt.enter_rssi ? '(Below Threshold)' : '(Timed Out)'}`}
                        </span>
                      ) : (
                        <span className="text-slate-600 italic">Not heard yet</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {tgt.rssi && tgt.rssi !== -100 ? (
                      <button
                        type="button"
                        onClick={() => handleCalibrateBeacon(tgt, tgt.rssi!)}
                        className="px-2 py-1 rounded bg-purple-950/80 hover:bg-purple-900 text-purple-300 border border-purple-800/80 text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                        title="Calibrate threshold to current live distance"
                      >
                        📍 Set Current ({tgt.rssi} dBm)
                      </button>
                    ) : null}
                    {onSelectTriggerForAutomation && (
                      <button
                        type="button"
                        onClick={() => handleCreateAutomationForBeacon(tgt)}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-purple-300 text-[11px] font-semibold transition"
                        title="Create automation triggered by this beacon"
                      >
                        + Rule
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDeleteBeacon(tgt.uuid, tgt.mac)}
                      className="p-1 text-slate-500 hover:text-rose-400 transition"
                      title="Remove beacon target"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recently Discovered Beacons In Range */}
        {status?.discovered_beacons && status.discovered_beacons.length > 0 && (
          <div className="p-3 rounded-xl bg-purple-950/20 border border-purple-900/50 space-y-2">
            <span className="text-[11px] font-bold text-purple-300 flex items-center gap-1.5">
              <Signal className="w-3.5 h-3.5 text-purple-400" />
              Nearby iBeacons Heard by Atom Lite (Click to Track):
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
              {status.discovered_beacons.map((b, idx) => (
                <div key={idx} className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-white text-[11px] truncate">{b.uuid}</div>
                    <div className="text-slate-400 text-[10px] flex items-center gap-1.5">
                      <span className="text-purple-300 font-bold">RSSI: {b.rssi} dBm</span>
                      {b.major ? <span>• Major: {b.major}</span> : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {onSelectTriggerForAutomation && (
                      <button
                        type="button"
                        onClick={() => handleCreateAutomationForDiscoveredBeacon(b)}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-purple-300 font-sans text-[10px] font-bold transition cursor-pointer"
                        title="Create automation rule with this beacon and live RSSI"
                      >
                        + Rule
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setBeaconUuid(b.uuid || b.mac);
                        setBeaconName(b.major ? `iBeacon ${b.major}` : 'Phone Beacon');
                        if (b.rssi) setBeaconEnterRssi(b.rssi);
                      }}
                      className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white font-sans text-[10px] font-bold shrink-0 transition flex items-center gap-1 cursor-pointer"
                      title={`Track with current live RSSI (${b.rssi} dBm)`}
                    >
                      <span>Track</span>
                      <span className="opacity-90 font-mono text-[9px]">({b.rssi} dBm)</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Live Event Log & Guides Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Live Event Feed */}
        <div className="can-do-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Real-Time Button Event Stream
            </span>
            <button
              type="button"
              onClick={() => setRecentEvents([])}
              className="text-[10px] text-slate-500 hover:text-rose-400 transition"
            >
              Clear Log
            </button>
          </div>

          <div className="h-44 overflow-y-auto bg-slate-950 rounded-xl p-2.5 font-mono text-xs space-y-1.5 border border-slate-800">
            {recentEvents.length === 0 ? (
              <div className="text-slate-600 text-center pt-8 italic text-[11px]">
                No button events recorded yet. Press a button on your connected controller or use the test buttons above.
              </div>
            ) : (
              recentEvents.map((evt, idx) => (
                <div key={idx} className="flex items-center justify-between text-[11px] p-1 rounded hover:bg-slate-900">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-400 font-bold">{evt.button_name}</span>
                    <span className="px-1 py-0.2 rounded bg-slate-800 text-slate-300 text-[10px]">
                      {evt.action}
                    </span>
                  </div>
                  <span className="text-slate-500 text-[10px]">
                    {evt.timestamp_ms
                      ? evt.timestamp_ms > 1000000000000
                        ? new Date(evt.timestamp_ms).toLocaleTimeString()
                        : `${(evt.timestamp_ms / 1000).toFixed(1)}s`
                      : '--'}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Android Phone Testing Guide Card */}
        <div className="can-do-card p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
            <Smartphone className="w-4 h-4 text-emerald-400" />
            <span>How to test using your Android phone</span>
          </div>

          <div className="text-xs text-slate-300 space-y-2 leading-relaxed">
            <p>
              You don't need physical hardware to test right now! Android can act as a standard Bluetooth HID Keyboard/Remote:
            </p>
            <ol className="list-decimal list-inside space-y-1.5 text-[11px] text-slate-400">
              <li>
                Install any free Bluetooth HID app on Android (e.g. <strong className="text-white">"Serverless Bluetooth Keyboard & Mouse"</strong>).
              </li>
              <li>
                Open the app and turn on Bluetooth. It starts advertising as an HID device.
              </li>
              <li>
                Click <strong className="text-blue-400">"Scan for Devices"</strong> above, select your phone, and click <strong className="text-white">Pair</strong>.
              </li>
              <li>
                Press the volume keys or tap any number on the app. The ESP32 will receive the native keystroke and execute your automation!
              </li>
            </ol>
          </div>
        </div>
      </div>

      {/* Hardware Recommendations Deck */}
      <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300 space-y-2">
        <div className="flex items-center gap-2 font-bold text-slate-200">
          <Keyboard className="w-4 h-4 text-cyan-400" />
          <span>Recommended Hardware Options (Extra Buttons & Macro Keyboards)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 text-[11px] text-slate-400">
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
            <span className="font-bold text-white block">Steering Wheel Media Remote</span>
            <p>
              Compact circular remotes (5-7 buttons: Vol+, Vol-, Next, Prev, Play, Mute). Attaches to steering wheel with strap or tape. Runs on CR2032 coin cell for 1-2 years.
            </p>
          </div>
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
            <span className="font-bold text-white block">3 / 6 / 9-Key Macro Keypads</span>
            <p>
              Bluetooth mechanical macropads with hot-swap switches & rotary encoders. Fully programmable as standard HID keys (1-9, F13-F24). Fits neatly in center console.
            </p>
          </div>
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
            <span className="font-bold text-white block">Bluetooth Shutter Remotes</span>
            <p>
              Ultra-budget ($3-$5) 2-button camera clickers. Native Volume Up / Enter commands that map directly to any CAN toggle or automation trigger.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BluetoothManager;
