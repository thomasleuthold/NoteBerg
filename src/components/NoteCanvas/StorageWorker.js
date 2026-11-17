/**
 * StorageWorker - Handles IndexedDB operations off the main thread.
 *
 * Schema v4: notes are split across two stores:
 *   "notes"       — lightweight index (id, modified, version, synced, hasStrokes, …)
 *   "noteContent" — heavy payload   (strokes, content, media, tasks, recognition, …)
 *
 * Each message handler writes ONLY to the store(s) it needs:
 *   OPEN_FOR_EDITING → no write: the editor opened this note with the right to edit
 *                      (see assertWritable)
 *   SAVE_STROKES     → noteContent (strokes) + notes (modified/version/synced/hasStrokes)
 *   SAVE_MEDIA       → noteContent (media)   + notes (modified/version/synced)
 *   SAVE_PRESETS     → noteContent (penPresets) only — no index bump, presets
 *                      are UI preferences and must not trigger a re-upload
 *   SAVE_TASKS       → noteContent (tasks)   + notes (modified/version/synced)
 *   SAVE_CONTENT     → noteContent (content) + notes (modified/version/synced/hasContent);
 *                      with `expected`, refused when the stored text is no longer
 *                      what the editor last saw; the outcome is posted back
 *                      (CONTENT_SAVED) when the message has a requestId
 *   SAVE_RECORDINGS  → noteContent (recordings/deletedRecordings) + notes (modified/version/synced)
 */

import { openDB } from "idb";
import { DOMParser } from "linkedom";
import { decryptObject, encryptObject } from "../../modules/encryption.js";
import { planLiveSync } from "../../modules/liveSyncPlan.js";
import { computeTakeIn } from "../../modules/liveTakeIn.js";
import {
  ELEMENT_KINDS,
  mergeElements,
  mergeVersionFields,
  normalize,
} from "../../modules/noteMerge.js";
import { mergeNote, splitNote } from "../../modules/noteRecord.js";
import { noteUploadBody } from "../../modules/noteUpload.js";
import { assertEditable } from "../../modules/sharing/shareRestrictions.js";
import { DB_NAME, DB_VERSION } from "../../modules/storage.js";
import { mergeContent, useHtmlParser } from "../../modules/textMerge.js";

// No DOM in a worker: the text merge parses HTML with linkedom's parser
useHtmlParser(DOMParser);

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION);
  }
  return dbPromise;
}

/**
 * A note of a notebook shared with this user is writable only where the share
 * allows it. The worker bypasses storage.js, so it checks for itself; a refused
 * write is logged by the queue below, like any other failure.
 *
 * Except for the note this worker's editor opened with the right to edit
 * (OPEN_FOR_EDITING): if the share's permissions are reduced while it is open,
 * what the user typed until the editor turns read-only is still stored here —
 * refusing it would throw it away. It never reaches the share: the sync uploads
 * nothing to a read-only share and lists such notes as changes it can no longer
 * save (strandedNoteIds), with a notice and a "Discard my changes" action.
 */
async function assertWritable(db, noteIndex) {
  if (!noteIndex?.notebookId) return;
  if (noteIndex.id === openedForEditing) return;
  assertEditable(await db.get("notebooks", noteIndex.notebookId), "saveNoteContent");
}

// The note this worker's editor opened with the right to edit (one worker per open note)
let openedForEditing = null;

/**
 * A note's stored text as the editor knows it: decrypted when needed.
 * @returns {Promise<string|undefined>} undefined when it cannot be told (encrypted, no key)
 */
async function readableText(stored, encrypted, key) {
  if (!encrypted) return typeof stored === "string" ? stored : "";
  if (!stored) return "";
  if (!key) return undefined;
  try {
    const text = await decryptObject(stored, key);
    return typeof text === "string" ? text : "";
  } catch (_e) {
    return undefined;
  }
}

