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
 * Monotonic token identifying the most recently started rendernotebook.
 *
 * The handler clears the container and then awaits load(), so two renders in
 * quick succession (two navigations — e.g. a double-submitted create) used to
 * interleave: both instances finished loading and both appended themselves, but
 * only the later one was kept in noteCanvasInstance. The earlier became an
 * orphan — unreachable yet still live, holding its listeners, autosave timer and
 * worker handles, and still able to write to the DB. Each render captures the
 * token at entry and tears itself down if a newer one has begun.
 */
let renderToken = 0;

/**
 * Tear down an instance the app is finished with.
 *
 * destroy() is null-guarded throughout (textEditorLayer, strokeManager and the
 * rest are only touched when present), so it is safe on an instance whose load()
 * never completed — and calling it is necessary there, since a partial instance
 * can still hold a worker connection and half-built layers.
 */
function releaseInstance(instance) {
  if (!instance) return;
  instance.destroy();
}

/**
 * Remove the DOM a superseded render mounted into the shared container.
 *
 * destroy() tears down state and workers but deliberately leaves the DOM alone —
 * it relies on the next render clearing the container. That assumption breaks
 * when renders overlap, because the winner cleared the container *before* the
 * loser finished mounting, leaving two editors stacked in it.
 *
 * Only the instance that currently owns the container may clear it: if the
 * winning render has already mounted, wiping the container here would blank the
 * view. So this clears only while the winner is still loading — recognisable
 * because nothing has been mounted since (`noteCanvasInstance` is not yet
 * initialized). The winner clears the container itself before mounting, so any
 * leftovers in the other case are removed there.
 */
function clearSupersededMount(container) {
  if (noteCanvasInstance?.isInitialized) return;
  container.innerHTML = "";
}

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

    const myToken = ++renderToken;

    // Clean up previous instance if exists
    if (noteCanvasInstance) {
      releaseInstance(noteCanvasInstance);
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

    // Create and load new instance. Held locally as well as in the module slot:
    // if a newer render supersedes this one mid-load, the module slot already
    // belongs to that render and only this reference can still reach the
    // instance that has to be torn down.
    //
    // NoteCanvas mounts directly into the shared container (it sets the
    // container's own class and layout, so an intermediate wrapper would break
    // the flex chain from #notebook-editor-container). Ownership is therefore
    // tracked by token, and a superseded render clears only what it appended.
    let instance = null;
    try {
      instance = new NoteCanvas(container);
      noteCanvasInstance = instance;
      await instance.load(noteId, { searchQuery, taskId });

      if (myToken !== renderToken) {
        // A newer render started while this one was loading. Tear this instance
        // down rather than leaving it live and unreachable. Its DOM is left to
        // the winning render: if that render has already cleared the container
        // and mounted, this instance's nodes are gone with it; if it is still
        // loading, it will clear them before mounting.
        releaseInstance(instance);
        clearSupersededMount(container);
        return;
      }

      // First-ever note open on this device: show the 7-step toolbar tour.
      // No-op after the first time (flag persisted in localStorage). The second
      // load() call site below is a live re-render of an already-open note, not
      // a first open, so it is intentionally not hooked.
      startFirstNoteTour();
    } catch (error) {
      console.error("[NoteCanvas] Failed to initialize:", error);

      // A failed load that has already been superseded must not clear the newer
      // render's DOM, show its error over that render, or overwrite the module
      // slot with its own dead instance.
      if (myToken !== renderToken) {
        releaseInstance(instance);
        clearSupersededMount(container);
        return;
      }

      // The failed instance is never returned to, so drop it rather than leaving
      // it in the module slot where teardown paths would treat it as current.
      releaseInstance(instance);
      noteCanvasInstance = null;

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

  // Closing the tab/app does not run the "navigate" handler below, so a stroke
  // drawn moments earlier would never be written. visibilitychange→hidden is the
  // only teardown signal mobile browsers deliver reliably (beforeunload is not
  // fired when the OS kills a backgrounded tab), so flush there.
  //
  // Note this cannot await: the page may be gone before a promise settles. It
  // starts the write and relies on the browser keeping the in-flight request
  // alive, which is why an extra pause before closing still helps on a slow
  // connection. It is strictly better than the previous behaviour, where
  // nothing was started at all.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    noteCanvasInstance?.flushPendingSaves?.();
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

  // Listen for data changes to refresh if the open note was updated externally.
  //
  // NoteCanvas.handleExternalDataChange owns the decision (own-write filtering,
  // mid-drawing deferral, content-diff check) — it must not be duplicated here,
  // or a guard added to one path silently fails to apply to the other. This
  // listener only covers the case NoteCanvas cannot handle for itself: an
  // instance that exists but never finished loading has to be rebuilt.
  window.addEventListener("datachange", async () => {
    if (!noteCanvasInstance?.noteId) return;

    if (noteCanvasInstance.isInitialized) {
      // NoteCanvas has its own listener; it reloads itself.
      return;
    }

    const noteId = noteCanvasInstance.noteId;
    const container = noteCanvasInstance.containerElement;
    if (!container) return;

    if (!(await noteCanvasInstance.hasContentChanged(noteId))) return;

    // Re-check after the await — the instance may have been destroyed or
    // replaced (and a replacement may have initialized in the meantime).
    if (!noteCanvasInstance || noteCanvasInstance.noteId !== noteId) return;
    if (noteCanvasInstance.isInitialized) return;

    // This rebuild is a render in its own right, so it claims a token like any
    // other. Without one, a rendernotebook starting mid-rebuild would be
    // silently overwritten by the instance created here.
    const myToken = ++renderToken;

    releaseInstance(noteCanvasInstance);
    const instance = new NoteCanvas(container);
    noteCanvasInstance = instance;
    await instance.load(noteId);

    if (myToken !== renderToken) {
      // A rendernotebook started mid-rebuild and owns the container now.
      releaseInstance(instance);
      clearSupersededMount(container);
    }
  });
}

export { CanvasRenderer } from "./CanvasRenderer.js";
// Re-export classes for direct usage if needed
export { NoteCanvas } from "./NoteCanvas.js";
export { SpatialIndex } from "./SpatialIndex.js";
export { VirtualScroller } from "./VirtualScroller.js";
