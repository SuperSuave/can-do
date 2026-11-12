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
      <ModalBackdrop className="bg-backdrop backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <ModalContainer className="w-full max-w-lg">
          <ModalDialog className="relative bg-overlay border border-border rounded-2xl shadow-overlay overflow-hidden flex flex-col max-h-[90vh]">
            <ModalHeader className="px-5 py-4 border-b border-separator bg-surface">
              <div className="flex items-center gap-2.5 min-w-0 pr-10">
                <span
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    rule.enabled ? 'bg-success' : 'bg-muted/50'
                  }`}
                />
                <ModalHeading className="text-base font-bold text-foreground truncate">
                  {rule.name || 'Automation Details'}
                </ModalHeading>
              </div>
            </ModalHeader>

            {/* Upper Right Close Button */}
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={onClose}
              aria-label="Close modal"
              className="absolute top-3.5 right-3.5 z-20 !rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border border-border/50 shadow-sm transition-colors"
            >
              <X className="w-4 h-4" />
            </Button>

            <ModalBody className="p-5 space-y-4 overflow-y-auto text-sm text-foreground">
              {/* Primary Status Banner */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-surface-secondary border border-border">
                <div className="flex items-center gap-3">
                  <HaToggleSwitch
                    checked={rule.enabled}
                    onChange={(checked) => onToggleEnabled && onToggleEnabled(rule.id, checked)}
                    ariaLabel="Toggle automation state"
                  />
                  <div>
                    <div className="font-semibold text-foreground text-sm">
                      {rule.enabled ? 'Automation is Active' : 'Automation is Disabled'}
                    </div>
                    <div className="text-xs text-muted font-mono">
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
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-accent-soft text-accent-soft-foreground border border-accent/30 hover:bg-accent/20 transition"
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
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-muted hover:text-accent hover:bg-surface-tertiary transition"
                  >
                    <Tag className="w-3 h-3" />
                    <span>+ Add Category</span>
                  </button>
                )}
              </div>

              {/* Statistics & Engine Info */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2.5 rounded-xl bg-surface-secondary border border-border">
                  <div className="flex items-center justify-center gap-1 text-warning text-xs font-semibold mb-0.5">
                    <Zap className="w-3.5 h-3.5" />
                    <span>Triggers</span>
                  </div>
                  <div className="text-lg font-bold text-foreground font-mono">
                    {(rule.triggers || []).length}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-surface-secondary border border-border">
                  <div className="flex items-center justify-center gap-1 text-accent text-xs font-semibold mb-0.5">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Conditions</span>
                  </div>
                  <div className="text-lg font-bold text-foreground font-mono">
                    {(rule.conditions || []).length}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-surface-secondary border border-border">
                  <div className="flex items-center justify-center gap-1 text-success text-xs font-semibold mb-0.5">
                    <Send className="w-3.5 h-3.5" />
                    <span>Actions</span>
                  </div>
                  <div className="text-lg font-bold text-foreground font-mono">
                    {(rule.actions || []).length}
                  </div>
                </div>
              </div>

              {/* Execution Specs */}
              <div className="p-3 rounded-xl bg-surface-secondary border border-border space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Execution Mode</span>
                  <span className="font-semibold text-foreground capitalize">
                    {rule.exec_mode?.replace('_', ' ') || 'One Shot'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Trigger Mode</span>
                  <span className="font-semibold text-foreground capitalize">
                    {rule.trigger_mode || 'any'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Cooldown</span>
                  <span className="font-mono text-accent">
                    {rule.cooldown_ms || 0} ms
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Home Assistant Entity</span>
                  <span className="font-mono text-foreground truncate max-w-[220px]">
                    automation.cando_{rule.id.toLowerCase()}
                  </span>
                </div>
              </div>

              {rule.description && (
                <div className="p-3 rounded-xl bg-surface-secondary border border-border text-xs text-foreground">
                  <div className="font-semibold text-muted mb-1">Description</div>
                  <p className="leading-relaxed">{rule.description}</p>
                </div>
              )}

              {/* Collapsible JSON Preview */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowJson(!showJson)}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition"
                >
                  <FileCode className="w-3.5 h-3.5" />
                  <span>{showJson ? 'Hide JSON representation' : 'View JSON representation'}</span>
                </button>
                {showJson && (
                  <div className="mt-2 relative">
                    <pre className="p-3 bg-surface-secondary rounded-xl border border-border text-[11px] font-mono text-foreground overflow-x-auto max-h-48">
                      {JSON.stringify(rule, null, 2)}
                    </pre>
                    <button
                      type="button"
                      onClick={handleCopyJson}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface-tertiary hover:bg-default-hover text-foreground border border-border text-xs transition"
                      title="Copy JSON"
                    >
                      {copiedJson ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
            </ModalBody>

            <ModalFooter className="px-5 py-3 border-t border-separator bg-surface flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    onClose();
                    onRunActions && onRunActions(rule);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition"
                >
                  <Play className="w-3.5 h-3.5 fill-current text-accent" />
                  <span>Run actions</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    onClose();
                    onShowTraces && onShowTraces(rule);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition"
                >
                  <TracesIcon className="w-3.5 h-3.5 text-accent" />
                  <span>Traces</span>
                </Button>
              </div>

              <Button
                variant="primary"
                size="sm"
                onPress={onClose}
                className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-accent hover:bg-accent-hover text-accent-foreground transition"
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
