/**
 * jQuery global setup - MUST be imported before Trumbowyg
 *
 * ES module imports are hoisted, so `window.jQuery = jQuery` in the same file
 * as `import "trumbowyg"` would execute AFTER Trumbowyg tries to access `jQuery`.
 * This separate module ensures jQuery is on `window` before any Trumbowyg code runs.
 */
import jQuery from "jquery/slim";

// NC33 defines window.jQuery and window.$ as getter-only properties.
// Try to redefine them as writable so Trumbowyg (which reads window.jQuery to self-register)
// finds OUR jQuery. Fall back to silent try/catch if non-configurable.
for (const prop of ["jQuery", "$"]) {
  try {
    Object.defineProperty(window, prop, {
      configurable: true,
      writable: true,
      value: jQuery,
    });
  } catch (_) {
    try {
      window[prop] = jQuery;
    } catch (__) {}
  }
}
// Neutralise noConflict so NC33's post-load cleanup can't overwrite window.jQuery back.
jQuery.noConflict = () => jQuery;

export default jQuery;
