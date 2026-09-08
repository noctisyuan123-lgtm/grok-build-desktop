import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fetchCliBilling } from './scripts/cliUsage.mjs';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function cliUsagePlugin(): Plugin {
  return {
    name: 'grok-cli-usage',
    configureServer(server) {
      server.middlewares.use('/__grok/cli-usage', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          next();
          return;
        }
        void fetchCliBilling()
          .then((usage) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(usage));
          })
          .catch((error: unknown) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                creditUsagePercent: null,
                periodType: null,
                periodStart: null,
                periodEnd: null,
                onDemandCap: null,
                onDemandUsed: null,
                prepaidBalance: null,
                unifiedBilling: false,
                subscriptionTier: null,
                snapshots: [],
              }),
            );
          });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), cliUsagePlugin()],

  // Tauri serves the production bundle from a custom protocol. Relative
  // asset URLs keep CSS-owned resources (notably KaTeX fonts) on that same
  // origin instead of resolving them against a protocol root WebKit cannot
  // reliably load.
  base: './',

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}));
