/**
 * src/modules/__fixtures__/mockWebDAVServer.test.js
 * Self-tests for the shared WebDAV mock fixture's hardened behaviors —
 * fault injection, deterministic etags, request logging, locks, quota.
 */

import { describe, expect, it } from "vitest";
import { MockWebDAVServer } from "./mockWebDAVServer.js";

// Basic auth for the default "testuser" login.
const BASIC = `Basic ${btoa("testuser:app-password-123")}`;
const AUTH = { headers: { Authorization: BASIC } };

describe("MockWebDAVServer fixture", () => {
  it("generates deterministic, monotonic etags instead of random ones", async () => {
    const server = new MockWebDAVServer();
    server.files.set("/NoteBerg/a.json", { isCollection: true, mtime: new Date() });
    await server.handleRequest(`${server.baseUrl}${server.rootPath}/a.json`, {
      ...AUTH,
      method: "PUT",
      body: "1",
    });
    await server.handleRequest(`${server.baseUrl}${server.rootPath}/b.json`, {
      ...AUTH,
      method: "PUT",
      body: "2",
    });
    expect(server.files.get("/a.json").etag).toBe("etag-seed-1");
    expect(server.files.get("/b.json").etag).toBe("etag-seed-2");
  });

  it("logs every request so tests can assert request counts", async () => {
    const server = new MockWebDAVServer();
    await server.handleRequest(`${server.baseUrl}${server.rootPath}/`, {
      ...AUTH,
      method: "PROPFIND",
    });
    await server.handleRequest(`${server.baseUrl}${server.rootPath}/`, {
      ...AUTH,
      method: "PROPFIND",
    });
    expect(server.requests.filter((r) => r.method === "PROPFIND")).toHaveLength(2);
  });

  it("failNext fails only the next matching request, then reverts to normal behavior", async () => {
    const server = new MockWebDAVServer();
    server.failNext({ method: "PUT", pathMatch: "/x.json", status: 503, retryAfter: 5 });

    const failed = await server.handleRequest(`${server.baseUrl}${server.rootPath}/x.json`, {
      ...AUTH,
      method: "PUT",
      body: "1",
    });
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Retry-After")).toBe("5");

    const succeeded = await server.handleRequest(`${server.baseUrl}${server.rootPath}/x.json`, {
      ...AUTH,
      method: "PUT",
      body: "1",
    });
    expect(succeeded.ok).toBe(true);
  });

  it("failEvery keeps failing until cleared", async () => {
    const server = new MockWebDAVServer();
    server.failEvery({ method: "GET", pathMatch: "/y.json", status: 500 });
    server.files.set("/y.json", { content: "data", etag: "e1", mtime: new Date() });

    const r1 = await server.handleRequest(`${server.baseUrl}${server.rootPath}/y.json`, {
      ...AUTH,
      method: "GET",
    });
    const r2 = await server.handleRequest(`${server.baseUrl}${server.rootPath}/y.json`, {
      ...AUTH,
      method: "GET",
    });
    expect(r1.status).toBe(500);
    expect(r2.status).toBe(500);

    server.clearFaults();
    const r3 = await server.handleRequest(`${server.baseUrl}${server.rootPath}/y.json`, {
      ...AUTH,
      method: "GET",
    });
    expect(r3.ok).toBe(true);
  });

  it("simulates a network throw instead of an HTTP error response", async () => {
    const server = new MockWebDAVServer();
    server.failNext({ method: "GET", pathMatch: "/z.json", throws: "simulated network failure" });
    server.files.set("/z.json", { content: "data", etag: "e1", mtime: new Date() });

    await expect(
      server.handleRequest(`${server.baseUrl}${server.rootPath}/z.json`, {
        ...AUTH,
        method: "GET",
      }),
    ).rejects.toThrow("simulated network failure");
  });

  it("returns 423 Locked on PUT to a locked path", async () => {
    const server = new MockWebDAVServer();
    server.files.set("/locked.json", { content: "data", etag: "e1", mtime: new Date() });
    server.lock("/locked.json");

    const res = await server.handleRequest(`${server.baseUrl}${server.rootPath}/locked.json`, {
      ...AUTH,
      method: "PUT",
      body: "new",
    });
    expect(res.status).toBe(423);

    server.unlock("/locked.json");
    const res2 = await server.handleRequest(`${server.baseUrl}${server.rootPath}/locked.json`, {
      ...AUTH,
      method: "PUT",
      body: "new",
    });
    expect(res2.ok).toBe(true);
  });

  it("returns 507 Insufficient Storage when quota is exceeded", async () => {
    const server = new MockWebDAVServer();
    server.setQuotaExceeded(true);
    const res = await server.handleRequest(`${server.baseUrl}${server.rootPath}/full.json`, {
      ...AUTH,
      method: "PUT",
      body: "data",
    });
    expect(res.status).toBe(507);
  });

  it("rejects Depth: infinity PROPFIND with 400 when configured", async () => {
    const server = new MockWebDAVServer();
    server.rejectDepthInfinity(true);
    const res = await server.handleRequest(`${server.baseUrl}${server.rootPath}/`, {
      ...AUTH,
      method: "PROPFIND",
      headers: { Authorization: BASIC, Depth: "infinity" },
    });
    expect(res.status).toBe(400);

    const depth1 = await server.handleRequest(`${server.baseUrl}${server.rootPath}/`, {
      ...AUTH,
      method: "PROPFIND",
      headers: { Authorization: BASIC, Depth: "1" },
    });
    expect(depth1.status).toBe(207);
  });

  it("returns 409 Conflict on a PUT whose parent collection does not exist (real WebDAV)", async () => {
    const server = new MockWebDAVServer();
    // /NoteBerg exists (seeded by constructor) but /NoteBerg/notebooks/nb1/notes does not.
    const res = await server.handleRequest(
      `${server.baseUrl}${server.rootPath}/NoteBerg/notebooks/nb1/notes/orphan.json`,
      { ...AUTH, method: "PUT", body: "{}" },
    );
    expect(res.status).toBe(409);
    // The orphaned PUT must NOT silently create the file or resurrect its parents.
    expect(server.files.has("/NoteBerg/notebooks/nb1/notes/orphan.json")).toBe(false);
    expect(server.files.has("/NoteBerg/notebooks/nb1")).toBe(false);
  });

  it("allows a PUT once the parent collection chain exists", async () => {
    const server = new MockWebDAVServer();
    server.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
    server.files.set("/NoteBerg/notebooks/nb1/notes", { isCollection: true, mtime: new Date() });
    const res = await server.handleRequest(
      `${server.baseUrl}${server.rootPath}/NoteBerg/notebooks/nb1/notes/n1.json`,
      { ...AUTH, method: "PUT", body: "{}" },
    );
    expect(res.ok).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb1/notes/n1.json")).toBe(true);
  });

  it("PROPFIND scopes to the collection's own subtree, not prefix-siblings", async () => {
    const server = new MockWebDAVServer();
    server.files.set("/NoteBerg/notebooks/nb1", { isCollection: true, mtime: new Date() });
    server.files.set("/NoteBerg/notebooks/nb1/notes", { isCollection: true, mtime: new Date() });
    server.files.set("/NoteBerg/notebooks/nb1/notes/a.json", {
      content: "{}",
      etag: "e",
      mtime: new Date(),
    });
    // Prefix-sibling: "nb10" starts with "nb1" as a raw string but is a different notebook.
    server.files.set("/NoteBerg/notebooks/nb10", { isCollection: true, mtime: new Date() });
    server.files.set("/NoteBerg/notebooks/nb10/notes/b.json", {
      content: "{}",
      etag: "e",
      mtime: new Date(),
    });

    const res = await server.handleRequest(
      `${server.baseUrl}${server.rootPath}/NoteBerg/notebooks/nb1`,
      {
        ...AUTH,
        method: "PROPFIND",
        headers: { Authorization: BASIC, Depth: "infinity" },
      },
    );
    const xml = await res.text();
    const hrefs = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) =>
      decodeURIComponent(m[1]),
    );
    // nb1's own subtree is present…
    expect(hrefs.some((h) => h.endsWith("/nb1/notes/a.json"))).toBe(true);
    // …but nb10's subtree must NOT leak in.
    expect(hrefs.some((h) => h.includes("/nb10"))).toBe(false);
  });

  describe("account: login name vs user ID (LDAP/AD, email login)", () => {
    const ldap = () =>
      new MockWebDAVServer({
        loginName: "alice@example.com",
        userId: "5b3c1d2e-0f4a-4b7c-9d8e-1a2b3c4d5e6f",
      });
    const auth = (user) => ({ Authorization: `Basic ${btoa(`${user}:pw`)}` });

    it("roots DAV paths at the user ID, not the login name", () => {
      expect(ldap().rootPath).toBe("/remote.php/dav/files/5b3c1d2e-0f4a-4b7c-9d8e-1a2b3c4d5e6f");
    });

    it("rejects requests whose Basic auth names neither the login name nor the user ID", async () => {
      const server = ldap();
      const res = await server.handleRequest(`${server.baseUrl}${server.rootPath}/`, {
        method: "PROPFIND",
        headers: auth("mallory"),
      });
      expect(res.status).toBe(401);
    });

    it("answers MKCOL under the login-name root with 409 and PROPFIND with 404", async () => {
      const server = ldap();
      const wrongRoot = `${server.baseUrl}/remote.php/dav/files/${encodeURIComponent("alice@example.com")}`;
      const mkcol = await server.handleRequest(`${wrongRoot}/NoteBerg/notebooks`, {
        method: "MKCOL",
        headers: auth("alice@example.com"),
      });
      expect(mkcol.status).toBe(409);
      expect(server.files.has("/NoteBerg/notebooks")).toBe(false);

      const propfind = await server.handleRequest(`${wrongRoot}/NoteBerg`, {
        method: "PROPFIND",
        headers: auth("alice@example.com"),
      });
      expect(propfind.status).toBe(404);
    });

    it("accepts the login name for auth on the user-ID root", async () => {
      const server = ldap();
      const res = await server.handleRequest(`${server.baseUrl}${server.rootPath}/NoteBerg/x`, {
        method: "MKCOL",
        headers: auth("alice@example.com"),
      });
      expect(res.status).toBe(201);
    });

    it("rejects a chunked-upload MOVE whose Destination names the wrong principal", async () => {
      const server = ldap();
      const uploads = `${server.baseUrl}/remote.php/dav/uploads/5b3c1d2e-0f4a-4b7c-9d8e-1a2b3c4d5e6f/s1`;
      await server.handleRequest(uploads, { method: "MKCOL", headers: auth("alice@example.com") });
      const res = await server.handleRequest(`${uploads}/.file`, {
        method: "MOVE",
        headers: {
          ...auth("alice@example.com"),
          Destination: `${server.baseUrl}/remote.php/dav/files/alice%40example.com/NoteBerg/f.bin`,
        },
      });
      expect(res.status).toBe(409);
    });

    it("serves the user ID from the OCS user endpoint", async () => {
      const server = ldap();
      const res = await server.handleRequest(
        `${server.baseUrl}/ocs/v2.php/cloud/user?format=json`,
        { method: "GET", headers: auth("alice@example.com") },
      );
      expect(res.ok).toBe(true);
      expect((await res.json()).ocs.data.id).toBe("5b3c1d2e-0f4a-4b7c-9d8e-1a2b3c4d5e6f");
    });
  });

  describe("seed DSL", () => {
    it("seedNotebook creates the notebook folder, notes folder, and _notebook.json", () => {
      const server = new MockWebDAVServer();
      server.seedNotebook("nb1", { title: "My Notebook" });
      expect(server.files.has("/NoteBerg/notebooks/nb1")).toBe(true);
      expect(server.files.has("/NoteBerg/notebooks/nb1/notes")).toBe(true);
      const nb = JSON.parse(server.files.get("/NoteBerg/notebooks/nb1/_notebook.json").content);
      expect(nb.title).toBe("My Notebook");
    });

    it("seedNote places notes under the notebook and seedQuickNote under quickNotes", () => {
      const server = new MockWebDAVServer();
      server.seedNote("nb1", { id: "n1", content: "hi" });
      server.seedQuickNote({ id: "qn1", content: "quick" });
      expect(server.files.has("/NoteBerg/notebooks/nb1/notes/n1.json")).toBe(true);
      expect(server.files.has("/NoteBerg/quickNotes/qn1.json")).toBe(true);
    });

    it("seedTombstone and seedMedia populate the expected paths", () => {
      const server = new MockWebDAVServer();
      server.seedTombstone("nb1", { notes: [{ id: "n1" }], notebooks: [], media: [] });
      server.seedMedia("nb1", "n1", "file-1");
      expect(server.files.has("/NoteBerg/notebooks/nb1/_tombstones.json")).toBe(true);
      expect(server.files.has("/NoteBerg/notebooks/nb1/notes/n1_media/file-1.bin")).toBe(true);
    });
  });
});

