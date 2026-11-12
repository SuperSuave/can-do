import React, { useState } from 'react';
import {
  Tabs,
  Chip,
  Button,
  Dropdown,
  Label,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Table
} from '@heroui/react';
import { Command, CommandRole, CommandOption, Catalog, getCommandContributors } from '../types/catalog';
import { PayloadByteVisualizer } from './PayloadByteVisualizer';
import { validateCommand } from '../utils/canValidator';
import { exportCommandToDbcSnippet } from '../utils/dbcConverter';
import { formatCommandAsCanCapture } from '../utils/canCaptureParser';
import { MdiIcon, getHaDomainBadgeStyle } from './MdiIcon';
import {
  X,
  Copy,
  Check,
  Edit3,
  Car,
  AlertTriangle,
  Info,
  Layers,
  Code2,
  Cpu,
  Trash2,
  FileCode,
  FileText,
  Home,
  Sparkles,
  Zap,
  Play,
  Radio,
  MoreVertical
} from 'lucide-react';

interface CommandDetailModalProps {
  command: Command | null;
  catalog: Catalog;
  onClose: () => void;
  onEdit: (cmd: Command) => void;
  onDuplicate?: (cmd: Command) => void;
  onDelete?: (cmdId: string) => void;
  onAddToAutomation?: (cmd: Command, role?: CommandRole, option?: CommandOption) => void;
  queuedAutomationKeys?: Set<string>;
  queuedAutomationCount?: number;
  onToggleAutomationQueue?: (cmd: Command, role?: CommandRole, option?: CommandOption) => void;
  onBuildFromAutomationQueue?: () => void;
  onClearAutomationQueue?: () => void;
}

export const getAutomationQueueKey = (
  commandId: string,
  role?: CommandRole,
  option?: CommandOption
): string => {
  const optKey = option
    ? `${option.label ?? ''}#${option.state_value ?? ''}`
    : '';
  return `${commandId}::${role || 'auto'}::${optKey}`;
};

const ROLE_META: { role: CommandRole; letter: string; label: string; className: string }[] = [
  { role: 'trigger', letter: 'T', label: 'Trigger', className: 'trig-pill' },
  { role: 'condition', letter: 'C', label: 'Condition', className: 'cond-pill' },
  { role: 'action', letter: 'A', label: 'Action', className: 'act-pill' }
];

const RoleSummaryPill: React.FC<{ roles?: CommandRole[]; size?: 'sm' | 'md' }> = ({
  roles,
  size = 'md'
}) => {
  const active = ROLE_META.filter(m => roles?.includes(m.role));
  const items = active.length > 0 ? active : [ROLE_META[0]];

  return (
    <Chip
      size="sm"
      variant="secondary"
      aria-label={items.map(i => i.label).join(', ')}
      className={`inline-flex items-center rounded-full bg-surface-secondary border border-border shrink-0 ${
        size === 'md' ? 'px-1.5 py-0.5 gap-1' : 'px-1 py-0.5 gap-0.5'
      }`}
    >
      {items.map(item => (
        <span
          key={item.role}
          title={item.label}
          className={`inline-flex items-center justify-center rounded-full font-bold uppercase leading-none ${item.className} ${
            size === 'md' ? 'w-5 h-5 text-[11px]' : 'w-4 h-4 text-[10px]'
          }`}
        >
          {item.letter}
        </span>
      ))}
    </Chip>
  );
};

export const formatPayloadDisplay = (val: any): string => {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return `0x${val.toString(16).toUpperCase()}`;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'object') {
    if (val.byte && val.operator) {
      const op = val.operator === 'greater_than' ? '>' : val.operator === 'less_than' ? '<' : val.operator === 'equals' ? '==' : val.operator;
      return `${val.byte} ${op} ${val.value ?? ''}`;
    }
    const entries = Object.entries(val);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => `${k}:${v}`).join(' ');
  }
  return String(val);
};

interface CommandActionMenuProps {
  commandName: string;
  copied: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onDuplicate?: () => void;
  onRequestDelete?: () => void;
}

