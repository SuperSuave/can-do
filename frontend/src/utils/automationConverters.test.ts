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
  compileActionList,
  compileAutomationRule,
  decompileCondition,
  decompileActionList,
  decompileAutomationRule,
  decompileAutomationRules,
  exportToCandoJson,
  commandToTrigger,
  commandToCondition,
  commandToAction,
  applyOptionToTrigger,
  applyOptionToAction,
  applyOptionToCondition,
  applyOptionsToCondition,
  applyEffectToAction,
  formatDefaultTriggerName,
  resolveActionBus,
} from './automationConverters.js';
import type { Catalog, Command, Vehicle } from '../types/catalog.js';
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

test('compileToByteMap parses continuous hex payload strings into 1-based ByteMap', () => {
  const payload16 = 'D0C1751500000000';
  assert.deepStrictEqual(compileToByteMap(payload16), {
    D1: '0xD0',
    D2: '0xC1',
    D3: '0x75',
    D4: '0x15',
    D5: '0x00',
    D6: '0x00',
    D7: '0x00',
    D8: '0x00',
  });

  const payloadCommit = '0002082000000000';
  assert.deepStrictEqual(compileToByteMap(payloadCommit), {
    D1: '0x00',
    D2: '0x02',
    D3: '0x08',
    D4: '0x20',
    D5: '0x00',
    D6: '0x00',
    D7: '0x00',
    D8: '0x00',
  });
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

test('normalizeCanId handles decimal numbers and hex strings matching firmware parser.cpp', () => {
  assert.strictEqual(normalizeCanId(1186), '0x4a2');
  assert.strictEqual(normalizeCanId('1186'), '0x1186');
  assert.strictEqual(normalizeCanId('448'), '0x448');
  assert.strictEqual(normalizeCanId('0x4A2'), '0x4a2');
  assert.strictEqual(normalizeCanId('0x4a2'), '0x4a2');
  assert.strictEqual(normalizeCanId('4A2'), '0x4a2');
  assert.strictEqual(normalizeCanId(-1), '');
  assert.strictEqual(normalizeCanId(0x20000000), '');
  assert.strictEqual(normalizeCanId(null), '');
  assert.strictEqual(normalizeCanId(undefined), '');
  assert.strictEqual(normalizeCanId(''), '');
});

test('formatCanId formats decimal numbers (0..0x1FFFFFFF) and base-16 hex strings into canonical 0x... format', () => {
  assert.strictEqual(formatCanId(1186), '0x4A2');
  assert.strictEqual(formatCanId(0x1FFFFFFF), '0x1FFFFFFF');
  assert.strictEqual(formatCanId(0), '0x0');
  assert.strictEqual(formatCanId(-1), '');
  assert.strictEqual(formatCanId(1.5), '');
  assert.strictEqual(formatCanId(0x20000000), '');
  assert.strictEqual(formatCanId('448'), '0x448');
  assert.strictEqual(formatCanId('1186'), '0x1186');
  assert.strictEqual(formatCanId('0x4a2'), '0x4A2');
  assert.strictEqual(formatCanId('4a2'), '0x4A2');
  assert.strictEqual(formatCanId('0x20000000'), '');
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

test('compileAction compiles cycle_entity into compact native Option B action object', () => {
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
    direction: 'forward',
    wrap: true,
    fallback_state: '__first__',
    show_popup: false,
  };

  const compiled = compileAction(cycleAct, catalog);
  assert.strictEqual(compiled.type, 'cycle_entity');
  assert.strictEqual(compiled.entity_id, 'seat_heater');
  assert.deepStrictEqual(compiled.states, ['Off', 'Low', 'High']);
  assert.strictEqual(compiled.direction, 'forward');
  assert.strictEqual(compiled.wrap, true);
  assert.strictEqual(compiled.fallback_state, '__first__');
  assert.strictEqual(compiled.show_popup, false);
  assert.strictEqual(compiled.level, 'info');
  assert.strictEqual(compiled.choices, undefined);
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



test('resolveCatalogCommandForAction and applyOptionToAction properly handle ambient_mood_lighting continuous hex steps and Mood Light Off', () => {

  const catalog: Catalog = {

    can_do_version: '1.0.0',

    vehicles: [],

    commands: [

      {

        id: 'ambient_mood_lighting',

        name: 'Ambient Mood Lighting',

        category: 'Lighting',

        roles: ['action'],

        network: { action_can_id: '0x4AD', state_can_id: '0x3C6', delay_ms: 25 },

        options: [

          {

            label: 'Mood Light Off',

            steps: [

              { payload: '0000000000000000', repeat: 2, delay_ms: 25 },

              { payload: '0002082000000000', repeat: 2, delay_ms: 0 }

            ]

          },

          {

            label: 'Color 8: Pure Cyan / Aqua Wave',

            steps: [

              { payload: 'EB02371700000000', repeat: 2, delay_ms: 25 },

              { payload: '0002082000000000', repeat: 2, delay_ms: 0 }

            ]

          }

        ]

      }

    ]

  };



  // 1. Selecting Mood Light Off should not mismatch because of Stage 2 latch 0002082000000000

  const offAct: AutomationAction = {

    id: 'act_off',

    type: 'can_tx',

    can_id: '0x4AD',

    entity_id: 'ambient_mood_lighting',

    option_label: 'Mood Light Off',

    command: 'Mood Light Off',

    steps: [

      { can_id: '0x4AD', bus: 0, payload: compileToByteMap('0000000000000000'), repeat: 2, delay_ms: 25 },

      { can_id: '0x4AD', bus: 0, payload: compileToByteMap('0002082000000000'), repeat: 2, delay_ms: 0 }

    ]

  };

  const resolvedOff = resolveCatalogCommandForAction(offAct, catalog);

  assert.strictEqual(resolvedOff.command?.id, 'ambient_mood_lighting');

  assert.strictEqual(resolvedOff.matchedOption?.label, 'Mood Light Off');



  // 2. Compiling 2-stage ambient mood lighting on 0x4AD
  const ambientAct: AutomationAction = {
    id: 'act_ambient',
    type: 'can_tx',
    can_id: '0x4AD',
    entity_id: 'ambient_mood_lighting',
    option_label: 'Color 8: Pure Cyan / Aqua Wave',
    command: 'Color 8: Pure Cyan / Aqua Wave',
    steps: [
      { can_id: '0x4AD', bus: 0, payload: compileToByteMap('00FFFF0400000000'), repeat: 2, delay_ms: 25 },
      { can_id: '0x4AD', bus: 0, payload: compileToByteMap('0002082000000000'), repeat: 2, delay_ms: 0 }
    ]
  };
  const compiledAmbient = compileAction(ambientAct, catalog);
  assert.ok(Array.isArray(compiledAmbient));
  const frames4ad = compiledAmbient.filter((s: any) => s.type === 'transmit' && s.can_id === '0x4AD');
  assert.strictEqual(frames4ad.length, 2);
  assert.strictEqual(frames4ad[0].payload.D1, '0x00');
  assert.strictEqual(frames4ad[0].payload.D2, '0xFF');
});


test('compileAutomationRule and compileCondition properly serialize ble_presence and ble_beacon with present and away', () => {
  const catalog = createMockCatalog(10);

  // 1. Walk-Away trigger compilation preserves ble_beacon type and away event
  const awayRule: AutomationRule = {
    id: 'rule_away',
    name: 'Walk-Away Rule',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-door-lock',
    exec_mode: 'one_shot',
    cooldown_ms: 1000,
    triggers: [
      {
        id: 'trig_away',
        source: 'ble',
        type: 'ble_presence',
        ble_event: 'away',
        beacon_uuid: 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825',
        beacon_major: 100,
        beacon_minor: 1,
        target_rssi: -75
      }
    ],
    conditions: [
      {
        id: 'cond_away',
        type: 'ble_presence',
        device_property: 'away',
        beacon_uuid: 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825',
        target_bool: false,
        target_rssi: -75
      }
    ],
    actions: []
  };

  const compiled = compileAutomationRule(awayRule, catalog);
  assert.strictEqual(compiled.triggers.length, 1);
  assert.strictEqual(compiled.triggers[0].type, 'ble_beacon');
  assert.strictEqual(compiled.triggers[0].ble_event, 'away');
  assert.strictEqual(compiled.triggers[0].beacon_uuid, 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825');
  assert.strictEqual(compiled.triggers[0].beacon_major, 100);
  assert.strictEqual(compiled.triggers[0].beacon_minor, 1);
  assert.strictEqual(compiled.triggers[0].target_rssi, -75);

  assert.strictEqual(compiled.conditions.length, 1);
  assert.strictEqual(compiled.conditions[0].type, 'ble_beacon');
  assert.strictEqual(compiled.conditions[0].device_property, 'away');
  assert.strictEqual(compiled.conditions[0].beacon_uuid, 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825');
  assert.strictEqual(compiled.conditions[0].target_bool, false);

  // 2. Cross conversion
  const convertedCond = convertTriggerToCondition(awayRule.triggers[0]);
  assert.strictEqual(convertedCond.type, 'ble_presence');
  assert.strictEqual(convertedCond.device_property, 'away');
  assert.strictEqual(convertedCond.target_bool, false);

  const convertedTrig = convertConditionToTrigger(convertedCond);
  assert.strictEqual(convertedTrig.type, 'ble_presence');
  assert.strictEqual(convertedTrig.ble_event, 'away');
});

test('compileAutomationRule and decompileAutomationRule preserve multi-step catalog commands as a single unified action across push/pull', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'drivers_seat_comfort',
        name: 'Driver Seat Comfort',
        category: 'Climate & Comfort',
        roles: ['action'],
        network: { action_can_id: '0x4A2', state_can_id: '0x496', delay_ms: 20 },
        options: [
          { label: 'Medium Cool', steps: [{ payload: { D5: '0x4F' }, repeat: 3 }, { payload: { D5: '0xFF' }, repeat: 1 }] },
          { label: 'High Heat', steps: [{ payload: { D5: '0x8F' }, repeat: 3 }, { payload: { D5: '0xFF' }, repeat: 1 }] }
        ]
      },
      {
        id: 'ambient_mood_lighting',
        name: 'Ambient Mood Lighting',
        category: 'Lighting',
        roles: ['action'],
        network: { action_can_id: '0x4AD', state_can_id: '0x3C6', delay_ms: 25 },
        options: [
          {
            label: 'Color 8: Pure Cyan / Aqua Wave',
            steps: [
              { payload: '00FFFF0400000000', repeat: 2, delay_ms: 25 },
              { payload: '0002082000000000', repeat: 2, delay_ms: 0 }
            ]
          }
        ]
      }
    ]
  };

  const seatAction = commandToAction(catalog.commands[0], catalog.commands[0].options![0]);
  const ambientAction = commandToAction(catalog.commands[1], catalog.commands[1].options![0]);

  const rule: AutomationRule = {
    id: 'rule_multistep_roundtrip',
    name: 'Comfort & Lighting Combo',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-cooler',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [{ id: 'trig_1', source: 'can', can_id: '0x448', byte: 'D7', from: '0x00', to: '0x10', mask: '0xF0' }],
    conditions: [],
    actions: [seatAction, ambientAction]
  };

  // 1. Compile for ESP32 automations.json: steps are flattened for C++ firmware execution
  const compiled = compileAutomationRule(rule, catalog);
  // seatAction (2 transmits + 1 delay = 3) + ambientAction (2 0x4AD transmits + 1 delay = 3) = 6 flat items
  assert.strictEqual(compiled.actions.length, 6);

  // 2. Decompile when pulled back from ESP32 or imported: must coalesce back into 2 unified actions!
  const decompiled = decompileAutomationRule(compiled, catalog);
  assert.strictEqual(decompiled.actions.length, 2);

  assert.strictEqual(decompiled.actions[0].source_command_id, 'drivers_seat_comfort');
  assert.strictEqual(decompiled.actions[0].option_label, 'Medium Cool');
  assert.strictEqual(decompiled.actions[0].steps?.length, 2);
  assert.deepStrictEqual(decompiled.actions[0].steps?.[0].payload, { D5: '0x4F' });
  assert.deepStrictEqual(decompiled.actions[0].steps?.[1].payload, { D5: '0xFF' });

  assert.strictEqual(decompiled.actions[1].source_command_id, 'ambient_mood_lighting');
  assert.strictEqual(decompiled.actions[1].option_label, 'Color 8: Pure Cyan / Aqua Wave');
  assert.strictEqual(decompiled.actions[1].steps?.length, 2);
  assert.strictEqual((decompiled.actions[1].steps?.[0].payload as any).D1, '0x00');
  assert.strictEqual((decompiled.actions[1].steps?.[1].payload as any).D4, '0x20');
});

test('decompileAutomationRule coalesces legacy untagged flattened actions and cleans up duplicate orphaned release steps', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'drivers_seat_comfort',
        name: 'Driver Seat Comfort',
        category: 'Climate & Comfort',
        roles: ['action'],
        network: { action_can_id: '0x4A2', state_can_id: '0x496', delay_ms: 20 },
        options: [
          { label: 'Medium Cool', steps: [{ payload: { D5: '0x4F' }, repeat: 3 }, { payload: { D5: '0xFF' }, repeat: 1 }] }
        ]
      }
    ]
  };

  // Simulate a legacy automations.json rule without _step_group_id that also suffered duplicate orphaned [delay, transmit(0xFF)] from prior push/pull cycles
  const legacyFlattenedRule = {
    id: 'rule_legacy_broken',
    name: 'Legacy Broken Seat Rule',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-cooler',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [{ id: 'trig_1', type: 'byte_transition', can_id: '0x448', bus: 0, byte: 'D7', mask: '0xF0', from: '0x00', to: '0x10' }],
    conditions: [],
    actions: [
      {
        type: 'transmit',
        can_id: '0x4A2',
        bus: 0,
        payload: { D5: '0x4F' },
        repeat: 3,
        source_command_id: 'drivers_seat_comfort',
        source_command_name: 'Driver Seat Comfort',
        option_label: 'Medium Cool',
        entity_id: 'drivers_seat_comfort'
      },
      { type: 'delay', ms: 20 },
      { type: 'transmit', can_id: '0x4A2', bus: 0, payload: { D5: '0xFF' }, repeat: 1 },
      // Orphaned duplicate release step from an earlier edit/re-push cycle
      { type: 'delay', ms: 20 },
      { type: 'transmit', can_id: '0x4A2', bus: 0, payload: { D5: '0xFF' }, repeat: 1 },
      { type: 'track_popup', level: 'info', text: 'Seat Cool Med' }
    ]
  };

  const decompiled = decompileAutomationRule(legacyFlattenedRule, catalog);
  assert.strictEqual(decompiled.actions.length, 2);
  assert.strictEqual(decompiled.actions[0].type, 'can_tx');
  assert.strictEqual(decompiled.actions[0].source_command_id, 'drivers_seat_comfort');
  assert.strictEqual(decompiled.actions[0].option_label, 'Medium Cool');
  assert.strictEqual(decompiled.actions[0].steps?.length, 2);
  assert.strictEqual(decompiled.actions[1].type, 'track_popup');
  assert.strictEqual(decompiled.actions[1].text, 'Seat Cool Med');
});

