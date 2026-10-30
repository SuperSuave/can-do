import React, { useState, useContext } from 'react';
import {
  ArrowUp,
  ArrowDown,
  Copy,
  ClipboardCopy,
  Trash2,
  ChevronDown,
  ChevronUp,
  Clock,
  Bluetooth,
  Signal,
  Wifi,
  Sliders
} from 'lucide-react';
import { AutomationTrigger, AutomationAction, AutomationCondition } from '../../types/automation';
import { Catalog, CommandOption } from '../../types/catalog';
import { compileToByteMap, resolveCatalogCommandForTrigger, applyOptionToTrigger } from '../../utils/automationConverters';
import { groupOptionsIntoGridRows, OptionGridGroup, LiveWifiStatus, LiveBleItem } from './liveEvaluator';
import { DayOfWeekPicker } from './DayOfWeekPicker';
import { BleButtonComboPicker } from '../BleButtonComboPicker';
import { BleDeviceSelect, BleBeaconSelect } from '../BleSelects';
import { AutomationClipboardContext } from './AutomationClipboardContext';

export interface TriggerNodeEditorProps {
  key?: React.Key;
  trig: AutomationTrigger;
  tIdx: number;
  catalog?: Catalog;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (updated: AutomationTrigger) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
}

export function TriggerNodeEditor({
  trig,
  tIdx,
  catalog,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: TriggerNodeEditorProps) {
  const [showAdvanced, setShowAdvanced] = useState(Boolean((trig as any)._showAdvanced));
  const [collapsed, setCollapsed] = useState(false);
  const { copyToClipboard } = useContext(AutomationClipboardContext);

  const getTriggerLabel = (): string => {
    if (trig.type === 'time_schedule' || trig.source === 'time') {
      return `Time: ${trig.time || '--:--'}`;
    }
    if (trig.type === 'ble_button' || trig.type === 'ble_key' || (!trig.type && trig.source === 'ble' && trig.ble_button)) {
      return `BLE: ${trig.ble_button || 'button'} (${trig.ble_action || 'press'})`;
    }
    if (trig.type === 'ble_presence' || trig.type === 'ble_beacon' || trig.type === 'beacon') {
      return `BLE Presence: ${trig.ble_event || 'enter'}`;
    }
    if (trig.type === 'wifi' || trig.type === 'wifi_status') {
      return `Wi-Fi: ${trig.device_property || 'status'}`;
    }
    if (trig.command_name || trig.name) {
      return trig.command_name || trig.name || 'CAN Trigger';
    }
    return `CAN ${trig.can_id || 'Trigger'}`;
  };

  const toggleAdvanced = () => {
    const nextVal = !showAdvanced;
    setShowAdvanced(nextVal);
    (trig as any)._showAdvanced = nextVal;
  };

  const actionButtons = (
    <div className="flex items-center gap-1 shrink-0 flex-wrap">
      {onMoveUp && (
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition shrink-0"
          title="Move up"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
      )}
      {onMoveDown && (
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition shrink-0"
          title="Move down"
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </button>
      )}
      {onDuplicate && (
        <button
          type="button"
          onClick={onDuplicate}
          className="p-1 text-slate-500 hover:text-cyan-400 transition shrink-0"
          title="Duplicate trigger"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => copyToClipboard('trigger', trig, getTriggerLabel())}
        className="p-1 text-slate-500 hover:text-amber-400 transition shrink-0"
        title="Copy trigger to clipboard"
      >
        <ClipboardCopy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-slate-500 hover:text-rose-400 transition shrink-0"
        title="Delete trigger"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  // Time-based schedule trigger
  if (trig.type === 'time_schedule' || trig.source === 'time') {
    return (
      <div
        className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2.5 text-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 font-bold text-[10px] flex items-center justify-center border border-cyan-800 shrink-0">
              T{tIdx + 1}
            </span>
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[10px] text-slate-500 font-sans">ID:</span>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-cyan-300 text-[11px] font-mono focus:outline-none focus:border-cyan-500 w-24"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              <span className="font-semibold text-white">Time Schedule</span>
              {trig.time && (
                <span className="px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60 font-mono">
                  {trig.time}
                </span>
              )}
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <>
            <div>
              <label className="block text-[10px] font-sans text-slate-400 mb-1">Target Time (24h)</label>
              <input
                type="time"
                value={trig.time || ''}
                onChange={e => onUpdate({ ...trig, time: e.target.value })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500"
              />
            </div>

            <DayOfWeekPicker
              selectedDays={trig.days}
              onChange={days => onUpdate({ ...trig, days })}
            />
          </>
        )}
      </div>
    );
  }

  // Bluetooth Remote / Button Trigger
  if (trig.type === 'ble_button' || trig.type === 'ble_key' || (!trig.type && trig.source === 'ble' && trig.ble_button)) {
    return (
      <div
        className="p-3.5 rounded-xl bg-slate-950 border border-blue-800/80 space-y-2.5 text-xs shadow-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-blue-950 text-blue-300 font-bold text-[10px] flex items-center justify-center border border-blue-800 shrink-0">
              T{tIdx + 1}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-blue-400 font-semibold">
                <Bluetooth className="w-3.5 h-3.5" />
                <span>Bluetooth Remote Button</span>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-200 text-[10px] font-mono border border-blue-700/50">
                {trig.ble_button || 'volume_up'} • {trig.ble_action || 'press'}
              </span>
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] items-end">
            <div className="flex flex-col justify-end">
              <BleButtonComboPicker
                value={trig.ble_button || 'volume_up'}
                onChange={val => onUpdate({ ...trig, ble_button: val })}
                label="Button or Multi-Button Combo Chord"
              />
            </div>

            <div className="flex flex-col justify-end">
              <label className="block text-[10px] font-sans text-slate-400 mb-1">Action Event</label>
              <select
                value={trig.ble_action || 'press'}
                onChange={e => onUpdate({ ...trig, ble_action: e.target.value as any })}
                className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-slate-200 font-sans box-border"
              >
                <option value="press">Button Pressed (or Combo Chord)</option>
                <option value="release">Button Released</option>
                <option value="any">Any (Press or Release)</option>
              </select>
            </div>

            <div className="flex flex-col justify-end">
              <BleDeviceSelect
                value={trig.ble_device || ''}
                onChange={val => onUpdate({ ...trig, ble_device: val })}
                label="Device Filter (Optional)"
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Bluetooth Presence / Proximity Trigger (Phone Beacon, Key Fob, or Paired Device)
  if (
    trig.type === 'ble_presence' ||
    trig.type === 'ble_device_event' ||
    trig.type === 'ble_device' ||
    trig.type === 'ble_beacon' ||
    trig.type === 'beacon' ||
    (!trig.type && trig.source === 'ble')
  ) {
    const isPairedDeviceMode = trig.ble_event === 'connected' || trig.ble_event === 'disconnected';
    const currentMode = isPairedDeviceMode ? 'paired_device' : 'phone_beacon';

    return (
      <div className="p-3.5 rounded-xl bg-slate-950 border border-purple-800/80 space-y-2.5 text-xs shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-purple-950 text-purple-300 font-bold text-[10px] flex items-center justify-center border border-purple-800 shrink-0">
              T{tIdx + 1}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-purple-400 font-semibold">
                <Bluetooth className="w-3.5 h-3.5" />
                <span>Bluetooth Presence / Proximity</span>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-200 text-[10px] font-mono border border-purple-700/50">
                {currentMode === 'phone_beacon'
                  ? (trig.ble_event === 'exit' ? 'Walk-Away (exit)' : (trig.ble_event === 'proximity' ? 'Proximity' : 'Walk-Up (enter)'))
                  : (trig.ble_event === 'disconnected' ? 'Disconnected' : 'Connected')}
                {trig.beacon_uuid ? ` • ${trig.beacon_uuid.substring(0, 8)}...` : (trig.ble_device ? ` • ${trig.ble_device}` : '')}
                {trig.target_rssi ? ` • RSSI: ${trig.target_rssi} dBm` : ''}
              </span>
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] items-end">
              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Tracking Target</label>
                <select
                  value={currentMode}
                  onChange={e => {
                    const newMode = e.target.value;
                    if (newMode === 'phone_beacon') {
                      onUpdate({
                        ...trig,
                        type: 'ble_presence',
                        ble_event: 'enter',
                        target_rssi: trig.target_rssi || -70
                      });
                    } else {
                      onUpdate({
                        ...trig,
                        type: 'ble_presence',
                        ble_event: 'connected',
                        target_rssi: trig.target_rssi || -65
                      });
                    }
                  }}
                  className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-purple-300 font-sans box-border"
                >
                  <option value="phone_beacon">Phone iBeacon / Key Fob (Walk-Up / Walk-Away)</option>
                  <option value="paired_device">Paired Remote / Bluetooth Device</option>
                </select>
              </div>

              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Trigger Event</label>
                {currentMode === 'phone_beacon' ? (
                  <select
                    value={trig.ble_event || 'enter'}
                    onChange={e => onUpdate({ ...trig, ble_event: e.target.value })}
                    className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-purple-300 font-sans box-border"
                  >
                    <option value="enter">Walk-Up (Enters Proximity Range)</option>
                    <option value="exit">Walk-Away (Exits Proximity Range)</option>
                    <option value="proximity">Proximity Signal (Continuous RSSI)</option>
                  </select>
                ) : (
                  <select
                    value={trig.ble_event || 'connected'}
                    onChange={e => onUpdate({ ...trig, ble_event: e.target.value })}
                    className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-indigo-300 font-sans box-border"
                  >
                    <option value="connected">Device Connected (In Range)</option>
                    <option value="disconnected">Device Disconnected (Walk Away)</option>
                    <option value="proximity">Proximity Signal (RSSI)</option>
                  </select>
                )}
              </div>

              <div className="flex flex-col justify-end">
                {currentMode === 'phone_beacon' ? (
                  <BleBeaconSelect
                    value={trig.beacon_uuid || trig.ble_device || ''}
                    onChange={val => onUpdate({ ...trig, beacon_uuid: val, ble_device: val })}
                    label="Beacon UUID / MAC Filter"
                  />
                ) : (
                  <BleDeviceSelect
                    value={trig.ble_device || ''}
                    onChange={val => onUpdate({ ...trig, ble_device: val })}
                    label="Device MAC / Name Filter"
                  />
                )}
              </div>
            </div>

            {/* RSSI Proximity threshold settings */}
            {(() => {
              const targetKey = (trig.beacon_uuid || trig.ble_device || '').toLowerCase().trim();
              let matchedBle: LiveBleItem | undefined;
              if (liveBleMap) {
                if (targetKey) {
                  for (const [k, v] of liveBleMap.entries()) {
                    if (
                      k.toLowerCase() === targetKey ||
                      (v.mac && v.mac.toLowerCase() === targetKey) ||
                      (v.uuid && v.uuid.toLowerCase() === targetKey) ||
                      (v.name && v.name.toLowerCase() === targetKey)
                    ) {
                      matchedBle = v;
                      break;
                    }
                  }
                } else {
                  for (const v of liveBleMap.values()) {
                    if (v.is_present || v.connected) {
                      matchedBle = v;
                      break;
                    }
                  }
                }
              }
              const liveRssi = matchedBle?.rssi;

              return (
                <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-sans text-slate-400">Proximity Threshold:</span>
                    <input
                      type="number"
                      value={trig.target_rssi ?? -70}
                      onChange={e => onUpdate({ ...trig, target_rssi: parseInt(e.target.value) || -70 })}
                      placeholder="-70"
                      className="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-purple-300 font-mono font-bold text-center text-[11px]"
                    />
                    <span className="text-[10px] font-mono text-slate-500">dBm</span>
                    {liveRssi !== undefined && liveRssi !== 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 text-[10px] font-bold">
                        <Signal className="w-3 h-3 text-purple-400 animate-pulse" />
                        Live: {liveRssi} dBm
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {liveRssi !== undefined && liveRssi !== 0 && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...trig, target_rssi: liveRssi })}
                        className="px-2 py-0.5 text-[10px] font-sans rounded bg-purple-950 hover:bg-purple-900 text-purple-300 border border-purple-800 font-bold transition flex items-center gap-1 cursor-pointer"
                        title="Auto-populate trigger threshold with current live signal"
                      >
                        📍 Set to Current ({liveRssi} dBm)
                      </button>
                    )}
                    <span className="text-[10px] font-sans text-slate-500">Presets:</span>
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...trig, target_rssi: -60 })}
                      className={`px-2 py-0.5 text-[10px] font-sans rounded border transition ${
                        (trig.target_rssi ?? -70) === -60
                          ? 'bg-purple-900 text-purple-100 border-purple-500'
                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      In-Car (-60)
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...trig, target_rssi: -75 })}
                      className={`px-2 py-0.5 text-[10px] font-sans rounded border transition ${
                        (trig.target_rssi ?? -70) === -75
                          ? 'bg-purple-900 text-purple-100 border-purple-500'
                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      Doors (-75)
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...trig, target_rssi: -85 })}
                      className={`px-2 py-0.5 text-[10px] font-sans rounded border transition ${
                        (trig.target_rssi ?? -70) === -85
                          ? 'bg-purple-900 text-purple-100 border-purple-500'
                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      Walk-Up (-85)
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    );
  }

  // Wi-Fi / Device Trigger
  if (trig.type === 'wifi' || trig.type === 'wifi_event' || trig.source === 'wifi') {
    return (
      <div className="p-3.5 rounded-xl bg-slate-950 border border-sky-800/80 space-y-2.5 text-xs shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-sky-950 text-sky-300 font-bold text-[10px] flex items-center justify-center border border-sky-800 shrink-0">
              T{tIdx + 1}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-sky-400 font-semibold">
                <Wifi className="w-3.5 h-3.5" />
                <span>Wi-Fi / AP Connection Event</span>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-sky-900/50 text-sky-200 text-[10px] font-mono border border-sky-700/50">
                {trig.wifi_event || 'ap_client_connected'}
                {trig.ssid ? ` • SSID: ${trig.ssid}` : ''}
                {trig.client_mac ? ` • MAC: ${trig.client_mac}` : ''}
                {trig.target_rssi ? ` • RSSI: ≥${trig.target_rssi} dBm` : ''}
              </span>
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-slate-400 mb-1">Wi-Fi Event</label>
              <select
                value={trig.wifi_event || 'ap_client_connected'}
                onChange={e => onUpdate({ ...trig, wifi_event: e.target.value })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sky-300 font-sans"
              >
                <option value="ap_client_connected">AP Client Connected (Phone/Tablet)</option>
                <option value="ap_client_disconnected">AP Client Disconnected</option>
                <option value="wifi_connected">Connected to Station Network</option>
                <option value="wifi_disconnected">Disconnected from Station Network</option>
              </select>
            </div>

            {trig.wifi_event === 'wifi_connected' ? (
              <>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] font-sans text-slate-400">Network SSID Filter</label>
                    {liveWifiStatus?.sta_connected && liveWifiStatus.sta_ssid && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...trig, ssid: liveWifiStatus.sta_ssid })}
                        className="text-[9px] text-sky-400 hover:underline cursor-pointer"
                        title="Set to currently connected SSID"
                      >
                        Use Current ({liveWifiStatus.sta_ssid})
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={trig.ssid || ''}
                    onChange={e => onUpdate({ ...trig, ssid: e.target.value })}
                    placeholder="e.g. Home_Garage_WiFi (or blank for any)"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-400 mb-1">Min Station RSSI Threshold (dBm)</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={trig.target_rssi || 0}
                      onChange={e => onUpdate({ ...trig, target_rssi: parseInt(e.target.value) || 0 })}
                      placeholder="0 = any, e.g. -75"
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sky-300 font-mono font-bold"
                    />
                    {liveWifiStatus?.sta_connected && liveWifiStatus.sta_rssi !== undefined && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...trig, target_rssi: liveWifiStatus.sta_rssi })}
                        className="shrink-0 px-2 py-1 bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 rounded text-[10px] font-sans font-bold transition flex items-center gap-1 cursor-pointer"
                        title="Auto-populate with current station RSSI"
                      >
                        <Signal className="w-3 h-3 text-sky-400" />
                        <span>Set Current ({liveWifiStatus.sta_rssi} dBm)</span>
                      </button>
                    )}
                  </div>
                  <span className="text-[9px] text-slate-500 font-sans block mt-0.5">0 = trigger on any signal level</span>
                </div>
              </>
            ) : trig.wifi_event === 'wifi_disconnected' ? (
              <div className="sm:col-span-2">
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Network SSID Filter (Optional)</label>
                <input
                  type="text"
                  value={trig.ssid || ''}
                  onChange={e => onUpdate({ ...trig, ssid: e.target.value })}
                  placeholder="e.g. Home_Garage_WiFi (leave blank for any network)"
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-400 mb-1">Client MAC Filter (Optional)</label>
                  <input
                    type="text"
                    value={trig.client_mac || ''}
                    onChange={e => onUpdate({ ...trig, client_mac: e.target.value })}
                    placeholder="e.g. AA:BB:CC:DD:EE:FF"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-400 mb-1">Proximity RSSI Threshold (dBm)</label>
                  <input
                    type="number"
                    value={trig.target_rssi || 0}
                    onChange={e => onUpdate({ ...trig, target_rssi: parseInt(e.target.value) || 0 })}
                    placeholder="0 = any, e.g. -60 for close"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono"
                  />
                  <span className="text-[9px] text-slate-500 font-sans block mt-0.5">0 = trigger on any signal level</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // CAN Trigger: Dual-View with Catalog recognition
  const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForTrigger(trig, catalog) : {};
  const hasOptions = !!(catalogCmd?.options && catalogCmd.options.length > 0);
  const triggerName =
    catalogCmd?.ha_metadata?.name ||
    catalogCmd?.name ||
    trig.source_command_name ||
    (trig.can_id ? `CAN Trigger ${trig.can_id}` : `Trigger ${tIdx + 1}`);

  return (
    <div className="p-2.5 sm:p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 hover:border-slate-700/80 space-y-2.5 text-xs transition-all shadow-sm min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
          >
            {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <span className="w-5 h-5 rounded-full bg-amber-950 text-amber-300 font-bold text-[10px] flex items-center justify-center border border-amber-800 shrink-0">
            T{tIdx + 1}
          </span>
          <span className="font-semibold text-white text-xs sm:text-sm tracking-tight truncate">{triggerName}</span>
          
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
          {hasOptions && !collapsed && (
            <button
              type="button"
              onClick={toggleAdvanced}
              className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                showAdvanced
                  ? 'bg-amber-950/60 text-amber-300 border-amber-800/80 shadow'
                  : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800 hover:bg-slate-850'
              }`}
              title="Toggle configuration details"
            >
              <Sliders className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden xs:inline sm:inline">{showAdvanced ? 'Simple' : 'Details'}</span>
            </button>
          )}
          {actionButtons}
        </div>
      </div>

      {!collapsed && (
        <>

      {/* Option Selector Big Pills in Smart Grid Rows */}
      {hasOptions && (
        <div className="space-y-1.5 pt-0.5">
          {groupOptionsIntoGridRows(catalogCmd.options).map((group, gIdx) => {
            const itemCount = group.items.length;
            const gridClass =
              itemCount === 1
                ? 'flex'
                : itemCount === 2
                ? 'grid grid-cols-2 gap-1.5'
                : itemCount === 3
                ? 'grid grid-cols-2 sm:grid-cols-3 gap-1.5'
                : itemCount === 4
                ? 'grid grid-cols-2 sm:grid-cols-4 gap-1.5'
                : 'grid grid-cols-2 sm:grid-cols-3 gap-1.5';

            return (
              <div key={group.key || gIdx} className={gridClass}>
                {group.items.map(({ opt, origIndex }) => {
                  const isSelected =
                    (trig.option_label && opt.label.toLowerCase() === trig.option_label.toLowerCase()) ||
                    (matchedOption && opt.label.toLowerCase() === matchedOption.label.toLowerCase()) ||
                    (!trig.option_label && !matchedOption && origIndex === 0);

                  return (
                    <button
                      key={opt.label || origIndex}
                      type="button"
                      onClick={() => {
                        const updated = applyOptionToTrigger(trig, catalogCmd, opt);
                        onUpdate(updated);
                      }}
                      className={`${
                        itemCount === 1 ? 'px-4 min-w-[90px]' : 'w-full px-2'
                      } py-1.5 rounded-lg text-xs font-medium transition flex items-center justify-center gap-1.5 border cursor-pointer text-center ${
                        isSelected
                          ? 'bg-amber-500/20 text-amber-200 border-amber-500/80 font-semibold shadow-sm ring-1 ring-amber-500/40'
                          : 'bg-slate-900/90 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border-slate-800'
                      }`}
                    >
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Advanced Details View */}
      {(!hasOptions || showAdvanced) && (
        <div className={`space-y-3 ${hasOptions ? 'pt-2.5 border-t border-slate-850' : ''}`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Trigger ID</label>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-amber-300 text-[11px] font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
              <input
                type="text"
                value={trig.can_id || ''}
                onChange={e => onUpdate({ ...trig, can_id: e.target.value })}
                placeholder="0x448"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Bus</label>
              <select
                value={trig.bus ?? 0}
                onChange={e => onUpdate({ ...trig, bus: parseInt(e.target.value) || 0 })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
              >
                <option value={0}>Bus 0</option>
                <option value={1}>Bus 1</option>
              </select>
            </div>
            
          </div>

          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Target Match (1-based D1..D8)</label>
              <input
                type="text"
                value={
                  typeof trig.match === 'object' && Object.keys(trig.match).length > 0
                    ? JSON.stringify(trig.match)
                    : typeof trig.to_payload === 'object' && Object.keys(trig.to_payload).length > 0
                    ? JSON.stringify(trig.to_payload)
                    : typeof trig.to_payload === 'string'
                    ? trig.to_payload
                    : ''
                }
                onChange={e => {
                  const compiled = compileToByteMap(e.target.value);
                  onUpdate({ ...trig, match: compiled, to_payload: compiled });
                }}
                placeholder='{"D7":"0x0"}'
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-cyan-300 font-bold"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Byte Transition (Byte, Mask, From, To)</label>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="D7"
                  value={trig.byte || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : '')}
                  onChange={e => {
                    const byte = e.target.value.toUpperCase();
                    const num = parseInt(e.target.value.replace(/\D/g, ''), 10);
                    const byte_index = !isNaN(num) && num >= 1 && num <= 8 ? num - 1 : trig.byte_index;
                    onUpdate({ ...trig, byte, byte_index });
                  }}
                  className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 text-center font-bold"
                  title="1-based Byte (D1..D8)"
                />
                <input
                  type="text"
                  placeholder="Mask"
                  value={trig.mask || ''}
                  onChange={e => onUpdate({ ...trig, mask: e.target.value })}
                  className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-yellow-300 text-center font-bold"
                  title="Byte Bitmask (e.g. 0xF0)"
                />
                <input
                  type="text"
                  placeholder="From"
                  value={trig.from || (trig.from_value !== undefined ? `0x${trig.from_value.toString(16).padStart(2, '0').toUpperCase()}` : '')}
                  onChange={e => {
                    const from = e.target.value;
                    const from_value = e.target.value === '' ? undefined : parseInt(e.target.value, 16) || 0;
                    onUpdate({ ...trig, from, from_value });
                  }}
                  className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 text-center"
                  title="From Value (e.g. 0x00)"
                />
                <input
                  type="text"
                  placeholder="To"
                  value={trig.to || (trig.to_value !== undefined ? `0x${trig.to_value.toString(16).padStart(2, '0').toUpperCase()}` : '')}
                  onChange={e => {
                    const to = e.target.value;
                    const to_value = e.target.value === '' ? undefined : parseInt(e.target.value, 16) || 0;
                    onUpdate({ ...trig, to, to_value });
                  }}
                  className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-cyan-300 text-center font-bold"
                  title="To Value (e.g. 0x10)"
                />
              </div>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

interface ActionNodeEditorProps {
  key?: React.Key;
  act: AutomationAction;
  index: number;
  depth?: number;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (updated: AutomationAction) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
  onTestSingleAction?: (act: AutomationAction) => void;
}

interface ActionListEditorProps {
  actions: AutomationAction[];
  depth?: number;
  label?: string;
  emptyText?: string;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (actions: AutomationAction[]) => void;
  onPullCatalog?: () => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
  onTestSingleAction?: (act: AutomationAction) => void;
}
