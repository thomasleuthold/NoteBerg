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
const getCurrentUserId = vi.fn();
const syncSharedNotebook = vi.fn();
vi.mock("./nextcloudSync.js", () => ({
  syncSharedNotebook: (...args) => syncSharedNotebook(...args),
  attemptMerge: (...args) => attemptMerge(...args),
  fullSync: (...args) => fullSync(...args),
  isAuthenticated: (...args) => isAuthenticated(...args),
  getCurrentUserId: (...args) => getCurrentUserId(...args),
}));

let sharingEnabled = false;
vi.mock("./sharing/enabled.js", () => ({
  isSharingEnabled: () => sharingEnabled,
}));
const prepareSharing = vi.fn();
const runDiscovery = vi.fn();
vi.mock("./sharing/nativeSharing.js", () => ({
  prepareSharing: (...args) => prepareSharing(...args),
  runDiscovery: (...args) => runDiscovery(...args),
}));

const refreshOwnerShares = vi.fn();
const refreshOwnerSharesIfStale = vi.fn();
vi.mock("./sharing/ownerShares.js", () => ({
  refreshOwnerShares: (...args) => refreshOwnerShares(...args),
  refreshOwnerSharesIfStale: (...args) => refreshOwnerSharesIfStale(...args),
}));

const isCollaborativeNote = vi.fn();
vi.mock("./sharing/collaboration.js", () => ({
  isCollaborativeNote: (...args) => isCollaborativeNote(...args),
}));

const getAllNotebooksForSync = vi.fn();
const getAllNoteMetadataForSync = vi.fn();
const getNote = vi.fn();
const getNoteBase = vi.fn();
const setNoteBase = vi.fn();
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
  getNoteBase: (...args) => getNoteBase(...args),
  setNoteBase: (...args) => setNoteBase(...args),
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
let whenSyncIdle;
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
  getCurrentUserId.mockResolvedValue("alice");
  syncSharedNotebook.mockResolvedValue(emptyResult());
  sharingEnabled = false;
  prepareSharing.mockResolvedValue(undefined);
  refreshOwnerShares.mockResolvedValue(false);
  refreshOwnerSharesIfStale.mockResolvedValue(false);
  runDiscovery.mockResolvedValue(null);
  getNoteBase.mockResolvedValue(null);
  isCollaborativeNote.mockResolvedValue(false);
  getAllNotebooksForSync.mockResolvedValue([]);
  getAllNoteMetadataForSync.mockResolvedValue([]);
  fullSync.mockResolvedValue(emptyResult());
  window.dispatchEvent = vi.fn();

  ({ performSync, getIsSyncing, getLastSyncResult, onSyncStatusChange, whenSyncIdle } =
    await import("./sync.js"));
});

