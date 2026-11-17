/**
 * src/modules/sharing/nextcloudShares.test.js
 * The OCS sharing client on the native build: Basic auth through the Tauri HTTP
 * client, against a mock Nextcloud instance that models pending vs accepted
 * shares, permission reduction by policy and OCS-level failures.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../__fixtures__/mockOcsServer.js";
import { dropCredentialsCache } from "../nextcloudSync.js"; // also registers the native transport
import {
  acceptPendingShare,
  createShare,
  deleteShare,
  listPendingShares,
  listSharedWithMe,
  listSharesForPath,
  listSharesInFolder,
  OcsError,
  searchSharees,
  updateSharePermissions,
} from "./nextcloudShares.js";

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

/** Sign the client in as `uid` (app password). */
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

beforeEach(() => {
  vi.clearAllMocks();
  secrets.clear();
  dropCredentialsCache();
  nc = new MockNextcloud();
  nc.addUser("alice", { displayName: "Alice Anderson" });
  nc.addUser("bob", { displayName: "Bob Brown" });
  nc.addUser("carol", { displayName: "Carol Clark" });
  nc.dav("alice").seedNotebook("nb1", { title: "Recipes" });
  wireMockNextcloud(fetch, nc);
  signInAs("alice");
});

const FOLDER = "/NoteBerg/notebooks/nb1";

describe("authentication and request shape", () => {
  it("authenticates with Basic auth and the OCS header, asking for JSON", async () => {
    await listSharedWithMe();

    const request = nc.requests.at(-1);
    expect(request.user).toBe("alice");
    expect(request.headers.Authorization).toMatch(/^Basic /);
    expect(request.headers["OCS-APIRequest"]).toBe("true");
    expect(request.headers.Accept).toBe("application/json");
    expect(request.query.format).toBe("json");
  });

  it("fails clearly when the account is not signed in", async () => {
    secrets.clear();
    await expect(listSharedWithMe()).rejects.toThrow(/Not authenticated/);
  });

  it("rejects credentials the server does not know", async () => {
    signInAs("mallory");
    await expect(listSharedWithMe()).rejects.toMatchObject({ name: "OcsError", status: 401 });
  });
});

describe("searchSharees", () => {
  it("returns users matching the query, exact match first, never the searching user", async () => {
    nc.addUser("alice2", { displayName: "Another Alice" });

    const found = await searchSharees("alice");

    expect(found.map((u) => u.uid)).toEqual(["alice2"]);
  });

  it("also drops self defensively when the server includes it", async () => {
    nc.includeSelfInSharees = true;
    const found = await searchSharees("alice");
    expect(found.map((u) => u.uid)).not.toContain("alice");
  });

  it("matches by display name and returns it as the label", async () => {
    expect(await searchSharees("brown")).toEqual([{ uid: "bob", displayName: "Bob Brown" }]);
  });

  it("puts an exact uid match before partial matches and drops duplicates", async () => {
    nc.addUser("bobby", { displayName: "Bobby" });
    const found = await searchSharees("bob");
    expect(found.map((u) => u.uid)).toEqual(["bob", "bobby"]);
  });

  it("does not ask the server for an empty query", async () => {
    expect(await searchSharees("   ")).toEqual([]);
    expect(nc.requests.filter((r) => r.path.endsWith("/sharees"))).toHaveLength(0);
  });

  it("asks for folder shares with a bounded page", async () => {
    await searchSharees("bob");
    const request = nc.requests.find((r) => r.path.endsWith("/sharees"));
    expect(request.query).toMatchObject({
      search: "bob",
      itemType: "folder",
      lookup: "false",
      perPage: "20",
    });
  });
});

