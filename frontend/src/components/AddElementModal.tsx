import React, { useState, useMemo, useEffect } from 'react';
import {
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';
import { Catalog, Command, CommandOption } from '../types/catalog';
import {
  commandToTrigger,
  commandToCondition,
  commandToAction
} from '../utils/automationConverters';
import {
  Radio,
  Clock,
  Bluetooth,
  Cpu,
  Sliders,
  Zap,
  Code,
  GitFork,
  Split,
  Sparkles,
  MessageSquare,
  Thermometer,
  Search,
  X,
  ChevronRight,
  Shield,
  Send
} from 'lucide-react';

export interface AddElementTarget {
  type: 'trigger' | 'condition' | 'action';
  title?: string;
  contextHint?: string;
  onAdd: (item: any) => void;
}

interface AddElementModalProps {
  target: AddElementTarget;
  catalog: Catalog;
  availableTriggers?: AutomationTrigger[];
  onClose: () => void;
}

interface BuildingBlockDef {
  id: string;
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  create: () => any;
}

export const AddElementModal: React.FC<AddElementModalProps> = ({
  target,
  catalog,
  availableTriggers = [],
  onClose
}) => {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'blocks' | 'catalog'>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Trigger entrance animation immediately after mount
    const raf = requestAnimationFrame(() => {
      setIsOpen(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const categories = useMemo(() => {
    return Array.from(new Set(catalog.commands.map(c => c.category))).filter(Boolean);
  }, [catalog]);

  const query = search.toLowerCase().trim();

  // Building blocks definitions per element type
  const buildingBlocks: BuildingBlockDef[] = useMemo(() => {
    if (target.type === 'trigger') {
      return [
        {
          id: 'custom_can',
          title: 'Custom CAN Trigger',
          desc: 'Trigger on raw CAN ID, byte value transitions, or button click gestures',
          icon: Radio,
          color: 'text-amber-400 bg-amber-950/40 border-amber-800/60',
          create: (): AutomationTrigger => ({
            id: `trig_${Date.now().toString(36)}`,
            source: 'can',
            can_id: '',
            bus: 0,
            click_count: 1,
            byte: '',
            mask: '',
            from: '',
            to: '',
            match: {}
          })
        },
        {
          id: 'clock_schedule',
          title: 'Time / Clock Schedule',
          desc: 'Fire at specific daily clock time (24h) on designated days of week',
          icon: Clock,
          color: 'text-cyan-400 bg-cyan-950/40 border-cyan-800/60',
          create: (): AutomationTrigger => ({
            id: `trig_time_${Date.now().toString(36)}`,
            source: 'time',
            type: 'time_schedule',
            time: '',
            days: []
          })
        },
        {
          id: 'ble_button',
          title: 'Bluetooth Remote / Keypad Button',
          desc: 'Fire on wireless media buttons (Volume +/-, Next/Prev, Play/Pause, Shutter) or wireless macro keys',
          icon: Bluetooth,
          color: 'text-blue-400 bg-blue-950/40 border-blue-800/60',
          create: (): AutomationTrigger => ({
            id: `trig_ble_${Date.now().toString(36)}`,
            source: 'ble',
            type: 'ble_button',
            ble_button: 'volume_up',
            ble_action: 'press'
          })
        }
      ];
    }

    if (target.type === 'condition') {
      return [
        {
          id: 'triggered_by',
          title: 'Triggered By (CHOOSE Branching)',
          desc: 'Evaluate which trigger ID initiated this automation execution',
          icon: Radio,
          color: 'text-amber-400 bg-amber-950/40 border-amber-800/60',
          create: (): AutomationCondition => ({
            id: `cond_trig_${Date.now().toString(36)}`,
            type: 'triggered_by',
            trigger_id: ''
          })
        },
        {
          id: 'can_state',
          title: 'Exact CAN Payload Match',
          desc: 'Evaluate live bus byte values with bitmask and equality/range operators',
          icon: Cpu,
          color: 'text-purple-400 bg-purple-950/40 border-purple-800/60',
          create: (): AutomationCondition => ({
            id: `cond_${Date.now().toString(36)}`,
            logic: 'leaf',
            can_id: '',
            bus: 0,
            byte: '',
            mask: '',
            operator: 'equal',
            value: ''
          })
        },
        {
          id: 'time_window',
          title: 'Time Window / Schedule',
          desc: 'Permit execution only during designated hours or weekdays',
          icon: Clock,
          color: 'text-cyan-400 bg-cyan-950/40 border-cyan-800/60',
          create: (): AutomationCondition => ({
            id: `cond_time_${Date.now().toString(36)}`,
            type: 'time_condition',
            start_time: '',
            end_time: '',
            days: []
          })
        },
        {
          id: 'param_range',
          title: 'Parameter / Range Comparison',
          desc: 'Compare speed, battery SOC, temperatures, or gear positions',
          icon: Sliders,
          color: 'text-blue-400 bg-blue-950/40 border-blue-800/60',
          create: (): AutomationCondition => ({
            id: `cond_param_${Date.now().toString(36)}`,
            type: 'param_range',
            can_id: '',
            operator: 'equal',
            value: ''
          })
        },
        {
          id: 'voltage_check',
          title: '12V Battery Voltage Check',
          desc: 'Confirm auxiliary 12V system is above or below threshold voltage',
          icon: Zap,
          color: 'text-yellow-400 bg-yellow-950/40 border-yellow-800/60',
          create: (): AutomationCondition => ({
            id: `cond_volt_${Date.now().toString(36)}`,
            type: 'voltage',
            voltage_dir: 'above',
            voltage_val: ''
          })
        },
        {
          id: 'logic_and',
          title: 'AND Logic Block',
          desc: 'Group multiple child conditions; ALL must evaluate to true',
          icon: Code,
          color: 'text-purple-400 bg-purple-950/40 border-purple-800/60',
          create: (): AutomationCondition => ({
            id: `cond_and_${Date.now().toString(36)}`,
            logic: 'and',
            conditions: []
          })
        },
        {
          id: 'logic_or',
          title: 'OR Logic Block',
          desc: 'Group multiple child conditions; AT LEAST ONE must evaluate to true',
          icon: Code,
          color: 'text-indigo-400 bg-indigo-950/40 border-indigo-800/60',
          create: (): AutomationCondition => ({
            id: `cond_or_${Date.now().toString(36)}`,
            logic: 'or',
            conditions: []
          })
        },
        {
          id: 'logic_not',
          title: 'NOT Logic Block',
          desc: 'Invert condition outcome; nested condition must evaluate to false',
          icon: Code,
          color: 'text-rose-400 bg-rose-950/40 border-rose-800/60',
          create: (): AutomationCondition => ({
            id: `cond_not_${Date.now().toString(36)}`,
            logic: 'not',
            conditions: []
          })
        }
      ];
    }

    // Action building blocks
    return [
      {
        id: 'flow_ifthen',
        title: 'If - Then - Else',
        desc: 'Perform actions conditionally based on nested condition evaluation',
        icon: GitFork,
        color: 'text-cyan-400 bg-cyan-950/40 border-cyan-800/60',
        create: (): AutomationAction => ({
          id: `act_ifthen_${Date.now().toString(36)}`,
          type: 'if_then',
          conditions: [],
          then: [],
          else: []
        })
      },
      {
        id: 'flow_choose',
        title: 'Choose (Sequential Branching)',
        desc: 'Multi-branch sequence executing the first matching condition',
        icon: Split,
        color: 'text-blue-400 bg-blue-950/40 border-blue-800/60',
        create: (): AutomationAction => ({
          id: `act_choose_${Date.now().toString(36)}`,
          type: 'choose',
          choices: [],
          default: []
        })
      },
      {
        id: 'entity_command',
        title: 'Entity Command',
        desc: 'Trigger high-level vehicle command (e.g. heated seats, mirrors, doors)',
        icon: Sparkles,
        color: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/60',
        create: (): AutomationAction => ({
          id: `act_ent_${Date.now().toString(36)}`,
          type: 'entity_command',
          entity_id: '',
          command: ''
        })
      },
      {
        id: 'act_can_tx',
        title: 'Transmit CAN Sequence',
        desc: 'Inject raw or custom CAN frames with repeat and delay timing',
        icon: Radio,
        color: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/60',
        create: (): AutomationAction => ({
          id: `act_can_${Date.now().toString(36)}`,
          type: 'can_tx',
          can_id: '',
          bus: 0,
          payload: '',
          repeat: 1,
          delay_ms: 0
        })
      },
      {
        id: 'act_delay',
        title: 'Delay / Wait',
        desc: 'Pause automation execution pipeline for a specified millisecond duration',
        icon: Clock,
        color: 'text-amber-400 bg-amber-950/40 border-amber-800/60',
        create: (): AutomationAction => ({
          id: `act_delay_${Date.now().toString(36)}`,
          type: 'delay',
          delay_ms: 0
        })
      },
      {
        id: 'act_popup',
        title: 'Cluster Popup (OSD)',
        desc: 'Show notification toast message on vehicle cluster or WiCAN UI',
        icon: MessageSquare,
        color: 'text-cyan-400 bg-cyan-950/40 border-cyan-800/60',
        create: (): AutomationAction => ({
          id: `act_pop_${Date.now().toString(36)}`,
          type: 'track_popup',
          level: 'info',
          text: ''
        })
      },
      {
        id: 'climate_target',
        title: 'Dynamic Climate Target',
        desc: 'Adjust driver or passenger setpoint temp and zone conditioning',
        icon: Thermometer,
        color: 'text-rose-400 bg-rose-950/40 border-rose-800/60',
        create: (): AutomationAction => ({
          id: `act_clim_${Date.now().toString(36)}`,
          type: 'climate_target',
          zone: 'driver',
          sync_on: true
        })
      },
      {
        id: 'precondition',
        title: 'Battery Preconditioning',
        desc: 'Trigger vehicle persistent battery preconditioning state machine',
        icon: Zap,
        color: 'text-yellow-400 bg-yellow-950/40 border-yellow-800/60',
        create: (): AutomationAction => ({
          id: `act_precon_${Date.now().toString(36)}`,
          type: 'precondition',
          precon_mode: 'persistent',
          precon_action: 'start'
        })
      }
    ];
  }, [target.type, availableTriggers]);

  // Filter building blocks
  const filteredBlocks = useMemo(() => {
    return buildingBlocks.filter(
      b => !query || b.title.toLowerCase().includes(query) || b.desc.toLowerCase().includes(query)
    );
  }, [buildingBlocks, query]);

  // Filter catalog commands
  const filteredCatalog = useMemo(() => {
    return (catalog?.commands || []).filter(cmd => {
      const cmdName = cmd.name || cmd.ha_metadata?.name || cmd.id || '';
      const cmdId = cmd.id || '';
      const stateCanId = cmd.state_can_id || cmd.network?.state_can_id || '';
      const actionCanId = cmd.action_can_id || cmd.network?.action_can_id || '';
      const matchesSearch =
        !query ||
        cmdName.toLowerCase().includes(query) ||
        cmdId.toLowerCase().includes(query) ||
        stateCanId.toLowerCase().includes(query) ||
        actionCanId.toLowerCase().includes(query) ||
        (cmd.options || []).some(o => o.label.toLowerCase().includes(query));
      const matchesCat = selectedCategory === 'all' || cmd.category === selectedCategory;
      return matchesSearch && matchesCat;
    });
  }, [catalog, query, selectedCategory]);

  const handleSelectBlock = (block: BuildingBlockDef) => {
    target.onAdd(block.create());
    handleClose();
  };

  const handleSelectCatalogItem = (cmd: Command, opt?: CommandOption) => {
    if (target.type === 'trigger') {
      target.onAdd(commandToTrigger(cmd, opt));
    } else if (target.type === 'condition') {
      target.onAdd(commandToCondition(cmd, opt));
    } else {
      target.onAdd(commandToAction(cmd, opt));
    }
    handleClose();
  };

  const typeConfig = {
    trigger: {
      pillText: 'When',
      pillClass: 'bg-amber-950 text-amber-300 border-amber-800/70',
      title: 'Add Trigger',
      icon: Zap,
      iconColor: 'text-amber-400 bg-amber-950/50'
    },
    condition: {
      pillText: 'And if',
      pillClass: 'bg-sky-950 text-sky-300 border-sky-800/70',
      title: 'Add Condition',
      icon: Shield,
      iconColor: 'text-sky-400 bg-sky-950/50'
    },
    action: {
      pillText: 'Then do',
      pillClass: 'bg-emerald-950 text-emerald-300 border-emerald-800/70',
      title: 'Add Action',
      icon: Send,
      iconColor: 'text-emerald-400 bg-emerald-950/50'
    }
  }[target.type];

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm transition-opacity duration-200 ease-out ${
        isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] transition-all duration-200 ease-out transform ${
          isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        }`}
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-3 bg-slate-900/90">
          <div className="flex items-center gap-2.5">
            <span className={`px-2 py-0.5 rounded-full font-bold uppercase text-[10px] tracking-wider border font-mono ${typeConfig.pillClass}`}>
              {typeConfig.pillText}
            </span>
            <div>
              <h3 className="text-sm font-bold text-white leading-snug">
                {target.title || typeConfig.title}
              </h3>
              <p className="text-[11px] text-slate-400">
                {target.contextHint || 'Select a building block or vehicle catalog command'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search Bar & Nav Filter */}
        <div className="p-3 border-b border-slate-800 bg-slate-950/60 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${target.type} elements or catalog commands...`}
              autoFocus
              className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-8 pr-8 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex items-center p-0.5 rounded-xl bg-slate-900 border border-slate-800 text-[11px]">
              <button
                type="button"
                onClick={() => setActiveTab('all')}
                className={`px-2.5 py-1 rounded-lg font-medium transition ${
                  activeTab === 'all'
                    ? 'bg-cyan-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('blocks')}
                className={`px-2.5 py-1 rounded-lg font-medium transition ${
                  activeTab === 'blocks'
                    ? 'bg-cyan-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Blocks ({filteredBlocks.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('catalog')}
                className={`px-2.5 py-1 rounded-lg font-medium transition ${
                  activeTab === 'catalog'
                    ? 'bg-cyan-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Catalog ({filteredCatalog.length})
              </button>
            </div>

            {activeTab !== 'blocks' && categories.length > 0 && (
              <select
                value={selectedCategory}
                onChange={e => setSelectedCategory(e.target.value)}
                className="bg-slate-900 border border-slate-800 rounded-xl px-2 py-1 text-xs text-slate-300 focus:outline-none"
              >
                <option value="all">All Categories</option>
                {categories.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Scrollable Content Body */}
        <div className="p-4 overflow-y-auto space-y-5 flex-1">
          {/* Section 1: Building Blocks */}
          {(activeTab === 'all' || activeTab === 'blocks') && filteredBlocks.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <span>Building Blocks &amp; Flow Control</span>
                <span className="text-slate-600 font-mono">({filteredBlocks.length})</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {filteredBlocks.map(block => {
                  const Icon = block.icon;
                  return (
                    <button
                      key={block.id}
                      type="button"
                      onClick={() => handleSelectBlock(block)}
                      className="group p-3 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-cyan-500/80 hover:bg-slate-800/40 transition text-left flex items-start gap-2.5 cursor-pointer"
                    >
                      <div className={`p-2 rounded-lg border flex-shrink-0 ${block.color}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-white group-hover:text-cyan-300 transition flex items-center justify-between">
                          <span>{block.title}</span>
                          <ChevronRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-cyan-400 transition" />
                        </div>
                        <p className="text-[11px] text-slate-400 line-clamp-2 mt-0.5 leading-relaxed">
                          {block.desc}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 2: Vehicle Catalog Presets */}
          {(activeTab === 'all' || activeTab === 'catalog') && (
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <span>Vehicle Catalog Commands</span>
                <span className="text-slate-600 font-mono">({filteredCatalog.length})</span>
              </div>

              {filteredCatalog.length === 0 ? (
                <div className="p-6 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500">
                  No catalog commands match your search query.
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredCatalog.map(cmd => {
                    const hasOptions = cmd.options && cmd.options.length > 0;
                    return (
                      <div
                        key={cmd.id}
                        className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/90 hover:border-slate-700 transition flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-white truncate">
                                {cmd.name || cmd.ha_metadata?.name || cmd.id}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 font-mono border border-slate-800">
                                {cmd.category}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                              {(cmd.state_can_id || cmd.network?.state_can_id) && (
                                <span>RX: {cmd.state_can_id || cmd.network?.state_can_id}</span>
                              )}
                              {(cmd.action_can_id || cmd.network?.action_can_id) && (
                                <span>TX: {cmd.action_can_id || cmd.network?.action_can_id}</span>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleSelectCatalogItem(cmd)}
                            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                          >
                            Select Command
                          </button>
                        </div>

                        {/* Direct Option/State selection */}
                        {hasOptions && (
                          <div className="pt-2 border-t border-slate-900/90 flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] text-slate-500 font-medium">Or pick state:</span>
                            {cmd.options!.map((opt, optIdx) => (
                              <button
                                key={optIdx}
                                type="button"
                                onClick={() => handleSelectCatalogItem(cmd, opt)}
                                className="px-2 py-0.5 rounded text-[10px] font-mono text-cyan-300 bg-slate-900 hover:bg-cyan-950 hover:text-cyan-200 border border-slate-800 hover:border-cyan-800 transition"
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
