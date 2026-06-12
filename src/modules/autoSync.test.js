/**
 * src/modules/autoSync.test.js
 * Unit tests for autoSync — focusing on the syncOnNoteClose race condition fix.
 *
 * Bug: When media is added to a note and the user navigates away immediately,
 * the Web Worker's SAVE_MEDIA message may not yet have set synced=false in
 * IndexedDB by the time syncOnNoteClose reads the note index. Without the
 * forceSync flag, syncOnNoteClose would see synced=true and skip the sync,
 * leaving the media folder on Nextcloud empty indefinitely (the inactivity
 * timer is also cancelled by syncOnNoteClose).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must precede imports of the module under test) ---

vi.mock("./nextcloudSync.js", () => ({
  isAuthenticated: vi.fn().mockResolvedValue(true),
  hasRemoteChanges: vi.fn().mockResolvedValue(false),
}));

vi.mock("./storage.js", () => ({
  getNoteIndex: vi.fn(),
  getAllNotesForSync: vi.fn().mockResolvedValue([]),
}));

vi.mock("./sync.js", () => ({
  getIsSyncing: vi.fn().mockReturnValue(false),
  performSync: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("./autoRecognition.js", () => ({
  recognizeUnprocessedNotes: vi.fn(),
}));

import { syncOnNoteClose, syncOnNoteOpen } from "./autoSync.js";
import { hasRemoteChanges, isAuthenticated } from "./nextcloudSync.js";
import { getAllNotesForSync, getNoteIndex } from "./storage.js";
import { performSync } from "./sync.js";

// Each test needs a time that is well past the SYNC_COOLDOWN (5s) relative to
// when the previous test recorded lastSyncTime. We advance the fake clock by 60s
// per test so that lastSyncTime from the previous test is always in the past.
let fakeNow = 1_700_000_000_000;

beforeEach(() => {
  fakeNow += 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(fakeNow);
  vi.clearAllMocks();
  vi.mocked(isAuthenticated).mockResolvedValue(true);
  vi.mocked(performSync).mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncOnNoteClose", () => {
  it("skips sync when note is already synced and forceSync is false", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "note-1", synced: true });

    await syncOnNoteClose("note-1");

    expect(performSync).not.toHaveBeenCalled();
  });

  it("syncs when note is unsynced (synced=false)", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "note-1", synced: false });

    await syncOnNoteClose("note-1");

    expect(performSync).toHaveBeenCalledOnce();
  });

  it("syncs when forceSync=true even if note appears synced", async () => {
    // This covers the race condition: the SAVE_MEDIA Web Worker message may not yet
    // have been processed by IndexedDB when syncOnNoteClose reads the note index.
    // The destroy() result carries mediaChanged=true so that sync is not skipped.
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "note-1", synced: true });

    await syncOnNoteClose("note-1", { forceSync: true });

    expect(performSync).toHaveBeenCalledOnce();
  });

  it("syncs when forceSync=true and note is also unsynced", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "note-1", synced: false });

    await syncOnNoteClose("note-1", { forceSync: true });

    expect(performSync).toHaveBeenCalledOnce();
  });

  it("skips sync when not authenticated regardless of forceSync", async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "note-1", synced: false });

    await syncOnNoteClose("note-1", { forceSync: true });

    expect(performSync).not.toHaveBeenCalled();
  });
});

describe("syncOnNoteOpen — change check inputs", () => {
  it("passes the notebook's notes INCLUDING soft-deleted ones to hasRemoteChanges", async () => {
    // A soft-deleted note still has its JSON (and etag) on the server. Excluding
    // it from the local list would make its remote file look "changed" on every
    // note open and trigger a needless full sync each time.
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "n-active", notebookId: "nb1" });
    vi.mocked(getAllNotesForSync).mockResolvedValue([
      { id: "n-active", notebookId: "nb1", deleted: false, lastSyncedEtag: "e1" },
      { id: "n-deleted", notebookId: "nb1", deleted: true, lastSyncedEtag: "e2" },
      { id: "n-other", notebookId: "nb2", deleted: false, lastSyncedEtag: "e3" },
    ]);
    vi.mocked(hasRemoteChanges).mockResolvedValue(false);

    await syncOnNoteOpen("n-active");

    expect(hasRemoteChanges).toHaveBeenCalledOnce();
    const [notebookId, localNotes] = vi.mocked(hasRemoteChanges).mock.calls[0];
    expect(notebookId).toBe("nb1");
    const ids = localNotes.map((n) => n.id);
    expect(ids).toContain("n-active");
    expect(ids).toContain("n-deleted"); // soft-deleted note must be included
    expect(ids).not.toContain("n-other"); // other notebooks excluded
    expect(performSync).not.toHaveBeenCalled(); // no changes → no sync
  });

  it("handles quick notes (notebookId null)", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "qn1", notebookId: null });
    vi.mocked(getAllNotesForSync).mockResolvedValue([
      { id: "qn1", notebookId: null, deleted: false },
      { id: "n-other", notebookId: "nb1", deleted: false },
    ]);
    vi.mocked(hasRemoteChanges).mockResolvedValue(true);

    await syncOnNoteOpen("qn1");

    const [notebookId, localNotes] = vi.mocked(hasRemoteChanges).mock.calls[0];
    expect(notebookId).toBeNull();
    expect(localNotes.map((n) => n.id)).toEqual(["qn1"]);
    expect(performSync).toHaveBeenCalledOnce();
  });
});
