import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';

/**
 * set-prerelease.js <beta|rc>
 *
 * Sets the pre-release stage of package.json.version, starting the counter at .1.
 *   0.5.33          + rc   -> 0.5.33-rc.1
 *   0.5.33-beta.2   + rc   -> 0.5.33-rc.1   (switch stage, counter resets to 1)
 *   0.5.33-rc.4     + rc   -> no-op         (same stage already set)
 *
 * Uses `npm version <newversion>` so the change is committed + tagged (and fires the
 * "version" npm script that regenerates all derived files). Requires a clean tree.
 *
 * This does NOT touch the build counter — that is bumped only by `just bump-build`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(__dirname, 'package.json');

const stage = (process.argv[2] || '').toLowerCase();
if (stage !== 'beta' && stage !== 'rc') {
  console.error('Usage: node set-prerelease.js <beta|rc>');
  process.exit(1);
}

const currentVersion = JSON.parse(readFileSync(packagePath, 'utf-8')).version;
const match = currentVersion.match(/^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)(?:\.(\d+))?)?$/);
if (!match) {
  console.error(`Cannot parse current version "${currentVersion}"`);
  process.exit(1);
}

const [, base, currentStage = ''] = match;

if (currentStage.toLowerCase() === stage) {
  console.log(`Already on ${stage} (${currentVersion}) — no-op.`);
  process.exit(0);
}

const newVersion = `${base}-${stage}.1`;
console.log(`Setting pre-release: ${currentVersion} -> ${newVersion}`);

// npm version <exact> commits, tags, and runs the "version" script (sync-version + git add).
execSync(`npm version ${newVersion}`, { stdio: 'inherit', cwd: __dirname });
