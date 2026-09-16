import { Command, Catalog, GitHubRepoConfig, Vehicle } from '../types/catalog';
import { validateCommand } from './canValidator';

export const DEFAULT_REPO_CONFIG: GitHubRepoConfig = {
  owner: 'SuperSuave',
  repo: 'can-do-message-catalog',
  branch: 'main',
  filePath: 'catalog/can_do_catalog.json'
};

export function getSavedRepoConfig(): GitHubRepoConfig {
  try {
    const saved = localStorage.getItem('can_do_repo_config');
    if (saved) {
      return { ...DEFAULT_REPO_CONFIG, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Failed to parse repo config', e);
  }
  return DEFAULT_REPO_CONFIG;
}

export function saveRepoConfig(config: GitHubRepoConfig): void {
  try {
    localStorage.setItem('can_do_repo_config', JSON.stringify(config));
  } catch (e) {
    console.error('Failed to save repo config', e);
  }
}

export interface ContributionSummary {
  added: Command[];
  modified: Command[];
  addedVehicles?: Vehicle[];
  modifiedVehicles?: Vehicle[];
  notes?: string;
  contributorName?: string;
}

export function generateIssueMarkdown(
  contribution: ContributionSummary,
  catalog: Catalog,
  config: GitHubRepoConfig
): { title: string; body: string; url: string } {
  const allCommands = [...(contribution.added || []), ...(contribution.modified || [])];
  const allVehicles = [...(contribution.addedVehicles || []), ...(contribution.modifiedVehicles || [])];
  const cmdCount = allCommands.length;
  const vehCount = allVehicles.length;

  let title = '';
  if (cmdCount > 0 && vehCount > 0) {
    title = `[Catalog Contribution] Update ${cmdCount} CAN command(s) and ${vehCount} vehicle trim(s)`;
  } else if (vehCount > 0) {
    const firstVeh = allVehicles[0];
    title = vehCount === 1
      ? `[Vehicle Update] ${firstVeh.make} ${firstVeh.model} (${firstVeh.trim})`
      : `[Vehicle Update] Add/Update ${vehCount} vehicle trims (${firstVeh.model} + ${vehCount - 1} more)`;
  } else {
    const primaryName = allCommands[0]?.name || 'CAN Commands';
    title = cmdCount === 1
      ? `[Catalog Contribution] ${primaryName} (${allCommands[0]?.id})`
      : `[Catalog Contribution] Add/Update ${cmdCount} CAN commands (${primaryName} + ${cmdCount - 1} more)`;
  }

  let markdown = `## 🚗 CAN Do Message Catalog Contribution\n\n`;
  if (contribution.contributorName) {
    markdown += `**Contributor:** ${contribution.contributorName}\n`;
  }
  markdown += `**Target Repository:** \`${config.owner}/${config.repo}\` (\`${config.filePath}\`)\n`;
  markdown += `**Catalog Version:** \`${catalog.catalog_version}\`\n\n`;

  if (contribution.notes) {
    markdown += `### 📝 Description & Research Notes\n${contribution.notes}\n\n`;
  }

  markdown += `### 🔍 Change Summary\n`;

  // Vehicle additions & modifications
  if (contribution.addedVehicles && contribution.addedVehicles.length > 0) {
    markdown += `#### 🚙 New Vehicle Platforms / Trims (${contribution.addedVehicles.length})\n`;
    contribution.addedVehicles.forEach(v => {
      markdown += `- **${v.make} ${v.model}** \`${v.trim}\` (\`${v.id}\`) — Region: \`${v.region}\` | Family: \`${v.family}\`\n`;
      markdown += `  - Features (${v.features.length}): \`${v.features.join(', ') || 'none'}\`\n`;
    });
    markdown += `\n`;
  }

  if (contribution.modifiedVehicles && contribution.modifiedVehicles.length > 0) {
    markdown += `#### 🛠️ Modified Vehicle Platforms / Trims (${contribution.modifiedVehicles.length})\n`;
    contribution.modifiedVehicles.forEach(v => {
      markdown += `- **${v.make} ${v.model}** \`${v.trim}\` (\`${v.id}\`) — Region: \`${v.region}\` | Family: \`${v.family}\`\n`;
      markdown += `  - Features (${v.features.length}): \`${v.features.join(', ') || 'none'}\`\n`;
    });
    markdown += `\n`;
  }

  if (contribution.added.length > 0) {
    markdown += `#### ➕ New Commands (${contribution.added.length})\n`;
    contribution.added.forEach(cmd => {
      const canInfo = cmd.state_can_id ? `CAN: \`${cmd.state_can_id}\` (Bus ${cmd.bus ?? 0})` : 'Virtual / Logic';
      const authorInfo = cmd.contributor?.github
        ? ` | Author: @${cmd.contributor.github.replace(/^@/, '')}`
        : cmd.contributor?.name
        ? ` | Author: ${cmd.contributor.name}`
        : '';
      markdown += `- **${cmd.name}** (\`${cmd.id}\`) — ${canInfo} | Roles: \`${cmd.roles.join(', ')}\` | Category: *${cmd.category}*${authorInfo}\n`;
    });
    markdown += `\n`;
  }

  if (contribution.modified.length > 0) {
    markdown += `#### ✏️ Modified Commands (${contribution.modified.length})\n`;
    contribution.modified.forEach(cmd => {
      const canInfo = cmd.state_can_id ? `CAN: \`${cmd.state_can_id}\` (Bus ${cmd.bus ?? 0})` : 'Virtual / Logic';
      const authorInfo = cmd.contributor?.github
        ? ` | Author: @${cmd.contributor.github.replace(/^@/, '')}`
        : cmd.contributor?.name
        ? ` | Author: ${cmd.contributor.name}`
        : '';
      markdown += `- **${cmd.name}** (\`${cmd.id}\`) — ${canInfo} | Category: *${cmd.category}*${authorInfo}\n`;
    });
    markdown += `\n`;
  }

  // Pre-computed validation summary
  const allIssues = allCommands.flatMap(cmd => validateCommand(cmd, catalog, false));
  const errors = allIssues.filter(i => i.type === 'error');
  const warnings = allIssues.filter(i => i.type === 'warning');

  markdown += `### 🛡️ Automated Validation Status\n`;
  if (errors.length === 0) {
    markdown += `✅ **All validation checks passed!** (No format or syntax errors detected)\n`;
  } else {
    markdown += `⚠️ **Validation Errors (${errors.length}):**\n`;
    errors.forEach(err => {
      markdown += `- [ ] \`${err.commandId || 'unknown'}\`: ${err.message}\n`;
    });
  }

  if (warnings.length > 0) {
    markdown += `ℹ️ **Validation Warnings (${warnings.length}):**\n`;
    warnings.forEach(w => {
      markdown += `- \`${w.commandId || 'unknown'}\`: ${w.message}\n`;
    });
  }
  markdown += `\n`;

  // Merge JSON Snippets
  if (allVehicles.length > 0) {
    markdown += `### 🚙 Updated Vehicles JSON Snippet\n`;
    markdown += `\`\`\`json\n`;
    markdown += JSON.stringify(allVehicles, null, 2);
    markdown += `\n\`\`\`\n\n`;
  }

  if (allCommands.length > 0) {
    markdown += `### 📦 Updated Commands JSON Snippet\n`;
    markdown += `\`\`\`json\n`;
    markdown += JSON.stringify(allCommands, null, 2);
    markdown += `\n\`\`\`\n\n`;
  }

  markdown += `---\n*Generated by CAN Do Catalog Hub Web Interface*`;

  const url = `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(markdown)}`;

  return { title, body: markdown, url };
}

export function getGitHubWebEditUrl(config: GitHubRepoConfig): string {
  return `https://github.com/${config.owner}/${config.repo}/edit/${config.branch}/${config.filePath}`;
}
