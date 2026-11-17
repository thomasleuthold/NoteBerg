/**
 * src/components/NoteCanvas/liveUpdate.nextcloud.test.js
 * Live updates of the open note on the Nextcloud app build (run by
 * `npm run test:nextcloud`): a second writer saves the note while the editor
 * has it open, and the editor's periodic look (NoteCanvas._liveCheckNextcloud)
 * brings the change in.
 *
 * Runs as "bob" in the browser (session cookie); "alice" owns the shared
 * notebook and saves into it directly. Real: storage.webdav.js (its etag
 * tracking and merging writer), StrokeManager, LiveText and the editor's
 * take-in path. The editor's DOM parts are stand-ins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud } from "../../modules/__fixtures__/mockOcsServer.js";

vi.mock("../../modules/sharing/config.js", () => ({ SHARING_ENABLED: true }));
vi.mock("../../modules/masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("../../modules/autoRecognition.js", () => ({ forceRecognition: vi.fn() }));
vi.mock("../modals.js", () => ({
  showAlertDialog: vi.fn(),
  showConfirmDialog: vi.fn(),
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
vi.mock("./HistoryManager.js");
vi.mock("./PdfTextLayerManager.js", () => ({ PdfTextLayerManager: class {} }));
vi.mock("./TextLayer.js", () => ({ TextLayer: class {} }));

const documentListeners = [];
const NB = "nb1";
const ownerNotePath = (id) => `/NoteBerg/notebooks/${NB}/notes/${id}.json`;
const stroke = (id, x = 1) => ({ id, x: [x, x + 1], y: [1, 2], pressure: [0.5, 0.5], width: 2 });

let nc;
let alice;
let bob;
let storage;
let NoteCanvas;
let LiveText;
let StrokeManager;
let NoteVersioner;
let createClock;
let canvas;
let editorText;
let dataChanges;
const onDataChange = (e) => dataChanges.push(e.detail ?? null);

const readOwner = () => JSON.parse(alice.files.get(ownerNotePath("n1")).content);
const requestsSince = (n) => bob.requests.slice(n).map((r) => r.method);

/** Alice edits on her own device, which stamps her edits (her editor would), and saves. */
function aliceEdits(edit) {
  const current = readOwner();
  const versions = new NoteVersioner({ clock: createClock({ device: "alice" }) });
  versions.adopt(current);
  edit(current, versions);
  versions.stamp(current);
  alice.files.set(ownerNotePath("n1"), {
    content: JSON.stringify({ ...current, version: current.version + 1, modified: Date.now() }),
    etag: `alice-${Math.random()}`,
    mtime: new Date(),
  });
}

/** Alice saves the note as her client would: on top of what the server holds. */
function aliceSaves(change) {
  const current = readOwner();
  alice.files.set(ownerNotePath("n1"), {
    content: JSON.stringify({
      ...change(current),
      version: current.version + 1,
      modified: Date.now(),
      lastModifiedBy: "alice",
    }),
    etag: `alice-${Math.random()}`,
    mtime: new Date(),
  });
}

/** The editor with note `id` open, as NoteCanvas.load() leaves it. */
async function openEditor(id) {
  const noteData = await storage.getNote(id, { track: true });
  const c = Object.create(NoteCanvas.prototype);
  Object.assign(c, {
    noteId: id,
    isInitialized: true,
    readOnly: false,
    noteData,
    activePointers: new Map(),
    inputHandler: { isDrawing: false },
    spatialIndex: { insert: vi.fn(), build: vi.fn(), getContentBounds: () => null },
    renderer: {
      drawAddedStrokes: vi.fn(),
      forceRedraw: vi.fn(),
      setData: vi.fn(),
      setSelectedStrokes: vi.fn(),
    },
    contentHeight: 1000,
    mediaManager: { setItems: vi.fn(), getItems: () => [] },
    historyManager: { clear: vi.fn() },
    _updateTaskCheckboxes: vi.fn(),
    _updateNavigatorSubjects: vi.fn(),
    _renderPdfControls: vi.fn(),
  });
  c.strokeManager = new StrokeManager(id, noteData.strokes, noteData.deletedStrokes);
  // As load() leaves it: every save stamps the user's edits
  c.versions = new NoteVersioner();
  c.versions.adopt(noteData);
  c.strokeManager.beforeSave = (what) => c._versionFields(what);
  editorText = noteData.content;
  c.textEditorLayer = {
    getContent: () => editorText,
    replaceContent: (html) => {
      editorText = html;
    },
    renderTaskCheckboxes: vi.fn(),
  };
  c.liveText = new LiveText({
    initial: noteData.content,
    write: (html, expected) => c._writeText(html, expected),
    read: () => c._readStoredText(),
    getEditorText: () => editorText,
    setEditorText: (html) => c._adoptText(html),
  });
  let idle = true;
  c.liveRefresh = { isIdle: () => idle, soon: vi.fn(), setIdle: (value) => (idle = value) };
  return c;
}

