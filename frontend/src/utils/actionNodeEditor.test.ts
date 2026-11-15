import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { ActionNodeEditor } from '../components/automation/ActionNodeEditor';
import type { AutomationAction } from '../types/automation';
import type { Catalog } from '../types/catalog';

const testCatalog: Catalog = {
  can_do_version: '1.0.0',
  vehicles: [],
  commands: [
    {
      id: 'drivers_seat_comfort',
      name: 'Driver Seat Comfort',
      category: 'Climate & Comfort',
      roles: ['action', 'condition'],
      ha_metadata: { name: 'Driver Seat Comfort', domain: 'select' },
      network: { action_can_id: '0x4A2', state_can_id: '0x496', bus: 0, delay_ms: 20 },
      options: [
        { label: 'Off', match: { D3: '0x00' }, steps: [{ payload: { D5: '0x2F' } }, { payload: { D5: '0xFF' } }] },
        { label: 'Low Heat', match: { D3: '0x04' }, steps: [{ payload: { D5: '0x6F' } }, { payload: { D5: '0xFF' } }] },
      ],
    },
    {
      id: 'surround_view_camera',
      name: '360 Surround View Camera',
      category: 'Cockpit & Controls',
      roles: ['action'],
      ha_metadata: { name: '360 Surround View Camera', domain: 'button' },
      network: { action_can_id: '0x476', bus: 0, delay_ms: 20 },
      popup_message: 'Camera View',
      steps: [
        { payload: { D3: '0x52' }, repeat: 3 },
        { payload: {}, repeat: 3 },
      ],
    },
  ],
};

describe('ActionNodeEditor card mode preservation', () => {
  it('renders cycle_entity as Cyclic Stepper Configuration instead of option pills or Custom CAN Transmit', () => {
    const cycleAction: AutomationAction = {
      id: 'act_cycle_1',
      type: 'cycle_entity',
      entity_id: 'drivers_seat_comfort',
      states: ['Off', 'Low Heat'],
      direction: 'forward',
      wrap: true,
      show_popup: true,
      popup_prefix: 'Driver Seat: ',
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: cycleAction,
        index: 0,
        depth: 2,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
        onDuplicate: () => {},
      })
    );

    assert.ok(html.includes('Cyclic Stepper Configuration'), 'Must render Cyclic Stepper Configuration directly');
    assert.ok(!html.includes('Target CAN ID'), 'Must not render raw Custom CAN Transmit fields on cycle_entity');
    assert.ok(!html.includes('Low Heat</button>'), 'Must not hijack cycle_entity with static option pills');
  });

  it('renders 0-option catalog actions like surround_view_camera as a normal catalog card with Details toggle', () => {
    const camAction: AutomationAction = {
      id: 'act_cam_1',
      type: 'can_tx',
      source_command_id: 'surround_view_camera',
      entity_id: 'surround_view_camera',
      source_command_name: '360 Surround View Camera',
      can_id: '0x476',
      bus: 0,
      steps: [
        { can_id: '0x476', bus: 0, payload: { D3: '0x52' }, repeat: 3, delay_ms: 20 },
        { can_id: '0x476', bus: 0, payload: { D1: '0x01' }, repeat: 3, delay_ms: 0 },
      ],
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: camAction,
        index: 0,
        depth: 2,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
        onDuplicate: () => {},
      })
    );

    const textHtml = html.replace(/<!-- -->/g, '');
    assert.ok(textHtml.includes('360 Surround View Camera'), 'Must display catalog command name');
    assert.ok(textHtml.includes('Details'), 'Must show Details toggle button');
    assert.ok(textHtml.includes('TX 0x476'), 'Must show compact TX summary');
    assert.ok(!textHtml.includes('Sequence Steps (2)'), 'Must not render expanded Custom CAN Sequence Steps by default');
  });
});
