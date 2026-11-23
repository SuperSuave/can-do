import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  VehicleRearChargingView,
  type EgmpModel,
} from '../components/VehicleOutlines';
import {
  EV6_FASCIA,
  GV60_FASCIA,
  IONIQ5_FASCIA,
  IONIQ6_FASCIA,
} from '../components/frontFasciaPaths';
import {
  EV6_REAR_CHARGING,
  GV60_REAR_CHARGING,
  IONIQ5_REAR_CHARGING,
  IONIQ6_REAR_CHARGING,
} from '../components/rearChargingPaths';

describe('VehicleRearChargingView EV6 Rear Charging Integration', () => {
  it('renders EV6 rear view with EV6 emblem, theme-aware styling, and clean SVG attributes', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ev6',
        soc: 72,
        chargeRateKw: 11.2,
        lights: 'auto',
        isCharging: true,
        trunkOpen: false,
      })
    );

    for (const id of [
      'ev6-rear-view',
      'ev6-rear-emblem',
      'ev6-body',
      'ev6-center-leds',
      'ev6-left-tail-light',
      'ev6-right-tail-light',
      'ev6-charging-interface',
      'ev6-j1772',
      'ev6-charge-door-open',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `EV6 rear view must include #${id}`);
    }

    for (const emblemPath of EV6_FASCIA.emblemPaths) {
      assert.ok(html.includes(emblemPath), 'EV6 rear emblem must reuse EV6_FASCIA.emblemPaths');
    }

    assert.ok(!html.includes('transform-origin'), 'must not emit CSS transform-origin');
    assert.ok(!html.includes('transform-box'), 'must not emit CSS transform-box');
    assert.ok(!html.includes('#000') && !html.includes('rgb(0, 0, 0)'), 'must not hardcode black colors');
    assert.ok(
      !html.includes('#fff') && !html.includes('rgb(255, 255, 255)'),
      'must not hardcode white colors'
    );
    assert.ok(
      html.includes('@media (prefers-reduced-motion: no-preference)'),
      'animations must opt in inside prefers-reduced-motion: no-preference'
    );

    const [vbMinX, , vbWidth] = EV6_REAR_CHARGING.viewBox.split(/\s+/).map(Number);
    const vbCenterX = vbMinX + vbWidth / 2;
    assert.ok(
      Math.abs(vbCenterX - 1320.43) <= 0.1,
      `EV6 viewBox center (${vbCenterX}) must align with tail centerline (~1320.43)`
    );
    assert.ok(
      vbMinX + vbWidth >= 2096,
      'EV6 viewBox right edge must encompass the open charge door without clipping'
    );
  });

  it('lights the 4-bar SoC indicators and cable energy stream accurately', () => {
    const charging65 = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ev6',
        soc: 65,
        chargeRateKw: 11,
        lights: 'auto',
        isCharging: true,
      })
    );

    const quarter = charging65.match(/<path[^>]*id="quarter-indicator"[^>]*>/)?.[0] ?? '';
    const half = charging65.match(/<path[^>]*id="half-indicator"[^>]*>/)?.[0] ?? '';
    const threeQuarter = charging65.match(/<path[^>]*id="three-quarter-indicator"[^>]*>/)?.[0] ?? '';
    const full = charging65.match(/<path[^>]*id="full-indicator"[^>]*>/)?.[0] ?? '';

    assert.ok(quarter.includes('fill="#34d399"') && !quarter.includes('ev6-rear-soc-pulse'));
    assert.ok(half.includes('fill="#34d399"') && !half.includes('ev6-rear-soc-pulse'));
    assert.ok(threeQuarter.includes('fill="#34d399"') && threeQuarter.includes('ev6-rear-soc-pulse'));
    assert.ok(full.includes('fill="#3f4654"') && !full.includes('ev6-rear-soc-pulse'));
    assert.ok(charging65.includes('id="ev6-cable-energy"'), 'cable energy stream must render when charging');

    const charging100 = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ev6',
        soc: 100,
        chargeRateKw: 0,
        lights: 'auto',
        isCharging: true,
      })
    );
    for (const id of ['quarter-indicator', 'half-indicator', 'three-quarter-indicator', 'full-indicator']) {
      const bar = charging100.match(new RegExp(`<path[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
      assert.ok(bar.includes('fill="#34d399"') && !bar.includes('ev6-rear-soc-pulse'), `${id} must be solid at 100%`);
    }

    const idle65 = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ev6',
        soc: 65,
        chargeRateKw: 0,
        lights: 'auto',
        isCharging: false,
      })
    );
    assert.ok(!idle65.includes('id="ev6-cable-energy"'), 'cable energy stream must not render when not charging');
  });

  it('reflects taillights off, left turn blinker, and liftgate open states', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ev6',
        soc: 50,
        chargeRateKw: 0,
        lights: 'off',
        turnSignal: 'left',
        blinkState: true,
        trunkOpen: true,
      })
    );

    const leftGroup = html.match(/<g id="ev6-left-tail-light">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const rightGroup = html.match(/<g id="ev6-right-tail-light">([\s\S]*?)<\/g>/)?.[1] ?? '';

    assert.ok(leftGroup.includes('fill="#450a0a"'), 'lights=off must dim taillight lens');
    assert.ok(leftGroup.includes('stroke="#f59e0b"'), 'left turn blink must tint left fender LED amber');
    assert.ok(!rightGroup.includes('stroke="#f59e0b"'), 'right fender LED must stay non-amber on left signal');
    assert.ok(html.includes('stroke="#f59e0b" stroke-opacity="0.95"'), 'trunkOpen must highlight tailgate seams amber');
    assert.ok(html.includes('id="ev6-rear-emblem"') && html.includes('text-amber-500/80'), 'trunkOpen must tint emblem amber');
  });

  it('renders dedicated rear views across all four E-GMP models without legacy side-profile fallback', () => {
    const allModels: EgmpModel[] = ['ev6', 'ioniq5', 'ioniq6', 'gv60'];
    for (const model of allModels) {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(VehicleRearChargingView, {
          model,
          soc: 80,
          chargeRateKw: 7.4,
          lights: 'auto',
        })
      );

      assert.ok(html.includes('id="hero-rear-charging-silhouette"'), `${model} must render #hero-rear-charging-silhouette`);
      assert.ok(!html.includes('hero-side-charging-silhouette'), `${model} must not emit legacy side charging id`);
      assert.ok(html.includes(`id="${model}-rear-view"`), `${model} must render #${model}-rear-view`);
      assert.ok(!html.includes('viewBox="0 0 460 148"'), `${model} must not fall back to legacy side silhouette`);
    }
  });
});

