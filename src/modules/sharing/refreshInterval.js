/**
 * How often the app looks at shares again without being asked: which notebooks
 * are shared with the user (discovery) and whom the user shares theirs with
 * (the badges). Syncs and notebook listings can come every few seconds; shares
 * change rarely, and a manual sync, leaving a share or the share dialog always
 * look at once.
 */
export const SHARE_REFRESH_INTERVAL_MS = 60_000;
