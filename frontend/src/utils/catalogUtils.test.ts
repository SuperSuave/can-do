import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEffectiveOptions,
  expandLinearScaleOptions,
  resolveVariant,
  resolveAllVariants,
  formatPlatformFamily,
  formatCommandForCatalog,
  rawByteToPhysical,
  physicalToRawByte,
  buildRangeActionPayload,
} from './catalogUtils.js';
import type { Command, CommandOption, Vehicle } from '../types/catalog.js';

test('getEffectiveOptions returns command options for regular discrete command', () => {
  const discreteOptions: CommandOption[] = [
    { label: 'Off', payload: { D1: '0x00' } },
    { label: 'Level 1', payload: { D1: '0x01' } },
    { label: 'Level 2', payload: { D1: '0x02' } },
  ];
  const cmd: Command = {
    id: 'seat_heater',
    name: 'Seat Heater',
    category: 'Comfort',
    roles: ['condition', 'action'],
    options: discreteOptions,
  };

  const options = getEffectiveOptions(cmd);
  assert.strictEqual(options.length, 3);
  assert.deepStrictEqual(options, discreteOptions);
});

test('getEffectiveOptions returns empty array when options are undefined or missing', () => {
  const cmd: Command = {
    id: 'horn_burst',
    name: 'Horn Burst',
    category: 'Body',
    roles: ['action'],
  };

  const options = getEffectiveOptions(cmd);
  assert.deepStrictEqual(options, []);
});

test('getEffectiveOptions expands linear_scale options according to network metadata', () => {
  const cmd: Command = {
    id: 'fan_speed',
    name: 'Fan Speed',
    category: 'Climate',
    roles: ['condition', 'action'],
    type: 'linear_scale',
    network: {
      raw_min: '0x01',
      raw_max: '0x04',
      min: 1,
      step: 1,
      unit: ' speed',
      state_byte: 'D2',
      action_byte: 'D2',
    } as any,
  };

  const options = getEffectiveOptions(cmd);
  assert.strictEqual(options.length, 4);

  // First step (0x01)
  assert.strictEqual(options[0].label, '1 speed');
  assert.deepStrictEqual(options[0].match, { D2: '0x01' });
  assert.deepStrictEqual(options[0].payload, { D2: '0x01' });
  assert.strictEqual(options[0].mask, '0xFF');

  // Last step (0x04)
  assert.strictEqual(options[3].label, '4 speed');
  assert.deepStrictEqual(options[3].match, { D2: '0x04' });
  assert.deepStrictEqual(options[3].payload, { D2: '0x04' });
  assert.strictEqual(options[3].mask, '0xFF');
});

test('getEffectiveOptions falls back to cmd.options for linear_scale missing raw_min/raw_max', () => {
  const fallbackOption: CommandOption = { label: 'Default', payload: { D1: '0x00' } };
  const cmd: Command = {
    id: 'scale_missing_meta',
    name: 'Scale Missing Metadata',
    category: 'Climate',
    roles: ['condition'],
    type: 'linear_scale',
    options: [fallbackOption],
    network: {} as any,
  };

  const options = getEffectiveOptions(cmd);
  assert.deepStrictEqual(options, [fallbackOption]);
});

test('getEffectiveOptions overlays named options and appends evaluate condition options on linear_scale', () => {
  const cmd: Command = {
    id: 'target_temp',
    name: 'Target Temperature',
    category: 'Climate',
    roles: ['condition', 'action'],
    type: 'linear_scale',
    network: {
      raw_min: '0x10',
      raw_max: '0x12',
      min: 60,
      step: 1,
      unit: '°F',
      state_byte: 'D1',
    } as any,
    options: [
      // Overlay step 0x10 with custom label and default flag
      { label: 'Low / Min', match: { D1: '0x10' }, is_default: true },
      // Evaluate option chip (e.g. range comparison condition)
      { label: 'Under 62°F', evaluate: '< 62' } as any,
    ],
  };

  const options = getEffectiveOptions(cmd);
  // 3 generated steps (0x10, 0x11, 0x12) + 1 evaluate option
  assert.strictEqual(options.length, 4);

  // Overlaid option at 0x10
  assert.strictEqual(options[0].label, 'Low / Min');
  assert.strictEqual(options[0].is_default, true);
  assert.deepStrictEqual(options[0].match, { D1: '0x10' });

  // Purely generated steps
  assert.strictEqual(options[1].label, '61°F');
  assert.strictEqual(options[2].label, '62°F');

  // Appended evaluate option
  assert.strictEqual(options[3].label, 'Under 62°F');
  assert.strictEqual((options[3] as any).evaluate, '< 62');
});

