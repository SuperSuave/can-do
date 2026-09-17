import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    base: '/',
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
              cleanUrl === '/CAN-Do-Message-Catalog/catalog/can_do_catalog.json'
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
            this.emitFile({
              type: 'asset',
              fileName: 'catalog/can_do_catalog.json',
              source: fs.readFileSync(catalogFile, 'utf-8'),
            });
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
