import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  Table,
  Checkbox,
  Tooltip,
  ProgressBar
} from '@heroui/react';
import {
  tableVariants,
  checkboxVariants,
  tooltipVariants,
  progressBarVariants
} from '@heroui/styles';

describe('HeroUI Table, Checkbox, Tooltip, and ProgressBar Migration Verification', () => {
  it('exports all compound Table components', () => {
    assert.ok(Table, 'Table must be exported');
    assert.ok(Table.Content, 'Table.Content must be exported');
    assert.ok(Table.Header, 'Table.Header must be exported');
    assert.ok(Table.Column, 'Table.Column must be exported');
    assert.ok(Table.Body, 'Table.Body must be exported');
    assert.ok(Table.Row, 'Table.Row must be exported');
    assert.ok(Table.Cell, 'Table.Cell must be exported');
  });

  it('exports all compound Checkbox components', () => {
    assert.ok(Checkbox, 'Checkbox must be exported');
    assert.ok(Checkbox.Control, 'Checkbox.Control must be exported');
    assert.ok(Checkbox.Indicator, 'Checkbox.Indicator must be exported');
    assert.ok(Checkbox.Content, 'Checkbox.Content must be exported');
  });

  it('exports all compound Tooltip and ProgressBar components', () => {
    assert.ok(Tooltip, 'Tooltip must be exported');
    assert.ok(Tooltip.Trigger, 'Tooltip.Trigger must be exported');
    assert.ok(Tooltip.Content, 'Tooltip.Content must be exported');

    assert.ok(ProgressBar, 'ProgressBar must be exported');
    assert.ok(ProgressBar.Track, 'ProgressBar.Track must be exported');
    assert.ok(ProgressBar.Fill, 'ProgressBar.Fill must be exported');
  });

  it('generates expected HeroUI / Tailwind BEM classes for variants', () => {
    const tableSlots = tableVariants();
    assert.ok(tableSlots.base().includes('table-root'), 'Table base slot must contain table-root');
    assert.ok(tableSlots.header().includes('table__header'), 'Table header slot must contain table__header');
    assert.ok(tableSlots.body().includes('table__body'), 'Table body slot must contain table__body');
    assert.ok(tableSlots.row().includes('table__row'), 'Table row slot must contain table__row');
    assert.ok(tableSlots.cell().includes('table__cell'), 'Table cell slot must contain table__cell');

    const checkSlots = checkboxVariants();
    assert.ok(checkSlots.base().includes('checkbox'), 'Checkbox base slot must contain checkbox');
    assert.ok(checkSlots.control().includes('checkbox__control'), 'Checkbox control slot must contain checkbox__control');
    assert.ok(checkSlots.indicator().includes('checkbox__indicator'), 'Checkbox indicator slot must contain checkbox__indicator');

    const tipSlots = tooltipVariants();
    assert.ok(tipSlots.base().includes('tooltip'), 'Tooltip base slot must contain tooltip');
    assert.ok(tipSlots.trigger().includes('tooltip__trigger'), 'Tooltip trigger slot must contain tooltip__trigger');

    const progressSlots = progressBarVariants();
    assert.ok(progressSlots.base().includes('progress-bar'), 'ProgressBar base slot must contain progress-bar');
    assert.ok(progressSlots.track().includes('progress-bar__track'), 'ProgressBar track slot must contain progress-bar__track');
    assert.ok(progressSlots.fill().includes('progress-bar__fill'), 'ProgressBar fill slot must contain progress-bar__fill');
  });

  it('renders Table cleanly via SSR without DOM hierarchy violations', () => {
    const tableElement = React.createElement(
      Table,
      { className: 'w-full text-left text-xs' },
      React.createElement(
        Table.Content,
        { 'aria-label': 'CAN Frame State Table' },
        React.createElement(
          Table.Header,
          null,
          React.createElement(Table.Column, { id: 'col1', isRowHeader: true }, 'State Label'),
          React.createElement(Table.Column, { id: 'col2' }, 'CAN ID')
        ),
        React.createElement(
          Table.Body,
          null,
          React.createElement(
            Table.Row,
            { id: 'row1' },
            React.createElement(Table.Cell, null, 'Active State'),
            React.createElement(Table.Cell, null, '0x2FC')
          )
        )
      )
    );

    const html = ReactDOMServer.renderToString(tableElement);
    assert.ok(html.includes('table-root'), 'Must render HeroUI table root container');
    assert.ok(html.includes('State Label'), 'Must render column header');
    assert.ok(html.includes('Active State'), 'Must render cell content');
    assert.ok(html.includes('0x2FC'), 'Must render CAN ID');
  });

  it('renders Checkbox cleanly via SSR with aria accessibility', () => {
    const checkboxElement = React.createElement(
      Checkbox,
      {
        isSelected: true,
        'aria-label': 'Enable Remote Climate'
      },
      React.createElement(
        Checkbox.Control,
        null,
        React.createElement(Checkbox.Indicator, null)
      ),
      React.createElement(
        Checkbox.Content,
        null,
        'Enable Remote Climate'
      )
    );

    const html = ReactDOMServer.renderToString(checkboxElement);
    assert.ok(html.includes('checkbox'), 'Must render HeroUI checkbox container');
    assert.ok(html.includes('data-selected="true"'), 'Must reflect selected state in data attribute');
    assert.ok(html.includes('Enable Remote Climate'), 'Must render checkbox content label');
  });

  it('renders Tooltip cleanly via SSR with Trigger and Content slots', () => {
    const tooltipElement = React.createElement(
      Tooltip,
      null,
      React.createElement(
        Tooltip.Trigger,
        null,
        React.createElement('button', { type: 'button' }, 'DLC Pill')
      ),
      React.createElement(
        Tooltip.Content,
        null,
        'Data Length Code (CAN Frame Payload Size)'
      )
    );

    const html = ReactDOMServer.renderToString(tooltipElement);
    assert.ok(html.includes('tooltip__trigger'), 'Must render tooltip trigger wrapper');
    assert.ok(html.includes('DLC Pill'), 'Must render trigger button');
  });

  it('renders ProgressBar cleanly via SSR with Track and Fill slots', () => {
    const progressElement = React.createElement(
      ProgressBar,
      {
        value: 78,
        'aria-label': 'Traction Battery SOC'
      },
      React.createElement(
        ProgressBar.Track,
        { className: 'bg-slate-800' },
        React.createElement(ProgressBar.Fill, { className: 'bg-cyan-400' })
      )
    );

    const html = ReactDOMServer.renderToString(progressElement);
    assert.ok(html.includes('progress-bar'), 'Must render progress bar container');
    assert.ok(html.includes('progress-bar__track'), 'Must render track slot');
    assert.ok(html.includes('progress-bar__fill'), 'Must render fill slot');
  });
});
