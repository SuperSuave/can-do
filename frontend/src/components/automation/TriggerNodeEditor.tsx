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
  Radio,
  Sliders
} from 'lucide-react';
import { AutomationTrigger, AutomationAction, AutomationCondition } from '../../types/automation';
import { Catalog, CommandOption } from '../../types/catalog';
import { compileToByteMap, resolveCatalogCommandForTrigger, applyOptionToTrigger } from '../../utils/automationConverters';
import { groupOptionsIntoGridRows, OptionGridGroup, LiveWifiStatus, LiveBleItem } from './liveEvaluator';
import { DayOfWeekPicker } from './DayOfWeekPicker';
import { BleButtonComboPicker } from '../BleButtonComboPicker';
import { BleDeviceSelect, BleBeaconSelect, BleActionSelect } from '../BleSelects';
import { SustainedDurationInput, formatSustainedBadge } from './SustainedDurationInput';
import { AutomationClipboardContext } from './AutomationClipboardContext';
import { NumericRangeNodeEditor } from './NumericRangeNodeEditor';

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
    if (trig.name || trig.command_name) {
      return trig.name || trig.command_name || 'Custom CAN Trigger';
    }
    return trig.can_id ? `CAN ${trig.can_id}` : 'Custom CAN Trigger';
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
          className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition shrink-0"
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
          className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition shrink-0"
          title="Move down"
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </button>
      )}
      {onDuplicate && (
        <button
          type="button"
          onClick={onDuplicate}
          className="p-1 text-muted hover:text-accent transition shrink-0"
          title="Duplicate trigger"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => copyToClipboard('trigger', trig, getTriggerLabel())}
        className="p-1 text-muted hover:text-warning transition shrink-0"
        title="Copy trigger to clipboard"
      >
        <ClipboardCopy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-muted hover:text-danger transition shrink-0"
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
        className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-2.5 text-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-accent" />
              <span className="font-semibold text-foreground">Time Schedule</span>
              {trig.time && (
                <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground text-[10px] border border-accent/30 font-mono">
                  {trig.time}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[10px] text-muted font-sans">ID:</span>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="bg-surface-tertiary border border-border rounded px-1.5 py-0.5 text-accent text-[11px] font-mono focus:outline-none focus:border-accent w-24"
              />
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-sans text-muted mb-1">Trigger ID</label>
                <input
                  type="text"
                  value={trig.id || ''}
                  onChange={e => onUpdate({ ...trig, id: e.target.value })}
                  placeholder={`trig_${tIdx + 1}`}
                  className="w-full bg-surface-tertiary border border-border rounded px-2.5 py-1 text-accent font-mono text-xs focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-[10px] font-sans text-muted mb-1">Target Time (24h)</label>
                <input
                  type="time"
                  value={trig.time || ''}
                  onChange={e => onUpdate({ ...trig, time: e.target.value })}
                  className="w-full bg-surface-tertiary border border-border rounded px-2.5 py-1 text-accent font-mono text-xs focus:outline-none focus:border-accent"
                />
              </div>
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
        className="p-3.5 rounded-xl bg-surface-secondary border border-accent/40 space-y-2.5 text-xs shadow-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-accent font-semibold">
                <Bluetooth className="w-3.5 h-3.5" />
                <span>Bluetooth Remote Button</span>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground text-[10px] font-mono border border-accent/30">
                {trig.ble_button || 'any'} • {trig.ble_action || 'press'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[10px] text-muted font-sans">ID:</span>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="bg-surface-tertiary border border-border rounded px-1.5 py-0.5 text-accent text-[11px] font-mono focus:outline-none focus:border-accent w-24"
              />
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 font-mono text-[11px] items-end">
            <div className="flex flex-col justify-end">
              <label className="block text-[10px] font-sans text-muted mb-1">Trigger ID</label>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="w-full h-8 bg-surface-tertiary border border-border rounded px-2 text-accent font-mono text-[11px] box-border focus:outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col justify-end">
              <BleButtonComboPicker
                value={trig.ble_button ?? 'any'}
                onChange={val => onUpdate({ ...trig, ble_button: val })}
                label="Button or Multi-Button Combo Chord"
              />
            </div>

            <div className="flex flex-col justify-end">
              <BleActionSelect
                value={trig.ble_action || 'press'}
                onChange={val => onUpdate({ ...trig, ble_action: val })}
              />
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
      <div className="p-3.5 rounded-xl bg-surface-secondary border border-purple-500/40 space-y-2.5 text-xs shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400 font-semibold">
                <Bluetooth className="w-3.5 h-3.5" />
                <span>Presence / Proximity</span>
              </div>
              {formatSustainedBadge(trig.for_sec, trig.for_ms) && (
                <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600 dark:text-purple-400 text-[10px] font-mono border border-purple-500/30">
                  for {formatSustainedBadge(trig.for_sec, trig.for_ms)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[10px] text-muted font-sans">ID:</span>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="bg-surface-tertiary border border-border rounded px-1.5 py-0.5 text-purple-600 dark:text-purple-400 text-[11px] font-mono focus:outline-none focus:border-purple-500 w-24"
              />
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 font-mono text-[11px] items-end">
              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-muted mb-1">Trigger ID</label>
                <input
                  type="text"
                  value={trig.id || ''}
                  onChange={e => onUpdate({ ...trig, id: e.target.value })}
                  placeholder={`trig_${tIdx + 1}`}
                  className="w-full h-8 bg-surface-tertiary border border-border rounded px-2 text-purple-600 dark:text-purple-400 font-mono text-[11px] box-border focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-muted mb-1">Tracking Target</label>
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
                  className="w-full h-8 bg-surface-tertiary border border-border rounded px-2 text-purple-600 dark:text-purple-400 font-sans box-border"
                >
                  <option value="phone_beacon">BLE Beacon</option>
                  <option value="paired_device">Paired Device</option>
                </select>
              </div>

              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-muted mb-1">Trigger Event</label>
                {currentMode === 'phone_beacon' ? (
                  <select
                    value={trig.ble_event || 'present'}
                    onChange={e => onUpdate({ ...trig, ble_event: e.target.value })}
                    className="w-full h-8 bg-surface-tertiary border border-border rounded px-2 text-purple-600 dark:text-purple-400 font-sans box-border"
                  >
                    <option value="present">Present</option>
                    <option value="away">Away</option>
                    <option value="enter">Walk-Up</option>
                    <option value="exit">Walk-Away</option>
                    <option value="proximity">Proximity Signal (Continuous RSSI)</option>
                  </select>
                ) : (
                  <select
                    value={trig.ble_event || 'connected'}
                    onChange={e => onUpdate({ ...trig, ble_event: e.target.value })}
                    className="w-full h-8 bg-surface-tertiary border border-border rounded px-2 text-accent font-sans box-border"
                  >
                    <option value="present">Present</option>
                    <option value="away">Away</option>
                    <option value="connected">Device Connected</option>
                    <option value="disconnected">Device Disconnected</option>
                    <option value="proximity">Proximity Signal</option>
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
                <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-surface-tertiary border border-border">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-sans text-muted">Proximity Threshold:</span>
                    <input
                      type="number"
                      value={trig.target_rssi ?? -70}
                      onChange={e => onUpdate({ ...trig, target_rssi: parseInt(e.target.value) || -70 })}
                      placeholder="-70"
                      className="w-20 bg-surface-secondary border border-border rounded px-2 py-0.5 text-purple-600 dark:text-purple-400 font-mono font-bold text-center text-[11px]"
                    />
                    <span className="text-[10px] font-mono text-muted">dBm</span>
                    {liveRssi !== undefined && liveRssi !== 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30 text-[10px] font-bold">
                        <Signal className="w-3 h-3 animate-pulse" />
                        Live: {liveRssi} dBm
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {liveRssi !== undefined && liveRssi !== 0 && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...trig, target_rssi: liveRssi })}
                        className="px-2 py-0.5 text-[10px] font-sans rounded bg-purple-500/15 hover:bg-purple-500/25 text-purple-600 dark:text-purple-400 border border-purple-500/30 font-bold transition flex items-center gap-1 cursor-pointer"
                        title="Auto-populate trigger threshold with current live signal"
                      >
                        📍 Set to Current ({liveRssi} dBm)
                      </button>
                    )}
                    <span className="text-[10px] font-sans text-muted">Presets:</span>
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...trig, target_rssi: -60 })}
                      className={`px-2 py-0.5 text-[10px] font-sans rounded border transition ${
                        (trig.target_rssi ?? -70) === -60
                          ? 'bg-purple-500 text-white border-purple-500'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground'
                      }`}
                    >
                      In-Car (-60)
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...trig, target_rssi: -75 })}
                      className={`px-2 py-0.5 text-[10px] font-sans rounded border transition ${
                        (trig.target_rssi ?? -70) === -75
                          ? 'bg-purple-500 text-white border-purple-500'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground'
                      }`}
                    >
                      Doors (-75)
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...trig, target_rssi: -85 })}
                      className={`px-2 py-0.5 text-[10px] font-sans rounded border transition ${
                        (trig.target_rssi ?? -70) === -85
                          ? 'bg-purple-500 text-white border-purple-500'
                          : 'bg-surface-secondary text-muted border-border hover:text-foreground'
                      }`}
                    >
                      Walk-Up (-85)
                    </button>
                  </div>
                </div>
              );
            })()}
            <SustainedDurationInput
              forSec={trig.for_sec}
              forMs={trig.for_ms}
              onChange={next => onUpdate({ ...trig, ...next })}
            />
          </div>
        )}
      </div>
    );
  }

  // Wi-Fi / Device Trigger
  if (trig.type === 'wifi' || trig.type === 'wifi_event' || trig.source === 'wifi') {
    return (
      <div className="p-3.5 rounded-xl bg-surface-secondary border border-accent/40 space-y-2.5 text-xs shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-accent font-semibold">
                <Wifi className="w-3.5 h-3.5" />
                <span>Wi-Fi / AP Connection Event</span>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground text-[10px] font-mono border border-accent/30">
                {trig.wifi_event || 'ap_client_connected'}
                {trig.ssid ? ` • SSID: ${trig.ssid}` : ''}
                {trig.client_mac ? ` • MAC: ${trig.client_mac}` : ''}
                {trig.target_rssi ? ` • RSSI: ≥${trig.target_rssi} dBm` : ''}
                {formatSustainedBadge(trig.for_sec, trig.for_ms) ? ` • for ${formatSustainedBadge(trig.for_sec, trig.for_ms)}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[10px] text-muted font-sans">ID:</span>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="bg-surface-tertiary border border-border rounded px-1.5 py-0.5 text-accent text-[11px] font-mono focus:outline-none focus:border-accent w-24"
              />
            </div>
          </div>
          {actionButtons}
        </div>

        {!collapsed && (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-muted mb-1">Trigger ID</label>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-accent font-mono text-[11px] focus:outline-none focus:border-accent"
              />
            </div>

            <div>
              <label className="block text-[10px] font-sans text-muted mb-1">Wi-Fi Event</label>
              <select
                value={trig.wifi_event || 'ap_client_connected'}
                onChange={e => onUpdate({ ...trig, wifi_event: e.target.value })}
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-accent font-sans"
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
                    <label className="text-[10px] font-sans text-muted">Network SSID Filter</label>
                    {liveWifiStatus?.sta_connected && liveWifiStatus.sta_ssid && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...trig, ssid: liveWifiStatus.sta_ssid })}
                        className="text-[9px] text-accent hover:underline cursor-pointer"
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
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-sans"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-muted mb-1">Min Station RSSI Threshold (dBm)</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={trig.target_rssi || 0}
                      onChange={e => onUpdate({ ...trig, target_rssi: parseInt(e.target.value) || 0 })}
                      placeholder="0 = any, e.g. -75"
                      className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-accent font-mono font-bold"
                    />
                    {liveWifiStatus?.sta_connected && liveWifiStatus.sta_rssi !== undefined && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...trig, target_rssi: liveWifiStatus.sta_rssi })}
                        className="shrink-0 px-2 py-1 bg-accent-soft hover:bg-accent/20 text-accent-soft-foreground border border-accent/30 rounded text-[10px] font-sans font-bold transition flex items-center gap-1 cursor-pointer"
                        title="Auto-populate with current station RSSI"
                      >
                        <Signal className="w-3 h-3 text-accent" />
                        <span>Set Current ({liveWifiStatus.sta_rssi} dBm)</span>
                      </button>
                    )}
                  </div>
                  <span className="text-[9px] text-muted font-sans block mt-0.5">0 = trigger on any signal level</span>
                </div>
              </>
            ) : trig.wifi_event === 'wifi_disconnected' ? (
              <div className="sm:col-span-2">
                <label className="block text-[10px] font-sans text-muted mb-1">Network SSID Filter (Optional)</label>
                <input
                  type="text"
                  value={trig.ssid || ''}
                  onChange={e => onUpdate({ ...trig, ssid: e.target.value })}
                  placeholder="e.g. Home_Garage_WiFi (leave blank for any network)"
                  className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-muted mb-1">Client MAC Filter (Optional)</label>
                  <input
                    type="text"
                    value={trig.client_mac || ''}
                    onChange={e => onUpdate({ ...trig, client_mac: e.target.value })}
                    placeholder="e.g. AA:BB:CC:DD:EE:FF"
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-muted mb-1">Proximity RSSI Threshold (dBm)</label>
                  <input
                    type="number"
                    value={trig.target_rssi || 0}
                    onChange={e => onUpdate({ ...trig, target_rssi: parseInt(e.target.value) || 0 })}
                    placeholder="0 = any, e.g. -60 for close"
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-mono"
                  />
                  <span className="text-[9px] text-muted font-sans block mt-0.5">0 = trigger on any signal level</span>
                </div>
              </>
            )}
          </div>
          <SustainedDurationInput
            forSec={trig.for_sec}
            forMs={trig.for_ms}
            onChange={next => onUpdate({ ...trig, ...next })}
          />
          </>
        )}
      </div>
    );
  }

  // CAN Trigger: Dual-View with Catalog recognition
  const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForTrigger(trig, catalog) : {};
  const hasOptions = !!(catalogCmd?.options && catalogCmd.options.length > 0);
  const isRangeEntity = !hasOptions && Boolean(
    catalogCmd?.type === 'param_range' ||
    catalogCmd?.type === 'linear_scale' ||
    (catalogCmd?.network?.min !== undefined && catalogCmd?.network?.max !== undefined) ||
    catalogCmd?.network?.factor !== undefined ||
    trig.type === 'param_range'
  );
  const isCustomCan = !catalogCmd;
  const defaultCanName = isCustomCan
    ? (trig.can_id ? `Custom CAN (${trig.can_id})` : 'Custom CAN Trigger')
    : (catalogCmd?.ha_metadata?.name || catalogCmd?.name || 'CAN Trigger');

  const triggerName =
    trig.name ||
    trig.command_name ||
    trig.source_command_name ||
    defaultCanName;

  return (
    <div className="p-2.5 sm:p-3.5 rounded-xl bg-surface-secondary border border-border hover:border-border-secondary space-y-2.5 text-xs transition-all shadow-sm min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 flex-wrap">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="text-muted hover:text-foreground transition p-0.5 shrink-0"
          >
            {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <div className="flex items-center gap-1.5 text-warning font-semibold min-w-0">
            <Radio className="w-3.5 h-3.5 shrink-0" />
            <span className="font-semibold text-foreground text-xs sm:text-sm tracking-tight truncate">
              {triggerName}
            </span>
          </div>
          {trig.can_id && (
            <span className="px-1.5 py-0.5 rounded bg-warning-soft text-warning-soft-foreground text-[10px] border border-warning/30 font-mono">
              {trig.can_id}
            </span>
          )}
          {formatSustainedBadge(trig.for_sec, trig.for_ms) && (
            <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground text-[10px] border border-accent/30 font-mono">
              for {formatSustainedBadge(trig.for_sec, trig.for_ms)}
            </span>
          )}
          <div className="flex items-center gap-1.5 font-mono text-[11px] shrink-0">
            <span className="text-[10px] text-muted font-sans">ID:</span>
            <input
              type="text"
              value={trig.id || ''}
              onChange={e => onUpdate({ ...trig, id: e.target.value })}
              placeholder={`trig_${tIdx + 1}`}
              className="bg-surface-tertiary border border-border rounded px-1.5 py-0.5 text-warning text-[11px] font-mono focus:outline-none focus:border-warning w-24"
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
          {(hasOptions || isRangeEntity) && !collapsed && (
            <button
              type="button"
              onClick={toggleAdvanced}
              className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                showAdvanced
                  ? 'bg-warning-soft text-warning-soft-foreground border-warning/50 shadow'
                  : 'bg-surface-tertiary text-foreground/85 hover:text-foreground border-border hover:bg-default-hover'
              }`}
              title="Toggle configuration details"
            >
              <Sliders className="w-3.5 h-3.5 text-warning" />
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
                  const activeTrigOptionLabel = (trig.option_label || matchedOption?.label || '').toLowerCase().trim();
                  const isSelected = activeTrigOptionLabel
                    ? opt.label.toLowerCase().trim() === activeTrigOptionLabel
                    : origIndex === 0;

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
                          ? 'bg-warning-soft text-warning-soft-foreground border-warning/60 font-semibold shadow-sm ring-1 ring-warning/30'
                          : 'bg-surface-tertiary text-foreground/85 hover:text-foreground hover:bg-default-hover border-border'
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

      {/* Numeric Range Comparator for param_range / continuous telemetry */}
      {isRangeEntity && (
        <NumericRangeNodeEditor
          item={trig}
          catalogCmd={catalogCmd}
          onUpdate={onUpdate}
        />
      )}

      {/* Advanced Details View */}
      {((!hasOptions && !isRangeEntity) || showAdvanced) && (() => {
        const effectiveTrigCanId =
          trig.can_id ||
          catalogCmd?.network?.state_can_id ||
          catalogCmd?.state_can_id ||
          catalogCmd?.network?.action_can_id ||
          catalogCmd?.action_can_id ||
          '';
        const effectiveTrigBus = trig.bus ?? catalogCmd?.network?.bus ?? catalogCmd?.bus ?? 0;
        const fallbackTrigMatch = compileToByteMap(
          matchedOption?.match || matchedOption?.payload || catalogCmd?.match || catalogCmd?.payload
        );
        const effectiveTrigMatch =
          typeof trig.match === 'object' && trig.match && Object.keys(trig.match).length > 0
            ? trig.match
            : typeof trig.to_payload === 'object' && trig.to_payload && Object.keys(trig.to_payload).length > 0
            ? trig.to_payload
            : typeof trig.to_payload === 'string' && trig.to_payload.trim() !== ''
            ? trig.to_payload
            : Object.keys(fallbackTrigMatch).length > 0
            ? fallbackTrigMatch
            : '';
        const effectiveTrigByte =
          trig.byte ||
          (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : '') ||
          Object.keys(fallbackTrigMatch)[0] ||
          '';
        const rawFallbackMask = matchedOption?.mask || catalogCmd?.mask;
        const effectiveTrigMask =
          trig.mask ||
          (typeof rawFallbackMask === 'string'
            ? rawFallbackMask
            : rawFallbackMask && typeof rawFallbackMask === 'object' && effectiveTrigByte
            ? (rawFallbackMask as any)[effectiveTrigByte] || ''
            : '');
        const effectiveTrigTo =
          trig.to ||
          (trig.to_value !== undefined ? `0x${trig.to_value.toString(16).padStart(2, '0').toUpperCase()}` : '') ||
          (effectiveTrigByte && fallbackTrigMatch[effectiveTrigByte] ? fallbackTrigMatch[effectiveTrigByte] : '');

        return (
        <div className={`space-y-3 ${hasOptions ? 'pt-2.5 border-t border-separator' : ''}`}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-muted">Trigger Name</label>
              <input
                type="text"
                value={trig.name || ''}
                onChange={e => onUpdate({ ...trig, name: e.target.value })}
                placeholder={defaultCanName}
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground text-[11px] font-sans focus:outline-none focus:border-warning"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-muted">Trigger ID</label>
              <input
                type="text"
                value={trig.id || ''}
                onChange={e => onUpdate({ ...trig, id: e.target.value })}
                placeholder={`trig_${tIdx + 1}`}
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-warning text-[11px] font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-muted">CAN ID</label>
              <input
                type="text"
                value={effectiveTrigCanId}
                onChange={e => onUpdate({ ...trig, can_id: e.target.value })}
                placeholder="0x448"
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-muted">Bus</label>
              <select
                value={effectiveTrigBus}
                onChange={e => onUpdate({ ...trig, bus: parseInt(e.target.value) || 0 })}
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground"
              >
                <option value={0}>Bus 0</option>
                <option value={1}>Bus 1</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-muted">Target Match (1-based D1..D8)</label>
              <input
                type="text"
                value={
                  typeof effectiveTrigMatch === 'object' && effectiveTrigMatch && Object.keys(effectiveTrigMatch).length > 0
                    ? JSON.stringify(effectiveTrigMatch)
                    : typeof effectiveTrigMatch === 'string'
                    ? effectiveTrigMatch
                    : ''
                }
                onChange={e => {
                  const compiled = compileToByteMap(e.target.value);
                  onUpdate({
                    ...trig,
                    match: Object.keys(compiled).length > 0 ? compiled : undefined,
                    to_payload: Object.keys(compiled).length > 0 ? compiled : e.target.value
                  });
                }}
                placeholder='{"D7":"0x0"}'
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-accent font-bold"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-muted">Byte Transition (Byte, Mask, From, To)</label>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="D7"
                  value={effectiveTrigByte}
                  onChange={e => {
                    const byte = e.target.value.toUpperCase();
                    const num = parseInt(e.target.value.replace(/\D/g, ''), 10);
                    const byte_index = !isNaN(num) && num >= 1 && num <= 8 ? num - 1 : trig.byte_index;
                    onUpdate({ ...trig, byte, byte_index });
                  }}
                  className="w-1/4 bg-surface-tertiary border border-border rounded px-1.5 py-1 text-foreground text-center font-bold"
                  title="1-based Byte (D1..D8)"
                />
                <input
                  type="text"
                  placeholder="Mask"
                  value={effectiveTrigMask}
                  onChange={e => onUpdate({ ...trig, mask: e.target.value })}
                  className="w-1/4 bg-surface-tertiary border border-border rounded px-1.5 py-1 text-warning text-center font-bold"
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
                  className="w-1/4 bg-surface-tertiary border border-border rounded px-1.5 py-1 text-muted text-center"
                  title="From Value (e.g. 0x00)"
                />
                <input
                  type="text"
                  placeholder="To"
                  value={effectiveTrigTo}
                  onChange={e => {
                    const to = e.target.value;
                    const to_value = e.target.value === '' ? undefined : parseInt(e.target.value, 16) || 0;
                    onUpdate({ ...trig, to, to_value });
                  }}
                  className="w-1/4 bg-surface-tertiary border border-border rounded px-1.5 py-1 text-accent text-center font-bold"
                  title="To Value (e.g. 0x10)"
                />
              </div>
            </div>
          </div>
        </div>
        );
      })()}
      <SustainedDurationInput
        forSec={trig.for_sec}
        forMs={trig.for_ms}
        onChange={next => onUpdate({ ...trig, ...next })}
      />
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
