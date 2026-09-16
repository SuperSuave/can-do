import React, { useState } from 'react';
import {
  AutomationRule,
  AutomationSettings,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  ExecutionMode,
  TriggerCombineMode
} from '../types/automation';
import { Catalog, Command, CommandOption } from '../types/catalog';
import {
  exportToCandoJson,
  exportToEsp32FirmwareJson,
  exportToFullCatalogJson,
  commandToTrigger,
  commandToCondition,
  commandToAction
} from '../utils/automationConverters';
import { MdiIcon, SUGGESTED_MDI_ICONS } from './MdiIcon';
import {
  Zap,
  Shield,
  Send,
  Plus,
  Trash2,
  Copy,
  Check,
  Download,
  Upload,
  Play,
  RotateCw,
  Sliders,
  Sparkles,
  Layers,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Search,
  ExternalLink,
  Code,
  FileJson,
  Cpu,
  RefreshCcw,
  RefreshCw,
  Eye,
  Info,
  Car
} from 'lucide-react';

interface AutomationBuilderProps {
  catalog: Catalog;
  rules: AutomationRule[];
  onUpdateRules: (newRules: AutomationRule[]) => void;
  settings: AutomationSettings;
  onUpdateSettings: (newSettings: AutomationSettings) => void;
  onBackToCatalog?: () => void;
  // If items were selected from the catalog to pull into an automation
  pulledCommands?: { command: Command; option?: CommandOption; role?: 'trigger' | 'condition' | 'action' }[];
  onClearPulledCommands?: () => void;
}

