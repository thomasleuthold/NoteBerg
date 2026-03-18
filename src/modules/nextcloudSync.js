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
import {
  getSecureCredential as _tauriGetSecureCredential,
  deleteSecureCredential,
  saveSecureCredential,
} from "./secureStorage.js";
import {
  checkFileExists,
  clearNoteMoveFlag,
  getFile,
  getRawNote,
  isNextcloudEncryptionEnabled,
  permanentlyDeleteNote,
  permanentlyDeleteNotebook,
  permanentlyDeleteNotesInNotebook,
  saveFile,
  saveNote,
} from "./storage.js";
import {
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

// ─── Injectable HTTP / credential providers ───────────────────────────────────
// Defaults to the real Tauri implementations. SyncWorker overrides these with
// worker-safe shims via configureHttpProvider() before running any sync logic.
let _fetch = _tauriFetch;
let _getSecureCredential = _tauriGetSecureCredential;

/**
 * Override the fetch implementation and credential reader used by this module.
 * Called by SyncWorker.js to inject worker-safe shims (no Tauri IPC needed).
 * @param {Function} fetchFn         — drop-in for fetch()
 * @param {Function} getCredentialFn — drop-in for getSecureCredential(key)
 */
export function configureHttpProvider(fetchFn, getCredentialFn) {
  _fetch = fetchFn;
  _getSecureCredential = getCredentialFn;
}

const NEXTCLOUD_STORAGE_KEY = "nextcloud_credentials";
const LEGACY_STORAGE_KEY = "nextcloud_credentials"; // Same key used in localStorage

// Mime type mapping for file extensions
const MIME_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "audio/webm": ".webm",
  "audio/webm;codecs=opus": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

function getExtensionFromMime(mimeType) {
  return MIME_TYPES[mimeType] || ".bin";
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
 * @param {Object} note - Note object (may be locally encrypted)
 * @returns {Promise<Object>} - Note with all content fields decrypted
 */
async function decryptNoteLocally(note) {
  if (!note.encrypted) return note;

  const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
  const { decryptObject } = await import("./encryption.js");

  if (!isAppUnlocked()) {
    throw new Error("Cannot upload encrypted note - app is locked");
  }

  const key = getEncryptionKey();
  const isBlob = (v) =>
    v && typeof v === "object" && typeof v.data === "string" && typeof v.iv === "string";

  return {
    ...note,
    content: isBlob(note.content) ? await decryptObject(note.content, key) : note.content,
    strokes: isBlob(note.strokes) ? await decryptObject(note.strokes, key) : note.strokes,
    media: isBlob(note.media) ? await decryptObject(note.media, key) : note.media,
    recordings: isBlob(note.recordings) ? await decryptObject(note.recordings, key) : (note.recordings ?? []),
    tasks: isBlob(note.tasks) ? await decryptObject(note.tasks, key) : note.tasks || [],
    recognition: isBlob(note.recognition)
      ? await decryptObject(note.recognition, key)
      : note.recognition,
    thumbnail: isBlob(note.thumbnail)
      ? await decryptObject(note.thumbnail, key)
      : (note.thumbnail ?? null),
    encrypted: undefined,
  };
}

/**
 * Encrypt note data for Nextcloud upload if encryption is enabled
 * Handles conversion between local encryption and Nextcloud encryption formats
 * @param {Object} note - Note object (may be locally encrypted)
 * @returns {Promise<Object>} - Note object (in Nextcloud format)
 */
async function encryptNoteForNextcloud(note) {
  const shouldEncryptForNextcloud = await isNextcloudEncryptionEnabled();

  // If the note has locally-encrypted content blobs, decrypt them first so the
  // Nextcloud file always contains readable JSON regardless of local encryption setting.
  const decryptedNote = await decryptNoteLocally(note);

  // Encrypt for Nextcloud if enabled
  if (!shouldEncryptForNextcloud) {
    // Nextcloud encryption disabled - return decrypted note
    return decryptedNote;
  }

  // Nextcloud encryption enabled - encrypt the decrypted note
  const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
  const { encryptObject } = await import("./encryption.js");

  if (!isAppUnlocked()) {
    throw new Error("Cannot encrypt note for Nextcloud - app is locked");
  }

  try {
    const encryptionKey = getEncryptionKey();

    // Encrypt content, strokes, media, recordings and thumbnail for Nextcloud storage
    const encryptedContent = await encryptObject(decryptedNote.content || "", encryptionKey);
    const encryptedStrokes = await encryptObject(decryptedNote.strokes || [], encryptionKey);
    const encryptedMedia = await encryptObject(decryptedNote.media || [], encryptionKey);
    const encryptedRecordings = await encryptObject(decryptedNote.recordings || [], encryptionKey);
    const encryptedThumbnail = decryptedNote.thumbnail
      ? await encryptObject(decryptedNote.thumbnail, encryptionKey)
      : null;

    return {
      ...decryptedNote,
      content: encryptedContent,
      strokes: encryptedStrokes,
      media: encryptedMedia,
      recordings: encryptedRecordings,
      thumbnail: encryptedThumbnail,
      nextcloudEncrypted: true, // Mark as Nextcloud-encrypted
    };
  } catch (error) {
    console.error("[NextcloudSync] Failed to encrypt note for Nextcloud:", error);
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt note data from Nextcloud and prepare it for local storage
 * @param {Object} note - Note object (possibly encrypted for Nextcloud)
 * @returns {Promise<Object>} - Note prepared for local storage (encrypted if local encryption enabled)
 */
async function decryptNoteFromNextcloud(note) {
  // Step 1: Decrypt from Nextcloud format if needed
  let decryptedNote = note;

  if (note?.nextcloudEncrypted) {
    // Import encryption modules
    const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
    const { decryptObject } = await import("./encryption.js");

    if (!isAppUnlocked()) {
      throw new Error("Cannot decrypt note - app is locked");
    }

    try {
      const encryptionKey = getEncryptionKey();

      // Decrypt content, strokes, and media from Nextcloud encryption
      const decryptedContent = await decryptObject(note.content, encryptionKey);
      const decryptedStrokes = await decryptObject(note.strokes, encryptionKey);

      // Only decrypt media/recordings if they exist and have the encrypted structure
      // (notes encrypted before these fields were added won't have them)
      let decryptedMedia = [];
      if (note.media && typeof note.media === "object" && note.media.data && note.media.iv) {
        decryptedMedia = await decryptObject(note.media, encryptionKey);
      }

      let decryptedRecordings = [];
      if (note.recordings && typeof note.recordings === "object" && note.recordings.data && note.recordings.iv) {
        decryptedRecordings = await decryptObject(note.recordings, encryptionKey);
      } else if (Array.isArray(note.recordings)) {
        decryptedRecordings = note.recordings;
      }

      let decryptedThumbnail = null;
      if (
        note.thumbnail &&
        typeof note.thumbnail === "object" &&
        note.thumbnail.data &&
        note.thumbnail.iv
      ) {
        decryptedThumbnail = await decryptObject(note.thumbnail, encryptionKey);
      } else {
        decryptedThumbnail = note.thumbnail ?? null;
      }

      decryptedNote = {
        ...note,
        content: decryptedContent,
        strokes: decryptedStrokes,
        media: decryptedMedia,
        recordings: decryptedRecordings,
        thumbnail: decryptedThumbnail,
        nextcloudEncrypted: undefined, // Remove Nextcloud encryption flag
      };
    } catch (error) {
      console.error("[NextcloudSync] Failed to decrypt note from Nextcloud:", error);
      throw new Error("Failed to decrypt note from Nextcloud");
    }
  }

  // Step 2: If the note has local encryption from another client (encrypted: true),
  // decrypt it now so saveNote can re-encrypt it with this client's local key.
  // This handles the case where a note was saved encrypted by another client and
  // uploaded to Nextcloud without Nextcloud-level encryption.
  if (decryptedNote.encrypted) {
    try {
      decryptedNote = await decryptNoteLocally(decryptedNote);
    } catch (err) {
      console.error(`[NextcloudSync] Could not decrypt locally-encrypted note ${decryptedNote.id} — wrong key or corrupted:`, err);
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
    const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
    const { decryptObject } = await import("./encryption.js");

    if (isAppUnlocked()) {
      const key = getEncryptionKey();

      if (isEncryptedBlob(decryptedNote.recordings)) {
        try {
          const dec = await decryptObject(decryptedNote.recordings, key);
          decryptedNote = { ...decryptedNote, recordings: Array.isArray(dec) ? dec : [] };
        } catch (_e) {
          // Wrong key (from another device) — drop the recordings rather than breaking the note
          console.warn(`[NextcloudSync] Could not decrypt recordings blob for note ${decryptedNote.id} — dropping recordings`);
          decryptedNote = { ...decryptedNote, recordings: [] };
        }
      }

      if (isEncryptedBlob(decryptedNote.media)) {
        try {
          const dec = await decryptObject(decryptedNote.media, key);
          decryptedNote = { ...decryptedNote, media: Array.isArray(dec) ? dec : [] };
        } catch (_e) {
          console.warn(`[NextcloudSync] Could not decrypt media blob for note ${decryptedNote.id} — dropping media`);
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
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    console.info("[NextcloudSync] Migrated credentials to secure storage");
  } catch (error) {
    console.error("[NextcloudSync] Failed to migrate credentials:", error);
  }
}

/**
 * Get stored Nextcloud credentials from secure storage
 */
export async function getStoredCredentials() {
  try {
    const credString = await _getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    if (credString) {
      return JSON.parse(credString);
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
  try {
    const credString = JSON.stringify(credentials);
    await saveSecureCredential(NEXTCLOUD_STORAGE_KEY, credString);

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
  try {
    await deleteSecureCredential(NEXTCLOUD_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear credentials:", error);
    throw error;
  }
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated() {
  const creds = await getStoredCredentials();
  return !!(creds?.serverUrl && creds.loginName && creds.appPassword);
}

/**
 * Test connection to Nextcloud server
 */
export async function testConnection(serverUrl) {
  serverUrl = serverUrl.replace(/\/$/, "");

  try {
    const response = await _fetch(`${serverUrl}/status.php`);
    const data = await response.json();

    if (data.installed && data.version) {
      return {
        success: true,
        version: data.version,
        versionstring: data.versionstring,
      };
    }

    return { success: false, error: "Not a valid Nextcloud server" };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Start Nextcloud Login Flow v2
 * Returns a promise that resolves when authentication is complete
 * Calls onLoginUrlReady callback with login URL when available
 */
export async function startLoginFlow(serverUrl, onLoginUrlReady = null) {
  serverUrl = serverUrl.replace(/\/$/, "");

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
    console.log("Init response headers:", initResponse.headers);

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error("Init response error:", errorText);
      throw new Error(
        `Failed to initialize login flow: ${initResponse.status} ${initResponse.statusText}`,
      );
    }

    const responseText = await initResponse.text();
    console.log("Init response body:", responseText);

    if (!responseText || responseText.trim() === "") {
      console.error("Empty response from server");
      throw new Error("Empty response from server");
    }

    let initData;
    try {
      initData = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse init response as JSON:", e);
      console.error("Response text was:", responseText);
      throw new Error(`Invalid JSON response from server: ${e.message}`);
    }

    console.log("Parsed init data:", initData);

    const { poll, login } = initData;

    if (!poll || !login) {
      console.error("Missing required fields in response:", { poll, login });
      throw new Error("Invalid login flow response - missing poll or login");
    }

    // Extract token from poll object
    const token = poll.token;
    const endpoint = poll.endpoint;

    if (!token || !endpoint) {
      console.error("Missing token or endpoint in poll object:", poll);
      throw new Error("Invalid poll response - missing token or endpoint");
    }

    console.log("Login Flow initialized:", {
      endpoint,
      token: `${token.substring(0, 10)}...`,
      login,
    });

    // Step 2: Provide login URL to callback (for UI display)
    if (onLoginUrlReady) {
      onLoginUrlReady(login);
    }

    // Step 3: Try to open login page in default browser
    console.log("Opening login page in browser:", login);
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
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;
  const authHeader = `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`;

  const response = await _fetch(webdavUrl, {
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

/**
 * Upload a file to Nextcloud using WebDAV
 * Uses X-OC-Mtime to set the modification time to match local file
 */
async function uploadFile(path, content, mtime = null, etag = null) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const headers = {
    Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
    "Content-Type": "application/json",
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
  }

  let response = await _fetch(webdavUrl, {
    method: "PUT",
    headers,
    body: content,
  });

  if (response.status === 412) {
    console.warn(`[NextcloudSync] 412 Conflict detected for ${path}. Forcing overwrite.`);

    // Remove If-Match to force overwrite (Brute force resolution)
    if (headers["If-Match"]) {
      delete headers["If-Match"];
    }

    // Retry upload without the version check
    response = await _fetch(webdavUrl, {
      method: "PUT",
      headers,
      body: content,
    });
  }

  if (!response.ok && response.status !== 201 && response.status !== 204) {
    const errorText = await response.text();
    console.error("Upload error:", errorText);
    throw new Error(`Failed to upload file: ${response.status} ${response.statusText}`);
  }

  let newEtag = response.headers.get("etag")?.replace(/"/g, "");

  // If ETag is missing (e.g. 204 response), try to fetch it via HEAD
  if (!newEtag && response.ok) {
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

/**
 * Download a file from Nextcloud using WebDAV
 */
async function downloadFile(path, asBinary = false) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await _fetch(webdavUrl, {
    method: "GET",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
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
    const content = await response.arrayBuffer();
    const etag = response.headers.get("etag")?.replace(/"/g, "");
    return { content, etag };
  }

  const content = await response.text();
  const etag = response.headers.get("etag")?.replace(/"/g, "");
  return { content, etag };
}

/**
 * Sync media files for a note (Upload)
 * Ensures all binary files referenced in the note are uploaded to Nextcloud
 * Uses parallel uploads for efficiency
 */
async function syncNoteMedia(note) {
  // When the note is locally encrypted, media is stored as an encrypted blob —
  // media files were already uploaded when the note was last synced unencrypted,
  // and the encrypted payload references them by fileId inside the blob.
  if (note.media !== undefined && !Array.isArray(note.media)) return;
  const hasRecordings = Array.isArray(note.recordings) && note.recordings.length > 0;
  if ((!note.media || note.media.length === 0) && !note.pdfSource && !hasRecordings) return;

  const mediaFolder = getNoteMediaFolder(note.id, note.notebookId);

  // Ensure media folder exists
  await createFolder(mediaFolder);

  // Get list of existing files on server to avoid unnecessary uploads
  let remoteFiles = [];
  try {
    remoteFiles = await listFiles(mediaFolder);
  } catch (_e) {
    // Ignore error if folder is empty/new
  }
  const remoteNames = new Set(remoteFiles.map((f) => f.name));

  // Prepare upload tasks for items that need uploading
  const uploadTasks = [];
  const processedIds = new Set(); // Track processed IDs to avoid duplicates (e.g. multiple PDF pages)

  // Collect all file IDs (media items + pdfSource + recordings)
  const itemsToSync = [...(note.media || [])];
  if (note.pdfSource) {
    itemsToSync.push({ fileId: note.pdfSource, id: "pdf-source" });
  }
  for (const rec of note.recordings || []) {
    if (!rec.deleted && rec.fileId) {
      itemsToSync.push({ fileId: rec.fileId, id: rec.id });
    }
  }

  for (const item of itemsToSync) {
    const fileId = item.fileId;
    if (!fileId) continue;

    if (processedIds.has(fileId)) continue;
    processedIds.add(fileId);

    // Get file from local storage
    const blob = await getFile(fileId);
    if (!blob) {
      console.warn(`[Sync] Local file not found for media item ${item.id} (fileId: ${fileId})`);
      continue;
    }

    // Determine filename
    const ext = getExtensionFromMime(blob.type);
    const filename = `${fileId}${ext}`;

    // Queue upload if not exists on server
    if (!remoteNames.has(filename)) {
      uploadTasks.push({ filename, blob, path: `${mediaFolder}/${filename}` });
    }
  }

  // Upload in parallel batches
  if (uploadTasks.length > 0) {
    const MEDIA_UPLOAD_CONCURRENCY = 3;
    await runInBatches(uploadTasks, MEDIA_UPLOAD_CONCURRENCY, async (task) => {
      try {
        console.log(`[Sync] Uploading media file: ${task.filename}`);
        await uploadFile(task.path, task.blob);
        return { success: true, filename: task.filename };
      } catch (error) {
        console.error(`[Sync] Failed to upload media file ${task.filename}:`, error);
        return { success: false, filename: task.filename, error };
      }
    });
  }
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
 * Download media files for a note
 * Ensures all binary files referenced in the note are downloaded to local storage.
 */
async function downloadNoteMedia(note, preloadedRemoteFiles = null) {
  if (note.media !== undefined && !Array.isArray(note.media)) return;
  const hasRecordings = Array.isArray(note.recordings) && note.recordings.some((r) => !r.deleted);
  if ((!note.media || note.media.length === 0) && !note.pdfSource && !hasRecordings) return;

  const mediaFolder = getNoteMediaFolder(note.id, note.notebookId);
  let remoteFiles = preloadedRemoteFiles;
  const processedIds = new Set();

  // Collect all file IDs (media items + pdfSource + recordings)
  const itemsToDownload = [...(note.media || [])];
  if (note.pdfSource) {
    itemsToDownload.push({ fileId: note.pdfSource });
  }
  for (const rec of note.recordings || []) {
    if (!rec.deleted && rec.fileId) {
      itemsToDownload.push({ fileId: rec.fileId });
    }
  }

  for (const item of itemsToDownload) {
    const fileId = item.fileId;
    if (!fileId) continue;

    if (processedIds.has(fileId)) continue;
    processedIds.add(fileId);

    // Check if file exists locally
    const existing = await checkFileExists(fileId);
    if (existing) continue;

    // Need to find the remote filename. It should be fileId + extension.
    // Since we don't store the extension in the note JSON explicitly in all versions,
    // we list the folder once to find the matching file.
    if (!remoteFiles) {
      try {
        remoteFiles = await listFiles(mediaFolder);
      } catch (e) {
        console.warn(`[Sync] Failed to list media folder ${mediaFolder}:`, e);
        return; // Stop if folder doesn't exist
      }
    }

    const remoteFile = remoteFiles.find((f) => f.name.startsWith(fileId));
    if (remoteFile) {
      console.log(`[Sync] Downloading media file: ${remoteFile.name}`);
      const { content } = await downloadFile(`${mediaFolder}/${remoteFile.name}`, true); // Download as binary

      if (content) {
        // Infer mime type from extension
        const ext = remoteFile.name.substring(remoteFile.name.lastIndexOf("."));
        const mimeType =
          Object.keys(MIME_TYPES).find((key) => MIME_TYPES[key] === ext) ||
          "application/octet-stream";

        const blob = new Blob([content], { type: mimeType });
        await saveFile(blob, fileId);
      }
    }
  }
}

/**
 * Fetch the state of all files on the server (PROPFIND Depth: infinity)
 * Returns a flat list of all files with their ETags and modification times
 */
async function fetchRemoteState() {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${ROOT_FOLDER}`;

  const response = await _fetch(webdavUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      Depth: "infinity", // Get everything recursively
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (response.status === 404) {
    return []; // Root folder doesn't exist
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch remote state: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const allItems = parseWebDAVResponse(text, false); // false = don't include collections (folders)

  return allItems.map((item) => {
    // Decode URL encoded path
    let path = decodeURIComponent(item.href);
    // Robustly strip base path by finding ROOT_FOLDER
    // This handles variations in how Nextcloud returns the path (e.g. username casing)
    const rootIndex = path.indexOf(ROOT_FOLDER);
    if (rootIndex !== -1) {
      path = path.substring(rootIndex);
    }
    return {
      ...item,
      path, // e.g. /NoteBerg/notebooks/...
    };
  });
}

/**
 * List files in a folder using WebDAV PROPFIND
 */
export async function listFiles(path) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await _fetch(webdavUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      Depth: "1",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (response.status === 404) {
    return []; // Folder doesn't exist
  }

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return parseWebDAVResponse(text, false); // false = don't include collections (folders)
}

/**
 * List folders in a folder using WebDAV PROPFIND
 */
export async function listFolders(path) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await _fetch(webdavUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      Depth: "1",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
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
      etag: etag?.replace(/"/g, ""),
    });
  }

  return files;
}

/**
 * Delete a file from Nextcloud using WebDAV
 */
async function deleteFile(path) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await _fetch(webdavUrl, {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
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
 */
export async function syncNotebooks(notebooks) {
  if (!isAuthenticated()) {
    throw new Error("Not authenticated with Nextcloud");
  }

  // Ensure hierarchical folder structure exists
  await ensureHierarchicalStructure();

  // Separate purged notebooks from active ones
  const purgedNotebooks = notebooks.filter((n) => n.purged);
  const activeNotebooks = notebooks.filter((n) => !n.purged);
  const purgedResults = [];

  // Process purged notebooks: Delete files FIRST, then update tombstone
  // This prevents data loss if tombstone succeeds but deletion fails
  if (purgedNotebooks.length > 0) {
    try {
      // Step 1: Attempt to delete remote folders first
      const deleteResults = await runInBatches(purgedNotebooks, 5, async (notebook) => {
        try {
          console.log(`[Sync] Deleting remote notebook ${notebook.id}`);
          await deleteRemoteNotebook(notebook.id);
          return { success: true, id: notebook.id, action: "purge" };
        } catch (e) {
          console.error(`[Sync] Failed to delete remote notebook ${notebook.id}:`, e);
          return { success: false, id: notebook.id, error: e.message, action: "purge" };
        }
      });

      // Step 2: Only add successfully deleted notebooks to tombstone
      const successfullyDeleted = deleteResults.filter((r) => r.success);

      if (successfullyDeleted.length > 0) {
        const tombstonePath = getGlobalNotebookTombstonePath();
        let tombstone;
        try {
          const { content } = await downloadFile(tombstonePath);
          tombstone = content ? JSON.parse(content) : createEmptyTombstone();
        } catch (e) {
          console.warn(`[Sync] Could not download global tombstone, creating new.`, e);
          tombstone = createEmptyTombstone();
        }

        for (const result of successfullyDeleted) {
          tombstone = addNotebookTombstone(tombstone, result.id);
        }

        await uploadFile(tombstonePath, JSON.stringify(tombstone, null, 2));

        // Step 3: Clean up local stubs only for successful deletions
        for (const result of successfullyDeleted) {
          await permanentlyDeleteNotesInNotebook(result.id);
          await permanentlyDeleteNotebook(result.id);
        }
      }

      purgedResults.push(...deleteResults);
    } catch (error) {
      console.error("[Sync] Failed to process purged notebooks:", error);
    }
  }

  const CONCURRENCY = 5;

  const uploadResults = await runInBatches(activeNotebooks, CONCURRENCY, async (notebook) => {
    try {
      // Create notebook folder
      const notebookFolder = getNotebookFolder(notebook.id);
      await createFolder(notebookFolder);

      // Create notes subfolder
      const notesFolder = getNotebookNotesFolder(notebook.id);
      await createFolder(notesFolder);

      // Upload notebook metadata
      const path = getNotebookPath(notebook.id);
      const syncedNotebook = {
        ...notebook,
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

  const batchResults = [...purgedResults, ...uploadResults];

  const results = {
    uploaded: 0,
    failed: 0,
    errors: [],
    uploadedIds: [],
    metadata: {},
  };

  for (const res of batchResults) {
    if (res.success) {
      // Only count as uploaded if it wasn't a purge action
      if (res.action !== "purge") {
        results.uploaded++;
        results.uploadedIds.push(res.id);
        results.metadata[res.id] = { etag: typeof res.etag === "string" ? res.etag : null };
      }
    } else {
      results.failed++;
      results.errors.push({ id: res.id, error: res.error });
    }
  }

  return results;
}

/**
 * Sync notes to Nextcloud (hierarchical structure)
 */
export async function syncNotes(notes) {
  if (!isAuthenticated()) {
    throw new Error("Not authenticated with Nextcloud");
  }

  // Ensure hierarchical folder structure exists
  await ensureHierarchicalStructure();

  // Separate purged notes from active notes
  const purgedNotes = notes.filter((n) => n.purged);
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

      try {
        // Step 1: Delete files first (before updating tombstone)
        const deleteResults = await runInBatches(groupNotes, 5, async (note) => {
          try {
            const notePath = getNotePath(note.id, note.notebookId);
            const mediaFolder = getNoteMediaFolder(note.id, note.notebookId);

            await deleteFile(notePath);
            await deleteFile(mediaFolder).catch(() => {}); // Ignore if folder doesn't exist

            return { success: true, id: note.id, action: "purge" };
          } catch (e) {
            console.error(`[Sync] Failed to delete purged note files ${note.id}:`, e);
            return { success: false, id: note.id, error: e.message, action: "purge" };
          }
        });

        // Step 2: Only add successfully deleted notes to tombstone
        const successfullyDeleted = deleteResults.filter((r) => r.success);

        if (successfullyDeleted.length > 0) {
          const tombstonePath = notebookId
            ? getNotebookTombstonePath(notebookId)
            : getQuickNotesTombstonePath();

          let tombstone;
          try {
            const { content: tombstoneContent } = await downloadFile(tombstonePath);
            tombstone = tombstoneContent ? JSON.parse(tombstoneContent) : createEmptyTombstone();
          } catch (e) {
            console.warn(`[Sync] Could not download tombstone ${tombstonePath}, creating new.`, e);
            tombstone = createEmptyTombstone();
          }

          // Add only successfully deleted notes to tombstone
          for (const result of successfullyDeleted) {
            tombstone = addNoteTombstone(tombstone, result.id);
          }

          // Upload updated tombstone
          await uploadFile(tombstonePath, JSON.stringify(tombstone, null, 2));

          // Step 3: Clean up local stubs only for successful deletions
          for (const result of successfullyDeleted) {
            await permanentlyDeleteNote(result.id);
            console.log(`[Sync] Purged note ${result.id} completely`);
          }
        }

        purgedResults.push(...deleteResults);
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
  const movedNotes = activeNotes.filter((n) => n.previousNotebookId !== undefined);
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

      // Write tombstone once for the whole group (serial — no race)
      let tombstone;
      try {
        const { content } = await downloadFile(tombstonePath);
        tombstone = content ? JSON.parse(content) : createEmptyTombstone();
      } catch {
        tombstone = createEmptyTombstone();
      }
      for (const note of groupNotes) {
        tombstone = addNoteTombstone(tombstone, note.id);
      }
      await uploadFile(tombstonePath, JSON.stringify(tombstone, null, 2));

      console.log(
        `[Sync] Cleaned up ${groupNotes.length} moved note(s) from ${key}: ${groupNotes.map((n) => n.id).join(", ")}`,
      );
    }
  }

  const uploadResults = await runInBatches(activeNotes, CONCURRENCY, async (note) => {
    try {
      // Get the correct path based on whether note is in a notebook or is a quick note
      const path = getNotePath(note.id, note.notebookId);

      console.log(`Uploading note ${note.id} (${note.title}) to ${path}`);

      const syncedNote = {
        ...note,
        synced: true,
        // Keep original modified timestamp to preserve history
      };

      // Decrypt local encryption before syncing media — syncNoteMedia needs a plain media array.
      // decryptNoteLocally is a no-op when note.encrypted is falsy.
      const decryptedNote = await decryptNoteLocally(syncedNote);

      // Sync media files (upload binaries) — must use decrypted media array
      await syncNoteMedia(decryptedNote);

      // Clean up orphaned media files (deleted from note but still on server)
      await cleanupOrphanedMedia(decryptedNote);

      // Encrypt note for Nextcloud if encryption is enabled
      const encryptedNote = await encryptNoteForNextcloud(syncedNote);

      // Strip internal sync tracking fields before uploading
      const noteForUpload = { ...encryptedNote };
      delete noteForUpload.lastSyncedEtag;
      delete noteForUpload.synced;
      delete noteForUpload.encrypted;
      delete noteForUpload._currentFileEtag;
      delete noteForUpload.previousNotebookId;

      // Prepare content
      const content = JSON.stringify(noteForUpload, null, 2);

      // For moved notes, the file at the new path is new — there is no existing etag to match.
      // Passing null omits the If-Match header and avoids a guaranteed 412.
      const uploadEtag = note.previousNotebookId !== undefined ? null : note.lastSyncedEtag;
      const etag = await uploadFile(path, content, syncedNote.modified, uploadEtag);
      console.log(`Successfully uploaded note ${note.id}`);
      return {
        success: true,
        id: note.id,
        etag,
        hadPreviousLocation: note.previousNotebookId !== undefined,
      };
    } catch (error) {
      console.error(`Failed to sync note ${note.id}:`, error);
      return { success: false, id: note.id, error: error.message };
    }
  });

  const batchResults = [...purgedResults, ...uploadResults];

  const results = {
    uploaded: 0,
    failed: 0,
    errors: [],
    uploadedIds: [],
    metadata: {},
  };

  for (const res of batchResults) {
    if (res.success) {
      // Only count as uploaded if it wasn't a purge action
      if (res.action !== "purge") {
        results.uploaded++;
        results.uploadedIds.push(res.id);
        results.metadata[res.id] = { etag: typeof res.etag === "string" ? res.etag : null };

        // Clear previousNotebookId now that the move has been synced to Nextcloud
        if (res.hadPreviousLocation) {
          await clearNoteMoveFlag(res.id);
        }
      }
    } else {
      results.failed++;
      results.errors.push({ id: res.id, error: res.error });
    }
  }

  return results;
}

/**
 * Download all data from Nextcloud (hierarchical structure)
 * Optimized to only download changed files based on ETags
 */
export async function downloadAllData(localNotebooks = [], localNotes = []) {
  if (!isAuthenticated()) {
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
  const remoteFiles = await fetchRemoteState();

  // Lists of items to download
  const notebooksToDownload = [];
  const notesToDownload = [];
  const tombstonesToDownload = [];
  const mediaCheckQueue = []; // Notes that are unchanged but might need media checks

  // Step 2: Identify what needs downloading
  for (const file of remoteFiles) {
    const parsed = parsePath(file.path);

    if (parsed.type === "notebook") {
      const local = localNotebooksMap.get(parsed.notebookId);
      // Download if we don't have it or ETag changed
      if (!local || local.lastSyncedEtag !== file.etag) {
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

        if (local.media && local.media.length > 0) {
          mediaCheckQueue.push(local);
        }
      }
    } else if (parsed.type === "tombstone") {
      // Always download tombstones for now (they are small and critical)
      tombstonesToDownload.push({ ...parsed, path: file.path });
    }
  }

  // Index remote media files for efficient lookup
  // Map: noteId -> Array of { name, path }
  const remoteMediaMap = new Map();
  for (const file of remoteFiles) {
    const parsed = parsePath(file.path);
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

  console.log(
    `[Sync] Incremental check: ${notebooksToDownload.length} notebooks, ${notesToDownload.length} notes to download.`,
  );

  // Step 3: Download changed items in parallel batches
  const CONCURRENCY = 5;

  // Download Notebooks
  const downloadedNotebooks = await runInBatches(notebooksToDownload, CONCURRENCY, async (item) => {
    try {
      const { content } = await downloadFile(item.path);
      if (content) {
        const notebook = JSON.parse(content);
        notebook.lastSyncedEtag = item.etag;
        return notebook;
      }
    } catch (e) {
      console.error(`Failed to download notebook ${item.notebookId}:`, e);
    }
    return null;
  });
  notebooks.push(...downloadedNotebooks.filter((n) => n));

  // Download Notes
  const downloadedNotes = await runInBatches(notesToDownload, CONCURRENCY, async (item) => {
    try {
      const { content } = await downloadFile(item.path);
      if (content) {
        const note = JSON.parse(content);
        note._currentFileEtag = item.etag;
        const decrypted = await decryptNoteFromNextcloud(note);

        // Download media files for this note
        await downloadNoteMedia(decrypted, remoteMediaMap.get(decrypted.id));

        return decrypted;
      }
    } catch (e) {
      console.error(`Failed to download note ${item.noteId}:`, e);
    }
    return null;
  });
  notes.push(...downloadedNotes.filter((n) => n));

  // Check media for unchanged notes (fix for missing images)
  // Must use getRawNote to get the full content (with fileIds) — the index stub
  // only has {id, name, type, size, deleted} with no fileId, so downloadNoteMedia
  // would skip every item and never download any binaries.
  if (mediaCheckQueue.length > 0) {
    console.log(`[Sync] Checking media for ${mediaCheckQueue.length} unchanged notes...`);
    await runInBatches(mediaCheckQueue, CONCURRENCY, async (stub) => {
      const remoteMedia = remoteMediaMap.get(stub.id);
      if (!remoteMedia || remoteMedia.length === 0) return; // no remote media, skip
      const fullNote = await getRawNote(stub.id);
      if (!fullNote) return;
      await downloadNoteMedia(fullNote, remoteMedia);
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

  return { notebooks, notes, tombstones };
}

/**
 * Merge strokes while respecting deletions
 * Prioritizes strokes from the first array (priorityStrokes) in case of conflict
 * @param {Array} priorityStrokes - Strokes from the newer/priority version
 * @param {Array} secondaryStrokes - Strokes from the older/secondary version
 * @param {Array} priorityDeleted - Deleted stroke IDs from priority version
 * @param {Array} secondaryDeleted - Deleted stroke IDs from secondary version
 * @returns {Object} Object with merged strokes and deletedStrokes arrays
 */
function mergeStrokes(
  priorityStrokes,
  secondaryStrokes,
  priorityDeleted = [],
  secondaryDeleted = [],
) {
  // Combine all deleted stroke IDs from both sides
  const allDeletedIds = new Set([...priorityDeleted, ...secondaryDeleted]);

  // Create a map of stroke ID to stroke for deduplication
  const strokesById = new Map();

  // Add priority strokes first (wins conflicts)
  for (const stroke of priorityStrokes) {
    if (stroke.id && !allDeletedIds.has(stroke.id)) {
      strokesById.set(stroke.id, stroke);
    } else if (!stroke.id) {
      // Legacy stroke without ID - keep it for now (will be migrated)
      strokesById.set(JSON.stringify(stroke), stroke);
    }
  }

  // Add secondary strokes (only if not already present)
  for (const stroke of secondaryStrokes) {
    if (stroke.id) {
      if (!allDeletedIds.has(stroke.id) && !strokesById.has(stroke.id)) {
        strokesById.set(stroke.id, stroke);
      }
    } else {
      // Legacy stroke without ID
      const key = JSON.stringify(stroke);
      if (!strokesById.has(key)) {
        strokesById.set(key, stroke);
      }
    }
  }

  return {
    strokes: Array.from(strokesById.values()),
    deletedStrokes: Array.from(allDeletedIds),
  };
}

/**
 * Attempt to merge two versions of a note
 */
export function attemptMerge(local, remote) {
  // If the local note is encrypted (worker cannot decrypt), merging is not possible.
  // Return null so the caller treats this as a conflict to be resolved on the main thread.
  if (local.encrypted) return null;

  // Guard against encrypted content blobs (e.g. index.encrypted flag may be stale).
  // If strokes or content are encrypted objects rather than expected types, abort merge.
  if (local.strokes !== undefined && !Array.isArray(local.strokes)) return null;
  if (remote.strokes !== undefined && !Array.isArray(remote.strokes)) return null;
  if (local.tags !== undefined && !Array.isArray(local.tags)) return null;
  if (remote.tags !== undefined && !Array.isArray(remote.tags)) return null;
  if (local.media !== undefined && !Array.isArray(local.media)) return null;
  if (remote.media !== undefined && !Array.isArray(remote.media)) return null;

  // Determine which note is newer based on modification time
  const localIsNewer = local.modified >= remote.modified;
  const newerNote = localIsNewer ? local : remote;

  // Merge strokes while respecting deletions from both sides
  const mergedStrokeData = mergeStrokes(
    localIsNewer ? local.strokes || [] : remote.strokes || [],
    localIsNewer ? remote.strokes || [] : local.strokes || [],
    localIsNewer ? local.deletedStrokes || [] : remote.deletedStrokes || [],
    localIsNewer ? remote.deletedStrokes || [] : local.deletedStrokes || [],
  );

  // Attempt to merge text content.
  const localContent = local.content || "";
  const remoteContent = remote.content || "";
  let mergedContent;
  if (localContent === remoteContent) {
    // Content is identical, no merge needed.
    mergedContent = localContent;
  } else if (remoteContent.includes(localContent)) {
    // The remote content contains the local content, so it's likely an append. Use remote.
    mergedContent = remoteContent;
  } else if (localContent.includes(remoteContent)) {
    // The local content contains the remote content, so it's likely an append. Use local.
    mergedContent = localContent;
  } else {
    // This is a true conflict where both texts have diverged.
    // Return null to signal that manual conflict resolution is required.
    return null;
  }

  // Merge title using "last write wins".
  const mergedTitle = local.title !== remote.title ? newerNote.title : local.title;

  // Merge background using "last write wins".
  const mergedBackground =
    local.background !== remote.background ? newerNote.background : local.background;

  // Merge tags by taking the union of both sets.
  const mergedTags = [...new Set([...(local.tags || []), ...(remote.tags || [])])];

  // Merge media
  const localMedia = local.media || [];
  const remoteMedia = remote.media || [];
  const localDeletedMedia = local.deletedMedia || [];
  const remoteDeletedMedia = remote.deletedMedia || [];

  const allDeletedMedia = new Set([...localDeletedMedia, ...remoteDeletedMedia]);
  const mediaMap = new Map();

  // Helper to add media (newer overwrites older if same ID)
  const addMedia = (items) => {
    for (const item of items) {
      if (item.id && !allDeletedMedia.has(item.id)) {
        mediaMap.set(item.id, item);
      }
    }
  };

  addMedia(localIsNewer ? remoteMedia : localMedia); // Add older first
  addMedia(localIsNewer ? localMedia : remoteMedia); // Add newer second (wins)

  // Merge recordings by ID (same pattern as media)
  const localRecordings = local.recordings || [];
  const remoteRecordings = remote.recordings || [];
  const localDeletedRecordings = local.deletedRecordings || [];
  const remoteDeletedRecordings = remote.deletedRecordings || [];

  const allDeletedRecordings = new Set([...localDeletedRecordings, ...remoteDeletedRecordings]);
  const recordingsMap = new Map();

  const addRecordings = (items) => {
    for (const item of items) {
      if (item.id && !allDeletedRecordings.has(item.fileId)) {
        recordingsMap.set(item.id, item);
      }
    }
  };

  addRecordings(localIsNewer ? remoteRecordings : localRecordings);
  addRecordings(localIsNewer ? localRecordings : remoteRecordings);

  // Merge tasks by ID, newer modified timestamp wins for individual tasks
  const localTasks = local.tasks || [];
  const remoteTasks = remote.tasks || [];
  const taskMap = new Map();

  // Add older first, then newer overwrites by ID
  const olderTasks = localIsNewer ? remoteTasks : localTasks;
  const newerTasks = localIsNewer ? localTasks : remoteTasks;
  for (const task of olderTasks) {
    taskMap.set(task.id, task);
  }
  for (const task of newerTasks) {
    const existing = taskMap.get(task.id);
    if (!existing || (task.modified || 0) >= (existing.modified || 0)) {
      taskMap.set(task.id, task);
    }
  }

  // Construct the merged note.
  return {
    id: local.id, // Keep original ID
    notebookId: local.notebookId, // Keep original notebook ID
    created: local.created, // Keep original creation timestamp

    title: mergedTitle,
    content: mergedContent,
    background: mergedBackground,
    strokes: mergedStrokeData.strokes,
    deletedStrokes: mergedStrokeData.deletedStrokes,
    media: Array.from(mediaMap.values()),
    deletedMedia: Array.from(allDeletedMedia),
    recordings: Array.from(recordingsMap.values()),
    deletedRecordings: Array.from(allDeletedRecordings),
    tags: mergedTags,
    tasks: Array.from(taskMap.values()),
    deleted: local.deleted || remote.deleted, // If deleted on either side, it's deleted

    formatVersion: newerNote.formatVersion, // Use format from newer note
    modified: Date.now(), // Set a new modification time for the merged version
    version: Math.max(local.version, remote.version) + 1, // Increment version
    synced: false, // Mark as unsynced to trigger upload
    lastSyncedEtag: remote._currentFileEtag || remote.lastSyncedEtag, // Use current file ETag for If-Match
  };
}

/**
 * Full sync: upload local changes and download remote changes
 * Uses timestamp-based conflict resolution (newer wins)
 */
export async function fullSync(localNotebooks, localNotes) {
  if (!isAuthenticated()) {
    throw new Error("Not authenticated with Nextcloud");
  }

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

  // Step 1: Download remote data first
  const remoteData = await downloadAllData(localNotebooks, localNotes);

  // Step 2: Merge notebooks (newer wins)
  const notebooksToUpload = [];
  const notebooksToDownload = [];
  const notebooksToDelete = [];
  const notesToDelete = [];
  const noteEtagsToUpdate = []; // Notes whose etag changed on server but content is not newer
  const conflicts = { notebooks: [], notes: [] };

  // Create maps for quick lookup
  const localNotebookMap = new Map(localNotebooks.map((n) => [n.id, n]));
  const remoteNotebookMap = new Map(remoteData.notebooks.map((n) => [n.id, n]));

  // Check which local notebooks should be uploaded
  for (const local of localNotebooks) {
    // PRIORITY: If notebook is purged locally, queue it for processing immediately.
    if (local.purged) {
      notebooksToUpload.push(local);
      continue;
    }

    const remote = remoteNotebookMap.get(local.id);

    if (!remote) {
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

    const isModifiedLocally = local.synced === false;
    const isModifiedRemotely = local.lastSyncedEtag !== remote.lastSyncedEtag;

    if (isModifiedLocally && isModifiedRemotely) {
      conflicts.notebooks.push({ local, remote });
    } else if (isModifiedLocally) {
      notebooksToUpload.push(local);
    } else if (isModifiedRemotely) {
      notebooksToDownload.push(remote);
    }
  }

  // Check which remote notebooks should be downloaded
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
    // PRIORITY: If note is purged locally, queue it for processing immediately.
    // This bypasses conflict checks because purge is a final destructive action.
    if (local.purged) {
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
        if (local.synced === false && !local.deleted) {
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
      } else {
        // Not in tombstone -> Missing/Corrupted -> Re-upload (Self-healing)
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
      if (local.encrypted) {
        notesToUpload.push({ ...fullLocal, lastSyncedEtag: remote._currentFileEtag });
      } else {
        const merged = attemptMerge(fullLocal, remote);
        if (merged) {
          // Use the remote's current file ETag for the upload to succeed via If-Match
          const mergedWithRemoteBase = { ...merged, lastSyncedEtag: remote._currentFileEtag };
          notesToUpload.push(mergedWithRemoteBase);

          // Save merged note locally so the client sees the merged state immediately.
          // Use saveNote (not updateNote) to avoid bumping modified/version, which would
          // falsely trigger the race-condition detector in the post-sync download phase.
          await saveNote({ ...merged, synced: false });
        } else {
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
      if (
        remote.modified &&
        local.modified &&
        remote.modified <= local.modified + 2000 &&
        !isModifiedLocally
      ) {
        console.log(
          `[Sync] Note ${local.id}: remote etag changed but remote is not newer (remote.modified=${remote.modified}, local.modified=${local.modified}). Accepting remote etag without download.`,
        );
        noteEtagsToUpdate.push({ id: local.id, etag: remote._currentFileEtag });
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
    notebooks: await syncNotebooks(notebooksToUpload),
    notes: await syncNotes(notesToUpload),
  };

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
    conflicts,
    notebooksToUpload,
    notesToUpload,
    notebooksToDelete,
    notesToDelete,
  };
}

/**
 * Delete remote notebook (marks in tombstone, doesn't actually delete folder yet)
 */
export async function deleteRemoteNotebook(notebookId) {
  if (!isAuthenticated()) {
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
  if (!isAuthenticated()) {
    throw new Error("Not authenticated with Nextcloud");
  }

  try {
    // Get paths
    const notePath = getNotePath(noteId, notebookId);
    const mediaFolder = getNoteMediaFolder(noteId, notebookId);
    const tombstonePath = notebookId
      ? getNotebookTombstonePath(notebookId)
      : getQuickNotesTombstonePath();

    // Download current tombstone
    const { content: tombstoneContent } = await downloadFile(tombstonePath);
    let tombstone = tombstoneContent ? JSON.parse(tombstoneContent) : createEmptyTombstone();

    // Add to tombstone
    tombstone = addNoteTombstone(tombstone, noteId);

    // Upload updated tombstone
    await uploadFile(tombstonePath, JSON.stringify(tombstone, null, 2));

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
  if (!isAuthenticated()) {
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
  if (!isAuthenticated()) {
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
  if (!isAuthenticated()) {
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
  if (!isAuthenticated()) {
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
  if (!isAuthenticated()) {
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
