import React, { useState, useMemo, useEffect } from 'react';
import { Command, CommandRole } from '../types/catalog';
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
  onAddToAutomation?: (cmd: Command, role?: CommandRole) => void;
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
          <section
            key={catGroup.id}
            className="rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)]/40 overflow-hidden shadow-sm transition min-w-0"
          >
            {/* Top-Level Category Header */}
            <div
              onClick={() => toggleGroupCollapse(catGroup.id)}
              className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3 bg-[var(--card-bg)]/90 hover:bg-[var(--md-sys-color-surface-container-high)]/50 cursor-pointer border-b border-[var(--border-color)] transition select-none min-w-0"
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <button
                  type="button"
                  className="p-1 rounded-md text-slate-400 hover:text-white transition shrink-0"
                  aria-label={isCollapsed ? `Expand ${catGroup.categoryName}` : `Collapse ${catGroup.categoryName}`}
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-cyan-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-cyan-400" />
                  )}
                </button>

                <FolderKanban className="w-4 h-4 text-cyan-400 shrink-0" />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <h3 className="text-sm sm:text-base font-bold text-white tracking-tight truncate">
                      {catGroup.categoryName}
                    </h3>
                    <span className="px-2 py-0.5 rounded-full bg-slate-800/90 text-slate-300 font-mono text-[11px] font-semibold border border-slate-700/60">
                      {catGroup.totalCommands} {catGroup.totalCommands === 1 ? 'cmd' : 'cmds'}
                    </span>
                    {catGroup.subgroups.length > 1 && (
                      <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-cyan-300/90 font-medium px-2 py-0.5 rounded-full bg-cyan-950/40 border border-cyan-800/40">
                        <Layers className="w-3 h-3 text-cyan-400" />
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
                    <span className="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/60">
                      {catGroup.triggersCount} Trig
                    </span>
                  )}
                  {catGroup.conditionsCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                      {catGroup.conditionsCount} Cond
                    </span>
                  )}
                  {catGroup.actionsCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-800/60">
                      {catGroup.actionsCount} Act
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Category Body: Nested Subcategories or Direct Grid */}
            {!isCollapsed && (
              <div className="p-3.5 sm:p-4 bg-black/10 min-w-0">
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
                        <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border-color)]/70">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-1.5 h-3.5 rounded-full bg-cyan-400 shrink-0" />
                            <h4 className="text-xs sm:text-sm font-semibold text-slate-200 tracking-tight">
                              {subgroup.name}
                            </h4>
                            <span className="text-[11px] text-slate-400 font-mono">
                              ({subgroup.commands.length} {subgroup.commands.length === 1 ? 'cmd' : 'cmds'})
                            </span>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center gap-1.5 text-[10px] font-mono">
                              {subgroup.triggersCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-amber-950/40 text-amber-300/90 border border-amber-800/40">
                                  {subgroup.triggersCount} Trig
                                </span>
                              )}
                              {subgroup.conditionsCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-emerald-950/40 text-emerald-300/90 border border-emerald-800/40">
                                  {subgroup.conditionsCount} Cond
                                </span>
                              )}
                              {subgroup.actionsCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-cyan-950/40 text-cyan-300/90 border border-cyan-800/40">
                                  {subgroup.actionsCount} Act
                                </span>
                              )}
                            </div>

                            {onSelectSubcategory && subgroup.name !== 'General' && (
                              <button
                                type="button"
                                onClick={() => onSelectSubcategory(subgroup.name)}
                                className="text-[11px] text-cyan-400 hover:text-cyan-300 hover:underline px-1.5 py-0.5 font-medium ml-1"
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
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
