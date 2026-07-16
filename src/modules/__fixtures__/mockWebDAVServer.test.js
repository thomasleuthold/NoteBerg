/**
 * src/modules/__fixtures__/mockWebDAVServer.test.js
 * Self-tests for the shared WebDAV mock fixture's hardened behaviors —
 * fault injection, deterministic etags, request logging, locks, quota.
 */

import { describe, expect, it } from "vitest";
import { MockWebDAVServer } from "./mockWebDAVServer.js";

const AUTH = { headers: { Authorization: "Basic dGVzdA==" } };

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
      headers: { Authorization: "Basic dGVzdA==", Depth: "infinity" },
    });
    expect(res.status).toBe(400);

    const depth1 = await server.handleRequest(`${server.baseUrl}${server.rootPath}/`, {
      ...AUTH,
      method: "PROPFIND",
      headers: { Authorization: "Basic dGVzdA==", Depth: "1" },
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
        headers: { Authorization: "Basic dGVzdA==", Depth: "infinity" },
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