/**
 * The note as storage.js getNote() assembles it (index and content), its
 * encrypted fields decrypted. Null when it is not there, or encrypted and
 * cannot be read now (the app is locked).
 */
async function readPlainNote(noteId, key) {
  const db = await getDB();
  const [index, content] = await Promise.all([
    db.get("notes", noteId),
    db.get("noteContent", noteId),
  ]);
  if (!index) return null;
  const note = {
    ...index,
    ...(content ?? {}),
    media: content?.media ?? index.media ?? [],
    recordings: content?.recordings ?? index.recordings ?? [],
  };
  if (!index.encrypted) return note;
  if (!key) return null;
  const text = await readableText(note.content, true, key);
  if (text === undefined) return null;
  note.content = text;
  for (const field of ["strokes", "media", "recordings", "tasks", "deletedTasks", "recognition"]) {
    const value = await plainField(note[field], true, key);
    note[field] = value ?? (field === "recognition" ? null : []);
  }
  delete note.encrypted;
  return note;
}

/** Whether two stored values (plain text or an encrypted blob) are the same. */
function sameStoredValue(a, b) {
  return typeof a === "string" || typeof b === "string"
    ? a === b
    : JSON.stringify(a) === JSON.stringify(b);
}

/**
 * SAVE_CONTENT: store a note's text.
 * @returns {Promise<"saved"|"stale"|"failed">} "stale" when `expected` is given and
 *   the stored text is no longer it (something else stored a version since)
 */
