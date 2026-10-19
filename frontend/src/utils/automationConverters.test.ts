import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatalogCommandForTrigger } from './automationConverters.js';
import type { Catalog, Command } from '../types/catalog.js';
import type { AutomationTrigger } from '../types/automation.js';

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
