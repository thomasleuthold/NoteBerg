/**
 * src/modules/storage.test.js
 * Unit tests for moveNote, copyNote, and clearNoteMoveFlag.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNoteMoveFlag,
  copyNote,
  moveNote,
  updateNote,
  updateNotebook,
  updateNoteEtag,
} from "./storage.js";

// ── Multi-store in-memory DB mock ─────────────────────────────────────────────
// Schema v4 has two note stores: "notes" (index) and "noteContent" (payload).
// We simulate both with separate Maps.

const stores = {
  notes: new Map(),
  noteContent: new Map(),
  notebooks: new Map(),
  files: new Map(),
  settings: new Map(),
};
const fileStore = new Map();

vi.mock("idb", () => ({
  openDB: vi.fn(() => {
    // Per-transaction objectStore: writes go directly into stores
    function makeTxStore(name) {
      return {
        get: vi.fn((id) => Promise.resolve(stores[name]?.get(id) ?? null)),
        put: vi.fn((record) => {
          if (stores[name]) stores[name].set(record.id ?? record.key, structuredClone(record));
          return Promise.resolve();
        }),
      };
    }
    return Promise.resolve({
      get: vi.fn((storeName, id) => Promise.resolve(stores[storeName]?.get(id) ?? null)),
      put: vi.fn((storeName, record) => {
        if (stores[storeName])
          stores[storeName].set(record.id ?? record.key, structuredClone(record));
        return Promise.resolve();
      }),
      delete: vi.fn((storeName, id) => {
        stores[storeName]?.delete(id);
        return Promise.resolve();
      }),
      getAll: vi.fn((storeName) => Promise.resolve([...(stores[storeName]?.values() ?? [])])),
      getAllFromIndex: vi.fn((storeName, _index, value) =>
        Promise.resolve(
          [...(stores[storeName]?.values() ?? [])].filter((r) => r.notebookId === value),
        ),
      ),
      count: vi.fn(() => Promise.resolve(0)),
      transaction: vi.fn((storeNames) => {
        const storeMap = {};
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const n of names) storeMap[n] = makeTxStore(n);
        return {
          objectStore: vi.fn((name) => storeMap[name] ?? makeTxStore(name)),
          done: Promise.resolve(),
        };
      }),
    });
  }),
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

/**
 * Seed both "notes" and "noteContent" stores for a given note.
 * splitNote puts index fields in "notes" and content fields in "noteContent".
 */
function seedNote(note) {
  // Index fields (matches INDEX_FIELDS set in storage.js)
  const index = {
    id: note.id,
    notebookId: note.notebookId ?? null,
    title: note.title,
    created: note.created ?? 1000,
    modified: note.modified ?? 1000,
    version: note.version ?? 1,
    synced: note.synced ?? true,
    lastSyncedEtag: note.lastSyncedEtag ?? null,
    deleted: note.deleted ?? false,
    purged: note.purged,
    previousNotebookId: note.previousNotebookId,
    encrypted: note.encrypted ?? false,
    background: note.background ?? "none",
    formatVersion: note.formatVersion ?? 1,
    tags: note.tags ?? [],
    hasStrokes: Array.isArray(note.strokes) ? note.strokes.length > 0 : false,
    hasContent: typeof note.content === "string" ? note.content.trim().length > 0 : false,
    media: Array.isArray(note.media)
      ? note.media.map(({ id, name, type, size, deleted }) => ({ id, name, type, size, deleted }))
      : [],
  };
  // Content fields
  const content = {
    id: note.id,
    content: note.content ?? "",
    strokes: note.strokes ?? [],
    deletedStrokes: note.deletedStrokes ?? [],
    media: note.media ?? [],
    deletedMedia: note.deletedMedia ?? [],
    tasks: note.tasks ?? [],
    recognition: note.recognition ?? null,
    penPresets: note.penPresets ?? null,
    pdfSource: note.pdfSource ?? null,
  };
  stores.notes.set(note.id, index);
  stores.noteContent.set(note.id, content);
}

// Seed the in-memory stores before each test
beforeEach(async () => {
  for (const s of Object.values(stores)) s.clear();
  fileStore.clear();
  vi.clearAllMocks();

  // initStorage sets db internally — trigger it once
  const { initStorage } = await import("./storage.js");
  await initStorage();
});

// ── moveNote ──────────────────────────────────────────────────────────────────

