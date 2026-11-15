import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button, CloseButton } from '@heroui/react';
import {
  ChevronRight,
  ChevronDown,
  CheckSquare,
  Square,
  MinusSquare,
  Save,
  RotateCcw,
  Search,
  X,
  RefreshCw,
  Zap,
  Check,
  Plus,
  Sliders,
  Car,
  Activity,
  Cpu,
  Layers,
  Shield,
  Battery
} from 'lucide-react';
import { Command, Catalog } from '../types/catalog';
import { formatCanId, normalizeCanId } from '../utils/automationConverters';

export interface MonitoredCanIdSelectorProps {
  catalog?: Catalog;
  monitoredIds: string[];
  activeBusIds: string[];
  isCustomized: boolean;
  onSaveMonitoredIds: (ids: string[]) => Promise<void>;
  onResetDefaults: () => Promise<void>;
  onRefresh: () => Promise<void>;
  loading?: boolean;
}

interface CommandItem {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  canId: string;
  normId: string;
  notes?: string;
}

interface SubcategoryGroup {
  name: string;
  commands: CommandItem[];
  canIds: Set<string>;
}

interface CategoryGroup {
  name: string;
  subcategories: Map<string, SubcategoryGroup>;
  commands: CommandItem[];
  canIds: Set<string>;
}

function getCategoryIcon(catName: string) {
  const lower = catName.toLowerCase();
  if (lower.includes('high voltage') || lower.includes('charging') || lower.includes('battery')) {
    return <Battery className="w-4 h-4 text-amber-400 shrink-0" />;
  }
  if (lower.includes('door') || lower.includes('security') || lower.includes('access')) {
    return <Shield className="w-4 h-4 text-blue-400 shrink-0" />;
  }
  if (lower.includes('climate') || lower.includes('comfort')) {
    return <Sliders className="w-4 h-4 text-cyan-400 shrink-0" />;
  }
  if (lower.includes('cockpit') || lower.includes('controls')) {
    return <Car className="w-4 h-4 text-purple-400 shrink-0" />;
  }
  if (lower.includes('telematics') || lower.includes('state')) {
    return <Activity className="w-4 h-4 text-emerald-400 shrink-0" />;
  }
  if (lower.includes('powertrain') || lower.includes('performance')) {
    return <Cpu className="w-4 h-4 text-rose-400 shrink-0" />;
  }
  return <Layers className="w-4 h-4 text-muted shrink-0" />;
}

function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
  disabled,
  title
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`w-4 h-4 rounded flex items-center justify-center transition border ${
        checked
          ? 'bg-accent border-accent text-accent-foreground'
          : indeterminate
          ? 'bg-accent/20 border-accent text-accent'
          : 'bg-surface-secondary border-border text-transparent hover:border-foreground/50'
      } disabled:opacity-50 disabled:cursor-not-allowed shrink-0`}
    >
      {checked ? (
        <Check className="w-3 h-3 stroke-[3]" />
      ) : indeterminate ? (
        <MinusSquare className="w-3.5 h-3.5" />
      ) : null}
    </button>
  );
}

