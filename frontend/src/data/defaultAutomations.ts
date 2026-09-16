import { AutomationRule, AutomationSettings } from '../types/automation';

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  vehicle_model: 'all_egmp',
  unit_system: 'imperial',
  firmware_version: '2.0.0',
  capture_mode: 'auto'
};

export const DEFAULT_AUTOMATION_RULES: AutomationRule[] = [
  {
    id: 'menu_ok_cool_driver_seat',
    name: 'Menu OK Press → Driver Seat Medium Cool',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-cooler',
    exec_mode: 'one_shot',
    trigger_mode: 'any',
    cooldown_ms: 1000,
    timeout_reset_ms: 2000,
    reset_can_id: '0x448',
    triggers: [
      {
        id: 'trig_menu_ok',
        source: 'can',
        type: 'can_rx',
        can_id: '0x448',
        bus: 0,
        click_count: 1,
        for_sec: 0,
        for_ms: 0,
        byte_index: 6,
        from_value: 0,
        to_value: 1,
        match: { D7: '0x0' },
        source_command_id: 'sw_ok',
        source_command_name: 'Menu / OK Button',
        option_label: 'Pressed'
      }
    ],
    conditions: [],
    actions: [
      {
        id: 'act_cool_driver_seat',
        type: 'entity_command',
        entity_id: 'drivers_seat_comfort',
        command: 'Medium Cool',
        popup_message: 'Driver Seat: Cool Med',
        source_command_id: 'drivers_seat_comfort',
        source_command_name: 'Driver Seat Comfort'
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
        type: 'can_rx',
        can_id: '0x380',
        bus: 0,
        click_count: 2,
        for_sec: 0,
        for_ms: 0,
        byte_index: 2,
        from_value: 0,
        to_value: 1,
        match: { D3: '0x01' },
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
        match: { D1: '0x00', D2: '0x00' },
        evaluate: {
          byte: 'D1',
          operator: 'equal',
          value: '0x00'
        },
        invert: false,
        source_command_id: 'wheel_speed',
        source_command_name: 'Vehicle Speed',
        option_label: '0 km/h (Stopped)'
      }
    ],
    actions: [
      {
        id: 'act_tailgate',
        type: 'transmit',
        can_id: '0x540',
        bus: 0,
        payload: { D1: '0x08', D2: '0x01' },
        repeat: 3,
        delay_ms: 100,
        steps: [
          { payload: { D1: '0x08', D2: '0x01' }, repeat: 3, delay_ms: 80 }
        ],
        popup_message: 'Opening Tailgate',
        source_command_id: 'tailgate_trigger',
        source_command_name: 'Power Tailgate Toggle'
      }
    ]
  }
];
