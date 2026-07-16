# Notebook Sharing — Design

Status: **Draft / agreed direction.** No code written yet.
Scope: sharing a **whole notebook** with another Nextcloud user, read-only or full read-write (collab), on **both** build targets (native Tauri and the in-Nextcloud app build).

---

## 1. Goals and non-goals

**Goals**
- Share one notebook (folder) with another NC user.
- Two share modes: **read-only** and **can-edit** (full collab).
- Recipient sees shared notebooks in a dedicated **"Shared with me"** section, clearly separated from their own notebooks.
- Works on both platforms:
  - **NC app build** (`VITE_PLATFORM=nextcloud`): same-origin, uses `window.OC.requestToken` + session cookie.
  - **Native (Tauri)**: stored app-password credentials, Basic auth + `OCS-APIRequest` header against the configured base URL.
- No random `{uuid}` folders left dangling in the recipient's file tree (see §6).

**Non-goals (v1)**
- Sharing individual notes or quick notes (a note is not a self-contained folder in our layout).
- Public link shares / group shares (user shares only for v1).
- Encryption-aware collaboration / key exchange — **not needed**: the sync wire format is always plaintext. `note.encrypted` refers only to a client's *local at-rest* encryption; notes are decrypted before upload (`decryptNoteLocally` in `nextcloudSync.js`). A recipient always reads plaintext JSON. **No guardrail required.**

---

## 2. Why folder-share is the only viable mechanism

Everything for one user lives under a single root `ROOT_FOLDER = "/NoteBerg"` (`storagePaths.js`), scanned with one `PROPFIND Depth:infinity`. You **cannot** share `/NoteBerg` — the recipient would get *all* your notebooks and a second `NoteBerg`-ish folder in their tree that the sync engine can't place.

Therefore the **unit of sharing is a single notebook folder**: `/NoteBerg/notebooks/{notebookId}/`.

Full read-write collaboration requires the recipient to be able to `PUT`/`MKCOL`/`DELETE` inside that folder across accounts. **Only Nextcloud's native folder share grants cross-account write.** An "app-managed manifest" cannot grant filesystem permissions by itself, so it is not an alternative — at most a discovery convenience, and OCS `shared_with_me` already provides discovery. **Decision: Nextcloud native user folder-share, no custom registry file.**

---

## 3. Share modes map directly to NC permission bits

| Mode | NC `permissions` | Recipient sync | Recipient UI |
|---|---|---|---|
| Read-only | `1` (read) | download-only | edit/add/delete affordances hidden |
| Can-edit (collab) | `31` (all) | full bidirectional | full editing |

Read-only vs collab is **not two sync-engine code paths**. It is the same engine, gated by the permission bits NC returns. A read-only recipient's writes would 403; we pre-emptively **gate the UI on the granted permissions** so the engine never attempts an upload it can't make.

**Critical implementation note:** NC splits write into separate bits (`UPDATE=2`, `CREATE=4`, `DELETE=8`, `SHARE=16`). Our media/self-heal paths call `MKCOL` (needs `CREATE`) and note delete needs `DELETE`. When **creating** a collab share we request the full set (`31`). When **receiving** a share we **read back the actually-granted `permissions`** and gate accordingly — a share granted `UPDATE` but not `CREATE` would 403 on `MKCOL` in confusing ways. This is the most likely source of "why won't it sync" bugs.

**Delete semantics** follow the mode: a can-edit recipient participates in the normal tombstone flow, so their deletions propagate to everyone (owner included). This is the accepted collab contract. Read-only recipients cannot delete (NC-enforced + UI-gated).

---

## 4. The one hard architectural change: multi-root sync

Today every path derives from the constant `ROOT_FOLDER`, and `fullSync` scans exactly one tree.

A shared-in notebook lives at an **arbitrary path outside `/NoteBerg`** (wherever NC mounts it / wherever we normalize it to — see §6). Its folder *is* the notebook folder — there is no `notebooks/{id}` prefix.

### 4.1 Notebook record gains fields

```
origin:          "own" | "shared"        // threads through path + delete semantics
remoteBasePath:  string                  // own → "/NoteBerg/notebooks/{id}";  shared → post-normalize mount path
ownerUid:        string | null           // display + disambiguation (shared only)
sharePermissions: number | null          // NC permission bits as granted (shared only)
shareId:         string | null           // OCS share id (shared only), for unshare detection
normalized:      boolean                 // shared only: MOVE into tidy folder already done (§6)
```

### 4.2 `storagePaths` helpers take a base path

`getNotePath`, `getNoteMediaFolder`, `getMediaPath`, and the tombstone helpers must accept the notebook's `remoteBasePath` instead of computing `${ROOT_FOLDER}/notebooks/${id}`. For own notebooks the base is computed exactly as today (behavior-preserving); for shared notebooks the base is the stored mount path. `assertSafeId` / `assertSafeFilename` discipline is retained for the *leaf* segments; the base path for a shared notebook comes from OCS (trusted server response) but is still length/character sanitized before use in a URL.

### 4.3 `fullSync` runs once per root

- **N+1 independent passes:** one `PROPFIND Depth:infinity` on `/NoteBerg` (own tree) + one per shared notebook root.
- Each shared-root pass is **wrapped so a failure is logged and skipped** — a broken/removed share must never abort the user's own `/NoteBerg` sync.
- Isolation is worth the extra round-trips; no batching. (Even a user in ~50 shared notebooks is 51 periodic PROPFINDs — acceptable, and failures stay contained.)

### 4.4 The dangerous asymmetry: "missing on remote"

