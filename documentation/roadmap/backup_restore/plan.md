# Backup & Restore — Design and Implementation Plan

Status: **Implemented** (2026-09-15). See §13 for where the code landed and the small deviations from the plan.
Scope: full local backup to a single `.zip` file and restore from it, on **native builds only** (Windows + Android). Explicitly **not** available in the Nextcloud app build.

---

## 1. Goals and non-goals

**Goals**
- New **Backup** section in Settings (native only).
- **Backup to file** — one `.zip` containing every notebook, note, and binary (images, PDFs, recordings).
- **Restore from file** — read that `.zip` back into IndexedDB.
- **Optional password** on backup → the archive is encrypted.
- **Progress reporting** on both operations: waiting indicator + progress bar + `note n of m` text.
- **Conflict handling on restore** when a note or notebook already exists locally.
- **Backup freshness is visible** — the app records when it last backed up and says so, so a stale backup is not mistaken for protection (§5A).
- Archive creation/reading must not be bounded by JS heap or IPC payload limits.

**Non-goals (v1)**
- Backing up `settings` (credentials, `encryption_config`) — see §8.
- Scheduled / automatic backups — but freshness *is* tracked and surfaced (§5A.4), which is the path to them.
- Incremental or differential backups.
- Cross-device backup transfer (the user moves the file themselves).
- Availability in the Nextcloud build (`VITE_PLATFORM=nextcloud`) — that build has no local IndexedDB corpus to back up; it reads WebDAV directly via `storage.webdav.js`.

---

## 2. What already exists and gets reused

Nothing here is built from scratch. The existing pieces:

| Need | Existing asset |
|---|---|
| On-disk layout for notes/media | `src/modules/storagePaths.js` — the hierarchical NC sync layout |
| Sync-field stripping + JSON shape | `nextcloudSync.js` note upload path (`noteForUpload`, ~L1706-1714) |
| Media filename convention | `${fileId}${extFromMime(blob.type)}` — `nextcloudSync.js` ~L933 |
| Decrypt-before-export | `decryptNoteLocally(note)` — already used before every NC upload |
| Progress UI | `showProgressDialog()` — `src/components/modals.js` (has `update(current,total,text)`, `indeterminate()`, `setNote()`, `onCancel`) |
| Conflict UI (single) | `showConflictResolutionDialog(local, remote)` — `modals.js` |
| Password entry | `showPasswordPrompt(title, message)` — `modals.js` |
| Destructive-action confirm | `showConfirmDialog(...)` — `modals.js`, as used by the purge button |
| Settings section plumbing | Nav auto-builds from `.settings-section[data-section]` + its own `<h3>`; nothing to register |
| Native save dialog (desktop) | `save_pdf` Rust command in `src-tauri/src/lib.rs` — the **pattern**, not the command |
| Android file handoff | `PdfSavePlugin.kt` — FileProvider + intent, the pattern for the new SAF plugin |
| Platform gate | `IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud"` — `settingsMode.js:37` |
| Displacing a local note | `copyNote()` — `storage.js`, deep-copies blobs and **mints a new id** |
| Recycle bin | `getDeletedNotes()` / `restoreNote()`; the bin lists `note.title`, so a renamed copy is findable |
| Password set-up shape (confirm + strength + hint) | `showMasterPasswordSetup()` — `masterPasswordModals.js` (§4.2.1) |
| Password strength helpers | `calculatePasswordStrength` / `getPasswordStrengthLabel` / `getPasswordStrengthColor` — exported from `src/modules/encryption.js`, no UI coupling |
| Sync-in-flight check | `getIsSyncing()` — `src/modules/sync.js` (§7.2) |
| Corpus size for estimates | `getStorageStats()` — `storage.js`. **Currently displayed nowhere**; §7.1 is its first surface. |
| Pending-write flush before read | `NoteCanvas.destroy()` promise — `NoteCanvas/index.js` (§7.2) |
| Post-change UI refresh | `notes-updated` event, as the purge handler dispatches (§7.2) |

---

## 3. Where the zip is built — **Rust, streaming**

### 3.1 The real constraint is the IPC boundary, not the zip library

`save_pdf` passes bytes as `Array.from(bytes)` — every byte becomes a JSON number. That is roughly **4 bytes of JSON per byte of payload**, plus parse time on both sides. A 500 MB backup becomes a ~2 GB JSON string. That path is unusable for an archive of this size regardless of who does the zipping.

A JS zip library has the same problem from the other direction: the assembled archive must exist in the JS heap before it can cross to Rust at all.

### 3.2 Decision: Rust owns the archive; JS streams entries into it

```
JS                                      Rust
──                                      ────
backup_begin(path, password?)     ───▶  open ZipWriter on a real file handle
                                        (streaming to disk, never buffered whole)

for each entry (loop in JS):
  backup_add_entry(name, data)    ───▶  write one entry, drop the buffer
    ↑ one note JSON, or one media blob
  progress.update(i, total, …)

backup_finish()                   ───▶  finalize central directory → return path
```

Properties that make this the right split:

- **Peak memory is one entry**, not the archive. The worst single entry is one large PDF — a ceiling IndexedDB already imposes on a single blob anyway.
- **Peak IPC payload is one entry**, so the encoding overhead stays bounded.
- **Media blobs cross as base64** (~1.33x) rather than a JSON number array (~4x). The `base64` crate is already a dependency in `Cargo.toml`.
- **Note JSON crosses as a plain string** — no encoding needed.
- **Progress is naturally per-entry**, which is exactly the `n of m` the UI wants.
- JS keeps ownership of *what* goes in the archive; Rust only knows how to write an entry. The domain logic stays testable in JS.

Restore mirrors it: `restore_open(path, password?)` → manifest + entry list; `restore_read_entry(name)` → base64 bytes for one entry; `restore_close()`. **JS drives the read loop**, so every conflict decision happens in JS where the DB and the UI live.

