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
  DB_VERSION: 4,
}));

describe("StorageWorker", () => {
  let mockDb;
  let mockTx;
  let mockNotesStore;
  let mockContentStore;
  let workerHandler;

  // Helper to wait for async worker processing
  const flushPromises = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Two separate stores: notes (index) and noteContent (payload)
    mockNotesStore = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockContentStore = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockTx = {
      objectStore: vi.fn((name) => {
        if (name === "noteContent") return mockContentStore;
        return mockNotesStore;
      }),
      done: Promise.resolve(),
    };
    mockDb = {
      get: vi.fn(),
      put: vi.fn(),
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
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", strokes: [], deletedStrokes: [] };

    // db.get returns note index (encrypted check)
    mockDb.get.mockResolvedValue(indexEntry);
    // tx stores return their respective records
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [{ id: "s1" }],
      deletedStrokes: ["s2"],
    };

    await workerHandler({ data });
    await flushPromises();

    // Index store gets version bump + synced=false + hasStrokes flag
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-1",
        version: 2,
        synced: false,
        hasStrokes: true,
      }),
    );
    // Content store gets strokes
    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-1",
        strokes: [{ id: "s1" }],
        deletedStrokes: ["s2"],
      }),
    );
  });

  it("should handle SAVE_STROKES with encryption", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: true };
    const contentEntry = { id: "note-1", strokes: [] };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });
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
    expect(mockContentStore.put).toHaveBeenCalledWith(
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
      expect.stringContaining("Cannot save encrypted strokes: Key missing"),
    );
    expect(mockNotesStore.put).not.toHaveBeenCalled();
    expect(mockContentStore.put).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("should handle SAVE_MEDIA", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", media: [], deletedMedia: [] };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_MEDIA",
      noteId: "note-1",
      media: [{ id: "m1", name: "photo.jpg", type: "image/jpeg", size: 100 }],
      deletedMedia: ["m2"],
      pdfSource: "pdf1",
    };

    await workerHandler({ data });
    await flushPromises();

    // Content store gets full media objects
    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ id: "m1", name: "photo.jpg", type: "image/jpeg", size: 100 }],
        deletedMedia: ["m2"],
        pdfSource: "pdf1",
      }),
    );
    // Index store gets metadata snapshot (id, name, type, size, deleted only)
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ id: "m1", name: "photo.jpg", type: "image/jpeg", size: 100, deleted: undefined }],
        version: 2,
        synced: false,
      }),
    );
  });

  it("should handle SAVE_PRESETS without bumping version or clearing synced", async () => {
    const contentEntry = { id: "note-1", penPresets: [] };
    mockDb.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_PRESETS",
      noteId: "note-1",
      presets: [{ color: "red" }],
    };

    await workerHandler({ data });
    await flushPromises();

    // Presets are UI preferences: only the content record is written.
    expect(mockDb.put).toHaveBeenCalledWith(
      "noteContent",
      expect.objectContaining({ penPresets: [{ color: "red" }] }),
    );
    // No index write — a preset-only change must not mark the note unsynced
    // (that used to re-upload the whole note JSON for a pen color change).
    expect(mockNotesStore.put).not.toHaveBeenCalled();
  });

  it("should handle SAVE_TASKS", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", tasks: [] };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_TASKS",
      noteId: "note-1",
      tasks: [{ id: "t1" }],
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [{ id: "t1" }],
      }),
    );
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, synced: false }),
    );
  });

  it("should handle SAVE_CONTENT", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", content: "" };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_CONTENT",
      noteId: "note-1",
      content: "<p>Hello</p>",
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "<p>Hello</p>",
      }),
    );
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, synced: false, hasContent: true }),
    );
  });

  it("should handle CLOSE", async () => {
    const data = { type: "CLOSE" };
    await workerHandler({ data });
    await flushPromises();
    expect(self.close).toHaveBeenCalled();
  });
});