describe('VehicleRearChargingView Ioniq 5 Rear Charging Integration', () => {
  it('renders Ioniq 5 rear view with IONIQ 5 emblem, tail-centered viewBox, and theme-aware styling', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ioniq5',
        soc: 72,
        chargeRateKw: 11.2,
        lights: 'auto',
        isCharging: true,
        trunkOpen: false,
      })
    );

    for (const id of [
      'ioniq5-rear-view',
      'ioniq5-rear-emblem',
      'body-contours',
      'light-bar-frame',
      'pixel-taillights',
      'tailgate',
      'ioniq5-j1772',
      'ioniq5-charge-door-open',
      'ioniq5-cable-energy',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `Ioniq 5 rear view must include #${id}`);
    }

    for (const emblemPath of IONIQ5_FASCIA.emblemPaths) {
      assert.ok(html.includes(emblemPath), 'Ioniq 5 rear emblem must reuse IONIQ5_FASCIA.emblemPaths');
    }

    assert.ok(!html.includes('transform-origin'), 'must not emit CSS transform-origin');
    assert.ok(!html.includes('transform-box'), 'must not emit CSS transform-box');
    assert.ok(!html.includes('#000') && !html.includes('rgb(0, 0, 0)'), 'must not hardcode black colors');
    assert.ok(
      !html.includes('#fff') && !html.includes('rgb(255, 255, 255)'),
      'must not hardcode white colors'
    );
    assert.ok(
      html.includes('@media (prefers-reduced-motion: no-preference)'),
      'animations must opt in inside prefers-reduced-motion: no-preference'
    );

    const [vbMinX, , vbWidth] = IONIQ5_REAR_CHARGING.viewBox.split(/\s+/).map(Number);
    const vbCenterX = vbMinX + vbWidth / 2;
    assert.ok(
      Math.abs(vbCenterX - 1058.24) <= 0.1,
      `Ioniq 5 viewBox center (${vbCenterX}) must align with tail centerline (~1058.24)`
    );
    assert.ok(
      vbMinX + vbWidth >= 1772,
      'Ioniq 5 viewBox right edge must encompass the J1772 cable without clipping'
    );
  });

  it('omits cable energy stream when idle and reflects taillights off, blinker, and tailgate open states', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ioniq5',
        soc: 55,
        chargeRateKw: 0,
        lights: 'off',
        isCharging: false,
        turnSignal: 'left',
        blinkState: true,
        trunkOpen: true,
      })
    );

    assert.ok(!html.includes('id="ioniq5-cable-energy"'), 'cable energy stream must not render when not charging');

    const outerLeft = html.match(/<g id="lamp-outer-left">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const innerLeft = html.match(/<g id="lamp-inner-left">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const outerRight = html.match(/<g id="lamp-outer-right">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const tailgate = html.match(/<g id="tailgate"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? '';

    assert.ok(outerLeft.includes('stroke="#f59e0b"'), 'left turn blink must tint outer-left pixel lamp amber');
    assert.ok(innerLeft.includes('stroke="#991b1b"'), 'lights=off must dim inner-left pixel lamp');
    assert.ok(!outerRight.includes('stroke="#f59e0b"') && outerRight.includes('stroke="#991b1b"'), 'outer-right lamp must stay dim non-amber on left signal');
    assert.ok(tailgate.includes('stroke="#f59e0b"'), 'trunkOpen must highlight tailgate seams amber');
    assert.ok(html.includes('id="ioniq5-rear-emblem"') && html.includes('text-amber-500/80'), 'trunkOpen must tint emblem amber');
  });
});

