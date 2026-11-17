/**
 * Nextcloud sharing API (OCS), both builds (DESIGN §6).
 *
 * One request helper with two ways to authenticate:
 *  - Nextcloud app build: same-origin fetch with the session cookie and the
 *    page's `requesttoken` (the pattern storage.webdav.js uses for WebDAV).
 *  - Native: the stored app password as Basic auth against the configured
 *    server, through Tauri's HTTP client (no CORS).
 *
 * OCS reports failure in the envelope (`ocs.meta.statuscode`), and some
 * endpoints answer HTTP 200 with a failing status, so the envelope is always
 * checked, not just `response.ok`.
 */

import { getSessionUid } from "../nextcloudSession.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

const SHARES_API = "ocs/v2.php/apps/files_sharing/api/v1";
const SHARE_TYPE_USER = 0;

/** Failure reported by the server, either as an HTTP error or in the OCS envelope. */
export class OcsError extends Error {
  constructor(message, { status, statusCode } = {}) {
    super(message);
    this.name = "OcsError";
    /** HTTP status of the response */
    this.status = status;
    /** OCS `meta.statuscode` (may differ from the HTTP status) */
    this.statusCode = statusCode;
  }
}

// ─── Transport ────────────────────────────────────────────────────────────────

let nativeTransport = null;

/**
 * The native build says how it authenticates (app password through the Tauri
 * HTTP client). Registered by nextcloudSync.js, which owns the credentials, so
 * this module never imports it: the Nextcloud app bundle must not pull in the
 * Tauri-bound sync code.
 * @param {() => Promise<{baseUrl: string, fetch: Function, headers: object, userId: string}>} provider
 */
export function setNativeOcsTransport(provider) {
  nativeTransport = provider;
}

/** Where requests go and how they authenticate, for the current build. */
async function getTransport() {
  if (IS_NEXTCLOUD) {
    const oc = window.OC;
    const webroot = oc?.webroot || "";
    return {
      baseUrl: webroot,
      fetch: (url, options) => fetch(url, { ...options, credentials: "same-origin" }),
      headers: { requesttoken: oc?.requestToken || "" },
      userId: getSessionUid(),
    };
  }
  if (!nativeTransport) throw new Error("OCS transport is not configured");
  return nativeTransport();
}

/**
 * Call an OCS endpoint and return its `data`.
 * @param {string} method
 * @param {string} path - below the files_sharing API root, e.g. "shares"
 * @param {{query?: Record<string,string>, form?: Record<string,string|number>}} [params]
 */
