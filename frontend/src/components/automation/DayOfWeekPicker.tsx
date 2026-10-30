import React from 'react';

const ALL_DAYS = [
  { id: 'mon', label: 'Mon' },
  { id: 'tue', label: 'Tue' },
  { id: 'wed', label: 'Wed' },
  { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' },
  { id: 'sat', label: 'Sat' },
  { id: 'sun', label: 'Sun' },
];

export interface DayOfWeekPickerProps {
  selectedDays?: string[];
  onChange: (days: string[]) => void;
}

export function DayOfWeekPicker({
  selectedDays,
  onChange
}: DayOfWeekPickerProps) {
  const current = selectedDays && selectedDays.length > 0 ? selectedDays : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  const toggleDay = (dayId: string) => {
    if (current.includes(dayId)) {
      if (current.length === 1) return;
      onChange(current.filter(d => d !== dayId));
    } else {
      onChange([...current, dayId]);
    }
  };

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span className="font-semibold">Active Days</span>
        <div className="flex items-center gap-1 font-sans">
          <button
            type="button"
            onClick={() => onChange(['mon', 'tue', 'wed', 'thu', 'fri'])}
            className="hover:text-cyan-400 underline underline-offset-2"
          >
            Weekdays
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={() => onChange(['sat', 'sun'])}
            className="hover:text-cyan-400 underline underline-offset-2"
          >
            Weekends
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={() => onChange(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])}
            className="hover:text-cyan-400 underline underline-offset-2"
          >
            All
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {ALL_DAYS.map(d => {
          const active = current.includes(d.id);
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => toggleDay(d.id)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold transition border ${
                active
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              {d.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

