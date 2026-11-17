/**
 * src/modules/sharing/sharedRoots.test.js
 * Finding the notebooks shared with this user, registering them, and noticing
 * when they are gone (DESIGN §7, §8). Real OCS client and real native DAV
 * operations against a mock Nextcloud instance; only the registration store is
 * a plain in-memory object.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../__fixtures__/mockOcsServer.js";
import { createDavOps, dropCredentialsCache } from "../nextcloudSync.js";
import * as ocs from "./nextcloudShares.js";
import {
  discoverShares,
  dismissEndedShare,
  guardOwnRoot,
  leaveShare,
  SHARED_FOLDER,
} from "./sharedRoots.js";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("../encryption.js", () => ({ decryptObject: vi.fn() }));
vi.mock("../storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  initStorage: vi.fn(),
}));

const secrets = new Map();
vi.mock("../secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));

let nc;
let alice;
let bob;
let dav;
let store;

const FOLDER = (id) => `/NoteBerg/notebooks/${id}`;
const WRITES = ["PUT", "MKCOL", "DELETE", "MOVE", "COPY"];
const writesOf = (server) => server.requests.filter((r) => WRITES.includes(r.method));

/** The registration store: notebook records in a Map, as IndexedDB holds them. */
function memoryStore(initial = []) {
  const records = new Map(initial.map((r) => [r.id, r]));
  const calls = { forget: [], update: [], upsert: [] };
  return {
    records,
    calls,
    list: async () => [...records.values()].map((r) => ({ ...r })),
    upsert: async (record) => {
      calls.upsert.push(record.id);
      records.set(record.id, { ...record });
    },
    update: async (id, patch) => {
      calls.update.push(id);
      records.set(id, { ...records.get(id), ...patch });
    },
    forget: async (id) => {
      calls.forget.push(id);
      records.delete(id);
    },
    hasUnsyncedChanges: async (record) =>
      record.synced === false || (record.strandedNoteIds?.length ?? 0) > 0,
  };
}

function signInAs(uid) {
  dropCredentialsCache();
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: nc.baseUrl,
      loginName: uid,
      appPassword: "app-password-123",
      userId: uid,
    }),
  );
}

const discover = (options = {}) => discoverShares({ dav, ocs, store, ...options });

beforeEach(() => {
  vi.clearAllMocks();
  secrets.clear();
  dropCredentialsCache();
  nc = new MockNextcloud();
  nc.addUser("alice", { displayName: "Alice Anderson" });
  nc.addUser("bob", { displayName: "Bob Brown" });
  alice = nc.dav("alice");
  bob = nc.dav("bob");
  wireMockNextcloud(fetch, nc);
  signInAs("bob");
  dav = createDavOps();
  store = memoryStore();
  alice.seedNotebook("nb1", { title: "Recipes", color: "#abc" });
});

