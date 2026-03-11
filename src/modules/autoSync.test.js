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
}));

vi.mock("./storage.js", () => ({
  getNoteIndex: vi.fn(),
}));

vi.mock("./sync.js", () => ({
  getIsSyncing: vi.fn().mockReturnValue(false),
  performSync: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("./autoRecognition.js", () => ({
  recognizeUnprocessedNotes: vi.fn(),
}));

import { syncOnNoteClose } from "./autoSync.js";
import { isAuthenticated } from "./nextcloudSync.js";
import { getNoteIndex } from "./storage.js";
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
