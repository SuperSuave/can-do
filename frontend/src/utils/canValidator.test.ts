import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPayloadToken,
  validatePayloadString,
  validatePayload,
  validateCommand,
  validateAutomationRule,
  validateAutomationRules
} from './canValidator.js';
import { AutomationRule } from '../types/automation.js';
import { DEFAULT_CATALOG } from '../data/defaultCatalog.js';
import { DEFAULT_AUTOMATION_RULES } from '../data/defaultAutomations.js';

test('validatePayloadString handles empty, undefined, and whitespace inputs', () => {
  assert.deepStrictEqual(validatePayloadString(undefined), { isValid: true, byteCount: 0 });
  assert.deepStrictEqual(validatePayloadString(''), { isValid: true, byteCount: 0 });
  assert.deepStrictEqual(validatePayloadString('   '), { isValid: true, byteCount: 0 });
});

test('validatePayloadString validates continuous hex strings with and without 0x prefix', () => {
  // 8-byte standard frame (16 chars)
  const res1 = validatePayloadString('0102030405060708');
  assert.strictEqual(res1.isValid, true);
  assert.strictEqual(res1.byteCount, 8);

  // With 0x prefix
  const res2 = validatePayloadString('0x0102030405060708');
  assert.strictEqual(res2.isValid, true);
  assert.strictEqual(res2.byteCount, 8);

  // 4-byte frame uppercase/lowercase
  const res3 = validatePayloadString('0xDEADBEEF');
  assert.strictEqual(res3.isValid, true);
  assert.strictEqual(res3.byteCount, 4);

  const res4 = validatePayloadString('cafe0011');
  assert.strictEqual(res4.isValid, true);
  assert.strictEqual(res4.byteCount, 4);
});

test('validatePayloadString validates space-separated hex bytes', () => {
  const res1 = validatePayloadString('01 02 03 04 05 06 07 08');
  assert.strictEqual(res1.isValid, true);
  assert.strictEqual(res1.byteCount, 8);

  // Multiple spaces between tokens
  const res2 = validatePayloadString('AA   BB    CC  DD');
  assert.strictEqual(res2.isValid, true);
  assert.strictEqual(res2.byteCount, 4);
});

test('validatePayloadString accepts valid wildcards and negated tokens in space-separated payload', () => {
  // Full wildcard (*), nibble wildcards (*0, 0*, *F, F*), and negated bytes (!00, !FF)
  const payload = '01 * *0 0* *F F* !00 !FF';
  const res = validatePayloadString(payload);
  assert.strictEqual(res.isValid, true);
  assert.strictEqual(res.byteCount, 8);
});

test('validatePayloadString rejects invalid tokens and reports error with position', () => {
  // Non-hex token 'ZZ' at position 3
  const res1 = validatePayloadString('01 02 ZZ 04');
  assert.strictEqual(res1.isValid, false);
  assert.strictEqual(res1.byteCount, 4);
  assert.match(res1.error ?? '', /Invalid byte token 'ZZ' at position 3/);

  // 3-digit hex '123' at position 2
  const res2 = validatePayloadString('01 123 03');
  assert.strictEqual(res2.isValid, false);
  assert.match(res2.error ?? '', /Invalid byte token '123' at position 2/);

  // Odd length hex string without spaces
  const res3 = validatePayloadString('123');
  assert.strictEqual(res3.isValid, false);
  assert.match(res3.error ?? '', /Invalid byte token '123'/);

  // Stray characters '-'
  const res4 = validatePayloadString('01 - 03');
  assert.strictEqual(res4.isValid, false);
  assert.match(res4.error ?? '', /Invalid byte token '-'/);
});

test('validatePayloadString rejects payloads exceeding 4096 transport limit', () => {
  const hugePayload = Array(4097).fill('00').join(' ');
  const res = validatePayloadString(hugePayload);
  assert.strictEqual(res.isValid, false);
  assert.strictEqual(res.byteCount, 4097);
  assert.match(res.error ?? '', /Payload exceeds maximum transport limit/);
});