async function ocs(method, path, { query = {}, form } = {}) {
  const transport = await getTransport();
  const search = new URLSearchParams({ format: "json", ...query });
  const options = {
    method,
    headers: {
      ...transport.headers,
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
  };
  if (form) {
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(
      Object.entries(form).map(([k, v]) => [k, String(v)]),
    ).toString();
  }

  const response = await transport.fetch(
    `${transport.baseUrl}/${SHARES_API}/${path}?${search}`,
    options,
  );

  let envelope = null;
  try {
    envelope = await response.json();
  } catch (_e) {
    // Not JSON (proxy error page, empty body): reported below
  }
  const meta = envelope?.ocs?.meta;
  const statusCode = meta?.statuscode;
  // v2 uses HTTP-style codes (200); v1 style success is 100
  const ok = response.ok && (statusCode === undefined || statusCode === 100 || statusCode === 200);
  if (!ok || !meta) {
    throw new OcsError(meta?.message || `OCS ${method} ${path} failed: HTTP ${response.status}`, {
      status: response.status,
      statusCode,
    });
  }
  return envelope.ocs.data;
}

/** The user ID of the signed-in account. */
async function currentUserId() {
  return (await getTransport()).userId;
}

// ─── Shapes ───────────────────────────────────────────────────────────────────

/**
 * A share as the rest of the app sees it. OCS returns permissions and ids as
 * numbers or strings depending on the endpoint; both are normalized here.
 */
function normalizeShare(raw) {
  return {
    id: String(raw.id),
    shareType: Number(raw.share_type),
    permissions: Number(raw.permissions),
    itemType: raw.item_type,
    // The node, stable across renames and moves; merges duplicate mounts
    itemSource: raw.item_source != null ? String(raw.item_source) : null,
    ownerUid: raw.uid_owner ?? null,
    ownerDisplayName: raw.displayname_owner ?? null,
    shareWith: raw.share_with ?? null,
    shareWithDisplayName: raw.share_with_displayname ?? null,
    // Where the share is mounted in the recipient's own tree
    fileTarget: raw.file_target ?? null,
    // The owner's path of the shared folder
    path: raw.path ?? null,
    // 0 accepted, 1 pending, 2 rejected
    state: raw.state != null ? Number(raw.state) : 0,
  };
}

const normalizeShares = (data) => (Array.isArray(data) ? data.map(normalizeShare) : []);

// ─── Sharee search ────────────────────────────────────────────────────────────

/**
 * Search users to share with. Nextcloud only answers a query (it never lists
 * everyone) and may restrict it, e.g. to the user's own groups.
 * @returns {Promise<Array<{uid: string, displayName: string}>>} exact matches first, self excluded
 */
export async function searchSharees(query) {
  const search = (query ?? "").trim();
  if (!search) return [];
  const [data, self] = await Promise.all([
    ocs("GET", "sharees", {
      query: { search, itemType: "folder", lookup: "false", perPage: "20" },
    }),
    currentUserId(),
  ]);

  const seen = new Set();
  const found = [];
  for (const entry of [...(data?.exact?.users ?? []), ...(data?.users ?? [])]) {
    const uid = entry?.value?.shareWith;
    if (!uid || uid === self || seen.has(uid)) continue;
    seen.add(uid);
    found.push({ uid, displayName: entry.label || uid });
  }
  return found;
}

// ─── Shares ───────────────────────────────────────────────────────────────────

/**
 * Share a folder with one user.
 * @param {string} path - the folder in the sharer's tree, e.g. /NoteBerg/notebooks/{id}
 * @param {string} shareWith - recipient user ID
 * @param {number} permissions - permission bits requested; the server may grant fewer
 */
export async function createShare(path, shareWith, permissions) {
  const data = await ocs("POST", "shares", {
    form: { path, shareType: SHARE_TYPE_USER, shareWith, permissions },
  });
  return normalizeShare(data);
}

/** The user shares the signed-in user has made of `path`. */
export async function listSharesForPath(path) {
  const data = await ocs("GET", "shares", { query: { path, reshares: "false" } });
  return normalizeShares(data);
}

/**
 * The user shares of everything directly inside `folder`, in one request
 * (instead of asking for each child). Each share's `path` names its child.
 */
export async function listSharesInFolder(folder) {
  const data = await ocs("GET", "shares", {
    query: { path: folder, subfiles: "true", reshares: "false" },
  });
  return normalizeShares(data).filter((share) => share.shareType === SHARE_TYPE_USER);
}

/** Accepted shares others made with the signed-in user (pending ones are not included). */
export async function listSharedWithMe() {
  return normalizeShares(await ocs("GET", "shares", { query: { shared_with_me: "true" } }));
}

/** Shares waiting for the signed-in user's acceptance. */
export async function listPendingShares() {
  return normalizeShares(await ocs("GET", "shares/pending"));
}

/** Accept a pending share; the folder then appears in the user's file tree. */
export async function acceptPendingShare(id) {
  await ocs("POST", `shares/pending/${encodeURIComponent(id)}`);
}

/** Decline a pending share; it does not appear in the user's files. */
export async function rejectPendingShare(id) {
  await ocs("DELETE", `shares/pending/${encodeURIComponent(id)}`);
}

/** Change the permissions of a share the user made. */
export async function updateSharePermissions(id, permissions) {
  const data = await ocs("PUT", `shares/${encodeURIComponent(id)}`, { form: { permissions } });
  return normalizeShare(data);
}

/**
 * Remove a share. For the owner this revokes it; for a recipient it leaves the
 * share, removing only their own access.
 */
export async function deleteShare(id) {
  await ocs("DELETE", `shares/${encodeURIComponent(id)}`);
}
