/**
 * Audio recording preferences.
 *
 * Per-device, like displayPrefs.js: raw `localStorage`, not getSetting()/
 * setSetting() (IndexedDB, native-only, meant for synced/task data). A phone
 * carried in a pocket and a desktop mic sit in different noise environments,
 * so "per device" is the right default scope, matching card size and theme.
 *
 * Native-only feature: recording does not exist on the Nextcloud build, so
 * nothing here is read there.
 */

const AGGRESSIVENESS_STORAGE_KEY = "audio_agc_aggressiveness";

/**
 * Default auto-gain aggressiveness, 0.0-1.0.
 *
 * 0.0 keeps today's shipped behaviour (a 6 dB noise margin) unchanged for
 * every existing recording until a user deliberately raises it.
 */
const DEFAULT_AGGRESSIVENESS = 0.0;

/**
 * Auto-gain aggressiveness default for new recordings, 0.0 (least aggressive,
 * today's behaviour) to 1.0 (most aggressive: keeps lifting gain much closer
 * to the tracked noise floor, for use in steady loud noise such as driving).
 * @returns {number}
 */
export function getAutoGainAggressiveness() {
  const stored = Number.parseFloat(localStorage.getItem(AGGRESSIVENESS_STORAGE_KEY));
  return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : DEFAULT_AGGRESSIVENESS;
}

/** @param {number} value - 0.0-1.0 */
export function setAutoGainAggressiveness(value) {
  const clamped = Math.min(1, Math.max(0, Number(value) || 0));
  localStorage.setItem(AGGRESSIVENESS_STORAGE_KEY, String(clamped));
}
