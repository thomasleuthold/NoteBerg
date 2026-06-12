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

- [x] Fixed — all 12 guards now `await isAuthenticated()`.

### 7. Etag-oscillation guard compares mismatched time resolutions — **WITHDRAWN (not a bug)**
~~`remote.modified` comes from WebDAV `getlastmodified` (second resolution)…~~ Re-analysis showed the finding's premise was wrong: in the oscillation branch, `remote` is always a **fully downloaded** note (the etag differed, so `downloadAllData` fetched it), and its `modified` comes from the note JSON with millisecond precision — not from the WebDAV mtime. In true oscillation the remote file is our own upload, so strict equality matches exactly.

Moreover, a 2-second tolerance *was* the original implementation and was deliberately removed in commit e809876 ("Fix sync bug leading to stroke loss") because it swallowed genuinely newer remote edits. A clarifying comment was added at the guard so this isn't "fixed" again.

- [x] Resolved — withdrawn; protective comment added in `fullSync`.

### 8. Notebook conflicts are detected but never resolved
`fullSync` populates `conflicts.notebooks` (`nextcloudSync.js:2011-2012`), but `performSync` only resolves `conflicts.notes` — both the `preferNewer` path and the dialog path. A conflicted notebook stays `synced=false` with a mismatched etag forever: re-flagged every sync, never uploaded, never downloaded. Title/color edits on two devices deadlock.

**Fix:** notebooks have no mergeable content — last-write-wins on `modified` is sufficient.

- [x] Fixed — fullSync now resolves modified-both-sides notebooks by last-write-wins in the same cycle (newer remote → download, newer local → upload with the remote etag as If-Match base). `conflicts.notebooks` is no longer populated. Covered by two new tests.

### 9. `hasRemoteChanges` false-positives on soft-deleted notes → sync on every note open
`autoSync.js:185-186` passes `getNotesByNotebook()` (filters `!n.deleted`) into `hasRemoteChanges`. A soft-deleted note still has its JSON on the server, so its etag is unknown locally → `localEtagMap.get(noteId) !== file.etag` is always true (`nextcloudSync.js:1010-1015`) → every note/notebook open in that folder triggers a full sync until the deleted note is purged.

**Fix:** pass the unfiltered index (including deleted notes, scoped to the notebook).

- [x] Fixed — new `getLocalNotesForChangeCheck()` helper filters `getAllNotesForSync()` by notebook without excluding deleted notes. Also fixes the quick-notes case (`getNotesByNotebook(null)` queried an IndexedDB index with a null key, which can't match). Covered by new autoSync tests.

### 10. NC build writes tombstones on *soft* delete — semantic mismatch with native clients
In the native flow, tombstones mean "permanently purged; delete your local copy" (`sync.js` calls `permanentlyDeleteNote` when a tombstoned note is missing remotely). The NC build writes tombstones on plain soft delete (`storage.webdav.js:613-629`, `323-341`) and `restoreNote`/`restoreNotebook` never remove the entry. While the JSON exists remotely the tombstone is ignored, but any transient listing glitch where the note appears missing causes native clients to **permanently** delete a note the NC user only recycled.

**Fix:** tombstone only in `permanentlyDeleteNote`/`permanentlyDeleteNotebook` (which already do it).

- [x] Fixed — `deleteNote`/`deleteNotebook` no longer write tombstones (the `deleted` flag in the JSON propagates recycle-bin state); `permanentlyDeleteNote`/`permanentlyDeleteNotebook` still do. The `moveNote` old-location tombstone stays (intentional — it marks an obsolete path, and remote presence at the new path prevents local hard-deletes). Covered by new delete-semantics tests.

### 11. NC build: only `updateNote` goes through the per-note write queue
`_enqueueWrite` (`storage.webdav.js:570-585`) exists to serialize read-modify-write, but `saveNote`, `deleteNote`, `restoreNote`, `moveNote`, and `clearNoteMoveFlag` bypass it. A `deleteNote` racing a queued `updateNote` can interleave so the update's PUT lands last and resurrects the note (with the tombstone still claiming it's deleted).