test('decompileActionList preserves cycle_entity and nested choose/if_then multi-step sequences across compilation', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'drivers_seat_comfort',
        name: 'Driver Seat Comfort',
        category: 'Climate & Comfort',
        roles: ['action', 'condition'],
        network: { action_can_id: '0x4A2', state_can_id: '0x496', delay_ms: 20 },
        options: [
          { label: 'Off', match: { D3: '0x00' }, steps: [{ payload: { D5: '0x2F' } }, { payload: { D5: '0xFF' } }] },
          { label: 'Low Cool', match: { D3: '0x01' }, steps: [{ payload: { D5: '0x3F' } }, { payload: { D5: '0xFF' } }] }
        ]
      }
    ]
  };

  const cycleAct: AutomationAction = {
    id: 'act_cycle_seat',
    type: 'cycle_entity',
    entity_id: 'drivers_seat_comfort',
    states: ['Off', 'Low Cool'],
    wrap: true,
    show_popup: true,
    popup_prefix: 'Seat: '
  };

  const chooseAct: AutomationAction = {
    id: 'act_choose_seat',
    type: 'choose',
    choices: [
      {
        _clientId: 'br_1',
        label: 'Turn On Cool',
        conditions: [],
        sequence: [commandToAction(catalog.commands[0], catalog.commands[0].options![1])]
      }
    ],
    default: [commandToAction(catalog.commands[0], catalog.commands[0].options![0])]
  };

  const compiledList = compileActionList([cycleAct, chooseAct], catalog);
  const decompiledList = decompileActionList(compiledList, catalog);

  assert.strictEqual(decompiledList.length, 2);
  assert.strictEqual(decompiledList[0].type, 'cycle_entity');
  assert.strictEqual(decompiledList[0].entity_id, 'drivers_seat_comfort');
  assert.deepStrictEqual(decompiledList[0].states, ['Off', 'Low Cool']);

  assert.strictEqual(decompiledList[1].type, 'choose');
  assert.strictEqual(decompiledList[1].choices?.[0].label, 'Turn On Cool');
  assert.strictEqual(decompiledList[1].choices?.[0].sequence.length, 1);
  assert.strictEqual(decompiledList[1].choices?.[0].sequence[0].option_label, 'Low Cool');
  assert.strictEqual(decompiledList[1].choices?.[0].sequence[0].steps?.length, 2);
  assert.strictEqual(decompiledList[1].default?.length, 1);
  assert.strictEqual(decompiledList[1].default?.[0].option_label, 'Off');
  assert.strictEqual(decompiledList[1].default?.[0].steps?.length, 2);
});

test('compileAutomationRule and decompileAutomationRule preserve hold_beep and BLE hold/tap actions', () => {
  const catalog: Catalog = { can_do_version: '1.0', vehicles: [], commands: [] };
  const rule: AutomationRule = {
    id: 'ble_hold_rule',
    name: 'BLE Hold Rule',
    enabled: true,
    ha_expose: true,
    hold_beep: true,
    ha_icon: 'mdi:bluetooth',
    exec_mode: 'one_shot',
    cooldown_ms: 0,
    triggers: [
      { id: 't1', source: 'ble', type: 'ble_button', ble_button: 'key_1+key_2', ble_action: 'hold_2s' },
      { id: 't2', source: 'ble', type: 'ble_button', ble_button: 'key_3', ble_action: 'tap' }
    ],
    conditions: [
      { id: 'c1', type: 'ble_button', ble_button: 'key_1+key_2', ble_action: 'hold_3s' }
    ],
    actions: []
  };

  const compiled = compileAutomationRule(rule, catalog);
  assert.strictEqual(compiled.hold_beep, true);
  assert.strictEqual(compiled.triggers[0].ble_button, 'key_1+key_2');
  assert.strictEqual(compiled.triggers[0].ble_action, 'hold_2s');
  assert.strictEqual(compiled.triggers[1].ble_action, 'tap');
  assert.strictEqual(compiled.conditions[0].ble_action, 'hold_3s');

  const decompiled = decompileAutomationRule(compiled, catalog);
  assert.strictEqual(decompiled.hold_beep, true);
  assert.strictEqual(decompiled.triggers[0].ble_action, 'hold_2s');
  assert.strictEqual(decompiled.triggers[1].ble_action, 'tap');
  assert.strictEqual(decompiled.conditions[0].ble_action, 'hold_3s');
});

test('compileAutomationRule and decompileAutomationRule preserve sustained for_sec across triggers and conditions', () => {
  const catalog: Catalog = { can_do_version: '1.0', vehicles: [], commands: [] };
  const rule: AutomationRule = {
    id: 'sustained_rule',
    name: 'Sustained State Rule',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:timer',
    exec_mode: 'one_shot',
    cooldown_ms: 0,
    triggers: [
      {
        id: 't_can',
        source: 'can',
        type: 'byte_transition',
        can_id: '0x120',
        byte: 'D1',
        mask: '0xFF',
        from: '0x00',
        to: '0x01',
        for_sec: 300
      },
      {
        id: 't_beacon',
        source: 'ble',
        type: 'ble_presence',
        ble_event: 'away',
        beacon_uuid: '46BC57C2-8FB0-4C2C-A13E-30F00B387701',
        for_sec: 120
      }
    ],
    conditions: [
      {
        id: 'c_can',
        type: 'can_state',
        can_id: '0x226',
        byte: 'D2',
        mask: '0x0F',
        operator: 'equal',
        value: '0x00',
        for_sec: 60
      },
      {
        id: 'c_and',
        logic: 'and',
        for_sec: 15,
        conditions: [
          {
            id: 'c_wifi',
            type: 'device_state',
            device_property: 'wifi_connected',
            target_bool: false
          }
        ]
      }
    ],
    actions: []
  };

  const compiled = compileAutomationRule(rule, catalog);
  assert.strictEqual(compiled.triggers[0].for_sec, 300);
  assert.strictEqual(compiled.triggers[1].for_sec, 120);
  assert.strictEqual(compiled.conditions[0].for_sec, 60);
  assert.strictEqual(compiled.conditions[1].for_sec, 15);
  assert.strictEqual(compiled.conditions[1].and[0].device_property, 'wifi_connected');

  const decompiled = decompileAutomationRule(compiled, catalog);
  assert.strictEqual(decompiled.triggers[0].for_sec, 300);
  assert.strictEqual(decompiled.triggers[1].for_sec, 120);
  assert.strictEqual(decompiled.conditions[0].for_sec, 60);
  assert.strictEqual(decompiled.conditions[1].for_sec, 15);

  const condFromTrig = convertTriggerToCondition(decompiled.triggers[0]);
  assert.strictEqual(condFromTrig.for_sec, 300);
  const trigFromCond = convertConditionToTrigger(condFromTrig);
  assert.strictEqual(trigFromCond.for_sec, 300);
});

test('param_range commands convert cleanly to trigger, condition, and action and disambiguate shared CAN IDs', () => {
  const driverTemp: Command = {
    id: 'climate_driver_temp',
    name: 'Driver Cabin Target Temperature',
    ha_metadata: { name: 'Driver Cabin Target Temperature', domain: 'climate', icon: 'mdi:thermometer' },
    type: 'param_range',
    category: 'Climate & Comfort',
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
  };

  const passengerTemp: Command = {
    id: 'climate_passenger_temp',
    name: 'Passenger Cabin Target Temperature',
    ha_metadata: { name: 'Passenger Cabin Target Temperature', domain: 'climate', icon: 'mdi:thermometer' },
    type: 'param_range',
    category: 'Climate & Comfort',
    roles: ['trigger', 'condition', 'action'],
    network: {
      bus: 0,
      type: 'can_rx_tx',
      state_can_id: '0x380',
      action_can_id: '0x4A0',
      state_byte: 'D3',
      action_byte: 'D8',
      min: 62,
      max: 82,
      step: 1,
      unit: '°F',
      raw_min: '0x06',
      raw_max: '0x1A',
      delay_ms: 20,
    },
  };

  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [driverTemp, passengerTemp],
  };

  // Defaults to 70°F (0x0E) on the correct state_byte / action_byte
  const trigDriver = commandToTrigger(driverTemp);
  assert.strictEqual(trigDriver.can_id, '0x380');
  assert.strictEqual(trigDriver.byte, 'D2');
  assert.strictEqual(trigDriver.to, '0x0E');
  assert.strictEqual(trigDriver.mask, '0xFF');
  assert.strictEqual(trigDriver.option_label, '70°F');

  const condPassenger = commandToCondition(passengerTemp);
  assert.strictEqual(condPassenger.can_id, '0x380');
  assert.strictEqual(condPassenger.byte, 'D3');
  assert.strictEqual(condPassenger.value, '0x0E');
  assert.strictEqual(condPassenger.mask, '0xFF');
  assert.strictEqual(condPassenger.option_label, '70°F');

  const actDriver = commandToAction(driverTemp);
  assert.strictEqual(actDriver.can_id, '0x4A0');
  assert.deepStrictEqual(actDriver.payload, { D2: '0x0E' });
  assert.strictEqual(actDriver.option_label, '70°F');

  const actPassenger = commandToAction(passengerTemp);
  assert.strictEqual(actPassenger.can_id, '0x4A0');
  assert.deepStrictEqual(actPassenger.payload, { D8: '0x0E' });

  // Disambiguation without source_command_id (using shared CAN ID + byte position)
  const resolvedTrigPass = resolveCatalogCommandForTrigger(
    { id: 't_pass', source: 'can', type: 'byte_transition', can_id: '0x380', byte: 'D3', to: '0x10' },
    catalog
  );
  assert.strictEqual(resolvedTrigPass.command?.id, 'climate_passenger_temp');

  const resolvedCondDriver = resolveCatalogCommandForCondition(
    { id: 'c_drv', type: 'can_state', can_id: '0x380', byte: 'D2', operator: 'greater_than', value: '0x10' },
    catalog
  );
  assert.strictEqual(resolvedCondDriver.command?.id, 'climate_driver_temp');

  const resolvedActPass = resolveCatalogCommandForAction(
    { id: 'a_pass', type: 'can_tx', can_id: '0x4A0', payload: { D8: '0x10' } },
    catalog
  );
  assert.strictEqual(resolvedActPass.command?.id, 'climate_passenger_temp');

  // Compile rule preserves trigger relational operator and param_range condition fields
  const compiled = compileAutomationRule(
    {
      id: 'rule_range',
      name: 'Temp Rule',
      enabled: true,
      ha_expose: false,
      ha_icon: 'mdi:thermometer',
      exec_mode: 'one_shot',
      trigger_mode: 'any',
      cooldown_ms: 500,
      triggers: [
        {
          ...trigDriver,
          operator: 'greater_than',
          value: '0x12',
          to: '0x12',
        },
      ],
      conditions: [
        {
          ...condPassenger,
          type: 'param_range',
          operator: 'less_than_or_equal',
          value: '0x14',
        },
      ],
      actions: [actPassenger],
    },
    catalog
  );

  assert.strictEqual(compiled.triggers[0].type, 'byte_transition');
  assert.strictEqual(compiled.triggers[0].byte, 'D2');
  assert.strictEqual(compiled.triggers[0].mask, '0xFF');
  assert.strictEqual(compiled.triggers[0].to, '0x12');
  assert.strictEqual(compiled.triggers[0].operator, 'greater_than');

  assert.strictEqual(compiled.conditions[0].can_id, '0x380');
  assert.strictEqual(compiled.conditions[0].byte, 'D3');
  assert.strictEqual(compiled.conditions[0].mask, '0xFF');
  assert.strictEqual(compiled.conditions[0].operator, 'less_than_or_equal');
  assert.strictEqual(compiled.conditions[0].value, '0x14');

  assert.strictEqual(compiled.actions[0].type, 'transmit');
  assert.strictEqual(compiled.actions[0].can_id, '0x4A0');
  assert.deepStrictEqual(compiled.actions[0].payload, { D8: '0x0E' });

  // entity_command action on param_range without explicit options compiles from physical label
  const compiledEntityCmd = compileAction(
    {
      id: 'a_ent',
      type: 'entity_command',
      entity_id: 'climate_driver_temp',
      command: '75°F',
    },
    catalog
  );
  assert.strictEqual(compiledEntityCmd.type, 'transmit');
  assert.strictEqual(compiledEntityCmd.can_id, '0x4A0');
  assert.deepStrictEqual(compiledEntityCmd.payload, { D2: '0x13' }); // 0x06 + (75 - 62) = 19 = 0x13
});

test('Button triggers support single, double, and triple press (click_count: 1, 2, 3) across CAN and BLE', () => {
  const catalog = createMockCatalog(10);
  const starCmd = {
    id: 'sw_star',
    name: 'Steering Wheel Star Button',
    category: 'Steering Wheel & Controls',
    subcategory: 'steering_wheel_buttons',
    roles: ['trigger'] as ('trigger' | 'condition' | 'action')[],
    ha_metadata: { name: 'Star Button', domain: 'event' },
    network: { state_can_id: '0x448', bus: 0 },
    options: [
      { label: 'Pressed', match: { D8: '0x02' }, mask: '0x02', default: true },
      { label: 'Released', match: { D8: '0x00' }, mask: '0x02' },
    ],
  };
  catalog.commands.push(starCmd);

  const singleTrig = commandToTrigger(starCmd, starCmd.options[0]);
  assert.strictEqual(singleTrig.click_count, 1);

  const doubleTrig: AutomationTrigger = {
    ...singleTrig,
    id: 'trig_star_2x',
    click_count: 2,
    for_sec: 2,
    for_ms: 500,
  };

  const tripleBleTrig: AutomationTrigger = {
    id: 'trig_ble_3x',
    type: 'ble_button',
    source: 'ble',
    ble_button: 'volume_up',
    ble_action: 'press',
    click_count: 3,
  };

  const compiled = compileAutomationRule(
    {
      id: 'rule_multipress',
      name: 'Multi-Press Test',
      enabled: true,
      ha_expose: true,
      ha_icon: 'mdi:gesture-double-tap',
      exec_mode: 'one_shot',
      trigger_mode: 'any',
      cooldown_ms: 500,
      triggers: [singleTrig, doubleTrig, tripleBleTrig],
      conditions: [],
      actions: [],
    },
    catalog
  );

  // Single press omits click_count in compiled output for compact JSON
  assert.strictEqual(compiled.triggers[0].click_count, undefined);
  // Double press preserves click_count=2 and strips sustained hold fields
  assert.strictEqual(compiled.triggers[1].click_count, 2);
  assert.strictEqual(compiled.triggers[1].for_sec, undefined);
  assert.strictEqual(compiled.triggers[1].for_ms, undefined);
  // Triple BLE press preserves click_count=3
  assert.strictEqual(compiled.triggers[2].click_count, 3);
  assert.strictEqual(compiled.triggers[2].ble_button, 'volume_up');

  // Decompile restores click_count and normalizes legacy ble_action='double_press'
  const decompiled = decompileAutomationRule(
    {
      ...compiled,
      triggers: [
        ...compiled.triggers,
        { id: 'trig_ble_legacy', type: 'ble_button', ble_button: 'play', ble_action: 'double_press' },
      ],
    },
    catalog
  );

  assert.strictEqual(decompiled.triggers[0].click_count, undefined);
  assert.strictEqual(decompiled.triggers[1].click_count, 2);
  assert.strictEqual(decompiled.triggers[1].for_sec, 0);
  assert.strictEqual(decompiled.triggers[2].click_count, 3);
  assert.strictEqual(decompiled.triggers[3].click_count, 2);
  assert.strictEqual(decompiled.triggers[3].ble_action, 'press');
});

