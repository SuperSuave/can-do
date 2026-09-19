/**
 * Utility functions for resolving CAN Do device endpoints and detecting hosting environment.
 */

export function isExternalHost(): boolean {
  if (typeof window === 'undefined') return true;
  const host = window.location.hostname;
  const port = window.location.port;

  return (
    host.includes('github.io') ||
    host.includes('googleusercontent.com') ||
    host.includes('aistudio') ||
    host.includes('webcontainer') ||
    host.includes('stackblitz') ||
    port === '3000'
  );
}

export function isRunningOnDevice(): boolean {
  return !isExternalHost();
}

/**
 * Returns the default device host string:
 * - If running on device: 'auto' (resolves to window.location.origin)
 * - If hosted externally (GitHub, AI Studio, local dev): 'http://192.168.4.1'
 */
export function getDefaultDeviceHost(): string {
  return isRunningOnDevice() ? 'auto' : 'http://192.168.4.1';
}

/**
 * Returns the default IP/host string for inputs:
 * - If running on device: current window host/IP (e.g. 192.168.4.1 or current STA IP)
 * - If hosted externally: '192.168.4.1'
 */
export function getDefaultEspIp(): string {
  if (typeof window === 'undefined') return '192.168.4.1';
  return isRunningOnDevice() ? (window.location.host || window.location.hostname || '192.168.4.1') : '192.168.4.1';
}

/**
 * Resolves a host setting (which may be 'auto', an IP, or a URL) to a base URL without trailing slash.
 */
export function resolveDeviceBaseUrl(target?: string | null): string {
  if (typeof window === 'undefined') return 'http://192.168.4.1';

  const host = (target || '').trim();
  if (!host || host === 'auto' || host.toLowerCase().includes('current host')) {
    return isRunningOnDevice() ? window.location.origin : 'http://192.168.4.1';
  }

  // Disregard old stale test IP if passed
  if (host === 'http://192.168.107.50' || host === '192.168.107.50') {
    return isRunningOnDevice() ? window.location.origin : 'http://192.168.4.1';
  }

  const clean = host.replace(/\/+$/, '');
  return clean.startsWith('http://') || clean.startsWith('https://') ? clean : `http://${clean}`;
}
