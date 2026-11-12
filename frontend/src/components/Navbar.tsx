import React from 'react';
import { Tabs } from '@heroui/react';
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
  Zap,
  Radio,
  Sun,
  Moon
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
  activeMainTab: 'catalog' | 'vehicles' | 'automations' | 'device' | 'dashboard';
  onChangeMainTab: (tab: 'catalog' | 'vehicles' | 'automations' | 'device' | 'dashboard') => void;
  repoConfig: GitHubRepoConfig;
  rulesCount?: number;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
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
  rulesCount = 0,
  theme: externalTheme,
  onToggleTheme
}) => {
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  const [internalTheme, setInternalTheme] = React.useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined') {
      const current = document.documentElement.getAttribute('data-theme');
      if (current === 'light' || current === 'dark') return current;
    }
    return 'dark';
  });

  const currentTheme = externalTheme || internalTheme;

  const handleToggle = () => {
    if (onToggleTheme) {
      onToggleTheme();
    } else {
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      setInternalTheme(nextTheme);
      document.documentElement.setAttribute('data-theme', nextTheme);
      if (nextTheme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      } else {
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
      }
      try {
        localStorage.setItem('theme', nextTheme);
        localStorage.setItem('can_do_theme', nextTheme);
      } catch (e) {}
    }
  };

  const handleQuickDownload = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(catalog, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `catalog-v${catalog.can_do_version || 'unknown'}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-surface/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Brand & Version */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 px-2.5 py-1 rounded-xl bg-surface-secondary border border-border flex items-center justify-center hover:border-border-secondary transition">
                <CanDoLogo className="h-7 w-auto" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-foreground tracking-tight">CAN Do</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent-soft-foreground font-mono border border-accent/30">
                    {catalog.can_do_version || 'Loading...'}
                  </span>
                </div>
              </div>
            </div>

            {/* Navigation tabs */}
            <div className="hidden md:flex items-center ml-4">
              <Tabs
                selectedKey={activeMainTab}
                onSelectionChange={key => onChangeMainTab(key as typeof activeMainTab)}
                aria-label="Navbar Main Navigation"
              >
                <Tabs.ListContainer className="p-1 rounded-xl bg-default border border-border text-xs">
                  <Tabs.List className="gap-1">
                    <Tabs.Tab
                      id="catalog"
                      className={`relative px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer flex items-center ${
                        activeMainTab === 'catalog'
                          ? 'text-segment-foreground'
                          : 'text-muted hover:text-foreground'
                      }`}
                    >
                      <span>Commands ({catalog.commands.length})</span>
                      <Tabs.Indicator className="rounded-lg bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="vehicles"
                      className={`relative px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer flex items-center ${
                        activeMainTab === 'vehicles'
                          ? 'text-segment-foreground'
                          : 'text-muted hover:text-foreground'
                      }`}
                    >
                      <span>Vehicles ({catalog.vehicles.length})</span>
                      <Tabs.Indicator className="rounded-lg bg-segment border border-border shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="automations"
                      className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer ${
                        activeMainTab === 'automations'
                          ? 'text-accent-foreground font-bold'
                          : 'text-accent hover:text-accent/80'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5 fill-current" />
                      <span>Automations</span>
                      {rulesCount > 0 && (
                        <span
                          className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                            activeMainTab === 'automations'
                              ? 'bg-accent-foreground/20 text-accent-foreground'
                              : 'bg-accent-soft text-accent-soft-foreground border border-accent/30'
                          }`}
                        >
                          {rulesCount}
                        </span>
                      )}
                      <Tabs.Indicator className="rounded-lg bg-accent shadow-sm" />
                    </Tabs.Tab>

                    <Tabs.Tab
                      id="device"
                      className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer ${
                        activeMainTab === 'device'
                          ? 'text-success-foreground font-bold'
                          : 'text-success hover:text-success/80'
                      }`}
                    >
                      <Radio className="w-3.5 h-3.5" />
                      <span>Device</span>
                      <Tabs.Indicator className="rounded-lg bg-success shadow-sm" />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
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
                  ? 'bg-success-soft text-success-soft-foreground border-success/30 hover:bg-success/20'
                  : 'bg-danger-soft text-danger-soft-foreground border-danger/30 hover:bg-danger/20 animate-pulse'
              }`}
            >
              {isValid ? (
                <ShieldCheck className="w-3.5 h-3.5 text-success" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-danger" />
              )}
              <span>{isValid ? 'Valid Catalog' : 'Audit Issues'}</span>
            </button>

            {/* Import Button */}
            <button
              type="button"
              onClick={onOpenImport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-foreground bg-surface-secondary hover:bg-surface-tertiary border border-border transition"
              title="Import or merge JSON catalog"
            >
              <Upload className="w-3.5 h-3.5 text-accent" />
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
              className="relative inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold bg-accent hover:bg-accent-hover text-accent-foreground shadow-sm transition"
            >
              <Github className="w-3.5 h-3.5" />
              <span>Contribute</span>
              {pendingCount > 0 && (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-foreground/20 text-accent-foreground font-mono text-[10px] font-bold">
                  {pendingCount}
                </span>
              )}
            </button>

            {/* Theme Toggle Button */}
            <button
              type="button"
              onClick={handleToggle}
              title={`Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label={`Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`}
              className="p-1.5 text-muted hover:text-foreground hover:bg-surface-secondary rounded-lg transition"
            >
              {currentTheme === 'dark' ? (
                <Sun className="w-4 h-4 text-warning" />
              ) : (
                <Moon className="w-4 h-4 text-accent" />
              )}
            </button>

            {/* Reset Catalog */}
            {showResetConfirm ? (
              <div className="flex items-center gap-1.5 bg-danger-soft border border-danger/40 px-2 py-1 rounded-lg text-xs animate-in fade-in">
                <span className="text-[10px] text-danger-soft-foreground font-semibold">Reset all?</span>
                <button
                  type="button"
                  onClick={() => {
                    onResetCatalog();
                    setShowResetConfirm(false);
                  }}
                  className="px-1.5 py-0.5 bg-danger hover:bg-danger-hover text-danger-foreground rounded font-bold text-[10px] transition"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(false)}
                  className="px-1.5 py-0.5 bg-surface-tertiary hover:bg-default-hover text-foreground rounded text-[10px] transition"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowResetConfirm(true)}
                title="Reset to default 3.1.0 catalog"
                className="p-1.5 text-muted hover:text-foreground hover:bg-surface-secondary rounded-lg transition"
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
