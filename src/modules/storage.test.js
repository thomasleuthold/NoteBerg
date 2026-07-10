/**
 * src/modules/storage.test.js
 * Unit tests for moveNote, copyNote, and clearNoteMoveFlag.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkFileExists,
  clearAllData,
  clearNoteMoveFlag,
  copyNote,
  createNote,
  createNotebook,
  deleteFile,
  deleteNote,
  deleteNotebook,
  fixCorruptedNotes,
  generateId,
  getAllNotebooks,
  getAllNotebooksForSync,
  getAllNoteMetadataForSync,
  getAllNotes,
  getAllNotesForSync,
  getDeletedNotebooks,
  getDeletedNotes,
  getFile,
  getNote,
  getNoteIndex,
  getQuickNotes,
  getRawNote,
  getSetting,
  getStorageStats,
  getStorageVersion,
  initStorage,
  isLocalEncryptionEnabled,
  migrateNotesToEncrypted,
  moveNote,
  permanentlyDeleteNote,
  permanentlyDeleteNotebook,
  permanentlyDeleteNotesInNotebook,
  purgeLocalData,
  purgeNote,
  purgeNotebook,
  restoreNote,
  restoreNotebook,
  saveFile,
  saveNote,
  setSetting,
  setStorageVersion,
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
      clear: vi.fn((storeName) => {
        stores[storeName]?.clear();
        return Promise.resolve();
      }),
      getAll: vi.fn((storeName) => Promise.resolve([...(stores[storeName]?.values() ?? [])])),
      getAllFromIndex: vi.fn((storeName, _index, value) =>
        Promise.resolve(
          [...(stores[storeName]?.values() ?? [])].filter((r) => r.notebookId === value),
        ),
      ),
      count: vi.fn((storeName, id) => Promise.resolve(stores[storeName]?.has(id) ? 1 : 0)),
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

// Mocks for the encryption fail-closed tests. _encryptContent dynamically imports
// these inside storage.js, so vi.mock intercepts them. Default state: app unlocked.
let _appUnlocked = true;
vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => _appUnlocked),
  getEncryptionKey: vi.fn(() => ({ type: "secret" })),
}));
vi.mock("./encryption.js", () => ({
  encryptObject: vi.fn(async (obj) => ({ data: `enc:${JSON.stringify(obj)}`, iv: "iv" })),
  decryptObject: vi.fn(async (blob) => {
    if (blob && typeof blob === "object" && typeof blob.data === "string") {
      const prefix = "enc:";
      const raw = blob.data.startsWith(prefix) ? blob.data.slice(prefix.length) : blob.data;
      try {
        return JSON.parse(raw);
      } catch (_e) {
        return raw;
      }
    }
    return blob;
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
    recordings: note.recordings ?? [],
    tasks: note.tasks ?? [],
    recognition: note.recognition ?? null,
    penPresets: note.penPresets ?? null,
    pdfSource: note.pdfSource ?? null,
  };
  stores.notes.set(note.id, index);
  stores.noteContent.set(note.id, content);
}

/** Seed a blob into the local "files" store and return its id. */
function seedFile(id) {
  stores.files.set(id, { id, data: new Blob(["x"]), type: "application/octet-stream" });
  return id;
}

