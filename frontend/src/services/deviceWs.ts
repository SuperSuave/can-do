/**
 * Centralized WebSocket client for the CAN Do device.
 * Maintains exactly 1 physical WebSocket connection to the ESP32 to eliminate
 * redundant FreeRTOS task overhead, TCP socket exhaustion, and heap churn.
 */

import { resolveDeviceBaseUrl } from '../utils/hostUtils';

export type DeviceWsMessage = 
  | { type: 'can_frame'; id: string; dlc?: number; data?: string }
  | { type: 'state'; entity: string; state: string }
  | { type: 'log'; msg?: string; [key: string]: any }
  | { type: 'automation_fired'; rule_id?: string; id?: string; trigger_id?: string }
  | { type: string; [key: string]: any };

type Listener = (msg: DeviceWsMessage, raw: string) => void;

class DeviceWebSocketService {
  private ws: WebSocket | null = null;
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

  public getWsUrl(): string {
    try {
      const baseUrl = resolveDeviceBaseUrl(typeof localStorage !== 'undefined' ? localStorage.getItem('cando_device_host') : null);
      const parsed = new URL(baseUrl);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${parsed.host}/ws`;
    } catch {
      return 'ws://192.168.4.1/ws';
    }
  }

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = this.getWsUrl();
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('ws://')) {
      // In secure HTTPS context (e.g. GitHub Pages), browsers block mixed content ws://.
      return;
    }
    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.notifyConnectionState(true);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const raw = String(event.data || '');
        let parsed: DeviceWsMessage;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { type: 'log', msg: raw };
        }
        this.listeners.forEach((listener) => {
          try {
            listener(parsed, raw);
          } catch (err) {
            console.error('Error in WS listener:', err);
          }
        });
      };

      this.ws.onclose = () => {
        this.handleDisconnect();
      };

      this.ws.onerror = () => {
        this.handleDisconnect();
        try {
          this.ws?.close();
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
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
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
