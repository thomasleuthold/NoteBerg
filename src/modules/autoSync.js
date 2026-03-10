/**
 * Auto Sync Module
 * Handles automatic syncing of notes and notebooks to minimize conflicts
 */

import { recognizeUnprocessedNotes } from "./autoRecognition.js";
import { isAuthenticated } from "./nextcloudSync.js";
import { getNoteIndex } from "./storage.js";
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