async function saveContent(noteId, data, key) {
  const { content: newContent, expected } = data;
  const db = await getDB();

  const noteIndex = await db.get("notes", noteId);
  if (!noteIndex) return "failed";
  await assertWritable(db, noteIndex);

  // The editor names the stored text it replaces. If something else stored a
  // different text since (a sync downloaded another version), writing would
  // overwrite it unseen: refuse, and let the editor merge it in first. Checked
  // here and again inside the write transaction (decrypting cannot happen
  // inside it), so a sync landing in between is caught too.
  let checkedValue;
  if (typeof expected === "string") {
    checkedValue = (await db.get("noteContent", noteId))?.content;
    const current = await readableText(checkedValue, noteIndex.encrypted, key);
    if (current !== undefined && current !== expected) {
      return "stale";
    }
  }

  let contentData = newContent;
  if (noteIndex.encrypted) {
    if (key) {
      contentData = await encryptObject(newContent, key);
    } else {
      console.error("[StorageWorker] Cannot save encrypted content: Key missing");
      return "failed";
    }
  }

  const tx = db.transaction(["notes", "noteContent"], "readwrite");
  const notesStore = tx.objectStore("notes");
  const contentStore = tx.objectStore("noteContent");

  const [index, content] = await Promise.all([notesStore.get(noteId), contentStore.get(noteId)]);

  let outcome = "failed";
  if (content && typeof expected === "string" && !sameStoredValue(content.content, checkedValue)) {
    outcome = "stale";
  } else if (index && content) {
    content.content = contentData;

    index.modified = Date.now();
    index.version = (index.version || 0) + 1;
    index.synced = false;
    index.hasContent = typeof newContent === "string" ? newContent.trim().length > 0 : false;

    await Promise.all([notesStore.put(index), contentStore.put(content)]);
    outcome = "saved";
  }

  await tx.done;
  return outcome;
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

/** A stored field as plain data: decrypted when the note is encrypted; undefined when unreadable. */
async function plainField(value, encrypted, key) {
  if (!encrypted || value == null || Array.isArray(value) || typeof value !== "object")
    return value;
  try {
    return await decryptObject(value, key);
  } catch (e) {
    console.warn("[StorageWorker] Could not decrypt a stored field; the save replaces it:", e);
    return undefined;
  }
}

/**
 * The editor's save of one kind of element, merged with what storage holds
 * (DESIGN §10.7 F): elements storage has that the editor has not taken in yet
 * (a sync saved them meanwhile) are kept, deletions win, and of two copies of
 * an element the newer version wins. Overwriting instead dropped the other
 * side's elements whenever a stroke was saved while a sync wrote the note.
 *
 * Synchronous, so it runs inside the write transaction on what that
 * transaction read: nothing written in between can be lost. Merges the save's
 * version bookkeeping into `stored` in place.
 * @returns {{items: Array, deleted: Array}}
 */
function mergeWithStored(kind, stored, storedItems, storedDeleted, incoming) {
  Object.assign(stored, mergeVersionFields(stored, incoming.versionFields ?? {}));
  const merged = mergeElements(
    kind,
    { items: incoming.items, deleted: incoming.deleted ?? storedDeleted },
    { items: Array.isArray(storedItems) ? storedItems : [], deleted: storedDeleted },
    // Elements written before versions: the editor's copy wins, as the save used to
    { aIsNewer: true, tombstones: stored.tombstones ?? {} },
  );
  const items =
    kind === "strokes" || kind === "media"
      ? normalize(kind, merged.items, stored.shifts)
      : merged.items;
  return { items, deleted: merged.deleted };
}

/**
 * The same merge for one kind of element, read from `content` as stored. An
 * encrypted note's fields must be decrypted first, which cannot happen inside a
 * write transaction (it would commit meanwhile): for those, `premerge()` runs
 * before the transaction and its result is used.
 */
async function premerge(kind, stored, encrypted, key, incoming) {
  if (!encrypted || !stored) return null;
  const { list, deleted } = ELEMENT_KINDS[kind];
  const items = await plainField(stored[list], true, key);
  const removed = (await plainField(stored[deleted], true, key)) ?? [];
  const merged = mergeWithStored(kind, stored, items, removed, incoming);
  return { ...merged, data: await encryptObject(merged.items, key) };
}

/** Merge inside the write transaction (plain notes), or take the premerged result. */
function mergeInTransaction(kind, content, pre, incoming) {
  if (pre) {
    Object.assign(content, mergeVersionFields(content, incoming.versionFields ?? {}));
    return pre;
  }
  const { list, deleted } = ELEMENT_KINDS[kind];
  const merged = mergeWithStored(kind, content, content[list], content[deleted] ?? [], incoming);
  return { ...merged, data: merged.items };
}

/** Whether a field sent with its stamp replaces the stored one (the larger stamp wins). */
function takesField(field, content, versionFields) {
  const incoming = versionFields?.fieldVersions?.[field] ?? "";
  const stored = content.fieldVersions?.[field] ?? "";
  return incoming >= stored;
}

/**
 * Save one kind of element (strokes, media, tasks, recordings) into a note: the
 * merge with what storage holds (DESIGN §10.7 F) and the bookkeeping on the note's
 * index record, in one write transaction. Every kind goes through here, so none
 * can drift from the others (a missing version-field merge, a missing bump).
 *
 * @param {string} kind - a key of ELEMENT_KINDS
 * @param {object} save
 * @param {string} save.noteId
 * @param {string} [save.key] - the note's key, when it is encrypted
 * @param {Array} [save.items] - the editor's elements
 * @param {Array} [save.deleted] - the editor's deletion list
 * @param {object} [save.versionFields]
 * @param {boolean} [save.optional] - `items` may be left out (only the version
 *   fields are saved then)
 * @param {boolean} [save.createContent] - a note without a content record gets one
 * @param {boolean} [save.encryptDeleted] - an encrypted note's deletion list is
 *   stored encrypted too
 * @param {(content: object) => any} [save.before] - read from the stored content
 *   before the version fields are merged into it; passed on to `after`
 * @param {(index: object, content: object, merged: object|null, before: any) => void} [save.after]
 *   - kind-specific changes to the index record and content, inside the transaction
 * @returns {Promise<boolean>} whether the note was written
 */
async function saveElements(kind, save) {
  const { noteId, key, items, deleted, versionFields, optional = false } = save;
  const db = await getDB();

  const noteIndex = await db.get("notes", noteId);
  if (!noteIndex) return false;
  await assertWritable(db, noteIndex);

  const hasItems = !optional || items !== undefined;
  if (noteIndex.encrypted && hasItems && !key) {
    console.error(`[StorageWorker] Cannot save encrypted ${kind}: Key missing`);
    return false;
  }

  const incoming = { items, deleted, versionFields };
  let pre = null;
  if (noteIndex.encrypted && hasItems) {
    const stored = await db.get("noteContent", noteId);
    pre = await premerge(
      kind,
      stored ?? (save.createContent ? { id: noteId } : null),
      true,
      key,
      incoming,
    );
  }
  const deletedData = pre && save.encryptDeleted ? await encryptObject(pre.deleted, key) : null;

  const tx = db.transaction(["notes", "noteContent"], "readwrite");
  const notesStore = tx.objectStore("notes");
  const contentStore = tx.objectStore("noteContent");

  const [index, existingContent] = await Promise.all([
    notesStore.get(noteId),
    contentStore.get(noteId),
  ]);
  const content = existingContent ?? (save.createContent ? { id: noteId } : undefined);

  let written = false;
  if (index && content) {
    const before = save.before?.(content);
    const { list, deleted: deletedList } = ELEMENT_KINDS[kind];
    let merged = null;
    if (hasItems) {
      merged = mergeInTransaction(kind, content, pre, incoming);
      content[list] = merged.data;
      content[deletedList] = deletedData ?? merged.deleted;
    } else {
      Object.assign(content, mergeVersionFields(content, versionFields ?? {}));
    }
    save.after?.(index, content, merged, before);

    index.modified = Date.now();
    index.version = (index.version || 0) + 1;
    index.synced = false;

    await Promise.all([notesStore.put(index), contentStore.put(content)]);
    written = true;
  }

  await tx.done;
  return written;
}

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
    versionFields,
    key,
  } = e.data;

  if (type === "OPEN_FOR_EDITING") {
    openedForEditing = noteId;
    return;
  }

  if (type === "SAVE_STROKES") {
    const written = await saveElements("strokes", {
      noteId,
      key,
      items: strokes,
      deleted: deletedStrokes,
      versionFields,
      after: (index, _content, merged) => {
        index.hasStrokes = merged.items.length > 0;
      },
    });
    // Stored: the editor stops resending these strokes (a save that fails never
    // gets here, and its strokes go again with the next one)
    if (e.data.requestId != null && written) {
      self.postMessage({ type: "STROKES_SAVED", requestId: e.data.requestId, noteId });
    }
  }

  if (type === "SAVE_MEDIA") {
    await saveElements("media", {
      noteId,
      key,
      items: media,
      deleted: deletedMedia,
      versionFields,
      optional: true,
      before: (content) =>
        pdfSource !== undefined && takesField("pdfSource", content, versionFields),
      after: (index, content, merged, takesPdfSource) => {
        if (takesPdfSource) content.pdfSource = pdfSource;
        // Index media metadata snapshot (no positions/fileIds)
        if (merged) {
          index.media = merged.items.map(({ id, name, type, size, deleted }) => ({
            id,
            name,
            type,
            size,
            deleted,
          }));
        }
      },
    });
  }

  if (type === "SAVE_PRESETS") {
    const db = await getDB();

    // Pen presets are per-note UI preferences — deliberately do NOT bump
    // modified/version or clear synced: a preset-only change must not trigger a
    // full note re-upload. Presets ride along with the next content/stroke save.
    await assertWritable(db, await db.get("notes", noteId));
    // Read and write in one transaction, like every other save
    const tx = db.transaction("noteContent", "readwrite");
    const content = await tx.store.get(noteId);
    if (content) {
      if (takesField("penPresets", content, versionFields)) content.penPresets = presets;
      Object.assign(content, mergeVersionFields(content, versionFields ?? {}));
      await tx.store.put(content);
    }
    await tx.done;
  }

  if (type === "SAVE_TASKS") {
    await saveElements("tasks", {
      noteId,
      key,
      items: e.data.tasks,
      deleted: e.data.deletedTasks || [],
      versionFields,
      encryptDeleted: true,
    });
  }

  if (type === "SAVE_CONTENT") {
    // Every outcome is reported when the editor asks (requestId), even a failure,
    // so it can tell which of its saves storage holds
    let outcome = "failed";
    try {
      outcome = await saveContent(noteId, e.data, key);
    } finally {
      if (e.data.requestId != null) {
        self.postMessage({ type: "CONTENT_SAVED", requestId: e.data.requestId, noteId, outcome });
      }
    }
  }

  if (type === "SAVE_RECORDINGS") {
    await saveElements("recordings", {
      noteId,
      key,
      items: recordings,
      deleted: deletedRecordings,
      versionFields,
      optional: true,
      createContent: true,
      after: (index, _content, merged) => {
        // Index recordings metadata snapshot (no fileIds)
        if (merged) {
          index.recordings = merged.items.map(({ id, name, duration, deleted }) => ({
            id,
            name,
            duration,
            deleted,
          }));
        }
      },
    });
  }

  // The stored text, read after every write queued before this request: what the
  // editor's own saves left there, unless something else stored a text since
  if (type === "READ_CONTENT") {
    const db = await getDB();
    const [index, content] = await Promise.all([
      db.get("notes", noteId),
      db.get("noteContent", noteId),
    ]);
    const text = index ? await readableText(content?.content, index.encrypted, key) : undefined;
    self.postMessage({
      type: "CONTENT",
      requestId: e.data.requestId,
      noteId,
      content: text ?? null,
      author: content?.lastModifiedBy ?? null,
    });
  }

  // The stored note taken in against what the editor holds (liveTakeIn.js):
  // only the delta goes back to the main thread (review P4, 4.7). In queue
  // order, so it includes every save the editor posted before asking.
  if (type === "TAKE_IN") {
    let delta = null;
    try {
      const note = await readPlainNote(noteId, key);
      if (note) delta = computeTakeIn(e.data.view, note);
    } finally {
      self.postMessage({ type: "TAKEN", requestId: e.data.requestId, noteId, delta });
    }
  }

  // The editor's text merged with the stored one (LiveText's reconcile), here
  // rather than on the main thread
  if (type === "MERGE_TEXT") {
    let merged = null;
    try {
      const { baseline, editorText, remote, author } = e.data;
      merged = mergeContent(baseline, editorText, remote, {
        localModified: 1,
        remoteModified: 0,
        remoteAuthor: author,
      });
    } finally {
      self.postMessage({ type: "TEXT_MERGED", requestId: e.data.requestId, noteId, merged });
    }
  }

  if (type === "LIVE_SYNC") {
    let answer = { action: "full", reason: "failed" };
    try {
      answer = await prepareLiveSync(e.data);
    } finally {
      self.postMessage({ type: "LIVE_SYNCED", requestId: e.data.requestId, noteId, ...answer });
    }
  }

  if (type === "LIVE_SYNC_COMMIT") {
    try {
      await commitLiveSync(e.data);
    } finally {
      self.postMessage({ type: "LIVE_SYNC_COMMITTED", requestId: e.data.requestId, noteId });
    }
  }

  if (type === "CLOSE") {
    self.close();
  }
}

