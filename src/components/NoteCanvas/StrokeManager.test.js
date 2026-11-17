import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrokeManager } from "./StrokeManager.js";

// Mock Worker
class MockWorker {
  constructor() {
    this.onmessage = null;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    this.listeners = [];
  }

  addEventListener(_type, listener) {
    this.listeners.push(listener);
  }

  /** The worker answers. */
  answer(data) {
    for (const listener of this.listeners) listener({ data });
  }
}
globalThis.Worker = MockWorker;

// Mock dependencies
vi.mock("../../modules/masterPassword.js", () => ({
  getEncryptionKey: vi.fn(() => "mock-key"),
  isAppUnlocked: vi.fn(() => true),
}));

const updateNote = vi.fn();
vi.mock("../../modules/storage.js", () => ({
  generateId: vi.fn(() => "mock-id"),
  updateNote: (...args) => updateNote(...args),
}));

import { getEncryptionKey, isAppUnlocked } from "../../modules/masterPassword.js";

describe("StrokeManager", () => {
  let strokeManager;
  const noteId = "test-note";

  beforeEach(() => {
    strokeManager = new StrokeManager(noteId);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Review P4, 4.9: posting every stroke on every pen lift stalled writing on a
  // large note. A save carries only what storage has not confirmed yet.
  describe("only what storage has not confirmed", () => {
    const draw = (x) => {
      strokeManager.startStroke({ x, y: 1, pressure: 0.5 });
      return strokeManager.endStroke();
    };
    const lastSave = () =>
      strokeManager.worker.postMessage.mock.calls
        .filter(([m]) => m.type === "SAVE_STROKES")
        .at(-1)[0];

    beforeEach(() => {
      let n = 0;
      // Distinct ids for distinct strokes
      strokeManager.startStroke = ((start) => (props) => {
        const stroke = start.call(strokeManager, props);
        stroke.id = `s${++n}`;
        return stroke;
      })(strokeManager.startStroke);
    });

    it("sends the stroke just drawn, not the ones storage confirmed", () => {
      draw(1);
      strokeManager.worker.answer({ type: "STROKES_SAVED", requestId: lastSave().requestId });
      draw(2);
      expect(lastSave().strokes.map((s) => s.id)).toEqual(["s2"]);
    });

    it("sends a stroke again until storage confirms it (a failed save is repaired)", () => {
      draw(1);
      // No answer: that save may have failed
      draw(2);
      expect(lastSave().strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
    });

    it("sends a confirmed stroke again once it changed (moved, recoloured)", () => {
      const stroke = draw(1);
      strokeManager.worker.answer({ type: "STROKES_SAVED", requestId: lastSave().requestId });
      const stored = strokeManager.strokes.find((s) => s.id === stroke.id);
      stored.v = "changed";
      strokeManager.markDirty();
      strokeManager.forceSave();
      expect(lastSave().strokes.map((s) => s.id)).toEqual(["s1"]);
    });

    it("sends erased strokes as ids only", () => {
      draw(1);
      strokeManager.worker.answer({ type: "STROKES_SAVED", requestId: lastSave().requestId });
      strokeManager.strokes[0]._deleted = true;
      strokeManager.deletedStrokes.push("s1");
      strokeManager.markDirty();
      strokeManager.forceSave();
      expect(lastSave().strokes).toEqual([]);
      expect(lastSave().deletedStrokes).toEqual(["s1"]);
    });

    it("does not send strokes the editor was opened with", () => {
      strokeManager = new StrokeManager(noteId, [{ id: "old", x: [1], y: [1] }]);
      strokeManager.markDirty();
      strokeManager.forceSave();
      expect(lastSave().strokes).toEqual([]);
    });
  });

  // DESIGN §10.7: every save stamps the user's edits and carries the note's
  // version bookkeeping, so storage merges by element
  describe("version bookkeeping on saves", () => {
    const bookkeeping = { tombstones: { gone: "t1" }, shifts: [] };

    it("asks the editor for it before saving strokes, and sends it", () => {
      strokeManager.beforeSave = vi.fn(() => bookkeeping);
      strokeManager.startStroke({ x: 1, y: 1, pressure: 0.5 });
      strokeManager.endStroke();
      expect(strokeManager.beforeSave).toHaveBeenCalledWith("strokes");
      expect(strokeManager.worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SAVE_STROKES", versionFields: bookkeeping }),
      );
    });

    it("sends it with media, recordings and pen preset saves", () => {
      strokeManager.beforeSave = vi.fn(() => bookkeeping);
      strokeManager.saveMedia({ media: [], deletedMedia: [], pdfSource: null });
      strokeManager.saveRecordings({ recordings: [], deletedRecordings: [] });
      strokeManager.savePresets([]);
      expect(strokeManager.beforeSave.mock.calls.map((c) => c[0])).toEqual([
        "media",
        "recordings",
        "penPresets",
      ]);
      for (const call of strokeManager.worker.postMessage.mock.calls) {
        expect(call[0].versionFields).toBe(bookkeeping);
      }
    });
  });

  it("starts a stroke", () => {
    const props = { x: 10, y: 10, pressure: 0.5, pointerType: "pen" };
    const stroke = strokeManager.startStroke(props);

    expect(stroke).toMatchObject({
      x: [10],
      y: [10],
      pressure: [0.5],
      pointerType: "pen",
    });
    expect(strokeManager.currentStroke).toBe(stroke);
  });

  it("adds points to current stroke", () => {
    strokeManager.startStroke({ x: 10, y: 10, pressure: 0.5 });
    const points = [{ x: 20, y: 20, pressure: 0.6, time: 100 }];

    strokeManager.addPoints(points);

    expect(strokeManager.currentStroke.x).toEqual([10, 20]);
    expect(strokeManager.currentStroke.y).toEqual([10, 20]);
  });

  it("ends stroke and saves", () => {
    strokeManager.startStroke({ x: 10, y: 10, pressure: 0.5 });
    strokeManager.addPoints([{ x: 20, y: 20, pressure: 0.6 }]);

    const stroke = strokeManager.endStroke();

    expect(strokeManager.strokes).toHaveLength(1);
    expect(strokeManager.strokes[0]).toBe(stroke);
    expect(strokeManager.currentStroke).toBeNull();

    // Check worker message
    expect(strokeManager.worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SAVE_STROKES",
        noteId: noteId,
        strokes: expect.any(Array),
        key: "mock-key",
      }),
    );
  });

  it("cancels current stroke", () => {
    strokeManager.startStroke({ x: 10, y: 10 });
    strokeManager.cancelCurrentStroke();
    expect(strokeManager.currentStroke).toBeNull();
    expect(strokeManager.strokes).toHaveLength(0);
  });

  it("endStroke does not save when there is no current stroke", () => {
    strokeManager.endStroke();
    expect(strokeManager.strokes).toHaveLength(0);
    expect(strokeManager.worker.postMessage).not.toHaveBeenCalled();
  });

  it("markDirty sets isDirty without saving", () => {
    expect(strokeManager.isDirty).toBe(false);
    strokeManager.markDirty();
    expect(strokeManager.isDirty).toBe(true);
    expect(strokeManager.worker.postMessage).not.toHaveBeenCalled();
  });

  it("_save filters out deleted strokes before posting to the worker", () => {
    strokeManager.strokes = [
      { id: "a", _deleted: false },
      { id: "b", _deleted: true },
    ];
    strokeManager.markDirty();
    strokeManager.forceSave();

    const call = strokeManager.worker.postMessage.mock.calls.find(
      ([msg]) => msg.type === "SAVE_STROKES",
    );
    expect(call[0].strokes).toEqual([{ id: "a", _deleted: false }]);
  });

  it("_save is a no-op (does not post) when not dirty", () => {
    strokeManager.forceSave(); // isDirty is false by default
    expect(strokeManager.worker.postMessage).not.toHaveBeenCalled();
  });

  it("_save omits the encryption key when the app is locked", () => {
    isAppUnlocked.mockReturnValue(false);
    strokeManager.markDirty();
    strokeManager.forceSave();

    const call = strokeManager.worker.postMessage.mock.calls.find(
      ([msg]) => msg.type === "SAVE_STROKES",
    );
    expect(call[0].key).toBeNull();
    isAppUnlocked.mockReturnValue(true);
  });

  it("_save omits the key and logs a warning when getEncryptionKey throws", () => {
    getEncryptionKey.mockImplementationOnce(() => {
      throw new Error("locked mid-flight");
    });
    strokeManager.markDirty();
    strokeManager.forceSave();

    const call = strokeManager.worker.postMessage.mock.calls.find(
      ([msg]) => msg.type === "SAVE_STROKES",
    );
    expect(call[0].key).toBeNull();
  });

  it("forceSave triggers a save even when called directly (non-Nextcloud build)", () => {
    strokeManager.markDirty();
    strokeManager.forceSave();
    expect(strokeManager.worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SAVE_STROKES" }),
    );
    expect(strokeManager.isDirty).toBe(false);
  });

  it("saveMedia posts a SAVE_MEDIA message with the encryption key", () => {
    strokeManager.saveMedia({ media: [{ id: "m1" }], deletedMedia: ["m2"], pdfSource: "f1" });
    expect(strokeManager.worker.postMessage).toHaveBeenCalledWith({
      type: "SAVE_MEDIA",
      noteId,
      media: [{ id: "m1" }],
      deletedMedia: ["m2"],
      pdfSource: "f1",
      key: "mock-key",
    });
  });

  it("savePresets posts a SAVE_PRESETS message via the worker (non-Nextcloud build)", () => {
    strokeManager.savePresets([{ color: "#000" }]);
    expect(strokeManager.worker.postMessage).toHaveBeenCalledWith({
      type: "SAVE_PRESETS",
      noteId,
      presets: [{ color: "#000" }],
      key: "mock-key",
    });
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("saveRecordings posts a SAVE_RECORDINGS message via the worker", () => {
    strokeManager.saveRecordings({ recordings: [{ id: "r1" }], deletedRecordings: ["f1"] });
    expect(strokeManager.worker.postMessage).toHaveBeenCalledWith({
      type: "SAVE_RECORDINGS",
      noteId,
      recordings: [{ id: "r1" }],
      deletedRecordings: ["f1"],
      key: "mock-key",
    });
  });

  it("saveRecordings is a no-op when there is no worker", () => {
    strokeManager.worker = null;
    expect(() =>
      strokeManager.saveRecordings({ recordings: [], deletedRecordings: [] }),
    ).not.toThrow();
  });

  it("destroy sends a CLOSE message and clears the worker reference", () => {
    const worker = strokeManager.worker;
    strokeManager.destroy();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "CLOSE" });
    expect(strokeManager.worker).toBeNull();
  });

  it("destroy is a no-op when there is no worker", () => {
    strokeManager.worker = null;
    expect(() => strokeManager.destroy()).not.toThrow();
  });
});

// NOTE: This file only covers the default (Tauri/desktop) build, where
// IS_NEXTCLOUD is always false under `npm test` (import.meta.env.VITE_PLATFORM
// is undefined here). The Nextcloud-build branches (forceSave/savePresets
// calling updateNote() directly, and the constructor skipping Worker
// creation) are covered separately in StrokeManager.nextcloud.test.js, run
// via `npm run test:nextcloud`.

describe("StrokeManager - read-only", () => {
  let manager;

  beforeEach(() => {
    manager = new StrokeManager("shared-note");
    manager.readOnly = true;
    manager.worker.postMessage.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it("never posts a save to the worker", () => {
    manager.isDirty = true;
    manager._save();
    manager.saveMedia({ media: [], deletedMedia: [], pdfSource: null });
    manager.savePresets([]);
    manager.saveRecordings({ recordings: [], deletedRecordings: [] });

    expect(manager.worker.postMessage).not.toHaveBeenCalled();
  });

  it("settles on forceSave without writing", async () => {
    manager.isDirty = true;
    await expect(manager.forceSave()).resolves.toBeUndefined();
    expect(manager.worker.postMessage).not.toHaveBeenCalled();
  });

  it("saves again once it is no longer read-only", () => {
    manager.readOnly = false;
    manager.isDirty = true;
    manager._save();
    expect(manager.worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SAVE_STROKES" }),
    );
  });
});
