/**
 * src/modules/sharing/nativeSharing.test.js
 * The native build's side of sharing: registrations kept as notebook records,
 * and the preparation every sync starts with (root guard, then discovery).
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../__fixtures__/mockOcsServer.js";
import { getNotebookFolder } from "../storagePaths.js";
import {
  createNativeShareStore,
  discardStrandedChanges,
  dismissEndedSharedNotebook,
  hasUnsyncedChangesInSharedNotebook,
  leaveSharedNotebook,
  prepareSharing,
  resetSharingSession,
  runDiscovery,
} from "./nativeSharing.js";
import { SHARE_REFRESH_INTERVAL_MS } from "./refreshInterval.js";
import { SHARE_ENDED_EVENT } from "./shareEvents.js";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("../encryption.js", () => ({ decryptObject: vi.fn() }));

const secrets = new Map();
vi.mock("../secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));

// Local storage: notebooks and note indexes in Maps, with the semantics sync relies on
const db = { notebooks: new Map(), notes: new Map() };
vi.mock("../storage.js", () => ({
  discardLocalChanges: vi.fn(async (id) => {
    const note = db.notes.get(id);
    if (note) db.notes.set(id, { ...note, synced: true, lastSyncedEtag: null });
  }),
  getAllNotebooksForSync: vi.fn(async () => [...db.notebooks.values()].map((n) => ({ ...n }))),
  getAllNoteMetadataForSync: vi.fn(async () => [...db.notes.values()].map((n) => ({ ...n }))),
  getNotebook: vi.fn(async (id) =>
    db.notebooks.has(id) ? { ...db.notebooks.get(id) } : undefined,
  ),
  saveNotebook: vi.fn(async (nb) => void db.notebooks.set(nb.id, { ...nb })),
  permanentlyDeleteNotebook: vi.fn(async (id) => void db.notebooks.delete(id)),
  permanentlyDeleteNotesInNotebook: vi.fn(async (id) => {
    for (const [noteId, note] of db.notes) if (note.notebookId === id) db.notes.delete(noteId);
  }),
}));

let nc;
let alice;
let bob;

beforeEach(() => {
  vi.clearAllMocks();
  resetSharingSession();
  db.notebooks.clear();
  db.notes.clear();
  secrets.clear();
  nc = new MockNextcloud();
  nc.addUser("alice", { displayName: "Alice" });
  nc.addUser("bob");
  alice = nc.dav("alice");
  bob = nc.dav("bob");
  wireMockNextcloud(fetch, nc);
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: nc.baseUrl,
      loginName: "bob",
      appPassword: "app-password-123",
      userId: "bob",
    }),
  );
  alice.seedNotebook("nb1", { title: "Recipes" });
});

describe("the native registration store", () => {
  it("lists every notebook record, own and shared", async () => {
    db.notebooks.set("own", { id: "own" });
    db.notebooks.set("sh", { id: "sh", origin: "shared" });
    const records = await createNativeShareStore().list();
    expect(records.map((r) => r.id).sort()).toEqual(["own", "sh"]);
  });

  it("upserts and updates records without marking them for upload, and announces the change", async () => {
    const store = createNativeShareStore();
    const events = [];
    window.addEventListener("datachange", () => events.push(1));

    await store.upsert({ id: "sh", origin: "shared", synced: true });
    await store.update("sh", { sharePermissions: 1 });

    expect(db.notebooks.get("sh")).toMatchObject({ synced: true, sharePermissions: 1 });
    expect(events.length).toBe(2);
  });

  it("ignores an update for a notebook that is no longer there", async () => {
    await createNativeShareStore().update("ghost", { shareEnded: true });
    expect(db.notebooks.size).toBe(0);
  });

  it("forgets a notebook and its notes locally, and makes its paths unresolvable", async () => {
    db.notebooks.set("sh", { id: "sh", origin: "shared" });
    db.notes.set("n1", { id: "n1", notebookId: "sh" });
    db.notes.set("n2", { id: "n2", notebookId: "other" });

    await createNativeShareStore().forget("sh");

    expect(db.notebooks.has("sh")).toBe(false);
    expect([...db.notes.keys()]).toEqual(["n2"]);
    // A late write for the forgotten notebook must not fall back into the own tree
    expect(() => getNotebookFolder("sh")).toThrow(/ended/);
  });

  it.each([
    ["an unsynced notebook", { id: "sh", synced: false }, []],
    ["stranded notes", { id: "sh", strandedNoteIds: ["n1"] }, []],
    ["an unsynced note", { id: "sh" }, [{ id: "n1", notebookId: "sh", synced: false }]],
  ])("reports unsynced changes for %s", async (_label, record, notes) => {
    for (const n of notes) db.notes.set(n.id, n);
    expect(await createNativeShareStore().hasUnsyncedChanges(record)).toBe(true);
  });

  it("reports none for a clean notebook, ignoring other notebooks' unsynced notes", async () => {
    db.notes.set("n9", { id: "n9", notebookId: "other", synced: false });
    db.notes.set("n1", { id: "n1", notebookId: "sh", synced: true });
    expect(await createNativeShareStore().hasUnsyncedChanges({ id: "sh", synced: true })).toBe(
      false,
    );
  });
});

describe("prepareSharing", () => {
  it("registers a notebook shared with the user", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);

    await prepareSharing();

    expect(db.notebooks.get("nb1")).toMatchObject({
      origin: "shared",
      ownerUid: "alice",
      sharePermissions: 7,
    });
  });

  it("checks the root before anything else, and aborts if it cannot", async () => {
    bob.failEvery({ method: "PROPFIND", pathMatch: "/NoteBerg", status: 500 });
    const ocsCallsBefore = nc.requests.length;

    await expect(prepareSharing()).rejects.toThrow();

    expect(nc.requests.length).toBe(ocsCallsBefore); // discovery never started
  });

  it("moves a foreign /NoteBerg out of the way before discovery", async () => {
    bob.files.delete("/NoteBerg");
    alice.files.set("/Impostor", { isCollection: true, mtime: new Date() });
    bob.addMount({
      shareId: "50",
      path: "/NoteBerg",
      source: alice,
      sourcePath: "/Impostor",
      permissions: 7,
    });

    await prepareSharing();

    expect(bob.files.get("/NoteBerg")?.isCollection).toBe(true);
    expect(bob.mounts.get("50").path).toBe("/Shared_NoteBerg/alice_NoteBerg");
  });
});

describe("how often shares are looked for", () => {
  const sharesListings = () =>
    nc.requests.filter((r) => r.path.endsWith("/shares") && r.query.shared_with_me === "true")
      .length;

  it("looks at most once a minute, but checks the root every time", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    await prepareSharing({ now });
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    const rootChecks = () =>
      bob.requests.filter((r) => r.method === "PROPFIND" && r.path === "/NoteBerg").length;
    const checksBefore = rootChecks();

    clock += SHARE_REFRESH_INTERVAL_MS - 1;
    await prepareSharing({ now });
    expect(db.notebooks.has("nb1")).toBe(false); // not looked for yet
    expect(rootChecks()).toBe(checksBefore + 1);

    clock += 1;
    await prepareSharing({ now });
    expect(db.notebooks.get("nb1")).toMatchObject({ origin: "shared" });
  });

  it("looks at once when forced (a manual sync)", async () => {
    await prepareSharing();
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);

    await prepareSharing({ force: true });

    expect(db.notebooks.get("nb1")).toMatchObject({ origin: "shared" });
  });

  it("does not count a failed look, so the next sync tries again", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    // The sharing API is unreachable; WebDAV (the root guard) still answers
    fetch.mockImplementation((url, options) =>
      url.includes("/ocs/") ? Promise.reject(new Error("offline")) : nc.handleRequest(url, options),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await prepareSharing();
    warn.mockRestore();
    expect(db.notebooks.has("nb1")).toBe(false);
    wireMockNextcloud(fetch, nc);

    await prepareSharing();

    expect(db.notebooks.get("nb1")).toMatchObject({ origin: "shared" });
    expect(sharesListings()).toBe(1);
  });
});

describe("runDiscovery", () => {
  it("never throws: a failing discovery just reports nothing", async () => {
    fetch.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runDiscovery()).toMatchObject({ ok: false });
    warn.mockRestore();
  });
});

describe("what the user can do about a shared notebook", () => {
  beforeEach(async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await prepareSharing();
  });

  it("leaving removes only this user's access and then the local copy", async () => {
    db.notes.set("n1", { id: "n1", notebookId: "nb1", synced: true });

    await leaveSharedNotebook(db.notebooks.get("nb1"));

    expect(db.notebooks.has("nb1")).toBe(false);
    expect(db.notes.size).toBe(0);
    expect(bob.mounts.size).toBe(0);
    expect(alice.files.has("/NoteBerg/notebooks/nb1/_notebook.json")).toBe(true);
  });

  it("dismissing an ended share just forgets it", async () => {
    db.notebooks.set("nb1", { ...db.notebooks.get("nb1"), shareEnded: true });
    await dismissEndedSharedNotebook(db.notebooks.get("nb1"));
    expect(db.notebooks.has("nb1")).toBe(false);
  });

  it("reports unsynced changes so leaving can warn first", async () => {
    expect(await hasUnsyncedChangesInSharedNotebook(db.notebooks.get("nb1"))).toBe(false);
    db.notes.set("n1", { id: "n1", notebookId: "nb1", synced: false });
    expect(await hasUnsyncedChangesInSharedNotebook(db.notebooks.get("nb1"))).toBe(true);
  });

  it("discarding stranded changes makes the notes take the shared version and clears the notice", async () => {
    db.notes.set("n1", { id: "n1", notebookId: "nb1", synced: false, lastSyncedEtag: "old" });
    db.notes.set("n2", { id: "n2", notebookId: "nb1", synced: true, lastSyncedEtag: "keep" });
    db.notebooks.set("nb1", { ...db.notebooks.get("nb1"), strandedNoteIds: ["n1"] });

    await discardStrandedChanges(db.notebooks.get("nb1"));

    // Clean but out of date: the next sync downloads the owner's version over it
    expect(db.notes.get("n1")).toMatchObject({ synced: true, lastSyncedEtag: null });
    expect(db.notes.get("n2")).toMatchObject({ lastSyncedEtag: "keep" });
    expect(db.notebooks.get("nb1").strandedNoteIds).toEqual([]);
  });
});

describe("when a share ends", () => {
  it("tells an open editor", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await prepareSharing();
    const ended = vi.fn();
    window.addEventListener(SHARE_ENDED_EVENT, ended);
    nc.shares.delete("1");
    bob.removeMount("1");

    await runDiscovery();

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0][0].detail).toEqual({ notebookId: "nb1" });
    window.removeEventListener(SHARE_ENDED_EVENT, ended);
  });
});