describe("createShare", () => {
  it("creates a user share with the requested permissions", async () => {
    const share = await createShare(FOLDER, "bob", 7);

    expect(share).toMatchObject({
      shareType: 0,
      permissions: 7,
      shareWith: "bob",
      ownerUid: "alice",
      itemType: "folder",
      state: 0,
    });
    const request = nc.requests.at(-1);
    expect(request.method).toBe("POST");
    expect(request.form).toEqual({
      path: FOLDER,
      shareType: "0",
      shareWith: "bob",
      permissions: "7",
    });
  });

  it("reports granted, not requested, permissions when policy reduces them", async () => {
    nc.maxPermissions = 1; // admin forces read-only
    const share = await createShare(FOLDER, "bob", 7);
    expect(share.permissions).toBe(1);
  });

  it("fails for a missing folder, an unknown user, yourself and a duplicate", async () => {
    await expect(createShare("/NoteBerg/notebooks/nope", "bob", 1)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(createShare(FOLDER, "nobody", 1)).rejects.toMatchObject({ statusCode: 404 });
    await expect(createShare(FOLDER, "alice", 1)).rejects.toMatchObject({ statusCode: 403 });
    await createShare(FOLDER, "bob", 1);
    await expect(createShare(FOLDER, "bob", 1)).rejects.toThrow(/already shared/);
  });
});

describe("listSharesForPath", () => {
  it("lists only this user's shares of that folder", async () => {
    await createShare(FOLDER, "bob", 1);
    await createShare(FOLDER, "carol", 7);
    nc.dav("alice").seedNotebook("nb2");
    await createShare("/NoteBerg/notebooks/nb2", "bob", 1);

    const shares = await listSharesForPath(FOLDER);

    expect(shares.map((s) => s.shareWith).sort()).toEqual(["bob", "carol"]);
    expect(nc.requests.at(-1).query).toMatchObject({ path: FOLDER, reshares: "false" });
  });

  it("is empty for a folder that is not shared", async () => {
    expect(await listSharesForPath(FOLDER)).toEqual([]);
  });
});

describe("listSharesInFolder", () => {
  it("returns the shares of every child in one request", async () => {
    nc.dav("alice").seedNotebook("nb2");
    await createShare(FOLDER, "bob", 1);
    await createShare("/NoteBerg/notebooks/nb2", "carol", 7);
    const before = nc.requests.length;

    const shares = await listSharesInFolder("/NoteBerg/notebooks");

    expect(nc.requests.length - before).toBe(1);
    expect(nc.requests.at(-1).query).toMatchObject({ subfiles: "true", reshares: "false" });
    expect(shares.map((s) => [s.path, s.shareWith]).sort()).toEqual([
      [FOLDER, "bob"],
      ["/NoteBerg/notebooks/nb2", "carol"],
    ]);
  });

  it("is empty when nothing in the folder is shared, and ignores deeper levels", async () => {
    expect(await listSharesInFolder("/NoteBerg/notebooks")).toEqual([]);
    nc.dav("alice").files.set(`${FOLDER}/notes`, { isCollection: true, mtime: new Date() });
    await createShare(`${FOLDER}/notes`, "bob", 1);
    expect(await listSharesInFolder("/NoteBerg/notebooks")).toEqual([]);
  });
});

describe("recipient side: shared with me, pending, accept", () => {
  it("lists an accepted share with its mount target, owner and granted permissions", async () => {
    await createShare(FOLDER, "bob", 7);
    signInAs("bob");

    const shares = await listSharedWithMe();

    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      ownerUid: "alice",
      ownerDisplayName: "Alice Anderson",
      permissions: 7,
      itemType: "folder",
      shareType: 0,
      fileTarget: "/nb1",
      state: 0,
    });
    expect(typeof shares[0].id).toBe("string");
  });

  it("keeps a pending share out of shared_with_me until it is accepted", async () => {
    nc.users.get("bob").autoAccept = false;
    const created = await createShare(FOLDER, "bob", 7);
    signInAs("bob");

    expect(await listSharedWithMe()).toEqual([]);
    const pending = await listPendingShares();
    expect(pending.map((s) => s.id)).toEqual([created.id]);
    expect(pending[0].state).toBe(1);
    expect(nc.dav("bob").mounts.size).toBe(0);

    await acceptPendingShare(created.id);

    expect((await listSharedWithMe()).map((s) => s.id)).toEqual([created.id]);
    expect(await listPendingShares()).toEqual([]);
    expect(nc.dav("bob").mounts.size).toBe(1);
  });

  it("does not let one user accept another's pending share", async () => {
    nc.users.get("bob").autoAccept = false;
    const created = await createShare(FOLDER, "bob", 7);
    signInAs("carol");
    await expect(acceptPendingShare(created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("gives colliding mount names a suffix", async () => {
    nc.dav("bob").seedNotebook("nb1"); // bob already has a /nb1 elsewhere in his tree
    nc.dav("bob").files.set("/nb1", { isCollection: true, mtime: new Date() });
    await createShare(FOLDER, "bob", 1);
    signInAs("bob");
    expect((await listSharedWithMe())[0].fileTarget).toBe("/nb1 (2)");
  });
});

describe("updateSharePermissions and deleteShare", () => {
  it("lets the owner change permissions, bounded by policy", async () => {
    const created = await createShare(FOLDER, "bob", 1);
    expect((await updateSharePermissions(created.id, 7)).permissions).toBe(7);

    nc.maxPermissions = 3;
    expect((await updateSharePermissions(created.id, 7)).permissions).toBe(3);
    expect(nc.requests.at(-1).form).toEqual({ permissions: "7" });
  });

  it("does not let the recipient change permissions", async () => {
    const created = await createShare(FOLDER, "bob", 1);
    signInAs("bob");
    await expect(updateSharePermissions(created.id, 31)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets the owner revoke", async () => {
    const created = await createShare(FOLDER, "bob", 1);
    await deleteShare(created.id);
    expect(await listSharesForPath(FOLDER)).toEqual([]);
    expect(nc.dav("bob").mounts.size).toBe(0);
  });

  it("lets the recipient leave, which ends the share for everyone", async () => {
    const created = await createShare(FOLDER, "bob", 1);
    signInAs("bob");

    await deleteShare(created.id);

    expect(await listSharedWithMe()).toEqual([]);
    signInAs("alice");
    expect(await listSharesForPath(FOLDER)).toEqual([]);
  });

  it("fails for a share the user is not part of", async () => {
    const created = await createShare(FOLDER, "bob", 1);
    signInAs("carol");
    await expect(deleteShare(created.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("OCS failures", () => {
  it("surfaces an HTTP error with its OCS message", async () => {
    const error = await createShare(FOLDER, "nobody", 1).catch((e) => e);
    expect(error).toBeInstanceOf(OcsError);
    expect(error.message).toBe("Wrong share recipient");
    expect(error.status).toBe(404);
    expect(error.statusCode).toBe(404);
  });

  it("detects a failure the server reports with HTTP 200 (OCS v1 style)", async () => {
    nc.v1Errors = true;
    const error = await createShare(FOLDER, "nobody", 1).catch((e) => e);
    expect(error).toBeInstanceOf(OcsError);
    expect(error.status).toBe(200);
    expect(error.statusCode).toBe(404);
  });

  it("never mistakes a failed listing for an empty one", async () => {
    nc.v1Errors = true;
    signInAs("mallory"); // unauthenticated -> 401 in the envelope, HTTP 200
    await expect(listSharedWithMe()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a response that is not an OCS envelope", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(listSharedWithMe()).rejects.toBeInstanceOf(OcsError);
  });

  it("rejects an envelope-less JSON body", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ hello: "world" }) });
    await expect(listPendingShares()).rejects.toBeInstanceOf(OcsError);
  });

  it("propagates a network failure", async () => {
    fetch.mockRejectedValueOnce(new Error("connection refused"));
    await expect(listSharedWithMe()).rejects.toThrow("connection refused");
  });
});
