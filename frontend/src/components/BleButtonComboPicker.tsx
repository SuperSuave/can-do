import React, { useState } from 'react';
import { X } from 'lucide-react';

interface BleButtonComboPickerProps {
  value: string;
  onChange: (val: string) => void;
  label?: string;
}

const BUTTON_GROUPS = [
  {
    name: 'Media & Volume',
    buttons: [
      { id: 'volume_up', label: 'Vol +' },
      { id: 'volume_down', label: 'Vol -' },
      { id: 'mute', label: 'Mute' },
      { id: 'play_pause', label: 'Play/Pause' },
      { id: 'next_track', label: 'Next' },
      { id: 'prev_track', label: 'Prev' },
      { id: 'shutter', label: 'Shutter' },
    ]
  },
  {
    name: 'Macro Keypad (1 - 9)',
    buttons: [
      { id: 'key_1', label: 'Key 1' },
      { id: 'key_2', label: 'Key 2' },
      { id: 'key_3', label: 'Key 3' },
      { id: 'key_4', label: 'Key 4' },
      { id: 'key_5', label: 'Key 5' },
      { id: 'key_6', label: 'Key 6' },
      { id: 'key_7', label: 'Key 7' },
      { id: 'key_8', label: 'Key 8' },
      { id: 'key_9', label: 'Key 9' },
    ]
  },
  {
    name: 'Navigation & Standard Keys',
    buttons: [
      { id: 'enter', label: 'Enter' },
      { id: 'space', label: 'Space' },
      { id: 'escape', label: 'Esc' },
      { id: 'tab', label: 'Tab' },
      { id: 'arrow_up', label: 'Up' },
      { id: 'arrow_down', label: 'Down' },
      { id: 'arrow_left', label: 'Left' },
      { id: 'arrow_right', label: 'Right' },
    ]
  }
];

export const BleButtonComboPicker: React.FC<BleButtonComboPickerProps> = ({
  value,
  onChange,
  label = 'Button or Multi-Button Combo Chord'
}) => {
  const [showPicker, setShowPicker] = useState(false);

  // Parse currently active keys from value string (split on + and trim)
  const currentTokens = (value || '')
    .split('+')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  const toggleButton = (btnId: string) => {
    let next: string[];
    if (currentTokens.includes(btnId)) {
      next = currentTokens.filter(t => t !== btnId);
    } else {
      next = [...currentTokens, btnId];
    }
    // Sort alphabetically so it matches the bridge's sorted combo format
    next.sort();
    onChange(next.join('+'));
  };

  const clearSelection = () => {
    onChange('');
  };

  const isCombo = currentTokens.length > 1;

  return (
    <div className="space-y-1 font-sans">
      <div className="flex items-center justify-between">
        <label className="block text-[10px] text-slate-400 font-medium truncate">{label}</label>
        <button
          type="button"
          onClick={() => setShowPicker(!showPicker)}
          className={`text-[9px] px-2 py-0.5 rounded transition font-medium ${
            showPicker ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700'
          }`}
        >
          {showPicker ? 'Done Selecting' : 'Select / Build Combo'}
        </button>
      </div>

      {/* Active Selection Display */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <input
            type="text"
            value={value || ''}
            onChange={e => onChange(e.target.value.toLowerCase())}
            placeholder="e.g. volume_up, key_1+key_2, mute+volume_down"
            className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 text-xs text-blue-300 font-mono h-8 focus:border-blue-500 focus:outline-none box-border"
          />
          {value && (
            <button
              type="button"
              onClick={clearSelection}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 p-0.5"
              title="Clear"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {isCombo && (
          <span className="px-1.5 py-0.5 rounded bg-blue-950 text-blue-400 border border-blue-800 text-[10px] font-mono shrink-0">
            {currentTokens.length}-Key Chord
          </span>
        )}
      </div>

      {/* Interactive Button Pad */}
      {showPicker && (
        <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 space-y-2 mt-1 shadow-lg">
          <div className="text-[10px] text-slate-400 leading-tight">
            Click buttons to toggle. Select 2 or more to create a simultaneous combo chord:
          </div>

          {BUTTON_GROUPS.map(group => (
            <div key={group.name} className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">
                {group.name}
              </span>
              <div className="flex flex-wrap gap-1">
                {group.buttons.map(b => {
                  const isSelected = currentTokens.includes(b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleButton(b.id)}
                      className={`px-2 py-1 text-[11px] font-medium rounded transition border ${
                        isSelected
                          ? 'bg-blue-600 text-white border-blue-400 shadow-sm shadow-blue-500/30'
                          : 'bg-slate-800/90 text-slate-300 border-slate-700/60 hover:bg-slate-700 hover:text-white'
                      }`}
                    >
                      {b.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
