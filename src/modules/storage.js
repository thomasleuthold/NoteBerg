/**
 * Storage Module
 * IndexedDB wrapper for notes, notebooks, and settings.
 *
 * Schema v4 — split note storage:
 *   "notes"       — lightweight index (unencrypted, read constantly)
 *   "noteContent" — heavy payload   (encrypted when local encryption is on)
 *   "notebooks"   — unchanged
 *   "files"       — binary blobs (unchanged)
 *   "settings"    — key/value (unchanged)
 *
 * "notes" index fields (always unencrypted):
 *   id, notebookId, title, created, modified, version,
 *   synced, lastSyncedEtag, deleted, purged, previousNotebookId,
 *   encrypted, background, formatVersion, tags,
 *   hasStrokes, hasContent,
 *   media       — array of { id, name, type, size, deleted } (no blobs, no positions)
 *   recordings  — array of { id, name, duration, deleted } (no fileId)
 *
 * "noteContent" payload fields (content fields encrypted when note.encrypted):
 *   id, content, strokes, deletedStrokes,
 *   media  — full objects incl. fileId, x, y, width, height, rotation, …
 *   deletedMedia, tasks, recognition, penPresets, pdfSource,
 *   recordings       — full objects incl. fileId, duration, name, created, deleted
 *   deletedRecordings — array of fileIds to purge from "files" store
 */

import { openDB } from "idb";

export const DB_NAME = "NoteBerg";
export const DB_VERSION = 4;

let db = null;

// ─── Index field list ─────────────────────────────────────────────────────────
// Fields stored in the "notes" index store (never encrypted).
const INDEX_FIELDS = new Set([
  "id",
  "notebookId",
  "title",
  "created",
  "modified",
  "version",
  "synced",
  "lastSyncedEtag",
  "deleted",
  "purged",
  "previousNotebookId",
  "encrypted",
  "background",
  "formatVersion",
  "tags",
  "hasStrokes",
  "hasContent",
  "hasRecognition",
  "media", // metadata-only snapshot — see splitNote()
  "recordings", // metadata-only snapshot — see splitNote()
]);

// ─── Schema helpers ───────────────────────────────────────────────────────────

/**
 * Split a full note object into { index, content } for storage.
 * The index entry gets a lightweight media snapshot (no blobs, no positions).
 */
function splitNote(note) {
  const index = {};
  const content = { id: note.id };

  for (const [key, value] of Object.entries(note)) {
    if (key === "media") {
      // Index: metadata only (for sync decisions)
      index.media = Array.isArray(value)
        ? value.map(({ id, name, type, size, deleted }) => ({ id, name, type, size, deleted }))
        : [];
      // Content: full objects (fileId, positions, etc.)
      content.media = value ?? [];
    } else if (key === "recordings") {
      // Index: metadata only (no fileId)
      index.recordings = Array.isArray(value)
        ? value.map(({ id, name, duration, deleted }) => ({ id, name, duration, deleted }))
        : [];
      // Content: full objects (fileId, etc.)
      content.recordings = value ?? [];
    } else if (INDEX_FIELDS.has(key)) {
      index[key] = value;
    } else {
      content[key] = value;
    }
  }

  // Derived flags so overview never needs to load content
  index.hasStrokes = Array.isArray(note.strokes) ? note.strokes.length > 0 : false;
  index.hasContent = typeof note.content === "string" ? note.content.trim().length > 0 : false;
  index.hasRecognition =
    note.recognition != null &&
    typeof note.recognition.fullText === "string" &&
    note.recognition.fullText.length > 0;

  return { index, content };
}

/**
 * Merge an index entry and a content record back into a single note object.
 * Content fields win when both sides have the same key.
 */
