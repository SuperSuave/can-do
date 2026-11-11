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
