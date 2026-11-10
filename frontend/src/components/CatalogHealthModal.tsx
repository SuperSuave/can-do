import React, { useState } from 'react';
import { Catalog } from '../types/catalog';
import {
  Button,
  Chip,
  Badge,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Alert
} from '@heroui/react';
import { validateCatalog, getAllKnownFeatures } from '../utils/canValidator';
import {
  X,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Cpu,
  Layers,
  Car
} from 'lucide-react';

interface CatalogHealthModalProps {
  isOpen: boolean;
  onClose: () => void;
  catalog: Catalog;
}

export const CatalogHealthModal: React.FC<CatalogHealthModalProps> = ({
  isOpen,
  onClose,
  catalog
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const report = validateCatalog(catalog);
  const knownFeatures = Array.from(getAllKnownFeatures(catalog));

  // Check commands that use features
  const featuresWithCommands = new Set<string>();
  catalog.commands.forEach(c => {
    if (c.requires_feature) featuresWithCommands.add(c.requires_feature);
    c.options?.forEach(opt => {
      if (opt.requires_feature) featuresWithCommands.add(opt.requires_feature);
    });
  });

  const unusedFeatures = knownFeatures.filter(f => !featuresWithCommands.has(f));

  // Shared CAN IDs (multiplexed frames)
  const sharedCanIds = Object.entries(report.canIdGroups).filter(([_, cmds]) => cmds.length > 1);

  const handleCopyReport = () => {
    const text = `CAN Do Catalog Health Audit:
CAN Do Version: ${catalog.can_do_version || 'unknown'}
Status: ${report.isValid ? 'VALID' : 'HAS ERRORS'}
Total Commands: ${report.totalCommands}
Total Vehicles: ${catalog.vehicles.length}
Errors: ${report.errors.length}
Warnings: ${report.warnings.length}
Shared / Multiplexed CAN Frames: ${sharedCanIds.length}
`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-4 sm:p-6">
          <ModalDialog className="relative w-full max-w-2xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden my-auto p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="flex items-center justify-between p-5 border-b border-separator bg-surface gap-0">
              <div>
                <ModalHeading className="text-lg font-bold text-foreground flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-accent" />
                  Catalog Validation & Health Audit
                </ModalHeading>
                <p className="text-xs text-muted mt-0.5">
                  Comprehensive scan of CAN IDs, payload masks, multiplexing, and vehicle compatibility.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                onPress={onClose}
                aria-label="Close modal"
                className="p-1.5 text-muted hover:text-foreground rounded-full hover:bg-default-hover transition"
              >
                <X className="w-5 h-5" />
              </Button>
            </ModalHeader>

            {/* Content */}
            <ModalBody className="p-6 max-h-[70vh] overflow-y-auto space-y-5 text-xs">
          {/* Health Status Banner */}
          <Alert
            status={report.errors.length === 0 ? 'success' : 'danger'}
            className="p-4 rounded-[12px] border flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <Alert.Indicator className="shrink-0" />
              <Alert.Content>
                <Alert.Title className="text-sm font-bold text-foreground">
                  {report.errors.length === 0
                    ? 'Catalog Passed Validation Checks'
                    : `${report.errors.length} Critical Syntax Error(s) Found`}
                </Alert.Title>
                <Alert.Description className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <Chip
                    size="sm"
                    color={report.errors.length === 0 ? 'success' : 'danger'}
                    variant="soft"
                    className="font-bold text-[10.5px]"
                  >
                    {report.errors.length === 0 ? '0 Syntax Errors' : `${report.errors.length} Critical Errors`}
                  </Chip>
                  <Chip
                    size="sm"
                    color={report.warnings.length === 0 ? 'success' : 'warning'}
                    variant="soft"
                    className="font-medium text-[10.5px]"
                  >
                    {report.warnings.length} Warnings
                  </Chip>
                  <Chip
                    size="sm"
                    variant="secondary"
                    className="font-mono text-[10.5px]"
                  >
                    {catalog.commands.length} Commands Verified
                  </Chip>
                </Alert.Description>
              </Alert.Content>
            </div>

            <Button
              variant="outline"
              size="sm"
              onPress={handleCopyReport}
              className="dash-outline-btn px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 shrink-0 ml-3"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              Copy Audit
            </Button>
          </Alert>

          {/* Quick Metrics */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="p-2.5 rounded-[12px] bg-surface-secondary border border-border flex flex-col items-center gap-1">
              <div className="text-base font-bold text-foreground">{report.roleCounts.trigger}</div>
              <Badge size="sm" color="warning" variant="soft" className="text-[10px] font-semibold uppercase">
                Triggers
              </Badge>
            </div>
            <div className="p-2.5 rounded-[12px] bg-surface-secondary border border-border flex flex-col items-center gap-1">
              <div className="text-base font-bold text-foreground">{report.roleCounts.condition}</div>
              <Badge size="sm" color="accent" variant="soft" className="text-[10px] font-semibold uppercase">
                Conditions
              </Badge>
            </div>
            <div className="p-2.5 rounded-[12px] bg-surface-secondary border border-border flex flex-col items-center gap-1">
              <div className="text-base font-bold text-foreground">{report.roleCounts.action}</div>
              <Badge size="sm" color="success" variant="soft" className="text-[10px] font-semibold uppercase">
                Actions
              </Badge>
            </div>
            <div className="p-2.5 rounded-[12px] bg-surface-secondary border border-border flex flex-col items-center gap-1">
              <div className="text-base font-bold text-foreground">{catalog.vehicles.length}</div>
              <Badge size="sm" variant="secondary" className="text-[10px] font-semibold uppercase bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/40">
                Vehicles
              </Badge>
            </div>
          </div>

          {/* Errors list if any */}
          {report.errors.length > 0 && (
            <Alert status="danger" className="p-3.5 rounded-[12px] border text-danger-soft-foreground space-y-1.5">
              <Alert.Indicator />
              <Alert.Content className="w-full">
                <Alert.Title className="font-semibold flex items-center gap-1.5 text-danger">
                  Errors Requiring Fix:
                </Alert.Title>
                <Alert.Description className="space-y-1 block mt-1">
                  {report.errors.map((err, i) => (
                    <div key={i} className="pl-2">
                      • <strong className="font-mono text-foreground">{err.commandId}</strong>: {err.message}
                    </div>
                  ))}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {/* Shared / Multiplexed Frames */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-accent" />
                Multiplexed / Shared CAN Frames ({sharedCanIds.length})
              </span>
              <span className="text-[11px] text-muted">
                Expected for automotive sensor frames
              </span>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {sharedCanIds.map(([canIdKey, cmdNames]) => (
                <div
                  key={canIdKey}
                  className="p-2.5 rounded-[10px] bg-surface-secondary border border-border flex items-start justify-between gap-3"
                >
                  <div>
                    <span className="font-mono text-accent font-semibold">{canIdKey}</span>
                    <div className="text-[11px] text-muted mt-0.5">
                      {cmdNames.join(' • ')}
                    </div>
                  </div>
                  <Badge
                    size="sm"
                    variant="secondary"
                    className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-surface-tertiary text-muted border border-border shrink-0"
                  >
                    {cmdNames.length} commands
                  </Badge>
                </div>
              ))}
            </div>
          </div>

          {/* Feature Coverage */}
          <div>
            <span className="font-semibold text-foreground flex items-center gap-1.5 mb-2">
              <Car className="w-4 h-4 text-success" />
              Trim Feature Coverage ({featuresWithCommands.size} of {knownFeatures.length} features active)
            </span>
            <div className="p-3 rounded-[12px] bg-surface-secondary border border-border space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {knownFeatures.map(feat => {
                  const hasCmd = featuresWithCommands.has(feat);
                  return (
                    <Chip
                      key={feat}
                      size="sm"
                      color={hasCmd ? 'success' : 'default'}
                      variant={hasCmd ? 'soft' : 'secondary'}
                      className={`px-2 py-0.5 rounded-full text-[11px] font-mono ${
                        hasCmd
                          ? 'bg-success-soft text-success-soft-foreground border border-success/40'
                          : 'bg-surface-tertiary text-muted border border-border'
                      }`}
                    >
                      {feat} {hasCmd ? '✓' : '(No commands)'}
                    </Chip>
                  );
                })}
              </div>
              {unusedFeatures.length > 0 && (
                <p className="text-[11px] text-muted pt-1">
                  Features without commands: {unusedFeatures.join(', ')}. Contributors can submit new CAN triggers/actions for these!
                </p>
              )}
            </div>
          </div>
        </ModalBody>

        {/* Footer */}
        <ModalFooter className="flex items-center justify-end p-4 px-6 border-t border-separator bg-surface shrink-0">
          <Button
            variant="primary"
            size="sm"
            onPress={onClose}
            className="px-5 py-2 rounded-full text-xs font-semibold text-accent-foreground bg-accent hover:bg-accent-hover transition"
          >
            Close Audit
          </Button>
        </ModalFooter>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
