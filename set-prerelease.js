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
 * Rewrites package.json only — no commit, no tag, no clean-tree requirement — so it
 * can be run with other work in flight. `--no-git-tag-version` also suppresses the
 * "version" npm script, so sync-version.js is invoked directly to keep
 * info.xml / tauri.conf.json / Cargo.toml in step. Commit and tag yourself when the
 * tree settles.
 *
 * `--no-git` is accepted and ignored: git-free is now the only behaviour.
 *
 * This does NOT touch the build counter — that is bumped only by `just bump-build`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(__dirname, 'package.json');

const args = process.argv.slice(2);
const stage = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
if (stage !== 'beta' && stage !== 'rc') {
  console.error('Usage: node set-prerelease.js <beta|rc> [--no-git]');
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

// --no-git-tag-version writes package.json only: no commit, no tag, and no
// clean-tree check. It also skips the "version" npm script, so the derived
// files are regenerated here instead.
execSync(`npm version ${newVersion} --no-git-tag-version`, { stdio: 'inherit', cwd: __dirname });
execSync('node sync-version.js', { stdio: 'inherit', cwd: __dirname });
console.log(`\nVersion set to ${newVersion} — not committed or tagged.`);
console.log('Commit the version files and tag manually when your tree is ready.');
