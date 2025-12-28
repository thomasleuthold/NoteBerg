/**
 * Auto Sync Module
 * Handles automatic syncing of notes and notebooks to minimize conflicts
 */

import { fullSync, isAuthenticated } from "./nextcloudSync.js";
import { getAllNotebooksForSync, getAllNotesForSync, saveNote, saveNotebook } from "./storage.js";

// Configuration
const INACTIVITY_TIMEOUT = 30000; // 30 seconds of inactivity before syncing
const SYNC_COOLDOWN = 5000; // Minimum time between syncs (5 seconds)

// State
let inactivityTimer = null;
let lastSyncTime = 0;
let isSyncing = false;
let currentNoteId = null;

/**
 * Check if we should sync (respects cooldown period)
 */
function shouldSync() {
  if (!isAuthenticated()) return false;
  if (isSyncing) return false;

  const now = Date.now();
  const timeSinceLastSync = now - lastSyncTime;

  return timeSinceLastSync >= SYNC_COOLDOWN;
}

/**
 * Perform a full sync
 * @param {boolean} silent - If true, don't update UI status
 * @returns {Promise<Object>} Sync result
 */
async function performSync(silent = true) {
  if (!shouldSync()) {
    console.log("Auto-sync: Skipping sync (cooldown period or already syncing)");
    return null;
  }

  isSyncing = true;
  lastSyncTime = Date.now();

  try {
    console.log("Auto-sync: Starting sync...");

    const notebooks = await getAllNotebooksForSync();
    const notes = await getAllNotesForSync();

    const result = await fullSync(notebooks, notes);

    // Mark uploaded items as synced
    for (const id of result.uploaded.notebooks.uploadedIds || []) {
      const notebook = notebooks.find((n) => n.id === id);
      if (notebook) {
        const etag = result.uploaded.notebooks.metadata?.[id]?.etag;
        await saveNotebook({
          ...notebook,
          synced: true,
          lastSyncedEtag: etag || notebook.lastSyncedEtag,
        });
      }
    }

    for (const id of result.uploaded.notes.uploadedIds || []) {
      const note = notes.find((n) => n.id === id);
      if (note) {
        const etag = result.uploaded.notes.metadata?.[id]?.etag;
        await saveNote({
          ...note,
          synced: true,
          lastSyncedEtag: etag || note.lastSyncedEtag,
        });
      }
    }

    // Save downloaded items
    for (const notebook of result.downloaded.notebooks) {
      await saveNotebook(notebook);
    }

    for (const note of result.downloaded.notes) {
      await saveNote(note);
    }

    if (!silent) {
      // Dispatch event for UI updates
      window.dispatchEvent(new CustomEvent("datachange"));
    }

    const totalConflicts =
      (result.conflicts?.notebooks?.length || 0) + (result.conflicts?.notes?.length || 0);

    if (totalConflicts > 0) {
      console.warn(`Auto-sync: Completed with ${totalConflicts} conflicts`);
      // Dispatch event to notify about conflicts
      window.dispatchEvent(
        new CustomEvent("sync-conflicts", {
          detail: { conflicts: result.conflicts },
        }),
      );
    } else {
      console.log("Auto-sync: Completed successfully");
    }

    return result;
  } catch (error) {
    console.error("Auto-sync: Failed", error);
    throw error;
  } finally {
    isSyncing = false;
  }
}

/**
 * Sync a single note immediately
 * @param {string} noteId - Note ID to sync
 */
async function syncSingleNote(noteId) {
  if (!isAuthenticated()) return;

  try {
    console.log(`Auto-sync: Syncing note ${noteId}`);

    // For now, we'll do a full sync since our sync logic handles individual items
    // In the future, we could optimize this to only sync the specific note
    await performSync(true);
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
 */
export async function syncOnNoteClose(noteId) {
  stopInactivityTimer();

  if (!isAuthenticated()) return;

  console.log(`Auto-sync: Note closed (${noteId}), syncing...`);
  await syncSingleNote(noteId);
}

/**
 * Sync when note is created
 * @param {string} noteId - Note ID that was created
 */
export async function syncOnNoteCreate(noteId) {
  if (!isAuthenticated()) return;

  console.log(`Auto-sync: Note created (${noteId}), syncing...`);
  await syncSingleNote(noteId);
}

/**
 * Sync when notebook is created
 * @param {string} notebookId - Notebook ID that was created
 */
export async function syncOnNotebookCreate(notebookId) {
  if (!isAuthenticated()) return;

  console.log(`Auto-sync: Notebook created (${notebookId}), syncing...`);
  await performSync(true);
}

/**
 * Sync on app startup
 */
export async function syncOnAppStart() {
  if (!isAuthenticated()) {
    console.log("Auto-sync: Not authenticated, skipping startup sync");
    return;
  }

  console.log("Auto-sync: App started, performing initial sync...");

  try {
    await performSync(false); // Not silent, update UI
  } catch (error) {
    console.error("Auto-sync: Startup sync failed", error);
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
