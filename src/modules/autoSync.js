/**
 * Auto Sync Module
 * Handles automatic syncing of notes and notebooks to minimize conflicts
 */

import { recognizeUnprocessedNotes } from "./autoRecognition.js";
import { hasRemoteChanges, isAuthenticated } from "./nextcloudSync.js";
import { getAllNotesForSync, getNoteIndex } from "./storage.js";
import { getIsSyncing, performSync } from "./sync.js";

/**
 * Local note index for one notebook (or quick notes), INCLUDING soft-deleted notes.
 * hasRemoteChanges compares etags per note id — a soft-deleted note still has its
 * JSON (and etag) on the server, so excluding it would make every remote file look
 * "changed" and trigger a full sync on every note/notebook open.
 */
async function getLocalNotesForChangeCheck(notebookId) {
  const allNotes = await getAllNotesForSync();
  return allNotes.filter((n) => (n.notebookId ?? null) === (notebookId ?? null));
}

// Configuration
const INACTIVITY_TIMEOUT = 30000; // 30 seconds of inactivity before syncing
const SYNC_COOLDOWN = 5000; // Minimum time between syncs (5 seconds)

// State
let inactivityTimer = null;
let lastSyncTime = 0;
let currentNoteId = null;

// Suspension depth. Auto-sync is event-driven (navigate, note-created,
// notebook-created, inactivity), so a caller that rewrites the corpus — a backup
// restore — cannot just check getIsSyncing() once: a sync can start mid-way
// through its writes from any of those listeners. Suspending closes every entry
// point for the duration. A counter rather than a boolean so nested callers
// cannot resume each other early.
let suspendDepth = 0;

/**
 * Stop auto-sync from starting any sync until the matching resumeAutoSync().
 * Always pair with resumeAutoSync() in a `finally`.
 */
export function suspendAutoSync() {
  suspendDepth++;
  stopInactivityTimer();
}

/** Release one suspendAutoSync() call. */
export function resumeAutoSync() {
  if (suspendDepth > 0) suspendDepth--;
}

/** Whether auto-sync is currently held off by suspendAutoSync(). */
export function isAutoSyncSuspended() {
  return suspendDepth > 0;
}

/**
 * Check if we should sync (respects cooldown period)
 */
async function shouldSync() {
  if (isAutoSyncSuspended()) return false;
  if (!(await isAuthenticated())) return false;
  if (getIsSyncing()) return false;

  const now = Date.now();
  const timeSinceLastSync = now - lastSyncTime;

  return timeSinceLastSync >= SYNC_COOLDOWN;
}

/**
 * Sync a single note immediately
 * @param {string} noteId - Note ID to sync
 */
async function syncSingleNote(noteId) {
  if (!(await isAuthenticated())) return;

  if (!(await shouldSync())) {
    console.log("Auto-sync: Skipping sync (cooldown period or already syncing)");
    return null;
  }

  lastSyncTime = Date.now();

  try {
    console.log(`Auto-sync: Syncing note ${noteId}`);

    // For now, we'll do a full sync since our sync logic handles individual items
    // In the future, we could optimize this to only sync the specific note
    await performSync({ silent: true, skipConflictResolution: true });
  } catch (error) {
    console.error(`Auto-sync: Failed to sync note ${noteId}`, error);
  }
}

/**
 * Reset inactivity timer
 * Call this whenever user interacts with the note
 */
export function resetInactivityTimer(noteId) {
  currentNoteId = noteId;

  // Clear existing timer
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }

  // Set new timer
  inactivityTimer = setTimeout(() => {
    console.log("Auto-sync: Inactivity timeout reached");
    if (currentNoteId && !isAutoSyncSuspended()) {
      syncSingleNote(currentNoteId);
    }
  }, INACTIVITY_TIMEOUT);
}

/**
 * Stop inactivity timer (called when note is closed)
 */
export function stopInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

/**
 * Sync when note is closed
 * @param {string} noteId - Note ID that was closed
 * @param {Object} [options]
 * @param {boolean} [options.forceSync] - If true, sync even when the note appears clean.
 *   Use this when media was changed: the Web Worker's SAVE_MEDIA message may not have been
 *   processed by IndexedDB yet when we read the synced flag, causing a false "no changes" skip.
 */