test('Trigger name defaults to chosen option and preserves custom names across option changes', () => {
  const starCmd: Command = {
    id: 'sw_star',
    name: 'Steering Wheel Star Button',
    category: 'Steering Wheel & Controls',
    roles: ['trigger'],
    ha_metadata: { name: 'Star Button', domain: 'event' },
    network: { state_can_id: '0x448', bus: 0 },
    options: [
      { label: 'Pressed', match: { D8: '0x02' }, mask: '0x02', default: true },
      { label: 'Released', match: { D8: '0x00' }, mask: '0x02' },
    ],
  };

  const trig = commandToTrigger(starCmd, starCmd.options![0]);
  assert.strictEqual(trig.name, 'Star Button - Pressed');

  const updatedDefault = applyOptionToTrigger(trig, starCmd, starCmd.options![1]);
  assert.strictEqual(updatedDefault.name, 'Star Button - Released');

  const customized = { ...updatedDefault, name: 'My Garage Door Opener' };
  const updatedCustom = applyOptionToTrigger(customized, starCmd, starCmd.options![0]);
  assert.strictEqual(updatedCustom.name, 'My Garage Door Opener');

  assert.strictEqual(formatDefaultTriggerName('Star Button', 'Pressed', 2), 'Star Button - Pressed (2x Press)');
});

test('resolveCatalogCommandForAction resolves ambient_mood_lighting alias, exact 0x00 Off options, and preserves single-step metadata', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'ambient_light_colors',
        name: 'Ambient Light Colors',
        category: 'Cockpit & Controls',
        roles: ['action'],
        network: { action_can_id: '0x4AD', bus: 0, delay_ms: 25 },
        options: [
          {
            label: 'Color 8: Pure Cyan / Aqua Wave',
            steps: [
              { payload: '0064530F00000000', repeat: 3, delay_ms: 25 },
              { payload: '0002082000000000', repeat: 3, delay_ms: 25 },
            ],
          },
          {
            label: 'Off',
            steps: [
              { payload: '000208A000000000', repeat: 3, delay_ms: 25 },
              { payload: '0002082000000000', repeat: 3, delay_ms: 25 },
            ],
          },
        ],
      },
      {
        id: 'ambient_light_brightness',
        name: 'Ambient Light Brightness',
        category: 'Cockpit & Controls',
        roles: ['action'],
        network: { action_can_id: '0x4AD', bus: 0, delay_ms: 25 },
        options: [{ label: 'Level 5', payload: '0002085000000000' }],
      },
      {
        id: 'hazard_lights',
        name: 'Hazard Lights',
        category: 'Lighting',
        roles: ['action'],
        network: { action_can_id: '0x587', bus: 0 },
        options: [
          { label: 'Turned ON / Active', payload: { D1: '0x01' } },
          {
            label: 'Turned OFF / Inactive',
            payload: { D1: '0x00', D2: '0x00', D3: '0x00', D4: '0x00', D5: '0x00', D6: '0x00', D7: '0x00', D8: '0x00' },
          },
        ],
      },
      {
        id: 'telematics_remote_door_locks',
        name: 'Remote Door Locks',
        category: 'Closures',
        roles: ['action'],
        network: { action_can_id: '0x587', bus: 0 },
        options: [{ label: 'Lock', payload: { D2: '0x02' } }],
      },
    ],
  };

  // Legacy ambient_mood_lighting alias resolves to ambient_light_colors instead of failing on ambiguous 0x4AD
  const aliasResolved = resolveCatalogCommandForAction(
    { id: 'act_alias', type: 'can_tx', entity_id: 'ambient_mood_lighting' },
    catalog
  );
  assert.strictEqual(aliasResolved.command?.id, 'ambient_light_colors');

  // Exact all-0x00 payload matches Turned OFF / Inactive without metadata
  const zeroOffResolved = resolveCatalogCommandForAction(
    {
      id: 'act_hazard_off',
      type: 'can_tx',
      can_id: '0x587',
      payload: { D1: '0x00', D2: '0x00', D3: '0x00', D4: '0x00', D5: '0x00', D6: '0x00', D7: '0x00', D8: '0x00' },
    },
    catalog
  );
  assert.strictEqual(zeroOffResolved.command?.id, 'hazard_lights');
  assert.strictEqual(zeroOffResolved.matchedOption?.label, 'Turned OFF / Inactive');

  // Single-step compileAction preserves resolved catalog metadata
  const compiledSingle = compileAction(
    {
      id: 'act_hazard_on',
      type: 'can_tx',
      can_id: '0x587',
      payload: { D1: '0x01' },
    },
    catalog
  );
  assert.strictEqual(compiledSingle.source_command_id, 'hazard_lights');
  assert.strictEqual(compiledSingle.option_label, 'Turned ON / Active');
});

test('compileAction and decompileActionList round-trip repeat_until and wait_for with conditions array', () => {
  const catalog = createMockCatalog(5);

  // Single condition passed via conditions[] (e.g. edited via ConditionListEditor) compiles to condition
  const waitSingle: AutomationAction = {
    id: 'act_wait_single',
    type: 'wait_for',
    interval_ms: 50,
    timeout_ms: 5000,
    conditions: [
      { id: 'c1', type: 'ble_button', ble_button: 'volume_up', ble_action: 'press' } as AutomationCondition,
    ],
  };
  const compiledWaitSingle = compileAction(waitSingle, catalog);
  assert.strictEqual(compiledWaitSingle.type, 'wait_for');
  assert.ok(compiledWaitSingle.condition, 'Single condition in conditions[] should compile to condition');
  assert.strictEqual(compiledWaitSingle.condition.ble_button, 'volume_up');

  // Multiple conditions in repeat_until compile to conditions[] and preserve sequence
  const repeatMulti: AutomationAction = {
    id: 'act_repeat_multi',
    type: 'repeat_until',
    interval_ms: 500,
    timeout_ms: 20000,
    conditions: [
      { id: 'c1', type: 'can_state', can_id: '0x226', byte: 'D1', mask: '0xFF', operator: 'equal', value: '0x00' },
      { id: 'c2', type: 'ble_button', ble_button: 'mute', ble_action: 'press' } as AutomationCondition,
    ],
    sequence: [
      { id: 'seq_1', type: 'track_popup', level: 'info', text: 'Repeating' },
    ],
  };
  const compiledRepeat = compileAction(repeatMulti, catalog);
  assert.strictEqual(compiledRepeat.type, 'repeat_until');
  assert.strictEqual(compiledRepeat.interval_ms, 500);
  assert.strictEqual(compiledRepeat.timeout_ms, 20000);
  assert.strictEqual(compiledRepeat.conditions?.length, 2);
  assert.strictEqual(compiledRepeat.sequence?.length, 1);

  const decompiled = decompileActionList([compiledRepeat], catalog);
  assert.strictEqual(decompiled.length, 1);
  assert.strictEqual(decompiled[0].type, 'repeat_until');
  assert.strictEqual(decompiled[0].conditions?.length, 2);
  assert.ok(decompiled[0].condition);
  assert.strictEqual(decompiled[0].sequence?.length, 1);

  // Legacy webhook should not compile into an empty transmit frame
  const compiledWebhook = compileAction(
    { id: 'act_wh', type: 'webhook', webhook_url: 'https://example.com', webhook_method: 'POST' },
    catalog
  );
  assert.strictEqual(compiledWebhook.type, 'webhook');
  assert.strictEqual(compiledWebhook.webhook_url, 'https://example.com');
});

test('compileAction and decompileActionList handle cycle_entity ping_pong, popup templates, fallback modes, and legacy choose compatibility', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'drivers_seat_comfort',
        name: 'Driver Seat Comfort',
        category: 'Climate & Comfort',
        roles: ['action', 'condition'],
        network: { action_can_id: '0x4A2', state_can_id: '0x496', bus: 0 },
        options: [
          { label: 'Off', match: { D3: '0x00' }, payload: { D5: '0x2F' } },
          { label: 'Low Heat', match: { D3: '0x01' }, payload: { D5: '0x6F' } },
          { label: 'Medium Heat', match: { D3: '0x02' }, payload: { D5: '0x7F' } },
          { label: 'High Heat', match: { D3: '0x03' }, payload: { D5: '0x8F' } },
        ],
      },
    ],
  };

  const cyclePingPong: AutomationAction = {
    id: 'act_cycle_pp',
    type: 'cycle_entity',
    entity_id: 'drivers_seat_comfort',
    states: ['Off', 'Low Heat', 'High Heat'],
    direction: 'ping_pong',
    fallback_state: '__first__',
    show_popup: true,
    popup_prefix: '{entity}: {state}!',
    level: 'warning',
  };

  const compiled = compileAction(cyclePingPong, catalog);
  assert.strictEqual(compiled.type, 'cycle_entity');
  assert.strictEqual(compiled.entity_id, 'drivers_seat_comfort');
  assert.deepStrictEqual(compiled.states, ['Off', 'Low Heat', 'High Heat']);
  assert.strictEqual(compiled.direction, 'ping_pong');
  assert.strictEqual(compiled.fallback_state, '__first__');
  assert.strictEqual(compiled.show_popup, true);
  assert.strictEqual(compiled.popup_prefix, '{entity}: {state}!');
  assert.strictEqual(compiled.level, 'warning');

  // Round-trip decompile restores native cycle_entity
  const decompiled = decompileActionList([compiled], catalog);
  assert.strictEqual(decompiled.length, 1);
  assert.strictEqual(decompiled[0].type, 'cycle_entity');
  assert.strictEqual(decompiled[0].direction, 'ping_pong');
  assert.deepStrictEqual(decompiled[0].states, ['Off', 'Low Heat', 'High Heat']);
  assert.strictEqual(decompiled[0].popup_prefix, '{entity}: {state}!');
  assert.strictEqual(decompiled[0].level, 'warning');

  // Fallback '__none__' is preserved verbatim
  const compiledNoFallback = compileAction(
    { ...cyclePingPong, fallback_state: '__none__' },
    catalog
  );
  assert.strictEqual(compiledNoFallback.fallback_state, '__none__');

  // Legacy exported choose + _cycle_entity format still decompiles cleanly into cycle_entity
  const legacyDecompiled = decompileActionList([
    {
      id: 'act_legacy_pp',
      type: 'choose',
      choices: [],
      default: [],
      _cycle_entity: {
        entity_id: 'drivers_seat_comfort',
        states: ['Off', 'Low Heat', 'High Heat'],
        direction: 'ping_pong',
        wrap: true,
        fallback_state: '__first__',
        show_popup: true,
        popup_prefix: '{entity}: {state}!',
        level: 'warning',
      },
    },
  ], catalog);
  assert.strictEqual(legacyDecompiled.length, 1);
  assert.strictEqual(legacyDecompiled[0].type, 'cycle_entity');
  assert.strictEqual(legacyDecompiled[0].direction, 'ping_pong');
  assert.strictEqual(legacyDecompiled[0].level, 'warning');
});

test('compileAction and decompileActionList round-trip hud_nav update and clear actions', () => {
  const catalog = createMockCatalog(2);

  const hudUpdate: AutomationAction = {
    id: 'act_hud_update',
    type: 'hud_nav',
    nav_action: 'update',
    icon: 0x08, // Turn Left
    direction_deg: 270,
    distance_meters: 400,
    bars: 5,
    speed_limit: 88, // 55 mph in km/h
    camera_alert: true,
    street: 'I-5 North',
    num_lanes: 4,
    lane_directions: [8, 1, 1, 3],
    lane_recommended: [1, 0, 0, 0],
  };

  const compiledUpdate = compileAction(hudUpdate, catalog);
  assert.strictEqual(compiledUpdate.type, 'hud_nav');
  assert.strictEqual(compiledUpdate.icon, 0x08);
  assert.strictEqual(compiledUpdate.direction_deg, 270);
  assert.strictEqual(compiledUpdate.distance_meters, 400);
  assert.strictEqual(compiledUpdate.bars, 5);
  assert.strictEqual(compiledUpdate.speed_limit, 88);
  assert.strictEqual(compiledUpdate.camera_alert, true);
  assert.strictEqual(compiledUpdate.street, 'I-5 North');
  assert.strictEqual(compiledUpdate.num_lanes, 4);
  assert.deepStrictEqual(compiledUpdate.lane_directions, [8, 1, 1, 3]);
  assert.deepStrictEqual(compiledUpdate.lane_recommended, [1, 0, 0, 0]);

  const compiledClear = compileAction(
    { id: 'act_hud_clear', type: 'hud_nav', nav_action: 'clear' },
    catalog
  );
  assert.strictEqual(compiledClear.type, 'hud_nav');
  assert.strictEqual(compiledClear.action, 'clear');

  const decompiled = decompileActionList([compiledUpdate, compiledClear], catalog);
  assert.strictEqual(decompiled.length, 2);
  assert.strictEqual(decompiled[0].type, 'hud_nav');
  assert.strictEqual(decompiled[0].icon, 0x08);
  assert.strictEqual(decompiled[0].distance_meters, 400);
  assert.strictEqual(decompiled[0].speed_limit, 88);
  assert.strictEqual(decompiled[0].num_lanes, 4);
  assert.strictEqual(decompiled[1].type, 'hud_nav');
  assert.strictEqual(decompiled[1].nav_action, 'clear');
});

test('compileAutomationRule and decompileAutomationRule preserve trigger_mode and trigger_window_ms', () => {
  const catalog = createMockCatalog(2);
  const seqRule: AutomationRule = {
    id: 'rule_seq_win',
    name: 'Two-Button Secret Sequence',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:gesture-tap-hold',
    exec_mode: 'one_shot',
    trigger_mode: 'sequence',
    trigger_window_ms: 8000,
    cooldown_ms: 500,
    triggers: [
      { id: 't1', source: 'ble', type: 'ble_button', ble_button: 'mute', to: 'press' },
      { id: 't2', source: 'ble', type: 'ble_button', ble_button: 'volume_down', to: 'press' },
    ],
    conditions: [],
    actions: [{ id: 'a1', type: 'track_popup', level: 'info', text: 'Sequence Matched!' }],
  };

  const compiled = compileAutomationRule(seqRule, catalog);
  assert.strictEqual(compiled.trigger_mode, 'sequence');
  assert.strictEqual(compiled.trigger_window_ms, 8000);

  const decompiled = decompileAutomationRule(compiled, catalog);
  assert.strictEqual(decompiled.trigger_mode, 'sequence');
  assert.strictEqual(decompiled.trigger_window_ms, 8000);
});

