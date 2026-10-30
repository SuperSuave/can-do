import React, { useState, useContext } from 'react';
import {
  Check,
  HelpCircle,
  ArrowUp,
  ArrowDown,
  Copy,
  ClipboardCopy,
  Trash2,
  ChevronDown,
  ChevronUp,
  Radio,
  Clock,
  Wifi,
  Signal,
  Bluetooth,
  CheckSquare,
  Sliders,
  Plus,
  ClipboardPaste,
  X
} from 'lucide-react';
import { AutomationCondition, AutomationTrigger } from '../../types/automation';
import { Catalog, CommandOption } from '../../types/catalog';
import {
  resolveCatalogCommandForCondition,
  resolveCatalogCommandForTrigger,
  applyOptionToCondition,
  applyOptionsToCondition,
  regenerateConditionIds,
  compileToByteMap
} from '../../utils/automationConverters';
import {
  groupOptionsIntoGridRows,
  OptionGridGroup,
  LiveWifiStatus,
  LiveBleItem,
  evaluateConditionState,
  isOptionCurrentlyValid
} from './liveEvaluator';
import { DayOfWeekPicker } from './DayOfWeekPicker';
import { BleButtonComboPicker } from '../BleButtonComboPicker';
import { BleDeviceSelect, BleBeaconSelect } from '../BleSelects';
import { AutomationClipboardContext } from './AutomationClipboardContext';

export interface ConditionNodeEditorProps {
  key?: React.Key;
  cond: AutomationCondition;
  index: number;
  depth?: number;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (updated: AutomationCondition) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
}

export interface ConditionListEditorProps {
  conditions: AutomationCondition[];
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
  onUpdate: (conditions: AutomationCondition[]) => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
}