// Seed the in-memory stores before each test
beforeEach(async () => {
  for (const s of Object.values(stores)) s.clear();
  fileStore.clear();
  vi.clearAllMocks();
  _appUnlocked = true;

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

// ── Encryption fail-closed ──────────────────────────────────────────────────────
// When local encryption is enabled, a save must never persist plaintext content.
// If we cannot encrypt (app locked, or a crypto error), the save must abort.

describe("encryption fail-closed", () => {
  beforeEach(() => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
  });

  it("encrypts content when enabled and unlocked", async () => {
    seedNote(makeNote({ content: "secret" }));
    _appUnlocked = true;

    await updateNote("note-1", { content: "secret text" });

    const content = stores.noteContent.get("note-1");
    expect(typeof content.content).toBe("object");
    expect(content.content.iv).toBe("iv");
    expect(stores.notes.get("note-1").encrypted).toBe(true);
  });

  it("aborts the save when the app is locked (does not write plaintext)", async () => {
    seedNote(makeNote({ content: "secret" }));
    const before = structuredClone(stores.noteContent.get("note-1"));
    _appUnlocked = false;

    await expect(updateNote("note-1", { content: "new secret" })).rejects.toThrow(/locked/);

    // Stored content unchanged — no plaintext "new secret" persisted
    expect(stores.noteContent.get("note-1")).toEqual(before);
  });

  it("aborts the save when encryption throws (does not write plaintext)", async () => {
    seedNote(makeNote({ content: "secret" }));
    _appUnlocked = true;
    const { encryptObject } = await import("./encryption.js");
    encryptObject.mockRejectedValueOnce(new Error("crypto boom"));

    await expect(updateNote("note-1", { content: "new secret" })).rejects.toThrow(/save aborted/);
  });
});

// ── purgeNote blob cleanup ──────────────────────────────────────────────────────
// Purging a note must delete ALL its local blobs: media, pdfSource, recordings.

describe("purgeNote blob cleanup", () => {
  it("deletes media, pdfSource, and recording blobs from the files store", async () => {
    seedFile("media-1");
    seedFile("pdf-1");
    seedFile("rec-1");
    seedNote(
      makeNote({
        media: [{ id: "m1", fileId: "media-1", type: "image" }],
        pdfSource: "pdf-1",
        recordings: [{ id: "r1", fileId: "rec-1", name: "clip" }],
      }),
    );

    await purgeNote("note-1");

    expect(stores.files.has("media-1")).toBe(false);
    expect(stores.files.has("pdf-1")).toBe(false);
    expect(stores.files.has("rec-1")).toBe(false);
  });

  it("removes the content record and leaves a purged stub", async () => {
    seedNote(makeNote());

    await purgeNote("note-1");

    expect(stores.noteContent.has("note-1")).toBe(false);
    expect(stores.notes.get("note-1").purged).toBe(true);
  });
});

// ── copyNote recording blobs ────────────────────────────────────────────────────

describe("copyNote recording blobs", () => {
  it("deep-copies recording blobs to new fileIds", async () => {
    seedFile("rec-orig");
    seedNote(makeNote({ recordings: [{ id: "r1", fileId: "rec-orig", name: "clip" }] }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.recordings).toHaveLength(1);
    // New blob created, original fileId not shared
    expect(copied.recordings[0].fileId).not.toBe("rec-orig");
    expect(stores.files.has(copied.recordings[0].fileId)).toBe(true);
    // Original blob untouched
    expect(stores.files.has("rec-orig")).toBe(true);
  });

  it("keeps the original fileId when the blob is missing (fallback)", async () => {
    seedNote(makeNote({ recordings: [{ id: "r1", fileId: "rec-gone", name: "clip" }] }));

    const copied = await copyNote("note-1", "nb-b");

    expect(copied.recordings[0].fileId).toBe("rec-gone");
  });
});

// ── purgeLocalData / clearAllData clear the files store ──────────────────────────

describe("purgeLocalData", () => {
  it("clears the files (blob) store along with notes and notebooks", async () => {
    seedFile("blob-1");
    seedNote(makeNote());
    seedNotebook(makeNotebook());

    await purgeLocalData();

    expect(stores.files.size).toBe(0);
    expect(stores.notes.size).toBe(0);
    expect(stores.noteContent.size).toBe(0);
    expect(stores.notebooks.size).toBe(0);
  });

  it("keeps the settings store (credentials / encryption config)", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });

    await purgeLocalData();

    expect(stores.settings.has("encrypt_local_data")).toBe(true);
  });
});

describe("clearAllData", () => {
  it("clears the files store too", async () => {
    seedFile("blob-1");
    seedNote(makeNote());

    await clearAllData();

    expect(stores.files.size).toBe(0);
    expect(stores.noteContent.size).toBe(0);
  });
});

// ── generateId ────────────────────────────────────────────────────────────────

