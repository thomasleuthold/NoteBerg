/**
 * Sharing for the native build: shared-notebook registrations live in the
 * local notebook records, and discovery runs at the start of every sync.
 */

import { createDavOps, getCurrentUserIdentity } from "../nextcloudSync.js";
import {
  discardLocalChanges,
  getAllNotebooksForSync,
  getAllNoteMetadataForSync,
  getNotebook,
  permanentlyDeleteNotebook,
  permanentlyDeleteNotesInNotebook,
  saveNotebook,
} from "../storage.js";
import { markShareEnded } from "../storagePaths.js";
import { setInvitations } from "./invitations.js";
import * as ocs from "./nextcloudShares.js";
import { SHARE_REFRESH_INTERVAL_MS } from "./refreshInterval.js";
import { discoverShares, dismissEndedShare, guardOwnRoot, leaveShare } from "./sharedRoots.js";
import { announceAccessReduced, announceShareEnded } from "./shareEvents.js";

const notifyChange = () => window.dispatchEvent(new CustomEvent("datachange"));

/**
 * Registrations as notebook records in IndexedDB.
 * @returns {import("./sharedRoots.js").ShareStore}
 */
export function createNativeShareStore() {
  return {
    list: () => getAllNotebooksForSync(),

    async upsert(record) {
      await saveNotebook(record);
      notifyChange();
    },

    async update(id, patch) {
      const notebook = await getNotebook(id);
      if (!notebook) return;
      // Local bookkeeping only: this must not mark the notebook as needing upload
      await saveNotebook({ ...notebook, ...patch });
      notifyChange();
    },

    async forget(id) {
      // Local only: no tombstone and no remote call, the sharer's data is untouched
      await permanentlyDeleteNotesInNotebook(id);
      await permanentlyDeleteNotebook(id);
      markShareEnded(id);
      notifyChange();
    },

    async hasUnsyncedChanges(record) {
      if (record.synced === false || (record.strandedNoteIds?.length ?? 0) > 0) return true;
      const notes = await getAllNoteMetadataForSync();
      return notes.some((n) => n.notebookId === record.id && n.synced === false);
    },
  };
}

// Shares found not to be notebooks, remembered for the session so an ordinary
// folder share costs one request once, not one per sync
let notNotebooks = new Set();
// When discovery last got an answer from the server
let lastDiscoveryAt = Number.NEGATIVE_INFINITY;

/**
 * Before the own tree is touched: make sure `/NoteBerg` is the user's, then
 * bring the registrations of shared notebooks up to date.
 *
 * The root guard runs every time: nothing may be written into a folder that
 * might belong to someone else, so a root that cannot be verified aborts the
 * sync. Discovery runs at most once a minute (syncs can come every few seconds)
 * unless forced, and a failed discovery only skips discovery.
 *
 * @param {{force?: boolean, now?: () => number}} [options] - force: look for shares now (a manual sync)
 * @returns {Promise<void>}
 */
export async function prepareSharing({ force = false, now = Date.now } = {}) {
  const dav = createDavOps();
  const { uid, confirmed } = await getCurrentUserIdentity();
  await guardOwnRoot({ dav, uid, uidConfirmed: confirmed, ocs });
  if (force || now() - lastDiscoveryAt >= SHARE_REFRESH_INTERVAL_MS) {
    await runDiscovery(dav, { now });
  }
}

/** Bring the registrations up to date (also run after a shared root turned out to be gone). */
export async function runDiscovery(dav = createDavOps(), { now = Date.now } = {}) {
  try {
    const outcome = await discoverShares({
      dav,
      ocs,
      store: createNativeShareStore(),
      notNotebooks,
      onShareEnded: announceShareEnded,
      onAccessReduced: announceAccessReduced,
    });
    // A failed listing changes nothing and does not count as a look
    if (outcome.ok) {
      lastDiscoveryAt = now();
      setInvitations(outcome.pending);
    }
    return outcome;
  } catch (error) {
    console.warn("[Sharing] Discovery failed:", error);
    return null;
  }
}

/** Forget what this session learned about shares (sign-out, tests). */
export function resetSharingSession() {
  notNotebooks = new Set();
  lastDiscoveryAt = Number.NEGATIVE_INFINITY;
}

// ─── What the user can do about a shared notebook ─────────────────────────────

/** Whether leaving or dropping the notebook would lose changes that were never saved to the share. */
export function hasUnsyncedChangesInSharedNotebook(notebook) {
  return createNativeShareStore().hasUnsyncedChanges(notebook);
}

/** "Remove from my list": leave the share, then forget the local copy. */
export function leaveSharedNotebook(notebook) {
  return leaveShare({ ocs, store: createNativeShareStore(), notebook });
}

/** "Dismiss" on a notebook whose share ended. */
export function dismissEndedSharedNotebook(notebook) {
  return dismissEndedShare({ store: createNativeShareStore(), notebook });
}

/**
 * "Discard my changes": the notes whose edits can no longer be saved take the
 * shared version instead, and the notice goes away.
 */
export async function discardStrandedChanges(notebook) {
  const store = createNativeShareStore();
  for (const noteId of notebook.strandedNoteIds ?? []) await discardLocalChanges(noteId);
  await store.update(notebook.id, { strandedNoteIds: [] });
}
