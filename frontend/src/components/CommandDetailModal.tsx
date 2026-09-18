import React, { useState } from 'react';
import { Command, CommandRole, CommandOption, Catalog, getCommandContributors } from '../types/catalog';
import { PayloadByteVisualizer } from './PayloadByteVisualizer';
import { validateCommand } from '../utils/canValidator';
import { exportCommandToDbcSnippet } from '../utils/dbcConverter';
import { formatCommandAsCanCapture } from '../utils/canCaptureParser';
import { MdiIcon, getHaDomainBadgeStyle } from './MdiIcon';
import {
  X,
  Copy,
  Check,
  Edit3,
  Car,
  AlertTriangle,
  Info,
  Layers,
  Code2,
  Cpu,
  Trash2,
  Github,
  User,
  ExternalLink,
  FileCode,
  FileText,
  Home,
  Sparkles,
  Zap,
  Play,
  Radio
} from 'lucide-react';

interface CommandDetailModalProps {
  command: Command | null;
  catalog: Catalog;
  onClose: () => void;
  onEdit: (cmd: Command) => void;
  onDelete?: (cmdId: string) => void;
  onAddToAutomation?: (cmd: Command, role?: CommandRole, option?: CommandOption) => void;
}

export const formatPayloadDisplay = (val: any): string => {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return `0x${val.toString(16).toUpperCase()}`;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'object') {
    if (val.byte && val.operator) {
      const op = val.operator === 'greater_than' ? '>' : val.operator === 'less_than' ? '<' : val.operator === 'equals' ? '==' : val.operator;
      return `${val.byte} ${op} ${val.value ?? ''}`;
    }
    const entries = Object.entries(val);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => `${k}:${v}`).join(' ');
  }
  return String(val);
};

