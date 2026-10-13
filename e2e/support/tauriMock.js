/**
 * Fake Tauri runtime for browser e2e.
 *
 * The app treats `window.__TAURI_INTERNALS__` as "I am a native client" and
 * routes calls through `invoke()` from @tauri-apps/api/core, which calls
 * `__TAURI_INTERNALS__.invoke(cmd, args)`. This installs a minimal stand-in
 * (same shape as @tauri-apps/api/mocks' mockIPC) BEFORE any app script runs,
 * so the native code paths execute against a scripted backend instead of Rust.
 *
 * `installTauriMock` runs in the page (via addInitScript), so the response table
 * is serialised: keys are command names, values are plain JSON returned as-is.
 * Commands that need state or logic add functions to `window.__tauriHandlers`
 * from their own init script (see fakeArchive.js).
 * Every call is recorded on `window.__tauriCalls` and unknown commands reject
 * loudly, so a new native dependency shows up as a failing test, not a hang.
 */

/** Responses for the commands the app issues during normal startup. */
export const DEFAULT_TAURI_RESPONSES = {
  mcp_set_config: null,
  mcp_get_status: { enabled: false, running: false },
  get_recognition_url: "http://localhost:5000",
  // OS keychain: stateful, see fakeKeyring.js.
  // Tauri event system — app code calls listen() for MCP / native events.
  "plugin:event|listen": 1,
  "plugin:event|unlisten": null,
};

export async function installTauriMock(page, responses = {}) {
  await page.addInitScript(
    (table) => {
      const callbacks = new Map();
      window.__tauriCalls = [];
      // Stateful commands (e.g. fakeArchive.js) register functions here; they
      // take precedence over the static table.
      window.__tauriHandlers = {};
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback(cb, once) {
          const id = Math.floor(Math.random() * 0xffffffff);
          callbacks.set(id, (data) => {
            if (once) callbacks.delete(id);
            return cb?.(data);
          });
          return id;
        },
        unregisterCallback: (id) => callbacks.delete(id),
        runCallback: (id, data) => callbacks.get(id)?.(data),
        callbacks,
        async invoke(cmd, args) {
          window.__tauriCalls.push({ cmd, args });
          const handler = window.__tauriHandlers[cmd];
          if (handler) return handler(args ?? {});
          if (Object.hasOwn(table, cmd)) return table[cmd];
          throw new Error(`[e2e tauriMock] unhandled command: ${cmd}`);
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {},
      };
    },
    { ...DEFAULT_TAURI_RESPONSES, ...responses },
  );
}