/** What a save that merged announces (storage.webdav.js). */
const mergeEvent = () =>
  new CustomEvent("datachange", { detail: { noteId: "n1", source: "merge" } });

/** Bob draws a stroke; at its end the editor saves the strokes. */
async function bobDraws(s) {
  canvas.noteData.strokes.push(s);
  canvas.strokeManager.markDirty();
  await canvas.strokeManager.forceSave();
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("sharing_enabled", "true"); // a preview the user turned on
  nc = new MockNextcloud();
  nc.addUser("alice", { displayName: "Alice Anderson" });
  nc.addUser("bob", { displayName: "Bob Brown" });
  nc.sessionUser = "bob";
  alice = nc.dav("alice");
  bob = nc.dav("bob");
  vi.stubGlobal("fetch", (url, options) => nc.handleRequest(url, options));
  window.OC = {
    webroot: "",
    requestToken: "token",
    currentUser: "bob",
    getCurrentUser: () => ({ uid: "bob" }),
  };
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
  bob.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
  bob.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });
  await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 15);

  vi.resetModules();
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    documentListeners.push([type, listener]);
    add(type, listener, options);
  });
  storage = await import("../../modules/storage.js");
  ({ NoteCanvas } = await import("./NoteCanvas.js"));
  ({ LiveText } = await import("./liveText.js"));
  ({ StrokeManager } = await import("./StrokeManager.js"));
  ({ NoteVersioner } = await import("../../modules/noteVersions.js"));
  ({ createClock } = await import("../../modules/hlc.js"));
  await storage.initStorage();
  await storage.getAllNotebooks();

  dataChanges = [];
  window.addEventListener("datachange", onDataChange);
  canvas = await openEditor("n1");
});

