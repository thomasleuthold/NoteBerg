import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Fail the build if pdf.js can request a decoder we do not ship.
//
// The required set is derived from pdf.worker.mjs itself — every `_filename`
// and `_noWasmFilename` a WasmImage subclass declares — rather than hardcoded,
// so a pdfjs-dist upgrade that adds or renames a decoder trips this instead of
// silently shipping a gap.
//
// This exists because a missing decoder has no runtime symptom to debug:
// pdf.js logs "ignoring XObject" and returns an empty operator list, so the
// page renders as blank white with no error. A scanned PDF (whose pages ARE
// JBig2/JPX images) then shows nothing at all. Two separate bugs of exactly
// this shape shipped before this check existed — one from the file being
// absent from the NC tarball, one from an upgrade silently disabling the
// inlined fallback.
function assertPdfjsWasmAssetsPresent() {
  const workerPath = resolve(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
  const vendorDir = resolve(process.cwd(), 'public/pdfjs-wasm');
  const workerSrc = readFileSync(workerPath, 'utf-8');

  // e.g. `_filename = "jbig2.wasm";` / `_noWasmFilename = "jbig2_nowasm_fallback.js";`
  const required = new Set();
  for (const m of workerSrc.matchAll(/_(?:noWasm)?[Ff]ilename\s*=\s*["']([^"']+)["']/g)) {
    required.add(m[1]);
  }
  if (required.size === 0) {
    throw new Error(
      '[pdfjs-wasm-assets] Could not find any decoder filenames in pdf.worker.mjs — ' +
        'the declaration shape changed; update the regex in vite.config.js.'
    );
  }

  // qcms_bg.wasm is intentionally not shipped (see the comment block in
  // src/modules/pdfManager.js). It is fetched through a different code path
  // and so never appears as a _filename, but guard the name explicitly in case
  // that changes upstream.
  const intentionallyOmitted = new Set(['qcms_bg.wasm']);

  const missing = [...required]
    .filter((f) => !intentionallyOmitted.has(f))
    .filter((f) => !existsSync(resolve(vendorDir, f)));

  if (missing.length > 0) {
    throw new Error(
      `[pdfjs-wasm-assets] pdf.js can request these decoder files but they are not in ` +
        `public/pdfjs-wasm/: ${missing.join(', ')}. Copy them from ` +
        `node_modules/pdfjs-dist/wasm/. Without them, scanned PDFs render as blank ` +
        `pages with no error at runtime.`
    );
  }
}

// Patch pdf.worker.mjs to inline jbig2_nowasm_fallback.js instead of loading
// it via dynamic import(). NC and Android WebViews block dynamic module imports
// that lack a CSP nonce / wasm-unsafe-eval, so we bake the fallback in.
function inlinePdfjsJbig2FallbackPlugin() {
  const workerPath = resolve(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
  const fallbackPath = resolve(process.cwd(), 'node_modules/pdfjs-dist/wasm/jbig2_nowasm_fallback.js');
  return {
    name: 'inline-pdfjs-jbig2-fallback',
    enforce: 'pre',
    load(id) {
      // ?raw imports arrive here with the raw file ID + ?raw suffix.
      // We intercept before Vite stringifies it so we can patch the source.
      if (!id.includes('pdf.worker.mjs') || !id.endsWith('?raw')) return;
      const workerSrc = readFileSync(workerPath, 'utf-8');
      const fallbackSrc = readFileSync(fallbackPath, 'utf-8');
      // Strip the ES module export — embed as a plain async function declaration.
      const fallbackBody = fallbackSrc.replace(/^export default \w+;\s*$/m, '');
      // Rename the exported function to avoid collision with pdf.js internals.
      const fallbackBodyRenamed = fallbackBody.replace(
        /^async function JBig2\b/m,
        'async function __inlinedJBig2Fallback'
      );
      // Replace #getJsModule's dynamic import(path) with a call to the inlined fn.
      // `static` is optional: pdfjs-dist declared this method static up to v5 and
      // as an instance method from v6. Matching only the static form made the
      // patch silently no-op on upgrade — the build printed a warning that
      // nobody reads, and scanned (JBig2) PDFs then rendered as blank pages in
      // any environment where the .wasm decoder is unreachable.
      const getJsModuleRe =
        /(static\s+)?async #getJsModule\(fallbackCallback\) \{[\s\S]*?fallbackCallback\(instance\);\s*\}/;
      const patched = workerSrc.replace(
        getJsModuleRe,
        (_match, staticKeyword) => `${staticKeyword || ''}async #getJsModule(fallbackCallback) {
    let instance = null;
    try {
      instance = await __inlinedJBig2Fallback();
    } catch (e) {
      warn(\`JBig2CCITTFaxImage#getJsModule (inlined): \${e}\`);
    }
    fallbackCallback(instance);
  }`
      );
      // Hard failure, not a warning. This patch is the fallback that keeps
      // scanned PDFs rendering when the .wasm decoders cannot be fetched; losing
      // it silently produces blank pages with no error anywhere at runtime.
      if (patched === workerSrc) {
        throw new Error(
          '[inline-pdfjs-jbig2-fallback] #getJsModule pattern not found in pdf.worker.mjs — ' +
            'the JBig2 pure-JS fallback was NOT inlined. pdfjs-dist likely changed this ' +
            'method; update the regex in vite.config.js to match the new shape.'
        );
      }
      const patchedWorker = fallbackBodyRenamed + '\n' + patched;
      // Return as ?raw: Vite expects `export default <string>`
      return `export default ${JSON.stringify(patchedWorker)}`;
    },
  };
}

// For NC build: evaluate perspective-transform in Node at build time, emit a clean ES module.
// NC's CSP has no unsafe-eval — we cannot use new Function() at browser runtime.
// This plugin intercepts our shim file and replaces it with a statically-inlined version.
// Trumbowyg uses bare `jQuery` global — in NC, window.jQuery is NC's instance, not ours.
// This plugin prepends `var jQuery = __nbJQuery;` to all trumbowyg files at build time,
// making the bare `jQuery` reference resolve to our bundled instance instead of window.jQuery.
// __nbJQuery is injected by the alias below pointing to src/shims/jquery-export.js.
function injectJQueryForTrumbowygPlugin() {
  return {
    name: 'inject-jquery-for-trumbowyg',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('node_modules/trumbowyg') && id.endsWith('.js')) {
        return { code: `import __nbJQuery from "jquery/slim";\nvar jQuery = __nbJQuery;\n${code}`, map: null };
      }
    },
  };
}