**Fix:** route all note writes for a given id through the queue.

- [x] Fixed — `saveNote`, `deleteNote`, `restoreNote`, `moveNote`, `clearNoteMoveFlag`, and `permanentlyDeleteNote` all run through `_enqueueWrite` now. Also fixed a latent unhandled-rejection leak in the queue's cleanup chain. Covered by a serialization test (delayed update + immediate delete).

### 12. `mergeStrokes` scrambles temporal stroke order
`nextcloudSync.js:1707-1748` appends the secondary side's unique strokes after all priority strokes. Strokes are stored and consumed in temporal order — the handwriting recognition backend depends on it — so a merged note can produce garbled recognition and wrong z-order rendering.

**Fix:** if strokes carry a timestamp, sort the merged result by it; otherwise preserve the older array's order as the base and splice in newer strokes.

- [x] Fixed — merge now uses the older side as base order, the newer side overrides same-id strokes in place (still wins conflicts) and appends its new strokes; when all strokes carry `time[0]` (set by StrokeManager) the result is additionally sorted by it. Covered by two new ordering tests.

### 13. `fetchRemoteState` relies on `Depth: infinity`, which Nextcloud disables by default
`nextcloudSync.js:926-934` — `dav.propfind.depth_infinity` is off by default on stock Nextcloud; servers respond 400 and the whole sync throws. Works on servers where it's enabled, fails hard on stock installs.

**Fix:** fall back to per-folder Depth:1 walks (`listFiles`/`listFolders` already exist).

- [x] Fixed — on 400/403/501, `fetchRemoteStateShallow()` walks the known layout with Depth:1 (notebooks root → per-notebook folder + notes folder → quickNotes). Media folders are not walked; `downloadNoteMedia` lists them on demand, so the only degradation is the missing-media check for unchanged notes. Covered by a fallback test.

---

## Security

### 14. Stored XSS via note HTML content (most relevant to the NC build)
`note.content` is raw HTML synced verbatim and re-injected without sanitization — e.g. `noteRenderer.js:644` does `ghost.innerHTML = note.content` and **attaches the element to `document.body`**, where `<img src=x onerror=...>` executes (innerHTML neuters `<script>` but not event-handler attributes). In the NC build this runs inside the Nextcloud origin with the user's session and `requesttoken` — anything that can write a note JSON into the WebDAV folder (another app, a sync client, a shared-folder participant, a compromised device) gets script execution in the NC session.

