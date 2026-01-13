/**
 * Nextcloud Sync Module
 * Uses Nextcloud Login Flow v2 and WebDAV for syncing
 * Uses Tauri's HTTP client for native requests (no CORS issues!)
 *
 * Storage Version 2: Hierarchical folder structure
 */

import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { APP_NAME, APP_VERSION } from "../config.js";
import {
  deleteSecureCredential,
  getSecureCredential,
  saveSecureCredential,
} from "./secureStorage.js";
import { isNextcloudEncryptionEnabled } from "./storage.js";
import {
  getAllRequiredFolders,
  getLegacyNotebookPath,
  getLegacyNotePath,
  getNotebookFolder,
  getNotebookNotesFolder,
  getNotebookPath,
  getNotebookTombstonePath,
  getNotePath,
  getQuickNotesTombstonePath,
  ROOT_FOLDER,
  STORAGE_VERSION,
} from "./storagePaths.js";
import { addNoteTombstone, cleanupOldTombstones, createEmptyTombstone } from "./tombstones.js";

const NEXTCLOUD_STORAGE_KEY = "nextcloud_credentials";
const LEGACY_STORAGE_KEY = "nextcloud_credentials"; // Same key used in localStorage

/**
 * Encrypt note data for Nextcloud upload if encryption is enabled
 * Handles conversion between local encryption and Nextcloud encryption formats
 * @param {Object} note - Note object (may be locally encrypted)
 * @returns {Promise<Object>} - Note object (in Nextcloud format)
 */
