/**
 * src/modules/sharing/nextcloudShares.nextcloud.test.js
 * The OCS client on the Nextcloud app build (run by `npm run test:nextcloud`):
 * same-origin requests authenticated by the session cookie and the page's
 * request token, never by an app password.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud } from "../__fixtures__/mockOcsServer.js";
import { createShare, listSharedWithMe, OcsError, searchSharees } from "./nextcloudShares.js";

let nc;
let calls;

beforeEach(() => {
  nc = new MockNextcloud({ webroot: "/nextcloud" });
  nc.addUser("alice", { displayName: "Alice Anderson" });
  nc.addUser("bob", { displayName: "Bob Brown" });
  nc.dav("alice").seedNotebook("nb1");
  nc.sessionUser = "alice";

  calls = [];
  vi.stubGlobal("fetch", (url, options) => {
    calls.push({ url, options });
    return nc.handleRequest(url, options);
  });
  window.OC = {
    webroot: "/nextcloud",
    requestToken: "token-123",
    currentUser: "alice",
    getCurrentUser: () => ({ uid: "alice" }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.OC;
});

describe("Nextcloud app build transport", () => {
  it("is selected by the build, not by credentials", () => {
    expect(import.meta.env.VITE_PLATFORM).toBe("nextcloud");
  });

  it("sends same-origin requests with the request token and no Authorization header", async () => {
    await listSharedWithMe();

    const { url, options } = calls[0];
    expect(url.startsWith("/nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares?")).toBe(true);
    expect(options.credentials).toBe("same-origin");
    expect(options.headers.requesttoken).toBe("token-123");
    expect(options.headers["OCS-APIRequest"]).toBe("true");
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("works end to end against the instance as the signed-in session user", async () => {
    const share = await createShare("/NoteBerg/notebooks/nb1", "bob", 7);
    expect(share).toMatchObject({ ownerUid: "alice", shareWith: "bob", permissions: 7 });
    expect(nc.requests.at(-1).user).toBe("alice");
  });

  it("excludes the signed-in user from sharee results using the page's user id", async () => {
    nc.addUser("alina");
    nc.includeSelfInSharees = true;
    const found = await searchSharees("al");
    expect(found.map((u) => u.uid)).toEqual(["alina"]);
  });

  it("rejects when the session is gone", async () => {
    nc.sessionUser = null;
    await expect(listSharedWithMe()).rejects.toBeInstanceOf(OcsError);
  });

  it("falls back to OC.getCurrentUser() when currentUser is not set", async () => {
    window.OC.currentUser = undefined;
    nc.addUser("alina");
    nc.includeSelfInSharees = true;
    const found = await searchSharees("al");
    expect(found.map((u) => u.uid)).toEqual(["alina"]);
  });
});
