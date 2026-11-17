/**
 * Unified Sync Module
 * Centralized sync logic and state management for both manual and automatic syncing
 */

import { showConflictResolutionDialog } from "../components/modals.js";
import { perfStep } from "../utils/perfMonitor.js";
import {
  attemptMerge,
  fullSync,
  getCurrentUserId,
  isAuthenticated,
  syncSharedNotebook,
} from "./nextcloudSync.js";
import { isCollaborativeNote } from "./sharing/collaboration.js";
import { isSharingEnabled } from "./sharing/enabled.js";
import { prepareSharing, runDiscovery } from "./sharing/nativeSharing.js";
import { adoptRemoteNotebook } from "./sharing/notebookShareFields.js";
import { refreshOwnerShares, refreshOwnerSharesIfStale } from "./sharing/ownerShares.js";
import { registerSharedBases, splitByOrigin } from "./sharing/sharedBases.js";
import {
  getAllNotebooksForSync,
  getAllNoteMetadataForSync,
  getNote,
  getNoteBase,
  getNotebook,
  getNoteIndex,
  permanentlyDeleteNote,
  permanentlyDeleteNotebook,
  permanentlyDeleteNotesInNotebook,
  saveNote,
  saveNotebook,
  setNoteBase,
  updateNoteEtag,
} from "./storage.js";

// Sync state
let isSyncing = false;
let lastSyncResult = null;
const syncStatusCallbacks = [];
const idleWaiters = [];

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
  if (!isSyncing) for (const resolve of idleWaiters.splice(0)) resolve();
}

/**
 * Resolves once no sync is running (at once when none is). For callers that need
 * a sync of their own and must not have it skipped because one is in progress.
 * @returns {Promise<void>}
 */
