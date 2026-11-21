/**
 * Centralized WebSocket client for the CAN Do device.
 * Maintains exactly 1 physical WebSocket connection to the ESP32 to eliminate
 * redundant FreeRTOS task overhead, TCP socket exhaustion, and heap churn.
 */

import { isRunningOnDevice, resolveDeviceBaseUrl } from '../utils/hostUtils';

export type DeviceWsMessage =
  | { type: 'state'; entity: string; state: string }
  | { type: 'log'; msg?: string; [key: string]: any }
  | { type: 'automation_fired'; id?: string; name?: string; ts?: number }
  | { type: string; [key: string]: any };

type Listener = (msg: DeviceWsMessage, raw: string) => void;

class DeviceWebSocketService {
  private ws: WebSocket | null = null;
  private currentUrl: string | null = null;
  private listeners: Set<Listener> = new Set();
  private reconnectTimer: any = null;
  private isConnected: boolean = false;
  private connectionListeners: Set<(connected: boolean) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === 'cando_device_host') {
          this.reconnect();
        }
      });
    }
  }

  public getConnected(): boolean {
    return this.isConnected;
  }

  public getWsUrl(hostOverride?: string | null): string {
    try {
      const rawHost =
        hostOverride !== undefined
          ? hostOverride
          : typeof localStorage !== 'undefined'
            ? localStorage.getItem('cando_device_host')
            : null;
      const baseUrl = resolveDeviceBaseUrl(rawHost);
      const parsed = new URL(baseUrl);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${parsed.host}/ws`;
    } catch {
      return 'ws://192.168.4.1/ws';
    }
  }

  public setHost(host: string): void {
    const trimmed = (host || '').trim();
    const isCurrentDeviceOrigin =
      typeof window !== 'undefined' &&
      isRunningOnDevice() &&
      (trimmed === '' ||
        trimmed === 'auto' ||
        trimmed === window.location.host ||
        trimmed === window.location.origin);
    const storageValue = isCurrentDeviceOrigin ? 'auto' : trimmed || 'auto';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cando_device_host', storageValue);
      }
    } catch {}

    const nextUrl = this.getWsUrl();
    if (this.currentUrl !== nextUrl) {
      this.reconnect();
    } else if (this.listeners.size > 0 && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
      this.connect();
    }
  }

  public connect(): void {
    const url = this.getWsUrl();
    if (
      this.ws &&
      this.currentUrl === url &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      const prevWs = this.ws;
      this.ws = null;
      try { prevWs.close(); } catch {}
      if (this.isConnected) {
        this.isConnected = false;
        this.notifyConnectionState(false);
      }
    }

    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('ws://')) {
      // In secure HTTPS context (e.g. GitHub Pages), browsers block mixed content ws://.
      this.currentUrl = url;
      return;
    }
    try {
      this.currentUrl = url;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.isConnected = true;
        this.notifyConnectionState(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== ws) return;
        const raw = String(event.data || '');
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { type: 'log', msg: raw };
        }

        const dispatch = (msg: DeviceWsMessage) => {
          this.listeners.forEach((listener) => {
            try {
              listener(msg, raw);
            } catch (err) {
              console.error('Error in WS listener:', err);
            }
          });
        };

        // 1. BLE events: normalize button / button_name across firmware variants
        if (parsed && parsed.type === 'ble_event') {
          const btn = parsed.button || parsed.button_name || '';
          parsed.button = btn;
          parsed.button_name = btn;
        }

        // 2. Standard message dispatch
        dispatch(parsed);
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.handleDisconnect();
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.handleDisconnect();
        try {
          ws.close();
        } catch {}
      };
    } catch (e) {
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    if (this.isConnected) {
      this.isConnected = false;
      this.notifyConnectionState(false);
    }
    this.ws = null;
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 3500);
    }
  }

  private notifyConnectionState(connected: boolean): void {
    this.connectionListeners.forEach((cb) => {
      try { cb(connected); } catch {}
    });
  }

  public reconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const prevWs = this.ws;
      this.ws = null;
      try { prevWs.close(); } catch {}
      if (this.isConnected) {
        this.isConnected = false;
        this.notifyConnectionState(false);
      }
    }
    this.currentUrl = null;
    this.connect();
  }

  public send(data: string): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    cb(this.isConnected);
    return () => {
      this.connectionListeners.delete(cb);
    };
  }
}

export const deviceWs = new DeviceWebSocketService();
