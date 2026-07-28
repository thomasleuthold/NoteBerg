/**
 * Router Module
 * Simple view mode routing (overview, notebook, settings, recyclebin)
 */

const MODES = ["overview", "notebook", "settings", "recyclebin"];
const DEFAULT_MODE = "overview";

/**
 * History integration exists to stop Android's hardware Back from exiting the
 * app (see pushHistoryEntry). It is deliberately OFF in the Nextcloud build:
 * there the app is embedded in Nextcloud's own page, whose URL and history
 * belong to NC. Pushing our entries there would make the browser Back button
 * step through our internal views instead of leaving the app, hijacking
 * navigation the host page owns.
 */
const HISTORY_ENABLED = import.meta.env.VITE_PLATFORM !== "nextcloud";

let currentMode = DEFAULT_MODE;
let currentNoteId = null;
let currentNotebookId = null;

/**
 * True while we are navigating *because* of a popstate event. Suppresses the
 * pushState inside navigateTo, which would otherwise re-add the entry the user
 * just popped and make Back a no-op that never unwinds.
 */
let isPoppingState = false;

/**
 * Android's hardware Back is handled by WryActivity.onKeyDown, which calls
 * mWebView.goBack() only when mWebView.canGoBack() is true — otherwise it falls
 * through to super and finishes the Activity, i.e. exits the app. A SPA that
 * never touches history has exactly one entry, so canGoBack() is always false
 * and Back always exits, even from inside a note.
 *
 * Pushing a history entry per navigation gives the WebView real entries to go
 * back through, so Back unwinds note → notebook → overview and only exits from
 * the root. No Kotlin change is needed (and WryActivity.kt is generated code
 * that must not be edited).
 */
function pushHistoryEntry(mode, params) {
  if (!HISTORY_ENABLED) return;
  if (isPoppingState) return;
  if (typeof history === "undefined" || typeof history.pushState !== "function") return;

  const state = { nbMode: mode, nbParams: params };

  // The very first navigation replaces the initial entry rather than adding a
  // second one — otherwise the root overview would need two Back presses to
  // leave the app.
  if (history.state?.nbMode === undefined) {
    history.replaceState(state, "");
    return;
  }

  history.pushState(state, "");
}

function handlePopState(event) {
  const state = event.state;
  // Not one of ours (e.g. an entry owned by the host page) — leave it alone.
  if (!state || state.nbMode === undefined) return;

  isPoppingState = true;
  try {
    navigateTo(state.nbMode, state.nbParams || {});
  } finally {
    isPoppingState = false;
  }
}

// Bound once at module load, not in initRouter(): initRouter can be called more
// than once, and each call would otherwise add another listener that drives its
// own navigation per Back press. removeEventListener before add would not help
// across module reloads, since it can only remove *this* instance's handler.
if (HISTORY_ENABLED && typeof window !== "undefined") {
  window.addEventListener("popstate", handlePopState);
}

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

  // Settings deliberately does NOT clear note/notebook context: it renders as a
  // dialog over the current view, so the open note stays mounted underneath and
  // must still be the current note when the dialog closes.
  if (mode === "recyclebin") {
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

  // Record the destination so Android's hardware Back can unwind through the
  // app instead of exiting it. Must happen before the render events fire, so a
  // listener that navigates again stacks its entry on top of this one.
  pushHistoryEntry(mode, params);

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
