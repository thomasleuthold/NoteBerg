/**
 * Application Configuration
 * Central source of truth for app metadata
 */

export const APP_NAME = "NoteBerg";
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
// Plain semver, no pre-release label: package.json carries the base version only.
// A pre-release stage ("-rc.2") is a Nextcloud-store publishing concern and lives
// exclusively in appinfo/info.xml — it never reaches the built frontend.
export const APP_FULL_VERSION = APP_VERSION;

/**
 * Monotonic build counter from package.json.build, incremented on every build
 * (see sync-version.js). Empty string if unavailable.
 */
export const APP_BUILD = import.meta.env.VITE_APP_BUILD || "";

/**
 * Version string including the build number, e.g. "0.5.38 #2".
 *
 * Used only where the exact build matters — the About section, which is where
 * users read a version off to report a bug. Deliberately separate from
 * APP_FULL_VERSION, which the footer badge and the Nextcloud User-Agent use and
 * which should stay a plain semver label.
 */
export const APP_VERSION_WITH_BUILD = APP_BUILD
  ? `${APP_FULL_VERSION} #${APP_BUILD}`
  : APP_FULL_VERSION;

/**
 * Public project page. Single source of truth so the About section's link can
 * be repointed (e.g. to a downloads page once the Android app ships) without
 * touching component code or the translations.
 */
export const PROJECT_URL = "https://github.com/thomasleuthold/NoteBerg";
