export type CommandRole = 'trigger' | 'condition' | 'action';

export type CommandType =
  | 'can_tx'
  | 'popup'
  | 'precondition'
  | 'webhook'
  | 'mqtt'
  | 'climate_target'
  | 'speed_zero'
  | 'can_state'
  | 'param_range'
  | 'voltage'
  | 'day_of_week'
  | 'time_window'
  | string;

export type ByteMap = Record<string, string>;

export interface CommandNetwork {
  bus?: number;
  type?: string;
  state_can_id?: string;
  action_can_id?: string;
  delay_ms?: number;
  flow_control_can_id?: string;
  trigger_frame_can_id?: string;
  transports?: Record<string, { tx_id: string; flow_control_id: string }>;
}

export interface CommandHaMetadata {
  name?: string;
  domain?: string;
  icon?: string;
}

export interface CommandOption {
  label: string;
  payload?: string | ByteMap;
  match?: ByteMap;
  mask?: string | ByteMap;
  from_payload?: string;
  to_payload?: string;
  match_payload?: string;
  state_can_id?: string;
  action_can_id?: string;
  steps?: CommandStep[];
  popup?: string;
  popup_message?: string;
  popup_message_imperial?: string;
  level?: 'info' | 'warning' | 'error';
  default?: boolean;
  repeat?: number;
  requires_feature?: string;
  state_value?: string | number;
  evaluate?: string | { byte: string; operator: string; value: string | number };
  description?: string;
  [key: string]: any;
}

export interface CommandStep {
  payload: string | ByteMap;
  repeat?: number;
}

export interface ContributorInfo {
  name?: string;
  github?: string;
  notes?: string;
  tested_vehicle?: string;
  role?: string;
}

export function getCommandContributors(item?: { contributor?: ContributorInfo; contributors?: ContributorInfo[] } | null): ContributorInfo[] {
  if (!item) return [];
  if (Array.isArray(item.contributors) && item.contributors.length > 0) {
    return item.contributors.filter(c => Boolean(c && (c.name || c.github || c.notes || c.tested_vehicle || c.role)));
  }
  if (item.contributor && (item.contributor.name || item.contributor.github || item.contributor.notes || item.contributor.tested_vehicle || item.contributor.role)) {
    return [item.contributor];
  }
  return [];
}

export function getCommandNotes(cmd: Command): string | undefined {
  if (cmd.notes && cmd.notes.trim()) return cmd.notes.trim();
  const contribs = getCommandContributors(cmd);
  for (const c of contribs) {
    if (c.notes && c.notes.trim()) return c.notes.trim();
  }
  return undefined;
}

export function getCommandTestedVehicle(cmd: Command): string | undefined {
  if (cmd.tested_vehicle && cmd.tested_vehicle.trim()) return cmd.tested_vehicle.trim();
  const contribs = getCommandContributors(cmd);
  for (const c of contribs) {
    if (c.tested_vehicle && c.tested_vehicle.trim()) return c.tested_vehicle.trim();
  }
  // Also check if notes contains vehicle pattern like "Tested on 2024 Ioniq 5"
  for (const c of contribs) {
    if (c.notes) {
      const match = c.notes.match(/Tested (?:on|with)\s+([^;,.]+)/i);
      if (match && match[1]) return match[1].trim();
    }
  }
  if (cmd.notes) {
    const match = cmd.notes.match(/Tested (?:on|with)\s+([^;,.]+)/i);
    if (match && match[1]) return match[1].trim();
  }
  return undefined;
}

export function getCommandDisplayNotes(cmd: Command): string | undefined {
  const notes = getCommandNotes(cmd);
  if (!notes) return undefined;
  const vehicle = getCommandTestedVehicle(cmd);
  if (vehicle) {
    const lowerNotes = notes.trim().toLowerCase();
    const lowerVeh = vehicle.toLowerCase();
    if (
      lowerNotes === `tested on ${lowerVeh}` ||
      lowerNotes === `tested with ${lowerVeh}` ||
      lowerNotes === `tested on: ${lowerVeh}` ||
      lowerNotes === lowerVeh
    ) {
      return undefined;
    }
  }
  return notes;
}

export interface Command {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  roles: CommandRole[];
  network?: CommandNetwork;
  ha_metadata?: CommandHaMetadata;
  match?: ByteMap;
  mask?: string | ByteMap;
  state_can_id?: string;
  action_can_id?: string;
  bus?: number;
  action_bus?: number;
  from_payload?: string;
  to_payload?: string;
  match_payload?: string;
  tags?: string[];
  requires_feature?: string;
  type?: CommandType;
  delay_ms?: number;
  popup_message?: string;
  popup_message_imperial?: string;
  options?: CommandOption[];
  steps?: CommandStep[];
  notes?: string;
  tested_vehicle?: string;
  contributor?: ContributorInfo;
  contributors?: ContributorInfo[];
  // Home Assistant & MDI Icon metadata
  ha_domain?: string;
  icon?: string;
  mdi?: string;
  device_class?: string;
  // Special types properties
  precon_mode?: string;
  precon_press?: string;
  webhook_url?: string;
  mqtt_topic?: string;
  mqtt_payload?: string;
  expression?: string;
  voltage_val?: string;
  voltage_dir?: 'above' | 'below' | string;
  days?: string[];
  start_time?: string;
  end_time?: string;
  climate_zone?: string;
  target_temp_c?: number;
  target_temp_f?: number;
  pass_temp_c?: number;
  pass_temp_f?: number;
  climate_sync_on?: boolean;
  climate_driver_only?: boolean;
  [key: string]: any;
}

export interface Vehicle {
  id: string;
  name: string;
  make: string;
  model: string;
  trim: string;
  region: 'us' | 'eu' | 'global' | 'universal' | string;
  family: string;
  features: string[];
  model_years?: number[] | string;
  contributor?: ContributorInfo;
  contributors?: ContributorInfo[];
  [key: string]: any;
}

export interface Catalog {
  catalog_version: string;
  vehicles: Vehicle[];
  commands: Command[];
  automations?: any[];
}

export interface ValidationIssue {
  type: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
  commandId?: string;
}

export interface CatalogValidationReport {
  isValid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
  totalCommands: number;
  canIdGroups: Record<string, string[]>; // can_id -> command ids
  categoryCounts: Record<string, number>;
  roleCounts: Record<CommandRole, number>;
}

export interface GitHubRepoConfig {
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}
