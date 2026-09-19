import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    // 1. Relative base path so it resolves cleanly when served directly by ESP32 IP or mDNS and GitHub Pages
    base: './',

    // 2. Output to standard frontend/dist for GitHub Pages
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          entryFileNames: '[name]-[hash].js',
          chunkFileNames: '[name]-[hash].js',
          assetFileNames: '[name]-[hash].[ext]',
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
            if (
              cleanUrl === '/catalog' ||
              cleanUrl === '/catalog/' ||
              cleanUrl === '/catalog/can_do_catalog.json' ||
              cleanUrl === '/can-do/catalog' ||
              cleanUrl === '/can-do/catalog/can_do_catalog.json' ||
              cleanUrl === '/CAN-Do-Message-Catalog/catalog' ||
              cleanUrl === '/CAN-Do-Message-Catalog/catalog/can_do_catalog.json' ||
              cleanUrl === '/catalog.json'
            ) {
              const catalogFile = path.resolve(__dirname, '../catalog/can_do_catalog.json');
              if (fs.existsSync(catalogFile)) {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Cache-Control', 'no-cache');
                return res.end(fs.readFileSync(catalogFile, 'utf-8'));
              }
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

          // Stage in firmware/data/catalog.json (LittleFS root)
          const catalogFile = path.resolve(__dirname, '../catalog/can_do_catalog.json');
          if (fs.existsSync(catalogFile)) {
            if (!fs.existsSync(dataDir)) {
              fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.copyFileSync(catalogFile, path.join(dataDir, 'catalog.json'));
          }

          // Also copy automations.json if present in firmware
          const repoAuto = path.resolve(__dirname, '../firmware/automations.json');
          if (fs.existsSync(repoAuto)) {
            fs.copyFileSync(repoAuto, path.join(dataDir, 'automations.json'));
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
                // Skip duplicating can_do_catalog in www since it is at /spiffs/catalog.json
                if (entry.name.startsWith('can_do_catalog')) continue;

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
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
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
