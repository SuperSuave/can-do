import React, { useMemo, useState, useRef, useEffect } from 'react';
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
  Check,
  ChevronDown,
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
  selectedSubcategories?: string[];
  onSubcategoriesChange?: (subs: string[]) => void;
  viewMode?: 'grid' | 'grouped';
  onViewModeChange?: (mode: 'grid' | 'grouped') => void;
  selectedVehicleId: string;
  onVehicleChange: (vId: string) => void;
  selectedMake?: string;
  onMakeChange?: (make: string) => void;
  selectedModel?: string;
  onModelChange?: (model: string) => void;
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
  selectedSubcategories = [],
  onSubcategoriesChange,
  viewMode = 'grid',
  onViewModeChange,
  selectedVehicleId,
  onVehicleChange,
  selectedMake = 'all',
  onMakeChange = (_val: string) => { },
  selectedModel = 'all',
  onModelChange = (_val: string) => { },
  selectedRegion = 'all',
  onRegionChange = (_val: string) => { },
  selectedFeature = 'all',
  onFeatureChange = (_val: string) => { },
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
  // State for Subsystems multi-select dropdown popover
  const [isSubsystemsOpen, setIsSubsystemsOpen] = useState(false);
  const subsystemsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSubsystemsOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (subsystemsRef.current && !subsystemsRef.current.contains(e.target as Node)) {
        setIsSubsystemsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSubsystemsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSubsystemsOpen]);
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

  // Available Models filtered by selected make & region
  const availableModels = useMemo(() => {
    const models = new Set(
      catalog.vehicles
        .filter(v => {
          if (selectedMake !== 'all' && (v.make || 'Universal') !== selectedMake) return false;
          if (selectedRegion !== 'all' && v.region !== selectedRegion) return false;
          return true;
        })
        .map(v => v.model)
    );
    return Array.from(models).sort();
  }, [catalog.vehicles, selectedMake, selectedRegion]);

  // Available Trims filtered by selected make, model, & region
  const availableTrims = useMemo(() => {
    return catalog.vehicles.filter(v => {
      if (selectedMake !== 'all' && (v.make || 'Universal') !== selectedMake) return false;
      if (selectedModel !== 'all' && v.model !== selectedModel) return false;
      if (selectedRegion !== 'all' && v.region !== selectedRegion) return false;
      return true;
    });
  }, [catalog.vehicles, selectedMake, selectedModel, selectedRegion]);

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
    selectedModel !== 'all' ||
    selectedRegion !== 'all' ||
    selectedFeature !== 'all';

  const isFiltered =
    search !== '' ||
    selectedRole !== 'all' ||
    selectedCategory !== 'all' ||
    selectedSubcategory !== 'all' ||
    selectedSubcategories.length > 0 ||
    isVehicleFiltered;

  const handleResetVehicleFilters = () => {
    onVehicleChange('all');
    onMakeChange('all');
    onModelChange('all');
    onRegionChange('all');
    onFeatureChange('all');
  };

  const handleResetAllFilters = () => {
    onSearchChange('');
    onRoleChange('all');
    onCategoryChange('all');
    onSubcategoryChange?.('all');
    onSubcategoriesChange?.([]);
    handleResetVehicleFilters();
  };

  const handleMakeSelectChange = (make: string) => {
    onMakeChange(make);
    if (make !== 'all') {
      const makeModels = new Set(
        catalog.vehicles.filter(v => (v.make || 'Universal') === make).map(v => v.model)
      );
      if (selectedModel !== 'all' && !makeModels.has(selectedModel)) {
        onModelChange('all');
        onVehicleChange('all');
      } else if (selectedVehicle && (selectedVehicle.make || 'Universal') !== make) {
        onVehicleChange('all');
      }
    }
  };

  const handleModelSelectChange = (model: string) => {
    onModelChange(model);
    if (model !== 'all') {
      const matchingVehicles = catalog.vehicles.filter(v => v.model === model);
      if (matchingVehicles.length > 0) {
        const modelMake = matchingVehicles[0].make || 'Universal';
        if (selectedMake === 'all' || selectedMake !== modelMake) {
          onMakeChange(modelMake);
        }
      }
      if (selectedVehicle && selectedVehicle.model !== model) {
        onVehicleChange('all');
      }
    } else {
      if (selectedVehicleId !== 'all') {
        onVehicleChange('all');
      }
    }
  };

  const handleTrimSelectChange = (vId: string) => {
    onVehicleChange(vId);
    if (vId !== 'all') {
      const vehicle = catalog.vehicles.find(v => v.id === vId);
      if (vehicle) {
        if (vehicle.make && selectedMake !== vehicle.make) {
          onMakeChange(vehicle.make);
        }
        if (vehicle.model && selectedModel !== vehicle.model) {
          onModelChange(vehicle.model);
        }
        if (vehicle.region && selectedRegion !== vehicle.region) {
          onRegionChange(vehicle.region);
        }
        if (selectedFeature !== 'all' && !vehicle.features?.includes(selectedFeature)) {
          onFeatureChange('all');
        }
      }
    }
  };

  const handleRegionSelectChange = (region: string) => {
    onRegionChange(region);
    if (selectedVehicle && selectedVehicle.region !== region && region !== 'all') {
      onVehicleChange('all');
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
                  onClick={() => handleMakeSelectChange('all')}
                  className="hover:text-foreground ml-0.5"
                  title="Clear make filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedModel !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-accent-soft text-accent-soft-foreground border border-accent/30 px-2 py-0.5 rounded-full">
                Model: {selectedModel}
                <button
                  type="button"
                  onClick={() => handleModelSelectChange('all')}
                  className="hover:text-foreground ml-0.5"
                  title="Clear model filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedVehicleId !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-accent-soft text-accent-soft-foreground border border-accent/30 px-2 py-0.5 rounded-full">
                Trim: {selectedVehicle ? `${selectedVehicle.model} ${selectedVehicle.trim}` : selectedVehicleId}
                <button
                  type="button"
                  onClick={() => handleTrimSelectChange('all')}
                  className="hover:text-foreground ml-0.5"
                  title="Clear trim filter"
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
                  onClick={() => handleRegionSelectChange('all')}
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

        {/* 5 Coordinated Dropdowns: Make, Model, Trim, Region, Equipment Feature */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 text-xs min-w-0">
          {/* 1. Make Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedMake}
              onSelectionChange={key => handleMakeSelectChange(String(key))}
              aria-label="Filter by vehicle make"
              className="w-full min-w-0"
            >
              <Select.Trigger className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer ${
                selectedMake !== 'all'
                  ? 'border-accent text-accent font-semibold'
                  : 'border-border text-foreground focus:border-accent'
              }`}>
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

          {/* 2. Model Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedModel}
              onSelectionChange={key => handleModelSelectChange(String(key))}
              aria-label="Filter by vehicle model"
              className="w-full min-w-0"
            >
              <Select.Trigger className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer ${
                selectedModel !== 'all'
                  ? 'border-accent text-accent font-semibold'
                  : 'border-border text-foreground focus:border-accent'
              }`}>
                <Select.Value className="truncate text-xs text-left" />
                <Select.Indicator className="w-4 h-4 text-muted shrink-0" />
              </Select.Trigger>
              <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-lg shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                <ListBox className="outline-none space-y-0.5">
                  <ListBoxItem
                    id="all"
                    textValue={selectedMake !== 'all' ? `All ${selectedMake} Models (${availableModels.length})` : `All Models (${availableModels.length})`}
                    className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none"
                  >
                    {selectedMake !== 'all' ? `All ${selectedMake} Models (${availableModels.length})` : `All Models (${availableModels.length})`}
                  </ListBoxItem>
                  {availableModels.map(model => (
                    <ListBoxItem key={model} id={model} textValue={model} className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                      {model}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* 3. Trim Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedVehicleId}
              onSelectionChange={key => handleTrimSelectChange(String(key))}
              aria-label="Filter by specific vehicle trim"
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
                    textValue={
                      selectedModel !== 'all'
                        ? `Any ${selectedModel} Trim (${availableTrims.length})`
                        : selectedMake !== 'all'
                          ? `Any ${selectedMake} Trim (${availableTrims.length})`
                          : `Any Specific Trim (${catalog.vehicles.length})`
                    }
                    className="px-2.5 py-1.5 text-xs rounded hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none"
                  >
                    {selectedModel !== 'all'
                      ? `Any ${selectedModel} Trim (${availableTrims.length})`
                      : selectedMake !== 'all'
                        ? `Any ${selectedMake} Trim (${availableTrims.length})`
                        : `Any Specific Trim (${catalog.vehicles.length})`}
                  </ListBoxItem>
                  {availableTrims.map(v => {
                    const label = selectedModel !== 'all'
                      ? `${v.trim} [${v.region.toUpperCase()}]`
                      : `${v.make !== selectedMake ? `${v.make} ` : ''}${v.model} (${v.trim}) [${v.region.toUpperCase()}]`;
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

          {/* 4. Region Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedRegion}
              onSelectionChange={key => handleRegionSelectChange(String(key))}
              aria-label="Filter by region"
              className="w-full min-w-0"
            >
              <Select.Trigger className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer ${
                selectedRegion !== 'all'
                  ? 'border-accent text-accent font-semibold'
                  : 'border-border text-foreground focus:border-accent'
              }`}>
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

          {/* 5. Equipment / Feature Filter Dropdown */}
          <div className="relative min-w-0">
            <Select
              selectedKey={selectedFeature}
              onSelectionChange={key => onFeatureChange(String(key))}
              aria-label="Filter by equipment feature"
              className="w-full min-w-0"
            >
              <Select.Trigger
                className={`w-full max-w-full px-3 py-2 rounded-[8px] bg-surface-secondary border focus:outline-none transition min-w-0 text-xs flex items-center justify-between gap-1.5 cursor-pointer ${selectedFeature !== 'all'
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
      </div>

      {/* 2. MIDDLE: Streamlined Taxonomy & View Deck */}
      <div>
        {/* Main Taxonomy Controls Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 min-w-0 bg-surface p-2 sm:p-2.5 rounded-xl border border-border">
          {/* Left: Role Filter Tabs (Styled to match Messages/Vehicles tabs without scroller clipping) */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-default border border-border shrink-0">
              <button
                type="button"
                onClick={() => onRoleChange('all')}
                className={`relative flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  selectedRole === 'all'
                    ? 'bg-segment border border-border shadow-sm text-segment-foreground'
                    : 'text-muted hover:text-foreground hover:bg-surface-secondary/50 border border-transparent'
                }`}
              >
                All Roles
              </button>

              <button
                type="button"
                onClick={() => onRoleChange('trigger')}
                className={`relative flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  selectedRole === 'trigger'
                    ? 'bg-segment border border-border shadow-sm text-warning font-bold'
                    : 'text-muted hover:text-warning hover:bg-surface-secondary/50 border border-transparent'
                }`}
              >
                Triggers
              </button>

              <button
                type="button"
                onClick={() => onRoleChange('condition')}
                className={`relative flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  selectedRole === 'condition'
                    ? 'bg-segment border border-border shadow-sm text-accent font-bold'
                    : 'text-muted hover:text-accent hover:bg-surface-secondary/50 border border-transparent'
                }`}
              >
                Conditions
              </button>

              <button
                type="button"
                onClick={() => onRoleChange('action')}
                className={`relative flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  selectedRole === 'action'
                    ? 'bg-segment border border-border shadow-sm text-success font-bold'
                    : 'text-muted hover:text-success hover:bg-surface-secondary/50 border border-transparent'
                }`}
              >
                Actions
              </button>
            </div>
          </div>

          {/* Right: Category Dropdown, Subsystems Multi-Select, View Mode & Result Metrics */}
          <div className="flex flex-wrap items-center justify-between sm:justify-start lg:justify-end gap-2 text-xs w-full lg:w-auto min-w-0">
            {/* Category Dropdown */}
            <div className="relative flex-1 sm:flex-initial min-w-[130px] max-w-full">
              <Select
                selectedKey={selectedCategory}
                onSelectionChange={key => {
                  onCategoryChange(String(key));
                  onSubcategoryChange?.('all');
                  onSubcategoriesChange?.([]);
                }}
                aria-label="Filter by category"
                className="w-full min-w-0"
              >
                <Select.Trigger className="w-full h-9 px-3 rounded-xl bg-default border border-border text-foreground focus:outline-none focus:border-focus text-xs min-w-0 flex items-center justify-between gap-1.5 cursor-pointer transition hover:border-accent/40">
                  <Select.Value className="truncate text-xs text-left" />
                  <Select.Indicator className="w-3.5 h-3.5 text-muted shrink-0" />
                </Select.Trigger>
                <Select.Popover className="min-w-[var(--trigger-width)] bg-overlay border border-border rounded-xl shadow-overlay z-50 p-1 max-h-60 overflow-y-auto">
                  <ListBox className="outline-none space-y-0.5">
                    <ListBoxItem id="all" textValue={`All Categories (${categories.length})`} className="px-2.5 py-1.5 text-xs rounded-lg hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                      All Categories ({categories.length})
                    </ListBoxItem>
                    {categories.map(cat => (
                      <ListBoxItem key={cat} id={cat} textValue={cat} className="px-2.5 py-1.5 text-xs rounded-lg hover:bg-surface-secondary text-overlay-foreground cursor-pointer outline-none">
                        {cat}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>

            {/* Subsystems Multi-Select Dropdown (Directly next to Category Dropdown) */}
            <div className="relative flex-1 sm:flex-initial min-w-[150px] max-w-full" ref={subsystemsRef}>
              <button
                type="button"
                onClick={() => setIsSubsystemsOpen(prev => !prev)}
                aria-expanded={isSubsystemsOpen}
                aria-label="Filter by subsystems"
                className={`w-full h-9 px-3 rounded-xl bg-default border text-xs min-w-0 flex items-center justify-between gap-1.5 cursor-pointer transition hover:border-accent/40 ${
                  selectedSubcategories.length > 0
                    ? 'border-accent text-accent font-semibold bg-accent-soft/20'
                    : 'border-border text-foreground'
                }`}
              >
                <div className="flex items-center gap-1.5 truncate">
                  <Layers className={`w-3.5 h-3.5 shrink-0 ${selectedSubcategories.length > 0 ? 'text-accent' : 'text-muted'}`} />
                  <span className="truncate">
                    {selectedSubcategories.length === 0
                      ? `All Subsystems (${availableSubcategories.length})`
                      : selectedSubcategories.length === 1
                        ? selectedSubcategories[0]
                        : `${selectedSubcategories.length} Subsystems`}
                  </span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${
                  isSubsystemsOpen ? 'rotate-180 text-foreground' : 'text-muted'
                }`} />
              </button>

              {isSubsystemsOpen && (
                <div className="absolute right-0 sm:right-auto sm:left-0 top-full mt-1.5 w-64 max-w-[calc(100vw-2rem)] bg-overlay border border-border rounded-xl shadow-overlay z-50 p-2 space-y-2 text-overlay-foreground">
                  {/* Top Header & Actions */}
                  <div className="flex items-center justify-between pb-1.5 border-b border-separator text-xs">
                    <span className="font-semibold text-muted text-[11px] uppercase tracking-wider">
                      {selectedSubcategories.length > 0
                        ? `${selectedSubcategories.length} of ${availableSubcategories.length} selected`
                        : `All Subsystems (${availableSubcategories.length})`}
                    </span>
                    <div className="flex items-center gap-2">
                      {selectedSubcategories.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            onSubcategoriesChange?.([]);
                            onSubcategoryChange?.('all');
                          }}
                          className="text-[11px] text-accent hover:underline font-semibold cursor-pointer"
                        >
                          Clear
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            onSubcategoriesChange?.([...availableSubcategories]);
                            onSubcategoryChange?.('all');
                          }}
                          className="text-[11px] text-accent hover:underline font-semibold cursor-pointer"
                        >
                          Select All
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Subsystems List */}
                  <div className="max-h-60 overflow-y-auto space-y-0.5 custom-scrollbar pr-0.5">
                    {availableSubcategories.map(subcat => {
                      const isSelected = selectedSubcategories.includes(subcat);
                      const count = catalog.commands.filter(
                        c => (selectedCategory === 'all' || c.category === selectedCategory) && c.subcategory === subcat
                      ).length;

                      return (
                        <button
                          key={subcat}
                          type="button"
                          onClick={() => {
                            let next: string[];
                            if (isSelected) {
                              next = selectedSubcategories.filter(s => s !== subcat);
                            } else {
                              next = [...selectedSubcategories, subcat];
                            }
                            onSubcategoriesChange?.(next);
                            onSubcategoryChange?.('all');
                          }}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                            isSelected
                              ? 'bg-accent-soft text-accent font-semibold'
                              : 'hover:bg-surface-secondary text-overlay-foreground'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-4 h-4 rounded flex items-center justify-center border transition shrink-0 ${
                              isSelected
                                ? 'bg-accent border-accent text-accent-foreground'
                                : 'border-border bg-field'
                            }`}>
                              {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                            </div>
                            <span className="truncate">{subcat}</span>
                          </div>
                          <span className="text-[10px] font-mono text-muted shrink-0 ml-2">
                            ({count})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* View Mode Toggle: Grid vs Grouped (Styled matching Messages/Vehicles tabs without scroller clipping) */}
            {onViewModeChange && (
              <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-default border border-border shrink-0">
                <button
                  type="button"
                  onClick={() => onViewModeChange('grid')}
                  aria-label="Standard Grid View"
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                    viewMode === 'grid'
                      ? 'bg-segment border border-border shadow-sm text-segment-foreground'
                      : 'text-muted hover:text-foreground hover:bg-surface-secondary/50 border border-transparent'
                  }`}
                >
                  <LayoutGrid className={`w-3.5 h-3.5 ${viewMode === 'grid' ? 'text-accent' : 'text-muted'}`} />
                  <span className="hidden sm:inline">Grid</span>
                </button>

                <button
                  type="button"
                  onClick={() => onViewModeChange('grouped')}
                  aria-label="Group commands by subsystem & function"
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                    viewMode === 'grouped'
                      ? 'bg-segment border border-border shadow-sm text-segment-foreground'
                      : 'text-muted hover:text-foreground hover:bg-surface-secondary/50 border border-transparent'
                  }`}
                >
                  <FolderKanban className={`w-3.5 h-3.5 ${viewMode === 'grouped' ? 'text-accent' : 'text-muted'}`} />
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
                  className="h-9 px-2.5 rounded-xl text-xs text-accent hover:text-accent-hover hover:bg-surface-secondary flex items-center gap-1 font-semibold transition cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Reset</span>
                </button>
              )}

              <span className="h-9 px-3 rounded-xl bg-default border border-border text-muted font-mono text-xs flex items-center justify-center shrink-0">
                {filteredCount}/{totalCount}
              </span>
            </div>
          </div>
        </div>
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

