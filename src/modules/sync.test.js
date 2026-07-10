/**
 * src/modules/sync.test.js
 * performSync() is orchestration over nextcloudSync.fullSync/attemptMerge,
 * storage.js CRUD, and the manual-conflict dialog — all mocked here so we can
 * drive each branch (no conflicts, preferNewer auto-resolution, manual
 * resolution, race-condition merge, silent mode, and failure) deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showConflictResolutionDialog = vi.fn();
vi.mock("../components/modals.js", () => ({
  showConflictResolutionDialog: (...args) => showConflictResolutionDialog(...args),
}));

const attemptMerge = vi.fn();
const fullSync = vi.fn();
const isAuthenticated = vi.fn();
vi.mock("./nextcloudSync.js", () => ({
  attemptMerge: (...args) => attemptMerge(...args),
  fullSync: (...args) => fullSync(...args),
  isAuthenticated: (...args) => isAuthenticated(...args),
}));

const getAllNotebooksForSync = vi.fn();
const getAllNoteMetadataForSync = vi.fn();
const getNote = vi.fn();
const getNotebook = vi.fn();
const getNoteIndex = vi.fn();
const permanentlyDeleteNote = vi.fn();
const permanentlyDeleteNotebook = vi.fn();
const permanentlyDeleteNotesInNotebook = vi.fn();
const saveNote = vi.fn();
const saveNotebook = vi.fn();
const updateNoteEtag = vi.fn();
vi.mock("./storage.js", () => ({
  getAllNotebooksForSync: (...args) => getAllNotebooksForSync(...args),
  getAllNoteMetadataForSync: (...args) => getAllNoteMetadataForSync(...args),
  getNote: (...args) => getNote(...args),
  getNotebook: (...args) => getNotebook(...args),
  getNoteIndex: (...args) => getNoteIndex(...args),
  permanentlyDeleteNote: (...args) => permanentlyDeleteNote(...args),
  permanentlyDeleteNotebook: (...args) => permanentlyDeleteNotebook(...args),
  permanentlyDeleteNotesInNotebook: (...args) => permanentlyDeleteNotesInNotebook(...args),
  saveNote: (...args) => saveNote(...args),
  saveNotebook: (...args) => saveNotebook(...args),
  updateNoteEtag: (...args) => updateNoteEtag(...args),
}));

let performSync;
let getIsSyncing;
let getLastSyncResult;
let onSyncStatusChange;

function emptyResult(overrides = {}) {
  return {
    uploaded: {
      notes: { uploaded: 0, uploadedIds: [] },
      notebooks: { uploaded: 0, uploadedIds: [] },
    },
    downloaded: { notes: [], notebooks: [] },
    conflicts: { notes: [], notebooks: [] },
    notesToUpload: [],
    notesToDelete: [],
    notebooksToDelete: [],
    noteEtagsToUpdate: [],
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  isAuthenticated.mockResolvedValue(true);
  getAllNotebooksForSync.mockResolvedValue([]);
  getAllNoteMetadataForSync.mockResolvedValue([]);
  fullSync.mockResolvedValue(emptyResult());
  window.dispatchEvent = vi.fn();

  ({ performSync, getIsSyncing, getLastSyncResult, onSyncStatusChange } = await import(
    "./sync.js"
  ));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("performSync guard conditions", () => {
  it("returns null and skips when not authenticated", async () => {
    isAuthenticated.mockResolvedValue(false);
    const result = await performSync();
    expect(result).toBeNull();
    expect(fullSync).not.toHaveBeenCalled();
  });

  it("returns null when a sync is already in progress", async () => {
    let resolveFullSync;
    fullSync.mockReturnValue(new Promise((resolve) => (resolveFullSync = resolve)));

    const firstSync = performSync();
    // Let performSync progress far enough to set isSyncing = true.
    await Promise.resolve();
    await Promise.resolve();

    const secondResult = await performSync();
    expect(secondResult).toBeNull();

    resolveFullSync(emptyResult());
    await firstSync;
  });
});

describe("sync status notifications", () => {
  it("reports isSyncing true during sync and false after", async () => {
    const statuses = [];
    onSyncStatusChange((status) => statuses.push(status));

    expect(getIsSyncing()).toBe(false);
    await performSync();
    expect(getIsSyncing()).toBe(false);
    expect(statuses).toEqual([true, false]);
  });
});

describe("successful sync with no conflicts", () => {
  it("records a successful lastSyncResult with upload/download counts", async () => {
    fullSync.mockResolvedValue(
      emptyResult({
        uploaded: {
          notes: { uploaded: 2, uploadedIds: [] },
          notebooks: { uploaded: 1, uploadedIds: [] },
        },
      }),
    );

    const result = await performSync();
    expect(result).not.toBeNull();

    const last = getLastSyncResult();
    expect(last.success).toBe(true);
    expect(last.uploaded).toEqual({ notes: 2, notebooks: 1 });
  });

  it("does not dispatch datachange when nothing visible changed", async () => {
    await performSync();
    expect(window.dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "datachange" }),
    );
  });

  it("dispatches datachange when notes were downloaded", async () => {
    fullSync.mockResolvedValue(
      emptyResult({
        downloaded: {
          notes: [{ id: "n1", modified: 100, version: 1, lastSyncedEtag: "e1" }],
          notebooks: [],
        },
      }),
    );
    getNoteIndex.mockResolvedValue(null); // no local copy -> straightforward save

    await performSync();

    expect(saveNote).toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "datachange" }),
    );
  });
});

describe("marking uploaded items as synced", () => {
  it("marks an uploaded notebook synced with its returned etag", async () => {
    getNotebook.mockResolvedValue({ id: "nb1", synced: false });
    fullSync.mockResolvedValue(
      emptyResult({
        uploaded: {
          notes: { uploaded: 0, uploadedIds: [] },
          notebooks: {
            uploaded: 1,
            uploadedIds: ["nb1"],
            metadata: { nb1: { etag: "etag-nb1" } },
          },
        },
      }),
    );

    await performSync();

    expect(saveNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "nb1", synced: true, lastSyncedEtag: "etag-nb1" }),
    );
  });

  it("patches only the note etag (not full save) for uploaded notes", async () => {
    fullSync.mockResolvedValue(
      emptyResult({
        notesToUpload: [{ id: "n1", modified: 500 }],
        uploaded: {
          notes: {
            uploaded: 1,
            uploadedIds: ["n1"],
            metadata: { n1: { etag: "etag-n1" } },
          },
          notebooks: { uploaded: 0, uploadedIds: [] },
        },
      }),
    );

    await performSync();

    expect(updateNoteEtag).toHaveBeenCalledWith("n1", "etag-n1", 500);
    expect(saveNote).not.toHaveBeenCalled();
  });
});

describe("preferNewer automatic conflict resolution", () => {
  it("keeps the remote version when remote is newer, then re-syncs", async () => {
    const conflict = {
      local: { id: "n1", modified: 100 },
      remote: { id: "n1", modified: 200, _currentFileEtag: "etag-remote" },
    };
    fullSync
      .mockResolvedValueOnce(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }))
      .mockResolvedValueOnce(emptyResult());

    await performSync({ preferNewer: true, silent: true });

    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1", synced: true, lastSyncedEtag: "etag-remote" }),
    );
    expect(fullSync).toHaveBeenCalledTimes(2);
  });

  it("keeps the local version when local is newer or equal, then re-syncs", async () => {
    const conflict = {
      local: { id: "n1", modified: 300, version: 1 },
      remote: { id: "n1", modified: 200, version: 1, _currentFileEtag: "etag-remote" },
    };
    fullSync
      .mockResolvedValueOnce(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }))
      .mockResolvedValueOnce(emptyResult());

    await performSync({ preferNewer: true, silent: true });

    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1", synced: false, version: 2 }),
    );
    expect(fullSync).toHaveBeenCalledTimes(2);
  });

  it("stops after MAX_SYNC_PASSES (3) even if conflicts persist", async () => {
    const conflict = {
      local: { id: "n1", modified: 100, version: 1 },
      remote: { id: "n1", modified: 50, version: 1, _currentFileEtag: "etag-remote" },
    };
    fullSync.mockResolvedValue(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }));

    const result = await performSync({ preferNewer: true, silent: true });

    // The loop breaks once `pass >= MAX_SYNC_PASSES` instead of re-running,
    // so fullSync is called twice (pass 1 resolves+continues, pass 2 hits the cap).
    expect(fullSync).toHaveBeenCalledTimes(2);
    expect(result.conflicts.notes).toHaveLength(1);
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sync-conflicts" }),
    );
  });
});

describe("manual conflict resolution", () => {
  it("prompts the user and saves the local version on 'local' choice", async () => {
    const conflict = {
      local: { id: "n1", modified: 100, version: 1 },
      remote: { id: "n1", modified: 200, version: 1, _currentFileEtag: "etag-remote" },
    };
    fullSync
      .mockResolvedValueOnce(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }))
      .mockResolvedValueOnce(emptyResult());
    showConflictResolutionDialog.mockResolvedValue("local");

    await performSync({ silent: false });

    expect(showConflictResolutionDialog).toHaveBeenCalledWith(conflict.local, conflict.remote);
    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1", synced: false, version: 2 }),
    );
  });

  it("prompts the user and saves the remote version on 'remote' choice", async () => {
    const conflict = {
      local: { id: "n1", modified: 100 },
      remote: { id: "n1", modified: 200, _currentFileEtag: "etag-remote" },
    };
    fullSync
      .mockResolvedValueOnce(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }))
      .mockResolvedValueOnce(emptyResult());
    showConflictResolutionDialog.mockResolvedValue("remote");

    await performSync({ silent: false });

    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1", synced: true, lastSyncedEtag: "etag-remote" }),
    );
  });

  it("skips the dialog and reports conflicts when skipConflictResolution is set", async () => {
    const conflict = {
      local: { id: "n1", modified: 100 },
      remote: { id: "n1", modified: 200, _currentFileEtag: "etag-remote" },
    };
    fullSync.mockResolvedValue(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }));

    await performSync({ silent: false, skipConflictResolution: true });

    expect(showConflictResolutionDialog).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sync-conflicts" }),
    );
  });

  it("does not prompt in silent mode even without skipConflictResolution", async () => {
    const conflict = {
      local: { id: "n1", modified: 100 },
      remote: { id: "n1", modified: 200, _currentFileEtag: "etag-remote" },
    };
    fullSync.mockResolvedValue(emptyResult({ conflicts: { notes: [conflict], notebooks: [] } }));

    await performSync({ silent: true });

    expect(showConflictResolutionDialog).not.toHaveBeenCalled();
  });
});

describe("race condition handling on download", () => {
  it("attempts a merge when local changed during sync, and saves the merge result", async () => {
    const downloadedNote = { id: "n1", modified: 200, version: 2, lastSyncedEtag: "e2" };
    // originalLocalNote must be present (from the pre-sync metadata snapshot) and
    // differ from currentLocalIndex.modified for the race-condition branch to trigger.
    getAllNoteMetadataForSync.mockResolvedValue([{ id: "n1", modified: 50, version: 1 }]);
    fullSync.mockResolvedValue(
      emptyResult({ downloaded: { notes: [downloadedNote], notebooks: [] } }),
    );
    getNoteIndex.mockResolvedValue({ modified: 999, version: 5 }); // changed since original snapshot
    getNote.mockResolvedValue({ id: "n1", modified: 999, version: 5 });
    attemptMerge.mockReturnValue({ id: "n1", modified: 1000, version: 6, merged: true });

    await performSync();

    expect(attemptMerge).toHaveBeenCalled();
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ merged: true }));
  });

  it("keeps the local version when merge fails (text conflict)", async () => {
    const downloadedNote = { id: "n1", modified: 200, version: 2, lastSyncedEtag: "e2" };
    getAllNoteMetadataForSync.mockResolvedValue([{ id: "n1", modified: 50, version: 1 }]);
    fullSync.mockResolvedValue(
      emptyResult({ downloaded: { notes: [downloadedNote], notebooks: [] } }),
    );
    getNoteIndex.mockResolvedValue({ modified: 999, version: 5 });
    getNote.mockResolvedValue({ id: "n1", modified: 999, version: 5 });
    attemptMerge.mockReturnValue(null);

    await performSync();

    // sync.js's race-merge branch calls saveNote only when attemptMerge succeeds
    // (sync.js:334-342); on a failed merge it just warns and does nothing, so
    // saveNote must not be called at all here — not just "not with this shape".
    expect(saveNote).not.toHaveBeenCalled();
  });

  it("keeps the local version when local notebook changed during sync (no merge for notebooks)", async () => {
    const downloadedNotebook = { id: "nb1", modified: 200, lastSyncedEtag: "e2" };
    fullSync.mockResolvedValue(
      emptyResult({ downloaded: { notes: [], notebooks: [downloadedNotebook] } }),
    );
    getAllNotebooksForSync.mockResolvedValue([{ id: "nb1", modified: 100 }]);
    getNotebook.mockResolvedValue({ id: "nb1", modified: 999 }); // changed since sync started

    await performSync();

    expect(saveNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "nb1", synced: false, lastSyncedEtag: "e2" }),
    );
  });
});

describe("etag-only updates and deletions", () => {
  it("applies noteEtagsToUpdate without downloading content", async () => {
    fullSync.mockResolvedValue(
      emptyResult({ noteEtagsToUpdate: [{ id: "n1", etag: "e9", modified: 42 }] }),
    );

    await performSync();

    expect(updateNoteEtag).toHaveBeenCalledWith("n1", "e9", 42);
  });

  it("permanently deletes notes purged remotely", async () => {
    fullSync.mockResolvedValue(emptyResult({ notesToDelete: ["n-deleted"] }));

    await performSync();

    expect(permanentlyDeleteNote).toHaveBeenCalledWith("n-deleted");
  });

  it("permanently deletes notebooks (and their notes) purged remotely", async () => {
    fullSync.mockResolvedValue(emptyResult({ notebooksToDelete: ["nb-deleted"] }));

    await performSync();

    expect(permanentlyDeleteNotesInNotebook).toHaveBeenCalledWith("nb-deleted");
    expect(permanentlyDeleteNotebook).toHaveBeenCalledWith("nb-deleted");
  });
});

describe("failure handling", () => {
  it("records a failed lastSyncResult and rethrows", async () => {
    fullSync.mockRejectedValue(new Error("network down"));

    await expect(performSync()).rejects.toThrow("network down");

    const last = getLastSyncResult();
    expect(last.success).toBe(false);
    expect(last.error).toBe("network down");
  });

  it("resets isSyncing to false after a failure", async () => {
    fullSync.mockRejectedValue(new Error("boom"));
    await expect(performSync()).rejects.toThrow();
    expect(getIsSyncing()).toBe(false);
  });
});
