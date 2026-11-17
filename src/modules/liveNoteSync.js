/**
 * The open note's own sync on the native build (review P4, 4.3; DESIGN §10.4b).
 *
 * While a note is open, its live look used to run a full sync whenever its
 * notebook changed on the server or the note held unsynced edits: a listing of
 * the whole tree, every note's metadata, merges and saves, much of it on the
 * main thread, every few seconds while the user writes. This syncs the open
 * note alone. The main thread only makes the requests and moves strings: one
 * small request for the note's etag, its text when it changed, and the listing
 * of its media folder. The storage worker parses, merges, saves, builds the
 * upload and works out what the editor must take in (liveSyncPlan.js).
 *
 * With local encryption the worker decrypts the note to sync it and stores it
 * encrypted again (it needs the editor's key).
 * Anything this does not handle (media binaries to move, a
 * moved, restored or never-uploaded note, a conflict that cannot be merged)
 * comes back as "full", and the caller runs the full sync as before.
 */

import { perfAsync } from "../utils/perfMonitor.js";
import { isAutoSyncSuspended } from "./autoSync.js";
import {
  downloadNoteText,
  getCurrentUserId,
  isAuthenticated,
  listFiles,
  remoteFileEtag,
  uploadNoteText,
} from "./nextcloudSync.js";
import { isSharingEnabled } from "./sharing/enabled.js";
import { getNoteIndex, isLocalEncryptionEnabled } from "./storage.js";
import { getNoteMediaFolder, getNotePath } from "./storagePaths.js";
import { runExclusiveSync } from "./sync.js";

/** After an upload that failed, how long before the note's changes are pushed again. */
const PUSH_RETRY_MS = 120_000;
// noteId -> time before which a failed push is not retried
const pushBackoff = new Map();

/** The file ids in a note's media folder (files are named `<fileId><ext>`). */
async function mediaOnServer(noteId, notebookId) {
  const files = await listFiles(getNoteMediaFolder(noteId, notebookId));
  return files.map((f) => {
    const dot = f.name.lastIndexOf(".");
    return dot > 0 ? f.name.slice(0, dot) : f.name;
  });
}

/**
 * @param {object} options
 * @param {string} options.noteId
 * @param {string|null} options.notebookId
 * @param {(message: object) => Promise<object>} options.ask - a request to the
 *   editor's storage worker, answered in its queue order
 * @param {() => object} options.view - what the editor holds (liveTakeIn.js
 *   editorView), taken when the worker is asked
 * @param {() => boolean} options.isIdle - asked again before anything is downloaded
 * @returns {Promise<{outcome: "unchanged"|"synced"|"deferred"|"failed"|"full"|"skipped",
 *   delta?: object|null}>} `delta`: what the editor must take in
 */
export async function liveSyncOpenNote({ noteId, notebookId, ask, view, isIdle }) {
  // Part of the sharing preview: nothing of it runs while sharing is off
  if (!isSharingEnabled() || isAutoSyncSuspended()) return { outcome: "skipped" };
  const authStart = performance.now();
  const authenticated = await isAuthenticated();
  const authMs = Math.round(performance.now() - authStart);
  if (!authenticated) return { outcome: "skipped" };
  let path;
  try {
    path = getNotePath(noteId, notebookId ?? null);
  } catch {
    return { outcome: "skipped" }; // its share has ended
  }
  const queuedAt = performance.now();
  const result = await runExclusiveSync(() =>
    perfAsync("live note sync", () =>
      syncNote({
        noteId,
        notebookId,
        path,
        ask,
        view,
        isIdle,
        // Time before the steps: the sign-in check, then waiting for another sync to finish
        lead: [`auth ${authMs}`, `lock ${Math.round(performance.now() - queuedAt)}`],
      }),
    ),
  );
  // Another sync is running: look again at the next pause
  return result ?? { outcome: "deferred" };
}

