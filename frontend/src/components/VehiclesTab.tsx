import React, { useState, useMemo } from 'react';
import { Tabs, Chip, Badge } from '@heroui/react';
import { Catalog, Vehicle } from '../types/catalog';
import { getAllKnownFeatures } from '../utils/canValidator';
import { VehicleEditorModal } from './VehicleEditorModal';
import {
  Car,
  Search,
  Plus,
  X,
  Globe,
  Check,
  Trash2,
  Edit3,
  Copy,
  Sparkles,
  Filter,
  Layers,
  ChevronDown,
  Info,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

interface VehiclesTabProps {
  catalog: Catalog;
  onUpdateVehicles: (vehicles: Vehicle[], modifiedVehicleId?: string, isNew?: boolean) => void;
  onSelectVehicleFilter?: (vehicleId: string) => void;
  draftAddedVehicleIds?: string[];
  draftModifiedVehicleIds?: string[];
  allDiscoveredFeatures?: string[];
  onRegisterDiscoveredFeature?: (featureName: string) => void;
  activeMainTab?: 'catalog' | 'vehicles' | 'automations' | 'device' | 'dashboard';
  onChangeMainTab?: (tab: 'catalog' | 'vehicles' | 'automations' | 'device' | 'dashboard') => void;
}

export const VehiclesTab: React.FC<VehiclesTabProps> = ({
  catalog,
  onUpdateVehicles,
  onSelectVehicleFilter,
  draftAddedVehicleIds = [],
  draftModifiedVehicleIds = [],
  allDiscoveredFeatures = [],
  onRegisterDiscoveredFeature = (_feat: string) => {},
  activeMainTab = 'vehicles',
  onChangeMainTab
}) => {
  const [search, setSearch] = useState('');
  const [selectedMake, setSelectedMake] = useState<string>('all');
  const [selectedFamily, setSelectedFamily] = useState<string>('all');
  const [selectedRegion, setSelectedRegion] = useState<string>('all');
  const [activeFeatureFilter, setActiveFeatureFilter] = useState<string | null>(null);

  // Modal states
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);

  // Quick feature discover modal
  const [isDiscoverModalOpen, setIsDiscoverModalOpen] = useState(false);
  const [discoverFeatureInput, setDiscoverFeatureInput] = useState('');
  const [discoverBulkTargetFamily, setDiscoverBulkTargetFamily] = useState<string>('none');

  // Quick inline add feature popover per card
  const [inlineAddVehicleId, setInlineAddVehicleId] = useState<string | null>(null);
  const [inlineFeatureSearch, setInlineFeatureSearch] = useState('');
  const [confirmingVehicleId, setConfirmingVehicleId] = useState<string | null>(null);

  // 1. All unique discovered & catalog features
  const combinedFeatures = useMemo(() => {
    const set = new Set<string>([
      ...Array.from(getAllKnownFeatures(catalog)),
      ...allDiscoveredFeatures
    ]);
    return Array.from(set).sort();
  }, [catalog, allDiscoveredFeatures]);

  // 2. Count commands requiring each feature
  const featureCommandCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    combinedFeatures.forEach(feat => {
      counts[feat] = catalog.commands.filter(c => c.requires_feature === feat).length;
    });
    return counts;
  }, [catalog.commands, combinedFeatures]);

  // 3. Count vehicles equipped with each feature
  const featureVehicleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    combinedFeatures.forEach(feat => {
      counts[feat] = catalog.vehicles.filter(v => v.features?.includes(feat)).length;
    });
    return counts;
  }, [catalog.vehicles, combinedFeatures]);

  // 4. Unique makes
  const availableMakes = useMemo(() => {
    const makes = new Set(catalog.vehicles.map(v => v.make || 'Universal'));
    return ['all', ...Array.from(makes).sort()];
  }, [catalog.vehicles]);

  // 5. Unique families
  const availableFamilies = useMemo(() => {
    const families = new Set(catalog.vehicles.map(v => v.family));
    return Array.from(families).sort();
  }, [catalog.vehicles]);

  // 6. Filtered vehicles list
  const filteredVehicles = useMemo(() => {
    const q = search.toLowerCase().trim();
    return catalog.vehicles.filter(v => {
      if (selectedMake !== 'all' && v.make !== selectedMake) return false;
      if (selectedFamily !== 'all' && v.family !== selectedFamily) return false;
      if (selectedRegion !== 'all' && v.region !== selectedRegion) return false;
      if (activeFeatureFilter && !v.features.includes(activeFeatureFilter)) return false;

      if (q) {
        const matchesName = v.name?.toLowerCase().includes(q);
        const matchesMake = v.make.toLowerCase().includes(q);
        const matchesModel = v.model.toLowerCase().includes(q);
        const matchesTrim = v.trim.toLowerCase().includes(q);
        const matchesFamily = v.family.toLowerCase().includes(q);
        const matchesId = v.id.toLowerCase().includes(q);
        const matchesFeature = v.features.some(f => f.toLowerCase().includes(q));

        if (
          !matchesName &&
          !matchesMake &&
          !matchesModel &&
          !matchesTrim &&
          !matchesFamily &&
          !matchesId &&
          !matchesFeature
        ) {
          return false;
        }
      }

      return true;
    });
  }, [catalog.vehicles, search, selectedMake, selectedFamily, selectedRegion, activeFeatureFilter]);

  // Count commands compatible with a vehicle
  const countCommandsForVehicle = (vehicle: Vehicle) => {
    return catalog.commands.filter(cmd => {
      if (cmd.requires_feature && !vehicle.features.includes(cmd.requires_feature)) {
        return false;
      }
      if (cmd.tags && cmd.tags.length > 0) {
        const matchesTag = cmd.tags.some(
          t => vehicle.id.includes(t) || vehicle.family.includes(t)
        );
        if (!matchesTag) return false;
      }
      return true;
    }).length;
  };

  // Handlers for Vehicle Editor
  const handleOpenAdd = () => {
    setEditingVehicle(null);
    setIsEditorOpen(true);
  };

  const handleOpenEdit = (vehicle: Vehicle) => {
    setEditingVehicle(vehicle);
    setIsEditorOpen(true);
  };

  const handleCloneVehicle = (vehicle: Vehicle) => {
    const cloned: Vehicle = {
      ...vehicle,
      id: `${vehicle.id}_variant_${Date.now().toString(36).slice(-3)}`,
      name: `${vehicle.name} (Copy)`,
      trim: `${vehicle.trim} Facelift`,
      features: [...vehicle.features]
    };
    setEditingVehicle(cloned);
    setIsEditorOpen(true);
  };

  const handleSaveVehicleModal = (savedVehicle: Vehicle, isNew: boolean, originalId?: string) => {
    if (isNew) {
      onUpdateVehicles([savedVehicle, ...catalog.vehicles], savedVehicle.id, true);
    } else {
      const updated = catalog.vehicles.map(v => (v.id === originalId ? savedVehicle : v));
      onUpdateVehicles(updated, savedVehicle.id, false);
    }
  };

  const handleDeleteVehicle = (vId: string) => {
    onUpdateVehicles(catalog.vehicles.filter(v => v.id !== vId));
  };

  // Quick feature toggling directly on the vehicle card
  const handleToggleCardFeature = (vehicle: Vehicle, featureName: string) => {
    const hasFeature = vehicle.features.includes(featureName);
    const updatedFeatures = hasFeature
      ? vehicle.features.filter(f => f !== featureName)
      : [...vehicle.features, featureName];

    const updatedVehicle: Vehicle = {
      ...vehicle,
      features: updatedFeatures
    };

    const updatedList = catalog.vehicles.map(v => (v.id === vehicle.id ? updatedVehicle : v));
    onUpdateVehicles(updatedList, vehicle.id, false);
  };

  // Discover and optionally bulk-apply new feature
  const handleSaveDiscoveredFeature = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = discoverFeatureInput.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    if (!clean) return;

    onRegisterDiscoveredFeature(clean);

    if (discoverBulkTargetFamily !== 'none') {
      const updatedList = catalog.vehicles.map(v => {
        if (discoverBulkTargetFamily === 'all' || v.family === discoverBulkTargetFamily) {
          if (!v.features.includes(clean)) {
            return { ...v, features: [...v.features, clean] };
          }
        }
        return v;
      });
      onUpdateVehicles(updatedList);
    }

    setIsDiscoverModalOpen(false);
    setDiscoverFeatureInput('');
    setDiscoverBulkTargetFamily('none');
  };

  const isFiltered =
    search !== '' ||
    selectedMake !== 'all' ||
    selectedFamily !== 'all' ||
    selectedRegion !== 'all' ||
    activeFeatureFilter !== null;

  const handleResetFilters = () => {
    setSearch('');
    setSelectedMake('all');
    setSelectedFamily('all');
    setSelectedRegion('all');
    setActiveFeatureFilter(null);
  };

  return (
    <div className="space-y-3.5">
      {/* Primary search & quick action row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Search input */}
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search make, model, trim, platform family, equipped feature..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-10 py-2.5 rounded-full bg-field border border-border text-sm text-field-foreground placeholder:text-field-placeholder focus:outline-none focus:border-accent transition shadow-sm"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground rounded-full"
              title="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
          {/* Register New Feature Button */}
          <button
            type="button"
            onClick={() => setIsDiscoverModalOpen(true)}
            className="dash-outline-btn flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 text-xs py-2 px-3 sm:px-3.5 whitespace-nowrap"
            title="Register newly discovered automotive equipment tag"
          >
            <Sparkles className="w-3.5 h-3.5 text-warning shrink-0" />
            <span>+ Feature</span>
          </button>

          {/* Add Vehicle Platform */}
          <button
            type="button"
            onClick={handleOpenAdd}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full bg-accent hover:bg-accent-hover text-accent-foreground font-semibold text-xs transition shadow-sm whitespace-nowrap"
          >
            <Plus className="w-4 h-4 stroke-[2.5] shrink-0" />
            <span>Add Vehicle</span>
          </button>
        </div>
      </div>

      {/* Main View Toggle & Count Indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
        <div className="flex items-center gap-2.5">
          {/* Main View Toggle: Commands vs Vehicles */}
          {onChangeMainTab && (
            <Tabs
              selectedKey={activeMainTab}
              onSelectionChange={key => onChangeMainTab(key as 'catalog' | 'vehicles')}
              aria-label="View Sections"
            >
              <Tabs.ListContainer className="p-1 rounded-full bg-surface-secondary border border-border text-xs">
                <Tabs.List className="gap-1">
                  <Tabs.Tab
                    id="catalog"
                    className={`relative px-3.5 py-1.5 rounded-full font-bold transition cursor-pointer flex items-center gap-1.5 ${
                      activeMainTab === 'catalog'
                        ? 'text-accent-foreground'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <span>Commands</span>
                    <Badge
                      size="sm"
                      variant="secondary"
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                        activeMainTab === 'catalog'
                          ? 'bg-accent-foreground/20 text-accent-foreground'
                          : 'bg-surface-tertiary text-foreground'
                      }`}
                    >
                      {catalog.commands.length}
                    </Badge>
                    <Tabs.Indicator className="rounded-full bg-accent shadow-sm" />
                  </Tabs.Tab>

                  <Tabs.Tab
                    id="vehicles"
                    className={`relative px-3.5 py-1.5 rounded-full font-bold transition cursor-pointer flex items-center gap-1.5 ${
                      activeMainTab === 'vehicles'
                        ? 'text-accent-foreground'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <span>Vehicles</span>
                    <Badge
                      size="sm"
                      variant="secondary"
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                        activeMainTab === 'vehicles'
                          ? 'bg-accent-foreground/20 text-accent-foreground'
                          : 'bg-surface-tertiary text-foreground'
                      }`}
                    >
                      {catalog.vehicles.length}
                    </Badge>
                    <Tabs.Indicator className="rounded-full bg-accent shadow-sm" />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
          )}
        </div>

        {/* Counter & Reset */}
        <div className="flex items-center gap-2 text-xs">
          {isFiltered && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="text-xs text-accent hover:underline px-2 py-1 flex items-center gap-1"
            >
              Reset All
            </button>
          )}
          <span className="text-[11px] font-mono text-muted bg-surface-secondary border border-border px-2.5 py-1 rounded-[6px]">
            {filteredVehicles.length} / {catalog.vehicles.length} vehicles
          </span>
        </div>
      </div>

      {/* Coordinated Vehicle Specifications & Equipment Filter Bar */}
      <div className="rounded-xl border border-border bg-surface p-2.5 sm:p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Header label & active filter pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex items-center gap-1.5 font-semibold text-accent">
              <Car className="w-4 h-4" />
              <span>Vehicle Specifications & Equipment:</span>
            </div>

            {selectedMake !== 'all' && (
              <Chip
                size="sm"
                color="accent"
                variant="soft"
                className="inline-flex items-center gap-1 text-[11px] font-medium bg-accent-soft text-accent-soft-foreground border border-accent/30 px-2 py-0.5 rounded-full"
              >
                Make: {selectedMake}
                <button
                  type="button"
                  onClick={() => setSelectedMake('all')}
                  className="hover:text-foreground ml-1 cursor-pointer"
                  title="Clear make filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </Chip>
            )}

            {selectedFamily !== 'all' && (
              <Chip
                size="sm"
                color="accent"
                variant="soft"
                className="inline-flex items-center gap-1 text-[11px] font-medium bg-accent-soft text-accent-soft-foreground border border-accent/30 px-2 py-0.5 rounded-full"
              >
                Family: {selectedFamily}
                <button
                  type="button"
                  onClick={() => setSelectedFamily('all')}
                  className="hover:text-foreground ml-1 cursor-pointer"
                  title="Clear family filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </Chip>
            )}

            {selectedRegion !== 'all' && (
              <Chip
                size="sm"
                variant="secondary"
                className="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-secondary text-foreground border border-border px-2 py-0.5 rounded-full"
              >
                Region: {selectedRegion.toUpperCase()}
                <button
                  type="button"
                  onClick={() => setSelectedRegion('all')}
                  className="hover:text-accent ml-1 cursor-pointer"
                  title="Clear region filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </Chip>
            )}

            {activeFeatureFilter && (
              <Chip
                size="sm"
                color="success"
                variant="soft"
                className="inline-flex items-center gap-1 text-[11px] font-medium bg-success-soft text-success-soft-foreground border border-success/30 px-2 py-0.5 rounded-full"
              >
                Equipped: {activeFeatureFilter}
                <button
                  type="button"
                  onClick={() => setActiveFeatureFilter(null)}
                  className="hover:text-foreground ml-1 cursor-pointer"
                  title="Clear feature filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </Chip>
            )}
          </div>

          {/* Quick reset button for vehicle section */}
          {(selectedMake !== 'all' || selectedFamily !== 'all' || selectedRegion !== 'all' || activeFeatureFilter !== null) && (
            <button
              type="button"
              onClick={() => {
                setSelectedMake('all');
                setSelectedFamily('all');
                setSelectedRegion('all');
                setActiveFeatureFilter(null);
              }}
              className="text-xs text-accent hover:underline inline-flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" />
              <span>Clear Filters</span>
            </button>
          )}
        </div>

        {/* 4 Coordinated Dropdowns matching the layout */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          {/* 1. Make Filter */}
          <div className="relative">
            <select
              value={selectedMake}
              onChange={e => setSelectedMake(e.target.value)}
              className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-accent transition"
            >
              <option value="all">All Makes ({catalog.vehicles.length} models)</option>
              {availableMakes.filter(m => m !== 'all').map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* 2. Platform Family Filter */}
          <div className="relative">
            <select
              value={selectedFamily}
              onChange={e => setSelectedFamily(e.target.value)}
              className={`w-full px-3 py-2 rounded-[8px] bg-surface-secondary border focus:outline-none transition ${
                selectedFamily !== 'all'
                  ? 'border-accent text-accent font-semibold'
                  : 'border-border text-foreground focus:border-accent'
              }`}
            >
              <option value="all">All Platform Families ({availableFamilies.length})</option>
              {availableFamilies.map(fam => (
                <option key={fam} value={fam}>
                  {fam}
                </option>
              ))}
            </select>
          </div>

          {/* 3. Region Filter */}
          <div className="relative">
            <select
              value={selectedRegion}
              onChange={e => setSelectedRegion(e.target.value)}
              className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-accent transition"
            >
              <option value="all">All Regions</option>
              <option value="us">United States (us)</option>
              <option value="eu">Europe (eu)</option>
              <option value="kr">Korea (kr)</option>
              <option value="global">Global</option>
            </select>
          </div>

          {/* 4. Equipment Feature Filter */}
          <div className="relative">
            <select
              value={activeFeatureFilter || 'all'}
              onChange={e => setActiveFeatureFilter(e.target.value === 'all' ? null : e.target.value)}
              className={`w-full px-3 py-2 rounded-[8px] bg-surface-secondary border focus:outline-none transition ${
                activeFeatureFilter !== null
                  ? 'border-success text-success font-semibold'
                  : 'border-border text-foreground focus:border-accent'
              }`}
            >
              <option value="all">All Equipment Features ({combinedFeatures.length})</option>
              {combinedFeatures.map(feat => {
                const count = featureVehicleCounts[feat] || 0;
                const cmdCount = featureCommandCounts[feat] || 0;
                return (
                  <option key={feat} value={feat}>
                    {feat} ({count} {count === 1 ? 'vehicle' : 'vehicles'}{cmdCount > 0 ? `, ${cmdCount} cmds` : ''})
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        {/* Active Feature Filter Banner */}
        {activeFeatureFilter && (
          <div className="mt-2.5 pt-2.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 bg-success-soft p-2.5 rounded-lg border border-success/30">
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-success/20 text-success">
                <CheckCircle2 className="w-4 h-4" />
              </span>
              <span className="text-xs text-foreground">
                Filtering by equipped feature:{' '}
                <strong className="text-success-soft-foreground font-mono">{activeFeatureFilter}</strong>
                {' — '}
                <span className="text-muted">
                  {filteredVehicles.length} of {catalog.vehicles.length} vehicles equipped,{' '}
                  {featureCommandCounts[activeFeatureFilter] || 0} commands require this feature
                </span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveFeatureFilter(null)}
              className="text-xs py-1 px-2 rounded bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border inline-flex items-center gap-1 self-end sm:self-center transition"
            >
              <X className="w-3 h-3" />
              <span>Clear Filter</span>
            </button>
          </div>
        )}
      </div>

      {/* SECTION 3: Vehicle Cards Grid */}
      {filteredVehicles.length === 0 ? (
        <div className="p-12 text-center rounded-[16px] border border-border bg-surface">
          <Car className="w-10 h-10 text-muted mx-auto mb-3" />
          <h3 className="text-base font-semibold text-foreground">No vehicles match your search</h3>
          <p className="text-xs text-muted mt-1 max-w-sm mx-auto">
            Try adjusting your search criteria, clear active feature filters, or add a new vehicle platform.
          </p>
          <button
            type="button"
            onClick={handleResetFilters}
            className="mt-4 px-4 py-2 rounded-full bg-surface-secondary border border-border text-accent hover:bg-surface-tertiary text-xs font-semibold"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredVehicles.map(vehicle => {
            const matchingCommandsCount = countCommandsForVehicle(vehicle);
            const isAddedDraft = draftAddedVehicleIds.includes(vehicle.id);
            const isModifiedDraft =
              draftModifiedVehicleIds.includes(vehicle.id) && !isAddedDraft;

            const isInlinePickerOpen = inlineAddVehicleId === vehicle.id;

            return (
              <div
                key={vehicle.id}
                className={`p-4 sm:p-5 rounded-[12px] border transition flex flex-col justify-between overflow-hidden min-w-0 ${
                  isAddedDraft
                    ? 'border-success/60 bg-success-soft/40'
                    : isModifiedDraft
                    ? 'border-warning/60 bg-warning-soft/40'
                    : 'border-border bg-surface hover:border-border-secondary shadow-surface'
                }`}
              >
                <div className="min-w-0">
                  {/* Top card bar: Make, draft status, region */}
                  <div className="flex items-start justify-between gap-2 mb-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          size="sm"
                          color="accent"
                          variant="soft"
                          className="text-[10px] font-mono text-accent-soft-foreground uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-accent-soft border border-accent/30 shrink-0"
                        >
                          {vehicle.make}
                        </Badge>

                        {isAddedDraft && (
                          <Chip
                            size="sm"
                            color="success"
                            variant="soft"
                            className="text-[10px] font-mono text-success-soft-foreground px-1.5 py-0.5 rounded bg-success-soft border border-success/30 shrink-0"
                          >
                            + Added Draft
                          </Chip>
                        )}
                        {isModifiedDraft && (
                          <Chip
                            size="sm"
                            color="warning"
                            variant="soft"
                            className="text-[10px] font-mono text-warning-soft-foreground px-1.5 py-0.5 rounded bg-warning-soft border border-warning/30 shrink-0"
                          >
                            ~ Modified Draft
                          </Chip>
                        )}
                      </div>

                      <h3 className="text-base font-bold text-foreground leading-snug truncate" title={`${vehicle.model} • ${vehicle.trim}`}>
                        {vehicle.model}{' '}
                        <span className="text-muted font-medium text-sm">
                          • {vehicle.trim}
                        </span>
                      </h3>
                      {vehicle.name && vehicle.name !== vehicle.trim && (
                        <div className="text-xs text-muted mt-0.5 truncate" title={vehicle.name}>{vehicle.name}</div>
                      )}
                    </div>

                    <Badge
                      size="sm"
                      variant="secondary"
                      className="flex items-center gap-1 text-[10px] uppercase font-mono px-2 py-0.5 rounded-[6px] bg-surface-secondary text-foreground border border-border shrink-0"
                    >
                      <Globe className="w-3 h-3 text-accent mr-1" />
                      {vehicle.region}
                    </Badge>
                  </div>

                  {/* ID & Family metadata */}
                  <div className="text-[11px] font-mono text-muted mb-3 bg-surface-secondary px-2.5 py-1.5 rounded-[8px] border border-border flex items-center justify-between min-w-0 overflow-hidden">
                    <div className="truncate min-w-0 mr-2">
                      ID: <span className="text-accent" title={vehicle.id}>{vehicle.id}</span>
                    </div>
                    <div className="shrink-0 text-right">
                      Family: <span className="text-foreground">{vehicle.family}</span>
                    </div>
                  </div>

                  {/* Features section with interactive toggle chips */}
                  <div className="mb-4 min-w-0">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
                        Equipped Features ({vehicle.features.length}):
                      </span>

                      {/* Add feature to this vehicle button */}
                      <button
                        type="button"
                        onClick={() => {
                          setInlineAddVehicleId(isInlinePickerOpen ? null : vehicle.id);
                          setInlineFeatureSearch('');
                        }}
                        className="text-[11px] text-accent hover:underline flex items-center gap-0.5 font-semibold transition shrink-0"
                      >
                        <Plus className="w-3 h-3" />
                        {isInlinePickerOpen ? 'Done' : 'Add/Toggle'}
                      </button>
                    </div>

                    {/* Quick Inline Feature Picker */}
                    {isInlinePickerOpen && (
                      <div className="mb-2 p-2.5 rounded-[10px] bg-surface-secondary border border-accent/40 space-y-2 min-w-0">
                        <div className="flex items-center justify-between text-[11px] font-semibold text-accent">
                          <span>Toggle Features on {vehicle.trim}:</span>
                          <button
                            type="button"
                            onClick={() => setInlineAddVehicleId(null)}
                            className="text-muted hover:text-foreground"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="Filter feature to toggle..."
                          value={inlineFeatureSearch}
                          onChange={e => setInlineFeatureSearch(e.target.value)}
                          className="w-full px-2.5 py-1 rounded-[6px] bg-surface-tertiary border border-border text-xs text-foreground placeholder:text-field-placeholder min-w-0"
                        />
                        <div className="max-h-36 overflow-y-auto grid grid-cols-2 gap-1 custom-scrollbar">
                          {combinedFeatures
                            .filter(f => f.toLowerCase().includes(inlineFeatureSearch.toLowerCase()))
                            .map(feat => {
                              const isChecked = vehicle.features.includes(feat);
                              return (
                                <button
                                  key={feat}
                                  type="button"
                                  onClick={() => handleToggleCardFeature(vehicle, feat)}
                                  className={`flex items-center justify-between px-2 py-1 rounded text-[10px] font-mono border transition ${
                                    isChecked
                                      ? 'bg-accent-soft text-accent-soft-foreground border-accent/40 font-bold'
                                      : 'bg-surface-tertiary text-muted border-border hover:text-foreground'
                                  }`}
                                >
                                  <span className="truncate">{feat}</span>
                                  {isChecked && <Check className="w-2.5 h-2.5 text-accent shrink-0" />}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    )}

                    {/* Feature Chips */}
                    <div className="flex flex-wrap gap-1 max-h-36 overflow-y-auto min-w-0 custom-scrollbar">
                      {vehicle.features.length > 0 ? (
                        vehicle.features.map(f => {
                          const isFeatureFiltered = activeFeatureFilter === f;
                          return (
                            <Chip
                              key={f}
                              size="sm"
                              color={isFeatureFiltered ? 'success' : 'default'}
                              variant={isFeatureFiltered ? 'soft' : 'secondary'}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] text-[10px] font-mono border transition ${
                                isFeatureFiltered
                                  ? 'bg-success-soft text-success-soft-foreground border-success font-semibold ring-1 ring-success/50'
                                  : 'bg-surface-secondary text-success-soft-foreground border-border group hover:border-border-secondary'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => setActiveFeatureFilter(isFeatureFiltered ? null : f)}
                                className="hover:underline cursor-pointer"
                                title={isFeatureFiltered ? `Clear '${f}' filter` : `Filter vehicles with '${f}'`}
                              >
                                {f}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleToggleCardFeature(vehicle, f)}
                                className="text-muted hover:text-danger transition ml-0.5 cursor-pointer"
                                title={`Remove ${f} from this vehicle`}
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            </Chip>
                          );
                        })
                      ) : (
                        <span className="text-[11px] text-muted italic">
                          No features assigned. Click 'Add/Toggle' to equip features.
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bottom Actions Row */}
                <div className="pt-3 border-t border-separator flex items-center justify-between text-xs">
                  <Chip size="sm" variant="secondary" className="text-muted font-mono text-[11px]">
                    <strong className="text-accent mr-1">{matchingCommandsCount}</strong> compatible cmds
                  </Chip>

                  <div className="flex items-center gap-1.5">
                    {/* Filter commands link */}
                    {onSelectVehicleFilter && (
                      <button
                        type="button"
                        onClick={() => onSelectVehicleFilter(vehicle.id)}
                        className="px-2.5 py-1 rounded-[6px] bg-surface-secondary hover:bg-surface-tertiary text-accent border border-border font-medium text-xs transition"
                        title="View commands compatible with this vehicle"
                      >
                        Commands
                      </button>
                    )}

                    {/* Edit Vehicle Button */}
                    <button
                      type="button"
                      onClick={() => handleOpenEdit(vehicle)}
                      className="p-1.5 rounded-[6px] bg-surface-secondary hover:bg-accent-soft text-muted hover:text-accent border border-border hover:border-accent/40 transition"
                      title="Edit vehicle specifications and trim"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>

                    {/* Clone Vehicle Button */}
                    <button
                      type="button"
                      onClick={() => handleCloneVehicle(vehicle)}
                      className="p-1.5 rounded-[6px] bg-surface-secondary hover:bg-surface-tertiary text-muted hover:text-foreground border border-border transition"
                      title="Clone trim to create new variant"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>

                    {/* Delete Vehicle Button */}
                    {catalog.vehicles.length > 1 && (
                      confirmingVehicleId === vehicle.id ? (
                        <div className="flex items-center gap-1 bg-danger-soft border border-danger/40 px-2 py-0.5 rounded-[6px] text-xs">
                          <span className="text-[10px] text-danger-soft-foreground font-semibold">Delete?</span>
                          <button
                            type="button"
                            onClick={() => {
                              onUpdateVehicles(catalog.vehicles.filter(v => v.id !== vehicle.id));
                              setConfirmingVehicleId(null);
                            }}
                            className="px-1.5 py-0.5 bg-danger hover:bg-danger-hover text-danger-foreground rounded font-bold text-[10px] transition"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingVehicleId(null)}
                            className="px-1.5 py-0.5 bg-surface-tertiary hover:bg-default-hover text-foreground rounded text-[10px] transition"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingVehicleId(vehicle.id)}
                          className="p-1.5 rounded-[6px] bg-surface-secondary hover:bg-danger-soft text-muted hover:text-danger border border-border hover:border-danger/40 transition"
                          title="Remove vehicle from catalog"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Add Vehicle Modal */}
      <VehicleEditorModal
        isOpen={isEditorOpen}
        initialVehicle={editingVehicle}
        catalog={catalog}
        allDiscoveredFeatures={combinedFeatures}
        onClose={() => setIsEditorOpen(false)}
        onSave={handleSaveVehicleModal}
        onRegisterDiscoveredFeature={onRegisterDiscoveredFeature}
      />

      {/* Discover Feature Modal */}
      {isDiscoverModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-backdrop backdrop-blur-sm">
          <div className="relative w-full max-w-md rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-separator pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-warning" />
                <h3 className="text-base font-bold text-foreground">Discover & Register New Feature</h3>
              </div>
              <button
                onClick={() => setIsDiscoverModalOpen(false)}
                className="p-1 text-muted hover:text-foreground rounded-full hover:bg-surface-secondary"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDiscoveredFeature} className="space-y-4 text-xs">
              <div>
                <label className="block text-foreground font-semibold mb-1">
                  Feature Identifier Slug
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. matrix_led, hud, digital_side_mirrors, v2l"
                  value={discoverFeatureInput}
                  onChange={e => setDiscoverFeatureInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-accent font-mono focus:outline-none focus:border-accent"
                />
                <p className="text-[11px] text-muted mt-1">
                  Use lowercase letters, numbers, and underscores. This tag can be used in commands with{' '}
                  <code>requires_feature</code>.
                </p>
              </div>

              <div>
                <label className="block text-foreground font-semibold mb-1">
                  Optional: Bulk Equip to Vehicle Platform
                </label>
                <select
                  value={discoverBulkTargetFamily}
                  onChange={e => setDiscoverBulkTargetFamily(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-accent"
                >
                  <option value="none">Do not bulk-equip (register tag only)</option>
                  <option value="all">Equip to ALL vehicles in catalog</option>
                  {availableFamilies.map(fam => (
                    <option key={fam} value={fam}>
                      Equip to all '{fam}' trims
                    </option>
                  ))}
                </select>
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-separator">
                <button
                  type="button"
                  onClick={() => setIsDiscoverModalOpen(false)}
                  className="dash-outline-btn px-4 py-2 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-full bg-accent hover:bg-accent-hover text-accent-foreground font-bold transition shadow-sm"
                >
                  Register Feature
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
