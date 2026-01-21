/**
 * StorageWorker - Handles IndexedDB operations off the main thread
 */

const DB_NAME = "onejournal_db"; // Matches the app's DB name
const DB_VERSION = 1; // Assuming version 1, or whatever the app uses

let db = null;

async function getDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
  });
}

self.onmessage = async (e) => {
  const { type, noteId, strokes } = e.data;

  if (type === "SAVE_STROKES") {
    try {
      const database = await getDB();

      // 1. Get the current note
      const tx = database.transaction(["notes"], "readwrite");
      const store = tx.objectStore("notes");

      const getRequest = store.get(noteId);

      getRequest.onsuccess = () => {
        const note = getRequest.result;
        if (note) {
          // 2. Update strokes and modified time
          note.strokes = strokes;
          note.modified = Date.now();

          // 3. Save back
          store.put(note);
        }
      };
    } catch (err) {
      console.error("[StorageWorker] Save failed:", err);
    }
  }
};
