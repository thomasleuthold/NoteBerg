/**
 * The signed-in Nextcloud user as the in-Nextcloud app build sees it: the page
 * Nextcloud serves provides `window.OC`. The native build never has it.
 */

/** The user ID of the page's session, or null when the page does not say. */
export function getSessionUid() {
  return window.OC?.currentUser || window.OC?.getCurrentUser?.()?.uid || null;
}