// ─── The open note's own sync (liveNoteSync.js, review P4, 4.3) ───────────────
// The main thread brings the server's text and etag; everything heavy happens
// here: parse, merge, save, the upload body, and the editor's delta. In queue
// order, so the note includes every save the editor posted before. Anything
// this does not handle is left to the full sync ("full").

/** A stored encrypted value: `{data, iv}`. */
function isBlob(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.data === "string" &&
    typeof value.iv === "string"
  );
}

const ENCRYPTED_FIELDS = [
  "content",
  "strokes",
  "media",
  "tasks",
  "recognition",
  "recordings",
  "deletedTasks",
];

/** What a field holds when it cannot be read (as the full sync's decryptNoteFields). */
const EMPTY_FIELD = { content: "", recognition: null };

/**
 * A stored note with every encrypted field decrypted (fields of a note stored
 * before encryption was switched on are plain and stay as they are). A field
 * that cannot be decrypted (sealed with a key this device no longer holds)
 * comes back empty and is named in `failed`; the caller takes it from the
 * server's copy, as the full sync does, so it is never uploaded as nothing.
 * @returns {Promise<{note: object, failed: string[]}>}
 */
async function decryptStoredNote(stored, key) {
  const note = { ...stored };
  const failed = [];
  for (const field of ENCRYPTED_FIELDS) {
    if (!isBlob(note[field])) continue;
    try {
      note[field] = await decryptObject(note[field], key);
    } catch (e) {
      console.warn(`[StorageWorker] Live sync: could not decrypt ${field}:`, e);
      failed.push(field);
      note[field] = EMPTY_FIELD[field] ?? [];
    }
  }
  delete note.encrypted;
  return { note, failed };
}

