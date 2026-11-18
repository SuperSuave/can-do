import React, { useState, useContext, useMemo, useId, useRef } from 'react';
import { Tabs, Switch, Slider } from '@heroui/react';
import {
  Play,
  ArrowUp,
  ArrowDown,
  Copy,
  ClipboardCopy,
  Trash2,
  ChevronDown,
  ChevronUp,
  GitFork,
  Split,
  Plus,
  ClipboardPaste,
  Clock,
  Sliders,
  RotateCw,
  Layers,
  Thermometer,
  Gauge,
  Activity,
  Repeat,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ArrowLeftRight,
  GripVertical,
  X,
  Check,
  Navigation
} from 'lucide-react';
import { AutomationAction, AutomationCondition, AutomationTrigger, AutomationActionStep, ChoiceBranch } from '../../types/automation';
import { Catalog, Command, CommandOption, ByteMap } from '../../types/catalog';
import {
  resolveCatalogCommandForAction,
  applyOptionToAction,
  formatCanId,
  regenerateBranchIds,
  compileToByteMap,
  regenerateActionIds
} from '../../utils/automationConverters';
import { formatActionSummary } from '../../utils/ruleSummaries';
import {
  arrayMove,
  getActiveScopedDrag,
  setActiveScopedDrag
} from '../../utils/automationClipboard';
import type { NodeDragConfig } from './TriggerNodeEditor';
import {
  isRangeCommand,
  rawByteToPhysical,
  physicalToRawByte,
  getDefaultPhysicalValue,
  buildRangeActionPayload,
  resolveRangeSteps,  normalizeByteKey
} from '../../utils/catalogUtils';
import {
  groupOptionsIntoGridRows,
  OptionGridGroup,
  LiveWifiStatus,
  LiveBleItem,
  parseHexPayload
} from './liveEvaluator';
import { ConditionListEditor } from './ConditionNodeEditor';
import { AutomationClipboardContext } from './AutomationClipboardContext';
import {
  CLUSTER_POPUP_MAX_CODE_UNITS,
  CLUSTER_POPUP_MAX_TEXT_CODE_UNITS,
  getClusterPopupTotalCodeUnits,
  resolveCycleEntityPopupText
} from '../../utils/canValidator';

export const HUD_MANEUVER_ICONS: { value: number; label: string; symbol: string }[] = [
  { value: 0x00, label: 'None / Idle (0x00)', symbol: '•' },
  { value: 0x01, label: 'Straight Ahead (0x01)', symbol: '↑' },
  { value: 0x02, label: 'Slight Right (0x02)', symbol: '↗' },
  { value: 0x03, label: 'Turn Right (0x03)', symbol: '↱' },
  { value: 0x04, label: 'Sharp Right (0x04)', symbol: '↘' },
  { value: 0x05, label: 'U-Turn Left (0x05)', symbol: '↶' },
  { value: 0x06, label: 'U-Turn Right (0x06)', symbol: '↷' },
  { value: 0x07, label: 'Slight Left (0x07)', symbol: '↖' },
  { value: 0x08, label: 'Turn Left (0x08)', symbol: '↰' },
  { value: 0x09, label: 'Sharp Left (0x09)', symbol: '↙' },
  { value: 0x0A, label: 'Roundabout 1st Exit (0x0A)', symbol: '⟳1' },
  { value: 0x0B, label: 'Roundabout 2nd Exit (0x0B)', symbol: '⟳2' },
  { value: 0x0C, label: 'Roundabout 3rd Exit (0x0C)', symbol: '⟳3' },
  { value: 0x0D, label: 'Roundabout 4th Exit (0x0D)', symbol: '⟳4' },
  { value: 0x0E, label: 'Highway Fork Left (0x0E)', symbol: '⑂←' },
  { value: 0x0F, label: 'Highway Fork Right (0x0F)', symbol: '⑂→' },
  { value: 0x10, label: 'Offramp / Exit Left (0x10)', symbol: '↖Exit' },
  { value: 0x11, label: 'Offramp / Exit Right (0x11)', symbol: '↗Exit' },
  { value: 0x1F, label: 'Destination Flag (0x1F)', symbol: '🏁' }
];

const LANE_ARROW_OPTIONS: { value: number; label: string; symbol: string }[] = [
  { value: 1, label: 'Straight ↑', symbol: '↑' },
  { value: 8, label: 'Left ↰', symbol: '↰' },
  { value: 3, label: 'Right ↱', symbol: '↱' },
  { value: 7, label: 'Slight Left ↖', symbol: '↖' },
  { value: 2, label: 'Slight Right ↗', symbol: '↗' },
  { value: 5, label: 'U-Turn ↶', symbol: '↶' },
  { value: 0, label: 'Blank •', symbol: '•' }
];

interface HudNavActionConfigProps {
  act: AutomationAction;
  onUpdate: (updated: AutomationAction) => void;
}

