/**
 * Whether a note is edited by more than one person.
 *
 * Two people cannot be shown the same blocking question and be trusted to answer
 * it the same way, so such notes never raise the conflict dialog (DESIGN §10.3 D).
 * A note is collaborative when its notebook was shared with this user, or when it
 * is one of their own notebooks that has recipients.
 */

import { getNotebook } from "../storage.js";
import { getRecipientCount } from "./ownerShares.js";
import { isShared } from "./sharePermissions.js";

/**
 * @param {{notebookId?: string|null}} note
 * @returns {Promise<boolean>}
 */
export async function isCollaborativeNote(note) {
  if (!note?.notebookId) return false;
  if (isShared(await getNotebook(note.notebookId))) return true;
  return getRecipientCount(note.notebookId) > 0;
}
