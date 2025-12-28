/**
 * Auto Sync Module
 * Handles automatic syncing of notes and notebooks to minimize conflicts
 */

import { isAuthenticated } from "./nextcloudSync.js";
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
function shouldSync() {
  if (!isAuthenticated()) return false;
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
  if (!isAuthenticated()) return;

  if (!shouldSync()) {
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

  if (!shouldSync()) {
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
 */
export async function syncOnAppStart() {
  if (!isAuthenticated()) {
    console.log("Auto-sync: Not authenticated, skipping startup sync");
    return;
  }

  console.log("Auto-sync: App started, performing initial sync...");

  lastSyncTime = Date.now();

  try {
    await performSync({ silent: true, skipConflictResolution: true });
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