export const MonitoredCanIdSelector: React.FC<MonitoredCanIdSelectorProps> = ({
  catalog,
  monitoredIds,
  activeBusIds,
  isCustomized,
  onSaveMonitoredIds,
  onResetDefaults,
  onRefresh,
  loading = false
}) => {
  // Normalize state commands from catalog
  const allStateCommands = useMemo<CommandItem[]>(() => {
    if (!catalog?.commands) return [];
    return catalog.commands
      .filter((cmd: Command) => !!(cmd.state_can_id || cmd.network?.state_can_id))
      .map((cmd: Command) => {
        const rawId = cmd.state_can_id || cmd.network?.state_can_id;
        const canId = formatCanId(rawId);
        const normId = normalizeCanId(rawId);
        return {
          id: cmd.id,
          name: cmd.name || cmd.id,
          category: cmd.category || 'Uncategorized',
          subcategory: cmd.subcategory || 'General',
          canId,
          normId,
          notes: cmd.notes
        };
      });
  }, [catalog]);

  // Catalog normalized CAN IDs set
  const catalogNormIdsSet = useMemo(() => {
    return new Set(allStateCommands.map(c => c.normId));
  }, [allStateCommands]);

  // Active bus normalized IDs set
  const activeBusNormSet = useMemo(() => {
    return new Set(activeBusIds.map(normalizeCanId).filter(Boolean));
  }, [activeBusIds]);

  // Hierarchical groups: Category -> Subcategory -> Commands
  const categoryGroups = useMemo<CategoryGroup[]>(() => {
    const catMap = new Map<string, CategoryGroup>();

    allStateCommands.forEach((cmd) => {
      const catName = cmd.category;
      const subName = cmd.subcategory;

      if (!catMap.has(catName)) {
        catMap.set(catName, {
          name: catName,
          subcategories: new Map(),
          commands: [],
          canIds: new Set()
        });
      }

      const catGroup = catMap.get(catName)!;
      catGroup.commands.push(cmd);
      catGroup.canIds.add(cmd.canId);

      if (!catGroup.subcategories.has(subName)) {
        catGroup.subcategories.set(subName, {
          name: subName,
          commands: [],
          canIds: new Set()
        });
      }

      const subGroup = catGroup.subcategories.get(subName)!;
      subGroup.commands.push(cmd);
      subGroup.canIds.add(cmd.canId);
    });

    return Array.from(catMap.values());
  }, [allStateCommands]);

  // Selection states
  const [selectedCommandIds, setSelectedCommandIds] = useState<Set<string>>(new Set());
  const [savedSelectedCommandIds, setSavedSelectedCommandIds] = useState<Set<string>>(new Set());
  const [customCanIds, setCustomCanIds] = useState<string[]>([]);
  const [savedCustomCanIds, setSavedCustomCanIds] = useState<string[]>([]);

  // Accordion expand/collapse states
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedSubcategories, setExpandedSubcategories] = useState<Set<string>>(new Set());

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Advanced Custom Hex IDs section
  const [isAdvancedOpen, setIsAdvancedOpen] = useState<boolean>(false);
  const [newCustomIdInput, setNewCustomIdInput] = useState<string>('');

  // Save operation state
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [mounted, setMounted] = useState<boolean>(false);
  const [isSaveFabDismissed, setIsSaveFabDismissed] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Initialize selection when monitoredIds changes or loads
  useEffect(() => {
    if (allStateCommands.length === 0) return;

    const monitoredNormSet = new Set(monitoredIds.map(normalizeCanId).filter(Boolean));

    // Check localStorage for fine-grained entity selections
    let initialSelected: Set<string>;
    try {
      const stored = localStorage.getItem('cando_monitored_command_ids');
      if (stored) {
        const parsed: string[] = JSON.parse(stored);
        const validIds = new Set(allStateCommands.map(c => c.id));
        const filtered = parsed.filter(id => validIds.has(id));
        initialSelected = new Set(filtered);
      } else {
        // Fallback: select all commands whose CAN ID is in monitoredIds
        initialSelected = new Set(
          allStateCommands.filter(c => monitoredNormSet.has(c.normId)).map(c => c.id)
        );
      }
    } catch {
      initialSelected = new Set(
        allStateCommands.filter(c => monitoredNormSet.has(c.normId)).map(c => c.id)
      );
    }

    // Extract any custom CAN IDs not in the catalog
    const customs = monitoredIds
      .filter(id => !catalogNormIdsSet.has(normalizeCanId(id)))
      .map(formatCanId);

    setSelectedCommandIds(initialSelected);
    setSavedSelectedCommandIds(new Set(initialSelected));
    setCustomCanIds(customs);
    setSavedCustomCanIds(customs);
  }, [monitoredIds, allStateCommands, catalogNormIdsSet]);

  // Compute union of selected CAN IDs
  const computedCanIds = useMemo<string[]>(() => {
    const ids = new Set<string>();
    allStateCommands.forEach(cmd => {
      if (selectedCommandIds.has(cmd.id)) {
        ids.add(cmd.canId);
      }
    });
    customCanIds.forEach(cid => {
      if (cid) ids.add(formatCanId(cid));
    });
    return Array.from(ids).sort((a, b) => {
      const na = parseInt(a, 16);
      const nb = parseInt(b, 16);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [allStateCommands, selectedCommandIds, customCanIds]);

  // Dirty check: has the user made changes since last save/load?
  const hasChanges = useMemo<boolean>(() => {
    if (selectedCommandIds.size !== savedSelectedCommandIds.size) return true;
    for (const id of selectedCommandIds) {
      if (!savedSelectedCommandIds.has(id)) return true;
    }
    if (customCanIds.length !== savedCustomCanIds.length) return true;
    const sortedCustom = [...customCanIds].sort();
    const sortedSavedCustom = [...savedCustomCanIds].sort();
    for (let i = 0; i < sortedCustom.length; i++) {
      if (sortedCustom[i] !== sortedSavedCustom[i]) return true;
    }
    return false;
  }, [selectedCommandIds, savedSelectedCommandIds, customCanIds, savedCustomCanIds]);

  useEffect(() => {
    if (hasChanges) {
      setIsSaveFabDismissed(false);
    }
  }, [hasChanges]);

  const portalTarget = mounted && typeof document !== 'undefined' ? document.getElementById('ha-fab-stack') : null;

  // Filter commands by search query
  const queryLower = searchQuery.trim().toLowerCase();
  const isFiltering = queryLower.length > 0;

  const filteredCategories = useMemo(() => {
    if (!isFiltering) return categoryGroups;

    return categoryGroups
      .map((cat) => {
        const matchingSubcats = new Map<string, SubcategoryGroup>();
        cat.subcategories.forEach((subcat, subName) => {
          const matchingCmds = subcat.commands.filter((cmd) => {
            return (
              cmd.name.toLowerCase().includes(queryLower) ||
              cmd.id.toLowerCase().includes(queryLower) ||
              cmd.canId.toLowerCase().includes(queryLower) ||
              cmd.category.toLowerCase().includes(queryLower) ||
              cmd.subcategory.toLowerCase().includes(queryLower)
            );
          });
          if (matchingCmds.length > 0) {
            matchingSubcats.set(subName, {
              ...subcat,
              commands: matchingCmds
            });
          }
        });

        const catMatchingCmds = Array.from(matchingSubcats.values()).flatMap(s => s.commands);
        if (catMatchingCmds.length === 0) return null;

        return {
          ...cat,
          subcategories: matchingSubcats,
          commands: catMatchingCmds
        };
      })
      .filter((cat): cat is CategoryGroup => cat !== null);
  }, [categoryGroups, isFiltering, queryLower]);

  // Expand all categories when searching
  useEffect(() => {
    if (isFiltering) {
      setExpandedCategories(new Set(categoryGroups.map(c => c.name)));
      const allSub = new Set<string>();
      categoryGroups.forEach(c => {
        c.subcategories.forEach((_, subName) => {
          allSub.add(`${c.name}::${subName}`);
        });
      });
      setExpandedSubcategories(allSub);
    }
  }, [isFiltering, categoryGroups]);

  // Category toggle handler
  const handleToggleCategory = (cat: CategoryGroup) => {
    const catCmdIds = cat.commands.map(c => c.id);
    const selectedCount = catCmdIds.filter(id => selectedCommandIds.has(id)).length;
    const isAllSelected = selectedCount === catCmdIds.length && catCmdIds.length > 0;

    setSelectedCommandIds((prev) => {
      const next = new Set(prev);
      if (isAllSelected) {
        catCmdIds.forEach(id => next.delete(id));
      } else {
        catCmdIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  // Subcategory toggle handler
  const handleToggleSubcategory = (subcat: SubcategoryGroup) => {
    const subCmdIds = subcat.commands.map(c => c.id);
    const selectedCount = subCmdIds.filter(id => selectedCommandIds.has(id)).length;
    const isAllSelected = selectedCount === subCmdIds.length && subCmdIds.length > 0;

    setSelectedCommandIds((prev) => {
      const next = new Set(prev);
      if (isAllSelected) {
        subCmdIds.forEach(id => next.delete(id));
      } else {
        subCmdIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  // Command toggle handler
  const handleToggleCommand = (cmdId: string) => {
    setSelectedCommandIds((prev) => {
      const next = new Set(prev);
      if (next.has(cmdId)) {
        next.delete(cmdId);
      } else {
        next.add(cmdId);
      }
      return next;
    });
  };

  // Bulk: Select All
  const handleSelectAll = useCallback(() => {
    const allIds = new Set(allStateCommands.map(c => c.id));
    setSelectedCommandIds(allIds);
  }, [allStateCommands]);

  // Bulk: Clear All
  const handleClearAll = useCallback(() => {
    setSelectedCommandIds(new Set());
  }, []);

  // Bulk: Sync to Detected Bus IDs
  const handleSyncToBus = useCallback(() => {
    if (activeBusNormSet.size === 0) return;

    // 1. Select all catalog commands detected on the physical bus
    const detectedCmdIds = allStateCommands
      .filter(cmd => activeBusNormSet.has(cmd.normId))
      .map(cmd => cmd.id);

    // 2. Add any active bus IDs not recognized in catalog to custom IDs
    const unmappedCustoms = activeBusIds
      .filter(id => !catalogNormIdsSet.has(normalizeCanId(id)))
      .map(formatCanId);

    setSelectedCommandIds(new Set(detectedCmdIds));
    setCustomCanIds(Array.from(new Set(unmappedCustoms)));
  }, [activeBusNormSet, allStateCommands, activeBusIds, catalogNormIdsSet]);

  // Expand / Collapse All
  const handleExpandAll = () => {
    setExpandedCategories(new Set(categoryGroups.map(c => c.name)));
    const allSubs = new Set<string>();
    categoryGroups.forEach(c => {
      c.subcategories.forEach((_, subName) => {
        allSubs.add(`${c.name}::${subName}`);
      });
    });
    setExpandedSubcategories(allSubs);
  };

  const handleCollapseAll = () => {
    setExpandedCategories(new Set());
    setExpandedSubcategories(new Set());
  };

  // Revert changes
  const handleRevert = () => {
    setSelectedCommandIds(new Set(savedSelectedCommandIds));
    setCustomCanIds([...savedCustomCanIds]);
  };

  // Save changes
  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSaveMonitoredIds(computedCanIds);
      // Persist fine-grained entity selections in localStorage
      try {
        localStorage.setItem(
          'cando_monitored_command_ids',
          JSON.stringify(Array.from(selectedCommandIds))
        );
      } catch {}
      setSavedSelectedCommandIds(new Set(selectedCommandIds));
      setSavedCustomCanIds([...customCanIds]);
    } finally {
      setIsSaving(false);
    }
  };

  // Reset to defaults
  const handleReset = async () => {
    try {
      localStorage.removeItem('cando_monitored_command_ids');
    } catch {}
    await onResetDefaults();
  };

  return (
    <div className="space-y-4 w-full pb-24">
      {/* Top Header Card */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">
              Monitored CAN IDs & Subscriptions
            </span>
            {isCustomized && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-semibold border border-accent/25">
                Customized
              </span>
            )}
          </div>
          <span className="text-xs text-muted block mt-0.5">
            Select vehicle categories or individual signals to filter and stream over MQTT.
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            onPress={onRefresh}
            isDisabled={loading}
            className="p-1.5 text-xs rounded-lg border border-border"
            aria-label="Refresh Monitored IDs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-accent' : ''}`} />
          </Button>
          {isCustomized && (
            <Button
              size="sm"
              variant="secondary"
              onPress={handleReset}
              className="px-2.5 py-1 text-xs text-muted hover:text-danger rounded-lg border border-border font-semibold transition"
            >
              Reset Defaults
            </Button>
          )}
        </div>
      </div>

      {/* Detected on Bus Banner */}
      {activeBusIds.length > 0 && (
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-surface-secondary border border-border text-xs">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="text-muted">
              <span className="font-semibold text-success">{activeBusIds.length} IDs</span> actively transmitting on the physical bus.
            </span>
          </div>
          <button
            type="button"
            onClick={handleSyncToBus}
            className="inline-flex items-center gap-1 text-accent hover:underline font-bold transition text-xs"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Sync to Bus</span>
          </button>
        </div>
      )}

      {/* Search & Accordion Controls Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        {/* Search Input */}
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search signals, categories, or CAN IDs (e.g. 0x260, battery)..."
            className="w-full pl-8 pr-7 py-1.5 text-xs rounded-xl bg-surface-secondary border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-focus"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground text-xs"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Bulk Selection & Expand / Collapse Controls */}
        <div className="flex items-center gap-1 shrink-0 self-end sm:self-auto">
          <button
            type="button"
            onClick={handleSelectAll}
            className="px-2 py-1 text-[11px] font-medium text-accent hover:underline transition rounded"
          >
            Select All
          </button>
          <span className="text-border">|</span>
          <button
            type="button"
            onClick={handleClearAll}
            className="px-2 py-1 text-[11px] font-medium text-muted hover:text-danger transition rounded"
          >
            Clear All
          </button>
          <span className="text-border">|</span>
          <button
            type="button"
            onClick={handleExpandAll}
            className="px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground transition rounded"
          >
            Expand All
          </button>
          <span className="text-border">|</span>
          <button
            type="button"
            onClick={handleCollapseAll}
            className="px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground transition rounded"
          >
            Collapse All
          </button>
        </div>
      </div>

      {/* Category Accordion Tree */}
      <div className="space-y-2">
        {filteredCategories.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted rounded-xl bg-surface-secondary border border-border">
            No vehicle signals matching &ldquo;{searchQuery}&rdquo;
          </div>
        ) : (
          filteredCategories.map((cat) => {
            const isCatExpanded = expandedCategories.has(cat.name);
            const catCmdIds = cat.commands.map(c => c.id);
            const catSelectedCount = catCmdIds.filter(id => selectedCommandIds.has(id)).length;
            const isCatAllSelected = catSelectedCount === catCmdIds.length && catCmdIds.length > 0;
            const isCatIndeterminate = catSelectedCount > 0 && catSelectedCount < catCmdIds.length;

            // Unique CAN IDs in this category currently selected
            const catActiveCanIdsCount = new Set(
              cat.commands.filter(c => selectedCommandIds.has(c.id)).map(c => c.canId)
            ).size;

            return (
              <div
                key={cat.name}
                className="rounded-xl border border-border bg-surface overflow-hidden transition-colors"
              >
                {/* Category Header Row */}
                <div
                  onClick={() => {
                    setExpandedCategories((prev) => {
                      const next = new Set(prev);
                      if (next.has(cat.name)) {
                        next.delete(cat.name);
                      } else {
                        next.add(cat.name);
                      }
                      return next;
                    });
                  }}
                  className="flex items-center justify-between p-3 cursor-pointer select-none hover:bg-surface-secondary/50 transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-muted hover:text-foreground transition">
                      {isCatExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </span>

                    <TriStateCheckbox
                      checked={isCatAllSelected}
                      indeterminate={isCatIndeterminate}
                      onChange={() => handleToggleCategory(cat)}
                      title={`Toggle all ${cat.name} signals`}
                    />

                    <div className="flex items-center gap-2 min-w-0">
                      {getCategoryIcon(cat.name)}
                      <span className="text-xs font-bold text-foreground truncate">
                        {cat.name}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 text-[11px]">
                    <span className="font-mono text-muted">
                      <span className={catSelectedCount > 0 ? 'text-accent font-semibold' : ''}>
                        {catSelectedCount}
                      </span>
                      /{catCmdIds.length} signals
                    </span>
                    <span className="text-border">•</span>
                    <span className="font-mono text-muted">
                      {catActiveCanIdsCount}/{cat.canIds.size} IDs
                    </span>
                  </div>
                </div>

                {/* Category Body: Subcategories */}
                {isCatExpanded && (
                  <div className="border-t border-border/70 bg-surface-secondary/30 divide-y divide-border/40">
                    {Array.from(cat.subcategories.values()).map((subcat) => {
                      const subcatKey = `${cat.name}::${subcat.name}`;
                      const isSubExpanded = expandedSubcategories.has(subcatKey);
                      const subCmdIds = subcat.commands.map(c => c.id);
                      const subSelectedCount = subCmdIds.filter(id => selectedCommandIds.has(id)).length;
                      const isSubAllSelected = subSelectedCount === subCmdIds.length && subCmdIds.length > 0;
                      const isSubIndeterminate = subSelectedCount > 0 && subSelectedCount < subCmdIds.length;

                      return (
                        <div key={subcat.name} className="overflow-hidden">
                          {/* Subcategory Row */}
                          <div
                            onClick={() => {
                              setExpandedSubcategories((prev) => {
                                const next = new Set(prev);
                                if (next.has(subcatKey)) {
                                  next.delete(subcatKey);
                                } else {
                                  next.add(subcatKey);
                                }
                                return next;
                              });
                            }}
                            className="flex items-center justify-between py-2 px-3 pl-8 cursor-pointer select-none hover:bg-surface-secondary/70 transition-colors"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span className="text-muted hover:text-foreground transition">
                                {isSubExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </span>

                              <TriStateCheckbox
                                checked={isSubAllSelected}
                                indeterminate={isSubIndeterminate}
                                onChange={() => handleToggleSubcategory(subcat)}
                                title={`Toggle all ${subcat.name} signals`}
                              />

                              <span className="text-xs font-semibold text-foreground/90 truncate">
                                {subcat.name}
                              </span>
                            </div>

                            <span className="text-[10px] font-mono text-muted">
                              <span className={subSelectedCount > 0 ? 'text-accent font-semibold' : ''}>
                                {subSelectedCount}
                              </span>
                              /{subCmdIds.length}
                            </span>
                          </div>

                          {/* Individual Commands */}
                          {isSubExpanded && (
                            <div className="py-1 px-3 pl-14 bg-surface/50 space-y-1">
                              {subcat.commands.map((cmd) => {
                                const isSelected = selectedCommandIds.has(cmd.id);
                                const isBusActive = activeBusNormSet.has(cmd.normId);

                                return (
                                  <div
                                    key={cmd.id}
                                    onClick={() => handleToggleCommand(cmd.id)}
                                    className="flex items-center justify-between py-1 px-2 rounded-lg hover:bg-surface-secondary/80 cursor-pointer select-none transition-colors"
                                  >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                      <TriStateCheckbox
                                        checked={isSelected}
                                        onChange={() => handleToggleCommand(cmd.id)}
                                        title={`Toggle ${cmd.name}`}
                                      />
                                      <span className="text-xs text-foreground truncate">
                                        {cmd.name}
                                      </span>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                      {isBusActive && (
                                        <span className="inline-flex items-center gap-1 text-[10px] text-success font-medium">
                                          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                                          <span className="hidden sm:inline">Active</span>
                                        </span>
                                      )}
                                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-foreground">
                                        {cmd.canId}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Advanced Section: Custom / Non-Catalog Hex IDs */}
      <div className="pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground font-semibold transition"
        >
          {isAdvancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <span>Advanced: Custom Hex IDs ({customCanIds.length})</span>
        </button>

        {isAdvancedOpen && (
          <div className="mt-3 p-3 rounded-xl bg-surface-secondary border border-border space-y-3">
            <span className="text-[11px] text-muted block">
              Add arbitrary hex CAN IDs for sniffing, debugging, or reverse engineering signals not yet present in the catalog.
            </span>

            <div className="flex gap-2">
              <input
                type="text"
                value={newCustomIdInput}
                onChange={(e) => setNewCustomIdInput(e.target.value)}
                placeholder="e.g. 0x7EC or 4CE"
                className="px-3 py-1.5 text-xs rounded-xl bg-surface border border-border text-foreground font-mono flex-1 focus:outline-none focus:border-focus"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = formatCanId(newCustomIdInput.trim());
                    if (!val) return;
                    if (!customCanIds.includes(val)) {
                      setCustomCanIds([...customCanIds, val]);
                    }
                    setNewCustomIdInput('');
                  }
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  const val = formatCanId(newCustomIdInput.trim());
                  if (!val) return;
                  if (!customCanIds.includes(val)) {
                    setCustomCanIds([...customCanIds, val]);
                  }
                  setNewCustomIdInput('');
                }}
                className="px-3 py-1.5 text-xs rounded-xl bg-surface border border-border font-bold text-foreground"
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add ID
              </Button>
            </div>

            {customCanIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {customCanIds.map((cid) => (
                  <span
                    key={cid}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface text-[11px] font-mono border border-border text-foreground"
                  >
                    {cid}
                    <button
                      type="button"
                      onClick={() => {
                        setCustomCanIds(customCanIds.filter(id => id !== cid));
                      }}
                      className="text-muted hover:text-danger ml-0.5 text-xs leading-none font-bold"
                      title={`Remove custom ID ${cid}`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* =========================================================================
          FLOATING ACTION BUTTON (FAB)
          - Rendered only when hasChanges && !isSaveFabDismissed
          - Portaled into the unified #ha-fab-stack so it never collides
          - HeroUI Button and CloseButton specs
      ========================================================================= */}
      {hasChanges && !isSaveFabDismissed && (
        portalTarget ? (
          createPortal(
            <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <Button
                size="sm"
                variant="secondary"
                onPress={handleRevert}
                className="ha-save-fab !bg-surface-secondary !text-muted hover:!text-foreground !border !border-border text-xs font-semibold"
                aria-label="Discard changes and revert"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Revert</span>
              </Button>

              <Button
                size="sm"
                variant="primary"
                onPress={handleSave}
                isDisabled={isSaving}
                className="ha-save-fab dirty"
                aria-label="Save choices to ESP32 flash"
              >
                {isSaving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>Save Choices ({computedCanIds.length} IDs)</span>
                  </>
                )}
              </Button>

              <CloseButton
                aria-label="Dismiss save choices FAB"
                onPress={() => setIsSaveFabDismissed(true)}
                className="size-8 rounded-full bg-surface-secondary/90 hover:bg-surface-tertiary border border-border text-muted hover:text-foreground shadow-overlay backdrop-blur transition flex items-center justify-center shrink-0 cursor-pointer pointer-events-auto"
              />
            </div>,
            portalTarget
          )
        ) : (
          <div className="ha-fab-stack">
            <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <Button
                size="sm"
                variant="secondary"
                onPress={handleRevert}
                className="ha-save-fab !bg-surface-secondary !text-muted hover:!text-foreground !border !border-border text-xs font-semibold"
                aria-label="Discard changes and revert"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Revert</span>
              </Button>

              <Button
                size="sm"
                variant="primary"
                onPress={handleSave}
                isDisabled={isSaving}
                className="ha-save-fab dirty"
                aria-label="Save choices to ESP32 flash"
              >
                {isSaving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>Save Choices ({computedCanIds.length} IDs)</span>
                  </>
                )}
              </Button>

              <CloseButton
                aria-label="Dismiss save choices FAB"
                onPress={() => setIsSaveFabDismissed(true)}
                className="size-8 rounded-full bg-surface-secondary/90 hover:bg-surface-tertiary border border-border text-muted hover:text-foreground shadow-overlay backdrop-blur transition flex items-center justify-center shrink-0 cursor-pointer pointer-events-auto"
              />
            </div>
          </div>
        )
      )}
    </div>
  );
};
