import { openDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptObject } from "../../modules/encryption.js";

// Mock dependencies
vi.mock("idb", () => ({
  openDB: vi.fn(),
}));

vi.mock("../../modules/encryption.js", () => ({
  encryptObject: vi.fn(),
}));

vi.mock("../../modules/storage.js", () => ({
  DB_NAME: "test-db",
  DB_VERSION: 1,
}));

describe("StorageWorker", () => {
  let mockDb;
  let mockTx;
  let mockStore;
  let workerHandler;

  // Helper to wait for async worker processing
  const flushPromises = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock IndexedDB structure
    mockStore = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockTx = {
      objectStore: vi.fn(() => mockStore),
      done: Promise.resolve(),
    };
    mockDb = {
      get: vi.fn(),
      transaction: vi.fn(() => mockTx),
    };
    openDB.mockResolvedValue(mockDb);

    // Mock self.close and ensure self exists
    if (!globalThis.self) globalThis.self = {};
    globalThis.self.close = vi.fn();

    // Reset modules to ensure a fresh worker instance (and messageQueue) for each test
    vi.resetModules();

    // Import the worker to trigger onmessage assignment
    await import("./StorageWorker.js");
    workerHandler = self.onmessage;
  });

  it("should handle SAVE_STROKES", async () => {
    const note = { id: "note-1", strokes: [], version: 1 };
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: false });
    mockStore.get.mockResolvedValue(note);

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [{ id: "s1" }],
      deletedStrokes: ["s2"],
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockDb.get).toHaveBeenCalledWith("notes", "note-1");
    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-1",
        strokes: [{ id: "s1" }],
        deletedStrokes: ["s2"],
        version: 2,
        synced: false,
      }),
    );
  });

  it("should handle SAVE_STROKES with encryption", async () => {
    const note = { id: "note-1", strokes: [], version: 1 };
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: true });
    mockStore.get.mockResolvedValue(note);
    encryptObject.mockResolvedValue("encrypted-strokes");

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [{ id: "s1" }],
      key: "fake-key",
    };

    await workerHandler({ data });
    await flushPromises();

    expect(encryptObject).toHaveBeenCalledWith([{ id: "s1" }], "fake-key");
    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        strokes: "encrypted-strokes",
      }),
    );
  });

  it("should fail to save encrypted data if key is missing", async () => {
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: true });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [],
      // No key
    };

    await workerHandler({ data });
    await flushPromises();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot save encrypted note: Key missing"),
    );
    expect(mockStore.put).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("should handle SAVE_MEDIA", async () => {
    const note = { id: "note-1", media: [], version: 1 };
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: false });
    mockStore.get.mockResolvedValue(note);

    const data = {
      type: "SAVE_MEDIA",
      noteId: "note-1",
      media: [{ id: "m1" }],
      deletedMedia: ["m2"],
      pdfSource: "pdf1",
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ id: "m1" }],
        deletedMedia: ["m2"],
        pdfSource: "pdf1",
      }),
    );
  });

  it("should handle SAVE_PRESETS", async () => {
    const note = { id: "note-1", penPresets: [], version: 1 };
    mockStore.get.mockResolvedValue(note);

    const data = {
      type: "SAVE_PRESETS",
      noteId: "note-1",
      presets: [{ color: "red" }],
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        penPresets: [{ color: "red" }],
      }),
    );
  });

  it("should handle SAVE_THUMBNAIL", async () => {
    const note = { id: "note-1", version: 1 };
    mockStore.get.mockResolvedValue(note);

    const data = {
      type: "SAVE_THUMBNAIL",
      noteId: "note-1",
      thumbnailFileId: "thumb-1",
      thumbnailTimestamp: 123456,
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        thumbnailFileId: "thumb-1",
        thumbnailTimestamp: 123456,
      }),
    );
  });

  it("should handle SAVE_TASKS", async () => {
    const note = { id: "note-1", tasks: [], version: 1 };
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: false });
    mockStore.get.mockResolvedValue(note);

    const data = {
      type: "SAVE_TASKS",
      noteId: "note-1",
      tasks: [{ id: "t1" }],
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [{ id: "t1" }],
      }),
    );
  });

  it("should handle SAVE_CONTENT", async () => {
    const note = { id: "note-1", content: "", version: 1 };
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: false });
    mockStore.get.mockResolvedValue(note);

    const data = {
      type: "SAVE_CONTENT",
      noteId: "note-1",
      content: "<p>Hello</p>",
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "<p>Hello</p>",
      }),
    );
  });

  it("should handle CLOSE", async () => {
    const data = { type: "CLOSE" };
    await workerHandler({ data });
    await flushPromises();
    expect(self.close).toHaveBeenCalled();
  });
});