export function whenSyncIdle() {
  if (!isSyncing) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/**
 * Run `fn` as the one sync running now: a full sync does not start meanwhile,
 * and it is not started while one runs (null then). The open note's own sync
 * (liveNoteSync.js) runs under it.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T|null>}
 */
export async function runExclusiveSync(fn) {
  if (isSyncing) return null;
  isSyncing = true;
  notifySyncStatusChange();
  try {
    return await fn();
  } finally {
    isSyncing = false;
    notifySyncStatusChange();
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
 * Get the result of the last sync operation
 * @returns {Object|null} Last sync result or null if no sync has occurred
 */
export function getLastSyncResult() {
  return lastSyncResult;
}

/**
 * Remove stale pdf-page IDs from deletedMedia once the PDF is fully gone.
 * pdf-page items accumulate in deletedMedia when a PDF is removed (500 entries
 * for a 500-page PDF), but they have no independent binary — they share pdfSource.
 * Once the note has no pdfSource and no active pdf-page items, those deletedMedia
 * entries have served their merge-propagation purpose and can be dropped.
 *
 * Safe to drop only when we can prove ALL deletedMedia entries are pdf-page IDs:
 * if the note never had any non-pdf-page media, every deletedMedia entry must be
 * a pdf-page ID (since that's the only type that was ever deleted). If the note
 * also had real images, we cannot distinguish their deleted IDs from pdf-page IDs
 * and must leave deletedMedia untouched.
 *
 * Mutates the note object in place.
 */
function purgePdfPageDeletedMedia(note) {
  if (!Array.isArray(note.deletedMedia) || note.deletedMedia.length === 0) return;
  if (note.pdfSource) return;
  if (!Array.isArray(note.media)) return;

  const hasActivePdfPage = note.media.some((m) => m.type === "pdf-page" && !m.deleted);
  if (hasActivePdfPage) return;

  // Only purge when the note has never contained non-pdf-page media.
  // note.media includes both active and soft-deleted items, so this covers
  // notes that had images alongside the PDF.
  const hasEverHadRealMedia = note.media.some((m) => m.type !== "pdf-page");
  if (hasEverHadRealMedia) return;

  const dropped = note.deletedMedia.length;
  note.deletedMedia = [];
  if (dropped > 0) {
    console.log(
      `[Sync] Purged ${dropped} stale pdf-page deletedMedia entries from note ${note.id}`,
    );
  }
}

/**
 * Replace the local note with the server's version (remote wins). The server's
 * text is also the new merge baseline, since the local copy now equals it.
 */
async function acceptRemoteVersion(remote) {
  const remoteToSave = {
    ...remote,
    lastSyncedEtag: remote._currentFileEtag || remote.lastSyncedEtag,
    synced: true,
    _currentFileEtag: undefined,
    thumbnail: undefined, // local-only, never from NC
  };
  purgePdfPageDeletedMedia(remoteToSave);
  await saveNote(remoteToSave);
  await setNoteBase(remote.id, remoteToSave.content);
}

/** Keep the local note and queue it for upload against the server's current etag. */
async function keepLocalVersion({ local, remote }) {
  // saveNote handles encryption of the decrypted data
  await saveNote({
    ...local,
    lastSyncedEtag: remote._currentFileEtag || remote.lastSyncedEtag,
    synced: false,
    version: Math.max(local.version || 0, remote.version || 0) + 1,
    modified: Date.now(),
  });
}

/**
 * The version with the newer `modified` wins; a tie keeps the local one.
 * @returns {Promise<boolean>} whether the remote version was taken (what the
 *   user sees changed); otherwise the local one waits to be uploaded
 */
async function resolveConflictByTimestamp(conflict) {
  const localTime = conflict.local.modified || 0;
  const remoteTime = conflict.remote.modified || 0;
  const noteId = conflict.local.id;

  if (remoteTime > localTime) {
    console.log(
      `[Sync] Auto-resolving conflict for note ${noteId}: remote is newer (${new Date(remoteTime).toISOString()} > ${new Date(localTime).toISOString()})`,
    );
    await acceptRemoteVersion(conflict.remote);
    return true;
  }
  console.log(
    `[Sync] Auto-resolving conflict for note ${noteId}: local is newer or equal (${new Date(localTime).toISOString()} >= ${new Date(remoteTime).toISOString()})`,
  );
  await keepLocalVersion(conflict);
  return false;
}

/**
 * Apply the outcome of one sync pass to local storage: mark uploads as synced,
 * save downloads (merging if the user edited meanwhile), accept etags, process
 * remote deletions.
 *
 * @param {Object} result - what fullSync / syncSharedNotebook returned
 * @param {{localNotebooksMap: Map, localNotesMap: Map}} snapshot - local state when the pass began
 * @param {Object} [options]
 * @param {string} [options.sharedNotebookId] - the pass was for this shared notebook
 * @returns {Promise<boolean>} whether anything visible in the overview changed
 */
async function applySyncResult(
  result,
  { localNotebooksMap, localNotesMap },
  { sharedNotebookId = null } = {},
) {
  // Mark uploaded items as synced
  for (const id of result.uploaded.notebooks.uploadedIds || []) {
    // Fetch fresh notebook to avoid overwriting concurrent changes
    const notebook = await getNotebook(id);
    if (notebook) {
      const etag = result.uploaded.notebooks.metadata?.[id]?.etag;
      console.log(`Marking notebook ${id} as synced (was: ${notebook.synced})`);
      await saveNotebook({
        ...notebook,
        synced: true,
        lastSyncedEtag: etag || notebook.lastSyncedEtag,
      });
    }
  }

  // Pass the modified timestamp each note had when it was uploaded so
  // updateNoteEtag won't flip synced=true over an edit made during the sync.
  const uploadedModified = new Map((result.notesToUpload || []).map((n) => [n.id, n.modified]));
  for (const id of result.uploaded.notes.uploadedIds || []) {
    const etag = result.uploaded.notes.metadata?.[id]?.etag;
    // The server now holds exactly what was uploaded, whether or not the user
    // kept typing meanwhile — that text is the next merge's common ancestor.
    await setNoteBase(id, result.uploaded.notes.metadata?.[id]?.baseContent);
    if (etag) {
      // Patch only the index — avoids loading/decrypting/re-encrypting content.
      await updateNoteEtag(id, etag, uploadedModified.get(id));
    } else {
      const index = await getNoteIndex(id);
      if (index) await updateNoteEtag(id, index.lastSyncedEtag, uploadedModified.get(id));
    }
  }

  // Save downloaded items
  console.log(
    `[Sync] fullSync returned: downloaded ${result.downloaded.notes.length} notes, ${result.downloaded.notebooks.length} notebooks; noteEtagsToUpdate=${result.noteEtagsToUpdate?.length ?? 0}; uploaded notes=${result.uploaded.notes.uploaded} notebooks=${result.uploaded.notebooks.uploaded}; conflicts notes=${result.conflicts?.notes?.length ?? 0}`,
  );
  for (const notebook of result.downloaded.notebooks) {
    // Check for race condition: has local notebook changed since sync started?
    const currentLocalNotebook = await getNotebook(notebook.id);
    const originalLocalNotebook = localNotebooksMap.get(notebook.id);

    if (
      currentLocalNotebook &&
      (!originalLocalNotebook || currentLocalNotebook.modified !== originalLocalNotebook.modified)
    ) {
      console.warn(
        `[Sync] Race condition detected for notebook ${notebook.id}. Keeping local changes.`,
      );
      // Keep local version but update base ETag so next sync uploads it cleanly
      await saveNotebook({
        ...currentLocalNotebook,
        synced: false,
        lastSyncedEtag: notebook.lastSyncedEtag,
      });
    } else {
      // Sharing fields stay as this device has them; the file never sets them
      await saveNotebook(adoptRemoteNotebook(notebook, currentLocalNotebook));
    }
  }

  for (const note of result.downloaded.notes) {
    // A shared notebook's files are the sharer's: a note whose id belongs to a
    // different notebook here would overwrite one of this user's own notes
    if (sharedNotebookId && !(await belongsToSharedNotebook(note, sharedNotebookId))) {
      console.warn(`[Sync] Ignoring shared note ${note.id}: its id is already used elsewhere`);
      continue;
    }

    // Strip _currentFileEtag (internal) and thumbnail (legacy safety strip).
    const { _currentFileEtag, thumbnail: _thumbnail, ...noteToSave } = note;
    noteToSave.lastSyncedEtag = _currentFileEtag || note.lastSyncedEtag;
    purgePdfPageDeletedMedia(noteToSave);
    // Mark as synced: the downloaded version IS the server's version, so it should not
    // be re-uploaded on the next sync cycle (prevents oscillation when Nextcloud etags
    // differ between syncs due to server-side processing or multiple clients).
    noteToSave.synced = true;

    // Check for race condition: has local note changed since sync started?
    // Use index-only read to avoid decrypting content unnecessarily.
    const currentLocalIndex = await getNoteIndex(note.id);
    const originalLocalNote = localNotesMap.get(note.id);

    console.log(
      `[Sync:save] note=${note.id} currentLocal.modified=${currentLocalIndex?.modified} originalLocal.modified=${originalLocalNote?.modified} noteToSave.modified=${noteToSave.modified} currentLocal.version=${currentLocalIndex?.version} noteToSave.version=${noteToSave.version}`,
    );

    if (
      currentLocalIndex &&
      originalLocalNote &&
      currentLocalIndex.modified !== originalLocalNote.modified
    ) {
      console.warn(
        `[Sync:save] note=${note.id} → RACE CONDITION (local modified during sync). Attempting merge.`,
      );
      // Only load full content now that we know a merge is actually needed.
      const currentLocal = await getNote(note.id);
      const merged = currentLocal
        ? attemptMerge(currentLocal, noteToSave, {
            base: await getNoteBase(note.id).catch(() => null),
            localAuthor: await getCurrentUserId(),
          })
        : null;
      if (merged) {
        console.log(`[Sync:save] note=${note.id} → race merge succeeded, saving merged`);
        await saveNote(merged);
        // The merged note still has to be uploaded; the server's text is what it merges against
        await setNoteBase(note.id, noteToSave.content);
      } else {
        console.warn(
          `[Sync:save] note=${note.id} → race merge failed (text conflict). Keeping local version.`,
        );
      }
    } else if (
      currentLocalIndex &&
      currentLocalIndex.version === (noteToSave.version || 0) &&
      currentLocalIndex.modified === (noteToSave.modified || 0)
    ) {
      // Downloaded content is not newer than local — just update the etag silently.
      console.log(
        `[Sync:save] note=${note.id} → version+modified identical (${currentLocalIndex.version}/${currentLocalIndex.modified}). Skipping save, updating etag only.`,
      );
      await updateNoteEtag(note.id, noteToSave.lastSyncedEtag, currentLocalIndex.modified);
    } else {
      console.log(
        `[Sync:save] note=${note.id} → saving downloaded note (version ${noteToSave.version}, modified ${noteToSave.modified})`,
      );
      await saveNote(noteToSave);
      await setNoteBase(note.id, noteToSave.content);
    }
  }

  // Accept remote etag for notes whose server etag changed but content is not newer than local.
  // This silently updates lastSyncedEtag without downloading content or firing datachange.
  for (const { id, etag, modified } of result.noteEtagsToUpdate || []) {
    await updateNoteEtag(id, etag, modified);
  }

  // Process deletions (Remote deleted -> Local delete)
  for (const notebookId of result.notebooksToDelete || []) {
    console.log(`[Sync] Permanently deleting local notebook ${notebookId} (purged remotely)`);
    // Ensure all notes in the notebook are also permanently deleted
    await permanentlyDeleteNotesInNotebook(notebookId);
    await permanentlyDeleteNotebook(notebookId);
  }
  for (const noteId of result.notesToDelete || []) {
    console.log(`[Sync] Permanently deleting local note ${noteId} (purged remotely)`);
    await permanentlyDeleteNote(noteId);
  }

  // Whether content visible in the overview actually changed. Uploads (marking
  // synced=true) don't affect what the overview displays, so they don't count.
  // Downloads, merges, and deletions do. A merge with the server's version is
  // saved locally and uploaded, never downloaded: without counting it, a note
  // open while both sides changed it never took the other side's strokes in.
  return (
    result.downloaded.notes.length > 0 ||
    (result.mergedNoteIds?.length ?? 0) > 0 ||
    result.downloaded.notebooks.length > 0 ||
    (result.notesToDelete?.length ?? 0) > 0 ||
    (result.notebooksToDelete?.length ?? 0) > 0
  );
}

/**
 * Whether a note downloaded from a shared notebook may be saved: its id must be
 * free or already belong to that notebook.
 */
async function belongsToSharedNotebook(note, notebookId) {
  const existing = await getNoteIndex(note.id);
  return !existing || existing.notebookId === notebookId;
}

/**
 * Sync every notebook shared with this user, each in isolation: a failing share
 * never affects the own tree or another share.
 * @returns {Promise<{changed: boolean, rootMissing: string[]}>}
 */
async function syncSharedNotebooks(shared) {
  let changed = false;
  const rootMissing = [];
  for (const entry of shared) {
    let { notebook, notes } = entry;
    try {
      // A second pass only to upload what a conflict resolution kept locally
      for (let pass = 1; pass <= 2; pass++) {
        const result = await syncSharedNotebook(
          notebook,
          notes.map((n) => ({ ...n })),
        );
        if (result.rootMissing) {
          rootMissing.push(notebook.id);
          break;
        }
        const snapshot = {
          localNotebooksMap: new Map([[notebook.id, notebook]]),
          localNotesMap: new Map(notes.map((n) => [n.id, n])),
        };
        changed =
          (await applySyncResult(result, snapshot, { sharedNotebookId: notebook.id })) || changed;
        await recordStrandedNotes(notebook.id, result.strandedNoteIds ?? []);

        // A structurally unmergeable note on a collaborative notebook is never put to the user
        let keptLocal = false;
        for (const conflict of result.conflicts?.notes ?? []) {
          if (await resolveConflictByTimestamp(conflict)) changed = true;
          else keptLocal = true;
        }
        if (!keptLocal || pass === 2) break;
        notebook = (await getNotebook(notebook.id)) ?? notebook;
        notes = (await getAllNoteMetadataForSync()).filter((n) => n.notebookId === notebook.id);
      }
    } catch (error) {
      console.error(`[Sync] Shared notebook ${notebook.id} failed:`, error);
    }
  }
  return { changed, rootMissing };
}

/** Remember which notes of a shared notebook hold changes that cannot be uploaded. */
async function recordStrandedNotes(notebookId, strandedNoteIds) {
  const notebook = await getNotebook(notebookId);
  if (!notebook) return;
  const before = [...(notebook.strandedNoteIds ?? [])].sort().join(",");
  const after = [...strandedNoteIds].sort().join(",");
  if (before === after) return;
  // Local bookkeeping only: this must not mark the notebook as needing upload
  await saveNotebook({ ...notebook, strandedNoteIds });
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
  // How long a full sync takes, to tell whether it may run while someone writes
  // (review P4, 4.2): its long tasks are named after it (perfMonitor.js)
  const startedAt = Date.now();
  const endStep = perfStep("full sync");

  try {
    // Conflict resolutions are saved locally, then a fresh pass picks them up as
    // plain uploads. A bounded loop replaces the old self-recursion (which could
    // re-enter indefinitely); after MAX_SYNC_PASSES whatever conflicts remain are
    // reported via the sync-conflicts event below.
    const MAX_SYNC_PASSES = 3;

    // First: the own root really is ours, and the notebooks shared with us are known
    // (a manual sync looks for new shares at once; background syncs at most once a minute)
    if (isSharingEnabled()) await prepareSharing({ force: !silent });

    let usePreferNewer = preferNewer;
    let notebooks;
    let notes;
    let localNotebooksMap;
    let localNotesMap;
    let sharedNotebooks;
    let result;
    // Over all passes: whether anything visible changed, and what moved
    let hasVisibleChanges = false;
    const moved = { notes: [0, 0], notebooks: [0, 0] }; // [uploaded, downloaded]

    for (let pass = 1; ; pass++) {
      console.log(`Sync: Starting ${silent ? "silent" : "manual"} sync (pass ${pass})...`);

      notebooks = await getAllNotebooksForSync();
      // Fetch lightweight metadata only — no strokes, content, or media blobs.
      // Full note content is lazy-loaded inside fullSync only for notes that need uploading or merging.
      notes = await getAllNoteMetadataForSync();

      // Debug: Show unsynced items count
      if (!silent) {
        const unsyncedNotebooks = notebooks.filter((n) => n.synced === false);
        const unsyncedNotes = notes.filter((n) => n.synced === false);
        console.log(
          `Before sync - Unsynced: ${unsyncedNotebooks.length} notebooks, ${unsyncedNotes.length} notes`,
        );
      }

      // Notebooks shared with this user live in the sharer's tree: they get their
      // own passes below, and the own pass must not see them (it would find their
      // notes "missing" in /NoteBerg and heal them there).
      registerSharedBases(notebooks);
      const split = splitByOrigin(notebooks, notes);
      // With sharing switched off, notebooks shared earlier stay on the device
      // untouched: kept out of the own pass above, but not synced either
      sharedNotebooks = isSharingEnabled() ? split.shared : [];

      // Create maps of original local state for race condition detection
      localNotebooksMap = new Map(split.own.notebooks.map((n) => [n.id, n]));
      localNotesMap = new Map(split.own.notes.map((n) => [n.id, n]));

      // Pass copies of notes to fullSync to prevent any potential mutation of our local references
      // which we need for updating status later.
      const notesForSync = split.own.notes.map((n) => ({ ...n }));
      result = await fullSync(split.own.notebooks, notesForSync);
      // Applied before the next pass reads local state: otherwise it sees this
      // pass's uploads as still unsynced and its downloads as still to come
      hasVisibleChanges =
        (await applySyncResult(result, { localNotebooksMap, localNotesMap })) || hasVisibleChanges;
      moved.notes[0] += result.uploaded.notes.uploaded;
      moved.notes[1] += result.downloaded.notes.length;
      moved.notebooks[0] += result.uploaded.notebooks.uploaded;
      moved.notebooks[1] += result.downloaded.notebooks.length;

      const noteConflicts = result.conflicts?.notes ?? [];
      if (noteConflicts.length === 0 || pass >= MAX_SYNC_PASSES) break;

      // Automatic timestamp-based conflict resolution (for app startup)
      if (usePreferNewer) {
        for (const conflict of noteConflicts) {
          if (await resolveConflictByTimestamp(conflict)) hasVisibleChanges = true;
        }
        usePreferNewer = false;
        continue; // re-run so resolutions upload
      }

      // Manual conflict resolution (only for manual syncs)
      if (!skipConflictResolution && !silent) {
        for (const conflict of noteConflicts) {
          // Two people cannot be asked the same question and be trusted to
          // answer it the same way — each would resolve differently and the
          // note would flip-flop. Collaborative notes resolve deterministically.
          if (await isCollaborativeNote(conflict.local)) {
            if (await resolveConflictByTimestamp(conflict)) hasVisibleChanges = true;
            continue;
          }
          const choice = await showConflictResolutionDialog(conflict.local, conflict.remote);
          if (choice === "local") await keepLocalVersion(conflict);
          else {
            await acceptRemoteVersion(conflict.remote);
            hasVisibleChanges = true;
          }
        }
        continue; // re-run so resolutions upload
      }

      // Silent sync with conflicts and no resolution strategy — report them below
      break;
    }

    // Update last sync result on success
    lastSyncResult = {
      success: true,
      timestamp: Date.now(),
      uploaded: { notes: moved.notes[0], notebooks: moved.notebooks[0] },
      downloaded: { notes: moved.notes[1], notebooks: moved.notebooks[1] },
    };

    // Notebooks shared with this user, one isolated pass each
    const sharedOutcome = await syncSharedNotebooks(sharedNotebooks);
    hasVisibleChanges = sharedOutcome.changed || hasVisibleChanges;
    lastSyncResult.sharedRootsMissing = sharedOutcome.rootMissing;
    // A shared folder that has gone is either a moved mount or a share that ended
    if (sharedOutcome.rootMissing.length > 0) await runDiscovery();

    // Dispatch event for UI updates only when something visible in the overview changed.
    if (hasVisibleChanges) {
      window.dispatchEvent(new CustomEvent("datachange"));
    }

    // Who the own notebooks are shared with can change without this device knowing
    // (a recipient left); look again, but never make the sync wait for it
    if (isSharingEnabled()) {
      (silent ? refreshOwnerSharesIfStale() : refreshOwnerShares()).catch(() => {});
    }

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

    console.log(
      `[Sync] ${silent ? "Silent" : "Manual"} full sync took ${Date.now() - startedAt} ms: ` +
        `${notes.length} notes and ${notebooks.length} notebooks here; ` +
        `up ${moved.notes[0]} notes, down ${moved.notes[1]} notes`,
    );
    return result;
  } catch (error) {
    console.error("Sync: Failed", error);
    lastSyncResult = {
      success: false,
      timestamp: Date.now(),
      error: error.message,
    };
    throw error;
  } finally {
    endStep();
    isSyncing = false;
    notifySyncStatusChange();
  }
}
