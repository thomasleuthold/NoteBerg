/**
 * Window events about the state of notebooks shared with the user.
 */

/** A notebook shared with the user is no longer shared. detail: { notebookId } */
export const SHARE_ENDED_EVENT = "share-ended";

export function announceShareEnded(notebookId) {
  window.dispatchEvent(new CustomEvent(SHARE_ENDED_EVENT, { detail: { notebookId } }));
}

/**
 * A notebook shared with the user can no longer be edited by them (the owner
 * changed the share to view only). detail: { notebookId }
 */
export const SHARE_ACCESS_REDUCED_EVENT = "share-access-reduced";

export function announceAccessReduced(notebookId) {
  window.dispatchEvent(new CustomEvent(SHARE_ACCESS_REDUCED_EVENT, { detail: { notebookId } }));
}
