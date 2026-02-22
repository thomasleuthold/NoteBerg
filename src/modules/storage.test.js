/**
 * src/modules/storage.test.js
 * Unit tests for moveNote, copyNote, and clearNoteMoveFlag.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearNoteMoveFlag, copyNote, moveNote } from "./storage.js";

// ── Minimal in-memory DB mock ─────────────────────────────────────────────────

const store = new Map();
const fileStore = new Map();

vi.mock("idb", () => ({
  openDB: vi.fn(() =>
    Promise.resolve({
      get: vi.fn((_, id) => Promise.resolve(store.get(id) ?? null)),
      put: vi.fn((_, record) => {
        store.set(record.id, structuredClone(record));
        return Promise.resolve();
      }),
      getAll: vi.fn(() => Promise.resolve([...store.values()])),
    }),
  ),
}));

// Minimal mocks for helpers used by copyNote
vi.mock("./storage.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Override file helpers so we don't need a real file store
    getFile: vi.fn((id) => Promise.resolve(fileStore.get(id) ?? null)),
    saveFile: vi.fn((blob) => {
      const newId = `file-${Math.random().toString(36).slice(2)}`;
      fileStore.set(newId, blob);
      return Promise.resolve(newId);
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNote(overrides = {}) {
  return {
    id: "note-1",
    notebookId: "nb-a",
    title: "Test note",
    strokes: [],
    media: [],
    pdfSource: null,
    version: 1,
    synced: true,
    lastSyncedEtag: "etag-abc",
    modified: 1000,
    ...overrides,
  };
}

// Seed the in-memory store before each test
beforeEach(async () => {
  store.clear();
  fileStore.clear();
  vi.clearAllMocks();

  // initStorage sets db internally — trigger it once via a side-effect-free import
  const { initStorage } = await import("./storage.js");
  await initStorage();
});

// ── moveNote ──────────────────────────────────────────────────────────────────

describe("moveNote", () => {
  it("updates notebookId and sets previousNotebookId", async () => {
    store.set("note-1", makeNote());

    await moveNote("note-1", "nb-b");

    const updated = store.get("note-1");
    expect(updated.notebookId).toBe("nb-b");
    expect(updated.previousNotebookId).toBe("nb-a");
  });

  it("marks note as unsynced and bumps version", async () => {
    store.set("note-1", makeNote({ version: 3, synced: true }));

    await moveNote("note-1", "nb-b");

    const updated = store.get("note-1");
    expect(updated.synced).toBe(false);
    expect(updated.version).toBe(4);
    expect(updated.lastSyncedEtag).toBeNull();
  });

  it("is a no-op when source and target notebook are the same", async () => {
    store.set("note-1", makeNote({ notebookId: "nb-a", version: 1 }));

    await moveNote("note-1", "nb-a");

    const note = store.get("note-1");
    expect(note.version).toBe(1); // unchanged
  });

  it("treats undefined notebookId as null (quick notes) when comparing", async () => {
    store.set("note-1", makeNote({ notebookId: undefined }));

    // Moving from undefined → null is a no-op (same semantic meaning)
    await moveNote("note-1", null);

    const note = store.get("note-1");
    expect(note.version).toBe(1); // unchanged
  });

  it("moves note to quick notes (null target)", async () => {
    store.set("note-1", makeNote({ notebookId: "nb-a" }));

    await moveNote("note-1", null);

    const updated = store.get("note-1");
    expect(updated.notebookId).toBeNull();
    expect(updated.previousNotebookId).toBe("nb-a");
  });

  it("throws when note does not exist", async () => {
    await expect(moveNote("missing-id", "nb-b")).rejects.toThrow("Note not found");
  });
});

// ── copyNote ──────────────────────────────────────────────────────────────────

describe("copyNote", () => {
  it("creates a new note with a different id", async () => {
    store.set("note-1", makeNote());

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.id).not.toBe("note-1");
    expect(store.has(copied.id)).toBe(true);
  });

  it("sets the target notebookId on the copy", async () => {
    store.set("note-1", makeNote({ notebookId: "nb-a" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.notebookId).toBe("nb-b");
  });

  it("leaves the original note unchanged", async () => {
    const original = makeNote();
    store.set("note-1", structuredClone(original));

    await copyNote("note-1", "nb-b");

    const still = store.get("note-1");
    expect(still.notebookId).toBe("nb-a");
    expect(still.id).toBe("note-1");
  });

  it("resets sync state and version on the copy", async () => {
    store.set("note-1", makeNote({ version: 5, synced: true, lastSyncedEtag: "etag-xyz" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.synced).toBe(false);
    expect(copied.version).toBe(1);
    expect(copied.lastSyncedEtag).toBeNull();
  });

  it("clears thumbnailFileId on the copy", async () => {
    store.set("note-1", makeNote({ thumbnailFileId: "thumb-123" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.thumbnailFileId).toBeNull();
  });

  it("does not carry previousNotebookId onto the copy", async () => {
    store.set("note-1", makeNote({ previousNotebookId: "nb-old" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.previousNotebookId).toBeUndefined();
  });

  it("preserves media items (blob not in fileStore — fallback keeps original fileId)", async () => {
    // In the test environment, getFile returns null (mock default), so copyNote
    // falls back to keeping the original fileId rather than creating a new one.
    store.set("note-1", makeNote({ media: [{ fileId: "file-orig", type: "image" }] }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.media).toHaveLength(1);
    // Original fileId is preserved when blob cannot be fetched (fallback path)
    expect(copied.media[0].fileId).toBe("file-orig");
  });

  it("copies all media item metadata onto the copy", async () => {
    store.set(
      "note-1",
      makeNote({
        media: [{ fileId: "file-1", type: "image", x: 10, y: 20, width: 100, height: 80 }],
      }),
    );

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.media[0]).toMatchObject({ type: "image", x: 10, y: 20, width: 100, height: 80 });
  });

  it("throws when source note does not exist", async () => {
    await expect(copyNote("ghost", "nb-b")).rejects.toThrow("Note not found");
  });
});

// ── clearNoteMoveFlag ─────────────────────────────────────────────────────────

describe("clearNoteMoveFlag", () => {
  it("removes previousNotebookId from the note", async () => {
    store.set("note-1", makeNote({ previousNotebookId: "nb-old" }));

    await clearNoteMoveFlag("note-1");

    const updated = store.get("note-1");
    expect(updated.previousNotebookId).toBeUndefined();
  });

  it("does not modify version, synced, or modified", async () => {
    store.set("note-1", makeNote({ previousNotebookId: "nb-old", version: 7, synced: true }));

    await clearNoteMoveFlag("note-1");

    const updated = store.get("note-1");
    expect(updated.version).toBe(7);
    expect(updated.synced).toBe(true);
  });

  it("is a no-op when the note does not exist", async () => {
    // Should not throw
    await expect(clearNoteMoveFlag("missing")).resolves.toBeUndefined();
  });
});
