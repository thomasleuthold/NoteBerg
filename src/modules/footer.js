/**
 * Footer Module
 * Handles sync status display and sync triggering
 */

import { isAuthenticated, fullSync } from './nextcloudSync.js';
import { getAllNotebooksForSync, getAllNotesForSync, saveNotebook, saveNote, permanentlyDeleteNotebook, permanentlyDeleteNote } from './storage.js';

let isSyncing = false;

/**
 * Update sync status display
 */
export function updateSyncStatus() {
  const syncStatus = document.querySelector('.sync-status');
  const syncIndicator = document.querySelector('.sync-indicator');
  const syncText = document.querySelector('.sync-text');

  if (!syncStatus || !syncIndicator || !syncText) return;

  const authenticated = isAuthenticated();

  if (isSyncing) {
    syncStatus.dataset.status = 'syncing';
    syncIndicator.textContent = '↻';
    syncText.textContent = 'Syncing...';
    syncStatus.style.cursor = 'wait';
  } else if (authenticated) {
    syncStatus.dataset.status = 'connected';
    syncIndicator.textContent = '●';
    syncText.textContent = 'Connected - Click to sync';
    syncStatus.style.cursor = 'pointer';
  } else {
    syncStatus.dataset.status = 'offline';
    syncIndicator.textContent = '○';
    syncText.textContent = 'Not connected';
    syncStatus.style.cursor = 'default';
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

    const result = await fullSync(notebooks, notes);

    // Mark uploaded items as synced in local storage
    for (const id of result.uploaded.notebooks.uploadedIds || []) {
      const notebook = notebooks.find(n => n.id === id);
      if (notebook) {
        await saveNotebook({ ...notebook, synced: true });
      }
    }

    for (const id of result.uploaded.notes.uploadedIds || []) {
      const note = notes.find(n => n.id === id);
      if (note) {
        await saveNote({ ...note, synced: true });
      }
    }

    // Save downloaded notebooks to local storage
    let downloadedNotebooks = 0;
    let downloadedNotes = 0;

    for (const notebook of result.downloaded.notebooks) {
      // Check if it's a tombstone (has minimal fields)
      const isTombstone = notebook.deleted && !notebook.name;

      if (isTombstone) {
        // Permanently delete local copy if it exists
        await permanentlyDeleteNotebook(notebook.id);
      } else {
        await saveNotebook(notebook);
      }
      downloadedNotebooks++;
    }

    // Save downloaded notes to local storage
    for (const note of result.downloaded.notes) {
      // Check if it's a tombstone (has minimal fields)
      const isTombstone = note.deleted && !note.title && !note.content;

      if (isTombstone) {
        // Permanently delete local copy if it exists
        await permanentlyDeleteNote(note.id);
      } else {
        await saveNote(note);
      }
      downloadedNotes++;
    }

    console.log(
      `Sync complete! Uploaded ${result.uploaded.notebooks.uploaded} notebooks, ${result.uploaded.notes.uploaded} notes. Downloaded ${downloadedNotebooks} notebooks, ${downloadedNotes} notes.`
    );

    // Show success briefly
    const syncText = document.querySelector('.sync-text');
    if (syncText) {
      syncText.textContent = 'Sync successful!';
      setTimeout(() => {
        isSyncing = false;
        updateSyncStatus();
      }, 2000);
    }

    // Trigger a UI refresh if notes/notebooks were downloaded
    if (downloadedNotebooks > 0 || downloadedNotes > 0) {
      window.dispatchEvent(new CustomEvent('notes-updated'));
    }
  } catch (error) {
    console.error('Sync failed:', error);

    // Show error briefly
    const syncText = document.querySelector('.sync-text');
    if (syncText) {
      syncText.textContent = 'Sync failed!';
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
  const syncStatus = document.querySelector('.sync-status');

  if (syncStatus) {
    syncStatus.addEventListener('click', () => {
      if (isAuthenticated() && !isSyncing) {
        performSync();
      }
    });
  }

  // Update status on load and when auth changes
  updateSyncStatus();

  // Listen for auth changes
  window.addEventListener('nextcloud-auth-changed', updateSyncStatus);

  console.log('Footer initialized');
}