### 3.3 Rust crate

Add `zip = "2"` with the `aes-crypto` feature. It provides both writer and reader, and WinZip **AES-256** for the optional password. AES-256, not legacy ZipCrypto — ZipCrypto is trivially broken and would make the password feature misleading.

### 3.4 Android file handoff — **option B (cache-then-copy)**

`rfd` is desktop-only in `Cargo.toml` (`cfg(not(target_os = "android"))`), and Android gives the app no filesystem path where it may freely write a user-visible file. Android needs the Storage Access Framework.

**Decided: option B.** Rust writes the archive to the app cache dir; a Kotlin plugin then copies cache → SAF URI at the end.

- Backup: Kotlin `ACTION_CREATE_DOCUMENT` → user picks destination → copy cache file into the returned URI → delete the cache file.
- Restore: Kotlin `ACTION_OPEN_DOCUMENT` → user picks the archive → copy URI content into the cache dir → Rust reads the cache path → delete the cache file when done.

Cost: one full-size temp file on device storage during the operation, and a copy pass. Benefit: the Rust side is **identical on every platform** (it always works with a plain filesystem path), and it reuses the FileProvider/intent shape already proven in `PdfSavePlugin.kt`.

Option A (Kotlin hands Rust a file descriptor, streaming end to end, no temp file) stays on the table as a later optimization if cache pressure proves to be a real problem on device. It does not change any JS-side code.

**Pre-flight check:** before starting an Android backup, estimate the archive size (sum of note JSON + blob sizes) and compare against available cache space. Fail early with a clear message rather than halfway through.

---

## 4. Archive format

```
noteberg-backup-2026-09-15T14-30.zip
├── manifest.json
├── notebooks/
│   └── {notebookId}/
│       ├── _notebook.json
│       └── notes/
│           ├── {noteId}.json
│           └── {noteId}_media/
│               └── {fileId}.{ext}
└── quickNotes/
    ├── {noteId}.json
    └── {noteId}_media/
        └── {fileId}.{ext}
```

**Deliberately identical to the Nextcloud sync layout.** This buys three things:

1. The path builders in `storagePaths.js` work unchanged — including `assertSafeId` / `assertSafeFilename`, which matter more here than in sync (see §9).
2. A backup is human-inspectable and recoverable by hand.
3. A `NoteBerg` folder pulled from Nextcloud can be zipped into a valid backup by adding a `manifest.json` (§4.1) at the root of the zip; the note and notebook files need no change.

No `_tombstones.json` — tombstones are sync bookkeeping, not user data, and restoring stale ones would resurrect deletions as sync instructions.

### 4.1 `manifest.json`

```jsonc
{
  "schema": 1,              // backup format version — bump on layout change
  "appVersion": "0.5.42",
  "dbVersion": 5,           // DB_VERSION from storage.js at backup time
  "createdAt": 1757944200000,
  "encrypted": false,       // whether the zip entries are password-protected
  "counts": { "notebooks": 12, "notes": 340, "files": 187 },
  "totalBytes": 524288000
}
```

`manifest.json` is written **unencrypted** even in a password-protected archive, so the restore UI can show what the file contains (and warn about version mismatches) *before* asking for the password. It contains no note content — only counts and versions.

**Version gating on restore:**
- `schema` newer than the app understands → refuse with a clear message.
- `dbVersion` newer than the running `DB_VERSION` → refuse. Writing shapes the app cannot read is worse than refusing.
- `dbVersion` older → accept; the note/notebook shapes are forward-compatible within the current schema line.

### 4.2 Notes are written **decrypted**

Call `decryptNoteLocally(note)` before serializing, exactly as the NC upload path does. If a backup stored locally-encrypted blobs, it would be unreadable after a master-password reset — which is precisely the situation where a backup is needed.

The zip password is the protection layer instead. The UI must say so plainly:

> Backups are stored unencrypted. Set a password to protect the file.

### 4.2.1 The backup password dialog — reuse the master-password setup shape

`showPasswordPrompt()` is a **single** password input (`modals.js`). It is the
right control for *entering* a known password (restore), and the **wrong** one
for *setting* a new one (backup).

A single un-confirmed field is a data-loss trap: one typo produces a permanently
unreadable archive, and the user finds out months later at the exact moment they
need it. There is no reset — that is what encryption means.

The app already has the correct pattern in `masterPasswordModals.js`
(`showMasterPasswordSetup`). The backup password dialog mirrors it:

| Element | Source |
|---|---|
| Password field | `autocomplete="new-password"` |
| **Confirm field** — non-negotiable | same shape as `setup-password-confirm` |
| Strength bar + label | `calculatePasswordStrength` / `getPasswordStrengthLabel` / `getPasswordStrengthColor` — all exported from **`src/modules/encryption.js`**, so there is no coupling to the master-password UI |
| Weak-password block | same threshold as setup (`strength < 30`) |
| **Password hint** field (optional) | mirrors `setup-password-hint`; stored in `manifest.json` (see below) |
| `warning-box` | the unrecoverable-password warning |

**Required warning copy** (i18n `backup.password.warning`) — the current plan
text sells only the upside. The risk must be stated:

> If you lose this password, the backup cannot be recovered. There is no reset
> and no recovery key.

**This password is independent of the master password.** State it explicitly
(`backup.password.independentNote`). A user who assumes "it's my master
password", is wrong, and discovers it a year later has an unopenable archive.
Using the same password is permitted — no special handling, no detection — but
the independence must not be left to inference.

**Password hint in the manifest.** Since `manifest.json` is written unencrypted
(§4.1), an optional user-supplied hint can live there and be displayed by the
restore dialog *before* the password prompt. This mirrors the master-password
hint the app already offers and is the only recovery affordance an encrypted
archive can have. The hint is user-authored free text — never derived from the
password, and never the password itself.

