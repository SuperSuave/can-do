import React, { useMemo } from 'react';
import { Tabs, SearchField, Select, ListBox, ListBoxItem } from '@heroui/react';
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
  FileText,
  Maximize2,
  Minimize2
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
  activeMainTab?: 'catalog' | 'vehicles' | 'automations' | 'device' | 'dashboard';
  onChangeMainTab?: (tab: 'catalog' | 'vehicles' | 'automations' | 'device' | 'dashboard') => void;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
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
  onChangeMainTab,
  onExpandAll,
  onCollapseAll
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
      <div className="rounded-xl border border-border bg-surface p-2.5 sm:p-3 space-y-2.5 shadow-surface">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Header label & active pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex items-center gap-1.5 font-semibold text-accent">
              <Car className="w-4 h-4" />
              <span>Vehicle & Compatibility:</span>
            </div>

            {/* Active pills indicator */}
            {selectedMake !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-accent-soft text-accent-soft-foreground border border-accent/30 px-2 py-0.5 rounded-full">
                Make: {selectedMake}
                <button
                  type="button"
                  onClick={() => onMakeChange('all')}
                  className="hover:text-foreground ml-0.5"
                  title="Clear make filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedRegion !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-secondary text-foreground border border-border px-2 py-0.5 rounded-full">
                Region: {selectedRegion.toUpperCase()}
                <button
                  type="button"
                  onClick={() => onRegionChange('all')}
                  className="hover:text-accent ml-0.5"
                  title="Clear region filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedFeature !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-success-soft text-success-soft-foreground border border-success/30 px-2 py-0.5 rounded-full">
                Requires: {selectedFeature}
                <button
                  type="button"
                  onClick={() => onFeatureChange('all')}
                  className="hover:text-foreground ml-0.5"
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
              className="text-xs text-accent hover:underline inline-flex items-center gap-1"
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
            <Select
              selectedKey={selectedMake}
              onSelectionChange={key => handleMakeSelectChange(String(key))}
              aria-label="Filter by vehicle make"
              className="w-full min-w-0"
            >
              <Select.Trigger className="w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-accent transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer">
                <Select.Value className="truncate text-xs text-left" />
                <Select.Indicator className="w-4 h-4 text-muted shrink-0" />
              </Select.Trigger>
              <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-lg shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                <ListBox className="outline-none space-y-0.5">
                  <ListBoxItem id="all" textValue={`All Makes (${catalog.vehicles.length} models)`} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                    All Makes ({catalog.vehicles.length} models)
                  </ListBoxItem>
                  {availableMakes.filter(m => m !== 'all').map(m => (
                    <ListBoxItem key={m} id={m} textValue={m} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                      {m}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* 2. Specific Vehicle Model & Trim Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedVehicleId}
              onSelectionChange={key => handleVehicleSelectChange(String(key))}
              aria-label="Filter by specific vehicle model & trim"
              className="w-full min-w-0"
            >
              <Select.Trigger
                className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border focus:outline-none transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer ${
                  selectedVehicleId !== 'all'
                    ? 'border-accent text-accent font-semibold'
                    : 'border-border text-foreground focus:border-accent'
                }`}
              >
                <Select.Value className="truncate text-xs text-left" />
                <Select.Indicator className="w-4 h-4 text-muted shrink-0" />
              </Select.Trigger>
              <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-lg shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                <ListBox className="outline-none space-y-0.5">
                  <ListBoxItem
                    id="all"
                    textValue={selectedMake !== 'all' ? `Any ${selectedMake} Model (${availableVehicles.length})` : `Any Specific Model Trim (${catalog.vehicles.length})`}
                    className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none"
                  >
                    {selectedMake !== 'all'
                      ? `Any ${selectedMake} Model (${availableVehicles.length})`
                      : `Any Specific Model Trim (${catalog.vehicles.length})`}
                  </ListBoxItem>
                  {availableVehicles.map(v => {
                    const label = `${v.make !== selectedMake ? `${v.make} ` : ''}${v.model} (${v.trim}) [${v.region.toUpperCase()}]`;
                    return (
                      <ListBoxItem key={v.id} id={v.id} textValue={label} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                        {label}
                      </ListBoxItem>
                    );
                  })}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* 3. Region Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedRegion}
              onSelectionChange={key => onRegionChange(String(key))}
              aria-label="Filter by region"
              className="w-full min-w-0"
            >
              <Select.Trigger className="w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-accent transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer">
                <Select.Value className="truncate text-xs text-left" />
                <Select.Indicator className="w-4 h-4 text-muted shrink-0" />
              </Select.Trigger>
              <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-lg shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                <ListBox className="outline-none space-y-0.5">
                  <ListBoxItem id="all" textValue="All Regions" className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                    All Regions
                  </ListBoxItem>
                  <ListBoxItem id="us" textValue="United States (us)" className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                    United States (us)
                  </ListBoxItem>
                  <ListBoxItem id="eu" textValue="Europe (eu)" className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                    Europe (eu)
                  </ListBoxItem>
                  <ListBoxItem id="kr" textValue="Korea (kr)" className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                    Korea (kr)
                  </ListBoxItem>
                  <ListBoxItem id="global" textValue="Global" className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                    Global
                  </ListBoxItem>
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* 4. Equipment / Feature Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedFeature}
              onSelectionChange={key => onFeatureChange(String(key))}
              aria-label="Filter by equipment feature"
              className="w-full min-w-0"
            >
              <Select.Trigger
                className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border focus:outline-none transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer ${
                  selectedFeature !== 'all'
                    ? 'border-success text-success font-semibold'
                    : 'border-border text-foreground focus:border-accent'
                }`}
              >
                <Select.Value className="truncate text-xs text-left" />
                <Select.Indicator className="w-4 h-4 text-muted shrink-0" />
              </Select.Trigger>
              <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-lg shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                <ListBox className="outline-none space-y-0.5">
                  <ListBoxItem
                    id="all"
                    textValue={`All Equipment Features (${featuresWithCommands.length})`}
                    className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none"
                  >
                    All Equipment Features ({featuresWithCommands.length})
                  </ListBoxItem>
                  {featuresWithCommands.map(feat => {
                    const count = featureCommandCounts[feat] || 0;
                    const label = `${feat} (${count} ${count === 1 ? 'cmd' : 'cmds'})`;
                    return (
                      <ListBoxItem key={feat} id={feat} textValue={label} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                        {label}
                      </ListBoxItem>
                    );
                  })}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
        </div>

        {/* Active Selected Vehicle Banner (When a specific vehicle trim is selected) */}
        {selectedVehicle && (
          <div className="mt-2.5 pt-2.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-accent-soft p-3 rounded-lg border border-accent/30">
            <div className="flex items-start gap-3 min-w-0">
              <div className="p-2 rounded-lg bg-accent/15 border border-accent/30 text-accent shrink-0 mt-0.5">
                <Car className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-foreground">
                    {selectedVehicle.make} {selectedVehicle.model}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent/20 text-accent-soft-foreground border border-accent/40">
                    {selectedVehicle.trim}
                  </span>
                  <span className="px-1.5 py-0.2 rounded text-[10px] font-mono uppercase bg-surface-secondary text-foreground border border-border">
                    {selectedVehicle.region}
                  </span>
                  <span className="text-[11px] text-muted font-mono">
                    family: {selectedVehicle.family}
                  </span>
                </div>

                {/* Equipped features on this vehicle */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] text-muted">Equipped:</span>
                  {selectedVehicle.features.map(f => {
                    const isFeatureSelected = selectedFeature === f;
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => onFeatureChange(isFeatureSelected ? 'all' : f)}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded transition ${
                          isFeatureSelected
                            ? 'bg-success text-success-foreground font-bold ring-2 ring-success/50'
                            : 'bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border'
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
              <span className="text-xs font-mono text-accent-soft-foreground bg-surface-secondary px-2.5 py-1 rounded border border-accent/30">
                <strong>{filteredCount}</strong> compatible
              </span>
              {onNavigateToVehicles && (
                <button
                  type="button"
                  onClick={onNavigateToVehicles}
                  className="dash-outline-btn text-xs py-1.5 px-3 inline-flex items-center gap-1"
                  title="Inspect this vehicle in the Vehicles tab"
                >
                  <span>Specs</span>
                  <ArrowRight className="w-3 h-3 text-accent" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onVehicleChange('all')}
                className="text-xs py-1.5 px-2.5 rounded-md bg-surface-secondary hover:bg-surface-tertiary text-muted hover:text-danger border border-border inline-flex items-center gap-1 transition"
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
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 min-w-0 bg-surface p-2 sm:p-2.5 rounded-xl border border-border">
          {/* Left: View Switching & Role Segmentation */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 min-w-0">
            {/* Role Filter Pills */}
            <div className="flex flex-wrap items-center gap-1 p-1 rounded-full bg-surface-secondary border border-border text-xs">
              <button
                type="button"
                onClick={() => onRoleChange('all')}
                className={`px-2.5 sm:px-3 py-1 rounded-full font-semibold transition text-[11px] sm:text-xs ${
                  selectedRole === 'all'
                    ? 'bg-surface-tertiary text-foreground shadow-sm border border-border'
                    : 'text-muted hover:text-foreground'
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
                    : 'text-muted hover:text-warning'
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
                    : 'text-muted hover:text-accent'
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
                    : 'text-muted hover:text-success'
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
              <Select
                selectedKey={selectedCategory}
                onSelectionChange={key => {
                  onCategoryChange(String(key));
                  onSubcategoryChange?.('all');
                }}
                aria-label="Filter by category"
                className="w-full min-w-0"
              >
                <Select.Trigger className="w-full px-3 py-1.5 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-accent text-xs min-w-0 flex items-center justify-between gap-1.5 cursor-pointer">
                  <Select.Value className="truncate text-xs text-left" />
                  <Select.Indicator className="w-4 h-4 text-muted shrink-0" />
                </Select.Trigger>
                <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-lg shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                  <ListBox className="outline-none space-y-0.5">
                    <ListBoxItem id="all" textValue={`All Categories (${categories.length})`} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                      All Categories ({categories.length})
                    </ListBoxItem>
                    {categories.map(cat => (
                      <ListBoxItem key={cat} id={cat} textValue={cat} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                        {cat}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>

            {/* View Mode Toggle: Grid vs Grouped */}
            {onViewModeChange && (
              <Tabs
                selectedKey={viewMode}
                onSelectionChange={key => onViewModeChange(key as 'grid' | 'grouped')}
                aria-label="View Mode"
              >
                <Tabs.ListContainer className="p-0.5 rounded-lg bg-surface-secondary border border-border text-xs shrink-0">
                  <Tabs.List className="gap-0.5">
                    <Tabs.Tab
                      id="grid"
                      className={`relative px-2 py-1 rounded font-semibold transition cursor-pointer flex items-center gap-1 text-[11px] ${
                        viewMode === 'grid'
                          ? 'text-foreground'
                          : 'text-muted hover:text-foreground'
                      }`}
                      aria-label="Standard Grid View"
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Grid</span>
                      <Tabs.Indicator className="rounded bg-surface-tertiary shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="grouped"
                      className={`relative px-2 py-1 rounded font-semibold transition cursor-pointer flex items-center gap-1 text-[11px] ${
                        viewMode === 'grouped'
                          ? 'text-accent'
                          : 'text-muted hover:text-accent'
                      }`}
                      aria-label="Group commands by subsystem & function"
                    >
                      <FolderKanban className="w-3.5 h-3.5" />
                      <span>Grouped</span>
                      <Tabs.Indicator className="rounded bg-accent-soft border border-accent/40 shadow-sm" />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            )}

            {/* Stats & Reset Filter */}
            <div className="flex items-center gap-2 shrink-0 ml-auto sm:ml-0">
              {isFiltered && (
                <button
                  type="button"
                  onClick={handleResetAllFilters}
                  className="text-xs text-accent hover:underline px-1.5 py-0.5 flex items-center gap-1 font-medium"
                >
                  <X className="w-3 h-3" />
                  <span>Reset</span>
                </button>
              )}

              <span className="text-muted font-mono text-[11px] bg-surface-secondary px-2 py-1 rounded border border-border shrink-0">
                {filteredCount}/{totalCount}
              </span>
            </div>
          </div>
        </div>

        {/* Subsystem / Subcategory Chips Bar (Integrated directly beneath Category) */}
        {availableSubcategories.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1 px-1 text-xs min-w-0">
            <span className="text-muted text-[11px] font-medium flex items-center gap-1 shrink-0 mr-1">
              <Layers className="w-3.5 h-3.5 text-accent" />
              <span className="hidden sm:inline">Subsystems:</span>
            </span>
            <button
              type="button"
              onClick={() => onSubcategoryChange?.('all')}
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition ${
                selectedSubcategory === 'all'
                  ? 'bg-accent-soft text-accent-soft-foreground border border-accent/40 font-semibold'
                  : 'bg-surface text-muted hover:text-foreground border border-border'
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
                      ? 'bg-accent/20 text-accent-soft-foreground border border-accent/60 font-semibold shadow-sm'
                      : 'bg-surface text-muted hover:text-foreground border border-border'
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
        <SearchField
          value={search}
          onChange={onSearchChange}
          aria-label="Search catalog commands"
          className="flex-1 min-w-0"
        >
          <SearchField.Group className="relative w-full flex items-center rounded-xl bg-field border border-border focus-within:border-accent focus-within:ring-1 focus-within:ring-focus shadow-sm transition px-3 py-2 text-xs">
            <SearchField.SearchIcon className="w-4 h-4 text-muted mr-2 shrink-0" />
            <SearchField.Input
              placeholder="Search commands by name, ID, CAN ID, contributor (@handle), or byte..."
              className="w-full bg-transparent text-xs text-field-foreground placeholder:text-field-placeholder focus:outline-none"
            />
            {search && (
              <SearchField.ClearButton
                className="text-muted hover:text-foreground shrink-0 p-1 rounded-md hover:bg-surface-secondary transition cursor-pointer"
                aria-label="Clear search"
              />
            )}
          </SearchField.Group>
        </SearchField>

        {/* Action buttons: Expand/Collapse (when grouped), Categories & New CAN Command */}
        <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
          {viewMode === 'grouped' && onExpandAll && onCollapseAll && (
            <div className="inline-flex items-center p-0.5 rounded-xl bg-surface-secondary border border-border text-xs shrink-0 shadow-sm">
              <button
                type="button"
                onClick={onExpandAll}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-foreground hover:bg-surface-tertiary transition text-xs font-semibold"
                title="Expand all groups"
              >
                <Maximize2 className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="whitespace-nowrap">Expand All</span>
              </button>
              <div className="h-4 w-px bg-separator shrink-0 mx-0.5" />
              <button
                type="button"
                onClick={onCollapseAll}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-foreground hover:bg-surface-tertiary transition text-xs font-semibold"
                title="Collapse all groups"
              >
                <Minimize2 className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="whitespace-nowrap">Collapse All</span>
              </button>
            </div>
          )}

          {onOpenCategoryManager && (
            <button
              type="button"
              onClick={onOpenCategoryManager}
              className="dash-outline-btn flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 text-xs py-2.5 px-3 sm:px-3.5 whitespace-nowrap rounded-xl"
              title="Manage, batch rename, or merge CAN command categories"
            >
              <Layers className="w-4 h-4 text-accent shrink-0" />
              <span>Categories</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenCreateModal}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-accent-foreground font-semibold text-xs shadow-sm transition whitespace-nowrap"
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