test('resolveCatalogCommandForAction skips non-catalog built-ins like hud_nav and commandToAction creates native hud_nav / track_popup actions', () => {
  const catalog = createMockCatalog(2);
  catalog.commands.push(
    {
      id: 'audio_sound_focus',
      name: 'Infotainment Sound Stage Focus',
      category: 'Cockpit & Controls',
      roles: ['action', 'condition'],
      network: { action_can_id: '0x60E', state_can_id: '0x60E', bus: 0 },
      options: [
        { label: 'Center', match: { D2: '0x0A', D3: '0x0A' }, payload: { D2: '0x0A', D3: '0x0A' }, default: true },
      ],
    },
    {
      id: 'hud_turn_by_turn_maneuver',
      name: 'Windshield HUD Turn-by-Turn Navigation',
      category: 'Cockpit & Controls',
      roles: ['action', 'condition'],
      network: { type: 'hud_nav', action_can_id: '0x29B', state_can_id: '0x29B', bus: 0 },
      options: [
        { label: 'Continue Straight', match: { D1: '0x01' }, mask: '0xFF', default: true },
        { label: 'Turn Right 90°', match: { D1: '0x03' }, mask: '0xFF' },
      ],
    }
  );

  const taintedHud: AutomationAction = {
    id: 'act_hud_stale',
    type: 'hud_nav',
    source_command_id: 'audio_sound_focus',
    entity_id: 'audio_sound_focus',
    can_id: '0x60E',
    nav_action: 'update',
    icon: 1,
  };
  const resolved = resolveCatalogCommandForAction(taintedHud, catalog);
  assert.strictEqual(resolved.command, undefined, 'hud_nav must never resolve to a catalog command');

  const hudCmd = catalog.commands.find(c => c.id === 'hud_turn_by_turn_maneuver')!;
  const convertedHud = commandToAction(hudCmd, hudCmd.options![1]);
  assert.strictEqual(convertedHud.type, 'hud_nav');
  assert.strictEqual(convertedHud.nav_action, 'update');
  assert.strictEqual(convertedHud.icon, 0x03);
});

test('applyEffectToAction, compileAction, and decompileActionList preserve dynamic ambient animations as entity_command', () => {
  const catalog = createMockCatalog(1);
  const ambientCmd: Command = {
    id: 'ambient_light_colors',
    name: 'Ambient Light Colors',
    category: 'Cockpit & Controls',
    roles: ['action', 'trigger'],
    ha_metadata: { name: 'Ambient Mood Lighting', domain: 'light' },
    network: { bus: 0, type: 'can_rx_tx', action_can_id: '0x4AD', delay_ms: 25, state_can_id: '0x455' },
    options: [
      {
        label: 'Golden Insight / Orange Delight',
        steps: [
          { payload: 'D0C1751500000000', repeat: 3, delay_ms: 25 },
          { payload: '0002082000000000', repeat: 3, delay_ms: 25 },
        ],
      },
      {
        label: 'Color 8: Pure Cyan / Aqua Wave',
        steps: [
          { payload: '0064530F00000000', repeat: 3, delay_ms: 25 },
          { payload: '0002082000000000', repeat: 3, delay_ms: 25 },
        ],
      },
    ],
    effects: [
      { label: 'Rainbow Spectrum Wave', name: 'Rainbow Wave', hex: '#ff00ff' },
      { label: 'Sunset Glow', name: 'Sunset Glow', hex: '#ff8c00' },
    ],
  };
  catalog.commands.push(ambientCmd);

  // Applying a dynamic effect produces a clean entity_command without stale static CAN steps
  const applied = applyEffectToAction(
    {
      id: 'act_amb_1',
      type: 'can_tx',
      payload: { D1: '0xD0' },
      steps: [{ can_id: '0x4AD', bus: 0, payload: { D1: '0xD0' }, repeat: 3, delay_ms: 25 }],
    },
    ambientCmd,
    ambientCmd.effects![0]
  );
  assert.strictEqual(applied.type, 'entity_command');
  assert.strictEqual(applied.entity_id, 'ambient_light_colors');
  assert.strictEqual(applied.command, 'Rainbow Spectrum Wave');
  assert.strictEqual(applied.steps, undefined);
  assert.strictEqual(applied.payload, undefined);

  // Compilation preserves type='entity_command' and never falls back to options[0]
  const compiled = compileAction(applied, catalog);
  assert.strictEqual(compiled.type, 'entity_command');
  assert.strictEqual(compiled.entity_id, 'ambient_light_colors');
  assert.strictEqual(compiled.command, 'Rainbow Spectrum Wave');

  // Even a legacy can_tx action carrying an effect label compiles to entity_command
  const compiledFromLegacy = compileAction(
    {
      id: 'act_amb_legacy',
      type: 'can_tx',
      entity_id: 'ambient_light_colors',
      can_id: '0x4AD',
      command: 'Sunset Glow',
      option_label: 'Sunset Glow',
    },
    catalog
  );
  assert.strictEqual(compiledFromLegacy.type, 'entity_command');
  assert.strictEqual(compiledFromLegacy.entity_id, 'ambient_light_colors');
  assert.strictEqual(compiledFromLegacy.command, 'Sunset Glow');

  // Decompiling preserves entity_command cleanly without flattening to Golden Insight / options[0]
  const decompiled = decompileActionList([compiled, compiledFromLegacy], catalog);
  assert.strictEqual(decompiled.length, 2);
  assert.strictEqual(decompiled[0].type, 'entity_command');
  assert.strictEqual(decompiled[0].command, 'Rainbow Spectrum Wave');
  assert.strictEqual(decompiled[0].option_label, 'Rainbow Spectrum Wave');
  assert.strictEqual(decompiled[1].type, 'entity_command');
  assert.strictEqual(decompiled[1].command, 'Sunset Glow');
});

test('Wave A1-1: formatHexByte validates bounds/strict hex/negated bytes, compileToByteMap handles arrays & wrapper objects, and compileAction emits empty payload', () => {
  // formatHexByte bounds & strict 0x parsing
  assert.strictEqual(formatHexByte(-1), undefined);
  assert.strictEqual(formatHexByte(256), undefined);
  assert.strictEqual(formatHexByte(Infinity), undefined);
  assert.strictEqual(formatHexByte(NaN), undefined);
  assert.strictEqual(formatHexByte('0x1FF'), undefined);
  assert.strictEqual(formatHexByte('0x12G'), undefined);
  assert.strictEqual(formatHexByte('0x5'), '0x05');

  // allowNegated support for condition/match compilation
  assert.strictEqual(formatHexByte('!0x00'), undefined);
  assert.strictEqual(formatHexByte('!0x00', true), '!0x00');
  assert.strictEqual(formatHexByte('!0x0f', true), '!0x0F');
  assert.strictEqual(formatHexByte('!ff', true), '!0xFF');
  assert.strictEqual(formatHexByte('!!0x00', true), undefined);

  // compileToByteMap maps arrays 0..7 -> D1..D8 without left-shifting
  assert.deepStrictEqual(compileToByteMap([0xAA, 0xBB, 0xCC, '*', 0x05]), {
    D1: '0xAA',
    D2: '0xBB',
    D3: '0xCC',
    D5: '0x05',
  });

  // compileToByteMap unwraps { hex | data | raw } objects
  assert.deepStrictEqual(compileToByteMap({ hex: 'D0C1751500000000' }), {
    D1: '0xD0',
    D2: '0xC1',
    D3: '0x75',
    D4: '0x15',
    D5: '0x00',
    D6: '0x00',
    D7: '0x00',
    D8: '0x00',
  });
  assert.deepStrictEqual(compileToByteMap({ data: '01020304' }), {
    D1: '0x01',
    D2: '0x02',
    D3: '0x03',
    D4: '0x04',
  });
  assert.deepStrictEqual(compileToByteMap({ raw: '0xAABB' }), {
    D1: '0xAA',
    D2: '0xBB',
  });

  // Negated bytes survive condition compilation
  const negCond = compileCondition({
    id: 'c_neg',
    type: 'can_state',
    can_id: '0x496',
    match: { D1: '!0x00', D2: '0x10' },
  });
  assert.deepStrictEqual(negCond.match, { D1: '!0x00', D2: '0x10' });

  // compileAction emits {} instead of { D1: '0x01' } when payload is empty
  const emptyTx = compileAction({
    id: 'act_empty',
    type: 'can_tx',
    can_id: '0x000',
    payload: {},
  });
  assert.deepStrictEqual(emptyTx.payload, {});
});

test('Wave A1-2: compileAction preserves clamped delay_ms on single/repeated transmit steps and decompileActionList preserves item.delay_ms separately from inter-step delays', () => {
  const catalog = createMockCatalog(2);

  // Single-step transmit with repeat pacing delay_ms
  const compiledSingle = compileAction(
    {
      id: 'act_single_delay',
      type: 'can_tx',
      can_id: '0x4A2',
      bus: 0,
      payload: { D5: '0x3F' },
      repeat: 4,
      delay_ms: 65,
    },
    catalog
  );
  assert.strictEqual(compiledSingle.delay_ms, 65);

  // Clamps delay_ms to 60000
  const compiledClamped = compileAction(
    {
      id: 'act_clamped_delay',
      type: 'can_tx',
      can_id: '0x4A2',
      bus: 0,
      payload: { D5: '0x3F' },
      repeat: 2,
      delay_ms: 999999,
    },
    catalog
  );
  assert.strictEqual(compiledClamped.delay_ms, 60000);

  // Decompile preserves transmit delay_ms without conflating with differing inter-step delay
  const rawGrouped = [
    {
      id: 'act_grp_delay',
      type: 'transmit',
      can_id: '0x4A2',
      bus: 0,
      payload: { D5: '0x4F' },
      repeat: 3,
      delay_ms: 40,
      _step_group_id: 'grp_pacing',
    },
    {
      type: 'delay',
      ms: 500,
      _step_group_id: 'grp_pacing',
    },
    {
      type: 'transmit',
      can_id: '0x4A2',
      bus: 0,
      payload: { D5: '0xFF' },
      repeat: 1,
      _step_group_id: 'grp_pacing',
    },
  ];

  const decompiled = decompileActionList(rawGrouped, catalog);
  assert.strictEqual(decompiled.length, 1);
  assert.strictEqual(decompiled[0].steps?.length, 3);
  assert.strictEqual(decompiled[0].steps?.[0].delay_ms, 40);
  assert.strictEqual(decompiled[0].steps?.[1].type, 'delay');
  assert.strictEqual(decompiled[0].steps?.[1].delay_ms, 500);

  // Round-trip re-compilation preserves repeat delay_ms=40 and inter-step delay=500 without duplicating delays
  const recompiled = compileActionList(decompiled, catalog);
  assert.strictEqual(recompiled.length, 3);
  assert.strictEqual(recompiled[0].type, 'transmit');
  assert.strictEqual(recompiled[0].delay_ms, 40);
  assert.strictEqual(recompiled[1].type, 'delay');
  assert.strictEqual(recompiled[1].ms, 500);
  assert.strictEqual(recompiled[2].type, 'transmit');
});

test('Wave A1-3: battery_preconditioning alias, Cancel/Off STOP inference, and applyOptionToAction precondition handling', () => {
  const preconCmd: Command = {
    id: 'battery_preconditioning',
    name: 'Battery Preconditioning Control',
    type: 'precondition',
    category: 'High Voltage & Charging',
    roles: ['action'],
    network: { bus: 0, type: 'precondition', action_can_id: '0x0C7' },
    options: [
      {
        label: 'Persistent',
        precon_mode: 'persistent',
        steps: [{ payload: { D4: '0x40', D5: '0x03' }, repeat: 3 }],
      },
      {
        label: 'Continuous',
        precon_mode: 'continuous',
        steps: [{ payload: { D4: '0x40', D5: '0x03' }, repeat: 3 }],
      },
      {
        label: 'Cancel / Off',
        precon_mode: 'cancel',
        steps: [{ payload: { D1: '0x00', D4: '0x00' }, repeat: 3 }],
      },
    ],
  };
  const catalog: Catalog = { can_do_version: '1.0.0', vehicles: [], commands: [preconCmd] };

  // Alias type='battery_preconditioning' with mode='cancel' compiles to stop, never fallback transmit
  const compiledAliasCancel = compileAction(
    { id: 'p1', type: 'battery_preconditioning', mode: 'cancel' } as any,
    catalog
  );
  assert.strictEqual(compiledAliasCancel.type, 'precondition');
  assert.strictEqual(compiledAliasCancel.mode, 'cancel');
  assert.strictEqual(compiledAliasCancel.action, 'stop');

  // entity_command with command='Cancel / Off' compiles to stop, never start
  const compiledEntityStop = compileAction(
    { id: 'p2', type: 'entity_command', entity_id: 'battery_preconditioning', command: 'Cancel / Off' },
    catalog
  );
  assert.strictEqual(compiledEntityStop.type, 'precondition');
  assert.strictEqual(compiledEntityStop.mode, 'cancel');
  assert.strictEqual(compiledEntityStop.action, 'stop');

  // compileActionList (which runs decompileActionList first) also preserves precondition STOP instead of 0x0C7 bursts
  const compiledListStop = compileActionList(
    [{ id: 'p2b', type: 'entity_command', entity_id: 'battery_preconditioning', command: 'Cancel / Off' }],
    catalog
  );
  assert.strictEqual(compiledListStop.length, 1);
  assert.strictEqual(compiledListStop[0].type, 'precondition');
  assert.strictEqual(compiledListStop[0].mode, 'cancel');
  assert.strictEqual(compiledListStop[0].action, 'stop');

  // decompileActionList maps { type: 'precondition', mode: 'cancel' } without action -> precon_action: 'stop'
  const decompiledCancel = decompileActionList(
    [
      { id: 'p3', type: 'precondition', mode: 'cancel' },
      { id: 'p4', type: 'battery_preconditioning', mode: 'continuous' },
    ],
    catalog
  );
  assert.strictEqual(decompiledCancel[0].type, 'precondition');
  assert.strictEqual(decompiledCancel[0].precon_mode, 'cancel');
  assert.strictEqual(decompiledCancel[0].precon_action, 'stop');
  assert.strictEqual(decompiledCancel[1].type, 'precondition');
  assert.strictEqual(decompiledCancel[1].precon_mode, 'continuous');
  assert.strictEqual(decompiledCancel[1].precon_action, 'start');

  // applyOptionToAction stays type='precondition' instead of raw 0x0C7 steps
  const appliedCancel = applyOptionToAction(
    { id: 'p5', type: 'precondition', precon_mode: 'persistent', precon_action: 'start' },
    preconCmd,
    preconCmd.options![2]
  );
  assert.strictEqual(appliedCancel.type, 'precondition');
  assert.strictEqual(appliedCancel.precon_mode, 'cancel');
  assert.strictEqual(appliedCancel.precon_action, 'stop');
  assert.strictEqual(appliedCancel.steps, undefined);
  assert.strictEqual(appliedCancel.can_id, undefined);
});

