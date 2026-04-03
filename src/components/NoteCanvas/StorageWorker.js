/**
 * StorageWorker - Handles IndexedDB operations off the main thread.
 *
 * Schema v4: notes are split across two stores:
 *   "notes"       — lightweight index (id, modified, version, synced, hasStrokes, …)
 *   "noteContent" — heavy payload   (strokes, content, media, tasks, recognition, …)
 *
 * Each message handler writes ONLY to the store(s) it needs:
 *   SAVE_STROKES     → noteContent (strokes) + notes (modified/version/synced/hasStrokes)
 *   SAVE_MEDIA       → noteContent (media)   + notes (modified/version/synced)
 *   SAVE_PRESETS     → noteContent (penPresets) + notes (modified/version/synced)
 *   SAVE_THUMBNAIL   → noteContent (thumbnail base64) only — does NOT touch notes index
 *   SAVE_TASKS       → noteContent (tasks)   + notes (modified/version/synced)
 *   SAVE_CONTENT     → noteContent (content) + notes (modified/version/synced/hasContent)
 *   SAVE_RECORDINGS  → noteContent (recordings/deletedRecordings) + notes (modified/version/synced)
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

// Queue for sequential processing — prevents read-modify-write races
let messageQueue = Promise.resolve();

self.onmessage = (e) => {
  messageQueue = messageQueue
    .then(() => processMessage(e))
    .catch((err) => {
      console.error("[StorageWorker] Error processing message:", err);
    });
};

async function processMessage(e) {
  const {
    type,
    noteId,
    strokes,
    deletedStrokes,
    media,
    deletedMedia,
    pdfSource,
    presets,
    recordings,
    deletedRecordings,
    key,
  } = e.data;

  if (type === "SAVE_STROKES") {
    const db = await getDB();

    const noteIndex = await db.get("notes", noteId);
    if (!noteIndex) return;

    let strokesData = strokes;
    if (noteIndex.encrypted) {
      if (key) {
        strokesData = await encryptObject(strokes, key);
      } else {
        console.error("[StorageWorker] Cannot save encrypted strokes: Key missing");
        return;
      }
    }

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

    if (index && content) {
      const now = Date.now();
      content.strokes = strokesData;
      if (deletedStrokes) content.deletedStrokes = deletedStrokes;

      index.modified = now;
      index.version = (index.version || 0) + 1;
      index.synced = false;
      index.hasStrokes = Array.isArray(strokes) ? strokes.length > 0 : false;

      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "SAVE_MEDIA") {
    const db = await getDB();

    const noteIndex = await db.get("notes", noteId);
    if (!noteIndex) return;

    let mediaData = media;
    if (noteIndex.encrypted && media) {
      if (key) {
        mediaData = await encryptObject(media, key);
      } else {
        console.error("[StorageWorker] Cannot save encrypted media: Key missing");
        return;
      }
    }

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

    if (index && content) {
      const now = Date.now();
      if (media !== undefined) content.media = mediaData;
      if (deletedMedia !== undefined) content.deletedMedia = deletedMedia;
      if (pdfSource !== undefined) content.pdfSource = pdfSource;

      // Update index media metadata snapshot (no positions/fileIds)
      if (media !== undefined && Array.isArray(media)) {
        index.media = media.map(({ id, name, type, size, deleted }) => ({
          id,
          name,
          type,
          size,
          deleted,
        }));
      }

      index.modified = now;
      index.version = (index.version || 0) + 1;
      index.synced = false;

      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "SAVE_PRESETS") {
    const db = await getDB();

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

    if (index && content) {
      content.penPresets = presets;

      index.modified = Date.now();
      index.version = (index.version || 0) + 1;
      index.synced = false;

      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "SAVE_THUMBNAIL") {
    const { thumbnail } = e.data;
    const db = await getDB();

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

    if (index && content) {
      let thumbnailData = thumbnail;
      if (index.encrypted && key) {
        thumbnailData = await encryptObject(thumbnail, key);
      }
      content.thumbnail = thumbnailData;
      // Do NOT update modified/version/synced — thumbnails are UI-only metadata.
      // Bumping these fields causes the note to be re-uploaded on every sync,
      // and the new modified timestamp triggers a download on the other device,
      // which saves the note, generates a thumbnail, bumps modified again → infinite oscillation.
      index.hasThumbnail = true;
      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "SAVE_TASKS") {
    const { tasks } = e.data;
    const db = await getDB();

    const noteIndex = await db.get("notes", noteId);
    if (!noteIndex) return;

    let tasksData = tasks;
    if (noteIndex.encrypted) {
      if (key) {
        tasksData = await encryptObject(tasks, key);
      } else {
        console.error("[StorageWorker] Cannot save encrypted tasks: Key missing");
        return;
      }
    }

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

    if (index && content) {
      content.tasks = tasksData;

      index.modified = Date.now();
      index.version = (index.version || 0) + 1;
      index.synced = false;

      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "SAVE_CONTENT") {
    const { content: newContent } = e.data;
    const db = await getDB();

    const noteIndex = await db.get("notes", noteId);
    if (!noteIndex) return;

    let contentData = newContent;
    if (noteIndex.encrypted) {
      if (key) {
        contentData = await encryptObject(newContent, key);
      } else {
        console.error("[StorageWorker] Cannot save encrypted content: Key missing");
        return;
      }
    }

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

    if (index && content) {
      content.content = contentData;

      index.modified = Date.now();
      index.version = (index.version || 0) + 1;
      index.synced = false;
      index.hasContent = typeof newContent === "string" ? newContent.trim().length > 0 : false;

      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "SAVE_RECORDINGS") {
    const db = await getDB();

    const noteIndex = await db.get("notes", noteId);
    if (!noteIndex) return;

    let recordingsData = recordings;
    if (noteIndex.encrypted && recordings) {
      if (key) {
        recordingsData = await encryptObject(recordings, key);
      } else {
        console.error("[StorageWorker] Cannot save encrypted recordings: Key missing");
        return;
      }
    }

    const tx = db.transaction(["notes", "noteContent"], "readwrite");
    const notesStore = tx.objectStore("notes");
    const contentStore = tx.objectStore("noteContent");

    const [index, existingContent] = await Promise.all([
      notesStore.get(noteId),
      contentStore.get(noteId),
    ]);
    const content = existingContent ?? { id: noteId };

    if (index) {
      const now = Date.now();
      if (recordings !== undefined) content.recordings = recordingsData;
      if (deletedRecordings !== undefined) content.deletedRecordings = deletedRecordings;

      // Update index recordings metadata snapshot (no fileIds)
      if (recordings !== undefined && Array.isArray(recordings)) {
        index.recordings = recordings.map(({ id, name, duration, deleted }) => ({
          id,
          name,
          duration,
          deleted,
        }));
      }

      index.modified = now;
      index.version = (index.version || 0) + 1;
      index.synced = false;

      await Promise.all([notesStore.put(index), contentStore.put(content)]);
    }

    await tx.done;
  }

  if (type === "CLOSE") {
    self.close();
  }
}
