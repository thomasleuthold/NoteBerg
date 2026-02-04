/**
 * StorageWorker - Handles IndexedDB operations off the main thread
 */

import { openDB } from "idb";
import { encryptObject } from "../../modules/encryption.js";
import { DB_NAME, DB_VERSION } from "../../modules/storage.js";

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION);
  }
  return dbPromise;
}

// Queue for sequential processing of messages
// This prevents race conditions where concurrent read-modify-write operations
// on the same note could overwrite each other (e.g., SAVE_MEDIA vs SAVE_THUMBNAIL)
let messageQueue = Promise.resolve();

self.onmessage = (e) => {
  // Chain the processing of messages to ensure sequential execution
  messageQueue = messageQueue.then(() => processMessage(e)).catch((err) => {
    console.error("[StorageWorker] Error processing message:", err);
  });
};

async function processMessage(e) {
  const { type, noteId, strokes, deletedStrokes, media, deletedMedia, pdfSource, presets, key } =
    e.data;

  if (type === "SAVE_STROKES") {
    try {
      const db = await getDB();

      // First, check if we need to encrypt (read note metadata outside transaction)
      const noteCheck = await db.get("notes", noteId);
      if (!noteCheck) return;

      // Encrypt data BEFORE starting the transaction to avoid auto-commit issues
      // (IndexedDB transactions auto-commit when awaiting non-IDB promises)
      let strokesData = strokes;
      if (noteCheck.encrypted) {
        if (key) {
          strokesData = await encryptObject(strokes, key);
        } else {
          console.error("[StorageWorker] Cannot save encrypted note: Key missing");
          return;
        }
      }

      // Now do the actual update in a transaction
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      const note = await store.get(noteId);

      if (note) {
        if (deletedStrokes) {
          note.deletedStrokes = deletedStrokes;
        }
        note.strokes = strokesData;
        note.modified = Date.now();
        note.version = (note.version || 0) + 1;
        note.synced = false;

        await store.put(note);
      }

      await tx.done;
    } catch (err) {
      console.error("[StorageWorker] Save failed:", err);
    }
  }

  if (type === "SAVE_MEDIA") {
    try {
      const db = await getDB();

      // First, check if we need to encrypt (read note metadata outside transaction)
      const noteCheck = await db.get("notes", noteId);
      if (!noteCheck) return;

      // Encrypt data BEFORE starting the transaction to avoid auto-commit issues
      let mediaData = media;
      if (noteCheck.encrypted && media) {
        if (key) {
          mediaData = await encryptObject(media, key);
        } else {
          console.error("[StorageWorker] Cannot save encrypted media: Key missing");
          return;
        }
      }

      // Now do the actual update in a transaction
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      const note = await store.get(noteId);

      if (note) {
        if (media !== undefined) note.media = mediaData;
        if (deletedMedia !== undefined) note.deletedMedia = deletedMedia;
        if (pdfSource !== undefined) note.pdfSource = pdfSource;

        note.modified = Date.now();
        note.version = (note.version || 0) + 1;
        note.synced = false;

        await store.put(note);
      }
      await tx.done;
    } catch (err) {
      console.error("[StorageWorker] Media save failed:", err);
    }
  }

  if (type === "SAVE_PRESETS") {
    try {
      const db = await getDB();
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      const note = await store.get(noteId);

      if (note) {
        note.penPresets = presets;
        note.modified = Date.now();
        note.version = (note.version || 0) + 1;
        note.synced = false;

        await store.put(note);
      }
      await tx.done;
    } catch (err) {
      console.error("[StorageWorker] Presets save failed:", err);
    }
  }

  if (type === "SAVE_THUMBNAIL") {
    const { thumbnailFileId, thumbnailTimestamp } = e.data;
    try {
      const db = await getDB();
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      const note = await store.get(noteId);

      if (note) {
        note.thumbnailFileId = thumbnailFileId;
        note.thumbnailTimestamp = thumbnailTimestamp;
        note.modified = Date.now();
        note.version = (note.version || 0) + 1;
        note.synced = false;

        await store.put(note);
      }
      await tx.done;
    } catch (err) {
      console.error("[StorageWorker] Thumbnail save failed:", err);
    }
  }

  if (type === "CLOSE") {
    self.close();
  }
}
