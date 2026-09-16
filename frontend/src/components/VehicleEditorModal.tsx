import React, { useState, useEffect } from 'react';
import { Catalog, Vehicle, ValidationIssue } from '../types/catalog';
import { getAllKnownFeatures, validateVehicle } from '../utils/canValidator';
import {
  X,
  Car,
  Check,
  Plus,
  Trash2,
  Sparkles,
  AlertTriangle,
  HelpCircle,
  Tag,
  Globe
} from 'lucide-react';

interface VehicleEditorModalProps {
  isOpen: boolean;
  initialVehicle: Vehicle | null; // null if creating new
  catalog: Catalog;
  allDiscoveredFeatures: string[];
  onClose: () => void;
  onSave: (vehicle: Vehicle, isNew: boolean, originalId?: string) => void;
  onRegisterDiscoveredFeature: (featureName: string) => void;
}

// Popular automotive features that community might discover
const SUGGESTED_FEATURES = [
  'heated_seats',
  'ventilated_seats',
  'rear_heated_seats',
  'heated_steering_wheel',
  'touch_bar',
  'preconditioning',
  'camera_360',
  'blind_spot_view_monitor',
  'asd',
  'hud',
  'matrix_led',
  'smart_tailgate',
  'digital_side_mirrors',
  'v2l',
  'frunk_release',
  'sunroof',
  'ambient_lighting',
  'memory_seats',
  'remote_smart_parking',
  'hda2'
];

