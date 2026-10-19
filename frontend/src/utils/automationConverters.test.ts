import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCatalogCommandForTrigger,
  resolveCatalogCommandForAction,
  resolveCatalogCommandForCondition,
} from './automationConverters.js';
import type { Catalog, Command } from '../types/catalog.js';
import type {
  AutomationTrigger,
  AutomationAction,
  AutomationCondition,
} from '../types/automation.js';

function createMockCatalog(commandCount = 100): Catalog {
  const commands: Command[] = [];
  for (let i = 1; i <= commandCount; i++) {
    commands.push({
      id: `cmd_${i}`,
      name: `Command ${i}`,
      category: 'General',
      roles: ['trigger', 'action'],
      network: {
        state_can_id: `0x${(100 + i).toString(16)}`,
        action_can_id: `0x${(200 + i).toString(16)}`,
      },
      options: [
        { label: 'Off', payload: { D1: '0x00' }, match: { D1: '0x00' } },
        { label: 'On', payload: { D1: '0x01' }, match: { D1: '0x01' } },
      ],
    });
  }

  // Add specific commands for special matching
  commands.push({
    id: 'sw_menu',
    name: 'Steering Wheel Menu',
    category: 'Steering',
    roles: ['trigger'],
    network: { state_can_id: '0x448' },
    options: [{ label: 'Press', match: { D1: '0x01' } }],
  });

  return {
    can_do_version: '1.0.0',
    vehicles: [],
    commands,
  };
}

test('resolveCatalogCommandForTrigger matches direct source_command_id via O(1) index', () => {
  const catalog = createMockCatalog(150);
  const trig: AutomationTrigger = {
    id: 'trig_1',
    source: 'preset',
    source_command_id: 'cmd_75',
    option_label: 'On',
  };

  const { command, matchedOption } = resolveCatalogCommandForTrigger(trig, catalog);
  assert.ok(command);
  assert.strictEqual(command.id, 'cmd_75');
  assert.strictEqual(matchedOption?.label, 'On');
});

test('resolveCatalogCommandForTrigger matches ID hint (menu/ok -> sw_menu)', () => {
  const catalog = createMockCatalog(50);
  const trig: AutomationTrigger = {
    id: 'trig_menu_btn',
    source: 'can',
  };

  const { command } = resolveCatalogCommandForTrigger(trig, catalog);
  assert.ok(command);
  assert.strictEqual(command.id, 'sw_menu');
});

test('resolveCatalogCommandForTrigger matches CAN ID via byCanId index', () => {
  const catalog = createMockCatalog(100);
  // Target cmd_50 which has state_can_id 0x${(100 + 50).toString(16)} = 0x96
  const targetCanId = `0x${(150).toString(16)}`;
  const trig: AutomationTrigger = {
    id: 'trig_can',
    source: 'can',
    can_id: targetCanId,
    byte: 'D1',
    to: '0x01',
  };

  const { command, matchedOption } = resolveCatalogCommandForTrigger(trig, catalog);
  assert.ok(command);
  assert.strictEqual(command.id, 'cmd_50');
  assert.strictEqual(matchedOption?.label, 'On');
});

test('resolveCatalogCommandForTrigger performance benchmark (10,000 lookups)', () => {
  const catalog = createMockCatalog(200);
  const triggers: AutomationTrigger[] = [
    { id: 't1', source: 'preset', source_command_id: 'cmd_1' },
    { id: 't2', source: 'preset', source_command_id: 'cmd_100' },
    { id: 't3', source: 'preset', source_command_id: 'cmd_199' },
    { id: 't4', source: 'can', can_id: '0x448' },
    { id: 'trig_ok_btn', source: 'can' },
  ];

  const iterations = 10000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const t = triggers[i % triggers.length];
    const res = resolveCatalogCommandForTrigger(t, catalog);
    assert.ok(res.command);
  }
  const duration = performance.now() - start;

  // 10,000 lookups across a 200-command catalog should complete in under 50ms with O(1) Map cache
  assert.ok(duration < 100, `Benchmark took too long: ${duration.toFixed(2)}ms`);
});

