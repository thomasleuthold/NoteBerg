/**
 * src/components/NoteCanvas/liveUpdate.integration.test.js
 * Live updates of the open note on the native build: a second writer changes
 * the note on the server while the editor has it open, and the editor's
 * periodic look (NoteCanvas._liveCheck) brings the change in.
 *
 * Runs as "bob" with a notebook "alice" shared with him, so the look and the
 * sync go through the share's registered base path. Real: the look
 * (autoSync.syncIfNotebookChanged, nextcloudSync.hasRemoteChanges), the whole
 * sync (sync.performSync and the shared pass), the editor's take-in path and
 * LiveText. Modelled: local storage (an in-memory store with IndexedDB's
 * semantics) and the storage worker's guarded text protocol.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../../modules/__fixtures__/mockOcsServer.js";
import { createClock } from "../../modules/hlc.js";
import { planLiveSync } from "../../modules/liveSyncPlan.js";
import { computeTakeIn } from "../../modules/liveTakeIn.js";
import { mergeElements, mergeVersionFields, normalize } from "../../modules/noteMerge.js";
import { noteUploadBody } from "../../modules/noteUpload.js";
import { NoteVersioner } from "../../modules/noteVersions.js";
import { registerSharedBases } from "../../modules/sharing/sharedBases.js";
import { clearSharedNotebookBases } from "../../modules/storagePaths.js";
import { mergeContent } from "../../modules/textMerge.js";
import { LiveText } from "./liveText.js";
import { NoteCanvas } from "./NoteCanvas.js";

const store = vi.hoisted(() => ({ notebooks: new Map(), notes: new Map(), bases: new Map() }));
const clone = (value) => (value == null ? value : structuredClone(value));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../modules/masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("../../modules/encryption.js", () => ({ decryptObject: vi.fn() }));
const secrets = vi.hoisted(() => new Map());
vi.mock("../../modules/secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));
vi.mock("../../modules/sharing/config.js", () => ({ SHARING_ENABLED: true }));
// Discovery and owner badges are their own concern; the share is already known
vi.mock("../../modules/sharing/nativeSharing.js", () => ({
  prepareSharing: vi.fn(async () => {}),
  runDiscovery: vi.fn(async () => {}),
}));
vi.mock("../../modules/sharing/ownerShares.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshOwnerShares: vi.fn(async () => {}),
  refreshOwnerSharesIfStale: vi.fn(async () => {}),
  getRecipientCount: vi.fn(() => 0),
}));
vi.mock("../../modules/autoRecognition.js", () => ({
  forceRecognition: vi.fn(async () => {}),
  recognizeUnprocessedNotes: vi.fn(async () => 0),
}));
vi.mock("../modals.js", () => ({
  showAlertDialog: vi.fn(),
  showConfirmDialog: vi.fn(),
  showConflictResolutionDialog: vi.fn(),
  showProgressDialog: vi.fn(() => ({ update: vi.fn(), close: vi.fn() })),
}));
vi.mock("../../modules/pdfManager.js", () => ({ importPdf: vi.fn() }));
vi.mock("./VirtualScroller.js");
vi.mock("./CanvasRenderer.js");
vi.mock("./SpatialIndex.js");
vi.mock("./InputHandler.js");
vi.mock("./MediaManager.js");
vi.mock("./MediaOverlay.js");
vi.mock("./NoteToolbar.js");
vi.mock("./StrokeManager.js");
vi.mock("./HistoryManager.js");
vi.mock("./PdfTextLayerManager.js", () => ({ PdfTextLayerManager: class {} }));
vi.mock("./TextLayer.js", () => ({ TextLayer: class {} }));

// Local storage, as IndexedDB holds it: a note's index and content in one record
vi.mock("../../modules/storage.js", () => {
  const all = (map) => [...map.values()].map(clone);
  return {
    initStorage: async () => {},
    getSetting: async () => null,
    isLocalEncryptionEnabled: async () => false,
    getAllNotebooksForSync: async () => all(store.notebooks),
    getAllNoteMetadataForSync: async () => all(store.notes),
    getAllNotesForSync: async () => all(store.notes),
    getNotebook: async (id) => clone(store.notebooks.get(id)) ?? null,
    saveNotebook: async (nb) => void store.notebooks.set(nb.id, clone(nb)),
    getNote: async (id) => clone(store.notes.get(id)) ?? null,
    getRawNote: async (id) => clone(store.notes.get(id)) ?? null,
    getNoteIndex: async (id) => clone(store.notes.get(id)) ?? null,
    saveNote: async (note) => void store.notes.set(note.id, clone(note)),
    getNoteBase: async (id) => store.bases.get(id) ?? null,
    setNoteBase: async (id, content) => {
      if (typeof content === "string") store.bases.set(id, content);
    },
    updateNoteEtag: async (id, etag, modified) => {
      const note = store.notes.get(id);
      if (!note) return;
      note.lastSyncedEtag = etag;
      if (modified === undefined || note.modified === modified) note.synced = true;
    },
    permanentlyDeleteNote: async (id) => void store.notes.delete(id),
    permanentlyDeleteNotebook: async (id) => void store.notebooks.delete(id),
    permanentlyDeleteNotesInNotebook: async () => {},
    discardLocalChanges: async () => {},
    checkFileExists: async () => false,
    getFile: async () => null,
    saveFile: async () => "file-id",
    clearNoteMoveFlag: async () => {},
    flushNoteWrites: async () => {},
    updateNote: vi.fn(),
    updateNoteCoalesced: vi.fn(async () => {}),
    generateId: () => "generated",
  };
});

/**
 * The storage worker's answers, as StorageWorker.js gives them: in queue order,
 * text saves refused when storage holds other text than the editor expects.
 */
