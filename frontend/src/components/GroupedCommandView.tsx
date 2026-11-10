import React, { useState, useMemo, useEffect } from 'react';
import { Disclosure } from '@heroui/react';
import { Command, CommandRole, CommandOption } from '../types/catalog';
import { CommandCard } from './CommandCard';
import {
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Layers
} from 'lucide-react';

interface GroupedCommandViewProps {
  commands: Command[];
  selectedCategory: string;
  onSelectCommand: (cmd: Command) => void;
  onEditCommand: (cmd: Command) => void;
  onDuplicateCommand: (cmd: Command) => void;
  onDeleteCommand: (cmdId: string) => void;
  draftAddedIds: string[];
  draftModifiedIds: string[];
  onSelectSubcategory?: (subcat: string) => void;
  selectedCommandIdsForAutomation?: Set<string>;
  onToggleSelectForAutomation?: (cmd: Command) => void;
  onAddToAutomation?: (cmd: Command, role?: CommandRole, option?: CommandOption) => void;
  expandAllSignal?: number;
  collapseAllSignal?: number;
}

interface CommandSubgroup {
  name: string;
  commands: Command[];
  triggersCount: number;
  conditionsCount: number;
  actionsCount: number;
}

interface CommandCategoryGroup {
  id: string;
  categoryName: string;
  subgroups: CommandSubgroup[];
  totalCommands: number;
  triggersCount: number;
  conditionsCount: number;
  actionsCount: number;
}