test('Wave A1-4: decompileActionList preserves non-catalog and rule-targeting entity_command actions', () => {
  const catalog = createMockCatalog(2);
  catalog.commands.push({
    id: 'virtual_sensor_entity',
    name: 'Virtual Sensor',
    category: 'General',
    roles: ['condition'],
    network: { state_can_id: '0x333' },
  });

  const actions = [
    { id: 'a_rule_toggle', type: 'entity_command', entity_id: 'rule_auto_hold', command: 'OFF' },
    { id: 'a_virtual', type: 'entity_command', entity_id: 'virtual_sensor_entity', command: 'Refresh' },
    { id: 'a_static', type: 'entity_command', entity_id: 'cmd_1', command: 'On' },
  ];

  const decompiled = decompileActionList(actions, catalog);
  assert.strictEqual(decompiled.length, 3);

  // Rule-targeting entity_command preserved verbatim
  assert.strictEqual(decompiled[0].type, 'entity_command');
  assert.strictEqual(decompiled[0].entity_id, 'rule_auto_hold');
  assert.strictEqual(decompiled[0].command, 'OFF');

  // Non-static catalog command preserved as entity_command
  assert.strictEqual(decompiled[1].type, 'entity_command');
  assert.strictEqual(decompiled[1].entity_id, 'virtual_sensor_entity');
  assert.strictEqual(decompiled[1].command, 'Refresh');

  // Static CAN catalog command coerced to can_tx with resolved payload
  assert.strictEqual(decompiled[2].type, 'can_tx');
  assert.strictEqual(decompiled[2].can_id, '0xC9');
  assert.deepStrictEqual(decompiled[2].payload, { D1: '0x01' });

  // Full compileActionList preserves rule-targeting entity_command end-to-end
  const compiled = compileActionList([actions[0] as AutomationAction], catalog);
  assert.strictEqual(compiled.length, 1);
  assert.strictEqual(compiled[0].type, 'entity_command');
  assert.strictEqual(compiled[0].entity_id, 'rule_auto_hold');
  assert.strictEqual(compiled[0].command, 'OFF');
});

test('Wave A1-5: resolveActionBus honors dual-CAN network.action_bus consistently across all action converters', () => {
  const dualBusCmd: Command = {
    id: 'dual_bus_cmd',
    name: 'Dual Bus Action',
    category: 'General',
    roles: ['action', 'condition'],
    network: {
      bus: 0,
      action_bus: 1,
      state_can_id: '0x310',
      action_can_id: '0x410',
      delay_ms: 20,
    },
    options: [
      {
        label: 'Activate',
        steps: [{ payload: { D1: '0x01' } }, { payload: { D1: '0x00' } }],
      },
    ],
    effects: [{ label: 'Pulse', name: 'Pulse' }],
  };

  const reverseDualBusCmd: Command = {
    id: 'reverse_dual_bus_cmd',
    name: 'Reverse Dual Bus Action',
    category: 'General',
    roles: ['action'],
    network: {
      bus: 1,
      action_bus: 0,
      action_can_id: '0x411',
    },
    options: [{ label: 'Go', payload: { D1: '0x02' } }],
  };

  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [dualBusCmd, reverseDualBusCmd],
  };

  assert.strictEqual(resolveActionBus(dualBusCmd), 1);
  assert.strictEqual(resolveActionBus(reverseDualBusCmd), 0);
  assert.strictEqual(resolveActionBus({ ...dualBusCmd, network: { action_bus: 9 } }), 1);
  assert.strictEqual(resolveActionBus({ ...dualBusCmd, network: { action_bus: -3 } }), 0);

  // commandToAction
  const actFromCmd = commandToAction(dualBusCmd, dualBusCmd.options![0]);
  assert.strictEqual(actFromCmd.bus, 1);
  assert.strictEqual(actFromCmd.steps?.[0].bus, 1);
  assert.strictEqual(actFromCmd.steps?.[1].bus, 1);

  const actReverse = commandToAction(reverseDualBusCmd, reverseDualBusCmd.options![0]);
  assert.strictEqual(actReverse.bus, 0);

  // applyOptionToAction
  const appliedOpt = applyOptionToAction(
    { id: 'a1', type: 'can_tx', bus: 0 },
    dualBusCmd,
    dualBusCmd.options![0]
  );
  assert.strictEqual(appliedOpt.bus, 1);
  assert.strictEqual(appliedOpt.steps?.[0].bus, 1);

  // applyEffectToAction
  const appliedEff = applyEffectToAction(
    { id: 'a2', type: 'can_tx', bus: 0 },
    dualBusCmd,
    dualBusCmd.effects![0]
  );
  assert.strictEqual(appliedEff.bus, 1);

  // compileAction (entity_command)
  const compiled = compileAction(
    { id: 'a3', type: 'entity_command', entity_id: 'dual_bus_cmd', command: 'Activate' },
    catalog
  );
  assert.ok(Array.isArray(compiled));
  assert.strictEqual(compiled[0].bus, 1);
  assert.strictEqual(compiled[2].bus, 1);

  // decompileActionList (dynamic effect + multi-step)
  const decompiledEff = decompileActionList(
    [{ id: 'a4', type: 'entity_command', entity_id: 'dual_bus_cmd', command: 'Pulse' }],
    catalog
  );
  assert.strictEqual(decompiledEff[0].bus, 1);

  const decompiledMulti = decompileActionList(
    [{ id: 'a5', type: 'entity_command', entity_id: 'dual_bus_cmd', command: 'Activate' }],
    catalog
  );
  assert.strictEqual(decompiledMulti[0].bus, 1);
  assert.strictEqual(decompiledMulti[0].steps?.[0].bus, 1);
});

test('Wave A2-1: byte_transition omits default/relational from, commandToTrigger omits from: 0x00, and can_rx normalizes match & mask', () => {
  const catalog = createMockCatalog(2);
  const tempRangeCmd: Command = {
    id: 'cabin_temp_range',
    name: 'Cabin Temp',
    category: 'Climate',
    roles: ['trigger'],
    type: 'param_range',
    network: {
      state_can_id: '0x380',
      bus: 0,
      state_byte: 'D2',
      state_mask: '0xFF',
      min: 62,
      max: 82,
      step: 1,
      unit: '°F',
      raw_min: 0x06,
      raw_max: 0x1A,
    },
  };

  // Range trigger and discrete trigger do not pre-fill from: '0x00'
  const rangeTrig = commandToTrigger(tempRangeCmd);
  assert.strictEqual(rangeTrig.from, undefined);
  const discreteTrig = commandToTrigger(catalog.commands[0], catalog.commands[0].options![0]);
  assert.strictEqual(discreteTrig.from, undefined);

  const rule: AutomationRule = {
    id: 'rule_a2_1',
    name: 'Wave A2-1 Rule',
    enabled: true,
    ha_expose: false,
    ha_icon: 'mdi:car',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [
      // 1. Empty/undefined from -> omitted
      { id: 't_empty_from', source: 'can', type: 'byte_transition', can_id: '0x380', byte: 'D2', mask: '0xFF', to: '0x10' },
      // 2. Relational operators with stale from: '0x00' -> from omitted
      { id: 't_gt', source: 'can', type: 'byte_transition', can_id: '0x380', byte: 'D2', mask: '0xFF', from: '0x00', to: '0x12', operator: 'greater_than' },
      { id: 't_lte', source: 'can', type: 'byte_transition', can_id: '0x380', byte: 'D2', mask: '0xFF', from: '0x00', to: '0x0A', operator: 'less_than_or_equal' },
      { id: 't_neq', source: 'can', type: 'byte_transition', can_id: '0x380', byte: 'D2', mask: '0xFF', from: '0x00', to: '0x00', operator: 'not_equal' },
      // 3. Explicit from with equal operator -> preserved
      { id: 't_explicit_from', source: 'can', type: 'byte_transition', can_id: '0x448', byte: 'D7', mask: '0xF0', from: '0x00', to: '0x10' },
      // 4. Single-byte byte_transition with multi-byte match stays byte_transition
      { id: 't_single_with_match', source: 'can', can_id: '0x448', byte: 'D7', mask: '0xF0', to: '0x10', match: { D1: '0x00', D7: '0x10' } },
      // 5. Multi-byte match without trig.byte -> enters can_rx with normalized match & mask
      { id: 't_can_rx_multi', source: 'can', can_id: '0x496', match: { D1: 16, D3: 255 } as any, mask: { D1: 240 } as any },
      // 6. Explicit can_rx using to_payload and numeric scalar mask
      { id: 't_can_rx_explicit', source: 'can', type: 'can_rx', can_id: '0x496', to_payload: { D2: 15, D4: 'ab' } as any, mask: 240 as any },
    ],
    conditions: [],
    actions: [],
  };

  const compiled = compileAutomationRule(rule, catalog);
  assert.strictEqual(compiled.triggers[0].type, 'byte_transition');
  assert.strictEqual('from' in compiled.triggers[0], false);

  assert.strictEqual(compiled.triggers[1].type, 'byte_transition');
  assert.strictEqual('from' in compiled.triggers[1], false);
  assert.strictEqual(compiled.triggers[1].operator, 'greater_than');

  assert.strictEqual(compiled.triggers[2].type, 'byte_transition');
  assert.strictEqual('from' in compiled.triggers[2], false);
  assert.strictEqual(compiled.triggers[2].operator, 'less_than_or_equal');

  assert.strictEqual(compiled.triggers[3].type, 'byte_transition');
  assert.strictEqual('from' in compiled.triggers[3], false);
  assert.strictEqual(compiled.triggers[3].operator, 'not_equal');

  assert.strictEqual(compiled.triggers[4].type, 'byte_transition');
  assert.strictEqual(compiled.triggers[4].from, '0x00');

  assert.strictEqual(compiled.triggers[5].type, 'byte_transition');
  assert.strictEqual(compiled.triggers[5].byte, 'D7');

  assert.strictEqual(compiled.triggers[6].type, 'can_rx');
  assert.deepStrictEqual(compiled.triggers[6].match, { D1: '0x10', D3: '0xFF' });
  assert.deepStrictEqual(compiled.triggers[6].mask, { D1: '0xF0', D3: '0xFF' });

  assert.strictEqual(compiled.triggers[7].type, 'can_rx');
  assert.deepStrictEqual(compiled.triggers[7].match, { D2: '0x0F', D4: '0xAB' });
  assert.deepStrictEqual(compiled.triggers[7].mask, { D2: '0xF0', D4: '0xF0' });
});

test('Wave A2-2: AND/OR/NOT logic groups round-trip cleanly, empty NOT is omitted, and mixed OR never deletes children', () => {
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [
      {
        id: 'seat_heater',
        name: 'Seat Heater',
        category: 'Comfort',
        roles: ['condition'],
        network: { state_can_id: '0x496' },
        options: [
          { label: 'Off', match: { D3: '0x00' } },
          { label: 'Low', match: { D3: '0x01' } },
          { label: 'High', match: { D3: '0x03' } },
        ],
      },
    ],
  };

  // 1. Decompile shorthand { and }, { or }, { not } and *_group types into UI { id, logic, conditions, ...sustained }
  const decompiledAnd = decompileCondition(
    {
      and: [
        { can_id: '0x496', byte: 'D3', value: '0x01' },
        { type: 'voltage', operator: 'greater', value: 12.2 },
      ],
      for_sec: 5,
    },
    catalog
  );
  assert.strictEqual(decompiledAnd.logic, 'and');
  assert.strictEqual('and' in decompiledAnd, false);
  assert.strictEqual(decompiledAnd.for_sec, 5);
  assert.strictEqual(decompiledAnd.conditions?.length, 2);

  const decompiledNotSingle = decompileCondition(
    { not: { can_id: '0x496', byte: 'D3', value: '0x00' } },
    catalog
  );
  assert.strictEqual(decompiledNotSingle.logic, 'not');
  assert.strictEqual('not' in decompiledNotSingle, false);
  assert.strictEqual(decompiledNotSingle.conditions?.length, 1);

  const decompiledNotMulti = decompileCondition(
    {
      type: 'not_group',
      conditions: [
        { can_id: '0x496', byte: 'D3', value: '0x00' },
        { type: 'voltage', operator: 'less', value: 11.5 },
      ],
    },
    catalog
  );
  assert.strictEqual(decompiledNotMulti.logic, 'not');
  assert.strictEqual(decompiledNotMulti.type, undefined);
  assert.strictEqual(decompiledNotMulti.conditions?.length, 2);

  // 2. Compile recognizes logic, type (*_group), shorthand, single vs multi NOT, and omits empty NOT
  const compiledNotSingle = compileCondition(decompiledNotSingle, catalog);
  assert.ok(compiledNotSingle.not && !Array.isArray(compiledNotSingle.not));
  assert.strictEqual(compiledNotSingle.not.value, '0x00');

  const compiledNotMulti = compileCondition(decompiledNotMulti, catalog);
  assert.ok(Array.isArray(compiledNotMulti.not));
  assert.strictEqual(compiledNotMulti.not.length, 2);

  const compiledFromType = compileCondition(
    {
      id: 'grp_type',
      type: 'or_group',
      conditions: [{ id: 'c1', type: 'voltage', operator: 'greater', value: '12.5' }],
    },
    catalog
  );
  assert.ok(Array.isArray(compiledFromType.or));
  assert.strictEqual(compiledFromType.or.length, 1);

  const compiledFromShorthand = compileCondition(
    {
      id: 'grp_short',
      and: [{ id: 'c1', type: 'voltage', operator: 'greater', value: '12.5' }],
    },
    catalog
  );
  assert.ok(Array.isArray(compiledFromShorthand.and));
  assert.strictEqual(compiledFromShorthand.and.length, 1);

  const compiledEmptyNot = compileCondition({ id: 'empty_not', logic: 'not', conditions: [] }, catalog);
  assert.strictEqual(compiledEmptyNot, undefined);

  const compiledRuleWithEmptyNot = compileAutomationRule(
    {
      id: 'rule_empty_not',
      name: 'Empty NOT Rule',
      enabled: true,
      ha_expose: false,
      ha_icon: 'mdi:car',
      exec_mode: 'one_shot',
      cooldown_ms: 500,
      triggers: [],
      conditions: [{ id: 'empty_not', logic: 'not', conditions: [] }],
      actions: [],
    },
    catalog
  );
  assert.deepStrictEqual(compiledRuleWithEmptyNot.conditions, []);

  // 3. Mixed OR group (2 catalog leaves + 1 non-catalog condition) MUST NOT collapse or delete the 3rd child
  const mixedOrRaw = {
    or: [
      { can_id: '0x496', byte: 'D3', operator: 'equal', value: '0x01', source_command_id: 'seat_heater', option_label: 'Low' },
      { can_id: '0x496', byte: 'D3', operator: 'equal', value: '0x03', source_command_id: 'seat_heater', option_label: 'High' },
      { type: 'voltage', operator: 'less', value: 12.0 },
    ],
  };
  const decompiledMixedOr = decompileCondition(mixedOrRaw, catalog);
  assert.strictEqual(decompiledMixedOr.logic, 'or');
  assert.strictEqual('or' in decompiledMixedOr, false);
  assert.strictEqual(decompiledMixedOr.conditions?.length, 3);
  assert.strictEqual(decompiledMixedOr.conditions?.[2].type, 'voltage');

  // 4. Same-command OR with non-equal operator MUST NOT collapse
  const nonEqualOrRaw = {
    or: [
      { can_id: '0x496', byte: 'D3', operator: 'equal', value: '0x01', source_command_id: 'seat_heater', option_label: 'Low' },
      { can_id: '0x496', byte: 'D3', operator: 'not_equal', value: '0x00', source_command_id: 'seat_heater', option_label: 'Off' },
    ],
  };
  const decompiledNonEqualOr = decompileCondition(nonEqualOrRaw, catalog);
  assert.strictEqual(decompiledNonEqualOr.logic, 'or');
  assert.strictEqual(decompiledNonEqualOr.conditions?.length, 2);

  // 5. Pure single-entity multi-option OR STILL collapses cleanly
  const pureMultiOrRaw = {
    or: [
      { can_id: '0x496', byte: 'D3', operator: 'equal', value: '0x01', source_command_id: 'seat_heater', option_label: 'Low' },
      { can_id: '0x496', byte: 'D3', operator: 'equal', value: '0x03', source_command_id: 'seat_heater', option_label: 'High' },
    ],
  };
  const decompiledPureOr = decompileCondition(pureMultiOrRaw, catalog);
  assert.strictEqual(decompiledPureOr.type, 'can_state');
  assert.strictEqual(decompiledPureOr.logic, undefined);
  assert.deepStrictEqual(decompiledPureOr.selected_options, ['Low', 'High']);
});