describe('VehicleRearChargingView Ioniq 6 Rear Charging Integration', () => {
  it('renders Ioniq 6 rear view with IONIQ 6 emblem, 104 center pixels, and tail-centered viewBox', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ioniq6',
        soc: 72,
        chargeRateKw: 11.2,
        lights: 'auto',
        isCharging: true,
        trunkOpen: false,
      })
    );

    for (const id of [
      'ioniq6-rear-view',
      'ioniq6-rear-emblem',
      'ioniq6-body',
      'charge-port',
      'ioniq6-tail-lights',
      'ioniq6-lamp-center-upper',
      'ioniq6-lamp-center-lower',
      'lower-trim',
      'ioniq6-j1772',
      'ioniq6-charge-door-open',
      'ioniq6-cable-energy',
      'px-c-r1-c1',
      'px-c-r1-c52',
      'px-c-r2-c1',
      'px-c-r2-c52',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `Ioniq 6 rear view must include #${id}`);
    }

    for (const emblemPath of IONIQ6_FASCIA.emblemPaths) {
      assert.ok(html.includes(emblemPath), 'Ioniq 6 rear emblem must reuse IONIQ6_FASCIA.emblemPaths');
    }

    assert.ok(!html.includes('transform-origin'), 'must not emit CSS transform-origin');
    assert.ok(!html.includes('transform-box'), 'must not emit CSS transform-box');
    assert.ok(!html.includes('#000') && !html.includes('rgb(0, 0, 0)'), 'must not hardcode black colors');
    assert.ok(
      !html.includes('#fff') && !html.includes('rgb(255, 255, 255)'),
      'must not hardcode white colors'
    );
    assert.ok(
      html.includes('@media (prefers-reduced-motion: no-preference)'),
      'animations must opt in inside prefers-reduced-motion: no-preference'
    );

    const [vbMinX, , vbWidth] = IONIQ6_REAR_CHARGING.viewBox.split(/\s+/).map(Number);
    const vbCenterX = vbMinX + vbWidth / 2;
    assert.ok(
      Math.abs(vbCenterX - -1038.37) <= 0.1,
      `Ioniq 6 viewBox center (${vbCenterX}) must align with tail centerline (~-1038.37)`
    );
    assert.ok(
      vbMinX + vbWidth >= -417,
      'Ioniq 6 viewBox right edge must encompass the J1772 cable without clipping'
    );
  });

  it('omits cable energy stream when idle and reflects taillights off, right blinker, and trunk open states', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'ioniq6',
        soc: 55,
        chargeRateKw: 0,
        lights: 'off',
        isCharging: false,
        turnSignal: 'right',
        blinkState: true,
        trunkOpen: true,
      })
    );

    assert.ok(!html.includes('id="ioniq6-cable-energy"'), 'cable energy stream must not render when not charging');

    const centerUpper = html.match(/<g id="ioniq6-lamp-center-upper">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const leftLower = html.match(/<g id="ioniq6-left-pixels-lower"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? '';
    const rightLower = html.match(/<g id="ioniq6-right-pixels-lower"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? '';
    const lowerTrim = html.match(/<g id="lower-trim"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? '';

    assert.ok(centerUpper.includes('fill="#7f1d1d"'), 'lights=off must dim center upper red pixels');
    assert.ok(rightLower.includes('fill="#f59e0b"'), 'right turn blink must tint right lower pixels amber');
    assert.ok(
      !leftLower.includes('fill="#f59e0b"') && leftLower.includes('fill="#1e2229"'),
      'left lower pixels must stay dark non-amber on right signal'
    );
    assert.ok(lowerTrim.includes('stroke="#f59e0b"'), 'trunkOpen must highlight plinth seams amber');
    assert.ok(
      html.includes('id="ioniq6-rear-emblem"') && html.includes('text-amber-500/80'),
      'trunkOpen must tint emblem amber'
    );
  });
});

