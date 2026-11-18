import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrayMove,
  canAcceptGlobalPasteTarget,
  isClipboardCompatibleWithTarget,
  serializeClipboardEnvelope,
  parseClipboardText,
  resolveClipboardPaste,
  setActiveScopedDrag,
  getActiveScopedDrag
} from './automationClipboard';
import { AutomationClipboardItem } from '../types/automation';

test('arrayMove reorders immutably and handles out-of-bounds safely', () => {
  const original = ['a', 'b', 'c', 'd'];
  const movedForward = arrayMove(original, 0, 2);
  assert.deepEqual(movedForward, ['b', 'c', 'a', 'd']);
  assert.deepEqual(original, ['a', 'b', 'c', 'd']);

  const movedBackward = arrayMove(original, 3, 1);
  assert.deepEqual(movedBackward, ['a', 'd', 'b', 'c']);

  assert.deepEqual(arrayMove(original, 1, 1), original);
  assert.deepEqual(arrayMove(original, -1, 2), original);
  assert.deepEqual(arrayMove(original, 0, 9), original);
  assert.deepEqual(arrayMove([], 0, 0), []);
});

test('scoped drag payload tracks listId to isolate nested lists', () => {
  assert.equal(getActiveScopedDrag(), null);
  setActiveScopedDrag({ listId: 'nested_list_2', index: 1 });
  assert.deepEqual(getActiveScopedDrag(), { listId: 'nested_list_2', index: 1 });
  setActiveScopedDrag(null);
  assert.equal(getActiveScopedDrag(), null);
});

test('serializeClipboardEnvelope & parseClipboardText round-trip envelopes accurately', () => {
  const item: AutomationClipboardItem = {
    type: 'action',
    label: 'Fold Mirrors',
    timestamp: 1700000000000,
    payload: {
      id: 'act_old',
      type: 'can_tx',
      can_id: '0x524',
      bus: 0,
      payload: { D1: '0x02' }
    }
  };

  const text = serializeClipboardEnvelope(item);
  const parsed = parseClipboardText(text);
  assert.ok(parsed);
  assert.equal(parsed.type, 'action');
  assert.equal(parsed.label, 'Fold Mirrors');
  assert.equal(parsed.payload.can_id, '0x524');
});

test('parseClipboardText detects raw CAN Do JSON blocks without envelope', () => {
  const rawAction = JSON.stringify({
    type: 'cycle_entity',
    entity_id: 'drivers_seat_comfort',
    states: ['Off', 'Low Heat', 'High Heat']
  });
  const parsedAction = parseClipboardText(rawAction);
  assert.ok(parsedAction);
  assert.equal(parsedAction.type, 'action');
  assert.equal(parsedAction.label, 'drivers_seat_comfort');

  const rawBranch = JSON.stringify({
    label: 'Winter Path',
    conditions: [{ id: 'c1', type: 'can_state', can_id: '0x123', operator: 'equal', value: '0x01' }],
    sequence: [{ id: 'a1', type: 'delay', delay_ms: 500 }]
  });
  const parsedBranch = parseClipboardText(rawBranch);
  assert.ok(parsedBranch);
  assert.equal(parsedBranch.type, 'choice_branch');
  assert.equal(parsedBranch.label, 'Winter Path');

  const rawTrigger = JSON.stringify({
    source: 'can',
    type: 'byte_transition',
    can_id: '0x381',
    to: '0x04'
  });
  const parsedTrigger = parseClipboardText(rawTrigger);
  assert.ok(parsedTrigger);
  assert.equal(parsedTrigger.type, 'trigger');

  // Rejects non-JSON or full rule objects
  assert.equal(parseClipboardText('hello world'), null);
  assert.equal(parseClipboardText('[]'), null);
  assert.equal(parseClipboardText(JSON.stringify({ triggers: [], actions: [] })), null);
});

