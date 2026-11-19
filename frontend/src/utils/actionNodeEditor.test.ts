import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { ActionNodeEditor, ActionListEditor } from '../components/automation/ActionNodeEditor';
import { ConditionListEditor } from '../components/automation/ConditionNodeEditor';
import { AutomationClipboardContext, AutomationClipboardContextType } from '../components/automation/AutomationClipboardContext';
import type { AutomationAction, AutomationClipboardItem } from '../types/automation';
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

  it('renders repeat_until with Loop Interval, Safety Timeout, Repeat Actions, and Stop Condition', () => {
    const repeatAction: AutomationAction = {
      id: 'act_repeat_1',
      type: 'repeat_until',
      interval_ms: 750,
      timeout_ms: 15000,
      sequence: [
        {
          id: 'act_inner_1',
          type: 'track_popup',
          level: 'info',
          text: 'Loop tick',
        },
      ],
      conditions: [
        {
          id: 'cond_stop_1',
          type: 'can_state',
          can_id: '0x226',
          byte: 'D1',
          mask: '0x0F',
          operator: 'equal',
          value: '0x00',
        },
      ],
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: repeatAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
        onDuplicate: () => {},
      })
    );

    const textHtml = html.replace(/<!-- -->/g, '');
    assert.ok(textHtml.includes('REPEAT UNTIL (Loop)'), 'Must render REPEAT UNTIL header');
    assert.ok(textHtml.includes('Loop Interval (ms)'), 'Must render Loop Interval input');
    assert.ok(textHtml.includes('Safety Timeout (ms)'), 'Must render Safety Timeout input');
    assert.ok(textHtml.includes('Repeat Actions (Loop Body) (1)'), 'Must render nested loop body actions');
    assert.ok(textHtml.includes('Stop Condition (Repeat Until True)'), 'Must render stop condition editor');
  });

  it('shows unsupported warning for legacy webhook actions and omits webhook from standard CAN TX type selector', () => {
    const webhookAction: AutomationAction = {
      id: 'act_wh_1',
      type: 'webhook',
      webhook_url: 'https://example.com/hook',
    };

    const webhookHtml = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: webhookAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(webhookHtml.includes('Legacy Webhook Action Not Supported on ESP32 Firmware'), 'Must show offline firmware warning for legacy webhook');

    const canTxAction: AutomationAction = {
      id: 'act_can_1',
      type: 'can_tx',
      can_id: '0x524',
      payload: '00 00 00 00 00 00 00 00',
    };

    const canTxHtml = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: canTxAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
      })
    );

    assert.ok(!canTxHtml.includes('webhook (HTTP)'), 'Standard action type selector must not offer broken webhook option');
  });

  it('renders CycleEntityStepperConfig with catalog entity picker, selectable state chips, draggable sequence strip, and ping-pong mode', () => {
    const cycleCatalog: Catalog = {
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
            { label: 'Off', match: { D3: '0x00' }, steps: [{ payload: { D5: '0x2F' } }] },
            { label: 'Low Heat', match: { D3: '0x01' }, steps: [{ payload: { D5: '0x6F' } }] },
            { label: 'Medium Heat', match: { D3: '0x02' }, steps: [{ payload: { D5: '0x7F' } }] },
            { label: 'High Heat', match: { D3: '0x03' }, steps: [{ payload: { D5: '0x8F' } }] },
          ],
        },
      ],
    };

    const cycleAction: AutomationAction = {
      id: 'act_cycle_1',
      type: 'cycle_entity',
      entity_id: 'drivers_seat_comfort',
      states: ['Off', 'Low Heat', 'High Heat'],
      direction: 'ping_pong',
      fallback_state: '__first__',
      show_popup: true,
      popup_prefix: '{entity} ➔ {state}',
      level: 'warning',
    };

    const entityStates = new Map<string, string>([['drivers_seat_comfort', 'Low Heat']]);

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: cycleAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: cycleCatalog,
        entityStates,
        onUpdate: () => {},
        onDelete: () => {},
        onDuplicate: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(html.includes('Cyclic Stepper Configuration'), 'Must render Cyclic Stepper Configuration header');
    assert.ok(html.includes('Driver Seat Comfort (4 states)'), 'Must render catalog entity option in selector');
    assert.ok(html.includes('Ping-Pong ⇄ (Bounce)'), 'Must render Ping-Pong bounce badge');
    assert.ok(html.includes('Live: Low Heat'), 'Must render live current state badge');
    assert.ok(html.includes('1. Toggle States to Include (3 of 4 selected):'), 'Must render toggleable catalog option chip pool');
    assert.ok(html.includes('2. Cycle Sequence Order'), 'Must render draggable sequence order strip');
    assert.ok(html.includes('Reverse Order'), 'Must render Reverse Order button');
  });

  it('renders HudNavActionConfig with maneuver icons, imperial/metric distance & speed limit inputs, and 8-lane guidance', () => {
    const hudAction: AutomationAction = {
      id: 'act_hud_1',
      type: 'hud_nav',
      nav_action: 'update',
      icon: 0x03, // Turn Right
      street: 'Pacific Coast Hwy',
      distance_meters: 305, // ~1000 ft
      bars: 6,
      speed_limit: 105, // ~65 mph
      camera_alert: true,
      num_lanes: 3,
      lane_directions: [8, 1, 3],
      lane_recommended: [0, 1, 0],
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: hudAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
        onDuplicate: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(html.includes('HUD &amp; Cluster Turn-by-Turn Navigation') || html.includes('HUD & Cluster Turn-by-Turn Navigation'), 'Must render HUD navigation header');
    assert.ok(html.includes('Turn Right (0x03)'), 'Must render maneuver icon options');
    assert.ok(html.includes('Pacific Coast Hwy'), 'Must render street name');
    assert.ok(html.includes('1001 ft (305m)'), 'Must render both imperial ft and metric m distance');
    assert.ok(html.includes('Limit 65 mph (105 km/h)'), 'Must render both imperial mph and metric km/h speed limit');
    assert.ok(html.includes('Multi-Lane Guidance'), 'Must render Multi-Lane Guidance switch');
    assert.ok(html.includes('Lane 1') && html.includes('Lane 2') && html.includes('Lane 3'), 'Must render 3 lane columns');
  });

  it('shows only friendly names for action types in the selector and enforces 50-char cluster popup limit', () => {
    const canTxAction: AutomationAction = {
      id: 'act_can_friendly',
      type: 'can_tx',
      can_id: '0x524',
      payload: '00 00 00 00 00 00 00 00',
    };

    const canTxHtml = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: canTxAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(canTxHtml.includes('>CAN Transmit<'), 'Must show friendly CAN Transmit option');
    assert.ok(canTxHtml.includes('>Cyclic Stepper<'), 'Must show friendly Cyclic Stepper option');
    assert.ok(canTxHtml.includes('>Cluster Popup<'), 'Must show friendly Cluster Popup option');
    assert.ok(canTxHtml.includes('>Wait / Delay<'), 'Must show friendly Wait / Delay option');
    assert.ok(!canTxHtml.includes('can_tx ('), 'Must not show raw can_tx identifier in action type dropdown');
    assert.ok(!canTxHtml.includes('track_popup ('), 'Must not show raw track_popup identifier in action type dropdown');
    assert.ok(!canTxHtml.includes('cycle_entity ('), 'Must not show raw cycle_entity identifier in action type dropdown');

    const longPopupAction: AutomationAction = {
      id: 'act_pop_long',
      type: 'track_popup',
      level: 'info',
      text: 'X'.repeat(49), // 49 + 2 ("ⓘ ") = 51 > 50
    };

    const popupHtml = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: longPopupAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(popupHtml.includes('51/50 (incl. icon)'), 'Must display total character count including 2-char severity icon');
    assert.ok(popupHtml.includes('maxLength="48"'), 'Must cap track_popup text input at 48 characters (50 with icon)');
    assert.ok(popupHtml.includes('Firmware drops popups over 50 characters'), 'Must warn when existing popup text exceeds 50 total chars');

    const longCycleAction: AutomationAction = {
      id: 'act_cycle_long',
      type: 'cycle_entity',
      entity_id: 'drivers_seat_comfort',
      states: ['Off', 'Very Long Heated And Ventilated Seat State Label'],
      show_popup: true,
      popup_prefix: 'Driver Seat: ',
    };

    const cycleHtml = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: longCycleAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: testCatalog,
        onUpdate: () => {},
        onDelete: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(cycleHtml.includes('Toast exceeds the 50-character cluster limit'), 'Must warn when cycle_entity resolved toast exceeds 50 characters');
    assert.ok(cycleHtml.includes('draggable="true"'), 'Must render cycle_entity sequence chips as draggable');
  });

  it('never renders hud_nav as Infotainment Sound Stage Focus even if stale catalog metadata or 0x60E is present', () => {
    const soundStageCatalog: Catalog = {
      can_do_version: '1.0.0',
      vehicles: [],
      commands: [
        ...testCatalog.commands,
        {
          id: 'audio_sound_focus',
          name: 'Infotainment Sound Stage Focus',
          category: 'Cockpit & Controls',
          roles: ['action', 'condition'],
          ha_metadata: { name: 'Infotainment Sound Stage Focus', domain: 'select' },
          network: { action_can_id: '0x60E', state_can_id: '0x60E', bus: 0 },
          options: [
            { label: 'Center', match: { D2: '0x0A', D3: '0x0A' }, payload: { D2: '0x0A', D3: '0x0A' }, default: true },
            { label: 'Front Driver', match: { D2: '0x05', D3: '0x0E' }, payload: { D2: '0x05', D3: '0x0E' } },
          ],
        },
      ],
    };

    const taintedHudAction: AutomationAction = {
      id: 'act_hud_tainted',
      type: 'hud_nav',
      nav_action: 'update',
      icon: 0x03,
      street: 'Market St',
      distance_meters: 150,
      bars: 4,
      speed_limit: 55,
      // Simulate leftover metadata when switching an action from Infotainment Sound Stage Focus -> HUD Turn-by-Turn
      source_command_id: 'audio_sound_focus',
      entity_id: 'audio_sound_focus',
      source_command_name: 'Infotainment Sound Stage Focus',
      can_id: '0x60E',
      option_label: 'Center',
      payload: { D2: '0x0A', D3: '0x0A' },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: taintedHudAction,
        index: 0,
        depth: 0,
        availableTriggers: [],
        catalog: soundStageCatalog,
        onUpdate: () => {},
        onDelete: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(
      html.includes('HUD &amp; Cluster Turn-by-Turn') || html.includes('HUD & Cluster Turn-by-Turn'),
      'Card header must show HUD & Cluster Turn-by-Turn'
    );
    assert.ok(html.includes('HUD &amp; Cluster Turn-by-Turn Navigation') || html.includes('HUD & Cluster Turn-by-Turn Navigation'), 'Must render HudNavActionConfig directly without collapsing behind Details');
    assert.ok(!html.includes('Infotainment Sound Stage Focus'), 'Must never render Infotainment Sound Stage Focus for hud_nav');
    assert.ok(!html.includes('Front Driver</button>'), 'Must not render Sound Stage option pills on hud_nav');
    assert.ok(!html.includes('Target CAN ID'), 'Must not render raw CAN Transmit fields on hud_nav');
    assert.ok(html.includes('<option value="hud_nav" selected=""') || html.includes('selected="" value="hud_nav"') || html.includes('<option value="hud_nav" selected'), 'Action Type selector must select hud_nav');
  });

  it('shows aligned paste buttons only in sections compatible with valid clipboard entries', () => {
    const makeCtx = (clipboard: AutomationClipboardItem | null): AutomationClipboardContextType => ({
      clipboard,
      copyToClipboard: () => {},
      clearClipboard: () => {},
      pastePayload: () => null,
      pasteFromClipboard: async () => null,
    });

    // Empty clipboard -> no Paste buttons in Conditions or Actions
    const emptyActHtml = ReactDOMServer.renderToString(
      React.createElement(
        AutomationClipboardContext.Provider,
        { value: makeCtx(null) },
        React.createElement(ActionListEditor, {
          actions: [],
          availableTriggers: [],
          catalog: testCatalog,
          onUpdate: () => {},
        })
      )
    ).replace(/<!-- -->/g, '');
    const emptyCondHtml = ReactDOMServer.renderToString(
      React.createElement(
        AutomationClipboardContext.Provider,
        { value: makeCtx(null) },
        React.createElement(ConditionListEditor, {
          conditions: [],
          availableTriggers: [],
          catalog: testCatalog,
          onUpdate: () => {},
        })
      )
    ).replace(/<!-- -->/g, '');

    assert.ok(!emptyActHtml.includes('Paste from Clipboard'), 'Must not show generic Paste from Clipboard in Actions');
    assert.ok(!emptyCondHtml.includes('Paste from Clipboard'), 'Must not show generic Paste from Clipboard in Conditions');
    assert.ok(!emptyActHtml.includes('ha-section-paste-btn'), 'Must hide Action paste button when clipboard is empty');
    assert.ok(!emptyCondHtml.includes('ha-section-paste-btn'), 'Must hide Condition paste button when clipboard is empty');

    // Action in clipboard -> shown & aligned in Actions, hidden in Conditions
    const actionCtx = makeCtx({
      type: 'action',
      label: 'Test Popup',
      payload: { id: 'a1', type: 'track_popup', text: 'Hi' },
    });
    const withActionInActHtml = ReactDOMServer.renderToString(
      React.createElement(
        AutomationClipboardContext.Provider,
        { value: actionCtx },
        React.createElement(ActionListEditor, {
          actions: [],
          availableTriggers: [],
          catalog: testCatalog,
          onUpdate: () => {},
        })
      )
    ).replace(/<!-- -->/g, '');
    const withActionInCondHtml = ReactDOMServer.renderToString(
      React.createElement(
        AutomationClipboardContext.Provider,
        { value: actionCtx },
        React.createElement(ConditionListEditor, {
          conditions: [],
          availableTriggers: [],
          catalog: testCatalog,
          onUpdate: () => {},
        })
      )
    ).replace(/<!-- -->/g, '');

    assert.ok(withActionInActHtml.includes('ha-section-paste-btn'), 'Must use aligned ha-section-paste-btn class');
    assert.ok(withActionInActHtml.includes('Paste Action (Test Popup)'), 'Must show typed Paste Action button');
    assert.ok(!withActionInCondHtml.includes('ha-section-paste-btn'), 'Must not show paste button in incompatible Condition section');

    // Trigger in clipboard -> shown as cross-pasted Condition button
    const trigCtx = makeCtx({
      type: 'trigger',
      label: 'Brake Pressed',
      payload: { id: 't1', source: 'can', can_id: '0x200', to: '0x01' },
    });
    const withTrigInCondHtml = ReactDOMServer.renderToString(
      React.createElement(
        AutomationClipboardContext.Provider,
        { value: trigCtx },
        React.createElement(ConditionListEditor, {
          conditions: [],
          availableTriggers: [],
          catalog: testCatalog,
          onUpdate: () => {},
        })
      )
    ).replace(/<!-- -->/g, '');

    assert.ok(withTrigInCondHtml.includes('ha-section-paste-btn'), 'Must use aligned ha-section-paste-btn class for cross-paste');
    assert.ok(withTrigInCondHtml.includes('Paste as Condition (Brake Pressed)'), 'Must offer Paste as Condition for compatible trigger');
  });

  it('renders Dynamic Animations pills for ambient_light_colors and preserves compact catalog card on entity_command effect', () => {
    const ambientCatalog: Catalog = {
      can_do_version: '1.0.0',
      vehicles: [],
      commands: [
        {
          id: 'ambient_light_colors',
          name: 'Ambient Light Colors',
          category: 'Cockpit & Controls',
          roles: ['action'],
          ha_metadata: { name: 'Ambient Mood Lighting', domain: 'light' },
          network: { action_can_id: '0x4AD', state_can_id: '0x455', bus: 0, delay_ms: 25 },
          options: [
            { label: 'Dreamy Purple', steps: [{ payload: '6B69551900000000' }, { payload: '0002082000000000' }] },
            { label: 'Color 8: Pure Cyan / Aqua Wave', steps: [{ payload: '0064530F00000000' }, { payload: '0002082000000000' }] },
          ],
          effects: [
            { label: 'Rainbow Spectrum Wave', name: 'Rainbow Wave', hex: '#ff00ff', description: '64-color sweep' },
            { label: 'Sunset Glow', name: 'Sunset Glow', hex: '#ff8c00', description: 'Warm embers' },
          ],
        },
      ],
    };

    const effAction: AutomationAction = {
      id: 'act_amb_eff',
      type: 'entity_command',
      entity_id: 'ambient_light_colors',
      source_command_id: 'ambient_light_colors',
      command: 'Sunset Glow',
      option_label: 'Sunset Glow',
      can_id: '0x4AD',
      bus: 0,
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ActionNodeEditor, {
        act: effAction,
        index: 0,
        depth: 1,
        availableTriggers: [],
        catalog: ambientCatalog,
        onUpdate: () => {},
        onDelete: () => {},
        onDuplicate: () => {},
      })
    ).replace(/<!-- -->/g, '');

    assert.ok(html.includes('Dynamic Animations (Offline Edge)'), 'Must show Dynamic Animations section');
    assert.ok(html.includes('Rainbow Spectrum Wave'), 'Must list Rainbow Spectrum Wave pill');
    assert.ok(html.includes('Sunset Glow'), 'Must list Sunset Glow pill');
    assert.ok(html.includes('Dreamy Purple'), 'Must still list static factory themes and palette options');
    assert.ok(!html.includes('Target CAN ID'), 'Must stay in compact catalog mode instead of raw Custom CAN TX');
  });
});

