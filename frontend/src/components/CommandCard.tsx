import React from 'react';
import { Chip, Badge, Card, Checkbox, Tooltip } from '@heroui/react';
import { Command, CommandRole, CommandOption, getCommandContributors, getCommandTestedVehicle } from '../types/catalog';
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
  Zap,
  Sparkles
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
  onAddToAutomation?: (cmd: Command, role?: CommandRole, option?: CommandOption) => void;
}

const CommandCardComponent: React.FC<CommandCardProps> = ({
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
          <Chip
            key={role}
            size="sm"
            color="warning"
            variant="soft"
            className="can-do-ha-pill trig-pill"
          >
            <Radio className="w-3 h-3 text-amber-400" />
            Trigger
          </Chip>
        );
      case 'condition':
        return (
          <Chip
            key={role}
            size="sm"
            color="accent"
            variant="soft"
            className="can-do-ha-pill cond-pill"
          >
            <Sliders className="w-3 h-3 text-cyan-400" />
            Condition
          </Chip>
        );
      case 'action':
        return (
          <Chip
            key={role}
            size="sm"
            color="success"
            variant="soft"
            className="can-do-ha-pill act-pill"
          >
            <Play className="w-3 h-3 text-emerald-400" />
            Action
          </Chip>
        );
      default:
        return null;
    }
  };

  const getLeftBorderGradient = () => {
    const roleOrder: CommandRole[] = ['trigger', 'condition', 'action'];
    const activeRoles = roleOrder.filter(r => command.roles?.includes(r));
    
    let colors: string[] = [];
    if (activeRoles.length === 0) {
      if (command.type === 'choose') colors = ['#8b5cf6'];
      else if (command.type === 'ifthen') colors = ['#0ea5e9'];
      else colors = ['#64748b'];
    } else {
      const roleColors: Record<CommandRole, string> = {
        trigger: '#f59e0b',   // amber/orange
        condition: '#0284c7', // cyan/blue
        action: '#10b981'     // emerald/green
      };
      colors = activeRoles.map(r => roleColors[r]);
    }

    const fadePct = colors.length === 1 ? 25 : Math.max(12, Math.round(30 / colors.length));
    const bottomFadePct = 100 - fadePct;

    if (colors.length === 1) {
      const col = colors[0];
      return `linear-gradient(to bottom, var(--card-bg) 0%, ${col} ${fadePct}%, ${col} ${bottomFadePct}%, var(--card-bg) 100%)`;
    }

    const stops: string[] = [];
    stops.push(`var(--card-bg) 0%`, `${colors[0]} ${fadePct}%`);

    const step = 100 / colors.length;
    const blendHalf = 2.5; // subtle 5% transition window between adjacent colors
    colors.forEach((col, idx) => {
      const start = idx * step;
      const end = (idx + 1) * step;
      if (idx > 0) {
        const blendStart = Math.max(fadePct, Math.round((start + blendHalf) * 10) / 10);
        stops.push(`${col} ${blendStart}%`);
      }
      if (idx < colors.length - 1) {
        const blendEnd = Math.min(bottomFadePct, Math.round((end - blendHalf) * 10) / 10);
        stops.push(`${col} ${blendEnd}%`);
      }
    });

    stops.push(`${colors[colors.length - 1]} ${bottomFadePct}%`, `var(--card-bg) 100%`);
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
    <Card
      onClick={() => onSelect(command)}
      className={`group relative flex flex-col rounded-[12px] border bg-[var(--card-bg)] p-4 sm:p-5 transition-all duration-200 hover:border-slate-500 hover:shadow-md cursor-pointer min-w-0 ${
        isNew
          ? 'border-emerald-500/50 shadow-emerald-500/5'
          : isModified
          ? 'border-amber-500/50 shadow-amber-500/5'
          : 'border-[var(--border-color)]'
      }`}
    >
      {/* Dynamic multi-role split left border indicator */}
      <div 
        className="absolute left-[6px] top-[12px] bottom-[12px] w-[6px] pointer-events-none"
        style={{ background: getLeftBorderGradient() }}
      />
      {/* Draft badge indicator */}
      {(isNew || isModified) && (
        <div className="absolute -top-2.5 right-4 shadow">
          {isNew ? (
            <Badge
              size="sm"
              color="success"
              variant="soft"
              className="text-[10px] font-bold uppercase tracking-wider bg-slate-950 border border-emerald-500/50 text-emerald-400"
            >
              <Sparkles className="w-3 h-3 mr-1" /> New Contribution
            </Badge>
          ) : (
            <Badge
              size="sm"
              color="warning"
              variant="soft"
              className="text-[10px] font-bold uppercase tracking-wider bg-slate-950 border border-amber-500/50 text-amber-400"
            >
              <Edit3 className="w-3 h-3 mr-1" /> Draft Modified
            </Badge>
          )}
        </div>
      )}

      <div className="min-w-0">
        {/* Row 1: Role pills */}
        <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {command.roles && command.roles.length > 0 ? (
              command.roles.map(role => getRoleBadge(role))
            ) : (
              <Chip size="sm" color="warning" variant="soft" className="can-do-ha-pill trig-pill">
                <Radio className="w-3 h-3 text-amber-400" />
                Trigger
              </Chip>
            )}
          </div>
        </div>

        {/* Row 2: Merged CAN Bus & ID Pill & DLC */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3 text-xs font-mono">
          {hasRx || hasTx ? (
            <Tooltip>
              <Tooltip.Trigger>
                <Chip 
                  size="sm"
                  variant="secondary"
                  className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-md bg-slate-950/80 border border-slate-800/80 text-xs font-mono shrink-0 shadow-sm cursor-help"
                >
                  {hasRx && hasTx && rxBus === txBus ? (
                    // Unified single bus display when RX and TX share the same bus
                    <div className="inline-flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Bus {rxBus}
                      </span>
                      <span className="text-slate-600">•</span>
                      {rxCanId === txCanId ? (
                        <span className="inline-flex items-center gap-1 text-cyan-300 font-semibold">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">RX/TX</span>
                          <Badge size="sm" color="accent" variant="soft" className="font-mono text-cyan-300 font-semibold px-1 py-0">{rxCanId}</Badge>
                        </span>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          {rxCanId && (
                            <span className="inline-flex items-center gap-1 text-cyan-300 font-semibold">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400/80">RX</span>
                              <Badge size="sm" color="accent" variant="soft" className="font-mono text-cyan-300 font-semibold px-1 py-0">{rxCanId}</Badge>
                            </span>
                          )}
                          {rxCanId && txCanId && <span className="text-slate-600">•</span>}
                          {txCanId && (
                            <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400/80">TX</span>
                              <Badge size="sm" color="success" variant="soft" className="font-mono text-emerald-400 font-semibold px-1 py-0">{txCanId}</Badge>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    // Segmented display when buses differ or single RX/TX
                    <div className="inline-flex items-center gap-2 divide-x divide-slate-800">
                      {hasRx && (
                        <div className="inline-flex items-center gap-1.5 text-cyan-300">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            RX Bus {rxBus}
                          </span>
                          {rxCanId && (
                            <>
                              <span className="text-slate-600">•</span>
                              <Badge size="sm" color="accent" variant="soft" className="font-semibold font-mono text-cyan-300 px-1 py-0">{rxCanId}</Badge>
                            </>
                          )}
                        </div>
                      )}
                      {hasTx && (
                        <div className={`inline-flex items-center gap-1.5 text-emerald-300 ${hasRx ? 'pl-2' : ''}`}>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            TX Bus {txBus}
                          </span>
                          {txCanId && (
                            <>
                              <span className="text-slate-600">•</span>
                              <Badge size="sm" color="success" variant="soft" className="font-semibold font-mono text-emerald-400 px-1 py-0">{txCanId}</Badge>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Chip>
              </Tooltip.Trigger>
              <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-slate-900 border border-slate-700 text-slate-200 shadow-xl z-50">
                {hasRx && hasTx
                  ? `RX: ${rxCanId || 'N/A'} (Bus ${rxBus}), TX: ${txCanId || 'N/A'} (Bus ${txBus})`
                  : hasRx
                  ? `RX: ${rxCanId || 'N/A'} (Bus ${rxBus})`
                  : `TX: ${txCanId || 'N/A'} (Bus ${txBus})`}
              </Tooltip.Content>
            </Tooltip>
          ) : (
            <Chip
              size="sm"
              variant="secondary"
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-slate-950/80 border border-slate-800/80 text-slate-400 shrink-0 font-mono text-xs"
            >
              <span className="text-[10px] uppercase font-bold text-slate-500">Virtual / OSD</span>
            </Chip>
          )}

          {/* DLC length pill */}
          {(hasRx || hasTx) && (
            <Tooltip>
              <Tooltip.Trigger>
                <Chip
                  size="sm"
                  variant="secondary"
                  className="px-2 py-0.5 rounded-md bg-slate-950/80 border border-slate-800/80 text-slate-400 text-[10.5px] font-mono shrink-0 shadow-sm cursor-help"
                >
                  {(command.network as any)?.dlc || (command as any).dlc || 8} Bytes
                </Chip>
              </Tooltip.Trigger>
              <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-slate-900 border border-slate-700 text-slate-200 shadow-xl z-50">
                Data Length Code (CAN Frame Payload Size)
              </Tooltip.Content>
            </Tooltip>
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
        {/* Zone 1: Tested Vehicle */}
        {(() => {
          const testedVehicle = getCommandTestedVehicle(command);

          if (!testedVehicle) {
            return (
              <div className="text-xs text-slate-500 mb-2.5 flex items-center gap-1.5 min-w-0">
                {command.subcategory ? (
                  <Chip
                    size="sm"
                    variant="secondary"
                    className="text-slate-400 font-medium truncate text-[11px] bg-slate-900/60 px-2 py-0.5 rounded border border-slate-800/80"
                    title={`Subsystem: ${command.subcategory}`}
                  >
                    {command.subcategory}
                  </Chip>
                ) : null}
              </div>
            );
          }

          return (
            <div className="mb-2.5 min-w-0">
              <Chip 
                size="sm"
                color="success"
                variant="soft"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-[11px] font-medium min-w-0 max-w-full shadow-sm"
                title={`Tested vehicle: ${testedVehicle}`}
              >
                <Car className="w-3.5 h-3.5 text-emerald-400 shrink-0 mr-1" />
                <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-400/80 shrink-0">Tested Vehicle:</span>
                <span className="truncate text-emerald-200 font-medium">{testedVehicle}</span>
              </Chip>
            </div>
          );
        })()}
      </div>

      {/* Zone 2: Payload preview (Elastic zone that absorbs height variations) */}
      <div className="flex-1 flex flex-col justify-start min-w-0 mb-3">
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
                    className={`group/opt p-1.5 rounded text-[11px] font-mono flex items-center justify-between gap-2 ${
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
                      {onAddToAutomation && (
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onAddToAutomation(command, 'action', opt);
                          }}
                          title={`Add "${opt.label}" to Automation`}
                          className="opacity-0 group-hover/opt:opacity-100 p-0.5 hover:bg-slate-700 text-cyan-400 rounded transition"
                        >
                          <Zap className="w-3 h-3 fill-current" />
                        </button>
                      )}
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
          ) : (command.network?.min !== undefined && command.network?.max !== undefined) || command.ha_metadata?.domain === 'number' || (command as any).type === 'linear_scale' ? (
            <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800 text-xs flex flex-col gap-2 min-w-0">
              <div className="flex items-center justify-between gap-1 text-[11px] font-medium min-w-0">
                <span className="flex items-center gap-1 text-cyan-300 truncate">
                  <Sliders className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>Continuous Numeric Range</span>
                </span>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/60 shrink-0">
                  Target: {command.network?.state_byte || command.network?.action_byte || (command.network as any)?.byte || 'D1'}
                </span>
              </div>
              
              {/* Range & Slider Visual */}
              <div className="flex items-center justify-between text-slate-400 font-mono text-[11px] px-0.5">
                <span className="font-semibold text-slate-300">
                  {command.network?.min ?? 0}{(command.network as any)?.unit || (command.subcategory === 'Audio & Media' ? ' dB' : '')}
                </span>
                <div className="flex-1 mx-2 h-1.5 rounded-full bg-slate-800 overflow-hidden relative">
                  <div 
                    className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-cyan-500 to-emerald-400 rounded-full"
                    style={{ width: '50%' }}
                  />
                </div>
                <span className="font-semibold text-slate-300">
                  +{command.network?.max ?? 100}{(command.network as any)?.unit || (command.subcategory === 'Audio & Media' ? ' dB' : '')}
                </span>
              </div>

              {/* Base Frame Hex Preview if available */}
              {Array.isArray((command.network as any)?.base_payload) && (command.network as any).base_payload.length === 8 && (
                <div className="grid grid-cols-8 gap-0.5 pt-0.5">
                  {(command.network as any).base_payload.map((byteVal: any, idx: number) => {
                    const dKey = `D${idx + 1}`;
                    const isTarget = dKey === (command.network?.state_byte || command.network?.action_byte || (command.network as any)?.byte);
                    const hexStr = typeof byteVal === 'string' 
                      ? byteVal.replace(/^0x/i, '').toUpperCase().padStart(2, '0')
                      : (Number(byteVal) & 0xFF).toString(16).toUpperCase().padStart(2, '0');
                    return (
                      <div 
                        key={idx}
                        className={`flex flex-col items-center justify-center p-0.5 rounded text-[9.5px] font-mono ${
                          isTarget 
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold ring-1 ring-cyan-500/30' 
                            : 'bg-slate-900/60 text-slate-500 border border-slate-800/40'
                        }`}
                        title={`${dKey}: 0x${hexStr}${isTarget ? ' (Dynamic Value Byte)' : ' (Static Base Frame)'}`}
                      >
                        <span className="text-[7.5px] text-slate-400">{dKey}</span>
                        <span>{isTarget ? 'VAR' : hexStr}</span>
                      </div>
                    );
                  })}
                </div>
              )}
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

      {/* Zone 3: Bottom Pinned Section (Tags, Contributor, Footer Actions) */}
      <div className="mt-auto flex flex-col gap-2.5 min-w-0">
        {/* Details below grids/options: HA domain, type, requirements, and tags */}
        {(command.ha_domain || command.type || command.requires_feature || (command.tags && command.tags.length > 0)) && (
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {command.ha_domain && (() => {
              const domainStyle = getHaDomainBadgeStyle(command.ha_domain);
              return (
                <Chip
                  size="sm"
                  variant="secondary"
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-mono font-medium border shrink-0 ${domainStyle.bg} ${domainStyle.text} ${domainStyle.border}`}
                  title={`Home Assistant Domain: ${command.ha_domain}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full mr-1 ${domainStyle.dot}`} />
                  ha:{command.ha_domain}
                </Chip>
              );
            })()}
            {command.type && (
              <Chip
                size="sm"
                variant="secondary"
                className="px-2 py-0.5 rounded text-[10.5px] font-mono bg-slate-900 text-slate-400 border border-slate-800 shrink-0"
              >
                {command.type}
              </Chip>
            )}
            {command.requires_feature && (
              <Chip
                size="sm"
                color="success"
                variant="soft"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-700/40 truncate max-w-full"
              >
                <Car className="w-3 h-3 shrink-0 mr-1" />
                <span className="truncate">Requires: {command.requires_feature}</span>
              </Chip>
            )}
            {command.tags?.map(tag => (
              <Chip
                key={tag}
                size="sm"
                variant="secondary"
                className="text-[10px] text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700 truncate max-w-[140px]"
              >
                #{tag}
              </Chip>
            ))}
          </div>
        )}

        {/* Contributor Attribution */}
        {(() => {
          const contributors = getCommandContributors(command);
          if (contributors.length === 0) return null;
          return (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 pt-2 border-t border-slate-800/60 mb-1 min-w-0">
              <span className="text-[10px] text-slate-500 font-medium shrink-0">
                {contributors.length > 1 ? 'Contributors:' : 'Contributed by:'}
              </span>
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                {contributors.map((contrib, idx) => {
                  const handle = contrib.github ? contrib.github.replace(/^@/, '') : '';
                  return (
                    <Badge
                      key={idx}
                      size="sm"
                      variant="secondary"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700/70 text-[10.5px] max-w-[170px] truncate"
                      title={contrib.notes ? `${contrib.name || handle || 'Contributor'}: ${contrib.notes}` : (contrib.name || handle)}
                    >
                      {handle ? (
                        <a
                          href={`https://github.com/${handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 font-mono transition truncate"
                          title={`View @${handle} on GitHub`}
                        >
                          <Github className="w-3 h-3 text-slate-400 shrink-0 mr-1" />
                          <span className="truncate">@{handle}</span>
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-300 font-medium truncate">
                          <User className="w-3 h-3 text-slate-400 shrink-0 mr-1" />
                          <span className="truncate">{contrib.name}</span>
                        </span>
                      )}
                      {contrib.name && handle && (
                        <span className="text-[9.5px] text-slate-400 truncate ml-1">
                          ({contrib.name})
                        </span>
                      )}
                      {contrib.role && (
                        <span className="text-[9px] text-slate-400 uppercase tracking-wider bg-slate-800/90 px-1 py-0.5 rounded ml-1">
                          {contrib.role}
                        </span>
                      )}
                    </Badge>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Footer action buttons */}
        <div className="flex items-center justify-between pt-2.5 border-t border-slate-800/80 text-slate-400">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1">
            <ExternalLink className="w-3 h-3 text-slate-400" />
            <span>Details</span>
          </span>

          {onToggleSelectForAutomation && (
            <Checkbox
              isSelected={isSelectedForAutomation || false}
              onChange={() => onToggleSelectForAutomation(command)}
              aria-label={`Select ${command.name} for automation`}
              className="px-2 py-0.5 rounded-md border border-slate-800 bg-slate-950/60 hover:border-slate-700 cursor-pointer select-none"
            >
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Checkbox.Content className="text-[10.5px] font-semibold text-slate-300">
                Automate
              </Checkbox.Content>
            </Checkbox>
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
          {onAddToAutomation && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                onAddToAutomation(command);
              }}
              title="Add command to automation"
              className="p-1.5 hover:text-cyan-400 hover:bg-slate-800 rounded transition text-slate-400"
            >
              <Zap className="w-3.5 h-3.5" />
            </button>
          )}
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
  </Card>
  );
};

export const CommandCard = React.memo(CommandCardComponent);
