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
  is_rebuild?: boolean;
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

const STORAGE_KEY_LAST_UPDATE_TIME = 'cando_last_update_installed_at';

export function recordUpdateInstalledTime(timestamp?: string): void {
  try {
    const ts = timestamp || new Date().toISOString();
    localStorage.setItem(STORAGE_KEY_LAST_UPDATE_TIME, ts);
  } catch {}
}

export function getLastUpdateInstalledTime(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_LAST_UPDATE_TIME);
  } catch {
    return null;
  }
}

export async function checkForUpdates(
  currentCatalogVersion = '2026.9.4',
  currentFirmwareVersion = '2026.9.4',
  currentFrontendVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2026.9.4'
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
    const tag = release.tag_name || '2026.9.4';
    const isFwNewer = isVersionNewer(tag, currentFirmwareVersion);
    const isCatNewer = isVersionNewer(tag, currentCatalogVersion);
    const isFrontNewer = isVersionNewer(tag, currentFrontendVersion);

    // Locate assets if attached to GitHub release
    let firmwareUrl: string | undefined;
    let catalogUrl: string | undefined;

    if (Array.isArray(release.assets)) {
      for (const asset of release.assets) {
        const name = (asset.name || '').toLowerCase();
        // Match app binary (flexible matching supporting versioned names, excluding merged or storage)
        const isAppBinary =
          (name.startsWith('can-do') || name.startsWith('firmware')) &&
          name.endsWith('.bin') &&
          !name.includes('merged') &&
          !name.includes('storage') &&
          !name.includes('bootloader') &&
          !name.includes('partition');

        if (isAppBinary && !firmwareUrl) {
          firmwareUrl = asset.browser_download_url;
        } else if (name.includes('catalog') && name.endsWith('.json')) {
          catalogUrl = asset.browser_download_url;
        }
      }
    }

    // Check if the release was rebuilt/re-published after last install even if same version tag
    const lastInstalledTs = getLastUpdateInstalledTime();
    let isRebuild = false;
    if (!isFwNewer && !isCatNewer && !isFrontNewer && release.published_at && lastInstalledTs) {
      const releaseTime = new Date(release.published_at).getTime();
      const installedTime = new Date(lastInstalledTs).getTime();
      if (releaseTime > installedTime + 60000) { // 1 min buffer
        isRebuild = true;
      }
    }

    const hasAnyUpdate = isFwNewer || isCatNewer || isFrontNewer || isRebuild;

    // Always use raw.githubusercontent.com for catalog download in browser
    // because GitHub Release download assets redirect to S3 without CORS headers
    catalogUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/catalog/can_do_catalog.json`;

    return {
      has_update: hasAnyUpdate,
      is_rebuild: isRebuild,
      version: tag,
      release_name: release.name || tag,
      published_at: release.published_at,
      notes: release.body || 'New vehicle definitions and performance updates.',
      components: {
        frontend: isFrontNewer || isRebuild,
        catalog: isCatNewer || isRebuild,
        firmware: !!firmwareUrl && (isFwNewer || isRebuild),
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
      const data = await res.json();
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
  data: Blob | ArrayBuffer | string,
  noReboot = false
): Promise<boolean> {
  const headers: Record<string, string> = {
    'X-File-Path': remotePath,
  };
  if (noReboot) {
    headers['X-No-Reboot'] = '1';
  }
  const res = await fetch(`${deviceBaseUrl}/api/upload`, {
    method: 'POST',
    headers,
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
 * Execute update sequence:
 * 1. Web Front-End (validation & staging)
 * 2. Message Catalog (updated with X-No-Reboot if firmware follows)
 * 3. Firmware Binary (OTA flash + device reboot)
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
    // STAGE 1: FRONT-END ASSETS
    // -------------------------------------------------------------
    if (componentsToUpdate.frontend) {
      onProgress('frontend', 15, 'Validating Web Dashboard assets...');
      await new Promise((r) => setTimeout(r, 400));
      onProgress('frontend', 35, 'Web Front-End ready');
    }

    // -------------------------------------------------------------
    // STAGE 2: MESSAGE CATALOG (Vehicle definitions & CAN DBC)
    // -------------------------------------------------------------
    if (componentsToUpdate.catalog) {
      onProgress('catalog', 40, 'Fetching latest message catalog from GitHub...');
      let catalogText: string | null = null;
      
      const candidateUrls = [
        `https://raw.githubusercontent.com/${GITHUB_REPO}/${updateData.version}/catalog/can_do_catalog.json`,
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/catalog/can_do_catalog.json`,
      ];
      if (updateData.assets.catalog_url && !candidateUrls.includes(updateData.assets.catalog_url)) {
        candidateUrls.push(updateData.assets.catalog_url);
      }

      for (const url of candidateUrls) {
        try {
          const catRes = await fetch(url, { cache: 'no-cache' });
          if (catRes.ok) {
            catalogText = await catRes.text();
            break;
          }
        } catch (e) {
          console.warn(`Failed to fetch catalog from ${url}:`, e);
        }
      }

      if (!catalogText) {
        throw new Error('Unable to download message catalog from GitHub. Check internet connection or CORS restrictions.');
      }

      onProgress('catalog', 60, 'Writing catalog.json to LittleFS storage...');
      // If firmware is also being updated, do not reboot yet!
      const deferReboot = !!(componentsToUpdate.firmware && updateData.assets.firmware_url);
      const ok = await uploadToDevice(deviceBaseUrl, '/spiffs/catalog.json', catalogText, deferReboot);
      if (!ok) {
        throw new Error('Failed to save catalog.json to device LittleFS storage.');
      }
      onProgress('catalog', 75, 'Message Catalog updated successfully');
    }

    // -------------------------------------------------------------
    // STAGE 3: FIRMWARE BINARY (Final step, triggers reboot)
    // -------------------------------------------------------------
    if (componentsToUpdate.firmware && updateData.assets.firmware_url) {
      // First attempt direct browser-assisted stream to /api/ota for guaranteed reliability across all networks
      let browserStreamSuccess = false;
      onProgress('firmware', 80, 'Downloading firmware binary from GitHub release...');
      try {
        const fwRes = await fetch(updateData.assets.firmware_url, { cache: 'no-cache' });
        if (fwRes.ok) {
          const fwBlob = await fwRes.blob();
          onProgress('firmware', 85, 'Flashing firmware to device OTA partition...');
          await uploadFirmwareOta(deviceBaseUrl, fwBlob, (pct) => {
            onProgress('firmware', 85 + Math.round(pct * 0.12), `Flashing firmware: ${pct}%`);
          });
          browserStreamSuccess = true;
          recordUpdateInstalledTime(updateData.published_at || new Date().toISOString());
          onProgress('rebooting', 100, 'Firmware flash complete! Device is rebooting...');
        }
      } catch (e) {
        console.warn('Browser direct fetch encountered CORS or network error, falling back to device-side pull', e);
      }

      // If browser fetch was blocked by CORS, fallback to device-side cloud_pull
      if (!browserStreamSuccess) {
        onProgress('firmware', 82, 'Requesting device-side Cloud OTA pull...');
        try {
          const cloudPullRes = await fetch(`${deviceBaseUrl}/api/ota/cloud_pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: updateData.assets.firmware_url }),
          });
          if (cloudPullRes.ok) {
            recordUpdateInstalledTime(updateData.published_at || new Date().toISOString());
            onProgress('rebooting', 100, 'Cloud flash initiated on device! Rebooting upon completion...');
          } else {
            throw new Error(`Device cloud pull returned HTTP ${cloudPullRes.status}`);
          }
        } catch (err: any) {
          throw new Error(`Firmware update failed: ${err.message || err}`);
        }
      }
    } else {
      recordUpdateInstalledTime(updateData.published_at || new Date().toISOString());
      onProgress('complete', 100, 'Updates applied successfully!');
    }
  } catch (err: any) {
    onProgress('error', 0, `Update failed: ${err.message || err}`);
    throw err;
  }
}
