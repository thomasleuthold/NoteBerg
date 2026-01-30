/**
 * Storage Module
 * IndexedDB wrapper for notes, notebooks, and settings
 */

import { openDB } from "idb";

export const DB_NAME = "oneJournal";
export const DB_VERSION = 3;

let db = null;

/**
 * Initialize the database
 */
export async function initStorage() {
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // Create notebooks store
      if (!database.objectStoreNames.contains("notebooks")) {
        const notebookStore = database.createObjectStore("notebooks", { keyPath: "id" });
        notebookStore.createIndex("created", "created");
        notebookStore.createIndex("modified", "modified");
      }

      // Create notes store
      if (!database.objectStoreNames.contains("notes")) {
        const noteStore = database.createObjectStore("notes", { keyPath: "id" });
        noteStore.createIndex("notebookId", "notebookId");
        noteStore.createIndex("created", "created");
        noteStore.createIndex("modified", "modified");
      }

      // Create settings store
      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }

      // Create sync queue store
      if (!database.objectStoreNames.contains("syncQueue")) {
        const syncStore = database.createObjectStore("syncQueue", {
          keyPath: "id",
          autoIncrement: true,
        });
        syncStore.createIndex("timestamp", "timestamp");
      }

      // Create files store for binary data (blobs)
      if (!database.objectStoreNames.contains("files")) {
        database.createObjectStore("files", { keyPath: "id" });
      }
    },
  });

  console.log("Storage initialized");

  // Run migrations
  await migrateStrokeIds();

  return db;
}

/**
 * Migrate existing strokes to add IDs
 * This ensures all strokes have unique IDs for deletion tracking
 */
async function migrateStrokeIds() {
  if (!db) return;

  try {
    const notes = await db.getAll("notes");
    let migratedCount = 0;

    for (const note of notes) {
      let needsUpdate = false;

      // Check if any strokes are missing IDs
      if (note.strokes && Array.isArray(note.strokes)) {
        for (const stroke of note.strokes) {
          if (!stroke.id) {
            stroke.id = generateIdHelper(); // Use helper to avoid circular dependency
            needsUpdate = true;
          }
        }
      }

      // Initialize deletedStrokes array if it doesn't exist
      if (!note.deletedStrokes) {
        note.deletedStrokes = [];
        needsUpdate = true;
      }

      if (needsUpdate) {
        await db.put("notes", note);
        migratedCount++;
      }
    }

    if (migratedCount > 0) {
      console.log(`Migrated stroke IDs for ${migratedCount} notes`);
    }
  } catch (error) {
    console.error("Failed to migrate stroke IDs:", error);
  }
}

/**
 * Helper to generate ID (used during migration before generateId is defined)
 */
function generateIdHelper() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a UUID v4
 * Uses crypto.randomUUID() if available, falls back to polyfill for non-secure contexts
 */
export function generateId() {
  // Try native crypto.randomUUID() first (works in secure contexts and Tauri)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch (e) {
      console.warn("crypto.randomUUID() failed, falling back to polyfill", e);
    }
  }

  // Fallback for non-secure contexts (HTTP dev server on mobile)
  // Generate UUID v4 using crypto.getRandomValues or Math.random as last resort
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    // Use crypto.getRandomValues for better randomness
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
    );
  }

  // Last resort: Math.random (less secure but works everywhere)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ========== Notebook Operations ==========

/**
 * Create a new notebook
 */
export async function createNotebook({ title, description = "", color = "#3b82f6" }) {
  const notebook = {
    id: generateId(),
    title,
    description,
    color,
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    synced: false,
    lastSyncedEtag: null,
    deleted: false,
  };

  await db.put("notebooks", notebook);
  console.log("Notebook created:", notebook.id);

  // Dispatch event for auto-sync
  window.dispatchEvent(
    new CustomEvent("notebook-created", { detail: { notebookId: notebook.id } }),
  );

  return notebook;
}

/**
 * Get all notebooks (non-deleted)
 */
