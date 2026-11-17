/**
 * Who the user shares their own notebooks with (the owner's side of DESIGN §3).
 *
 * One request lists the shares of every notebook, so the "Shared" badge costs a
 * single call. The answer is kept in memory for the session and refreshed when
 * the share dialog changes it, after a manual sync, and at most once a minute
 * after background syncs; it is never persisted, because the server is the only
 * authority on who currently has access.
 */

import { ROOT_FOLDER } from "../storagePaths.js";
import { isSharingAvailable } from "./availability.js";
import { listSharesInFolder } from "./nextcloudShares.js";
import { SHARE_REFRESH_INTERVAL_MS } from "./refreshInterval.js";

const NOTEBOOKS_FOLDER = `${ROOT_FOLDER}/notebooks`;

/** @type {Map<string, Array<object>>} notebook id -> user shares */
let sharesByNotebook = new Map();
let loaded = false;
let inFlight = null;
let lastRefreshAt = Number.NEGATIVE_INFINITY;

/** The notebook a share belongs to: the path segment directly under the notebooks folder. */
export function notebookIdOf(share) {
  const prefix = `${NOTEBOOKS_FOLDER}/`;
  const path = share.path ?? "";
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length).split("/")[0] || undefined;
}

const fingerprint = (map) =>
  JSON.stringify(
    [...map.entries()]
      .map(([id, shares]) => [id, shares.map((s) => `${s.id}:${s.permissions}`).sort()])
      .sort(),
  );

function announceChange() {
  window.dispatchEvent(new CustomEvent("datachange"));
}

/** The user shares of one own notebook, as last seen. */
export function getOwnerShares(notebookId) {
  return sharesByNotebook.get(notebookId) ?? [];
}

/** How many people the notebook is shared with, as last seen. */
export function getRecipientCount(notebookId) {
  return getOwnerShares(notebookId).length;
}

/**
 * Read every notebook's shares from the server. A failed read keeps what was
 * known: a hiccup must not make notebooks look unshared.
 * @returns {Promise<boolean>} whether anything changed
 */
export function refreshOwnerShares() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!(await isSharingAvailable())) return false;
    let shares;
    try {
      shares = await listSharesInFolder(NOTEBOOKS_FOLDER);
    } catch (error) {
      console.warn("[Sharing] Could not read the notebooks' shares:", error);
      return false;
    }

    const next = new Map();
    for (const share of shares) {
      const id = notebookIdOf(share);
      if (id) next.set(id, [...(next.get(id) ?? []), share]);
    }
    const changed = fingerprint(next) !== fingerprint(sharesByNotebook);
    sharesByNotebook = next;
    loaded = true;
    lastRefreshAt = Date.now();
    if (changed) announceChange();
    return changed;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Read the shares once per session; later calls reuse the answer. */
export function ensureOwnerShares() {
  return loaded ? Promise.resolve(false) : refreshOwnerShares();
}

/**
 * Read the shares again if the last answer is more than a minute old: for
 * background callers (every sync), which can come every few seconds.
 * @returns {Promise<boolean>} whether anything changed
 */
export function refreshOwnerSharesIfStale(now = Date.now) {
  if (now() - lastRefreshAt < SHARE_REFRESH_INTERVAL_MS) return Promise.resolve(false);
  return refreshOwnerShares();
}

/** The share dialog knows the newest state of one notebook: take it over. */
export function recordOwnerShares(notebookId, shares) {
  const before = getRecipientCount(notebookId);
  const next = new Map(sharesByNotebook);
  if (shares.length > 0) next.set(notebookId, shares);
  else next.delete(notebookId);
  const changed = fingerprint(next) !== fingerprint(sharesByNotebook);
  sharesByNotebook = next;
  if (changed || before !== shares.length) announceChange();
}

/** Forget everything (sign-out, tests). */
export function resetOwnerShares() {
  sharesByNotebook = new Map();
  loaded = false;
  inFlight = null;
  lastRefreshAt = Number.NEGATIVE_INFINITY;
}
