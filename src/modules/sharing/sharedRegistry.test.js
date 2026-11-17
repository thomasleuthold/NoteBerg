/**
 * src/modules/sharing/sharedRegistry.test.js
 * The Nextcloud app build's in-memory registry: refresh cadence, change
 * notification, and what happens to the path helpers as shares come and go.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../__fixtures__/mockOcsServer.js";
import { createDavOps, dropCredentialsCache } from "../nextcloudSync.js";
import { clearSharedNotebookBases, getNotebookFolder } from "../storagePaths.js";
import * as ocs from "./nextcloudShares.js";
import { SHARE_REFRESH_INTERVAL_MS } from "./refreshInterval.js";
import { createSharedRegistry } from "./sharedRegistry.js";

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
let clock;
let onChange;
let ownNotebooks;
let registry;

const ocsCalls = () => nc.requests.filter((r) => r.path.includes("/shares"));

beforeEach(() => {
  vi.clearAllMocks();
  clearSharedNotebookBases();
  secrets.clear();
  dropCredentialsCache();
  nc = new MockNextcloud();
  nc.addUser("alice", { displayName: "Alice" });
  nc.addUser("bob");
  alice = nc.dav("alice");
  alice.seedNotebook("nb1", { title: "Recipes" });
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

  clock = 1_000_000;
  onChange = vi.fn();
  ownNotebooks = [];
  registry = createSharedRegistry({
    dav: createDavOps(),
    ocs,
    getOwnNotebooks: async () => ownNotebooks,
    onChange,
    now: () => clock,
  });
});

afterEach(() => clearSharedNotebookBases());

describe("refresh", () => {
  it("registers shared notebooks and points the path helpers at their mounts", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);

    const changed = await registry.refresh({ force: true });

    expect(changed).toBe(true);
    expect(registry.isShared("nb1")).toBe(true);
    expect(registry.get("nb1")).toMatchObject({ ownerUid: "alice", sharePermissions: 7 });
    expect(registry.list().map((r) => r.id)).toEqual(["nb1"]);
    expect(getNotebookFolder("nb1")).toBe("/Shared_NoteBerg/nb1");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is limited to once a minute unless forced", async () => {
    await registry.refresh();
    const first = ocsCalls().length;
    expect(first).toBeGreaterThan(0);

    clock += SHARE_REFRESH_INTERVAL_MS - 1;
    await registry.refresh();
    expect(ocsCalls().length).toBe(first);

    clock += 1;
    await registry.refresh();
    expect(ocsCalls().length).toBeGreaterThan(first);

    const afterThird = ocsCalls().length;
    await registry.refresh({ force: true });
    expect(ocsCalls().length).toBeGreaterThan(afterThird);
  });

  it("runs one discovery for concurrent callers", async () => {
    await Promise.all([registry.refresh({ force: true }), registry.refresh({ force: true })]);
    expect(nc.requests.filter((r) => r.path.endsWith("/shares/pending"))).toHaveLength(1);
  });

  it("notifies only when something changed", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });
    onChange.mockClear();

    expect(await registry.refresh({ force: true })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("notices a permission change", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });
    onChange.mockClear();

    nc.shares.get("1").permissions = 1;
    nc.dav("bob").setMountPermissions("1", 1);

    expect(await registry.refresh({ force: true })).toBe(true);
    expect(registry.get("nb1").sharePermissions).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not count a failed listing as a refresh: the next call tries again at once", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signIn = (loginName) => {
      dropCredentialsCache();
      secrets.set(
        "nextcloud_credentials",
        JSON.stringify({
          serverUrl: nc.baseUrl,
          loginName,
          appPassword: "app-password-123",
          userId: loginName,
        }),
      );
    };

    signIn("mallory"); // unknown to the server: the listing fails
    expect(await registry.refresh()).toBe(false);
    expect(registry.list()).toEqual([]);

    signIn("bob"); // same minute, no force
    expect(await registry.refresh()).toBe(true);
    expect(registry.isShared("nb1")).toBe(true);
    warn.mockRestore();
  });

  it("keeps what it knows when a later listing fails", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    secrets.set(
      "nextcloud_credentials",
      JSON.stringify({
        serverUrl: nc.baseUrl,
        loginName: "mallory",
        appPassword: "x",
        userId: "x",
      }),
    );
    nc.shares.delete("1"); // even though the share is gone, a failed listing proves nothing
    await registry.refresh({ force: true });

    expect(registry.isShared("nb1")).toBe(true);
    warn.mockRestore();
  });

  it("forgets a share that ended, and its paths stop resolving", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });

    nc.shares.delete("1");
    nc.dav("bob").removeMount("1");
    await registry.refresh({ force: true });

    expect(registry.isShared("nb1")).toBe(false);
    expect(() => getNotebookFolder("nb1")).toThrow(/ended/);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ignores a share whose id collides with one of the user's own notebooks", async () => {
    ownNotebooks = [{ id: "nb1", title: "Mine" }];
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);

    await registry.refresh({ force: true });

    expect(registry.isShared("nb1")).toBe(false);
    expect(getNotebookFolder("nb1")).toBe("/NoteBerg/notebooks/nb1");
  });
});

describe("annotate", () => {
  beforeEach(async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 3);
    await registry.refresh({ force: true });
  });

  it("gives a notebook file this user's sharing fields", () => {
    const annotated = registry.annotate({ id: "nb1", title: "Recipes", color: "#fff" });
    expect(annotated).toMatchObject({
      id: "nb1",
      title: "Recipes",
      origin: "shared",
      ownerUid: "alice",
      sharePermissions: 3,
      shareEnded: false,
    });
  });

  it("does not trust sharing fields the file itself carries", () => {
    const annotated = registry.annotate({ id: "nb1", origin: "own", sharePermissions: 31 });
    expect(annotated.origin).toBe("shared");
    expect(annotated.sharePermissions).toBe(3);
  });

  it("returns files that are not shared notebooks untouched", () => {
    const own = { id: "mine", title: "Mine" };
    expect(registry.annotate(own)).toBe(own);
  });
});

describe("leave", () => {
  it("removes the user's access on the server, then the registration, and tells the app", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });
    onChange.mockClear();

    await registry.leave("nb1");

    expect(nc.shares.size).toBe(0);
    expect(registry.isShared("nb1")).toBe(false);
    expect(() => getNotebookFolder("nb1")).toThrow(/ended/);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the registration when the server refuses to let go", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });
    nc.shares.clear(); // the share id no longer exists: the server answers 404

    await expect(registry.leave("nb1")).rejects.toThrow();

    expect(registry.isShared("nb1")).toBe(true);
  });

  it("does nothing for an id that is not a registered share", async () => {
    await registry.leave("mine");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("store contract", () => {
  it("never reports unsynced changes: this build keeps nothing locally", async () => {
    expect(await registry.store.hasUnsyncedChanges({ id: "x" })).toBe(false);
  });

  it("lists own notebooks together with the registered shared ones", async () => {
    ownNotebooks = [{ id: "mine" }];
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 7);
    await registry.refresh({ force: true });
    expect((await registry.store.list()).map((r) => r.id).sort()).toEqual(["mine", "nb1"]);
  });
});
