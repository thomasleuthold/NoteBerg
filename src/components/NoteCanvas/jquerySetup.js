/**
 * jQuery global setup - MUST be imported before Trumbowyg
 *
 * ES module imports are hoisted, so `window.jQuery = jQuery` in the same file
 * as `import "trumbowyg"` would execute AFTER Trumbowyg tries to access `jQuery`.
 * This separate module ensures jQuery is on `window` before any Trumbowyg code runs.
 */
import jQuery from "jquery/slim";

window.jQuery = jQuery;
// NC defines window.$ as a getter-only property — only assign if writable
const descriptor = Object.getOwnPropertyDescriptor(window, "$");
if (!descriptor || descriptor.writable || descriptor.set) {
  window.$ = jQuery;
}

export default jQuery;
