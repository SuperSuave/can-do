import React, { useState, useEffect, useMemo } from 'react';
import { Command, CommandRole, Catalog, CommandOption, CommandStep } from '../types/catalog';
import { validateCommand, getAllKnownFeatures } from '../utils/canValidator';
import { parseCanCaptureNote } from '../utils/canCaptureParser';
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
  const [contributorName, setContributorName] = useState('');
  const [contributorGithub, setContributorGithub] = useState('');
  const [contributorNotes, setContributorNotes] = useState('');

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
      setFormData({ ...initialCommand });
      setIsIdManuallyEdited(true);
      setTagsInput(initialCommand.tags?.join(', ') || '');
      setContributorName(initialCommand.contributor?.name || '');
      setContributorGithub(initialCommand.contributor?.github || '');
      setContributorNotes(initialCommand.contributor?.notes || '');
      if (initialCommand.options && initialCommand.options.length > 0) {
        setActivePayloadMode('options');
      } else if (initialCommand.steps && initialCommand.steps.length > 0) {
        setActivePayloadMode('steps');
      } else if (initialCommand.match_payload) {
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
          setContributorName(parsed.name || '');
          setContributorGithub(parsed.github || '');
          setContributorNotes(parsed.notes || '');
        } else {
          setContributorName('');
          setContributorGithub('');
          setContributorNotes('');
        }
      } catch {
        setContributorName('');
        setContributorGithub('');
        setContributorNotes('');
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

    if (formData.state_can_id && formData.state_can_id.trim() !== '') {
      cleaned.state_can_id = formData.state_can_id.trim();
    } else {
      delete cleaned.state_can_id;
    }
    delete cleaned.can_id;

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

    const trimmedName = contributorName.trim();
    const trimmedGithub = contributorGithub.trim().replace(/^@/, '');
    const trimmedNotes = contributorNotes.trim();

    if (trimmedName || trimmedGithub || trimmedNotes) {
      cleaned.contributor = {
        name: trimmedName || undefined,
        github: trimmedGithub || undefined,
        notes: trimmedNotes || undefined
      };
      try {
        localStorage.setItem(
          'can_do_last_contributor',
          JSON.stringify({
            name: trimmedName,
            github: trimmedGithub,
            notes: trimmedNotes
          })
        );
      } catch {}
    } else {
      delete cleaned.contributor;
    }

    onSave(cleaned, isNew, initialCommand?.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-3xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div>
            <h2 className="text-lg md:text-xl font-bold text-white flex items-center gap-2">
              {isNew ? (
                <>
                  <Sparkles className="w-5 h-5 text-emerald-400" />
                  Add New CAN Command
                </>
              ) : (
                <>
                  <Layers className="w-5 h-5 text-amber-400" />
                  Edit Command: <span className="font-mono text-cyan-400">{formData.id}</span>
                </>
              )}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Specify the command details, CAN identifiers, and payload patterns. Real-time validation active.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {isNew && (
          <div className="border-b border-[var(--border-color)] bg-cyan-950/20">
            <div className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-cyan-200">
                <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>Have a raw capture note (<code className="font-mono text-amber-300">!cancapture</code> D1-D8 notation)?</span>
              </div>
              <button
                type="button"
                onClick={() => setShowCaptureBox(!showCaptureBox)}
                className="px-3 py-1.5 rounded-lg bg-cyan-900 border border-cyan-700 text-white font-semibold hover:bg-cyan-800 transition shadow-sm flex items-center gap-1.5 whitespace-nowrap"
              >
                <span>{showCaptureBox ? 'Hide Importer' : 'Paste & Parse Capture Note'}</span>
                {showCaptureBox ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </div>

            {showCaptureBox && (
              <div className="p-4 pt-0 space-y-3">
                <textarea
                  rows={5}
                  value={captureNoteText}
                  onChange={e => setCaptureNoteText(e.target.value)}
                  placeholder="Paste !cancapture note here..."
                  className="w-full font-mono text-xs p-3 rounded-xl bg-black/60 border border-cyan-800/60 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
                
                {captureParseResult && (
                  <div className="p-3.5 rounded-xl bg-cyan-950/60 border border-cyan-800/60 text-xs space-y-3">
                    <div className="flex items-center justify-between text-cyan-300 font-semibold">
                      <span>Parsed: {captureParseResult.inferredName}</span>
                      <span className="font-mono text-[10px] bg-cyan-900 px-2 py-0.5 rounded text-cyan-200">
                        {captureParseResult.command.options?.length || 0} Options / States
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-300 flex flex-wrap gap-x-4 gap-y-1">
                      <span><strong>Category:</strong> {captureParseResult.category}</span>
                      <span><strong>Command CAN ID:</strong> {captureParseResult.commandCanId || 'N/A'}</span>
                      <span><strong>State CAN ID:</strong> {captureParseResult.stateCanId || 'N/A'}</span>
                    </div>

                    {/* D1-D8 Byte Boxes Preview */}
                    {captureParseResult.command.options && captureParseResult.command.options.length > 0 && (
                      <div className="space-y-2 mt-2 pt-2 border-t border-cyan-800/40">
                        <span className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider">
                          Decoded Byte Payload Preview:
                        </span>
                        <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                          {captureParseResult.command.options.map((opt, idx) => (
                            <div key={idx} className="p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-xs space-y-1.5">
                              <span className="font-bold text-white flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400"></span>
                                {opt.label}
                              </span>
                              {opt.steps && opt.steps.map((st, sIdx) => (
                                <div key={sIdx} className="space-y-1">
                                  <span className="text-[10px] font-mono text-emerald-400">Tx Step:</span>
                                  <PayloadByteVisualizer payload={st.payload} compact={true} />
                                  {st.repeat && st.repeat > 1 && (
                                    <span className="text-[10px] text-amber-300 font-mono">x{st.repeat}</span>
                                  )}
                                </div>
                              ))}
                              {opt.match_payload && (
                                <div className="space-y-1 pt-1">
                                  <span className="text-[10px] font-mono text-cyan-400">State Match:</span>
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
                  <button
                    type="button"
                    onClick={() => setShowCaptureBox(false)}
                    className="px-3 py-1.5 text-xs text-slate-400 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyCaptureNote}
                    disabled={!captureParseResult}
                    className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition shadow-md disabled:opacity-50"
                  >
                    Apply Note to Form & Tweak
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit}>
          <div className="p-6 max-h-[70vh] overflow-y-auto space-y-5">
            {/* Row 1: Name & ID */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                  Command Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Star (⭐) Button"
                  value={formData.name || ''}
                  onChange={e => handleNameChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Command ID (Slug) <span className="text-rose-400">*</span>
                  </label>
                  <span className="text-[10px] text-slate-400 font-mono tracking-tight">
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
                    className="w-full pl-3 pr-8 py-2 rounded-[8px] font-mono text-sm bg-[var(--input-bg)] border border-[var(--border-color)] text-cyan-300 placeholder-slate-600 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                  {formData.name && (
                    <button
                      type="button"
                      onClick={handleRegenerateIdFromName}
                      title="Regenerate slug from command name"
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-cyan-300 rounded transition"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {!isNew && initialCommand?.id && formData.id && formData.id !== initialCommand.id && (
                  <p className="text-[11px] text-amber-400/90 mt-1 flex items-center gap-1 font-mono">
                    Renaming: <span className="text-slate-400 line-through">{initialCommand.id}</span> → <span className="text-cyan-300 font-semibold">{formData.id}</span>
                  </p>
                )}
              </div>
            </div>

            {/* Row 2: Category, Subcategory & Roles */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                  Category <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    list="category-suggestions"
                    required
                    value={formData.category || ''}
                    onChange={e => setFormData({ ...formData, category: e.target.value })}
                    className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-sm text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                  <datalist id="category-suggestions">
                    {availableCategories.map(cat => (
                      <option key={cat} value={cat} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                  Subsystem / Group <span className="text-slate-500 font-normal text-[11px]">(Optional)</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    list="subcategory-suggestions"
                    placeholder="e.g. Driver Seat Comfort"
                    value={formData.subcategory || ''}
                    onChange={e => setFormData({ ...formData, subcategory: e.target.value })}
                    className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-sm text-white focus:outline-none focus:border-[var(--md-sys-color-primary)] placeholder:text-slate-600"
                  />
                  <datalist id="subcategory-suggestions">
                    {availableSubcategories.map(subcat => (
                      <option key={subcat} value={subcat} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                  Roles <span className="text-rose-400">*</span>
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
                              ? 'bg-amber-950/80 text-amber-300 border-amber-500 shadow-sm'
                              : role === 'condition'
                              ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500 shadow-sm'
                              : 'bg-cyan-950/80 text-cyan-300 border-cyan-500 shadow-sm'
                            : 'bg-[var(--input-bg)] border-[var(--border-color)] text-slate-400 hover:border-slate-500'
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
            <div className="space-y-3 p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)]">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    {formData.action_can_id ? 'State / Rx CAN ID' : 'CAN ID (Hex)'}
                  </label>
                  <input
                    type="text"
                    placeholder="0x448 or 0x438"
                    value={formData.state_can_id || ''}
                    onChange={e => setFormData({ ...formData, state_can_id: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-sm text-cyan-300 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                  <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1">
                    <span>11-bit (&le;0x7FF) or 29-bit</span>
                    {formData.options && formData.options.length > 0 && (
                      <span className="text-cyan-400 font-medium">
                        {formData.options.length} states mapped
                      </span>
                    )}
                  </div>

                  {/* Quick State Definition Link */}
                  <div className="mt-2 p-2 rounded-[8px] bg-cyan-950/40 border border-cyan-800/60 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-semibold text-cyan-300 flex items-center gap-1">
                        <Layers className="w-3 h-3 text-cyan-400" />
                        State Definitions ("What state is what")
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-900/80 text-cyan-200 border border-cyan-700/60 font-semibold">
                        {formData.options && formData.options.length > 0
                          ? `${formData.options.length} states`
                          : 'Not set'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      {formData.options && formData.options.length > 0
                        ? formData.options.map(o => o.label).slice(0, 3).join(', ') + (formData.options.length > 3 ? '...' : '')
                        : 'Define what each CAN state means (Park, Drive, Open, Closed, etc.)'}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setActivePayloadMode('options');
                        if (!formData.options || formData.options.length === 0) {
                          handleAddOption();
                        }
                        setTimeout(() => {
                          const el = document.getElementById('payload-pattern-config-section');
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }, 50);
                      }}
                      className="w-full text-center py-1 rounded bg-cyan-900/70 hover:bg-cyan-800 text-cyan-200 border border-cyan-700 text-[11px] font-semibold transition"
                    >
                      {formData.options && formData.options.length > 0
                        ? 'Edit State Mappings ("What state is what")'
                        : '+ Define States for this CAN ID'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    CAN Bus Index
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="4"
                    value={formData.bus ?? 0}
                    onChange={e => setFormData({ ...formData, bus: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-sm text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    0 = Primary CAN (C-CAN / E-CAN)
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
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
                    className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-sm text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  >
                    {COMMAND_TYPES.map(t => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    Handler protocol type
                  </span>
                </div>
              </div>

              {/* Action CAN ID (Tx) row when action role is enabled or action_can_id is set */}
              {(formData.roles?.includes('action') || formData.action_can_id) && (
                <div className="pt-3 border-t border-[var(--border-color)]/60 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-emerald-400 mb-1 flex items-center justify-between">
                      <span>Action / Tx CAN ID (Hex)</span>
                      <span className="text-[10px] font-normal text-slate-400">Optional separate Tx ID</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 0x4A2 (for command transmission)"
                      value={formData.action_can_id || ''}
                      onChange={e => setFormData({ ...formData, action_can_id: e.target.value })}
                      className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-emerald-800/60 font-mono text-sm text-emerald-300 focus:outline-none focus:border-emerald-500"
                    />
                    <span className="text-[10px] text-slate-400 mt-1 block">
                      Use when sending commands (Tx) on a different CAN ID than the state sensor (Rx, e.g. 0x4A2 vs 0x438).
                    </span>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-emerald-400 mb-1">
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
                      className="w-full px-3 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-emerald-800/60 font-mono text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                    <span className="text-[10px] text-slate-400 mt-1 block">
                      Defaults to primary bus ({formData.bus ?? 0}) if empty.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Row 4: Payload Mode Selector */}
            <div id="payload-pattern-config-section">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <span>Payload Pattern Configuration</span>
                  {formData.state_can_id && (
                    <span className="text-[10px] text-cyan-400 font-mono font-normal">
                      for {formData.state_can_id}
                    </span>
                  )}
                </label>
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setActivePayloadMode('options')}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition flex items-center gap-1.5 ${
                      activePayloadMode === 'options'
                        ? 'bg-[var(--md-sys-color-primary)] text-white border-[var(--md-sys-color-primary)] shadow-sm'
                        : 'bg-[var(--input-bg)] border-[var(--border-color)] text-slate-400 hover:text-white'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5 text-cyan-400" />
                    <span>State Definitions ("What State is What")</span>
                    {formData.options && formData.options.length > 0 && (
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800 font-mono font-bold">
                        {formData.options.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivePayloadMode('transition')}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition ${
                      activePayloadMode === 'transition'
                        ? 'bg-[var(--md-sys-color-primary)] text-white border-[var(--md-sys-color-primary)]'
                        : 'bg-[var(--input-bg)] border-[var(--border-color)] text-slate-400 hover:text-white'
                    }`}
                  >
                    From / To Transition
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivePayloadMode('match')}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition ${
                      activePayloadMode === 'match'
                        ? 'bg-[var(--md-sys-color-primary)] text-white border-[var(--md-sys-color-primary)]'
                        : 'bg-[var(--input-bg)] border-[var(--border-color)] text-slate-400 hover:text-white'
                    }`}
                  >
                    Single Match Pattern
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivePayloadMode('steps')}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition ${
                      activePayloadMode === 'steps'
                        ? 'bg-[var(--md-sys-color-primary)] text-white border-[var(--md-sys-color-primary)]'
                        : 'bg-[var(--input-bg)] border-[var(--border-color)] text-slate-400 hover:text-white'
                    }`}
                  >
                    Burst Steps
                  </button>
                </div>
              </div>

              {/* Mode 1: Transition */}
              {activePayloadMode === 'transition' && (
                <div className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-4">
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

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 pt-1">
                    <span className="text-slate-500">Syntax Quick Paste:</span>
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          from_payload: '* * * * * * * 0*',
                          to_payload: '* * * * * * * 1*'
                        })
                      }
                      className="px-2 py-0.5 rounded-[6px] bg-[var(--input-bg)] border border-[var(--border-color)] hover:bg-slate-700 text-slate-300 font-mono"
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
                      className="px-2 py-0.5 rounded-[6px] bg-[var(--input-bg)] border border-[var(--border-color)] hover:bg-slate-700 text-slate-300 font-mono"
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
                      className="px-2 py-0.5 rounded-[6px] bg-[var(--input-bg)] border border-[var(--border-color)] hover:bg-slate-700 text-slate-300 font-mono"
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
                <div className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-3">
                  <PayloadByteEditor
                    label="Match Payload (Sensor / State Condition)"
                    value={formData.match_payload || '* * * * * * * *'}
                    onChange={val => setFormData({ ...formData, match_payload: val })}
                  />

                  <div className="pt-2">
                    <PayloadByteVisualizer matchPayload={formData.match_payload} />
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
                <div className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-400">
                      Sequential Frame Steps ({formData.steps?.length || 0})
                    </span>
                    <button
                      type="button"
                      onClick={handleAddStep}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[var(--md-sys-color-primary)] text-white text-xs hover:opacity-90 transition font-medium"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Step
                    </button>
                  </div>

                  <div className="space-y-2">
                    {formData.steps?.map((step, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-[10px] bg-[var(--input-bg)] border border-[var(--border-color)] space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-white flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center font-mono text-slate-400 text-[10px]">
                              {idx + 1}
                            </span>
                            Step Payload
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-slate-400">Repeat:</span>
                            <input
                              type="number"
                              min="1"
                              max="50"
                              value={step.repeat || 1}
                              onChange={e =>
                                handleUpdateStep(idx, { repeat: parseInt(e.target.value) || 1 })
                              }
                              className="w-16 px-2 py-1 rounded-[6px] bg-[var(--card-bg)] border border-[var(--border-color)] font-mono text-white text-center text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveStep(idx)}
                              className="p-1 hover:text-rose-400 text-slate-500 rounded"
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
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Requires Feature (Vehicle Trim)
                </label>
                <select
                  value={formData.requires_feature || ''}
                  onChange={e => setFormData({ ...formData, requires_feature: e.target.value })}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
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
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Tags (comma separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g. kia_ev6, ioniq5"
                  value={tagsInput}
                  onChange={e => handleTagsChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
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
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
              </div>
            </div>

            {/* Home Assistant & MDI Integration */}
            <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-sky-950/70 border border-sky-800/60 flex items-center justify-center text-sky-400">
                    <Home className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-xs font-bold text-white uppercase tracking-wider">
                    Home Assistant & MDI Integration (ha_domain, mdi / icon)
                  </span>
                </div>
                <span className="text-[11px] text-slate-400">
                  Controls entity type and icon rendering across Home Assistant & the catalog
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* HA Domain */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-300">
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
                      className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-sky-300 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
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
                            ? 'bg-sky-500/20 text-sky-300 border-sky-500 font-bold'
                            : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700'
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
                    <label className="block text-xs font-semibold text-slate-300">
                      MDI Icon (mdi / icon)
                    </label>
                    <span className="text-[10px] text-slate-500 font-mono">mdi:icon-name</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className="w-9 h-9 rounded-lg bg-sky-950/70 border border-sky-800/70 flex items-center justify-center text-sky-400 shrink-0 shadow-sm"
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
                        className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-sky-300 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
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
                            ? 'bg-sky-500/20 text-sky-300 border-sky-500 font-bold'
                            : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700'
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
                    <label className="block text-xs font-semibold text-slate-300">
                      Device Class <span className="text-slate-500 font-normal text-[11px]">(Optional)</span>
                    </label>
                    <span className="text-[10px] text-slate-500">HA component class</span>
                  </div>
                  <input
                    type="text"
                    list="device-class-suggestions"
                    placeholder="e.g. door, window, battery"
                    value={formData.device_class || ''}
                    onChange={e => setFormData({ ...formData, device_class: e.target.value })}
                    className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)] placeholder:text-slate-600"
                  />
                  <datalist id="device-class-suggestions">
                    {['door', 'window', 'battery', 'battery_charging', 'power', 'temperature', 'speed', 'lock', 'motion', 'problem', 'plug', 'heat'].map(dc => (
                      <option key={dc} value={dc} />
                    ))}
                  </datalist>
                  <p className="text-[10px] text-slate-500 mt-1.5">
                    Controls state display format & icons in Home Assistant.
                  </p>
                </div>
              </div>
            </div>

            {/* Contributor Attribution */}
            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Github className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-bold text-white uppercase tracking-wider">
                    Community Contributor Attribution (Optional)
                  </span>
                </div>
                <span className="text-[11px] text-slate-400">
                  Displayed on the CAN block & detail view
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Your Name or Alias
                  </label>
                  <div className="relative">
                    <User className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="e.g. Your Name"
                      value={contributorName}
                      onChange={e => setContributorName(e.target.value)}
                      className="w-full pl-8 pr-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    GitHub Username
                  </label>
                  <div className="relative">
                    <span className="text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono">@</span>
                    <input
                      type="text"
                      placeholder="@github-handle"
                      value={contributorGithub}
                      onChange={e => setContributorGithub(e.target.value.replace(/^@/, ''))}
                      className="w-full pl-7 pr-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-cyan-300 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Tested Vehicle / Notes
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Tested on 2024 Ioniq 5"
                    value={contributorNotes}
                    onChange={e => setContributorNotes(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                </div>
              </div>
            </div>

            {/* Live Validation Box */}
            <div className="p-3 rounded-[10px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  {errors.length === 0 ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span className="text-emerald-300">Catalog Validation: Valid</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-4 h-4 text-rose-400" />
                      <span className="text-rose-300">
                        {errors.length} Error{errors.length > 1 ? 's' : ''} must be resolved
                      </span>
                    </>
                  )}
                </span>
                {warnings.length > 0 && (
                  <span className="text-amber-400 font-medium">
                    {warnings.length} Warning{warnings.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {errors.map((err, i) => (
                <div key={i} className="text-rose-300 pl-5">
                  • {err.message}
                </div>
              ))}
              {warnings.map((w, i) => (
                <div key={i} className="text-amber-300 pl-5">
                  • {w.message}
                </div>
              ))}
            </div>
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-between p-4 px-6 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
            <div>
              {!isNew && onDelete && initialCommand && (
                confirmDelete ? (
                  <div className="flex items-center gap-1.5 bg-rose-950/90 border border-rose-700/80 px-2.5 py-1 rounded-lg">
                    <span className="text-xs font-semibold text-rose-200">Delete this command?</span>
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(initialCommand.id);
                        onClose();
                      }}
                      className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-xs transition"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="dash-outline-btn inline-flex items-center gap-1.5 text-xs py-2 px-3 text-slate-400 hover:text-rose-400 hover:border-rose-800/60"
                    title="Delete this command"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Command
                  </button>
                )
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="dash-outline-btn px-4 py-2 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSave}
                className={`px-5 py-2 rounded-full text-xs font-semibold shadow transition ${
                  canSave
                    ? 'bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                }`}
              >
                {isNew ? 'Add to Catalog' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
