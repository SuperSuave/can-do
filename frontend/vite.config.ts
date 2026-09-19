import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vite';
import viteCompression from 'vite-plugin-compression';

export default defineConfig(() => {
  return {
    // 1. Relative base path so it resolves cleanly when served directly by ESP32 IP or mDNS
    base: './',

    // 2. Output directly to the ESP-IDF data staging folder
    build: {
      outDir: path.resolve(__dirname, '../firmware/data/www'),
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
      // 3. Compress files to .gz to save LittleFS partition space
      viteCompression({
        algorithm: 'gzip',
        ext: '.gz',
        deleteOriginFile: true,
      }),
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
            // Stage in firmware/data/catalog.json (LittleFS root)
            const dataDir = path.resolve(__dirname, '../firmware/data');
            if (!fs.existsSync(dataDir)) {
              fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.copyFileSync(catalogFile, path.join(dataDir, 'catalog.json'));

            // Also copy automations.json if present in repo root or firmware
            const repoAuto = path.resolve(__dirname, '../firmware/automations.json');
            if (fs.existsSync(repoAuto)) {
              fs.copyFileSync(repoAuto, path.join(dataDir, 'automations.json'));
            }
          }
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
