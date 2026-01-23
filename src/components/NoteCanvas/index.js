/**
 * NoteCanvas Module - Entry point and component initialization
 *
 * This module provides the virtualized canvas rendering system for notes.
 * Supports smooth scrolling, zoom, and stylus/pen drawing.
 */

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
    const { noteId } = e.detail || {};

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

    // Clear container
    container.innerHTML = "";

    // Create and load new instance
    try {
      noteCanvasInstance = new NoteCanvas(container);
      await noteCanvasInstance.load(noteId);
      console.log("[NoteCanvas] Component initialized for note:", noteId);
    } catch (error) {
      console.error("[NoteCanvas] Failed to initialize:", error);

      // Show error message in container
      container.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-secondary);">
          <p>Failed to load note</p>
          <p style="font-size: 12px; margin-top: 8px;">${error.message}</p>
        </div>
      `;
    }
  });

  // Listen for navigation to clean up when leaving notebook mode
  window.addEventListener("navigate", (e) => {
    if (e.detail?.previousMode === "notebook" && noteCanvasInstance) {
      console.log("[NoteCanvas] Cleaning up on navigation away");
      noteCanvasInstance.destroy();
      noteCanvasInstance = null;
    }
  });

  // Listen for data changes to refresh if current note was updated externally
  window.addEventListener("datachange", async () => {
    if (!noteCanvasInstance || !noteCanvasInstance.noteId) return;

    // In Phase 1, we just reload the note on external changes
    // Future phases will implement smarter merging
    const noteId = noteCanvasInstance.noteId;
    const container = noteCanvasInstance.containerElement;

    if (container) {
      noteCanvasInstance.destroy();
      noteCanvasInstance = new NoteCanvas(container);
      await noteCanvasInstance.load(noteId);
      console.log("[NoteCanvas] Reloaded after external data change");
    }
  });

  console.log("[NoteCanvas] Component registered");
}

export { CanvasRenderer } from "./CanvasRenderer.js";
// Re-export classes for direct usage if needed
export { NoteCanvas } from "./NoteCanvas.js";
export { SpatialIndex } from "./SpatialIndex.js";
export { VirtualScroller } from "./VirtualScroller.js";
