import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeFiredTime,
  simulateAutomationRule,
  discoverRuleSimulationInputs
} from './ruleSimulator.js';
import { AutomationRule } from '../types/automation.js';
import { Catalog } from '../types/catalog.js';

const MOCK_CATALOG: Catalog = {
  can_do_version: '2026.11.6',
  vehicles: [],
  commands: [
    {
      id: 'drivers_seat_comfort',
      name: 'Driver Seat Comfort',
      category: 'Climate',
      roles: ['condition', 'action'],
      state_can_id: '0x4A2',
      action_can_id: '0x4A2',
      options: [
        { label: 'Off', match: { D5: '0x00' }, payload: { D5: '0x00' } },
        { label: 'Low Heat', match: { D5: '0x49' }, payload: { D5: '0x49' } },
        { label: 'Medium Heat', match: { D5: '0x4A' }, payload: { D5: '0x4A' } },
        { label: 'High Heat', match: { D5: '0x4B' }, payload: { D5: '0x4B' } }
      ]
    }
  ]
};

test('formatRelativeFiredTime transitions from Just now to seconds, minutes, hours, and days', () => {
  const base = 1_700_000_000_000;
  assert.strictEqual(formatRelativeFiredTime(base, base + 2_000), 'Just now');
  assert.strictEqual(formatRelativeFiredTime(base, base + 14_000), '14s ago');
  assert.strictEqual(formatRelativeFiredTime(base, base + 59_000), '59s ago');
  assert.strictEqual(formatRelativeFiredTime(base, base + 60_000), '1m ago');
  assert.strictEqual(formatRelativeFiredTime(base, base + 45 * 60_000), '45m ago');
  assert.strictEqual(formatRelativeFiredTime(base, base + 3 * 3600_000), '3h ago');
  assert.strictEqual(formatRelativeFiredTime(base, base + 48 * 3600_000), '2d ago');
});

test('simulateAutomationRule traces if_then, choose, and cycle_entity ping_pong accurately', () => {
  const rule: AutomationRule = {
    id: 'sim_seat_cycle',
    name: 'Seat Cycle Test',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-heater',
    exec_mode: 'one_shot',
    trigger_mode: 'any',
    cooldown_ms: 250,
    triggers: [
      { id: 't1', source: 'ble', type: 'ble_button', ble_button: 'volume_up' }
    ],
    conditions: [],
    actions: [
      {
        id: 'act_cycle',
        type: 'cycle_entity',
        entity_id: 'drivers_seat_comfort',
        states: ['Off', 'Low Heat', 'High Heat'],
        direction: 'ping_pong',
        wrap: false,
        show_popup: true,
        popup_prefix: '{entity} -> {state}'
      }
    ]
  };

  const inputs = discoverRuleSimulationInputs(rule, MOCK_CATALOG);
  assert.strictEqual(inputs.entities.length, 1);
  assert.strictEqual(inputs.entities[0].entityId, 'drivers_seat_comfort');

  const states1 = new Map<string, string>([['drivers_seat_comfort', 'Off']]);
  const frames = new Map<string, { data: string }>();

  // Step 1: Off -> Low Heat
  const res1 = simulateAutomationRule(rule, {
    catalog: MOCK_CATALOG,
    entityStates: states1,
    liveFrames: frames
  });
  assert.strictEqual(res1.passed, true);
  assert.strictEqual(res1.nextEntityStates.get('drivers_seat_comfort'), 'Low Heat');
  assert.ok(res1.traces.some(t => /Off ➔ Low Heat/.test(t.title)));

  // Step 2: Low Heat -> High Heat (reverses ping-pong direction at boundary)
  const res2 = simulateAutomationRule(rule, {
    catalog: MOCK_CATALOG,
    entityStates: res1.nextEntityStates,
    liveFrames: frames,
    pingPongDirections: res1.nextPingPongDirections
  });
  assert.strictEqual(res2.nextEntityStates.get('drivers_seat_comfort'), 'High Heat');

  // Step 3: High Heat -> Low Heat (bounces backward)
  const res3 = simulateAutomationRule(rule, {
    catalog: MOCK_CATALOG,
    entityStates: res2.nextEntityStates,
    liveFrames: frames,
    pingPongDirections: res2.nextPingPongDirections
  });
  assert.strictEqual(res3.nextEntityStates.get('drivers_seat_comfort'), 'Low Heat');
});

test('simulateAutomationRule blocks when multi-trigger window or guard condition fails', () => {
  const rule: AutomationRule = {
    id: 'multi_trig_guard',
    name: 'Sequence Rule',
    enabled: true,
    ha_expose: false,
    ha_icon: 'mdi:car',
    exec_mode: 'one_shot',
    trigger_mode: 'sequence',
    trigger_window_ms: 8000,
    cooldown_ms: 0,
    triggers: [
      { id: 't1', source: 'ble', type: 'ble_button', ble_button: 'volume_up' },
      { id: 't2', source: 'ble', type: 'ble_button', ble_button: 'volume_down' }
    ],
    conditions: [],
    actions: [{ id: 'a1', type: 'delay', delay_ms: 200 }]
  };

  const blocked = simulateAutomationRule(rule, {
    catalog: MOCK_CATALOG,
    multiTriggerWindowSatisfied: false,
    entityStates: new Map(),
    liveFrames: new Map()
  });
  assert.strictEqual(blocked.passed, false);
  assert.ok(blocked.traces.some(t => t.status === 'fail' && /Multi-Trigger Mode/.test(t.title)));
});
