import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEffectiveOptions, expandLinearScaleOptions } from './catalogUtils.js';
import type { Command, CommandOption } from '../types/catalog.js';

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
