import React, { useState, useMemo } from 'react';
import { Catalog } from '../types/catalog';
import { exportToDbc } from '../utils/dbcConverter';
import {
  X,
  Download,
  Copy,
  Check,
  FileCode,
  Filter,
  Car,
  Layers,
  Sparkles,
  Info,
  Code2,
  FileJson,
  CheckCircle2
} from 'lucide-react';

export type ExportFormat = 'dbc' | 'json';

interface ExportModalProps {
  isOpen: boolean;
  catalog: Catalog;
  onClose: () => void;
  initialFormat?: ExportFormat;
  selectedVehicleId?: string;
  selectedCategory?: string;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  catalog,
  onClose,
  initialFormat = 'dbc',
  selectedVehicleId = 'all',
  selectedCategory = 'all'
}) => {
  const [activeFormat, setActiveFormat] = useState<ExportFormat>(initialFormat);
  const [vehicleFilter, setVehicleFilter] = useState<string>(selectedVehicleId);
  const [categoryFilter, setCategoryFilter] = useState<string>(selectedCategory);
  const [ecuName, setEcuName] = useState<string>('CAN_DO_HUB');
  const [includeComments, setIncludeComments] = useState<boolean>(true);
  const [jsonMinified, setJsonMinified] = useState<boolean>(false);
  const [filterJsonToScope, setFilterJsonToScope] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'preview' | 'help'>('preview');

  // Sync initialFormat if changed when opened
  React.useEffect(() => {
    if (isOpen) {
      setActiveFormat(initialFormat);
    }
  }, [isOpen, initialFormat]);

  // Categories list
  const categories = useMemo(() => {
    const cats = new Set(catalog.commands.map(c => c.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [catalog.commands]);

  // Filtered commands count
  const filteredCommands = useMemo(() => {
    return catalog.commands.filter(cmd => {
      if (vehicleFilter !== 'all') {
        const hasVehicle = cmd.vehicles?.some(
          v => (typeof v === 'string' ? v : v.vehicle_id) === vehicleFilter
        );
        if (!hasVehicle) return false;
      }
      if (categoryFilter !== 'all') {
        if (cmd.category !== categoryFilter) return false;
      }
      return true;
    });
  }, [catalog.commands, vehicleFilter, categoryFilter]);

  // Compute DBC string
  const dbcContent = useMemo(() => {
    return exportToDbc(catalog, {
      vehicleId: vehicleFilter,
      category: categoryFilter,
      ecuName,
      includeComments
    });
  }, [catalog, vehicleFilter, categoryFilter, ecuName, includeComments]);

  // Compute JSON string
  const jsonContent = useMemo(() => {
    if (filterJsonToScope && (vehicleFilter !== 'all' || categoryFilter !== 'all')) {
      const filteredCatalog: Catalog = {
        ...catalog,
        vehicles:
          vehicleFilter !== 'all'
            ? catalog.vehicles.filter(v => v.id === vehicleFilter)
            : catalog.vehicles,
        commands: filteredCommands
      };
      return jsonMinified
        ? JSON.stringify(filteredCatalog)
        : JSON.stringify(filteredCatalog, null, 2);
    }

    return jsonMinified
      ? JSON.stringify(catalog)
      : JSON.stringify(catalog, null, 2);
  }, [catalog, filterJsonToScope, vehicleFilter, categoryFilter, filteredCommands, jsonMinified]);

  // Active content based on format
  const activeContent = activeFormat === 'dbc' ? dbcContent : jsonContent;

  // Summary statistics for DBC
  const dbcStats = useMemo(() => {
    const lines = dbcContent.split('\n');
    const boCount = lines.filter(l => l.startsWith('BO_ ')).length;
    const sgCount = lines.filter(l => l.trimStart().startsWith('SG_ ')).length;
    const valCount = lines.filter(l => l.startsWith('VAL_ ')).length;
    const cmCount = lines.filter(l => l.startsWith('CM_ ')).length;
    return { boCount, sgCount, valCount, cmCount };
  }, [dbcContent]);

  // Summary statistics for JSON
  const jsonStats = useMemo(() => {
    const byteSize = new Blob([jsonContent]).size;
    const kb = (byteSize / 1024).toFixed(1);
    const cmdCount = filterJsonToScope && (vehicleFilter !== 'all' || categoryFilter !== 'all')
      ? filteredCommands.length
      : catalog.commands.length;
    const vehCount = filterJsonToScope && vehicleFilter !== 'all' ? 1 : catalog.vehicles.length;
    return { kb, cmdCount, vehCount };
  }, [jsonContent, filterJsonToScope, vehicleFilter, categoryFilter, filteredCommands.length, catalog]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(activeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    let filename: string;
    let mimeType: string;

    if (activeFormat === 'dbc') {
      filename =
        vehicleFilter !== 'all'
          ? `can_do_${vehicleFilter}.dbc`
          : `can_do_catalog_v${catalog.catalog_version}.dbc`;
      mimeType = 'text/plain;charset=utf-8';
    } else {
      filename =
        filterJsonToScope && vehicleFilter !== 'all'
          ? `can_do_${vehicleFilter}.json`
          : `can_do_catalog_v${catalog.catalog_version}.json`;
      mimeType = 'application/json;charset=utf-8';
    }

    const blob = new Blob([activeContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-4xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-950/60 border border-cyan-800/80 flex items-center justify-center text-cyan-400">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">Export CAN Catalog</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-300 font-mono border border-cyan-800/80">
                  v{catalog.catalog_version}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Download or copy catalog in standard Vector DBC or CAN Do JSON format
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Format Selector Bar */}
        <div className="px-5 py-3 border-b border-[var(--border-color)] bg-slate-900/60 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400 mr-1">Format:</span>
            <button
              type="button"
              onClick={() => setActiveFormat('dbc')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition border ${
                activeFormat === 'dbc'
                  ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/50 shadow-sm'
                  : 'bg-slate-950/50 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <FileCode className="w-3.5 h-3.5 text-cyan-400" />
              <span>Vector CAN DBC (.dbc)</span>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60">
                SavvyCAN / comma
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveFormat('json')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition border ${
                activeFormat === 'json'
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-950/50 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <FileJson className="w-3.5 h-3.5 text-emerald-400" />
              <span>CAN Do JSON (.json)</span>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/60">
                Hub Schema
              </span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('preview')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${
                activeTab === 'preview'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              File Preview
            </button>
            <button
              onClick={() => setActiveTab('help')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${
                activeTab === 'help'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tool Setup Guide
            </button>
          </div>
        </div>

        {/* Filter & Configuration Toolbar */}
        <div className="p-4 border-b border-[var(--border-color)] bg-slate-950/40 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs shrink-0">
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
              <Car className="w-3.5 h-3.5 text-cyan-400" />
              Target Vehicle Trim
            </label>
            <select
              value={vehicleFilter}
              onChange={e => setVehicleFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
            >
              <option value="all">All Vehicles & Trims</option>
              {catalog.vehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.model_years})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              Category Filter
            </label>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
            >
              <option value="all">All Categories ({catalog.commands.length})</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {activeFormat === 'dbc' ? (
            <>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  ECU Transmitter Node
                </label>
                <input
                  type="text"
                  value={ecuName}
                  onChange={e => setEcuName(e.target.value)}
                  placeholder="CAN_DO_HUB"
                  className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
              </div>

              <div className="flex flex-col justify-end">
                <label className="inline-flex items-center gap-2 cursor-pointer pb-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={includeComments}
                    onChange={e => setIncludeComments(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0 w-4 h-4"
                  />
                  <span className="text-[11px]">Include Author & Notes (`CM_`)</span>
                </label>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col justify-end">
                <label className="inline-flex items-center gap-2 cursor-pointer pb-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={filterJsonToScope}
                    onChange={e => setFilterJsonToScope(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-0 w-4 h-4"
                  />
                  <span className="text-[11px]">Filter JSON to selected scope</span>
                </label>
              </div>

              <div className="flex flex-col justify-end">
                <label className="inline-flex items-center gap-2 cursor-pointer pb-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={jsonMinified}
                    onChange={e => setJsonMinified(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-0 w-4 h-4"
                  />
                  <span className="text-[11px]">Compact (Minified) JSON</span>
                </label>
              </div>
            </>
          )}
        </div>

        {/* Stats strip */}
        <div className="px-5 py-2.5 bg-slate-900/50 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          {activeFormat === 'dbc' ? (
            <div className="flex items-center gap-4 text-slate-300">
              <div>
                <span className="text-slate-400 text-[11px]">CAN Messages (`BO_`): </span>
                <strong className="text-white font-mono">{dbcStats.boCount}</strong>
              </div>
              <div>
                <span className="text-slate-400 text-[11px]">Signals (`SG_`): </span>
                <strong className="text-cyan-300 font-mono">{dbcStats.sgCount}</strong>
              </div>
              <div>
                <span className="text-slate-400 text-[11px]">Value Tables (`VAL_`): </span>
                <strong className="text-emerald-300 font-mono">{dbcStats.valCount}</strong>
              </div>
              <div>
                <span className="text-slate-400 text-[11px]">Annotations (`CM_`): </span>
                <strong className="text-amber-300 font-mono">{dbcStats.cmCount}</strong>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4 text-slate-300">
              <div>
                <span className="text-slate-400 text-[11px]">Commands: </span>
                <strong className="text-emerald-300 font-mono">{jsonStats.cmdCount}</strong>
              </div>
              <div>
                <span className="text-slate-400 text-[11px]">Vehicles: </span>
                <strong className="text-white font-mono">{jsonStats.vehCount}</strong>
              </div>
              <div>
                <span className="text-slate-400 text-[11px]">Estimated Size: </span>
                <strong className="text-cyan-300 font-mono">{jsonStats.kb} KB</strong>
              </div>
            </div>
          )}

          <div className="text-[11px] text-slate-400">
            {vehicleFilter !== 'all' ? (
              <span>Filtered to: <strong className="text-white">{vehicleFilter}</strong></span>
            ) : (
              <span>Scope: <strong className="text-slate-200">Entire Catalog</strong></span>
            )}
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'preview' ? (
            <div className="relative">
              <pre className="p-4 rounded-xl bg-slate-950/90 border border-slate-800/90 font-mono text-xs text-slate-200 overflow-x-auto leading-relaxed max-h-[420px] select-all">
                {activeContent}
              </pre>
            </div>
          ) : (
            <div className="space-y-4 text-xs text-slate-300 leading-relaxed">
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
                <h4 className="font-bold text-white text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-cyan-400" />
                  Automotive Integration Guide
                </h4>
                <p>
                  Vector DBC is the automotive industry standard for CAN packet decoding, supported by open-source and commercial tooling. CAN Do JSON provides full catalog schema fidelity.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                  <strong className="text-white block font-semibold flex items-center gap-1.5">
                    <FileCode className="w-4 h-4 text-cyan-400" />
                    1. SavvyCAN & SocketCAN (.dbc)
                  </strong>
                  <p className="text-slate-400">
                    Open SavvyCAN → Click <code className="text-cyan-300">File</code> →{' '}
                    <code className="text-cyan-300">Load DBC File</code>. Live CAN frames matching the
                    IDs will immediately decode into named buttons and byte values.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                  <strong className="text-white block font-semibold flex items-center gap-1.5">
                    <FileCode className="w-4 h-4 text-cyan-400" />
                    2. comma.ai / opendbc (.dbc)
                  </strong>
                  <p className="text-slate-400">
                    Drop the downloaded <code className="text-cyan-300">.dbc</code> file directly into the{' '}
                    <code className="text-slate-300">opendbc/</code> repository or custom fork for
                    openpilot CAN message decoding.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                  <strong className="text-white block font-semibold flex items-center gap-1.5">
                    <FileCode className="w-4 h-4 text-cyan-400" />
                    3. Wireshark (.dbc)
                  </strong>
                  <p className="text-slate-400">
                    In Wireshark, navigate to <code className="text-cyan-300">Analyze</code> →{' '}
                    <code className="text-cyan-300">Enabled Protocols</code> →{' '}
                    <code className="text-slate-300">CANopen / CAN</code> and load the DBC database to
                    view live signal names in packet captures.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                  <strong className="text-white block font-semibold flex items-center gap-1.5">
                    <FileJson className="w-4 h-4 text-emerald-400" />
                    4. CAN Do Hub / Custom Firmware (.json)
                  </strong>
                  <p className="text-slate-400">
                    Flash to ESP32 / STM32 CAN controllers, or backup the database for versioning in Git. Contains vehicles, validation constraints, and options.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 px-6 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] shrink-0">
          <div className="text-xs text-slate-400">
            {activeFormat === 'dbc' ? (
              <span>{dbcStats.sgCount} Signals across {dbcStats.boCount} CAN Messages</span>
            ) : (
              <span>{jsonStats.cmdCount} Commands in {jsonStats.vehCount} Vehicles ({jsonStats.kb} KB)</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
              className="dash-outline-btn px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-300">Copied to Clipboard</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy {activeFormat === 'dbc' ? 'DBC Text' : 'JSON Text'}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className={`px-5 py-2 rounded-full text-xs font-bold inline-flex items-center gap-2 transition shadow-md ${
                activeFormat === 'dbc'
                  ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-cyan-500/20'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
              }`}
            >
              <Download className="w-4 h-4" />
              <span>Download {activeFormat === 'dbc' ? '.dbc File' : '.json File'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