export const VehicleEditorModal: React.FC<VehicleEditorModalProps> = ({
  isOpen,
  initialVehicle,
  catalog,
  allDiscoveredFeatures,
  onClose,
  onSave,
  onRegisterDiscoveredFeature
}) => {
  const isNew = !initialVehicle;
  const originalId = initialVehicle?.id;

  const [form, setForm] = useState<Partial<Vehicle>>({
    id: '',
    name: '',
    make: 'Hyundai',
    model: '',
    trim: '',
    region: 'us',
    family: '',
    features: ['heated_seats', 'preconditioning']
  });

  const [customFeatureInput, setCustomFeatureInput] = useState('');
  const [featureSearch, setFeatureSearch] = useState('');
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [autoIdLocked, setAutoIdLocked] = useState(!initialVehicle);

  // Initialize or reset form
  useEffect(() => {
    if (initialVehicle) {
      setForm({ ...initialVehicle, features: [...initialVehicle.features] });
      setAutoIdLocked(false);
    } else {
      setForm({
        id: '',
        name: '',
        make: 'Hyundai',
        model: '',
        trim: '',
        region: 'us',
        family: '',
        features: ['heated_seats', 'preconditioning']
      });
      setAutoIdLocked(true);
    }
    setCustomFeatureInput('');
    setFeatureSearch('');
    setErrors([]);
  }, [initialVehicle, isOpen]);

  if (!isOpen) return null;

  // Auto-generate ID & Family if unlocked
  const handleModelChange = (model: string) => {
    const slug = model.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    const trimSlug = (form.trim || 'base').toLowerCase().replace(/[^a-z0-9]/g, '_');

    if (autoIdLocked) {
      setForm(prev => ({
        ...prev,
        model,
        family: prev.family || slug,
        id: `${slug}_${trimSlug}`
      }));
    } else {
      setForm(prev => ({ ...prev, model }));
    }
  };

  const handleTrimChange = (trim: string) => {
    const trimSlug = trim.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    const modelSlug = (form.model || 'veh').toLowerCase().replace(/[^a-z0-9]/g, '_');

    if (autoIdLocked) {
      setForm(prev => ({
        ...prev,
        trim,
        name: trim,
        id: `${modelSlug}_${trimSlug}`
      }));
    } else {
      setForm(prev => ({
        ...prev,
        trim,
        name: prev.name || trim
      }));
    }
  };

  // Feature handling
  const toggleFeature = (feat: string) => {
    const current = form.features || [];
    if (current.includes(feat)) {
      setForm({ ...form, features: current.filter(f => f !== feat) });
    } else {
      setForm({ ...form, features: [...current, feat] });
    }
  };

  const addCustomFeature = () => {
    const raw = customFeatureInput.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    if (!raw) return;

    onRegisterDiscoveredFeature(raw);

    const current = form.features || [];
    if (!current.includes(raw)) {
      setForm({ ...form, features: [...current, raw] });
    }
    setCustomFeatureInput('');
  };

  // All combined available features
  const combinedFeatures = Array.from(
    new Set([
      ...Array.from(getAllKnownFeatures(catalog)),
      ...allDiscoveredFeatures,
      ...SUGGESTED_FEATURES,
      ...(form.features || [])
    ])
  ).sort();

  const filteredFeatures = combinedFeatures.filter(f =>
    f.toLowerCase().includes(featureSearch.toLowerCase())
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const validation = validateVehicle(form, catalog, isNew, originalId);
    const criticalErrors = validation.filter(v => v.type === 'error');
    if (criticalErrors.length > 0) {
      setErrors(validation);
      return;
    }

    const savedVehicle: Vehicle = {
      id: form.id!.trim(),
      name: form.name?.trim() || form.trim || form.model || 'Vehicle',
      make: form.make?.trim() || 'Universal',
      model: form.model!.trim(),
      trim: form.trim?.trim() || 'Base',
      region: form.region || 'us',
      family: form.family?.trim() || form.model!.toLowerCase().replace(/\s+/g, '_'),
      features: form.features || []
    };

    onSave(savedVehicle, isNew, originalId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[var(--input-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--md-sys-color-primary)]">
              <Car className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white">
                {isNew ? 'Add Vehicle Platform & Trim' : `Edit ${form.make} ${form.model} (${form.trim})`}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Configure vehicle specifications, unique IDs, and toggle or discover trim features.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 max-h-[72vh] overflow-y-auto space-y-5 text-xs">
          {/* Errors banner */}
          {errors.length > 0 && (
            <div className="p-3.5 rounded-[12px] bg-rose-950/40 border border-rose-800 text-rose-200 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-rose-300">
                <AlertTriangle className="w-4 h-4" /> Validation Issues:
              </div>
              {errors.map((err, idx) => (
                <div key={idx} className="pl-5 text-[11px]">
                  • <span className="font-semibold">{err.field}:</span> {err.message}
                </div>
              ))}
            </div>
          )}

          {/* Make & Quick buttons */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Manufacturer / Make <span className="text-rose-400">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {['Hyundai', 'Kia', 'Genesis', 'Universal'].map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setForm({ ...form, make: m })}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${
                    form.make === m
                      ? 'bg-[var(--md-sys-color-primary)] text-white border-[var(--md-sys-color-primary)]'
                      : 'bg-[var(--input-bg)] text-slate-400 border-[var(--border-color)] hover:text-white'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <input
              type="text"
              required
              placeholder="e.g. Hyundai, Kia, Genesis"
              value={form.make || ''}
              onChange={e => setForm({ ...form, make: e.target.value })}
              className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
            />
          </div>

          {/* Model and Trim */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Model Name <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Ioniq 5, EV6, GV60, EV9"
                value={form.model || ''}
                onChange={e => handleModelChange(e.target.value)}
                className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Trim / Variant <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Limited, Wind, GT-Line, Standard"
                value={form.trim || ''}
                onChange={e => handleTrimChange(e.target.value)}
                className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              />
            </div>
          </div>

          {/* Display Name & Region */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Display Title (Optional label)
              </label>
              <input
                type="text"
                placeholder="e.g. Limited or AWD Dual-Motor"
                value={form.name || ''}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Market Region <span className="text-rose-400">*</span>
              </label>
              <select
                value={form.region || 'us'}
                onChange={e => setForm({ ...form, region: e.target.value })}
                className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              >
                <option value="us">United States (us)</option>
                <option value="eu">Europe (eu)</option>
                <option value="kr">Korea (kr)</option>
                <option value="global">Global (global)</option>
                <option value="universal">Universal (universal)</option>
              </select>
            </div>
          </div>

          {/* Vehicle ID & Family */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-300 font-semibold">
                  Unique Vehicle ID <span className="text-rose-400">*</span>
                </label>
                {autoIdLocked && (
                  <button
                    type="button"
                    onClick={() => setAutoIdLocked(false)}
                    className="text-[10px] text-cyan-400 hover:underline"
                  >
                    Unlock custom ID
                  </button>
                )}
              </div>
              <input
                type="text"
                required
                placeholder="e.g. hi5_ltd"
                value={form.id || ''}
                onChange={e => {
                  setAutoIdLocked(false);
                  setForm({ ...form, id: e.target.value });
                }}
                className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-cyan-300 font-mono focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              />
              <p className="text-[10px] text-slate-500 mt-0.5">
                Internal reference used in CAN Do catalog JSON
              </p>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Vehicle Family Slug <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. ioniq5, ev6, gv60"
                value={form.family || ''}
                onChange={e => setForm({ ...form, family: e.target.value })}
                className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white font-mono focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              />
              <p className="text-[10px] text-slate-500 mt-0.5">
                Matches vehicle command compatibility tags
              </p>
            </div>
          </div>

          {/* Features Management Section */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Tag className="w-4 h-4 text-cyan-400" />
                  Trim Features & Equipment ({form.features?.length || 0} active)
                </label>
                <p className="text-[11px] text-slate-400">
                  Select discovered features equipped on this specific trim. Commands with{' '}
                  <code className="text-cyan-300">requires_feature</code> will only run on matching vehicles.
                </p>
              </div>
            </div>

            {/* Discover / Add custom new feature inline */}
            <div className="p-3 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-2">
              <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                Discover a New Feature Not in Catalog Yet:
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="e.g. matrix_led, hud, digital_mirrors, sunroof..."
                  value={customFeatureInput}
                  onChange={e => setCustomFeatureInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustomFeature();
                    }
                  }}
                  className="flex-1 px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-cyan-300 font-mono text-xs placeholder-slate-600 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
                <button
                  type="button"
                  onClick={addCustomFeature}
                  disabled={!customFeatureInput.trim()}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold text-xs disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                  Add Feature
                </button>
              </div>
            </div>

            {/* Search & Filter Feature Tags */}
            <div className="flex items-center justify-between gap-2">
              <input
                type="text"
                placeholder="Filter feature list..."
                value={featureSearch}
                onChange={e => setFeatureSearch(e.target.value)}
                className="w-full sm:w-64 px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, features: [...combinedFeatures] })}
                  className="text-[11px] text-cyan-400 hover:underline"
                >
                  Enable All
                </button>
                <span className="text-slate-600">|</span>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, features: [] })}
                  className="text-[11px] text-slate-400 hover:text-rose-400"
                >
                  Clear All
                </button>
              </div>
            </div>

            {/* Feature Pills Selection Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-56 overflow-y-auto p-2.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
              {filteredFeatures.map(feat => {
                const isChecked = form.features?.includes(feat);
                return (
                  <button
                    key={feat}
                    type="button"
                    onClick={() => toggleFeature(feat)}
                    className={`flex items-center justify-between p-2 rounded-[8px] text-left transition font-mono text-[11px] border ${
                      isChecked
                        ? 'bg-[var(--card-bg)] text-cyan-200 border-[var(--md-sys-color-primary)] shadow-sm'
                        : 'bg-[var(--input-bg)] text-slate-400 border-[var(--border-color)] hover:border-slate-600 hover:text-slate-200'
                    }`}
                  >
                    <span className="truncate mr-1.5">{feat}</span>
                    <span
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 border ${
                        isChecked ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary)] text-white' : 'border-slate-700 bg-slate-900'
                      }`}
                    >
                      {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Features Summary Preview */}
          <div className="p-3 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-1.5">
              Active Features Summary ({form.features?.length || 0}):
            </div>
            <div className="flex flex-wrap gap-1">
              {form.features && form.features.length > 0 ? (
                form.features.map(f => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono bg-[var(--input-bg)] text-cyan-300 border border-[var(--border-color)]"
                  >
                    {f}
                    <button
                      type="button"
                      onClick={() => toggleFeature(f)}
                      className="hover:text-white"
                      title="Remove feature"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-xs text-slate-500 italic">No features currently assigned</span>
              )}
            </div>
          </div>

          {/* Modal Footer */}
          <div className="pt-4 flex items-center justify-between border-t border-[var(--border-color)]">
            <button
              type="button"
              onClick={onClose}
              className="dash-outline-btn px-4 py-2 text-xs font-semibold"
            >
              Cancel
            </button>

            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold text-xs shadow-md transition"
            >
              <Check className="w-4 h-4 stroke-[2.5]" />
              {isNew ? 'Add Vehicle Platform' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