export const CommandDetailModal: React.FC<CommandDetailModalProps> = ({
  command,
  catalog,
  onClose,
  onEdit,
  onDelete,
  onAddToAutomation
}) => {
  const [copied, setCopied] = useState(false);
  const [copiedDbc, setCopiedDbc] = useState(false);
  const [copiedCapture, setCopiedCapture] = useState(false);
  const [copiedHaYaml, setCopiedHaYaml] = useState(false);
  const [copiedIcon, setCopiedIcon] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'vehicles' | 'cancapture' | 'homeassistant' | 'raw_json' | 'dbc'>('overview');
  const [selectedOptionIdx, setSelectedOptionIdx] = useState<number>(0);

  if (!command) return null;

  const commandName = command.name || command.ha_metadata?.name || command.id || 'Unnamed Command';
  const dbcSnippet = exportCommandToDbcSnippet(command);

  const haYamlSnippet = (() => {
    const domain = command.ha_domain || 'sensor';
    const iconStr = command.icon || command.mdi || 'mdi:car-info';
    const rxCan = command.state_can_id || command.can_id;
    const txCan = command.action_can_id;
    const lines: string[] = [
      `# Home Assistant Entity Configuration for CAN-Do`,
      `# Domain: ${domain}`,
      `${domain}:`,
      `  - platform: can_do`,
      `    name: "${commandName}"`,
      `    unique_id: "can_do_${command.id}"`,
      `    icon: "${iconStr}"`
    ];
    if (command.device_class) {
      lines.push(`    device_class: "${command.device_class}"`);
    }
    if (rxCan) {
      lines.push(`    can_id: "${rxCan}"`);
      lines.push(`    bus: ${command.bus ?? 0}`);
    }
    if (txCan) {
      lines.push(`    action_can_id: "${txCan}"`);
      lines.push(`    action_bus: ${command.action_bus ?? command.bus ?? 0}`);
    }
    if (command.from_payload) lines.push(`    from_payload: "${formatPayloadDisplay(command.from_payload)}"`);
    if (command.to_payload) lines.push(`    to_payload: "${formatPayloadDisplay(command.to_payload)}"`);
    if (command.match_payload) lines.push(`    match_payload: "${formatPayloadDisplay(command.match_payload)}"`);
    if (command.payload_mask) lines.push(`    payload_mask: "${command.payload_mask}"`);
    if (command.requires_feature) lines.push(`    requires_feature: "${command.requires_feature}"`);
    if (command.options && command.options.length > 0) {
      lines.push(`    options:`);
      command.options.forEach(o => {
        lines.push(`      - label: "${o.label}"`);
        if (o.popup_message) lines.push(`        popup_message: "${o.popup_message}"`);
        if (o.popup_message_imperial) lines.push(`        popup_message_imperial: "${o.popup_message_imperial}"`);
        if (o.payload) lines.push(`        payload: "${formatPayloadDisplay(o.payload)}"`);
        if (o.to_payload) lines.push(`        to_payload: "${formatPayloadDisplay(o.to_payload)}"`);
        if (o.match_payload || o.match) lines.push(`        match_payload: "${formatPayloadDisplay(o.match_payload || o.match)}"`);
        if (o.default) lines.push(`        default: true`);
      });
    }

    if (domain === 'notify' || command.type === 'popup') {
      lines.push('');
      lines.push('# Example Home Assistant Automation / Action Call:');
      lines.push('# action: notify.send_message');
      lines.push('# target:');
      lines.push(`#   entity_id: notify.can_do_${command.id}`);
      lines.push('# data:');
      const sampleMsg = command.options?.find(o => o.popup_message)?.popup_message || command.popup_message || 'Vehicle Alert Toast';
      lines.push(`#   message: "${sampleMsg}"`);
    }

    return lines.join('\n');
  })();

  const issues = validateCommand(command, catalog, false);
  const hasErrors = issues.some(i => i.type === 'error');
  const hasWarnings = issues.some(i => i.type === 'warning');

  // Check vehicle compatibility
  const compatibleVehicles = catalog.vehicles.filter(v => {
    if (command.requires_feature && !v.features.includes(command.requires_feature)) {
      return false;
    }
    if (command.tags && command.tags.length > 0) {
      const matchesAnyTag = command.tags.some(
        tag =>
          v.id.includes(tag) ||
          v.family.includes(tag) ||
          v.model.toLowerCase().replace(/\s+/g, '_').includes(tag)
      );
      if (!matchesAnyTag) return false;
    }
    return true;
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(command, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-3xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div className="pr-6">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {command.roles.map(r => (
                <span
                  key={r}
                  className={`can-do-ha-pill ${
                    r === 'trigger' ? 'trig-pill' : r === 'condition' ? 'cond-pill' : 'act-pill'
                  }`}
                >
                  {r}
                </span>
              ))}
              {(command.state_can_id || command.can_id) && (
                <span className="font-mono text-xs px-2.5 py-0.5 rounded-[6px] bg-[var(--input-bg)] text-cyan-400 border border-[var(--border-color)]">
                  {command.action_can_id ? `Rx: ${command.state_can_id || command.can_id}` : (command.state_can_id || command.can_id)} • Bus {command.bus ?? 0}
                </span>
              )}
              {command.action_can_id && (
                <span className="font-mono text-xs px-2.5 py-0.5 rounded-[6px] bg-[var(--input-bg)] text-emerald-400 border border-emerald-900/50">
                  Tx: {command.action_can_id} • Bus {command.action_bus ?? command.bus ?? 0}
                </span>
              )}
              {command.type && (
                <span className="text-xs font-mono px-2.5 py-0.5 rounded-[6px] bg-[var(--input-bg)] text-slate-300 border border-[var(--border-color)]">
                  Type: {command.type}
                </span>
              )}
              {command.ha_domain && (() => {
                const domainStyle = getHaDomainBadgeStyle(command.ha_domain);
                return (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[6px] text-xs font-mono font-semibold border ${domainStyle.bg} ${domainStyle.text} ${domainStyle.border}`}
                    title={`Home Assistant Domain: ${command.ha_domain}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${domainStyle.dot}`} />
                    HA: {command.ha_domain}
                  </span>
                );
              })()}
              {(command.ha_metadata?.icon || command.icon || command.mdi) && (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[6px] text-xs font-mono font-medium bg-sky-950/70 text-sky-300 border border-sky-800/60"
                  title={`MDI Icon: ${command.ha_metadata?.icon || command.icon || command.mdi}`}
                >
                  <MdiIcon icon={command.ha_metadata?.icon || command.icon || command.mdi} className="w-3.5 h-3.5 text-sky-400" />
                  {command.ha_metadata?.icon || command.icon || command.mdi}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {(command.ha_metadata?.icon || command.icon || command.mdi) && (
                <div className="w-9 h-9 rounded-xl bg-sky-950/70 border border-sky-800/70 flex items-center justify-center text-sky-300 shrink-0 shadow-sm">
                  <MdiIcon icon={command.ha_metadata?.icon || command.icon || command.mdi} className="w-5 h-5" />
                </div>
              )}
              <h2 className="text-xl md:text-2xl font-bold text-white tracking-tight">
                {commandName}
              </h2>
            </div>
            <p className="text-xs font-mono text-[var(--text-muted)] mt-1 flex items-center gap-1.5 flex-wrap">
              <span>ID: <span className="text-slate-200">{command.id}</span></span>
              <span>•</span>
              <span>Category: <span className="text-cyan-400 font-sans">{command.category}</span></span>
              {command.subcategory && (
                <>
                  <span>•</span>
                  <span>Subsystem: <span className="text-cyan-300 font-sans font-semibold bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/60">{command.subcategory}</span></span>
                </>
              )}
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-[var(--text-muted)] hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-2 px-6 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-lowest)] text-sm">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-3 px-3 font-medium border-b-2 transition ${
              activeTab === 'overview'
                ? 'border-[var(--md-sys-color-primary)] text-cyan-400 font-bold'
                : 'border-transparent text-[var(--text-muted)] hover:text-slate-200'
            }`}
          >
            <Cpu className="w-4 h-4 inline-block mr-1.5" />
            CAN Parameters
          </button>
          <button
            onClick={() => setActiveTab('vehicles')}
            className={`py-3 px-3 font-medium border-b-2 transition ${
              activeTab === 'vehicles'
                ? 'border-[var(--md-sys-color-primary)] text-cyan-400 font-bold'
                : 'border-transparent text-[var(--text-muted)] hover:text-slate-200'
            }`}
          >
            <Car className="w-4 h-4 inline-block mr-1.5" />
            Vehicle Compatibility ({compatibleVehicles.length}/{catalog.vehicles.length})
          </button>
          <button
            onClick={() => setActiveTab('cancapture')}
            className={`py-3 px-3 font-medium border-b-2 transition ${
              activeTab === 'cancapture'
                ? 'border-[var(--md-sys-color-primary)] text-cyan-400 font-bold'
                : 'border-transparent text-[var(--text-muted)] hover:text-slate-200'
            }`}
          >
            <FileText className="w-4 h-4 inline-block mr-1.5" />
            Capture Note (D1–D8)
          </button>
          <button
            onClick={() => setActiveTab('raw_json')}
            className={`py-3 px-3 font-medium border-b-2 transition ${
              activeTab === 'raw_json'
                ? 'border-[var(--md-sys-color-primary)] text-cyan-400 font-bold'
                : 'border-transparent text-[var(--text-muted)] hover:text-slate-200'
            }`}
          >
            <Code2 className="w-4 h-4 inline-block mr-1.5" />
            Raw JSON
          </button>
          <button
            onClick={() => setActiveTab('dbc')}
            className={`py-3 px-3 font-medium border-b-2 transition ${
              activeTab === 'dbc'
                ? 'border-[var(--md-sys-color-primary)] text-cyan-400 font-bold'
                : 'border-transparent text-[var(--text-muted)] hover:text-slate-200'
            }`}
          >
            <FileCode className="w-4 h-4 inline-block mr-1.5" />
            Vector DBC Signal
          </button>
          <button
            onClick={() => setActiveTab('homeassistant')}
            className={`py-3 px-3 font-medium border-b-2 transition ${
              activeTab === 'homeassistant'
                ? 'border-[var(--md-sys-color-primary)] text-cyan-400 font-bold'
                : 'border-transparent text-[var(--text-muted)] hover:text-slate-200'
            }`}
          >
            <Home className="w-4 h-4 inline-block mr-1.5 text-sky-400" />
            Home Assistant
          </button>
        </div>

        {/* Body content */}
        <div className="p-6 max-h-[68vh] overflow-y-auto space-y-6">
          {/* Validation Banner if any issues */}
          {(hasErrors || hasWarnings) && (
            <div
              className={`p-3.5 rounded-lg border flex items-start gap-3 text-xs ${
                hasErrors
                  ? 'bg-rose-950/40 border-rose-800 text-rose-200'
                  : 'bg-amber-950/40 border-amber-800 text-amber-200'
              }`}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">
                  {hasErrors ? 'Validation Errors' : 'Validation Warnings'}
                </div>
                {issues.map((iss, i) => (
                  <div key={i}>
                    • {iss.field ? `[${iss.field}] ` : ''}
                    {iss.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Community Contributor Credit */}
              {(() => {
                const contributors = getCommandContributors(command);
                if (contributors.length === 0) return null;

                return (
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-700/80 shadow-sm space-y-3">
                    <div className="flex items-center gap-2">
                      <Github className="w-4 h-4 text-cyan-400" />
                      <span className="text-[11px] uppercase font-bold tracking-wider text-slate-300">
                        {contributors.length > 1 ? 'Discovered & Contributed By (Research Credits)' : 'Discovered & Contributed By'}
                      </span>
                    </div>

                    <div className={`grid gap-3 ${contributors.length > 1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
                      {contributors.map((contrib, idx) => {
                        const handle = contrib.github ? contrib.github.replace(/^@/, '') : '';
                        return (
                          <div 
                            key={idx}
                            className="p-3 rounded-lg bg-slate-950/70 border border-slate-800/90 flex flex-col justify-between gap-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-cyan-400 shrink-0">
                                  {handle ? <Github className="w-4 h-4" /> : <User className="w-4 h-4" />}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {contrib.name && (
                                      <span className="text-sm font-bold text-white truncate">
                                        {contrib.name}
                                      </span>
                                    )}
                                    {handle && (
                                      <a
                                        href={`https://github.com/${handle}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-xs font-mono text-cyan-300 hover:text-cyan-200 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-700/60 hover:border-cyan-500 transition"
                                      >
                                        <span>@{handle}</span>
                                        <ExternalLink className="w-2.5 h-2.5" />
                                      </a>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {contrib.role && (
                                <span className="text-[10px] text-cyan-400 uppercase tracking-wider bg-cyan-950/60 border border-cyan-800 px-1.5 py-0.5 rounded font-semibold shrink-0">
                                  {contrib.role}
                                </span>
                              )}
                            </div>

                            {/* Separate Tested Vehicle Box & Notes Box */}
                            {(contrib.tested_vehicle || (contributors.length === 1 && command.tested_vehicle)) && (
                              <div className="text-xs text-emerald-300 bg-emerald-950/40 px-2.5 py-1.5 rounded border border-emerald-800/60 flex items-center gap-2">
                                <Car className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-400/80 shrink-0">Tested Vehicle:</span>
                                <span className="font-medium text-emerald-200">
                                  {contrib.tested_vehicle || command.tested_vehicle}
                                </span>
                              </div>
                            )}

                            {(contrib.notes || (contributors.length === 1 && command.notes)) && (
                              <div className="text-xs text-slate-300 bg-slate-900/80 px-2.5 py-1.5 rounded border border-slate-800/80 flex items-start gap-2">
                                <FileText className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                                <div>
                                  <span className="text-[10px] text-cyan-400/80 font-bold uppercase tracking-wider block mb-0.5">
                                    Notes:
                                  </span>
                                  <span className="leading-relaxed">
                                    {contrib.notes || command.notes}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Payloads section */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                  CAN Payload & Byte Transition
                </h4>
                {(() => {
                  const defaultOpt = command.options?.find(o => o.default) || command.options?.[0];
                  return (
                    <PayloadByteVisualizer
                      fromPayload={command.from_payload}
                      toPayload={command.to_payload}
                      matchPayload={command.match_payload || (command.from_payload || command.to_payload ? undefined : (defaultOpt?.match || defaultOpt?.match_payload))}
                      payload={command.payload || (command.from_payload || command.to_payload || command.match_payload ? undefined : (defaultOpt?.payload as any))}
                    />
                  );
                })()}
              </div>

              {/* Options / State Breakdown if present */}
              {command.options && command.options.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-cyan-400" />
                      State Definitions & Rx CAN ID Decode Map ({command.options.length} Defined States)
                    </h4>
                    {onEdit && (
                      <button
                        onClick={() => onEdit(command)}
                        className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 underline"
                      >
                        Edit State Mappings
                      </button>
                    )}
                  </div>
                  <div className="overflow-hidden rounded-lg border border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="p-3">State Meaning / Label</th>
                          <th className="p-3 font-mono">Code / Value</th>
                          <th className="p-3 font-mono">RX CAN Match Pattern</th>
                          <th className="p-3 font-mono">Action Frame (TX)</th>
                          <th className="p-3">Description / Toast</th>
                          <th className="p-3 text-center">Default</th>
                          <th className="p-3 text-right">Automate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 font-mono">
                        {command.options.map((opt, idx) => (
                          <tr key={idx} className="hover:bg-slate-800/30 transition">
                            <td className="p-3 font-sans font-medium text-white">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-semibold">{opt.label}</span>
                                {opt.requires_feature && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-cyan-950/80 border border-cyan-800 text-cyan-300 font-mono">
                                    req: {opt.requires_feature}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="p-3 text-cyan-300">
                              {opt.state_value !== undefined && opt.state_value !== '' ? (
                                <span className="bg-cyan-950/60 border border-cyan-800/60 px-2 py-0.5 rounded text-[11px] font-bold">
                                  {formatPayloadDisplay(opt.state_value)}
                                </span>
                              ) : opt.evaluate ? (
                                <span className="bg-amber-950/60 border border-amber-800/60 px-2 py-0.5 rounded text-[11px] font-bold text-amber-300 font-mono">
                                  {formatPayloadDisplay(opt.evaluate)}
                                </span>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>
                            <td className="p-3 text-slate-300">
                              {(opt.match_payload || opt.match) ? (
                                <span className="text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/40 font-mono text-[11px]">
                                  {formatPayloadDisplay(opt.match_payload || opt.match)}
                                </span>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>
                            <td className="p-3 text-emerald-300">
                              {opt.steps && opt.steps.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1 flex-wrap">
                                    {opt.steps.map((st, sidx) => (
                                      <span
                                        key={sidx}
                                        className="bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 px-1.5 py-0.5 rounded text-[10px]"
                                      >
                                        {formatPayloadDisplay(st.payload)}{' '}
                                        {st.repeat ? (
                                          <span className="text-amber-400 font-bold">x{st.repeat}</span>
                                        ) : null}
                                      </span>
                                    ))}
                                  </div>
                                  {opt.from_payload && (
                                    <span className="text-[10px] text-slate-400 font-sans">
                                      Trigger: <span className="font-mono text-amber-300">{formatPayloadDisplay(opt.from_payload)}</span>
                                    </span>
                                  )}
                                </div>
                              ) : opt.from_payload || opt.to_payload ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="text-amber-300">{formatPayloadDisplay(opt.from_payload) || '*'}</span>
                                  <span className="text-slate-500 font-sans">→</span>
                                  <span className="text-emerald-300">{formatPayloadDisplay(opt.to_payload) || '*'}</span>
                                  {opt.repeat && opt.repeat > 1 && (
                                    <span className="text-amber-400 font-bold ml-1">x{opt.repeat}</span>
                                  )}
                                </span>
                              ) : opt.payload ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="text-cyan-300">{formatPayloadDisplay(opt.payload)}</span>
                                  {opt.repeat && opt.repeat > 1 && (
                                    <span className="text-amber-400 font-bold ml-1">x{opt.repeat}</span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>
                            <td className="p-3 font-sans text-slate-400">
                              {opt.description || opt.popup || opt.popup_message || '-'}
                            </td>
                            <td className="p-3 text-center">
                              {opt.default ? (
                                <span className="px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase bg-cyan-950 text-cyan-300 border border-cyan-700">
                                  Default
                                </span>
                              ) : (
                                '-'
                              )}
                            </td>
                            <td className="p-3 text-right">
                              {onAddToAutomation && (
                                <div className="inline-flex items-center gap-1.5 justify-end">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onAddToAutomation(command, 'action', opt);
                                      onClose();
                                    }}
                                    title={`Add "${opt.label}" as Action to Automation`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-emerald-950/90 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/70 transition shadow-sm"
                                  >
                                    <Play className="w-3 h-3 fill-current" />
                                    <span>Action</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onAddToAutomation(command, 'trigger', opt);
                                      onClose();
                                    }}
                                    title={`Add "${opt.label}" as Trigger to Automation`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-amber-950/90 hover:bg-amber-900 text-amber-300 border border-amber-700/70 transition shadow-sm"
                                  >
                                    <Radio className="w-3 h-3" />
                                    <span>Trigger</span>
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Sequence Steps if present */}
              {command.steps && command.steps.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                    Sequence Steps ({command.steps.length} Frames, Delay: {command.delay_ms ?? 0}ms)
                  </h4>
                  <div className="space-y-2">
                    {command.steps.map((step, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-mono text-slate-400">
                            {idx + 1}
                          </span>
                          <span className="font-mono text-cyan-300">{formatPayloadDisplay(step.payload)}</span>
                        </div>
                        <span className="text-slate-400">
                          Repeat: <strong className="text-white">{step.repeat ?? 1}x</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata Grid */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                  Parameters & Properties
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-950/50 border border-slate-800">
                    <div className="text-slate-400 mb-1">CAN Bus</div>
                    <div className="font-mono text-white font-semibold">
                      Bus {command.bus ?? 0}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-950/50 border border-slate-800">
                    <div className="text-slate-400 mb-1">Delay (ms)</div>
                    <div className="font-mono text-white font-semibold">
                      {command.delay_ms !== undefined ? `${command.delay_ms} ms` : 'Immediate'}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-950/50 border border-slate-800">
                    <div className="text-slate-400 mb-1">Required Feature</div>
                    <div className="font-semibold text-emerald-300">
                      {command.requires_feature || 'None (Universal)'}
                    </div>
                  </div>
                  {command.ha_domain && (() => {
                    const domainStyle = getHaDomainBadgeStyle(command.ha_domain);
                    return (
                      <div className={`p-3 rounded-lg border ${domainStyle.bg} ${domainStyle.border}`}>
                        <div className="text-slate-400 mb-1 flex items-center justify-between">
                          <span>HA Domain</span>
                          <span className={`w-2 h-2 rounded-full ${domainStyle.dot}`} />
                        </div>
                        <div className={`font-mono font-bold text-sm ${domainStyle.text}`}>
                          {command.ha_domain}
                        </div>
                      </div>
                    );
                  })()}
                  {(command.ha_metadata?.icon || command.icon || command.mdi) && (
                    <div className="p-3 rounded-lg bg-sky-950/40 border border-sky-800/50">
                      <div className="text-slate-400 mb-1 flex items-center justify-between">
                        <span>Icon (MDI)</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(command.ha_metadata?.icon || command.icon || command.mdi || '');
                            setCopiedIcon(true);
                            setTimeout(() => setCopiedIcon(false), 2000);
                          }}
                          className="text-slate-400 hover:text-white transition"
                          title="Copy icon name"
                        >
                          {copiedIcon ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-sky-300 truncate">
                        <MdiIcon icon={command.ha_metadata?.icon || command.icon || command.mdi} className="w-4 h-4 text-sky-400 shrink-0" />
                        <span className="truncate">{command.ha_metadata?.icon || command.icon || command.mdi}</span>
                      </div>
                    </div>
                  )}
                  {command.device_class && (
                    <div className="p-3 rounded-lg bg-slate-950/50 border border-slate-800">
                      <div className="text-slate-400 mb-1">HA Device Class</div>
                      <div className="font-mono text-cyan-300 font-semibold">{command.device_class}</div>
                    </div>
                  )}
                  {command.popup_message && (
                    <div className="p-3 col-span-2 rounded-lg bg-slate-950/50 border border-slate-800">
                      <div className="text-slate-400 mb-1">Popup OSD Message</div>
                      <div className="font-mono text-amber-300">{command.popup_message}</div>
                    </div>
                  )}
                  {command.expression && (
                    <div className="p-3 col-span-2 rounded-lg bg-slate-950/50 border border-slate-800">
                      <div className="text-slate-400 mb-1">Logical Expression</div>
                      <div className="font-mono text-cyan-300">{command.expression}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'vehicles' && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-slate-950/50 border border-slate-800 text-xs text-slate-300 flex items-center justify-between">
                <div>
                  Required Feature:{' '}
                  <strong className="text-emerald-300">
                    {command.requires_feature || 'None (Works on all Gen5W models)'}
                  </strong>
                </div>
                <div>
                  Compatible: <strong className="text-white">{compatibleVehicles.length}</strong> /{' '}
                  {catalog.vehicles.length} Trims
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {catalog.vehicles.map(v => {
                  const isCompatible = compatibleVehicles.some(cv => cv.id === v.id);
                  return (
                    <div
                      key={v.id}
                      className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
                        isCompatible
                          ? 'bg-slate-900/90 border-slate-800 text-slate-200'
                          : 'bg-slate-950/30 border-slate-900 text-slate-600 opacity-60'
                      }`}
                    >
                      <div>
                        <div className="font-semibold text-white flex items-center gap-1.5">
                          {v.make} {v.model}
                          <span className="text-[11px] font-normal text-slate-400">
                            ({v.trim})
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          {v.id} • Region: {v.region}
                        </div>
                      </div>
                      <div>
                        {isCompatible ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-800">
                            Supported
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-900 text-slate-500">
                            Missing Feature
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'cancapture' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-400 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-cyan-400" />
                  <span>
                    Community <strong className="text-white font-mono">!cancapture</strong> note format (D1–D8 notation)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const note = formatCommandAsCanCapture(command);
                    navigator.clipboard.writeText(note);
                    setCopiedCapture(true);
                    setTimeout(() => setCopiedCapture(false), 2000);
                  }}
                  className="dash-outline-btn px-2.5 py-1 text-[11px] inline-flex items-center gap-1"
                >
                  {copiedCapture ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-300">Copied Note</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy Note</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-cyan-300 overflow-x-auto border border-slate-800 leading-relaxed select-all">
                {formatCommandAsCanCapture(command)}
              </pre>

              <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">Discord & Forum Sharing:</div>
                <p>
                  • Formatted with D1–D8 byte references, multi-packet steps, and CAN IDs ready to paste directly into community notes.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'raw_json' && (
            <div className="relative">
              <pre className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-slate-300 overflow-x-auto border border-slate-800 leading-relaxed select-all">
                {JSON.stringify(command, null, 2)}
              </pre>
            </div>
          )}

          {activeTab === 'dbc' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-400 flex items-center gap-1.5">
                  <FileCode className="w-4 h-4 text-cyan-400" />
                  <span>
                    Standard Vector CAN DBC syntax for CAN ID{' '}
                    <strong className="text-white font-mono">{command.state_can_id || command.can_id}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(dbcSnippet);
                    setCopiedDbc(true);
                    setTimeout(() => setCopiedDbc(false), 2000);
                  }}
                  className="dash-outline-btn px-2.5 py-1 text-[11px] inline-flex items-center gap-1"
                >
                  {copiedDbc ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-300">Copied DBC</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy DBC</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-emerald-300 overflow-x-auto border border-slate-800 leading-relaxed select-all">
                {dbcSnippet}
              </pre>

              <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">DBC Signal Mapping:</div>
                <p>
                  • CAN message defined as <code className="text-cyan-300 font-mono">BO_ {parseInt(command.state_can_id || command.can_id || '0', 16)}</code>
                </p>
                <p>
                  • Bit position & length calculated from payload mask <code className="text-cyan-300 font-mono">{command.payload_mask}</code>
                </p>
                {command.options && command.options.length > 0 && (
                  <p>
                    • Discrete states exported as DBC Value Table <code className="text-cyan-300 font-mono">VAL_</code>
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'homeassistant' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-slate-300 flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-sky-950/70 border border-sky-800/60 flex items-center justify-center text-sky-400">
                    <Home className="w-3.5 h-3.5" />
                  </div>
                  <span>
                    Home Assistant YAML configuration for <strong className="text-white font-mono">{commandName}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(haYamlSnippet);
                    setCopiedHaYaml(true);
                    setTimeout(() => setCopiedHaYaml(false), 2000);
                  }}
                  className="dash-outline-btn px-3 py-1.5 text-xs inline-flex items-center gap-1.5"
                >
                  {copiedHaYaml ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-300">Copied YAML</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy HA YAML</span>
                    </>
                  )}
                </button>
              </div>

              {/* Entity Overview Pills */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                  <div className="text-slate-400 text-[10.5px] mb-0.5">HA Domain</div>
                  <div className="font-mono font-bold text-sky-400 truncate">
                    {command.ha_domain || 'sensor'}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                  <div className="text-slate-400 text-[10.5px] mb-0.5">MDI Icon</div>
                  <div className="flex items-center gap-1.5 font-mono text-cyan-300 truncate">
                    <MdiIcon icon={command.ha_metadata?.icon || command.icon || command.mdi} className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span className="truncate">{command.ha_metadata?.icon || command.icon || command.mdi || 'mdi:car-info'}</span>
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                  <div className="text-slate-400 text-[10.5px] mb-0.5">Entity ID</div>
                  <div className="font-mono text-slate-300 truncate text-[11px]">
                    {command.ha_domain || 'sensor'}.can_do_{command.id}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                  <div className="text-slate-400 text-[10.5px] mb-0.5">Device Class</div>
                  <div className="font-mono text-emerald-300 truncate">
                    {command.device_class || 'None'}
                  </div>
                </div>
              </div>

              <pre className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-sky-300 overflow-x-auto border border-slate-800 leading-relaxed select-all">
                {haYamlSnippet}
              </pre>

              <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400 space-y-1.5">
                <div className="text-slate-300 font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Home Assistant Metadata Integration Guide
                </div>
                <p>
                  • <strong className="text-slate-200">ha_domain</strong>: Maps this CAN message to the appropriate Home Assistant component architecture (<code className="text-orange-300 font-mono">notify</code> for cluster OSD popups and toasts, <code className="text-cyan-300 font-mono">event</code> for button/click triggers, <code className="text-teal-300 font-mono">binary_sensor</code> for two-state latches, <code className="text-emerald-300 font-mono">switch</code> for controllable outputs).
                </p>
                <p>
                  • <strong className="text-slate-200">icon / mdi</strong>: Specifies the standard Material Design Icon (e.g. <code className="text-sky-300 font-mono">{command.icon || command.mdi || 'mdi:steering'}</code>) natively rendered across Home Assistant Lovelace dashboards, mobile apps, and Apple CarPlay/Android Auto.
                </p>
                {command.device_class && (
                  <p>
                    • <strong className="text-slate-200">device_class</strong>: Configures native Home Assistant state representation and telemetry units (<code className="text-amber-300 font-mono">{command.device_class}</code>).
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 px-6 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="dash-outline-btn inline-flex items-center gap-2 text-xs py-2 px-3.5"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied Snippet
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy JSON
                </>
              )}
            </button>

            {onDelete && (
              confirmDelete ? (
                <div className="flex items-center gap-1.5 bg-rose-950/90 border border-rose-700/80 px-2.5 py-1 rounded-lg">
                  <span className="text-xs font-semibold text-rose-200">Delete command?</span>
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(command.id);
                      onClose();
                    }}
                    className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-xs transition"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="dash-outline-btn inline-flex items-center gap-1.5 text-xs py-2 px-3 text-slate-400 hover:text-rose-400 hover:border-rose-800/60"
                  title="Delete this command"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )
            )}
          </div>

          <div className="flex items-center gap-2">
            {onAddToAutomation && (
              <div className="flex items-center gap-1.5">
                {command.options && command.options.length > 0 && (
                  <select
                    value={selectedOptionIdx}
                    onChange={e => setSelectedOptionIdx(parseInt(e.target.value) || 0)}
                    className="bg-slate-900 border border-slate-700 rounded-full px-3 py-1.5 text-xs text-slate-200 font-medium focus:outline-none focus:border-cyan-500"
                    title="Select specific state for automation"
                  >
                    {command.options.map((opt, oIdx) => (
                      <option key={oIdx} value={oIdx}>
                        State: {opt.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const chosenOpt = command.options && command.options.length > 0
                      ? command.options[selectedOptionIdx] || command.options[0]
                      : undefined;
                    onAddToAutomation(command, undefined, chosenOpt);
                    onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold text-slate-950 bg-cyan-400 hover:bg-cyan-300 transition shadow-sm"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span>Add to Automation</span>
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="dash-outline-btn px-4 py-2 text-xs font-semibold"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit(command);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold text-white bg-[var(--md-sys-color-primary)] hover:opacity-90 transition shadow-sm"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit Command
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
