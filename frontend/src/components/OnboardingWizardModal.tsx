import React, { useState, useMemo } from 'react';
import {
  Tabs,
  Switch,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter
} from '@heroui/react';
import { Catalog, Vehicle } from '../types/catalog';
import { UserPreferences, UpdatePolicy, DEFAULT_USER_PREFERENCES } from '../types/settings';
import { isRunningOnDevice } from '../utils/hostUtils';
import { formatPlatformFamily } from '../utils/catalogUtils';
import { STANDARD_TIMEZONES, detectBrowserTimezone, getTimezoneLabel } from '../utils/timezone';
import {
  Car,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Wifi,
  Sparkles,
  Shield,
  Clock,
  Home,
  ExternalLink,
  ArrowRight,
  Gauge,
  Sliders,
  Bell,
  RefreshCw,
  X
} from 'lucide-react';

interface OnboardingWizardModalProps {
  isOpen: boolean;
  catalog: Catalog;
  initialPreferences?: UserPreferences;
  onComplete: (preferences: UserPreferences) => void;
  onClose: () => void;
}

export function OnboardingWizardModal({
  isOpen,
  catalog,
  initialPreferences = DEFAULT_USER_PREFERENCES,
  onComplete,
  onClose,
}: OnboardingWizardModalProps) {
  const [step, setStep] = useState<number>(1);
  const [vehicleId, setVehicleId] = useState<string>(initialPreferences.vehicle_id || 'ev6_gtline');
  const [unitSystem, setUnitSystem] = useState<'imperial' | 'metric'>(initialPreferences.unit_system || 'imperial');
  const [timezone, setTimezone] = useState<string>(initialPreferences.timezone || detectBrowserTimezone());

  // Wi-Fi inputs
  const [wifiSsid, setWifiSsid] = useState<string>('');
  const [wifiPassword, setWifiPassword] = useState<string>('');

  // Update preferences
  const [updatePolicy, setUpdatePolicy] = useState<UpdatePolicy>(initialPreferences.update_policy || 'prompt');
  const [updateFirmware, setUpdateFirmware] = useState<boolean>(initialPreferences.update_components.firmware);
  const [updateCatalog, setUpdateCatalog] = useState<boolean>(initialPreferences.update_components.catalog);
  const [updateFrontend, setUpdateFrontend] = useState<boolean>(initialPreferences.update_components.frontend);
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(initialPreferences.update_schedule.enabled);
  const [scheduleTime, setScheduleTime] = useState<string>(initialPreferences.update_schedule.time || '03:00');

  // HA state
  const [haInterested, setHaInterested] = useState<boolean>(false);

  // Active vehicle helper
  const selectedVehicle = useMemo(() => {
    return catalog.vehicles?.find((v) => v.id === vehicleId) || catalog.vehicles?.[0];
  }, [catalog.vehicles, vehicleId]);

  const selectedMake = selectedVehicle?.make || 'Universal';
  const selectedModel = selectedVehicle?.model || '';

  // 1. Available Makes
  const availableMakes = useMemo(() => {
    const makes = new Set(catalog.vehicles?.map(v => v.make || 'Universal') || []);
    return Array.from(makes).sort();
  }, [catalog.vehicles]);

  // 2. Available Models for current Make
  const availableModels = useMemo(() => {
    const models = new Set(
      catalog.vehicles
        ?.filter(v => (v.make || 'Universal') === selectedMake)
        .map(v => v.model) || []
    );
    return Array.from(models).sort();
  }, [catalog.vehicles, selectedMake]);

  // 3. Available Trims for current Make & Model
  const availableTrims = useMemo(() => {
    return (
      catalog.vehicles?.filter(
        v => (v.make || 'Universal') === selectedMake && v.model === selectedModel
      ) || []
    );
  }, [catalog.vehicles, selectedMake, selectedModel]);

  const handleMakeChange = (newMake: string) => {
    const candidates = catalog.vehicles?.filter(v => (v.make || 'Universal') === newMake) || [];
    if (candidates.length === 0) return;
    const matchingModel = candidates.find(v => v.model === selectedModel);
    setVehicleId((matchingModel || candidates[0]).id);
  };

  const handleModelChange = (newModel: string) => {
    const candidates = catalog.vehicles?.filter(
      v => (v.make || 'Universal') === selectedMake && v.model === newModel
    ) || [];
    if (candidates.length === 0) return;
    const matchingTrim = candidates.find(v => v.trim === selectedVehicle?.trim);
    setVehicleId((matchingTrim || candidates[0]).id);
  };

  if (!isOpen) return null;

  const handleFinish = () => {
    const finalPrefs: UserPreferences = {
      onboarding_completed: true,
      vehicle_id: vehicleId,
      unit_system: unitSystem,
      timezone: timezone,
      update_policy: updatePolicy,
      update_components: {
        firmware: updateFirmware,
        catalog: updateCatalog,
        frontend: updateFrontend,
      },
      update_schedule: {
        enabled: scheduleEnabled,
        time: scheduleTime,
      },
      ha_prompt_dismissed: true,
      last_update_check: new Date().toISOString(),
    };
    onComplete(finalPrefs);
  };

  const stepsTotal = 5;

  return (
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="top" scroll="inside" className="w-full p-3 pt-4 sm:p-6 sm:pt-10">
          <ModalDialog className="relative w-full max-w-2xl rounded-3xl bg-overlay border border-border shadow-overlay flex flex-col max-h-full overflow-hidden text-overlay-foreground p-0">
            {/* Header with Progress Steps */}
            <ModalHeader className="relative p-5 sm:p-6 pr-14 sm:pr-16 border-b border-separator bg-surface flex flex-row items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-accent-soft border border-accent/30 flex items-center justify-center text-accent shrink-0">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <ModalHeading className="text-base sm:text-lg font-bold text-foreground tracking-tight">
                    Welcome to CAN Do
                  </ModalHeading>
                  <p className="text-xs text-muted">
                    Quick Setup &bull; Step {step} of {stepsTotal}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close setup"
                title="Close setup"
                className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full bg-surface-secondary hover:bg-surface-tertiary text-muted hover:text-foreground flex items-center justify-center transition border border-border/50 shadow-sm"
              >
                <X className="w-4 h-4" />
              </button>
            </ModalHeader>

            {/* Progress Bar */}
            <div className="w-full bg-surface-secondary h-1">
              <div
                className="bg-accent h-1 transition-all duration-300"
                style={{ width: `${(step / stepsTotal) * 100}%` }}
              />
            </div>

            {/* Wizard Step Tabs Navigation */}
            <div className="px-4 sm:px-6 py-2.5 border-b border-separator bg-surface">
              <Tabs
                selectedKey={String(step)}
                onSelectionChange={key => setStep(Number(key))}
                aria-label="Onboarding Wizard Steps"
              >
                <Tabs.ListContainer className="p-1 rounded-2xl bg-default border border-border overflow-x-auto no-scrollbar">
                  <Tabs.List className="gap-1 flex-nowrap w-full">
                    <Tabs.Tab
                      id="1"
                      className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${step === 1 ? 'text-segment-foreground' : 'text-muted hover:text-foreground'
                        }`}
                    >
                      <Car className={`w-3.5 h-3.5 shrink-0 ${step === 1 ? 'text-accent' : 'text-muted'}`} />
                      <span className="truncate">1. Vehicle</span>
                      <Tabs.Indicator className="rounded-xl bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="2"
                      className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${step === 2 ? 'text-segment-foreground' : 'text-muted hover:text-foreground'
                        }`}
                    >
                      <Wifi className={`w-3.5 h-3.5 shrink-0 ${step === 2 ? 'text-accent' : 'text-muted'}`} />
                      <span className="truncate">2. Wi-Fi</span>
                      <Tabs.Indicator className="rounded-xl bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="3"
                      className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${step === 3 ? 'text-segment-foreground' : 'text-muted hover:text-foreground'
                        }`}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${step === 3 ? 'text-accent' : 'text-muted'}`} />
                      <span className="truncate">3. Updates</span>
                      <Tabs.Indicator className="rounded-xl bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="4"
                      className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${step === 4 ? 'text-segment-foreground' : 'text-muted hover:text-foreground'
                        }`}
                    >
                      <Home className={`w-3.5 h-3.5 shrink-0 ${step === 4 ? 'text-accent' : 'text-muted'}`} />
                      <span className="truncate">4. HA Setup</span>
                      <Tabs.Indicator className="rounded-xl bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="5"
                      className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${step === 5 ? 'text-segment-foreground' : 'text-muted hover:text-foreground'
                        }`}
                    >
                      <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${step === 5 ? 'text-success' : 'text-muted'}`} />
                      <span className="truncate">5. Review</span>
                      <Tabs.Indicator className="rounded-xl bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </div>

            {/* Modal Body */}
            <ModalBody className="p-5 sm:p-7 overflow-y-auto flex-1 space-y-6">

              {/* =========================================================
              STEP 1: Vehicle Selection & Unit System
             ========================================================= */}
              {step === 1 && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-2">
                      <Car className="w-4 h-4 text-accent" />
                      Select Your Vehicle & Preferred Units
                    </h3>
                  </div>

                  {/* Make / Model / Trim Cascading Selectors */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-foreground flex items-center justify-between">
                      <span>Vehicle Specification</span>
                      <span className="text-[11px] font-normal text-muted">
                        Select Make, Model, and Trim Variant
                      </span>
                    </label>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* 1. Manufacturer / Make */}
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted">Manufacturer</label>
                        <select
                          value={selectedMake}
                          onChange={(e) => handleMakeChange(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl bg-surface-secondary border border-border text-xs sm:text-sm text-foreground focus:outline-none focus:border-focus transition"
                        >
                          {availableMakes.map((m) => (
                            <option key={m} value={m} className="bg-overlay text-overlay-foreground">
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 2. Model */}
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted">Model</label>
                        <select
                          value={selectedModel}
                          onChange={(e) => handleModelChange(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl bg-surface-secondary border border-border text-xs sm:text-sm text-foreground focus:outline-none focus:border-focus transition"
                        >
                          {availableModels.map((m) => (
                            <option key={m} value={m} className="bg-overlay text-overlay-foreground">
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 3. Trim & Region */}
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted">Trim & Region</label>
                        <select
                          value={vehicleId}
                          onChange={(e) => setVehicleId(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl bg-surface-secondary border border-border text-xs sm:text-sm text-foreground focus:outline-none focus:border-focus transition"
                        >
                          {availableTrims.map((v) => (
                            <option key={v.id} value={v.id} className="bg-overlay text-overlay-foreground">
                              {v.trim} ({v.region.toUpperCase()})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Vehicle Badge & Features Preview */}
                  {selectedVehicle && (
                    <div className="p-4 rounded-2xl bg-surface-secondary border border-border flex flex-col sm:flex-row items-center gap-4">
                      <div className="w-full sm:w-28 h-20 flex flex-col items-center justify-center bg-surface-tertiary rounded-xl p-2 border border-border text-accent gap-1.5 shrink-0">
                        <Car className="w-8 h-8" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted font-mono">
                          {selectedVehicle.make}
                        </span>
                      </div>
                      <div className="space-y-1.5 text-center sm:text-left flex-1 min-w-0">
                        <div className="text-xs font-bold text-foreground uppercase tracking-wider">
                          {selectedVehicle.make} {selectedVehicle.model} {selectedVehicle.trim}
                        </div>
                        <div className="text-[11px] text-muted">
                          Platform: <span className="font-mono text-accent" title={selectedVehicle.family}>{formatPlatformFamily(selectedVehicle.family)}</span>
                        </div>
                        <div className="flex flex-wrap gap-1 justify-center sm:justify-start pt-1">
                          {selectedVehicle.features.slice(0, 4).map((f) => (
                            <span key={f} className="px-2 py-0.5 rounded-full text-[10px] bg-accent-soft text-accent-soft-foreground border border-accent/30">
                              {f.replace(/_/g, ' ')}
                            </span>
                          ))}
                          {selectedVehicle.features.length > 4 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-surface-tertiary text-muted border border-border">
                              +{selectedVehicle.features.length - 4} more
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Unit System Tabs */}
                  <div className="space-y-2 pt-6 border-t border-separator">
                    <label className="text-xs font-semibold text-foreground flex items-center gap-2">
                      <Gauge className="w-3.5 h-3.5 text-accent" />
                      Measurement System
                    </label>
                    <Tabs
                      selectedKey={unitSystem}
                      onSelectionChange={key => setUnitSystem(key as 'imperial' | 'metric')}
                      aria-label="Measurement Units"
                      className="w-full"
                    >
                      <Tabs.ListContainer className="p-1 rounded-2xl bg-default border border-border w-full">
                        <Tabs.List className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                          <Tabs.Tab
                            id="imperial"
                            className={`relative px-4 py-3 rounded-xl text-left cursor-pointer transition-colors ${unitSystem === 'imperial'
                              ? 'text-foreground'
                              : 'text-muted hover:text-foreground'
                              }`}
                          >
                            <div className="flex items-center gap-3">
                              {unitSystem === 'imperial' ? (
                                <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                              ) : (
                                <div className="w-4 h-4 rounded-full border border-border shrink-0" />
                              )}
                              <span
                                className={`text-xs font-bold whitespace-nowrap transition-colors ${unitSystem === 'imperial' ? 'text-foreground' : 'text-muted'
                                  }`}
                              >
                                Imperial:
                              </span>
                              <span
                                className={`text-[11px] whitespace-nowrap transition-colors ${unitSystem === 'imperial' ? 'text-accent font-medium' : 'text-muted'
                                  }`}
                              >
                                <b>MPH</b>, <b>&deg;F</b>, <b>PSI</b>
                              </span>
                            </div>
                            <Tabs.Indicator className="rounded-xl bg-accent-soft border border-accent shadow-sm" />
                          </Tabs.Tab>

                          <Tabs.Tab
                            id="metric"
                            className={`relative px-4 py-3 rounded-xl text-left cursor-pointer transition-colors ${unitSystem === 'metric'
                              ? 'text-foreground'
                              : 'text-muted hover:text-foreground'
                              }`}
                          >
                            <div className="flex items-center gap-3">
                              {unitSystem === 'metric' ? (
                                <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                              ) : (
                                <div className="w-4 h-4 rounded-full border border-border shrink-0" />
                              )}
                              <span
                                className={`text-xs font-bold whitespace-nowrap transition-colors ${unitSystem === 'metric' ? 'text-foreground' : 'text-muted'
                                  }`}
                              >
                                Metric:
                              </span>
                              <span
                                className={`text-[11px] whitespace-nowrap transition-colors ${unitSystem === 'metric' ? 'text-accent font-medium' : 'text-muted'
                                  }`}
                              >
                                <b>km/h</b>, <b>&deg;C</b>, <b>Bar/kPa</b>
                              </span>
                            </div>
                            <Tabs.Indicator className="rounded-xl bg-accent-soft border border-accent shadow-sm" />
                          </Tabs.Tab>
                        </Tabs.List>
                      </Tabs.ListContainer>
                    </Tabs>
                  </div>

                  {/* System Timezone */}
                  <div className="space-y-2 pt-6 border-t border-separator">
                    <label className="text-xs font-semibold text-foreground flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-accent" />
                      Local Timezone
                    </label>
                    <p className="text-[11px] text-muted">
                      Used by the ESP32 coprocessor for scheduled automations, quiet hours, and daylight saving time.
                    </p>
                    <select
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-surface-secondary border border-border text-sm text-foreground focus:outline-none focus:border-focus transition"
                    >
                      {STANDARD_TIMEZONES.map((tz) => (
                        <option key={tz.id} value={tz.id} className="bg-overlay text-overlay-foreground">
                          {tz.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* =========================================================
              STEP 2: Wi-Fi Setup
             ========================================================= */}
              {step === 2 && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-2">
                      <Wifi className="w-4 h-4 text-accent" />
                      Wi-Fi Connection
                    </h3>
                    <p className="text-xs text-muted mt-1">
                      Connect CAN Do to your home Wi-Fi or mobile hotspot so it can communicate with Home Assistant and receive updates while parked.
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl bg-surface-secondary border border-border space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">Network Name (SSID)</label>
                      <input
                        type="text"
                        value={wifiSsid}
                        onChange={(e) => setWifiSsid(e.target.value)}
                        placeholder="e.g. Home_Garage_2.4G"
                        className="w-full px-3.5 py-2.5 rounded-xl bg-surface-tertiary border border-border text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">Wi-Fi Password</label>
                      <input
                        type="password"
                        value={wifiPassword}
                        onChange={(e) => setWifiPassword(e.target.value)}
                        placeholder="WPA2/WPA3 Pre-shared key"
                        className="w-full px-3.5 py-2.5 rounded-xl bg-surface-tertiary border border-border text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                      />
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-surface-secondary border border-border flex items-start gap-2.5 text-muted text-xs">
                    <Shield className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                    <span>
                      <b className="text-foreground">No network nearby right now?</b> That is completely fine! You can skip this step and CAN Do will continue operating in standalone SoftAP mode (<code className="text-accent font-mono">192.168.4.1</code>).
                    </span>
                  </div>
                </div>
              )}

              {/* =========================================================
              STEP 3: Opt-in Update Preferences & Scheduling
             ========================================================= */}
              {step === 3 && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 text-accent" />
                      Software Update Policy
                    </h3>
                    <p className="text-xs text-muted mt-1">
                      CAN Do can update without a PC. Choose how you would like updates to be handled.
                    </p>
                  </div>

                  {/* 3 Main Policies */}
                  <div className="space-y-2.5">
                    {/* Policy 1: Full Auto */}
                    <div
                      onClick={() => setUpdatePolicy('auto')}
                      className={`p-3.5 rounded-2xl border cursor-pointer transition ${updatePolicy === 'auto'
                        ? 'bg-accent-soft border-accent text-foreground shadow-sm'
                        : 'bg-surface-secondary border-border text-muted hover:bg-default-hover'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-bold text-xs text-foreground">
                          <Sparkles className="w-4 h-4 text-accent" />
                          <span>Full Auto Updates (Hands-Free)</span>
                        </div>
                        {updatePolicy === 'auto' && <CheckCircle2 className="w-4 h-4 text-accent" />}
                      </div>
                      <p className="text-[11px] text-muted mt-1">
                        Automatically checks for and installs verified updates during off-hours when connected to Wi-Fi.
                      </p>
                    </div>

                    {/* Policy 2: Prompt When Available */}
                    <div
                      onClick={() => setUpdatePolicy('prompt')}
                      className={`p-3.5 rounded-2xl border cursor-pointer transition ${updatePolicy === 'prompt'
                        ? 'bg-accent-soft border-accent text-foreground shadow-sm'
                        : 'bg-surface-secondary border-border text-muted hover:bg-default-hover'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-bold text-xs text-foreground">
                          <Bell className="w-4 h-4 text-success" />
                          <span>Prompt Me When Updates Are Available (Recommended)</span>
                        </div>
                        {updatePolicy === 'prompt' && <CheckCircle2 className="w-4 h-4 text-accent" />}
                      </div>
                      <p className="text-[11px] text-muted mt-1">
                        Checks in the background and displays a notification banner in the dashboard. Never installs without your confirmation.
                      </p>
                    </div>

                    {/* Policy 3: Manual Only */}
                    <div
                      onClick={() => setUpdatePolicy('manual')}
                      className={`p-3.5 rounded-2xl border cursor-pointer transition ${updatePolicy === 'manual'
                        ? 'bg-accent-soft border-accent text-foreground shadow-sm'
                        : 'bg-surface-secondary border-border text-muted hover:bg-default-hover'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-bold text-xs text-foreground">
                          <Sliders className="w-4 h-4 text-muted" />
                          <span>Do Not Check (Manual Only)</span>
                        </div>
                        {updatePolicy === 'manual' && <CheckCircle2 className="w-4 h-4 text-accent" />}
                      </div>
                      <p className="text-[11px] text-muted mt-1">
                        Completely disables automatic checks. You can check manually anytime from the System tab.
                      </p>
                    </div>
                  </div>

                  {/* Granular Component Selection (if not manual) */}
                  {updatePolicy !== 'manual' && (
                    <div className="p-4 rounded-2xl bg-surface-secondary border border-border space-y-3">
                      <div className="text-xs font-semibold text-foreground">
                        Include in updates:
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <Switch
                          isSelected={updateFrontend}
                          onChange={setUpdateFrontend}
                          size="sm"
                          aria-label="Web Front-End"
                          className="p-2 rounded-lg bg-surface-tertiary border border-border text-xs text-foreground"
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span>Web Front-End</span>
                          </Switch.Content>
                        </Switch>

                        <Switch
                          isSelected={updateCatalog}
                          onChange={setUpdateCatalog}
                          size="sm"
                          aria-label="Message Catalog"
                          className="p-2 rounded-lg bg-surface-tertiary border border-border text-xs text-foreground"
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span>Message Catalog</span>
                          </Switch.Content>
                        </Switch>

                        <Switch
                          isSelected={updateFirmware}
                          onChange={setUpdateFirmware}
                          size="sm"
                          aria-label="Firmware Binary"
                          className="p-2 rounded-lg bg-surface-tertiary border border-border text-xs text-foreground"
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span>Firmware Binary</span>
                          </Switch.Content>
                        </Switch>
                      </div>
                    </div>
                  )}

                  {/* Scheduled Time Section */}
                  {updatePolicy !== 'manual' && (
                    <div className="p-4 rounded-2xl bg-surface-secondary border border-border space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <div className="text-xs font-semibold text-foreground flex items-center gap-2">
                            <Clock className="w-3.5 h-3.5 text-accent" />
                            Scheduled Off-Hours Install
                          </div>
                          <div className="text-[11px] text-muted">
                            Install when vehicle is typically parked overnight
                          </div>
                        </div>
                        <Switch
                          isSelected={scheduleEnabled}
                          onChange={setScheduleEnabled}
                          size="sm"
                          aria-label="Scheduled Off-Hours Install"
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span className="text-xs font-bold text-foreground">
                              {scheduleEnabled ? 'SCHEDULED' : 'OFF'}
                            </span>
                          </Switch.Content>
                        </Switch>
                      </div>

                      {scheduleEnabled && (
                        <div className="flex items-center gap-3 pt-2">
                          <span className="text-xs text-muted">Run update at:</span>
                          <input
                            type="time"
                            value={scheduleTime}
                            onChange={(e) => setScheduleTime(e.target.value)}
                            className="px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border text-xs text-foreground font-mono"
                          />
                          <span className="text-[11px] text-muted italic">(Device local time)</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* =========================================================
              STEP 4: Home Assistant Integration Spotlight
             ========================================================= */}
              {step === 4 && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-2">
                      <Home className="w-4 h-4 text-accent" />
                      Home Assistant Integration
                    </h3>
                    <p className="text-xs text-muted mt-1">
                      Connect CAN Do seamlessly into your smart home.
                    </p>
                  </div>

                  <div className="p-5 rounded-3xl bg-surface-secondary border border-accent/40 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-accent-soft border border-accent/30 flex items-center justify-center text-accent font-bold text-lg">
                        HA
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-foreground">Native Integration via HACS</h4>
                        <p className="text-xs text-muted">Automated vehicle telemetry & control services</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs text-foreground">
                      <div className="p-2.5 rounded-xl bg-surface-tertiary border border-border flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                        <span>Real-time speed, battery, tire pressure</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-surface-tertiary border border-border flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                        <span>Doors, climate & charge status</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-surface-tertiary border border-border flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                        <span>Native notify.can_do service</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-surface-tertiary border border-border flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                        <span>MQTT & Webhook auto-discovery</span>
                      </div>
                    </div>

                    <div className="pt-2 flex flex-col sm:flex-row gap-3">
                      <a
                        href="https://github.com/SuperSuave/can-do/tree/main/custom_components/can_do"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setHaInterested(true)}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-semibold transition"
                      >
                        <span>View Home Assistant Setup Guide</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setHaInterested(false);
                          setStep(5);
                        }}
                        className="px-4 py-2.5 rounded-xl bg-surface-tertiary hover:bg-default-hover text-foreground border border-border text-xs font-semibold transition text-center"
                      >
                        Skip / Not Using HA
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* =========================================================
              STEP 5: Review & Complete
             ========================================================= */}
              {step === 5 && (
                <div className="space-y-6 text-center py-2">
                  <div className="w-16 h-16 rounded-full bg-success-soft border border-success/40 flex items-center justify-center text-success mx-auto">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>

                  <div className="space-y-1">
                    <h3 className="text-lg font-bold text-foreground">Setup Complete!</h3>
                    <p className="text-xs text-muted max-w-sm mx-auto">
                      Your preferences are configured. CAN Do will not bother you with this wizard again, but you can change your settings anytime.
                    </p>
                  </div>

                  {/* Summary Card */}
                  <div className="p-4 rounded-2xl bg-surface-secondary border border-border text-left max-w-md mx-auto space-y-2 text-xs">
                    <div className="flex justify-between border-b border-separator pb-2">
                      <span className="text-muted">Vehicle:</span>
                      <span className="font-semibold text-foreground">
                        {selectedVehicle?.make} {selectedVehicle?.model} ({selectedVehicle?.trim})
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-separator pb-2">
                      <span className="text-muted">Units:</span>
                      <span className="font-semibold text-accent capitalize">{unitSystem}</span>
                    </div>
                    <div className="flex justify-between border-b border-separator pb-2">
                      <span className="text-muted">Timezone:</span>
                      <span className="font-semibold text-foreground">{getTimezoneLabel(timezone)}</span>
                    </div>
                    <div className="flex justify-between border-b border-separator pb-2">
                      <span className="text-muted">Update Policy:</span>
                      <span className="font-semibold text-foreground capitalize">
                        {updatePolicy === 'auto' ? 'Full Auto' : updatePolicy === 'prompt' ? 'Prompt on Available' : 'Manual'}
                      </span>
                    </div>
                    {updatePolicy !== 'manual' && scheduleEnabled && (
                      <div className="flex justify-between">
                        <span className="text-muted">Scheduled Time:</span>
                        <span className="font-mono text-accent">{scheduleTime}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </ModalBody>

            {/* Modal Footer Controls */}
            <ModalFooter className="p-4 sm:p-5 border-t border-separator bg-surface flex items-center justify-between shrink-0">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => setStep(step - 1)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-foreground bg-surface-secondary hover:bg-default-hover border border-border transition"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>
              ) : (
                <div />
              )}

              {step < stepsTotal ? (
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-bold text-accent-foreground bg-accent hover:bg-accent-hover transition shadow-sm"
                >
                  <span>Next</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFinish}
                  className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-xs font-bold text-success-foreground bg-success hover:bg-success-hover transition shadow-sm"
                >
                  <span>Launch Dashboard</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </ModalFooter>

          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