describe("generateId", () => {
  it("produces a valid-looking UUID via crypto.randomUUID", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("falls back to crypto.getRandomValues when randomUUID is unavailable", () => {
    const original = crypto.randomUUID;
    // Remove randomUUID to force the getRandomValues fallback path
    // eslint-disable-next-line no-param-reassign
    crypto.randomUUID = undefined;
    try {
      const id = generateId();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(10);
      expect(id).toContain("-");
    } finally {
      crypto.randomUUID = original;
    }
  });

  it("falls back to Math.random when crypto is entirely unavailable", () => {
    // `crypto` is a getter-only global in this environment; vi.stubGlobal
    // replaces it safely and vi.unstubAllGlobals() restores it afterwards.
    vi.stubGlobal("crypto", undefined);
    try {
      const id = generateId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls through to getRandomValues when randomUUID throws", () => {
    const original = crypto.randomUUID;
    crypto.randomUUID = () => {
      throw new Error("not supported in this context");
    };
    try {
      const id = generateId();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(10);
    } finally {
      crypto.randomUUID = original;
    }
  });
});

// ── Notebook CRUD ────────────────────────────────────────────────────────────

describe("createNotebook", () => {
  it("creates a notebook with defaults and dispatches notebook-created", async () => {
    const events = [];
    window.addEventListener("notebook-created", (e) => events.push(e));

    const nb = await createNotebook({ title: "My Notebook" });

    expect(nb.title).toBe("My Notebook");
    expect(nb.description).toBe("");
    expect(nb.color).toBe("#3b82f6");
    expect(nb.version).toBe(1);
    expect(nb.synced).toBe(false);
    expect(nb.deleted).toBe(false);
    expect(stores.notebooks.has(nb.id)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].detail.notebookId).toBe(nb.id);
    window.removeEventListener("notebook-created", events[0]);
  });

  it("honors provided description and color", async () => {
    const nb = await createNotebook({ title: "X", description: "desc", color: "#ff0000" });
    expect(nb.description).toBe("desc");
    expect(nb.color).toBe("#ff0000");
  });
});

describe("getAllNotebooks", () => {
  it("filters out deleted notebooks and sorts by modified desc", async () => {
    seedNotebook(makeNotebook({ id: "nb-1", modified: 100 }));
    seedNotebook(makeNotebook({ id: "nb-2", modified: 300 }));
    seedNotebook(makeNotebook({ id: "nb-3", modified: 200, deleted: true }));

    const all = await getAllNotebooks();

    expect(all.map((n) => n.id)).toEqual(["nb-2", "nb-1"]);
  });
});

describe("getAllNotebooksForSync", () => {
  it("includes deleted notebooks, sorted by modified desc", async () => {
    seedNotebook(makeNotebook({ id: "nb-1", modified: 100 }));
    seedNotebook(makeNotebook({ id: "nb-2", modified: 300, deleted: true }));

    const all = await getAllNotebooksForSync();

    expect(all.map((n) => n.id)).toEqual(["nb-2", "nb-1"]);
  });
});

describe("deleteNotebook", () => {
  it("soft-deletes the notebook and cascades to its notes", async () => {
    seedNotebook(makeNotebook({ id: "nb-a", version: 1 }));
    seedNote(makeNote({ id: "note-1", notebookId: "nb-a" }));
    seedNote(makeNote({ id: "note-2", notebookId: "nb-a" }));

    await deleteNotebook("nb-a");

    const nb = stores.notebooks.get("nb-a");
    expect(nb.deleted).toBe(true);
    expect(nb.version).toBe(2);
    expect(nb.synced).toBe(false);

    expect(stores.notes.get("note-1").deleted).toBe(true);
    expect(stores.notes.get("note-2").deleted).toBe(true);
  });

  it("does not re-delete notes that are already deleted", async () => {
    seedNotebook(makeNotebook({ id: "nb-a" }));
    seedNote(makeNote({ id: "note-1", notebookId: "nb-a", deleted: true, version: 5 }));

    await deleteNotebook("nb-a");

    // Version should be untouched since the note was already deleted (loop skips it)
    expect(stores.notes.get("note-1").version).toBe(5);
  });

  it("throws when notebook does not exist", async () => {
    await expect(deleteNotebook("ghost")).rejects.toThrow("Notebook not found");
  });
});

describe("purgeNotebook", () => {
  it("purges all notes in the notebook and stubs the notebook", async () => {
    seedNotebook(makeNotebook({ id: "nb-a", title: "Notebook A", lastSyncedEtag: "etag-1" }));
    seedNote(makeNote({ id: "note-1", notebookId: "nb-a" }));

    await purgeNotebook("nb-a");

    // Note should be purged (stubbed)
    expect(stores.notes.get("note-1").purged).toBe(true);
    expect(stores.noteContent.has("note-1")).toBe(false);

    // Notebook should be stubbed
    const nb = stores.notebooks.get("nb-a");
    expect(nb.purged).toBe(true);
    expect(nb.deleted).toBe(true);
    expect(nb.synced).toBe(false);
    expect(nb.title).toBe("Notebook A");
    expect(nb.lastSyncedEtag).toBe("etag-1");
  });

  it("is a no-op when notebook does not exist", async () => {
    await expect(purgeNotebook("ghost")).resolves.toBeUndefined();
  });
});

describe("permanentlyDeleteNotebook", () => {
  it("removes the notebook record entirely", async () => {
    seedNotebook(makeNotebook({ id: "nb-a" }));

    await permanentlyDeleteNotebook("nb-a");

    expect(stores.notebooks.has("nb-a")).toBe(false);
  });
});

// ── createNote ────────────────────────────────────────────────────────────────

describe("createNote", () => {
  it("creates a note with expected defaults and dispatches note-created", async () => {
    const events = [];
    window.addEventListener("note-created", (e) => events.push(e));

    const note = await createNote({ title: "New note", notebookId: "nb-a" });

    expect(note.title).toBe("New note");
    expect(note.notebookId).toBe("nb-a");
    expect(note.version).toBe(1);
    expect(note.synced).toBe(false);
    expect(note.deleted).toBe(false);
    expect(stores.notes.has(note.id)).toBe(true);
    expect(stores.noteContent.has(note.id)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].detail.noteId).toBe(note.id);
    window.removeEventListener("note-created", events[0]);
  });

  it("defaults notebookId to null for quick notes", async () => {
    const note = await createNote({ title: "Quick note" });
    expect(note.notebookId).toBeNull();
    expect(stores.notes.get(note.id).notebookId).toBeNull();
  });
});

