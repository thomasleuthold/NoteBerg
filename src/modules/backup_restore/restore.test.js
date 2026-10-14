/**
 * src/modules/backup_restore/restore.test.js
 *
 * The design risk of the feature lives here, so it is tested before any I/O
 * exists: a merge never loses a local note; every applied item re-enters sync
 * as a fresh local edit; displacement produces a renamed, binned copy under a
 * new id and the original id is reclaimed; version gating refuses archives
 * the app cannot read; entry names from the archive are treated as hostile.
 *
 * Archives are produced by the real backup.js into a memory archive, so the
 * two modules are held to the same layout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage.js", async () => {
  const { createStorageMock } = await import("./__fixtures__/mockBackupStorage.js");
  return createStorageMock();
});

import { __store as store } from "../storage.js";
import { MANIFEST_NAME, runBackup } from "./backup.js";
import { createMemoryArchive } from "./backupArchive.js";
import {
  applyRestore,
  checkCompatibility,
  indexArchive,
  MAX_ENTRY_BYTES,
  MAX_JSON_ENTRY_BYTES,
  MODE_MISSING,
  MODE_PREFER_BACKUP,
  MODE_REPLACE_ALL,
  parseManifest,
  planRestore,
  RestoreError,
  scanRestore,
  stripArchiveFields,
  withReplacedSuffix,
} from "./restore.js";

const makeNotebook = (over = {}) => ({
  id: "nb-1",
  title: "Work",
  created: 1,
  modified: 2,
  version: 3,
  synced: true,
  lastSyncedEtag: "e",
  deleted: false,
  ...over,
});

const makeNote = (over = {}) => ({
  id: "note-1",
  notebookId: "nb-1",
  title: "Meeting",
  content: "<p>backup</p>",
  strokes: [],
  media: [],
  recordings: [],
  pdfSource: null,
  created: 10,
  modified: 1000,
  version: 4,
  synced: true,
  lastSyncedEtag: "e",
  deleted: false,
  ...over,
});

const png = () => new Blob([new Uint8Array([9, 9, 9])], { type: "image/png" });

/** Back up the current store into a memory archive and return its reader. */
async function snapshot({ password = null } = {}) {
  const archive = createMemoryArchive({ password });
  await runBackup(archive.writer, { appVersion: "0.5.42", encrypted: password != null });
  return archive;
}

/** The full read path a UI would run: manifest → gate → index → scan. */
async function openAndScan(archive) {
  const reader = archive.reader();
  const manifest = parseManifest(reader.manifestText);
  checkCompatibility(manifest);
  const index = indexArchive(reader.entries, manifest);
  const scan = await scanRestore(reader, index);
  return { reader, manifest, index, scan };
}

