# Backup & Restore — Design

Full local backup to a single `.zip` and restore from it, on **native builds only** (Windows + Android). Absent from the Nextcloud app build, which has no local IndexedDB corpus to back up — it reads WebDAV directly.


---

## 1. What the feature does

- **Backup to file** — one `.zip` containing every notebook, note, and binary (images, PDFs, recordings), optionally password-protected.
- **Restore from file** — reads that `.zip` back into local storage, non-destructively.
- **Freshness tracking** — the app remembers when it last backed up and nudges when that has gone stale, so a six-month-old backup is not mistaken for protection.

**Deliberately out of scope:** the `settings` store (credentials, `encryption_config` — see §7), scheduled/automatic backups, incremental backups, cross-device transfer, notebook-subset selection, and the Nextcloud build entirely.

---

## 2. Why Rust owns the archive

The obvious implementation — assemble the zip in JS, hand Rust the bytes — fails on the IPC boundary before it fails on anything else. The existing `save_pdf` pattern passes bytes as `Array.from(bytes)`, turning every byte into a JSON number: roughly 4× inflation, so a 500 MB backup becomes a ~2 GB JSON string. A JS zip library has the mirror problem: the assembled archive must exist whole in the JS heap before it can cross to Rust at all.

**Rust owns the archive; JS streams entries into it, one at a time:**

```
JS                                      Rust
──                                      ────
backup_begin(path, password?)     ───▶  open ZipWriter on a real file handle,
                                         streaming to disk, never buffered whole

for each entry (loop in JS):
  backup_add_entry / begin_entry  ───▶  write one entry
  + write_chunk (8 MiB slices)         drop each chunk after writing
  progress.update(i, total, …)

backup_finish()                   ───▶  finalize central directory, rename the
                                         .partial file onto the path → path + size
```

Peak memory and peak IPC payload are both bounded by one chunk, not the archive or even one whole entry. Restore mirrors it — `restore_open` → manifest + entry list, `restore_read_begin/chunk/end` → one entry's bytes in slices — and **JS drives the read loop**, so every conflict decision happens in JS where the DB and UI live.

Binary entries cross in **8 MiB chunks** (`CHUNK_BYTES`; **2 MiB on Android**, `ANDROID_CHUNK_BYTES`, because there the base64 string is also copied through JNI) via `backup_begin_entry`/`backup_write_chunk` on write and `restore_read_begin`/`restore_read_chunk`/`restore_read_end` on read. This refines "one entry per call" to "one chunk per call": cancellation is honoured mid-file, and the progress line can show a per-file percentage. JSON entries (small, always read whole) go through single-call `backup_add_text`/`restore_read_text` instead.

On read, `restore_read_begin` decodes the whole entry (decrypting and inflating it) into one staging file, `noteberg-restore-entry-{pid}.bin`. That file goes in the OS temp dir on desktop and in the app cache dir on Android. Chunks are then served from the staging file, so a 300 MiB PDF costs one chunk of RAM. `restore_read_end`/`restore_close` delete it.

Crate: `zip = "8.6"` with `aes-crypto` (WinZip AES-256, never legacy ZipCrypto) and `deflate-flate2-zlib-rs` — a pure-Rust deflate backend, needed because the plain `deflate-flate2` feature leaves flate2 without one on Android.

### Android: cache, then copy

`rfd` (the desktop file-dialog crate) is desktop-only, and Android gives an app no path it may freely write a user-visible file to — it needs the Storage Access Framework. Rust always writes to a plain filesystem path in the app cache dir; `BackupFilePlugin.kt` then does the SAF side: `ACTION_CREATE_DOCUMENT`/`ACTION_OPEN_DOCUMENT` plus a cache ↔ URI copy, deleting the cache file in every outcome (including cancel and error). This keeps the Rust archive code identical on every platform and reuses the FileProvider/intent shape already proven in `PdfSavePlugin.kt`.

Pre-flight: both backup and restore check the estimated/reported size against free cache space (estimate × 1.2, minimum 20 MB headroom) before doing any work, so a shortfall is reported up front rather than discovered mid-copy.

---

## 3. Archive format

```
manifest.json
notebooks/{notebookId}/_notebook.json
notebooks/{notebookId}/notes/{noteId}.json
notebooks/{notebookId}/notes/{noteId}_media/{fileId}.{ext}
quickNotes/{noteId}.json
quickNotes/{noteId}_media/{fileId}.{ext}
```