test('isValidPayloadToken validates individual token formats correctly', () => {
  // Valid tokens
  assert.strictEqual(isValidPayloadToken('*'), true);
  assert.strictEqual(isValidPayloadToken('*0'), true);
  assert.strictEqual(isValidPayloadToken('0*'), true);
  assert.strictEqual(isValidPayloadToken('*F'), true);
  assert.strictEqual(isValidPayloadToken('A*'), true);
  assert.strictEqual(isValidPayloadToken('!00'), true);
  assert.strictEqual(isValidPayloadToken('!FF'), true);
  assert.strictEqual(isValidPayloadToken('00'), true);
  assert.strictEqual(isValidPayloadToken('FF'), true);
  assert.strictEqual(isValidPayloadToken('1a'), true);

  // Invalid tokens
  assert.strictEqual(isValidPayloadToken(''), false);
  assert.strictEqual(isValidPayloadToken('***'), false);
  assert.strictEqual(isValidPayloadToken('**'), false);
  assert.strictEqual(isValidPayloadToken('!0'), false);
  assert.strictEqual(isValidPayloadToken('!FFF'), false);
  assert.strictEqual(isValidPayloadToken('123'), false);
  assert.strictEqual(isValidPayloadToken('G'), false);
  assert.strictEqual(isValidPayloadToken('ZZ'), false);
});

test('validatePayload handles ByteMap and hex object formats', () => {
  // Object with 'hex' key
  const hexObj = validatePayload({ hex: '0x01020304' });
  assert.strictEqual(hexObj.isValid, true);
  assert.strictEqual(hexObj.byteCount, 4);

  // Object with odd hex length is rejected
  const badHexObj = validatePayload({ hex: '123' });
  assert.strictEqual(badHexObj.isValid, false);

  // D1..D8 ByteMap
  const byteMap = validatePayload({ D1: '0x01', D2: '0x02', D8: '!FF' });
  assert.strictEqual(byteMap.isValid, true);
  assert.strictEqual(byteMap.byteCount, 3);

  // Invalid key in ByteMap
  const badKeyMap = validatePayload({ D0: '0x01' });
  assert.strictEqual(badKeyMap.isValid, false);
});

test('validateAutomationRules passes DEFAULT_AUTOMATION_RULES with zero issues', () => {
  const report = validateAutomationRules(DEFAULT_AUTOMATION_RULES, DEFAULT_CATALOG);
  assert.strictEqual(report.isValid, true);
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.warnings.length, 0);
});

test('validateAutomationRule catches 1-based byte errors, bad CAN IDs, and wildcards on edge', () => {
  const brokenRule: AutomationRule = {
    id: 'bad_rule',
    name: 'Broken CAN Rule',
    enabled: true,
    ha_expose: false,
    ha_icon: 'mdi:car',
    exec_mode: 'one_shot',
    cooldown_ms: 0,
    triggers: [
      {
        id: 't1',
        source: 'can',
        type: 'byte_transition',
        can_id: 'NOT_HEX',
        byte: 'D0',
        from: '*',
        to: '0x10'
      }
    ],
    conditions: [
      {
        id: 'c1',
        type: 'can_state',
        can_id: '0x4A2',
        byte: 'D9',
        value: '0xGG'
      }
    ],
    actions: [
      {
        id: 'a1',
        type: 'can_tx',
        can_id: '0x4A2',
        payload: { D1: '0x**' }
      }
    ]
  };

  const issues = validateAutomationRule(brokenRule, DEFAULT_CATALOG);
  const errors = issues.filter(i => i.type === 'error');
  assert.ok(errors.some(e => e.section === 'trigger' && /CAN ID/i.test(e.message)));
  assert.ok(errors.some(e => e.section === 'trigger' && /D0.*D1–D8/i.test(e.message)));
  assert.ok(errors.some(e => e.section === 'trigger' && /Wildcard/i.test(e.message)));
  assert.ok(errors.some(e => e.section === 'condition' && /D9.*D1–D8/i.test(e.message)));
  assert.ok(errors.some(e => e.section === 'condition' && /0xGG/i.test(e.message)));
  assert.ok(errors.some(e => e.section === 'action' && /Wildcard/i.test(e.message)));
});

