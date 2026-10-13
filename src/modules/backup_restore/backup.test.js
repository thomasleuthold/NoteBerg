/**
 * src/modules/backup_restore/backup.test.js
 *
 * The archive layout is the contract: these tests pin the entry names, what is
 * and is not written, and what the manifest claims — against an in-memory
 * archive, with no Tauri and no zip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage.js", async () => {
  const { createStorageMock } = await import("./__fixtures__/mockBackupStorage.js");
  return createStorageMock();
});

import { getFileStats, __store as store } from "../storage.js";
import {
  BACKUP_SCHEMA,
  BackupCancelledError,
  collectNoteFileIds,
  estimateBackupSize,
  getBackupFreshness,
  getEncryptByDefault,
  invalidateBackupEstimate,
  isBackupStale,
  MANIFEST_NAME,
  noteForArchive,
  recordBackupSuccess,
  runBackup,
  STALE_AFTER_MS,
  suggestedBackupFilename,
} from "./backup.js";
import { createMemoryArchive } from "./backupArchive.js";

const makeNotebook = (over = {}) => ({
  id: "nb-1",
  title: "Work",
  color: "#000",
  created: 1,
  modified: 2,
  version: 3,
  synced: true,
  lastSyncedEtag: "etag-nb",
  deleted: false,
  ...over,
});

const makeNote = (over = {}) => ({
  id: "note-1",
  notebookId: "nb-1",
  title: "Meeting",
  content: "<p>hi</p>",
  strokes: [{ id: "s1", x: [1], y: [1] }],
  media: [],
  recordings: [],
  pdfSource: null,
  created: 10,
  modified: 20,
  version: 4,
  synced: true,
  lastSyncedEtag: "etag-note",
  _currentFileEtag: "etag-file",
  previousNotebookId: "nb-0",
  encrypted: true,
  deleted: false,
  ...over,
});

const png = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
const pdf = () => new Blob([new Uint8Array(64)], { type: "application/pdf" });

async function backupToMemory(options = {}) {
  const archive = createMemoryArchive();
  const manifest = await runBackup(archive.writer, { appVersion: "0.5.42", ...options });
  return { archive, manifest, names: [...archive.entries.keys()] };
}

beforeEach(() => {
  store.reset();
  invalidateBackupEstimate();
  vi.clearAllMocks();
});

describe("archive layout", () => {
  it("writes notebooks, notes and quick notes under the Nextcloud sync paths", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote());
    store.seedNote(makeNote({ id: "quick-1", notebookId: null }));

    const { names } = await backupToMemory();

    expect(names).toContain("notebooks/nb-1/_notebook.json");
    expect(names).toContain("notebooks/nb-1/notes/note-1.json");
    expect(names).toContain("quickNotes/quick-1.json");
    expect(names).toContain(MANIFEST_NAME);
  });

  it("names media {fileId}{ext} under the note's media folder, by MIME type", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("img-1", png());
    store.seedNote(makeNote({ media: [{ id: "m1", fileId: "img-1", type: "image" }] }));

    const { names, archive } = await backupToMemory();

    expect(names).toContain("notebooks/nb-1/notes/note-1_media/img-1.png");
    expect(archive.entries.get("notebooks/nb-1/notes/note-1_media/img-1.png").blob.type).toBe(
      "image/png",
    );
  });

  it("writes a shared PDF binary once, however many pdf-page items reference it", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("pdf-1", pdf());
    const pages = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      fileId: "pdf-1",
      type: "pdf-page",
    }));
    store.seedNote(makeNote({ media: pages, pdfSource: "pdf-1" }));

    const { names, manifest } = await backupToMemory();

    expect(names.filter((n) => n.includes("_media/"))).toEqual([
      "notebooks/nb-1/notes/note-1_media/pdf-1.pdf",
    ]);
    expect(manifest.counts.files).toBe(1);
  });

  it("writes media before the note that references it", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("img-1", png());
    store.seedNote(makeNote({ media: [{ id: "m1", fileId: "img-1" }] }));

    const { names } = await backupToMemory();

    expect(names.indexOf("notebooks/nb-1/notes/note-1_media/img-1.png")).toBeLessThan(
      names.indexOf("notebooks/nb-1/notes/note-1.json"),
    );
  });

  it("includes recordings and skips blobs missing locally without failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.seedNotebook(makeNotebook());
    store.seedFile("rec-1", new Blob([new Uint8Array(8)], { type: "audio/webm" }));
    store.seedNote(
      makeNote({
        media: [{ id: "m1", fileId: "gone" }],
        recordings: [
          { id: "r1", fileId: "rec-1" },
          { id: "r2", fileId: "rec-deleted", deleted: true },
        ],
      }),
    );

    const { names, manifest } = await backupToMemory();

    expect(names).toContain("notebooks/nb-1/notes/note-1_media/rec-1.webm");
    expect(names.some((n) => n.includes("gone"))).toBe(false);
    expect(names.some((n) => n.includes("rec-deleted"))).toBe(false);
    expect(manifest.counts.files).toBe(1);
    // Ids only, never titles or content.
    expect(warn.mock.calls[0][0]).toContain("gone");
    expect(warn.mock.calls[0][0]).not.toContain("Meeting");
    warn.mockRestore();
  });

  it("strips sync-tracking fields and writes notes decrypted", async () => {
    store.seedNotebook(makeNotebook({ restoredAt: 5 }));
    store.seedNote(makeNote({ restoredAt: 5 }));

    const { archive } = await backupToMemory();
    const note = JSON.parse(archive.entries.get("notebooks/nb-1/notes/note-1.json").text);
    const notebook = JSON.parse(archive.entries.get("notebooks/nb-1/_notebook.json").text);

    for (const field of [
      "synced",
      "lastSyncedEtag",
      "_currentFileEtag",
      "previousNotebookId",
      "encrypted",
      "restoredAt",
    ]) {
      expect(note).not.toHaveProperty(field);
      expect(notebook).not.toHaveProperty(field);
    }
    // Content survives, as plain data.
    expect(note.strokes).toEqual([{ id: "s1", x: [1], y: [1] }]);
    expect(note.content).toBe("<p>hi</p>");
    // Version and modified are the note's own history and must be kept.
    expect(note.version).toBe(4);
    expect(note.modified).toBe(20);
  });

  it("includes recycle-bin items with their deleted flag but never purged stubs or tombstones", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNotebook(makeNotebook({ id: "nb-purged", purged: true, deleted: true }));
    store.seedNote(makeNote({ id: "binned", deleted: true }));
    store.seedNote(makeNote({ id: "stub", purged: true, deleted: true }));

    const { names, archive } = await backupToMemory();

    expect(names).toContain("notebooks/nb-1/notes/binned.json");
    expect(JSON.parse(archive.entries.get("notebooks/nb-1/notes/binned.json").text).deleted).toBe(
      true,
    );
    expect(names.some((n) => n.includes("stub"))).toBe(false);
    expect(names.some((n) => n.includes("nb-purged"))).toBe(false);
    expect(names.some((n) => n.includes("_tombstones"))).toBe(false);
  });

  it("fails rather than writing a note it cannot decrypt", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote({ locked: true }));

    await expect(backupToMemory()).rejects.toThrow(/locked/);
  });
});

describe("manifest", () => {
  it("records schema, versions, counts, byte total and encryption", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("img-1", png());
    store.seedNote(makeNote({ media: [{ id: "m1", fileId: "img-1" }] }));
    store.seedNote(makeNote({ id: "q", notebookId: null }));

    const { archive, manifest } = await backupToMemory({
      encrypted: true,
      appVersion: "1.2.3",
    });

    expect(manifest).toMatchObject({
      schema: BACKUP_SCHEMA,
      appVersion: "1.2.3",
      dbVersion: 5,
      encrypted: true,
      counts: { notebooks: 1, notes: 2, files: 1 },
    });
    expect(typeof manifest.createdAt).toBe("number");

    // totalBytes is the sum of every entry except the manifest itself.
    let sum = 0;
    for (const [name, e] of archive.entries) if (name !== MANIFEST_NAME) sum += e.size;
    expect(manifest.totalBytes).toBe(sum);

    // The manifest entry is the same object, and is written last.
    expect(JSON.parse(archive.entries.get(MANIFEST_NAME).text)).toEqual(manifest);
    expect([...archive.entries.keys()].at(-1)).toBe(MANIFEST_NAME);
  });

  it("carries nothing that could help guess the password", async () => {
    const { manifest } = await backupToMemory({ encrypted: true });
    expect(Object.keys(manifest).sort()).toEqual([
      "appVersion",
      "counts",
      "createdAt",
      "dbVersion",
      "encrypted",
      "schema",
      "totalBytes",
    ]);
  });
});

describe("progress and cancellation", () => {
  it("counts notebooks and notes as steps and names the media file being written", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("pdf-1", pdf());
    store.seedNote(makeNote({ pdfSource: "pdf-1" }));
    const reports = [];

    await backupToMemory({ onProgress: (p) => reports.push(p) });

    expect(reports[0]).toMatchObject({ current: 0, total: 2, phase: "notebook" });
    expect(reports.find((p) => p.phase === "media")).toMatchObject({ detail: "pdf-1.pdf" });
    expect(reports.at(-1)).toMatchObject({ current: 2, total: 2, phase: "finalize" });
  });

  it("stops at the next entry once cancelled and does not write a manifest", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote({ id: "a" }));
    store.seedNote(makeNote({ id: "b" }));
    const archive = createMemoryArchive();
    let written = 0;
    const isCancelled = () => written >= 2;
    const writer = {
      addText: async (...args) => {
        written++;
        return archive.writer.addText(...args);
      },
      addBinary: archive.writer.addBinary,
    };

    await expect(runBackup(writer, { isCancelled })).rejects.toBeInstanceOf(BackupCancelledError);
    expect(archive.entries.has(MANIFEST_NAME)).toBe(false);
    expect(archive.entries.size).toBe(2);
  });
});

describe("collectNoteFileIds", () => {
  it("returns each id once in media, pdf, recording order and skips deleted recordings", () => {
    const ids = collectNoteFileIds({
      media: [{ fileId: "a" }, { fileId: "a" }, { fileId: "b" }, {}],
      pdfSource: "a",
      recordings: [{ fileId: "c" }, { fileId: "d", deleted: true }],
    });
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("tolerates notes without media fields", () => {
    expect(collectNoteFileIds({})).toEqual([]);
  });
});

describe("noteForArchive", () => {
  it("does not mutate the input", () => {
    const note = makeNote();
    noteForArchive(note);
    expect(note.synced).toBe(true);
  });
});

describe("suggestedBackupFilename", () => {
  it("stamps local date and time down to the minute", () => {
    expect(suggestedBackupFilename(new Date(2026, 8, 15, 14, 30))).toBe(
      "noteberg-backup-2026-09-15T14-30.zip",
    );
  });
});

describe("freshness state", () => {
  it("records a successful backup and remembers the encrypt choice, never the password", async () => {
    await recordBackupSuccess({ noteCount: 340, bytes: 1000, encrypted: true, at: 123 });

    expect(await getBackupFreshness()).toEqual({
      lastBackupAt: 123,
      lastBackupNoteCount: 340,
      lastBackupBytes: 1000,
      lastBackupEncrypted: true,
    });
    expect(await getEncryptByDefault()).toBe(true);
    for (const value of store.settings.values()) expect(String(value)).not.toMatch(/pass/i);
  });

  it("reports never-backed-up as nulls", async () => {
    expect(await getBackupFreshness()).toMatchObject({ lastBackupAt: null });
    expect(await getEncryptByDefault()).toBe(false);
  });
});

describe("isBackupStale", () => {
  const now = 10 * STALE_AFTER_MS;
  const old = now - STALE_AFTER_MS - 1;
  const recent = now - 1000;

  it("nudges when there has never been a backup but there is something to back up", () => {
    expect(isBackupStale({ lastBackupAt: null }, 5, now)).toBe(true);
    expect(isBackupStale({ lastBackupAt: null }, 0, now)).toBe(false);
  });

  it("does not nudge for a recent backup regardless of growth", () => {
    expect(isBackupStale({ lastBackupAt: recent, lastBackupNoteCount: 10 }, 500, now)).toBe(false);
  });

  it("does not nudge for an old backup of an unchanged corpus", () => {
    expect(isBackupStale({ lastBackupAt: old, lastBackupNoteCount: 100 }, 100, now)).toBe(false);
  });

  it("nudges after 30 days once the corpus grew by 10% or 10 notes, whichever is smaller", () => {
    // Large corpus: 10 notes is less than 10%.
    expect(isBackupStale({ lastBackupAt: old, lastBackupNoteCount: 500 }, 509, now)).toBe(false);
    expect(isBackupStale({ lastBackupAt: old, lastBackupNoteCount: 500 }, 510, now)).toBe(true);
    // Small corpus: 10% (rounded up) is less than 10 notes.
    expect(isBackupStale({ lastBackupAt: old, lastBackupNoteCount: 20 }, 21, now)).toBe(false);
    expect(isBackupStale({ lastBackupAt: old, lastBackupNoteCount: 20 }, 22, now)).toBe(true);
  });
});

describe("estimateBackupSize", () => {
  it("walks the blob store once and reuses it until invalidated", async () => {
    store.seedFile("a", png());

    await estimateBackupSize();
    await estimateBackupSize();
    expect(getFileStats).toHaveBeenCalledTimes(1);

    store.seedFile("b", pdf());
    expect((await estimateBackupSize()).fileCount).toBe(1); // stale until told otherwise
    invalidateBackupEstimate();
    expect((await estimateBackupSize()).fileCount).toBe(2);
    expect(getFileStats).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed walk", async () => {
    getFileStats.mockRejectedValueOnce(new Error("db closed"));
    await expect(estimateBackupSize()).rejects.toThrow("db closed");
    store.seedFile("a", png());
    expect((await estimateBackupSize()).fileCount).toBe(1);
  });

  it("combines note counts with the blob store byte sum", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote());
    store.seedFile("a", png());
    store.seedFile("b", pdf());

    expect(await estimateBackupSize()).toEqual({
      notebookCount: 1,
      noteCount: 1,
      fileCount: 2,
      bytes: 68,
    });
  });
});
