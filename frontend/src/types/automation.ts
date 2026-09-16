import { CommandRole, CommandOption, ByteMap } from './catalog';

export type ExecutionMode =
  | 'one_shot'
  | 'toggle'
  | 'continuous_hold'
  | 'on_change'
  | 'poll_verify';

export type TriggerCombineMode = 'any' | 'all' | 'sequence';

export interface AutomationTrigger {
  id: string;
  source: 'preset' | 'can' | 'time' | 'voltage' | 'mqtt';
  type?: string;
  can_id?: string;
  bus?: number;
  click_count?: number; // 1 = single, 2 = double, 3 = triple
  for_sec?: number;
  for_ms?: number;
  byte_index?: number;
  byte?: string;
  mask?: string;
  from?: string;
  to?: string;
  from_value?: number;
  to_value?: number;
  from_payload?: string | ByteMap;
  to_payload?: string | ByteMap;
  match_payload?: string | ByteMap;
  match?: ByteMap;
  source_command_id?: string;
  source_command_name?: string;
  option_label?: string;
  time?: string;
  interval_sec?: number;
  voltage_val?: string;
  voltage_dir?: 'above' | 'below';
  expression?: string;
  mqtt_topic?: string;
  mqtt_payload?: string;
}

export interface AutomationCondition {
  id: string;
  type?: 'can_state' | 'param_range' | 'time' | 'voltage' | 'and_group' | 'or_group' | 'not_group';
  logic?: 'and' | 'or' | 'not' | 'leaf';
  can_id?: string;
  bus?: number;
  byte?: string;
  mask?: string;
  operator?: string;
  value?: string;
  match_payload?: string | ByteMap;
  match?: ByteMap;
  byte_index?: number;
  evaluate?: {
    byte: string;
    byte_index?: number;
    mask?: string;
    operator: string;
    value: string;
  };
  invert?: boolean;
  expression?: string;
  source_command_id?: string;
  source_command_name?: string;
  option_label?: string;
  preset_name?: string;
  days?: string[];
  start_time?: string;
  end_time?: string;
  voltage_val?: string;
  voltage_dir?: 'above' | 'below';
  conditions?: AutomationCondition[];
}

export interface AutomationActionChoice {
  conditions: AutomationCondition[];
  sequence: AutomationAction[];
}

export interface AutomationActionStep {
  payload: string | ByteMap;
  repeat?: number;
  delay_ms?: number;
}

export interface AutomationAction {
  id: string;
  type: 'can_tx' | 'transmit' | 'entity_command' | 'delay' | 'precondition' | 'climate_target' | 'webhook' | 'choose' | 'if_then';
  trigger_id?: string;
  can_id?: string;
  bus?: number;
  entity_id?: string;
  command?: string;
  payload?: string | ByteMap;
  to_payload?: string | ByteMap;
  repeat?: number;
  delay_ms?: number;
  ms?: number;
  steps?: AutomationActionStep[];
  popup_message?: string;
  precon_mode?: 'persistent' | 'timed' | 'toggle';
  precon_press?: 'short' | 'long';
  source_command_id?: string;
  source_command_name?: string;
  option_label?: string;
  webhook_url?: string;
  webhook_method?: 'GET' | 'POST';

  // For if_then
  conditions?: AutomationCondition[];
  then?: AutomationAction[];
  else?: AutomationAction[];

  // For choose
  choices?: AutomationActionChoice[];
  default?: AutomationAction[];
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  ha_expose: boolean;
  ha_icon: string;
  exec_mode: ExecutionMode;
  trigger_mode?: TriggerCombineMode;
  cooldown_ms: number;
  timeout_reset_ms?: number;
  reset_can_id?: string;
  verify_can_id?: string;
  verify_payload?: string;
  auto_revert_sec?: number;
  triggers: AutomationTrigger[];
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  off_actions?: AutomationAction[];
}

export interface AutomationSettings {
  vehicle_model?: string;
  unit_system?: 'imperial' | 'metric';
  firmware_version?: string;
  capture_mode?: 'auto' | 'paused' | 'disabled';
}

export interface CandoRulesExport {
  settings: AutomationSettings;
  rules: AutomationRule[];
}

/**
 * Streamlined ESP32 firmware format (flat & memory-efficient C parser)
 */
export interface Esp32FirmwareRule {
  id: string;
  name: string;
  en: number; // 0 or 1
  mode: number; // 0=one_shot, 1=toggle, 2=hold, 3=on_change, 4=poll_verify
  trig_op: number; // 0=any, 1=all
  cd_ms: number;
  trigs: {
    id: string;
    can_id: string;
    bus: number;
    clicks: number;
    from: string | ByteMap;
    to: string | ByteMap;
  }[];
  conds: {
    can_id: string;
    bus: number;
    match: string | ByteMap;
    inv: number;
  }[];
  acts: {
    can_id: string;
    bus: number;
    payload: string | ByteMap;
    rep: number;
    delay: number;
    steps?: { p: string | ByteMap; r: number; d: number }[];
    osd?: string;
  }[];
  off_acts?: {
    can_id: string;
    bus: number;
    payload: string | ByteMap;
    rep: number;
  }[];
}

export interface Esp32FirmwareConfig {
  v: number;
  vehicle: string;
  rules: Esp32FirmwareRule[];
}
