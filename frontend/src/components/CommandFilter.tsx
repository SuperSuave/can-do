import React, { useMemo } from 'react';
import { CommandRole, Catalog, Vehicle } from '../types/catalog';
import { getAllKnownFeatures } from '../utils/canValidator';
import {
  Search,
  Plus,
  Car,
  X,
  Layers,
  Globe,
  CheckCircle2,
  Sparkles,
  ArrowRight,
  Filter,
  LayoutGrid,
  FolderKanban,
  FileText
} from 'lucide-react';

interface CommandFilterProps {
  catalog: Catalog;
  search: string;
  onSearchChange: (val: string) => void;
  selectedRole: CommandRole | 'all';
  onRoleChange: (role: CommandRole | 'all') => void;
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  selectedSubcategory?: string;
  onSubcategoryChange?: (subcat: string) => void;
  viewMode?: 'grid' | 'grouped';
  onViewModeChange?: (mode: 'grid' | 'grouped') => void;
  selectedVehicleId: string;
  onVehicleChange: (vId: string) => void;
  selectedMake?: string;
  onMakeChange?: (make: string) => void;
  selectedRegion?: string;
  onRegionChange?: (region: string) => void;
  selectedFeature?: string;
  onFeatureChange?: (feat: string) => void;
  onOpenCreateModal: () => void;
  onOpenCategoryManager?: () => void;
  onOpenCanCapture?: () => void;
  onNavigateToVehicles?: () => void;
  filteredCount: number;
  totalCount: number;
  activeMainTab?: 'catalog' | 'vehicles' | 'automations';
  onChangeMainTab?: (tab: 'catalog' | 'vehicles' | 'automations') => void;
}

