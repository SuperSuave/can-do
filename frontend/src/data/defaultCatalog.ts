import { Catalog, Command } from '../types/catalog';

export function normalizeCommand(cmd: Command): Command {
  const name = cmd.name || cmd.ha_metadata?.name || cmd.id || 'Unnamed Command';
  const state_can_id = cmd.state_can_id || cmd.network?.state_can_id;
  const action_can_id = cmd.action_can_id || cmd.network?.action_can_id;
  const ha_domain = cmd.ha_domain || cmd.ha_metadata?.domain;
  const icon = cmd.icon || cmd.ha_metadata?.icon || 'mdi:car-info';

  return {
    ...cmd,
    name,
    state_can_id,
    action_can_id,
    ha_domain,
    icon,
    mdi: cmd.mdi || icon,
    ha_metadata: {
      ...cmd.ha_metadata,
      name: cmd.ha_metadata?.name || name,
      domain: cmd.ha_metadata?.domain || ha_domain,
      icon: cmd.ha_metadata?.icon || icon,
    },
    network: {
      ...cmd.network,
      state_can_id: cmd.network?.state_can_id || state_can_id,
      action_can_id: cmd.network?.action_can_id || action_can_id,
    }
  };
}

export function normalizeCatalog(cat: Catalog): Catalog {
  if (!cat || !cat.commands) return cat;
  return {
    ...cat,
    commands: cat.commands.map(normalizeCommand)
  };
}

export const DEFAULT_CATALOG: Catalog = {
  can_do_version: '2026.9.13',
  vehicles: [],
  commands: [],
};
