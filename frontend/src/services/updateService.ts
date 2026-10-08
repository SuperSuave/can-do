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
    wican_firmware_url?: string;
    atom_firmware_url?: string;
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
  currentFrontendVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  targetDevice = 'esp32c3'
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
    let wicanFirmwareUrl: string | undefined;
    let atomFirmwareUrl: string | undefined;
    let catalogUrl: string | undefined;
    let manifestUrl: string | undefined;

    if (Array.isArray(release.assets)) {
      let bestWicanScore = -1;
      let bestAtomScore = -1;

      for (const asset of release.assets) {
        const name = (asset.name || '').toLowerCase();
        const downloadUrl = asset.browser_download_url;

        // Skip non-binary or auxiliary flash partitions (merged, storage, bootloader, partition table, littlefs)
        const isBin = name.endsWith('.bin');
        const isAuxiliary =
          name.includes('merged') ||
          name.includes('storage') ||
          name.includes('bootloader') ||
          name.includes('partition') ||
          name.includes('littlefs');

        if (isBin && !isAuxiliary) {
          if (name.includes('atom') || name.includes('bridge')) {
            // M5Stack Atom Lite Bridge application binary
            let score = 10;
            if (tag && name.includes(tag.toLowerCase())) score += 30;
            if (name.includes('can-do-atom-bridge')) score += 20;
            if (tag && name === `can-do-atom-bridge-${tag.toLowerCase()}.bin`) score += 40;
            if (name === 'can-do-atom-bridge.bin') score += 15;
            if (score > bestAtomScore) {
              bestAtomScore = score;
              atomFirmwareUrl = downloadUrl;
            }
          } else {
            // WiCAN (ESP32-C3) application binary - strictly exclude Atom / Bridge
            let score = 10;
            if (name.includes('esp32c3')) score += 30;
            if (tag && name.includes(tag.toLowerCase())) score += 30;
            if (tag && name === `can-do-esp32c3-${tag.toLowerCase()}.bin`) score += 50;
            if (name === 'can-do-esp32c3.bin') score += 20;
            if (name === 'can-do.bin') score += 15;
            if (score > bestWicanScore) {
              bestWicanScore = score;
              wicanFirmwareUrl = downloadUrl;
            }
          }
        } else if (name.includes('catalog') && name.endsWith('.json')) {
          if (!catalogUrl || (tag && name.includes(tag.toLowerCase()))) {
            catalogUrl = downloadUrl;
          }
        } else if (name.includes('frontend_manifest') && name.endsWith('.json')) {
          manifestUrl = downloadUrl;
        }
      }
    }

    // Select the firmware URL for the active device target (WiCAN vs Atom bridge)
    const isAtom = (targetDevice || '').toLowerCase().includes('atom') || (targetDevice || '').toLowerCase().includes('bridge');
    const firmwareUrl = isAtom
      ? (atomFirmwareUrl || wicanFirmwareUrl)
      : (wicanFirmwareUrl || atomFirmwareUrl);

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
        wican_firmware_url: wicanFirmwareUrl,
        atom_firmware_url: atomFirmwareUrl,
        catalog_url: catalogUrl,
        frontend_manifest_url: manifestUrl,
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
  try {
    const res = await fetch(`${deviceBaseUrl}/api/upload`, {
      method: 'POST',
      headers,
      body: data,
    });
    return res.ok;
  } catch {
    return false;
  }
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
  onProgress: UpdateProgressCallback,
  targetDevice = 'esp32c3'
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
        onProgress('frontend', 15, 'Scanning device and purging stale web assets...');

        const newFileNames = new Set(manifest.files.map((f) => f.name));
        const staleFilesToDelete = new Set<string>();

        // 1a. Attempt hardware-side purge via /api/system/control clean_stale_web
        try {
          const cleanRes = await fetch(`${deviceBaseUrl}/api/system/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'clean_stale_web',
              keep: Array.from(newFileNames),
            }),
          });
          if (cleanRes.ok) {
            const cleanJson = await cleanRes.json();
            if (cleanJson.deleted_count > 0) {
              console.log(`[UpdateService] Device purged ${cleanJson.deleted_count} stale files (${cleanJson.bytes_freed} bytes freed) via clean_stale_web`);
            }
          }
        } catch {}

        // 1b. Query device file list via /api/system/control list_files
        try {
          const listRes = await fetch(`${deviceBaseUrl}/api/system/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list_files' }),
          });
          if (listRes.ok) {
            const listJson = await listRes.json();
            if (Array.isArray(listJson.files)) {
              for (const f of listJson.files) {
                const fname = f.name || '';
                const fpath = f.path || `/spiffs/www/${fname}`;
                const isWebAsset = fpath.includes('/www/') || fname.endsWith('.gz') || fname.endsWith('.js') || fname.endsWith('.css');
                if (
                  isWebAsset &&
                  !newFileNames.has(fname) &&
                  fname !== 'catalog.json' &&
                  fname !== 'automations.json' &&
                  fname !== 'preferences.json'
                ) {
                  staleFilesToDelete.add(fpath);
                }
              }
            }
          }
        } catch {}

        // 1c. Inspect device's currently installed frontend_manifest.json
        try {
          const devManifestRes = await fetch(`${deviceBaseUrl}/frontend_manifest.json`, { cache: 'no-cache' });
          if (devManifestRes.ok) {
            const devManifest = await devManifestRes.json();
            if (Array.isArray(devManifest.files)) {
              for (const f of devManifest.files) {
                if (f.name && !newFileNames.has(f.name)) {
                  staleFilesToDelete.add(f.path || `/spiffs/www/${f.name}`);
                }
              }
            }
          }
        } catch {}

        // 1d. Inspect device's current index.html and its entry bundle to discover loaded chunks
        try {
          const currentHtmlRes = await fetch(`${deviceBaseUrl}/index.html`, { cache: 'no-cache' });
          if (currentHtmlRes.ok) {
            const htmlText = await currentHtmlRes.text();
            const matches = htmlText.match(/[A-Za-z0-9_\-]+-[a-zA-Z0-9_\-]+\.(?:js|css)/g) || [];
            for (const staleBase of matches) {
              if (!newFileNames.has(staleBase) && !newFileNames.has(`${staleBase}.gz`)) {
                staleFilesToDelete.add(`/spiffs/www/${staleBase}`);
                staleFilesToDelete.add(`/spiffs/www/${staleBase}.gz`);
              }
            }

            // Also inspect entry js bundle for code-split chunks (e.g. CDr4PWH3.js, 0UrhFJN7.js)
            const scriptMatch = htmlText.match(/src=["']\.\/([a-zA-Z0-9_\-]+\.js)["']/);
            if (scriptMatch && scriptMatch[1]) {
              try {
                const scriptRes = await fetch(`${deviceBaseUrl}/${scriptMatch[1]}`, { cache: 'no-cache' });
                if (scriptRes.ok) {
                  const scriptText = await scriptRes.text();
                  const chunkMatches = scriptText.match(/[a-zA-Z0-9_\-]{8}\.js/g) || [];
                  for (const chunk of chunkMatches) {
                    if (!newFileNames.has(chunk) && !newFileNames.has(`${chunk}.gz`)) {
                      staleFilesToDelete.add(`/spiffs/www/${chunk}`);
                      staleFilesToDelete.add(`/spiffs/www/${chunk}.gz`);
                    }
                  }
                }
              } catch {}
            }
          }
        } catch (e) {
          console.warn('Could not inspect current device HTML for stale cleanup:', e);
        }

        // 1e. Delete all detected stale files sequentially
        if (staleFilesToDelete.size > 0) {
          console.log(`[UpdateService] Purging ${staleFilesToDelete.size} detected stale files from LittleFS...`);
          for (const stalePath of staleFilesToDelete) {
            await truncateDeviceFile(deviceBaseUrl, stalePath);
          }
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
          let uploaded = await uploadToDevice(deviceBaseUrl, fileInfo.path, fileBuffer, true);
          if (!uploaded) {
            // Self-healing retry: disk space may be exhausted by lingering fragments.
            // Run emergency purge of any file not matching newFileNames, truncate this file, and retry once.
            console.warn(`[UpdateService] Failed to store ${fileInfo.name}. Performing emergency LittleFS purge and retrying...`);
            try {
              await fetch(`${deviceBaseUrl}/api/system/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'clean_stale_web', keep: Array.from(newFileNames) }),
              });
            } catch {}
            await truncateDeviceFile(deviceBaseUrl, fileInfo.path);
            uploaded = await uploadToDevice(deviceBaseUrl, fileInfo.path, fileBuffer, true);
          }

          if (!uploaded) {
            throw new Error(`Device failed to store ${fileInfo.name} to LittleFS (LittleFS partition may be out of space). Please reboot the device and retry.`);
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
    const isAtom = (targetDevice || '').toLowerCase().includes('atom') || (targetDevice || '').toLowerCase().includes('bridge');
    const selectedFwUrl = isAtom
      ? (updateData.assets.atom_firmware_url || updateData.assets.firmware_url)
      : (updateData.assets.wican_firmware_url || updateData.assets.firmware_url);

    if (componentsToUpdate.firmware && selectedFwUrl) {
      let browserStreamSuccess = false;
      onProgress('firmware', 80, 'Downloading firmware binary...');

      // Priority list of binary sources based on target:
      const fwCandidates = isAtom
        ? [
            selectedFwUrl,
            `https://${pagesHost}/can-do-atom-bridge.bin`,
            `https://raw.githubusercontent.com/${GITHUB_REPO}/main/atom-ui-bridge/.pio/build/m5stack-atom/firmware.bin`,
          ].filter(Boolean) as string[]
        : [
            selectedFwUrl,
            `https://${pagesHost}/can-do-esp32c3.bin`,
            `https://${pagesHost}/can-do.bin`,
            `https://raw.githubusercontent.com/${GITHUB_REPO}/main/firmware/can-do-esp32c3.bin`,
            `https://raw.githubusercontent.com/${GITHUB_REPO}/main/firmware/build/can-do.bin`,
          ].filter(Boolean) as string[];

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
          body: JSON.stringify({ url: selectedFwUrl }),
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
