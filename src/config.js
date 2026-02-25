/**
 * Application Configuration
 * Central source of truth for app metadata
 */

export const APP_NAME = "NoteBerg";
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
export const APP_STAGE = "Alpha";
export const APP_FULL_VERSION = `${APP_VERSION} (${APP_STAGE})`;
