import React, { useState } from 'react';
import {
  AutomationRule,
  AutomationSettings,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  ExecutionMode,
  TriggerCombineMode
} from '../types/automation';
import { Catalog, Command, CommandOption } from '../types/catalog';
import {
  exportToCandoJson,
  exportToEsp32FirmwareJson,
  exportToFullCatalogJson,
  commandToTrigger,
  commandToCondition,
  commandToAction,
  compileToByteMap
} from '../utils/automationConverters';
import { MdiIcon, SUGGESTED_MDI_ICONS } from './MdiIcon';
import {
  Zap,
  Shield,
  Send,
  Plus,
  Trash2,
  Copy,
  Check,
  Download,
  Upload,
  Play,
  RotateCw,
  Sliders,
  Sparkles,
  Layers,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Search,
  ExternalLink,
  Code,
  FileJson,
  Cpu,
  RefreshCcw,
  RefreshCw,
  Eye,
  Info,
  Car,
  GitFork,
  Split,
  Clock,
  MessageSquare,
  Thermometer
} from 'lucide-react';

interface AutomationBuilderProps {
  catalog: Catalog;
  rules: AutomationRule[];
  onUpdateRules: (newRules: AutomationRule[]) => void;
  settings: AutomationSettings;
  onUpdateSettings: (newSettings: AutomationSettings) => void;
  onBackToCatalog?: () => void;
  // If items were selected from the catalog to pull into an automation
  pulledCommands?: { command: Command; option?: CommandOption; role?: 'trigger' | 'condition' | 'action' }[];
  onClearPulledCommands?: () => void;
}

interface ConditionNodeEditorProps {
  cond: AutomationCondition;
  index: number;
  depth?: number;
  onUpdate: (updated: AutomationCondition) => void;
  onDelete: () => void;
}

