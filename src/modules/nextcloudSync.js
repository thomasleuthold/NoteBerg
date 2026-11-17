/**
 * Nextcloud Sync Module
 * Uses Nextcloud Login Flow v2 and WebDAV for syncing
 * Uses Tauri's HTTP client for native requests (no CORS issues!)
 *
 * Storage Version 2: Hierarchical folder structure
 */

import { fetch as _tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { APP_NAME, APP_VERSION } from "../config.js";
import { logger } from "../utils/logger.js";
import { decryptObject } from "./encryption.js";
import { getEncryptionKey, isAppUnlocked } from "./masterPassword.js";
import { extFromMime, mimeFromExt } from "./mime.js";
import { attemptMerge } from "./noteMerge.js";
import { noteForUpload } from "./noteUpload.js";
import {
  getSecureCredential as _tauriGetSecureCredential,
  deleteSecureCredential,
  saveSecureCredential,
} from "./secureStorage.js";
import { createDavOps as createSharingDavOps, OWNER_PROPFIND_BODY } from "./sharing/davOps.js";
import { isForeignGuardActive } from "./sharing/enabled.js";
import { setNativeOcsTransport } from "./sharing/nextcloudShares.js";
import { stripLocalFields } from "./sharing/notebookShareFields.js";
import { canEdit } from "./sharing/sharePermissions.js";
import {
  checkFileExists,
  clearNoteMoveFlag,
  getFile,
  getNoteBase,
  getRawNote,
  permanentlyDeleteNote,
  permanentlyDeleteNotebook,
  permanentlyDeleteNotesInNotebook,
  saveFile,
  saveNote,
} from "./storage.js";
import {
  davHrefToPath,
  encodeDavPath,
  getAllRequiredFolders,
  getGlobalNotebookTombstonePath,
  getLegacyNotebookPath,
  getLegacyNotePath,
  getNotebookFolder,
  getNotebookNotesFolder,
  getNotebookPath,
  getNotebookTombstonePath,
  getNoteMediaFolder,
  getNotePath,
  getQuickNotesTombstonePath,
  isPathWithin,
  isSafeId,
  isShareEnded,
  parseNotebookRelativePath,
  parsePath,
  ROOT_FOLDER,
  STORAGE_VERSION,
} from "./storagePaths.js";
import {
  addNotebookTombstone,
  addNoteTombstone,
  cleanupOldTombstones,
  createEmptyTombstone,
} from "./tombstones.js";

// The merge itself lives in noteMerge.js so the Nextcloud app build can use it too
export { attemptMerge };

// ─── HTTP / credential providers ──────────────────────────────────────────────
// The real Tauri implementations. (Previously these were injectable for an
// off-thread SyncWorker that no longer exists.)
const _fetch = _tauriFetch;
const _getSecureCredential = _tauriGetSecureCredential;

const NEXTCLOUD_STORAGE_KEY = "nextcloud_credentials";
const LEGACY_STORAGE_KEY = "nextcloud_credentials"; // Same key used in localStorage

/**
 * Build a Basic Auth header value that is safe for non-Latin1 credentials.
 * `btoa()` throws on characters outside Latin1; this encodes via TextEncoder first.
 */
function basicAuth(loginName, appPassword) {
  const raw = `${loginName}:${appPassword}`;
  try {
    return `Basic ${btoa(raw)}`;
  } catch (_e) {
    // Fallback: encode each code-point via percent-encoding then btoa
    const bytes = new TextEncoder().encode(raw);
    let latin1 = "";
    for (const b of bytes) latin1 += String.fromCharCode(b);
    return `Basic ${btoa(latin1)}`;
  }
}

// Ceiling on the total bytes of media downloads held in memory at once.
//
// runInBatches gives every download stage a concurrency of 5, which is right for
// the common case (many small note JSONs) but unbounded in BYTES: five notes
// that each embed a 1000-page PDF would materialize five full files at the same
// time and OOM-kill the WebView renderer on a low-end Android tablet — the app
// simply vanishes mid-sync, with no JS error to catch.
//
// The budget bounds concurrent bytes rather than concurrent requests, so small
// files stay fully parallel and only genuinely large ones serialize.
const MAX_INFLIGHT_MEDIA_BYTES = 64 * 1024 * 1024;

let _inflightMediaBytes = 0;
const _mediaBudgetWaiters = [];

/**
 * Reserve `bytes` of the in-flight media budget, waiting until it fits.
 *
 * A request larger than the whole budget is admitted alone (once the pipe is
 * otherwise empty) rather than deadlocking forever waiting for space that can
 * never exist.
 * @returns {Promise<() => void>} release function — must be called in a finally.
 */
async function acquireMediaBudget(bytes) {
  const cost = Math.max(0, bytes || 0);
  const fits = () =>
    _inflightMediaBytes === 0 || _inflightMediaBytes + cost <= MAX_INFLIGHT_MEDIA_BYTES;

  while (!fits()) {
    await new Promise((resolve) => _mediaBudgetWaiters.push(resolve));
  }

  _inflightMediaBytes += cost;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _inflightMediaBytes -= cost;
    // Wake every waiter and let each re-test: the freed space may admit several
    // small requests but not one large one, and only the waiters know their size.
    while (_mediaBudgetWaiters.length > 0) _mediaBudgetWaiters.shift()();
  };
}

// Helper for batching promises
async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Decrypt a locally-encrypted note into plain objects.
 * If the note is not locally encrypted, returns the note unchanged.
 *
 * A field that cannot be decrypted comes back as its empty value. Callers that
 * write the result to the server must use decryptNoteFields() instead, which
 * names those fields, so the server's copy of them is not overwritten with
 * nothing (see fillUndecryptableFieldsFromServer).
 * @param {Object} note - Note object (may be locally encrypted)
 * @returns {Promise<Object>} - Note with all content fields decrypted
 */
async function decryptNoteLocally(note) {
  return (await decryptNoteFields(note)).note;
}

/**
 * decryptNoteLocally(), also reporting which fields could not be decrypted.
 * @param {Object} note - Note object (may be locally encrypted)
 * @returns {Promise<{note: Object, failed: string[]}>}
 */
async function decryptNoteFields(note) {
  if (!note.encrypted) return { note, failed: [] };

  if (!isAppUnlocked()) {
    throw new Error("Cannot upload encrypted note - app is locked");
  }

  const key = getEncryptionKey();
  const isBlob = (v) =>
    v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";

  // Decrypt each field independently, and never let one bad field take the note
  // with it.
  //
  // A single blob encrypted with a key this client no longer holds — a purge and
  // restore cycle, a changed master password — used to throw straight out of
  // this function. The caller then failed the whole note's upload, every sync,
  // forever: the note could never reach the server again and the failure looked
  // identical to a wrong master password.
  //
  // Such a field holds nothing edited since the key changed: saveNote
  // re-encrypts every field it writes with the current key, so the user's new
  // edits are always in fields that do decrypt. Reporting the failed fields lets
  // the upload path keep both — the new edits from here, the unreadable fields
  // from the server's copy — instead of choosing which one to lose.
  const failed = [];
  const decryptField = async (value, fallback) => {
    if (!isBlob(value)) return value;
    try {
      return await decryptObject(value, key);
    } catch (_e) {
      failed.push(fallback.name);
      return fallback.value;
    }
  };

  const result = {
    ...note,
    content: await decryptField(note.content, { name: "content", value: "" }),
    strokes: await decryptField(note.strokes, { name: "strokes", value: [] }),
    media: await decryptField(note.media, { name: "media", value: [] }),
    recordings: isBlob(note.recordings)
      ? await decryptField(note.recordings, { name: "recordings", value: [] })
      : (note.recordings ?? []),
    tasks: isBlob(note.tasks)
      ? await decryptField(note.tasks, { name: "tasks", value: [] })
      : note.tasks || [],
    deletedTasks: isBlob(note.deletedTasks)
      ? await decryptField(note.deletedTasks, { name: "deletedTasks", value: [] })
      : note.deletedTasks || [],
    recognition: await decryptField(note.recognition, { name: "recognition", value: null }),
    encrypted: undefined,
  };

  if (failed.length > 0) {
    // Warning, not debug: the local copy of these fields is lost, and the user
    // should be able to see it in the log without changing settings.
    console.warn(
      `[Sync] Note ${note.id}: could not decrypt ${failed.join(", ")} (wrong key or corrupted).`,
    );
  }

  return { note: result, failed };
}

const isLocallyEncryptedBlob = (v) =>
  v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";

/**
 * Take the fields this client could not decrypt from another copy of the note.
 * A field the source lacks, or holds only as an encrypted blob, stays empty.
 * @param {Object} note - Plain note from decryptNoteFields()
 * @param {string[]} failed - Field names from decryptNoteFields()
 * @param {Object} source - Plain note to take them from (the server's copy)
 * @returns {Object}
 */
function takeFieldsFrom(note, failed, source) {
  const filled = { ...note };
  for (const field of failed) {
    const value = source?.[field];
    if (value !== undefined && !isLocallyEncryptedBlob(value)) filled[field] = value;
  }
  return filled;
}

/**
 * Before an upload, fill the fields that could not be decrypted locally from
 * the server's copy of the note, so the upload carries this device's new edits
 * without overwriting the server's intact copy of those fields with nothing.
 *
 * Costs one extra GET, and only on this rare path: in the usual case (only
 * this device changed) fullSync holds just a stub of the remote note.
 *
 * @param {Object} note - Plain note from decryptNoteFields()
 * @param {string[]} failed - Field names from decryptNoteFields()
 * @param {string} path - The note's remote path
 * @returns {Promise<Object|null>} The note with those fields taken from the
 *   server; unchanged (fields empty) when the server has no usable copy, so
 *   there is nothing to keep; or null when the server copy could not be
 *   fetched — the caller skips the upload this cycle and retries next sync,
 *   rather than blank fields the server may still hold.
 */
async function fillUndecryptableFieldsFromServer(note, failed, path) {
  let content;
  try {
    ({ content } = await downloadFile(path));
  } catch (e) {
    console.warn(
      `[Sync] Note ${note.id}: could not fetch the server copy to recover ${failed.join(", ")} — skipping this upload, will retry:`,
      e,
    );
    return null;
  }

  if (!content) {
    console.warn(
      `[Sync] Note ${note.id}: no server copy to recover ${failed.join(", ")} from — uploading without them.`,
    );
    return note;
  }

  let remote;
  try {
    remote = await decryptNoteFromNextcloud(JSON.parse(content));
  } catch (_e) {
    console.warn(
      `[Sync] Note ${note.id}: server copy is unreadable, cannot recover ${failed.join(", ")} — uploading without them.`,
    );
    return note;
  }

  console.warn(`[Sync] Note ${note.id}: recovered ${failed.join(", ")} from the server copy.`);
  return takeFieldsFrom(note, failed, remote);
}

/**
 * Decrypt note data from Nextcloud and prepare it for local storage
 * @param {Object} note - Note object (possibly encrypted for Nextcloud)
 * @returns {Promise<Object>} - Note prepared for local storage (encrypted if local encryption enabled)
 */
async function decryptNoteFromNextcloud(note) {
  let decryptedNote = note;

  // Step 1: If the note has local encryption from another client (encrypted: true),
  // decrypt it now so saveNote can re-encrypt it with this client's local key.
  // This handles the case where a note was saved encrypted by another client and
  // uploaded to Nextcloud without Nextcloud-level encryption.
  if (decryptedNote.encrypted) {
    try {
      decryptedNote = await decryptNoteLocally(decryptedNote);
    } catch (err) {
      console.error(
        `[NextcloudSync] Could not decrypt locally-encrypted note ${decryptedNote.id} — wrong key or corrupted:`,
        err,
      );
      // Leave as-is; saveNote will store it with encrypted:true and it will fail on read.
      // This is better than silently discarding the note.
    }
  }

  // Step 3: Sanitize any stray locally-encrypted blobs that survived the upload path.
  // This can happen when recordings/media were encrypted by another client's local key
  // and uploaded without being decrypted first (e.g. the Android local-encryption bug).
  // The `encrypted` flag is absent from the Nextcloud JSON, so step 2 never fires.
  // We attempt to decrypt with our own key and fall back to [] on failure (wrong key).
  const isEncryptedBlob = (v) =>
    v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";

  if (isEncryptedBlob(decryptedNote.recordings) || isEncryptedBlob(decryptedNote.media)) {
    if (isAppUnlocked()) {
      const key = getEncryptionKey();

      if (isEncryptedBlob(decryptedNote.recordings)) {
        try {
          const dec = await decryptObject(decryptedNote.recordings, key);
          decryptedNote = { ...decryptedNote, recordings: Array.isArray(dec) ? dec : [] };
        } catch (_e) {
          // Wrong key (from another device) — drop the recordings rather than breaking the note
          console.warn(
            `[NextcloudSync] Could not decrypt recordings blob for note ${decryptedNote.id} — dropping recordings`,
          );
          decryptedNote = { ...decryptedNote, recordings: [] };
        }
      }

      if (isEncryptedBlob(decryptedNote.media)) {
        try {
          const dec = await decryptObject(decryptedNote.media, key);
          decryptedNote = { ...decryptedNote, media: Array.isArray(dec) ? dec : [] };
        } catch (_e) {
          console.warn(
            `[NextcloudSync] Could not decrypt media blob for note ${decryptedNote.id} — dropping media`,
          );
          decryptedNote = { ...decryptedNote, media: [] };
        }
      }
    }
  }

  // Return plain text note (storage.js will handle local encryption on save)
  return decryptedNote;
}

/**
 * Migrate credentials from localStorage to secure storage
 * Called once on app startup
 */
export async function migrateCredentials() {
  try {
    const legacyCredString = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyCredString) {
      return;
    }

    const existingCreds = await _getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    if (existingCreds) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }

    await saveSecureCredential(NEXTCLOUD_STORAGE_KEY, legacyCredString);
    dropCredentialsCache();
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    console.info("[NextcloudSync] Migrated credentials to secure storage");
  } catch (error) {
    console.error("[NextcloudSync] Failed to migrate credentials:", error);
  }
}

// The credentials as last read, so the many requests of a sync (the open note's
// live sync makes about six in a row) do not each go to the keystore: on Android
// that is a native plugin call with an AES-GCM decrypt, tens of ms apiece. Held
// as the stored string and parsed per call, so a caller cannot change the cache.
// Every write in this module drops it; the lifetime only bounds a change made
// elsewhere. Never holds "nothing" or a failure.
const CREDENTIALS_CACHE_MS = 60_000;
let credentialsCache = null; // { raw: string, at: number }

/** Forget the cached credentials (a write drops them itself; tests that rewrite the keystore call this). */
export function dropCredentialsCache() {
  credentialsCache = null;
}

/**
 * Get stored Nextcloud credentials from secure storage
 */
export async function getStoredCredentials() {
  try {
    if (credentialsCache && Date.now() - credentialsCache.at < CREDENTIALS_CACHE_MS) {
      return JSON.parse(credentialsCache.raw);
    }
    const credString = await _getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    if (credString) {
      const parsed = JSON.parse(credString);
      credentialsCache = { raw: credString, at: Date.now() };
      return parsed;
    }
    return null;
  } catch (error) {
    console.error("[NextcloudSync] Failed to get credentials:", error);
    return null;
  }
}

