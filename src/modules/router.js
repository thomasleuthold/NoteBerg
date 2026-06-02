/**
 * Router Module
 * Simple view mode routing (overview, notebook, settings, recyclebin)
 */

const MODES = ["overview", "notebook", "settings", "recyclebin"];
const DEFAULT_MODE = "overview";

let currentMode = DEFAULT_MODE;
let currentNoteId = null;
let currentNotebookId = null;

/**
 * Initialize router
 */
export function initRouter() {
  currentMode = DEFAULT_MODE;
  navigateTo(DEFAULT_MODE);
  console.log("Router initialized");
}

/**
 * Navigate to a specific mode
 * @param {string} mode - Mode to navigate to ('overview', 'notebook', 'settings')
 * @param {object} params - Optional parameters (e.g., { noteId: '123' })
 */
export function navigateTo(mode, params = {}) {
  if (!MODES.includes(mode)) {
    console.warn(`Invalid mode: ${mode}. Using ${DEFAULT_MODE}`);
    mode = DEFAULT_MODE;
  }

  const previousMode = currentMode;
  currentMode = mode;

  // Clear notebook/note context when navigating to overview, settings, or recycle bin
  if (mode === "settings" || mode === "recyclebin") {
    currentNotebookId = null;
    currentNoteId = null;
  } else if (mode === "overview") {
    currentNoteId = null;
    // Only clear notebook ID if not provided in params (root overview)
    if (params.notebookId !== undefined) {
      currentNotebookId = params.notebookId;
    } else {
      currentNotebookId = null;
    }
  } else {
    // Store params for notebook/note modes
    if (params.noteId !== undefined) {
      currentNoteId = params.noteId;
    }
    if (params.notebookId !== undefined) {
      currentNotebookId = params.notebookId;
    }
  }

  // Dispatch before-navigate event while the current view is still visible.
  // Listeners can do synchronous DOM reads (e.g. getBoundingClientRect) here.
  window.dispatchEvent(
    new CustomEvent("beforenavigate", {
      detail: { mode, params, previousMode },
    }),
  );

  // Update UI (hides the previous view)
  updateView(mode, params);

  // Dispatch navigation event
  window.dispatchEvent(
    new CustomEvent("navigate", {
      detail: { mode, params, previousMode },
    }),
  );

  console.log(`Navigated to: ${mode}`, params);
}

/**
 * Update the view based on current mode
 * @param {string} mode - Current mode
 * @param {object} params - Navigation parameters
 */
function updateView(mode, params) {
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return;

  // Hide all mode containers
  const modeContainers = mainContent.querySelectorAll("[data-mode]");
  modeContainers.forEach((container) => {
    container.classList.add("hidden");
  });

  // Show current mode container
  let modeContainer = mainContent.querySelector(`[data-mode="${mode}"]`);

  if (!modeContainer) {
    // Create mode container if it doesn't exist
    modeContainer = document.createElement("div");
    modeContainer.setAttribute("data-mode", mode);
    modeContainer.className = `mode-container ${mode}-mode`;
    mainContent.appendChild(modeContainer);
  }

  modeContainer.classList.remove("hidden");

  // Update content based on mode
  switch (mode) {
    case "overview":
      renderOverview(modeContainer);
      break;
    case "notebook":
      renderNotebook(modeContainer, params);
      break;
    case "settings":
      renderSettings(modeContainer);
      break;
    case "recyclebin":
      renderRecycleBin(modeContainer);
      break;
  }
}

/**
 * Render overview mode
 */
function renderOverview(container, params = {}) {
  // Create the overview content container
  container.innerHTML = '<div id="overview-content" class="overview-content"></div>';

  // Dispatch event for overview component to render itself
  const notebookId = params.notebookId || currentNotebookId;
  window.dispatchEvent(new CustomEvent("renderoverview", { detail: { notebookId } }));
}

/**
 * Render notebook mode
 */
function renderNotebook(container, params) {
  const noteId = params.noteId || currentNoteId;
  const notebookId = params.notebookId || currentNotebookId;
  const { taskId, searchQuery } = params;

  container.innerHTML = `
    <div class="notebook-container">
      <div id="notebook-editor-container"></div>
    </div>
  `;

  // Dispatch event to initialize editor
  window.dispatchEvent(
    new CustomEvent("rendernotebook", {
      detail: { noteId, notebookId, taskId, searchQuery },
    }),
  );
}

/**
 * Render settings mode
 */
function renderSettings(container) {
  // This will be populated by the settings component
  container.innerHTML = `
    <div class="settings-container">
      <div id="settings-content"></div>
    </div>
  `;

  // Trigger settings render event
  window.dispatchEvent(new CustomEvent("rendersettings"));
}

/**
 * Render recycle bin mode
 */
function renderRecycleBin(container) {
  // This will be populated by the recycle bin component
  container.innerHTML = `
    <div class="recycle-bin-wrapper">
      <div id="recycle-bin-content"></div>
    </div>
  `;

  // Trigger recycle bin render event
  window.dispatchEvent(new CustomEvent("renderrecyclebin"));
}

/**
 * Get current mode
 * @returns {string} Current mode
 */
export function getCurrentMode() {
  return currentMode;
}

/**
 * Get current note ID (if in notebook mode)
 * @returns {string|null} Current note ID
 */
export function getCurrentNoteId() {
  return currentNoteId;
}

/**
 * Get current notebook ID (if viewing a notebook)
 * @returns {string|null} Current notebook ID
 */
export function getCurrentNotebookId() {
  return currentNotebookId;
}

/**
 * Go back to previous mode (typically overview)
 */
export function goBack() {
  navigateTo("overview");
}
