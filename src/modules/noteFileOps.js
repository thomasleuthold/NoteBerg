/**
 * The heavy work on a note file of the Nextcloud app, off the main thread
 * (review P4, 4.7; DESIGN §10.4b).
 *
 * A note is one JSON file, and every save of the open note is a GET, a merge and
 * a PUT of the whole file: `JSON.parse` and `JSON.stringify` of several MB and a
 * merge of every stroke. On the main thread that stalled writing at every pause.
 * These operations do all of it with nothing but the request details and the
 * update going in, and a small summary coming out. They run in
 * workers/noteFileWorker.js; noteFileClient.js runs them inline where there is
 * no worker (tests, or a browser that refuses one), so both paths are the same code.
 *
 * Worker-safe: fetch, JSON, the merge modules. Nothing here touches the DOM,
 * `window`, or storage.webdav.js's caches; the caller does that with the summary.
 */

import { computeTakeIn } from "./liveTakeIn.js";
import { attemptMerge, resolvePartialStrokes } from "./noteMerge.js";
import { versionedUpdates } from "./noteVersions.js";
import { isSafeId } from "./storagePaths.js";
import { mergeContent } from "./textMerge.js";

const MAX_LOCK_RETRIES = 3;

// What a merge with the server's version decides; everything else keeps this
// client's value (storage.webdav.js MERGED_FIELDS)
const MERGED_FIELDS = [
  "content",
  "strokes",
  "deletedStrokes",
  "media",
  "deletedMedia",
  "recordings",
  "deletedRecordings",
  "tasks",
  "deletedTasks",
  "tombstones",
  "shifts",
  "fieldVersions",
  "title",
  "background",
  "penPresets",
  "pdfSource",
  "recognition",
  "hasRecognition",
];

/** The bare etag of a response (see storage.webdav.js bareEtag). */
export function bareEtag(value) {
  return value
    ?.replace(/^W\//, "")
    .replace(/"/g, "")
    .replace(/-(gzip|br|deflate)$/, "");
}

function responseEtag(res) {
  return bareEtag(res.headers?.get?.("etag")) || bareEtag(res.headers?.get?.("oc-etag")) || null;
}

/** Array fields as arrays (an encrypted native blob reads as empty), as storage.webdav.js does. */
export function normalizeNote(note) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  for (const field of [
    "strokes",
    "deletedStrokes",
    "media",
    "deletedMedia",
    "tasks",
    "deletedTasks",
    "recordings",
    "deletedRecordings",
  ]) {
    note[field] = arr(note[field]);
  }
  delete note.thumbnail;
  return note;
}

/** The file ids a note refers to, for the caller's file-location cache. */
function filesOf(note) {
  return {
    id: note.id,
    notebookId: note.notebookId ?? null,
    media: note.media.map((m) => ({ fileId: m.fileId })),
    pdfSource: note.pdfSource ?? null,
    recordings: note.recordings.map((r) => ({ fileId: r.fileId })),
  };
}

/**
 * GET and parse the note file.
 * @returns {Promise<{status: "ok", note: object, etag: string|null}|{status: string, httpStatus?: number}>}
 */
async function readNote({ url, headers, id, notebookId, shared }) {
  const res = await fetch(url, {
    headers: { ...headers, "Cache-Control": "no-cache" },
    credentials: "same-origin",
  });
  if (res.status === 404) return { status: "notFound" };
  if (!res.ok) return { status: "httpError", httpStatus: res.status };
  let note;
  try {
    note = JSON.parse(await res.text());
  } catch {
    return { status: "unreadable" };
  }
  // A shared notebook's file must be the note it is named for (storage.webdav.js _isGenuineNote)
  if (
    shared &&
    !(isSafeId(note?.id) && note.id === id && (note.notebookId ?? null) === notebookId)
  ) {
    return { status: "notGenuine" };
  }
  return { status: "ok", note: normalizeNote(note), etag: responseEtag(res) };
}

/** PUT a body, waiting out Nextcloud's file locks (423) as davPutWithRetry does. */
async function putNote(url, headers, body, ifMatch) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        ...(ifMatch ? { "If-Match": `"${ifMatch}"` } : {}),
      },
      credentials: "same-origin",
      body,
    });
    if (res.ok) return { ok: true, etag: responseEtag(res) };
    if (res.status === 423 && i < MAX_LOCK_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      continue;
    }
    return { ok: false, httpStatus: res.status };
  }
}

