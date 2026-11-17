/**
 * WebDAV Storage Backend — Nextcloud build only
 *
 * Implements the same API surface as storage.js but reads/writes directly
 * to the Nextcloud WebDAV endpoint instead of IndexedDB.
 *
 * File layout mirrors storagePaths.js (shared with Tauri sync):
 *   /NoteBerg/notebooks/{notebookId}/_notebook.json
 *   /NoteBerg/notebooks/{notebookId}/notes/{noteId}.json
 *   /NoteBerg/notebooks/{notebookId}/notes/{noteId}_media/{filename}
 *   /NoteBerg/quickNotes/{noteId}.json
 *   /NoteBerg/quickNotes/{noteId}_media/{filename}
 *   /NoteBerg/notebooks/_tombstones.json
 *   /NoteBerg/notebooks/{notebookId}/_tombstones.json
 *   /NoteBerg/quickNotes/_tombstones.json
 */

import { perfAsync } from "../utils/perfMonitor.js";
import { extFromMime, mimeFromExt } from "./mime.js";
import { getSessionUid } from "./nextcloudSession.js";
import { createDavOps as createSharingDavOps } from "./sharing/davOps.js";
import { isSharingEnabled, SHARING_PREF_EVENT } from "./sharing/enabled.js";
import * as ocs from "./sharing/nextcloudShares.js";
import { stripLocalFields } from "./sharing/notebookShareFields.js";
import { createSharedRegistry } from "./sharing/sharedRegistry.js";
import { guardOwnRoot } from "./sharing/sharedRoots.js";
import { assertEditable, assertManageable } from "./sharing/shareRestrictions.js";
import {
  davHrefToPath,
  encodeDavPath,
  getAllRequiredFolders,
  getGlobalNotebookTombstonePath,
  getMediaPath,
  getNotebookFolder,
  getNotebookNotesFolder,
  getNotebookPath,
  getNotebookTombstonePath,
  getNoteMediaFolder,
  getNotePath,
  getQuickNotesTombstonePath,
  isSafeId,
  ROOT_FOLDER,
} from "./storagePaths.js";
import {
  addMediaTombstone,
  addNotebookTombstone,
  addNoteTombstone,
  cleanupOldTombstones,
  createEmptyTombstone,
} from "./tombstones.js";
import { runNoteFileOp } from "./workers/noteFileClient.js";

// ─── Tombstone helpers ─────────────────────────────────────────────────────────

async function _readTombstoneWithEtag(path) {
  const res = await fetch(davUrl(path), {
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
      "Cache-Control": "no-cache",
    },
    credentials: "same-origin",
  });
  if (res.status === 404) return { tombstone: createEmptyTombstone(), etag: null };
  if (!res.ok) throw new Error(`DAV GET ${path} failed: ${res.status}`);
  const etag = res.headers.get("etag")?.replace(/"/g, "") ?? null;
  // A tombstone that exists but cannot be parsed must abort the operation —
  // replacing it with an empty one would wipe the deletion history and make
  // deleted notes resurrect on other devices.
  const tombstone = await res.json();
  return { tombstone, etag };
}

/**
 * Read-modify-write a tombstone with optimistic concurrency: the PUT carries
 * If-Match (or If-None-Match: * when creating), and on 412 the tombstone is
 * re-read and `mutate` re-applied, so concurrent writers from other devices
 * never lose their entries.
 */
async function _updateTombstone(path, mutate) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    const { tombstone, etag } = await _readTombstoneWithEtag(path);
    mutate(tombstone);
    cleanupOldTombstones(tombstone);
    try {
      await davPut(path, tombstone, etag ? { "If-Match": `"${etag}"` } : { "If-None-Match": "*" });
      return;
    } catch (e) {
      if (e.status !== 412 || attempt >= MAX_ATTEMPTS) throw e;
      console.warn(`[WebDAV] Tombstone ${path} changed concurrently, retrying update`);
    }
  }
}

// ─── Read cache ───────────────────────────────────────────────────────────────
// The overview re-fetches every notebook JSON and every note JSON (including
// strokes) on each render. Cache folder listings briefly; a local write
// invalidates only the entries its path can affect, so staleness is limited to
// changes made by OTHER clients within the TTL — the next render re-fetches.
//
// Invalidation is path-scoped rather than a blanket clear: while drawing, every
// stroke triggers a note PUT, and a full clear would make any concurrent
// overview render re-download every note in the folder.

const CACHE_TTL_MS = 15000;
const _readCache = new Map(); // key → { ts, data }

function _cacheGet(key) {
  const hit = _readCache.get(key);
  if (!hit || Date.now() - hit.ts > CACHE_TTL_MS) return null;
  // Clone so callers can mutate their copy, same contract as a fresh fetch.
  // Callers do mutate: _getNotesInFolder deletes .thumbnail, _normalizeNote
  // rewrites array fields in place.
  return structuredClone(hit.data);
}

/**
 * Store `data` and return the caller's own copy.
 *
 * The cache must not share a reference with the caller — consumers (overview
 * rendering, mcpBridge) treat these results as theirs to mutate. Cloning once
 * here and handing back the clone keeps that guarantee at one clone per miss
 * instead of the two a store-clone + get-clone pair would cost.
 */
function _cacheSet(key, data) {
  _readCache.set(key, { ts: Date.now(), data });
  return structuredClone(data);
}

/**
 * Drop the cache entries a write to `path` can affect.
 *
 * Cache keys are "notebooks" and "notes:<folder>". A write to
 * <folder>/<file>.json can only invalidate the listing of its own parent
 * folder, plus "notebooks" when it touches a _notebook.json. Anything we cannot
 * confidently map (folder MOVE/COPY/DELETE, which can relocate whole trees)
 * falls back to a full clear.
 */
function _invalidateReadCache(path) {
  if (!path) {
    _readCache.clear();
    return;
  }

  // Folder-level operations can move or remove arbitrary subtrees — the set of
  // affected listings is not derivable from the path alone.
  const isFile = path.endsWith(".json");
  if (!isFile) {
    _readCache.clear();
    return;
  }

  const folder = path.slice(0, path.lastIndexOf("/"));
  _readCache.delete(`notes:${folder}`);

  // Notebook metadata lives at <root>/notebooks/<id>/_notebook.json. Tombstones
  // retire whole notebooks (or notes within one), so they can change which
  // notebooks the overview lists.
  if (path.endsWith("/_notebook.json") || path.endsWith("/_tombstones.json")) {
    _readCache.delete("notebooks");
  }
}

// ─── WebDAV helpers ────────────────────────────────────────────────────────────

function getWebDAVBase() {
  const uid = getSessionUid();
  if (!uid) {
    // Never guess a uid — a wrong fallback would aim requests at another
    // user's DAV root. Failing loudly is the safe behavior.
    throw new Error("[WebDAV] Nextcloud user not available (window.OC missing)");
  }
  const webroot = window.OC?.webroot || "";
  return `${webroot}/remote.php/dav/files/${encodeURIComponent(uid)}`;
}

/** The WebDAV URL of a path in the user's file tree (see encodeDavPath). */
function davUrl(path) {
  return `${getWebDAVBase()}${encodeDavPath(path)}`;
}

/**
 * The bare etag of a response: quotes, the weak marker and the "-gzip" / "-br"
 * suffix web servers append to a compressed body are removed. Without that last
 * step a GET's etag never matches the file's real one, and every If-Match
 * built from it fails with 412.
 */
