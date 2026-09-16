import { AutomationRule, AutomationSettings } from '../types/automation';

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  vehicle_model: 'all_egmp',
  unit_system: 'imperial',
  firmware_version: '2.0.0',
  capture_mode: 'auto'
};

export const DEFAULT_AUTOMATION_RULES: AutomationRule[] = [
  {
    id: 'rule-precondition-star',
    name: 'Steering Wheel Star → Battery Preconditioning',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-defrost-rear',
    exec_mode: 'one_shot',
    trigger_mode: 'any',
    cooldown_ms: 1000,
    timeout_reset_ms: 2000,
    reset_can_id: '0x448',
    triggers: [
      {
        id: 'trig_sw_star',
        source: 'preset',
        can_id: '0x448',
        bus: 0,
        click_count: 1,
        for_sec: 0,
        for_ms: 0,
        from_payload: '* * * * * 0*',
        to_payload: '* * * * * 1*',
        match_payload: '* * * * * 1*',
        source_command_id: 'sw_star_btn',
        source_command_name: 'Steering Wheel Star Button',
        option_label: 'Pressed'
      }
    ],
    conditions: [
      {
        id: 'cond_gear_park',
        type: 'can_state',
        can_id: '0x120',
        bus: 0,
        match_payload: '01 * * * * * * *',
        invert: false,
        source_command_id: 'gear_selector',
        source_command_name: 'Transmission Gear (PRND)',
        option_label: 'Park (P)'
      }
    ],
    actions: [
      {
        id: 'act_precon',
        type: 'precondition',
        trigger_id: 'trig_sw_star',
        precon_mode: 'persistent',
        precon_press: 'short',
        popup_message: 'Battery Precon Activated'
      }
    ]
  },
  {
    id: 'rule-double-tap-tailgate',
    name: 'Double-Tap Unlock Button → Open Power Tailgate',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-door',
    exec_mode: 'one_shot',
    trigger_mode: 'any',
    cooldown_ms: 2000,
    timeout_reset_ms: 1500,
    triggers: [
      {
        id: 'trig_unlock_double',
        source: 'can',
        can_id: '0x380',
        bus: 0,
        click_count: 2,
        for_sec: 0,
        for_ms: 0,
        from_payload: '* * 00 * * * * *',
        to_payload: '* * 01 * * * * *',
        match_payload: '* * 01 * * * * *',
        source_command_id: 'door_lock_switch',
        source_command_name: 'Driver Door Unlock Switch',
        option_label: 'Unlock'
      }
    ],
    conditions: [
      {
        id: 'cond_speed_zero',
        type: 'can_state',
        can_id: '0x220',
        bus: 0,
        match_payload: '00 00 * * * * * *',
        invert: false,
        source_command_id: 'wheel_speed',
        source_command_name: 'Vehicle Speed',
        option_label: '0 km/h (Stopped)'
      }
    ],
    actions: [
      {
        id: 'act_tailgate',
        type: 'can_tx',
        can_id: '0x540',
        bus: 0,
        payload: '08 01 00 00 00 00 00 00',
        repeat: 3,
        delay_ms: 100,
        steps: [
          { payload: '08 01 00 00 00 00 00 00', repeat: 3, delay_ms: 80 }
        ],
        popup_message: 'Opening Tailgate',
        source_command_id: 'tailgate_trigger',
        source_command_name: 'Power Tailgate Toggle'
      }
    ]
  }
];
