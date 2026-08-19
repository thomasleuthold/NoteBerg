/**
 * src/components/NoteCanvas/index.test.js
 *
 * The rendernotebook handler clears its container and then awaits load(). Two
 * renders in quick succession (two navigations — e.g. the double-submitted
 * create this was found through) used to interleave: both instances finished
 * loading and both appended themselves, but only the later was kept in the
 * module slot. The earlier became an orphan — unreachable yet still live,
 * holding listeners, its autosave timer and worker handles, and still able to
 * write to the DB.
 *
 * The NoteCanvas mock gates load() on a promise the test controls, because the
 * interleaving only exists when a load is genuinely slower than the next
 * navigation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NoteCanvas.js touches canvas APIs at import time that jsdom does not provide.
globalThis.DOMMatrix = class {
  constructor() {
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.e = 0;
    this.f = 0;
  }
};

const loadCalls = [];
const destroyCalls = [];
/** Instances that finished load() without being torn down. */
const liveInstances = new Set();
let nextLoadGate = null;

vi.mock("./NoteCanvas.js", () => ({
  NoteCanvas: class {
    constructor(container) {
      this.containerElement = container;
      this.isInitialized = false;
      this.noteId = null;
    }

    async load(noteId) {
      loadCalls.push(noteId);
      this.noteId = noteId;
      if (nextLoadGate) await nextLoadGate.promise;
      // Mirrors the real load(): it clears the container and mounts into it
      // *after* its awaits, which is precisely why two overlapping renders can
      // both end up mounted (see NoteCanvas.js — containerElement.innerHTML = "").
      this.containerElement.innerHTML = "";
      this.isInitialized = true;
      liveInstances.add(this);
      const el = document.createElement("div");
      el.className = "editor";
      el.textContent = noteId;
      this.containerElement.appendChild(el);
    }

    destroy() {
      destroyCalls.push(this.noteId ?? "unloaded");
      liveInstances.delete(this);
      this.isInitialized = false;
      return Promise.resolve({});
    }

    hasContentChanged() {
      return Promise.resolve(false);
    }

    flushPendingSaves() {}
  },
}));

vi.mock("../../modules/autoSync.js", () => ({ syncOnNoteClose: vi.fn() }));
vi.mock("../HelpOverlay.js", () => ({ startHelpTour: vi.fn() }));
vi.mock("../helpContent.js", () => ({
  getHelpContent: () => new Proxy({}, { get: () => ({ title: "t", body: "b" }) }),
  getHelpLabels: () => ({}),
}));
vi.mock("../../modules/helpGuidance.js", () => ({ HELP_IDS: { FIRST_NOTE: "first-note" } }));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function render(noteId) {
  window.dispatchEvent(new CustomEvent("rendernotebook", { detail: { noteId } }));
}

function editorsInDom() {
  return Array.from(document.querySelectorAll("#notebook-editor-container .editor")).map(
    (el) => el.textContent,
  );
}

function noteIdsOfLiveInstances() {
  return [...liveInstances].map((i) => i.noteId).sort();
}

let mod;

/**
 * initNoteCanvasComponent binds window/document listeners. vi.resetModules()
 * hands each test a fresh module, but listeners registered by *previous*
 * instances stay attached to the shared jsdom window and keep handling
 * rendernotebook against their own stale module state — so a later test sees
 * several modules all rendering into the same container. Track and detach them
 * per test. (Same approach as router.test.js.)
 */
let boundListeners;
const realWinAdd = window.addEventListener.bind(window);
const realWinRemove = window.removeEventListener.bind(window);
const realDocAdd = document.addEventListener.bind(document);
const realDocRemove = document.removeEventListener.bind(document);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  loadCalls.length = 0;
  destroyCalls.length = 0;
  liveInstances.clear();
  nextLoadGate = null;
  document.body.innerHTML = '<div id="notebook-editor-container"></div>';

  boundListeners = [];
  window.addEventListener = (type, handler, options) => {
    boundListeners.push(["window", type, handler]);
    return realWinAdd(type, handler, options);
  };
  document.addEventListener = (type, handler, options) => {
    boundListeners.push(["document", type, handler]);
    return realDocAdd(type, handler, options);
  };

  mod = await import("./index.js");
  mod.initNoteCanvasComponent();
});

