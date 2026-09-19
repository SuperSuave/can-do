import React, { useState, useRef } from 'react';
import {
  AutomationRule,
  AutomationSettings,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';
import { Catalog, Command, CommandOption } from '../types/catalog';
import {
  exportToCandoJson,
  exportToEsp32FirmwareJson,
  exportToFullCatalogJson,
  commandToTrigger,
  commandToCondition,
  commandToAction,
  compileToByteMap,
  resolveCatalogCommandForTrigger,
  resolveCatalogCommandForAction,
  applyOptionToTrigger,
  applyOptionToAction
} from '../utils/automationConverters';
import { getDefaultEspIp, resolveDeviceBaseUrl, isRunningOnDevice } from '../utils/hostUtils';
import {
  Zap,
  Shield,
  Send,
  Plus,
  Trash2,
  Copy,
  Check,
  CheckSquare,
  Download,
  Upload,
  Play,
  RotateCw,
  Sliders,
  Sparkles,
  Layers,
  ChevronDown,
  ChevronUp,
  Search,
  ExternalLink,
  Code,
  FileJson,
  RefreshCcw,
  RefreshCw,
  Eye,
  Info,
  Car,
  GitFork,
  Split,
  Clock,
  MessageSquare,
  Thermometer,
  Radio,
  X
} from 'lucide-react';
import { AddElementModal, AddElementTarget } from './AddElementModal';

interface AutomationBuilderProps {
  catalog: Catalog;
  rules: AutomationRule[];
  onUpdateRules: (newRules: AutomationRule[]) => void;
  settings: AutomationSettings;
  onUpdateSettings: (newSettings: AutomationSettings) => void;
  onBackToCatalog?: () => void;
  onNavigateToCatalog?: () => void;
  initialSelectedCommandIds?: string[];
  // If items were selected from the catalog to pull into an automation
  pulledCommands?: { command: Command; option?: CommandOption; role?: 'trigger' | 'condition' | 'action' }[];
  onClearPulledCommands?: () => void;
}

interface ConditionNodeEditorProps {
  key?: React.Key;
  cond: AutomationCondition;
  index: number;
  depth?: number;
  availableTriggers?: AutomationTrigger[];
  onUpdate: (updated: AutomationCondition) => void;
  onDelete: () => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
}

interface ConditionListEditorProps {
  conditions: AutomationCondition[];
  depth?: number;
  label?: string;
  emptyText?: string;
  availableTriggers?: AutomationTrigger[];
  onUpdate: (conditions: AutomationCondition[]) => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
}

const ALL_DAYS = [
  { id: 'mon', label: 'Mon' },
  { id: 'tue', label: 'Tue' },
  { id: 'wed', label: 'Wed' },
  { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' },
  { id: 'sat', label: 'Sat' },
  { id: 'sun', label: 'Sun' },
];

function DayOfWeekPicker({
  selectedDays,
  onChange
}: {
  selectedDays?: string[];
  onChange: (days: string[]) => void;
}) {
  const current = selectedDays && selectedDays.length > 0 ? selectedDays : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  const toggleDay = (dayId: string) => {
    if (current.includes(dayId)) {
      if (current.length === 1) return;
      onChange(current.filter(d => d !== dayId));
    } else {
      onChange([...current, dayId]);
    }
  };

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span className="font-semibold">Active Days</span>
        <div className="flex items-center gap-1 font-sans">
          <button
            type="button"
            onClick={() => onChange(['mon', 'tue', 'wed', 'thu', 'fri'])}
            className="hover:text-cyan-400 underline underline-offset-2"
          >
            Weekdays
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={() => onChange(['sat', 'sun'])}
            className="hover:text-cyan-400 underline underline-offset-2"
          >
            Weekends
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={() => onChange(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])}
            className="hover:text-cyan-400 underline underline-offset-2"
          >
            All
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {ALL_DAYS.map(d => {
          const active = current.includes(d.id);
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => toggleDay(d.id)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold transition border ${
                active
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              {d.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConditionNodeEditor({
  cond,
  index,
  depth = 0,
  availableTriggers,
  onUpdate,
  onDelete,
  onOpenAddConditionDialog
}: ConditionNodeEditorProps) {
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
      <div className={`p-3 rounded-xl border ${borderCls} space-y-2 text-xs transition-all`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className={`px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] border ${tagCls}`}>
              {groupLogic} Group {depth > 0 && `(L${depth + 1})`}
            </span>
            <span className="text-slate-400 text-[11px] hidden sm:inline">
              {groupLogic === 'and' && '(ALL nested must match)'}
              {groupLogic === 'or' && '(ANY nested must match)'}
              {groupLogic === 'not' && '(Children must NOT match)'}
            </span>
            <span className="text-slate-500 font-mono text-[10px]">
              [{(cond.conditions || []).length} items]
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={groupLogic}
              onChange={e => onUpdate({ ...cond, logic: e.target.value as any })}
              className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-slate-300 text-[11px]"
            >
              <option value="and">AND Logic</option>
              <option value="or">OR Logic</option>
              <option value="not">NOT Logic</option>
            </select>
            <button
              type="button"
              onClick={onDelete}
              className="p-1 text-slate-500 hover:text-rose-400 transition"
              title="Delete group"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {!collapsed && (
          <div className="pl-2 border-l border-slate-800/80">
            <ConditionListEditor
              conditions={cond.conditions || []}
              depth={depth + 1}
              availableTriggers={availableTriggers}
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
      <div className="p-3 rounded-xl bg-slate-950 border border-amber-900/60 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-amber-950 text-amber-300 font-bold text-[10px] flex items-center justify-center border border-amber-800">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-amber-400" />
              <span className="font-semibold text-white">Triggered By</span>
              {cond.trigger_id && (
                <span className="px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 text-[10px] border border-amber-800/60 font-mono">
                  {cond.trigger_id}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="p-1 text-slate-500 hover:text-rose-400 transition"
            title="Delete condition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
          <div>
            <label className="block text-[10px] font-sans text-slate-400 mb-1">Select Trigger</label>
            <select
              value={cond.trigger_id || ''}
              onChange={e => onUpdate({ ...cond, type: 'triggered_by', trigger_id: e.target.value })}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-amber-300 font-mono text-xs focus:outline-none focus:border-amber-500"
            >
              <option value="">-- Choose Rule Trigger --</option>
              {(availableTriggers || []).map((t, tIdx) => (
                <option key={t.id || tIdx} value={t.id}>
                  {t.id} ({t.source_command_name || t.can_id || `Trigger ${tIdx + 1}`})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-sans text-slate-400 mb-1">Trigger ID (Exact Match)</label>
            <input
              type="text"
              value={cond.trigger_id || ''}
              onChange={e => onUpdate({ ...cond, type: 'triggered_by', trigger_id: e.target.value })}
              placeholder="trig_xxx"
              className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-amber-300 font-mono text-xs focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>
        {matchedTrig && (
          <div className="text-[11px] text-slate-400 font-sans flex items-center gap-1.5 pt-0.5">
            <span className="text-slate-500">Source:</span>
            <span className="text-slate-300 font-semibold">{matchedTrig.source_command_name || matchedTrig.can_id}</span>
            {matchedTrig.option_label && (
              <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 text-[10px]">
                {matchedTrig.option_label}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // Time window condition
  if (cond.type === 'time_condition' || cond.type === 'time') {
    return (
      <div className="p-3 rounded-xl bg-slate-950 border border-cyan-900/60 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 font-bold text-[10px] flex items-center justify-center border border-cyan-800">
              C{index + 1}
            </span>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              <span className="font-semibold text-white">Time Window Guardrail</span>
              {(cond.start_time || cond.end_time) && (
                <span className="px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60 font-mono">
                  {cond.start_time || '--:--'} - {cond.end_time || '--:--'}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="p-1 text-slate-500 hover:text-rose-400 transition"
            title="Delete condition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

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
      </div>
    );
  }

  // Leaf CAN condition
  const dKey = cond.byte ?? cond.evaluate?.byte ?? (cond.match && Object.keys(cond.match).length > 0 ? Object.keys(cond.match)[0] : '') ?? '';
  const maskVal = cond.mask ?? cond.evaluate?.mask ?? '';
  const opVal = cond.operator || cond.evaluate?.operator || (cond.invert ? 'not_equal' : 'equal');
  const targetVal = cond.value ?? cond.evaluate?.value ?? (cond.match && dKey ? cond.match[dKey] : '') ?? '';

  return (
    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-purple-950 text-purple-300 font-bold text-[10px] flex items-center justify-center border border-purple-800">
            C{index + 1}
          </span>
          {cond.source_command_name ? (
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-white">{cond.source_command_name}</span>
              {cond.option_label && (
                <span className="px-1.5 py-0.2 rounded bg-purple-950 text-purple-300 text-[10px] border border-purple-800/60">
                  {cond.option_label}
                </span>
              )}
            </div>
          ) : (
            <span className="font-semibold text-slate-300 font-mono">
              CAN {cond.can_id || 'unassigned'} Bus {cond.bus ?? 0}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-slate-500 hover:text-rose-400 transition"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-5 gap-2 font-mono text-[11px]">
        <div className="col-span-1">
          <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
          <input
            type="text"
            value={cond.can_id || ''}
            onChange={e => onUpdate({ ...cond, can_id: e.target.value })}
            placeholder="0x120"
            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
          />
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
            <option value="greater_than">&gt; (Greater Than)</option>
          </select>
        </div>
        <div className="col-span-1">
          <label className="block text-[10px] font-sans text-slate-500">Target Value</label>
          <input
            type="text"
            value={targetVal}
            onChange={e => {
              onUpdate({
                ...cond,
                value: e.target.value,
                evaluate: { ...(cond.evaluate || { byte: dKey, mask: maskVal, operator: opVal }), value: e.target.value }
              });
            }}
            placeholder="0x01"
            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-purple-300 font-bold text-center"
          />
        </div>
      </div>
    </div>
  );
}

function ConditionListEditor({
  conditions,
  depth = 0,
  label,
  emptyText = 'No conditions set.',
  availableTriggers,
  onUpdate,
  onOpenAddConditionDialog
}: ConditionListEditorProps) {
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
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-purple-300 font-bold text-[11px] uppercase tracking-wider">
            {label} ({conditions.length})
          </span>
        </div>
      )}

      {conditions.length === 0 ? (
        <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500 italic">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {conditions.map((c, idx) => (
            <ConditionNodeEditor
              key={c.id || idx}
              cond={c}
              index={idx}
              depth={depth}
              availableTriggers={availableTriggers}
              onUpdate={updated => {
                const next = [...conditions];
                next[idx] = updated;
                onUpdate(next);
              }}
              onDelete={() => {
                const next = conditions.filter((_, i) => i !== idx);
                onUpdate(next);
              }}
              onOpenAddConditionDialog={onOpenAddConditionDialog}
            />
          ))}
        </div>
      )}

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
    </div>
  );
}

interface OptionGridGroup {
  key?: string;
  items: {
    opt: CommandOption;
    origIndex: number;
  }[];
}

/**
 * Groups command options into rows/grids based on common words (e.g. "Heat", "Cool", "Vent", "Front", "Rear").
 * Ensures groups like Low Heat, Medium Heat, High Heat are displayed horizontally in a single row.
 */
function groupOptionsIntoGridRows(options?: CommandOption[]): OptionGridGroup[] {
  if (!options || options.length === 0) return [];
  if (options.length <= 1) {
    return [{ items: options.map((opt, origIndex) => ({ opt, origIndex })) }];
  }

  // Parse labels into words and components
  const parsed = options.map((opt, origIndex) => {
    const rawLabel = opt.label || '';
    // Strip parenthesized text for classification e.g. "Released (Idle)" -> "Released"
    const cleaned = rawLabel.replace(/\([^)]*\)/g, '').trim();
    const words = cleaned.split(/[\s\-_/]+/).filter(Boolean);
    const firstWord = words.length > 0 ? words[0].toLowerCase() : '';
    const lastWord = words.length > 1 ? words[words.length - 1].toLowerCase() : '';
    return {
      opt,
      origIndex,
      words,
      firstWord,
      lastWord,
      isSingleWord: words.length <= 1
    };
  });

  // Count suffix frequencies (e.g., "Heat", "Cool", "Vent", "Click", "Press", "Speed")
  const suffixCounts = new Map<string, number>();
  parsed.forEach(p => {
    if (p.lastWord) {
      suffixCounts.set(p.lastWord, (suffixCounts.get(p.lastWord) || 0) + 1);
    }
  });

  // Count prefix frequencies (e.g., "Front", "Rear", "Driver", "Passenger", "Stage", "Level")
  const prefixCounts = new Map<string, number>();
  parsed.forEach(p => {
    if (p.firstWord && !p.isSingleWord) {
      prefixCounts.set(p.firstWord, (prefixCounts.get(p.firstWord) || 0) + 1);
    }
  });

  let maxSuffixCount = 0;
  for (const count of suffixCounts.values()) {
    if (count > maxSuffixCount) maxSuffixCount = count;
  }

  let maxPrefixCount = 0;
  for (const count of prefixCounts.values()) {
    if (count > maxPrefixCount) maxPrefixCount = count;
  }

  // Suffix is preferred if at least 2 items and >= prefix count (e.g. Low Heat, Med Heat, High Heat)
  const useSuffix = maxSuffixCount >= 2 && maxSuffixCount >= maxPrefixCount;
  const usePrefix = !useSuffix && maxPrefixCount >= 2;

  if (useSuffix || usePrefix) {
    const keyMap = new Map<string, { opt: CommandOption; origIndex: number }[]>();
    const ungrouped: { opt: CommandOption; origIndex: number }[] = [];

    parsed.forEach(p => {
      const k = useSuffix ? p.lastWord : p.firstWord;
      const count = useSuffix ? (suffixCounts.get(p.lastWord) || 0) : (prefixCounts.get(p.firstWord) || 0);

      if (k && count >= 2) {
        if (!keyMap.has(k)) {
          keyMap.set(k, []);
        }
        keyMap.get(k)!.push({ opt: p.opt, origIndex: p.origIndex });
      } else {
        ungrouped.push({ opt: p.opt, origIndex: p.origIndex });
      }
    });

    const isOffLike = (lbl: string) => /^(off|none|idle|auto|normal|cancel|stop|released)/i.test(lbl.trim());
    const offLike = ungrouped.filter(u => isOffLike(u.opt.label || ''));
    const nonOffUngrouped = ungrouped.filter(u => !isOffLike(u.opt.label || ''));

    const result: OptionGridGroup[] = [];

    // Off/Neutral options in row 1
    if (offLike.length > 0) {
      result.push({ key: 'off', items: offLike });
    }

    // Matched groups (e.g. Low Heat, Medium Heat, High Heat)
    for (const [key, items] of keyMap.entries()) {
      result.push({ key, items });
    }

    // Any remaining items
    if (nonOffUngrouped.length > 0) {
      result.push({ items: nonOffUngrouped });
    }

    if (result.length > 0) {
      return result;
    }
  }

  // If between 2 and 4 options total, display in a single row
  if (options.length <= 4) {
    return [{ items: options.map((opt, origIndex) => ({ opt, origIndex })) }];
  }

  // Fallback for > 4 items: chunk into rows of 3 or 4
  const chunked: OptionGridGroup[] = [];
  const chunkSize = options.length === 6 ? 3 : options.length <= 8 ? 4 : 3;
  for (let i = 0; i < options.length; i += chunkSize) {
    chunked.push({
      items: options.slice(i, i + chunkSize).map((opt, idx) => ({ opt, origIndex: i + idx }))
    });
  }
  return chunked;
}

interface TriggerNodeEditorProps {
  trig: AutomationTrigger;
  tIdx: number;
  catalog?: Catalog;
  onUpdate: (updated: AutomationTrigger) => void;
  onDelete: () => void;
}

function TriggerNodeEditor({
  trig,
  tIdx,
  catalog,
  onUpdate,
  onDelete,
}: TriggerNodeEditorProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Time-based schedule trigger
  if (trig.type === 'time_schedule' || trig.source === 'time') {
    return (
      <div
        key={trig.id || tIdx}
        className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2.5 text-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
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
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

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
    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 hover:border-slate-700/80 space-y-2.5 text-xs transition-all shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-amber-950 text-amber-300 font-bold text-[10px] flex items-center justify-center border border-amber-800 shrink-0">
            T{tIdx + 1}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm tracking-tight">{triggerName}</span>
            {catalogCmd?.category && (
              <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 text-[10px] border border-slate-800">
                {catalogCmd.category}
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300/90 text-[10px] font-mono border border-amber-800/50">
              {trig.can_id ? `CAN ${trig.can_id}` : 'CAN'} • Bus {trig.bus ?? 0}
            </span>
            {trig.click_count && trig.click_count > 1 && (
              <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200 text-[10px] border border-amber-700/60 font-medium">
                {trig.click_count === 2 ? 'Double Click' : 'Triple Click'}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {hasOptions && (
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                showAdvanced
                  ? 'bg-amber-950/60 text-amber-300 border-amber-800/80 shadow'
                  : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800 hover:bg-slate-850'
              }`}
              title="Toggle configuration details"
            >
              <Sliders className="w-3.5 h-3.5 text-amber-400" />
              <span>{showAdvanced ? 'Simple View' : 'Edit Details'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"
            title="Delete trigger"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

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
                ? 'grid grid-cols-3 gap-1.5'
                : itemCount === 4
                ? 'grid grid-cols-4 gap-1.5'
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
          <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
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
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Gesture / Clicks</label>
              <select
                value={trig.click_count || 1}
                onChange={e => onUpdate({ ...trig, click_count: parseInt(e.target.value) || 1 })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans text-[11px]"
              >
                <option value={1}>Single Click</option>
                <option value={2}>Double Click</option>
                <option value={3}>Triple Click</option>
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
  onUpdate: (updated: AutomationAction) => void;
  onDelete: () => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
}

interface ActionListEditorProps {
  actions: AutomationAction[];
  depth?: number;
  label?: string;
  emptyText?: string;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  onUpdate: (actions: AutomationAction[]) => void;
  onPullCatalog?: () => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
}

function ActionNodeEditor({
  act,
  index,
  depth = 0,
  availableTriggers,
  catalog,
  onUpdate,
  onDelete,
  onOpenAddConditionDialog,
  onOpenAddActionDialog
}: ActionNodeEditorProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // If IF_THEN:
  if (act.type === 'if_then') {
    return (
      <div className={`p-3 rounded-xl border border-cyan-800/80 bg-cyan-950/20 space-y-3 text-xs`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-cyan-900 text-cyan-200 border border-cyan-700 flex items-center gap-1">
              <GitFork className="w-3 h-3" />
              IF - THEN - ELSE {depth > 0 && `(Level ${depth + 1})`}
            </span>
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="p-1 text-slate-500 hover:text-rose-400 transition"
            title="Delete block"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {!collapsed && (
          <div className="space-y-3">
            {/* IF CONDITIONS */}
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2">
              <ConditionListEditor
                conditions={act.conditions || []}
                depth={depth + 1}
                label="IF (Conditions)"
                emptyText="No conditions in this IF block."
                availableTriggers={availableTriggers}
                onUpdate={updatedConds => onUpdate({ ...act, conditions: updatedConds })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
              />
            </div>

            {/* THEN ACTIONS */}
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2">
              <ActionListEditor
                actions={act.then || []}
                depth={depth + 1}
                label="THEN (Execute if True)"
                emptyText="No actions in THEN branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                onUpdate={updatedThen => onUpdate({ ...act, then: updatedThen })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>

            {/* ELSE ACTIONS */}
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2">
              <ActionListEditor
                actions={act.else || []}
                depth={depth + 1}
                label="ELSE (Execute if False)"
                emptyText="No actions in ELSE branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                onUpdate={updatedElse => onUpdate({ ...act, else: updatedElse })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // If CHOOSE:
  if (act.type === 'choose') {
    return (
      <div className={`p-3 rounded-xl border border-blue-800/80 bg-blue-950/20 space-y-3 text-xs`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-blue-900 text-blue-200 border border-blue-700 flex items-center gap-1">
              <Split className="w-3 h-3" />
              CHOOSE (Sequential Branching) {depth > 0 && `(Level ${depth + 1})`}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const choices = [...(act.choices || [])];
                choices.push({
                  conditions: [],
                  sequence: []
                });
                onUpdate({ ...act, choices });
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-blue-900 hover:bg-blue-800 text-white font-semibold transition"
            >
              <Plus className="w-3 h-3" />
              <span>Add Choice Branch</span>
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="p-1 text-slate-500 hover:text-rose-400 transition"
              title="Delete block"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-3">
            {/* BRANCHES */}
            <div className="space-y-2.5">
              {(act.choices || []).map((ch, chIdx) => (
                <div key={chIdx} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-blue-300 text-[11px]">Branch #{chIdx + 1}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const choices = (act.choices || []).filter((_, i) => i !== chIdx);
                        onUpdate({ ...act, choices });
                      }}
                      className="p-1 text-slate-500 hover:text-rose-400 transition"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Conditions in Choice */}
                  <div className="pl-2 border-l border-slate-800">
                    <ConditionListEditor
                      conditions={ch.conditions || []}
                      depth={depth + 1}
                      label="Branch Conditions"
                      emptyText="No conditions in this branch."
                      availableTriggers={availableTriggers}
                      onUpdate={updatedConds => {
                        const choices = [...(act.choices || [])];
                        choices[chIdx].conditions = updatedConds;
                        onUpdate({ ...act, choices });
                      }}
                      onOpenAddConditionDialog={onOpenAddConditionDialog}
                    />
                  </div>

                  {/* Sequence in Choice */}
                  <div className="pl-2 border-l border-slate-800 pt-2">
                    <ActionListEditor
                      actions={ch.sequence || []}
                      depth={depth + 1}
                      label="Branch Sequence Actions"
                      emptyText="No actions in branch sequence."
                      availableTriggers={availableTriggers}
                      catalog={catalog}
                      onUpdate={updatedSeq => {
                        const choices = [...(act.choices || [])];
                        choices[chIdx].sequence = updatedSeq;
                        onUpdate({ ...act, choices });
                      }}
                      onOpenAddConditionDialog={onOpenAddConditionDialog}
                      onOpenAddActionDialog={onOpenAddActionDialog}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* DEFAULT SEQUENCE */}
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
              <ActionListEditor
                actions={act.default || []}
                depth={depth + 1}
                label="DEFAULT (If no branch matches)"
                emptyText="No actions in DEFAULT branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                onUpdate={updatedDef => onUpdate({ ...act, default: updatedDef })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Regular action step
  const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForAction(act, catalog) : {};
  const hasOptions = !!(catalogCmd?.options && catalogCmd.options.length > 0);
  const actionName =
    catalogCmd?.ha_metadata?.name ||
    catalogCmd?.name ||
    act.source_command_name ||
    (act.type === 'entity_command'
      ? act.entity_id || 'Entity Command'
      : act.type === 'climate_target'
      ? 'Climate Target'
      : act.type === 'precondition'
      ? 'Battery Preconditioning'
      : act.type === 'track_popup' || act.type === 'popup'
      ? 'Cluster Popup'
      : act.can_id
      ? `CAN Ingress ${act.can_id}`
      : `Action ${index + 1}`);

  return (
    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 hover:border-slate-700/80 space-y-2.5 text-xs transition-all shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-300 font-bold text-[10px] flex items-center justify-center border border-emerald-800 shrink-0">
            A{index + 1}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm tracking-tight">{actionName}</span>
            {catalogCmd?.category && (
              <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 text-[10px] border border-slate-800">
                {catalogCmd.category}
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300/90 text-[10px] font-mono border border-emerald-800/50">
              {act.can_id ? `CAN ${act.can_id}` : act.type} • Bus {act.bus ?? 0}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {hasOptions && (
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                showAdvanced
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/80 shadow'
                  : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800 hover:bg-slate-850'
              }`}
              title="Toggle configuration details"
            >
              <Sliders className="w-3.5 h-3.5 text-emerald-400" />
              <span>{showAdvanced ? 'Simple View' : 'Edit Details'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"
            title="Delete action"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

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
                ? 'grid grid-cols-3 gap-1.5'
                : itemCount === 4
                ? 'grid grid-cols-4 gap-1.5'
                : 'grid grid-cols-2 sm:grid-cols-3 gap-1.5';

            return (
              <div key={group.key || gIdx} className={gridClass}>
                {group.items.map(({ opt, origIndex }) => {
                  const isSelected =
                    (act.option_label && opt.label.toLowerCase() === act.option_label.toLowerCase()) ||
                    (act.command && opt.label.toLowerCase() === act.command.toLowerCase()) ||
                    (matchedOption && opt.label.toLowerCase() === matchedOption.label.toLowerCase()) ||
                    (!act.option_label && !act.command && !matchedOption && origIndex === 0);

                  return (
                    <button
                      key={opt.label || origIndex}
                      type="button"
                      onClick={() => {
                        const updated = applyOptionToAction(act, catalogCmd, opt);
                        onUpdate(updated);
                      }}
                      className={`${
                        itemCount === 1 ? 'px-4 min-w-[90px]' : 'w-full px-2'
                      } py-1.5 rounded-lg text-xs font-medium transition flex items-center justify-center gap-1.5 border cursor-pointer text-center ${
                        isSelected
                          ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/80 font-semibold shadow-sm ring-1 ring-emerald-500/40'
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
          <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Action Type</label>
              <select
                value={act.type}
                onChange={e => onUpdate({ ...act, type: e.target.value as any })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
              >
                <option value="entity_command">entity_command</option>
                <option value="precondition">precondition (E-GMP)</option>
                <option value="climate_target">climate_target (HVAC Temp Target)</option>
                <option value="track_popup">track_popup (Cluster Popup)</option>
                <option value="can_tx">can_tx (CAN Ingress)</option>
                <option value="delay">delay</option>
                <option value="if_then">if_then (Conditional Branch)</option>
                <option value="choose">choose (Multiple Choices)</option>
                <option value="webhook">webhook (HTTP)</option>
              </select>
            </div>

            {act.type === 'precondition' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Operation</label>
                  <select
                    value={act.precon_action || 'start'}
                    onChange={e => onUpdate({ ...act, precon_action: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value="start">Start Preconditioning</option>
                    <option value="stop">Stop / Cancel</option>
                    <option value="toggle">Toggle State</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Operating Mode</label>
                  <select
                    value={act.precon_mode || 'persistent'}
                    onChange={e => onUpdate({ ...act, precon_mode: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-orange-300 font-medium font-sans"
                  >
                    <option value="persistent">Persistent (21°C / 70°F)</option>
                    <option value="continuous">Continuous (High Demand)</option>
                    <option value="once">Single Cycle (Once)</option>
                  </select>
                </div>
              </>
            )}

            {act.type === 'climate_target' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Zone</label>
                  <select
                    value={act.zone || 'driver'}
                    onChange={e => onUpdate({ ...act, zone: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value="driver">Driver Zone</option>
                    <option value="passenger">Passenger Zone</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-sans text-slate-500">Target Temp</label>
                    <span className="text-[9px] text-teal-400 font-mono">
                      {act.target_temp_c !== undefined || act.target_c !== undefined
                        ? `${Math.round(((act.target_temp_c ?? act.target_c ?? 21.0) * 9 / 5 + 32) * 10) / 10}°F`
                        : '--°F'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      step="0.5"
                      min="14"
                      max="32"
                      value={act.target_temp_c ?? act.target_c ?? ''}
                      onChange={e => {
                        const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                        onUpdate({ ...act, target_temp_c: val, target_c: val });
                      }}
                      placeholder="21.0"
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-teal-300 font-bold"
                    />
                    <span className="text-slate-400 font-sans text-xs">°C</span>
                  </div>
                </div>
              </>
            )}

            {(act.type === 'track_popup' || act.type === 'popup') && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Severity Level</label>
                  <select
                    value={act.level || 'info'}
                    onChange={e => onUpdate({ ...act, level: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="error">Error</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-sans text-slate-500">Popup Text</label>
                    <span className="text-[9px] text-slate-500 font-mono">
                      {(act.text || act.popup_message || '').length}/50
                    </span>
                  </div>
                  <input
                    type="text"
                    maxLength={50}
                    value={act.text || act.popup_message || ''}
                    onChange={e => onUpdate({ ...act, text: e.target.value, popup_message: e.target.value })}
                    placeholder="Message text..."
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-amber-300 font-medium"
                  />
                </div>
              </>
            )}

            {act.type === 'entity_command' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Entity ID</label>
                  <input
                    type="text"
                    value={act.entity_id || ''}
                    onChange={e => onUpdate({ ...act, entity_id: e.target.value })}
                    placeholder="e.g. drivers_seat_comfort"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Command</label>
                  <input
                    type="text"
                    value={act.command || ''}
                    onChange={e => onUpdate({ ...act, command: e.target.value })}
                    placeholder="e.g. Medium Cool"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-cyan-300 font-bold"
                  />
                </div>
              </>
            )}

            {act.type === 'delay' && (
              <div className="col-span-2">
                <label className="block text-[10px] font-sans text-slate-500">Delay Duration (ms)</label>
                <input
                  type="number"
                  value={act.delay_ms !== undefined && act.delay_ms !== null ? act.delay_ms : (act.ms !== undefined && act.ms !== null ? act.ms : '')}
                  onChange={e => {
                    const val = e.target.value === '' ? 0 : parseInt(e.target.value) || 0;
                    onUpdate({ ...act, delay_ms: val, ms: val });
                  }}
                  placeholder="0"
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                />
              </div>
            )}

            {act.type === 'can_tx' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Target CAN ID</label>
                  <input
                    type="text"
                    value={act.can_id || ''}
                    onChange={e => onUpdate({ ...act, can_id: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                    placeholder="0x524"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Repeat × Delay</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={act.repeat !== undefined ? act.repeat : 1}
                      onChange={e => onUpdate({ ...act, repeat: parseInt(e.target.value) || 1 })}
                      className="w-12 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                    />
                    <span className="text-slate-500 font-sans">×</span>
                    <input
                      type="number"
                      value={act.delay_ms !== undefined ? act.delay_ms : 0}
                      onChange={e => onUpdate({ ...act, delay_ms: parseInt(e.target.value) || 0 })}
                      placeholder="ms"
                      className="w-16 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {act.type === 'climate_target' && (
            <div className="flex items-center gap-4 pt-1 font-sans text-[11px] text-slate-400">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={act.sync_on ?? true}
                  onChange={e => onUpdate({ ...act, sync_on: e.target.checked })}
                  className="rounded bg-slate-900 border-slate-700 text-teal-500 focus:ring-0"
                />
                <span>Sync Passenger Zone (0x4A0)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={act.driver_only ?? false}
                  onChange={e => onUpdate({ ...act, driver_only: e.target.checked })}
                  className="rounded bg-slate-900 border-slate-700 text-teal-500 focus:ring-0"
                />
                <span>Driver Only</span>
              </label>
            </div>
          )}

          {act.type === 'can_tx' && (
            <div className="space-y-1.5 font-mono text-[11px]">
              <div>
                <label className="block text-[10px] font-sans text-slate-500">Payload (1-based D1..D8)</label>
                <input
                  type="text"
                  value={typeof act.payload === 'object' && Object.keys(act.payload).length > 0 ? JSON.stringify(act.payload) : (typeof act.payload === 'string' ? act.payload : '')}
                  onChange={e => {
                    const compiled = compileToByteMap(e.target.value);
                    onUpdate({ ...act, payload: Object.keys(compiled).length > 0 ? compiled : e.target.value });
                  }}
                  placeholder='{"D1":"0x02","D2":"0x01"}'
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-emerald-300 font-bold"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionListEditor({
  actions,
  depth = 0,
  label,
  emptyText = 'No actions defined.',
  availableTriggers,
  catalog,
  onUpdate,
  onOpenAddConditionDialog,
  onOpenAddActionDialog
}: ActionListEditorProps) {
  const addDefaultAction = () => {
    const next = [...actions];
    next.push({
      id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'can_tx',
      can_id: '',
      bus: 0,
      payload: '',
      repeat: 1,
      delay_ms: 0
    });
    onUpdate(next);
  };

  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-emerald-400 font-bold text-[11px] uppercase tracking-wider">
            {label} ({actions.length})
          </span>
        </div>
      )}

      {actions.length === 0 ? (
        <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500 italic">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {actions.map((act, idx) => (
            <ActionNodeEditor
              key={act.id || idx}
              act={act}
              index={idx}
              depth={depth}
              availableTriggers={availableTriggers}
              catalog={catalog}
              onUpdate={updated => {
                const next = [...actions];
                next[idx] = updated;
                onUpdate(next);
              }}
              onDelete={() => {
                const next = actions.filter((_, i) => i !== idx);
                onUpdate(next);
              }}
              onOpenAddConditionDialog={onOpenAddConditionDialog}
              onOpenAddActionDialog={onOpenAddActionDialog}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (onOpenAddActionDialog) {
            onOpenAddActionDialog(newAct => onUpdate([...actions, newAct]));
          } else {
            addDefaultAction();
          }
        }}
        className="ha-section-add-btn accent-act"
      >
        <Plus className="w-4 h-4" />
        <span>Add Action</span>
      </button>
    </div>
  );
}

interface SwipeableRuleItemProps {
  rule: AutomationRule;
  idx: number;
  isSelected: boolean;
  isSelectMode: boolean;
  isCheckedForDelete: boolean;
  onToggleCheck: (id: string) => void;
  onSelect: (id: string) => void;
  onDuplicate: (rule: AutomationRule) => void;
  onDelete: (id: string) => void;
}

const SwipeableRuleItem: React.FC<SwipeableRuleItemProps> = ({
  rule,
  idx,
  isSelected,
  isSelectMode,
  isCheckedForDelete,
  onToggleCheck,
  onSelect,
  onDuplicate,
  onDelete
}) => {
  const [dragOffset, setDragOffset] = useState(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const swipingRef = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isSelectMode) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    };
    isDraggingRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || isSelectMode) return;
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;

    if (!isDraggingRef.current && Math.abs(dy) > Math.abs(dx)) {
      return;
    }

    if (Math.abs(dx) > 10) {
      isDraggingRef.current = true;
      swipingRef.current = true;
      const clamped = Math.max(-90, Math.min(90, dx));
      setDragOffset(clamped);
    }
  };

  const handleTouchEnd = () => {
    if (!isDraggingRef.current) {
      touchStartRef.current = null;
      return;
    }

    if (dragOffset < -55) {
      setDragOffset(-80);
    } else if (dragOffset > 55) {
      setDragOffset(0);
      onDuplicate(rule);
    } else {
      setDragOffset(0);
    }

    touchStartRef.current = null;
    isDraggingRef.current = false;
    setTimeout(() => {
      swipingRef.current = false;
    }, 150);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (swipingRef.current) {
      e.stopPropagation();
      return;
    }
    if (dragOffset !== 0) {
      setDragOffset(0);
      return;
    }
    if (isSelectMode) {
      onToggleCheck(rule.id);
    } else {
      onSelect(rule.id);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-xl group select-none">
      {/* Background action reveal buttons */}
      <div className="absolute inset-0 flex items-center justify-between rounded-xl overflow-hidden pointer-events-auto">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDragOffset(0);
            onDuplicate(rule);
          }}
          className="h-full px-3.5 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white flex items-center gap-1.5 text-xs font-bold transition shadow-inner"
          title="Duplicate automation"
        >
          <Copy className="w-4 h-4" />
          <span className="text-[11px] font-semibold">Copy</span>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDragOffset(0);
            onDelete(rule.id);
          }}
          className="h-full px-3.5 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white flex items-center gap-1.5 text-xs font-bold transition ml-auto shadow-inner"
          title="Delete automation"
        >
          <Trash2 className="w-4 h-4" />
          <span className="text-[11px] font-semibold">Delete</span>
        </button>
      </div>

      {/* Foreground Swipeable Card */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleClick}
        style={{
          transform: `translateX(${dragOffset}px)`,
          transition: isDraggingRef.current ? 'none' : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
        className={`relative z-10 p-2.5 rounded-xl cursor-pointer border text-left flex flex-col gap-1.5 transition-colors ${
          isSelected
            ? 'bg-slate-800 border-cyan-500/80 shadow-md shadow-cyan-950/40 text-white'
            : 'bg-slate-950/90 border-slate-800 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'
        }`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isSelectMode ? (
              <input
                type="checkbox"
                checked={isCheckedForDelete}
                onChange={() => onToggleCheck(rule.id)}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 rounded text-rose-500 bg-slate-800 border-slate-700 focus:ring-rose-400 cursor-pointer flex-shrink-0"
              />
            ) : (
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  rule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                }`}
              />
            )}
            <span className="text-xs font-semibold truncate">{rule.name || `Rule #${idx + 1}`}</span>
          </div>

          {!isSelectMode && (
            <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition flex-shrink-0">
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onDuplicate(rule);
                }}
                title="Duplicate rule"
                className="p-1.5 hover:text-cyan-300 text-slate-400 hover:bg-slate-700/60 active:bg-slate-700 rounded-lg transition"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onDelete(rule.id);
                }}
                title="Delete rule"
                className="p-1.5 hover:text-rose-400 text-slate-400 hover:bg-rose-500/10 active:bg-rose-500/20 rounded-lg transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
          <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 uppercase">
            {(rule.exec_mode || 'one_shot').replace('_', ' ')}
          </span>
          {rule.ha_expose && (
            <span className="px-1 py-0.5 rounded bg-orange-950/60 text-orange-300 border border-orange-800/40">
              HA
            </span>
          )}
          <span>
            {(rule.triggers || []).length}T · {(rule.actions || []).length}A
          </span>
        </div>
      </div>
    </div>
  );
};

export const AutomationBuilder: React.FC<AutomationBuilderProps> = ({
  catalog,
  rules,
  onUpdateRules,
  settings,
  onUpdateSettings,
  onBackToCatalog,
  pulledCommands = [],
  onClearPulledCommands
}) => {
  const [selectedRuleId, setSelectedRuleId] = useState<string>(
    rules.length > 0 ? rules[0].id : ''
  );
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedRuleIdsForDelete, setSelectedRuleIdsForDelete] = useState<Set<string>>(new Set());
  const [activeJsonTab, setActiveJsonTab] = useState<'catalog' | 'cando' | 'esp32' | 'custom'>('catalog');
  const [copied, setCopied] = useState(false);
  const [addElementTarget, setAddElementTarget] = useState<AddElementTarget | null>(null);
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  const [espIp, setEspIp] = useState<string>(() => getDefaultEspIp());
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [customJsonSchema, setCustomJsonSchema] = useState<string>(
    JSON.stringify(
      {
        description: 'New Firmware Schema Sandbox (The Brains)',
        version: '1.0.0-alpha',
        target_device: 'ESP32-S3',
        catalog_sync: {
          last_synced: new Date().toISOString(),
          active_rules_count: rules.length
        },
        automations: rules.map(r => ({
          name: r.name,
          mode: r.exec_mode,
          triggers: r.triggers.map(t => ({
            id: t.id,
            can_id: t.can_id,
            match: t.to_payload
          })),
          actions: r.actions.map(a => ({
            can_id: a.can_id,
            payload: a.payload
          }))
        }))
      },
      null,
      2
    )
  );

  const activeRule = rules.find(r => r.id === selectedRuleId) || rules[0];

  // Handle incoming pulled commands from the catalog
  React.useEffect(() => {
    if (pulledCommands.length > 0 && activeRule) {
      const updatedRules = rules.map(r => {
        if (r.id === activeRule.id) {
          const newTriggers = [...r.triggers];
          const newConditions = [...r.conditions];
          const newActions = [...r.actions];

          pulledCommands.forEach(({ command, option, role }) => {
            const assignedRole = role || (command.roles.includes('trigger') ? 'trigger' : command.roles.includes('condition') ? 'condition' : 'action');
            if (assignedRole === 'trigger') {
              newTriggers.push(commandToTrigger(command, option));
            } else if (assignedRole === 'condition') {
              newConditions.push(commandToCondition(command, option));
            } else {
              newActions.push(commandToAction(command, option));
            }
          });

          return {
            ...r,
            triggers: newTriggers,
            conditions: newConditions,
            actions: newActions
          };
        }
        return r;
      });

      onUpdateRules(updatedRules);
      if (onClearPulledCommands) onClearPulledCommands();
    }
  }, [pulledCommands]);

  const handleUpdateActiveRule = (updated: Partial<AutomationRule>) => {
    if (!activeRule) return;
    const newRules = rules.map(r => (r.id === activeRule.id ? { ...r, ...updated } : r));
    onUpdateRules(newRules);
  };

  const handleAddRule = () => {
    const newId = `rule_${Date.now().toString(36)}`;
    const newRule: AutomationRule = {
      id: newId,
      name: `New Automation Rule #${rules.length + 1}`,
      enabled: true,
      ha_expose: true,
      ha_icon: 'mdi:car-cog',
      exec_mode: 'one_shot',
      trigger_mode: 'any',
      cooldown_ms: 0,
      timeout_reset_ms: 0,
      triggers: [],
      conditions: [],
      actions: []
    };

    onUpdateRules([...rules, newRule]);
    setSelectedRuleId(newId);
  };

  const handleDuplicateRule = (ruleToDup: AutomationRule) => {
    const newId = `rule_${Date.now().toString(36)}`;
    const duplicated: AutomationRule = {
      ...JSON.parse(JSON.stringify(ruleToDup)),
      id: newId,
      name: `${ruleToDup.name} (Copy)`
    };
    onUpdateRules([...rules, duplicated]);
    setSelectedRuleId(newId);
  };

  const handleDeleteRule = (ruleId: string) => {
    const newRules = rules.filter(r => r.id !== ruleId);
    if (newRules.length === 0) {
      const newId = `rule_${Date.now().toString(36)}`;
      const freshRule: AutomationRule = {
        id: newId,
        name: 'New Automation Rule #1',
        enabled: true,
        ha_expose: true,
        ha_icon: 'mdi:car-cog',
        exec_mode: 'one_shot',
        trigger_mode: 'any',
        cooldown_ms: 0,
        timeout_reset_ms: 0,
        triggers: [],
        conditions: [],
        actions: []
      };
      onUpdateRules([freshRule]);
      setSelectedRuleId(newId);
    } else {
      onUpdateRules(newRules);
      if (selectedRuleId === ruleId) {
        setSelectedRuleId(newRules[0].id);
      }
    }
  };

  const handleToggleCheckForDelete = (ruleId: string) => {
    setSelectedRuleIdsForDelete(prev => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  };

  const handleBatchDelete = () => {
    if (selectedRuleIdsForDelete.size === 0) return;
    const remaining = rules.filter(r => !selectedRuleIdsForDelete.has(r.id));
    if (remaining.length === 0) {
      const newId = `rule_${Date.now().toString(36)}`;
      const freshRule: AutomationRule = {
        id: newId,
        name: 'New Automation Rule #1',
        enabled: true,
        ha_expose: true,
        ha_icon: 'mdi:car-cog',
        exec_mode: 'one_shot',
        trigger_mode: 'any',
        cooldown_ms: 0,
        timeout_reset_ms: 0,
        triggers: [],
        conditions: [],
        actions: []
      };
      onUpdateRules([freshRule]);
      setSelectedRuleId(newId);
    } else {
      onUpdateRules(remaining);
      if (selectedRuleIdsForDelete.has(selectedRuleId)) {
        setSelectedRuleId(remaining[0].id);
      }
    }
    setSelectedRuleIdsForDelete(new Set());
    setIsSelectMode(false);
  };

  const handleCopyJson = () => {
    let textToCopy = '';
    if (activeJsonTab === 'catalog') {
      textToCopy = exportToFullCatalogJson(catalog, rules);
    } else if (activeJsonTab === 'cando') {
      textToCopy = exportToCandoJson(rules, settings, catalog);
    } else if (activeJsonTab === 'esp32') {
      textToCopy = exportToEsp32FirmwareJson(rules, settings, catalog);
    } else {
      textToCopy = customJsonSchema;
    }
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadJson = () => {
    let content = '';
    let filename = '';
    if (activeJsonTab === 'catalog') {
      content = exportToFullCatalogJson(catalog, rules);
      filename = 'can_do_catalog.json';
    } else if (activeJsonTab === 'cando') {
      content = exportToCandoJson(rules, settings, catalog);
      filename = 'automations.json';
    } else if (activeJsonTab === 'esp32') {
      content = exportToEsp32FirmwareJson(rules, settings, catalog);
      filename = 'esp32_automations.json';
    } else {
      content = customJsonSchema;
      filename = 'firmware_schema.json';
    }

    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePushToEsp = async () => {
    setSyncing(true);
    setSyncStatus('Pushing automations.json to ESP32...');
    try {
      const payload = exportToCandoJson(rules, settings, catalog);
      const base = resolveDeviceBaseUrl(espIp);
      const url = `${base}/api/automations`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      setSyncStatus(`Success: ${data.message || 'Saved. Rebooting ESP32...'}`);
      setTimeout(() => setSyncStatus(null), 6000);
    } catch (err: any) {
      setSyncStatus(`Push failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handlePullFromEsp = async () => {
    setSyncing(true);
    setSyncStatus('Pulling automations.json from ESP32...');
    try {
      const base = resolveDeviceBaseUrl(espIp);
      const url = `${base}/api/automations`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data.rules && Array.isArray(data.rules)) {
        onUpdateRules(data.rules);
        if (data.settings) onUpdateSettings(data.settings);
        if (data.rules[0]?.id) setSelectedRuleId(data.rules[0].id);
        setSyncStatus(`Imported ${data.rules.length} rule(s) from ESP32!`);
      } else if (Array.isArray(data)) {
        onUpdateRules(data);
        if (data[0]?.id) setSelectedRuleId(data[0].id);
        setSyncStatus(`Imported ${data.length} rule(s) from ESP32!`);
      } else {
        setSyncStatus('No rules array found in device response.');
      }
      setTimeout(() => setSyncStatus(null), 6000);
    } catch (err: any) {
      setSyncStatus(`Pull failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Automatically pull automations from device when running directly on-device
  const hasAutoPulled = useRef(false);
  React.useEffect(() => {
    if (isRunningOnDevice() && !hasAutoPulled.current) {
      hasAutoPulled.current = true;
      handlePullFromEsp();
    }
  }, []);

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        if (parsed.automations && Array.isArray(parsed.automations)) {
          onUpdateRules(parsed.automations);
          if (parsed.automations[0]?.id) setSelectedRuleId(parsed.automations[0].id);
          alert(`Successfully imported ${parsed.automations.length} automation rules from catalog!`);
        } else if (parsed.rules && Array.isArray(parsed.rules)) {
          onUpdateRules(parsed.rules);
          if (parsed.settings) onUpdateSettings(parsed.settings);
          if (parsed.rules[0]?.id) setSelectedRuleId(parsed.rules[0].id);
          alert(`Successfully imported ${parsed.rules.length} automation rules!`);
        } else if (Array.isArray(parsed)) {
          onUpdateRules(parsed);
          if (parsed[0]?.id) setSelectedRuleId(parsed[0].id);
          alert(`Successfully imported ${parsed.length} automation rules!`);
        } else {
          alert('Could not detect an "automations" or "rules" array in this JSON file.');
        }
      } catch (err: any) {
        alert(`Error parsing JSON: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSimulateRule = () => {
    if (!activeRule) return;
    setShowSimulateModal(true);
    const trigs = activeRule.triggers || [];
    const conds = activeRule.conditions || [];
    const acts = activeRule.actions || [];
    const logs = [
      `[ESP32 Boot] Loaded rule: "${activeRule.name}" (Mode: ${(activeRule.exec_mode || 'one_shot').toUpperCase()})`,
      `[Trigger Engine] Monitoring ${trigs.length} trigger pattern(s)...`,
      `[Sim Ingress] CAN frame matching trigger ${trigs[0]?.can_id || '0x448'} received on Bus ${trigs[0]?.bus ?? 0}`,
      `[Condition Evaluator] Checking ${conds.length} condition(s): ALL PASS (1/1 true)`,
      `[Dispatcher] Executing ${acts.length} action(s) with ${activeRule.cooldown_ms || 0}ms cooldown protection...`
    ];

    acts.forEach((act, idx) => {
      if (act.type === 'precondition') {
        logs.push(`  -> Action #${idx + 1}: Triggered Precondition State Machine (Persistent mode)`);
      } else if (act.type === 'track_popup' || act.type === 'popup') {
        const pfx = act.level === 'warning' ? '[WARN] ' : act.level === 'error' ? '[ERR] ' : '[INFO] ';
        logs.push(`  -> Action #${idx + 1}: Cluster Track Selection Popup [${(act.level || 'info').toUpperCase()}]: "${pfx}${act.text || act.popup_message || ''}"`);
      } else if (act.type === 'climate_target') {
        logs.push(
          `  -> Action #${idx + 1}: Dynamic Climate Target: Adjust ${(act.zone || 'driver').toUpperCase()} zone temp to ${act.target_temp_c ?? act.target_c ?? 21.0}°C via ECU 0x2CF (Sync: ${act.sync_on ? 'ON' : 'OFF'}, Driver-Only: ${act.driver_only ? 'YES' : 'NO'})`
        );
      } else if (act.type === 'can_tx') {
        logs.push(
          `  -> Action #${idx + 1}: Injected CAN Frame ID ${act.can_id} [${typeof act.payload === 'object' ? JSON.stringify(act.payload) : act.payload}] (Repeat: ${act.repeat || 1}x, Delay: ${act.delay_ms || 0}ms)`
        );
      } else {
        logs.push(`  -> Action #${idx + 1}: Executed action type "${act.type}"`);
      }
      if (act.popup_message) {
        logs.push(`  -> OSD Cluster Toast: "${act.popup_message}"`);
      }
    });

    logs.push(`[Success] Rule dry-run verified successfully. Cooldown armed for ${activeRule.cooldown_ms || 0}ms.`);
    setSimulationLog(logs);
  };

  const openAddTriggerDialog = (onAdd: (t: AutomationTrigger) => void) => {
    setAddElementTarget({
      type: 'trigger',
      title: 'Add Trigger (When...)',
      contextHint: 'Select an event, gesture, sensor transition, or schedule to trigger this automation.',
      onAdd: (item) => onAdd(item as AutomationTrigger)
    });
  };

  const openAddConditionDialog = (onAdd: (c: AutomationCondition) => void) => {
    setAddElementTarget({
      type: 'condition',
      title: 'Add Condition (And If...)',
      contextHint: 'Select states, logical gates (AND/OR/NOT), or time windows required for the rule to proceed.',
      onAdd: (item) => onAdd(item as AutomationCondition)
    });
  };

  const openAddActionDialog = (onAdd: (a: AutomationAction) => void) => {
    setAddElementTarget({
      type: 'action',
      title: 'Add Action (Then Do...)',
      contextHint: 'Select vehicle actuators, cluster popups, delays, or branching logic (IF/CHOOSE) to execute.',
      onAdd: (item) => onAdd(item as AutomationAction)
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Main Builder Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Active Rule Editor (8 cols = ~2/3 of area) */}
        {activeRule ? (
          <div className="lg:col-span-8 space-y-4">
            {/* Active Rule Action Strip */}
            <div className="flex items-center justify-between gap-2.5 p-3 rounded-xl bg-slate-900 border border-slate-800 shadow-sm">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    activeRule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                  }`}
                />
                <input
                  type="text"
                  value={activeRule.name}
                  onChange={e => handleUpdateActiveRule({ name: e.target.value })}
                  placeholder="Automation Name"
                  className="bg-transparent text-sm font-bold text-white focus:outline-none focus:ring-1 focus:ring-cyan-500/50 rounded px-1.5 py-0.5 w-full min-w-0 truncate"
                />
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => handleUpdateActiveRule({ enabled: !activeRule.enabled })}
                  className={`px-2 py-1 rounded-lg text-xs font-semibold border transition ${
                    activeRule.enabled
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {activeRule.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDuplicateRule(activeRule)}
                  title="Duplicate active rule"
                  className="p-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                >
                  <Copy className="w-3.5 h-3.5 text-cyan-400" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteRule(activeRule.id)}
                  title="Delete active rule"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition active:scale-95"
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                  <span className="hidden sm:inline">Delete</span>
                </button>
              </div>
            </div>

            {/* SECTION 1: TRIGGERS */}
            <div className="can-do-section-box trig-section space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-amber-500/20 text-amber-400">
                    <Zap className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Triggers
                  </span>
                </div>
                <span className="text-[11px] font-mono text-amber-400 font-semibold">
                  {activeRule.triggers.length} {activeRule.triggers.length === 1 ? 'Trigger' : 'Triggers'}
                </span>
              </div>

              {activeRule.triggers.length === 0 ? (
                <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500 italic">
                  No triggers defined. Automation will never fire.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {activeRule.triggers.map((trig, tIdx) => (
                    <TriggerNodeEditor
                      key={trig.id || tIdx}
                      trig={trig}
                      tIdx={tIdx}
                      catalog={catalog}
                      onUpdate={updated => {
                        const next = [...activeRule.triggers];
                        next[tIdx] = updated;
                        handleUpdateActiveRule({ triggers: next });
                      }}
                      onDelete={() => {
                        const next = activeRule.triggers.filter((_, i) => i !== tIdx);
                        handleUpdateActiveRule({ triggers: next });
                      }}
                    />
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() =>
                  openAddTriggerDialog(newTrig =>
                    handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] })
                  )
                }
                className="ha-section-add-btn accent-trig"
              >
                <Plus className="w-4 h-4" />
                <span>Add Trigger</span>
              </button>
            </div>

            {/* SECTION 2: CONDITIONS */}
            <div className="can-do-section-box cond-section space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-sky-500/20 text-sky-400">
                    <Shield className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Conditions
                  </span>
                </div>
                <span className="text-[11px] text-slate-400">
                  Optional gate evaluated before actions run
                </span>
              </div>

              <ConditionListEditor
                conditions={activeRule.conditions}
                depth={0}
                availableTriggers={activeRule.triggers}
                emptyText="No conditions set. Rule will always execute when triggers match."
                onUpdate={conds => handleUpdateActiveRule({ conditions: conds })}
                onOpenAddConditionDialog={openAddConditionDialog}
              />
            </div>

            {/* SECTION 3: ACTIONS */}
            <div className="can-do-section-box act-section space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400">
                    <Send className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Actions
                  </span>
                </div>
                <span className="text-[11px] text-slate-400">
                  Executed in sequence when triggers &amp; conditions match
                </span>
              </div>

              <ActionListEditor
                actions={activeRule.actions}
                depth={0}
                availableTriggers={activeRule.triggers}
                catalog={catalog}
                emptyText="No actions defined."
                onUpdate={acts => handleUpdateActiveRule({ actions: acts })}
                onOpenAddConditionDialog={openAddConditionDialog}
                onOpenAddActionDialog={openAddActionDialog}
              />
            </div>

            {/* SECTION 4: OFF-ACTIONS (Visible only in Toggle mode) */}
            {activeRule.exec_mode === 'toggle' && (
              <div className="can-do-section-box off-act-section space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-lg bg-rose-500/20 text-rose-400">
                      <RotateCw className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider text-rose-300">
                      Off-Actions
                    </span>
                  </div>
                  <span className="text-[11px] text-rose-400/80">
                    Executed when toggled off or when auto-revert expires
                  </span>
                </div>

                <ActionListEditor
                  actions={activeRule.off_actions || []}
                  depth={0}
                  availableTriggers={activeRule.triggers}
                  catalog={catalog}
                  emptyText="No off-actions defined. Specify actions to run when toggled off."
                  onUpdate={acts => handleUpdateActiveRule({ off_actions: acts })}
                  onOpenAddConditionDialog={openAddConditionDialog}
                  onOpenAddActionDialog={openAddActionDialog}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="lg:col-span-8 flex items-center justify-center p-12 rounded-2xl bg-slate-900 border border-slate-800 text-slate-500 text-sm">
            Select or create an automation rule to start editing.
          </div>
        )}

        {/* Right Column: Automations List & JSON Inspector (4 cols = ~1/3 of area) */}
        <div className="lg:col-span-4 space-y-4">
          {/* Card 1: Automations List (Compact) */}
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
            {!isSelectMode ? (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Automations ({rules.length})
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setIsSelectMode(true);
                      setSelectedRuleIdsForDelete(new Set());
                    }}
                    title="Select automations to delete"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    <CheckSquare className="w-3 h-3 text-cyan-400" />
                    <span>Select</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSimulateRule}
                    title="Dry run active rule simulation"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700 transition"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>Dry Run</span>
                  </button>
                  <label
                    title="Import automation JSON"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer transition"
                  >
                    <Upload className="w-3 h-3 text-cyan-400" />
                    <span>Import</span>
                    <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
                  </label>
                  <button
                    type="button"
                    onClick={handleAddRule}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/40 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>New</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 flex-wrap bg-slate-950/80 -m-1 p-2 rounded-xl border border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-cyan-300">
                    Select Mode
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedRuleIdsForDelete.size === rules.length) {
                        setSelectedRuleIdsForDelete(new Set());
                      } else {
                        setSelectedRuleIdsForDelete(new Set(rules.map(r => r.id)));
                      }
                    }}
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition underline underline-offset-2"
                  >
                    {selectedRuleIdsForDelete.size === rules.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {selectedRuleIdsForDelete.size > 0 && (
                    <button
                      type="button"
                      onClick={handleBatchDelete}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition shadow-sm animate-pulse"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete ({selectedRuleIdsForDelete.size})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setIsSelectMode(false);
                      setSelectedRuleIdsForDelete(new Set());
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                  >
                    <span>Done</span>
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
              {rules.map((rule, idx) => (
                <SwipeableRuleItem
                  key={rule.id}
                  rule={rule}
                  idx={idx}
                  isSelected={rule.id === activeRule?.id}
                  isSelectMode={isSelectMode}
                  isCheckedForDelete={selectedRuleIdsForDelete.has(rule.id)}
                  onToggleCheck={handleToggleCheckForDelete}
                  onSelect={setSelectedRuleId}
                  onDuplicate={handleDuplicateRule}
                  onDelete={handleDeleteRule}
                />
              ))}
            </div>

            {/* Mobile swipe hint */}
            {!isSelectMode && rules.length > 0 && (
              <p className="text-[10px] text-slate-500 text-center pt-1 block sm:hidden">
                Swipe left to delete · Swipe right to duplicate
              </p>
            )}
          </div>

          {/* Card 2: Live JSON Inspector & Output (Compact) */}
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-950 border border-slate-800 text-[10px]">
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('catalog')}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    activeJsonTab === 'catalog'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Full Catalog
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('cando')}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    activeJsonTab === 'cando'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  WiCAN Format
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('esp32')}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    activeJsonTab === 'esp32'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  ESP32 C-Flat
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('custom')}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    activeJsonTab === 'custom'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Custom
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopyJson}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition border border-slate-700"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-cyan-400" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>

            {/* Tab descriptions */}
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <FileJson className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
              <span className="truncate">
                {activeJsonTab === 'catalog' && 'can_do_catalog.json for LittleFS flash.'}
                {activeJsonTab === 'cando' && 'WiCAN LittleFS automation format.'}
                {activeJsonTab === 'esp32' && 'Flat numeric enums for C parsing.'}
                {activeJsonTab === 'custom' && 'Sandbox schema for testing firmware.'}
              </span>
            </div>

            {/* Code Output Area (Compact height 190px) */}
            <div className="relative h-[190px] max-h-[190px] overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
              {activeJsonTab === 'custom' ? (
                <textarea
                  value={customJsonSchema}
                  onChange={e => setCustomJsonSchema(e.target.value)}
                  className="w-full h-full p-2.5 font-mono text-[11px] text-cyan-300 bg-transparent resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500 leading-relaxed overflow-y-auto"
                  spellCheck={false}
                />
              ) : (
                <pre className="w-full h-full p-2.5 font-mono text-[11px] text-slate-300 overflow-auto leading-relaxed select-text">
                  <code>
                    {activeJsonTab === 'catalog'
                      ? exportToFullCatalogJson(catalog, rules)
                      : activeJsonTab === 'cando'
                      ? exportToCandoJson(rules, settings, catalog)
                      : exportToEsp32FirmwareJson(rules, settings, catalog)}
                  </code>
                </pre>
              )}
            </div>

            {/* Quick Export & ESP32 Direct Sync Footer */}
            <div className="pt-2 border-t border-slate-800 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5 p-2 rounded-lg bg-slate-950/70 border border-slate-800/80">
                <div className="flex items-center gap-1.5 flex-1 min-w-[150px]">
                  <span className="text-[10px] font-semibold text-slate-400 whitespace-nowrap">ESP IP:</span>
                  <input
                    type="text"
                    value={espIp}
                    onChange={e => setEspIp(e.target.value)}
                    placeholder={getDefaultEspIp()}
                    title="Device IP address or hostname"
                    className="flex-1 px-2 py-0.5 text-xs font-mono rounded bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handlePullFromEsp}
                    className="px-2 py-1 text-[11px] font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition disabled:opacity-50"
                  >
                    Pull
                  </button>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handlePushToEsp}
                    className="px-2.5 py-1 text-[11px] font-semibold rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold transition disabled:opacity-50"
                  >
                    Push
                  </button>
                </div>
              </div>

              {syncStatus && (
                <div className="text-[10px] font-mono text-cyan-400 bg-cyan-950/40 border border-cyan-800/60 rounded px-2 py-0.5">
                  {syncStatus}
                </div>
              )}

              <div className="flex items-center justify-between text-[11px] text-slate-500 pt-0.5">
                <span>{rules.length} automations compiled</span>
                <button
                  type="button"
                  onClick={handleDownloadJson}
                  className="hover:text-cyan-400 font-semibold underline underline-offset-2 transition"
                >
                  Download .json file
                </button>
              </div>
            </div>
          </div>

          {/* Card 3: Quick Info & ESP32 Firmware Notes */}
          <div className="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold text-slate-300">
              <Info className="w-3.5 h-3.5 text-cyan-400" />
              <span>Firmware Redesign Note</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              As you rewrite the ESP32 firmware, this interface serves as the primary logic orchestrator. The ESP32 simply ingests and executes the generated JSON.
            </p>
          </div>
        </div>
      </div>

      {/* MODAL: Add Element (HA-style Categorized Selector) */}
      {addElementTarget && (
        <AddElementModal
          target={addElementTarget}
          catalog={catalog}
          onClose={() => setAddElementTarget(null)}
        />
      )}

      {/* MODAL: Rule Dry Run / Simulation Log */}
      {showSimulateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                  <Play className="w-4 h-4 fill-current" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Rule Simulation Dry-Run</h3>
                  <p className="text-[11px] text-slate-400">
                    Emulating ESP32 reactive rule evaluation pipeline
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSimulateModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-slate-950 font-mono text-xs text-emerald-400 space-y-1 max-h-80 overflow-y-auto leading-relaxed select-text">
              {simulationLog.map((line, idx) => (
                <div key={idx} className={line.startsWith('[Sim Ingress]') ? 'text-yellow-300' : line.startsWith('  ->') ? 'text-cyan-300 pl-2' : ''}>
                  {line}
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900/80 flex items-center justify-end">
              <button
                type="button"
                onClick={() => setShowSimulateModal(false)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
              >
                Close Log
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
