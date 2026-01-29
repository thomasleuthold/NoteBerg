/**
 * src/modules/nextcloudSync.test.js
 * Comprehensive unit tests for Nextcloud Sync with a stateful WebDAV mock.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "@tauri-apps/plugin-http";
import {
  attemptMerge,
  downloadAllData,
  fullSync,
  isAuthenticated,
  startLoginFlow,
  syncNotebooks,
  syncNotes,
} from "./nextcloudSync.js";

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
    isNextcloudEncryptionEnabled: vi.fn(() => Promise.resolve(false)),
    isLocalEncryptionEnabled: vi.fn(() => Promise.resolve(false)),
    initStorage: vi.fn(() => Promise.resolve()),
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
    this.files.set("/oneJournal", { isCollection: true, mtime: new Date() });
  }

  reset() {
    this.files.clear();
    this.files.set("/", { isCollection: true, mtime: new Date() });
    this.files.set("/oneJournal", { isCollection: true, mtime: new Date() });
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
        const mtime = f.mtime || new Date();
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
      expect(mockSecureStorage.get("nextcloud_credentials")).toBeTruthy();
      vi.useRealTimers();
    });
  });

  describe("Sync Logic", () => {
    it("should upload a new notebook", async () => {
      const notebook = { id: "nb1", title: "Test Notebook", modified: Date.now() };

      const result = await syncNotebooks([notebook]);

      expect(result.uploaded).toBe(1);
      expect(mockServer.files.has("/oneJournal/notebooks/nb1")).toBe(true);
      expect(mockServer.files.has("/oneJournal/notebooks/nb1/_notebook.json")).toBe(true);

      const remoteContent = JSON.parse(
        mockServer.files.get("/oneJournal/notebooks/nb1/_notebook.json").content,
      );
      expect(remoteContent.title).toBe("Test Notebook");
      expect(remoteContent.synced).toBe(true);
    });

    it("should upload a new note", async () => {
      const note = {
        id: "note1",
        notebookId: "nb1",
        title: "Test Note",
        content: "Hello",
        modified: Date.now(),
      };

      // Ensure parent folders exist
      mockServer.files.set("/oneJournal/notebooks/nb1", { isCollection: true });
      mockServer.files.set("/oneJournal/notebooks/nb1/notes", { isCollection: true });

      const result = await syncNotes([note]);

      expect(result.uploaded).toBe(1);
      expect(mockServer.files.has("/oneJournal/notebooks/nb1/notes/note1.json")).toBe(true);
    });

    it("should download remote changes", async () => {
      // Setup remote state
      const remoteNotebook = { id: "nb1", title: "Remote Notebook", modified: Date.now() };
      mockServer.files.set("/oneJournal/notebooks/nb1", { isCollection: true });
      mockServer.files.set("/oneJournal/notebooks/nb1/_notebook.json", {
        isCollection: false,
        content: JSON.stringify(remoteNotebook),
        etag: "etag1",
        mtime: new Date(),
      });

      const { notebooks } = await downloadAllData([], []);

      expect(notebooks).toHaveLength(1);
      expect(notebooks[0].title).toBe("Remote Notebook");
      expect(notebooks[0].lastSyncedEtag).toBe("etag1");
    });

    it("should handle conflict: local modified, remote modified (Remote Newer)", async () => {
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

      mockServer.files.set(`/oneJournal/notebooks/${notebookId}`, { isCollection: true });
      mockServer.files.set(`/oneJournal/notebooks/${notebookId}/notes`, { isCollection: true });
      mockServer.files.set(`/oneJournal/notebooks/${notebookId}/notes/${noteId}.json`, {
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
      mockServer.files.set("/oneJournal/notebooks/nb1", { isCollection: true });
      mockServer.files.set("/oneJournal/notebooks/nb1/notes", { isCollection: true });

      const result = await syncNotes([note]);
      expect(result.uploaded).toBe(1);

      // Check note file
      expect(mockServer.files.has(`/oneJournal/notebooks/nb1/notes/${noteId}.json`)).toBe(true);

      // Check media file (mock storage returns text/plain -> .bin extension)
      expect(
        mockServer.files.has(`/oneJournal/notebooks/nb1/notes/${noteId}_media/${fileId}.bin`),
      ).toBe(true);
    });

    it("should delete orphaned media on server", async () => {
      const noteId = "note-orphan-test";
      const keepFileId = "keep-me";
      const deleteFileId = "delete-me";

      // Setup remote state: Note folder with 2 files
      mockServer.files.set(`/oneJournal/notebooks/nb1`, { isCollection: true });
      mockServer.files.set(`/oneJournal/notebooks/nb1/notes`, { isCollection: true });
      mockServer.files.set(`/oneJournal/notebooks/nb1/notes/${noteId}_media`, {
        isCollection: true,
      });
      mockServer.files.set(`/oneJournal/notebooks/nb1/notes/${noteId}_media/${keepFileId}.bin`, {
        content: "data",
      });
      mockServer.files.set(`/oneJournal/notebooks/nb1/notes/${noteId}_media/${deleteFileId}.bin`, {
        content: "data",
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
        mockServer.files.has(`/oneJournal/notebooks/nb1/notes/${noteId}_media/${keepFileId}.bin`),
      ).toBe(true);
      expect(
        mockServer.files.has(`/oneJournal/notebooks/nb1/notes/${noteId}_media/${deleteFileId}.bin`),
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

    it("should purge a single note", async () => {
      const noteId = "note-purge-single";
      mockServer.files.set(`/oneJournal/quickNotes`, { isCollection: true });
      mockServer.files.set(`/oneJournal/quickNotes/${noteId}.json`, { content: "{}" });

      const note = { id: noteId, purged: true, deleted: true };
      await syncNotes([note]);

      expect(mockServer.files.has(`/oneJournal/quickNotes/${noteId}.json`)).toBe(false);
    });
  });

  describe("Purge Logic (Bug Reproduction)", () => {
    it("should correctly handle notebook purging", async () => {
      // Scenario:
      // 1. Notebook exists remotely
      // 2. Client purges notebook locally
      // 3. Sync should delete remote folder and update tombstone

      const notebookId = "nb-purge-test";

      // Setup remote state
      mockServer.files.set(`/oneJournal/notebooks/${notebookId}`, { isCollection: true });
      mockServer.files.set(`/oneJournal/notebooks/${notebookId}/_notebook.json`, {
        isCollection: false,
        content: "{}",
      });
      mockServer.files.set(`/oneJournal/notebooks/${notebookId}/notes`, { isCollection: true });
      mockServer.files.set(`/oneJournal/notebooks/${notebookId}/notes/note1.json`, {
        isCollection: false,
        content: "{}",
      });

      // Local state: Purged notebook
      const localNotebook = {
        id: notebookId,
        title: "Purged Notebook",
        purged: true,
        deleted: true,
        synced: false,
      };

      // Also have a purged note inside it (simulating the bug condition)
      const localNote = {
        id: "note1",
        notebookId: notebookId,
        purged: true,
        deleted: true,
        synced: false,
      };

      const result = await fullSync([localNotebook], [localNote]);

      // Verify remote deletion
      expect(mockServer.files.has(`/oneJournal/notebooks/${notebookId}`)).toBe(false);
      expect(mockServer.files.has(`/oneJournal/notebooks/${notebookId}/notes/note1.json`)).toBe(
        false,
      );

      // Verify tombstone update
      expect(mockServer.files.has("/oneJournal/notebooks/_tombstones.json")).toBe(true);
      const tombstone = JSON.parse(
        mockServer.files.get("/oneJournal/notebooks/_tombstones.json").content,
      );
      expect(tombstone.notebooks.some((n) => n.id === notebookId)).toBe(true);

      // Verify local cleanup instructions
      // The sync function returns lists of items to delete locally
      // Note: In the fixed implementation, purged items are handled inside syncNotebooks/syncNotes
      // and don't necessarily appear in 'notebooksToDelete' which is for remote-driven deletions.
      // However, we want to ensure no errors occurred.
      expect(result.uploaded.notebooks.failed).toBe(0);
      expect(result.uploaded.notes.failed).toBe(0);
    });

    it("should not re-upload purged notebook if another client syncs", async () => {
      // Scenario:
      // 1. Notebook is purged remotely (in tombstone)
      // 2. Local client has it in recycle bin (deleted=true, purged=false)
      // 3. Sync should detect remote purge and delete locally, NOT re-upload

      const notebookId = "nb-zombie";

      // Remote state: Tombstone exists, Folder gone
      const tombstone = {
        notebooks: [{ id: notebookId, deletedAt: new Date().toISOString() }],
        notes: [],
      };
      mockServer.files.set("/oneJournal/notebooks/_tombstones.json", {
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