test('resolveVariant returns original command unmodified if command has no variants', () => {
  const baseCmd: Command = {
    id: 'base_cmd',
    name: 'Base Command',
    category: 'Lighting',
    roles: ['action'],
  };
  const vehicle: Vehicle = {
    id: 'ioniq5_2022',
    name: 'Ioniq 5',
    make: 'Hyundai',
    model: 'Ioniq 5',
    trim: 'Limited',
    region: 'us',
    family: 'ioniq5',
    features: [],
  };

  const resolved = resolveVariant(baseCmd, vehicle);
  assert.strictEqual(resolved, baseCmd);
});

test('resolveVariant returns original command unmodified if variants array is empty', () => {
  const baseCmd: Command = {
    id: 'base_cmd_empty_var',
    name: 'Base Command Empty',
    category: 'Lighting',
    roles: ['action'],
    variants: [],
  };
  const resolved = resolveVariant(baseCmd, null);
  assert.strictEqual(resolved, baseCmd);
});

test('resolveVariant matches specific vehicle id target and merges network/options', () => {
  const baseCmd: Command = {
    id: 'preconditioning_status',
    name: 'Preconditioning Status',
    category: 'HVAC',
    roles: ['condition'],
    network: { state_can_id: '0x2AD' },
    variants: [
      {
        targets: ['ev6_2022'],
        network: { state_can_id: '0x2AD' },
      },
      {
        targets: ['ioniq6_2023'],
        network: { state_can_id: '0x0A82AA03' },
        options: [{ label: 'Active', payload: { D1: '0x01' } }],
      },
    ],
  };

  const vehicle: Vehicle = {
    id: 'ioniq6_2023',
    name: 'Ioniq 6',
    make: 'Hyundai',
    model: 'Ioniq 6',
    trim: 'SEL',
    region: 'us',
    family: 'ioniq6',
    features: [],
  };

  const resolved = resolveVariant(baseCmd, vehicle);
  assert.strictEqual(resolved.network?.state_can_id, '0x0A82AA03');
  assert.strictEqual(resolved.options?.length, 1);
  assert.strictEqual(resolved.name, 'Preconditioning Status');
});

test('resolveVariant matches vehicle family target when specific id does not match', () => {
  const baseCmd: Command = {
    id: 'mirror_fold',
    name: 'Mirror Fold',
    category: 'Body',
    roles: ['action'],
    variants: [
      {
        targets: ['egmp_kia'],
        network: { action_can_id: '0x540' },
      },
      {
        targets: ['egmp_hyundai'],
        network: { action_can_id: '0x520' },
      },
    ],
  };

  const vehicle: Vehicle = {
    id: 'custom_ev6_custom_id',
    name: 'EV6 Custom',
    make: 'Kia',
    model: 'EV6',
    trim: 'GT-Line',
    region: 'us',
    family: 'egmp_kia',
    features: [],
  };

  const resolved = resolveVariant(baseCmd, vehicle);
  assert.strictEqual(resolved.network?.action_can_id, '0x540');
});

test('resolveVariant falls back to first variant when vehicle does not match', () => {
  const baseCmd: Command = {
    id: 'fallback_test',
    name: 'Fallback Test',
    category: 'Misc',
    roles: ['action'],
    variants: [
      {
        targets: ['known_car'],
        network: { action_can_id: '0x111' },
      },
      {
        targets: ['other_car'],
        network: { action_can_id: '0x222' },
      },
    ],
  };

  const unknownVehicle: Vehicle = {
    id: 'unknown_prototype',
    name: 'Unknown',
    make: 'Proto',
    model: 'X',
    trim: 'Base',
    region: 'global',
    family: 'unknown_family',
    features: [],
  };

  const resolved = resolveVariant(baseCmd, unknownVehicle);
  // Falls back to variants[0]
  assert.strictEqual(resolved.network?.action_can_id, '0x111');
});

test('resolveAllVariants maps resolveVariant across a list of commands', () => {
  const commands: Command[] = [
    {
      id: 'cmd1',
      name: 'Command 1',
      category: 'Cat1',
      roles: ['action'],
      variants: [{ targets: ['car_a'], network: { action_can_id: '0xAAA' } }],
    },
    {
      id: 'cmd2',
      name: 'Command 2',
      category: 'Cat2',
      roles: ['action'],
    },
  ];

  const vehicle: Vehicle = {
    id: 'car_a',
    name: 'Car A',
    make: 'Hyundai',
    model: 'A',
    trim: 'A',
    region: 'us',
    family: 'fam_a',
    features: [],
  };

  const resolvedList = resolveAllVariants(commands, vehicle);
  assert.strictEqual(resolvedList.length, 2);
  assert.strictEqual(resolvedList[0].network?.action_can_id, '0xAAA');
  assert.strictEqual(resolvedList[1].id, 'cmd2');
});