function createWorker() {
  const listeners = new Set();
  const reply = (data) =>
    queueMicrotask(() => {
      for (const listener of listeners) listener({ data });
    });
  const touch = (note) => {
    note.modified = Date.now();
    note.version = (note.version || 0) + 1;
    note.synced = false;
  };
  return {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    postMessage(message) {
      const note = store.notes.get(message.noteId);
      if (message.type === "READ_CONTENT") {
        reply({ type: "CONTENT", requestId: message.requestId, content: note?.content ?? null });
      } else if (message.type === "SAVE_CONTENT") {
        let outcome = "failed";
        if (note && message.expected !== undefined && note.content !== message.expected) {
          outcome = "stale";
        } else if (note) {
          note.content = message.content;
          touch(note);
          outcome = "saved";
        }
        reply({ type: "CONTENT_SAVED", requestId: message.requestId, outcome });
      } else if (message.type === "SAVE_STROKES" && note) {
        // Merged with what is stored, as StorageWorker does (DESIGN §10.7 F)
        Object.assign(note, mergeVersionFields(note, message.versionFields ?? {}));
        const merged = mergeElements(
          "strokes",
          { items: clone(message.strokes), deleted: clone(message.deletedStrokes) },
          { items: note.strokes ?? [], deleted: note.deletedStrokes ?? [] },
          { aIsNewer: true, tombstones: note.tombstones ?? {} },
        );
        note.strokes = normalize("strokes", merged.items, note.shifts);
        note.deletedStrokes = merged.deleted;
        touch(note);
      } else if (message.type === "TAKE_IN") {
        // As StorageWorker does: the stored note against the editor's view
        reply({
          type: "TAKEN",
          requestId: message.requestId,
          delta: note ? computeTakeIn(clone(message.view), clone(note)) : null,
        });
      } else if (message.type === "LIVE_SYNC") {
        // As StorageWorker does (liveSyncPlan.js), on the modelled store
        planLiveSync({
          local: note ? clone(note) : null,
          encrypted: false,
          remoteText: message.remoteText,
          remoteEtag: message.remoteEtag,
          base: store.bases.get(message.noteId) ?? null,
          uid: message.uid,
          mediaOnServer: message.mediaOnServer,
          hasFile: () => false,
        }).then((plan) => {
          if (plan.action === "full" || plan.action === "none") {
            reply({ type: "LIVE_SYNCED", requestId: message.requestId, ...plan });
            return;
          }
          if (plan.next) store.notes.set(message.noteId, clone(plan.next));
          if (typeof plan.baseContent === "string")
            store.bases.set(message.noteId, plan.baseContent);
          reply({
            type: "LIVE_SYNCED",
            requestId: message.requestId,
            action: plan.action,
            uploadBody: plan.upload ? noteUploadBody(plan.upload, message.uid) : null,
            ifMatch: plan.ifMatch,
            modified: plan.modified,
            baseContent: plan.upload?.content,
            delta: plan.next ? computeTakeIn(clone(message.view), clone(plan.next)) : null,
          });
        });
      } else if (message.type === "LIVE_SYNC_COMMIT") {
        if (note) {
          note.lastSyncedEtag = message.etag;
          if (note.modified === message.modified) note.synced = true;
        }
        if (typeof message.baseContent === "string") {
          store.bases.set(message.noteId, message.baseContent);
        }
        reply({ type: "LIVE_SYNC_COMMITTED", requestId: message.requestId });
      } else if (message.type === "MERGE_TEXT") {
        reply({
          type: "TEXT_MERGED",
          requestId: message.requestId,
          merged: mergeContent(message.baseline, message.editorText, message.remote, {
            localModified: 1,
            remoteModified: 0,
            remoteAuthor: message.author,
          }),
        });
      } else if (message.type === "SAVE_TASKS" && note) {
        note.tasks = clone(message.tasks);
        note.deletedTasks = clone(message.deletedTasks);
        touch(note);
      }
    },
  };
}