export async function getAllNotebooks() {
  const notebooks = await db.getAll("notebooks");
  return notebooks.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get all notebooks including deleted/tombstones (for sync)
 */
export async function getAllNotebooksForSync() {
  const notebooks = await db.getAll("notebooks");
  return notebooks.sort((a, b) => b.modified - a.modified);
}

/**
 * Get a notebook by ID
 */
export async function getNotebook(id) {
  return db.get("notebooks", id);
}

/**
 * Update a notebook
 */
export async function updateNotebook(id, updates) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) throw new Error("Notebook not found");

  const updated = {
    ...notebook,
    ...updates,
    modified: Date.now(),
    version: (notebook.version || 0) + 1,
    synced: false,
  };

  await db.put("notebooks", updated);
  console.log("Notebook updated:", id);
  return updated;
}

/**
 * Delete a notebook (soft delete) and all its notes
 */
export async function deleteNotebook(id) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) throw new Error("Notebook not found");

  // Mark notebook as deleted
  notebook.deleted = true;
  notebook.modified = Date.now();
  notebook.version = (notebook.version || 0) + 1;
  notebook.synced = false;

  await db.put("notebooks", notebook);

  // Also delete all notes in this notebook
  const notes = await db.getAllFromIndex("notes", "notebookId", id);
  const timestamp = Date.now();

  for (const note of notes) {
    if (!note.deleted) {
      note.deleted = true;
      note.modified = timestamp;
      note.version = (note.version || 0) + 1;
      note.synced = false;
      await db.put("notes", note);
    }
  }

  console.log(`Notebook deleted: ${id} (with ${notes.length} notes)`);
  return notebook;
}

/**
 * Purge a notebook (mark for permanent deletion)
 * This also purges all notes within the notebook
 */
export async function purgeNotebook(id) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) return;

  // Purge all notes in this notebook first
  const notes = await db.getAllFromIndex("notes", "notebookId", id);
  for (const note of notes) {
    await purgeNote(note.id);
  }

  // Create a purged stub for the notebook
  const stub = {
    id: notebook.id,
    title: notebook.title, // Keep title for logs/debugging
    purged: true,
    deleted: true,
    synced: false, // Mark as unsynced to trigger upload/processing
    modified: Date.now(),
    lastSyncedEtag: notebook.lastSyncedEtag,
  };

  await db.put("notebooks", stub);
  console.log("Notebook purged (stubbed):", id);
}

/**
 * Permanently delete a notebook record from the database (after sync)
 */
export async function permanentlyDeleteNotebook(id) {
  await db.delete("notebooks", id);
  console.log("Notebook permanently deleted from DB:", id);
}

// ========== Note Operations ==========

/**
 * Create a new note
 */
export async function createNote({ title, notebookId = null }) {
  const note = {
    id: generateId(),
    notebookId,
    title,
    content: "", // Markdown content
    strokes: [], // Array of drawing strokes
    media: [], // Array of media items (images, pdf pages)
    deletedMedia: [], // Array of deleted media IDs
    formatVersion: 1, // Stroke format version
    background: "none", // Background pattern: none, ruled-narrow, ruled-medium, ruled-wide, grid-small, grid-medium, grid-large
    created: Date.now(),
    modified: Date.now(),
    version: 1,
    synced: false,
    lastSyncedEtag: null,
    deleted: false,
    tags: [],
  };

  // Encrypt note data if local encryption is enabled
  const encryptedNote = await encryptNoteIfEnabled(note);
  await db.put("notes", encryptedNote);
  console.log("Note created:", note.id);

  // Dispatch event for auto-sync
  window.dispatchEvent(new CustomEvent("note-created", { detail: { noteId: note.id } }));

  return note; // Return unencrypted note to caller
}

/**
 * Get all notes (non-deleted)
 */
export async function getAllNotes() {
  const notes = await db.getAll("notes");
  const filtered = notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);

  // Decrypt notes if needed
  const decrypted = await Promise.all(filtered.map((note) => decryptNoteIfNeeded(note)));
  return decrypted;
}

/**
 * Get all notes including deleted/tombstones (for sync)
 * Returns notes in their stored form (encrypted or plain text)
 * The sync layer will handle Nextcloud encryption separately
 */
export async function getAllNotesForSync() {
  if (!db) await initStorage();
  const notes = await db.getAll("notes");
  // Decrypt all notes before sync so the sync logic can read/merge content
  return await Promise.all(notes.map((note) => decryptNoteIfNeeded(note)));
}

/**
 * Get notes by notebook ID
 */