/**
 * Save Nextcloud credentials to secure storage
 */
async function saveCredentials(credentials) {
  dropCredentialsCache();
  try {
    const credString = JSON.stringify(credentials);
    await saveSecureCredential(NEXTCLOUD_STORAGE_KEY, credString);
    dropCredentialsCache(); // a read during the write may have cached the old value

    // Verify save worked
    const verifyRead = await _getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    if (!verifyRead) {
      console.error("[NextcloudSync] Credential save verification failed");
    }
  } catch (error) {
    console.error("[NextcloudSync] Failed to save credentials:", error);
    throw error;
  }
}

/**
 * Clear stored credentials from secure storage
 */
export async function clearCredentials() {
  dropCredentialsCache();
  resetUserIdLookup();
  try {
    await deleteSecureCredential(NEXTCLOUD_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear credentials:", error);
    throw error;
  }
}

// ─── WebDAV account root ──────────────────────────────────────────────────────
// WebDAV paths are keyed by the Nextcloud *user ID*, which is not necessarily
// the login name Login Flow v2 returns: LDAP/AD backends map accounts to UUIDs,
// and users may log in with an email address or alias. Basic auth accepts the
// login name, but /remote.php/dav/files/{loginName}/ does not exist on such
// servers and every request fails (MKCOL answers 409).
//
// The user ID is fetched from OCS at login and stored as `creds.userId`.
// Credentials saved before that field existed are backfilled lazily on first
// use. Until the lookup succeeds the login name is used — exactly the previous
// behavior, which is correct whenever login name and user ID coincide.

// After a failed lookup, keep using the login name for this long before asking
// OCS again, so a sync cycle does not double every request against a server
// whose OCS endpoint is unreachable.
const USER_ID_RETRY_MS = 5 * 60 * 1000;

let _userIdLookup = null; // { key, promise } — dedupes concurrent backfills
let _userIdFailure = null; // { key, at } — last failed backfill

function resetUserIdLookup() {
  _userIdLookup = null;
  _userIdFailure = null;
}

/**
 * Ask Nextcloud for the internal user ID of the authenticated account.
 * @throws when the server does not answer with a usable ID
 */
async function fetchUserId(serverUrl, authHeader) {
  const response = await _fetch(`${serverUrl}/ocs/v2.php/cloud/user?format=json`, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`OCS user lookup failed: ${response.status} ${response.statusText}`);
  }
  const userId = (await response.json())?.ocs?.data?.id;
  if (typeof userId !== "string" || !userId) {
    throw new Error("OCS user lookup returned no user id");
  }
  return userId;
}

/**
 * Store a backfilled user ID — but only onto the same account it was looked up
 * for. A logout or re-login while the lookup was in flight must not be undone.
 */
async function persistUserId(creds, userId) {
  const current = await getStoredCredentials();
  if (
    current?.serverUrl !== creds.serverUrl ||
    current?.loginName !== creds.loginName ||
    current?.appPassword !== creds.appPassword
  ) {
    return;
  }
  await saveCredentials({ ...current, userId });
}

async function backfillUserId(creds, key) {
  try {
    const userId = await fetchUserId(
      creds.serverUrl,
      basicAuth(creds.loginName, creds.appPassword),
    );
    await persistUserId(creds, userId);
    _userIdFailure = null;
    return userId;
  } catch (error) {
    logger.warning("NextcloudSync", "User ID lookup failed — using login name for WebDAV paths", {
      message: error?.message ?? String(error),
    });
    _userIdFailure = { key, at: Date.now() };
    return creds.loginName;
  }
}

/**
 * The user ID to put into WebDAV paths for `creds`.
 */
async function resolveUserId(creds) {
  if (creds.userId) return creds.userId;

  const key = `${creds.serverUrl}\n${creds.loginName}`;
  if (_userIdFailure?.key === key && Date.now() - _userIdFailure.at < USER_ID_RETRY_MS) {
    return creds.loginName;
  }
  if (_userIdLookup?.key !== key) {
    const promise = backfillUserId(creds, key).finally(() => {
      if (_userIdLookup?.promise === promise) _userIdLookup = null;
    });
    _userIdLookup = { key, promise };
  }
  return _userIdLookup.promise;
}

/**
 * The Nextcloud user ID of the signed-in account (null when signed out).
 * Used to attribute edits (`lastModifiedBy`) and to recognise our own files.
 */
export async function getCurrentUserId() {
  const creds = await getStoredCredentials();
  return creds ? resolveUserId(creds) : null;
}

/**
 * The user ID together with whether the server confirmed it. When the lookup
 * fails, getCurrentUserId() falls back to the login name, which is often but not
 * always the user ID. That guess is good enough to address WebDAV (a wrong one
 * simply fails), but never for deciding that something belongs to another user.
 * @returns {Promise<{uid: string|null, confirmed: boolean}>}
 */
export async function getCurrentUserIdentity() {
  const uid = await getCurrentUserId();
  // A confirmed ID is stored with the credentials; the fallback never is
  const stored = (await getStoredCredentials())?.userId ?? null;
  return { uid, confirmed: Boolean(uid) && stored === uid };
}

/**
 * Everything a WebDAV request needs from the stored account: the auth header
 * and URL builders rooted at the user's DAV principal.
 * @throws when not authenticated
 */
async function getDavAccount() {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const user = encodeURIComponent(await resolveUserId(creds));
  const davRoot = `${creds.serverUrl}/remote.php/dav`;
  return {
    authHeader: basicAuth(creds.loginName, creds.appPassword),
    fileUrl: (path) => `${davRoot}/files/${user}${encodeDavPath(path)}`,
    uploadUrl: (uploadId) => `${davRoot}/uploads/${user}/${uploadId}`,
  };
}

// The sharing API (OCS) authenticates like WebDAV does: the stored app password,
// through the Tauri client
setNativeOcsTransport(async () => {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");
  return {
    baseUrl: creds.serverUrl,
    fetch: _fetch,
    headers: { Authorization: basicAuth(creds.loginName, creds.appPassword) },
    userId: await resolveUserId(creds),
  };
});

/**
 * Check if user is authenticated
 */
export async function isAuthenticated() {
  const creds = await getStoredCredentials();
  return !!(creds?.serverUrl && creds.loginName && creds.appPassword);
}

/**
 * Normalize a user-entered server URL: default to https:// when no scheme
 * was typed, and strip a trailing slash. Without this, a bare host like
 * "example.com" is treated as a path relative to the webview's own origin
 * (tauri.localhost) instead of an absolute URL.
 */
function normalizeServerUrl(serverUrl) {
  serverUrl = serverUrl.trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(serverUrl)) {
    serverUrl = `https://${serverUrl}`;
  }
  return serverUrl;
}

/**
 * Test connection to Nextcloud server
 */
export async function testConnection(serverUrl) {
  serverUrl = normalizeServerUrl(serverUrl);

  try {
    const response = await _fetch(`${serverUrl}/status.php`, {
      headers: {
        "User-Agent": `${APP_NAME}/${APP_VERSION}`,
      },
    });
    if (!response.ok) {
      return { success: false, error: `Server returned HTTP ${response.status}` };
    }
    let data;
    try {
      data = await response.json();
    } catch (jsonErr) {
      console.error("[NextcloudSync] testConnection: invalid JSON from status.php", jsonErr);
      return {
        success: false,
        error: "Server did not return valid JSON — not a Nextcloud server?",
      };
    }

    if (data.installed && data.version) {
      return {
        success: true,
        version: data.version,
        versionstring: data.versionstring,
      };
    }

    return { success: false, error: "Not a valid Nextcloud server" };
  } catch (error) {
    // Capture the full error (reqwest includes the underlying cause — DNS, TLS,
    // connection refused — after the URL) in the copyable debug logs.
    logger.error("NextcloudSync", "testConnection failed", {
      url: `${serverUrl}/status.php`,
      name: error?.name,
      message: error?.message ?? String(error),
    });
    return { success: false, error: error?.message || String(error) };
  }
}

/**
 * Start Nextcloud Login Flow v2
 * Returns a promise that resolves when authentication is complete
 * Calls onLoginUrlReady callback with login URL when available
 */
export async function startLoginFlow(serverUrl, onLoginUrlReady = null) {
  serverUrl = normalizeServerUrl(serverUrl);

  try {
    // Step 1: Initialize login flow
    console.log("Initializing Login Flow v2 for:", serverUrl);

    let initResponse;
    try {
      initResponse = await _fetch(`${serverUrl}/index.php/login/v2`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "OCS-APIRequest": "true",
          "User-Agent": `${APP_NAME}/${APP_VERSION}`,
        },
        body: "",
      });
    } catch (fetchError) {
      console.error("Fetch error:", fetchError);
      throw new Error(`Network error: ${fetchError.message || "Failed to connect to server"}`);
    }

    console.log("Init response status:", initResponse.status);

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error("Init response error:", errorText);
      throw new Error(
        `Failed to initialize login flow: ${initResponse.status} ${initResponse.statusText}`,
      );
    }

    // SECURITY: never log the response body or parsed data — it contains the
    // poll token, which lets anyone reading the log obtain the app password
    // while the login flow is open (~20 min).
    const responseText = await initResponse.text();

    if (!responseText || responseText.trim() === "") {
      console.error("Empty response from server");
      throw new Error("Empty response from server");
    }

    let initData;
    try {
      initData = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse init response as JSON:", e);
      throw new Error(`Invalid JSON response from server: ${e.message}`);
    }

    const { poll, login } = initData;

    if (!poll || !login) {
      console.error("Invalid login flow response - missing poll or login");
      throw new Error("Invalid login flow response - missing poll or login");
    }

    // Extract token from poll object
    const token = poll.token;
    const endpoint = poll.endpoint;

    if (!token || !endpoint) {
      console.error("Invalid poll response - missing token or endpoint");
      throw new Error("Invalid poll response - missing token or endpoint");
    }

    console.log("Login Flow initialized, poll endpoint:", endpoint);

    // Step 2: Provide login URL to callback (for UI display)
    if (onLoginUrlReady) {
      onLoginUrlReady(login);
    }

    // Step 3: Try to open login page in default browser
    console.log("Opening login page in browser...");
    try {
      await openUrl(login);
      console.log("Browser opened successfully");
    } catch (openError) {
      console.warn("Failed to open URL automatically:", openError);
      // If automatic opening fails, user can still use the URL field
    }

    // Step 3: Poll for credentials (browser-based, no popup to track)
    const credentials = await pollForCredentials(endpoint, token, null);

    // Step 4: Save credentials
    const savedCreds = {
      serverUrl,
      loginName: credentials.loginName,
      appPassword: credentials.appPassword,
    };

    // A failed lookup must not fail the login: without userId the first sync
    // retries it (see resolveUserId).
    resetUserIdLookup();
    try {
      savedCreds.userId = await fetchUserId(
        serverUrl,
        basicAuth(savedCreds.loginName, savedCreds.appPassword),
      );
    } catch (error) {
      logger.warning("NextcloudSync", "User ID lookup after login failed — will retry on sync", {
        message: error?.message ?? String(error),
      });
    }

    await saveCredentials(savedCreds);
    console.log("Nextcloud authentication successful");

    return savedCreds;
  } catch (error) {
    console.error("Login flow error:", error);
    throw error;
  }
}

/**
 * Poll for credentials after user completes login
 */