test('Wave A2-3: BLE proximity classification, default RSSI operator, and time_condition/time defaults & day expansion', () => {
  const catalog = createMockCatalog(2);

  // 1. Any-beacon proximity trigger & major/minor-only beacon trigger compile to ble_beacon
  const compiledBleRule = compileAutomationRule(
    {
      id: 'rule_ble_prox',
      name: 'BLE Proximity',
      enabled: true,
      ha_expose: false,
      ha_icon: 'mdi:bluetooth',
      exec_mode: 'one_shot',
      cooldown_ms: 500,
      triggers: [
        { id: 't_prox', source: 'ble', type: 'ble_presence', ble_event: 'proximity', target_rssi: -65 },
        { id: 't_maj', source: 'ble', type: 'ble_presence', beacon_major: 42 },
        { id: 't_min', source: 'ble', type: 'ble_presence', beacon_minor: 7 },
      ],
      conditions: [],
      actions: [],
    },
    catalog
  );
  assert.strictEqual(compiledBleRule.triggers[0].type, 'ble_beacon');
  assert.strictEqual(compiledBleRule.triggers[0].ble_event, 'proximity');
  assert.strictEqual(compiledBleRule.triggers[1].type, 'ble_beacon');
  assert.strictEqual(compiledBleRule.triggers[1].beacon_major, 42);
  assert.strictEqual(compiledBleRule.triggers[2].type, 'ble_beacon');
  assert.strictEqual(compiledBleRule.triggers[2].beacon_minor, 7);

  // 2. Default RSSI operator >= when target_rssi is non-zero and operator omitted
  const compiledBeaconRssi = compileCondition({ id: 'c1', type: 'ble_beacon', target_rssi: -70 }, catalog);
  assert.strictEqual(compiledBeaconRssi.operator, 'greater_than_or_equal');

  const compiledDeviceRssi = compileCondition({ id: 'c2', type: 'ble_device', target_rssi: -65 }, catalog);
  assert.strictEqual(compiledDeviceRssi.operator, 'greater_than_or_equal');

  const compiledWifiConnectedRssi = compileCondition(
    { id: 'c3', type: 'device_state', device_property: 'wifi_connected', target_rssi: -60 },
    catalog
  );
  assert.strictEqual(compiledWifiConnectedRssi.operator, 'greater_than_or_equal');

  const compiledWifiRssi = compileCondition(
    { id: 'c4', type: 'device_state', device_property: 'wifi_rssi', target_rssi: -75 },
    catalog
  );
  assert.strictEqual(compiledWifiRssi.operator, 'greater_than_or_equal');

  const compiledApClientRssi = compileCondition(
    { id: 'c5', type: 'wifi', device_property: 'ap_client_rssi', target_rssi: -55 },
    catalog
  );
  assert.strictEqual(compiledApClientRssi.operator, 'greater_than_or_equal');

  // Explicit operator preserved; zero target_rssi does not synthesize operator
  const compiledExplicitOp = compileCondition(
    { id: 'c6', type: 'ble_beacon', target_rssi: -70, operator: 'less_than' },
    catalog
  );
  assert.strictEqual(compiledExplicitOp.operator, 'less_than');
  const compiledZeroRssi = compileCondition({ id: 'c7', type: 'ble_beacon', target_rssi: 0 }, catalog);
  assert.strictEqual(compiledZeroRssi.operator, undefined);

  // 3. time_condition empty days defaults to all 7 days
  const compiledTimeCond = compileCondition({ id: 'c_time', type: 'time_condition', start_time: '07:00', end_time: '21:00', days: [] }, catalog);
  assert.deepStrictEqual(compiledTimeCond.days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

  // 4. decompileAutomationRule recognizes firmware alias type: 'time' and expands day aliases/numbers
  const decompiledTimeRule = decompileAutomationRule(
    {
      id: 'rule_time_alias',
      name: 'Time Alias Rule',
      triggers: [
        { id: 't_time_1', type: 'time', time: '06:30', days: ['weekdays'] },
        { id: 't_time_2', type: 'time_schedule', time: '09:00', days: [0, 6] },
        { id: 't_time_3', type: 'time', time: '12:00', days: ['Monday', 3, '7'] },
      ],
      conditions: [
        { id: 'c_time_1', type: 'time', start_time: '08:00', end_time: '17:00', days: ['weekends'] },
      ],
      actions: [],
    },
    catalog
  );
  assert.strictEqual(decompiledTimeRule.triggers[0].type, 'time_schedule');
  assert.strictEqual(decompiledTimeRule.triggers[0].source, 'time');
  assert.deepStrictEqual(decompiledTimeRule.triggers[0].days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepStrictEqual(decompiledTimeRule.triggers[1].days, ['sat', 'sun']);
  assert.deepStrictEqual(decompiledTimeRule.triggers[2].days, ['mon', 'wed', 'sun']);
  assert.strictEqual(decompiledTimeRule.conditions[0].type, 'time_condition');
  assert.deepStrictEqual(decompiledTimeRule.conditions[0].days, ['sat', 'sun']);
});

test('Wave A2-4: BLE button action/click_count normalization, beacon/device target_string mapping, and ble_device_event decompile', () => {
  const catalog = createMockCatalog(2);

  // 1. Compile normalizes single_press/double_press/triple_press (even with click_count: 1) and prevents click_count > 1 on hold_Ns
  const compiledRule = compileAutomationRule(
    {
      id: 'rule_ble_norm',
      name: 'BLE Normalization',
      enabled: true,
      ha_expose: false,
      ha_icon: 'mdi:bluetooth',
      exec_mode: 'one_shot',
      cooldown_ms: 500,
      triggers: [
        { id: 't_single', source: 'ble', type: 'ble_button', ble_button: 'play', ble_action: 'single_press', click_count: 1 },
        { id: 't_double', source: 'ble', type: 'ble_button', ble_button: 'play', ble_action: 'double_press', click_count: 1 },
        { id: 't_triple', source: 'ble', type: 'ble_button', ble_button: 'play', ble_action: 'triple_press', click_count: 1 },
        { id: 't_hold', source: 'ble', type: 'ble_button', ble_button: 'play', ble_action: 'hold_3s', click_count: 2 },
      ],
      conditions: [
        { id: 'c_btn', type: 'ble_button', ble_button: 'mute', ble_action: 'single_press' },
        { id: 'c_beacon_rssi', type: 'ble_presence', device_property: 'beacon_rssi', target_string: 'FDA5-UUID', target_rssi: -68 },
        { id: 'c_beacon_major', type: 'ble_presence', beacon_major: 10, target_string: 'MAJOR-UUID' },
        { id: 'c_dev_str', type: 'ble_device', device_property: 'connected', target_string: 'AA:BB:CC:DD:EE:FF' },
      ],
      actions: [],
    },
    catalog
  );

  assert.strictEqual(compiledRule.triggers[0].ble_action, 'press');
  assert.strictEqual(compiledRule.triggers[0].click_count, undefined);
  assert.strictEqual(compiledRule.triggers[1].ble_action, 'press');
  assert.strictEqual(compiledRule.triggers[1].click_count, 2);
  assert.strictEqual(compiledRule.triggers[2].ble_action, 'press');
  assert.strictEqual(compiledRule.triggers[2].click_count, 3);
  assert.strictEqual(compiledRule.triggers[3].ble_action, 'hold_3s');
  assert.strictEqual(compiledRule.triggers[3].click_count, undefined);

  assert.strictEqual(compiledRule.conditions[0].ble_action, 'press');
  assert.strictEqual(compiledRule.conditions[1].type, 'ble_beacon');
  assert.strictEqual(compiledRule.conditions[1].beacon_uuid, 'FDA5-UUID');
  assert.strictEqual(compiledRule.conditions[1].operator, 'greater_than_or_equal');
  assert.strictEqual(compiledRule.conditions[2].type, 'ble_beacon');
  assert.strictEqual(compiledRule.conditions[2].beacon_uuid, 'MAJOR-UUID');
  assert.strictEqual(compiledRule.conditions[3].type, 'ble_device');
  assert.strictEqual(compiledRule.conditions[3].ble_device, 'AA:BB:CC:DD:EE:FF');

  // 2. Decompile normalizes single_press/double_press/triple_press even with click_count: 1, clamps hold_Ns, and maps ble_device_event -> ble_presence
  const decompiled = decompileAutomationRule(
    {
      id: 'rule_ble_dec',
      name: 'BLE Decompile',
      triggers: [
        { id: 't1', type: 'ble_button', ble_button: 'play', ble_action: 'single_press', click_count: 1 },
        { id: 't2', type: 'ble_button', ble_button: 'play', ble_action: 'double_press', click_count: 1 },
        { id: 't3', type: 'ble_button', ble_button: 'play', ble_action: 'triple_press', click_count: 1 },
        { id: 't4', type: 'ble_button', ble_button: 'play', ble_action: 'hold_2s', click_count: 3 },
        { id: 't5', type: 'ble_device_event', ble_event: 'connected', ble_device: 'AA:BB:CC:DD:EE:FF' },
        { id: 't6', type: 'ble_beacon', target_rssi: -62 },
      ],
      conditions: [
        { id: 'c1', type: 'ble_button', ble_button: 'mute', ble_action: 'single_press' },
        { id: 'c2', type: 'ble_beacon', target_rssi: -64 },
      ],
      actions: [],
    },
    catalog
  );

  assert.strictEqual(decompiled.triggers[0].ble_action, 'press');
  assert.strictEqual(decompiled.triggers[0].click_count, 1);
  assert.strictEqual(decompiled.triggers[1].ble_action, 'press');
  assert.strictEqual(decompiled.triggers[1].click_count, 2);
  assert.strictEqual(decompiled.triggers[2].ble_action, 'press');
  assert.strictEqual(decompiled.triggers[2].click_count, 3);
  assert.strictEqual(decompiled.triggers[3].ble_action, 'hold_2s');
  assert.strictEqual(decompiled.triggers[3].click_count, 1);
  assert.strictEqual(decompiled.triggers[4].type, 'ble_presence');
  assert.strictEqual(decompiled.triggers[4].source, 'ble');
  assert.strictEqual(decompiled.triggers[5].type, 'ble_presence');
  assert.strictEqual(decompiled.triggers[5].ble_event, 'present');
  assert.strictEqual(decompiled.conditions[0].ble_action, 'press');
  assert.strictEqual(decompiled.conditions[1].type, 'ble_presence');
  assert.strictEqual(decompiled.conditions[1].device_property, 'present');

  // Recompiling decompiled ble_device_event and Any-Beacon ble_beacon round-trips cleanly
  const recompiled = compileAutomationRule(decompiled, catalog);
  assert.strictEqual(recompiled.triggers[4].type, 'ble_device_event');
  assert.strictEqual(recompiled.triggers[4].ble_event, 'connected');
  assert.strictEqual(recompiled.triggers[4].ble_device, 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(recompiled.triggers[5].type, 'ble_beacon');
  assert.strictEqual(recompiled.conditions[1].type, 'ble_beacon');
  assert.strictEqual(recompiled.conditions[1].operator, 'greater_than_or_equal');
});

test('Regression: double round-trip (compile -> decompile -> compile) idempotency for AND/OR/NOT, mixed-command OR, and multi-child NOT', () => {
  const catalog = createMockCatalog(4);
  const rule: AutomationRule = {
    id: 'rule_double_rt_logic',
    name: 'Logic Groups Double Round-Trip',
    enabled: true,
    ha_expose: false,
    ha_icon: 'mdi:logic-gate',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [
      {
        id: 't_1',
        source: 'can',
        type: 'byte_transition',
        can_id: '0x101',
        bus: 0,
        byte: 'D1',
        mask: '0xFF',
        to: '0x01',
      },
    ],
    conditions: [
      {
        id: 'c_and',
        type: 'and',
        logic: 'and',
        for_sec: 3,
        conditions: [
          {
            id: 'c_and_1',
            type: 'can_state',
            can_id: '0x101',
            bus: 0,
            byte: 'D1',
            mask: '0xFF',
            operator: 'equal',
            value: '0x01',
            source_command_id: 'cmd_1',
          },
          {
            id: 'c_not_single',
            type: 'not',
            logic: 'not',
            conditions: [
              {
                id: 'c_not_single_child',
                type: 'can_state',
                can_id: '0x102',
                bus: 0,
                byte: 'D1',
                mask: '0xFF',
                operator: 'equal',
                value: '0x00',
              },
            ],
          },
        ],
      },
      {
        id: 'c_mixed_or',
        type: 'or',
        logic: 'or',
        conditions: [
          {
            id: 'c_or_cat',
            type: 'can_state',
            can_id: '0x103',
            bus: 0,
            byte: 'D1',
            mask: '0xFF',
            operator: 'equal',
            value: '0x01',
            source_command_id: 'cmd_3',
            option_label: 'On',
          },
          {
            id: 'c_or_volt',
            type: 'voltage',
            operator: 'greater',
            value: '13.1',
          },
        ],
      },
      {
        id: 'c_not_multi',
        type: 'not',
        logic: 'not',
        conditions: [
          {
            id: 'c_not_a',
            type: 'can_state',
            can_id: '0x101',
            bus: 0,
            byte: 'D1',
            mask: '0xFF',
            operator: 'equal',
            value: '0x00',
          },
          {
            id: 'c_not_b',
            type: 'voltage',
            operator: 'less',
            value: '11.8',
          },
        ],
      },
    ],
    actions: [
      {
        id: 'a_1',
        type: 'transmit',
        can_id: '0x201',
        bus: 0,
        payload: { D1: '0x01' },
      },
    ],
  };

  const compiled1 = compileAutomationRule(rule, catalog);
  // Verify multi-child NOT stays an array and mixed-command OR preserves non-catalog voltage child
  assert.ok(Array.isArray(compiled1.conditions[0].and));
  assert.strictEqual(compiled1.conditions[0].for_sec, 3);
  assert.strictEqual(compiled1.conditions[1].or.length, 2);
  assert.strictEqual(compiled1.conditions[1].or[1].type, 'voltage');
  assert.strictEqual(compiled1.conditions[1].or[1].value, 13.1);
  assert.ok(Array.isArray(compiled1.conditions[2].not));
  assert.strictEqual(compiled1.conditions[2].not.length, 2);

  const decompiled = decompileAutomationRule(compiled1, catalog);
  assert.strictEqual(decompiled.conditions[0].logic, 'and');
  assert.strictEqual(decompiled.conditions[1].logic, 'or');
  assert.strictEqual(decompiled.conditions[1].conditions?.length, 2);
  assert.strictEqual(decompiled.conditions[1].conditions?.[1].type, 'voltage');
  assert.strictEqual(decompiled.conditions[2].logic, 'not');
  assert.strictEqual(decompiled.conditions[2].conditions?.length, 2);

  const compiled2 = compileAutomationRule(decompiled, catalog);
  assert.deepStrictEqual(compiled2, compiled1);
});

test('Regression: action contracts (precondition, track_popup/popup, transmit_frame, delay_ms pacing, climate_target, hud_nav, non-catalog entity_command, dual-CAN action_bus)', () => {
  const dualCanCmd: Command = {
    id: 'dual_bus_cmd',
    name: 'Dual Bus Command',
    category: 'Chassis',
    roles: ['action'],
    network: {
      bus: 0,
      action_bus: 1,
      action_can_id: '0x390',
    },
    options: [
      { label: 'Trigger', payload: { D1: '0xAA', D2: '0x55' } },
    ],
  };
  const catalog: Catalog = {
    can_do_version: '1.0.0',
    vehicles: [],
    commands: [dualCanCmd],
  };

  // 1. precondition / battery_preconditioning including "Cancel / Off" -> stop
  const preconCancel = compileAction(
    { id: 'a_pre_cancel', type: 'battery_preconditioning' as any, option_label: 'Cancel / Off' },
    catalog
  );
  assert.deepStrictEqual(preconCancel, {
    id: 'a_pre_cancel',
    type: 'precondition',
    mode: 'cancel',
    action: 'stop',
  });

  const preconStart = compileAction(
    { id: 'a_pre_start', type: 'precondition', mode: 'continuous' } as any,
    catalog
  );
  assert.deepStrictEqual(preconStart, {
    id: 'a_pre_start',
    type: 'precondition',
    mode: 'continuous',
    action: 'start',
  });

  // 2. track_popup / popup aliases (message, popup_text, critical)
  const popupFromMessage = compileAction(
    { id: 'a_pop_1', type: 'popup' as any, message: 'Battery Low', level: 'critical' } as any,
    catalog
  );
  assert.deepStrictEqual(popupFromMessage, {
    id: 'a_pop_1',
    type: 'track_popup',
    level: 'critical',
    text: 'Battery Low',
  });

  const popupFromPopupText = compileAction(
    { id: 'a_pop_2', type: 'track_popup', popup_text: 'Preconditioning Active' } as any,
    catalog
  );
  assert.deepStrictEqual(popupFromPopupText, {
    id: 'a_pop_2',
    type: 'track_popup',
    level: 'info',
    text: 'Preconditioning Active',
  });

  // 3. transmit_frame alias + repeat pacing delay_ms
  const compiledTxFrame = compileAction(
    {
      id: 'a_tx_alias',
      type: 'transmit_frame' as any,
      can_id: '0x390',
      bus: 1,
      payload: { D1: '0x05' },
      repeat: 4,
      delay_ms: 120,
    },
    catalog
  );
  assert.strictEqual(compiledTxFrame.type, 'transmit');
  assert.strictEqual(compiledTxFrame.repeat, 4);
  assert.strictEqual(compiledTxFrame.delay_ms, 120);

  const decompiledTxAlias = decompileActionList(
    [{ id: 'a_tx_raw', type: 'transmit_frame', can_id: '0x391', bus: 0, payload: { D1: '0x07' }, repeat: 2, delay_ms: 75 }],
    catalog
  );
  assert.strictEqual(decompiledTxAlias.length, 1);
  assert.strictEqual(decompiledTxAlias[0].type, 'can_tx');
  assert.strictEqual(decompiledTxAlias[0].delay_ms, 75);

  // 4. climate_target (Fahrenheit conversion + extended fields)
  const compiledClimate = compileAction(
    {
      id: 'a_clim',
      type: 'climate_target',
      target_temp_f: 77,
      zone: 'passenger',
      defrost: true,
      sync_on: true,
      driver_only: false,
      monitor_0x38: true,
      duration_minutes: 15,
    } as any,
    catalog
  );
  assert.deepStrictEqual(compiledClimate, {
    id: 'a_clim',
    type: 'climate_target',
    target_temp_c: 25,
    defrost: true,
    duration_minutes: 15,
    zone: 'passenger',
    sync_on: true,
    driver_only: false,
    monitor_0x38: true,
  });

  // 5. hud_nav (lane_highlights, heading, omitted num_lanes, and clear)
  const compiledHud = compileAction(
    {
      id: 'a_hud',
      type: 'hud_nav',
      icon: 4,
      heading: 270,
      distance: 350,
      lane_highlights: [true, false, true],
      street: 'Main St',
    } as any,
    catalog
  );
  assert.strictEqual(compiledHud.type, 'hud_nav');
  assert.strictEqual(compiledHud.direction_deg, 270);
  assert.strictEqual(compiledHud.distance_meters, 350);
  assert.strictEqual(compiledHud.num_lanes, 3);
  assert.deepStrictEqual(compiledHud.lane_directions, [1, 1, 1]);
  assert.deepStrictEqual(compiledHud.lane_recommended, [1, 0, 1]);

  const compiledHudClear = compileAction(
    { id: 'a_hud_clr', type: 'hud_nav', action: 'clear' },
    catalog
  );
  assert.deepStrictEqual(compiledHudClear, {
    id: 'a_hud_clr',
    type: 'hud_nav',
    action: 'clear',
  });

  // 6. Non-catalog entity_command preserved across compile -> decompile -> compile
  const customEntity: AutomationAction = {
    id: 'a_custom_ent',
    type: 'entity_command',
    entity_id: 'custom_aux_relay',
    command: 'Pulse',
  };
  const compiledCustom = compileActionList([customEntity], catalog);
  assert.strictEqual(compiledCustom[0].type, 'entity_command');
  assert.strictEqual(compiledCustom[0].entity_id, 'custom_aux_relay');
  assert.strictEqual(compiledCustom[0].command, 'Pulse');
  const decompiledCustom = decompileActionList(compiledCustom, catalog);
  assert.strictEqual(decompiledCustom[0].type, 'entity_command');
  assert.strictEqual(decompiledCustom[0].entity_id, 'custom_aux_relay');
  assert.strictEqual(decompiledCustom[0].command, 'Pulse');

  // 7. Dual-CAN network.action_bus honored across converters
  assert.strictEqual(resolveActionBus(dualCanCmd), 1);
  const fromCmd = commandToAction(dualCanCmd, dualCanCmd.options![0]);
  assert.strictEqual(fromCmd.bus, 1);
  const compiledFromEntity = compileAction(
    { id: 'a_dual', type: 'entity_command', entity_id: 'dual_bus_cmd', command: 'Trigger' },
    catalog
  );
  assert.strictEqual(compiledFromEntity.bus, 1);
  assert.strictEqual(compiledFromEntity.can_id, '0x390');
});

test('Regression: trigger/condition contracts (byte_transition relational ops, can_rx numeric/multi-byte match, time defaults, BLE proximity empty UUID, press counts, default >= RSSI)', () => {
  const catalog = createMockCatalog(2);
  const compiled = compileAutomationRule(
    {
      id: 'rule_trig_cond_contracts',
      name: 'Trigger & Condition Contracts',
      enabled: true,
      ha_expose: false,
      ha_icon: 'mdi:radar',
      exec_mode: 'one_shot',
      cooldown_ms: 500,
      triggers: [
        {
          id: 't_rel_gt',
          source: 'can',
          type: 'byte_transition',
          can_id: '0x101',
          bus: 0,
          byte: 'D2',
          mask: '0xFF',
          operator: 'greater_than',
          from: '0x00',
          to: '0x40',
        },
        {
          id: 't_rel_lte',
          source: 'can',
          type: 'byte_transition',
          can_id: '0x101',
          bus: 0,
          byte: 'D3',
          mask: '0xFF',
          operator: 'less_than_or_equal',
          from: '0x10',
          to: '0x05',
        },
        {
          id: 't_can_rx',
          source: 'can',
          type: 'can_rx',
          can_id: '0x250',
          bus: 1,
          match: { D1: 16 as any, D3: '3f' },
          mask: { D1: '0xF0', D3: 255 } as any,
        },
        {
          id: 't_time_alias',
          source: 'time',
          type: 'time' as any,
          time: '06:45',
          days: [],
        },
        {
          id: 't_ble_prox_empty_uuid',
          source: 'ble',
          type: 'ble_presence',
          ble_event: 'proximity',
          beacon_uuid: '',
          target_rssi: -70,
        },
        {
          id: 't_single',
          source: 'ble',
          type: 'ble_button',
          ble_button: 'next_track',
          ble_action: 'single_press',
        },
        {
          id: 't_double',
          source: 'ble',
          type: 'ble_button',
          ble_button: 'next_track',
          ble_action: 'double_press',
        },
        {
          id: 't_triple',
          source: 'ble',
          type: 'ble_button',
          ble_button: 'next_track',
          ble_action: 'triple_press',
        },
      ],
      conditions: [
        {
          id: 'c_time_alias',
          type: 'time' as any,
          start_time: '09:00',
          end_time: '17:00',
        },
        {
          id: 'c_ble_rssi_default',
          type: 'ble_presence',
          device_property: 'beacon_rssi',
          target_rssi: -65,
        },
        {
          id: 'c_wifi_rssi_default',
          type: 'device_state',
          device_property: 'wifi_rssi',
          target_rssi: -72,
        },
      ],
      actions: [],
    },
    catalog
  );

  // Relational byte_transition omits `from`
  assert.strictEqual(compiled.triggers[0].operator, 'greater_than');
  assert.strictEqual(compiled.triggers[0].from, undefined);
  assert.strictEqual(compiled.triggers[1].operator, 'less_than_or_equal');
  assert.strictEqual(compiled.triggers[1].from, undefined);

  // can_rx numeric + multi-byte match & mask normalized
  assert.strictEqual(compiled.triggers[2].type, 'can_rx');
  assert.deepStrictEqual(compiled.triggers[2].match, { D1: '0x10', D3: '0x3F' });
  assert.deepStrictEqual(compiled.triggers[2].mask, { D1: '0xF0', D3: '0xFF' });

  // time alias expands to 7 days
  assert.strictEqual(compiled.triggers[3].type, 'time_schedule');
  assert.deepStrictEqual(compiled.triggers[3].days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

  // BLE proximity with empty beacon_uuid -> ble_beacon without empty beacon_uuid
  assert.strictEqual(compiled.triggers[4].type, 'ble_beacon');
  assert.strictEqual(compiled.triggers[4].ble_event, 'proximity');
  assert.strictEqual(compiled.triggers[4].beacon_uuid, undefined);
  assert.strictEqual(compiled.triggers[4].target_rssi, -70);

  // single/double/triple press normalization
  assert.strictEqual(compiled.triggers[5].ble_action, 'press');
  assert.strictEqual(compiled.triggers[5].click_count, undefined);
  assert.strictEqual(compiled.triggers[6].ble_action, 'press');
  assert.strictEqual(compiled.triggers[6].click_count, 2);
  assert.strictEqual(compiled.triggers[7].ble_action, 'press');
  assert.strictEqual(compiled.triggers[7].click_count, 3);

  // time condition alias -> time_condition with 7 days
  assert.strictEqual(compiled.conditions[0].type, 'time_condition');
  assert.deepStrictEqual(compiled.conditions[0].days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

  // default >= RSSI operator on BLE & Wi-Fi conditions
  assert.strictEqual(compiled.conditions[1].type, 'ble_beacon');
  assert.strictEqual(compiled.conditions[1].operator, 'greater_than_or_equal');
  assert.strictEqual(compiled.conditions[2].type, 'device_state');
  assert.strictEqual(compiled.conditions[2].operator, 'greater_than_or_equal');
});

test('Regression: malformed-JSON defensive handling (null/primitives, array/{hex} payloads, !0x.. negated bytes, NaN/Infinity/negative numbers, non-string id/command/option_label)', () => {
  const catalog = createMockCatalog(2);

  // 1. Array and { hex } payloads in compileToByteMap + !0x.. negated bytes
  assert.deepStrictEqual(
    compileToByteMap([0x10, 255, null, '3f', -5, Number.NaN, Number.POSITIVE_INFINITY, '0x0a']),
    { D1: '0x10', D2: '0xFF', D4: '0x3F', D8: '0x0A' }
  );
  assert.deepStrictEqual(
    compileToByteMap({ hex: '10 20 ?? 3f' }),
    { D1: '0x10', D2: '0x20', D4: '0x3F' }
  );
  assert.strictEqual(formatHexByte('!0x00', true), '!0x00');
  assert.strictEqual(formatHexByte('!0x00', false), undefined);
  assert.deepStrictEqual(compileToByteMap({ D1: '!0x00', D2: '0x01' }, true), { D1: '!0x00', D2: '0x01' });
  assert.deepStrictEqual(compileToByteMap({ D1: '!0x00', D2: '0x01' }, false), { D2: '0x01' });

  // 2. NaN / Infinity / negative numeric inputs
  assert.strictEqual(formatHexByte(Number.NaN), undefined);
  assert.strictEqual(formatHexByte(Number.POSITIVE_INFINITY), undefined);
  assert.strictEqual(formatHexByte(Number.NEGATIVE_INFINITY), undefined);
  assert.strictEqual(formatHexByte(-1), undefined);
  assert.strictEqual(formatHexByte(256), undefined);
  assert.strictEqual(formatCanId(Number.NaN), '');
  assert.strictEqual(formatCanId(Number.POSITIVE_INFINITY), '');

  // 3. null / primitive elements across rules, triggers, conditions, actions, choices, steps, and non-string id/command/option_label
  const malformedRule: any = {
    id: 12345,
    name: 'Malformed Rule',
    cooldown_ms: -999,
    trigger_window_ms: Number.POSITIVE_INFINITY,
    triggers: [
      null,
      'bad_trigger',
      42,
      {
        id: 777,
        source: 'can',
        type: 'byte_transition',
        can_id: '0x101',
        byte: 'D1',
        to: '0x01',
        option_label: { nested: true },
        for_sec: Number.NaN,
        target_rssi: Number.NEGATIVE_INFINITY,
      },
    ],
    conditions: [
      null,
      false,
      'bad_cond',
      {
        id: 888,
        type: 'can_state',
        can_id: '0x101',
        byte: 'D1',
        value: '0x01',
        option_label: 999,
      },
    ],
    actions: [
      null,
      123,
      'bad_action',
      {
        id: 999,
        type: 'delay',
        delay_ms: -500,
      },
      {
        id: 'a_choose',
        type: 'choose',
        choices: [
          null,
          'bad_choice',
          {
            label: 'Valid Branch',
            conditions: [null, 'bad', { type: 'can_state', can_id: '0x101', byte: 'D1', value: '0x01' }],
            sequence: [null, 42, { type: 'delay', ms: Number.NaN }],
          },
        ],
        default: [null, 'bad'],
      },
      {
        id: 'a_steps',
        type: 'transmit',
        can_id: '0x201',
        bus: 0,
        steps: [null, 'bad_step', { payload: [0x01, 0x02], delay_ms: Number.POSITIVE_INFINITY }, { payload: { hex: '03 04' }, delay_ms: -10 }],
      },
      {
        id: 'a_ent_non_str',
        type: 'entity_command',
        entity_id: 'cmd_1',
        command: 42,
        option_label: { invalid: 1 },
      },
    ],
  };

  const decompiledRules = decompileAutomationRules([null, 42, 'invalid', malformedRule] as any, catalog);
  assert.strictEqual(decompiledRules.length, 1);
  assert.strictEqual(decompiledRules[0].triggers.length, 1);
  assert.strictEqual(decompiledRules[0].conditions.length, 1);
  assert.ok(decompiledRules[0].actions.length >= 1);
  assert.strictEqual(decompiledRules[0].cooldown_ms, 0);

  const exportedJson = exportToCandoJson([null, 'bad', decompiledRules[0]] as any, {}, catalog);
  const parsedExport = JSON.parse(exportedJson);
  assert.strictEqual(parsedExport.rules.length, 1);
  assert.strictEqual(parsedExport.rules[0].cooldown_ms, 0);
  assert.strictEqual(parsedExport.rules[0].triggers.length, 1);
  assert.strictEqual(parsedExport.rules[0].conditions.length, 1);
});

test('Regression: Task 2 & 3 fixes (vehicle variant threading, cond.invert, applyOptionsToCondition cmd.mask, payload key-order dedup, _step_group_id nested repeat_until/wait_for, regenerateActionIds singular condition, and cross-paste field/op preservation)', () => {
  const ev6Vehicle: Vehicle = {
    id: 'kia_ev6_2024',
    name: '2024 Kia EV6 GT-Line',
    make: 'Kia',
    model: 'EV6',
    trim: 'GT-Line',
    region: 'US',
    family: 'egmp',
    years: [2024],
    features: [],
  };
  const variantCmd: Command = {
    id: 'variant_seat_cmd',
    name: 'Seat Heater',
    category: 'Comfort',
    roles: ['trigger', 'action'],
    network: {
      bus: 0,
      state_can_id: '0x210',
      action_can_id: '0x211',
    },
    mask: '0x0F',
    options: [
      { label: 'Off', payload: { D1: '0x00' }, match: { D1: '0x00' } },
      { label: 'High', payload: { D1: '0x03' }, match: { D1: '0x03' } },
    ],
    variants: [
      {
        targets: ['hyundai_ioniq5_2022'],
        network: {
          bus: 0,
          state_can_id: '0x210',
          action_can_id: '0x211',
        },
        options: [
          { label: 'Off', payload: { D1: '0x00' }, match: { D1: '0x00' } },
          { label: 'High', payload: { D1: '0x03' }, match: { D1: '0x03' } },
        ],
      },
      {
        targets: ['kia_ev6_2024'],
        network: {
          bus: 1,
          state_can_id: '0x310',
          action_can_id: '0x311',
        },
        options: [
          { label: 'Off', payload: { D1: '0x00' }, match: { D1: '0x00' } },
          { label: 'High', payload: { D1: '0x09' }, match: { D1: '0x09' } },
        ],
      },
    ],
  };
  const catalog: Catalog = { can_do_version: '1.0.0', vehicles: [ev6Vehicle], commands: [variantCmd] };

  // 1. Vehicle variant resolution threaded through exportToCandoJson / compileAutomationRule / decompileAutomationRule
  const baseRule: AutomationRule = {
    id: 'rule_variant',
    name: 'Variant Test',
    enabled: true,
    ha_expose: false,
    ha_icon: 'mdi:car-seat-heater',
    exec_mode: 'one_shot',
    cooldown_ms: 500,
    triggers: [commandToTrigger(variantCmd, undefined, ev6Vehicle)],
    conditions: [],
    actions: [{ id: 'a_var', type: 'entity_command', entity_id: 'variant_seat_cmd', command: 'High' }],
  };

  const exportedDefault = JSON.parse(exportToCandoJson([baseRule], {}, catalog));
  const exportedEv6 = JSON.parse(exportToCandoJson([baseRule], {}, catalog, ev6Vehicle));
  assert.strictEqual(exportedDefault.rules[0].actions[0].can_id, '0x211');
  assert.deepStrictEqual(exportedDefault.rules[0].actions[0].payload, { D1: '0x03' });
  assert.strictEqual(exportedEv6.rules[0].actions[0].can_id, '0x311');
  assert.strictEqual(exportedEv6.rules[0].actions[0].bus, 1);
  assert.deepStrictEqual(exportedEv6.rules[0].actions[0].payload, { D1: '0x09' });

  const decompiledEv6 = decompileAutomationRule(exportedEv6.rules[0], catalog, ev6Vehicle);
  assert.strictEqual(decompiledEv6.actions[0].source_command_id, 'variant_seat_cmd');
  assert.strictEqual(decompiledEv6.actions[0].option_label, 'High');

  // 2. compileCondition inverts equal <-> not_equal when invert === true, leaves relational ops intact
  const invEq = compileCondition({
    id: 'c_inv_eq',
    type: 'can_state',
    can_id: '0x210',
    byte: 'D1',
    value: '0x03',
    operator: 'equal',
    invert: true,
  });
  assert.strictEqual(invEq.operator, 'not_equal');

  const invNeq = compileCondition({
    id: 'c_inv_neq',
    type: 'can_state',
    can_id: '0x210',
    byte: 'D1',
    value: '0x03',
    operator: 'not_equal',
    invert: true,
  });
  assert.strictEqual(invNeq.operator, 'equal');

  const invGt = compileCondition({
    id: 'c_inv_gt',
    type: 'can_state',
    can_id: '0x210',
    byte: 'D1',
    value: '0x03',
    operator: 'greater_than',
    invert: true,
  });
  assert.strictEqual(invGt.operator, 'greater_than');

  // 3. applyOptionsToCondition inherits command-level cmd.mask
  const multiOptCond = applyOptionsToCondition(
    { id: 'c_mask', type: 'can_state', can_id: '0x210' },
    variantCmd,
    [variantCmd.options![1]],
    null
  );
  assert.strictEqual(multiOptCond.mask, '0x0F');
  const singleOptCond = applyOptionToCondition(
    { id: 'c_mask_single', type: 'can_state', can_id: '0x210' },
    variantCmd,
    variantCmd.options![1],
    null
  );
  assert.strictEqual(singleOptCond.mask, '0x0F');

  // 4. Key-order-independent payload matching & custom catalog forwarding in matchAndConsumeRemainingCatalogSteps
  const multiStepCmd: Command = {
    id: 'custom_two_step_cmd',
    name: 'Custom Two Step',
    category: 'General',
    roles: ['action'],
    network: { bus: 0, action_can_id: '0x400', delay_ms: 20 },
    options: [
      {
        label: 'Activate',
        steps: [
          { payload: { D1: '0x01', D2: '0x02' }, repeat: 2 },
          { payload: { D1: '0x00', D2: '0xFF' }, repeat: 1 },
        ],
      },
    ],
  };
  const customCatalog: Catalog = { can_do_version: '1.0.0', vehicles: [ev6Vehicle], commands: [variantCmd, multiStepCmd] };
  const coalescedReversedKeys = decompileActionList(
    [
      {
        type: 'transmit',
        can_id: '0x400',
        bus: 0,
        payload: { D2: '0x02', D1: '0x01' },
        repeat: 2,
        source_command_id: 'custom_two_step_cmd',
        option_label: 'Activate',
      },
      { type: 'delay', ms: 20 },
      { type: 'transmit', can_id: '0x400', bus: 0, payload: { D2: '0xFF', D1: '0x00' }, repeat: 1 },
      { type: 'delay', ms: 20 },
      { type: 'transmit', can_id: '0x400', bus: 0, payload: { D1: '0x00', D2: '0xFF' }, repeat: 1 },
    ],
    customCatalog
  );
  assert.strictEqual(coalescedReversedKeys.length, 1);
  assert.strictEqual(coalescedReversedKeys[0].source_command_id, 'custom_two_step_cmd');
  assert.strictEqual(coalescedReversedKeys[0].steps?.length, 2);

  // 5. _step_group_id containing transmit + repeat_until / wait_for is recursively decompiled
  const nestedInGroup = decompileActionList(
    [
      {
        id: 'act_tx_in_grp',
        _step_group_id: 'grp_nested',
        type: 'transmit',
        can_id: '0x311',
        bus: 1,
        payload: { D1: '0x09' },
        repeat: 1,
      },
      {
        id: 'act_wait_in_grp',
        _step_group_id: 'grp_nested',
        type: 'wait_for',
        interval_ms: 100,
        timeout_ms: 5000,
        condition: { can_id: '0x310', bus: 1, byte: 'D1', mask: '0x0F', operator: 'equal', value: '0x09' },
      },
      {
        id: 'act_rep_in_grp',
        _step_group_id: 'grp_nested',
        type: 'repeat_until',
        interval_ms: 250,
        timeout_ms: 8000,
        condition: { can_id: '0x310', bus: 1, byte: 'D1', mask: '0x0F', operator: 'equal', value: '0x00' },
        sequence: [{ type: 'transmit', can_id: '0x311', bus: 1, payload: { D1: '0x09' } }],
      },
    ],
    catalog,
    0,
    ev6Vehicle
  );
  assert.strictEqual(nestedInGroup.length, 1);
  assert.strictEqual(nestedInGroup[0].steps?.length, 3);
  const waitStep: any = nestedInGroup[0].steps?.[1];
  const repStep: any = nestedInGroup[0].steps?.[2];
  assert.strictEqual(waitStep.type, 'wait_for');
  assert.strictEqual(waitStep._step_group_id, undefined);
  assert.strictEqual(waitStep.conditions?.length, 1);
  assert.strictEqual(waitStep.conditions[0].can_id, '0x310');
  assert.strictEqual(repStep.type, 'repeat_until');
  assert.strictEqual(repStep._step_group_id, undefined);
  assert.strictEqual(repStep.sequence?.length, 1);
  assert.strictEqual(repStep.sequence[0].source_command_id, 'variant_seat_cmd');

  // 6. regenerateActionIds regenerates singular clone.condition
  const waitAction: AutomationAction = {
    id: 'act_orig_wait',
    type: 'wait_for',
    condition: {
      id: 'cond_orig_singular',
      _clientId: 'client_orig_singular',
      type: 'can_state',
      can_id: '0x210',
      byte: 'D1',
      value: '0x03',
    },
  };
  const regenWait = regenerateActionIds(waitAction);
  assert.notStrictEqual(regenWait.id, waitAction.id);
  assert.ok(regenWait.condition);
  assert.notStrictEqual(regenWait.condition!.id, 'cond_orig_singular');
  assert.notStrictEqual(regenWait.condition!._clientId, 'client_orig_singular');
  assert.strictEqual(waitAction.condition!.id, 'cond_orig_singular');

  // 7. convertTriggerToCondition & convertConditionToTrigger preserve relational ops & map Wi-Fi/BLE/time/voltage
  const relTrig: AutomationTrigger = {
    id: 't_rel',
    source: 'can',
    type: 'byte_transition',
    can_id: '0x380',
    byte: 'D2',
    operator: 'greater_than',
    to: '0x2A',
  };
  const relCond = convertTriggerToCondition(relTrig);
  assert.strictEqual(relCond.type, 'can_state');
  assert.strictEqual(relCond.operator, 'greater_than');
  assert.strictEqual(relCond.value, '0x2A');

  const relBackTrig = convertConditionToTrigger({ ...relCond, operator: 'equal', invert: true });
  assert.strictEqual(relBackTrig.type, 'byte_transition');
  assert.strictEqual(relBackTrig.operator, 'not_equal');

  const wifiTrig: AutomationTrigger = {
    id: 't_wifi',
    source: 'wifi',
    type: 'wifi_event',
    wifi_event: 'ap_client_connected',
    client_mac: 'AA:BB:CC:DD:EE:FF',
  };
  const wifiCond = convertTriggerToCondition(wifiTrig);
  assert.strictEqual(wifiCond.type, 'device_state');
  assert.strictEqual(wifiCond.device_property, 'ap_client_connected');
  assert.strictEqual(wifiCond.target_string, 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(wifiCond.target_bool, true);

  const wifiBackTrig = convertConditionToTrigger(wifiCond);
  assert.strictEqual(wifiBackTrig.type, 'wifi_event');
  assert.strictEqual(wifiBackTrig.wifi_event, 'ap_client_connected');
  assert.strictEqual(wifiBackTrig.client_mac, 'AA:BB:CC:DD:EE:FF');

  const wifiSsidCond = convertTriggerToCondition({
    id: 't_wifi_ssid',
    source: 'wifi',
    type: 'wifi_event',
    wifi_event: 'wifi_disconnected',
    ssid: 'HomeNet',
  });
  assert.strictEqual(wifiSsidCond.device_property, 'wifi_connected');
  assert.strictEqual(wifiSsidCond.target_string, 'HomeNet');
  assert.strictEqual(wifiSsidCond.target_bool, false);
  const wifiSsidBack = convertConditionToTrigger(wifiSsidCond);
  assert.strictEqual(wifiSsidBack.wifi_event, 'wifi_disconnected');
  assert.strictEqual(wifiSsidBack.ssid, 'HomeNet');

  const bleProxCond = convertTriggerToCondition({
    id: 't_ble_prox',
    source: 'ble',
    type: 'ble_presence',
    ble_event: 'proximity',
    beacon_uuid: 'UUID-1234',
    target_rssi: -66,
  });
  assert.strictEqual(bleProxCond.type, 'ble_presence');
  assert.strictEqual(bleProxCond.device_property, 'beacon_rssi');
  assert.strictEqual(bleProxCond.target_string, 'UUID-1234');
  assert.strictEqual(bleProxCond.operator, 'greater_than_or_equal');
  const bleProxBack = convertConditionToTrigger(bleProxCond);
  assert.strictEqual(bleProxBack.type, 'ble_presence');
  assert.strictEqual(bleProxBack.ble_event, 'proximity');
  assert.strictEqual(bleProxBack.beacon_uuid, 'UUID-1234');

  const timeCond = convertTriggerToCondition({
    id: 't_time',
    source: 'time',
    type: 'time_schedule',
    time: '07:15',
    days: ['mon', 'fri'],
  });
  assert.strictEqual(timeCond.type, 'time_condition');
  assert.strictEqual(timeCond.start_time, '07:15');
  assert.deepStrictEqual(timeCond.days, ['mon', 'fri']);
  const timeBack = convertConditionToTrigger(timeCond);
  assert.strictEqual(timeBack.type, 'time_schedule');
  assert.strictEqual(timeBack.time, '07:15');
  assert.deepStrictEqual(timeBack.days, ['mon', 'fri']);

  const voltCond = convertTriggerToCondition({
    id: 't_volt',
    source: 'voltage',
    type: 'voltage',
    voltage_val: '11.9',
    voltage_dir: 'below',
  });
  assert.strictEqual(voltCond.type, 'voltage');
  assert.strictEqual(voltCond.operator, 'less');
  assert.strictEqual(voltCond.value, '11.9');
  assert.strictEqual(voltCond.voltage_dir, 'below');
  const voltBack = convertConditionToTrigger(voltCond);
  assert.strictEqual(voltBack.type, 'voltage');
  assert.strictEqual(voltBack.operator, 'less');
  assert.strictEqual(voltBack.voltage_val, '11.9');
  assert.strictEqual(voltBack.voltage_dir, 'below');
});


