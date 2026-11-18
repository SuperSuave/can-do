import React, { useState, useEffect, useMemo } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Button
} from '@heroui/react';
import {
  Play,
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  Sliders,
  RotateCcw,
  StepForward,
  Cpu,
  Radio,
  Wifi,
  Bluetooth,
  BatteryCharging
} from 'lucide-react';
import { AutomationRule } from '../../types/automation';
import { Catalog } from '../../types/catalog';
import { normalizeCanId, resolveCatalogCommandForCondition } from '../../utils/automationConverters';
import { LiveWifiStatus, LiveBleItem } from './liveEvaluator';
import {
  discoverRuleSimulationInputs,
  simulateAutomationRule,
  describeTriggerForSim,
  applyOptionToHexFrame,
  SimulationTraceItem
} from '../../utils/ruleSimulator';

export interface RuleSimulatorModalProps {
  rule: AutomationRule | null;
  isOpen: boolean;
  onClose: () => void;
  catalog?: Catalog;
  liveFrames: Map<string, { data: string }>;
  entityStates: Map<string, string>;
  liveWifiStatus: LiveWifiStatus | null;
  liveBleMap: Map<string, LiveBleItem>;
  lastFiredTriggerId?: string;
  onQueryHardwareDryRun?: (rule: AutomationRule) => Promise<{ passed: boolean; message: string } | null>;
}

