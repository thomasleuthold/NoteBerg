/**
 * "Rate this app" (Google Play).
 *
 * Deliberately a button the user chooses to press in Settings → About, never a
 * prompt: the app does not ask for ratings on its own.
 *
 * Android build of the native app only. The Nextcloud (browser) build and Windows
 * have no Play Store page.
 */

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

export function isRatingSupported() {
  return !IS_NEXTCLOUD && typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

/** Open this app's Play Store page. */
export async function openStoreListing() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("open_store_listing");
}