/**
 * Read-merge-write the note file (storage.webdav.js _applyNoteUpdate).
 * @param {object} request
 * @param {string} request.url - the note file's WebDAV URL
 * @param {string} [request.folderUrl] - its folder, created first when given
 * @param {object} request.headers - Nextcloud request headers (request token)
 * @param {string} request.id
 * @param {string|null} request.notebookId
 * @param {boolean} request.shared - the notebook is shared with this user
 * @param {object} request.updates - fields to write (strokes may be partial)
 * @param {{etag?: string, base?: string, needsMerge?: boolean}|undefined} request.known -
 *   what this client last read or wrote
 * @param {string|null} request.uid - the user, recorded as the last writer
 * @param {number} request.maxAttempts
 * @returns {Promise<object>} `status: "ok"` with the new etag and a summary, or why not
 */
export async function writeNote(request) {
  const { url, folderUrl, headers, id, notebookId, shared, updates, known, uid, maxAttempts } =
    request;
  let folderReady = !folderUrl;
  for (let attempt = 1; ; attempt++) {
    const read = await readNote({ url, headers, id, notebookId, shared });
    if (read.status !== "ok") return read;
    const existing = read.note;

    let updated = {
      ...existing,
      ...versionedUpdates(existing, resolvePartialStrokes(existing, updates)),
      modified: Date.now(),
      version: (existing.version || 0) + 1,
    };
    // A retry means the previous PUT lost a race, i.e. someone else wrote
    const someoneElseWrote =
      attempt > 1 || Boolean(known?.etag && read.etag && known.etag !== read.etag);
    const merging = someoneElseWrote || Boolean(known?.needsMerge);
    if (merging) {
      const merged = attemptMerge(updated, existing, {
        base: known?.base ?? null,
        localAuthor: uid,
      });
      if (merged) {
        const fields = { ...updated };
        for (const field of MERGED_FIELDS) fields[field] = merged[field];
        updated = fields;
      }
    }
    if (uid) updated.lastModifiedBy = uid;

    // The folder is made sure of just before writing, as storage.webdav.js _putNote
    // does: a read that fails first says more (a moved note, an ended share)
    if (!folderReady) {
      const res = await fetch(folderUrl, { method: "MKCOL", headers, credentials: "same-origin" });
      if (!res.ok && res.status !== 405) {
        return { status: "httpError", httpStatus: res.status, op: "MKCOL" };
      }
      folderReady = true;
    }
    const put = await putNote(url, headers, JSON.stringify(updated), read.etag);
    if (put.ok) {
      // The written note goes back without its strokes: they are what makes it
      // large, and nobody who saves needs them back
      const { strokes: _strokes, deletedStrokes: _deleted, ...note } = updated;
      return {
        status: "ok",
        etag: put.etag,
        someoneElseWrote,
        merging,
        note,
        files: filesOf(updated),
      };
    }
    if (put.httpStatus !== 412 || attempt >= maxAttempts) {
      return { status: "httpError", httpStatus: put.httpStatus, op: "PUT" };
    }
  }
}

/** The note's text and who wrote it last (LiveText's read on the Nextcloud app). */
export async function readNoteText(request) {
  const read = await readNote(request);
  if (read.status !== "ok") return read;
  return {
    status: "ok",
    etag: read.etag,
    content: typeof read.note.content === "string" ? read.note.content : "",
    author: read.note.lastModifiedBy,
  };
}

/**
 * The server's version of the open note, taken in against what the editor holds
 * (liveTakeIn.js): only the delta comes back. With `text`, the editor's text is
 * merged with the server's too (LiveText's merge), when both changed.
 * @param {object} request - readNote's, plus `view` and optionally
 *   `text: {baseline, editorText}`
 */
export async function takeInNote(request) {
  const read = await readNote(request);
  if (read.status !== "ok") return read;
  const delta = computeTakeIn(request.view, read.note);
  let text = null;
  if (request.text) {
    const remote = delta.stored.content;
    const { baseline, editorText } = request.text;
    text = {
      remote,
      author: read.note.lastModifiedBy,
      // Only when both changed; otherwise the editor simply shows the stored text
      merged:
        editorText !== baseline && remote !== editorText
          ? mergeContent(baseline, editorText, remote, {
              localModified: 1,
              remoteModified: 0,
              remoteAuthor: read.note.lastModifiedBy,
            })
          : null,
    };
  }
  return { status: "ok", etag: read.etag, delta, text, files: filesOf(read.note) };
}

/** Text merge only (LiveText's reconcile on the native build, see StorageWorker). */
export function mergeText({ baseline, editorText, remote, author }) {
  return mergeContent(baseline, editorText, remote, {
    localModified: 1,
    remoteModified: 0,
    remoteAuthor: author,
  });
}

export const NOTE_FILE_OPS = { writeNote, readNoteText, takeInNote, mergeText };
