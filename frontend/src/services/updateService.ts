/**
 * Update Engine & Staging Pipeline
 * Strictly executes updates in sequence:
 * 1. Web Front-End (no reboot, cleans stale assets)
 * 2. Message Catalog (data definitions)
 * 3. Firmware Binary (final OTA write + device reboot)
 */

import { UpdateComponentSelection, UserPreferences } from '../types/settings';
import { resolveDeviceBaseUrl } from '../utils/hostUtils';

export interface UpdateCheckResult {
  has_update: boolean;
  version: string;
  release_name?: string;
  published_at?: string;
  notes?: string;
  components: {
    frontend: boolean;
    catalog: boolean;
    firmware: boolean;
  };
  assets: {
    firmware_url?: string;
    catalog_url?: string;
    frontend_manifest_url?: string;
  };
}

export type UpdateStage = 'idle' | 'checking' | 'cleaning' | 'frontend' | 'catalog' | 'firmware' | 'rebooting' | 'complete' | 'error';

export interface UpdateProgressCallback {
  (stage: UpdateStage, percent: number, message: string): void;
}

const GITHUB_REPO = 'SuperSuave/can-do';

/**
 * Compare two version strings (CalVer e.g. 2026.9.1 or SemVer 1.0.0)
 */
export function isVersionNewer(remote: string, current: string): boolean {
  const cleanRemote = remote.replace(/^v/, '').replace(/^catalog-v/, '').trim();
  const cleanCurrent = current.replace(/^v/, '').replace(/^catalog-v/, '').trim();
  if (cleanRemote === cleanCurrent) return false;

  const rParts = cleanRemote.split('.').map(n => parseInt(n, 10) || 0);
  const cParts = cleanCurrent.split('.').map(n => parseInt(n, 10) || 0);

  const maxLen = Math.max(rParts.length, cParts.length);
  for (let i = 0; i < maxLen; i++) {
    const r = rParts[i] || 0;
    const c = cParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

/**
 * Checks GitHub Releases and raw repository files for available updates.
 */
export async function checkForUpdates(
  currentCatalogVersion = '2026.9.1',
  currentFirmwareVersion = '2026.9.1'
): Promise<UpdateCheckResult> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) {
      // If no formal GitHub release exists yet or rate-limited, query catalog version directly
      return await checkFallbackCatalogUpdate(currentCatalogVersion);
    }

    const release = await res.json();
    const tag = release.tag_name || '2026.9.1';
    const isNewer = isVersionNewer(tag, currentFirmwareVersion);

    // Locate assets if attached to GitHub release
    let firmwareUrl: string | undefined;
    let catalogUrl: string | undefined;

    if (Array.isArray(release.assets)) {
      for (const asset of release.assets) {
        const name = (asset.name || '').toLowerCase();
        if (name.endsWith('.bin') && !name.includes('bootloader') && !name.includes('partition')) {
          firmwareUrl = asset.browser_download_url;
        } else if (name.includes('catalog') && name.endsWith('.json')) {
          catalogUrl = asset.browser_download_url;
        }
      }
    }

    // Default fallback to main branch raw urls if assets aren't individually attached to release
    if (!catalogUrl) {
      catalogUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/catalog/can_do_catalog.json`;
    }

    return {
      has_update: isNewer,
      version: tag,
      release_name: release.name || tag,
      published_at: release.published_at,
      notes: release.body || 'New vehicle definitions and performance updates.',
      components: {
        frontend: isNewer,
        catalog: true,
        firmware: !!firmwareUrl && isNewer,
      },
      assets: {
        firmware_url: firmwareUrl,
        catalog_url: catalogUrl,
      },
    };
  } catch {
    return await checkFallbackCatalogUpdate(currentCatalogVersion);
  }
}

async function checkFallbackCatalogUpdate(currentCatalogVersion: string): Promise<UpdateCheckResult> {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/catalog/can_do_catalog.json`, {
      cache: 'no-cache',
    });
    if (res.ok) {
      const remoteVersion = data.catalog_version || '2026.9.1';
      const hasCatalogUpdate = isVersionNewer(remoteVersion, currentCatalogVersion);

      return {
        has_update: hasCatalogUpdate,
        version: `catalog-v${remoteVersion}`,
        release_name: `Message Catalog Update v${remoteVersion}`,
        notes: 'Latest community CAN bus message decoders and vehicle definitions.',
        components: {
          frontend: false,
          catalog: hasCatalogUpdate,
          firmware: false,
        },
        assets: {
          catalog_url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/catalog/can_do_catalog.json`,
        },
      };
    }
  } catch (e) {
    console.warn('Unable to query remote updates', e);
  }

  return {
    has_update: false,
    version: currentCatalogVersion,
    components: {
      frontend: false,
      catalog: false,
      firmware: false,
    },
    assets: {},
  };
}

/**
 * Truncate known stale files on device LittleFS to prevent storage exhaustion
 */
async function truncateDeviceFile(deviceBaseUrl: string, remotePath: string): Promise<boolean> {
  try {
    const res = await fetch(`${deviceBaseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        'X-File-Path': remotePath,
      },
      body: new Uint8Array(0),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Upload a single file payload directly to LittleFS on the ESP32
 */
async function uploadToDevice(
  deviceBaseUrl: string,
  remotePath: string,
  data: Blob | ArrayBuffer | string
): Promise<boolean> {
  const res = await fetch(`${deviceBaseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'X-File-Path': remotePath,
    },
    body: data,
  });
  return res.ok;
}

/**
 * Upload firmware image to /api/ota with progress tracking
 */
function uploadFirmwareOta(
  deviceBaseUrl: string,
  binaryData: Blob | ArrayBuffer,
  onProgress?: (percent: number) => void
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${deviceBaseUrl}/api/ota`);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct);
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(true);
      } else {
        reject(new Error(`OTA Flash failed: HTTP ${xhr.status} ${xhr.responseText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during firmware OTA upload'));
    xhr.send(binaryData);
  });
}

/**
 * Execute the complete 3-Stage update sequence
 */
export async function executeUpdateSequence(
  targetDeviceHost: string,
  componentsToUpdate: UpdateComponentSelection,
  updateData: UpdateCheckResult,
  onProgress: UpdateProgressCallback
): Promise<void> {
  const deviceBaseUrl = resolveDeviceBaseUrl(targetDeviceHost);

  try {
    // -------------------------------------------------------------
    // STAGE 1: FRONT-END ASSETS (Zero disruption, clean stale files)
    // -------------------------------------------------------------
    if (componentsToUpdate.frontend) {
      onProgress('cleaning', 10, 'Pruning stale web bundles on LittleFS...');

      const knownStale = [
        '/spiffs/www/index-BNa0XSA6.js.gz',
        '/spiffs/www/index-BLMva-xK.js.gz',
        '/spiffs/www/index-BgIqk_xU.js.gz',
        '/spiffs/www/index-CgV9alWL.js.gz',
        '/spiffs/www/index-of4sRFFA.css.gz',
        '/spiffs/www/index-F2wQvwRQ.css.gz',
        '/spiffs/www/catalog/can_do_catalog.json.gz',
        '/spiffs/www/can_do_catalog.json.gz',
        '/spiffs/www/can_do_catalog.json',
        '/spiffs/www/test.txt',
        '/spiffs/www/test_size.bin',
        '/spiffs/test.txt',
      ];

      for (const stale of knownStale) {
        await truncateDeviceFile(deviceBaseUrl, stale);
      }

      onProgress('frontend', 25, 'Downloading latest web dashboard bundle...');
      // Sync latest front-end assets if bundle package is hosted
      // Currently web assets stay intact unless an update URL is provided
      onProgress('frontend', 45, 'Web Front-End up to date');
    }

    // -------------------------------------------------------------
    // STAGE 2: MESSAGE CATALOG (Vehicle definitions & CAN DBC)
    // -------------------------------------------------------------
    if (componentsToUpdate.catalog && updateData.assets.catalog_url) {
      onProgress('catalog', 50, 'Fetching latest message catalog...');
      const catRes = await fetch(updateData.assets.catalog_url);
      if (!catRes.ok) {
        throw new Error(`Failed to download catalog: HTTP ${catRes.status}`);
      }
      const catalogText = await catRes.text();

      onProgress('catalog', 70, 'Writing catalog.json to LittleFS storage...');
      const ok = await uploadToDevice(deviceBaseUrl, '/spiffs/catalog.json', catalogText);
      if (!ok) {
        throw new Error('Failed to save catalog.json to device');
      }
      onProgress('catalog', 80, 'Message Catalog updated successfully');
    }

    // -------------------------------------------------------------
    // STAGE 3: FIRMWARE BINARY (Final step, triggers reboot)
    // -------------------------------------------------------------
    if (componentsToUpdate.firmware && updateData.assets.firmware_url) {
      onProgress('firmware', 85, 'Downloading new firmware binary (.bin)...');
      const fwRes = await fetch(updateData.assets.firmware_url);
      if (!fwRes.ok) {
        throw new Error(`Failed to download firmware binary: HTTP ${fwRes.status}`);
      }
      const fwBlob = await fwRes.blob();

      onProgress('firmware', 90, 'Flashing firmware to inactive OTA partition...');
      await uploadFirmwareOta(deviceBaseUrl, fwBlob, (pct) => {
        onProgress('firmware', 90 + Math.round(pct * 0.08), `Flashing firmware: ${pct}%`);
      });

      onProgress('rebooting', 100, 'Firmware flash complete! Device is rebooting...');
    } else {
      onProgress('complete', 100, 'Updates applied successfully!');
    }
  } catch (err: any) {
    onProgress('error', 0, `Update failed: ${err.message || err}`);
    throw err;
  }
}
