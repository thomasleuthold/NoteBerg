/**
 * NoteCanvas Module - Entry point and component initialization
 *
 * This module provides the virtualized canvas rendering system for notes.
 * Supports smooth scrolling, zoom, and stylus/pen drawing.
 */

import { syncOnNoteClose } from "../../modules/autoSync.js";
import { NoteCanvas } from "./NoteCanvas.js";

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
    } catch (error) {
      console.error("[NoteCanvas] Failed to initialize:", error);

      // Show error message in container
      container.innerHTML = `
        <div class="note-canvas__error">
          <p class="note-canvas__error-title">Failed to load note</p>
          <p class="note-canvas__error-message">${error.message}</p>
        </div>
      `;
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
        // Thumbnail has been saved to DB by now — refresh the overview so it picks it up.
        window.dispatchEvent(new CustomEvent("datachange"));
        syncOnNoteClose(noteId, { forceSync: destroyResult?.mediaChanged === true });
      }
    }
  });

  // Listen for data changes to refresh if current note was updated externally
  window.addEventListener("datachange", async () => {
    if (!noteCanvasInstance || !noteCanvasInstance.noteId) return;

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

    if (container) {
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
