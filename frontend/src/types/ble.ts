export interface BleDeviceInfo {
  name: string;
  address: string;
  rssi: number;
  connected: boolean;
  bonded: boolean;
  battery_pct?: number;
  last_seen_ms?: number;
}

export interface BleStatus {
  enabled: boolean;
  scanning: boolean;
  connected_device: BleDeviceInfo | null;
  paired_devices: BleDeviceInfo[];
  discovered_devices?: BleDeviceInfo[];
  last_event?: BleButtonEvent | null;
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