async function restoreWith(archive, planOptions, applyOptions = {}) {
  const { reader, index, scan } = await openAndScan(archive);
  const plan = planRestore(scan, planOptions);
  const summary = await applyRestore(reader, index, plan, { now: () => 5000, ...applyOptions });
  return { scan, plan, summary };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

// ─── Manifest and version gating ──────────────────────────────────────────────

describe("parseManifest", () => {
  it("rejects non-JSON and JSON that is not a manifest as not-a-backup", () => {
    for (const text of ["", "nope", "[]", '{"foo":1}', '{"schema":"1","counts":{}}']) {
      let err;
      try {
        parseManifest(text);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.code).toBe("not-a-backup");
    }
  });

  it("accepts the manifest backup.js writes", async () => {
    const archive = await snapshot();
    expect(parseManifest(archive.reader().manifestText)).toMatchObject({ schema: 1, dbVersion: 5 });
  });
});

describe("checkCompatibility", () => {
  const base = { schema: 1, dbVersion: 5, appVersion: "9.9.9" };

  it("refuses a newer schema, naming the app version that wrote it", () => {
    expect(() => checkCompatibility({ ...base, schema: 2 })).toThrow(RestoreError);
    try {
      checkCompatibility({ ...base, schema: 2 });
    } catch (e) {
      expect(e.code).toBe("schema-newer");
      expect(e.details.appVersion).toBe("9.9.9");
    }
  });

  it("refuses a newer DB version", () => {
    let err;
    try {
      checkCompatibility({ ...base, dbVersion: 6 });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("db-newer");
  });

  it("accepts equal and older versions", () => {
    expect(() => checkCompatibility(base)).not.toThrow();
    expect(() => checkCompatibility({ ...base, schema: 0, dbVersion: 4 })).not.toThrow();
  });
});

// ─── Entry indexing and safety ────────────────────────────────────────────────

describe("indexArchive", () => {
  const manifest = { totalBytes: 10_000 };

  it("classifies notebooks, notes, quick notes and media, and ignores tombstones", () => {
    const index = indexArchive(
      [
        { name: "notebooks/nb-1/_notebook.json", size: 10 },
        { name: "notebooks/nb-1/_tombstones.json", size: 10 },
        { name: "notebooks/_tombstones.json", size: 10 },
        { name: "notebooks/nb-1/notes/n-1.json", size: 10 },
        { name: "notebooks/nb-1/notes/n-1_media/f-1.png", size: 10 },
        { name: "quickNotes/q-1.json", size: 10 },
        { name: "quickNotes/q-1_media/f-2.pdf", size: 10 },
        { name: "quickNotes/_tombstones.json", size: 10 },
        { name: "notebooks/nb-1/notes/", size: 0 },
        { name: "README.txt", size: 10 },
        { name: MANIFEST_NAME, size: 10 },
      ],
      manifest,
    );

    expect([...index.notebooks.keys()]).toEqual(["nb-1"]);
    expect(index.notes.get("n-1")).toEqual({
      name: "notebooks/nb-1/notes/n-1.json",
      notebookId: "nb-1",
    });
    expect(index.notes.get("q-1")).toEqual({ name: "quickNotes/q-1.json", notebookId: null });
    expect(index.media.get("n-1")).toEqual([
      {
        name: "notebooks/nb-1/notes/n-1_media/f-1.png",
        fileId: "f-1",
        mimeType: "image/png",
        size: 10,
      },
    ]);
    expect(index.media.get("q-1")[0]).toMatchObject({ fileId: "f-2", mimeType: "application/pdf" });
  });

  it("rejects the whole archive on a path-traversal id rather than skipping the entry", () => {
    const hostile = [
      "notebooks/../../Photos/_notebook.json",
      "notebooks/nb-1/notes/..%2F..%2Fetc.json",
      "quickNotes/a b.json",
      "notebooks/nb-1/notes/n-1_media/../../x.png",
      "notebooks/nb-1/notes/n-1_media/f.png/../x",
    ];
    for (const name of hostile) {
      let err;
      try {
        indexArchive([{ name, size: 1 }], manifest);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(RestoreError);
      expect(err.code, name).toBe("unsafe-entry");
    }
  });

  it("refuses an entry above the size ceiling before anything is allocated", () => {
    let err;
    try {
      indexArchive([{ name: "quickNotes/q-1.json", size: MAX_ENTRY_BYTES + 1 }], manifest);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("entry-too-large");
  });

  it("refuses an implausible compression ratio (zip bomb)", () => {
    let err;
    try {
      indexArchive(
        // Under the JSON ceiling, so the ratio guard is what fires.
        [{ name: "quickNotes/q-1.json", size: 32 * 1024 * 1024, compressedSize: 1000 }],
        { totalBytes: 64 * 1024 * 1024 },
      );
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("corrupt");
  });

  it("refuses a listing whose sizes far exceed what the manifest claims", () => {
    let err;
    try {
      indexArchive(
        [{ name: "quickNotes/q-1.json", size: 50 * 1024 * 1024, compressedSize: 10 * 1024 * 1024 }],
        { totalBytes: 1000 },
      );
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("size-mismatch");
  });
});

// ─── Empty device ─────────────────────────────────────────────────────────────

describe("restore onto an empty device", () => {
  it("scans as no local data with every item new, and no conflicts", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote());
    store.seedNote(makeNote({ id: "q-1", notebookId: null }));
    const archive = await snapshot();
    store.reset();

    const { scan } = await openAndScan(archive);

    expect(scan.hasLocalData).toBe(false);
    expect(scan.counts).toEqual({
      notebooks: 1,
      notes: 2,
      newNotes: 2,
      sameNotes: 0,
      conflicts: 0,
      backupNewer: 0,
      localNewer: 0,
    });
    expect(scan.conflicts).toEqual([]);
  });

  it("writes everything and re-dirties every item for the next sync", async () => {
    store.seedNotebook(makeNotebook({ version: 7, modified: 99 }));
    store.seedFile("img-1", png());
    store.seedNote(makeNote({ media: [{ id: "m1", fileId: "img-1" }] }));
    const archive = await snapshot();
    store.reset();

    const { summary } = await restoreWith(archive, { mode: MODE_MISSING });

    expect(summary).toMatchObject({
      restored: 1,
      skipped: 0,
      replaced: 0,
      notebooksCreated: 1,
      cancelled: false,
    });

    const nb = store.notebooks.get("nb-1");
    expect(nb).toMatchObject({
      title: "Work",
      synced: false,
      lastSyncedEtag: null,
      version: 8,
      modified: 5000,
    });

    const note = store.notes.get("note-1");
    expect(note).toMatchObject({
      title: "Meeting",
      content: "<p>backup</p>",
      notebookId: "nb-1",
      synced: false,
      lastSyncedEtag: null,
      version: 5,
      modified: 5000,
      deleted: false,
    });
    expect(note).not.toHaveProperty("encrypted");

    const blob = store.files.get("img-1");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("every mode produces the same result when nothing exists locally", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote());
    const archive = await snapshot();

    for (const mode of [MODE_MISSING, MODE_PREFER_BACKUP, MODE_REPLACE_ALL]) {
      store.reset();
      const { plan } = await restoreWith(archive, { mode });
      expect(plan.counts).toMatchObject({ write: 1, skip: 0, displace: 0 });
      expect(store.notes.get("note-1").content).toBe("<p>backup</p>");
    }
  });
});

// ─── Conflicts ────────────────────────────────────────────────────────────────

describe("conflict detection", () => {
  async function archiveWithNote(over) {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote(over));
    const archive = await snapshot();
    store.reset();
    store.seedNotebook(makeNotebook());
    return archive;
  }

  it("treats a same-version local copy as the same note, whatever its modified time", async () => {
    const archive = await archiveWithNote({ version: 4, modified: 1000 });
    store.seedNote(makeNote({ version: 4, modified: 7777, content: "<p>local</p>" }));

    const { scan } = await openAndScan(archive);

    expect(scan.notes[0].status).toBe("same");
    expect(scan.counts.conflicts).toBe(0);
  });

  it("flags a conflict only when both version and modified differ, and says which side is newer", async () => {
    const archive = await archiveWithNote({ version: 4, modified: 1000 });
    store.seedNote(makeNote({ id: "note-1", version: 9, modified: 2000, content: "<p>local</p>" }));

    const { scan } = await openAndScan(archive);

    expect(scan.conflicts).toHaveLength(1);
    expect(scan.conflicts[0]).toMatchObject({
      id: "note-1",
      status: "conflict",
      backupNewer: false,
      backup: { modified: 1000, version: 4 },
      local: { modified: 2000, version: 9 },
    });
    expect(scan.counts).toMatchObject({ conflicts: 1, localNewer: 1, backupNewer: 0 });
  });

  it("does not surface a purged stub as a conflict", async () => {
    const archive = await archiveWithNote({});
    store.seedNote({ id: "note-1", purged: true, deleted: true, version: 5, modified: 9 });

    const { scan } = await openAndScan(archive);
    expect(scan.notes[0].status).toBe("new");
  });
});

describe("planRestore", () => {
  const scan = {
    notebooks: [
      { id: "nb-new", name: "n", status: "new" },
      { id: "nb-keep", name: "n", status: "keep" },
      { id: "nb-undel", name: "n", status: "undelete" },
    ],
    notes: [
      { id: "new", name: "a", notebookId: null, status: "new", local: null, backupNewer: false },
      { id: "same", name: "b", notebookId: null, status: "same", local: {}, backupNewer: false },
      {
        id: "bnewer",
        name: "c",
        notebookId: null,
        status: "conflict",
        local: {},
        backupNewer: true,
      },
      {
        id: "lnewer",
        name: "d",
        notebookId: null,
        status: "conflict",
        local: {},
        backupNewer: false,
      },
    ],
  };
  const actionOf = (plan, id) => plan.notes.find((n) => n.id === id);

  it("missing: adds only what is absent locally, skipping every conflict", () => {
    const plan = planRestore(scan, { mode: MODE_MISSING });
    expect(actionOf(plan, "new").action).toBe("write");
    expect(actionOf(plan, "same").action).toBe("skip");
    expect(actionOf(plan, "bnewer").action).toBe("skip");
    expect(actionOf(plan, "lnewer").action).toBe("skip");
    expect(plan.counts).toMatchObject({ write: 1, skip: 3, displace: 0 });
  });

  it("preferBackup: backup wins where newer, local wins otherwise, and displaces the local copy", () => {
    const plan = planRestore(scan, { mode: MODE_PREFER_BACKUP });
    expect(actionOf(plan, "bnewer")).toMatchObject({ action: "write", displace: true });
    expect(actionOf(plan, "lnewer")).toMatchObject({ action: "skip", displace: false });
    expect(actionOf(plan, "new")).toMatchObject({ action: "write", displace: false });
    expect(actionOf(plan, "same").action).toBe("skip");
  });

  it("preferBackup: a review decision overrides the timestamp rule in both directions", () => {
    const plan = planRestore(scan, {
      mode: MODE_PREFER_BACKUP,
      decisions: { bnewer: "local", lnewer: "backup" },
    });
    expect(actionOf(plan, "bnewer").action).toBe("skip");
    expect(actionOf(plan, "lnewer")).toMatchObject({ action: "write", displace: true });
  });

  it("never rewrites a same-version note even when told to prefer backup", () => {
    const plan = planRestore(scan, { mode: MODE_PREFER_BACKUP, decisions: { same: "backup" } });
    expect(actionOf(plan, "same").action).toBe("skip");
  });

  it("maps notebook statuses to create / undelete / keep in every mode", () => {
    for (const mode of [MODE_MISSING, MODE_PREFER_BACKUP, MODE_REPLACE_ALL]) {
      const plan = planRestore(scan, { mode });
      expect(plan.notebooks.map((n) => n.action)).toEqual(["create", "keep", "undelete"]);
    }
    expect(planRestore(scan, { mode: MODE_MISSING }).counts).toMatchObject({
      createNotebooks: 1,
      undeleteNotebooks: 1,
    });
  });
});

// ─── Displacement (Tier 3) ────────────────────────────────────────────────────

describe("displacement", () => {
  async function conflictingArchive() {
    store.seedNotebook(makeNotebook());
    store.seedFile("img-backup", png());
    store.seedNote(
      makeNote({ version: 4, modified: 9000, media: [{ id: "m1", fileId: "img-backup" }] }),
    );
    const archive = await snapshot();
    store.reset();
    store.seedNotebook(makeNotebook());
    store.seedFile("img-local", png());
    store.seedNote(
      makeNote({
        version: 6,
        modified: 1000,
        content: "<p>local</p>",
        media: [{ id: "m1", fileId: "img-local" }],
      }),
    );
    return archive;
  }

  it("keeps the local note as a renamed, binned copy under a new id and reclaims the original id", async () => {
    const archive = await conflictingArchive();

    const { summary } = await restoreWith(archive, { mode: MODE_PREFER_BACKUP });

    expect(summary).toMatchObject({ restored: 1, replaced: 1, skipped: 0 });

    const restored = store.notes.get("note-1");
    expect(restored.content).toBe("<p>backup</p>");
    expect(restored.title).toBe("Meeting"); // the suffix goes on the copy, never the restored note
    expect(restored.version).toBe(7); // bumped past the local 6, so it wins the next sync
    expect(restored).toMatchObject({ synced: false, lastSyncedEtag: null, modified: 5000 });

    const copies = [...store.notes.values()].filter((n) => n.id !== "note-1");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      title: "Meeting (replaced)",
      deleted: true,
      content: "<p>local</p>",
      notebookId: "nb-1",
      synced: false,
    });
    // The copy owns its own blob: purging one must not delete the other's.
    expect(copies[0].media[0].fileId).not.toBe("img-local");
    expect(store.files.has(copies[0].media[0].fileId)).toBe(true);
    expect(store.files.has("img-backup")).toBe(true);
  });

  it("never loses a local note in any mode", async () => {
    for (const mode of [MODE_MISSING, MODE_PREFER_BACKUP]) {
      const archive = await conflictingArchive();
      await restoreWith(archive, { mode, decisions: { "note-1": "backup" } });
      const contents = [...store.notes.values()].map((n) => n.content);
      expect(contents, mode).toContain("<p>local</p>");
    }
  });

  it("uses the translated suffix and does not double it on a repeat restore", async () => {
    const archive = await conflictingArchive();
    await restoreWith(
      archive,
      { mode: MODE_PREFER_BACKUP, decisions: { "note-1": "backup" } },
      { replacedSuffix: "(ersetzt)" },
    );
    // Second run: the restored note is now a same-version copy of the backup,
    // so it is skipped; force it via a decision after bumping the local.
    store.notes.get("note-1").version = 42;
    store.notes.get("note-1").modified = 1;
    await restoreWith(
      archive,
      { mode: MODE_PREFER_BACKUP, decisions: { "note-1": "backup" } },
      { replacedSuffix: "(ersetzt)" },
    );

    const titles = [...store.notes.values()].map((n) => n.title).sort();
    expect(titles).toEqual(["Meeting", "Meeting (ersetzt)", "Meeting (ersetzt)"]);
  });
});

describe("withReplacedSuffix", () => {
  it("appends once and is idempotent", () => {
    expect(withReplacedSuffix("Notes", "(replaced)")).toBe("Notes (replaced)");
    expect(withReplacedSuffix("Notes (replaced)", "(replaced)")).toBe("Notes (replaced)");
    expect(withReplacedSuffix("Notes (replaced) ", "(replaced)")).toBe("Notes (replaced)");
  });

  it("handles empty and missing titles", () => {
    expect(withReplacedSuffix("", "(replaced)")).toBe("(replaced)");
    expect(withReplacedSuffix(undefined, "(replaced)")).toBe("(replaced)");
  });
});

// ─── Notebooks ────────────────────────────────────────────────────────────────

describe("notebooks", () => {
  it("keeps the local notebook when the id exists with a different title, and restores notes into it", async () => {
    store.seedNotebook(makeNotebook({ title: "Old name" }));
    store.seedNote(makeNote());
    const archive = await snapshot();
    store.reset();
    store.seedNotebook(makeNotebook({ title: "Renamed locally", version: 8 }));

    const { scan, summary } = await restoreWith(archive, { mode: MODE_MISSING });

    expect(scan.notebooks[0]).toMatchObject({
      status: "keep",
      titleDiffers: true,
      localTitle: "Renamed locally",
    });
    expect(store.notebooks.get("nb-1")).toMatchObject({ title: "Renamed locally", version: 8 });
    expect(summary.notebooksCreated).toBe(0);
    expect(store.notes.get("note-1").notebookId).toBe("nb-1");
  });

  it("un-deletes a locally deleted notebook the archive says should exist", async () => {
    store.seedNotebook(makeNotebook());
    const archive = await snapshot();
    store.reset();
    store.seedNotebook(makeNotebook({ deleted: true, version: 2 }));

    const { summary } = await restoreWith(archive, { mode: MODE_MISSING });

    expect(summary.notebooksRestored).toBe(1);
    expect(store.notebooks.get("nb-1")).toMatchObject({
      deleted: false,
      synced: false,
      version: 3,
    });
  });

  it("restores a soft-deleted notebook from the archive into the recycle bin", async () => {
    store.seedNotebook(makeNotebook({ deleted: true }));
    const archive = await snapshot();
    store.reset();

    await restoreWith(archive, { mode: MODE_MISSING });

    expect(store.notebooks.get("nb-1")).toMatchObject({ deleted: true, synced: false });
  });
});

// ─── Media, cancellation, corruption ──────────────────────────────────────────

describe("media", () => {
  it("does not rewrite a blob whose fileId already exists locally", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("img-1", png());
    store.seedNote(makeNote({ media: [{ id: "m1", fileId: "img-1" }] }));
    const archive = await snapshot();
    const reader = archive.reader();
    const readBinary = vi.spyOn(reader, "readBinary");
    store.notes.clear();

    const index = indexArchive(reader.entries, parseManifest(reader.manifestText));
    const plan = planRestore(await scanRestore(reader, index), { mode: MODE_MISSING });
    await applyRestore(reader, index, plan);

    expect(readBinary).not.toHaveBeenCalled();
    expect(store.files.size).toBe(1);
  });
});

