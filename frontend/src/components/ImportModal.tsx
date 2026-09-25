import React, { useState } from 'react';
import { Catalog, Command, Vehicle } from '../types/catalog';
import { validateCatalog, validateCommand } from '../utils/canValidator';
import { normalizeCatalog } from '../data/defaultCatalog';
import { parseDbc, DbcParseStats } from '../utils/dbcConverter';
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
      if (parsed.catalog_version && Array.isArray(parsed.commands)) {
        catalogCandidate = {
          catalog_version: parsed.catalog_version,
          vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : currentCatalog.vehicles,
          commands: parsed.commands
        };
      }
      // Handle array of commands
      else if (Array.isArray(parsed)) {
        catalogCandidate = {
          catalog_version: currentCatalog.catalog_version,
          vehicles: currentCatalog.vehicles,
          commands: parsed
        };
      }
      // Handle single command object
      else if (parsed.id && parsed.name) {
        catalogCandidate = {
          catalog_version: currentCatalog.catalog_version,
          vehicles: currentCatalog.vehicles,
          commands: [parsed]
        };
      } else {
        throw new Error(
          'Unrecognized JSON structure. Expected a CAN Do catalog object with "catalog_version" & "commands", or an array of command objects.'
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
        catalog_version: parsedData.catalog_version || currentCatalog.catalog_version,
        vehicles: Array.from(vehicleMap.values()),
        commands: Array.from(cmdMap.values())
      };
      onImport(merged, 'merge');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Upload className="w-5 h-5 text-[var(--md-sys-color-primary)]" />
              Import Catalog or Vector DBC
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Upload a <code className="text-cyan-300">catalog.json</code> or industry-standard{' '}
              <code className="text-emerald-300">.dbc</code> database file.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-5">
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
                ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary)]/10'
                : 'border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] hover:border-slate-500'
            }`}
          >
            <FileCode className="w-8 h-8 text-[var(--md-sys-color-primary)] mx-auto mb-2" />
            <p className="text-sm font-medium text-white mb-1">
              Drag and drop your JSON or <span className="text-emerald-300 font-semibold">.DBC</span> file here, or{' '}
              <label className="text-cyan-400 hover:underline cursor-pointer">
                browse file
                <input
                  type="file"
                  accept=".json,application/json,.dbc,text/plain"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              Auto-detects CAN Do catalogs (.json) and Vector CAN Databases (.dbc)
            </p>
          </div>

          {/* Paste Raw Content */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Or Paste JSON or Vector DBC Content Directly
              </label>
              {detectedFormat && (
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase ${
                    detectedFormat === 'dbc'
                      ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                      : 'bg-cyan-950/80 text-cyan-300 border border-cyan-800'
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
              className="w-full p-3 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-cyan-200 placeholder-slate-600 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
            />
          </div>

          {/* DBC Conversion Banner */}
          {dbcStats && (
            <div className="p-3.5 rounded-[10px] bg-emerald-950/40 border border-emerald-800/80 text-xs text-emerald-200 space-y-1">
              <div className="font-bold text-white flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                Vector DBC Successfully Converted to CAN Do Catalog
              </div>
              <div className="flex flex-wrap items-center gap-3 text-emerald-300/90 text-[11px] pt-1">
                <span>CAN Messages (`BO_`): <strong>{dbcStats.messageCount}</strong></span>
                <span>Signals (`SG_`): <strong>{dbcStats.signalCount}</strong></span>
                <span>Value Enums (`VAL_`): <strong>{dbcStats.valueTableCount}</strong></span>
                <span>Annotations (`CM_`): <strong>{dbcStats.commentCount}</strong></span>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="p-3 rounded-[10px] bg-rose-950/50 border border-rose-800 text-xs text-rose-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Diff preview */}
          {diff && parsedData && (
            <div className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Diff Analysis Preview
                </span>
                <span className="text-[var(--text-muted)] font-mono">
                  {diff.totalImported} command(s) processed
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2.5 rounded-[8px] bg-emerald-950/40 border border-emerald-800">
                  <div className="text-lg font-bold text-emerald-300">+{diff.newCommands.length}</div>
                  <div className="text-[11px] text-slate-400">New Commands</div>
                </div>
                <div className="p-2.5 rounded-[8px] bg-amber-950/40 border border-amber-800">
                  <div className="text-lg font-bold text-amber-300">~{diff.modifiedCommands.length}</div>
                  <div className="text-[11px] text-slate-400">Modified</div>
                </div>
                <div className="p-2.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)]">
                  <div className="text-lg font-bold text-slate-400">={diff.unchangedCount}</div>
                  <div className="text-[11px] text-slate-400">Unchanged</div>
                </div>
              </div>

              {diff.newCommands.length > 0 && (
                <div className="text-xs text-slate-400 space-y-1">
                  <span className="font-semibold text-emerald-400">New additions:</span>
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                    {diff.newCommands.map(c => (
                      <span
                        key={c.id}
                        className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800"
                      >
                        {c.name} ({c.id})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {diff.modifiedCommands.length > 0 && (
                <div className="text-xs text-slate-400 space-y-1">
                  <span className="font-semibold text-amber-400">Updates to existing:</span>
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                    {diff.modifiedCommands.map(({ updated }) => (
                      <span
                        key={updated.id}
                        className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-amber-950 text-amber-300 border border-amber-800"
                      >
                        {updated.name} ({updated.id})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between p-4 px-6 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <button
            type="button"
            onClick={onClose}
            className="dash-outline-btn px-4 py-2 text-xs font-semibold"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!parsedData}
              onClick={() => handleApply('merge')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold shadow transition ${
                parsedData
                  ? 'bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white'
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Merge into Catalog
            </button>
            {confirmReplace ? (
              <div className="flex items-center gap-1.5 bg-rose-950/90 border border-rose-700/80 px-2.5 py-1 rounded-lg text-xs">
                <span className="text-xs text-rose-200 font-semibold">Overwrite all?</span>
                <button
                  type="button"
                  onClick={() => {
                    handleApply('replace');
                    setConfirmReplace(false);
                  }}
                  className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-xs transition"
                >
                  Yes, Replace
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReplace(false)}
                  className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!parsedData}
                onClick={() => setConfirmReplace(true)}
                className={`dash-outline-btn px-3 py-2 text-xs font-medium text-rose-300 border-rose-800/60 hover:bg-rose-950/40 ${
                  !parsedData ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              >
                Replace Entirely
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