async function syncNote({ noteId, notebookId, path, ask, view, isIdle, lead }) {
  // Where the time goes, one line per sync that did something (log level debug)
  const started = performance.now();
  const timings = [];
  const timed = async (name, fn) => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      timings.push(`${name} ${Math.round(performance.now() - start)}`);
    }
  };
  const outcome = await syncNoteSteps({
    noteId,
    notebookId,
    path,
    ask,
    view,
    isIdle,
    timed,
    timings,
  });
  if (outcome.outcome !== "unchanged" && outcome.outcome !== "skipped") {
    const total = Math.round(performance.now() - started);
    const why = outcome.reason ? ` [${outcome.reason}]` : "";
    console.debug(
      `[LiveSync] ${outcome.outcome}${why} (ms): ${[...lead, ...timings].join(", ")}, total ${total}`,
    );
  }
  return outcome;
}

async function syncNoteSteps({ noteId, notebookId, path, ask, view, isIdle, timed, timings }) {
  const index = await timed("index", () => getNoteIndex(noteId));
  if (!index) return { outcome: "skipped" };
  const remoteEtag = await timed("etag", () => remoteFileEtag(path));
  // Gone from the server (purged, moved): the full sync knows what that means
  if (remoteEtag === null) return { outcome: "full", reason: "no etag from the server" };
  const remoteChanged = remoteEtag !== index.lastSyncedEtag;
  const localChanged = index.synced === false && Date.now() >= (pushBackoff.get(noteId) ?? 0);
  if (!remoteChanged && !localChanged) return { outcome: "unchanged" };
  // With local encryption the worker reads the note decrypted and stores it encrypted
  // again (it needs the editor's key, which `ask` adds)
  const localEncryption = await timed("encryption check", isLocalEncryptionEnabled);
  if (!isIdle()) return { outcome: "deferred" };

  let remoteText = null;
  if (remoteChanged) {
    const download = await timed("download", () => downloadNoteText(path));
    if (typeof download.content !== "string") return { outcome: "full", reason: "download empty" };
    remoteText = download.content;
    timings.push(`(downloaded ${remoteText.length} chars)`);
  }
  const uid = await timed("user", () => getCurrentUserId().catch(() => null));
  // Per asking: the worker's own steps (answer.timings) are listed after it
  const request = (mediaOnServer) =>
    timed(mediaOnServer ? "worker 2" : "worker", async () => {
      const answer = await ask({
        type: "LIVE_SYNC",
        noteId,
        remoteText,
        remoteEtag,
        mediaOnServer,
        view: await timed("view", async () => view()),
        uid,
        localEncryption,
      });
      if (answer?.timings) timings.push(`(in worker: ${answer.timings})`);
      return answer;
    });
  // The media folder is listed only when the note refers to files
  let answer = await request(null);
  if (answer?.action === "need-remote") {
    // Fields of the stored note cannot be read here: the worker takes them from
    // the server's copy, which the upload would otherwise overwrite
    const download = await timed("download (for unreadable fields)", () => downloadNoteText(path));
    if (typeof download.content !== "string") return { outcome: "full", reason: "download empty" };
    remoteText = download.content;
    answer = await request(null);
  }
  if (answer?.action === "need-media") {
    const media = await timed("media listing", () => mediaOnServer(noteId, notebookId ?? null));
    answer = await request(media);
  }
  if (!answer || answer.action === "full") {
    return { outcome: "full", reason: answer?.reason ?? "no answer from the worker" };
  }
  if (answer.action === "none") return { outcome: "unchanged" };

  if (answer.uploadBody) {
    let etag;
    try {
      etag = await timed("upload", () =>
        uploadNoteText(path, answer.uploadBody, answer.modified, answer.ifMatch),
      );
      timings.push(`(uploaded ${answer.uploadBody.length} chars)`);
    } catch (error) {
      // The server moved on meanwhile: look again soon, the next look merges it.
      // Anything else: try again later, not at every look.
      if (error?.status !== 412) {
        console.warn(`[LiveSync] Upload of note ${noteId} failed:`, error);
        pushBackoff.set(noteId, Date.now() + PUSH_RETRY_MS);
        return { outcome: "failed", delta: answer.delta };
      }
      return { outcome: "deferred", delta: answer.delta };
    }
    await timed("commit", () =>
      ask({
        type: "LIVE_SYNC_COMMIT",
        noteId,
        etag,
        modified: answer.modified,
        baseContent: answer.baseContent,
        localEncryption,
      }),
    );
    pushBackoff.delete(noteId);
  }
  return { outcome: "synced", delta: answer.delta };
}