// ── Note read/list operations ───────────────────────────────────────────────

describe("getAllNotes", () => {
  it("filters deleted notes and sorts by modified desc", async () => {
    seedNote(makeNote({ id: "note-1", modified: 100 }));
    seedNote(makeNote({ id: "note-2", modified: 300 }));
    seedNote(makeNote({ id: "note-3", modified: 200, deleted: true }));

    const all = await getAllNotes();

    expect(all.map((n) => n.id)).toEqual(["note-2", "note-1"]);
  });
});

describe("getAllNotesForSync / getAllNoteMetadataForSync", () => {
  it("includes deleted and non-deleted notes without filtering", async () => {
    seedNote(makeNote({ id: "note-1" }));
    seedNote(makeNote({ id: "note-2", deleted: true }));

    const forSync = await getAllNotesForSync();
    const metaForSync = await getAllNoteMetadataForSync();

    expect(forSync.map((n) => n.id).sort()).toEqual(["note-1", "note-2"]);
    expect(metaForSync.map((n) => n.id).sort()).toEqual(["note-1", "note-2"]);
  });
});

describe("getQuickNotes", () => {
  it("returns only non-deleted notes with null notebookId, sorted by modified desc", async () => {
    seedNote(makeNote({ id: "note-1", notebookId: null, modified: 100 }));
    seedNote(makeNote({ id: "note-2", notebookId: null, modified: 300 }));
    seedNote(makeNote({ id: "note-3", notebookId: "nb-a", modified: 200 }));
    seedNote(makeNote({ id: "note-4", notebookId: null, modified: 400, deleted: true }));

    const quick = await getQuickNotes();

    expect(quick.map((n) => n.id)).toEqual(["note-2", "note-1"]);
  });
});

describe("getNoteIndex", () => {
  it("returns the index record only", async () => {
    seedNote(makeNote({ id: "note-1", title: "Hi" }));

    const idx = await getNoteIndex("note-1");

    expect(idx.id).toBe("note-1");
    expect(idx.title).toBe("Hi");
    // Index record should not carry content-only fields like `content`
    expect(idx.content).toBeUndefined();
  });
});