function patchPerspectiveTransformPlugin() {
  const distPath = resolve(process.cwd(), 'node_modules/perspective-transform/dist/perspective-transform.js');
  const distSrc = readFileSync(distPath, 'utf-8');
  // Patch the UMD source: replace `this` references in IIFE calls and remove this.numeric
  const patchedSrc = distSrc
    .replace(/\}?\(this([,)])/g, (_, sep) => `}(globalThis${sep}`)
    .replace('this.numeric = numeric;', '');
  // Wrap in explicit CJS-like scope so globalThis.numeric flows correctly
  const shimCode = `
const _root = {};
const _mod = { exports: {} };
(function(root, module, exports) {
${patchedSrc}
})(_root, _mod, _mod.exports);
export default _mod.exports;
`;
  return {
    name: 'patch-perspective-transform-nc',
    enforce: 'pre',
    transform(_code, id) {
if (id.includes('perspective-transform-nc-inline')) {
        return { code: shimCode, map: null };
      }
    },
  };
}



/**
 * Read the version from package.json (single source of truth for the base
 * version across all platforms).
 *   "0.5.33" -> { version: "0.5.33", build: "2" }
 *
 * package.json holds plain semver only — pre-release labels ("-rc.2") are a
 * Nextcloud-store concern and live solely in appinfo/info.xml, so nothing here
 * has to strip or interpret them. A stray suffix is tolerated defensively.
 */
function getAppVersionInfo() {
  let raw = '0.0.0';
  // package.json.build is the monotonic build counter maintained by
  // sync-version.js. Surfaced here so the About section can show it — it is the
  // number that distinguishes two builds of the same semver version, which is
  // what bug reports need.
  let build = '';
  try {
    const packagePath = resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    raw = pkg.version || '0.0.0';
    build = pkg.build !== undefined ? String(pkg.build) : '';
  } catch (e) {
    // fall through with default
  }

  const match = raw.match(/^(\d+\.\d+\.\d+)(?:-.*)?$/);
  if (!match) return { version: raw, build };

  return { version: match[1], build };
}

const appVersionInfo = getAppVersionInfo();

// Runs on every build (and dev server start) for every platform — the decoders
// are fetched at runtime on all targets, so a gap breaks Tauri and NC alike.
assertPdfjsWasmAssetsPresent();

const platform = process.env.VITE_PLATFORM || 'tauri';
// NC build uses a RELATIVE base so lazy-loaded chunk URLs resolve against the
// importing module's own URL. An absolute base (e.g. '/apps/noteberg/') is baked
// into every dynamic import() at build time and breaks on any NC installed under
// a path prefix: a server at /nextcloud/ would request /apps/noteberg/js/foo.js,
// which 404s into the SSO login page (YunoHost) and gets blocked as text/html.
// The static entry is unaffected — Util::addScript() generates that URL
// server-side via NC's URL generator, which already knows the webroot.
// VITE_NC_BASE is still honoured if explicitly set, for the container recipes.
const ncBase = process.env.VITE_NC_BASE || './';
const base = platform === 'nextcloud' ? ncBase : '/';

export default defineConfig({
  plugins: [
    injectJQueryForTrumbowygPlugin(),
    inlinePdfjsJbig2FallbackPlugin(),
    ...(platform === 'nextcloud' ? [patchPerspectiveTransformPlugin()] : []),
  ],
  base,
  resolve: {
    alias: [
      // ES module shim for UMD perspective-transform (uses `this` as global, undefined in strict mode).
      // NC build: static inline shim (no new Function — blocked by NC CSP).
      // Tauri/dev: ?raw + new Function shim (unsafe-eval is allowed in Tauri CSP).
      {
        find: 'perspective-transform',
        replacement: resolve(process.cwd(), platform === 'nextcloud'
          ? 'src/shims/perspective-transform-nc-inline.js'
          : 'src/shims/perspective-transform.js'),
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
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersionInfo.version),
    'import.meta.env.VITE_APP_BUILD': JSON.stringify(appVersionInfo.build),
    'import.meta.env.VITE_PLATFORM': JSON.stringify(platform),
  },
  build: {
    target: 'esnext',
    outDir: platform === 'nextcloud' ? '.' : 'dist',
    emptyOutDir: platform !== 'nextcloud', // never wipe the repo root
    // Tauri uses Chromium, so we can use modern features
    minify: !process.env.TAURI_DEBUG ? 'oxc' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: platform === 'nextcloud' ? {
      input: resolve(process.cwd(), 'src/main.js'),
      output: {
        entryFileNames: 'js/noteberg-main.mjs',
        // Content-hashed chunk names. The entry stays stable because
        // Util::addScript() must be able to name it, and NC's own versioning
        // busts its cache. Chunks get hashes so a stale file from an earlier
        // build can never shadow a fresh one — mangled export names are not
        // stable across builds, and a mismatch is a hard module-load error.
        chunkFileNames: 'js/[name]-[hash].js',
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