const NB = "nb1";
const notePath = (id) => `/NoteBerg/notebooks/${NB}/notes/${id}.json`;
const stroke = (id, x = 1) => ({ id, x: [x, x + 1], y: [1, 2], pressure: [0.5, 0.5], width: 2 });

let nc;
let alice;
let handlers;
let canvas;
let editorText;

/** The editor with note `id` open, as NoteCanvas.load() leaves it. */
function openEditor(id) {
  const worker = createWorker();
  const c = Object.create(NoteCanvas.prototype);
  Object.assign(c, {
    noteId: id,
    isInitialized: true,
    readOnly: false,
    noteData: clone(store.notes.get(id)),
    _contentRequests: new Map(),
    _nextContentRequest: 0,
    activePointers: new Map(),
    inputHandler: { isDrawing: false },
    spatialIndex: {
      insert: vi.fn(),
      build: vi.fn(),
      // The lowest ink the editor holds
      getContentBounds: () => ({
        maxY: Math.max(0, ...c.noteData.strokes.flatMap((s) => s.y)),
      }),
    },
    renderer: {
      drawAddedStrokes: vi.fn(),
      forceRedraw: vi.fn(),
      setData: vi.fn(),
      setSelectedStrokes: vi.fn(),
      setSelectedMedia: vi.fn(),
      setContentSize: vi.fn(),
    },
    contentHeight: 1000,
    maxContentWidth: 800,
    scroller: { setContentSize: vi.fn(), container: {} },
    selectionOverlay: { hide: vi.fn() },
    mediaManager: { setItems: vi.fn(), getItems: () => [] },
    historyManager: { clear: vi.fn() },
    _updateTaskCheckboxes: vi.fn(),
    _updateNavigatorSubjects: vi.fn(),
    _renderPdfControls: vi.fn(),
  });
  c.strokeManager = {
    worker,
    markDirty: vi.fn(),
    // What the real one posts at stroke end
    save: () =>
      worker.postMessage({
        type: "SAVE_STROKES",
        noteId: id,
        strokes: c.noteData.strokes.filter((s) => !s._deleted),
        deletedStrokes: c.noteData.deletedStrokes,
        versionFields: c._versionFields("strokes"),
      }),
  };
  // As load() leaves it: edits are stamped by this device's clock
  c.versions = new NoteVersioner({ clock: createClock({ device: "bob" }) });
  c.versions.adopt(c.noteData);
  c._onWorkerMessage = c._onWorkerMessage.bind(c);
  worker.addEventListener("message", c._onWorkerMessage);
  editorText = c.noteData.content;
  c.textEditorLayer = {
    getContent: () => editorText,
    replaceContent: (html) => {
      editorText = html;
    },
    renderTaskCheckboxes: vi.fn(),
    setContentHeight: vi.fn(),
  };
  c.liveText = new LiveText({
    initial: c.noteData.content,
    write: (html, expected) => c._writeText(html, expected),
    read: () => c._readStoredText(),
    getEditorText: () => editorText,
    setEditorText: (html) => c._adoptText(html),
  });
  let idle = true;
  c.liveRefresh = { isIdle: () => idle, soon: vi.fn(), setIdle: (value) => (idle = value) };
  return c;
}