describe("registering shares", () => {
  it("registers an auto-accepted notebook share and moves it into the shared folder", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);

    const outcome = await discover();

    expect(outcome).toMatchObject({ ok: true, registered: ["nb1"] });
    expect(store.records.get("nb1")).toMatchObject({
      id: "nb1",
      title: "Recipes",
      color: "#abc",
      origin: "shared",
      ownerUid: "alice",
      ownerDisplayName: "Alice Anderson",
      sharePermissions: 7,
      remoteBasePath: `${SHARED_FOLDER}/nb1`,
      normalized: true,
      shareEnded: false,
      strandedNoteIds: [],
    });
    // The mount really moved, and the notebook is readable at its new place
    expect(bob.mounts.values().next().value.path).toBe(`${SHARED_FOLDER}/nb1`);
    expect(await dav.readJson(`${SHARED_FOLDER}/nb1/_notebook.json`)).toMatchObject({
      id: "nb1",
    });
  });

  it("never accepts a pending share on its own: it is reported for the user to answer", async () => {
    // A server that asks for acceptance: that is the user's decision (invitations.js)
    nc.users.get("bob").autoAccept = false;
    const { id } = await nc.share("alice", FOLDER("nb1"), "bob", 1);

    const outcome = await discover();

    expect(outcome.registered).toEqual([]);
    expect(bob.mounts.size).toBe(0);
    expect(nc.shares.get(id).state).toBe(1); // still pending
    expect(outcome.pending.map((s) => s.id)).toEqual([id]);
    expect(nc.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("registers a pending share once the user accepted it", async () => {
    nc.users.get("bob").autoAccept = false;
    const { id } = await nc.share("alice", FOLDER("nb1"), "bob", 1);
    await ocs.acceptPendingShare(id);

    const outcome = await discover();

    expect(outcome.registered).toEqual(["nb1"]);
    expect(outcome.pending).toEqual([]);
  });

  it("registers the permissions the server granted, not the ones requested", async () => {
    nc.maxPermissions = 1;
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    expect(store.records.get("nb1").sharePermissions).toBe(1);
  });

  it("never moves or registers a folder share that is not a notebook", async () => {
    alice.files.set("/Photos", { isCollection: true, mtime: new Date() });
    await nc.share("alice", "/Photos", "bob", 7);

    const outcome = await discover();

    expect(outcome.registered).toEqual([]);
    expect(store.records.size).toBe(0);
    expect(bob.requests.filter((r) => r.method === "MOVE")).toEqual([]);
    expect([...bob.mounts.values()].map((m) => m.path)).toEqual(["/Photos"]);
  });

  it("does not read an ordinary folder share again once it is known not to be a notebook", async () => {
    alice.files.set("/Photos", { isCollection: true, mtime: new Date() });
    await nc.share("alice", "/Photos", "bob", 7);
    const notNotebooks = new Set();

    await discover({ notNotebooks });
    bob.requests.length = 0;
    await discover({ notNotebooks });

    expect(bob.requests.filter((r) => r.path.endsWith("_notebook.json"))).toEqual([]);
  });

  it("ignores a share whose notebook file has an unsafe id", async () => {
    alice.files.get(`${FOLDER("nb1")}/_notebook.json`).content = JSON.stringify({
      id: "../../etc",
      title: "x",
    });
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    expect((await discover()).registered).toEqual([]);
  });

  it("ignores a share whose id collides with one of the user's own notebooks", async () => {
    store = memoryStore([{ id: "nb1", title: "Mine" }]);
    await nc.share("alice", FOLDER("nb1"), "bob", 7);

    const outcome = await discover();

    expect(outcome.registered).toEqual([]);
    expect(store.records.get("nb1")).toEqual({ id: "nb1", title: "Mine" });
    expect(bob.requests.filter((r) => r.method === "MOVE")).toEqual([]);
  });

  it("ignores a second owner's share of an id that is already registered", async () => {
    nc.addUser("carol");
    nc.dav("carol").seedNotebook("nb1", { title: "Impostor" });
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    await nc.share("carol", FOLDER("nb1"), "bob", 7);

    const outcome = await discover();

    expect(outcome.registered).toEqual([]);
    expect(store.records.get("nb1").ownerUid).toBe("alice");
  });

  it("merges several shares of one folder, combining their permissions", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 1);
    // Nextcloud refuses a second user share of the same folder, but a group share
    // or a re-share can mount the same node again; model that second share directly
    nc.shares.set("99", { ...nc.shares.get("1"), id: "99", permissions: 6 });
    bob.addMount({
      shareId: "99",
      path: "/nb1-second",
      source: alice,
      sourcePath: FOLDER("nb1"),
      permissions: 6,
    });

    await discover();

    expect([...store.records.keys()]).toEqual(["nb1"]);
    expect(store.records.get("nb1").sharePermissions).toBe(7);
  });

  it("keeps a notebook registered when one of its two shares is revoked", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 1);
    nc.shares.set("99", { ...nc.shares.get("1"), id: "99", permissions: 6 });
    bob.addMount({
      shareId: "99",
      path: "/nb1-second",
      source: alice,
      sourcePath: FOLDER("nb1"),
      permissions: 6,
    });
    await discover();
    store.calls.upsert.length = 0;

    // The first share goes; the folder is still mounted through the second
    nc.shares.delete("1");
    const outcome = await discover();

    expect(outcome.registered).toEqual([]);
    expect(store.calls.upsert).toEqual([]);
    expect(store.records.get("nb1")).toMatchObject({ shareId: "99", shareIds: ["99"] });
    expect(store.records.get("nb1").shareEnded).toBeFalsy();
  });

  it("gives a mount name that is already taken a suffix", async () => {
    bob.files.set(SHARED_FOLDER, { isCollection: true, mtime: new Date() });
    bob.files.set(`${SHARED_FOLDER}/nb1`, { isCollection: true, mtime: new Date() });
    await nc.share("alice", FOLDER("nb1"), "bob", 7);

    await discover();

    expect(store.records.get("nb1").remoteBasePath).toBe(`${SHARED_FOLDER}/nb1_2`);
  });

  it("names the folder after the notebook id, whatever the title", async () => {
    // The title is for people; it never becomes part of a path
    alice.files.get(`${FOLDER("nb1")}/_notebook.json`).content = JSON.stringify({
      id: "nb1",
      title: "../Küche: a/b*c? #1 100%",
    });
    await nc.share("alice", FOLDER("nb1"), "bob", 7);

    await discover();

    expect(store.records.get("nb1").remoteBasePath).toBe(`${SHARED_FOLDER}/nb1`);
  });

  it("works with a share wherever its folder is, however that folder is named", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    // The user moved it to a folder whose name would end or garble an unencoded URL
    const odd = "/Ideas #2/100% done? (a&b)";
    bob.files.set("/Ideas #2", { isCollection: true, mtime: new Date() });
    bob.mounts.values().next().value.path = odd;

    await discover();

    expect(store.records.get("nb1").remoteBasePath).toBe(odd);
    expect(await dav.exists(odd)).toBe(true);
    expect(await dav.readJson(`${odd}/_notebook.json`)).toMatchObject({ id: "nb1" });
  });
});