**Remember the choice, never the password.** A user who encrypts once almost
certainly wants it every time. Persist a boolean preference
(`backupEncryptByDefault`) that pre-checks the encrypt option on the next
backup. The password itself is **never** persisted — not in settings, not in the
keyring. Re-entered every time.

### 4.3 Deduplication

`pdf-page` media items all share one `fileId` (the source PDF binary). The entry writer must deduplicate by `fileId` per note — the same `seenIds` guard `syncNoteMedia` already uses — or a 500-page PDF note writes the same binary 500 times.

---

## 5. Restore conflicts

### 5.1 Why not a dialog per note

A 300-note backup would mean 300 modals. Equally, a blanket "overwrite everything" loses data silently. The model below decides the *policy* once, surfaces only *genuine* conflicts for review, and is **non-destructive by construction**.

### 5.2 Tier 1 — restore mode, named by intent, defaulted by the scan

Modes are labelled by **what the user is trying to achieve**, not by the merge
mechanism. A user restoring a backup does not think in terms of "merge
strategies"; they think "get my stuff back".

| Mode | i18n key | Behavior |
|---|---|---|
| **Restore missing items only** | `backup.restore.modeMissing` | Existing items are left alone; only items absent locally are added. Zero prompts. |
| **Restore from backup, keep replaced notes in recycle bin** *(default when conflicts exist)* | `backup.restore.modePreferBackup` | Backup wins where `backup.modified > local.modified`; local wins otherwise. Displaced locals go to the recycle bin per §5.4. |
| **Replace everything** | `backup.restore.modeReplaceAll` | `purgeLocalData()` first, then restore the archive verbatim. Behind a `showConfirmDialog` with `btn-danger`, matching the existing purge button. Refused while NC is connected (§5.6). |

**Why prefer-backup is the default and not "missing only".**

The conservative default is the wrong one here, because of *why* people restore:

| Real scenario | "Missing only" does | User expected |
|---|---|---|
| New device, empty app | Correct | Correct |
| "I ruined this note — get the backup version" | **Nothing.** The note exists, so it is skipped. | Backup version returns |
| Bad sync / corrupted state, want the good backup | **Nothing** for every existing note | Backup state restored |

In two of three cases "missing only" reports *"restore complete"* and changes
nothing. The user concludes the feature is broken, or that their backup is
empty. That is a worse outcome than any data risk it avoids.

**And the risk it avoids no longer exists.** Tier 3 (§5.4) means prefer-backup
never destroys anything — the displaced local version is kept, renamed, and
recoverable from the recycle bin in one click. A timid default is guarding
against a danger the design already removed.

### 5.2.1 Progressive disclosure — the scan decides how much UI appears

The number of decisions the user faces must scale with the number of actual
conflicts. For the single most common case — new device, empty app, restore
everything — the correct number of decisions after picking the file is **zero**.

| Scan result | Flow |
|---|---|
| **Empty corpus** (no local notes/notebooks) | Pick file → one confirm (*"Restore 340 notes into this device?"*) → progress → done. **No mode selection, no conflict step.** |
| **Existing data, no id collisions** | Same as above, plus one line: *"Nothing existing will be replaced."* |
| **Existing data with genuine conflicts** | Pick file → mode selection + conflict summary → optional Tier 2 review → progress → done. |

A scan that finds no conflicts must produce no conflict UI. Mode selection is
rendered **only** in the third row — offering a three-way merge-policy choice to
someone restoring onto a blank device is noise that implies a risk that is not
present.

### 5.3 Tier 2 — conflict review, after a dry-run scan, before any write

Restore always runs a **dry-run scan first**: read the manifest and every `*.json` entry's metadata, compare against local by id, and produce a summary without writing anything.

> 12 notes already exist locally. 3 are newer locally, 9 are older. — **[Review 3]**

An item lands in the review list only when it **genuinely differs**: both `modified` and `version` disagree between archive and local. Same-`version` items are the same note and need no decision.

"Review" opens a compact list with a per-item keep-local / keep-backup toggle, plus select-all-local / select-all-backup. `showConflictResolutionDialog` already handles the single-item shape; this is a list variant of it.

### 5.4 Tier 3 — never overwrite in place; **displace and rename**

Whenever the user's choice means the backup's version of a note wins, the local note is **not** destroyed. Instead:

1. `copyNote(localNoteId, localNotebookId)` — deep-copies the blobs and **mints a new id**, so the original id is freed for the backup's note to reclaim.
2. Rename the copy: `title` becomes `<original title> (replaced)`, via i18n key `backup.restore.replacedSuffix`.
3. Mark the copy `deleted: true` so it lands in the **recycle bin** rather than cluttering the notebook.
4. Write the backup's note at the original id.

The recycle bin already lists `note.title` (`recycleBinMode.js`), so `My Meeting Notes (replaced)` is immediately identifiable and one click from restoration. The user gets a reversible operation with a visible audit trail, and the normal recycle-bin purge flow eventually reclaims the space.

The suffix is appended to the **copy**, never to the restored note — the restored note must keep the title the user expects to see.

#### 5.4.1 The suffix must be idempotent

Restore is a repeatable operation (§7.5 relies on that). Naively appending would
turn a note restored three times into `Notes (replaced) (replaced) (replaced)`.

Rule: **if the title already ends in the suffix, do not append a second one.**
Titles are not length-capped anywhere (no `maxlength` on the title inputs) and are
CSS-ellipsised in cards and lists, so an unbounded chain is never rejected — it
just silently becomes unreadable and identical-looking in the recycle bin, which
is the opposite of the audit trail the suffix exists to provide.

