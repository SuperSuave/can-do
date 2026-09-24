import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Catalog, Command, CommandRole, CommandOption, GitHubRepoConfig, Vehicle, getCommandContributors } from './types/catalog';
import { DEFAULT_CATALOG, normalizeCatalog } from './data/defaultCatalog';
import { validateCatalog } from './utils/canValidator';
import { commandToAction, commandToTrigger } from './utils/automationConverters';
import { getSavedRepoConfig, saveRepoConfig } from './utils/githubHelper';
import { isRunningOnDevice, resolveDeviceBaseUrl } from './utils/hostUtils';
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
import { ErrorBoundary } from './components/ErrorBoundary';
import { CanDoLogo } from './components/CanDoLogo';
import { AutomationBuilder } from './components/AutomationBuilder';
import { DeviceDashboard } from './components/DeviceDashboard';
import { VehicleDashboard } from './components/VehicleDashboard';
import { OnboardingWizardModal } from './components/OnboardingWizardModal';
import { UserPreferences, getUserPreferences, saveUserPreferences, fetchDevicePreferences } from './types/settings';
import { checkForUpdates } from './services/updateService';
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
  Layers,
  Radio,
  Gauge,
  X
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
  // 1. Core catalog state (Strictly from /catalog/can_do_catalog.json)
  const [catalog, setCatalog] = useState<Catalog>(() => {
    try {
      const hasDrafts = (localStorage.getItem(STORAGE_KEY_DRAFT_ADDED) || '[]') !== '[]' ||
                        (localStorage.getItem(STORAGE_KEY_DRAFT_MODIFIED) || '[]') !== '[]';
      const saved = localStorage.getItem(STORAGE_KEY_CATALOG);
      if (saved && hasDrafts) {
        const parsed = JSON.parse(saved);
        if (parsed.commands && parsed.vehicles) {
          return normalizeCatalog(parsed);
        }
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
  const [activeMainTab, setActiveMainTab] = useState<'dashboard' | 'catalog' | 'vehicles' | 'automations' | 'device'>('dashboard');
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
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((rule: AutomationRule) => ({
            ...rule,
            triggers: (rule.triggers || []).map(trig => {
              if (trig.id === 'trig_menu_ok' || (!trig.source_command_id && trig.can_id === '0x448')) {
                return {
                  ...trig,
                  source_command_id: trig.source_command_id || 'sw_menu',
                  source_command_name: trig.source_command_name || 'Menu / OK Button',
                  option_label: trig.option_label || 'Menu OK / Press'
                };
              }
              return trig;
            }),
            actions: (rule.actions || []).map(act => {
              if (act.id === 'act_cool_driver_seat' || act.entity_id === 'drivers_seat_comfort') {
                return {
                  ...act,
                  source_command_id: act.source_command_id || 'drivers_seat_comfort',
                  source_command_name: act.source_command_name || 'Driver Seat Comfort',
                  option_label: act.option_label || act.command || 'Medium Cool'
                };
              }
              return act;
            })
          }));
        }
      }
    } catch (e) {
      console.error('Failed to load automation rules from storage', e);
    }
    if ((DEFAULT_CATALOG as any).automations && Array.isArray((DEFAULT_CATALOG as any).automations) && (DEFAULT_CATALOG as any).automations.length > 0) {
      return (DEFAULT_CATALOG as any).automations;
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

  // Main navigation tab slider state
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [sliderStyle, setSliderStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  useEffect(() => {
    const updateSlider = () => {
      const currentBtn = tabRefs.current[activeMainTab];
      if (currentBtn) {
        setSliderStyle({
          left: currentBtn.offsetLeft,
          width: currentBtn.offsetWidth,
        });
      }
    };
    updateSlider();
    window.addEventListener('resize', updateSlider);
    const timer = setTimeout(updateSlider, 50);
    return () => {
      window.removeEventListener('resize', updateSlider);
      clearTimeout(timer);
    };
  }, [activeMainTab, catalog.commands.length, catalog.vehicles.length, automationRules.length]);

  // 5. Filters state
  const [search, setSearch] = useState('');
  const [selectedRole, setSelectedRole] = useState<CommandRole | 'all'>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'grouped'>('grouped');
  const [expandAllSignal, setExpandAllSignal] = useState<number>(0);
  const [collapseAllSignal, setCollapseAllSignal] = useState<number>(0);
  const [userPreferences, setUserPreferences] = useState<UserPreferences>(() => getUserPreferences());
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(() => !getUserPreferences().onboarding_completed);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(() => getUserPreferences().vehicle_id || 'all');
  const [selectedMake, setSelectedMake] = useState<string>('all');
  const [selectedRegion, setSelectedRegion] = useState<string>('all');
  const [selectedFeature, setSelectedFeature] = useState<string>('all');

  // Pull latest catalog strictly from /catalog/can_do_catalog.json with smart client-side caching
  useEffect(() => {
    const fetchCatalog = async () => {
      const hasDrafts = (localStorage.getItem(STORAGE_KEY_DRAFT_ADDED) || '[]') !== '[]' ||
                        (localStorage.getItem(STORAGE_KEY_DRAFT_MODIFIED) || '[]') !== '[]';
      if (!hasDrafts) {
        // If we already have a valid cached catalog in localStorage, skip network request
        const cached = localStorage.getItem(STORAGE_KEY_CATALOG);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.commands && parsed.vehicles) {
              setCatalog(normalizeCatalog(parsed));
              return;
            }
          } catch {}
        }

        try {
          const res = await fetch(`${import.meta.env.BASE_URL}catalog/can_do_catalog.json`);
          if (res.ok) {
            const data = await res.json();
            if (data && data.commands && data.vehicles) {
              setCatalog(normalizeCatalog(data));
              try {
                localStorage.setItem(STORAGE_KEY_CATALOG, JSON.stringify(data));
              } catch {}
              return;
            }
          }
        } catch {
          // Fallback to DEFAULT_CATALOG which is directly imported from /catalog
        }
      }
    };
    fetchCatalog();
  }, []);

  // Synchronize User Preferences directly from CAN Do device storage (resolves cross-device & force-refresh loss)
  useEffect(() => {
    let cancelled = false;
    const syncFromDevice = async () => {
      try {
        const devicePrefs = await fetchDevicePreferences();
        if (!cancelled && devicePrefs) {
          setUserPreferences(devicePrefs);
          if (devicePrefs.onboarding_completed) {
            setIsOnboardingOpen(false);
          }
          if (devicePrefs.vehicle_id && devicePrefs.vehicle_id !== 'all') {
            setSelectedVehicleId(devicePrefs.vehicle_id);
          }
        }
      } catch {
        // Device offline or unreachable
      }
    };
    syncFromDevice();
    return () => {
      cancelled = true;
    };
  }, []);

  // Scheduled Off-Hours Update Checker
  useEffect(() => {
    if (!userPreferences.update_schedule?.enabled || userPreferences.update_policy === 'manual') {
      return;
    }

    const interval = setInterval(() => {
      const now = new Date();
      const currentHhMm = now.toTimeString().slice(0, 5);
      if (currentHhMm === userPreferences.update_schedule.time) {
        checkForUpdates(catalog?.catalog_version || '2026.9.1', '2026.9.1').then((res) => {
          if (res.has_update) {
            console.log('[Scheduler] New update available:', res.release_name || res.version);
          }
        }).catch(() => {});
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [userPreferences.update_schedule, userPreferences.update_policy, catalog.catalog_version]);

  const handleCompleteOnboarding = (prefs: UserPreferences) => {
    const saved = saveUserPreferences(prefs);
    setUserPreferences(saved);
    if (prefs.vehicle_id && prefs.vehicle_id !== 'all') {
      setSelectedVehicleId(prefs.vehicle_id);
    }
    setIsOnboardingOpen(false);
  };

  const handleUpdatePreferences = (prefs: Partial<UserPreferences>) => {
    const saved = saveUserPreferences(prefs);
    setUserPreferences(saved);
    if (prefs.vehicle_id && prefs.vehicle_id !== 'all') {
      setSelectedVehicleId(prefs.vehicle_id);
    }
  };

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
        const cmdName = cmd.name || cmd.ha_metadata?.name || cmd.id || '';
        const matchesName = cmdName.toLowerCase().includes(q);
        const matchesId = (cmd.id || '').toLowerCase().includes(q);
        const stateId = cmd.state_can_id || cmd.network?.state_can_id || '';
        const actionId = cmd.action_can_id || cmd.network?.action_can_id || '';
        const matchesCanId = stateId.toLowerCase().includes(q) || actionId.toLowerCase().includes(q);
        const matchesCategory = (cmd.category || '').toLowerCase().includes(q);
        const matchesSubcategory = (cmd.subcategory || '').toLowerCase().includes(q);
        const matchesFrom = typeof cmd.from_payload === 'string' ? cmd.from_payload.toLowerCase().includes(q) : false;
        const matchesTo = typeof cmd.to_payload === 'string' ? cmd.to_payload.toLowerCase().includes(q) : false;
        const matchesMatch = typeof cmd.match_payload === 'string' ? cmd.match_payload.toLowerCase().includes(q) : false;
        const matchesOptions = cmd.options?.some(
          o =>
            (o.label || '').toLowerCase().includes(q) ||
            (typeof o.payload === 'string' && o.payload.toLowerCase().includes(q)) ||
            (typeof o.match_payload === 'string' && o.match_payload.toLowerCase().includes(q)) ||
            (typeof o.to_payload === 'string' && o.to_payload.toLowerCase().includes(q)) ||
            (o.state_value !== undefined && String(o.state_value).toLowerCase().includes(q)) ||
            (o.description || '').toLowerCase().includes(q)
        );
        const cleanQ = q.replace(/^@/, '');
        const cmdContribs = getCommandContributors(cmd);
        const matchesContributor = cmdContribs.some(
          c =>
            (c.name && c.name.toLowerCase().includes(cleanQ)) ||
            (c.github && c.github.toLowerCase().includes(cleanQ)) ||
            (c.notes && c.notes.toLowerCase().includes(cleanQ)) ||
            (c.role && c.role.toLowerCase().includes(cleanQ))
        );
        const matchesHaDomain = (cmd.ha_domain || cmd.ha_metadata?.domain || '').toLowerCase().includes(q);
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

  const handleReloadCatalog = async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}catalog/can_do_catalog.json`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.commands && data.vehicles) {
          const normalized = normalizeCatalog(data);
          setCatalog(normalized);
          localStorage.setItem(STORAGE_KEY_CATALOG, JSON.stringify(normalized));
          alert(`Successfully reloaded catalog (v${data.catalog_version || '1.0.0'}) from /catalog!`);
          return;
        }
      }
      setCatalog(DEFAULT_CATALOG);
      localStorage.setItem(STORAGE_KEY_CATALOG, JSON.stringify(DEFAULT_CATALOG));
      alert('Reloaded catalog from /catalog/can_do_catalog.json.');
    } catch (e) {
      console.error(e);
      setCatalog(DEFAULT_CATALOG);
      alert('Reloaded catalog from /catalog.');
    }
  };

  const handleClearDrafts = () => {
    setDraftAddedIds([]);
    setDraftModifiedIds([]);
    setDraftAddedVehicleIds([]);
    setDraftModifiedVehicleIds([]);
  };

  const handleSyncAutomationsToDevice = async () => {
    try {
      const base = resolveDeviceBaseUrl(localStorage.getItem('cando_device_host'));
      const payload = {
        version: "1.0",
        settings: automationSettings,
        rules: automationRules
      };
      const res = await fetch(`${base}/api/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err: any) {
      alert(`Failed to deploy automations to device: ${err.message}`);
      throw err;
    }
  };

  const handlePullAutomationsFromDevice = async (silent: boolean = false) => {
    try {
      const base = resolveDeviceBaseUrl(localStorage.getItem('cando_device_host'));
      const res = await fetch(`${base}/api/automations`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data && Array.isArray(data.rules)) {
        setAutomationRules(data.rules);
      }
      if (data && data.settings) {
        setAutomationSettings(data.settings);
      }
    } catch (err: any) {
      if (!silent) {
        alert(`Failed to pull automations from device: ${err.message}`);
      }
      throw err;
    }
  };

  // Automatically pull automations from device on boot if running on-device
  const hasAutoPulledDevice = useRef(false);
  useEffect(() => {
    if (isRunningOnDevice() && !hasAutoPulledDevice.current) {
      hasAutoPulledDevice.current = true;
      handlePullAutomationsFromDevice(true).catch(() => {});
    }
  }, []);

  const handleAddToAutomation = (command: Command, role?: CommandRole, option?: CommandOption) => {
    const isAction = role === 'action' || (!role && command.roles?.includes('action') && !command.roles?.includes('trigger'));

    setAutomationRules(prev => {
      const nextRules = [...prev];
      let activeRule = nextRules[0];

      if (!activeRule) {
        activeRule = {
          id: `rule_${Date.now()}`,
          name: `Automate: ${command.name}${option?.label ? ` (${option.label})` : ''}`,
          enabled: true,
          ha_expose: true,
          ha_icon: command.icon || command.mdi || 'mdi:car-cog',
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
        activeRule.actions.push(commandToAction(command, option));
      } else {
        activeRule.triggers.push(commandToTrigger(command, option));
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
                {catalog.catalog_version}
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

            {/* Reload from /catalog Button */}
            <button
              type="button"
              onClick={handleReloadCatalog}
              className="dash-outline-btn inline-flex items-center gap-1.5 text-xs py-1.5 px-3.5 text-cyan-300 hover:text-cyan-200"
              title="Pull latest catalog directly from /catalog/can_do_catalog.json"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reload /catalog</span>
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
      <div className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
          <div className="relative flex items-center justify-center h-14">
            {/* Centered Segmented Tab Group with Sliding Indicator */}
            <nav
              className="relative inline-flex items-center p-1 rounded-xl bg-slate-900/90 border border-slate-800/80 shadow-inner overflow-x-auto no-scrollbar"
              aria-label="Main Navigation"
            >
              {/* Sliding Active Indicator Pill */}
              <div
                className="absolute top-1 bottom-1 rounded-lg bg-slate-800 border border-slate-700/80 shadow-sm transition-all duration-300 ease-out pointer-events-none"
                style={{
                  left: `${sliderStyle.left}px`,
                  width: `${sliderStyle.width}px`,
                  opacity: sliderStyle.width > 0 ? 1 : 0,
                }}
              />

              <button
                id="main-tab-dashboard"
                ref={el => { tabRefs.current['dashboard'] = el; }}
                type="button"
                onClick={() => setActiveMainTab('dashboard')}
                className={`relative z-10 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                  activeMainTab === 'dashboard'
                    ? 'text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Gauge className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeMainTab === 'dashboard' ? 'text-sky-400' : 'text-slate-500'}`} />
                <span>Live Cockpit</span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors ${
                    activeMainTab === 'dashboard'
                      ? 'bg-slate-900/90 text-sky-300 border border-slate-700/70'
                      : 'bg-slate-950/60 text-slate-400 border border-slate-800/60'
                  }`}
                >
                  LIVE
                </span>
              </button>

              <button
                id="main-tab-messages"
                ref={el => { tabRefs.current['catalog'] = el; }}
                type="button"
                onClick={() => setActiveMainTab('catalog')}
                className={`relative z-10 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                  activeMainTab === 'catalog'
                    ? 'text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Layers className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeMainTab === 'catalog' ? 'text-cyan-400' : 'text-slate-500'}`} />
                <span>Messages</span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors ${
                    activeMainTab === 'catalog'
                      ? 'bg-slate-900/90 text-cyan-300 border border-slate-700/70'
                      : 'bg-slate-950/60 text-slate-400 border border-slate-800/60'
                  }`}
                >
                  {catalog.commands.length}
                </span>
              </button>

              <button
                id="main-tab-vehicles"
                ref={el => { tabRefs.current['vehicles'] = el; }}
                type="button"
                onClick={() => setActiveMainTab('vehicles')}
                className={`relative z-10 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                  activeMainTab === 'vehicles'
                    ? 'text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Car className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeMainTab === 'vehicles' ? 'text-indigo-400' : 'text-slate-500'}`} />
                <span>Vehicles</span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors ${
                    activeMainTab === 'vehicles'
                      ? 'bg-slate-900/90 text-indigo-300 border border-slate-700/70'
                      : 'bg-slate-950/60 text-slate-400 border border-slate-800/60'
                  }`}
                >
                  {catalog.vehicles.length}
                </span>
              </button>

              <button
                id="main-tab-automations"
                ref={el => { tabRefs.current['automations'] = el; }}
                type="button"
                onClick={() => setActiveMainTab('automations')}
                className={`relative z-10 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                  activeMainTab === 'automations'
                    ? 'text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Zap className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeMainTab === 'automations' ? 'text-amber-400' : 'text-slate-500'}`} />
                <span>Automations</span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors ${
                    activeMainTab === 'automations'
                      ? 'bg-slate-900/90 text-amber-300 border border-slate-700/70'
                      : 'bg-slate-950/60 text-slate-400 border border-slate-800/60'
                  }`}
                >
                  {automationRules.length}
                </span>
              </button>

              <button
                id="main-tab-device"
                ref={el => { tabRefs.current['device'] = el; }}
                type="button"
                onClick={() => setActiveMainTab('device')}
                className={`relative z-10 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                  activeMainTab === 'device'
                    ? 'text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Radio className={`w-3.5 h-3.5 shrink-0 transition-colors ${activeMainTab === 'device' ? 'text-emerald-400' : 'text-slate-500'}`} />
                <span>Device Console</span>
              </button>
            </nav>

            {/* Quick action button positioned to the right */}
            {activeMainTab === 'catalog' && selectedForAutomation.size > 0 && (
              <div className="absolute right-0 flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleCreateAutomationFromSelected}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition shadow-sm"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span className="hidden sm:inline">Build with ({selectedForAutomation.size})</span>
                  <span className="sm:hidden">({selectedForAutomation.size})</span>
                </button>
              </div>
            )}
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
              onExpandAll={() => setExpandAllSignal(s => s + 1)}
              onCollapseAll={() => setCollapseAllSignal(s => s + 1)}
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
                  expandAllSignal={expandAllSignal}
                  collapseAllSignal={collapseAllSignal}
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
        ) : activeMainTab === 'automations' ? (
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
        ) : activeMainTab === 'dashboard' ? (
          /* Live Vehicle Cockpit Dashboard */
          <VehicleDashboard
            catalog={catalog}
            unitSystem={userPreferences.unit_system}
            activeVehicle={
              selectedVehicleId !== 'all'
                ? catalog.vehicles.find(v => v.id === selectedVehicleId)
                : catalog.vehicles[0]
            }
            onSelectVehicle={vId => setSelectedVehicleId(vId)}
            onNavigateToCatalog={(searchQuery) => {
              if (searchQuery) setSearch(searchQuery);
              setActiveMainTab('catalog');
            }}
            onNavigateToAutomations={() => setActiveMainTab('automations')}
          />
        ) : (
          /* Device Console Tab */
          <DeviceDashboard
            catalog={catalog}
            automationRules={automationRules}
            preferences={userPreferences}
            onUpdatePreferences={handleUpdatePreferences}
            onRerunOnboarding={() => setIsOnboardingOpen(true)}
            onSyncAutomationsToDevice={handleSyncAutomationsToDevice}
            onPullAutomationsFromDevice={handlePullAutomationsFromDevice}
            onNavigateToCatalog={(searchQuery) => {
              if (searchQuery) setSearch(searchQuery);
              setActiveMainTab('catalog');
            }}
            onNavigateToAutomations={() => setActiveMainTab('automations')}
            onCreateCommandFromCanId={(canId, sampleData) => {
              setEditingCommand({
                id: `cmd_${canId.toLowerCase().replace(/^0x/, '')}_${Date.now().toString(36).slice(-4)}`,
                name: `CAN Message ${canId}`,
                category: 'telemetry',
                subcategory: 'general',
                can_id: canId,
                state_can_id: canId,
                bus: 0,
                roles: ['trigger'],
                match_payload: sampleData || '00 00 00 00 00 00 00 00',
                from_payload: sampleData || '00 00 00 00 00 00 00 00',
                notes: `Captured from live TWAI CAN bus`
              });
              setIsEditorOpen(true);
            }}
            onCreateAutomationFromFrame={(canId, sampleData) => {
              const newRule: AutomationRule = {
                id: `rule_can_${canId.toLowerCase().replace(/^0x/, '')}_${Date.now()}`,
                name: `React to CAN ${canId}`,
                enabled: true,
                ha_expose: true,
                ha_icon: 'mdi:car-cog',
                exec_mode: 'one_shot',
                trigger_mode: 'any',
                cooldown_ms: 500,
                timeout_reset_ms: 0,
                triggers: [{
                  id: `trig_${Date.now()}`,
                  source: 'can',
                  bus: 0,
                  can_id: canId,
                  match_payload: sampleData || '00 00 00 00 00 00 00 00',
                  click_count: 1
                }],
                conditions: [],
                actions: []
              };
              setAutomationRules(prev => [newRule, ...prev]);
              setActiveMainTab('automations');
            }}
            onCreateAutomationWithTrigger={(trigger) => {
              const newRule: AutomationRule = {
                id: `rule_ble_${Date.now()}`,
                name: `Bluetooth ${trigger.ble_button || 'Button'} Trigger`,
                enabled: true,
                ha_expose: true,
                ha_icon: 'mdi:bluetooth',
                exec_mode: 'one_shot',
                trigger_mode: 'any',
                cooldown_ms: 0,
                timeout_reset_ms: 0,
                triggers: [trigger],
                conditions: [],
                actions: []
              };
              setAutomationRules(prev => [newRule, ...prev]);
              setActiveMainTab('automations');
            }}
          />
        )}
      </main>

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
              <span className="text-[var(--text-muted)] font-mono text-[11px]">{catalog.catalog_version}</span>
              <span className="hidden sm:inline text-slate-600">•</span>
              <span className="text-[var(--text-muted)]">Community Message Catalog</span>
            </div>
          </div>
        </div>
      </footer>

      {/* Floating Action Buttons (FAB Stack) */}
      <div className="ha-fab-stack">
        {/* Contribute to GitHub FAB: only visible if edits exist */}
        {totalPendingCount > 0 && (
          <button
            type="button"
            onClick={() => setIsContributeOpen(true)}
            className="ha-save-fab dirty"
            title="Review & Contribute Changes to GitHub"
          >
            <Github className="w-4 h-4" />
            <span>Contribute ({totalPendingCount} Staged)</span>
          </button>
        )}

        {/* Automate FAB */}
        {activeMainTab === 'catalog' && (
          <div className="flex items-center gap-2">
            {selectedForAutomation.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedForAutomation(new Set())}
                title="Clear selected commands"
                className="inline-flex items-center gap-1 h-9 px-3 rounded-full bg-slate-900/90 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700 text-xs font-semibold shadow-lg backdrop-blur transition"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (selectedForAutomation.size > 0) {
                  handleCreateAutomationFromSelected();
                } else {
                  setActiveMainTab('automations');
                }
              }}
              className={`ha-automate-fab ${selectedForAutomation.size > 0 ? 'active' : ''}`}
              title={
                selectedForAutomation.size > 0
                  ? `Create Automation Rule with ${selectedForAutomation.size} selected command${selectedForAutomation.size > 1 ? 's' : ''}`
                  : 'Open Automation Builder'
              }
            >
              <Zap className={`w-4 h-4 ${selectedForAutomation.size > 0 ? 'fill-current' : ''}`} />
              <span>
                {selectedForAutomation.size > 0
                  ? `+ Automate (${selectedForAutomation.size})`
                  : '+ Automate'}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      {selectedCommand && (
        <ErrorBoundary
          fallbackTitle="Unable to load command details"
          onReset={() => setSelectedCommand(null)}
        >
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
            onAddToAutomation={(cmd, role, opt) => {
              setSelectedCommand(null);
              handleAddToAutomation(cmd, role, opt);
            }}
          />
        </ErrorBoundary>
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

      {/* First-Use Onboarding Experience */}
      <OnboardingWizardModal
        isOpen={isOnboardingOpen}
        catalog={catalog}
        initialPreferences={userPreferences}
        onComplete={handleCompleteOnboarding}
        onClose={() => setIsOnboardingOpen(false)}
      />
    </div>
  );
}