describe("moving the mount out of the way", () => {
  it("leaves a failed move usable through the server's file_target and retries it later", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    bob.failNext({ method: "MOVE", status: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await discover();
    expect(store.records.get("nb1")).toMatchObject({ remoteBasePath: "/nb1", normalized: false });
    expect(await dav.readJson("/nb1/_notebook.json")).toMatchObject({ id: "nb1" });

    await discover(); // the retry succeeds
    expect(store.records.get("nb1")).toMatchObject({
      remoteBasePath: `${SHARED_FOLDER}/nb1`,
      normalized: true,
    });
    warn.mockRestore();
  });

  it("moves a mount only once: a location the user chose afterwards is respected", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    // The user drags it elsewhere in Files
    bob.files.set("/Documents", { isCollection: true, mtime: new Date() });
    bob.mounts.values().next().value.path = "/Documents/Recipes";
    bob.requests.length = 0;

    await discover();

    expect(bob.requests.filter((r) => r.method === "MOVE")).toEqual([]);
    expect(store.records.get("nb1").remoteBasePath).toBe("/Documents/Recipes");
  });

  it("keeps a share that already sits in the shared folder where it is", async () => {
    bob.files.set(SHARED_FOLDER, { isCollection: true, mtime: new Date() });
    nc.shareFolder = SHARED_FOLDER;
    await nc.share("alice", FOLDER("nb1"), "bob", 7);

    await discover();

    expect(bob.requests.filter((r) => r.method === "MOVE")).toEqual([]);
    expect(store.records.get("nb1")).toMatchObject({
      remoteBasePath: `${SHARED_FOLDER}/nb1`,
      normalized: true,
    });
  });
});

describe("refreshing known shares", () => {
  beforeEach(async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    store.calls.update.length = 0;
  });

  it("changes nothing when nothing changed", async () => {
    await discover();
    expect(store.calls.update).toEqual([]);
    expect(store.calls.upsert).toEqual(["nb1"]); // only the first registration
  });

  it("reports a share that can no longer be edited, so an open editor can stop", async () => {
    const onAccessReduced = vi.fn();
    signInAs("alice");
    await ocs.updateSharePermissions("1", 1);
    signInAs("bob");

    const outcome = await discover({ onAccessReduced });

    expect(outcome.reduced).toEqual(["nb1"]);
    expect(onAccessReduced).toHaveBeenCalledWith("nb1");
  });

  it("does not report a change that keeps or grants the right to edit", async () => {
    const onAccessReduced = vi.fn();
    signInAs("alice");
    await ocs.updateSharePermissions("1", 15); // more, not less
    signInAs("bob");

    const outcome = await discover({ onAccessReduced });

    expect(outcome.reduced).toEqual([]);
    expect(onAccessReduced).not.toHaveBeenCalled();
  });

  it("follows a permission change", async () => {
    signInAs("alice");
    await ocs.updateSharePermissions("1", 1);
    signInAs("bob");

    const outcome = await discover();

    expect(outcome.updated).toEqual(["nb1"]);
    expect(store.records.get("nb1").sharePermissions).toBe(1);
  });

  it("follows an owner's display name change and a mount moved by the user", async () => {
    nc.users.get("alice").displayName = "Alice A.";
    bob.files.set("/Documents", { isCollection: true, mtime: new Date() });
    bob.mounts.values().next().value.path = "/Documents/Recipes";

    await discover();

    expect(store.records.get("nb1")).toMatchObject({
      ownerDisplayName: "Alice A.",
      remoteBasePath: "/Documents/Recipes",
    });
  });
});

