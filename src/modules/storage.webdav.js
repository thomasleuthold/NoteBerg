/**
 * WebDAV Storage Backend — Nextcloud build only
 *
 * Implements the same API surface as storage.js but reads/writes directly
 * to the Nextcloud WebDAV endpoint instead of IndexedDB.
 *
 * File layout mirrors storagePaths.js (shared with Tauri sync):
 *   /NoteBerg/notebooks/{notebookId}/_notebook.json
 *   /NoteBerg/notebooks/{notebookId}/notes/{noteId}.json
 *   /NoteBerg/notebooks/{notebookId}/notes/{noteId}_media/{filename}
 *   /NoteBerg/quickNotes/{noteId}.json
 *   /NoteBerg/quickNotes/{noteId}_media/{filename}
 *   /NoteBerg/notebooks/_tombstones.json
 *   /NoteBerg/notebooks/{notebookId}/_tombstones.json
 *   /NoteBerg/quickNotes/_tombstones.json
 */

import {
  getAllRequiredFolders,
  getMediaPath,
  getNoteMediaFolder,
  getNotebookFolder,
  getNotebookNotesFolder,
  getNotebookPath,
  getNotebookTombstonePath,
  getNotePath,
  getQuickNotesTombstonePath,
  ROOT_FOLDER,
} from "./storagePaths.js";

// ─── WebDAV helpers ────────────────────────────────────────────────────────────

function getWebDAVBase() {
  const uid = window.OC?.currentUser || window.OC?.getCurrentUser?.()?.uid || "admin";
  return `/remote.php/dav/files/${uid}`;
}

async function davGet(path) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    headers: { "OCS-APIREQUEST": "true" },
    credentials: "same-origin",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DAV GET ${path} failed: ${res.status}`);
  return res.json();
}

async function davPut(path, data) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`DAV PUT ${path} failed: ${res.status}`);
}

async function davPutBinary(path, blob) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: blob,
  });
  if (!res.ok) throw new Error(`DAV PUT binary ${path} failed: ${res.status}`);
}

async function davDelete(path) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    method: "DELETE",
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  if (res.status === 404) return; // already gone
  if (!res.ok) throw new Error(`DAV DELETE ${path} failed: ${res.status}`);
}

async function davGetBinary(path) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    headers: { "OCS-APIREQUEST": "true" },
    credentials: "same-origin",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DAV GET binary ${path} failed: ${res.status}`);
  return res.blob();
}

async function davMkcol(path) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    method: "MKCOL",
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  // 405 = already exists, that's fine
  if (!res.ok && res.status !== 405) throw new Error(`DAV MKCOL ${path} failed: ${res.status}`);
}

/** PROPFIND a directory, returns array of child filenames (not the dir itself) */
async function davList(path) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`DAV PROPFIND ${path} failed: ${res.status}`);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  const hrefs = [...doc.querySelectorAll("response href")].map((el) => el.textContent.trim());
  const base = `/remote.php/dav/files/`;
  return hrefs
    .map((h) => {
      // strip base + uid prefix, decode
      const idx = h.indexOf(ROOT_FOLDER);
      return idx >= 0 ? decodeURIComponent(h.slice(idx)) : null;
    })
    .filter(Boolean)
    .filter((p) => p !== path && p !== `${path}/`); // exclude the dir itself
}

// ─── IndexedDB stubs (referenced by StorageWorker which is disabled in NC build) ─
export const DB_NAME = "NoteBerg";
export const DB_VERSION = 4;

// ─── Init ─────────────────────────────────────────────────────────────────────

let _initialized = false;
// Simple in-memory settings store (replaces IndexedDB settings for NC build)
const _settings = {};

export async function initStorage() {
  if (_initialized) return;
  // Ensure required folders exist
  for (const folder of getAllRequiredFolders()) {
    await davMkcol(folder);
  }
  _initialized = true;
  console.log("Storage initialized (WebDAV)");
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try { return crypto.randomUUID(); } catch (_e) { /* fall through */ }
  }
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );
}

