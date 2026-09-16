import React from 'react';
import { Command, CommandRole } from '../types/catalog';
import { PayloadByteVisualizer } from './PayloadByteVisualizer';
import { MdiIcon, getHaDomainBadgeStyle } from './MdiIcon';
import { 
  Radio, 
  Sliders, 
  Play, 
  Copy, 
  Edit3, 
  Layers, 
  Car, 
  ExternalLink,
  Trash2,
  CheckCircle2,
  Github,
  User,
  Zap
} from 'lucide-react';

interface CommandCardProps {
  command: Command;
  onSelect: (cmd: Command) => void;
  onEdit: (cmd: Command) => void;
  onDuplicate: (cmd: Command) => void;
  onDelete: (cmdId: string) => void;
  isModified?: boolean;
  isNew?: boolean;
  isSelectedForAutomation?: boolean;
  onToggleSelectForAutomation?: (cmd: Command) => void;
  onAddToAutomation?: (cmd: Command, role?: CommandRole) => void;
}

export const CommandCard: React.FC<CommandCardProps> = ({
  command,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  isModified,
  isNew,
  isSelectedForAutomation,
  onToggleSelectForAutomation,
  onAddToAutomation
}) => {
  const [copied, setCopied] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [showRoleMenu, setShowRoleMenu] = React.useState(false);

  React.useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => {
      setConfirmDelete(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const getRoleBadge = (role: CommandRole) => {
    switch (role) {
      case 'trigger':
        return (
          <span
            key={role}
            className="can-do-ha-pill trig-pill"
          >
            <Radio className="w-3 h-3 text-amber-400" />
            Trigger
          </span>
        );
      case 'condition':
        return (
          <span
            key={role}
            className="can-do-ha-pill cond-pill"
          >
            <Sliders className="w-3 h-3 text-cyan-400" />
            Condition
          </span>
        );
      case 'action':
        return (
          <span
            key={role}
            className="can-do-ha-pill act-pill"
          >
            <Play className="w-3 h-3 text-emerald-400" />
            Action
          </span>
        );
      default:
        return null;
    }
  };

  const getLeftBorderGradient = () => {
    const roleOrder: CommandRole[] = ['trigger', 'condition', 'action'];
    const activeRoles = roleOrder.filter(r => command.roles?.includes(r));
    
    if (activeRoles.length === 0) {
      if (command.type === 'choose') return 'linear-gradient(to bottom, #8b5cf6, #8b5cf6)';
      if (command.type === 'ifthen') return 'linear-gradient(to bottom, #0ea5e9, #0ea5e9)';
      return 'linear-gradient(to bottom, #64748b, #64748b)';
    }

    const roleColors: Record<CommandRole, string> = {
      trigger: '#f59e0b',   // amber/orange
      condition: '#0284c7', // cyan/blue
      action: '#10b981'     // emerald/green
    };

    if (activeRoles.length === 1) {
      const col = roleColors[activeRoles[0]];
      return `linear-gradient(to bottom, ${col}, ${col})`;
    }

    const step = 100 / activeRoles.length;
    const stops: string[] = [];
    activeRoles.forEach((role, idx) => {
      const col = roleColors[role];
      const start = idx * step;
      const end = (idx + 1) * step;
      stops.push(`${col} ${start}%`, `${col} ${end}%`);
    });

    return `linear-gradient(to bottom, ${stops.join(', ')})`;
  };

  const handleCopyJson = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(command, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const hasActionRole = command.roles?.includes('action') || Boolean(command.action_can_id);
  const hasListenRole = command.roles?.includes('trigger') || command.roles?.includes('condition') || Boolean(command.state_can_id);

  const rxBus = command.network?.bus ?? command.bus ?? 0;
  const rxCanId = command.network?.state_can_id || command.state_can_id || (!command.action_can_id && !command.network?.action_can_id && !hasActionRole ? command.can_id : undefined);

  const txBus = command.network?.bus ?? command.action_bus ?? command.bus ?? 0;
  const txCanId = command.network?.action_can_id || command.action_can_id || (hasActionRole && !command.state_can_id && !command.network?.state_can_id ? command.can_id : undefined);

  const hasRx = Boolean(rxCanId || (hasListenRole && (command.network?.bus !== undefined || command.bus !== undefined)));
  const hasTx = Boolean(txCanId || (hasActionRole && (command.network?.bus !== undefined || command.action_bus !== undefined || command.bus !== undefined)));

  const cardMdiIcon = command.ha_metadata?.icon || command.icon || command.mdi || 'mdi:car-info';

  const formatByteMap = (val: any) => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    return Object.entries(val).map(([k, v]) => `${k}:${v}`).join(' ');
  };

  return (
    <div
      onClick={() => onSelect(command)}
      className={`group relative flex flex-col justify-between rounded-[12px] border bg-[var(--card-bg)] p-4 sm:p-5 transition-all duration-200 hover:border-slate-500 hover:shadow-md cursor-pointer min-w-0 ${
        isNew
          ? 'border-emerald-500/50 shadow-emerald-500/5'
          : isModified
          ? 'border-amber-500/50 shadow-amber-500/5'
          : 'border-[var(--border-color)]'
      }`}
    >
      {/* Dynamic multi-role split left border indicator */}
      <div 
        className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-[12px] overflow-hidden pointer-events-none"
        style={{ background: getLeftBorderGradient() }}
      />
      {/* Draft badge indicator */}
      {(isNew || isModified) && (
        <div className="absolute -top-2.5 right-4 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-950 border shadow">
          {isNew ? (
            <span className="text-emerald-400">✨ New Contribution</span>
          ) : (
            <span className="text-amber-400">✏️ Draft Modified</span>
          )}
        </div>
      )}

      <div className="min-w-0">
        {/* Row 1: Role pills and Automation select checkbox */}
        <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {command.roles && command.roles.length > 0 ? (
              command.roles.map(role => getRoleBadge(role))
            ) : (
              <span className="can-do-ha-pill trig-pill">
                <Radio className="w-3 h-3 text-amber-400" />
                Trigger
              </span>
            )}
          </div>

          {onToggleSelectForAutomation && (
            <div
              onClick={e => {
                e.stopPropagation();
                onToggleSelectForAutomation(command);
              }}
              title={isSelectedForAutomation ? 'Selected for automation' : 'Select for automation'}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold cursor-pointer transition ${
                isSelectedForAutomation
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400 font-bold shadow'
                  : 'bg-slate-950/60 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200'
              }`}
            >
              <input
                type="checkbox"
                checked={isSelectedForAutomation || false}
                onChange={() => {}} // Handled by parent div
                className="w-3 h-3 rounded pointer-events-none text-cyan-500"
              />
              <span>Automate</span>
            </div>
          )}
        </div>

        {/* Row 2: TX Bus / RX Bus */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3 text-xs font-mono">
          {hasRx && (
            <div 
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-950/80 border border-slate-800/80 text-cyan-300 shrink-0"
              title={rxCanId ? `RX CAN ID: ${rxCanId} on Bus ${rxBus}` : `RX Bus ${rxBus}`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">RX Bus {rxBus}</span>
              {rxCanId && (
                <>
                  <span className="text-slate-600">•</span>
                  <span className="font-semibold text-cyan-300">{rxCanId}</span>
                  {command.options && command.options.length > 0 && (
                    <span className="text-[10px] text-cyan-400 bg-cyan-950/90 px-1 py-0.2 rounded border border-cyan-800/80 font-sans font-medium" title={`${command.options.length} Defined States mapped for this CAN ID`}>
                      {command.options.length} states
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {hasTx && (
            <div 
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-950/80 border border-slate-800/80 text-emerald-300 shrink-0"
              title={txCanId ? `TX CAN ID: ${txCanId} on Bus ${txBus}` : `TX Bus ${txBus}`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">TX Bus {txBus}</span>
              {txCanId && (
                <>
                  <span className="text-slate-600">•</span>
                  <span className="font-semibold text-emerald-400">{txCanId}</span>
                </>
              )}
            </div>
          )}

          {!hasRx && !hasTx && (
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-950/80 border border-slate-800/80 text-slate-400 shrink-0">
              <span className="text-[10px] uppercase font-bold text-slate-500">Virtual / OSD</span>
            </div>
          )}
        </div>

        {/* Command Title & ID / Category with MDI Icon */}
        <div className="flex items-center gap-2.5 mb-1 min-w-0">
          <div
            className="w-7 h-7 rounded-lg bg-sky-950/60 border border-sky-800/60 flex items-center justify-center text-sky-400 shrink-0 group-hover:border-sky-500/70 group-hover:text-sky-300 transition-colors shadow-sm"
            title={`MDI: ${cardMdiIcon}`}
          >
            <MdiIcon icon={cardMdiIcon} className="w-4 h-4" />
          </div>
          <h3 className="text-base font-semibold text-white group-hover:text-cyan-300 transition-colors truncate" title={command.name}>
            {command.name}
          </h3>
        </div>
        <div className="text-xs text-slate-400 mb-3 flex items-center gap-1.5 min-w-0 overflow-hidden">
          <span className="font-mono text-slate-400 truncate shrink min-w-0 text-[11px]" title={command.id}>
            {command.id}
          </span>
          <span className="text-slate-600 shrink-0">•</span>
          <span className="text-slate-400 font-sans truncate shrink-0 max-w-[36%]" title={command.category}>
            {command.category}
          </span>
          {command.subcategory && (
            <>
              <span className="text-slate-600 shrink-0">›</span>
              <span
                className="text-cyan-400/90 font-medium truncate shrink-0 max-w-[40%] text-[11px] bg-cyan-950/50 px-1.5 py-0.5 rounded border border-cyan-900/50"
                title={`Subsystem: ${command.subcategory}`}
              >
                {command.subcategory}
              </span>
            </>
          )}
        </div>

        {/* Payload preview */}
        <div className="mb-3 min-w-0">
          {command.options && command.options.length > 0 ? (
            <div className="bg-slate-950/70 rounded-lg p-2 border border-slate-800 text-xs min-w-0">
              <div className="flex items-center justify-between text-slate-400 mb-1.5 font-medium gap-1 min-w-0">
                <span className="flex items-center gap-1 text-[11px] text-slate-300 truncate">
                  <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="truncate">{command.options.length} Defined States:</span>
                </span>
                <span className="text-[10px] text-slate-500 truncate shrink-0">
                  Default: {command.options.find(o => o.default)?.label || command.options[0].label}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                {command.options.slice(0, 3).map((opt, i) => (
                  <div
                    key={i}
                    className={`p-1.5 rounded text-[11px] font-mono flex items-center justify-between gap-2 ${
                      opt.default
                        ? 'bg-cyan-950/40 text-cyan-300 border border-cyan-700/40'
                        : 'bg-slate-900/80 text-slate-300 border border-slate-800'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 shrink-0 min-w-0">
                      {opt.state_value !== undefined && opt.state_value !== '' && (
                        <span className="text-[10px] px-1 py-0.2 rounded bg-slate-800 text-cyan-400 border border-slate-700 font-mono font-semibold">
                          {opt.state_value}
                        </span>
                      )}
                      <span className="font-semibold truncate">{opt.label}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-end min-w-0">
                      {(opt.match || opt.match_payload) && (
                        <span className="text-[10px] text-cyan-300 bg-cyan-950/70 px-1 py-0.5 rounded border border-cyan-800/40 truncate font-mono" title="RX Match State">
                          RX: {formatByteMap(opt.match || opt.match_payload)}
                        </span>
                      )}
                      {opt.steps && opt.steps.length > 0 ? (
                        opt.steps.map((st, sidx) => (
                          <span key={sidx} className="text-[10px] text-emerald-300 bg-emerald-950/60 px-1 py-0.5 rounded border border-emerald-800/40 truncate">
                            TX: {formatByteMap(st.payload)} {st.repeat ? <strong className="text-amber-400 font-bold">x{st.repeat}</strong> : null}
                          </span>
                        ))
                      ) : (opt.payload || opt.to_payload) ? (
                        <span className="text-[10px] text-emerald-300 bg-emerald-950/60 px-1 py-0.5 rounded border border-emerald-800/40 truncate font-mono" title="TX Action">
                          TX: {formatByteMap(opt.payload || opt.to_payload)} {opt.repeat ? <strong className="text-amber-400 font-bold">x{opt.repeat}</strong> : null}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
                {command.options.length > 3 && (
                  <span className="text-[10px] text-slate-500 px-1">
                    +{command.options.length - 3} more defined states
                  </span>
                )}
              </div>
            </div>
          ) : command.from_payload || command.to_payload ? (
            <PayloadByteVisualizer
              fromPayload={command.from_payload}
              toPayload={command.to_payload}
              compact
            />
          ) : (command.match || command.match_payload) ? (
            <PayloadByteVisualizer matchPayload={command.match || command.match_payload} compact />
          ) : command.steps && command.steps.length > 0 ? (
            <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800 text-xs flex items-center justify-between min-w-0">
              <span className="text-slate-300 font-medium flex items-center gap-1 shrink-0">
                <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                Frame Sequence:
              </span>
              <span className="font-mono text-cyan-400 font-medium truncate ml-2">
                {command.steps.length} Steps {command.delay_ms ? `(${command.delay_ms}ms)` : ''}
              </span>
            </div>
          ) : (
            <div className="text-xs text-slate-500 bg-slate-950/40 p-2 rounded border border-slate-800/60 italic truncate">
              {command.popup_message
                ? `OSD Popup: "${command.popup_message}"`
                : command.expression
                ? `Expression: ${command.expression}`
                : 'Condition / Virtual Automation State'}
            </div>
          )}
        </div>

        {/* Details below grids/options: HA domain, type, requirements, and tags */}
        {(command.ha_domain || command.type || command.requires_feature || (command.tags && command.tags.length > 0)) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3 min-w-0">
            {command.ha_domain && (() => {
              const domainStyle = getHaDomainBadgeStyle(command.ha_domain);
              return (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-mono font-medium border shrink-0 ${domainStyle.bg} ${domainStyle.text} ${domainStyle.border}`}
                  title={`Home Assistant Domain: ${command.ha_domain}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${domainStyle.dot}`} />
                  ha:{command.ha_domain}
                </span>
              );
            })()}
            {command.type && (
              <span className="px-2 py-0.5 rounded text-[10.5px] font-mono bg-slate-900 text-slate-400 border border-slate-800 shrink-0">
                {command.type}
              </span>
            )}
            {command.requires_feature && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-700/40 truncate max-w-full">
                <Car className="w-3 h-3 shrink-0" />
                <span className="truncate">Requires: {command.requires_feature}</span>
              </span>
            )}
            {command.tags?.map(tag => (
              <span
                key={tag}
                className="text-[10px] text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700 truncate max-w-[140px]"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}

        {/* Contributor Attribution */}
        {command.contributor && (command.contributor.name || command.contributor.github) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 pt-2 border-t border-slate-800/60 mb-1 min-w-0 overflow-hidden">
            <span className="text-[10px] text-slate-500 font-medium shrink-0">Contributed by:</span>
            {command.contributor.github ? (
              <a
                href={`https://github.com/${command.contributor.github.replace(/^@/, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900/90 hover:bg-slate-800 border border-slate-700/70 text-cyan-300 hover:text-cyan-200 transition font-mono text-[10.5px] truncate max-w-[140px]"
                title={`View GitHub profile @${command.contributor.github.replace(/^@/, '')}`}
              >
                <Github className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="truncate">@{command.contributor.github.replace(/^@/, '')}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700/70 text-slate-300 font-medium text-[10.5px] truncate max-w-[140px]">
                <User className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="truncate">{command.contributor.name}</span>
              </span>
            )}
            {command.contributor.name && command.contributor.github && (
              <span className="text-[10px] text-slate-400 font-sans truncate max-w-[100px]">
                ({command.contributor.name})
              </span>
            )}
            {command.contributor.notes && (
              <span className="text-[10px] text-slate-500 ml-auto truncate max-w-[110px] italic" title={command.contributor.notes}>
                {command.contributor.notes}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Footer action buttons */}
      <div className="flex items-center justify-between pt-3 border-t border-slate-800/80 mt-2 text-slate-400">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1">
            <ExternalLink className="w-3 h-3" /> Details
          </span>

          {onAddToAutomation && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                onAddToAutomation(command);
              }}
              title="Add to active automation rule"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-[10px] font-semibold transition"
            >
              <Zap className="w-3 h-3 text-cyan-400" />
              <span>+ Automate</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopyJson}
            title="Copy command JSON snippet"
            className="p-1.5 hover:text-cyan-400 hover:bg-slate-800 rounded transition"
          >
            {copied ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onDuplicate(command);
            }}
            title="Duplicate command"
            className="p-1.5 hover:text-cyan-400 hover:bg-slate-800 rounded transition"
          >
            <Layers className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onEdit(command);
            }}
            title="Edit command"
            className="p-1.5 hover:text-amber-400 hover:bg-slate-800 rounded transition"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          {confirmDelete ? (
            <div
              className="flex items-center gap-1.5 bg-rose-950/90 border border-rose-700/80 px-2 py-0.5 rounded-md animate-in fade-in"
              onClick={e => e.stopPropagation()}
            >
              <span className="text-[10px] font-semibold text-rose-200">Delete?</span>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onDelete(command.id);
                  setConfirmDelete(false);
                }}
                title="Confirm deletion"
                className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-[10px] transition shadow-sm"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  setConfirmDelete(false);
                }}
                title="Cancel"
                className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
              title="Delete command"
              className="p-1.5 hover:text-rose-400 hover:bg-slate-800 rounded transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