async function pollForCredentials(endpoint, token, popup) {
  const maxAttempts = 60; // 5 minutes (60 * 5 seconds)
  let attempts = 0;

  return new Promise((resolve, reject) => {
    console.log("Starting to poll for credentials. Please complete login in your browser...");

    const pollInterval = setInterval(async () => {
      attempts++;

      // Check if popup was closed (only if popup exists)
      if (popup?.closed) {
        clearInterval(pollInterval);
        reject(new Error("Login cancelled by user"));
        return;
      }

      // Check if max attempts reached
      if (attempts > maxAttempts) {
        clearInterval(pollInterval);
        if (popup) popup.close();
        reject(new Error("Login timeout - please try again"));
        return;
      }

      try {
        // Poll endpoint with token as URL parameter (not body!)
        const pollUrl = `${endpoint}?token=${encodeURIComponent(token)}`;
        console.log(`Polling attempt ${attempts}/${maxAttempts}...`);

        const response = await _fetch(pollUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (response.status === 404) {
          // Still waiting for user to complete login
          console.log("Waiting for user to complete login...");
          return;
        }

        if (!response.ok) {
          clearInterval(pollInterval);
          if (popup) popup.close();
          reject(new Error(`Polling failed: ${response.status} ${response.statusText}`));
          return;
        }

        // Success! We have credentials
        const data = await response.json();
        console.log("Login successful! Credentials received.");
        clearInterval(pollInterval);
        if (popup) popup.close();
        resolve(data);
      } catch (error) {
        // Continue polling on network errors
        console.warn("Poll attempt failed:", error.message);
      }
    }, 5000); // Poll every 5 seconds
  });
}

/**
 * Create a folder in Nextcloud using WebDAV
 */
async function createFolder(path) {
  const { authHeader, fileUrl } = await getDavAccount();

  const response = await _fetch(fileUrl(path), {
    method: "MKCOL",
    headers: {
      Authorization: authHeader,
      "OCS-APIRequest": "true",
    },
  });

  if (response.status === 405) {
    // Folder already exists
    return true;
  }

  if (!response.ok && response.status !== 201) {
    throw new Error(`Failed to create folder: ${response.status} ${response.statusText}`);
  }

  return true;
}

// Above this size, a Blob body is uploaded via Nextcloud's chunked-upload
// endpoint instead of a single PUT.
//
// This is NOT a network optimisation — it is a hard memory constraint imposed by
// the Tauri HTTP plugin. `@tauri-apps/plugin-http`'s fetch cannot stream a body:
// it does `Array.from(new Uint8Array(await req.arrayBuffer()))` and passes the
// result through the JSON IPC bridge to Rust. Every byte becomes a boxed JS
// number (~8 bytes) and then ~4 more bytes of JSON text, so a single PUT costs
// roughly 12x the file size in transient allocation — a 120MB PDF (a scanned
// 1500-page book) peaks over 1.3GB and the Android WebView renderer is
// OOM-killed by the kernel. There is no JS exception to catch: the app vanishes
// mid-sync, and because the upload never completes the note stays synced=false
// and crashes again on the next sync, including at app start.
//
// The native WebView fetch would stream this correctly but is unusable here:
// WebDAV requests to the Nextcloud host are cross-origin and blocked by CORS.
// So the only lever from JS is to keep each individual body small; chunking is
// the fix, and a byte budget (as used for downloads) is not — that bounds
// concurrent files, while this blowup is per-file and happens with just one.
const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Upload a large Blob via Nextcloud's chunked-upload endpoint.
 *
 * Three plain WebDAV verbs against /remote.php/dav/uploads/{user}/{uploadId}/:
 *   MKCOL  the session directory
 *   PUT    each chunk, named by its 1-based index
 *   MOVE   .file to the destination, which assembles the chunks server-side
 *
 * Chunks are sent SEQUENTIALLY on purpose. Uploading them in parallel would put
 * several chunks through the IPC marshalling above at once and reintroduce the
 * very memory spike this exists to avoid.
 *
 * Not resumable: on failure the session directory is deleted and the error
 * propagates, leaving the note synced=false so the ordinary retry starts over.
 * Cross-restart resume is real complexity for a rare case, so it is out of scope.
 */
async function uploadFileChunked(path, blob, mtime = null) {
  const { authHeader, fileUrl, uploadUrl } = await getDavAccount();

  // Session-directory name only — never persisted, so a timestamp plus random
  // suffix is enough to keep concurrent uploads from colliding.
  const uploadId = `noteberg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploadRoot = uploadUrl(uploadId);
  const destinationUrl = fileUrl(path);

  const mkcolResponse = await _fetch(uploadRoot, {
    method: "MKCOL",
    headers: { Authorization: authHeader, "OCS-APIRequest": "true" },
  });
  if (!mkcolResponse.ok && mkcolResponse.status !== 201) {
    throw new Error(
      `Failed to create chunked upload session: ${mkcolResponse.status} ${mkcolResponse.statusText}`,
    );
  }

  try {
    const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
    for (let index = 0; index < totalChunks; index++) {
      const start = index * CHUNK_SIZE;
      // blob.slice() is a view over the same underlying data — it does not copy
      // the payload, so only the sliced chunk is ever marshalled.
      const chunk = blob.slice(start, Math.min(start + CHUNK_SIZE, blob.size));

      const chunkHeaders = {
        Authorization: authHeader,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache",
      };
      // Raw bytes over IPC where the app can (putFileRaw); the HTTP plugin otherwise
      const sent = await putFileRaw(`/${uploadId}/${index + 1}`, chunk, chunkHeaders, {
        tree: "uploads",
      });
      const chunkResponse = sent
        ? { ok: sent.status >= 200 && sent.status < 300, status: sent.status, statusText: "" }
        : await _fetch(`${uploadRoot}/${index + 1}`, {
            method: "PUT",
            headers: chunkHeaders,
            body: chunk,
          });

      if (!chunkResponse.ok && chunkResponse.status !== 201 && chunkResponse.status !== 204) {
        throw new Error(
          `Failed to upload chunk ${index + 1}/${totalChunks}: ${chunkResponse.status} ${chunkResponse.statusText}`,
        );
      }
    }

    const moveHeaders = {
      Authorization: authHeader,
      Destination: destinationUrl,
      "OCS-APIRequest": "true",
    };
    // Carried on the MOVE rather than the chunk PUTs — the destination file only
    // comes into existence when the chunks are assembled.
    if (mtime) {
      moveHeaders["X-OC-Mtime"] = Math.floor(new Date(mtime).getTime() / 1000).toString();
    }

    const moveResponse = await _fetch(`${uploadRoot}/.file`, {
      method: "MOVE",
      headers: moveHeaders,
    });

    if (!moveResponse.ok && moveResponse.status !== 201 && moveResponse.status !== 204) {
      throw new Error(
        `Failed to assemble chunked upload: ${moveResponse.status} ${moveResponse.statusText}`,
      );
    }

    let newEtag = moveResponse.headers?.get("etag")?.replace(/"/g, "");
    if (!newEtag) {
      try {
        const headResponse = await _fetch(destinationUrl, {
          method: "HEAD",
          headers: { Authorization: authHeader },
        });
        if (headResponse.ok) {
          newEtag = headResponse.headers?.get("etag")?.replace(/"/g, "");
        }
      } catch (_e) {
        // Etag is optional for media uploads — callers of the Blob path ignore it.
      }
    }
    return newEtag;
  } catch (error) {
    // Best-effort cleanup so a failed session does not accumulate on the server.
    try {
      await _fetch(uploadRoot, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      });
    } catch (_e) {
      // Cleanup failure must not mask the original upload error.
    }
    throw error;
  }
}

/**
 * Upload a file to Nextcloud using WebDAV
 * Uses X-OC-Mtime to set the modification time to match local file
 * @param {string|null} etag - If set, sent as If-Match so a concurrent remote
 *   change fails the upload (412) instead of being overwritten.
 * @param {boolean} options.requireAbsent - Send If-None-Match: * so the upload
 *   fails (412) if the file already exists (used for tombstone creation races).
 */
async function uploadFile(
  path,
  content,
  mtime = null,
  etag = null,
  { requireAbsent = false } = {},
) {
  const { authHeader, fileUrl } = await getDavAccount();

  // Large binaries go through the chunked endpoint (see CHUNKED_UPLOAD_THRESHOLD).
  // Only media uploads pass a Blob, and that call site passes no etag/mtime/
  // requireAbsent — the If-Match conflict handling below is JSON-only and stays
  // unreachable from here. Asserted rather than assumed: silently dropping an
  // If-Match would turn a conflict-detected upload into a blind overwrite.
  if (typeof Blob !== "undefined" && content instanceof Blob) {
    if (etag || requireAbsent) {
      throw new Error("uploadFile: If-Match/If-None-Match are not supported for Blob bodies");
    }
    if (content.size > CHUNKED_UPLOAD_THRESHOLD) {
      return uploadFileChunked(path, content, mtime);
    }
  }

  const webdavUrl = fileUrl(path);

  const headers = {
    Authorization: authHeader,
    // Every other caller uploads JSON; only media passes a Blob. Sending
    // application/json for binary media was harmless (WebDAV stores the bytes
    // either way) but wrong, and it misleads anything reading the file back.
    "Content-Type":
      typeof Blob !== "undefined" && content instanceof Blob
        ? content.type || "application/octet-stream"
        : "application/json",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  // Set modification time if provided (Nextcloud-specific header)
  if (mtime) {
    headers["X-OC-Mtime"] = Math.floor(new Date(mtime).getTime() / 1000).toString();
  }

  // Use ETag to prevent overwriting changes (If-Match)
  if (etag) {
    headers["If-Match"] = `"${etag}"`;
  } else if (requireAbsent) {
    headers["If-None-Match"] = "*";
  }

  // The body as raw bytes over IPC where the app can (putFileRaw); the HTTP
  // plugin otherwise
  const sent = await putFileRaw(path, content, headers);
  const response = sent
    ? null
    : await _fetch(webdavUrl, {
        method: "PUT",
        headers,
        body: content,
      });
  const status = sent ? sent.status : response.status;
  const ok = status >= 200 && status < 300;

  if (status === 412) {
    // Remote changed since our last sync. Do NOT force-overwrite — fail this
    // upload so the item stays synced=false and the next sync cycle downloads
    // the remote version, merges, and re-uploads.
    const err = new Error(`Upload conflict (412) for ${path} — remote changed since last sync`);
    err.status = 412;
    throw err;
  }

  if (!ok) {
    if (response) console.error("Upload error:", await response.text());
    const err = new Error(`Failed to upload file: ${status} ${response?.statusText ?? ""}`.trim());
    err.status = status;
    throw err;
  }

  let newEtag = sent ? sent.etag || undefined : response.headers.get("etag")?.replace(/"/g, "");

  // If ETag is missing (e.g. 204 response), try to fetch it via HEAD
  if (!newEtag && ok) {
    try {
      const headResponse = await _fetch(webdavUrl, {
        method: "HEAD",
        headers: {
          Authorization: headers.Authorization,
        },
      });
      newEtag = headResponse.headers.get("etag")?.replace(/"/g, "");
    } catch (e) {
      console.warn("Failed to fetch ETag after upload:", e);
    }
  }

  if (!newEtag) {
    throw new Error("Server did not return an ETag for the uploaded file");
  }

  return newEtag;
}

// Set once the app turns out not to have the raw upload command (an older
// build): every upload then goes through the HTTP plugin
let rawUploadUnavailable = false;

const IS_ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

async function toBytes(content) {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(await content.arrayBuffer());
}

async function toBase64(content) {
  const blob = content instanceof Blob ? content : new Blob([content]);
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

/**
 * PUT a body into the user's own Nextcloud files through the app's
 * `nc_put_file` command, which takes the body as raw bytes. The HTTP plugin
 * sends a body over IPC as a JSON array of numbers, one per byte: uploading a
 * 1.3 MB note blocked the main thread for about 1.5 s, while the user writes
 * (review P4). The command reads the server and the login from the stored
 * credentials itself; this side names only the path and the conditions.
 * @param {string} path - in the user's file tree
 * @param {string|Blob} content
 * @param {object} headers - the upload's headers as built for the plugin
 * @param {{tree?: "files"|"uploads"}} [options] - the user's files (default), or
 *   their chunked-upload area (`path` is then `/<session>/<n>`)
 * @returns {Promise<{status: number, etag: string|null}|null>} null when the
 *   command cannot be used here (not the app, an older build, credentials it
 *   cannot read): the caller uses the plugin then
 */
async function putFileRaw(path, content, headers, { tree = "files" } = {}) {
  if (rawUploadUnavailable) return null;
  if (typeof window === "undefined" || window.__TAURI_INTERNALS__ === undefined) return null;
  // Android's IPC cannot carry raw bytes (Tauri always uses postMessage there,
  // which JSON-encodes a typed array as one number per byte): send one base64
  // string instead, encoded natively by FileReader rather than in a JS loop
  const body = IS_ANDROID ? await toBase64(content) : await toBytes(content);
  const ipcHeaders = {
    // Encoded: IPC header values are ASCII, a shared folder's name need not be
    "x-nb-path": encodeDavPath(path),
    "x-nb-content-type": headers["Content-Type"],
    "x-nb-tree": tree,
  };
  if (headers["If-Match"]) ipcHeaders["x-nb-if-match"] = headers["If-Match"].replace(/"/g, "");
  if (headers["If-None-Match"]) ipcHeaders["x-nb-if-none-match"] = headers["If-None-Match"];
  if (headers["X-OC-Mtime"]) ipcHeaders["x-nb-mtime"] = headers["X-OC-Mtime"];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("nc_put_file", body, { headers: ipcHeaders });
  } catch (error) {
    const message = String(error?.message ?? error);
    // The command is not there, or cannot sign in: the plugin can still upload
    if (/not found|not allowed|not signed in|unreadable|not http|raw byte body/i.test(message)) {
      if (/not found|not allowed|raw byte body/i.test(message)) rawUploadUnavailable = true;
      console.warn("[Sync] Raw upload unavailable, using the HTTP plugin:", message);
      return null;
    }
    // The request itself failed (network): as any failed upload
    throw new Error(message);
  }
}

/**
 * Download a file from Nextcloud using WebDAV
 */
async function downloadFile(path, asBinary = false) {
  const { authHeader, fileUrl } = await getDavAccount();

  const response = await _fetch(fileUrl(path), {
    method: "GET",
    headers: {
      Authorization: authHeader,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (response.status === 404) {
    return { content: null, etag: null };
  }

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  if (asBinary) {
    // The in-flight byte budget is reserved from the advertised Content-Length
    // *before* the body is read, and held by the caller until the blob has been
    // persisted and dropped — reserving after the read would defeat the point.
    // A missing/!ok Content-Length reserves nothing rather than guessing, so an
    // unknown-length response still downloads instead of blocking the sync.
    const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
    const reserveBytes = Number.isFinite(declared) && declared > 0 ? declared : 0;
    const release = await acquireMediaBudget(reserveBytes);
    try {
      // response.blob() rather than arrayBuffer(): the caller hands this straight
      // to saveFile, which stores a Blob as-is. Reading an ArrayBuffer here forced
      // a `new Blob([content])` copy at the call site and cost a second full-size
      // allocation of every media file — fatal on large PDFs on low-end Android.
      const content = await response.blob();
      const etag = response.headers.get("etag")?.replace(/"/g, "");
      return { content, etag, releaseBudget: release };
    } catch (e) {
      release();
      throw e;
    }
  }

  const content = await response.text();
  const etag = response.headers.get("etag")?.replace(/"/g, "");
  return { content, etag };
}

/**
 * File operations on the user's own tree for the sharing module (root guard,
 * share discovery), over Basic auth through the Tauri client. Their semantics
 * are shared with the Nextcloud app build (sharing/davOps.js).
 * @returns {import("./sharing/sharedRoots.js").DavOps}
 */
export function createDavOps() {
  return createSharingDavOps({
    async request(method, path, { headers = {}, body, destination } = {}) {
      const { authHeader, fileUrl } = await getDavAccount();
      return _fetch(fileUrl(path), {
        method,
        headers: {
          Authorization: authHeader,
          "Cache-Control": "no-cache",
          ...(destination ? { Destination: fileUrl(destination) } : {}),
          ...headers,
        },
        body,
      });
    },
    mkcol: async (path) => {
      await createFolder(path);
    },
  });
}

// ─── What one sync pass may do (DESIGN §5.4, §5.5) ────────────────────────────
// The own tree is the user's. A notebook shared with this user is the sharer's
// folder: it exists by definition, and the share grants at most READ, UPDATE and
// CREATE, never DELETE. Every difference between the two kinds of pass is stated
// here once; the engine asks these rules rather than "is this a share?".

/**
 * @typedef {object} PassRules
 * @property {boolean} repairTree - create missing folders, re-upload a missing
 *   notebook file, heal legacy media. Never in a share: its folders are the
 *   sharer's, and the sharer's client repairs its own tree.
 * @property {boolean} deleteRemote - purge notes and notebooks, move notes away
 *   (deletes the old file, writes a tombstone), clean up orphaned media. All need
 *   DELETE, which a share never grants.
 * @property {boolean} upload - send local changes at all. Not with a read-only
 *   share: local changes are stranded instead, and the remote copy is not
 *   applied over them.
 * @property {boolean} resurrectPurged - a note purged remotely but edited locally
 *   is uploaded again. In a share the owner's purge wins and the edit is stranded.
 */

/** @type {PassRules} The user's own tree: everything is allowed. */
const OWN_TREE_RULES = Object.freeze({
  repairTree: true,
  deleteRemote: true,
  upload: true,
  resurrectPurged: true,
});

/**
 * @param {{canEdit: boolean}|null} shared - the notebook shared with this user, or null for the own tree
 * @returns {PassRules}
 */
function passRules(shared) {
  if (!shared) return OWN_TREE_RULES;
  return Object.freeze({
    repairTree: false,
    deleteRemote: false,
    upload: Boolean(shared.canEdit),
    resurrectPurged: false,
  });
}

/**
 * Sync media files for a note (Upload)
 * Ensures all binary files referenced in the note are uploaded to Nextcloud
 * Uses parallel uploads for efficiency
 * @param {Object} note
 * @param {{rules?: PassRules}} [options]
 */
async function syncNoteMedia(note, { rules = OWN_TREE_RULES } = {}) {
  // When the note is locally encrypted, media is stored as an encrypted blob —
  // media files were already uploaded when the note was last synced unencrypted,
  // and the encrypted payload references them by fileId inside the blob.
  if (note.media !== undefined && !Array.isArray(note.media)) return true;
  const hasRecordings = Array.isArray(note.recordings) && note.recordings.length > 0;
  if ((!note.media || note.media.length === 0) && !note.pdfSource && !hasRecordings) return true;

  const mediaFolder = getNoteMediaFolder(note.id, note.notebookId);

  // Ensure the full folder chain exists. createFolder(mediaFolder) gets a
  // 409 Conflict if any parent is missing, so we create parents first.
  // createFolder handles 405 (already exists) so these calls are always safe.
  // A shared notebook's folders belong to its owner and already exist: creating
  // them from here would mean writing outside what the share granted.
  if (rules.repairTree) {
    if (note.notebookId) {
      await createFolder(getNotebookFolder(note.notebookId));
      await createFolder(getNotebookNotesFolder(note.notebookId));
    } else {
      await createFolder(`${ROOT_FOLDER}/quickNotes`);
    }
  }
  await createFolder(mediaFolder);

  // Get list of existing files on server to avoid unnecessary uploads
  let remoteFiles = [];
  try {
    remoteFiles = await listFiles(mediaFolder);
  } catch (_e) {
    // Ignore error if folder is empty/new
  }
  const remoteNames = new Set(remoteFiles.map((f) => f.name));

  // Prepare upload tasks for items that need uploading.
  // Deduplicate by fileId up front — pdf-page items all share the same fileId
  // (the PDF binary), so we must not fetch/upload it 500 times.
  const uploadTasks = [];
  const seenIds = new Set();
  const itemsToSync = [];
  for (const item of note.media || []) {
    if (item.fileId && !seenIds.has(item.fileId)) {
      seenIds.add(item.fileId);
      itemsToSync.push(item);
    }
  }
  if (note.pdfSource && !seenIds.has(note.pdfSource)) {
    seenIds.add(note.pdfSource);
    itemsToSync.push({ fileId: note.pdfSource, id: "pdf-source" });
  }
  for (const rec of note.recordings || []) {
    if (!rec.deleted && rec.fileId && !seenIds.has(rec.fileId)) {
      seenIds.add(rec.fileId);
      itemsToSync.push({ fileId: rec.fileId, id: rec.id });
    }
  }

  for (const item of itemsToSync) {
    const fileId = item.fileId;
    if (!fileId) continue;

    // Get file from local storage
    const blob = await getFile(fileId);
    if (!blob) {
      console.warn(`[Sync] Local file not found for media item ${item.id} (fileId: ${fileId})`);
      continue;
    }

    // Determine filename
    const ext = extFromMime(blob.type);
    const filename = `${fileId}${ext}`;

    // Queue upload if not exists on server
    if (!remoteNames.has(filename)) {
      uploadTasks.push({ filename, blob, path: `${mediaFolder}/${filename}` });
    }
  }

  // Upload in parallel batches
  if (uploadTasks.length > 0) {
    const MEDIA_UPLOAD_CONCURRENCY = 3;
    const uploadResults = await runInBatches(
      uploadTasks,
      MEDIA_UPLOAD_CONCURRENCY,
      async (task) => {
        try {
          console.log(`[Sync] Uploading media file: ${task.filename}`);
          await uploadFile(task.path, task.blob);
          return { success: true, filename: task.filename };
        } catch (error) {
          console.error(`[Sync] Failed to upload media file ${task.filename}:`, error);
          return { success: false, filename: task.filename, error };
        }
      },
    );
    const anyFailed = uploadResults.some((r) => !r.success);
    if (anyFailed) return false;
  }
  return true;
}

/**
 * Clean up orphaned media files from Nextcloud
 * Deletes files in the media folder that are no longer referenced by the note
 * @param {Object} note - Note with media array and deletedMedia array
 */
async function cleanupOrphanedMedia(note) {
  // Cannot determine which media is orphaned when fields are encrypted blobs.
  if (note.media !== undefined && !Array.isArray(note.media)) return;
  const mediaFolder = getNoteMediaFolder(note.id, note.notebookId);

  // Get list of files currently on server
  let remoteFiles = [];
  try {
    remoteFiles = await listFiles(mediaFolder);
  } catch (_e) {
    // Folder doesn't exist, nothing to clean up
    return;
  }

  if (remoteFiles.length === 0) return;

  // Build set of valid fileIds that should exist
  const validFileIds = new Set();
  if (note.media) {
    for (const item of note.media) {
      if (item.fileId) validFileIds.add(item.fileId);
    }
  }
  if (note.pdfSource) {
    validFileIds.add(note.pdfSource);
  }
  if (Array.isArray(note.recordings)) {
    for (const rec of note.recordings) {
      if (!rec.deleted && rec.fileId) validFileIds.add(rec.fileId);
    }
  }

  // Find orphaned files (files on server not referenced in note.media)
  const orphanedFiles = remoteFiles.filter((file) => {
    // Extract fileId from filename (filename format: {fileId}.{ext})
    const dotIndex = file.name.lastIndexOf(".");
    const fileId = dotIndex > 0 ? file.name.substring(0, dotIndex) : file.name;
    return !validFileIds.has(fileId);
  });

  // Delete orphaned files
  if (orphanedFiles.length > 0) {
    console.log(
      `[Sync] Cleaning up ${orphanedFiles.length} orphaned media files for note ${note.id}`,
    );
    for (const file of orphanedFiles) {
      try {
        await deleteFile(`${mediaFolder}/${file.name}`);
        console.log(`[Sync] Deleted orphaned media file: ${file.name}`);
      } catch (error) {
        console.warn(`[Sync] Failed to delete orphaned media file ${file.name}:`, error);
      }
    }
  }
}

/**
 * Download media files for a note that are missing locally.
 * Returns a Set of fileIds that were expected but not found on the server,
 * so callers can mark the note for re-upload (self-healing).
 */
async function downloadNoteMedia(note, preloadedRemoteFiles = null) {
  if (note.media !== undefined && !Array.isArray(note.media)) {
    console.warn(
      `[Sync] Media check skipped for note ${note.id}: media is not an array (${typeof note.media}) — still encrypted?`,
    );
    return new Set();
  }
  const hasRecordings = Array.isArray(note.recordings) && note.recordings.some((r) => !r.deleted);

  if ((!note.media || note.media.length === 0) && !note.pdfSource && !hasRecordings) {
    console.log(
      `[Sync] Media check for note ${note.id}: nothing to fetch (media=${note.media?.length ?? 0} pdfSource=${Boolean(note.pdfSource)} recordings=${Array.isArray(note.recordings) ? note.recordings.length : typeof note.recordings})`,
    );
    return new Set();
  }

  const mediaFolder = getNoteMediaFolder(note.id, note.notebookId);
  let remoteFiles = preloadedRemoteFiles;

  // Collect unique file IDs (media items + pdfSource + recordings).
  // pdf-page items all share the same fileId (the PDF binary) — deduplicate
  // up front so we never iterate 500 items to do a single checkFileExists.
  const seenIds = new Set();
  const itemsToDownload = [];
  for (const item of note.media || []) {
    if (item.fileId && !seenIds.has(item.fileId)) {
      seenIds.add(item.fileId);
      itemsToDownload.push(item);
    }
  }
  if (note.pdfSource && !seenIds.has(note.pdfSource)) {
    seenIds.add(note.pdfSource);
    itemsToDownload.push({ fileId: note.pdfSource });
  }
  for (const rec of note.recordings || []) {
    if (!rec.deleted && rec.fileId && !seenIds.has(rec.fileId)) {
      seenIds.add(rec.fileId);
      itemsToDownload.push({ fileId: rec.fileId });
    }
  }

  const missingOnServer = new Set();

  console.log(
    `[Sync] Media check for note ${note.id}: ${itemsToDownload.length} file id(s) referenced`,
  );

  for (const item of itemsToDownload) {
    const fileId = item.fileId;
    if (!fileId) continue;

    // Check if file exists locally
    const existing = await checkFileExists(fileId);
    if (existing) continue;
    console.log(`[Sync] Media check: note ${note.id} is missing ${fileId} locally — fetching`);

    // Need to find the remote filename. It should be fileId + extension.
    // Since we don't store the extension in the note JSON explicitly in all versions,
    // we list the folder once to find the matching file.
    if (!remoteFiles) {
      try {
        remoteFiles = await listFiles(mediaFolder);
      } catch (e) {
        console.warn(`[Sync] Failed to list media folder ${mediaFolder}:`, e);
        return missingOnServer; // Stop if folder doesn't exist
      }
    }

    const remoteFile = remoteFiles.find((f) => f.name.startsWith(fileId));
    if (remoteFile) {
      console.log(`[Sync] Downloading media file: ${remoteFile.name}`);
      // Download as binary. releaseBudget is held until the blob is persisted,
      // so the in-flight cap covers the whole lifetime of the payload in memory.
      const { content, releaseBudget } = await downloadFile(
        `${mediaFolder}/${remoteFile.name}`,
        true,
      );

      try {
        if (content) {
          // Infer mime type from extension — the server's Content-Type is often
          // application/octet-stream for WebDAV GETs. blob.slice() retypes without
          // copying the payload (it shares the same underlying blob data), unlike
          // `new Blob([arrayBuffer])`, which duplicated the whole file in memory.
          const ext = remoteFile.name.substring(remoteFile.name.lastIndexOf("."));
          const mime = mimeFromExt(ext);
          const blob = content.type === mime ? content : content.slice(0, content.size, mime);
          await saveFile(blob, fileId);
        }
      } finally {
        releaseBudget?.();
      }
    } else {
      console.warn(
        `[Sync] Media file ${fileId} not found in remote folder ${mediaFolder} (${remoteFiles.length} file(s) listed) — note ${note.id} needs re-upload`,
      );
      missingOnServer.add(fileId);
    }
  }

  return missingOnServer;
}

/**
 * The shared notebook's root folder is gone or no longer readable (404/403): the
 * share was revoked, the owner deleted the notebook, or the mount moved. Nothing
 * may be classified, uploaded or healed when this happens.
 */
export class SharedRootMissingError extends Error {
  constructor(path, status) {
    super(`Shared notebook root ${path} is not available (${status})`);
    this.name = "SharedRootMissingError";
    this.path = path;
    this.status = status;
  }
}

/**
 * Fetch the state of all files below `rootPath` (PROPFIND Depth: infinity)
 * Returns a flat list of all files with their ETags and modification times.
 *
 * @param {string} [rootPath] - ROOT_FOLDER for the own tree, or a shared notebook's base
 * @param {object} [options]
 * @param {boolean} [options.requireRoot] - a missing root throws SharedRootMissingError
 *   instead of reading as an empty tree (shared roots must never read as "empty")
 */
async function fetchRemoteState(rootPath = ROOT_FOLDER, { requireRoot = false } = {}) {
  const { authHeader, fileUrl } = await getDavAccount();

  const ownTree = rootPath === ROOT_FOLDER;
  const response = await _fetch(fileUrl(rootPath), {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader,
      Depth: "infinity", // Get everything recursively
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...ownerBody(ownTree).headers,
    },
    body: ownerBody(ownTree).body,
  });

  if (response.status === 404) {
    if (requireRoot) throw new SharedRootMissingError(rootPath, 404);
    return []; // Root folder doesn't exist
  }

  // Stock Nextcloud ships with `dav.propfind.depth_infinity` disabled and answers
  // Depth: infinity with 400 — fall back to walking the tree with Depth: 1.
  if (response.status === 400 || response.status === 403 || response.status === 501) {
    console.warn(
      `[Sync] PROPFIND Depth: infinity rejected (${response.status}) — falling back to per-folder listing`,
    );
    return rootPath === ROOT_FOLDER
      ? fetchRemoteStateShallow()
      : walkNotebookRoot(rootPath, { requireRoot });
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch remote state: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const allItems = parseWebDAVResponse(text, false); // false = don't include collections (folders)

  // Strip the DAV files prefix (whatever case the server reports the uid in) and
  // keep only what lies inside the root, compared by whole path segments.
  const items = allItems
    .map((item) => ({
      ...item,
      path: davHrefToPath(item.href), // e.g. /NoteBerg/notebooks/...
    }))
    .filter((item) => isPathWithin(item.path, rootPath));
  return ownTree ? await excludeForeign(items) : items;
}

/**
 * Ask which user owns each item. Only needed (and only sent) for the own tree
 * once sharing is on: anything below /NoteBerg that belongs to someone else is a
 * share mounted there, not this user's data.
 */
function ownerBody(ownTree) {
  return isForeignGuardActive() && ownTree
    ? { headers: { "Content-Type": "application/xml" }, body: OWNER_PROPFIND_BODY }
    : { headers: {}, body: undefined };
}

/** Items of the own tree that belong to another user (shares mounted inside it) are not ours to sync. */
async function excludeForeign(items) {
  if (!isForeignGuardActive()) return items;
  // Only a confirmed ID may declare items foreign: a guessed one that is wrong
  // would declare the whole own tree someone else's
  const { uid: currentUid, confirmed } = await getCurrentUserIdentity();
  const uid = confirmed ? currentUid.toLowerCase() : null;
  return items.filter((item) => !item.ownerId || !uid || item.ownerId.toLowerCase() === uid);
}

/**
 * List one notebook folder with Depth: 1 requests: its own files and its notes.
 * Media folders are intentionally NOT walked (see fetchRemoteStateShallow).
 * @param {string} base - the notebook folder, under the own tree or a shared mount
 */
async function walkNotebookRoot(base, { requireRoot = false } = {}) {
  const items = [];
  const addFiles = (folder, files) => {
    for (const f of files) items.push({ ...f, path: `${folder}/${f.name}` });
  };
  addFiles(base, await listFiles(base, { requireRoot }));
  addFiles(`${base}/notes`, await listFiles(`${base}/notes`));
  return items;
}

/**
 * Fallback for servers that reject PROPFIND Depth: infinity.
 * Walks the known folder layout with Depth: 1 requests:
 *   /NoteBerg/notebooks            → global tombstone + notebook folders
 *   /NoteBerg/notebooks/{id}       → _notebook.json, _tombstones.json
 *   /NoteBerg/notebooks/{id}/notes → note JSONs
 *   /NoteBerg/quickNotes           → quick note JSONs + tombstone
 * Media folders are intentionally NOT walked — downloadNoteMedia lists them on
 * demand for notes that are missing binaries. The only degradation is that the
 * missing-media check for *unchanged* notes is skipped in this mode.
 */
async function fetchRemoteStateShallow() {
  const items = [];
  const addFiles = (folder, files) => {
    for (const f of files) {
      items.push({ ...f, path: `${folder}/${f.name}` });
    }
  };

  const notebooksFolder = `${ROOT_FOLDER}/notebooks`;
  addFiles(notebooksFolder, await listFiles(notebooksFolder));

  const notebookFolders = await listFolders(notebooksFolder);
  await runInBatches(notebookFolders, 5, async (nb) => {
    items.push(...(await walkNotebookRoot(`${notebooksFolder}/${nb.name}`)));
  });

  const quickNotesFolder = `${ROOT_FOLDER}/quickNotes`;
  addFiles(quickNotesFolder, await listFiles(quickNotesFolder));

  return excludeForeign(items);
}

/**
 * List files in a folder using WebDAV PROPFIND
 */
export async function listFiles(path, { requireRoot = false } = {}) {
  const { authHeader, fileUrl } = await getDavAccount();

  const owned = ownerBody(isPathWithin(path, ROOT_FOLDER));
  const response = await _fetch(fileUrl(path), {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader,
      Depth: "1",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...owned.headers,
    },
    body: owned.body,
  });

  if (response.status === 404 || (requireRoot && response.status === 403)) {
    if (requireRoot) throw new SharedRootMissingError(path, response.status);
    return []; // Folder doesn't exist
  }

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return parseWebDAVResponse(text, false); // false = don't include collections (folders)
}

// ─── The open note, on its own (liveNoteSync.js) ─────────────────────────────
// While a note is open and the user writes, it is synced by itself: these are
// its requests. The main thread only moves strings; parsing, merging and saving
// happen in the storage worker (review P4, 4.3).

/**
 * The etag of one file on the server (a Depth:0 PROPFIND), or null when it is not there.
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function remoteFileEtag(path) {
  const { authHeader, fileUrl } = await getDavAccount();
  const response = await _fetch(fileUrl(path), {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader,
      Depth: "0",
      "Content-Type": "application/xml",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to look at ${path}: ${response.status}`);
  const xml = await response.text();
  const raw = xml.match(/<(?:[\w-]+:)?getetag[^>]*>([^<]*)</i)?.[1];
  if (!raw) {
    console.warn(
      `[LiveSync] No etag in the answer for ${path}: ${response.status} ${xml.slice(0, 300)}`,
    );
  }
  return raw
    ? raw
        .replace(/&quot;/g, "")
        .replace(/"/g, "")
        .trim() || null
    : null;
}

/** A note file's text as stored on the server, with its etag; content null when it is not there. */
export function downloadNoteText(path) {
  return downloadFile(path);
}

/**
 * Upload a note file prepared elsewhere (already JSON), conditionally on `ifMatch`.
 * @returns {Promise<string>} the new etag; throws with status 412 when the server moved on
 */
export function uploadNoteText(path, body, modified, ifMatch) {
  return uploadFile(path, body, modified, ifMatch);
}

/**
 * Check whether the server has note changes that the local client hasn't seen yet.
 * Uses a single Depth:1 PROPFIND against the notebook's notes folder — cheap, no content download.
 * @param {string|null} notebookId - Notebook to check, or null for quick notes
 * @param {Array<{id: string, lastSyncedEtag: string|null}>} localNotes - Local note index stubs
 * @returns {Promise<boolean>} true if at least one remote note etag differs from local
 */
export async function hasRemoteChanges(notebookId, localNotes) {
  if (!(await isAuthenticated())) return false;
  // Nothing left to look at, and asking would fail (and warn) on every live check
  if (notebookId && isShareEnded(notebookId)) return false;

  try {
    const folder = notebookId ? getNotebookNotesFolder(notebookId) : `${ROOT_FOLDER}/quickNotes`;

    const remoteFiles = await listFiles(folder);
    const localEtagMap = new Map(localNotes.map((n) => [n.id, n.lastSyncedEtag]));

    for (const file of remoteFiles) {
      if (!file.name.endsWith(".json")) continue;
      const noteId = file.name.slice(0, -5);
      // undefined !== etag catches new remote notes local doesn't know about
      if (localEtagMap.get(noteId) !== file.etag) return true;
    }
    return false;
  } catch (e) {
    console.warn("[Sync] hasRemoteChanges check failed, assuming no changes:", e);
    return false;
  }
}

/**
 * List folders in a folder using WebDAV PROPFIND
 */
export async function listFolders(path) {
  const { authHeader, fileUrl } = await getDavAccount();

  const owned = ownerBody(isPathWithin(path, ROOT_FOLDER));
  const response = await _fetch(fileUrl(path), {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader,
      Depth: "1",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...owned.headers,
    },
    body: owned.body,
  });

  if (response.status === 404) {
    return []; // Folder doesn't exist
  }

  if (!response.ok) {
    throw new Error(`Failed to list folders: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const allItems = parseWebDAVResponse(text, true); // true = include collections

  // Filter to only return collections (folders)
  return allItems.filter((item) => item.isCollection);
}

/**
 * Extract the text content of the first occurrence of a namespaced XML tag
 * within a string block. Works without DOMParser (safe in Web Workers).
 */
function xmlText(block, localName) {
  // Match both namespace-prefixed (d:tag, D:tag) and unprefixed variants
  const re = new RegExp(`<[^:>]*:?${localName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${localName}>`, "i");
  return block.match(re)?.[1]?.trim() ?? null;
}

/**
 * Parse WebDAV XML response without DOMParser (compatible with Web Workers).
 * Splits on <d:response> blocks and extracts the fields we need via lightweight regex.
 */
function parseWebDAVResponse(rawXml, includeCollections = false) {
  const files = [];

  // Split into per-resource blocks. Handle both prefixed (d:response) and unprefixed.
  const responseBlocks = rawXml.split(/<\/?[^:>]*:?response>/i).filter((_, i) => i % 2 === 1);

  for (let i = 0; i < responseBlocks.length; i++) {
    const block = responseBlocks[i];

    const href = xmlText(block, "href");
    if (!href) continue;

    const resourceTypeBlock =
      block.match(/<[^:>]*:?resourcetype[^>]*>([\s\S]*?)<\/[^:>]*:?resourcetype>/i)?.[1] ?? "";
    const isCollection = /<[^:>]*:?collection[^>]*\/?>/i.test(resourceTypeBlock);
    const lastModified = xmlText(block, "getlastmodified");
    const etag = xmlText(block, "getetag");
    // Only present when the request asked for it (see ownerBody)
    const ownerId = xmlText(block, "owner-id");

    // Extract filename/foldername from href
    const name = decodeURIComponent(
      href
        .split("/")
        .filter((p) => p)
        .pop(),
    );

    // Skip if it's a collection and we don't want collections
    if (isCollection && !includeCollections) {
      continue;
    }

    // Skip the parent directory (empty name or just the path itself)
    if (!name || (href.endsWith("/") && i === 0)) {
      continue;
    }

    files.push({
      name,
      href,
      isCollection,
      lastModified: lastModified ? new Date(lastModified).getTime() : null,
      etag: etag?.replace(/&quot;/g, "").replace(/"/g, ""),
      ownerId,
    });
  }

  return files;
}

/**
 * Delete a file from Nextcloud using WebDAV
 */
async function deleteFile(path) {
  const { authHeader, fileUrl } = await getDavAccount();

  const response = await _fetch(fileUrl(path), {
    method: "DELETE",
    headers: {
      Authorization: authHeader,
    },
  });

  if (response.status === 404) {
    return true; // File doesn't exist, consider it deleted
  }

  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to delete file: ${response.status} ${response.statusText}`);
  }

  return true;
}

/**
 * Read-modify-write a remote tombstone with optimistic concurrency.
 * Re-reads the tombstone and re-applies `mutate` on every attempt, uploading
 * with If-Match (or If-None-Match: * when creating) so a concurrent writer on
 * another device causes a 412 retry instead of having its entries silently
 * overwritten (lost entries make deleted notes resurrect).
 * A tombstone that exists but fails to parse aborts the operation — replacing
 * it with an empty one would wipe the deletion history.
 * @param {string} tombstonePath
 * @param {Function} mutate - (tombstone) => void, applied to the freshly-read tombstone
 */
async function updateRemoteTombstone(tombstonePath, mutate) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    const { content, etag } = await downloadFile(tombstonePath);
    const tombstone = content ? JSON.parse(content) : createEmptyTombstone();
    mutate(tombstone);
    cleanupOldTombstones(tombstone);
    try {
      await uploadFile(tombstonePath, JSON.stringify(tombstone, null, 2), null, etag, {
        requireAbsent: !etag,
      });
      return;
    } catch (e) {
      if (e.status !== 412 || attempt >= MAX_ATTEMPTS) throw e;
      // Lost the race against another device — re-read and retry
      console.warn(`[Sync] Tombstone ${tombstonePath} changed concurrently, retrying update`);
    }
  }
}

