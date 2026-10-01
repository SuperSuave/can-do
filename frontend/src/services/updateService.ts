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
 * Compare two version strings (CalVer e.g. 2026.9.1 or SemVer 1.0.0 or CalVer with build tags e.g. 2026.10.1-b001)
 */
export function isVersionNewer(remote: string, current: string): boolean {
  const cleanRemote = remote.replace(/^v/, '').replace(/^catalog-v/, '').trim();
  const cleanCurrent = current.replace(/^v/, '').replace(/^catalog-v/, '').trim();
  if (!cleanRemote || !cleanCurrent || cleanRemote === cleanCurrent) return false;

  const rTokens = cleanRemote.split(/[-.+]/);
  const cTokens = cleanCurrent.split(/[-.+]/);
  const maxLen = Math.max(rTokens.length, cTokens.length);

  for (let i = 0; i < maxLen; i++) {
    const rTok = rTokens[i] || '';
    const cTok = cTokens[i] || '';
    const rNum = parseInt(rTok, 10);
    const cNum = parseInt(cTok, 10);

    const rIsNum = !isNaN(rNum) && String(rNum) === rTok;
    const cIsNum = !isNaN(cNum) && String(cNum) === cTok;

    if (rIsNum && cIsNum) {
      if (rNum > cNum) return true;
      if (rNum < cNum) return false;
    } else {
      const cmp = rTok.localeCompare(cTok, undefined, { numeric: true });
      if (cmp > 0) return true;
      if (cmp < 0) return false;
    }
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
  currentCatalogVersion = '',
  currentFirmwareVersion = '',
  currentFrontendVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
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
    const tag = release.tag_name || '';
    const isFwNewer = Boolean(tag && (!currentFirmwareVersion || currentFirmwareVersion === 'unknown' || isVersionNewer(tag, currentFirmwareVersion)));
    const isCatNewer = Boolean(tag && (!currentCatalogVersion || currentCatalogVersion === 'unknown' || isVersionNewer(tag, currentCatalogVersion)));
    const isFrontNewer = Boolean(tag && (!currentFrontendVersion || currentFrontendVersion === 'unknown' || isVersionNewer(tag, currentFrontendVersion)));

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

    // Use raw main by default for the catalog as it reliably has the latest release sync
    catalogUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/catalog/can_do_catalog.json`;

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
      const remoteVersion = data.can_do_version || '';
      const hasCatalogUpdate = Boolean(remoteVersion && currentCatalogVersion && isVersionNewer(remoteVersion, currentCatalogVersion));

      return {
        has_update: hasCatalogUpdate,
        version: `v${remoteVersion}`,
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
export function uploadFirmwareOta(
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
  const pagesHost = `${GITHUB_REPO.split('/')[0].toLowerCase()}.github.io/${GITHUB_REPO.split('/')[1]}`;

  try {
    // -------------------------------------------------------------
    // STAGE 1: FRONT-END ASSETS (Real LittleFS OTA)
    // -------------------------------------------------------------
    if (componentsToUpdate.frontend) {
      onProgress('frontend', 10, 'Fetching frontend release manifest...');

      // Manifest sources in priority order:
      // 1. GitHub Pages build (CORS-enabled static CDN)
      // 2. Main branch raw repository (synced by CI)
      // 3. Specific release tag raw repository
      const manifestCandidates = [
        `https://${pagesHost}/frontend_manifest.json`,
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/firmware/data/www/frontend_manifest.json`,
        `https://raw.githubusercontent.com/${GITHUB_REPO}/${updateData.version}/firmware/data/www/frontend_manifest.json`,
      ];

      let manifest: { version?: string; files: { name: string; path: string; size: number }[] } | null = null;
      let manifestBaseUrl = '';

      for (const mUrl of manifestCandidates) {
        try {
          const mRes = await fetch(mUrl, { cache: 'no-cache' });
          if (mRes.ok) {
            const candidateManifest = await mRes.json();
            if (candidateManifest && Array.isArray(candidateManifest.files) && candidateManifest.files.length > 0) {
              const cleanVer = (candidateManifest.version || '').replace(/^v/, '');
              const cleanTarget = (updateData.version || '').replace(/^v/, '');
              // If candidate matches target version, select immediately!
              if (cleanVer === cleanTarget) {
                manifest = candidateManifest;
                manifestBaseUrl = mUrl.substring(0, mUrl.lastIndexOf('/'));
                break;
              }
              // Otherwise keep the newest candidate manifest found
              if (!manifest || isVersionNewer(candidateManifest.version || '', manifest.version || '')) {
                manifest = candidateManifest;
                manifestBaseUrl = mUrl.substring(0, mUrl.lastIndexOf('/'));
              }
            }
          }
        } catch {}
      }

      if (manifest && Array.isArray(manifest.files) && manifest.files.length > 0) {
        // 1. Detect current hashed assets on device to clean up stale files
        onProgress('frontend', 15, 'Scanning device for stale web assets...');
        try {
          const currentHtmlRes = await fetch(`${deviceBaseUrl}/index.html`, { cache: 'no-cache' });
          if (currentHtmlRes.ok) {
            const htmlText = await currentHtmlRes.text();
            const matches = htmlText.match(/index-[a-zA-Z0-9_\-]+\.(?:js|css)/g) || [];
            const newFileNames = new Set(manifest.files.map((f) => f.name));
            for (const staleBase of matches) {
              const staleGz = `${staleBase}.gz`;
              if (!newFileNames.has(staleGz) && !newFileNames.has(staleBase)) {
                await truncateDeviceFile(deviceBaseUrl, `/spiffs/www/${staleGz}`);
                await truncateDeviceFile(deviceBaseUrl, `/spiffs/www/${staleBase}`);
              }
            }
          }
        } catch (e) {
          console.warn('Could not inspect current device HTML for stale cleanup:', e);
        }

        // 2. Upload new web assets sequentially with fallback download URLs
        const totalFiles = manifest.files.length;
        for (let i = 0; i < totalFiles; i++) {
          const fileInfo = manifest.files[i];
          const pct = 15 + Math.round(((i + 1) / totalFiles) * 20);
          onProgress('frontend', pct, `Updating ${fileInfo.name} (${i + 1}/${totalFiles})...`);

          const downloadCandidates = [
            `${manifestBaseUrl}/${fileInfo.name}`,
            `https://${pagesHost}/${fileInfo.name}`,
            `https://raw.githubusercontent.com/${GITHUB_REPO}/main/firmware/data/www/${fileInfo.name}`,
            `https://raw.githubusercontent.com/${GITHUB_REPO}/${updateData.version}/firmware/data/www/${fileInfo.name}`,
          ];

          let fileBuffer: ArrayBuffer | null = null;
          for (const dUrl of downloadCandidates) {
            try {
              const fileRes = await fetch(dUrl, { cache: 'no-cache' });
              if (fileRes.ok) {
                const buf = await fileRes.arrayBuffer();
                if (buf.byteLength > 0) {
                  fileBuffer = buf;
                  break;
                }
              }
            } catch {}
          }

          if (!fileBuffer || fileBuffer.byteLength === 0) {
            throw new Error(`Failed to download ${fileInfo.name} from any release repository`);
          }

          // Always skip reboot for web assets!
          const uploaded = await uploadToDevice(deviceBaseUrl, fileInfo.path, fileBuffer, true);
          if (!uploaded) {
            throw new Error(`Device failed to store ${fileInfo.name} to LittleFS`);
          }
        }
        onProgress('frontend', 35, 'Web Front-End successfully updated on LittleFS');
      } else {
        onProgress('frontend', 35, 'Frontend manifest not found, skipping LittleFS web sync');
      }
    }

    // -------------------------------------------------------------
    // STAGE 2: MESSAGE CATALOG (Vehicle definitions & CAN DBC)
    // -------------------------------------------------------------
    if (componentsToUpdate.catalog) {
      onProgress('catalog', 40, 'Fetching latest message catalog from GitHub...');
      let catalogText: string | null = null;

      // Candidate catalog sources prioritized by freshness and CORS compatibility
      const candidateUrls = [
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/catalog/can_do_catalog.json`,
        `https://${pagesHost}/catalog/can_do_catalog.json`,
        `https://${pagesHost}/can_do_catalog.json`,
        `https://raw.githubusercontent.com/${GITHUB_REPO}/${updateData.version}/catalog/can_do_catalog.json`,
      ];
      if (updateData.assets.catalog_url && !candidateUrls.includes(updateData.assets.catalog_url)) {
        candidateUrls.push(updateData.assets.catalog_url);
      }

      for (const url of candidateUrls) {
        try {
          const catRes = await fetch(url, { cache: 'no-cache' });
          if (catRes.ok) {
            const text = await catRes.text();
            try {
              const parsed = JSON.parse(text);
              const ver = (parsed.can_do_version || parsed.catalog_version || '').replace(/^v/, '');
              const targetVer = (updateData.version || '').replace(/^v/, '');
              // If catalog matches target version, select it immediately!
              if (ver === targetVer) {
                catalogText = text;
                break;
              }
              if (!catalogText) {
                catalogText = text;
              }
            } catch {
              if (!catalogText) catalogText = text;
            }
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
      let browserStreamSuccess = false;
      onProgress('firmware', 80, 'Downloading firmware binary...');

      // Priority list of binary sources:
      // 1. GitHub Pages static binary (CORS-enabled, fast, CDN)
      // 2. Raw GitHub on main branch
      // 3. GitHub release download asset
      const fwCandidates = [
        `https://${pagesHost}/can-do-esp32c3.bin`,
        `https://${pagesHost}/can-do.bin`,
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/firmware/can-do-esp32c3.bin`,
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/firmware/build/can-do.bin`,
        updateData.assets.firmware_url,
      ];

      for (const fwUrl of fwCandidates) {
        try {
          const fwRes = await fetch(fwUrl, { cache: 'no-cache' });
          if (fwRes.ok) {
            const fwBuf = await fwRes.arrayBuffer();
            // Validate: ESP32 application binary magic byte is 0xE9, size > 100KB
            if (fwBuf.byteLength > 100000) {
              const u8 = new Uint8Array(fwBuf);
              if (u8[0] === 0xE9) {
                onProgress('firmware', 85, 'Flashing firmware to device OTA partition...');
                await uploadFirmwareOta(deviceBaseUrl, fwBuf, (pct) => {
                  onProgress('firmware', 85 + Math.round(pct * 0.12), `Flashing firmware: ${pct}%`);
                });
                browserStreamSuccess = true;
                recordUpdateInstalledTime(updateData.published_at || new Date().toISOString());
                onProgress('rebooting', 100, 'Firmware flash complete! Device is rebooting...');
                break;
              }
            }
          }
        } catch (e) {
          // Expected for URLs with CORS restrictions or not yet deployed
        }
      }

      // If browser direct download was blocked by CORS or network, fall back to device-side Cloud OTA pull
      if (!browserStreamSuccess) {
        onProgress('firmware', 82, 'Requesting device-side Cloud OTA pull...');
        const cloudPullRes = await fetch(`${deviceBaseUrl}/api/ota/cloud_pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: updateData.assets.firmware_url }),
        });

        if (!cloudPullRes.ok) {
          throw new Error(`Device cloud pull returned HTTP ${cloudPullRes.status}`);
        }

        // Actively poll /api/ota/status on the device to verify progress and real completion
        onProgress('firmware', 84, 'Device connecting to GitHub Cloud Release...');
        let pollCount = 0;
        let lastReportedPct = 0;
        let completed = false;

        while (pollCount < 60) {
          await new Promise((r) => setTimeout(r, 1000));
          pollCount++;

          try {
            const stRes = await fetch(`${deviceBaseUrl}/api/ota/status`, { cache: 'no-cache' });
            if (stRes.ok) {
              const st = await stRes.json();
              if (st.error && st.error.length > 0) {
                throw new Error(`Device Cloud OTA failed: ${st.error}`);
              }
              if (st.progress !== undefined && st.progress > lastReportedPct) {
                lastReportedPct = st.progress;
                onProgress('firmware', 84 + Math.round(lastReportedPct * 0.14), `Device flashing: ${lastReportedPct}%`);
              }
              if (st.success) {
                completed = true;
                break;
              }
            }
          } catch (pollErr: any) {
            // If the device reboots at the end of flash, network requests will fail — this signals success!
            if (lastReportedPct >= 80) {
              completed = true;
              break;
            }
            if (pollErr.message && pollErr.message.includes('Device Cloud OTA failed')) {
              throw pollErr;
            }
          }
        }

        if (!completed && lastReportedPct < 80) {
          throw new Error(
            'Device could not download firmware binary from GitHub (ESP32 is offline or GitHub redirected without CORS). Please use the "Download .bin" link and manually flash via the file selector below.'
          );
        }

        recordUpdateInstalledTime(updateData.published_at || new Date().toISOString());
        onProgress('rebooting', 100, 'Cloud flash complete! Device is rebooting...');
      }
    } else {
      // If we updated web assets or catalog without flashing firmware, reboot the device once at the end
      if (componentsToUpdate.frontend || componentsToUpdate.catalog) {
        onProgress('rebooting', 95, 'Restarting device to apply new assets...');
        try {
          await fetch(`${deviceBaseUrl}/api/system/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reboot: true }),
          });
        } catch {}
      }
      recordUpdateInstalledTime(updateData.published_at || new Date().toISOString());
      onProgress('complete', 100, 'Updates applied successfully!');
    }
  } catch (err: any) {
    onProgress('error', 0, `Update failed: ${err.message || err}`);
    throw err;
  }
}
