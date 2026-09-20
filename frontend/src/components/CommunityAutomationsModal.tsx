import React, { useState, useMemo } from 'react';
import {
  AutomationRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';
import { Catalog } from '../types/catalog';
import {
  Sparkles,
  Search,
  Plus,
  Check,
  X,
  ExternalLink,
  Copy,
  Upload,
  Share2,
  Zap,
  Shield,
  Send,
  Sliders,
  Info,
  Tag,
  Car,
  FileCode,
  Github
} from 'lucide-react';

interface CommunityAutomationsModalProps {
  catalog: Catalog;
  currentRules: AutomationRule[];
  activeRule?: AutomationRule | null;
  onInstallRule: (rule: AutomationRule) => void;
  onClose: () => void;
}

export const CommunityAutomationsModal: React.FC<CommunityAutomationsModalProps> = ({
  catalog,
  currentRules,
  activeRule,
  onInstallRule,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<'browse' | 'import' | 'share'>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [installedIdSet, setInstalledIdSet] = useState<Set<string>>(
    () => new Set(currentRules.map(r => r.id))
  );
  const [recentlyInstalledId, setRecentlyInstalledId] = useState<string | null>(null);

  // Import State
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [parsedImportRule, setParsedImportRule] = useState<AutomationRule | null>(null);

  // Share State
  const [selectedShareRuleId, setSelectedShareRuleId] = useState<string>(
    activeRule?.id || currentRules[0]?.id || ''
  );
  const [contributorName, setContributorName] = useState('');
  const [contributorGithub, setContributorGithub] = useState('');
  const [shareCopied, setShareCopied] = useState(false);

  // Community Automations from Catalog
  const communityList: AutomationRule[] = useMemo(() => {
    const fromCat = catalog.automations;
    if (Array.isArray(fromCat) && fromCat.length > 0) {
      return fromCat;
    }
    return [];
  }, [catalog]);

  // Categories present in catalog
  const categories = useMemo(() => {
    const set = new Set<string>();
    communityList.forEach(item => {
      if (item.category) set.add(item.category);
    });
    return Array.from(set);
  }, [communityList]);

  // Filtered list
  const filteredList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return communityList.filter(item => {
      const matchCat = selectedCategory === 'all' || item.category === selectedCategory;
      if (!matchCat) return false;
      if (!q) return true;
      const matchName = item.name.toLowerCase().includes(q);
      const matchDesc = (item.description || '').toLowerCase().includes(q);
      const matchContrib = (item.contributor?.name || '').toLowerCase().includes(q);
      const matchTags = (item.tags || []).some(t => t.toLowerCase().includes(q));
      return matchName || matchDesc || matchContrib || matchTags;
    });
  }, [communityList, searchQuery, selectedCategory]);

  const handleInstall = (preset: AutomationRule) => {
    // Clone with unique ID if already installed
    let ruleId = preset.id;
    if (currentRules.some(r => r.id === ruleId)) {
      ruleId = `${preset.id}_${Date.now().toString().slice(-4)}`;
    }

    const cloned: AutomationRule = {
      ...preset,
      id: ruleId,
      enabled: true
    };

    onInstallRule(cloned);
    setInstalledIdSet(prev => new Set(prev).add(preset.id).add(ruleId));
    setRecentlyInstalledId(preset.id);
    setTimeout(() => setRecentlyInstalledId(null), 2500);
  };

  // Import Parser
  const handleParseImport = () => {
    setImportError(null);
    setParsedImportRule(null);
    const trimmed = importText.trim();
    if (!trimmed) {
      setImportError('Please paste an automation JSON object or snippet.');
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const candidate = parsed.rule || (Array.isArray(parsed) ? parsed[0] : parsed);
      if (!candidate || typeof candidate !== 'object') {
        throw new Error('Invalid JSON format: expected an automation object.');
      }
      if (!candidate.name) {
        throw new Error('Missing "name" field in automation object.');
      }
      if (!Array.isArray(candidate.triggers) || candidate.triggers.length === 0) {
        throw new Error('Automation must contain at least one trigger.');
      }
      if (!Array.isArray(candidate.actions) || candidate.actions.length === 0) {
        throw new Error('Automation must contain at least one action.');
      }

      const validated: AutomationRule = {
        id: candidate.id || `community_import_${Date.now().toString().slice(-5)}`,
        name: candidate.name,
        description: candidate.description || 'Community imported automation rule',
        category: candidate.category || 'Community Import',
        tags: candidate.tags || ['imported'],
        enabled: candidate.enabled ?? true,
        ha_expose: candidate.ha_expose ?? true,
        ha_icon: candidate.ha_icon || 'mdi:car-cog',
        exec_mode: candidate.exec_mode || 'one_shot',
        cooldown_ms: candidate.cooldown_ms ?? 500,
        triggers: candidate.triggers,
        conditions: candidate.conditions || [],
        actions: candidate.actions,
        contributor: candidate.contributor
      };

      setParsedImportRule(validated);
    } catch (err: any) {
      setImportError(err.message || 'Could not parse automation JSON');
    }
  };

  const handleInstallImported = () => {
    if (!parsedImportRule) return;
    handleInstall(parsedImportRule);
    setImportText('');
    setParsedImportRule(null);
    setActiveTab('browse');
  };

  // Share Formatter
  const ruleToShare = useMemo(() => {
    return currentRules.find(r => r.id === selectedShareRuleId) || activeRule;
  }, [currentRules, selectedShareRuleId, activeRule]);

  const sharePayload = useMemo(() => {
    if (!ruleToShare) return '';
    const out: Partial<AutomationRule> = {
      id: ruleToShare.id,
      name: ruleToShare.name,
      description: ruleToShare.description || 'Custom CAN Do automation rule',
      category: ruleToShare.category || 'Custom',
      tags: ruleToShare.tags || ['all_egmp'],
      enabled: ruleToShare.enabled,
      ha_expose: ruleToShare.ha_expose,
      ha_icon: ruleToShare.ha_icon,
      exec_mode: ruleToShare.exec_mode,
      cooldown_ms: ruleToShare.cooldown_ms,
      triggers: ruleToShare.triggers,
      conditions: ruleToShare.conditions,
      actions: ruleToShare.actions,
      contributor: {
        name: contributorName.trim() || 'Community Contributor',
        github: contributorGithub.trim().replace(/^@/, '') || undefined
      }
    };
    return JSON.stringify(out, null, 2);
  }, [ruleToShare, contributorName, contributorGithub]);

  const handleCopyShareJson = () => {
    if (!sharePayload) return;
    navigator.clipboard.writeText(sharePayload);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const handleOpenGithubIssue = () => {
    if (!ruleToShare) return;
    const title = encodeURIComponent(`[Community Automation] ${ruleToShare.name}`);
    const body = encodeURIComponent(
      `### Community Automation Submission\n\n` +
      `**Name:** ${ruleToShare.name}\n` +
      `**Description:** ${ruleToShare.description || ''}\n` +
      `**Category:** ${ruleToShare.category || 'General'}\n` +
      `**Contributor:** ${contributorName || 'Community'}${contributorGithub ? ` (@${contributorGithub.replace(/^@/, '')})` : ''}\n\n` +
      `\`\`\`json\n${sharePayload}\n\`\`\`\n`
    );
    window.open(`https://github.com/SuperSuave/can-do/issues/new?title=${title}&body=${body}`, '_blank');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in">
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header Strip */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between gap-3 bg-slate-900/90">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30 shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-white truncate">
                  Community Automations
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  {communityList.length} Verified
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate">
                Discover, 1-click install, and share vehicle automations crafted by the CAN Do community.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-4 sm:px-5 border-b border-slate-800 bg-slate-950/50 gap-2 overflow-x-auto text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('browse')}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'browse'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Browse Library</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-slate-800 text-slate-300">
              {filteredList.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('import')}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'import'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import from JSON / Gist</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('share')}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'share'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Share Your Automation</span>
          </button>
        </div>

        {/* Tab Content Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {/* TAB 1: BROWSE */}
          {activeTab === 'browse' && (
            <div className="space-y-4">
              {/* Search & Category Filter */}
              <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search automations by button, feature, tag, or author..."
                    className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Category Pills */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 text-xs shrink-0">
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('all')}
                    className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                      selectedCategory === 'all'
                        ? 'bg-cyan-500 text-slate-950 font-bold'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    All
                  </button>
                  {categories.map(cat => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-2.5 py-1.5 rounded-lg font-medium transition whitespace-nowrap ${
                        selectedCategory === cat
                          ? 'bg-cyan-500 text-slate-950 font-bold'
                          : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Automation Cards Grid */}
              {filteredList.length === 0 ? (
                <div className="p-8 text-center rounded-2xl bg-slate-950/40 border border-dashed border-slate-800 space-y-2">
                  <Sparkles className="w-8 h-8 text-slate-600 mx-auto" />
                  <div className="text-sm font-semibold text-slate-300">No automations match your search</div>
                  <p className="text-xs text-slate-500">
                    Try adjusting your filters or search keywords, or import a community JSON snippet.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {filteredList.map(item => {
                    const isInstalled = installedIdSet.has(item.id);
                    const isJustInstalled = recentlyInstalledId === item.id;

                    return (
                      <div
                        key={item.id}
                        className={`p-4 rounded-xl border flex flex-col justify-between transition-all duration-200 ${
                          isJustInstalled
                            ? 'bg-emerald-950/30 border-emerald-500/50 shadow-lg shadow-emerald-900/20'
                            : 'bg-slate-950/60 hover:bg-slate-950/90 border-slate-800/80 hover:border-slate-700'
                        }`}
                      >
                        <div className="space-y-2.5">
                          {/* Top Badges */}
                          <div className="flex items-center justify-between gap-2">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-800 text-cyan-400 border border-slate-700/60">
                              {item.category || 'General'}
                            </span>
                            {item.contributor && (
                              <div className="flex items-center gap-1 text-[11px] text-slate-400 font-medium">
                                <Github className="w-3 h-3 text-slate-500" />
                                <span>{item.contributor.name || 'Community'}</span>
                              </div>
                            )}
                          </div>

                          {/* Title & Description */}
                          <div>
                            <h3 className="text-sm font-bold text-white group-hover:text-cyan-300 transition">
                              {item.name}
                            </h3>
                            <p className="text-xs text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                              {item.description}
                            </p>
                          </div>

                          {/* Summary Chips */}
                          <div className="flex items-center gap-3 pt-1 text-[11px] font-mono text-slate-400 border-t border-slate-800/60">
                            <span className="flex items-center gap-1 text-amber-300">
                              <Zap className="w-3 h-3 text-amber-400" />
                              {item.triggers.length} {item.triggers.length === 1 ? 'Trigger' : 'Triggers'}
                            </span>
                            {item.conditions && item.conditions.length > 0 && (
                              <span className="flex items-center gap-1 text-cyan-300">
                                <Shield className="w-3 h-3 text-cyan-400" />
                                {item.conditions.length} {item.conditions.length === 1 ? 'Cond' : 'Conds'}
                              </span>
                            )}
                            <span className="flex items-center gap-1 text-emerald-300">
                              <Send className="w-3 h-3 text-emerald-400" />
                              {item.actions.length} {item.actions.length === 1 ? 'Action' : 'Actions'}
                            </span>
                          </div>
                        </div>

                        {/* Action Bar */}
                        <div className="pt-3 mt-2 flex items-center justify-between gap-2 border-t border-slate-900">
                          <div className="flex items-center gap-1 text-[10px] text-slate-500 font-mono">
                            <Car className="w-3 h-3" />
                            <span>{(item.tags || ['all_egmp']).join(', ')}</span>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleInstall(item)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm active:scale-95 ${
                              isJustInstalled
                                ? 'bg-emerald-500 text-slate-950 font-black'
                                : isInstalled
                                ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
                                : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950'
                            }`}
                          >
                            {isJustInstalled ? (
                              <>
                                <Check className="w-3.5 h-3.5 stroke-[3]" />
                                <span>Installed!</span>
                              </>
                            ) : isInstalled ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span>Add Another Copy</span>
                              </>
                            ) : (
                              <>
                                <Plus className="w-3.5 h-3.5 stroke-[3]" />
                                <span>1-Click Install</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: IMPORT */}
          {activeTab === 'import' && (
            <div className="space-y-4 max-w-2xl mx-auto">
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2 text-xs">
                <div className="flex items-center gap-2 font-bold text-white">
                  <Info className="w-4 h-4 text-cyan-400" />
                  <span>Import Community Recipe</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  Paste an automation JSON snippet shared by another user on Discord, Reddit, or a GitHub Gist.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block">
                  Paste JSON / Recipe Code
                </label>
                <textarea
                  rows={8}
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  placeholder={`{\n  "name": "Auto-Fold Mirrors on Lock",\n  "triggers": [...],\n  "actions": [...]\n}`}
                  className="w-full p-3 font-mono text-xs bg-slate-950 border border-slate-800 rounded-xl text-emerald-400 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                />
              </div>

              {importError && (
                <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/80 text-rose-300 text-xs font-medium">
                  {importError}
                </div>
              )}

              {parsedImportRule && (
                <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-300">Preview Validated Rule</span>
                    <span className="text-[10px] font-mono text-emerald-400">Ready to install</span>
                  </div>
                  <h4 className="text-sm font-bold text-white">{parsedImportRule.name}</h4>
                  <p className="text-xs text-slate-400">{parsedImportRule.description}</p>
                  <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400 pt-1">
                    <span>{parsedImportRule.triggers.length} Triggers</span>
                    <span>{parsedImportRule.conditions.length} Conditions</span>
                    <span>{parsedImportRule.actions.length} Actions</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                {!parsedImportRule ? (
                  <button
                    type="button"
                    onClick={handleParseImport}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition shadow-sm"
                  >
                    Validate & Preview
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleInstallImported}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition shadow-sm flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4 stroke-[3]" />
                    <span>Install to My Automations</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: SHARE */}
          {activeTab === 'share' && (
            <div className="space-y-4 max-w-2xl mx-auto">
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2 text-xs">
                <div className="flex items-center gap-2 font-bold text-white">
                  <Share2 className="w-4 h-4 text-cyan-400" />
                  <span>Share Your Automation with the Community</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  Export your rule formatted for community sharing. You can submit it to the CAN Do GitHub repository to be included in the official catalog for all drivers!
                </p>
              </div>

              {/* Rule Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block">
                  Select Automation to Share
                </label>
                <select
                  value={selectedShareRuleId}
                  onChange={e => setSelectedShareRuleId(e.target.value)}
                  className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                >
                  {currentRules.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.triggers.length} trig, {r.actions.length} act)
                    </option>
                  ))}
                </select>
              </div>

              {/* Contributor Inputs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-400 block">
                    Your Name / Handle
                  </label>
                  <input
                    type="text"
                    value={contributorName}
                    onChange={e => setContributorName(e.target.value)}
                    placeholder="e.g. SuperSuave"
                    className="w-full p-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-400 block">
                    GitHub Username (Optional)
                  </label>
                  <input
                    type="text"
                    value={contributorGithub}
                    onChange={e => setContributorGithub(e.target.value)}
                    placeholder="e.g. SuperSuave"
                    className="w-full p-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>
              </div>

              {/* JSON Preview */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block">
                    Shareable Recipe JSON
                  </label>
                  <button
                    type="button"
                    onClick={handleCopyShareJson}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1"
                  >
                    {shareCopied ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Code</span>
                      </>
                    )}
                  </button>
                </div>
                <textarea
                  readOnly
                  rows={8}
                  value={sharePayload}
                  className="w-full p-3 font-mono text-xs bg-slate-950 border border-slate-800 rounded-xl text-cyan-300 focus:outline-none select-all"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={handleCopyShareJson}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white transition flex items-center justify-center gap-1.5 border border-slate-700"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{shareCopied ? 'Copied to Clipboard!' : 'Copy Recipe Snippet'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleOpenGithubIssue}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Github className="w-3.5 h-3.5" />
                  <span>Submit to GitHub Catalog</span>
                  <ExternalLink className="w-3 h-3 opacity-70" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