// ─── Settings (in-memory for NC build) ───────────────────────────────────────

export async function getSetting(key) {
  return _settings[key] ?? null;
}

export async function setSetting(key, value) {
  _settings[key] = value;
}

// ─── Notebook operations ──────────────────────────────────────────────────────

export async function createNotebook({ title, description = "", color = "#3b82f6" }) {
  const notebook = {
    id: generateId(),
    title,
    description,
    color,
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    deleted: false,
  };
  await davMkcol(getNotebookFolder(notebook.id));
  await davMkcol(getNotebookNotesFolder(notebook.id));
  await davPut(getNotebookPath(notebook.id), notebook);
  console.log("Notebook created:", notebook.id);
  window.dispatchEvent(new CustomEvent("notebook-created", { detail: { notebookId: notebook.id } }));
  return notebook;
}

export async function getAllNotebooks() {
  const paths = await davList(`${ROOT_FOLDER}/notebooks`);
  const notebookIds = paths
    .filter((p) => !p.endsWith(".json")) // exclude _tombstones.json
    .map((p) => p.replace(/\/$/, "").split("/").pop())
    .filter(Boolean);

  const notebooks = await Promise.all(
    notebookIds.map((id) => davGet(getNotebookPath(id)).catch(() => null)),
  );
  return notebooks
    .filter((n) => n && !n.deleted)
    .sort((a, b) => b.modified - a.modified);
}

export async function getNotebook(id) {
  return davGet(getNotebookPath(id));
}

export async function updateNotebook(id, updates) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  const updated = { ...notebook, ...updates, modified: Date.now(), version: (notebook.version || 0) + 1 };
  await davPut(getNotebookPath(id), updated);
  console.log("Notebook updated:", id);
  return updated;
}

export async function deleteNotebook(id) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  const updated = { ...notebook, deleted: true, modified: Date.now() };
  await davPut(getNotebookPath(id), updated);

  // Soft-delete all notes in this notebook
  const notes = await getNotesByNotebook(id);
  for (const note of notes) {
    await deleteNote(note.id);
  }
  console.log("Notebook deleted:", id);
  return updated;
}

export async function getDeletedNotebooks() {
  const paths = await davList(`${ROOT_FOLDER}/notebooks`);
  const notebookIds = paths.filter((p) => !p.endsWith(".json")).map((p) => p.replace(/\/$/, "").split("/").pop()).filter(Boolean);
  const notebooks = await Promise.all(notebookIds.map((id) => davGet(getNotebookPath(id)).catch(() => null)));
  return notebooks.filter((n) => n?.deleted);
}

export async function restoreNotebook(id) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  const updated = { ...notebook, deleted: false, modified: Date.now() };
  await davPut(getNotebookPath(id), updated);
  return updated;
}

export async function permanentlyDeleteNotebook(id) {
  await davDelete(getNotebookFolder(id));
}

// ─── Note operations ──────────────────────────────────────────────────────────

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
  await _putNote(note);
  console.log("Note created:", note.id);
  window.dispatchEvent(new CustomEvent("note-created", { detail: { noteId: note.id } }));
  return note;
}

async function _putNote(note) {
  const path = getNotePath(note.id, note.notebookId);
  // Ensure notes folder exists (for quick notes or new notebooks)
  if (note.notebookId) {
    await davMkcol(getNotebookNotesFolder(note.notebookId));
  } else {
    await davMkcol(`${ROOT_FOLDER}/quickNotes`);
  }
  await davPut(path, note);
}