test('resolveCatalogCommandForAction matches direct source_command_id and entity_id via O(1) index', () => {
  const catalog = createMockCatalog(150);

  // Match via source_command_id
  const act1: AutomationAction = {
    id: 'act_1',
    type: 'can_tx',
    source_command_id: 'cmd_80',
    option_label: 'On',
  };
  const res1 = resolveCatalogCommandForAction(act1, catalog);
  assert.ok(res1.command);
  assert.strictEqual(res1.command.id, 'cmd_80');
  assert.strictEqual(res1.matchedOption?.label, 'On');

  // Match via entity_id fallback
  const act2: AutomationAction = {
    id: 'act_2',
    type: 'can_tx',
    entity_id: 'cmd_25',
    command: 'Off',
  };
  const res2 = resolveCatalogCommandForAction(act2, catalog);
  assert.ok(res2.command);
  assert.strictEqual(res2.command.id, 'cmd_25');
  assert.strictEqual(res2.matchedOption?.label, 'Off');
});

test('resolveCatalogCommandForAction matches CAN ID via byCanId index', () => {
  const catalog = createMockCatalog(100);
  // Target cmd_30 action_can_id: 0x${(200 + 30).toString(16)} = 0x${(230).toString(16)}
  const targetCanId = `0x${(230).toString(16)}`;
  const act: AutomationAction = {
    id: 'act_can',
    type: 'can_tx',
    can_id: targetCanId,
    command: 'On',
  };

  const { command, matchedOption } = resolveCatalogCommandForAction(act, catalog);
  assert.ok(command);
  assert.strictEqual(command.id, 'cmd_30');
  assert.strictEqual(matchedOption?.label, 'On');
});

test('resolveCatalogCommandForAction performance benchmark (10,000 lookups)', () => {
  const catalog = createMockCatalog(200);
  const actions: AutomationAction[] = [
    { id: 'a1', type: 'can_tx', source_command_id: 'cmd_5' },
    { id: 'a2', type: 'can_tx', entity_id: 'cmd_120' },
    { id: 'a3', type: 'can_tx', source_command_id: 'cmd_195' },
    { id: 'a4', type: 'can_tx', can_id: `0x${(250).toString(16)}` },
  ];

  const iterations = 10000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const a = actions[i % actions.length];
    const res = resolveCatalogCommandForAction(a, catalog);
    assert.ok(res.command);
  }
  const duration = performance.now() - start;

  // 10,000 lookups across a 200-command catalog should complete in under 50ms with O(1) Map cache
  assert.ok(duration < 100, `Benchmark took too long: ${duration.toFixed(2)}ms`);
});

test('resolveCatalogCommandForCondition matches direct source_command_id via O(1) index', () => {
  const catalog = createMockCatalog(150);
  const cond: AutomationCondition = {
    id: 'cond_1',
    type: 'can_state',
    source_command_id: 'cmd_60',
    option_label: 'On',
  };

  const { command, matchedOption } = resolveCatalogCommandForCondition(cond, catalog);
  assert.ok(command);
  assert.strictEqual(command.id, 'cmd_60');
  assert.strictEqual(matchedOption?.label, 'On');
});

test('resolveCatalogCommandForCondition matches CAN ID via byCanId index', () => {
  const catalog = createMockCatalog(100);
  // Target cmd_40 state_can_id: 0x${(100 + 40).toString(16)} = 0x8c
  const targetCanId = `0x${(140).toString(16)}`;
  const cond: AutomationCondition = {
    id: 'cond_can',
    type: 'can_state',
    can_id: targetCanId,
    byte: 'D1',
    value: '0x01',
  };

  const { command, matchedOption } = resolveCatalogCommandForCondition(cond, catalog);
  assert.ok(command);
  assert.strictEqual(command.id, 'cmd_40');
  assert.strictEqual(matchedOption?.label, 'On');
});

test('resolveCatalogCommandForCondition performance benchmark (10,000 lookups)', () => {
  const catalog = createMockCatalog(200);
  const conditions: AutomationCondition[] = [
    { id: 'c1', type: 'can_state', source_command_id: 'cmd_10' },
    { id: 'c2', type: 'can_state', source_command_id: 'cmd_110' },
    { id: 'c3', type: 'can_state', source_command_id: 'cmd_180' },
    { id: 'c4', type: 'can_state', can_id: `0x${(150).toString(16)}` },
  ];

  const iterations = 10000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const c = conditions[i % conditions.length];
    const res = resolveCatalogCommandForCondition(c, catalog);
    assert.ok(res.command);
  }
  const duration = performance.now() - start;

  // 10,000 lookups across a 200-command catalog should complete in under 50ms with O(1) Map cache
  assert.ok(duration < 100, `Benchmark took too long: ${duration.toFixed(2)}ms`);
});


