/**
 * Notebooks other users want to share with this one, waiting for an answer.
 *
 * On a server where shares need accepting, the app never accepts on its own:
 * that would override the server's setting, and a pending share's contents
 * cannot be looked at before accepting. Discovery lists pending folder shares,
 * keeps those that look like notebooks, and the overview offers them with
 * Accept and Decline (shareActions.js). Ordinary folder shares are left for the
 * user to handle in Nextcloud.
 *
 * Kept in memory and rebuilt by every successful discovery, on both builds.
 */

// Notebook folders are always named by the notebook's id, a UUID (storage.generateId)
const NOTEBOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a pending folder share is probably a notebook: its folder is named
 * like a notebook id. (Nextcloud may append " (2)" when the name is taken.)
 * Accepting still checks for `_notebook.json` before anything is registered.
 */
export function looksLikeNotebookShare(share) {
  const target = share.fileTarget ?? share.path ?? "";
  const name = target.replace(/\/+$/, "").split("/").pop() ?? "";
  return NOTEBOOK_ID.test(name.replace(/ \(\d+\)$/, ""));
}

/**
 * @typedef {object} Invitation
 * @property {string} shareId
 * @property {string|null} ownerUid
 * @property {string|null} ownerDisplayName
 */

/** @type {Invitation[]} */
let invitations = [];

const fingerprint = (list) => list.map((i) => `${i.shareId}:${i.ownerDisplayName}`).join("|");

/** The invitations waiting for an answer. */
export function getInvitations() {
  return invitations;
}

/**
 * Take the pending notebook shares of a successful discovery.
 * @param {Array<object>} pendingShares - pending folder user shares (nextcloudShares.js shape)
 */
export function setInvitations(pendingShares) {
  const next = pendingShares.filter(looksLikeNotebookShare).map((share) => ({
    shareId: share.id,
    ownerUid: share.ownerUid ?? null,
    ownerDisplayName: share.ownerDisplayName ?? null,
  }));
  const changed = fingerprint(next) !== fingerprint(invitations);
  invitations = next;
  if (changed) window.dispatchEvent(new CustomEvent("datachange"));
}

/** An invitation was answered. */
export function dropInvitation(shareId) {
  const next = invitations.filter((i) => i.shareId !== shareId);
  if (next.length === invitations.length) return;
  invitations = next;
  window.dispatchEvent(new CustomEvent("datachange"));
}

/** Forget every invitation (sign-out, tests). */
export function resetInvitations() {
  invitations = [];
}
