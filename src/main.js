/**
 * oneJournal - Main Application Entry Point
 */

// Import styles
import "./styles/main.css";
import "./styles/themes/light.css";
import "./styles/themes/dark.css";
import "./styles/themes/epaper.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/notebookEditor.css";

import { initModals } from "./components/modals.js";
import { initNotebookEditorComponent } from "./components/notebookEditor.js";
import { initOverview } from "./components/overviewMode.js";
import { initRecycleBin } from "./components/recycleBinMode.js";
import { initSettings } from "./components/settingsMode.js";
import { initializeApp, setupAppLockListener } from "./modules/appInit.js";
import { initAutoSync } from "./modules/autoSync.js";
import { initBreadcrumb } from "./modules/breadcrumb.js";
import { initFooter } from "./modules/footer.js";
import { migrateCredentials } from "./modules/nextcloudSync.js";
import { initRouter, navigateTo } from "./modules/router.js";
import { initStorage } from "./modules/storage.js";
// Import modules
import { initTheme } from "./modules/theme.js";
import { getIcon } from "./utils/icons.js";

// Application state
const app = {
  initialized: false,
  currentNote: null,
};

/**
 * Initialize the application
 */
async function init() {
  console.log("oneJournal initializing...");

  // Initialize storage (IndexedDB)
  await initStorage();

  // Initialize theme system (before master password modal for proper styling)
  await initTheme();

  // MASTER PASSWORD: Initialize and unlock app (shows modal if needed)
  // This MUST happen before any data access
  try {
    await initializeApp();
    setupAppLockListener();
  } catch (error) {
    console.error("Failed to initialize master password system:", error);
    // Show error to user
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
  // Note: This is the Phase 1 migration, not master password migration
  await migrateCredentials();

  // Initialize router
  initRouter();

  // Initialize components
  initSettings();
  initOverview();
  initModals();
  initRecycleBin();
  initNotebookEditorComponent();
  initBreadcrumb();
  initFooter();
  initAutoSync();

  // Set up event listeners
  setupEventListeners();

  // Navigate to overview by default
  navigateTo("overview");

  // Mark as initialized
  app.initialized = true;
  console.log("oneJournal ready!");
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

  // Settings button
  const settingsBtn = document.getElementById("nav-settings");
  if (settingsBtn) {
    // Inject settings icon
    settingsBtn.innerHTML = getIcon("settings", 24);
    settingsBtn.addEventListener("click", () => navigateTo("settings"));
  }
}

// Initialize app when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Export for debugging
window.__oneJournal = app;
