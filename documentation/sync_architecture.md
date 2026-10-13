# Nextcloud Sync Architecture

## Overview

Sync is orchestrated by `sync.js` (`performSync`) which calls the core engine in `nextcloudSync.js` (`fullSync`). All remote storage is WebDAV (PROPFIND / PUT / DELETE / MKCOL). Local storage is IndexedDB via `storage.js`.

---

## Remote Folder Structure

```
/NoteBerg/
  notebooks/
    _tombstones.json                         ← global notebook deletion log
    {notebookId}/
      _notebook.json                         ← notebook metadata
      _tombstones.json                       ← note deletion log for this notebook
      notes/
        {noteId}.json                        ← full note JSON
        {noteId}_media/
          {fileId}.pdf                       ← PDF binary (one per PDF note)
          {fileId}.png                       ← image/media binaries
  quickNotes/
    _tombstones.json
    {noteId}.json
    {noteId}_media/
      {fileId}.pdf
```

---

## Local Storage Split (IndexedDB)

Every note is split into two IndexedDB records by `splitNote()` in `storage.js`:

| Store | Contents | Used for |
|---|---|---|
| `notes` (index) | id, title, modified, version, synced, lastSyncedEtag, deleted, purged, tags, media `[{id, name, type, size, deleted}]` (no fileId), recordings `[{id, name, duration, deleted}]` (no fileId) | Sync decisions, overview list |
| `noteContent` (content) | strokes, content, media with fileIds and positions, recordings with fileIds, pdfSource, deletedMedia, tasks | Rendering, editing |

Key implication: **the index stub's media array has no `fileId`**. To get fileIds for binary file operations, `getRawNote()` must be called to load the full content record.

---

## Entry Points

### Auto-sync (periodic / on data change)
`performSync({ silent: true, preferNewer: true })`

### Manual sync (user button)
`performSync({ silent: false, skipConflictResolution: false })`

### On app startup
`performSync({ silent: true, preferNewer: true })` — conflicts auto-resolved by timestamp

---

## performSync() — Step by Step (`sync.js`)

1. **Guard:** Return `null` if already syncing or not authenticated.
2. **Load local state:** `getAllNotebooksForSync()` + `getAllNoteMetadataForSync()` (index stubs only — no content).
3. **Call `fullSync()`** — returns `{uploaded, downloaded, noteEtagsToUpdate, conflicts, notebooksToDelete, notesToDelete}`.
4. **Resolve conflicts:**
   - `preferNewer=true` (startup/auto): newer timestamp wins automatically; re-sync.
   - `preferNewer=false` (manual): show UI dialog per conflict; user picks local or remote; re-sync.
5. **Mark uploaded items as synced:**
   - Notebooks: `saveNotebook({...notebook, synced: true})`.
   - Notes: `updateNoteEtag(id, etag)` — index-only write, no content change, no `datachange` event.