If disambiguating repeated displacements is wanted, use a counter
(`Notes (replaced 2)`) rather than repetition — but the `deletedAt` timestamp the
recycle bin already sorts by is probably sufficient, so the simple
do-not-double rule is the v1 behavior.

The suffix is a **translated** string (`backup.restore.replacedSuffix`), so the
idempotency check must compare against the current locale's suffix. A user who
switches language between restores can legitimately end up with one of each; that
is acceptable and not worth carrying a locale-independent marker field for.

#### 5.4.2 Make displaced notes legible in the recycle bin

A restore that displaces 50 notes puts 50 new entries in the recycle bin, all
stamped today, interleaved with genuinely user-deleted notes. The user cannot
tell *"things I deleted"* from *"things the restore moved aside"* — and that
distinction is the whole point of Tier 3 being an audit trail.

v1 requirement: **the completion summary names the count and offers a button
that navigates to the recycle bin** (§7.3). That covers the immediate need — the
user is told what happened and taken to where it is, at the moment it matters.

Deferred, not rejected: a visual marker in `recycleBinMode.js` distinguishing
displaced notes from deleted ones. It needs a field to key off (a
`displacedByRestoreAt` timestamp on the copy would do it) and a decision about
whether the bin gains a filter. Worth doing if displacement turns out to be
common; not worth blocking v1.

### 5.5 Notebooks

Conflict only on id collision.

- **Id absent locally** → create the notebook from the archive.
- **Id exists locally, title differs** → **keep the local notebook**, restore its notes into it. A notebook is a container, not content; renaming a user's notebook out from under them is a worse outcome than a title mismatch. Log it and include it in the completion summary.
- **Id exists locally and was deleted** (`deleted: true`) → restore it (`deleted: false`), since the archive asserts it should exist.

No displacement/rename for notebooks. The Tier 3 machinery applies to notes only.

### 5.6 The sync interaction — the sharpest edge

**Every restored note and notebook must be written as:**

```js
{
  ...itemFromBackup,
  synced: false,
  lastSyncedEtag: null,
  version: (local?.version ?? 0) + 1,
  modified: Date.now(),
}
```

Bumping `version` past the local value and clearing `lastSyncedEtag` is what makes the restored state **win the next Nextcloud sync**. Without it, the server copy is "newer" by the sync engine's own comparison and the restore is silently reverted on the next cycle.

> A restore that does not correctly re-dirty every item is worse than having no restore feature at all, because it appears to succeed.

**Re-dirtying alone is not enough for notes that still exist on the server.**
The sync engine never compares `version`; it compares etags, and a restored
note (`lastSyncedEtag: null`) against any server copy classifies as "modified
on both sides" and goes through `attemptMerge`. That merge is a stroke union
that also applies the server's `deletedStrokes`, so it would put back exactly
the edits the user restored the backup to get rid of. Restored notes therefore
also carry a transient index field, **`restoredAt`**, which the classifier
treats as "local wins": the note is uploaded as-is with the remote etag as the
If-Match base, and `updateNoteEtag` clears the marker once the upload lands.
The marker never leaves the device (stripped from uploads and from archives).
The post-restore sync runs with `preferNewer`, so anything the merge path
cannot settle resolves by timestamp, which the restore has just set.

Guardrails:
- **Block restore while a sync is in flight.** Check **`getIsSyncing()`** (`src/modules/sync.js`) and refuse with a clear message. Sampling it once is not enough — see §7.2, which requires autoSync to be *suspended* for the whole operation because `autoSync.js` can start a sync mid-restore from its own event listeners.
- **Force a full sync after restore** completes, so the restored state reaches the server before anything else touches it.
- **"Replace all" refuses to run while Nextcloud is connected.** Purging everything locally and re-uploading is indistinguishable from a mass deletion from the server's point of view. Require an explicit disconnect first.

  **The message must answer the question the user actually has.** *"Disconnect
  Nextcloud first"* prompts *"why?"* and, far more urgently, *"will I lose my
  cloud notes if I do?"* — a user who fears yes will abandon the restore, and a
  user who assumes no may be wrong about something else. State the reason, state
  what disconnecting does **not** do, and offer the action inline rather than
  sending the user to hunt for it in another settings section:

  > Replacing everything would look like a mass deletion to Nextcloud and could
  > delete your notes on the server. Disconnect first — your notes stay on the
  > server, and you can reconnect after the restore.
  > **[Disconnect and continue]  [Cancel]**

  The inline button is the difference between a dead end and a flow. Copy lives
  under `backup.restore.replaceAllNcBlocked`.

Merge modes remain available while connected — they only ever move `version` forward, which is a normal edit from the sync engine's perspective.

### 5.7 Media and blob restoration

For each restored note, its `{noteId}_media/` entries are written to the `files` store keyed by the `fileId` parsed from the entry filename. Because `fileId`s are UUIDs, collision with an unrelated local blob is not a practical concern; when the key already exists the blob is byte-identical and the write is a harmless no-op.

Blobs orphaned by a displaced note are **not** cleaned up during restore — the displaced copy in the recycle bin holds its own deep copies (`copyNote` deep-copies), and the normal purge path reclaims them.

---

## 5A. Backup freshness — the app must know when it last backed up

As originally planned the feature was entirely **manual and stateless**: nothing
recorded that a backup ever happened. That makes it a feature that exists rather
than a feature that protects anyone.

The failure it permits: the user backs up once in March, feels safe, loses the
tablet in September. Eleven notebooks are gone and the app never hinted that the
backup was six months stale. There is also no way to answer *"did I back up
recently?"* without hunting for the file in a file manager and reading its
timestamp.

### 5A.1 State to persist (after every successful backup)

Written to the `settings` store — local-only bookkeeping, never synced, never
included in a backup archive (§8):