describe("cancellation", () => {
  it("stops between notes, keeps what was written, and reports the partial count", async () => {
    store.seedNotebook(makeNotebook());
    for (let i = 0; i < 4; i++) store.seedNote(makeNote({ id: `n-${i}` }));
    const archive = await snapshot();
    store.reset();

    let cancelled = false;
    const { summary } = await restoreWith(
      archive,
      { mode: MODE_MISSING },
      {
        isCancelled: () => cancelled,
        onProgress: (p) => {
          // Raised while the second note is being written: the third is never started.
          if (p.phase === "note" && p.current === 2) cancelled = true;
        },
      },
    );

    expect(summary.cancelled).toBe(true);
    expect(summary.restored).toBe(2);
    expect(summary.total).toBe(4);
    expect(store.notes.size).toBe(2);
    for (const note of store.notes.values()) expect(note.synced).toBe(false);
  });

  it("is idempotent: re-running after a cancel finishes the rest and leaves restored notes alone", async () => {
    store.seedNotebook(makeNotebook());
    for (let i = 0; i < 3; i++) store.seedNote(makeNote({ id: `n-${i}` }));
    const archive = await snapshot();
    store.reset();
    let cancelled = false;
    const first = await restoreWith(
      archive,
      { mode: MODE_MISSING },
      {
        isCancelled: () => cancelled,
        onProgress: (p) => {
          if (p.phase === "note" && p.current === 2) cancelled = true;
        },
      },
    );
    expect(first.summary.restored).toBe(2);

    const { scan, summary } = await restoreWith(archive, { mode: MODE_PREFER_BACKUP });

    // The restored notes were re-dirtied (modified = restore time), so they
    // read as "newer locally" and the default keeps them: nothing is written
    // twice and nothing is displaced. The note the cancel cut off is restored.
    expect(scan.counts).toMatchObject({ conflicts: 2, localNewer: 2, newNotes: 1 });
    expect(summary).toMatchObject({ restored: 1, skipped: 2, replaced: 0 });
    expect(store.notes.size).toBe(3);
  });
});

