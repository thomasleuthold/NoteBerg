/**
 * src/modules/nextcloudSync.migration.test.js
 * Migration Logic: flat→hierarchical, needsMigration, cleanupLegacyFiles.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { cleanupLegacyFiles, migrateToHierarchical, needsMigration } from "./nextcloudSync.js";

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