export function bareEtag(value) {
  return value
    ?.replace(/^W\//, "")
    .replace(/"/g, "")
    .replace(/-(gzip|br|deflate)$/, "");
}

function _responseEtag(res) {
  return bareEtag(res.headers?.get?.("etag")) || bareEtag(res.headers?.get?.("oc-etag")) || null;
}

/** GET a JSON document with its etag; null when it does not exist (or is unreadable). */
async function davGetEntry(path) {
  const res = await fetch(davUrl(path), {
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
      "Cache-Control": "no-cache",
    },
    credentials: "same-origin",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DAV GET ${path} failed: ${res.status}`);
  try {
    return { data: await res.json(), etag: _responseEtag(res) };
  } catch (e) {
    console.error(`[WebDAV] JSON parse failed for ${path}:`, e);
    return null;
  }
}

async function davGet(path) {
  return (await davGetEntry(path))?.data ?? null;
}

const LISTING_RETRY_MS = 300;

/**
 * Read the JSON files of a listing. A file that cannot be read right now is
 * tried once more: Nextcloud answers 423 Locked while a file is being written,
 * e.g. the last save of a note that was just closed, and a write into someone
 * else's share holds the lock longer. A listing still missing a file is
 * `complete: false` and must not be cached, or the file would stay out of view
 * for the cache's lifetime. A file that does not exist (404) is simply absent.
 * @returns {Promise<{items: Array<object|null>, complete: boolean}>}
 */
async function _readListing(paths) {
  const read = (path) =>
    davGet(path).then(
      (data) => ({ data }),
      (error) => ({ error }),
    );
  const results = await Promise.all(paths.map(read));
  if (results.some((r) => r.error)) {
    await new Promise((resolve) => setTimeout(resolve, LISTING_RETRY_MS));
    for (const [i, result] of results.entries()) {
      if (result.error) results[i] = await read(paths[i]);
    }
  }
  const failed = results.filter((r) => r.error);
  for (const { error } of failed) console.warn("[WebDAV] Listing left out a file:", error.message);
  return { items: results.map((r) => r.data ?? null), complete: failed.length === 0 };
}

async function davPutWithRetry(path, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(davUrl(path), options);
    if (res.ok) return res;
    // 423 Locked — Nextcloud file lock, wait and retry
    if (res.status === 423 && i < retries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      continue;
    }
    const body = await res.text().catch(() => "");
    console.error(`[WebDAV] PUT ${path} failed ${res.status}:`, body);
    const err = new Error(`DAV PUT ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

/** PUT a JSON document. @returns {Promise<string|null>} the new etag, when the server sent one */
async function davPut(path, data, extraHeaders = {}) {
  _invalidateReadCache(path);
  try {
    const res = await davPutWithRetry(path, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIREQUEST": "true",
        requesttoken: window.OC?.requestToken || "",
        ...extraHeaders,
      },
      credentials: "same-origin",
      body: JSON.stringify(data),
    });
    return _responseEtag(res);
  } finally {
    // Again once the write is over: a listing read while it was in flight (the
    // notebook view renders as soon as a note closes, during its last saves)
    // holds the file as it was, or not at all, and must not be served afterwards
    _invalidateReadCache(path);
  }
}

async function davPutBinary(path, blob) {
  await davPutWithRetry(path, {
    method: "PUT",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: blob,
  });
}

async function davDelete(path) {
  _invalidateReadCache(path);
  const res = await fetch(davUrl(path), {
    method: "DELETE",
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  if (res.status === 404) return; // already gone
  if (!res.ok) throw new Error(`DAV DELETE ${path} failed: ${res.status}`);
}

async function davGetBinary(path) {
  const res = await fetch(davUrl(path), {
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DAV GET binary ${path} failed: ${res.status}`);
  return res.blob();
}

async function davExists(path) {
  const res = await fetch(davUrl(path), {
    method: "PROPFIND",
    headers: {
      Depth: "0",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  return res.ok || res.status === 207;
}

async function davMkcol(path) {
  if (_knownFolders.has(path)) return; // already confirmed to exist
  const res = await fetch(davUrl(path), {
    method: "MKCOL",
    headers: {
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  // 405 = already exists, that's fine
  if (!res.ok && res.status !== 405) {
    console.error(`[WebDAV] MKCOL ${path} failed: ${res.status} — folder not created`);
    throw new Error(`DAV MKCOL ${path} failed: ${res.status}`);
  }
  _knownFolders.add(path);
}

/** Server-side MOVE or COPY (works on files and folders, recursive). */
async function _davMoveOrCopy(method, from, to) {
  // Full clear: this touches two locations and may relocate a whole subtree,
  // so the affected listings are not derivable from a single path.
  _invalidateReadCache();
  const res = await fetch(davUrl(from), {
    method,
    headers: {
      Destination: davUrl(to),
      Overwrite: "T",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
  });
  if (!res.ok) {
    const err = new Error(`DAV ${method} ${from} → ${to} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

async function davMove(from, to) {
  await _davMoveOrCopy("MOVE", from, to);
}

async function davCopy(from, to) {
  await _davMoveOrCopy("COPY", from, to);
}

/** PROPFIND a directory, returns array of child filenames (not the dir itself) */
async function davList(path) {
  const res = await fetch(davUrl(path), {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`DAV PROPFIND ${path} failed: ${res.status}`);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  // By local name: the server's XML is prefixed (d:href), the tests' is not
  const hrefs = [...doc.getElementsByTagNameNS("*", "href")].map((el) => el.textContent.trim());
  return hrefs.map(davHrefToPath).filter((p) => p !== path && p !== `${path}/`); // exclude the dir itself
}

// ─── Notebooks shared with this user ──────────────────────────────────────────
// Registrations live in memory (this build persists nothing) and are rebuilt
// from the server; see sharing/sharedRegistry.js. Off until sharing is released.

/**
 * File operations the sharing module needs, over the session cookie. Their
 * semantics are shared with the native build (sharing/davOps.js).
 */
function createDavOps() {
  return createSharingDavOps({
    request(method, path, { headers = {}, body, destination } = {}) {
      // A move relocates whole subtrees: no cached listing survives it
      if (method === "MOVE") _invalidateReadCache();
      return fetch(davUrl(path), {
        method,
        headers: {
          "OCS-APIREQUEST": "true",
          requesttoken: window.OC?.requestToken || "",
          "Cache-Control": "no-cache",
          ...(destination ? { Destination: davUrl(destination) } : {}),
          ...headers,
        },
        body,
        credentials: "same-origin",
      });
    },
    mkcol: (path) => davMkcol(path),
  });
}

let _registry = null;
let _visibilityHooked = false;

// Switched on or off in Settings: the notebook list must be read again, and off,
// the registry is forgotten or notebooks shared with the user would go on
// resolving from it
window.addEventListener(SHARING_PREF_EVENT, (event) => {
  if (!event.detail?.enabled) _registry = null;
  _invalidateReadCache();
});

/** The registry of shared notebooks, or null while sharing is switched off. */
function getSharedRegistry() {
  if (!isSharingEnabled()) return null;
  if (!_registry) {
    _registry = createSharedRegistry({
      dav: createDavOps(),
      ocs,
      getOwnNotebooks: _listOwnNotebooks,
      onChange: () => {
        _invalidateReadCache();
        window.dispatchEvent(new CustomEvent("datachange"));
      },
    });
    // Coming back to the tab is when a share is most likely to have changed
    if (!_visibilityHooked) {
      _visibilityHooked = true;
      // Reads the current registry: it is null while sharing is switched off
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible")
          _registry?.refresh({ force: true }).catch(() => {});
      });
    }
  }
  return _registry;
}

/** Whether a notebook id is one shared with this user. */
function isSharedNotebook(notebookId) {
  return Boolean(notebookId && _registry?.isShared(notebookId));
}

/**
 * The record of a notebook shared with this user (permissions as granted), or
 * null for an own notebook, a quick note, or an id that is not registered.
 * Notebooks shared with the user are the owner's: see shareRestrictions.js.
 */
function sharedRecord(notebookId) {
  return notebookId ? (_registry?.get(notebookId) ?? null) : null;
}

/**
 * A write into a shared notebook that the server refuses with 403/404 may mean
 * the share ended or was moved: look again, so the registry stops resolving it
 * (an ended share's paths throw instead of falling back to the own tree).
 */
async function _checkShareAfterFailedWrite(notebookId, error) {
  // 409: the folder the write belongs in is gone
  if ([403, 404, 409].includes(error?.status)) await _lookAgainAtShare(notebookId);
}

/** Re-check the shares if `notebookId` is one shared with this user. */
async function _lookAgainAtShare(notebookId) {
  if (isSharedNotebook(notebookId)) await _registry.refresh({ force: true }).catch(() => {});
}

// ─── IndexedDB stubs (referenced by StorageWorker which is disabled in NC build) ─
// Kept in step with storage.js so the two builds cannot disagree about a schema
// neither of them opens here — the NC build has no IndexedDB at all.
export const DB_NAME = "NoteBerg";
export const DB_VERSION = 6;

// ─── Init ─────────────────────────────────────────────────────────────────────

let _initialized = false;
// Track folders confirmed to exist so we skip redundant MKCOL requests
const _knownFolders = new Set();

const _INIT_KEY = "noteberg_webdav_initialized";

/**
 * Make sure /NoteBerg is the user's own, while sharing is on: a folder shared to
 * them would otherwise become their storage. A root that cannot be verified
 * throws. A foreign root is moved aside and an own one created in its place.
 * @returns {Promise<{moved: boolean, to?: string}>}
 */
async function _guardOwnRoot() {
  if (!getSharedRegistry()) return { moved: false };
  return guardOwnRoot({ dav: createDavOps(), uid: getSessionUid(), ocs });
}

/**
 * Sharing was just switched on in Settings, mid-session: the check initStorage()
 * makes at load, now. If the root had to be moved, the folders of the own tree
 * are created again.
 * @returns {Promise<{moved: boolean, to?: string}>}
 */
export async function guardRootForSharing() {
  const result = await _guardOwnRoot();
  if (result.moved) {
    _knownFolders.clear();
    localStorage.removeItem(_INIT_KEY);
    for (const folder of getAllRequiredFolders()) {
      await davMkcol(folder);
    }
    localStorage.setItem(_INIT_KEY, "1");
    _invalidateReadCache();
  }
  return result;
}

export async function initStorage() {
  if (_initialized) return;
  // Before anything is read from or written to /NoteBerg: it must be the user's.
  // A folder shared to them before their first visit would otherwise become
  // their storage. A root that cannot be verified stops the app from loading.
  await _guardOwnRoot();
  const registry = getSharedRegistry();
  // Always verify root folder exists before trusting the localStorage flag.
  // The flag is an optimisation to skip MKCOL on every load, but if the folder
  // was deleted (uninstall, manual cleanup) we must recreate it.
  const rootExists = await davExists(ROOT_FOLDER);
  if (!rootExists) {
    localStorage.removeItem(_INIT_KEY);
  }
  if (!localStorage.getItem(_INIT_KEY)) {
    for (const folder of getAllRequiredFolders()) {
      await davMkcol(folder);
    }
    localStorage.setItem(_INIT_KEY, "1");
  } else {
    // Pre-populate cache so davMkcol skips these folders if called again this session
    for (const folder of getAllRequiredFolders()) {
      _knownFolders.add(folder);
    }
  }
  _initialized = true;
  if (registry) await registry.refresh({ force: true });
  console.log("Storage initialized (WebDAV)");
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch (_e) {
      /* fall through */
    }
  }
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );
}

// ─── Settings (localStorage for NC build) ────────────────────────────────────
//
// The native build keeps settings in IndexedDB. NC has no IndexedDB at all —
// everything goes straight to WebDAV — so settings previously lived in a plain
// in-memory object and were silently lost on every reload. That made the
// recognition backend impossible to configure here: each page load reset it to
// the sidecar default, which does not exist on NC.
//
// localStorage is the right weight for this: settings are small, per-device,
// and none of them need to sync. It is also already used in this module for the
// init flag, and by displayPrefs.js, which moved the card size here for exactly
// this reason.
//
// NOT for secrets. localStorage is readable by any script on the origin; the
// recognition API key goes through secureStorage.js and must stay there.

/** Namespaced so we cannot collide with Nextcloud's own localStorage keys. */
const _SETTING_PREFIX = "noteberg_setting_";

export async function getSetting(key) {
  try {
    const raw = localStorage.getItem(_SETTING_PREFIX + key);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (_e) {
    // Corrupt value, or storage unavailable (private mode, quota). A missing
    // setting is always a legal state — callers fall back to their default.
    return null;
  }
}

export async function setSetting(key, value) {
  try {
    // Stored as JSON so numbers and booleans survive the round trip. Reading
    // back a stringified value would turn `false` into the truthy "false" and
    // maxTokens into a string.
    localStorage.setItem(_SETTING_PREFIX + key, JSON.stringify(value ?? null));
  } catch (error) {
    // Quota or a locked-down browser. Non-fatal: the setting simply does not
    // persist, which is the behaviour this build had for its whole life.
    console.warn(`[storage.webdav] Could not persist setting "${key}":`, error);
  }
}

// ─── Recognition jobs (localStorage for NC build) ────────────────────────────
//
// Same contract as the native build's IndexedDB store, same reason for being
// local-only: a job holds partial work that must survive a reload without ever
// being mistaken for a finished recognition. Kept in one key rather than one
// key per job — the queue is short, and a single read/write keeps it atomic.

const _JOBS_KEY = "noteberg_recognition_jobs";

export async function getRecognitionJobs() {
  try {
    const raw = localStorage.getItem(_JOBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

async function _writeJobs(jobs) {
  try {
    localStorage.setItem(_JOBS_KEY, JSON.stringify(jobs));
  } catch (error) {
    // Losing the queue is survivable — it degrades to the pre-persistence
    // behaviour — so this must never break the run in progress.
    console.warn("[storage.webdav] Could not persist recognition jobs:", error);
  }
}

export async function saveRecognitionJob(job) {
  const jobs = await getRecognitionJobs();
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.push(job);
  await _writeJobs(jobs);
  return job;
}

export async function deleteRecognitionJob(id) {
  const jobs = await getRecognitionJobs();
  await _writeJobs(jobs.filter((j) => j.id !== id));
}

export async function clearRecognitionJobs() {
  await _writeJobs([]);
}

// ─── Notebook operations ──────────────────────────────────────────────────────

/** Write a notebook file. Local-only sharing fields never leave the browser. */
async function _putNotebook(notebook) {
  try {
    await davPut(getNotebookPath(notebook.id), stripLocalFields(notebook));
  } catch (error) {
    await _checkShareAfterFailedWrite(notebook.id, error);
    throw error;
  }
}

export async function createNotebook({ title, description = "", color = "#3b82f6" }) {
  const notebook = {
    id: generateId(),
    title,
    description,
    color,
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    deleted: false,
  };
  await davMkcol(getNotebookFolder(notebook.id));
  await davMkcol(getNotebookNotesFolder(notebook.id));
  await _putNotebook(notebook);
  console.log("Notebook created:", notebook.id);
  window.dispatchEvent(
    new CustomEvent("notebook-created", { detail: { notebookId: notebook.id } }),
  );
  return notebook;
}

/** The notebooks in the user's own tree. */
async function _listOwnNotebooks() {
  return (await _readOwnNotebooks()).notebooks;
}

/** The own notebooks, and whether every one of them could be read. */
async function _readOwnNotebooks() {
  const paths = await davList(`${ROOT_FOLDER}/notebooks`);
  const notebookIds = paths
    .filter((p) => !p.endsWith(".json")) // exclude _tombstones.json
    .map((p) => p.replace(/\/$/, "").split("/").pop())
    .filter(Boolean);

  const { items, complete } = await _readListing(notebookIds.map((id) => getNotebookPath(id)));
  return { notebooks: items.filter(Boolean), complete };
}

/** The notebooks shared with this user, read from the owners' folders. */
async function _listSharedNotebooks(registry) {
  const records = registry.list();
  const { items, complete } = await _readListing(
    records.map((record) => `${record.remoteBasePath}/_notebook.json`),
  );
  const notebooks = items
    .map((file, i) => _genuineSharedNotebook(file, records[i].id))
    .filter(Boolean)
    .map((file) => registry.annotate(file));
  return { notebooks, complete };
}

/**
 * A notebook file read from a share, or null unless it describes the notebook it
 * is registered as. Another user wrote it: one claiming a different id would be
 * listed without its sharing fields, i.e. as if it were the user's own.
 */
function _genuineSharedNotebook(file, notebookId) {
  if (!file) return null;
  if (file.id === notebookId) return file;
  console.warn(`[WebDAV] Ignoring shared notebook file claiming id ${JSON.stringify(file.id)}`);
  return null;
}

/**
 * Whether a note file is the note it is stored as. Always true in the user's own
 * tree; in a notebook shared with them another user wrote it, and one claiming a
 * different id or notebook would stand in for one of the user's own notes (reads
 * and saves of that note would go to the share).
 */
function _isGenuineNote(note, noteId, notebookId) {
  if (!isSharedNotebook(notebookId)) return true;
  if (isSafeId(note?.id) && note.id === noteId && (note.notebookId ?? null) === notebookId) {
    return true;
  }
  console.warn(`[WebDAV] Ignoring shared note file ${noteId}.json: id or notebook mismatch`);
  return false;
}

async function _getAllNotebooksRaw() {
  const registry = getSharedRegistry();
  // At most once a minute; a failure just leaves the registrations as they were
  if (registry) await registry.refresh().catch(() => {});

  const cached = _cacheGet("notebooks");
  if (cached) return cached;

  const own = await _readOwnNotebooks();
  const shared = registry
    ? await _listSharedNotebooks(registry)
    : { notebooks: [], complete: true };
  const notebooks = [...own.notebooks, ...shared.notebooks];
  // A list missing a notebook that could not be read is not kept
  return own.complete && shared.complete ? _cacheSet("notebooks", notebooks) : notebooks;
}

export async function getAllNotebooks() {
  const notebooks = await _getAllNotebooksRaw();
  return notebooks.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

export async function getNotebook(id) {
  const notebook = await davGet(getNotebookPath(id));
  if (!notebook || !isSharedNotebook(id)) return notebook;
  // A shared notebook carries this user's sharing fields (in memory only)
  const genuine = _genuineSharedNotebook(notebook, id);
  return genuine && _registry.annotate(genuine);
}

export async function updateNotebook(id, updates) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  assertEditable(sharedRecord(id), "updateNotebook");
  const updated = {
    ...notebook,
    ...updates,
    modified: Date.now(),
    version: (notebook.version || 0) + 1,
  };
  await _putNotebook(updated);
  console.log("Notebook updated:", id);
  return updated;
}

export async function deleteNotebook(id) {
  // Soft delete only — no tombstone. To native clients a tombstone means
  // "permanently purged, hard-delete your local copy"; the deleted flags in the
  // JSON are what propagate a recycle-bin delete. Tombstones are written by
  // permanentlyDeleteNotebook().
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  assertManageable(sharedRecord(id), "deleteNotebook");
  const updated = {
    ...notebook,
    deleted: true,
    modified: Date.now(),
    version: (notebook.version || 0) + 1,
  };
  await _putNotebook(updated);

  // Soft-delete all notes in this notebook
  const notes = await getNotesByNotebook(id);
  for (const note of notes) {
    await deleteNote(note.id);
  }
  console.log("Notebook deleted:", id);
  return updated;
}

export async function getDeletedNotebooks() {
  // Recipients have no trash for notebooks that are not theirs
  const notebooks = await _getAllNotebooksRaw();
  return notebooks.filter((n) => n.deleted && n.origin !== "shared");
}

export async function restoreNotebook(id) {
  const notebook = await getNotebook(id);
  if (!notebook) throw new Error("Notebook not found");
  assertManageable(sharedRecord(id), "restoreNotebook");
  const updated = {
    ...notebook,
    deleted: false,
    modified: Date.now(),
    version: (notebook.version || 0) + 1,
  };
  await _putNotebook(updated);
  return updated;
}

export async function permanentlyDeleteNotebook(id) {
  assertManageable(sharedRecord(id), "purgeNotebook");
  // Write global notebook tombstone before deleting the folder
  await _updateTombstone(getGlobalNotebookTombstonePath(), (t) => addNotebookTombstone(t, id));
  await davDelete(getNotebookFolder(id));
}

// ─── Note operations ──────────────────────────────────────────────────────────

export async function createNote({ title, notebookId = null }) {
  assertEditable(sharedRecord(notebookId), "createNote");
  const note = {
    id: generateId(),
    notebookId,
    title,
    content: "",
    strokes: [],
    media: [],
    deletedMedia: [],
    formatVersion: 1,
    background: "none",
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    deleted: false,
    tags: [],
    tasks: [],
    penPresets: null,
    pdfSource: null,
    recognition: null,
    deletedStrokes: [],
    recordings: [],
    deletedRecordings: [],
  };
  await _putNote(note);
  console.log("Note created:", note.id);
  window.dispatchEvent(new CustomEvent("note-created", { detail: { noteId: note.id } }));
  return note;
}

/**
 * Write a note file. With `ifMatch` the PUT is conditional, so a concurrent
 * writer surfaces as a 412 instead of being silently overwritten.
 * @returns {Promise<string|null>} the new etag, when the server sent one
 */
async function _putNote(note, ifMatch = null) {
  const path = getNotePath(note.id, note.notebookId);
  // Ensure notes folder exists (for quick notes or new notebooks)
  if (note.notebookId) {
    await davMkcol(getNotebookNotesFolder(note.notebookId));
  } else {
    await davMkcol(`${ROOT_FOLDER}/quickNotes`);
  }
  try {
    return await davPut(path, note, ifMatch ? { "If-Match": `"${ifMatch}"` } : {});
  } catch (error) {
    await _checkShareAfterFailedWrite(note.notebookId, error);
    throw error;
  }
}

function _normalizeNote(note) {
  // Guard against encrypted blobs ({data, iv, version}) that may have been uploaded
  // by a native client with local encryption. Normalize all array fields to their defaults
  // so the rest of the app can safely iterate/spread them.
  const arr = (v) => (Array.isArray(v) ? v : []);
  note.strokes = arr(note.strokes);
  note.deletedStrokes = arr(note.deletedStrokes);
  note.media = arr(note.media);
  note.deletedMedia = arr(note.deletedMedia);
  note.tasks = arr(note.tasks);
  note.deletedTasks = arr(note.deletedTasks);
  note.recordings = arr(note.recordings);
  note.deletedRecordings = arr(note.deletedRecordings);
  delete note.thumbnail;
  return note;
}

/** Locate a note (cached notebook hint first, then a scan) and return its file entry. */
async function _readNoteEntry(id) {
  const cached = _notePathCache.get(id);
  let entry = null;
  if (cached !== undefined) {
    entry = await davGetEntry(getNotePath(id, cached));
    if (entry && !_isGenuineNote(entry.data, id, cached)) entry = null;
  }
  if (!entry) entry = await _findNoteEntry(id);
  if (!entry) return null;
  _normalizeNote(entry.data);
  await _cacheFileLocations(entry.data);
  return entry;
}

/**
 * @param {string} id
 * @param {{track?: boolean}} [options] - the editor is loading this note: from now on
 *   saves are measured against what it was just given. Every other reader (recognition,
 *   search, live updates) must not move that mark, or a save would believe nobody else
 *   had written since and overwrite their changes instead of merging.
 */
export async function getNote(id, { track = false } = {}) {
  const entry = await _readNoteEntry(id);
  if (!entry) return null;
  if (track) _trackLoadedNote(id, entry);
  else if (!_noteSync.has(id))
    _trackNote(id, { etag: entry.etag, base: entry.data.content ?? "", needsMerge: false });
  return entry.data;
}

async function _cacheFileLocations(note) {
  const notebookId = note.notebookId ?? null;
  const fileIds = [
    ...(note.media || []).map((m) => m.fileId),
    note.pdfSource,
    ...(note.recordings || []).map((r) => r.fileId),
  ].filter(Boolean);

  if (fileIds.length === 0) return;

  // Check if all fileIds already have ext resolved — skip folder listing if so
  const needsResolution = fileIds.some((fid) => !_fileLocationCache.get(fid)?.ext);
  if (!needsResolution) return;

  // List the media folder once to resolve all extensions in one request
  const mediaFolder = getNoteMediaFolder(note.id, notebookId);
  const files = await davList(mediaFolder).catch(() => []);

  for (const fileId of fileIds) {
    if (_fileLocationCache.get(fileId)?.ext) continue; // already resolved

    const match = files.find((p) => {
      const name = p.replace(/\/$/, "").split("/").pop();
      return name === fileId || name.startsWith(`${fileId}.`);
    });

    if (match) {
      const name = match.replace(/\/$/, "").split("/").pop();
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      _fileLocationCache.set(fileId, { noteId: note.id, notebookId, ext });
    } else {
      // File not on server yet (e.g. just created, not yet uploaded)
      _fileLocationCache.set(fileId, { noteId: note.id, notebookId, ext: null });
    }
  }
}

export async function getNoteIndex(id) {
  return getNote(id);
}

export async function getNoteContent(id) {
  return getNote(id);
}

export async function getRawNote(id) {
  return getNote(id);
}

// Cache: noteId → notebookId (null for quick notes)
const _notePathCache = new Map();

async function _findNoteEntry(id) {
  // Try quick notes
  const qn = await davGetEntry(getNotePath(id, null));
  if (qn) {
    _notePathCache.set(id, null);
    return qn;
  }
  // Try all notebooks
  const notebooks = await getAllNotebooks();
  for (const nb of notebooks) {
    const entry = await davGetEntry(getNotePath(id, nb.id));
    if (entry && _isGenuineNote(entry.data, id, nb.id)) {
      _notePathCache.set(id, nb.id);
      return entry;
    }
  }
  return null;
}

export async function getAllNotes() {
  const [quickNotes, ...notebookNotes] = await Promise.all([
    _getNotesInFolder(`${ROOT_FOLDER}/quickNotes`, null),
    ...(await getAllNotebooks()).map((nb) =>
      _getNotesInFolder(getNotebookNotesFolder(nb.id), nb.id),
    ),
  ]);
  return [...quickNotes, ...notebookNotes.flat()]
    .filter((n) => !n.deleted)
    .sort((a, b) => b.modified - a.modified);
}

async function _getAllNotesIncludingDeleted() {
  const [quickNotes, ...notebookNotes] = await Promise.all([
    _getNotesInFolder(`${ROOT_FOLDER}/quickNotes`, null),
    ...(await getAllNotebooks()).map((nb) =>
      _getNotesInFolder(getNotebookNotesFolder(nb.id), nb.id),
    ),
  ]);
  return [...quickNotes, ...notebookNotes.flat()].sort((a, b) => b.modified - a.modified);
}

async function _getNotesInFolder(folder, notebookId) {
  let notes = _cacheGet(`notes:${folder}`);
  if (!notes) {
    const paths = await davList(folder);
    const noteFiles = paths.filter((p) => p.endsWith(".json") && !p.includes("_tombstones"));
    const { items, complete } = await _readListing(noteFiles);
    const read = items
      .filter((note, i) => {
        const fileId = noteFiles[i].slice(noteFiles[i].lastIndexOf("/") + 1, -".json".length);
        return note && _isGenuineNote(note, fileId, notebookId);
      })
      .map((n) => {
        delete n.thumbnail;
        return n;
      });
    // A listing missing a note that could not be read is not kept: the next
    // look reads the folder again instead of hiding the note until it expires
    notes = complete ? _cacheSet(`notes:${folder}`, read) : read;
  }
  for (const n of notes) {
    _notePathCache.set(n.id, notebookId);
  }
  return notes;
}

export async function getNotesByNotebook(notebookId) {
  const folder = notebookId ? getNotebookNotesFolder(notebookId) : `${ROOT_FOLDER}/quickNotes`;
  const notes = await _getNotesInFolder(folder, notebookId);
  return notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

export async function getQuickNotes() {
  const notes = await _getNotesInFolder(`${ROOT_FOLDER}/quickNotes`, null);
  return notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

// Per-note write queue — prevents concurrent PUTs to the same file (WebDAV 423 Locked)
const _writeQueues = new Map(); // noteId → Promise

function _enqueueWrite(id, fn) {
  const prev = _writeQueues.get(id) ?? Promise.resolve();
  // Always run fn after the previous write settles (success or failure)
  const next = prev.then(() => fn());
  // The queue stores a settled-tracking promise with the rejection swallowed —
  // only the caller (via the returned `next`) handles the real error. Storing
  // `next` directly would surface an unhandled rejection from the cleanup chain.
  const settled = next.catch(() => {});
  _writeQueues.set(id, settled);
  settled.then(() => {
    if (_writeQueues.get(id) === settled) _writeQueues.delete(id);
  });
  return next;
}

// ─── Concurrent writers ───────────────────────────────────────────────────────
// A note is one JSON file and every save is read-modify-write, so two people
// (or two tabs) editing the same note would silently replace each other's
// strokes and text. Each save therefore remembers what this client last saw of
// the file; if the server's copy moved on, the save is merged with it instead of
// replacing it (noteMerge.js), and the PUT carries If-Match so a write that
// races the merge is retried rather than lost. With a single writer nothing
// differs from a plain overlay.
//
// Per-note, in memory only — the NC build persists nothing locally:
//   etag       the file's etag as of our last read or write
//   base       the text this client's editor last sent: the common ancestor of
//              the next three-way text merge. It follows the editor's own
//              lineage, not the merged file: the editor keeps showing its text
//              until reloaded, so measuring its next save against the merged
//              text would read the other side's additions as deletions.
//   needsMerge set once a merge happened, until the editor has re-read the note:
//              the editor's strokes do not yet include the other side's, so a
//              plain overlay would drop them.

const MAX_TRACKED_NOTES = 20;
const _noteSync = new Map(); // noteId -> { etag, base, needsMerge }
const MAX_WRITE_ATTEMPTS = 3;

function _trackNote(id, patch) {
  const next = { ..._noteSync.get(id), ...patch };
  // Re-insert so the Map's iteration order is least- to most-recently used
  _noteSync.delete(id);
  _noteSync.set(id, next);
  if (_noteSync.size > MAX_TRACKED_NOTES) _noteSync.delete(_noteSync.keys().next().value);
}

/** The editor loaded this note: everything it holds is exactly what the server had. */
function _trackLoadedNote(id, entry) {
  _trackNote(id, { etag: entry.etag, base: entry.data.content ?? "", needsMerge: false });
}

/** The request headers every WebDAV call of this app carries. */
function _davHeaders() {
  return { "OCS-APIREQUEST": "true", requesttoken: window.OC?.requestToken || "" };
}

/**
 * Read-merge-write a note and announce the change.
 *
 * The single place that defines note-update semantics — how `modified` is
 * stamped, how `version` is bumped, and the shape of the `datachange` payload.
 * Both writers below go through here so the two can never drift apart.
 *
 * The GET, the merge with what the server holds and the PUT run in the
 * note-file worker (noteFileOps.writeNote, review P4, 4.7): a note file is
 * several MB once it holds thousands of strokes, and parsing, merging and
 * serializing it here stalled writing at every save. This side keeps the
 * bookkeeping: where the note lives, what was last read or written (_noteSync),
 * the caches and the announcement.
 *
 * Caller must already hold the per-note write queue (see _enqueueWrite): this
 * does a read-modify-write and would race with itself otherwise.
 *
 * @param {string} id - Note id
 * @param {Object} updates - Fields to merge into the note; `strokesPartial`
 *   marks `strokes` as only the strokes the server has not confirmed
 * @param {boolean} [relocated] - the note was looked for again after it moved
 * @returns {Promise<Object>} the written note, without its strokes (they stay in
 *   the worker: nobody who saves needs them back)
 */
async function _applyNoteUpdate(id, updates, relocated = false) {
  let notebookId = _notePathCache.get(id);
  if (notebookId === undefined) {
    // Where the note lives is not known yet: find it (one read here, once)
    const entry = await _readNoteEntry(id);
    if (!entry) {
      await _lookAgainAtShare(_notePathCache.get(id));
      throw new Error("Note not found");
    }
    notebookId = _notePathCache.get(id) ?? entry.data.notebookId ?? null;
  }
  assertEditable(sharedRecord(notebookId), "updateNote");
  const path = getNotePath(id, notebookId);
  const folder = notebookId ? getNotebookNotesFolder(notebookId) : `${ROOT_FOLDER}/quickNotes`;
  const createFolder = !_knownFolders.has(folder);
  const known = _noteSync.get(id);

  _invalidateReadCache(path);
  let result;
  try {
    result = await perfAsync("note write (worker)", () =>
      runNoteFileOp("writeNote", {
        url: davUrl(path),
        folderUrl: createFolder ? davUrl(folder) : null,
        headers: _davHeaders(),
        id,
        notebookId,
        shared: isSharedNotebook(notebookId),
        updates,
        known: known ? { etag: known.etag, base: known.base, needsMerge: known.needsMerge } : null,
        uid: getSessionUid(),
        maxAttempts: MAX_WRITE_ATTEMPTS,
      }),
    );
  } finally {
    // Again once the write is over: a listing read while it was in flight holds
    // the file as it was, and must not be served afterwards (see davPut)
    _invalidateReadCache(path);
  }

  if (result.status === "notFound" || result.status === "notGenuine") {
    // Moved meanwhile (or no longer the file it was): look for it once more
    _notePathCache.delete(id);
    if (!relocated && (await _readNoteEntry(id))) return _applyNoteUpdate(id, updates, true);
    // A note of a shared notebook that cannot be found any more may mean the share ended
    await _lookAgainAtShare(notebookId);
    throw new Error("Note not found");
  }
  if (result.status === "unreadable") throw new Error(`Note ${id} could not be read`);
  if (result.status !== "ok") {
    const error = new Error(`DAV ${result.op ?? "GET"} ${path} failed: ${result.httpStatus}`);
    error.status = result.httpStatus;
    if (result.op === "PUT" || result.op === "MKCOL") {
      await _checkShareAfterFailedWrite(notebookId, error);
    }
    throw error;
  }

  if (createFolder) _knownFolders.add(folder);
  await _cacheFileLocations(result.files);
  _trackNote(id, {
    etag: result.etag,
    // The editor's own text is the next ancestor; without one, what we wrote
    base:
      typeof updates.content === "string" ? updates.content : (known?.base ?? result.note.content),
    needsMerge: result.merging,
  });
  window.dispatchEvent(
    new CustomEvent("datachange", {
      // A merge brought in changes the open editor has not seen: not "local",
      // or the editor would ignore the event instead of adopting them.
      detail: { noteId: id, source: result.someoneElseWrote ? "merge" : "local" },
    }),
  );
  return result.note;
}

export function updateNote(id, updates) {
  return _enqueueWrite(id, async () => {
    const updated = await _applyNoteUpdate(id, updates);
    console.log("Note updated:", id);
    return updated;
  });
}

// ─── Coalescing writer (high-frequency fields) ────────────────────────────────
// A note is stored as one JSON file, so a PUT always writes the whole note.
// While drawing, updateNote() is called once per stroke; each call costs a
// network GET + PUT. When strokes arrive faster than a round-trip completes,
// _enqueueWrite's strictly-serial chain grows without bound and every queued
// job later fires its own main-thread parse/serialize burst — which is what
// makes preview strokes stutter and tear the longer a session runs.
//
// The insight: once a newer snapshot of the same fields exists, any older
// pending snapshot is redundant, because the PUT is whole-file anyway. So a
// write that has NOT started yet is replaced rather than queued behind. That
// bounds the pipeline at one in-flight request plus one pending snapshot, no
// matter how fast the user draws.
//
// This is not a debounce: there is no timer and no idle guess. A save starts
// the instant the connection is free; only already-obsolete snapshots collapse.

const _pendingCoalesced = new Map(); // noteId → { updates, promise, resolve, reject }

/**
 * Queue a whole-note update, collapsing snapshots that are superseded before
 * they start. Callers that must not lose an update (title, media, tasks…)
 * should use updateNote() — only fields that are re-sent in full on every call
 * are safe here.
 *
 * @param {string} id - Note id
 * @param {Object} updates - Fields to merge into the note
 * @returns {Promise<void>} Resolves when this snapshot (or a newer one that
 *   superseded it) has been written.
 */
export function updateNoteCoalesced(id, updates) {
  const pending = _pendingCoalesced.get(id);

  // A snapshot is already waiting for the in-flight write to finish. Overwrite
  // its payload — it has not been sent, so nothing is lost — and hand back the
  // same promise so earlier callers still settle when the newer write lands.
  if (pending) {
    pending.updates = { ...pending.updates, ...updates };
    return pending.promise;
  }

  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry = { updates: { ...updates }, promise, resolve, reject };
  _pendingCoalesced.set(id, entry);

  // Chain onto the shared per-note queue so coalesced writes still serialize
  // against ordinary updateNote()/deleteNote() calls for the same file.
  _enqueueWrite(id, async () => {
    // Claim the snapshot as it exists now; further calls start a new entry.
    _pendingCoalesced.delete(id);
    await _applyNoteUpdate(id, entry.updates);
  }).then(entry.resolve, entry.reject);

  return promise;
}

/**
 * Await any coalesced write still pending for `id`, so callers that must not
 * lose the last snapshot (note close, navigation) can flush deterministically.
 */
export function flushNoteWrites(id) {
  return _pendingCoalesced.get(id)?.promise ?? _writeQueues.get(id) ?? Promise.resolve();
}

// ─── Live updates of the open note ────────────────────────────────────────────
// The editor looks now and then whether someone else saved the note it shows
// (NoteCanvas/liveRefresh.js). Three steps, so that the look itself is one
// small request and the tracking above stays true:
//   1. remoteNoteChange(): one PROPFIND of the note file, compared with the etag
//      tracked for it. Nothing is downloaded.
//   2. readNoteForLiveUpdate(): only when it changed, the note itself.
//   3. adoptRemoteNote(): the editor took that version in, so it is what this
//      client's next save builds on. Called in the same synchronous step that
//      takes it in, after noteSyncUnchanged() said no save of ours came between:
//      a save measured against the old etag would merge needlessly, and one that
//      overlays a version the editor has not taken in would drop its strokes.

/** A save of this note is queued or under way. */
function _isWritePending(id) {
  return _writeQueues.has(id) || _pendingCoalesced.has(id);
}

/**
 * Whether the server's copy of a note moved on since this client last read or
 * wrote it.
 * @returns {Promise<string|null>} the tracked etag it was measured against when
 *   the file changed; null when it did not, when that cannot be told, or while a
 *   save of ours is under way (that save merges with whatever it finds)
 */
export async function remoteNoteChange(id) {
  // Why a look found nothing, at debug level (the console's "Verbose" filter):
  // a look runs every few seconds while a note is open
  const nothing = (reason) => {
    console.debug(`[WebDAV] Live check of ${id}: ${reason}`);
    return null;
  };
  const known = _noteSync.get(id)?.etag;
  const notebookId = _notePathCache.get(id);
  if (!known) return nothing("no etag tracked for the note");
  if (notebookId === undefined) return nothing("the note's location is not known");
  if (_isWritePending(id)) return nothing("a save of ours is under way");
  let path;
  try {
    path = getNotePath(id, notebookId);
  } catch {
    return nothing("its share has ended");
  }
  const res = await fetch(davUrl(path), {
    method: "PROPFIND",
    headers: {
      Depth: "0",
      "Content-Type": "application/xml",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
      "Cache-Control": "no-cache",
    },
    credentials: "same-origin",
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`,
  });
  if (!res.ok && res.status !== 207) return nothing(`PROPFIND answered ${res.status}`);
  const xml = await res.text();
  const raw = xml.match(/<(?:[\w-]+:)?getetag[^>]*>([^<]*)</i)?.[1];
  const etag = bareEtag(raw?.replace(/&quot;/g, '"').trim());
  if (!etag) return nothing("PROPFIND sent no etag");
  if (etag === known) return nothing(`unchanged (${etag})`);
  if (_isWritePending(id)) return nothing("a save of ours started meanwhile");
  console.debug(`[WebDAV] Live check of ${id}: changed (${known} -> ${etag})`);
  return known;
}

/** True while nothing of ours was saved or queued since `etag` was tracked for the note. */
export function noteSyncUnchanged(id, etag) {
  return _noteSync.get(id)?.etag === etag && !_isWritePending(id);
}

/**
 * The note as the server holds it now, with its etag, for the editor to take in.
 * Moves no tracking: see adoptRemoteNote().
 * @returns {Promise<{note: object, etag: string|null}|null>}
 */
export async function readNoteForLiveUpdate(id) {
  const entry = await _readNoteEntry(id);
  return entry ? { note: entry.data, etag: entry.etag } : null;
}

/**
 * The open note as the server holds it, taken in against what the editor holds
 * (`view`, liveTakeIn.js) in the note-file worker: the note is read, parsed and
 * merged there, and only the delta comes back (review P4, 4.7). With `text`
 * ({baseline, editorText}), the editor's text is merged with the server's too.
 * Moves no tracking: see adoptRemoteNote().
 * @returns {Promise<{delta: object, etag: string|null, text: object|null}|null>}
 */
export async function takeInStoredNote(id, view, text = null) {
  const request = _noteFileRequest(id);
  if (!request) return null;
  const result = await perfAsync("live take-in (worker)", () =>
    runNoteFileOp("takeInNote", { ...request, view, text }),
  );
  if (result?.status !== "ok") return null;
  await _cacheFileLocations(result.files);
  return { delta: result.delta, etag: result.etag, text: result.text };
}

/**
 * The note's stored text, read after every write of ours issued so far, without
 * parsing the whole note on the main thread (LiveText's read).
 * @returns {Promise<{content: string, author?: string}|null>}
 */
export async function readStoredNoteText(id) {
  await flushNoteWrites(id).catch(() => {});
  const request = _noteFileRequest(id);
  if (!request) return null;
  const result = await runNoteFileOp("readNoteText", request);
  return result?.status === "ok" ? { content: result.content, author: result.author } : null;
}

/** What a note-file operation needs to read the note; null when its place is not known. */
function _noteFileRequest(id) {
  const notebookId = _notePathCache.get(id);
  if (notebookId === undefined) return null;
  let path;
  try {
    path = getNotePath(id, notebookId);
  } catch {
    return null; // its share has ended
  }
  return {
    url: davUrl(path),
    headers: _davHeaders(),
    id,
    notebookId,
    shared: isSharedNotebook(notebookId),
  };
}

/**
 * The open editor has taken in the version read with `etag`: this client's
 * next save replaces that version rather than merging with it.
 * @param {string} id
 * @param {{etag: string|null, base: string}} seen - `base` is the text editor and
 *   storage now agree on (in the editor's form), the ancestor of a later merge
 */
export function adoptRemoteNote(id, { etag, base }) {
  _trackNote(id, { etag, base, needsMerge: false });
}

export function saveNote(note) {
  return _enqueueWrite(note.id, async () => {
    assertEditable(sharedRecord(note.notebookId), "saveNote");
    await _putNote(note);
    window.dispatchEvent(
      new CustomEvent("datachange", { detail: { noteId: note.id, source: "local" } }),
    );
  });
}

export function deleteNote(id) {
  // Soft delete only — no tombstone. To native clients a tombstone means
  // "permanently purged, hard-delete your local copy"; the deleted flag in the
  // JSON is what propagates a recycle-bin delete. Tombstones are written by
  // permanentlyDeleteNote().
  return _enqueueWrite(id, async () => {
    const note = await getNote(id);
    if (!note) throw new Error("Note not found");
    assertManageable(sharedRecord(note.notebookId), "deleteNote");
    const updated = {
      ...note,
      deleted: true,
      modified: Date.now(),
      version: (note.version || 0) + 1,
    };
    await _putNote(updated);
    console.log("Note deleted:", id);
    return updated;
  });
}

export function permanentlyDeleteNote(id) {
  return _enqueueWrite(id, async () => {
    const note = await getNote(id);
    if (!note) return;
    assertManageable(sharedRecord(note.notebookId), "purgeNote");

    // Write tombstone for the note and its media files before deleting them
    const tombstonePath = note.notebookId
      ? getNotebookTombstonePath(note.notebookId)
      : getQuickNotesTombstonePath();
    await _updateTombstone(tombstonePath, (tombstone) => {
      addNoteTombstone(tombstone, id);
      for (const item of note.media || []) {
        if (item.fileId) addMediaTombstone(tombstone, id, item.fileId);
      }
    });

    const path = getNotePath(id, note.notebookId);
    await davDelete(path);
    await davDelete(getNoteMediaFolder(id, note.notebookId));
    _notePathCache.delete(id);
    _noteSync.delete(id);
    // A copy of this note holds the same file ids in its own folder: locations
    // still pointing here would send it (getFileUrl) to files that are gone
    for (const [fid, loc] of _fileLocationCache) {
      if (loc.noteId === id) _fileLocationCache.delete(fid);
    }
  });
}

export async function getDeletedNotes() {
  const all = await _getAllNotesIncludingDeleted();
  return all.filter((n) => n.deleted && !isSharedNotebook(n.notebookId));
}

export function restoreNote(id) {
  return _enqueueWrite(id, async () => {
    const note = await getNote(id);
    if (!note) throw new Error("Note not found");
    assertManageable(sharedRecord(note.notebookId), "restoreNote");
    const updated = {
      ...note,
      deleted: false,
      modified: Date.now(),
      version: (note.version || 0) + 1,
    };
    await _putNote(updated);
    return updated;
  });
}

export function moveNote(noteId, targetNotebookId) {
  return _enqueueWrite(noteId, async () => {
    const note = await getNote(noteId);
    if (!note) throw new Error("Note not found");
    const previousNotebookId = note.notebookId ?? null;
    const target = targetNotebookId ?? null;
    if (previousNotebookId === target) return;
    // Out of a shared notebook or into one: neither is the recipient's to do
    assertManageable(sharedRecord(previousNotebookId), "moveNote");
    assertManageable(sharedRecord(target), "moveNote");

    // 1. Write the note at the new location first — never delete the only copy.
    const updated = {
      ...note,
      notebookId: target,
      modified: Date.now(),
      version: (note.version || 0) + 1,
    };
    await _putNote(updated);
    _notePathCache.set(noteId, target);

    // 2. Move the media folder server-side (atomic, recursive; 404 = note has no media).
    try {
      await davMove(
        getNoteMediaFolder(noteId, previousNotebookId),
        getNoteMediaFolder(noteId, target),
      );
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    // Keep cached file locations valid so getFileUrl keeps working this session
    for (const [fid, loc] of _fileLocationCache) {
      if (loc.noteId === noteId) _fileLocationCache.set(fid, { ...loc, notebookId: target });
    }

    // 3. Remove the old JSON and tombstone the old location so native clients
    //    don't "self-heal" the note back into the old notebook.
    await davDelete(getNotePath(noteId, previousNotebookId));
    const oldTombstonePath = previousNotebookId
      ? getNotebookTombstonePath(previousNotebookId)
      : getQuickNotesTombstonePath();
    await _updateTombstone(oldTombstonePath, (t) => addNoteTombstone(t, noteId));

    console.log(`Note moved: ${noteId} → ${targetNotebookId}`);
  });
}

export async function copyNote(noteId, targetNotebookId) {
  const note = await getNote(noteId);
  if (!note) throw new Error("Note not found");
  assertManageable(sharedRecord(note.notebookId), "copyNote");
  assertManageable(sharedRecord(targetNotebookId), "copyNote");
  const now = Date.now();
  const newNote = {
    ...note,
    id: generateId(),
    notebookId: targetNotebookId ?? null,
    deletedMedia: [],
    version: 1,
    created: now,
    modified: now,
  };

  // Copy media files server-side into the copy's own folder. Media is stored
  // per-note, so sharing fileIds with the original would orphan the copy's
  // media as soon as the original note is permanently deleted.
  const srcFiles = await davList(getNoteMediaFolder(noteId, note.notebookId ?? null)).catch(
    () => [],
  );
  if (srcFiles.length > 0) {
    const destFolder = getNoteMediaFolder(newNote.id, newNote.notebookId);
    await davMkcol(destFolder);
    for (const srcPath of srcFiles) {
      const name = srcPath.replace(/\/$/, "").split("/").pop();
      await davCopy(srcPath, `${destFolder}/${name}`);
    }
  }

  // Write the JSON only after the media copy succeeded, so a half-copied note
  // never becomes visible.
  await _putNote(newNote);
  _notePathCache.set(newNote.id, newNote.notebookId);
  console.log(`Note copied: ${noteId} → ${newNote.id}`);
  return newNote;
}

export function clearNoteMoveFlag(id) {
  return _enqueueWrite(id, async () => {
    const note = await getNote(id);
    if (!note) return;
    delete note.previousNotebookId;
    await _putNote(note);
  });
}

export async function purgeNote(id) {
  return permanentlyDeleteNote(id);
}

export async function permanentlyDeleteNotesInNotebook(notebookId) {
  const notes = await getNotesByNotebook(notebookId);
  for (const note of notes) await permanentlyDeleteNote(note.id);
}

// ─── Media / files ────────────────────────────────────────────────────────────

// Detect MIME type from magic bytes when the blob has no useful type
async function _sniffMime(blob) {
  const buf = await blob.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  // WebM magic: 0x1A 0x45 0xDF 0xA3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  // WAV: "RIFF" .... "WAVE" — bytes 0-3 and 8-11.
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x41 &&
    b[10] === 0x56 &&
    b[11] === 0x45
  ) {
    return "audio/wav";
  }
  // MP4/M4A: "ftyp" at bytes 4-7 (the box type of the first box).
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "audio/mp4";
  return null;
}

async function _ensureMimeType(blob, ext) {
  const usefulType = blob.type && blob.type !== "application/octet-stream";
  if (usefulType) return blob;
  // Try extension first (mirrors sync's approach), then magic bytes as fallback
  if (ext) {
    const mime = mimeFromExt(ext);
    if (mime !== "application/octet-stream") return new Blob([blob], { type: mime });
  }
  const sniffed = await _sniffMime(blob);
  if (sniffed) return new Blob([blob], { type: sniffed });
  return blob;
}

// fileId → blob (in-memory cache for freshly uploaded files)
const _fileCache = new Map();
// fileId → { noteId, notebookId, ext } (persists for lifetime of page so getFile can fetch WebDAV)
const _fileLocationCache = new Map();

export async function saveFile(blob, id = null) {
  // Files are stored per-note — caller passes noteId and notebookId via context.
  // For compatibility we store blobs in a flat virtual "files" namespace keyed by id.
  // Actual placement happens in saveMediaForNote().
  const fileId = id || generateId();
  _fileCache.set(fileId, blob);
  return fileId;
}

export async function saveMediaForNote(blob, fileId, noteId, notebookId) {
  const ext = extFromMime(blob.type);
  const filename = `${fileId}${ext}`;
  const folder = getNoteMediaFolder(noteId, notebookId);
  try {
    await davMkcol(folder);
    await davPutBinary(getMediaPath(noteId, notebookId, filename), blob);
  } catch (error) {
    await _checkShareAfterFailedWrite(notebookId, error);
    throw error;
  }
  // Record location so getFile() can fetch from WebDAV after a page reload
  _fileLocationCache.set(fileId, { noteId, notebookId, ext });
  _fileCache.set(fileId, blob);
}

/**
 * Delete media binaries on the server that are no longer referenced by the note.
 * Mirrors the native sync layer's cleanupOrphanedMedia — without it, deleting an
 * image/PDF/recording in the NC app leaves its binary in the folder forever.
 * @param {string[]} validFileIds - fileIds the note still references (media + pdfSource + recordings)
 */
export async function cleanupNoteMedia(noteId, notebookId, validFileIds) {
  // Needs DELETE, which a share never grants: the owner's client cleans up
  if (isSharedNotebook(notebookId)) return;
  const folder = getNoteMediaFolder(noteId, notebookId);
  const files = await davList(folder).catch(() => []); // folder may not exist yet
  const valid = new Set(validFileIds);

  for (const path of files) {
    const name = path.replace(/\/$/, "").split("/").pop();
    const dotIdx = name.lastIndexOf(".");
    const fileId = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    if (valid.has(fileId)) continue;
    await davDelete(getMediaPath(noteId, notebookId, name)).catch((e) =>
      console.warn(`[WebDAV] Failed to delete orphaned media ${name}:`, e),
    );
    _fileCache.delete(fileId);
    _fileLocationCache.delete(fileId);
  }
}

export async function getFile(id) {
  // Return from in-memory cache if available (freshly uploaded or already fetched)
  if (_fileCache.has(id)) return _fileCache.get(id);

  // Try to fetch from WebDAV using the recorded location (known ext)
  const loc = _fileLocationCache.get(id);
  if (loc?.ext) {
    const filename = `${id}${loc.ext}`;
    const raw = await davGetBinary(getMediaPath(loc.noteId, loc.notebookId, filename)).catch(
      () => null,
    );
    if (raw) {
      const blob = await _ensureMimeType(raw, loc.ext);
      _fileCache.set(id, blob);
      return blob;
    }
  }

  // Location not known in this session — scan the note's media folder to find the file by prefix.
  // This happens after a page reload. First try to find the note via _notePathCache / scan.
  const allNotes = await getAllNotes();
  for (const note of allNotes) {
    const notebookId = note.notebookId ?? null;
    const fileIds = [
      ...(note.media || []).map((m) => m.fileId),
      note.pdfSource,
      ...(note.recordings || []).map((r) => r.fileId),
    ].filter(Boolean);

    if (!fileIds.includes(id)) continue;

    // List the media folder to find the actual filename (with extension)
    const mediaFolder = getNoteMediaFolder(note.id, notebookId);
    const files = await davList(mediaFolder).catch(() => []);
    const match = files.find((p) => {
      const name = p.replace(/\/$/, "").split("/").pop();
      return name === id || name.startsWith(`${id}.`);
    });

    if (match) {
      const raw = await davGetBinary(match).catch(() => null);
      if (raw) {
        const name = match.replace(/\/$/, "").split("/").pop();
        const dotIdx = name.lastIndexOf(".");
        const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
        // Ensure blob has correct MIME type (Nextcloud serves extensionless files as octet-stream)
        const blob = await _ensureMimeType(raw, ext);
        _fileLocationCache.set(id, { noteId: note.id, notebookId, ext });
        _fileCache.set(id, blob);
        return blob;
      }
    }
  }

  return null;
}

export async function checkFileExists(id) {
  if (_fileCache.has(id)) return true;
  const loc = _fileLocationCache.get(id);
  return loc?.ext != null; // only true if ext was resolved (file confirmed on server)
}

export async function deleteFile(id) {
  _fileCache.delete(id);
  _fileLocationCache.delete(id);
}

/**
 * Returns a direct WebDAV URL for a file, or null if the location is not known.
 * Used by NC build to set <audio src> directly (avoids blob: URL which is blocked by NC CSP media-src).
 */
export function getFileUrl(id) {
  const loc = _fileLocationCache.get(id);
  if (!loc?.ext) return null;
  return davUrl(getMediaPath(loc.noteId, loc.notebookId, `${id}${loc.ext}`));
}

// Pending upload promises: fileId → Promise — lets callers await upload completion
const _pendingUploads = new Map();

export function registerPendingUpload(fileId, promise) {
  _pendingUploads.set(
    fileId,
    promise.finally(() => _pendingUploads.delete(fileId)),
  );
}

/**
 * Waits for any in-flight upload for this fileId to complete, then returns the WebDAV URL.
 * Returns null if no URL can be determined.
 */
export async function waitForFileUrl(id) {
  const pending = _pendingUploads.get(id);
  if (pending) await pending.catch(() => {});
  return getFileUrl(id);
}

// ─── Storage stats / admin ────────────────────────────────────────────────────

export async function getStorageStats() {
  return { notes: 0, notebooks: 0, files: 0, settings: 0 };
}

export async function clearAllData() {
  // No-op in NC build — data lives on Nextcloud server
  console.warn("[WebDAV Storage] clearAllData is a no-op in Nextcloud build");
}

export async function purgeLocalData() {
  console.warn("[WebDAV Storage] purgeLocalData is a no-op in Nextcloud build");
}

export async function getStorageVersion() {
  return 2;
}
export async function setStorageVersion() {}

// ─── Encryption stubs (always off in NC build) ───────────────────────────────

export async function isLocalEncryptionEnabled() {
  return false;
}
export async function fixCorruptedNotes() {
  return { fixed: 0 };
}
export async function migrateNotesToEncrypted() {}
export async function updateNoteEtag() {}

// ─── Merge baselines ─────────────────────────────────────────────────────────
// The NC build has no local database. Its baselines live in memory per open note
// (see the write path); these exist so modules shared with the native build
// import the same names.
// Nothing is kept locally here, so there are no unsynced changes to give up.
export async function discardLocalChanges() {}

export async function getNoteBase() {
  return null;
}
export async function setNoteBase() {}
export async function deleteNoteBase() {}

// ─── Sync stubs (no sync in NC build) ────────────────────────────────────────

export async function getAllNotesForSync() {
  return [];
}
export async function getAllNoteMetadataForSync() {
  return [];
}
export async function getAllNotebooksForSync() {
  return [];
}
export async function purgeNotebook(id) {
  return permanentlyDeleteNotebook(id);
}
export async function saveNotebook(nb) {
  return updateNotebook(nb.id, nb);
}

// ─── Shared notebooks: UI entry points ───────────────────────────────────────

/**
 * Leave a notebook shared with this user ("Remove from my list"): the server
 * drops only this user's access, then the notebook disappears from the list.
 */
export async function leaveSharedNotebook(notebookId) {
  await getSharedRegistry()?.leave(notebookId);
}

/** Look for new, changed and ended shares now (e.g. after leaving one). */
export async function refreshSharedNotebooks() {
  await getSharedRegistry()?.refresh({ force: true });
}