/**
 * Purge a batch of items remotely: delete files FIRST, then record the ids in
 * the tombstone, then clean up local stubs — each step only for items whose
 * deletion succeeded (prevents data loss if the tombstone write succeeds but
 * the deletion fails). Shared by syncNotebooks and syncNotes.
 * @returns {Array} per-item results tagged with action:"purge"
 */
async function purgeRemoteItems(
  items,
  { deleteRemote, tombstonePath, addTombstone, cleanupLocal },
) {
  const deleteResults = await runInBatches(items, 5, async (item) => {
    try {
      await deleteRemote(item);
      return { success: true, id: item.id, action: "purge" };
    } catch (e) {
      console.error(`[Sync] Failed to delete purged item ${item.id}:`, e);
      return { success: false, id: item.id, error: e.message, action: "purge" };
    }
  });

  const succeeded = deleteResults.filter((r) => r.success);
  if (succeeded.length > 0) {
    await updateRemoteTombstone(tombstonePath, (tombstone) => {
      for (const r of succeeded) addTombstone(tombstone, r.id);
    });
    for (const r of succeeded) await cleanupLocal(r.id);
  }
  return deleteResults;
}

/**
 * Aggregate per-item batch results into the summary shape returned by
 * syncNotebooks/syncNotes. Successful purges count neither as uploads nor failures.
 */
