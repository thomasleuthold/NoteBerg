# Sync & Storage Code Review

Date: 2026-06-11
Scope: `storage.webdav.js` (NC app backend), `nextcloudSync.js`, `sync.js`, `storage.js`, `autoSync.js`, `tombstones.js`, `StorageWorker.js`, `encryption.js`
Branch: `Bump_versions_bug_fixes`

Findings ordered by severity. Checkboxes for tracking fixes.

---

## Critical — data loss risks

### 1. NC build: `moveNote` loses the note if the write fails, and never moves media
`storage.webdav.js:665-677` deletes the note JSON from the old location **before** writing it to the new one. If `_putNote` fails (network drop, 423 that exhausts retries), the only copy of the note is gone.

The media folder (`{noteId}_media`) is never moved at all — after a move, `getNoteMediaFolder(noteId, newNotebookId)` points at an empty folder, so once the in-memory `_fileLocationCache` is gone (page reload), all images/recordings/PDFs in the moved note are unreachable. The binaries sit orphaned in the old notebook's folder.

No tombstone is written for the old location, so a native client that had the note synced sees "missing on server, not in tombstone → re-upload (self-healing)" (`nextcloudSync.js:2072-2077`) and resurrects the note in the old notebook — the move silently undoes itself or duplicates the note.

**Fix:** use WebDAV `MOVE` (atomic server-side) for both the JSON and the media folder, then write the tombstone for the old path — mirroring the native move handling in `nextcloudSync.js:1381-1422`.

- [x] Fixed — note JSON is written to the new location first, media folder moved via server-side `MOVE`, old JSON deleted last, old location tombstoned. Covered by `storage.webdav.test.js`.

### 2. NC build: `copyNote` shares fileIds without copying binaries
`storage.webdav.js:679-695` copies `media`, `recordings`, and `pdfSource` references as-is, but media lives in per-note folders. The copy's media folder is empty; display only works by accident while the original note exists (the `getFile` fallback scan finds the binary via the original). Delete the original (`permanentlyDeleteNote` removes its media folder) and the copy's media is permanently gone.

The native version (`storage.js:520-558`) deep-copies blobs with new fileIds.

**Fix:** server-side WebDAV `COPY` of each file into the new note's media folder.

- [x] Fixed — media binaries are server-side `COPY`ed into the copy's own folder before the JSON is written. Covered by `storage.webdav.test.js` (incl. copy surviving deletion of the original).

### 3. 412 conflict → force overwrite throws away remote changes
`nextcloudSync.js:583-599`: when `If-Match` fails, the code deletes the header and PUTs again, overwriting whatever changed on the server. A 412 means another device wrote *after* this sync's PROPFIND — exactly what the etag protects against. The window is the entire sync duration (minutes with large media). Applies to note, notebook, and tombstone uploads since `uploadFile` is shared.

**Fix:** on 412, return failure for that note (it stays `synced=false`) and let the next sync cycle classify it as modified-both-sides and merge.

- [x] Fixed — `uploadFile` now throws on 412 (with `err.status = 412`); the per-item catch marks the upload failed so the next cycle merges. Covered by the updated 412 test in `nextcloudSync.test.js`.

### 4. `updateNoteEtag` unconditionally sets `synced=true`, masking edits made during sync
`storage.js:747-753`, called from `sync.js:255-264`. Sequence: sync starts uploading a note (slow media upload) → user draws strokes → StorageWorker sets `synced=false`, bumps `modified` → upload finishes → `updateNoteEtag` flips `synced=true`. The new strokes are stored locally but never uploaded until the user edits the note again; other devices keep diverging.

**Fix:** pass the `modified` value captured at upload time; only set `synced=true` if the index still matches.

- [x] Fixed — `updateNoteEtag(noteId, etag, expectedModified)` only flips `synced` when `modified` is unchanged; all sync.js call sites pass the timestamp captured at upload/classification time (`noteEtagsToUpdate` entries now carry `modified`). Covered by new `updateNoteEtag` tests in `storage.test.js`.

### 5. Tombstone read-modify-write has no concurrency protection
Every tombstone update (both backends) is download → add entry → upload with no `If-Match` (`nextcloudSync.js:1336-1351`, `storage.webdav.js:46-49`). Two devices purging notes concurrently drop each other's entries → ghost notes resurrect on a third device.

Additionally, in the NC build a tombstone that fails to parse (`storage.webdav.js:70-75` returns `null` on bad JSON) is silently replaced by a fresh tombstone containing only the new entry — one corrupted read wipes 90 days of deletion history.