For an **own** notebook missing remotely, the engine self-heals by **re-uploading** (`nextcloudSync.js` ~L1975-1980). For a **shared** notebook, "missing on remote" means **the share was revoked or the owner deleted it** — re-uploading would be wrong (it would try to recreate the owner's content at the wrong path). The `origin` flag **must** gate this branch:

| Situation | `own` notebook | `shared` notebook |
|---|---|---|
| Missing on remote, local clean | re-upload (self-heal) | **forget locally, no tombstone** (§7) |
| Missing on remote, local modified | restore (re-upload) | **forget locally** — cannot restore into someone else's tree; surface a "share ended, unsynced local edits" notice |

This is the single most important correctness point in the whole feature.

---

## 5. OCS layer (both platforms)

New thin module (proposed `nextcloudShares.js`) wrapping OCS. Two auth strategies behind one interface:

- **NC app build:** same-origin `fetch`, headers `OCS-APIRequest: true`, `requesttoken: window.OC.requestToken`, `credentials: "same-origin"`. Mirrors the existing pattern in `storage.webdav.js`.
- **Native (Tauri):** absolute URL against configured base, `Authorization: Basic ...` from stored app-password credentials, `OCS-APIRequest: true`. Reuses whatever credential store `nextcloudSync.js` already uses.

Endpoints:

| Purpose | Call |
|---|---|
| Search users to share with | `GET ocs/v2.php/apps/files_sharing/api/v1/sharees?search=...&itemType=folder&perPage=...` |
| Create share | `POST ocs/v2.php/apps/files_sharing/api/v1/shares` (`shareType=0`, `path`, `shareWith`, `permissions`) |
| List shares I created (for a notebook) | `GET .../shares?path={notebookFolder}` |
| List shares to me | `GET .../shares?shared_with_me=true` |
| Accept a pending share | `POST .../shares/pending/{id}` |
| Update permissions | `PUT .../shares/{id}` |
| Revoke | `DELETE .../shares/{id}` |

**User listing is search-only.** NC deliberately restricts `sharees` (requires a query; admins may limit to same-group). The UI is a **type-to-search autocomplete**, not a full user dropdown — this is the native NC pattern.

---

## 6. Recipient folder placement — no dangling `{uuid}` folders

The sharer cannot dictate where the mount lands; placement is the recipient's. Three levers:

1. **`share_folder` (server-wide, admin-only)** — document as an optional admin nicety, **do not rely on it.**
2. **MOVE after acceptance (client-controlled) — our real tool.** An accepted share is a normal mount point and can be `MOVE`d via WebDAV; NC persists the new `file_target`, so it does **not** reappear at root. On first discovery of a share the recipient app:
   1. `MKCOL /NoteBerg_SharedWithMe/` (ignore 405).
   2. `MOVE` the `{uuid}` mount → `/NoteBerg_SharedWithMe/{ownerUid}_{safeTitle}/` (disambiguate with a short id on collision; `assertSafeFilename` discipline).
   3. Record `remoteBasePath` = the new path, set `normalized: true` so we never MOVE again.
3. **Address by OCS `file_target`, never by scanning (safety net).** Sync always uses the OCS-reported path, so a not-yet-normalized share is still fully usable; the MOVE is purely cosmetic. If the MOVE fails or races (user opened Files web UI first), sync still works and it self-corrects next pass.

**Recipient discovery sequence:** list `shared_with_me` → accept any pending → MOVE/normalize (once) → register as `origin:"shared"` notebook with its `remoteBasePath`, `ownerUid`, `sharePermissions`, `shareId`.

---

## 7. Share lifecycle transitions (new code paths)

| Transition | Owner side | Recipient side |
|---|---|---|
| **Share created** | create OCS share (perms per mode); notebook shows a "shared" badge + recipient list | on discovery: accept → normalize → register in "Shared with me" |
| **Permissions changed** | `PUT shares/{id}` | re-read granted perms, re-gate UI (e.g. collab→read-only disables editing) |
| **Unshared / revoked** | `DELETE shares/{id}` | share vanishes from `shared_with_me` → **forget the local notebook (remove from view), do NOT tombstone/delete the notes** — they still live in the owner's `/NoteBerg`. New path: "remote gone but not deleted." |
| **Owner deletes the whole notebook** | normal own-notebook delete flow (tombstone in owner tree) | share also disappears → same "forget, don't tombstone" path. (Recipient loses access either way; no attempt to preserve.) |

The recipient "forget-not-delete" path is genuinely new: today sync only knows "remote deleted → delete local." We add "remote gone for a `shared` notebook → drop the local shadow, leave no tombstone."

---

## 8. Assets we already have (why this is smaller than it looks)

- **Per-notebook tombstones** and **per-note `If-Match` optimistic concurrency** are already notebook-scoped — they keep working *within* a shared folder, now across users, and the existing retry loop already tolerates concurrent writers.
- **`attemptMerge`** already handles field-level merges — for collab it moves from "rare same-user safety net" to "load-bearing," but the machinery exists.
- **Plaintext wire format** removes the entire encryption/key-exchange dimension.

The genuinely new engineering is concentrated in **multi-root sync (§4)** and the **share lifecycle + OCS layer (§5, §7)**. Everything else is additive UI.

---

## 9. Open risks to validate during build

- **Pending-share variance:** some instances auto-accept user shares, others require `POST shares/pending/{id}`. Discovery must handle both.
- **Permission-bit gating:** must read *granted* perms, not requested; `CREATE` vs `UPDATE` split (§3).
- **MOVE race:** brief `{uuid}`-at-root window if user opens Files UI before app syncs; acceptable, self-correcting.
- **Native CORS/host:** confirm OCS endpoints reachable with app-password Basic auth from Tauri (should match existing WebDAV path, but verify).
- **Multi-writer merge quality:** exercise two-user simultaneous edits against `attemptMerge` for real, not just multi-device.
