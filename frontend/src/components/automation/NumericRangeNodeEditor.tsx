import React, { useState, useMemo } from 'react';
import { Thermometer, Gauge, Activity } from 'lucide-react';
import { AutomationCondition, AutomationTrigger } from '../../types/automation';
import { Command } from '../../types/catalog';
import {
  rawByteToPhysical,
  physicalToRawByte,
  getDefaultPhysicalValue,
  buildRangeActionPayload,
  normalizeByteKey
} from '../../utils/catalogUtils';
import { parseHexPayload } from './liveEvaluator';

export {
  rawByteToPhysical,
  physicalToRawByte,
  getDefaultPhysicalValue,
  buildRangeActionPayload
};

export interface NumericRangeNodeEditorProps {
  item: AutomationCondition | AutomationTrigger;
  catalogCmd?: Command;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  onUpdate: (updated: any) => void;
}

export const NumericRangeNodeEditor: React.FC<NumericRangeNodeEditorProps> = ({
  item,
  catalogCmd,
  liveFrames,
  entityStates,
  onUpdate
}) => {
  const net = catalogCmd?.network;
  const nativeUnit = net?.unit || '';
  const isTemperature = nativeUnit === '°C' || nativeUnit === '°F' || (catalogCmd?.id && catalogCmd.id.includes('temp'));
  const isTriggerItem = 'source' in item;

  // Local temperature unit preference for viewing/editing (°F vs °C)
  const [displayTempUnit, setDisplayTempUnit] = useState<'°F' | '°C'>(() => {
    return nativeUnit === '°F' ? '°F' : '°C';
  });

  const stateByte = normalizeByteKey(net?.state_byte || net?.byte || item.byte || 'D1');
  const stateCanId = net?.state_can_id || catalogCmd?.state_can_id || item.can_id || '0x000';
  const stateMask = net?.state_mask || net?.mask || (typeof item.mask === 'string' ? item.mask : undefined) || '0xFF';
  const byteIdx = useMemo(() => {
    const m = stateByte.match(/D(\d+)/i);
    return m ? Math.max(0, Math.min(7, parseInt(m[1], 10) - 1)) : 0;
  }, [stateByte]);

  // Decode raw value currently in condition / trigger, defaulting to mid/nominal setpoint if absent
  const rawVal = useMemo(() => {
    const rawCandidate =
      (item as any).value ??
      (item as any).evaluate?.value ??
      (item as any).to ??
      (item as any).to_value ??
      (item as any).match?.[stateByte];
    if (typeof rawCandidate === 'string' && rawCandidate.trim() !== '') {
      const parsed = rawCandidate.trim().startsWith('0x')
        ? parseInt(rawCandidate, 16)
        : parseInt(rawCandidate, 10);
      if (!isNaN(parsed)) return parsed;
    }
    if (typeof rawCandidate === 'number' && !isNaN(rawCandidate)) {
      return rawCandidate;
    }
    return physicalToRawByte(getDefaultPhysicalValue(net), net);
  }, [(item as any).value, (item as any).evaluate?.value, (item as any).to, (item as any).to_value, (item as any).match, stateByte, net]);

  const currentPhys = useMemo(() => {
    const res = rawByteToPhysical(isNaN(rawVal) ? 0 : rawVal, net);
    if (isTemperature) {
      if (nativeUnit === '°C' && displayTempUnit === '°F') {
        return Math.round((res.val * 1.8 + 32) * 10) / 10;
      } else if (nativeUnit === '°F' && displayTempUnit === '°C') {
        return Math.round(((res.val - 32) / 1.8) * 10) / 10;
      }
    }
    return res.val;
  }, [rawVal, net, isTemperature, nativeUnit, displayTempUnit]);

  // Read live telemetry from CAN frame or entity state
  const liveInfo = useMemo(() => {
    const cleanCanId = stateCanId.toLowerCase().replace(/^0x/, '');
    if (liveFrames && cleanCanId) {
      for (const [k, frame] of liveFrames.entries()) {
        if (k.toLowerCase().replace(/^0x/, '') === cleanCanId) {
          const bytes = parseHexPayload(frame.data);
          if (bytes && bytes.length > byteIdx) {
            const actByte = bytes[byteIdx];
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
              raw: actByte,
              physValue: displayVal,
              unit: isTemperature ? displayTempUnit : nativeUnit,
              formatted: `${displayVal} ${isTemperature ? displayTempUnit : nativeUnit}`
            };
          }
        }
      }
    }
    if (catalogCmd?.id && entityStates && entityStates.has(catalogCmd.id)) {
      return {
        formatted: entityStates.get(catalogCmd.id) || '',
        physValue: undefined,
        unit: nativeUnit
      };
    }
    return undefined;
  }, [liveFrames, entityStates, stateCanId, byteIdx, net, isTemperature, nativeUnit, displayTempUnit, catalogCmd?.id]);

  const updateNumericThreshold = (newPhysValue: number, newOp?: string) => {
    const op = newOp || (item as any).operator || (item as any).evaluate?.operator || 'equal';
    let nativePhys = newPhysValue;
    if (isTemperature) {
      if (nativeUnit === '°C' && displayTempUnit === '°F') {
        nativePhys = (newPhysValue - 32) / 1.8;
      } else if (nativeUnit === '°F' && displayTempUnit === '°C') {
        nativePhys = newPhysValue * 1.8 + 32;
      }
    }

    const calculatedRaw = physicalToRawByte(nativePhys, net);
    const hexVal = `0x${calculatedRaw.toString(16).toUpperCase().padStart(2, '0')}`;
    const displayUnit = isTemperature ? displayTempUnit : nativeUnit;
    const roundedDisplay = Math.round(newPhysValue * 10) / 10;
    const labelStr = `${roundedDisplay}${displayUnit}`;

    onUpdate({
      ...item,
      type: isTriggerItem ? 'byte_transition' : 'can_state',
      can_id: stateCanId,
      bus: net?.bus ?? (item as any).bus ?? 0,
      byte: stateByte,
      mask: stateMask,
      operator: op,
      value: hexVal,
      to: hexVal,
      to_value: calculatedRaw,
      match: { [stateByte]: hexVal },
      option_label: labelStr,
      ...(catalogCmd?.id ? { source_command_id: catalogCmd.id, target_entity_id: catalogCmd.id } : {}),
      evaluate: {
        byte: stateByte,
        byte_index: byteIdx,
        operator: op,
        value: hexVal,
        mask: stateMask
      }
    });
  };

  const currentOp = (item as any).operator || (item as any).evaluate?.operator || 'equal';
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

  return (
    <div className="space-y-2.5 p-3 rounded-lg bg-surface-secondary/70 border border-border">
      {/* Top Header: Physical bounds & Unit switch */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground/90">
          {isTemperature ? (
            <Thermometer className="w-4 h-4 text-danger" />
          ) : (
            <Gauge className="w-4 h-4 text-accent" />
          )}
          <span>Numeric Range Comparator</span>
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
                  ? 'bg-accent text-accent-foreground shadow-sm'
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
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              °C
            </button>
          </div>
        )}
      </div>

      {/* Main Comparator Control: Operator + Value Input + Steppers */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
        <div className="sm:col-span-5">
          <label className="block text-[10px] font-sans text-muted mb-1">Operator</label>
          <select
            value={currentOp}
            onChange={e => updateNumericThreshold(currentPhys, e.target.value)}
            className="w-full bg-surface-tertiary border border-border rounded px-2.5 py-1.5 text-foreground text-xs font-mono font-medium focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="less_than">&lt; (Less than / Below)</option>
            <option value="less_than_or_equal">&lt;= (At most / Up to)</option>
            <option value="greater_than">&gt; (Greater than / Above)</option>
            <option value="greater_than_or_equal">&gt;= (At least / From)</option>
            <option value="equal">== (Exactly Equal to)</option>
            <option value="not_equal">!= (Not Equal to)</option>
          </select>
        </div>

        <div className="sm:col-span-7">
          <label className="block text-[10px] font-sans text-muted mb-1">
            Threshold Value ({isTemperature ? displayTempUnit : nativeUnit})
          </label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => updateNumericThreshold(currentPhys - sliderStep, currentOp)}
              className="px-2.5 py-1.5 rounded bg-surface-tertiary hover:bg-default-hover border border-border text-foreground font-bold text-xs"
              title="Decrement step"
            >
              -
            </button>

            <input
              type="number"
              step={sliderStep}
              value={isNaN(currentPhys) ? '' : currentPhys}
              onChange={e => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  updateNumericThreshold(val, currentOp);
                }
              }}
              className="w-full bg-surface-tertiary border border-border rounded px-2.5 py-1.5 text-accent font-mono font-bold text-sm text-center focus:outline-none focus:ring-1 focus:ring-accent"
            />

            <button
              type="button"
              onClick={() => updateNumericThreshold(currentPhys + sliderStep, currentOp)}
              className="px-2.5 py-1.5 rounded bg-surface-tertiary hover:bg-default-hover border border-border text-foreground font-bold text-xs"
              title="Increment step"
            >
              +
            </button>

            <span className="text-xs font-bold text-muted px-1 shrink-0 font-sans">
              {isTemperature ? displayTempUnit : nativeUnit}
            </span>
          </div>
        </div>
      </div>

      {/* Interactive Range Slider when catalog bounds are defined */}
      {sliderMin !== undefined && sliderMax !== undefined && (
        <div className="flex items-center gap-2 pt-0.5">
          <span className="text-[10px] font-mono text-muted shrink-0">
            {sliderMin}{isTemperature ? displayTempUnit : nativeUnit}
          </span>
          <input
            type="range"
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            value={Math.max(sliderMin, Math.min(sliderMax, isNaN(currentPhys) ? sliderMin : currentPhys))}
            onChange={e => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) {
                updateNumericThreshold(val, currentOp);
              }
            }}
            aria-label="Numeric Range Threshold Slider"
            className="flex-1 accent-accent cursor-pointer h-1.5 rounded-lg"
          />
          <span className="text-[10px] font-mono text-muted shrink-0">
            {sliderMax}{isTemperature ? displayTempUnit : nativeUnit}
          </span>
        </div>
      )}

      {/* Live Telemetry Pill & Edge Evaluation Insight */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-separator text-[11px]">
        {liveInfo ? (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
            <span className="text-muted">Live Car Reading:</span>
            <span className="font-mono font-semibold text-foreground">{liveInfo.formatted}</span>
            {liveInfo.physValue !== undefined && (
              <button
                type="button"
                onClick={() => updateNumericThreshold(liveInfo.physValue!, currentOp)}
                className="ml-1 text-[10px] text-accent hover:underline font-mono flex items-center gap-0.5 cursor-pointer"
                title="Populate threshold with current vehicle live state"
              >
                📍 Use Current
              </button>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-muted flex items-center gap-1">
            <Activity className="w-3 h-3 text-muted" />
            <span>Awaiting CAN telemetry for {stateCanId}</span>
          </div>
        )}

        <div className="text-[10px] font-mono text-muted/80 ml-auto">
          ⚙️ Frame {stateCanId} · {stateByte} {currentOp} 0x{rawVal.toString(16).toUpperCase().padStart(2, '0')} ({rawVal})
        </div>
      </div>
    </div>
  );
};