**Fix:** tombstone PUTs should use the etag from the download and merge-retry on 412. `mergeTombstones()` in `tombstones.js` already exists and is currently unused.

- [x] Fixed — both backends now use a read–mutate–PUT loop (`updateRemoteTombstone` / `_updateTombstone`) with `If-Match` (or `If-None-Match: *` on create) and up to 3 retries that re-read and re-apply on 412. Unparseable tombstones abort the operation instead of being replaced. Covered by concurrency + corruption tests in both test suites.

---

## Bugs / logic errors

### 6. All `isAuthenticated()` guards in nextcloudSync.js are no-ops
`isAuthenticated` is async (`nextcloudSync.js:295`), but 12 call sites in the same file call it without `await` — e.g. lines 1160, 1286, 1523, 1002. `!Promise` is always `false`, so the guards never fire. Mostly benign (downstream `getStoredCredentials` throws), but `hasRemoteChanges` (line 1002) intends `return false` when logged out and instead proceeds. `autoSync.js` awaits correctly; these should too.

- [ ] Fixed

### 7. Etag-oscillation guard compares mismatched time resolutions
`nextcloudSync.js:2127-2137` requires `remote.modified === local.modified` exactly. `remote.modified` comes from WebDAV `getlastmodified` (second resolution — set via `X-OC-Mtime = floor(ms/1000)`), while `local.modified` is a millisecond timestamp from the note JSON. They're only equal when the ms component happens to be 0, so the guard almost never fires and oscillating etags fall through to a full redundant download (the `version+modified identical` check in `sync.js:331-340` then catches it after downloading).

**Fix:** tolerance comparison, e.g. `Math.abs(remote.modified - local.modified) < 2000`. The original implementation of this fix used a 2-second tolerance — strict equality looks like a regression.

- [ ] Fixed

### 8. Notebook conflicts are detected but never resolved
`fullSync` populates `conflicts.notebooks` (`nextcloudSync.js:2011-2012`), but `performSync` only resolves `conflicts.notes` — both the `preferNewer` path and the dialog path. A conflicted notebook stays `synced=false` with a mismatched etag forever: re-flagged every sync, never uploaded, never downloaded. Title/color edits on two devices deadlock.

**Fix:** notebooks have no mergeable content — last-write-wins on `modified` is sufficient.

- [ ] Fixed

### 9. `hasRemoteChanges` false-positives on soft-deleted notes → sync on every note open
`autoSync.js:185-186` passes `getNotesByNotebook()` (filters `!n.deleted`) into `hasRemoteChanges`. A soft-deleted note still has its JSON on the server, so its etag is unknown locally → `localEtagMap.get(noteId) !== file.etag` is always true (`nextcloudSync.js:1010-1015`) → every note/notebook open in that folder triggers a full sync until the deleted note is purged.

**Fix:** pass the unfiltered index (including deleted notes, scoped to the notebook).

- [ ] Fixed

### 10. NC build writes tombstones on *soft* delete — semantic mismatch with native clients
In the native flow, tombstones mean "permanently purged; delete your local copy" (`sync.js` calls `permanentlyDeleteNote` when a tombstoned note is missing remotely). The NC build writes tombstones on plain soft delete (`storage.webdav.js:613-629`, `323-341`) and `restoreNote`/`restoreNotebook` never remove the entry. While the JSON exists remotely the tombstone is ignored, but any transient listing glitch where the note appears missing causes native clients to **permanently** delete a note the NC user only recycled.

**Fix:** tombstone only in `permanentlyDeleteNote`/`permanentlyDeleteNotebook` (which already do it).

- [ ] Fixed

### 11. NC build: only `updateNote` goes through the per-note write queue
`_enqueueWrite` (`storage.webdav.js:570-585`) exists to serialize read-modify-write, but `saveNote`, `deleteNote`, `restoreNote`, `moveNote`, and `clearNoteMoveFlag` bypass it. A `deleteNote` racing a queued `updateNote` can interleave so the update's PUT lands last and resurrects the note (with the tombstone still claiming it's deleted).

**Fix:** route all note writes for a given id through the queue.

- [ ] Fixed

### 12. `mergeStrokes` scrambles temporal stroke order
`nextcloudSync.js:1707-1748` appends the secondary side's unique strokes after all priority strokes. Strokes are stored and consumed in temporal order — the handwriting recognition backend depends on it — so a merged note can produce garbled recognition and wrong z-order rendering.

**Fix:** if strokes carry a timestamp, sort the merged result by it; otherwise preserve the older array's order as the base and splice in newer strokes.

- [ ] Fixed