function mergeNote(index, content) {
  if (!index) return null;
  // Use full recordings/media from content (have fileIds); index copies are metadata-only
  return {
    ...index,
    ...(content ?? {}),
    media: content?.media ?? index.media ?? [],
    recordings: content?.recordings ?? index.recordings ?? [],
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initStorage() {
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      // v4: drop old notes store (monolithic) and create split stores.
      // Any existing local data is intentionally discarded — the app
      // will repopulate from Nextcloud on the next sync.
      if (oldVersion < 4) {
        if (database.objectStoreNames.contains("notes")) {
          database.deleteObjectStore("notes");
        }
        if (database.objectStoreNames.contains("noteContent")) {
          database.deleteObjectStore("noteContent");
        }
        if (database.objectStoreNames.contains("syncQueue")) {
          database.deleteObjectStore("syncQueue");
        }
      }

      // notes index store
      if (!database.objectStoreNames.contains("notes")) {
        const noteStore = database.createObjectStore("notes", { keyPath: "id" });
        noteStore.createIndex("notebookId", "notebookId");
        noteStore.createIndex("modified", "modified");
        noteStore.createIndex("created", "created");
      }

      // noteContent payload store
      if (!database.objectStoreNames.contains("noteContent")) {
        database.createObjectStore("noteContent", { keyPath: "id" });
      }

      // notebooks — unchanged
      if (!database.objectStoreNames.contains("notebooks")) {
        const notebookStore = database.createObjectStore("notebooks", { keyPath: "id" });
        notebookStore.createIndex("created", "created");
        notebookStore.createIndex("modified", "modified");
      }

      // files — unchanged
      if (!database.objectStoreNames.contains("files")) {
        database.createObjectStore("files", { keyPath: "id" });
      }

      // settings — unchanged
      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
    },
  });

  await _migrateThumbnailsToNoteContent();
  console.log("Storage initialized (v4)");
  return db;
}

/**
 * One-time migration: remove stale thumbnailFileId/thumbnailTimestamp from the notes index
 * and delete the corresponding orphaned blobs from the files store.
 * Thumbnails are no longer stored or synced — they are rendered on demand in the
 * overview (see renderNoteSnapshot), so these legacy fields and blobs are dead weight.
 */
async function _migrateThumbnailsToNoteContent() {
  const migrated = await getSetting("thumbnailMigrationV5Done");
  if (migrated) return;

  const allIndexes = await db.getAll("notes");
  let count = 0;

  for (const index of allIndexes) {
    if (!index.thumbnailFileId) continue;
    const fileId = index.thumbnailFileId;
    delete index.thumbnailFileId;
    delete index.thumbnailTimestamp;
    await db.put("notes", index);
    try {
      await db.delete("files", fileId);
    } catch (_) {}
    count++;
  }

  await setSetting("thumbnailMigrationV5Done", true);
  if (count > 0) {
    console.log(`[Storage] Migrated ${count} notes: removed stale thumbnailFileId fields`);
  }
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch (_e) {
      /* fall through */
    }
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
    );
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─── Notebook Operations ──────────────────────────────────────────────────────

export async function createNotebook({ title, description = "", color = "#3b82f6" }) {
  const notebook = {
    id: generateId(),
    title,
    description,
    color,
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    synced: false,
    lastSyncedEtag: null,
    deleted: false,
  };

  await db.put("notebooks", notebook);
  console.log("Notebook created:", notebook.id);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("notebook-created", { detail: { notebookId: notebook.id } }),
    );
  return notebook;
}

export async function getAllNotebooks() {
  const notebooks = await db.getAll("notebooks");
  return notebooks.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

export async function getAllNotebooksForSync() {
  const notebooks = await db.getAll("notebooks");
  return notebooks.sort((a, b) => b.modified - a.modified);
}

export async function getNotebook(id) {
  return db.get("notebooks", id);
}

export async function updateNotebook(id, updates) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) throw new Error("Notebook not found");

  const updated = {
    ...notebook,
    ...updates,
    modified: Date.now(),
    version: (notebook.version || 0) + 1,
    synced: false,
  };

  await db.put("notebooks", updated);
  console.log("Notebook updated:", id);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("datachange", { detail: { notebookId: id, source: "local" } }),
    );
  return updated;
}

