import React from 'react';
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
import { AlertTriangle, XCircle, X, ArrowUpRight, ArrowUp, CheckCircle2 } from 'lucide-react';
import { AutomationValidationReport, AutomationValidationIssue } from '../../utils/canValidator';

export interface PrePushValidationModalProps {
  report: AutomationValidationReport | null;
  isOpen: boolean;
  onClose: () => void;
  onJumpToRule: (ruleId: string) => void;
  onPushAnyway: () => void;
}

const SECTION_LABELS: Record<AutomationValidationIssue['section'], string> = {
  general: 'Rule',
  trigger: 'Trigger',
  condition: 'Condition',
  action: 'Action'
};

export const PrePushValidationModal: React.FC<PrePushValidationModalProps> = ({
  report,
  isOpen,
  onClose,
  onJumpToRule,
  onPushAnyway
}) => {
  if (!isOpen || !report) return null;

  const errorCount = report.errors.length;
  const warningCount = report.warnings.length;
  const hasErrors = errorCount > 0;
  const groupedEntries = Object.entries(report.issuesByRuleId);

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalBackdrop className="bg-backdrop backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <ModalContainer className="w-full max-w-2xl">
          <ModalDialog className="relative bg-overlay border border-border rounded-2xl shadow-overlay overflow-hidden p-0 flex flex-col max-h-[90vh]">
            <ModalHeader className="px-5 py-4 border-b border-separator bg-surface">
              <div className="flex items-start gap-3 pr-10">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                    hasErrors
                      ? 'bg-danger-soft text-danger border-danger/30'
                      : 'bg-warning-soft text-warning border-warning/30'
                  }`}
                >
                  {hasErrors ? (
                    <XCircle className="w-5 h-5" />
                  ) : (
                    <AlertTriangle className="w-5 h-5" />
                  )}
                </div>
                <div className="min-w-0">
                  <ModalHeading className="text-base font-bold text-foreground">
                    Pre-Push Validation Check
                  </ModalHeading>
                  <p className="text-xs text-muted mt-0.5">
                    {errorCount > 0 && (
                      <span className="text-danger font-semibold">
                        {errorCount} error{errorCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {errorCount > 0 && warningCount > 0 && ' and '}
                    {warningCount > 0 && (
                      <span className="text-warning font-semibold">
                        {warningCount} warning{warningCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {' '}found across {groupedEntries.length} rule{groupedEntries.length !== 1 ? 's' : ''}.
                  </p>
                </div>
              </div>
            </ModalHeader>

            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={onClose}
              aria-label="Close validation modal"
              className="absolute top-3.5 right-3.5 z-20 !rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border border-border/50 shadow-sm transition-colors"
            >
              <X className="w-4 h-4" />
            </Button>

            <ModalBody className="p-5 space-y-3 overflow-y-auto text-sm text-foreground bg-surface-secondary/40">
              {groupedEntries.length === 0 ? (
                <div className="p-6 text-center text-muted flex flex-col items-center gap-2">
                  <CheckCircle2 className="w-8 h-8 text-success" />
                  <span>All rules look valid and ready to push!</span>
                </div>
              ) : (
                groupedEntries.map(([ruleId, ruleIssues]) => {
                  const ruleName = ruleIssues[0]?.ruleName || ruleId;
                  const ruleErrors = ruleIssues.filter(i => i.type === 'error').length;
                  const ruleWarnings = ruleIssues.filter(i => i.type === 'warning').length;

                  return (
                    <div
                      key={ruleId}
                      className="rounded-xl border border-border bg-surface overflow-hidden shadow-xs"
                    >
                      <div className="px-3.5 py-2.5 bg-surface-secondary/70 border-b border-separator flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-2">
                          <span className="font-semibold text-xs sm:text-sm text-foreground truncate">
                            {ruleName}
                          </span>
                          {ruleErrors > 0 && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-danger-soft text-danger border border-danger/30 shrink-0">
                              {ruleErrors} err
                            </span>
                          )}
                          {ruleWarnings > 0 && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-warning-soft text-warning border border-warning/30 shrink-0">
                              {ruleWarnings} warn
                            </span>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onPress={() => onJumpToRule(ruleId)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-surface hover:bg-default-hover text-foreground border border-border shrink-0 cursor-pointer"
                        >
                          <span>Jump to Rule</span>
                          <ArrowUpRight className="w-3.5 h-3.5 text-accent" />
                        </Button>
                      </div>

                      <div className="divide-y divide-separator">
                        {ruleIssues.map((issue, idx) => (
                          <div
                            key={`${ruleId}-${idx}`}
                            className="px-3.5 py-2.5 flex items-start gap-2.5 text-xs"
                          >
                            {issue.type === 'error' ? (
                              <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                            )}
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded ${
                                    issue.type === 'error'
                                      ? 'bg-danger-soft/70 text-danger'
                                      : 'bg-warning-soft/70 text-warning'
                                  }`}
                                >
                                  {SECTION_LABELS[issue.section]}
                                </span>
                                {issue.field && (
                                  <span className="text-[10px] font-mono text-muted">
                                    {issue.field}
                                  </span>
                                )}
                              </div>
                              <p className="text-foreground/95 leading-snug">
                                {issue.message}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </ModalBody>

            <ModalFooter className="px-5 py-3.5 border-t border-separator bg-surface flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted">
                {hasErrors
                  ? 'Errors may prevent affected rules or steps from executing on the ESP32.'
                  : 'Warnings are advisory only and will still run on the ESP32.'}
              </p>
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onPress={onClose}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition cursor-pointer"
                >
                  Back to Editor
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onPress={onPushAnyway}
                  className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                    hasErrors
                      ? 'bg-danger hover:bg-danger/90 text-white'
                      : 'bg-warning hover:bg-warning-hover text-warning-foreground'
                  }`}
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                  <span>Push Anyway</span>
                </Button>
              </div>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
};