export async function getNote(id) {
  // We need to find which notebook the note belongs to — try quick notes first, then scan notebooks
  // For efficiency, accept notebookId hint via a small in-memory cache populated on getAllNotes
  const cached = _notePathCache.get(id);
  if (cached !== undefined) {
    const note = await davGet(getNotePath(id, cached));
    if (note) { note.tasks = note.tasks || []; return note; }
  }
  // Scan all notebooks
  const note = await _findNote(id);
  if (note) note.tasks = note.tasks || [];
  return note;
}

export async function getNoteIndex(id) {
  return getNote(id);
}

export async function getNoteContent(id) {
  return getNote(id);
}

export async function getRawNote(id) {
  return getNote(id);
}

// Cache: noteId → notebookId (null for quick notes)
const _notePathCache = new Map();

async function _findNote(id) {
  // Try quick notes
  const qn = await davGet(getNotePath(id, null));
  if (qn) { _notePathCache.set(id, null); return qn; }
  // Try all notebooks
  const notebooks = await getAllNotebooks();
  for (const nb of notebooks) {
    const note = await davGet(getNotePath(id, nb.id));
    if (note) { _notePathCache.set(id, nb.id); return note; }
  }
  return null;
}

export async function getAllNotes() {
  const [quickNotes, ...notebookNotes] = await Promise.all([
    _getNotesInFolder(`${ROOT_FOLDER}/quickNotes`, null),
    ...(await getAllNotebooks()).map((nb) => _getNotesInFolder(getNotebookNotesFolder(nb.id), nb.id)),
  ]);
  return [...quickNotes, ...notebookNotes.flat()]
    .filter((n) => !n.deleted)
    .sort((a, b) => b.modified - a.modified);
}

async function _getNotesInFolder(folder, notebookId) {
  const paths = await davList(folder);
  const noteFiles = paths.filter((p) => p.endsWith(".json") && !p.includes("_tombstones"));
  const notes = await Promise.all(noteFiles.map((p) => davGet(p).catch(() => null)));
  return notes.filter(Boolean).map((n) => {
    _notePathCache.set(n.id, notebookId);
    return n;
  });
}

