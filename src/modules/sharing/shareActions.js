/**
 * What the user can do about a notebook shared with them, the same on both builds.
 * The native build keeps registrations as notebook records and removes local
 * data; the Nextcloud app build only keeps them in memory (nativeSharing.js and
 * storage.webdav.js respectively). Callers need not know which they are on.
 */

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

/** Whether removing the notebook would lose changes never saved to the share. */
export async function hasUnsyncedChanges(notebook) {
  if (IS_NEXTCLOUD) return false;
  const { hasUnsyncedChangesInSharedNotebook } = await import("./nativeSharing.js");
  return hasUnsyncedChangesInSharedNotebook(notebook);
}

/** "Remove from my list": leave the share and forget the notebook. */
export async function leaveSharedNotebook(notebook) {
  if (IS_NEXTCLOUD) {
    const { leaveSharedNotebook: leave } = await import("../storage.js");
    await leave(notebook.id);
    return;
  }
  const { leaveSharedNotebook: leave } = await import("./nativeSharing.js");
  await leave(notebook);
}

/** Dismiss the notice of an ended share, dropping the frozen notebook. */
export async function dismissEndedShare(notebook) {
  // An ended share is forgotten at once on the Nextcloud app build: nothing is kept there
  if (IS_NEXTCLOUD) return;
  const { dismissEndedSharedNotebook } = await import("./nativeSharing.js");
  await dismissEndedSharedNotebook(notebook);
}

/** Give up the changes a share no longer allows to be saved. */
export async function discardStrandedChanges(notebook) {
  if (IS_NEXTCLOUD) return;
  const { discardStrandedChanges: discard } = await import("./nativeSharing.js");
  await discard(notebook);
}

/**
 * Accept a notebook another user wants to share: it is registered at once and
 * its notes arrive with the next sync (native) or the next listing (Nextcloud).
 * @param {import("./invitations.js").Invitation} invitation
 */
export async function acceptInvitation(invitation) {
  const { acceptPendingShare } = await import("./nextcloudShares.js");
  const { dropInvitation } = await import("./invitations.js");
  await acceptPendingShare(invitation.shareId);
  dropInvitation(invitation.shareId);
  if (IS_NEXTCLOUD) {
    const { refreshSharedNotebooks } = await import("../storage.js");
    await refreshSharedNotebooks();
    return;
  }
  const { runDiscovery } = await import("./nativeSharing.js");
  await runDiscovery();
  // Fetch its notes now rather than at the next sync
  const { performSync } = await import("../sync.js");
  performSync({ silent: true }).catch((error) => console.warn("[Sharing] Sync failed:", error));
}

/**
 * Decline a notebook another user wants to share. The owner would have to share
 * it again for the user to change their mind.
 * @param {import("./invitations.js").Invitation} invitation
 */
export async function declineInvitation(invitation) {
  const { rejectPendingShare } = await import("./nextcloudShares.js");
  const { dropInvitation } = await import("./invitations.js");
  await rejectPendingShare(invitation.shareId);
  dropInvitation(invitation.shareId);
}