export async function getNotesByNotebook(notebookId) {
  const notes = await db.getAllFromIndex("notes", "notebookId", notebookId);
  const filtered = notes.filter((n) => !n.deleted).sort((a, b) => b.modified - a.modified);

  // Decrypt notes if needed
  const decrypted = await Promise.all(filtered.map((note) => decryptNoteIfNeeded(note)));
  return decrypted;
}

/**
 * Get quick notes (notes without a notebook)
 */
export async function getQuickNotes() {
  // Get all notes and filter for those without a notebook
  const allNotes = await db.getAll("notes");
  const quickNotes = allNotes.filter((n) => !n.deleted && n.notebookId === null);
  const sorted = quickNotes.sort((a, b) => b.modified - a.modified);

  // Decrypt notes if needed
  const decrypted = await Promise.all(sorted.map((note) => decryptNoteIfNeeded(note)));
  return decrypted;
}

/**
 * Get a note by ID
 */
export async function getNote(id) {
  const note = await db.get("notes", id);
  return await decryptNoteIfNeeded(note);
}

/**
 * Update a note
 */
export async function updateNote(id, updates) {
  const note = await db.get("notes", id);
  if (!note) throw new Error("Note not found");

  // Decrypt the existing note if needed (to merge updates properly)
  const decryptedNote = await decryptNoteIfNeeded(note);

  const updated = {
    ...decryptedNote,
    ...updates,
    modified: Date.now(),
    version: (decryptedNote.version || 0) + 1,
    synced: false,
  };

  // Encrypt before saving
  const encryptedNote = await encryptNoteIfEnabled(updated);
  await db.put("notes", encryptedNote);
  console.log("Note updated:", id);

  // Dispatch event for auto-sync and live updates
  window.dispatchEvent(new CustomEvent("datachange", { detail: { noteId: id } }));

  return updated; // Return unencrypted version to caller
}

/**
 * Delete a note (soft delete)
 */
export async function deleteNote(id) {
  const note = await db.get("notes", id);
  if (!note) throw new Error("Note not found");

  note.deleted = true;
  note.modified = Date.now();
  note.version = (note.version || 0) + 1;
  note.synced = false;

  await db.put("notes", note);
  console.log("Note deleted:", id);
  return note;
}

/**
 * Purge a note (mark for permanent deletion and remove content/media)
 * This keeps a stub to ensure the deletion is synced to Nextcloud
 */
export async function purgeNote(id) {
  const note = await db.get("notes", id);
  if (!note) return;

  // Delete local media files immediately to free space
  // Handle both encrypted and unencrypted media arrays
  let mediaItems = [];
  try {
    // If note is encrypted, decrypt to access media array
    if (note.encrypted) {
      const decrypted = await decryptNoteIfNeeded(note);
      if (decrypted?.media && Array.isArray(decrypted.media)) {
        mediaItems = decrypted.media;
      }
    } else if (note.media && Array.isArray(note.media)) {
      mediaItems = note.media;
    }
  } catch (e) {
    // If decryption fails (app locked), media files will be orphaned
    // but purge should still proceed to maintain data consistency
    console.warn("[Storage] Could not decrypt note for media cleanup during purge:", e);
  }

  for (const item of mediaItems) {
    if (item.fileId) {
      await deleteFile(item.fileId);
    }
  }

  // Create a purged stub
  const stub = {
    id: note.id,
    notebookId: note.notebookId,
    purged: true, // Flag for sync
    deleted: true,
    synced: false, // Mark as unsynced to trigger upload/processing
    modified: Date.now(),
    lastSyncedEtag: note.lastSyncedEtag,
    _currentFileEtag: note._currentFileEtag,
  };

  await db.put("notes", stub);
  console.log("Note purged (stubbed):", id);
}

/**
 * Permanently delete a note record from the database (after sync)
 */
export async function permanentlyDeleteNote(id) {
  await db.delete("notes", id);
  console.log("Note permanently deleted from DB:", id);
}

/**
 * Permanently delete all notes belonging to a notebook (used when purging notebook)
 */
export async function permanentlyDeleteNotesInNotebook(notebookId) {
  const notes = await db.getAllFromIndex("notes", "notebookId", notebookId);
  for (const note of notes) {
    await db.delete("notes", note.id);
    console.log("Note permanently deleted from DB:", note.id);
  }
}