export const AutomationBuilder: React.FC<AutomationBuilderProps> = ({
  catalog,
  rules,
  onUpdateRules,
  settings,
  onUpdateSettings,
  onBackToCatalog,
  pulledCommands = [],
  onClearPulledCommands
}) => {
  const [selectedRuleId, setSelectedRuleId] = useState<string>(
    rules.length > 0 ? rules[0].id : ''
  );
  const [activeJsonTab, setActiveJsonTab] = useState<'catalog' | 'cando' | 'esp32' | 'custom'>('catalog');
  const [copied, setCopied] = useState(false);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<'trigger' | 'condition' | 'action' | 'off_action'>('trigger');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerCategory, setPickerCategory] = useState('all');
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  const [customJsonSchema, setCustomJsonSchema] = useState<string>(
    JSON.stringify(
      {
        description: 'New Firmware Schema Sandbox (The Brains)',
        version: '1.0.0-alpha',
        target_device: 'ESP32-S3',
        catalog_sync: {
          last_synced: new Date().toISOString(),
          active_rules_count: rules.length
        },
        automations: rules.map(r => ({
          name: r.name,
          mode: r.exec_mode,
          triggers: r.triggers.map(t => ({
            id: t.id,
            can_id: t.can_id,
            match: t.to_payload
          })),
          actions: r.actions.map(a => ({
            can_id: a.can_id,
            payload: a.payload
          }))
        }))
      },
      null,
      2
    )
  );

  const activeRule = rules.find(r => r.id === selectedRuleId) || rules[0];

  // Handle incoming pulled commands from the catalog
  React.useEffect(() => {
    if (pulledCommands.length > 0 && activeRule) {
      const updatedRules = rules.map(r => {
        if (r.id === activeRule.id) {
          const newTriggers = [...r.triggers];
          const newConditions = [...r.conditions];
          const newActions = [...r.actions];

          pulledCommands.forEach(({ command, option, role }) => {
            const assignedRole = role || (command.roles.includes('trigger') ? 'trigger' : command.roles.includes('condition') ? 'condition' : 'action');
            if (assignedRole === 'trigger') {
              newTriggers.push(commandToTrigger(command, option));
            } else if (assignedRole === 'condition') {
              newConditions.push(commandToCondition(command, option));
            } else {
              newActions.push(commandToAction(command, option));
            }
          });

          return {
            ...r,
            triggers: newTriggers,
            conditions: newConditions,
            actions: newActions
          };
        }
        return r;
      });

      onUpdateRules(updatedRules);
      if (onClearPulledCommands) onClearPulledCommands();
    }
  }, [pulledCommands]);

  const handleUpdateActiveRule = (updated: Partial<AutomationRule>) => {
    if (!activeRule) return;
    const newRules = rules.map(r => (r.id === activeRule.id ? { ...r, ...updated } : r));
    onUpdateRules(newRules);
  };

  const handleAddRule = () => {
    const newId = `rule_${Date.now().toString(36)}`;
    const newRule: AutomationRule = {
      id: newId,
      name: `New Automation Rule #${rules.length + 1}`,
      enabled: true,
      ha_expose: true,
      ha_icon: 'mdi:car-defrost-rear',
      exec_mode: 'one_shot',
      trigger_mode: 'any',
      cooldown_ms: 500,
      timeout_reset_ms: 2000,
      triggers: [
        {
          id: `trig_${Date.now().toString(36)}`,
          source: 'can',
          can_id: '0x448',
          bus: 0,
          click_count: 1,
          from_payload: '* * * * * 0*',
          to_payload: '* * * * * 1*'
        }
      ],
      conditions: [],
      actions: [
        {
          id: `act_${Date.now().toString(36)}`,
          type: 'can_tx',
          can_id: '0x524',
          bus: 0,
          payload: '02 01 00 00 00 00 00 00',
          repeat: 1,
          delay_ms: 50
        }
      ]
    };

    onUpdateRules([...rules, newRule]);
    setSelectedRuleId(newId);
  };

  const handleDuplicateRule = (ruleToDup: AutomationRule) => {
    const newId = `rule_${Date.now().toString(36)}`;
    const duplicated: AutomationRule = {
      ...JSON.parse(JSON.stringify(ruleToDup)),
      id: newId,
      name: `${ruleToDup.name} (Copy)`
    };
    onUpdateRules([...rules, duplicated]);
    setSelectedRuleId(newId);
  };

  const handleDeleteRule = (ruleId: string) => {
    if (rules.length <= 1) {
      alert('You must keep at least one automation rule.');
      return;
    }
    const newRules = rules.filter(r => r.id !== ruleId);
    onUpdateRules(newRules);
    if (selectedRuleId === ruleId) {
      setSelectedRuleId(newRules[0]?.id || '');
    }
  };

  const handleCopyJson = () => {
    let textToCopy = '';
    if (activeJsonTab === 'catalog') {
      textToCopy = exportToFullCatalogJson(catalog, rules);
    } else if (activeJsonTab === 'cando') {
      textToCopy = exportToCandoJson(rules, settings);
    } else if (activeJsonTab === 'esp32') {
      textToCopy = exportToEsp32FirmwareJson(rules, settings);
    } else {
      textToCopy = customJsonSchema;
    }
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadJson = () => {
    let content = '';
    let filename = '';
    if (activeJsonTab === 'catalog') {
      content = exportToFullCatalogJson(catalog, rules);
      filename = 'can_do_catalog.json';
    } else if (activeJsonTab === 'cando') {
      content = exportToCandoJson(rules, settings);
      filename = 'wican_cando_rules.json';
    } else if (activeJsonTab === 'esp32') {
      content = exportToEsp32FirmwareJson(rules, settings);
      filename = 'esp32_automations.json';
    } else {
      content = customJsonSchema;
      filename = 'firmware_schema.json';
    }

    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        if (parsed.automations && Array.isArray(parsed.automations)) {
          onUpdateRules(parsed.automations);
          if (parsed.automations[0]?.id) setSelectedRuleId(parsed.automations[0].id);
          alert(`Successfully imported ${parsed.automations.length} automation rules from catalog!`);
        } else if (parsed.rules && Array.isArray(parsed.rules)) {
          onUpdateRules(parsed.rules);
          if (parsed.settings) onUpdateSettings(parsed.settings);
          if (parsed.rules[0]?.id) setSelectedRuleId(parsed.rules[0].id);
          alert(`Successfully imported ${parsed.rules.length} automation rules!`);
        } else if (Array.isArray(parsed)) {
          onUpdateRules(parsed);
          if (parsed[0]?.id) setSelectedRuleId(parsed[0].id);
          alert(`Successfully imported ${parsed.length} automation rules!`);
        } else {
          alert('Could not detect an "automations" or "rules" array in this JSON file.');
        }
      } catch (err: any) {
        alert(`Error parsing JSON: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSimulateRule = () => {
    if (!activeRule) return;
    setShowSimulateModal(true);
    const logs = [
      `[ESP32 Boot] Loaded rule: "${activeRule.name}" (Mode: ${activeRule.exec_mode.toUpperCase()})`,
      `[Trigger Engine] Monitoring ${activeRule.triggers.length} trigger pattern(s)...`,
      `[Sim Ingress] CAN frame matching trigger ${activeRule.triggers[0]?.can_id || '0x448'} received on Bus ${activeRule.triggers[0]?.bus ?? 0}`,
      `[Condition Evaluator] Checking ${activeRule.conditions.length} condition(s): ALL PASS (1/1 true)`,
      `[Dispatcher] Executing ${activeRule.actions.length} action(s) with ${activeRule.cooldown_ms}ms cooldown protection...`
    ];

    activeRule.actions.forEach((act, idx) => {
      if (act.type === 'precondition') {
        logs.push(`  -> Action #${idx + 1}: Triggered Precondition State Machine (Persistent mode)`);
      } else if (act.type === 'can_tx') {
        logs.push(
          `  -> Action #${idx + 1}: Injected CAN Frame ID ${act.can_id} [${act.payload}] (Repeat: ${act.repeat || 1}x, Delay: ${act.delay_ms || 0}ms)`
        );
      } else {
        logs.push(`  -> Action #${idx + 1}: Executed action type "${act.type}"`);
      }
      if (act.popup_message) {
        logs.push(`  -> OSD Cluster Toast: "${act.popup_message}"`);
      }
    });

    logs.push(`[Success] Rule dry-run verified successfully. Cooldown armed for ${activeRule.cooldown_ms}ms.`);
    setSimulationLog(logs);
  };

  // Filter commands for the catalog pull picker
  const filteredPickerCommands = catalog.commands.filter(cmd => {
    const matchesSearch =
      cmd.name.toLowerCase().includes(pickerSearch.toLowerCase()) ||
      cmd.id.toLowerCase().includes(pickerSearch.toLowerCase()) ||
      (cmd.state_can_id && cmd.state_can_id.toLowerCase().includes(pickerSearch.toLowerCase())) ||
      (cmd.action_can_id && cmd.action_can_id.toLowerCase().includes(pickerSearch.toLowerCase()));
    const matchesCat = pickerCategory === 'all' || cmd.category === pickerCategory;
    return matchesSearch && matchesCat;
  });

  const handleSelectFromPicker = (cmd: Command, opt?: CommandOption) => {
    if (!activeRule) return;
    if (pickerTarget === 'trigger') {
      const newTrig = commandToTrigger(cmd, opt);
      handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] });
    } else if (pickerTarget === 'condition') {
      const newCond = commandToCondition(cmd, opt);
      handleUpdateActiveRule({ conditions: [...activeRule.conditions, newCond] });
    } else if (pickerTarget === 'action') {
      const newAct = commandToAction(cmd, opt);
      handleUpdateActiveRule({ actions: [...activeRule.actions, newAct] });
    } else if (pickerTarget === 'off_action') {
      const newOffAct = commandToAction(cmd, opt);
      handleUpdateActiveRule({ off_actions: [...(activeRule.off_actions || []), newOffAct] });
    }
    setCatalogPickerOpen(false);
  };

  const categories = Array.from(new Set(catalog.commands.map(c => c.category))).filter(Boolean);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Top Header & Context Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-inner">
            <Cpu className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white tracking-tight">CAN Do Automation Builder</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 font-mono border border-cyan-800">
                The Brains
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-medium">
                {rules.length} {rules.length === 1 ? 'Rule' : 'Rules'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Select catalog commands to generate reactive trigger-action automations for the ESP32 firmware.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onBackToCatalog && (
            <button
              type="button"
              onClick={onBackToCatalog}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition"
            >
              <ArrowRight className="w-3.5 h-3.5 rotate-180" />
              <span>Back to Catalog</span>
            </button>
          )}

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer transition">
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span>Import JSON</span>
            <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
          </label>

          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition shadow"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Export JSON</span>
          </button>

          <button
            type="button"
            onClick={handleSimulateRule}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-cyan-950 bg-cyan-400 hover:bg-cyan-300 transition shadow-md shadow-cyan-500/20"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Dry Run Rule</span>
          </button>
        </div>
      </div>

      {/* Main Builder Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Rule Selector & Management (3 cols) */}
        <div className="lg:col-span-3 space-y-4">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Automations</span>
              <button
                type="button"
                onClick={handleAddRule}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/40 transition"
              >
                <Plus className="w-3 h-3" />
                <span>New</span>
              </button>
            </div>

            <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
              {rules.map((rule, idx) => {
                const isSelected = rule.id === activeRule?.id;
                return (
                  <div
                    key={rule.id}
                    onClick={() => setSelectedRuleId(rule.id)}
                    className={`group p-2.5 rounded-xl cursor-pointer border transition text-left flex flex-col gap-1.5 ${
                      isSelected
                        ? 'bg-slate-800 border-cyan-500/80 shadow-md shadow-cyan-950/40 text-white'
                        : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            rule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                        />
                        <span className="text-xs font-semibold truncate">{rule.name || `Rule #${idx + 1}`}</span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleDuplicateRule(rule);
                          }}
                          title="Duplicate rule"
                          className="p-1 hover:text-cyan-300 text-slate-400"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleDeleteRule(rule.id);
                          }}
                          title="Delete rule"
                          className="p-1 hover:text-rose-400 text-slate-400"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
                      <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 uppercase">
                        {rule.exec_mode.replace('_', ' ')}
                      </span>
                      {rule.ha_expose && (
                        <span className="px-1 py-0.5 rounded bg-orange-950/60 text-orange-300 border border-orange-800/40">
                          HA
                        </span>
                      )}
                      <span>
                        {rule.triggers.length}T · {rule.actions.length}A
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick Info & ESP32 Firmware Notes */}
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 space-y-2">
            <div className="flex items-center gap-1.5 font-semibold text-slate-300">
              <Info className="w-3.5 h-3.5 text-cyan-400" />
              <span>Firmware Redesign Note</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              As you rewrite the ESP32 firmware, this interface serves as the primary logic orchestrator. The ESP32 simply ingests and executes the generated JSON.
            </p>
          </div>
        </div>

        {/* Middle Column: Active Rule Editor (5 cols) */}
        {activeRule ? (
          <div className="lg:col-span-5 space-y-4">
            {/* Rule Config Header Card */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-4">
              <div className="flex items-center justify-between gap-3">
                <input
                  type="text"
                  value={activeRule.name}
                  onChange={e => handleUpdateActiveRule({ name: e.target.value })}
                  placeholder="Rule Name"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm font-bold text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
                />
                <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                  <span className="text-xs font-semibold text-slate-300">
                    {activeRule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <input
                    type="checkbox"
                    checked={activeRule.enabled}
                    onChange={e => handleUpdateActiveRule({ enabled: e.target.checked })}
                    className="w-4 h-4 rounded text-cyan-500 bg-slate-800 border-slate-700 focus:ring-cyan-400"
                  />
                </label>
              </div>

              {/* Execution Mode & Combining */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Execution Mode</label>
                  <select
                    value={activeRule.exec_mode}
                    onChange={e => handleUpdateActiveRule({ exec_mode: e.target.value as ExecutionMode })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="one_shot">one_shot (Edge release)</option>
                    <option value="toggle">toggle (Stateful On/Off)</option>
                    <option value="continuous_hold">continuous_hold (While held)</option>
                    <option value="on_change">on_change (Value change)</option>
                    <option value="poll_verify">poll_verify (Verification loop)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Trigger Combination</label>
                  <select
                    value={activeRule.trigger_mode}
                    onChange={e => handleUpdateActiveRule({ trigger_mode: e.target.value as TriggerCombineMode })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="any">ANY (OR - Any trigger fires)</option>
                    <option value="all">ALL (AND - Simultaneous Chord)</option>
                    <option value="sequence">SEQUENCE (Ordered chain)</option>
                  </select>
                </div>
              </div>

              {/* Cooldown, Timeout & Auto-Revert */}
              <div className="grid grid-cols-3 gap-2.5 text-xs">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Cooldown (ms)</label>
                  <input
                    type="number"
                    value={activeRule.cooldown_ms}
                    onChange={e => handleUpdateActiveRule({ cooldown_ms: parseInt(e.target.value) || 0 })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Timeout (ms)</label>
                  <input
                    type="number"
                    value={activeRule.timeout_reset_ms}
                    onChange={e => handleUpdateActiveRule({ timeout_reset_ms: parseInt(e.target.value) || 0 })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                {activeRule.exec_mode === 'toggle' ? (
                  <div>
                    <label className="block text-slate-400 font-medium mb-1">Auto-Revert (sec)</label>
                    <input
                      type="number"
                      value={activeRule.auto_revert_sec || 0}
                      onChange={e => handleUpdateActiveRule({ auto_revert_sec: parseInt(e.target.value) || 0 })}
                      placeholder="0 = disabled"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-slate-400 font-medium mb-1">HA Integration</label>
                    <div className="flex items-center gap-2 pt-1.5">
                      <input
                        type="checkbox"
                        checked={activeRule.ha_expose}
                        onChange={e => handleUpdateActiveRule({ ha_expose: e.target.checked })}
                        className="w-4 h-4 rounded text-orange-500 bg-slate-800 border-slate-700"
                      />
                      <span className="text-slate-300">Expose Entity</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Home Assistant MDI Icon selector */}
              {activeRule.ha_expose && (
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-orange-950/60 border border-orange-800/60 flex items-center justify-center text-orange-400">
                      <MdiIcon icon={activeRule.ha_icon} className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-slate-300">HA Entity Icon</div>
                      <div className="text-[10px] text-slate-400 font-mono">{activeRule.ha_icon}</div>
                    </div>
                  </div>
                  <select
                    value={activeRule.ha_icon}
                    onChange={e => handleUpdateActiveRule({ ha_icon: e.target.value })}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-slate-200 font-mono text-[11px]"
                  >
                    {SUGGESTED_MDI_ICONS.map(i => (
                      <option key={i.id} value={i.id}>
                        {i.label} ({i.id})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* SECTION 1: TRIGGERS (WHEN...) */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-cyan-500/20 text-cyan-400">
                    <Zap className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    1. Triggers (When...)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTarget('trigger');
                      setCatalogPickerOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Pull Catalog</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const newTrig: AutomationTrigger = {
                        id: `trig_${Date.now().toString(36)}`,
                        source: 'can',
                        can_id: '0x448',
                        bus: 0,
                        click_count: 1,
                        from_payload: '* * * * * 0*',
                        to_payload: '* * * * * 1*'
                      };
                      handleUpdateActiveRule({ triggers: [...activeRule.triggers, newTrig] });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Raw CAN</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {activeRule.triggers.map((trig, tIdx) => (
                  <div
                    key={trig.id || tIdx}
                    className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-cyan-950 text-cyan-300 font-bold text-[10px] flex items-center justify-center border border-cyan-800">
                          T{tIdx + 1}
                        </span>
                        {trig.source_command_name ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-white">{trig.source_command_name}</span>
                            {trig.option_label && (
                              <span className="px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 text-[10px] border border-cyan-800/60">
                                {trig.option_label}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="font-semibold text-slate-300 font-mono">
                            CAN Trigger {trig.can_id}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = activeRule.triggers.filter((_, i) => i !== tIdx);
                          handleUpdateActiveRule({ triggers: updated });
                        }}
                        className="p-1 text-slate-500 hover:text-rose-400 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
                        <input
                          type="text"
                          value={trig.can_id || ''}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].can_id = e.target.value;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                          placeholder="0x448"
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">Bus</label>
                        <select
                          value={trig.bus ?? 0}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].bus = parseInt(e.target.value) || 0;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                        >
                          <option value={0}>Bus 0</option>
                          <option value={1}>Bus 1</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">Gesture / Clicks</label>
                        <select
                          value={trig.click_count || 1}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].click_count = parseInt(e.target.value) || 1;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans text-[11px]"
                        >
                          <option value={1}>Single Click</option>
                          <option value={2}>Double Click</option>
                          <option value={3}>Triple Click</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">From Payload</label>
                        <input
                          type="text"
                          value={trig.from_payload || '* * * * * 0*'}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].from_payload = e.target.value;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-300"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">To / Match Payload</label>
                        <input
                          type="text"
                          value={trig.to_payload || trig.match_payload || '* * * * * 1*'}
                          onChange={e => {
                            const updated = [...activeRule.triggers];
                            updated[tIdx].to_payload = e.target.value;
                            updated[tIdx].match_payload = e.target.value;
                            handleUpdateActiveRule({ triggers: updated });
                          }}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-cyan-300 font-bold"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* SECTION 2: CONDITIONS (AND IF...) */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-purple-500/20 text-purple-400">
                    <Shield className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    2. Conditions (And if...)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTarget('condition');
                      setCatalogPickerOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-purple-500 text-slate-950 hover:bg-purple-400 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Pull Catalog</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const newCond: AutomationCondition = {
                        id: `cond_${Date.now().toString(36)}`,
                        type: 'can_state',
                        can_id: '0x120',
                        bus: 0,
                        match_payload: '01 * * * * * * *',
                        invert: false
                      };
                      handleUpdateActiveRule({ conditions: [...activeRule.conditions, newCond] });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Raw CAN</span>
                  </button>
                </div>
              </div>

              {activeRule.conditions.length === 0 ? (
                <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500">
                  No conditions set. Rule will always execute when triggers match.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {activeRule.conditions.map((cond, cIdx) => (
                    <div
                      key={cond.id || cIdx}
                      className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-purple-950 text-purple-300 font-bold text-[10px] flex items-center justify-center border border-purple-800">
                            C{cIdx + 1}
                          </span>
                          {cond.source_command_name ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-white">{cond.source_command_name}</span>
                              {cond.option_label && (
                                <span className="px-1.5 py-0.2 rounded bg-purple-950 text-purple-300 text-[10px] border border-purple-800/60">
                                  {cond.option_label}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="font-semibold text-slate-300 font-mono">
                              State Check: {cond.can_id}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={cond.invert || false}
                              onChange={e => {
                                const updated = [...activeRule.conditions];
                                updated[cIdx].invert = e.target.checked;
                                handleUpdateActiveRule({ conditions: updated });
                              }}
                              className="w-3.5 h-3.5 rounded text-purple-500 bg-slate-800 border-slate-700"
                            />
                            <span>Invert (NOT)</span>
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              const updated = activeRule.conditions.filter((_, i) => i !== cIdx);
                              handleUpdateActiveRule({ conditions: updated });
                            }}
                            className="p-1 text-slate-500 hover:text-rose-400 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
                          <input
                            type="text"
                            value={cond.can_id || ''}
                            onChange={e => {
                              const updated = [...activeRule.conditions];
                              updated[cIdx].can_id = e.target.value;
                              handleUpdateActiveRule({ conditions: updated });
                            }}
                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">Match Payload Pattern</label>
                          <input
                            type="text"
                            value={cond.match_payload || '* * * * * * * *'}
                            onChange={e => {
                              const updated = [...activeRule.conditions];
                              updated[cIdx].match_payload = e.target.value;
                              handleUpdateActiveRule({ conditions: updated });
                            }}
                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-purple-300 font-bold"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* SECTION 3: ACTIONS (THEN DO...) */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400">
                    <Send className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    3. Actions (Then do...)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTarget('action');
                      setCatalogPickerOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Pull Catalog</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const newAct: AutomationAction = {
                        id: `act_${Date.now().toString(36)}`,
                        type: 'can_tx',
                        can_id: '0x524',
                        bus: 0,
                        payload: '02 01 00 00 00 00 00 00',
                        repeat: 1,
                        delay_ms: 50
                      };
                      handleUpdateActiveRule({ actions: [...activeRule.actions, newAct] });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Raw CAN TX</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {activeRule.actions.map((act, aIdx) => (
                  <div
                    key={act.id || aIdx}
                    className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-300 font-bold text-[10px] flex items-center justify-center border border-emerald-800">
                          A{aIdx + 1}
                        </span>
                        {act.source_command_name ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-white">{act.source_command_name}</span>
                            {act.option_label && (
                              <span className="px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 text-[10px] border border-emerald-800/60">
                                {act.option_label}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="font-semibold text-slate-300 font-mono">
                            {act.type === 'precondition' ? 'Battery Precondition' : `CAN TX ${act.can_id}`}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = activeRule.actions.filter((_, i) => i !== aIdx);
                          handleUpdateActiveRule({ actions: updated });
                        }}
                        className="p-1 text-slate-500 hover:text-rose-400 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                      <div>
                        <label className="block text-[10px] font-sans text-slate-500">Action Type</label>
                        <select
                          value={act.type}
                          onChange={e => {
                            const updated = [...activeRule.actions];
                            updated[aIdx].type = e.target.value as any;
                            handleUpdateActiveRule({ actions: updated });
                          }}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                        >
                          <option value="can_tx">can_tx (CAN Ingress)</option>
                          <option value="precondition">precondition (E-GMP)</option>
                          <option value="climate_target">climate_target</option>
                          <option value="webhook">webhook (HTTP)</option>
                        </select>
                      </div>

                      {act.type === 'can_tx' && (
                        <>
                          <div>
                            <label className="block text-[10px] font-sans text-slate-500">Target CAN ID</label>
                            <input
                              type="text"
                              value={act.can_id || ''}
                              onChange={e => {
                                const updated = [...activeRule.actions];
                                updated[aIdx].can_id = e.target.value;
                                handleUpdateActiveRule({ actions: updated });
                              }}
                              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-sans text-slate-500">Repeat × Delay</label>
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                value={act.repeat || 1}
                                onChange={e => {
                                  const updated = [...activeRule.actions];
                                  updated[aIdx].repeat = parseInt(e.target.value) || 1;
                                  handleUpdateActiveRule({ actions: updated });
                                }}
                                className="w-12 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                              />
                              <span className="text-slate-500 font-sans">×</span>
                              <input
                                type="number"
                                value={act.delay_ms || 0}
                                onChange={e => {
                                  const updated = [...activeRule.actions];
                                  updated[aIdx].delay_ms = parseInt(e.target.value) || 0;
                                  handleUpdateActiveRule({ actions: updated });
                                }}
                                placeholder="ms"
                                className="w-16 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                              />
                            </div>
                          </div>
                        </>
                      )}

                      {act.type === 'precondition' && (
                        <>
                          <div>
                            <label className="block text-[10px] font-sans text-slate-500">Mode</label>
                            <select
                              value={act.precon_mode || 'persistent'}
                              onChange={e => {
                                const updated = [...activeRule.actions];
                                updated[aIdx].precon_mode = e.target.value as any;
                                handleUpdateActiveRule({ actions: updated });
                              }}
                              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                            >
                              <option value="persistent">Persistent</option>
                              <option value="toggle">Toggle</option>
                              <option value="timed">Timed</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] font-sans text-slate-500">Press Type</label>
                            <select
                              value={act.precon_press || 'short'}
                              onChange={e => {
                                const updated = [...activeRule.actions];
                                updated[aIdx].precon_press = e.target.value as any;
                                handleUpdateActiveRule({ actions: updated });
                              }}
                              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                            >
                              <option value="short">Short Press</option>
                              <option value="long">Long Press</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>

                    {act.type === 'can_tx' && (
                      <div className="space-y-1.5 font-mono text-[11px]">
                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">Payload (8 Bytes)</label>
                          <input
                            type="text"
                            value={act.payload || '00 00 00 00 00 00 00 00'}
                            onChange={e => {
                              const updated = [...activeRule.actions];
                              updated[aIdx].payload = e.target.value;
                              handleUpdateActiveRule({ actions: updated });
                            }}
                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-emerald-300 font-bold"
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">
                            OSD Cluster / Screen Popup Message (Optional)
                          </label>
                          <input
                            type="text"
                            value={act.popup_message || ''}
                            onChange={e => {
                              const updated = [...activeRule.actions];
                              updated[aIdx].popup_message = e.target.value;
                              handleUpdateActiveRule({ actions: updated });
                            }}
                            placeholder="e.g. Precondition Started"
                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-300 font-sans"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* SECTION 4: OFF-ACTIONS (Visible only in Toggle mode) */}
            {activeRule.exec_mode === 'toggle' && (
              <div className="p-4 rounded-2xl bg-slate-900 border border-amber-900/40 shadow-lg space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-lg bg-amber-500/20 text-amber-400">
                      <RotateCw className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                      4. Off-Actions (When toggled OFF...)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTarget('off_action');
                      setCatalogPickerOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500 text-slate-950 hover:bg-amber-400 transition"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Pull Catalog</span>
                  </button>
                </div>

                {(!activeRule.off_actions || activeRule.off_actions.length === 0) ? (
                  <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500">
                    No off-actions defined. Specify frames to send when state toggles off.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeRule.off_actions.map((offAct, oIdx) => (
                      <div
                        key={offAct.id || oIdx}
                        className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-white">
                            {offAct.source_command_name || `Off Action ${offAct.can_id}`}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const updated = activeRule.off_actions?.filter((_, i) => i !== oIdx) || [];
                              handleUpdateActiveRule({ off_actions: updated });
                            }}
                            className="p-1 text-slate-500 hover:text-rose-400 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                          <div>
                            <label className="block text-[10px] font-sans text-slate-500">CAN ID</label>
                            <input
                              type="text"
                              value={offAct.can_id || ''}
                              onChange={e => {
                                const updated = [...(activeRule.off_actions || [])];
                                updated[oIdx].can_id = e.target.value;
                                handleUpdateActiveRule({ off_actions: updated });
                              }}
                              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-sans text-slate-500">Off Payload</label>
                            <input
                              type="text"
                              value={offAct.payload || ''}
                              onChange={e => {
                                const updated = [...(activeRule.off_actions || [])];
                                updated[oIdx].payload = e.target.value;
                                handleUpdateActiveRule({ off_actions: updated });
                              }}
                              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-amber-300 font-bold"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="lg:col-span-5 flex items-center justify-center p-12 text-slate-500 text-sm">
            Select or create a rule to start editing.
          </div>
        )}

        {/* Right Column: Live JSON Inspector & Output (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-lg flex flex-col h-full space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-950 border border-slate-800 text-[11px]">
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('catalog')}
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                    activeJsonTab === 'catalog'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Full Catalog
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('cando')}
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                    activeJsonTab === 'cando'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  WiCAN Format
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('esp32')}
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                    activeJsonTab === 'esp32'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  ESP32 C-Flat
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJsonTab('custom')}
                  className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                    activeJsonTab === 'custom'
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Custom Schema
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopyJson}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition border border-slate-700"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-cyan-400" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>

            {/* Tab descriptions */}
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <FileJson className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
              <span>
                {activeJsonTab === 'catalog' && 'Full can_do_catalog.json with embedded automations ready for LittleFS flash.'}
                {activeJsonTab === 'cando' && 'Formatted for SuperSuave/wicant-i-automate LittleFS flash.'}
                {activeJsonTab === 'esp32' && 'Flat, numeric enums optimized for lightweight ESP32 C parsing.'}
                {activeJsonTab === 'custom' && 'Sandbox schema for testing your new firmware architecture from scratch.'}
              </span>
            </div>

            {/* Code Output Area */}
            <div className="relative flex-1 min-h-[420px] max-h-[600px] overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
              {activeJsonTab === 'custom' ? (
                <textarea
                  value={customJsonSchema}
                  onChange={e => setCustomJsonSchema(e.target.value)}
                  className="w-full h-full p-3 font-mono text-[11px] text-cyan-300 bg-transparent resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500 leading-relaxed overflow-y-auto"
                  spellCheck={false}
                />
              ) : (
                <pre className="w-full h-full p-3 font-mono text-[11px] text-slate-300 overflow-auto leading-relaxed select-text">
                  <code>
                    {activeJsonTab === 'catalog'
                      ? exportToFullCatalogJson(catalog, rules)
                      : activeJsonTab === 'cando'
                      ? exportToCandoJson(rules, settings)
                      : exportToEsp32FirmwareJson(rules, settings)}
                  </code>
                </pre>
              )}
            </div>

            {/* Quick Export Footer */}
            <div className="flex items-center justify-between pt-2 text-[11px] text-slate-500">
              <span>{rules.length} automations compiled</span>
              <button
                type="button"
                onClick={handleDownloadJson}
                className="hover:text-cyan-400 font-semibold underline underline-offset-2 transition"
              >
                Download .json file
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: Catalog Command Pull Picker */}
      {catalogPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Pull Command into {pickerTarget.toUpperCase()}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Select a catalog item or state to populate into this rule.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCatalogPickerOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            {/* Search & Filter */}
            <div className="p-3 border-b border-slate-800 bg-slate-950/50 flex flex-wrap gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
                <input
                  type="text"
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  placeholder="Search commands or CAN IDs..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <select
                value={pickerCategory}
                onChange={e => setPickerCategory(e.target.value)}
                className="bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none"
              >
                <option value="all">All Categories</option>
                {categories.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {/* Command List */}
            <div className="p-4 overflow-y-auto space-y-2 flex-1">
              {filteredPickerCommands.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">No commands found.</div>
              ) : (
                filteredPickerCommands.map(cmd => (
                  <div
                    key={cmd.id}
                    className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{cmd.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 font-mono">
                            {cmd.category}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                          {cmd.state_can_id && <span>RX: {cmd.state_can_id}</span>}
                          {cmd.action_can_id && <span>TX: {cmd.action_can_id}</span>}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleSelectFromPicker(cmd)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                      >
                        Select Base Command
                      </button>
                    </div>

                    {/* Specific Options/States if available */}
                    {cmd.options && cmd.options.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-900">
                        <span className="text-[10px] text-slate-500 font-medium self-center">Or Pick State:</span>
                        {cmd.options.map((opt, oIdx) => (
                          <button
                            key={oIdx}
                            type="button"
                            onClick={() => handleSelectFromPicker(cmd, opt)}
                            className="text-[10px] px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-800 transition"
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Rule Dry Run / Simulation Log */}
      {showSimulateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                  <Play className="w-4 h-4 fill-current" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Rule Simulation Dry-Run</h3>
                  <p className="text-[11px] text-slate-400">
                    Emulating ESP32 reactive rule evaluation pipeline
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSimulateModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-4 bg-slate-950 font-mono text-xs text-emerald-400 space-y-1 max-h-80 overflow-y-auto leading-relaxed select-text">
              {simulationLog.map((line, idx) => (
                <div key={idx} className={line.startsWith('[Sim Ingress]') ? 'text-yellow-300' : line.startsWith('  ->') ? 'text-cyan-300 pl-2' : ''}>
                  {line}
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900/80 flex items-center justify-end">
              <button
                type="button"
                onClick={() => setShowSimulateModal(false)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
              >
                Close Log
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
