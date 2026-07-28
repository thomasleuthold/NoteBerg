/**
 * Display Preferences
 *
 * Per-device UI preferences that are not tied to note content.
 *
 * Storage: raw `localStorage`. This is the only mechanism that persists
 * per-device identically on both native (Tauri webview) and the Nextcloud web
 * build — `getSetting`/`setSetting` is IndexedDB-backed on native but
 * in-memory-only on the NC build (storage.webdav.js), so a preference stored
 * that way silently resets on every reload there. Mirrors the existing pattern
 * in helpGuidance.js and theme.js.
 *
 * Per-device is also the right semantic for these: a phone and a desktop
 * legitimately want different card sizes.
 */

const CARD_SIZE_STORAGE_KEY = "card_size";
const CARD_SIZES = ["small", "medium", "large"];
const DEFAULT_CARD_SIZE = "medium";

/**
 * Overview note-card size.
 * @returns {"small"|"medium"|"large"}
 */
export function getCardSize() {
  const stored = localStorage.getItem(CARD_SIZE_STORAGE_KEY);
  return CARD_SIZES.includes(stored) ? stored : DEFAULT_CARD_SIZE;
}

/**
 * @param {"small"|"medium"|"large"} size
 */
export function setCardSize(size) {
  if (!CARD_SIZES.includes(size)) {
    console.warn(`Invalid card size: ${size}. Using ${DEFAULT_CARD_SIZE}`);
    size = DEFAULT_CARD_SIZE;
  }
  localStorage.setItem(CARD_SIZE_STORAGE_KEY, size);
}

export function getAvailableCardSizes() {
  return [...CARD_SIZES];
}

/**
 * One-time migration of the card size that older native builds stored in
 * IndexedDB via setSetting(). Without this, existing users' choice would
 * silently reset to "medium" on upgrade.
 *
 * Only runs when localStorage has no value yet, so it can never clobber a
 * choice the user made after upgrading. Never runs meaningfully on the NC
 * build — getSetting() is in-memory there and returns null on a fresh load,
 * which is precisely the bug this move fixes.
 *
 * @param {(key: string) => Promise<unknown>} getSetting
 */
export async function migrateCardSizeFromSettings(getSetting) {
  if (localStorage.getItem(CARD_SIZE_STORAGE_KEY) !== null) return;

  try {
    const legacy = await getSetting(CARD_SIZE_STORAGE_KEY);
    if (CARD_SIZES.includes(legacy)) {
      localStorage.setItem(CARD_SIZE_STORAGE_KEY, legacy);
      console.log(`[displayPrefs] Migrated card size from settings store: ${legacy}`);
    }
  } catch (error) {
    // Non-fatal: the user keeps the default and can re-pick in Settings.
    console.warn("[displayPrefs] Card size migration failed:", error);
  }
}
