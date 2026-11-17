/**
 * Whether the user can share notebooks right now: sharing is released and the
 * app is connected to a Nextcloud account (always true inside Nextcloud itself).
 */

import { isSharingEnabled } from "./enabled.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

export async function isSharingAvailable() {
  if (!isSharingEnabled()) return false;
  if (IS_NEXTCLOUD) return true;
  const { isAuthenticated } = await import("../nextcloudSync.js");
  return isAuthenticated();
}