describe("whenSyncIdle", () => {
  it("resolves at once when no sync is running", async () => {
    await expect(whenSyncIdle()).resolves.toBeUndefined();
  });

  it("resolves only once the running sync has finished", async () => {
    let finish;
    fullSync.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const running = performSync({ silent: true });
    await vi.waitFor(() => expect(fullSync).toHaveBeenCalled());

    let idle = false;
    const waiting = whenSyncIdle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(false);

    finish(emptyResult());
    await running;
    await waiting;
    expect(idle).toBe(true);
  });
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

describe("several passes", () => {
  const conflict = {
    local: { id: "n-c", modified: 100, version: 1 },
    remote: { id: "n-c", modified: 50, version: 1, _currentFileEtag: "etag-remote" },
  };

  it("applies each pass before the next one reads local state", async () => {
    // Pass 1 uploads one note and downloads another, and meets a conflict
    fullSync
      .mockResolvedValueOnce(
        emptyResult({
          notesToUpload: [{ id: "n-up", modified: 500 }],
          uploaded: {
            notes: { uploaded: 1, uploadedIds: ["n-up"], metadata: { "n-up": { etag: "e-up" } } },
            notebooks: { uploaded: 0, uploadedIds: [] },
          },
          downloaded: { notes: [{ id: "n-down", modified: 7, version: 1 }], notebooks: [] },
          conflicts: { notes: [conflict], notebooks: [] },
        }),
      )
      .mockImplementationOnce(async () => {
        // By the time pass 2 starts, pass 1's outcome is stored
        expect(updateNoteEtag).toHaveBeenCalledWith("n-up", "e-up", 500);
        expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n-down" }));
        return emptyResult();
      });

    await performSync({ preferNewer: true, silent: true });

    expect(fullSync).toHaveBeenCalledTimes(2);
    // The download of pass 1 is announced, though pass 2 brought nothing
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "datachange" }),
    );
    expect(getLastSyncResult()).toMatchObject({
      uploaded: { notes: 1, notebooks: 0 },
      downloaded: { notes: 1, notebooks: 0 },
    });
  });

  it("announces a conflict resolved by taking the remote version", async () => {
    const newerRemote = { ...conflict, remote: { ...conflict.remote, modified: 200 } };
    fullSync
      .mockResolvedValueOnce(emptyResult({ conflicts: { notes: [newerRemote], notebooks: [] } }))
      .mockResolvedValueOnce(emptyResult());

    await performSync({ preferNewer: true, silent: true });

    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "datachange" }),
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

    // The race-merge branch saves only when attemptMerge succeeds (after the
    // text merge it returns null only for structurally unmergeable notes, e.g. an
    // unloaded stub); on a failed merge it just warns and does nothing, so
    // saveNote must not be called at all here, not just "not with this shape".
    expect(saveNote).not.toHaveBeenCalled();
    expect(setNoteBase).not.toHaveBeenCalled();
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

describe("merge baselines", () => {
  it("records the uploaded text as the baseline, whatever the user typed meanwhile", async () => {
    fullSync.mockResolvedValue(
      emptyResult({
        uploaded: {
          notes: {
            uploaded: 1,
            uploadedIds: ["n1"],
            metadata: { n1: { etag: "e1", baseContent: "<p>as uploaded</p>" } },
          },
          notebooks: { uploaded: 0, uploadedIds: [] },
        },
        notesToUpload: [{ id: "n1", modified: 100 }],
      }),
    );

    await performSync();

    expect(setNoteBase).toHaveBeenCalledWith("n1", "<p>as uploaded</p>");
  });

  it("records the downloaded text as the baseline when a downloaded note is saved", async () => {
    const downloaded = { id: "n1", content: "<p>from server</p>", modified: 200, version: 2 };
    fullSync.mockResolvedValue(emptyResult({ downloaded: { notes: [downloaded], notebooks: [] } }));
    getNoteIndex.mockResolvedValue({ modified: 50, version: 1 });
    getAllNoteMetadataForSync.mockResolvedValue([{ id: "n1", modified: 50, version: 1 }]);

    await performSync();

    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
    expect(setNoteBase).toHaveBeenCalledWith("n1", "<p>from server</p>");
  });

  it("does not touch the baseline when a download only refreshes the etag", async () => {
    const downloaded = { id: "n1", content: "x", modified: 100, version: 3 };
    fullSync.mockResolvedValue(emptyResult({ downloaded: { notes: [downloaded], notebooks: [] } }));
    getAllNoteMetadataForSync.mockResolvedValue([{ id: "n1", modified: 100, version: 3 }]);
    getNoteIndex.mockResolvedValue({ modified: 100, version: 3 });

    await performSync();

    expect(updateNoteEtag).toHaveBeenCalled();
    expect(setNoteBase).not.toHaveBeenCalled();
  });

  it("merges against the baseline and attributes the local side when a race is detected", async () => {
    const downloaded = { id: "n1", content: "<p>server</p>", modified: 200, version: 2 };
    getAllNoteMetadataForSync.mockResolvedValue([{ id: "n1", modified: 50, version: 1 }]);
    fullSync.mockResolvedValue(emptyResult({ downloaded: { notes: [downloaded], notebooks: [] } }));
    getNoteIndex.mockResolvedValue({ modified: 999, version: 5 });
    getNote.mockResolvedValue({ id: "n1", modified: 999, version: 5 });
    getNoteBase.mockResolvedValue("<p>ancestor</p>");
    attemptMerge.mockReturnValue({ id: "n1", merged: true });

    await performSync();

    expect(attemptMerge).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      base: "<p>ancestor</p>",
      localAuthor: "alice",
    });
    // The merged note still has to upload, so the server's text stays the baseline
    expect(setNoteBase).toHaveBeenCalledWith("n1", "<p>server</p>");
  });

  it("takes the server's text as baseline when the user keeps the remote version", async () => {
    showConflictResolutionDialog.mockResolvedValue("remote");
    const local = { id: "n1", modified: 100 };
    const remote = { id: "n1", content: "<p>theirs</p>", modified: 200, _currentFileEtag: "e2" };
    fullSync
      .mockResolvedValueOnce(
        emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
      )
      .mockResolvedValueOnce(emptyResult());

    await performSync();

    expect(setNoteBase).toHaveBeenCalledWith("n1", "<p>theirs</p>");
  });

  it("leaves the baseline alone when the user keeps the local version", async () => {
    showConflictResolutionDialog.mockResolvedValue("local");
    const local = { id: "n1", modified: 100 };
    const remote = { id: "n1", modified: 200, _currentFileEtag: "e2" };
    fullSync
      .mockResolvedValueOnce(
        emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
      )
      .mockResolvedValueOnce(emptyResult());

    await performSync();

    expect(setNoteBase).not.toHaveBeenCalled();
  });
});

