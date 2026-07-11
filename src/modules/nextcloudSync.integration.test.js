/**
 * src/modules/nextcloudSync.integration.test.js
 * Phase 4 — Multi-device / multi-cycle integration scenarios.
 *
 * Each test drives fullSync in an A -> B -> A (or similar) cycle pattern against
 * ONE shared MockWebDAVServer instance, simulating two devices that sync at
 * different times against the same Nextcloud account.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { decryptObject } from "./encryption.js";
import { getEncryptionKey, isAppUnlocked } from "./masterPassword.js";
import { fullSync } from "./nextcloudSync.js";
import { saveNote } from "./storage.js";

// --- Mocks ---

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));

vi.mock("./encryption.js", () => ({
  decryptObject: vi.fn(),
}));

const mockSecureStorage = new Map();
vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn((key, value) => {
    mockSecureStorage.set(key, value);
    return Promise.resolve();
  }),
  getSecureCredential: vi.fn((key) => {
    return Promise.resolve(mockSecureStorage.get(key) || null);
  }),
  deleteSecureCredential: vi.fn((key) => {
    mockSecureStorage.delete(key);
    return Promise.resolve();
  }),
}));

// In-memory note store for tests — getNote/getRawNote read from here
const mockNoteStore = new Map();

vi.mock("./storage.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveFile: vi.fn(() => Promise.resolve("file-id")),
    getFile: vi.fn(() => Promise.resolve(new Blob(["test"], { type: "text/plain" }))),
    checkFileExists: vi.fn(() => Promise.resolve(false)),
    deleteFile: vi.fn(() => Promise.resolve()),
    permanentlyDeleteNote: vi.fn(),
    permanentlyDeleteNotebook: vi.fn(),
    permanentlyDeleteNotesInNotebook: vi.fn(),
    getSetting: vi.fn(() => Promise.resolve(null)),
    getStorageVersion: vi.fn(() => Promise.resolve(1)),
    isLocalEncryptionEnabled: vi.fn(() => Promise.resolve(false)),
    initStorage: vi.fn(() => Promise.resolve()),
    updateNote: vi.fn(() => Promise.resolve()),
    saveNote: vi.fn(() => Promise.resolve()),
    getNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
    getRawNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
  };
});

describe("Nextcloud Sync Integration (multi-device / multi-cycle)", () => {
  let mockServer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureStorage.clear();
    mockNoteStore.clear();
    mockServer = new MockWebDAVServer();
    wireMockServer(fetch, mockServer);

    mockSecureStorage.set(
      "nextcloud_credentials",
      JSON.stringify({
        serverUrl: "https://cloud.example.com",
        loginName: "testuser",
        appPassword: "app-password-123",
      }),
    );
  });

  it("scenario 1: two devices with different strokes on the same note converge over 2 cycles, no loss", async () => {
    const noteId = "n-two-device";
    const notebookId = "nb1";

    // Device A: has stroke S1 only, never synced this note before.
    const deviceANote = {
      id: noteId,
      notebookId,
      strokes: [{ id: "s1", time: [100], x: [1], y: [1] }],
      deletedStrokes: [],
      version: 1,
      modified: 1000,
      synced: false,
    };

    // Device B: independently has stroke S2 only (different local array —
    // simulating a second device that started from the same blank note).
    const deviceBNote = {
      id: noteId,
      notebookId,
      strokes: [{ id: "s2", time: [200], x: [2], y: [2] }],
      deletedStrokes: [],
      version: 1,
      modified: 1500,
      synced: false,
    };

    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;

    // The notebook folder chain exists on the server (the notebook was synced
    // before its notes, as in real usage — a note is never uploaded into a
    // notebook that has never been created).
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });

    // --- Cycle 1: Device A syncs first, creating the note on the server ---
    const resultA1 = await fullSync([], [{ ...deviceANote }]);
    expect(resultA1.uploaded.notes.uploaded).toBe(1);
    expect(mockServer.files.has(notePath)).toBe(true);
    const afterA1 = JSON.parse(mockServer.files.get(notePath).content);
    expect(afterA1.strokes.map((s) => s.id)).toEqual(["s1"]);

    // --- Cycle 2: Device B syncs against the now-updated server. B's local
    // view only has S2 and no lastSyncedEtag (stale/absent) — merge path fires.
    mockNoteStore.set(noteId, { ...deviceBNote });
    const resultB = await fullSync([], [{ ...deviceBNote }]);
    expect(resultB.uploaded.notes.uploaded).toBe(1);
    expect(resultB.conflicts.notes).toHaveLength(0);

    const mergedByB = saveNote.mock.calls.find((c) => c[0]?.id === noteId)?.[0];
    expect(mergedByB).toBeDefined();
    expect(mergedByB.strokes.find((s) => s.id === "s1")).toBeTruthy();
    expect(mergedByB.strokes.find((s) => s.id === "s2")).toBeTruthy();

    const afterB = JSON.parse(mockServer.files.get(notePath).content);
    expect(afterB.strokes.find((s) => s.id === "s1")).toBeTruthy();
    expect(afterB.strokes.find((s) => s.id === "s2")).toBeTruthy();

    // --- Cycle 3: Device A syncs again (second cycle) with its stale local
    // view (still only S1, old etag) — should download/merge in S2 too.
    saveNote.mockClear();
    const resultA2 = await fullSync([], [{ ...deviceANote }]);

    // Either a merge-and-upload or a plain download could occur depending on
    // etag/version comparison — assert the end state has both strokes, which
    // is the invariant that matters: no stroke lost across the 2-cycle converge.
    const finalServerState = JSON.parse(mockServer.files.get(notePath).content);
    expect(finalServerState.strokes.find((s) => s.id === "s1")).toBeTruthy();
    expect(finalServerState.strokes.find((s) => s.id === "s2")).toBeTruthy();

    // Device A's local copy (via saveNote, if a merge/download path called it)
    // or its own already-correct upload must also reflect both strokes.
    if (saveNote.mock.calls.length > 0) {
      const aFinal = saveNote.mock.calls.find((c) => c[0]?.id === noteId)?.[0];
      expect(aFinal.strokes.find((s) => s.id === "s1")).toBeTruthy();
      expect(aFinal.strokes.find((s) => s.id === "s2")).toBeTruthy();
    } else {
      // No merge call needed — A's upload attempt must not have been a no-op
      // that regresses the server; already asserted server state above.
      expect(resultA2.downloaded.notes.some((n) => n.id === noteId)).toBe(true);
    }
  });

  it("scenario 2: delete-on-A vs edit-on-B — locally-modified item restored after real 2-device round trip", async () => {
    const noteId = "n-delete-vs-edit";
    const notebookId = "nb1";
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;
    const tombstonePath = `/NoteBerg/notebooks/${notebookId}/_tombstones.json`;

    // Seed the note as already existing/synced on the server (both devices
    // had it before this round).
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(notePath, {
      content: JSON.stringify({
        id: noteId,
        notebookId,
        content: "Original",
        modified: 1000,
      }),
      etag: "etag-original",
      mtime: new Date(1000),
    });

    // --- Device A: deletes the note (purged locally) and syncs first. ---
    const deviceANote = {
      id: noteId,
      notebookId,
      purged: true,
      deleted: true,
      synced: false,
    };
    const resultA = await fullSync([], [{ ...deviceANote }]);
    // A's delete should remove the remote file and create a tombstone entry.
    expect(mockServer.files.has(notePath)).toBe(false);
    expect(mockServer.files.has(tombstonePath)).toBe(true);
    const tombstoneAfterA = JSON.parse(mockServer.files.get(tombstonePath).content);
    expect(tombstoneAfterA.notes.some((n) => n.id === noteId)).toBe(true);
    void resultA;

    // --- Device B: unaware of the deletion, edited the same note locally. ---
    const deviceBNote = {
      id: noteId,
      notebookId,
      content: "Edited on B, unaware of delete",
      modified: 2000,
      synced: false,
      deleted: false,
    };
    const resultB = await fullSync([], [{ ...deviceBNote }]);

    // Documented existing behavior (see nextcloudSync.conflict.test.js's
    // "should restore locally modified item if deleted remotely" test): a
    // locally-modified item that was deleted remotely gets RESTORED, not
    // silently deleted. Verify this holds after a genuine two-device round trip.
    expect(resultB.uploaded.notes.uploaded).toBe(1);
    expect(mockServer.files.has(notePath)).toBe(true);
    const restored = JSON.parse(mockServer.files.get(notePath).content);
    expect(restored.content).toBe("Edited on B, unaware of delete");
  });

  it("scenario 3: notebook purge on A while a note inside it is edited on B", async () => {
    const notebookId = "nb-purge-vs-edit";
    const noteId = "n-inside-purged-nb";
    const nbPath = `/NoteBerg/notebooks/${notebookId}`;
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;
    const nbTombstonePath = "/NoteBerg/notebooks/_tombstones.json";

    // Seed remote notebook + note (both devices had synced this before).
    mockServer.files.set(nbPath, { isCollection: true, mtime: new Date() });
    mockServer.files.set(`${nbPath}/_notebook.json`, {
      content: JSON.stringify({ id: notebookId, title: "To be purged", modified: 1000 }),
      etag: "etag-nb-1",
      mtime: new Date(1000),
    });
    mockServer.files.set(`${nbPath}/notes`, { isCollection: true, mtime: new Date() });
    mockServer.files.set(notePath, {
      content: JSON.stringify({ id: noteId, notebookId, content: "Original", modified: 1000 }),
      etag: "etag-note-1",
      mtime: new Date(1000),
    });

    // --- Device A: purges the whole notebook. ---
    const deviceANotebook = {
      id: notebookId,
      title: "To be purged",
      purged: true,
      deleted: true,
      synced: false,
    };
    await fullSync([{ ...deviceANotebook }], []);

    // Notebook folder gone entirely, tombstoned.
    expect(mockServer.files.has(nbPath)).toBe(false);
    expect(mockServer.files.has(nbTombstonePath)).toBe(true);
    const nbTombstone = JSON.parse(mockServer.files.get(nbTombstonePath).content);
    expect(nbTombstone.notebooks.some((n) => n.id === notebookId)).toBe(true);

    // --- Device B: unaware of the purge, edits the note inside NB and syncs. ---
    const deviceBNote = {
      id: noteId,
      notebookId,
      content: "Edited on B inside purged notebook",
      modified: 2000,
      synced: false,
    };
    const resultB = await fullSync([], [{ ...deviceBNote }]);

    // Correct behavior (data preservation): B's local notebook record was never
    // told about the purge — B synced only the note, so fullSync attempts to
    // upload the edited note into the (now deleted) notebook/notes folder.
    // On a real WebDAV server a PUT into a missing parent collection returns
    // 409 Conflict, so the upload FAILS. The critical invariant is that B's
    // edit must NOT be silently lost: the upload is reported as failed (not a
    // phantom success) and B's note stays synced=false so the next cycle can
    // retry once the notebook structure is re-established.
    expect(resultB.uploaded.notes.uploaded).toBe(0);
    expect(resultB.uploaded.notes.failed).toBe(1);

    // The purged notebook folder must NOT be silently resurrected by an
    // orphaned note upload — the note file did not land on the server.
    expect(mockServer.files.has(notePath)).toBe(false);

    // B's edit is preserved locally for retry: fullSync must not have recorded
    // this note as an uploaded/converged item, and it is not in any downloaded
    // or conflict bucket (there is no remote counterpart to conflict with).
    expect(resultB.uploaded.notes.uploadedIds ?? []).not.toContain(noteId);
    expect(resultB.conflicts.notes.some((c) => c.local?.id === noteId)).toBe(false);
    expect(resultB.downloaded.notes.some((n) => n.id === noteId)).toBe(false);
  });

  it("scenario 4: media added on A survives a non-media edit merge on B", async () => {
    const noteId = "n-media-survive";
    const notebookId = "nb1";
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;
    const fileId = "media-file-1";

    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });

    // --- Device A: adds media to note N and syncs. ---
    const deviceANote = {
      id: noteId,
      notebookId,
      title: "Note with media",
      content: "Original content",
      media: [{ id: "m1", fileId, type: "image" }],
      deletedMedia: [],
      modified: 1000,
      synced: false,
    };
    const resultA = await fullSync([], [{ ...deviceANote }]);
    expect(resultA.uploaded.notes.uploaded).toBe(1);
    expect(
      mockServer.files.has(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}_media/${fileId}.bin`),
    ).toBe(true);
    const afterA = JSON.parse(mockServer.files.get(notePath).content);
    expect(afterA.media.some((m) => m.id === "m1")).toBe(true);

    // --- Device B: working from an older local copy without the media
    // reference, edits the note's title/content only and syncs. Its stale
    // lastSyncedEtag forces the merge path. Content is a superset of the
    // remote (A's) content so the substring-containment heuristic in
    // attemptMerge treats this as auto-mergeable rather than a true conflict
    // (attemptMerge returns null — a real conflict — if neither side's
    // content contains the other's and they differ).
    const deviceBFull = {
      id: noteId,
      notebookId,
      title: "Edited title on B",
      content: "Original content, expanded by B",
      media: [], // B never had the media
      deletedMedia: [],
      modified: 2000,
      synced: false,
      lastSyncedEtag: "stale-etag-before-a-synced",
    };
    mockNoteStore.set(noteId, { ...deviceBFull });
    const resultB = await fullSync([], [{ ...deviceBFull }]);

    expect(resultB.conflicts.notes).toHaveLength(0);
    expect(resultB.uploaded.notes.uploaded).toBe(1);

    const mergedByB = saveNote.mock.calls.find((c) => c[0]?.id === noteId)?.[0];
    expect(mergedByB).toBeDefined();
    // Media added by A must not be dropped by B's merge.
    expect(mergedByB.media.some((m) => m.id === "m1")).toBe(true);

    const afterB = JSON.parse(mockServer.files.get(notePath).content);
    expect(afterB.media.some((m) => m.id === "m1")).toBe(true);
    // The media binary itself must still be present on the server.
    expect(
      mockServer.files.has(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}_media/${fileId}.bin`),
    ).toBe(true);
  });

  it("scenario 5: network failure mid-sync recovers cleanly on the next cycle, no data loss", async () => {
    const noteId = "n-network-fail";
    const notebookId = "nb1";
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;

    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });

    const localNote = {
      id: noteId,
      notebookId,
      content: "Content to upload",
      strokes: [{ id: "s1", x: [1], y: [1] }],
      deletedStrokes: [],
      modified: 1000,
      synced: false,
    };

    // Fault: the PUT for this note throws a network error once.
    mockServer.failNext({ method: "PUT", pathMatch: `${noteId}.json`, throws: true });

    const result1 = await fullSync([], [{ ...localNote }]);
    expect(result1.uploaded.notes.uploaded).toBe(0);
    expect(result1.uploaded.notes.failed).toBe(1);
    // Nothing should have landed on the server from the failed attempt.
    expect(mockServer.files.has(notePath)).toBe(false);

    // Cycle 2: fault cleared (failNext only fires once, and there's no more
    // queued fault) — the same local note (still synced=false) retries.
    const result2 = await fullSync([], [{ ...localNote }]);
    expect(result2.uploaded.notes.uploaded).toBe(1);
    expect(result2.uploaded.notes.failed).toBe(0);
    expect(mockServer.files.has(notePath)).toBe(true);
    const uploaded = JSON.parse(mockServer.files.get(notePath).content);
    expect(uploaded.content).toBe("Content to upload");
    expect(uploaded.strokes.find((s) => s.id === "s1")).toBeTruthy();

    // No duplicate/corrupt entries — exactly one file at this path.
    expect([...mockServer.files.keys()].filter((k) => k === notePath)).toHaveLength(1);
  });

  it("scenario 6a: 503 + Retry-After on PUT — upload fails cleanly, no data loss, recovers next cycle", async () => {
    const noteId = "n-503-retry-after";
    const notebookId = "nb1";
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;

    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });

    const localNote = {
      id: noteId,
      notebookId,
      content: "Will hit 503",
      modified: 1000,
      synced: false,
    };

    mockServer.failNext({
      method: "PUT",
      pathMatch: `${noteId}.json`,
      status: 503,
      retryAfter: 5,
    });

    const result1 = await fullSync([], [{ ...localNote }]);

    // The upload was actually attempted (guards against the note being silently
    // skipped rather than genuinely tried). We assert at least one PUT — NOT an
    // exact count — so this test stays green if retry/backoff for 503+Retry-After
    // is added later. What matters is the invariant below, not the attempt count.
    const putAttempts = mockServer.requests.filter(
      (r) => r.method === "PUT" && r.path.includes(`${noteId}.json`),
    );
    expect(putAttempts.length).toBeGreaterThanOrEqual(1);

    // Invariant: a 503 leaves NO data loss and NO partial state on the server —
    // the note is reported failed (not a phantom success) and nothing landed.
    expect(result1.uploaded.notes.uploaded).toBe(0);
    expect(result1.uploaded.notes.failed).toBe(1);
    expect(mockServer.files.has(notePath)).toBe(false);

    // Cycle 2: fault was single-use (failNext), already cleared automatically —
    // the still-unsynced note retries and lands intact.
    const result2 = await fullSync([], [{ ...localNote }]);
    expect(result2.uploaded.notes.uploaded).toBe(1);
    expect(mockServer.files.has(notePath)).toBe(true);
    expect(JSON.parse(mockServer.files.get(notePath).content).content).toBe("Will hit 503");
  });

  it("scenario 6b: 423 Locked on PUT — upload fails cleanly, existing content untouched, recovers after unlock", async () => {
    const noteId = "n-423-locked";
    const notebookId = "nb1";
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;

    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });
    // Seed the file first so lock() has an existing entry to mark locked.
    mockServer.files.set(notePath, {
      content: JSON.stringify({ id: noteId, notebookId, content: "pre-existing", modified: 500 }),
      etag: "etag-pre",
      mtime: new Date(500),
    });
    mockServer.lock(notePath);

    const localNote = {
      id: noteId,
      notebookId,
      content: "Trying to update locked file",
      modified: 1000,
      synced: false,
      lastSyncedEtag: "etag-pre",
    };

    const result1 = await fullSync([], [{ ...localNote }]);

    // At least one PUT was attempted; exact count is not pinned so adding
    // retry/backoff for 423 later does not break this test.
    const putAttempts = mockServer.requests.filter(
      (r) => r.method === "PUT" && r.path.includes(`${noteId}.json`),
    );
    expect(putAttempts.length).toBeGreaterThanOrEqual(1);

    // Invariant: a 423 leaves the upload failed and the locked file's existing
    // content byte-for-byte untouched — no partial write, no data loss.
    expect(result1.uploaded.notes.uploaded).toBe(0);
    expect(result1.uploaded.notes.failed).toBe(1);
    expect(JSON.parse(mockServer.files.get(notePath).content).content).toBe("pre-existing");

    // Unlock and retry next cycle.
    mockServer.unlock(notePath);
    const result2 = await fullSync([], [{ ...localNote }]);
    expect(result2.uploaded.notes.uploaded).toBe(1);
    expect(JSON.parse(mockServer.files.get(notePath).content).content).toBe(
      "Trying to update locked file",
    );
  });

  it("scenario 7: locally-encrypted note round-trips through sync as decrypted plaintext on the server", async () => {
    // IMPORTANT — documented, intentional behavior (see nextcloudSync.js
    // decryptNoteLocally() / syncNotes(), comment at the JSON-upload site:
    // "decryptedNote is already plain — Nextcloud always receives readable
    // JSON."). "Local encryption" (note.encrypted / isAppUnlocked /
    // getEncryptionKey) protects the local on-device DB only. When a
    // locally-encrypted note is synced, nextcloudSync.js decrypts it with the
    // local key BEFORE uploading, and Nextcloud stores plain JSON. There is no
    // separate "server-side encryption" layer in this module — this test
    // documents that the server DOES receive plaintext for this feature,
    // which is the opposite of what a naive reading of "encryption enabled"
    // might suggest. (Transport security is TLS, out of scope for this mock.)
    const noteId = "n-encrypted-roundtrip";
    const notebookId = "nb1";
    const notePath = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;

    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
      isCollection: true,
      mtime: new Date(),
    });
    mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
      isCollection: true,
      mtime: new Date(),
    });

    const encryptedNote = {
      id: noteId,
      notebookId,
      title: "Encrypted Note",
      encrypted: true,
      content: { data: "enc-content-blob", iv: "iv-content" },
      strokes: { data: "enc-strokes-blob", iv: "iv-strokes" },
      media: { data: "enc-media-blob", iv: "iv-media" },
      tasks: { data: "enc-tasks-blob", iv: "iv-tasks" },
      recognition: null,
      modified: Date.now(),
      synced: false,
    };

    const plainContent = "This is the plaintext content";
    const plainStrokes = [{ id: "s1", x: [1], y: [1] }];

    vi.mocked(isAppUnlocked).mockReturnValue(true);
    vi.mocked(getEncryptionKey).mockReturnValue("test-key");
    vi.mocked(decryptObject).mockImplementation(async (blob) => {
      if (blob === encryptedNote.content) return plainContent;
      if (blob === encryptedNote.strokes) return plainStrokes;
      if (blob === encryptedNote.media) return [];
      if (blob === encryptedNote.tasks) return [];
      return null;
    });

    // --- Device A: syncs the locally-encrypted note. ---
    const resultA = await fullSync([], [{ ...encryptedNote }]);
    expect(resultA.uploaded.notes.uploaded).toBe(1);
    expect(mockServer.files.has(notePath)).toBe(true);

    // As documented: the server receives the DECRYPTED plaintext, not the
    // {data, iv} blob shape. The `encrypted` flag itself is stripped too.
    const serverRecord = JSON.parse(mockServer.files.get(notePath).content);
    expect(serverRecord.content).toBe(plainContent);
    expect(serverRecord.strokes).toEqual(plainStrokes);
    expect(serverRecord.encrypted).toBeUndefined();

    // --- Device B: downloads that same note. Since Nextcloud only ever held
    // plaintext, B receives plaintext directly — no decrypt step is needed
    // (or possible) on the way down through fullSync/downloadAllData.
    const localBStub = {
      id: noteId,
      notebookId,
      modified: 0, // older than server -> triggers download
      synced: true,
      lastSyncedEtag: "stale-etag-b",
    };
    const resultB = await fullSync([], [{ ...localBStub }]);
    expect(resultB.downloaded.notes.some((n) => n.id === noteId)).toBe(true);
    const downloaded = resultB.downloaded.notes.find((n) => n.id === noteId);
    expect(downloaded.content).toBe(plainContent);

    vi.mocked(isAppUnlocked).mockReturnValue(false);
    vi.mocked(getEncryptionKey).mockReturnValue(null);
    vi.mocked(decryptObject).mockReset();
  });
});