describe("getNote / getRawNote", () => {
  it("merges index and content into a full note", async () => {
    seedNote(makeNote({ id: "note-1", content: "hello world", title: "T" }));

    const note = await getNote("note-1");

    expect(note.id).toBe("note-1");
    expect(note.title).toBe("T");
    expect(note.content).toBe("hello world");
    expect(note.tasks).toEqual([]);
  });

  it("returns null when the note does not exist", async () => {
    expect(await getNote("ghost")).toBeNull();
    expect(await getRawNote("ghost")).toBeNull();
  });

  it("getRawNote returns content without decrypting, even if flagged encrypted", async () => {
    seedNote(makeNote({ id: "note-1", content: "plaintext-ish" }));
    stores.notes.set("note-1", { ...stores.notes.get("note-1"), encrypted: true });

    const raw = await getRawNote("note-1");

    // getRawNote must not attempt decryption — content passes through untouched
    expect(raw.content).toBe("plaintext-ish");
    expect(raw.tasks).toEqual([]);
  });

  it("decrypts an encrypted note when unlocked", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
    seedNote(makeNote({ id: "note-1", content: "secret" }));
    // Re-save via updateNote to go through the real encryption path
    await updateNote("note-1", { content: "secret payload" });

    const note = await getNote("note-1");

    expect(note.content).toBe("secret payload");
    expect(note.encrypted).toBeUndefined();
  });

  it("throws when reading an encrypted note while app is locked", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
    seedNote(makeNote({ id: "note-1", content: "secret" }));
    await updateNote("note-1", { content: "secret payload" });

    _appUnlocked = false;
    await expect(getNote("note-1")).rejects.toThrow(/locked/);
  });

  it("throws when reading an encrypted note but local encryption is disabled", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
    seedNote(makeNote({ id: "note-1", content: "secret" }));
    await updateNote("note-1", { content: "secret payload" });

    // Now disable local encryption setting entirely (e.g. user turned it off elsewhere)
    stores.settings.delete("encrypt_local_data");

    await expect(getNote("note-1")).rejects.toThrow(/encryption is disabled/);
  });
});

describe("deleteNote", () => {
  it("soft-deletes and bumps version", async () => {
    seedNote(makeNote({ id: "note-1", version: 2 }));

    const result = await deleteNote("note-1");

    expect(result.deleted).toBe(true);
    expect(stores.notes.get("note-1").deleted).toBe(true);
    expect(stores.notes.get("note-1").version).toBe(3);
    expect(stores.notes.get("note-1").synced).toBe(false);
  });

  it("throws when note does not exist", async () => {
    await expect(deleteNote("ghost")).rejects.toThrow("Note not found");
  });
});

describe("permanentlyDeleteNote", () => {
  it("removes both index and content records", async () => {
    seedNote(makeNote({ id: "note-1" }));

    await permanentlyDeleteNote("note-1");

    expect(stores.notes.has("note-1")).toBe(false);
    expect(stores.noteContent.has("note-1")).toBe(false);
  });
});

describe("permanentlyDeleteNotesInNotebook", () => {
  it("removes all notes (index + content) belonging to the notebook", async () => {
    seedNote(makeNote({ id: "note-1", notebookId: "nb-a" }));
    seedNote(makeNote({ id: "note-2", notebookId: "nb-a" }));
    seedNote(makeNote({ id: "note-3", notebookId: "nb-b" }));

    await permanentlyDeleteNotesInNotebook("nb-a");

    expect(stores.notes.has("note-1")).toBe(false);
    expect(stores.notes.has("note-2")).toBe(false);
    expect(stores.noteContent.has("note-1")).toBe(false);
    expect(stores.noteContent.has("note-2")).toBe(false);
    // Untouched
    expect(stores.notes.has("note-3")).toBe(true);
  });
});

// ── Recycle bin ──────────────────────────────────────────────────────────────

describe("getDeletedNotebooks / getDeletedNotes", () => {
  it("returns only deleted-and-not-purged records, sorted by modified desc", async () => {
    seedNotebook(makeNotebook({ id: "nb-1", deleted: true, modified: 100 }));
    seedNotebook(makeNotebook({ id: "nb-2", deleted: true, modified: 300 }));
    seedNotebook(makeNotebook({ id: "nb-3", deleted: true, purged: true, modified: 200 }));
    seedNotebook(makeNotebook({ id: "nb-4", deleted: false, modified: 400 }));

    const deletedNotebooks = await getDeletedNotebooks();
    expect(deletedNotebooks.map((n) => n.id)).toEqual(["nb-2", "nb-1"]);

    seedNote(makeNote({ id: "note-1", deleted: true, modified: 100 }));
    seedNote(makeNote({ id: "note-2", deleted: true, modified: 300 }));
    seedNote(makeNote({ id: "note-3", deleted: true, purged: true, modified: 200 }));
    seedNote(makeNote({ id: "note-4", deleted: false, modified: 400 }));

    const deletedNotes = await getDeletedNotes();
    expect(deletedNotes.map((n) => n.id)).toEqual(["note-2", "note-1"]);
  });
});

