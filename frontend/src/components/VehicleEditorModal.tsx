import React, { useState, useEffect } from 'react';
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter
} from '@heroui/react';
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

const STANDARD_MAKES = ['Hyundai', 'Kia', 'Genesis', 'Universal'];

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

  const [isCustomMake, setIsCustomMake] = useState(false);
  const [customFeatureInput, setCustomFeatureInput] = useState('');
  const [featureSearch, setFeatureSearch] = useState('');
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [autoIdLocked, setAutoIdLocked] = useState(!initialVehicle);

  // Initialize or reset form
  useEffect(() => {
    if (initialVehicle) {
      setForm({ ...initialVehicle, features: [...initialVehicle.features] });
      setAutoIdLocked(false);
      setIsCustomMake(!STANDARD_MAKES.includes(initialVehicle.make || ''));
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
      setIsCustomMake(false);
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
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-4 sm:p-6">
          <ModalDialog className="relative w-full max-w-2xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden my-auto p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="p-5 border-b border-separator bg-surface">
              <div className="flex items-center gap-2.5 pr-10">
                <div className="w-8 h-8 rounded-full bg-surface-secondary border border-border flex items-center justify-center text-accent shrink-0">
                  <Car className="w-4 h-4" />
                </div>
                <div>
                  <ModalHeading className="text-base sm:text-lg font-bold text-foreground">
                    {isNew ? 'Add Vehicle Platform & Trim' : `Edit ${form.make} ${form.model} (${form.trim})`}
                  </ModalHeading>
                  <p className="text-xs text-muted mt-0.5">
                    Configure vehicle specifications, unique IDs, and toggle or discover trim features.
                  </p>
                </div>
              </div>
            </ModalHeader>

            {/* Upper Right Close Button */}
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={onClose}
              aria-label="Close modal"
              className="absolute top-4 right-4 z-20 !rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border border-border/50 shadow-sm transition-colors"
            >
              <X className="w-4 h-4" />
            </Button>

            {/* Form Body */}
            <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
              <ModalBody className="p-6 max-h-[72vh] overflow-y-auto space-y-5 text-xs">
          {/* Errors banner */}
          {errors.length > 0 && (
            <div className="p-3.5 rounded-[12px] bg-danger-soft border border-danger/40 text-danger-soft-foreground space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-danger">
                <AlertTriangle className="w-4 h-4" /> Validation Issues:
              </div>
              {errors.map((err, idx) => (
                <div key={idx} className="pl-5 text-[11px]">
                  • <span className="font-semibold">{err.field}:</span> {err.message}
                </div>
              ))}
            </div>
          )}

          {/* Manufacturer / Make */}
          <div>
            <label className="block text-foreground font-semibold mb-1">
              Manufacturer / Make <span className="text-danger">*</span>
            </label>
            <div className={`grid gap-3 ${isCustomMake ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
              <select
                value={isCustomMake ? '__custom__' : (form.make || 'Hyundai')}
                onChange={e => {
                  const val = e.target.value;
                  if (val === '__custom__') {
                    setIsCustomMake(true);
                    setForm(prev => ({
                      ...prev,
                      make: STANDARD_MAKES.includes(prev.make || '') ? '' : prev.make
                    }));
                  } else {
                    setIsCustomMake(false);
                    setForm(prev => ({ ...prev, make: val }));
                  }
                }}
                className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-focus"
              >
                <option value="Hyundai">Hyundai</option>
                <option value="Kia">Kia</option>
                <option value="Genesis">Genesis</option>
                <option value="Universal">Universal (Cross-Platform)</option>
                <option value="__custom__">Custom / Other Manufacturer...</option>
              </select>

              {isCustomMake && (
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Lucid, Rivian, Ford, Toyota"
                  value={form.make || ''}
                  onChange={e => setForm({ ...form, make: e.target.value })}
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                />
              )}
            </div>
          </div>

          {/* Model and Trim */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-foreground font-semibold mb-1">
                Model Name <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Ioniq 5, EV6, GV60, EV9"
                value={form.model || ''}
                onChange={e => handleModelChange(e.target.value)}
                className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
              />
            </div>

            <div>
              <label className="block text-foreground font-semibold mb-1">
                Trim / Variant <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Limited, Wind, GT-Line, Standard"
                value={form.trim || ''}
                onChange={e => handleTrimChange(e.target.value)}
                className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
              />
            </div>
          </div>

          {/* Display Name & Region */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-foreground font-semibold mb-1">
                Display Title (Optional label)
              </label>
              <input
                type="text"
                placeholder="e.g. Limited or AWD Dual-Motor"
                value={form.name || ''}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
              />
            </div>

            <div>
              <label className="block text-foreground font-semibold mb-1">
                Market Region <span className="text-danger">*</span>
              </label>
              <select
                value={form.region || 'us'}
                onChange={e => setForm({ ...form, region: e.target.value })}
                className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-foreground focus:outline-none focus:border-focus"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-[12px] bg-surface-secondary border border-border">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-foreground font-semibold">
                  Unique Vehicle ID <span className="text-danger">*</span>
                </label>
                {autoIdLocked && (
                  <button
                    type="button"
                    onClick={() => setAutoIdLocked(false)}
                    className="text-[10px] text-accent hover:underline"
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
                className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-accent font-mono focus:outline-none focus:border-focus"
              />
              <p className="text-[10px] text-muted mt-0.5">
                Internal reference used in CAN Do catalog JSON
              </p>
            </div>

            <div>
              <label className="block text-foreground font-semibold mb-1">
                Vehicle Family Slug <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. ioniq5, ev6, gv60"
                value={form.family || ''}
                onChange={e => setForm({ ...form, family: e.target.value })}
                className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-foreground font-mono focus:outline-none focus:border-focus"
              />
              <p className="text-[10px] text-muted mt-0.5">
                Matches vehicle command compatibility tags
              </p>
            </div>
          </div>

          {/* Features Management Section */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-bold text-foreground flex items-center gap-1.5">
                  <Tag className="w-4 h-4 text-accent" />
                  Trim Features & Equipment ({form.features?.length || 0} active)
                </label>
                <p className="text-[11px] text-muted">
                  Select discovered features equipped on this specific trim. Commands with{' '}
                  <code className="text-accent">requires_feature</code> will only run on matching vehicles.
                </p>
              </div>
            </div>

            {/* Discover / Add custom new feature inline */}
            <div className="p-3 rounded-[12px] bg-surface-secondary border border-border space-y-2">
              <div className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-warning" />
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
                  className="flex-1 px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-accent font-mono text-xs placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onPress={addCustomFeature}
                  isDisabled={!customFeatureInput.trim()}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-accent hover:bg-accent-hover text-accent-foreground font-semibold text-xs disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                  Add Feature
                </Button>
              </div>
            </div>

            {/* Search & Filter Feature Tags */}
            <div className="flex items-center justify-between gap-2">
              <input
                type="text"
                placeholder="Filter feature list..."
                value={featureSearch}
                onChange={e => setFeatureSearch(e.target.value)}
                className="w-full sm:w-64 px-3 py-1.5 rounded-[8px] bg-surface-secondary border border-border text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
              />
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setForm({ ...form, features: [...combinedFeatures] })}
                  className="text-[11px] text-accent h-auto py-0.5 px-1.5"
                >
                  Enable All
                </Button>
                <span className="text-muted">|</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setForm({ ...form, features: [] })}
                  className="text-[11px] text-muted hover:text-danger h-auto py-0.5 px-1.5"
                >
                  Clear All
                </Button>
              </div>
            </div>

            {/* Feature Pills Selection Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-56 overflow-y-auto p-2.5 rounded-[12px] bg-surface-secondary border border-border">
              {filteredFeatures.map(feat => {
                const isChecked = form.features?.includes(feat);
                return (
                  <button
                    key={feat}
                    type="button"
                    onClick={() => toggleFeature(feat)}
                    className={`flex items-center justify-between p-2 rounded-[8px] text-left transition font-mono text-[11px] border ${
                      isChecked
                        ? 'bg-accent-soft text-accent-soft-foreground border-accent shadow-sm'
                        : 'bg-surface-tertiary text-muted border-border hover:border-border-secondary hover:text-foreground'
                    }`}
                  >
                    <span className="truncate mr-1.5">{feat}</span>
                    <span
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 border ${
                        isChecked ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-surface'
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
          <div className="p-3 rounded-[12px] bg-surface-secondary border border-border">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1.5">
              Active Features Summary ({form.features?.length || 0}):
            </div>
            <div className="flex flex-wrap gap-1">
              {form.features && form.features.length > 0 ? (
                form.features.map(f => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono bg-surface-tertiary text-accent border border-border"
                  >
                    {f}
                    <button
                      type="button"
                      onClick={() => toggleFeature(f)}
                      className="hover:text-foreground"
                      title="Remove feature"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-xs text-muted italic">No features currently assigned</span>
              )}
            </div>
          </div>
        </ModalBody>

          {/* Modal Footer */}
          <ModalFooter className="p-4 px-6 flex items-center justify-between border-t border-separator bg-surface shrink-0">
            <Button
              variant="outline"
              size="sm"
              onPress={onClose}
              className="dash-outline-btn px-4 py-2 text-xs font-semibold"
            >
              Cancel
            </Button>

            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-accent hover:bg-accent-hover text-accent-foreground font-semibold text-xs shadow-md transition"
            >
              <Check className="w-4 h-4 stroke-[2.5]" />
              {isNew ? 'Add Vehicle Platform' : 'Save Changes'}
            </Button>
          </ModalFooter>
        </form>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
