import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Button,
} from '@heroui/react';
import { X, Radio, Check, Keyboard, Sparkles } from 'lucide-react';
import { deviceWs } from '../services/deviceWs';

interface BleButtonComboPickerProps {
  value: string;
  onChange: (val: string) => void;
  label?: string;
}

export const BUTTON_GROUPS = [
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
    ],
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
    ],
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
    ],
  },
] as const;

const BUTTON_LABEL_MAP: Record<string, string> = BUTTON_GROUPS.reduce(
  (acc, group) => {
    for (const btn of group.buttons) {
      acc[btn.id] = btn.label;
    }
    return acc;
  },
  {} as Record<string, string>
);

export function parseBleButtonTokens(value?: string): string[] {
  return (value || '')
    .split('+')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function getBleButtonFriendlyLabel(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized || normalized === 'any') return 'Any Button';
  if (BUTTON_LABEL_MAP[normalized]) return BUTTON_LABEL_MAP[normalized];
  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatBleButtonFriendlyName(value?: string): string {
  const tokens = parseBleButtonTokens(value).filter((t) => t !== 'any');
  if (tokens.length === 0) return 'Any Button';
  return tokens.map(getBleButtonFriendlyLabel).join(' + ');
}

export const BleButtonComboPicker: React.FC<BleButtonComboPickerProps> = ({
  value,
  onChange,
  label = 'Button or Multi-Button Combo Chord',
}) => {
  const [showPicker, setShowPicker] = useState(false);
  const [draftValue, setDraftValue] = useState<string>(value || 'any');
  const [isListening, setIsListening] = useState(false);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const showPickerRef = useRef(showPicker);
  showPickerRef.current = showPicker;

  // Keep draft synchronized when modal opens
  useEffect(() => {
    if (showPicker) {
      setDraftValue(value || 'any');
    }
  }, [showPicker, value]);

  useEffect(() => {
    if (!isListening) return;

    const unsubscribe = deviceWs.subscribe((msg) => {
      if (msg.type === 'ble_event' && msg.action !== 'release') {
        const captured = String(msg.combo || msg.button || msg.button_name || '')
          .trim()
          .toLowerCase();
        if (captured) {
          if (showPickerRef.current) {
            setDraftValue(captured);
          } else {
            onChangeRef.current(captured);
          }
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

  const currentTokens = parseBleButtonTokens(value);
  const activeTokens = currentTokens.filter((t) => t !== 'any');
  const friendlyDisplay = formatBleButtonFriendlyName(value);

  const draftTokens = parseBleButtonTokens(draftValue);
  const draftActiveTokens = draftTokens.filter((t) => t !== 'any');
  const isDraftAny = draftActiveTokens.length === 0;

  const toggleDraftButton = (btnId: string) => {
    let next: string[];
    if (draftActiveTokens.includes(btnId)) {
      next = draftActiveTokens.filter((t) => t !== btnId);
    } else {
      next = [...draftActiveTokens, btnId];
    }
    // Sort alphabetically so it matches the bridge's sorted combo format
    next.sort();
    setDraftValue(next.length > 0 ? next.join('+') : 'any');
  };

  const clearSelection = () => {
    onChange('any');
  };

  const handleApply = () => {
    const cleaned = parseBleButtonTokens(draftValue).filter((t) => t !== 'any');
    onChange(cleaned.length > 0 ? cleaned.join('+') : 'any');
    setShowPicker(false);
  };

  const handleClose = () => {
    setShowPicker(false);
  };

  return (
    <div className="space-y-1 font-sans">
      <div className="flex items-center justify-between gap-1.5">
        <label className="block text-[10px] text-muted font-medium truncate">{label}</label>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setIsListening((prev) => !prev)}
            title={
              isListening
                ? 'Cancel learning (pauses BLE button automations while active)'
                : 'Learn a physical Bluetooth button or combo press'
            }
            className={`inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded transition font-medium border ${
              isListening
                ? 'bg-warning text-warning-foreground border-warning animate-pulse'
                : 'bg-surface-tertiary text-foreground border-border hover:bg-default-hover'
            }`}
          >
            <Radio className="w-2.5 h-2.5" />
            <span>{isListening ? 'Learning...' : 'Learn'}</span>
          </button>
        </div>
      </div>

      {isListening && !showPicker && (
        <div className="text-[10px] text-warning bg-warning-soft border border-warning/30 rounded px-2 py-1">
          Press any Bluetooth button or combo on your remote... (BLE button automations paused)
        </div>
      )}

      {/* Active Selection Display (Click to open modal) */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <input
            type="text"
            readOnly
            value={friendlyDisplay}
            onClick={() => setShowPicker(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowPicker(true);
              }
            }}
            title="Click to select a button or build a multi-button combo"
            placeholder="Any Button"
            className="w-full bg-surface-secondary border border-border rounded px-2.5 pr-7 text-xs text-accent font-sans font-medium h-8 cursor-pointer hover:border-accent/60 focus:border-focus focus:outline-none box-border truncate"
          />
          {activeTokens.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                clearSelection();
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-0.5"
              title="Reset to Any Button"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Dedicated Button / Combo Picker Modal */}
      {showPicker && (
        <Modal isOpen={showPicker} onOpenChange={(open) => !open && handleClose()}>
          <ModalBackdrop className="bg-backdrop backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
            <ModalContainer className="w-full max-w-xl">
              <ModalDialog className="relative bg-overlay border border-border rounded-2xl shadow-overlay overflow-hidden p-0 flex flex-col">
                <ModalHeader className="px-5 py-4 border-b border-separator bg-surface">
                  <div className="flex items-center gap-2.5 pr-10">
                    <Keyboard className="w-4 h-4 text-accent shrink-0" />
                    <div>
                      <ModalHeading className="text-base font-bold text-foreground">
                        Select Button or Combo Chord
                      </ModalHeading>
                      <p className="text-xs text-muted mt-0.5">
                        Pick a single button, combine 2+ keys for a simultaneous chord, or learn directly from your remote.
                      </p>
                    </div>
                  </div>
                </ModalHeader>

                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  onPress={handleClose}
                  aria-label="Close modal"
                  className="absolute top-3.5 right-3.5 z-20 !rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border border-border/50 shadow-sm transition-colors"
                >
                  <X className="w-4 h-4" />
                </Button>

                <ModalBody className="p-5 space-y-4 text-sm text-foreground max-h-[70vh] overflow-y-auto">
                  {/* Current Selection Preview & Quick Controls */}
                  <div className="p-3 rounded-xl bg-surface-secondary border border-border space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                        Selected Input
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDraftValue('any')}
                          className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border font-medium transition ${
                            isDraftAny
                              ? 'bg-accent-soft border-accent text-accent-soft-foreground'
                              : 'bg-surface border-border text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          <Sparkles className="w-3 h-3" />
                          <span>Any Button</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsListening((prev) => !prev)}
                          title={
                            isListening
                              ? 'Cancel learning (pauses BLE button automations while active)'
                              : 'Learn a physical Bluetooth button or combo press'
                          }
                          className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border font-medium transition ${
                            isListening
                              ? 'bg-warning text-warning-foreground border-warning animate-pulse'
                              : 'bg-surface border-border text-foreground hover:bg-surface-tertiary'
                          }`}
                        >
                          <Radio className="w-3 h-3" />
                          <span>{isListening ? 'Learning...' : 'Learn'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 min-h-[28px]">
                      {isDraftAny ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-accent-soft border border-accent/40 text-accent-soft-foreground text-xs font-semibold">
                          Any Button
                        </span>
                      ) : (
                        draftActiveTokens.map((token, idx) => (
                          <React.Fragment key={token}>
                            {idx > 0 && <span className="text-xs font-bold text-muted">+</span>}
                            <button
                              type="button"
                              onClick={() => toggleDraftButton(token)}
                              title={`Remove ${getBleButtonFriendlyLabel(token)}`}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent text-accent-foreground text-xs font-semibold shadow-sm hover:opacity-90 transition"
                            >
                              <span>{getBleButtonFriendlyLabel(token)}</span>
                              <X className="w-3 h-3 opacity-80" />
                            </button>
                          </React.Fragment>
                        ))
                      )}
                      {draftActiveTokens.length > 1 && (
                        <span className="ml-auto px-2 py-0.5 rounded-md bg-surface border border-border text-[10px] font-mono text-muted">
                          {`${draftActiveTokens.length}-Key Chord`}
                        </span>
                      )}
                    </div>

                    {isListening && (
                      <div className="text-xs text-warning bg-warning-soft border border-warning/30 rounded-lg px-3 py-2">
                        Press any Bluetooth button or combo on your remote... (BLE button automations paused)
                      </div>
                    )}
                  </div>

                  {/* Categorized Button Pads */}
                  <div className="space-y-4">
                    {BUTTON_GROUPS.map((group) => (
                      <div key={group.name} className="space-y-2">
                        <div className="text-[11px] uppercase font-bold text-muted tracking-wider">
                          {group.name}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {group.buttons.map((b) => {
                            const isSelected = draftActiveTokens.includes(b.id);
                            return (
                              <button
                                key={b.id}
                                type="button"
                                onClick={() => toggleDraftButton(b.id)}
                                className={`px-3 py-2 rounded-xl text-xs font-medium border transition flex items-center justify-between gap-2 ${
                                  isSelected
                                    ? 'bg-accent text-accent-foreground border-accent font-semibold shadow-sm'
                                    : 'bg-surface-secondary text-foreground border-border hover:bg-surface-tertiary hover:border-border-secondary'
                                }`}
                              >
                                <span className="truncate">{b.label}</span>
                                {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Advanced Custom Raw ID Input */}
                  <div className="pt-3 border-t border-separator space-y-1.5">
                    <label className="block text-xs font-semibold text-muted">
                      Custom Button ID / Raw Combo (Advanced)
                    </label>
                    <input
                      type="text"
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value.toLowerCase())}
                      onBlur={() => {
                        if (!draftValue.trim()) {
                          setDraftValue('any');
                        }
                      }}
                      placeholder="any (or e.g. volume_up, key_1+key_2)"
                      className="w-full px-3 py-2 rounded-xl bg-surface-secondary border border-border text-foreground font-mono text-xs focus:outline-none focus:border-accent"
                    />
                  </div>
                </ModalBody>

                <ModalFooter className="px-5 py-3 border-t border-separator bg-surface flex items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => setDraftValue('any')}
                    isDisabled={isDraftAny}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium text-muted hover:text-foreground transition"
                  >
                    Reset to Any
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onPress={handleClose}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onPress={handleApply}
                      className="px-4 py-1.5 rounded-xl text-xs font-bold bg-accent hover:bg-accent-hover text-accent-foreground transition"
                    >
                      Apply
                    </Button>
                  </div>
                </ModalFooter>
              </ModalDialog>
            </ModalContainer>
          </ModalBackdrop>
        </Modal>
      )}
    </div>
  );
};
