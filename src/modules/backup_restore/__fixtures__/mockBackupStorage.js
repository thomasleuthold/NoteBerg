/**
 * In-memory stand-in for storage.js, for the backup/restore tests.
 *
 * Models the external behaviour those modules rely on rather than the
 * IndexedDB mechanics: records are cloned on write (as IndexedDB does), notes
 * come back whole and decrypted from getNote(), copyNote() deep-copies blobs
 * under fresh ids, and restoreNotebook() re-dirties the notebook the way the
 * real one does. Tests seed and inspect the maps directly via `__store`.
 */

import { vi } from "vitest";

let idCounter = 0;
const nextId = (prefix) => `${prefix}-${++idCounter}`;

function clone(record) {
  if (record == null) return record;
  const blobs = [];
  for (const [key, value] of Object.entries(record)) {
    if (Object.prototype.toString.call(value) === "[object Blob]") blobs.push([key, value]);
  }
  const plain = { ...record };
  for (const [key] of blobs) delete plain[key];
  const cloned = structuredClone(plain);
  for (const [key, value] of blobs) cloned[key] = value;
  return cloned;
}

export function createStorageMock() {
  const store = {
    notes: new Map(),
    notebooks: new Map(),
    files: new Map(),
    settings: new Map(),
    reset() {
      store.notes.clear();
      store.notebooks.clear();
      store.files.clear();
      store.settings.clear();
    },
    seedNote(note) {
      store.notes.set(note.id, clone(note));
    },
    seedNotebook(nb) {
      store.notebooks.set(nb.id, clone(nb));
    },
    seedFile(id, blob) {
      store.files.set(id, blob);
    },
  };

  const api = {
    DB_VERSION: 5,
    __store: store,

    getAllNotebooksForSync: vi.fn(async () => [...store.notebooks.values()].map(clone)),
    getAllNotesForSync: vi.fn(async () => [...store.notes.values()].map(clone)),
    getNoteIndex: vi.fn(async (id) => clone(store.notes.get(id) ?? null)),
    getNote: vi.fn(async (id) => {
      const note = store.notes.get(id);
      if (!note) return null;
      if (note.locked) throw new Error("Cannot decrypt note - app is locked.");
      const full = clone(note);
      // Real getNote() returns decrypted content and clears the flag.
      full.encrypted = undefined;
      return full;
    }),
    saveNote: vi.fn(async (note) => {
      store.notes.set(note.id, clone(note));
    }),
    saveNotebook: vi.fn(async (nb) => {
      store.notebooks.set(nb.id, clone(nb));
    }),
    restoreNotebook: vi.fn(async (id) => {
      const nb = store.notebooks.get(id);
      if (!nb) throw new Error("Notebook not found");
      nb.deleted = false;
      nb.modified = Date.now();
      nb.version = (nb.version || 0) + 1;
      nb.synced = false;
      return clone(nb);
    }),
    copyNote: vi.fn(async (id, targetNotebookId) => {
      const note = store.notes.get(id);
      if (!note) throw new Error("Note not found");
      const media = [];
      for (const item of note.media || []) {
        const blob = store.files.get(item.fileId);
        const fileId = blob ? nextId("file") : item.fileId;
        if (blob) store.files.set(fileId, blob);
        media.push({ ...item, fileId });
      }
      const now = Date.now();
      const copy = {
        ...clone(note),
        id: nextId("copy"),
        notebookId: targetNotebookId ?? null,
        media,
        synced: false,
        lastSyncedEtag: null,
        version: 1,
        created: now,
        modified: now,
      };
      store.notes.set(copy.id, clone(copy));
      return copy;
    }),
    saveFile: vi.fn(async (blob, id = null) => {
      const fileId = id || nextId("file");
      store.files.set(fileId, blob);
      return fileId;
    }),
    getFile: vi.fn(async (id) => store.files.get(id) ?? null),
    checkFileExists: vi.fn(async (id) => store.files.has(id)),
    getFileStats: vi.fn(async () => {
      let bytes = 0;
      for (const blob of store.files.values()) bytes += blob.size;
      return { count: store.files.size, bytes };
    }),
    getStorageStats: vi.fn(async () => {
      const notes = [...store.notes.values()].filter((n) => !n.deleted);
      return {
        notebookCount: [...store.notebooks.values()].filter((n) => !n.deleted).length,
        noteCount: notes.length,
        quickNoteCount: notes.filter((n) => !n.notebookId).length,
      };
    }),
    getSetting: vi.fn(async (key) => store.settings.get(key) ?? null),
    setSetting: vi.fn(async (key, value) => {
      store.settings.set(key, value);
    }),
    isLocalEncryptionEnabled: vi.fn(async () => store.settings.get("encrypt_local_data") ?? false),
  };

  return api;
}