// ========== Recycle Bin Operations ==========

/**
 * Get all deleted notebooks
 */
export async function getDeletedNotebooks() {
  const allNotebooks = await db.getAll("notebooks");
  // Filter out notebooks that are already purged (stubs)
  return allNotebooks.filter((n) => n.deleted && !n.purged).sort((a, b) => b.modified - a.modified);
}

/**
 * Get all deleted notes
 */
export async function getDeletedNotes() {
  const allNotes = await db.getAll("notes");
  // Filter out notes that are already purged (stubs)
  return allNotes.filter((n) => n.deleted && !n.purged).sort((a, b) => b.modified - a.modified);
}

/**
 * Restore a deleted notebook
 */
export async function restoreNotebook(id) {
  const notebook = await db.get("notebooks", id);
  if (!notebook) throw new Error("Notebook not found");

  notebook.deleted = false;
  notebook.modified = Date.now();
  notebook.version = (notebook.version || 0) + 1;
  notebook.synced = false;

  await db.put("notebooks", notebook);
  console.log("Notebook restored:", id);
  return notebook;
}

/**
 * Restore a deleted note
 */
export async function restoreNote(id) {
  const note = await db.get("notes", id);
  if (!note) throw new Error("Note not found");

  note.deleted = false;
  note.modified = Date.now();
  note.version = (note.version || 0) + 1;
  note.synced = false;

  await db.put("notes", note);
  console.log("Note restored:", id);
  return note;
}

// ========== File/Blob Operations ==========

/**
 * Save a binary file (blob)
 * @param {Blob} blob - The file data
 * @param {string} [id] - Optional ID (if syncing from server)
 * @returns {Promise<string>} - The file ID
 */
export async function saveFile(blob, id = null) {
  const fileId = id || generateId();

  // Convert Blob to ArrayBuffer for maximum compatibility
  // Some mobile WebViews have issues storing Blobs directly in IndexedDB
  let dataToStore = blob;
  const mimeType = blob.type;

  if (blob instanceof Blob) {
    try {
      dataToStore = await blob.arrayBuffer();
    } catch (e) {
      console.warn(
        "[Storage] Failed to convert Blob to ArrayBuffer, trying FileReader fallback",
        e,
      );
      dataToStore = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
    }
  }

  await db.put("files", { id: fileId, data: dataToStore, type: mimeType, created: Date.now() });
  return fileId;
}

/**
 * Get a binary file (blob) by ID
 */
export async function getFile(id) {
  const record = await db.get("files", id);
  if (!record) return null;

  // If stored as ArrayBuffer (new format), convert back to Blob
  if (record.data instanceof ArrayBuffer) {
    return new Blob([record.data], { type: record.type || "application/octet-stream" });
  }

  // If stored as Blob (legacy/direct support), return as is
  return record.data;
}

/**
 * Check if a file exists in storage without loading it
 * @param {string} id - File ID
 * @returns {Promise<boolean>}
 */
export async function checkFileExists(id) {
  const count = await db.count("files", id);
  return count > 0;
}

/**
 * Delete a binary file
 */
export async function deleteFile(id) {
  await db.delete("files", id);
}

// ========== Settings Operations ==========

/**
 * Get a setting value
 */
export async function getSetting(key) {
  const setting = await db.get("settings", key);
  return setting ? setting.value : null;
}

/**
 * Set a setting value
 */
export async function setSetting(key, value) {
  await db.put("settings", { key, value });
  console.log("Setting saved:", key);
}

/**
 * Get storage version
 * Returns 1 for flat structure, 2 for hierarchical
 */
export async function getStorageVersion() {
  const version = await getSetting("storageVersion");
  return version || 1; // Default to v1 if not set
}

/**
 * Set storage version
 */
export async function setStorageVersion(version) {
  await setSetting("storageVersion", version);
  console.log("Storage version set to:", version);
}

// ========== Utility Functions ==========

/**
 * Get storage statistics
 */
export async function getStorageStats() {
  const notebooks = await getAllNotebooks();
  const notes = await getAllNotes();

  return {
    notebookCount: notebooks.length,
    noteCount: notes.length,
    quickNoteCount: notes.filter((n) => !n.notebookId).length,
  };
}

/**
 * Clear all data (for debugging/testing)
 */