/** A note with the fields that could not be decrypted taken from the server's copy. */
function takeFailedFieldsFrom(note, failed, remote) {
  const filled = { ...note };
  for (const field of failed) {
    const value = remote?.[field];
    if (value !== undefined && !isBlob(value)) filled[field] = value;
  }
  return filled;
}

/**
 * A note's content record as storage.js _encryptContent stores it when local
 * encryption is on: the same fields, encrypted with the editor's key. Throws if
 * a field cannot be encrypted, so nothing readable is stored in its place.
 */
async function encryptContentRecord(content, key) {
  const sealed = async (value, empty) =>
    isBlob(value) ? value : encryptObject(value ?? empty, key);
  return {
    ...content,
    content: await sealed(content.content, ""),
    strokes: await sealed(content.strokes, []),
    media: await sealed(content.media, []),
    tasks: await sealed(content.tasks, []),
    recognition: content.recognition ? await sealed(content.recognition, null) : null,
  };
}

/** The merge baseline as storage.js keeps it: encrypted when local encryption is on. */
async function baseRecord(noteId, text, encrypt, key) {
  if (!encrypt) return { id: noteId, content: text, encrypted: false };
  return { id: noteId, content: await encryptObject(text, key), encrypted: true };
}

/** The stored merge baseline as text; null when there is none or it cannot be read. */
async function readBase(baseRow, key) {
  if (!baseRow) return null;
  if (!baseRow.encrypted) return typeof baseRow.content === "string" ? baseRow.content : null;
  // No baseline is better than a wrong one: the merge then has no common ancestor
  const text = await decryptObject(baseRow.content, key).catch(() => null);
  return typeof text === "string" ? text : null;
}

