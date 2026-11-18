import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesRuleSearch,
  formatTriggerSummary,
  formatConditionSummary,
  formatActionSummary
} from './ruleSummaries.js';
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
      roles: ['trigger', 'condition', 'action'],
      state_can_id: '0x4A2',
      action_can_id: '0x4A2',
      options: [
        { label: 'Off', match: { D5: '0x00' }, payload: { D5: '0x00' } },
        { label: 'Low Heat', match: { D5: '0x49' }, payload: { D5: '0x49' } },
        { label: 'High Heat', match: { D5: '0x4B' }, payload: { D5: '0x4B' } }
      ]
    }
  ]
};

test('matchesRuleSearch matches by name, category, CAN ID, entity, and nested action fields', () => {
  const rule: AutomationRule = {
    id: 'seat_warm_rule',
    name: 'Winter Seat Heater',
    category: 'Comfort',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-heater',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [
      { id: 't1', source: 'can', type: 'byte_transition', can_id: '0x448', byte: 'D7', from: '0x00', to: '0x10' }
    ],
    conditions: [],
    actions: [
      {
        id: 'a1',
        type: 'if_then',
        conditions: [{ id: 'c1', type: 'voltage', voltage_val: '13.2', voltage_dir: 'above' }],
        then: [{ id: 'a2', type: 'cycle_entity', entity_id: 'drivers_seat_comfort', states: ['Off', 'Low Heat', 'High Heat'] }],
        else: []
      }
    ]
  };

  assert.strictEqual(matchesRuleSearch(rule, '', MOCK_CATALOG), true);
  assert.strictEqual(matchesRuleSearch(rule, 'winter', MOCK_CATALOG), true);
  assert.strictEqual(matchesRuleSearch(rule, 'comfort', MOCK_CATALOG), true);
  assert.strictEqual(matchesRuleSearch(rule, '0x448', MOCK_CATALOG), true);
  assert.strictEqual(matchesRuleSearch(rule, 'high heat', MOCK_CATALOG), true);
  assert.strictEqual(matchesRuleSearch(rule, 'nonexistent_xyz', MOCK_CATALOG), false);
});

test('formatTriggerSummary, formatConditionSummary, and formatActionSummary produce concise 1-line summaries', () => {
  const trigSummary = formatTriggerSummary(
    { id: 't1', source: 'can', type: 'byte_transition', can_id: '0x448', byte: 'D7', from: '0x00', to: '0x10', for_ms: 1500 },
    MOCK_CATALOG
  );
  assert.match(trigSummary, /CAN 0x448/);
  assert.match(trigSummary, /D7: 0x00 ➔ 0x10/);
  assert.match(trigSummary, /hold 1\.5s/);

  const condSummary = formatConditionSummary(
    { id: 'c1', type: 'time_condition', start_time: '07:00', end_time: '09:30', days: ['mon', 'tue', 'wed'] },
    MOCK_CATALOG
  );
  assert.strictEqual(condSummary, '07:00 – 09:30 (mon, tue, wed)');

  const cycleSummary = formatActionSummary(
    {
      id: 'a1',
      type: 'cycle_entity',
      entity_id: 'drivers_seat_comfort',
      states: ['Off', 'Low Heat', 'High Heat'],
      direction: 'ping_pong'
    },
    MOCK_CATALOG
  );
  assert.strictEqual(cycleSummary, 'Cycle Driver Seat Comfort: Off ➔ Low Heat ➔ High Heat (Ping-Pong)');
});
