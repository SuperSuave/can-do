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
  _clientId?: string;
  source: 'preset' | 'can' | 'time' | 'voltage' | 'mqtt' | 'ble';
  type?: 'byte_transition' | 'time_schedule' | 'can_rx' | 'mqtt' | 'ble_button' | 'ble_key' | string;
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
  days?: string[];
  interval_sec?: number;
  voltage_val?: string;
  voltage_dir?: 'above' | 'below';
  expression?: string;
  mqtt_topic?: string;
  mqtt_payload?: string;
  // Bluetooth BLE trigger fields
  ble_button?: string; // e.g. "volume_up", "volume_down", "play_pause", "key_1", etc.
  ble_action?: 'press' | 'release' | 'hold' | 'any';
  ble_device?: string; // optional device name or address filter
}

export interface AutomationCondition {
  id: string;
  _clientId?: string;
  type?: 'can_state' | 'byte_value' | 'time_condition' | 'time' | 'param_range' | 'voltage' | 'and' | 'or' | 'not' | 'and_group' | 'or_group' | 'not_group' | 'triggered_by' | 'trigger';
  logic?: 'and' | 'or' | 'not' | 'leaf';
  trigger_id?: string;
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
  and?: AutomationCondition[];
  or?: AutomationCondition[];
  not?: AutomationCondition[] | AutomationCondition;
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

export type PopupLevel = 'info' | 'warning' | 'error';

export interface AutomationAction {
  id: string;
  _clientId?: string;
  type: 'can_tx' | 'transmit' | 'entity_command' | 'delay' | 'precondition' | 'climate_target' | 'webhook' | 'choose' | 'if_then' | 'track_popup' | 'popup';
  level?: PopupLevel;
  text?: string;
  popup_message?: string;
  target_temp_c?: number;
  target_c?: number;
  zone?: 'driver' | 'passenger';
  sync_on?: boolean;
  driver_only?: boolean;
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
  precon_mode?: 'persistent' | 'continuous' | 'once' | 'cancel' | string;
  precon_action?: 'start' | 'stop' | 'toggle' | string;
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
  description?: string;
  category?: string;
  tags?: string[];
  contributor?: {
    name?: string;
    github?: string;
    notes?: string;
  };
}

export interface AutomationSettings {
  vehicle_model?: string;
  unit_system?: 'imperial' | 'metric';
  firmware_version?: string;
  capture_mode?: 'auto' | 'paused' | 'disabled';
  ntp_server?: string;
  timezone?: string;
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
