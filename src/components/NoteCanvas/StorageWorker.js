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

self.onmessage = async (e) => {
  const { type, noteId, strokes, deletedStrokes, media, deletedMedia, presets, key } = e.data;

  if (type === "SAVE_STROKES") {
    try {
      const db = await getDB();

      // Use a transaction to ensure atomicity
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");

      const note = await store.get(noteId);

      if (note) {
        // 1. Update deleted strokes
        if (deletedStrokes) {
          note.deletedStrokes = deletedStrokes;
        }

        // 2. Update strokes (encrypt if needed)
        if (note.encrypted) {
          if (key) {
            note.strokes = await encryptObject(strokes, key);
          } else {
            console.error("[StorageWorker] Cannot save encrypted note: Key missing");
            return;
          }
        } else {
          note.strokes = strokes;
        }

        // 3. Update metadata to match storage.js logic
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
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      const note = await store.get(noteId);

      if (note) {
        // Update media fields
        if (media !== undefined) note.media = media;
        if (deletedMedia !== undefined) note.deletedMedia = deletedMedia;

        // Encrypt media if needed
        if (note.encrypted && media) {
          if (key) {
            note.media = await encryptObject(media, key);
          } else {
            console.error("[StorageWorker] Cannot save encrypted media: Key missing");
            return;
          }
        }

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

  if (type === "CLOSE") {
    self.close();
  }
};
