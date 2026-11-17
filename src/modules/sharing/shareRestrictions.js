/**
 * What a recipient of a shared notebook is never allowed to do, enforced where
 * the data is written (DESIGN §4). The UI hides these actions, but a single
 * missed button must not be able to delete or move the owner's notes, so the
 * storage layer of both builds refuses them too.
 */

import { canEdit, canManage } from "./sharePermissions.js";

/** Thrown when an action a share does not allow reaches the storage layer. */
export class ShareRestrictedError extends Error {
  /**
   * @param {string} action - what was attempted, e.g. "deleteNote"
   * @param {string} [notebookId] - the shared notebook it concerned
   */
  constructor(action, notebookId) {
    super(`Not allowed on a notebook shared with you: ${action}`);
    this.name = "ShareRestrictedError";
    this.action = action;
    this.notebookId = notebookId;
  }
}

/**
 * Deleting, purging, moving, copying and restoring are the owner's alone,
 * whatever permissions the share grants. `notebook` may be null (quick notes).
 * @throws {ShareRestrictedError}
 */
export function assertManageable(notebook, action) {
  if (!canManage(notebook)) throw new ShareRestrictedError(action, notebook.id);
}

/**
 * Changing content needs UPDATE and CREATE on the share.
 * @throws {ShareRestrictedError}
 */
export function assertEditable(notebook, action) {
  if (!canEdit(notebook)) throw new ShareRestrictedError(action, notebook.id);
}
