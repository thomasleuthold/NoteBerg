# Notebook Sharing — Design

Status: **Implemented**, covered by automated tests against mock Nextcloud instances. Validation against real Nextcloud servers and real devices is still to be done by hand; see §10.6 and §12.
Scope: sharing a **whole notebook** with another Nextcloud user, read-only or can-edit (collab), on **both** build targets (native Tauri — Windows/Android — and the in-Nextcloud app build).

---

## 1. Goals and non-goals

**Goals**
- Share one notebook (folder) with another NC user.
- Two share modes: **read-only** and **can-edit** (collab).
- Recipient sees shared notebooks in a dedicated **"Shared with me"** section, clearly separated from their own notebooks.
- Works on both platforms:
  - **NC app build** (`VITE_PLATFORM=nextcloud`): same-origin, `window.OC.requestToken` + session cookie.
  - **Native (Tauri)**: stored app-password credentials, Basic auth + `OCS-APIRequest` header against the configured base URL, via `@tauri-apps/plugin-http` (no CORS; the capability URL scopes already allow `https://**`).
- No random `{uuid}` folders left dangling in the recipient's file tree (§7).

**Non-goals (v1)**
- Sharing individual notes or quick notes (a note is not a self-contained folder in our layout).
- Public link shares, group shares, federated shares. Only user shares (`shareType=0`) are created and registered.
- Re-sharing: a recipient can never share a received notebook further (§3).
- Encryption-aware collaboration / key exchange — **not needed**: the sync wire format is always plaintext. `note.encrypted` refers only to a client's *local at-rest* encryption; notes are decrypted before upload (`decryptNoteLocally` / `decryptNoteFields` in `nextcloudSync.js`). A recipient always reads plaintext JSON.
- Real-time collaboration (§10).

---

## 2. Why folder-share is the only viable mechanism

Everything for one user lives under a single root `ROOT_FOLDER = "/NoteBerg"` (`storagePaths.js`). You **cannot** share `/NoteBerg` — the recipient would get *all* your notebooks.

Therefore the **unit of sharing is a single notebook folder**: `/NoteBerg/notebooks/{notebookId}/` (contains `_notebook.json`, `_tombstones.json`, `notes/`). Everything a notebook needs, including its note tombstones, is inside that folder; only the global notebook tombstone (`/NoteBerg/notebooks/_tombstones.json`) is outside, and it stays owner-only.

Cross-account write access requires filesystem permissions, which **only Nextcloud's native folder share** grants. **Decision: Nextcloud native user folder-share, no custom registry file.** OCS `shared_with_me` provides discovery.

---

## 3. Share modes and permission bits

NC permission bits: `READ=1`, `UPDATE=2`, `CREATE=4`, `DELETE=8`, `SHARE=16`.

| Mode | Requested `permissions` | Recipient sync | Recipient UI |
|---|---|---|---|
| Read-only | `1` (READ) | download-only | all edit affordances hidden |
| Can-edit (collab) | `7` (READ + UPDATE + CREATE) | bidirectional, never deletes | edit, add notes/media, rename/recolor notebook |

- **No `DELETE` bit:** recipients never delete notes or notebooks (§4), so the server enforces it too.
- **No `SHARE` bit:** re-sharing is not allowed; NC rejects a re-share attempt, and the UI never offers it.
- `CREATE` is required for new notes, media folders (`MKCOL`) and chunked uploads (`MOVE` of the assembled `.file` into the share). `UPDATE` is required to overwrite existing files.

**Gate on granted, not requested, permissions.** Admin policy can reduce what is granted. The client reads back `permissions` from OCS on every discovery pass and stores it as `sharePermissions`. All gating is a pure function of that value (`canEdit = (p & UPDATE) && (p & CREATE)`), the same approach as Nextcloud Notes (`readonly = !file.isUpdateable()`). A share granted `UPDATE` without `CREATE` (e.g. edited in the NC web UI) is treated as **read-only**, because adding media would fail on `MKCOL`.

**Share indicator (owner side).** Owned notebooks show a "shared" badge when `listSharesForPath` returns at least one share. Fetched on demand, cached in memory for the session, refreshed when the share dialog closes and on each sync. Not persisted.

---

## 4. Recipient rules (decided)

A recipient may **read** (both modes) and **edit content** (collab only). A recipient may **never delete, move or copy** notes or notebooks.

| Action on a received notebook / its notes | Read-only | Collab |
|---|---|---|
| Open, read, search, see tasks | yes | yes |
| Edit text, strokes, tasks, task properties, title; add/remove media and recordings inside a note | no | yes |
| Create a new note in the notebook | no | yes |
| Rename / recolor the notebook | no | yes |
| Delete (trash) or purge a note or the notebook | **no** | **no** |
| Move or copy a note **into or out of** the notebook (incl. assigning a quick note to it) | **no** | **no** |
| Restore anything from trash | **no** | **no** |
| Share the notebook further | **no** | **no** |
| Leave the share ("Remove from my list", §8) | yes | yes |
| Export / print a note | yes | yes |

Enforcement is layered so a single missed button cannot cause damage:
1. **UI:** affordances hidden/disabled (editor, toolbars, notebook context menu, move/copy dialogs — shared notebooks are excluded as targets and their notes have no move/copy action — drag and drop, task checkboxes and task properties dialog in read-only notebooks).
2. **Storage layer:** `deleteNote`, `deleteNotebook`, `purgeNote`, `purgeNotebook`, `moveNote`, `copyNote`, `restoreNote`, `restoreNotebook` throw a `ShareRestrictedError` for a note/notebook in an `origin:"shared"` notebook (and for a target that is shared), in both `storage.js` and `storage.webdav.js`. Content writes (`updateNote`, `saveNote`, `SAVE_CONTENT`, `updateNotebook`) throw for read-only notebooks.
3. **Background writers** check `canEdit` before writing: handwriting recognition on note close, the AI recognition queue, missing-media self-heal. In read-only notebooks they do nothing.
4. **Sync engine:** never uploads into a root without `UPDATE`, never issues `DELETE` into a shared root, never writes a tombstone into a shared root (§5.5).
5. **Server:** permission bits (§3).

**Consequences**
- **Orphaned media:** removing an image/recording from a note is a content edit, but the recipient cannot delete the binary (`cleanupOrphanedMedia` native / `cleanupNoteMedia` NC app need `DELETE`). Both are skipped for shared roots. The binary stays until the owner's client uploads that note and runs its cleanup. Accepted (bounded, harmless).
- **Trash:** notes the owner trashed (`deleted:true`) are hidden for recipients and never appear in the recipient's trash view.
- **Owner actions are unrestricted** in their own tree: the owner can delete, purge, move notes in/out, and those changes propagate to recipients by the existing soft-delete flags and tombstones.

---

## 5. Multi-root architecture

### 5.1 Notebook record: local-only sharing fields

```
origin:           "own" | "shared"   // absent ⇒ "own" (no migration)
remoteBasePath:   string | null      // shared only: current OCS file_target, e.g. "/Shared_NoteBerg/{notebookId}"
ownerUid:         string | null      // shared only
ownerDisplayName: string | null      // shared only, for the "Shared with me" section
sharePermissions: number | null      // shared only, as granted (§3)
shareId:          string | null      // shared only, OCS share id (the first of shareIds)
shareIds:         string[]           // shared only: every OCS share mounting the folder (a user and a group share)
normalized:       boolean            // shared only: MOVE into /Shared_NoteBerg done once (§7)
shareEnded:       boolean            // shared only: share gone, kept frozen for stranded changes (§8)
strandedNoteIds:  string[]           // shared only: notes with local changes that can no longer be uploaded (§8)
```

These fields describe **this user's relationship** to the notebook, so they are **local-only**:
- **Never uploaded.** `syncNotebooks` today uploads `{...notebook, synced:true}` unfiltered (`syncNotebooks`, [nextcloudSync.js:1802](../../../src/modules/nextcloudSync.js)); a `NOTEBOOK_LOCAL_FIELDS` strip list is added there and in `storage.webdav.js` `updateNotebook`/`createNotebook` (which PUT the whole record). Otherwise a collab recipient would write `origin:"shared"` into the owner's `_notebook.json`, and the owner's client would adopt it.
- **Never adopted on download:** when a remote `_notebook.json` is applied locally, these fields are taken from the existing local record, never from the file (a buggy or malicious collaborator could write them).
- **Never in backups** (added to `SYNC_ONLY_FIELDS` handling for notebooks; shared notebooks are excluded from backups entirely, §8).

