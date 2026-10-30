import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileToByteMap,
  formatHexByte,
  resolveCatalogCommandForTrigger,
  resolveCatalogCommandForAction,
  resolveCatalogCommandForCondition,
  regenerateBranchIds,
  regenerateActionIds,
  cloneRuleWithNewIds,
  convertTriggerToCondition,
  convertConditionToTrigger,
  normalizeCanId,
  formatCanId,
  compileCondition,
  compileAction,
  compileAutomationRule,
  applyOptionsToCondition,
} from './automationConverters.js';
import type { Catalog, Command } from '../types/catalog.js';
import type {
  AutomationTrigger,
  AutomationAction,
  AutomationCondition,
  ChoiceBranch,
  AutomationRule,
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

  // 10,000 lookups across a 200-command catalog should complete in under 250ms with O(1) Map cache
  assert.ok(duration < 250, `Benchmark took too long: ${duration.toFixed(2)}ms`);
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

test('compileToByteMap returns empty object for undefined, null, or empty string', () => {
  assert.deepStrictEqual(compileToByteMap(undefined), {});
  assert.deepStrictEqual(compileToByteMap(''), {});
  assert.deepStrictEqual(compileToByteMap('   '), {});
});

test('compileToByteMap normalizes object ByteMap input and filters out wildcards', () => {
  const input = {
    D1: '0x12',
    D2: 'ab',
    D3: '0XCD',
    D4: '*',
    D5: '1*',
    D6: '?',
  };

  const expected = {
    D1: '0x12',
    D2: '0xAB',
    D3: '0xCD',
  };

  assert.deepStrictEqual(compileToByteMap(input), expected);
});

test('compileToByteMap parses space-separated hex payload strings into 1-based ByteMap', () => {
  const payload = '01 02 03 04 05 06 07 08';
  assert.deepStrictEqual(compileToByteMap(payload), {
    D1: '0x01',
    D2: '0x02',
    D3: '0x03',
    D4: '0x04',
    D5: '0x05',
    D6: '0x06',
    D7: '0x07',
    D8: '0x08',
  });
});

test('compileToByteMap skips wildcard tokens and clamps to maximum 8 bytes', () => {
  // * and ** and ?? are ignored, and tokens beyond 8th byte are ignored
  const payload = '* 0x20 * ** 0x50 ?? * 0xFF 0x99 0xAA';
  assert.deepStrictEqual(compileToByteMap(payload), {
    D2: '0x20',
    D5: '0x50',
    D8: '0xFF',
  });
});

test('compileToByteMap normalizes partial nibble wildcards by replacing * with 0', () => {
  // '1*' becomes '10', '0*' becomes '00'
  const payload = '* * 1* * * * 0* *';
  assert.deepStrictEqual(compileToByteMap(payload), {
    D3: '0x10',
    D7: '0x00',
  });
});

test('regenerateBranchIds regenerates all nested IDs when cloning a ChoiceBranch', () => {
  const original: ChoiceBranch = {
    _clientId: 'br_orig',
    label: 'Low Heat Step',
    conditions: [{ id: 'cond_1', _clientId: 'cond_c1', type: 'can_state', can_id: '0x123', value: '0x00' }],
    sequence: [{ id: 'act_1', _clientId: 'act_c1', type: 'can_tx', can_id: '0x4A2' }],
  };
  const cloned = regenerateBranchIds(original, true);
  assert.notStrictEqual(cloned._clientId, original._clientId);
  assert.strictEqual(cloned.label, 'Low Heat Step (Copy)');
  assert.notStrictEqual(cloned.conditions[0]._clientId, original.conditions[0]._clientId);
  assert.notStrictEqual(cloned.conditions[0].id, original.conditions[0].id);
  assert.notStrictEqual(cloned.sequence[0]._clientId, original.sequence[0]._clientId);
  assert.notStrictEqual(cloned.sequence[0].id, original.sequence[0].id);

  // Mutating clone does not mutate original
  cloned.conditions[0].value = '0x01';
  assert.strictEqual(original.conditions[0].value, '0x00');
});

test('regenerateActionIds recursively regenerates IDs inside a Choose action', () => {
  const chooseAction: AutomationAction = {
    id: 'act_root',
    _clientId: 'act_root_client',
    type: 'choose',
    choices: [
      {
        _clientId: 'br_1',
        label: 'Branch 1',
        conditions: [{ id: 'c_id_1', _clientId: 'c_1', type: 'can_state' }],
        sequence: [{ id: 'a_id_1', _clientId: 'a_1', type: 'delay', delay_ms: 100 }],
      },
    ],
    default: [{ id: 'def_id_1', _clientId: 'def_1', type: 'popup' }],
  };
  const cloned = regenerateActionIds(chooseAction);
  assert.notStrictEqual(cloned._clientId, 'act_root_client');
  assert.notStrictEqual(cloned.id, 'act_root');
  assert.notStrictEqual(cloned.choices![0]._clientId, 'br_1');
  assert.notStrictEqual(cloned.choices![0].conditions[0]._clientId, 'c_1');
  assert.notStrictEqual(cloned.choices![0].sequence[0]._clientId, 'a_1');
  assert.notStrictEqual(cloned.default![0]._clientId, 'def_1');
});

test('cloneRuleWithNewIds clones an entire rule with fresh IDs across all components', () => {
  const rule: AutomationRule = {
    id: 'seat_rule_1',
    name: 'Driver Seat Automation',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-heater',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [{ id: 'trig_1', _clientId: 'trig_c1', source: 'ble', ble_button: 'key_1' }],
    conditions: [{ id: 'cond_1', _clientId: 'cond_c1', type: 'can_state', can_id: '0x123' }],
    actions: [{ id: 'act_1', _clientId: 'act_c1', type: 'can_tx', can_id: '0x4A2' }],
  };
  const cloned = cloneRuleWithNewIds(rule);
  assert.notStrictEqual(cloned.id, 'seat_rule_1');
  assert.strictEqual(cloned.name, 'Driver Seat Automation (Copy)');
  assert.notStrictEqual(cloned.triggers[0].id, 'trig_1');
  assert.notStrictEqual(cloned.conditions[0].id, 'cond_1');
  assert.notStrictEqual(cloned.actions[0].id, 'act_1');
});

test('convertTriggerToCondition and convertConditionToTrigger correctly map cross-type fields', () => {
  const trigger: AutomationTrigger = {
    id: 'trig_btn',
    _clientId: 'trig_btn_client',
    source: 'ble',
    type: 'ble_button',
    ble_button: 'key_1',
    to: 'press'
  };
  const cond = convertTriggerToCondition(trigger);
  assert.strictEqual(cond.type, 'ble_button');
  assert.strictEqual(cond.ble_button, 'key_1');
  assert.strictEqual(cond.value, 'press');
  assert.notStrictEqual(cond.id, 'trig_btn');

  const backToTrig = convertConditionToTrigger(cond);
  assert.strictEqual(backToTrig.source, 'ble');
  assert.strictEqual(backToTrig.type, 'ble_button');
  assert.strictEqual(backToTrig.ble_button, 'key_1');
  assert.strictEqual(backToTrig.to, 'press');
  assert.notStrictEqual(backToTrig.id, cond.id);
});

test('normalizeCanId handles numbers, decimal strings, hex strings, and bare hex', () => {
  assert.strictEqual(normalizeCanId(1186), '0x4a2');
  assert.strictEqual(normalizeCanId('1186'), '0x4a2');
  assert.strictEqual(normalizeCanId('0x4A2'), '0x4a2');
  assert.strictEqual(normalizeCanId('0x4a2'), '0x4a2');
  assert.strictEqual(normalizeCanId('4A2'), '0x4a2');
  assert.strictEqual(normalizeCanId(null), '');
  assert.strictEqual(normalizeCanId(undefined), '');
  assert.strictEqual(normalizeCanId(''), '');
});

test('formatCanId formats numbers, decimal strings, and hex strings into canonical 0x... format', () => {
  assert.strictEqual(formatCanId(1186), '0x4A2');
  assert.strictEqual(formatCanId('1186'), '0x4A2');
  assert.strictEqual(formatCanId('0x4a2'), '0x4A2');
  assert.strictEqual(formatCanId('4a2'), '0x4A2');
  assert.strictEqual(formatCanId(null), '');
  assert.strictEqual(formatCanId(undefined), '');
});

test('resolveCatalogCommandForAction handles numeric can_id without throwing toLowerCase error', () => {
  const catalog = createMockCatalog(100);
  // Add a specific command with action_can_id 0x4A2 (which is 1186 decimal)
  catalog.commands.push({
    id: 'seat_vent',
    name: 'Seat Ventilation',
    category: 'Comfort',
    roles: ['action'],
    network: { action_can_id: '0x4A2' },
    options: [{ label: 'Low', payload: { D5: '0x3F' } }],
  });

  // Action has numeric can_id (e.g. 1186 from parsed JSON)
  const actWithNumericCanId = {
    id: 'act_test',
    type: 'can_tx',
    can_id: 1186 as any,
    payload: { D5: '0x3F' },
  } as AutomationAction;

  const res = resolveCatalogCommandForAction(actWithNumericCanId, catalog);
  assert.ok(res.command);
  assert.strictEqual(res.command.id, 'seat_vent');
  assert.strictEqual(res.matchedOption?.label, 'Low');
});

test('resolveCatalogCommandForTrigger handles numeric can_id without throwing toLowerCase error', () => {
  const catalog = createMockCatalog(100);
  catalog.commands.push({
    id: 'custom_trigger_btn',
    name: 'Custom Trigger Button',
    category: 'Steering',
    roles: ['trigger'],
    network: { state_can_id: '0x555' },
    options: [{ label: 'Press', match: { D1: '0x01' } }],
  });

  // 0x555 in decimal is 1365
  const trigWithNumericCanId = {
    id: 'trig_num',
    source: 'can',
    can_id: 1365 as any,
    byte: 'D1',
    to: '0x01',
  } as AutomationTrigger;

  const res = resolveCatalogCommandForTrigger(trigWithNumericCanId, catalog);
  assert.ok(res.command);
  assert.strictEqual(res.command.id, 'custom_trigger_btn');
});

test('resolveCatalogCommandForCondition handles numeric can_id and numeric value without throwing error', () => {
  const catalog = createMockCatalog(100);
  catalog.commands.push({
    id: 'custom_condition_cmd',
    name: 'Custom Condition Command',
    category: 'Drivetrain',
    roles: ['condition'],
    network: { state_can_id: '0x666' },
    options: [{ label: 'Active', match: { D1: '0x05' } }],
  });

  // 0x666 in decimal is 1638
  const condWithNumeric = {
    id: 'cond_num',
    can_id: 1638 as any,
    byte: 'D1',
    value: 5 as any,
  } as AutomationCondition;

  const res = resolveCatalogCommandForCondition(condWithNumeric, catalog);
  assert.ok(res.command);
  assert.strictEqual(res.command.id, 'custom_condition_cmd');
});

test('resolveCatalogCommandForAction correctly disambiguates seat actions from defogger on shared 0x4A2', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'climate_rear_defog',
        name: 'Rear Defogger & Heated Mirrors',
        category: 'Climate & Comfort',
        roles: ['action'],
        network: { action_can_id: '0x4A2', state_can_id: '0x541' },
        options: [
          {
            label: 'Defogger & Mirrors On',
            payload: { D1: '0x00', D2: '0x00', D3: '0xCF', D4: '0x03', D5: '0xFF', D6: '0xFF', D7: '0x00', D8: '0x00' },
            default: true,
          },
          {
            label: 'Defogger & Mirrors Off',
            payload: { D1: '0x00', D2: '0x00', D3: '0x0F', D4: '0x03', D5: '0xFF', D6: '0xFF', D7: '0x00', D8: '0x00' },
          },
        ],
      },
      {
        id: 'drivers_seat_comfort',
        name: 'Driver Seat Comfort',
        category: 'Climate & Comfort',
        roles: ['action'],
        network: { action_can_id: '0x4A2', state_can_id: '0x496' },
        options: [
          { label: 'Off', steps: [{ payload: { D5: '0x2F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'Low Heat', steps: [{ payload: { D5: '0x6F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'Medium Heat', steps: [{ payload: { D5: '0x7F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'High Heat', steps: [{ payload: { D5: '0x8F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'Low Cool', steps: [{ payload: { D5: '0x3F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'Medium Cool', steps: [{ payload: { D5: '0x4F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'High Cool', steps: [{ payload: { D5: '0x5F' } }, { payload: { D5: '0xFF' } }] },
        ],
      },
      {
        id: 'heated_steering_wheel_toggle',
        name: 'Heated Steering Wheel',
        category: 'Climate & Comfort',
        roles: ['action'],
        network: { action_can_id: '0x4A2', state_can_id: '0x418' },
        options: [
          { label: 'Heated Steering Wheel On', payload: { D1: '0x00', D2: '0x00', D3: '0x1F', D4: '0x03', D5: '0xFF', D6: '0xFF', D7: '0x00', D8: '0x00' } },
          { label: 'Heated Steering Wheel Off', payload: { D1: '0x00', D2: '0x00', D3: '0x0F', D4: '0x03', D5: '0xFF', D6: '0xFF', D7: '0x00', D8: '0x00' } },
        ],
      },
    ],
  };

  // Case 1: Action with label "Low Cool" on 0x4A2
  const act1: AutomationAction = {
    id: 'act_seat_1',
    type: 'can_tx',
    can_id: '0x4A2',
    command: 'Low Cool',
  };
  const res1 = resolveCatalogCommandForAction(act1, catalog);
  assert.strictEqual(res1.command?.id, 'drivers_seat_comfort');
  assert.strictEqual(res1.matchedOption?.label, 'Low Cool');

  // Case 2: Action with steps payload { D5: '0x3F' } on 0x4A2
  const act2: AutomationAction = {
    id: 'act_seat_2',
    type: 'can_tx',
    can_id: '0x4A2',
    steps: [
      { can_id: '0x4A2', bus: 0, payload: { D5: '0x3F' } },
      { can_id: '0x4A2', bus: 0, payload: { D5: '0xFF' } },
    ],
  };
  const res2 = resolveCatalogCommandForAction(act2, catalog);
  assert.strictEqual(res2.command?.id, 'drivers_seat_comfort');
  assert.strictEqual(res2.matchedOption?.label, 'Low Cool');

  // Case 3: Action with steps payload { D5: '0x6F' } on 0x4A2 (Low Heat)
  const act3: AutomationAction = {
    id: 'act_seat_3',
    type: 'can_tx',
    can_id: '0x4A2',
    steps: [
      { can_id: '0x4A2', bus: 0, payload: { D5: '0x6F' } },
    ],
  };
  const res3 = resolveCatalogCommandForAction(act3, catalog);
  assert.strictEqual(res3.command?.id, 'drivers_seat_comfort');
  assert.strictEqual(res3.matchedOption?.label, 'Low Heat');

  // Case 4: Action with singular alias "driver_seat_comfort" and command "Medium Heat"
  const act4: AutomationAction = {
    id: 'act_seat_4',
    type: 'can_tx',
    can_id: '0x4A2',
    entity_id: 'driver_seat_comfort',
    command: 'Medium Heat',
  };
  const res4 = resolveCatalogCommandForAction(act4, catalog);
  assert.strictEqual(res4.command?.id, 'drivers_seat_comfort');
  assert.strictEqual(res4.matchedOption?.label, 'Medium Heat');

  // Case 5: Genuine Defogger action with D3: 0xCF
  const act5: AutomationAction = {
    id: 'act_defog',
    type: 'can_tx',
    can_id: '0x4A2',
    payload: { D3: '0xCF' },
  };
  const res5 = resolveCatalogCommandForAction(act5, catalog);
  assert.strictEqual(res5.command?.id, 'climate_rear_defog');
  assert.strictEqual(res5.matchedOption?.label, 'Defogger & Mirrors On');

  // Case 6: Neutral/idle reset frame with only D5: 0xFF should NOT become Defogger
  const act6: AutomationAction = {
    id: 'act_idle',
    type: 'can_tx',
    can_id: '0x4A2',
    payload: { D5: '0xFF' },
  };
  const res6 = resolveCatalogCommandForAction(act6, catalog);
  assert.strictEqual(res6.command, undefined);

  // Case 7: Seat action with numeric decimal entries in steps (e.g. 63 and 255)
  const act7: AutomationAction = {
    id: 'act_seat_decimal',
    type: 'can_tx',
    can_id: '0x4A2',
    steps: [
      { can_id: '0x4A2', bus: 0, payload: { D5: 63 } as any },
      { can_id: '0x4A2', bus: 0, payload: { D5: 255 } as any },
    ],
  };
  const res7 = resolveCatalogCommandForAction(act7, catalog);
  assert.strictEqual(res7.command?.id, 'drivers_seat_comfort');
  assert.strictEqual(res7.matchedOption?.label, 'Low Cool');

  // Case 8: Seat action with single payload containing decimal integer (111 = 0x6F -> Low Heat)
  const act8: AutomationAction = {
    id: 'act_seat_heat_dec',
    type: 'can_tx',
    can_id: '0x4A2',
    payload: { D5: 111 } as any,
  };
  const res8 = resolveCatalogCommandForAction(act8, catalog);
  assert.strictEqual(res8.command?.id, 'drivers_seat_comfort');
  assert.strictEqual(res8.matchedOption?.label, 'Low Heat');
});

test('formatHexByte converts numbers and decimal strings into canonical hex bytes', () => {
  assert.strictEqual(formatHexByte(255), '0xFF');
  assert.strictEqual(formatHexByte(63), '0x3F');
  assert.strictEqual(formatHexByte(0), '0x00');
  assert.strictEqual(formatHexByte(15), '0x0F');
  assert.strictEqual(formatHexByte(111), '0x6F');
  assert.strictEqual(formatHexByte('0xff'), '0xFF');
  assert.strictEqual(formatHexByte('0X3F'), '0x3F');
  assert.strictEqual(formatHexByte('3F'), '0x3F');
  assert.strictEqual(formatHexByte('255'), '0xFF');
  assert.strictEqual(formatHexByte('0'), '0x00');
  assert.strictEqual(formatHexByte('00'), '0x00');
  assert.strictEqual(formatHexByte(undefined), undefined);
  assert.strictEqual(formatHexByte(null), undefined);
  assert.strictEqual(formatHexByte(''), undefined);
  assert.strictEqual(formatHexByte('*'), undefined);
  assert.strictEqual(formatHexByte('?'), undefined);
});

test('compileToByteMap converts numeric values and JSON object strings into clean ByteMap', () => {
  const numMap = compileToByteMap({ D5: 255, D6: 63, D7: 0 } as any);
  assert.deepStrictEqual(numMap, {
    D5: '0xFF',
    D6: '0x3F',
    D7: '0x00',
  });

  const lowercaseKeys = compileToByteMap({ d1: 255, d2: 15 } as any);
  assert.deepStrictEqual(lowercaseKeys, {
    D1: '0xFF',
    D2: '0x0F',
  });

  const jsonStr = compileToByteMap('{"D5": 255, "D6": 63}');
  assert.deepStrictEqual(jsonStr, {
    D5: '0xFF',
    D6: '0x3F',
  });
});

test('compileAction desugars cycle_entity into native choose action with sequential state transitions', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'seat_heater',
        name: 'Seat Heater',
        category: 'General',
        roles: ['action', 'condition'],
        network: { state_can_id: '0x4A2', action_can_id: '0x4A2' },
        options: [
          { label: 'Off', payload: { D1: '0x00' }, match: { D1: '0x00' } },
          { label: 'Low', payload: { D1: '0x01' }, match: { D1: '0x01' } },
          { label: 'High', payload: { D1: '0x02' }, match: { D1: '0x02' } },
        ],
      },
    ],
  };

  const cycleAct: AutomationAction = {
    id: 'act_cycle',
    type: 'cycle_entity',
    entity_id: 'seat_heater',
    states: ['Off', 'Low', 'High'],
    wrap: true,
    show_popup: false,
  };

  const compiled = compileAction(cycleAct, catalog);
  assert.strictEqual(compiled.type, 'choose');
  assert.strictEqual(compiled.choices.length, 3);

  // Branch 0: If Off -> Transmit Low
  assert.strictEqual(compiled.choices[0].conditions[0].value, '0x00');
  assert.strictEqual(compiled.choices[0].sequence[0].type, 'transmit');
  assert.deepStrictEqual(compiled.choices[0].sequence[0].payload, { D1: '0x01' });

  // Branch 1: If Low -> Transmit High
  assert.strictEqual(compiled.choices[1].conditions[0].value, '0x01');
  assert.strictEqual(compiled.choices[1].sequence[0].type, 'transmit');
  assert.deepStrictEqual(compiled.choices[1].sequence[0].payload, { D1: '0x02' });

  // Branch 2: If High -> Transmit Off (wrap)
  assert.strictEqual(compiled.choices[2].conditions[0].value, '0x02');
  assert.strictEqual(compiled.choices[2].sequence[0].type, 'transmit');
  assert.deepStrictEqual(compiled.choices[2].sequence[0].payload, { D1: '0x00' });

  // Default fallback -> Transmit Off
  assert.strictEqual(compiled.default[0].type, 'transmit');
  assert.deepStrictEqual(compiled.default[0].payload, { D1: '0x00' });
});

test('compileAction compiles climate_target preserving target_temp_c, defrost, and duration_minutes', () => {
  const climAct: AutomationAction = {
    id: 'act_clim',
    type: 'climate_target',
    target_temp_c: 21.5,
    defrost: true,
    duration_minutes: 25,
    zone: 'driver',
  };

  const compiled = compileAction(climAct);
  assert.strictEqual(compiled.type, 'climate_target');
  assert.strictEqual(compiled.target_temp_c, 21.5);
  assert.strictEqual(compiled.defrost, true);
  assert.strictEqual(compiled.duration_minutes, 25);
  assert.strictEqual(compiled.zone, 'driver');
});

test('compileCondition compiles voltage condition with operator and float value', () => {
  const voltCond: AutomationCondition = {
    id: 'cond_volt',
    type: 'voltage',
    operator: 'less',
    value: '11.8',
  };

  const compiled = compileCondition(voltCond);
  assert.strictEqual(compiled.type, 'voltage');
  assert.strictEqual(compiled.operator, 'less');
  assert.strictEqual(compiled.value, 11.8);
});

test('applyOptionsToCondition groups same-byte conflicting options into an OR logic group during compilation', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'seat_heater',
        name: 'Seat Heater',
        category: 'General',
        roles: ['action', 'condition'],
        network: { state_can_id: '0x4A2' },
        options: [
          { label: 'Off', match: { D1: '0x00' } },
          { label: 'Low Heat', match: { D1: '0x01' } },
          { label: 'Med Heat', match: { D1: '0x02' } },
        ],
      },
    ],
  };

  const baseCond: AutomationCondition = {
    id: 'cond_multi',
    type: 'can_state',
  };

  // User selects both 'Low Heat' and 'Med Heat' (both match on D1)
  const multiCond = applyOptionsToCondition(
    baseCond,
    catalog.commands[0],
    [catalog.commands[0].options![1], catalog.commands[0].options![2]]
  );

  assert.strictEqual(multiCond.option_label, 'Low Heat or Med Heat');
  assert.deepStrictEqual(multiCond.selected_options, ['Low Heat', 'Med Heat']);

  const compiled = compileCondition(multiCond, catalog);
  assert.ok(compiled.or, 'Expected compiled condition to have an or property');
  assert.strictEqual(compiled.or.length, 2);
  assert.strictEqual(compiled.or[0].value, '0x01');
  assert.strictEqual(compiled.or[1].value, '0x02');
});
