/**
 * NoteBerg - Main Application Entry Point
 */

// Import styles
import "./styles/main.css";
// Tauri/Android only: set html/body height and overflow — NC manages these itself
if (import.meta.env.VITE_PLATFORM !== "nextcloud") {
  await import("./styles/layout-root.css");
  await import("./styles/fonts.css");
}
import "./styles/themes/light.css";
import "./styles/themes/dark.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/notebookEditor.css";

import { initModals } from "./components/modals.js";
import { initNoteCanvasComponent } from "./components/NoteCanvas/index.js";
import { initOverview } from "./components/overviewMode.js";
import { initRecycleBin } from "./components/recycleBinMode.js";
import { initI18n } from "./i18n/index.js";
import { initializeApp } from "./modules/appInit.js";
import { initBreadcrumb } from "./modules/breadcrumb.js";
import { migrateCardSizeFromSettings } from "./modules/displayPrefs.js";
import { initFooter } from "./modules/footer.js";
import { initRouter, navigateTo } from "./modules/router.js";
import { getSetting, initStorage } from "./modules/storage.js";
import { initTheme } from "./modules/theme.js";
import { getIcon } from "./utils/icons.js";
import { initLogger } from "./utils/logger.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

// Platforms where the Rust MCP server (src-tauri/src/mcp.rs) is compiled in —
// must be kept in lockstep with the #[cfg(target_os = "...")] gates on
// mcp::start / mcp::mcp_respond in lib.rs. Widen both together, not just one.
// (Windows-only today; add macOS/Linux here when their cfg gates are added.)
function isMcpSupportedPlatform() {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

// Application state
const app = {
  initialized: false,
  currentNote: null,
};

/**
 * Lazily-loaded settingsDialog module exports. Cached on first open so the
 * popstate handler can check dialog state synchronously (see setupEventListeners).
 */
let settingsDialogApi = null;

/**
 * Initialize the application
 */
async function init() {
  const appStartTime = performance.now();

  console.log("NoteBerg initializing...");

  // Initialize storage FIRST (required for logger to load saved level)
  const storageStart = performance.now();
  await initStorage();
  console.log(`Storage initialized in ${Math.round(performance.now() - storageStart)}ms`);

  // Initialize logger (loads saved log level from storage)
  const loggerStart = performance.now();
  await initLogger();
  console.log(`Logger initialized in ${Math.round(performance.now() - loggerStart)}ms`);

  // Card size moved from the settings store to localStorage (it must persist on
  // the NC build too, where setSetting is in-memory only). Carry the existing
  // native value over once, before the overview first reads it.
  await migrateCardSizeFromSettings(getSetting);

  // Initialize i18n (loads saved language preference from storage)
  const i18nStart = performance.now();
  await initI18n();
  console.log(`i18n initialized in ${Math.round(performance.now() - i18nStart)}ms`);

  // Initialize theme system (before master password modal for proper styling)
  const themeStart = performance.now();
  await initTheme();
  console.log(`Theme initialized in ${Math.round(performance.now() - themeStart)}ms`);

  // MASTER PASSWORD: Initialize and unlock app (Tauri only)
  if (!IS_NEXTCLOUD) {
    try {
      const appInitStart = performance.now();
      await initializeApp();
      console.log(`App initialization took ${Math.round(performance.now() - appInitStart)}ms`);
    } catch (error) {
      console.error("Failed to initialize master password system:", error);
      document.body.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100vh; padding: 20px;">
          <div style="text-align: center; max-width: 500px;">
            <h1 style="color: #dc2626; margin-bottom: 16px;">Initialization Error</h1>
            <p style="color: #6b7280; margin-bottom: 24px;">
              Failed to initialize the encryption system. Please refresh the page and try again.
            </p>
            <p style="font-family: monospace; font-size: 12px; color: #9ca3af; background: #f3f4f6; padding: 12px; border-radius: 8px;">
              ${error.message}
            </p>
            <button onclick="location.reload()" style="margin-top: 24px; padding: 12px 24px; background: #3b82f6; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500;">
              Reload App
            </button>
          </div>
        </div>
      `;
      return;
    }

    // Migrate credentials from localStorage to secure storage (one-time migration)
    const migrateStart = performance.now();
    const { migrateCredentials } = await import("./modules/nextcloudSync.js");
    await migrateCredentials();
    console.log(`Credential migration took ${Math.round(performance.now() - migrateStart)}ms`);

    // MCP bridge: only where the Rust side actually exists (see isMcpSupportedPlatform
    // above and documentation/mcp_design.md). This whole branch is already
    // unreachable in the Nextcloud build (IS_NEXTCLOUD guard above); this check
    // additionally excludes Android, iOS, and any future desktop OS before its
    // Rust cfg gate is actually added.
    if (isMcpSupportedPlatform()) {
      const { initMcpBridge, syncMcpConfigToRust } = await import("./modules/mcpBridge.js");
      initMcpBridge();
      // Awaited (not fire-and-forget): Rust always boots disabled/tokenless,
      // so until this completes the server doesn't reflect a user's
      // persisted "enabled" setting yet. See syncMcpConfigToRust's doc
      // comment for why this is awaited-with-one-retry rather than a
      // silent background push.
      try {
        await syncMcpConfigToRust();
      } catch (error) {
        console.error(
          "[MCP Bridge] Could not sync MCP config to Rust after retry — MCP will stay disabled this session:",
          error,
        );
      }
    }
  }

  // Initialize router
  const componentsStart = performance.now();
  initRouter();

  // Initialize components.
  // Settings needs no init step any more: the dialog imports and renders the
  // panel on demand (see settingsDialog.js), rather than a router mode listener
  // registered up front. That also keeps settingsMode.js out of the startup path.
  if (!IS_NEXTCLOUD) {
    const { initAutoSync } = await import("./modules/autoSync.js");
    initAutoSync();
  }
  initOverview();
  initModals();
  initRecycleBin();
  initNoteCanvasComponent();
  initBreadcrumb();
  initFooter();
  console.log(`Components initialized in ${Math.round(performance.now() - componentsStart)}ms`);

  // Set up event listeners
  setupEventListeners();

  // Navigate to overview by default
  const navStart = performance.now();
  navigateTo("overview");
  console.log(`Navigation to overview took ${Math.round(performance.now() - navStart)}ms`);

  // Mark as initialized
  app.initialized = true;
  const totalTime = Math.round(performance.now() - appStartTime);
  console.log(`NoteBerg ready! Total startup time: ${totalTime}ms`);
}

/**
 * Set up global event listeners
 */
function setupEventListeners() {
  // Overview button
  const overviewBtn = document.getElementById("nav-overview");
  if (overviewBtn) {
    overviewBtn.addEventListener("click", () => {
      navigateTo("overview");
    });
  }

  // Settings button. Opens a dialog rather than navigating: a mode change would
  // replace #main-content and tear down an open note (see settingsDialog.js).
  const settingsBtn = document.getElementById("nav-settings");
  if (settingsBtn) {
    settingsBtn.innerHTML = getIcon("settings", 24);
    settingsBtn.addEventListener("click", async () => {
      // Cached so the popstate handler below can query dialog state
      // synchronously; the module still stays out of the initial bundle.
      settingsDialogApi = await import("./components/settingsDialog.js");
      await settingsDialogApi.openSettingsDialog();
    });
  }

  // Android hardware Back closes the settings dialog before it unwinds app
  // navigation, matching the platform convention that Back dismisses whatever
  // is on top.
  //
  // Capture phase AND synchronous: stopImmediatePropagation only suppresses the
  // router's popstate handler if it runs before that handler does. An async
  // listener would resolve its dynamic import a microtask too late, by which
  // point the router has already navigated. settingsDialog is therefore
  // imported eagerly here (it is already loaded whenever the dialog is open).
  window.addEventListener(
    "popstate",
    (event) => {
      if (!settingsDialogApi?.isSettingsDialogOpen()) return;

      event.stopImmediatePropagation();
      settingsDialogApi.closeSettingsDialog();
      // Re-push the entry the Back press consumed, so the view underneath stays
      // where it was rather than having been silently popped.
      history.pushState(history.state, "");
    },
    true,
  );

  // Prevent global browser zoom (Ctrl+Wheel and Pinch-to-Zoom on trackpad)
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  // Prevent global keyboard zoom (Ctrl + / -)
  window.addEventListener("keydown", (e) => {
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "_")
    ) {
      e.preventDefault();
    }
  });

  // Prevent global gesture zooming (Safari/iOS)
  window.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
  window.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });

  // Prevent pinch-to-zoom on touch devices (Android/Chrome)
  window.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  // Prevent context menu in production builds (allow in dev for debugging).
  // In the NC build, #app is embedded in the larger Nextcloud page — only
  // suppress it inside our own app area so the rest of NC keeps its native
  // browser context menu (e.g. right-click "open in new tab" on other apps).
  if (import.meta.env.PROD) {
    window.addEventListener("contextmenu", (e) => {
      if (IS_NEXTCLOUD && !e.target.closest("#app")) return;
      e.preventDefault();
    });
  }
}

// Initialize app when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Export for debugging
window.__noteberg = app;
