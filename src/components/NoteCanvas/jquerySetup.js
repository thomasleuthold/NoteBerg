/**
 * jQuery global setup - MUST be imported before Trumbowyg
 *
 * ES module imports are hoisted, so `window.jQuery = jQuery` in the same file
 * as `import "trumbowyg"` would execute AFTER Trumbowyg tries to access `jQuery`.
 * This separate module ensures jQuery is on `window` before any Trumbowyg code runs.
 */
import jQuery from "jquery/slim";

window.jQuery = jQuery;
// NC defines window.$ as a getter-only property — use try/catch so the assignment
// survives tree-shaking and gracefully skips if $ is not writable
try {
  window.$ = jQuery;
} catch (_) {
  // getter-only — skip
}

export default jQuery;
