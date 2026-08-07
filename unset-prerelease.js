import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';

/**
 * unset-prerelease.js
 *
 * Promotes a pre-release to final by dropping the label, keeping the base:
 *   0.5.33-rc.4   -> 0.5.33
 *   0.5.33-beta.2 -> 0.5.33
 *   0.5.33        -> no-op (already final)
 *
 * The counterpart to set-prerelease.js. `npm version patch` happens to do the same
 * thing from a pre-release, but it is easy to misread as "next patch" — this is the
 * explicit way to say "ship what is on the RC".
 *
 * Rewrites package.json only — no commit, no tag, no clean-tree requirement.
 * `--no-git-tag-version` also suppresses the "version" npm script, so
 * sync-version.js is invoked directly to keep info.xml / tauri.conf.json /
 * Cargo.toml in step. Does NOT touch the build counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(__dirname, 'package.json');

const currentVersion = JSON.parse(readFileSync(packagePath, 'utf-8')).version;
const match = currentVersion.match(/^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)(?:\.(\d+))?)?$/);
if (!match) {
  console.error(`Cannot parse current version "${currentVersion}"`);
  process.exit(1);
}

const [, base, stage = ''] = match;

if (!stage) {
  console.log(`Already final (${currentVersion}) — no-op.`);
  process.exit(0);
}

console.log(`Promoting to final: ${currentVersion} -> ${base}`);
execSync(`npm version ${base} --no-git-tag-version`, { stdio: 'inherit', cwd: __dirname });
execSync('node sync-version.js', { stdio: 'inherit', cwd: __dirname });
console.log(`\nVersion set to ${base} — not committed or tagged.`);
console.log('Commit the version files and tag manually when your tree is ready.');
