/**
 * jQuery global setup - MUST be imported before Trumbowyg
 *
 * ES module imports are hoisted, so `window.jQuery = jQuery` in the same file
 * as `import "trumbowyg"` would execute AFTER Trumbowyg tries to access `jQuery`.
 * This separate module ensures jQuery is on `window` before any Trumbowyg code runs.
 */
import jQuery from "jquery/slim";

// NC may define window.jQuery and/or window.$ as getter-only properties.
// Use try/catch so assignments survive esbuild tree-shaking and skip gracefully if not writable.
try {
  window.jQuery = jQuery;
} catch (_) {
  // getter-only — skip
}
try {
  window.$ = jQuery;
} catch (_) {
  // getter-only — skip
}

export default jQuery;