describe('VehicleRearChargingView GV60 Rear Charging Integration', () => {
  it('renders GV60 rear view with GV60 emblem, tail-centered viewBox, and theme-aware styling', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'gv60',
        soc: 72,
        chargeRateKw: 11.2,
        lights: 'auto',
        isCharging: true,
        trunkOpen: false,
      })
    );

    for (const id of [
      'gv60-rear-view',
      'gv60-rear-emblem',
      'gv60-body',
      'rear-spoiler',
      'lamp-chmsl',
      'taillights',
      'lamp-left-upper',
      'lamp-left-lower',
      'lamp-right-upper',
      'lamp-right-lower',
      'gv60-charge-door',
      'gv60-j1772',
      'gv60-cable-energy',
      'gv60-tailgate-seams',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `GV60 rear view must include #${id}`);
    }

    assert.ok(html.includes(GV60_FASCIA.emblemPath), 'GV60 rear emblem must reuse GV60_FASCIA.emblemPath');

    assert.ok(!html.includes('transform-origin'), 'must not emit CSS transform-origin');
    assert.ok(!html.includes('transform-box'), 'must not emit CSS transform-box');
    assert.ok(!html.includes('#000') && !html.includes('rgb(0, 0, 0)'), 'must not hardcode black colors');
    assert.ok(
      !html.includes('#fff') && !html.includes('rgb(255, 255, 255)'),
      'must not hardcode white colors'
    );
    assert.ok(
      html.includes('@media (prefers-reduced-motion: no-preference)'),
      'animations must opt in inside prefers-reduced-motion: no-preference'
    );

    const [vbMinX, , vbWidth] = GV60_REAR_CHARGING.viewBox.split(/\s+/).map(Number);
    const vbCenterX = vbMinX + vbWidth / 2;
    assert.ok(
      Math.abs(vbCenterX - -1510.7) <= 0.1,
      `GV60 viewBox center (${vbCenterX}) must align with tail centerline (~-1510.7)`
    );
    assert.ok(
      vbMinX + vbWidth >= -884,
      'GV60 viewBox right edge must encompass the J1772 cable without clipping'
    );
  });

  it('omits cable energy stream when idle and reflects taillights off, lower quad-lamp blinker, and tailgate open states', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VehicleRearChargingView, {
        model: 'gv60',
        soc: 55,
        chargeRateKw: 0,
        lights: 'off',
        isCharging: false,
        turnSignal: 'left',
        blinkState: true,
        trunkOpen: true,
      })
    );

    assert.ok(!html.includes('id="gv60-cable-energy"'), 'cable energy stream must not render when not charging');

    const leftUpper = html.match(/<g id="lamp-left-upper">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const leftLower = html.match(/<g id="lamp-left-lower">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const rightLower = html.match(/<g id="lamp-right-lower">([\s\S]*?)<\/g>/)?.[1] ?? '';
    const tailgate = html.match(/<g id="gv60-tailgate-seams">([\s\S]*?)<\/g>/)?.[1] ?? '';

    assert.ok(leftUpper.includes('fill="#991b1b"'), 'lights=off must dim upper quad lamp LED');
    assert.ok(leftLower.includes('fill="#f59e0b"'), 'left turn blink must tint lower-left quad lamp LED amber');
    assert.ok(
      !rightLower.includes('fill="#f59e0b"') && rightLower.includes('fill="#991b1b"'),
      'lower-right quad lamp must stay dim non-amber on left signal'
    );
    assert.ok(tailgate.includes('stroke="#f59e0b"'), 'trunkOpen must highlight tailgate seams amber');
    assert.ok(
      html.includes('id="gv60-rear-emblem"') && html.includes('text-amber-500/80'),
      'trunkOpen must tint emblem amber'
    );
  });
});