export async function syncOnNoteClose(noteId, { forceSync = false } = {}) {
  stopInactivityTimer();

  if (!(await isAuthenticated())) return;

  const note = await getNoteIndex(noteId);
  if (note?.synced !== false && !forceSync) {
    console.log(`Auto-sync: Note ${noteId} has no local changes, skipping sync`);
    return;
  }

  console.log(`Auto-sync: Note closed (${noteId}), syncing...`);
  await syncSingleNote(noteId);
}

/**
 * Sync when note is created
 * @param {string} noteId - Note ID that was created
 */
export async function syncOnNoteCreate(noteId) {
  if (!(await isAuthenticated())) return;

  console.log(`Auto-sync: Note created (${noteId}), syncing...`);
  await syncSingleNote(noteId);
}

/**
 * Sync when notebook is created
 * @param {string} notebookId - Notebook ID that was created
 */
export async function syncOnNotebookCreate(notebookId) {
  if (!(await isAuthenticated())) return;

  if (!(await shouldSync())) {
    console.log("Auto-sync: Skipping sync (cooldown period or already syncing)");
    return;
  }

  lastSyncTime = Date.now();

  console.log(`Auto-sync: Notebook created (${notebookId}), syncing...`);
  try {
    await performSync({ silent: true, skipConflictResolution: true });
  } catch (error) {
    console.error(`Auto-sync: Failed to sync notebook ${notebookId}`, error);
  }
}

/**
 * Check for remote changes when a notebook is opened, and sync if needed.
 * @param {string} notebookId - The notebook being opened
 */
export async function syncOnNotebookOpen(notebookId) {
  if (isAutoSyncSuspended()) return;
  if (!(await isAuthenticated())) return;
  if (getIsSyncing()) return;

  try {
    const localNotes = await getLocalNotesForChangeCheck(notebookId);
    const changed = await hasRemoteChanges(notebookId, localNotes);
    if (!changed) return;

    console.log(
      `Auto-sync: Remote changes detected on notebook open (notebook ${notebookId}), syncing...`,
    );
    lastSyncTime = Date.now();
    await performSync({ silent: true, skipConflictResolution: true });
  } catch (e) {
    console.warn("Auto-sync: syncOnNotebookOpen failed:", e);
  }
}

/**
 * Check for remote changes when a note is opened, and sync if needed.
 * Uses a cheap Depth:1 PROPFIND against the notebook's notes folder — no content downloaded.
 * If remote changes are found, runs a full silent sync (the footer spinner activates automatically).
 * @param {string} noteId - The note being opened
 * @param {string|null} notebookId - Its notebook (null = quick note). If undefined, looks up from local index.
 */
export async function syncOnNoteOpen(noteId) {
  if (isAutoSyncSuspended()) return;
  if (!(await isAuthenticated())) return;
  if (getIsSyncing()) return;

  try {
    // notebookId may be omitted from navigate params — always look it up from the local index
    // so we check the right folder on the server (notebook notes vs quick notes).
    const noteIndex = await getNoteIndex(noteId);
    const resolvedNotebookId = noteIndex?.notebookId ?? null;

    const localNotes = await getLocalNotesForChangeCheck(resolvedNotebookId);
    const changed = await hasRemoteChanges(resolvedNotebookId, localNotes);
    if (!changed) return;

    console.log(
      `Auto-sync: Remote changes detected on note open (notebook ${resolvedNotebookId}), syncing...`,
    );
    lastSyncTime = Date.now();
    await performSync({ silent: true, skipConflictResolution: true });
  } catch (e) {
    console.warn("Auto-sync: syncOnNoteOpen failed:", e);
  }
}

/** After a sync that left the open note unsynced, how long before its changes are pushed again. */
const PUSH_RETRY_MS = 120_000;
// noteId -> time before which a push of its local changes is not retried
const pushBackoff = new Map();

/**
 * The periodic look of an open note (NoteCanvas/liveRefresh.js): sync when the
 * note's notebook changed on the server, or when the open note holds changes not
 * uploaded yet. The look is one listing of the notebook's notes, compared by
 * etag, and downloads nothing; the sync that follows a change announces it as a
 * `datachange`, which the editor takes in.
 *
 * The second reason is what makes this device's edits reach a collaborator while
 * the note stays open. Without it they were uploaded only when the note closed,
 * or as a side effect of a sync for someone else's change (DESIGN §10.4b).
 *
 * @param {string|null} notebookId - the open note's notebook (null = quick notes)
 * @param {object} [options]
 * @param {() => boolean} [options.isIdle] - asked again before syncing: the user
 *   may have started writing while the listing was on its way
 * @param {string|null} [options.noteId] - the open note, when the user may edit it:
 *   its unsynced changes are pushed
 * @returns {Promise<"synced"|"deferred"|"unchanged"|"skipped">}
 */