describe("restoreNotebook", () => {
  it("clears deleted and bumps version", async () => {
    seedNotebook(makeNotebook({ id: "nb-1", deleted: true, version: 1 }));

    const restored = await restoreNotebook("nb-1");

    expect(restored.deleted).toBe(false);
    expect(restored.version).toBe(2);
    expect(restored.synced).toBe(false);
  });

  it("throws when notebook does not exist", async () => {
    await expect(restoreNotebook("ghost")).rejects.toThrow("Notebook not found");
  });
});

describe("restoreNote", () => {
  it("clears deleted and bumps version", async () => {
    seedNote(makeNote({ id: "note-1", deleted: true, version: 1 }));

    const restored = await restoreNote("note-1");

    expect(restored.deleted).toBe(false);
    expect(restored.version).toBe(2);
    expect(restored.synced).toBe(false);
  });

  it("throws when note does not exist", async () => {
    await expect(restoreNote("ghost")).rejects.toThrow("Note not found");
  });
});

// ── File/blob operations ─────────────────────────────────────────────────────
// Note: the top-of-file `vi.mock("./storage.js", ...)` factory replaces the
// exported getFile/saveFile with fakes backed by `fileStore` (a plain Map) for
// ALL consumers of this module, including this test file's own imports. So the
// imported `saveFile`/`getFile` here exercise the mock, not the real
// db-backed implementation — assert against `fileStore`, not `stores.files`.

describe("saveFile / getFile", () => {
  it("stores a Blob and returns a generated id", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });

    const id = await saveFile(blob);

    expect(typeof id).toBe("string");
    expect(fileStore.has(id)).toBe(true);
  });

  it("round-trips a Blob through getFile", async () => {
    const blob = new Blob(["hello world"], { type: "text/plain" });
    const id = await saveFile(blob);

    const retrieved = await getFile(id);

    expect(retrieved).toBe(blob);
  });

  it("getFile returns null for a missing id", async () => {
    expect(await getFile("missing")).toBeNull();
  });
});

describe("checkFileExists / deleteFile", () => {
  it("returns true for a file that exists in the store", async () => {
    seedFile("file-1");

    expect(await checkFileExists("file-1")).toBe(true);
  });

  it("returns false for a file that does not exist", async () => {
    expect(await checkFileExists("missing-file")).toBe(false);
  });

  it("deleteFile removes the record from the files store", async () => {
    seedFile("file-1");

    await deleteFile("file-1");

    expect(stores.files.has("file-1")).toBe(false);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("getSetting / setSetting", () => {
  it("returns null for an unset key", async () => {
    expect(await getSetting("nonexistent")).toBeNull();
  });

  it("round-trips a value", async () => {
    await setSetting("myKey", { nested: true });
    expect(await getSetting("myKey")).toEqual({ nested: true });
  });
});

describe("getStorageVersion / setStorageVersion", () => {
  it("defaults to 1 when unset", async () => {
    expect(await getStorageVersion()).toBe(1);
  });

  it("round-trips a version number", async () => {
    await setStorageVersion(3);
    expect(await getStorageVersion()).toBe(3);
  });
});

describe("isLocalEncryptionEnabled", () => {
  it("defaults to false when unset", async () => {
    expect(await isLocalEncryptionEnabled()).toBe(false);
  });

  it("reflects the stored setting", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
    expect(await isLocalEncryptionEnabled()).toBe(true);
  });
});

// ── saveNote (sync path) ─────────────────────────────────────────────────────

describe("saveNote", () => {
  it("splits and stores a full note, dispatching datachange", async () => {
    const events = [];
    window.addEventListener("datachange", (e) => events.push(e));

    await saveNote(makeNote({ id: "note-sync", content: "from sync" }));

    expect(stores.notes.has("note-sync")).toBe(true);
    expect(stores.noteContent.get("note-sync").content).toBe("from sync");
    expect(events).toHaveLength(1);
    expect(events[0].detail.noteId).toBe("note-sync");
    window.removeEventListener("datachange", events[0]);
  });

  it("skipEncryption stores content as-is without encrypting", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });

    await saveNote(makeNote({ id: "note-sync", content: "plain from sync" }), {
      skipEncryption: true,
    });

    expect(stores.noteContent.get("note-sync").content).toBe("plain from sync");
    // Encrypted flag on the index should remain whatever was on the note object
    // (splitNote copies note.encrypted verbatim since skipEncryption never sets index.encrypted)
    expect(stores.notes.get("note-sync").encrypted).toBeUndefined();
  });
});