export async function deleteNotebook(id) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) throw new Error("Notebook not found");

  notebook.deleted = true;
  notebook.modified = Date.now();
  notebook.version = (notebook.version || 0) + 1;
  notebook.synced = false;
  await db.put("notebooks", notebook);

  // Soft-delete all notes in this notebook
  const notes = await db.getAllFromIndex("notes", "notebookId", id);
  const timestamp = Date.now();
  for (const note of notes) {
    if (!note.deleted) {
      note.deleted = true;
      note.modified = timestamp;
      note.version = (note.version || 0) + 1;
      note.synced = false;
      await db.put("notes", note);
    }
  }

  console.log(`Notebook deleted: ${id} (with ${notes.length} notes)`);
  return notebook;
}

export async function purgeNotebook(id) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) return;

  const notes = await db.getAllFromIndex("notes", "notebookId", id);
  for (const note of notes) {
    await purgeNote(note.id);
  }

  const stub = {
    id: notebook.id,
    title: notebook.title,
    purged: true,
    deleted: true,
    synced: false,
    modified: Date.now(),
    lastSyncedEtag: notebook.lastSyncedEtag,
  };

  await db.put("notebooks", stub);
  console.log("Notebook purged (stubbed):", id);
}

export async function permanentlyDeleteNotebook(id) {
  await db.delete("notebooks", id);
  console.log("Notebook permanently deleted from DB:", id);
}

// ─── Note Operations ──────────────────────────────────────────────────────────

export async function createNote({ title, notebookId = null }) {
  const note = {
    id: generateId(),
    notebookId,
    title,
    content: "",
    strokes: [],
    media: [],
    deletedMedia: [],
    formatVersion: 1,
    background: "none",
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    synced: false,
    lastSyncedEtag: null,
    deleted: false,
    tags: [],
    tasks: [],
    penPresets: null,
    pdfSource: null,
    recognition: null,
    deletedStrokes: [],
    recordings: [],
    deletedRecordings: [],
  };

  await _saveNoteSplit(note);
  console.log("Note created:", note.id);
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("note-created", { detail: { noteId: note.id } }));
  return note;
}

/**
 * Get all non-deleted notes as index entries (no strokes/content).
 * Used for overview rendering — fast, no decryption needed.
 */
