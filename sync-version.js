import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';

/**
 * sync-version.js
 *
 * Single source of truth for versioning:
 *   package.json.version  -> plain semver base, e.g. "0.5.33" (NO pre-release label;
 *                            npm-managed via `npm version` / `just bump*`)
 *   package.json.build    -> monotonic build counter, incremented on EVERY build
 *                            (managed here; may run on a dirty tree, is NOT committed)
 *
 * From those two, this script derives and writes:
 *   - src-tauri/tauri.conf.json
 *       version                        = "0.5.33"
 *       bundle.windows.wix.version     = "0.5.33.<build>" (MSI ProductVersion, 4th part = build)
 *       bundle.android.versionCode     = <versionCode>    (monotonic, encodes semver + build)
 *   - src-tauri/Cargo.toml
 *       version                        = "0.5.33"
 *   - appinfo/info.xml
 *       <version>                      = "0.5.33" + whatever pre-release suffix
 *                                        info.xml already carried (see below)
 *
 * Pre-release / RC stages are a Nextcloud-store concern ONLY (a labeled version is
 * hidden from the store's default listing). They are therefore NOT globally managed:
 * edit `<version>0.5.33-rc.2</version>` in appinfo/info.xml by hand, and this script
 * preserves that suffix while keeping the base version in lockstep with package.json.
 * There are no set-rc/bump-rc/unset-rc commands, and no stage reaches the frontend.
 *
 * The frontend (footer / settings "About") reads the version + build from
 * package.json via vite.config.js (VITE_APP_VERSION / VITE_APP_BUILD), so no source
 * file is mutated for display.
 *
 * versionCode scheme (monotonic, human-decodable):
 *   versionCode = major*10_000_000 + minor*100_000 + patch*1_000 + build
 *   e.g. 0.5.33 build 142 -> 0 + 500_000 + 33_000 + 142 = 533_142  ("0.5.33 #142")
 *   Constraints: minor < 100, patch < 100, build < 1000 within a single patch line.
 *
 * This script does not otherwise touch the build counter — it just reads
 * package.json and regenerates the derived files — except:
 *   - `just bump-build` passes --bump-build, which increments it by 1.
 *   - `npm version patch/minor/major` (i.e. `just bump`/`bump-minor`/`bump-major`)
 *     runs this script as npm's "version" lifecycle script (recognizable via
 *     process.env.npm_lifecycle_event === 'version'). That means the semver
 *     base just changed, so the build counter resets to 1 for the new version.
 *
 * Flags:
 *   --bump-build   increment package.json.build by 1 before regenerating (NOT committed)
 *   --info         print the version summary line and exit; write no files
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;

const packagePath = resolve(rootDir, 'package.json');
const tauriConfigPath = resolve(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = resolve(rootDir, 'src-tauri', 'Cargo.toml');
const infoXmlPath = resolve(rootDir, 'appinfo', 'info.xml');

const bumpBuild = process.argv.includes('--bump-build');
const infoOnly = process.argv.includes('--info');
// npm sets this to the script name being run — 'version' only when invoked as
// npm's version-lifecycle script (i.e. via `npm version patch/minor/major`).
const isNpmVersionHook = process.env.npm_lifecycle_event === 'version';

/**
 * Parse package.json's version into its parts. Returns { major, minor, patch, base }.
 *
 * package.json is expected to hold plain semver ("0.5.33"). A pre-release suffix
 * left over from an older checkout is tolerated and stripped with a warning — RC
 * stages belong in appinfo/info.xml, not here.
 */
function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
  if (!match) {
    throw new Error(`Cannot parse version "${version}" (expected e.g. 0.5.33)`);
  }
  const [, major, minor, patch, suffix] = match;
  if (suffix) {
    console.warn(
      `WARNING: package.json version "${version}" carries a pre-release label. ` +
        `Pre-release stages now live only in appinfo/info.xml — using ${major}.${minor}.${patch} ` +
        `and ignoring "${suffix}". Run \`npm version ${major}.${minor}.${patch} --no-git-tag-version\` to clean it up.`,
    );
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    base: `${major}.${minor}.${patch}`,
  };
}

function computeVersionCode({ major, minor, patch }, build) {
  if (minor >= 100) throw new Error(`minor version ${minor} >= 100 breaks versionCode scheme`);
  if (patch >= 100) throw new Error(`patch version ${patch} >= 100 breaks versionCode scheme`);
  if (build >= 1000) {
    console.warn(
      `WARNING: build ${build} >= 1000 will overflow into the patch field of versionCode. ` +
        `Consider bumping the patch version to reset the effective build room.`,
    );
  }
  return major * 10_000_000 + minor * 100_000 + patch * 1_000 + build;
}