afterEach(() => {
  for (const [target, type, handler] of boundListeners) {
    if (target === "window") realWinRemove(type, handler);
    else realDocRemove(type, handler);
  }
  window.addEventListener = realWinAdd;
  document.addEventListener = realDocAdd;
});

describe("rendernotebook — overlapping renders", () => {
  it("shows only the newest note when two renders overlap", async () => {
    const gate = deferred();
    nextLoadGate = gate;

    render("noteA");
    await flush();
    render("noteB");
    await flush();

    gate.resolve();
    await flush();
    await flush();

    // The winning render clears the container before mounting, so this holds on
    // the old code too — the damage there is the orphaned *instance* behind the
    // DOM (covered by the next test), not what the user sees.
    expect(editorsInDom()).toEqual(["noteB"]);
    expect(noteIdsOfLiveInstances()).toEqual(["noteB"]);
  });

  it("does not leave the superseded instance live", async () => {
    const gate = deferred();
    nextLoadGate = gate;

    render("noteA");
    await flush();
    render("noteB");
    await flush();

    gate.resolve();
    await flush();
    await flush();

    // Exactly one instance survives: an orphan would keep its listeners,
    // autosave timer and worker handles alive and could still write to the DB.
    expect(liveInstances.size).toBe(1);
    expect([...liveInstances][0].noteId).toBe("noteB");
  });

  it("destroys the superseded instance rather than dropping it", async () => {
    const gate = deferred();
    nextLoadGate = gate;

    render("noteA");
    await flush();
    render("noteB");
    await flush();

    gate.resolve();
    await flush();
    await flush();

    // destroy() is null-guarded throughout, so it is safe on a partially built
    // instance — and required, since one can still hold a worker connection and
    // half-built layers.
    expect(destroyCalls).toContain("noteA");
  });

  it("still renders normally for a single navigation", async () => {
    render("noteA");
    await flush();

    expect(editorsInDom()).toEqual(["noteA"]);
    expect(liveInstances.size).toBe(1);
  });

  it("tears down the previous note when navigating between two notes in sequence", async () => {
    render("noteA");
    await flush();
    render("noteB");
    await flush();

    expect(editorsInDom()).toEqual(["noteB"]);
    expect(destroyCalls).toContain("noteA");
    expect(liveInstances.size).toBe(1);
  });
});

describe("rendernotebook — failed load", () => {
  it("does not clobber a newer render when a superseded load fails", async () => {
    const { NoteCanvas } = await import("./NoteCanvas.js");
    const failGate = deferred();
    const originalLoad = NoteCanvas.prototype.load;
    let call = 0;

    NoteCanvas.prototype.load = async function load(noteId) {
      call += 1;
      if (call === 1) {
        this.noteId = noteId;
        await failGate.promise;
        throw new Error("load failed");
      }
      return originalLoad.call(this, noteId);
    };

    try {
      render("noteA");
      await flush();
      render("noteB");
      await flush();

      failGate.resolve();
      await flush();
      await flush();

      // noteB's editor must survive, and no error panel may replace it.
      expect(editorsInDom()).toEqual(["noteB"]);
      expect(document.querySelector(".note-canvas__error")).toBeNull();
    } finally {
      NoteCanvas.prototype.load = originalLoad;
    }
  });

  it("shows the error panel when the current render fails", async () => {
    const { NoteCanvas } = await import("./NoteCanvas.js");
    const originalLoad = NoteCanvas.prototype.load;
    NoteCanvas.prototype.load = async () => {
      throw new Error("boom");
    };

    try {
      render("noteA");
      await flush();

      expect(document.querySelector(".note-canvas__error-message").textContent).toBe("boom");
    } finally {
      NoteCanvas.prototype.load = originalLoad;
    }
  });
});
