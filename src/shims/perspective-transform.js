// ES module shim for perspective-transform (UMD, uses `this` as global).
// Executes the original source in an explicit scope (no `this` dependency).
// Tauri CSP includes unsafe-eval so new Function is allowed at runtime.
// For NC builds, vite.config.js replaces this entire module at build time.

import src from "../../node_modules/perspective-transform/dist/perspective-transform.js?raw";

const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("root", "module", "exports", src)({}, mod, mod.exports);

export default mod.exports;
