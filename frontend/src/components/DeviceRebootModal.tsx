import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  isAtomBridge?: boolean;
  version?: string;
  customTitle?: string;
  customMessage?: string;
  onClose: () => void;
  onReconnected?: () => void;
}

export const DeviceRebootModal: React.FC<DeviceRebootModalProps> = ({
  isOpen,
  deviceHost,
  isAtomBridge = false,
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

  const targetUrl = resolveDeviceBaseUrl(deviceHost);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSecondsElapsed(0);
      setPingCount(0);
      setIsReconnected(false);
      setReconnectedUptime(null);
      setIsChecking(false);
      setAutoCloseCountdown(null);
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

  // Ping probe to test if device is back online
  const checkDeviceStatus = useCallback(async () => {
    if (!isOpen || isReconnected || isChecking) return;
    setIsChecking(true);
    setPingCount(prev => prev + 1);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      // Probe /api/status (LittleFS / ESP-IDF REST API endpoint)
      const res = await fetch(`${targetUrl}/api/status`, {
        cache: 'no-cache',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setIsReconnected(true);
        if (data.uptime_sec !== undefined) {
          setReconnectedUptime(data.uptime_sec);
        }
        if (onReconnected) {
          onReconnected();
        }
        // Start 4-second auto-close countdown so user can see confirmation
        setAutoCloseCountdown(4);
      }
    } catch {
      // Device still restarting or network temporarily offline
    } finally {
      setIsChecking(false);
    }
  }, [isOpen, isReconnected, isChecking, targetUrl, onReconnected]);

  // Periodic pinging: Start probing after 3 seconds of reboot
  useEffect(() => {
    if (!isOpen || isReconnected) return;

    // Wait 3 seconds before starting active pinging to give ESP32 time to reset
    const startDelay = setTimeout(() => {
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

  // Countdown timer when reconnected
  useEffect(() => {
    if (autoCloseCountdown === null || autoCloseCountdown <= 0) return;

    autoCloseTimerRef.current = window.setInterval(() => {
      setAutoCloseCountdown(prev => {
        if (prev === null || prev <= 1) {
          // If running embedded directly on the device, reload the page to load fresh assets
          if (isRunningOnDevice()) {
            window.location.reload();
          } else {
            onClose();
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (autoCloseTimerRef.current) clearInterval(autoCloseTimerRef.current);
    };
  }, [autoCloseCountdown, onClose]);

  if (!isOpen) return null;

  // Estimated total reboot window is 12 seconds for ESP32-C3 / M5Stack Atom
  const estimatedTotalSec = 12;
  const progressPct = isReconnected
    ? 100
    : Math.min(95, Math.round((secondsElapsed / estimatedTotalSec) * 100));

  const handleManualReload = () => {
    if (isRunningOnDevice()) {
      window.location.reload();
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-md p-6 sm:p-7 rounded-2xl bg-slate-900 border border-cyan-500/30 shadow-2xl shadow-cyan-950/60 text-center space-y-5 overflow-hidden">
        {/* Subtle decorative glowing background blur */}
        <div
          className={`absolute -top-16 -left-16 w-44 h-44 rounded-full blur-3xl pointer-events-none transition-colors duration-700 ${
            isReconnected ? 'bg-emerald-500/20' : 'bg-cyan-500/15'
          }`}
        />
        <div
          className={`absolute -bottom-16 -right-16 w-44 h-44 rounded-full blur-3xl pointer-events-none transition-colors duration-700 ${
            isReconnected ? 'bg-teal-500/20' : 'bg-blue-500/15'
          }`}
        />

        {/* Close button (only available if taking long or reconnected) */}
        {(secondsElapsed > 15 || isReconnected) && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title="Dismiss popup"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Animated Icon Header */}
        <div className="relative flex items-center justify-center pt-2">
          {isReconnected ? (
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl bg-emerald-950/60 border border-emerald-500/60 flex items-center justify-center shadow-lg shadow-emerald-950/60 animate-bounce-short">
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              </div>
              <div className="absolute -inset-1 rounded-2xl bg-emerald-400/20 blur-sm -z-10 animate-pulse" />
            </div>
          ) : (
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-950/80 to-blue-950/80 border border-cyan-500/50 flex items-center justify-center shadow-lg shadow-cyan-950/60">
                <RefreshCw className="w-9 h-9 text-cyan-400 animate-spin" />
              </div>
              {/* Expanding pulse rings */}
              <div className="absolute -inset-2 rounded-2xl border border-cyan-400/30 animate-ping pointer-events-none" />
              <div className="absolute -inset-4 rounded-3xl border border-cyan-500/10 pointer-events-none" />
            </div>
          )}
        </div>

        {/* Title & Description */}
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-2">
            <span
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider border ${
                isReconnected
                  ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                  : 'bg-cyan-950 text-cyan-300 border-cyan-800 animate-pulse'
              }`}
            >
              {isReconnected ? 'System Online' : 'Device Rebooting'}
            </span>
          </div>

          <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
            {isReconnected
              ? 'Hardware Back Online!'
              : (customTitle || 'Restarting CAN Do Hardware...')}
          </h3>

          <p className="text-xs text-slate-300 leading-relaxed max-w-sm mx-auto">
            {isReconnected
              ? `Reconnection verified successfully! The new firmware and LittleFS assets are active on your ${
                  isAtomBridge ? 'M5Stack Atom Lite Bridge' : 'ESP32'
                }.`
              : (customMessage ||
                  'The update was written to flash. The processor is currently resetting, mounting LittleFS partitions, and reconnecting to your Wi-Fi network.')}
          </p>
        </div>

        {/* Progress & Countdown Section */}
        <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/80 space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-slate-400 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>{isAtomBridge ? 'Atom Lite Bridge' : 'CAN Do ESP32'}</span>
            </span>
            <span className={isReconnected ? 'text-emerald-400 font-bold' : 'text-cyan-300'}>
              {isReconnected ? 'Reboot Verified' : `${secondsElapsed}s elapsed`}
            </span>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-slate-800/80 rounded-full h-2.5 overflow-hidden p-0.5 border border-slate-700/50">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isReconnected
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                  : 'bg-gradient-to-r from-cyan-500 via-sky-400 to-teal-400'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* Pinging telemetry indicator */}
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
            <span className="flex items-center gap-1.5">
              <Wifi className={`w-3.5 h-3.5 ${isChecking ? 'text-cyan-300 animate-pulse' : 'text-slate-500'}`} />
              <span>Host: <strong className="text-slate-200 font-mono">{deviceHost || 'auto'}</strong></span>
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              {isReconnected ? (
                <span className="text-emerald-400 font-semibold">HTTP 200 OK</span>
              ) : pingCount > 0 ? (
                `Ping probe #${pingCount}`
              ) : (
                'Initializing bus...'
              )}
            </span>
          </div>

          {version && (
            <div className="text-[10px] text-slate-400 border-t border-slate-800/60 pt-2 flex items-center justify-between">
              <span>Target Version:</span>
              <span className="font-mono text-cyan-300 font-bold">{version}</span>
            </div>
          )}

          {reconnectedUptime !== null && (
            <div className="text-[10px] text-slate-400 border-t border-slate-800/60 pt-2 flex items-center justify-between">
              <span>Device Uptime:</span>
              <span className="font-mono text-emerald-300 font-bold">{reconnectedUptime}s (Fresh Boot)</span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="pt-1 space-y-2">
          {isReconnected ? (
            <button
              type="button"
              onClick={handleManualReload}
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold text-xs shadow-lg shadow-emerald-950/40 transition flex items-center justify-center gap-2"
            >
              <span>{isRunningOnDevice() ? 'Reload Dashboard Now' : 'Back to Device Console'}</span>
              <ArrowRight className="w-4 h-4" />
              {autoCloseCountdown !== null && (
                <span className="text-[10px] bg-emerald-950 text-emerald-200 px-1.5 py-0.5 rounded-full font-mono font-normal">
                  auto in {autoCloseCountdown}s
                </span>
              )}
            </button>
          ) : (
            <>
              {secondsElapsed > 15 ? (
                <div className="space-y-2 text-left">
                  <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/50 text-[11px] text-amber-200 flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <p className="leading-relaxed">
                      Reconnection is taking a bit longer than usual. If the device was assigned a different DHCP IP or restarted in SoftAP mode, connect to <strong className="text-white font-mono">192.168.4.1</strong> or reload.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => checkDeviceStatus()}
                      disabled={isChecking}
                      className="flex-1 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-800/60 font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                    >
                      <RotateCcw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
                      <span>Ping Again</span>
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="py-2 px-4 rounded-xl bg-slate-800/60 hover:bg-slate-800 text-slate-300 font-semibold text-xs transition"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                  <span>Waiting for ESP32 Wi-Fi handshake...</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeviceRebootModal;
