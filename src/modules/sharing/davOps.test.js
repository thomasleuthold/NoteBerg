/**
 * src/modules/sharing/davOps.test.js
 * What a WebDAV answer means to the sharing module, decided once for both
 * builds (each supplies only how a request is sent). The distinction that
 * matters most: "not there" (404/403) may end a share, while a failed request
 * must never read as "not there".
 */

import { describe, expect, it, vi } from "vitest";
import { createDavOps, ownerIdOf } from "./davOps.js";

const answer = (status, body = "") => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

const MULTISTATUS = (ownerId) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/files/bob/NoteBerg/</d:href><d:propstat><d:prop>${
    ownerId ? `<oc:owner-id>${ownerId}</oc:owner-id>` : ""
  }</d:prop></d:propstat></d:response></d:multistatus>`;

function opsAnswering(status, body) {
  const request = vi.fn(async () => answer(status, body));
  const mkcol = vi.fn(async () => {});
  return { dav: createDavOps({ request, mkcol }), request, mkcol };
}

describe("ownerOf", () => {
  it("asks for the owner with a Depth: 0 PROPFIND", async () => {
    const { dav, request } = opsAnswering(207, MULTISTATUS("alice"));
    await dav.ownerOf("/NoteBerg");
    const [method, path, init] = request.mock.calls[0];
    expect([method, path]).toEqual(["PROPFIND", "/NoteBerg"]);
    expect(init.headers.Depth).toBe("0");
    expect(init.body).toContain("owner-id");
  });

  it("reports the owner the server names", async () => {
    expect(await opsAnswering(207, MULTISTATUS("alice")).dav.ownerOf("/NoteBerg")).toBe("alice");
  });

  it("says null when the server does not report owners", async () => {
    expect(await opsAnswering(207, MULTISTATUS(null)).dav.ownerOf("/NoteBerg")).toBeNull();
  });

  it("says undefined when there is nothing there", async () => {
    expect(await opsAnswering(404).dav.ownerOf("/NoteBerg")).toBeUndefined();
  });

  it("throws on any other answer: the root then cannot be verified", async () => {
    await expect(opsAnswering(403).dav.ownerOf("/NoteBerg")).rejects.toMatchObject({
      status: 403,
    });
    await expect(opsAnswering(500).dav.ownerOf("/NoteBerg")).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("exists", () => {
  it("is true for a folder that answers", async () => {
    expect(await opsAnswering(207).dav.exists("/Shared_NoteBerg/x")).toBe(true);
  });

  it("is false for a folder that is absent (404) or no longer readable (403)", async () => {
    expect(await opsAnswering(404).dav.exists("/Shared_NoteBerg/x")).toBe(false);
    expect(await opsAnswering(403).dav.exists("/Shared_NoteBerg/x")).toBe(false);
  });

  it("throws when the server fails, which must never read as gone", async () => {
    await expect(opsAnswering(500).dav.exists("/Shared_NoteBerg/x")).rejects.toMatchObject({
      status: 500,
    });
    await expect(opsAnswering(503).dav.exists("/Shared_NoteBerg/x")).rejects.toThrow();
  });
});

describe("move", () => {
  it("never overwrites and names the destination as a path", async () => {
    const { dav, request } = opsAnswering(201);
    await dav.move("/Recipes", "/Shared_NoteBerg/alice_Recipes");
    expect(request).toHaveBeenCalledWith("MOVE", "/Recipes", {
      headers: { Overwrite: "F" },
      destination: "/Shared_NoteBerg/alice_Recipes",
    });
  });

  it("throws with the status when refused", async () => {
    await expect(opsAnswering(412).dav.move("/a", "/b")).rejects.toMatchObject({ status: 412 });
  });
});

describe("readJson", () => {
  it("returns the parsed object", async () => {
    const { dav } = opsAnswering(200, '{"id":"nb1"}');
    expect(await dav.readJson("/x/_notebook.json")).toEqual({ id: "nb1" });
  });

  it("is null when the file is absent, not JSON, or not an object", async () => {
    expect(await opsAnswering(404).dav.readJson("/x")).toBeNull();
    expect(await opsAnswering(200, "<html>").dav.readJson("/x")).toBeNull();
    expect(await opsAnswering(200, '"just a string"').dav.readJson("/x")).toBeNull();
    expect(await opsAnswering(200, "null").dav.readJson("/x")).toBeNull();
  });

  it("throws when the server fails, so a share is not written off as no notebook", async () => {
    await expect(opsAnswering(500).dav.readJson("/x")).rejects.toMatchObject({ status: 500 });
  });
});

describe("mkcol", () => {
  it("is the build's own (an existing folder is fine there)", async () => {
    const { dav, mkcol } = opsAnswering(201);
    await dav.mkcol("/Shared_NoteBerg");
    expect(mkcol).toHaveBeenCalledWith("/Shared_NoteBerg");
  });
});

describe("ownerIdOf", () => {
  it("reads prefixed and unprefixed tags", () => {
    expect(ownerIdOf("<oc:owner-id> alice </oc:owner-id>")).toBe("alice");
    expect(ownerIdOf("<owner-id>bob</owner-id>")).toBe("bob");
    expect(ownerIdOf("<oc:owner-display-name>A</oc:owner-display-name>")).toBeNull();
  });
});
