import { AutomationRule, AutomationSettings } from '../types/automation';

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  vehicle_model: 'all_egmp',
  unit_system: 'imperial',
  firmware_version: '2.0.0'
};

export const DEFAULT_AUTOMATION_RULES: AutomationRule[] = [
  {
    id: 'menu_ok_cool_driver_seat',
    name: 'Menu OK Sets Driver Seat Medium Cool',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-cog',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [
      {
        id: 'trig_menu_ok',
        source: 'can',
        type: 'byte_transition',
        can_id: '0x448',
        bus: 0,
        byte: 'D7',
        mask: '0xF0',
        from: '0x00',
        to: '0x10'
      }
    ],
    conditions: [],
    actions: [
      {
        id: 'act_cool_driver_seat',
        type: 'entity_command',
        entity_id: 'drivers_seat_comfort',
        command: 'Medium Cool'
      }
    ]
  }
];
