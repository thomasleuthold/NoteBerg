/**
 * Unified Sync Module
 * Centralized sync logic and state management for both manual and automatic syncing
 */

import { showConflictResolutionDialog } from "../components/modals.js";
import { fullSync, isAuthenticated } from "./nextcloudSync.js";
import {
  deleteNote,
  deleteNotebook,
  getAllNotebooksForSync,
  getAllNotesForSync,
  getNote,
  getNotebook,
  saveNote,
  saveNotebook,
} from "./storage.js";

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
 * @param {boolean} options.preferNewer - If true, automatically resolve conflicts by preferring the version with newer timestamp
 * @returns {Promise<Object|null>} Sync result or null if sync was skipped
 */
export async function performSync({
  silent = false,
  skipConflictResolution = false,
  preferNewer = false,
} = {}) {
  if (isSyncing || !(await isAuthenticated())) {
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

    // Pass copies of notes to fullSync to prevent any potential mutation of our local references
    // which we need for updating status later.
    const notesForSync = notes.map((n) => ({ ...n }));
    const result = await fullSync(notebooks, notesForSync);

    // Handle automatic timestamp-based conflict resolution (for app startup)
    if (preferNewer && result.conflicts?.notes?.length > 0) {
      for (const conflict of result.conflicts.notes) {
        const localTime = conflict.local.modified || 0;
        const remoteTime = conflict.remote.modified || 0;

        if (remoteTime > localTime) {
          // Remote is newer, use remote version
          console.log(
            `[Sync] Auto-resolving conflict for note ${conflict.local.id}: remote is newer (${new Date(remoteTime).toISOString()} > ${new Date(localTime).toISOString()})`,
          );
          await saveNote({
            ...conflict.remote,
            lastSyncedEtag: conflict.remote._currentFileEtag || conflict.remote.lastSyncedEtag,
            synced: true,
            _currentFileEtag: undefined, // Remove internal field
          });
        } else {
          // Local is newer or same timestamp, keep local version
          console.log(
            `[Sync] Auto-resolving conflict for note ${conflict.local.id}: local is newer or equal (${new Date(localTime).toISOString()} >= ${new Date(remoteTime).toISOString()})`,
          );
          await saveNote({
            ...conflict.local,
            lastSyncedEtag: conflict.remote._currentFileEtag || conflict.remote.lastSyncedEtag,
            synced: false,
            version: Math.max(conflict.local.version || 0, conflict.remote.version || 0) + 1,
            modified: Date.now(),
          });
        }
      }
      // Re-trigger sync to process resolutions
      isSyncing = false;
      notifySyncStatusChange();
      return await performSync({ silent, skipConflictResolution, preferNewer: false });
    }

    // Handle manual conflict resolution (only for manual syncs)
    if (!skipConflictResolution && !silent && result.conflicts?.notes?.length > 0) {
      for (const conflict of result.conflicts.notes) {
        const choice = await showConflictResolutionDialog(conflict.local, conflict.remote);
        if (choice === "local") {
          // Keep local version - skip encryption as it's already in correct format
          await saveNote(
            {
              ...conflict.local,
              lastSyncedEtag: conflict.remote._currentFileEtag || conflict.remote.lastSyncedEtag,
              synced: false,
              version: Math.max(conflict.local.version || 0, conflict.remote.version || 0) + 1,
              modified: Date.now(),
            },
            // Allow saveNote to handle encryption since we are working with decrypted data
          );
        } else {
          // Use remote version - saveNote will handle local encryption
          // Also update with current file etag for proper future sync tracking
          await saveNote(
            {
              ...conflict.remote,
              lastSyncedEtag: conflict.remote._currentFileEtag || conflict.remote.lastSyncedEtag,
              synced: true,
              _currentFileEtag: undefined, // Remove internal field
            },
            // Allow saveNote to handle encryption since we are working with decrypted data
          );
        }
      }
      // Re-trigger sync to process resolutions
      isSyncing = false;
      notifySyncStatusChange();
      return await performSync({ silent, skipConflictResolution });
    }

    // Mark uploaded items as synced
    for (const id of result.uploaded.notebooks.uploadedIds || []) {
      // Fetch fresh notebook to avoid overwriting concurrent changes
      const notebook = await getNotebook(id);
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
      // Fetch fresh note to avoid overwriting concurrent changes (e.g. new strokes)
      // getNote returns decrypted note, which is what we want for modification
      const note = await getNote(id);
      if (note) {
        const etag = result.uploaded.notes.metadata?.[id]?.etag;
        if (!silent) {
          console.log(`Marking note ${id} as synced (was: ${note.synced})`);
        }
        // Use skipEncryption because note is already in correct encrypted format
        // Wait, getNote returns decrypted. saveNote handles encryption.
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
      // Note is decrypted (plain text) from Nextcloud, so saveNote will handle local encryption
      // Remove internal _currentFileEtag and update lastSyncedEtag for tracking
      const { _currentFileEtag, ...noteToSave } = note;
      noteToSave.lastSyncedEtag = _currentFileEtag || note.lastSyncedEtag;
      await saveNote(noteToSave);
    }

    // Process deletions (Remote deleted -> Local delete)
    for (const notebookId of result.notebooksToDelete || []) {
      console.log(`[Sync] Deleting local notebook ${notebookId} (deleted remotely)`);
      await deleteNotebook(notebookId);
    }
    for (const noteId of result.notesToDelete || []) {
      console.log(`[Sync] Deleting local note ${noteId} (deleted remotely)`);
      await deleteNote(noteId);
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
