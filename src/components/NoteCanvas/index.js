/**
 * NoteCanvas Module - Entry point and component initialization
 *
 * This module provides the virtualized canvas rendering system for notes.
 * Supports smooth scrolling, zoom, and stylus/pen drawing.
 */

import { syncOnNoteClose } from "../../modules/autoSync.js";
import { HELP_IDS } from "../../modules/helpGuidance.js";
import { startHelpTour } from "../HelpOverlay.js";
import { getHelpContent, getHelpLabels } from "../helpContent.js";
import { NoteCanvas } from "./NoteCanvas.js";

// First-note tour: a centered welcome step (auto-save/sync intro, no arrow),
// then a map of the toolbar in left-to-right order. The toolbar steps anchor to
// buttons by their stable DOM id (queried at tour start, after the toolbar has
// rendered); the welcome step has no target so it shows centered.
const FIRST_NOTE_TOOL_IDS = ["pan", "text", "draw", "eraser", "lasso", "options", "insert"];

function startFirstNoteTour() {
  const content = getHelpContent();
  const steps = [
    { target: null, title: content.welcome.title, body: content.welcome.body },
    ...FIRST_NOTE_TOOL_IDS.map((toolId) => ({
      target: document.getElementById(`nc-tool-${toolId}`),
      title: content[toolId].title,
      body: content[toolId].body,
    })),
  ];
  startHelpTour(HELP_IDS.FIRST_NOTE, steps, getHelpLabels());
}

// Module-level instance
let noteCanvasInstance = null;

/**
 * Initialize the NoteCanvas component
 * Sets up event listeners for router integration
 */
export function initNoteCanvasComponent() {
  // Listen for render notebook event from router
  window.addEventListener("rendernotebook", async (e) => {
    const { noteId, taskId } = e.detail || {};
    let { searchQuery } = e.detail || {};

    if (!noteId) {
      console.warn("[NoteCanvas] No note ID provided");
      return;
    }

    // Get the container
    const container = document.getElementById("notebook-editor-container");
    if (!container) {
      console.error("[NoteCanvas] Container not found");
      return;
    }

    // Clean up previous instance if exists
    if (noteCanvasInstance) {
      noteCanvasInstance.destroy();
      noteCanvasInstance = null;
    }

    // Fallback: check session storage for search query if not in event detail
    if (!searchQuery) {
      const storedQuery = sessionStorage.getItem("noteberg_search_query");
      if (storedQuery) {
        searchQuery = storedQuery;
        sessionStorage.removeItem("noteberg_search_query");
      }
    }

    // Clear container
    container.innerHTML = "";

    // Create and load new instance
    try {
      noteCanvasInstance = new NoteCanvas(container);
      await noteCanvasInstance.load(noteId, { searchQuery, taskId });
      // First-ever note open on this device: show the 7-step toolbar tour.
      // No-op after the first time (flag persisted in localStorage). The second
      // load() call site below is a live re-render of an already-open note, not
      // a first open, so it is intentionally not hooked.
      startFirstNoteTour();
    } catch (error) {
      console.error("[NoteCanvas] Failed to initialize:", error);

      // Show error message in container. Built via textContent (not innerHTML)
      // since error.message may echo untrusted data (e.g. a corrupted note field).
      container.innerHTML = "";
      const errorEl = document.createElement("div");
      errorEl.className = "note-canvas__error";
      const titleEl = document.createElement("p");
      titleEl.className = "note-canvas__error-title";
      titleEl.textContent = "Failed to load note";
      const messageEl = document.createElement("p");
      messageEl.className = "note-canvas__error-message";
      messageEl.textContent = error.message;
      errorEl.append(titleEl, messageEl);
      container.appendChild(errorEl);
    }
  });

  // Listen for navigation to clean up when leaving notebook mode
  window.addEventListener("navigate", async (e) => {
    if (e.detail?.previousMode === "notebook" && noteCanvasInstance) {
      const noteId = noteCanvasInstance.noteId;
      const destroyPromise = noteCanvasInstance.destroy();
      noteCanvasInstance = null;

      if (noteId) {
        const destroyResult = await destroyPromise;
        window.dispatchEvent(new CustomEvent("datachange"));
        syncOnNoteClose(noteId, { forceSync: destroyResult?.mediaChanged === true });
      }
    }
  });

  // Listen for data changes to refresh if current note was updated externally
  window.addEventListener("datachange", async () => {
    if (!noteCanvasInstance?.noteId) return;

    const noteId = noteCanvasInstance.noteId;
    const container = noteCanvasInstance.containerElement;

    // Check if content actually changed to avoid unnecessary reloads (e.g. on sync metadata update)
    // This prevents "vanishing strokes" when auto-sync updates the note status while drawing
    const changed = await noteCanvasInstance.hasContentChanged(noteId);
    if (!changed) {
      return;
    }

    // Re-check instance validity after async operation (could have been destroyed during await)
    if (!noteCanvasInstance || noteCanvasInstance.noteId !== noteId) {
      return;
    }

    if (noteCanvasInstance.isInitialized) {
      await noteCanvasInstance.applyLiveUpdate();
    } else if (container) {
      noteCanvasInstance.destroy();
      noteCanvasInstance = new NoteCanvas(container);
      await noteCanvasInstance.load(noteId);
    }
  });
}

export { CanvasRenderer } from "./CanvasRenderer.js";
// Re-export classes for direct usage if needed
export { NoteCanvas } from "./NoteCanvas.js";
export { SpatialIndex } from "./SpatialIndex.js";
export { VirtualScroller } from "./VirtualScroller.js";
