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

function assertSafeId(id, kind) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(`Invalid ${kind} id for storage path: ${JSON.stringify(id)}`);
  }
  return id;
}

function assertSafeFilename(filename) {
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

/**
 * Get the folder path for a notebook
 */
export function getNotebookFolder(notebookId) {
  return `${ROOT_FOLDER}/notebooks/${assertSafeId(notebookId, "notebook")}`;
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
 * Get all required folders for the hierarchical structure
 */
export function getAllRequiredFolders() {
  return [ROOT_FOLDER, `${ROOT_FOLDER}/notebooks`, `${ROOT_FOLDER}/quickNotes`];
}

/**
 * Parse a hierarchical path to extract components
 * Returns: { type: 'notebook' | 'note' | 'media' | 'tombstone', notebookId, noteId, filename }
 */
export function parsePath(path) {
  const parts = path.replace(`${ROOT_FOLDER}/`, "").split("/");

  if (parts[0] === "notebooks") {
    const notebookId = parts[1];

    if (notebookId === "_tombstones.json") {
      return { type: "tombstone", notebookId: "global_notebooks" };
    }

    if (parts[2] === "_notebook.json") {
      return { type: "notebook", notebookId };
    }

    if (parts[2] === "_tombstones.json") {
      return { type: "tombstone", notebookId };
    }

    if (parts[2] === "notes" && parts[3]) {
      const noteFile = parts[3];

      if (noteFile.endsWith(".json")) {
        const noteId = noteFile.replace(".json", "");
        return { type: "note", notebookId, noteId };
      }

      if (noteFile.endsWith("_media") && parts[4]) {
        const noteId = noteFile.replace("_media", "");
        const filename = parts[4];
        return { type: "media", notebookId, noteId, filename };
      }
    }
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

/**
 * Legacy flat structure paths (for migration)
 */
export function getLegacyNotebookPath(notebookId) {
  return `${ROOT_FOLDER}/notebook_${assertSafeId(notebookId, "notebook")}.json`;
}

export function getLegacyNotePath(noteId) {
  return `${ROOT_FOLDER}/note_${assertSafeId(noteId, "note")}.json`;
}