```jsonc
{
  "lastBackupAt": 1757944200000,   // completion timestamp
  "lastBackupNoteCount": 340,      // corpus size at that moment
  "lastBackupBytes": 524288000,    // archive size, for the size estimate (§7.1)
  "lastBackupEncrypted": true      // drives the `backupEncryptByDefault` pre-check
}
```

Only written on **success**. A cancelled or failed backup must not move the
timestamp — that would be the feature lying about the thing it exists to
guarantee. A partial restore likewise never touches these.

Deliberately **not** stored: the file path. It goes stale immediately (removable
media, moved files, Android SAF URIs that do not survive), and a stale path
displayed as fact is worse than no path. The completion dialog shows the path
once, at the moment it is true.

### 5A.2 Surfacing it in the Backup section

The section header states the current state before any button:

| State | Display |
|---|---|
| Never | **Never backed up** (warning colour) |
| Recent | **Last backup: 3 days ago (340 notes)** |
| Stale | **Last backup: 7 months ago (120 notes)** + staleness nudge |

Relative dates ("3 days ago"), with the absolute timestamp as a `title`
attribute — a user judging freshness thinks in elapsed time, not calendar dates.

### 5A.3 The staleness nudge

Shown when **both** conditions hold — either alone produces false alarms:

1. `lastBackupAt` is older than **30 days** (or is absent entirely), **and**
2. the corpus has grown meaningfully since — say `noteCount > lastBackupNoteCount * 1.1` or `+10` notes, whichever is smaller.

Condition 2 matters: a user who has not touched the app in six months does not
need to be told to re-back-up an unchanged corpus.

**Placement: in the Backup section, and at most one passive indicator elsewhere.
Never a modal.** Nagging popups get dismissed reflexively and train the user to
dismiss the dialog that eventually matters. If a second surface is wanted later,
the footer (`footer.js`) already carries passive sync status and is the natural
home — but that is not v1.

### 5A.4 Scheduled backups stay out of scope — but this is the path to them

Automatic backups remain a non-goal (§1). The point of 5A is that **surfacing
staleness now** delivers most of the protective value at a fraction of the cost,
and the persisted state above is exactly what a scheduler would later read. The
intended progression is: surface staleness (v1) → offer a reminder cadence →
automate. Recorded here so the next step is not re-derived from scratch.

---

## 6. Module layout

| File | Responsibility |
|---|---|
| `src/modules/backup.js` | Walk storage → ordered entry stream. Pure logic, no UI, no Tauri. Emits `{name, data}` + progress callbacks. |
| `src/modules/restore.js` | Entry stream → dry-run scan → conflict plan → apply. Pure logic, no UI, no Tauri. |
| `src/modules/backupArchive.js` | Thin Tauri-invoke wrapper (`backup_begin/add/finish`, `restore_open/read/close`) + platform file-picker dispatch. In-memory fallback implementation for tests. |
| `src/components/settingsMode.js` | New `data-section="backup"` div, gated on `!IS_NEXTCLOUD`. Wires two buttons to progress dialogs. |
| `src/components/modals.js` | Add the conflict **list** variant beside the existing single-item dialog, plus the backup-password dialog (§4.2.1 — confirm + strength + hint + warning). |
| `src/modules/autoSync.js` | **New:** `suspendAutoSync()` / `resumeAutoSync()`. Does not exist today; required by §7.2 so a restore cannot be raced by an event-triggered sync. |
| `src-tauri/src/backup.rs` | `zip` crate; streaming writer/reader; AES-256 when a password is given. |
| `src-tauri/gen/android/.../BackupFilePlugin.kt` | SAF `ACTION_CREATE_DOCUMENT` / `ACTION_OPEN_DOCUMENT` + cache↔URI copy. |
| `src/i18n/locales/*.json` | New `settings.sections.backup` + `backup.*` keys. |

`backup.js` and `restore.js` being UI-free and Tauri-free is what makes them testable. `backupArchive.js` is the only file that knows Tauri exists.

---

## 7. Settings UI

New section, placed before `dangerZone`, rendered only when `!IS_NEXTCLOUD`:

```html
<div class="settings-section" data-section="backup">
  <h3>{{ settings.sections.backup }}</h3>

  <!-- Freshness line (§5A.2): "Last backup: 3 days ago (340 notes)" / "Never backed up" -->
  <!-- Staleness nudge, conditional (§5A.3) -->
  <!-- Size estimate (§7.1): "About 340 notes, ~180 MB" -->

  <!-- Backup to file: description, encrypt checkbox, button, status note -->
  <!-- Restore from file: description, button, status note -->
  <!-- Full-width note: backups are unencrypted unless a password is set -->
</div>
```

The nav entry appears automatically — `initSettingsNav()` reads
`.settings-section[data-section]` and labels from the section's own `<h3>`.
Nothing to register.

Status notes follow the established destructive-action pattern from the purge
button (`settingsMode.js`): disable the button, set live status text, restore on
completion, and finish with a `showAlertDialog`.

### 7.1 Show the size before the button, not after

As originally planned the user clicked **Backup to file** and got a file picker
with no indication whether this was 2 MB or 2 GB, or whether it would take two
seconds or four minutes.

The section shows an estimate **before** the button:

> About 340 notes, ~180 MB

Computed from `getStorageStats()` (`storage.js`) plus a sum of blob sizes from
the `files` store. Note that **`getStorageStats()` is currently displayed nowhere
in the app** — it exists and is unused, so this is its first surface.

Two further uses for the same number:

- On **Android it doubles as the pre-flight check** §3.4 already requires — compare the estimate against available cache space and fail early with a clear message rather than halfway through.
- It sets the expectation that makes a long-running progress dialog legible instead of alarming.

Cheap approximation is fine (byte sums, not compressed size); label it as
approximate. `lastBackupBytes` from §5A.1 is a good sanity check against drift.

### 7.2 Pre-flight state — what must be true before either operation runs

