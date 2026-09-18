import { CommandOption } from '../types/catalog';

export interface StatePreset {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  options: CommandOption[];
}

export const STATE_PRESETS: StatePreset[] = [
  {
    id: 'gear',
    name: 'Gear Shifter (P / R / N / D)',
    icon: 'mdi:car-shift-pattern',
    category: 'Transmission',
    description: 'Standard automatic transmission gear positions (byte 3 matching E-GMP / CAN-Do standard)',
    options: [
      {
        label: 'Park (P)',
        state_value: '0x00',
        match_payload: '* * 00 * * * * *',
        description: 'Transmission safely locked in Park',
        default: true
      },
      {
        label: 'Reverse (R)',
        state_value: '0x07',
        match_payload: '* * 07 * * * * *',
        description: 'Transmission engaged in Reverse'
      },
      {
        label: 'Neutral (N)',
        state_value: '0x06',
        match_payload: '* * 06 * * * * *',
        description: 'Transmission in Neutral idle'
      },
      {
        label: 'Drive (D)',
        state_value: '0x05',
        match_payload: '* * 05 * * * * *',
        description: 'Transmission engaged in forward Drive'
      }
    ]
  },
  {
    id: 'doors',
    name: 'Cabin Doors (Closed / Opened)',
    icon: 'mdi:car-door',
    category: 'Doors & Access',
    description: 'Vehicle door latch sensor status',
    options: [
      {
        label: 'Closed & Latched',
        state_value: '0',
        match_payload: '* * * 00 * * * *',
        description: 'Door securely latched and closed',
        default: true
      },
      {
        label: 'Door Ajar / Open',
        state_value: '1',
        match_payload: '* * * 01 * * * *',
        description: 'Door is ajar or opened'
      }
    ]
  },
  {
    id: 'locks',
    name: 'Central Door Locks (Locked / Unlocked)',
    icon: 'mdi:lock',
    category: 'Doors & Access',
    description: 'Central vehicle locking actuator feedback',
    options: [
      {
        label: 'Locked',
        state_value: '0x00',
        match_payload: '* * * 00 * * * *',
        description: 'All vehicle doors secured and locked',
        default: true
      },
      {
        label: 'Unlocked',
        state_value: '0x40',
        match_payload: '* * * 40 * * * *',
        description: 'Doors unlocked / accessible'
      }
    ]
  },
  {
    id: 'seat_heating',
    name: '3-Level Seat Heat (Off / Low / Med / High)',
    icon: 'mdi:car-seat-heater',
    category: 'Comfort & Climate',
    description: 'Driver or passenger seat heating status (D1 byte indicator)',
    options: [
      {
        label: 'Off',
        state_value: '0',
        match_payload: '16 * * * * * * *',
        to_payload: '00 00 00 00 00 00 00 00',
        description: 'Seat heating deactivated',
        default: true
      },
      {
        label: 'Low Heat',
        state_value: '1',
        match_payload: '36 * * * * * * *',
        to_payload: '00 00 00 00 00 F8 00 00',
        description: 'Stage 1 gentle seat heating'
      },
      {
        label: 'Medium Heat',
        state_value: '2',
        match_payload: '4E * * * * * * *',
        to_payload: '00 00 00 00 00 F8 00 00',
        description: 'Stage 2 moderate seat heating'
      },
      {
        label: 'High Heat',
        state_value: '3',
        match_payload: '46 * * * * * * *',
        to_payload: '00 00 00 00 00 F8 00 00',
        description: 'Stage 3 maximum seat heating'
      }
    ]
  },
  {
    id: 'button_switch',
    name: 'Button Switch (Released / Pressed / Long Press)',
    icon: 'mdi:knob',
    category: 'Switches',
    description: 'Steering wheel or center console momentary switch',
    options: [
      {
        label: 'Released (Idle)',
        state_value: '0',
        match_payload: '* * * * * 0*',
        description: 'Button is idle / unpressed',
        default: true
      },
      {
        label: 'Pressed',
        state_value: '1',
        match_payload: '* * * * * 1*',
        description: 'Button momentary press active'
      },
      {
        label: 'Long Press (Held)',
        state_value: '2',
        match_payload: '* * * * * 2*',
        description: 'Button sustained hold > 1.5 seconds'
      }
    ]
  },
  {
    id: 'binary_state',
    name: 'Binary State (0: Inactive / 1: Active)',
    icon: 'mdi:power',
    category: 'Sensors',
    description: 'Generic active/inactive CAN bit sensor',
    options: [
      {
        label: 'Inactive / Off',
        state_value: '0',
        match_payload: '* * 00 * * * * *',
        description: 'Condition is inactive or off',
        default: true
      },
      {
        label: 'Active / On',
        state_value: '1',
        match_payload: '* * 01 * * * * *',
        description: 'Condition is active or triggered'
      }
    ]
  },
  {
    id: 'charging_state',
    name: 'EV High-Voltage Charging Status',
    icon: 'mdi:ev-station',
    category: 'Battery & EV',
    description: 'EV charge port connection and power delivery state',
    options: [
      {
        label: 'Disconnected',
        state_value: '0',
        match_payload: '00 * * * * * * *',
        description: 'Charge port unplugged',
        default: true
      },
      {
        label: 'Plugged In (Waiting)',
        state_value: '1',
        match_payload: '01 * * * * * * *',
        description: 'Cable inserted, awaiting session start'
      },
      {
        label: 'Actively Charging',
        state_value: '2',
        match_payload: '02 * * * * * * *',
        description: 'High-voltage energy flowing to battery pack'
      },
      {
        label: 'Charging Complete',
        state_value: '3',
        match_payload: '03 * * * * * * *',
        description: 'Target charge level reached, port in standby'
      }
    ]
  },
  {
    id: 'turn_signals',
    name: 'Exterior Turn Signals & Hazard',
    icon: 'mdi:car-light-dimmed',
    category: 'Lighting',
    description: 'Vehicle flasher and indicator states',
    options: [
      {
        label: 'Off',
        state_value: '0',
        match_payload: '00 * * * * * * *',
        description: 'Turn indicators and hazard off',
        default: true
      },
      {
        label: 'Left Turn Active',
        state_value: '1',
        match_payload: '01 * * * * * * *',
        description: 'Left turn signal actively flashing'
      },
      {
        label: 'Right Turn Active',
        state_value: '2',
        match_payload: '02 * * * * * * *',
        description: 'Right turn signal actively flashing'
      },
      {
        label: 'Hazard Flashers Active',
        state_value: '3',
        match_payload: '03 * * * * * * *',
        description: 'Emergency 4-way hazard flashers active'
      }
    ]
  },
  {
    id: 'windows',
    name: 'Power Windows (Closed / Venting / Open)',
    icon: 'mdi:window-open',
    category: 'Actuators',
    description: 'Door window position status',
    options: [
      {
        label: 'Fully Closed',
        state_value: '0',
        match_payload: '* * 00 * * * * *',
        description: 'Window glass completely raised',
        default: true
      },
      {
        label: 'Venting',
        state_value: '1',
        match_payload: '* * 20 * * * * *',
        description: 'Window cracked open for fresh air ventilation'
      },
      {
        label: 'Fully Lowered / Open',
        state_value: '2',
        match_payload: '* * FF * * * * *',
        description: 'Window completely rolled down'
      }
    ]
  }
];