// ── getStorageStats ──────────────────────────────────────────────────────────

describe("getStorageStats", () => {
  it("counts notebooks, notes, and quick notes", async () => {
    seedNotebook(makeNotebook({ id: "nb-1" }));
    seedNote(makeNote({ id: "note-1", notebookId: "nb-1" }));
    seedNote(makeNote({ id: "note-2", notebookId: null }));
    seedNote(makeNote({ id: "note-3", notebookId: null, deleted: true }));

    const stats = await getStorageStats();

    expect(stats.notebookCount).toBe(1);
    expect(stats.noteCount).toBe(2); // deleted note-3 excluded
    expect(stats.quickNoteCount).toBe(1); // note-2 only (note-3 filtered out earlier)
  });
});

// ── fixCorruptedNotes ─────────────────────────────────────────────────────────

describe("fixCorruptedNotes", () => {
  it("sets encrypted:true on the index when content looks encrypted but flag is missing", async () => {
    seedNote(makeNote({ id: "note-1" }));
    stores.noteContent.set("note-1", {
      ...stores.noteContent.get("note-1"),
      content: { data: "cipher", iv: "iv" },
    });
    stores.notes.set("note-1", { ...stores.notes.get("note-1"), encrypted: false });

    const result = await fixCorruptedNotes();

    expect(result.fixed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(stores.notes.get("note-1").encrypted).toBe(true);
  });

  it("detects encrypted strokes blobs too", async () => {
    seedNote(makeNote({ id: "note-1" }));
    stores.noteContent.set("note-1", {
      ...stores.noteContent.get("note-1"),
      strokes: { data: "cipher", iv: "iv" },
    });
    stores.notes.set("note-1", { ...stores.notes.get("note-1"), encrypted: false });

    const result = await fixCorruptedNotes();

    expect(result.fixed).toBe(1);
    expect(stores.notes.get("note-1").encrypted).toBe(true);
  });

  it("skips notes that are already correctly flagged or not encrypted", async () => {
    seedNote(makeNote({ id: "note-1", content: "plain text" }));

    const result = await fixCorruptedNotes();

    expect(result.fixed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips content records with no matching index entry", async () => {
    stores.noteContent.set("orphan-1", { id: "orphan-1", content: "orphaned" });

    const result = await fixCorruptedNotes();

    expect(result.fixed).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ── migrateNotesToEncrypted ───────────────────────────────────────────────────

describe("migrateNotesToEncrypted", () => {
  it("returns zeroed result when local encryption is disabled", async () => {
    const result = await migrateNotesToEncrypted();
    expect(result).toEqual({ migrated: 0, skipped: 0, failed: 0 });
  });

  it("throws when encryption is enabled but the app is locked", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
    _appUnlocked = false;

    await expect(migrateNotesToEncrypted()).rejects.toThrow(/locked/);
  });

  it("migrates unencrypted notes and skips already-encrypted ones", async () => {
    stores.settings.set("encrypt_local_data", { key: "encrypt_local_data", value: true });
    seedNote(makeNote({ id: "note-1", content: "needs encryption" }));
    seedNote(makeNote({ id: "note-2", content: "already done" }));
    stores.notes.set("note-2", { ...stores.notes.get("note-2"), encrypted: true });

    const result = await migrateNotesToEncrypted();

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(stores.notes.get("note-1").encrypted).toBe(true);
  });
});

// ── initStorage / _migrateThumbnailsToNoteContent ────────────────────────────

describe("initStorage thumbnail migration", () => {
  it("removes stale thumbnailFileId/thumbnailTimestamp and deletes the orphaned blob", async () => {
    // Reset the "done" flag so migration runs again, and seed a note with legacy fields.
    stores.settings.delete("thumbnailMigrationV5Done");
    seedFile("thumb-1");
    seedNote(makeNote({ id: "note-1" }));
    stores.notes.set("note-1", {
      ...stores.notes.get("note-1"),
      thumbnailFileId: "thumb-1",
      thumbnailTimestamp: 12345,
    });

    await initStorage();

    const idx = stores.notes.get("note-1");
    expect(idx.thumbnailFileId).toBeUndefined();
    expect(idx.thumbnailTimestamp).toBeUndefined();
    expect(stores.files.has("thumb-1")).toBe(false);
    expect(await getSetting("thumbnailMigrationV5Done")).toBe(true);
  });

  it("is a no-op (does not re-scan) once the migration flag is already set", async () => {
    stores.settings.set("thumbnailMigrationV5Done", {
      key: "thumbnailMigrationV5Done",
      value: true,
    });
    seedFile("thumb-1");
    seedNote(makeNote({ id: "note-1" }));
    stores.notes.set("note-1", {
      ...stores.notes.get("note-1"),
      thumbnailFileId: "thumb-1",
    });

    await initStorage();

    // Migration flag already true — should skip the scan, leaving legacy fields intact
    const idx = stores.notes.get("note-1");
    expect(idx.thumbnailFileId).toBe("thumb-1");
    expect(stores.files.has("thumb-1")).toBe(true);
  });

  it("does nothing when no notes have a thumbnailFileId", async () => {
    stores.settings.delete("thumbnailMigrationV5Done");
    seedNote(makeNote({ id: "note-1" }));

    await expect(initStorage()).resolves.toBeDefined();
    expect(await getSetting("thumbnailMigrationV5Done")).toBe(true);
  });
});

// ── splitNote/mergeNote via createNote — derived flags ───────────────────────

describe("splitNote derived flags (via createNote + updateNote)", () => {
  it("sets hasStrokes/hasContent/hasRecognition based on note content", async () => {
    const note = await createNote({ title: "T" });
    await updateNote(note.id, {
      strokes: [{ id: "s1", x: [1], y: [1], pressure: [1], width: 2 }],
      content: "some text",
      recognition: { fullText: "recognized text" },
    });

    const idx = stores.notes.get(note.id);
    expect(idx.hasStrokes).toBe(true);
    expect(idx.hasContent).toBe(true);
    expect(idx.hasRecognition).toBe(true);
  });

  it("flags are false for empty strokes/content/recognition", async () => {
    const note = await createNote({ title: "T" });
    await updateNote(note.id, { strokes: [], content: "   ", recognition: null });

    const idx = stores.notes.get(note.id);
    expect(idx.hasStrokes).toBe(false);
    expect(idx.hasContent).toBe(false); // whitespace-only content trims to empty
    expect(idx.hasRecognition).toBe(false);
  });

  it("hasRecognition is false when fullText is an empty string", async () => {
    const note = await createNote({ title: "T" });
    await updateNote(note.id, { recognition: { fullText: "" } });

    expect(stores.notes.get(note.id).hasRecognition).toBe(false);
  });

  it("stores a metadata-only media snapshot in the index (no fileId/positions)", async () => {
    const note = await createNote({ title: "T" });
    await updateNote(note.id, {
      media: [
        { id: "m1", name: "img.png", type: "image", size: 100, fileId: "file-x", x: 5, y: 5 },
      ],
    });

    const idx = stores.notes.get(note.id);
    expect(idx.media[0]).toEqual({
      id: "m1",
      name: "img.png",
      type: "image",
      size: 100,
      deleted: undefined,
    });
    expect(idx.media[0].fileId).toBeUndefined();
    expect(idx.media[0].x).toBeUndefined();

    // Content store retains the full object
    const content = stores.noteContent.get(note.id);
    expect(content.media[0].fileId).toBe("file-x");
    expect(content.media[0].x).toBe(5);
  });

  it("stores a metadata-only recordings snapshot in the index (no fileId)", async () => {
    const note = await createNote({ title: "T" });
    await updateNote(note.id, {
      recordings: [{ id: "r1", name: "clip.wav", duration: 30, fileId: "file-r" }],
    });

    const idx = stores.notes.get(note.id);
    expect(idx.recordings[0]).toEqual({
      id: "r1",
      name: "clip.wav",
      duration: 30,
      deleted: undefined,
    });
    expect(idx.recordings[0].fileId).toBeUndefined();

    const content = stores.noteContent.get(note.id);
    expect(content.recordings[0].fileId).toBe("file-r");
  });
});
