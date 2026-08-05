/**
 * src/components/NoteCanvas/StrokeManager.nextcloud.test.js
 *
 * Exercises StrokeManager.js's Nextcloud-build branches (IS_NEXTCLOUD = true),
 * which are unreachable under the default `npm test` because
 * import.meta.env.VITE_PLATFORM is undefined there. Run this file via
 * `npm run test:nextcloud` (vitest.config.nextcloud.js), a standalone Vitest
 * config that defines VITE_PLATFORM=nextcloud and aliases
 * ../../modules/storage.js to storage.webdav.js — matching the real
 * Nextcloud build's vite.config.js. It intentionally is NOT merged into
 * vitest.config.js via `test.projects`: that was tried first and caused the
 * `define` to leak into the default project's transform for shared source
 * files (see vitest.config.nextcloud.js for details).
 *
 * Covers: constructor skips Worker creation entirely; forceSave writes through
 * the coalescing writer (and flushes pending writes when not dirty), and
 * savePresets calls updateNote() (WebDAV) directly instead of posting to the
 * worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Worker so if the constructor DID create one (i.e. the platform gating
// broke), the test fails loudly via the "does not construct a Worker" case
// below rather than crashing on a missing global.
class MockWorker {
  constructor() {
    this.onmessage = null;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
  }
}
const WorkerCtorSpy = vi.fn(function (...args) {
  return new MockWorker(...args);
});
globalThis.Worker = WorkerCtorSpy;

vi.mock("../../modules/masterPassword.js", () => ({
  getEncryptionKey: vi.fn(() => "mock-key"),
  isAppUnlocked: vi.fn(() => true),
}));

// storage.js resolves to storage.webdav.js under the "nextcloud" project
// (see the resolve.alias in vitest.config.js), so this mock target is the
// real NC import path, not a redirect we're choosing in the test.
const updateNote = vi.fn();
const updateNoteCoalesced = vi.fn();
const flushNoteWrites = vi.fn();
vi.mock("../../modules/storage.js", () => ({
  generateId: vi.fn(() => "mock-id"),
  updateNote: (...args) => updateNote(...args),
  // Stroke saves go through the coalescing writer: they are re-sent in full on
  // every call, so a snapshot not yet started is safely replaced by a newer one.
  updateNoteCoalesced: (...args) => updateNoteCoalesced(...args),
  flushNoteWrites: (...args) => flushNoteWrites(...args),
}));

describe("StrokeManager (Nextcloud build)", () => {
  let StrokeManager;
  let strokeManager;
  const noteId = "test-note";

  beforeEach(async () => {
    vi.clearAllMocks();
    WorkerCtorSpy.mockClear();
    updateNote.mockResolvedValue(undefined);
    updateNoteCoalesced.mockResolvedValue(undefined);
    flushNoteWrites.mockResolvedValue(undefined);
    ({ StrokeManager } = await import("./StrokeManager.js"));
    strokeManager = new StrokeManager(noteId);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not construct a Worker (NC has no worker-based storage layer)", () => {
    expect(WorkerCtorSpy).not.toHaveBeenCalled();
    expect(strokeManager.worker).toBeUndefined();
  });

  it("still builds strokes locally via startStroke/addPoints/endStroke", () => {
    strokeManager.startStroke({ x: 10, y: 10, pressure: 0.5 });
    strokeManager.addPoints([{ x: 20, y: 20, pressure: 0.6, time: 100 }]);
    const stroke = strokeManager.endStroke();

    expect(strokeManager.strokes).toHaveLength(1);
    expect(stroke.x).toEqual([10, 20]);
  });

  it("endStroke marks dirty but does not throw despite no worker to save through", () => {
    strokeManager.startStroke({ x: 1, y: 1, pressure: 0.5 });
    expect(() => strokeManager.endStroke()).not.toThrow();
    expect(strokeManager.isDirty).toBe(true); // _save() is a no-op under NC; forceSave() does the real write
  });

  it("forceSave writes active strokes through the coalescing writer when dirty", async () => {
    strokeManager.strokes = [
      { id: "a", _deleted: false },
      { id: "b", _deleted: true },
    ];
    strokeManager.deletedStrokes = ["b"];
    strokeManager.markDirty();

    await strokeManager.forceSave();

    expect(updateNoteCoalesced).toHaveBeenCalledWith(noteId, {
      strokes: [{ id: "a", _deleted: false }],
      deletedStrokes: ["b"],
    });
    // Per-stroke writes must not use the plain writer: those queue serially and
    // never collapse, so drawing outpaces the network and the backlog grows.
    expect(updateNote).not.toHaveBeenCalled();
    expect(strokeManager.isDirty).toBe(false);
  });

  it("forceSave flushes pending writes instead of no-oping when not dirty", async () => {
    // Not dirty does NOT mean nothing to wait for: the newest snapshot may still
    // be in flight from an earlier stroke. destroy() awaits forceSave()'s return
    // value, so returning undefined here would drop the last strokes on close.
    const pending = strokeManager.forceSave();

    expect(flushNoteWrites).toHaveBeenCalledWith(noteId);
    expect(updateNoteCoalesced).not.toHaveBeenCalled();
    await expect(pending).resolves.toBeUndefined();
  });

  it("forceSave resolves (not rejects) when a pending flush fails", async () => {
    // destroy() feeds this promise into a Promise.all. A rejection would abort
    // the close sequence in index.js before it dispatches datachange and runs
    // syncOnNoteClose — so a failed flush must be logged, not propagated.
    flushNoteWrites.mockRejectedValueOnce(new Error("WebDAV flush failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(strokeManager.forceSave()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("forceSave resolves (not rejects) when the coalesced write fails", async () => {
    updateNoteCoalesced.mockRejectedValueOnce(new Error("WebDAV write failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    strokeManager.markDirty();
    await expect(strokeManager.forceSave()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("savePresets calls updateNote directly instead of posting to a worker", () => {
    strokeManager.savePresets([{ color: "#000" }]);
    expect(updateNote).toHaveBeenCalledWith(noteId, { penPresets: [{ color: "#000" }] });
  });

  it("savePresets logs but does not throw when updateNote rejects", async () => {
    updateNote.mockRejectedValueOnce(new Error("WebDAV write failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    strokeManager.savePresets([{ color: "#fff" }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("saveRecordings is a no-op since there is no worker under NC", () => {
    expect(() =>
      strokeManager.saveRecordings({ recordings: [{ id: "r1" }], deletedRecordings: [] }),
    ).not.toThrow();
  });

  it("saveMedia does not throw even though there is no worker to post to", () => {
    expect(() =>
      strokeManager.saveMedia({ media: [], deletedMedia: [], pdfSource: null }),
    ).not.toThrow();
  });

  it("destroy does not throw when there is no worker to close", () => {
    expect(() => strokeManager.destroy()).not.toThrow();
  });
});
