# Plan: Nextcloud Sync Integration Test Suite

**Status:** Proposed
**Created:** 2026-07-10
**Scope:** `src/modules/nextcloudSync.js` (2502 lines) — the most complex module in the app.

## Goal

Provide comprehensive integration test coverage for Nextcloud sync by driving the
**real** sync functions (`fullSync`, `syncNotes`, `downloadAllData`, `attemptMerge`,
`hasRemoteChanges`) against a high-fidelity, reusable WebDAV mock server. Close the
current coverage gaps and add multi-device / multi-cycle scenarios that only an
integration-style test can express.

## Guiding principle

Test at the `_fetch` → `@tauri-apps/plugin-http` seam. Every HTTP request in
`nextcloudSync.js` flows through `const _fetch = _tauriFetch` (line 57), which is
already the boundary the existing test mocks via `vi.mock("@tauri-apps/plugin-http")`.
**No source changes to `nextcloudSync.js` are planned.**

## Current state

`src/modules/nextcloudSync.test.js` (~2500 lines) is already effectively an
integration test: it drives real `fullSync`/`syncNotes`/`attemptMerge` against an
inlined stateful `MockWebDAVServer` (~170 lines). It is strong on merge / conflict /
412-recovery / tombstone / etag-oscillation paths.

### Problems

1. **Coverage gaps** — these exported functions are never exercised directly:
   `testConnection`, `listFiles`, `listFolders`, `hasRemoteChanges`,
   `uploadTombstone`, `downloadTombstone`, `getStoredCredentials`,
   `clearCredentials`, `migrateCredentials`.
   `hasRemoteChanges` is the change-detection gate the whole auto-sync system
   depends on, yet it is only tested indirectly in `autoSync.test.js` with
   `nextcloudSync` **fully mocked**.
2. **Mock server isn't reusable** — inlined in one file; any new sync test file
   would copy-paste it and the copies would drift.
3. **Uneven mock fidelity** — some behaviors are faked/hardcoded (random etags, no
   network-error / 429 / 503 / partial-write simulation). These are exactly the
   failure modes that break real sync.

### Decisions locked

- **Test file layout:** Extract the mock server into a shared fixture, then split
  the existing monolith into focused files.
- **Mock fidelity:** Full WebDAV fidelity (PROPFIND pagination, partial writes,
  Depth quirks, quota/507, lock tokens, fault injection).
- **hasRemoteChanges:** Test it directly against the real WebDAV mock.

## Phases

### Phase 1 — Extract & build a full-fidelity WebDAV mock fixture

**New file:** `src/modules/__fixtures__/mockWebDAVServer.js`

1. Lift the existing `MockWebDAVServer` out of `nextcloudSync.test.js` verbatim;
   repoint the existing test's import at it.
   **Checkpoint: full suite stays green** — proves byte-for-byte parity before
   adding anything.
2. Raise fidelity to full WebDAV behavior:
   - **Deterministic seeded etags** (monotonic counter, not `Math.random`) so tests
     assert exact etag values and request counts.
   - **Fault injection:** `server.failNext({ method, pathMatch, status })` and
     `server.failEvery(...)` for `412 / 423 Locked / 500 / 503 + Retry-After /
     network-throw`.
   - **PROPFIND realism:** `Depth: 0/1/infinity` with a per-server toggle to reject
     `infinity` (400) exercising the real fallback walk; multistatus with mixed
     200/404 propstats; pagination-style large-folder responses.
   - **Write semantics:** `If-Match`/`If-None-Match` precondition eval,
     `507 Insufficient Storage`, partial-write / interrupted-PUT simulation,
     lock-token / `423` on concurrent PUT.
   - **Request log** (`server.requests[]`) so tests assert
     "incremental sync issued exactly N GETs / 1 PROPFIND."
   - **Seed DSL:** `seedNotebook`, `seedNote`, `seedQuickNote`, `seedTombstone`,
     `seedMedia` — collapses the repetitive 4-line folder setup.
3. Fidelity validated by construction: existing ~40 tests must keep passing against
   the hardened mock (they encode the correct WebDAV contract), plus new low-level
   tests asserting the new behaviors (fault injection fails, etags deterministic).

### Phase 2 — Split the existing monolith into focused files

Using the shared fixture, reorganize `nextcloudSync.test.js` into:

- `nextcloudSync.auth.test.js` — login flow, `isAuthenticated`, `testConnection`,
  credential lifecycle (`getStoredCredentials` / `clearCredentials` /
  `migrateCredentials`).