On the NC app build the same fields exist only in memory (§9); they are never written.

### 5.2 Path resolution: a notebook-base resolver

All path helpers in `storagePaths.js` (`getNotebookFolder`, `getNotebookPath`, `getNotebookNotesFolder`, `getNotePath`, `getNoteMediaFolder`, `getMediaPath`, `getNotebookTombstonePath`) already take a `notebookId`, and every caller on both builds passes it. Instead of threading a base path through every call site, `getNotebookFolder(id)` resolves through a **base registry**:

- `setSharedNotebookBases(Map<notebookId, basePath>)` / `markShareEnded(notebookId)` in `storagePaths.js`.
- Registered id → its base path. Unregistered id → `${ROOT_FOLDER}/notebooks/${id}` exactly as today (own notebooks byte-for-byte unchanged).
- An id marked ended → **throws**, never falls back to the own tree. Without this, a write for a shared note after the share vanished would create `/NoteBerg/notebooks/{ownerNotebookId}/…` in the recipient's own storage.
- Native populates the registry from local notebook records at the start of every sync and at app start; a shared record without `remoteBasePath` is not synced (and not registered as own). NC app populates it from discovery (§9).
- Base paths come from OCS (`file_target`): validated as an absolute path of safe segments (no `..`, no control characters, bounded length) before registration. Leaf segments keep `assertSafeId`/`assertSafeFilename`.

**Parsing.** `parsePath` stays the own-tree parser. A new `parseNotebookRelativePath(relPath, notebookId)` handles `_notebook.json`, `_tombstones.json`, `notes/{id}.json`, `notes/{id}_media/{file}`; `parsePath` delegates to it for `notebooks/{id}/…`, and shared-root passes call it with the notebook id known from the registry.

**DAV href handling.** `fetchRemoteState` ([nextcloudSync.js:1437](../../../src/modules/nextcloudSync.js)) and `davList` ([storage.webdav.js:340](../../../src/modules/storage.webdav.js)) locate paths with `href.indexOf(ROOT_FOLDER)`. That breaks for a user whose uid is `NoteBerg` and cannot locate shared roots. Both switch to stripping the known DAV files prefix (`/remote.php/dav/files/{uid}`, case-insensitive on uid) and then comparing with segment boundaries (`=== ROOT_FOLDER || startsWith(ROOT_FOLDER + "/")`). The recipient folder is named `/Shared_NoteBerg` so it does not share a prefix with `/NoteBerg` either way.

### 5.3 Native sync runs once per root

Order of one `performSync` on native:
1. **Root guard** (§7.4) on `/NoteBerg`.
2. **Discovery** (§7.5) — an OCS failure is logged and skipped; existing registrations stay.
3. **Own pass:** today's `fullSync`, with every `origin:"shared"` notebook **and its notes excluded** from `localNotebooks`/`localNotes`. Without the exclusion the own pass would see shared notes as "missing on remote" and self-heal them into `/NoteBerg`.
4. **One pass per shared notebook** whose `shareEnded` is false, each wrapped so a failure is logged and skipped and never aborts other passes. The pass contains only that notebook and its notes, and no quick notes or global notebook tombstone.