export async function getNotesByNotebook(notebookId) {
  const folder = notebookId ? getNotebookNotesFolder(notebookId) : `${ROOT_FOLDER}/quickNotes`;
  const notes = await _getNotesInFolder(folder, notebookId);
  return notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

export async function getQuickNotes() {
  const notes = await _getNotesInFolder(`${ROOT_FOLDER}/quickNotes`, null);
  return notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

export async function updateNote(id, updates) {
  const existing = await getNote(id);
  if (!existing) throw new Error("Note not found");
  const updated = {
    ...existing,
    ...updates,
    modified: Date.now(),
    version: (existing.version || 0) + 1,
  };
  await _putNote(updated);
  console.log("Note updated:", id);
  window.dispatchEvent(new CustomEvent("datachange", { detail: { noteId: id } }));
  return updated;
}

export async function saveNote(note) {
  await _putNote(note);
  window.dispatchEvent(new CustomEvent("datachange", { detail: { noteId: note.id } }));
}

export async function deleteNote(id) {
  const note = await getNote(id);
  if (!note) throw new Error("Note not found");
  const updated = { ...note, deleted: true, modified: Date.now() };
  await _putNote(updated);
  console.log("Note deleted:", id);
  return updated;
}

export async function permanentlyDeleteNote(id) {
  const note = await getNote(id);
  if (!note) return;
  const path = getNotePath(id, note.notebookId);
  await davDelete(path);
  // Also delete media folder
  await davDelete(getNoteMediaFolder(id, note.notebookId));
  _notePathCache.delete(id);
}

export async function getDeletedNotes() {
  const all = await getAllNotes();
  return all.filter((n) => n.deleted);
}

export async function restoreNote(id) {
  const note = await getNote(id);
  if (!note) throw new Error("Note not found");
  const updated = { ...note, deleted: false, modified: Date.now() };
  await _putNote(updated);
  return updated;
}

export async function moveNote(noteId, targetNotebookId) {
  const note = await getNote(noteId);
  if (!note) throw new Error("Note not found");
  const previousNotebookId = note.notebookId ?? null;
  if (previousNotebookId === (targetNotebookId ?? null)) return;

  // Delete from old location, write to new
  await davDelete(getNotePath(noteId, previousNotebookId));
  const updated = { ...note, notebookId: targetNotebookId ?? null, modified: Date.now() };
  _notePathCache.set(noteId, targetNotebookId ?? null);
  await _putNote(updated);
  console.log(`Note moved: ${noteId} → ${targetNotebookId}`);
}

export async function copyNote(noteId, targetNotebookId) {
  const note = await getNote(noteId);
  if (!note) throw new Error("Note not found");
  const now = Date.now();
  const newNote = {
    ...note,
    id: generateId(),
    notebookId: targetNotebookId ?? null,
    thumbnail: null,
    deletedMedia: [],
    version: 1,
    created: now,
    modified: now,
  };
  await _putNote(newNote);
  console.log(`Note copied: ${noteId} → ${newNote.id}`);
  return newNote;
}

export async function clearNoteMoveFlag(id) {
  const note = await getNote(id);
  if (!note) return;
  delete note.previousNotebookId;
  await _putNote(note);
}

export async function purgeNote(id) {
  return permanentlyDeleteNote(id);
}

export async function permanentlyDeleteNotesInNotebook(notebookId) {
  const notes = await getNotesByNotebook(notebookId);
  for (const note of notes) await permanentlyDeleteNote(note.id);
}

// ─── Media / files ────────────────────────────────────────────────────────────

// fileId → { notebookId, noteId, filename } cache
const _fileCache = new Map();

export async function saveFile(blob, id = null) {
  // Files are stored per-note — caller passes noteId and notebookId via context.
  // For compatibility we store blobs in a flat virtual "files" namespace keyed by id.
  // Actual placement happens in saveMediaForNote().
  const fileId = id || generateId();
  _fileCache.set(fileId, blob);
  return fileId;
}

export async function saveMediaForNote(blob, filename, noteId, notebookId) {
  const folder = getNoteMediaFolder(noteId, notebookId);
  await davMkcol(folder);
  await davPutBinary(getMediaPath(noteId, notebookId, filename), blob);
}

export async function getFile(id) {
  // Return from in-memory cache if available (freshly uploaded)
  if (_fileCache.has(id)) return _fileCache.get(id);
  return null;
}

export async function checkFileExists(id) {
  return _fileCache.has(id);
}

export async function deleteFile(id) {
  _fileCache.delete(id);
}

// ─── Storage stats / admin ────────────────────────────────────────────────────

export async function getStorageStats() {
  return { notes: 0, notebooks: 0, files: 0, settings: 0 };
}

export async function clearAllData() {
  // No-op in NC build — data lives on Nextcloud server
  console.warn("[WebDAV Storage] clearAllData is a no-op in Nextcloud build");
}

export async function purgeLocalData() {
  console.warn("[WebDAV Storage] purgeLocalData is a no-op in Nextcloud build");
}

export async function getStorageVersion() { return 2; }
export async function setStorageVersion() {}

// ─── Encryption stubs (always off in NC build) ───────────────────────────────

export async function isLocalEncryptionEnabled() { return false; }
export async function isNextcloudEncryptionEnabled() { return false; }
export async function fixCorruptedNotes() { return { fixed: 0 }; }
export async function migrateNotesToEncrypted() {}
export async function updateNoteEtag() {}

// ─── Sync stubs (no sync in NC build) ────────────────────────────────────────

export async function getAllNotesForSync() { return []; }
export async function getAllNoteMetadataForSync() { return []; }
export async function getAllNotebooksForSync() { return []; }
export async function purgeNotebook(id) { return permanentlyDeleteNotebook(id); }
export async function saveNotebook(nb) { return updateNotebook(nb.id, nb); }