export async function clearAllData() {
  await db.clear("notebooks");
  await db.clear("notes");
  await db.clear("settings");
  await db.clear("syncQueue");
  console.log("All data cleared");
}

/**
 * Purge only user data (notebooks and notes), preserve settings
 * Use this to reset local data before downloading from server
 */
export async function purgeLocalData() {
  if (!db) {
    throw new Error("Database not initialized. Call initStorage() first.");
  }

  await db.clear("notebooks");
  await db.clear("notes");
  await db.clear("syncQueue");

  const notebooksAfterPurge = await db.getAll("notebooks");
  const notesAfterPurge = await db.getAll("notes");

  if (notebooksAfterPurge.length > 0 || notesAfterPurge.length > 0) {
    throw new Error("Purge failed: Data still exists after clear operation!");
  }
}

/**
 * Save or update a notebook from sync
 * @param {Object} notebook - Notebook object to save
 */
export async function saveNotebook(notebook) {
  await db.put("notebooks", notebook);
}

/**
 * Save or update a note from sync
 * @param {Object} note - Note object to save
 * @param {Object} options - Save options
 * @param {boolean} options.skipEncryption - If true, skip encryption (note is already in correct format)
 */
export async function saveNote(note, options = {}) {
  const { skipEncryption = false } = options;

  // If skipEncryption is true, save note as-is (it's already in the correct format)
  if (skipEncryption) {
    await db.put("notes", note);
  } else {
    // Encrypt note before saving if local encryption is enabled
    const encryptedNote = await encryptNoteIfEnabled(note);
    await db.put("notes", encryptedNote);
  }

  // Dispatch event for auto-sync and live updates
  window.dispatchEvent(new CustomEvent("datachange", { detail: { noteId: note.id } }));
}

/**
 * Check if local data encryption is enabled
 * @returns {Promise<boolean>}
 */
export async function isLocalEncryptionEnabled() {
  const setting = await getSetting("encrypt_local_data");
  return setting ?? true; // Default: enabled
}

/**
 * Check if Nextcloud sync encryption is enabled
 * @returns {Promise<boolean>}
 */
export async function isNextcloudEncryptionEnabled() {
  const setting = await getSetting("encrypt_nextcloud_data");
  return setting ?? false; // Default: disabled
}

/**
 * Fix corrupted notes that have encrypted content but no encrypted flag
 * This happens if sync ran while app was locked
 * @returns {Promise<{fixed: number, skipped: number}>}
 */
export async function fixCorruptedNotes() {
  console.log("[Storage] Scanning for corrupted notes...");

  const allNotes = await db.getAll("notes");
  let fixed = 0;
  let skipped = 0;

  for (const note of allNotes) {
    try {
      // Check if note has encrypted content but no encrypted flag
      const hasEncryptedContent =
        note.content &&
        typeof note.content === "object" &&
        note.content.data &&
        note.content.iv &&
        note.content.version;

      const hasEncryptedStrokes =
        note.strokes &&
        typeof note.strokes === "object" &&
        note.strokes.data &&
        note.strokes.iv &&
        note.strokes.version;

      if ((hasEncryptedContent || hasEncryptedStrokes) && !note.encrypted) {
        console.warn(`[Storage] Found corrupted note ${note.id} - fixing encrypted flag`);

        // Fix the note by adding the encrypted flag
        const fixedNote = {
          ...note,
          encrypted: true,
        };

        await db.put("notes", fixedNote);
        fixed++;

        console.log(`[Storage] Fixed note ${note.id}`);
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`[Storage] Failed to check/fix note ${note.id}:`, error);
    }
  }

  console.log(`[Storage] Corruption scan complete: ${fixed} fixed, ${skipped} skipped`);

  return { fixed, skipped };
}

/**
 * Migrate existing plain text notes to encrypted format
 * This function encrypts all notes that are currently stored in plain text
 * @returns {Promise<{migrated: number, skipped: number, failed: number}>}
 */
