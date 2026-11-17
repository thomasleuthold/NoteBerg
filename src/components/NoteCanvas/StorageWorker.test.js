import { openDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptObject, encryptObject } from "../../modules/encryption.js";
import { splitNote } from "../../modules/noteRecord.js";

// Mock dependencies
vi.mock("idb", () => ({
  openDB: vi.fn(),
}));

vi.mock("../../modules/encryption.js", () => ({
  encryptObject: vi.fn(),
  decryptObject: vi.fn(),
}));

vi.mock("../../modules/storage.js", () => ({
  DB_NAME: "test-db",
  DB_VERSION: 4,
}));

describe("StorageWorker", () => {
  let mockDb;
  let mockTx;
  let mockNotesStore;
  let mockContentStore;
  let workerHandler;

  // Helper to wait for async worker processing
  const flushPromises = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Two separate stores: notes (index) and noteContent (payload)
    mockNotesStore = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockContentStore = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockTx = {
      objectStore: vi.fn((name) => {
        if (name === "noteContent") return mockContentStore;
        return mockNotesStore;
      }),
      store: mockContentStore,
      done: Promise.resolve(),
    };
    mockDb = {
      get: vi.fn(),
      put: vi.fn(),
      transaction: vi.fn(() => mockTx),
    };
    openDB.mockResolvedValue(mockDb);

    // Mock self.close and ensure self exists
    if (!globalThis.self) globalThis.self = {};
    globalThis.self.close = vi.fn();
    globalThis.self.postMessage = vi.fn();

    // Reset modules to ensure a fresh worker instance (and messageQueue) for each test
    vi.resetModules();

    // Import the worker to trigger onmessage assignment
    await import("./StorageWorker.js");
    workerHandler = self.onmessage;
  });

  it("should handle SAVE_STROKES", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", strokes: [], deletedStrokes: [] };

    // db.get returns note index (encrypted check)
    mockDb.get.mockResolvedValue(indexEntry);
    // tx stores return their respective records
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [{ id: "s1" }],
      deletedStrokes: ["s2"],
    };

    await workerHandler({ data });
    await flushPromises();

    // Index store gets version bump + synced=false + hasStrokes flag
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-1",
        version: 2,
        synced: false,
        hasStrokes: true,
      }),
    );
    // Content store gets strokes
    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-1",
        strokes: [{ id: "s1" }],
        deletedStrokes: ["s2"],
      }),
    );
  });

  it("should handle SAVE_STROKES with encryption", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: true };
    const contentEntry = { id: "note-1", strokes: [] };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });
    encryptObject.mockResolvedValue("encrypted-strokes");

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [{ id: "s1" }],
      key: "fake-key",
    };

    await workerHandler({ data });
    await flushPromises();

    expect(encryptObject).toHaveBeenCalledWith([{ id: "s1" }], "fake-key");
    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        strokes: "encrypted-strokes",
      }),
    );
  });

  it("should fail to save encrypted data if key is missing", async () => {
    mockDb.get.mockResolvedValue({ id: "note-1", encrypted: true });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const data = {
      type: "SAVE_STROKES",
      noteId: "note-1",
      strokes: [],
      // No key
    };

    await workerHandler({ data });
    await flushPromises();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot save encrypted strokes: Key missing"),
    );
    expect(mockNotesStore.put).not.toHaveBeenCalled();
    expect(mockContentStore.put).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("should handle SAVE_MEDIA", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", media: [], deletedMedia: [] };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_MEDIA",
      noteId: "note-1",
      media: [{ id: "m1", name: "photo.jpg", type: "image/jpeg", size: 100 }],
      deletedMedia: ["m2"],
      pdfSource: "pdf1",
    };

    await workerHandler({ data });
    await flushPromises();

    // Content store gets full media objects
    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ id: "m1", name: "photo.jpg", type: "image/jpeg", size: 100 }],
        deletedMedia: ["m2"],
        pdfSource: "pdf1",
      }),
    );
    // Index store gets metadata snapshot (id, name, type, size, deleted only)
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ id: "m1", name: "photo.jpg", type: "image/jpeg", size: 100, deleted: undefined }],
        version: 2,
        synced: false,
      }),
    );
  });

  it("should handle SAVE_PRESETS without bumping version or clearing synced", async () => {
    const contentEntry = { id: "note-1", penPresets: [] };
    mockDb.get.mockResolvedValue({ ...contentEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_PRESETS",
      noteId: "note-1",
      presets: [{ color: "red" }],
    };

    await workerHandler({ data });
    await flushPromises();

    // Presets are UI preferences: only the content record is written.
    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ penPresets: [{ color: "red" }] }),
    );
    // No index write — a preset-only change must not mark the note unsynced
    // (that used to re-upload the whole note JSON for a pen color change).
    expect(mockNotesStore.put).not.toHaveBeenCalled();
  });

  it("should handle SAVE_TASKS", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", tasks: [] };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_TASKS",
      noteId: "note-1",
      tasks: [{ id: "t1" }],
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [{ id: "t1" }],
      }),
    );
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, synced: false }),
    );
  });

  it("should handle SAVE_CONTENT", async () => {
    const indexEntry = { id: "note-1", version: 1, encrypted: false };
    const contentEntry = { id: "note-1", content: "" };

    mockDb.get.mockResolvedValue(indexEntry);
    mockNotesStore.get.mockResolvedValue({ ...indexEntry });
    mockContentStore.get.mockResolvedValue({ ...contentEntry });

    const data = {
      type: "SAVE_CONTENT",
      noteId: "note-1",
      content: "<p>Hello</p>",
    };

    await workerHandler({ data });
    await flushPromises();

    expect(mockContentStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "<p>Hello</p>",
      }),
    );
    expect(mockNotesStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, synced: false, hasContent: true }),
    );
  });

  describe("text saves that name the text they replace", () => {
    // What storage holds right now; a sync can change it between messages
    let stored;
    let index;

    beforeEach(() => {
      index = { id: "note-1", version: 1, encrypted: false };
      stored = { id: "note-1", content: "<p>a</p>", lastModifiedBy: "bob" };
      mockDb.get.mockImplementation(async (store) =>
        store === "noteContent" ? { ...stored } : { ...index },
      );
      mockNotesStore.get.mockImplementation(async () => ({ ...index }));
      mockContentStore.get.mockImplementation(async () => ({ ...stored }));
    });

    const save = async (content, expected) => {
      workerHandler({
        data: { type: "SAVE_CONTENT", noteId: "note-1", content, expected, requestId: 7 },
      });
      await flushPromises();
    };
    const answer = () => self.postMessage.mock.calls.at(-1)?.[0];

    it("are stored while storage still holds the expected text, and say so", async () => {
      await save("<p>ab</p>", "<p>a</p>");

      expect(mockContentStore.put).toHaveBeenCalledWith(
        expect.objectContaining({ content: "<p>ab</p>" }),
      );
      expect(answer()).toEqual({
        type: "CONTENT_SAVED",
        requestId: 7,
        noteId: "note-1",
        outcome: "saved",
      });
    });

    it("are refused when another version was stored meanwhile, which is never overwritten", async () => {
      stored.content = "<p>a</p><p>from bob</p>"; // a sync downloaded it

      await save("<p>ab</p>", "<p>a</p>");

      expect(mockContentStore.put).not.toHaveBeenCalled();
      expect(mockNotesStore.put).not.toHaveBeenCalled();
      expect(answer()).toMatchObject({ requestId: 7, outcome: "stale" });
    });

    it("are refused when that version lands between the check and the write", async () => {
      mockContentStore.get.mockImplementation(async () => ({ ...stored, content: "<p>bob</p>" }));

      await save("<p>ab</p>", "<p>a</p>");

      expect(mockContentStore.put).not.toHaveBeenCalled();
      expect(answer()).toMatchObject({ outcome: "stale" });
    });

    it("compare the decrypted text of an encrypted note", async () => {
      index.encrypted = true;
      stored.content = { data: "x", iv: "y" };
      decryptObject.mockResolvedValue("<p>a</p>");
      encryptObject.mockResolvedValue({ data: "z", iv: "w" });

      await workerHandler({
        data: {
          type: "SAVE_CONTENT",
          noteId: "note-1",
          content: "<p>ab</p>",
          expected: "<p>a</p>",
          key: "k",
          requestId: 8,
        },
      });
      await flushPromises();

      expect(answer()).toMatchObject({ requestId: 8, outcome: "saved" });
      expect(mockContentStore.put).toHaveBeenCalledWith(
        expect.objectContaining({ content: { data: "z", iv: "w" } }),
      );
    });

    it("report a save that could not be made", async () => {
      index = undefined;
      mockDb.get.mockImplementation(async () => undefined);

      await save("<p>ab</p>", "<p>a</p>");

      expect(answer()).toMatchObject({ requestId: 7, outcome: "failed" });
    });

    it("read back the stored text and who stored it, in queue order", async () => {
      await save("<p>ab</p>", "<p>a</p>");
      stored.content = "<p>ab</p>";

      await workerHandler({ data: { type: "READ_CONTENT", noteId: "note-1", requestId: 9 } });
      await flushPromises();

      expect(answer()).toEqual({
        type: "CONTENT",
        requestId: 9,
        noteId: "note-1",
        content: "<p>ab</p>",
        author: "bob",
      });
    });

    it("read back nothing for an encrypted note while the app is locked", async () => {
      index.encrypted = true;
      stored.content = { data: "x", iv: "y" };

      await workerHandler({ data: { type: "READ_CONTENT", noteId: "note-1", requestId: 10 } });
      await flushPromises();

      expect(answer()).toMatchObject({ requestId: 10, content: null });
    });
  });

  describe("notes of a notebook shared with this user", () => {
    const noteIndex = { id: "note-1", notebookId: "nb-shared", version: 1, encrypted: false };

    /** db.get answers by store: the note's index, and the notebook record */
    function setup(notebook) {
      mockDb.get.mockImplementation(async (store) => {
        if (store === "notebooks") return notebook;
        if (store === "notes") return { ...noteIndex };
        return { id: "note-1" };
      });
      mockNotesStore.get.mockResolvedValue({ ...noteIndex });
      mockContentStore.get.mockResolvedValue({ id: "note-1" });
    }

    const messages = {
      SAVE_STROKES: { strokes: [{ id: "s1" }] },
      SAVE_MEDIA: { media: [{ id: "m1" }] },
      SAVE_TASKS: { tasks: [], deletedTasks: [] },
      SAVE_CONTENT: { content: "<p>x</p>" },
      SAVE_RECORDINGS: { recordings: [] },
      SAVE_PRESETS: { presets: [] },
    };

    it.each(Object.keys(messages))("%s is refused on a read-only share", async (type) => {
      setup({ id: "nb-shared", origin: "shared", sharePermissions: 1 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      await workerHandler({ data: { type, noteId: "note-1", ...messages[type] } });
      await flushPromises();

      expect(mockNotesStore.put).not.toHaveBeenCalled();
      expect(mockContentStore.put).not.toHaveBeenCalled();
      expect(mockDb.put).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it("is refused once the share ended", async () => {
      setup({ id: "nb-shared", origin: "shared", sharePermissions: 7, shareEnded: true });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      await workerHandler({ data: { type: "SAVE_STROKES", noteId: "note-1", strokes: [] } });
      await flushPromises();

      expect(mockContentStore.put).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it("goes through on a collaborative share", async () => {
      setup({ id: "nb-shared", origin: "shared", sharePermissions: 7 });

      await workerHandler({
        data: { type: "SAVE_CONTENT", noteId: "note-1", content: "<p>ok</p>" },
      });
      await flushPromises();

      expect(mockContentStore.put).toHaveBeenCalledWith(
        expect.objectContaining({ content: "<p>ok</p>" }),
      );
    });

    // The share turned view only while the note was open with the right to edit:
    // what the user typed until the editor stops is kept on this device (the sync
    // lists it as changes the share no longer accepts) rather than thrown away
    it("keeps the writes of an editor that opened the note with the right to edit", async () => {
      setup({ id: "nb-shared", origin: "shared", sharePermissions: 1 });

      await workerHandler({ data: { type: "OPEN_FOR_EDITING", noteId: "note-1" } });
      await workerHandler({ data: { type: "SAVE_STROKES", noteId: "note-1", strokes: [] } });
      await flushPromises();

      expect(mockContentStore.put).toHaveBeenCalled();
      expect(mockNotesStore.put).toHaveBeenCalledWith(expect.objectContaining({ synced: false }));
    });

    it("still refuses writes to other notes of that share", async () => {
      setup({ id: "nb-shared", origin: "shared", sharePermissions: 1 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      await workerHandler({ data: { type: "OPEN_FOR_EDITING", noteId: "note-2" } });
      await workerHandler({ data: { type: "SAVE_STROKES", noteId: "note-1", strokes: [] } });
      await flushPromises();

      expect(mockContentStore.put).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it("keeps working after a refused write", async () => {
      setup({ id: "nb-shared", origin: "shared", sharePermissions: 1 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await workerHandler({ data: { type: "SAVE_CONTENT", noteId: "note-1", content: "x" } });
      await flushPromises();

      setup({ id: "nb-shared", origin: "shared", sharePermissions: 7 });
      await workerHandler({ data: { type: "SAVE_CONTENT", noteId: "note-1", content: "y" } });
      await flushPromises();

      expect(mockContentStore.put).toHaveBeenCalledWith(expect.objectContaining({ content: "y" }));
      error.mockRestore();
    });
  });

  // DESIGN §10.7 F: the editor's saves are merged with what storage holds, so a
  // stroke saved while a sync wrote the note never drops the other side's work.
  describe("saves merged with what storage holds", () => {
    const stroke = (id, v, y = 10, extra = {}) => ({ id, x: [1, 2], y: [y, y + 5], v, ...extra });
    let stored;
    let index;

    function holds(content, { encrypted = false } = {}) {
      index = { id: "note-1", version: 1, encrypted };
      stored = { id: "note-1", ...content };
      mockDb.get.mockImplementation(async (store) =>
        store === "notes" ? { ...index } : structuredClone(stored),
      );
      mockNotesStore.get.mockResolvedValue({ ...index });
      mockContentStore.get.mockResolvedValue(structuredClone(stored));
    }

    async function send(data) {
      await workerHandler({ data: { noteId: "note-1", ...data } });
      await flushPromises();
      return mockContentStore.put.mock.calls.at(-1)?.[0];
    }

    it("keeps strokes storage has that the editor has not taken in yet", async () => {
      holds({ strokes: [stroke("synced", "b1")], deletedStrokes: [] });
      const written = await send({ type: "SAVE_STROKES", strokes: [stroke("mine", "a1")] });
      expect(written.strokes.map((s) => s.id).sort()).toEqual(["mine", "synced"]);
      expect(mockNotesStore.put).toHaveBeenCalledWith(
        expect.objectContaining({ hasStrokes: true }),
      );
    });

    it("keeps the newer copy of a stroke, whichever side it is on", async () => {
      holds({
        strokes: [stroke("s1", "0000000b0-000-x", 99), stroke("s2", "0000000a0-000-x", 10)],
      });
      const written = await send({
        type: "SAVE_STROKES",
        strokes: [stroke("s1", "0000000a0-000-y", 10), stroke("s2", "0000000b0-000-y", 50)],
      });
      const byId = Object.fromEntries(written.strokes.map((s) => [s.id, s.y[0]]));
      expect(byId).toEqual({ s1: 99, s2: 50 });
    });

    it("lets a deletion win on either side, and records the save's deletion stamps", async () => {
      holds({
        strokes: [stroke("gone-here", "a1"), stroke("still-mine", "a1")],
        deletedStrokes: ["gone-there"],
        tombstones: { "gone-there": "t-there" },
      });
      const written = await send({
        type: "SAVE_STROKES",
        strokes: [stroke("still-mine", "a1"), stroke("gone-there", "a9")],
        deletedStrokes: ["gone-here"],
        versionFields: { tombstones: { "gone-here": "t-here" } },
      });
      expect(written.strokes.map((s) => s.id)).toEqual(["still-mine"]);
      expect(written.deletedStrokes.sort()).toEqual(["gone-here", "gone-there"]);
      expect(written.tombstones).toEqual({ "gone-there": "t-there", "gone-here": "t-here" });
    });

    it("brings back a stroke whose deletion the editor undid", async () => {
      holds({ strokes: [], deletedStrokes: ["s1"], tombstones: { s1: "t1" } });
      const written = await send({
        type: "SAVE_STROKES",
        strokes: [stroke("s1", "a2", 10, { restores: "t1" })],
        deletedStrokes: [],
      });
      expect(written.strokes.map((s) => s.id)).toEqual(["s1"]);
      expect(written.deletedStrokes).toEqual([]);
    });

    it("merges the version bookkeeping instead of replacing it", async () => {
      const shiftThere = { v: "0000000a0-000-there", y: 0, delta: 5 };
      const shiftHere = { v: "0000000b0-000-here", y: 0, delta: 5 };
      holds({
        strokes: [],
        tombstones: { a: "t2" },
        shifts: [shiftThere],
        fieldVersions: { title: "f2" },
      });
      const written = await send({
        type: "SAVE_STROKES",
        strokes: [],
        versionFields: {
          tombstones: { a: "t1", b: "t1" },
          shifts: [shiftHere],
          fieldVersions: { title: "f1" },
        },
      });
      expect(written.tombstones).toEqual({ a: "t2", b: "t1" });
      expect(written.shifts).toEqual([shiftThere, shiftHere]);
      expect(written.fieldVersions).toEqual({ title: "f2" });
    });

    it("moves a saved stroke by an insert space storage knows and the editor had not seen", async () => {
      holds({ strokes: [], shifts: [{ v: "0000000a0-000-there", y: 100, delta: 40 }] });
      const written = await send({
        type: "SAVE_STROKES",
        strokes: [
          stroke("below", "0000000b0-000-here", 200),
          stroke("above", "0000000b0-000-here", 50),
        ],
      });
      const byId = Object.fromEntries(written.strokes.map((s) => [s.id, s.y[0]]));
      expect(byId).toEqual({ below: 240, above: 50 });
    });

    it("decrypts an encrypted note's strokes to merge them, and encrypts the result", async () => {
      holds({ strokes: { data: "x", iv: "y" } }, { encrypted: true });
      decryptObject.mockResolvedValue([stroke("synced", "b1")]);
      encryptObject.mockImplementation(async (value) => ({ sealed: value }));
      const written = await send({
        type: "SAVE_STROKES",
        strokes: [stroke("mine", "a1")],
        key: "k",
      });
      expect(written.strokes.sealed.map((s) => s.id).sort()).toEqual(["mine", "synced"]);
    });

    it("keeps an encrypted note's tasks and their deletions encrypted when merging", async () => {
      holds(
        { tasks: { sealed: "tasks" }, deletedTasks: { sealed: "deleted" } },
        { encrypted: true },
      );
      decryptObject.mockImplementation(async (value) =>
        value.sealed === "tasks" ? [{ id: "t-there", v: "b1" }] : ["t-gone"],
      );
      encryptObject.mockImplementation(async (value) => ({ sealed: value }));
      const written = await send({
        type: "SAVE_TASKS",
        tasks: [
          { id: "t-mine", v: "a1" },
          { id: "t-gone", v: "a1" },
        ],
        deletedTasks: [],
        key: "k",
      });
      expect(written.tasks.sealed.map((t) => t.id).sort()).toEqual(["t-mine", "t-there"]);
      expect(written.deletedTasks).toEqual({ sealed: ["t-gone"] });
    });

    it("merges tasks the same way", async () => {
      holds({ tasks: [{ id: "t-there", v: "b1" }], deletedTasks: [] });
      const written = await send({
        type: "SAVE_TASKS",
        tasks: [{ id: "t-mine", v: "a1" }],
        deletedTasks: [],
      });
      expect(written.tasks.map((t) => t.id).sort()).toEqual(["t-mine", "t-there"]);
    });

    it("merges media and takes the PDF source only with the newer stamp", async () => {
      holds({
        media: [{ id: "m-there", y: 0, z: 1, v: "b1" }],
        pdfSource: "newer",
        fieldVersions: { pdfSource: "f2" },
      });
      const written = await send({
        type: "SAVE_MEDIA",
        media: [{ id: "m-mine", y: 0, z: 2, v: "a1" }],
        deletedMedia: [],
        pdfSource: "older",
        versionFields: { fieldVersions: { pdfSource: "f1" } },
      });
      expect(written.media.map((m) => m.id)).toEqual(["m-there", "m-mine"]);
      expect(written.pdfSource).toBe("newer");
    });

    it("keeps pen presets saved with an older stamp from replacing newer ones", async () => {
      const content = { id: "note-1", penPresets: ["newer"], fieldVersions: { penPresets: "f2" } };
      mockDb.get.mockResolvedValue({ ...content });
      mockContentStore.get.mockResolvedValue({ ...content });
      await send({
        type: "SAVE_PRESETS",
        presets: ["older"],
        versionFields: { fieldVersions: { penPresets: "f1" } },
      });
      expect(mockContentStore.put).toHaveBeenCalledWith(
        expect.objectContaining({ penPresets: ["newer"] }),
      );
    });

    it("merges recordings, deleted ones by their file", async () => {
      holds({
        recordings: [{ id: "r-there", fileId: "f-there", v: "b1" }],
        deletedRecordings: [],
      });
      const written = await send({
        type: "SAVE_RECORDINGS",
        recordings: [{ id: "r-mine", fileId: "f-mine", v: "a1" }],
        deletedRecordings: ["f-there"],
      });
      expect(written.recordings.map((r) => r.id)).toEqual(["r-mine"]);
      expect(written.deletedRecordings).toEqual(["f-there"]);
    });

    it("keeps the save's version fields when it carries no recordings", async () => {
      holds({ recordings: [{ id: "r1", fileId: "f1", v: "b1" }], fieldVersions: {} });
      const written = await send({
        type: "SAVE_RECORDINGS",
        versionFields: { fieldVersions: { title: "f9" } },
      });
      expect(written.fieldVersions).toEqual({ title: "f9" });
      expect(written.recordings.map((r) => r.id)).toEqual(["r1"]);
    });
  });

  describe("the open note's own sync with local encryption", () => {
    const KEY = "fake-key";
    const seal = (value) => ({ data: JSON.stringify(value), iv: "iv" });
    let stores;

    const plainNote = (overrides = {}) => ({
      id: "note-1",
      notebookId: null,
      title: "t",
      content: "<p>mine</p>",
      strokes: [{ id: "s1", x: [1], y: [1], v: "000000001-000-a" }],
      deletedStrokes: [],
      media: [],
      recordings: [],
      tasks: [],
      modified: 1000,
      version: 1,
      synced: true,
      lastSyncedEtag: "e1",
      ...overrides,
    });

    /** The note as storage.js stores it with local encryption on. */
    function holdsEncrypted(note, { base = "<p>mine</p>" } = {}) {
      const { index, content } = splitNote(note);
      index.encrypted = true;
      for (const field of ["content", "strokes", "media", "tasks"]) {
        content[field] = seal(content[field]);
      }
      stores = {
        notes: new Map([[note.id, index]]),
        noteContent: new Map([[note.id, content]]),
        noteBase: new Map(
          base === null ? [] : [[note.id, { id: note.id, content: seal(base), encrypted: true }]],
        ),
        files: new Map(),
      };
    }

    beforeEach(() => {
      encryptObject.mockImplementation(async (value) => seal(value));
      decryptObject.mockImplementation(async (blob) => JSON.parse(blob.data));
      mockDb.get.mockImplementation(async (store, id) => stores[store].get(id));
      mockDb.transaction.mockImplementation(() => ({
        objectStore: (name) => ({
          get: async (id) => stores[name].get(id),
          put: async (value) => {
            stores[name].set(value.id, value);
          },
          delete: async (id) => {
            stores[name].delete(id);
          },
        }),
        done: Promise.resolve(),
      }));
    });

    async function liveSync(extra = {}) {
      self.postMessage.mockClear();
      await workerHandler({
        data: {
          type: "LIVE_SYNC",
          noteId: "note-1",
          requestId: 1,
          remoteText: null,
          remoteEtag: "e1",
          mediaOnServer: [],
          view: null,
          uid: "bob",
          localEncryption: true,
          key: KEY,
          ...extra,
        },
      });
      await flushPromises();
      return self.postMessage.mock.calls.find(([m]) => m.type === "LIVE_SYNCED")[0];
    }

    const theirs = (overrides = {}) =>
      JSON.stringify(plainNote({ content: "<p>theirs</p>", modified: 3000, ...overrides }));

    it("takes in the server's version and stores it encrypted, baseline included", async () => {
      holdsEncrypted(plainNote());
      const answer = await liveSync({ remoteText: theirs(), remoteEtag: "e2" });
      expect(answer.action).toBe("downloaded");

      const content = stores.noteContent.get("note-1");
      expect(stores.notes.get("note-1")).toMatchObject({
        encrypted: true,
        lastSyncedEtag: "e2",
        synced: true,
      });
      expect(content.content).toEqual(seal("<p>theirs</p>"));
      for (const field of ["content", "strokes", "media", "tasks"]) {
        expect(content[field]).toEqual({ data: expect.any(String), iv: "iv" });
      }
      expect(stores.noteBase.get("note-1")).toEqual({
        id: "note-1",
        content: seal("<p>theirs</p>"),
        encrypted: true,
      });
    });

    it("merges with the decrypted baseline and uploads the merge as plain JSON", async () => {
      holdsEncrypted(plainNote({ synced: false, modified: 2000 }));
      const answer = await liveSync({ remoteText: theirs(), remoteEtag: "e2" });
      expect(answer.action).toBe("upload");
      const uploaded = JSON.parse(answer.uploadBody);
      expect(typeof uploaded.content).toBe("string");
      expect(Array.isArray(uploaded.strokes)).toBe(true);
      expect(uploaded.encrypted).toBeUndefined();
      expect(answer.ifMatch).toBe("e2");
    });

    it("uploads this device's change without writing the note again", async () => {
      holdsEncrypted(plainNote({ synced: false, modified: 2000, content: "<p>b</p>" }));
      const before = structuredClone([...stores.noteContent.values()]);
      const answer = await liveSync();
      expect(answer.action).toBe("upload");
      expect(JSON.parse(answer.uploadBody).content).toBe("<p>b</p>");
      expect(answer.ifMatch).toBe("e1");
      expect([...stores.noteContent.values()]).toEqual(before);
    });

    describe("a stored field that cannot be decrypted", () => {
      // The strokes were sealed with a key this device no longer holds
      const unreadableStrokes = () =>
        decryptObject.mockImplementation(async (blob) => {
          if (blob.data.includes("s1")) throw new Error("wrong key");
          return JSON.parse(blob.data);
        });

      it("is taken from the server copy, so the upload does not erase it there", async () => {
        holdsEncrypted(plainNote({ synced: false, modified: 2000, content: "<p>mine</p>" }));
        unreadableStrokes();
        const answer = await liveSync({ remoteText: theirs(), remoteEtag: "e2" });
        expect(answer.action).toBe("upload");
        const uploaded = JSON.parse(answer.uploadBody);
        expect(uploaded.strokes.map((s) => s.id)).toEqual(["s1"]);
        // and stored again with the current key
        expect(stores.noteContent.get("note-1").strokes).toEqual(seal(uploaded.strokes));
      });

      it("asks for the server copy when it has changes to upload and none was brought", async () => {
        holdsEncrypted(plainNote({ synced: false, modified: 2000 }));
        unreadableStrokes();
        const answer = await liveSync();
        expect(answer.action).toBe("need-remote");
        expect(stores.noteContent.get("note-1").content).toEqual(seal("<p>mine</p>"));
      });

      it("needs nothing from the server when there is nothing to upload", async () => {
        holdsEncrypted(plainNote());
        unreadableStrokes();
        const answer = await liveSync();
        expect(answer.action).toBe("none");
      });
    });

    it("stores nothing readable when encrypting fails", async () => {
      holdsEncrypted(plainNote());
      encryptObject.mockRejectedValue(new Error("crypto failed"));
      const answer = await liveSync({ remoteText: theirs(), remoteEtag: "e2" });
      expect(answer.action).toBe("full");
      expect(stores.noteContent.get("note-1").content).toEqual(seal("<p>mine</p>"));
      expect(stores.notes.get("note-1").encrypted).toBe(true);
    });

    it("takes the server's version when the baseline cannot be read", async () => {
      holdsEncrypted(plainNote(), { base: null });
      const answer = await liveSync({ remoteText: theirs(), remoteEtag: "e2" });
      expect(answer.action).toBe("downloaded");
    });

    it("leaves a note stored encrypted to the full sync when encryption is off", async () => {
      holdsEncrypted(plainNote());
      const answer = await liveSync({ localEncryption: false, key: null });
      expect(answer).toMatchObject({ action: "full", reason: "note stored encrypted" });
    });

    it("still stores a plain note plain when encryption is off", async () => {
      const { index, content } = splitNote(plainNote());
      stores = {
        notes: new Map([["note-1", index]]),
        noteContent: new Map([["note-1", content]]),
        noteBase: new Map(),
        files: new Map(),
      };
      const answer = await liveSync({
        localEncryption: false,
        key: null,
        remoteText: theirs(),
        remoteEtag: "e2",
      });
      expect(answer.action).toBe("downloaded");
      expect(stores.noteContent.get("note-1").content).toBe("<p>theirs</p>");
      expect(stores.notes.get("note-1").encrypted).toBe(false);
      expect(stores.noteBase.get("note-1")).toMatchObject({
        content: "<p>theirs</p>",
        encrypted: false,
      });
    });

    describe("commit", () => {
      const commit = async (extra) => {
        await workerHandler({
          data: {
            type: "LIVE_SYNC_COMMIT",
            noteId: "note-1",
            requestId: 2,
            etag: "e3",
            modified: 2000,
            baseContent: "<p>up</p>",
            ...extra,
          },
        });
        await flushPromises();
      };

      it("keeps the new baseline encrypted", async () => {
        holdsEncrypted(plainNote({ synced: false, modified: 2000 }));
        await commit({ localEncryption: true, key: KEY });
        expect(stores.noteBase.get("note-1")).toEqual({
          id: "note-1",
          content: seal("<p>up</p>"),
          encrypted: true,
        });
        expect(stores.notes.get("note-1")).toMatchObject({ lastSyncedEtag: "e3", synced: true });
      });
    });
  });

  it("should handle CLOSE", async () => {
    const data = { type: "CLOSE" };
    await workerHandler({ data });
    await flushPromises();
    expect(self.close).toHaveBeenCalled();
  });
});
