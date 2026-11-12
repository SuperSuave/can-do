import React, { useState, useMemo } from 'react';
import {
  Tabs,
  Switch,
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
  Info
} from 'lucide-react';

interface DbcExportModalProps {
  isOpen: boolean;
  catalog: Catalog;
  onClose: () => void;
  selectedVehicleId?: string;
  selectedCategory?: string;
}

export const DbcExportModal: React.FC<DbcExportModalProps> = ({
  isOpen,
  catalog,
  onClose,
  selectedVehicleId = 'all',
  selectedCategory = 'all'
}) => {
  const [vehicleFilter, setVehicleFilter] = useState<string>(selectedVehicleId);
  const [categoryFilter, setCategoryFilter] = useState<string>(selectedCategory);
  const [ecuName, setEcuName] = useState<string>('CAN_DO_HUB');
  const [includeComments, setIncludeComments] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'preview' | 'help'>('preview');

  // Categories list
  const categories = useMemo(() => {
    const cats = new Set(catalog.commands.map(c => c.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [catalog.commands]);

  // Compute DBC string
  const dbcContent = useMemo(() => {
    return exportToDbc(catalog, {
      vehicleId: vehicleFilter,
      category: categoryFilter,
      ecuName,
      includeComments
    });
  }, [catalog, vehicleFilter, categoryFilter, ecuName, includeComments]);

  // Summary statistics
  const stats = useMemo(() => {
    const lines = dbcContent.split('\n');
    const boCount = lines.filter(l => l.startsWith('BO_ ')).length;
    const sgCount = lines.filter(l => l.trimStart().startsWith('SG_ ')).length;
    const valCount = lines.filter(l => l.startsWith('VAL_ ')).length;
    const cmCount = lines.filter(l => l.startsWith('CM_ ')).length;
    return { boCount, sgCount, valCount, cmCount };
  }, [dbcContent]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(dbcContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const filename =
      vehicleFilter !== 'all'
        ? `can_do_${vehicleFilter}.dbc`
        : `can_do_catalog_v${catalog.can_do_version || 'unknown'}.dbc`;

    const blob = new Blob([dbcContent], { type: 'text/plain;charset=utf-8' });
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
            <ModalHeader className="p-5 border-b border-separator bg-surface shrink-0">
              <div className="flex items-center gap-3 pr-10">
                <div className="w-10 h-10 rounded-xl bg-accent-soft border border-accent/30 flex items-center justify-center text-accent shrink-0">
                  <FileCode className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <ModalHeading className="text-base font-bold text-foreground">Export Vector CAN DBC</ModalHeading>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-soft text-accent-soft-foreground font-mono border border-accent/30">
                      Industry Standard .dbc
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    Compatible with SavvyCAN, comma.ai / opendbc, Wireshark, Vector CANoe, and BusMaster
                  </p>
                </div>
              </div>
            </ModalHeader>

            {/* Upper Right Close Button */}
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={onClose}
              aria-label="Close modal"
              className="absolute top-4 right-4 z-20 !rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border border-border/50 shadow-sm transition-colors"
            >
              <X className="w-4 h-4" />
            </Button>

        {/* Filter Toolbar */}
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
        </div>

        {/* Stats strip */}
        <div className="px-5 py-2.5 bg-surface border-b border-separator flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-4 text-foreground">
            <div>
              <span className="text-muted text-[11px]">CAN Messages (`BO_`): </span>
              <strong className="text-foreground font-mono">{stats.boCount}</strong>
            </div>
            <div>
              <span className="text-muted text-[11px]">Signals (`SG_`): </span>
              <strong className="text-accent font-mono">{stats.sgCount}</strong>
            </div>
            <div>
              <span className="text-muted text-[11px]">Value Tables (`VAL_`): </span>
              <strong className="text-success font-mono">{stats.valCount}</strong>
            </div>
            <div>
              <span className="text-muted text-[11px]">Annotations (`CM_`): </span>
              <strong className="text-warning font-mono">{stats.cmCount}</strong>
            </div>
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
                  <span>DBC Preview</span>
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

        {/* Modal Body */}
        <ModalBody className="flex-1 overflow-y-auto p-5">
          {activeTab === 'preview' ? (
            <div className="relative">
              <pre className="p-4 rounded-xl bg-surface-secondary border border-border font-mono text-xs text-foreground overflow-x-auto leading-relaxed max-h-[420px] select-all">
                {dbcContent}
              </pre>
            </div>
          ) : (
            <div className="space-y-4 text-xs text-muted leading-relaxed">
              <div className="p-4 rounded-xl bg-surface-secondary border border-border space-y-2">
                <h4 className="font-bold text-foreground text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-accent" />
                  Using this DBC in Automotive Tools
                </h4>
                <p>
                  Vector DBC is the cross-platform standard used by virtually all vehicle bus software.
                  Here is how you can use this exported file:
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold">1. SavvyCAN & SocketCAN</strong>
                  <p className="text-muted">
                    Open SavvyCAN → Click <code className="text-accent">File</code> →{' '}
                    <code className="text-accent">Load DBC File</code>. All CAN frames matching the
                    IDs will immediately decode into named buttons and byte values.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold">2. comma.ai / opendbc</strong>
                  <p className="text-muted">
                    Drop the downloaded <code className="text-accent">.dbc</code> file directly into{' '}
                    <code className="text-foreground">opendbc/</code> repository or your custom fork for
                    openpilot CAN message decoding.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold">3. Wireshark</strong>
                  <p className="text-muted">
                    In Wireshark, navigate to <code className="text-accent">Analyze</code> →{' '}
                    <code className="text-accent">Enabled Protocols</code> →{' '}
                    <code className="text-foreground">CANopen / CAN</code> and load the DBC database to
                    view live signal names in packet captures.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-surface-secondary border border-border space-y-1.5">
                  <strong className="text-foreground block font-semibold">4. Python / cantools</strong>
                  <p className="font-mono text-[11px] text-accent">
                    import cantools<br />
                    db = cantools.database.load_file('catalog.dbc')<br />
                    db.decode_message(0x448, b'\x00\x00\x00\x00\x00\x10\x00\x00')
                  </p>
                </div>
              </div>
            </div>
          )}
        </ModalBody>

        {/* Footer */}
        <ModalFooter className="flex items-center justify-between p-4 px-6 border-t border-separator bg-surface shrink-0">
          <div className="text-xs text-muted">
            {stats.sgCount} Signals across {stats.boCount} CAN Messages
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
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
                  <span>Copy DBC Text</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="px-5 py-2 rounded-full text-xs bg-accent hover:bg-accent-hover text-accent-foreground font-bold shadow-md inline-flex items-center gap-2 transition"
            >
              <Download className="w-4 h-4" />
              <span>Download .dbc File</span>
            </button>
          </div>
        </ModalFooter>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
