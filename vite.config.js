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

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(getAppVersion()),
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    // Tauri uses Chromium, so we can use modern features
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  // Prevent vite from obscuring rust errors
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
