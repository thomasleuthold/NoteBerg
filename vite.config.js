import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';



function getAppVersion() {
  try {
    // Try tauri.conf.json first (source of truth for MSI/bundle)
    const tauriConfigPath = resolve(process.cwd(), 'src-tauri', 'tauri.conf.json');
    const content = readFileSync(tauriConfigPath, 'utf-8');
    const config = JSON.parse(content);
    // Handle Tauri v1 (package.version) and v2 (version)
    return config.version || config.package?.version || '0.0.0';
  } catch (e) {
    // Fallback to package.json
    try {
      const packagePath = resolve(process.cwd(), 'package.json');
      const content = readFileSync(packagePath, 'utf-8');
      return JSON.parse(content).version || '0.0.0';
    } catch (e2) {
      return '0.0.0';
    }
  }
}

const platform = process.env.VITE_PLATFORM || 'tauri';
// Dev container uses /apps-extra/; production Nextcloud uses /apps/
// Override with: VITE_NC_BASE=/apps/noteberg/ npm run build:nextcloud
const ncBase = process.env.VITE_NC_BASE || '/apps-extra/noteberg/';
const base = platform === 'nextcloud' ? ncBase : '/';

export default defineConfig({
  plugins: [],
  base,
  resolve: {
    alias: [
      // ES module shim for UMD perspective-transform (uses `this` as global, undefined in strict mode)
      {
        find: 'perspective-transform',
        replacement: resolve(process.cwd(), 'src/shims/perspective-transform.js'),
      },
      ...(platform === 'nextcloud' ? [
        // Redirect all storage.js imports to the WebDAV backend for NC build
        {
          find: /.*\/storage\.js$/,
          replacement: resolve(process.cwd(), 'src/modules/storage.webdav.js'),
        },
      ] : []),
    ],
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(getAppVersion()),
    'import.meta.env.VITE_PLATFORM': JSON.stringify(platform),
  },
  build: {
    target: 'esnext',
    outDir: platform === 'nextcloud' ? '.' : 'dist',
    emptyOutDir: platform !== 'nextcloud', // never wipe the repo root
    // Tauri uses Chromium, so we can use modern features
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: platform === 'nextcloud' ? {
      input: resolve(process.cwd(), 'src/main.js'),
      output: {
        entryFileNames: 'js/noteberg-main.js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'css/noteberg-styles.css' : 'assets/[name][extname]',
      },
    } : {},
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  // Prevent vite from obscuring rust errors
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
