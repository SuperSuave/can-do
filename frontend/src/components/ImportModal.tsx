import React, { useState } from 'react';
import { Catalog, Command, Vehicle } from '../types/catalog';
import { validateCatalog, validateCommand } from '../utils/canValidator';
import { normalizeCatalog } from '../data/defaultCatalog';
import { parseDbc, DbcParseStats } from '../utils/dbcConverter';
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter
} from '@heroui/react';
import {
  X,
  Upload,
  FileCode,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
  Cpu,
  Sparkles
} from 'lucide-react';

interface ImportModalProps {
  isOpen: boolean;
  currentCatalog: Catalog;
  onClose: () => void;
  onImport: (importedCatalog: Catalog, mode: 'merge' | 'replace') => void;
}

interface DiffAnalysis {
  newCommands: Command[];
  modifiedCommands: { original: Command; updated: Command }[];
  unchangedCount: number;
  newVehicles: Vehicle[];
  totalImported: number;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  currentCatalog,
  onClose,
  onImport
}) => {
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<Catalog | null>(null);
  const [diff, setDiff] = useState<DiffAnalysis | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [dbcStats, setDbcStats] = useState<DbcParseStats | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<'json' | 'dbc' | null>(null);

  if (!isOpen) return null;

  const analyzeDiff = (incoming: Catalog) => {
    const existingCmdMap = new Map<string, Command>();
    currentCatalog.commands.forEach(c => existingCmdMap.set(c.id, c));

    const newCmds: Command[] = [];
    const modifiedCmds: { original: Command; updated: Command }[] = [];
    let unchanged = 0;

    incoming.commands.forEach(cmd => {
      const existing = existingCmdMap.get(cmd.id);
      if (!existing) {
        newCmds.push(cmd);
      } else {
        const isDifferent = JSON.stringify(existing) !== JSON.stringify(cmd);
        if (isDifferent) {
          modifiedCmds.push({ original: existing, updated: cmd });
        } else {
          unchanged++;
        }
      }
    });

    const existingVehicles = new Set(currentCatalog.vehicles.map(v => v.id));
    const newVehicles = incoming.vehicles.filter(v => !existingVehicles.has(v.id));

    setDiff({
      newCommands: newCmds,
      modifiedCommands: modifiedCmds,
      unchangedCount: unchanged,
      newVehicles,
      totalImported: incoming.commands.length
    });
  };

  const handleProcessRaw = (raw: string) => {
    setError(null);
    setParsedData(null);
    setDiff(null);
    setDbcStats(null);
    setDetectedFormat(null);

    if (!raw.trim()) {
      return;
    }

    // Auto-detect Vector DBC file format
    const isDbc =
      raw.includes('BO_ ') ||
      raw.includes('VERSION ""') ||
      raw.includes('NS_ :') ||
      raw.includes('BS_:');

    if (isDbc) {
      setDetectedFormat('dbc');
      try {
        const { catalog: dbcCatalog, stats: parsedStats, issues } = parseDbc(raw);
        if (dbcCatalog.commands.length === 0) {
          throw new Error(
            'DBC file was parsed, but no valid signals (SG_) or messages (BO_) could be converted into CAN Do commands.'
          );
        }
        setDbcStats(parsedStats);
        setParsedData(dbcCatalog);
        analyzeDiff(dbcCatalog);
      } catch (err: any) {
        setError(err.message || 'Failed to parse DBC file.');
      }
      return;
    }

    // Otherwise parse JSON
    setDetectedFormat('json');
    try {
      const parsed = JSON.parse(raw);
      let catalogCandidate: Catalog;

      // Handle full catalog object
      const incomingVer = parsed.can_do_version;
      if (incomingVer && Array.isArray(parsed.commands)) {
        catalogCandidate = {
          can_do_version: incomingVer,
          vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : currentCatalog.vehicles,
          commands: parsed.commands
        };
      }
      // Handle array of commands
      else if (Array.isArray(parsed)) {
        catalogCandidate = {
          can_do_version: currentCatalog.can_do_version,
          vehicles: currentCatalog.vehicles,
          commands: parsed
        };
      }
      // Handle single command object
      else if (parsed.id && parsed.name) {
        catalogCandidate = {
          can_do_version: currentCatalog.can_do_version,
          vehicles: currentCatalog.vehicles,
          commands: [parsed]
        };
      } else {
        throw new Error(
          'Unrecognized JSON structure. Expected a CAN Do catalog object with "can_do_version" & "commands", or an array of command objects.'
        );
      }

      catalogCandidate = normalizeCatalog(catalogCandidate);

      // Basic validation
      const report = validateCatalog(catalogCandidate);
      if (report.errors.length > 0) {
        const sampleErrors = report.errors.slice(0, 3).map(e => e.message).join('; ');
        setError(`Catalog schema errors: ${sampleErrors}`);
      }

      setParsedData(catalogCandidate);
      analyzeDiff(catalogCandidate);
    } catch (err: any) {
      setError(err.message || 'Invalid JSON syntax.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = event => {
      const content = event.target?.result as string;
      setJsonText(content);
      handleProcessRaw(content);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = event => {
        const content = event.target?.result as string;
        setJsonText(content);
        handleProcessRaw(content);
      };
      reader.readAsText(file);
    }
  };

  const handleApply = (mode: 'merge' | 'replace') => {
    if (!parsedData) return;

    if (mode === 'replace') {
      onImport(parsedData, 'replace');
    } else {
      // Merge
      const cmdMap = new Map<string, Command>();
      currentCatalog.commands.forEach(c => cmdMap.set(c.id, c));
      parsedData.commands.forEach(c => cmdMap.set(c.id, c));

      const vehicleMap = new Map<string, Vehicle>();
      currentCatalog.vehicles.forEach(v => vehicleMap.set(v.id, v));
      parsedData.vehicles.forEach(v => vehicleMap.set(v.id, v));

      const merged: Catalog = {
        can_do_version: parsedData.can_do_version || currentCatalog.can_do_version,
        vehicles: Array.from(vehicleMap.values()),
        commands: Array.from(cmdMap.values())
      };
      onImport(merged, 'merge');
    }
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-4 sm:p-6">
          <ModalDialog className="relative w-full max-w-2xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden my-auto p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="flex items-center justify-between p-5 border-b border-separator bg-surface-secondary gap-0">
              <div>
                <ModalHeading className="text-lg font-bold text-foreground flex items-center gap-2">
                  <Upload className="w-5 h-5 text-accent" />
                  Import Catalog or Vector DBC
                </ModalHeading>
                <p className="text-xs text-muted mt-0.5">
                  Upload a <code className="text-accent">catalog.json</code> or industry-standard{' '}
                  <code className="text-success">.dbc</code> database file.
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

            <ModalBody className="p-6 max-h-[70vh] overflow-y-auto space-y-5">
          {/* Drag and Drop Zone */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-[12px] p-6 text-center transition ${
              dragOver
                ? 'border-accent bg-accent/10'
                : 'border-border bg-surface-secondary hover:border-accent/50'
            }`}
          >
            <FileCode className="w-8 h-8 text-accent mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground mb-1">
              Drag and drop your JSON or <span className="text-success font-semibold">.DBC</span> file here, or{' '}
              <label className="text-accent hover:underline cursor-pointer">
                browse file
                <input
                  type="file"
                  accept=".json,application/json,.dbc,text/plain"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </p>
            <p className="text-xs text-muted">
              Auto-detects CAN Do catalogs (.json) and Vector CAN Databases (.dbc)
            </p>
          </div>

          {/* Paste Raw Content */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                Or Paste JSON or Vector DBC Content Directly
              </label>
              {detectedFormat && (
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase ${
                    detectedFormat === 'dbc'
                      ? 'bg-success/15 text-success border border-success/30'
                      : 'bg-accent/15 text-accent border border-accent/30'
                  }`}
                >
                  Detected: {detectedFormat === 'dbc' ? 'Vector CAN DBC' : 'CAN Do JSON'}
                </span>
              )}
            </div>
            <textarea
              rows={6}
              placeholder="Paste JSON or Vector DBC (BO_, SG_...) here..."
              value={jsonText}
              onChange={e => {
                setJsonText(e.target.value);
                handleProcessRaw(e.target.value);
              }}
              className="w-full p-3 rounded-[8px] bg-surface-tertiary border border-border font-mono text-xs text-accent placeholder:text-field-placeholder focus:outline-none focus:border-focus"
            />
          </div>

          {/* DBC Conversion Banner */}
          {dbcStats && (
            <div className="p-3.5 rounded-[10px] bg-success/10 border border-success/30 text-xs text-foreground space-y-1">
              <div className="font-bold text-foreground flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-success" />
                Vector DBC Successfully Converted to CAN Do Catalog
              </div>
              <div className="flex flex-wrap items-center gap-3 text-success text-[11px] pt-1">
                <span>CAN Messages (`BO_`): <strong>{dbcStats.messageCount}</strong></span>
                <span>Signals (`SG_`): <strong>{dbcStats.signalCount}</strong></span>
                <span>Value Enums (`VAL_`): <strong>{dbcStats.valueTableCount}</strong></span>
                <span>Annotations (`CM_`): <strong>{dbcStats.commentCount}</strong></span>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="p-3 rounded-[10px] bg-danger/15 border border-danger/40 text-xs text-danger flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Diff preview */}
          {diff && parsedData && (
            <div className="p-4 rounded-[12px] bg-surface-secondary border border-border space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  Diff Analysis Preview
                </span>
                <span className="text-muted font-mono">
                  {diff.totalImported} command(s) processed
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2.5 rounded-[8px] bg-success/10 border border-success/30">
                  <div className="text-lg font-bold text-success">+{diff.newCommands.length}</div>
                  <div className="text-[11px] text-muted">New Commands</div>
                </div>
                <div className="p-2.5 rounded-[8px] bg-warning/10 border border-warning/30">
                  <div className="text-lg font-bold text-warning">~{diff.modifiedCommands.length}</div>
                  <div className="text-[11px] text-muted">Modified</div>
                </div>
                <div className="p-2.5 rounded-[8px] bg-surface-tertiary border border-border">
                  <div className="text-lg font-bold text-muted">={diff.unchangedCount}</div>
                  <div className="text-[11px] text-muted">Unchanged</div>
                </div>
              </div>

              {diff.newCommands.length > 0 && (
                <div className="text-xs text-muted space-y-1">
                  <span className="font-semibold text-success">New additions:</span>
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                    {diff.newCommands.map(c => (
                      <span
                        key={c.id}
                        className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-success/15 text-success border border-success/30"
                      >
                        {c.name} ({c.id})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {diff.modifiedCommands.length > 0 && (
                <div className="text-xs text-muted space-y-1">
                  <span className="font-semibold text-warning">Updates to existing:</span>
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                    {diff.modifiedCommands.map(({ updated }) => (
                      <span
                        key={updated.id}
                        className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-warning/15 text-warning border border-warning/30"
                      >
                        {updated.name} ({updated.id})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </ModalBody>

        {/* Modal Footer */}
        <ModalFooter className="flex items-center justify-between p-4 px-6 border-t border-separator bg-surface-secondary shrink-0">
          <Button
            variant="outline"
            size="sm"
            onPress={onClose}
            className="dash-outline-btn px-4 py-2 text-xs font-semibold"
          >
            Cancel
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              isDisabled={!parsedData}
              onPress={() => handleApply('merge')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold shadow transition ${
                parsedData
                  ? 'bg-accent hover:opacity-90 text-accent-foreground'
                  : 'bg-surface-tertiary text-muted cursor-not-allowed'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Merge into Catalog
            </Button>
            {confirmReplace ? (
              <div className="flex items-center gap-1.5 bg-danger/15 border border-danger/40 px-2.5 py-1 rounded-lg text-xs">
                <span className="text-xs text-danger font-semibold">Overwrite all?</span>
                <Button
                  variant="danger"
                  size="sm"
                  onPress={() => {
                    handleApply('replace');
                    setConfirmReplace(false);
                  }}
                  className="px-2 py-0.5 bg-danger hover:opacity-90 text-danger-foreground rounded font-bold text-xs transition"
                >
                  Yes, Replace
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => setConfirmReplace(false)}
                  className="px-2 py-0.5 bg-surface-tertiary hover:bg-default-hover text-foreground rounded text-xs transition"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                isDisabled={!parsedData}
                onPress={() => setConfirmReplace(true)}
                className={`dash-outline-btn px-3 py-2 text-xs font-medium text-danger border-danger/40 hover:bg-danger/15 ${
                  !parsedData ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              >
                Replace Entirely
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
