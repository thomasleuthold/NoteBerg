import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
      const patched = workerSrc.replace(
        /static async #getJsModule\(fallbackCallback\) \{[\s\S]*?fallbackCallback\(instance\);\s*\}/,
        `static async #getJsModule(fallbackCallback) {
    let instance = null;
    try {
      instance = await __inlinedJBig2Fallback();
    } catch (e) {
      warn(\`JBig2CCITTFaxImage#getJsModule (inlined): \${e}\`);
    }
    fallbackCallback(instance);
  }`
      );
      if (patched === workerSrc) {
        console.warn('[inline-pdfjs-jbig2-fallback] WARNING: #getJsModule pattern not found — patch not applied');
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
 * Read the labeled version from package.json (single source of truth) and split
 * it into a clean base version and a human pre-release stage.
 *   "0.5.33-rc.4"  -> { version: "0.5.33", stage: "RC" }
 *   "0.5.33-beta.1"-> { version: "0.5.33", stage: "Beta" }
 *   "0.5.33"       -> { version: "0.5.33", stage: "" }
 */
function getAppVersionInfo() {
  let raw = '0.0.0';
  try {
    const packagePath = resolve(process.cwd(), 'package.json');
    raw = JSON.parse(readFileSync(packagePath, 'utf-8')).version || '0.0.0';
  } catch (e) {
    // fall through with default
  }

  const match = raw.match(/^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)(?:\.\d+)?)?$/);
  if (!match) return { version: raw, stage: '' };

  const [, base, stageRaw = ''] = match;
  const STAGE_LABELS = { rc: 'RC', beta: 'Beta', alpha: 'Alpha' };
  const key = stageRaw.toLowerCase();
  const stage = STAGE_LABELS[key] || (stageRaw ? stageRaw : '');
  return { version: base, stage };
}

const appVersionInfo = getAppVersionInfo();

const platform = process.env.VITE_PLATFORM || 'tauri';
// Dev container uses /apps-extra/; production Nextcloud uses /apps/
// Override with: VITE_NC_BASE=/apps/noteberg/ npm run build:nextcloud
const ncBase = process.env.VITE_NC_BASE || '/apps-extra/noteberg/';
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
    'import.meta.env.VITE_APP_STAGE': JSON.stringify(appVersionInfo.stage),
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
