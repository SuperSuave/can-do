import React, { useState, useEffect } from 'react';
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
import { Catalog, Command, GitHubRepoConfig, Vehicle } from '../types/catalog';
import {
  generateIssueMarkdown,
  getGitHubWebEditUrl,
  ContributionSummary
} from '../utils/githubHelper';
import { formatCommandForCatalog } from '../utils/catalogUtils';
import { CanDoLogo } from './CanDoLogo';
import {
  X,
  ExternalLink,
  Copy,
  Check,
  Download,
  Github,
  Settings,
  FileCheck,
  Send,
  GitPullRequest
} from 'lucide-react';

interface ContributeModalProps {
  isOpen: boolean;
  onClose: () => void;
  catalog: Catalog;
  pendingAdded: Command[];
  pendingModified: Command[];
  pendingAddedVehicles?: Vehicle[];
  pendingModifiedVehicles?: Vehicle[];
  repoConfig: GitHubRepoConfig;
  onUpdateRepoConfig: (config: GitHubRepoConfig) => void;
  onClearDrafts: () => void;
}

export const ContributeModal: React.FC<ContributeModalProps> = ({
  isOpen,
  onClose,
  catalog,
  pendingAdded,
  pendingModified,
  pendingAddedVehicles = [],
  pendingModifiedVehicles = [],
  repoConfig,
  onUpdateRepoConfig,
  onClearDrafts
}) => {
  const [activeTab, setActiveTab] = useState<'issue' | 'webedit' | 'download'>('issue');
  const [contributorName, setContributorName] = useState('');
  const [testingNotes, setTestingNotes] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [configState, setConfigState] = useState<GitHubRepoConfig>(repoConfig);
  const [copied, setCopied] = useState(false);
  const [copiedCatalog, setCopiedCatalog] = useState(false);
  const [confirmResetDrafts, setConfirmResetDrafts] = useState(false);

  useEffect(() => {
    if (!contributorName) {
      try {
        const saved = localStorage.getItem('can_do_last_contributor');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.github) setContributorName(`@${parsed.github}`);
          else if (parsed.name) setContributorName(parsed.name);
        }
      } catch {}
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const totalChanges =
    pendingAdded.length +
    pendingModified.length +
    pendingAddedVehicles.length +
    pendingModifiedVehicles.length;

  const contribution: ContributionSummary = {
    added: pendingAdded,
    modified: pendingModified,
    addedVehicles: pendingAddedVehicles,
    modifiedVehicles: pendingModifiedVehicles,
    notes: testingNotes,
    contributorName
  };

  const { title: issueTitle, body: issueMarkdown, url: issueUrl } = generateIssueMarkdown(
    contribution,
    catalog,
    configState
  );

  const handleCopyIssueBody = () => {
    navigator.clipboard.writeText(issueMarkdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getCleanCatalog = () => ({
    ...catalog,
    commands: catalog.commands.map(formatCommandForCatalog)
  });

  const handleCopyFullCatalog = () => {
    navigator.clipboard.writeText(JSON.stringify(getCleanCatalog(), null, 2));
    setCopiedCatalog(true);
    setTimeout(() => setCopiedCatalog(false), 2000);
  };

  const handleDownloadCatalog = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(getCleanCatalog(), null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', 'catalog.json');
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleSaveConfig = () => {
    onUpdateRepoConfig(configState);
    setShowConfig(false);
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <ModalBackdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
        <ModalContainer placement="center" scroll="inside" className="p-4 sm:p-6">
          <ModalDialog className="relative w-full max-w-3xl rounded-[16px] border border-border bg-overlay text-overlay-foreground shadow-overlay overflow-hidden my-auto p-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <ModalHeader className="p-5 border-b border-separator bg-surface-secondary">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pr-12">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="h-7 px-1.5 py-0.5 rounded-[8px] bg-surface-tertiary border border-border flex items-center justify-center shrink-0">
                      <CanDoLogo className="h-4.5 w-auto" />
                    </div>
                    <ModalHeading className="text-lg md:text-xl font-bold text-foreground">
                      Contribute to CAN Do Message Catalog
                    </ModalHeading>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    Submit your proposed CAN messages to <code className="text-accent">{configState.owner}/{configState.repo}</code> on GitHub.
                  </p>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => setShowConfig(!showConfig)}
                  className="dash-outline-btn px-2.5 py-1 text-xs font-semibold flex items-center gap-1 shrink-0"
                  aria-label="Configure Target GitHub Repository"
                >
                  <Settings className="w-4 h-4" />
                  <span>Repo Settings</span>
                </Button>
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

        {/* Repository Settings Panel */}
        {showConfig && (
          <div className="p-4 bg-surface-secondary border-b border-separator text-xs space-y-3">
            <div className="font-semibold text-foreground">Target GitHub Repository Configuration:</div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-muted mb-1">Owner / Org</label>
                <input
                  type="text"
                  value={configState.owner}
                  onChange={e => setConfigState({ ...configState, owner: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-foreground font-mono focus:outline-none focus:border-focus"
                />
              </div>
              <div>
                <label className="block text-muted mb-1">Repository Name</label>
                <input
                  type="text"
                  value={configState.repo}
                  onChange={e => setConfigState({ ...configState, repo: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-foreground font-mono focus:outline-none focus:border-focus"
                />
              </div>
              <div>
                <label className="block text-muted mb-1">Target Branch</label>
                <input
                  type="text"
                  value={configState.branch}
                  onChange={e => setConfigState({ ...configState, branch: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-foreground font-mono focus:outline-none focus:border-focus"
                />
              </div>
              <div>
                <label className="block text-muted mb-1">Catalog File Path</label>
                <input
                  type="text"
                  value={configState.filePath}
                  onChange={e => setConfigState({ ...configState, filePath: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-surface-tertiary border border-border text-foreground font-mono focus:outline-none focus:border-focus"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onPress={() => setShowConfig(false)}
                className="dash-outline-btn px-3 py-1 text-xs"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={handleSaveConfig}
                className="px-4 py-1.5 rounded-full bg-accent text-accent-foreground font-semibold hover:opacity-90 transition"
              >
                Save Repo Settings
              </Button>
            </div>
          </div>
        )}

        {/* Change stats banner */}
        <div className="p-3.5 bg-surface border-b border-separator flex items-center justify-between text-xs px-6">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="font-semibold text-foreground">Pending Changes:</span>
            {pendingAdded.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-success/15 text-success border border-success/30 font-mono text-[11px]">
                +{pendingAdded.length} Commands
              </span>
            )}
            {pendingModified.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/30 font-mono text-[11px]">
                ~{pendingModified.length} Commands
              </span>
            )}
            {pendingAddedVehicles.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 font-mono text-[11px]">
                +{pendingAddedVehicles.length} Vehicles
              </span>
            )}
            {pendingModifiedVehicles.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30 font-mono text-[11px]">
                ~{pendingModifiedVehicles.length} Vehicles
              </span>
            )}
            {totalChanges === 0 && (
              <span className="text-muted italic">
                (No uncommitted draft changes. Full catalog will be shared.)
              </span>
            )}
          </div>

          {totalChanges > 0 && (
            confirmResetDrafts ? (
              <div className="flex items-center gap-1.5 bg-danger/15 border border-danger/40 px-2 py-0.5 rounded text-xs">
                <span className="text-[10px] text-danger font-semibold">Clear marks?</span>
                <Button
                  variant="danger"
                  size="sm"
                  onPress={() => {
                    onClearDrafts();
                    setConfirmResetDrafts(false);
                  }}
                  className="px-1.5 py-0.5 bg-danger hover:opacity-90 text-danger-foreground rounded font-bold text-[10px] h-auto transition"
                >
                  Yes
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => setConfirmResetDrafts(false)}
                  className="px-1.5 py-0.5 bg-surface-tertiary hover:bg-default-hover text-foreground rounded text-[10px] h-auto transition"
                >
                  No
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onPress={() => setConfirmResetDrafts(true)}
                className="text-[11px] text-muted hover:text-danger transition h-auto p-0"
              >
                Reset Draft Marks
              </Button>
            )
          )}
        </div>

        {/* Tab Selection */}
        <div className="px-6 border-b border-separator bg-surface-secondary text-xs">
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={key => setActiveTab(key as 'issue' | 'webedit' | 'download')}
            aria-label="Contribute Options"
          >
            <Tabs.ListContainer className="overflow-x-auto no-scrollbar">
              <Tabs.List className="gap-2">
                <Tabs.Tab
                  id="issue"
                  className={`relative py-3 px-3 font-semibold transition cursor-pointer flex items-center ${
                    activeTab === 'issue'
                      ? 'text-foreground'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>1. One-Click GitHub Issue (Recommended)</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="webedit"
                  className={`relative py-3 px-3 font-semibold transition cursor-pointer flex items-center ${
                    activeTab === 'webedit'
                      ? 'text-foreground'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>2. Web Editor / PR Fork</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="download"
                  className={`relative py-3 px-3 font-semibold transition cursor-pointer flex items-center ${
                    activeTab === 'download'
                      ? 'text-foreground'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>3. Download / Export JSON</span>
                  <Tabs.Indicator className="h-0.5 bg-accent bottom-0 rounded-full" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>

        {/* Tab 1: One Click GitHub Issue */}
        <ModalBody className="p-6 max-h-[64vh] overflow-y-auto space-y-4">
          {activeTab === 'issue' && (
            <div className="space-y-4 text-xs">
              <div className="p-3.5 rounded-[12px] bg-surface-secondary border border-border text-muted space-y-1">
                <div className="font-semibold text-accent flex items-center gap-1.5">
                  <FileCheck className="w-4 h-4" />
                  Easiest method for community contributors
                </div>
                <div>
                  No Git knowledge or write permissions required. Clicking below opens a pre-formatted
                  issue on GitHub with your validated CAN frames, byte descriptions, and raw JSON snippet ready for maintainers to merge!
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-muted mb-1 font-medium">
                    Contributor Name or GitHub Handle (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="@your-username"
                    value={contributorName}
                    onChange={e => setContributorName(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] bg-surface-tertiary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                  />
                </div>
                <div>
                  <label className="block text-muted mb-1 font-medium">
                    Testing Notes or Vehicle Tested (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Tested on 2023 Ioniq 5 Limited (Gen5W)"
                    value={testingNotes}
                    onChange={e => setTestingNotes(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] bg-surface-tertiary border border-border text-foreground placeholder:text-field-placeholder focus:outline-none focus:border-focus"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="font-medium text-muted">
                    Generated Issue Body Preview
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={handleCopyIssueBody}
                    className="text-accent hover:underline flex items-center gap-1 h-auto p-1"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy Markdown'}
                  </Button>
                </div>
                <textarea
                  readOnly
                  rows={8}
                  value={issueMarkdown}
                  className="w-full p-3 rounded-[8px] bg-surface-tertiary border border-border font-mono text-[11px] text-foreground focus:outline-none focus:border-focus"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <a
                  href={issueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-accent hover:opacity-90 text-accent-foreground font-semibold text-sm shadow transition"
                >
                  <Send className="w-4 h-4" />
                  Open Pre-Filled Issue on GitHub
                  <ExternalLink className="w-3.5 h-3.5 opacity-70" />
                </a>
              </div>
            </div>
          )}

          {/* Tab 2: Web Editor / PR Fork */}
          {activeTab === 'webedit' && (
            <div className="space-y-4 text-xs text-muted">
              <div className="p-3.5 rounded-[12px] bg-surface-secondary border border-border space-y-2">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  <GitPullRequest className="w-4 h-4 text-accent" />
                  Edit directly on GitHub Web Editor
                </div>
                <ol className="list-decimal pl-5 space-y-1.5 text-muted">
                  <li>
                    Click <strong className="text-foreground">"Copy Full Updated Catalog JSON"</strong> below.
                  </li>
                  <li>
                    Click <strong className="text-foreground">"Open catalog.json in GitHub Web Editor"</strong>.
                  </li>
                  <li>
                    Paste into the GitHub editor (Ctrl+A / Cmd+A then Ctrl+V / Cmd+V) and click <strong className="text-accent">"Propose changes"</strong> to open a Pull Request!
                  </li>
                </ol>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                <Button
                  variant="primary"
                  size="sm"
                  onPress={handleCopyFullCatalog}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-accent hover:opacity-90 text-accent-foreground font-semibold transition"
                >
                  {copiedCatalog ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copiedCatalog ? 'Catalog JSON Copied!' : '1. Copy Full Catalog JSON'}
                </Button>

                <a
                  href={getGitHubWebEditUrl(configState)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto dash-outline-btn inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold"
                >
                  2. Open in GitHub Editor
                  <ExternalLink className="w-3.5 h-3.5 text-muted" />
                </a>
              </div>
            </div>
          )}

          {/* Tab 3: Download catalog.json & Patch */}
          {activeTab === 'download' && (
            <div className="space-y-4 text-xs text-muted">
              <div className="p-4 rounded-[12px] bg-surface-secondary border border-border space-y-2">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  <Download className="w-4 h-4 text-accent" />
                  Save File Locally
                </div>
                <p className="text-muted">
                  Download the complete validated <code className="text-accent">catalog.json</code> containing all {catalog.vehicles.length} vehicles and {catalog.commands.length} commands, or copy your changes.
                  You can deploy this directly into your local CAN Do automation platform directory, submit it to GitHub, or share it with the community.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  variant="primary"
                  size="sm"
                  onPress={handleDownloadCatalog}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-accent hover:opacity-90 text-accent-foreground font-semibold transition"
                >
                  <Download className="w-4 h-4" />
                  Download catalog.json
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleCopyFullCatalog}
                  className="dash-outline-btn inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-xs font-semibold"
                >
                  {copiedCatalog ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                  {copiedCatalog ? 'Copied to Clipboard' : 'Copy JSON'}
                </Button>
              </div>
            </div>
          )}
        </ModalBody>

        {/* Modal Footer */}
        <ModalFooter className="flex items-center justify-between p-4 px-6 border-t border-separator bg-surface-secondary shrink-0">
          <span className="text-[11px] text-muted font-mono">
            CAN Do Version: {catalog.can_do_version || 'unknown'} • {catalog.commands.length} Commands
          </span>
          <Button
            variant="outline"
            size="sm"
            onPress={onClose}
            className="dash-outline-btn px-4 py-1.5 text-xs font-semibold"
          >
            Close
          </Button>
        </ModalFooter>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
  );
};
