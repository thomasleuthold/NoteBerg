/**
 * Footer Module
 * Handles sync status display and sync triggering
 */

import { showConflictResolutionDialog } from "../components/modals.js";
import { fullSync, isAuthenticated } from "./nextcloudSync.js";
import { getAllNotebooksForSync, getAllNotesForSync, saveNote, saveNotebook } from "./storage.js";

let isSyncing = false;

/**
 * Update sync status display
 */
export function updateSyncStatus() {
  const syncStatus = document.querySelector(".sync-status");
  const syncIndicator = document.querySelector(".sync-indicator");
  const syncText = document.querySelector(".sync-text");

  if (!syncStatus || !syncIndicator || !syncText) return;

  const authenticated = isAuthenticated();

  if (isSyncing) {
    syncStatus.dataset.status = "syncing";
    syncIndicator.textContent = "↻";
    syncText.textContent = "Syncing...";
    syncStatus.style.cursor = "wait";
  } else if (authenticated) {
    syncStatus.dataset.status = "connected";
    syncIndicator.textContent = "●";
    syncText.textContent = "Connected - Click to sync";
    syncStatus.style.cursor = "pointer";
  } else {
    syncStatus.dataset.status = "offline";
    syncIndicator.textContent = "○";
    syncText.textContent = "Not connected";
    syncStatus.style.cursor = "default";
  }
}

/**
 * Perform sync
 */
async function performSync() {
  if (isSyncing || !isAuthenticated()) return;

  isSyncing = true;
  updateSyncStatus();

  try {
    const notebooks = await getAllNotebooksForSync();
    const notes = await getAllNotesForSync();

    // Debug: Show unsynced items count
    const unsyncedNotebooks = notebooks.filter((n) => n.synced === false);
    const unsyncedNotes = notes.filter((n) => n.synced === false);
    console.log(
      `Before sync - Unsynced: ${unsyncedNotebooks.length} notebooks, ${unsyncedNotes.length} notes`,
    );

    const result = await fullSync(notebooks, notes);

    // Handle manual conflict resolution
    if (result.conflicts?.notes?.length > 0) {
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
      return await performSync();
    }

    // Mark uploaded items as synced in local storage
    for (const id of result.uploaded.notebooks.uploadedIds || []) {
      const uploadedNotebook = result.notebooksToUpload.find((n) => n.id === id);
      const notebook = uploadedNotebook || notebooks.find((n) => n.id === id);
      if (notebook) {
        // Don't modify the 'modified' timestamp when marking as synced
        console.log(`Marking notebook ${id} as synced (was: ${notebook.synced})`);
        const etag = result.uploaded.notebooks.metadata?.[id]?.etag;
        await saveNotebook({
          ...notebook,
          synced: true,
          lastSyncedEtag: etag || notebook.lastSyncedEtag,
        });
      }
    }

    for (const id of result.uploaded.notes.uploadedIds || []) {
      const uploadedNote = result.notesToUpload.find((n) => n.id === id);
      const note = uploadedNote || notes.find((n) => n.id === id);
      if (note) {
        // Don't modify the 'modified' timestamp when marking as synced
        console.log(`Marking note ${id} as synced (was: ${note.synced})`);
        const etag = result.uploaded.notes.metadata?.[id]?.etag;
        await saveNote({
          ...note,
          synced: true,
          lastSyncedEtag: etag || note.lastSyncedEtag,
        });
      }
    }

    // Save downloaded notebooks to local storage
    let downloadedNotebooks = 0;
    let downloadedNotes = 0;

    for (const notebook of result.downloaded.notebooks) {
      await saveNotebook(notebook);
      downloadedNotebooks++;
    }

    // Save downloaded notes to local storage
    for (const note of result.downloaded.notes) {
      await saveNote(note);
      downloadedNotes++;
    }

    const syncSummary = `Sync complete!\nUploaded: ${result.uploaded.notebooks.uploaded} notebooks, ${result.uploaded.notes.uploaded} notes\nDownloaded: ${downloadedNotebooks} notebooks, ${downloadedNotes} notes\n\nBefore sync - Unsynced: ${unsyncedNotebooks.length} notebooks, ${unsyncedNotes.length} notes`;
    console.log(syncSummary);

    // Show success briefly
    const syncText = document.querySelector(".sync-text");
    if (syncText) {
      syncText.textContent = "Sync successful!";
      setTimeout(() => {
        isSyncing = false;
        updateSyncStatus();
      }, 2000);
    }

    // Dispatch a global event to notify all components that data has changed.
    window.dispatchEvent(new CustomEvent("datachange"));
  } catch (error) {
    console.error("Sync failed:", error);

    // Show error briefly
    const syncText = document.querySelector(".sync-text");
    if (syncText) {
      syncText.textContent = "Sync failed!";
      setTimeout(() => {
        isSyncing = false;
        updateSyncStatus();
      }, 3000);
    }
  }
}

/**
 * Initialize footer
 */
export function initFooter() {
  const syncStatus = document.querySelector(".sync-status");

  if (syncStatus) {
    syncStatus.addEventListener("click", () => {
      if (isAuthenticated() && !isSyncing) {
        performSync();
      }
    });
  }

  // Update status on load and when auth changes
  updateSyncStatus();

  // Listen for auth changes
  window.addEventListener("nextcloud-auth-changed", updateSyncStatus);

  console.log("Footer initialized");
}
