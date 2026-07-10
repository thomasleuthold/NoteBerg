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

import { recognizeUnprocessedNotes } from "./autoRecognition.js";
import {
  initAutoSync,
  resetInactivityTimer,
  stopInactivityTimer,
  syncOnAppStart,
  syncOnNotebookCreate,
  syncOnNotebookOpen,
  syncOnNoteClose,
  syncOnNoteCreate,
  syncOnNoteOpen,
} from "./autoSync.js";
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

  it("does nothing while a sync is already in progress", async () => {
    const { getIsSyncing } = await import("./sync.js");
    vi.mocked(getIsSyncing).mockReturnValue(true);

    await syncOnNoteOpen("n1");

    expect(getNoteIndex).not.toHaveBeenCalled();
    vi.mocked(getIsSyncing).mockReturnValue(false);
  });

  it("swallows errors instead of throwing", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "n1", notebookId: "nb1" });
    vi.mocked(hasRemoteChanges).mockRejectedValue(new Error("network error"));

    await expect(syncOnNoteOpen("n1")).resolves.toBeUndefined();
  });
});

describe("resetInactivityTimer / stopInactivityTimer", () => {
  afterEach(() => {
    stopInactivityTimer();
  });

  it("does not sync before the 30s inactivity window elapses", () => {
    resetInactivityTimer("n1");
    vi.advanceTimersByTime(29000);
    expect(performSync).not.toHaveBeenCalled();
  });

  it("syncs the active note after 30s of inactivity", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "n1", synced: false });
    resetInactivityTimer("n1");
    await vi.advanceTimersByTimeAsync(30000);
    expect(performSync).toHaveBeenCalled();
  });

  it("resets the timer on repeated calls (only the last note's timer fires)", async () => {
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "n2", synced: false });
    resetInactivityTimer("n1");
    vi.advanceTimersByTime(20000);
    resetInactivityTimer("n2"); // restarts the 30s window
    vi.advanceTimersByTime(20000);
    expect(performSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10000);
    expect(performSync).toHaveBeenCalledOnce();
  });

  it("stopInactivityTimer cancels a pending sync", async () => {
    resetInactivityTimer("n1");
    stopInactivityTimer();
    await vi.advanceTimersByTimeAsync(31000);
    expect(performSync).not.toHaveBeenCalled();
  });

  it("stopInactivityTimer is a no-op when nothing is pending", () => {
    expect(() => stopInactivityTimer()).not.toThrow();
  });
});

describe("sync cooldown (shouldSync)", () => {
  it("skips a second sync trigger within the 5s cooldown window", async () => {
    await syncOnNoteCreate("n1");
    expect(performSync).toHaveBeenCalledOnce();

    await syncOnNoteCreate("n2");
    expect(performSync).toHaveBeenCalledOnce(); // still within cooldown, no second call
  });

  it("allows a sync once the cooldown window passes", async () => {
    await syncOnNoteCreate("n1");
    vi.advanceTimersByTime(5000);
    await syncOnNoteCreate("n2");
    expect(performSync).toHaveBeenCalledTimes(2);
  });

  it("does not sync while another sync is already in progress", async () => {
    const { getIsSyncing } = await import("./sync.js");
    vi.mocked(getIsSyncing).mockReturnValue(true);

    await syncOnNoteCreate("n1");

    expect(performSync).not.toHaveBeenCalled();
    vi.mocked(getIsSyncing).mockReturnValue(false);
  });
});

describe("syncOnNoteCreate", () => {
  it("does nothing when not authenticated", async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    await syncOnNoteCreate("n1");
    expect(performSync).not.toHaveBeenCalled();
  });

  it("syncs a newly created note", async () => {
    await syncOnNoteCreate("n1");
    expect(performSync).toHaveBeenCalledWith({ silent: true, skipConflictResolution: true });
  });
});

describe("syncOnNotebookCreate", () => {
  it("does nothing when not authenticated", async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    await syncOnNotebookCreate("nb1");
    expect(performSync).not.toHaveBeenCalled();
  });

  it("syncs a newly created notebook", async () => {
    await syncOnNotebookCreate("nb1");
    expect(performSync).toHaveBeenCalledWith({ silent: true, skipConflictResolution: true });
  });

  it("swallows errors from performSync instead of throwing", async () => {
    vi.mocked(performSync).mockRejectedValue(new Error("network down"));
    await expect(syncOnNotebookCreate("nb1")).resolves.toBeUndefined();
  });
});

