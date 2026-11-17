/**
 * src/modules/storage.webdav.sharing.nextcloud.test.js
 * Notebooks shared with the user on the Nextcloud app build (run by
 * `npm run test:nextcloud`): listed from the owner's folders through a
 * registry kept in memory, never written outside what the share allows, and
 * never mistaken for the user's own data.
 *
 * Runs as "bob" in the browser (session cookie); "alice" owns the notebook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud } from "./__fixtures__/mockOcsServer.js";

vi.mock("./sharing/config.js", () => ({ SHARING_ENABLED: true }));

// Each test loads a fresh copy of the module, which registers its own document
// listener; keep them from outliving the test that created them
const documentListeners = [];

let nc;
let alice;
let bob;
let storage;
let paths;

const WRITES = ["PUT", "MKCOL", "DELETE", "MOVE", "COPY"];
const writes = (server) => server.requests.filter((r) => WRITES.includes(r.method));
const ocsRequests = () => nc.requests.filter((r) => r.path.includes("/shares"));
const NB = "nb1";
const ownerNotePath = (id) => `/NoteBerg/notebooks/${NB}/notes/${id}.json`;
const readOwner = (path) => JSON.parse(alice.files.get(path).content);

async function load() {
  vi.resetModules();
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    documentListeners.push([type, listener]);
    add(type, listener, options);
  });
  storage = await import("./storage.webdav.js");
  paths = await import("./storagePaths.js");
}

beforeEach(() => {
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
    strokes: [],
    modified: 1000,
    version: 1,
  });
  bob.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
  bob.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });
  bob.seedNotebook("mine", { title: "Mine", modified: 500 });
  bob.seedNote("mine", { id: "m1", notebookId: "mine", title: "Own", modified: 500, version: 1 });
});

afterEach(() => {
  for (const [type, listener] of documentListeners.splice(0)) {
    document.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.OC;
});

describe("with no share at all", () => {
  it("lists only the user's own notebooks and behaves as before", async () => {
    await load();
    await storage.initStorage();

    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
    expect((await storage.getAllNotes()).map((n) => n.id)).toEqual(["m1"]);
    // Only the required folders are created, as ever
    expect(writes(bob).every((r) => r.method === "MKCOL")).toBe(true);
    expect(ocsRequests().filter((r) => r.method !== "GET")).toEqual([]);
  });
});

describe("loading the app", () => {
  it("lists a shared notebook next to the user's own, with its notes", async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();

    await storage.initStorage();

    const notebooks = await storage.getAllNotebooks();
    expect(notebooks.map((n) => n.id).sort()).toEqual(["mine", NB]);
    const shared = notebooks.find((n) => n.id === NB);
    expect(shared).toMatchObject({
      title: "Recipes",
      origin: "shared",
      ownerUid: "alice",
      ownerDisplayName: "Alice Anderson",
      sharePermissions: 7,
    });
    expect((await storage.getNotesByNotebook(NB)).map((n) => n.id)).toEqual(["n1"]);
    expect((await storage.getAllNotes()).map((n) => n.id).sort()).toEqual(["m1", "n1"]);
    expect((await storage.getNote("n1")).title).toBe("Soup");
  });

  it("moves the share into the shared folder, once", async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();

    expect(bob.mounts.values().next().value.path).toBe("/Shared_NoteBerg/nb1");
    expect(paths.getNotebookFolder(NB)).toBe("/Shared_NoteBerg/nb1");
  });

  it("moves a foreign folder mounted at /NoteBerg out of the way before touching it", async () => {
    bob.files.delete("/NoteBerg");
    alice.files.set("/Impostor", { isCollection: true, mtime: new Date() });
    bob.addMount({
      shareId: "50",
      path: "/NoteBerg",
      source: alice,
      sourcePath: "/Impostor",
      permissions: 7,
    });
    nc.shares.set("50", {
      id: "50",
      owner: "alice",
      shareWith: "bob",
      path: "/Impostor",
      itemSource: "x",
      permissions: 7,
      state: 0,
    });
    await load();

    await storage.initStorage();

    expect(bob.mounts.get("50").path).toBe("/Shared_NoteBerg/alice_NoteBerg");
    expect(bob.files.get("/NoteBerg")?.isCollection).toBe(true);
    // Nothing was written into alice's folder
    expect(writes(alice).filter((r) => r.path.startsWith("/Impostor"))).toEqual([]);
  });

  // Switching sharing on in Settings, mid-session: the check initStorage() makes
  // at load happens then, not at the next load
  it("checks the root when sharing is switched on in Settings", async () => {
    bob.files.delete("/NoteBerg");
    alice.files.set("/Impostor", { isCollection: true, mtime: new Date() });
    bob.addMount({
      shareId: "50",
      path: "/NoteBerg",
      source: alice,
      sourcePath: "/Impostor",
      permissions: 7,
    });
    nc.shares.set("50", {
      id: "50",
      owner: "alice",
      shareWith: "bob",
      path: "/Impostor",
      itemSource: "x",
      permissions: 7,
      state: 0,
    });
    await load();

    const result = await storage.guardRootForSharing();

    expect(result.moved).toBe(true);
    expect(bob.mounts.get("50").path).toBe("/Shared_NoteBerg/alice_NoteBerg");
    // The own tree is there again, ready for use
    expect(bob.files.get("/NoteBerg")?.isCollection).toBe(true);
    expect(bob.files.get("/NoteBerg/notebooks")?.isCollection).toBe(true);
    expect(writes(alice).filter((r) => r.path.startsWith("/Impostor"))).toEqual([]);
  });

  it("leaves an own root alone when sharing is switched on in Settings", async () => {
    await load();
    const before = writes(bob).length;

    expect(await storage.guardRootForSharing()).toEqual({ moved: false });
    expect(writes(bob)).toHaveLength(before);
  });

  it("reports a root that cannot be verified when sharing is switched on in Settings", async () => {
    bob.failEvery({ method: "PROPFIND", pathMatch: "/NoteBerg", status: 500 });
    await load();
    await expect(storage.guardRootForSharing()).rejects.toThrow();
  });

  it("does not load the app when the root cannot be verified", async () => {
    bob.failEvery({ method: "PROPFIND", pathMatch: "/NoteBerg", status: 500 });
    await load();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(storage.initStorage()).rejects.toThrow();
    error.mockRestore();
  });
});

describe("listing", () => {
  beforeEach(async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
  });

  it("asks the server for shares at most once a minute while the list is read", async () => {
    const before = ocsRequests().length;
    await storage.getAllNotebooks();
    await storage.getAllNotebooks();
    expect(ocsRequests().length).toBe(before);
  });

  it("picks up a new share when the tab becomes visible again", async () => {
    alice.seedNotebook("nb2", { title: "Garden" });
    await nc.share("alice", "/NoteBerg/notebooks/nb2", "bob", 1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(async () => {
      expect((await storage.getAllNotebooks()).map((n) => n.id)).toContain("nb2");
    });
  });

  it("announces a change in the shares so the overview re-renders", async () => {
    const changed = vi.fn();
    window.addEventListener("datachange", changed);
    alice.seedNotebook("nb2", { title: "Garden" });
    await nc.share("alice", "/NoteBerg/notebooks/nb2", "bob", 1);

    await storage.refreshSharedNotebooks();

    expect(changed).toHaveBeenCalled();
    window.removeEventListener("datachange", changed);
  });

  it("excludes shared notebooks and their notes from the trash views", async () => {
    // The owner trashed a note and a notebook; those are the owner's to restore
    const trashed = readOwner(ownerNotePath("n1"));
    alice.files.get(ownerNotePath("n1")).content = JSON.stringify({ ...trashed, deleted: true });
    const trashedNotebook = readOwner(`/NoteBerg/notebooks/${NB}/_notebook.json`);
    alice.files.get(`/NoteBerg/notebooks/${NB}/_notebook.json`).content = JSON.stringify({
      ...trashedNotebook,
      deleted: true,
    });
    bob.seedNote("mine", { id: "g1", notebookId: "mine", deleted: true, modified: 1 });
    bob.seedNotebook("gone", { title: "Gone", deleted: true });
    await storage.refreshSharedNotebooks(); // re-read the listing

    expect((await storage.getDeletedNotes()).map((n) => n.id)).toEqual(["g1"]);
    expect((await storage.getDeletedNotebooks()).map((n) => n.id)).toEqual(["gone"]);
  });
});

// Sharing is a preview the user turns on. Off, the app lists the user's own
// notebooks only and asks the server nothing about shares.
describe("with sharing switched off", () => {
  beforeEach(async () => {
    localStorage.setItem("sharing_enabled", "false");
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
  });

  it("lists the user's own notebooks only, and asks the server nothing about shares", async () => {
    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
    expect(ocsRequests()).toHaveLength(0);
  });

  it("stops listing shared notebooks when sharing is switched off in Settings", async () => {
    localStorage.setItem("sharing_enabled", "true");
    window.dispatchEvent(
      new CustomEvent("sharing-preference-changed", { detail: { enabled: true } }),
    );
    await storage.refreshSharedNotebooks();
    expect((await storage.getAllNotebooks()).map((n) => n.id)).toContain(NB);

    localStorage.setItem("sharing_enabled", "false");
    window.dispatchEvent(
      new CustomEvent("sharing-preference-changed", { detail: { enabled: false } }),
    );

    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
  });
});

describe("writing", () => {
  beforeEach(async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
    bob.requests.length = 0;
  });

  it("saves an edited note into the owner's tree, never into the own tree", async () => {
    await storage.getNote("n1");
    await storage.updateNote("n1", { content: "<p>carrots and leeks</p>" });

    expect(readOwner(ownerNotePath("n1")).content).toBe("<p>carrots and leeks</p>");
    expect(readOwner(ownerNotePath("n1")).lastModifiedBy).toBe("bob");
    expect(bob.requests.filter((r) => r.path.startsWith("/NoteBerg/notebooks/nb1"))).toEqual([]);
  });

  it("creates a note in a shared notebook inside the share", async () => {
    const note = await storage.createNote({ title: "Cake", notebookId: NB });
    expect(alice.files.has(ownerNotePath(note.id))).toBe(true);
    expect([...bob.files.keys()].some((p) => p.includes(note.id))).toBe(false);
  });

  it("keeps two simultaneous writers' strokes", async () => {
    await storage.getNote("n1");
    const current = readOwner(ownerNotePath("n1"));
    alice.files.set(ownerNotePath("n1"), {
      content: JSON.stringify({ ...current, strokes: [{ id: "s-alice", x: [1], y: [1] }] }),
      etag: "alice-wrote",
      mtime: new Date(),
    });

    await storage.updateNoteCoalesced("n1", {
      strokes: [{ id: "s-bob", x: [2], y: [2] }],
      deletedStrokes: [],
    });

    expect(
      readOwner(ownerNotePath("n1"))
        .strokes.map((s) => s.id)
        .sort(),
    ).toEqual(["s-alice", "s-bob"]);
  });

  it("never uploads the local-only sharing fields when the notebook is renamed", async () => {
    await storage.updateNotebook(NB, { title: "Family recipes" });

    const stored = readOwner(`/NoteBerg/notebooks/${NB}/_notebook.json`);
    expect(stored.title).toBe("Family recipes");
    for (const field of ["origin", "ownerUid", "sharePermissions", "shareId", "remoteBasePath"]) {
      expect(stored).not.toHaveProperty(field);
    }
  });

  it("does not delete orphaned media from a shared note", async () => {
    alice.seedMedia(NB, "n1", "old-file");
    await storage.cleanupNoteMedia("n1", NB, []);
    expect(bob.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    expect([...alice.files.keys()].some((p) => p.endsWith("old-file.bin"))).toBe(true);
  });

  it("uploads media into the share", async () => {
    await storage.saveMediaForNote(new Blob(["x"], { type: "image/png" }), "f1", "n1", NB);
    expect([...alice.files.keys()].some((p) => p.includes("/notes/n1_media/f1"))).toBe(true);
  });
});

describe("when the share ends", () => {
  beforeEach(async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
    await storage.getNote("n1");
    bob.requests.length = 0;
  });

  const endShare = () => {
    nc.shares.delete("1");
    bob.removeMount("1");
  };

  it("fails the write that notices, then refuses later ones without touching the own tree", async () => {
    endShare();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(storage.updateNote("n1", { title: "Late edit" })).rejects.toThrow();
    // The failed write made the app look again: the share is now known to be gone
    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
    await expect(storage.updateNote("n1", { title: "Later edit" })).rejects.toThrow();
    await expect(storage.createNote({ title: "x", notebookId: NB })).rejects.toThrow(/ended/);

    // Neither the write attempts nor the lookups created anything in /NoteBerg
    expect([...bob.files.keys()].filter((p) => p.includes(NB) || p.includes("n1"))).toEqual([]);
    expect(writes(bob).filter((r) => r.path.startsWith("/NoteBerg"))).toEqual([]);
    error.mockRestore();
  });

  it("is noticed by the periodic look as well", async () => {
    endShare();
    await storage.refreshSharedNotebooks();
    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
    expect(() => paths.getNotebookFolder(NB)).toThrow(/ended/);
  });

  it("is not mistaken for ending when the listing merely fails", async () => {
    endShare();
    window.OC.requestToken = ""; // the session is no longer accepted: OCS answers 401
    nc.sessionUser = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await storage.refreshSharedNotebooks();
    expect(paths.getNotebookFolder(NB)).toBe("/Shared_NoteBerg/nb1");
    warn.mockRestore();
  });
});

describe("a read-only share", () => {
  it("is listed with the permissions the server granted", async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 1);
    await load();
    await storage.initStorage();
    expect((await storage.getNotebook(NB)).sharePermissions).toBe(1);
  });
});

describe("what a recipient may never do", () => {
  // Whatever the share grants, none of these may reach the server
  describe.each([
    ["read-only", 1],
    ["collab", 7],
  ])("on a %s share", (_label, permissions) => {
    beforeEach(async () => {
      await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", permissions);
      await load();
      await storage.initStorage();
      await storage.getNote("n1");
      bob.requests.length = 0;
      alice.requests.length = 0;
    });

    it.each([
      ["deleteNote", () => storage.deleteNote("n1")],
      ["deleteNotebook", () => storage.deleteNotebook(NB)],
      ["purgeNote", () => storage.purgeNote("n1")],
      ["permanentlyDeleteNote", () => storage.permanentlyDeleteNote("n1")],
      ["permanentlyDeleteNotebook", () => storage.permanentlyDeleteNotebook(NB)],
      ["purgeNotebook", () => storage.purgeNotebook(NB)],
      ["restoreNote", () => storage.restoreNote("n1")],
      ["restoreNotebook", () => storage.restoreNotebook(NB)],
      ["moveNote out of it", () => storage.moveNote("n1", "mine")],
      ["moveNote into it", () => storage.moveNote("m1", NB)],
      ["copyNote out of it", () => storage.copyNote("n1", "mine")],
      ["copyNote into it", () => storage.copyNote("m1", NB)],
    ])("refuses %s without a single write request", async (_name, action) => {
      const { ShareRestrictedError } = await import("./sharing/shareRestrictions.js");

      await expect(action()).rejects.toBeInstanceOf(ShareRestrictedError);

      expect(writes(bob)).toEqual([]);
      expect(writes(alice)).toEqual([]);
    });
  });

  describe("content writes", () => {
    it("are allowed on a collaborative share", async () => {
      await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
      await load();
      await storage.initStorage();
      await expect(storage.updateNote("n1", { title: "Edited" })).resolves.toBeDefined();
      await expect(storage.updateNotebook(NB, { title: "Renamed" })).resolves.toBeDefined();
      await expect(storage.createNote({ title: "New", notebookId: NB })).resolves.toBeDefined();
    });

    it("are refused on a read-only share, before anything is sent", async () => {
      await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 1);
      await load();
      await storage.initStorage();
      await storage.getNote("n1");
      bob.requests.length = 0;
      const { ShareRestrictedError } = await import("./sharing/shareRestrictions.js");

      await expect(storage.updateNote("n1", { title: "x" })).rejects.toBeInstanceOf(
        ShareRestrictedError,
      );
      await expect(storage.updateNoteCoalesced("n1", { strokes: [] })).rejects.toBeInstanceOf(
        ShareRestrictedError,
      );
      await expect(storage.updateNotebook(NB, { title: "x" })).rejects.toBeInstanceOf(
        ShareRestrictedError,
      );
      await expect(storage.createNote({ title: "x", notebookId: NB })).rejects.toBeInstanceOf(
        ShareRestrictedError,
      );

      expect(writes(bob)).toEqual([]);
      expect(readOwner(ownerNotePath("n1")).title).toBe("Soup");
    });
  });

  it("leave the user's own notebooks alone while shares exist", async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 1);
    await load();
    await storage.initStorage();

    await expect(storage.updateNote("m1", { title: "Edited" })).resolves.toBeDefined();
    await expect(storage.deleteNote("m1")).resolves.toBeDefined();
    await expect(storage.createNote({ title: "Quick" })).resolves.toBeDefined();
  });
});

describe("leaving a share", () => {
  beforeEach(async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
  });

  it("removes only this user's access, then the notebook from the list", async () => {
    await storage.leaveSharedNotebook(NB);

    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
    expect(bob.mounts.size).toBe(0);
    expect(alice.files.has(`/NoteBerg/notebooks/${NB}/_notebook.json`)).toBe(true);
    expect(() => paths.getNotebookFolder(NB)).toThrow(/ended/);
  });

  it("tells the app the list changed", async () => {
    const changed = vi.fn();
    window.addEventListener("datachange", changed);
    await storage.leaveSharedNotebook(NB);
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("datachange", changed);
  });

  it("does nothing for a notebook that is not shared with the user", async () => {
    await storage.leaveSharedNotebook("mine");
    expect(ocsRequests().filter((r) => r.method === "DELETE")).toEqual([]);
    expect((await storage.getAllNotebooks()).map((n) => n.id).sort()).toEqual(["mine", NB]);
  });

  it("keeps the notebook when the server refuses to let go", async () => {
    nc.shares.delete("1"); // the share is already gone server-side: DELETE answers 404
    await expect(storage.leaveSharedNotebook(NB)).rejects.toThrow();
    expect(paths.getNotebookFolder(NB)).toBe("/Shared_NoteBerg/nb1");
  });
});

describe("files in a share that claim to be something else", () => {
  // Another user writes the share's files; these stand in for a buggy or hostile one
  const plant = (path, data) =>
    alice.files.set(path, {
      content: JSON.stringify(data),
      etag: `planted-${alice.files.size}`,
      mtime: new Date(),
    });
  const bobsOwnNote = () =>
    JSON.parse(bob.files.get("/NoteBerg/notebooks/mine/notes/m1.json").content);

  async function openShare() {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
  }

  it("never let a shared note file stand in for one of the user's own notes", async () => {
    // A file in the share claiming the id of bob's own note m1
    plant(ownerNotePath("decoy"), {
      id: "m1",
      notebookId: NB,
      title: "Fake",
      content: "<p>fake</p>",
      modified: 2000,
      version: 1,
    });
    await openShare();

    expect((await storage.getNotesByNotebook(NB)).map((n) => n.id)).toEqual(["n1"]);
    await storage.getAllNotes(); // reads every folder, the share's too
    expect((await storage.getNote("m1")).title).toBe("Own");

    await storage.updateNote("m1", { title: "Still mine" });
    expect(bobsOwnNote().title).toBe("Still mine");
    expect(readOwner(ownerNotePath("decoy")).title).toBe("Fake"); // nothing written into the share
  });

  it("ignore a note whose id is not safe to put into paths and markup", async () => {
    plant(ownerNotePath("bad id"), { id: "bad id", notebookId: NB, title: "Bad" });
    await openShare();
    expect((await storage.getNotesByNotebook(NB)).map((n) => n.id)).toEqual(["n1"]);
  });

  it("ignore a note that says it belongs to another notebook", async () => {
    plant(ownerNotePath("n2"), { id: "n2", notebookId: "mine", title: "Elsewhere" });
    await openShare();
    expect((await storage.getNotesByNotebook(NB)).map((n) => n.id)).toEqual(["n1"]);
    expect(await storage.getNote("n2")).toBeNull();
  });

  it("stop listing a shared notebook whose file starts claiming another id", async () => {
    await openShare();
    // After registration, the owner's file now claims to be bob's own notebook
    plant(`/NoteBerg/notebooks/${NB}/_notebook.json`, { id: "mine", title: "Mine (fake)" });
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 20_000); // past the read cache

    const notebooks = await storage.getAllNotebooks();

    expect(notebooks.map((n) => n.id)).toEqual(["mine"]);
    expect(notebooks[0].title).toBe("Mine");
    expect(await storage.getNotebook(NB)).toBeNull();
  });
});

// Closing a note navigates to the notebook view at once, while the note's last
// saves are still being written. Nextcloud answers a read of a file being written
// with 423 Locked, and a write into someone else's share takes longer.
describe("the notebook view while a note is being saved", () => {
  beforeEach(async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
  });
  const titles = async () => (await storage.getNotesByNotebook(NB)).map((n) => n.title);

  it("still lists a note whose file is locked for a moment", async () => {
    bob.failNext({ method: "GET", pathMatch: "/notes/n1.json", status: 423 });
    expect(await titles()).toEqual(["Soup"]);
  });

  it("does not keep a listing that missed a note, so the next look finds it", async () => {
    bob.failEvery({ method: "GET", pathMatch: "/notes/n1.json", status: 423 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await titles()).toEqual([]); // still locked after the retry
    warn.mockRestore();
    bob.clearFaults();

    expect(await titles()).toEqual(["Soup"]); // not served from the cache
  });

  it("does not keep a listing read while the note was being written", async () => {
    await storage.getNote("n1", { track: true });
    // The notebook view lists the folder while the PUT is in flight
    const original = globalThis.fetch;
    let listedDuring = null;
    vi.stubGlobal("fetch", async (url, options) => {
      if (options?.method === "PUT" && url.includes("/notes/n1.json") && !listedDuring) {
        listedDuring = await titles();
      }
      return original(url, options);
    });

    await storage.updateNote("n1", { title: "Soup v2" });

    expect(listedDuring).toEqual(["Soup"]);
    expect(await titles()).toEqual(["Soup v2"]);
  });
});

// Paths go into URLs: a share can sit in any folder the user moved it to, and
// a Nextcloud user ID can hold a space or "@"
describe("names that need encoding in a URL", () => {
  it("reads and writes a share in a folder whose name holds # % ? and spaces", async () => {
    await nc.share("alice", `/NoteBerg/notebooks/${NB}`, "bob", 7);
    await load();
    await storage.initStorage();
    const odd = "/Ideas #2/100% done? (a&b)";
    bob.files.set("/Ideas #2", { isCollection: true, mtime: new Date() });
    bob.mounts.values().next().value.path = odd;
    await storage.refreshSharedNotebooks();
    expect(paths.getNotebookFolder(NB)).toBe(odd);

    expect((await storage.getNotesByNotebook(NB)).map((n) => n.title)).toEqual(["Soup"]);
    await storage.updateNote("n1", { title: "Soup v2" });

    expect(readOwner(ownerNotePath("n1")).title).toBe("Soup v2");
  });

  it("works for a user whose ID holds a space and an @", async () => {
    nc.addUser("carol jones@x", { displayName: "Carol" });
    nc.sessionUser = "carol jones@x";
    const carol = nc.dav("carol jones@x");
    carol.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
    carol.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });
    window.OC.currentUser = "carol jones@x";
    window.OC.getCurrentUser = () => ({ uid: "carol jones@x" });
    await load();
    await storage.initStorage();

    const notebook = await storage.createNotebook({ title: "Mine" });

    expect(carol.files.has(`/NoteBerg/notebooks/${notebook.id}/_notebook.json`)).toBe(true);
    expect((await storage.getAllNotebooks()).map((n) => n.title)).toContain("Mine");
  });
});

// A server that asks for acceptance: the app offers the share and does what the
// user answers, never accepting on its own. Notebook folders are named by the
// notebook's id, a UUID, which is how an offered notebook is told from a folder.
describe("a notebook offered to the user", () => {
  const ID = "3f2c9a1e-8b4d-4c2a-9f1e-7a6b5c4d3e2f";
  let share;
  beforeEach(async () => {
    alice.seedNotebook(ID, { title: "Garden" });
    alice.seedNote(ID, { id: "g1", notebookId: ID, title: "Tomatoes", modified: 1, version: 1 });
    nc.users.get("bob").autoAccept = false;
    share = await nc.share("alice", `/NoteBerg/notebooks/${ID}`, "bob", 7);
    await load();
    await storage.initStorage();
  });
  const offered = async () => (await import("./sharing/invitations.js")).getInvitations();
  const actions = () => import("./sharing/shareActions.js");

  it("is offered, not accepted and not listed", async () => {
    expect(nc.shares.get(share.id).state).toBe(1);
    expect((await storage.getAllNotebooks()).map((n) => n.id)).toEqual(["mine"]);
    expect(await offered()).toEqual([
      { shareId: share.id, ownerUid: "alice", ownerDisplayName: "Alice Anderson" },
    ]);
  });

  it("appears with its notes once accepted", async () => {
    const { acceptInvitation } = await actions();
    await acceptInvitation((await offered())[0]);

    expect((await storage.getAllNotebooks()).map((n) => n.id).sort()).toEqual([ID, "mine"]);
    expect((await storage.getNotesByNotebook(ID)).map((n) => n.title)).toEqual(["Tomatoes"]);
    expect(await offered()).toEqual([]);
  });

  it("is never offered again once declined", async () => {
    const { declineInvitation } = await actions();
    await declineInvitation((await offered())[0]);

    expect(nc.shares.get(share.id).state).toBe(2);
    await storage.refreshSharedNotebooks();
    expect(await offered()).toEqual([]);
    expect(bob.mounts.size).toBe(0);
  });

  it("leaves an ordinary folder shared the same way to Nextcloud", async () => {
    alice.files.set("/Photos", { isCollection: true, mtime: new Date() });
    const photos = await nc.share("alice", "/Photos", "bob", 1);

    await storage.refreshSharedNotebooks();

    expect((await offered()).map((i) => i.shareId)).toEqual([share.id]);
    expect(nc.shares.get(photos.id).state).toBe(1);
  });
});
