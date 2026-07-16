/**
 * Application Configuration
 * Central source of truth for app metadata
 */

export const APP_NAME = "NoteBerg";
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
// Pre-release stage ("RC", "Beta", …) derived from the package.json version
// suffix at build time (see vite.config.js). Empty string for final releases.
export const APP_STAGE = import.meta.env.VITE_APP_STAGE || "";
export const APP_FULL_VERSION = APP_STAGE ? `${APP_VERSION} (${APP_STAGE})` : APP_VERSION;
