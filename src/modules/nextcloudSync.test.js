/**
 * src/modules/nextcloudSync.test.js
 * Comprehensive unit tests for Nextcloud Sync with a stateful WebDAV mock.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptMerge,
  cleanupLegacyFiles,
  deleteRemoteNote,
  deleteRemoteNotebook,
  downloadAllData,
  fullSync,
  isAuthenticated,
  migrateToHierarchical,
  needsMigration,
  startLoginFlow,
  syncNotebooks,
  syncNotes,
} from "./nextcloudSync.js";
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
    isNextcloudEncryptionEnabled: vi.fn(() => Promise.resolve(false)),
    isLocalEncryptionEnabled: vi.fn(() => Promise.resolve(false)),
    initStorage: vi.fn(() => Promise.resolve()),
    updateNote: vi.fn(() => Promise.resolve()),
    saveNote: vi.fn(() => Promise.resolve()),
    // getNote / getRawNote return whatever was seeded in mockNoteStore
    getNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
    getRawNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
  };
});

// --- WebDAV Mock Server ---

class MockWebDAVServer {
  constructor() {
    this.files = new Map(); // path -> { content, etag, mtime, isCollection }
    this.baseUrl = "https://cloud.example.com";
    this.user = "testuser";
    this.rootPath = `/remote.php/dav/files/${this.user}`;

    // Initialize root
    this.files.set("/", { isCollection: true, mtime: new Date() });
    this.files.set("/NoteBerg", { isCollection: true, mtime: new Date() });
  }

  reset() {
    this.files.clear();
    this.files.set("/", { isCollection: true, mtime: new Date() });
    this.files.set("/NoteBerg", { isCollection: true, mtime: new Date() });
  }

  _normalizePath(url) {
    let path = url.replace(this.baseUrl + this.rootPath, "");
    if (path === "") path = "/";
    return decodeURIComponent(path);
  }

  _generateEtag() {
    return Math.random().toString(36).substring(2, 15);
  }

  async handleRequest(url, options) {
    const method = options.method || "GET";
    const path = this._normalizePath(url);
    const headers = options.headers || {};

    // Auth check
    if (!headers.Authorization) {
      return { ok: false, status: 401, statusText: "Unauthorized", text: async () => "" };
    }

    // console.log(`[MockDAV] ${method} ${path}`);

    if (method === "MKCOL") {
      if (this.files.has(path)) return { ok: false, status: 405, statusText: "Method Not Allowed" };
      // Check parent exists
      const parent = path.substring(0, path.lastIndexOf("/")) || "/";
      if (!this.files.has(parent)) return { ok: false, status: 409, statusText: "Conflict" };

      this.files.set(path, { isCollection: true, mtime: new Date(), etag: this._generateEtag() });
      return { ok: true, status: 201, statusText: "Created" };
    }

    if (method === "PUT") {
      const ifMatch = headers["If-Match"];
      const existing = this.files.get(path);

      if (ifMatch && existing && `"${existing.etag}"` !== ifMatch) {
        return { ok: false, status: 412, statusText: "Precondition Failed" };
      }

      const content = options.body;
      const etag = this._generateEtag();
      this.files.set(path, {
        isCollection: false,
        content,
        mtime: new Date(),
        etag,
      });

      return {
        ok: true,
        status: existing ? 204 : 201,
        headers: { get: (name) => (name.toLowerCase() === "etag" ? `"${etag}"` : null) },
        text: async () => "",
      };
    }

    if (method === "GET") {
      const file = this.files.get(path);
      if (!file) return { ok: false, status: 404, statusText: "Not Found" };
      if (file.isCollection) return { ok: false, status: 405, statusText: "Is Collection" };

      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "etag" ? `"${file.etag}"` : null) },
        text: async () => file.content,
        arrayBuffer: async () => new TextEncoder().encode(file.content).buffer,
        json: async () => JSON.parse(file.content),
      };
    }

    if (method === "DELETE") {
      if (!this.files.has(path)) return { ok: false, status: 404, statusText: "Not Found" };

      // Recursive delete simulation
      for (const key of this.files.keys()) {
        if (key.startsWith(`${path}/`) || key === path) {
          this.files.delete(key);
        }
      }
      return { ok: true, status: 204, statusText: "No Content" };
    }

    if (method === "PROPFIND") {
      if (!this.files.has(path)) return { ok: false, status: 404, statusText: "Not Found" };

      const depth = headers.Depth || "1";
      const file = this.files.get(path);
      let xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">';

      const addItem = (p, f) => {
        const href = this.rootPath + p.split("/").map(encodeURIComponent).join("/");
        const mtime = f.mtime instanceof Date ? f.mtime : new Date();
        const type = f.isCollection ? "<d:collection/>" : "";
        xml += `
          <d:response>
            <d:href>${href}</d:href>
            <d:propstat>
              <d:prop>
                <d:getlastmodified>${mtime.toUTCString()}</d:getlastmodified>
                <d:getetag>"${f.etag || ""}"</d:getetag>
                <d:resourcetype>${type}</d:resourcetype>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>`;
      };

      // Add self
      addItem(path, file);

      // Add children if collection
      if (file.isCollection && depth !== "0") {
        for (const [childPath, childFile] of this.files.entries()) {
          if (childPath !== path && childPath.startsWith(path)) {
            const relative = childPath.substring(path.length);
            // Direct child check for Depth: 1
            const isDirectChild = relative.startsWith("/") && relative.indexOf("/", 1) === -1;

            if (depth === "infinity" || isDirectChild) {
              addItem(childPath, childFile);
            }
          }
        }
      }

      xml += "</d:multistatus>";
      return { ok: true, status: 207, text: async () => xml };
    }

    if (method === "HEAD") {
      const file = this.files.get(path);
      if (!file) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "etag" ? `"${file.etag}"` : null) },
      };
    }

    return { ok: false, status: 501, statusText: "Not Implemented" };
  }
}

// --- Tests ---

describe("Nextcloud Sync Module", () => {
  let mockServer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureStorage.clear();
    mockServer = new MockWebDAVServer();

    // Setup fetch mock to route to our MockWebDAVServer
    fetch.mockImplementation((url, options) => {
      // Handle Login Flow v2 endpoints specifically if needed, otherwise route to WebDAV
      if (url.includes("/index.php/login/v2")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              poll: { token: "test-token", endpoint: "https://cloud.example.com/login/v2/poll" },
              login: "https://cloud.example.com/login/v2/flow/123",
            }),
        });
      }
      if (url.includes("/login/v2/poll")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            server: "https://cloud.example.com",
            loginName: "testuser",
            appPassword: "app-password-123",
          }),
        });
      }
      if (url.includes("/status.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            installed: true,
            version: "25.0.0",
            versionstring: "Nextcloud 25.0.0",
          }),
        });
      }

      return mockServer.handleRequest(url, options || {});
    });

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

  describe("Authentication", () => {
    it("should detect authentication status", async () => {
      expect(await isAuthenticated()).toBe(true);
      mockSecureStorage.clear();
      expect(await isAuthenticated()).toBe(false);
    });

    it("should complete login flow", async () => {
      vi.useFakeTimers();
      mockSecureStorage.clear();

      const loginPromise = startLoginFlow("https://cloud.example.com");

      // Advance time to trigger the poll interval (5000ms)
      await vi.advanceTimersByTimeAsync(6000);

      const creds = await loginPromise;

      expect(creds).toEqual({
        serverUrl: "https://cloud.example.com",
        loginName: "testuser",
        appPassword: "app-password-123",
      });
      expect(mockSecureStorage.has("nextcloud_credentials")).toBe(true);
      vi.useRealTimers();
    });
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
  });

  describe("Conflict Resolution", () => {
    it("should handle true conflict (divergent content)", async () => {
      const noteId = "note1";
      const notebookId = "nb1";

      // Local state
      const localNote = {
        id: noteId,
        notebookId,
        title: "Local Title",
        content: "Local Content",
        modified: 1000,
        synced: false,
        lastSyncedEtag: "old-etag",
      };

      // Remote state (Newer)
      const remoteNote = {
        id: noteId,
        notebookId,
        title: "Remote Title",
        content: "Remote Content",
        modified: 2000,
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
        isCollection: false,
        content: JSON.stringify(remoteNote),
        etag: "new-etag",
        mtime: new Date(),
      });

      const result = await fullSync([], [localNote]);

      // Should detect conflict
      expect(result.conflicts.notes).toHaveLength(1);
      expect(result.conflicts.notes[0].local.title).toBe("Local Title");
      expect(result.conflicts.notes[0].remote.title).toBe("Remote Title");
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

  describe("Media Handling", () => {
    it("should upload note with media", async () => {
      const noteId = "note-media-test";
      const fileId = "file-123";
      const note = {
        id: noteId,
        notebookId: "nb1",
        title: "Media Note",
        content: "",
        media: [{ id: "m1", fileId: fileId, type: "image" }],
        modified: Date.now(),
      };

      // Ensure parent folders exist
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });

      const result = await syncNotes([note]);
      expect(result.uploaded).toBe(1);

      // Check note file
      expect(mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}.json`)).toBe(true);

      // Check media file (mock storage returns text/plain -> .bin extension)
      expect(
        mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${fileId}.bin`),
      ).toBe(true);
    });

    it("should delete orphaned media on server", async () => {
      const noteId = "note-orphan-test";
      const keepFileId = "keep-me";
      const deleteFileId = "delete-me";

      // Setup remote state: Note folder with 2 files
      mockServer.files.set(`/NoteBerg/notebooks/nb1`, { isCollection: true, mtime: new Date() });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes/${noteId}_media`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${keepFileId}.bin`, {
        content: "data",
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${deleteFileId}.bin`, {
        content: "data",
        mtime: new Date(),
      });

      // Local note only has one media item
      const note = {
        id: noteId,
        notebookId: "nb1",
        media: [{ id: "m1", fileId: keepFileId }],
        modified: Date.now(),
      };

      await syncNotes([note]);

      // Verify orphaned file is gone
      expect(
        mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${keepFileId}.bin`),
      ).toBe(true);
      expect(
        mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${deleteFileId}.bin`),
      ).toBe(false);
    });

    it("should merge media during conflict", async () => {
      const noteId = "note-merge-media";

      // Local: Has media A, deleted media B
      const local = {
        id: noteId,
        modified: 2000, // Newer
        media: [{ id: "media-A", x: 10 }],
        deletedMedia: ["media-B"],
      };

      // Remote: Has media B (modified), media C
      const remote = {
        id: noteId,
        modified: 1000, // Older
        media: [
          { id: "media-B", x: 20 }, // Should be deleted because local deleted it
          { id: "media-C", x: 30 }, // Should be kept (added remotely)
        ],
        deletedMedia: [],
      };

      const merged = attemptMerge(local, remote);

      // Should contain A and C
      expect(merged.media).toHaveLength(2);
      expect(merged.media.find((m) => m.id === "media-A")).toBeTruthy();
      expect(merged.media.find((m) => m.id === "media-C")).toBeTruthy();

      // Should NOT contain B
      expect(merged.media.find((m) => m.id === "media-B")).toBeFalsy();

      // Should track deletions
      expect(merged.deletedMedia).toContain("media-B");
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

    it("should retry upload on 412 Precondition Failed", async () => {
      const note = {
        id: "n-412",
        notebookId: "nb1",
        content: "New",
        lastSyncedEtag: "wrong-etag",
        synced: false,
      };

      // Remote exists with different etag
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes/n-412.json", {
        content: "{}",
        etag: "real-etag",
        mtime: new Date(),
      });

      // The sync logic will try to upload with If-Match: "wrong-etag"
      // Mock server returns 412
      // Logic should retry without If-Match

      await fullSync([], [note]);

      const file = mockServer.files.get("/NoteBerg/notebooks/nb1/notes/n-412.json");
      const content = JSON.parse(file.content);
      expect(content.content).toBe("New");
    });

    it("should self-heal if synced: true but missing on server", async () => {
      const note = { id: "n-heal", notebookId: "nb1", synced: true, content: "Heal Me" };

      // Remote does NOT have file

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

  describe("Standalone Operations", () => {
    it("should delete remote note directly", async () => {
      const noteId = "n-del-direct";
      const notebookId = "nb1";

      // Setup remote
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`, {
        content: "{}",
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/_tombstones.json`, {
        content: "{}",
        mtime: new Date(),
      });

      await deleteRemoteNote(noteId, notebookId);

      expect(mockServer.files.has(`/NoteBerg/notebooks/${notebookId}/notes/${noteId}.json`)).toBe(
        false,
      );

      const tombstone = JSON.parse(
        mockServer.files.get(`/NoteBerg/notebooks/${notebookId}/_tombstones.json`).content,
      );
      expect(tombstone.notes.some((n) => n.id === noteId)).toBe(true);
    });

    it("should handle errors in deleteRemoteNotebook", async () => {
      const notebookId = "nb-error";

      // Mock fetch to fail for this specific DELETE request
      const originalFetch = fetch.getMockImplementation();
      fetch.mockImplementation(async (url, options) => {
        if (url.includes(notebookId) && options.method === "DELETE") {
          return { ok: false, status: 500, statusText: "Server Error" };
        }
        return originalFetch(url, options);
      });

      const result = await deleteRemoteNotebook(notebookId);
      expect(result).toBe(false);

      // Restore fetch
      fetch.mockImplementation(originalFetch);
    });
  });

  describe("Migration Logic", () => {
    it("should detect migration needed (Legacy files present, v1 storage)", async () => {
      // Mock legacy files
      mockServer.files.set("/NoteBerg/notebook_old.json", { content: "{}", mtime: new Date() });

      // Storage version is 1 by default in mocks
      const needed = await needsMigration();
      expect(needed).toBe(true);
    });

    it("should perform migration from flat to hierarchical", async () => {
      // Setup legacy files
      const nbContent = JSON.stringify({ id: "nb-mig", title: "Migrated" });
      const noteContent = JSON.stringify({ id: "n-mig", notebookId: "nb-mig", title: "Note" });

      mockServer.files.set("/NoteBerg/notebook_nb-mig.json", {
        content: nbContent,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/note_n-mig.json", {
        content: noteContent,
        mtime: new Date(),
      });

      await migrateToHierarchical();

      // Verify new structure exists
      expect(mockServer.files.has("/NoteBerg/notebooks/nb-mig/_notebook.json")).toBe(true);
      expect(mockServer.files.has("/NoteBerg/notebooks/nb-mig/notes/n-mig.json")).toBe(true);
    });

    it("should cleanup legacy files", async () => {
      mockServer.files.set("/NoteBerg/notebook_old.json", { content: "{}", mtime: new Date() });
      mockServer.files.set("/NoteBerg/note_old.json", { content: "{}", mtime: new Date() });
      mockServer.files.set("/NoteBerg/other.txt", { content: "{}", mtime: new Date() });

      await cleanupLegacyFiles();

      expect(mockServer.files.has("/NoteBerg/notebook_old.json")).toBe(false);
      expect(mockServer.files.has("/NoteBerg/note_old.json")).toBe(false);
      expect(mockServer.files.has("/NoteBerg/other.txt")).toBe(true);
    });
  });
});