async function aggregateSyncResults(batchResults) {
  const results = { uploaded: 0, failed: 0, errors: [], uploadedIds: [], metadata: {} };
  for (const res of batchResults) {
    if (!res.success) {
      results.failed++;
      results.errors.push({ id: res.id, error: res.error });
      continue;
    }
    if (res.action === "purge") continue;
    results.uploaded++;
    results.uploadedIds.push(res.id);
    results.metadata[res.id] = {
      etag: typeof res.etag === "string" ? res.etag : null,
      // Text the server now holds (notes only) — becomes the next merge baseline
      baseContent: res.baseContent,
    };
    // Clear previousNotebookId now that the move has been synced to Nextcloud
    if (res.hadPreviousLocation) await clearNoteMoveFlag(res.id);
  }
  return results;
}

/**
 * Ensure all required folders for hierarchical structure exist
 */
async function ensureHierarchicalStructure() {
  const folders = getAllRequiredFolders();
  for (const folder of folders) {
    await createFolder(folder);
  }
}

/**
 * Sync notebooks to Nextcloud (hierarchical structure)
 * @param {Array} notebooks
 * @param {{rules?: PassRules}} [options] - what the pass may do (a share: no folders, no purges)
 */
export async function syncNotebooks(notebooks, { rules = OWN_TREE_RULES } = {}) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  // Ensure hierarchical folder structure exists
  if (rules.repairTree) await ensureHierarchicalStructure();

  // Separate purged notebooks from active ones
  const purgedNotebooks = rules.deleteRemote ? notebooks.filter((n) => n.purged) : [];
  const activeNotebooks = notebooks.filter((n) => !n.purged);
  const purgedResults = [];

  if (purgedNotebooks.length > 0) {
    try {
      purgedResults.push(
        ...(await purgeRemoteItems(purgedNotebooks, {
          deleteRemote: (nb) => {
            console.log(`[Sync] Deleting remote notebook ${nb.id}`);
            return deleteRemoteNotebook(nb.id);
          },
          tombstonePath: getGlobalNotebookTombstonePath(),
          addTombstone: addNotebookTombstone,
          cleanupLocal: async (id) => {
            await permanentlyDeleteNotesInNotebook(id);
            await permanentlyDeleteNotebook(id);
          },
        })),
      );
    } catch (error) {
      console.error("[Sync] Failed to process purged notebooks:", error);
    }
  }

  const CONCURRENCY = 5;

  const uploadResults = await runInBatches(activeNotebooks, CONCURRENCY, async (notebook) => {
    try {
      if (rules.repairTree) {
        // Create notebook folder
        await createFolder(getNotebookFolder(notebook.id));

        // Create notes subfolder
        await createFolder(getNotebookNotesFolder(notebook.id));
      }

      // Upload notebook metadata
      const path = getNotebookPath(notebook.id);
      const syncedNotebook = {
        // Sharing fields describe this user's relationship to the notebook; the
        // file is the notebook's, shared with every collaborator
        ...stripLocalFields(notebook),
        synced: true,
        // Keep original modified timestamp to preserve history
      };
      const content = JSON.stringify(syncedNotebook, null, 2);

      const etag = await uploadFile(
        path,
        content,
        syncedNotebook.modified,
        notebook.lastSyncedEtag,
      );
      return { success: true, id: notebook.id, etag };
    } catch (error) {
      console.error(`Failed to sync notebook ${notebook.id}:`, error);
      return { success: false, id: notebook.id, error: error.message };
    }
  });

  return aggregateSyncResults([...purgedResults, ...uploadResults]);
}

/**
 * Sync notes to Nextcloud (hierarchical structure)
 * @param {Array} notes
 * @param {{rules?: PassRules}} [options] - what the pass may do. In a share writes stay
 *   inside what it grants: no folders outside the media folder are created, and
 *   nothing is deleted (no purges, no moves, no orphaned-media cleanup).
 */
