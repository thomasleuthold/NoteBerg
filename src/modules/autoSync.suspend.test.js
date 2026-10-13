/**
 * src/modules/autoSync.suspend.test.js
 *
 * A restore rewrites the corpus over many seconds. Auto-sync is event-driven,
 * so a one-time getIsSyncing() check at the start cannot stop a sync from
 * beginning mid-restore from a navigate or note-created listener and racing
 * the writes. suspendAutoSync() must close every entry point for as long as
 * the caller holds it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./nextcloudSync.js", () => ({
  isAuthenticated: vi.fn().mockResolvedValue(true),
  hasRemoteChanges: vi.fn().mockResolvedValue(true),
}));

vi.mock("./storage.js", () => ({
  getNoteIndex: vi.fn().mockResolvedValue({ id: "n1", notebookId: null, synced: false }),
  getAllNotesForSync: vi.fn().mockResolvedValue([]),
}));

vi.mock("./sync.js", () => ({
  getIsSyncing: vi.fn().mockReturnValue(false),
  performSync: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("./autoRecognition.js", () => ({
  recognizeUnprocessedNotes: vi.fn().mockResolvedValue(0),
}));

import {
  isAutoSyncSuspended,
  resetInactivityTimer,
  resumeAutoSync,
  suspendAutoSync,
  syncOnAppStart,
  syncOnNotebookCreate,
  syncOnNotebookOpen,
  syncOnNoteClose,
  syncOnNoteCreate,
  syncOnNoteOpen,
} from "./autoSync.js";
import { performSync } from "./sync.js";

let fakeNow = 1_800_000_000_000;

beforeEach(() => {
  fakeNow += 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(fakeNow);
  vi.clearAllMocks();
});

afterEach(() => {
  while (isAutoSyncSuspended()) resumeAutoSync();
  vi.useRealTimers();
});

describe("suspendAutoSync", () => {
  it("is not suspended by default", () => {
    expect(isAutoSyncSuspended()).toBe(false);
  });

  it("blocks every event-driven entry point while held", async () => {
    suspendAutoSync();

    await syncOnNoteCreate("n1");
    await syncOnNotebookCreate("nb1");
    await syncOnNoteClose("n1");
    await syncOnNoteOpen("n1");
    await syncOnNotebookOpen("nb1");
    await syncOnAppStart();

    expect(performSync).not.toHaveBeenCalled();
  });

  it("does not let the inactivity timer fire a sync while held", async () => {
    suspendAutoSync();
    resetInactivityTimer("n1");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(performSync).not.toHaveBeenCalled();
  });

  it("cancels an inactivity timer that was already running", async () => {
    resetInactivityTimer("n1");
    suspendAutoSync();
    resumeAutoSync();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(performSync).not.toHaveBeenCalled();
  });

  it("resumes syncing after release", async () => {
    suspendAutoSync();
    await syncOnNoteCreate("n1");
    expect(performSync).not.toHaveBeenCalled();

    resumeAutoSync();
    await syncOnNoteCreate("n1");
    expect(performSync).toHaveBeenCalledTimes(1);
  });

  it("nests: a second holder cannot be released by the first", async () => {
    suspendAutoSync();
    suspendAutoSync();
    resumeAutoSync();
    expect(isAutoSyncSuspended()).toBe(true);
    await syncOnNoteCreate("n1");
    expect(performSync).not.toHaveBeenCalled();

    resumeAutoSync();
    expect(isAutoSyncSuspended()).toBe(false);
  });

  it("tolerates an unbalanced resume", () => {
    resumeAutoSync();
    expect(isAutoSyncSuspended()).toBe(false);
  });
});
