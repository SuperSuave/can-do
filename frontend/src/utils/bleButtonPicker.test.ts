import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  BleButtonComboPicker,
  formatBleButtonFriendlyName,
  getBleButtonFriendlyLabel,
  parseBleButtonTokens,
} from '../components/BleButtonComboPicker';

describe('BleButtonComboPicker friendly names and layout', () => {
  it('formats single and multi-button combos into friendly names', () => {
    assert.strictEqual(formatBleButtonFriendlyName('any'), 'Any Button');
    assert.strictEqual(formatBleButtonFriendlyName(''), 'Any Button');
    assert.strictEqual(formatBleButtonFriendlyName(undefined), 'Any Button');

    assert.strictEqual(formatBleButtonFriendlyName('volume_up'), 'Vol +');
    assert.strictEqual(formatBleButtonFriendlyName('play_pause'), 'Play/Pause');
    assert.strictEqual(formatBleButtonFriendlyName('key_3'), 'Key 3');
    assert.strictEqual(formatBleButtonFriendlyName('escape'), 'Esc');

    assert.strictEqual(
      formatBleButtonFriendlyName('key_1+volume_up'),
      'Key 1 + Vol +'
    );
    assert.strictEqual(
      formatBleButtonFriendlyName('any+next_track'),
      'Next'
    );
  });

  it('formats unknown custom button IDs cleanly', () => {
    assert.strictEqual(getBleButtonFriendlyLabel('custom_macro'), 'Custom Macro');
    assert.deepStrictEqual(parseBleButtonTokens('Key_1 + Volume_Up'), ['key_1', 'volume_up']);
  });

  it('renders Learn button, friendly input value, and omits Select/Build Combo button', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(BleButtonComboPicker, {
        value: 'key_1+volume_up',
        onChange: () => {},
        label: 'Button or Multi-Button Combo Chord',
      })
    );

    assert.ok(html.includes('Key 1 + Vol +'), 'Input must display friendly combo name');
    assert.ok(html.includes('Learn'), 'Must render Learn button');
    assert.ok(!html.includes('Select / Build Combo'), 'Must remove Select / Build Combo button');
    assert.ok(!html.includes('>Listen<'), 'Must rename Listen to Learn');
    assert.ok(!html.includes('2-Key Chord'), 'Must not render inline chord count badge');
  });
});
