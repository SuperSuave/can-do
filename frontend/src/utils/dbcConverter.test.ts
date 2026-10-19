import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDbc,
  parseCanIdString,
  formatCanIdToHex,
  deriveSignalBitRange,
} from './dbcConverter.js';

test('parseDbc handles empty and whitespace-only input', () => {
  const emptyRes = parseDbc('');
  assert.strictEqual(emptyRes.catalog.commands.length, 0);
  assert.strictEqual(emptyRes.stats.messageCount, 0);
  assert.strictEqual(emptyRes.stats.signalCount, 0);
  assert.strictEqual(emptyRes.stats.valueTableCount, 0);
  assert.strictEqual(emptyRes.stats.commentCount, 0);
  assert.deepStrictEqual(emptyRes.issues, []);

  const commentsRes = parseDbc('  \n// Vector DBC Header\n// Comments only\n  ');
  assert.strictEqual(commentsRes.catalog.commands.length, 0);
  assert.strictEqual(commentsRes.stats.messageCount, 0);
});

test('parseDbc parses standard 11-bit CAN messages and signals', () => {
  const dbc = `
BO_ 1096 STEERING_BUTTONS: 8 ECU
 SG_ STAR_BTN : 44|4@1+ (1,0) [0|15] "" ECU
  `.trim();

  const res = parseDbc(dbc);
  assert.strictEqual(res.stats.messageCount, 1);
  assert.strictEqual(res.stats.signalCount, 1);
  assert.strictEqual(res.catalog.commands.length, 1);

  const cmd = res.catalog.commands[0];
  assert.strictEqual(cmd.id, 'star_btn');
  assert.strictEqual(cmd.name, 'Star Btn');
  assert.strictEqual(cmd.state_can_id, '0x448');
  assert.strictEqual(cmd.category, 'Steering Wheel');
  assert.deepStrictEqual(cmd.roles, ['trigger']);

  // Start bit 44 is byte 5, bit 4 (high nibble)
  assert.strictEqual(cmd.from_payload, '* * * * * 0* * *');
  assert.strictEqual(cmd.to_payload, '* * * * * 1* * *');
});

test('parseDbc parses value tables (VAL_) into command options', () => {
  const dbc = `
BO_ 1096 STEERING_BUTTONS: 8 ECU
 SG_ STAR_BTN : 44|4@1+ (1,0) [0|15] "" ECU
VAL_ 1096 STAR_BTN 0 "Released" 1 "Pressed" ;
  `.trim();

  const res = parseDbc(dbc);
  assert.strictEqual(res.stats.valueTableCount, 1);

  const cmd = res.catalog.commands[0];
  assert.ok(cmd.options);
  assert.strictEqual(cmd.options.length, 2);

  assert.strictEqual(cmd.options[0].label, 'Released');
  assert.strictEqual(cmd.options[0].default, true);
  assert.strictEqual(cmd.options[0].payload, '* * * * * 0* * *');

  assert.strictEqual(cmd.options[1].label, 'Pressed');
  assert.strictEqual(cmd.options[1].default, false);
  assert.strictEqual(cmd.options[1].payload, '* * * * * 1* * *');
});

test('parseDbc parses extended 29-bit CAN IDs and infers condition roles for status signals', () => {
  // 2565882624 = 0x98F04300 (bit 31 set for 29-bit extended ID)
  // Clean 29-bit ID = 0x18F04300
  const dbc = `
BO_ 2565882624 CLIMATE_STATUS: 8 HVAC
 SG_ FAN_SPEED_STATUS : 16|8@1+ (1,0) [0|255] "rpm" HVAC
  `.trim();

  const res = parseDbc(dbc);
  assert.strictEqual(res.stats.messageCount, 1);

  const cmd = res.catalog.commands[0];
  assert.strictEqual(cmd.state_can_id, '0x18F04300');
  assert.strictEqual(cmd.category, 'Cabin Climate Control');
  // Contains "status" -> both trigger and condition roles
  assert.deepStrictEqual(cmd.roles, ['trigger', 'condition']);
  // Byte 2 full byte mask
  assert.strictEqual(cmd.from_payload, '* * 00 * * * * *');
  assert.strictEqual(cmd.to_payload, '* * 01 * * * * *');
});

