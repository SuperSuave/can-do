import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog
} from '@heroui/react';
import {
  RefreshCw,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  Wifi,
  Radio,
  ArrowRight,
  RotateCcw,
  X
} from 'lucide-react';
import { resolveDeviceBaseUrl, isRunningOnDevice } from '../utils/hostUtils';

export interface DeviceRebootModalProps {
  isOpen: boolean;
  deviceHost: string;
  version?: string;
  customTitle?: string;
  customMessage?: string;
  onClose: () => void;
  onReconnected?: () => void;
}

export const DeviceRebootModal: React.FC<DeviceRebootModalProps> = ({
  isOpen,
  deviceHost,
  version,
  customTitle,
  customMessage,
  onClose,
  onReconnected
}) => {
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [pingCount, setPingCount] = useState(0);
  const [isReconnected, setIsReconnected] = useState(false);
  const [reconnectedUptime, setReconnectedUptime] = useState<number | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [autoCloseCountdown, setAutoCloseCountdown] = useState<number | null>(null);

  const pingTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const autoCloseTimerRef = useRef<number | null>(null);
  const isCheckingRef = useRef<boolean>(false);
  const isReconnectedRef = useRef<boolean>(false);
  const sawDisconnectRef = useRef<boolean>(false);
  const onCloseRef = useRef(onClose);
  const onReconnectedRef = useRef(onReconnected);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    onReconnectedRef.current = onReconnected;
  }, [onReconnected]);

  // Always prefer the current browser IP/origin when served directly from the device
  const targetUrl = isRunningOnDevice() && (!deviceHost || deviceHost === 'auto' || deviceHost.toLowerCase().includes('current host'))
    ? window.location.origin
    : resolveDeviceBaseUrl(deviceHost);
  const displayHost = targetUrl.replace(/^https?:\/\//, '');

  const performReloadOrClose = useCallback(async () => {
    if (isRunningOnDevice()) {
      try {
        await fetch(`${window.location.origin}/?t=${Date.now()}`, { cache: 'reload' });
      } catch {}
      window.location.reload();
    } else {
      onCloseRef.current();
    }
  }, []);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSecondsElapsed(0);
      setPingCount(0);
      setIsReconnected(false);
      setReconnectedUptime(null);
      setIsChecking(false);
      setAutoCloseCountdown(null);
      isCheckingRef.current = false;
      isReconnectedRef.current = false;
      sawDisconnectRef.current = false;
    }
  }, [isOpen]);

  // Elapsed seconds timer
  useEffect(() => {
    if (!isOpen || isReconnected) return;

    elapsedTimerRef.current = window.setInterval(() => {
      setSecondsElapsed(prev => prev + 1);
    }, 1000);

    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [isOpen, isReconnected]);

  // Ping probe to test if device is back online via /api/system/status
  const checkDeviceStatus = useCallback(async () => {
    if (!isOpen || isReconnectedRef.current || isCheckingRef.current) return;
    isCheckingRef.current = true;
    setIsChecking(true);
    setPingCount(prev => prev + 1);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2200);

      // Probe /api/system/status (canonical status endpoint)
      const res = await fetch(`${targetUrl}/api/system/status?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        // Ensure we don't catch a pre-reboot response before the 1s restart_task fires:
        // Accept immediately if uptime_sec is fresh (< 45s), or if we already observed a disconnect,
        // or after at least 4s have elapsed.
        const freshBoot = typeof data.uptime_sec === 'number' && data.uptime_sec < 45;
        if (freshBoot || sawDisconnectRef.current) {
          isReconnectedRef.current = true;
          setIsReconnected(true);
          if (data.uptime_sec !== undefined) {
            setReconnectedUptime(data.uptime_sec);
          }
          if (onReconnectedRef.current) {
            onReconnectedRef.current();
          }
          setAutoCloseCountdown(3);
        }
      } else {
        sawDisconnectRef.current = true;
      }
    } catch {
      // Device is actively resetting or Wi-Fi is re-associating
      sawDisconnectRef.current = true;
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
    }
  }, [isOpen, targetUrl]);

  // Fallback check if uptime_sec isn't small (e.g. if reload happened without full power cycle after 5s)
  useEffect(() => {
    if (isOpen && secondsElapsed >= 5 && !sawDisconnectRef.current) {
      sawDisconnectRef.current = true;
    }
  }, [isOpen, secondsElapsed]);

  // Periodic pinging: Start probing after 3 seconds of reboot
  useEffect(() => {
    if (!isOpen || isReconnected) return;

    const startDelay = window.setTimeout(() => {
      checkDeviceStatus();
      pingTimerRef.current = window.setInterval(() => {
        checkDeviceStatus();
      }, 1500);
    }, 3000);

    return () => {
      clearTimeout(startDelay);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    };
  }, [isOpen, isReconnected, checkDeviceStatus]);

  // Countdown timer when reconnected — decoupled from parent render callbacks
  useEffect(() => {
    if (!isReconnected) return;

    autoCloseTimerRef.current = window.setInterval(() => {
      setAutoCloseCountdown(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (autoCloseTimerRef.current) {
            clearInterval(autoCloseTimerRef.current);
            autoCloseTimerRef.current = null;
          }
          performReloadOrClose();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (autoCloseTimerRef.current) {
        clearInterval(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, [isReconnected, performReloadOrClose]);

  if (!isOpen) return null;

  // Estimated total reboot window is 12 seconds for ESP32
  const estimatedTotalSec = 12;
  const progressPct = isReconnected
    ? 100
    : Math.min(95, Math.round((secondsElapsed / estimatedTotalSec) * 100));

  const handleManualReload = () => {
    performReloadOrClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-md">
        <ModalContainer placement="center" className="p-4">
          <ModalDialog className="relative w-full max-w-md p-6 sm:p-7 rounded-2xl bg-overlay text-overlay-foreground border border-accent/30 shadow-overlay text-center space-y-5 overflow-hidden">
        {/* Subtle decorative glowing background blur */}
        <div
          className={`absolute -top-16 -left-16 w-44 h-44 rounded-full blur-3xl pointer-events-none transition-colors duration-700 ${
            isReconnected ? 'bg-success/20' : 'bg-accent/15'
          }`}
        />
        <div
          className={`absolute -bottom-16 -right-16 w-44 h-44 rounded-full blur-3xl pointer-events-none transition-colors duration-700 ${
            isReconnected ? 'bg-success/15' : 'bg-accent/10'
          }`}
        />

        {/* Close button (only available if taking long or reconnected) */}
        {(secondsElapsed > 15 || isReconnected) && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-default-hover transition"
            title="Dismiss popup"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Animated Icon Header */}
        <div className="relative flex items-center justify-center pt-2">
          {isReconnected ? (
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl bg-success-soft border border-success/60 flex items-center justify-center shadow-lg animate-bounce-short">
                <CheckCircle2 className="w-10 h-10 text-success" />
              </div>
              <div className="absolute -inset-1 rounded-2xl bg-success/20 blur-sm -z-10 animate-pulse" />
            </div>
          ) : (
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl bg-accent-soft border border-accent/50 flex items-center justify-center shadow-lg">
                <RefreshCw className="w-9 h-9 text-accent animate-spin" />
              </div>
              {/* Expanding pulse rings */}
              <div className="absolute -inset-2 rounded-2xl border border-accent/30 animate-ping pointer-events-none" />
              <div className="absolute -inset-4 rounded-3xl border border-accent/15 pointer-events-none" />
            </div>
          )}
        </div>

        {/* Title & Description */}
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-2">
            <span
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider border ${
                isReconnected
                  ? 'bg-success-soft text-success-soft-foreground border-success/40'
                  : 'bg-accent-soft text-accent-soft-foreground border-accent/40 animate-pulse'
              }`}
            >
              {isReconnected ? 'System Online' : 'Device Rebooting'}
            </span>
          </div>

          <h3 className="text-lg sm:text-xl font-bold text-foreground tracking-tight">
            {isReconnected
              ? 'Hardware Back Online!'
              : (customTitle || 'Restarting CAN Do Hardware...')}
          </h3>

          <p className="text-xs text-muted leading-relaxed max-w-sm mx-auto">
            {isReconnected
              ? 'Reconnection verified successfully! The new firmware and LittleFS assets are active on your ESP32.'
              : (customMessage ||
                  'The update was written to flash. The processor is currently resetting, mounting LittleFS partitions, and reconnecting to your Wi-Fi network.')}
          </p>
        </div>

        {/* Progress & Countdown Section */}
        <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-muted flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-accent" />
              <span>CAN Do ESP32</span>
            </span>
            <span className={isReconnected ? 'text-success font-bold' : 'text-accent'}>
              {isReconnected ? 'Reboot Verified' : `${secondsElapsed}s elapsed`}
            </span>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-surface-tertiary rounded-full h-2.5 overflow-hidden p-0.5 border border-border">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isReconnected
                  ? 'bg-success'
                  : 'bg-accent'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* Pinging telemetry indicator */}
          <div className="flex items-center justify-between text-[11px] text-muted pt-0.5">
            <span className="flex items-center gap-1.5">
              <Wifi className={`w-3.5 h-3.5 ${isChecking ? 'text-accent animate-pulse' : 'text-muted'}`} />
              <span>Host: <strong className="text-foreground font-mono">{displayHost}</strong></span>
            </span>
            <span className="font-mono text-[10px] text-muted">
              {isReconnected ? (
                <span className="text-success font-semibold">HTTP 200 OK</span>
              ) : pingCount > 0 ? (
                `Ping probe #${pingCount}`
              ) : (
                'Initializing bus...'
              )}
            </span>
          </div>

          {version && (
            <div className="text-[10px] text-muted border-t border-separator pt-3 flex items-center justify-between">
              <span>Target Version:</span>
              <span className="font-mono text-accent font-bold">{version}</span>
            </div>
          )}

          {reconnectedUptime !== null && (
            <div className="text-[10px] text-muted border-t border-separator pt-3 flex items-center justify-between">
              <span>Device Uptime:</span>
              <span className="font-mono text-success font-bold">{reconnectedUptime}s (Fresh Boot)</span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="pt-1 space-y-2">
          {isReconnected ? (
            <button
              type="button"
              onClick={handleManualReload}
              className="w-full py-2.5 px-4 rounded-xl bg-success hover:bg-success-hover text-success-foreground font-bold text-xs shadow-lg transition flex items-center justify-center gap-2"
            >
              <span>{isRunningOnDevice() ? 'Reload Dashboard Now' : 'Back to Device Console'}</span>
              <ArrowRight className="w-4 h-4" />
              {autoCloseCountdown !== null && (
                <span className="text-[10px] bg-black/15 text-success-foreground px-1.5 py-0.5 rounded-full font-mono font-normal">
                  auto in {autoCloseCountdown}s
                </span>
              )}
            </button>
          ) : (
            <>
              {secondsElapsed > 15 ? (
                <div className="space-y-2 text-left">
                  <div className="p-2.5 rounded-lg bg-warning-soft border border-warning/40 text-[11px] text-warning-soft-foreground flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                    <p className="leading-relaxed">
                      Reconnection is taking a bit longer than usual. If the device was assigned a different DHCP IP or restarted in SoftAP mode, connect to <strong className="text-foreground font-mono">192.168.4.1</strong> or reload.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => checkDeviceStatus()}
                      disabled={isChecking}
                      className="flex-1 py-2 px-3 rounded-xl bg-surface-secondary hover:bg-default-hover text-accent border border-accent/40 font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                    >
                      <RotateCcw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
                      <span>Ping Again</span>
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="py-2 px-4 rounded-xl bg-surface-secondary hover:bg-default-hover text-muted hover:text-foreground border border-border font-semibold text-xs transition"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-xs text-muted">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-ping" />
                  <span>Waiting for ESP32 Wi-Fi handshake...</span>
                </div>
              )}
            </>
          )}
        </div>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
};

export default DeviceRebootModal;
