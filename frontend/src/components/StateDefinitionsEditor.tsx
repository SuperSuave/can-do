import React, { useState } from 'react';
import { CommandOption } from '../types/catalog';
import { PayloadByteEditor } from './PayloadByteEditor';
import { STATE_PRESETS, StatePreset } from '../data/statePresets';
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
  Car
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
                      <span className="text-base shrink-0 mt-0.5">{preset.icon}</span>
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
                  value={opt.match_payload || (opt.to_payload && !opt.from_payload ? opt.to_payload : '* * * * * * * *')}
                  onChange={val => handleUpdateState(idx, { match_payload: val })}
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
                      {opt.to_payload || (opt.steps && opt.steps.length > 0)
                        ? 'Action Frame (TX) Configured'
                        : '+ Optional Action Transmission (TX) / Trigger Transition'}
                    </span>
                    {(opt.to_payload || (opt.steps && opt.steps.length > 0)) && (
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-800/60">
                        {opt.steps ? `${opt.steps.length} steps` : opt.to_payload}
                      </span>
                    )}
                  </span>
                  <span className="text-slate-500">
                    {expandedActionIndex === idx ? 'Collapse ▲' : 'Configure ▼'}
                  </span>
                </button>

                {expandedActionIndex === idx && (
                  <div className="mt-2 p-3 rounded-[10px] bg-slate-950/70 border border-slate-800/80 space-y-3">
                    <p className="text-[10px] text-slate-400">
                      If this command can also send a CAN message to actuate this state, configure the Action (TX) payload below:
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <PayloadByteEditor
                          label="Action Payload (To Payload / TX)"
                          value={opt.to_payload || opt.payload || '* * * * * * * *'}
                          onChange={val => handleUpdateState(idx, { to_payload: val, payload: val })}
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
                  </div>
                )}
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
                      {opt.match_payload ? (
                        <span className="text-cyan-300 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/50 font-mono text-[11px]">
                          {opt.match_payload}
                        </span>
                      ) : opt.to_payload ? (
                        <span className="text-emerald-300 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50 font-mono text-[11px]">
                          {opt.to_payload}
                        </span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
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
