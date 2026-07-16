# Notebook Sharing — Implementation Plan

Companion to [DESIGN.md](./DESIGN.md). Ordered so each phase is independently testable and merges without breaking existing single-user sync.

Guiding rule: **behavior for own notebooks must be byte-for-byte unchanged** until the sharing UI is deliberately used. Multi-root and record-field changes are introduced as no-ops for `origin:"own"` first.

---

## Phase 0 — Multi-platform + test baseline (no behavior change)

1. Snapshot: run the existing Nextcloud sync test suite (`vitest.config.nextcloud.js`) and record green baseline.
2. Confirm the plaintext-wire assumption in code (already verified: `decryptNoteLocally` runs before upload).

**Exit:** baseline green; no source changes.

---

## Phase 1 — Path abstraction (own-only, pure refactor)

Make paths derive from a per-notebook **base path** without changing any output for own notebooks.

- `storagePaths.js`: add `getNotebookBasePath(notebook)` returning `${ROOT_FOLDER}/notebooks/${id}` for own notebooks. Refactor `getNotePath`, `getNoteMediaFolder`, `getMediaPath`, `getNotebookTombstonePath` to accept a base (with a back-compat overload that computes the own-base from an id, so existing callers don't break in one commit).
- Keep `parsePath` working for the own tree.
- Update `storagePaths.test.js` to assert the base-path form produces identical strings to today for own notebooks.

**Exit:** all path tests green; produced paths identical for own notebooks. **No feature yet.**

---

## Phase 2 — Notebook record fields (dormant)

- Add `origin`, `remoteBasePath`, `ownerUid`, `sharePermissions`, `shareId`, `normalized` to the notebook record (default `origin:"own"`, others null/false) in `storage.js` (and `storage.webdav.js` shape).
- Migration: existing notebooks default to `origin:"own"`; `remoteBasePath` computed lazily from id when absent.
- `fullSync` and `storagePaths` read `remoteBasePath` when present, else fall back to computed own-base.

**Exit:** fields persist round-trip; existing notebooks behave as before (treated as `own`).

---

## Phase 3 — OCS layer (`nextcloudShares.js`)

New module, no UI yet, unit-tested against a mock OCS server (extend the `__fixtures__` mock pattern used for WebDAV).

- Two auth strategies behind one `ocsFetch()` (cookie/`requesttoken` for NC build; Basic app-password for Tauri), selected by `VITE_PLATFORM`.
- Functions: `searchSharees(query)`, `createShare(path, shareWith, permissions)`, `listSharesForPath(path)`, `listSharedWithMe()`, `acceptPendingShare(id)`, `updateSharePermissions(id, perms)`, `revokeShare(id)`.
- Parse OCS XML/JSON envelope; surface `permissions` (granted) explicitly.

**Exit:** module unit-tested (search, create, list-mine, list-to-me, accept, update, revoke) against mock; both auth header shapes covered.

---

## Phase 4 — Multi-root `fullSync` (own tree unchanged)

- Refactor the top of `fullSync`/`performSync` to iterate **roots**: `[ownRoot, ...sharedRoots]`. With zero shared notebooks this is exactly today's single pass.
- Each shared-root pass wrapped in try/catch: failure logged, skipped, never aborts the own pass.
- Thread `remoteBasePath` through classification, upload, download, media, tombstones.
- **Gate the "missing on remote" branch on `origin`** (DESIGN §4.4): own → self-heal/re-upload; shared → forget-not-delete (Phase 6 wires the actual forget).

**Exit:** with no shares, sync behavior and tests identical to Phase 0 baseline. A hand-registered fake shared root syncs in isolation in a new test.

---

## Phase 5 — Owner-side sharing UI

- In notebook context/overview: "Share…" action → type-to-search sharee autocomplete (`searchSharees`), pick user, pick mode (read-only / can-edit), `createShare` with `1` or `31`.
- Show current recipients + their permissions for a shared notebook; allow change (`updateSharePermissions`) and revoke (`revokeShare`).
- "Shared" badge on owned-and-shared notebooks.

**Exit:** owner can share/list/change/revoke against a real test instance; folder share visible in NC.

---

## Phase 6 — Recipient discovery, normalize, "Shared with me"

- Discovery pass (runs with sync): `listSharedWithMe()` → accept pending → MOVE-normalize once into `/NoteBerg_SharedWithMe/{ownerUid}_{safeTitle}/` (set `normalized`, `remoteBasePath`) → register as `origin:"shared"` notebook.
- **"Shared with me"** section in overview, visually distinct (owner name, shared badge).
- **UI gating on granted `sharePermissions`**: read-only hides add/edit/delete; collab full.
- **Forget-not-delete**: share absent from `shared_with_me` → remove local shadow, **no tombstone**; if it had unsynced local edits, surface a non-destructive "share ended" notice.

**Exit:** recipient sees shared notebooks tidily; read-only is view-only (no 403 loops); revoke/owner-delete cleanly forgets without resurrecting or destroying owner content.

---

## Phase 7 — Collab hardening

- Exercise **two real users editing the same note simultaneously** against `attemptMerge` (not just multi-device).
- Verify `CREATE` vs `UPDATE` permission split: collab recipient adding media/notes hits `MKCOL` successfully; a `UPDATE`-only share degrades gracefully.
- Pending-share variance across instance policies.
- Native (Tauri) OCS reachability with app-password Basic auth + CORS.

**Exit:** DESIGN §9 risks each have a passing test or a documented, accepted limitation.

---

## Test strategy

- Extend the existing mock-server fixtures (`src/modules/__fixtures__/`) with an OCS mock and multi-root WebDAV.
- New suites: `nextcloudShares.test.js` (OCS), `nextcloudSync.sharedroot.test.js` (multi-root classification incl. forget-not-delete), `storagePaths.sharedbase.test.js`.
- Per project convention: mocks model real NC/WebDAV behavior; tests assert requirements; no can't-fail tests.
- Every phase re-runs the Phase 0 baseline to prove own-notebook behavior is unchanged.

## Multi-platform checklist (per DESIGN, every phase)

- **NC app build** (`VITE_PLATFORM=nextcloud`): OCS via cookie + requesttoken.
- **Native Tauri (Windows + Android)**: OCS via app-password Basic auth; MOVE/PROPFIND against configured base URL.
- Verify UI gating and "Shared with me" render on both.

---

## Suggested commit boundaries

Phases 1, 2, 3, 4 are each a safe standalone commit (no user-visible change). 5, 6, 7 are the feature-visible commits. This keeps the risky multi-root refactor (4) bisectable and separate from UI.