- `nextcloudSync.propfind.test.js` — `listFiles` / `listFolders`, Depth fallback,
  `&quot;` etag parsing, PROPFIND edge cases.
- `nextcloudSync.conflict.test.js` — `attemptMerge` + conflict / etag-oscillation /
  stale-fork scenarios.
- `nextcloudSync.media.test.js` — media upload, orphan cleanup, encrypted-media,
  merge.
- `nextcloudSync.migration.test.js` — flat→hierarchical, `needsMigration`,
  `cleanupLegacyFiles`.
- `nextcloudSync.tombstone.test.js` — `uploadTombstone` / `downloadTombstone`
  standalone, 412-retry, corrupted-tombstone preservation.

Each moved test keeps its assertions unchanged — mechanical move, verified green
after each file.

### Phase 3 — New coverage: untested exports

- **`hasRemoteChanges` (direct)** — new `nextcloudSync.changedetection.test.js`
  against the real mock: no-change→false, remote etag drift→true, new remote
  file→true, remote deletion→true, notebook-scoped vs quick-notes
  (`notebookId: null`), and a request-count assertion (change detection must be a
  cheap PROPFIND, not a full download). Closes the gap where it's currently only
  tested with `nextcloudSync` fully mocked.
- `testConnection`, `listFiles`, `listFolders`, `uploadTombstone`,
  `downloadTombstone` — direct tests (some absorbed into Phase 2 files).

### Phase 4 — Multi-device / multi-cycle integration scenarios

**New file:** `nextcloudSync.integration.test.js` — each test drives A→B→A cycles
against one shared server:

1. Two devices, different strokes, same note → converge, no loss, over 2 cycles.
2. Delete-on-A vs edit-on-B → tombstone / restore resolution.
3. Notebook purge on A while note edited on B.
4. Media added on A, note edited on B → media survives merge.
5. **Network failure mid-sync** (fault injection) → next cycle recovers, no
   partial/corrupt state, no lost strokes on either side.
6. `503 + Retry-After` and `423 Locked` → retry / back-off behavior (if source
   retries) or clean failure + next-cycle recovery (if it doesn't) — the test
   documents actual behavior.
7. Encryption enabled → encrypted blobs round-trip; assert the server content is
   never plaintext.

## Deliverables & sequencing

Each phase is independently reviewable and leaves the suite green. Run `npm test`
(and `test:nextcloud` if the fixture ends up shared with those) after each.

1. Fixture extracted, existing tests repointed, suite green. *(checkpoint)*
2. Fixture hardened to full fidelity + fixture self-tests green. *(checkpoint)*
3. Monolith split into focused files, all green. *(checkpoint)*
4. New `hasRemoteChanges` + untested-export coverage. *(checkpoint)*
5. Multi-device integration scenarios. *(checkpoint)*

## Risks / notes

- **Full-fidelity mock is the bulk of the effort** — the fixture will be ~400–600
  lines. Payoff: every future sync test reuses it. Fidelity additions stay behind
  opt-in APIs so simple tests stay simple.
- **Preserve every existing assertion** during the split; no test loses coverage in
  the reorg.
- **Retry / back-off** (503 / `Retry-After`) will be **tested as-observed** — if the
  source doesn't retry, the test asserts clean failure + recovery rather than
  inventing behavior. Flag any place where observed behavior looks like a latent bug
  rather than encoding it as "correct."
- No source changes to `nextcloudSync.js` planned. If a seam turns out to need it
  (unlikely given `_fetch`), surface it before touching source.

## Reference: exported surface & current direct-test coverage

| Function | Called in existing test |
|---|---|
| `migrateCredentials` | 0 |
| `getStoredCredentials` | 0 |
| `clearCredentials` | 0 |
| `isAuthenticated` | 3 |
| `testConnection` | 0 |
| `startLoginFlow` | 2 |
| `listFiles` | 0 |
| `hasRemoteChanges` | 0 |
| `listFolders` | 0 |
| `syncNotebooks` | 2 |
| `syncNotes` | 6 |
| `downloadAllData` | 3 |
| `attemptMerge` | 7 |
| `fullSync` | 22 |
| `deleteRemoteNotebook` | 3 |
| `deleteRemoteNote` | 5 |
| `uploadTombstone` | 0 |
| `downloadTombstone` | 0 |
| `migrateToHierarchical` | 2 |
| `needsMigration` | 2 |
| `cleanupLegacyFiles` | 2 |
