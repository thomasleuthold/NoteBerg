/**
 * src/modules/nextcloudSync.tombstone.test.js
 * Standalone Operations: deleteRemoteNote / deleteRemoteNotebook, 412-retry,
 * corrupted-tombstone preservation.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import {
  deleteRemoteNote,
  deleteRemoteNotebook,
  downloadTombstone,
  uploadTombstone,
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

    it("should preserve concurrent tombstone entries via 412 retry", async () => {
      const notebookId = "nb1";
      const tombstonePath = `/NoteBerg/notebooks/${notebookId}/_tombstones.json`;
      const entry = (id) => ({ id, deletedAt: new Date().toISOString() });

      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/n-mine.json`, {
        content: "{}",
        mtime: new Date(),
      });
      mockServer.files.set(tombstonePath, {
        content: JSON.stringify({ notes: [entry("n-other-device")], media: [], notebooks: [] }),
        etag: "tomb-v1",
        mtime: new Date(),
      });

      // Simulate a concurrent writer: just before our first tombstone PUT, another
      // device replaces the tombstone (new entry, new etag) → our If-Match fails.
      const originalFetch = fetch.getMockImplementation();
      let injected = false;
      fetch.mockImplementation(async (url, options) => {
        if (!injected && url.includes("_tombstones.json") && options?.method === "PUT") {
          injected = true;
          mockServer.files.set(tombstonePath, {
            content: JSON.stringify({
              notes: [entry("n-other-device"), entry("n-concurrent")],
              media: [],
              notebooks: [],
            }),
            etag: "tomb-v2",
            mtime: new Date(),
          });
        }
        return originalFetch(url, options);
      });

      const ok = await deleteRemoteNote("n-mine", notebookId);
      expect(ok).toBe(true);
      expect(injected).toBe(true);

      // All three entries must survive: ours, the pre-existing one, and the
      // concurrent one written mid-flight (old behavior dropped it).
      const tombstone = JSON.parse(mockServer.files.get(tombstonePath).content);
      const ids = tombstone.notes.map((t) => t.id);
      expect(ids).toContain("n-mine");
      expect(ids).toContain("n-other-device");
      expect(ids).toContain("n-concurrent");

      fetch.mockImplementation(originalFetch);
    });

    it("should not wipe a corrupted tombstone", async () => {
      const notebookId = "nb1";
      const tombstonePath = `/NoteBerg/notebooks/${notebookId}/_tombstones.json`;
      const corrupted = "not-json{{{";

      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}/notes/n-x.json`, {
        content: "{}",
        mtime: new Date(),
      });
      mockServer.files.set(tombstonePath, {
        content: corrupted,
        etag: "tomb-bad",
        mtime: new Date(),
      });

      // deleteRemoteNote must fail (returns false) instead of replacing the
      // unparseable tombstone with an empty one (which would lose all history).
      const ok = await deleteRemoteNote("n-x", notebookId);
      expect(ok).toBe(false);

      expect(mockServer.files.get(tombstonePath).content).toBe(corrupted);
      // The note file must not have been deleted either (operation aborted)
      expect(mockServer.files.has(`/NoteBerg/notebooks/${notebookId}/notes/n-x.json`)).toBe(true);
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

  describe("uploadTombstone / downloadTombstone (standalone)", () => {
    it("uploads a tombstone for a notebook and round-trips it via download", async () => {
      const notebookId = "nb1";
      mockServer.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });

      const tombstone = {
        notes: [{ id: "n1", deletedAt: new Date().toISOString() }],
        media: [],
        notebooks: [],
      };

      await uploadTombstone(notebookId, tombstone);
      expect(mockServer.files.has(`/NoteBerg/notebooks/${notebookId}/_tombstones.json`)).toBe(true);

      const downloaded = await downloadTombstone(notebookId);
      expect(downloaded.notes.some((n) => n.id === "n1")).toBe(true);
    });

    it("uploads and downloads the quick-notes tombstone when notebookId is null", async () => {
      const tombstone = {
        notes: [{ id: "qn1", deletedAt: new Date().toISOString() }],
        media: [],
        notebooks: [],
      };

      // The quickNotes folder exists (created by the hierarchical structure
      // setup on any real sync); uploadTombstone writes into it.
      mockServer.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });

      await uploadTombstone(null, tombstone);
      expect(mockServer.files.has("/NoteBerg/quickNotes/_tombstones.json")).toBe(true);

      const downloaded = await downloadTombstone(null);
      expect(downloaded.notes.some((n) => n.id === "qn1")).toBe(true);
    });

    it("downloadTombstone returns an empty tombstone when none exists yet", async () => {
      const downloaded = await downloadTombstone("nb-never-synced");
      expect(downloaded).toEqual({ notes: [], media: [], notebooks: [] });
    });

    it("uploadTombstone throws when not authenticated", async () => {
      mockSecureStorage.clear();
      await expect(
        uploadTombstone("nb1", { notes: [], media: [], notebooks: [] }),
      ).rejects.toThrow();
    });

    it("downloadTombstone throws when not authenticated", async () => {
      mockSecureStorage.clear();
      await expect(downloadTombstone("nb1")).rejects.toThrow();
    });
  });
});