export const GroupedCommandView: React.FC<GroupedCommandViewProps> = ({
  commands,
  selectedCategory: _selectedCategory,
  onSelectCommand,
  onEditCommand,
  onDuplicateCommand,
  onDeleteCommand,
  draftAddedIds,
  draftModifiedIds,
  onSelectSubcategory,
  selectedCommandIdsForAutomation,
  onToggleSelectForAutomation,
  onAddToAutomation,
  expandAllSignal,
  collapseAllSignal
}) => {
  // Compute hierarchical groups: Category -> Subcategories
  const categoryGroups = useMemo(() => {
    const catMap = new Map<string, {
      id: string;
      categoryName: string;
      subMap: Map<string, CommandSubgroup>;
      totalCommands: number;
      triggersCount: number;
      conditionsCount: number;
      actionsCount: number;
    }>();

    commands.forEach(cmd => {
      const cat = cmd.category || 'Uncategorized';
      const sub = cmd.subcategory || 'General';

      if (!catMap.has(cat)) {
        catMap.set(cat, {
          id: cat,
          categoryName: cat,
          subMap: new Map(),
          totalCommands: 0,
          triggersCount: 0,
          conditionsCount: 0,
          actionsCount: 0
        });
      }

      const catEntry = catMap.get(cat)!;
      catEntry.totalCommands += 1;
      if (cmd.roles.includes('trigger')) catEntry.triggersCount += 1;
      if (cmd.roles.includes('condition')) catEntry.conditionsCount += 1;
      if (cmd.roles.includes('action')) catEntry.actionsCount += 1;

      if (!catEntry.subMap.has(sub)) {
        catEntry.subMap.set(sub, {
          name: sub,
          commands: [],
          triggersCount: 0,
          conditionsCount: 0,
          actionsCount: 0
        });
      }

      const subEntry = catEntry.subMap.get(sub)!;
      subEntry.commands.push(cmd);
      if (cmd.roles.includes('trigger')) subEntry.triggersCount += 1;
      if (cmd.roles.includes('condition')) subEntry.conditionsCount += 1;
      if (cmd.roles.includes('action')) subEntry.actionsCount += 1;
    });

    return Array.from(catMap.values())
      .map(entry => {
        // Sort subgroups: put specific subcategories first, 'General' last
        const subgroups = Array.from(entry.subMap.values()).sort((a, b) => {
          if (a.name === 'General' && b.name !== 'General') return 1;
          if (b.name === 'General' && a.name !== 'General') return -1;
          return a.name.localeCompare(b.name);
        });

        return {
          id: entry.id,
          categoryName: entry.categoryName,
          subgroups,
          totalCommands: entry.totalCommands,
          triggersCount: entry.triggersCount,
          conditionsCount: entry.conditionsCount,
          actionsCount: entry.actionsCount
        } as CommandCategoryGroup;
      })
      .sort((a, b) => a.categoryName.localeCompare(b.categoryName));
  }, [commands]);

  // Set of collapsed category group IDs
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Listen for expand/collapse signals triggered from parent controls
  useEffect(() => {
    if (expandAllSignal && expandAllSignal > 0) {
      setCollapsedGroups(new Set());
    }
  }, [expandAllSignal]);

  useEffect(() => {
    if (collapseAllSignal && collapseAllSignal > 0) {
      setCollapsedGroups(new Set(categoryGroups.map(g => g.id)));
    }
  }, [collapseAllSignal, categoryGroups]);

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  if (categoryGroups.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4 sm:space-y-5 min-w-0">
      {categoryGroups.map(catGroup => {
        const isCollapsed = collapsedGroups.has(catGroup.id);

        return (
          <Disclosure
            key={catGroup.id}
            isExpanded={!isCollapsed}
            onExpandedChange={() => toggleGroupCollapse(catGroup.id)}
            className="rounded-2xl border border-border bg-surface overflow-hidden shadow-surface transition min-w-0"
          >
            {/* Top-Level Category Header */}
            <Disclosure.Heading className="m-0 p-0">
              <Disclosure.Trigger
                className="w-full flex flex-wrap items-center justify-between gap-2.5 px-4 py-3 bg-surface hover:bg-surface-secondary cursor-pointer border-b border-border transition select-none min-w-0 text-left"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Disclosure.Indicator className="text-accent shrink-0" />
                  <FolderKanban className="w-4 h-4 text-accent shrink-0" />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="text-sm sm:text-base font-bold text-foreground tracking-tight truncate">
                        {catGroup.categoryName}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-surface-secondary text-foreground font-mono text-[11px] font-semibold border border-border">
                        {catGroup.totalCommands} {catGroup.totalCommands === 1 ? 'cmd' : 'cmds'}
                      </span>
                      {catGroup.subgroups.length > 1 && (
                        <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-accent-soft-foreground font-medium px-2 py-0.5 rounded-full bg-accent-soft border border-accent/30">
                          <Layers className="w-3 h-3 text-accent" />
                          <span>{catGroup.subgroups.length} subcategories</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Category-Level Role Counters */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono">
                    {catGroup.triggersCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-warning-soft text-warning-soft-foreground border border-warning/30">
                        {catGroup.triggersCount} Trig
                      </span>
                    )}
                    {catGroup.conditionsCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground border border-accent/30">
                        {catGroup.conditionsCount} Cond
                      </span>
                    )}
                    {catGroup.actionsCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-success-soft text-success-soft-foreground border border-success/30">
                        {catGroup.actionsCount} Act
                      </span>
                    )}
                  </div>
                </div>
              </Disclosure.Trigger>
            </Disclosure.Heading>

            {/* Category Body: Nested Subcategories or Direct Grid */}
            <Disclosure.Content className="p-3.5 sm:p-4 bg-background/40 min-w-0">
                {catGroup.subgroups.length <= 1 ? (
                  /* Single subcategory (or general): render grid directly without redundant headers */
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4 min-w-0">
                    {catGroup.subgroups[0]?.commands.map(cmd => (
                      <CommandCard
                        key={cmd.id}
                        command={cmd}
                        onSelect={onSelectCommand}
                        onEdit={onEditCommand}
                        onDuplicate={onDuplicateCommand}
                        onDelete={onDeleteCommand}
                        isNew={draftAddedIds.includes(cmd.id)}
                        isModified={draftModifiedIds.includes(cmd.id)}
                        isSelectedForAutomation={selectedCommandIdsForAutomation?.has(cmd.id)}
                        onToggleSelectForAutomation={onToggleSelectForAutomation}
                        onAddToAutomation={onAddToAutomation}
                      />
                    ))}
                  </div>
                ) : (
                  /* Multiple subcategories: nested cleanly under the category */
                  <div className="space-y-6 min-w-0">
                    {catGroup.subgroups.map(subgroup => (
                      <div key={subgroup.name} className="space-y-3 min-w-0">
                        {/* Nested Subgroup Header */}
                        <div className="flex items-center justify-between gap-2 pb-2 border-b border-separator">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-1.5 h-3.5 rounded-full bg-accent shrink-0" />
                            <h4 className="text-xs sm:text-sm font-semibold text-foreground tracking-tight">
                              {subgroup.name}
                            </h4>
                            <span className="text-[11px] text-muted font-mono">
                              ({subgroup.commands.length} {subgroup.commands.length === 1 ? 'cmd' : 'cmds'})
                            </span>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center gap-1.5 text-[10px] font-mono">
                              {subgroup.triggersCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-warning-soft text-warning-soft-foreground border border-warning/30">
                                  {subgroup.triggersCount} Trig
                                </span>
                              )}
                              {subgroup.conditionsCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-accent-soft text-accent-soft-foreground border border-accent/30">
                                  {subgroup.conditionsCount} Cond
                                </span>
                              )}
                              {subgroup.actionsCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-success-soft text-success-soft-foreground border border-success/30">
                                  {subgroup.actionsCount} Act
                                </span>
                              )}
                            </div>

                            {onSelectSubcategory && subgroup.name !== 'General' && (
                              <button
                                type="button"
                                onClick={() => onSelectSubcategory(subgroup.name)}
                                className="text-[11px] text-accent hover:underline px-1.5 py-0.5 font-medium ml-1"
                                title={`Filter strictly to ${subgroup.name}`}
                              >
                                Focus
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Nested Commands Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4 min-w-0">
                          {subgroup.commands.map(cmd => (
                            <CommandCard
                              key={cmd.id}
                              command={cmd}
                              onSelect={onSelectCommand}
                              onEdit={onEditCommand}
                              onDuplicate={onDuplicateCommand}
                              onDelete={onDeleteCommand}
                              isNew={draftAddedIds.includes(cmd.id)}
                              isModified={draftModifiedIds.includes(cmd.id)}
                              isSelectedForAutomation={selectedCommandIdsForAutomation?.has(cmd.id)}
                              onToggleSelectForAutomation={onToggleSelectForAutomation}
                              onAddToAutomation={onAddToAutomation}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Disclosure.Content>
            </Disclosure>
        );
      })}
    </div>
  );
};
