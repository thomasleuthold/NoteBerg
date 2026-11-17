/**
 * What the open note's own sync does (liveNoteSync.js, review P4, 4.3): given
 * the note as stored here and as the server holds it, the note to store here
 * from now on, what to upload, and the next merge baseline. Pure and
 * worker-safe; the storage worker runs it.
 *
 * It follows the full sync for one note: both changed is merged (with the
 * baseline) and uploaded against the server's etag; only the server changed is
 * taken as downloaded; only this device changed is uploaded against the etag it
 * last synced. Everything the full sync does around that (media binaries,
 * moves, restores, purges, conflicts it asks the user about)
 * is left to the full sync: the plan says "full".
 */

import { attemptMerge } from "./noteMerge.js";

/** The file ids a note refers to (media, its PDF, recordings). */
export function fileIdsOf(note) {
  return [
    ...(Array.isArray(note?.media) ? note.media : []).map((m) => m.fileId),
    note?.pdfSource,
    ...(Array.isArray(note?.recordings) ? note.recordings : []).map((r) => r.fileId),
  ].filter(Boolean);
}

/**
 * @param {object} input
 * @param {object} input.local - the note as stored here (plain)
 * @param {boolean} input.encrypted - stored with local encryption (the caller passes the note decrypted
 *   and false; true is left to the full sync)
 * @param {string|null} input.remoteText - the server's file, when it changed
 * @param {string} input.remoteEtag
 * @param {string|null} input.base - the last text both sides agreed on
 * @param {string|null} input.uid - this user, recorded as the uploader
 * @param {Array<string>|null} input.mediaOnServer - file ids in the note's media folder;
 *   null when not listed (answered with "need-media" if the note refers to files)
 * @param {(fileId: string) => Promise<boolean>|boolean} input.hasFile - whether a file is stored here
 * @returns {Promise<{action: "full", reason: string} | {action: "none"} | {action: "need-media"} |
 *   {action: "upload"|"downloaded", next: object|null, upload: object|null,
 *    ifMatch: string, modified: number, baseContent?: string}>}
 */
export async function planLiveSync({
  local,
  encrypted,
  remoteText,
  remoteEtag,
  base,
  uid,
  mediaOnServer,
  hasFile,
}) {
  const full = (reason) => ({ action: "full", reason });
  if (!local) return full("not stored");
  if (encrypted) return full("encrypted");
  if (local.previousNotebookId !== undefined || local.restoredAt || local.purged) {
    return full("moved, restored or purged");
  }
  if (!local.lastSyncedEtag) return full("never uploaded");

  let remote = null;
  if (typeof remoteText === "string") {
    try {
      remote = JSON.parse(remoteText);
    } catch {
      return full("server copy unreadable");
    }
    if (remote?.id !== local.id) return full("server copy is another note");
  }

  // Media binaries move only with the full sync: every file must be where it is needed.
  // The server's media folder is listed only for a note that refers to files
  // (null: not listed yet), so a note without media costs no listing request
  if (mediaOnServer === null && fileIdsOf(local).length > 0) return { action: "need-media" };
  const onServer = new Set(mediaOnServer ?? []);
  if (fileIdsOf(local).some((id) => !onServer.has(id))) return full("media not on the server");
  if (remote) {
    for (const id of fileIdsOf(remote)) if (!(await hasFile(id))) return full("media not here");
  }

  const localChanged = local.synced === false;
  if (remote && localChanged) {
    const merged = attemptMerge(
      local,
      { ...remote, _currentFileEtag: remoteEtag },
      { base, localAuthor: uid },
    );
    if (!merged) return full("conflict");
    return {
      action: "upload",
      next: merged,
      upload: merged,
      ifMatch: remoteEtag,
      modified: merged.modified,
      // Until the merge is uploaded, the server's text is what both sides share
      baseContent: typeof remote.content === "string" ? remote.content : undefined,
    };
  }
  if (remote) {
    // The server's version, saved as a download is (sync.js applySyncResult)
    const { _currentFileEtag: _etag, thumbnail: _thumbnail, ...downloaded } = remote;
    return {
      action: "downloaded",
      next: { ...downloaded, lastSyncedEtag: remoteEtag, synced: true },
      upload: null,
      ifMatch: remoteEtag,
      modified: remote.modified,
      baseContent: typeof remote.content === "string" ? remote.content : undefined,
    };
  }
  if (localChanged) {
    return {
      action: "upload",
      next: null,
      upload: local,
      ifMatch: local.lastSyncedEtag,
      modified: local.modified,
    };
  }
  return { action: "none" };
}
