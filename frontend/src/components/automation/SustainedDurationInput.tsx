import React, { useId, useState, useEffect } from 'react';
import { Timer } from 'lucide-react';

interface SustainedDurationInputProps {
  forSec?: number;
  forMs?: number;
  onChange: (next: { for_sec?: number; for_ms?: number }) => void;
  label?: string;
}

export function formatSustainedBadge(forSec?: number, forMs?: number): string | null {
  const totalSec = (forSec || 0) + (forMs ? forMs / 1000 : 0);
  if (totalSec <= 0) return null;
  if (totalSec >= 60 && totalSec % 60 === 0) {
    return `${totalSec / 60}m`;
  }
  return `${Number.isInteger(totalSec) ? totalSec : totalSec.toFixed(1)}s`;
}

export const SustainedDurationInput: React.FC<SustainedDurationInputProps> = ({
  forSec,
  forMs,
  onChange,
  label = 'Sustained For (Optional)'
}) => {
  const inputId = useId();
  const unitId = useId();
  const totalSec = Math.round((forSec || 0) + (forMs ? forMs / 1000 : 0));

  const [unit, setUnit] = useState<'sec' | 'min'>(() =>
    totalSec >= 60 && totalSec % 60 === 0 ? 'min' : 'sec'
  );

  useEffect(() => {
    if (totalSec >= 60 && totalSec % 60 === 0) {
      setUnit('min');
    } else if (totalSec > 0 && totalSec < 60) {
      setUnit('sec');
    }
  }, [totalSec]);

  const displayVal = totalSec > 0
    ? (unit === 'min' ? String(Math.max(1, Math.round(totalSec / 60))) : String(totalSec))
    : '';

  const applyDigits = (rawDigits: string, targetUnit: 'sec' | 'min') => {
    const clean = rawDigits.replace(/\D+/g, '');
    if (!clean) {
      onChange({ for_sec: 0, for_ms: 0 });
      return;
    }
    const num = Math.min(86400, parseInt(clean, 10) || 0);
    const nextSec = num <= 0 ? 0 : (targetUnit === 'min' ? num * 60 : num);
    onChange({ for_sec: nextSec, for_ms: 0 });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-separator text-[11px] font-sans">
      <div className="flex items-center gap-1.5 text-muted">
        <Timer className="w-3.5 h-3.5 text-accent shrink-0" />
        <label htmlFor={inputId} className="text-[10px] font-medium text-muted">
          {label}
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={displayVal}
          placeholder="0 (Instant)"
          onChange={e => applyDigits(e.target.value, unit)}
          className="w-24 h-7 bg-surface-tertiary border border-border rounded px-2 text-xs text-accent font-mono text-center box-border focus:outline-none focus:border-focus"
        />
        <label htmlFor={unitId} className="sr-only">Duration unit</label>
        <select
          id={unitId}
          value={unit}
          onChange={e => {
            const nextUnit = e.target.value as 'sec' | 'min';
            setUnit(nextUnit);
            if (totalSec > 0) {
              const converted = nextUnit === 'min'
                ? Math.max(1, Math.round(totalSec / 60)) * 60
                : totalSec;
              onChange({ for_sec: converted, for_ms: 0 });
            }
          }}
          className="h-7 bg-surface-tertiary border border-border rounded px-1.5 text-[11px] text-foreground font-sans box-border focus:outline-none focus:border-focus"
        >
          <option value="sec">sec</option>
          <option value="min">min</option>
        </select>
      </div>
    </div>
  );
};