export async function getAllNotes() {
  const notes = await db.getAll("notes");
  return notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get all notes including tombstones, index only.
 * The sync layer lazy-loads content via getNoteContent() for notes it needs to upload.
 */
export async function getAllNotesForSync() {
  if (!db) await initStorage();
  return db.getAll("notes");
}

/**
 * Get lightweight sync metadata for all notes.
 * With the split schema, the "notes" store IS the metadata — no projection needed.
 */
export async function getAllNoteMetadataForSync() {
  if (!db) await initStorage();
  return db.getAll("notes");
}

/**
 * Get index entries for all notes in a notebook (non-deleted).
 * Overview uses these — no content/strokes loaded.
 */
export async function getNotesByNotebook(notebookId) {
  const notes = await db.getAllFromIndex("notes", "notebookId", notebookId);
  return notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get index entries for quick notes (no notebook), non-deleted.
 */
export async function getQuickNotes() {
  const allNotes = await db.getAll("notes");
  return allNotes
    .filter((n) => !n.deleted && n.notebookId === null)
    .sort((a, b) => b.modified - a.modified);
}

/**
 * Get a full note (index + content merged, content decrypted).
 * Used when opening a note for editing.
 */
export async function getNote(id) {
  const [index, content] = await Promise.all([db.get("notes", id), db.get("noteContent", id)]);
  if (!index) return null;

  const merged = mergeNote(index, content);
  const decrypted = await decryptNoteIfNeeded(merged);
  if (decrypted) decrypted.tasks = decrypted.tasks || [];
  return decrypted;
}

/**
 * Get only the content record for a note (for sync upload).
 * Returns the raw stored form — sync layer handles Nextcloud encryption separately.
 */
export async function getNoteContent(id) {
  return db.get("noteContent", id);
}

/**
 * Get the full note (index + content merged) WITHOUT decryption.
 * Safe to call from a Web Worker where the encryption key is unavailable.
 * The sync layer handles Nextcloud-level encryption separately.
 */
export async function getRawNote(id) {
  const [index, content] = await Promise.all([db.get("notes", id), db.get("noteContent", id)]);
  if (!index) return null;
  const merged = mergeNote(index, content);
  if (merged) merged.tasks = merged.tasks || [];
  return merged;
}

/**
 * Get the index entry only (no content). Cheap — used where content isn't needed.
 */
export async function getNoteIndex(id) {
  return db.get("notes", id);
}

export async function updateNote(id, updates) {
  const existing = await getNote(id);
  if (!existing) throw new Error("Note not found");

  const updated = {
    ...existing,
    ...updates,
    modified: Date.now(),
    version: (existing.version || 0) + 1,
    synced: false,
  };

  await _saveNoteSplit(updated);
  console.log("Note updated:", id);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("datachange", { detail: { noteId: id, source: "local" } }),
    );
  return updated;
}

/**
 * API-compatible counterpart to the WebDAV backend's coalescing writer.
 *
 * Native builds write strokes through StorageWorker (off-thread IndexedDB),
 * which drains far faster than strokes arrive, so there is no backlog to
 * collapse and nothing to coalesce. This exists purely so modules shared with
 * the Nextcloud build can import the same name — see storage.webdav.js for the
 * implementation that actually coalesces.
 */
export async function updateNoteCoalesced(id, updates) {
  await updateNote(id, updates);
}

/** No-op on native: IndexedDB writes are awaited directly by their callers. */
export async function flushNoteWrites() {}

export async function deleteNote(id) {
  const note = await db.get("notes", id);
  if (!note) throw new Error("Note not found");

  note.deleted = true;
  note.modified = Date.now();
  note.version = (note.version || 0) + 1;
  note.synced = false;

  await db.put("notes", note);
  console.log("Note deleted:", id);
  return note;
}

export async function moveNote(noteId, targetNotebookId) {
  const note = await db.get("notes", noteId);
  if (!note) throw new Error("Note not found");

  const previousNotebookId = note.notebookId ?? null;
  if (previousNotebookId === (targetNotebookId ?? null)) return;

  const updated = {
    ...note,
    notebookId: targetNotebookId ?? null,
    previousNotebookId,
    modified: Date.now(),
    version: (note.version || 0) + 1,
    synced: false,
    lastSyncedEtag: null,
  };
  await db.put("notes", updated);
  console.log(`Note moved: ${noteId} from ${previousNotebookId} to ${targetNotebookId}`);
}

export async function copyNote(noteId, targetNotebookId) {
  const note = await getNote(noteId);
  if (!note) throw new Error("Note not found");

  // Deep-copy media blobs
  const newMedia = [];
  for (const item of note.media || []) {
    const blob = await getFile(item.fileId);
    const newFileId = blob ? await saveFile(blob) : item.fileId;
    newMedia.push({ ...item, fileId: newFileId });
  }

  let newPdfSource = note.pdfSource ?? null;
  if (note.pdfSource) {
    const pdfBlob = await getFile(note.pdfSource);
    newPdfSource = pdfBlob ? await saveFile(pdfBlob) : note.pdfSource;
  }

  // Deep-copy recording blobs so the copy doesn't share fileIds with the original
  // (purging one note would otherwise delete the other's audio).
  const newRecordings = [];
  for (const rec of note.recordings || []) {
    const blob = rec.fileId ? await getFile(rec.fileId) : null;
    const newFileId = blob ? await saveFile(blob) : rec.fileId;
    newRecordings.push({ ...rec, fileId: newFileId });
  }

  const now = Date.now();
  const newNote = {
    ...note,
    id: generateId(),
    notebookId: targetNotebookId ?? null,
    media: newMedia,
    recordings: newRecordings,
    pdfSource: newPdfSource,
    previousNotebookId: undefined,
    deletedMedia: [],
    synced: false,
    lastSyncedEtag: null,
    version: 1,
    created: now,
    modified: now,
  };
  delete newNote.previousNotebookId;

  await _saveNoteSplit(newNote);
  console.log(`Note copied: ${noteId} → ${newNote.id} into ${targetNotebookId}`);
  return newNote;
}

export async function clearNoteMoveFlag(id) {
  const note = await db.get("notes", id);
  if (!note) return;
  delete note.previousNotebookId;
  await db.put("notes", note);
}

/**
 * Collect every local blob fileId a note references: media, pdfSource, and
 * recording files. Used to clean up the "files" store when a note is destroyed.
 * Uses getNote() so encrypted media/recordings are decrypted to plain arrays
 * (the raw content record stores them as opaque {data,iv} blobs with no fileIds).
 * Falls back to the raw content record if decryption is unavailable (app locked).
 */
async function collectNoteBlobIds(id) {
  const ids = new Set();
  let note = null;
  try {
    note = await getNote(id);
  } catch (_e) {
    // App locked / corrupted — fall back to whatever is readable in raw content.
    note = await getRawNote(id);
  }
  if (!note) return ids;

  if (Array.isArray(note.media)) {
    for (const item of note.media) if (item?.fileId) ids.add(item.fileId);
  }
  if (note.pdfSource) ids.add(note.pdfSource);
  if (Array.isArray(note.recordings)) {
    for (const rec of note.recordings) if (rec?.fileId) ids.add(rec.fileId);
  }
  return ids;
}

export async function purgeNote(id) {
  const index = await db.get("notes", id);
  if (!index) return;

  // Delete all local blob files this note references (media, PDF, recordings).
  try {
    for (const fileId of await collectNoteBlobIds(id)) {
      await deleteFile(fileId);
    }
  } catch (e) {
    console.warn("[Storage] Could not clean up blobs during purge:", e);
  }

  // Delete content record
  await db.delete("noteContent", id);

  // Replace index with a minimal stub
  const stub = {
    id: index.id,
    notebookId: index.notebookId,
    purged: true,
    deleted: true,
    synced: false,
    modified: Date.now(),
    lastSyncedEtag: index.lastSyncedEtag,
    _currentFileEtag: index._currentFileEtag,
  };
  await db.put("notes", stub);
  console.log("Note purged (stubbed):", id);
}

export async function permanentlyDeleteNote(id) {
  await Promise.all([db.delete("notes", id), db.delete("noteContent", id)]);
  console.log("Note permanently deleted from DB:", id);
}

export async function permanentlyDeleteNotesInNotebook(notebookId) {
  const notes = await db.getAllFromIndex("notes", "notebookId", notebookId);
  await Promise.all(
    notes.flatMap((note) => [db.delete("notes", note.id), db.delete("noteContent", note.id)]),
  );
  console.log(`Permanently deleted ${notes.length} notes for notebook ${notebookId}`);
}

// ─── Recycle Bin ──────────────────────────────────────────────────────────────

export async function getDeletedNotebooks() {
  const all = await db.getAll("notebooks");
  return all.filter((n) => n.deleted && !n.purged).sort((a, b) => b.modified - a.modified);
}

export async function getDeletedNotes() {
  const all = await db.getAll("notes");
  return all.filter((n) => n.deleted && !n.purged).sort((a, b) => b.modified - a.modified);
}

export async function restoreNotebook(id) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) throw new Error("Notebook not found");

  notebook.deleted = false;
  notebook.modified = Date.now();
  notebook.version = (notebook.version || 0) + 1;
  notebook.synced = false;

  await db.put("notebooks", notebook);
  console.log("Notebook restored:", id);
  return notebook;
}

