/**
 * Storage Paths Module
 * Manages hierarchical file paths for Nextcloud sync
 *
 * Structure:
 * /NoteBerg/
 *   ├── notebooks/
 *   │   ├── {notebookId}/
 *   │   │   ├── _notebook.json
 *   │   │   ├── _tombstones.json
 *   │   │   └── notes/
 *   │   │       ├── {noteId}.json
 *   │   │       └── {noteId}_media/
 *   │   │           ├── {filename}.jpg
 *   │   │           └── {filename}.mp3
 *   │   └── ...
 *   └── quickNotes/
 *       ├── {noteId}.json
 *       └── _tombstones.json
 */

export const STORAGE_VERSION = 2; // Hierarchical structure
export const ROOT_FOLDER = "/NoteBerg";

// ─── Path-segment validation ──────────────────────────────────────────────────
// Note/notebook ids and media filenames end up in WebDAV URLs for PUT/DELETE/MOVE.
// Ids parsed from *downloaded* JSON are untrusted — an id like "../../Photos"
// would steer writes/deletes outside the NoteBerg folder. App-generated ids are
// always UUIDs, so a strict charset check loses nothing.

const SAFE_ID = /^[\w-]{1,64}$/;

/**
 * Assert that an id is safe to embed in a storage path. Exported because the
 * backup restore path parses ids out of an untrusted archive and must reject
 * the archive on the first violation (see restore.js).
 */
