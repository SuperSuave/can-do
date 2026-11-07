import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { Chip, Badge } from '@heroui/react';
import { chipVariants, badgeVariants } from '@heroui/styles';

describe('HeroUI Chip & Badge Migration Verification', () => {
  it('exports compound Chip and Badge components', () => {
    assert.ok(Chip, 'Chip must be exported');
    assert.strictEqual(typeof Chip, 'function', 'Chip should be a component function');
    assert.ok(Chip.Root, 'Chip.Root must be defined');
    assert.ok(Chip.Label, 'Chip.Label must be defined');

    assert.ok(Badge, 'Badge must be exported');
    assert.strictEqual(typeof Badge, 'function', 'Badge should be a component function');
    assert.ok(Badge.Root, 'Badge.Root must be defined');
    assert.ok(Badge.Label, 'Badge.Label must be defined');
    assert.ok(Badge.Anchor, 'Badge.Anchor must be defined');
  });

  it('generates expected HeroUI / Tailwind BEM classes for Chip variants', () => {
    const defaultSm = chipVariants({ size: 'sm', color: 'default', variant: 'secondary' });
    assert.ok(defaultSm.base().includes('chip--sm'), 'Small size must include chip--sm');
    assert.ok(defaultSm.base().includes('chip--default'), 'Default color must include chip--default');
    assert.ok(defaultSm.base().includes('chip--secondary'), 'Secondary variant must include chip--secondary');
    assert.ok(defaultSm.label().includes('chip__label'), 'Label slot must include chip__label');

    const warningSoft = chipVariants({ size: 'sm', color: 'warning', variant: 'soft' });
    assert.ok(warningSoft.base().includes('chip--warning'), 'Warning color must include chip--warning');
    assert.ok(warningSoft.base().includes('chip--soft'), 'Soft variant must include chip--soft');

    const successSoft = chipVariants({ size: 'sm', color: 'success', variant: 'soft' });
    assert.ok(successSoft.base().includes('chip--success'), 'Success color must include chip--success');

    const dangerSoft = chipVariants({ size: 'sm', color: 'danger', variant: 'soft' });
    assert.ok(dangerSoft.base().includes('chip--danger'), 'Danger color must include chip--danger');

    const accentPrimary = chipVariants({ size: 'md', color: 'accent', variant: 'primary' });
    assert.ok(accentPrimary.base().includes('chip--accent'), 'Accent color must include chip--accent');
    assert.ok(accentPrimary.base().includes('chip--primary'), 'Primary variant must include chip--primary');
  });

  it('generates expected HeroUI / Tailwind BEM classes for Badge variants', () => {
    const badgeTopRight = badgeVariants({ size: 'sm', color: 'accent', placement: 'top-right' });
    assert.ok(badgeTopRight.base().includes('badge--top-right'), 'Must include top-right placement');
    assert.ok(badgeTopRight.base().includes('badge--sm'), 'Must include sm size');
    assert.ok(badgeTopRight.base().includes('badge--accent'), 'Must include accent color');
    assert.ok(badgeTopRight.label().includes('badge__label'), 'Label slot must include badge__label');

    const badgeDangerBottomLeft = badgeVariants({ size: 'lg', color: 'danger', placement: 'bottom-left' });
    assert.ok(badgeDangerBottomLeft.base().includes('badge--bottom-left'), 'Must include bottom-left placement');
    assert.ok(badgeDangerBottomLeft.base().includes('badge--danger'), 'Must include danger color');
  });

  it('renders Chip component to static HTML with appropriate classes and custom classNames', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Chip, {
        children: '0x4A2',
        color: 'warning',
        variant: 'soft',
        size: 'sm',
        className: 'font-mono text-xs test-custom-class'
      })
    );

    assert.ok(html.includes('chip--warning'), 'HTML should include chip--warning');
    assert.ok(html.includes('chip--sm'), 'HTML should include chip--sm');
    assert.ok(html.includes('font-mono'), 'HTML should preserve custom font-mono styling');
    assert.ok(html.includes('test-custom-class'), 'HTML should preserve custom classNames');
    assert.ok(html.includes('0x4A2'), 'HTML should render CAN ID text content');
  });

  it('renders Chip with compound composite children (icons + labels)', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Chip, {
        children: [
          React.createElement('span', { key: 'icon', className: 'test-icon' }, '►'),
          'Action'
        ],
        color: 'success',
        variant: 'soft',
        size: 'sm',
        className: 'can-do-ha-pill act-pill'
      })
    );

    assert.ok(html.includes('chip--success'), 'HTML should include chip--success');
    assert.ok(html.includes('can-do-ha-pill'), 'HTML should preserve can-do-ha-pill class');
    assert.ok(html.includes('test-icon'), 'HTML should render icon node');
    assert.ok(html.includes('Action'), 'HTML should render Action text');
  });

  it('renders Badge component to static HTML', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Badge, {
        children: '5',
        color: 'danger',
        size: 'sm',
        className: 'badge-test'
      })
    );

    assert.ok(html.includes('badge--danger'), 'HTML should include badge--danger');
    assert.ok(html.includes('badge--sm'), 'HTML should include badge--sm');
    assert.ok(html.includes('5'), 'HTML should render badge content');
  });

  it('renders CAN ID Badge preserving font-mono, accent color, and soft variant', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Badge, {
        children: '0x4A2',
        color: 'accent',
        variant: 'soft',
        size: 'sm',
        className: 'font-mono text-cyan-300 font-semibold px-1 py-0'
      })
    );

    assert.ok(html.includes('badge--accent'), 'HTML should include badge--accent');
    assert.ok(html.includes('badge--soft'), 'HTML should include badge--soft');
    assert.ok(html.includes('font-mono'), 'HTML should include font-mono');
    assert.ok(html.includes('0x4A2'), 'HTML should contain CAN ID 0x4A2');
  });

  it('renders anchored Badge with top-right placement for draft indicator', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Badge.Anchor, {
        children: [
          React.createElement('div', { key: 'card', className: 'command-card' }, 'Card Body'),
          React.createElement(Badge, {
            key: 'badge',
            children: 'New Contribution',
            placement: 'top-right',
            color: 'success',
            variant: 'soft',
            size: 'sm'
          })
        ]
      })
    );

    assert.ok(html.includes('badge-anchor'), 'HTML should include badge-anchor');
    assert.ok(html.includes('badge--top-right'), 'HTML should include badge--top-right');
    assert.ok(html.includes('badge--success'), 'HTML should include badge--success');
    assert.ok(html.includes('New Contribution'), 'HTML should render badge label');
  });

  it('renders automotive telemetry status badges and battery SoC chips', () => {
    const socHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Chip, {
        children: [
          React.createElement('span', { key: 'icon' }, '⚡'),
          '82%'
        ],
        color: 'accent',
        variant: 'soft',
        size: 'sm',
        className: 'font-mono font-semibold'
      })
    );
    assert.ok(socHtml.includes('chip--accent'), 'SoC chip must have accent color');
    assert.ok(socHtml.includes('82%'), 'SoC chip must render charge level');

    const canStatusHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Badge, {
        children: 'LIVE CAN: CONNECTED',
        color: 'success',
        variant: 'soft',
        size: 'sm'
      })
    );
    assert.ok(canStatusHtml.includes('badge--success'), 'Live CAN badge must have success color');
    assert.ok(canStatusHtml.includes('LIVE CAN: CONNECTED'), 'Live CAN badge must render status');
  });
});