export async function syncIfNotebookChanged(
  notebookId,
  { isIdle = () => true, noteId = null } = {},
) {
  if (isAutoSyncSuspended() || getIsSyncing()) return "skipped";
  if (!(await isAuthenticated())) return "skipped";

  const localNotes = await getLocalNotesForChangeCheck(notebookId);
  const toPush =
    noteId !== null &&
    localNotes.some((n) => n.id === noteId && n.synced === false) &&
    Date.now() >= (pushBackoff.get(noteId) ?? 0);
  if (!toPush && !(await hasRemoteChanges(notebookId, localNotes))) return "unchanged";
  // Found while the user writes, or within the cooldown after another sync:
  // the editor looks again at the next pause
  if (!isIdle() || !(await shouldSync())) return "deferred";

  console.log(
    `Auto-sync: ${toPush ? "Local" : "Remote"} changes in the open note's notebook (${notebookId}), syncing...`,
  );
  lastSyncTime = Date.now();
  try {
    await performSync({ silent: true, skipConflictResolution: true });
  } catch (e) {
    console.warn("Auto-sync: live sync failed:", e);
  }
  if (toPush) {
    // A note the sync could not upload (an unmergeable conflict, a refused
    // write) is not pushed again at every look
    const index = await getNoteIndex(noteId).catch(() => null);
    if (index?.synced === false) pushBackoff.set(noteId, Date.now() + PUSH_RETRY_MS);
    else pushBackoff.delete(noteId);
  }
  return "synced";
}

/**
 * Sync on app startup
 * Uses smart conflict resolution - prefers the version with newer timestamp.
 * On Windows, also triggers handwriting recognition for notes that were edited
 * on mobile (where recognition is unavailable), then syncs the results back.
 */
export async function syncOnAppStart() {
  if (isAutoSyncSuspended()) return;
  if (!(await isAuthenticated())) {
    console.log("Auto-sync: Not authenticated, skipping startup sync");
    return;
  }

  console.log("Auto-sync: App started, performing initial sync with smart conflict resolution...");

  lastSyncTime = Date.now();

  try {
    await performSync({ silent: true, skipConflictResolution: true, preferNewer: true });
  } catch (error) {
    console.error("Auto-sync: Startup sync failed", error);
    return; // Don't attempt recognition if sync itself failed
  }

  // Post-sync recognition: process notes with strokes but no recognition data.
  // recognizeUnprocessedNotes() is a no-op when the recognition service is unavailable
  // (i.e. on mobile or when no sidecar/fallback URL is configured).
  try {
    const recognized = await recognizeUnprocessedNotes();
    if (recognized > 0) {
      // Upload the recognition data so other devices can use it for search.
      // This performSync does NOT re-trigger recognizeUnprocessedNotes (one-shot).
      lastSyncTime = Date.now();
      console.log(`Auto-sync: Syncing ${recognized} newly recognized note(s)...`);
      await performSync({ silent: true, skipConflictResolution: true });
    }
  } catch (error) {
    console.error("Auto-sync: Post-recognition sync failed", error);
  }
}

/**
 * Initialize auto-sync system
 */
export function initAutoSync() {
  // Sync on app start
  syncOnAppStart();

  // Listen for note/notebook events
  window.addEventListener("navigate", (e) => {
    const { mode, params } = e.detail ?? {};
    if (mode === "notebook" && params?.noteId) {
      syncOnNoteOpen(params.noteId, params.notebookId);
    } else if (mode === "overview" && params?.notebookId) {
      syncOnNotebookOpen(params.notebookId);
    }
  });

  window.addEventListener("note-created", (e) => {
    if (e.detail?.noteId) {
      syncOnNoteCreate(e.detail.noteId);
    }
  });

  window.addEventListener("notebook-created", (e) => {
    if (e.detail?.notebookId) {
      syncOnNotebookCreate(e.detail.notebookId);
    }
  });

  console.log("Auto-sync: Initialized");
}
