import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  findOptionForDashboardCommand,
  resolveDashboardCommandRequest,
} from './dashboardCommands.js';
import type { Catalog, Command } from '../types/catalog.js';

const catalogPath = new URL('../../../catalog/can_do_catalog.json', import.meta.url);
const realCatalog: Catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const ev6Vehicle = realCatalog.vehicles?.find((v) => v.id?.includes('ev6')) || null;

test('door_locks resolves lock and unlock without cross-matching Unlock on lock', () => {
  const lockReq = resolveDashboardCommandRequest('door_locks', 'lock', realCatalog, ev6Vehicle);
  assert.strictEqual(lockReq.entity, 'door_locks');
  assert.strictEqual(lockReq.command, 'Locked / Lock');
  assert.strictEqual(lockReq.can_id, '0x4A2');
  assert.ok(Array.isArray(lockReq.steps) && lockReq.steps.length === 3);
  assert.deepStrictEqual(lockReq.steps[0].payload, {
    D1: '0x00',
    D2: '0x00',
    D3: '0xFF',
    D4: '0x73',
    D5: '0xFF',
    D6: '0xFF',
    D7: '0xFF',
    D8: '0x00',
  });

  const unlockReq = resolveDashboardCommandRequest('door_locks', 'unlock', realCatalog, ev6Vehicle);
  assert.strictEqual(unlockReq.entity, 'door_locks');
  assert.strictEqual(unlockReq.command, 'Unlocked / Unlock');
  assert.strictEqual(unlockReq.can_id, '0x4A2');
  assert.ok(Array.isArray(unlockReq.steps) && unlockReq.steps.length === 4);
  assert.deepStrictEqual(unlockReq.steps[0].payload, {
    D1: '0x00',
    D2: '0x00',
    D3: '0xFF',
    D4: '0x43',
    D5: '0xFF',
    D6: '0xFF',
    D7: '0xC0',
    D8: '0x00',
  });
});

test('climate_driver_temp and climate_passenger_temp resolve param_range CAN bytes on 0x4A0', () => {
  const drv70 = resolveDashboardCommandRequest('climate_driver_temp', '70°F', realCatalog, ev6Vehicle);
  assert.strictEqual(drv70.entity, 'climate_driver_temp');
  assert.strictEqual(drv70.can_id, '0x4A0');
  assert.strictEqual(drv70.bus, 0);
  // 70 - 56 = 14 = 0x0E
  assert.deepStrictEqual(drv70.payload, { D2: '0x0E' });

  const pass74 = resolveDashboardCommandRequest('climate_passenger_temp', '74°F', realCatalog, ev6Vehicle);
  assert.strictEqual(pass74.entity, 'climate_passenger_temp');
  assert.strictEqual(pass74.can_id, '0x4A0');
  // 74 - 56 = 18 = 0x12
  assert.deepStrictEqual(pass74.payload, { D8: '0x12' });

  // Clamping at bounds (62..82°F -> 0x06..0x1A)
  const drvMin = resolveDashboardCommandRequest('climate_driver_temp', '50°F', realCatalog, ev6Vehicle);
  assert.deepStrictEqual(drvMin.payload, { D2: '0x06' });
  const drvMax = resolveDashboardCommandRequest('climate_driver_temp', '90°F', realCatalog, ev6Vehicle);
  assert.deepStrictEqual(drvMax.payload, { D2: '0x1A' });
});

test('ambient_light_brightness resolves Level 10 (not Level 1) and Off via multi-step burst', () => {
  const lvl10 = resolveDashboardCommandRequest(
    'ambient_light_brightness',
    'Brightness Level 10',
    realCatalog,
    ev6Vehicle
  );
  assert.strictEqual(lvl10.command, 'Brightness Level 10 (Max)');
  assert.strictEqual(lvl10.can_id, '0x4AD');
  assert.ok(Array.isArray(lvl10.steps) && lvl10.steps.length === 2);
  assert.notStrictEqual(lvl10.steps[0].payload, '0002082001000000');

  const off = resolveDashboardCommandRequest(
    'ambient_light_brightness',
    'Off',
    realCatalog,
    ev6Vehicle
  );
  assert.strictEqual(off.command, 'Off');
  assert.ok(Array.isArray(off.steps) && off.steps.length === 2);
  assert.strictEqual(off.steps[0].payload, '000208A000000000');
});

