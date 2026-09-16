import React, { useState, useEffect, useMemo } from 'react';
import { Catalog, Command, CommandRole, GitHubRepoConfig, Vehicle } from './types/catalog';
import { DEFAULT_CATALOG } from './data/defaultCatalog';
import { validateCatalog } from './utils/canValidator';
import { getSavedRepoConfig, saveRepoConfig } from './utils/githubHelper';
import { CommandFilter } from './components/CommandFilter';
import { CommandCard } from './components/CommandCard';
import { CommandDetailModal } from './components/CommandDetailModal';
import { CommandEditorModal } from './components/CommandEditorModal';
import { ImportModal } from './components/ImportModal';
import { ContributeModal } from './components/ContributeModal';
import { CatalogHealthModal } from './components/CatalogHealthModal';
import { CategoryManagerModal } from './components/CategoryManagerModal';
import { ExportModal, ExportFormat } from './components/ExportModal';
import { ExportDropdown } from './components/ExportDropdown';
import { VehiclesTab } from './components/VehiclesTab';
import { GroupedCommandView } from './components/GroupedCommandView';
import { CanDoLogo } from './components/CanDoLogo';
import { AutomationBuilder } from './components/AutomationBuilder';
import { 
  AutomationRule, 
  AutomationSettings, 
  AutomationTrigger, 
  AutomationAction 
} from './types/automation';
import { 
  DEFAULT_AUTOMATION_RULES, 
  DEFAULT_AUTOMATION_SETTINGS 
} from './data/defaultAutomations';
import {
  Sparkles,
  GitBranch,
  ShieldCheck,
  Search,
  Plus,
  ArrowUpRight,
  Info,
  Upload,
  Download,
  Github,
  AlertTriangle,
  RefreshCw,
  Zap,
  Car,
  Layers
} from 'lucide-react';

const STORAGE_KEY_CATALOG = 'can_do_catalog_data';
const STORAGE_KEY_DRAFT_ADDED = 'can_do_draft_added';
const STORAGE_KEY_DRAFT_MODIFIED = 'can_do_draft_modified';
const STORAGE_KEY_DRAFT_ADDED_VEHICLES = 'can_do_draft_added_vehicles';
const STORAGE_KEY_DRAFT_MODIFIED_VEHICLES = 'can_do_draft_modified_vehicles';
const STORAGE_KEY_DISCOVERED_FEATURES = 'can_do_discovered_features';
const STORAGE_KEY_AUTOMATIONS_RULES = 'can_do_automation_rules';
const STORAGE_KEY_AUTOMATIONS_SETTINGS = 'can_do_automation_settings';

