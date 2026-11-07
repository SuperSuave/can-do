import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  Card,
  Disclosure,
  Alert
} from '@heroui/react';
import { cardVariants, disclosureVariants, alertVariants } from '@heroui/styles';

describe('HeroUI Card, Disclosure, and Alert Migration Verification', () => {
  it('exports all compound Card, Disclosure, and Alert components', () => {
    assert.ok(Card, 'Card must be exported');
    assert.ok(Card.Header, 'Card.Header must be exported');
    assert.ok(Card.Title, 'Card.Title must be exported');
    assert.ok(Card.Description, 'Card.Description must be exported');
    assert.ok(Card.Content, 'Card.Content must be exported');
    assert.ok(Card.Footer, 'Card.Footer must be exported');

    assert.ok(Disclosure, 'Disclosure must be exported');
    assert.ok(Disclosure.Heading, 'Disclosure.Heading must be exported');
    assert.ok(Disclosure.Trigger, 'Disclosure.Trigger must be exported');
    assert.ok(Disclosure.Indicator, 'Disclosure.Indicator must be exported');
    assert.ok(Disclosure.Content, 'Disclosure.Content must be exported');

    assert.ok(Alert, 'Alert must be exported');
    assert.ok(Alert.Indicator, 'Alert.Indicator must be exported');
    assert.ok(Alert.Content, 'Alert.Content must be exported');
    assert.ok(Alert.Title, 'Alert.Title must be exported');
    assert.ok(Alert.Description, 'Alert.Description must be exported');
  });

  it('generates expected HeroUI / Tailwind BEM classes for variants', () => {
    const cardSlots = cardVariants();
    assert.ok(cardSlots.base().includes('card'), 'Card base slot must contain card');
    assert.ok(cardSlots.header().includes('card__header'), 'Card header slot must contain card__header');
    assert.ok(cardSlots.title().includes('card__title'), 'Card title slot must contain card__title');
    assert.ok(cardSlots.content().includes('card__content'), 'Card content slot must contain card__content');
    assert.ok(cardSlots.footer().includes('card__footer'), 'Card footer slot must contain card__footer');

    const discSlots = disclosureVariants();
    assert.ok(discSlots.base().includes('disclosure'), 'Disclosure base slot must contain disclosure');
    assert.ok(discSlots.heading().includes('disclosure__heading'), 'Disclosure heading slot must contain disclosure__heading');
    assert.ok(discSlots.trigger().includes('disclosure__trigger'), 'Disclosure trigger slot must contain disclosure__trigger');
    assert.ok(discSlots.indicator().includes('disclosure__indicator'), 'Disclosure indicator slot must contain disclosure__indicator');
    assert.ok(discSlots.content().includes('disclosure__content'), 'Disclosure content slot must contain disclosure__content');

    const alertSlots = alertVariants({ status: 'warning' });
    assert.ok(alertSlots.base().includes('alert--warning'), 'Alert warning variant must include alert--warning');
    assert.ok(alertSlots.indicator().includes('alert__indicator'), 'Alert indicator slot must contain alert__indicator');
    assert.ok(alertSlots.content().includes('alert__content'), 'Alert content slot must contain alert__content');
    assert.ok(alertSlots.title().includes('alert__title'), 'Alert title slot must contain alert__title');
    assert.ok(alertSlots.description().includes('alert__description'), 'Alert description slot must contain alert__description');
  });

  it('renders Card with Header, Title, Content, and Footer', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Card,
        {
          className: 'vehicle-card',
          children: [
            React.createElement(
              Card.Header,
              { key: 'header' },
              React.createElement(Card.Title, null, 'Kia EV6 GT Telemetry'),
              React.createElement(Card.Description, null, 'Real-time CAN metrics')
            ),
            React.createElement(Card.Content, { key: 'content' }, 'State of Charge: 82%'),
            React.createElement(Card.Footer, { key: 'footer' }, 'Updated just now')
          ]
        }
      )
    );

    assert.ok(html.includes('data-slot="card"'), 'Must render card data-slot');
    assert.ok(html.includes('data-slot="card-header"'), 'Must render card-header data-slot');
    assert.ok(html.includes('data-slot="card-title"'), 'Must render card-title data-slot');
    assert.ok(html.includes('Kia EV6 GT Telemetry'), 'Must contain card title');
    assert.ok(html.includes('data-slot="card-content"'), 'Must render card-content data-slot');
    assert.ok(html.includes('State of Charge: 82%'), 'Must contain content');
    assert.ok(html.includes('data-slot="card-footer"'), 'Must render card-footer data-slot');
  });

  it('renders Disclosure with accessible triggers, indicators, and content', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Disclosure,
        {
          isExpanded: true,
          className: 'cat-group',
          children: [
            React.createElement(
              Disclosure.Heading,
              { key: 'heading' },
              React.createElement(
                Disclosure.Trigger,
                null,
                React.createElement(Disclosure.Indicator, null),
                'Battery & Thermal'
              )
            ),
            React.createElement(
              Disclosure.Content,
              { key: 'content', children: '12 CAN Commands in group' }
            )
          ]
        }
      )
    );

    assert.ok(html.includes('data-slot="disclosure"'), 'Must render disclosure data-slot');
    assert.ok(html.includes('data-expanded="true"'), 'Must indicate expanded state');
    assert.ok(html.includes('data-slot="disclosure-heading"'), 'Must render disclosure-heading data-slot');
    assert.ok(html.includes('data-slot="disclosure-trigger"'), 'Must render disclosure-trigger data-slot');
    assert.ok(html.includes('data-slot="disclosure-indicator"'), 'Must render disclosure-indicator data-slot');
    assert.ok(html.includes('data-slot="disclosure-content"'), 'Must render disclosure-content data-slot');
    assert.ok(html.includes('12 CAN Commands in group'), 'Must contain content');
  });

  it('renders Alert with Indicator, Title, and Description', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Alert,
        {
          status: 'danger',
          className: 'syntax-alert',
          children: [
            React.createElement(Alert.Indicator, { key: 'indicator' }),
            React.createElement(
              Alert.Content,
              { key: 'content' },
              React.createElement(Alert.Title, null, 'Critical CAN ID Collision'),
              React.createElement(Alert.Description, null, '0x1CF byte mask conflict detected')
            )
          ]
        }
      )
    );

    assert.ok(html.includes('data-slot="alert-root"'), 'Must render alert-root data-slot');
    assert.ok(html.includes('alert--danger'), 'Must have alert--danger class');
    assert.ok(html.includes('data-slot="alert-indicator"'), 'Must render alert-indicator data-slot');
    assert.ok(html.includes('data-slot="alert-content"'), 'Must render alert-content data-slot');
    assert.ok(html.includes('Critical CAN ID Collision'), 'Must contain title');
    assert.ok(html.includes('0x1CF byte mask conflict detected'), 'Must contain description');
  });
});
