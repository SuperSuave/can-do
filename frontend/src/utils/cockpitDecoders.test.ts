import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeChargePortCanFrame,
  decodeChargingCanFrame,
  decodeRearSeatEntityUpdate,
  decodeSeatComfortByte,
  decodeSeatLevel,
  decodeSunroofEntityState,
  decodeAirflowCanByte,
  decodeAirflowEntityState,
  decodeDriverOnlyCanFrame,
  decodeAmbientCanFrame,
  getAmbientColorHex,
  AMBIENT_LIGHT_THEMES,
  AMBIENT_PALETTE_64,
  AIRFLOW_MODE_COMMAND_LABELS,
  displayTempToFahrenheit,
  fahrenheitToDisplayTemp,
  formatOdometerFromKm,
  normalizeHexCanId,
  parseBooleanEntityState,
  parseChargingEntityState,
  parseDualCabinTempToF,
  parseOdometerStateToKm,
  parseSingleCabinTempToF,
} from './cockpitDecoders.js';
import { resolveVariant } from './catalogUtils.js';
import type { Catalog, Command } from '../types/catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const catalogPath = path.resolve(__dirname, '../../../catalog/can_do_catalog.json');
const catalog: Catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));

test('parseChargingEntityState rejects Inactive, Not Charging, and Unplugged labels', () => {
  assert.strictEqual(parseChargingEntityState('Inactive'), false);
  assert.strictEqual(parseChargingEntityState('inactive'), false);
  assert.strictEqual(parseChargingEntityState('Not Charging / Disconnected'), false);
  assert.strictEqual(parseChargingEntityState('Not Charging'), false);
  assert.strictEqual(parseChargingEntityState('Disconnected'), false);
  assert.strictEqual(parseChargingEntityState('Unplugged'), false);
  assert.strictEqual(parseChargingEntityState('OFF'), false);
  assert.strictEqual(parseChargingEntityState('Unknown'), false);
  assert.strictEqual(parseChargingEntityState(''), false);

  assert.strictEqual(parseChargingEntityState('Charging'), true);
  assert.strictEqual(parseChargingEntityState('Charging In Progress'), true);
  assert.strictEqual(parseChargingEntityState('Active'), true);
  assert.strictEqual(parseChargingEntityState('ACTIVE / PLUGGED IN'), true);
  assert.strictEqual(parseChargingEntityState('Plugged In'), true);
  assert.strictEqual(parseChargingEntityState('true'), true);
});

test('parseBooleanEntityState does not match Inactive as active or Stopped as start', () => {
  assert.strictEqual(parseBooleanEntityState('Inactive'), false);
  assert.strictEqual(parseBooleanEntityState('Turned OFF / Inactive'), false);
  assert.strictEqual(parseBooleanEntityState('OFF'), false);
  assert.strictEqual(parseBooleanEntityState('None'), false);
  assert.strictEqual(parseBooleanEntityState('Stopped'), false);
  assert.strictEqual(parseBooleanEntityState('Unknown'), false);

  assert.strictEqual(parseBooleanEntityState('Active'), true);
  assert.strictEqual(parseBooleanEntityState('Turned ON / Active'), true);
  assert.strictEqual(parseBooleanEntityState('ON'), true);
  assert.strictEqual(parseBooleanEntityState('High'), true);
  assert.strictEqual(parseBooleanEntityState('Left Signal Active / On'), true);
});

