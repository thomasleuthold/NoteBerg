import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const packagePath = resolve(rootDir, 'package.json');
const tauriConfigPath = resolve(rootDir, 'src-tauri', 'tauri.conf.json');

try {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf-8'));

  if (tauriConfig.version !== pkg.version) {
    console.log(`Bumping tauri.conf.json version: ${tauriConfig.version} -> ${pkg.version}`);
    tauriConfig.version = pkg.version;
    writeFileSync(tauriConfigPath, JSON.stringify(tauriConfig, null, 2));
  } else {
    console.log('tauri.conf.json version is already up to date');
  }
} catch (error) {
  console.error('Failed to sync version:', error);
  process.exit(1);
}