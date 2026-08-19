/**
 * src/modules/nextcloudSync.media.test.js
 * Media Handling: upload, orphan cleanup, merge, encrypted-media.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { decryptObject } from "./encryption.js";
import { getEncryptionKey, isAppUnlocked } from "./masterPassword.js";
import { attemptMerge, downloadAllData, syncNotes } from "./nextcloudSync.js";
import { getFile, saveFile } from "./storage.js";

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

    // clearAllMocks() resets call history but NOT implementations, so a test
    // that points getFile at its own blob would otherwise leak that blob (and
    // its mime type, which decides the uploaded file's extension) into every
    // later test. Restore the small-text default explicitly.
    getFile.mockResolvedValue(new Blob(["test"], { type: "text/plain" }));

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

    // Regression: a large PDF (e.g. a scanned 1500-page book) used to be PUT as a
    // single body. @tauri-apps/plugin-http cannot stream — it marshals the body
    // as Array.from(new Uint8Array(...)) over the JSON IPC bridge, costing ~12x
    // the file size in transient allocation and OOM-killing the Android WebView
    // renderer mid-sync (no catchable JS error; the app just vanishes).
    describe("large media uploads", () => {
      const CHUNK_SIZE = 8 * 1024 * 1024;

      /** Seeds a notebook's folder chain and returns a note referencing one media file. */
      const setupLargeMediaNote = (noteId, fileId, blob) => {
        mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
        mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
          isCollection: true,
          mtime: new Date(),
        });
        getFile.mockResolvedValue(blob);
        return {
          id: noteId,
          notebookId: "nb1",
          title: "Big PDF Note",
          media: [{ id: "m1", fileId, type: "pdf-page" }],
          pdfSource: fileId,
          modified: Date.now(),
        };
      };

      it("never sends a request body larger than one chunk", async () => {
        const fileId = "big-pdf";
        // 20MB of distinct content -> 3 chunks at an 8MB chunk size.
        const payload = "P".repeat(20 * 1024 * 1024);
        const note = setupLargeMediaNote("note-big-pdf", fileId, new Blob([payload]));

        await syncNotes([note]);

        // The assertion that matches the real failure mode: it is the size of a
        // SINGLE body that kills the renderer, so no individual request may
        // carry the whole file regardless of how many requests are made.
        const bodySizes = fetch.mock.calls
          .map(([, options]) => options?.body)
          .filter((body) => body instanceof Blob)
          .map((body) => body.size);

        expect(bodySizes.length).toBeGreaterThan(0);
        for (const size of bodySizes) {
          expect(size).toBeLessThanOrEqual(CHUNK_SIZE);
        }
      });

      it("reassembles chunks into the original file at the destination", async () => {
        const fileId = "big-pdf";
        const payload = "ABCDEFGH".repeat(2 * 1024 * 1024 + 7); // ~16MB, not chunk-aligned
        const note = setupLargeMediaNote("note-reassemble", fileId, new Blob([payload]));

        const result = await syncNotes([note]);
        expect(result.uploaded).toBe(1);

        // Assert the file actually went up in pieces. Without this the test
        // passes on a single unchunked PUT too (which also stores the file
        // intact), so it would not detect the regression it exists to catch.
        const chunkPuts = mockServer.requests.filter(
          (r) => r.method === "PUT" && /^\/__uploads__\/.+\/\d+$/.test(r.path),
        );
        expect(chunkPuts.length).toBe(Math.ceil(payload.length / CHUNK_SIZE));

        // Chunking is only correct if the bytes survive it — a fix that uploads
        // in pieces but corrupts or truncates the file is worse than the crash.
        // The payload length is deliberately not a multiple of CHUNK_SIZE, so a
        // short final chunk is exercised.
        const stored = mockServer.files.get(
          `/NoteBerg/notebooks/nb1/notes/note-reassemble_media/${fileId}.bin`,
        );
        expect(stored).toBeTruthy();
        expect(stored.content).toBe(payload);
      });

      it("uses the chunked endpoint and cleans up the session directory", async () => {
        const fileId = "big-pdf";
        const note = setupLargeMediaNote(
          "note-session",
          fileId,
          new Blob(["X".repeat(12 * 1024 * 1024)]),
        );

        await syncNotes([note]);

        const methods = mockServer.requests.map((r) => `${r.method} ${r.path}`);
        expect(methods.some((m) => m.startsWith("MOVE /__uploads__/"))).toBe(true);

        // No upload session may outlive the sync, or they accumulate server-side.
        const leftover = [...mockServer.files.keys()].filter((k) => k.startsWith("/__uploads__/"));
        expect(leftover).toEqual([]);
      });

      it("removes the session directory when a chunk fails", async () => {
        const fileId = "big-pdf";
        const note = setupLargeMediaNote(
          "note-chunk-fail",
          fileId,
          new Blob(["X".repeat(20 * 1024 * 1024)]),
        );

        mockServer.failNext({ method: "PUT", pathMatch: /^\/__uploads__\/.+\/2$/, status: 500 });

        const result = await syncNotes([note]);

        // The note JSON must not be uploaded when its media failed, so the next
        // sync retries rather than leaving NC referencing a missing binary.
        expect(result.uploaded).toBe(0);
        expect(mockServer.files.has("/NoteBerg/notebooks/nb1/notes/note-chunk-fail.json")).toBe(
          false,
        );
        const leftover = [...mockServer.files.keys()].filter((k) => k.startsWith("/__uploads__/"));
        expect(leftover).toEqual([]);
      });

      it("uploads small media with a single PUT", async () => {
        const fileId = "small-image";
        const note = setupLargeMediaNote(
          "note-small",
          fileId,
          new Blob(["tiny"], { type: "image/png" }),
        );

        await syncNotes([note]);

        // Chunking must stay off the common path — it costs extra round-trips.
        const uploadCalls = mockServer.requests.filter((r) => r.path.startsWith("/__uploads__/"));
        expect(uploadCalls).toEqual([]);
        expect(
          mockServer.files.has(`/NoteBerg/notebooks/nb1/notes/note-small_media/${fileId}.png`),
        ).toBe(true);
      });
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

  // Syncing a note with a very large embedded PDF crashed the app mid-sync on a
  // low-end Android tablet: the WebView renderer was OOM-killed, which presents
  // as the app simply closing with no JS error. The download path materialized
  // the whole file several times over, with no ceiling on how many large files
  // could be in flight at once.
  describe("Media download memory behaviour", () => {
    /** Seed a note on the server whose media binary is `size` bytes. */
    function seedRemoteNoteWithMedia(noteId, fileId, size) {
      mockServer.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
      mockServer.files.set("/NoteBerg/notebooks/nb1/notes", {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes/${noteId}_media`, {
        isCollection: true,
        mtime: new Date(),
      });
      mockServer.files.set(`/NoteBerg/notebooks/nb1/notes/${noteId}_media/${fileId}.bin`, {
        content: "x".repeat(size),
        mtime: new Date(),
        etag: `etag-${fileId}`,
      });
      return {
        id: noteId,
        notebookId: "nb1",
        title: "Note",
        media: [{ id: `m-${fileId}`, fileId, type: "image" }],
        modified: Date.now(),
      };
    }

    it("hands the downloaded binary to storage as a Blob, not an ArrayBuffer", async () => {
      const note = seedRemoteNoteWithMedia("n-blob", "file-blob", 64);
      mockNoteStore.set(note.id, note);
      await syncNotes([note]);

      vi.mocked(saveFile).mockClear();
      // Download with no local state: every remote note (and its media) is new.
      await downloadAllData([], []);

      expect(saveFile).toHaveBeenCalled();
      const [savedBlob] = vi.mocked(saveFile).mock.calls.at(-1);
      // An ArrayBuffer here means the payload was copied an extra time on the
      // way to storage — the allocation that pushed the tablet over its budget.
      expect(Object.prototype.toString.call(savedBlob)).toBe("[object Blob]");
      // The extension-derived mime must survive the retype.
      expect(savedBlob.type).toBe("application/octet-stream");
    });

    it("caps how many bytes of media are held in memory concurrently", async () => {
      // Four notes, each with a media file a little over a third of the budget:
      // downloading all four at once would exceed it, so some must wait.
      const budget = 64 * 1024 * 1024;
      const size = Math.floor(budget * 0.4);

      let inFlight = 0;
      let peakInFlight = 0;
      let peakBytes = 0;
      let currentBytes = 0;

      // Instrument saveFile: it runs while the payload is still held in memory,
      // so concurrency observed here is concurrency of large in-memory buffers.
      vi.mocked(saveFile).mockImplementation(async (blob) => {
        inFlight++;
        currentBytes += blob.size;
        peakInFlight = Math.max(peakInFlight, inFlight);
        peakBytes = Math.max(peakBytes, currentBytes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        currentBytes -= blob.size;
        return "file-id";
      });

      const notes = [0, 1, 2, 3].map((i) =>
        seedRemoteNoteWithMedia(`n-cap-${i}`, `file-cap-${i}`, size),
      );
      for (const n of notes) mockNoteStore.set(n.id, n);
      await syncNotes(notes);

      // downloadAllData fetches notes with CONCURRENCY 5, so all four notes are
      // in flight together — exactly the situation that blew the memory budget.
      await downloadAllData([], []);

      // Unbounded, all four would overlap. The cap must hold the concurrent
      // bytes under the budget rather than letting every download pile up.
      expect(peakInFlight).toBeLessThan(4);
      expect(peakBytes).toBeLessThanOrEqual(budget);
    });
  });
});