test('decodeChargingCanFrame decodes E-GMP 0x326 using Byte D5 (bits 0:1), ignoring D3 bit 0', () => {
  const condCharging = catalog.commands.find(c => c.id === 'cond_charging') as Command;
  assert.ok(condCharging, 'cond_charging must exist in catalog');
  const egmpResolved = resolveVariant(condCharging, {
    id: 'ev6_gtline',
    name: 'Kia EV6 GT-Line',
    make: 'Kia',
    model: 'EV6',
    trim: 'GT-Line',
    region: 'us',
    features: [],
    family: 'kia_ev6',
  });
  const mappedId = normalizeHexCanId(egmpResolved.network?.state_can_id);
  assert.strictEqual(mappedId, '326');

  // Unplugged / idle with D3 bit 0 set (previously falsely decoded as charging via bytes[2] & 0x01)
  assert.strictEqual(
    decodeChargingCanFrame('326', [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00], egmpResolved.options, mappedId),
    false
  );
  // Idle with D5 = 0x10 (bits 0:1 == 0) and D3 bit 0 set
  assert.strictEqual(
    decodeChargingCanFrame('0x326', [0x00, 0x00, 0x01, 0x00, 0x10, 0x00, 0x00, 0x00], egmpResolved.options, mappedId),
    false
  );
  // Non-charging reserved bits (D5 & 0x03 == 2 or 3)
  assert.strictEqual(
    decodeChargingCanFrame('326', [0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00], egmpResolved.options, mappedId),
    false
  );
  // Active charging (D5 bits 0:1 == 1)
  assert.strictEqual(
    decodeChargingCanFrame('326', [0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], egmpResolved.options, mappedId),
    true
  );
  assert.strictEqual(
    decodeChargingCanFrame('326', [0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00], egmpResolved.options, mappedId),
    true
  );
  // Too short for D5
  assert.strictEqual(
    decodeChargingCanFrame('326', [0x00, 0x00, 0x01, 0x00], egmpResolved.options, mappedId),
    null
  );
});

test('decodeChargingCanFrame decodes Legacy Gen 2 0x594 using Byte D2 bit 1 (0x02)', () => {
  const condCharging = catalog.commands.find(c => c.id === 'cond_charging') as Command;
  const gen2Resolved = resolveVariant(condCharging, {
    id: 'hyundai_kona_ev',
    name: 'Hyundai Kona EV',
    make: 'Hyundai',
    model: 'Kona EV',
    trim: 'Limited',
    region: 'us',
    features: [],
    family: 'all_gen2',
  });
  const mappedId = normalizeHexCanId(gen2Resolved.network?.state_can_id);
  assert.strictEqual(mappedId, '594');

  assert.strictEqual(
    decodeChargingCanFrame('594', [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00], gen2Resolved.options, mappedId),
    false
  );
  assert.strictEqual(
    decodeChargingCanFrame('594', [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], gen2Resolved.options, mappedId),
    true
  );
});

test('decodeChargingCanFrame returns null for unrelated CAN IDs', () => {
  assert.strictEqual(decodeChargingCanFrame('30b', [0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x10, 0x00]), null);
  assert.strictEqual(decodeChargingCanFrame('411', [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]), null);
});

test('odometer parsing treats unitless firmware emission as km and converts cleanly to imperial miles', () => {
  const km = parseOdometerStateToKm('90296');
  assert.strictEqual(km, 90296);
  assert.strictEqual(formatOdometerFromKm(km!, 'imperial'), 56107);
  assert.strictEqual(formatOdometerFromKm(km!, 'metric'), 90296);

  const kmFromMiles = parseOdometerStateToKm('56107 mi');
  assert.ok(kmFromMiles !== null);
  assert.strictEqual(formatOdometerFromKm(kmFromMiles!, 'imperial'), 56107);
});

test('cabin target temp parsing handles dual °F strings in both F and C display modes', () => {
  const dual = parseDualCabinTempToF('72 / 72');
  assert.deepStrictEqual(dual, { driverF: 72, passengerF: 72 });
  assert.strictEqual(fahrenheitToDisplayTemp(dual.driverF!, 'F'), 72);
  assert.strictEqual(fahrenheitToDisplayTemp(dual.driverF!, 'C'), 22);

  assert.strictEqual(parseSingleCabinTempToF('68°F'), 68);
  assert.strictEqual(parseSingleCabinTempToF('22°C'), 72);
  assert.strictEqual(displayTempToFahrenheit(22, 'C'), 72);
  assert.strictEqual(displayTempToFahrenheit(72, 'F'), 72);
});

