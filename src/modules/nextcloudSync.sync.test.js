/**
 * src/modules/nextcloudSync.sync.test.js
 * Sync Logic (Incremental & Filtering), Edge Cases & Features, Purge Logic.
 * All exercise fullSync/syncNotes/syncNotebooks incremental behavior.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { downloadAllData, fullSync, syncNotebooks, syncNotes } from "./nextcloudSync.js";
import { saveNote } from "./storage.js";

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

  describe("Sync Logic (Incremental & Filtering)", () => {
    it("should upload a new notebook", async () => {
      // Ensure parent notebooks folder exists
      mockServer.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });

      const notebook = { id: "nb1", title: "Test Notebook", modified: Date.now() };

      const result = await syncNotebooks([notebook]);

      expect(result.uploaded).toBe(1);
      expect(mockServer.files.has("/NoteBerg/notebooks/nb1")).toBe(true);
      expect(mockServer.files.has("/NoteBerg/notebooks/nb1/_notebook.json")).toBe(true);

      const remoteContent = JSON.parse(
        mockServer.files.get("/NoteBerg/notebooks/nb1/_notebook.json").content,
      );
      expect(remoteContent.title).toBe("Test Notebook");
      expect(remoteContent.synced).toBe(true);
    });

    it("should only download changed items (Incremental Sync)", async () => {
      // Setup remote
      const note1 = { id: "n1", content: "A", modified: 1000 };
      const note2 = { id: "n2", content: "B", modified: 1000 };

      mockServer.files.set("/NoteBerg/notebooks/nb1/notes/n1.json", {
        content: JSON.stringify(note1),
        etag: "etag-A",
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes/n2.json", {
        content: JSON.stringify(note2),
        etag: "etag-B",
        mtime: new Date(),
      });

      // Local state
      const localNote1 = { id: "n1", notebookId: "nb1", lastSyncedEtag: "etag-A" }; // Match
      const localNote2 = { id: "n2", notebookId: "nb1", lastSyncedEtag: "old-etag" }; // Mismatch

      const result = await downloadAllData([], [localNote1, localNote2]);

      // Should return both notes (one stub, one downloaded)
      expect(result.notes).toHaveLength(2);

      // n1 should be a stub (no content downloaded)
      const resN1 = result.notes.find((n) => n.id === "n1");
      expect(resN1.content).toBeUndefined();

      // n2 should be downloaded
      const resN2 = result.notes.find((n) => n.id === "n2");
      expect(resN2.content).toBe("B");
    });

    it("should only upload modified items", async () => {
      const nb1 = { id: "nb1", synced: true, lastSyncedEtag: "etag-1" };
      const nb2 = { id: "nb2", synced: false }; // Modified

      // Remote has nb1 with proper folder structure
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/_notebook.json", {
        content: JSON.stringify(nb1),
        etag: "etag-1",
        mtime: new Date(),
      });

      const result = await fullSync([nb1, nb2], []);

      expect(result.uploaded.notebooks.uploaded).toBe(1);
      expect(result.uploaded.notebooks.uploadedIds).toContain("nb2");
      expect(result.uploaded.notebooks.uploadedIds).not.toContain("nb1");
    });

    it("should download note when remote.modified differs from local.modified (not etag oscillation)", async () => {
      const noteId = "n-real-edit";
      const notebookId = "nb1";
      const T1 = 1_700_000_000_000;

      const remoteNote = { id: noteId, notebookId, content: "Edited in NC", modified: T1 + 5000 };

      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`, {
        content: JSON.stringify(remoteNote),
        etag: "etag-E2",
        mtime: new Date(T1 + 5000),
      });

      const localNote = {
        id: noteId,
        notebookId,
        modified: T1,
        synced: true,
        lastSyncedEtag: "etag-E1",
      };
      const result = await fullSync([], [localNote]);

      // Real NC edit: must be queued for download, NOT silently accepted as etag oscillation
      expect(result.downloaded.notes.some((n) => n.id === noteId)).toBe(true);
      expect(result.noteEtagsToUpdate.some((e) => e.id === noteId)).toBe(false);
    });

    it("should accept remote etag without download when remote.modified equals local.modified (etag oscillation)", async () => {
      const noteId = "n-oscillation";
      const notebookId = "nb1";
      const T1 = 1_700_000_000_000;

      // Same modified timestamp as local → etag oscillation, no real content change
      const remoteNote = { id: noteId, notebookId, content: "Same content", modified: T1 };

      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`, {
        content: JSON.stringify(remoteNote),
        etag: "etag-E2", // Different ETag → isModifiedRemotely = true
        mtime: new Date(T1),
      });

      const localNote = {
        id: noteId,
        notebookId,
        modified: T1,
        synced: true,
        lastSyncedEtag: "etag-E1",
      };
      const result = await fullSync([], [localNote]);

      // Oscillation: must NOT trigger a download, ETag accepted silently
      expect(result.downloaded.notes.some((n) => n.id === noteId)).toBe(false);
      expect(result.noteEtagsToUpdate.some((e) => e.id === noteId)).toBe(true);
      expect(result.noteEtagsToUpdate.find((e) => e.id === noteId).etag).toBe("etag-E2");
      // Carries the local modified timestamp so updateNoteEtag can detect mid-sync edits
      expect(result.noteEtagsToUpdate.find((e) => e.id === noteId).modified).toBe(T1);
    });

    it("should merge and upload when remote is a stale fork (remote.version < local.version, local is clean)", async () => {
      // Scenario: native uploaded v8 → v13 (clean, synced=true). NC edited from v8 base → v15
      // (NC didn't see v9-v13). Local is clean but has more strokes than the remote fork.
      // Expected: stale-fork path fires, merged note uploaded, NOT a plain download.
      const noteId = "n-stale-fork";
      const notebookId = "nb1";

      const localStroke = { id: "s-native", x: [10], y: [10] };
      const ncStroke = { id: "s-nc", x: [20], y: [20] };

      const remoteNote = {
        id: noteId,
        notebookId,
        strokes: [ncStroke],
        deletedStrokes: [],
        version: 15,
        modified: 1_700_000_010_000,
      };

      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`, {
        content: JSON.stringify(remoteNote),
        etag: "etag-nc",
        mtime: new Date(1_700_000_010_000),
      });

      // Seed local full note (for getNote / getRawNote calls during merge)
      const localFull = {
        id: noteId,
        notebookId,
        strokes: [localStroke],
        deletedStrokes: [],
        version: 17,
        modified: 1_700_000_020_000,
        synced: true,
        lastSyncedEtag: "etag-native-v13",
      };
      mockNoteStore.set(noteId, localFull);

      const localIndex = { ...localFull };
      const result = await fullSync([], [localIndex]);

      // Must NOT be a plain download
      expect(result.downloaded.notes.some((n) => n.id === noteId)).toBe(false);

      // Must upload the merged result
      expect(result.uploaded.notes.uploaded).toBe(1);

      // saveNote must have been called with both strokes
      expect(saveNote).toHaveBeenCalled();
      const mergedArg = saveNote.mock.calls.find((c) => c[0]?.id === noteId)?.[0];
      expect(mergedArg).toBeDefined();
      expect(mergedArg.strokes.find((s) => s.id === "s-native")).toBeTruthy();
      expect(mergedArg.strokes.find((s) => s.id === "s-nc")).toBeTruthy();

      mockNoteStore.delete(noteId);
    });

    it("should upload an existing notebook modified locally when remote is unchanged", async () => {
      // Scenario: notebook was previously synced (has lastSyncedEtag), user edits title/description.
      // Remote file has not changed — etag still matches lastSyncedEtag.
      // Expected: notebook is queued for upload.
      const nb = {
        id: "nb-edit",
        title: "Updated Title",
        synced: false,
        lastSyncedEtag: "etag-original",
      };

      // Remote folder structure exists with matching etag (nothing changed remotely)
      mockServer.files.set("/NoteBerg/notebooks/nb-edit", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-edit/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-edit/_notebook.json", {
        content: JSON.stringify({ id: "nb-edit", title: "Old Title", synced: true }),
        etag: "etag-original", // Matches local lastSyncedEtag — no remote change
        mtime: new Date(),
      });

      const result = await fullSync([nb], []);

      expect(result.uploaded.notebooks.uploaded).toBe(1);
      expect(result.uploaded.notebooks.uploadedIds).toContain("nb-edit");

      // Verify the uploaded content has the new title
      const uploaded = mockServer.files.get("/NoteBerg/notebooks/nb-edit/_notebook.json");
      const uploadedContent = JSON.parse(uploaded.content);
      expect(uploadedContent.title).toBe("Updated Title");
    });
  });

  describe("Edge Cases & Features", () => {
    it("should sync quick notes (no notebook)", async () => {
      const note = { id: "qn1", notebookId: null, title: "Quick", modified: Date.now() };

      await fullSync([], [note]);

      expect(mockServer.files.has("/NoteBerg/quickNotes/qn1.json")).toBe(true);
    });

    it("should handle concurrent notebook and note purge", async () => {
      // If notebook is purged, notes inside it shouldn't trigger individual delete requests
      // because the parent folder deletion handles it.

      const nb = { id: "nb-purge", purged: true };
      const note = { id: "n-purge", notebookId: "nb-purge", purged: true };

      // Setup remote
      mockServer.files.set("/NoteBerg/notebooks/nb-purge", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-purge/notes/n-purge.json", {
        content: "{}",
        mtime: new Date(),
      });

      const result = await fullSync([nb], [note]);

      // Note should NOT be processed individually in syncNotes because fullSync filters it out
      const noteInUploadList = result.notesToUpload.find((n) => n.id === "n-purge");
      expect(noteInUploadList).toBeUndefined();

      // Verify remote deletion happened via notebook purge
      expect(mockServer.files.has("/NoteBerg/notebooks/nb-purge")).toBe(false);
    });

    it("should fail the upload on 412 instead of force-overwriting remote changes", async () => {
      // Remote changed after our PROPFIND (concurrent edit from another device).
      // The upload must FAIL (note stays synced=false, next cycle merges) — the
      // old behavior force-overwrote and silently lost the remote edit.
      const note = {
        id: "n-412",
        notebookId: "nb1",
        title: "Local",
        content: "Local edit",
        lastSyncedEtag: "stale-etag",
        synced: false,
        modified: 1000,
      };

      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes/n-412.json", {
        content: JSON.stringify({ id: "n-412", content: "Concurrent remote edit" }),
        etag: "current-etag",
        mtime: new Date(),
      });

      const result = await syncNotes([note]);

      expect(result.uploaded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].id).toBe("n-412");

      // Remote content must be preserved, not overwritten
      const file = mockServer.files.get("/NoteBerg/notebooks/nb1/notes/n-412.json");
      expect(JSON.parse(file.content).content).toBe("Concurrent remote edit");
    });

    it("should recover from a 412 on the next sync cycle without losing either side's changes", async () => {
      // Full lifecycle of the un-stick path that replaced the 412 force-overwrite:
      // Cycle 1: local uploads with If-Match, but another device wrote between our
      //          PROPFIND and PUT → 412 → upload fails, note stays synced=false.
      // Cycle 2: etag mismatch is detected up front → merge → upload with the fresh
      //          etag succeeds. Both devices' strokes survive on the server.
      const noteId = "n-412-recover";
      const notePath = `/NoteBerg/notebooks/nb1/notes/${noteId}.json`;
      const localStroke = { id: "s-local", x: [1], y: [1] };
      const remoteStroke = { id: "s-other-device", x: [2], y: [2] };

      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(notePath, {
        content: JSON.stringify({
          id: noteId,
          notebookId: "nb1",
          strokes: [],
          deletedStrokes: [],
          version: 1,
          modified: 1000,
        }),
        etag: "etag-v1",
        mtime: new Date(1000),
      });

      // Local: edited (synced=false), base etag still matches the server → cycle 1
      // takes the plain-upload path with If-Match: etag-v1.
      const localNote = {
        id: noteId,
        notebookId: "nb1",
        strokes: [localStroke],
        deletedStrokes: [],
        version: 2,
        modified: 2000,
        synced: false,
        lastSyncedEtag: "etag-v1",
      };

      // Inject the race: just before our PUT lands, another device updates the note.
      const originalFetch = fetch.getMockImplementation();
      let injected = false;
      fetch.mockImplementation(async (url, options) => {
        if (!injected && url.includes(`${noteId}.json`) && options?.method === "PUT") {
          injected = true;
          mockServer.files.set(notePath, {
            content: JSON.stringify({
              id: noteId,
              notebookId: "nb1",
              strokes: [remoteStroke],
              deletedStrokes: [],
              version: 2,
              modified: 1500,
            }),
            etag: "etag-v2",
            mtime: new Date(1500),
          });
        }
        return originalFetch(url, options);
      });

      // Cycle 1: upload must FAIL (not force-overwrite the other device's stroke)
      const result1 = await fullSync([], [{ ...localNote }]);
      expect(injected).toBe(true);
      expect(result1.uploaded.notes.uploaded).toBe(0);
      expect(result1.uploaded.notes.failed).toBe(1);
      const afterCycle1 = JSON.parse(mockServer.files.get(notePath).content);
      expect(afterCycle1.strokes.find((s) => s.id === "s-other-device")).toBeTruthy();

      // Cycle 2: note is still synced=false with the stale base etag — the etag
      // mismatch routes it through the merge path, which uploads with the fresh etag.
      const result2 = await fullSync([], [{ ...localNote }]);
      expect(result2.uploaded.notes.uploaded).toBe(1);
      expect(result2.conflicts.notes).toHaveLength(0);

      // Both sides' strokes must be on the server now
      const afterCycle2 = JSON.parse(mockServer.files.get(notePath).content);
      expect(afterCycle2.strokes.find((s) => s.id === "s-local")).toBeTruthy();
      expect(afterCycle2.strokes.find((s) => s.id === "s-other-device")).toBeTruthy();

      fetch.mockImplementation(originalFetch);
    });

    it("should self-heal if synced: true but missing on server", async () => {
      const note = { id: "n-heal", notebookId: "nb1", synced: true, content: "Heal Me" };

      // The notebook folder chain exists (the notebook was synced previously);
      // only the note JSON is missing on the server — that's the self-heal case.
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });

      const result = await fullSync([], [note]);

      expect(result.uploaded.notes.uploaded).toBe(1);
      expect(mockServer.files.has("/NoteBerg/notebooks/nb1/notes/n-heal.json")).toBe(true);
    });
  });

  describe("Purge Logic", () => {
    it("should correctly handle notebook purging", async () => {
      const notebookId = "nb-purge-test";

      // Setup remote state
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/_notebook.json`, {
        isCollection: false,
        content: "{}",
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/note1.json`, {
        isCollection: false,
        content: "{}",
        mtime: new Date(),
      });

      // Local state: Purged notebook
      const localNotebook = {
        id: notebookId,
        title: "Purged Notebook",
        purged: true,
        deleted: true,
        synced: false,
      };

      await fullSync([localNotebook], []);

      // Verify remote deletion
      expect(mockServer.files.has(`/NoteBerg/notebooks/${notebookId}`)).toBe(false);

      // Verify tombstone update
      expect(mockServer.files.has("/NoteBerg/notebooks/_tombstones.json")).toBe(true);
      const tombstone = JSON.parse(
        mockServer.files.get("/NoteBerg/notebooks/_tombstones.json").content,
      );
      expect(tombstone.notebooks.some((n) => n.id === notebookId)).toBe(true);
      // Verify deletedAt is present
      expect(tombstone.notebooks.find((n) => n.id === notebookId).deletedAt).toBeTruthy();
    });

    it("should not re-upload purged notebook if another client syncs", async () => {
      const notebookId = "nb-zombie";

      // Remote state: Tombstone exists, Folder gone
      const tombstone = {
        notebooks: [{ id: notebookId, deletedAt: new Date().toISOString() }],
        notes: [],
      };
      mockServer.files.set("/NoteBerg/notebooks/_tombstones.json", {
        isCollection: false,
        content: JSON.stringify(tombstone),
        etag: "tomb-etag",
      });

      // Local state: In recycle bin (modified locally because deleted=true)
      const localNotebook = {
        id: notebookId,
        title: "Zombie Notebook",
        deleted: true,
        purged: false,
        synced: false, // "Modified" locally
        lastSyncedEtag: "old-etag",
      };

      const result = await fullSync([localNotebook], []);

      // Should NOT upload
      expect(result.notebooksToUpload).toHaveLength(0);

      // Should instruct to delete locally
      expect(result.notebooksToDelete).toContain(notebookId);
    });
  });
});