**Deliberately identical to the Nextcloud sync layout** (`storagePaths.js`), minus the root folder. This buys three things: the existing path builders and id validators (`assertSafeId`/`assertSafeFilename`) work unchanged; a backup is human-inspectable and hand-recoverable; and a `NoteBerg` folder pulled from Nextcloud becomes a valid backup just by adding a `manifest.json` at the zip root.

No tombstones — they are sync bookkeeping, and restoring stale ones would resurrect deletions as sync instructions. **Soft-deleted (recycle bin) items are included** with their `deleted` flag, so the recycle bin survives a restore; purged stubs are not written.

### `manifest.json`

```jsonc
{
  "schema": 1,
  "appVersion": "0.5.42",
  "dbVersion": 5,
  "createdAt": 1757944200000,
  "encrypted": false,
  "counts": { "notebooks": 12, "notes": 340, "files": 187 },
  "totalBytes": 524288000
}
```

Written **last**, so its counts and byte total are exact, and **always unencrypted** even in a password-protected archive — it holds no content, only counts and versions, and the restore UI needs it before asking for a password. Readers locate it by name, so its position in the zip is irrelevant.

**Version gating on restore:** a `schema` or `dbVersion` newer than the running app refuses outright — writing shapes the app cannot read is worse than refusing. Older is accepted; note/notebook shapes are forward-compatible within a schema line.

### Notes are written decrypted

`getNote()` decrypts locally-encrypted content before it is serialized — the same outcome as the Nextcloud upload path's `decryptNoteLocally`, reached independently rather than by importing the sync module, so backup carries no coupling to sync. A backup holding ciphertext would be unreadable after exactly the event that makes a backup necessary: a master-password reset. The zip password is the protection layer instead, and the UI states plainly that an unencrypted backup is unencrypted.

### Deduplication

`pdf-page` media items all share one `fileId` (the source PDF binary). `collectNoteFileIds()` deduplicates per note with the same `seenIds` guard `syncNoteMedia` uses, so a 500-page PDF note doesn't write the same binary 500 times.

---

## 4. Archive password

A single un-confirmed password field is a data-loss trap for a *setting* action — one typo makes a permanently unreadable archive, discovered months later at the exact moment it's needed. The backup password dialog therefore mirrors `showMasterPasswordSetup()`'s shape: password + confirm field, strength meter (`calculatePasswordStrength` from `encryption.js`), and an explicit unrecoverable-password warning. It states two things plainly, because both are easy to assume wrongly: backups are otherwise stored unencrypted, and **this password is independent of the master password** — using the same one is fine, but the app never implies they're linked.

Implementation deviates from the original plan in three ways:

- **No password hint field.** The plan called for one, stored in the plain manifest — but a hint that actually helps recovery is a hint that leaks, sitting unencrypted beside the data it protects. Dropped; the restore prompt just re-asks on a wrong password.
- **Password floor is stricter than the master password's.** Strength ≥ 50 (master password's setup floor is 30) plus a minimum length of 8, because WinZip AES fixes its KDF at PBKDF2-SHA1 with only 1000 iterations — weak enough that the archive is meaningfully attackable offline, unlike the master password's PBKDF2-SHA256 at 600,000 iterations.
- **Never persisted.** Only a boolean, `backupEncryptByDefault`, is remembered (pre-checking the encrypt option next time) — never the password itself.

Encryption is zip's own per-entry WinZip AES-256; there is no whole-archive mode. The manifest entry is simply the one entry written without it.

---

## 5. Restore: non-destructive by construction

### 5.1 Four stages, in order

```
indexArchive()   validate every entry name and size — nothing read yet
scanRestore()    dry run: read JSON metadata, diff against local by id
planRestore()    turn the scan + the user's mode/decisions into actions
applyRestore()   execute, reporting progress, honouring cancellation
```

Splitting the decision (stages 1–3) from the write (stage 4) is what makes every write provably safe before anything happens to local storage.

### 5.2 Restore modes, named by intent

| Mode | Behavior |
|---|---|
| **Restore missing items only** | Existing items untouched; only absent ones added. Zero prompts. |
| **Restore from backup, keep replaced notes in recycle bin** *(default when conflicts exist)* | Backup wins where newer; local wins otherwise. Displaced locals go to the recycle bin (§5.4). |
| **Replace everything** | Purge local data first, then restore verbatim. Confirmed as a destructive action; refused while Nextcloud is connected (§5.6). |

