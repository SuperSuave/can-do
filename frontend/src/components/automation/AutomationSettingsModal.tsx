import React, { useState, useEffect } from 'react';
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
  Slider
} from '@heroui/react';
import { X, Settings, Sliders, Shield, Tag } from 'lucide-react';
import { AutomationRule, ExecutionMode, TriggerCombineMode } from '../../types/automation';
import { HaToggleSwitch } from './HaToggleSwitch';

export interface AutomationSettingsModalProps {
  rule: AutomationRule | null;
  isOpen: boolean;
  onClose: () => void;
  onSaveSettings: (ruleId: string, updates: Partial<AutomationRule>) => void;
}

export const AutomationSettingsModal: React.FC<AutomationSettingsModalProps> = ({
  rule,
  isOpen,
  onClose,
  onSaveSettings
}) => {
  const [name, setName] = useState('');
  const [execMode, setExecMode] = useState<ExecutionMode>('one_shot');
  const [triggerMode, setTriggerMode] = useState<TriggerCombineMode>('any');
  const [cooldownMs, setCooldownMs] = useState(0);
  const [timeoutResetMs, setTimeoutResetMs] = useState(0);
  const [autoRevertSec, setAutoRevertSec] = useState(0);
  const [haExpose, setHaExpose] = useState(true);
  const [haIcon, setHaIcon] = useState('mdi:car-cog');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    if (rule) {
      setName(rule.name || '');
      setExecMode(rule.exec_mode || 'one_shot');
      setTriggerMode(rule.trigger_mode || 'any');
      setCooldownMs(rule.cooldown_ms || 0);
      setTimeoutResetMs(rule.timeout_reset_ms || 0);
      setAutoRevertSec(rule.auto_revert_sec || 0);
      setHaExpose(rule.ha_expose !== false);
      setHaIcon(rule.ha_icon || 'mdi:car-cog');
      setDescription(rule.description || '');
      setCategory(rule.category || '');
    }
  }, [rule]);

  if (!isOpen || !rule) return null;

  const handleSave = () => {
    onSaveSettings(rule.id, {
      name: name.trim() || rule.name,
      exec_mode: execMode,
      trigger_mode: triggerMode,
      cooldown_ms: Number(cooldownMs) || 0,
      timeout_reset_ms: Number(timeoutResetMs) || 0,
      auto_revert_sec: Number(autoRevertSec) || 0,
      ha_expose: haExpose,
      ha_icon: haIcon.trim() || 'mdi:car-cog',
      description: description.trim(),
      category: category.trim()
    });
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalBackdrop className="bg-black/80 backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <ModalContainer className="w-full max-w-lg">
          <ModalDialog className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <ModalHeader className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-950/70">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-cyan-400" />
                <ModalHeading className="text-base font-bold text-white">
                  Automation Settings
                </ModalHeading>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
                aria-label="Close modal"
              >
                <X className="w-5 h-5" />
              </button>
            </ModalHeader>

            <ModalBody className="p-5 space-y-4 overflow-y-auto text-sm text-slate-300">
              {/* Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Automation Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Auto Seat Warmer on Entry"
                  className="w-full px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Category
                </label>
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Comfort & Climate"
                  className="w-full px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>

              {/* Execution & Trigger Modes */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Execution Mode
                  </label>
                  <select
                    value={execMode}
                    onChange={(e) => setExecMode(e.target.value as ExecutionMode)}
                    className="w-full px-2.5 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                  >
                    <option value="one_shot">One Shot (Fire Once)</option>
                    <option value="toggle">Toggle (Flip State)</option>
                    <option value="continuous_hold">Continuous Hold</option>
                    <option value="on_change">On Change (State Diff)</option>
                    <option value="poll_verify">Poll & Verify</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Trigger Mode
                  </label>
                  <select
                    value={triggerMode}
                    onChange={(e) => setTriggerMode(e.target.value as TriggerCombineMode)}
                    className="w-full px-2.5 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                  >
                    <option value="any">Any Trigger (OR)</option>
                    <option value="all">All Triggers (AND)</option>
                    <option value="sequence">Sequence (In Order)</option>
                  </select>
                </div>
              </div>

              {/* Cooldown Slider */}
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-300">
                    Cooldown (Debounce)
                  </label>
                  <span className="text-xs font-mono text-cyan-400">
                    {cooldownMs} ms
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Slider
                    minValue={0}
                    maxValue={5000}
                    step={100}
                    value={cooldownMs}
                    onChange={(val) => {
                      const num = typeof val === 'number' ? val : val[0];
                      setCooldownMs(num);
                    }}
                    aria-label="Cooldown in milliseconds"
                    className="flex-1"
                  >
                    <Slider.Track className="h-1.5 bg-slate-800 rounded-full cursor-pointer relative">
                      <Slider.Fill className="bg-cyan-500 rounded-full h-full" />
                      <Slider.Thumb className="w-3.5 h-3.5 bg-cyan-400 border-2 border-slate-950 rounded-full shadow cursor-grab active:cursor-grabbing focus:outline-none" />
                    </Slider.Track>
                  </Slider>
                  <input
                    type="number"
                    min="0"
                    step="50"
                    value={cooldownMs}
                    onChange={(e) => setCooldownMs(parseInt(e.target.value) || 0)}
                    className="w-16 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 font-mono text-xs focus:outline-none focus:border-cyan-500 text-right"
                  />
                </div>
              </div>

              {/* Home Assistant Integration */}
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-slate-200">
                      Expose to Home Assistant
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Publishes MQTT discovery entity for dashboard switch & triggers
                    </div>
                  </div>
                  <HaToggleSwitch
                    checked={haExpose}
                    onChange={setHaExpose}
                    size="sm"
                    ariaLabel="Toggle Home Assistant exposure"
                  />
                </div>

                {haExpose && (
                  <div className="pt-2 border-t border-slate-800">
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Material Design Icon
                    </label>
                    <input
                      type="text"
                      value={haIcon}
                      onChange={(e) => setHaIcon(e.target.value)}
                      placeholder="mdi:car-cog"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 font-mono text-xs focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                )}
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Description / Documentation
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Optional notes or operational context for this automation..."
                  className="w-full px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500 resize-none"
                />
              </div>
            </ModalBody>

            <ModalFooter className="px-5 py-3 border-t border-slate-800/80 bg-slate-950/70 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onPress={onClose}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={handleSave}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition"
              >
                Save Settings
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
};
