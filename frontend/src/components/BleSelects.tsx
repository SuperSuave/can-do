import React, { useState, useEffect } from 'react';
import { Bluetooth, Radio, Smartphone, ChevronDown, Check, Edit3 } from 'lucide-react';
import { BleStatus, BleDeviceInfo, BeaconTarget, DiscoveredBeacon } from '../types/ble';
import { resolveDeviceBaseUrl } from '../utils/hostUtils';

// Global cache to avoid redundant API polling across multiple cards
let cachedBleStatus: BleStatus | null = null;
let lastFetchTime = 0;
const statusListeners: Array<(s: BleStatus) => void> = [];

export function useBleStatus() {
  const [status, setStatus] = useState<BleStatus | null>(cachedBleStatus);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    const listener = (s: BleStatus) => {
      if (mounted) setStatus(s);
    };
    statusListeners.push(listener);

    const fetchStatus = async () => {
      const now = Date.now();
      // Cache for 3 seconds unless forced
      if (cachedBleStatus && now - lastFetchTime < 3000) {
        setStatus(cachedBleStatus);
        return;
      }
      try {
        setLoading(true);
        const baseUrl = resolveDeviceBaseUrl();
        const res = await fetch(`${baseUrl}/api/ble/status`);
        if (res.ok) {
          const data: BleStatus = await res.json();
          cachedBleStatus = data;
          lastFetchTime = Date.now();
          statusListeners.forEach(fn => fn(data));
        }
      } catch {
        // Device offline or simulator
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchStatus();
    }, 4000);

    return () => {
      mounted = false;
      const idx = statusListeners.indexOf(listener);
      if (idx !== -1) statusListeners.splice(idx, 1);
      clearInterval(interval);
    };
  }, []);

  return { status, loading };
}

interface BleDeviceSelectProps {
  value: string;
  onChange: (value: string, name?: string) => void;
  label?: string;
  placeholder?: string;
  className?: string;
}

export const BleDeviceSelect: React.FC<BleDeviceSelectProps> = ({
  value,
  onChange,
  label = 'Device Filter (Optional)',
  placeholder = 'Any Bluetooth Device',
  className = ''
}) => {
  const { status } = useBleStatus();
  const [isManual, setIsManual] = useState(false);

  // Collect paired and discovered devices
  const pairedDevices = status?.paired_devices || [];
  const connectedDevice = status?.connected_device;
  const discoveredDevices = (status?.discovered_devices || []).filter(
    d => !pairedDevices.some(p => p.address.toLowerCase() === d.address.toLowerCase())
  );

  // If currently connected device isn't in paired list, merge it
  const allKnownDevices: BleDeviceInfo[] = [...pairedDevices];
  if (connectedDevice && !allKnownDevices.some(d => d.address.toLowerCase() === connectedDevice.address.toLowerCase())) {
    allKnownDevices.unshift(connectedDevice);
  }

  // Check if current value matches a known device address or name
  const isKnownMatch = !value || allKnownDevices.some(
    d => d.address.toLowerCase() === value.toLowerCase() || d.name.toLowerCase() === value.toLowerCase()
  );

  // If value is a custom string not in known devices, default to manual mode if not explicitly set
  useEffect(() => {
    if (value && !isKnownMatch && !isManual) {
      setIsManual(true);
    }
  }, [value, isKnownMatch]);

  return (
    <div className={`space-y-1 font-sans ${className}`}>
      <div className="flex items-center justify-between">
        <label className="block text-[10px] text-slate-400 font-medium truncate">{label}</label>
        <button
          type="button"
          onClick={() => setIsManual(!isManual)}
          className="text-[9px] text-blue-400 hover:text-blue-300 font-mono transition flex items-center gap-0.5"
          title={isManual ? 'Select from detected devices' : 'Enter custom MAC address'}
        >
          {isManual ? 'Choose List' : 'Custom MAC'}
        </button>
      </div>

      {isManual ? (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. D1:01:B1:F6:8C:34 or MK321BT"
          className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2.5 text-xs text-slate-200 font-mono focus:border-blue-500 focus:outline-none box-border"
        />
      ) : (
        <select
          value={value}
          onChange={e => {
            const val = e.target.value;
            if (val === '__custom__') {
              setIsManual(true);
            } else {
              const matched = allKnownDevices.find(d => d.address.toLowerCase() === val.toLowerCase());
              onChange(val, matched?.name);
            }
          }}
          className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-xs text-slate-200 font-mono focus:border-blue-500 focus:outline-none box-border"
        >
          <option value="">{placeholder} (No Filter)</option>

          {allKnownDevices.length > 0 && (
            <optgroup label="Paired & Connected Devices">
              {allKnownDevices.map(d => {
                const isConn = connectedDevice?.address.toLowerCase() === d.address.toLowerCase();
                return (
                  <option key={d.address} value={d.address}>
                    {d.name ? `${d.name} (${d.address})` : d.address} {isConn ? '• Connected' : ''}
                  </option>
                );
              })}
            </optgroup>
          )}

          {discoveredDevices.length > 0 && (
            <optgroup label="Discovered Nearby Devices">
              {discoveredDevices.map(d => (
                <option key={d.address} value={d.address}>
                  {d.name || 'Unknown'} ({d.address}) • {d.rssi} dBm
                </option>
              ))}
            </optgroup>
          )}

          <option value="__custom__">Custom MAC Address / Name...</option>
        </select>
      )}
    </div>
  );
};