describe("when the share is gone", () => {
  beforeEach(async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    store.calls.forget.length = 0;
    store.calls.update.length = 0;
  });

  const revoke = () => {
    nc.shares.delete("1");
    bob.removeMount("1");
  };

  it("forgets a clean notebook locally: no remote call and no tombstone", async () => {
    revoke();
    bob.requests.length = 0;

    const outcome = await discover();

    expect(outcome.forgotten).toEqual(["nb1"]);
    expect(store.records.has("nb1")).toBe(false);
    expect(writesOf(bob)).toEqual([]);
    expect(nc.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("freezes a notebook with unsynced changes instead of deleting them", async () => {
    store.records.set("nb1", { ...store.records.get("nb1"), strandedNoteIds: ["n1"] });
    revoke();

    const outcome = await discover();

    expect(outcome.ended).toEqual(["nb1"]);
    expect(store.records.get("nb1")).toMatchObject({ shareEnded: true });
    expect(store.calls.forget).toEqual([]);
  });

  it("tells the caller which shares ended, so an open editor can stop accepting changes", async () => {
    const onShareEnded = vi.fn();
    store.records.set("nb1", { ...store.records.get("nb1"), strandedNoteIds: ["n1"] });
    revoke();

    await discover({ onShareEnded });

    expect(onShareEnded).toHaveBeenCalledWith("nb1");
  });

  it("also tells the caller when a clean notebook is forgotten", async () => {
    const onShareEnded = vi.fn();
    revoke();
    await discover({ onShareEnded });
    expect(onShareEnded).toHaveBeenCalledWith("nb1");
  });

  it("does not claim a share ended while it is only a lagging listing", async () => {
    const onShareEnded = vi.fn();
    nc.shares.delete("1");
    await discover({ onShareEnded });
    expect(onShareEnded).not.toHaveBeenCalled();
  });

  it("keeps a notebook the listing no longer mentions while its folder is still readable", async () => {
    // Server lag: the share list dropped it but the mount is still there
    nc.shares.delete("1");

    const outcome = await discover();

    expect(outcome.forgotten).toEqual([]);
    expect(outcome.ended).toEqual([]);
    expect(store.records.has("nb1")).toBe(true);
  });

  it("follows the mount when the folder moved but the share is still listed", async () => {
    bob.files.set("/Elsewhere", { isCollection: true, mtime: new Date() });
    bob.mounts.values().next().value.path = "/Elsewhere/Recipes";

    const outcome = await discover();

    expect(outcome.forgotten).toEqual([]);
    expect(store.records.get("nb1").remoteBasePath).toBe("/Elsewhere/Recipes");
  });

  it("forgets nothing when the OCS listing fails", async () => {
    revoke();
    nc.v1Errors = true;
    signInAs("mallory"); // every OCS call now fails with a failing envelope
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await discover();

    expect(outcome.ok).toBe(false);
    expect(store.records.has("nb1")).toBe(true);
    expect(store.calls.forget).toEqual([]);
    warn.mockRestore();
  });

  it("forgets nothing when the server cannot be reached", async () => {
    revoke();
    fetch.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await discover();

    expect(outcome.ok).toBe(false);
    expect(store.records.has("nb1")).toBe(true);
    warn.mockRestore();
  });

  it("re-attaches a frozen notebook when the same notebook is shared again", async () => {
    store.records.set("nb1", {
      ...store.records.get("nb1"),
      strandedNoteIds: ["n1"],
      shareEnded: true,
      shareId: "1",
    });
    revoke();

    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    const outcome = await discover();

    expect(outcome.updated).toEqual(["nb1"]);
    const record = store.records.get("nb1");
    expect(record.shareEnded).toBe(false);
    expect(record.shareId).toBe("2");
    expect(record.strandedNoteIds).toEqual(["n1"]); // what it held is kept
    expect(store.calls.upsert).toEqual(["nb1"]); // no second registration
  });

  it("leaves a frozen notebook alone while its share is still gone", async () => {
    store.records.set("nb1", { ...store.records.get("nb1"), shareEnded: true });
    revoke();
    const outcome = await discover();
    expect(outcome.ended).toEqual([]);
    expect(outcome.forgotten).toEqual([]);
    expect(store.records.get("nb1").shareEnded).toBe(true);
  });

  it("counts a folder the server no longer lets the user read (403) as gone", async () => {
    const base = store.records.get("nb1").remoteBasePath;
    nc.shares.delete("1"); // gone from the listing…
    bob.failEvery({ method: "PROPFIND", pathMatch: base, status: 403 }); // …and unreadable

    const outcome = await discover();

    expect(outcome.forgotten).toEqual(["nb1"]);
  });

  it("keeps a notebook whose folder cannot be checked, without holding up the others", async () => {
    alice.seedNotebook("nb2", { title: "Travel" });
    await nc.share("alice", FOLDER("nb2"), "bob", 7);
    await discover();
    const base1 = store.records.get("nb1").remoteBasePath;
    // Both drop out of the listing; nb1's folder cannot be checked, nb2's is gone
    nc.shares.clear();
    bob.removeMount("2");
    bob.failEvery({ method: "PROPFIND", pathMatch: base1, status: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await discover();

    warn.mockRestore();
    expect(store.records.has("nb1")).toBe(true); // no answer is not "gone"
    expect(outcome.forgotten).toEqual(["nb2"]);
  });

  it("re-attaches a live notebook the owner re-shared before this device noticed, keeping its local state", async () => {
    // A rename not uploaded yet, and a note whose change could not be saved
    store.records.set("nb1", {
      ...store.records.get("nb1"),
      title: "Recipes (mine)",
      synced: false,
      lastSyncedEtag: "etag-known",
      strandedNoteIds: ["n1"],
    });
    revoke();
    await nc.share("alice", FOLDER("nb1"), "bob", 7); // a new share id

    const outcome = await discover();

    expect(outcome.updated).toEqual(["nb1"]);
    expect(store.records.get("nb1")).toMatchObject({
      shareId: "2",
      shareEnded: false,
      title: "Recipes (mine)",
      synced: false,
      lastSyncedEtag: "etag-known",
      strandedNoteIds: ["n1"],
    });
    expect(store.calls.upsert).toEqual(["nb1"]); // no second registration over it
    expect(store.calls.forget).toEqual([]);
  });
});

describe("leaving a share", () => {
  it("removes only this user's access on the server, then the local copy", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();

    await leaveShare({ ocs, store, notebook: store.records.get("nb1") });

    expect(store.records.has("nb1")).toBe(false);
    expect(bob.mounts.size).toBe(0);
    // alice's notebook itself is untouched
    expect(alice.files.has(`${FOLDER("nb1")}/_notebook.json`)).toBe(true);
  });

  it("leaves every share mounting the folder, so it does not come back", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 1);
    // A second share of the same folder (as a group share would be)
    nc.shares.set("99", { ...nc.shares.get("1"), id: "99", permissions: 6 });
    bob.addMount({
      shareId: "99",
      path: "/nb1-second",
      source: alice,
      sourcePath: FOLDER("nb1"),
      permissions: 6,
    });
    await discover();

    await leaveShare({ ocs, store, notebook: store.records.get("nb1") });
    const outcome = await discover();

    expect(outcome.registered).toEqual([]);
    expect(store.records.has("nb1")).toBe(false);
  });

  it("does not ask the server about a share that already ended", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    nc.requests.length = 0;

    await leaveShare({
      ocs,
      store,
      notebook: { ...store.records.get("nb1"), shareEnded: true },
    });

    expect(nc.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(store.records.has("nb1")).toBe(false);
  });

  it("keeps the local copy when the server refuses to let go", async () => {
    await nc.share("alice", FOLDER("nb1"), "bob", 7);
    await discover();
    nc.shares.delete("1"); // already gone on the server: DELETE answers 404

    await expect(
      leaveShare({ ocs, store, notebook: store.records.get("nb1") }),
    ).rejects.toBeInstanceOf(ocs.OcsError);
    expect(store.records.has("nb1")).toBe(true);
  });

  it("dismissing an ended share just forgets it", async () => {
    store = memoryStore([{ id: "nb1", origin: "shared", shareEnded: true }]);
    await dismissEndedShare({ store, notebook: store.records.get("nb1") });
    expect(store.records.size).toBe(0);
  });
});

describe("guardOwnRoot", () => {
  it("does nothing when /NoteBerg does not exist yet", async () => {
    bob.files.delete("/NoteBerg");
    expect(await guardOwnRoot({ dav, uid: "bob", ocs })).toEqual({ moved: false });
    expect(writesOf(bob)).toEqual([]);
  });

  it("does nothing when /NoteBerg is the user's own", async () => {
    expect(await guardOwnRoot({ dav, uid: "bob", ocs })).toEqual({ moved: false });
    expect(writesOf(bob)).toEqual([]);
  });

  it("recognises the user's own folder whatever case the server reports the uid in", async () => {
    expect(await guardOwnRoot({ dav, uid: "BOB", ocs })).toEqual({ moved: false });
  });

  describe("a folder shared to the user was mounted at /NoteBerg", () => {
    beforeEach(() => {
      bob.files.delete("/NoteBerg");
      alice.files.set("/Impostor", { isCollection: true, mtime: new Date() });
      alice.files.set("/Impostor/marker.txt", { content: "alice's", etag: "m", mtime: new Date() });
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
    });

    it("moves it out and creates a fresh own root, writing nothing into the share", async () => {
      const result = await guardOwnRoot({ dav, uid: "bob", ocs });

      expect(result).toEqual({ moved: true, to: `${SHARED_FOLDER}/alice_NoteBerg` });
      expect(bob.files.get("/NoteBerg")?.isCollection).toBe(true);
      expect(bob.mounts.get("50").path).toBe(`${SHARED_FOLDER}/alice_NoteBerg`);
      // Not a single write reached alice's folder: only the move of the mount itself
      expect(alice.requests.filter((r) => WRITES.includes(r.method))).toEqual([]);
      expect(alice.files.has("/Impostor/NoteBerg")).toBe(false);
    });

    it("uses the next free name when the target already exists", async () => {
      bob.files.set(SHARED_FOLDER, { isCollection: true, mtime: new Date() });
      bob.files.set(`${SHARED_FOLDER}/alice_NoteBerg`, { isCollection: true, mtime: new Date() });
      const result = await guardOwnRoot({ dav, uid: "bob", ocs });
      expect(result.to).toBe(`${SHARED_FOLDER}/alice_NoteBerg_2`);
    });

    it("falls back to the share list when the server reports no owners", async () => {
      alice.reportOwnerId = false;
      bob.reportOwnerId = false;
      const result = await guardOwnRoot({ dav, uid: "bob", ocs });
      expect(result.moved).toBe(true);
    });

    it("leaves a root alone when the server reports no owners and no share points at it", async () => {
      bob.removeMount("50");
      bob.files.set("/NoteBerg", { isCollection: true, mtime: new Date(), etag: "own" });
      bob.reportOwnerId = false;
      expect(await guardOwnRoot({ dav, uid: "bob", ocs })).toEqual({ moved: false });
    });

    it("fails loudly if the move is refused, so the sync does not write into the share", async () => {
      bob.failNext({ method: "MOVE", status: 403 });
      await expect(guardOwnRoot({ dav, uid: "bob", ocs })).rejects.toThrow();
    });

    it("trusts the share list as evidence even when the user ID is only a guess", async () => {
      alice.reportOwnerId = false;
      bob.reportOwnerId = false;
      const result = await guardOwnRoot({ dav, uid: "bob", uidConfirmed: false, ocs });
      expect(result.moved).toBe(true);
    });
  });

  // When the server cannot be asked for the user ID, the login name stands in
  // for it. It is usually right; when it is not, the user's own root would look
  // like someone else's, and moving it would take all their notes out of place.
  describe("with a user ID that is only a guess", () => {
    it("stops instead of moving a root whose owner differs from the guess", async () => {
      // bob's own root, but the guess is the login name "bob@example.com"
      await expect(
        guardOwnRoot({ dav, uid: "bob@example.com", uidConfirmed: false, ocs }),
      ).rejects.toThrow(/could not be confirmed/);

      expect(writesOf(bob)).toEqual([]);
      expect(bob.files.get("/NoteBerg")?.isCollection).toBe(true);
    });

    it("goes ahead when the guess matches the owner", async () => {
      expect(await guardOwnRoot({ dav, uid: "bob", uidConfirmed: false, ocs })).toEqual({
        moved: false,
      });
    });
  });
});
