/**
 * Whether notebook sharing is switched on for this device.
 *
 * Two layers, so the feature can ship as a preview:
 *  - `SHARING_ENABLED` (config.js) is the release gate, fixed at build time. Off,
 *    sharing is not in the build at all.
 *  - The user's choice (Settings > Notebook sharing, preview; on the native
 *    clients in the Nextcloud sync section) decides. It is off until the user
 *    turns it on, so a user who never does runs exactly the code that shipped
 *    before sharing existed: no share discovery, no owner lookups in the sync
 *    requests, no sharing menus.
 *
 * The choice is per device (per browser in the Nextcloud app) and kept in
 * localStorage, like displayPrefs.js: it has to be readable synchronously from
 * the sync code, and `getSetting` is in-memory only in the Nextcloud app.
 */

import { SHARING_ENABLED } from "./config.js";

export const SHARING_PREF_KEY = "sharing_enabled";
/** Set once the user turned sharing on; never cleared (see isForeignGuardActive). */
export const SHARING_EVER_KEY = "sharing_ever_enabled";
export const SHARING_PREF_EVENT = "sharing-preference-changed";

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("[Sharing] Could not store the sharing preference:", e);
  }
}

/** Whether sharing is on: released, and turned on by the user. */
export function isSharingEnabled() {
  if (!SHARING_ENABLED) return false;
  return read(SHARING_PREF_KEY) === "true";
}

/**
 * Whether sync must keep other people's data out of the own tree. That is the
 * case while sharing is on, and also after it was turned off again: a share
 * accepted into /NoteBerg stays mounted there, and without the guard its content
 * would be read as the user's own and synced (even deleted) as such.
 */
export function isForeignGuardActive() {
  if (!SHARING_ENABLED) return false;
  return isSharingEnabled() || read(SHARING_EVER_KEY) === "true";
}

/** The user's choice; tells the rest of the app (settings, overview, sync). */
export function setSharingEnabled(enabled) {
  write(SHARING_PREF_KEY, enabled ? "true" : "false");
  if (enabled) write(SHARING_EVER_KEY, "true");
  window.dispatchEvent(new CustomEvent(SHARING_PREF_EVENT, { detail: { enabled } }));
}
