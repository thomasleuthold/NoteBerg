/**
 * src/components/backupSection.test.js
 *
 * The section's job before either button is pressed: say when the last backup
 * was, warn when that is stale, and size the job. Plus the helpers that turn
 * errors and numbers into what the user reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({
  t: (key, opts) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  getCurrentLanguage: () => "en",
}));

vi.mock("../modules/storage.js", async () => {
  const { createStorageMock } = await import(
    "../modules/backup_restore/__fixtures__/mockBackupStorage.js"
  );
  return { ...createStorageMock(), purgeLocalData: vi.fn() };
});

vi.mock("../modules/router.js", () => ({
  getCurrentMode: vi.fn(() => "overview"),
  getCurrentNoteId: vi.fn(() => null),
  navigateTo: vi.fn(),
}));

vi.mock("../modules/sync.js", () => ({
  getIsSyncing: vi.fn(() => false),
  performSync: vi.fn(),
}));

vi.mock("../modules/masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => true),
}));

vi.mock("../modules/autoSync.js", () => ({
  suspendAutoSync: vi.fn(),
  resumeAutoSync: vi.fn(),
}));

// The archive bridge is Tauri; the flows get an in-memory archive instead.
vi.mock("../modules/backup_restore/backupArchive.js", async (importOriginal) => ({
  ...(await importOriginal()),
  chooseRestoreSource: vi.fn(),
  openBackupReader: vi.fn(),
  chooseBackupDestination: vi.fn(),
  openBackupWriter: vi.fn(),
  getBackupFreeSpace: vi.fn(async () => null),
  abortBackup: vi.fn(),
}));

vi.mock("./backupModals.js", () => ({
  showBackupPasswordDialog: vi.fn(),
  showRestorePasswordPrompt: vi.fn(),
  showRestoreConfirmDialog: vi.fn(async () => true),
  showRestoreModeDialog: vi.fn(),
  showReplaceAllBlockedDialog: vi.fn(),
  showRestoreCompleteDialog: vi.fn(async () => {}),
}));

vi.mock("./modals.js", () => ({
  showAlertDialog: vi.fn(async () => {}),
  showConfirmDialog: vi.fn(async () => true),
  showProgressDialog: vi.fn(() => ({
    update: vi.fn(),
    indeterminate: vi.fn(),
    setNote: vi.fn(),
    disableCancel: vi.fn(),
    close: vi.fn(),
  })),
}));

import { resumeAutoSync, suspendAutoSync } from "../modules/autoSync.js";
import {
  invalidateBackupEstimate,
  runBackup,
  STALE_AFTER_MS,
} from "../modules/backup_restore/backup.js";
import {
  ArchiveError,
  chooseRestoreSource,
  createMemoryArchive,
  openBackupReader,
} from "../modules/backup_restore/backupArchive.js";
import { isAppUnlocked } from "../modules/masterPassword.js";
import { getCurrentMode, getCurrentNoteId } from "../modules/router.js";
import { getFileStats, saveNote, __store as store } from "../modules/storage.js";
import { getIsSyncing, performSync } from "../modules/sync.js";
import {
  describeRestoreError,
  formatBytes,
  formatRelativeTime,
  preflightMessage,
  progressDetail,
  renderBackupSection,
  runRestoreFlow,
} from "./backupSection.js";
import { showAlertDialog } from "./modals.js";

async function renderInto() {
  const div = document.createElement("div");
  div.innerHTML = await renderBackupSection();
  return div;
}

beforeEach(() => {
  store.reset();
  invalidateBackupEstimate();
  vi.clearAllMocks();
  getCurrentMode.mockReturnValue("overview");
  getCurrentNoteId.mockReturnValue(null);
  getIsSyncing.mockReturnValue(false);
  isAppUnlocked.mockReturnValue(true);
});

describe("formatBytes", () => {
  it("scales by 1024 and keeps one decimal below ten", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(180 * 1024 * 1024)).toBe("180 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_800_000_000_000;

  it("speaks in elapsed time, in the interface language", () => {
    expect(formatRelativeTime(now - 3 * 86400_000, now, "en")).toBe("3 days ago");
    expect(formatRelativeTime(now - 7 * 30 * 86400_000, now, "en")).toBe("7 months ago");
    expect(formatRelativeTime(now - 90_000, now, "en")).toBe("1 minute ago");
    expect(formatRelativeTime(now - 3 * 86400_000, now, "de")).toBe("vor 3 Tagen");
  });

  it("falls back to English for an unknown locale", () => {
    expect(formatRelativeTime(now - 3600_000, now, "xx-invalid-!!")).toBe("1 hour ago");
  });
});

describe("renderBackupSection", () => {
  it("says never backed up, in warning colour, with a nudge when there is something to protect", async () => {
    store.seedNote({ id: "n1", notebookId: null, deleted: false });
    const el = await renderInto();

    const line = el.querySelector("#backup-freshness");
    expect(line.textContent.trim()).toBe("backup.freshness.never");
    expect(line.classList.contains("backup-freshness--warning")).toBe(true);
    expect(el.querySelector("#backup-nudge").textContent).toBe("backup.freshness.neverNudge");
  });

  it("shows the last backup as elapsed time with the absolute time as a tooltip", async () => {
    const at = Date.now() - 3 * 86400_000;
    store.settings.set("lastBackupAt", at);
    store.settings.set("lastBackupNoteCount", 340);
    store.settings.set("lastBackupEncrypted", true);
    const el = await renderInto();

    const line = el.querySelector("#backup-freshness");
    expect(line.textContent).toContain('backup.freshness.last:{"when":"3 days ago","count":340}');
    expect(line.textContent).toContain("backup.freshness.encrypted");
    expect(line.getAttribute("title")).toBe(new Date(at).toLocaleString());
    expect(line.classList.contains("backup-freshness--warning")).toBe(false);
    expect(el.querySelector("#backup-nudge")).toBeNull();
  });

  it("nudges only when the backup is old AND the corpus grew", async () => {
    store.settings.set("lastBackupAt", Date.now() - STALE_AFTER_MS - 1000);
    store.settings.set("lastBackupNoteCount", 2);
    for (let i = 0; i < 2; i++) store.seedNote({ id: `n${i}`, notebookId: null });
    expect((await renderInto()).querySelector("#backup-nudge")).toBeNull();

    store.seedNote({ id: "n-new", notebookId: null });
    expect((await renderInto()).querySelector("#backup-nudge").textContent).toBe(
      "backup.freshness.staleNudge",
    );
  });

  it("shows the size estimate and pre-checks encryption from the last choice", async () => {
    store.seedNote({ id: "n1", notebookId: null });
    store.seedFile("f", new Blob([new Uint8Array(2048)]));
    store.settings.set("backupEncryptByDefault", true);
    const el = await renderInto();

    expect(el.querySelector("#backup-estimate").textContent).toBe(
      'backup.estimate:{"notes":1,"files":1,"size":"2.0 KB"}',
    );
    expect(el.querySelector("#backup-encrypt-toggle").checked).toBe(true);
    expect(el.querySelector(".settings-section").dataset.section).toBe("backup");
    expect(el.querySelector("h3").textContent).toBe("settings.sections.backup");
  });
});

describe("size estimate cache", () => {
  it("walks the blob store once across re-renders until the corpus changes", async () => {
    await renderInto();
    await renderInto();
    expect(getFileStats).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent("datachange"));
    await renderInto();
    expect(getFileStats).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new CustomEvent("notes-updated"));
    await renderInto();
    expect(getFileStats).toHaveBeenCalledTimes(3);
  });
});

describe("preflightMessage", () => {
  it("passes on the overview with no sync running", async () => {
    expect(await preflightMessage()).toBeNull();
  });

  it("names the open note as the blocker", async () => {
    getCurrentMode.mockReturnValue("notebook");
    getCurrentNoteId.mockReturnValue("n1");
    expect(await preflightMessage()).toBe("backup.errors.noteOpen");
  });

  it("names a running sync as the blocker", async () => {
    getIsSyncing.mockReturnValue(true);
    expect(await preflightMessage()).toBe("backup.errors.syncing");
  });

  it("names a locked app as the blocker when local encryption is on", async () => {
    store.settings.set("encrypt_local_data", true);
    isAppUnlocked.mockReturnValue(false);
    expect(await preflightMessage()).toBe("backup.errors.locked");
  });

  it("ignores the lock state when local encryption is off", async () => {
    isAppUnlocked.mockReturnValue(false);
    expect(await preflightMessage()).toBeNull();
  });
});

describe("describeRestoreError", () => {
  const err = (code, details) => Object.assign(new Error("raw"), { code, details });

  it("tells not-a-backup from corrupt, names the file, and escapes it", () => {
    expect(describeRestoreError(err("not-a-backup"), "x<b>.zip")).toBe(
      'backup.errors.notABackup:{"file":"x&lt;b&gt;.zip"}',
    );
    expect(describeRestoreError(err("corrupt"), "a.zip")).toContain("backup.errors.corrupt");
    expect(describeRestoreError(err("size-mismatch"), "a.zip")).toContain("backup.errors.corrupt");
  });

  it("turns a newer-version refusal into an upgrade prompt naming the version", () => {
    expect(describeRestoreError(err("db-newer", { appVersion: "9.0.0" }), "a.zip")).toBe(
      'backup.errors.newerVersion:{"version":"9.0.0"}',
    );
    expect(describeRestoreError(err("schema-newer", {}), "a.zip")).toContain('"version":"?"');
  });

  it("falls back to the raw message for anything else", () => {
    expect(describeRestoreError(new Error("boom"), "a.zip")).toBe("boom");
    expect(describeRestoreError(err("unsafe-entry"), "a.zip")).toContain("unsafeEntry");
    expect(describeRestoreError(err("entry-too-large"), "a.zip")).toContain("entryTooLarge");
  });
});

describe("progressDetail", () => {
  it("always yields a line, so the dialog height never jumps between phases", () => {
    expect(progressDetail("writing", { phase: "notebook" })).toBe(
      "backup.progress.writingNotebook",
    );
    expect(progressDetail("writing", { phase: "note" })).toBe("backup.progress.writingNote");
    expect(progressDetail("writing", { phase: "media", detail: "a.pdf" })).toBe(
      'backup.progress.writingMedia:{"name":"a.pdf","percent":0}',
    );
    expect(progressDetail("writing", { phase: "media", detail: "a.pdf", percent: 45 })).toBe(
      'backup.progress.writingMedia:{"name":"a.pdf","percent":45}',
    );
    expect(progressDetail("reading", { phase: "note" })).toBe("backup.progress.readingNote");
    expect(progressDetail("reading", { phase: "media", detail: "a.png" })).toContain(
      "readingMedia",
    );
  });
});

describe("runRestoreFlow", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const ctx = () => ({
    setRestoreStatus: vi.fn(),
    loadNextcloudSync: async () => ({ isAuthenticated: async () => true }),
  });

  /** Back the current store up into memory, wipe it, and hand the flow the archive. */
  async function stageArchive() {
    const archive = createMemoryArchive();
    await runBackup(archive.writer);
    store.reset();
    chooseRestoreSource.mockResolvedValue("C:/backups/noteberg.zip");
    openBackupReader.mockResolvedValue(archive.reader());
  }

  let updated;
  beforeEach(() => {
    updated = vi.fn();
    window.addEventListener("notes-updated", updated);
  });
  afterEach(() => window.removeEventListener("notes-updated", updated));

  it("restores, refreshes the overview, releases auto-sync and pushes with preferNewer", async () => {
    store.seedNote({ id: "n1", notebookId: null, title: "A", modified: 1, version: 1 });
    await stageArchive();

    await runRestoreFlow(ctx());
    await flush();

    expect(store.notes.get("n1")).toMatchObject({ synced: false, restoredAt: expect.any(Number) });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(suspendAutoSync).toHaveBeenCalledTimes(1);
    expect(resumeAutoSync).toHaveBeenCalledTimes(1);
    // Restored notes upload as-is; whatever the merge path cannot settle
    // resolves by timestamp, which the restore has just set.
    expect(performSync).toHaveBeenCalledWith({
      silent: true,
      skipConflictResolution: true,
      preferNewer: true,
    });
  });

  it("still refreshes the overview and releases auto-sync when apply fails partway", async () => {
    store.seedNote({ id: "n1", notebookId: null, title: "A", modified: 1, version: 1 });
    store.seedNote({ id: "n2", notebookId: null, title: "B", modified: 1, version: 1 });
    await stageArchive();
    const write = saveNote.getMockImplementation();
    saveNote.mockImplementationOnce(write).mockImplementationOnce(async () => {
      throw new Error("disk");
    });

    await runRestoreFlow(ctx());
    await flush();

    expect(store.notes.size).toBe(1); // the first note is real and must be shown
    expect(updated).toHaveBeenCalledTimes(1);
    expect(showAlertDialog).toHaveBeenCalledWith("backup.done.restoreFailedTitle", "disk");
    expect(resumeAutoSync).toHaveBeenCalledTimes(1);
    expect(performSync).not.toHaveBeenCalled();
  });

  it("reports the staging-space refusal from the Android picker in bytes", async () => {
    chooseRestoreSource.mockRejectedValue(new ArchiveError("no-space", "1048576 524288"));

    await runRestoreFlow(ctx());

    expect(showAlertDialog).toHaveBeenCalledWith(
      "backup.done.restoreFailedTitle",
      'backup.errors.cacheSpace:{"needed":"1.0 MB","available":"512 KB"}',
    );
    expect(suspendAutoSync).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
  });
});