test('seat decoders handle Off transitions and isolate rear left/right state updates', () => {
  assert.strictEqual(decodeSeatLevel('Off'), 'off');
  assert.strictEqual(decodeSeatLevel('Medium Heat'), 'heat_med');
  assert.strictEqual(decodeSeatLevel('High Cool'), 'cool_high');

  assert.strictEqual(decodeSeatComfortByte(0x16), 'off');
  assert.strictEqual(decodeSeatComfortByte(0x46), 'heat_high');
  assert.strictEqual(decodeSeatComfortByte(0x2e), 'cool_high');

  assert.deepStrictEqual(decodeRearSeatEntityUpdate('rear_right_seat_comfort', 'Off'), { right: 'off' });
  assert.deepStrictEqual(decodeRearSeatEntityUpdate('rear_left_seat_comfort', 'High Heat'), { left: 'heat_high' });
  assert.deepStrictEqual(decodeRearSeatEntityUpdate('rear_seats_comfort', 'Rear Right Off'), { right: 'off' });
  assert.deepStrictEqual(decodeRearSeatEntityUpdate('rear_seats_comfort', 'Rear Left Low Heat'), { left: 'heat_low' });
});

test('decodeChargePortCanFrame uses catalog 0x3AA Byte D4 (0x01=Open, 0x02=Closed)', () => {
  const chargePort = catalog.commands.find(c => c.id === 'charge_port') as Command;
  assert.ok(chargePort, 'charge_port must exist in catalog');
  const mappedId = normalizeHexCanId(chargePort.network?.state_can_id);
  assert.strictEqual(mappedId, '3aa');

  // D4 = 0x02 (Closed), even if D5 bit 1 happens to be set
  assert.strictEqual(
    decodeChargePortCanFrame('3aa', [0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0x00], chargePort.options, mappedId),
    false
  );
  // D4 = 0x01 (Open), even if D5 bit 1 is 0
  assert.strictEqual(
    decodeChargePortCanFrame('3aa', [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], chargePort.options, mappedId),
    true
  );
});

test('decodeSunroofEntityState separates cover shade from glass position', () => {
  assert.deepStrictEqual(decodeSunroofEntityState('Cover Opened'), { sunshade: 'open' });
  assert.deepStrictEqual(decodeSunroofEntityState('Cover Closed'), { sunshade: 'closed' });
  assert.deepStrictEqual(decodeSunroofEntityState('Glass Tilted / Windbreak'), { glassState: 'vent' });
  assert.deepStrictEqual(decodeSunroofEntityState('closed'), { glassState: 'closed' });
});

test('decodeAirflowCanByte decodes 0x31B Byte D4 nibble distribution', () => {
  assert.strictEqual(decodeAirflowCanByte(0x00), 'auto');
  assert.strictEqual(decodeAirflowCanByte(0x15), 'face');
  assert.strictEqual(decodeAirflowCanByte(0x27), 'face_feet');
  assert.strictEqual(decodeAirflowCanByte(0x32), 'feet');
  assert.strictEqual(decodeAirflowCanByte(0x40), 'defrost');
  assert.strictEqual(decodeAirflowCanByte(0x50), null);
});

test('decodeAirflowEntityState decodes textual status descriptions', () => {
  assert.strictEqual(decodeAirflowEntityState('Auto'), 'auto');
  assert.strictEqual(decodeAirflowEntityState('Body / Face Vents'), 'face');
  assert.strictEqual(decodeAirflowEntityState('Body & Legs'), 'face_feet');
  assert.strictEqual(decodeAirflowEntityState('Legs / Floor Vents'), 'feet');
  assert.strictEqual(decodeAirflowEntityState('Legs & Windshield Defog'), 'defrost');
  assert.strictEqual(decodeAirflowEntityState('Random String'), null);
});

test('AIRFLOW_MODE_COMMAND_LABELS maps modes directly to catalog options', () => {
  const airflowCmd = catalog.commands.find(c => c.id === 'climate_airflow_direction');
  assert.ok(airflowCmd, 'climate_airflow_direction must exist in catalog');
  const catalogLabels = airflowCmd.options?.map(o => o.label) || [];
  for (const [, label] of Object.entries(AIRFLOW_MODE_COMMAND_LABELS)) {
    assert.ok(
      catalogLabels.includes(label),
      `Catalog climate_airflow_direction must include label "${label}"`
    );
  }
});