export async function syncNotes(notes, { rules = OWN_TREE_RULES } = {}) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  // Ensure hierarchical folder structure exists
  if (rules.repairTree) await ensureHierarchicalStructure();

  // Separate purged notes from active notes
  const purgedNotes = rules.deleteRemote ? notes.filter((n) => n.purged) : [];
  const activeNotes = notes.filter((n) => !n.purged);
  const purgedResults = [];

  // Process purged notes grouped by notebook to avoid tombstone race conditions
  // Delete files FIRST, then update tombstone to prevent data loss
  if (purgedNotes.length > 0) {
    const byNotebook = {};
    for (const note of purgedNotes) {
      const key = note.notebookId || "quickNotes";
      if (!byNotebook[key]) byNotebook[key] = [];
      byNotebook[key].push(note);
    }

    for (const [key, groupNotes] of Object.entries(byNotebook)) {
      const notebookId = key === "quickNotes" ? null : key;
      const tombstonePath = notebookId
        ? getNotebookTombstonePath(notebookId)
        : getQuickNotesTombstonePath();

      try {
        purgedResults.push(
          ...(await purgeRemoteItems(groupNotes, {
            deleteRemote: async (note) => {
              await deleteFile(getNotePath(note.id, note.notebookId));
              // Ignore if media folder doesn't exist
              await deleteFile(getNoteMediaFolder(note.id, note.notebookId)).catch(() => {});
            },
            tombstonePath,
            addTombstone: addNoteTombstone,
            cleanupLocal: async (id) => {
              await permanentlyDeleteNote(id);
              console.log(`[Sync] Purged note ${id} completely`);
            },
          })),
        );
      } catch (error) {
        console.error(`[Sync] Failed to process purged notes group for ${key}:`, error);
        // Mark all in group as failed
        for (const note of groupNotes) {
          purgedResults.push({
            success: false,
            id: note.id,
            error: error.message,
            action: "purge",
          });
        }
      }
    }
  }

  const CONCURRENCY = 5;

  // Pre-process moves: group by old notebook so the tombstone read-modify-write
  // for each source location is done serially, preventing concurrent overwrites
  // that would drop tombstone entries and cause ghost notes on other devices.
  const movedNotes = rules.deleteRemote
    ? activeNotes.filter((n) => n.previousNotebookId !== undefined)
    : [];
  if (movedNotes.length > 0) {
    // Group by old notebook key
    const byOldNotebook = {};
    for (const note of movedNotes) {
      const key = note.previousNotebookId ?? "quickNotes";
      if (!byOldNotebook[key]) byOldNotebook[key] = [];
      byOldNotebook[key].push(note);
    }

    for (const [key, groupNotes] of Object.entries(byOldNotebook)) {
      const oldNotebookId = key === "quickNotes" ? null : key;
      const tombstonePath = oldNotebookId
        ? getNotebookTombstonePath(oldNotebookId)
        : getQuickNotesTombstonePath();

      // Delete old files concurrently (each is an independent path — no collision risk)
      await runInBatches(groupNotes, CONCURRENCY, async (note) => {
        const oldNotePath = getNotePath(note.id, oldNotebookId);
        const oldMediaFolder = getNoteMediaFolder(note.id, oldNotebookId);
        await deleteFile(oldNotePath).catch(() => {});
        await deleteFile(oldMediaFolder).catch(() => {});
      });

      // Write tombstone once for the whole group. If this fails the move still
      // completes (note uploads to its new location); only the old-location
      // cleanup marker is missing, so log and continue rather than abort the sync.
      try {
        await updateRemoteTombstone(tombstonePath, (tombstone) => {
          for (const note of groupNotes) {
            addNoteTombstone(tombstone, note.id);
          }
        });
      } catch (e) {
        console.error(`[Sync] Failed to write move tombstone ${tombstonePath}:`, e);
      }

      console.log(
        `[Sync] Cleaned up ${groupNotes.length} moved note(s) from ${key}: ${groupNotes.map((n) => n.id).join(", ")}`,
      );
    }
  }

  const uploader = await getCurrentUserId();
  const uploadResults = await runInBatches(activeNotes, CONCURRENCY, async (note) => {
    try {
      // Get the correct path based on whether note is in a notebook or is a quick note
      const path = getNotePath(note.id, note.notebookId);

      // Log id/path only — never the title (note content must not leak to logs).
      console.log(`Uploading note ${note.id} to ${path}`);

      const syncedNote = {
        ...note,
        synced: true,
        // Keep original modified timestamp to preserve history
      };

      // Decrypt local encryption before syncing media — syncNoteMedia needs a plain media array.
      // decryptNoteFields is a no-op when note.encrypted is falsy.
      const decrypted = await decryptNoteFields(syncedNote);
      let decryptedNote = decrypted.note;
      if (decrypted.failed.length > 0) {
        decryptedNote = await fillUndecryptableFieldsFromServer(
          decryptedNote,
          decrypted.failed,
          path,
        );
        if (!decryptedNote) {
          return { success: false, id: note.id, error: "server copy unavailable" };
        }
        // Heal the local copy too: saveNote re-encrypts the recovered fields
        // with the current key, so the next sync decrypts cleanly. modified is
        // kept, so updateNoteEtag still marks the note synced after the upload.
        await saveNote({ ...decryptedNote, synced: false });
      }

      // Sync media files (upload binaries) — must use decrypted media array.
      // If any binary fails to upload, skip the note JSON so synced stays false
      // and the next sync cycle retries (prevents NC from having a note JSON that
      // references media files that don't exist on the server yet).
      const mediaOk = await syncNoteMedia(decryptedNote, { rules });
      if (!mediaOk) {
        console.warn(`[Sync] Skipping JSON upload for note ${note.id} — media upload incomplete`);
        return { success: false, id: note.id, error: "media upload incomplete" };
      }

      // Clean up orphaned media files (deleted from note but still on server).
      // Needs DELETE, which a share never grants: the owner's client does it.
      if (rules.deleteRemote) await cleanupOrphanedMedia(decryptedNote);

      // Strip internal sync tracking fields before uploading.
      // decryptedNote is already plain — Nextcloud always receives readable JSON.
      // Attribution for the other side's merge hint (note-level, see DESIGN §10.3 F)
      const uploaded = noteForUpload(decryptedNote, uploader);

      // Prepare content
      const content = JSON.stringify(uploaded, null, 2);

      // For moved notes, the file at the new path is new — there is no existing etag to match.
      // Passing null omits the If-Match header and avoids a guaranteed 412.
      const uploadEtag = note.previousNotebookId !== undefined ? null : note.lastSyncedEtag;
      const etag = await uploadFile(path, content, syncedNote.modified, uploadEtag);
      console.log(`Successfully uploaded note ${note.id}`);

      return {
        success: true,
        id: note.id,
        etag,
        baseContent: typeof uploaded.content === "string" ? uploaded.content : undefined,
        hadPreviousLocation: note.previousNotebookId !== undefined,
      };
    } catch (error) {
      console.error(`Failed to sync note ${note.id}:`, error);
      return { success: false, id: note.id, error: error.message };
    }
  });

  return aggregateSyncResults([...purgedResults, ...uploadResults]);
}

/**
 * Download all data from Nextcloud (hierarchical structure)
 * Optimized to only download changed files based on ETags
 */
/**
 * @param {Array} localNotebooks
 * @param {Array} localNotes
 * @param {object} [options]
 * @param {{notebookId: string}} [options.shared] - read one notebook shared with this user
 *   (rooted at its registered base) instead of the own tree
 */
export async function downloadAllData(
  localNotebooks = [],
  localNotes = [],
  { shared = null } = {},
) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  console.log("[Sync] Fetching remote state...");

  // Create maps for fast lookup of local state
  const localNotebooksMap = new Map(localNotebooks.map((n) => [n.id, n]));
  const localNotesMap = new Map(localNotes.map((n) => [n.id, n]));

  const notebooks = [];
  const notes = [];
  const tombstones = new Map(); // Map of notebookId -> tombstone data

  // Step 1: Fetch all remote files in one request
  const root = shared ? getNotebookFolder(shared.notebookId) : ROOT_FOLDER;
  const remoteFiles = await fetchRemoteState(root, { requireRoot: Boolean(shared) });
  // A shared root holds exactly one notebook, so its files are read relative to it
  const parse = shared
    ? (path) => parseNotebookRelativePath(path.slice(root.length + 1), shared.notebookId)
    : parsePath;

  // Index remote media files for efficient lookup.
  // Map: noteId -> Array of { name, path }
  const remoteMediaMap = new Map();
  for (const file of remoteFiles) {
    const parsed = parse(file.path);
    if (parsed.type === "media" && parsed.noteId) {
      if (!remoteMediaMap.has(parsed.noteId)) {
        remoteMediaMap.set(parsed.noteId, []);
      }
      remoteMediaMap.get(parsed.noteId).push({
        name: parsed.filename,
        path: file.path,
      });
    }
  }

  // Lists of items to download
  const notebooksToDownload = [];
  const notesToDownload = [];
  const tombstonesToDownload = [];
  const mediaCheckQueue = []; // Notes that are unchanged but might need media checks

  // Step 2: Identify what needs downloading
  for (const file of remoteFiles) {
    const parsed = parse(file.path);

    if (parsed.type === "notebook") {
      const local = localNotebooksMap.get(parsed.notebookId);
      // Download if we don't have it or ETag changed. An unsynced shared notebook
      // also needs the owner's file: the share may no longer take the change, and
      // then that file replaces it (fullSync)
      if (!local || local.lastSyncedEtag !== file.etag || (shared && local.synced === false)) {
        notebooksToDownload.push({ ...parsed, path: file.path, etag: file.etag });
      } else {
        // Unchanged: Add stub to result so fullSync knows it exists
        notebooks.push({
          ...local,
          lastSyncedEtag: file.etag, // Ensure it matches remote
        });
      }
    } else if (parsed.type === "note") {
      const local = localNotesMap.get(parsed.noteId);
      // Download if we don't have it or ETag changed
      // Note: For notes, we compare against _currentFileEtag if available, or lastSyncedEtag
      // But local notes store the *remote* etag in lastSyncedEtag.
      if (!local || local.lastSyncedEtag !== file.etag) {
        notesToDownload.push({ ...parsed, path: file.path, etag: file.etag });
      } else {
        // Unchanged: Add stub to result
        notes.push({
          id: local.id,
          notebookId: local.notebookId,
          modified: file.lastModified, // Use remote timestamp for conflict check
          _currentFileEtag: file.etag,
          // We don't need content for unchanged notes unless there's a local conflict,
          // in which case fullSync logic handles it (local modified + remote unchanged = upload local).
        });

        // Two shapes have to pass this gate, and the old condition let neither
        // recording case through:
        //
        //  - `local` is the INDEX entry, and splitNote() strips `fileId` from
        //    the index copy of `recordings` (it keeps id/name/duration/deleted
        //    only). Requiring `r.fileId` here therefore excluded every note
        //    whose media is a recording, encrypted or not.
        //  - On a locally-encrypted note `recordings` and `media` are {data,iv}
        //    blobs rather than arrays, so the Array.isArray test failed too.
        //
        // The queue only decides whether to *look*; downloadNoteMedia re-reads
        // the full note and does the real filtering, so a false positive here
        // costs one cheap check and a false negative costs the binaries
        // permanently. Err toward looking.
        const isEncryptedBlob = (v) =>
          v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";
        const mayHaveMedia =
          (Array.isArray(local.media) && local.media.length > 0) ||
          isEncryptedBlob(local.media) ||
          (Array.isArray(local.recordings) && local.recordings.some((r) => !r.deleted)) ||
          isEncryptedBlob(local.recordings) ||
          Boolean(local.pdfSource);
        if (mayHaveMedia) {
          mediaCheckQueue.push(local);
        }
      }
    } else if (parsed.type === "tombstone") {
      // Always download tombstones for now (they are small and critical)
      tombstonesToDownload.push({ ...parsed, path: file.path });
    }
  }

  console.log(
    `[Sync] Incremental check: ${notebooksToDownload.length} notebooks, ${notesToDownload.length} notes to download.`,
  );
  for (const item of notesToDownload) {
    console.log(`[Sync] Queued for download: note=${item.noteId} path=${item.path}`);
  }

  // Step 3: Download changed items in parallel batches
  const CONCURRENCY = 5;

  // Download Notebooks
  const downloadedNotebooks = await runInBatches(notebooksToDownload, CONCURRENCY, async (item) => {
    try {
      const { content } = await downloadFile(item.path);
      if (content) {
        const notebook = JSON.parse(content);
        // The owner controls this file; it must describe the notebook it is registered as
        if (shared && notebook.id !== shared.notebookId) {
          console.warn(`[Sync] Ignoring shared notebook file claiming id ${notebook.id}`);
          return null;
        }
        notebook.lastSyncedEtag = item.etag;
        return notebook;
      }
    } catch (e) {
      console.error(`Failed to download notebook ${item.notebookId}:`, e);
    }
    return null;
  });
  notebooks.push(...downloadedNotebooks.filter((n) => n));

  // IDs of notes whose media was missing on the server — these need a re-upload
  // from the device that has the binaries locally, so we flag them synced=false.
  const notesWithMissingMedia = new Set();

  // Download Notes
  const downloadedNotes = await runInBatches(notesToDownload, CONCURRENCY, async (item) => {
    try {
      const { content } = await downloadFile(item.path);
      if (content) {
        const note = JSON.parse(content);
        // A note file of a shared notebook must be that note, in that notebook:
        // otherwise saving it would overwrite one of this user's own notes. Its id
        // also ends up in paths and markup, and another user chose it.
        if (
          shared &&
          (!isSafeId(note.id) ||
            note.id !== item.noteId ||
            (note.notebookId ?? null) !== shared.notebookId)
        ) {
          console.warn(`[Sync] Ignoring shared note file ${item.path}: id or notebook mismatch`);
          return null;
        }
        note._currentFileEtag = item.etag;
        const decrypted = await decryptNoteFromNextcloud(note);

        const missing = await downloadNoteMedia(decrypted, remoteMediaMap.get(decrypted.id));
        if (missing.size > 0) notesWithMissingMedia.add(decrypted.id);

        return decrypted;
      }
      // downloadFile returns { content: null } for a 404 rather than throwing,
      // so an empty body lands here and not in the catch below. Without this
      // the note is dropped from the download set in complete silence and the
      // sync reports "downloaded 0 notes" as though nothing was pending —
      // which is indistinguishable from there being nothing to do.
      console.error(
        `[Sync] Note ${item.noteId} was listed for download but its file is missing or empty: ${item.path}`,
      );
    } catch (e) {
      console.error(`Failed to download note ${item.noteId}:`, e);
    }
    return null;
  });

  if (downloadedNotes.filter((n) => n).length < notesToDownload.length) {
    console.warn(
      `[Sync] ${notesToDownload.length - downloadedNotes.filter((n) => n).length} of ${notesToDownload.length} queued note download(s) produced nothing — changes made on another device will not appear here.`,
    );
  }
  const keptNotes = downloadedNotes.filter((n) => n);
  console.log(
    `[Sync] Note downloads: queued=${notesToDownload.length} returned=${keptNotes.length} (ids: ${keptNotes.map((n) => n.id).join(", ") || "none"})`,
  );
  notes.push(...keptNotes);

  // Check media for unchanged notes (fix for missing images)
  // Must use getRawNote to get the full content (with fileIds) — the index stub
  // only has {id, name, type, size, deleted} with no fileId, so downloadNoteMedia
  // would skip every item and never download any binaries.
  if (mediaCheckQueue.length > 0) {
    console.log(`[Sync] Checking media for ${mediaCheckQueue.length} unchanged notes...`);
    await runInBatches(mediaCheckQueue, CONCURRENCY, async (stub) => {
      const remoteMedia = remoteMediaMap.get(stub.id);
      if (!remoteMedia || remoteMedia.length === 0) return;
      const rawNote = await getRawNote(stub.id);
      if (!rawNote) return;

      // getRawNote does NOT decrypt, so on a locally-encrypted note `media` and
      // `recordings` arrive as {data, iv} blobs rather than arrays. Every check
      // inside downloadNoteMedia is array-shaped, so it returned immediately and
      // this whole pass silently did nothing for encrypted notes — their media
      // binaries were never downloaded on any device, no matter how many times
      // the note synced. Decrypt first so the check can actually see the
      // fileIds it is meant to be looking for.
      let fullNote = rawNote;
      if (rawNote.encrypted) {
        try {
          fullNote = await decryptNoteLocally(rawNote);
        } catch (e) {
          console.warn(`[Sync] Note ${stub.id}: cannot check media, local decryption failed:`, e);
          return;
        }
      }

      const missing = await downloadNoteMedia(fullNote, remoteMedia);
      if (missing.size > 0) notesWithMissingMedia.add(stub.id);
    });
  }

  // Download Tombstones
  const downloadedTombstones = await runInBatches(
    tombstonesToDownload,
    CONCURRENCY,
    async (item) => {
      try {
        const { content } = await downloadFile(item.path);
        if (content) {
          const key = item.notebookId || "quickNotes";
          return { key, data: JSON.parse(content) };
        }
      } catch (e) {
        console.error(`Failed to download tombstone ${item.path}:`, e);
      }
      return null;
    },
  );

  downloadedTombstones.forEach((t) => {
    if (t) tombstones.set(t.key, t.data);
  });

  return { notebooks, notes, tombstones, remoteMediaMap, notesWithMissingMedia };
}

