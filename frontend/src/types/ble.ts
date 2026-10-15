export interface BleDeviceInfo {
  name: string;
  address: string;
  rssi: number;
  connected: boolean;
  bonded: boolean;
  battery_pct?: number;
  last_seen_ms?: number;
}

export interface BeaconTarget {
  uuid: string;
  mac: string;
  name: string;
  enter_rssi: number;
  exit_timeout_s: number;
  is_present?: boolean;
  rssi?: number;
  major?: number;
  minor?: number;
  last_seen_ms?: number;
}

export interface DiscoveredBeacon {
  uuid: string;
  mac: string;
  rssi: number;
  major?: number;
  minor?: number;
  last_seen_ms?: number;
}

export interface BleStatus {
  enabled: boolean;
  scanning: boolean;
  connected_device: BleDeviceInfo | null;
  paired_devices: BleDeviceInfo[];
  discovered_devices?: BleDeviceInfo[];
  last_event?: BleButtonEvent | null;
  recent_events?: BleButtonEvent[];
  beacon_targets?: BeaconTarget[];
  discovered_beacons?: DiscoveredBeacon[];
}

export interface BleButtonEvent {
  device_address: string;
  device_name: string;
  button_name: string;
  action: 'press' | 'release' | 'hold';
  key_code?: number;
  modifiers?: number;
  timestamp_ms?: number;
}

