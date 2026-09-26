import React, { useState, useEffect } from 'react';
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
  GitPullRequest,
  ExternalLink,
  Copy,
  Check,
  Download,
  Github,
  Settings,
  AlertCircle,
  FileCheck,
  Send
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
  const [activeTab, setActiveTab] = useState<'issue' | 'webedit' | 'download' | 'direct_pr'>('issue');
  const [contributorName, setContributorName] = useState('');
  const [testingNotes, setTestingNotes] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [configState, setConfigState] = useState<GitHubRepoConfig>(repoConfig);
  const [copied, setCopied] = useState(false);
  const [copiedCatalog, setCopiedCatalog] = useState(false);

  // Direct PR state
  const [githubToken, setGithubToken] = useState('');
  const [prLoading, setPrLoading] = useState(false);
  const [prResult, setPrResult] = useState<{ success: boolean; url?: string; error?: string } | null>(null);
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

  // Direct GitHub PR execution via GitHub REST API
  const handleDirectPR = async () => {
    if (!githubToken.trim()) {
      setPrResult({ success: false, error: 'Please enter a GitHub Personal Access Token.' });
      return;
    }

    setPrLoading(true);
    setPrResult(null);

    try {
      const { owner, repo, branch, filePath } = configState;
      const headers = {
        Authorization: `token ${githubToken.trim()}`,
        Accept: 'application/vnd.github.v3+json'
      };

      // 1. Get branch ref SHA
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, {
        headers
      });
      if (!refRes.ok) {
        throw new Error(`Failed to fetch base branch (${branch}). Check repo permissions or token.`);
      }
      const refData = await refRes.json();
      const baseSha = refData.object.sha;

      // 2. Create new branch
      const newBranchName = `contrib-can-${Date.now().toString(36)}`;
      const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${newBranchName}`,
          sha: baseSha
        })
      });
      if (!branchRes.ok) {
        throw new Error('Failed to create contribution branch.');
      }

      // 3. Get current file SHA (to update it)
      let currentFileSha: string | undefined;
      const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, {
        headers
      });
      if (fileRes.ok) {
        const fileData = await fileRes.json();
        currentFileSha = fileData.sha;
      }

      // 4. Commit updated catalog.json
      const contentBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(getCleanCatalog(), null, 2))));
      const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: issueTitle,
          content: contentBase64,
          branch: newBranchName,
          ...(currentFileSha ? { sha: currentFileSha } : {})
        })
      });
      if (!commitRes.ok) {
        throw new Error('Failed to commit updated catalog to branch.');
      }

      // 5. Create Pull Request
      const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: issueTitle,
          body: issueMarkdown,
          head: newBranchName,
          base: branch
        })
      });
      if (!prRes.ok) {
        const prErr = await prRes.json();
        throw new Error(prErr.message || 'Failed to open Pull Request.');
      }
      const prData = await prRes.json();

      setPrResult({ success: true, url: prData.html_url });
    } catch (err: any) {
      setPrResult({ success: false, error: err.message || 'Error occurred while creating PR.' });
    } finally {
      setPrLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-3xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-7 px-1.5 py-0.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] flex items-center justify-center">
                <CanDoLogo className="h-4.5 w-auto" />
              </div>
              <h2 className="text-lg md:text-xl font-bold text-white">
                Contribute to CAN Do Message Catalog
              </h2>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Submit your proposed CAN messages to <code className="text-cyan-300">{configState.owner}/{configState.repo}</code> on GitHub.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="dash-outline-btn px-2.5 py-1 text-xs font-semibold flex items-center gap-1"
              title="Configure Target GitHub Repository"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Repo Settings</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Repository Settings Panel */}
        {showConfig && (
          <div className="p-4 bg-[var(--md-sys-color-surface-container-low)] border-b border-[var(--border-color)] text-xs space-y-3">
            <div className="font-semibold text-slate-200">Target GitHub Repository Configuration:</div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Owner / Org</label>
                <input
                  type="text"
                  value={configState.owner}
                  onChange={e => setConfigState({ ...configState, owner: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Repository Name</label>
                <input
                  type="text"
                  value={configState.repo}
                  onChange={e => setConfigState({ ...configState, repo: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Target Branch</label>
                <input
                  type="text"
                  value={configState.branch}
                  onChange={e => setConfigState({ ...configState, branch: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Catalog File Path</label>
                <input
                  type="text"
                  value={configState.filePath}
                  onChange={e => setConfigState({ ...configState, filePath: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowConfig(false)}
                className="dash-outline-btn px-3 py-1 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveConfig}
                className="px-4 py-1.5 rounded-full bg-[var(--md-sys-color-primary)] text-white font-semibold hover:opacity-90 transition"
              >
                Save Repo Settings
              </button>
            </div>
          </div>
        )}

        {/* Change stats banner */}
        <div className="p-3.5 bg-[var(--card-bg)] border-b border-[var(--border-color)] flex items-center justify-between text-xs px-6">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="font-semibold text-slate-200">Pending Changes:</span>
            {pendingAdded.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 font-mono text-[11px]">
                +{pendingAdded.length} Commands
              </span>
            )}
            {pendingModified.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-950 text-amber-300 border border-amber-800 font-mono text-[11px]">
                ~{pendingModified.length} Commands
              </span>
            )}
            {pendingAddedVehicles.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 font-mono text-[11px]">
                +{pendingAddedVehicles.length} Vehicles
              </span>
            )}
            {pendingModifiedVehicles.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono text-[11px]">
                ~{pendingModifiedVehicles.length} Vehicles
              </span>
            )}
            {totalChanges === 0 && (
              <span className="text-[var(--text-muted)] italic">
                (No uncommitted draft changes. Full catalog will be shared.)
              </span>
            )}
          </div>

          {totalChanges > 0 && (
            confirmResetDrafts ? (
              <div className="flex items-center gap-1.5 bg-rose-950/90 border border-rose-700/80 px-2 py-0.5 rounded text-xs">
                <span className="text-[10px] text-rose-200 font-semibold">Clear marks?</span>
                <button
                  type="button"
                  onClick={() => {
                    onClearDrafts();
                    setConfirmResetDrafts(false);
                  }}
                  className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-[10px] transition"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmResetDrafts(false)}
                  className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmResetDrafts(true)}
                className="text-[11px] text-slate-500 hover:text-rose-400 transition"
              >
                Reset Draft Marks
              </button>
            )
          )}
        </div>

        {/* Tab Selection */}
        <div className="flex items-center gap-2 px-6 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] text-xs">
          <button
            onClick={() => setActiveTab('issue')}
            className={`py-3 px-3 font-semibold border-b-2 transition ${
              activeTab === 'issue'
                ? 'border-[var(--md-sys-color-primary)] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            1. One-Click GitHub Issue (Recommended)
          </button>
          <button
            onClick={() => setActiveTab('webedit')}
            className={`py-3 px-3 font-semibold border-b-2 transition ${
              activeTab === 'webedit'
                ? 'border-[var(--md-sys-color-primary)] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            2. Web Editor / PR Fork
          </button>
          <button
            onClick={() => setActiveTab('download')}
            className={`py-3 px-3 font-semibold border-b-2 transition ${
              activeTab === 'download'
                ? 'border-[var(--md-sys-color-primary)] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            3. Download catalog.json
          </button>
          <button
            onClick={() => setActiveTab('direct_pr')}
            className={`py-3 px-3 font-semibold border-b-2 transition ${
              activeTab === 'direct_pr'
                ? 'border-[var(--md-sys-color-primary)] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            4. Direct GitHub PR (Token)
          </button>
        </div>

        {/* Tab 1: One Click GitHub Issue */}
        <div className="p-6 max-h-[64vh] overflow-y-auto space-y-4">
          {activeTab === 'issue' && (
            <div className="space-y-4 text-xs">
              <div className="p-3.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] text-slate-300 space-y-1">
                <div className="font-semibold text-cyan-300 flex items-center gap-1.5">
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
                  <label className="block text-slate-400 mb-1 font-medium">
                    Contributor Name or GitHub Handle (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="@your-username"
                    value={contributorName}
                    onChange={e => setContributorName(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">
                    Testing Notes or Vehicle Tested (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Tested on 2023 Ioniq 5 Limited (Gen5W)"
                    value={testingNotes}
                    onChange={e => setTestingNotes(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="font-medium text-slate-400">
                    Generated Issue Body Preview
                  </label>
                  <button
                    type="button"
                    onClick={handleCopyIssueBody}
                    className="text-cyan-400 hover:underline flex items-center gap-1"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy Markdown'}
                  </button>
                </div>
                <textarea
                  readOnly
                  rows={8}
                  value={issueMarkdown}
                  className="w-full p-3 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-[11px] text-slate-300 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <a
                  href={issueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold text-sm shadow transition"
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
            <div className="space-y-4 text-xs text-slate-300">
              <div className="p-3.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-2">
                <div className="font-semibold text-white flex items-center gap-1.5">
                  <GitPullRequest className="w-4 h-4 text-cyan-400" />
                  Edit directly on GitHub Web Editor
                </div>
                <ol className="list-decimal pl-5 space-y-1.5 text-slate-400">
                  <li>
                    Click <strong className="text-white">"Copy Full Updated Catalog JSON"</strong> below.
                  </li>
                  <li>
                    Click <strong className="text-white">"Open catalog.json in GitHub Web Editor"</strong>.
                  </li>
                  <li>
                    Paste into the GitHub editor (Ctrl+A / Cmd+A then Ctrl+V / Cmd+V) and click <strong className="text-cyan-400">"Propose changes"</strong> to open a Pull Request!
                  </li>
                </ol>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCopyFullCatalog}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold transition"
                >
                  {copiedCatalog ? <Check className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4" />}
                  {copiedCatalog ? 'Catalog JSON Copied!' : '1. Copy Full Catalog JSON'}
                </button>

                <a
                  href={getGitHubWebEditUrl(configState)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto dash-outline-btn inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold"
                >
                  2. Open in GitHub Editor
                  <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
                </a>
              </div>
            </div>
          )}

          {/* Tab 3: Download catalog.json */}
          {activeTab === 'download' && (
            <div className="space-y-4 text-xs text-slate-300">
              <div className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-2">
                <div className="font-semibold text-white flex items-center gap-1.5">
                  <Download className="w-4 h-4 text-cyan-400" />
                  Save File Locally
                </div>
                <p className="text-[var(--text-muted)]">
                  Download the complete validated <code className="text-cyan-300">catalog.json</code> containing all {catalog.vehicles.length} vehicles and {catalog.commands.length} commands.
                  You can deploy this directly into your local CAN Do automation platform directory or commit it via git.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleDownloadCatalog}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold transition"
                >
                  <Download className="w-4 h-4" />
                  Download catalog.json
                </button>
              </div>
            </div>
          )}

          {/* Tab 4: Direct PR */}
          {activeTab === 'direct_pr' && (
            <div className="space-y-4 text-xs text-slate-300">
              <div className="p-3.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-1">
                <div className="font-semibold text-white">Automated GitHub Pull Request</div>
                <p className="text-[var(--text-muted)]">
                  Provide a personal access token (with <code className="text-cyan-300">repo</code> scope) to create a branch, commit the catalog, and open a Pull Request automatically. The token is never stored on any server.
                </p>
              </div>

              <div>
                <label className="block text-slate-400 mb-1 font-medium">
                  GitHub Personal Access Token (PAT)
                </label>
                <input
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  value={githubToken}
                  onChange={e => setGithubToken(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-cyan-300 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
              </div>

              {prResult && (
                <div
                  className={`p-3 rounded-[10px] border flex items-center gap-2 ${
                    prResult.success
                      ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                      : 'bg-rose-950/40 border-rose-800 text-rose-300'
                  }`}
                >
                  {prResult.success ? (
                    <>
                      <Check className="w-4 h-4 shrink-0" />
                      <span>
                        Pull Request created successfully!{' '}
                        <a
                          href={prResult.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline font-bold text-white ml-1"
                        >
                          View PR on GitHub
                        </a>
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{prResult.error}</span>
                    </>
                  )}
                </div>
              )}

              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  disabled={prLoading || !githubToken}
                  onClick={handleDirectPR}
                  className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full font-semibold transition ${
                    githubToken && !prLoading
                      ? 'bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white'
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  <GitPullRequest className="w-4 h-4" />
                  {prLoading ? 'Creating Branch & PR...' : 'Create Pull Request'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between p-4 px-6 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <span className="text-[11px] text-[var(--text-muted)] font-mono">
            CAN Do Version: {catalog.can_do_version || 'unknown'} • {catalog.commands.length} Commands
          </span>
          <button
            type="button"
            onClick={onClose}
            className="dash-outline-btn px-4 py-1.5 text-xs font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