export async function restoreNote(id) {
  const note = await db.get("notes", id);
  if (!note) throw new Error("Note not found");

  note.deleted = false;
  note.modified = Date.now();
  note.version = (note.version || 0) + 1;
  note.synced = false;

  await db.put("notes", note);
  console.log("Note restored:", id);
  return note;
}

// ─── File/Blob Operations ─────────────────────────────────────────────────────

export async function saveFile(blob, id = null) {
  const fileId = id || generateId();
  const mimeType = blob.type;

  // Blobs are stored as-is rather than unwrapped to an ArrayBuffer first.
  // IndexedDB stores Blobs natively (usually by reference to the browser's own
  // blob store), so the previous blob.arrayBuffer() hop bought nothing and cost
  // a full extra copy of the payload in JS heap — on a 1000-page PDF that is
  // ~80MB of transient allocation per file, which is what OOM-killed the WebView
  // renderer mid-sync on low-end Android. getFile already reads back either
  // shape, so records written by older versions still load unchanged.
  await db.put("files", { id: fileId, data: blob, type: mimeType, created: Date.now() });
  return fileId;
}

export async function getFile(id) {
  const record = await db.get("files", id);
  if (!record) return null;
  // Records written before saveFile stored Blobs directly hold an ArrayBuffer;
  // wrap those so every caller gets a Blob regardless of when the file was
  // saved. Branded via the toString tag rather than `instanceof`, which is
  // false for a buffer that crossed a realm boundary (a WebView/worker/iframe
  // hand-off) and would silently return the raw buffer to callers expecting a
  // Blob. ArrayBuffer.isView does not cover a bare ArrayBuffer, hence the tag.
  const tag = Object.prototype.toString.call(record.data);
  if (tag === "[object ArrayBuffer]" || ArrayBuffer.isView(record.data)) {
    return new Blob([record.data], { type: record.type || "application/octet-stream" });
  }
  return record.data;
}

