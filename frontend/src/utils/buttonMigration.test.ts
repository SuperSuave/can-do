import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { Button, ButtonGroup } from '@heroui/react';
import { buttonVariants, buttonGroupVariants } from '@heroui/styles';

describe('HeroUI Button & ButtonGroup Migration Verification', () => {
  it('exports compound Button and ButtonGroup components', () => {
    assert.ok(Button, 'Button must be exported');
    assert.strictEqual(typeof Button, 'function', 'Button should be a component function');
    assert.ok(Button.Root, 'Button.Root must be defined');

    assert.ok(ButtonGroup, 'ButtonGroup must be exported');
    assert.strictEqual(typeof ButtonGroup, 'function', 'ButtonGroup should be a component function');
    assert.ok(ButtonGroup.Root, 'ButtonGroup.Root must be defined');
    assert.ok(ButtonGroup.Separator, 'ButtonGroup.Separator must be defined');
  });

  it('generates expected HeroUI / Tailwind BEM classes for Button variants', () => {
    const primarySm = buttonVariants({ variant: 'primary', size: 'sm' });
    assert.ok(primarySm.includes('button--primary'), 'Primary variant must contain button--primary');
    assert.ok(primarySm.includes('button--sm'), 'Small size must contain button--sm');

    const secondaryMd = buttonVariants({ variant: 'secondary', size: 'md' });
    assert.ok(secondaryMd.includes('button--secondary'), 'Secondary variant must contain button--secondary');
    assert.ok(secondaryMd.includes('button--md'), 'Medium size must contain button--md');

    const outlineSm = buttonVariants({ variant: 'outline', size: 'sm' });
    assert.ok(outlineSm.includes('button--outline'), 'Outline variant must contain button--outline');
    assert.ok(outlineSm.includes('button--sm'), 'Small size must contain button--sm');

    const ghostSm = buttonVariants({ variant: 'ghost', size: 'sm' });
    assert.ok(ghostSm.includes('button--ghost'), 'Ghost variant must contain button--ghost');

    const dangerSm = buttonVariants({ variant: 'danger', size: 'sm' });
    assert.ok(dangerSm.includes('button--danger'), 'Danger variant must contain button--danger');

    const dangerSoftSm = buttonVariants({ variant: 'danger-soft', size: 'sm' });
    assert.ok(dangerSoftSm.includes('button--danger-soft'), 'Danger-soft variant must contain button--danger-soft');

    const iconOnly = buttonVariants({ isIconOnly: true, size: 'sm' });
    assert.ok(iconOnly.includes('button--icon-only'), 'isIconOnly must contain button--icon-only');

    const fullWidth = buttonVariants({ fullWidth: true });
    assert.ok(fullWidth.includes('button--full-width'), 'fullWidth must contain button--full-width');
  });

  it('generates expected HeroUI / Tailwind BEM classes for ButtonGroup', () => {
    const horizontalSlots = buttonGroupVariants({ orientation: 'horizontal' });
    assert.ok(horizontalSlots.base().includes('button-group'), 'ButtonGroup base must contain button-group');
    assert.ok(horizontalSlots.base().includes('button-group--horizontal'), 'ButtonGroup must contain horizontal orientation');

    const verticalSlots = buttonGroupVariants({ orientation: 'vertical' });
    assert.ok(verticalSlots.base().includes('button-group--vertical'), 'ButtonGroup must contain vertical orientation');

    const fullWidthSlots = buttonGroupVariants({ fullWidth: true });
    assert.ok(fullWidthSlots.base().includes('button-group--full-width'), 'fullWidth must contain button-group--full-width');
  });

  it('renders Button to HTML with appropriate React Aria attributes and classes', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Button, {
        variant: 'primary',
        size: 'sm',
        type: 'submit',
        isDisabled: true,
        'aria-label': 'Save Changes'
      }, 'Save')
    );
    assert.ok(html.includes('type="submit"'), 'Must render type="submit"');
    assert.ok(html.includes('button--primary'), 'Must render button--primary class');
    assert.ok(html.includes('button--sm'), 'Must render button--sm class');
    assert.ok(html.includes('aria-label="Save Changes"'), 'Must preserve aria-label');
    assert.ok(html.includes('disabled=""') || html.includes('aria-disabled="true"'), 'Must set disabled state');
  });

  it('propagates size and variant context from ButtonGroup to child Buttons', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        ButtonGroup,
        { size: 'sm', variant: 'outline' },
        React.createElement(Button, null, 'Action 1'),
        React.createElement(Button, null, 'Action 2')
      )
    );
    assert.ok(html.includes('button-group'), 'Must render button-group container');
    assert.ok(html.includes('button-group--horizontal'), 'Must default to horizontal group');
    // Both children should inherit size and variant from context
    const occurrences = (html.match(/button--outline/g) || []).length;
    assert.strictEqual(occurrences, 2, 'Both child buttons should inherit outline variant from group');
    const smOccurrences = (html.match(/button--sm/g) || []).length;
    assert.strictEqual(smOccurrences, 2, 'Both child buttons should inherit small size from group');
  });
});
