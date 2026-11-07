import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Switch } from '@heroui/react';
import { switchVariants } from '@heroui/styles';

describe('HeroUI Switch Migration & Verification', () => {
  it('exports compound Switch with Root, Content, Control, Thumb, and Icon', () => {
    assert.ok(Switch, 'Switch must be exported');
    assert.strictEqual(typeof Switch, 'function', 'Switch should be a component function');
    assert.ok(Switch.Root, 'Switch.Root must be defined');
    assert.ok(Switch.Content, 'Switch.Content must be defined');
    assert.ok(Switch.Control, 'Switch.Control must be defined');
    assert.ok(Switch.Thumb, 'Switch.Thumb must be defined');
    assert.ok(Switch.Icon, 'Switch.Icon must be defined');
  });

  it('generates expected Tailwind / HeroUI v3 BEM slot classes for small switches', () => {
    const slots = switchVariants({ size: 'sm' });
    assert.strictEqual(slots.base(), 'switch switch--sm');
    assert.strictEqual(slots.content(), 'switch__content');
    assert.strictEqual(slots.control(), 'switch__control');
    assert.strictEqual(slots.thumb(), 'switch__thumb');
  });

  it('generates expected default medium slot classes', () => {
    const slots = switchVariants();
    assert.strictEqual(slots.base(), 'switch switch--md');
    assert.strictEqual(slots.content(), 'switch__content');
    assert.strictEqual(slots.control(), 'switch__control');
    assert.strictEqual(slots.thumb(), 'switch__thumb');
  });

  it('correctly calculates deterministic target state for hardware toggles', () => {
    // Verifies the fix for handleToggleListenOnly / handleToggleAutomations / handleToggleSniffer
    const resolveTargetState = (currentVal: boolean, nextVal?: boolean): boolean => {
      return typeof nextVal === 'boolean' ? nextVal : !currentVal;
    };

    // When Switch passes explicit boolean from user interaction:
    assert.strictEqual(resolveTargetState(false, true), true);
    assert.strictEqual(resolveTargetState(true, false), false);
    assert.strictEqual(resolveTargetState(true, true), true); // idempotent
    assert.strictEqual(resolveTargetState(false, false), false); // idempotent

    // When called without argument (fallback toggle behavior):
    assert.strictEqual(resolveTargetState(false, undefined), true);
    assert.strictEqual(resolveTargetState(true, undefined), false);
  });
});