const HudNavActionConfig: React.FC<HudNavActionConfigProps> = ({ act, onUpdate }) => {
  const [distUnit, setDistUnit] = useState<'m' | 'km' | 'ft' | 'mi'>('ft');
  const [speedUnit, setSpeedUnit] = useState<'mph' | 'kph'>('mph');

  const navMode = (act.nav_action || act.action || 'update') === 'clear' ? 'clear' : 'update';
  const distanceMeters = act.distance_meters ?? act.distance ?? 200;
  const speedLimitKph = act.speed_limit ?? 0;
  const bars = act.bars ?? 4;
  const numLanes = act.num_lanes ?? act.lanes ?? 0;
  const hasLaneGuidance = numLanes > 0;

  const displayedDistance = useMemo(() => {
    if (distanceMeters === undefined || distanceMeters === 0xffff) return '';
    switch (distUnit) {
      case 'ft':
        return Math.round(distanceMeters * 3.28084);
      case 'mi':
        return Math.round((distanceMeters / 1609.344) * 100) / 100;
      case 'km':
        return Math.round((distanceMeters / 1000) * 100) / 100;
      case 'm':
      default:
        return Math.round(distanceMeters);
    }
  }, [distanceMeters, distUnit]);

  const handleDistanceChange = (rawVal: string, unit = distUnit) => {
    if (rawVal === '') {
      onUpdate({ ...act, distance_meters: 0, distance: 0 });
      return;
    }
    const num = parseFloat(rawVal);
    if (isNaN(num) || num < 0) return;
    let meters = num;
    if (unit === 'ft') meters = num / 3.28084;
    else if (unit === 'mi') meters = num * 1609.344;
    else if (unit === 'km') meters = num * 1000;
    const clampedMeters = Math.min(65534, Math.round(meters));
    onUpdate({ ...act, distance_meters: clampedMeters, distance: clampedMeters });
  };

  const displayedSpeed = useMemo(() => {
    if (!speedLimitKph || speedLimitKph <= 0) return 0;
    return speedUnit === 'mph' ? Math.round(speedLimitKph / 1.609344) : Math.round(speedLimitKph);
  }, [speedLimitKph, speedUnit]);

  const handleSpeedChange = (rawVal: string, unit = speedUnit) => {
    if (rawVal === '') {
      onUpdate({ ...act, speed_limit: 0 });
      return;
    }
    const num = parseFloat(rawVal);
    if (isNaN(num) || num < 0) return;
    const kph = unit === 'mph' ? Math.round(num * 1.609344) : Math.round(num);
    onUpdate({ ...act, speed_limit: Math.min(250, Math.max(0, kph)) });
  };

  const ensureLaneArrays = (targetCount: number) => {
    const dirs = Array.from({ length: targetCount }, (_, i) =>
      Array.isArray(act.lane_directions) && act.lane_directions[i] !== undefined
        ? act.lane_directions[i]
        : 1
    );
    const recs = Array.from({ length: targetCount }, (_, i) =>
      Array.isArray(act.lane_recommended) && act.lane_recommended[i] !== undefined
        ? act.lane_recommended[i]
        : i === Math.floor(targetCount / 2)
        ? 1
        : 0
    );
    return { dirs, recs };
  };

  const handleToggleLaneGuidance = (enabled: boolean) => {
    if (!enabled) {
      onUpdate({
        ...act,
        num_lanes: 0,
        lanes: 0,
        lane_directions: [],
        lane_recommended: []
      });
    } else {
      const count = 3;
      const { dirs, recs } = ensureLaneArrays(count);
      onUpdate({
        ...act,
        num_lanes: count,
        lanes: count,
        lane_directions: dirs,
        lane_recommended: recs
      });
    }
  };

  const handleLaneCountChange = (count: number) => {
    const clamped = Math.max(1, Math.min(8, count));
    const { dirs, recs } = ensureLaneArrays(clamped);
    onUpdate({
      ...act,
      num_lanes: clamped,
      lanes: clamped,
      lane_directions: dirs,
      lane_recommended: recs
    });
  };

  const updateLaneDirection = (laneIdx: number, arrowVal: number) => {
    const { dirs, recs } = ensureLaneArrays(numLanes);
    dirs[laneIdx] = arrowVal;
    onUpdate({ ...act, lane_directions: dirs, lane_recommended: recs });
  };

  const toggleLaneRecommended = (laneIdx: number) => {
    const { dirs, recs } = ensureLaneArrays(numLanes);
    recs[laneIdx] = recs[laneIdx] ? 0 : 1;
    onUpdate({ ...act, lane_directions: dirs, lane_recommended: recs });
  };

  const selectedManeuver =
    HUD_MANEUVER_ICONS.find(m => m.value === (act.icon ?? 1)) || HUD_MANEUVER_ICONS[1];

  return (
    <div className="col-span-full space-y-3 p-3 rounded-lg bg-surface-tertiary border border-accent/40 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-accent flex items-center gap-1.5">
          <Navigation className="w-3.5 h-3.5 text-accent" />
          <span>HUD & Cluster Turn-by-Turn Navigation</span>
        </span>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted">
          {navMode === 'clear' ? (
            <span className="text-warning font-semibold">Action: Clear / Dismiss HUD Guidance</span>
          ) : (
            <span>
              <span className="text-accent font-bold">{selectedManeuver.symbol}</span>{' '}
              {act.street || 'Guidance'} · {Math.round(distanceMeters * 3.28084)} ft ({distanceMeters}m)
              {speedLimitKph > 0
                ? ` · Limit ${Math.round(speedLimitKph / 1.609344)} mph (${speedLimitKph} km/h)`
                : ''}
            </span>
          )}
        </div>
      </div>

      {/* Operation Mode Selector */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px]">
        <div>
          <label className="block text-[10px] text-muted mb-1">HUD Operation</label>
          <select
            value={navMode}
            onChange={e => {
              const mode = e.target.value;
              onUpdate({ ...act, nav_action: mode, action: mode });
            }}
            className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground font-medium"
          >
            <option value="update">Show / Update HUD Guidance</option>
            <option value="clear">Clear / Dismiss HUD Guidance</option>
          </select>
        </div>

        {navMode !== 'clear' && (
          <>
            {/* Maneuver Icon */}
            <div>
              <label className="block text-[10px] text-muted mb-1">Maneuver Arrow / Graphic</label>
              <select
                value={act.icon ?? 1}
                onChange={e => onUpdate({ ...act, icon: parseInt(e.target.value, 10) })}
                className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-accent font-semibold"
              >
                {HUD_MANEUVER_ICONS.map(ic => (
                  <option key={ic.value} value={ic.value}>
                    {ic.symbol} {ic.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Street / Banner Label (UTF-8 ISO-TP) */}
            <div className="sm:col-span-2">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[10px] text-muted">Street / Alert Banner Text (ISO-TP)</label>
                <span className="text-[9px] font-mono text-muted">{(act.street || '').length}/32</span>
              </div>
              <input
                type="text"
                maxLength={32}
                value={act.street || ''}
                onChange={e => onUpdate({ ...act, street: e.target.value })}
                placeholder="e.g. Main St / Fast Charger Ahead"
                className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground font-medium"
              />
            </div>
          </>
        )}
      </div>

      {navMode !== 'clear' && (
        <>
          {/* Row 2: Distance (Imperial/Metric), Countdown Bar Graph, Speed Limit (mph/kph), Heading & Camera Alert */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px]">
            {/* Distance with Imperial/Metric Unit Switcher */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[10px] text-muted">Distance to Maneuver</label>
                <span className="text-[9px] font-mono text-accent">
                  {distUnit === 'ft' || distUnit === 'mi'
                    ? `${distanceMeters} m`
                    : `${Math.round(distanceMeters * 3.28084)} ft`}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  step={distUnit === 'mi' || distUnit === 'km' ? '0.1' : '10'}
                  value={displayedDistance}
                  onChange={e => handleDistanceChange(e.target.value)}
                  className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground font-mono"
                />
                <select
                  value={distUnit}
                  onChange={e => setDistUnit(e.target.value as any)}
                  className="bg-surface-secondary border border-border rounded px-1.5 py-1 text-[10px] text-accent font-mono shrink-0"
                  title="Distance Unit (Imperial ft/mi or Metric m/km)"
                >
                  <option value="ft">ft</option>
                  <option value="mi">mi</option>
                  <option value="m">m</option>
                  <option value="km">km</option>
                </select>
              </div>
            </div>

            {/* Countdown Bar Graph (0-8 bars) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[10px] text-muted">Countdown Bar Graph</label>
                <span className="text-[9px] font-mono text-accent">
                  {bars === 0 ? 'Off' : `${bars}/8 bars`}
                </span>
              </div>
              <select
                value={bars}
                onChange={e => onUpdate({ ...act, bars: parseInt(e.target.value, 10) })}
                className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground font-mono"
              >
                <option value={0}>0 — Off / Hidden</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                  <option key={n} value={n}>
                    {n} / 8 Bars ({'█'.repeat(n)}{'░'.repeat(8 - n)})
                  </option>
                ))}
              </select>
            </div>

            {/* Speed Limit Sign (mph / km/h) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[10px] text-muted">Speed Limit Badge (0=Off)</label>
                <span className="text-[9px] font-mono text-accent">
                  {speedLimitKph > 0
                    ? speedUnit === 'mph'
                      ? `${speedLimitKph} km/h`
                      : `${Math.round(speedLimitKph / 1.609344)} mph`
                    : 'Off'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="200"
                  step="5"
                  value={displayedSpeed || ''}
                  onChange={e => handleSpeedChange(e.target.value)}
                  placeholder="0 (Off)"
                  className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground font-mono"
                />
                <select
                  value={speedUnit}
                  onChange={e => setSpeedUnit(e.target.value as any)}
                  className="bg-surface-secondary border border-border rounded px-1.5 py-1 text-[10px] text-accent font-mono shrink-0"
                  title="Speed Limit Unit (Imperial mph or Metric km/h)"
                >
                  <option value="mph">mph</option>
                  <option value="kph">km/h</option>
                </select>
              </div>
            </div>

            {/* Turn Angle & Speed Camera Alert */}
            <div className="flex flex-col justify-between gap-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[10px] text-muted shrink-0">Turn Angle (°):</label>
                <input
                  type="number"
                  min="0"
                  max="359"
                  value={act.direction_deg ?? 0}
                  onChange={e =>
                    onUpdate({
                      ...act,
                      direction_deg: Math.max(0, Math.min(359, parseInt(e.target.value, 10) || 0))
                    })
                  }
                  className="w-20 bg-surface-secondary border border-border rounded px-2 py-0.5 text-foreground font-mono text-[11px]"
                />
              </div>
              <Switch
                isSelected={!!act.camera_alert}
                onChange={isSelected => onUpdate({ ...act, camera_alert: isSelected })}
                size="sm"
                aria-label="Speed Camera Alert"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <span className="text-foreground text-[10px]">Speed Camera Alert Icon</span>
                </Switch.Content>
              </Switch>
            </div>
          </div>

          {/* Expandable 8-Lane Guidance Builder */}
          <div className="pt-2.5 border-t border-separator space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Switch
                isSelected={hasLaneGuidance}
                onChange={handleToggleLaneGuidance}
                size="sm"
                aria-label="Enable Multi-Lane Guidance"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <span className="text-foreground text-[11px] font-medium">
                    Multi-Lane Guidance (Up to 8 Lanes via ISO-TP 0x6E2)
                  </span>
                </Switch.Content>
              </Switch>

              {hasLaneGuidance && (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-[10px] text-muted">Lane Count:</span>
                  <select
                    value={numLanes}
                    onChange={e => handleLaneCountChange(parseInt(e.target.value, 10))}
                    className="bg-surface-secondary border border-border rounded px-2 py-0.5 text-accent font-mono font-bold"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                      <option key={n} value={n}>
                        {n} {n === 1 ? 'Lane' : 'Lanes'}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {hasLaneGuidance && (
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-1.5 pt-1">
                {Array.from({ length: numLanes }, (_, idx) => {
                  const dirVal =
                    Array.isArray(act.lane_directions) && act.lane_directions[idx] !== undefined
                      ? act.lane_directions[idx]
                      : 1;
                  const isRec =
                    Array.isArray(act.lane_recommended) && Boolean(act.lane_recommended[idx]);

                  return (
                    <div
                      key={idx}
                      className={`p-1.5 rounded-lg border flex flex-col items-center gap-1 text-[10px] transition ${
                        isRec
                          ? 'bg-accent/15 border-accent text-accent shadow-sm'
                          : 'bg-surface-secondary/70 border-border text-muted'
                      }`}
                    >
                      <span className="font-mono text-[9px] uppercase">Lane {idx + 1}</span>
                      <select
                        value={dirVal}
                        onChange={e => updateLaneDirection(idx, parseInt(e.target.value, 10))}
                        className="w-full bg-surface-tertiary border border-border rounded px-1 py-0.5 text-center text-foreground font-mono text-[10px]"
                      >
                        {LANE_ARROW_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => toggleLaneRecommended(idx)}
                        className={`w-full py-0.5 px-1 rounded text-[9px] font-bold border transition ${
                          isRec
                            ? 'bg-accent text-white border-accent'
                            : 'bg-surface-tertiary text-muted border-border hover:text-foreground'
                        }`}
                      >
                        {isRec ? '★ Active' : 'Normal'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

interface CycleEntityStepperConfigProps {
  act: AutomationAction;
  catalog?: Catalog;
  entityStates?: Map<string, string>;
  onUpdate: (updated: AutomationAction) => void;
}

const isStateReadableCycleCommand = (cmd: Command): boolean => {
  if (!cmd.options || cmd.options.length < 2) return false;
  const hasStateCanId = Boolean(cmd.network?.state_can_id || cmd.state_can_id);
  const hasMatchOptions = cmd.options.some(
    o => o.match && typeof o.match === 'object' && Object.keys(o.match).length > 0
  );
  const hasActionCapability = Boolean(
    cmd.roles?.includes('action') ||
      cmd.network?.action_can_id ||
      cmd.action_can_id ||
      cmd.options.some(o => (o.steps && o.steps.length > 0) || o.payload)
  );
  return hasStateCanId && hasMatchOptions && hasActionCapability;
};

const CycleEntityStepperConfig: React.FC<CycleEntityStepperConfigProps> = ({
  act,
  catalog,
  entityStates,
  onUpdate
}) => {
  const [showAllEntities, setShowAllEntities] = useState(false);
  const [customEntityMode, setCustomEntityMode] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [customStateInput, setCustomStateInput] = useState('');
  const dragIdxRef = useRef<number | null>(null);
  const chipListId = useId();

  const entId = act.entity_id || act.target_command_id || 'drivers_seat_comfort';

  const allMultiOptionCommands = useMemo(() => {
    if (!catalog?.commands) return [];
    return catalog.commands.filter(c => c.options && c.options.length >= 2);
  }, [catalog]);

  const stateReadableCommands = useMemo(() => {
    return allMultiOptionCommands.filter(isStateReadableCycleCommand);
  }, [allMultiOptionCommands]);

  const selectedCmd = useMemo(() => {
    return catalog?.commands?.find(c => c.id === entId || c.entity_id === entId);
  }, [catalog, entId]);

  const displayedCommands = useMemo(() => {
    const base = showAllEntities ? allMultiOptionCommands : stateReadableCommands;
    if (selectedCmd && !base.some(c => c.id === selectedCmd.id)) {
      return [selectedCmd, ...base];
    }
    return base;
  }, [showAllEntities, allMultiOptionCommands, stateReadableCommands, selectedCmd]);

  const catalogOptionLabels = useMemo(() => {
    if (selectedCmd?.options && selectedCmd.options.length > 0) {
      return selectedCmd.options.map(o => o.label);
    }
    return ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
  }, [selectedCmd]);

  const activeStates = useMemo(() => {
    if (act.states && act.states.length > 0) return act.states;
    return catalogOptionLabels;
  }, [act.states, catalogOptionLabels]);

  const direction = act.direction || 'forward';
  const isPingPong = direction === 'ping_pong';
  const isReverse = direction === 'reverse';
  const wrap = act.wrap !== false;

  const entityDisplayName = selectedCmd?.ha_metadata?.name || selectedCmd?.name || entId;
  const defaultPopupPrefix = `${entityDisplayName}: `;

  const popupLengthCheck = useMemo(() => {
    const effectivePrefix = act.popup_prefix !== undefined ? act.popup_prefix : defaultPopupPrefix;
    const entries = activeStates.map(s => {
      const resolved = resolveCycleEntityPopupText(effectivePrefix, entityDisplayName, s);
      const totalChars = getClusterPopupTotalCodeUnits(resolved, true);
      return { state: s, text: resolved, totalChars };
    });
    const maxEntry = entries.reduce(
      (best, cur) => (cur.totalChars > best.totalChars ? cur : best),
      entries[0] || { state: '', text: '', totalChars: 0 }
    );
    const overLimit = entries.filter(e => e.totalChars > CLUSTER_POPUP_MAX_CODE_UNITS);
    return { entries, maxEntry, overLimit };
  }, [activeStates, act.popup_prefix, defaultPopupPrefix, entityDisplayName]);

  // Live current state & next step preview
  const liveCurrentState = useMemo(() => {
    if (!entityStates) return undefined;
    return (
      entityStates.get(entId) ||
      entityStates.get(entId.toLowerCase()) ||
      (selectedCmd?.id ? entityStates.get(selectedCmd.id) : undefined)
    );
  }, [entityStates, entId, selectedCmd]);

  const previewTargetState = useMemo(() => {
    if (activeStates.length === 0) return '--';
    const curState = liveCurrentState || activeStates[0];
    const curIdx = activeStates.findIndex(s => s.toLowerCase() === curState.toLowerCase());
    if (curIdx < 0) {
      const fb = act.fallback_state || '__first__';
      if (fb === '__none__') return 'No Action (Ignored)';
      return fb === '__first__' ? activeStates[0] : fb;
    }
    if (isPingPong) {
      const nextIdx = curIdx + 1 < activeStates.length ? curIdx + 1 : Math.max(0, activeStates.length - 2);
      return activeStates[nextIdx];
    }
    let nextIdx = isReverse ? curIdx - 1 : curIdx + 1;
    if (nextIdx >= activeStates.length) nextIdx = wrap ? 0 : activeStates.length - 1;
    if (nextIdx < 0) nextIdx = wrap ? activeStates.length - 1 : 0;
    return activeStates[nextIdx];
  }, [activeStates, liveCurrentState, act.fallback_state, isPingPong, isReverse, wrap]);

  const handleSelectEntity = (newEntityId: string) => {
    if (newEntityId === '__custom__') {
      setCustomEntityMode(true);
      return;
    }
    setCustomEntityMode(false);
    const nextCmd = catalog?.commands?.find(c => c.id === newEntityId || c.entity_id === newEntityId);
    const nextOptions =
      nextCmd?.options && nextCmd.options.length > 0
        ? nextCmd.options.map(o => o.label)
        : ['Off', 'Low Heat', 'Medium Heat', 'High Heat'];
    const nextLabel = nextCmd?.ha_metadata?.name || nextCmd?.name || newEntityId;

    onUpdate({
      ...act,
      entity_id: newEntityId,
      target_command_id: nextCmd?.id || newEntityId,
      states: nextOptions,
      fallback_state: '__first__',
      popup_prefix: `${nextLabel}: `
    });
  };

  const toggleCatalogOptionChip = (label: string) => {
    const existsIdx = activeStates.findIndex(s => s.toLowerCase() === label.toLowerCase());
    if (existsIdx >= 0) {
      if (activeStates.length <= 2) return; // Keep at least 2 states to cycle
      const next = activeStates.filter((_, idx) => idx !== existsIdx);
      onUpdate({ ...act, states: next });
    } else {
      onUpdate({ ...act, states: [...activeStates, label] });
    }
  };

  const moveChip = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= activeStates.length || fromIndex === toIndex) return;
    const next = [...activeStates];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onUpdate({ ...act, states: next });
  };

  const removeChipAt = (idx: number) => {
    if (activeStates.length <= 2) return;
    const next = activeStates.filter((_, i) => i !== idx);
    onUpdate({ ...act, states: next });
  };

  const reverseChipOrder = () => {
    onUpdate({ ...act, states: [...activeStates].reverse() });
  };

  const selectAllCatalogChips = () => {
    onUpdate({ ...act, states: [...catalogOptionLabels] });
  };

  const handleAddCustomChip = () => {
    const trimmed = customStateInput.trim();
    if (!trimmed) return;
    if (!activeStates.some(s => s.toLowerCase() === trimmed.toLowerCase())) {
      onUpdate({ ...act, states: [...activeStates, trimmed] });
    }
    setCustomStateInput('');
  };

  const isSelectedCmdWriteOnly = Boolean(selectedCmd && !isStateReadableCycleCommand(selectedCmd));

  return (
    <div className="col-span-full space-y-3 p-3 rounded-lg bg-surface-tertiary border border-warning/40 font-sans">
      {/* Header + Live Step Preview */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-warning flex items-center gap-1.5">
          <RotateCw className="w-3.5 h-3.5 text-warning" />
          <span>Cyclic Stepper Configuration</span>
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] px-2 py-0.5 rounded bg-surface-secondary border border-border font-mono text-muted">
            <span className="text-foreground font-semibold">
              {liveCurrentState ? `Live: ${liveCurrentState}` : `Start: ${activeStates[0] || '--'}`}
            </span>
            <span className="mx-1 text-warning">➔</span>
            <span className="text-warning font-bold">{previewTargetState}</span>
          </span>
          <span className="text-[10px] text-muted font-mono">
            {isPingPong
              ? 'Ping-Pong ⇄ (Bounce)'
              : `${isReverse ? 'Reverse ◀' : 'Forward ▶'} · ${wrap ? 'Wrap: ON ↺' : 'Clamp: ON ⇥'}`}
          </span>
        </div>
      </div>

      {/* Row 1: Catalog Entity Picker, Direction Mode, Wrap, Fallback */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px]">
        {/* Catalog Entity Selector */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-[10px] text-muted">Target Catalog Entity</label>
            <button
              type="button"
              onClick={() => setShowAllEntities(v => !v)}
              className="text-[9px] text-accent hover:underline font-mono"
              title="Toggle between state-readable multi-option entities and all catalog entities"
            >
              {showAllEntities ? 'Filter State-Aware' : `Show All (${allMultiOptionCommands.length})`}
            </button>
          </div>
          {!customEntityMode && displayedCommands.length > 0 ? (
            <div className="flex items-center gap-1">
              <select
                value={selectedCmd ? selectedCmd.id : '__custom__'}
                onChange={e => handleSelectEntity(e.target.value)}
                className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-warning font-semibold truncate"
              >
                {displayedCommands.map(cmd => {
                  const readable = isStateReadableCycleCommand(cmd);
                  const label = cmd.ha_metadata?.name || cmd.name || cmd.id;
                  return (
                    <option key={cmd.id} value={cmd.id}>
                      {label} ({cmd.options?.length || 0} states{readable ? '' : ' · write-only'})
                    </option>
                  );
                })}
                <option value="__custom__">Custom Entity ID...</option>
              </select>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={entId}
                onChange={e => onUpdate({ ...act, entity_id: e.target.value })}
                placeholder="drivers_seat_comfort"
                className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-warning font-mono font-bold"
              />
              {displayedCommands.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCustomEntityMode(false)}
                  className="px-1.5 py-1 text-[10px] rounded bg-surface-secondary border border-border text-muted hover:text-foreground shrink-0"
                  title="Pick from Catalog"
                >
                  Catalog
                </button>
              )}
            </div>
          )}
        </div>

        {/* Step Mode / Direction */}
        <div>
          <label className="block text-[10px] text-muted mb-1">Step Mode / Direction</label>
          <select
            value={direction}
            onChange={e => {
              const nextDir = e.target.value as 'forward' | 'reverse' | 'ping_pong';
              onUpdate({ ...act, direction: nextDir });
            }}
            className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground"
          >
            <option value="forward">Forward ▶ (1 ➔ 2 ➔ 3)</option>
            <option value="reverse">Reverse ◀ (3 ➔ 2 ➔ 1)</option>
            <option value="ping_pong">Ping-Pong ⇄ (1 ➔ 2 ➔ 3 ➔ 2 ➔ 1)</option>
          </select>
        </div>

        {/* End Behavior (Wrap vs Clamp vs Ping-Pong Bounce) */}
        <div>
          <label className="block text-[10px] text-muted mb-1">End of Sequence Behavior</label>
          {isPingPong ? (
            <div className="w-full bg-surface-secondary/60 border border-warning/30 rounded px-2 py-1 text-warning font-mono text-[10px] flex items-center gap-1.5">
              <ArrowLeftRight className="w-3 h-3 shrink-0" />
              <span className="truncate">Bounces at both ends</span>
            </div>
          ) : (
            <select
              value={wrap ? 'true' : 'false'}
              onChange={e => onUpdate({ ...act, wrap: e.target.value === 'true' })}
              className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground"
            >
              <option value="true">
                Wrap Around ↺ ({activeStates[activeStates.length - 1] || 'End'} ➔ {activeStates[0] || 'Start'})
              </option>
              <option value="false">
                Clamp at End ⇥ (Stay at {isReverse ? activeStates[0] || 'Start' : activeStates[activeStates.length - 1] || 'End'})
              </option>
            </select>
          )}
        </div>

        {/* Fallback State Dropdown (When Car Is Outside Sequence) */}
        <div>
          <label className="block text-[10px] text-muted mb-1">If Outside Sequence (Fallback)</label>
          <select
            value={act.fallback_state || '__first__'}
            onChange={e => onUpdate({ ...act, fallback_state: e.target.value })}
            className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground"
          >
            <option value="__first__">Jump to 1st Chip ({activeStates[0] || 'Off'})</option>
            <option value="__none__">Do Nothing / Ignore</option>
            {catalogOptionLabels.map(optLabel => (
              <option key={optLabel} value={optLabel}>
                Jump to: {optLabel}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isSelectedCmdWriteOnly && (
        <div className="p-2 rounded bg-warning/10 border border-warning/30 text-[10px] text-warning flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            This entity has no CAN state feedback (<code className="font-mono">state_can_id</code> / option <code className="font-mono">match</code>), so the ESP32 cannot read its current state from the bus. Pick a state-aware entity for true step cycling.
          </span>
        </div>
      )}

      {/* Available Catalog Options Pool (Click to Toggle Include/Exclude) */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-[10px] text-muted">
            1. Toggle States to Include ({activeStates.length} of {catalogOptionLabels.length} selected):
          </label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={selectAllCatalogChips}
              className="px-2 py-0.5 rounded text-[10px] bg-surface-secondary border border-border text-muted hover:text-foreground transition"
            >
              Reset All States
            </button>
            <button
              type="button"
              onClick={reverseChipOrder}
              className="px-2 py-0.5 rounded text-[10px] bg-surface-secondary border border-border text-warning hover:border-warning transition flex items-center gap-1"
              title="Reverse the order of the active cycle sequence"
            >
              <ArrowLeftRight className="w-3 h-3" />
              <span>Reverse Order</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {catalogOptionLabels.map(label => {
            const selectedIdx = activeStates.findIndex(s => s.toLowerCase() === label.toLowerCase());
            const isSelected = selectedIdx >= 0;
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggleCatalogOptionChip(label)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium border transition flex items-center gap-1 ${
                  isSelected
                    ? 'bg-warning/20 border-warning text-warning shadow-sm'
                    : 'bg-surface-secondary/60 border-border text-muted hover:text-foreground hover:border-border/80 opacity-75'
                }`}
                title={
                  isSelected
                    ? `Included as Step #${selectedIdx + 1} (click to remove)`
                    : 'Click to add to cycle sequence'
                }
              >
                {isSelected ? <Check className="w-3 h-3 shrink-0" /> : <Plus className="w-3 h-3 shrink-0" />}
                <span>{label}</span>
                {isSelected && (
                  <span className="ml-0.5 px-1 rounded bg-warning/30 text-[9px] font-mono font-bold">
                    #{selectedIdx + 1}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Draggable + Reorderable Cycle Sequence Strip */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-muted">
            2. Cycle Sequence Order (Drag chips or use ◀ / ▶ to reorder):
          </label>
          {customEntityMode && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={customStateInput}
                onChange={e => setCustomStateInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomChip();
                  }
                }}
                placeholder="Add custom state..."
                className="bg-surface-secondary border border-border rounded px-2 py-0.5 text-[10px] text-foreground w-32"
              />
              <button
                type="button"
                onClick={handleAddCustomChip}
                className="px-1.5 py-0.5 rounded bg-warning/20 border border-warning/50 text-warning text-[10px] font-bold"
              >
                + Add
              </button>
            </div>
          )}
        </div>

        <div
          className="p-2 rounded-lg bg-surface-secondary/80 border border-border flex flex-wrap items-center gap-1.5 min-h-[42px]"
          onDragOver={e => {
            if (dragIdxRef.current === null) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={e => {
            if (dragIdxRef.current === null) return;
            e.preventDefault();
            e.stopPropagation();
            dragIdxRef.current = null;
            setDragIdx(null);
            setDragOverIdx(null);
          }}
        >
          {activeStates.map((stateLabel, idx) => {
            const isDragging = dragIdx === idx;
            const isDragOver = dragOverIdx === idx && dragIdx !== idx;
            const isLiveActive =
              liveCurrentState !== undefined && liveCurrentState.toLowerCase() === stateLabel.toLowerCase();

            return (
              <React.Fragment key={`${stateLabel}-${idx}`}>
                <div
                  draggable
                  onPointerDown={e => {
                    e.stopPropagation();
                  }}
                  onDragStart={e => {
                    e.stopPropagation();
                    dragIdxRef.current = idx;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', `${chipListId}:${idx}`);
                    requestAnimationFrame(() => setDragIdx(idx));
                  }}
                  onDragEnter={e => {
                    if (dragIdxRef.current === null) return;
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDragOver={e => {
                    if (dragIdxRef.current === null) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverIdx !== idx) setDragOverIdx(idx);
                  }}
                  onDragLeave={e => {
                    e.stopPropagation();
                    if (!e.currentTarget.contains(e.relatedTarget as Node) && dragOverIdx === idx) {
                      setDragOverIdx(null);
                    }
                  }}
                  onDrop={e => {
                    e.stopPropagation();
                    let from = dragIdxRef.current;
                    if (from === null) {
                      const raw = e.dataTransfer.getData('text/plain');
                      if (raw.startsWith(`${chipListId}:`)) {
                        const parsed = parseInt(raw.slice(chipListId.length + 1), 10);
                        if (!isNaN(parsed)) from = parsed;
                      }
                    }
                    if (from === null) return;
                    e.preventDefault();
                    if (from !== idx) {
                      moveChip(from, idx);
                    }
                    dragIdxRef.current = null;
                    setDragIdx(null);
                    setDragOverIdx(null);
                  }}
                  onDragEnd={e => {
                    e.stopPropagation();
                    dragIdxRef.current = null;
                    setDragIdx(null);
                    setDragOverIdx(null);
                  }}
                  className={`group flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium select-none cursor-grab active:cursor-grabbing transition ${
                    isDragging
                      ? 'opacity-40 border-dashed border-warning bg-warning/10'
                      : isDragOver
                      ? 'border-accent bg-accent/20 ring-1 ring-accent'
                      : isLiveActive
                      ? 'border-success bg-success/15 text-success font-bold'
                      : 'border-warning/50 bg-surface-tertiary text-foreground hover:border-warning'
                  }`}
                >
                  <GripVertical className="w-3 h-3 text-muted group-hover:text-warning shrink-0" />
                  <span className="text-[9px] font-mono text-muted">{idx + 1}.</span>
                  <span>{stateLabel}</span>

                  <div className="flex items-center gap-0.5 ml-1">
                    <button
                      type="button"
                      draggable={false}
                      onDragStart={e => e.preventDefault()}
                      onClick={() => moveChip(idx, idx - 1)}
                      disabled={idx === 0}
                      className="p-0.5 text-muted hover:text-foreground disabled:opacity-25 transition"
                      title="Move Left"
                    >
                      <ChevronLeft className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      draggable={false}
                      onDragStart={e => e.preventDefault()}
                      onClick={() => moveChip(idx, idx + 1)}
                      disabled={idx === activeStates.length - 1}
                      className="p-0.5 text-muted hover:text-foreground disabled:opacity-25 transition"
                      title="Move Right"
                    >
                      <ChevronRight className="w-3 h-3" />
                    </button>
                    {activeStates.length > 2 && (
                      <button
                        type="button"
                        draggable={false}
                        onDragStart={e => e.preventDefault()}
                        onClick={() => removeChipAt(idx)}
                        className="p-0.5 text-muted hover:text-danger transition"
                        title="Remove from sequence"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {idx < activeStates.length - 1 && (
                  <span className="text-warning font-mono text-xs font-bold px-0.5">
                    {isPingPong ? '⇄' : isReverse ? '◀' : '➔'}
                  </span>
                )}
              </React.Fragment>
            );
          })}

          <span
            className="ml-1 px-1.5 py-0.5 rounded bg-warning/15 border border-warning/30 text-[10px] font-mono text-warning"
            title={
              isPingPong
                ? 'Ping-Pong mode bounces back and forth at the first and last chips'
                : wrap
                ? 'Wraps from last state back to first state'
                : 'Clamps and stays at the last state'
            }
          >
            {isPingPong ? '⇄ Bounce' : wrap ? '↺ Wrap' : '⇥ Clamp'}
          </span>
        </div>
      </div>

      {/* In-Cabin Confirmation Popup */}
      <div className="pt-2.5 border-t border-separator space-y-2 text-[11px]">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
          <div className="sm:col-span-4">
            <Switch
              isSelected={act.show_popup ?? true}
              onChange={isSelected => onUpdate({ ...act, show_popup: isSelected })}
              size="sm"
              aria-label="Auto-show Cluster / HUD Popup Toast"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="text-foreground">Auto-show Cluster Popup Toast</span>
              </Switch.Content>
            </Switch>
          </div>
          {act.show_popup !== false && (
            <>
              <div className="sm:col-span-6 flex items-center gap-1.5">
                <span className="text-[10px] text-muted shrink-0" title="Supports {state} and {entity} placeholders">
                  Popup Prefix / Template:
                </span>
                <input
                  type="text"
                  value={act.popup_prefix !== undefined ? act.popup_prefix : defaultPopupPrefix}
                  onChange={e => onUpdate({ ...act, popup_prefix: e.target.value })}
                  placeholder={`${defaultPopupPrefix} or {entity}: {state}`}
                  className={`w-full bg-surface-secondary border rounded px-2 py-0.5 text-warning font-medium text-[11px] ${
                    popupLengthCheck.overLimit.length > 0 ? 'border-danger focus:outline-none focus:ring-1 focus:ring-danger' : 'border-border'
                  }`}
                />
                <span
                  className={`text-[9px] font-mono shrink-0 ${
                    popupLengthCheck.overLimit.length > 0
                      ? 'text-danger font-bold'
                      : popupLengthCheck.maxEntry.totalChars >= 45
                      ? 'text-warning font-semibold'
                      : 'text-muted'
                  }`}
                  title={`Longest resolved toast "${popupLengthCheck.maxEntry.text}" + 2-char severity icon (max ${CLUSTER_POPUP_MAX_CODE_UNITS} characters on cluster)`}
                >
                  {popupLengthCheck.maxEntry.totalChars}/{CLUSTER_POPUP_MAX_CODE_UNITS}
                </span>
              </div>
              <div className="sm:col-span-2 flex items-center gap-1">
                <select
                  value={act.level || 'info'}
                  onChange={e => onUpdate({ ...act, level: e.target.value as any })}
                  className="w-full bg-surface-secondary border border-border rounded px-1.5 py-0.5 text-[10px] text-foreground"
                  title="Popup Severity"
                >
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </>
          )}
        </div>

        {act.show_popup !== false && popupLengthCheck.overLimit.length > 0 && (
          <div className="p-2 rounded bg-danger/10 border border-danger/40 text-[10px] text-danger flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              Toast exceeds the {CLUSTER_POPUP_MAX_CODE_UNITS}-character cluster limit (including 2-char severity icon) for{' '}
              <strong>
                {popupLengthCheck.overLimit.map(e => `"${e.state}" (${e.totalChars}/${CLUSTER_POPUP_MAX_CODE_UNITS})`).join(', ')}
              </strong>
              . Firmware drops oversized popups — shorten the prefix or use <code className="font-mono">{'{state}'}</code> (≤{CLUSTER_POPUP_MAX_TEXT_CODE_UNITS} chars before icon).
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

interface NumericActionRangeControlProps {
  act: AutomationAction;
  catalogCmd: Command;
  effectiveCanId: string;
  effectiveBus: number;
  effectivePayloadMap: ByteMap;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  onUpdate: (updated: AutomationAction) => void;
}

const NumericActionRangeControl: React.FC<NumericActionRangeControlProps> = ({
  act,
  catalogCmd,
  effectiveCanId,
  effectiveBus,
  effectivePayloadMap,
  liveFrames,
  entityStates,
  onUpdate
}) => {
  const net = catalogCmd.network;
  const nativeUnit = net?.unit || '';
  const isTemperature = nativeUnit === '°C' || nativeUnit === '°F' || (catalogCmd.id && catalogCmd.id.includes('temp'));

  const [displayTempUnit, setDisplayTempUnit] = useState<'°F' | '°C'>(() => {
    return nativeUnit === '°F' ? '°F' : '°C';
  });

  const actionByte = normalizeByteKey(net?.action_byte || net?.state_byte || net?.byte || 'D1');
  const stateByte = normalizeByteKey(net?.state_byte || net?.action_byte || net?.byte || 'D1');
  const stateCanId = net?.state_can_id || catalogCmd.state_can_id || effectiveCanId || '0x000';
  const stateByteIdx = useMemo(() => {
    const m = stateByte.match(/D(\d+)/i);
    return m ? Math.max(0, Math.min(7, parseInt(m[1], 10) - 1)) : 0;
  }, [stateByte]);

  const rawVal = useMemo(() => {
    const payloadHex = effectivePayloadMap[actionByte];
    if (typeof payloadHex === 'string' && payloadHex.trim() !== '') {
      const parsed = payloadHex.trim().startsWith('0x')
        ? parseInt(payloadHex, 16)
        : parseInt(payloadHex, 10);
      if (!isNaN(parsed)) return parsed;
    }
    const labelStr = act.option_label || act.command;
    if (labelStr) {
      const num = parseFloat(labelStr);
      if (!isNaN(num)) {
        return physicalToRawByte(num, net);
      }
      if (catalogCmd.options) {
        const found = catalogCmd.options.find(o => o.label?.toLowerCase() === labelStr.toLowerCase());
        if (found && found.match) {
          const mVal = Object.values(found.match)[0];
          if (mVal) {
            const parsed = parseInt(String(mVal).replace(/^0x/i, ''), 16);
            if (!isNaN(parsed)) return parsed;
          }
        }
      }
      const matchNum = labelStr.match(/(\d+(\.\d+)?)/);
      if (matchNum) {
        const parsed = parseFloat(matchNum[1]);
        if (!isNaN(parsed)) return physicalToRawByte(parsed, net);
      }
      if (labelStr.toLowerCase().includes('off')) {
        return physicalToRawByte(net?.min ?? 0, net);
      }
    }
    return physicalToRawByte(getDefaultPhysicalValue(net), net);
  }, [effectivePayloadMap, actionByte, act.option_label, act.command, net, catalogCmd.options]);

  const currentPhys = useMemo(() => {
    const res = rawByteToPhysical(isNaN(rawVal) ? 0 : rawVal, net);
    if (isTemperature) {
      if (nativeUnit === '°C' && displayTempUnit === '°F') {
        return Math.round((res.val * 1.8 + 32) * 10) / 10;
      } else if (nativeUnit === '°F' && displayTempUnit === '°C') {
        return Math.round(((res.val - 32) / 1.8) * 10) / 10;
      }
    }
    return Math.round(res.val * 100) / 100;
  }, [rawVal, net, isTemperature, nativeUnit, displayTempUnit]);

  const liveInfo = useMemo(() => {
    const cleanCanId = stateCanId.toLowerCase().replace(/^0x/, '');
    if (liveFrames && cleanCanId) {
      for (const [k, frame] of liveFrames.entries()) {
        if (k.toLowerCase().replace(/^0x/, '') === cleanCanId) {
          const bytes = parseHexPayload(frame.data);
          if (bytes && bytes.length > stateByteIdx) {
            const actByte = bytes[stateByteIdx];
            const phys = rawByteToPhysical(actByte, net);
            let displayVal = phys.val;
            if (isTemperature) {
              if (nativeUnit === '°C' && displayTempUnit === '°F') {
                displayVal = Math.round((phys.val * 1.8 + 32) * 10) / 10;
              } else if (nativeUnit === '°F' && displayTempUnit === '°C') {
                displayVal = Math.round(((phys.val - 32) / 1.8) * 10) / 10;
              }
            }
            return {
              physValue: displayVal,
              formatted: `${displayVal} ${isTemperature ? displayTempUnit : nativeUnit}`
            };
          }
        }
      }
    }
    if (catalogCmd.id && entityStates && entityStates.has(catalogCmd.id)) {
      return {
        formatted: entityStates.get(catalogCmd.id) || '',
        physValue: undefined
      };
    }
    return undefined;
  }, [liveFrames, entityStates, stateCanId, stateByteIdx, net, isTemperature, nativeUnit, displayTempUnit, catalogCmd.id]);

  const sliderMin = useMemo(() => {
    if (net?.min === undefined) return undefined;
    if (isTemperature && nativeUnit === '°C' && displayTempUnit === '°F') return Math.round((net.min * 1.8 + 32) * 10) / 10;
    if (isTemperature && nativeUnit === '°F' && displayTempUnit === '°C') return Math.round(((net.min - 32) / 1.8) * 10) / 10;
    return net.min;
  }, [net?.min, isTemperature, nativeUnit, displayTempUnit]);

  const sliderMax = useMemo(() => {
    if (net?.max === undefined) return undefined;
    if (isTemperature && nativeUnit === '°C' && displayTempUnit === '°F') return Math.round((net.max * 1.8 + 32) * 10) / 10;
    if (isTemperature && nativeUnit === '°F' && displayTempUnit === '°C') return Math.round(((net.max - 32) / 1.8) * 10) / 10;
    return net.max;
  }, [net?.max, isTemperature, nativeUnit, displayTempUnit]);

  const sliderStep = isTemperature && displayTempUnit === '°C' && nativeUnit === '°F' ? 0.5 : (net?.step || 1);

  const updateActionSetpoint = (newDisplayVal: number) => {
    let clampedDisplay = newDisplayVal;
    if (sliderMin !== undefined) clampedDisplay = Math.max(sliderMin, clampedDisplay);
    if (sliderMax !== undefined) clampedDisplay = Math.min(sliderMax, clampedDisplay);

    let nativePhys = clampedDisplay;
    if (isTemperature) {
      if (nativeUnit === '°C' && displayTempUnit === '°F') {
        nativePhys = (clampedDisplay - 32) / 1.8;
      } else if (nativeUnit === '°F' && displayTempUnit === '°C') {
        nativePhys = clampedDisplay * 1.8 + 32;
      }
    }

    const calculatedRaw = physicalToRawByte(nativePhys, net);
    const hexVal = `0x${calculatedRaw.toString(16).toUpperCase().padStart(2, '0')}`;
    let payload = buildRangeActionPayload(hexVal, net);
    const displayUnit = isTemperature ? displayTempUnit : nativeUnit;
    const roundedDisplay = Math.round(clampedDisplay * 10) / 10;
    let labelStr = `${roundedDisplay}${displayUnit}`;
    const txCanId = net?.action_can_id || catalogCmd.action_can_id || effectiveCanId || '0x000';
    const rangeSteps = resolveRangeSteps(catalogCmd, hexVal);
    const txBus = net?.bus ?? effectiveBus ?? 0;
    let cleanSteps = rangeSteps && rangeSteps.length > 1
      ? rangeSteps.map((s, idx) => ({
          can_id: s.can_id || txCanId,
          bus: s.bus ?? txBus,
          payload: compileToByteMap(s.payload),
          repeat: s.repeat ?? 1,
          delay_ms: s.delay_ms ?? (idx < rangeSteps.length - 1 ? (net?.delay_ms ?? 20) : 0)
        }))
      : undefined;

    // Check if catalogCmd has discrete options matching this slider setpoint (e.g. ambient_light_brightness)
    if (catalogCmd.options && catalogCmd.options.length > 0) {
      const matchedOpt = catalogCmd.options.find(o => {
        if (o.match) {
          const mVal = Object.values(o.match)[0];
          if (mVal && String(mVal).toLowerCase() === hexVal.toLowerCase()) return true;
        }
        return false;
      }) || catalogCmd.options[Math.round(clampedDisplay)];

      if (matchedOpt) {
        if (matchedOpt.steps && matchedOpt.steps.length > 1) {
          cleanSteps = matchedOpt.steps.map((s: any, idx: number) => ({
            can_id: s.can_id || txCanId,
            bus: s.bus ?? txBus,
            payload: compileToByteMap(s.payload),
            repeat: s.repeat ?? 1,
            delay_ms: s.delay_ms ?? (idx < matchedOpt.steps!.length - 1 ? (net?.delay_ms ?? 20) : 0)
          }));
        } else if (matchedOpt.payload) {
          payload = compileToByteMap(matchedOpt.payload);
        }
        labelStr = matchedOpt.label;
      }
    }

    onUpdate({
      ...act,
      type: 'can_tx',
      can_id: txCanId,
      bus: txBus,
      payload: cleanSteps ? cleanSteps[0].payload : payload,
      ...(cleanSteps ? { steps: cleanSteps } : { steps: undefined }),
      command: labelStr,
      option_label: labelStr,
      entity_id: catalogCmd.id,
      source_command_id: catalogCmd.id,
      source_command_name: catalogCmd.ha_metadata?.name || catalogCmd.name || catalogCmd.id,
      ...(net?.delay_ms !== undefined && act.delay_ms === undefined ? { delay_ms: net.delay_ms } : {})
    });
  };

  const activeUnit = isTemperature ? displayTempUnit : nativeUnit;
  const hexByte = `0x${rawVal.toString(16).toUpperCase().padStart(2, '0')}`;

  return (
    <div className="space-y-2.5 p-3 rounded-lg bg-surface-tertiary/50 border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground/90">
          {isTemperature ? (
            <Thermometer className="w-4 h-4 text-danger" />
          ) : (
            <Gauge className="w-4 h-4 text-success" />
          )}
          <span>Target Setpoint</span>
          {net?.min !== undefined && net?.max !== undefined && (
            <span className="text-[10px] text-muted font-mono">
              ({net.min} to {net.max} {nativeUnit})
            </span>
          )}
        </div>

        {isTemperature && (
          <div className="flex items-center rounded-md bg-surface-tertiary border border-border p-0.5 text-[11px] font-bold">
            <button
              type="button"
              onClick={() => setDisplayTempUnit('°F')}
              className={`px-2 py-0.5 rounded transition ${
                displayTempUnit === '°F'
                  ? 'bg-success text-white shadow-sm'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              °F
            </button>
            <button
              type="button"
              onClick={() => setDisplayTempUnit('°C')}
              className={`px-2 py-0.5 rounded transition ${
                displayTempUnit === '°C'
                  ? 'bg-success text-white shadow-sm'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              °C
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
        <button
          type="button"
          onClick={() => updateActionSetpoint(currentPhys - sliderStep)}
          className="px-2.5 py-1.5 rounded bg-surface-tertiary hover:bg-default-hover border border-border text-foreground font-bold text-xs cursor-pointer"
          title="Decrement step"
        >
          -
        </button>

        {sliderMin !== undefined && sliderMax !== undefined && (
          <div className="flex-1 flex items-center gap-2 min-w-[140px]">
            <span className="text-[10px] font-mono text-muted shrink-0">
              {sliderMin}{activeUnit}
            </span>
            <input
              type="range"
              min={sliderMin}
              max={sliderMax}
              step={sliderStep}
              value={Math.max(sliderMin, Math.min(sliderMax, isNaN(currentPhys) ? sliderMin : currentPhys))}
              onChange={e => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) updateActionSetpoint(val);
              }}
              aria-label="Action Target Setpoint Slider"
              className="flex-1 accent-success cursor-pointer h-1.5 rounded-lg"
            />
            <span className="text-[10px] font-mono text-muted shrink-0">
              {sliderMax}{activeUnit}
            </span>
          </div>
        )}

        <div className="flex items-center gap-1 w-24 shrink-0">
          <input
            type="number"
            step={sliderStep}
            value={isNaN(currentPhys) ? '' : currentPhys}
            onChange={e => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) updateActionSetpoint(val);
            }}
            className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-success font-mono font-bold text-sm text-center focus:outline-none focus:ring-1 focus:ring-success"
          />
          <span className="text-xs font-bold text-muted shrink-0 font-sans">
            {activeUnit}
          </span>
        </div>

        <button
          type="button"
          onClick={() => updateActionSetpoint(currentPhys + sliderStep)}
          className="px-2.5 py-1.5 rounded bg-surface-tertiary hover:bg-default-hover border border-border text-foreground font-bold text-xs cursor-pointer"
          title="Increment step"
        >
          +
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-separator text-[11px]">
        {liveInfo ? (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
            <span className="text-muted">Live Car Reading:</span>
            <span className="font-mono font-semibold text-foreground">{liveInfo.formatted}</span>
            {liveInfo.physValue !== undefined && (
              <button
                type="button"
                onClick={() => updateActionSetpoint(liveInfo.physValue!)}
                className="ml-1 text-[10px] text-success hover:underline font-mono cursor-pointer"
                title="Set action setpoint to current vehicle value"
              >
                Use Current
              </button>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-muted flex items-center gap-1">
            <Activity className="w-3 h-3 text-muted" />
            <span>TX CAN frame on trigger</span>
          </div>
        )}

        <div className="text-[10px] font-mono text-muted/80 ml-auto">
          TX Frame {effectiveCanId || net?.action_can_id || '0x000'} · {actionByte} = {hexByte} ({rawVal})
        </div>
      </div>
    </div>
  );
};

export interface ActionNodeEditorProps {
  key?: React.Key;
  act: AutomationAction;
  index: number;
  depth?: number;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (updated: AutomationAction) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
  onTestSingleAction?: (act: AutomationAction) => void;
  dragConfig?: NodeDragConfig;
}

export interface ActionListEditorProps {
  actions: AutomationAction[];
  depth?: number;
  label?: string;
  emptyText?: string;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (actions: AutomationAction[]) => void;
  onPullCatalog?: () => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
  onTestSingleAction?: (act: AutomationAction) => void;
}

export function ActionNodeEditor({
  act,
  index,
  depth = 0,
  availableTriggers,
  catalog,
  liveFrames,
  entityStates,
  lastFiredTriggerId,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  onOpenAddConditionDialog,
  onOpenAddActionDialog,
  onTestSingleAction,
  dragConfig
}: ActionNodeEditorProps) {
  const { clipboard, copyToClipboard, pasteFromClipboard } = useContext(AutomationClipboardContext);
  const [collapsed, setCollapsed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testFiring, setTestFiring] = useState(false);
  const [collapsedBranches, setCollapsedBranches] = useState<Set<number>>(new Set());
  const [dragArmed, setDragArmed] = useState(false);
  const branchListId = useId();
  const [armedBranchIdx, setArmedBranchIdx] = useState<number | null>(null);
  const [branchDragIdx, setBranchDragIdx] = useState<number | null>(null);
  const [branchDragOverIdx, setBranchDragOverIdx] = useState<number | null>(null);

  const dragClass = dragConfig?.isDragging
    ? 'opacity-50 ring-1 ring-accent/50'
    : dragConfig?.isDragOver
    ? 'ring-2 ring-accent border-accent bg-accent-soft/15'
    : '';

  const cardDragProps = dragConfig
    ? {
        draggable: dragArmed,
        onDragStart: (e: React.DragEvent) => {
          if (!dragArmed) {
            e.preventDefault();
            return;
          }
          dragConfig.onDragStart(e);
        },
        onDragOver: dragConfig.onDragOver,
        onDrop: (e: React.DragEvent) => {
          setDragArmed(false);
          dragConfig.onDrop(e);
        },
        onDragEnd: () => {
          setDragArmed(false);
          dragConfig.onDragEnd();
        },
        onPointerUp: () => setDragArmed(false)
      }
    : {};

  const dragHandle = dragConfig ? (
    <span
      onPointerDown={e => {
        e.stopPropagation();
        setDragArmed(true);
      }}
      onPointerUp={() => setDragArmed(false)}
      className="cursor-grab active:cursor-grabbing text-muted hover:text-foreground p-0.5 shrink-0 touch-none"
      title="Drag to reorder"
      aria-label="Drag action to reorder"
    >
      <GripVertical className="w-3.5 h-3.5" />
    </span>
  ) : null;

  const toggleBranchCollapse = (idx: number) => {
    setCollapsedBranches(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleTestTrigger = async () => {
    if (!onTestSingleAction || testFiring) return;
    setTestFiring(true);
    try {
      await onTestSingleAction(act);
    } finally {
      setTimeout(() => setTestFiring(false), 600);
    }
  };

  const isBuiltinNonCanTx = [
    'precondition',
    'climate_target',
    'remote_climate',
    'track_popup',
    'popup',
    'hud_nav',
    'nav',
    'delay',
    'if_then',
    'choose',
    'webhook',
    'cycle_entity',
    'wait_for',
    'repeat_until'
  ].includes(act.type);
  const isCanTxAction =
    act.type === 'can_tx' ||
    act.type === 'entity_command' ||
    act.type === 'transmit' ||
    !isBuiltinNonCanTx;

  // Action naming & catalog resolution (only CAN TX and cycle_entity resolve catalog commands)
  const shouldResolveCatalogCmd = isCanTxAction || act.type === 'cycle_entity';
  const { command: catalogCmd, matchedOption } =
    catalog && shouldResolveCatalogCmd
      ? resolveCatalogCommandForAction(act, catalog)
      : { command: undefined, matchedOption: undefined };
  const hasOptions = isCanTxAction && !!(catalogCmd?.options && catalogCmd.options.length > 0);
  const isRangeEntity = isCanTxAction && isRangeCommand(catalogCmd);
  const hasPills = hasOptions && !isRangeEntity;
  const hasCompactCatalogView = hasPills || isRangeEntity || (isCanTxAction && Boolean(catalogCmd));
  const actionName =
    act.type === 'cycle_entity'
      ? `Cycle ${catalogCmd?.ha_metadata?.name || catalogCmd?.name || act.entity_id || 'Entity'}`
      : act.type === 'hud_nav' || act.type === 'nav'
      ? 'HUD & Cluster Turn-by-Turn'
      : act.type === 'track_popup' || act.type === 'popup'
      ? 'Cluster Popup'
      : act.type === 'precondition'
      ? 'Battery Preconditioning'
      : act.type === 'climate_target' || act.type === 'remote_climate'
      ? 'Climate Target'
      : act.type === 'delay'
      ? `Delay ${act.delay_ms || act.ms || 0}ms`
      : act.type === 'if_then'
      ? 'IF-THEN-ELSE'
      : act.type === 'choose'
      ? 'CHOOSE'
      : act.type === 'wait_for'
      ? 'Wait For'
      : act.type === 'repeat_until'
      ? 'Repeat Until'
      : catalogCmd?.ha_metadata?.name ||
        catalogCmd?.name ||
        act.source_command_name ||
        (act.can_id
          ? `CAN Transmit ${formatCanId(act.can_id)}`
          : `Action ${index + 1}`);

  const actionButtons = (
    <div className="flex items-center gap-1 shrink-0 flex-wrap">
      {onTestSingleAction && (
        <button
          type="button"
          onClick={handleTestTrigger}
          disabled={testFiring}
          className={`p-1 sm:p-1.5 rounded-lg border transition flex items-center gap-1 shrink-0 ${
            testFiring
              ? 'bg-success text-success-foreground border-success animate-pulse'
              : 'bg-success-soft text-success-soft-foreground hover:bg-success/20 border-success/40 hover:border-success'
          }`}
          title="Manual Trigger: Test this individual action now"
        >
          <Play className={`w-3 h-3 ${testFiring ? 'fill-current' : 'fill-success text-success'}`} />
          <span className="text-[10px] font-bold hidden sm:inline">Test</span>
        </button>
      )}
      {onMoveUp && (
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition shrink-0"
          title="Move up"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
      )}
      {onMoveDown && (
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition shrink-0"
          title="Move down"
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </button>
      )}
      {onDuplicate && (
        <button
          type="button"
          onClick={onDuplicate}
          className="p-1 text-muted hover:text-accent transition shrink-0"
          title="Duplicate action"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => copyToClipboard('action', act, actionName)}
        className="p-1 text-muted hover:text-success transition shrink-0"
        title="Copy action to clipboard"
      >
        <ClipboardCopy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-muted hover:text-danger transition shrink-0"
        title="Delete action"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  // If IF_THEN:
  if (act.type === 'if_then') {
    return (
      <div
        {...cardDragProps}
        className={`p-2.5 sm:p-3 rounded-xl border border-accent/40 bg-accent-soft/30 space-y-3 text-xs transition-all min-w-0 overflow-hidden ${dragClass}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {dragHandle}
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-accent-soft text-accent-soft-foreground border border-accent/40 flex items-center gap-1 min-w-0">
              <GitFork className="w-3 h-3 shrink-0" />
              <span className="truncate">IF - THEN - ELSE</span> {depth > 0 && `(L${depth + 1})`}
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {collapsed && (
          <div className="px-2.5 py-1.5 rounded-lg bg-surface-tertiary/70 border border-border/60 font-mono text-[11px] text-muted truncate">
            {formatActionSummary(act, catalog)}
          </div>
        )}

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            {/* IF CONDITIONS */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
              <ConditionListEditor
                conditions={act.conditions || []}
                depth={depth + 1}
                label="IF (Conditions)"
                emptyText="No conditions in this IF block."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onUpdate={updatedConds => onUpdate({ ...act, conditions: updatedConds })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
              />
            </div>

            {/* THEN ACTIONS */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.then || []}
                depth={depth + 1}
                label="THEN (Execute if True)"
                emptyText="No actions in THEN branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedThen => onUpdate({ ...act, then: updatedThen })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>

            {/* ELSE ACTIONS */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.else || []}
                depth={depth + 1}
                label="ELSE (Execute if False)"
                emptyText="No actions in ELSE branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedElse => onUpdate({ ...act, else: updatedElse })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // If CHOOSE:
  if (act.type === 'choose') {
    return (
      <div
        {...cardDragProps}
        className={`p-2 sm:p-3 rounded-xl border border-purple-500/40 bg-purple-500/5 space-y-3 text-xs transition-all min-w-0 overflow-hidden ${dragClass}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {dragHandle}
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/40 flex items-center gap-1 min-w-0">
              <Split className="w-3 h-3 shrink-0" />
              <span className="truncate">CHOOSE (Sequential Branching)</span> {depth > 0 && `(L${depth + 1})`}
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {collapsed && (
          <div className="px-2.5 py-1.5 rounded-lg bg-surface-tertiary/70 border border-border/60 font-mono text-[11px] text-muted truncate">
            {formatActionSummary(act, catalog)}
          </div>
        )}

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            {/* BRANCHES */}
            <div className="space-y-2.5 min-w-0">
              {(act.choices || []).map((ch, chIdx) => {
                const isBranchCollapsed = collapsedBranches.has(chIdx);
                const condCount = ch.conditions?.length || 0;
                const actCount = ch.sequence?.length || 0;
                const branchTitle = ch.label || `Branch #${chIdx + 1}`;

                const moveBranch = (direction: -1 | 1) => {
                  const targetIdx = chIdx + direction;
                  const list = act.choices || [];
                  if (targetIdx < 0 || targetIdx >= list.length) return;
                  onUpdate({ ...act, choices: arrayMove(list, chIdx, targetIdx) });
                };

                const duplicateBranch = () => {
                  const list = [...(act.choices || [])];
                  const clonedBranch = regenerateBranchIds(ch, true);
                  list.splice(chIdx + 1, 0, clonedBranch);
                  onUpdate({ ...act, choices: list });
                };

                const copyBranch = () => {
                  copyToClipboard('choice_branch', ch, branchTitle);
                };

                const branchCount = (act.choices || []).length;
                const isBranchDragging = branchDragIdx === chIdx;
                const isBranchDragOver = branchDragOverIdx === chIdx && branchDragIdx !== chIdx;
                const branchDragClass = isBranchDragging
                  ? 'opacity-50 ring-1 ring-purple-500/60'
                  : isBranchDragOver
                  ? 'ring-2 ring-purple-500 border-purple-500 bg-purple-500/10'
                  : '';

                return (
                  <div
                    key={ch._clientId || chIdx}
                    draggable={branchCount > 1 && armedBranchIdx === chIdx}
                    onDragStart={e => {
                      if (armedBranchIdx !== chIdx) {
                        e.preventDefault();
                        return;
                      }
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', `${branchListId}:${chIdx}`);
                      setActiveScopedDrag({ listId: branchListId, index: chIdx });
                      setBranchDragIdx(chIdx);
                    }}
                    onDragOver={e => {
                      const active = getActiveScopedDrag();
                      if (active?.listId !== branchListId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      if (branchDragOverIdx !== chIdx) {
                        setBranchDragOverIdx(chIdx);
                      }
                    }}
                    onDrop={e => {
                      const active = getActiveScopedDrag();
                      if (active?.listId !== branchListId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (active.index !== chIdx) {
                        onUpdate({ ...act, choices: arrayMove(act.choices || [], active.index, chIdx) });
                      }
                      setArmedBranchIdx(null);
                      setActiveScopedDrag(null);
                      setBranchDragIdx(null);
                      setBranchDragOverIdx(null);
                    }}
                    onDragEnd={() => {
                      setArmedBranchIdx(null);
                      setActiveScopedDrag(null);
                      setBranchDragIdx(null);
                      setBranchDragOverIdx(null);
                    }}
                    onPointerUp={() => setArmedBranchIdx(null)}
                    className={`p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 transition-all min-w-0 overflow-hidden ${branchDragClass}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        {branchCount > 1 && (
                          <span
                            onPointerDown={e => {
                              e.stopPropagation();
                              setArmedBranchIdx(chIdx);
                            }}
                            onPointerUp={() => setArmedBranchIdx(null)}
                            className="cursor-grab active:cursor-grabbing text-muted hover:text-foreground p-0.5 shrink-0 touch-none"
                            title="Drag branch to reorder"
                            aria-label={`Drag branch #${chIdx + 1} to reorder`}
                          >
                            <GripVertical className="w-3.5 h-3.5" />
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleBranchCollapse(chIdx)}
                          className="text-muted hover:text-foreground transition p-0.5 shrink-0"
                          title={isBranchCollapsed ? "Expand branch" : "Collapse branch"}
                        >
                          {isBranchCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                        </button>
                        <span className="w-5 h-5 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400 font-bold text-[10px] flex items-center justify-center border border-purple-500/40 shrink-0">
                          #{chIdx + 1}
                        </span>
                        <input
                          type="text"
                          value={ch.label || ''}
                          onChange={e => {
                            const choices = [...(act.choices || [])];
                            choices[chIdx] = { ...ch, label: e.target.value };
                            onUpdate({ ...act, choices });
                          }}
                          placeholder={`Branch #${chIdx + 1} (e.g. Low Heat ➔ Med Heat)`}
                          className="bg-surface-tertiary border border-border rounded px-2 py-0.5 text-foreground text-xs font-semibold focus:outline-none focus:border-purple-500 flex-1 min-w-0 truncate"
                        />
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={chIdx === 0}
                          onClick={() => moveBranch(-1)}
                          className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition shrink-0 cursor-pointer"
                          title="Move branch up (higher priority)"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={chIdx === (act.choices || []).length - 1}
                          onClick={() => moveBranch(1)}
                          className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition shrink-0 cursor-pointer"
                          title="Move branch down (lower priority)"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={duplicateBranch}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-tertiary hover:bg-default-hover text-accent border border-border hover:border-accent transition shrink-0 cursor-pointer"
                          title="Duplicate this branch and all its conditions & sequence actions"
                        >
                          <Copy className="w-3 h-3" />
                          <span className="hidden sm:inline">Duplicate</span>
                        </button>
                        <button
                          type="button"
                          onClick={copyBranch}
                          className="p-1 text-muted hover:text-purple-500 transition shrink-0 cursor-pointer"
                          title="Copy branch to universal clipboard"
                        >
                          <ClipboardCopy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const choices = (act.choices || []).filter((_, i) => i !== chIdx);
                            onUpdate({ ...act, choices });
                          }}
                          className="p-1 text-muted hover:text-danger transition shrink-0 cursor-pointer"
                          title="Delete Branch"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {isBranchCollapsed ? (
                      <div className="text-[11px] text-muted pl-7 font-mono flex items-center gap-2">
                        <span>
                          {condCount === 0 ? 'No conditions (always matches)' : `${condCount} condition(s)`} ➔ {actCount} action(s)
                        </span>
                      </div>
                    ) : (
                      <>
                        {/* Conditions in Choice */}
                        <div className="pl-1.5 sm:pl-2 border-l border-separator min-w-0">
                          <ConditionListEditor
                            conditions={ch.conditions || []}
                            depth={depth + 1}
                            label="Branch Conditions"
                            emptyText="No conditions in this branch."
                            availableTriggers={availableTriggers}
                            catalog={catalog}
                            liveFrames={liveFrames}
                            entityStates={entityStates}
                            lastFiredTriggerId={lastFiredTriggerId}
                            liveWifiStatus={liveWifiStatus}
                            liveBleMap={liveBleMap}
                            onUpdate={updatedConds => {
                              const choices = [...(act.choices || [])];
                              choices[chIdx].conditions = updatedConds;
                              onUpdate({ ...act, choices });
                            }}
                            onOpenAddConditionDialog={onOpenAddConditionDialog}
                          />
                        </div>

                        {/* Sequence in Choice */}
                        <div className="pl-1.5 sm:pl-2 border-l border-separator pt-2 min-w-0">
                          <ActionListEditor
                            actions={ch.sequence || []}
                            depth={depth + 1}
                            label="Branch Sequence Actions"
                            emptyText="No actions in branch sequence."
                            availableTriggers={availableTriggers}
                            catalog={catalog}
                            liveFrames={liveFrames}
                            entityStates={entityStates}
                            lastFiredTriggerId={lastFiredTriggerId}
                            liveWifiStatus={liveWifiStatus}
                            liveBleMap={liveBleMap}
                            onTestSingleAction={onTestSingleAction}
                            onUpdate={updatedSeq => {
                              const choices = [...(act.choices || [])];
                              choices[chIdx].sequence = updatedSeq;
                              onUpdate({ ...act, choices });
                            }}
                            onOpenAddConditionDialog={onOpenAddConditionDialog}
                            onOpenAddActionDialog={onOpenAddActionDialog}
                          />
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2 flex-wrap mt-2">
              <button
                type="button"
                onClick={() => {
                  const choices = [...(act.choices || [])];
                  choices.push({
                    conditions: [],
                    sequence: []
                  });
                  onUpdate({ ...act, choices });
                }}
                className="ha-section-add-btn accent-act"
              >
                <Plus className="w-4 h-4" />
                <span>Add Choice Branch</span>
              </button>

              {clipboard?.type === 'choice_branch' && (
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const pasted = await pasteFromClipboard('choice_branch');
                      if (pasted) {
                        onUpdate({ ...act, choices: [...(act.choices || []), pasted] });
                      }
                    })();
                  }}
                  className="ha-section-paste-btn bg-purple-500/15 hover:bg-purple-500/25 text-purple-600 dark:text-purple-400 border border-purple-500/40"
                  title={`Paste copied choice branch "${clipboard.label}"`}
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  <span>Paste Branch ({clipboard.label})</span>
                </button>
              )}
            </div>

            {/* DEFAULT SEQUENCE */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.default || []}
                depth={depth + 1}
                label="DEFAULT (If no branch matches)"
                emptyText="No actions in DEFAULT branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedDef => onUpdate({ ...act, default: updatedDef })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Unified WAIT (Condition or Delay)
  if (act.type === 'wait_for' || act.type === 'delay') {
    const isDelayMode = act.type === 'delay';
    const condList = act.conditions || (act.condition ? [act.condition] : []);

    const currentTotalMs = act.delay_ms !== undefined && act.delay_ms !== null 
      ? act.delay_ms 
      : (act.ms !== undefined && act.ms !== null ? act.ms : 2000);

    let defaultUnit: 'ms' | 's' | 'mins' | 'hrs' = 'ms';
    let displayVal = currentTotalMs;
    if (currentTotalMs > 0) {
      if (currentTotalMs % 3600000 === 0) {
        defaultUnit = 'hrs';
        displayVal = currentTotalMs / 3600000;
      } else if (currentTotalMs % 60000 === 0) {
        defaultUnit = 'mins';
        displayVal = currentTotalMs / 60000;
      } else if (currentTotalMs % 1000 === 0) {
        defaultUnit = 's';
        displayVal = currentTotalMs / 1000;
      }
    }
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      mins: 60000,
      hrs: 3600000
    };

    return (
      <div
        {...cardDragProps}
        className={`p-2 sm:p-3 rounded-xl border border-purple-500/40 bg-purple-500/5 space-y-3 text-xs transition-all min-w-0 overflow-hidden ${dragClass}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {dragHandle}
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/40 flex items-center gap-1 min-w-0">
              <Clock className="w-3 h-3 shrink-0" />
              <span className="truncate">WAIT (Condition or Delay)</span>
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {collapsed && (
          <div className="px-2.5 py-1.5 rounded-lg bg-surface-tertiary/70 border border-border/60 font-mono text-[11px] text-muted truncate">
            {formatActionSummary(act, catalog)}
          </div>
        )}

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            {/* Mode switch */}
            <Tabs
              selectedKey={isDelayMode ? 'delay' : 'wait_for'}
              onSelectionChange={key => {
                if (key === 'delay') {
                  onUpdate({
                    ...act,
                    type: 'delay',
                    delay_ms: currentTotalMs || 2000,
                    ms: currentTotalMs || 2000
                  });
                } else {
                  onUpdate({
                    ...act,
                    type: 'wait_for',
                    timeout_ms: act.timeout_ms || 10000,
                    interval_ms: act.interval_ms || 50,
                    conditions: condList.length > 0 ? condList : [{
                      id: `cond_wait_${Date.now().toString(36)}`,
                      type: 'ble_button',
                      ble_button: 'any',
                      ble_action: 'press'
                    }]
                  });
                }
              }}
              aria-label="Delay Execution Mode"
              className="w-full"
            >
              <Tabs.ListContainer className="p-1 bg-default border border-border rounded-lg w-full">
                <Tabs.List className="gap-2 w-full">
                  <Tabs.Tab
                    id="delay"
                    className={`relative flex-1 py-1 px-2.5 rounded text-xs font-medium transition cursor-pointer flex items-center justify-center ${
                      isDelayMode
                        ? 'text-white'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <span>Fixed Delay Duration</span>
                    <Tabs.Indicator className="rounded bg-purple-600 shadow-sm" />
                  </Tabs.Tab>

                  <Tabs.Tab
                    id="wait_for"
                    className={`relative flex-1 py-1 px-2.5 rounded text-xs font-medium transition cursor-pointer flex items-center justify-center ${
                      !isDelayMode
                        ? 'text-white'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <span>Wait For Condition / Button Press</span>
                    <Tabs.Indicator className="rounded bg-purple-600 shadow-sm" />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>

            {isDelayMode ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px] items-end">
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-muted mb-1">Delay Duration Value</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={displayVal || ''}
                      onChange={e => {
                        const raw = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                        const factor = multipliers[defaultUnit] || 1;
                        const total = Math.round(raw * factor);
                        onUpdate({ ...act, type: 'delay', delay_ms: total, ms: total });
                      }}
                      placeholder="0"
                      className="w-full h-8 bg-surface-secondary border border-border rounded px-2.5 text-foreground font-mono text-xs focus:outline-none focus:border-purple-500 box-border"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-muted mb-1">Duration Unit</label>
                    <select
                      value={defaultUnit}
                      onChange={e => {
                        const newUnit = e.target.value;
                        const newFactor = multipliers[newUnit] || 1;
                        const total = Math.round(displayVal * newFactor);
                        onUpdate({ ...act, type: 'delay', delay_ms: total, ms: total });
                      }}
                      className="w-full h-8 bg-surface-secondary border border-border rounded px-2 text-purple-600 dark:text-purple-400 font-sans text-xs focus:outline-none focus:border-purple-500 box-border"
                    >
                      <option value="ms">Milliseconds (ms)</option>
                      <option value="s">Seconds (s)</option>
                      <option value="mins">Minutes (mins)</option>
                      <option value="hrs">Hours (hrs)</option>
                    </select>
                  </div>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center gap-1.5 flex-wrap pt-1 font-mono text-[10px]">
                  <span className="text-muted font-sans">Quick Presets:</span>
                  {[
                    { label: '250ms', val: 250 },
                    { label: '500ms', val: 500 },
                    { label: '1s', val: 1000 },
                    { label: '2s', val: 2000 },
                    { label: '5s', val: 5000 },
                    { label: '10s', val: 10000 }
                  ].map(p => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => onUpdate({ ...act, type: 'delay', delay_ms: p.val, ms: p.val })}
                      className={`px-2 py-0.5 rounded border transition ${
                        currentTotalMs === p.val
                          ? 'bg-purple-600 text-white border-purple-500 font-bold'
                          : 'bg-surface-tertiary text-foreground/85 border-border hover:text-foreground hover:bg-default-hover'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                  {currentTotalMs > 0 && (
                    <span className="text-muted ml-auto">
                      = {currentTotalMs.toLocaleString()} ms ({currentTotalMs >= 1000 ? `${(currentTotalMs / 1000).toFixed(1)}s` : `${currentTotalMs}ms`})
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px] items-end">
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-muted mb-1">Timeout (ms)</label>
                    <input
                      type="number"
                      value={act.timeout_ms || 10000}
                      onChange={e => onUpdate({ ...act, timeout_ms: parseInt(e.target.value) || 10000 })}
                      placeholder="10000 (10 seconds)"
                      className="w-full h-8 bg-surface-secondary border border-border rounded px-2 text-foreground font-mono box-border"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-muted mb-1">Check Interval (ms)</label>
                    <input
                      type="number"
                      value={act.interval_ms || 50}
                      onChange={e => onUpdate({ ...act, interval_ms: parseInt(e.target.value) || 50 })}
                      placeholder="50"
                      className="w-full h-8 bg-surface-secondary border border-border rounded px-2 text-foreground font-mono box-border"
                    />
                  </div>
                </div>

                {/* Target Condition in WAIT_FOR */}
                <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
                  <ConditionListEditor
                    conditions={condList}
                    depth={depth + 1}
                    label="Target Condition (e.g. Volume Up / Down or Key Pressed)"
                    emptyText="No target condition set (will proceed immediately)."
                    availableTriggers={availableTriggers}
                    catalog={catalog}
                    liveFrames={liveFrames}
                    entityStates={entityStates}
                    lastFiredTriggerId={lastFiredTriggerId}
                    liveWifiStatus={liveWifiStatus}
                    liveBleMap={liveBleMap}
                    onUpdate={updatedConds => {
                      onUpdate({
                        ...act,
                        conditions: updatedConds,
                        condition: updatedConds[0]
                      });
                    }}
                    onOpenAddConditionDialog={onOpenAddConditionDialog}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Repeat Until (Loop)
  if (act.type === 'repeat_until') {
    const condList = act.conditions && act.conditions.length > 0
      ? act.conditions
      : (act.condition ? [act.condition] : []);
    const loopIntervalMs = act.interval_ms ?? 1000;
    const safetyTimeoutMs = act.timeout_ms ?? 30000;

    return (
      <div
        {...cardDragProps}
        className={`p-2.5 sm:p-3 rounded-xl border border-warning/40 bg-warning-soft/20 space-y-3 text-xs transition-all min-w-0 overflow-hidden ${dragClass}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {dragHandle}
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted hover:text-foreground transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-warning-soft text-warning-soft-foreground border border-warning/40 flex items-center gap-1 min-w-0">
              <Repeat className="w-3 h-3 shrink-0" />
              <span className="truncate">REPEAT UNTIL (Loop)</span> {depth > 0 && `(L${depth + 1})`}
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {collapsed && (
          <div className="px-2.5 py-1.5 rounded-lg bg-surface-tertiary/70 border border-border/60 font-mono text-[11px] text-muted truncate">
            {formatActionSummary(act, catalog)}
          </div>
        )}

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px] items-end">
              <div className="flex flex-col justify-end">
                <label className="block text-[10px] font-sans text-muted mb-1">Loop Interval (ms)</label>
                <input
                  type="number"
                  min="20"
                  step="50"
                  value={loopIntervalMs}
                  onChange={e => onUpdate({ ...act, interval_ms: Math.max(20, parseInt(e.target.value) || 1000) })}
                  placeholder="1000"
                  className="w-full h-8 bg-surface-secondary border border-border rounded px-2 text-foreground font-mono box-border"
                />
              </div>
              <div className="flex flex-col justify-end">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[10px] font-sans text-muted">Safety Timeout (ms)</label>
                  <span className="text-[9px] text-muted font-mono">
                    {safetyTimeoutMs >= 1000 ? `${(safetyTimeoutMs / 1000).toFixed(1)}s max` : `${safetyTimeoutMs}ms`}
                  </span>
                </div>
                <input
                  type="number"
                  min="100"
                  step="500"
                  value={safetyTimeoutMs}
                  onChange={e => onUpdate({ ...act, timeout_ms: Math.max(100, parseInt(e.target.value) || 30000) })}
                  placeholder="30000"
                  className="w-full h-8 bg-surface-secondary border border-border rounded px-2 text-foreground font-mono box-border"
                />
              </div>
            </div>

            <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.sequence || []}
                depth={depth + 1}
                label="Repeat Actions (Loop Body)"
                emptyText="No actions in loop sequence."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedSeq => onUpdate({ ...act, sequence: updatedSeq })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>

            <div className="p-2 sm:p-2.5 rounded-lg bg-surface-secondary border border-border space-y-2 min-w-0 overflow-hidden">
              <ConditionListEditor
                conditions={condList}
                depth={depth + 1}
                label="Stop Condition (Repeat Until True)"
                emptyText="No stop condition set (will loop until timeout)."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onUpdate={updatedConds => {
                  onUpdate({
                    ...act,
                    conditions: updatedConds,
                    condition: updatedConds[0]
                  });
                }}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Regular action step rendering uses catalogCmd, matchedOption, hasOptions, and actionName declared above
  const effectiveCanId =
    act.can_id ||
    catalogCmd?.network?.action_can_id ||
    catalogCmd?.action_can_id ||
    catalogCmd?.network?.state_can_id ||
    catalogCmd?.state_can_id ||
    '';
  const effectiveBus = act.bus ?? catalogCmd?.network?.bus ?? catalogCmd?.action_bus ?? catalogCmd?.bus ?? 0;
  const effectiveRepeat =
    act.repeat !== undefined
      ? act.repeat
      : matchedOption?.repeat ?? (matchedOption?.steps && matchedOption.steps[0]?.repeat) ?? catalogCmd?.repeat ?? 1;
  const effectiveDelayMs =
    act.delay_ms !== undefined
      ? act.delay_ms
      : matchedOption?.delay_ms ??
        (matchedOption?.steps && matchedOption.steps[0]?.delay_ms) ??
        catalogCmd?.network?.delay_ms ??
        catalogCmd?.delay_ms ??
        0;

  const rawEffectivePayload =
    (typeof act.payload === 'object' && act.payload && Object.keys(act.payload).length > 0
      ? act.payload
      : typeof act.payload === 'string' && act.payload.trim() !== ''
      ? act.payload
      : undefined) ??
    matchedOption?.payload ??
    (matchedOption?.steps && matchedOption.steps[0]?.payload) ??
    catalogCmd?.payload;

  const effectivePayloadMap = compileToByteMap(rawEffectivePayload);
  const effectivePayload =
    Object.keys(effectivePayloadMap).length > 0
      ? effectivePayloadMap
      : typeof rawEffectivePayload === 'string'
      ? rawEffectivePayload
      : '';

  const effectiveSteps: AutomationActionStep[] | undefined = (() => {
    const rawList =
      act.steps && act.steps.length > 0
        ? act.steps
        : matchedOption?.steps && matchedOption.steps.length > 0
        ? matchedOption.steps
        : !matchedOption?.payload && catalogCmd?.steps && catalogCmd.steps.length > 0
        ? catalogCmd.steps
        : undefined;
    if (!rawList || rawList.length === 0) return undefined;
    return rawList.map((s, idx) => {
      const sMap = compileToByteMap(s.payload);
      const fallbackStepPayload =
        matchedOption?.steps?.[idx]?.payload ?? catalogCmd?.steps?.[idx]?.payload;
      const finalMap = Object.keys(sMap).length > 0 ? sMap : compileToByteMap(fallbackStepPayload);
      return {
        can_id: s.can_id || effectiveCanId || '0x000',
        bus: s.bus ?? effectiveBus,
        repeat: s.repeat ?? 1,
        delay_ms: s.delay_ms ?? 0,
        payload:
          Object.keys(finalMap).length > 0
            ? finalMap
            : typeof s.payload === 'string' && s.payload.trim() !== ''
            ? s.payload
            : ''
      };
    });
  })();

  const activeOptionLabel = (act.option_label || act.command || matchedOption?.label || '').toLowerCase().trim();

  const renderByteBoxes = (byteSource: any) => {
    const map = typeof byteSource === 'object' && byteSource !== null ? byteSource : compileToByteMap(byteSource);
    const keys = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
    return (
      <div className="grid grid-cols-8 gap-1 pt-1">
        {keys.map(k => {
          const val = map[k];
          const hasVal = val !== undefined && val !== '' && val !== '*';
          const isNonZero = hasVal && val !== '0x00' && val !== '00' && val !== '0';
          return (
            <div
              key={k}
              className={`flex flex-col items-center justify-center py-1 px-0.5 rounded border text-[10px] font-mono transition-colors ${
                isNonZero
                  ? 'bg-success-soft border-success/50 text-success-soft-foreground font-bold shadow-sm'
                  : hasVal
                  ? 'bg-surface-tertiary border-border text-foreground'
                  : 'bg-surface border-border text-muted/60'
              }`}
              title={`Byte ${k}: ${val || '*'}`}
            >
              <span className="text-[8px] text-muted leading-none mb-0.5">{k}</span>
              <span className="leading-none">{val || '*'}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      {...cardDragProps}
      className={`p-2.5 sm:p-3.5 rounded-xl bg-surface-secondary border border-border hover:border-border-secondary space-y-2.5 text-xs transition-all shadow-sm min-w-0 overflow-hidden ${dragClass}`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          {dragHandle}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="text-muted hover:text-foreground transition p-0.5 shrink-0"
          >
            {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <span className="w-5 h-5 rounded-full bg-success-soft text-success-soft-foreground font-bold text-[10px] flex items-center justify-center border border-success/40 shrink-0">
            A{index + 1}
          </span>
          <span className="font-semibold text-foreground text-xs sm:text-sm tracking-tight truncate">{actionName}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
          {hasCompactCatalogView && !collapsed && (
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition cursor-pointer ${
                showAdvanced
                  ? 'bg-success-soft text-success-soft-foreground border-success/50 shadow'
                  : 'bg-surface-tertiary text-foreground/85 hover:text-foreground border-border hover:bg-default-hover'
              }`}
              title="Toggle configuration details"
            >
              <Sliders className="w-3.5 h-3.5 text-success" />
              <span className="hidden xs:inline sm:inline">{showAdvanced ? 'Simple' : 'Details'}</span>
            </button>
          )}
          {actionButtons}
        </div>
      </div>

      {collapsed && (
        <div className="px-2.5 py-1.5 rounded-lg bg-surface-tertiary/70 border border-border/60 font-mono text-[11px] text-muted truncate">
          {formatActionSummary(act, catalog)}
        </div>
      )}

      {!collapsed && (
        <>

      {/* Option Selector Big Pills in Smart Grid Rows */}
      {hasPills && (
        <div className="space-y-1.5 pt-0.5">
          {groupOptionsIntoGridRows(catalogCmd.options).map((group, gIdx) => {
            const itemCount = group.items.length;
            const gridClass =
              itemCount === 1
                ? 'flex'
                : itemCount === 2
                ? 'grid grid-cols-2 gap-1.5'
                : itemCount === 3
                ? 'grid grid-cols-2 sm:grid-cols-3 gap-1.5'
                : itemCount === 4
                ? 'grid grid-cols-2 sm:grid-cols-4 gap-1.5'
                : 'grid grid-cols-2 sm:grid-cols-3 gap-1.5';

            return (
              <div key={group.key || gIdx} className={gridClass}>
                {group.items.map(({ opt, origIndex }) => {
                  const isSelected = activeOptionLabel
                    ? opt.label.toLowerCase().trim() === activeOptionLabel
                    : origIndex === 0;

                  return (
                    <button
                      key={opt.label || origIndex}
                      type="button"
                      onClick={() => {
                        const updated = applyOptionToAction(act, catalogCmd, opt);
                        onUpdate(updated);
                      }}
                      className={`${
                        itemCount === 1 ? 'px-4 min-w-[90px]' : 'w-full px-2'
                      } py-1.5 rounded-lg text-xs font-medium transition flex items-center justify-center gap-1.5 border cursor-pointer text-center ${
                        isSelected
                          ? 'bg-success-soft text-success-soft-foreground border-success/60 font-semibold shadow-sm ring-1 ring-success/30'
                          : 'bg-surface-tertiary text-foreground/85 hover:text-foreground hover:bg-default-hover border-border'
                      }`}
                    >
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {/* Numeric Range Setpoint Control for param_range actions */}
      {isRangeEntity && catalogCmd && (
        <NumericActionRangeControl
          act={act}
          catalogCmd={catalogCmd}
          effectiveCanId={effectiveCanId}
          effectiveBus={effectiveBus}
          effectivePayloadMap={effectivePayloadMap}
          liveFrames={liveFrames}
          entityStates={entityStates}
          onUpdate={onUpdate}
        />
      )}

      {/* Compact Catalog Action Card for 0-option catalog commands (e.g. surround_view_camera) */}
      {isCanTxAction && catalogCmd && !hasPills && !isRangeEntity && !showAdvanced && (
        <div className="p-2.5 rounded-lg bg-surface-tertiary/60 border border-border flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2 py-0.5 rounded bg-success-soft text-success-soft-foreground border border-success/40 font-semibold text-[10px] uppercase tracking-wider shrink-0">
              {catalogCmd.ha_metadata?.domain || 'Command'}
            </span>
            <span className="text-foreground/90 font-medium truncate">
              {act.popup_message || catalogCmd.popup_message || catalogCmd.ha_metadata?.name || catalogCmd.name}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted font-mono shrink-0">
            {effectiveCanId && <span>TX {formatCanId(effectiveCanId)}</span>}
            {effectiveSteps && effectiveSteps.length > 1 && (
              <span>· {effectiveSteps.length} steps</span>
            )}
          </div>
        </div>
      )}

      {/* Advanced Details View */}
      {(!hasCompactCatalogView || showAdvanced) && (() => {
        const isCanTx = isCanTxAction;
        const hasMultipleSteps = isCanTx && !!(effectiveSteps && effectiveSteps.length > 1);

        return (
        <div className={`space-y-3 ${hasCompactCatalogView ? 'pt-2.5 border-t border-separator' : ''}`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-muted">Action Type</label>
              <select
                value={isCanTx ? 'can_tx' : act.type === 'nav' ? 'hud_nav' : act.type}
                onChange={e => {
                  const nextType = e.target.value as AutomationAction['type'];
                  if (nextType === 'hud_nav') {
                    const {
                      source_command_id: _sci,
                      source_command_name: _scn,
                      entity_id: _eid,
                      target_command_id: _tci,
                      command: _cmd,
                      option_label: _ol,
                      can_id: _cid,
                      bus: _bus,
                      payload: _pay,
                      steps: _steps,
                      repeat: _rep,
                      delay_ms: _del,
                      popup_message: _pm,
                      ...rest
                    } = act as any;
                    onUpdate({
                      ...rest,
                      type: 'hud_nav',
                      nav_action: act.nav_action || (act.action === 'clear' ? 'clear' : 'update'),
                      icon: act.icon ?? 1,
                      distance_meters: act.distance_meters ?? 200,
                      bars: act.bars ?? 4,
                      speed_limit: act.speed_limit ?? 0,
                      camera_alert: !!act.camera_alert,
                      street: act.street ?? ''
                    });
                    return;
                  }
                  if (nextType !== 'can_tx' && nextType !== 'cycle_entity') {
                    const {
                      source_command_id: _sci,
                      source_command_name: _scn,
                      entity_id: _eid,
                      target_command_id: _tci,
                      command: _cmd,
                      option_label: _ol,
                      can_id: _cid,
                      payload: _pay,
                      steps: _steps,
                      ...rest
                    } = act as any;
                    onUpdate({ ...rest, type: nextType });
                    return;
                  }
                  onUpdate({ ...act, type: nextType });
                }}
                className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-sans"
              >
                <option value="can_tx">CAN Transmit</option>
                <option value="cycle_entity">Cyclic Stepper</option>
                <option value="hud_nav">HUD Turn-by-Turn Guidance</option>
                <option value="precondition">Battery Preconditioning (E-GMP)</option>
                <option value="climate_target">HVAC Temp Target</option>
                <option value="track_popup">Cluster Popup</option>
                <option value="delay">Wait / Delay</option>
                <option value="if_then">Conditional Branch</option>
                <option value="choose">Multiple Choices</option>
                <option value="repeat_until">Repeat Until (Loop)</option>
                {act.type === 'webhook' && (
                  <option value="webhook" disabled>Webhook (Unsupported on ESP32)</option>
                )}
              </select>
            </div>

            {(act.type === 'hud_nav' || act.type === 'nav') && (
              <HudNavActionConfig act={act} onUpdate={onUpdate} />
            )}

            {act.type === 'webhook' && (
              <div className="col-span-full p-2.5 rounded-lg bg-warning-soft border border-warning/40 text-warning-soft-foreground font-sans text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">Legacy Webhook Action Not Supported on ESP32 Firmware: </span>
                  <span>The ESP32 CAN engine runs 100% offline and does not execute HTTP webhooks. Switch Action Type above to a CAN action or use Home Assistant triggers via MQTT.</span>
                </div>
              </div>
            )}

            {act.type === 'precondition' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-muted">Operation</label>
                  <select
                    value={act.precon_action || 'start'}
                    onChange={e => onUpdate({ ...act, precon_action: e.target.value as any })}
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-sans"
                  >
                    <option value="start">Start Preconditioning</option>
                    <option value="stop">Stop / Cancel</option>
                    <option value="toggle">Toggle State</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-muted">Operating Mode</label>
                  <select
                    value={act.precon_mode || 'persistent'}
                    onChange={e => onUpdate({ ...act, precon_mode: e.target.value as any })}
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-warning font-medium font-sans"
                  >
                    <option value="persistent">Persistent (21°C / 70°F)</option>
                    <option value="continuous">Continuous (High Demand)</option>
                    <option value="once">Single Cycle (Once)</option>
                  </select>
                </div>
              </>
            )}

            {act.type === 'climate_target' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-muted">Zone</label>
                  <select
                    value={act.zone || 'driver'}
                    onChange={e => onUpdate({ ...act, zone: e.target.value as any })}
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-sans"
                  >
                    <option value="driver">Driver Zone</option>
                    <option value="passenger">Passenger Zone</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-sans text-muted">Target Temp</label>
                    <span className="text-[9px] text-accent font-mono">
                      {act.target_temp_c !== undefined || act.target_c !== undefined
                        ? `${Math.round(((act.target_temp_c ?? act.target_c ?? 21.0) * 9 / 5 + 32) * 10) / 10}°F`
                        : '--°F'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Slider
                      minValue={14}
                      maxValue={32}
                      step={0.5}
                      value={act.target_temp_c ?? act.target_c ?? 21.0}
                      onChange={val => {
                        const num = typeof val === 'number' ? val : val[0];
                        onUpdate({ ...act, target_temp_c: num, target_c: num });
                      }}
                      aria-label="Target Temperature Slider"
                      className="flex-1"
                    >
                      <Slider.Track className="h-1.5 bg-surface-tertiary rounded-full cursor-pointer relative">
                        <Slider.Fill className="bg-accent rounded-full h-full" />
                        <Slider.Thumb className="w-3.5 h-3.5 bg-accent border-2 border-surface rounded-full shadow cursor-grab active:cursor-grabbing focus:outline-none" />
                      </Slider.Track>
                    </Slider>
                    <div className="flex items-center gap-1 shrink-0 w-20">
                      <input
                        type="number"
                        step="0.5"
                        min="14"
                        max="32"
                        value={act.target_temp_c ?? act.target_c ?? ''}
                        onChange={e => {
                          const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                          onUpdate({ ...act, target_temp_c: val, target_c: val });
                        }}
                        placeholder="21.0"
                        className="w-full bg-surface-tertiary border border-border rounded px-2 py-0.5 text-accent font-bold text-xs"
                      />
                      <span className="text-muted font-sans text-[10px]">°C</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {(act.type === 'track_popup' || act.type === 'popup') && (() => {
              const popupText = act.text || act.popup_message || '';
              const totalToastChars = getClusterPopupTotalCodeUnits(popupText, true);
              const isOverClusterLimit = totalToastChars > CLUSTER_POPUP_MAX_CODE_UNITS;
              return (
                <>
                  <div>
                    <label className="block text-[10px] font-sans text-muted">Severity Level</label>
                    <select
                      value={act.level || 'info'}
                      onChange={e => onUpdate({ ...act, level: e.target.value as any })}
                      className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-sans"
                    >
                      <option value="info">Info</option>
                      <option value="warning">Warning</option>
                      <option value="error">Error</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="flex items-center justify-between">
                      <label className="block text-[10px] font-sans text-muted">Popup Text</label>
                      <span
                        className={`text-[9px] font-mono ${
                          isOverClusterLimit
                            ? 'text-danger font-bold'
                            : totalToastChars >= 45
                            ? 'text-warning font-semibold'
                            : 'text-muted'
                        }`}
                        title={`Includes 2-char severity icon prefix (max ${CLUSTER_POPUP_MAX_TEXT_CODE_UNITS} text chars = ${CLUSTER_POPUP_MAX_CODE_UNITS} total on cluster)`}
                      >
                        {totalToastChars}/{CLUSTER_POPUP_MAX_CODE_UNITS} (incl. icon)
                      </span>
                    </div>
                    <input
                      type="text"
                      maxLength={CLUSTER_POPUP_MAX_TEXT_CODE_UNITS}
                      value={popupText}
                      onChange={e => onUpdate({ ...act, text: e.target.value, popup_message: e.target.value })}
                      placeholder={`Message text (max ${CLUSTER_POPUP_MAX_TEXT_CODE_UNITS} chars)...`}
                      className={`w-full bg-surface-tertiary border rounded px-2 py-1 text-warning font-medium ${
                        isOverClusterLimit ? 'border-danger focus:outline-none focus:ring-1 focus:ring-danger' : 'border-border'
                      }`}
                    />
                    {isOverClusterLimit && (
                      <p className="text-[10px] font-sans text-danger mt-1">
                        Toast is {totalToastChars}/{CLUSTER_POPUP_MAX_CODE_UNITS} characters (including 2-char severity icon). Firmware drops popups over {CLUSTER_POPUP_MAX_CODE_UNITS} characters — shorten to ≤{CLUSTER_POPUP_MAX_TEXT_CODE_UNITS}.
                      </p>
                    )}
                  </div>
                </>
              );
            })()}

            {act.type === 'cycle_entity' && (
              <CycleEntityStepperConfig
                act={act}
                catalog={catalog}
                entityStates={entityStates}
                onUpdate={onUpdate}
              />
            )}

            {isCanTx && !hasMultipleSteps && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-muted">Target CAN ID</label>
                  <input
                    type="text"
                    value={effectiveCanId}
                    onChange={e => onUpdate({ ...act, can_id: e.target.value, type: 'can_tx' })}
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground"
                    placeholder="0x524"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-muted">Bus</label>
                  <select
                    value={effectiveBus}
                    onChange={e => onUpdate({ ...act, bus: parseInt(e.target.value) || 0, type: 'can_tx' })}
                    className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-foreground font-sans"
                  >
                    <option value={0}>Bus 0</option>
                    <option value={1}>Bus 1</option>
                    <option value={2}>Bus 2</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-muted">Repeat × Delay</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={effectiveRepeat}
                      onChange={e => onUpdate({ ...act, repeat: parseInt(e.target.value) || 1, type: 'can_tx' })}
                      className="w-12 bg-surface-tertiary border border-border rounded px-1.5 py-1 text-foreground"
                    />
                    <span className="text-muted font-sans">×</span>
                    <input
                      type="number"
                      value={effectiveDelayMs}
                      onChange={e => onUpdate({ ...act, delay_ms: parseInt(e.target.value) || 0, type: 'can_tx' })}
                      placeholder="ms"
                      className="w-16 bg-surface-tertiary border border-border rounded px-1.5 py-1 text-foreground"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {act.type === 'climate_target' && (
            <div className="flex items-center gap-4 pt-1 font-sans text-[11px] text-muted">
              <Switch
                isSelected={act.sync_on ?? true}
                onChange={(isSelected) => onUpdate({ ...act, sync_on: isSelected })}
                size="sm"
                aria-label="Sync Passenger Zone (0x4A0)"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <span>Sync Passenger Zone (0x4A0)</span>
                </Switch.Content>
              </Switch>
              <Switch
                isSelected={act.driver_only ?? false}
                onChange={(isSelected) => onUpdate({ ...act, driver_only: isSelected })}
                size="sm"
                aria-label="Driver Only"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <span>Driver Only</span>
                </Switch.Content>
              </Switch>
            </div>
          )}

          {isCanTx && !hasMultipleSteps && (
            <div className="space-y-2 font-mono text-[11px]">
              <div>
                <label className="block text-[10px] font-sans text-muted">Payload (1-based D1..D8)</label>
                <input
                  type="text"
                  value={
                    typeof effectivePayload === 'object' && effectivePayload && Object.keys(effectivePayload).length > 0
                      ? JSON.stringify(effectivePayload)
                      : typeof effectivePayload === 'string'
                      ? effectivePayload
                      : ''
                  }
                  onChange={e => {
                    const compiled = compileToByteMap(e.target.value);
                    onUpdate({ ...act, payload: Object.keys(compiled).length > 0 ? compiled : e.target.value, type: 'can_tx' });
                  }}
                  placeholder='{"D1":"0x02","D2":"0x01"}'
                  className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-success font-bold"
                />
                {renderByteBoxes(effectivePayload)}
              </div>
              <div className="flex items-center justify-between pt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    const currentStep: AutomationActionStep = {
                      can_id: effectiveCanId || '0x000',
                      bus: effectiveBus,
                      repeat: effectiveRepeat,
                      delay_ms: effectiveDelayMs || 20,
                      payload: effectivePayload || ''
                    };
                    const secondStep: AutomationActionStep = {
                      can_id: effectiveCanId || '0x000',
                      bus: effectiveBus,
                      repeat: 1,
                      delay_ms: 20,
                      payload: ''
                    };
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: [currentStep, secondStep]
                    });
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-surface-tertiary hover:bg-default-hover text-foreground border border-border transition cursor-pointer"
                >
                  <Plus className="w-3 h-3 text-success" />
                  <span>Add Step (Convert to Sequence)</span>
                </button>
              </div>
            </div>
          )}

          {/* Dedicated Multi-Step Sequence Editor */}
          {hasMultipleSteps && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between border-b border-separator pb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-success" />
                    Sequence Steps ({effectiveSteps!.length})
                  </span>
                  <span className="text-[10px] text-muted font-sans">Frames will transmit sequentially in order</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const newStep: AutomationActionStep = {
                      can_id: effectiveCanId || '0x000',
                      bus: effectiveBus,
                      repeat: 1,
                      delay_ms: 20,
                      payload: ''
                    };
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: [...effectiveSteps!, newStep]
                    });
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-success-soft text-success-soft-foreground border border-success/40 hover:bg-success/20 transition cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Step</span>
                </button>
              </div>

              <div className="space-y-2.5">
                {effectiveSteps!.map((step, sIdx) => {
                  const payloadStr = typeof step.payload === 'object' && step.payload && Object.keys(step.payload).length > 0
                    ? JSON.stringify(step.payload)
                    : (typeof step.payload === 'string' ? step.payload : '');

                  const updateStep = (patch: Partial<AutomationActionStep>) => {
                    const updatedSteps = effectiveSteps!.map((st, i) => (i === sIdx ? { ...st, ...patch } : st));
                    const isFirstStep = sIdx === 0;
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: updatedSteps,
                      ...(isFirstStep ? {
                        can_id: patch.can_id !== undefined ? patch.can_id : effectiveCanId,
                        bus: patch.bus !== undefined ? patch.bus : effectiveBus,
                        repeat: patch.repeat !== undefined ? patch.repeat : effectiveRepeat,
                        delay_ms: patch.delay_ms !== undefined ? patch.delay_ms : effectiveDelayMs,
                        payload: patch.payload !== undefined ? patch.payload : effectivePayload
                      } : {})
                    });
                  };

                  const removeStep = () => {
                    const updatedSteps = effectiveSteps!.filter((_, i) => i !== sIdx);
                    if (updatedSteps.length <= 1) {
                      const remaining = updatedSteps[0] || { can_id: effectiveCanId, bus: effectiveBus, payload: effectivePayload, repeat: effectiveRepeat, delay_ms: effectiveDelayMs };
                      onUpdate({
                        ...act,
                        type: 'can_tx',
                        steps: undefined,
                        can_id: remaining.can_id || effectiveCanId,
                        bus: remaining.bus ?? effectiveBus ?? 0,
                        repeat: remaining.repeat ?? effectiveRepeat ?? 1,
                        delay_ms: remaining.delay_ms ?? effectiveDelayMs ?? 0,
                        payload: remaining.payload || effectivePayload
                      });
                    } else {
                      onUpdate({
                        ...act,
                        type: 'can_tx',
                        steps: updatedSteps,
                        ...(sIdx === 0 ? {
                          can_id: updatedSteps[0].can_id,
                          bus: updatedSteps[0].bus,
                          repeat: updatedSteps[0].repeat,
                          delay_ms: updatedSteps[0].delay_ms,
                          payload: updatedSteps[0].payload
                        } : {})
                      });
                    }
                  };

                  const moveStep = (direction: -1 | 1) => {
                    const targetIdx = sIdx + direction;
                    if (targetIdx < 0 || targetIdx >= effectiveSteps!.length) return;
                    const reordered = [...effectiveSteps!];
                    const temp = reordered[sIdx];
                    reordered[sIdx] = reordered[targetIdx];
                    reordered[targetIdx] = temp;
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: reordered,
                      can_id: reordered[0].can_id,
                      bus: reordered[0].bus,
                      repeat: reordered[0].repeat,
                      delay_ms: reordered[0].delay_ms,
                      payload: reordered[0].payload
                    });
                  };

                  return (
                    <div key={sIdx} className="p-2.5 rounded-lg bg-surface-tertiary border border-border space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="w-5 h-5 rounded-full bg-success-soft text-success-soft-foreground font-bold text-[10px] flex items-center justify-center border border-success/40">
                            {sIdx + 1}
                          </span>
                          <span className="font-semibold text-foreground text-[11px] font-sans">Step {sIdx + 1} of {effectiveSteps!.length}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={sIdx === 0}
                            onClick={() => moveStep(-1)}
                            className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition cursor-pointer"
                            title="Move step up"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={sIdx === effectiveSteps!.length - 1}
                            onClick={() => moveStep(1)}
                            className="p-1 text-muted hover:text-foreground disabled:opacity-30 disabled:hover:text-muted transition cursor-pointer"
                            title="Move step down"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={removeStep}
                            className="p-1 text-muted hover:text-danger transition cursor-pointer ml-1"
                            title="Remove this step"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px]">
                        <div>
                          <label className="block text-[10px] font-sans text-muted">Target CAN ID</label>
                          <input
                            type="text"
                            value={step.can_id || ''}
                            onChange={e => updateStep({ can_id: e.target.value })}
                            className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground"
                            placeholder={effectiveCanId || "0x524"}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-sans text-muted">Bus</label>
                          <select
                            value={step.bus ?? 0}
                            onChange={e => updateStep({ bus: parseInt(e.target.value) || 0 })}
                            className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-foreground font-sans"
                          >
                            <option value={0}>Bus 0</option>
                            <option value={1}>Bus 1</option>
                            <option value={2}>Bus 2</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-sans text-muted">Repeat × Delay</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              value={step.repeat !== undefined ? step.repeat : 1}
                              onChange={e => updateStep({ repeat: parseInt(e.target.value) || 1 })}
                              className="w-12 bg-surface-secondary border border-border rounded px-1.5 py-1 text-foreground"
                            />
                            <span className="text-muted font-sans">×</span>
                            <input
                              type="number"
                              value={step.delay_ms !== undefined ? step.delay_ms : 0}
                              onChange={e => updateStep({ delay_ms: parseInt(e.target.value) || 0 })}
                              placeholder="ms"
                              className="w-16 bg-surface-secondary border border-border rounded px-1.5 py-1 text-foreground"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1 font-mono text-[11px]">
                        <label className="block text-[10px] font-sans text-muted">Step {sIdx + 1} Payload (1-based D1..D8)</label>
                        <input
                          type="text"
                          value={payloadStr}
                          onChange={e => {
                            const compiled = compileToByteMap(e.target.value);
                            updateStep({ payload: Object.keys(compiled).length > 0 ? compiled : e.target.value });
                          }}
                          placeholder='{"D1":"0x02","D2":"0x01"}'
                          className="w-full bg-surface-secondary border border-border rounded px-2 py-1 text-success font-bold"
                        />
                        {renderByteBoxes(step.payload)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        );
      })()}
        </>
      )}
    </div>
  );
}

export function ActionListEditor({
  actions,
  depth = 0,
  label,
  emptyText = 'No actions defined.',
  availableTriggers,
  catalog,
  liveFrames,
  entityStates,
  lastFiredTriggerId,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onOpenAddConditionDialog,
  onOpenAddActionDialog,
  onTestSingleAction
}: ActionListEditorProps) {
  const { clipboard, pasteFromClipboard } = useContext(AutomationClipboardContext);
  const listId = useId();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handlePasteAction = async () => {
    const pasted = await pasteFromClipboard('action');
    if (pasted) {
      onUpdate([...actions, pasted]);
    }
  };

  const addDefaultAction = () => {
    const next = [...actions];
    next.push({
      id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'can_tx',
      can_id: '',
      bus: 0,
      payload: '',
      repeat: 1,
      delay_ms: 0
    });
    onUpdate(next);
  };

  return (
    <div className="space-y-2 min-w-0">
      {label && (
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-success font-bold text-[11px] uppercase tracking-wider truncate">
            {label} ({actions.length})
          </span>
        </div>
      )}

      {actions.length === 0 ? (
        <div className="p-3 rounded-xl bg-surface-secondary/60 border border-dashed border-border text-center text-xs text-muted italic">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2 min-w-0">
                  {actions.map((act, idx) => {
                    const stableKey = act._clientId || (act._clientId = `act_client_${idx}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
                    return (
                      <ActionNodeEditor
                        key={stableKey}
                        act={act}
                        index={idx}
                        depth={depth}
                        availableTriggers={availableTriggers}
                        catalog={catalog}
                        liveFrames={liveFrames}
                        entityStates={entityStates}
                        lastFiredTriggerId={lastFiredTriggerId}
                        liveWifiStatus={liveWifiStatus}
                        liveBleMap={liveBleMap}
                        onTestSingleAction={onTestSingleAction}
                        onUpdate={updated => {
                          const next = [...actions];
                          next[idx] = { ...updated, _clientId: stableKey };
                          onUpdate(next);
                        }}
                        onDelete={() => {
                          const next = actions.filter((_, i) => i !== idx);
                          onUpdate(next);
                        }}
                        onDuplicate={() => {
                          const dup = regenerateActionIds(act);
                          const next = [...actions];
                          next.splice(idx + 1, 0, dup);
                          onUpdate(next);
                        }}
                        onMoveUp={idx > 0 ? () => {
                          onUpdate(arrayMove(actions, idx, idx - 1));
                        } : undefined}
                        onMoveDown={idx < actions.length - 1 ? () => {
                          onUpdate(arrayMove(actions, idx, idx + 1));
                        } : undefined}
                        isFirst={idx === 0}
                        isLast={idx === actions.length - 1}
                        onOpenAddConditionDialog={onOpenAddConditionDialog}
                        onOpenAddActionDialog={onOpenAddActionDialog}
                        dragConfig={
                          actions.length > 1
                            ? {
                                onDragStart: e => {
                                  e.stopPropagation();
                                  e.dataTransfer.effectAllowed = 'move';
                                  e.dataTransfer.setData('text/plain', `${listId}:${idx}`);
                                  setActiveScopedDrag({ listId, index: idx });
                                  setDragIdx(idx);
                                },
                                onDragOver: e => {
                                  const active = getActiveScopedDrag();
                                  if (active?.listId !== listId) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = 'move';
                                  if (dragOverIdx !== idx) {
                                    setDragOverIdx(idx);
                                  }
                                },
                                onDrop: e => {
                                  const active = getActiveScopedDrag();
                                  if (active?.listId !== listId) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (active.index !== idx) {
                                    onUpdate(arrayMove(actions, active.index, idx));
                                  }
                                  setActiveScopedDrag(null);
                                  setDragIdx(null);
                                  setDragOverIdx(null);
                                },
                                onDragEnd: () => {
                                  setActiveScopedDrag(null);
                                  setDragIdx(null);
                                  setDragOverIdx(null);
                                },
                                isDragging: dragIdx === idx,
                                isDragOver: dragOverIdx === idx && dragIdx !== idx
                              }
                            : undefined
                        }
                      />
                    );
                  })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mt-2">
        <button
          type="button"
          onClick={() => {
            if (onOpenAddActionDialog) {
              onOpenAddActionDialog(newAct => onUpdate([...actions, newAct]));
            } else {
              addDefaultAction();
            }
          }}
          className="ha-section-add-btn accent-act"
        >
          <Plus className="w-4 h-4" />
          <span>Add Action</span>
        </button>

        {clipboard?.type === 'action' && (
          <button
            type="button"
            onClick={() => {
              void handlePasteAction();
            }}
            className="ha-section-paste-btn bg-success-soft hover:bg-success/20 text-success-soft-foreground border border-success/40"
            title={`Paste copied action: "${clipboard.label}"`}
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-success" />
            <span>Paste Action ({clipboard.label})</span>
          </button>
        )}
      </div>
    </div>
  );
}