/**
 * Merge a locally-encrypted note with its remote counterpart.
 *
 * `attemptMerge` refuses encrypted notes outright, because it must also be safe
 * to call from the Web Worker, which holds no key. Both callers then fell back
 * to "local wins, remote's edits are lost" — which silently discarded whatever
 * the other device had added. For a note edited on two devices that meant one
 * side's recordings, media and strokes vanished on every sync, with no conflict
 * raised and nothing in the log.
 *
 * fullSync runs on the main thread, where the key IS available (syncNotes
 * already decrypts these same notes to upload them), so the note can be
 * decrypted first and then merged like any other. A field that cannot be
 * decrypted is taken from the remote before merging. Returns null when the app
 * is locked, leaving the caller's existing local-wins fallback in place.
 *
 * @returns {Promise<Object|null>} the merged PLAIN note, or null
 */
async function attemptMergeEncrypted(fullLocal, remote, opts) {
  if (!isAppUnlocked()) {
    console.warn(
      `[Sync] Note ${fullLocal.id}: app is locked, cannot merge encrypted note — local will win and the remote's edits will be lost.`,
    );
    return null;
  }

  let plainLocal;
  try {
    const decrypted = await decryptNoteFields(fullLocal);
    // A field this client cannot read holds no local edits (see
    // decryptNoteFields), so the remote's copy is the only one worth keeping.
    // Merged as an empty value instead, it could win against the remote's.
    plainLocal = takeFieldsFrom(decrypted.note, decrypted.failed, remote);
  } catch (e) {
    console.warn(`[Sync] Note ${fullLocal.id}: could not decrypt for merge:`, e);
    return null;
  }

  // decryptNoteFields clears `encrypted`, so attemptMerge no longer refuses.
  // The merged note is plain; saveNote re-encrypts it on the way back to disk,
  // and syncNotes uploads Nextcloud-side plain as it always has.
  return attemptMerge(plainLocal, remote, opts);
}

/**
 * Full sync: upload local changes and download remote changes
 * Uses timestamp-based conflict resolution (newer wins)
 *
 * With `shared`, syncs ONE notebook shared with this user, read from its
 * registered base instead of the own tree (DESIGN §5.3-5.5). The sharer owns that
 * folder, so the pass obeys what the share allows (see PassRules): nothing is
 * created, repaired, purged or deleted there; with a read-only share nothing is
 * uploaded, and local changes are reported in `strandedNoteIds` instead; a note
 * the sharer purged stays purged.
 * A missing root throws SharedRootMissingError before anything is classified.
 *
 * @param {Array} localNotebooks
 * @param {Array} localNotes
 * @param {object} [options]
 * @param {{notebookId: string, canEdit: boolean}} [options.shared]
 */
export async function fullSync(localNotebooks, localNotes, { shared = null } = {}) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  const rules = passRules(shared);
  // Notes whose local changes can no longer be uploaded (shared roots only)
  const stranded = new Set();

  console.log("Starting full sync...");
  console.log(`Local data: ${localNotebooks.length} notebooks, ${localNotes.length} notes`);
  console.log(`Unsynced notes: ${localNotes.filter((n) => n.synced === false).length}`);

  // Cache of full note objects loaded on demand. localNotes may contain lightweight metadata
  // stubs (no strokes/content) when called from performSync. We only fetch the full object
  // for notes that actually need to be uploaded or merged — typically just 1 note per sync.
  const fullNoteCache = new Map();
  async function getFullNote(stub) {
    if (fullNoteCache.has(stub.id)) return fullNoteCache.get(stub.id);
    // Use getRawNote (no decryption) so this is safe to call from a Web Worker.
    // The sync layer applies Nextcloud-level encryption separately in syncNotes().
    const full = await getRawNote(stub.id);
    if (full) fullNoteCache.set(stub.id, full);
    return full ?? stub; // fall back to stub if note was deleted between sync start and now
  }

  // Merge inputs: the baseline text both sides last agreed on, and who "local"
  // is, so a conflicting block can say whose version it is. A baseline that
  // cannot be read only costs the three-way merge, never the sync.
  const localAuthor = await getCurrentUserId();
  const mergeOptionsFor = async (noteId) => {
    let base = null;
    try {
      base = await getNoteBase(noteId);
    } catch (e) {
      console.warn(`[Sync] Note ${noteId}: merge baseline unavailable:`, e);
    }
    return { base, localAuthor };
  };

  // Step 1: Download remote data first
  const remoteData = await downloadAllData(localNotebooks, localNotes, { shared });

  // Step 2: Merge notebooks (newer wins)
  const notebooksToUpload = [];
  const notebooksToDownload = [];
  const notebooksToDelete = [];
  const notesToDelete = [];
  const noteEtagsToUpdate = []; // Notes whose etag changed on server but content is not newer
  // Notes saved locally as a merge with the server's version: what they show changed,
  // although nothing was downloaded (an open editor must take the merge in)
  const mergedNoteIds = [];
  const conflicts = { notebooks: [], notes: [] };

  // Self-heal: notes whose media files were missing on the server need re-upload
  // from whichever device holds the local binaries. Mark them synced=false so
  // the note-classification loop below will queue them for upload.
  if (remoteData.notesWithMissingMedia.size > 0 && rules.upload) {
    console.log(
      `[Sync] ${remoteData.notesWithMissingMedia.size} note(s) have missing remote media — marking for re-upload: ${[...remoteData.notesWithMissingMedia].join(", ")}`,
    );
    for (const noteId of remoteData.notesWithMissingMedia) {
      const stub = localNotes.find((n) => n.id === noteId);
      if (stub && stub.synced !== false) {
        await saveNote({ ...(await getFullNote(stub)), synced: false });
      }
    }
    // Refresh localNotes map so the classification loop sees the updated synced flag.
    for (const note of localNotes) {
      if (remoteData.notesWithMissingMedia.has(note.id)) {
        note.synced = false;
      }
    }
  }

  // Create maps for quick lookup
  const localNotebookMap = new Map(localNotebooks.map((n) => [n.id, n]));
  const remoteNotebookMap = new Map(remoteData.notebooks.map((n) => [n.id, n]));

  // Check which local notebooks should be uploaded
  for (const local of localNotebooks) {
    // PRIORITY: If notebook is purged locally, queue it for processing immediately.
    if (local.purged) {
      if (rules.deleteRemote) notebooksToUpload.push(local);
      continue;
    }

    const remote = remoteNotebookMap.get(local.id);

    if (!remote) {
      if (!rules.repairTree) {
        // A shared notebook's file is the sharer's: if it is missing, their
        // folder is broken and their client heals it. Never created from here.
        console.warn(`[Sync] Shared notebook ${local.id}: _notebook.json missing, skipping`);
        continue;
      }

      // Check global tombstone for deletion
      const globalTombstone = remoteData.tombstones.get("global_notebooks");
      const isDeletedRemotely = globalTombstone?.notebooks?.some((t) => t.id === local.id);

      if (isDeletedRemotely) {
        if (local.synced === false && !local.deleted) {
          // Conflict: Deleted remotely, Modified locally. Restore (re-upload).
          console.log(
            `[Sync] Notebook ${local.id} deleted remotely but modified locally. Restoring.`,
          );
          notebooksToUpload.push({ ...local, lastSyncedEtag: null });
        } else {
          console.log(`[Sync] Notebook ${local.id} deleted remotely. Deleting locally.`);
          notebooksToDelete.push(local.id);
        }
        continue;
      }

      // For notebooks, if it's missing remotely and we are synced, we usually re-upload (self-heal).
      // There isn't a global tombstone for notebooks currently.
      if (local.synced === false) {
        notebooksToUpload.push({ ...local, lastSyncedEtag: null });
      } else {
        console.log(`[Sync] Notebook ${local.id} missing on server. Re-uploading.`);
        notebooksToUpload.push({ ...local, lastSyncedEtag: null });
      }
      continue;
    }

    // A rename or recolour the share no longer accepts (the owner made it view
    // only meanwhile): the owner's version replaces it, or it would stay unsynced
    // for good and make leaving the share warn about changes that cannot be saved
    if (!rules.upload && local.synced === false) {
      notebooksToDownload.push(remote);
      continue;
    }

    // A collaborator may rename or recolor; a read-only recipient never uploads
    const isModifiedLocally = local.synced === false && rules.upload;
    const isModifiedRemotely = local.lastSyncedEtag !== remote.lastSyncedEtag;

    if (isModifiedLocally && isModifiedRemotely) {
      // Notebooks have no mergeable content (title/description/color only), so
      // resolve modified-both-sides by last-write-wins instead of surfacing a
      // conflict that nothing downstream resolves (which left the notebook
      // permanently stuck unsynced).
      if ((remote.modified || 0) > (local.modified || 0)) {
        console.log(`[Sync] Notebook ${local.id} conflict → remote is newer, downloading`);
        notebooksToDownload.push(remote);
      } else {
        // Local wins: upload using the remote's current etag as If-Match base
        console.log(`[Sync] Notebook ${local.id} conflict → local is newer, uploading`);
        notebooksToUpload.push({ ...local, lastSyncedEtag: remote.lastSyncedEtag });
      }
    } else if (isModifiedLocally) {
      notebooksToUpload.push(local);
    } else if (isModifiedRemotely) {
      notebooksToDownload.push(remote);
    }
  }

  // Check which remote notebooks should be downloaded (a shared root holds only
  // the one notebook it is registered as, which is always local)
  for (const remote of remoteData.notebooks) {
    if (!localNotebookMap.has(remote.id)) {
      notebooksToDownload.push(remote);
    }
  }

  // Step 3: Merge notes (newer wins)
  const notesToUpload = [];
  const notesToDownload = [];

  const localNoteMap = new Map(localNotes.map((n) => [n.id, n]));
  const remoteNoteMap = new Map(remoteData.notes.map((n) => [n.id, n]));

  // Check which local notes should be uploaded
  for (const local of localNotes) {
    // Nothing may be uploaded: keep the change, and do not overwrite it with the remote copy
    if (!rules.upload && local.synced === false && !local.purged) {
      stranded.add(local.id);
      continue;
    }

    // PRIORITY: If note is purged locally, queue it for processing immediately.
    // This bypasses conflict checks because purge is a final destructive action.
    if (local.purged) {
      // Deleting from a share is never allowed, so nothing is purged through one
      if (!rules.deleteRemote) continue;
      // If the parent notebook is also being purged in this sync, skip processing this note.
      // The notebook purge will delete the entire folder structure, so individual note deletion is redundant and will fail.
      const parentNotebookPurged =
        local.notebookId && notebooksToUpload.some((n) => n.id === local.notebookId && n.purged);
      if (parentNotebookPurged) {
        continue;
      }
      // Purge only needs id/notebookId — stub is sufficient, no need for full note.
      notesToUpload.push(local);
      continue;
    }

    const remote = remoteNoteMap.get(local.id);

    if (!remote) {
      // Check tombstones to see if it was deleted remotely
      const tombstoneKey = local.notebookId || "quickNotes";
      const tombstone = remoteData.tombstones.get(tombstoneKey);
      const isDeletedRemotely = tombstone?.notes?.some((t) => t.id === local.id);

      if (isDeletedRemotely) {
        if (local.synced === false && !local.deleted && !rules.resurrectPurged) {
          // The sharer purged it: an unsynced edit is stranded, not resurrected
          stranded.add(local.id);
        } else if (local.synced === false && !local.deleted) {
          // Conflict: Deleted remotely, Modified locally. Strategy: Restore (re-upload).
          console.log(
            `[Sync] Note ${local.id} was deleted remotely but modified locally. Restoring.`,
          );
          notesToUpload.push({ ...(await getFullNote(local)), lastSyncedEtag: null });
        } else {
          // Deleted remotely, no local changes. Delete locally.
          console.log(`[Sync] Note ${local.id} was deleted remotely. Deleting locally.`);
          notesToDelete.push(local.id);
        }
      } else if (rules.upload) {
        // Not in tombstone -> Missing/Corrupted -> Re-upload (Self-healing).
        // In a share CREATE covers this; a read-only share cannot heal anything.
        if (local.synced === true) {
          console.log(`[Sync] Note ${local.id} missing on server. Re-uploading.`);
        }
        notesToUpload.push({ ...(await getFullNote(local)), lastSyncedEtag: null });
      }
      continue;
    }

    const isModifiedLocally = local.synced === false;
    // A note is modified remotely if the current file etag differs from our last synced etag
    // Since we don't store lastSyncedEtag in Nextcloud JSON, we compare with _currentFileEtag
    const isModifiedRemotely = local.lastSyncedEtag !== remote._currentFileEtag;

    if (isModifiedLocally && isModifiedRemotely) {
      const fullLocal = await getFullNote(local);

      // Locally-encrypted notes cannot be merged in the worker (no decryption key).
      // Treat as "local wins": upload the local version using the remote etag as the
      // If-Match base so the PUT succeeds even though remote changed.
      if (local.restoredAt) {
        // Restored from a backup and not uploaded since. The user asked for this
        // exact version back, and a merge would re-apply the server's strokes and
        // stroke deletions on top of it, undoing the restore. Local wins outright,
        // with the remote etag as the If-Match base so the PUT succeeds. The
        // marker is cleared by updateNoteEtag once the upload lands.
        console.log(`[Sync:classify] note=${local.id} -> restored from backup, local-wins upload`);
        notesToUpload.push({ ...fullLocal, lastSyncedEtag: remote._currentFileEtag });
      } else if (local.encrypted) {
        const merged = await attemptMergeEncrypted(
          fullLocal,
          remote,
          await mergeOptionsFor(local.id),
        );
        if (merged) {
          console.log(
            `[Sync:classify] note=${local.id} → encrypted merge succeeded, uploading merged`,
          );
          notesToUpload.push({ ...merged, lastSyncedEtag: remote._currentFileEtag });
          // Save locally so this client shows the merged state immediately, and
          // so the other device's additions are not lost if the upload fails.
          // saveNote re-applies local encryption.
          await saveNote({ ...merged, synced: false });
          mergedNoteIds.push(local.id);
        } else {
          // Could not decrypt (locked, or a field written with another key):
          // fall back to the previous behaviour rather than merging blind.
          console.log(
            `[Sync:classify] note=${local.id} → encrypted local-wins upload (merge unavailable)`,
          );
          notesToUpload.push({ ...fullLocal, lastSyncedEtag: remote._currentFileEtag });
        }
      } else {
        const merged = attemptMerge(fullLocal, remote, await mergeOptionsFor(local.id));
        if (merged) {
          console.log(`[Sync:classify] note=${local.id} → merge succeeded, will upload merged`);
          // Use the remote's current file ETag for the upload to succeed via If-Match
          const mergedWithRemoteBase = { ...merged, lastSyncedEtag: remote._currentFileEtag };
          notesToUpload.push(mergedWithRemoteBase);

          // Save merged note locally so the client sees the merged state immediately.
          // Use saveNote (not updateNote) to avoid bumping modified/version, which would
          // falsely trigger the race-condition detector in the post-sync download phase.
          await saveNote({ ...merged, synced: false });
          mergedNoteIds.push(local.id);
        } else {
          console.log(`[Sync:classify] note=${local.id} → merge failed, adding to conflicts`);
          conflicts.notes.push({ local: fullLocal, remote });
        }
      }
    } else if (isModifiedLocally) {
      notesToUpload.push(await getFullNote(local));
    } else if (isModifiedRemotely) {
      // Check if the remote version is actually not newer than our local version.
      // This happens when Nextcloud's server-side versioning causes the PROPFIND getetag to
      // alternate between two etags for the same file — one for an older versioned copy, and
      // one whose mtime matches our local version exactly (the file we last uploaded).
      // In both cases there is no real remote change: skip the download and just accept
      // the remote etag so the next PROPFIND comparison is correct.
      // The guard `!isModifiedLocally` ensures we only skip downloads when local is clean.
      //
      // NOTE: strict equality is intentional. `remote.modified` comes from the downloaded
      // note JSON (millisecond precision), NOT the WebDAV mtime — in true oscillation the
      // remote file IS our own upload, so the timestamps match exactly. A looser tolerance
      // (remote.modified <= local.modified + 2000) was tried before and swallowed genuinely
      // newer remote edits, causing stroke loss (commit e809876). Do not relax this.
      if (
        remote.modified &&
        local.modified &&
        remote.modified === local.modified &&
        !isModifiedLocally
      ) {
        console.log(
          `[Sync:classify] note=${local.id} → etag oscillation detected (remote.modified === local.modified = ${local.modified}). Accepting etag without download.`,
        );
        noteEtagsToUpdate.push({
          id: local.id,
          etag: remote._currentFileEtag,
          modified: local.modified,
        });
      } else if (
        rules.upload &&
        remote.version !== undefined &&
        local.version !== undefined &&
        remote.version < local.version
      ) {
        // Remote was edited from a stale base (remote.version < local.version).
        // Even though local is clean (synced=true), a plain download would discard
        // strokes that local uploaded in the interim. Merge instead.
        console.log(
          `[Sync:classify] note=${local.id} → stale-fork remote (remote.version=${remote.version} < local.version=${local.version}). Merging.`,
        );
        const fullLocal = await getFullNote(local);
        if (local.encrypted) {
          const merged = await attemptMergeEncrypted(
            fullLocal,
            remote,
            await mergeOptionsFor(local.id),
          );
          if (merged) {
            console.log(
              `[Sync:classify] note=${local.id} → stale-fork encrypted merge succeeded, uploading merged`,
            );
            notesToUpload.push({ ...merged, lastSyncedEtag: remote._currentFileEtag });
            await saveNote({ ...merged, synced: false });
            mergedNoteIds.push(local.id);
          } else {
            // Undecryptable: previous behaviour, local wins.
            notesToUpload.push({ ...fullLocal, lastSyncedEtag: remote._currentFileEtag });
          }
        } else {
          const merged = attemptMerge(fullLocal, remote, await mergeOptionsFor(local.id));
          if (merged) {
            console.log(
              `[Sync:classify] note=${local.id} → stale-fork merge succeeded, uploading merged`,
            );
            notesToUpload.push({ ...merged, lastSyncedEtag: remote._currentFileEtag });
            await saveNote({ ...merged, synced: false });
            mergedNoteIds.push(local.id);
          } else {
            console.log(
              `[Sync:classify] note=${local.id} → stale-fork merge failed, adding to conflicts`,
            );
            conflicts.notes.push({ local: fullLocal, remote });
          }
        }
      } else {
        notesToDownload.push(remote);
      }
    }
  }

  // Check which remote notes should be downloaded
  for (const remote of remoteData.notes) {
    if (!localNoteMap.has(remote.id)) {
      notesToDownload.push(remote);
    }
  }

  // Step 4: Upload only what needs to be uploaded
  const uploadResults = {
    notebooks: await syncNotebooks(notebooksToUpload, { rules }),
    notes: await syncNotes(notesToUpload, { rules }),
  };

  // Step 4b: Heal media for legacy notes that have pdf-page items but no pdfSource.
  // These notes predate pdfSource tracking and were synced before media upload existed,
  // so their PDF blobs were never uploaded. syncNoteMedia is idempotent (skips existing files).
  // Note: localNotes stubs have metadata-only media (no fileId). We filter by type presence,
  // then load the full note to get fileIds before calling syncNoteMedia.
  const uploadedNoteIds = new Set(notesToUpload.map((n) => n.id));
  const legacyPdfStubs = (rules.repairTree ? localNotes : []).filter(
    (n) =>
      !n.deleted &&
      !n.purged &&
      !uploadedNoteIds.has(n.id) &&
      !n.pdfSource &&
      Array.isArray(n.media) &&
      n.media.some((m) => m.type === "pdf-page"),
  );
  if (legacyPdfStubs.length > 0) {
    console.log(`[Sync] Healing media for ${legacyPdfStubs.length} legacy PDF note(s)`);
    for (const stub of legacyPdfStubs) {
      const fullNote = await getFullNote(stub);
      const decryptedNote = await decryptNoteLocally(fullNote);
      // Only proceed if the full note actually has pdf-page items with fileIds
      const pdfPageItem = decryptedNote.media?.find((m) => m.type === "pdf-page" && m.fileId);
      if (!pdfPageItem) continue;
      await syncNoteMedia(decryptedNote);
      // Patch pdfSource so this note is treated correctly going forward.
      // Save without marking synced=false to avoid re-uploading the JSON.
      if (!fullNote.pdfSource) {
        await saveNote({ ...fullNote, pdfSource: pdfPageItem.fileId });
      }
    }
  }

  console.log("Full sync completed:", {
    uploaded: {
      notebooks: uploadResults.notebooks.uploaded,
      notes: uploadResults.notes.uploaded,
    },
    downloaded: {
      notebooks: notebooksToDownload.length,
      notes: notesToDownload.length,
    },
  });

  return {
    uploaded: uploadResults,
    downloaded: {
      notebooks: notebooksToDownload,
      notes: notesToDownload,
    },
    noteEtagsToUpdate,
    mergedNoteIds,
    conflicts,
    notebooksToUpload,
    notesToUpload,
    notebooksToDelete,
    notesToDelete,
    strandedNoteIds: [...stranded],
  };
}

