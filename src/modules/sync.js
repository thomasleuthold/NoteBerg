/**
 * Unified Sync Module
 * Centralized sync logic and state management for both manual and automatic syncing
 */

import { showConflictResolutionDialog } from "../components/modals.js";
import { fullSync, isAuthenticated } from "./nextcloudSync.js";
import { getAllNotebooksForSync, getAllNotesForSync, saveNote, saveNotebook } from "./storage.js";

// Sync state
let isSyncing = false;
const syncStatusCallbacks = [];

/**
 * Register a callback to be notified of sync status changes
 * @param {Function} callback - Function to call when sync status changes
 */
export function onSyncStatusChange(callback) {
  syncStatusCallbacks.push(callback);
}

/**
 * Notify all registered callbacks of sync status change
 */
function notifySyncStatusChange() {
  for (const callback of syncStatusCallbacks) {
    callback(isSyncing);
  }
}

/**
 * Get current sync status
 * @returns {boolean} Whether a sync is currently in progress
 */
export function getIsSyncing() {
  return isSyncing;
}

/**
 * Perform a full sync
 * @param {Object} options - Sync options
 * @param {boolean} options.silent - If true, don't show UI notifications or prompt for conflicts
 * @param {boolean} options.skipConflictResolution - If true, skip manual conflict resolution
 * @returns {Promise<Object|null>} Sync result or null if sync was skipped
 */
export async function performSync({ silent = false, skipConflictResolution = false } = {}) {
  if (isSyncing || !isAuthenticated()) {
    console.log("Sync: Skipping (already syncing or not authenticated)");
    return null;
  }

  isSyncing = true;
  notifySyncStatusChange();

  try {
    console.log(`Sync: Starting ${silent ? "silent" : "manual"} sync...`);

    const notebooks = await getAllNotebooksForSync();
    const notes = await getAllNotesForSync();

    // Debug: Show unsynced items count
    if (!silent) {
      const unsyncedNotebooks = notebooks.filter((n) => n.synced === false);
      const unsyncedNotes = notes.filter((n) => n.synced === false);
      console.log(
        `Before sync - Unsynced: ${unsyncedNotebooks.length} notebooks, ${unsyncedNotes.length} notes`,
      );
    }

    const result = await fullSync(notebooks, notes);

    // Handle manual conflict resolution (only for manual syncs)
    if (!skipConflictResolution && !silent && result.conflicts?.notes?.length > 0) {
      for (const conflict of result.conflicts.notes) {
        const choice = await showConflictResolutionDialog(conflict.local, conflict.remote);
        if (choice === "local") {
          await saveNote({
            ...conflict.local,
            lastSyncedEtag: conflict.remote.lastSyncedEtag,
            synced: false,
            version: Math.max(conflict.local.version || 0, conflict.remote.version || 0) + 1,
            modified: Date.now(),
          });
        } else {
          await saveNote({ ...conflict.remote, synced: true });
        }
      }
      // Re-trigger sync to process resolutions
      isSyncing = false;
      notifySyncStatusChange();
      return await performSync({ silent, skipConflictResolution });
    }

    // Mark uploaded items as synced
    for (const id of result.uploaded.notebooks.uploadedIds || []) {
      const notebook = notebooks.find((n) => n.id === id);
      if (notebook) {
        const etag = result.uploaded.notebooks.metadata?.[id]?.etag;
        if (!silent) {
          console.log(`Marking notebook ${id} as synced (was: ${notebook.synced})`);
        }
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
        if (!silent) {
          console.log(`Marking note ${id} as synced (was: ${note.synced})`);
        }
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

    // Dispatch event for UI updates (always, even in silent mode)
    window.dispatchEvent(new CustomEvent("datachange"));

    const totalConflicts =
      (result.conflicts?.notebooks?.length || 0) + (result.conflicts?.notes?.length || 0);

    if (totalConflicts > 0) {
      console.warn(`Sync: Completed with ${totalConflicts} conflicts`);
      // Dispatch event to notify about conflicts
      window.dispatchEvent(
        new CustomEvent("sync-conflicts", {
          detail: { conflicts: result.conflicts },
        }),
      );
    } else {
      console.log("Sync: Completed successfully");
    }

    if (!silent) {
      const unsyncedNotebooks = notebooks.filter((n) => n.synced === false);
      const unsyncedNotes = notes.filter((n) => n.synced === false);
      const syncSummary = `Sync complete!\nUploaded: ${result.uploaded.notebooks.uploaded} notebooks, ${result.uploaded.notes.uploaded} notes\nDownloaded: ${result.downloaded.notebooks.length} notebooks, ${result.downloaded.notes.length} notes\n\nBefore sync - Unsynced: ${unsyncedNotebooks.length} notebooks, ${unsyncedNotes.length} notes`;
      console.log(syncSummary);
    }

    return result;
  } catch (error) {
    console.error("Sync: Failed", error);
    throw error;
  } finally {
    isSyncing = false;
    notifySyncStatusChange();
  }
}
