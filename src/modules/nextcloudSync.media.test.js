/**
 * src/modules/nextcloudSync.media.test.js
 * Media Handling: upload, orphan cleanup, merge, encrypted-media.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { decryptObject } from "./encryption.js";
import { getEncryptionKey, isAppUnlocked } from "./masterPassword.js";
import { attemptMerge, syncNotes } from "./nextcloudSync.js";

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

    it("should upload media for locally-encrypted notes", async () => {
      // Regression test: syncNoteMedia was called BEFORE decryptNoteLocally, so
      // note.media was an encrypted blob {data, iv} and the media upload was silently skipped.
      const noteId = "note-encrypted-media";
      const fileId = "file-enc-123";
      const plainMediaArray = [{ id: "m1", fileId: fileId, type: "image" }];

      // Simulate a locally-encrypted note: media is an encrypted blob
      const note = {
        id: noteId,
        notebookId: "nb1",
        title: "Encrypted Note",
        encrypted: true,
        content: { data: "enc-content", iv: "iv1" },
        strokes: { data: "enc-strokes", iv: "iv2" },
        media: { data: "enc-media", iv: "iv3" }, // ← encrypted blob, not array
        tasks: { data: "enc-tasks", iv: "iv4" },
        recognition: null,
        modified: Date.now(),
      };

      // Ensure parent folders exist
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });

      // Override masterPassword and encryption so decryptNoteLocally can run
      vi.mocked(isAppUnlocked).mockReturnValue(true);
      vi.mocked(getEncryptionKey).mockReturnValue("test-key");
      vi.mocked(decryptObject).mockImplementation(async (blob) => {
        if (blob === note.media) return plainMediaArray;
        if (blob === note.content) return "";
        if (blob === note.strokes) return [];
        if (blob === note.tasks) return [];
        return null;
      });

      const result = await syncNotes([note]);
      expect(result.uploaded).toBe(1);

      // The note JSON should be uploaded
      expect(mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}.json`)).toBe(true);

      // The media binary MUST be uploaded — this was the bug
      expect(
        mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${fileId}.bin`),
      ).toBe(true);

      // Restore defaults
      vi.mocked(isAppUnlocked).mockReturnValue(false);
      vi.mocked(getEncryptionKey).mockReturnValue(null);
      vi.mocked(decryptObject).mockReset();
    });
  });
});