export function ConditionNodeEditor({
  cond,
  index,
  depth = 0,
  availableTriggers,
  catalog,
  liveFrames,
  entityStates,
  lastFiredTriggerId,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  onOpenAddConditionDialog
}: ConditionNodeEditorProps) {
  const { copyToClipboard } = useContext(AutomationClipboardContext);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState<boolean>(() => {
    return !!(cond.selected_options && cond.selected_options.length > 1) ||
           !!(cond.match && Object.keys(cond.match).length > 1);
  });
  const isGroup =
    cond.logic === 'and' ||
    cond.logic === 'or' ||
    cond.logic === 'not' ||
    cond.type === 'and_group' ||
    cond.type === 'or_group' ||
    cond.type === 'not_group';
  const groupLogic =
    cond.logic ||
    (cond.type === 'and_group' ? 'and' : cond.type === 'or_group' ? 'or' : cond.type === 'not_group' ? 'not' : 'and');

  const [collapsed, setCollapsed] = useState(false);

  // Evaluate current condition state against live telemetry
  const evalResult = evaluateConditionState(cond, liveFrames, entityStates, lastFiredTriggerId, catalog, liveWifiStatus, liveBleMap);

  const validityBadge = (
    <div
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full border transition shrink-0 ${
        evalResult.state === 'valid'
          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/70 shadow-sm shadow-emerald-500/20'
          : evalResult.state === 'invalid'
          ? 'bg-rose-500/20 text-rose-400 border-rose-500/70 shadow-sm shadow-rose-500/20'
          : 'bg-slate-800 text-slate-400 border-slate-700'
      }`}
      title={evalResult.reason || `Status: ${evalResult.state.toUpperCase()}`}
    >
      {evalResult.state === 'valid' && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
      {evalResult.state === 'invalid' && <X className="w-3.5 h-3.5 stroke-[2.5]" />}
      {evalResult.state === 'unknown' && <HelpCircle className="w-3.5 h-3.5" />}
    </div>
  );

  const condDisplayName = cond.source_command_name || cond.option_label || cond.type || 'Condition';

  const actionButtons = (
    <div className="flex items-center gap-1 shrink-0 flex-wrap">
      {validityBadge}
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
          title="Duplicate condition"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => copyToClipboard('condition', cond, condDisplayName)}
        className="p-1 text-slate-500 hover:text-purple-400 transition shrink-0"
        title="Copy condition to clipboard"
      >
        <ClipboardCopy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-slate-500 hover:text-rose-400 transition shrink-0"
        title="Delete condition"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  if (isGroup) {
    const borderCls =
      groupLogic === 'and'
        ? 'border-purple-800/80 bg-purple-950/20'
        : groupLogic === 'or'
        ? 'border-indigo-800/80 bg-indigo-950/20'
        : 'border-rose-800/80 bg-rose-950/20';
    const tagCls =
      groupLogic === 'and'
        ? 'bg-purple-900 text-purple-200 border-purple-700'
        : groupLogic === 'or'
        ? 'bg-indigo-900 text-indigo-200 border-indigo-700'
        : 'bg-rose-900 text-rose-200 border-rose-700';

    return (
      <div className={`p-2.5 sm:p-3 rounded-xl border ${borderCls} space-y-2 text-xs transition-all min-w-0 overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap min-w-0">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className={`px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] border ${tagCls} shrink-0`}>
              {groupLogic} Group {depth > 0 && `(L${depth + 1})`}
            </span>
            <span className="text-slate-400 text-[11px] hidden sm:inline">
              {groupLogic === 'and' && '(ALL nested must match)'}
              {groupLogic === 'or' && '(ANY nested must match)'}
              {groupLogic === 'not' && '(Children must NOT match)'}
            </span>
            <span className="text-slate-500 font-mono text-[10px] shrink-0">
              [{(cond.conditions || []).length} items]
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
            <select
              value={groupLogic}
              onChange={e => onUpdate({ ...cond, logic: e.target.value as any })}
              className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-slate-300 text-[11px]"
            >
              <option value="and">AND Logic</option>
              <option value="or">OR Logic</option>
              <option value="not">NOT Logic</option>
            </select>
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="pl-1.5 sm:pl-2 border-l border-slate-800/80 min-w-0">
            <ConditionListEditor
              conditions={cond.conditions || []}
              depth={depth + 1}
              availableTriggers={availableTriggers}
              catalog={catalog}
              liveFrames={liveFrames}
              entityStates={entityStates}
              lastFiredTriggerId={lastFiredTriggerId}
              liveWifiStatus={liveWifiStatus}
              liveBleMap={liveBleMap}
              emptyText="Empty group. Add conditions below."
              onUpdate={updatedSubs => onUpdate({ ...cond, conditions: updatedSubs })}
              onOpenAddConditionDialog={onOpenAddConditionDialog}
            />
          </div>
        )}
      </div>
    );
  }

  // Triggered by condition
  if (cond.type === 'triggered_by' || cond.type === 'trigger' || cond.trigger_id !== undefined) {
    const matchedTrig = (availableTriggers || []).find(t => t.id === cond.trigger_id);
    return (
      <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950 border border-amber-900/60 space-y-2 text-xs min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-amber-950 text-amber-300 font-bold text-[10px] flex items-center justify-center border border-amber-800 shrink-0">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <Radio className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-semibold text-white truncate">Triggered By</span>
            </div>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <>
            <div className="font-mono text-[11px]">
              <div>
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Select Trigger</label>
                <select
                  value={cond.trigger_id || ''}
                  onChange={e => onUpdate({ ...cond, type: 'triggered_by', trigger_id: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-amber-300 font-mono text-xs focus:outline-none focus:border-amber-500"
                >
                  <option value="">-- Choose Rule Trigger --</option>
                  {(availableTriggers || []).map((t, tIdx) => {
                    const { command: tCmd, matchedOption: tOpt } = catalog ? resolveCatalogCommandForTrigger(t, catalog) : {};
                    let tName = tCmd?.ha_metadata?.name || tCmd?.name || t.source_command_name || t.can_id || `Trigger ${tIdx + 1}`;
                    if (tOpt) tName += ` (${tOpt.label})`;
                    return (
                      <option key={t.id || tIdx} value={t.id}>
                        {tName}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
            {matchedTrig && (
              <div className="text-[11px] text-slate-400 font-sans flex items-center gap-1.5 pt-0.5 min-w-0 flex-wrap">
                <span className="text-slate-500">Source:</span>
                <span className="text-slate-300 font-semibold">{matchedTrig.source_command_name || matchedTrig.can_id}</span>
                {matchedTrig.option_label && (
                  <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 text-[10px]">
                    {matchedTrig.option_label}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // Time window condition
  if (cond.type === 'time_condition' || cond.type === 'time') {
    return (
      <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950 border border-cyan-900/60 space-y-2 text-xs min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 font-bold text-[10px] flex items-center justify-center border border-cyan-800 shrink-0">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <Clock className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="font-semibold text-white truncate">Time Window</span>
              {(cond.start_time || cond.end_time) && (
                <span className="px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60 font-mono shrink-0">
                  {cond.start_time || '--:--'} - {cond.end_time || '--:--'}
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Start Time (24h)</label>
                <input
                  type="time"
                  value={cond.start_time || ''}
                  onChange={e => onUpdate({ ...cond, start_time: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-[10px] font-sans text-slate-400 mb-1">End Time (24h)</label>
                <input
                  type="time"
                  value={cond.end_time || ''}
                  onChange={e => onUpdate({ ...cond, end_time: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            <DayOfWeekPicker
              selectedDays={cond.days}
              onChange={days => onUpdate({ ...cond, days })}
            />
          </>
        )}
      </div>
    );
  }

  // ESP32 Wi-Fi / AP Mode condition
  if (cond.type === 'device_state' || cond.type === 'wifi' || cond.type === 'wifi_condition') {
    const prop = cond.device_property || 'wifi_ssid';
    return (
      <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950 border border-sky-900/60 space-y-2 text-xs min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-sky-950 text-sky-300 font-bold text-[10px] flex items-center justify-center border border-sky-800 shrink-0">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <Wifi className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="font-semibold text-white truncate">ESP32 Wi-Fi / AP Mode</span>
              <span className="px-1.5 py-0.2 rounded bg-sky-950 text-sky-300 text-[10px] border border-sky-800/60 font-mono shrink-0">
                {prop}
              </span>
            </div>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-2 pt-1 border-t border-slate-900">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Device Property</label>
                <select
                  value={prop}
                  onChange={e => onUpdate({ ...cond, device_property: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sky-300 font-sans"
                >
                  <option value="wifi_ssid">Connected Wi-Fi SSID</option>
                  <option value="wifi_connected">Wi-Fi Station Connection Status</option>
                  <option value="wifi_rssi">Wi-Fi Station Signal (RSSI Threshold)</option>
                  <option value="wifi_mode">Wi-Fi Mode (AP / Station / Both)</option>
                  <option value="ap_client_connected">AP Client Connected (MAC Presence)</option>
                  <option value="ap_client_rssi">AP Client Proximity (Signal RSSI)</option>
                </select>
              </div>

              {prop === 'wifi_ssid' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[10px] font-sans text-slate-400">Target Network SSID</label>
                    {liveWifiStatus?.sta_connected && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ ...cond, target_string: liveWifiStatus.sta_ssid })}
                        className="text-[10px] text-sky-400 hover:text-sky-300 underline font-mono flex items-center gap-0.5 cursor-pointer"
                        title="Use current connected SSID"
                      >
                        📍 Use '{liveWifiStatus.sta_ssid}'
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <select
                      value={cond.operator || 'equal'}
                      onChange={e => onUpdate({ ...cond, operator: e.target.value })}
                      className="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 font-mono w-24 shrink-0"
                    >
                      <option value="equal">== (Is)</option>
                      <option value="not_equal">!= (Not)</option>
                    </select>
                    <input
                      type="text"
                      value={cond.target_string || ''}
                      onChange={e => onUpdate({ ...cond, target_string: e.target.value })}
                      placeholder="e.g. Home_WiFi"
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                    />
                  </div>
                </div>
              )}

              {prop === 'wifi_connected' && (
                <div>
                  <label className="block text-[10px] font-sans text-slate-400 mb-1">Expected Status</label>
                  <select
                    value={cond.target_bool !== false ? 'true' : 'false'}
                    onChange={e => onUpdate({ ...cond, target_bool: e.target.value === 'true' })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                  >
                    <option value="true">Connected to a Wi-Fi Network</option>
                    <option value="false">Disconnected (No Network)</option>
                  </select>
                </div>
              )}

              {prop === 'wifi_rssi' && (
                <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Target Network SSID (Optional)</label>
                    <input
                      type="text"
                      value={cond.target_string || ''}
                      onChange={e => onUpdate({ ...cond, target_string: e.target.value })}
                      placeholder="e.g. Home_WiFi (blank = any connected network)"
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[10px] font-sans text-slate-400">Signal RSSI Threshold</label>
                      {liveWifiStatus?.sta_connected && (
                        <button
                          type="button"
                          onClick={() => onUpdate({ ...cond, target_rssi: liveWifiStatus.sta_rssi })}
                          className="text-[10px] text-sky-400 hover:text-sky-300 underline font-mono flex items-center gap-0.5 cursor-pointer"
                          title="Populate with current live station RSSI"
                        >
                          📍 Use {liveWifiStatus.sta_rssi} dBm
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <select
                        value={cond.operator || 'greater_than'}
                        onChange={e => onUpdate({ ...cond, operator: e.target.value })}
                        className="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 font-mono w-28 shrink-0"
                      >
                        <option value="greater_than">&gt; (Stronger than)</option>
                        <option value="less_than">&lt; (Weaker than)</option>
                      </select>
                      <input
                        type="number"
                        value={cond.target_rssi ?? -65}
                        onChange={e => onUpdate({ ...cond, target_rssi: parseInt(e.target.value) || 0 })}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sky-300 font-mono font-bold text-center"
                      />
                      <span className="text-[10px] text-slate-500 shrink-0">dBm</span>
                    </div>
                  </div>
                </div>
              )}

              {prop === 'wifi_mode' && (
                <div>
                  <label className="block text-[10px] font-sans text-slate-400 mb-1">Expected Mode</label>
                  <select
                    value={cond.target_string || 'ap'}
                    onChange={e => onUpdate({ ...cond, target_string: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                  >
                    <option value="ap">In SoftAP Mode (Standalone Hotspot)</option>
                    <option value="sta">Connected as Client (Station Mode)</option>
                    <option value="both">Both SoftAP and Station Active</option>
                  </select>
                </div>
              )}

              {prop === 'ap_client_connected' && (
                <div>
                  <label className="block text-[10px] font-sans text-slate-400 mb-1">Client MAC Address (Optional)</label>
                  <input
                    type="text"
                    value={cond.target_string || ''}
                    onChange={e => onUpdate({ ...cond, target_string: e.target.value })}
                    placeholder="e.g. AA:BB:CC:DD:EE:FF (blank = any client)"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono"
                  />
                </div>
              )}

              {prop === 'ap_client_rssi' && (
                <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Client MAC Filter</label>
                    <input
                      type="text"
                      value={cond.target_string || ''}
                      onChange={e => onUpdate({ ...cond, target_string: e.target.value })}
                      placeholder="e.g. AA:BB:CC:DD:EE:FF (or blank for closest)"
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Proximity RSSI Threshold</label>
                    <div className="flex items-center gap-1">
                      <select
                        value={cond.operator || 'greater_than'}
                        onChange={e => onUpdate({ ...cond, operator: e.target.value })}
                        className="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 font-mono w-28 shrink-0"
                      >
                        <option value="greater_than">&gt; (Closer than)</option>
                        <option value="less_than">&lt; (Further than)</option>
                      </select>
                      <input
                        type="number"
                        value={cond.target_rssi ?? -65}
                        onChange={e => onUpdate({ ...cond, target_rssi: parseInt(e.target.value) || 0 })}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sky-300 font-mono font-bold text-center"
                      />
                      <span className="text-[10px] text-slate-500 shrink-0">dBm</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Optional RSSI Filter for wifi_connected or wifi_ssid */}
            {(prop === 'wifi_connected' || prop === 'wifi_ssid') && (
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-900/60 font-mono text-[11px] flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-sans text-slate-400">Signal RSSI Filter (Optional):</span>
                  <input
                    type="number"
                    value={cond.target_rssi ?? 0}
                    onChange={e => onUpdate({ ...cond, target_rssi: parseInt(e.target.value) || 0 })}
                    placeholder="0 = ignore, e.g. -65"
                    className="w-20 bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-sky-300 font-mono font-bold text-center text-[11px]"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">dBm</span>
                  <span className="text-[10px] text-slate-500 font-sans hidden sm:inline">(0 = check connection only)</span>
                </div>
                {liveWifiStatus?.sta_connected && (
                  <button
                    type="button"
                    onClick={() => onUpdate({ ...cond, target_rssi: liveWifiStatus.sta_rssi })}
                    className="px-2 py-0.5 rounded bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                    title="Populate with current live station signal"
                  >
                    📍 Set to Current ({liveWifiStatus.sta_rssi} dBm)
                  </button>
                )}
              </div>
            )}

            {/* Live Station Telemetry Bar */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-900/60 font-mono text-[11px] flex-wrap">
              <div className="flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span className="text-[10px] font-sans text-slate-400">Live Station Status:</span>
                {liveWifiStatus?.sta_connected ? (
                  <span className="px-1.5 py-0.5 rounded bg-sky-950 text-sky-300 border border-sky-800/80 font-bold flex items-center gap-1 text-[10px]">
                    <Signal className="w-3 h-3 text-sky-400 animate-pulse" />
                    {liveWifiStatus.sta_rssi} dBm ({liveWifiStatus.sta_ssid})
                  </span>
                ) : (
                  <span className="text-slate-500 text-[10px]">Disconnected</span>
                )}
              </div>
              {liveWifiStatus?.sta_connected && prop === 'wifi_rssi' && (
                <button
                  type="button"
                  onClick={() => onUpdate({ ...cond, target_rssi: liveWifiStatus.sta_rssi })}
                  className="px-2 py-0.5 rounded bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                  title="Autopopulate RSSI threshold with current station signal"
                >
                  📍 Auto-Populate Current ({liveWifiStatus.sta_rssi} dBm)
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Bluetooth Presence / Proximity condition (Phone Beacon or Paired Device)
  if (cond.type === 'ble_presence' || cond.type === 'ble_beacon' || cond.type === 'beacon' || cond.type === 'ble_device') {
    const isDeviceMode = cond.type === 'ble_device' || cond.device_property === 'connected' || (cond.device_property === 'rssi' && !cond.beacon_uuid);
    const currentMode = isDeviceMode ? 'paired_device' : 'phone_beacon';

    return (
      <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950 border border-purple-900/60 space-y-2 text-xs min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-purple-950 text-purple-300 font-bold text-[10px] flex items-center justify-center border border-purple-800 shrink-0">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <Bluetooth className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span className="font-semibold text-white truncate">Bluetooth Presence</span>
              <span className="px-1.5 py-0.2 rounded bg-purple-950 text-purple-300 text-[10px] border border-purple-800/60 font-mono shrink-0">
                {currentMode === 'phone_beacon'
                  ? (cond.target_bool !== false ? 'Beacon Present' : 'Beacon Absent')
                  : (cond.target_bool !== false ? 'Device Connected' : 'Device Disconnected')}
              </span>
            </div>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-2 pt-1 border-t border-slate-900">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] items-end">
              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Check Target</label>
                <select
                  value={currentMode}
                  onChange={e => {
                    const newMode = e.target.value;
                    if (newMode === 'phone_beacon') {
                      onUpdate({
                        ...cond,
                        type: 'ble_presence',
                        device_property: 'beacon_present',
                        target_bool: cond.target_bool !== false
                      });
                    } else {
                      onUpdate({
                        ...cond,
                        type: 'ble_presence',
                        device_property: 'connected',
                        target_bool: cond.target_bool !== false
                      });
                    }
                  }}
                  className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-purple-300 font-sans box-border"
                >
                  <option value="phone_beacon">Phone iBeacon / Key Fob</option>
                  <option value="paired_device">Paired Bluetooth Device</option>
                </select>
              </div>

              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Expected State</label>
                {currentMode === 'phone_beacon' ? (
                  <select
                    value={cond.target_bool !== false ? 'true' : 'false'}
                    onChange={e => onUpdate({ ...cond, target_bool: e.target.value === 'true' })}
                    className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-slate-200 box-border"
                  >
                    <option value="true">Beacon is Present (Near Car)</option>
                    <option value="false">Beacon is Absent (Away)</option>
                  </select>
                ) : (
                  <select
                    value={cond.target_bool !== false ? 'true' : 'false'}
                    onChange={e => onUpdate({ ...cond, target_bool: e.target.value === 'true' })}
                    className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-slate-200 box-border"
                  >
                    <option value="true">Device is Connected</option>
                    <option value="false">Device is Disconnected</option>
                  </select>
                )}
              </div>

              <div className="flex flex-col justify-end">
                {currentMode === 'phone_beacon' ? (
                  <BleBeaconSelect
                    value={cond.beacon_uuid || cond.ble_device || cond.target_string || ''}
                    onChange={val => {
                      onUpdate({ ...cond, beacon_uuid: val, ble_device: val, target_string: val });
                    }}
                    label="Beacon / Phone Filter"
                  />
                ) : (
                  <BleDeviceSelect
                    value={cond.ble_device || cond.target_string || ''}
                    onChange={val => {
                      onUpdate({ ...cond, ble_device: val, target_string: val });
                    }}
                    label="Device MAC Filter"
                  />
                )}
              </div>
            </div>

            {/* Optional RSSI threshold */}
            {(() => {
              const targetKey = (cond.beacon_uuid || cond.ble_device || cond.target_string || '').toLowerCase().trim();
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
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-900/60 font-mono text-[11px] flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-sans text-slate-400">Min RSSI Filter:</span>
                    <input
                      type="number"
                      value={cond.target_rssi ?? 0}
                      onChange={e => onUpdate({ ...cond, target_rssi: parseInt(e.target.value) || 0 })}
                      placeholder="0 = ignore, -70 = in car"
                      className="w-20 bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-purple-300 font-mono font-bold text-center text-[11px]"
                    />
                    <span className="text-[10px] text-slate-500 font-mono">dBm</span>
                    {liveRssi !== undefined && liveRssi !== 0 ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 text-[10px] font-bold">
                        <Signal className="w-3 h-3 text-purple-400 animate-pulse" />
                        Live: {liveRssi} dBm
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-500 font-sans hidden sm:inline">(0 = presence only)</span>
                    )}
                  </div>
                  {liveRssi !== undefined && liveRssi !== 0 && (
                    <button
                      type="button"
                      onClick={() => onUpdate({ ...cond, target_rssi: liveRssi })}
                      className="px-2 py-0.5 rounded bg-purple-950 hover:bg-purple-900 text-purple-300 border border-purple-800 text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                      title="Set condition threshold to current live RSSI"
                    >
                      📍 Set to Current ({liveRssi} dBm)
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    );
  }

  // Bluetooth Button Pressed condition
  if (cond.type === 'ble_button' || cond.type === 'ble_key' || cond.type === 'ble') {
    const btn = cond.ble_button || cond.target_string || 'volume_up';
    const act = cond.ble_action || 'press';
    return (
      <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950 border border-blue-900/60 space-y-2 text-xs min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="w-5 h-5 rounded-full bg-blue-950 text-blue-300 font-bold text-[10px] flex items-center justify-center border border-blue-800 shrink-0">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <Bluetooth className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="font-semibold text-white truncate">Bluetooth Button / Combo</span>
              <span className="px-1.5 py-0.2 rounded bg-blue-950 text-blue-300 text-[10px] border border-blue-800/60 font-mono shrink-0">
                {btn} • {act}
              </span>
            </div>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-2 pt-1 border-t border-slate-900">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] items-end">
              <div className="flex flex-col justify-end">
                <BleButtonComboPicker
                  value={btn}
                  onChange={val => onUpdate({ ...cond, ble_button: val, target_string: val })}
                  label="Target Button / Combo Chord"
                />
              </div>
              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-slate-400 mb-1">Action Event</label>
                <select
                  value={act}
                  onChange={e => onUpdate({ ...cond, ble_action: e.target.value })}
                  className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-slate-200 font-sans box-border"
                >
                  <option value="press">Press (or Combo)</option>
                  <option value="release">Release</option>
                  <option value="any">Any Event</option>
                </select>
              </div>
              <div className="flex flex-col justify-end">
                <BleDeviceSelect
                  value={cond.ble_device || ''}
                  onChange={val => onUpdate({ ...cond, ble_device: val })}
                  label="Device MAC Filter (Optional)"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }



  // Leaf CAN / Catalog condition
  const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForCondition(cond, catalog) : {};
  const hasOptions = !!(catalogCmd?.options && catalogCmd.options.length > 0);
  const conditionName =
    catalogCmd?.ha_metadata?.name ||
    catalogCmd?.name ||
    cond.source_command_name ||
    (cond.can_id ? `CAN Condition ${cond.can_id}` : `Condition ${index + 1}`);

  const fallbackCondMatch = compileToByteMap(
    matchedOption?.match || matchedOption?.payload || catalogCmd?.match || catalogCmd?.payload
  );
  const optEval = typeof matchedOption?.evaluate === 'object' ? matchedOption.evaluate : (typeof catalogCmd?.evaluate === 'object' ? catalogCmd.evaluate : undefined);
  const dKey =
    cond.byte ??
    cond.evaluate?.byte ??
    (cond.match && Object.keys(cond.match).length > 0 ? Object.keys(cond.match)[0] : undefined) ??
    optEval?.byte ??
    matchedOption?.byte ??
    Object.keys(fallbackCondMatch)[0] ??
    '';
  const rawMaskVal = cond.mask ?? cond.evaluate?.mask ?? optEval?.mask ?? matchedOption?.mask ?? catalogCmd?.mask ?? '';
  const maskVal =
    typeof rawMaskVal === 'string'
      ? rawMaskVal
      : rawMaskVal && typeof rawMaskVal === 'object'
      ? dKey && (rawMaskVal as any)[dKey]
        ? (rawMaskVal as any)[dKey]
        : JSON.stringify(rawMaskVal)
      : '';
  const rawOpVal = cond.operator || cond.evaluate?.operator || optEval?.operator || matchedOption?.operator || (cond.invert ? 'not_equal' : 'equal');
  const opVal =
    rawOpVal === '==' || rawOpVal === 'equals'
      ? 'equal'
      : rawOpVal === '!=' || rawOpVal === 'not_equals'
      ? 'not_equal'
      : rawOpVal === '<'
      ? 'less_than'
      : rawOpVal === '<='
      ? 'less_than_or_equal'
      : rawOpVal === '>'
      ? 'greater_than'
      : rawOpVal === '>='
      ? 'greater_than_or_equal'
      : rawOpVal;
  const targetVal =
    cond.value ??
    cond.evaluate?.value ??
    (cond.match && dKey ? cond.match[dKey] : undefined) ??
    (optEval?.value !== undefined ? String(optEval.value) : undefined) ??
    matchedOption?.value ??
    (dKey && fallbackCondMatch[dKey] ? fallbackCondMatch[dKey] : '');
  const effectiveCondCanId =
    cond.can_id ||
    catalogCmd?.network?.state_can_id ||
    catalogCmd?.state_can_id ||
    catalogCmd?.network?.action_can_id ||
    catalogCmd?.action_can_id ||
    '';
  const effectiveCondBus = cond.bus ?? catalogCmd?.network?.bus ?? catalogCmd?.bus ?? 0;
  const activeCondOptionLabel = (cond.option_label || matchedOption?.label || '').toLowerCase().trim();

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
          <span className="w-5 h-5 rounded-full bg-purple-950 text-purple-300 font-bold text-[10px] flex items-center justify-center border border-purple-800 shrink-0">
            C{index + 1}
          </span>
          <span className="font-semibold text-white text-xs sm:text-sm tracking-tight truncate">{conditionName}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
          {hasOptions && !collapsed && (
            <>
              {catalogCmd.options && catalogCmd.options.length > 1 && (
                <button
                  type="button"
                  onClick={() => setMultiSelectMode(!multiSelectMode)}
                  className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                    multiSelectMode
                      ? 'bg-purple-950/80 text-purple-200 border-purple-500 shadow-sm ring-1 ring-purple-500/50 font-semibold'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-850'
                  }`}
                  title="Toggle multi-state selection (e.g. check multiple doors simultaneously)"
                >
                  <CheckSquare className="w-3.5 h-3.5 text-purple-400" />
                  <span className="hidden xs:inline sm:inline">{multiSelectMode ? 'Multi-State' : 'Multi-Select'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                  showAdvanced
                    ? 'bg-purple-950/60 text-purple-300 border-purple-800/80 shadow'
                    : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800 hover:bg-slate-850'
                }`}
                title="Toggle configuration details"
              >
                <Sliders className="w-3.5 h-3.5 text-purple-400" />
                <span className="hidden xs:inline sm:inline">{showAdvanced ? 'Simple' : 'Details'}</span>
              </button>
            </>
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
                      const isMulti = multiSelectMode;
                      const selectedList = cond.selected_options || (cond.option_label ? cond.option_label.split(',').map(s => s.trim()) : []);
                      const isSelected = isMulti
                        ? selectedList.some(l => l.toLowerCase() === opt.label.toLowerCase())
                        : activeCondOptionLabel
                        ? opt.label.toLowerCase().trim() === activeCondOptionLabel
                        : origIndex === 0;

                      const isLiveValid = isOptionCurrentlyValid(
                        opt,
                        cond.can_id || catalogCmd.network?.state_can_id || catalogCmd.state_can_id || catalogCmd.network?.action_can_id || catalogCmd.action_can_id,
                        liveFrames,
                        cond.source_command_id || catalogCmd.id,
                        entityStates
                      );

                      let pillStyle = 'bg-slate-900/90 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border-slate-800';
                      if (isSelected && isLiveValid) {
                        pillStyle = 'bg-purple-950/60 text-purple-200 border-emerald-400 font-semibold shadow-md shadow-emerald-950/50 ring-2 ring-emerald-500/70';
                      } else if (isSelected) {
                        pillStyle = 'bg-purple-500/20 text-purple-200 border-purple-500/80 font-semibold shadow-sm ring-1 ring-purple-500/40';
                      } else if (isLiveValid) {
                        pillStyle = 'bg-emerald-950/40 text-emerald-300 border-emerald-500/80 font-medium shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/50';
                      }

                      return (
                        <button
                          key={opt.label || origIndex}
                          type="button"
                          onClick={() => {
                            if (isMulti) {
                              const already = selectedList.some(l => l.toLowerCase() === opt.label.toLowerCase());
                              let nextLabels: string[];
                              if (already) {
                                nextLabels = selectedList.filter(l => l.toLowerCase() !== opt.label.toLowerCase());
                              } else {
                                nextLabels = [...selectedList, opt.label];
                              }
                              const nextOpts = catalogCmd.options.filter(o => nextLabels.some(l => l.toLowerCase() === o.label.toLowerCase()));
                              const updated = applyOptionsToCondition(cond, catalogCmd, nextOpts);
                              onUpdate(updated);
                            } else {
                              const updated = applyOptionToCondition(cond, catalogCmd, opt);
                              onUpdate({ ...updated, selected_options: [opt.label] });
                            }
                          }}
                          className={`${
                            itemCount === 1 ? 'px-4 min-w-[90px]' : 'w-full px-2'
                          } py-1.5 rounded-lg text-xs font-medium transition flex items-center justify-center gap-1.5 border cursor-pointer text-center relative ${pillStyle}`}
                        >
                          {isMulti && (
                            <span className={`w-3.5 h-3.5 rounded flex items-center justify-center border text-[9px] shrink-0 ${
                              isSelected ? 'bg-purple-600 border-purple-400 text-white font-bold' : 'border-slate-700 bg-slate-900/60 text-transparent'
                            }`}>
                              ✓
                            </span>
                          )}
                          <span className="truncate">{opt.label}</span>
                          {isLiveValid && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" title="Matches current live vehicle state" />
                          )}
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
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 font-mono text-[11px]">
            <div className="col-span-1">
              <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
              <input
                type="text"
                value={effectiveCondCanId}
                onChange={e => onUpdate({ ...cond, can_id: e.target.value })}
                placeholder="0x120"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
              />
            </div>
            <div className="col-span-1">
              <label className="block text-[10px] font-sans text-slate-500">Bus</label>
              <select
                value={effectiveCondBus}
                onChange={e => onUpdate({ ...cond, bus: parseInt(e.target.value) || 0 })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-1 py-1 text-slate-200 font-sans"
              >
                <option value={0}>Bus 0</option>
                <option value={1}>Bus 1</option>
                <option value={2}>Bus 2</option>
              </select>
            </div>
            <div className="col-span-1">
              <label className="block text-[10px] font-sans text-slate-500">Byte</label>
              <input
                type="text"
                value={dKey}
                onChange={e => {
                  const val = e.target.value.toUpperCase();
                  onUpdate({
                    ...cond,
                    byte: val,
                    evaluate: { ...(cond.evaluate || { operator: opVal, value: targetVal }), byte: val }
                  });
                }}
                placeholder="D1"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-purple-300 font-bold text-center"
              />
            </div>
            <div className="col-span-1">
              <label className="block text-[10px] font-sans text-slate-500">Mask</label>
              <input
                type="text"
                value={maskVal}
                onChange={e => {
                  onUpdate({
                    ...cond,
                    mask: e.target.value,
                    evaluate: { ...(cond.evaluate || { byte: dKey, operator: opVal, value: targetVal }), mask: e.target.value }
                  });
                }}
                placeholder="0xFF"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-yellow-300 font-bold text-center"
              />
            </div>
            <div className="col-span-1">
              <label className="block text-[10px] font-sans text-slate-500">Operator</label>
              <select
                value={opVal}
                onChange={e => {
                  onUpdate({
                    ...cond,
                    operator: e.target.value,
                    evaluate: { ...(cond.evaluate || { byte: dKey, mask: maskVal, value: targetVal }), operator: e.target.value }
                  });
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded px-1 py-1 text-slate-200 font-sans"
              >
                <option value="equal">== (Equal)</option>
                <option value="not_equal">!= (Not Equal)</option>
                <option value="less_than">&lt; (Less Than)</option>
                <option value="less_than_or_equal">&lt;= (Less or Equal)</option>
                <option value="greater_than">&gt; (Greater Than)</option>
                <option value="greater_than_or_equal">&gt;= (Greater or Equal)</option>
              </select>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-[10px] font-sans text-slate-500">Target Value</label>
              <input
                type="text"
                value={targetVal}
                onChange={e => {
                  const val = e.target.value;
                  onUpdate({
                    ...cond,
                    value: val,
                    match: dKey ? { [dKey]: val } : cond.match,
                    evaluate: { ...(cond.evaluate || { byte: dKey, mask: maskVal, operator: opVal }), value: val }
                  });
                }}
                placeholder="0x01"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-purple-300 font-bold text-center"
              />
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

export function ConditionListEditor({
  conditions,
  depth = 0,
  label,
  emptyText = 'No conditions set.',
  availableTriggers,
  catalog,
  liveFrames,
  entityStates,
  lastFiredTriggerId,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onOpenAddConditionDialog
}: ConditionListEditorProps) {
  const { clipboard, pastePayload } = useContext(AutomationClipboardContext);

  const addDefaultCondition = () => {
    const next = [...conditions];
    next.push({
      id: `cond_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      logic: 'leaf',
      can_id: '',
      bus: 0,
      byte: '',
      mask: '',
      operator: 'equal',
      value: ''
    });
    onUpdate(next);
  };

  return (
    <div className="space-y-2 min-w-0">
      {label && (
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-purple-300 font-bold text-[11px] uppercase tracking-wider truncate">
            {label} ({conditions.length})
          </span>
        </div>
      )}

      {conditions.length === 0 ? (
        <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500 italic">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2 min-w-0">
                  {conditions.map((c, idx) => {
                    const stableKey = c._clientId || (c._clientId = `cond_client_${idx}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
                    return (
                      <ConditionNodeEditor
                        key={stableKey}
                        cond={c}
                        index={idx}
                        depth={depth}
                        availableTriggers={availableTriggers}
                        catalog={catalog}
                        liveFrames={liveFrames}
                        entityStates={entityStates}
                        lastFiredTriggerId={lastFiredTriggerId}
                        liveWifiStatus={liveWifiStatus}
                        liveBleMap={liveBleMap}
                        onUpdate={updated => {
                          const next = [...conditions];
                          next[idx] = { ...updated, _clientId: stableKey };
                          onUpdate(next);
                        }}
                        onDelete={() => {
                          const next = conditions.filter((_, i) => i !== idx);
                          onUpdate(next);
                        }}
                        onDuplicate={() => {
                          const dup = regenerateConditionIds(c);
                          const next = [...conditions];
                          next.splice(idx + 1, 0, dup);
                          onUpdate(next);
                        }}
                        onMoveUp={idx > 0 ? () => {
                          const next = [...conditions];
                          const temp = next[idx];
                          next[idx] = next[idx - 1];
                          next[idx - 1] = temp;
                          onUpdate(next);
                        } : undefined}
                        onMoveDown={idx < conditions.length - 1 ? () => {
                          const next = [...conditions];
                          const temp = next[idx];
                          next[idx] = next[idx + 1];
                          next[idx + 1] = temp;
                          onUpdate(next);
                        } : undefined}
                        isFirst={idx === 0}
                        isLast={idx === conditions.length - 1}
                        onOpenAddConditionDialog={onOpenAddConditionDialog}
                      />
                    );
                  })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => {
            if (onOpenAddConditionDialog) {
              onOpenAddConditionDialog(newCond => onUpdate([...conditions, newCond]));
            } else {
              addDefaultCondition();
            }
          }}
          className="ha-section-add-btn accent-cond"
        >
          <Plus className="w-4 h-4" />
          <span>Add Condition</span>
        </button>

        {clipboard?.type === 'condition' && (
          <button
            type="button"
            onClick={() => {
              const pasted = pastePayload('condition');
              if (pasted) onUpdate([...conditions, pasted]);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-purple-950/60 hover:bg-purple-900/60 text-purple-200 border border-purple-700/60 transition cursor-pointer"
            title={`Paste copied condition "${clipboard.label}"`}
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-purple-300" />
            <span>Paste Condition ({clipboard.label})</span>
          </button>
        )}

        {clipboard?.type === 'trigger' && (
          <button
            type="button"
            onClick={() => {
              const pasted = pastePayload('condition');
              if (pasted) onUpdate([...conditions, pasted]);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-950/50 hover:bg-amber-900/50 text-amber-200 border border-amber-700/60 transition cursor-pointer"
            title={`Convert & paste copied trigger "${clipboard.label}" as condition`}
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-amber-300" />
            <span>Paste as Condition ({clipboard.label})</span>
          </button>
        )}
      </div>
    </div>
  );
}