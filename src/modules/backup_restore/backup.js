/**
 * Backup Module
 *
 * Walks local storage and streams it into an archive as an ordered sequence of
 * entries — one entry per notebook, note, or media blob. Pure domain logic: no
 * UI and no Tauri. The archive is an object with `addText(name, text)` and
 * `addBinary(name, blob)`; backupArchive.js provides the real one (a Rust zip
 * writer behind an IPC boundary) and an in-memory one for tests.
 *
 * Archive layout is deliberately the Nextcloud sync layout (storagePaths.js)
 * minus the root folder, so the same path builders and id validators apply and
 * a backup is inspectable by hand:
 *
 *   manifest.json
 *   notebooks/{notebookId}/_notebook.json
 *   notebooks/{notebookId}/notes/{noteId}.json
 *   notebooks/{notebookId}/notes/{noteId}_media/{fileId}.{ext}
 *   quickNotes/{noteId}.json
 *   quickNotes/{noteId}_media/{fileId}.{ext}
 *
 * Notes are written decrypted (getNote() decrypts locally-encrypted content),
 * exactly as the Nextcloud upload path does: a backup that stored locally
 * encrypted blobs would be unreadable after a master-password reset, which is
 * precisely when a backup is needed. The optional archive password is the
 * protection layer instead.
 *
 * No tombstones: they are sync bookkeeping, and restoring stale ones would
 * resurrect deletions as sync instructions. Soft-deleted (recycle bin) items
 * are included with their `deleted` flag; purged stubs are not.
 */

import { extFromMime } from "../mime.js";
import {
  DB_VERSION,
  getAllNotebooksForSync,
  getAllNotesForSync,
  getFile,
  getFileStats,
  getNote,
  getSetting,
  getStorageStats,
  setSetting,
} from "../storage.js";
import { getMediaPath, getNotebookPath, getNotePath, toRootRelativePath } from "../storagePaths.js";

/** Backup format version. Bump when the archive layout changes. */
export const BACKUP_SCHEMA = 1;
export const MANIFEST_NAME = "manifest.json";

/**
 * Fields that describe sync state, not content. Never written to an archive,
 * and stripped again on restore (restore.js) so a hand-made archive cannot
 * smuggle them in.
 */
export const SYNC_ONLY_FIELDS = [
  "lastSyncedEtag",
  "synced",
  "encrypted",
  "_currentFileEtag",
  "previousNotebookId",
  "restoredAt",
];

/** Thrown when the caller's cancellation flag is raised mid-run. */
export class BackupCancelledError extends Error {
  constructor() {
    super("Backup cancelled");
    this.name = "BackupCancelledError";
  }
}

// ─── Entry shaping ────────────────────────────────────────────────────────────

/**
 * The note as it goes into the archive: sync-tracking fields stripped, content
 * as-is. Mirrors the Nextcloud upload path's `noteForUpload`.
 */
export function noteForArchive(note) {
  const copy = { ...note };
  for (const field of SYNC_ONLY_FIELDS) delete copy[field];
  return copy;
}

/** The notebook as it goes into the archive. */
export function notebookForArchive(notebook) {
  const copy = { ...notebook };
  for (const field of SYNC_ONLY_FIELDS) delete copy[field];
  return copy;
}

/**
 * Every blob a note references, each fileId once. pdf-page media items all
 * share one fileId (the source PDF), so without deduplication a 500-page PDF
 * note would write the same binary 500 times — the same guard syncNoteMedia
 * uses. Order: media, PDF source, recordings.
 */
export function collectNoteFileIds(note) {
  const seen = new Set();
  const ids = [];
  const add = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  if (Array.isArray(note.media)) for (const item of note.media) add(item?.fileId);
  add(note.pdfSource);
  if (Array.isArray(note.recordings)) {
    for (const rec of note.recordings) if (!rec?.deleted) add(rec?.fileId);
  }
  return ids;
}

