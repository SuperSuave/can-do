import React from 'react';
import { Catalog, CommandRole, GitHubRepoConfig } from '../types/catalog';
import { CanDoLogo } from './CanDoLogo';
import { ExportDropdown } from './ExportDropdown';
import { ExportFormat } from './ExportModal';
import {
  Car,
  Github,
  Upload,
  Download,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Layers,
  Settings,
  Zap
} from 'lucide-react';

interface NavbarProps {
  catalog: Catalog;
  pendingCount: number;
  isValid: boolean;
  onOpenImport: () => void;
  onOpenContribute: () => void;
  onOpenHealth: () => void;
  onResetCatalog: () => void;
  onOpenExportModal?: (format?: ExportFormat) => void;
  onOpenDbcExport?: () => void;
  activeMainTab: 'catalog' | 'vehicles' | 'automations';
  onChangeMainTab: (tab: 'catalog' | 'vehicles' | 'automations') => void;
  repoConfig: GitHubRepoConfig;
  rulesCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  catalog,
  pendingCount,
  isValid,
  onOpenImport,
  onOpenContribute,
  onOpenHealth,
  onResetCatalog,
  onOpenExportModal,
  onOpenDbcExport,
  activeMainTab,
  onChangeMainTab,
  repoConfig,
  rulesCount = 0
}) => {
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);

  const handleQuickDownload = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(catalog, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `catalog-v${catalog.catalog_version}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Brand & Version */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 px-2.5 py-1 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shadow-inner hover:border-slate-700 transition">
                <CanDoLogo className="h-7 w-auto" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-white tracking-tight">CAN Do</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-cyan-300 font-mono border border-slate-700">
                    v{catalog.catalog_version}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-medium">
                  Community Contribution Hub
                </div>
              </div>
            </div>

            {/* Navigation tabs */}
            <div className="hidden md:flex items-center gap-1 ml-4 p-1 rounded-xl bg-slate-900 border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => onChangeMainTab('catalog')}
                className={`px-3 py-1.5 rounded-lg font-semibold transition ${
                  activeMainTab === 'catalog'
                    ? 'bg-slate-800 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Commands ({catalog.commands.length})
              </button>
              <button
                type="button"
                onClick={() => onChangeMainTab('vehicles')}
                className={`px-3 py-1.5 rounded-lg font-semibold transition ${
                  activeMainTab === 'vehicles'
                    ? 'bg-slate-800 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Vehicles ({catalog.vehicles.length})
              </button>
              <button
                type="button"
                onClick={() => onChangeMainTab('automations')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition ${
                  activeMainTab === 'automations'
                    ? 'bg-cyan-500 text-slate-950 shadow font-bold'
                    : 'text-cyan-400 hover:text-cyan-300 hover:bg-slate-800/80'
                }`}
              >
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>Automations</span>
                {rulesCount > 0 && (
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                      activeMainTab === 'automations'
                        ? 'bg-slate-950 text-cyan-300'
                        : 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                    }`}
                  >
                    {rulesCount}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 sm:gap-2.5">
            {/* Catalog Health Status */}
            <button
              type="button"
              onClick={onOpenHealth}
              title="Open Catalog Validation Report"
              className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                isValid
                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/80 hover:bg-emerald-950/80'
                  : 'bg-rose-950/40 text-rose-300 border-rose-800/80 hover:bg-rose-950/80 animate-pulse'
              }`}
            >
              {isValid ? (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              )}
              <span>{isValid ? 'Valid Catalog' : 'Audit Issues'}</span>
            </button>

            {/* Import Button */}
            <button
              type="button"
              onClick={onOpenImport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 transition"
              title="Import or merge JSON catalog"
            >
              <Upload className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Import</span>
            </button>

            {/* Merged Export Button & Dropdown */}
            <ExportDropdown
              variant="navbar"
              onQuickDownloadJson={handleQuickDownload}
              onOpenExportModal={format => {
                if (onOpenExportModal) {
                  onOpenExportModal(format);
                } else if (onOpenDbcExport) {
                  onOpenDbcExport();
                }
              }}
            />

            {/* Submit / Contribute to GitHub Button */}
            <button
              type="button"
              onClick={onOpenContribute}
              className="relative inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-md shadow-cyan-500/20 transition"
            >
              <Github className="w-3.5 h-3.5" />
              <span>Contribute</span>
              {pendingCount > 0 && (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-950 text-cyan-300 font-mono text-[10px] font-bold">
                  {pendingCount}
                </span>
              )}
            </button>

            {/* Reset Catalog */}
            {showResetConfirm ? (
              <div className="flex items-center gap-1.5 bg-rose-950/90 border border-rose-700/80 px-2 py-1 rounded-lg text-xs animate-in fade-in">
                <span className="text-[10px] text-rose-200 font-semibold">Reset all?</span>
                <button
                  type="button"
                  onClick={() => {
                    onResetCatalog();
                    setShowResetConfirm(false);
                  }}
                  className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-[10px] transition"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(false)}
                  className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowResetConfirm(true)}
                title="Reset to default 3.1.0 catalog"
                className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-slate-900 rounded-lg transition"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
