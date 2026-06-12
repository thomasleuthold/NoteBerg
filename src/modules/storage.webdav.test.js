/**
 * src/modules/storage.webdav.test.js
 * Unit tests for the Nextcloud-app WebDAV storage backend, focused on the
 * multi-step server operations that must not lose data:
 *   - moveNote  (write-before-delete, server-side MOVE of media, tombstone)
 *   - copyNote  (server-side COPY of media binaries)
 *   - tombstone read-modify-write (If-Match concurrency, corruption guard)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock WebDAV server (browser-fetch flavoured) ──────────────────────────────

function makeHeaders(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function plainResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(),
    text: async () => "",
  };
}

class MockDavServer {
  constructor() {
    this.base = "/remote.php/dav/files/testuser";
    this.files = new Map(); // path -> { isCollection, content, etag }
    this._etagCounter = 0;
  }

  _etag() {
    return `etag-${++this._etagCounter}`;
  }

  seed(path, entry = {}) {
    this.files.set(path, { etag: this._etag(), ...entry });
  }

  seedFolder(path) {
    this.seed(path, { isCollection: true });
  }

  seedJson(path, obj) {
    this.seed(path, { isCollection: false, content: JSON.stringify(obj) });
  }

  _norm(url) {
    const p = url.startsWith(this.base) ? url.slice(this.base.length) : url;
    return decodeURIComponent(p || "/");
  }

  handle(url, options = {}) {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const path = this._norm(url);
    const existing = this.files.get(path);

    if (method === "GET") {
      if (!existing || existing.isCollection) return plainResponse(404);
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({ etag: `"${existing.etag}"` }),
        json: async () => JSON.parse(existing.content),
        text: async () => existing.content,
        blob: async () => new Blob([existing.content]),
      };
    }

    if (method === "PUT") {
      if (headers["If-Match"] && (!existing || `"${existing.etag}"` !== headers["If-Match"])) {
        return plainResponse(412);
      }
      if (headers["If-None-Match"] === "*" && existing) {
        return plainResponse(412);
      }
      const etag = this._etag();
      this.files.set(path, { isCollection: false, content: options.body, etag });
      return {
        ok: true,
        status: existing ? 204 : 201,
        headers: makeHeaders({ etag: `"${etag}"` }),
        text: async () => "",
      };
    }

    if (method === "DELETE") {
      if (!existing) return plainResponse(404);
      for (const key of [...this.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
      }
      return plainResponse(204);
    }

    if (method === "MKCOL") {
      if (existing) return plainResponse(405);
      this.seedFolder(path);
      return plainResponse(201);
    }

    if (method === "MOVE" || method === "COPY") {
      if (!existing) return plainResponse(404);
      const dest = this._norm(headers.Destination);
      for (const [key, value] of [...this.files.entries()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          this.files.set(dest + key.slice(path.length), { ...value, etag: this._etag() });
          if (method === "MOVE") this.files.delete(key);
        }
      }
      return plainResponse(201);
    }

    if (method === "PROPFIND") {
      if (!existing) return plainResponse(404);
      const depth = headers.Depth || "1";
      // Unprefixed XML — parsed via DOMParser + querySelectorAll in davList
      let xml = `<?xml version="1.0"?><multistatus>`;
      const addItem = (p, f) => {
        const href = this.base + p + (f.isCollection ? "/" : "");
        const type = f.isCollection ? "<collection/>" : "";
        xml += `<response><href>${href}</href><propstat><prop><resourcetype>${type}</resourcetype><getetag>"${f.etag}"</getetag></prop></propstat></response>`;
      };
      addItem(path, existing);
      if (existing.isCollection && depth !== "0") {
        for (const [key, value] of this.files.entries()) {
          const isDirectChild =
            key !== path && key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/");
          if (isDirectChild) addItem(key, value);
        }
      }
      xml += "</multistatus>";
      return { ok: true, status: 207, text: async () => xml };
    }

    return plainResponse(501);
  }
}

// ── Test setup ────────────────────────────────────────────────────────────────

let server;
let storage;
let fetchImpl; // tests may wrap this to inject failures / concurrent writers

function seedBaseStructure() {
  server.seedFolder("/NoteBerg");
  server.seedFolder("/NoteBerg/notebooks");
  server.seedFolder("/NoteBerg/quickNotes");
  for (const nb of ["nb-a", "nb-b"]) {
    server.seedFolder(`/NoteBerg/notebooks/${nb}`);
    server.seedFolder(`/NoteBerg/notebooks/${nb}/notes`);
    server.seedJson(`/NoteBerg/notebooks/${nb}/_notebook.json`, {
      id: nb,
      title: nb,
      modified: 1000,
      deleted: false,
    });
  }
}

function seedNoteWithMedia() {
  server.seedJson("/NoteBerg/notebooks/nb-a/notes/n1.json", {
    id: "n1",
    notebookId: "nb-a",
    title: "Note 1",
    media: [{ id: "m1", fileId: "f1", type: "image" }],
    modified: 1000,
    version: 1,
  });
  server.seedFolder("/NoteBerg/notebooks/nb-a/notes/n1_media");
  server.seed("/NoteBerg/notebooks/nb-a/notes/n1_media/f1.png", {
    isCollection: false,
    content: "PNG-DATA",
  });
}

beforeEach(async () => {
  server = new MockDavServer();
  seedBaseStructure();
  fetchImpl = (url, options) => Promise.resolve(server.handle(url, options));
  vi.stubGlobal("fetch", (url, options) => fetchImpl(url, options));
  window.OC = { currentUser: "testuser", requestToken: "test-token" };
  localStorage.clear();

  // Fresh module per test — the backend keeps module-level caches
  vi.resetModules();
  storage = await import("./storage.webdav.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.OC;
});

// ── moveNote ──────────────────────────────────────────────────────────────────

describe("moveNote (WebDAV)", () => {
  it("moves the note JSON and its media folder, and tombstones the old location", async () => {
    seedNoteWithMedia();

    await storage.moveNote("n1", "nb-b");

    // New location: JSON with updated notebookId
    const newJson = server.files.get("/NoteBerg/notebooks/nb-b/notes/n1.json");
    expect(newJson).toBeDefined();
    expect(JSON.parse(newJson.content).notebookId).toBe("nb-b");

    // Media moved server-side
    expect(server.files.has("/NoteBerg/notebooks/nb-b/notes/n1_media/f1.png")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/f1.png")).toBe(false);

    // Old JSON removed
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(false);

    // Old location tombstoned so native clients don't resurrect the note there
    const tombstone = JSON.parse(
      server.files.get("/NoteBerg/notebooks/nb-a/_tombstones.json").content,
    );
    expect(tombstone.notes.some((t) => t.id === "n1")).toBe(true);
  });

  it("does not delete the original when the write to the new location fails", async () => {
    seedNoteWithMedia();

    // Fail the PUT of the note JSON at the new location
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/nb-b/notes/n1.json")) {
        return Promise.resolve(plainResponse(500));
      }
      return base(url, options);
    };

    await expect(storage.moveNote("n1", "nb-b")).rejects.toThrow();

    // Old copy must be fully intact — JSON and media
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/f1.png")).toBe(true);
  });

  it("moves a note to quick notes", async () => {
    seedNoteWithMedia();

    await storage.moveNote("n1", null);

    expect(server.files.has("/NoteBerg/quickNotes/n1.json")).toBe(true);
    expect(server.files.has("/NoteBerg/quickNotes/n1_media/f1.png")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(false);
  });
});

// ── copyNote ──────────────────────────────────────────────────────────────────

describe("copyNote (WebDAV)", () => {
  it("copies media binaries into the copy's own folder", async () => {
    seedNoteWithMedia();

    const copy = await storage.copyNote("n1", "nb-b");

    // Copy JSON exists in target notebook
    const copyJson = server.files.get(`/NoteBerg/notebooks/nb-b/notes/${copy.id}.json`);
    expect(copyJson).toBeDefined();
    expect(JSON.parse(copyJson.content).notebookId).toBe("nb-b");

    // Media binary copied into the copy's folder — not shared with the original
    expect(server.files.has(`/NoteBerg/notebooks/nb-b/notes/${copy.id}_media/f1.png`)).toBe(true);

    // Original untouched
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/f1.png")).toBe(true);
  });

  it("copy survives permanent deletion of the original", async () => {
    seedNoteWithMedia();

    const copy = await storage.copyNote("n1", "nb-b");
    await storage.permanentlyDeleteNote("n1");

    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/f1.png")).toBe(false);
    expect(server.files.has(`/NoteBerg/notebooks/nb-b/notes/${copy.id}_media/f1.png`)).toBe(true);
  });
});

// ── cleanupNoteMedia ──────────────────────────────────────────────────────────

describe("cleanupNoteMedia (WebDAV)", () => {
  beforeEach(() => {
    // Two media binaries on the server; the note will only reference one of them.
    server.seedFolder("/NoteBerg/notebooks/nb-a/notes/n1_media");
    server.seed("/NoteBerg/notebooks/nb-a/notes/n1_media/keep.png", {
      isCollection: false,
      content: "KEEP",
    });
    server.seed("/NoteBerg/notebooks/nb-a/notes/n1_media/orphan.png", {
      isCollection: false,
      content: "ORPHAN",
    });
  });

  it("deletes server binaries no longer referenced by the note", async () => {
    await storage.cleanupNoteMedia("n1", "nb-a", ["keep"]);

    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/keep.png")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/orphan.png")).toBe(false);
  });

  it("keeps every referenced file and tolerates a missing folder", async () => {
    await storage.cleanupNoteMedia("n1", "nb-a", ["keep", "orphan"]);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/keep.png")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/orphan.png")).toBe(true);

    // No media folder for this note — must not throw
    await expect(storage.cleanupNoteMedia("n-none", null, [])).resolves.toBeUndefined();
  });
});

// ── Delete semantics ──────────────────────────────────────────────────────────

describe("delete semantics (WebDAV)", () => {
  it("soft deleteNote sets the deleted flag but writes NO tombstone", async () => {
    // To native clients a tombstone means "permanently purged — hard-delete your
    // local copy". A recycle-bin delete must propagate via the deleted flag only.
    seedNoteWithMedia();

    await storage.deleteNote("n1");

    const json = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(json.deleted).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/_tombstones.json")).toBe(false);
  });

  it("permanentlyDeleteNote removes files and writes the tombstone", async () => {
    seedNoteWithMedia();

    await storage.permanentlyDeleteNote("n1");

    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(false);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/f1.png")).toBe(false);
    const tombstone = JSON.parse(
      server.files.get("/NoteBerg/notebooks/nb-a/_tombstones.json").content,
    );
    expect(tombstone.notes.some((t) => t.id === "n1")).toBe(true);
  });
});

// ── Write queue serialization ─────────────────────────────────────────────────

describe("per-note write queue (WebDAV)", () => {
  it("serializes deleteNote behind an in-flight updateNote (no resurrection)", async () => {
    seedNoteWithMedia();

    // Slow down the update's PUT so an unqueued delete would interleave:
    // delete would read+write the pre-update note, then the update's PUT would
    // land last and resurrect the note with deleted missing.
    const base = fetchImpl;
    let delayed = false;
    fetchImpl = async (url, options) => {
      if (!delayed && options?.method === "PUT" && url.includes("/notes/n1.json")) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return base(url, options);
    };

    const updatePromise = storage.updateNote("n1", { title: "Updated title" });
    const deletePromise = storage.deleteNote("n1");
    await Promise.all([updatePromise, deletePromise]);

    const json = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(json.deleted).toBe(true); // delete must win (ran last)
    expect(json.title).toBe("Updated title"); // update was not lost either
  });
});

// ── Read cache ────────────────────────────────────────────────────────────────

describe("read cache (WebDAV)", () => {
  it("reuses listed notes within the TTL but never serves stale data after a write", async () => {
    seedNoteWithMedia();
    let noteGets = 0;
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if ((options?.method ?? "GET") === "GET" && url.includes("/notes/n1.json")) noteGets++;
      return base(url, options);
    };

    await storage.getNotesByNotebook("nb-a");
    await storage.getNotesByNotebook("nb-a"); // second call within TTL → cache hit
    expect(noteGets).toBe(1);

    // Any local write invalidates the cache
    await storage.updateNote("n1", { title: "Changed" });
    const notes = await storage.getNotesByNotebook("nb-a");
    expect(notes.find((n) => n.id === "n1").title).toBe("Changed");
  });
});

// ── WebDAV base path safety ───────────────────────────────────────────────────

describe("getWebDAVBase safety", () => {
  it("fails loudly instead of falling back to another user's DAV root", async () => {
    seedNoteWithMedia();
    delete window.OC; // Nextcloud globals unavailable

    // Any operation must reject — never silently target /files/admin
    await expect(storage.getNote("n1")).rejects.toThrow(/Nextcloud user not available/);
  });
});

// ── Tombstone concurrency & corruption ────────────────────────────────────────

describe("tombstone updates (WebDAV)", () => {
  it("preserves concurrent tombstone entries via If-Match + retry", async () => {
    seedNoteWithMedia();
    const tombstonePath = "/NoteBerg/notebooks/nb-a/_tombstones.json";
    const entry = (id) => ({ id, deletedAt: new Date().toISOString() });
    server.seedJson(tombstonePath, {
      notes: [entry("n-other-device")],
      media: [],
      notebooks: [],
    });

    // Another device replaces the tombstone just before our first PUT —
    // our If-Match must fail (412) and the retry must merge both entries.
    const base = fetchImpl;
    let injected = false;
    fetchImpl = (url, options) => {
      if (!injected && options?.method === "PUT" && url.includes("_tombstones.json")) {
        injected = true;
        server.seedJson(tombstonePath, {
          notes: [entry("n-other-device"), entry("n-concurrent")],
          media: [],
          notebooks: [],
        });
      }
      return base(url, options);
    };

    await storage.permanentlyDeleteNote("n1");

    expect(injected).toBe(true);
    const tombstone = JSON.parse(server.files.get(tombstonePath).content);
    const ids = tombstone.notes.map((t) => t.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n-other-device");
    expect(ids).toContain("n-concurrent");
  });

  it("does not wipe a corrupted tombstone", async () => {
    seedNoteWithMedia();
    const tombstonePath = "/NoteBerg/notebooks/nb-a/_tombstones.json";
    server.seed(tombstonePath, { isCollection: false, content: "not-json{{{" });

    await expect(storage.permanentlyDeleteNote("n1")).rejects.toThrow();

    // Corrupted tombstone left untouched — deletion history not destroyed,
    // and the note file was not deleted (operation aborted before the DELETE)
    expect(server.files.get(tombstonePath).content).toBe("not-json{{{");
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(true);
  });
});