async function prepareLiveSync(request) {
  const { noteId, remoteText, remoteEtag, mediaOnServer, view, uid, key } = request;
  // Local encryption on: the note is read decrypted and stored encrypted again,
  // with the editor's key (the app is always unlocked; were the key missing,
  // decrypting and encrypting would fail and nothing would be written)
  const encrypt = Boolean(request.localEncryption);
  const steps = [];
  let mark = performance.now();
  const lap = (name) => {
    const now = performance.now();
    steps.push(`${name} ${Math.round(now - mark)}`);
    mark = now;
  };
  const db = await getDB();
  lap("open db");
  const [index, content, baseRow] = await Promise.all([
    db.get("notes", noteId),
    db.get("noteContent", noteId),
    db.get("noteBase", noteId),
  ]);
  lap("read");
  // A note stored encrypted while encryption is off is left to the full sync
  if (index?.encrypted && !encrypt) return { action: "full", reason: "note stored encrypted" };
  let local = index ? mergeNote(index, content) : null;
  if (local && encrypt) {
    const { note, failed } = await decryptStoredNote(local, key);
    local = note;
    if (failed.length > 0) {
      // Fields that cannot be read are taken from the server's copy. When this
      // device has changes to upload and the main thread has not brought that
      // copy, it is asked for: uploading the fields empty would erase the server's
      if (typeof remoteText !== "string") {
        if (local.synced === false) return { action: "need-remote", timings: steps.join(", ") };
      } else {
        let remote;
        try {
          remote = JSON.parse(remoteText);
        } catch {
          return { action: "full", reason: "server copy unreadable" };
        }
        local = takeFailedFieldsFrom(local, failed, remote);
        console.warn(`[StorageWorker] Live sync: ${failed.join(", ")} taken from the server copy`);
      }
    }
  }
  const base = await readBase(baseRow, key);
  if (encrypt) lap("decrypt");
  const plan = await planLiveSync({
    local,
    encrypted: false,
    remoteText,
    remoteEtag,
    base,
    uid,
    mediaOnServer,
    hasFile: async (fileId) => Boolean(await db.get("files", fileId)),
  });
  lap("plan (parse, merge)");
  if (plan.action === "full" || plan.action === "none" || plan.action === "need-media") {
    return { ...plan, timings: steps.join(", ") };
  }

  if (plan.next) {
    const { index: nextIndex, content: nextContent } = splitNote(plan.next);
    nextIndex.encrypted = encrypt;
    // Encrypted before the transaction opens (it would not outlast the crypto wait).
    // A failure aborts this sync: nothing readable is written in its place
    const storedContent = encrypt ? await encryptContentRecord(nextContent, key) : nextContent;
    const storedBase =
      typeof plan.baseContent === "string"
        ? await baseRecord(noteId, plan.baseContent, encrypt, key)
        : null;
    if (encrypt) lap("encrypt");
    const tx = db.transaction(["notes", "noteContent", "noteBase"], "readwrite");
    const writes = [
      tx.objectStore("notes").put(nextIndex),
      tx.objectStore("noteContent").put(storedContent),
    ];
    if (storedBase) writes.push(tx.objectStore("noteBase").put(storedBase));
    await Promise.all([...writes, tx.done]);
  }
  lap("save");

  const uploadBody = plan.upload ? noteUploadBody(plan.upload, uid) : null;
  lap("upload body");
  const delta = plan.next && view ? computeTakeIn(view, plan.next) : null;
  lap("take-in delta");

  return {
    timings: steps.join(", "),
    action: plan.action,
    uploadBody,
    ifMatch: plan.ifMatch,
    modified: plan.modified,
    baseContent:
      plan.upload && typeof plan.upload.content === "string" ? plan.upload.content : undefined,
    // What the editor must take in (nothing when only its own changes went up)
    delta,
  };
}

/** The upload went through: the note is synced, unless the editor changed it since. */
async function commitLiveSync({ noteId, etag, modified, baseContent, localEncryption, key }) {
  const db = await getDB();
  const encrypt = Boolean(localEncryption);
  // Encrypted before the transaction opens
  const storedBase =
    typeof baseContent === "string" ? await baseRecord(noteId, baseContent, encrypt, key) : null;
  const tx = db.transaction(["notes", "noteBase"], "readwrite");
  const notes = tx.objectStore("notes");
  const index = await notes.get(noteId);
  if (index) {
    index.lastSyncedEtag = etag;
    // As storage.js updateNoteEtag: an edit made meanwhile still has to go up
    if (index.modified === modified) {
      index.synced = true;
      delete index.restoredAt;
    }
    await notes.put(index);
  }
  // The server now holds exactly what was uploaded: the next merge's common ancestor
  if (storedBase) await tx.objectStore("noteBase").put(storedBase);
  await tx.done;
}