describe("conflicts on collaborative notes", () => {
  it("never shows the dialog; the newer version wins deterministically", async () => {
    isCollaborativeNote.mockResolvedValue(true);
    const local = { id: "n1", notebookId: "nb", modified: 100 };
    const remote = {
      id: "n1",
      notebookId: "nb",
      content: "r",
      modified: 200,
      _currentFileEtag: "e2",
    };
    fullSync
      .mockResolvedValueOnce(
        emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
      )
      .mockResolvedValueOnce(emptyResult());

    await performSync();

    expect(showConflictResolutionDialog).not.toHaveBeenCalled();
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n1", synced: true }));
  });

  it("still asks about conflicts on ordinary notes", async () => {
    showConflictResolutionDialog.mockResolvedValue("local");
    const local = { id: "n1", modified: 100 };
    const remote = { id: "n1", modified: 200, _currentFileEtag: "e2" };
    fullSync
      .mockResolvedValueOnce(
        emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
      )
      .mockResolvedValueOnce(emptyResult());

    await performSync();

    expect(showConflictResolutionDialog).toHaveBeenCalledOnce();
  });
});

describe("notebooks shared with this user", () => {
  beforeEach(() => {
    sharingEnabled = true;
  });

  const sharedNb = (overrides = {}) => ({
    id: "nb-shared",
    title: "Recipes",
    modified: 100,
    origin: "shared",
    remoteBasePath: "/Shared_NoteBerg/alice_Recipes",
    ownerUid: "alice",
    shareId: "42",
    sharePermissions: 7,
    ...overrides,
  });
  const ownNb = { id: "nb-own", title: "Mine", modified: 100 };
  const ownNote = { id: "n-own", notebookId: "nb-own", modified: 10 };
  const sharedNote = { id: "n-shared", notebookId: "nb-shared", modified: 10 };

  function seedLocal(notebooks, notes) {
    getAllNotebooksForSync.mockResolvedValue(notebooks);
    getAllNoteMetadataForSync.mockResolvedValue(notes);
  }

  it("keeps shared notebooks and their notes out of the own pass", async () => {
    seedLocal([ownNb, sharedNb()], [ownNote, sharedNote]);

    await performSync();

    const [ownNotebooks, ownNotes] = fullSync.mock.calls[0];
    expect(ownNotebooks.map((n) => n.id)).toEqual(["nb-own"]);
    expect(ownNotes.map((n) => n.id)).toEqual(["n-own"]);
  });

  // Sharing turned off after notebooks were shared with the user: they stay on
  // the device as they are. They are not the own pass's to touch (that would
  // read their notes as missing from /NoteBerg), and not synced either.
  it("leaves notebooks shared earlier alone while sharing is switched off", async () => {
    sharingEnabled = false;
    seedLocal([ownNb, sharedNb()], [ownNote, sharedNote]);

    await performSync();

    const [ownNotebooks, ownNotes] = fullSync.mock.calls[0];
    expect(ownNotebooks.map((n) => n.id)).toEqual(["nb-own"]);
    expect(ownNotes.map((n) => n.id)).toEqual(["n-own"]);
    expect(syncSharedNotebook).not.toHaveBeenCalled();
    expect(runDiscovery).not.toHaveBeenCalled();
  });

  it("runs one isolated pass per shared notebook with that notebook's notes only", async () => {
    const second = sharedNb({ id: "nb-second", remoteBasePath: "/Shared_NoteBerg/bob_X" });
    seedLocal(
      [ownNb, sharedNb(), second],
      [ownNote, sharedNote, { id: "n-second", notebookId: "nb-second", modified: 5 }],
    );

    await performSync();

    expect(syncSharedNotebook).toHaveBeenCalledTimes(2);
    const [firstNb, firstNotes] = syncSharedNotebook.mock.calls[0];
    expect(firstNb.id).toBe("nb-shared");
    expect(firstNotes.map((n) => n.id)).toEqual(["n-shared"]);
    expect(syncSharedNotebook.mock.calls[1][0].id).toBe("nb-second");
    expect(syncSharedNotebook.mock.calls[1][1].map((n) => n.id)).toEqual(["n-second"]);
  });

  it("does not sync a shared notebook whose share ended or whose mount is unknown", async () => {
    seedLocal(
      [sharedNb({ shareEnded: true }), sharedNb({ id: "nb-unmounted", remoteBasePath: null })],
      [sharedNote, { id: "n-u", notebookId: "nb-unmounted", modified: 1 }],
    );

    await performSync();

    expect(syncSharedNotebook).not.toHaveBeenCalled();
    // ...and they are not left for the own pass to find "missing" and heal
    expect(fullSync.mock.calls[0][0]).toEqual([]);
    expect(fullSync.mock.calls[0][1]).toEqual([]);
  });

  it("registers where each shared notebook lives, and makes the others unresolvable", async () => {
    const { getNotebookFolder } = await import("./storagePaths.js");
    seedLocal([sharedNb(), sharedNb({ id: "nb-ended", shareEnded: true }), ownNb], []);

    await performSync();

    expect(getNotebookFolder("nb-shared")).toBe("/Shared_NoteBerg/alice_Recipes");
    expect(() => getNotebookFolder("nb-ended")).toThrow(/ended/);
    expect(getNotebookFolder("nb-own")).toBe("/NoteBerg/notebooks/nb-own");
  });

  it("a failing shared pass affects neither the own pass nor the other shares", async () => {
    const second = sharedNb({ id: "nb-second", remoteBasePath: "/Shared_NoteBerg/bob_X" });
    seedLocal([ownNb, sharedNb(), second], []);
    syncSharedNotebook.mockRejectedValueOnce(new Error("503 from the share"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await performSync();

    expect(result).not.toBeNull();
    expect(syncSharedNotebook).toHaveBeenCalledTimes(2);
    expect(getLastSyncResult().success).toBe(true);
    consoleError.mockRestore();
  });

  it("reports shared notebooks whose root has gone, without applying anything", async () => {
    seedLocal([sharedNb()], [sharedNote]);
    syncSharedNotebook.mockResolvedValue({ ...emptyResult(), rootMissing: true });

    await performSync();

    expect(getLastSyncResult().sharedRootsMissing).toEqual(["nb-shared"]);
    expect(saveNote).not.toHaveBeenCalled();
    expect(saveNotebook).not.toHaveBeenCalled();
    expect(permanentlyDeleteNote).not.toHaveBeenCalled();
  });

  it("applies a shared pass's downloads like any other, keeping this device's sharing fields", async () => {
    const local = sharedNb();
    seedLocal([local], [sharedNote]);
    getNotebook.mockResolvedValue(local);
    syncSharedNotebook.mockResolvedValue(
      emptyResult({
        downloaded: {
          notes: [],
          notebooks: [
            { id: "nb-shared", title: "Renamed by owner", modified: 100, lastSyncedEtag: "e2" },
          ],
        },
      }),
    );

    await performSync();

    expect(saveNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Renamed by owner",
        origin: "shared",
        shareId: "42",
        sharePermissions: 7,
        ownerUid: "alice",
      }),
    );
  });

  it("ignores sharing fields a downloaded file claims, so an own notebook stays own", async () => {
    const downloaded = {
      id: "nb-own",
      title: "Mine",
      modified: 100,
      lastSyncedEtag: "e2",
      origin: "shared",
      sharePermissions: 31,
    };
    fullSync.mockResolvedValue(emptyResult({ downloaded: { notes: [], notebooks: [downloaded] } }));
    seedLocal([ownNb], []);
    getNotebook.mockResolvedValue(ownNb);

    await performSync();

    const saved = saveNotebook.mock.calls.at(-1)[0];
    expect(saved).not.toHaveProperty("origin");
    expect(saved).not.toHaveProperty("sharePermissions");
  });

  it("drops the fields from a notebook first seen in a download", async () => {
    const downloaded = {
      id: "nb9",
      title: "New",
      modified: 5,
      lastSyncedEtag: "e1",
      origin: "shared",
    };
    fullSync.mockResolvedValue(emptyResult({ downloaded: { notes: [], notebooks: [downloaded] } }));
    getNotebook.mockResolvedValue(undefined);

    await performSync();

    expect(saveNotebook.mock.calls.at(-1)[0]).not.toHaveProperty("origin");
  });

  it("refuses a downloaded shared note whose id is already one of this user's own notes", async () => {
    seedLocal([sharedNb(), ownNb], [ownNote]);
    // The sharer's file claims the id of an own note
    const hostile = { id: "n-own", notebookId: "nb-shared", modified: 99, version: 9 };
    syncSharedNotebook.mockResolvedValue(
      emptyResult({ downloaded: { notes: [hostile], notebooks: [] } }),
    );
    getNoteIndex.mockResolvedValue({ id: "n-own", notebookId: "nb-own", modified: 10 });

    await performSync();

    expect(saveNote).not.toHaveBeenCalled();
  });

  it("saves a downloaded shared note whose id is new or already in that notebook", async () => {
    seedLocal([sharedNb()], []);
    syncSharedNotebook.mockResolvedValue(
      emptyResult({
        downloaded: {
          notes: [{ id: "n-new", notebookId: "nb-shared", content: "c", modified: 5, version: 1 }],
          notebooks: [],
        },
      }),
    );
    getNoteIndex.mockResolvedValue(null);

    await performSync();

    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n-new" }));
  });

  it("records stranded notes on the notebook without marking it for upload", async () => {
    const local = sharedNb();
    seedLocal([local], [sharedNote]);
    getNotebook.mockResolvedValue(local);
    syncSharedNotebook.mockResolvedValue(emptyResult({ strandedNoteIds: ["n-shared"] }));

    await performSync();

    const saved = saveNotebook.mock.calls.at(-1)[0];
    expect(saved.strandedNoteIds).toEqual(["n-shared"]);
    expect(saved.synced).not.toBe(false);
  });

  it("clears the stranded list once nothing is stranded any more", async () => {
    const local = sharedNb({ strandedNoteIds: ["n-shared"] });
    seedLocal([local], [sharedNote]);
    getNotebook.mockResolvedValue(local);
    syncSharedNotebook.mockResolvedValue(emptyResult({ strandedNoteIds: [] }));

    await performSync();

    expect(saveNotebook.mock.calls.at(-1)[0].strandedNoteIds).toEqual([]);
  });

  it("does not rewrite the notebook when the stranded list is unchanged", async () => {
    const local = sharedNb({ strandedNoteIds: ["b", "a"] });
    seedLocal([local], []);
    getNotebook.mockResolvedValue(local);
    syncSharedNotebook.mockResolvedValue(emptyResult({ strandedNoteIds: ["a", "b"] }));

    await performSync();

    expect(saveNotebook).not.toHaveBeenCalled();
  });

  it("resolves a structurally unmergeable shared note by timestamp, never with a dialog", async () => {
    seedLocal([sharedNb()], [sharedNote]);
    const local = { id: "n-shared", notebookId: "nb-shared", modified: 100 };
    const remote = {
      id: "n-shared",
      notebookId: "nb-shared",
      modified: 200,
      _currentFileEtag: "e",
    };
    syncSharedNotebook.mockResolvedValue(
      emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
    );

    await performSync();

    expect(showConflictResolutionDialog).not.toHaveBeenCalled();
    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n-shared", synced: true }),
    );
  });

  it("announces a shared conflict resolved by taking the remote version", async () => {
    seedLocal([sharedNb()], [sharedNote]);
    const local = { id: "n-shared", notebookId: "nb-shared", modified: 100 };
    const remote = { id: "n-shared", notebookId: "nb-shared", modified: 200 };
    syncSharedNotebook.mockResolvedValue(
      emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
    );

    await performSync();

    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "datachange" }),
    );
  });

  it("uploads a shared note kept locally by a conflict resolution in the same sync", async () => {
    seedLocal([sharedNb()], [sharedNote]);
    const local = { id: "n-shared", notebookId: "nb-shared", modified: 300, version: 1 };
    const remote = { id: "n-shared", notebookId: "nb-shared", modified: 200, version: 1 };
    syncSharedNotebook
      .mockResolvedValueOnce(
        emptyResult({ conflicts: { notes: [{ local, remote }], notebooks: [] } }),
      )
      .mockResolvedValueOnce(emptyResult());

    await performSync();

    // A second pass for that notebook, with its notes read again
    expect(syncSharedNotebook).toHaveBeenCalledTimes(2);
    expect(syncSharedNotebook.mock.calls[1][0].id).toBe("nb-shared");
    expect(syncSharedNotebook.mock.calls[1][1].map((n) => n.id)).toEqual(["n-shared"]);
  });

  it("does no root guard or discovery while sharing is switched off", async () => {
    sharingEnabled = false;
    seedLocal([ownNb], [ownNote]);
    await performSync();
    expect(prepareSharing).not.toHaveBeenCalled();
    expect(runDiscovery).not.toHaveBeenCalled();
    expect(refreshOwnerShares).not.toHaveBeenCalled();
    expect(refreshOwnerSharesIfStale).not.toHaveBeenCalled();
  });

  it("looks for shares at once on a manual sync", async () => {
    sharingEnabled = true;
    seedLocal([ownNb], [ownNote]);

    await performSync({ silent: false });

    expect(prepareSharing).toHaveBeenCalledWith({ force: true });
    expect(refreshOwnerShares).toHaveBeenCalledTimes(1);
    expect(refreshOwnerSharesIfStale).not.toHaveBeenCalled();
  });

  it("leaves it to the minute-long interval on a background sync, which can come every few seconds", async () => {
    sharingEnabled = true;
    seedLocal([ownNb], [ownNote]);

    await performSync({ silent: true, skipConflictResolution: true });

    expect(prepareSharing).toHaveBeenCalledWith({ force: false });
    expect(refreshOwnerSharesIfStale).toHaveBeenCalledTimes(1);
    expect(refreshOwnerShares).not.toHaveBeenCalled();
  });

  it("looks at who the own notebooks are shared with after each sync, without waiting for it", async () => {
    sharingEnabled = true;
    seedLocal([ownNb], [ownNote]);
    let resolve;
    refreshOwnerShares.mockReturnValue(new Promise((r) => (resolve = r)));

    await performSync(); // returns although the refresh is still pending

    expect(refreshOwnerShares).toHaveBeenCalledTimes(1);
    resolve(true);
  });

  it("is not troubled by a failing look at the shares", async () => {
    sharingEnabled = true;
    seedLocal([ownNb], [ownNote]);
    refreshOwnerShares.mockRejectedValue(new Error("offline"));
    await expect(performSync()).resolves.not.toBeNull();
  });

  it("guards the root and discovers shares before anything is read, once sharing is on", async () => {
    sharingEnabled = true;
    const order = [];
    prepareSharing.mockImplementation(async () => void order.push("prepare"));
    getAllNotebooksForSync.mockImplementation(async () => {
      order.push("read-local");
      return [];
    });

    await performSync();

    expect(order[0]).toBe("prepare");
    expect(order).toContain("read-local");
  });

  it("aborts the sync, touching nothing, when the own root cannot be verified", async () => {
    sharingEnabled = true;
    prepareSharing.mockRejectedValue(new Error("cannot verify /NoteBerg"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(performSync()).rejects.toThrow(/cannot verify/);

    expect(fullSync).not.toHaveBeenCalled();
    expect(getLastSyncResult().success).toBe(false);
    consoleError.mockRestore();
  });

  it("re-runs discovery when a shared root turned out to be gone, to move or end the share", async () => {
    sharingEnabled = true;
    seedLocal([sharedNb()], [sharedNote]);
    syncSharedNotebook.mockResolvedValue({ ...emptyResult(), rootMissing: true });

    await performSync();

    expect(runDiscovery).toHaveBeenCalledTimes(1);
  });

  it("does not re-run discovery when every root was there", async () => {
    sharingEnabled = true;
    seedLocal([sharedNb()], [sharedNote]);
    await performSync();
    expect(runDiscovery).not.toHaveBeenCalled();
  });

  it("with no shares at all, behaves exactly as a plain sync", async () => {
    seedLocal([ownNb], [ownNote]);

    await performSync();

    expect(syncSharedNotebook).not.toHaveBeenCalled();
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(getLastSyncResult().sharedRootsMissing).toEqual([]);
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
