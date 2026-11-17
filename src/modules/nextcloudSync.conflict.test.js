/**
 * src/modules/nextcloudSync.conflict.test.js
 * Conflict Resolution + Concurrent Editing & Merging (attemptMerge, fullSync).
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { attemptMerge, fullSync } from "./nextcloudSync.js";
import { getNoteBase, saveNote } from "./storage.js";

// --- Mocks ---

// Mock Tauri HTTP plugin
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

// Mock Tauri Opener
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

// Mock masterPassword (static import in nextcloudSync.js)
vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));

// Mock encryption (static import in nextcloudSync.js)
vi.mock("./encryption.js", () => ({
  decryptObject: vi.fn(),
}));

// Mock Secure Storage
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

// In-memory note store for tests — getNote reads from here
const mockNoteStore = new Map();

// Mock Storage Module (Partial)
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
    getNoteBase: vi.fn(() => Promise.resolve(null)),
    // getNote / getRawNote return whatever was seeded in mockNoteStore
    getNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
    getRawNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
  };
});

// --- Tests ---

describe("Nextcloud Sync Module", () => {
  let mockServer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureStorage.clear();
    mockServer = new MockWebDAVServer();
    wireMockServer(fetch, mockServer);

    // Setup authenticated state
    mockSecureStorage.set(
      "nextcloud_credentials",
      JSON.stringify({
        serverUrl: "https://cloud.example.com",
        loginName: "testuser",
        appPassword: "app-password-123",
      }),
    );
  });

  describe("Conflict Resolution", () => {
    it("keeps both texts and every other field when the text diverges (no conflict dialog)", async () => {
      const noteId = "note1";
      const notebookId = "nb1";

      const localNote = {
        id: noteId,
        notebookId,
        title: "Local Title",
        content: "<p>Local Content</p>",
        strokes: [{ id: "s-local", x: [1], y: [1] }],
        tasks: [{ id: "t-local", text: "mine", modified: 900 }],
        modified: 1000,
        synced: false,
        lastSyncedEtag: "old-etag",
      };
      const remoteNote = {
        id: noteId,
        notebookId,
        title: "Remote Title",
        content: "<p>Remote Content</p>",
        strokes: [{ id: "s-remote", x: [2], y: [2] }],
        tasks: [{ id: "t-remote", text: "theirs", modified: 1500 }],
        modified: 2000,
        lastModifiedBy: "bob",
      };

      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      const path = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`;
      mockServer.files.set(path, {
        isCollection: false,
        content: JSON.stringify(remoteNote),
        etag: "new-etag",
        mtime: new Date(),
      });

      const result = await fullSync([], [localNote]);

      expect(result.conflicts.notes).toHaveLength(0);
      expect(result.uploaded.notes.uploaded).toBe(1);
      const uploaded = JSON.parse(mockServer.files.get(path).content);
      // Neither text was lost; the older side is marked as the conflicting copy
      expect(uploaded.content).toContain("Local Content");
      expect(uploaded.content).toContain("Remote Content");
      expect(uploaded.content).toContain('class="merge-hint"');
      // The losing copy is local (older), attributed to the signed-in user
      expect(uploaded.content).toContain('data-by="testuser"');
      // And nothing outside the text was dropped with the losing side
      expect(uploaded.strokes.map((st) => st.id).sort()).toEqual(["s-local", "s-remote"]);
      expect(uploaded.tasks.map((t) => t.id).sort()).toEqual(["t-local", "t-remote"]);
      // Newer note wins the title (last write wins)
      expect(uploaded.title).toBe("Remote Title");
    });

    it("merges against the stored baseline: independent edits to different blocks both survive", async () => {
      const noteId = "n-base";
      const path = `/NoteBerg/notebooks/nb1/notes/${noteId}.json`;
      getNoteBase.mockResolvedValueOnce("<p>one</p><p>two</p>");
      const local = {
        id: noteId,
        notebookId: "nb1",
        content: "<p>ONE</p><p>two</p>",
        modified: 2000,
        synced: false,
        lastSyncedEtag: "old",
      };
      const remote = {
        id: noteId,
        notebookId: "nb1",
        content: "<p>one</p><p>TWO</p>",
        modified: 1500,
      };
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(path, {
        content: JSON.stringify(remote),
        etag: "new",
        mtime: new Date(),
      });

      await fullSync([], [local]);

      expect(getNoteBase).toHaveBeenCalledWith(noteId);
      const uploaded = JSON.parse(mockServer.files.get(path).content);
      expect(uploaded.content).toBe("<p>ONE</p><p>TWO</p>");
      expect(uploaded.content).not.toContain("merge-hint");
    });

    it("should auto-merge when local content contains remote (No Conflict)", async () => {
      const noteId = "n-merge";
      const local = {
        id: noteId,
        notebookId: "nb1",
        content: "Hello World",
        modified: 2000,
        synced: false,
        lastSyncedEtag: "old",
      };
      const remote = {
        id: noteId,
        notebookId: "nb1",
        content: "Hello",
        modified: 1000,
      };

      // Setup remote with proper folder structure
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes/${noteId}.json`, {
        content: JSON.stringify(remote),
        etag: "new",
        mtime: new Date(),
      });

      const result = await fullSync([], [local]);

      // Should NOT report conflict
      expect(result.conflicts.notes).toHaveLength(0);

      // Should upload merged version (local wins content)
      expect(result.uploaded.notes.uploaded).toBe(1);
      const uploadedContent = JSON.parse(
        mockServer.files.get(`/NoteBerg/notebooks/nb1/notes/${noteId}.json`).content,
      );
      expect(uploadedContent.content).toBe("Hello World");
    });

    it("uploads a restored note as-is instead of merging the server copy back in", async () => {
      // A backup restore re-dirties the note with lastSyncedEtag=null, which
      // classifies as modified on both sides. A merge would re-apply the
      // server's strokes and stroke deletions, undoing the restore. The
      // restoredAt marker makes local win outright.
      const noteId = "n-restored";
      const path = `/NoteBerg/notebooks/nb1/notes/${noteId}.json`;
      const local = {
        id: noteId,
        notebookId: "nb1",
        content: "backup",
        modified: 5000,
        version: 8,
        synced: false,
        lastSyncedEtag: null,
        restoredAt: 5000,
        strokes: [{ id: "s-kept", x: [1], y: [1] }],
        deletedStrokes: [],
      };
      const remote = {
        id: noteId,
        notebookId: "nb1",
        content: "backup",
        modified: 4000,
        version: 7,
        strokes: [
          { id: "s-kept", x: [1], y: [1] },
          { id: "s-ruined", x: [2], y: [2] },
        ],
        deletedStrokes: ["s-kept"],
      };
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(path, {
        content: JSON.stringify(remote),
        etag: "etag-remote",
        mtime: new Date(),
      });
      mockNoteStore.set(noteId, local);

      const result = await fullSync([], [local]);

      expect(result.conflicts.notes).toHaveLength(0);
      expect(result.uploaded.notes.uploaded).toBe(1);
      const uploaded = JSON.parse(mockServer.files.get(path).content);
      expect(uploaded.strokes.map((st) => st.id)).toEqual(["s-kept"]);
      expect(uploaded).not.toHaveProperty("restoredAt");
      // Uploaded against the server's current etag, so the PUT is not a 412.
      const put = mockServer.requests.find((r) => r.method === "PUT" && r.path === path);
      expect(String(put.headers["If-Match"]).replace(/"/g, "")).toBe("etag-remote");
      // Nothing merged was written back locally either.
      expect(saveNote).not.toHaveBeenCalled();
    });

    it("should restore locally modified item if deleted remotely", async () => {
      const noteId = "n-restore";
      const local = {
        id: noteId,
        notebookId: "nb1",
        content: "I am alive",
        modified: 2000,
        synced: false,
        deleted: false,
      };

      // Setup remote folder structure
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });

      // Remote: Tombstone says deleted
      const tombstone = { notes: [{ id: noteId, deletedAt: new Date().toISOString() }] };
      mockServer.files.set("/NoteBerg/notebooks/nb1/_tombstones.json", {
        content: JSON.stringify(tombstone),
        mtime: new Date(),
      });

      const result = await fullSync([], [local]);

      expect(result.uploaded.notes.uploaded).toBe(1);
      expect(mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}.json`)).toBe(true);
    });

    it("should resolve notebook conflicts by last-write-wins (local newer → upload)", async () => {
      // Notebooks have no mergeable content — a modified-both-sides notebook must
      // resolve automatically instead of being reported as a conflict forever.
      const remoteNb = { id: "nb-lww", title: "Remote Title", modified: 1000 };
      mockServer.files.set("/NoteBerg/notebooks/nb-lww", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb-lww/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-lww/_notebook.json", {
        content: JSON.stringify(remoteNb),
        etag: "etag-remote",
        mtime: new Date(),
      });

      const localNb = {
        id: "nb-lww",
        title: "Local Title",
        modified: 2000, // newer than remote
        synced: false,
        lastSyncedEtag: "etag-stale", // ≠ remote → modified both sides
      };

      const result = await fullSync([localNb], []);

      expect(result.conflicts.notebooks).toHaveLength(0);
      expect(result.uploaded.notebooks.uploaded).toBe(1);
      const uploaded = JSON.parse(
        mockServer.files.get("/NoteBerg/notebooks/nb-lww/_notebook.json").content,
      );
      expect(uploaded.title).toBe("Local Title");
    });

    it("should resolve notebook conflicts by last-write-wins (remote newer → download)", async () => {
      const remoteNb = { id: "nb-lww2", title: "Remote Title", modified: 3000 };
      mockServer.files.set("/NoteBerg/notebooks/nb-lww2", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-lww2/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-lww2/_notebook.json", {
        content: JSON.stringify(remoteNb),
        etag: "etag-remote",
        mtime: new Date(),
      });

      const localNb = {
        id: "nb-lww2",
        title: "Local Title",
        modified: 2000, // older than remote
        synced: false,
        lastSyncedEtag: "etag-stale",
      };

      const result = await fullSync([localNb], []);

      expect(result.conflicts.notebooks).toHaveLength(0);
      expect(result.uploaded.notebooks.uploaded).toBe(0);
      expect(result.downloaded.notebooks.some((n) => n.id === "nb-lww2")).toBe(true);
      // Remote was not overwritten
      const remote = JSON.parse(
        mockServer.files.get("/NoteBerg/notebooks/nb-lww2/_notebook.json").content,
      );
      expect(remote.title).toBe("Remote Title");
    });

    it("should preserve background setting during merge", async () => {
      const noteId = "n-bg-merge";
      // Local is newer, has background
      const local = {
        id: noteId,
        modified: 2000,
        background: "grid-large",
        strokes: [],
      };
      // Remote is older
      const remote = {
        id: noteId,
        modified: 1000,
        background: "none",
        strokes: [],
      };

      const merged = attemptMerge(local, remote);
      expect(merged.background).toBe("grid-large");
    });

    it("should return null when local is a stub (hasStrokes=true but strokes undefined)", () => {
      // Scenario: StorageWorker write still in-flight — getRawNote returns the index record
      // only (no noteContent), so strokes is undefined even though the note has strokes.
      // Merging with this stub would treat local as empty and silently drop all local strokes.
      const local = {
        id: "n-stub",
        modified: 2000,
        hasStrokes: true, // index flag says strokes exist
        strokes: undefined, // content record not loaded yet
      };
      const remote = {
        id: "n-stub",
        modified: 1000,
        strokes: [{ id: "s-remote", x: [1], y: [1] }],
      };

      expect(attemptMerge(local, remote)).toBeNull();
    });

    it("should merge normally when local has no strokes and hasStrokes is false", () => {
      // Genuine empty note — not a stub. Should merge fine.
      const local = {
        id: "n-empty",
        modified: 2000,
        hasStrokes: false,
        strokes: [],
      };
      const remote = {
        id: "n-empty",
        modified: 1000,
        strokes: [{ id: "s-remote", x: [1], y: [1] }],
      };

      const merged = attemptMerge(local, remote);
      expect(merged).not.toBeNull();
      expect(merged.strokes.find((s) => s.id === "s-remote")).toBeTruthy();
    });
  });

  describe("attemptMerge text handling", () => {
    const note = (overrides) => ({ id: "n", modified: 1000, strokes: [], ...overrides });

    it("merges diverging text instead of giving up on the whole note", () => {
      const merged = attemptMerge(
        note({ content: "<p>a</p><p>local</p>", modified: 2000 }),
        note({ content: "<p>a</p><p>remote</p>", modified: 1000 }),
      );
      expect(merged).not.toBeNull();
      expect(merged.content).toContain("local");
      expect(merged.content).toContain("remote");
    });

    it("uses the baseline for a three-way merge of independent edits", () => {
      const base = "<p>one</p><p>two</p><p>three</p>";
      const merged = attemptMerge(
        note({ content: "<p>ONE</p><p>two</p><p>three</p>", modified: 2000 }),
        note({ content: "<p>one</p><p>two</p><p>THREE</p>", modified: 1500 }),
        { base },
      );
      expect(merged.content).toBe("<p>ONE</p><p>two</p><p>THREE</p>");
    });

    it("honours a local deletion of everything when the baseline proves it", () => {
      // Without a baseline the old containment heuristic would resurrect the text
      const merged = attemptMerge(
        note({ content: "", modified: 2000 }),
        note({ content: "<p>a</p>", modified: 1000 }),
        { base: "<p>a</p>" },
      );
      expect(merged.content).toBe("");
    });

    it("attributes the other side's copy to the remote author and records nothing for unknown ones", () => {
      const merged = attemptMerge(
        note({ content: "<p>L</p>", modified: 2000 }),
        note({ content: "<p>R</p>", modified: 1000, lastModifiedBy: "bob" }),
        { base: "<p>x</p>", localAuthor: "alice" },
      );
      expect(merged.content).toContain('data-by="bob"');
    });

    it("still returns null for structurally unmergeable notes (encrypted blob content)", () => {
      expect(
        attemptMerge(note({ strokes: { data: "x", iv: "y" } }), note({ strokes: [] })),
      ).toBeNull();
    });
  });

  describe("delete versus concurrent edit", () => {
    const note = (overrides) => ({ id: "n-del", modified: 1000, strokes: [], ...overrides });

    it("keeps the other device's strokes and text in a note trashed meanwhile (restorable)", () => {
      const trashedElsewhere = note({
        deleted: true,
        content: "<p>old</p>",
        modified: 2000,
      });
      const editedHere = note({
        deleted: false,
        content: "<p>old</p><p>new edit</p>",
        strokes: [{ id: "s-new", x: [1], y: [1] }],
        modified: 1500,
      });

      const merged = attemptMerge(editedHere, trashedElsewhere, { base: "<p>old</p>" });

      expect(merged.deleted).toBe(true); // the delete propagates...
      expect(merged.content).toContain("new edit"); // ...but nothing typed is lost
      expect(merged.strokes.map((st) => st.id)).toEqual(["s-new"]);
    });

    it("re-uploads an edit made while the note was purged elsewhere instead of dropping it", async () => {
      const path = "/NoteBerg/notebooks/nb1/notes/n-purged.json";
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/_tombstones.json", {
        content: JSON.stringify({ notes: [{ id: "n-purged", deletedAt: Date.now() }] }),
        etag: "t1",
        mtime: new Date(),
      });
      const local = {
        id: "n-purged",
        notebookId: "nb1",
        content: "<p>typed after the purge</p>",
        modified: 3000,
        synced: false,
      };

      const result = await fullSync([], [local]);

      expect(result.notesToDelete).toEqual([]);
      expect(mockServer.files.has(path)).toBe(true);
      expect(JSON.parse(mockServer.files.get(path).content).content).toContain("typed after");
    });
  });

  describe("Concurrent Editing & Merging", () => {
    it("should merge strokes and update local note on conflict", async () => {
      const noteId = "n-concurrent";
      const notebookId = "nb1";

      // Remote state: Has stroke S1 (Client A)
      const remoteNote = {
        id: noteId,
        notebookId,
        strokes: [{ id: "s1", x: [1], y: [1] }],
        deletedStrokes: [],
        modified: 1000,
        _currentFileEtag: "etag-remote",
      };

      // Local state: Has stroke S2 (Client B)
      const localNote = {
        id: noteId,
        notebookId,
        strokes: [{ id: "s2", x: [2], y: [2] }],
        deletedStrokes: [],
        modified: 2000, // Newer
        synced: false,
        lastSyncedEtag: "etag-base", // Mismatch
      };

      // Setup remote file
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`, {
        content: JSON.stringify(remoteNote),
        etag: "etag-remote",
        mtime: new Date(),
      });

      const result = await fullSync([], [localNote]);

      // Should upload merged version
      expect(result.uploaded.notes.uploaded).toBe(1);

      // Verify saveNote was called to show merged state locally immediately
      expect(saveNote).toHaveBeenCalled();
      const mergedArg = saveNote.mock.calls.find((call) => call[0]?.id === noteId)[0];
      expect(mergedArg.strokes).toHaveLength(2); // Should have S1 and S2
      expect(mergedArg.strokes.find((s) => s.id === "s1")).toBeTruthy();
      expect(mergedArg.strokes.find((s) => s.id === "s2")).toBeTruthy();
    });

    it("should keep merged strokes in temporal order (sorted by time[0])", () => {
      // Recognition consumes strokes in temporal order — a merge must not put the
      // newer device's strokes in front of older ones.
      const older = {
        id: "n-order",
        modified: 1000,
        strokes: [
          { id: "s1", time: [100], x: [1], y: [1] },
          { id: "s2", time: [200], x: [2], y: [2] },
        ],
        deletedStrokes: [],
      };
      const newer = {
        id: "n-order",
        modified: 2000,
        strokes: [
          { id: "s1", time: [100], x: [99], y: [99] }, // same id, edited content
          { id: "s3", time: [300], x: [3], y: [3] }, // drawn later
        ],
        deletedStrokes: [],
      };

      const merged = attemptMerge(newer, older);
      expect(merged.strokes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
      // Same-id conflict: newer side's content wins
      expect(merged.strokes[0].x).toEqual([99]);
    });

    it("should keep the older side's base order for legacy strokes without timestamps", () => {
      const older = {
        id: "n-legacy-order",
        modified: 1000,
        strokes: [
          { id: "s1", x: [1], y: [1] },
          { id: "s2", x: [2], y: [2] },
        ],
        deletedStrokes: [],
      };
      const newer = {
        id: "n-legacy-order",
        modified: 2000,
        strokes: [
          { id: "s1", x: [1], y: [1] },
          { id: "s3", x: [3], y: [3] },
        ],
        deletedStrokes: [],
      };

      const merged = attemptMerge(newer, older);
      // Base order preserved, new strokes appended — never newer-first
      expect(merged.strokes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    });

    it("should propagate stroke deletions during merge", async () => {
      const noteId = "n-del-merge";
      const notebookId = "nb1";

      // Remote: Stroke S1 was deleted by Client A
      const remoteNote = {
        id: noteId,
        notebookId,
        strokes: [],
        deletedStrokes: ["s1"],
        modified: 2000,
        _currentFileEtag: "etag-remote",
      };

      // Local: Has Stroke S1 and S2, but S1 is modified locally (e.g. moved)
      // Since remote deleted S1, the merge should respect the deletion.
      const localNote = {
        id: noteId,
        notebookId,
        strokes: [
          { id: "s1", x: [10], y: [10] }, // Modified locally
          { id: "s2", x: [2], y: [2] }, // New local stroke
        ],
        deletedStrokes: [],
        modified: 1000, // Older (or newer, deletion usually wins in mergeStrokes logic)
        synced: false,
        lastSyncedEtag: "etag-base",
      };

      // Setup remote file
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`, {
        content: JSON.stringify(remoteNote),
        etag: "etag-remote",
        mtime: new Date(),
      });

      await fullSync([], [localNote]);

      // Verify merged content passed to saveNote
      const mergedArg = saveNote.mock.calls.find((call) => call[0]?.id === noteId)[0];

      // S1 should be gone (deleted remotely), S2 should be present
      expect(mergedArg.strokes.find((s) => s.id === "s1")).toBeFalsy();
      expect(mergedArg.strokes.find((s) => s.id === "s2")).toBeTruthy();
      expect(mergedArg.deletedStrokes).toContain("s1");
    });
  });
});
