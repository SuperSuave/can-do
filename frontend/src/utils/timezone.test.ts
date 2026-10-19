import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDARD_TIMEZONES,
  getTimezoneLabel,
  detectBrowserTimezone,
} from './timezone.js';

const originalDateTimeFormat = Intl.DateTimeFormat;
const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;

function mockBrowserTimezone(timeZone?: string, offsetMinutes?: number) {
  (Intl as any).DateTimeFormat = function () {
    return {
      resolvedOptions() {
        return { timeZone };
      },
    };
  };
  if (offsetMinutes !== undefined) {
    Date.prototype.getTimezoneOffset = function () {
      // In timezone.ts: const offsetMin = -new Date().getTimezoneOffset();
      // Therefore, to make offsetMin === X, getTimezoneOffset() must return -X.
      return -offsetMinutes;
    };
  }
}

function restoreBrowserTimezone() {
  Intl.DateTimeFormat = originalDateTimeFormat;
  Date.prototype.getTimezoneOffset = originalGetTimezoneOffset;
}

afterEach(() => {
  restoreBrowserTimezone();
});

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

test('detectBrowserTimezone returns a valid standard timezone ID in unmocked environment', () => {
  const detected = detectBrowserTimezone();
  assert.ok(typeof detected === 'string');
  const found = STANDARD_TIMEZONES.find(t => t.id === detected);
  assert.ok(found, `Expected detected timezone '${detected}' to be in STANDARD_TIMEZONES`);
});

test('detectBrowserTimezone handles direct standard timezone matches', () => {
  mockBrowserTimezone('US/Pacific');
  assert.strictEqual(detectBrowserTimezone(), 'US/Pacific');

  mockBrowserTimezone('Europe/London');
  assert.strictEqual(detectBrowserTimezone(), 'Europe/London');

  mockBrowserTimezone('Asia/Tokyo');
  assert.strictEqual(detectBrowserTimezone(), 'Asia/Tokyo');

  mockBrowserTimezone('UTC');
  assert.strictEqual(detectBrowserTimezone(), 'UTC');
});

test('detectBrowserTimezone handles common city and regional mappings', () => {
  const cases: [string, string][] = [
    ['America/Los_Angeles', 'US/Pacific'],
    ['America/Vancouver', 'US/Pacific'],
    ['America/Tijuana', 'US/Pacific'],
    ['America/Denver', 'US/Mountain'],
    ['America/Edmonton', 'US/Mountain'],
    ['America/Boise', 'US/Mountain'],
    ['America/Phoenix', 'US/Arizona'],
    ['America/Chicago', 'US/Central'],
    ['America/Winnipeg', 'US/Central'],
    ['America/Mexico_City', 'US/Central'],
    ['America/New_York', 'US/Eastern'],
    ['America/Toronto', 'US/Eastern'],
    ['America/Detroit', 'US/Eastern'],
    ['America/Montreal', 'US/Eastern'],
    ['America/Anchorage', 'US/Alaska'],
    ['America/Juneau', 'US/Alaska'],
    ['Pacific/Honolulu', 'US/Hawaii'],
    ['Europe/Dublin', 'Europe/London'],
    ['Europe/Lisbon', 'Europe/London'],
    ['Europe/Paris', 'Europe/Berlin'],
    ['Europe/Rome', 'Europe/Berlin'],
    ['Europe/Madrid', 'Europe/Berlin'],
    ['Europe/Amsterdam', 'Europe/Berlin'],
    ['Europe/Athens', 'Europe/Helsinki'],
    ['Europe/Bucharest', 'Europe/Helsinki'],
    ['Europe/Kyiv', 'Europe/Helsinki'],
    ['Australia/Melbourne', 'Australia/Sydney'],
    ['Australia/Brisbane', 'Australia/Sydney'],
    ['Australia/Darwin', 'Australia/Adelaide'],
    ['Australia/Perth', 'Australia/Perth'],
  ];

  for (const [inputTz, expected] of cases) {
    mockBrowserTimezone(inputTz);
    assert.strictEqual(
      detectBrowserTimezone(),
      expected,
      `Failed mapping for input timezone '${inputTz}'`
    );
  }
});

test('detectBrowserTimezone falls back to US/Pacific when browser timezone is missing or empty', () => {
  mockBrowserTimezone(undefined);
  assert.strictEqual(detectBrowserTimezone(), 'US/Pacific');

  mockBrowserTimezone('');
  assert.strictEqual(detectBrowserTimezone(), 'US/Pacific');
});

test('detectBrowserTimezone catches exceptions and falls back to US/Pacific', () => {
  (Intl as any).DateTimeFormat = function () {
    throw new Error('Intl API unavailable');
  };
  assert.strictEqual(detectBrowserTimezone(), 'US/Pacific');
});

test('detectBrowserTimezone approximates timezone by UTC offset when city is unknown', () => {
  // -480 min offset -> US/Pacific
  mockBrowserTimezone('Unknown/Region', -480);
  assert.strictEqual(detectBrowserTimezone(), 'US/Pacific');

  // -360 min offset -> US/Central (CST)
  mockBrowserTimezone('Unknown/Region', -360);
  assert.strictEqual(detectBrowserTimezone(), 'US/Central');

  // -240 min offset -> US/Eastern (EDT)
  mockBrowserTimezone('Unknown/Region', -240);
  assert.strictEqual(detectBrowserTimezone(), 'US/Eastern');

  // 0 min offset -> Europe/London (GMT)
  mockBrowserTimezone('Unknown/Region', 0);
  assert.strictEqual(detectBrowserTimezone(), 'Europe/London');

  // +120 min offset -> Europe/Berlin (CEST)
  mockBrowserTimezone('Unknown/Region', 120);
  assert.strictEqual(detectBrowserTimezone(), 'Europe/Berlin');

  // Completely unknown offset -> UTC
  mockBrowserTimezone('Unknown/Region', 720);
  assert.strictEqual(detectBrowserTimezone(), 'UTC');
});
