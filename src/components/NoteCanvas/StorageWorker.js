/**
 * StorageWorker - Handles IndexedDB operations off the main thread
 */

import { openDB } from "idb";
import { encryptObject } from "../../modules/encryption.js";

const DB_NAME = "oneJournal"; // Matches the app's DB name
const DB_VERSION = 1; // Assuming version 1, or whatever the app uses

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION);
  }
  return dbPromise;
}

self.onmessage = async (e) => {
  const { type, noteId, strokes, key } = e.data;

  if (type === "SAVE_STROKES") {
    try {
      const db = await getDB();

      // Use a transaction to ensure atomicity
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");

      const note = await store.get(noteId);

      if (note) {
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

  if (type === "CLOSE") {
    self.close();
  }
};