afterEach(() => {
  window.removeEventListener("datachange", onDataChange);
  for (const [type, listener] of documentListeners.splice(0)) {
    document.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.OC;
});

describe("live updates of the open note (Nextcloud app)", () => {
  it("costs one small request, and downloads nothing, while nobody else wrote", async () => {
    const before = bob.requests.length;
    await expect(canvas._liveCheckNextcloud()).resolves.toBeUndefined();
    expect(requestsSince(before)).toEqual(["PROPFIND"]);
    expect(bob.requests.at(-1).headers.Depth).toBe("0");
  });

  it("does not look while a save of ours is under way", async () => {
    canvas.noteData.strokes.push(stroke("s-bob", 5));
    canvas.strokeManager.markDirty();
    const saving = canvas.strokeManager.forceSave();
    const before = bob.requests.length;
    await expect(canvas._liveCheckNextcloud()).resolves.toBeUndefined();
    expect(requestsSince(before).filter((m) => m === "PROPFIND")).toEqual([]);
    await saving;
  });

  it("brings in a collaborator's strokes and text without losing the local user's", async () => {
    // Bob draws and types, both saved
    await bobDraws(stroke("s-bob", 5));
    editorText = "<p>carrots</p><p>onions</p>";
    canvas.liveText.save(editorText);
    await storage.flushNoteWrites("n1");

    // Alice saves a stroke and a line of her own
    aliceSaves((n) => ({
      ...n,
      content: `<p>leeks</p>${n.content}`,
      strokes: [...n.strokes, stroke("s-alice", 9)],
    }));

    await expect(canvas._liveCheckNextcloud()).resolves.toBe("taken");

    expect(canvas.noteData.strokes.map((s) => s.id).sort()).toEqual(["s-alice", "s-bob", "s-old"]);
    expect(editorText).toBe("<p>leeks</p><p>carrots</p><p>onions</p>");
    // Only the new stroke was painted; nothing was rebuilt
    expect(canvas.renderer.forceRedraw).not.toHaveBeenCalled();
    expect(canvas.renderer.drawAddedStrokes).toHaveBeenCalledWith([
      expect.objectContaining({ id: "s-alice" }),
    ]);
    // Taking it in wrote nothing: there was nothing of Bob's the server lacked
    await storage.flushNoteWrites("n1");
    expect(bob.requests.filter((r) => r.method === "PUT")).toHaveLength(2);

    // Bob's next save replaces the version he took in: no second merge, and
    // Alice's strokes and text stay
    const before = bob.requests.length;
    dataChanges = [];
    await bobDraws(stroke("s-bob2", 12));
    expect(requestsSince(before)).toEqual(["GET", "PUT"]);
    expect(dataChanges.map((d) => d?.source)).toEqual(["local"]);
    const onServer = readOwner();
    expect(onServer.strokes.map((s) => s.id).sort()).toEqual([
      "s-alice",
      "s-bob",
      "s-bob2",
      "s-old",
    ]);
    expect(onServer.content).toBe("<p>leeks</p><p>carrots</p><p>onions</p>");

    // And the next look finds nothing new
    await expect(canvas._liveCheckNextcloud()).resolves.toBeUndefined();
  });

  it("merges a collaborator's text with an edit the editor has not saved yet", async () => {
    aliceSaves((n) => ({ ...n, content: `<p>leeks</p>${n.content}` }));
    // Bob typed; the editor's debounce has not sent it yet
    editorText = "<p>carrots</p><p>onions</p>";

    await expect(canvas._liveCheckNextcloud()).resolves.toBe("taken");
    expect(editorText).toBe("<p>leeks</p><p>carrots</p><p>onions</p>");

    // The merge is stored on top of Alice's version, without merging again
    await storage.flushNoteWrites("n1");
    expect(readOwner().content).toBe("<p>leeks</p><p>carrots</p><p>onions</p>");
    expect(dataChanges.map((d) => d?.source)).toEqual(["local"]);
  });

  it("waits for the user's pause when they started writing meanwhile", async () => {
    aliceSaves((n) => ({ ...n, strokes: [...n.strokes, stroke("s-alice", 9)] }));
    canvas.liveRefresh.setIdle(false);

    const before = bob.requests.length;
    await expect(canvas._liveCheckNextcloud()).resolves.toBe("deferred");
    expect(requestsSince(before)).toEqual(["PROPFIND"]); // nothing downloaded
    expect(canvas.noteData.strokes.map((s) => s.id)).toEqual(["s-old"]);

    canvas.liveRefresh.setIdle(true);
    await expect(canvas._liveCheckNextcloud()).resolves.toBe("taken");
    expect(canvas.noteData.strokes.map((s) => s.id)).toEqual(["s-old", "s-alice"]);
    // Strokes that only arrived move none of the user's: their undo history stays
    expect(canvas.historyManager.clear).not.toHaveBeenCalled();
  });

  it("puts a drawn stroke on the server at the user's next pause, for the others to see", async () => {
    const { LiveRefresh } = await import("./liveRefresh.js");
    Object.assign(canvas, {
      mode: "draw",
      _clearLongPress: vi.fn(),
      _isScratchGesture: () => false,
    });
    canvas.renderer.drawDirectStroke = vi.fn();
    canvas.historyManager.push = vi.fn();
    canvas.liveRefresh = new LiveRefresh(
      { check: async () => undefined, isBusy: () => canvas.inputHandler.isDrawing },
      { quietMs: 40 },
    );
    canvas.liveRefresh.start();

    // A stroke drawn and finished, as the input handler reports it
    canvas.strokeManager.startStroke({ x: 10, y: 10, pressure: 0.5 });
    canvas.strokeManager.addPoints([{ x: 20, y: 20, pressure: 0.5, time: 1 }]);
    canvas.liveRefresh.noteInput();
    canvas._onStrokeEnd();
    const drawn = canvas.noteData.strokes.at(-1).id;

    // Nothing is written while the user keeps writing
    canvas.inputHandler.isDrawing = true;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(bob.requests.some((r) => r.method === "PUT")).toBe(false);

    canvas.inputHandler.isDrawing = false;
    canvas.liveRefresh.noteInput();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await storage.flushNoteWrites("n1");
    expect(readOwner().strokes.map((s) => s.id)).toContain(drawn);
    canvas.liveRefresh.stop();
  });

  it("keeps a collaborator's move when the editor saves its older copy afterwards", async () => {
    aliceEdits((note) => {
      const s = note.strokes.find((x) => x.id === "s-old");
      s.y = s.y.map((y) => y + 300);
    });
    // Bob has not taken her move in yet, and saves a new stroke
    await bobDraws(stroke("s-bob", 5));
    expect(readOwner().strokes.find((s) => s.id === "s-old").y[0]).toBe(301);

    // His save merged, and says so: the editor takes the merge in
    expect(dataChanges.at(-1)).toEqual({ noteId: "n1", source: "merge" });
    await canvas.handleExternalDataChange(mergeEvent());
    expect(canvas.noteData.strokes.find((s) => s.id === "s-old").y[0]).toBe(301);
  });

  it("moves the editor's stroke drawn below a collaborator's insert space it had not seen", async () => {
    aliceEdits((note, versions) => versions.recordShift(note, { y: 50, delta: 100 }));
    await bobDraws({ id: "s-bob", x: [5, 6], y: [80, 90], pressure: [0.5, 0.5], width: 2 });

    const yOf = (strokes, id) => strokes.find((s) => s.id === id).y[0];
    expect(yOf(readOwner().strokes, "s-bob")).toBe(180);
    expect(yOf(readOwner().strokes, "s-old")).toBe(1); // above the line
    // The shift stays recorded, for writers that have not seen it yet
    expect(readOwner().shifts).toEqual([expect.objectContaining({ y: 50, delta: 100 })]);

    await canvas.handleExternalDataChange(mergeEvent());
    expect(yOf(canvas.noteData.strokes, "s-bob")).toBe(180);
  });

  it("does not undo a collaborator's insert space by saving copies from before it", async () => {
    // Alice inserts space above Bob's stroke, moving it
    await bobDraws({ id: "s-bob", x: [5, 6], y: [80, 90], pressure: [0.5, 0.5], width: 2 });
    aliceEdits((note, versions) => {
      versions.recordShift(note, { y: 50, delta: 100 });
      const s = note.strokes.find((x) => x.id === "s-bob");
      s.y = s.y.map((y) => y + 100);
    });
    // Bob saves again without having seen it
    await bobDraws(stroke("s-bob2", 9));
    expect(readOwner().strokes.find((s) => s.id === "s-bob").y[0]).toBe(180);
  });

  it("leaves a version a save of ours merged in the meantime to that save", async () => {
    aliceSaves((n) => ({ ...n, strokes: [...n.strokes, stroke("s-alice", 9)] }));
    const seen = await storage.remoteNoteChange("n1");
    expect(seen).toBeTruthy();

    // Bob's save lands first, merging Alice's strokes on the server
    await bobDraws(stroke("s-bob", 5));
    expect(storage.noteSyncUnchanged("n1", seen)).toBe(false);
    expect(dataChanges.map((d) => d?.source)).toContain("merge");
    expect(
      readOwner()
        .strokes.map((s) => s.id)
        .sort(),
    ).toEqual(["s-alice", "s-bob", "s-old"]);
  });
});