export function assertSafeId(id, kind) {
  if (!isSafeId(id)) {
    throw new Error(`Invalid ${kind} id for storage path: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Whether an id is safe to embed in a storage path (and in markup: word characters and "-" only). */
export function isSafeId(id) {
  return typeof id === "string" && SAFE_ID.test(id);
}

export function assertSafeFilename(filename) {
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    throw new Error(`Invalid filename for storage path: ${JSON.stringify(filename)}`);
  }
  return filename;
}

// ─── Shared notebook bases ────────────────────────────────────────────────────
// A notebook shared WITH this user lives under a folder the sharer's Nextcloud
// mounted for us (its OCS `file_target`), not under ROOT_FOLDER. Every helper
// below resolves the notebook folder through getNotebookFolder(), so registering
// a base here redirects all of them at once and no call site passes a base path.
//
// Own notebooks are never registered: an unregistered id resolves exactly as
// before. An id whose share ended throws instead — falling back to the own tree
// would make a late write recreate the sharer's notebook inside this user's own
// storage.

const MAX_BASE_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

/** Control characters and backslashes have no business in a path segment. */
function hasUnsafeChar(segment) {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

const sharedBases = new Map(); // notebookId -> base path
const endedShares = new Set(); // notebookIds whose share is gone

/**
 * Validate a base path that came from the server (OCS `file_target`).
 * Absolute, made of ordinary segments, nothing that could climb out of the DAV
 * root or smuggle a control character into a URL.
 * @returns {string} the path without a trailing slash
 */
export function validateBasePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > MAX_BASE_PATH_LENGTH) {
    throw new Error(`Invalid shared notebook path: ${JSON.stringify(path)}`);
  }
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const segments = trimmed.split("/").slice(1);
  const valid =
    segments.length > 0 &&
    segments.every(
      (seg) =>
        seg.length > 0 &&
        seg.length <= MAX_SEGMENT_LENGTH &&
        seg !== "." &&
        seg !== ".." &&
        !hasUnsafeChar(seg),
    );
  if (!valid) throw new Error(`Invalid shared notebook path: ${JSON.stringify(path)}`);
  return trimmed;
}

/**
 * Replace the registry of shared notebook bases.
 * @param {Map<string, string>} bases - notebookId -> base path
 */
export function setSharedNotebookBases(bases) {
  const next = new Map();
  for (const [id, base] of bases) {
    assertSafeId(id, "notebook");
    next.set(id, validateBasePath(base));
  }
  sharedBases.clear();
  for (const [id, base] of next) {
    sharedBases.set(id, base);
    endedShares.delete(id); // a re-registered share is live again
  }
}

/** Stop resolving a notebook: its share is gone. Later path lookups throw. */
export function markShareEnded(notebookId) {
  assertSafeId(notebookId, "notebook");
  sharedBases.delete(notebookId);
  endedShares.add(notebookId);
}

/** Whether a notebook's share has ended (its paths no longer resolve). */
export function isShareEnded(notebookId) {
  return endedShares.has(notebookId);
}

/** Forget every registration, including ended shares. */
export function clearSharedNotebookBases() {
  sharedBases.clear();
  endedShares.clear();
}

/** The registered base of a shared notebook, or null for an own (or unknown) one. */
export function getSharedNotebookBase(notebookId) {
  return sharedBases.get(notebookId) ?? null;
}

/**
 * Get the folder path for a notebook
 * @throws when the notebook's share has ended
 */
export function getNotebookFolder(notebookId) {
  assertSafeId(notebookId, "notebook");
  if (endedShares.has(notebookId)) {
    throw new Error(`The share of notebook ${notebookId} has ended`);
  }
  return sharedBases.get(notebookId) ?? `${ROOT_FOLDER}/notebooks/${notebookId}`;
}

/**
 * Get the path for a notebook metadata file
 */
export function getNotebookPath(notebookId) {
  return `${getNotebookFolder(notebookId)}/_notebook.json`;
}

/**
 * Get the folder path for notes within a notebook
 */
export function getNotebookNotesFolder(notebookId) {
  return `${getNotebookFolder(notebookId)}/notes`;
}

/**
 * Get the path for a note file within a notebook
 */
export function getNotePath(noteId, notebookId) {
  assertSafeId(noteId, "note");
  if (notebookId) {
    return `${getNotebookNotesFolder(notebookId)}/${noteId}.json`;
  }
  // Quick note (no notebook)
  return `${ROOT_FOLDER}/quickNotes/${noteId}.json`;
}

/**
 * Get the folder path for a note's media files
 */
export function getNoteMediaFolder(noteId, notebookId) {
  assertSafeId(noteId, "note");
  if (notebookId) {
    return `${getNotebookNotesFolder(notebookId)}/${noteId}_media`;
  }
  return `${ROOT_FOLDER}/quickNotes/${noteId}_media`;
}

/**
 * Get the path for a media file within a note
 */
export function getMediaPath(noteId, notebookId, filename) {
  return `${getNoteMediaFolder(noteId, notebookId)}/${assertSafeFilename(filename)}`;
}

/**
 * Get the path for a notebook's tombstone file
 */
export function getNotebookTombstonePath(notebookId) {
  return `${getNotebookFolder(notebookId)}/_tombstones.json`;
}

/**
 * Get the path for quick notes tombstone file
 */
export function getQuickNotesTombstonePath() {
  return `${ROOT_FOLDER}/quickNotes/_tombstones.json`;
}

/**
 * Get the path for the global notebook tombstone file
 */
export function getGlobalNotebookTombstonePath() {
  return `${ROOT_FOLDER}/notebooks/_tombstones.json`;
}

/**
 * Strip the root folder from a full storage path, giving the path relative to
 * the NoteBerg root — the form used for entry names inside a backup archive.
 * @param {string} path - A path produced by one of the builders above
 * @returns {string}
 */
export function toRootRelativePath(path) {
  const prefix = `${ROOT_FOLDER}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Get all required folders for the hierarchical structure
 */
export function getAllRequiredFolders() {
  return [ROOT_FOLDER, `${ROOT_FOLDER}/notebooks`, `${ROOT_FOLDER}/quickNotes`];
}

/**
 * Parse a path relative to one notebook's folder:
 *   _notebook.json | _tombstones.json | notes/{id}.json | notes/{id}_media/{file}
 * Returns: { type: 'notebook' | 'note' | 'media' | 'tombstone' | 'unknown', notebookId, noteId, filename }
 */
export function parseNotebookRelativePath(relPath, notebookId) {
  const parts = relPath.split("/");

  if (parts.length === 1 && parts[0] === "_notebook.json") return { type: "notebook", notebookId };
  if (parts.length === 1 && parts[0] === "_tombstones.json") {
    return { type: "tombstone", notebookId };
  }

  if (parts[0] === "notes" && parts[1]) {
    const noteFile = parts[1];

    if (noteFile.endsWith(".json")) {
      return { type: "note", notebookId, noteId: noteFile.slice(0, -".json".length) };
    }

    if (noteFile.endsWith("_media") && parts[2]) {
      return {
        type: "media",
        notebookId,
        noteId: noteFile.slice(0, -"_media".length),
        filename: parts[2],
      };
    }
  }

  return { type: "unknown" };
}

/**
 * Parse a path in the own tree (below ROOT_FOLDER) to extract components.
 * Notebooks shared with this user live elsewhere and are parsed with
 * parseNotebookRelativePath, the notebook id being known from the registry.
 * Returns: { type: 'notebook' | 'note' | 'media' | 'tombstone', notebookId, noteId, filename }
 */
export function parsePath(path) {
  const parts = path.replace(`${ROOT_FOLDER}/`, "").split("/");

  if (parts[0] === "notebooks") {
    const notebookId = parts[1];

    if (notebookId === "_tombstones.json") {
      return { type: "tombstone", notebookId: "global_notebooks" };
    }

    const parsed = parseNotebookRelativePath(parts.slice(2).join("/"), notebookId);
    if (parsed.type !== "unknown") return parsed;
  }

  if (parts[0] === "quickNotes") {
    if (parts[1] === "_tombstones.json") {
      return { type: "tombstone" };
    }

    if (parts[1]?.endsWith(".json")) {
      const noteId = parts[1].replace(".json", "");
      return { type: "note", noteId };
    }

    if (parts[1]?.endsWith("_media") && parts[2]) {
      const noteId = parts[1].replace("_media", "");
      const filename = parts[2];
      return { type: "media", noteId, filename };
    }
  }

  return { type: "unknown" };
}

// ─── DAV hrefs ────────────────────────────────────────────────────────────────

const DAV_FILES_PREFIX = /\/remote\.php\/dav\/files\/[^/]+(\/.*)?$/i;

/**
 * Turn a PROPFIND `href` into a path in the user's file tree
 * (e.g. `/NoteBerg/notebooks/...` or `/Shared_NoteBerg/...`).
 *
 * Strips the DAV files prefix — including any web-root before it and whatever
 * case the server reports the uid in — rather than searching for ROOT_FOLDER
 * inside the href, which mis-parsed a user whose uid is "NoteBerg".
 */
export function davHrefToPath(href) {
  const match = href.match(DAV_FILES_PREFIX);
  return decodeURIComponent(match ? (match[1] ?? "/") : href);
}

/**
 * A path of the user's file tree as it goes into a WebDAV URL: every segment
 * percent-encoded. Paths in the app are always plain text; own-tree paths are
 * made of safe ids, but a shared notebook's folder is wherever Nextcloud mounted
 * it or the user moved it, so its name can hold "#", "%", "?" or spaces, which
 * would otherwise end or garble the URL.
 */
export function encodeDavPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** True when `path` is `root` or lies below it (compared by whole segments). */
export function isPathWithin(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Legacy flat structure paths (for migration)
 */
export function getLegacyNotebookPath(notebookId) {
  return `${ROOT_FOLDER}/notebook_${assertSafeId(notebookId, "notebook")}.json`;
}

export function getLegacyNotePath(noteId) {
  return `${ROOT_FOLDER}/note_${assertSafeId(noteId, "note")}.json`;
}