export default function App() {
  // 1. Core catalog state
  const [catalog, setCatalog] = useState<Catalog>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CATALOG);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Synchronize default catalog enhancements like dual CAN IDs if not modified in draft
        if (parsed.commands) {
          const defaultSeat = DEFAULT_CATALOG.commands.find(c => c.id === 'rear_left_seat_heating');
          const savedSeatIdx = parsed.commands.findIndex((c: any) => c.id === 'rear_left_seat_heating');
          if (defaultSeat && savedSeatIdx >= 0 && !parsed.commands[savedSeatIdx].action_can_id) {
            parsed.commands[savedSeatIdx] = { ...parsed.commands[savedSeatIdx], ...defaultSeat };
          }

          const defaultPopup = DEFAULT_CATALOG.commands.find(c => c.id === 'cluster_telemetry_popup');
          const savedPopupIdx = parsed.commands.findIndex((c: any) => c.id === 'cluster_telemetry_popup');
          if (defaultPopup && savedPopupIdx >= 0 && parsed.commands[savedPopupIdx].ha_domain !== 'notify') {
            parsed.commands[savedPopupIdx] = {
              ...parsed.commands[savedPopupIdx],
              ha_domain: 'notify',
              icon: defaultPopup.icon || 'mdi:message-badge',
              mdi: defaultPopup.mdi || 'mdi:message-badge'
            };
          }

          parsed.commands.forEach((c: any) => {
            if (!c.icon || !c.mdi) {
              const def = DEFAULT_CATALOG.commands.find(dc => dc.id === c.id);
              if (def) {
                c.icon = c.icon || def.icon || def.mdi || 'mdi:car-info';
                c.mdi = c.mdi || def.mdi || def.icon || 'mdi:car-info';
              }
            }
          });
        }
        return parsed;
      }
    } catch (e) {
      console.error('Failed to load catalog from localStorage', e);
    }
    return DEFAULT_CATALOG;
  });

  // 2. Draft contribution tracking (Commands)
  const [draftAddedIds, setDraftAddedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DRAFT_ADDED);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [draftModifiedIds, setDraftModifiedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DRAFT_MODIFIED);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // 2b. Draft contribution tracking (Vehicles)
  const [draftAddedVehicleIds, setDraftAddedVehicleIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DRAFT_ADDED_VEHICLES);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [draftModifiedVehicleIds, setDraftModifiedVehicleIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DRAFT_MODIFIED_VEHICLES);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // 2c. Discovered features repository
  const [discoveredFeatures, setDiscoveredFeatures] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DISCOVERED_FEATURES);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // 3. GitHub repository configuration
  const [repoConfig, setRepoConfig] = useState<GitHubRepoConfig>(() => getSavedRepoConfig());

  // 4. Navigation & Modals state
  const [activeMainTab, setActiveMainTab] = useState<'catalog' | 'vehicles' | 'automations'>('catalog');
  const [selectedCommand, setSelectedCommand] = useState<Command | null>(null);
  const [editingCommand, setEditingCommand] = useState<Command | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isContributeOpen, setIsContributeOpen] = useState(false);
  const [isHealthOpen, setIsHealthOpen] = useState(false);
  const [isCategoryManagerOpen, setIsCategoryManagerOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [exportModalFormat, setExportModalFormat] = useState<ExportFormat>('dbc');

  // 4b. Automation Builder state & Selected Commands
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_AUTOMATIONS_RULES);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load automation rules from storage', e);
    }
    return DEFAULT_AUTOMATION_RULES;
  });

  const [automationSettings, setAutomationSettings] = useState<AutomationSettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_AUTOMATIONS_SETTINGS);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load automation settings from storage', e);
    }
    return DEFAULT_AUTOMATION_SETTINGS;
  });

  const [selectedForAutomation, setSelectedForAutomation] = useState<Set<string>>(new Set());

  // Save automations to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_AUTOMATIONS_RULES, JSON.stringify(automationRules));
    } catch (e) {
      console.error('Failed to persist automation rules', e);
    }
  }, [automationRules]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_AUTOMATIONS_SETTINGS, JSON.stringify(automationSettings));
    } catch (e) {
      console.error('Failed to persist automation settings', e);
    }
  }, [automationSettings]);

  // 5. Filters state
  const [search, setSearch] = useState('');
  const [selectedRole, setSelectedRole] = useState<CommandRole | 'all'>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'grouped'>('grouped');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>('all');
  const [selectedMake, setSelectedMake] = useState<string>('all');
  const [selectedRegion, setSelectedRegion] = useState<string>('all');
  const [selectedFeature, setSelectedFeature] = useState<string>('all');

  // Fetch remote can_do_catalog.json from GitHub raw on mount if no local cache exists
  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY_CATALOG)) {
      const fetchSources = [
        `https://raw.githubusercontent.com/${repoConfig.owner}/${repoConfig.repo}/${repoConfig.branch}/${repoConfig.filePath}`,
        './can_do_catalog.json'
      ];

      const tryFetch = async () => {
        for (const url of fetchSources) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const data = await res.json();
              if (data && data.commands && data.vehicles) {
                setCatalog(data);
                break;
              }
            }
          } catch {
            // Try next source
          }
        }
      };
      tryFetch();
    }
  }, [repoConfig]);

  // Sync to LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_CATALOG, JSON.stringify(catalog));
    } catch (e) {
      console.error('Failed to persist catalog', e);
    }
  }, [catalog]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DRAFT_ADDED, JSON.stringify(draftAddedIds));
  }, [draftAddedIds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DRAFT_MODIFIED, JSON.stringify(draftModifiedIds));
  }, [draftModifiedIds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DRAFT_ADDED_VEHICLES, JSON.stringify(draftAddedVehicleIds));
  }, [draftAddedVehicleIds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DRAFT_MODIFIED_VEHICLES, JSON.stringify(draftModifiedVehicleIds));
  }, [draftModifiedVehicleIds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DISCOVERED_FEATURES, JSON.stringify(discoveredFeatures));
  }, [discoveredFeatures]);

  const handleUpdateRepoConfig = (newConfig: GitHubRepoConfig) => {
    setRepoConfig(newConfig);
    saveRepoConfig(newConfig);
  };

  // Validation report
  const validationReport = useMemo(() => validateCatalog(catalog), [catalog]);

  // Filtered commands list
  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    const selectedVehicle =
      selectedVehicleId !== 'all'
        ? catalog.vehicles.find(v => v.id === selectedVehicleId)
        : null;

    // Helper: test if a command is compatible with a vehicle specification
    const isCmdCompatible = (cmd: Command, v: Vehicle): boolean => {
      // 1. Hardware feature check
      if (cmd.requires_feature && !v.features.includes(cmd.requires_feature)) {
        return false;
      }
      // 2. Platform / Family tag check
      if (cmd.tags && cmd.tags.length > 0) {
        const isEgmpVehicle =
          v.id.includes('egmp') ||
          v.family.includes('egmp') ||
          v.family.includes('ioniq') ||
          v.family.includes('ev6') ||
          v.family.includes('gv60');

        const matchesTag = cmd.tags.some(t => {
          if (t === 'all_egmp') return isEgmpVehicle;
          if (t === 'universal') return true;
          return v.id.includes(t) || v.family.includes(t);
        });

        if (!matchesTag) return false;
      }
      return true;
    };

    return catalog.commands.filter(cmd => {
      // Role filter
      if (selectedRole !== 'all' && !cmd.roles.includes(selectedRole)) {
        return false;
      }

      // Category filter
      if (selectedCategory !== 'all' && cmd.category !== selectedCategory) {
        return false;
      }

      // Subcategory / Subsystem filter
      if (selectedSubcategory !== 'all' && cmd.subcategory !== selectedSubcategory) {
        return false;
      }

      // Equipment / Feature requirement filter
      if (selectedFeature !== 'all') {
        const matchesCmd = cmd.requires_feature === selectedFeature;
        const matchesOpts = cmd.options?.some(o => o.requires_feature === selectedFeature);
        if (!matchesCmd && !matchesOpts) {
          return false;
        }
      }

      // Vehicle compatibility filter
      if (selectedVehicle) {
        if (!isCmdCompatible(cmd, selectedVehicle)) {
          return false;
        }
      } else if (selectedMake !== 'all' || selectedRegion !== 'all') {
        // When filtering by Make or Region without a specific trim:
        const candidateVehicles = catalog.vehicles.filter(v => {
          if (selectedMake !== 'all' && v.make !== selectedMake) return false;
          if (selectedRegion !== 'all' && v.region !== selectedRegion) return false;
          return true;
        });

        if (candidateVehicles.length > 0) {
          const compatibleWithAny = candidateVehicles.some(v => isCmdCompatible(cmd, v));
          if (!compatibleWithAny) return false;
        }
      }

      // Search query (name, id, state_can_id, action_can_id, category, payloads)
      if (q) {
        const matchesName = cmd.name.toLowerCase().includes(q);
        const matchesId = cmd.id.toLowerCase().includes(q);
        const matchesCanId = cmd.state_can_id?.toLowerCase().includes(q) || cmd.action_can_id?.toLowerCase().includes(q);
        const matchesCategory = cmd.category.toLowerCase().includes(q);
        const matchesSubcategory = cmd.subcategory?.toLowerCase().includes(q);
        const matchesFrom = cmd.from_payload?.toLowerCase().includes(q);
        const matchesTo = cmd.to_payload?.toLowerCase().includes(q);
        const matchesMatch = cmd.match_payload?.toLowerCase().includes(q);
        const matchesOptions = cmd.options?.some(
          o =>
            o.label.toLowerCase().includes(q) ||
            o.payload?.toLowerCase().includes(q) ||
            o.match_payload?.toLowerCase().includes(q) ||
            o.to_payload?.toLowerCase().includes(q) ||
            (o.state_value !== undefined && String(o.state_value).toLowerCase().includes(q)) ||
            o.description?.toLowerCase().includes(q)
        );
        const cleanQ = q.replace(/^@/, '');
        const matchesContributor =
          (cmd.contributor?.name && cmd.contributor.name.toLowerCase().includes(cleanQ)) ||
          (cmd.contributor?.github && cmd.contributor.github.toLowerCase().includes(cleanQ)) ||
          (cmd.contributor?.notes && cmd.contributor.notes.toLowerCase().includes(cleanQ));
        const matchesHaDomain = cmd.ha_domain?.toLowerCase().includes(q);
        const matchesMdi = (cmd.icon?.toLowerCase().includes(q) || cmd.mdi?.toLowerCase().includes(q));
        const matchesDeviceClass = cmd.device_class?.toLowerCase().includes(q);

        if (
          !matchesName &&
          !matchesId &&
          !matchesCanId &&
          !matchesCategory &&
          !matchesSubcategory &&
          !matchesFrom &&
          !matchesTo &&
          !matchesMatch &&
          !matchesOptions &&
          !matchesContributor &&
          !matchesHaDomain &&
          !matchesMdi &&
          !matchesDeviceClass
        ) {
          return false;
        }
      }

      return true;
    });
  }, [
    catalog,
    search,
    selectedRole,
    selectedCategory,
    selectedSubcategory,
    selectedVehicleId,
    selectedMake,
    selectedRegion,
    selectedFeature
  ]);

  // Command handlers
  const handleSaveCommand = (cmd: Command, isNew: boolean, originalId?: string) => {
    const targetId = originalId || cmd.id;
    if (isNew) {
      setCatalog(prev => ({
        ...prev,
        commands: [cmd, ...prev.commands]
      }));
      setDraftAddedIds(prev => Array.from(new Set([...prev, cmd.id])));
    } else {
      setCatalog(prev => ({
        ...prev,
        commands: prev.commands.map(c => (c.id === targetId ? cmd : c))
      }));
      // If the command ID was changed during edit, update draft tracking
      if (originalId && originalId !== cmd.id) {
        setDraftAddedIds(prev =>
          prev.map(id => (id === originalId ? cmd.id : id))
        );
        setDraftModifiedIds(prev => {
          const filtered = prev.filter(id => id !== originalId);
          return Array.from(new Set([...filtered, cmd.id]));
        });
      } else if (!draftAddedIds.includes(cmd.id)) {
        setDraftModifiedIds(prev => Array.from(new Set([...prev, cmd.id])));
      }
    }
  };

  const handleDuplicateCommand = (cmd: Command) => {
    const newId = `${cmd.id}_copy_${Date.now().toString(36).slice(-4)}`;
    const duplicated: Command = {
      ...cmd,
      id: newId,
      name: `${cmd.name} (Copy)`
    };
    setEditingCommand(duplicated);
    setIsEditorOpen(true);
  };

  const handleDeleteCommand = (cmdId: string) => {
    setCatalog(prev => ({
      ...prev,
      commands: prev.commands.filter(c => c.id !== cmdId)
    }));
    setDraftAddedIds(prev => prev.filter(id => id !== cmdId));
    setDraftModifiedIds(prev => prev.filter(id => id !== cmdId));
    if (selectedCommand?.id === cmdId) {
      setSelectedCommand(null);
    }
  };

  const handleBatchUpdateCategories = (
    updatedCommands: Command[],
    _actionDescription: string,
    affectedCommandIds: string[]
  ) => {
    setCatalog(prev => ({
      ...prev,
      commands: updatedCommands
    }));

    // Mark affected commands as modified drafts (unless already in draftAddedIds)
    setDraftModifiedIds(prev => {
      const addedSet = new Set(draftAddedIds);
      const toAdd = affectedCommandIds.filter(id => !addedSet.has(id));
      return Array.from(new Set([...prev, ...toAdd]));
    });

    // If currently filtered by a category that was renamed or merged, reset the filter to 'all'
    setSelectedCategory('all');
  };

  const handleUpdateVehicles = (
    newVehicles: Vehicle[],
    modifiedVehicleId?: string,
    isNew?: boolean
  ) => {
    setCatalog(prev => ({ ...prev, vehicles: newVehicles }));
    if (modifiedVehicleId) {
      if (isNew) {
        setDraftAddedVehicleIds(prev => Array.from(new Set([...prev, modifiedVehicleId])));
      } else if (!draftAddedVehicleIds.includes(modifiedVehicleId)) {
        setDraftModifiedVehicleIds(prev => Array.from(new Set([...prev, modifiedVehicleId])));
      }
    }
  };

  const handleRegisterDiscoveredFeature = (featureName: string) => {
    setDiscoveredFeatures(prev => Array.from(new Set([...prev, featureName])));
  };

  const handleImport = (importedCatalog: Catalog, mode: 'merge' | 'replace') => {
    if (mode === 'replace') {
      setCatalog(importedCatalog);
      setDraftAddedIds([]);
      setDraftModifiedIds([]);
      setDraftAddedVehicleIds([]);
      setDraftModifiedVehicleIds([]);
    } else {
      // Record new commands in draftAddedIds
      const existingIds = new Set(catalog.commands.map(c => c.id));
      const newlyAdded = importedCatalog.commands.filter(c => !existingIds.has(c.id)).map(c => c.id);

      const existingVehicleIds = new Set(catalog.vehicles.map(v => v.id));
      const newlyAddedVehicles = importedCatalog.vehicles.filter(v => !existingVehicleIds.has(v.id)).map(v => v.id);

      setCatalog(importedCatalog);
      setDraftAddedIds(prev => Array.from(new Set([...prev, ...newlyAdded])));
      setDraftAddedVehicleIds(prev => Array.from(new Set([...prev, ...newlyAddedVehicles])));
    }
  };

  const handleResetCatalog = () => {
    setCatalog(DEFAULT_CATALOG);
    setDraftAddedIds([]);
    setDraftModifiedIds([]);
    setDraftAddedVehicleIds([]);
    setDraftModifiedVehicleIds([]);
    setDiscoveredFeatures([]);
    localStorage.removeItem(STORAGE_KEY_CATALOG);
    localStorage.removeItem(STORAGE_KEY_DRAFT_ADDED);
    localStorage.removeItem(STORAGE_KEY_DRAFT_MODIFIED);
    localStorage.removeItem(STORAGE_KEY_DRAFT_ADDED_VEHICLES);
    localStorage.removeItem(STORAGE_KEY_DRAFT_MODIFIED_VEHICLES);
    localStorage.removeItem(STORAGE_KEY_DISCOVERED_FEATURES);
  };

  const handleSyncFromGitHub = async () => {
    const url = `https://raw.githubusercontent.com/${repoConfig.owner}/${repoConfig.repo}/${repoConfig.branch}/${repoConfig.filePath}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && data.commands && data.vehicles) {
          setCatalog(data);
          alert(`Successfully synced latest catalog (v${data.catalog_version}) from GitHub PRs!`);
          return;
        }
      }
      alert('Failed to fetch latest catalog from GitHub repository.');
    } catch (e) {
      console.error(e);
      alert('Error connecting to GitHub. Check network connection.');
    }
  };

  const handleClearDrafts = () => {
    setDraftAddedIds([]);
    setDraftModifiedIds([]);
    setDraftAddedVehicleIds([]);
    setDraftModifiedVehicleIds([]);
  };

  const handleAddToAutomation = (command: Command, role?: CommandRole) => {
    const isAction = role === 'action' || (!role && command.roles?.includes('action') && !command.roles?.includes('trigger'));

    setAutomationRules(prev => {
      const nextRules = [...prev];
      let activeRule = nextRules[0];

      if (!activeRule) {
        activeRule = {
          id: `rule_${Date.now()}`,
          name: `Automate: ${command.name}`,
          enabled: true,
          ha_expose: true,
          ha_icon: 'mdi:car-cog',
          exec_mode: 'one_shot',
          trigger_mode: 'any',
          cooldown_ms: 500,
          timeout_reset_ms: 0,
          triggers: [],
          conditions: [],
          actions: []
        };
        nextRules.push(activeRule);
      } else {
        activeRule = {
          ...activeRule,
          triggers: [...activeRule.triggers],
          conditions: [...activeRule.conditions],
          actions: [...activeRule.actions]
        };
        nextRules[0] = activeRule;
      }

      if (isAction) {
        activeRule.actions.push({
          id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'can_tx',
          source_command_id: command.id,
          source_command_name: command.name,
          bus: command.action_bus ?? command.bus ?? 0,
          can_id: command.action_can_id || command.state_can_id || '0x000',
          payload: command.options?.[0]?.payload || command.from_payload || command.match_payload || '00 00 00 00 00 00 00 00',
          repeat: 1,
          delay_ms: 0
        });
      } else {
        activeRule.triggers.push({
          id: `trig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          source: 'can',
          source_command_id: command.id,
          source_command_name: command.name,
          bus: command.bus ?? 0,
          can_id: command.state_can_id || command.action_can_id || '0x000',
          match_payload: command.options?.[0]?.payload || command.match_payload || command.from_payload || '00 00 00 00 00 00 00 00',
          click_count: 1
        });
      }

      return nextRules;
    });

    setActiveMainTab('automations');
  };

  const handleToggleSelectForAutomation = (command: Command) => {
    setSelectedForAutomation(prev => {
      const next = new Set(prev);
      if (next.has(command.id)) {
        next.delete(command.id);
      } else {
        next.add(command.id);
      }
      return next;
    });
  };

  const handleCreateAutomationFromSelected = () => {
    const selectedCmds = catalog.commands.filter(c => selectedForAutomation.has(c.id));
    if (selectedCmds.length === 0) return;

    const newRule: AutomationRule = {
      id: `rule_${Date.now()}`,
      name: selectedCmds.map(c => c.name).slice(0, 2).join(' + ') + (selectedCmds.length > 2 ? ` (+${selectedCmds.length - 2})` : ''),
      enabled: true,
      ha_expose: true,
      ha_icon: 'mdi:car-cog',
      exec_mode: 'one_shot',
      trigger_mode: 'any',
      cooldown_ms: 500,
      timeout_reset_ms: 0,
      triggers: [],
      conditions: [],
      actions: []
    };

    selectedCmds.forEach(cmd => {
      const isAction = cmd.roles?.includes('action') && !cmd.roles?.includes('trigger');
      if (isAction) {
        newRule.actions.push({
          id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'can_tx',
          source_command_id: cmd.id,
          source_command_name: cmd.name,
          bus: cmd.action_bus ?? cmd.bus ?? 0,
          can_id: cmd.action_can_id || cmd.state_can_id || '0x000',
          payload: cmd.options?.[0]?.payload || cmd.from_payload || cmd.match_payload || '00 00 00 00 00 00 00 00',
          repeat: 1,
          delay_ms: 0
        });
      } else {
        newRule.triggers.push({
          id: `trig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          source: 'can',
          source_command_id: cmd.id,
          source_command_name: cmd.name,
          bus: cmd.bus ?? 0,
          can_id: cmd.state_can_id || cmd.action_can_id || '0x000',
          match_payload: cmd.options?.[0]?.payload || cmd.match_payload || cmd.from_payload || '00 00 00 00 00 00 00 00',
          click_count: 1
        });
      }
    });

    setAutomationRules(prev => [newRule, ...prev]);
    setSelectedForAutomation(new Set());
    setActiveMainTab('automations');
  };

  // Pending contributions to pass to ContributeModal
  const pendingAddedCommands = catalog.commands.filter(c => draftAddedIds.includes(c.id));
  const pendingModifiedCommands = catalog.commands.filter(
    c => draftModifiedIds.includes(c.id) && !draftAddedIds.includes(c.id)
  );
  const pendingAddedVehicles = catalog.vehicles.filter(v => draftAddedVehicleIds.includes(v.id));
  const pendingModifiedVehicles = catalog.vehicles.filter(
    v => draftModifiedVehicleIds.includes(v.id) && !draftAddedVehicleIds.includes(v.id)
  );

  const totalPendingCount =
    pendingAddedCommands.length +
    pendingModifiedCommands.length +
    pendingAddedVehicles.length +
    pendingModifiedVehicles.length;

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
    <div className="min-h-screen flex flex-col bg-[var(--background-color)] text-[var(--text-color)] selection:bg-cyan-500 selection:text-slate-950">
      {/* Hero Banner / Header Area */}
      <section className="border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] px-3.5 py-4 sm:px-6 sm:py-5 lg:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 items-center gap-4 py-1">
          {/* Left: Stacked title + Version chip underneath */}
          <div className="flex flex-col items-center md:items-start text-center md:text-left">
            <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-heading)] tracking-tight leading-tight">
              <span className="block">CAN Do Automation</span>
              <span className="block text-slate-300">Message Catalog</span>
            </h1>
            <div className="mt-2 flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-[var(--input-bg)] text-cyan-400 border border-[var(--border-color)] shadow-sm">
                v{catalog.catalog_version}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                Community Contribution Hub
              </span>
            </div>
          </div>

          {/* Center: Centered CAN Do Logo */}
          <div className="flex items-center justify-center">
            <CanDoLogo className="h-14 sm:h-18 md:h-20 w-auto" />
          </div>

          {/* Right: Consolidated Action Toolbar */}
          <div className="flex flex-wrap items-center justify-center md:justify-end gap-2 text-xs w-full">
            {/* Catalog Health Status */}
            <button
              type="button"
              onClick={() => setIsHealthOpen(true)}
              title="Open Catalog Validation Report"
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition ${
                validationReport.isValid
                  ? 'bg-emerald-950/30 text-emerald-300 border-emerald-800/80 hover:bg-emerald-950/60'
                  : 'bg-rose-950/30 text-rose-300 border-rose-800/80 hover:bg-rose-950/60 animate-pulse'
              }`}
            >
              <span className={`status-dot ${validationReport.isValid ? 'green' : 'red'}`} />
              <span>{validationReport.isValid ? 'Valid Catalog' : 'Audit Issues'}</span>
            </button>

            {/* Sync from GitHub Button */}
            <button
              type="button"
              onClick={handleSyncFromGitHub}
              className="dash-outline-btn inline-flex items-center gap-1.5 text-xs py-1.5 px-3.5 text-cyan-300 hover:text-cyan-200"
              title="Pull latest catalog from GitHub repository (based on recent PRs)"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Sync GitHub</span>
            </button>

            {/* Import Button */}
            <button
              type="button"
              onClick={() => setIsImportOpen(true)}
              className="dash-outline-btn inline-flex items-center gap-1.5 text-xs py-1.5 px-3.5"
              title="Import JSON catalog or Vector DBC"
            >
              <Upload className="w-3.5 h-3.5 text-cyan-400" />
              <span>Import</span>
            </button>

            {/* Merged Export Button & Dropdown */}
            <ExportDropdown
              variant="toolbar"
              onQuickDownloadJson={handleQuickDownload}
              onOpenExportModal={format => {
                setExportModalFormat(format || 'dbc');
                setIsExportOpen(true);
              }}
            />
          </div>
        </div>
      </section>

      {/* Main Tab Navigation Header */}
      <div className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14 gap-2">
            <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar py-1">
              <button
                type="button"
                onClick={() => setActiveMainTab('catalog')}
                className={`inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold transition shrink-0 ${
                  activeMainTab === 'catalog'
                    ? 'bg-slate-800 text-white shadow-sm border border-slate-700 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span>Commands</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-900/90 text-slate-300 font-mono border border-slate-800">
                  {catalog.commands.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveMainTab('vehicles')}
                className={`inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold transition shrink-0 ${
                  activeMainTab === 'vehicles'
                    ? 'bg-slate-800 text-white shadow-sm border border-slate-700 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Car className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>Vehicles</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-900/90 text-slate-300 font-mono border border-slate-800">
                  {catalog.vehicles.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveMainTab('automations')}
                className={`inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold transition shrink-0 ${
                  activeMainTab === 'automations'
                    ? 'bg-cyan-500 text-slate-950 font-black shadow-md shadow-cyan-500/10'
                    : 'bg-cyan-950/30 text-cyan-300 hover:bg-cyan-900/40 border border-cyan-800/50'
                }`}
              >
                <Zap className="w-3.5 h-3.5 fill-current shrink-0" />
                <span>Automation Builder</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                    activeMainTab === 'automations'
                      ? 'bg-slate-950 text-cyan-300'
                      : 'bg-cyan-900/80 text-cyan-200'
                  }`}
                >
                  {automationRules.length}
                </span>
              </button>
            </div>

            {/* Quick action button */}
            <div className="flex items-center gap-2 shrink-0">
              {activeMainTab === 'catalog' && selectedForAutomation.size > 0 && (
                <button
                  type="button"
                  onClick={handleCreateAutomationFromSelected}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold transition shadow-sm"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span>Build with ({selectedForAutomation.size})</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main App Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 min-w-0">
        {activeMainTab === 'catalog' ? (
          <div className="space-y-5 sm:space-y-6 min-w-0">
            {/* Filter and Search Bar */}
            <CommandFilter
              catalog={catalog}
              search={search}
              onSearchChange={setSearch}
              selectedRole={selectedRole}
              onRoleChange={setSelectedRole}
              selectedCategory={selectedCategory}
              onCategoryChange={setSelectedCategory}
              selectedSubcategory={selectedSubcategory}
              onSubcategoryChange={setSelectedSubcategory}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              selectedVehicleId={selectedVehicleId}
              onVehicleChange={setSelectedVehicleId}
              selectedMake={selectedMake}
              onMakeChange={setSelectedMake}
              selectedRegion={selectedRegion}
              onRegionChange={setSelectedRegion}
              selectedFeature={selectedFeature}
              onFeatureChange={setSelectedFeature}
              onOpenCreateModal={() => {
                setEditingCommand(null);
                setIsEditorOpen(true);
              }}
              onOpenCategoryManager={() => setIsCategoryManagerOpen(true)}
              onNavigateToVehicles={() => setActiveMainTab('vehicles')}
              filteredCount={filteredCommands.length}
              totalCount={catalog.commands.length}
              activeMainTab={activeMainTab}
              onChangeMainTab={setActiveMainTab}
            />

            {/* Commands Rendering (Grouped by Subsystem vs Flat Grid) */}
            {filteredCommands.length > 0 ? (
              viewMode === 'grouped' ? (
                <GroupedCommandView
                  commands={filteredCommands}
                  selectedCategory={selectedCategory}
                  onSelectCommand={c => setSelectedCommand(c)}
                  onEditCommand={c => {
                    setEditingCommand(c);
                    setIsEditorOpen(true);
                  }}
                  onDuplicateCommand={handleDuplicateCommand}
                  onDeleteCommand={handleDeleteCommand}
                  draftAddedIds={draftAddedIds}
                  draftModifiedIds={draftModifiedIds}
                  onSelectSubcategory={subcat => setSelectedSubcategory(subcat)}
                  selectedCommandIdsForAutomation={selectedForAutomation}
                  onToggleSelectForAutomation={handleToggleSelectForAutomation}
                  onAddToAutomation={handleAddToAutomation}
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4 min-w-0">
                  {filteredCommands.map(cmd => (
                    <CommandCard
                      key={cmd.id}
                      command={cmd}
                      onSelect={c => setSelectedCommand(c)}
                      onEdit={c => {
                        setEditingCommand(c);
                        setIsEditorOpen(true);
                      }}
                      onDuplicate={handleDuplicateCommand}
                      onDelete={handleDeleteCommand}
                      isNew={draftAddedIds.includes(cmd.id)}
                      isModified={draftModifiedIds.includes(cmd.id)}
                      isSelectedForAutomation={selectedForAutomation.has(cmd.id)}
                      onToggleSelectForAutomation={handleToggleSelectForAutomation}
                      onAddToAutomation={handleAddToAutomation}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="text-center py-16 px-4 rounded-2xl border border-dashed border-slate-800 bg-slate-950/40">
                <Search className="w-8 h-8 text-slate-600 mx-auto mb-3" />
                <h3 className="text-base font-semibold text-slate-300">No CAN messages found</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto mt-1 mb-4">
                  No commands match your current search criteria or vehicle compatibility filter.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setSelectedRole('all');
                    setSelectedCategory('all');
                    setSelectedSubcategory('all');
                    setSelectedVehicleId('all');
                    setSelectedMake('all');
                    setSelectedRegion('all');
                    setSelectedFeature('all');
                  }}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition"
                >
                  Clear All Filters
                </button>
              </div>
            )}
          </div>
        ) : activeMainTab === 'vehicles' ? (
          /* Vehicles Explorer Tab */
          <VehiclesTab
            catalog={catalog}
            onUpdateVehicles={handleUpdateVehicles}
            onSelectVehicleFilter={vId => {
              const target = catalog.vehicles.find(v => v.id === vId);
              setSelectedVehicleId(vId);
              if (target) {
                setSelectedMake(target.make);
                setSelectedRegion(target.region);
              }
              setActiveMainTab('catalog');
            }}
            draftAddedVehicleIds={draftAddedVehicleIds}
            draftModifiedVehicleIds={draftModifiedVehicleIds}
            allDiscoveredFeatures={discoveredFeatures}
            onRegisterDiscoveredFeature={handleRegisterDiscoveredFeature}
            activeMainTab={activeMainTab}
            onChangeMainTab={setActiveMainTab}
          />
        ) : (
          /* Automation Builder Tab */
          <AutomationBuilder
            catalog={catalog}
            rules={automationRules}
            onUpdateRules={setAutomationRules}
            settings={automationSettings}
            onUpdateSettings={setAutomationSettings}
            initialSelectedCommandIds={Array.from(selectedForAutomation)}
            onNavigateToCatalog={() => setActiveMainTab('catalog')}
          />
        )}
      </main>

      {/* Floating Automation Selection Bar */}
      {selectedForAutomation.size > 0 && activeMainTab === 'catalog' && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 border border-cyan-500/50 shadow-2xl shadow-cyan-950/80 rounded-2xl p-2.5 px-4 flex items-center gap-3 backdrop-blur-md animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-200">
            <span className="w-6 h-6 rounded-full bg-cyan-500 text-slate-950 flex items-center justify-center font-bold text-xs">
              {selectedForAutomation.size}
            </span>
            <span>commands selected for automation</span>
          </div>

          <div className="h-4 w-px bg-slate-700" />

          <button
            type="button"
            onClick={handleCreateAutomationFromSelected}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold text-xs shadow transition"
          >
            <Zap className="w-3.5 h-3.5 fill-current" />
            <span>Create Rule</span>
          </button>

          <button
            type="button"
            onClick={() => setSelectedForAutomation(new Set())}
            className="text-xs text-slate-400 hover:text-white px-2 py-1 transition"
          >
            Clear
          </button>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] text-[var(--text-muted)] py-8 px-4 text-xs">
        <div className="max-w-7xl mx-auto flex flex-col items-center justify-center">
          {/* Centered Logo without background, with title and metadata underneath */}
          <div className="flex flex-col items-center justify-center text-center gap-2">
            <div className="flex items-center justify-center transition-transform hover:scale-105">
              <CanDoLogo className="h-10 sm:h-12 w-auto" />
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-1.5 sm:gap-2 text-slate-300 font-medium">
              <span className="font-semibold text-white tracking-wide">CAN Do Automations</span>
              <span className="hidden sm:inline text-slate-600">•</span>
              <span className="text-[var(--text-muted)] font-mono text-[11px]">v{catalog.catalog_version}</span>
              <span className="hidden sm:inline text-slate-600">•</span>
              <span className="text-[var(--text-muted)]">Community Message Catalog</span>
            </div>
          </div>
        </div>
      </footer>

      {/* Home Assistant / CAN Do Anchored Floating Save FAB */}
      <button
        type="button"
        onClick={() => setIsContributeOpen(true)}
        className={`ha-save-fab ${totalPendingCount > 0 ? 'dirty' : ''}`}
        title="Review & Contribute Changes to GitHub"
      >
        <Github className="w-4 h-4" />
        <span>
          {totalPendingCount > 0
            ? `Contribute (${totalPendingCount} Staged)`
            : 'Contribute to GitHub'}
        </span>
      </button>

      {/* Modals */}
      {selectedCommand && (
        <CommandDetailModal
          command={selectedCommand}
          catalog={catalog}
          onClose={() => setSelectedCommand(null)}
          onDelete={handleDeleteCommand}
          onEdit={cmd => {
            setSelectedCommand(null);
            setEditingCommand(cmd);
            setIsEditorOpen(true);
          }}
          onAddToAutomation={(cmd, role) => {
            setSelectedCommand(null);
            handleAddToAutomation(cmd, role);
          }}
        />
      )}

      {isEditorOpen && (
        <CommandEditorModal
          initialCommand={editingCommand}
          catalog={catalog}
          isOpen={isEditorOpen}
          onClose={() => {
            setIsEditorOpen(false);
            setEditingCommand(null);
          }}
          onSave={handleSaveCommand}
          onDelete={handleDeleteCommand}
        />
      )}

      {isImportOpen && (
        <ImportModal
          isOpen={isImportOpen}
          currentCatalog={catalog}
          onClose={() => setIsImportOpen(false)}
          onImport={handleImport}
        />
      )}

      {isContributeOpen && (
        <ContributeModal
          isOpen={isContributeOpen}
          onClose={() => setIsContributeOpen(false)}
          catalog={catalog}
          pendingAdded={pendingAddedCommands}
          pendingModified={pendingModifiedCommands}
          pendingAddedVehicles={pendingAddedVehicles}
          pendingModifiedVehicles={pendingModifiedVehicles}
          repoConfig={repoConfig}
          onUpdateRepoConfig={handleUpdateRepoConfig}
          onClearDrafts={handleClearDrafts}
        />
      )}

      {isHealthOpen && (
        <CatalogHealthModal
          isOpen={isHealthOpen}
          onClose={() => setIsHealthOpen(false)}
          catalog={catalog}
        />
      )}

      {isCategoryManagerOpen && (
        <CategoryManagerModal
          isOpen={isCategoryManagerOpen}
          catalog={catalog}
          onClose={() => setIsCategoryManagerOpen(false)}
          onBatchUpdateCategories={handleBatchUpdateCategories}
        />
      )}

      {isExportOpen && (
        <ExportModal
          isOpen={isExportOpen}
          catalog={catalog}
          initialFormat={exportModalFormat}
          selectedVehicleId={selectedVehicleId}
          selectedCategory={selectedCategory}
          onClose={() => setIsExportOpen(false)}
        />
      )}
    </div>
  );
}