test('resolveClipboardPaste regenerates IDs, converts trigger <-> condition, and rejects mismatches', () => {
  const triggerItem: AutomationClipboardItem = {
    type: 'trigger',
    label: 'Brake Pressed',
    payload: {
      id: 'trg_orig',
      _clientId: 'client_orig',
      source: 'can',
      type: 'byte_transition',
      can_id: '0x200',
      byte: 'D1',
      mask: '0x01',
      to: '0x01'
    }
  };

  // Same type paste
  const sameRes = resolveClipboardPaste(triggerItem, 'trigger');
  assert.equal(sameRes.ok, true);
  if (sameRes.ok) {
    assert.notEqual((sameRes.data as any).id, 'trg_orig');
    assert.notEqual((sameRes.data as any)._clientId, 'client_orig');
    assert.equal(sameRes.convertedFrom, undefined);
  }

  // Cross-paste trigger -> condition
  const crossRes = resolveClipboardPaste(triggerItem, 'condition');
  assert.equal(crossRes.ok, true);
  if (crossRes.ok) {
    assert.equal(crossRes.convertedFrom, 'trigger');
    assert.equal((crossRes.data as any).type, 'can_state');
    assert.notEqual((crossRes.data as any).id, 'trg_orig');
  }

  // Mismatch trigger -> action
  const badRes = resolveClipboardPaste(triggerItem, 'action');
  assert.equal(badRes.ok, false);
  if (!badRes.ok) {
    assert.match(badRes.reason, /Trigger block.*cannot be pasted into Actions/i);
  }
});

test('isClipboardCompatibleWithTarget enforces smart section compatibility', () => {
  const trigItem: AutomationClipboardItem = { type: 'trigger', label: 'Door Open', payload: { id: 't1', source: 'can' } };
  const condItem: AutomationClipboardItem = { type: 'condition', label: 'Parked', payload: { id: 'c1', type: 'can_state' } };
  const actItem: AutomationClipboardItem = { type: 'action', label: 'Popup', payload: { id: 'a1', type: 'track_popup' } };
  const branchItem: AutomationClipboardItem = { type: 'choice_branch', label: 'Branch 1', payload: { conditions: [], sequence: [] } };

  assert.equal(isClipboardCompatibleWithTarget(null, 'action'), false);
  assert.equal(isClipboardCompatibleWithTarget(trigItem, 'trigger'), true);
  assert.equal(isClipboardCompatibleWithTarget(trigItem, 'condition'), true);
  assert.equal(isClipboardCompatibleWithTarget(trigItem, 'action'), false);
  assert.equal(isClipboardCompatibleWithTarget(trigItem, 'choice_branch'), false);

  assert.equal(isClipboardCompatibleWithTarget(condItem, 'condition'), true);
  assert.equal(isClipboardCompatibleWithTarget(condItem, 'trigger'), true);
  assert.equal(isClipboardCompatibleWithTarget(condItem, 'action'), false);

  assert.equal(isClipboardCompatibleWithTarget(actItem, 'action'), true);
  assert.equal(isClipboardCompatibleWithTarget(actItem, 'trigger'), false);
  assert.equal(isClipboardCompatibleWithTarget(actItem, 'condition'), false);

  assert.equal(isClipboardCompatibleWithTarget(branchItem, 'choice_branch'), true);
  assert.equal(isClipboardCompatibleWithTarget(branchItem, 'branch'), true);
  assert.equal(isClipboardCompatibleWithTarget(branchItem, 'action'), false);
});

test('canAcceptGlobalPasteTarget ignores editable controls and modal dialogs', () => {
  assert.equal(canAcceptGlobalPasteTarget(null), true);
  assert.equal(canAcceptGlobalPasteTarget({ tagName: 'DIV' } as unknown as EventTarget), true);
  assert.equal(canAcceptGlobalPasteTarget({ tagName: 'INPUT' } as unknown as EventTarget), false);
  assert.equal(canAcceptGlobalPasteTarget({ tagName: 'textarea' } as unknown as EventTarget), false);
  assert.equal(canAcceptGlobalPasteTarget({ tagName: 'SELECT' } as unknown as EventTarget), false);
  assert.equal(canAcceptGlobalPasteTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), false);
  assert.equal(
    canAcceptGlobalPasteTarget({
      tagName: 'DIV',
      closest: (sel: string) => (sel === '[role="dialog"]' ? {} : null)
    } as unknown as EventTarget),
    false
  );
});
