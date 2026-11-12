import React, { useState, useMemo } from 'react';
import {
  Tabs,
  Button,
  Chip,
  Badge,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  SearchField
} from '@heroui/react';
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
  initialTab?: 'browse' | 'share';
  onInstallRule: (rule: AutomationRule) => void;
  onClose: () => void;
}

export const CommunityAutomationsModal: React.FC<CommunityAutomationsModalProps> = ({
  catalog,
  currentRules,
  activeRule,
  initialTab = 'browse',
  onInstallRule,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<'browse' | 'share'>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [installedIdSet, setInstalledIdSet] = useState<Set<string>>(
    () => new Set(currentRules.map(r => r.id))
  );
  const [recentlyInstalledId, setRecentlyInstalledId] = useState<string | null>(null);

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
      ...(ruleToShare.hold_beep ? { hold_beep: true } : {}),
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
    <Modal isOpen={true} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-md">
        <ModalContainer placement="center" scroll="inside" className="p-3 sm:p-4">
          <ModalDialog className="relative w-full max-w-4xl bg-overlay text-overlay-foreground border border-border rounded-2xl shadow-overlay overflow-hidden flex flex-col max-h-[90vh] p-0">
            {/* Header Strip */}
            <ModalHeader className="p-4 sm:p-5 border-b border-separator bg-surface shrink-0">
              <div className="flex items-center gap-3 min-w-0 pr-10">
                <div className="w-10 h-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center border border-accent/30 shrink-0">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <ModalHeading className="text-base sm:text-lg font-bold text-foreground truncate">
                      Community Automations
                    </ModalHeading>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase bg-accent-soft text-accent-soft-foreground border border-accent/30">
                      {communityList.length} Verified
                    </span>
                  </div>
                  <p className="text-xs text-muted truncate">
                    Discover, 1-click install, and share vehicle automations crafted by the CAN Do community.
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

        {/* Tab Navigation */}
        <div className="px-4 sm:px-5 border-b border-separator bg-surface text-xs font-semibold shrink-0">
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={key => setActiveTab(key as 'browse' | 'share')}
            aria-label="Community Automations Navigation"
          >
            <Tabs.ListContainer className="overflow-x-auto no-scrollbar">
              <Tabs.List className="gap-2">
                <Tabs.Tab
                  id="browse"
                  className={`relative py-3 px-3 transition flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'browse'
                      ? 'text-accent'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Browse Library</span>
                  <Badge size="sm" variant="secondary" className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-surface-secondary text-foreground border border-border">
                    {filteredList.length}
                  </Badge>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="share"
                  className={`relative py-3 px-3 transition flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'share'
                      ? 'text-accent'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Share Your Automation</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>

        {/* Tab Content Area */}
        <ModalBody className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {/* TAB 1: BROWSE */}
          {activeTab === 'browse' && (
            <div className="space-y-4">
              {/* Search & Category Filter */}
              <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between">
                <SearchField
                  value={searchQuery}
                  onChange={setSearchQuery}
                  aria-label="Search automations"
                  className="flex-1"
                >
                  <SearchField.Group className="relative w-full flex items-center rounded-xl bg-surface-secondary border border-border focus-within:border-focus focus-within:ring-1 focus-within:ring-focus/40 px-3 py-1.5 text-xs transition">
                    <SearchField.SearchIcon className="w-4 h-4 text-muted mr-2 shrink-0" />
                    <SearchField.Input
                      placeholder="Search automations by button, feature, tag, or author..."
                      className="w-full bg-transparent text-xs text-foreground placeholder:text-field-placeholder focus:outline-none"
                    />
                    {searchQuery && (
                      <SearchField.ClearButton
                        className="text-muted hover:text-foreground shrink-0 p-1 rounded-md hover:bg-default-hover transition cursor-pointer"
                        aria-label="Clear search"
                      />
                    )}
                  </SearchField.Group>
                </SearchField>

                {/* Category Pills */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 text-xs shrink-0">
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('all')}
                    className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                      selectedCategory === 'all'
                        ? 'bg-accent text-accent-foreground font-bold'
                        : 'bg-surface-secondary text-muted hover:text-foreground border border-border'
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
                          ? 'bg-accent text-accent-foreground font-bold'
                          : 'bg-surface-secondary text-muted hover:text-foreground border border-border'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Automation Cards Grid */}
              {filteredList.length === 0 ? (
                <div className="p-8 text-center rounded-2xl bg-surface-secondary border border-dashed border-border space-y-2">
                  <Sparkles className="w-8 h-8 text-muted mx-auto" />
                  <div className="text-sm font-semibold text-foreground">No automations match your search</div>
                  <p className="text-xs text-muted">
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
                            ? 'bg-success-soft border-success/50 shadow-md'
                            : 'bg-surface-secondary hover:bg-surface-tertiary border-border hover:border-border-secondary'
                        }`}
                      >
                        <div className="space-y-2.5">
                          {/* Top Badges */}
                          <div className="flex items-center justify-between gap-2">
                            <Badge size="sm" color="accent" variant="soft" className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-accent-soft text-accent-soft-foreground border border-accent/30">
                              {item.category || 'General'}
                            </Badge>
                            {item.contributor && (
                              <Badge size="sm" variant="secondary" className="flex items-center gap-1 text-[11px] text-muted font-medium bg-surface-tertiary border border-border">
                                <Github className="w-3 h-3 text-muted mr-1" />
                                <span>{item.contributor.name || 'Community'}</span>
                              </Badge>
                            )}
                          </div>

                          {/* Title & Description */}
                          <div>
                            <h3 className="text-sm font-bold text-foreground transition">
                              {item.name}
                            </h3>
                            <p className="text-xs text-muted line-clamp-2 mt-1 leading-relaxed">
                              {item.description}
                            </p>
                          </div>

                          {/* Summary Chips */}
                          <div className="flex flex-wrap items-center gap-2 pt-2.5 text-[11px] font-mono text-muted border-t border-separator">
                            <Chip size="sm" color="warning" variant="soft" className="flex items-center gap-1 bg-warning-soft text-warning-soft-foreground border border-warning/30">
                              <Zap className="w-3 h-3 text-warning mr-1" />
                              {item.triggers.length} {item.triggers.length === 1 ? 'Trigger' : 'Triggers'}
                            </Chip>
                            {item.conditions && item.conditions.length > 0 && (
                              <Chip size="sm" color="accent" variant="soft" className="flex items-center gap-1 bg-accent-soft text-accent-soft-foreground border border-accent/30">
                                <Shield className="w-3 h-3 text-accent mr-1" />
                                {item.conditions.length} {item.conditions.length === 1 ? 'Cond' : 'Conds'}
                              </Chip>
                            )}
                            <Chip size="sm" color="success" variant="soft" className="flex items-center gap-1 bg-success-soft text-success-soft-foreground border border-success/30">
                              <Send className="w-3 h-3 text-success mr-1" />
                              {item.actions.length} {item.actions.length === 1 ? 'Action' : 'Actions'}
                            </Chip>
                          </div>
                        </div>

                        {/* Action Bar */}
                        <div className="pt-3 mt-3 flex items-center justify-between gap-2 border-t border-separator">
                          <Chip size="sm" variant="secondary" className="flex items-center gap-1 text-[10px] text-muted font-mono bg-surface-tertiary border border-border">
                            <Car className="w-3 h-3 mr-1" />
                            <span>{(item.tags || ['all_egmp']).join(', ')}</span>
                          </Chip>

                          <Button
                            variant={isJustInstalled ? 'primary' : isInstalled ? 'secondary' : 'primary'}
                            size="sm"
                            onPress={() => handleInstall(item)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm active:scale-95 ${
                              isJustInstalled
                                ? 'bg-success text-success-foreground font-black'
                                : isInstalled
                                ? 'bg-surface-tertiary text-foreground hover:bg-default-hover border border-border'
                                : 'bg-accent hover:bg-accent-hover text-accent-foreground'
                            }`}
                          >
                            {isJustInstalled ? (
                              <>
                                <Check className="w-3.5 h-3.5 stroke-[3]" />
                                <span>Installed!</span>
                              </>
                            ) : isInstalled ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-success" />
                                <span>Add Another Copy</span>
                              </>
                            ) : (
                              <>
                                <Plus className="w-3.5 h-3.5 stroke-[3]" />
                                <span>1-Click Install</span>
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: SHARE */}
          {activeTab === 'share' && (
            <div className="space-y-4 max-w-2xl mx-auto">
              <div className="p-4 rounded-xl bg-surface-secondary border border-border space-y-2 text-xs">
                <div className="flex items-center gap-2 font-bold text-foreground">
                  <Share2 className="w-4 h-4 text-accent" />
                  <span>Share Your Automation with the Community</span>
                </div>
                <p className="text-muted leading-relaxed">
                  Export your rule formatted for community sharing. You can submit it to the CAN Do GitHub repository to be included in the official catalog for all drivers!
                </p>
              </div>

              {/* Rule Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-muted block">
                  Select Automation to Share
                </label>
                <select
                  value={selectedShareRuleId}
                  onChange={e => setSelectedShareRuleId(e.target.value)}
                  className="w-full p-2.5 bg-surface-secondary border border-border rounded-xl text-xs text-foreground focus:outline-none focus:border-focus"
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
                  <label className="text-[11px] font-semibold text-muted block">
                    Your Name / Handle
                  </label>
                  <input
                    type="text"
                    value={contributorName}
                    onChange={e => setContributorName(e.target.value)}
                    placeholder="e.g. SuperSuave"
                    className="w-full p-2 bg-surface-secondary border border-border rounded-lg text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-muted block">
                    GitHub Username (Optional)
                  </label>
                  <input
                    type="text"
                    value={contributorGithub}
                    onChange={e => setContributorGithub(e.target.value)}
                    placeholder="e.g. SuperSuave"
                    className="w-full p-2 bg-surface-secondary border border-border rounded-lg text-xs text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                  />
                </div>
              </div>

              {/* JSON Preview */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold uppercase tracking-wider text-muted block">
                    Shareable Recipe JSON
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={handleCopyShareJson}
                    className="text-[11px] text-accent hover:opacity-80 font-semibold flex items-center gap-1 h-auto p-1"
                  >
                    {shareCopied ? (
                      <>
                        <Check className="w-3 h-3 text-success" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Code</span>
                      </>
                    )}
                  </Button>
                </div>
                <textarea
                  readOnly
                  rows={8}
                  value={sharePayload}
                  className="w-full p-3 font-mono text-xs bg-surface-secondary border border-border rounded-xl text-accent focus:outline-none select-all"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row items-center justify-end gap-2.5 pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={handleCopyShareJson}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl text-xs font-bold bg-surface-secondary hover:bg-default-hover text-foreground transition flex items-center justify-center gap-1.5 border border-border"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{shareCopied ? 'Copied to Clipboard!' : 'Copy Recipe Snippet'}</span>
                </Button>

                <Button
                  variant="primary"
                  size="sm"
                  onPress={handleOpenGithubIssue}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl text-xs font-bold bg-accent hover:bg-accent-hover text-accent-foreground transition flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Github className="w-3.5 h-3.5" />
                  <span>Submit to GitHub Catalog</span>
                  <ExternalLink className="w-3 h-3 opacity-70" />
                </Button>
              </div>
            </div>
          )}
        </ModalBody>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
