import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';

/**
 * bump-prerelease.js
 *
 * Bumps the current pre-release counter, keeping the stage:
 *   0.5.33-rc.1   -> 0.5.33-rc.2
 *   0.5.33-beta.2 -> 0.5.33-beta.3
 *
 * FAILS if no pre-release is set (a final release like 0.5.33) — use
 * `just set-rc <rc|beta>` first. This guard is why we don't use a bare
 * `npm version prerelease`, which would silently produce "0.5.34-0".
 *
 * Uses `npm version prerelease --preid <stage>` so the stage label is preserved.
 * Rewrites package.json only — no commit, no tag, no clean-tree requirement.
 * `--no-git-tag-version` also suppresses the "version" npm script, so
 * sync-version.js is invoked directly to regenerate the derived files.
 * Does NOT touch the build counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(__dirname, 'package.json');

const currentVersion = JSON.parse(readFileSync(packagePath, 'utf-8')).version;
const match = currentVersion.match(/^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)(?:\.(\d+))?)?$/);
if (!match) {
  console.error(`Cannot parse current version "${currentVersion}"`);
  process.exit(1);
}

const [, , stage = ''] = match;
if (!stage) {
  console.error(
    `No pre-release is set (current: ${currentVersion}). ` +
      `Use "just set-rc rc" or "just set-rc beta" first.`,
  );
  process.exit(1);
}

console.log(`Bumping pre-release: ${currentVersion} (stage ${stage}) ...`);
execSync(`npm version prerelease --preid ${stage} --no-git-tag-version`, {
  stdio: 'inherit',
  cwd: __dirname,
});
execSync('node sync-version.js', { stdio: 'inherit', cwd: __dirname });
console.log('\nNot committed or tagged — commit the version files when your tree is ready.');