**"Missing only" is not the default**, despite being the conservative-sounding choice — because in the two most common real reasons someone restores ("this note is now wrong, give me the backup version" / "my sync state is bad, restore the good backup"), missing-only does *nothing*: every note already exists, so nothing is touched, and the restore silently reports success while changing nothing. Prefer-backup is safe as a default only because Tier 3 (§5.4) means it never actually destroys anything.

### 5.2.1 The scan decides how much UI appears

The number of decisions shown must scale with the number of genuine conflicts:

| Scan result | Flow |
|---|---|
| Empty local corpus | Pick file → one confirm → progress → done. No mode selection. |
| Existing data, no id collisions | Same, plus "nothing existing will be replaced." |
| Existing data with genuine conflicts | Mode selection + conflict summary → optional per-item review → progress → done. |

An item is a genuine conflict only when **both** `modified` and `version` disagree between archive and local (`noteStatus()` in `restore.js`); same-version items need no decision. A scan that finds nothing to decide produces no decision UI — offering a three-way merge choice to someone restoring onto a blank device is noise implying a risk that isn't present.

### 5.3 Conflict review

The review list is title + local/backup timestamps only, no content previews — previews would mean decrypting and rendering every conflicting note during a dry-run scan, at list scale that's real cost for a rarely-used affordance. Per-item keep-local / keep-backup toggle, plus select-all shortcuts.

### 5.4 Tier 3 — displace and rename, never overwrite in place

Whenever the backup's version of a note wins over an existing local one:

1. `copyNote()` deep-copies the local note's blobs under a **new id**, freeing the original id.
2. The copy's title gets a translated `(replaced)` suffix (`withReplacedSuffix()`).
3. The copy is marked `deleted: true` — it lands in the recycle bin rather than cluttering the notebook.
4. The backup's note is written at the reclaimed original id.

The suffix logic is **idempotent**: if the title already ends in the current locale's suffix, it is not appended again. Titles have no length cap and are CSS-ellipsised everywhere they're shown, so a naive repeat-append would silently produce an unreadable, indistinguishable chain after a few re-restores — exactly the audit trail the suffix exists to prevent from happening. (A user who switches app language between restores can legitimately end up with one suffix of each; accepted, not worth a locale-independent marker.)

Blobs orphaned by a displaced note are not cleaned up during restore — the recycle-bin copy holds its own deep copies, and the normal purge path reclaims the space later.

**v1 does not mark displaced notes visually in the recycle bin.** The completion dialog states the count and offers a button straight to the bin (`showRestoreCompleteDialog`), which covers the moment it matters; a dedicated marker (needing a `displacedByRestoreAt`-style field and a decision on bin filtering) is deferred.

### 5.5 Notebooks: conflict only on id collision

- Id absent locally → create from the archive.
- Id exists, title differs → **keep the local title**, restore notes into it anyway, and note the mismatch in the summary. A notebook is a container; silently renaming a user's notebook is worse than a stale title.
- Id exists and was soft-deleted → undelete it, since the archive asserts it should exist.

No Tier-3 displacement for notebooks — that machinery is note-only.

### 5.6 The sync interaction

Every restored note/notebook is written re-entering sync as a fresh edit:

```js
{
  ...itemFromArchive,
  synced: false,
  lastSyncedEtag: null,
  version: Math.max(local?.version ?? 0, itemFromArchive.version ?? 0) + 1,
  modified: Date.now(),
}
```

The version takes the max of local and archive, so a note that already reached a high version elsewhere (server, other devices) but has never been seen on this device is not rolled back to a low one, which would make it look like a stale fork on the next sync. Notebooks bump past a purged stub's version the same way.

This alone is not sufficient for a note that still exists on the server. The sync engine compares etags, not versions, and a restored note (`lastSyncedEtag: null`) against any server copy classifies as "modified on both sides" — which runs `attemptMerge`, a stroke union that reapplies the server's `deletedStrokes`. That would put back exactly the edits the restore exists to undo. So restored notes also carry a transient field, **`restoredAt`**: the sync classifier treats its presence as "local wins outright," uploading as-is with the remote etag as the `If-Match` base. `updateNoteEtag()` clears the marker once the upload lands; it never crosses into an upload body or an archive (`SYNC_ONLY_FIELDS` strips it going out, `stripArchiveFields` strips it coming in). The post-restore sync runs with `preferNewer` so anything left over resolves by the timestamp the restore just set.

**Guardrails, enforced for the whole operation, not sampled once:**