test('parseDbc extracts author metadata and notes from DBC comments (CM_)', () => {
  const dbc = `
BO_ 1096 STEERING_BUTTONS: 8 ECU
 SG_ STAR_BTN : 44|4@1+ (1,0) [0|15] "" ECU
 SG_ MODE_BTN : 40|4@1+ (1,0) [0|15] "" ECU
CM_ BO_ 1096 "Steering wheel buttons switch bank" ;
CM_ SG_ 1096 STAR_BTN "Author: @hyundai_dev Notes: Custom navigation toggle" ;
CM_ SG_ 1096 MODE_BTN "Notes: Mode switch popup" ;
  `.trim();

  const res = parseDbc(dbc);
  assert.strictEqual(res.stats.commentCount, 3);

  const starCmd = res.catalog.commands.find(c => c.id === 'star_btn');
  assert.ok(starCmd);
  assert.ok(starCmd.contributor);
  assert.strictEqual(starCmd.contributor.github, 'hyundai_dev');
  assert.strictEqual(starCmd.contributor.notes, 'Custom navigation toggle');

  const modeCmd = res.catalog.commands.find(c => c.id === 'mode_btn');
  assert.ok(modeCmd);
  assert.strictEqual(modeCmd.popup_message, 'Mode switch popup');
});

test('parseDbc infers categories accurately across automotive subsystems', () => {
  const dbc = `
BO_ 500 BMS_BATTERY_MAIN: 8 BMS
 SG_ SOC_LEVEL : 0|8@1+ (1,0) [0|100] "%" BMS
BO_ 600 PRECON_CONTROLLER: 8 BATT
 SG_ PRECON_ACTIVE : 0|1@1+ (1,0) [0|1] "" BATT
BO_ 700 SEAT_COMFORT: 8 SEAT
 SG_ HEATED_SEAT_LEVEL : 0|4@1+ (1,0) [0|3] "" SEAT
BO_ 800 DOOR_LOCK_SYSTEM: 8 BCM
 SG_ TAILGATE_OPEN : 0|1@1+ (1,0) [0|1] "" BCM
  `.trim();

  const res = parseDbc(dbc);
  assert.strictEqual(res.catalog.commands.length, 4);

  assert.strictEqual(res.catalog.commands[0].category, 'Battery & Power');
  assert.strictEqual(res.catalog.commands[1].category, 'Battery Preconditioning');
  assert.strictEqual(res.catalog.commands[2].category, 'Seats & Steering Wheel Comfort');
  assert.strictEqual(res.catalog.commands[3].category, 'Vehicle Actuators & Features');
});

test('parseCanIdString handles both decimal and hex strings', () => {
  assert.deepStrictEqual(parseCanIdString('0x448'), { id: 1096, isExtended: false });
  assert.deepStrictEqual(parseCanIdString('1096'), { id: 1096, isExtended: false });
  assert.deepStrictEqual(parseCanIdString('0x18DAF110'), { id: 417001744, isExtended: true });
  assert.deepStrictEqual(parseCanIdString(''), { id: 0, isExtended: false });
  assert.deepStrictEqual(parseCanIdString(undefined), { id: 0, isExtended: false });
});

test('formatCanIdToHex formats numbers to clean uppercase hex', () => {
  assert.strictEqual(formatCanIdToHex(1096), '0x448');
  assert.strictEqual(formatCanIdToHex(417001744), '0x18DAF110');
  assert.strictEqual(formatCanIdToHex(0), '0x0');
});

test('deriveSignalBitRange derives bit offsets for nibble and byte transitions', () => {
  // Byte 2 high nibble differs
  const nibbleRange = deriveSignalBitRange('* * 0* * * * *', '* * 1* * * * *');
  assert.strictEqual(nibbleRange.startBit, 20); // 2 * 8 + 4
  assert.strictEqual(nibbleRange.length, 4);
  assert.strictEqual(nibbleRange.idleVal, 0);
  assert.strictEqual(nibbleRange.activeVal, 1);

  // Byte 1 low nibble differs
  const lowNibbleRange = deriveSignalBitRange('* *0 * * * * *', '* *1 * * * * *');
  assert.strictEqual(lowNibbleRange.startBit, 8); // 1 * 8
  assert.strictEqual(lowNibbleRange.length, 4);
});