interface ConditionListEditorProps {
  conditions: AutomationCondition[];
  depth?: number;
  label?: string;
  emptyText?: string;
  onUpdate: (conditions: AutomationCondition[]) => void;
  onPullCatalog?: () => void;
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
  onUpdate,
  onDelete
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
              emptyText="Empty group. Add conditions below."
              onUpdate={updatedSubs => onUpdate({ ...cond, conditions: updatedSubs })}
            />
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
              <span className="px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60">
                {cond.start_time || '08:00'} - {cond.end_time || '18:00'}
              </span>
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
              value={cond.start_time || '08:00'}
              onChange={e => onUpdate({ ...cond, start_time: e.target.value })}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500"
            />
          </div>
          <div>
            <label className="block text-[10px] font-sans text-slate-400 mb-1">End Time (24h)</label>
            <input
              type="time"
              value={cond.end_time || '18:00'}
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
  const dKey = cond.byte || cond.evaluate?.byte || (cond.match ? Object.keys(cond.match)[0] : 'D1') || 'D1';
  const maskVal = cond.mask || cond.evaluate?.mask || '0xFF';
  const opVal = cond.operator || cond.evaluate?.operator || (cond.invert ? 'not_equal' : 'equal');
  const targetVal = cond.value || cond.evaluate?.value || (cond.match ? cond.match[dKey] : '0x01') || '0x01';

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
              CAN {cond.can_id || '0x000'} Bus {cond.bus ?? 0}
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
  onUpdate,
  onPullCatalog
}: ConditionListEditorProps) {
  const addCondition = (type: 'leaf' | 'time' | 'and' | 'or' | 'not') => {
    const next = [...conditions];
    if (type === 'leaf') {
      next.push({
        id: `cond_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        logic: 'leaf',
        can_id: '0x120',
        bus: 0,
        byte: 'D1',
        mask: '0xFF',
        operator: 'equal',
        value: '0x01'
      });
    } else if (type === 'time') {
      next.push({
        id: `cond_time_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'time_condition',
        start_time: '08:00',
        end_time: '18:00',
        days: ['mon', 'tue', 'wed', 'thu', 'fri']
      });
    } else {
      next.push({
        id: `cond_${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        logic: type,
        conditions: []
      });
    }
    onUpdate(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {label && (
          <span className="text-purple-300 font-bold text-[11px] uppercase tracking-wider">
            {label} ({conditions.length})
          </span>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          {onPullCatalog && (
            <button
              type="button"
              onClick={onPullCatalog}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-500 text-slate-950 hover:bg-purple-400 transition"
            >
              <Plus className="w-3 h-3" />
              <span>Pull Catalog</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => addCondition('leaf')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
          >
            <Plus className="w-3 h-3" />
            <span>Byte Value</span>
          </button>
          <button
            type="button"
            onClick={() => addCondition('time')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-cyan-300 hover:bg-slate-700 transition border border-cyan-900/50"
          >
            <Clock className="w-3 h-3" />
            <span>Time Window</span>
          </button>
          <button
            type="button"
            onClick={() => addCondition('and')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-950 text-purple-300 border border-purple-800 hover:bg-purple-900 transition"
          >
            <Plus className="w-3 h-3" />
            <span>AND</span>
          </button>
          <button
            type="button"
            onClick={() => addCondition('or')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-950 text-indigo-300 border border-indigo-800 hover:bg-indigo-900 transition"
          >
            <Plus className="w-3 h-3" />
            <span>OR</span>
          </button>
          <button
            type="button"
            onClick={() => addCondition('not')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-950 text-rose-300 border border-rose-800 hover:bg-rose-900 transition"
          >
            <Plus className="w-3 h-3" />
            <span>NOT</span>
          </button>
        </div>
      </div>

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
              onUpdate={updated => {
                const next = [...conditions];
                next[idx] = updated;
                onUpdate(next);
              }}
              onDelete={() => {
                const next = conditions.filter((_, i) => i !== idx);
                onUpdate(next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ActionNodeEditorProps {
  act: AutomationAction;
  index: number;
  depth?: number;
  onUpdate: (updated: AutomationAction) => void;
  onDelete: () => void;
}

interface ActionListEditorProps {
  actions: AutomationAction[];
  depth?: number;
  label?: string;
  emptyText?: string;
  onUpdate: (actions: AutomationAction[]) => void;
  onPullCatalog?: () => void;
}

function ActionNodeEditor({
  act,
  index,
  depth = 0,
  onUpdate,
  onDelete
}: ActionNodeEditorProps) {
  const [collapsed, setCollapsed] = useState(false);

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
                onUpdate={updatedConds => onUpdate({ ...act, conditions: updatedConds })}
              />
            </div>

            {/* THEN ACTIONS */}
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2">
              <ActionListEditor
                actions={act.then || []}
                depth={depth + 1}
                label="THEN (Execute if True)"
                emptyText="No actions in THEN branch."
                onUpdate={updatedThen => onUpdate({ ...act, then: updatedThen })}
              />
            </div>

            {/* ELSE ACTIONS */}
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2">
              <ActionListEditor
                actions={act.else || []}
                depth={depth + 1}
                label="ELSE (Execute if False)"
                emptyText="No actions in ELSE branch."
                onUpdate={updatedElse => onUpdate({ ...act, else: updatedElse })}
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
                  conditions: [{
                    id: `cond_${Date.now().toString(36)}`,
                    logic: 'leaf',
                    can_id: '0x120',
                    bus: 0,
                    byte: 'D1',
                    mask: '0xFF',
                    operator: 'equal',
                    value: '0x01'
                  }],
                  sequence: [{
                    id: `act_${Date.now().toString(36)}`,
                    type: 'entity_command',
                    entity_id: 'drivers_seat_comfort',
                    command: 'Medium Cool'
                  }]
                });
                onUpdate({ ...act, choices });
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-blue-900 hover:bg-blue-800 text-white font-semibold"
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
                      onUpdate={updatedConds => {
                        const choices = [...(act.choices || [])];
                        choices[chIdx].conditions = updatedConds;
                        onUpdate({ ...act, choices });
                      }}
                    />
                  </div>

                  {/* Sequence in Choice */}
                  <div className="pl-2 border-l border-slate-800 pt-2">
                    <ActionListEditor
                      actions={ch.sequence || []}
                      depth={depth + 1}
                      label="Branch Sequence Actions"
                      emptyText="No actions in branch sequence."
                      onUpdate={updatedSeq => {
                        const choices = [...(act.choices || [])];
                        choices[chIdx].sequence = updatedSeq;
                        onUpdate({ ...act, choices });
                      }}
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
                onUpdate={updatedDef => onUpdate({ ...act, default: updatedDef })}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Regular action step
  return (
    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-300 font-bold text-[10px] flex items-center justify-center border border-emerald-800">
            A{index + 1}
          </span>
          {act.source_command_name ? (
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-white">{act.source_command_name}</span>
              {act.option_label && (
                <span className="px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 text-[10px] border border-emerald-800/60">
                  {act.option_label}
                </span>
              )}
            </div>
          ) : (
            <span className="font-semibold text-slate-300 font-mono">
              {act.type === 'entity_command'
                ? `Entity: ${act.entity_id || 'drivers_seat_comfort'}`
                : act.type === 'delay'
                ? `Delay: ${act.delay_ms || act.ms || 500}ms`
                : act.type === 'track_popup' || act.type === 'popup'
                ? `Cluster Popup (${(act.level || 'info').toUpperCase()}): ${act.text || act.popup_message || 'Message'}`
                : act.type === 'climate_target'
                ? `Climate Target: ${act.target_temp_c ?? act.target_c ?? 21.0}°C (${(act.zone || 'driver').toUpperCase()})`
                : act.type === 'precondition'
                ? `Battery Preconditioning: ${(act.precon_action || 'start').toUpperCase()} (${act.precon_mode || 'persistent'})`
                : `CAN TX ${act.can_id}`}
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
                  {Math.round(((act.target_temp_c ?? 21.0) * 9 / 5 + 32) * 10) / 10}°F
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step="0.5"
                  min="14"
                  max="32"
                  value={act.target_temp_c ?? act.target_c ?? 21.0}
                  onChange={e => {
                    const val = parseFloat(e.target.value) || 21.0;
                    onUpdate({ ...act, target_temp_c: val, target_c: val });
                  }}
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
                <option value="info">ⓘ Info</option>
                <option value="warning">⚠ Warning</option>
                <option value="error">‼ Error</option>
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
                placeholder="Preconditioning Started"
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
                placeholder="drivers_seat_comfort"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Command</label>
              <input
                type="text"
                value={act.command || ''}
                onChange={e => onUpdate({ ...act, command: e.target.value })}
                placeholder="Medium Cool"
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
              value={act.delay_ms || act.ms || 500}
              onChange={e => {
                const val = parseInt(e.target.value) || 0;
                onUpdate({ ...act, delay_ms: val, ms: val });
              }}
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
                  value={act.repeat || 1}
                  onChange={e => onUpdate({ ...act, repeat: parseInt(e.target.value) || 1 })}
                  className="w-12 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                />
                <span className="text-slate-500 font-sans">×</span>
                <input
                  type="number"
                  value={act.delay_ms || 0}
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
              value={typeof act.payload === 'object' ? JSON.stringify(act.payload) : act.payload || '{"D1":"0x02","D2":"0x01"}'}
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
  );
}

function ActionListEditor({
  actions,
  depth = 0,
  label,
  emptyText = 'No actions defined.',
  onUpdate,
  onPullCatalog
}: ActionListEditorProps) {
  const addAction = (type: 'entity_command' | 'can_tx' | 'delay' | 'if_then' | 'choose' | 'track_popup' | 'climate_target' | 'precondition') => {
    const next = [...actions];
    if (type === 'entity_command') {
      next.push({
        id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'entity_command',
        entity_id: 'drivers_seat_comfort',
        command: 'Medium Cool'
      });
    } else if (type === 'climate_target') {
      next.push({
        id: `act_climate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'climate_target',
        target_temp_c: 21.0,
        zone: 'driver',
        sync_on: true,
        driver_only: false
      });
    } else if (type === 'can_tx') {
      next.push({
        id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'can_tx',
        can_id: '0x524',
        bus: 0,
        payload: { D1: '0x02', D2: '0x01' },
        repeat: 1,
        delay_ms: 50
      });
    } else if (type === 'delay') {
      next.push({
        id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'delay',
        delay_ms: 500,
        ms: 500
      });
    } else if (type === 'if_then') {
      next.push({
        id: `act_if_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'if_then',
        conditions: [{
          id: `cond_${Date.now().toString(36)}`,
          logic: 'leaf',
          can_id: '0x120',
          bus: 0,
          byte: 'D1',
          mask: '0xFF',
          operator: 'equal',
          value: '0x01'
        }],
        then: [{
          id: `act_${Date.now().toString(36)}_1`,
          type: 'entity_command',
          entity_id: 'drivers_seat_comfort',
          command: 'Medium Cool'
        }],
        else: []
      });
    } else if (type === 'choose') {
      next.push({
        id: `act_choose_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'choose',
        choices: [{
          conditions: [{
            id: `cond_${Date.now().toString(36)}`,
            logic: 'leaf',
            can_id: '0x120',
            bus: 0,
            byte: 'D1',
            mask: '0xFF',
            operator: 'equal',
            value: '0x01'
          }],
          sequence: [{
            id: `act_${Date.now().toString(36)}_1`,
            type: 'entity_command',
            entity_id: 'drivers_seat_comfort',
            command: 'Medium Cool'
          }]
        }],
        default: []
      });
    } else if (type === 'track_popup') {
      next.push({
        id: `act_popup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'track_popup',
        level: 'info',
        text: 'Preconditioning Started'
      });
    } else if (type === 'precondition') {
      next.push({
        id: `act_precon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'precondition',
        precon_mode: 'persistent',
        precon_action: 'start'
      });
    }
    onUpdate(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {label && (
          <span className="text-emerald-400 font-bold text-[11px] uppercase tracking-wider">
            {label} ({actions.length})
          </span>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          {onPullCatalog && (
            <button
              type="button"
              onClick={onPullCatalog}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition"
            >
              <Plus className="w-3 h-3" />
              <span>Pull Catalog</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => addAction('entity_command')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
          >
            <Plus className="w-3 h-3" />
            <span>Entity Cmd</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('precondition')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-orange-950 text-orange-300 border border-orange-800 hover:bg-orange-900 transition"
          >
            <Zap className="w-3 h-3" />
            <span>Precondition</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('climate_target')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-teal-950 text-teal-300 border border-teal-800 hover:bg-teal-900 transition"
          >
            <Thermometer className="w-3 h-3" />
            <span>Climate Target</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('track_popup')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-950 text-amber-300 border border-amber-800 hover:bg-amber-900 transition"
          >
            <MessageSquare className="w-3 h-3" />
            <span>Show Popup Message</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('can_tx')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
          >
            <Plus className="w-3 h-3" />
            <span>Raw CAN TX</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('delay')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
          >
            <Clock className="w-3 h-3" />
            <span>Delay</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('if_then')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-cyan-950 text-cyan-300 border border-cyan-800 hover:bg-cyan-900 transition"
          >
            <GitFork className="w-3 h-3" />
            <span>If-Then-Else</span>
          </button>
          <button
            type="button"
            onClick={() => addAction('choose')}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-950 text-blue-300 border border-blue-800 hover:bg-blue-900 transition"
          >
            <Split className="w-3 h-3" />
            <span>Choose</span>
          </button>
        </div>
      </div>

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
              onUpdate={updated => {
                const next = [...actions];
                next[idx] = updated;
                onUpdate(next);
              }}
              onDelete={() => {
                const next = actions.filter((_, i) => i !== idx);
                onUpdate(next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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
  const [activeJsonTab, setActiveJsonTab] = useState<'catalog' | 'cando' | 'esp32' | 'custom'>('catalog');
  const [copied, setCopied] = useState(false);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<'trigger' | 'condition' | 'action' | 'off_action'>('trigger');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerCategory, setPickerCategory] = useState('all');
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  const [espIp, setEspIp] = useState('192.168.4.1');
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
      ha_icon: 'mdi:car-defrost-rear',
      exec_mode: 'one_shot',
      trigger_mode: 'any',
      cooldown_ms: 500,
      timeout_reset_ms: 2000,
      triggers: [
        {
          id: `trig_${Date.now().toString(36)}`,
          source: 'can',
          can_id: '0x448',
          bus: 0,
          click_count: 1,
          byte_index: 6,
          from_value: 0,
          to_value: 1,
          match: { D7: '0x0' }
        }
      ],
      conditions: [],
      actions: [
        {
          id: `act_${Date.now().toString(36)}`,
          type: 'can_tx',
          can_id: '0x524',
          bus: 0,
          payload: { D1: '0x02', D2: '0x01' },
          repeat: 1,
          delay_ms: 50
        }
      ]
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
    if (rules.length <= 1) {
      alert('You must keep at least one automation rule.');
      return;
    }
    const newRules = rules.filter(r => r.id !== ruleId);
    onUpdateRules(newRules);
    if (selectedRuleId === ruleId) {
      setSelectedRuleId(newRules[0]?.id || '');
    }
  };

  const handleCopyJson = () => {
    let textToCopy = '';
    if (activeJsonTab === 'catalog') {
      textToCopy = exportToFullCatalogJson(catalog, rules);
    } else if (activeJsonTab === 'cando') {
      textToCopy = exportToCandoJson(rules, settings);
    } else if (activeJsonTab === 'esp32') {
      textToCopy = exportToEsp32FirmwareJson(rules, settings);
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
      content = exportToCandoJson(rules, settings);
      filename = 'automations.json';
    } else if (activeJsonTab === 'esp32') {
      content = exportToEsp32FirmwareJson(rules, settings);
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
      const payload = exportToCandoJson(rules, settings);
      const host = espIp.trim().replace(/\/+$/, '');
      const url = host.startsWith('http') ? `${host}/api/automations` : `http://${host}/api/automations`;
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
      const host = espIp.trim().replace(/\/+$/, '');
      const url = host.startsWith('http') ? `${host}/api/automations` : `http://${host}/api/automations`;
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
        const pfx = act.level === 'warning' ? '⚠ ' : act.level === 'error' ? '‼ ' : 'ⓘ ';
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

  // Filter commands for the catalog pull picker
  const filteredPickerCommands = (catalog?.commands || []).filter(cmd => {
    const cmdName = cmd.name || cmd.ha_metadata?.name || cmd.id || '';
    const cmdId = cmd.id || '';
    const stateCanId = cmd.state_can_id || cmd.network?.state_can_id || '';
    const actionCanId = cmd.action_can_id || cmd.network?.action_can_id || '';
    const q = (pickerSearch || '').toLowerCase();

    const matchesSearch =
      cmdName.toLowerCase().includes(q) ||
      cmdId.toLowerCase().includes(q) ||
      stateCanId.toLowerCase().includes(q) ||
      actionCanId.toLowerCase().includes(q);
    const matchesCat = pickerCategory === 'all' || cmd.category === pickerCategory;
    return matchesSearch && matchesCat;
  });

  const handleSelectFromPicker = (cmd: Command, opt?: CommandOption) => {
    if (!activeRule) return;
    if (pickerTarget === 'trigger') {
      const newTrig = commandToTrigger(cmd, opt);
      handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] });
    } else if (pickerTarget === 'condition') {
      const newCond = commandToCondition(cmd, opt);
      handleUpdateActiveRule({ conditions: [...activeRule.conditions, newCond] });
    } else if (pickerTarget === 'action') {
      const newAct = commandToAction(cmd, opt);
      handleUpdateActiveRule({ actions: [...activeRule.actions, newAct] });
    } else if (pickerTarget === 'off_action') {
      const newOffAct = commandToAction(cmd, opt);
      handleUpdateActiveRule({ off_actions: [...(activeRule.off_actions || []), newOffAct] });
    }
    setCatalogPickerOpen(false);
  };

  const categories = Array.from(new Set(catalog.commands.map(c => c.category))).filter(Boolean);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Top Header & Context Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-inner">
            <Cpu className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white tracking-tight">CAN Do Automation Builder</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 font-mono border border-cyan-800">
                The Brains
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-medium">
                {rules.length} {rules.length === 1 ? 'Rule' : 'Rules'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Select catalog commands to generate reactive trigger-action automations for the ESP32 firmware.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onBackToCatalog && (
            <button
              type="button"
              onClick={onBackToCatalog}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition"
            >
              <ArrowRight className="w-3.5 h-3.5 rotate-180" />
              <span>Back to Catalog</span>
            </button>
          )}

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer transition">
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span>Import JSON</span>
            <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
          </label>

          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition shadow"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Export JSON</span>
          </button>

          <button
            type="button"
            onClick={handleSimulateRule}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-cyan-950 bg-cyan-400 hover:bg-cyan-300 transition shadow-md shadow-cyan-500/20"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Dry Run Rule</span>
          </button>
        </div>
      </div>

      {/* Main Builder Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Rule Selector & Management (3 cols) */}
        <div className="lg:col-span-3 space-y-4">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Automations</span>
              <button
                type="button"
                onClick={handleAddRule}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/40 transition"
              >
                <Plus className="w-3 h-3" />
                <span>New</span>
              </button>
            </div>

            <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
              {rules.map((rule, idx) => {
                const isSelected = rule.id === activeRule?.id;
                return (
                  <div
                    key={rule.id}
                    onClick={() => setSelectedRuleId(rule.id)}
                    className={`group p-2.5 rounded-xl cursor-pointer border transition text-left flex flex-col gap-1.5 ${
                      isSelected
                        ? 'bg-slate-800 border-cyan-500/80 shadow-md shadow-cyan-950/40 text-white'
                        : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            rule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                        />
                        <span className="text-xs font-semibold truncate">{rule.name || `Rule #${idx + 1}`}</span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleDuplicateRule(rule);
                          }}
                          title="Duplicate rule"
                          className="p-1 hover:text-cyan-300 text-slate-400"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleDeleteRule(rule.id);
                          }}
                          title="Delete rule"
                          className="p-1 hover:text-rose-400 text-slate-400"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
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
                );
              })}
            </div>
          </div>

          {/* Quick Info & ESP32 Firmware Notes */}
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 space-y-2">
            <div className="flex items-center gap-1.5 font-semibold text-slate-300">
              <Info className="w-3.5 h-3.5 text-cyan-400" />
              <span>Firmware Redesign Note</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              As you rewrite the ESP32 firmware, this interface serves as the primary logic orchestrator. The ESP32 simply ingests and executes the generated JSON.
            </p>
          </div>
        </div>

        {/* Middle Column: Active Rule Editor (5 cols) */}
        {activeRule ? (
          <div className="lg:col-span-5 space-y-4">
            {/* Rule Config Header Card */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-4">
              <div className="flex items-center justify-between gap-3">
                <input
                  type="text"
                  value={activeRule.name}
                  onChange={e => handleUpdateActiveRule({ name: e.target.value })}
                  placeholder="Rule Name"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm font-bold text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
                />
                <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                  <span className="text-xs font-semibold text-slate-300">
                    {activeRule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <input
                    type="checkbox"
                    checked={activeRule.enabled}
                    onChange={e => handleUpdateActiveRule({ enabled: e.target.checked })}
                    className="w-4 h-4 rounded text-cyan-500 bg-slate-800 border-slate-700 focus:ring-cyan-400"
                  />
                </label>
              </div>

              {/* Execution Mode & Combining */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Execution Mode</label>
                  <select
                    value={activeRule.exec_mode || 'one_shot'}
                    onChange={e => handleUpdateActiveRule({ exec_mode: e.target.value as ExecutionMode })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="one_shot">one_shot (Edge release)</option>
                    <option value="toggle">toggle (Stateful On/Off)</option>
                    <option value="continuous_hold">continuous_hold (While held)</option>
                    <option value="on_change">on_change (Value change)</option>
                    <option value="poll_verify">poll_verify (Verification loop)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Trigger Combination</label>
                  <select
                    value={activeRule.trigger_mode || 'any'}
                    onChange={e => handleUpdateActiveRule({ trigger_mode: e.target.value as TriggerCombineMode })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="any">ANY (OR - Any trigger fires)</option>
                    <option value="all">ALL (AND - Simultaneous Chord)</option>
                    <option value="sequence">SEQUENCE (Ordered chain)</option>
                  </select>
                </div>
              </div>

              {/* Cooldown, Timeout & Auto-Revert */}
              <div className="grid grid-cols-3 gap-2.5 text-xs">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Cooldown (ms)</label>
                  <input
                    type="number"
                    value={activeRule.cooldown_ms ?? 0}
                    onChange={e => handleUpdateActiveRule({ cooldown_ms: parseInt(e.target.value) || 0 })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Timeout (ms)</label>
                  <input
                    type="number"
                    value={activeRule.timeout_reset_ms ?? 0}
                    onChange={e => handleUpdateActiveRule({ timeout_reset_ms: parseInt(e.target.value) || 0 })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                {activeRule.exec_mode === 'toggle' ? (
                  <div>
                    <label className="block text-slate-400 font-medium mb-1">Auto-Revert (sec)</label>
                    <input
                      type="number"
                      value={activeRule.auto_revert_sec || 0}
                      onChange={e => handleUpdateActiveRule({ auto_revert_sec: parseInt(e.target.value) || 0 })}
                      placeholder="0 = disabled"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-slate-400 font-medium mb-1">HA Integration</label>
                    <div className="flex items-center gap-2 pt-1.5">
                      <input
                        type="checkbox"
                        checked={activeRule.ha_expose}
                        onChange={e => handleUpdateActiveRule({ ha_expose: e.target.checked })}
                        className="w-4 h-4 rounded text-orange-500 bg-slate-800 border-slate-700"
                      />
                      <span className="text-slate-300">Expose Entity</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Home Assistant MDI Icon selector */}
              {activeRule.ha_expose && (
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-orange-950/60 border border-orange-800/60 flex items-center justify-center text-orange-400">
                      <MdiIcon icon={activeRule.ha_icon} className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-slate-300">HA Entity Icon</div>
                      <div className="text-[10px] text-slate-400 font-mono">{activeRule.ha_icon}</div>
                    </div>
                  </div>
                  <select
                    value={activeRule.ha_icon}
                    onChange={e => handleUpdateActiveRule({ ha_icon: e.target.value })}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-slate-200 font-mono text-[11px]"
                  >
                    {SUGGESTED_MDI_ICONS.map(i => (
                      <option key={i.id} value={i.id}>
                        {i.label} ({i.id})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* SECTION 1: TRIGGERS (WHEN...) */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-cyan-500/20 text-cyan-400">
                    <Zap className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    1. Triggers (When...)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTarget('trigger');
                      setCatalogPickerOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Pull Catalog</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const newTrig: AutomationTrigger = {
                        id: `trig_${Date.now().toString(36)}`,
                        source: 'can',
                        can_id: '0x448',
                        bus: 0,
                        click_count: 1,
                        byte_index: 6,
                        from_value: 0,
                        to_value: 1,
                        match: { D7: '0x0' }
                      };
                      handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Raw CAN</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const newTrig: AutomationTrigger = {
                        id: `trig_time_${Date.now().toString(36)}`,
                        source: 'time',
                        type: 'time_schedule',
                        time: '07:30',
                        days: ['mon', 'tue', 'wed', 'thu', 'fri']
                      };
                      handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-slate-800 text-cyan-300 hover:bg-slate-700 transition border border-cyan-900/50"
                  >
                    <Clock className="w-3 h-3" />
                    <span>Time Schedule</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {activeRule.triggers.map((trig, tIdx) => {
                  if (trig.type === 'time_schedule' || trig.source === 'time') {
                    return (
                      <div
                        key={trig.id || tIdx}
                        className="p-3 rounded-xl bg-slate-950 border border-cyan-900/60 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 font-bold text-[10px] flex items-center justify-center border border-cyan-800">
                              T{tIdx + 1}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 text-cyan-400" />
                              <span className="font-semibold text-white">Time Schedule Trigger</span>
                              <span className="px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60 font-mono">
                                {trig.time || '07:30'}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const updated = activeRule.triggers.filter((_, i) => i !== tIdx);
                              handleUpdateActiveRule({ triggers: updated });
                            }}
                            className="p-1 text-slate-500 hover:text-rose-400 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <div>
                          <label className="block text-[10px] font-sans text-slate-400 mb-1">Target Time (24h)</label>
                          <input
                            type="time"
                            value={trig.time || '07:30'}
                            onChange={e => {
                              const updated = [...activeRule.triggers];
                              updated[tIdx] = { ...updated[tIdx], time: e.target.value };
                              handleUpdateActiveRule({ triggers: updated });
                            }}
                            className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500"
                          />
                        </div>

                        <DayOfWeekPicker
                          selectedDays={trig.days}
                          onChange={days => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx] = { ...updated[tIdx], days };
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                        />
                      </div>
                    );
                  }

                  return (
                  <div
                    key={trig.id || tIdx}
                    className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 font-bold text-[10px] flex items-center justify-center border border-cyan-800">
                          T{tIdx + 1}
                        </span>
                        {trig.source_command_name ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-white">{trig.source_command_name}</span>
                            {trig.option_label && (
                              <span className="px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60">
                                {trig.option_label}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="font-semibold text-slate-300 font-mono">
                            CAN Trigger {trig.can_id}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = activeRule.triggers.filter((_, i) => i !== tIdx);
                          handleUpdateActiveRule({ triggers: updated });
                        }}
                        className="p-1 text-slate-500 hover:text-rose-400 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
                        <input
                          type="text"
                          value={trig.can_id || ''}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].can_id = e.target.value;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                          placeholder="0x448"
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">Bus</label>
                        <select
                          value={trig.bus ?? 0}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].bus = parseInt(e.target.value) || 0;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
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
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].click_count = parseInt(e.target.value) || 1;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
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
                          value={typeof trig.match === 'object' ? JSON.stringify(trig.match) : (trig.to_payload || '{"D7":"0x0"}')}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            const compiled = compileToByteMap(e.target.value);
                            updated[tIdx].match = compiled;
                            updated[tIdx].to_payload = compiled;
                            handleUpdateActiveRule({ triggers: updated });
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
                            value={trig.byte || (trig.byte_index !== undefined ? `D${trig.byte_index + 1}` : 'D7')}
                            onChange={e => {
                              const updated = [...activeRule.triggers];
                              updated[tIdx].byte = e.target.value.toUpperCase();
                              const num = parseInt(e.target.value.replace(/\D/g, ''), 10);
                              if (!isNaN(num) && num >= 1 && num <= 8) {
                                updated[tIdx].byte_index = num - 1;
                              }
                              handleUpdateActiveRule({ triggers: updated });
                            }}
                            className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 text-center font-bold"
                            title="1-based Byte (D1..D8)"
                          />
                          <input
                            type="text"
                            placeholder="Mask"
                            value={trig.mask || '0xF0'}
                            onChange={e => {
                              const updated = [...activeRule.triggers];
                              updated[tIdx].mask = e.target.value;
                              handleUpdateActiveRule({ triggers: updated });
                            }}
                            className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-yellow-300 text-center font-bold"
                            title="Byte Bitmask (e.g. 0xF0)"
                          />
                          <input
                            type="text"
                            placeholder="From"
                            value={trig.from || (trig.from_value !== undefined ? `0x${trig.from_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x00')}
                            onChange={e => {
                              const updated = [...activeRule.triggers];
                              updated[tIdx].from = e.target.value;
                              updated[tIdx].from_value = parseInt(e.target.value, 16) || 0;
                              handleUpdateActiveRule({ triggers: updated });
                            }}
                            className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-300 text-center"
                            title="From Value (e.g. 0x00)"
                          />
                          <input
                            type="text"
                            placeholder="To"
                            value={trig.to || (trig.to_value !== undefined ? `0x${trig.to_value.toString(16).padStart(2, '0').toUpperCase()}` : '0x10')}
                            onChange={e => {
                              const updated = [...activeRule.triggers];
                              updated[tIdx].to = e.target.value;
                              updated[tIdx].to_value = parseInt(e.target.value, 16) || 0;
                              handleUpdateActiveRule({ triggers: updated });
                            }}
                            className="w-1/4 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-cyan-300 text-center font-bold"
                            title="To Value (e.g. 0x10)"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            {/* SECTION 2: CONDITIONS (AND IF...) */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
              <div className="flex items-center gap-2">
                <span className="p-1 rounded-lg bg-purple-500/20 text-purple-400">
                  <Shield className="w-3.5 h-3.5" />
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-white">
                  2. Conditions (And if...)
                </span>
              </div>

              <ConditionListEditor
                conditions={activeRule.conditions}
                depth={0}
                emptyText="No conditions set. Rule will always execute when triggers match."
                onUpdate={conds => handleUpdateActiveRule({ conditions: conds })}
                onPullCatalog={() => {
                  setPickerTarget('condition');
                  setCatalogPickerOpen(true);
                }}
              />
            </div>

            {/* SECTION 3: ACTIONS (THEN DO...) */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
              <div className="flex items-center gap-2">
                <span className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400">
                  <Send className="w-3.5 h-3.5" />
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-white">
                  3. Actions (Then do...)
                </span>
              </div>

              <ActionListEditor
                actions={activeRule.actions}
                depth={0}
                emptyText="No actions defined."
                onUpdate={acts => handleUpdateActiveRule({ actions: acts })}
                onPullCatalog={() => {
                  setPickerTarget('action');
                  setCatalogPickerOpen(true);
                }}
              />
            </div>

            {/* SECTION 4: OFF-ACTIONS (Visible only in Toggle mode) */}
            {activeRule.exec_mode === 'toggle' && (
              <div className="p-4 rounded-2xl bg-slate-900 border border-amber-900/40 shadow-lg space-y-3">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-amber-500/20 text-amber-400">
                    <RotateCw className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                    4. Off-Actions (When toggled OFF...)
                  </span>
                </div>

                <ActionListEditor
                  actions={activeRule.off_actions || []}
                  depth={0}
                  emptyText="No off-actions defined. Specify actions to run when toggled off."
                  onUpdate={acts => handleUpdateActiveRule({ off_actions: acts })}
                  onPullCatalog={() => {
                    setPickerTarget('off_action');
                    setCatalogPickerOpen(true);
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="lg:col-span-5 flex items-center justify-center p-12 text-slate-500 text-sm">
            Select or create a rule to start editing.
          </div>
        )}

        {/* Right Column: Live JSON Inspector & Output (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg flex flex-col h-full space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-950 border border-slate-800 text-[11px]">
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('catalog')}
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
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
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
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
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
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
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                    activeJsonTab === 'custom'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Custom Schema
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopyJson}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition border border-slate-700"
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
              <span>
                {activeJsonTab === 'catalog' && 'Full can_do_catalog.json with embedded automations ready for LittleFS flash.'}
                {activeJsonTab === 'cando' && 'Formatted for SuperSuave/wicant-i-automate LittleFS flash.'}
                {activeJsonTab === 'esp32' && 'Flat, numeric enums optimized for lightweight ESP32 C parsing.'}
                {activeJsonTab === 'custom' && 'Sandbox schema for testing your new firmware architecture from scratch.'}
              </span>
            </div>

            {/* Code Output Area */}
            <div className="relative flex-1 min-h-[420px] max-h-[600px] overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
              {activeJsonTab === 'custom' ? (
                <textarea
                  value={customJsonSchema}
                  onChange={e => setCustomJsonSchema(e.target.value)}
                  className="w-full h-full p-3 font-mono text-[11px] text-cyan-300 bg-transparent resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500 leading-relaxed overflow-y-auto"
                  spellCheck={false}
                />
              ) : (
                <pre className="w-full h-full p-3 font-mono text-[11px] text-slate-300 overflow-auto leading-relaxed select-text">
                  <code>
                    {activeJsonTab === 'catalog'
                      ? exportToFullCatalogJson(catalog, rules)
                      : activeJsonTab === 'cando'
                      ? exportToCandoJson(rules, settings)
                      : exportToEsp32FirmwareJson(rules, settings)}
                  </code>
                </pre>
              )}
            </div>

            {/* Quick Export & ESP32 Direct Sync Footer */}
            <div className="pt-3 border-t border-slate-800 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-slate-950/70 border border-slate-800/80">
                <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                  <span className="text-[11px] font-semibold text-slate-400 whitespace-nowrap">ESP32 Device:</span>
                  <input
                    type="text"
                    value={espIp}
                    onChange={e => setEspIp(e.target.value)}
                    placeholder="192.168.4.1"
                    className="flex-1 px-2 py-1 text-xs font-mono rounded bg-slate-900 border border-slate-700 text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handlePullFromEsp}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition disabled:opacity-50"
                  >
                    Pull (/api/automations)
                  </button>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handlePushToEsp}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold transition disabled:opacity-50"
                  >
                    Push &amp; Soft-Reset
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 p-2 rounded-lg bg-slate-950/70 border border-slate-800/80 text-xs">
                <div>
                  <label className="block text-[10px] text-slate-400 font-semibold mb-0.5">NTP Time Server</label>
                  <input
                    type="text"
                    value={settings.ntp_server || 'pool.ntp.org'}
                    onChange={e => onUpdateSettings({ ...settings, ntp_server: e.target.value })}
                    placeholder="pool.ntp.org"
                    className="w-full px-2 py-1 text-xs font-mono rounded bg-slate-900 border border-slate-700 text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 font-semibold mb-0.5">Timezone / POSIX TZ</label>
                  <input
                    type="text"
                    value={settings.timezone || 'America/Los_Angeles'}
                    onChange={e => onUpdateSettings({ ...settings, timezone: e.target.value })}
                    placeholder="America/Los_Angeles or PST8PDT"
                    className="w-full px-2 py-1 text-xs font-mono rounded bg-slate-900 border border-slate-700 text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
              </div>

              {syncStatus && (
                <div className="text-[11px] font-mono text-cyan-400 bg-cyan-950/40 border border-cyan-800/60 rounded px-2.5 py-1">
                  {syncStatus}
                </div>
              )}

              <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
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
        </div>
      </div>

      {/* MODAL: Catalog Command Pull Picker */}
      {catalogPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Pull Command into {pickerTarget.toUpperCase()}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Select a catalog item or state to populate into this rule.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCatalogPickerOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            {/* Search & Filter */}
            <div className="p-3 border-b border-slate-800 bg-slate-950/50 flex flex-wrap gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
                <input
                  type="text"
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  placeholder="Search commands or CAN IDs..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <select
                value={pickerCategory}
                onChange={e => setPickerCategory(e.target.value)}
                className="bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none"
              >
                <option value="all">All Categories</option>
                {categories.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {/* Command List */}
            <div className="p-4 overflow-y-auto space-y-2 flex-1">
              {filteredPickerCommands.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">No commands found.</div>
              ) : (
                filteredPickerCommands.map(cmd => (
                  <div
                    key={cmd.id}
                    className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{cmd.name || cmd.ha_metadata?.name || cmd.id}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 font-mono">
                            {cmd.category}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                          {(cmd.state_can_id || cmd.network?.state_can_id) && (
                            <span>RX: {cmd.state_can_id || cmd.network?.state_can_id}</span>
                          )}
                          {(cmd.action_can_id || cmd.network?.action_can_id) && (
                            <span>TX: {cmd.action_can_id || cmd.network?.action_can_id}</span>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleSelectFromPicker(cmd)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                      >
                        Select Base Command
                      </button>
                    </div>

                    {/* Specific Options/States if available */}
                    {cmd.options && cmd.options.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-900">
                        <span className="text-[10px] text-slate-500 font-medium self-center">Or Pick State:</span>
                        {cmd.options.map((opt, oIdx) => (
                          <button
                            key={oIdx}
                            type="button"
                            onClick={() => handleSelectFromPicker(cmd, opt)}
                            className="text-[10px] px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-800 transition"
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
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
                ✕
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