export const CommandFilter: React.FC<CommandFilterProps> = ({
  catalog,
  search,
  onSearchChange,
  selectedRole,
  onRoleChange,
  selectedCategory,
  onCategoryChange,
  selectedSubcategory = 'all',
  onSubcategoryChange,
  viewMode = 'grid',
  onViewModeChange,
  selectedVehicleId,
  onVehicleChange,
  selectedMake = 'all',
  onMakeChange = (_val: string) => {},
  selectedRegion = 'all',
  onRegionChange = (_val: string) => {},
  selectedFeature = 'all',
  onFeatureChange = (_val: string) => {},
  onOpenCreateModal,
  onOpenCategoryManager,
  onOpenCanCapture,
  onNavigateToVehicles,
  filteredCount,
  totalCount,
  activeMainTab = 'catalog',
  onChangeMainTab
}) => {
  // Extract unique categories
  const categories = Array.from(new Set(catalog.commands.map(c => c.category))).sort();

  // Extract available subcategories (optionally scoped to selectedCategory)
  const availableSubcategories = useMemo(() => {
    const subcats = new Set<string>();
    catalog.commands.forEach(c => {
      if (selectedCategory !== 'all' && c.category !== selectedCategory) return;
      if (c.subcategory) {
        subcats.add(c.subcategory);
      }
    });
    return Array.from(subcats).sort();
  }, [catalog.commands, selectedCategory]);

  // Unique makes from catalog vehicles
  const availableMakes = useMemo(() => {
    const makes = new Set(catalog.vehicles.map(v => v.make || 'Universal'));
    return ['all', ...Array.from(makes).sort()];
  }, [catalog.vehicles]);

  // Filter vehicles dropdown based on make & region
  const availableVehicles = useMemo(() => {
    return catalog.vehicles.filter(v => {
      if (selectedMake !== 'all' && v.make !== selectedMake) return false;
      if (selectedRegion !== 'all' && v.region !== selectedRegion) return false;
      return true;
    });
  }, [catalog.vehicles, selectedMake, selectedRegion]);

  // Combined equipment features from catalog
  const featuresWithCommands = useMemo(() => {
    const counts: Record<string, number> = {};
    catalog.commands.forEach(c => {
      const featsInCmd = new Set<string>();
      if (c.requires_feature) featsInCmd.add(c.requires_feature);
      c.options?.forEach(opt => {
        if (opt.requires_feature) featsInCmd.add(opt.requires_feature);
      });
      featsInCmd.forEach(feat => {
        counts[feat] = (counts[feat] || 0) + 1;
      });
    });

    const allFeats = Array.from(getAllKnownFeatures(catalog));
    return allFeats.sort((a, b) => {
      const countA = counts[a] || 0;
      const countB = counts[b] || 0;
      if (countB !== countA) return countB - countA;
      return a.localeCompare(b);
    });
  }, [catalog]);

  const featureCommandCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    catalog.commands.forEach(c => {
      const featsInCmd = new Set<string>();
      if (c.requires_feature) featsInCmd.add(c.requires_feature);
      c.options?.forEach(opt => {
        if (opt.requires_feature) featsInCmd.add(opt.requires_feature);
      });
      featsInCmd.forEach(feat => {
        counts[feat] = (counts[feat] || 0) + 1;
      });
    });
    return counts;
  }, [catalog.commands]);

  const selectedVehicle = useMemo(() => {
    return selectedVehicleId !== 'all'
      ? catalog.vehicles.find(v => v.id === selectedVehicleId) || null
      : null;
  }, [catalog.vehicles, selectedVehicleId]);

  const isVehicleFiltered =
    selectedVehicleId !== 'all' ||
    selectedMake !== 'all' ||
    selectedRegion !== 'all' ||
    selectedFeature !== 'all';

  const isFiltered =
    search !== '' ||
    selectedRole !== 'all' ||
    selectedCategory !== 'all' ||
    selectedSubcategory !== 'all' ||
    isVehicleFiltered;

  const handleResetVehicleFilters = () => {
    onVehicleChange('all');
    onMakeChange('all');
    onRegionChange('all');
    onFeatureChange('all');
  };

  const handleResetAllFilters = () => {
    onSearchChange('');
    onRoleChange('all');
    onCategoryChange('all');
    onSubcategoryChange?.('all');
    handleResetVehicleFilters();
  };

  const handleMakeSelectChange = (make: string) => {
    onMakeChange(make);
    // If the currently selected vehicle is from a different make, reset vehicle selection
    if (selectedVehicle && selectedVehicle.make !== make && make !== 'all') {
      onVehicleChange('all');
    }
  };

  const handleVehicleSelectChange = (vId: string) => {
    onVehicleChange(vId);
    if (vId !== 'all') {
      const vehicle = catalog.vehicles.find(v => v.id === vId);
      if (vehicle) {
        if (selectedMake !== 'all' && vehicle.make !== selectedMake) {
          onMakeChange(vehicle.make);
        }
      }
    }
  };

  return (
    <div className="space-y-3.5">
      {/* 1. TOP: Vehicle & Hardware Equipment Compatibility Bar */}
      <div className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)]/80 p-2.5 sm:p-3 space-y-2.5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Header label & active pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex items-center gap-1.5 font-semibold text-cyan-400">
              <Car className="w-4 h-4" />
              <span>Vehicle & Compatibility:</span>
            </div>

            {/* Active pills indicator */}
            {selectedMake !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-cyan-950/60 text-cyan-300 border border-cyan-800/60 px-2 py-0.5 rounded-full">
                Make: {selectedMake}
                <button
                  type="button"
                  onClick={() => onMakeChange('all')}
                  className="hover:text-white ml-0.5"
                  title="Clear make filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedRegion !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full">
                Region: {selectedRegion.toUpperCase()}
                <button
                  type="button"
                  onClick={() => onRegionChange('all')}
                  className="hover:text-white ml-0.5"
                  title="Clear region filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedFeature !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-emerald-950/60 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded-full">
                Requires: {selectedFeature}
                <button
                  type="button"
                  onClick={() => onFeatureChange('all')}
                  className="hover:text-white ml-0.5"
                  title="Clear feature filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
          </div>

          {/* Quick reset button for vehicle section */}
          {isVehicleFiltered && (
            <button
              type="button"
              onClick={handleResetVehicleFilters}
              className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline inline-flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" />
              <span>Clear Vehicle Filters</span>
            </button>
          )}
        </div>

        {/* 4 Coordinated Dropdowns matching the Vehicles Tab */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs min-w-0">
          {/* 1. Make Filter Dropdown */}
          <div className="relative min-w-0">
            <select
              value={selectedMake}
              onChange={e => handleMakeSelectChange(e.target.value)}
              className="w-full max-w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition min-w-0 text-xs"
            >
              <option value="all">All Makes ({catalog.vehicles.length} models)</option>
              {availableMakes.filter(m => m !== 'all').map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* 2. Specific Vehicle Model & Trim Dropdown */}
          <div className="relative min-w-0">
            <select
              value={selectedVehicleId}
              onChange={e => handleVehicleSelectChange(e.target.value)}
              className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border focus:outline-none transition min-w-0 text-xs ${
                selectedVehicleId !== 'all'
                  ? 'border-cyan-500/70 text-cyan-300 font-semibold'
                  : 'border-[var(--border-color)] text-[var(--text-heading)] focus:border-[var(--md-sys-color-primary)]'
              }`}
            >
              <option value="all">
                {selectedMake !== 'all'
                  ? `Any ${selectedMake} Model (${availableVehicles.length})`
                  : `Any Specific Model Trim (${catalog.vehicles.length})`}
              </option>
              {availableVehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {v.make !== selectedMake ? `${v.make} ` : ''}{v.model} ({v.trim}) [{v.region.toUpperCase()}]
                </option>
              ))}
            </select>
          </div>

          {/* 3. Region Filter Dropdown */}
          <div className="relative min-w-0">
            <select
              value={selectedRegion}
              onChange={e => onRegionChange(e.target.value)}
              className="w-full max-w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition min-w-0 text-xs"
            >
              <option value="all">All Regions</option>
              <option value="us">United States (us)</option>
              <option value="eu">Europe (eu)</option>
              <option value="kr">Korea (kr)</option>
              <option value="global">Global</option>
            </select>
          </div>

          {/* 4. Equipment / Feature Filter Dropdown */}
          <div className="relative min-w-0">
            <select
              value={selectedFeature}
              onChange={e => onFeatureChange(e.target.value)}
              className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border focus:outline-none transition min-w-0 text-xs ${
                selectedFeature !== 'all'
                  ? 'border-emerald-500/70 text-emerald-300 font-semibold'
                  : 'border-[var(--border-color)] text-[var(--text-heading)] focus:border-[var(--md-sys-color-primary)]'
              }`}
            >
              <option value="all">All Equipment Features ({featuresWithCommands.length})</option>
              {featuresWithCommands.map(feat => {
                const count = featureCommandCounts[feat] || 0;
                return (
                  <option key={feat} value={feat}>
                    {feat} ({count} {count === 1 ? 'cmd' : 'cmds'})
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        {/* Active Selected Vehicle Banner (When a specific vehicle trim is selected) */}
        {selectedVehicle && (
          <div className="mt-2.5 pt-2.5 border-t border-[var(--border-color)]/60 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-cyan-950/20 p-3 rounded-lg border border-cyan-800/30">
            <div className="flex items-start gap-3 min-w-0">
              <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0 mt-0.5">
                <Car className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-white">
                    {selectedVehicle.make} {selectedVehicle.model}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-cyan-400/20 text-cyan-300 border border-cyan-400/40">
                    {selectedVehicle.trim}
                  </span>
                  <span className="px-1.5 py-0.2 rounded text-[10px] font-mono uppercase bg-slate-800 text-slate-300 border border-slate-700">
                    {selectedVehicle.region}
                  </span>
                  <span className="text-[11px] text-slate-400 font-mono">
                    family: {selectedVehicle.family}
                  </span>
                </div>

                {/* Equipped features on this vehicle */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] text-slate-400">Equipped:</span>
                  {selectedVehicle.features.map(f => {
                    const isFeatureSelected = selectedFeature === f;
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => onFeatureChange(isFeatureSelected ? 'all' : f)}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded transition ${
                          isFeatureSelected
                            ? 'bg-emerald-400 text-black font-bold ring-2 ring-emerald-400/50'
                            : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700'
                        }`}
                        title={isFeatureSelected ? 'Click to clear feature filter' : `Filter commands requiring ${f}`}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 self-end md:self-center shrink-0">
              <span className="text-xs font-mono text-cyan-400 bg-cyan-950/60 px-2.5 py-1 rounded border border-cyan-800/40">
                <strong>{filteredCount}</strong> compatible
              </span>
              {onNavigateToVehicles && (
                <button
                  type="button"
                  onClick={onNavigateToVehicles}
                  className="dash-outline-btn text-xs py-1.5 px-3 inline-flex items-center gap-1 text-slate-300 hover:text-white"
                  title="Inspect this vehicle in the Vehicles tab"
                >
                  <span>Specs</span>
                  <ArrowRight className="w-3 h-3 text-cyan-400" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onVehicleChange('all')}
                className="text-xs py-1.5 px-2.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-rose-300 inline-flex items-center gap-1 transition"
                title="Clear vehicle selection"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 2. MIDDLE: Streamlined Taxonomy & View Deck (Unified Rows 2 & 3) */}
      <div className="space-y-2">
        {/* Main Taxonomy Controls Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 min-w-0 bg-[var(--card-bg)]/40 p-2 sm:p-2.5 rounded-xl border border-[var(--border-color)]">
          {/* Left: View Switching & Role Segmentation */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 min-w-0">
            {/* Commands vs Vehicles Toggle */}
            {onChangeMainTab && (
              <div className="ha-segmented-group text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => onChangeMainTab('catalog')}
                  className={`px-3 py-1.5 rounded-full font-bold transition flex items-center gap-1.5 ${
                    activeMainTab === 'catalog'
                      ? 'active !text-white'
                      : 'text-[var(--text-muted)] hover:text-white'
                  }`}
                >
                  <span>Commands</span>
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                      activeMainTab === 'catalog'
                        ? 'bg-black/30 text-white'
                        : 'bg-[var(--md-sys-color-surface-container-high)] text-slate-300'
                    }`}
                  >
                    {catalog.commands.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onChangeMainTab('vehicles')}
                  className={`px-3 py-1.5 rounded-full font-bold transition flex items-center gap-1.5 ${
                    activeMainTab === 'vehicles'
                      ? 'active !text-white'
                      : 'text-[var(--text-muted)] hover:text-white'
                  }`}
                >
                  <span>Vehicles</span>
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                      activeMainTab === 'vehicles'
                        ? 'bg-black/30 text-white'
                        : 'bg-[var(--md-sys-color-surface-container-high)] text-slate-300'
                    }`}
                  >
                    {catalog.vehicles.length}
                  </span>
                </button>
              </div>
            )}

            <div className="h-4 w-px bg-slate-800 hidden sm:block shrink-0" />

            {/* Role Filter Pills */}
            <div className="flex flex-wrap items-center gap-1 p-1 rounded-full bg-[var(--input-bg)] border border-[var(--border-color)] text-xs">
              <button
                type="button"
                onClick={() => onRoleChange('all')}
                className={`px-2.5 sm:px-3 py-1 rounded-full font-semibold transition text-[11px] sm:text-xs ${
                  selectedRole === 'all'
                    ? 'bg-[var(--md-sys-color-surface-container-highest)] text-white shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-white'
                }`}
              >
                All Roles
              </button>
              <button
                type="button"
                onClick={() => onRoleChange('trigger')}
                className={`px-2.5 sm:px-3 py-1 rounded-full font-semibold transition text-[11px] sm:text-xs ${
                  selectedRole === 'trigger'
                    ? 'trig-pill'
                    : 'text-[var(--text-muted)] hover:text-amber-300'
                }`}
              >
                Triggers
              </button>
              <button
                type="button"
                onClick={() => onRoleChange('condition')}
                className={`px-2.5 sm:px-3 py-1 rounded-full font-semibold transition text-[11px] sm:text-xs ${
                  selectedRole === 'condition'
                    ? 'cond-pill'
                    : 'text-[var(--text-muted)] hover:text-cyan-300'
                }`}
              >
                Conditions
              </button>
              <button
                type="button"
                onClick={() => onRoleChange('action')}
                className={`px-2.5 sm:px-3 py-1 rounded-full font-semibold transition text-[11px] sm:text-xs ${
                  selectedRole === 'action'
                    ? 'act-pill'
                    : 'text-[var(--text-muted)] hover:text-emerald-300'
                }`}
              >
                Actions
              </button>
            </div>
          </div>

          {/* Right: Category Dropdown, View Mode & Result Metrics */}
          <div className="flex flex-wrap items-center justify-between sm:justify-start lg:justify-end gap-2 text-xs w-full lg:w-auto min-w-0">
            {/* Category Dropdown */}
            <div className="relative flex-1 sm:flex-initial min-w-[140px] max-w-full">
              <select
                value={selectedCategory}
                onChange={e => {
                  onCategoryChange(e.target.value);
                  onSubcategoryChange?.('all');
                }}
                className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] text-xs min-w-0"
              >
                <option value="all">All Categories ({categories.length})</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            {/* View Mode Toggle: Grid vs Grouped */}
            {onViewModeChange && (
              <div className="flex items-center p-0.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => onViewModeChange('grid')}
                  className={`px-2 py-1 rounded font-semibold transition flex items-center gap-1 text-[11px] ${
                    viewMode === 'grid'
                      ? 'bg-[var(--md-sys-color-surface-container-highest)] text-white shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-white'
                  }`}
                  title="Standard Grid View"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Grid</span>
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange('grouped')}
                  className={`px-2 py-1 rounded font-semibold transition flex items-center gap-1 text-[11px] ${
                    viewMode === 'grouped'
                      ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-700/60 shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-cyan-300'
                  }`}
                  title="Group commands by subsystem & function"
                >
                  <FolderKanban className="w-3.5 h-3.5" />
                  <span>Grouped</span>
                </button>
              </div>
            )}

            {/* Stats & Reset Filter */}
            <div className="flex items-center gap-2 shrink-0 ml-auto sm:ml-0">
              {isFiltered && (
                <button
                  type="button"
                  onClick={handleResetAllFilters}
                  className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline px-1.5 py-0.5 flex items-center gap-1 font-medium"
                >
                  <X className="w-3 h-3" />
                  <span>Reset</span>
                </button>
              )}

              <span className="text-[var(--text-muted)] font-mono text-[11px] bg-[var(--input-bg)] px-2 py-1 rounded border border-[var(--border-color)] shrink-0">
                {filteredCount}/{totalCount}
              </span>
            </div>
          </div>
        </div>

        {/* Subsystem / Subcategory Chips Bar (Integrated directly beneath Category) */}
        {availableSubcategories.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1 px-1 text-xs min-w-0">
            <span className="text-slate-400 text-[11px] font-medium flex items-center gap-1 shrink-0 mr-1">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Subsystems:</span>
            </span>
            <button
              type="button"
              onClick={() => onSubcategoryChange?.('all')}
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition ${
                selectedSubcategory === 'all'
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-800 font-semibold'
                  : 'bg-slate-900/60 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              All Subsystems
            </button>
            {availableSubcategories.map(subcat => {
              const count = catalog.commands.filter(
                c => (selectedCategory === 'all' || c.category === selectedCategory) && c.subcategory === subcat
              ).length;
              const isSelected = selectedSubcategory === subcat;
              return (
                <button
                  key={subcat}
                  type="button"
                  onClick={() => onSubcategoryChange?.(isSelected ? 'all' : subcat)}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition flex items-center gap-1.5 ${
                    isSelected
                      ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/70 font-semibold shadow-sm'
                      : 'bg-slate-900/60 text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  <span>{subcat}</span>
                  <span className="text-[10px] opacity-75 font-mono">({count})</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. BOTTOM: Search & Primary Action Row (Right above the Command Cards) */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 min-w-0 pt-0.5">
        {/* Search input with responsive width */}
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search commands by name, ID, CAN ID, contributor (@handle), or byte..."
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-9 py-2.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-[var(--text-heading)] placeholder-slate-500 focus:outline-none focus:border-[var(--md-sys-color-primary)] focus:ring-1 focus:ring-[var(--md-sys-color-primary)] shadow-sm transition"
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-white"
              title="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Action buttons: Categories & New CAN Command */}
        <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
          {onOpenCategoryManager && (
            <button
              type="button"
              onClick={onOpenCategoryManager}
              className="dash-outline-btn flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 text-xs py-2.5 px-3 sm:px-3.5 whitespace-nowrap rounded-xl"
              title="Manage, batch rename, or merge CAN command categories"
            >
              <Layers className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>Categories</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenCreateModal}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold text-xs shadow-sm transition whitespace-nowrap"
            title="Create a new CAN automation command"
          >
            <Plus className="w-4 h-4 stroke-[2.5] shrink-0" />
            <span>New CAN Command</span>
          </button>
        </div>
      </div>
    </div>
  );
};

