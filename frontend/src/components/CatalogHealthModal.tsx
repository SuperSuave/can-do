import React, { useState } from 'react';
import { Catalog } from '../types/catalog';
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
Catalog Version: ${catalog.catalog_version}
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
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[var(--md-sys-color-primary)]" />
              Catalog Validation & Health Audit
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Comprehensive scan of CAN IDs, payload masks, multiplexing, and vehicle compatibility.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-5 text-xs">
          {/* Health Status Banner */}
          <div
            className={`p-4 rounded-[12px] border flex items-center justify-between ${
              report.errors.length === 0
                ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-200'
                : 'bg-rose-950/30 border-rose-800/60 text-rose-200'
            }`}
          >
            <div className="flex items-center gap-3">
              {report.errors.length === 0 ? (
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-6 h-6 text-rose-400" />
              )}
              <div>
                <div className="text-sm font-bold text-white">
                  {report.errors.length === 0
                    ? 'Catalog Passed Validation Checks'
                    : `${report.errors.length} Critical Syntax Error(s) Found`}
                </div>
                <div className="text-xs opacity-80 mt-0.5">
                  {report.warnings.length} warning(s) • {catalog.commands.length} total commands verified
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCopyReport}
              className="dash-outline-btn px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              Copy Audit
            </button>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="p-2.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
              <div className="text-base font-bold text-white">{report.roleCounts.trigger}</div>
              <div className="text-[10px] text-amber-400 font-medium uppercase">Triggers</div>
            </div>
            <div className="p-2.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
              <div className="text-base font-bold text-white">{report.roleCounts.condition}</div>
              <div className="text-[10px] text-emerald-400 font-medium uppercase">Conditions</div>
            </div>
            <div className="p-2.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
              <div className="text-base font-bold text-white">{report.roleCounts.action}</div>
              <div className="text-[10px] text-cyan-400 font-medium uppercase">Actions</div>
            </div>
            <div className="p-2.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
              <div className="text-base font-bold text-white">{catalog.vehicles.length}</div>
              <div className="text-[10px] text-purple-400 font-medium uppercase">Vehicles</div>
            </div>
          </div>

          {/* Errors list if any */}
          {report.errors.length > 0 && (
            <div className="p-3.5 rounded-[12px] bg-rose-950/40 border border-rose-800 text-rose-200 space-y-1.5">
              <div className="font-semibold flex items-center gap-1.5 text-rose-300">
                <AlertTriangle className="w-4 h-4" /> Errors Requiring Fix:
              </div>
              {report.errors.map((err, i) => (
                <div key={i} className="pl-5">
                  • <strong className="font-mono text-white">{err.commandId}</strong>: {err.message}
                </div>
              ))}
            </div>
          )}

          {/* Shared / Multiplexed Frames */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-cyan-400" />
                Multiplexed / Shared CAN Frames ({sharedCanIds.length})
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                Expected for automotive sensor frames
              </span>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {sharedCanIds.map(([canIdKey, cmdNames]) => (
                <div
                  key={canIdKey}
                  className="p-2.5 rounded-[10px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] flex items-start justify-between gap-3"
                >
                  <div>
                    <span className="font-mono text-cyan-300 font-semibold">{canIdKey}</span>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                      {cmdNames.join(' • ')}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--input-bg)] text-slate-400 border border-[var(--border-color)] shrink-0">
                    {cmdNames.length} commands
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Feature Coverage */}
          <div>
            <span className="font-semibold text-slate-300 flex items-center gap-1.5 mb-2">
              <Car className="w-4 h-4 text-emerald-400" />
              Trim Feature Coverage ({featuresWithCommands.size} of {knownFeatures.length} features active)
            </span>
            <div className="p-3 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {knownFeatures.map(feat => {
                  const hasCmd = featuresWithCommands.has(feat);
                  return (
                    <span
                      key={feat}
                      className={`px-2 py-0.5 rounded-full text-[11px] font-mono ${
                        hasCmd
                          ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                          : 'bg-[var(--input-bg)] text-slate-500 border border-[var(--border-color)]'
                      }`}
                    >
                      {feat} {hasCmd ? '✓' : '(No commands)'}
                    </span>
                  );
                })}
              </div>
              {unusedFeatures.length > 0 && (
                <p className="text-[11px] text-[var(--text-muted)] pt-1">
                  Features without commands: {unusedFeatures.join(', ')}. Contributors can submit new CAN triggers/actions for these!
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end p-4 px-6 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-full text-xs font-semibold text-white bg-[var(--md-sys-color-primary)] hover:opacity-90 transition"
          >
            Close Audit
          </button>
        </div>
      </div>
    </div>
  );
};