Neither operation may start from an arbitrary app state. This was unaddressed and
is a correctness issue, not only a UX one.

**Both backup and restore require:**

1. **No note open.** Navigate to overview first. An open `NoteCanvas` has pending
   writes; `destroy()` returns a promise that resolves when the thumbnail save
   and recognition complete (`NoteCanvas/index.js`), and that promise must be
   awaited before reading or writing the corpus. Backing up mid-stroke would
   otherwise capture a note the user can see but the DB has not received.
2. **No sync in flight.** Check **`getIsSyncing()`** — exported from
   `src/modules/sync.js`. Refuse with a clear message rather than racing it.

**Restore additionally requires:**

3. **AutoSync suppressed for the whole operation.** Sampling `getIsSyncing()`
   once at the start is **not sufficient**: `autoSync.js` is event-driven and
   fires on navigate, note-created and notebook-created (`initAutoSync`), so a
   sync can begin *during* a long restore and race the writes. There is no
   suppression flag today — **one must be added** (a module-scope
   `suspendAutoSync()` / `resumeAutoSync()` pair in `autoSync.js`, released in a
   `finally`).
4. **`notes-updated` dispatched on completion.** The purge handler already does
   this (`settingsMode.js`) and restore must match, or the overview shows a stale
   corpus. Restore rewrites `noteContent` wholesale, and local writes bypass
   canvas reload — which is precisely why requirement 1 is not optional.

### 7.3 Flows

**Backup:** freshness + estimate shown → encrypt checkbox (pre-checked per
`backupEncryptByDefault`) → password dialog per §4.2.1 if encrypting → pre-flight
(§7.2) → file picker → `showProgressDialog` with `onCancel` → progress per §7.4 →
persist §5A.1 state → completion dialog with path and final size.

**Restore:** file picker → manifest read + version gate → **hint displayed if
present** (§4.2.1) → password prompt if encrypted → dry-run scan → **flow branches
per §5.2.1** (empty corpus asks nothing; conflicts get mode + summary + optional
Tier 2 review) → pre-flight (§7.2) → `showProgressDialog` → completion summary
(`x restored, y skipped, z replaced`) → **button to the recycle bin** when
anything was displaced → full sync if connected.

### 7.4 Progress must not appear stalled

`n of m` counts **entries**, and one entry can be a 200-page PDF that takes 30
seconds while the counter sits still — indistinguishable from a hang.

Either weight the bar by **bytes** rather than entry count, or keep the `n of m`
count and add a second line naming the current entry:

> Note 41 of 340 — writing media: large-document.pdf

Naming the file gives a stalled counter a visible reason. `showProgressDialog`
already supports this: `update()` for the count and `setNote()` for the detail
line. Use `indeterminate()` for the phases with no meaningful count — archive
finalization, the dry-run scan, and the Android cache-to-SAF copy.

### 7.5 Cancellation

Both dialogs pass `onCancel`.

- **Backup cancel** aborts the writer, deletes the partial file, and leaves
  §5A.1 state untouched. A partial archive must never be left behind looking
  like a valid backup.
- **Restore cancel** stops the apply loop. Already-written items stay — they are
  valid, correctly re-dirtied notes. But the user is left in a state they cannot
  reason about, so the summary must be explicit and actionable:

  > Restore cancelled. 120 of 340 notes were restored. Run the restore again to
  > finish — already-restored notes will be skipped.

  Restore **is** idempotent (ids are stable, version bumps are monotonic), so
  re-running is safe. Say so rather than leaving the user to guess.

### 7.6 Error copy inventory

These are the messages users actually see most, and only wrong-password was
covered. Each needs its own i18n key and a stated next action:

| Condition | Message intent |
|---|---|
| File picker cancelled | Silent. No dialog, no status change — not an error. |
| Not a NoteBerg backup (no readable `manifest.json`) | Name the file, say what was expected. |
| Corrupt or truncated archive | Distinguish from the above — the file *is* a backup but unreadable. Suggest another copy. |
| Wrong password | **"Incorrect password"**, distinguishable from a parse failure. Show the hint if the manifest has one. Re-prompt rather than aborting the flow. |
| `schema` / `dbVersion` newer than app (§4.1) | Name the required app version. This is an upgrade prompt, not a failure. |
| Disk full mid-write | Report bytes written vs. needed; state that the partial file was deleted. |
| Insufficient Android cache space (§7.1) | Caught pre-flight, before any work. State needed vs. available. |
| Restore blocked by open note / active sync (§7.2) | Say which, and what to do — close the note, or wait for sync. |

---

## 8. `settings.json` is excluded from v1

The `settings` store holds `encryption_config` and Nextcloud credential material. `purgeLocalData()` deliberately leaves `settings` untouched for exactly that reason.

Putting it in a backup means a plaintext-by-default file containing credentials, which is a materially different security proposition from a file containing notes. **Excluded from v1.** If it is wanted later it ships as a separate, explicitly-labeled opt-in checkbox with its own warning, and credentials are stripped even then.

Display preferences and pen presets are worth revisiting separately — they are not sensitive — but they are also not what "backup" means to a user in v1.

---

## 9. Security notes

- **Entry names from an archive are untrusted.** A crafted zip with an entry named `../../../../etc/passwd` or a note id of `../../Photos` must not steer a write outside the intended stores. Route every parsed id and filename through the existing `assertSafeId` / `assertSafeFilename` in `storagePaths.js`, and reject the archive on the first violation rather than skipping the entry.
- **Zip-bomb guard.** Compare each entry's declared uncompressed size against the manifest's `totalBytes` and a hard per-entry ceiling before allocating. Refuse implausible ratios.
- **Wrong password must fail cleanly** — a distinguishable error surfaced as "Incorrect password", not a generic parse failure.
- **Never log note titles or content** from the backup/restore paths. The existing sync code logs ids and paths only; match it.
- **Delete the Android cache temp file** in a `finally`, including on cancel and on error.

