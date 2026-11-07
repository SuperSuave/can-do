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
      <ModalBackdrop variant="blur" className="bg-slate-950/85 backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-3 sm:p-4">
          <ModalDialog className="relative w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-700/60 shadow-2xl shadow-cyan-950/40 flex flex-col max-h-[90vh] overflow-hidden text-slate-100 p-0">
            {/* Header with Progress Steps */}
            <ModalHeader className="p-5 sm:p-6 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between gap-0 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <ModalHeading className="text-base sm:text-lg font-bold text-white tracking-tight">
                    Welcome to CAN Do
                  </ModalHeading>
                  <p className="text-xs text-slate-400">
                    Quick Setup &bull; Step {step} of {stepsTotal}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="Close setup"
              >
                <X className="w-5 h-5" />
              </button>
            </ModalHeader>

        {/* Progress Bar */}
        <div className="w-full bg-slate-800 h-1">
          <div
            className="bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400 h-1 transition-all duration-300"
            style={{ width: `${(step / stepsTotal) * 100}%` }}
          />
        </div>

        {/* Wizard Step Tabs Navigation */}
        <div className="px-4 sm:px-6 pt-3 pb-1 border-b border-slate-800 bg-slate-900/50">
          <Tabs
            selectedKey={String(step)}
            onSelectionChange={key => setStep(Number(key))}
            aria-label="Onboarding Wizard Steps"
          >
            <Tabs.ListContainer className="p-1 rounded-2xl bg-slate-950/70 border border-slate-800 overflow-x-auto no-scrollbar">
              <Tabs.List className="gap-1 flex-nowrap w-full">
                <Tabs.Tab
                  id="1"
                  className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                    step === 1 ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Car className={`w-3.5 h-3.5 shrink-0 ${step === 1 ? 'text-cyan-400' : 'text-slate-500'}`} />
                  <span className="truncate">1. Vehicle</span>
                  <Tabs.Indicator className="rounded-xl bg-slate-800 border border-slate-700/80 shadow-sm" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="2"
                  className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                    step === 2 ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Wifi className={`w-3.5 h-3.5 shrink-0 ${step === 2 ? 'text-teal-400' : 'text-slate-500'}`} />
                  <span className="truncate">2. Wi-Fi</span>
                  <Tabs.Indicator className="rounded-xl bg-slate-800 border border-slate-700/80 shadow-sm" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="3"
                  className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                    step === 3 ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${step === 3 ? 'text-cyan-400' : 'text-slate-500'}`} />
                  <span className="truncate">3. Updates</span>
                  <Tabs.Indicator className="rounded-xl bg-slate-800 border border-slate-700/80 shadow-sm" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="4"
                  className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                    step === 4 ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Home className={`w-3.5 h-3.5 shrink-0 ${step === 4 ? 'text-indigo-400' : 'text-slate-500'}`} />
                  <span className="truncate">4. HA Setup</span>
                  <Tabs.Indicator className="rounded-xl bg-slate-800 border border-slate-700/80 shadow-sm" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="5"
                  className={`relative flex items-center justify-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                    step === 5 ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${step === 5 ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span className="truncate">5. Review</span>
                  <Tabs.Indicator className="rounded-xl bg-slate-800 border border-slate-700/80 shadow-sm" />
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
                <h3 className="text-sm sm:text-base font-semibold text-white flex items-center gap-2">
                  <Car className="w-4 h-4 text-cyan-400" />
                  Select Your Vehicle & Units
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Choose your vehicle profile for optimized CAN bus message decoding, telemetry graphs, and dashboard layouts.
                </p>
              </div>

              {/* Vehicle Dropdown */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-300">Vehicle Model & Trim</label>
                <select
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-slate-800/90 border border-slate-700 text-sm text-white focus:outline-none focus:border-cyan-500 transition"
                >
                  {catalog.vehicles?.map((v) => (
                    <option key={v.id} value={v.id} className="bg-slate-900 text-slate-100">
                      {v.make} {v.model} - {v.trim} ({v.region.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              {/* Vehicle Badge & Features Preview */}
              {selectedVehicle && (
                <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 flex flex-col sm:flex-row items-center gap-4">
                  <div className="w-full sm:w-28 h-20 flex flex-col items-center justify-center bg-slate-900/80 rounded-xl p-2 border border-slate-800/80 text-cyan-400 gap-1.5 shrink-0">
                    <Car className="w-8 h-8" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                      {selectedVehicle.make}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-center sm:text-left flex-1 min-w-0">
                    <div className="text-xs font-bold text-white uppercase tracking-wider">
                      {selectedVehicle.make} {selectedVehicle.model} {selectedVehicle.trim}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Platform: <span className="font-mono text-cyan-300">{selectedVehicle.family}</span>
                    </div>
                    <div className="flex flex-wrap gap-1 justify-center sm:justify-start pt-1">
                      {selectedVehicle.features.slice(0, 4).map((f) => (
                        <span key={f} className="px-2 py-0.5 rounded-full text-[10px] bg-cyan-950/50 text-cyan-300 border border-cyan-800/50">
                          {f.replace(/_/g, ' ')}
                        </span>
                      ))}
                      {selectedVehicle.features.length > 4 && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-800 text-slate-400">
                          +{selectedVehicle.features.length - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Unit System Tabs */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                  <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                  Measurement System
                </label>
                <Tabs
                  selectedKey={unitSystem}
                  onSelectionChange={key => setUnitSystem(key as 'imperial' | 'metric')}
                  aria-label="Measurement Units"
                  className="w-full"
                >
                  <Tabs.ListContainer className="p-1 rounded-2xl bg-slate-950/60 border border-slate-800 w-full">
                    <Tabs.List className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                      <Tabs.Tab
                        id="imperial"
                        className={`relative px-4 py-3 rounded-xl text-left cursor-pointer transition-colors ${
                          unitSystem === 'imperial'
                            ? 'text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {unitSystem === 'imperial' ? (
                            <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                          ) : (
                            <div className="w-4 h-4 rounded-full border border-slate-700 shrink-0" />
                          )}
                          <span
                            className={`text-xs font-bold whitespace-nowrap transition-colors ${
                              unitSystem === 'imperial' ? 'text-white' : 'text-slate-400'
                            }`}
                          >
                            Imperial:
                          </span>
                          <span
                            className={`text-[11px] whitespace-nowrap transition-colors ${
                              unitSystem === 'imperial' ? 'text-cyan-200/90 font-medium' : 'text-slate-500'
                            }`}
                          >
                            <b>MPH</b>, <b>&deg;F</b>, <b>PSI</b>
                          </span>
                        </div>
                        <Tabs.Indicator className="rounded-xl bg-cyan-950/40 border border-cyan-500 shadow-sm shadow-cyan-900/20" />
                      </Tabs.Tab>

                      <Tabs.Tab
                        id="metric"
                        className={`relative px-4 py-3 rounded-xl text-left cursor-pointer transition-colors ${
                          unitSystem === 'metric'
                            ? 'text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {unitSystem === 'metric' ? (
                            <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                          ) : (
                            <div className="w-4 h-4 rounded-full border border-slate-700 shrink-0" />
                          )}
                          <span
                            className={`text-xs font-bold whitespace-nowrap transition-colors ${
                              unitSystem === 'metric' ? 'text-white' : 'text-slate-400'
                            }`}
                          >
                            Metric:
                          </span>
                          <span
                            className={`text-[11px] whitespace-nowrap transition-colors ${
                              unitSystem === 'metric' ? 'text-cyan-200/90 font-medium' : 'text-slate-500'
                            }`}
                          >
                            <b>km/h</b>, <b>&deg;C</b>, <b>Bar/kPa</b>
                          </span>
                        </div>
                        <Tabs.Indicator className="rounded-xl bg-cyan-950/40 border border-cyan-500 shadow-sm shadow-cyan-900/20" />
                      </Tabs.Tab>
                    </Tabs.List>
                  </Tabs.ListContainer>
                </Tabs>
              </div>

              {/* System Timezone */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-cyan-400" />
                  Local Timezone
                </label>
                <p className="text-[11px] text-slate-400">
                  Used by the ESP32 coprocessor for scheduled automations, quiet hours, and daylight saving time.
                </p>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-slate-800/90 border border-slate-700 text-sm text-white focus:outline-none focus:border-cyan-500 transition"
                >
                  {STANDARD_TIMEZONES.map((tz) => (
                    <option key={tz.id} value={tz.id} className="bg-slate-900 text-slate-100">
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
                <h3 className="text-sm sm:text-base font-semibold text-white flex items-center gap-2">
                  <Wifi className="w-4 h-4 text-teal-400" />
                  Wi-Fi Connection
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Connect CAN Do to your home Wi-Fi or mobile hotspot so it can communicate with Home Assistant and receive updates while parked.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Network Name (SSID)</label>
                  <input
                    type="text"
                    value={wifiSsid}
                    onChange={(e) => setWifiSsid(e.target.value)}
                    placeholder="e.g. Home_Garage_2.4G"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-xs text-white focus:outline-none focus:border-teal-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Wi-Fi Password</label>
                  <input
                    type="password"
                    value={wifiPassword}
                    onChange={(e) => setWifiPassword(e.target.value)}
                    placeholder="WPA2/WPA3 Pre-shared key"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-xs text-white focus:outline-none focus:border-teal-500"
                  />
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-800/40 border border-slate-700/60 flex items-start gap-2.5 text-slate-400 text-xs">
                <Shield className="w-4 h-4 text-teal-400 shrink-0 mt-0.5" />
                <span>
                  <b>No network nearby right now?</b> That is completely fine! You can skip this step and CAN Do will continue operating in standalone SoftAP mode (<code>192.168.4.1</code>).
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
                <h3 className="text-sm sm:text-base font-semibold text-white flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-cyan-400" />
                  Software Update Policy
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  CAN Do can update without a PC. Choose how you would like updates to be handled.
                </p>
              </div>

              {/* 3 Main Policies */}
              <div className="space-y-2.5">
                {/* Policy 1: Full Auto */}
                <div
                  onClick={() => setUpdatePolicy('auto')}
                  className={`p-3.5 rounded-2xl border cursor-pointer transition ${
                    updatePolicy === 'auto'
                      ? 'bg-cyan-950/40 border-cyan-500 text-white shadow-sm'
                      : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-xs">
                      <Sparkles className="w-4 h-4 text-cyan-400" />
                      <span>Full Auto Updates (Hands-Free)</span>
                    </div>
                    {updatePolicy === 'auto' && <CheckCircle2 className="w-4 h-4 text-cyan-400" />}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Automatically checks for and installs verified updates during off-hours when connected to Wi-Fi.
                  </p>
                </div>

                {/* Policy 2: Prompt When Available */}
                <div
                  onClick={() => setUpdatePolicy('prompt')}
                  className={`p-3.5 rounded-2xl border cursor-pointer transition ${
                    updatePolicy === 'prompt'
                      ? 'bg-cyan-950/40 border-cyan-500 text-white shadow-sm'
                      : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-xs">
                      <Bell className="w-4 h-4 text-teal-400" />
                      <span>Prompt Me When Updates Are Available (Recommended)</span>
                    </div>
                    {updatePolicy === 'prompt' && <CheckCircle2 className="w-4 h-4 text-cyan-400" />}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Checks in the background and displays a notification banner in the dashboard. Never installs without your confirmation.
                  </p>
                </div>

                {/* Policy 3: Manual Only */}
                <div
                  onClick={() => setUpdatePolicy('manual')}
                  className={`p-3.5 rounded-2xl border cursor-pointer transition ${
                    updatePolicy === 'manual'
                      ? 'bg-cyan-950/40 border-cyan-500 text-white shadow-sm'
                      : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-xs">
                      <Sliders className="w-4 h-4 text-slate-400" />
                      <span>Do Not Check (Manual Only)</span>
                    </div>
                    {updatePolicy === 'manual' && <CheckCircle2 className="w-4 h-4 text-cyan-400" />}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Completely disables automatic checks. You can check manually anytime from the System tab.
                  </p>
                </div>
              </div>

              {/* Granular Component Selection (if not manual) */}
              {updatePolicy !== 'manual' && (
                <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-3">
                  <div className="text-xs font-semibold text-slate-300">
                    Include in updates:
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <Switch
                      isSelected={updateFrontend}
                      onChange={setUpdateFrontend}
                      size="sm"
                      aria-label="Web Front-End"
                      className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300"
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
                      className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300"
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
                      className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300"
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
                <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-cyan-400" />
                        Scheduled Off-Hours Install
                      </div>
                      <div className="text-[11px] text-slate-400">
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
                        <span className="text-xs font-bold text-slate-300">
                          {scheduleEnabled ? 'SCHEDULED' : 'OFF'}
                        </span>
                      </Switch.Content>
                    </Switch>
                  </div>

                  {scheduleEnabled && (
                    <div className="flex items-center gap-3 pt-2">
                      <span className="text-xs text-slate-400">Run update at:</span>
                      <input
                        type="time"
                        value={scheduleTime}
                        onChange={(e) => setScheduleTime(e.target.value)}
                        className="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs text-white font-mono"
                      />
                      <span className="text-[11px] text-slate-500 italic">(Device local time)</span>
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
                <h3 className="text-sm sm:text-base font-semibold text-white flex items-center gap-2">
                  <Home className="w-4 h-4 text-indigo-400" />
                  Home Assistant Integration
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Connect CAN Do seamlessly into your smart home.
                </p>
              </div>

              <div className="p-5 rounded-3xl bg-gradient-to-br from-indigo-950/40 via-slate-900 to-slate-950 border border-indigo-500/30 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-lg">
                    HA
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">Native Integration via HACS</h4>
                    <p className="text-xs text-slate-400">Automated vehicle telemetry & control services</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs text-slate-300">
                  <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Real-time speed, battery, tire pressure</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Doors, climate & charge status</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Native notify.can_do service</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>MQTT & Webhook auto-discovery</span>
                  </div>
                </div>

                <div className="pt-2 flex flex-col sm:flex-row gap-3">
                  <a
                    href="https://github.com/SuperSuave/can-do/tree/main/custom_components/can_do"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setHaInterested(true)}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
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
                    className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition text-center"
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
              <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>

              <div className="space-y-1">
                <h3 className="text-lg font-bold text-white">Setup Complete!</h3>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">
                  Your preferences are configured. CAN Do will not bother you with this wizard again, but you can change your settings anytime.
                </p>
              </div>

              {/* Summary Card */}
              <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 text-left max-w-md mx-auto space-y-2 text-xs">
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-400">Vehicle:</span>
                  <span className="font-semibold text-white">{selectedVehicle?.make} {selectedVehicle?.model}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-400">Units:</span>
                  <span className="font-semibold text-cyan-300 capitalize">{unitSystem}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-400">Timezone:</span>
                  <span className="font-semibold text-white">{getTimezoneLabel(timezone)}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-400">Update Policy:</span>
                  <span className="font-semibold text-white capitalize">
                    {updatePolicy === 'auto' ? 'Full Auto' : updatePolicy === 'prompt' ? 'Prompt on Available' : 'Manual'}
                  </span>
                </div>
                {updatePolicy !== 'manual' && scheduleEnabled && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Scheduled Time:</span>
                    <span className="font-mono text-cyan-300">{scheduleTime}</span>
                  </div>
                )}
              </div>
            </div>
          )}

        </ModalBody>

        {/* Modal Footer Controls */}
        <ModalFooter className="p-4 sm:p-5 border-t border-slate-800 bg-slate-900/60 flex items-center justify-between shrink-0">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 transition"
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
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-bold text-slate-950 bg-gradient-to-r from-cyan-400 to-teal-300 hover:from-cyan-300 hover:to-teal-200 transition shadow-md shadow-cyan-950/40"
            >
              <span>Next</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinish}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-xs font-bold text-slate-950 bg-gradient-to-r from-emerald-400 to-teal-300 hover:from-emerald-300 hover:to-teal-200 transition shadow-md shadow-emerald-950/40"
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
