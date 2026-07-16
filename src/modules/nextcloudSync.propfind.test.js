/**
 * src/modules/nextcloudSync.propfind.test.js
 * PROPFIND Depth: infinity fallback, PROPFIND ETag parsing.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { downloadAllData, fullSync } from "./nextcloudSync.js";

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

  describe("PROPFIND Depth: infinity fallback", () => {
    it("should fall back to per-folder listing when the server rejects Depth: infinity", async () => {
      // Stock Nextcloud has dav.propfind.depth_infinity disabled → 400.
      const originalFetch = fetch.getMockImplementation();
      let rejectedInfinity = false;
      fetch.mockImplementation(async (url, options) => {
        if (options?.method === "PROPFIND" && options?.headers?.Depth === "infinity") {
          rejectedInfinity = true;
          return { ok: false, status: 400, statusText: "Bad Request", text: async () => "" };
        }
        return originalFetch(url, options);
      });

      // Seed hierarchical structure
      mockServer.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/_notebook.json", {
        content: JSON.stringify({ id: "nb1", title: "NB", modified: 1000 }),
        etag: "e-nb",
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/_tombstones.json", {
        content: JSON.stringify({ notes: [], media: [], notebooks: [] }),
        etag: "e-tomb",
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes/n1.json", {
        content: JSON.stringify({ id: "n1", notebookId: "nb1", content: "A", modified: 1000 }),
        etag: "e-n1",
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/quickNotes/qn1.json", {
        content: JSON.stringify({ id: "qn1", notebookId: null, content: "Q", modified: 1000 }),
        etag: "e-qn1",
        mtime: new Date(),
      });

      const result = await downloadAllData([], []);

      expect(rejectedInfinity).toBe(true);
      // Everything must still be discovered via the Depth: 1 walk
      expect(result.notebooks.some((n) => n.id === "nb1")).toBe(true);
      expect(result.notes.some((n) => n.id === "n1")).toBe(true);
      expect(result.notes.some((n) => n.id === "qn1")).toBe(true);
      expect(result.tombstones.has("nb1")).toBe(true);

      fetch.mockImplementation(originalFetch);
    });
  });

  describe("PROPFIND ETag parsing", () => {
    it("should strip &quot; HTML entities from PROPFIND etags so locally-modified notebooks upload", async () => {
      // Scenario: Nextcloud PROPFIND returns etag as &quot;abc&quot; (HTML-entity-encoded).
      // The local notebook was previously synced and has the bare etag "abc" stored.
      // Without the fix, &quot;abc&quot; !== "abc" → isModifiedRemotely=true → conflict,
      // and the local changes are never uploaded.
      const BARE_ETAG = "64e5cc51eda6b41fca80e1a64b8612a6";

      const nb = {
        id: "nb-quot",
        title: "Updated Title",
        synced: false,
        lastSyncedEtag: BARE_ETAG,
      };

      // Simulate Nextcloud returning the etag with &quot; HTML entities in PROPFIND.
      // We do this by intercepting the PROPFIND response via the mock server, then
      // replacing the mock's PROPFIND XML generation for this file.
      mockServer.files.set("/NoteBerg/notebooks/nb-quot", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set("/NoteBerg/notebooks/nb-quot/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      // Store the etag with &quot; wrapping to simulate Nextcloud HTML-encoding
      mockServer.files.set("/NoteBerg/notebooks/nb-quot/_notebook.json", {
        content: JSON.stringify({
          id: "nb-quot",
          title: "Old Title",
          synced: true,
          lastSyncedEtag: BARE_ETAG,
        }),
        etag: `&quot;${BARE_ETAG}&quot;`, // HTML-entity-encoded, as Nextcloud sends in PROPFIND
        mtime: new Date(),
      });

      const result = await fullSync([nb], []);

      // After the fix: &quot; stripped → file.etag === BARE_ETAG === local.lastSyncedEtag
      // → isModifiedRemotely=false, isModifiedLocally=true → upload
      expect(result.uploaded.notebooks.uploaded).toBe(1);
      expect(result.uploaded.notebooks.uploadedIds).toContain("nb-quot");

      const uploaded = mockServer.files.get("/NoteBerg/notebooks/nb-quot/_notebook.json");
      expect(JSON.parse(uploaded.content).title).toBe("Updated Title");
    });
  });
});