---

## 10. Build order

Each phase is independently testable and lands without breaking anything before it.

### Phase 0 — Baseline
Run `just fct` and record a green baseline. No source changes.

### Phase 1 — Format + `backup.js`
Entry-stream generation against an **in-memory mock archive**. Tests define the layout: correct paths, media dedup by `fileId`, notes decrypted, no tombstones, manifest accurate.
**Exit:** a backup can be produced as an in-memory entry list and asserted against, with no Tauri and no zip.

### Phase 2 — `restore.js` scan + conflict planner
Dry-run scan and the conflict plan. **This is where the real design risk lives**, so it is tested before any I/O exists. Tests assert the requirements: merge never loses a local note; every applied item has `synced:false` and a bumped `version`; displacement produces a renamed, `deleted:true` copy with a new id; the original id is reclaimed; version gating refuses a newer `dbVersion`.
**Exit:** planner is green against fixtures; nothing writes to a real DB yet.

### Phase 3 — `backup.rs` + desktop wiring
`zip` crate, streaming writer/reader, `rfd` save/open dialogs on Windows. `backupArchive.js` real implementation.
**Exit:** end-to-end backup and restore on Windows with a real archive.

### Phase 4 — Settings UI + progress + pre-flight
The section, both flows, progress dialogs (§7.4 byte-weighted or entry-named),
conflict review list, completion summaries, i18n keys **including the full error
inventory (§7.6)**.

Also in this phase, because the feature is not safe to ship without them:
- **Pre-flight state (§7.2)** — no note open, `getIsSyncing()` check, the new
  `suspendAutoSync()` / `resumeAutoSync()` pair, `notes-updated` on completion.
- **Freshness state (§5A)** — persist `lastBackupAt` and friends on success only;
  render the freshness line and the staleness nudge.
- **Size estimate (§7.1)** — first surface for `getStorageStats()`.
- **Progressive disclosure (§5.2.1)** — the empty-corpus path must ask nothing.
- **Suffix idempotency (§5.4.1)** and the recycle-bin navigation button (§5.4.2).
- **The blocked-by-NC dialog (§5.6)** with its inline disconnect action.

**Exit:** feature is usable on Windows; an empty-device restore asks zero
questions after the file picker; a cancelled restore reports a resumable state.

### Phase 5 — Password / AES-256
Backup password dialog per **§4.2.1** (confirm field, strength meter, hint,
unrecoverable-password warning, `backupEncryptByDefault` preference), password
gate on restore with the hint shown from the unencrypted manifest, clean
wrong-password error that re-prompts.
**Exit:** encrypted round-trip verified; wrong password fails distinguishably and
recoverably; a mistyped confirm field cannot produce an archive.

### Phase 6 — Android
`BackupFilePlugin.kt` (SAF create/open + cache copy), the cache-space pre-flight check, temp-file cleanup, Tauri capability entries.
**Exit:** end-to-end on device. Left last because it is the highest-friction phase and everything it depends on is proven by then.

### Phase 7 — Multi-platform verification
Windows, Android, and a Nextcloud build confirming the Backup section is **absent**. Per project convention, every change is verified across all three targets.

---

## 11. Decisions on the record

| Question | Decision |
|---|---|
| Who builds the zip? | **Rust**, streaming, one entry per IPC call. JS never holds the archive. |
| Android file handoff | **Option B** — Rust writes to app cache, Kotlin copies cache ↔ SAF URI. Option A (FD streaming) is a later optimization; it changes no JS. |
| Restore destructiveness | **Non-destructive by construction.** Displaced local notes become renamed `(replaced)` copies in the recycle bin, never overwritten in place. |
| `settings.json` in the archive | **Excluded from v1.** Holds credentials and `encryption_config`. |
| Archive layout | **Identical to the NC sync layout**, so `storagePaths.js` is reused verbatim. |
| Note encryption in the archive | **Decrypted**, as NC upload does. The zip password is the protection layer. |
| Encryption algorithm | **WinZip AES-256**, never legacy ZipCrypto. |
| Nextcloud build | **Feature absent.** No local corpus to back up. |
| "Replace all" while NC connected | **Refused.** Requires an explicit disconnect. |
| Default restore mode | **Prefer-backup when conflicts exist** (§5.2). "Missing only" silently does nothing in the two most common restore scenarios, and Tier 3 already removes the risk that would justify a timid default. |
| Mode selection on an empty device | **Not shown.** The scan drives disclosure; zero decisions after the file picker (§5.2.1). |
| Backup password entry | **Confirm field + strength meter + hint**, mirroring `showMasterPasswordSetup` (§4.2.1). A single un-confirmed field is a data-loss trap. |
| Password persistence | **Never.** Only the boolean `backupEncryptByDefault` preference is remembered. |
| Backup freshness | **Tracked and surfaced** (§5A). Timestamp written on success only; staleness nudge in-section, never a modal. |
| Scheduled backups | Still out of scope, but §5A.1 state is deliberately what a future scheduler would read. |
| AutoSync during restore | **Suspended for the duration** via a new `suspendAutoSync()` / `resumeAutoSync()` pair — a one-time `getIsSyncing()` check is insufficient (§7.2). |
| `(replaced)` suffix on repeat | **Do not double.** If the title already ends in the suffix, leave it (§5.4.1). Titles have no length cap and are CSS-ellipsised, so a chain fails silently rather than loudly. |
| Displaced notes in the recycle bin | **Completion summary + navigation button** in v1 (§5.4.2). A visual marker in the bin is deferred, not rejected. |
| "Replace all" blocked-by-NC copy | **States the reason, states what disconnecting does not do, and offers [Disconnect and continue] inline** (§5.6). A bare "disconnect first" is a dead end. |

---

