/**
 * src/modules/liveNoteSync.test.js
 * The open note's own sync belongs to the sharing preview: nothing of it runs
 * (no request, no worker) while sharing is off. With it on, the main thread
 * brings the server's text and asks the worker; a note whose stored fields
 * cannot be read gets the server copy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sharing, nextcloud, storage } = vi.hoisted(() => ({
  sharing: { enabled: false },
  nextcloud: {
    isAuthenticated: vi.fn(),
    remoteFileEtag: vi.fn(),
    downloadNoteText: vi.fn(),
    getCurrentUserId: vi.fn(),
    listFiles: vi.fn(),
    uploadNoteText: vi.fn(),
  },
  storage: { getNoteIndex: vi.fn(), isLocalEncryptionEnabled: vi.fn() },
}));

vi.mock("./sharing/enabled.js", () => ({ isSharingEnabled: () => sharing.enabled }));
vi.mock("./autoSync.js", () => ({ isAutoSyncSuspended: () => false }));
vi.mock("../utils/perfMonitor.js", () => ({ perfAsync: (_name, fn) => fn() }));
vi.mock("./sync.js", () => ({ runExclusiveSync: (fn) => fn() }));
vi.mock("./storagePaths.js", () => ({
  getNotePath: (noteId) => `/notes/${noteId}.json`,
  getNoteMediaFolder: () => "/media",
}));

vi.mock("./nextcloudSync.js", () => nextcloud);

vi.mock("./storage.js", () => storage);

import { liveSyncOpenNote } from "./liveNoteSync.js";

const sync = (ask) =>
  liveSyncOpenNote({
    noteId: "n1",
    notebookId: null,
    ask,
    view: () => ({}),
    isIdle: () => true,
  });

beforeEach(() => {
  vi.clearAllMocks();
  sharing.enabled = true;
  nextcloud.isAuthenticated.mockResolvedValue(true);
  nextcloud.remoteFileEtag.mockResolvedValue("e2");
  nextcloud.getCurrentUserId.mockResolvedValue("bob");
  nextcloud.downloadNoteText.mockResolvedValue({ content: '{"id":"n1"}', etag: "e2" });
  storage.getNoteIndex.mockResolvedValue({ id: "n1", lastSyncedEtag: "e1", synced: false });
  storage.isLocalEncryptionEnabled.mockResolvedValue(true);
});

describe("the open note's own sync, part of the sharing preview", () => {
  it("does nothing while sharing is off: no request, no worker", async () => {
    sharing.enabled = false;
    const ask = vi.fn();
    expect(await sync(ask)).toEqual({ outcome: "skipped" });
    expect(nextcloud.isAuthenticated).not.toHaveBeenCalled();
    expect(nextcloud.remoteFileEtag).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("tells the worker about local encryption", async () => {
    const ask = vi.fn(async () => ({ action: "none" }));
    await sync(ask);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LIVE_SYNC", localEncryption: true }),
    );
  });

  it("brings the server copy when the worker cannot read stored fields and has changes to upload", async () => {
    nextcloud.remoteFileEtag.mockResolvedValue("e1"); // the server did not change
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ action: "need-remote" })
      .mockResolvedValueOnce({ action: "none" });
    expect(await sync(ask)).toEqual({ outcome: "unchanged" });
    expect(nextcloud.downloadNoteText).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0][0].remoteText).toBeNull();
    expect(ask.mock.calls[1][0].remoteText).toBe('{"id":"n1"}');
  });

  it("leaves it to the full sync when the server copy is not there", async () => {
    nextcloud.remoteFileEtag.mockResolvedValue("e1");
    nextcloud.downloadNoteText.mockResolvedValue({ content: null, etag: null });
    const ask = vi.fn().mockResolvedValueOnce({ action: "need-remote" });
    expect(await sync(ask)).toMatchObject({ outcome: "full" });
  });
});
