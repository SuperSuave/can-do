import React from 'react';
import { Chip, Badge, Card, Button } from '@heroui/react';
import { Command, CommandRole } from '../types/catalog';
import {
  Radio,
  Sliders,
  Play,
  Edit3,
  Zap,
  Sparkles
} from 'lucide-react';

interface CommandCardProps {
  command: Command;
  onSelect: (cmd: Command) => void;
  isModified?: boolean;
  isNew?: boolean;
  onAddToAutomation?: (cmd: Command, role?: CommandRole) => void;
}

const ROLE_ORDER: CommandRole[] = ['trigger', 'condition', 'action'];

const ROLE_CONFIG: Record<
  CommandRole,
  { label: string; color: 'warning' | 'accent' | 'success'; pillClass: string; Icon: React.FC<{ className?: string }> }
> = {
  trigger: { label: 'Trigger', color: 'warning', pillClass: 'trig-pill', Icon: Radio },
  condition: { label: 'Condition', color: 'accent', pillClass: 'cond-pill', Icon: Sliders },
  action: { label: 'Action', color: 'success', pillClass: 'act-pill', Icon: Play }
};

const getLeftBorderGradient = (command: Command) => {
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

  const stops: string[] = [`var(--surface) 0%`, `${colors[0]} ${fadePct}%`];
  const step = 100 / colors.length;
  const blendHalf = 2.5;
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

const CommandCardComponent: React.FC<CommandCardProps> = ({
  command,
  onSelect,
  isModified,
  isNew,
  onAddToAutomation
}) => {
  const orderedRoles = ROLE_ORDER.filter(r => command.roles?.includes(r));
  const rolesToDisplay: CommandRole[] = orderedRoles.length > 0 ? orderedRoles : ['trigger'];

  return (
    <Card
      onClick={() => onSelect(command)}
      className={`group relative flex flex-col justify-between gap-3 min-h-[160px] rounded-[12px] border bg-surface p-4 pl-5 transition-all duration-200 hover:border-border-secondary hover:shadow-md cursor-pointer min-w-0 ${
        isNew
          ? 'border-success/50'
          : isModified
          ? 'border-warning/50'
          : 'border-border'
      }`}
    >
      {/* Dynamic multi-role split left border indicator */}
      <div
        className="absolute left-[6px] top-[12px] bottom-[12px] w-[5px] pointer-events-none"
        style={{ background: getLeftBorderGradient(command) }}
      />

      {/* Draft badge indicator */}
      {(isNew || isModified) && (
        <div className="absolute -top-2.5 right-3 shadow">
          {isNew ? (
            <Badge
              size="sm"
              color="success"
              variant="soft"
              className="text-[10px] font-bold uppercase tracking-wider bg-overlay border border-success/50 text-success-soft-foreground"
            >
              <Sparkles className="w-3 h-3 mr-1" /> New
            </Badge>
          ) : (
            <Badge
              size="sm"
              color="warning"
              variant="soft"
              className="text-[10px] font-bold uppercase tracking-wider bg-overlay border border-warning/50 text-warning-soft-foreground"
            >
              <Edit3 className="w-3 h-3 mr-1" /> Modified
            </Badge>
          )}
        </div>
      )}

      {/* Top content: Role pills + full command name */}
      <div className="flex flex-col gap-2.5 min-w-0">
        <div className="flex flex-wrap items-center gap-1 min-w-0">
          {rolesToDisplay.map(role => {
            const { label, color, pillClass, Icon } = ROLE_CONFIG[role];
            return (
              <Chip
                key={role}
                size="sm"
                color={color}
                variant="soft"
                className={`${pillClass} inline-flex items-center gap-1 rounded-full !px-1.5 !py-0.5 text-[10px] font-bold uppercase tracking-wide leading-none shrink-0`}
              >
                <Icon className="w-2.5 h-2.5 shrink-0" />
                <span>{label}</span>
              </Chip>
            );
          })}
        </div>

        <h3 className="text-[15px] font-semibold text-foreground group-hover:text-accent transition-colors leading-snug break-words">
          {command.name}
        </h3>
      </div>

      {/* Bottom row: Quick Add to Automation */}
      {onAddToAutomation && (
        <div onClick={e => e.stopPropagation()} className="flex items-center justify-end pt-1 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            onPress={() => onAddToAutomation(command)}
            aria-label={`Add ${command.name} to automation`}
            className="h-7 min-w-0 px-2.5 rounded-md text-xs font-semibold text-accent-soft-foreground bg-accent-soft hover:bg-accent hover:text-accent-foreground border border-accent/30 inline-flex items-center gap-1 transition"
          >
            <Zap className="w-3 h-3 fill-current shrink-0" />
            <span>Add</span>
          </Button>
        </div>
      )}
    </Card>
  );
};

export const CommandCard = React.memo(CommandCardComponent);