export async function migrateNotesToEncrypted() {
  const encryptionEnabled = await isLocalEncryptionEnabled();

  if (!encryptionEnabled) {
    console.log("[Storage] Local encryption is disabled, skipping migration");
    return { migrated: 0, skipped: 0, failed: 0 };
  }

  console.log("[Storage] Starting note encryption migration...");

  const { isAppUnlocked } = await import("./masterPassword.js");

  if (!isAppUnlocked()) {
    throw new Error("Cannot migrate notes - app is locked");
  }

  const allNotes = await db.getAll("notes");
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const note of allNotes) {
    try {
      // Skip already encrypted notes
      if (note.encrypted) {
        skipped++;
        continue;
      }

      // Encrypt the note
      const encryptedNote = await encryptNoteIfEnabled(note);

      // Save the encrypted version
      await db.put("notes", encryptedNote);
      migrated++;

      console.log(`[Storage] Migrated note ${note.id} to encrypted format`);
    } catch (error) {
      console.error(`[Storage] Failed to migrate note ${note.id}:`, error);
      failed++;
    }
  }

  console.log(
    `[Storage] Migration complete: ${migrated} migrated, ${skipped} skipped, ${failed} failed`,
  );

  return { migrated, skipped, failed };
}

/**
 * Encrypt note data if local encryption is enabled
 * @param {Object} note - Note object
 * @returns {Promise<Object>} - Note object (encrypted if enabled)
 */
async function encryptNoteIfEnabled(note) {
  const shouldEncrypt = await isLocalEncryptionEnabled();

  if (!shouldEncrypt) {
    return note;
  }

  // Import encryption modules
  const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
  const { encryptObject } = await import("./encryption.js");

  // Check if app is unlocked
  if (!isAppUnlocked()) {
    console.warn("[Storage] Cannot encrypt note - app is locked");
    return note;
  }

  try {
    const encryptionKey = getEncryptionKey();

    // Encrypt sensitive fields (content, strokes, and media)
    const encryptedContent = await encryptObject(note.content || "", encryptionKey);
    const encryptedStrokes = await encryptObject(note.strokes || [], encryptionKey);
    const encryptedMedia = await encryptObject(note.media || [], encryptionKey);

    return {
      ...note,
      content: encryptedContent,
      strokes: encryptedStrokes,
      media: encryptedMedia,
      encrypted: true, // Mark as encrypted
    };
  } catch (error) {
    console.error("[Storage] Failed to encrypt note:", error);
    // Return unencrypted note if encryption fails
    return note;
  }
}

/**
 * Decrypt note data if it's encrypted
 * @param {Object} note - Note object (possibly encrypted)
 * @returns {Promise<Object>} - Decrypted note object
 */
async function decryptNoteIfNeeded(note) {
  if (!note || !note.encrypted) {
    return note;
  }

  // Check if encryption is currently enabled
  const encryptionEnabled = await isLocalEncryptionEnabled();
  if (!encryptionEnabled) {
    // Encryption is disabled but note is encrypted - we cannot decrypt it
    // because we don't have access to the encryption key
    console.warn(
      "[Storage] Note is encrypted but encryption is disabled. Cannot decrypt without master password.",
    );
    throw new Error(
      "Cannot access encrypted note - encryption is disabled. Please enable local encryption or reset your data.",
    );
  }

  // Import encryption modules
  const { getEncryptionKey, isAppUnlocked } = await import("./masterPassword.js");
  const { decryptObject } = await import("./encryption.js");

  // Check if app is unlocked
  if (!isAppUnlocked()) {
    throw new Error(
      "Cannot decrypt note - app is locked. Please refresh the page to unlock with your master password.",
    );
  }

  try {
    const encryptionKey = getEncryptionKey();

    // Decrypt sensitive fields
    const decryptedContent = await decryptObject(note.content, encryptionKey);
    const decryptedStrokes = await decryptObject(note.strokes, encryptionKey);

    // Only decrypt media if it exists and has the encrypted structure
    // (notes encrypted before media support won't have this field)
    let decryptedMedia = [];
    if (note.media && typeof note.media === "object" && note.media.data && note.media.iv) {
      decryptedMedia = await decryptObject(note.media, encryptionKey);
    }

    return {
      ...note,
      content: decryptedContent,
      strokes: decryptedStrokes,
      media: decryptedMedia,
      encrypted: undefined, // Remove encrypted flag from decrypted version
    };
  } catch (error) {
    console.error("[Storage] Failed to decrypt note:", error);
    throw new Error("Failed to decrypt note - invalid master password or corrupted data");
  }
}