describe("cancellation during a media read", () => {
  it("reports a cancelled summary and leaves the note unwritten for the next run", async () => {
    store.seedNotebook(makeNotebook());
    store.seedFile("img-1", png());
    store.seedNote(makeNote({ media: [{ id: "m1", fileId: "img-1" }] }));
    const archive = await snapshot();
    store.reset();

    let cancelled = false;
    const reader = archive.reader({ isCancelled: () => cancelled });
    const index = indexArchive(reader.entries, parseManifest(reader.manifestText));
    const plan = planRestore(await scanRestore(reader, index), { mode: MODE_MISSING });
    const summary = await applyRestore(reader, index, plan, {
      onProgress: (p) => {
        if (p.phase === "media") cancelled = true;
      },
    });

    expect(summary).toMatchObject({ cancelled: true, restored: 0 });
    expect(store.notes.has("note-1")).toBe(false);
    expect(store.notebooks.has("nb-1")).toBe(true); // notebooks were created before the cut
  });
});

describe("corruption", () => {
  it("rejects a note whose JSON id does not match its path", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote());
    const archive = await snapshot();
    const entry = archive.entries.get("notebooks/nb-1/notes/note-1.json");
    entry.text = entry.text.replace('"id": "note-1"', '"id": "other"');

    await expect(openAndScan(archive)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects an entry that is not JSON as corrupt, distinct from not-a-backup", async () => {
    store.seedNotebook(makeNotebook());
    const archive = await snapshot();
    archive.entries.get("notebooks/nb-1/_notebook.json").text = "{{{";

    await expect(openAndScan(archive)).rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("password contract via the memory archive", () => {
  it("reads the manifest without a password but nothing else until unlocked", async () => {
    store.seedNotebook(makeNotebook());
    const archive = await snapshot({ password: "s3cret" });
    const reader = archive.reader();

    expect(parseManifest(reader.manifestText).encrypted).toBe(true);
    await expect(reader.readText("notebooks/nb-1/_notebook.json")).rejects.toMatchObject({
      code: "password-required",
    });
    await expect(reader.unlock("wrong")).rejects.toMatchObject({ code: "wrong-password" });
    await reader.unlock("s3cret");
    expect(JSON.parse(await reader.readText("notebooks/nb-1/_notebook.json")).id).toBe("nb-1");
  });
});

// --- Ceilings, field hygiene, sync marker -----------------------------------

describe("entry ceilings", () => {
  it("holds JSON entries to a far lower ceiling than media", () => {
    // A JSON entry is read whole and crosses the IPC boundary as one string.
    expect(MAX_JSON_ENTRY_BYTES).toBeLessThan(MAX_ENTRY_BYTES);
    const manifest = { totalBytes: MAX_ENTRY_BYTES };
    let err;
    try {
      indexArchive([{ name: "quickNotes/q-1.json", size: MAX_JSON_ENTRY_BYTES + 1 }], manifest);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("entry-too-large");
    expect(() =>
      indexArchive(
        [{ name: "quickNotes/q-1_media/f-1.pdf", size: MAX_JSON_ENTRY_BYTES + 1 }],
        manifest,
      ),
    ).not.toThrow();
  });
});

describe("archive field hygiene", () => {
  it("never writes sync-tracking fields or purged, whatever the file claims", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote());
    const archive = await snapshot();
    const note = archive.entries.get("notebooks/nb-1/notes/note-1.json");
    note.text = JSON.stringify({
      ...JSON.parse(note.text),
      purged: true,
      previousNotebookId: "nb-0",
      _currentFileEtag: "x",
      synced: true,
      lastSyncedEtag: "server",
      restoredAt: 1,
    });
    const nb = archive.entries.get("notebooks/nb-1/_notebook.json");
    nb.text = JSON.stringify({ ...JSON.parse(nb.text), purged: true, lastSyncedEtag: "server" });
    store.reset();

    await restoreWith(archive, { mode: MODE_MISSING });

    const restored = store.notes.get("note-1");
    for (const field of ["purged", "previousNotebookId", "_currentFileEtag"]) {
      expect(restored, field).not.toHaveProperty(field);
    }
    expect(restored).toMatchObject({ synced: false, lastSyncedEtag: null, restoredAt: 5000 });
    const notebook = store.notebooks.get("nb-1");
    expect(notebook).not.toHaveProperty("purged");
    expect(notebook.lastSyncedEtag).toBeNull();
  });

  it("strips as a pure helper without touching content fields", () => {
    expect(stripArchiveFields({ id: "a", purged: true, synced: true, title: "t" })).toEqual({
      id: "a",
      title: "t",
    });
  });
});

describe("restoredAt marker", () => {
  it("stamps every restored note with the restore time, never the displaced copy", async () => {
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote({ version: 4, modified: 9000 }));
    store.seedNote(makeNote({ id: "note-2", version: 1, modified: 9000 }));
    const archive = await snapshot();
    store.reset();
    store.seedNotebook(makeNotebook());
    store.seedNote(makeNote({ version: 6, modified: 1000, content: "<p>local</p>" }));

    const { summary } = await restoreWith(archive, { mode: MODE_PREFER_BACKUP });

    expect(summary).toMatchObject({ restored: 2, replaced: 1 });
    expect(store.notes.get("note-1").restoredAt).toBe(5000);
    expect(store.notes.get("note-2").restoredAt).toBe(5000);
    const copy = [...store.notes.values()].find((n) => n.title.endsWith("(replaced)"));
    expect(copy).not.toHaveProperty("restoredAt");
  });
});

describe("notebook re-created over a purged stub", () => {
  it("bumps past the stub's version like a restored note does", async () => {
    store.seedNotebook(makeNotebook());
    const archive = await snapshot();
    store.reset();
    store.seedNotebook({ id: "nb-1", purged: true, deleted: true, version: 12, modified: 1 });

    const { scan } = await restoreWith(archive, { mode: MODE_MISSING });

    expect(scan.notebooks[0]).toMatchObject({ status: "new", localVersion: 12 });
    expect(store.notebooks.get("nb-1")).toMatchObject({
      title: "Work",
      version: 13,
      synced: false,
    });
    expect(store.notebooks.get("nb-1")).not.toHaveProperty("purged");
  });
});