- **Restore blocks while a sync is in flight** (`getIsSyncing()`, checked in `preflightMessage()` before the file picker opens; autoSync is suspended once the picker returns).
- **AutoSync is suspended for the duration.** `autoSync.js` is event-driven (fires on navigate, note-created, notebook-created), so a one-time check at the start is not enough — a sync could start mid-restore from its own listeners. `suspendAutoSync()`/`resumeAutoSync()` is a reference-counted pair, released in a `finally`.
- **A sync runs after restore completes** when Nextcloud is connected (`performSync({ silent, skipConflictResolution, preferNewer })`, not awaited; progress shows in the footer), so the restored state reaches the server before anything else can touch it.
- **"Replace everything" scans before it purges.** `scanRestore()` reads and parses every JSON entry (decrypting them, which verifies the password and each entry's AES authentication) before `purgeLocalData()` runs, so a corrupt or wrongly-keyed archive is refused while local data is still intact. Media entries are only read during apply, so a damaged media entry, or a full disk, is discovered after the purge.
- **"Replace everything" refuses to run while Nextcloud is connected.** Purging and re-uploading looks like a mass deletion from the server's perspective. The blocked dialog states the reason, states what disconnecting does *not* do (notes stay on the server), and offers an inline **[Disconnect and continue]** button rather than sending the user to hunt through another settings section.

Merge-mode restores stay available while connected — they only ever move `version` forward, which the sync engine sees as an ordinary edit.

### 5.7 Media restoration

Each restored note's `{noteId}_media/` entries are keyed by the `fileId` parsed from the filename and written to the `files` store. Because `fileId`s are UUIDs, a key collision with an unrelated local blob isn't a practical concern — where the key already exists, `checkFileExists()` treats the write as a harmless no-op rather than re-fetching identical bytes.

---

## 6. Backup freshness

Nothing about backup is protective if the app never says how stale the last one is. After every **successful** backup (never on cancel or failure — that would make the feature lie about the one thing it guarantees), the settings store records:

```jsonc
{
  "lastBackupAt": 1757944200000,
  "lastBackupNoteCount": 340,
  "lastBackupBytes": 524288000,
  "lastBackupEncrypted": true
}
```

Deliberately **not** stored: the file path. It goes stale the moment the file moves, gets deleted, or (on Android) was a SAF URI that never survives past the session — a stale path shown as fact is worse than none. The completion dialog shows the real path once, at the one moment it's true.

The Backup section header reflects this state before either button: "Never backed up" (never), "Last backup: 3 days ago (340 notes)" (recent), or the same plus a staleness nudge. The nudge fires only when **both** hold — either alone is a false alarm:

1. the last backup is older than 30 days (or there was none), **and**
2. the corpus has grown meaningfully since: by 10% or by 10 notes, whichever is smaller.

A user who hasn't touched the app in six months does not need to be told to re-back-up an unchanged corpus. The nudge lives only in the Backup section — never a modal, which trains users to reflexively dismiss the dialog that eventually matters.

Automatic/scheduled backups remain out of scope, but this state is deliberately what a future scheduler would read — the intended progression is surface staleness (shipped) → reminder cadence → automate.

---

## 7. What's excluded, and why

The `settings` store holds `encryption_config` and Nextcloud credential material — `purgeLocalData()` already leaves it untouched for the same reason. Putting it in a backup turns a "file of your notes" into a plaintext-by-default file that also contains credentials, a materially different security posture. Excluded from v1; if wanted later it would ship as a separate, explicitly-labeled opt-in with its own warning, and credentials stripped even then.

---

## 8. Security notes

- **Every id and filename parsed from an archive is untrusted** — an entry named `../../../../etc/passwd`, or containing a backslash, leading `/`, or NUL, is rejected outright, and the whole archive is refused on the first violation rather than skipping just that entry (a crafted name is evidence about the whole file). Routed through the same `assertSafeId`/`assertSafeFilename` the sync layer uses.
- **Zip-bomb guards, at two ceilings.** Media entries: 1 GiB. JSON entries: 64 MiB — far lower, because they're read whole and cross the IPC boundary as one string; no genuine note comes close. A declared compression ratio above ~1032:1 (deflate's real ceiling) above a 1 MiB floor is treated as corrupt/hostile rather than data. Declared entry sizes are also cross-checked against the manifest's `totalBytes` (with slack) before any read.
- **Wrong password fails as a distinguishable, typed error** (`WRONG_PASSWORD`), not a generic parse failure — checked against the AES verifier on the first encrypted entry before any data is decoded.
- **Note titles or content are never logged** in the backup/restore path — only ids and paths, matching the existing sync code's discipline.
- **The Android cache temp file is deleted in every outcome** — success, cancel, and error alike — via `finally`-style cleanup on both the Kotlin and Rust sides.