async function encryptNoteForNextcloud(note) {
  const shouldEncryptForNextcloud = await isNextcloudEncryptionEnabled();
  // Note is already decrypted by storage.js before reaching here
  const decryptedNote = note;

  // Step 2: Encrypt for Nextcloud if enabled
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

    // Encrypt content, strokes, and media for Nextcloud storage
    const encryptedContent = await encryptObject(decryptedNote.content || "", encryptionKey);
    const encryptedStrokes = await encryptObject(decryptedNote.strokes || [], encryptionKey);
    const encryptedMedia = await encryptObject(decryptedNote.media || [], encryptionKey);

    return {
      ...decryptedNote,
      content: encryptedContent,
      strokes: encryptedStrokes,
      media: encryptedMedia,
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

      // Only decrypt media if it exists and has the encrypted structure
      // (notes encrypted before media support won't have this field)
      let decryptedMedia = [];
      if (note.media && typeof note.media === 'object' && note.media.data && note.media.iv) {
        decryptedMedia = await decryptObject(note.media, encryptionKey);
      }

      decryptedNote = {
        ...note,
        content: decryptedContent,
        strokes: decryptedStrokes,
        media: decryptedMedia,
        nextcloudEncrypted: undefined, // Remove Nextcloud encryption flag
      };
    } catch (error) {
      console.error("[NextcloudSync] Failed to decrypt note from Nextcloud:", error);
      throw new Error("Failed to decrypt note from Nextcloud");
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
  console.log("[MIGRATION] Starting credential migration check...");
  try {
    // Check if credentials exist in localStorage
    const legacyCredString = localStorage.getItem(LEGACY_STORAGE_KEY);
    console.log("[MIGRATION] localStorage credentials:", legacyCredString ? "found" : "not found");

    if (!legacyCredString) {
      console.log("[MIGRATION] No legacy credentials found, skipping migration");
      return;
    }

    // Check if credentials already exist in secure storage
    console.log("[MIGRATION] Checking if credentials already exist in secure storage...");
    const existingCreds = await getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    console.log("[MIGRATION] Existing secure credentials:", existingCreds ? "found" : "not found");

    if (existingCreds) {
      console.log(
        "[MIGRATION] Credentials already exist in secure storage, cleaning up localStorage",
      );
      // Clean up localStorage since migration already happened
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }

    // Migrate to secure storage
    console.log("[MIGRATION] Migrating credentials from localStorage to secure storage...");
    console.log("[MIGRATION] Credentials to migrate:", `${legacyCredString.substring(0, 50)}...`);
    await saveSecureCredential(NEXTCLOUD_STORAGE_KEY, legacyCredString);
    console.log("[MIGRATION] Credentials saved to secure storage");

    // Remove from localStorage after successful migration
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    console.log("[MIGRATION] Migration complete, localStorage cleaned up");
  } catch (error) {
    console.error("[MIGRATION] Failed to migrate credentials:", error);
    console.error("[MIGRATION] Error details:", error.message, error.stack);
    // Don't throw - we don't want to break app startup if migration fails
    // User can still log in again manually
  }
}

/**
 * Get stored Nextcloud credentials from secure storage
 */
export async function getStoredCredentials() {
  try {
    console.log("[NextcloudSync] Getting credentials from secure storage...");
    const credString = await getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    console.log("[NextcloudSync] Credential string retrieved:", credString ? "YES" : "NO");

    if (credString) {
      const parsed = JSON.parse(credString);
      console.log("[NextcloudSync] Parsed credentials:", {
        hasServerUrl: !!parsed.serverUrl,
        hasLoginName: !!parsed.loginName,
        hasAppPassword: !!parsed.appPassword,
      });
      return parsed;
    }

    console.log("[NextcloudSync] No credentials found in secure storage");
    return null;
  } catch (error) {
    console.error("[NextcloudSync] Failed to get credentials from secure storage:", error);
    return null;
  }
}

/**
 * Save Nextcloud credentials to secure storage
 */
async function saveCredentials(credentials) {
  try {
    console.log("[NextcloudSync] Saving credentials to secure storage:", {
      hasServerUrl: !!credentials.serverUrl,
      hasLoginName: !!credentials.loginName,
      hasAppPassword: !!credentials.appPassword,
    });
    const credString = JSON.stringify(credentials);
    console.log("[NextcloudSync] Credential JSON length:", credString.length);
    await saveSecureCredential(NEXTCLOUD_STORAGE_KEY, credString);
    console.log("[NextcloudSync] Credentials saved successfully to keyring");

    // VERIFICATION: Immediately read back to verify save worked
    console.log("[NextcloudSync] VERIFICATION: Reading back immediately after save...");
    const verifyRead = await getSecureCredential(NEXTCLOUD_STORAGE_KEY);
    console.log(
      "[NextcloudSync] VERIFICATION: Read back result:",
      verifyRead ? "SUCCESS" : "FAILED (null)",
    );
    if (!verifyRead) {
      console.error(
        "[NextcloudSync] CRITICAL: Credential save verification FAILED - credential not in keyring!",
      );
    }
  } catch (error) {
    console.error("[NextcloudSync] Failed to save credentials to secure storage:", error);
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
  return creds?.serverUrl && creds.loginName && creds.appPassword;
}

/**
 * Test connection to Nextcloud server
 */
export async function testConnection(serverUrl) {
  serverUrl = serverUrl.replace(/\/$/, "");

  try {
    const response = await fetch(`${serverUrl}/status.php`);
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
      initResponse = await fetch(`${serverUrl}/index.php/login/v2`, {
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

        const response = await fetch(pollUrl, {
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

  console.log("Creating folder with credentials:", {
    serverUrl: creds.serverUrl,
    loginName: creds.loginName,
    hasAppPassword: !!creds.appPassword,
  });

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const authHeader = `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`;
  console.log("Auth header preview:", `${authHeader.substring(0, 20)}...`);

  const response = await fetch(webdavUrl, {
    method: "MKCOL",
    headers: {
      Authorization: authHeader,
      "OCS-APIRequest": "true",
    },
  });

  console.log("MKCOL response status:", response.status);

  if (!response.ok && response.status !== 201 && response.status !== 405) {
    const responseText = await response.text();
    console.log("MKCOL error response:", responseText);
  }

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
  };

  // Set modification time if provided (Nextcloud-specific header)
  if (mtime) {
    headers["X-OC-Mtime"] = Math.floor(new Date(mtime).getTime() / 1000).toString();
  }

  // Use ETag to prevent overwriting changes (If-Match)
  if (etag) {
    headers["If-Match"] = `"${etag}"`;
  }

  let response = await fetch(webdavUrl, {
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
    response = await fetch(webdavUrl, {
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
      const headResponse = await fetch(webdavUrl, {
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
async function downloadFile(path) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await fetch(webdavUrl, {
    method: "GET",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
    },
  });

  if (response.status === 404) {
    return { content: null, etag: null };
  }

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();
  const etag = response.headers.get("etag")?.replace(/"/g, "");
  return { content, etag };
}

/**
 * List files in a folder using WebDAV PROPFIND
 */
export async function listFiles(path) {
  const creds = await getStoredCredentials();
  if (!creds) throw new Error("Not authenticated");

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await fetch(webdavUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      Depth: "1",
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

  const response = await fetch(webdavUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      Depth: "1",
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
 * Parse WebDAV XML response
 */
function parseWebDAVResponse(xmlText, includeCollections = false) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const responses = doc.getElementsByTagName("d:response");

  const files = [];
  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    const href = response.getElementsByTagName("d:href")[0]?.textContent;
    const resourceType = response.getElementsByTagName("d:resourcetype")[0];
    const isCollection = resourceType?.getElementsByTagName("d:collection").length > 0;
    const lastModified = response.getElementsByTagName("d:getlastmodified")[0]?.textContent;
    const etag = response.getElementsByTagName("d:getetag")[0]?.textContent;

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

    if (href) {
      files.push({
        name,
        href,
        isCollection,
        lastModified: lastModified ? new Date(lastModified).getTime() : null,
        etag: etag?.replace(/"/g, ""),
      });
    }
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

  const response = await fetch(webdavUrl, {
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

  const results = {
    uploaded: 0,
    failed: 0,
    errors: [],
    uploadedIds: [],
    metadata: {},
  };

  for (const notebook of notebooks) {
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
      results.uploaded++;
      results.uploadedIds.push(notebook.id);
      results.metadata[notebook.id] = { etag: typeof etag === "string" ? etag : null };
    } catch (error) {
      results.failed++;
      results.errors.push({ id: notebook.id, error: error.message });
      console.error(`Failed to sync notebook ${notebook.id}:`, error);
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

  const results = {
    uploaded: 0,
    failed: 0,
    errors: [],
    uploadedIds: [],
    metadata: {},
  };

  for (const note of notes) {
    try {
      // Get the correct path based on whether note is in a notebook or is a quick note
      const path = getNotePath(note.id, note.notebookId);

      console.log(`Uploading note ${note.id} (${note.title}) to ${path}`);

      const syncedNote = {
        ...note,
        synced: true,
        // Keep original modified timestamp to preserve history
      };

      // Encrypt note for Nextcloud if encryption is enabled
      const encryptedNote = await encryptNoteForNextcloud(syncedNote);

      // Strip internal sync tracking fields before uploading
      const {
        lastSyncedEtag: _,
        synced: __,
        encrypted: ___,
        _currentFileEtag: ____,
        ...noteForUpload
      } = encryptedNote;

      // Prepare content
      const content = JSON.stringify(noteForUpload, null, 2);

      const etag = await uploadFile(path, content, syncedNote.modified, note.lastSyncedEtag);
      results.uploaded++;
      results.uploadedIds.push(note.id);
      results.metadata[note.id] = { etag: typeof etag === "string" ? etag : null };
      console.log(`Successfully uploaded note ${note.id}`);
    } catch (error) {
      results.failed++;
      results.errors.push({ id: note.id, error: error.message });
      console.error(`Failed to sync note ${note.id}:`, error);
    }
  }

  return results;
}

/**
 * Download all data from Nextcloud (hierarchical structure)
 */
export async function downloadAllData() {
  if (!isAuthenticated()) {
    throw new Error("Not authenticated with Nextcloud");
  }

  const notebooks = [];
  const notes = [];
  const tombstones = new Map(); // Map of notebookId -> tombstone data

  // Step 1: List all notebook folders (need to include collections/folders)
  const notebookFolders = await listFolders(`${ROOT_FOLDER}/notebooks`);

  // Step 2: Download each notebook and its notes
  for (const folder of notebookFolders) {
    try {
      // Skip if not a folder (we only expect folders here, but WebDAV might include files)
      if (!folder.name || folder.name.includes(".")) {
        continue;
      }

      const notebookId = folder.name;

      // Download notebook metadata
      const notebookPath = getNotebookPath(notebookId);
      const { content: notebookContent, etag: notebookEtag } = await downloadFile(notebookPath);

      if (notebookContent) {
        const notebook = JSON.parse(notebookContent);
        notebook.lastSyncedEtag = notebookEtag;
        notebooks.push(notebook);
      }

      // Download tombstones for this notebook
      const tombstonePath = getNotebookTombstonePath(notebookId);
      const { content: tombstoneContent } = await downloadFile(tombstonePath);

      if (tombstoneContent) {
        tombstones.set(notebookId, JSON.parse(tombstoneContent));
      }

      // Download notes in this notebook
      const noteFiles = await listFiles(getNotebookNotesFolder(notebookId));

      for (const noteFile of noteFiles) {
        try {
          // Skip media folders and tombstone files
          if (
            noteFile.name.includes("_media") ||
            noteFile.name === "_tombstones.json" ||
            !noteFile.name.endsWith(".json")
          ) {
            continue;
          }

          const noteId = noteFile.name.replace(".json", "");
          const notePath = getNotePath(noteId, notebookId);
          const { content: noteContent, etag: noteEtag } = await downloadFile(notePath);

          if (noteContent) {
            const note = JSON.parse(noteContent);
            // Store both the etag from the note's JSON content (for conflict detection)
            // and the current file etag (for upload conditional requests)
            note._currentFileEtag = noteEtag || noteFile.etag;
            // Keep the lastSyncedEtag from the note's JSON content (don't overwrite it)

            // Decrypt note if it's encrypted for Nextcloud
            const decryptedNote = await decryptNoteFromNextcloud(note);
            notes.push(decryptedNote);
          }
        } catch (error) {
          console.error(`Failed to download note ${noteFile.name}:`, error);
        }
      }
    } catch (error) {
      console.error(`Failed to process notebook ${folder.name}:`, error);
    }
  }

  // Step 3: Download quick notes
  try {
    const quickNoteFiles = await listFiles(`${ROOT_FOLDER}/quickNotes`);

    for (const noteFile of quickNoteFiles) {
      try {
        // Skip media folders and tombstone files
        if (
          noteFile.name.includes("_media") ||
          noteFile.name === "_tombstones.json" ||
          !noteFile.name.endsWith(".json")
        ) {
          continue;
        }

        const noteId = noteFile.name.replace(".json", "");
        const notePath = getNotePath(noteId, null);
        const { content: noteContent, etag: noteEtag } = await downloadFile(notePath);

        if (noteContent) {
          const note = JSON.parse(noteContent);
          // Store both the etag from the note's JSON content (for conflict detection)
          // and the current file etag (for upload conditional requests)
          note._currentFileEtag = noteEtag || noteFile.etag;
          // Keep the lastSyncedEtag from the note's JSON content (don't overwrite it)

          // Decrypt note if it's encrypted for Nextcloud
          const decryptedNote = await decryptNoteFromNextcloud(note);
          notes.push(decryptedNote);
        }
      } catch (error) {
        console.error(`Failed to download quick note ${noteFile.name}:`, error);
      }
    }

    // Download quick notes tombstones
    const quickTombstonePath = getQuickNotesTombstonePath();
    const { content: quickTombstoneContent } = await downloadFile(quickTombstonePath);

    if (quickTombstoneContent) {
      tombstones.set("quickNotes", JSON.parse(quickTombstoneContent));
    }
  } catch (error) {
    console.error("Failed to process quick notes:", error);
  }

  return { notebooks, notes, tombstones };
}

/**
 * Merge strokes while respecting deletions
 * @param {Array} localStrokes - Local strokes array
 * @param {Array} remoteStrokes - Remote strokes array
 * @param {Array} localDeleted - Local deleted stroke IDs
 * @param {Array} remoteDeleted - Remote deleted stroke IDs
 * @returns {Object} Object with merged strokes and deletedStrokes arrays
 */
function mergeStrokes(localStrokes, remoteStrokes, localDeleted = [], remoteDeleted = []) {
  // Combine all deleted stroke IDs from both sides
  const allDeletedIds = new Set([...localDeleted, ...remoteDeleted]);

  // Create a map of stroke ID to stroke for deduplication
  const strokesById = new Map();

  // Add remote strokes (but skip deleted ones)
  for (const stroke of remoteStrokes) {
    if (stroke.id && !allDeletedIds.has(stroke.id)) {
      strokesById.set(stroke.id, stroke);
    } else if (!stroke.id) {
      // Legacy stroke without ID - keep it for now (will be migrated)
      strokesById.set(JSON.stringify(stroke), stroke);
    }
  }

  // Add local strokes (but skip deleted ones and duplicates)
  for (const stroke of localStrokes) {
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
function attemptMerge(local, remote) {
  // Merge strokes while respecting deletions from both sides
  const mergedStrokeData = mergeStrokes(
    local.strokes || [],
    remote.strokes || [],
    local.deletedStrokes || [],
    remote.deletedStrokes || [],
  );

  // Determine which note is newer based on modification time.
  const newerNote = remote.modified > local.modified ? remote : local;

  // Attempt to merge text content.
  let mergedContent;
  if (local.content === remote.content) {
    // Content is identical, no merge needed.
    mergedContent = local.content;
  } else if (remote.content.includes(local.content)) {
    // The remote content contains the local content, so it's likely an append. Use remote.
    mergedContent = remote.content;
  } else if (local.content.includes(remote.content)) {
    // The local content contains the remote content, so it's likely an append. Use local.
    mergedContent = local.content;
  } else {
    // This is a true conflict where both texts have diverged.
    // We apply a "last write wins" strategy based on the note's modified timestamp.
    // This handles the case where one client changed text and another changed strokes,
    // by picking the content from the more recent change.
    mergedContent = newerNote.content;
  }

  // Merge title using "last write wins".
  const mergedTitle = local.title !== remote.title ? newerNote.title : local.title;

  // Merge tags by taking the union of both sets.
  const mergedTags = [...new Set([...(local.tags || []), ...(remote.tags || [])])];

  // Construct the merged note.
  return {
    id: local.id, // Keep original ID
    notebookId: local.notebookId, // Keep original notebook ID
    created: local.created, // Keep original creation timestamp

    title: mergedTitle,
    content: mergedContent,
    strokes: mergedStrokeData.strokes,
    deletedStrokes: mergedStrokeData.deletedStrokes,
    tags: mergedTags,
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

  // Step 1: Download remote data first
  const remoteData = await downloadAllData();

  // Step 2: Merge notebooks (newer wins)
  const notebooksToUpload = [];
  const notebooksToDownload = [];
  const notebooksToDelete = [];
  const notesToDelete = [];
  const conflicts = { notebooks: [], notes: [] };

  // Create maps for quick lookup
  const localNotebookMap = new Map(localNotebooks.map((n) => [n.id, n]));
  const remoteNotebookMap = new Map(remoteData.notebooks.map((n) => [n.id, n]));

  // Check which local notebooks should be uploaded
  for (const local of localNotebooks) {
    const remote = remoteNotebookMap.get(local.id);

    if (!remote) {
      // Check if deleted remotely (via tombstone) - Notebook tombstones are stored inside the notebook folder usually,
      // but if the notebook folder is gone, we can't read it.
      // However, deleteRemoteNotebook implementation currently just marks it in the tombstone inside the folder.
      // If the folder is gone, we assume it's deleted.
      // But here we rely on downloadAllData which lists folders.
      // If a notebook is missing from remoteData, it means the folder is missing or empty/invalid.

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
    const remote = remoteNoteMap.get(local.id);

    if (!remote) {
      // Check tombstones to see if it was deleted remotely
      const tombstoneKey = local.notebookId || "quickNotes";
      const tombstone = remoteData.tombstones.get(tombstoneKey);
      const isDeletedRemotely = tombstone?.notes?.some((t) => t.id === local.id);

      if (isDeletedRemotely) {
        if (local.synced === false) {
          // Conflict: Deleted remotely, Modified locally. Strategy: Restore (re-upload).
          console.log(
            `[Sync] Note ${local.id} was deleted remotely but modified locally. Restoring.`,
          );
          notesToUpload.push({ ...local, lastSyncedEtag: null });
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
        notesToUpload.push({ ...local, lastSyncedEtag: null });
      }
      continue;
    }

    const isModifiedLocally = local.synced === false;
    // A note is modified remotely if the current file etag differs from our last synced etag
    // Since we don't store lastSyncedEtag in Nextcloud JSON, we compare with _currentFileEtag
    const isModifiedRemotely = local.lastSyncedEtag !== remote._currentFileEtag;

    if (isModifiedLocally && isModifiedRemotely) {
      const merged = attemptMerge(local, remote);
      if (merged) {
        // Use the remote's current file ETag for the upload to succeed via If-Match
        const mergedWithRemoteBase = { ...merged, lastSyncedEtag: remote._currentFileEtag };
        notesToUpload.push(mergedWithRemoteBase);
      } else {
        conflicts.notes.push({ local, remote });
      }
    } else if (isModifiedLocally) {
      notesToUpload.push(local);
    } else if (isModifiedRemotely) {
      notesToDownload.push(remote);
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
    // For now, we could either:
    // 1. Actually delete the folder (lose data)
    // 2. Just mark all notes as deleted in tombstone
    // Let's implement option 2 for safety

    // Download current tombstone
    const tombstonePath = getNotebookTombstonePath(notebookId);
    const { content: tombstoneContent } = await downloadFile(tombstonePath);

    const tombstone = tombstoneContent ? JSON.parse(tombstoneContent) : createEmptyTombstone();

    // Mark notebook itself as deleted
    tombstone.notebookDeleted = true;
    tombstone.notebookDeletedAt = new Date().toISOString();

    // Upload updated tombstone
    await uploadFile(tombstonePath, JSON.stringify(tombstone, null, 2));

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
