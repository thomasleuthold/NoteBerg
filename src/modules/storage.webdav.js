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
  getGlobalNotebookTombstonePath,
  getMediaPath,
  getNotebookFolder,
  getNotebookNotesFolder,
  getNotebookPath,
  getNotebookTombstonePath,
  getNoteMediaFolder,
  getNotePath,
  getQuickNotesTombstonePath,
  ROOT_FOLDER,
} from "./storagePaths.js";
import {
  addMediaTombstone,
  addNotebookTombstone,
  addNoteTombstone,
  cleanupOldTombstones,
  createEmptyTombstone,
} from "./tombstones.js";

// ─── Tombstone helpers ─────────────────────────────────────────────────────────

async function _readTombstone(path) {
  const data = await davGet(path);
  return data || createEmptyTombstone();
}

async function _writeTombstone(path, tombstone) {
  cleanupOldTombstones(tombstone);
  await davPut(path, tombstone);
}

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
  try {
    return await res.json();
  } catch (e) {
    console.error(`[WebDAV] JSON parse failed for ${path}:`, e);
    return null;
  }
}

async function davPutWithRetry(path, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${getWebDAVBase()}${path}`, options);
    if (res.ok) return;
    // 423 Locked — Nextcloud file lock, wait and retry
    if (res.status === 423 && i < retries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      continue;
    }
    throw new Error(`DAV PUT ${path} failed: ${res.status}`);
  }
}

async function davPut(path, data) {
  await davPutWithRetry(path, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: JSON.stringify(data),
  });
}

async function davPutBinary(path, blob) {
  await davPutWithRetry(path, {
    method: "PUT",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: blob,
  });
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

async function davExists(path) {
  const res = await fetch(`${getWebDAVBase()}${path}`, {
    method: "PROPFIND",
    headers: {
      Depth: "0",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  return res.ok || res.status === 207;
}

async function davMkcol(path) {
  if (_knownFolders.has(path)) return; // already confirmed to exist
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
  _knownFolders.add(path);
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
  const _base = `/remote.php/dav/files/`;
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
// Track folders confirmed to exist so we skip redundant MKCOL requests
const _knownFolders = new Set();

const _INIT_KEY = "noteberg_webdav_initialized";

export async function initStorage() {
  if (_initialized) return;
  // Always verify root folder exists before trusting the localStorage flag.
  // The flag is an optimisation to skip MKCOL on every load, but if the folder
  // was deleted (uninstall, manual cleanup) we must recreate it.
  const rootExists = await davExists(ROOT_FOLDER);
  if (!rootExists) {
    localStorage.removeItem(_INIT_KEY);
  }
  if (!localStorage.getItem(_INIT_KEY)) {
    for (const folder of getAllRequiredFolders()) {
      await davMkcol(folder);
    }
    localStorage.setItem(_INIT_KEY, "1");
  } else {
    // Pre-populate cache so davMkcol skips these folders if called again this session
    for (const folder of getAllRequiredFolders()) {
      _knownFolders.add(folder);
    }
  }
  _initialized = true;
  console.log("Storage initialized (WebDAV)");
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
  window.dispatchEvent(
    new CustomEvent("notebook-created", { detail: { notebookId: notebook.id } }),
  );
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
  return notebooks.filter((n) => n && !n.deleted).sort((a, b) => b.modified - a.modified);
}

export async function getNotebook(id) {
  return davGet(getNotebookPath(id));
}

export async function updateNotebook(id, updates) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  const updated = {
    ...notebook,
    ...updates,
    modified: Date.now(),
    version: (notebook.version || 0) + 1,
  };
  await davPut(getNotebookPath(id), updated);
  console.log("Notebook updated:", id);
  return updated;
}

export async function deleteNotebook(id) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  const updated = { ...notebook, deleted: true, modified: Date.now() };
  await davPut(getNotebookPath(id), updated);

  // Write global notebook tombstone so other devices know this notebook was deleted
  const globalTombstone = await _readTombstone(getGlobalNotebookTombstonePath());
  addNotebookTombstone(globalTombstone, id);
  await _writeTombstone(getGlobalNotebookTombstonePath(), globalTombstone);

  // Soft-delete all notes in this notebook (each deleteNote writes its own tombstone)
  const notes = await getNotesByNotebook(id);
  for (const note of notes) {
    await deleteNote(note.id);
  }
  console.log("Notebook deleted:", id);
  return updated;
}

export async function getDeletedNotebooks() {
  const paths = await davList(`${ROOT_FOLDER}/notebooks`);
  const notebookIds = paths
    .filter((p) => !p.endsWith(".json"))
    .map((p) => p.replace(/\/$/, "").split("/").pop())
    .filter(Boolean);
  const notebooks = await Promise.all(
    notebookIds.map((id) => davGet(getNotebookPath(id)).catch(() => null)),
  );
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
  // Write global notebook tombstone before deleting the folder
  const globalTombstone = await _readTombstone(getGlobalNotebookTombstonePath());
  addNotebookTombstone(globalTombstone, id);
  await _writeTombstone(getGlobalNotebookTombstonePath(), globalTombstone);
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
    if (note) {
      note.tasks = note.tasks || [];
      await _cacheFileLocations(note);
      return note;
    }
  }
  // Scan all notebooks
  const note = await _findNote(id);
  if (note) {
    note.tasks = note.tasks || [];
    await _cacheFileLocations(note);
  }
  return note;
}

async function _cacheFileLocations(note) {
  const notebookId = note.notebookId ?? null;
  const fileIds = [
    ...(note.media || []).map((m) => m.fileId),
    note.pdfSource,
    ...(note.recordings || []).map((r) => r.fileId),
  ].filter(Boolean);

  if (fileIds.length === 0) return;

  // Check if all fileIds already have ext resolved — skip folder listing if so
  const needsResolution = fileIds.some((fid) => !_fileLocationCache.get(fid)?.ext);
  if (!needsResolution) return;

  // List the media folder once to resolve all extensions in one request
  const mediaFolder = getNoteMediaFolder(note.id, notebookId);
  const files = await davList(mediaFolder).catch(() => []);

  for (const fileId of fileIds) {
    if (_fileLocationCache.get(fileId)?.ext) continue; // already resolved

    const match = files.find((p) => {
      const name = p.replace(/\/$/, "").split("/").pop();
      return name === fileId || name.startsWith(`${fileId}.`);
    });

    if (match) {
      const name = match.replace(/\/$/, "").split("/").pop();
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      _fileLocationCache.set(fileId, { noteId: note.id, notebookId, ext });
    } else {
      // File not on server yet (e.g. just created, not yet uploaded)
      _fileLocationCache.set(fileId, { noteId: note.id, notebookId, ext: null });
    }
  }
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
  if (qn) {
    _notePathCache.set(id, null);
    return qn;
  }
  // Try all notebooks
  const notebooks = await getAllNotebooks();
  for (const nb of notebooks) {
    const note = await davGet(getNotePath(id, nb.id));
    if (note) {
      _notePathCache.set(id, nb.id);
      return note;
    }
  }
  return null;
}

export async function getAllNotes() {
  const [quickNotes, ...notebookNotes] = await Promise.all([
    _getNotesInFolder(`${ROOT_FOLDER}/quickNotes`, null),
    ...(await getAllNotebooks()).map((nb) =>
      _getNotesInFolder(getNotebookNotesFolder(nb.id), nb.id),
    ),
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

// Per-note write queue — prevents concurrent PUTs to the same file (WebDAV 423 Locked)
const _writeQueues = new Map(); // noteId → Promise

function _enqueueWrite(id, fn) {
  const prev = _writeQueues.get(id) ?? Promise.resolve();
  // Always run fn after the previous write settles (success or failure)
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  _writeQueues.set(id, next);
  next.finally(() => {
    if (_writeQueues.get(id) === next) _writeQueues.delete(id);
  });
  return next;
}

export function updateNote(id, updates) {
  return _enqueueWrite(id, async () => {
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
    window.dispatchEvent(
      new CustomEvent("datachange", { detail: { noteId: id, source: "local" } }),
    );
    return updated;
  });
}

export async function saveNote(note) {
  await _putNote(note);
  window.dispatchEvent(
    new CustomEvent("datachange", { detail: { noteId: note.id, source: "local" } }),
  );
}

export async function deleteNote(id) {
  const note = await getNote(id);
  if (!note) throw new Error("Note not found");
  const updated = { ...note, deleted: true, modified: Date.now() };
  await _putNote(updated);

  // Write tombstone so other devices know this note was deleted
  const tombstonePath = note.notebookId
    ? getNotebookTombstonePath(note.notebookId)
    : getQuickNotesTombstonePath();
  const tombstone = await _readTombstone(tombstonePath);
  addNoteTombstone(tombstone, id);
  await _writeTombstone(tombstonePath, tombstone);

  console.log("Note deleted:", id);
  return updated;
}

export async function permanentlyDeleteNote(id) {
  const note = await getNote(id);
  if (!note) return;

  // Write tombstone for media files before deleting them
  const tombstonePath = note.notebookId
    ? getNotebookTombstonePath(note.notebookId)
    : getQuickNotesTombstonePath();
  const tombstone = await _readTombstone(tombstonePath);
  addNoteTombstone(tombstone, id);
  for (const item of note.media || []) {
    if (item.fileId) addMediaTombstone(tombstone, id, item.fileId);
  }
  await _writeTombstone(tombstonePath, tombstone);

  const path = getNotePath(id, note.notebookId);
  await davDelete(path);
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

const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "audio/webm": ".webm",
  "audio/webm;codecs=opus": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

function _extFromMime(type) {
  return MIME_TO_EXT[type] || ".bin";
}

// Mirror sync's lookup: find first MIME type matching the extension
function _mimeFromExt(ext) {
  return (
    Object.keys(MIME_TO_EXT).find((key) => MIME_TO_EXT[key] === ext) || "application/octet-stream"
  );
}

// Detect MIME type from magic bytes when the blob has no useful type
async function _sniffMime(blob) {
  const buf = await blob.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  // WebM magic: 0x1A 0x45 0xDF 0xA3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  return null;
}

async function _ensureMimeType(blob, ext) {
  const usefulType = blob.type && blob.type !== "application/octet-stream";
  if (usefulType) return blob;
  // Try extension first (mirrors sync's approach), then magic bytes as fallback
  if (ext) {
    const mime = _mimeFromExt(ext);
    if (mime !== "application/octet-stream") return new Blob([blob], { type: mime });
  }
  const sniffed = await _sniffMime(blob);
  if (sniffed) return new Blob([blob], { type: sniffed });
  return blob;
}

// fileId → blob (in-memory cache for freshly uploaded files)
const _fileCache = new Map();
// fileId → { noteId, notebookId, ext } (persists for lifetime of page so getFile can fetch WebDAV)
const _fileLocationCache = new Map();

export async function saveFile(blob, id = null) {
  // Files are stored per-note — caller passes noteId and notebookId via context.
  // For compatibility we store blobs in a flat virtual "files" namespace keyed by id.
  // Actual placement happens in saveMediaForNote().
  const fileId = id || generateId();
  _fileCache.set(fileId, blob);
  return fileId;
}

export async function saveMediaForNote(blob, fileId, noteId, notebookId) {
  const ext = _extFromMime(blob.type);
  const filename = `${fileId}${ext}`;
  const folder = getNoteMediaFolder(noteId, notebookId);
  await davMkcol(folder);
  await davPutBinary(getMediaPath(noteId, notebookId, filename), blob);
  // Record location so getFile() can fetch from WebDAV after a page reload
  _fileLocationCache.set(fileId, { noteId, notebookId, ext });
  _fileCache.set(fileId, blob);
}

export async function getFile(id) {
  // Return from in-memory cache if available (freshly uploaded or already fetched)
  if (_fileCache.has(id)) return _fileCache.get(id);

  // Try to fetch from WebDAV using the recorded location (known ext)
  const loc = _fileLocationCache.get(id);
  if (loc?.ext) {
    const filename = `${id}${loc.ext}`;
    const raw = await davGetBinary(getMediaPath(loc.noteId, loc.notebookId, filename)).catch(
      () => null,
    );
    if (raw) {
      const blob = await _ensureMimeType(raw, loc.ext);
      _fileCache.set(id, blob);
      return blob;
    }
  }

  // Location not known in this session — scan the note's media folder to find the file by prefix.
  // This happens after a page reload. First try to find the note via _notePathCache / scan.
  const allNotes = await getAllNotes();
  for (const note of allNotes) {
    const notebookId = note.notebookId ?? null;
    const fileIds = [
      ...(note.media || []).map((m) => m.fileId),
      note.pdfSource,
      ...(note.recordings || []).map((r) => r.fileId),
    ].filter(Boolean);

    if (!fileIds.includes(id)) continue;

    // List the media folder to find the actual filename (with extension)
    const mediaFolder = getNoteMediaFolder(note.id, notebookId);
    const files = await davList(mediaFolder).catch(() => []);
    const match = files.find((p) => {
      const name = p.replace(/\/$/, "").split("/").pop();
      return name === id || name.startsWith(`${id}.`);
    });

    if (match) {
      const raw = await davGetBinary(match).catch(() => null);
      if (raw) {
        const name = match.replace(/\/$/, "").split("/").pop();
        const dotIdx = name.lastIndexOf(".");
        const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
        // Ensure blob has correct MIME type (Nextcloud serves extensionless files as octet-stream)
        const blob = await _ensureMimeType(raw, ext);
        _fileLocationCache.set(id, { noteId: note.id, notebookId, ext });
        _fileCache.set(id, blob);
        return blob;
      }
    }
  }

  return null;
}

export async function checkFileExists(id) {
  if (_fileCache.has(id)) return true;
  const loc = _fileLocationCache.get(id);
  return loc?.ext != null; // only true if ext was resolved (file confirmed on server)
}

export async function deleteFile(id) {
  _fileCache.delete(id);
  _fileLocationCache.delete(id);
}

/**
 * Returns a direct WebDAV URL for a file, or null if the location is not known.
 * Used by NC build to set <audio src> directly (avoids blob: URL which is blocked by NC CSP media-src).
 */
export function getFileUrl(id) {
  const loc = _fileLocationCache.get(id);
  if (!loc?.ext) return null;
  return `${getWebDAVBase()}${getMediaPath(loc.noteId, loc.notebookId, `${id}${loc.ext}`)}`;
}

// Pending upload promises: fileId → Promise — lets callers await upload completion
const _pendingUploads = new Map();

export function registerPendingUpload(fileId, promise) {
  _pendingUploads.set(
    fileId,
    promise.finally(() => _pendingUploads.delete(fileId)),
  );
}

/**
 * Waits for any in-flight upload for this fileId to complete, then returns the WebDAV URL.
 * Returns null if no URL can be determined.
 */
export async function waitForFileUrl(id) {
  const pending = _pendingUploads.get(id);
  if (pending) await pending.catch(() => {});
  return getFileUrl(id);
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

export async function getStorageVersion() {
  return 2;
}
export async function setStorageVersion() {}

// ─── Encryption stubs (always off in NC build) ───────────────────────────────

export async function isLocalEncryptionEnabled() {
  return false;
}
export async function isNextcloudEncryptionEnabled() {
  return false;
}
export async function fixCorruptedNotes() {
  return { fixed: 0 };
}
export async function migrateNotesToEncrypted() {}
export async function updateNoteEtag() {}

// ─── Sync stubs (no sync in NC build) ────────────────────────────────────────

export async function getAllNotesForSync() {
  return [];
}
export async function getAllNoteMetadataForSync() {
  return [];
}
export async function getAllNotebooksForSync() {
  return [];
}
export async function purgeNotebook(id) {
  return permanentlyDeleteNotebook(id);
}
export async function saveNotebook(nb) {
  return updateNotebook(nb.id, nb);
}