describe("MockWebDAVServer shares (mounts)", () => {
  const auth = (server) => ({ Authorization: server._basicAuthFor() });
  const url = (server, path) => `${server.baseUrl}${server.rootPath}${path}`;

  function setup(permissions) {
    const alice = new MockWebDAVServer({ loginName: "alice" });
    const bob = new MockWebDAVServer({ loginName: "bob" });
    alice.seedNotebook("nb1", { title: "Recipes" });
    alice.seedNote("nb1", { id: "n1", content: "hello" });
    bob.addMount({
      shareId: 1,
      path: "/nb1",
      source: alice,
      sourcePath: "/NoteBerg/notebooks/nb1",
      permissions,
    });
    return { alice, bob };
  }
  const request = (server, method, path, extra = {}) =>
    server.handleRequest(url(server, path), { method, headers: auth(server), ...extra });

  it("serves reads from the owner's tree under the recipient's path", async () => {
    const { bob } = setup(1);
    const res = await request(bob, "GET", "/nb1/notes/n1.json");
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).content).toBe("hello");
  });

  it("rewrites PROPFIND hrefs into the recipient's namespace and names the owner", async () => {
    const { bob } = setup(1);
    const res = await request(bob, "PROPFIND", "/nb1/notes", {
      headers: { ...auth(bob), Depth: "1" },
    });
    const xml = await res.text();
    expect(xml).toContain(`${bob.rootPath}/nb1/notes/n1.json`);
    expect(xml).not.toContain("/remote.php/dav/files/alice");
    expect(xml).toContain("<oc:owner-id>alice</oc:owner-id>");
  });

  it("lists a mount among the children of the folder it sits in", async () => {
    const { bob } = setup(1);
    bob.files.set("/Docs", { isCollection: true, mtime: new Date() });
    bob.mounts.get("1").path = "/Docs/nb1";
    const xml = await (
      await request(bob, "PROPFIND", "/Docs", { headers: { ...auth(bob), Depth: "1" } })
    ).text();
    expect(xml).toContain(`${bob.rootPath}/Docs/nb1`);
    expect(xml).toContain("<oc:owner-id>alice</oc:owner-id>");
  });

  it("names the user as owner of their own files", async () => {
    const bob = new MockWebDAVServer({ loginName: "bob" });
    const xml = await (
      await request(bob, "PROPFIND", "/NoteBerg", { headers: { ...auth(bob), Depth: "0" } })
    ).text();
    expect(xml).toContain("<oc:owner-id>bob</oc:owner-id>");
  });

  it.each([
    ["read-only cannot PUT a new file", 1, "PUT", "/nb1/notes/new.json", 403],
    ["read-only cannot overwrite", 1, "PUT", "/nb1/notes/n1.json", 403],
    ["read-only cannot MKCOL", 1, "MKCOL", "/nb1/notes/n9_media", 403],
    ["UPDATE alone cannot create", 2, "PUT", "/nb1/notes/new.json", 403],
    ["CREATE alone cannot overwrite", 4, "PUT", "/nb1/notes/n1.json", 403],
    ["collab can create", 7, "PUT", "/nb1/notes/new.json", 201],
    ["collab can overwrite", 7, "PUT", "/nb1/notes/n1.json", 204],
    ["collab can MKCOL", 7, "MKCOL", "/nb1/notes/n9_media", 201],
    ["collab cannot DELETE", 7, "DELETE", "/nb1/notes/n1.json", 403],
    ["DELETE bit allows DELETE", 15, "DELETE", "/nb1/notes/n1.json", 204],
  ])("%s", async (_label, permissions, method, path, status) => {
    const { alice, bob } = setup(permissions);
    const res = await request(bob, method, path, { body: "{}" });
    expect(res.status).toBe(status);
    if (status === 403) {
      expect(alice.files.get(path.replace("/nb1", "/NoteBerg/notebooks/nb1"))?.content).not.toBe(
        "{}",
      );
    }
  });

  it("writes through a permitted request land in the owner's tree", async () => {
    const { alice, bob } = setup(7);
    await request(bob, "PUT", "/nb1/notes/new.json", { body: '{"id":"new"}' });
    expect(alice.files.get("/NoteBerg/notebooks/nb1/notes/new.json").content).toBe('{"id":"new"}');
    expect(bob.files.has("/nb1/notes/new.json")).toBe(false);
  });

  it("moving the mount root changes where the share appears, not the owner's tree", async () => {
    const { alice, bob } = setup(7);
    bob.files.set("/Shared_NoteBerg", { isCollection: true, mtime: new Date() });
    const res = await request(bob, "MOVE", "/nb1", {
      headers: { ...auth(bob), Destination: url(bob, "/Shared_NoteBerg/alice_nb1") },
    });
    expect(res.status).toBe(201);
    expect((await request(bob, "GET", "/Shared_NoteBerg/alice_nb1/notes/n1.json")).status).toBe(
      200,
    );
    expect((await request(bob, "GET", "/nb1/notes/n1.json")).status).toBe(404);
    expect(alice.files.has("/NoteBerg/notebooks/nb1/notes/n1.json")).toBe(true);
  });

  it("refuses to move the mount into a folder that does not exist", async () => {
    const { bob } = setup(7);
    const res = await request(bob, "MOVE", "/nb1", {
      headers: { ...auth(bob), Destination: url(bob, "/Nowhere/nb1") },
    });
    expect(res.status).toBe(409);
  });

  it("will not move a file out of the share", async () => {
    const { bob } = setup(15);
    const res = await request(bob, "MOVE", "/nb1/notes/n1.json", {
      headers: { ...auth(bob), Destination: url(bob, "/stolen.json") },
    });
    expect(res.status).toBe(403);
  });

  it("answers 404 for the mount path once the share is removed", async () => {
    const { bob } = setup(7);
    bob.removeMount(1);
    expect(
      (await request(bob, "PROPFIND", "/nb1", { headers: { ...auth(bob), Depth: "0" } })).status,
    ).toBe(404);
  });

  it("checks chunked-upload assembly into a share against its permissions", async () => {
    const { alice, bob } = setup(1);
    bob.files.set("/__uploads__/s1", { isCollection: true, mtime: new Date() });
    bob.files.set("/__uploads__/s1/1", { content: "AB", etag: "c1", mtime: new Date() });
    const res = await bob.handleRequest(`${bob.baseUrl}/remote.php/dav/uploads/bob/s1/.file`, {
      method: "MOVE",
      headers: { ...auth(bob), Destination: url(bob, "/nb1/notes/big.bin") },
    });
    expect(res.status).toBe(403);
    expect(alice.files.has("/NoteBerg/notebooks/nb1/notes/big.bin")).toBe(false);

    bob.setMountPermissions(1, 7);
    const ok = await bob.handleRequest(`${bob.baseUrl}/remote.php/dav/uploads/bob/s1/.file`, {
      method: "MOVE",
      headers: { ...auth(bob), Destination: url(bob, "/nb1/notes/big.bin") },
    });
    expect(ok.status).toBe(201);
    expect(alice.files.get("/NoteBerg/notebooks/nb1/notes/big.bin").content).toBe("AB");
  });
});
