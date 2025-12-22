/**
 * Storage Paths Module
 * Manages hierarchical file paths for Nextcloud sync
 *
 * Structure:
 * /oneJournal/
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
export const ROOT_FOLDER = "/oneJournal";

/**
 * Get the folder path for a notebook
 */
export function getNotebookFolder(notebookId) {
  return `${ROOT_FOLDER}/notebooks/${notebookId}`;
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
  if (notebookId) {
    return `${getNotebookNotesFolder(notebookId)}/${noteId}_media`;
  }
  return `${ROOT_FOLDER}/quickNotes/${noteId}_media`;
}

/**
 * Get the path for a media file within a note
 */
export function getMediaPath(noteId, notebookId, filename) {
  return `${getNoteMediaFolder(noteId, notebookId)}/${filename}`;
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
  return `${ROOT_FOLDER}/notebook_${notebookId}.json`;
}

export function getLegacyNotePath(noteId) {
  return `${ROOT_FOLDER}/note_${noteId}.json`;
}