test('decodeDriverOnlyCanFrame decodes 0x465 Byte D7', () => {
  // Too short
  assert.strictEqual(decodeDriverOnlyCanFrame([0, 0, 0, 0, 0, 0]), null);

  // D7 = 0x04 (Driver Only On)
  const onPayload = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00];
  assert.strictEqual(decodeDriverOnlyCanFrame(onPayload), true);

  // D7 = 0x0C (Driver Only Off)
  const offPayload = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x00];
  assert.strictEqual(decodeDriverOnlyCanFrame(offPayload), false);

  // Other bits in high nibble preserved (e.g. 0x34 -> 0x04)
  assert.strictEqual(decodeDriverOnlyCanFrame([0, 0, 0, 0, 0, 0, 0x34]), true);
  assert.strictEqual(decodeDriverOnlyCanFrame([0, 0, 0, 0, 0, 0, 0x3C]), false);
});

test('decodeAmbientCanFrame decodes 0x455 brightness level and active color option', () => {
  const ambientCmd = catalog.commands.find(c => c.id === 'ambient_light_colors') as Command;
  assert.ok(ambientCmd, 'ambient_light_colors must exist in catalog');

  // Payload 1: Dreamy Purple at Level 10 (from real vehicle capture)
  // 4B 00 6B 69 55 59 00 00
  const dreamyPurplePayload = [0x4b, 0x00, 0x6b, 0x69, 0x55, 0x59, 0x00, 0x00];
  const res1 = decodeAmbientCanFrame(dreamyPurplePayload, ambientCmd.options);
  assert.ok(res1);
  assert.strictEqual(res1.brightness, 10);
  assert.strictEqual(res1.activeOptionLabel, 'Dreamy Purple');
  assert.strictEqual(res1.hexColor, '#6b6955');

  // Payload 2: Dreamy Purple at Level 0 / Off
  // 41 00 6B 69 55 59 00 00
  const dreamyPurpleOff = [0x41, 0x00, 0x6b, 0x69, 0x55, 0x59, 0x00, 0x00];
  const res2 = decodeAmbientCanFrame(dreamyPurpleOff, ambientCmd.options);
  assert.ok(res2);
  assert.strictEqual(res2.brightness, 0);
  assert.strictEqual(res2.activeOptionLabel, 'Dreamy Purple');

  // Payload 3: Golden Insight at Level 10
  // 4B 00 D0 C1 75 55 00 00
  const goldenInsight = [0x4b, 0x00, 0xd0, 0xc1, 0x75, 0x55, 0x00, 0x00];
  const res3 = decodeAmbientCanFrame(goldenInsight, ambientCmd.options);
  assert.ok(res3);
  assert.strictEqual(res3.brightness, 10);
  assert.strictEqual(res3.activeOptionLabel, 'Golden Insight / Orange Delight');
  assert.strictEqual(res3.hexColor, '#ff8c00');
});

test('AMBIENT_LIGHT_THEMES and AMBIENT_PALETTE_64 cover all catalog options', () => {
  const ambientCmd = catalog.commands.find(c => c.id === 'ambient_light_colors') as Command;
  assert.ok(ambientCmd, 'ambient_light_colors must exist in catalog');
  assert.strictEqual(ambientCmd.options.length, 70);
  assert.strictEqual(AMBIENT_LIGHT_THEMES.length, 6);
  assert.strictEqual(AMBIENT_PALETTE_64.length, 64);

  // Every theme in AMBIENT_LIGHT_THEMES exists in catalog options
  for (const t of AMBIENT_LIGHT_THEMES) {
    assert.ok(
      ambientCmd.options.some(o => o.label === t.label),
      `Theme "${t.label}" must exist in catalog options`
    );
  }

  // Every palette color in AMBIENT_PALETTE_64 exists in catalog options
  for (const p of AMBIENT_PALETTE_64) {
    assert.ok(
      ambientCmd.options.some(o => o.label === p.label),
      `Palette color "${p.label}" must exist in catalog options`
    );
  }
});


