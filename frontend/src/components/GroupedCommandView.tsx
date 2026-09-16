import React, { useState, useMemo } from 'react';
import { Command, CommandRole } from '../types/catalog';
import { CommandCard } from './CommandCard';
import {
  ChevronDown,
  ChevronRight,
  Layers,
  FolderKanban,
  CheckCircle2,
  Maximize2,
  Minimize2
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
}

interface CommandSubgroup {
  id: string;
  category: string;
  subcategory: string;
  displayName: string;
  commands: Command[];
  triggersCount: number;
  conditionsCount: number;
  actionsCount: number;
}

export const GroupedCommandView: React.FC<GroupedCommandViewProps> = ({
  commands,
  selectedCategory,
  onSelectCommand,
  onEditCommand,
  onDuplicateCommand,
  onDeleteCommand,
  draftAddedIds,
  draftModifiedIds,
  onSelectSubcategory,
  selectedCommandIdsForAutomation,
  onToggleSelectForAutomation,
  onAddToAutomation
}) => {
  // Compute groups based on Category + Subcategory
  const groups = useMemo(() => {
    const map = new Map<string, CommandSubgroup>();

    commands.forEach(cmd => {
      const cat = cmd.category || 'Uncategorized';
      const sub = cmd.subcategory || 'General';
      const key = `${cat}:::${sub}`;

      if (!map.has(key)) {
        map.set(key, {
          id: key,
          category: cat,
          subcategory: sub,
          displayName: selectedCategory !== 'all' ? sub : `${cat} › ${sub}`,
          commands: [],
          triggersCount: 0,
          conditionsCount: 0,
          actionsCount: 0
        });
      }

      const group = map.get(key)!;
      group.commands.push(cmd);
      if (cmd.roles.includes('trigger')) group.triggersCount += 1;
      if (cmd.roles.includes('condition')) group.conditionsCount += 1;
      if (cmd.roles.includes('action')) group.actionsCount += 1;
    });

    // Sort groups alphabetically by Category, then by Subcategory (with 'General' last)
    return Array.from(map.values()).sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      if (a.subcategory === 'General') return 1;
      if (b.subcategory === 'General') return -1;
      return a.subcategory.localeCompare(b.subcategory);
    });
  }, [commands, selectedCategory]);

  // Set of collapsed group IDs
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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

  const collapseAll = () => {
    setCollapsedGroups(new Set(groups.map(g => g.id)));
  };

  const expandAll = () => {
    setCollapsedGroups(new Set());
  };

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6 min-w-0">
      {/* Global Group Controls Bar */}
      <div className="flex items-center justify-between gap-3 text-xs bg-[var(--card-bg)]/60 border border-[var(--border-color)] px-4 py-2.5 rounded-xl">
        <div className="flex items-center gap-2 text-slate-300 font-medium">
          <FolderKanban className="w-4 h-4 text-cyan-400 shrink-0" />
          <span>
            Showing <strong className="text-white font-mono">{groups.length}</strong> functional sub-groups ({commands.length} total commands)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={expandAll}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-slate-400 hover:text-white hover:bg-slate-800/80 transition text-[11px]"
            title="Expand all groups"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Expand All</span>
          </button>
          <span className="text-slate-600">•</span>
          <button
            type="button"
            onClick={collapseAll}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-slate-400 hover:text-white hover:bg-slate-800/80 transition text-[11px]"
            title="Collapse all groups"
          >
            <Minimize2 className="w-3.5 h-3.5" />
            <span>Collapse All</span>
          </button>
        </div>
      </div>

      {/* List of Subsystem Groups */}
      <div className="space-y-6 min-w-0">
        {groups.map(group => {
          const isCollapsed = collapsedGroups.has(group.id);

          return (
            <section
              key={group.id}
              className="rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)]/40 overflow-hidden shadow-sm transition min-w-0"
            >
              {/* Group Header */}
              <div
                onClick={() => toggleGroupCollapse(group.id)}
                className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3 bg-[var(--card-bg)]/90 hover:bg-[var(--md-sys-color-surface-container-high)]/50 cursor-pointer border-b border-[var(--border-color)] transition select-none min-w-0"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <button
                    type="button"
                    className="p-1 rounded-md text-slate-400 hover:text-white transition shrink-0"
                    aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-4 h-4 text-cyan-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-cyan-400" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <h3 className="text-sm sm:text-base font-bold text-white tracking-tight truncate">
                        {group.displayName}
                      </h3>
                      <span className="px-2 py-0.5 rounded-full bg-slate-800/90 text-slate-300 font-mono text-[11px] font-semibold border border-slate-700/60">
                        {group.commands.length} {group.commands.length === 1 ? 'cmd' : 'cmds'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Subgroup Role Counters & Focus Action */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono">
                    {group.triggersCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/60">
                        {group.triggersCount} Trig
                      </span>
                    )}
                    {group.conditionsCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                        {group.conditionsCount} Cond
                      </span>
                    )}
                    {group.actionsCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-800/60">
                        {group.actionsCount} Act
                      </span>
                    )}
                  </div>

                  {onSelectSubcategory && group.subcategory !== 'General' && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        onSelectSubcategory(group.subcategory);
                      }}
                      className="hidden sm:inline-flex items-center gap-1 text-[11px] font-medium text-cyan-400 hover:text-cyan-300 hover:underline px-2 py-1 ml-1"
                      title={`Filter strictly to ${group.subcategory}`}
                    >
                      Focus
                    </button>
                  )}
                </div>
              </div>

              {/* Group Body: Commands Grid */}
              {!isCollapsed && (
                <div className="p-3.5 sm:p-4 bg-black/10 min-w-0">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4 min-w-0">
                    {group.commands.map(cmd => (
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
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};
