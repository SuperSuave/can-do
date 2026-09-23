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
import { BleStatus, BleDeviceInfo, BleButtonEvent } from '../types/ble';
import { AutomationTrigger } from '../types/automation';

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
        if (data.last_event) {
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

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
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
    { id: 'key_9', label: '9' }
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
            <span className="font-semibold">Bluetooth Stack (NimBLE)</span>
            <Bluetooth className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-lg font-bold font-mono text-blue-300">
              {status?.enabled ? 'CENTRAL ACTIVE' : 'INITIALIZING'}
            </span>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center justify-between">
            <span>Native ESP-IDF HID Client</span>
            <span className="text-emerald-400 font-mono text-[10px]">Zero Custom Code</span>
          </div>
        </div>

        {/* Connected Controller Card */}
        <div className="can-do-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span className="font-semibold">Paired Button Controller</span>
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
          <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center justify-between">
            <span>Automations Hook</span>
            <span className="text-cyan-400 font-mono text-[10px]">HA Auto-Discovery Ready</span>
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
                    {evt.timestamp_ms ? new Date(evt.timestamp_ms).toLocaleTimeString() : '--'}
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
