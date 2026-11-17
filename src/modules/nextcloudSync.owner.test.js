/**
 * src/modules/nextcloudSync.owner.test.js
 * With sharing on, the own pass asks who owns each item and leaves alone
 * anything below /NoteBerg that belongs to someone else (a share the user
 * moved into the app's folder). Sharing is switched on for this file only.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "./__fixtures__/mockOcsServer.js";
import { downloadAllData, dropCredentialsCache } from "./nextcloudSync.js";
import { SHARING_EVER_KEY, SHARING_PREF_KEY } from "./sharing/enabled.js";

vi.mock("./sharing/config.js", () => ({ SHARING_ENABLED: true }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("./encryption.js", () => ({ decryptObject: vi.fn() }));
vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  initStorage: vi.fn(),
  getRawNote: vi.fn(async () => null),
}));

const secrets = new Map();
vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));

let nc;
let alice;
let bob;

beforeEach(() => {
  vi.clearAllMocks();
  dropCredentialsCache();
  localStorage.setItem(SHARING_PREF_KEY, "true");
  secrets.clear();
  nc = new MockNextcloud();
  nc.addUser("alice");
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

  bob.seedNotebook("mine", { title: "Mine" });
  bob.seedNote("mine", { id: "n-mine", notebookId: "mine", content: "x", modified: 1 });
  bob.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
  bob.files.set("/NoteBerg/quickNotes", { isCollection: true, mtime: new Date() });

  // A notebook alice shared, which bob dragged into his /NoteBerg/notebooks folder
  alice.seedNotebook("theirs", { title: "Theirs" });
  alice.seedNote("theirs", { id: "n-theirs", notebookId: "theirs", content: "y", modified: 1 });
  bob.addMount({
    shareId: "7",
    path: "/NoteBerg/notebooks/theirs",
    source: alice,
    sourcePath: "/NoteBerg/notebooks/theirs",
    permissions: 7,
  });
});

// Sharing is a preview, off until chosen. Off, the sync requests are what they
// were before sharing existed: no owner lookup, nothing filtered.
describe("the own pass with sharing switched off", () => {
  beforeEach(() => {
    localStorage.setItem(SHARING_PREF_KEY, "false");
    localStorage.removeItem(SHARING_EVER_KEY);
  });

  it("does not ask the server for owners", async () => {
    await downloadAllData([], []);

    const propfind = bob.requests.find((r) => r.method === "PROPFIND");
    expect(propfind.body ?? "").not.toContain("owner-id");
    expect(propfind.headers["Content-Type"]).not.toBe("application/xml");
  });

  it("reads the tree as it is, mounts included", async () => {
    const result = await downloadAllData([], []);
    expect(result.notebooks.map((n) => n.id).sort()).toEqual(["mine", "theirs"]);
  });

  // The mount of a share accepted while sharing was on stays in /NoteBerg after
  // it is switched off; read as the user's own, its notes would be synced (and
  // deleted) as theirs.
  it("still keeps a share accepted earlier out of the own tree", async () => {
    localStorage.setItem(SHARING_EVER_KEY, "true");

    const result = await downloadAllData([], []);

    expect(result.notebooks.map((n) => n.id)).toEqual(["mine"]);
    expect(result.notes.map((n) => n.id)).toEqual(["n-mine"]);
  });
});

describe("the own pass with sharing on", () => {
  it.each([
    ["Depth: infinity", () => {}],
    ["the per-folder fallback", () => bob.rejectDepthInfinity()],
  ])("reads only what belongs to the user (%s)", async (_label, setup) => {
    setup();

    const result = await downloadAllData([], []);

    expect(result.notebooks.map((n) => n.id)).toEqual(["mine"]);
    expect(result.notes.map((n) => n.id)).toEqual(["n-mine"]);
  });

  it("asks the server for each item's owner", async () => {
    await downloadAllData([], []);

    const propfind = bob.requests.find((r) => r.method === "PROPFIND");
    expect(propfind.headers["Content-Type"]).toBe("application/xml");
    expect(propfind.body).toContain("owner-id");
  });

  it("keeps items when the server does not report owners", async () => {
    bob.reportOwnerId = false;
    const result = await downloadAllData([], []);
    expect(result.notebooks.map((n) => n.id)).toContain("mine");
  });

  it("recognises the user's own items whatever case the owner is reported in", async () => {
    bob.reportedOwnerId = "BOB";
    const result = await downloadAllData([], []);
    expect(result.notebooks.map((n) => n.id)).toEqual(["mine"]);
    expect(result.notes.map((n) => n.id)).toEqual(["n-mine"]);
  });
});

// When the server cannot be asked for the user ID, the login name stands in for
// it. A guess may be wrong, and a wrong one would declare the user's whole tree
// someone else's: only a confirmed ID decides what is foreign.
describe("a user ID that is only a guess", () => {
  beforeEach(() => {
    secrets.set(
      "nextcloud_credentials",
      JSON.stringify({ serverUrl: nc.baseUrl, loginName: "bob", appPassword: "app-password-123" }),
    );
    // The user ID lookup fails; WebDAV still answers under the login name
    fetch.mockImplementation((url, options) =>
      url.includes("/cloud/user")
        ? Promise.resolve({ ok: false, status: 503, statusText: "Unavailable" })
        : nc.handleRequest(url, options || {}),
    );
  });

  it("is reported as unconfirmed", async () => {
    const { getCurrentUserIdentity } = await import("./nextcloudSync.js");
    expect(await getCurrentUserIdentity()).toEqual({ uid: "bob", confirmed: false });
  });

  it("declares nothing foreign", async () => {
    const result = await downloadAllData([], []);
    expect(result.notebooks.map((n) => n.id).sort()).toEqual(["mine", "theirs"]);
  });
});

describe("a confirmed user ID", () => {
  it("is reported as confirmed", async () => {
    const { getCurrentUserIdentity } = await import("./nextcloudSync.js");
    expect(await getCurrentUserIdentity()).toEqual({ uid: "bob", confirmed: true });
  });
});
