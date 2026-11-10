import React, { useState } from 'react';
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
  X,
  Play,
  Copy,
  Check,
  Tag,
  Zap,
  Shield,
  Send,
  FileCode,
  Clock,
  Car
} from 'lucide-react';
import { AutomationRule } from '../../types/automation';
import { HaToggleSwitch } from './HaToggleSwitch';
import { TracesIcon } from './AutomationActionMenu';

interface AutomationMoreInfoModalProps {
  rule: AutomationRule | null;
  isOpen: boolean;
  onClose: () => void;
  onToggleEnabled?: (ruleId: string, enabled: boolean) => void;
  onRunActions?: (rule: AutomationRule) => void;
  onShowTraces?: (rule: AutomationRule) => void;
  onEditCategory?: (rule: AutomationRule) => void;
  onEditSettings?: (rule: AutomationRule) => void;
}

export const AutomationMoreInfoModal: React.FC<AutomationMoreInfoModalProps> = ({
  rule,
  isOpen,
  onClose,
  onToggleEnabled,
  onRunActions,
  onShowTraces,
  onEditCategory,
  onEditSettings
}) => {
  const [copiedJson, setCopiedJson] = useState(false);
  const [showJson, setShowJson] = useState(false);

  if (!isOpen || !rule) return null;

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(rule, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalBackdrop className="bg-black/80 backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <ModalContainer className="w-full max-w-lg">
          <ModalDialog className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <ModalHeader className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-950/70">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    rule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                  }`}
                />
                <ModalHeading className="text-base font-bold text-white truncate">
                  {rule.name || 'Automation Details'}
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
              {/* Primary Status Banner */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                <div className="flex items-center gap-3">
                  <HaToggleSwitch
                    checked={rule.enabled}
                    onChange={(checked) => onToggleEnabled && onToggleEnabled(rule.id, checked)}
                    ariaLabel="Toggle automation state"
                  />
                  <div>
                    <div className="font-semibold text-white text-sm">
                      {rule.enabled ? 'Automation is Active' : 'Automation is Disabled'}
                    </div>
                    <div className="text-xs text-slate-400 font-mono">
                      ID: {rule.id}
                    </div>
                  </div>
                </div>

                {rule.category ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onEditCategory && onEditCategory(rule);
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-950/70 text-cyan-300 border border-cyan-800/60 hover:bg-cyan-900/60 transition"
                  >
                    <Tag className="w-3 h-3" />
                    <span>{rule.category}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onEditCategory && onEditCategory(rule);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition"
                  >
                    <Tag className="w-3 h-3" />
                    <span>+ Add Category</span>
                  </button>
                )}
              </div>

              {/* Statistics & Engine Info */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2.5 rounded-xl bg-slate-950/50 border border-slate-800/80">
                  <div className="flex items-center justify-center gap-1 text-cyan-400 text-xs font-semibold mb-0.5">
                    <Zap className="w-3.5 h-3.5" />
                    <span>Triggers</span>
                  </div>
                  <div className="text-lg font-bold text-white font-mono">
                    {(rule.triggers || []).length}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/50 border border-slate-800/80">
                  <div className="flex items-center justify-center gap-1 text-amber-400 text-xs font-semibold mb-0.5">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Conditions</span>
                  </div>
                  <div className="text-lg font-bold text-white font-mono">
                    {(rule.conditions || []).length}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/50 border border-slate-800/80">
                  <div className="flex items-center justify-center gap-1 text-emerald-400 text-xs font-semibold mb-0.5">
                    <Send className="w-3.5 h-3.5" />
                    <span>Actions</span>
                  </div>
                  <div className="text-lg font-bold text-white font-mono">
                    {(rule.actions || []).length}
                  </div>
                </div>
              </div>

              {/* Execution Specs */}
              <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/80 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Execution Mode</span>
                  <span className="font-semibold text-slate-200 capitalize">
                    {rule.exec_mode?.replace('_', ' ') || 'One Shot'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Trigger Mode</span>
                  <span className="font-semibold text-slate-200 capitalize">
                    {rule.trigger_mode || 'any'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Cooldown</span>
                  <span className="font-mono text-cyan-300">
                    {rule.cooldown_ms || 0} ms
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Home Assistant Entity</span>
                  <span className="font-mono text-slate-300 truncate max-w-[220px]">
                    automation.cando_{rule.id.toLowerCase()}
                  </span>
                </div>
              </div>

              {rule.description && (
                <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/80 text-xs text-slate-300">
                  <div className="font-semibold text-slate-400 mb-1">Description</div>
                  <p className="leading-relaxed">{rule.description}</p>
                </div>
              )}

              {/* Collapsible JSON Preview */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowJson(!showJson)}
                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-300 transition"
                >
                  <FileCode className="w-3.5 h-3.5" />
                  <span>{showJson ? 'Hide JSON representation' : 'View JSON representation'}</span>
                </button>
                {showJson && (
                  <div className="mt-2 relative">
                    <pre className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-48">
                      {JSON.stringify(rule, null, 2)}
                    </pre>
                    <button
                      type="button"
                      onClick={handleCopyJson}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs transition"
                      title="Copy JSON"
                    >
                      {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
            </ModalBody>

            <ModalFooter className="px-5 py-3 border-t border-slate-800/80 bg-slate-950/70 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    onClose();
                    onRunActions && onRunActions(rule);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                >
                  <Play className="w-3.5 h-3.5 fill-current text-cyan-400" />
                  <span>Run actions</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    onClose();
                    onShowTraces && onShowTraces(rule);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                >
                  <TracesIcon className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Traces</span>
                </Button>
              </div>

              <Button
                variant="primary"
                size="sm"
                onPress={onClose}
                className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition"
              >
                Close
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
};