---

## 9. Pre-flight and progress

Neither operation may start from an arbitrary app state:

- **No note open** — an open `NoteCanvas` has writes in flight; its `destroy()` promise (thumbnail save + recognition) must resolve first, or a backup could capture a note the user can see but the DB hasn't received yet.
- **No sync in flight**, checked via `getIsSyncing()`.
- Restore additionally suspends autoSync for the whole run and dispatches `notes-updated` on completion (§5.6), matching the existing purge-button pattern so the overview doesn't show a stale corpus.

Progress is **entry-count plus a detail line** naming the current file (`showProgressDialog`'s `update()` + `setNote()`), rather than byte-weighted — the lighter of the two options considered, since a stalled-looking counter during one large PDF still shows *why* via the filename. `indeterminate()` covers phases with no meaningful count: archive finalization, the dry-run scan, and the Android cache↔SAF copy.

**The destination is replaced only by a complete archive.** `Writer` writes to a sibling `{name}.partial` and, in `finish()`, renames it over the destination after `sync_all`. A user who picks an existing backup as the destination therefore keeps it intact through a cancel, an error, or a full disk; the old file is replaced only by a finished archive. On Android the picker reports whether the chosen document already had content (`existing`), and such a document is never deleted on cancel or failure, unlike a freshly created empty one.

**Cancellation:** a cancelled backup deletes the partial file and leaves freshness state untouched. A cancelled restore leaves already-written notes in place — they're valid, correctly re-dirtied — and the summary says so explicitly, because restore is idempotent (stable ids, monotonic version bumps) and re-running is safe and skips what's already done.

---

## 10. Module map

| File | Responsibility |
|---|---|
| `src/modules/backup_restore/backup.js` | Entry-stream generation, manifest, freshness state, size estimate. Pure logic — no UI, no Tauri. |
| `src/modules/backup_restore/restore.js` | Index → scan → plan → apply; entry-name validation; zip-bomb guards. Pure logic. |
| `src/modules/backup_restore/backupArchive.js` | Tauri invoke wrapper (chunked read/write commands) + in-memory archive for tests. |
| `src/components/backupSection.js` | Settings section markup and both flows. Lazy-loaded from `settingsMode.js`, native only. |
| `src/components/backupModals.js` | Password setup, restore password prompt, mode + conflict review, NC-blocked dialog, completion summary. |
| `src/modules/autoSync.js` | `suspendAutoSync()` / `resumeAutoSync()` — reference-counted suppression. |
| `src-tauri/src/backup.rs` | Streaming zip writer/reader, AES-256, chunked per-entry IPC commands. |
| `src-tauri/gen/android/.../BackupFilePlugin.kt` | SAF create/open + cache↔URI copy, free-space query. |

`backup.js` and `restore.js` being UI-free and Tauri-free is what makes the hard parts (the conflict planner especially) testable against fixtures with no real DB or zip involved.

---

## 11. Known limits

- Foreground-only, like AI recognition's job queue — no background progress.
- The staleness thresholds (30 days, 10%/10 notes) are a starting guess, not a measured one.
- Fingerprinting for "does this need re-backing-up" doesn't exist; freshness is corpus-size-based, not content-hash-based — a user could rewrite every note's content without growing the count and get no nudge.
- No visual marker yet distinguishes restore-displaced recycle-bin entries from genuinely user-deleted ones beyond the completion dialog's one-time count.
- Android, overwriting an existing document: SAF has no write-then-rename, so if the final cache → document copy fails midway, the old backup in that document is already damaged. It is not deleted, though, so a provider's version history can still recover it. Most providers never hand back an existing document from `ACTION_CREATE_DOCUMENT` (they create "name (1).zip" instead).
- A run killed outright (process crash, power loss) leaves `{name}.zip.partial` beside the destination. It is never mistaken for a backup (wrong extension), but it is not cleaned up automatically.
- "Replace everything" leaves a partial corpus if apply fails or is cancelled after the purge (see §5.6). The progress dialog still offers Cancel during that phase.
- The quota-style protections in place elsewhere in the app (e.g. AI usage caps) don't apply here; there's no limit on backup frequency or size beyond the ceilings in §8.
