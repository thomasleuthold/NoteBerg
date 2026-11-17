/**
 * A note as it is uploaded to Nextcloud: the one form both the full sync
 * (nextcloudSync.js) and the open note's own sync (the storage worker, see
 * liveNoteSync.js) write. Pure, worker-safe.
 */

/** Local sync bookkeeping that never goes to the server. */
const LOCAL_ONLY = [
  "lastSyncedEtag",
  "synced",
  "encrypted",
  "_currentFileEtag",
  "previousNotebookId",
  "restoredAt",
];

/**
 * @param {object} note - plain (decrypted) note
 * @param {string|null} [uploader] - who uploads it, for the other side's merge hint (DESIGN §10.3 F)
 * @returns {object} the note as uploaded
 */
export function noteForUpload(note, uploader = null) {
  const out = { ...note };
  for (const field of LOCAL_ONLY) delete out[field];
  if (uploader) out.lastModifiedBy = uploader;
  return out;
}

/** The uploaded file's text. */
export function noteUploadBody(note, uploader = null) {
  return JSON.stringify(noteForUpload(note, uploader), null, 2);
}