export async function checkFileExists(id) {
  return (await db.count("files", id)) > 0;
}

export async function deleteFile(id) {
  await db.delete("files", id);
}

// No-op in Tauri build — blobs are stored in IndexedDB via saveFile/getFile.
// In NC build this is replaced by storage.webdav.js which uploads to WebDAV.
export async function saveMediaForNote(_blob, _filename, _noteId, _notebookId) {}
// No-op in Tauri build — orphaned server media is cleaned by cleanupOrphanedMedia
// during sync. In NC build this is replaced by storage.webdav.js.
export async function cleanupNoteMedia(_noteId, _notebookId, _validFileIds) {}
// NC-only: returns a direct URL for a file. Always null in Tauri build.
export function getFileUrl(_id) {
  return null;
}
export function registerPendingUpload(_fileId, _promise) {}
export async function waitForFileUrl(_id) {
  return null;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSetting(key) {
  const setting = await db.get("settings", key);
  return setting ? setting.value : null;
}

export async function setSetting(key, value) {
  await db.put("settings", { key, value });
}

export async function getStorageVersion() {
  return (await getSetting("storageVersion")) || 1;
}

export async function setStorageVersion(version) {
  await setSetting("storageVersion", version);
}

// ─── Sync-oriented save functions ─────────────────────────────────────────────

/**
 * Save or update a note from sync.
 * The note object is a full merged note (index + content fields together).
 * Splits into both stores. Dispatches datachange.
 */
export async function saveNote(note, options = {}) {
  const { skipEncryption = false } = options;
  await _saveNoteSplit(note, { skipEncryption });
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("datachange", { detail: { noteId: note.id } }));
}

export async function saveNotebook(notebook) {
  await db.put("notebooks", notebook);
}

/**
 * Update only lastSyncedEtag + synced on the index — no datachange event,
 * no content write. Used after uploads and for the etag oscillation fix.
 * @param {number} [expectedModified] - The note's `modified` timestamp at the time
 *   the etag was obtained. If the note was edited since (timestamps differ), only
 *   the etag is updated and `synced` is left untouched — flipping it to true would
 *   mask the mid-sync edit and it would never be uploaded.
 */