/** Everything the `datachange` listeners started has finished. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.all(handlers.splice(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (handlers.length === 0) return;
  }
}

const onDataChange = (e) => handlers.push(canvas?.handleExternalDataChange(e));

let clock = Date.now();

beforeEach(async () => {
  // Each test starts well past the previous one's sync (autoSync's cooldown)
  clock += 60_000;
  localStorage.setItem("sharing_enabled", "true");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  store.notebooks.clear();
  store.notes.clear();
  store.bases.clear();
  clearSharedNotebookBases();
  handlers = [];
  window.addEventListener("datachange", onDataChange);

  nc = new MockNextcloud();
  nc.addUser("alice");
  nc.addUser("bob");
  alice = nc.dav("alice");
  const bob = nc.dav("bob");
  wireMockNextcloud(fetch, nc);
  secrets.clear();
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: nc.baseUrl,
      loginName: "bob",
      appPassword: "app-password-123",
      userId: "bob",
    }),
  );
  bob.files.set("/NoteBerg", { isCollection: true, mtime: new Date() });
  bob.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
  bob.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });

  alice.seedNotebook(NB, { title: "Recipes", modified: 1000 });
  alice.seedNote(NB, {
    id: "n1",
    notebookId: NB,
    title: "Soup",
    content: "<p>carrots</p>",
    strokes: [stroke("s-old")],
    deletedStrokes: [],
    modified: 1000,
    version: 1,
  });
  const created = await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 15);
  const mount = bob.mounts.get(created.id).path;

  // Bob has synced the notebook before: in step with alice's tree
  store.notebooks.set(NB, {
    id: NB,
    title: "Recipes",
    modified: 1000,
    origin: "shared",
    remoteBasePath: mount,
    sharePermissions: created.permissions,
    synced: true,
    lastSyncedEtag: alice.files.get(`/NoteBerg/notebooks/${NB}/_notebook.json`).etag,
  });
  const remote = JSON.parse(alice.files.get(notePath("n1")).content);
  store.notes.set("n1", {
    ...remote,
    synced: true,
    lastSyncedEtag: alice.files.get(notePath("n1")).etag,
  });
  store.bases.set("n1", remote.content);
  // As the app does at start (appInit.js): the share resolves to its base path
  registerSharedBases([...store.notebooks.values()]);
  // The editor's text is in its own form, which is the stored form here
  canvas = openEditor("n1");
});

afterEach(() => {
  vi.useRealTimers();
  window.removeEventListener("datachange", onDataChange);
  canvas = null;
});

/**
 * Alice edits the note on her own device, which stamps her edits with its
 * clock (her client's editor would), and her sync uploads it.
 */
const aliceClock = createClock({ device: "alice" });
function aliceEdits(edit) {
  const current = JSON.parse(alice.files.get(notePath("n1")).content);
  const versions = new NoteVersioner({ clock: aliceClock });
  versions.adopt(current);
  edit(current, versions);
  versions.stamp(current);
  alice.files.set(notePath("n1"), {
    content: JSON.stringify({ ...current, version: current.version + 1, modified: Date.now() }),
    etag: `alice-${Math.random()}`,
    mtime: new Date(),
  });
}

/** Alice saves the note as her client would: on top of what the server holds. */
function aliceSaves(change) {
  const current = JSON.parse(alice.files.get(notePath("n1")).content);
  const next = change(current);
  alice.files.set(notePath("n1"), {
    content: JSON.stringify({ ...next, version: current.version + 1, modified: Date.now() }),
    etag: `alice-${Math.random()}`,
    mtime: new Date(),
  });
}