## 12. Open items for implementation time

- Exact wording for the mode labels, the staleness nudge, and the error inventory (§7.6). The keys are named; the copy is not written.
- Whether the Tier 2 review list needs content previews (as `showConflictResolutionDialog` renders) or whether title + timestamp + stroke count is sufficient at list scale. Lean toward the lighter version; previews mean decrypting and rendering N notes during a scan.
- Whether backup should offer a notebook-subset selection, or always full-corpus. v1 assumes full-corpus.
- Cache-space threshold for the Android pre-flight check (a fixed headroom multiple vs. a percentage).
- Staleness thresholds in §5A.3 (30 days, +10%/+10 notes) are a starting guess, not a measured choice.
- Whether §7.4 progress is byte-weighted or entry-count-plus-detail-line. Byte-weighted is more honest; the detail line is less work and may be enough.
- Whether the recycle bin gains a **visual marker** for restore-displaced notes (§5.4.2). The v1 requirement — completion summary + recycle-bin button — is specified; the marker itself is deferred and needs a `displacedByRestoreAt`-style field plus a decision on whether the bin gains a filter.
- Whether repeated displacement should use a **counter** (`Notes (replaced 2)`) rather than the v1 do-not-double rule (§5.4.1). The recycle bin's existing `deletedAt` sort probably makes it unnecessary.

---

## 13. Implementation notes

Where the code landed (module folder chosen to keep `src/modules/` flat):

| Responsibility | File |
|---|---|
| Entry stream, manifest, freshness state, size estimate | `src/modules/backup_restore/backup.js` |
| Index → scan → plan → apply, entry-name validation, zip-bomb guard | `src/modules/backup_restore/restore.js` |
| Tauri invoke wrapper + in-memory archive for tests | `src/modules/backup_restore/backupArchive.js` |
| Settings section markup and both flows | `src/components/backupSection.js` (lazy-loaded from `settingsMode.js`, native only) |
| Password setup, restore password prompt, mode + review, blocked-by-NC, completion | `src/components/backupModals.js` |
| `suspendAutoSync()` / `resumeAutoSync()` | `src/modules/autoSync.js` |
| Streaming zip writer/reader, AES-256, per-entry IPC commands | `src-tauri/src/backup.rs` |
| SAF create/open + cache ↔ URI copy, free space | `src-tauri/gen/android/.../BackupFilePlugin.kt` |

Decisions made at implementation time (the open items in §12):

- **Progress** is entry-count plus a detail line naming the media file (§7.4, the lighter option).
- **Review list** shows title + local/backup timestamps, no content previews (§12).
- **Manifest is written last**, so its counts and `totalBytes` are exact; readers locate it by name, so position is irrelevant.
- **Decryption** uses `getNote()` (storage's own decrypt path) rather than exporting `decryptNoteLocally` from the sync module; same result, no coupling to sync.
- **`zip` crate 8.6** (current stable) with `aes-crypto` + `deflate-flate2-zlib-rs` (pure Rust; the plain `deflate-flate2` feature leaves flate2 without a backend on Android), not the 2.x named in §3.3.
- **Soft-deleted items** are included with their `deleted` flag so the recycle bin survives; purged stubs and tombstones are not.
- **Android free-space pre-flight**: estimate × 1.2, minimum 20 MB headroom.
- **Re-running after a cancel**: restored notes carry `modified = restore time`, so they scan as "newer locally" and the default keeps them; nothing is written twice.
- **Entry names** containing `..`, a backslash, a leading `/` or NUL reject the whole archive even where the layout would otherwise ignore the entry.
- **Media entries are stored, not deflated.** PDFs, images and audio are already compressed; deflating a 300 MiB PDF measured ~20 s for no gain, and made a large encrypted entry look like a hang. Stored: 0.8 s, 2.4 s with AES-256. JSON entries stay deflated.
- **Binary entries cross the IPC boundary in 8 MiB chunks** (`backup_begin_entry` / `backup_write_chunk`, `restore_read_begin` / `restore_read_chunk` / `restore_read_end`), so cancel is honoured between chunks of one file and the detail line shows a per-file percentage. This refines §3.2's "one entry per call": one *chunk* per call.
- **No password hint.** §4.2.1's hint field was dropped after implementation: a hint that actually helps is a hint that leaks, and it would sit unencrypted in the archive beside the data it protects. The restore prompt simply re-asks on a wrong password.
- **Encryption is zip's own WinZip AES-256, per entry** — that is the only kind of password a zip file has (there is no whole-archive mode); the plain manifest is simply one entry written without it.
- **Restored notes carry `restoredAt`** (see the addition to §5.6): without it the sync engine merges the server copy back into the restored note. It lives on the note index, is stripped from uploads and archives, and is cleared by `updateNoteEtag` when the upload lands. The post-restore sync passes `preferNewer`.
- **Archive JSON is stripped on the way in** (`stripArchiveFields`): the same sync-only set backup removes, plus `purged`. A hand-made archive cannot write a purged stub or a pending move.
- **JSON entries have their own ceiling**: 64 MiB (`MAX_JSON_ENTRY_BYTES` / `MAX_TEXT_ENTRY_BYTES`), because they are read whole and cross the IPC boundary as one string. Media keeps the 1 GiB ceiling.
- **Size estimate**: file records store `size`, the blob store is walked with a cursor rather than `getAll`, and the walk is cached until `datachange` or `notes-updated`.
- **Android restore pre-flight**: the picked document's reported size is checked against cache space (same 1.2x / 20 MB rule as backup) before it is copied; both copies run on a worker thread. The completion dialog shows the picker's display name rather than the content URI.
- **Backup password floor is 50**, above the master password's 30, because WinZip AES fixes the KDF at PBKDF2-SHA1 with 1000 iterations and the archive can be attacked offline. A hint that contains the password is refused.