Remote state per root:
- `fetchRemoteState(rootPath)`: `PROPFIND Depth: infinity` on the root.
- Stock NC disables Depth: infinity, so the **shallow walker is the common path**. `fetchRemoteStateShallow` is split into an own-tree walker (today's) and `walkNotebookRoot(base)` (Depth:1 on `base` and `base/notes`). The own walker reuses `walkNotebookRoot` per own notebook.
- Cost: about 2 requests per shared notebook per sync on stock NC (1 with Depth: infinity). 50 shared notebooks is about 100 small PROPFINDs; acceptable, no batching, failures stay contained.

`hasRemoteChanges(notebookId)` (open-note polling) works unchanged through the resolver.

### 5.4 "Missing on remote" — root gone vs. note gone

Today `fetchRemoteState` returns `[]` on 404, and missing items self-heal by re-upload ([nextcloudSync.js:2593-2600](../../../src/modules/nextcloudSync.js) notebooks, [2679-2684](../../../src/modules/nextcloudSync.js) notes). For a shared root this would re-create the owner's notebook as a plain folder in the recipient's home. Therefore:

| Situation | `own` notebook | `shared` notebook |
|---|---|---|
| **Root PROPFIND 404/403** | n/a (own root handled as today) | **Pass aborted, nothing classified.** Re-check OCS (§8 "share gone" rule): moved mount → update `remoteBasePath`; share gone → forget/strand. Never self-heal. |
| `_notebook.json` missing, root present | re-upload (self-heal) | do not upload; log; skip pass (owner's folder is broken; owner's client heals it) |
| Note missing, no tombstone, local clean | re-upload (self-heal) | collab: re-upload (same as own; `CREATE` covers it). Read-only: skip. |
| Note missing, no tombstone, local modified | re-upload | collab: upload. Read-only: n/a (cannot be modified). |
| Note tombstoned, local clean | delete locally | delete locally |
| Note tombstoned, local modified | restore (re-upload) | **tombstone wins**: recipient may not resurrect what the owner purged → note goes to `strandedNoteIds` (§8) |
| Shared root never `MKCOL`ed | — | `syncNotebooks` never creates the root of a shared notebook; it exists by definition or the pass is aborted |

This gate is the single most important correctness point of the feature.

### 5.5 Engine rules for shared roots

- **Read-only root** (`!canEdit`): classification never queues uploads. A locally dirty note (should not happen, §4) is not uploaded; it is added to `strandedNoteIds` and the remote version is not applied over it until the user resolves the notice (§8).
- **Collab root:** normal bidirectional sync with the merge of §10; no `DELETE` requests (orphan-media cleanup skipped, §4), no tombstone writes, no notebook purge processing.
- **Permission drop** (collab → read-only, discovered via OCS): notes with unsynced local changes go to `strandedNoteIds`.

---

## 6. OCS layer (both platforms)

New module `src/modules/sharing/nextcloudShares.js` (feature sub-folder, like `backup_restore/`). One `ocsFetch()` with two auth strategies:
- **NC app build:** same-origin `fetch`, `OCS-APIRequest: true`, `requesttoken: window.OC.requestToken`, `credentials: "same-origin"` (pattern of `storage.webdav.js`).
- **Native:** absolute URL against the configured base, `Authorization: Basic …` from the credentials `nextcloudSync.js` already stores (`getDavAccount`), `OCS-APIRequest: true`, through the Tauri HTTP plugin.

All calls use `format=json` and check `ocs.meta.statuscode` (OCS can return HTTP 200 with a failure status).

| Function | Call |
|---|---|
| `searchSharees(query)` | `GET ocs/v2.php/apps/files_sharing/api/v1/sharees?search=…&itemType=folder&lookup=false&perPage=20` — users from `exact.users` + `users`, excluding self |
| `createShare(path, shareWith, permissions)` | `POST …/shares` (`shareType=0`, `path` = `/NoteBerg/notebooks/{id}`, `shareWith`, `permissions` 1 or 7) |
| `listSharesForPath(path)` | `GET …/shares?path={path}&reshares=false` |
| `listSharedWithMe()` | `GET …/shares?shared_with_me=true` (accepted shares only) |
| `listPendingShares()` | `GET …/shares/pending` (pending shares are **not** in `shared_with_me`) |
| `acceptPendingShare(id)` | `POST …/shares/pending/{id}` |
| `updateSharePermissions(id, perms)` | `PUT …/shares/{id}` (`permissions`) |
| `deleteShare(id)` | `DELETE …/shares/{id}` — owner: revoke; recipient: leave the share (removes only the recipient's access) |

**User listing is search-only.** NC restricts `sharees` (requires a query; admins may limit to same-group). The UI is a type-to-search autocomplete.

---

## 7. Recipient folder placement and discovery

### 7.1 Where shares land
The sharer cannot dictate placement. Levers:
1. **`share_folder` (server-wide, admin-only)** — document as optional, **do not rely on it.**
2. **MOVE after acceptance (client-controlled).** An accepted share is a mount point and can be `MOVE`d via WebDAV; NC persists the new `file_target`. On first registration: `MKCOL /Shared_NoteBerg/` (ignore 405), then `MOVE` the mount to `/Shared_NoteBerg/{notebookId}/` (the id is unique, made of safe characters only, and never goes stale when the owner renames the notebook; if the name is taken, `_2`, `_3`, …), then set `normalized: true`. The title is deliberately not used: it would need sanitizing, could collide, and goes stale on rename; NoteBerg shows the title from `_notebook.json` anyway. Whatever the folder is called (Nextcloud's own `file_target` before the move, or wherever the user moved it), paths are percent-encoded per segment when they become WebDAV URLs (`encodeDavPath`), on both builds. A failed MOVE is retried on later passes until it succeeds once; after that the app never moves it again (if the user moves it elsewhere in Files, that is respected).
3. **Address by OCS `file_target`, never by scanning.** `remoteBasePath` is refreshed from OCS on every discovery pass, so a not-yet-normalized or user-moved share keeps working.

### 7.2 Which shares are registered
Only items from `shared_with_me` that satisfy **all** of:
- `share_type == 0` and `item_type == "folder"`;
- `{file_target}/_notebook.json` exists and parses, and its `id` passes `assertSafeId`;
- the `id` is not an existing `origin:"own"` notebook and not already registered from a different `ownerUid` (collision → ignored, logged).

Anything else (the user's other folder shares) is **never moved or touched.** If several entries point at the same node (`item_source`), they are merged into one registration and their permissions are OR'ed, as NC does when mounting them.

### 7.3 Pending shares
Some instances auto-accept; others need acceptance. **The app never accepts on its own** (decided): that would override the server's setting, and a pending share's contents cannot be read before accepting. Discovery lists `listPendingShares()` and offers each pending folder user share whose folder is named like a notebook id (a UUID, optionally with Nextcloud's ` (2)` suffix) as an invitation in "Shared with me" (`sharing/invitations.js`): "{owner} wants to share a notebook with you", with **Accept** (`acceptPendingShare`, then discovery registers it if `_notebook.json` passes §7.2, and on native a sync fetches its notes) and **Decline** (`DELETE shares/pending/{id}`, after confirming). Pending shares of ordinary folders are left for the user to handle in Nextcloud. The title is not known before accepting.

### 7.4 Root guard (security requirement)
Prior art: Nextcloud Notes [CVE-2024-37317](https://nvd.nist.gov/vuln/detail/cve-2024-37317) — a folder shared to a user before their first login landed on the app's root path and hijacked their note storage. Same exposure with `/NoteBerg`:
- Before any own-tree PROPFIND, write or bootstrap (native `performSync`; NC app `initStorage`, which today `MKCOL`s `/NoteBerg` if absent, [storage.webdav.js:366](../../../src/modules/storage.webdav.js)): `PROPFIND Depth:0 /NoteBerg` requesting `oc:owner-id`. If it exists and `owner-id ≠ current uid`, it is a share: do not sync into it; MOVE it to `/Shared_NoteBerg/{ownerUid}_NoteBerg` and create a fresh own root. Discovery then treats it like any other share (it will normally not pass §7.2 and is left alone).
- The own-tree PROPFIND also requests `oc:owner-id`; any item under `/NoteBerg` owned by someone else (a share the user moved inside) is excluded from the own pass and, if it is a notebook share in OCS, normalized out by discovery.
- Current uid: native `fetchUserId` (already stored); NC app `OC.getCurrentUser().uid`. When the native lookup fails, the login name stands in for the uid; such a guess is never used to declare something foreign: the guard stops the sync instead of moving a root whose owner differs from a guessed uid, and the own pass excludes nothing (`getCurrentUserIdentity().confirmed`). The share-list fallback needs no uid.

### 7.5 Discovery sequence
`listPendingShares` → offer notebook-looking ones as invitations (§7.3) → `listSharedWithMe` → filter/merge (§7.2) → for new ones: normalize (§7.1) → register (`origin:"shared"`, `remoteBasePath`, `ownerUid`, `ownerDisplayName`, `sharePermissions`, `shareId`) → for known ones: refresh `remoteBasePath`, `sharePermissions`, display name → apply the "share gone" rule (§8) to registered ones missing from the listing.

Discovery runs only when the OCS listing succeeded. A failed or non-OK OCS response changes nothing.

---

## 8. Share lifecycle

| Transition | Owner side | Recipient side |
|---|---|---|
| **Share created** | `createShare` (1 or 7); badge + recipient list | discovery: accept → normalize → register → appears in "Shared with me" |
| **Permissions changed** | `updateSharePermissions` | discovery refreshes `sharePermissions`; UI re-gates; collab→read-only strands unsynced notes (§5.5) and announces it (`share-access-reduced`): an open editor stores what was typed, then turns read-only with a notice. On native those last writes are kept locally (the storage worker accepts them from an editor that opened the note with edit rights, `OPEN_FOR_EDITING`) and become stranded notes; on the NC app build they cannot be saved. |
| **Owner revokes** | `deleteShare` | share gone (below) |
| **Owner trashes notebook** (`deleted:true`) | normal soft delete; confirm dialog mentions recipients lose access when it is purged | notebook hidden; sync continues (nothing is lost, owner can restore) |
| **Owner purges notebook** | normal purge: global tombstone in owner tree, folder deleted; NC removes the shares | share gone (below) |
| **Recipient leaves** ("Remove from my list") | recipient disappears from the owner's list | confirm (warns if notes have unsynced changes) → `deleteShare` for every share in `shareIds` (one left behind would mount the folder again) → forget locally |

**"Share gone" rule (two signals, never one).** A registered share is treated as gone only when the OCS listing **succeeded** and does not contain it **and** a `PROPFIND Depth:0` on `remoteBasePath` returns 404/403. Cases:
- Absent from OCS, root still readable → keep, retry next pass (server lag).
- In OCS, root 404 → mount moved; take the new `file_target` and continue.
- Both → gone.

**When gone (native):**
- No local unsynced changes → **forget**: `permanentlyDeleteNotesInNotebook` + `permanentlyDeleteNotebook` locally, **no tombstone, no remote call**, unregister the base, `markShareEnded`.
- Unsynced changes (`synced:false` notes or non-empty `strandedNoteIds`) → set `shareEnded:true`, keep the notebook **frozen** (read-only, not synced) in "Shared with me" with a notice: "This notebook is no longer shared with you. N notes had changes that could not be saved." Action: **Dismiss** → forget. No copy/move-out (§4); export/print of individual notes remains possible before dismissing.

**When gone (NC app):** nothing is stored locally, so the notebook simply disappears; if a note of it is open in the editor, the editor switches to read-only with the same notice (unsaved in-editor changes are lost).

**Stranded notes** (`strandedNoteIds`, native, share still active): shown with a notice on the notebook ("N notes have changes the owner's settings no longer allow to save"). Action: **Discard my changes** → the note is re-downloaded (remote wins) and removed from the list. If the share later becomes writable again, stranded notes go through normal classification/merge and the list clears.

**Re-share of the same notebook after it was gone:** a new `shareId` for an id that is still frozen locally reattaches it (`shareEnded:false`, new base/permissions); stranded notes then sync normally if permitted.

**Backups:** shared notebooks and their notes are excluded from backups (they belong to the owner). Restore skips any entry whose notebook id is locally `origin:"shared"`.

---

## 9. NC app build

`storage.webdav.js` (`VITE_PLATFORM=nextcloud`) has no local database and does not use `nextcloudSync.js`: every read lists/GETs WebDAV live (15 s read cache), and notebooks are listed only from `${ROOT_FOLDER}/notebooks` ([storage.webdav.js:519](../../../src/modules/storage.webdav.js)). Sharing on this build needs:

- **Registry (in memory).** `src/modules/sharing/sharedRoots.js` holds the shared registrations; discovery logic (§7.5, minus persistence) is the same module for both builds, with storage injected. On the NC app it runs in `initStorage` (after the root guard), then again at most every 60 s when the notebook list is read, on `visibilitychange` to visible, and after leaving a share. It feeds `setSharedNotebookBases` (§5.2).
- **Listing.** `_getAllNotebooksRaw` returns own notebooks plus `davGet(base + "/_notebook.json")` for each registered root, annotated in memory with the §5.1 fields. `getAllNotes`, `_getAllNotesIncludingDeleted`, `_findNote`, `getNotesByNotebook` and `getFile` therefore include shared notebooks through the resolver with no further change. Trash views (`getDeletedNotes`, `getDeletedNotebooks`) exclude shared notebooks (§4).
- **Writes.** `createNotebook`/`updateNotebook` strip the local-only fields; restricted operations throw (§4); `cleanupNoteMedia` is skipped for shared notebooks.
- **Concurrent writes.** Shared collab notebooks on this build require the merge-capable write path (§10.4): `If-Match`, 412 → re-GET, merge, retry.
- **Share ended while open:** a write that fails with 404/403 triggers a registry refresh; if the share is gone (§8 rule), `markShareEnded` makes further writes throw instead of falling back into the own tree, and the editor shows the notice.
- **Owner side** works like native: OCS via cookie + `requesttoken`.

---

## 10. Concurrent editing and merge hardening

**Scope decision:** real-time collaboration (live cursors, streamed strokes, CRDT text, relay service) is **out of scope** — Nextcloud cannot push over WebDAV, so it would need a separate relay with its own auth/permission mapping (est. 2–3+ months). v1 is **asynchronous collaboration** on the existing file-based sync, made safe by better merging. This work also benefits single-user multi-device sync and ships independently of sharing. Optional later follow-up: fast polling of the open note only.

### 10.1 What `attemptMerge` does today

| Field | Rule | Two-user verdict |
|---|---|---|
| strokes | union by id, deletions from either side win, sorted by `time[0]` | fine (append-mostly) — `time[0]` is a device wall clock, see §10.2 #6 |
| media / recordings / tags | union by id, deletions win | fine |
| tasks | per-id, newer `modified` wins | fine except same-task edits (LWW) |
| title / background | newer note `modified` wins | acceptable |
| `content` (HTML text) | merged only if one side contains the other (append heuristic), else `null` | **insufficient** |
| `deleted` | deleted on either side ⇒ deleted | fine: only owners delete in shared notebooks (§4) |

### 10.2 Known gaps

1. **A text divergence discards the whole losing side**, not just the text: `attemptMerge` returns `null` for the entire note, so strokes/media/tasks of the loser go with it. Resolution paths: silent/startup sync → whole-note newest-`modified` wins (`sync.js` auto-resolve); download race → "keeping local version" (remote text dropped, `sync.js` ~L334); manual sync → modal.
2. **Modal conflict dialog is wrong for two users** — each user is prompted independently and can choose differently, so the note can flip-flop.
3. **No base version** is kept, so a real three-way text merge is impossible today.
4. **Delete vs. concurrent edit:** a delete on one side wins and the other side's unseen strokes vanish with the note. In shared notebooks only the owner deletes; see §10.3 G.
5. **Locked app + local encryption:** a note that cannot be decrypted takes the "local wins, remote's edits are lost" fallback (`attemptMergeEncrypted`). Rare for one user, more likely with collaborators; needs a visible notice.
6. **Wall-clock dependence** (`modified`, stroke `time[0]`, task `modified`): tolerable across one user's devices, unreliable across two users' devices. Stroke order feeds handwriting recognition, so skew can reorder strokes across authors.

### 10.3 Merge design (decided: baseline text, not block ids)

**Why a baseline:** it keeps the whole change in the sync/storage layer. Block ids (`data-bid`/`data-rev`/`data-base`) would couple merge correctness to Trumbowyg behaviour (Enter clones attributes, paste/list conversions), force id assignment on legacy notes (false conflicts if devices assign differently), and rewrite content at every sync (etag churn). The baseline is a separate record the editor never sees.

**A. Field-independent merge.** `attemptMerge` must never return `null` for the whole note because of text. Everything except `content` merges as today; `content` is resolved by B and cannot fail (B always produces output). `attemptMerge(local, remote, opts)` gains an optional third argument `{ base, localAuthor, remoteAuthor }` — backward compatible, still pure and worker-safe (no key access; encrypted notes keep their main-thread wrapper `attemptMergeEncrypted`).

**B. Three-way block merge of `content` (HTML).**

- **Blocks:** the top-level children of the editor HTML; `ul`/`ol` are split so each `li` is its own block (wrapper rebuilt on output); contiguous bare inline nodes / `<br>` at top level form one pseudo-block. Compared after normalization (whitespace, and **with merge-hint spans stripped** — see idempotency). Exact segmentation is fixed by a spike against real note HTML (task lines, tables, quotes, pre, bare text) before coding.
- **Alignment:** diff3 over the block sequences (`base`, `local`, `remote`), comparing normalized HTML. Small in-house implementation or a vetted tiny dependency — decided in the spike (the repo has a dependency/security scanner; avoid heavy deps).
- **Per-hunk rules:**

| Situation | Result |
|---|---|
| Only one side changed vs base | take that side, no hint |
| Both made the identical change | take it |
| Both changed the same block differently | **conflict**: keep both blocks adjacent; the *primary* stays in place, the other is inserted right after it with a hint |
| Block inserted on one side only | keep it, positioned by its neighbours |
| Deleted on one side, unchanged on the other | delete |
| Deleted on one side, **edited** on the other | keep the edited block (lossless), no hint |

- **Changes of both sides in one region (added 2026-10-18):** where no unchanged block separates the two sides' changes, each side is aligned with the base on its own and turned into changes of base ranges (diff3). Changes touching different base blocks are all applied; inserts at the same place keep both (primary first); a change already applied in the other side's (re-merging a merge result) yields to it; a pure deletion inside the other side's change, or around an edit of the other side, deletes the rest and keeps the edit; the same base range changed on both sides is resolved as a small region of its own, so one real conflict no longer turns its neighbours into conflicts. Within a change, a new table (or table row) that is evidently a changed version of a base one is paired with it, so it meets the other side's change of the same table or row.
- **Tables (added 2026-10-18):** a table both sides changed is merged one level deeper instead of kept twice: rows are aligned and resolved like blocks (row added, deleted, reordered against edits elsewhere), and a row both sides changed is merged cell by cell. Only a cell both changed differently is a conflict: it keeps the primary's text and the other's in a `<div>` with the merge hint, inside that cell. Rows and cells compare by content, not attributes (restyling is not an edit). Shapes that cannot be lined up keep both tables whole, as before: a column added or removed, merged cells (`colspan`/`rowspan`), a table inside a cell, unparseable markup. Two tables without a baseline are only merged when they share a row. Checked by `textMerge.property.test.js` (random paragraph and table edits by two writers: convergence, idempotency, nothing lost; 1,000 histories checked by hand).
- **Convergence (hard requirement):** both users run the merge independently, so the output must not depend on which side is "local". Primary = the version from the note with the later `modified`; tie → smaller content hash. The duplicate carries a **deterministic conflict id** (hash of the two normalized versions) so two simultaneous merges produce identical blocks and are deduplicated by id.
- **Idempotency (hard requirement):** after A merges and uploads, B's sync must NOT see a new conflict. Hint spans are excluded from block comparison, so B's own version equals the hinted duplicate and B simply takes A's merged result.
- **No baseline** (note never synced from this device, restored from backup, baseline missing): align `local` vs `remote` by LCS; blocks present on one side only are kept (cannot tell insert from delete → keep, lossless); differing blocks in the same gap are treated as conflicts (both kept, hint). Noisy once, then a baseline exists.
- **Hint:** an inline `<span class="merge-hint" contenteditable="false" data-conflict="<id>" data-by="<uid>">` inside the duplicated block, styled right-aligned as a compact amber warning triangle (`⚠`) via `TextLayer.css` (both themes, no inline styles) with a popover tooltip showing the localized message ("Conflicting version — edited by <user>", or generic label when the author is unknown) on hover, focus, or touch (`data-hint` attribute rendered via `::after`). Both the icon text and transient attributes (`data-hint`, `aria-label`, `role`, `.merge-hint--open`) are generated at render time and stripped again in `getContent()` next to the existing checkbox/highlight cleanup, so stored HTML carries only `class`, `contenteditable`, `data-conflict`, and `data-by`. The hint is stripped for recognition, search and export; exported/plain HTML degrades to the duplicated block. Resolution in v1 is manual: the user deletes the block they do not want (the hint goes with it). In a read-only shared notebook the recipient sees the hint and can hover/tap it, but cannot resolve it.

**C. Baseline storage (decided: `noteBase` object store, native only).** The baseline is the HTML of `content` as of the last state known to be on the server *and acknowledged by this device*.

- **Store:** new IndexedDB object store `noteBase` keyed by note id; `DB_VERSION` 5 → 6 in `storage.js`, additive upgrade (empty store, no data migration). The exported `DB_VERSION` in `storage.webdav.js` and the backup fixture's `DB_VERSION` move to 6 as well. Consequence (accepted): backups written after the bump are refused by clients still on 5 (`checkCompatibility`), so all clients are updated together, as for any release.
- **Written** only at sync boundaries: after a successful upload (baseline := the exact content uploaded, **independent of the `expectedModified` check** — the server holds it even if the user kept typing), and after a downloaded note is saved (baseline := downloaded content). A classify-time merge does not set it; the upload that follows does.
- **Never written** by local edits (`SAVE_CONTENT`, `updateNote`), by the etag-only paths (`updateNoteEtag`, oscillation fix), or by backup restore (restored notes start without a baseline).
- **Kept while the note is in the trash.** A soft delete (`deleteNote`/`deleteNotebook` set `deleted:true`) does not touch it; restore from trash finds it intact.
- **Removed** on every path that finally drops the note's content record, in the same IndexedDB transaction as the content delete where one exists: `purgeNote` (and `purgeNotebook` per note), `permanentlyDeleteNote`, `permanentlyDeleteNotesInNotebook` (incl. remote tombstone and forgotten shared notebook, §8), `clearAllData` and `purgeLocalData` (`db.clear("noteBase")`). Safety net: `initStorage` drops baseline rows whose note has no index entry or is a purged stub.
- **Encryption:** with local encryption on, the baseline is stored encrypted with the same key and only read on the main thread; if the app is locked, behaviour is the existing local-wins fallback (§10.2 #5).
- **Never uploaded, never in backups, never merged into note objects.**

**D. Dialog policy.** Notes in `origin:"shared"` notebooks, and in own notebooks that have recipients (owner-side share info, §3), never show the blocking conflict dialog; B resolves them. The dialog remains for other notes (reachable only when `attemptMerge` still returns `null`, which after A is limited to structurally invalid data).

**E. Clock skew — accepted v1 limitation.** Stroke `time[0]` and `modified` are device wall clocks (`Date.now()`). The stroke sort stays time-based because it is deterministic and therefore convergent between two independent mergers; an append-the-other-side rule would not converge. Skew only reorders strokes of *simultaneous* authors on one note. Optional later improvement: a measured server-clock offset.

**F. Author attribution (note level).** New field `lastModifiedBy` (NC uid), set on every upload on native (uid from `fetchUserId`) and on every PUT on the NC app build (`OC.getCurrentUser().uid`). It labels the hint: the remote copy is attributed to `remote.lastModifiedBy`, the local copy to the current user. Limitation: when the remote file was itself a merge, the attribution is the merger's. Absent on legacy notes → generic label. Per-stroke authorship is not needed.

**G. Delete vs. concurrent edit.** Keep "delete wins" for `deleted`. In shared notebooks only the owner deletes: a recipient's edit to an owner-trashed note still syncs into the trashed note (owner can restore it). A recipient who has the note open when the deletion arrives sees the editor turn read-only with a notice saying so, instead of the note silently vanishing; a recipient's unsynced edit to an owner-purged note is stranded, not resurrected (§5.4). For own notebooks across devices: verify what the existing trash/tombstone flow preserves and add only what is missing.

### 10.4 NC app build write path

`storage.webdav.js` writes are read-modify-write of the whole JSON file (`_applyNoteUpdate`: GET, overlay `updates`, `PUT`) with **no `If-Match` and no merge**; `updateNoteEtag` is a no-op. Strokes are re-sent in full from the editor's in-memory state on every save (`StrokeManager` → `updateNoteCoalesced`). With two writers the last PUT silently replaces the other's strokes and text. Required (decided: in scope for v1; read-only on this build is not an accepted fallback):
- `If-Match` on the PUT (etag from the preceding GET); on 412, re-GET, merge, retry (bounded, like the existing tombstone loop in `_updateTombstone`).
- Merge instead of overwrite: `attemptMerge(existing, incoming, { base })` — strokes by id union with deletions, text by §10.3 B, same hint/convergence rules.
- **Baseline in memory per open note:** set to the content loaded from the server; after each successful PUT set to the content that was sent (not the editor's current content, which may have moved on). A reload re-reads it from the server. Nothing is persisted.

### 10.4a The text of an open note (both builds)

Merging in storage is not enough while a note is open: the editor keeps showing its own text. Previously an open note took in remote strokes (`applyLiveUpdate`) but never remote text, and on native the next text save (`SAVE_CONTENT`, a blind write) overwrote a downloaded version. `NoteCanvas/liveText.js` closes this:
- **Guarded saves (native):** every `SAVE_CONTENT` carries `expected`, the stored text it replaces. The storage worker refuses it when storage holds something else (checked before and again inside the write transaction) and reports `stale`; every save reports `saved`/`stale`/`failed` back. A save never overwrites text the editor has not seen.
- **Reconcile:** on a refused save and on every external `datachange` (sync, or `source:"merge"` on the NC build, whose write path already merges server-side), the stored text is read in write order (worker `READ_CONTENT`; NC: flush, then GET). If it is not the editor's own, it is merged three-way into the editor (§10.3 B) and the merge stored. The caret keeps its character position; undo history is cleared (its steps were recorded against the old text).
- **Base** = the editor's newest save storage accepted (in the editor's own HTML form, so normalization never reads as an edit). After a merge is shown, the stored version stays the base until the merged save is accepted, so a second remote version arriving in between cannot read the user's edits as deletions.
- **Live updates while the note stays open (§10.4b):** both builds look for remote changes periodically.

### 10.4b Live updates of an open note (both builds)

While a note is open, `NoteCanvas/liveRefresh.js` decides **when** to look for someone else's changes, and `NoteCanvas._liveCheck` decides **what** the look does.
- **Cadence:** every `LIVE_CHECK_INTERVAL_MS` (5 s; it was 15 s before the work after a look moved off the main thread, §10.4c), only while the window is visible and the device online (no timer otherwise; the first look after coming back follows after `QUIET_MS`). Stops when the note closes.
- **Never while writing:** no request, storage access, reconcile or redraw while a stroke is drawn, a finger is down, a pen hovers over the page, or within `QUIET_MS` (2.5 s) of the last pointer or key input. A hovering pen (pen `pointermove` with no button) is the earliest sign that writing resumes, and it arrives before contact. The input listeners only record a timestamp (no timers per event). A look that finds a change after the user resumed writing reports `deferred` and runs again at the next pause. A `datachange` arriving while the user writes is held (`pendingLiveUpdate`) and taken in at the next pause too; this replaces the old "apply at stroke end" and "reconcile text even mid-stroke" behaviour.
- **Native: the open note synced by itself (`liveNoteSync.js`):** one Depth:0 PROPFIND of the note file. Only when its etag differs from the one last synced, or the note holds unsynced edits, the note's text is downloaded (when it changed) and its media folder listed. The storage worker then plans and does the rest (`liveSyncPlan.js`), as the full sync would for this one note: both changed is merged with the baseline, saved, and uploaded against the server's etag; only the server changed is saved as a download; only this device changed is uploaded against the etag it last synced. The main thread then sends the upload (a string), and the worker marks the note synced (unless edited meanwhile) and records the new baseline. The editor takes in the delta the worker computed. Anything outside that comes back as "full", and the notebook's full sync below runs instead, at most every 15 s: local encryption, media binaries to move, a moved, restored or never-uploaded note, a conflict that cannot be merged, or a 404. A full sync never runs at the same time (`sync.runExclusiveSync`). Changes to other notes of the notebook are not looked for while a note is open; they come with the sync on close.
- **Native fallback (full sync):** `autoSync.syncIfNotebookChanged`: `hasRemoteChanges` (one Depth:1 listing of the notebook's notes, compared by etag; shared notebooks resolve through their registered base path) and, only on a change, the silent `performSync`. Its `datachange` reaches `handleExternalDataChange` as before. Found within the sync cooldown, the look is `deferred`.
- **This device's edits go up at the pause (native):** the same look also syncs when the open, editable note holds changes not uploaded yet (`synced: false`), without asking the server first. Before, a native edit reached the server only when the note closed, or as a side effect of a sync for someone else's change: a collaborator watching in the NC app saw nothing until they edited too. The 30 s inactivity upload (`resetInactivityTimer`) had lost its caller in an earlier editor rewrite. A note the sync could not upload (an unmergeable conflict, a refused write) is pushed again only after `PUSH_RETRY_MS` (2 min), not at every look. A viewer's note is never pushed.
- **NC build:** `remoteNoteChange` (one Depth:0 PROPFIND of the note file, compared with the etag `_noteSync` tracks; skipped while a save of ours is queued) and, only on a change, `takeInStoredNote`: the note-file worker GETs, parses and merges the note against what the editor holds, strokes and text alike, and returns the delta. If no save of ours came between (`noteSyncUnchanged`), the user still pauses, the editor's text did not change since it was sent, and LiveText is not mid-reconcile, the editor applies the strokes' delta (`_applyTakeIn`) and the merged text (`LiveText.applyMerged`) and the tracking moves to the version read (`adoptRemoteNote`: its etag, base = the editor's agreed text, `needsMerge` off), all in one synchronous step. No save can come between that would merge again or overlay the version without the strokes it brought. If a save of ours came between, it already merged and announced `source:"merge"`.
- **Drawn strokes are saved at the pause (NC build):** `StrokeManager._save` does not write on this build (so drawing never waits on a GET+PUT). Strokes reached the server only with an erase, paste or move, on close, or when the tab was hidden, so collaborators never saw a newly drawn stroke while its author kept the note open. Stroke end now asks `liveRefresh.whenIdle()` for `forceSave()`: one timer, run `QUIET_MS` after the last input. `remoteNoteChange` logs why a look found nothing at `console.debug` level.
- **A merge counts as a visible change (native):** when both sides changed the open note, `fullSync` merges, saves the merge locally and uploads it, and downloads nothing. It now reports such notes as `mergedNoteIds`, and `applySyncResult` counts them, so the sync announces a `datachange`. Before, the editor never took the other side's strokes in. The text only arrived after the next refused save.
- **No stroke-count gate:** `handleExternalDataChange` no longer asks `hasContentChanged()` (a count comparison that missed moved, recoloured, or erased-and-redrawn strokes). `_takeInNote` decides stroke by stroke and does nothing for metadata-only churn. Media are compared without the renderer's runtime fields (`renderable`, `loading`, ...), so a note with PDF pages is not rebuilt on every update.
- **Taking strokes in (`_takeInNote`, both builds):** strokes that only arrived are appended and painted on their own (`CanvasRenderer.drawAddedStrokes`). The undo history is kept, since appending moves no index. A removed or moved stroke, a media change or a new background rebuilds the canvas as before. Only what the editor holds beyond the stored version is written back: writing the merge unconditionally (the old `_saveTasks()` on every live update) made two open editors hand uploads back and forth forever.
- **Not done:** a stale text save still reconciles at once rather than at the next pause, because deferring it would risk losing the last edits if the note closes first.

### 10.4c Writing performance: the main thread is the pen's (both builds)

Writing must never stall, so nothing heavy runs on the main thread while a note is open: no `JSON.parse` or `JSON.stringify` of a whole note, no merge of its strokes, and no posting of its stroke list. Measured on the dev machine (jsdom, indicative): at 5,000 strokes (6 MB) a note's parse took 37 ms and its stroke merge 108 ms; at 20,000 strokes, 207 ms and 496 ms. Posting the whole stroke list to the storage worker took about 52 ms at 5,000 strokes, on every pen lift.
- **Saves carry only what storage has not confirmed** (`StrokeManager`): it keeps the version of each stroke storage holds (from load, from confirmed saves, and from take-ins). A save carries the strokes that differ, and erased strokes as ids. The native worker answers `STROKES_SAVED`; a save without an answer leaves its strokes unconfirmed, and the next save carries them again (as the full list used to repair a failed save). On the NC build, `updateNoteCoalesced` carries `strokesPartial`, and a newer snapshot holds every unconfirmed stroke an older one did, so coalescing stays safe. Storage merges partial saves by element (`noteMerge.resolvePartialStrokes`, the same merge the native worker always did).
- **Take-ins as deltas** (`liveTakeIn.js`): the editor sends a compact view: each stroke's id and version, its unconfirmed strokes whole, and its small fields. The worker rebuilds the editor's note from the view and the stored strokes, merges with `mergeNoteParts` as before, and returns only what changed: strokes added, changed (whole) and removed, the new order when strokes were removed or restored, and the small fields. When both sides hold the same strokes (someone else only typed), the stroke merge is skipped. A property test holds the delta to exactly what merging the editor's whole note gave.
- **Where the work runs:** native, in the editor's storage worker (`TAKE_IN`, `MERGE_TEXT`, `LIVE_SYNC`, `LIVE_SYNC_COMMIT`), in queue order after the editor's saves. NC, in the note-file worker (`workers/noteFileWorker.js` running `noteFileOps.js`): every save of a note (GET, merge, PUT), every take-in, and LiveText's reads and merges. The main thread keeps the bookkeeping (where a note lives, `_noteSync`, caches, announcements). `noteFileClient.js` runs the same operations inline where no worker can start (tests, or a policy without `worker-src`), so a refused worker costs smoothness, never correctness. The text merge needs an HTML parser, and workers have no `DOMParser`; they use `linkedom`'s (`textMerge.useHtmlParser`), and the whole text-merge suite also runs with it (`textMerge.linkedom.test.js`).
- **Applying stays short and gives up when input arrives:** the main thread applies a delta only if the user still pauses (and, for text, only if the editor's text did not change since the merge was asked for). Otherwise the change is taken in at the next pause, from storage. Strokes that only arrived are appended and drawn; changed ones are replaced in place; only removals rebuild the list.
- **Measured on devices:** `utils/perfMonitor.js` (on in development builds, and anywhere after `localStorage.setItem("noteberg_perf", "1")`) logs every long task (50 ms and more) with the steps under way, and says whether the user was writing (a stroke under way, or pen-down within 500 ms). A full sync logs how long it took. Long tasks are reported by Chromium-based engines (WebView2, Android WebView, Chrome).
- **Uploads as raw bytes (native):** the HTTP plugin sends request bodies over IPC as JSON arrays of numbers (about 1.5 s for a 1.3 MB note). Uploads therefore go through the app's own `nc_put_file` command, which takes the body as raw bytes. It is narrow on purpose: the WebView names only an encoded path in the user's own files (or chunked-upload area) and the upload's conditions. The command reads the server and the login from the stored credentials, and accepts PUT only. The plugin remains the fallback (`nextcloudSync.putFileRaw`).
- **Builds:** the NC build emits its workers into `js/` (cleaned before each build, copied by every deploy recipe); its CSP already allows `worker-src 'self'`.

### 10.5 Out of scope
Character-level text merging inside a block, CRDT/OT, presence, live strokes while they are drawn, per-user undo across sessions, per-stroke authorship, block ids.

### 10.6 Merge readiness (checked against the code)

**Verified**
- Per-field merge of strokes, media, recordings, tags, tasks exists and is deterministic (`attemptMerge`, `mergeStrokes`); stroke ids are stable.
- `attemptMerge` call sites: `nextcloudSync.js` ~L2727 and ~L2798, `sync.js` ~L334 (download race).
- Worker partial writes (`SAVE_CONTENT` etc. in `StorageWorker.js`) touch single fields of the content record, so they cannot clobber a baseline.
- The note upload path strips an explicit field list (`nextcloudSync.js` ~L1984-1990).
- The mock WebDAV server enforces `If-Match`/412 (`__fixtures__/mockWebDAVServer.js`).
- Stroke times are `Date.now()` (E is a real but bounded limitation).

**Spikes (step 0 of the merge work, each small)**
- Does Trumbowyg keep a `<span contenteditable="false" data-*>` (and an empty one) through load → edit → `getContent()`? Does Enter next to it behave?
- Block segmentation fixtures from real notes (task lines, tables, quotes, pre, bare text, nested lists).
- diff3: in-house vs tiny dependency.

**Spike findings (as implemented)**
- *Block segmentation* (`textMerge.js`, `segmentBlocks`): top-level elements are blocks; `ul`/`ol` split per `li` and are rebuilt by grouping consecutive items of the same list shell; contiguous bare inline nodes form one pseudo-block; whitespace-only runs are dropped. Tables, `pre` and quotes are single blocks (a conflict in one duplicates the whole block). Block keys are whitespace-normalized outer HTML with hint spans removed.
- *diff3*: in-house (about 150 lines, LCS with prefix/suffix trimming, bounded at 25M cells). No dependency was added.
- *Trumbowyg and the hint span*: not verified in a real browser (jsdom cannot run Trumbowyg). The implementation therefore does not depend on the answer: `renderMergeHints` re-applies `contenteditable="false"` and the label every time content enters the editor, `getContent()` empties the label again, and DOMPurify is covered by a test to keep `class`, `data-conflict` and `data-by`. **To check by hand:** type next to and after a hint, press Enter next to it, and undo/redo across it.
- *Same-gap inserts* by both sides are kept without a hint (they are not a conflict); only two different versions of the same block get one.

**Accepted residual risks**
- Adjacent-block edits by two users can be flagged as one conflict (git-like); output is still lossless.
- A locked app with local encryption takes the local-wins fallback for notes it cannot decrypt (§10.2 #5); worth a visible notice.
- Attribution on the hint is note-level (§10.3 F).

---

### 10.7 Element-level merge (decided and implemented 2026-10-18)

**Why.** §10.3 made text merging safe. The rest of a note still merges by *note*: when both sides hold the same stroke or media item, the copy from the note with the newer `modified` wins whole. With live updates (§10.4b) and one user's several devices this goes wrong in practice:

| Concurrent edits | Result today |
|---|---|
| A moves/resizes strokes (lasso), B saves later with its stale copies | A's move is silently undone |
| A inserts space, B draws below the line before seeing it, B saves later | the whole shift is undone (strokes and media) |
| A inserts space, it lands after B's new strokes | B's new strokes stay put while everything around them moves |
| A part-erases a stroke, B moves it | moved original deleted, pieces at the old position (accepted, see decisions) |
| A and B move/crop/reorder the same media item | newer note wins the item; z-order follows whichever array is taken |

An edit lock was considered and rejected: offline editing is a main feature, so a lock can never be complete, and the merge has to be right anyway. A CRDT library (Automerge/Yjs) was rejected too: it would solve per-element versions, but not "insert space moves what you have not seen yet" (that is application meaning), and it would replace the readable note JSON both builds read with a binary document carrying its history.

**Decisions (user, 2026-10-18).**
1. Part erase on one side, move of the same stroke on the other: **delete wins** (the original stays deleted, the pieces stay where they were cut).
2. Erase on one side, move of the same stroke on the other: **delete wins**.
3. A stroke crossing an insert-space line is **not moved**, during the edit and in a merge. The test is the one `_onStrokeEnd` uses today: a stroke moves when its top edge is below the line (`minY > startY`); a media item when `y > startY`, PDF pages never.

**A. One merge, everywhere.** A single pure function (`mergeNoteParts(a, b)`, wrapped by `attemptMerge` for text and bookkeeping) in `noteMerge.js`, worker-safe, is the only place two versions of a note are combined: native `fullSync` (both-modified and stale-fork branches), the download race merge in `applySyncResult`, the NC writer (`_mergeWithRemote`), the open editor's take-in (`_takeInNote`, which had its own union with a different winner rule) and the native storage worker's saves. Text keeps §10.3 B inside it. The editor merges its state with the stored one through it, then applies the difference (incremental when only elements were added, as now).

Hard requirements, checked by property-based tests: **commutative** `merge(a,b) = merge(b,a)`, **associative**, **idempotent** `merge(a,a) = a`. Two devices merging the same versions in any order must produce the same note, or they diverge.

**B. Versions: a hybrid logical clock.** Every change is stamped with an HLC value from the device that made it: wall time, a counter, and the device id, encoded as a fixed-width string so that plain string comparison orders them (`<time base36, 9>-<counter base36, 3>-<deviceId>`). The clock never runs behind what the device has seen: taking in a version (sync download, live update, NC merge) advances the local clock past every stamp in it, so an edit made after seeing another always carries a larger stamp, whatever the two devices' wall clocks say. The device id is stable per installation on native (`localStorage`) and new on every page load on the NC build (two tabs are two writers).

**C. Per-element merge.** Elements are strokes, media items, recordings and tasks; each carries `v`, the stamp of its last change (create, move, resize, rotate, recolour, crop, shift, task edit).

| Situation | Result |
|---|---|
| id on one side only | kept |
| id tombstoned on either side (`deletedStrokes`, `deletedMedia`, `deletedRecordings`, `deletedTasks`) | deleted. Delete wins over any concurrent change (decisions 1 and 2) |
| id on both sides | the copy with the larger `v`; equal `v` means equal content |
| scalar fields (`title`, `background`, `penPresets`, `pdfSource`) | per field, larger stamp wins (`fieldVersions: {title: v, ...}`) |
| stroke order | as today: by `time[0]`, then id (deterministic, §10.3 E) |
| media z-order | by a sortable key `z` set on insert and on reorder, then id; no longer array position |

Because tombstones are permanent, an undo that brings an element back must say so, or a merge would delete it again on the next sync. **Implemented differently from the first plan (fresh ids):** stroke tasks and text task spans reference ids, so a new id would break them. Instead every deletion records its stamp in `note.tombstones[id]`, and an element brought back by an undo carries `restores` = the stamp of the deletion it undid. The element is alive while some copy restores the newest deletion of its id; a later deletion (larger stamp) wins again. `restores` is merged on its own, the largest of all copies, independent of which copy wins the element: a copy edited by a writer that never saw the undo would otherwise take it away again (found by the property tests). Accepted limit: when two writers delete the same element concurrently and one of them undoes its own deletion, the undo wins if its deletion was the later one.

**D. Insert space as a recorded operation.** Insert space still moves the strokes and media below the line, and additionally appends an entry to the note's `shifts` list: `{v, y, delta}`; its stamp `v` is its id and names the device. Each element records which shifts it has *seen*: `seen`, a small version vector `{deviceId: stamp of that device's newest shift seen}` (a device's shifts are ordered by its own clock, so seeing one means seeing its earlier ones). A version stamp alone cannot tell this, because a stroke drawn offline long after a shift (in wall time) may still never have seen it.
- A device stamps `seen` on every element it creates or changes with all shifts it currently knows (absent while a note has no shifts, so ordinary notes pay nothing).
- **Normalization (the last step of every merge):** a function of the element as last edited (its *base*) and the set of shifts only, never of the order in which shifts reached it, so merges of three versions agree however they are grouped. A moved element's version grows by the stamps of the shifts applied since its edit (`<v>+<shift v>+…`), so the moved copy wins over the unmoved one wherever the two meet. The base is recovered from that version (the listed shifts' deltas taken back). Then every shift the edit had not seen is replayed on the base in `v` order: it moves the element by `delta` if its top edge (media: `y`) is below the shift's `y` at that point. `seen` stays what the edit saw. (It used to grow with every shift checked. Then an element met by a newer shift first was checked against an older one from where the newer had put it, and three-way merges depended on grouping. Found by the associativity property test.) A shift an element lists as applied counts as applied whatever its `seen` says, so elements stored the old way keep their place.
- **The shifting device** marks what it moved by stamping it (with the new shift seen), and stamps what lies below the line but is deliberately left in place (an undo of an insert space moves back only what the insert moved): otherwise the merge would move that too. An undo of an insert space is recorded as the opposite shift.
- What this gives: strokes drawn by anyone below the line before seeing the shift end up moved exactly once; strokes drawn after seeing it, and strokes above the line or crossing it, are never moved; a concurrent move of a stroke (larger `v`) wins, and its new position is then checked against the shifts it has not seen.
- The `shifts` list is kept (about 50 bytes per insert space); it cannot be pruned safely while an offline device may still bring elements that have not seen an entry.
- **Growth (measured, `noteMerge.elements.test.js` "what insert spaces cost"):** every insert space adds one `shifts` entry (under 80 bytes of JSON), and one stamp (about 25 bytes) to the version of each element it moves *without having seen it*. Elements the shifting device moved itself are re-stamped instead, and any later edit of an element resets its version to a plain stamp. So a long version only builds up on elements that sit untouched below many insert spaces made elsewhere (100 such shifts: about 2.5 KB on each such element). `tombstones` grow by one stamp per deleted element id. Normalization costs O(elements × shifts) on every merge and worker save. None of this is pruned yet. This is acceptable for notes with hundreds of insert spaces, not for tens of thousands.
- **Pruning (later):** a shift can go once no device can still bring an element that has not seen it (causal stability). That needs each writer to publish the newest shift it has seen (for example per device in the note), plus a rule for writers that never come back (an age limit after which their unseen elements are not shifted). Once a shift is stable, it is dropped from `shifts`, and its stamp is dropped from every compound version (the element keeps its position). Tombstones of ids no live copy can still carry can go by the same rule.

**E. Derived data.** Recognition bands carry positions; after a merge whose ink differs from both sides' they are dropped (as a whole) and rebuilt by the existing recognition triggers, not merged.

**F. Storage writes merge too (native).** The storage worker's `SAVE_STROKES`/`SAVE_TASKS`/`SAVE_MEDIA` overwrite the stored array with the editor's. A stroke drawn while a sync is saving a merge then drops the other side's elements locally, and the next upload deletes them on the server. With versions the worker merges by element instead of overwriting (same function as A), which closes that window.

**G. Migration.** None (pre-release): an element without `v` counts as the lowest version, one without `seen` as having seen no shift, a note without `shifts` has none. Notes keep their readable JSON; the new fields are plain values.

**H. Tests.**
- Property-based: random edit sequences (draw, erase, part erase, move, insert space, media edits, task edits, text edits) on 2-3 replicas, merged in random orders and groupings; assert convergence and the three algebraic laws.
- Known gap with an app that does not stamp: such an app (before versioned elements) keeps unknown fields when it saves a note, so a stroke it moves keeps its old stamp. Merging that copy with the unmoved one finds two copies with the same stamp and cannot tell which was changed; it keeps the older note's copy. The stroke is never lost or doubled, only its position may be the old one. Everything else an older app does is handled: strokes it adds have no stamp and are kept, strokes it erases (`deletedStrokes` only) stay erased, text edits are merged. Pinned by `nextcloudSync.mixedversion.test.js`, which starts from the older app's output recorded from `main`. Closing it would need a fingerprint of the drawing stored with each stroke.
- Known gap in associativity: an erase, its undo and an edit of the same element on three devices. A merge that meets the erase before the undo drops the element, and with it the third device's newer edit (a deleted element keeps no version). The undo then restores its own older copy. Every grouping still converges once all devices sync, but grouping decides whether that edit survives. Closing this would mean keeping the last copy of every erased element. Pinned by a `KNOWN GAP` test (`noteMerge.property.test.js`), and excluded from the associativity property.
- Intent invariants: nothing disappears unless tombstoned; after an insert space, every element below the line that the shifter had not seen is moved exactly once and nothing above or crossing it is moved; a deleted id never comes back.
- The existing integration tests (both builds) extended with the concurrent move and insert-space scenarios.

**I. Implementation notes (2026-10-18).**
- `src/modules/hlc.js` (clock, device id: native one per installation in `localStorage`, NC one per page load), `src/modules/noteMerge.js` (`mergeNoteParts`, `mergeElements`, `normalize`, `mergeVersionFields`; `attemptMerge` wraps them for the existing callers), `src/modules/noteVersions.js` (`NoteVersioner`: stamping, `assignStackingOrder`, `versionedUpdates`).
- **Stamping is centralized:** instead of every edit path stamping, the editor keeps the state it last took in (`adopt()`: load, live take-in) and, right before each save, stamps whatever differs from it (`stamp()`), new deletions, undone deletions and changed stacking order included. A stroke is compared by its point count, three sample points and its style, so a save while drawing stays cheap. Each save stamps only what it writes (`_SAVE_STAMPS` in NoteCanvas): a field stamped but not sent would let its stored, older value win under the new stamp.
- **Media stacking:** `z` keys are derived from the array order at save time, keeping the longest run already in order and fitting moved items between their neighbours, so a reorder re-keys one item. Items without `z` sort by their position.
- **Storage layers:** `storage.js`/`storage.webdav.js` `updateNote` merge the bookkeeping with what is stored (never replace it) and stamp scalar fields changed without a stamp (a rename outside the editor). The native worker merges every element save (`SAVE_STROKES`/`MEDIA`/`TASKS`/`RECORDINGS`, presets and PDF source by stamp) inside the write transaction for plain notes; an encrypted note's fields are decrypted, merged and re-encrypted before the transaction (a short window remains there). The NC writer merges as before, now through the element merge, whenever someone else wrote.
- **Editor take-in** (`NoteCanvas._takeInNote`) stamps the user's unsaved edits, merges with the stored version through `mergeNoteParts`, and applies the difference (incremental when only strokes arrived). Text stays LiveText's.
- **Local encryption:** `tombstones`, `shifts` and `fieldVersions` are stored unencrypted in the content record (they hold stamps, element ids and shift lines, no note content).
- **Convergence guarantee:** commutative and idempotent always; associative except where two writers inserted space concurrently and an element lies between their lines (the lines are not transformed against each other). Devices still converge, which the property tests check on 150 random histories (1,500 checked once by hand).
- Tasks and recordings keep the older note's order with new ones appended (not part of the convergence guarantee); recognition is dropped as a whole when the merged ink differs from both sides', not per range.

**J. Phases (all done 2026-10-18).**
1. One merge module (A) used by all five call sites, with property tests pinning today's behaviour. No behaviour change; makes the rest safe to change.
2. HLC and device id, `v` on elements and scalar fields, per-element merge (B, C), worker writes merge (F), fresh ids on undo/redo. Fixes reverted moves and insert-space case 1.
3. Shifts and `seen`, normalization (D). Fixes new strokes left behind by an insert space.
4. Media `z` key, recognition invalidation (E).

**Open:** the encoded HLC format and device id storage are fixed in phase 2; the property-test library (fast-check or in-house generator) is chosen in phase 1, subject to the dependency scanner.

## 11. What already exists

- **Per-notebook tombstones** live inside the notebook folder, so owner purges reach recipients unchanged.
- **Per-note `If-Match` optimistic concurrency** and **`attemptMerge`** on native; the NC app build gets them in §10.4.
- **Plaintext wire format** removes the encryption/key-exchange dimension.
- **Chunked uploads** (`uploadFileChunked`) already MOVE into the target path; with `CREATE`/`UPDATE` this works inside a share.

The new engineering is concentrated in **multi-root sync and path resolution (§5)**, **discovery + lifecycle (§7, §8)**, the **NC app registry (§9)** and **merge hardening (§10)**. The rest is UI.

---

## 12. Open risks to validate during build

- **Pending-share variance:** auto-accept vs. explicit acceptance across instance policies (§7.3).
- **Granted vs. requested permissions:** admin policies that strip `CREATE` or force read-only (§3).
- **MOVE race:** brief `{uuid}`-at-root window if the user opens Files before the app syncs; self-correcting.
- **`oc:owner-id` availability** on all supported NC versions for the root guard (§7.4); fallback: OCS `shared_with_me` `file_target == "/NoteBerg"`.
- **Multi-writer merge quality:** two real users editing the same note simultaneously (§10).

---

### Validation status

| Risk | Automated coverage | Still to do by hand |
|---|---|---|
| Pending-share variance (§7.3) | Both policies against the mock instance (`sharedRoots.test.js`) | A real instance with `shareapi_auto_accept_share` off |
| Granted vs. requested permissions (§3) | Admin-reduced permissions, UPDATE without CREATE, permission drop mid-air (`sharedRoots`, `sharedroot`, `sharePermissions` tests) | Edit a share to UPDATE-only in the NC web UI |
| MOVE race (§7.1) | A failed move stays usable via `file_target` and is retried (`sharedRoots.test.js`) | Open Files while a share is being accepted |
| `oc:owner-id` (§7.4) | Present, absent (OCS fallback) and differently-cased owner ids | The oldest supported Nextcloud version |
| Multi-writer merge (§10) | Two interleaved writers on both builds; convergence and idempotency of the text merge; lost-race retries | Two real users editing one note at once, native with native and native with the NC app |

## 13. Decision log

| # | Decision |
|---|---|
| 1 | Unit of sharing = notebook folder via NC native user share. |
| 2 | Read-only = `1`; collab = `7`. No `DELETE`, no `SHARE` (no re-sharing). |
| 3 | Recipients never delete, move or copy notes/notebooks; rename/recolor allowed for collab (§4). |
| 4 | Recipients can leave a share; this removes only their access. |
| 5 | Share-gone requires two signals (OCS + root 404); unsynced changes are frozen with a notice, never copied out. |
| 6 | Recipient folder `/Shared_NoteBerg/{notebookId}` (not the title); path always from OCS `file_target`, percent-encoded per segment in URLs. |
| 7 | Sharing fields are local-only, never uploaded or adopted from the server; absent `origin` = own (no migration). |
| 8 | Path helpers resolve through a base registry; ended shares throw, never fall back to the own tree. |
| 9 | Merge baseline in new `noteBase` store (`DB_VERSION` 6), native only; in memory on the NC app build. |
| 10 | NC app build is fully in scope (sharing + merge-capable write path). |
| 11 | Shared notebooks are excluded from backups. |
| 12 | Elements merge by per-element version (hybrid logical clock), not by note; one merge function for sync, NC writer, editor and storage worker (§10.7). |
| 13 | Delete wins over a concurrent move or part erase of the same stroke (§10.7). |
| 14 | Insert space is recorded as an operation and replayed on elements that had not seen it; strokes crossing the line are not moved (§10.7). |
| 15 | No edit lock and no CRDT library: offline editing must stay; the merge must be right on its own (§10.7). |
| 16 | Undo brings a deleted element back with a `restores` marker naming the deletion it undid, not a fresh id (task links keep working) (§10.7 C). |
