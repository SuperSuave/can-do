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
            <Radio className="w-3 h-3 text-warning" />
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
            <Sliders className="w-3 h-3 text-accent" />
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
            <Play className="w-3 h-3 text-success" />
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
      if (command.type === 'choose') colors = ['#a855f7'];
      else if (command.type === 'ifthen') colors = ['var(--accent)'];
      else colors = ['var(--muted)'];
    } else {
      const roleColors: Record<CommandRole, string> = {
        trigger: 'var(--warning)',
        condition: 'var(--accent)',
        action: 'var(--success)'
      };
      colors = activeRoles.map(r => roleColors[r]);
    }

    const fadePct = colors.length === 1 ? 25 : Math.max(12, Math.round(30 / colors.length));
    const bottomFadePct = 100 - fadePct;

    if (colors.length === 1) {
      const col = colors[0];
      return `linear-gradient(to bottom, var(--surface) 0%, ${col} ${fadePct}%, ${col} ${bottomFadePct}%, var(--surface) 100%)`;
    }

    const stops: string[] = [];
    stops.push(`var(--surface) 0%`, `${colors[0]} ${fadePct}%`);

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

    stops.push(`${colors[colors.length - 1]} ${bottomFadePct}%`, `var(--surface) 100%`);
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
      className={`group relative flex flex-col rounded-[12px] border bg-surface p-4 sm:p-5 transition-all duration-200 hover:border-border-secondary hover:shadow-md cursor-pointer min-w-0 ${
        isNew
          ? 'border-success/50'
          : isModified
          ? 'border-warning/50'
          : 'border-border'
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
              className="text-[10px] font-bold uppercase tracking-wider bg-overlay border border-success/50 text-success-soft-foreground"
            >
              <Sparkles className="w-3 h-3 mr-1" /> New Contribution
            </Badge>
          ) : (
            <Badge
              size="sm"
              color="warning"
              variant="soft"
              className="text-[10px] font-bold uppercase tracking-wider bg-overlay border border-warning/50 text-warning-soft-foreground"
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
                <Radio className="w-3 h-3 text-warning" />
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
                  className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-md bg-surface-secondary border border-border text-xs font-mono shrink-0 shadow-sm cursor-help"
                >
                  {hasRx && hasTx && rxBus === txBus ? (
                    // Unified single bus display when RX and TX share the same bus
                    <div className="inline-flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                        Bus {rxBus}
                      </span>
                      <span className="text-muted/60">•</span>
                      {rxCanId === txCanId ? (
                        <span className="inline-flex items-center gap-1 text-accent-soft-foreground font-semibold">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted">RX/TX</span>
                          <Badge size="sm" color="accent" variant="soft" className="font-mono text-accent-soft-foreground font-semibold px-1 py-0">{rxCanId}</Badge>
                        </span>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          {rxCanId && (
                            <span className="inline-flex items-center gap-1 text-accent-soft-foreground font-semibold">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-accent">RX</span>
                              <Badge size="sm" color="accent" variant="soft" className="font-mono text-accent-soft-foreground font-semibold px-1 py-0">{rxCanId}</Badge>
                            </span>
                          )}
                          {rxCanId && txCanId && <span className="text-muted/60">•</span>}
                          {txCanId && (
                            <span className="inline-flex items-center gap-1 text-success-soft-foreground font-semibold">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-success">TX</span>
                              <Badge size="sm" color="success" variant="soft" className="font-mono text-success-soft-foreground font-semibold px-1 py-0">{txCanId}</Badge>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    // Segmented display when buses differ or single RX/TX
                    <div className="inline-flex items-center gap-2 divide-x divide-separator">
                      {hasRx && (
                        <div className="inline-flex items-center gap-1.5 text-accent-soft-foreground">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                            RX Bus {rxBus}
                          </span>
                          {rxCanId && (
                            <>
                              <span className="text-muted/60">•</span>
                              <Badge size="sm" color="accent" variant="soft" className="font-semibold font-mono text-accent-soft-foreground px-1 py-0">{rxCanId}</Badge>
                            </>
                          )}
                        </div>
                      )}
                      {hasTx && (
                        <div className={`inline-flex items-center gap-1.5 text-success-soft-foreground ${hasRx ? 'pl-2' : ''}`}>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                            TX Bus {txBus}
                          </span>
                          {txCanId && (
                            <>
                              <span className="text-muted/60">•</span>
                              <Badge size="sm" color="success" variant="soft" className="font-semibold font-mono text-success-soft-foreground px-1 py-0">{txCanId}</Badge>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Chip>
              </Tooltip.Trigger>
              <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-overlay border border-border text-overlay-foreground shadow-overlay z-50">
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
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-surface-secondary border border-border text-muted shrink-0 font-mono text-xs"
            >
              <span className="text-[10px] uppercase font-bold text-muted">Virtual / OSD</span>
            </Chip>
          )}

          {/* DLC length pill */}
          {(hasRx || hasTx) && (
            <Tooltip>
              <Tooltip.Trigger>
                <Chip
                  size="sm"
                  variant="secondary"
                  className="px-2 py-0.5 rounded-md bg-surface-secondary border border-border text-muted text-[10.5px] font-mono shrink-0 shadow-sm cursor-help"
                >
                  {(command.network as any)?.dlc || (command as any).dlc || 8} Bytes
                </Chip>
              </Tooltip.Trigger>
              <Tooltip.Content className="px-2.5 py-1 text-xs rounded-md bg-overlay border border-border text-overlay-foreground shadow-overlay z-50">
                Data Length Code (CAN Frame Payload Size)
              </Tooltip.Content>
            </Tooltip>
          )}
        </div>

        {/* Command Title & ID / Category with MDI Icon */}
        <div className="flex items-center gap-2.5 mb-1 min-w-0">
          <div
            className="w-7 h-7 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent shrink-0 group-hover:border-accent/60 transition-colors shadow-sm"
            title={`MDI: ${cardMdiIcon}`}
          >
            <MdiIcon icon={cardMdiIcon} className="w-4 h-4" />
          </div>
          <h3 className="text-base font-semibold text-foreground group-hover:text-accent transition-colors truncate" title={command.name}>
            {command.name}
          </h3>
        </div>
        {/* Zone 1: Tested Vehicle */}
        {(() => {
          const testedVehicle = getCommandTestedVehicle(command);

          if (!testedVehicle) {
            return (
              <div className="text-xs text-muted mb-2.5 flex items-center gap-1.5 min-w-0">
                {command.subcategory ? (
                  <Chip
                    size="sm"
                    variant="secondary"
                    className="text-muted font-medium truncate text-[11px] bg-surface-secondary px-2 py-0.5 rounded border border-border"
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
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-success-soft border border-success/30 text-success-soft-foreground text-[11px] font-medium min-w-0 max-w-full shadow-sm"
                title={`Tested vehicle: ${testedVehicle}`}
              >
                <Car className="w-3.5 h-3.5 text-success shrink-0 mr-1" />
                <span className="text-[10px] uppercase font-bold tracking-wider text-success shrink-0">Tested Vehicle:</span>
                <span className="truncate font-medium">{testedVehicle}</span>
              </Chip>
            </div>
          );
        })()}
      </div>

      {/* Zone 2: Payload preview (Elastic zone that absorbs height variations) */}
      <div className="flex-1 flex flex-col justify-start min-w-0 mb-3">
          {command.options && command.options.length > 0 ? (
            <div className="bg-surface-secondary rounded-lg p-2 border border-border text-xs min-w-0">
              <div className="flex items-center justify-between text-muted mb-1.5 font-medium gap-1 min-w-0">
                <span className="flex items-center gap-1 text-[11px] text-foreground truncate">
                  <Layers className="w-3.5 h-3.5 text-accent shrink-0" />
                  <span className="truncate">{command.options.length} Defined States:</span>
                </span>
                <span className="text-[10px] text-muted truncate shrink-0">
                  Default: {command.options.find(o => o.default)?.label || command.options[0].label}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                {command.options.slice(0, 3).map((opt, i) => (
                  <div
                    key={i}
                    className={`group/opt p-1.5 rounded text-[11px] font-mono flex items-center justify-between gap-2 ${
                      opt.default
                        ? 'bg-accent-soft text-accent-soft-foreground border border-accent/35'
                        : 'bg-surface-tertiary text-foreground border border-border'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 shrink-0 min-w-0">
                      {opt.state_value !== undefined && opt.state_value !== '' && (
                        <span className="text-[10px] px-1 py-0.2 rounded bg-surface-secondary text-accent border border-border font-mono font-semibold">
                          {opt.state_value}
                        </span>
                      )}
                      <span className="font-semibold truncate">{opt.label}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-end min-w-0">
                      {(opt.match || opt.match_payload) && (
                        <span className="text-[10px] text-accent-soft-foreground bg-accent-soft px-1 py-0.5 rounded border border-accent/30 truncate font-mono" title="RX Match State">
                          RX: {formatByteMap(opt.match || opt.match_payload)}
                        </span>
                      )}
                      {opt.steps && opt.steps.length > 0 ? (
                        opt.steps.map((st, sidx) => (
                          <span key={sidx} className="text-[10px] text-success-soft-foreground bg-success-soft px-1 py-0.5 rounded border border-success/30 truncate">
                            TX: {formatByteMap(st.payload)} {st.repeat ? <strong className="text-warning font-bold">x{st.repeat}</strong> : null}
                          </span>
                        ))
                      ) : (opt.payload || opt.to_payload) ? (
                        <span className="text-[10px] text-success-soft-foreground bg-success-soft px-1 py-0.5 rounded border border-success/30 truncate font-mono" title="TX Action">
                          TX: {formatByteMap(opt.payload || opt.to_payload)} {opt.repeat ? <strong className="text-warning font-bold">x{opt.repeat}</strong> : null}
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
                          className="opacity-0 group-hover/opt:opacity-100 p-0.5 hover:bg-default-hover text-accent rounded transition"
                        >
                          <Zap className="w-3 h-3 fill-current" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {command.options.length > 3 && (
                  <span className="text-[10px] text-muted px-1">
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
            <div className="bg-surface-secondary rounded-lg p-2.5 border border-border text-xs flex items-center justify-between min-w-0">
              <span className="text-foreground font-medium flex items-center gap-1 shrink-0">
                <Layers className="w-3.5 h-3.5 text-warning shrink-0" />
                Frame Sequence:
              </span>
              <span className="font-mono text-accent font-medium truncate ml-2">
                {command.steps.length} Steps {command.delay_ms ? `(${command.delay_ms}ms)` : ''}
              </span>
            </div>
          ) : (command.network?.min !== undefined && command.network?.max !== undefined) || command.ha_metadata?.domain === 'number' || (command as any).type === 'linear_scale' ? (
            <div className="bg-surface-secondary rounded-lg p-2.5 border border-border text-xs flex flex-col gap-2 min-w-0">
              <div className="flex items-center justify-between gap-1 text-[11px] font-medium min-w-0">
                <span className="flex items-center gap-1 text-accent-soft-foreground truncate">
                  <Sliders className="w-3.5 h-3.5 text-accent shrink-0" />
                  <span>Continuous Numeric Range</span>
                </span>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground border border-accent/30 shrink-0">
                  Target: {command.network?.state_byte || command.network?.action_byte || (command.network as any)?.byte || 'D1'}
                </span>
              </div>
              
              {/* Range & Slider Visual */}
              <div className="flex items-center justify-between text-muted font-mono text-[11px] px-0.5">
                <span className="font-semibold text-foreground">
                  {command.network?.min ?? 0}{(command.network as any)?.unit || (command.subcategory === 'Audio & Media' ? ' dB' : '')}
                </span>
                <div className="flex-1 mx-2 h-1.5 rounded-full bg-surface-tertiary overflow-hidden relative">
                  <div 
                    className="absolute top-0 bottom-0 left-0 bg-accent rounded-full"
                    style={{ width: '50%' }}
                  />
                </div>
                <span className="font-semibold text-foreground">
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
                            ? 'bg-accent/20 text-accent border border-accent/50 font-bold ring-1 ring-accent/30' 
                            : 'bg-surface-tertiary text-muted border border-border'
                        }`}
                        title={`${dKey}: 0x${hexStr}${isTarget ? ' (Dynamic Value Byte)' : ' (Static Base Frame)'}`}
                      >
                        <span className="text-[7.5px] text-muted">{dKey}</span>
                        <span>{isTarget ? 'VAR' : hexStr}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted bg-surface-secondary p-2 rounded border border-border italic truncate">
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
                className="px-2 py-0.5 rounded text-[10.5px] font-mono bg-surface-secondary text-muted border border-border shrink-0"
              >
                {command.type}
              </Chip>
            )}
            {command.requires_feature && (
              <Chip
                size="sm"
                color="success"
                variant="soft"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-success-soft-foreground bg-success-soft px-2 py-0.5 rounded border border-success/30 truncate max-w-full"
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
                className="text-[10px] text-muted bg-surface-secondary px-1.5 py-0.5 rounded border border-border truncate max-w-[140px]"
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
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted pt-2 border-t border-separator mb-1 min-w-0">
              <span className="text-[10px] text-muted font-medium shrink-0">
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
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-[10.5px] max-w-[170px] truncate"
                      title={contrib.notes ? `${contrib.name || handle || 'Contributor'}: ${contrib.notes}` : (contrib.name || handle)}
                    >
                      {handle ? (
                        <a
                          href={`https://github.com/${handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-accent hover:underline font-mono transition truncate"
                          title={`View @${handle} on GitHub`}
                        >
                          <Github className="w-3 h-3 text-muted shrink-0 mr-1" />
                          <span className="truncate">@{handle}</span>
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-foreground font-medium truncate">
                          <User className="w-3 h-3 text-muted shrink-0 mr-1" />
                          <span className="truncate">{contrib.name}</span>
                        </span>
                      )}
                      {contrib.name && handle && (
                        <span className="text-[9.5px] text-muted truncate ml-1">
                          ({contrib.name})
                        </span>
                      )}
                      {contrib.role && (
                        <span className="text-[9px] text-muted uppercase tracking-wider bg-surface-tertiary px-1 py-0.5 rounded ml-1">
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
        <div className="flex items-center justify-between pt-2.5 border-t border-separator text-muted">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted hover:text-foreground flex items-center gap-1">
            <ExternalLink className="w-3 h-3 text-muted" />
            <span>Details</span>
          </span>

          {onToggleSelectForAutomation && (
            <Checkbox
              isSelected={isSelectedForAutomation || false}
              onChange={() => onToggleSelectForAutomation(command)}
              aria-label={`Select ${command.name} for automation`}
              className="px-2 py-0.5 rounded-md border border-border bg-surface-secondary hover:border-border-secondary cursor-pointer select-none"
            >
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Checkbox.Content className="text-[10.5px] font-semibold text-foreground">
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
            className="p-1.5 hover:text-accent hover:bg-surface-secondary rounded transition"
          >
            {copied ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
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
              className="p-1.5 hover:text-accent hover:bg-surface-secondary rounded transition text-muted"
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
            className="p-1.5 hover:text-accent hover:bg-surface-secondary rounded transition"
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
            className="p-1.5 hover:text-warning hover:bg-surface-secondary rounded transition"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          {confirmDelete ? (
            <div
              className="flex items-center gap-1.5 bg-danger-soft border border-danger/40 px-2 py-0.5 rounded-md animate-in fade-in"
              onClick={e => e.stopPropagation()}
            >
              <span className="text-[10px] font-semibold text-danger-soft-foreground">Delete?</span>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onDelete(command.id);
                  setConfirmDelete(false);
                }}
                title="Confirm deletion"
                className="px-1.5 py-0.5 bg-danger hover:bg-danger-hover text-danger-foreground rounded font-bold text-[10px] transition shadow-sm"
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
                className="px-1.5 py-0.5 bg-surface-tertiary hover:bg-default-hover text-foreground rounded text-[10px] transition"
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
              className="p-1.5 hover:text-danger hover:bg-surface-secondary rounded transition"
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
