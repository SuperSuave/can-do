import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPayloadToken,
  validatePayloadString,
  validatePayload,
} from './canValidator.js';

test('validatePayloadString handles empty, undefined, and whitespace inputs', () => {
  assert.deepStrictEqual(validatePayloadString(undefined), { isValid: true, byteCount: 0 });
  assert.deepStrictEqual(validatePayloadString(''), { isValid: true, byteCount: 0 });
  assert.deepStrictEqual(validatePayloadString('   '), { isValid: true, byteCount: 0 });
});

test('validatePayloadString validates continuous hex strings with and without 0x prefix', () => {
  // 8-byte standard frame (16 chars)
  const res1 = validatePayloadString('0102030405060708');
  assert.strictEqual(res1.isValid, true);
  assert.strictEqual(res1.byteCount, 8);

  // With 0x prefix
  const res2 = validatePayloadString('0x0102030405060708');
  assert.strictEqual(res2.isValid, true);
  assert.strictEqual(res2.byteCount, 8);

  // 4-byte frame uppercase/lowercase
  const res3 = validatePayloadString('0xDEADBEEF');
  assert.strictEqual(res3.isValid, true);
  assert.strictEqual(res3.byteCount, 4);

  const res4 = validatePayloadString('cafe0011');
  assert.strictEqual(res4.isValid, true);
  assert.strictEqual(res4.byteCount, 4);
});

test('validatePayloadString validates space-separated hex bytes', () => {
  const res1 = validatePayloadString('01 02 03 04 05 06 07 08');
  assert.strictEqual(res1.isValid, true);
  assert.strictEqual(res1.byteCount, 8);

  // Multiple spaces between tokens
  const res2 = validatePayloadString('AA   BB    CC  DD');
  assert.strictEqual(res2.isValid, true);
  assert.strictEqual(res2.byteCount, 4);
});

test('validatePayloadString accepts valid wildcards and negated tokens in space-separated payload', () => {
  // Full wildcard (*), nibble wildcards (*0, 0*, *F, F*), and negated bytes (!00, !FF)
  const payload = '01 * *0 0* *F F* !00 !FF';
  const res = validatePayloadString(payload);
  assert.strictEqual(res.isValid, true);
  assert.strictEqual(res.byteCount, 8);
});

test('validatePayloadString rejects invalid tokens and reports error with position', () => {
  // Non-hex token 'ZZ' at position 3
  const res1 = validatePayloadString('01 02 ZZ 04');
  assert.strictEqual(res1.isValid, false);
  assert.strictEqual(res1.byteCount, 4);
  assert.match(res1.error ?? '', /Invalid byte token 'ZZ' at position 3/);

  // 3-digit hex '123' at position 2
  const res2 = validatePayloadString('01 123 03');
  assert.strictEqual(res2.isValid, false);
  assert.match(res2.error ?? '', /Invalid byte token '123' at position 2/);

  // Odd length hex string without spaces
  const res3 = validatePayloadString('123');
  assert.strictEqual(res3.isValid, false);
  assert.match(res3.error ?? '', /Invalid byte token '123'/);

  // Stray characters '-'
  const res4 = validatePayloadString('01 - 03');
  assert.strictEqual(res4.isValid, false);
  assert.match(res4.error ?? '', /Invalid byte token '-'/);
});

test('validatePayloadString rejects payloads exceeding 4096 transport limit', () => {
  const hugePayload = Array(4097).fill('00').join(' ');
  const res = validatePayloadString(hugePayload);
  assert.strictEqual(res.isValid, false);
  assert.strictEqual(res.byteCount, 4097);
  assert.match(res.error ?? '', /Payload exceeds maximum transport limit/);
});

test('isValidPayloadToken validates individual token formats correctly', () => {
  // Valid tokens
  assert.strictEqual(isValidPayloadToken('*'), true);
  assert.strictEqual(isValidPayloadToken('*0'), true);
  assert.strictEqual(isValidPayloadToken('0*'), true);
  assert.strictEqual(isValidPayloadToken('*F'), true);
  assert.strictEqual(isValidPayloadToken('A*'), true);
  assert.strictEqual(isValidPayloadToken('!00'), true);
  assert.strictEqual(isValidPayloadToken('!FF'), true);
  assert.strictEqual(isValidPayloadToken('00'), true);
  assert.strictEqual(isValidPayloadToken('FF'), true);
  assert.strictEqual(isValidPayloadToken('1a'), true);

  // Invalid tokens
  assert.strictEqual(isValidPayloadToken(''), false);
  assert.strictEqual(isValidPayloadToken('***'), false);
  assert.strictEqual(isValidPayloadToken('**'), false);
  assert.strictEqual(isValidPayloadToken('!0'), false);
  assert.strictEqual(isValidPayloadToken('!FFF'), false);
  assert.strictEqual(isValidPayloadToken('123'), false);
  assert.strictEqual(isValidPayloadToken('G'), false);
  assert.strictEqual(isValidPayloadToken('ZZ'), false);
});

test('validatePayload handles ByteMap and hex object formats', () => {
  // Object with 'hex' key
  const hexObj = validatePayload({ hex: '0x01020304' });
  assert.strictEqual(hexObj.isValid, true);
  assert.strictEqual(hexObj.byteCount, 4);

  // Object with odd hex length is rejected
  const badHexObj = validatePayload({ hex: '123' });
  assert.strictEqual(badHexObj.isValid, false);

  // D1..D8 ByteMap
  const byteMap = validatePayload({ D1: '0x01', D2: '0x02', D8: '!FF' });
  assert.strictEqual(byteMap.isValid, true);
  assert.strictEqual(byteMap.byteCount, 3);

  // Invalid key in ByteMap
  const badKeyMap = validatePayload({ D0: '0x01' });
  assert.strictEqual(badKeyMap.isValid, false);
});