test('validateAutomationRule validates cycle_entity, control flow, and multi-trigger warnings', () => {
  const rule: AutomationRule = {
    id: 'cycle_check',
    name: 'Cycle + Flow Check',
    enabled: true,
    ha_expose: true,
    ha_icon: 'mdi:car-seat-heater',
    exec_mode: 'one_shot',
    trigger_mode: 'sequence',
    cooldown_ms: 500,
    triggers: [
      { id: 't1', source: 'ble', type: 'ble_button', ble_button: 'volume_up' }
    ],
    conditions: [],
    actions: [
      {
        id: 'a_cycle_empty',
        type: 'cycle_entity',
        entity_id: 'nonexistent_entity',
        states: []
      },
      {
        id: 'a_if',
        type: 'if_then',
        conditions: [],
        then: [],
        else: []
      },
      {
        id: 'a_wait',
        type: 'wait_for',
        timeout_ms: 5000
      },
      {
        id: 'a_hud',
        type: 'hud_nav',
        nav_action: 'update',
        icon: 1,
        num_lanes: 12
      }
    ]
  };

  const populatedCatalog = {
    ...DEFAULT_CATALOG,
    commands: [
      {
        id: 'drivers_seat_comfort',
        name: 'Driver Seat Comfort',
        category: 'Climate',
        roles: ['action' as const],
        state_can_id: '0x4A2',
        action_can_id: '0x4A2'
      }
    ]
  };
  const issues = validateAutomationRule(rule, populatedCatalog);
  assert.ok(issues.some(i => i.type === 'warning' && /2 or more triggers/i.test(i.message)));
  assert.ok(issues.some(i => i.type === 'warning' && /not found in the active catalog/i.test(i.message)));
  assert.ok(issues.some(i => i.type === 'error' && /0 states selected/i.test(i.message)));
  assert.ok(issues.some(i => i.type === 'error' && /no actions in either Then or Else/i.test(i.message)));
  assert.ok(issues.some(i => i.type === 'error' && /requires at least one stop condition/i.test(i.message)));
  assert.ok(issues.some(i => i.type === 'error' && /between 0 and 8/i.test(i.message)));
});

test('validateAutomationRules detects duplicate rule IDs and groups issues cleanly', () => {
  const baseRule = DEFAULT_AUTOMATION_RULES[0];
  const dupReport = validateAutomationRules([baseRule, { ...baseRule }], DEFAULT_CATALOG);
  assert.strictEqual(dupReport.isValid, false);
  assert.strictEqual(dupReport.errors.length, 2);
  assert.ok(dupReport.issuesByRuleId[baseRule.id]?.length === 2);
  assert.match(dupReport.errors[0].message, /Duplicate rule ID/i);
});

test('validateAutomationRule enforces 50-character cluster popup toast limit (incl. 2-char severity icon)', () => {
  const baseRule: AutomationRule = {
    id: 'popup_len_check',
    name: 'Popup Length Check',
    enabled: true,
    ha_expose: false,
    ha_icon: 'mdi:message-alert',
    exec_mode: 'one_shot',
    cooldown_ms: 0,
    triggers: [{ id: 't1', source: 'ble', type: 'ble_button', ble_button: 'volume_up' }],
    conditions: [],
    actions: [
      {
        id: 'a_pop_ok',
        type: 'track_popup',
        level: 'info',
        text: 'A'.repeat(48) // 48 + 2 ("ⓘ ") = 50 chars -> valid
      },
      {
        id: 'a_pop_too_long',
        type: 'track_popup',
        level: 'warning',
        text: 'B'.repeat(49) // 49 + 2 ("⚠ ") = 51 chars -> invalid
      },
      {
        id: 'a_cycle_ok',
        type: 'cycle_entity',
        entity_id: 'drivers_seat_comfort',
        states: ['Off', 'High Heat'],
        show_popup: true,
        popup_prefix: 'Seat: ' // "Seat: High Heat" = 15 + 2 = 17 chars -> valid
      },
      {
        id: 'a_cycle_too_long',
        type: 'cycle_entity',
        entity_id: 'drivers_seat_comfort',
        states: ['Off', 'High Ventilation Cooling Mode'],
        show_popup: true,
        popup_prefix: 'Front Passenger Seat Comfort: ' // 30 + 29 + 2 = 61 chars -> invalid
      },
      {
        id: 'a_cycle_muted_ok',
        type: 'cycle_entity',
        entity_id: 'drivers_seat_comfort',
        states: ['Off', 'High Ventilation Cooling Mode'],
        show_popup: false,
        popup_prefix: 'Front Passenger Seat Comfort: '
      }
    ]
  };

  const issues = validateAutomationRule(baseRule, DEFAULT_CATALOG);
  const popupErrors = issues.filter(i => i.type === 'error' && /50-character cluster limit/i.test(i.message));
  assert.strictEqual(popupErrors.length, 2, 'Should flag both oversized track_popup and oversized enabled cycle_entity toast');
  assert.ok(popupErrors.some(e => e.field === 'text' && /51 characters/i.test(e.message)));
  assert.ok(popupErrors.some(e => e.field === 'popup_prefix' && /High Ventilation Cooling Mode/.test(e.message)));
});