describe("live updates of the open note (native)", () => {
  it("finds nothing and syncs nothing while nobody else wrote", async () => {
    const before = nc.dav("bob").requests.length;
    await expect(canvas._liveCheck()).resolves.toBe("unchanged");
    // One listing, nothing downloaded
    const requests = nc.dav("bob").requests.slice(before);
    expect(requests.map((r) => r.method)).toEqual(["PROPFIND"]);
  });

  it("syncs only the open note when a collaborator changed it", async () => {
    aliceSaves((n) => ({ ...n, strokes: [...n.strokes, stroke("s-alice", 9)] }));
    const before = nc.dav("bob").requests.length;
    await expect(canvas._liveCheck()).resolves.toBe("synced");
    const requests = nc.dav("bob").requests.slice(before);
    // Its etag and its file: nothing else (the media folder is listed only for a note with files)
    expect(requests.map((r) => r.method)).toEqual(["PROPFIND", "GET"]);
    expect(requests.filter((r) => r.headers.Depth === "infinity")).toEqual([]);
    expect(canvas.noteData.strokes.map((s) => s.id)).toEqual(["s-old", "s-alice"]);
  });

  it("brings in a collaborator's strokes and text without losing the local user's", async () => {
    // Bob draws a stroke and types, both stored locally (not yet uploaded)
    canvas.noteData.strokes.push(stroke("s-bob", 5));
    canvas.strokeManager.save();
    editorText = "<p>carrots</p><p>onions</p>";
    canvas.liveText.save(editorText);
    await settle();

    // Alice adds a stroke and a line of her own
    aliceSaves((n) => ({
      ...n,
      content: "<p>leeks</p><p>carrots</p>",
      strokes: [...n.strokes, stroke("s-alice", 9)],
    }));

    await expect(canvas._liveCheck()).resolves.toBe("synced");
    await settle();

    // The editor shows both writers' work
    expect(canvas.noteData.strokes.map((s) => s.id).sort()).toEqual(["s-alice", "s-bob", "s-old"]);
    expect(editorText).toContain("leeks");
    expect(editorText).toContain("onions");
    expect(editorText).toContain("carrots");
    // Only the new stroke was painted; nothing was rebuilt
    expect(canvas.renderer.forceRedraw).not.toHaveBeenCalled();
    expect(canvas.renderer.drawAddedStrokes).toHaveBeenCalledWith([
      expect.objectContaining({ id: "s-alice" }),
    ]);

    // And so does the server: the sync uploaded the merge into alice's tree
    const onServer = JSON.parse(alice.files.get(notePath("n1")).content);
    expect(onServer.strokes.map((s) => s.id).sort()).toEqual(["s-alice", "s-bob", "s-old"]);
    expect(onServer.content).toContain("leeks");
    expect(onServer.content).toContain("onions");

    // Nothing is left to bring in: the next look finds nothing, and syncs nothing
    await expect(canvas._liveCheck()).resolves.toBe("unchanged");
  });

  it("uploads what the user typed at their pause, though nobody else changed anything", async () => {
    editorText = "<p>carrots</p><p>onions</p>";
    canvas.liveText.save(editorText);
    await settle();
    expect(store.notes.get("n1").synced).toBe(false);

    const before = nc.dav("bob").requests.length;
    await expect(canvas._liveCheck()).resolves.toBe("synced");
    // The open note alone (review P4, 4.3): no listing of the whole tree
    const requests = nc.dav("bob").requests.slice(before);
    expect(requests.filter((r) => r.headers.Depth === "infinity")).toEqual([]);
    expect(requests.map((r) => r.method)).toEqual(["PROPFIND", "PUT"]);
    await settle();

    // A collaborator's next look finds it on the server, without closing the note
    expect(JSON.parse(alice.files.get(notePath("n1")).content).content).toContain("onions");
    expect(store.notes.get("n1").synced).toBe(true);
    await expect(canvas._liveCheck()).resolves.toBe("unchanged");
  });

  it("takes the change in at the user's next pause when they started writing meanwhile", async () => {
    aliceSaves((n) => ({ ...n, strokes: [...n.strokes, stroke("s-alice", 9)] }));
    canvas.liveRefresh.setIdle(false);

    // Found, but not synced while the user writes
    await expect(canvas._liveCheck()).resolves.toBe("deferred");
    expect(canvas.noteData.strokes.map((s) => s.id)).toEqual(["s-old"]);

    canvas.liveRefresh.setIdle(true);
    await expect(canvas._liveCheck()).resolves.toBe("synced");
    await settle();
    expect(canvas.noteData.strokes.map((s) => s.id)).toEqual(["s-old", "s-alice"]);
  });

  it("keeps a collaborator's move of a stroke against the editor's older copy", async () => {
    aliceEdits((note) => {
      const s = note.strokes.find((x) => x.id === "s-old");
      s.y = s.y.map((y) => y + 300);
    });
    // Bob draws meanwhile, so his note is changed locally too: the sync merges
    canvas.noteData.strokes.push({ ...stroke("s-bob", 5), time: [Date.now()] });
    canvas.strokeManager.save();
    await settle();

    await expect(canvas._liveCheck()).resolves.toBe("synced");
    await settle();

    const shown = canvas.noteData.strokes.find((s) => s.id === "s-old");
    expect(shown.y[0]).toBe(301);
    expect(canvas.noteData.strokes.map((s) => s.id).sort()).toEqual(["s-bob", "s-old"]);
    const onServer = JSON.parse(alice.files.get(notePath("n1")).content);
    expect(onServer.strokes.find((s) => s.id === "s-old").y[0]).toBe(301);
  });

  it("moves the editor's stroke drawn below a collaborator's insert space it had not seen", async () => {
    aliceEdits((note, versions) => {
      versions.recordShift(note, { y: 50, delta: 100 });
    });
    // Bob draws below Alice's line without knowing of her shift
    canvas.noteData.strokes.push({
      id: "s-bob",
      x: [5, 6],
      y: [80, 90],
      pressure: [0.5, 0.5],
      width: 2,
      time: [Date.now()],
    });
    canvas.strokeManager.save();
    await settle();

    await canvas._liveCheck();
    await settle();

    const yOf = (strokes) => strokes.find((s) => s.id === "s-bob").y[0];
    expect(yOf(canvas.noteData.strokes)).toBe(180);

    expect(canvas.noteData.strokes.find((s) => s.id === "s-old").y[0]).toBe(1); // above the line
    expect(yOf(JSON.parse(alice.files.get(notePath("n1")).content).strokes)).toBe(180);
    expect(yOf(store.notes.get("n1").strokes)).toBe(180);
  });

  it("writes nothing back for a change it only took in", async () => {
    aliceSaves((n) => ({ ...n, strokes: [...n.strokes, stroke("s-alice", 9)] }));
    await canvas._liveCheck();
    await settle();

    // Nothing to upload, so the other side has nothing to bring in from us
    expect(canvas.strokeManager.markDirty).not.toHaveBeenCalled();
    expect(store.notes.get("n1").synced).toBe(true);
  });
});