try {
  const pkgRaw = readFileSync(packagePath, 'utf-8');
  const pkg = JSON.parse(pkgRaw);

  const parsed = parseVersion(pkg.version);

  // --- 1. Build counter -----------------------------------------------------
  // Bumped via --bump-build, or reset to 1 when a semver bump just ran (npm's
  // "version" lifecycle script — the base version has already changed by now).
  let build = Number.isInteger(pkg.build) ? pkg.build : 0;
  if (isNpmVersionHook && !infoOnly) {
    build = 1;
    pkg.build = build;
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`Version bump detected — build counter reset -> ${build}`);
  } else if (bumpBuild && !infoOnly) {
    build += 1;
    pkg.build = build;
    // Preserve formatting/indentation of package.json as closely as possible.
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`Build counter -> ${build}`);
  } else if (!infoOnly) {
    console.log(`Build counter unchanged: ${build}`);
  }

  const versionCode = computeVersionCode(parsed, build);
  const wixVersion = `${parsed.base}.${build}`;

  console.log(
    `Version: ${parsed.base}  |  build: ${build}  |  versionCode: ${versionCode}  |  wix: ${wixVersion}`,
  );

  // --info: read-only summary; do not touch any files. Includes the Nextcloud
  // version verbatim, since that is the only place a pre-release stage lives.
  if (infoOnly) {
    const ncVersion = readFileSync(infoXmlPath, 'utf-8').match(/<version>([^<]+)<\/version>/)?.[1];
    console.log(`Nextcloud (info.xml): ${ncVersion?.trim() ?? '(not found)'}`);
    process.exit(0);
  }

  // --- 2. tauri.conf.json --------------------------------------------------
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf-8'));

  tauriConfig.version = parsed.base;

  tauriConfig.bundle = tauriConfig.bundle || {};
  tauriConfig.bundle.windows = tauriConfig.bundle.windows || {};
  tauriConfig.bundle.windows.wix = tauriConfig.bundle.windows.wix || {};
  tauriConfig.bundle.windows.wix.version = wixVersion;

  tauriConfig.bundle.android = tauriConfig.bundle.android || {};
  tauriConfig.bundle.android.versionCode = versionCode;

  writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
  console.log(
    `tauri.conf.json -> version ${parsed.base}, wix.version ${wixVersion}, ` +
      `android.versionCode ${versionCode}`,
  );

  // --- 3. Cargo.toml -------------------------------------------------------
  const cargoToml = readFileSync(cargoTomlPath, 'utf-8');
  const cargoVersionMatch = cargoToml.match(/^version = "([^"]+)"/m);
  if (cargoVersionMatch && cargoVersionMatch[1] !== parsed.base) {
    const updatedCargoToml = cargoToml.replace(/^version = "[^"]+"/m, `version = "${parsed.base}"`);
    writeFileSync(cargoTomlPath, updatedCargoToml);
    console.log(`Cargo.toml -> version ${parsed.base}`);
  } else {
    console.log('Cargo.toml version already up to date');
  }

  // --- 4. appinfo/info.xml (Nextcloud app) ---------------------------------
  // Only the base version is synced here. Any pre-release suffix ("-rc.2") is
  // owned by info.xml itself and preserved verbatim, so a stage set by hand
  // survives every build:
  //   info.xml 0.5.39-rc.2 + package.json 0.5.40  ->  0.5.40-rc.2
  //   info.xml 0.5.39      + package.json 0.5.40  ->  0.5.40
  const infoXml = readFileSync(infoXmlPath, 'utf-8');
  const infoVersionMatch = infoXml.match(/<version>([^<]+)<\/version>/);
  if (infoVersionMatch) {
    const current = infoVersionMatch[1].trim();
    // Everything after the base version is the NC-local pre-release suffix.
    const suffixMatch = current.match(/^\d+\.\d+\.\d+(-.*)?$/);
    if (!suffixMatch) {
      console.warn(
        `WARNING: info.xml <version> "${current}" is not parseable as semver — ` +
          `replacing it with ${parsed.base} and dropping any pre-release label.`,
      );
    }
    const suffix = suffixMatch?.[1] ?? '';
    const target = `${parsed.base}${suffix}`;

    if (current !== target) {
      const updatedInfoXml = infoXml.replace(
        /<version>[^<]+<\/version>/,
        `<version>${target}</version>`,
      );
      writeFileSync(infoXmlPath, updatedInfoXml);
      console.log(`info.xml -> version ${target}${suffix ? `  (pre-release ${suffix.slice(1)})` : ''}`);
    } else {
      console.log(
        `info.xml version already up to date: ${target}${suffix ? `  (pre-release ${suffix.slice(1)})` : ''}`,
      );
    }

    // Warn-only sanity check: NC rejects malformed labels like "-rc2".
    if (suffix && !/^-[a-z]+\.\d+$/.test(suffix)) {
      console.warn(
        `WARNING: info.xml pre-release label "${suffix}" is unusual — ` +
          `Nextcloud expects e.g. "-rc.2" or "-beta.1".`,
      );
    }
  } else {
    console.warn('WARNING: no <version> element found in appinfo/info.xml — nothing synced');
  }
} catch (error) {
  console.error('Failed to sync version:', error.message);
  process.exit(1);
}
