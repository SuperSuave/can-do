import React, { useState, useEffect, useRef } from 'react';
import { X, Radio } from 'lucide-react';
import { deviceWs } from '../services/deviceWs';

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
  const [isListening, setIsListening] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!isListening) return;

    const unsubscribe = deviceWs.subscribe((msg) => {
      if (msg.type === 'ble_event' && msg.action !== 'release') {
        const captured = String(msg.combo || msg.button || msg.button_name || '').trim().toLowerCase();
        if (captured) {
          onChangeRef.current(captured);
          setIsListening(false);
        }
      }
    });

    deviceWs.send(JSON.stringify({ type: 'ble_learn', active: true, duration_ms: 30000 }));

    const timer = setTimeout(() => {
      setIsListening(false);
    }, 30000);

    return () => {
      clearTimeout(timer);
      unsubscribe();
      deviceWs.send(JSON.stringify({ type: 'ble_learn', active: false }));
    };
  }, [isListening]);

  // Parse currently active keys from value string (split on + and trim)
  const currentTokens = (value || '')
    .split('+')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  const toggleButton = (btnId: string) => {
    const activeKeys = currentTokens.filter(t => t !== 'any');
    let next: string[];
    if (activeKeys.includes(btnId)) {
      next = activeKeys.filter(t => t !== btnId);
    } else {
      next = [...activeKeys, btnId];
    }
    // Sort alphabetically so it matches the bridge's sorted combo format
    next.sort();
    onChange(next.length > 0 ? next.join('+') : 'any');
  };

  const clearSelection = () => {
    onChange('any');
  };

  const isCombo = currentTokens.length > 1;

  return (
    <div className="space-y-1 font-sans">
      <div className="flex items-center justify-between gap-1.5">
        <label className="block text-[10px] text-muted font-medium truncate">{label}</label>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setIsListening(prev => !prev)}
            title={isListening ? 'Cancel listening (pauses BLE button automations while active)' : 'Listen for a physical Bluetooth button or combo press'}
            className={`inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded transition font-medium border ${isListening
                ? 'bg-warning text-warning-foreground border-warning animate-pulse'
                : 'bg-surface-tertiary text-foreground border-border hover:bg-default-hover'
              }`}
          >
            <Radio className="w-2.5 h-2.5" />
            <span>{isListening ? 'Listening...' : 'Listen'}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowPicker(!showPicker)}
            className={`text-[9px] px-2 py-0.5 rounded transition font-medium ${showPicker ? 'bg-accent text-accent-foreground' : 'bg-surface-tertiary text-foreground border border-border hover:bg-default-hover'
              }`}
          >
            {showPicker ? 'Done Selecting' : 'Select / Build Combo'}
          </button>
        </div>
      </div>

      {isListening && (
        <div className="text-[10px] text-warning bg-warning-soft border border-warning/30 rounded px-2 py-1">
          Press any Bluetooth button or combo on your remote... (BLE button automations paused)
        </div>
      )}

      {/* Active Selection Display */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <input
            type="text"
            value={value ?? 'any'}
            onChange={e => onChange(e.target.value.toLowerCase())}
            onBlur={() => {
              if (!value || !value.trim()) {
                onChange('any');
              }
            }}
            placeholder="any (or e.g. volume_up, key_1+key_2)"
            className="w-full bg-surface-secondary border border-border rounded px-2.5 text-xs text-accent font-mono h-8 focus:border-focus focus:outline-none box-border"
          />
          {value && value !== 'any' && (
            <button
              type="button"
              onClick={clearSelection}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-0.5"
              title="Clear"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {isCombo && (
          <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-soft-foreground border border-accent/30 text-[10px] font-mono shrink-0">
            {currentTokens.length}-Key Chord
          </span>
        )}
      </div>

      {/* Interactive Button Pad */}
      {showPicker && (
        <div className="p-2.5 rounded-lg bg-overlay text-overlay-foreground border border-border space-y-2 mt-1 shadow-overlay">
          <div className="text-[10px] text-muted leading-tight">
            Click buttons to toggle. Select 2 or more to create a simultaneous combo chord:
          </div>

          {BUTTON_GROUPS.map(group => (
            <div key={group.name} className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-muted tracking-wider">
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
                      className={`px-2 py-1 text-[11px] font-medium rounded transition border ${isSelected
                          ? 'bg-accent text-accent-foreground border-accent shadow-sm'
                          : 'bg-surface-secondary text-foreground border-border hover:bg-default-hover'
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