describe("syncOnNotebookOpen", () => {
  it("does not sync when there are no remote changes", async () => {
    vi.mocked(getAllNotesForSync).mockResolvedValue([]);
    vi.mocked(hasRemoteChanges).mockResolvedValue(false);
    await syncOnNotebookOpen("nb1");
    expect(performSync).not.toHaveBeenCalled();
  });

  it("syncs when remote changes are detected", async () => {
    vi.mocked(getAllNotesForSync).mockResolvedValue([]);
    vi.mocked(hasRemoteChanges).mockResolvedValue(true);
    await syncOnNotebookOpen("nb1");
    expect(performSync).toHaveBeenCalledWith({ silent: true, skipConflictResolution: true });
  });

  it("skips entirely while a sync is already in progress", async () => {
    const { getIsSyncing } = await import("./sync.js");
    vi.mocked(getIsSyncing).mockReturnValue(true);

    await syncOnNotebookOpen("nb1");

    expect(hasRemoteChanges).not.toHaveBeenCalled();
    vi.mocked(getIsSyncing).mockReturnValue(false);
  });

  it("filters local notes to the given notebook (including quick notes as null)", async () => {
    vi.mocked(getAllNotesForSync).mockResolvedValue([
      { id: "a", notebookId: "nb1" },
      { id: "b", notebookId: "nb2" },
      { id: "c", notebookId: null },
    ]);
    vi.mocked(hasRemoteChanges).mockResolvedValue(false);

    await syncOnNotebookOpen("nb1");

    expect(hasRemoteChanges).toHaveBeenCalledWith("nb1", [{ id: "a", notebookId: "nb1" }]);
  });

  it("swallows errors instead of throwing", async () => {
    vi.mocked(getAllNotesForSync).mockResolvedValue([]);
    vi.mocked(hasRemoteChanges).mockRejectedValue(new Error("network error"));
    await expect(syncOnNotebookOpen("nb1")).resolves.toBeUndefined();
  });
});

describe("syncOnAppStart", () => {
  it("does nothing when not authenticated", async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    await syncOnAppStart();
    expect(performSync).not.toHaveBeenCalled();
  });

  it("performs an initial sync with preferNewer conflict resolution", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    await syncOnAppStart();
    expect(performSync).toHaveBeenCalledWith({
      silent: true,
      skipConflictResolution: true,
      preferNewer: true,
    });
  });

  it("does not attempt recognition when the initial sync fails", async () => {
    vi.mocked(performSync).mockRejectedValueOnce(new Error("sync failed"));
    await syncOnAppStart();
    expect(recognizeUnprocessedNotes).not.toHaveBeenCalled();
  });

  it("runs recognition after a successful sync and re-syncs if notes were recognized", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(3);
    await syncOnAppStart();

    expect(recognizeUnprocessedNotes).toHaveBeenCalled();
    // Initial sync + follow-up sync for the newly recognized notes.
    expect(performSync).toHaveBeenCalledTimes(2);
    expect(performSync).toHaveBeenLastCalledWith({ silent: true, skipConflictResolution: true });
  });

  it("does not re-sync when no notes needed recognition", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    await syncOnAppStart();
    expect(performSync).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from the post-sync recognition step", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockRejectedValue(new Error("recognition failed"));
    await expect(syncOnAppStart()).resolves.toBeUndefined();
  });
});

describe("initAutoSync", () => {
  afterEach(() => {
    stopInactivityTimer();
  });

  it("triggers an initial sync on startup", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    initAutoSync(); // syncOnAppStart() runs fire-and-forget internally
    await vi.waitFor(() =>
      expect(performSync).toHaveBeenCalledWith(
        expect.objectContaining({ silent: true, preferNewer: true }),
      ),
    );
  });

  it("wires syncOnNoteOpen to navigate events carrying a noteId", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    vi.mocked(getNoteIndex).mockResolvedValue({ id: "n1", notebookId: "nb1" });
    vi.mocked(hasRemoteChanges).mockResolvedValue(false);
    initAutoSync();

    window.dispatchEvent(
      new CustomEvent("navigate", { detail: { mode: "notebook", params: { noteId: "n1" } } }),
    );
    await vi.waitFor(() => expect(hasRemoteChanges).toHaveBeenCalled());
  });

  it("wires syncOnNotebookOpen to navigate events carrying a notebookId in overview mode", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    vi.mocked(getAllNotesForSync).mockResolvedValue([]);
    vi.mocked(hasRemoteChanges).mockResolvedValue(false);
    initAutoSync();

    window.dispatchEvent(
      new CustomEvent("navigate", { detail: { mode: "overview", params: { notebookId: "nb1" } } }),
    );
    await vi.waitFor(() => expect(hasRemoteChanges).toHaveBeenCalledWith("nb1", []));
  });

  it("wires syncOnNoteCreate to the note-created event", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    initAutoSync();
    vi.mocked(performSync).mockClear();
    vi.advanceTimersByTime(5000); // clear cooldown left over from the startup sync

    window.dispatchEvent(new CustomEvent("note-created", { detail: { noteId: "n1" } }));
    await vi.waitFor(() => expect(performSync).toHaveBeenCalled());
  });

  it("wires syncOnNotebookCreate to the notebook-created event", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    initAutoSync();
    vi.mocked(performSync).mockClear();
    vi.advanceTimersByTime(5000);

    window.dispatchEvent(new CustomEvent("notebook-created", { detail: { notebookId: "nb1" } }));
    await vi.waitFor(() => expect(performSync).toHaveBeenCalled());
  });

  it("ignores note-created events without a noteId", async () => {
    vi.mocked(recognizeUnprocessedNotes).mockResolvedValue(0);
    initAutoSync();
    await vi.waitFor(() => expect(performSync).toHaveBeenCalled()); // wait out the startup sync
    vi.mocked(performSync).mockClear();

    window.dispatchEvent(new CustomEvent("note-created", { detail: {} }));
    await Promise.resolve();
    expect(performSync).not.toHaveBeenCalled();
  });
});
