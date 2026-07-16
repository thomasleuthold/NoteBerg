import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrokeManager } from "./StrokeManager.js";

// Mock Worker
class MockWorker {
  constructor() {
    this.onmessage = null;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
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