export const RuleSimulatorModal: React.FC<RuleSimulatorModalProps> = ({
  rule,
  isOpen,
  onClose,
  catalog,
  liveFrames,
  entityStates,
  liveWifiStatus,
  liveBleMap,
  lastFiredTriggerId,
  onQueryHardwareDryRun
}) => {
  const [firedTriggerId, setFiredTriggerId] = useState<string>('');
  const [multiTriggerSatisfied, setMultiTriggerSatisfied] = useState<boolean>(true);
  const [mockEntityStates, setMockEntityStates] = useState<Map<string, string>>(new Map());
  const [mockCanFrames, setMockCanFrames] = useState<Map<string, { data: string }>>(new Map());
  const [mockVbat, setMockVbat] = useState<string>('12.8');
  const [mockWifiConnected, setMockWifiConnected] = useState<boolean>(true);
  const [mockWifiSsid, setMockWifiSsid] = useState<string>('HomeWiFi');
  const [mockWifiRssi, setMockWifiRssi] = useState<number>(-55);
  const [mockBlePresent, setMockBlePresent] = useState<boolean>(true);
  const [mockBleRssi, setMockBleRssi] = useState<number>(-60);
  const [pingPongDirs, setPingPongDirs] = useState<Map<string, number>>(new Map());
  const [stepCounter, setStepCounter] = useState<number>(1);
  const [hwStatus, setHwStatus] = useState<{ loading: boolean; text?: string; passed?: boolean } | null>(null);

  const discovered = useMemo(() => {
    if (!rule) {
      return {
        entities: [],
        rawCanFrames: [],
        usesVoltage: false,
        usesTime: false,
        usesWifi: false,
        usesBle: false
      };
    }
    return discoverRuleSimulationInputs(rule, catalog);
  }, [rule, catalog]);

  const resetMocksFromLive = () => {
    if (!rule) return;
    const firstTrigId = lastFiredTriggerId || rule.triggers?.[0]?.id || '';
    setFiredTriggerId(firstTrigId);
    setMultiTriggerSatisfied(true);
    setPingPongDirs(new Map());
    setStepCounter(1);
    setHwStatus(null);

    const nextEnts = new Map<string, string>(entityStates);
    const nextFrames = new Map<string, { data: string }>(liveFrames);

    // Initialize discovered entities that don't have a live state yet
    for (const ent of discovered.entities) {
      const existing = nextEnts.get(ent.entityId) || nextEnts.get(ent.entityId.toLowerCase());
      const chosenLabel = existing || ent.options[0]?.label || '';
      if (chosenLabel) {
        nextEnts.set(ent.entityId, chosenLabel);
        nextEnts.set(ent.entityId.toLowerCase(), chosenLabel);
        const opt = ent.options.find(o => o.label.toLowerCase() === chosenLabel.toLowerCase());
        if (opt && ent.canId) {
          const cid = normalizeCanId(ent.canId);
          nextFrames.set(cid, { data: applyOptionToHexFrame(nextFrames.get(cid)?.data, opt) });
        }
      }
    }

    // Initialize raw CAN frames that don't have a live frame yet
    for (const raw of discovered.rawCanFrames) {
      const cid = normalizeCanId(raw.canId);
      if (!nextFrames.has(cid)) {
        nextFrames.set(cid, { data: raw.samplePassBytes });
      }
    }

    const liveV = entityStates.get('cond_aux_12v_battery') || entityStates.get('vbat') || '12.8';
    setMockVbat(liveV);
    nextEnts.set('cond_aux_12v_battery', liveV);
    nextEnts.set('vbat', liveV);

    setMockWifiConnected(liveWifiStatus ? liveWifiStatus.sta_connected : true);
    setMockWifiSsid(liveWifiStatus?.sta_ssid || 'HomeWiFi');
    setMockWifiRssi(liveWifiStatus?.sta_rssi ?? -55);
    setMockBlePresent(true);
    setMockBleRssi(-60);

    setMockEntityStates(nextEnts);
    setMockCanFrames(nextFrames);
  };

  useEffect(() => {
    if (isOpen && rule) {
      resetMocksFromLive();
    }
  }, [isOpen, rule?.id]);

  if (!isOpen || !rule) return null;

  const handleSelectEntityOption = (entityId: string, label: string) => {
    const ent = discovered.entities.find(e => e.entityId === entityId);
    const nextEnts = new Map(mockEntityStates);
    nextEnts.set(entityId, label);
    nextEnts.set(entityId.toLowerCase(), label);
    setMockEntityStates(nextEnts);

    if (ent && ent.canId) {
      const opt = ent.options.find(o => o.label.toLowerCase() === label.toLowerCase());
      if (opt) {
        const cid = normalizeCanId(ent.canId);
        const nextFrames = new Map(mockCanFrames);
        nextFrames.set(cid, { data: applyOptionToHexFrame(nextFrames.get(cid)?.data, opt) });
        setMockCanFrames(nextFrames);
      }
    }
  };

  const handleUpdateRawFrame = (canId: string, hexData: string) => {
    const cid = normalizeCanId(canId);
    const nextFrames = new Map(mockCanFrames);
    nextFrames.set(cid, { data: hexData });
    setMockCanFrames(nextFrames);
  };

  // Build effective simulation context
  const effectiveEntityStates = new Map(mockEntityStates);
  effectiveEntityStates.set('cond_aux_12v_battery', mockVbat);
  effectiveEntityStates.set('vbat', mockVbat);

  const effectiveWifi: LiveWifiStatus = {
    sta_connected: mockWifiConnected,
    sta_ssid: mockWifiSsid,
    sta_rssi: mockWifiRssi,
    ap_active: liveWifiStatus?.ap_active ?? true,
    ap_clients: liveWifiStatus?.ap_clients ?? 0
  };

  const effectiveBleMap = new Map<string, LiveBleItem>(liveBleMap);
  const simBleItem: LiveBleItem = {
    name: 'Simulated BLE Device',
    rssi: mockBleRssi,
    is_present: mockBlePresent,
    connected: mockBlePresent
  };
  effectiveBleMap.set('connected_device', simBleItem);
  // Also populate any specific BLE target strings referenced in conditions
  (rule.conditions || []).forEach(c => {
    const k = (c.beacon_uuid || c.ble_device || c.target_string || '').toLowerCase().trim();
    if (k) {
      effectiveBleMap.set(k, { ...simBleItem, uuid: k, mac: k, name: k });
    }
  });

  const simResult = simulateAutomationRule(rule, {
    catalog,
    firedTriggerId,
    multiTriggerWindowSatisfied: multiTriggerSatisfied,
    entityStates: effectiveEntityStates,
    liveFrames: mockCanFrames,
    liveWifiStatus: effectiveWifi,
    liveBleMap: effectiveBleMap,
    pingPongDirections: pingPongDirs
  });

  const handleStepNextState = () => {
    const nextEnts = new Map(simResult.nextEntityStates);
    const nextFrames = new Map(mockCanFrames);

    for (const ent of discovered.entities) {
      const updatedLabel = nextEnts.get(ent.entityId) || nextEnts.get(ent.entityId.toLowerCase());
      if (updatedLabel && ent.canId) {
        const opt = ent.options.find(o => o.label.toLowerCase() === updatedLabel.toLowerCase());
        if (opt) {
          const cid = normalizeCanId(ent.canId);
          nextFrames.set(cid, { data: applyOptionToHexFrame(nextFrames.get(cid)?.data, opt) });
        }
      }
    }

    setMockEntityStates(nextEnts);
    setMockCanFrames(nextFrames);
    setPingPongDirs(new Map(simResult.nextPingPongDirections));
    setStepCounter(c => c + 1);
  };

  const handleCheckHardware = async () => {
    if (!onQueryHardwareDryRun) return;
    setHwStatus({ loading: true });
    const res = await onQueryHardwareDryRun(rule);
    if (res) {
      setHwStatus({ loading: false, passed: res.passed, text: res.message });
    } else {
      setHwStatus({ loading: false, passed: false, text: 'ESP32 not reachable (using local offline simulator).' });
    }
  };

  const getBadgeStyle = (status: SimulationTraceItem['status']) => {
    switch (status) {
      case 'pass':
        return 'bg-success-soft text-success border-success/30';
      case 'fail':
        return 'bg-danger-soft text-danger border-danger/30';
      case 'tx':
        return 'bg-accent-soft text-accent border-accent/30';
      case 'skip':
        return 'bg-surface-tertiary text-muted border-border';
      case 'info':
      default:
        return 'bg-warning-soft text-warning border-warning/30';
    }
  };

  const hasMockControls =
    (rule.triggers && rule.triggers.length > 0) ||
    discovered.entities.length > 0 ||
    discovered.rawCanFrames.length > 0 ||
    discovered.usesVoltage ||
    discovered.usesWifi ||
    discovered.usesBle;

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalBackdrop className="bg-backdrop backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <ModalContainer className="w-full max-w-2xl">
          <ModalDialog className="relative bg-overlay border border-border rounded-2xl shadow-overlay overflow-hidden p-0 flex flex-col max-h-[90vh]">
            <ModalHeader className="px-5 py-4 border-b border-separator bg-surface">
              <div className="flex items-center justify-between gap-3 pr-10">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-accent-soft text-accent border border-accent/30 flex items-center justify-center shrink-0">
                    <Play className="w-4 h-4 fill-current" />
                  </div>
                  <div className="min-w-0">
                    <ModalHeading className="text-base font-bold text-foreground truncate">
                      Offline Dry-Run Simulator
                    </ModalHeading>
                    <p className="text-xs text-muted truncate">
                      {rule.name || rule.id} · Zero CAN frames transmitted
                    </p>
                  </div>
                </div>
                {stepCounter > 1 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-accent-soft text-accent border border-accent/30 shrink-0">
                    Run #{stepCounter}
                  </span>
                )}
              </div>
            </ModalHeader>

            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={onClose}
              aria-label="Close simulation modal"
              className="absolute top-3.5 right-3.5 z-20 !rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border border-border/50 shadow-sm transition-colors"
            >
              <X className="w-4 h-4" />
            </Button>

            <ModalBody className="p-5 space-y-4 overflow-y-auto text-sm text-foreground">
              {/* Mock Bench Inputs */}
              {hasMockControls && (
                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-foreground uppercase tracking-wider">
                      <Sliders className="w-3.5 h-3.5 text-accent" />
                      <span>Simulated Vehicle & Trigger State</span>
                    </div>
                    <button
                      type="button"
                      onClick={resetMocksFromLive}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted hover:text-foreground cursor-pointer transition"
                      title="Reset mock overrides to live telemetry"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Reset</span>
                    </button>
                  </div>

                  {/* Trigger Picker */}
                  {rule.triggers && rule.triggers.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-semibold text-muted">
                        Simulated Firing Trigger
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {rule.triggers.map((trig, idx) => {
                          const tId = trig.id || `trig_${idx}`;
                          const isSelected = firedTriggerId === tId || (!firedTriggerId && idx === 0);
                          return (
                            <button
                              key={tId}
                              type="button"
                              onClick={() => setFiredTriggerId(tId)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition cursor-pointer flex items-center gap-1.5 ${
                                isSelected
                                  ? 'bg-accent-soft text-accent-soft-foreground border-accent font-semibold shadow-xs'
                                  : 'bg-surface text-foreground/85 hover:bg-default-hover border-border'
                              }`}
                            >
                              <Zap className="w-3 h-3 text-warning shrink-0" />
                              <span>#{idx + 1}: {describeTriggerForSim(trig, idx, catalog)}</span>
                            </button>
                          );
                        })}
                      </div>

                      {rule.trigger_mode && rule.trigger_mode !== 'any' && rule.triggers.length >= 2 && (
                        <div className="flex items-center justify-between pt-1.5 text-xs">
                          <span className="text-muted">
                            Simulate {rule.trigger_mode === 'sequence' ? 'ordered sequence' : 'all triggers'} completed within{' '}
                            {Math.round((rule.trigger_window_ms ?? 8000) / 1000)}s window:
                          </span>
                          <button
                            type="button"
                            onClick={() => setMultiTriggerSatisfied(v => !v)}
                            className={`px-2.5 py-0.5 rounded-md font-semibold text-[11px] border cursor-pointer transition ${
                              multiTriggerSatisfied
                                ? 'bg-success-soft text-success border-success/40'
                                : 'bg-danger-soft text-danger border-danger/40'
                            }`}
                          >
                            {multiTriggerSatisfied ? 'Window Satisfied' : 'Timed Out / Incomplete'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Discovered Catalog Entity Overrides */}
                  {discovered.entities.map(ent => {
                    const currentVal =
                      mockEntityStates.get(ent.entityId) ||
                      mockEntityStates.get(ent.entityId.toLowerCase()) ||
                      ent.options[0]?.label ||
                      '';
                    return (
                      <div key={ent.entityId} className="space-y-1.5 pt-1.5 border-t border-separator/70">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold text-foreground">
                            {ent.name}
                          </span>
                          <span className="text-[10px] font-mono text-muted">
                            Current: <strong className="text-accent">{currentVal || 'Unknown'}</strong>
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {ent.options.map(opt => {
                            const active = currentVal.toLowerCase() === opt.label.toLowerCase();
                            return (
                              <button
                                key={opt.label}
                                type="button"
                                onClick={() => handleSelectEntityOption(ent.entityId, opt.label)}
                                className={`px-2 py-1 rounded-lg text-[11px] font-medium border transition cursor-pointer ${
                                  active
                                    ? 'bg-accent text-accent-foreground border-accent font-semibold shadow-xs'
                                    : 'bg-surface text-foreground/80 hover:text-foreground hover:bg-default-hover border-border'
                                }`}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {/* Raw CAN Frame Overrides */}
                  {discovered.rawCanFrames.map(raw => {
                    const cid = normalizeCanId(raw.canId);
                    const curHex = mockCanFrames.get(cid)?.data || raw.defaultBytes;
                    return (
                      <div key={raw.canId} className="space-y-1.5 pt-1.5 border-t border-separator/70">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                            <Radio className="w-3 h-3 text-accent" />
                            <span>Mock CAN {raw.canId}</span>
                            <span className="text-[10px] text-muted font-normal">({raw.description})</span>
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleUpdateRawFrame(raw.canId, raw.samplePassBytes)}
                              className="px-2 py-0.5 rounded text-[10px] font-semibold bg-success-soft text-success border border-success/30 cursor-pointer"
                            >
                              Match Target
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUpdateRawFrame(raw.canId, raw.defaultBytes)}
                              className="px-2 py-0.5 rounded text-[10px] font-semibold bg-surface text-muted hover:text-foreground border border-border cursor-pointer"
                            >
                              Zero All
                            </button>
                          </div>
                        </div>
                        <input
                          type="text"
                          value={curHex}
                          onChange={(e) => handleUpdateRawFrame(raw.canId, e.target.value)}
                          placeholder="00 00 00 00 00 00 00 00"
                          className="w-full px-2.5 py-1 rounded-lg bg-surface border border-border font-mono text-xs text-foreground focus:outline-none focus:border-accent"
                        />
                      </div>
                    );
                  })}

                  {/* Voltage Override */}
                  {discovered.usesVoltage && (
                    <div className="flex items-center justify-between gap-3 pt-1.5 border-t border-separator/70">
                      <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                        <BatteryCharging className="w-3.5 h-3.5 text-warning" />
                        <span>12V Aux Battery Voltage</span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          step="0.1"
                          min="9.0"
                          max="16.0"
                          value={mockVbat}
                          onChange={(e) => setMockVbat(e.target.value)}
                          className="w-20 px-2 py-0.5 rounded-lg bg-surface border border-border font-mono text-xs text-right text-foreground"
                        />
                        <span className="text-xs text-muted font-mono">V</span>
                      </div>
                    </div>
                  )}

                  {/* Wi-Fi Override */}
                  {discovered.usesWifi && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-separator/70">
                      <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                        <Wifi className="w-3.5 h-3.5 text-accent" />
                        <span>Wi-Fi Station</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setMockWifiConnected(v => !v)}
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold border cursor-pointer ${
                            mockWifiConnected
                              ? 'bg-success-soft text-success border-success/30'
                              : 'bg-surface text-muted border-border'
                          }`}
                        >
                          {mockWifiConnected ? 'Connected' : 'Disconnected'}
                        </button>
                        <input
                          type="text"
                          value={mockWifiSsid}
                          onChange={(e) => setMockWifiSsid(e.target.value)}
                          placeholder="SSID"
                          className="w-28 px-2 py-0.5 rounded bg-surface border border-border text-xs font-mono text-foreground"
                        />
                        <input
                          type="number"
                          value={mockWifiRssi}
                          onChange={(e) => setMockWifiRssi(parseInt(e.target.value) || -60)}
                          className="w-16 px-1.5 py-0.5 rounded bg-surface border border-border text-xs font-mono text-right text-foreground"
                          title="Simulated Wi-Fi RSSI (dBm)"
                        />
                      </div>
                    </div>
                  )}

                  {/* BLE Override */}
                  {discovered.usesBle && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-separator/70">
                      <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                        <Bluetooth className="w-3.5 h-3.5 text-accent" />
                        <span>BLE Target Presence</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setMockBlePresent(v => !v)}
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold border cursor-pointer ${
                            mockBlePresent
                              ? 'bg-success-soft text-success border-success/30'
                              : 'bg-surface text-muted border-border'
                          }`}
                        >
                          {mockBlePresent ? 'Present / Connected' : 'Away / Disconnected'}
                        </button>
                        <input
                          type="number"
                          value={mockBleRssi}
                          onChange={(e) => setMockBleRssi(parseInt(e.target.value) || -60)}
                          className="w-16 px-1.5 py-0.5 rounded bg-surface border border-border text-xs font-mono text-right text-foreground"
                          title="Simulated BLE RSSI (dBm)"
                        />
                        <span className="text-[10px] font-mono text-muted">dBm</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Step-by-Step Execution Trace */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted">
                    Execution Trace ({simResult.traces.length} steps)
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                      simResult.passed
                        ? 'bg-success-soft text-success border-success/30'
                        : 'bg-danger-soft text-danger border-danger/30'
                    }`}
                  >
                    {simResult.passed ? 'RULE ARMED & EXECUTED' : 'BLOCKED BY CONDITIONS'}
                  </span>
                </div>

                <div className="rounded-xl border border-border bg-surface divide-y divide-separator overflow-hidden">
                  {simResult.traces.map((item, idx) => (
                    <div
                      key={idx}
                      style={{ paddingLeft: `${14 + (item.indent || 0) * 18}px` }}
                      className="pr-3.5 py-2.5 flex items-start gap-2.5 text-xs"
                    >
                      <div className="mt-0.5 shrink-0">
                        {item.status === 'pass' && <CheckCircle2 className="w-4 h-4 text-success" />}
                        {item.status === 'fail' && <XCircle className="w-4 h-4 text-danger" />}
                        {item.status === 'tx' && <Zap className="w-4 h-4 text-accent" />}
                        {item.status === 'info' && <AlertTriangle className="w-4 h-4 text-warning" />}
                        {item.status === 'skip' && <span className="w-4 h-4 inline-block text-center text-muted">—</span>}
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded border ${getBadgeStyle(
                              item.status
                            )}`}
                          >
                            {item.phase}
                          </span>
                          <span className="font-semibold text-foreground leading-snug">
                            {item.title}
                          </span>
                        </div>
                        {item.detail && (
                          <div className="text-[11px] font-mono text-muted break-words">
                            {item.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {hwStatus && (
                <div
                  className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                    hwStatus.passed
                      ? 'bg-success-soft/50 border-success/30 text-foreground'
                      : 'bg-surface-secondary border-border text-muted'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-accent shrink-0" />
                    <span>
                      <strong>ESP32 Hardware Check:</strong>{' '}
                      {hwStatus.loading ? 'Querying ESP32...' : hwStatus.text}
                    </span>
                  </div>
                </div>
              )}
            </ModalBody>

            <ModalFooter className="px-5 py-3 border-t border-separator bg-surface flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {onQueryHardwareDryRun && (
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={handleCheckHardware}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5 text-accent" />
                    <span>Check ESP32 Hardware</span>
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2 ml-auto">
                {simResult.passed && discovered.entities.length > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={handleStepNextState}
                    aria-label="Apply resulting entity states and simulate firing this rule again"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-accent-soft hover:bg-accent/20 text-accent border border-accent/30 transition cursor-pointer"
                  >
                    <StepForward className="w-3.5 h-3.5" />
                    <span>Simulate Next Firing</span>
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onPress={onClose}
                  className="px-4 py-1.5 rounded-xl text-xs font-bold bg-accent hover:bg-accent-hover text-accent-foreground transition cursor-pointer"
                >
                  Done
                </Button>
              </div>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
};