6. **Save downloaded items:**
   - Race-condition check: if local was modified *during* this sync, attempt merge rather than overwrite.
   - If version/modified identical to local: just update etag (`updateNoteEtag`).
   - Otherwise: `saveNote(downloadedNote)`.
   - Strip `_currentFileEtag` from downloaded notes before saving (also strips a legacy `thumbnail` field defensively, though notes no longer carry one — see [architecture_design.md](architecture_design.md#overview-thumbnails)).
7. **Update etags** for notes where the server etag changed but content was not actually newer (etag oscillation).
8. **Process deletions:** Remove locally any notebooks/notes deleted on remote.
9. **Dispatch events:** `datachange` if content changed; `sync-conflicts` if unresolved conflicts.

---

## fullSync() — Step by Step (`nextcloudSync.js`)

### Step 1 — Fetch remote state
Single `PROPFIND Depth:infinity` on `/NoteBerg/`. Returns every file/folder with etag and mtime. This is the **only** network call that scans the full tree.

### Step 2 — Classify notebooks
For each local notebook and each remote notebook, decide:

| Situation | Action |
|---|---|
| Local purged | Queue upload (delete remote + write tombstone) |
| Local only, not in tombstone | Re-upload (self-heal: was never synced or remote lost it) |
| Local only, in remote tombstone | If locally modified: restore (re-upload). If clean: delete locally. |
| Remote only | Queue download |
| Both sides, local modified (`synced=false`) | Queue upload |
| Both sides, remote etag changed | Queue download |
| Both sides, no changes | Skip |

### Step 3 — Classify notes
Same pattern as notebooks, with additions:

| Situation | Action |
|---|---|
| Both modified, local carries `restoredAt` | **Restored from a backup and not uploaded since — local wins outright.** Uploaded as-is with the remote etag as the `If-Match` base. A merge would re-apply the server's strokes and `deletedStrokes` and undo the restore. `updateNoteEtag()` clears the marker once the upload lands. See [backup_restore_design.md §5.6](backup_restore_design.md). |
| Both modified, local is locally encrypted | `attemptMergeEncrypted()`: decrypt on the main thread (where the key is), then `attemptMerge()` as for a plain note; the merged note is saved (re-encrypted by `saveNote`) and queued. Falls back to local-wins only when the app is locked or the note cannot be decrypted. |
| Both modified (conflict) | `attemptMerge()`. If merge succeeds: save locally + queue upload. If fails: add to conflicts list. |
| Remote etag changed, but `remote.modified === local.modified` | **Etag oscillation** — accept new etag via `noteEtagsToUpdate` without downloading. |
| Remote version < local version (stale fork) | Attempt merge even though local `synced=true` (via `attemptMergeEncrypted()` for an encrypted local). |

`attemptMerge()` itself still refuses an encrypted note, because it must stay safe to call from the Web Worker, which holds no key. Before `attemptMergeEncrypted()` existed, both encrypted branches fell straight back to local-wins, silently discarding the other device's strokes, media and recordings on every sync.

### Step 4 — Upload
Runs concurrently (5 notes at a time):

```
For each note to upload:
  1. decryptNoteFields()           — unwrap local encryption if enabled (per field, see below)
  2. syncNoteMedia()               — upload binary files (see below)
  3. cleanupOrphanedMedia()        — delete remote files no longer referenced
  4. Strip internal fields         — remove synced, lastSyncedEtag, encrypted, _currentFileEtag,
                                     previousNotebookId, restoredAt (and legacy thumbnail, if present)
  5. PUT note JSON                 — with If-Match: {etag} header. A 412
     (remote changed since our last sync) FAILS the upload — the note stays
     synced=false so the next cycle downloads + merges + re-uploads. It is
     NEVER force-overwritten (that would silently lose the concurrent remote
     edit; see the 412-recovery requirement below and commit e809876).
```

**Fields that cannot be decrypted are taken from the server.** `decryptNoteFields()` decrypts each field independently and reports the ones it could not decrypt (a key this client no longer holds), instead of failing the whole note. Before, one bad field failed the note's upload on every sync, forever. It throws only when the app is locked.

Such a field holds no local edits: `saveNote` re-encrypts every field it writes with the current key, so whatever the user changed is in fields that decrypt. The upload therefore keeps both sides. `fillUndecryptableFieldsFromServer()` downloads the server's copy of the note (one extra GET, only on this path, because `fullSync` usually holds just a stub of an unchanged remote note) and takes the failed fields from it. The new edits go up from this device, and the result is also saved locally, which re-encrypts the recovered fields with the current key.

| Server copy | Outcome |
|---|---|
| Has the field | Field taken from the server; upload proceeds; local copy healed |
| Missing (404), unreadable, or lacks the field | Uploaded with the field empty — there is no copy left to keep |
| Cannot be fetched (network, 5xx) | Upload skipped this cycle; note stays `synced=false` and retries next sync |

`attemptMergeEncrypted()` applies the same rule from the remote note it already holds, before merging, so an empty local value cannot win a merge. Known gap: a moved note's old server file is deleted before upload, so a moved note with an unreadable field goes up with it empty. A field the user edited *while* it was unreadable (e.g. new strokes drawn after the old ones failed to load) decrypts fine and is uploaded as it is, with only the new content.

### Step 4b — Legacy PDF healing
Finds notes that have `pdf-page` media items but no `pdfSource` field (created before `pdfSource` tracking was introduced). For each:
1. Load full note content.
2. Call `syncNoteMedia()` to upload the PDF binary if missing.
3. Patch `pdfSource` on the local note so it is treated correctly in future syncs.

---

## syncNoteMedia() — Binary File Upload

Called during upload for every note being synced.

```
1. Skip if note.media is an encrypted blob (not an array).
2. Ensure folder chain exists:
     createFolder(/NoteBerg/notebooks/{notebookId})      ← 405 = already exists, OK
     createFolder(/NoteBerg/notebooks/{notebookId}/notes)
     createFolder(/NoteBerg/notebooks/{notebookId}/notes/{noteId}_media)
3. List existing remote files in media folder.
4. Build deduplicated file list:
     note.media items (by fileId — pdf-page pages all share one fileId)
     + note.pdfSource
     + note.recordings
5. For each unique fileId:
     - getFile(fileId) from IndexedDB
     - Skip if already on remote (by filename)
     - Queue upload
6. Upload in batches of 3 (MEDIA_UPLOAD_CONCURRENCY).
```

**Key point for PDF notes:** A 500-page PDF creates 500 `pdf-page` entries in `note.media` but they all share one `fileId` (the PDF binary). Deduplication collapses this to a single file upload/check.

---

## downloadNoteMedia() — Binary File Download

Called after downloading a note's JSON.

```
1. Build deduplicated file list (same dedup logic as upload).
2. For each unique fileId:
     - checkFileExists(fileId) in IndexedDB — skip if present
     - Find matching remote file (fileId prefix match in media folder listing)
     - Download binary
     - saveFile(blob, fileId) to IndexedDB
```

---

## mediaCheckQueue — Missing File Recovery

For notes whose JSON was **not** downloaded (etag unchanged, note considered up-to-date), the sync still checks whether their binary files are present locally. This handles the case of a fresh install or cleared local storage.

```
Condition to enter queue (from index stub) — any of:
  note.media is a non-empty array, or an encrypted {data, iv} blob
  note.recordings has any non-deleted entry, or is an encrypted blob
  note.pdfSource is set

For each queued note (concurrency = 5):
  1. Check if remote media folder has any files (remoteMediaMap).
     If no remote files: skip (nothing to download).
  2. getRawNote() — load full content to get fileIds.
  3. If locally encrypted: decryptNoteLocally() first.
  4. downloadNoteMedia() — download any missing binaries.
```

**Why `getRawNote()` is needed:** The index stub's media array has no `fileId`. The full content record is required before any file download can happen.

**Why the gate errs toward looking:** the stub is the *index* entry, and `splitNote()` strips `fileId` from the index copy of `recordings`; on an encrypted note `media`/`recordings` are blobs, not arrays. The old condition (`media.length > 0` or a recording *with* `fileId`) therefore let no recording-only note and no encrypted note through, so their binaries were never fetched. A false positive costs one cheap check; a false negative loses the binaries for good. Likewise step 3: `getRawNote()` does not decrypt, and every check in `downloadNoteMedia()` is array-shaped.

---

## Tombstones

Tombstones record deletions so other devices know to remove items they already downloaded.

| File | Scope | Contents |
|---|---|---|
| `/NoteBerg/notebooks/_tombstones.json` | Global | List of deleted notebook IDs |
| `/NoteBerg/notebooks/{id}/_tombstones.json` | Per notebook | List of deleted note IDs in that notebook |
| `/NoteBerg/quickNotes/_tombstones.json` | Quick notes | List of deleted quick note IDs |

When a note is purged locally:
1. Remote note file is deleted.
2. Remote media folder is deleted.
3. Note ID is appended to the notebook's tombstone file.

When downloading: if a note is in the remote tombstone and the local copy is unmodified (`synced=true`), it is deleted locally. If the local copy was modified, it is restored (re-uploaded).

---

## Conflict Resolution (`attemptMerge`)

Returns `null` (unresolvable conflict) when:
- Either side is locally encrypted. (`fullSync` decrypts first via `attemptMergeEncrypted()`, so on the main thread this only blocks a merge while the app is locked.)
- Either side has encrypted content blobs.
- Local is a metadata stub with `hasStrokes=true` but no actual strokes loaded.

Otherwise merges field by field:

| Field | Strategy |
|---|---|
| title, background | Newer timestamp wins |
| content (text) | If one contains the other: use longer. If diverged: conflict (null). |
| strokes | Union: both sides keep their strokes unless explicitly deleted. Newer side's deletions win. |
| tags | Union set |
| media, recordings | Newer side's version wins per ID; deleted items stay deleted |
| tasks | Newer `modified` timestamp wins per task ID |

---

## Etag Oscillation Fix

Nextcloud sometimes alternates between two etag values for the same unchanged file (a server-side versioning artifact). Detected when:
- Remote etag differs from local `lastSyncedEtag`
- But `remote.modified === local.modified`
- And local is not modified (`synced=true`)

Resolution: accept the new etag via `updateNoteEtag()` without downloading. No content transfer occurs.

---

## Concurrency

| Operation | Concurrency |
|---|---|
| Notebook uploads | 5 |
| Note uploads | 5 |
| Note downloads | 5 |
| Media file uploads | 3 |
| mediaCheckQueue | 5 |
| Purged note deletions | 5 |

---

## Known Edge Cases and Fragile Areas

### PDF notes with many pages
- 500 pages = 500 `pdf-page` entries in `note.media`, but only **1 binary file** (`pdfSource`).
- All media entries share the same `fileId` — deduplication is critical or the sync loops 500× over one file.
- `deletedMedia` accumulates entries when a PDF is removed; these are never purged and grow the note JSON permanently.

### Legacy PDF notes (no `pdfSource`)
- Notes created before `pdfSource` field was introduced have `pdf-page` items with `fileId` in content but `pdfSource = null` in the index.
- The "healing" block in Step 4b patches these. It requires the notes folder chain to already exist on the remote — if it does not, `createFolder()` gets a 409 Conflict. `syncNoteMedia()` now creates the full parent chain before the media folder to avoid this.

### Self-heal of a plain note whose notebook folder is missing (latent gap)
- Design intent (Step 2 / Step 3 "self-heal"): a locally-modified note that is
  missing on the remote should be re-uploaded, recreating structure as needed.
- Actual behavior: `syncNoteMedia()` creates the `{notebookId} → notes → _media`
  folder chain **only for notes that have media/pdf/recordings** — it returns
  early (before any `createFolder`) for a plain text/stroke note. So uploading a
  plain note into a notebook folder that does not exist on the server returns
  **409 Conflict** and the upload fails.
- Consequence: the note is **not lost** — it stays `synced=false` and retries —
  but it will keep failing until the notebook folder is (re)created, e.g. by a
  notebook sync or a media-bearing note in the same notebook. A note orphaned by
  a remote notebook purge (notebook deleted on another device) therefore cannot
  self-heal on its own.
- This is a real gap between design ("self-heal re-uploads") and code, flagged
  rather than encoded as correct. Fix would be to ensure the parent folder chain
  in the note-JSON upload path too (not only in `syncNoteMedia`).

### Race conditions during sync
- `performSync` snapshots local state before calling `fullSync`.
- After fullSync returns, each downloaded note is compared against current local state.
- If the note was modified locally *during* the sync, `attemptMerge` is tried rather than overwriting.

### Android / Nextcloud WebView WASM restriction
- Nextcloud's CSP blocks `WebAssembly.instantiate()` (no `wasm-unsafe-eval`).
- PDF.js JBig2 decoder falls back to an inlined pure-JS build (`jbig2_nowasm_fallback.js`) that is patched into the worker blob at build time to avoid the dynamic `import()` that would also be blocked by CSP.
