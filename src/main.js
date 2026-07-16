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
import { initFooter } from "./modules/footer.js";
import { initRouter, navigateTo } from "./modules/router.js";
import { initStorage } from "./modules/storage.js";
import { initTheme } from "./modules/theme.js";
import { getIcon } from "./utils/icons.js";
import { initLogger } from "./utils/logger.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

// Application state
const app = {
  initialized: false,
  currentNote: null,
};

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
  }

  // Initialize router
  const componentsStart = performance.now();
  initRouter();

  // Initialize components
  if (!IS_NEXTCLOUD) {
    const { initSettings } = await import("./components/settingsMode.js");
    initSettings();
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

  // Settings button (Tauri only — no settings panel in Nextcloud build)
  if (!IS_NEXTCLOUD) {
    const settingsBtn = document.getElementById("nav-settings");
    if (settingsBtn) {
      settingsBtn.innerHTML = getIcon("settings", 24);
      settingsBtn.addEventListener("click", () => navigateTo("settings"));
    }
  }

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