/**
 * Sync one notebook shared with this user, in isolation from the own tree
 * and from every other share.
 *
 * @param {Object} notebook - the local record (carries the granted permissions)
 * @param {Array} notes - the notebook's local note metadata
 * @returns {Promise<Object>} a fullSync result; `rootMissing: true` and nothing else
 *   when the notebook's folder is gone, so the caller can run the share-gone check
 */
export async function syncSharedNotebook(notebook, notes) {
  const shared = { notebookId: notebook.id, canEdit: canEdit(notebook) };
  try {
    return await fullSync([notebook], notes, { shared });
  } catch (error) {
    if (error instanceof SharedRootMissingError) {
      console.warn(`[Sync] ${error.message}`);
      return { ...EMPTY_SYNC_RESULT(), rootMissing: true };
    }
    throw error;
  }
}

/** The result of a pass that did nothing, in the shape fullSync returns. */
const EMPTY_SYNC_RESULT = () => ({
  uploaded: {
    notebooks: { uploaded: 0, failed: 0, errors: [], uploadedIds: [], metadata: {} },
    notes: { uploaded: 0, failed: 0, errors: [], uploadedIds: [], metadata: {} },
  },
  downloaded: { notebooks: [], notes: [] },
  noteEtagsToUpdate: [],
  mergedNoteIds: [],
  conflicts: { notebooks: [], notes: [] },
  notebooksToUpload: [],
  notesToUpload: [],
  notebooksToDelete: [],
  notesToDelete: [],
  strandedNoteIds: [],
});

/**
 * Delete remote notebook (marks in tombstone, doesn't actually delete folder yet)
 */
export async function deleteRemoteNotebook(notebookId) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  try {
    // Delete the notebook folder recursively
    // This removes the notebook metadata, all notes, and media within it
    const notebookFolder = getNotebookFolder(notebookId);

    console.log(`[Sync] Deleting remote notebook folder: ${notebookFolder}`);
    // deleteFile uses WebDAV DELETE which works on folders
    await deleteFile(notebookFolder);

    return true;
  } catch (error) {
    console.error(`Failed to delete remote notebook ${notebookId}:`, error);
    return false;
  }
}

/**
 * Delete remote note (marks in tombstone and deletes file)
 */
export async function deleteRemoteNote(noteId, notebookId) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  try {
    // Get paths
    const notePath = getNotePath(noteId, notebookId);
    const mediaFolder = getNoteMediaFolder(noteId, notebookId);
    const tombstonePath = notebookId
      ? getNotebookTombstonePath(notebookId)
      : getQuickNotesTombstonePath();

    // Add to tombstone (etag-protected read-modify-write)
    await updateRemoteTombstone(tombstonePath, (tombstone) => {
      addNoteTombstone(tombstone, noteId);
    });

    // Delete the actual note file
    await deleteFile(notePath);

    // Delete the media folder if it exists
    // deleteFile (WebDAV DELETE) works on folders too
    await deleteFile(mediaFolder).catch(() => {}); // Ignore if folder doesn't exist

    console.log(`[Sync] Deleted remote note ${noteId} and media`);
    return true;
  } catch (error) {
    console.error(`Failed to delete remote note ${noteId}:`, error);
    return false;
  }
}

/**
 * Upload tombstone file for a notebook
 */
export async function uploadTombstone(notebookId, tombstone) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  const path = notebookId ? getNotebookTombstonePath(notebookId) : getQuickNotesTombstonePath();

  // Clean up old tombstones before uploading
  const cleaned = cleanupOldTombstones(tombstone);

  const content = JSON.stringify(cleaned, null, 2);
  await uploadFile(path, content);

  return true;
}

/**
 * Download tombstone file for a notebook
 */
export async function downloadTombstone(notebookId) {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  const path = notebookId ? getNotebookTombstonePath(notebookId) : getQuickNotesTombstonePath();

  const { content } = await downloadFile(path);

  if (!content) {
    return createEmptyTombstone();
  }

  return JSON.parse(content);
}

/**
 * Migrate from flat structure (v1) to hierarchical structure (v2)
 * Downloads all files from flat structure and re-uploads in hierarchical structure
 */
export async function migrateToHierarchical() {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  console.log("Starting migration from flat to hierarchical structure...");

  try {
    // Step 1: Download all files from flat structure
    const legacyFiles = await listFiles(ROOT_FOLDER);

    const notebooks = [];
    const notes = [];

    for (const file of legacyFiles) {
      try {
        if (file.name.startsWith("notebook_") && file.name.endsWith(".json")) {
          const notebookId = file.name.replace("notebook_", "").replace(".json", "");
          const path = getLegacyNotebookPath(notebookId);
          const { content } = await downloadFile(path);

          if (content) {
            notebooks.push(JSON.parse(content));
          }
        } else if (file.name.startsWith("note_") && file.name.endsWith(".json")) {
          const noteId = file.name.replace("note_", "").replace(".json", "");
          const path = getLegacyNotePath(noteId);
          const { content } = await downloadFile(path);

          if (content) {
            notes.push(JSON.parse(content));
          }
        }
      } catch (error) {
        console.error(`Failed to download legacy file ${file.name}:`, error);
      }
    }

    console.log(`Found ${notebooks.length} notebooks and ${notes.length} notes in flat structure`);

    // Step 2: Create hierarchical structure
    await ensureHierarchicalStructure();

    // Step 3: Upload notebooks to hierarchical structure
    console.log("Uploading notebooks to hierarchical structure...");
    await syncNotebooks(notebooks);

    // Step 4: Upload notes to hierarchical structure
    console.log("Uploading notes to hierarchical structure...");
    await syncNotes(notes);

    // Step 5: Optionally delete old flat files (commented out for safety)
    // for (const file of legacyFiles) {
    //   if (file.name.startsWith("notebook_") || file.name.startsWith("note_")) {
    //     await deleteFile(`${ROOT_FOLDER}/${file.name}`);
    //   }
    // }

    console.log("Migration completed successfully!");
    console.log(
      "Note: Old flat files have been kept for safety. You can manually delete them later.",
    );

    return {
      success: true,
      migratedNotebooks: notebooks.length,
      migratedNotes: notes.length,
    };
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}

/**
 * Check if migration is needed by detecting flat structure files
 * Also checks local storage version to avoid re-migration
 */
export async function needsMigration() {
  if (!(await isAuthenticated())) {
    return false;
  }

  try {
    // Import here to avoid circular dependency
    const { getStorageVersion } = await import("./storage.js");
    const localVersion = await getStorageVersion();

    // If local storage is already v2, no migration needed
    if (localVersion >= STORAGE_VERSION) {
      return false;
    }

    const files = await listFiles(ROOT_FOLDER);

    // Check if any flat structure files exist
    const hasLegacyFiles = files.some(
      (f) =>
        (f.name.startsWith("notebook_") || f.name.startsWith("note_")) && f.name.endsWith(".json"),
    );

    // Check if hierarchical structure exists
    const hasHierarchical = files.some((f) => f.name === "notebooks" || f.name === "quickNotes");

    // Migration needed if we have legacy files but no hierarchical structure
    return hasLegacyFiles && !hasHierarchical;
  } catch (error) {
    console.error("Failed to check migration status:", error);
    return false;
  }
}

/**
 * Clean up legacy flat structure files after successful migration
 * Only call this after confirming migration was successful
 */
export async function cleanupLegacyFiles() {
  if (!(await isAuthenticated())) {
    throw new Error("Not authenticated with Nextcloud");
  }

  console.log("Cleaning up legacy flat structure files...");

  try {
    const files = await listFiles(ROOT_FOLDER);
    let deletedCount = 0;

    for (const file of files) {
      try {
        if (
          (file.name.startsWith("notebook_") || file.name.startsWith("note_")) &&
          file.name.endsWith(".json")
        ) {
          const path = `${ROOT_FOLDER}/${file.name}`;
          await deleteFile(path);
          deletedCount++;
          console.log(`Deleted legacy file: ${file.name}`);
        }
      } catch (error) {
        console.error(`Failed to delete legacy file ${file.name}:`, error);
      }
    }

    console.log(`Cleanup complete! Deleted ${deletedCount} legacy files.`);

    return {
      success: true,
      deletedCount,
    };
  } catch (error) {
    console.error("Cleanup failed:", error);
    throw error;
  }
}