interface BleBeaconSelectProps {
  value: string;
  onChange: (value: string, name?: string) => void;
  label?: string;
  placeholder?: string;
  className?: string;
}

export const BleBeaconSelect: React.FC<BleBeaconSelectProps> = ({
  value,
  onChange,
  label = 'Beacon / Phone Filter',
  placeholder = 'Any Registered Beacon / Phone',
  className = ''
}) => {
  const { status } = useBleStatus();
  const [isManual, setIsManual] = useState(false);

  const beaconTargets = status?.beacon_targets || [];
  const discoveredBeacons = status?.discovered_beacons || [];

  const isKnownMatch = !value || 
    beaconTargets.some(b => b.uuid.toLowerCase() === value.toLowerCase() || (b.mac && b.mac.toLowerCase() === value.toLowerCase())) ||
    discoveredBeacons.some(b => b.uuid.toLowerCase() === value.toLowerCase());

  useEffect(() => {
    if (value && !isKnownMatch && !isManual) {
      setIsManual(true);
    }
  }, [value, isKnownMatch]);

  return (
    <div className={`space-y-1 font-sans ${className}`}>
      <div className="flex items-center justify-between">
        <label className="block text-[10px] text-slate-400 font-medium truncate">{label}</label>
        <button
          type="button"
          onClick={() => setIsManual(!isManual)}
          className="text-[9px] text-purple-400 hover:text-purple-300 font-mono transition flex items-center gap-0.5"
          title={isManual ? 'Select from detected beacons' : 'Enter custom UUID / MAC'}
        >
          {isManual ? 'Choose List' : 'Custom UUID'}
        </button>
      </div>

      {isManual ? (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. 46bc57c2-8fb0-4c2c-a13e-30f00b387701"
          className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2.5 text-xs text-purple-300 font-mono focus:border-purple-500 focus:outline-none box-border"
        />
      ) : (
        <select
          value={value}
          onChange={e => {
            const val = e.target.value;
            if (val === '__custom__') {
              setIsManual(true);
            } else {
              const matched = beaconTargets.find(b => b.uuid.toLowerCase() === val.toLowerCase() || (b.mac && b.mac.toLowerCase() === val.toLowerCase()));
              onChange(val, matched?.name);
            }
          }}
          className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-xs text-purple-300 font-mono focus:border-purple-500 focus:outline-none box-border"
        >
          <option value="">{placeholder} (No Filter)</option>

          {beaconTargets.length > 0 && (
            <optgroup label="Saved Beacon / Phone Targets">
              {beaconTargets.map(b => (
                <option key={b.uuid || b.mac} value={b.uuid || b.mac}>
                  {b.name || 'Phone Beacon'} ({b.uuid ? `${b.uuid.substring(0, 8)}...` : b.mac}) {b.is_present ? '• Present' : ''}
                </option>
              ))}
            </optgroup>
          )}

          {discoveredBeacons.length > 0 && (
            <optgroup label="Live Detected Beacons (Nearby)">
              {discoveredBeacons.map(b => (
                <option key={b.uuid} value={b.uuid}>
                  iBeacon ({b.uuid.substring(0, 8)}...) • RSSI {b.rssi} dBm
                </option>
              ))}
            </optgroup>
          )}

          <option value="__custom__">Custom Beacon UUID / MAC...</option>
        </select>
      )}
    </div>
  );
};