test('validateCommand validates network.mitm configuration and flags invalid rules', () => {
  const validCmd = {
    id: 'test_mitm_cmd',
    name: 'Test MITM Command',
    category: 'Cockpit & Controls',
    roles: ['action' as const],
    network: {
      bus: 0,
      action_bus: 0,
      type: 'can_tx',
      action_can_id: '0x6E0',
      mitm: {
        mode: 'on_demand' as const,
        source_bus: 1,
        target_bus: 0,
        block_can_ids: ['0x6E0'],
        reverse_block_can_ids: ['0x6BE'],
        match: { D1: '0x10' },
        mask: '0xFF',
        hold_ms: 5000,
      },
    },
  };
  const okIssues = validateCommand(validCmd, DEFAULT_CATALOG);
  assert.strictEqual(okIssues.filter(i => i.type === 'error' || i.type === 'warning').length, 0);

  const brokenCmd = {
    id: 'bad_mitm_cmd',
    name: 'Bad MITM Command',
    category: 'Cockpit & Controls',
    roles: ['action' as const],
    network: {
      bus: 0,
      action_bus: 9,
      type: 'can_tx',
      action_can_id: '0x4E8',
      mitm: {
        mode: 'always' as const,
        source_bus: 1,
        target_bus: 1,
        block_can_ids: ['INVALID_HEX'],
        reverse_block_can_ids: ['0xZZ'],
        mask: '0xZZ',
        hold_ms: -10,
      },
    },
  };
  const badIssues = validateCommand(brokenCmd, DEFAULT_CATALOG);
  const errors = badIssues.filter(i => i.type === 'error');
  assert.ok(errors.some(e => e.field === 'action_bus'));
  assert.ok(errors.some(e => e.field === 'network.mitm.target_bus' && /must be different/i.test(e.message)));
  assert.ok(errors.some(e => e.field === 'network.mitm.block_can_ids[0]'));
  assert.ok(errors.some(e => e.field === 'network.mitm.reverse_block_can_ids[0]'));
  assert.ok(errors.some(e => e.field === 'network.mitm.mask'));
  assert.ok(errors.some(e => e.field === 'network.mitm.hold_ms'));

  const emptyBlockCmd = {
    id: 'empty_mitm_ids',
    name: 'Empty MITM IDs',
    category: 'Cockpit & Controls',
    roles: ['action' as const],
    network: {
      bus: 0,
      type: 'can_tx',
      action_can_id: '0x4E8',
      mitm: {
        mode: 'on_demand' as const,
        source_bus: 1,
        target_bus: 0,
      },
    },
  };
  const warnIssues = validateCommand(emptyBlockCmd, DEFAULT_CATALOG);
  assert.ok(warnIssues.some(i => i.type === 'warning' && /no forward or reverse block CAN IDs/i.test(i.message)));
});