test('formatPlatformFamily maps raw family slugs to friendly names', () => {
  assert.strictEqual(formatPlatformFamily('kia_ev6'), 'EV6');
  assert.strictEqual(formatPlatformFamily('hyundai_ioniq5'), 'Ioniq 5');
  assert.strictEqual(formatPlatformFamily('hyundai_ioniq6'), 'Ioniq 6');
  assert.strictEqual(formatPlatformFamily('genesis_gv60'), 'GV60');
  assert.strictEqual(formatPlatformFamily('all_egmp'), 'All E-GMP');
  assert.strictEqual(formatPlatformFamily('all'), 'All Platform Families');
  assert.strictEqual(formatPlatformFamily(null), 'All Platform Families');
  assert.strictEqual(formatPlatformFamily(undefined), 'All Platform Families');

  // Dynamic derivation from catalog vehicles
  const mockCatalog = {
    vehicles: [
      { id: 'v1', make: 'Rivian', model: 'R1T', trim: 'Adventure', region: 'us', family: 'rivian_r1t', features: [] }
    ]
  };
  assert.strictEqual(formatPlatformFamily('rivian_r1t', mockCatalog as any), 'R1T');

  // Fallback heuristic for unrecognized slugs
  assert.strictEqual(formatPlatformFamily('kia_ev9'), 'EV9');
  assert.strictEqual(formatPlatformFamily('custom_platform_slug'), 'Custom Platform Slug');
});

test('rawByteToPhysical, physicalToRawByte, and buildRangeActionPayload handle param_range schemas accurately', () => {
  // 1. raw_min/raw_max climate_driver_temp schema (62..82 °F <-> 0x06..0x1A)
  const driverNet = {
    state_can_id: '0x380',
    action_can_id: '0x4A0',
    state_byte: 'D2',
    action_byte: 'D2',
    min: 62,
    max: 82,
    step: 1,
    unit: '°F',
    raw_min: '0x06',
    raw_max: '0x1A',
  };
  assert.strictEqual(physicalToRawByte(70, driverNet), 0x0e);
  assert.deepStrictEqual(rawByteToPhysical(0x0e, driverNet), { val: 70, unit: '°F' });
  assert.deepStrictEqual(buildRangeActionPayload('0x0E', driverNet), { D2: '0x0E' });

  // 2. Centered positive offset audio_amp_fader schema (-10..+10 dB <-> 0x00..0x14, center 0x0A)
  const faderNet = {
    action_can_id: '0x60C',
    action_byte: 'D3',
    min: -10,
    max: 10,
    step: 1,
    offset: 10,
    base_payload: ['0x19', '0x00', '0x0A', '0x00', '0x00', '0x00', '0x00', '0x00'],
  };
  assert.strictEqual(physicalToRawByte(0, faderNet), 0x0a);
  assert.strictEqual(physicalToRawByte(-10, faderNet), 0x00);
  assert.strictEqual(physicalToRawByte(10, faderNet), 0x14);
  assert.strictEqual(rawByteToPhysical(0x0a, faderNet).val, 0);
  assert.strictEqual(rawByteToPhysical(0x00, faderNet).val, -10);
  assert.deepStrictEqual(buildRangeActionPayload('0x0C', faderNet), {
    D1: '0x19',
    D2: '0x00',
    D3: '0x0C',
    D4: '0x00',
    D5: '0x00',
    D6: '0x00',
    D7: '0x00',
    D8: '0x00',
  });

  // 3. Negative offset temperature schema (outdoor_temperature: -40..215 °C <-> 0x00..0xFF)
  const outdoorNet = { min: -40, max: 215, factor: 1, offset: -40, unit: '°C' };
  assert.strictEqual(physicalToRawByte(0, outdoorNet), 40);
  assert.strictEqual(rawByteToPhysical(40, outdoorNet).val, 0);
});

test('formatCommandForCatalog preserves param_range type and network range metadata', () => {
  const formatted = formatCommandForCatalog({
    id: 'climate_driver_temp',
    name: 'Driver Cabin Target Temperature',
    ha_metadata: { name: 'Driver Cabin Target Temperature', domain: 'climate', icon: 'mdi:thermometer' },
    type: 'param_range',
    category: 'Climate & Comfort',
    subcategory: 'HVAC Controls',
    roles: ['trigger', 'condition', 'action'],
    network: {
      bus: 0,
      type: 'can_rx_tx',
      state_can_id: '0x380',
      action_can_id: '0x4A0',
      state_byte: 'D2',
      action_byte: 'D2',
      min: 62,
      max: 82,
      step: 1,
      unit: '°F',
      raw_min: '0x06',
      raw_max: '0x1A',
      delay_ms: 20,
    },
  });

  assert.strictEqual(formatted.type, 'param_range');
  assert.strictEqual(formatted.network?.state_byte, 'D2');
  assert.strictEqual(formatted.network?.action_byte, 'D2');
  assert.strictEqual(formatted.network?.min, 62);
  assert.strictEqual(formatted.network?.max, 82);
  assert.strictEqual(formatted.network?.raw_min, '0x06');
  assert.strictEqual(formatted.network?.raw_max, '0x1A');
  assert.strictEqual(formatted.network?.unit, '°F');
});