describe("what else a live update brings into the open note", () => {
  it("drops a selection whose strokes a rebuild moved to other places", async () => {
    aliceEdits((note) => {
      const s = note.strokes.find((x) => x.id === "s-old");
      s.y = s.y.map((y) => y + 300);
    });
    await canvas._liveCheck();
    await settle();

    // Rebuilt, so selected indices no longer name the strokes they did
    expect(canvas.renderer.forceRedraw).toHaveBeenCalled();
    expect(canvas.renderer.setSelectedStrokes).toHaveBeenCalledWith(new Set(), null);
    expect(canvas.selectionOverlay.hide).toHaveBeenCalled();
  });

  it("keeps the selection when strokes only arrived", async () => {
    aliceSaves((n) => ({ ...n, strokes: [...n.strokes, stroke("s-alice", 9)] }));
    await canvas._liveCheck();
    await settle();

    expect(canvas.renderer.drawAddedStrokes).toHaveBeenCalled();
    expect(canvas.renderer.setSelectedStrokes).not.toHaveBeenCalled();
  });

  it("makes room to scroll to ink a collaborator drew below the end of the page", async () => {
    aliceSaves((n) => ({
      ...n,
      strokes: [...n.strokes, { ...stroke("s-alice"), y: [2900, 3000] }],
    }));
    await canvas._liveCheck();
    await settle();

    expect(canvas.contentHeight).toBeGreaterThanOrEqual(3000);
    expect(canvas.scroller.setContentSize).toHaveBeenCalledWith(800, canvas.contentHeight);
  });

  it("shows a recording a collaborator added", async () => {
    canvas.recordingManager = { setRecordings: vi.fn() };
    aliceEdits((note) => {
      note.recordings = [{ id: "r1", fileId: "f1", name: "Interview", duration: 12 }];
    });
    await canvas._liveCheck();
    await settle();

    expect(canvas.noteData.recordings.map((r) => r.id)).toEqual(["r1"]);
    expect(canvas.recordingManager.setRecordings).toHaveBeenCalledWith([
      expect.objectContaining({ id: "r1", fileId: "f1" }),
    ]);
  });

  it("shows pen presets and a title a collaborator changed", async () => {
    canvas.toolbar = { setPresets: vi.fn() };
    const presets = [
      { width: 3, colorIndex: 2, type: "pen" },
      { width: 20, colorIndex: 1, type: "marker" },
    ];
    aliceEdits((note) => {
      note.penPresets = presets;
      note.title = "Soup, revised";
    });
    await canvas._liveCheck();
    await settle();

    expect(canvas.penPresets).toEqual(presets.map((p) => expect.objectContaining(p)));
    expect(canvas.toolbar.setPresets).toHaveBeenCalledWith(canvas.penPresets);
    expect(canvas.noteData.title).toBe("Soup, revised");
  });
});
