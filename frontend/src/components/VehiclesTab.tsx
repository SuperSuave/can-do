import React, { useState, useMemo } from 'react';
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
  activeMainTab?: 'catalog' | 'vehicles' | 'automations';
  onChangeMainTab?: (tab: 'catalog' | 'vehicles' | 'automations') => void;
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
          <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search make, model, trim, platform family, equipped feature..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-10 py-2.5 rounded-full bg-[var(--input-bg)] border border-[var(--border-color)] text-sm text-[var(--text-heading)] placeholder-slate-500 focus:outline-none focus:border-[var(--md-sys-color-primary)] transition shadow-sm"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white rounded-full"
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
            <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>+ Feature</span>
          </button>

          {/* Add Vehicle Platform */}
          <button
            type="button"
            onClick={handleOpenAdd}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold text-xs transition shadow-sm whitespace-nowrap"
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
            <div className="ha-segmented-group text-xs">
              <button
                type="button"
                onClick={() => onChangeMainTab('catalog')}
                className={`px-3.5 py-1.5 rounded-full font-bold transition flex items-center gap-1.5 ${
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
                className={`px-3.5 py-1.5 rounded-full font-bold transition flex items-center gap-1.5 ${
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
        </div>

        {/* Counter & Reset */}
        <div className="flex items-center gap-2 text-xs">
          {isFiltered && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="text-xs text-cyan-400 hover:underline px-2 py-1 flex items-center gap-1"
            >
              Reset All
            </button>
          )}
          <span className="text-[11px] font-mono text-slate-400 bg-[var(--input-bg)] border border-[var(--border-color)] px-2.5 py-1 rounded-[6px]">
            {filteredVehicles.length} / {catalog.vehicles.length} vehicles
          </span>
        </div>
      </div>

      {/* Coordinated Vehicle Specifications & Equipment Filter Bar */}
      <div className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)]/80 p-2.5 sm:p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Header label & active filter pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex items-center gap-1.5 font-semibold text-cyan-400">
              <Car className="w-4 h-4" />
              <span>Vehicle Specifications & Equipment:</span>
            </div>

            {selectedMake !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-cyan-950/60 text-cyan-300 border border-cyan-800/60 px-2 py-0.5 rounded-full">
                Make: {selectedMake}
                <button
                  type="button"
                  onClick={() => setSelectedMake('all')}
                  className="hover:text-white"
                  title="Clear make filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {selectedFamily !== 'all' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-blue-950/60 text-blue-300 border border-blue-800/60 px-2 py-0.5 rounded-full">
                Family: {selectedFamily}
                <button
                  type="button"
                  onClick={() => setSelectedFamily('all')}
                  className="hover:text-white"
                  title="Clear family filter"
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
                  onClick={() => setSelectedRegion('all')}
                  className="hover:text-white"
                  title="Clear region filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {activeFeatureFilter && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-emerald-950/60 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded-full">
                Equipped: {activeFeatureFilter}
                <button
                  type="button"
                  onClick={() => setActiveFeatureFilter(null)}
                  className="hover:text-white"
                  title="Clear feature filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
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
              className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline inline-flex items-center gap-1"
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
              className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition"
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
              className={`w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border focus:outline-none transition ${
                selectedFamily !== 'all'
                  ? 'border-blue-500/70 text-blue-300 font-semibold'
                  : 'border-[var(--border-color)] text-[var(--text-heading)] focus:border-[var(--md-sys-color-primary)]'
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
              className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-heading)] focus:outline-none focus:border-[var(--md-sys-color-primary)] transition"
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
              className={`w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border focus:outline-none transition ${
                activeFeatureFilter !== null
                  ? 'border-emerald-500/70 text-emerald-300 font-semibold'
                  : 'border-[var(--border-color)] text-[var(--text-heading)] focus:border-[var(--md-sys-color-primary)]'
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
          <div className="mt-2.5 pt-2.5 border-t border-[var(--border-color)]/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 bg-emerald-950/20 p-2.5 rounded-lg border border-emerald-800/30">
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-emerald-500/20 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
              </span>
              <span className="text-xs text-slate-300">
                Filtering by equipped feature:{' '}
                <strong className="text-emerald-300 font-mono">{activeFeatureFilter}</strong>
                {' — '}
                <span className="text-slate-400">
                  {filteredVehicles.length} of {catalog.vehicles.length} vehicles equipped,{' '}
                  {featureCommandCounts[activeFeatureFilter] || 0} commands require this feature
                </span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveFeatureFilter(null)}
              className="text-xs py-1 px-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white inline-flex items-center gap-1 self-end sm:self-center transition"
            >
              <X className="w-3 h-3" />
              <span>Clear Filter</span>
            </button>
          </div>
        )}
      </div>

      {/* SECTION 3: Vehicle Cards Grid */}
      {filteredVehicles.length === 0 ? (
        <div className="p-12 text-center rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)]">
          <Car className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-300">No vehicles match your search</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            Try adjusting your search criteria, clear active feature filters, or add a new vehicle platform.
          </p>
          <button
            type="button"
            onClick={handleResetFilters}
            className="mt-4 px-4 py-2 rounded-full bg-[var(--input-bg)] border border-[var(--border-color)] text-cyan-300 hover:bg-slate-800 text-xs font-semibold"
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
                    ? 'border-emerald-500/60 bg-emerald-950/15'
                    : isModifiedDraft
                    ? 'border-amber-500/60 bg-amber-950/15'
                    : 'border-[var(--border-color)] bg-[var(--card-bg)] hover:border-slate-500 shadow-sm'
                }`}
              >
                <div className="min-w-0">
                  {/* Top card bar: Make, draft status, region */}
                  <div className="flex items-start justify-between gap-2 mb-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-800 shrink-0">
                          {vehicle.make}
                        </span>

                        {isAddedDraft && (
                          <span className="text-[10px] font-mono text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-800 shrink-0">
                            + Added Draft
                          </span>
                        )}
                        {isModifiedDraft && (
                          <span className="text-[10px] font-mono text-amber-300 px-1.5 py-0.5 rounded bg-amber-950 border border-amber-800 shrink-0">
                            ~ Modified Draft
                          </span>
                        )}
                      </div>

                      <h3 className="text-base font-bold text-white leading-snug truncate" title={`${vehicle.model} • ${vehicle.trim}`}>
                        {vehicle.model}{' '}
                        <span className="text-slate-300 font-medium text-sm">
                          • {vehicle.trim}
                        </span>
                      </h3>
                      {vehicle.name && vehicle.name !== vehicle.trim && (
                        <div className="text-xs text-slate-400 mt-0.5 truncate" title={vehicle.name}>{vehicle.name}</div>
                      )}
                    </div>

                    <span className="flex items-center gap-1 text-[10px] uppercase font-mono px-2 py-0.5 rounded-[6px] bg-[var(--input-bg)] text-slate-300 border border-[var(--border-color)] shrink-0">
                      <Globe className="w-3 h-3 text-cyan-400" />
                      {vehicle.region}
                    </span>
                  </div>

                  {/* ID & Family metadata */}
                  <div className="text-[11px] font-mono text-[var(--text-muted)] mb-3 bg-[var(--input-bg)] px-2.5 py-1.5 rounded-[8px] border border-[var(--border-color)] flex items-center justify-between min-w-0 overflow-hidden">
                    <div className="truncate min-w-0 mr-2">
                      ID: <span className="text-cyan-300" title={vehicle.id}>{vehicle.id}</span>
                    </div>
                    <div className="shrink-0 text-right">
                      Family: <span className="text-slate-300">{vehicle.family}</span>
                    </div>
                  </div>

                  {/* Features section with interactive toggle chips */}
                  <div className="mb-4 min-w-0">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--text-muted)]">
                        Equipped Features ({vehicle.features.length}):
                      </span>

                      {/* Add feature to this vehicle button */}
                      <button
                        type="button"
                        onClick={() => {
                          setInlineAddVehicleId(isInlinePickerOpen ? null : vehicle.id);
                          setInlineFeatureSearch('');
                        }}
                        className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 font-semibold transition shrink-0"
                      >
                        <Plus className="w-3 h-3" />
                        {isInlinePickerOpen ? 'Done' : 'Add/Toggle'}
                      </button>
                    </div>

                    {/* Quick Inline Feature Picker */}
                    {isInlinePickerOpen && (
                      <div className="mb-2 p-2.5 rounded-[10px] bg-[var(--md-sys-color-surface-container-low)] border border-cyan-800/80 space-y-2 min-w-0">
                        <div className="flex items-center justify-between text-[11px] font-semibold text-cyan-300">
                          <span>Toggle Features on {vehicle.trim}:</span>
                          <button
                            type="button"
                            onClick={() => setInlineAddVehicleId(null)}
                            className="text-slate-400 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="Filter feature to toggle..."
                          value={inlineFeatureSearch}
                          onChange={e => setInlineFeatureSearch(e.target.value)}
                          className="w-full px-2.5 py-1 rounded-[6px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-white min-w-0"
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
                                      ? 'bg-cyan-950 text-cyan-200 border-cyan-700 font-bold'
                                      : 'bg-[var(--input-bg)] text-slate-400 border-[var(--border-color)] hover:text-white'
                                  }`}
                                >
                                  <span className="truncate">{feat}</span>
                                  {isChecked && <Check className="w-2.5 h-2.5 text-cyan-400 shrink-0" />}
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
                            <span
                              key={f}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] text-[10px] font-mono border transition ${
                                isFeatureFiltered
                                  ? 'bg-emerald-950 text-emerald-200 border-emerald-500 font-semibold ring-1 ring-emerald-500/50'
                                  : 'bg-[var(--input-bg)] text-emerald-300 border-[var(--border-color)] group hover:border-slate-500'
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
                                className="text-slate-500 hover:text-rose-400 transition ml-0.5"
                                title={`Remove ${f} from this vehicle`}
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-[11px] text-[var(--text-muted)] italic">
                          No features assigned. Click 'Add/Toggle' to equip features.
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bottom Actions Row */}
                <div className="pt-3 border-t border-[var(--border-color)] flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)] font-mono text-[11px]">
                    <strong className="text-cyan-400">{matchingCommandsCount}</strong> compatible cmds
                  </span>

                  <div className="flex items-center gap-1.5">
                    {/* Filter commands link */}
                    {onSelectVehicleFilter && (
                      <button
                        type="button"
                        onClick={() => onSelectVehicleFilter(vehicle.id)}
                        className="px-2.5 py-1 rounded-[6px] bg-[var(--input-bg)] hover:bg-slate-800 text-cyan-400 border border-[var(--border-color)] font-medium text-xs transition"
                        title="View commands compatible with this vehicle"
                      >
                        Commands
                      </button>
                    )}

                    {/* Edit Vehicle Button */}
                    <button
                      type="button"
                      onClick={() => handleOpenEdit(vehicle)}
                      className="p-1.5 rounded-[6px] bg-[var(--input-bg)] hover:bg-cyan-950 text-slate-300 hover:text-cyan-300 border border-[var(--border-color)] hover:border-cyan-800 transition"
                      title="Edit vehicle specifications and trim"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>

                    {/* Clone Vehicle Button */}
                    <button
                      type="button"
                      onClick={() => handleCloneVehicle(vehicle)}
                      className="p-1.5 rounded-[6px] bg-[var(--input-bg)] hover:bg-slate-800 text-slate-300 hover:text-white border border-[var(--border-color)] transition"
                      title="Clone trim to create new variant"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>

                    {/* Delete Vehicle Button */}
                    {catalog.vehicles.length > 1 && (
                      confirmingVehicleId === vehicle.id ? (
                        <div className="flex items-center gap-1 bg-rose-950/90 border border-rose-700/80 px-2 py-0.5 rounded-[6px] text-xs">
                          <span className="text-[10px] text-rose-200 font-semibold">Delete?</span>
                          <button
                            type="button"
                            onClick={() => {
                              onUpdateVehicles(catalog.vehicles.filter(v => v.id !== vehicle.id));
                              setConfirmingVehicleId(null);
                            }}
                            className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-[10px] transition"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingVehicleId(null)}
                            className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingVehicleId(vehicle.id)}
                          className="p-1.5 rounded-[6px] bg-[var(--input-bg)] hover:bg-rose-950 text-slate-500 hover:text-rose-400 border border-[var(--border-color)] hover:border-rose-900 transition"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="relative w-full max-w-md rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-400" />
                <h3 className="text-base font-bold text-white">Discover & Register New Feature</h3>
              </div>
              <button
                onClick={() => setIsDiscoverModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDiscoveredFeature} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Feature Identifier Slug
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. matrix_led, hud, digital_side_mirrors, v2l"
                  value={discoverFeatureInput}
                  onChange={e => setDiscoverFeatureInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-cyan-300 font-mono focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Use lowercase letters, numbers, and underscores. This tag can be used in commands with{' '}
                  <code>requires_feature</code>.
                </p>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Optional: Bulk Equip to Vehicle Platform
                </label>
                <select
                  value={discoverBulkTargetFamily}
                  onChange={e => setDiscoverBulkTargetFamily(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-slate-200 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
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

              <div className="pt-3 flex justify-end gap-2 border-t border-[var(--border-color)]">
                <button
                  type="button"
                  onClick={() => setIsDiscoverModalOpen(false)}
                  className="dash-outline-btn px-4 py-2 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-full bg-[var(--md-sys-color-primary)] text-white font-bold hover:opacity-90 transition shadow-sm"
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
