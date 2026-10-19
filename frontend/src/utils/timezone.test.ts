import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDARD_TIMEZONES,
  getTimezoneLabel,
  detectBrowserTimezone,
} from './timezone.js';

test('getTimezoneLabel returns default for empty/undefined input', () => {
  assert.strictEqual(getTimezoneLabel(undefined), 'UTC / GMT');
  assert.strictEqual(getTimezoneLabel(''), 'UTC / GMT');
});

test('getTimezoneLabel returns friendly labels with case insensitivity', () => {
  assert.strictEqual(getTimezoneLabel('US/Pacific'), 'US Pacific (PT)');
  assert.strictEqual(getTimezoneLabel('us/pacific'), 'US Pacific (PT)');
  assert.strictEqual(getTimezoneLabel('US/PACIFIC'), 'US Pacific (PT)');
  assert.strictEqual(getTimezoneLabel('Europe/London'), 'Western Europe / UK (GMT/BST)');
  assert.strictEqual(getTimezoneLabel('europe/london'), 'Western Europe / UK (GMT/BST)');
  assert.strictEqual(getTimezoneLabel('UTC'), 'UTC / GMT');
  assert.strictEqual(getTimezoneLabel('utc'), 'UTC / GMT');
});

test('getTimezoneLabel falls back to input string for unrecognized timezones', () => {
  assert.strictEqual(getTimezoneLabel('Mars/Olympus'), 'Mars/Olympus');
  assert.strictEqual(getTimezoneLabel('Custom/Tz'), 'Custom/Tz');
});

test('detectBrowserTimezone returns a valid standard timezone ID', () => {
  const detected = detectBrowserTimezone();
  assert.ok(typeof detected === 'string');
  const found = STANDARD_TIMEZONES.find(t => t.id === detected);
  assert.ok(found, `Expected detected timezone '${detected}' to be in STANDARD_TIMEZONES`);
});
