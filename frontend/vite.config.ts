import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  let pkgVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
    pkgVersion = pkg.version || '';
  } catch {}
  const appVersion = process.env.VITE_APP_VERSION || pkgVersion || 'unknown';

  return {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __CAN_DO_VERSION__: JSON.stringify(appVersion),
    },

    // 1. Relative base path so it resolves cleanly when served directly by ESP32 IP or mDNS and GitHub Pages
    base: './',

    // 2. Output to standard frontend/dist for GitHub Pages
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          entryFileNames: '[name]-[hash:6].js',
          chunkFileNames: '[hash:8].js',
          assetFileNames: '[name]-[hash:6].[ext]',
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('lucide-react')) {
                return 'vendor-icons';
              }
              if (
                id.includes('node_modules/react/') ||
                id.includes('node_modules/react-dom/') ||
                id.includes('node_modules/scheduler/') ||
                id.includes('@react-aria') ||
                id.includes('@react-stately') ||
                id.includes('@internationalized')
              ) {
                return 'vendor-react';
              }
              return 'vendor-heroui';
            }
            if (
              id.includes('/components/OnboardingWizardModal') ||
              id.includes('/components/CatalogHealthModal') ||
              id.includes('/components/CategoryManagerModal') ||
              id.includes('/components/ExportModal') ||
              id.includes('/components/ImportModal') ||
              id.includes('/components/ContributeModal')
            ) {
              return 'app-modals';
            }
          },
        },
      },
    },

    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'serve-root-catalog',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const cleanUrl = (req.url || '').split('?')[0];
            const method = req.method || 'GET';

            if (
              cleanUrl === '/catalog' ||
              cleanUrl === '/catalog/' ||
              cleanUrl === '/catalog/can_do_catalog.json' ||
              cleanUrl === '/can-do/catalog' ||
              cleanUrl === '/can-do/catalog/can_do_catalog.json' ||
              cleanUrl === '/CAN-Do-Message-Catalog/catalog' ||
              cleanUrl === '/CAN-Do-Message-Catalog/catalog/can_do_catalog.json' ||
              cleanUrl === '/catalog.json' ||
              cleanUrl === '/api/catalog'
            ) {
              const catalogFile = path.resolve(__dirname, '../catalog/can_do_catalog.json');
              if (fs.existsSync(catalogFile)) {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Cache-Control', 'no-cache');
                return res.end(fs.readFileSync(catalogFile, 'utf-8'));
              }
            }

            // Local development support for /api/preferences
            if (cleanUrl === '/api/preferences') {
              const prefFile = path.resolve(__dirname, '../firmware/data/preferences.json');
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');

              if (method === 'GET') {
                if (fs.existsSync(prefFile)) {
                  return res.end(fs.readFileSync(prefFile, 'utf-8'));
                }
                return res.end(JSON.stringify({ onboarding_completed: false }));
              }

              if (method === 'POST') {
                let body = '';
                req.on('data', chunk => {
                  body += chunk;
                });
                req.on('end', () => {
                  try {
                    const parsed = JSON.parse(body || '{}');
                    const dir = path.dirname(prefFile);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(prefFile, JSON.stringify(parsed, null, 2), 'utf-8');
                    res.statusCode = 200;
                    return res.end(JSON.stringify({ status: 'ok' }));
                  } catch (err: any) {
                    res.statusCode = 400;
                    return res.end(JSON.stringify({ error: err.message || 'Invalid JSON' }));
                  }
                });
                return;
              }
            }

            // Local development support for /api/automations (GET/POST)
            if (cleanUrl === '/api/automations') {
              const autoDataFile = path.resolve(__dirname, '../firmware/data/automations.json');
              const autoRepoFile = path.resolve(__dirname, '../firmware/automations.json');
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');

              if (method === 'GET') {
                const sourceFile = fs.existsSync(autoDataFile)
                  ? autoDataFile
                  : fs.existsSync(autoRepoFile)
                    ? autoRepoFile
                    : null;
                if (sourceFile) {
                  return res.end(fs.readFileSync(sourceFile, 'utf-8'));
                }
                return res.end(JSON.stringify({
                  settings: {
                    vehicle_model: 'all_egmp',
                    unit_system: 'imperial',
                    can_do_version: appVersion
                  },
                  rules: []
                }));
              }

              if (method === 'POST') {
                let body = '';
                req.on('data', chunk => {
                  body += chunk;
                });
                req.on('end', () => {
                  try {
                    const parsed = JSON.parse(body || '{}');
                    const dir = path.dirname(autoDataFile);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(autoDataFile, JSON.stringify(parsed), 'utf-8');
                    res.statusCode = 200;
                    return res.end(JSON.stringify({
                      status: 'ok',
                      message: 'Automations saved and hot-reloaded (dev mock).'
                    }));
                  } catch (err: any) {
                    res.statusCode = 400;
                    return res.end(JSON.stringify({ error: err.message || 'Invalid JSON' }));
                  }
                });
                return;
              }
            }

            // Local development mock for /api/automations/test
            if (cleanUrl === '/api/automations/test') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              let body = '';
              req.on('data', chunk => {
                body += chunk;
              });
              req.on('end', () => {
                try {
                  const parsed = JSON.parse(body || '{}');
                  const mode = parsed?.mode || 'dry_run';
                  res.statusCode = 200;
                  if (mode === 'dry_run') {
                    return res.end(JSON.stringify({
                      status: 'ok',
                      passed: true,
                      message: 'All conditions passed (dev mock)'
                    }));
                  }
                  return res.end(JSON.stringify({
                    status: 'ok',
                    message: 'Live fire actions queued'
                  }));
                } catch (err: any) {
                  res.statusCode = 400;
                  return res.end(JSON.stringify({ error: err.message || 'Invalid JSON' }));
                }
              });
              return;
            }

            // Local development mock for /api/wifi/status
            if (cleanUrl === '/api/wifi/status') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.statusCode = 200;
              return res.end(JSON.stringify({
                sta_connected: true,
                sta_ssid: 'DevWiFi',
                sta_ip: '127.0.0.1',
                sta_gw: '127.0.0.1',
                sta_mask: '255.255.255.0',
                sta_rssi: -55,
                ap_active: false,
                ap_ssid: 'CAN-Do-Setup',
                ap_ip: '192.168.4.1',
                ap_clients: 0,
                ap_mode: 'auto'
              }));
            }

            // Local development mock for /api/command
            if (cleanUrl === '/api/command') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.statusCode = 200;
              return res.end(JSON.stringify({ status: 'queued' }));
            }

            // Local development mock for /api/nav
            if (cleanUrl === '/api/nav') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              let body = '';
              req.on('data', chunk => {
                body += chunk;
              });
              req.on('end', () => {
                try {
                  const parsed = JSON.parse(body || '{}');
                  const isClear = parsed?.action === 'clear';
                  res.statusCode = 200;
                  return res.end(JSON.stringify({
                    status: 'ok',
                    message: isClear ? 'HUD navigation cleared' : 'HUD navigation updated'
                  }));
                } catch (err: any) {
                  res.statusCode = 400;
                  return res.end(JSON.stringify({ error: err.message || 'Invalid JSON' }));
                }
              });
              return;
            }

            // Local development mock for /api/states
            if (cleanUrl === '/api/states') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.statusCode = 200;
              return res.end(JSON.stringify([]));
            }

            // Local development mock for /api/ble/status
            if (cleanUrl === '/api/ble/status') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.statusCode = 200;
              return res.end(JSON.stringify({
                enabled: true,
                scanning: false,
                connected_device: null,
                paired_devices: [],
                discovered_devices: [],
                last_event: null,
                recent_events: [],
                beacon_targets: [],
                discovered_beacons: []
              }));
            }

            // Local development mock for /api/notify
            if (cleanUrl === '/api/notify') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.statusCode = 200;
              return res.end(JSON.stringify({ status: 'ok' }));
            }

            next();
          });
        },
        generateBundle() {
          const catalogFile = path.resolve(__dirname, '../catalog/can_do_catalog.json');
          if (fs.existsSync(catalogFile)) {
            // Emit within dist bundle for GitHub Pages
            this.emitFile({
              type: 'asset',
              fileName: 'catalog/can_do_catalog.json',
              source: fs.readFileSync(catalogFile, 'utf-8'),
            });
            this.emitFile({
              type: 'asset',
              fileName: 'can_do_catalog.json',
              source: fs.readFileSync(catalogFile, 'utf-8'),
            });
          }
        },
        closeBundle() {
          const distDir = path.resolve(__dirname, 'dist');
          const dataDir = path.resolve(__dirname, '../firmware/data');
          const wwwDir = path.join(dataDir, 'www');

          // Stage in firmware/data/catalog.json (LittleFS root) - MINIFIED to fit 960KB LittleFS partition
          const catalogFile = path.resolve(__dirname, '../catalog/can_do_catalog.json');
          if (fs.existsSync(catalogFile)) {
            try {
              if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
              }
              const parsedCatalog = JSON.parse(fs.readFileSync(catalogFile, 'utf-8'));
              fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify(parsedCatalog), 'utf-8');
            } catch (e) {
              console.warn('[vite closeBundle] Warning copying catalog.json:', e);
            }
          }

          // Also copy automations.json if present in firmware (minified)
          const repoAuto = path.resolve(__dirname, '../firmware/automations.json');
          if (fs.existsSync(repoAuto)) {
            try {
              const parsedAuto = JSON.parse(fs.readFileSync(repoAuto, 'utf-8'));
              fs.writeFileSync(path.join(dataDir, 'automations.json'), JSON.stringify(parsedAuto), 'utf-8');
            } catch (e) {
              console.warn('[vite closeBundle] Warning copying automations.json:', e);
            }
          }

          // Ensure default preferences.json exists for LittleFS filesystem
          const prefFile = path.join(dataDir, 'preferences.json');
          if (!fs.existsSync(prefFile)) {
            try {
              fs.writeFileSync(prefFile, JSON.stringify({ onboarding_completed: false }, null, 2), 'utf-8');
            } catch (e) {
              console.warn('[vite closeBundle] Warning writing preferences.json:', e);
            }
          }

          if (!fs.existsSync(distDir)) return;

          // 1. Generate pre-gzipped (.gz) copies of text assets in dist
          const gzipExtensions = ['.html', '.js', '.css', '.json'];
          const gzipFilesRecursively = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                gzipFilesRecursively(fullPath);
              } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (gzipExtensions.includes(ext) && !entry.name.endsWith('.gz')) {
                  const content = fs.readFileSync(fullPath);
                  const compressed = zlib.gzipSync(content, { level: 9 });
                  fs.writeFileSync(`${fullPath}.gz`, compressed);
                }
              }
            }
          };
          gzipFilesRecursively(distDir);

          // 2. Prepare firmware/data/www
          if (!fs.existsSync(wwwDir)) {
            fs.mkdirSync(wwwDir, { recursive: true });
          } else {
            for (const file of fs.readdirSync(wwwDir)) {
              fs.rmSync(path.join(wwwDir, file), { recursive: true, force: true });
            }
          }

          // 3. Populate firmware/data/www with compact assets for LittleFS
          const copyCompactToWww = (srcDir: string, destDir: string) => {
            const entries = fs.readdirSync(srcDir, { withFileTypes: true });
            for (const entry of entries) {
              const srcPath = path.join(srcDir, entry.name);
              const destPath = path.join(destDir, entry.name);

              if (entry.isDirectory()) {
                // Skip copying the large catalog/ folder into www since it's already at /spiffs/catalog.json
                if (entry.name === 'catalog') continue;
                if (!fs.existsSync(destPath)) {
                  fs.mkdirSync(destPath, { recursive: true });
                }
                copyCompactToWww(srcPath, destPath);
              } else if (entry.isFile()) {
                // Skip duplicating can_do_catalog, .nojekyll, 404 fallback, or manifest.gz in www
                if (
                  entry.name.startsWith('can_do_catalog') ||
                  entry.name === '.nojekyll' ||
                  entry.name.startsWith('404') ||
                  entry.name === 'frontend_manifest.json.gz'
                ) continue;

                // Copy all .gz files for compressed assets
                if (entry.name.endsWith('.gz')) {
                  fs.copyFileSync(srcPath, destPath);
                } else {
                  // For assets without .gz (e.g. svg, nojekyll), or small files like index.html, copy raw
                  const hasGz = fs.existsSync(srcPath + '.gz');
                  if (!hasGz || entry.name === 'index.html') {
                    fs.copyFileSync(srcPath, destPath);
                  }
                }
              }
            }
          };

          copyCompactToWww(distDir, wwwDir);

          // Generate frontend_manifest.json so the browser can discover all LittleFS assets to update
          const manifestFiles: { name: string; path: string; size: number }[] = [];
          for (const fname of fs.readdirSync(wwwDir)) {
            if (fname.startsWith('.')) continue;
            const fpath = path.join(wwwDir, fname);
            const stats = fs.statSync(fpath);
            if (stats.isFile()) {
              manifestFiles.push({
                name: fname,
                path: `/spiffs/www/${fname}`,
                size: stats.size,
              });
            }
          }
          const manifestJson = JSON.stringify({
            version: appVersion,
            files: manifestFiles,
          }, null, 2);
          fs.writeFileSync(path.join(wwwDir, 'frontend_manifest.json'), manifestJson, 'utf-8');
          fs.writeFileSync(path.join(distDir, 'frontend_manifest.json'), manifestJson, 'utf-8');

          // Generate 404.html for GitHub Pages SPA routing fallback
          const indexPath = path.join(distDir, 'index.html');
          if (fs.existsSync(indexPath)) {
            fs.copyFileSync(indexPath, path.join(distDir, '404.html'));
          }
        },
      },
    ],
    resolve: {
      dedupe: ['react', 'react-dom', 'react-dom/client'],
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'lucide-react',
        'mqtt'
      ],
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      allowedHosts: true,
      fs: {
        allow: [path.resolve(__dirname, '..')],
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
