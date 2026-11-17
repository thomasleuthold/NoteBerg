/**
 * src/modules/sharing/ownerShares.test.js
 * The owner's view of who a notebook is shared with: one request for all
 * notebooks, kept for the session, never mistaken for "unshared" after a failure.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../__fixtures__/mockOcsServer.js";
import { dropCredentialsCache } from "../nextcloudSync.js"; // also registers the native transport
import { SHARING_PREF_KEY } from "./enabled.js";
import {
  ensureOwnerShares,
  getOwnerShares,
  getRecipientCount,
  notebookIdOf,
  recordOwnerShares,
  refreshOwnerShares,
  resetOwnerShares,
} from "./ownerShares.js";

vi.mock("./config.js", () => ({ SHARING_ENABLED: true }));
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
let changed;
const listings = () => nc.requests.filter((r) => r.query?.subfiles === "true");

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem(SHARING_PREF_KEY, "true");
  resetOwnerShares();
  secrets.clear();
  dropCredentialsCache();
  nc = new MockNextcloud();
  for (const uid of ["alice", "bob", "carol"]) nc.addUser(uid);
  nc.dav("alice").seedNotebook("nb1");
  nc.dav("alice").seedNotebook("nb2");
  nc.dav("alice").seedNotebook("nb3");
  wireMockNextcloud(fetch, nc);
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: nc.baseUrl,
      loginName: "alice",
      appPassword: "app-password-123",
      userId: "alice",
    }),
  );
  changed = vi.fn();
  window.addEventListener("datachange", changed);
});

describe("notebookIdOf", () => {
  it("takes the segment directly under the notebooks folder", () => {
    expect(notebookIdOf({ path: "/NoteBerg/notebooks/nb1" })).toBe("nb1");
    expect(notebookIdOf({ path: "/NoteBerg/notebooks/nb1/notes/n1.json" })).toBe("nb1");
  });

  it("ignores a share outside the notebooks folder", () => {
    expect(notebookIdOf({ path: "/Documents/notebooks/nb1" })).toBeUndefined();
    expect(notebookIdOf({ path: "/NoteBerg/notebooks" })).toBeUndefined();
    expect(notebookIdOf({})).toBeUndefined();
  });
});

describe("refreshOwnerShares", () => {
  it("reads every notebook's shares with one request", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 1);
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "carol", 7);
    await nc.share("alice", "/NoteBerg/notebooks/nb2", "bob", 7);

    await refreshOwnerShares();

    expect(listings()).toHaveLength(1);
    expect(getRecipientCount("nb1")).toBe(2);
    expect(getRecipientCount("nb2")).toBe(1);
    expect(getRecipientCount("nb3")).toBe(0);
    expect(
      getOwnerShares("nb1")
        .map((s) => s.shareWith)
        .sort(),
    ).toEqual(["bob", "carol"]);
  });

  it("tells the app when something changed, and only then", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 1);
    expect(await refreshOwnerShares()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);

    expect(await refreshOwnerShares()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("notices a permission change and a revoked share", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 1);
    await refreshOwnerShares();

    nc.shares.get("1").permissions = 7;
    expect(await refreshOwnerShares()).toBe(true);
    expect(getOwnerShares("nb1")[0].permissions).toBe(7);

    nc.shares.delete("1");
    expect(await refreshOwnerShares()).toBe(true);
    expect(getRecipientCount("nb1")).toBe(0);
  });

  it("keeps what it knew when the read fails: a hiccup is not 'unshared'", async () => {
    await nc.share("alice", "/NoteBerg/notebooks/nb1", "bob", 1);
    await refreshOwnerShares();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await refreshOwnerShares()).toBe(false);

    expect(getRecipientCount("nb1")).toBe(1);
    warn.mockRestore();
  });

  it("runs once for concurrent callers", async () => {
    await Promise.all([refreshOwnerShares(), refreshOwnerShares(), refreshOwnerShares()]);
    expect(listings()).toHaveLength(1);
  });

  it("does nothing while sharing is switched off", async () => {
    localStorage.setItem(SHARING_PREF_KEY, "false");
    expect(await refreshOwnerShares()).toBe(false);
    expect(listings()).toHaveLength(0);
    expect(getOwnerShares("nb1")).toEqual([]);
  });

  it("does nothing while the app is not connected to Nextcloud", async () => {
    secrets.clear();
    expect(await refreshOwnerShares()).toBe(false);
    expect(listings()).toHaveLength(0);
  });
});

describe("ensureOwnerShares", () => {
  it("reads once per session", async () => {
    await ensureOwnerShares();
    await ensureOwnerShares();
    expect(listings()).toHaveLength(1);
  });

  it("tries again after a failed first read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetch.mockRejectedValueOnce(new Error("offline"));
    await ensureOwnerShares();
    await ensureOwnerShares();
    expect(listings()).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("recordOwnerShares", () => {
  it("takes over what the share dialog saw and announces the change", () => {
    recordOwnerShares("nb1", [{ id: "9", permissions: 1, shareWith: "bob" }]);
    expect(getRecipientCount("nb1")).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);

    recordOwnerShares("nb1", []);
    expect(getRecipientCount("nb1")).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when nothing changed", () => {
    const shares = [{ id: "9", permissions: 1, shareWith: "bob" }];
    recordOwnerShares("nb1", shares);
    changed.mockClear();
    recordOwnerShares("nb1", shares);
    expect(changed).not.toHaveBeenCalled();
  });
});