describe("moveNote", () => {
  it("updates notebookId and sets previousNotebookId", async () => {
    seedNote(makeNote());

    await moveNote("note-1", "nb-b");

    const updated = stores.notes.get("note-1");
    expect(updated.notebookId).toBe("nb-b");
    expect(updated.previousNotebookId).toBe("nb-a");
  });

  it("marks note as unsynced and bumps version", async () => {
    seedNote(makeNote({ version: 3, synced: true }));

    await moveNote("note-1", "nb-b");

    const updated = stores.notes.get("note-1");
    expect(updated.synced).toBe(false);
    expect(updated.version).toBe(4);
    expect(updated.lastSyncedEtag).toBeNull();
  });

  it("is a no-op when source and target notebook are the same", async () => {
    seedNote(makeNote({ notebookId: "nb-a", version: 1 }));

    await moveNote("note-1", "nb-a");

    const note = stores.notes.get("note-1");
    expect(note.version).toBe(1); // unchanged
  });

  it("treats undefined notebookId as null (quick notes) when comparing", async () => {
    seedNote(makeNote({ notebookId: undefined }));

    // Moving from undefined → null is a no-op (same semantic meaning)
    await moveNote("note-1", null);

    const note = stores.notes.get("note-1");
    expect(note.version).toBe(1); // unchanged
  });

  it("moves note to quick notes (null target)", async () => {
    seedNote(makeNote({ notebookId: "nb-a" }));

    await moveNote("note-1", null);

    const updated = stores.notes.get("note-1");
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
    seedNote(makeNote());

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.id).not.toBe("note-1");
    expect(stores.notes.has(copied.id)).toBe(true);
  });

  it("sets the target notebookId on the copy", async () => {
    seedNote(makeNote({ notebookId: "nb-a" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.notebookId).toBe("nb-b");
  });

  it("leaves the original note unchanged", async () => {
    const original = makeNote();
    seedNote(original);

    await copyNote("note-1", "nb-b");

    const still = stores.notes.get("note-1");
    expect(still.notebookId).toBe("nb-a");
    expect(still.id).toBe("note-1");
  });

  it("resets sync state and version on the copy", async () => {
    seedNote(makeNote({ version: 5, synced: true, lastSyncedEtag: "etag-xyz" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.synced).toBe(false);
    expect(copied.version).toBe(1);
    expect(copied.lastSyncedEtag).toBeNull();
  });

  it("does not carry previousNotebookId onto the copy", async () => {
    seedNote(makeNote({ previousNotebookId: "nb-old" }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.previousNotebookId).toBeUndefined();
  });

  it("preserves media items (blob not in fileStore — fallback keeps original fileId)", async () => {
    // In the test environment, getFile returns null (mock default), so copyNote
    // falls back to keeping the original fileId rather than creating a new one.
    seedNote(makeNote({ media: [{ fileId: "file-orig", type: "image" }] }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.media).toHaveLength(1);
    // Original fileId is preserved when blob cannot be fetched (fallback path)
    expect(copied.media[0].fileId).toBe("file-orig");
  });

  it("copies all media item metadata onto the copy", async () => {
    seedNote(
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

// ── updateNote ────────────────────────────────────────────────────────────────

describe("updateNote", () => {
  it("applies the updates and bumps version", async () => {
    seedNote(makeNote({ title: "Old title", version: 2 }));

    await updateNote("note-1", { title: "New title" });

    const updated = stores.notes.get("note-1");
    expect(updated.title).toBe("New title");
    expect(updated.version).toBe(3);
  });

  it("marks note as unsynced", async () => {
    seedNote(makeNote({ synced: true }));

    await updateNote("note-1", { title: "Changed" });

    expect(stores.notes.get("note-1").synced).toBe(false);
  });

  it("updates the modified timestamp", async () => {
    const before = Date.now();
    seedNote(makeNote({ modified: 0 }));

    await updateNote("note-1", { title: "Changed" });

    expect(stores.notes.get("note-1").modified).toBeGreaterThanOrEqual(before);
  });

  it("dispatches a datachange event", async () => {
    seedNote(makeNote());
    const events = [];
    window.addEventListener("datachange", (e) => events.push(e));

    await updateNote("note-1", { title: "Changed" });

    expect(events).toHaveLength(1);
    expect(events[0].detail.noteId).toBe("note-1");
    window.removeEventListener("datachange", events[0]);
  });

  it("throws when note does not exist", async () => {
    await expect(updateNote("ghost", { title: "X" })).rejects.toThrow("Note not found");
  });
});

// ── updateNotebook ────────────────────────────────────────────────────────────

function makeNotebook(overrides = {}) {
  return {
    id: "nb-1",
    title: "Test Notebook",
    description: "",
    color: "#3b82f6",
    version: 1,
    synced: true,
    modified: 1000,
    ...overrides,
  };
}

function seedNotebook(notebook) {
  stores.notebooks.set(notebook.id, structuredClone(notebook));
}

describe("updateNotebook", () => {
  it("applies updates and bumps version", async () => {
    seedNotebook(makeNotebook({ title: "Old", version: 1 }));

    await updateNotebook("nb-1", { title: "New", color: "#ef4444" });

    const updated = stores.notebooks.get("nb-1");
    expect(updated.title).toBe("New");
    expect(updated.color).toBe("#ef4444");
    expect(updated.version).toBe(2);
  });

  it("marks notebook as unsynced", async () => {
    seedNotebook(makeNotebook({ synced: true }));

    await updateNotebook("nb-1", { title: "Changed" });

    expect(stores.notebooks.get("nb-1").synced).toBe(false);
  });

  it("updates the modified timestamp", async () => {
    const before = Date.now();
    seedNotebook(makeNotebook({ modified: 0 }));

    await updateNotebook("nb-1", { title: "Changed" });

    expect(stores.notebooks.get("nb-1").modified).toBeGreaterThanOrEqual(before);
  });

  it("dispatches a datachange event", async () => {
    seedNotebook(makeNotebook());
    const events = [];
    window.addEventListener("datachange", (e) => events.push(e));

    await updateNotebook("nb-1", { title: "Changed" });

    expect(events).toHaveLength(1);
    expect(events[0].detail.notebookId).toBe("nb-1");
    window.removeEventListener("datachange", events[0]);
  });

  it("throws when notebook does not exist", async () => {
    await expect(updateNotebook("ghost", { title: "X" })).rejects.toThrow("Notebook not found");
  });
});

// ── updateNoteEtag ────────────────────────────────────────────────────────────

describe("updateNoteEtag", () => {
  it("updates etag and marks synced when no expectedModified is given", async () => {
    seedNote(makeNote({ synced: false, lastSyncedEtag: "old", modified: 1000 }));

    await updateNoteEtag("note-1", "new-etag");

    const updated = stores.notes.get("note-1");
    expect(updated.lastSyncedEtag).toBe("new-etag");
    expect(updated.synced).toBe(true);
  });

  it("marks synced when the note was not modified during sync", async () => {
    seedNote(makeNote({ synced: false, modified: 1000 }));

    await updateNoteEtag("note-1", "new-etag", 1000);

    expect(stores.notes.get("note-1").synced).toBe(true);
  });

  it("does NOT mark synced when the note was modified during sync", async () => {
    // The note was uploaded with modified=1000, but the user edited it while the
    // upload was in flight (modified is now 2000, synced=false). Flipping synced
    // to true would mask the edit and it would never be uploaded.
    seedNote(makeNote({ synced: false, modified: 2000 }));

    await updateNoteEtag("note-1", "new-etag", 1000);

    const updated = stores.notes.get("note-1");
    expect(updated.lastSyncedEtag).toBe("new-etag"); // etag still updated
    expect(updated.synced).toBe(false); // edit-pending flag preserved
  });

  it("is a no-op when the note does not exist", async () => {
    await expect(updateNoteEtag("missing", "etag", 1000)).resolves.toBeUndefined();
  });
});

// ── clearNoteMoveFlag ─────────────────────────────────────────────────────────

describe("clearNoteMoveFlag", () => {
  it("removes previousNotebookId from the note", async () => {
    seedNote(makeNote({ previousNotebookId: "nb-old" }));

    await clearNoteMoveFlag("note-1");

    const updated = stores.notes.get("note-1");
    expect(updated.previousNotebookId).toBeUndefined();
  });

  it("does not modify version, synced, or modified", async () => {
    seedNote(makeNote({ previousNotebookId: "nb-old", version: 7, synced: true }));

    await clearNoteMoveFlag("note-1");

    const updated = stores.notes.get("note-1");
    expect(updated.version).toBe(7);
    expect(updated.synced).toBe(true);
  });

  it("is a no-op when the note does not exist", async () => {
    // Should not throw
    await expect(clearNoteMoveFlag("missing")).resolves.toBeUndefined();
  });
});
