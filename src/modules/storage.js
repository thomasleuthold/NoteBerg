/**
 * Storage Module
 * IndexedDB wrapper for notes, notebooks, and settings
 */

import { openDB } from "idb";

const DB_NAME = "oneJournal";
const DB_VERSION = 1;

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
    },
  });

  console.log("Storage initialized");

  // Run migrations
  await migrateStrokeIds();
  await migrateMediaFields();

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
 * Migrate existing notes to add media fields
 * This ensures all notes have media, deletedMedia, and mediaVersion fields
 */
async function migrateMediaFields() {
  if (!db) return;

  try {
    const notes = await db.getAll("notes");
    let migratedCount = 0;

    for (const note of notes) {
      let needsUpdate = false;

      // Initialize media array if it doesn't exist
      if (!note.media) {
        note.media = [];
        needsUpdate = true;
      }

      // Initialize deletedMedia array if it doesn't exist
      if (!note.deletedMedia) {
        note.deletedMedia = [];
        needsUpdate = true;
      }

      // Initialize mediaVersion if it doesn't exist
      if (!note.mediaVersion) {
        note.mediaVersion = 1;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await db.put("notes", note);
        migratedCount++;
      }
    }

    if (migratedCount > 0) {
      console.log(`Migrated media fields for ${migratedCount} notes`);
    }
  } catch (error) {
    console.error("Failed to migrate media fields:", error);
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
    return crypto.randomUUID();
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

// ========== Recycle Bin Operations ==========

/**
 * Get all deleted notebooks
 */
export async function getDeletedNotebooks() {
  const allNotebooks = await db.getAll("notebooks");
  return allNotebooks.filter((n) => n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get all deleted notes
 */
export async function getDeletedNotes() {
  const allNotes = await db.getAll("notes");
  return allNotes.filter((n) => n.deleted).sort((a, b) => b.modified - a.modified);
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
    return;
  }

  // Encrypt note before saving if local encryption is enabled
  const encryptedNote = await encryptNoteIfEnabled(note);
  await db.put("notes", encryptedNote);
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
    if (note.media && typeof note.media === 'object' && note.media.data && note.media.iv) {
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
