import React from 'react';
import { Checkbox } from '@heroui/react';
import { AutomationRule } from '../../types/automation';
import { Tag } from 'lucide-react';
import { HaToggleSwitch } from './HaToggleSwitch';
import { AutomationActionMenu } from './AutomationActionMenu';

export interface SwipeableRuleItemProps {
  rule: AutomationRule;
  idx: number;
  isSelected: boolean;
  isSelectMode: boolean;
  isCheckedForDelete: boolean;
  onToggleCheck: (id: string) => void;
  onSelect: (id: string) => void;
  onDuplicate: (rule: AutomationRule) => void;
  onDelete: (id: string) => void;
  onToggleEnabled?: (id: string, enabled: boolean) => void;
  onRunActions?: (rule: AutomationRule) => void;
  onShowTraces?: (rule: AutomationRule) => void;
  onMoreInfo?: (rule: AutomationRule) => void;
  onEditSettings?: (rule: AutomationRule) => void;
  onEditCategory?: (rule: AutomationRule) => void;
}

export const SwipeableRuleItem: React.FC<SwipeableRuleItemProps> = ({
  rule,
  idx,
  isSelected,
  isSelectMode,
  isCheckedForDelete,
  onToggleCheck,
  onSelect,
  onDuplicate,
  onDelete,
  onToggleEnabled,
  onRunActions,
  onShowTraces,
  onMoreInfo,
  onEditSettings,
  onEditCategory
}) => {
  const handleClick = () => {
    if (isSelectMode) {
      onToggleCheck(rule.id);
    } else {
      onSelect(rule.id);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`relative z-10 p-2.5 rounded-xl cursor-pointer border text-left flex items-center justify-between gap-2.5 transition-all duration-150 select-none ${
        isSelected
          ? 'bg-surface-secondary border-accent shadow-sm text-foreground ring-1 ring-accent/30'
          : 'bg-surface border-border text-foreground hover:bg-surface-secondary hover:border-border-secondary'
      }`}
    >
      {/* Left side: Selection Checkbox / Status Indicator + Title + Badges */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {isSelectMode ? (
          <div onClick={(e) => e.stopPropagation()} className="flex items-center flex-shrink-0">
            <Checkbox
              isSelected={isCheckedForDelete}
              onChange={() => onToggleCheck(rule.id)}
              aria-label={`Select rule ${rule.name || rule.id}`}
              className="cursor-pointer"
            >
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox>
          </div>
        ) : (
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
              rule.enabled ? 'bg-success' : 'bg-muted/50'
            }`}
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold truncate leading-tight">
              {rule.name || `Rule #${idx + 1}`}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-muted font-mono mt-0.5 flex-wrap">
            {rule.category && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-surface-tertiary text-accent border border-border font-sans text-[9px] font-medium truncate max-w-[110px]">
                <Tag className="w-2.5 h-2.5 flex-shrink-0" />
                <span className="truncate">{rule.category}</span>
              </span>
            )}
            {rule.ha_expose && (
              <span className="px-1 py-0.2 rounded bg-warning-soft text-warning-soft-foreground border border-warning/30 text-[9px]">
                HA
              </span>
            )}
            <span>
              {(rule.triggers || []).length}T · {(rule.conditions || []).length}C · {(rule.actions || []).length}A
            </span>
            {rule.cooldown_ms ? (
              <span className="text-muted hidden sm:inline">
                {rule.cooldown_ms}ms
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Right side: Emulate the screenshot with HaToggleSwitch + 3-dots Dropdown Menu */}
      {!isSelectMode && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 flex-shrink-0"
        >
          {/* Toggle Switch */}
          <HaToggleSwitch
            checked={rule.enabled}
            onChange={(checked) => onToggleEnabled && onToggleEnabled(rule.id, checked)}
            size="sm"
            ariaLabel={`Toggle ${rule.name || rule.id}`}
          />

          {/* 3-dots Dropdown Menu */}
          <AutomationActionMenu
            rule={rule}
            buttonSize="sm"
            align="right"
            onToggleEnabled={(enabled) => onToggleEnabled && onToggleEnabled(rule.id, enabled)}
            onDuplicate={() => onDuplicate(rule)}
            onDelete={() => onDelete(rule.id)}
            onRunActions={() => onRunActions && onRunActions(rule)}
            onShowTraces={() => onShowTraces && onShowTraces(rule)}
            onMoreInfo={() => onMoreInfo && onMoreInfo(rule)}
            onEditSettings={() => onEditSettings && onEditSettings(rule)}
            onEditCategory={() => onEditCategory && onEditCategory(rule)}
          />
        </div>
      )}
    </div>
  );
};
