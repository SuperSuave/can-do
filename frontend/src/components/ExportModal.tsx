import React, { useState, useMemo } from 'react';
import {
  Tabs,
  Switch,
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
          : `can_do_catalog_v${catalog.can_do_version || 'unknown'}.dbc`;
      mimeType = 'text/plain;charset=utf-8';
    } else {
      filename =
        filterJsonToScope && vehicleFilter !== 'all'
          ? `can_do_${vehicleFilter}.json`
          : `can_do_catalog_v${catalog.can_do_version || 'unknown'}.json`;
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
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-4 sm:p-6">
          <ModalDialog className="relative w-full max-w-4xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden my-auto p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="flex items-center justify-between p-5 border-b border-separator bg-surface shrink-0 gap-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent-soft border border-accent/30 flex items-center justify-center text-accent">
                  <Download className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <ModalHeading className="text-base font-bold text-foreground">Export CAN Catalog</ModalHeading>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-soft text-accent-soft-foreground font-mono border border-accent/30">
                      {catalog.can_do_version || 'Loading...'}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    Download or copy catalog in standard Vector DBC or CAN Do JSON format
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                onPress={onClose}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-default-hover transition"
              >
                <X className="w-5 h-5" />
              </Button>
            </ModalHeader>

        {/* Format Selector Bar */}
        <div className="px-5 py-3 border-b border-separator bg-surface flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted mr-1">Format:</span>
            <Tabs
              selectedKey={activeFormat}
              onSelectionChange={key => setActiveFormat(key as ExportFormat)}
              aria-label="Export Format"
            >
              <Tabs.ListContainer className="p-0.5 rounded-lg bg-default border border-border text-xs">
                <Tabs.List className="gap-1">
                  <Tabs.Tab
                    id="dbc"
                    className={`relative px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
                      activeFormat === 'dbc'
                        ? 'text-accent-soft-foreground'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <FileCode className="w-3.5 h-3.5 text-accent" />
                    <span>Vector CAN DBC (.dbc)</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-accent-soft text-accent-soft-foreground border border-accent/30">
                      SavvyCAN / comma
                    </span>
                    <Tabs.Indicator className="rounded-lg bg-accent-soft border border-accent/50 shadow-sm" />
                  </Tabs.Tab>

                  <Tabs.Tab
                    id="json"
                    className={`relative px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
                      activeFormat === 'json'
                        ? 'text-success-soft-foreground'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <FileJson className="w-3.5 h-3.5 text-success" />
                    <span>CAN Do JSON (.json)</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-success-soft text-success-soft-foreground border border-success/30">
                      Hub Schema
                    </span>
                    <Tabs.Indicator className="rounded-lg bg-success-soft border border-success/50 shadow-sm" />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
          </div>

          <Tabs
            selectedKey={activeTab}
            onSelectionChange={key => setActiveTab(key as 'preview' | 'help')}
            aria-label="Export Views"
          >
            <Tabs.ListContainer className="p-0.5 rounded-lg bg-default border border-border text-[11px]">
              <Tabs.List className="gap-1">
                <Tabs.Tab
                  id="preview"
                  className={`relative px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer ${
                    activeTab === 'preview'
                      ? 'text-segment-foreground'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>File Preview</span>
                  <Tabs.Indicator className="rounded-md bg-segment border border-border shadow-sm" />
                </Tabs.Tab>
                <Tabs.Tab
                  id="help"
                  className={`relative px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer ${
                    activeTab === 'help'
                      ? 'text-segment-foreground'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>Tool Setup Guide</span>
                  <Tabs.Indicator className="rounded-md bg-segment border border-border shadow-sm" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>

        {/* Filter & Configuration Toolbar */}
        <div className="p-4 border-b border-separator bg-surface-secondary grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs shrink-0">
          <div>
            <label className="block text-[11px] font-semibold text-muted mb-1 flex items-center gap-1">
              <Car className="w-3.5 h-3.5 text-accent" />
              Target Vehicle Trim
            </label>
            <select
              value={vehicleFilter}
              onChange={e => setVehicleFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg bg-surface-tertiary border border-border text-foreground focus:outline-none focus:border-focus"
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
            <label className="block text-[11px] font-semibold text-muted mb-1 flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-accent" />
              Category Filter
            </label>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg bg-surface-tertiary border border-border text-foreground focus:outline-none focus:border-focus"
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
                <label className="block text-[11px] font-semibold text-muted mb-1">
                  ECU Transmitter Node
                </label>
                <input
                  type="text"
                  value={ecuName}
                  onChange={e => setEcuName(e.target.value)}
                  placeholder="CAN_DO_HUB"
                  className="w-full px-2.5 py-1.5 rounded-lg bg-surface-tertiary border border-border font-mono text-xs text-foreground focus:outline-none focus:border-focus"
                />
              </div>

              <div className="flex flex-col justify-end">
                <Switch
                  isSelected={includeComments}
                  onChange={setIncludeComments}
                  size="sm"
                  aria-label="Include Author & Notes (CM_)"
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-[11px] text-foreground">Include Author & Notes (`CM_`)</span>
                  </Switch.Content>
                </Switch>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col justify-end">
                <Switch
                  isSelected={filterJsonToScope}
                  onChange={setFilterJsonToScope}
                  size="sm"
                  aria-label="Filter JSON to selected scope"
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-[11px] text-foreground">Filter JSON to selected scope</span>
                  </Switch.Content>
                </Switch>
              </div>

              <div className="flex flex-col justify-end">
                <Switch
                  isSelected={jsonMinified}
                  onChange={setJsonMinified}
                  size="sm"
                  aria-label="Compact (Minified) JSON"
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-[11px] text-foreground">Compact (Minified) JSON</span>
                  </Switch.Content>
                </Switch>
              </div>
            </>
          )}
        </div>

        {/* Stats strip */}
        <div className="px-5 py-2.5 bg-surface border-b border-separator flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          {activeFormat === 'dbc' ? (
            <div className="flex items-center gap-4 text-foreground">
              <div>
                <span className="text-muted text-[11px]">CAN Messages (`BO_`): </span>
                <strong className="text-foreground font-mono">{dbcStats.boCount}</strong>
              </div>
              <div>
                <span className="text-muted text-[11px]">Signals (`SG_`): </span>
                <strong className="text-accent font-mono">{dbcStats.sgCount}</strong>
              </div>
              <div>
                <span className="text-muted text-[11px]">Value Tables (`VAL_`): </span>
                <strong className="text-success font-mono">{dbcStats.valCount}</strong>
              </div>
              <div>
                <span className="text-muted text-[11px]">Annotations (`CM_`): </span>
                <strong className="text-warning font-mono">{dbcStats.cmCount}</strong>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4 text-foreground">
              <div>
                <span className="text-muted text-[11px]">Commands: </span>
                <strong className="text-success font-mono">{jsonStats.cmdCount}</strong>
              </div>
              <div>
                <span className="text-muted text-[11px]">Vehicles: </span>
                <strong className="text-foreground font-mono">{jsonStats.vehCount}</strong>
              </div>
              <div>
                <span className="text-muted text-[11px]">Estimated Size: </span>
                <strong className="text-accent font-mono">{jsonStats.kb} KB</strong>
              </div>
            </div>
          )}

          <div className="text-[11px] text-muted">
            {vehicleFilter !== 'all' ? (
              <span>Filtered to: <strong className="text-foreground">{vehicleFilter}</strong></span>
            ) : (
              <span>Scope: <strong className="text-foreground">Entire Catalog</strong></span>
            )}
          </div>
        </div>

        {/* Modal Body */}
        <ModalBody className="flex-1 overflow-y-auto p-5">
          {activeTab === 'preview' ? (
            <div className="relative">
              <pre className="p-4 rounded-xl bg-surface-secondary border border-border font-mono text-xs text-foreground overflow-x-auto leading-relaxed max-h-[420px] select-all">
                {activeContent}
              </pre>
            </div>
          ) : (
            <div className="space-y-4 text-xs text-muted leading-relaxed">
              <div className="p-4 rounded-xl bg-surface-secondary border border-border space-y-2">
                <h4 className="font-bold text-foreground text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-accent" />
                  Automotive Integration Guide
                </h4>
                <p>
                  Vector DBC is the automotive industry standard for CAN packet decoding, supported by open-source and commercial tooling. CAN Do JSON provides full catalog schema fidelity.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold flex items-center gap-1.5">
                    <FileCode className="w-4 h-4 text-accent" />
                    1. SavvyCAN & SocketCAN (.dbc)
                  </strong>
                  <p className="text-muted">
                    Open SavvyCAN → Click <code className="text-accent">File</code> →{' '}
                    <code className="text-accent">Load DBC File</code>. Live CAN frames matching the
                    IDs will immediately decode into named buttons and byte values.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold flex items-center gap-1.5">
                    <FileCode className="w-4 h-4 text-accent" />
                    2. comma.ai / opendbc (.dbc)
                  </strong>
                  <p className="text-muted">
                    Drop the downloaded <code className="text-accent">.dbc</code> file directly into the{' '}
                    <code className="text-foreground">opendbc/</code> repository or custom fork for
                    openpilot CAN message decoding.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold flex items-center gap-1.5">
                    <FileCode className="w-4 h-4 text-accent" />
                    3. Wireshark (.dbc)
                  </strong>
                  <p className="text-muted">
                    In Wireshark, navigate to <code className="text-accent">Analyze</code> →{' '}
                    <code className="text-accent">Enabled Protocols</code> →{' '}
                    <code className="text-foreground">CANopen / CAN</code> and load the DBC database to
                    view live signal names in packet captures.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold flex items-center gap-1.5">
                    <FileJson className="w-4 h-4 text-success" />
                    4. CAN Do Hub / Custom Firmware (.json)
                  </strong>
                  <p className="text-muted">
                    Flash to ESP32 / STM32 CAN controllers, or backup the database for versioning in Git. Contains vehicles, validation constraints, and options.
                  </p>
                </div>
              </div>
            </div>
          )}
        </ModalBody>

        {/* Footer */}
        <ModalFooter className="flex items-center justify-between p-4 px-6 border-t border-separator bg-surface shrink-0">
          <div className="text-xs text-muted">
            {activeFormat === 'dbc' ? (
              <span>{dbcStats.sgCount} Signals across {dbcStats.boCount} CAN Messages</span>
            ) : (
              <span>{jsonStats.cmdCount} Commands in {jsonStats.vehCount} Vehicles ({jsonStats.kb} KB)</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onPress={handleCopy}
              className="dash-outline-btn px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-success" />
                  <span className="text-success">Copied to Clipboard</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy {activeFormat === 'dbc' ? 'DBC Text' : 'JSON Text'}</span>
                </>
              )}
            </Button>

            <Button
              variant="primary"
              size="sm"
              onPress={handleDownload}
              className={`px-5 py-2 rounded-full text-xs font-bold inline-flex items-center gap-2 transition shadow-md ${
                activeFormat === 'dbc'
                  ? 'bg-accent hover:bg-accent-hover text-accent-foreground'
                  : 'bg-success hover:bg-success-hover text-success-foreground'
              }`}
            >
              <Download className="w-4 h-4" />
              <span>Download {activeFormat === 'dbc' ? '.dbc File' : '.json File'}</span>
            </Button>
          </div>
        </ModalFooter>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