test('all discrete dashboard controls resolve valid CAN IDs and payloads/steps', () => {
  const cases: Array<[string, string, string]> = [
    ['charge_port', 'Opened / Open', '0x4A2'],
    ['charge_port', 'Closed / Shut', '0x4A2'],
    ['telematics_remote_tailgate', 'Open Tailgate / Trunk', '0x588'],
    ['drivers_seat_comfort', 'High Heat', '0x4A2'],
    ['passengers_seat_comfort', 'Medium Cool', '0x4A2'],
    ['rear_left_seat_comfort', 'Low Heat', '0x4A2'],
    ['rear_right_seat_comfort', 'Off', '0x4A2'],
    ['heated_steering_wheel_toggle', 'Heated Steering Wheel On', '0x4A2'],
    ['climate_driver_only_toggle', 'Driver Only On', '0x41D'],
    ['climate_sync_toggle', 'Sync Passenger to Driver', '0x4A0'],
    ['climate_heat_toggle', 'Heat On', '0x41D'],
    ['climate_ac_toggle', 'A/C On', '0x49F'],
    ['climate_rear_defrost', 'Defroster & Mirrors On', '0x4A2'],
    ['climate_airflow_direction', 'Body & Legs', '0x49F'],
    ['ac_charging_limit', '80%', '0x4C5'],
    ['dc_charging_limit', '90%', '0x4C5'],
    ['ambient_light_colors', 'Dreamy Purple', '0x4AD'],
    ['ambient_light_colors', 'Golden Insight / Orange Delight', '0x4AD'],
    ['ambient_light_colors', 'Color 24: Deep Purple / Violet', '0x4AD'],
  ];

  for (const [entity, command, expectedCanId] of cases) {
    const req = resolveDashboardCommandRequest(entity, command, realCatalog, ev6Vehicle);
    assert.strictEqual(req.entity, entity, `${entity} entity mismatch`);
    assert.strictEqual(req.can_id, expectedCanId, `${entity} CAN ID mismatch`);
    assert.ok(
      (Array.isArray(req.steps) && req.steps.length > 0) || Boolean(req.payload),
      `${entity} (${command}) missing steps and payload`
    );
    if (req.steps) {
      for (const st of req.steps) {
        assert.ok(st.can_id, `${entity} step missing inherited can_id`);
      }
    }
  }
});

test('remote_climate_tmu stays delegated to native ESP32 subsystem', () => {
  const req = resolveDashboardCommandRequest('remote_climate_tmu', 'Remote Climate On', realCatalog, ev6Vehicle);
  assert.strictEqual(req.entity, 'remote_climate_tmu');
  assert.deepStrictEqual(req, {
    entity: 'remote_climate_tmu',
    command: 'Remote Climate On',
  });
});

test('ambient_light_colors dynamic animations delegate to ESP32 ambient_anim without static steps fallback', () => {
  const rainbow = resolveDashboardCommandRequest('ambient_light_colors', 'Rainbow Spectrum Wave', realCatalog, ev6Vehicle);
  assert.deepStrictEqual(rainbow, {
    entity: 'ambient_light_colors',
    command: 'Rainbow Spectrum Wave',
  });

  const sunsetGlow = resolveDashboardCommandRequest('ambient_light_colors', 'Sunset Glow', realCatalog, ev6Vehicle);
  assert.deepStrictEqual(sunsetGlow, {
    entity: 'ambient_light_colors',
    command: 'Sunset Glow',
  });

  const warmSunset = resolveDashboardCommandRequest('ambient_light_colors', 'Color 57: Warm Sunset / Amber', realCatalog, ev6Vehicle);
  assert.strictEqual(warmSunset.can_id, '0x4AD');
  assert.ok(Array.isArray(warmSunset.steps) && warmSunset.steps.length === 2);
});

test('resolveDashboardCommandRequest applies vehicle variant network and option overrides', () => {
  const syntheticCatalog: Catalog = {
    can_do_version: 'test',
    vehicles: [
      { id: 'v_a', name: 'A', make: 'Kia', model: 'EV6', trim: 'GT-Line', year: '2023', region: 'US', family: 'kia_ev6', features: [] },
      { id: 'v_b', name: 'B', make: 'Hyundai', model: 'Ioniq 5', trim: 'Limited', year: '2024', region: 'US', family: 'hyundai_ioniq5', features: [] },
    ],
    commands: [
      {
        id: 'variant_switch',
        name: 'Variant Switch',
        category: 'Test',
        roles: ['action'],
        network: { bus: 0, action_can_id: '0x111' },
        options: [{ label: 'Switch On', payload: { D1: '0xAA' } }],
        variants: [
          {
            targets: ['kia_ev6'],
            network: { bus: 0, action_can_id: '0x111' },
            options: [{ label: 'Switch On', payload: { D1: '0xAA' } }],
          },
          {
            targets: ['hyundai_ioniq5'],
            network: { bus: 1, action_can_id: '0x222' },
            options: [{ label: 'Switch On', payload: { D3: '0xBB' } }],
          },
        ],
      } as Command,
    ],
  };

  const aReq = resolveDashboardCommandRequest('variant_switch', 'on', syntheticCatalog, syntheticCatalog.vehicles[0]);
  assert.strictEqual(aReq.can_id, '0x111');
  assert.strictEqual(aReq.bus, 0);
  assert.deepStrictEqual(aReq.payload, { D1: '0xAA' });

  const bReq = resolveDashboardCommandRequest('variant_switch', 'Switch On', syntheticCatalog, syntheticCatalog.vehicles[1]);
  assert.strictEqual(bReq.can_id, '0x222');
  assert.strictEqual(bReq.bus, 1);
  assert.deepStrictEqual(bReq.payload, { D3: '0xBB' });
});

test('findOptionForDashboardCommand matches longest option substring over short collision', () => {
  const matched = findOptionForDashboardCommand(
    [
      { label: 'Brightness Level 1' },
      { label: 'Brightness Level 10 (Max)' },
    ],
    'Brightness Level 10'
  );
  assert.strictEqual(matched?.label, 'Brightness Level 10 (Max)');
});
