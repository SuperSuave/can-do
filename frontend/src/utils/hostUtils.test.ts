import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExternalHost,
  isRunningOnDevice,
  getDefaultDeviceHost,
  getDefaultEspIp,
  resolveDeviceBaseUrl,
} from './hostUtils.js';

function setMockWindow(hostname: string, port = '', origin?: string, host?: string) {
  const computedHost = host ?? (port ? `${hostname}:${port}` : hostname);
  const computedOrigin = origin ?? `http://${computedHost}`;
  (globalThis as any).window = {
    location: {
      hostname,
      port,
      host: computedHost,
      origin: computedOrigin,
    },
  };
}

function clearMockWindow() {
  delete (globalThis as any).window;
}

afterEach(() => {
  clearMockWindow();
});

test('getDefaultDeviceHost returns default IP when window is undefined', () => {
  clearMockWindow();
  assert.strictEqual(isExternalHost(), true);
  assert.strictEqual(isRunningOnDevice(), false);
  assert.strictEqual(getDefaultDeviceHost(), 'http://192.168.4.1');
  assert.strictEqual(getDefaultEspIp(), '192.168.4.1');
  assert.strictEqual(resolveDeviceBaseUrl(), 'http://192.168.4.1');
});

test('getDefaultDeviceHost returns auto when hosted on device SoftAP (192.168.4.1)', () => {
  setMockWindow('192.168.4.1', '', 'http://192.168.4.1');
  assert.strictEqual(isExternalHost(), false);
  assert.strictEqual(isRunningOnDevice(), true);
  assert.strictEqual(getDefaultDeviceHost(), 'auto');
  assert.strictEqual(getDefaultEspIp(), '192.168.4.1');
  assert.strictEqual(resolveDeviceBaseUrl('auto'), 'http://192.168.4.1');
});

test('getDefaultDeviceHost returns auto when hosted on station Wi-Fi / mDNS (can-do.local)', () => {
  setMockWindow('can-do.local', '', 'http://can-do.local');
  assert.strictEqual(isExternalHost(), false);
  assert.strictEqual(isRunningOnDevice(), true);
  assert.strictEqual(getDefaultDeviceHost(), 'auto');
  assert.strictEqual(getDefaultEspIp(), 'can-do.local');
  assert.strictEqual(resolveDeviceBaseUrl('auto'), 'http://can-do.local');
});

test('getDefaultDeviceHost returns http://192.168.4.1 when hosted on GitHub Pages', () => {
  setMockWindow('supersuave.github.io', '', 'https://supersuave.github.io');
  assert.strictEqual(isExternalHost(), true);
  assert.strictEqual(isRunningOnDevice(), false);
  assert.strictEqual(getDefaultDeviceHost(), 'http://192.168.4.1');
  assert.strictEqual(getDefaultEspIp(), '192.168.4.1');
  assert.strictEqual(resolveDeviceBaseUrl('auto'), 'http://192.168.4.1');
});

test('getDefaultDeviceHost returns http://192.168.4.1 during local Vite development (port 3000 / 5173)', () => {
  setMockWindow('localhost', '3000');
  assert.strictEqual(isExternalHost(), true);
  assert.strictEqual(isRunningOnDevice(), false);
  assert.strictEqual(getDefaultDeviceHost(), 'http://192.168.4.1');

  setMockWindow('127.0.0.1', '5173');
  assert.strictEqual(isExternalHost(), true);
  assert.strictEqual(getDefaultDeviceHost(), 'http://192.168.4.1');
});

test('getDefaultDeviceHost detects cloud dev environments (stackblitz, googleusercontent)', () => {
  setMockWindow('preview-box.stackblitz.io');
  assert.strictEqual(isExternalHost(), true);
  assert.strictEqual(getDefaultDeviceHost(), 'http://192.168.4.1');

  setMockWindow('user-123.googleusercontent.com');
  assert.strictEqual(isExternalHost(), true);
  assert.strictEqual(getDefaultDeviceHost(), 'http://192.168.4.1');
});

test('resolveDeviceBaseUrl properly formats custom IP targets and strips trailing slashes', () => {
  setMockWindow('192.168.4.1', '', 'http://192.168.4.1');

  // Custom IP without protocol
  assert.strictEqual(resolveDeviceBaseUrl('192.168.1.150'), 'http://192.168.1.150');

  // Custom IP with protocol and trailing slash
  assert.strictEqual(resolveDeviceBaseUrl('http://192.168.1.150/'), 'http://192.168.1.150');

  // HTTPS target with trailing slashes
  assert.strictEqual(resolveDeviceBaseUrl('https://my-car.internal///'), 'https://my-car.internal');
});
