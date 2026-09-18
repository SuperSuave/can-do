import React, { useState } from 'react';
import { CommandOption, CommandStep } from '../types/catalog';
import { PayloadByteEditor } from './PayloadByteEditor';
import { MdiIcon } from './MdiIcon';
import { STATE_PRESETS, StatePreset } from '../data/statePresets';
import { compileToByteMap } from '../utils/automationConverters';
import { formatPayloadDisplay } from './CommandDetailModal';
import {
  Layers,
  Plus,
  Trash2,
  Sparkles,
  Sliders,
  ChevronDown,
  ChevronUp,
  Info,
  Check,
  ArrowUpDown,
  Copy,
  Car,
  ListOrdered,
  FileText,
  ArrowUp,
  ArrowDown
} from 'lucide-react';

interface StateDefinitionsEditorProps {
  options: CommandOption[];
  stateCanId?: string;
  bus?: number;
  actionCanId?: string;
  knownFeatures: string[];
  onChange: (options: CommandOption[]) => void;
}

export const StateDefinitionsEditor: React.FC<StateDefinitionsEditorProps> = ({
  options = [],
  stateCanId,
  bus = 0,
  actionCanId,
  knownFeatures = [],
  onChange
}) => {
  const [expandedActionIndex, setExpandedActionIndex] = useState<number | null>(null);
  const [showPresetsDropdown, setShowPresetsDropdown] = useState(false);
  const [previewActiveByteIndex, setPreviewActiveByteIndex] = useState<number | null>(null);
  const [actionTabMap, setActionTabMap] = useState<Record<number, 'single' | 'steps'>>({});
  const [pastingOptIdx, setPastingOptIdx] = useState<number | null>(null);
  const [pasteStepText, setPasteStepText] = useState('');

  // Step sequence parser for raw multi-step paste
  const parseStepSequenceText = (text: string): CommandStep[] => {
    if (!text || text.trim() === '') return [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const steps: CommandStep[] = [];

    for (const line of lines) {
      let repeat = 1;
      const parenMatch = line.match(/\((\d+)\s*(?:times|x)?\)/i);
      const endXMatch = line.match(/(?:x|\*)\s*(\d+)\s*$/i);
      if (parenMatch) {
        repeat = parseInt(parenMatch[1], 10) || 1;
      } else if (endXMatch) {
        repeat = parseInt(endXMatch[1], 10) || 1;
      }

      const cleanLine = line.replace(/\([^)]*\)/g, '').replace(/(?:x|\*)\s*\d+\s*$/i, '');
      const rawTokens = cleanLine
        .replace(/[,;:]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(t => /^(?:0x)?[0-9A-Fa-f]{1,2}$|^\*$|^![0-9A-Fa-f]{2}$/.test(t));

      if (rawTokens.length > 0) {
        const paddedTokens = [...rawTokens];
        while (paddedTokens.length < 8) {
          paddedTokens.push('*');
        }
        const normalizedTokens = paddedTokens.slice(0, 8).map(t => {
          if (t === '*' || t.startsWith('!')) return t;
          const hex = t.replace(/^0x/i, '');
          return hex.length === 1 ? '0' + hex.toUpperCase() : hex.toUpperCase();
        });

        const byteMap: Record<string, string> = {};
        normalizedTokens.forEach((t, i) => {
          byteMap[`D${i + 1}`] = t === '*' ? '*' : `0x${t}`;
        });

        steps.push({
          payload: byteMap,
          repeat
        });
      }
    }
    return steps;
  };

  const handleAddOptionStep = (optIdx: number) => {
    const opt = options[optIdx];
    const curSteps = opt.steps || [];
    const newStep: CommandStep = {
      payload: '* * * * * * * *',
      repeat: 1
    };
    handleUpdateState(optIdx, { steps: [...curSteps, newStep] });
  };

  const handleUpdateOptionStep = (optIdx: number, stepIdx: number, updated: Partial<CommandStep>) => {
    const opt = options[optIdx];
    const curSteps = [...(opt.steps || [])];
    if (!curSteps[stepIdx]) return;
    curSteps[stepIdx] = { ...curSteps[stepIdx], ...updated };
    handleUpdateState(optIdx, { steps: curSteps });
  };

  const handleRemoveOptionStep = (optIdx: number, stepIdx: number) => {
    const opt = options[optIdx];
    const curSteps = (opt.steps || []).filter((_, i) => i !== stepIdx);
    handleUpdateState(optIdx, { steps: curSteps.length > 0 ? curSteps : undefined });
  };

  const handleMoveOptionStep = (optIdx: number, fromIdx: number, toIdx: number) => {
    const opt = options[optIdx];
    const curSteps = [...(opt.steps || [])];
    if (toIdx < 0 || toIdx >= curSteps.length) return;
    const [moved] = curSteps.splice(fromIdx, 1);
    curSteps.splice(toIdx, 0, moved);
    handleUpdateState(optIdx, { steps: curSteps });
  };

  const handleDuplicateOptionStep = (optIdx: number, stepIdx: number) => {
    const opt = options[optIdx];
    const curSteps = [...(opt.steps || [])];
    if (!curSteps[stepIdx]) return;
    const dup = { ...curSteps[stepIdx] };
    curSteps.splice(stepIdx + 1, 0, dup);
    handleUpdateState(optIdx, { steps: curSteps });
  };

  const handleApplyPastedSteps = (optIdx: number) => {
    const parsed = parseStepSequenceText(pasteStepText);
    if (parsed.length > 0) {
      handleUpdateState(optIdx, { steps: parsed });
      setPastingOptIdx(null);
      setPasteStepText('');
    }
  };

  const handleAddState = () => {
    const nextIdx = options.length + 1;
    const newState: CommandOption = {
      label: `State ${nextIdx}`,
      state_value: `${nextIdx - 1}`,
      match_payload: '* * * * * * * *',
      default: options.length === 0
    };
    onChange([...options, newState]);
  };

  const handleUpdateState = (index: number, updated: Partial<CommandOption>) => {
    const next = [...options];
    next[index] = { ...next[index], ...updated };
    if (updated.default) {
      next.forEach((opt, idx) => {
        if (idx !== index) opt.default = false;
      });
    }
    onChange(next);
  };

  const handleRemoveState = (index: number) => {
    const next = options.filter((_, idx) => idx !== index);
    if (next.length > 0 && !next.some(o => o.default)) {
      next[0].default = true;
    }
    onChange(next);
  };

  const handleDuplicateState = (index: number) => {
    const src = options[index];
    const duplicated: CommandOption = {
      ...src,
      label: `${src.label} (Copy)`,
      default: false
    };
    const next = [...options];
    next.splice(index + 1, 0, duplicated);
    onChange(next);
  };

  const handleMoveState = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= options.length) return;
    const next = [...options];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onChange(next);
  };

  const handleApplyPreset = (preset: StatePreset) => {
    onChange(preset.options);
    setShowPresetsDropdown(false);
  };

  return (
    <div className="p-4 sm:p-5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-5">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--border-color)]/70">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-cyan-950/80 border border-cyan-800/80 flex items-center justify-center text-cyan-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>State Definitions</span>
                <span className="text-cyan-400 font-mono text-xs font-semibold">
                  ({stateCanId || 'RX CAN ID'}{bus !== undefined ? ` • Bus ${bus}` : ''})
                </span>
                <span className="text-slate-400 text-xs font-normal">
                  — "What state is what"
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Map human-readable states (e.g. Park, Drive, Open, Closed, Heated Level) to CAN byte patterns.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Quick Presets Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowPresetsDropdown(!showPresetsDropdown)}
              className="px-3 py-1.5 rounded-[8px] bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
              title="Load vehicle state template preset"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Load Template Preset</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPresetsDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showPresetsDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-72 sm:w-80 rounded-[12px] bg-slate-900 border border-slate-700 shadow-2xl p-2 z-50 space-y-1">
                <div className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-800">
                  Select a State Template Preset
                </div>
                <div className="max-h-72 overflow-y-auto space-y-1 py-1">
                  {STATE_PRESETS.map(preset => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleApplyPreset(preset)}
                      className="w-full text-left p-2 rounded-lg hover:bg-slate-800 transition flex items-start gap-2.5 group"
                    >
                      <MdiIcon icon={preset.icon} className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-white group-hover:text-cyan-300 transition flex items-center justify-between">
                          <span>{preset.name}</span>
                          <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950 px-1.5 py-0.2 rounded border border-cyan-800/60">
                            {preset.options.length} states
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                          {preset.description}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="p-1.5 text-[10px] text-slate-500 border-t border-slate-800 text-center">
                  Applies pre-configured states matching E-GMP / CAN-Do catalog standards.
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleAddState}
            className="px-3 py-1.5 rounded-[8px] bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add State</span>
          </button>
        </div>
      </div>

      {/* State List */}
      {options.length === 0 ? (
        <div className="p-8 text-center border-2 border-dashed border-slate-800 rounded-[12px] bg-slate-950/40 space-y-3">
          <Layers className="w-8 h-8 text-slate-600 mx-auto" />
          <div>
            <p className="text-sm font-semibold text-slate-300">
              No states defined yet for this CAN ID
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Define "what state is what" so CAN-Do can decode live messages or trigger automations when specific states occur.
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleAddState}
              className="px-3 py-1.5 rounded-lg bg-[var(--md-sys-color-primary)] text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Blank State
            </button>
            <button
              type="button"
              onClick={() => handleApplyPreset(STATE_PRESETS[0])}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Load Gear Shifter Preset
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {options.map((opt, idx) => (
            <div
              key={idx}
              className={`p-4 rounded-[12px] bg-[var(--input-bg)] border transition-all ${
                opt.default
                  ? 'border-cyan-700/60 shadow-md shadow-cyan-950/20'
                  : 'border-[var(--border-color)]'
              } space-y-3.5`}
            >
              {/* State Header Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-[var(--border-color)]/60">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-mono font-bold text-cyan-400 shrink-0">
                    {idx + 1}
                  </span>
                  <span className="text-xs font-bold text-white tracking-tight truncate">
                    {opt.label || `State #${idx + 1}`}
                  </span>
                  {opt.state_value !== undefined && opt.state_value !== '' && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700 shrink-0">
                      Code: {opt.state_value}
                    </span>
                  )}
                  {opt.default && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-700 shrink-0">
                      Default
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Default Radio */}
                  <label
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-xs cursor-pointer border transition ${
                      opt.default
                        ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700 font-semibold'
                        : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                    title="Set this state as default/initial"
                  >
                    <input
                      type="radio"
                      name="default_state_radio"
                      checked={!!opt.default}
                      onChange={() => handleUpdateState(idx, { default: true })}
                      className="accent-[var(--md-sys-color-primary)]"
                    />
                    <span>Default</span>
                  </label>

                  {/* Reorder Buttons */}
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => handleMoveState(idx, idx - 1)}
                    className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-800 transition"
                    title="Move state up"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === options.length - 1}
                    onClick={() => handleMoveState(idx, idx + 1)}
                    className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-800 transition"
                    title="Move state down"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>

                  {/* Duplicate */}
                  <button
                    type="button"
                    onClick={() => handleDuplicateState(idx)}
                    className="p-1 text-slate-400 hover:text-cyan-300 rounded hover:bg-slate-800 transition"
                    title="Duplicate state"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>

                  {/* Delete */}
                  <button
                    type="button"
                    onClick={() => handleRemoveState(idx)}
                    className="p-1 text-slate-400 hover:text-rose-400 rounded hover:bg-rose-950/40 transition"
                    title="Delete state"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* State Identity Inputs */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-5">
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    State Name / Meaning <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Park (P), Drive (D), Driver Door Open, High Heat"
                    value={opt.label}
                    onChange={e => handleUpdateState(idx, { label: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--card-bg)] border border-[var(--border-color)] text-white font-medium text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1 flex items-center justify-between">
                    <span>Value / Code</span>
                    <span className="text-[10px] font-normal text-slate-500">Hex or Number</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 0x00, 0x05, 1, 0"
                    value={opt.state_value ?? ''}
                    onChange={e => handleUpdateState(idx, { state_value: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--card-bg)] border border-[var(--border-color)] font-mono text-cyan-300 text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="sm:col-span-4">
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Requires Feature (Optional)
                  </label>
                  <select
                    value={opt.requires_feature || ''}
                    onChange={e => handleUpdateState(idx, { requires_feature: e.target.value || undefined })}
                    className="w-full px-2.5 py-1.5 rounded-[8px] bg-[var(--card-bg)] border border-[var(--border-color)] text-xs text-slate-300 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="">None (Always available)</option>
                    {knownFeatures.map(feat => (
                      <option key={feat} value={feat}>
                        {feat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* State Description & Toast */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    State Description (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Vehicle transmission locked in Park"
                    value={opt.description || ''}
                    onChange={e => handleUpdateState(idx, { description: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--card-bg)] border border-[var(--border-color)] text-slate-300 text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Cluster OSD Toast / Message (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Transmission: Park"
                    value={opt.popup || ''}
                    onChange={e => handleUpdateState(idx, { popup: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--card-bg)] border border-[var(--border-color)] text-slate-300 text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>

              {/* CAN RX Match Payload Editor (The core mapping) */}
              <div className="pt-2 border-t border-[var(--border-color)]/60">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">
                      RX CAN Match Pattern for this State:
                    </span>
                    <span className="text-[10px] text-slate-400">
                      (Bytes received on {stateCanId || 'Rx CAN ID'} when in this state)
                    </span>
                  </div>
                </div>

                <PayloadByteEditor
                  label=""
                  value={opt.match || opt.match_payload || (opt.to_payload && !opt.from_payload ? (opt.to_payload || opt.payload) : '* * * * * * * *')}
                  onChange={val => handleUpdateState(idx, { match_payload: val, match: compileToByteMap(val) })}
                />
              </div>

              {/* Action Transmission (TX) / Transition Steps (Optional) */}
              <div className="pt-2 border-t border-[var(--border-color)]/50">
                <button
                  type="button"
                  onClick={() => setExpandedActionIndex(expandedActionIndex === idx ? null : idx)}
                  className="flex items-center justify-between w-full text-left text-[11px] text-slate-400 hover:text-slate-200 transition py-1"
                >
                  <span className="flex items-center gap-1.5">
                    <Sliders className="w-3 h-3 text-emerald-400" />
                    <span>
                      {opt.to_payload || opt.payload || (opt.steps && opt.steps.length > 0)
                        ? 'Action Frame (TX) Configured'
                        : '+ Optional Action Transmission (TX) / Trigger Transition'}
                    </span>
                    {(opt.to_payload || opt.payload || (opt.steps && opt.steps.length > 0)) && (
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-800/60">
                        {opt.steps ? `${opt.steps.length} steps` : formatPayloadDisplay(opt.to_payload || opt.payload)}
                      </span>
                    )}
                  </span>
                  <span className="text-slate-500">
                    {expandedActionIndex === idx ? 'Collapse ▲' : 'Configure ▼'}
                  </span>
                </button>

                {expandedActionIndex === idx && (() => {
                  const hasSteps = opt.steps && opt.steps.length > 0;
                  const currentMode = actionTabMap[idx] || (hasSteps ? 'steps' : 'single');

                  return (
                    <div className="mt-2 p-3 sm:p-4 rounded-[10px] bg-slate-950/80 border border-slate-800/90 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-800/70">
                        <div>
                          <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                            <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                            Action Transmission (TX) / Transition Configuration
                          </span>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            Configure CAN frame(s) transmitted to trigger or simulate this button / state.
                          </p>
                        </div>

                        {/* Mode Selector Pill */}
                        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] self-start sm:self-auto shrink-0">
                          <button
                            type="button"
                            onClick={() => setActionTabMap(prev => ({ ...prev, [idx]: 'single' }))}
                            className={`px-2.5 py-1 rounded-md font-medium transition ${
                              currentMode === 'single'
                                ? 'bg-slate-800 text-white shadow-sm'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            Single Frame
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActionTabMap(prev => ({ ...prev, [idx]: 'steps' }));
                              if (!opt.steps || opt.steps.length === 0) {
                                const initialPayload = opt.to_payload || opt.payload || '* * * * * * * *';
                                handleUpdateState(idx, {
                                  steps: [{ payload: initialPayload, repeat: opt.repeat || 1 }]
                                });
                              }
                            }}
                            className={`px-2.5 py-1 rounded-md font-medium flex items-center gap-1.5 transition ${
                              currentMode === 'steps'
                                ? 'bg-emerald-950/80 border border-emerald-800/60 text-emerald-300 font-semibold shadow-sm'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <ListOrdered className="w-3 h-3 text-emerald-400" />
                            <span>Multi-Step Sequence</span>
                            {opt.steps && opt.steps.length > 0 && (
                              <span className="text-[10px] font-mono px-1 rounded bg-emerald-900 text-emerald-200">
                                {opt.steps.length}
                              </span>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Single Frame Mode */}
                      {currentMode === 'single' && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <PayloadByteEditor
                                label="Action Payload (To Payload / TX)"
                                value={opt.to_payload || opt.payload || '* * * * * * * *'}
                                onChange={val => handleUpdateState(idx, { to_payload: val, payload: compileToByteMap(val) })}
                              />
                            </div>

                            <div className="space-y-2">
                              <PayloadByteEditor
                                label="Trigger Condition (From Payload, optional)"
                                value={opt.from_payload || '* * * * * * * *'}
                                onChange={val => handleUpdateState(idx, { from_payload: val })}
                              />

                              <div className="flex items-center justify-between gap-2 p-2 rounded bg-slate-900 border border-slate-800 text-xs">
                                <span className="text-slate-300 font-medium text-[11px]">Action Repeat Count:</span>
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number"
                                    min="1"
                                    max="50"
                                    value={opt.repeat || 1}
                                    onChange={e => handleUpdateState(idx, { repeat: parseInt(e.target.value) || 1 })}
                                    className="w-16 px-2 py-0.5 rounded bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-amber-300 text-center font-bold"
                                  />
                                  <span className="text-[11px] text-slate-400">times</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[10px] text-slate-500">
                              For buttons requiring multi-frame pulses or setup sequences (e.g. EV6 setup), switch to Multi-Step Sequence.
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setActionTabMap(prev => ({ ...prev, [idx]: 'steps' }));
                                const initialPayload = opt.to_payload || opt.payload || '* * * * * * * *';
                                handleUpdateState(idx, {
                                  steps: [{ payload: initialPayload, repeat: opt.repeat || 1 }]
                                });
                              }}
                              className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium transition"
                            >
                              <ListOrdered className="w-3.5 h-3.5" /> Convert to Multi-Step Sequence →
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Multi-Step Sequence Mode */}
                      {currentMode === 'steps' && (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/60 p-2 rounded-lg border border-slate-800 text-xs">
                            <span className="text-[11px] text-slate-300 flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                              <span>Frames will be transmitted sequentially in this exact order:</span>
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setPastingOptIdx(pastingOptIdx === idx ? null : idx);
                                  setPasteStepText('');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] font-medium transition border border-slate-700"
                              >
                                <FileText className="w-3 h-3" />
                                {pastingOptIdx === idx ? 'Close Paste' : 'Paste Step Sequence'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleAddOptionStep(idx)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-semibold transition shadow-sm"
                              >
                                <Plus className="w-3 h-3" />
                                Add Step
                              </button>
                            </div>
                          </div>

                          {/* Paste Box */}
                          {pastingOptIdx === idx && (
                            <div className="p-3 rounded-lg bg-slate-900 border border-cyan-800/80 space-y-2">
                              <div className="flex items-center justify-between text-xs">
                                <span className="font-semibold text-cyan-300 flex items-center gap-1.5">
                                  <FileText className="w-3.5 h-3.5" /> Paste Raw Step Sequence (Hex & Repeats)
                                </span>
                                <span className="text-[10px] text-slate-400">e.g. FF,F1,FF,FF,FF,FF,FF,FF, (3 times)</span>
                              </div>
                              <textarea
                                rows={4}
                                value={pasteStepText}
                                onChange={e => setPasteStepText(e.target.value)}
                                placeholder="Paste lines like:&#10;FF,F1,FF,FF,FF,FF,FF,FF, (3 times)&#10;FF,FF,FF,FF,FF,FF,FF,FF&#10;FF,F0,FF,FF,FF,FF,FF,FF, (3 times)&#10;FF,FF,FF,FF,FF,FF,FF,FF"
                                className="w-full font-mono text-xs p-2 rounded bg-black/60 border border-slate-700 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
                              />
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-[10px] text-slate-400">
                                  Auto-detects comma/space separated bytes and (N times) repeats.
                                </span>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setPastingOptIdx(null)}
                                    className="px-2.5 py-1 text-slate-400 hover:text-white transition text-xs"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={!pasteStepText.trim()}
                                    onClick={() => handleApplyPastedSteps(idx)}
                                    className="px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold transition text-xs"
                                  >
                                    Parse & Apply Steps
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* List of Steps */}
                          {(!opt.steps || opt.steps.length === 0) ? (
                            <div className="text-center py-6 px-3 rounded-lg border border-dashed border-slate-800 bg-slate-900/30 text-xs text-slate-400">
                              <p>No sequence steps defined yet.</p>
                              <button
                                type="button"
                                onClick={() => handleAddOptionStep(idx)}
                                className="mt-2 inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-semibold"
                              >
                                <Plus className="w-3 h-3" /> Add First Step
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-2.5">
                              {opt.steps.map((step, sIdx) => (
                                <div
                                  key={sIdx}
                                  className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 space-y-2"
                                >
                                  <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                                    <div className="flex items-center gap-2">
                                      <span className="w-5 h-5 rounded-full bg-emerald-950 border border-emerald-700/80 text-emerald-300 text-[10px] font-mono font-bold flex items-center justify-center shrink-0">
                                        {sIdx + 1}
                                      </span>
                                      <span className="font-semibold text-slate-200">
                                        Frame Step #{sIdx + 1}
                                      </span>
                                      {step.repeat && step.repeat > 1 && (
                                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-300 border border-amber-800/60 font-bold">
                                          Repeated {step.repeat}x
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-2">
                                      <div className="flex items-center gap-1">
                                        <span className="text-[11px] text-slate-400">Repeat:</span>
                                        <input
                                          type="number"
                                          min="1"
                                          max="50"
                                          value={step.repeat || 1}
                                          onChange={e =>
                                            handleUpdateOptionStep(idx, sIdx, { repeat: parseInt(e.target.value) || 1 })
                                          }
                                          className="w-14 px-1.5 py-0.5 rounded bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-amber-300 text-center font-bold"
                                        />
                                        <span className="text-[10px] text-slate-400">times</span>
                                      </div>

                                      <div className="h-4 w-[1px] bg-slate-800 mx-0.5"></div>

                                      {/* Reorder Buttons */}
                                      <button
                                        type="button"
                                        disabled={sIdx === 0}
                                        onClick={() => handleMoveOptionStep(idx, sIdx, sIdx - 1)}
                                        title="Move step up"
                                        className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-800 transition"
                                      >
                                        <ArrowUp className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        disabled={sIdx === (opt.steps?.length || 1) - 1}
                                        onClick={() => handleMoveOptionStep(idx, sIdx, sIdx + 1)}
                                        title="Move step down"
                                        className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-800 transition"
                                      >
                                        <ArrowDown className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDuplicateOptionStep(idx, sIdx)}
                                        title="Duplicate step"
                                        className="p-1 text-slate-400 hover:text-cyan-300 rounded hover:bg-slate-800 transition"
                                      >
                                        <Copy className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveOptionStep(idx, sIdx)}
                                        title="Remove step"
                                        className="p-1 text-slate-400 hover:text-rose-400 rounded hover:bg-slate-800 transition"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </div>

                                  <PayloadByteEditor
                                    label=""
                                    value={step.payload || '* * * * * * * *'}
                                    onChange={val =>
                                      handleUpdateOptionStep(idx, sIdx, {
                                        payload: compileToByteMap(val)
                                      })
                                    }
                                  />
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Footer Actions */}
                          <div className="flex items-center justify-between pt-1 text-xs">
                            <button
                              type="button"
                              onClick={() => handleAddOptionStep(idx)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-800/70 font-medium transition"
                            >
                              <Plus className="w-3.5 h-3.5" /> Add Next Step
                            </button>

                            {opt.steps && opt.steps.length > 0 && (
                              <button
                                type="button"
                                onClick={() => handleUpdateState(idx, { steps: undefined })}
                                className="text-slate-500 hover:text-rose-400 transition text-[11px]"
                              >
                                Revert to Single Frame (Remove Steps)
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Decoded State Matrix Summary Table */}
      {options.length > 0 && (
        <div className="pt-4 border-t border-[var(--border-color)]/70 space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-cyan-400" />
              <span>Decoded State Matrix ({options.length} Mapped States)</span>
            </h4>
            <span className="text-[11px] text-slate-400">
              RX CAN ID: <span className="font-mono text-cyan-300 font-semibold">{stateCanId || '0x???'}</span>
            </span>
          </div>

          <div className="overflow-x-auto rounded-[10px] border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[11px]">
                <tr>
                  <th className="p-2.5">#</th>
                  <th className="p-2.5">State Name</th>
                  <th className="p-2.5">Code</th>
                  <th className="p-2.5">RX CAN Match Pattern</th>
                  <th className="p-2.5">Description</th>
                  <th className="p-2.5 text-right">Default</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 font-mono bg-slate-950/40">
                {options.map((opt, i) => (
                  <tr key={i} className="hover:bg-slate-900/60 transition">
                    <td className="p-2.5 text-slate-500 font-bold">{i + 1}</td>
                    <td className="p-2.5 font-sans font-semibold text-white">
                      {opt.label}
                    </td>
                    <td className="p-2.5 text-cyan-300">
                      {opt.state_value !== undefined && opt.state_value !== '' ? (
                        <span className="bg-cyan-950/60 border border-cyan-800/60 px-1.5 py-0.5 rounded text-[11px]">
                          {opt.state_value}
                        </span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                    <td className="p-2.5">
                      <div className="flex flex-col gap-1">
                        {opt.match || opt.match_payload ? (
                          <span className="text-cyan-300 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/50 font-mono text-[11px] inline-block w-fit">
                            RX: {formatPayloadDisplay(opt.match || opt.match_payload)}
                          </span>
                        ) : null}
                        {opt.steps && opt.steps.length > 0 ? (
                          <span className="text-emerald-300 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50 font-mono text-[11px] inline-block w-fit">
                            TX: {opt.steps.length} sequential steps ({opt.steps.map(s => `x${s.repeat || 1}`).join(', ')})
                          </span>
                        ) : (opt.to_payload || opt.payload) ? (
                          <span className="text-emerald-300 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50 font-mono text-[11px] inline-block w-fit">
                            TX: {formatPayloadDisplay(opt.to_payload || opt.payload)} {opt.repeat && opt.repeat > 1 ? `x${opt.repeat}` : ''}
                          </span>
                        ) : null}
                        {!opt.match && !opt.match_payload && !opt.steps && !opt.to_payload && !opt.payload && (
                          <span className="text-slate-600">-</span>
                        )}
                      </div>
                    </td>
                    <td className="p-2.5 font-sans text-slate-400 max-w-xs truncate">
                      {opt.description || opt.popup || '-'}
                    </td>
                    <td className="p-2.5 text-right">
                      {opt.default ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase bg-cyan-950 text-cyan-300 border border-cyan-700">
                          Default
                        </span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