**Fix:** sanitize on render (DOMPurify or NC's built-in sanitizer) at the injection points — thumbnail ghost and the text-editor load path.

- [x] Fixed — added DOMPurify (`src/utils/sanitizeHtml.js`, default profile keeps formatting/classes/data-* for task spans) and applied it at **four** sinks: thumbnail ghost (`noteRenderer.js`), editor load (`TextEditorLayer.js`, with `_lastHtml` kept in sanitized form for dirty-detection), PDF-export iframe (`pdfExport.js` — `document.write` even executes `<script>`), and the conflict-dialog content previews (`modals.js`). Also found and fixed an unescaped note **title** interpolation in the conflict dialog (i18next is configured with `escapeValue: false`). Covered by `sanitizeHtml.test.js`.

### 15. Server-supplied ids flow into WebDAV paths unvalidated
`note.id` / `note.notebookId` parsed out of downloaded JSON are interpolated into paths for PUT/DELETE (`storagePaths.js:49-65`). An id containing `../` lets crafted content steer deletes/writes anywhere in the user's DAV space (e.g. `/Photos`). Ids are self-generated UUIDs in normal operation.

**Fix:** validate `^[0-9a-f-]{36}$`-style at sync ingestion.

- [x] Fixed — validation lives in the path builders themselves (`storagePaths.js`), the single chokepoint both backends use: ids must match `^[\w-]{1,64}$`, media filenames must not contain `/`, `\`, or `..`. Covered by `storagePaths.test.js`.

### 16. PBKDF2 at 100k iterations, extractable key
`encryption.js:14` — OWASP's current guidance for PBKDF2-SHA256 is ~600k iterations; 100k is weak against offline brute force of synced encrypted blobs. The derived AES key is also created with `extractable: true` (`encryption.js:93`) with no current need.

**Fix:** bump iterations (the `version` field in encrypted blobs gives a migration hook); set extractable false.

- [x] Fixed — `PBKDF2_ITERATIONS` raised to 600,000 for **new** key derivations; `deriveKeyFromPassword`/`hashPassword` take an explicit `iterations` parameter, and `unlockApp` passes the count stored in the user's `encryption_config` (the field always existed — it was just ignored), falling back to the legacy 100k for configs without it. `changeMasterPassword` upgrades to the new count (it re-derives from a fresh salt anyway). Derived key is now `extractable: false` (nothing calls `exportKey`; workers receive the key via structured clone, which is unaffected). Covered by `masterPassword.test.js`.

### 17. Login flow logs sensitive material; bad uid fallback
`startLoginFlow` logs the full `login/v2` response body including the poll token (`nextcloudSync.js:377-378`) — anyone reading the log within the 20-minute window can poll for the app password. Also `storage.webdav.js:54` falls back to uid `"admin"` when `window.OC` is missing; better to throw than aim requests at another user's DAV root.

- [x] Fixed — `startLoginFlow` no longer logs the response body, parsed init data, token prefix, or login URL (a SECURITY comment marks why); `getWebDAVBase()` throws when no Nextcloud uid is available instead of defaulting to `admin`. Covered by a `getWebDAVBase` safety test.

---

## Simplification opportunities — all done

- [x] **Duplicate decryption in `syncNotes`** — second `decryptNoteLocally` call removed; `noteForUpload` is built from the already-decrypted note.
- [x] **MIME table duplicated** — extracted `src/modules/mime.js` (`MIME_TO_EXT`, `extFromMime`, `mimeFromExt`); both backends import it. Magic-byte sniffing stays webdav-local (only consumer).
- [x] **`syncNotebooks` / `syncNotes` shared purge + aggregation** — factored into `purgeRemoteItems()` (delete-first → tombstone → local cleanup, parameterized by delete/tombstone/cleanup functions) and `aggregateSyncResults()`. ~100 lines removed, behavior preserved.
- [x] **`performSync` recursion → bounded loop** — at most 3 passes; conflict resolutions `continue` into a fresh pass. Bonus: `isSyncing` is now held across passes (the recursion briefly released it, leaving a window for a concurrent sync to start mid-resolution).
- [x] **NC overview cost** — 15s in-memory read cache for notebook and note-folder listings in `storage.webdav.js`, cleared by every local write (`davPut`/`davDelete`/`MOVE`/`COPY`), so staleness only applies to other clients' changes within the TTL. Entries are cloned on hit (same mutation contract as a fresh fetch). Chose write-invalidated TTL over the etag-keyed variant — simpler, and etag-keying would inherit the NC etag-oscillation problem. Also deduplicated `getAllNotebooks`/`getDeletedNotebooks` into one cached `_getAllNotebooksRaw()`. Covered by a cache test (hit within TTL, never stale after a write).
- [x] **`mergeTombstones` dead code** — deleted (superseded by the If-Match re-read-and-re-apply retry loop from finding 5).
- [x] **StorageWorker `SAVE_PRESETS` churn** — writes only `noteContent.penPresets`; no `modified`/`version`/`synced` change. A pen-color change no longer re-uploads the note; presets ride along with the next content/stroke save. Test updated to pin this.

---

## Overall assessment

The native sync engine's architecture (etag-based change detection, tombstones, three-way merge, self-healing media) is sound. The two weakest areas:

1. **The NC WebDAV backend treats multi-step server operations as if they were atomic local DB writes** (move, copy, delete-then-tombstone) — findings 1, 2, 5, 11 all stem from this.
2. **Conflict-protection mechanisms that disarm themselves under pressure** (412 force-overwrite, unconditional `synced=true`) — findings 3 and 4.

Recommended order: fix 1–5 before the next release (done 2026-06-11); 6, 7, and 9 are small diffs with outsized payoff.