### 13. `fetchRemoteState` relies on `Depth: infinity`, which Nextcloud disables by default
`nextcloudSync.js:926-934` — `dav.propfind.depth_infinity` is off by default on stock Nextcloud; servers respond 400 and the whole sync throws. Works on servers where it's enabled, fails hard on stock installs.

**Fix:** fall back to per-folder Depth:1 walks (`listFiles`/`listFolders` already exist).

- [ ] Fixed

---

## Security

### 14. Stored XSS via note HTML content (most relevant to the NC build)
`note.content` is raw HTML synced verbatim and re-injected without sanitization — e.g. `noteRenderer.js:644` does `ghost.innerHTML = note.content` and **attaches the element to `document.body`**, where `<img src=x onerror=...>` executes (innerHTML neuters `<script>` but not event-handler attributes). In the NC build this runs inside the Nextcloud origin with the user's session and `requesttoken` — anything that can write a note JSON into the WebDAV folder (another app, a sync client, a shared-folder participant, a compromised device) gets script execution in the NC session.

**Fix:** sanitize on render (DOMPurify or NC's built-in sanitizer) at the injection points — thumbnail ghost and the text-editor load path.

- [ ] Fixed

### 15. Server-supplied ids flow into WebDAV paths unvalidated
`note.id` / `note.notebookId` parsed out of downloaded JSON are interpolated into paths for PUT/DELETE (`storagePaths.js:49-65`). An id containing `../` lets crafted content steer deletes/writes anywhere in the user's DAV space (e.g. `/Photos`). Ids are self-generated UUIDs in normal operation.

**Fix:** validate `^[0-9a-f-]{36}$`-style at sync ingestion.

- [ ] Fixed

### 16. PBKDF2 at 100k iterations, extractable key
`encryption.js:14` — OWASP's current guidance for PBKDF2-SHA256 is ~600k iterations; 100k is weak against offline brute force of synced encrypted blobs. The derived AES key is also created with `extractable: true` (`encryption.js:93`) with no current need.

**Fix:** bump iterations (the `version` field in encrypted blobs gives a migration hook); set extractable false.

- [ ] Fixed

### 17. Login flow logs sensitive material; bad uid fallback
`startLoginFlow` logs the full `login/v2` response body including the poll token (`nextcloudSync.js:377-378`) — anyone reading the log within the 20-minute window can poll for the app password. Also `storage.webdav.js:54` falls back to uid `"admin"` when `window.OC` is missing; better to throw than aim requests at another user's DAV root.

- [ ] Fixed

---

## Simplification opportunities

- **Duplicate decryption in `syncNotes`**: `nextcloudSync.js:1439` and `:1455` both call `decryptNoteLocally(syncedNote)` — the second result is misnamed `encryptedNote`. Reuse `decryptedNote`.
- **MIME table duplicated** in `nextcloudSync.js:74-89` and `storage.webdav.js:715-737` — extract a shared `mime.js` (they already drifted: only the webdav copy has magic-byte sniffing).
- **`syncNotebooks` / `syncNotes` share ~120 lines** of purge-delete-then-tombstone and result-aggregation logic — factor into one helper parameterized by tombstone path and delete function.
- **`performSync` re-invokes itself recursively** after conflict resolution (`sync.js:185`, `:221`) — a `while` loop with a max-iterations guard is easier to reason about and can't stack up.
- **NC overview cost**: `getAllNotes` downloads every note JSON including full strokes (one GET per note, every overview render — `storage.webdav.js:548-557`), and `getAllNotebooks` re-PROPFINDs each time (called by `getAllNotes`, `_findNote`, and the `getFile` fallback). A short-lived in-memory cache keyed by folder etag would cut most of the traffic.
- **`tombstones.js` `mergeTombstones` is dead code** in the current sync path — superseded by the re-read-and-re-apply retry loop added for finding 5; can be deleted.
- **StorageWorker `SAVE_PRESETS` bumps `version`/`modified` and flags `synced=false`** for a pen-preset change (`StorageWorker.js:143-163`) — UI preference churn triggering full note re-uploads, same class of problem as the thumbnail fix.

---

## Overall assessment

The native sync engine's architecture (etag-based change detection, tombstones, three-way merge, self-healing media) is sound. The two weakest areas:

1. **The NC WebDAV backend treats multi-step server operations as if they were atomic local DB writes** (move, copy, delete-then-tombstone) — findings 1, 2, 5, 11 all stem from this.
2. **Conflict-protection mechanisms that disarm themselves under pressure** (412 force-overwrite, unconditional `synced=true`) — findings 3 and 4.

Recommended order: fix 1–5 before the next release (done 2026-06-11); 6, 7, and 9 are small diffs with outsized payoff.