/** Archive entry name for a media blob: `{fileId}{ext}` under the note's media folder. */
export function mediaEntryName(noteId, notebookId, fileId, mimeType) {
  return toRootRelativePath(getMediaPath(noteId, notebookId, `${fileId}${extFromMime(mimeType)}`));
}

export function noteEntryName(noteId, notebookId) {
  return toRootRelativePath(getNotePath(noteId, notebookId));
}

export function notebookEntryName(notebookId) {
  return toRootRelativePath(getNotebookPath(notebookId));
}

/** Suggested file name for a new backup: `noteberg-backup-YYYY-MM-DDTHH-MM.zip`. */
export function suggestedBackupFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}`;
  return `noteberg-backup-${stamp}.zip`;
}

// ─── The run ──────────────────────────────────────────────────────────────────

/**
 * Write the whole local corpus into `archive`.
 *
 * Order: notebooks, then notes (each followed by its media), then the manifest
 * last — its counts and byte total are exact because they are tallied on the
 * way. Progress is reported per notebook/note with a detail string naming the
 * media file currently being written, so one 200-page PDF does not read as a
 * hang while the counter sits still.
 *
 * @param {{addText: Function, addBinary: Function}} archive - both return the bytes written
 * @param {object} [options]
 * @param {(p: {current: number, total: number, phase: string, detail?: string}) => void} [options.onProgress]
 * @param {() => boolean} [options.isCancelled] - polled between entries
 * @param {string} [options.appVersion]
 * @param {boolean} [options.encrypted] - recorded in the manifest
 * @returns {Promise<object>} the manifest that was written
 */
export async function runBackup(archive, options = {}) {
  const {
    onProgress = () => {},
    isCancelled = () => false,
    appVersion = "",
    encrypted = false,
  } = options;

  const checkCancelled = () => {
    if (isCancelled()) throw new BackupCancelledError();
  };

  const notebooks = (await getAllNotebooksForSync()).filter((nb) => !nb.purged);
  const noteIndexes = (await getAllNotesForSync()).filter((n) => !n.purged);
  const total = notebooks.length + noteIndexes.length;
  let current = 0;
  let totalBytes = 0;
  let fileCount = 0;

  for (const notebook of notebooks) {
    checkCancelled();
    onProgress({ current, total, phase: "notebook" });
    const text = JSON.stringify(notebookForArchive(notebook), null, 2);
    totalBytes += await archive.addText(notebookEntryName(notebook.id), text);
    current++;
  }

  for (const index of noteIndexes) {
    checkCancelled();
    onProgress({ current, total, phase: "note" });

    // Full note, decrypted — throws when local encryption is on and the app is
    // locked, which is the right outcome: a backup must never contain
    // ciphertext the user cannot read back.
    const note = await getNote(index.id);
    if (!note) {
      current++;
      continue;
    }

    // Media first, so a reader that stops early never sees a note whose blobs
    // are missing.
    for (const fileId of collectNoteFileIds(note)) {
      checkCancelled();
      const blob = await getFile(fileId);
      if (!blob) {
        // Id only — never log content.
        console.warn(`[Backup] Missing local file ${fileId} for note ${note.id}, skipping`);
        continue;
      }
      const name = mediaEntryName(note.id, note.notebookId, fileId, blob.type);
      onProgress({ current, total, phase: "media", detail: name.split("/").pop() });
      totalBytes += await archive.addBinary(name, blob);
      fileCount++;
    }

    const text = JSON.stringify(noteForArchive(note), null, 2);
    totalBytes += await archive.addText(noteEntryName(note.id, note.notebookId), text);
    current++;
  }

  checkCancelled();
  onProgress({ current, total, phase: "finalize" });

  const manifest = {
    schema: BACKUP_SCHEMA,
    appVersion,
    dbVersion: DB_VERSION,
    createdAt: Date.now(),
    encrypted,
    counts: { notebooks: notebooks.length, notes: noteIndexes.length, files: fileCount },
    totalBytes,
  };
  await archive.addText(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  return manifest;
}

// ─── Freshness state ──────────────────────────────────────────────────────────
//
// Local-only bookkeeping in the settings store: never synced, never part of an
// archive. Written on success only — a cancelled or failed backup must not move
// the timestamp, or the feature would lie about the one thing it guarantees.

export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_LAST_AT = "lastBackupAt";
const KEY_LAST_NOTES = "lastBackupNoteCount";
const KEY_LAST_BYTES = "lastBackupBytes";
const KEY_LAST_ENCRYPTED = "lastBackupEncrypted";
const KEY_ENCRYPT_DEFAULT = "backupEncryptByDefault";

/** Persist a completed backup. Only ever called after the archive is safely written. */
export async function recordBackupSuccess({ noteCount, bytes, encrypted, at = Date.now() }) {
  await setSetting(KEY_LAST_AT, at);
  await setSetting(KEY_LAST_NOTES, noteCount);
  await setSetting(KEY_LAST_BYTES, bytes);
  await setSetting(KEY_LAST_ENCRYPTED, Boolean(encrypted));
  await setSetting(KEY_ENCRYPT_DEFAULT, Boolean(encrypted));
}

/** @returns {Promise<{lastBackupAt: number|null, lastBackupNoteCount: number|null, lastBackupBytes: number|null, lastBackupEncrypted: boolean}>} */
export async function getBackupFreshness() {
  return {
    lastBackupAt: await getSetting(KEY_LAST_AT),
    lastBackupNoteCount: await getSetting(KEY_LAST_NOTES),
    lastBackupBytes: await getSetting(KEY_LAST_BYTES),
    lastBackupEncrypted: Boolean(await getSetting(KEY_LAST_ENCRYPTED)),
  };
}

/** Whether the encrypt option should start checked: the user's last choice. */
export async function getEncryptByDefault() {
  return Boolean(await getSetting(KEY_ENCRYPT_DEFAULT));
}

/**
 * The staleness nudge fires only when BOTH hold — either alone is a false alarm:
 *   1. the last backup is older than 30 days (or there never was one), and
 *   2. the corpus has grown meaningfully since: by 10% or by 10 notes,
 *      whichever is smaller (so small corpora are not held to a percentage
 *      and large ones are not held to a fixed count).
 * A user who has not touched the app for six months does not need to be told
 * to re-back-up an unchanged corpus.
 */
export function isBackupStale(freshness, currentNoteCount, now = Date.now()) {
  const { lastBackupAt, lastBackupNoteCount } = freshness ?? {};
  if (lastBackupAt == null) return currentNoteCount > 0;
  if (now - lastBackupAt < STALE_AFTER_MS) return false;
  const baseline = lastBackupNoteCount ?? 0;
  const growthNeeded = Math.max(1, Math.min(Math.ceil(baseline * 0.1), 10));
  return currentNoteCount - baseline >= growthNeeded;
}

/**
 * Cheap size estimate for the settings section: note counts plus the byte sum
 * of the blob store. Labelled approximate by the UI — note JSON (strokes) is
 * not measured, and compression is ignored.
 */
export async function estimateBackupSize() {
  const stats = await getStorageStats();
  const files = await cachedFileStats();
  return {
    notebookCount: stats.notebookCount,
    noteCount: stats.noteCount,
    fileCount: files.count,
    bytes: files.bytes,
  };
}

// Walking the blob store is the expensive half of the estimate, and the
// settings screen re-renders on every change made in it. The walk is done once
// and reused until the corpus changes (the UI invalidates on datachange and
// notes-updated).
let fileStatsPromise = null;

function cachedFileStats() {
  if (!fileStatsPromise) {
    fileStatsPromise = getFileStats().catch((error) => {
      fileStatsPromise = null;
      throw error;
    });
  }
  return fileStatsPromise;
}

/** Forget the cached blob-store walk; the next estimate reads it again. */
export function invalidateBackupEstimate() {
  fileStatsPromise = null;
}
