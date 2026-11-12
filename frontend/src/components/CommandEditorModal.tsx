import React, { useState, useEffect, useMemo } from 'react';
import {
  Tabs,
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
import { Command, CommandRole, Catalog, CommandOption, CommandStep, ContributorInfo, getCommandContributors } from '../types/catalog';
import { validateCommand, getAllKnownFeatures } from '../utils/canValidator';
import { parseCanCaptureNote } from '../utils/canCaptureParser';
import { compileToByteMap } from '../utils/automationConverters';
import { PayloadByteVisualizer } from './PayloadByteVisualizer';
import { PayloadByteEditor } from './PayloadByteEditor';
import { StateDefinitionsEditor } from './StateDefinitionsEditor';
import { MdiIcon, COMMON_HA_DOMAINS, SUGGESTED_MDI_ICONS, getHaDomainBadgeStyle } from './MdiIcon';
import {
  X,
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Info,
  Layers,
  Sparkles,
  Github,
  User,
  Car,
  FileText,
  ChevronDown,
  ChevronUp,
  Home
} from 'lucide-react';

interface CommandEditorModalProps {
  initialCommand?: Command | null;
  catalog: Catalog;
  isOpen: boolean;
  onClose: () => void;
  onSave: (cmd: Command, isNew: boolean, originalId?: string) => void;
  onDelete?: (cmdId: string) => void;
  onOpenCanCapture?: () => void;
}

const COMMON_CATEGORIES = [
  'Steering Wheel',
  'Dashboard / Center Console',
  'Comfort & Climate',
  'Vehicle State & Safety',
  'Battery Preconditioning',
  'Cluster OSD Popups',
  'EV Charging Limits',
  'Seats & Steering Wheel Comfort',
  'Cabin Climate Control',
  'Vehicle Actuators & Features',
  'Home Assistant & Cloud',
  'Environment & Weather',
  'Battery & Power',
  'Schedule & Calendar'
];

const COMMAND_TYPES = [
  'can_tx',
  'can_state',
  'popup',
  'precondition',
  'climate_target',
  'param_range',
  'voltage',
  'speed_zero',
  'day_of_week',
  'time_window',
  'webhook',
  'mqtt'
];

export const CommandEditorModal: React.FC<CommandEditorModalProps> = ({
  initialCommand,
  catalog,
  isOpen,
  onClose,
  onSave,
  onDelete,
  onOpenCanCapture
}) => {
  const isNew = !initialCommand;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [formData, setFormData] = useState<Partial<Command>>({
    id: '',
    name: '',
    category: 'Steering Wheel',
    roles: ['trigger'],
    state_can_id: '0x448',
    bus: 0,
    from_payload: '',
    to_payload: '',
    match_payload: '',
    type: 'can_tx',
    requires_feature: '',
    tags: [],
    options: [],
    steps: [],
    popup_message: '',
    delay_ms: 20,
    ha_domain: 'event',
    icon: 'mdi:steering',
    mdi: 'mdi:steering',
    device_class: ''
  });

  const [tagsInput, setTagsInput] = useState('');
  const [activePayloadMode, setActivePayloadMode] = useState<'transition' | 'match' | 'options' | 'steps'>('transition');
  const [isIdManuallyEdited, setIsIdManuallyEdited] = useState(false);
  const [contributorsList, setContributorsList] = useState<ContributorInfo[]>([
    { name: '', github: '', notes: '', tested_vehicle: '', role: '' }
  ]);

  const handleAddContributor = () => {
    setContributorsList(prev => [...prev, { name: '', github: '', notes: '', tested_vehicle: '', role: '' }]);
  };

  const handleUpdateContributor = (index: number, field: keyof ContributorInfo, value: string) => {
    setContributorsList(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleRemoveContributor = (index: number) => {
    setContributorsList(prev => {
      if (prev.length <= 1) {
        return [{ name: '', github: '', notes: '', role: '' }];
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const [showCaptureBox, setShowCaptureBox] = useState(false);
  const [captureNoteText, setCaptureNoteText] = useState('');

  const captureParseResult = useMemo(() => {
    if (!captureNoteText.trim()) return null;
    return parseCanCaptureNote(captureNoteText);
  }, [captureNoteText]);

  const handleApplyCaptureNote = () => {
    if (!captureParseResult?.command) return;
    const cmd = captureParseResult.command;
    setFormData(prev => ({
      ...prev,
      id: cmd.id || prev.id,
      name: cmd.name || prev.name,
      category: cmd.category || prev.category,
      subcategory: cmd.subcategory || prev.subcategory,
      can_id: cmd.can_id || prev.can_id,
      state_can_id: cmd.state_can_id || prev.state_can_id,
      action_can_id: cmd.action_can_id || prev.action_can_id,
      options: cmd.options || prev.options,
      steps: cmd.steps || prev.steps,
      tags: Array.from(new Set([...(prev.tags || []), ...(cmd.tags || [])]))
    }));
    if (cmd.id) setIsIdManuallyEdited(true);
    if (cmd.options && cmd.options.length > 0) {
      setActivePayloadMode('options');
    }
    setShowCaptureBox(false);
  };

  // Compute all available categories from default presets plus active catalog commands
  const availableCategories = useMemo(() => {
    const cats = new Set([
      ...COMMON_CATEGORIES,
      ...catalog.commands.map(c => c.category).filter(Boolean)
    ]);
    return Array.from(cats).sort();
  }, [catalog.commands]);

  // Compute available subcategories (optionally filtered by current category)
  const availableSubcategories = useMemo(() => {
    const subcats = new Set(
      catalog.commands
        .filter(c => !formData.category || c.category.toLowerCase() === formData.category.toLowerCase())
        .map(c => c.subcategory)
        .filter(Boolean) as string[]
    );
    return Array.from(subcats).sort();
  }, [catalog.commands, formData.category]);

  // Populate when modal opens
  useEffect(() => {
    if (initialCommand) {
      const stateCan = initialCommand.state_can_id || initialCommand.network?.state_can_id || initialCommand.can_id || '';
      const actionCan = initialCommand.action_can_id || initialCommand.network?.action_can_id || '';
      setFormData({
        ...initialCommand,
        state_can_id: stateCan,
        action_can_id: actionCan,
        bus: initialCommand.bus ?? initialCommand.network?.bus ?? 0,
      });
      setIsIdManuallyEdited(true);
      setTagsInput(initialCommand.tags?.join(', ') || '');
      const contribs = getCommandContributors(initialCommand);
      if (contribs.length > 0) {
        setContributorsList(
          contribs.map(c => ({
            name: c.name || '',
            github: c.github || '',
            notes: c.notes || initialCommand.notes || '',
            tested_vehicle: c.tested_vehicle || initialCommand.tested_vehicle || '',
            role: c.role || ''
          }))
        );
      } else {
        setContributorsList([{ 
          name: '', 
          github: '', 
          notes: initialCommand.notes || '', 
          tested_vehicle: initialCommand.tested_vehicle || '', 
          role: '' 
        }]);
      }
      if (initialCommand.options && initialCommand.options.length > 0) {
        setActivePayloadMode('options');
      } else if (initialCommand.steps && initialCommand.steps.length > 0) {
        setActivePayloadMode('steps');
      } else if (initialCommand.match_payload || initialCommand.match) {
        setActivePayloadMode('match');
      } else {
        setActivePayloadMode('transition');
      }
    } else {
      setFormData({
        id: '',
        name: '',
        category: 'Steering Wheel',
        roles: ['trigger'],
        state_can_id: '0x',
        bus: 0,
        from_payload: '* * * * * 0*',
        to_payload: '* * * * * 1*',
        match_payload: '',
        type: 'can_tx',
        requires_feature: '',
        tags: [],
        options: [],
        steps: [],
        popup_message: '',
        delay_ms: 20,
        ha_domain: 'event',
        icon: 'mdi:steering',
        mdi: 'mdi:steering',
        device_class: ''
      });
      setIsIdManuallyEdited(false);
      setTagsInput('');
      setActivePayloadMode('transition');

      // Pre-fill author info from saved local storage if available
      try {
        const saved = localStorage.getItem('can_do_last_contributor');
        if (saved) {
          const parsed = JSON.parse(saved);
          setContributorsList([
            {
              name: parsed.name || '',
              github: parsed.github || '',
              notes: parsed.notes || '',
              tested_vehicle: parsed.tested_vehicle || '',
              role: parsed.role || ''
            }
          ]);
        } else {
          setContributorsList([{ name: '', github: '', notes: '', tested_vehicle: '', role: '' }]);
        }
      } catch {
        setContributorsList([{ name: '', github: '', notes: '', tested_vehicle: '', role: '' }]);
      }
    }
  }, [initialCommand, isOpen]);

  if (!isOpen) return null;

  const knownFeatures = Array.from(getAllKnownFeatures(catalog));
  const issues = validateCommand(formData, catalog, isNew, initialCommand?.id);
  const errors = issues.filter(i => i.type === 'error');
  const warnings = issues.filter(i => i.type === 'warning');
  const canSave = errors.length === 0 && (formData.id?.trim() !== '') && (formData.name?.trim() !== '');

  const handleRoleToggle = (role: CommandRole) => {
    const current = formData.roles || [];
    if (current.includes(role)) {
      if (current.length > 1) {
        setFormData({ ...formData, roles: current.filter(r => r !== role) });
      }
    } else {
      setFormData({ ...formData, roles: [...current, role] });
    }
  };

  const handleNameChange = (name: string) => {
    // If new command and ID hasn't been manually heavily edited, generate a friendly slug
    if (isNew && !isIdManuallyEdited) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      setFormData(prev => ({ ...prev, name, id: slug || 'new_command' }));
    } else {
      setFormData(prev => ({ ...prev, name }));
    }
  };

  const handleIdChange = (raw: string) => {
    setIsIdManuallyEdited(true);
    // Strictly enforce lowercase letters, numbers, and underscores
    // Convert whitespace and hyphens into underscores, strip everything else
    const sanitized = raw
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    setFormData(prev => ({ ...prev, id: sanitized }));
  };

  const handleRegenerateIdFromName = () => {
    if (!formData.name) return;
    const slug = formData.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    setFormData(prev => ({ ...prev, id: slug || 'new_command' }));
    setIsIdManuallyEdited(true);
  };

  const handleTagsChange = (val: string) => {
    setTagsInput(val);
    const split = val
      .split(',')
      .map(t => t.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
      .filter(t => t.length > 0);
    setFormData(prev => ({ ...prev, tags: split }));
  };

  // Option row helpers
  const handleAddOption = () => {
    const newOpt: CommandOption = {
      label: `Option ${(formData.options?.length || 0) + 1}`,
      payload: '00 00 00 00 00 00 00 00',
      default: formData.options?.length === 0
    };
    setFormData(prev => ({
      ...prev,
      options: [...(prev.options || []), newOpt]
    }));
  };

  const handleUpdateOption = (index: number, updated: Partial<CommandOption>) => {
    const updatedOptions = [...(formData.options || [])];
    updatedOptions[index] = { ...updatedOptions[index], ...updated };
    if (updated.default) {
      // Unset other defaults
      updatedOptions.forEach((opt, idx) => {
        if (idx !== index) opt.default = false;
      });
    }
    setFormData(prev => ({ ...prev, options: updatedOptions }));
  };

  const handleRemoveOption = (index: number) => {
    const updatedOptions = (formData.options || []).filter((_, idx) => idx !== index);
    setFormData(prev => ({ ...prev, options: updatedOptions }));
  };

  // Step row helpers
  const handleAddStep = () => {
    const newStep: CommandStep = {
      payload: '00 00 00 00 00 00 00 00',
      repeat: 3
    };
    setFormData(prev => ({
      ...prev,
      steps: [...(prev.steps || []), newStep]
    }));
  };

  const handleUpdateStep = (index: number, updated: Partial<CommandStep>) => {
    const updatedSteps = [...(formData.steps || [])];
    updatedSteps[index] = { ...updatedSteps[index], ...updated };
    setFormData(prev => ({ ...prev, steps: updatedSteps }));
  };

  const handleRemoveStep = (index: number) => {
    const updatedSteps = (formData.steps || []).filter((_, idx) => idx !== index);
    setFormData(prev => ({ ...prev, steps: updatedSteps }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;

    const cleanedId = (formData.id || '').trim().replace(/^_+|_+$/g, '');

    // Clean up fields based on activePayloadMode
    const cleaned: Command = {
      ...formData,
      id: cleanedId,
      name: formData.name!.trim(),
      category: formData.category!.trim(),
      roles: formData.roles || ['trigger'],
      bus: formData.bus ?? 0,
    } as Command;

    if (formData.subcategory && formData.subcategory.trim() !== '') {
      cleaned.subcategory = formData.subcategory.trim();
    } else {
      delete cleaned.subcategory;
    }

    const formatCanId = (id?: string) => {
      if (!id) return undefined;
      const t = id.trim();
      if (!t) return undefined;
      return t.toLowerCase().startsWith('0x') ? `0x${t.slice(2).toUpperCase()}` : `0x${t.toUpperCase()}`;
    };

    if (formData.state_can_id && formData.state_can_id.trim() !== '') {
      cleaned.state_can_id = formatCanId(formData.state_can_id);
    } else {
      delete cleaned.state_can_id;
    }
    if (formData.action_can_id && formData.action_can_id.trim() !== '') {
      cleaned.action_can_id = formatCanId(formData.action_can_id);
    } else {
      delete cleaned.action_can_id;
    }
    delete cleaned.can_id;

    // Ensure network structure is preserved and synchronized
    cleaned.network = {
      ...(formData.network || {}),
      bus: cleaned.bus ?? 0,
      type: cleaned.type || formData.network?.type || (cleaned.action_can_id ? 'can_rx_tx' : 'can_rx'),
      ...(cleaned.state_can_id ? { state_can_id: cleaned.state_can_id } : {}),
      ...(cleaned.action_can_id ? { action_can_id: cleaned.action_can_id } : {}),
    };

    if (activePayloadMode === 'transition') {
      delete cleaned.match_payload;
      delete cleaned.options;
      delete cleaned.steps;
    } else if (activePayloadMode === 'match') {
      delete cleaned.from_payload;
      delete cleaned.to_payload;
      delete cleaned.options;
      delete cleaned.steps;
    } else if (activePayloadMode === 'options') {
      delete cleaned.from_payload;
      delete cleaned.to_payload;
      delete cleaned.match_payload;
      delete cleaned.steps;
    } else if (activePayloadMode === 'steps') {
      delete cleaned.from_payload;
      delete cleaned.to_payload;
      delete cleaned.match_payload;
      delete cleaned.options;
    }

    if (formData.ha_domain && formData.ha_domain.trim() !== '') {
      cleaned.ha_domain = formData.ha_domain.trim();
    } else {
      delete cleaned.ha_domain;
    }

    const iconVal = (formData.icon || formData.mdi || '').trim();
    if (iconVal) {
      const formattedIcon = iconVal.startsWith('mdi:') ? iconVal : `mdi:${iconVal}`;
      cleaned.icon = formattedIcon;
      cleaned.mdi = formattedIcon;
    } else {
      delete cleaned.icon;
      delete cleaned.mdi;
    }

    if (formData.device_class && formData.device_class.trim() !== '') {
      cleaned.device_class = formData.device_class.trim();
    } else {
      delete cleaned.device_class;
    }

    const validContributors = contributorsList
      .map(c => ({
        name: c.name?.trim() || undefined,
        github: c.github?.trim().replace(/^@/, '') || undefined,
        notes: c.notes?.trim() || undefined,
        tested_vehicle: c.tested_vehicle?.trim() || undefined,
        role: c.role?.trim() || undefined
      }))
      .filter(c => Boolean(c.name || c.github || c.notes || c.tested_vehicle || c.role));

    if (validContributors.length > 0) {
      cleaned.contributors = validContributors;
      cleaned.contributor = validContributors[0]; // backward compatibility
      if (validContributors[0].tested_vehicle) {
        cleaned.tested_vehicle = validContributors[0].tested_vehicle;
      } else {
        delete cleaned.tested_vehicle;
      }
      if (validContributors[0].notes) {
        cleaned.notes = validContributors[0].notes;
      } else {
        delete cleaned.notes;
      }
      try {
        localStorage.setItem(
          'can_do_last_contributor',
          JSON.stringify(validContributors[0])
        );
      } catch {}
    } else {
      delete cleaned.contributors;
      delete cleaned.contributor;
      delete cleaned.tested_vehicle;
      delete cleaned.notes;
    }

    onSave(cleaned, isNew, initialCommand?.id);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-4 sm:p-6">
          <ModalDialog className="relative w-full max-w-3xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden my-auto p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="flex items-center justify-between p-5 border-b border-separator bg-surface gap-0">
              <div>
                <ModalHeading className="text-lg md:text-xl font-bold text-foreground flex items-center gap-2">
                  {isNew ? (
                    <>
                      <Sparkles className="w-5 h-5 text-success" />
                      Add New CAN Command
                    </>
                  ) : (
                    <>
                      <Layers className="w-5 h-5 text-warning" />
                      Edit Command: <span className="font-mono text-accent">{formData.id}</span>
                    </>
                  )}
                </ModalHeading>
                <p className="text-xs text-muted mt-0.5">
                  Specify the command details, CAN identifiers, and payload patterns. Real-time validation active.
                </p>
              </div>
              <div className="flex items-center gap-3">
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
              </div>
            </ModalHeader>

        {isNew && (
          <div className="border-b border-separator bg-accent-soft/40">
            <div className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-foreground">
                <FileText className="w-4 h-4 text-accent shrink-0" />
                <span>Have a raw capture note (<code className="font-mono text-warning">!cancapture</code> D1-D8 notation)?</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onPress={() => setShowCaptureBox(!showCaptureBox)}
                className="px-3 py-1.5 rounded-lg bg-surface hover:bg-default-hover border border-accent/40 text-accent font-semibold transition shadow-sm flex items-center gap-1.5 whitespace-nowrap"
              >
                <span>{showCaptureBox ? 'Hide Importer' : 'Paste & Parse Capture Note'}</span>
                {showCaptureBox ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </Button>
            </div>

            {showCaptureBox && (
              <div className="p-4 pt-0 space-y-3">
                <textarea
                  rows={5}
                  value={captureNoteText}
                  onChange={e => setCaptureNoteText(e.target.value)}
                  placeholder="Paste !cancapture note here..."
                  className="w-full font-mono text-xs p-3 rounded-xl bg-surface-secondary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                />
                
                {captureParseResult && (
                  <div className="p-3.5 rounded-xl bg-surface-secondary border border-accent/40 text-xs space-y-3">
                    <div className="flex items-center justify-between text-accent font-semibold">
                      <span>Parsed: {captureParseResult.inferredName}</span>
                      <span className="font-mono text-[10px] bg-accent-soft px-2 py-0.5 rounded text-accent-soft-foreground border border-accent/30">
                        {captureParseResult.command.options?.length || 0} Options / States
                      </span>
                    </div>
                    <div className="text-[11px] text-muted flex flex-wrap gap-x-4 gap-y-1">
                      <span><strong className="text-foreground">Category:</strong> {captureParseResult.category}</span>
                      <span><strong className="text-foreground">Command CAN ID:</strong> {captureParseResult.commandCanId || 'N/A'}</span>
                      <span><strong className="text-foreground">State CAN ID:</strong> {captureParseResult.stateCanId || 'N/A'}</span>
                    </div>

                    {/* D1-D8 Byte Boxes Preview */}
                    {captureParseResult.command.options && captureParseResult.command.options.length > 0 && (
                      <div className="space-y-2 pt-3 border-t border-separator">
                        <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">
                          Decoded Byte Payload Preview:
                        </span>
                        <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                          {captureParseResult.command.options.map((opt, idx) => (
                            <div key={idx} className="p-2 rounded-lg bg-surface-tertiary border border-border text-xs space-y-1.5">
                              <span className="font-bold text-foreground flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-accent"></span>
                                {opt.label}
                              </span>
                              {opt.steps && opt.steps.map((st, sIdx) => (
                                <div key={sIdx} className="space-y-1">
                                  <span className="text-[10px] font-mono text-success">Tx Step:</span>
                                  <PayloadByteVisualizer payload={st.payload} compact={true} />
                                  {st.repeat && st.repeat > 1 && (
                                    <span className="text-[10px] text-warning font-mono">x{st.repeat}</span>
                                  )}
                                </div>
                              ))}
                              {opt.match_payload && (
                                <div className="space-y-1 pt-1">
                                  <span className="text-[10px] font-mono text-accent">State Match:</span>
                                  <PayloadByteVisualizer matchPayload={opt.match_payload} compact={true} />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => setShowCaptureBox(false)}
                    className="dash-outline-btn px-3 py-1.5 text-xs"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    isDisabled={!captureParseResult}
                    onPress={handleApplyCaptureNote}
                    className="px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-bold transition shadow-md disabled:opacity-50"
                  >
                    Apply Note to Form & Tweak
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          <ModalBody className="p-6 max-h-[70vh] overflow-y-auto space-y-5">
            {/* Row 1: Name & ID */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                  Command Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Steering Wheel Star Button"
                  value={formData.name || ''}
                  onChange={e => handleNameChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-sm text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                    Command ID (Slug) <span className="text-danger">*</span>
                  </label>
                  <span className="text-[10px] text-muted font-mono tracking-tight">
                    lowercase_with_underscores
                  </span>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    required
                    placeholder="e.g. sw_star"
                    value={formData.id || ''}
                    onChange={e => handleIdChange(e.target.value)}
                    className="w-full pl-3 pr-8 py-2 rounded-[8px] font-mono text-sm bg-surface-secondary border border-border text-accent placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                  />
                  {formData.name && (
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      onPress={handleRegenerateIdFromName}
                      aria-label="Regenerate slug from command name"
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-accent rounded transition"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
                {!isNew && initialCommand?.id && formData.id && formData.id !== initialCommand.id && (
                  <p className="text-[11px] text-warning mt-1 flex items-center gap-1 font-mono">
                    Renaming: <span className="text-muted line-through">{initialCommand.id}</span> → <span className="text-accent font-semibold">{formData.id}</span>
                  </p>
                )}
              </div>
            </div>

            {/* Row 2: Category, Subcategory & Roles */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                  Category <span className="text-danger">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    list="category-suggestions"
                    required
                    value={formData.category || ''}
                    onChange={e => setFormData({ ...formData, category: e.target.value })}
                    className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-sm text-foreground focus:outline-none focus:border-focus"
                  />
                  <datalist id="category-suggestions">
                    {availableCategories.map(cat => (
                      <option key={cat} value={cat} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                  Subsystem / Group <span className="text-muted font-normal text-[11px]">(Optional)</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    list="subcategory-suggestions"
                    placeholder="e.g. Driver Seat Comfort"
                    value={formData.subcategory || ''}
                    onChange={e => setFormData({ ...formData, subcategory: e.target.value })}
                    className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-sm text-foreground focus:outline-none focus:border-focus placeholder:text-field-placeholder"
                  />
                  <datalist id="subcategory-suggestions">
                    {availableSubcategories.map(subcat => (
                      <option key={subcat} value={subcat} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                  Roles <span className="text-danger">*</span>
                </label>
                <div className="flex items-center gap-2 pt-1">
                  {(['trigger', 'condition', 'action'] as CommandRole[]).map(role => {
                    const isSelected = formData.roles?.includes(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        onClick={() => handleRoleToggle(role)}
                        className={`flex-1 py-1.5 px-3 rounded-full text-xs font-semibold border capitalize transition ${
                          isSelected
                            ? role === 'trigger'
                              ? 'bg-warning-soft text-warning-soft-foreground border-warning shadow-sm'
                              : role === 'condition'
                              ? 'bg-accent-soft text-accent-soft-foreground border-accent shadow-sm'
                              : 'bg-success-soft text-success-soft-foreground border-success shadow-sm'
                            : 'bg-surface-secondary border-border text-muted hover:border-border-secondary hover:text-foreground'
                        }`}
                      >
                        {role}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Row 3: CAN ID, Bus, Type, Action CAN ID */}
            <div className="space-y-3 p-4 rounded-[12px] bg-surface-secondary border border-border">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {formData.action_can_id ? 'State / Rx CAN ID' : 'CAN ID (Hex)'}
                  </label>
                  <input
                    type="text"
                    placeholder="0x448 or 0x438"
                    value={formData.state_can_id || ''}
                    onChange={e => setFormData({ ...formData, state_can_id: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-border font-mono text-sm text-accent focus:outline-none focus:border-focus"
                  />
                  <div className="flex items-center justify-between text-[10px] text-muted mt-1">
                    <span>11-bit (&le;0x7FF) or 29-bit</span>
                    {formData.options && formData.options.length > 0 && (
                      <span className="text-accent font-medium">
                        {formData.options.length} states mapped
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    CAN Bus Index
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="4"
                    value={formData.bus ?? 0}
                    onChange={e => setFormData({ ...formData, bus: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-border font-mono text-sm text-foreground focus:outline-none focus:border-focus"
                  />
                  <span className="text-[10px] text-muted mt-1 block">
                    0 = Primary CAN (C-CAN / E-CAN)
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    Command Type
                  </label>
                  <select
                    value={formData.type || 'can_tx'}
                    onChange={e => {
                      const newType = e.target.value;
                      const updates: Partial<typeof formData> = { type: newType };
                      if (newType === 'popup' && (!formData.ha_domain || formData.ha_domain === 'event' || formData.ha_domain === 'button')) {
                        updates.ha_domain = 'notify';
                        if (!formData.icon || formData.icon === 'mdi:steering') {
                          updates.icon = 'mdi:message-badge';
                          updates.mdi = 'mdi:message-badge';
                        }
                      }
                      setFormData({ ...formData, ...updates });
                    }}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-sm text-foreground focus:outline-none focus:border-focus"
                  >
                    {COMMAND_TYPES.map(t => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <span className="text-[10px] text-muted mt-1 block">
                    Handler protocol type
                  </span>
                </div>
              </div>

              {/* Action CAN ID (Tx) row when action role is enabled or action_can_id is set */}
              {(formData.roles?.includes('action') || formData.action_can_id) && (
                <div className="pt-3 border-t border-separator grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-success mb-1 flex items-center justify-between">
                      <span>Action / Tx CAN ID (Hex)</span>
                      <span className="text-[10px] font-normal text-muted">Optional separate Tx ID</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 0x4A2 (for command transmission)"
                      value={formData.action_can_id || ''}
                      onChange={e => setFormData({ ...formData, action_can_id: e.target.value })}
                      className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-success/40 font-mono text-sm text-success focus:outline-none focus:border-success"
                    />
                    <span className="text-[10px] text-muted mt-1 block">
                      Use when sending commands (Tx) on a different CAN ID than the state sensor (Rx, e.g. 0x4A2 vs 0x438).
                    </span>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-success mb-1">
                      Action Bus Index
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="4"
                      placeholder="Same as primary"
                      value={formData.action_bus !== undefined ? formData.action_bus : ''}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          action_bus: e.target.value === '' ? undefined : parseInt(e.target.value)
                        })
                      }
                      className="w-full px-3 py-1.5 rounded-[8px] bg-surface-tertiary border border-success/40 font-mono text-sm text-foreground focus:outline-none focus:border-success"
                    />
                    <span className="text-[10px] text-muted mt-1 block">
                      Defaults to primary bus ({formData.bus ?? 0}) if empty.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Row 4: Payload Mode Selector */}
            <div id="payload-pattern-config-section">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted flex items-center gap-1.5">
                  <span>Payload Pattern Configuration</span>
                  {formData.state_can_id && (
                    <span className="text-[10px] text-accent font-mono font-normal">
                      for {formData.state_can_id}
                    </span>
                  )}
                </label>
                <Tabs
                  selectedKey={activePayloadMode}
                  onSelectionChange={key => setActivePayloadMode(key as 'transition' | 'match' | 'options' | 'steps')}
                  aria-label="Payload Mode Selection"
                >
                  <Tabs.ListContainer className="p-1 rounded-xl bg-surface-secondary border border-border text-xs font-medium overflow-x-auto no-scrollbar">
                    <Tabs.List className="gap-1 flex-wrap">
                      <Tabs.Tab
                        id="options"
                        className={`relative px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                          activePayloadMode === 'options'
                            ? 'text-accent-foreground'
                            : 'text-muted hover:text-foreground'
                        }`}
                      >
                        <Layers className={`w-3.5 h-3.5 ${activePayloadMode === 'options' ? 'text-accent-foreground' : 'text-accent'}`} />
                        <span>State Definitions ("What State is What")</span>
                        {formData.options && formData.options.length > 0 && (
                          <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                            activePayloadMode === 'options'
                              ? 'bg-accent-foreground/20 text-accent-foreground'
                              : 'bg-accent-soft text-accent-soft-foreground border border-accent/30'
                          }`}>
                            {formData.options.length}
                          </span>
                        )}
                        <Tabs.Indicator className="rounded-lg bg-accent shadow-sm" />
                      </Tabs.Tab>

                      <Tabs.Tab
                        id="transition"
                        className={`relative px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center ${
                          activePayloadMode === 'transition'
                            ? 'text-accent-foreground'
                            : 'text-muted hover:text-foreground'
                        }`}
                      >
                        <span>From / To Transition</span>
                        <Tabs.Indicator className="rounded-lg bg-accent shadow-sm" />
                      </Tabs.Tab>

                      <Tabs.Tab
                        id="match"
                        className={`relative px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center ${
                          activePayloadMode === 'match'
                            ? 'text-accent-foreground'
                            : 'text-muted hover:text-foreground'
                        }`}
                      >
                        <span>Single Match Pattern</span>
                        <Tabs.Indicator className="rounded-lg bg-accent shadow-sm" />
                      </Tabs.Tab>

                      <Tabs.Tab
                        id="steps"
                        className={`relative px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center ${
                          activePayloadMode === 'steps'
                            ? 'text-accent-foreground'
                            : 'text-muted hover:text-foreground'
                        }`}
                      >
                        <span>Burst Steps</span>
                        <Tabs.Indicator className="rounded-lg bg-accent shadow-sm" />
                      </Tabs.Tab>
                    </Tabs.List>
                  </Tabs.ListContainer>
                </Tabs>
              </div>

              {/* Mode 1: Transition */}
              {activePayloadMode === 'transition' && (
                <div className="p-4 rounded-[12px] bg-surface-secondary border border-border space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <PayloadByteEditor
                      label="From Payload (Idle / Released)"
                      value={formData.from_payload || '* * * * * * * *'}
                      onChange={val => setFormData({ ...formData, from_payload: val })}
                    />
                    <PayloadByteEditor
                      label="To Payload (Triggered / Pressed)"
                      value={formData.to_payload || '* * * * * * * *'}
                      onChange={val => setFormData({ ...formData, to_payload: val })}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted pt-1">
                    <span className="text-muted">Syntax Quick Paste:</span>
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          from_payload: '* * * * * * * 0*',
                          to_payload: '* * * * * * * 1*'
                        })
                      }
                      className="px-2 py-0.5 rounded-[6px] bg-surface-tertiary border border-border hover:bg-default-hover text-foreground font-mono transition"
                    >
                      D8 Bit Trigger
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          from_payload: '00 00 00 00 00 00 00 00',
                          to_payload: '00 00 01 00 00 00 00 00'
                        })
                      }
                      className="px-2 py-0.5 rounded-[6px] bg-surface-tertiary border border-border hover:bg-default-hover text-foreground font-mono transition"
                    >
                      D3 Pulse
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          from_payload: '* * * * * 00 * *',
                          to_payload: '* * * * * F8 * *'
                        })
                      }
                      className="px-2 py-0.5 rounded-[6px] bg-surface-tertiary border border-border hover:bg-default-hover text-foreground font-mono transition"
                    >
                      D6 Seat Pulse
                    </button>
                  </div>

                  {/* Real-time Visualizer */}
                  <div className="pt-2">
                    <PayloadByteVisualizer
                      fromPayload={formData.from_payload}
                      toPayload={formData.to_payload}
                    />
                  </div>
                </div>
              )}

              {/* Mode 2: Match */}
              {activePayloadMode === 'match' && (
                <div className="p-4 rounded-[12px] bg-surface-secondary border border-border space-y-3">
                  <PayloadByteEditor
                    label="Match Payload (Sensor / State Condition)"
                    value={formData.match || formData.match_payload || '* * * * * * * *'}
                    onChange={val => setFormData({ ...formData, match_payload: val, match: compileToByteMap(val) })}
                  />

                  <div className="pt-2">
                    <PayloadByteVisualizer matchPayload={formData.match || formData.match_payload} />
                  </div>
                </div>
              )}

              {/* Mode 3: State Definitions ("What State is What") */}
              {activePayloadMode === 'options' && (
                <StateDefinitionsEditor
                  options={formData.options || []}
                  stateCanId={formData.state_can_id}
                  bus={formData.bus ?? 0}
                  actionCanId={formData.action_can_id}
                  knownFeatures={knownFeatures}
                  onChange={newOptions => setFormData(prev => ({ ...prev, options: newOptions }))}
                />
              )}

              {/* Mode 4: Burst Steps */}
              {activePayloadMode === 'steps' && (
                <div className="p-4 rounded-[12px] bg-surface-secondary border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">
                      Sequential Frame Steps ({formData.steps?.length || 0})
                    </span>
                    <button
                      type="button"
                      onClick={handleAddStep}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-accent hover:bg-accent-hover text-accent-foreground text-xs transition font-medium"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Step
                    </button>
                  </div>

                  <div className="space-y-2">
                    {formData.steps?.map((step, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-[10px] bg-surface-tertiary border border-border space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-foreground flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-surface border border-border flex items-center justify-center font-mono text-muted text-[10px]">
                              {idx + 1}
                            </span>
                            Step Payload
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-muted">Repeat:</span>
                            <input
                              type="number"
                              min="1"
                              max="50"
                              value={step.repeat || 1}
                              onChange={e =>
                                handleUpdateStep(idx, { repeat: parseInt(e.target.value) || 1 })
                              }
                              className="w-16 px-2 py-1 rounded-[6px] bg-surface border border-border font-mono text-foreground text-center text-xs focus:outline-none focus:border-focus"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveStep(idx)}
                              className="p-1 hover:text-danger text-muted rounded transition"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <PayloadByteEditor
                          label=""
                          value={step.payload || '* * * * * * * *'}
                          onChange={val => handleUpdateStep(idx, { payload: val })}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Row 5: Required Feature, Tags, Delay */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-muted mb-1">
                  Requires Feature (Vehicle Trim)
                </label>
                <select
                  value={formData.requires_feature || ''}
                  onChange={e => setFormData({ ...formData, requires_feature: e.target.value })}
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-xs text-foreground focus:outline-none focus:border-focus"
                >
                  <option value="">None (Available on all models)</option>
                  {knownFeatures.map(feat => (
                    <option key={feat} value={feat}>
                      {feat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1">
                  Tags (comma separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g. kia_ev6, ioniq5"
                  value={tagsInput}
                  onChange={e => handleTagsChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1">
                  Delay Between Frames (ms)
                </label>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  value={formData.delay_ms ?? 20}
                  onChange={e =>
                    setFormData({ ...formData, delay_ms: parseInt(e.target.value) || 0 })
                  }
                  className="w-full px-3 py-2 rounded-[8px] bg-surface-secondary border border-border font-mono text-xs text-foreground focus:outline-none focus:border-focus"
                />
              </div>
            </div>

            {/* Home Assistant & MDI Integration */}
            <div className="p-4 rounded-xl bg-surface-secondary border border-border space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-accent-soft border border-accent/30 flex items-center justify-center text-accent">
                    <Home className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Home Assistant & MDI Integration (ha_domain, mdi / icon)
                  </span>
                </div>
                <span className="text-[11px] text-muted">
                  Controls entity type and icon rendering across Home Assistant & the catalog
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* HA Domain */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-muted">
                      Home Assistant Domain (ha_domain)
                    </label>
                    {formData.ha_domain && (() => {
                      const domainStyle = getHaDomainBadgeStyle(formData.ha_domain);
                      return (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${domainStyle.bg} ${domainStyle.text} ${domainStyle.border}`}>
                          {formData.ha_domain}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      list="ha-domain-suggestions"
                      placeholder="e.g. event, sensor, binary_sensor"
                      value={formData.ha_domain || ''}
                      onChange={e => setFormData({ ...formData, ha_domain: e.target.value })}
                      className="w-full px-3 py-2 rounded-[8px] bg-surface-tertiary border border-border font-mono text-xs text-accent placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                    />
                    <datalist id="ha-domain-suggestions">
                      {COMMON_HA_DOMAINS.map(d => (
                        <option key={d.id} value={d.id}>
                          {d.label} — {d.description}
                        </option>
                      ))}
                    </datalist>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {['notify', 'event', 'binary_sensor', 'sensor', 'switch', 'climate'].map(d => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setFormData({ ...formData, ha_domain: d })}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition ${
                          formData.ha_domain === d
                            ? 'bg-accent-soft text-accent-soft-foreground border-accent font-bold'
                            : 'bg-surface-tertiary text-muted border-border hover:border-border-secondary hover:text-foreground'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>

                {/* MDI Icon with live preview */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-muted">
                      MDI Icon (mdi / icon)
                    </label>
                    <span className="text-[10px] text-muted font-mono">mdi:icon-name</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className="w-9 h-9 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent shrink-0 shadow-sm"
                      title={formData.icon || formData.mdi || 'No icon set'}
                    >
                      <MdiIcon icon={formData.icon || formData.mdi} className="w-5 h-5" />
                    </div>
                    <div className="relative flex-1">
                      <input
                        type="text"
                        list="mdi-icon-suggestions"
                        placeholder="e.g. mdi:steering"
                        value={formData.icon || formData.mdi || ''}
                        onChange={e => {
                          const val = e.target.value;
                          setFormData({ ...formData, icon: val, mdi: val });
                        }}
                        className="w-full px-3 py-2 rounded-[8px] bg-surface-tertiary border border-border font-mono text-xs text-accent placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                      />
                      <datalist id="mdi-icon-suggestions">
                        {SUGGESTED_MDI_ICONS.map(i => (
                          <option key={i.id} value={i.id}>
                            {i.label} ({i.category})
                          </option>
                        ))}
                      </datalist>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {['mdi:message-badge', 'mdi:steering', 'mdi:thermostat', 'mdi:car-door', 'mdi:car-battery', 'mdi:speedometer'].map(ic => (
                      <button
                        key={ic}
                        type="button"
                        onClick={() => setFormData({ ...formData, icon: ic, mdi: ic })}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition flex items-center gap-1 ${
                          (formData.icon === ic || formData.mdi === ic)
                            ? 'bg-accent-soft text-accent-soft-foreground border-accent font-bold'
                            : 'bg-surface-tertiary text-muted border-border hover:border-border-secondary hover:text-foreground'
                        }`}
                      >
                        <MdiIcon icon={ic} className="w-2.5 h-2.5" />
                        <span>{ic.replace('mdi:', '')}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Device Class */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-muted">
                      Device Class <span className="text-muted font-normal text-[11px]">(Optional)</span>
                    </label>
                    <span className="text-[10px] text-muted">HA component class</span>
                  </div>
                  <input
                    type="text"
                    list="device-class-suggestions"
                    placeholder="e.g. door, window, battery"
                    value={formData.device_class || ''}
                    onChange={e => setFormData({ ...formData, device_class: e.target.value })}
                    className="w-full px-3 py-2 rounded-[8px] bg-surface-tertiary border border-border font-mono text-xs text-foreground focus:outline-none focus:border-focus placeholder:text-field-placeholder"
                  />
                  <datalist id="device-class-suggestions">
                    {['door', 'window', 'battery', 'battery_charging', 'power', 'temperature', 'speed', 'lock', 'motion', 'problem', 'plug', 'heat'].map(dc => (
                      <option key={dc} value={dc} />
                    ))}
                  </datalist>
                  <p className="text-[10px] text-muted mt-1.5">
                    Controls state display format & icons in Home Assistant.
                  </p>
                </div>
              </div>
            </div>

            {/* Contributor Attribution */}
            <div className="p-4 rounded-xl bg-surface-secondary border border-border space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Github className="w-4 h-4 text-accent" />
                  <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Community Contributor Attribution (Optional)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted hidden sm:inline">
                    Credited on card & detail modal
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    onPress={handleAddContributor}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] bg-accent-soft hover:opacity-90 border border-accent/40 text-accent-soft-foreground text-xs font-semibold transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Contributor</span>
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {contributorsList.map((contrib, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg bg-surface-tertiary border border-border space-y-2.5 relative"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-muted uppercase tracking-wider flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-accent" />
                        Contributor #{idx + 1}
                      </span>
                      {contributorsList.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          onPress={() => handleRemoveContributor(idx)}
                          className="p-1 text-muted hover:text-danger hover:bg-danger-soft rounded transition"
                          aria-label="Remove contributor"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <label className="block text-[10.5px] font-semibold text-muted mb-1">
                          Name / Alias
                        </label>
                        <div className="relative">
                          <User className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            placeholder="e.g. Jane Doe"
                            value={contrib.name || ''}
                            onChange={e => handleUpdateContributor(idx, 'name', e.target.value)}
                            className="w-full pl-8 pr-2 py-1.5 rounded-[8px] bg-surface border border-border text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10.5px] font-semibold text-muted mb-1">
                          GitHub Username
                        </label>
                        <div className="relative">
                          <span className="text-muted absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono">@</span>
                          <input
                            type="text"
                            placeholder="username"
                            value={contrib.github || ''}
                            onChange={e => handleUpdateContributor(idx, 'github', e.target.value.replace(/^@/, ''))}
                            className="w-full pl-7 pr-2 py-1.5 rounded-[8px] bg-surface border border-border font-mono text-xs text-accent placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10.5px] font-semibold text-muted mb-1">
                          Role / Tag
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Discovery, Tester"
                          value={contrib.role || ''}
                          onChange={e => handleUpdateContributor(idx, 'role', e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-[8px] bg-surface border border-border text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2.5 border-t border-separator">
                      <div>
                        <label className="block text-[10.5px] font-semibold text-success mb-1 flex items-center gap-1.5">
                          <Car className="w-3.5 h-3.5 text-success" />
                          <span>Tested Vehicle</span>
                        </label>
                        <div className="relative">
                          <select
                            value={contrib.tested_vehicle || ''}
                            onChange={e => handleUpdateContributor(idx, 'tested_vehicle', e.target.value)}
                            className="w-full pl-2.5 pr-8 py-1.5 rounded-[8px] bg-surface border border-success/40 focus:border-success text-xs text-success focus:outline-none appearance-none cursor-pointer"
                          >
                            <option value="" className="bg-overlay text-muted">
                              -- Select tested vehicle from catalog --
                            </option>
                            {contrib.tested_vehicle && !catalog.vehicles?.some(v => {
                              const label = v.make === 'Universal' 
                                ? (v.name || 'All Gen5W Models') 
                                : `${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ''}${v.region && v.region !== 'universal' ? ` (${v.region.toUpperCase()})` : ''}`;
                              return contrib.tested_vehicle === label || contrib.tested_vehicle === v.id || contrib.tested_vehicle === v.name;
                            }) && (
                              <option value={contrib.tested_vehicle} className="bg-overlay text-success">
                                {contrib.tested_vehicle} (Custom)
                              </option>
                            )}
                            {catalog.vehicles?.map(v => {
                              const label = v.make === 'Universal' 
                                ? (v.name || 'All Gen5W Models') 
                                : `${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ''}${v.region && v.region !== 'universal' ? ` (${v.region.toUpperCase()})` : ''}`;
                              return (
                                <option key={v.id} value={label} className="bg-overlay text-overlay-foreground">
                                  {label}
                                </option>
                              );
                            })}
                          </select>
                          <ChevronDown className="w-3.5 h-3.5 text-success absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10.5px] font-semibold text-accent mb-1 flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5 text-accent" />
                          <span>Notes</span>
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Decoded from CAN-FD frame 463; requires ACC mode"
                          value={contrib.notes || ''}
                          onChange={e => handleUpdateContributor(idx, 'notes', e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-[8px] bg-surface border border-accent/40 focus:border-focus text-xs text-foreground placeholder:text-field-placeholder focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Live Validation Box */}
            <div className="p-3 rounded-[10px] bg-surface-secondary border border-border text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  {errors.length === 0 ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-success" />
                      <span className="text-success">Catalog Validation: Valid</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-4 h-4 text-danger" />
                      <span className="text-danger">
                        {errors.length} Error{errors.length > 1 ? 's' : ''} must be resolved
                      </span>
                    </>
                  )}
                </span>
                {warnings.length > 0 && (
                  <span className="text-warning font-medium">
                    {warnings.length} Warning{warnings.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {errors.map((err, i) => (
                <div key={i} className="text-danger pl-5">
                  • {err.message}
                </div>
              ))}
              {warnings.map((w, i) => (
                <div key={i} className="text-warning pl-5">
                  • {w.message}
                </div>
              ))}
            </div>
          </ModalBody>

          {/* Modal Footer */}
          <ModalFooter className="flex items-center justify-between p-4 px-6 border-t border-separator bg-surface shrink-0">
            <div>
              {!isNew && onDelete && initialCommand && (
                confirmDelete ? (
                  <div className="flex items-center gap-1.5 bg-danger-soft border border-danger/40 px-2.5 py-1 rounded-lg">
                    <span className="text-xs font-semibold text-danger-soft-foreground">Delete this command?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      onPress={() => {
                        onDelete(initialCommand.id);
                        onClose();
                      }}
                      className="px-2 py-0.5 bg-danger hover:bg-danger-hover text-danger-foreground rounded font-bold text-xs transition"
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => setConfirmDelete(false)}
                      className="px-2 py-0.5 bg-surface-secondary hover:bg-default-hover text-foreground border border-border rounded text-xs transition"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => setConfirmDelete(true)}
                    className="dash-outline-btn inline-flex items-center gap-1.5 text-xs py-2 px-3 text-muted hover:text-danger hover:border-danger/40"
                    aria-label="Delete this command"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Command
                  </Button>
                )
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onPress={onClose}
                className="dash-outline-btn px-4 py-2 text-xs font-semibold"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                isDisabled={!canSave}
                className={`px-5 py-2 rounded-full text-xs font-semibold shadow transition ${
                  canSave
                    ? 'bg-accent hover:bg-accent-hover text-accent-foreground'
                    : 'bg-surface-secondary text-muted cursor-not-allowed'
                }`}
              >
                {isNew ? 'Add to Catalog' : 'Save Changes'}
              </Button>
            </div>
          </ModalFooter>
        </form>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