export async function updateNoteEtag(noteId, etag, expectedModified) {
  const note = await db.get("notes", noteId);
  if (!note) return;
  note.lastSyncedEtag = etag;
  if (expectedModified === undefined || note.modified === expectedModified) {
    note.synced = true;
  }
  await db.put("notes", note);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export async function getStorageStats() {
  const notebooks = await getAllNotebooks();
  const notes = await getAllNotes();
  return {
    notebookCount: notebooks.length,
    noteCount: notes.length,
    quickNoteCount: notes.filter((n) => !n.notebookId).length,
  };
}

export async function clearAllData() {
  await Promise.all([
    db.clear("notebooks"),
    db.clear("notes"),
    db.clear("noteContent"),
    db.clear("files"),
    db.clear("settings"),
  ]);
  console.log("All data cleared");
}

export async function purgeLocalData() {
  if (!db) throw new Error("Database not initialized. Call initStorage() first.");

  // Clear notes/notebooks/content AND the binary blob store — leaving "files"
  // behind would orphan every image, PDF, and recording in IndexedDB.
  // "settings" is intentionally kept (credentials, encryption config).
  await Promise.all([
    db.clear("notebooks"),
    db.clear("notes"),
    db.clear("noteContent"),
    db.clear("files"),
  ]);

  const [nb, n, f] = await Promise.all([
    db.getAll("notebooks"),
    db.getAll("notes"),
    db.getAll("files"),
  ]);
  if (nb.length > 0 || n.length > 0 || f.length > 0)
    throw new Error("Purge failed: Data still exists!");
}

export async function isLocalEncryptionEnabled() {
  return (await getSetting("encrypt_local_data")) ?? false;
}

export async function fixCorruptedNotes() {
  console.log("[Storage] Scanning for corrupted notes...");
  const allContent = await db.getAll("noteContent");
  let fixed = 0;
  let skipped = 0;

  for (const content of allContent) {
    try {
      const hasEncryptedContent =
        content.content &&
        typeof content.content === "object" &&
        content.content.data &&
        content.content.iv;
      const hasEncryptedStrokes =
        content.strokes &&
        typeof content.strokes === "object" &&
        content.strokes.data &&
        content.strokes.iv;

      const index = await db.get("notes", content.id);
      if (!index) continue;

      if ((hasEncryptedContent || hasEncryptedStrokes) && !index.encrypted) {
        await db.put("notes", { ...index, encrypted: true });
        fixed++;
        console.log(`[Storage] Fixed encrypted flag for note ${content.id}`);
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`[Storage] Failed to check note ${content.id}:`, error);
    }
  }

  console.log(`[Storage] Corruption scan complete: ${fixed} fixed, ${skipped} skipped`);
  return { fixed, skipped };
}

export async function migrateNotesToEncrypted() {
  const encryptionEnabled = await isLocalEncryptionEnabled();
  if (!encryptionEnabled) return { migrated: 0, skipped: 0, failed: 0 };

  const { isAppUnlocked } = await import("./masterPassword.js");
  if (!isAppUnlocked()) throw new Error("Cannot migrate notes - app is locked");

  const allContent = await db.getAll("noteContent");
  let migrated = 0,
    skipped = 0,
    failed = 0;

  for (const content of allContent) {
    try {
      const index = await db.get("notes", content.id);
      if (!index || index.encrypted) {
        skipped++;
        continue;
      }

      const merged = mergeNote(index, content);
      await _saveNoteSplit(merged, { skipEncryption: false });
      migrated++;
    } catch (error) {
      console.error(`[Storage] Failed to migrate note ${content.id}:`, error);
      failed++;
    }
  }

  console.log(
    `[Storage] Encryption migration: ${migrated} migrated, ${skipped} skipped, ${failed} failed`,
  );
  return { migrated, skipped, failed };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Write a full note object to both "notes" (index) and "noteContent" stores.
 * Encrypts content fields when local encryption is enabled.
 */
async function _saveNoteSplit(note, { skipEncryption = false } = {}) {
  let { index, content } = splitNote(note);

  if (!skipEncryption) {
    content = await _encryptContent(content);
    // encrypted flag lives on the index so getAllNoteMetadataForSync can see it
    index.encrypted = content._encrypted;
    delete content._encrypted;
  }

  // Single transaction across both stores for atomicity
  const tx = db.transaction(["notes", "noteContent"], "readwrite");
  await Promise.all([
    tx.objectStore("notes").put(index),
    tx.objectStore("noteContent").put(content),
    tx.done,
  ]);
}

/**
 * Encrypt the content fields of a noteContent record if local encryption is on.
 * Returns the (possibly encrypted) content object, with a temporary `_encrypted`
 * boolean flag that _saveNoteSplit copies to the index entry.
 */
async function _encryptContent(content) {
  const shouldEncrypt = await isLocalEncryptionEnabled();
  if (!shouldEncrypt) return { ...content, _encrypted: false };

  const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
  const { encryptObject } = await import("./encryption.js");

  // Fail closed: encryption is enabled, so never persist plaintext content. If we
  // cannot encrypt (locked, or a crypto error), abort the save and surface the
  // error instead of silently writing readable data with encrypted:false.
  if (!isAppUnlocked()) {
    throw new Error("Cannot encrypt note content - app is locked");
  }

  try {
    const key = getEncryptionKey();
    // Helper: skip encryption if the value is already an encrypted blob {data, iv}
    const isEncryptedBlob = (v) =>
      v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";

    return {
      ...content,
      content: isEncryptedBlob(content.content)
        ? content.content
        : await encryptObject(content.content || "", key),
      strokes: isEncryptedBlob(content.strokes)
        ? content.strokes
        : await encryptObject(content.strokes || [], key),
      media: isEncryptedBlob(content.media)
        ? content.media
        : await encryptObject(content.media || [], key),
      tasks: isEncryptedBlob(content.tasks)
        ? content.tasks
        : await encryptObject(content.tasks || [], key),
      recognition: isEncryptedBlob(content.recognition)
        ? content.recognition
        : content.recognition
          ? await encryptObject(content.recognition, key)
          : null,
      _encrypted: true,
    };
  } catch (error) {
    console.error("[Storage] Failed to encrypt note content:", error);
    throw new Error("Failed to encrypt note content - save aborted to avoid storing plaintext");
  }
}

/**
 * Decrypt a merged note object's content fields if needed.
 */
async function decryptNoteIfNeeded(note) {
  if (!note?.encrypted) return note;

  const encryptionEnabled = await isLocalEncryptionEnabled();
  if (!encryptionEnabled) {
    throw new Error("Cannot access encrypted note - encryption is disabled.");
  }

  const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
  const { decryptObject } = await import("./encryption.js");

  if (!isAppUnlocked()) {
    throw new Error("Cannot decrypt note - app is locked.");
  }

  try {
    const key = getEncryptionKey();

    let decryptedMedia = [];
    if (note.media && typeof note.media === "object" && note.media.data && note.media.iv) {
      let once = await decryptObject(note.media, key);
      // Guard against double-encryption: decrypt a second time if still an encrypted blob
      if (once && typeof once === "object" && once.data && once.iv) {
        once = await decryptObject(once, key);
      }
      decryptedMedia = Array.isArray(once) ? once : [];
    }

    let decryptedRecordings = [];
    if (
      note.recordings &&
      typeof note.recordings === "object" &&
      note.recordings.data &&
      note.recordings.iv
    ) {
      try {
        const once = await decryptObject(note.recordings, key);
        decryptedRecordings = Array.isArray(once) ? once : [];
      } catch (_e) {
        // Encrypted with a different device's key (cross-device sync artifact) — treat as empty
        console.warn(
          "[Storage] Could not decrypt recordings blob — dropping recordings for note",
          note.id,
        );
        decryptedRecordings = [];
      }
    } else if (Array.isArray(note.recordings)) {
      decryptedRecordings = note.recordings;
    }

    let decryptedTasks = [];
    if (note.tasks && typeof note.tasks === "object" && note.tasks.data && note.tasks.iv) {
      decryptedTasks = await decryptObject(note.tasks, key);
    } else if (note.tasks) {
      decryptedTasks = note.tasks;
    }

    let decryptedRecognition = null;
    if (note.recognition && typeof note.recognition === "object" && note.recognition.data) {
      decryptedRecognition = await decryptObject(note.recognition, key);
    } else if (note.recognition) {
      decryptedRecognition = note.recognition;
    }

    const _isEncryptedBlob = (v) =>
      v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";

    return {
      ...note,
      content: await decryptObject(note.content, key),
      strokes: await decryptObject(note.strokes, key),
      media: decryptedMedia,
      recordings: decryptedRecordings,
      tasks: decryptedTasks,
      recognition: decryptedRecognition,
      encrypted: undefined,
    };
  } catch (error) {
    console.error("[Storage] Failed to decrypt note:", error);
    throw new Error("Failed to decrypt note - invalid master password or corrupted data");
  }
}