const CommandActionMenu: React.FC<CommandActionMenuProps> = ({
  commandName,
  copied,
  onEdit,
  onCopy,
  onDuplicate,
  onRequestDelete
}) => {
  return (
    <Dropdown>
      <Button
        variant="ghost"
        size="md"
        isIconOnly
        aria-label={`Actions for ${commandName}`}
        className="!rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border-0 transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-[172px] bg-overlay border border-border shadow-overlay">
        <Dropdown.Menu
          aria-label="Command Actions"
          onAction={key => {
            if (key === 'edit') onEdit();
            else if (key === 'duplicate') onDuplicate?.();
            else if (key === 'copy') onCopy();
            else if (key === 'delete') onRequestDelete?.();
          }}
        >
          <Dropdown.Item id="edit" textValue="Edit command">
            <Edit3 className="w-4 h-4 text-accent shrink-0" />
            <Label className="text-accent font-semibold">Edit command</Label>
          </Dropdown.Item>
          {onDuplicate ? (
            <Dropdown.Item id="duplicate" textValue="Duplicate">
              <Layers className="w-4 h-4 text-muted shrink-0" />
              <Label>Duplicate</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="copy" textValue={copied ? 'Copied JSON' : 'Copy JSON'}>
            {copied ? (
              <Check className="w-4 h-4 text-success shrink-0" />
            ) : (
              <Copy className="w-4 h-4 text-muted shrink-0" />
            )}
            <Label>{copied ? 'Copied JSON' : 'Copy JSON'}</Label>
          </Dropdown.Item>
          {onRequestDelete ? (
            <Dropdown.Item id="delete" textValue="Delete" variant="danger">
              <Trash2 className="w-4 h-4 text-danger shrink-0" />
              <Label>Delete</Label>
            </Dropdown.Item>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
};

export const CommandDetailModal: React.FC<CommandDetailModalProps> = ({
  command,
  catalog,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
  onAddToAutomation,
  queuedAutomationKeys,
  queuedAutomationCount = 0,
  onToggleAutomationQueue,
  onBuildFromAutomationQueue,
  onClearAutomationQueue
}) => {
  const [copied, setCopied] = useState(false);
  const [copiedDbc, setCopiedDbc] = useState(false);
  const [copiedCapture, setCopiedCapture] = useState(false);
  const [copiedHaYaml, setCopiedHaYaml] = useState(false);
  const [copiedIcon, setCopiedIcon] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'vehicles' | 'cancapture' | 'homeassistant' | 'raw_json' | 'dbc'>('overview');
  const [selectedOptionIdx, setSelectedOptionIdx] = useState<number>(0);

  if (!command) return null;

  const commandName = command.name || command.ha_metadata?.name || command.id || 'Unnamed Command';
  const dbcSnippet = exportCommandToDbcSnippet(command);

  const haYamlSnippet = (() => {
    const domain = command.ha_domain || 'sensor';
    const iconStr = command.icon || command.mdi || 'mdi:car-info';
    const rxCan = command.state_can_id || command.network?.state_can_id || command.can_id;
    const txCan = command.action_can_id || command.network?.action_can_id;
    const lines: string[] = [
      `# Home Assistant Entity Configuration for CAN-Do`,
      `# Domain: ${domain}`,
      `${domain}:`,
      `  - platform: can_do`,
      `    name: "${commandName}"`,
      `    unique_id: "can_do_${command.id}"`,
      `    icon: "${iconStr}"`
    ];
    if (command.device_class) {
      lines.push(`    device_class: "${command.device_class}"`);
    }
    if (rxCan) {
      lines.push(`    can_id: "${rxCan}"`);
      lines.push(`    bus: ${command.bus ?? command.network?.bus ?? 0}`);
    }
    if (txCan) {
      lines.push(`    action_can_id: "${txCan}"`);
      lines.push(`    action_bus: ${command.action_bus ?? command.network?.bus ?? command.bus ?? 0}`);
    }
    if (command.from_payload) lines.push(`    from_payload: "${formatPayloadDisplay(command.from_payload)}"`);
    if (command.to_payload) lines.push(`    to_payload: "${formatPayloadDisplay(command.to_payload)}"`);
    if (command.match_payload) lines.push(`    match_payload: "${formatPayloadDisplay(command.match_payload)}"`);
    if (command.payload_mask) lines.push(`    payload_mask: "${command.payload_mask}"`);
    if (command.requires_feature) lines.push(`    requires_feature: "${command.requires_feature}"`);
    if (command.options && command.options.length > 0) {
      lines.push(`    options:`);
      command.options.forEach(o => {
        lines.push(`      - label: "${o.label}"`);
        if (o.popup_message) lines.push(`        popup_message: "${o.popup_message}"`);
        if (o.popup_message_imperial) lines.push(`        popup_message_imperial: "${o.popup_message_imperial}"`);
        if (o.payload) lines.push(`        payload: "${formatPayloadDisplay(o.payload)}"`);
        if (o.to_payload) lines.push(`        to_payload: "${formatPayloadDisplay(o.to_payload)}"`);
        if (o.match_payload || o.match) lines.push(`        match_payload: "${formatPayloadDisplay(o.match_payload || o.match)}"`);
        if (o.default) lines.push(`        default: true`);
      });
    }

    if (domain === 'notify' || command.type === 'popup') {
      lines.push('');
      lines.push('# Example Home Assistant Automation / Action Call:');
      lines.push('# action: notify.send_message');
      lines.push('# target:');
      lines.push(`#   entity_id: notify.can_do_${command.id}`);
      lines.push('# data:');
      const sampleMsg = command.options?.find(o => o.popup_message)?.popup_message || command.popup_message || 'Vehicle Alert Toast';
      lines.push(`#   message: "${sampleMsg}"`);
    }

    return lines.join('\n');
  })();

  const issues = validateCommand(command, catalog, false);
  const hasErrors = issues.some(i => i.type === 'error');
  const hasWarnings = issues.some(i => i.type === 'warning');

  // Check vehicle compatibility
  const compatibleVehicles = catalog.vehicles.filter(v => {
    if (command.requires_feature && !v.features.includes(command.requires_feature)) {
      return false;
    }
    if (command.tags && command.tags.length > 0) {
      const matchesAnyTag = command.tags.some(
        tag =>
          v.id.includes(tag) ||
          v.family.includes(tag) ||
          v.model.toLowerCase().replace(/\s+/g, '_').includes(tag)
      );
      if (!matchesAnyTag) return false;
    }
    return true;
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(command, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal isOpen={Boolean(command)} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="top" scroll="inside" className="p-4 sm:p-6 sm:pt-8">
          <ModalDialog className="relative w-full max-w-3xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="p-6 border-b border-separator bg-surface">
              <div className="flex flex-row items-start justify-between gap-4 w-full">
                <div className="min-w-0 flex-1">
                  <ModalHeading className="text-xl md:text-2xl font-bold text-foreground tracking-tight">
                    {commandName}
                  </ModalHeading>
                  <p className="text-xs font-mono text-muted mt-1 flex items-center gap-1.5 flex-wrap">
                    <span>ID: <span className="text-foreground">{command.id}</span></span>
                    <span>•</span>
                    <span>Category: <span className="text-accent font-sans">{command.category}</span></span>
                    {command.subcategory && (
                      <>
                        <span>•</span>
                        <span>Subsystem: <span className="text-accent-soft-foreground font-sans font-semibold bg-accent-soft px-1.5 py-0.5 rounded border border-accent/30">{command.subcategory}</span></span>
                      </>
                    )}
                  </p>
                  {(() => {
                    const contributors = getCommandContributors(command);
                    if (contributors.length === 0) return null;
                    return (
                      <p className="text-xs text-muted mt-1.5 flex items-center gap-1.5 flex-wrap">
                        <span>Discovered &amp; Contributed By:</span>
                        {contributors.map((contrib, idx) => {
                          const handle = contrib.github ? contrib.github.replace(/^@/, '') : '';
                          const displayName = contrib.name || (handle ? `@${handle}` : 'Contributor');
                          return (
                            <React.Fragment key={idx}>
                              {idx > 0 && <span>,</span>}
                              {handle ? (
                                <a
                                  href={`https://github.com/${handle}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-accent hover:underline font-medium"
                                >
                                  {displayName}
                                </a>
                              ) : (
                                <span className="text-foreground font-medium">{displayName}</span>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </p>
                    );
                  })()}

                  {/* Role & CAN ID Metadata Pills below header text */}
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <RoleSummaryPill roles={command.roles} size="md" />
                    {(command.state_can_id || command.network?.state_can_id || command.can_id) && (
                      <Chip size="sm" color="accent" variant="soft" className="font-mono text-xs px-2.5 py-0.5 rounded-[6px] bg-surface-secondary text-accent border border-border">
                        {(command.action_can_id || command.network?.action_can_id)
                          ? `Rx: ${command.state_can_id || command.network?.state_can_id || command.can_id}`
                          : (command.state_can_id || command.network?.state_can_id || command.can_id)}
                      </Chip>
                    )}
                    {(command.action_can_id || command.network?.action_can_id) && (
                      <Chip size="sm" color="success" variant="soft" className="font-mono text-xs px-2.5 py-0.5 rounded-[6px] bg-success-soft text-success-soft-foreground border border-success/40">
                        Tx: {command.action_can_id || command.network?.action_can_id}
                      </Chip>
                    )}
                    {command.type && (
                      <Chip size="sm" variant="secondary" className="text-xs font-mono px-2.5 py-0.5 rounded-[6px] bg-surface-secondary text-foreground border border-border">
                        Type: {command.type}
                      </Chip>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <CommandActionMenu
                    commandName={commandName}
                    copied={copied}
                    onEdit={() => {
                      onClose();
                      onEdit(command);
                    }}
                    onCopy={handleCopy}
                    onDuplicate={
                      onDuplicate
                        ? () => {
                            onDuplicate(command);
                            onClose();
                          }
                        : undefined
                    }
                    onRequestDelete={onDelete ? () => setConfirmDelete(true) : undefined}
                  />

                  <Button
                    variant="ghost"
                    size="md"
                    isIconOnly
                    onPress={onClose}
                    aria-label="Close details modal"
                    className="!rounded-full w-8 h-8 flex items-center justify-center p-0 !bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border-0 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </ModalHeader>

        {/* Tab switcher */}
        <div className="px-6 border-b border-separator bg-surface text-sm">
          <Tabs
            variant="secondary"
            selectedKey={activeTab}
            onSelectionChange={key => setActiveTab(key as typeof activeTab)}
            aria-label="Command Details Tabs"
          >
            <Tabs.ListContainer className="overflow-x-auto no-scrollbar border-b-0">
              <Tabs.List className="gap-1 sm:gap-2">
                <Tabs.Tab
                  id="overview"
                  className={`relative py-3 px-2.5 !w-auto font-medium transition cursor-pointer flex items-center whitespace-nowrap shrink-0 ${
                    activeTab === 'overview'
                      ? 'text-accent font-bold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <Cpu className="w-4 h-4 inline-block mr-1.5 shrink-0" />
                  <span>Parameters</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="vehicles"
                  className={`relative py-3 px-2.5 !w-auto font-medium transition cursor-pointer flex items-center whitespace-nowrap shrink-0 ${
                    activeTab === 'vehicles'
                      ? 'text-accent font-bold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <Car className="w-4 h-4 inline-block mr-1.5 shrink-0" />
                  <span>Vehicles ({compatibleVehicles.length}/{catalog.vehicles.length})</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="cancapture"
                  className={`relative py-3 px-2.5 !w-auto font-medium transition cursor-pointer flex items-center whitespace-nowrap shrink-0 ${
                    activeTab === 'cancapture'
                      ? 'text-accent font-bold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <FileText className="w-4 h-4 inline-block mr-1.5 shrink-0" />
                  <span>Capture</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="raw_json"
                  className={`relative py-3 px-2.5 !w-auto font-medium transition cursor-pointer flex items-center whitespace-nowrap shrink-0 ${
                    activeTab === 'raw_json'
                      ? 'text-accent font-bold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <Code2 className="w-4 h-4 inline-block mr-1.5 shrink-0" />
                  <span>JSON</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="dbc"
                  className={`relative py-3 px-2.5 !w-auto font-medium transition cursor-pointer flex items-center whitespace-nowrap shrink-0 ${
                    activeTab === 'dbc'
                      ? 'text-accent font-bold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <FileCode className="w-4 h-4 inline-block mr-1.5 shrink-0" />
                  <span>DBC</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="homeassistant"
                  className={`relative py-3 px-2.5 !w-auto font-medium transition cursor-pointer flex items-center whitespace-nowrap shrink-0 ${
                    activeTab === 'homeassistant'
                      ? 'text-accent font-bold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <Home className="w-4 h-4 inline-block mr-1.5 text-accent shrink-0" />
                  <span>Home Assistant</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>

        {/* Body content */}
        <ModalBody className="p-6 max-h-[68vh] overflow-y-auto space-y-6">
          {/* Validation Banner if any issues */}
          {(hasErrors || hasWarnings) && (
            <div
              className={`p-3.5 rounded-lg border flex items-start gap-3 text-xs ${
                hasErrors
                  ? 'bg-danger-soft border-danger/40 text-danger-soft-foreground'
                  : 'bg-warning-soft border-warning/40 text-warning-soft-foreground'
              }`}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">
                  {hasErrors ? 'Validation Errors' : 'Validation Warnings'}
                </div>
                {issues.map((iss, i) => (
                  <div key={i}>
                    • {iss.field ? `[${iss.field}] ` : ''}
                    {iss.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Tested Vehicle & Research Notes (when present) */}
              {(() => {
                const contributors = getCommandContributors(command);
                const testedVehicles = Array.from(
                  new Set([
                    ...contributors.map(c => c.tested_vehicle).filter(Boolean),
                    ...(command.tested_vehicle ? [command.tested_vehicle] : [])
                  ] as string[])
                );
                const notes = Array.from(
                  new Set([
                    ...contributors.map(c => c.notes).filter(Boolean),
                    ...(command.notes ? [command.notes] : [])
                  ] as string[])
                );
                if (testedVehicles.length === 0 && notes.length === 0) return null;

                return (
                  <div className="space-y-2">
                    {testedVehicles.length > 0 && (
                      <div className="text-xs text-success-soft-foreground bg-success-soft px-3 py-2 rounded-lg border border-success/40 flex items-center gap-2 flex-wrap">
                        <Car className="w-3.5 h-3.5 text-success shrink-0" />
                        <span className="text-[10px] uppercase font-bold tracking-wider text-success shrink-0">Tested Vehicle:</span>
                        <span className="font-medium">{testedVehicles.join(' • ')}</span>
                      </div>
                    )}
                    {notes.map((note, idx) => (
                      <div key={idx} className="text-xs text-foreground bg-surface-secondary px-3 py-2 rounded-lg border border-border flex items-start gap-2">
                        <FileText className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                        <span className="leading-relaxed">{note}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Payloads section */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">
                  CAN Payload & Byte Transition
                </h4>
                {(() => {
                  const defaultOpt = command.options?.find(o => o.default) || command.options?.[0];
                  return (
                    <PayloadByteVisualizer
                      fromPayload={command.from_payload}
                      toPayload={command.to_payload}
                      matchPayload={command.match_payload || (command.from_payload || command.to_payload ? undefined : (defaultOpt?.match || defaultOpt?.match_payload))}
                      payload={command.payload || (command.from_payload || command.to_payload || command.match_payload ? undefined : ((defaultOpt?.payload || defaultOpt?.steps?.[0]?.payload) as any))}
                      basePayload={(command.network as any)?.base_payload}
                      targetByte={command.network?.state_byte || command.network?.action_byte || (command.network as any)?.byte}
                      numericRange={command.network?.min !== undefined && command.network?.max !== undefined ? { min: command.network.min, max: command.network.max, unit: (command.network as any)?.unit || (command.subcategory === 'Audio & Media' ? ' dB' : '') } : undefined}
                    />
                  );
                })()}
              </div>

              {/* Options / State Breakdown if present */}
              {command.options && command.options.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-accent" />
                      State Definitions & Rx CAN ID Decode Map ({command.options.length} Defined States)
                    </h4>
                    {onEdit && (
                      <button
                        onClick={() => onEdit(command)}
                        className="text-xs text-accent hover:opacity-80 font-semibold flex items-center gap-1 underline"
                      >
                        Edit State Mappings
                      </button>
                    )}
                  </div>
                  <Table className="w-full text-left text-xs overflow-hidden rounded-lg border border-border bg-surface-secondary">
                    <Table.Content aria-label="Defined Discrete States Table">
                      <Table.Header className="bg-surface-tertiary text-muted border-b border-border">
                        <Table.Column id="label" isRowHeader className="p-3 !text-center">State Meaning / Label</Table.Column>
                        <Table.Column id="val" className="p-3 font-mono !text-center">Code / Value</Table.Column>
                        <Table.Column id="rx" className="p-3 font-mono !text-center">RX CAN Match Pattern</Table.Column>
                        <Table.Column id="tx" className="p-3 font-mono !text-center">Action Frame (TX)</Table.Column>
                        <Table.Column id="desc" className="p-3 !text-center">Description / Toast</Table.Column>
                        <Table.Column id="def" className="p-3 !text-center">Default</Table.Column>
                        <Table.Column id="act" className="p-3 !text-center">Automate</Table.Column>
                      </Table.Header>
                      <Table.Body className="divide-y divide-separator font-mono">
                        {command.options.map((opt, idx) => (
                          <Table.Row key={idx} id={String(idx)} className="hover:bg-surface-tertiary/60 transition">
                            <Table.Cell className="p-3 font-sans font-medium text-foreground">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-semibold">{opt.label}</span>
                                {opt.requires_feature && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent-soft border border-accent/30 text-accent-soft-foreground font-mono">
                                    req: {opt.requires_feature}
                                  </span>
                                )}
                              </div>
                            </Table.Cell>
                            <Table.Cell className="p-3 text-accent">
                              {opt.state_value !== undefined && opt.state_value !== '' ? (
                                <span className="bg-accent-soft border border-accent/30 text-accent-soft-foreground px-2 py-0.5 rounded text-[11px] font-bold">
                                  {formatPayloadDisplay(opt.state_value)}
                                </span>
                              ) : opt.evaluate ? (
                                <span className="bg-warning-soft border border-warning/30 px-2 py-0.5 rounded text-[11px] font-bold text-warning-soft-foreground font-mono">
                                  {formatPayloadDisplay(opt.evaluate)}
                                </span>
                              ) : (
                                <span className="text-muted">-</span>
                              )}
                            </Table.Cell>
                            <Table.Cell className="p-3 text-foreground">
                              {(opt.match_payload || opt.match) ? (
                                <span className="text-accent bg-accent-soft px-2 py-0.5 rounded border border-accent/30 font-mono text-[11px]">
                                  {formatPayloadDisplay(opt.match_payload || opt.match)}
                                </span>
                              ) : (
                                <span className="text-muted">-</span>
                              )}
                            </Table.Cell>
                            <Table.Cell className="p-3 text-success">
                              {opt.steps && opt.steps.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1 flex-wrap">
                                    {opt.steps.map((st, sidx) => (
                                      <span
                                        key={sidx}
                                        className="bg-success-soft border border-success/30 text-success-soft-foreground px-1.5 py-0.5 rounded text-[10px]"
                                      >
                                        {formatPayloadDisplay(st.payload)}{' '}
                                        {st.repeat ? (
                                          <span className="text-warning font-bold">x{st.repeat}</span>
                                        ) : null}
                                      </span>
                                    ))}
                                  </div>
                                  {opt.from_payload && (
                                    <span className="text-[10px] text-muted font-sans">
                                      Trigger: <span className="font-mono text-warning">{formatPayloadDisplay(opt.from_payload)}</span>
                                    </span>
                                  )}
                                </div>
                              ) : opt.from_payload || opt.to_payload ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="text-warning">{formatPayloadDisplay(opt.from_payload) || '*'}</span>
                                  <span className="text-muted font-sans">→</span>
                                  <span className="text-success">{formatPayloadDisplay(opt.to_payload) || '*'}</span>
                                  {opt.repeat && opt.repeat > 1 && (
                                    <span className="text-warning font-bold ml-1">x{opt.repeat}</span>
                                  )}
                                </span>
                              ) : opt.payload ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="text-accent">{formatPayloadDisplay(opt.payload)}</span>
                                  {opt.repeat && opt.repeat > 1 && (
                                    <span className="text-warning font-bold ml-1">x{opt.repeat}</span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-muted">-</span>
                              )}
                            </Table.Cell>
                            <Table.Cell className="p-3 font-sans text-muted">
                              {opt.description || opt.popup || opt.popup_message || '-'}
                            </Table.Cell>
                            <Table.Cell className="p-3 text-center">
                              {opt.default ? (
                                <span className="px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase bg-accent-soft text-accent-soft-foreground border border-accent/40">
                                  Default
                                </span>
                              ) : (
                                '-'
                              )}
                            </Table.Cell>
                            <Table.Cell className="p-3 text-right">
                              {(onToggleAutomationQueue || onAddToAutomation) && (() => {
                                const isActionQueued = Boolean(
                                  queuedAutomationKeys?.has(getAutomationQueueKey(command.id, 'action', opt))
                                );
                                const isTriggerQueued = Boolean(
                                  queuedAutomationKeys?.has(getAutomationQueueKey(command.id, 'trigger', opt))
                                );
                                return (
                                  <div className="inline-flex items-center gap-1.5 justify-end">
                                    <button
                                      type="button"
                                      aria-pressed={isActionQueued}
                                      onClick={() => {
                                        if (onToggleAutomationQueue) {
                                          onToggleAutomationQueue(command, 'action', opt);
                                        } else if (onAddToAutomation) {
                                          onAddToAutomation(command, 'action', opt);
                                          onClose();
                                        }
                                      }}
                                      title={
                                        isActionQueued
                                          ? `Remove "${opt.label}" Action from Automation queue`
                                          : `Add "${opt.label}" as Action to Automation queue`
                                      }
                                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border transition shadow-sm ${
                                        isActionQueued
                                          ? 'bg-success text-success-foreground border-success'
                                          : 'bg-success-soft hover:opacity-90 text-success-soft-foreground border-success/40'
                                      }`}
                                    >
                                      {isActionQueued ? (
                                        <Check className="w-3 h-3" />
                                      ) : (
                                        <Play className="w-3 h-3 fill-current" />
                                      )}
                                      <span>Action</span>
                                    </button>
                                    <button
                                      type="button"
                                      aria-pressed={isTriggerQueued}
                                      onClick={() => {
                                        if (onToggleAutomationQueue) {
                                          onToggleAutomationQueue(command, 'trigger', opt);
                                        } else if (onAddToAutomation) {
                                          onAddToAutomation(command, 'trigger', opt);
                                          onClose();
                                        }
                                      }}
                                      title={
                                        isTriggerQueued
                                          ? `Remove "${opt.label}" Trigger from Automation queue`
                                          : `Add "${opt.label}" as Trigger to Automation queue`
                                      }
                                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border transition shadow-sm ${
                                        isTriggerQueued
                                          ? 'bg-warning text-warning-foreground border-warning'
                                          : 'bg-warning-soft hover:opacity-90 text-warning-soft-foreground border-warning/40'
                                      }`}
                                    >
                                      {isTriggerQueued ? (
                                        <Check className="w-3 h-3" />
                                      ) : (
                                        <Radio className="w-3 h-3" />
                                      )}
                                      <span>Trigger</span>
                                    </button>
                                  </div>
                                );
                              })()}
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Content>
                  </Table>
                </div>
              )}

              {/* Sequence Steps if present */}
              {command.steps && command.steps.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">
                    Sequence Steps ({command.steps.length} Frames, Delay: {command.delay_ms ?? 0}ms)
                  </h4>
                  <div className="space-y-2">
                    {command.steps.map((step, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-surface-secondary border border-border text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-5 h-5 rounded-full bg-surface-tertiary flex items-center justify-center text-[10px] font-mono text-muted border border-border">
                            {idx + 1}
                          </span>
                          <span className="font-mono text-accent">{formatPayloadDisplay(step.payload)}</span>
                        </div>
                        <span className="text-muted">
                          Repeat: <strong className="text-foreground">{step.repeat ?? 1}x</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata Grid */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">
                  Parameters & Properties
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-surface-secondary border border-border">
                    <div className="text-muted mb-1">CAN Bus</div>
                    <div className="font-mono text-foreground font-semibold">
                      Bus {command.bus ?? 0}
                    </div>
                  </div>
                  {(command.state_can_id || command.network?.state_can_id || command.can_id || command.action_can_id || command.network?.action_can_id) && (
                    <div className="p-3 rounded-lg bg-surface-secondary border border-border">
                      <div className="text-muted mb-1">Frame Length (DLC)</div>
                      <div className="font-mono text-foreground font-semibold">
                        {(command.network as any)?.dlc || (command as any).dlc || 8} Bytes
                      </div>
                    </div>
                  )}
                  <div className="p-3 rounded-lg bg-surface-secondary border border-border">
                    <div className="text-muted mb-1">Delay (ms)</div>
                    <div className="font-mono text-foreground font-semibold">
                      {command.delay_ms !== undefined ? `${command.delay_ms} ms` : 'Immediate'}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-surface-secondary border border-border">
                    <div className="text-muted mb-1">Required Feature</div>
                    <div className="font-semibold text-success">
                      {command.requires_feature || 'None (Universal)'}
                    </div>
                  </div>
                  {command.ha_domain && (() => {
                    const domainStyle = getHaDomainBadgeStyle(command.ha_domain);
                    return (
                      <div className={`p-3 rounded-lg border ${domainStyle.bg} ${domainStyle.border}`}>
                        <div className="text-muted mb-1 flex items-center justify-between">
                          <span>HA Domain</span>
                          <span className={`w-2 h-2 rounded-full ${domainStyle.dot}`} />
                        </div>
                        <div className={`font-mono font-bold text-sm ${domainStyle.text}`}>
                          {command.ha_domain}
                        </div>
                      </div>
                    );
                  })()}
                  {(command.ha_metadata?.icon || command.icon || command.mdi) && (
                    <div className="p-3 rounded-lg bg-accent-soft border border-accent/30">
                      <div className="text-muted mb-1 flex items-center justify-between">
                        <span>Icon (MDI)</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(command.ha_metadata?.icon || command.icon || command.mdi || '');
                            setCopiedIcon(true);
                            setTimeout(() => setCopiedIcon(false), 2000);
                          }}
                          className="text-muted hover:text-foreground transition"
                          title="Copy icon name"
                        >
                          {copiedIcon ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-accent-soft-foreground truncate">
                        <MdiIcon icon={command.ha_metadata?.icon || command.icon || command.mdi} className="w-4 h-4 text-accent shrink-0" />
                        <span className="truncate">{command.ha_metadata?.icon || command.icon || command.mdi}</span>
                      </div>
                    </div>
                  )}
                  {command.device_class && (
                    <div className="p-3 rounded-lg bg-surface-secondary border border-border">
                      <div className="text-muted mb-1">HA Device Class</div>
                      <div className="font-mono text-accent font-semibold">{command.device_class}</div>
                    </div>
                  )}
                  {command.popup_message && (
                    <div className="p-3 col-span-2 rounded-lg bg-surface-secondary border border-border">
                      <div className="text-muted mb-1">Popup OSD Message</div>
                      <div className="font-mono text-warning">{command.popup_message}</div>
                    </div>
                  )}
                  {command.expression && (
                    <div className="p-3 col-span-2 rounded-lg bg-surface-secondary border border-border">
                      <div className="text-muted mb-1">Logical Expression</div>
                      <div className="font-mono text-accent">{command.expression}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tags */}
              {command.tags && command.tags.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">
                    Platform & Compatibility Tags
                  </h4>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {command.tags.map(tag => (
                      <Chip
                        key={tag}
                        size="sm"
                        variant="secondary"
                        className="text-xs font-mono text-muted bg-surface-secondary px-2 py-0.5 rounded border border-border"
                      >
                        #{tag}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'vehicles' && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-surface-secondary border border-border text-xs text-foreground flex items-center justify-between">
                <div>
                  Required Feature:{' '}
                  <strong className="text-success">
                    {command.requires_feature || 'None (Works on all Gen5W models)'}
                  </strong>
                </div>
                <div>
                  Compatible: <strong className="text-foreground">{compatibleVehicles.length}</strong> /{' '}
                  {catalog.vehicles.length} Trims
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {catalog.vehicles.map(v => {
                  const isCompatible = compatibleVehicles.some(cv => cv.id === v.id);
                  return (
                    <div
                      key={v.id}
                      className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
                        isCompatible
                          ? 'bg-surface-secondary border-border text-foreground'
                          : 'bg-surface border-border/50 text-muted opacity-60'
                      }`}
                    >
                      <div>
                        <div className="font-semibold text-foreground flex items-center gap-1.5">
                          {v.make} {v.model}
                          <span className="text-[11px] font-normal text-muted">
                            ({v.trim})
                          </span>
                        </div>
                        <div className="text-[10px] text-muted font-mono">
                          {v.id} • Region: {v.region}
                        </div>
                      </div>
                      <div>
                        {isCompatible ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-success-soft text-success-soft-foreground border border-success/40">
                            Supported
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-surface-tertiary text-muted border border-border">
                            Missing Feature
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'cancapture' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-accent" />
                  <span>
                    Community <strong className="text-foreground font-mono">!cancapture</strong> note format (D1–D8 notation)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const note = formatCommandAsCanCapture(command);
                    navigator.clipboard.writeText(note);
                    setCopiedCapture(true);
                    setTimeout(() => setCopiedCapture(false), 2000);
                  }}
                  className="dash-outline-btn px-2.5 py-1 text-[11px] inline-flex items-center gap-1"
                >
                  {copiedCapture ? (
                    <>
                      <Check className="w-3 h-3 text-success" />
                      <span className="text-success">Copied Note</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy Note</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="p-4 rounded-xl bg-surface-secondary font-mono text-xs text-accent overflow-x-auto border border-border leading-relaxed select-all">
                {formatCommandAsCanCapture(command)}
              </pre>

              <div className="p-3 rounded-lg bg-surface-secondary border border-border text-[11px] text-muted space-y-1">
                <div className="text-foreground font-semibold">Discord & Forum Sharing:</div>
                <p>
                  • Formatted with D1–D8 byte references, multi-packet steps, and CAN IDs ready to paste directly into community notes.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'raw_json' && (
            <div className="relative">
              <pre className="p-4 rounded-xl bg-surface-secondary font-mono text-xs text-foreground overflow-x-auto border border-border leading-relaxed select-all">
                {JSON.stringify(command, null, 2)}
              </pre>
            </div>
          )}

          {activeTab === 'dbc' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted flex items-center gap-1.5">
                  <FileCode className="w-4 h-4 text-accent" />
                  <span>
                    Standard Vector CAN DBC syntax for CAN ID{' '}
                    <strong className="text-foreground font-mono">{command.state_can_id || command.can_id}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(dbcSnippet);
                    setCopiedDbc(true);
                    setTimeout(() => setCopiedDbc(false), 2000);
                  }}
                  className="dash-outline-btn px-2.5 py-1 text-[11px] inline-flex items-center gap-1"
                >
                  {copiedDbc ? (
                    <>
                      <Check className="w-3 h-3 text-success" />
                      <span className="text-success">Copied DBC</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy DBC</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="p-4 rounded-xl bg-surface-secondary font-mono text-xs text-success overflow-x-auto border border-border leading-relaxed select-all">
                {dbcSnippet}
              </pre>

              <div className="p-3 rounded-lg bg-surface-secondary border border-border text-[11px] text-muted space-y-1">
                <div className="text-foreground font-semibold">DBC Signal Mapping:</div>
                <p>
                  • CAN message defined as <code className="text-accent font-mono">BO_ {parseInt(command.state_can_id || command.can_id || '0', 16)}</code>
                </p>
                <p>
                  • Bit position & length calculated from payload mask <code className="text-accent font-mono">{command.payload_mask}</code>
                </p>
                {command.options && command.options.length > 0 && (
                  <p>
                    • Discrete states exported as DBC Value Table <code className="text-accent font-mono">VAL_</code>
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'homeassistant' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-foreground flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-accent-soft border border-accent/30 flex items-center justify-center text-accent">
                    <Home className="w-3.5 h-3.5" />
                  </div>
                  <span>
                    Home Assistant YAML configuration for <strong className="text-foreground font-mono">{commandName}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(haYamlSnippet);
                    setCopiedHaYaml(true);
                    setTimeout(() => setCopiedHaYaml(false), 2000);
                  }}
                  className="dash-outline-btn px-3 py-1.5 text-xs inline-flex items-center gap-1.5"
                >
                  {copiedHaYaml ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-success" />
                      <span className="text-success">Copied YAML</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy HA YAML</span>
                    </>
                  )}
                </button>
              </div>

              {/* Entity Overview Pills */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="p-2.5 rounded-lg bg-surface-secondary border border-border">
                  <div className="text-muted text-[10.5px] mb-0.5">HA Domain</div>
                  <div className="font-mono font-bold text-accent truncate">
                    {command.ha_domain || 'sensor'}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-secondary border border-border">
                  <div className="text-muted text-[10.5px] mb-0.5">MDI Icon</div>
                  <div className="flex items-center gap-1.5 font-mono text-accent truncate">
                    <MdiIcon icon={command.ha_metadata?.icon || command.icon || command.mdi} className="w-3.5 h-3.5 text-accent shrink-0" />
                    <span className="truncate">{command.ha_metadata?.icon || command.icon || command.mdi || 'mdi:car-info'}</span>
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-secondary border border-border">
                  <div className="text-muted text-[10.5px] mb-0.5">Entity ID</div>
                  <div className="font-mono text-foreground truncate text-[11px]">
                    {command.ha_domain || 'sensor'}.can_do_{command.id}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-secondary border border-border">
                  <div className="text-muted text-[10.5px] mb-0.5">Device Class</div>
                  <div className="font-mono text-success truncate">
                    {command.device_class || 'None'}
                  </div>
                </div>
              </div>

              <pre className="p-4 rounded-xl bg-surface-secondary font-mono text-xs text-accent overflow-x-auto border border-border leading-relaxed select-all">
                {haYamlSnippet}
              </pre>

              <div className="p-3.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-muted space-y-1.5">
                <div className="text-foreground font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-warning" />
                  Home Assistant Metadata Integration Guide
                </div>
                <p>
                  • <strong className="text-foreground">ha_domain</strong>: Maps this CAN message to the appropriate Home Assistant component architecture (<code className="text-warning font-mono">notify</code> for cluster OSD popups and toasts, <code className="text-purple-600 dark:text-purple-400 font-mono">event</code> for button/click triggers, <code className="text-accent font-mono">binary_sensor</code> for two-state latches, <code className="text-success font-mono">switch</code> for controllable outputs).
                </p>
                <p>
                  • <strong className="text-foreground">icon / mdi</strong>: Specifies the standard Material Design Icon (e.g. <code className="text-accent font-mono">{command.icon || command.mdi || 'mdi:steering'}</code>) natively rendered across Home Assistant Lovelace dashboards, mobile apps, and Apple CarPlay/Android Auto.
                </p>
                {command.device_class && (
                  <p>
                    • <strong className="text-foreground">device_class</strong>: Configures native Home Assistant state representation and telemetry units (<code className="text-warning font-mono">{command.device_class}</code>).
                  </p>
                )}
              </div>
            </div>
          )}
        </ModalBody>

        {/* Modal Footer */}
        {(onAddToAutomation || queuedAutomationCount > 0 || copied || (onDelete && confirmDelete)) && (
          <ModalFooter className="flex flex-wrap items-center justify-between gap-3 p-4 px-6 border-t border-separator bg-surface shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              {copied && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                  <Check className="w-3.5 h-3.5" />
                  Copied JSON
                </span>
              )}

              {queuedAutomationCount > 0 && (
                <div className="inline-flex items-center gap-1.5 bg-accent-soft border border-accent/30 px-2.5 py-1 rounded-full text-xs font-semibold text-accent-soft-foreground">
                  <span>{queuedAutomationCount} queued</span>
                  {onClearAutomationQueue && (
                    <button
                      type="button"
                      onClick={onClearAutomationQueue}
                      className="ml-0.5 text-muted hover:text-foreground transition underline"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              {onDelete && confirmDelete && (
                <div className="flex items-center gap-1.5 bg-danger-soft border border-danger/40 px-2.5 py-1 rounded-lg">
                  <span className="text-xs font-semibold text-danger-soft-foreground">Delete command?</span>
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(command.id);
                      onClose();
                    }}
                    className="px-2 py-0.5 bg-danger hover:bg-danger-hover text-danger-foreground rounded font-bold text-xs transition"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-0.5 bg-surface-secondary hover:bg-default-hover text-foreground border border-border rounded text-xs transition"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {(onAddToAutomation || (queuedAutomationCount > 0 && onBuildFromAutomationQueue)) && (
              <div className="flex items-center gap-1.5 ml-auto">
                {queuedAutomationCount === 0 && command.options && command.options.length > 0 && (
                  <select
                    value={selectedOptionIdx}
                    onChange={e => setSelectedOptionIdx(parseInt(e.target.value) || 0)}
                    className="bg-surface-secondary border border-border rounded-full px-3 py-1.5 text-xs text-foreground font-medium focus:outline-none focus:border-focus"
                    title="Select specific state for automation"
                  >
                    {command.options.map((opt, oIdx) => (
                      <option key={oIdx} value={oIdx}>
                        State: {opt.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (queuedAutomationCount > 0 && onBuildFromAutomationQueue) {
                      onBuildFromAutomationQueue();
                      onClose();
                    } else if (onAddToAutomation) {
                      const chosenOpt = command.options && command.options.length > 0
                        ? command.options[selectedOptionIdx] || command.options[0]
                        : undefined;
                      onAddToAutomation(command, undefined, chosenOpt);
                      onClose();
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold text-accent-soft-foreground bg-accent-soft hover:bg-accent hover:text-accent-foreground border border-accent/40 transition shadow-sm"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {queuedAutomationCount > 0
                      ? `Add to Automation (${queuedAutomationCount})`
                      : 'Add to Automation'}
                  </span>
                </button>
              </div>
            )}
          </ModalFooter>
        )}
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
