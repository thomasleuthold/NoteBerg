/**
 * src/components/NoteCanvas/index.test.js
 *
 * Wiring tests for the module-level `datachange` listener registered by
 * initNoteCanvasComponent().
 *
 * Regression guard for the Nextcloud undo bug: NoteCanvas.handleExternalDataChange
 * already filtered out our own writes (`source: "local"`), but this listener
 * carried a second, unguarded copy of the reload decision and called
 * applyLiveUpdate() — which clears the undo history — for *every* datachange,
 * including the ones storage.webdav.js dispatches for the app's own PUTs. The
 * undo button therefore went dead a moment after drawing.
 *
 * These tests deliberately mock NoteCanvas.js: the subject here is which
 * decisions index.js makes for itself versus delegates, not the canvas
 * internals (covered by NoteCanvas.test.js).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.js re-exports CanvasRenderer/SpatialIndex/VirtualScroller, which drags
// pdfjs-dist into the graph. jsdom has no DOMMatrix, so polyfill before import.
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    translate() {
      return this;
    }
    scale() {
      return this;
    }
    multiply() {
      return this;
    }
  };
}

vi.mock("./CanvasRenderer.js");
vi.mock("./SpatialIndex.js");
vi.mock("./VirtualScroller.js");

// Stubbed so the navigate handler does not pull the real sync stack into scope.
vi.mock("../../modules/autoSync.js", () => ({ syncOnNoteClose: vi.fn() }));

vi.mock("../HelpOverlay.js", () => ({ startHelpTour: vi.fn() }));
vi.mock("../helpContent.js", () => ({
  // The tour reads content[toolId] for each toolbar id; a Proxy keeps this
  // mock from having to track FIRST_NOTE_TOOL_IDS as the toolbar evolves.
  getHelpContent: vi.fn(() => new Proxy({}, { get: () => ({ title: "t", body: "b" }) })),
  getHelpLabels: vi.fn(() => ({})),
}));
vi.mock("../../modules/helpGuidance.js", () => ({ HELP_IDS: { FIRST_NOTE: "first-note" } }));

// One shared handle so each test can reach the instance index.js created.
let lastInstance = null;

vi.mock("./NoteCanvas.js", () => {
  class NoteCanvasMock {
    constructor(container) {
      this.containerElement = container;
      this.noteId = null;
      this.isInitialized = false;
      this.load = vi.fn(async (noteId) => {
        this.noteId = noteId;
        this.isInitialized = true;
      });
      this.destroy = vi.fn(() => ({ mediaChanged: false }));
      this.hasContentChanged = vi.fn(async () => true);
      this.applyLiveUpdate = vi.fn(async () => {});
      this.handleExternalDataChange = vi.fn(async () => false);
      this.flushPendingSaves = vi.fn();
      lastInstance = this;
    }
  }
  return { NoteCanvas: NoteCanvasMock };
});

/** Open a note through the real `rendernotebook` path index.js listens on. */
async function openNote(noteId = "n1") {
  window.dispatchEvent(new CustomEvent("rendernotebook", { detail: { noteId } }));
  // Two microtask drains: the handler awaits load() before returning.
  await Promise.resolve();
  await Promise.resolve();
  return lastInstance;
}

/** Dispatch a datachange and let the async listener settle. */
async function dispatchDataChange(detail) {
  window.dispatchEvent(new CustomEvent("datachange", detail ? { detail } : undefined));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("initNoteCanvasComponent — datachange wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    lastInstance = null;
    document.body.innerHTML = '<div id="notebook-editor-container"></div>';
    const { initNoteCanvasComponent } = await import("./index.js");
    initNoteCanvasComponent();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── The undo regression ─────────────────────────────────────────────────────

  it("does not reload the open note on our own local write", async () => {
    // storage.webdav.js stamps every PUT it makes with source: "local". In the
    // NC build strokes are only written on flush/close, so the in-memory copy is
    // routinely ahead of the server — hasContentChanged() reports a difference
    // and the old unguarded listener reloaded, wiping undo after every stroke.
    const canvas = await openNote("n1");

    await dispatchDataChange({ noteId: "n1", source: "local" });

    expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
  });

  it("leaves the reload decision to NoteCanvas once the instance is initialized", async () => {
    // The guards (own-write filtering, mid-drawing deferral, content diff) live
    // in handleExternalDataChange. Duplicating any of them here is what let a
    // fix applied to one path silently miss the other.
    const canvas = await openNote("n1");
    expect(canvas.isInitialized).toBe(true);

    await dispatchDataChange({ noteId: "n1", source: "local" });

    expect(canvas.hasContentChanged).not.toHaveBeenCalled();
    expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
    expect(canvas.destroy).not.toHaveBeenCalled();
  });

  it("does not rebuild an initialized instance on a detail-less sync event", async () => {
    // sync.js dispatches without a detail. That must not tear down and reload a
    // live canvas from here — NoteCanvas's own listener handles it.
    const canvas = await openNote("n1");

    await dispatchDataChange(undefined);

    expect(canvas.destroy).not.toHaveBeenCalled();
    expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
  });

  // ── The case index.js legitimately still owns ───────────────────────────────

  it("rebuilds an instance that exists but never finished loading", async () => {
    // A canvas mid-load cannot react to datachange itself (its listeners are not
    // wired yet), so index.js must rebuild it. This is the sole reason the
    // listener still exists.
    const stalled = await openNote("n1");
    stalled.isInitialized = false; // simulate load() still in flight

    await dispatchDataChange({ noteId: "n1" });

    expect(stalled.destroy).toHaveBeenCalled();
    expect(lastInstance).not.toBe(stalled);
    expect(lastInstance.load).toHaveBeenCalledWith("n1");
  });

  it("does not rebuild an uninitialized instance when only metadata changed", async () => {
    const stalled = await openNote("n1");
    stalled.isInitialized = false;
    stalled.hasContentChanged = vi.fn(async () => false);

    await dispatchDataChange({ noteId: "n1" });

    expect(stalled.destroy).not.toHaveBeenCalled();
    expect(lastInstance).toBe(stalled);
  });

  it("does not rebuild if the instance finished loading during the content check", async () => {
    // hasContentChanged() is awaited; load() can complete in that window. Acting
    // on the stale answer would destroy a canvas that is now live and drawable.
    const stalled = await openNote("n1");
    stalled.isInitialized = false;
    stalled.hasContentChanged = vi.fn(async () => {
      stalled.isInitialized = true;
      return true;
    });

    await dispatchDataChange({ noteId: "n1" });

    expect(stalled.destroy).not.toHaveBeenCalled();
    expect(lastInstance).toBe(stalled);
  });

  it("ignores datachange when no note is open", async () => {
    await expect(dispatchDataChange({ noteId: "n1", source: "local" })).resolves.toBeUndefined();
    expect(lastInstance).toBeNull();
  });
});
