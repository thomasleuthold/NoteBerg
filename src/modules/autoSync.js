/**
 * Auto Sync Module
 * Handles automatic syncing of notes and notebooks to minimize conflicts
 */

import { recognizeUnprocessedNotes } from "./autoRecognition.js";
import { hasRemoteChanges, isAuthenticated } from "./nextcloudSync.js";
import { getNoteIndex, getNotesByNotebook } from "./storage.js";
import { getIsSyncing, performSync } from "./sync.js";

// Configuration
const INACTIVITY_TIMEOUT = 30000; // 30 seconds of inactivity before syncing
const SYNC_COOLDOWN = 5000; // Minimum time between syncs (5 seconds)

// State
let inactivityTimer = null;
let lastSyncTime = 0;
let currentNoteId = null;

/**
 * Check if we should sync (respects cooldown period)
 */
async function shouldSync() {
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
    if (currentNoteId) {
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
  if (!(await isAuthenticated())) return;
  if (getIsSyncing()) return;

  try {
    const localNotes = await getNotesByNotebook(notebookId);
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
  if (!(await isAuthenticated())) return;
  if (getIsSyncing()) return;

  try {
    // notebookId may be omitted from navigate params — always look it up from the local index
    // so we check the right folder on the server (notebook notes vs quick notes).
    const noteIndex = await getNoteIndex(noteId);
    const resolvedNotebookId = noteIndex?.notebookId ?? null;

    const localNotes = await getNotesByNotebook(resolvedNotebookId);
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

/**
 * Sync on app startup
 * Uses smart conflict resolution - prefers the version with newer timestamp.
 * On Windows, also triggers handwriting recognition for notes that were edited
 * on mobile (where recognition is unavailable), then syncs the results back.
 */
export async function syncOnAppStart() {
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
