import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  FrontFasciaHeadlightSignature,
  type EgmpModel,
} from '../components/VehicleOutlines';

const MODELS: EgmpModel[] = ['gv60', 'ioniq6', 'ioniq5', 'ev6'];

describe('FrontFasciaHeadlightSignature Remade SVG Integration', () => {
  it('renders all four E-GMP models cleanly with normalized coordinates and theme-aware colors', () => {
    for (const model of MODELS) {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(FrontFasciaHeadlightSignature, {
          model,
          lights: 'high',
          gear: 'D',
          hazards: false,
          turnSignal: 'off',
          blinkState: false,
          hoodOpen: false,
        })
      );

      assert.ok(html.includes(`id="fascia-${model}"`), `${model} must render fascia group`);
      assert.ok(html.includes(`id="${model}-emblem"`), `${model} must include emblem group`);
      assert.ok(html.includes(`id="${model}-drl-left"`), `${model} must include left DRL group`);
      assert.ok(html.includes(`id="${model}-drl-right"`), `${model} must include right DRL group`);
      assert.ok(!/<rect[^>]*\by="-/.test(html), `${model} must not contain negative-y beam rects`);
      assert.ok(!html.includes('transform-origin'), `${model} must not rely on CSS transform-origin`);
      assert.ok(!html.includes('transform-box'), `${model} must not rely on CSS transform-box`);
      assert.ok(!html.includes('#000') && !html.includes('rgb(0, 0, 0)'), `${model} must not hardcode black fills/strokes`);
      assert.ok(!html.includes('rgb(255, 255, 255)'), `${model} must not hardcode white strokes`);
    }
  });

  it('places ioniq5-high-beam-right cleanly inside the right inner DRL bracket', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(FrontFasciaHeadlightSignature, {
        model: 'ioniq5',
        lights: 'low',
        gear: 'D',
        hazards: false,
        turnSignal: 'off',
        blinkState: false,
      })
    );

    const lowRight = html.match(/<rect[^>]*id="ioniq5-low-beam-right"[^>]*>/);
    const highRight = html.match(/<rect[^>]*id="ioniq5-high-beam-right"[^>]*>/);

    assert.ok(lowRight, 'ioniq5-low-beam-right rect must be rendered');
    assert.ok(highRight, 'ioniq5-high-beam-right rect must be rendered');
    assert.ok(lowRight[0].includes('y="1540"'), 'ioniq5-low-beam-right must use y=1540');
    assert.ok(highRight[0].includes('y="1540"'), 'ioniq5-high-beam-right must align at y=1540');
  });

  it('differentiates low beam, high beam, turn signals, and hood ajar states', () => {
    const lowHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(FrontFasciaHeadlightSignature, {
        model: 'gv60',
        lights: 'low',
        gear: 'D',
        hazards: false,
        turnSignal: 'left',
        blinkState: true,
        hoodOpen: true,
      })
    );

    assert.ok(lowHtml.includes('id="gv60-low-beams-right"'), 'GV60 must render gv60-low-beams-right');
    assert.ok(lowHtml.includes('id="gv60-high-beams-right"'), 'GV60 must render gv60-high-beams-right');
    assert.ok(lowHtml.includes('id="gv60-drl-left" class="text-amber-500'), 'Left blink must tint left DRL amber');
    assert.ok(lowHtml.includes('id="gv60-drl-right" class="text-sky-500'), 'Right DRL must stay ice-blue');
    assert.ok(lowHtml.includes('id="gv60-housings-left" class="text-amber-500/80'), 'Hood open must highlight housing amber');
  });
});
