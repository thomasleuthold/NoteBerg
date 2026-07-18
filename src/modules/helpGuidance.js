/**
 * Help Guidance persistence
 *
 * Tracks which first-use help tours the user has seen, per device.
 *
 * Storage: raw `localStorage`, one key per overlay ID. This is the only
 * mechanism that persists per-device identically on both native (Tauri webview)
 * and the Nextcloud web build — `getSetting`/`setSetting` is IndexedDB-backed on
 * native but in-memory-only on the NC build (storage.webdav.js), so it would
 * silently fail to persist there. Mirrors the existing pattern in
 * storage.webdav.js (`_INIT_KEY`) and theme.js (`THEME_STORAGE_KEY`).
 *
 * This module has no dependencies on canvas/toolbar code and is inert until
 * called — zero regression surface by itself.
 */

const SEEN_PREFIX = "noteberg_help_seen_";
const STEP_PREFIX = "noteberg_help_step_";

export const HELP_IDS = Object.freeze({
  FIRST_NOTE: "first_note", // multi-step tour (7 steps)
  MODE_PAN: "mode_pan",
  MODE_DRAW: "mode_draw",
  MODE_TEXT: "mode_text",
  MODE_ERASER: "mode_eraser",
  MODE_LASSO: "mode_lasso",
  FIRST_IMAGE: "first_image",
  MARK_AS_TASK: "mark_as_task",
});

export function hasSeenHelp(id) {
  return localStorage.getItem(SEEN_PREFIX + id) === "1";
}

export function markHelpSeen(id) {
  localStorage.setItem(SEEN_PREFIX + id, "1");
  localStorage.removeItem(STEP_PREFIX + id);
}

/**
 * Current step index for a multi-step tour (currently just FIRST_NOTE).
 * Returns 0 if never started, so a fresh tour begins at step 0.
 */
export function getTourStep(id) {
  return Number(localStorage.getItem(STEP_PREFIX + id)) || 0;
}

export function setTourStep(id, stepIndex) {
  localStorage.setItem(STEP_PREFIX + id, String(stepIndex));
}

/**
 * Clear every help flag — used by the "Reset help guidance" Settings row.
 * Only touches the known HELP_IDS set, never other localStorage keys.
 */
export function resetAllHelp() {
  for (const id of Object.values(HELP_IDS)) {
    localStorage.removeItem(SEEN_PREFIX + id);
    localStorage.removeItem(STEP_PREFIX + id);
  }
}
