/**
 * Which local notebooks live in someone else's tree, and where.
 *
 * The path registry in storagePaths.js is fed from the local notebook records
 * (native build). A shared notebook that cannot be located right now (its share
 * ended, or no mount is known yet) is registered as ended, so any attempt to
 * build a path for it throws instead of silently resolving into the own tree.
 */

import { markShareEnded, setSharedNotebookBases, validateBasePath } from "../storagePaths.js";
import { isShared } from "./sharePermissions.js";

/** A shared notebook that can be synced right now: its share is live and its mount is known. */
export function isSyncableShared(notebook) {
  return isShared(notebook) && !notebook.shareEnded && Boolean(notebook.remoteBasePath);
}

/**
 * Point the path helpers at the mounts of the shared notebooks in `notebooks`.
 * Call at the start of every sync pass and whenever notebook records change.
 */
export function registerSharedBases(notebooks) {
  const bases = new Map();
  const unresolvable = [];
  for (const notebook of notebooks) {
    if (!isShared(notebook)) continue;
    if (!isSyncableShared(notebook)) {
      unresolvable.push(notebook.id);
      continue;
    }
    try {
      bases.set(notebook.id, validateBasePath(notebook.remoteBasePath));
    } catch (error) {
      console.warn(`[Sharing] Notebook ${notebook.id}: ${error.message}`);
      unresolvable.push(notebook.id);
    }
  }
  setSharedNotebookBases(bases);
  for (const id of unresolvable) markShareEnded(id);
}

/**
 * Separate what belongs to the own tree from what is shared with this user.
 * Notes of a shared notebook that cannot be synced right now are in neither
 * group: they are not the own tree's to heal and there is no mount to sync them to.
 *
 * @returns {{own: {notebooks: Array, notes: Array}, shared: Array<{notebook: Object, notes: Array}>}}
 */
export function splitByOrigin(notebooks, notes) {
  const sharedIds = new Set(notebooks.filter(isShared).map((nb) => nb.id));
  const own = {
    notebooks: notebooks.filter((nb) => !sharedIds.has(nb.id)),
    notes: notes.filter((n) => !sharedIds.has(n.notebookId)),
  };
  const shared = notebooks.filter(isSyncableShared).map((notebook) => ({
    notebook,
    notes: notes.filter((n) => n.notebookId === notebook.id),
  }));
  return { own, shared };
}
