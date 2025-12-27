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
import "./styles/editor.css";
import "./styles/notebookEditor.css";

import { initModals } from "./components/modals.js";
import { initNotebookEditorComponent } from "./components/notebookEditor.js";
import { initOverview } from "./components/overviewMode.js";
import { initRecycleBin } from "./components/recycleBinMode.js";
import { initSettings } from "./components/settingsMode.js";
import { initBreadcrumb } from "./modules/breadcrumb.js";
import { initFooter } from "./modules/footer.js";
import { initRouter, navigateTo } from "./modules/router.js";
import { initStorage } from "./modules/storage.js";
// Import modules
import { initTheme } from "./modules/theme.js";

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

  // Initialize theme system
  await initTheme();

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
