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

  it("does not hand out the purged original's file locations for the copy", async () => {
    seedNoteWithMedia();
    // The original's file was opened this session: its location is known
    await storage.saveMediaForNote(new Blob(["x"], { type: "image/png" }), "f1", "n1", "nb-a");
    await storage.copyNote("n1", "nb-b");

    await storage.permanentlyDeleteNote("n1");

    // The copy holds the same file id; its URL must not lead into the deleted folder
    expect(storage.getFileUrl("f1") ?? "").not.toContain("/nb-a/notes/n1_media/");
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

  it("delete and restore of a note bump its version, as the native storage does", async () => {
    seedNoteWithMedia();
    const read = () =>
      JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content).version;
    const before = read();

    await storage.deleteNote("n1");
    const deleted = read();
    await storage.restoreNote("n1");

    expect(deleted).toBe((before || 0) + 1);
    expect(read()).toBe(deleted + 1);
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

// ── Coalescing writer ─────────────────────────────────────────────────────────

describe("updateNoteCoalesced (WebDAV)", () => {
  /**
   * Hold every PUT to n1.json open until released, so writes can be observed
   * while in flight. `total` counts PUTs ever started (not just pending ones),
   * which is what the coalescing assertions care about.
   */
  function blockPuts() {
    const pending = [];
    let total = 0;
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/notes/n1.json")) {
        total++;
        return new Promise((release) => {
          pending.push(() => release(base(url, options)));
        });
      }
      return base(url, options);
    };
    return {
      total: () => total,
      pending: () => pending.length,
      /**
       * Drain the whole chain. Each released PUT lets the next queued write run,
       * which only then issues its own PUT (via davMkcol → davPut), so releasing
       * once is not enough — keep going until no new gate appears.
       */
      drain: async () => {
        for (let i = 0; i < 20 && (pending.length || i < 2); i++) {
          while (pending.length) pending.shift()();
          await new Promise((r) => setTimeout(r, 0));
          await new Promise((r) => setTimeout(r, 0));
        }
      },
    };
  }

  it("collapses snapshots queued behind an in-flight write into a single PUT", async () => {
    seedNoteWithMedia();
    // Prime the path cache so getNote() does not scan notebooks mid-test.
    await storage.getNote("n1");

    const puts = blockPuts();

    // First call goes in flight and blocks on its PUT.
    const first = storage.updateNoteCoalesced("n1", { strokes: [{ id: "s1" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(puts.total()).toBe(1);

    // Three more strokes arrive while that PUT is still open. Serial queueing
    // would send three more PUTs; coalescing must collapse them into one.
    const a = storage.updateNoteCoalesced("n1", { strokes: [{ id: "s1" }, { id: "s2" }] });
    const b = storage.updateNoteCoalesced("n1", {
      strokes: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    });
    const c = storage.updateNoteCoalesced("n1", {
      strokes: [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }],
    });
    expect(a).toBe(b);
    expect(b).toBe(c);

    await puts.drain();
    await Promise.all([first, a, b, c]);

    // Exactly two PUTs: the in-flight one, then one carrying the newest snapshot.
    expect(puts.total()).toBe(2);

    // The surviving write must be the LATEST snapshot, not an intermediate one.
    const saved = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(saved.strokes.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("does not drop fields when different callers coalesce together", async () => {
    seedNoteWithMedia();
    await storage.getNote("n1");
    const puts = blockPuts();

    const first = storage.updateNoteCoalesced("n1", { strokes: [{ id: "s1" }] });
    await new Promise((r) => setTimeout(r, 0));

    // Two different field sets collapse into one pending snapshot — the merge
    // must keep both, not let the later call clobber the earlier one.
    const pendingA = storage.updateNoteCoalesced("n1", { deletedStrokes: ["gone"] });
    const pendingB = storage.updateNoteCoalesced("n1", { strokes: [{ id: "s9" }] });

    await puts.drain();
    await Promise.all([first, pendingA, pendingB]);

    const saved = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(saved.strokes.map((s) => s.id)).toEqual(["s9"]);
    expect(saved.deletedStrokes).toEqual(["gone"]);
  });

  it("flushNoteWrites resolves only after the pending snapshot is written", async () => {
    seedNoteWithMedia();
    await storage.getNote("n1");
    const puts = blockPuts();

    storage.updateNoteCoalesced("n1", { strokes: [{ id: "s1" }] });
    await new Promise((r) => setTimeout(r, 0));
    storage.updateNoteCoalesced("n1", { strokes: [{ id: "s1" }, { id: "s2" }] });

    let flushed = false;
    const flush = storage.flushNoteWrites("n1").then(() => {
      flushed = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toBe(false); // still pending — close must not proceed yet

    await puts.drain();
    await flush;

    expect(flushed).toBe(true);
    const saved = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(saved.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("surfaces write failures to the caller instead of swallowing them", async () => {
    seedNoteWithMedia();
    await storage.getNote("n1");

    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/notes/n1.json")) {
        return Promise.resolve(plainResponse(507));
      }
      return base(url, options);
    };

    await expect(storage.updateNoteCoalesced("n1", { strokes: [] })).rejects.toThrow(/507/);
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

  it("a note write leaves other folders' listings cached", async () => {
    // While drawing, every stroke PUTs the open note. A blanket cache clear
    // would make a concurrent overview render re-download every other folder.
    seedNoteWithMedia();
    server.seedJson("/NoteBerg/notebooks/nb-b/notes/n2.json", {
      id: "n2",
      notebookId: "nb-b",
      title: "Note 2",
      modified: 1000,
      version: 1,
    });

    await storage.getNotesByNotebook("nb-a");
    await storage.getNotesByNotebook("nb-b");

    let otherFolderGets = 0;
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if ((options?.method ?? "GET") === "GET" && url.includes("/notes/n2.json")) {
        otherFolderGets++;
      }
      return base(url, options);
    };

    await storage.updateNote("n1", { title: "Changed" });

    // nb-b is untouched by a write to nb-a's note — still served from cache
    const nbB = await storage.getNotesByNotebook("nb-b");
    expect(otherFolderGets).toBe(0);
    expect(nbB.find((n) => n.id === "n2").title).toBe("Note 2");

    // ...while nb-a genuinely re-fetches
    const nbA = await storage.getNotesByNotebook("nb-a");
    expect(nbA.find((n) => n.id === "n1").title).toBe("Changed");
  });

  it("does not let a caller's mutations corrupt the cached copy", async () => {
    seedNoteWithMedia();

    // First call is a cache miss and hands back its own copy. The second is a
    // hit — the copy it returns must also be private, or a consumer mutating a
    // note (overview rendering, mcpBridge) would poison every later reader.
    await storage.getNotesByNotebook("nb-a");
    const fromHit = await storage.getNotesByNotebook("nb-a");
    fromHit.find((n) => n.id === "n1").title = "Mutated by caller";

    const later = await storage.getNotesByNotebook("nb-a");
    expect(later.find((n) => n.id === "n1").title).toBe("Note 1");
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

// ── Notebook operations ────────────────────────────────────────────────────────

describe("notebook operations (WebDAV)", () => {
  it("createNotebook writes folders and the notebook JSON, and dispatches an event", async () => {
    const spy = vi.fn();
    window.addEventListener("notebook-created", spy);

    const nb = await storage.createNotebook({ title: "New NB", description: "d", color: "#fff" });

    expect(nb.id).toBeTruthy();
    expect(nb.deleted).toBe(false);
    expect(server.files.has(`/NoteBerg/notebooks/${nb.id}`)).toBe(true);
    expect(server.files.has(`/NoteBerg/notebooks/${nb.id}/notes`)).toBe(true);
    const stored = JSON.parse(
      server.files.get(`/NoteBerg/notebooks/${nb.id}/_notebook.json`).content,
    );
    expect(stored.title).toBe("New NB");
    expect(spy).toHaveBeenCalledTimes(1);

    window.removeEventListener("notebook-created", spy);
  });

  it("createNotebook defaults description and color when omitted", async () => {
    const nb = await storage.createNotebook({ title: "Bare" });
    expect(nb.description).toBe("");
    expect(nb.color).toBe("#3b82f6");
  });

  it("getAllNotebooks excludes deleted and sorts by modified desc", async () => {
    const notebooks = await storage.getAllNotebooks();
    const ids = notebooks.map((n) => n.id);
    expect(ids).toEqual(["nb-a", "nb-b"].sort()); // both modified:1000, order stable-ish
    expect(notebooks.every((n) => !n.deleted)).toBe(true);
  });

  it("getNotebook returns null for a missing notebook", async () => {
    const nb = await storage.getNotebook("does-not-exist");
    expect(nb).toBeNull();
  });

  it("updateNotebook merges updates, bumps modified/version", async () => {
    const updated = await storage.updateNotebook("nb-a", { title: "Renamed" });
    expect(updated.title).toBe("Renamed");
    // seedBaseStructure() does not set a version field, so (undefined || 0) + 1 === 1
    expect(updated.version).toBe(1);
    const stored = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/_notebook.json").content);
    expect(stored.title).toBe("Renamed");
  });

  it("updateNotebook throws for a missing notebook", async () => {
    await expect(storage.updateNotebook("nope", { title: "x" })).rejects.toThrow(
      "Notebook not found",
    );
  });

  it("deleteNotebook soft-deletes the notebook and cascades to its notes (no tombstone)", async () => {
    seedNoteWithMedia();
    await storage.deleteNotebook("nb-a");

    const nb = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/_notebook.json").content);
    expect(nb.deleted).toBe(true);
    const note = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(note.deleted).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/_tombstones.json")).toBe(false);
  });

  it("deleteNotebook throws for a missing notebook", async () => {
    await expect(storage.deleteNotebook("nope")).rejects.toThrow("Notebook not found");
  });

  it("getDeletedNotebooks returns only deleted notebooks", async () => {
    await storage.deleteNotebook("nb-a");
    const deleted = await storage.getDeletedNotebooks();
    expect(deleted.map((n) => n.id)).toEqual(["nb-a"]);
  });

  it("restoreNotebook clears the deleted flag", async () => {
    await storage.deleteNotebook("nb-a");
    const restored = await storage.restoreNotebook("nb-a");
    expect(restored.deleted).toBe(false);
    const stored = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/_notebook.json").content);
    expect(stored.deleted).toBe(false);
  });

  it("restoreNotebook throws for a missing notebook", async () => {
    await expect(storage.restoreNotebook("nope")).rejects.toThrow("Notebook not found");
  });

  it("permanentlyDeleteNotebook writes a global tombstone and removes the folder", async () => {
    await storage.permanentlyDeleteNotebook("nb-a");

    expect(server.files.has("/NoteBerg/notebooks/nb-a")).toBe(false);
    const tombstone = JSON.parse(server.files.get("/NoteBerg/notebooks/_tombstones.json").content);
    expect(tombstone.notebooks.some((t) => t.id === "nb-a")).toBe(true);
  });
});

// ── Note read/query operations ─────────────────────────────────────────────────

describe("note read operations (WebDAV)", () => {
  it("getNote finds a note by scanning notebooks when not cached, and normalizes array fields", async () => {
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n1.json", {
      id: "n1",
      notebookId: "nb-a",
      title: "Weird note",
      strokes: undefined,
      media: undefined,
      modified: 1000,
      thumbnail: "should-be-stripped",
    });

    const note = await storage.getNote("n1");
    expect(note.strokes).toEqual([]);
    expect(note.media).toEqual([]);
    expect(note.deletedRecordings).toEqual([]);
    expect(note.thumbnail).toBeUndefined();
  });

  it("getNote returns null when the note doesn't exist anywhere", async () => {
    const note = await storage.getNote("nowhere");
    expect(note).toBeNull();
  });

  it("getNote uses the cached notebookId on a second lookup (avoids full scan)", async () => {
    seedNoteWithMedia();
    await storage.getNote("n1"); // populates _notePathCache

    let getCount = 0;
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if ((options?.method ?? "GET") === "GET" && url.includes(".json")) getCount++;
      return base(url, options);
    };

    const note = await storage.getNote("n1");
    expect(note.id).toBe("n1");
    // Only the direct cached-path GET, not a scan across notebooks
    expect(getCount).toBe(1);
  });

  it("getNoteIndex, getNoteContent, getRawNote all delegate to getNote", async () => {
    seedNoteWithMedia();
    const [a, b, c] = await Promise.all([
      storage.getNoteIndex("n1"),
      storage.getNoteContent("n1"),
      storage.getRawNote("n1"),
    ]);
    expect(a.id).toBe("n1");
    expect(b.id).toBe("n1");
    expect(c.id).toBe("n1");
  });

  it("getAllNotes aggregates quick notes and notebook notes, excludes deleted", async () => {
    seedNoteWithMedia();
    server.seedJson("/NoteBerg/quickNotes/qn1.json", {
      id: "qn1",
      notebookId: null,
      title: "Quick",
      modified: 2000,
    });
    server.seedJson("/NoteBerg/notebooks/nb-b/notes/n2.json", {
      id: "n2",
      notebookId: "nb-b",
      title: "Deleted note",
      modified: 500,
      deleted: true,
    });

    const notes = await storage.getAllNotes();
    const ids = notes.map((n) => n.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("qn1");
    expect(ids).not.toContain("n2");
    // sorted by modified desc
    expect(notes[0].id).toBe("qn1");
  });

  it("getDeletedNotes returns only deleted notes across all folders", async () => {
    seedNoteWithMedia();
    server.seedJson("/NoteBerg/notebooks/nb-b/notes/n2.json", {
      id: "n2",
      notebookId: "nb-b",
      title: "Deleted note",
      modified: 500,
      deleted: true,
    });

    const deleted = await storage.getDeletedNotes();
    expect(deleted.map((n) => n.id)).toEqual(["n2"]);
  });

  it("getNotesByNotebook and getQuickNotes filter deleted and sort by modified desc", async () => {
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n1.json", {
      id: "n1",
      notebookId: "nb-a",
      modified: 1000,
    });
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n2.json", {
      id: "n2",
      notebookId: "nb-a",
      modified: 2000,
    });
    server.seedJson("/NoteBerg/quickNotes/qn1.json", {
      id: "qn1",
      notebookId: null,
      modified: 100,
    });

    const nbNotes = await storage.getNotesByNotebook("nb-a");
    expect(nbNotes.map((n) => n.id)).toEqual(["n2", "n1"]);

    const quick = await storage.getQuickNotes();
    expect(quick.map((n) => n.id)).toEqual(["qn1"]);
  });
});

// ── Note mutation operations ───────────────────────────────────────────────────

describe("note mutation operations (WebDAV)", () => {
  it("createNote writes defaults and dispatches note-created", async () => {
    const spy = vi.fn();
    window.addEventListener("note-created", spy);

    const note = await storage.createNote({ title: "Fresh", notebookId: "nb-a" });

    expect(note.id).toBeTruthy();
    expect(note.deleted).toBe(false);
    expect(note.version).toBe(1);
    expect(server.files.has(`/NoteBerg/notebooks/nb-a/notes/${note.id}.json`)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    window.removeEventListener("note-created", spy);
  });

  it("createNote for a quick note (no notebookId) ensures the quickNotes folder exists", async () => {
    const note = await storage.createNote({ title: "Quick" });
    expect(note.notebookId).toBeNull();
    expect(server.files.has(`/NoteBerg/quickNotes/${note.id}.json`)).toBe(true);
  });

  it("updateNote merges fields, bumps modified/version, dispatches datachange", async () => {
    seedNoteWithMedia();
    const spy = vi.fn();
    window.addEventListener("datachange", spy);

    const updated = await storage.updateNote("n1", { title: "New title" });

    expect(updated.title).toBe("New title");
    expect(updated.version).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].detail).toEqual({ noteId: "n1", source: "local" });

    window.removeEventListener("datachange", spy);
  });

  it("updateNote throws for a missing note", async () => {
    await expect(storage.updateNote("nope", { title: "x" })).rejects.toThrow("Note not found");
  });

  it("saveNote writes the note verbatim and dispatches datachange", async () => {
    seedNoteWithMedia();
    const note = await storage.getNote("n1");
    note.title = "Saved directly";

    await storage.saveNote(note);

    const stored = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(stored.title).toBe("Saved directly");
  });

  it("deleteNote throws for a missing note", async () => {
    await expect(storage.deleteNote("nope")).rejects.toThrow("Note not found");
  });

  it("restoreNote clears the deleted flag", async () => {
    seedNoteWithMedia();
    await storage.deleteNote("n1");
    const restored = await storage.restoreNote("n1");
    expect(restored.deleted).toBe(false);
  });

  it("restoreNote throws for a missing note", async () => {
    await expect(storage.restoreNote("nope")).rejects.toThrow("Note not found");
  });

  it("permanentlyDeleteNote is a no-op when the note doesn't exist", async () => {
    await expect(storage.permanentlyDeleteNote("nope")).resolves.toBeUndefined();
  });

  it("moveNote is a no-op when target equals the current notebook", async () => {
    seedNoteWithMedia();
    const before = server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").etag;

    await storage.moveNote("n1", "nb-a");

    const after = server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").etag;
    expect(after).toBe(before); // untouched — no PUT happened
  });

  it("moveNote throws for a missing note", async () => {
    await expect(storage.moveNote("nope", "nb-b")).rejects.toThrow("Note not found");
  });

  it("copyNote throws for a missing note", async () => {
    await expect(storage.copyNote("nope", "nb-b")).rejects.toThrow("Note not found");
  });

  it("copyNote handles a note with no media folder", async () => {
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n-nomedia.json", {
      id: "n-nomedia",
      notebookId: "nb-a",
      title: "No media",
      media: [],
      modified: 1000,
    });

    const copy = await storage.copyNote("n-nomedia", "nb-b");
    expect(copy.id).not.toBe("n-nomedia");
    expect(copy.deletedMedia).toEqual([]);
    expect(copy.version).toBe(1);
  });

  it("clearNoteMoveFlag removes previousNotebookId from the note", async () => {
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n1.json", {
      id: "n1",
      notebookId: "nb-a",
      previousNotebookId: "nb-old",
      modified: 1000,
    });

    await storage.clearNoteMoveFlag("n1");

    const stored = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(stored.previousNotebookId).toBeUndefined();
  });

  it("clearNoteMoveFlag is a no-op when the note doesn't exist", async () => {
    await expect(storage.clearNoteMoveFlag("nope")).resolves.toBeUndefined();
  });

  it("purgeNote delegates to permanentlyDeleteNote", async () => {
    seedNoteWithMedia();
    await storage.purgeNote("n1");
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(false);
  });

  it("permanentlyDeleteNotesInNotebook purges every note in the notebook", async () => {
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n1.json", {
      id: "n1",
      notebookId: "nb-a",
      modified: 1000,
    });
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n2.json", {
      id: "n2",
      notebookId: "nb-a",
      modified: 1000,
    });

    await storage.permanentlyDeleteNotesInNotebook("nb-a");

    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1.json")).toBe(false);
    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n2.json")).toBe(false);
  });
});

// ── Media / file operations ─────────────────────────────────────────────────────

describe("media operations (WebDAV)", () => {
  it("saveFile caches the blob in memory and returns a generated id when none given", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const id = await storage.saveFile(blob);
    expect(id).toBeTruthy();
    expect(await storage.getFile(id)).toBe(blob);
  });

  it("saveFile uses the provided id", async () => {
    const blob = new Blob(["hello"]);
    const id = await storage.saveFile(blob, "explicit-id");
    expect(id).toBe("explicit-id");
  });

  it("saveMediaForNote uploads the blob and records its location for getFileUrl", async () => {
    const blob = new Blob(["PNGDATA"], { type: "image/png" });
    await storage.saveMediaForNote(blob, "f2", "n1", "nb-a");

    expect(server.files.has("/NoteBerg/notebooks/nb-a/notes/n1_media/f2.png")).toBe(true);
    const url = storage.getFileUrl("f2");
    expect(url).toContain("/notes/n1_media/f2.png");
  });

  it("getFileUrl returns null when the file location is unknown", () => {
    expect(storage.getFileUrl("unknown-file")).toBeNull();
  });

  it("checkFileExists is true for cached blobs and files with resolved ext, false otherwise", async () => {
    const blob = new Blob(["x"]);
    await storage.saveFile(blob, "cached-file");
    expect(await storage.checkFileExists("cached-file")).toBe(true);
    expect(await storage.checkFileExists("never-seen")).toBe(false);
  });

  it("deleteFile clears both the in-memory cache and the location cache", async () => {
    const blob = new Blob(["x"]);
    await storage.saveFile(blob, "to-delete");
    await storage.deleteFile("to-delete");
    expect(await storage.checkFileExists("to-delete")).toBe(false);
  });

  it("getFile scans notebooks to find a file by prefix when location is unknown (e.g. after reload)", async () => {
    seedNoteWithMedia(); // note n1 in nb-a references fileId f1, file f1.png exists on server, no location cache

    const blob = await storage.getFile("f1");
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("PNG-DATA");
  });

  it("getFile returns null when the file cannot be found anywhere", async () => {
    seedNoteWithMedia();
    const blob = await storage.getFile("totally-unknown-file");
    expect(blob).toBeNull();
  });

  it("registerPendingUpload + waitForFileUrl waits for the upload before resolving the URL", async () => {
    let resolveUpload;
    const uploadPromise = new Promise((r) => {
      resolveUpload = r;
    });
    storage.registerPendingUpload("f4", uploadPromise);

    const waitPromise = storage.waitForFileUrl("f4");
    // Not yet resolved to a URL because location isn't known and upload is pending
    await storage.saveMediaForNote(new Blob(["x"], { type: "image/png" }), "f4", "n1", "nb-a");
    resolveUpload();

    const url = await waitPromise;
    expect(url).toContain("f4.png");
  });

  it("waitForFileUrl returns null immediately when there is no pending upload and no known location", async () => {
    const url = await storage.waitForFileUrl("never-uploaded");
    expect(url).toBeNull();
  });

  it("cleanupNoteMedia removes cache entries for deleted files (checkFileExists reflects it)", async () => {
    await storage.saveMediaForNote(new Blob(["x"], { type: "image/png" }), "keep2", "n1", "nb-a");
    await storage.saveMediaForNote(new Blob(["y"], { type: "image/png" }), "orphan2", "n1", "nb-a");

    await storage.cleanupNoteMedia("n1", "nb-a", ["keep2"]);

    expect(await storage.checkFileExists("orphan2")).toBe(false);
    expect(await storage.checkFileExists("keep2")).toBe(true);
  });
});

// ── initStorage ───────────────────────────────────────────────────────────────

describe("initStorage (WebDAV)", () => {
  it("creates required folders and sets the init flag on first run", async () => {
    // beforeEach already seeds /NoteBerg etc, but localStorage flag is unset
    await storage.initStorage();
    expect(localStorage.getItem("noteberg_webdav_initialized")).toBe("1");
  });

  it("re-verifies the root folder even if the init flag was already set, recreating it if missing", async () => {
    localStorage.setItem("noteberg_webdav_initialized", "1");
    server.files.delete("/NoteBerg"); // simulate folder removed out-of-band
    // Also remove children so MKCOL calls succeed cleanly
    for (const key of [...server.files.keys()]) {
      if (key.startsWith("/NoteBerg")) server.files.delete(key);
    }

    await storage.initStorage();

    expect(server.files.has("/NoteBerg")).toBe(true);
    expect(server.files.has("/NoteBerg/notebooks")).toBe(true);
    expect(server.files.has("/NoteBerg/quickNotes")).toBe(true);
  });

  it("is idempotent — calling twice does not re-run initialization work", async () => {
    await storage.initStorage();
    const mkcolCalls = [];
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "MKCOL") mkcolCalls.push(url);
      return base(url, options);
    };

    await storage.initStorage();
    expect(mkcolCalls).toEqual([]);
  });
});

// ── Settings / stats / stubs ────────────────────────────────────────────────────

describe("settings and stub APIs (WebDAV)", () => {
  it("getSetting/setSetting round-trip", async () => {
    expect(await storage.getSetting("missing-key")).toBeNull();
    await storage.setSetting("theme", "dark");
    expect(await storage.getSetting("theme")).toBe("dark");
  });

  it("generateId returns a non-empty unique string", () => {
    const a = storage.generateId();
    const b = storage.generateId();
    expect(a).not.toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("stub APIs resolve with their documented no-op values", async () => {
    expect(await storage.getStorageStats()).toEqual({
      notes: 0,
      notebooks: 0,
      files: 0,
      settings: 0,
    });
    await expect(storage.clearAllData()).resolves.toBeUndefined();
    await expect(storage.purgeLocalData()).resolves.toBeUndefined();
    expect(await storage.getStorageVersion()).toBe(2);
    await expect(storage.setStorageVersion()).resolves.toBeUndefined();
    expect(await storage.isLocalEncryptionEnabled()).toBe(false);
    expect(await storage.fixCorruptedNotes()).toEqual({ fixed: 0 });
    await expect(storage.migrateNotesToEncrypted()).resolves.toBeUndefined();
    await expect(storage.updateNoteEtag()).resolves.toBeUndefined();
    expect(await storage.getAllNotesForSync()).toEqual([]);
    expect(await storage.getAllNoteMetadataForSync()).toEqual([]);
    expect(await storage.getAllNotebooksForSync()).toEqual([]);
  });

  it("purgeNotebook delegates to permanentlyDeleteNotebook", async () => {
    await storage.purgeNotebook("nb-a");
    expect(server.files.has("/NoteBerg/notebooks/nb-a")).toBe(false);
    const tombstone = JSON.parse(server.files.get("/NoteBerg/notebooks/_tombstones.json").content);
    expect(tombstone.notebooks.some((t) => t.id === "nb-a")).toBe(true);
  });

  it("saveNotebook delegates to updateNotebook", async () => {
    const result = await storage.saveNotebook({ id: "nb-a", title: "Via saveNotebook" });
    expect(result.title).toBe("Via saveNotebook");
    const stored = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/_notebook.json").content);
    expect(stored.title).toBe("Via saveNotebook");
  });
});

// ── PUT retry / error-handling branches ─────────────────────────────────────────

describe("davPutWithRetry (WebDAV)", () => {
  it("retries on 423 Locked and succeeds once the lock clears", async () => {
    let attempts = 0;
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/notes/n1.json")) {
        attempts++;
        if (attempts < 2) return Promise.resolve(plainResponse(423));
      }
      return base(url, options);
    };
    seedNoteWithMedia();

    await storage.updateNote("n1", { title: "Retried" });

    expect(attempts).toBe(2);
    const stored = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(stored.title).toBe("Retried");
  });

  it("throws with a status-carrying error after exhausting retries", async () => {
    seedNoteWithMedia();
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/notes/n1.json")) {
        return Promise.resolve(plainResponse(500));
      }
      return base(url, options);
    };

    await expect(storage.updateNote("n1", { title: "x" })).rejects.toMatchObject({
      status: 500,
    });
  });
});

// ── MKCOL / MOVE / COPY error branches ──────────────────────────────────────────

describe("davMkcol and davMove/Copy error handling (WebDAV)", () => {
  it("createNotebook throws when MKCOL fails with a non-405 status", async () => {
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "MKCOL") return Promise.resolve(plainResponse(500));
      return base(url, options);
    };

    await expect(storage.createNotebook({ title: "Boom" })).rejects.toThrow(/MKCOL/);
  });

  it("moveNote propagates a non-404 MOVE failure instead of swallowing it", async () => {
    seedNoteWithMedia();
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "MOVE") return Promise.resolve(plainResponse(500));
      return base(url, options);
    };

    await expect(storage.moveNote("n1", "nb-b")).rejects.toMatchObject({ status: 500 });
  });
});

// ── getFile: known-location WebDAV fetch path ───────────────────────────────────

describe("getFile known-location fetch (WebDAV)", () => {
  it("fetches the blob from WebDAV when location is cached but blob is not in memory", async () => {
    await storage.saveMediaForNote(new Blob(["DATA"], { type: "image/png" }), "f5", "n1", "nb-a");
    await storage.deleteFile("f5"); // clears both the in-memory blob cache and the location cache

    // Re-derive only the location cache (no blob cache) via getNote()'s _cacheFileLocations,
    // which resolves fileId → {noteId, notebookId, ext} from a folder listing without fetching
    // the binary itself — this is the "known location, cache-miss on blob" path getFile exercises.
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n5.json", {
      id: "n5",
      notebookId: "nb-a",
      title: "Has media",
      media: [{ id: "m5", fileId: "f5", type: "image" }],
      modified: 1000,
    });
    server.seedFolder("/NoteBerg/notebooks/nb-a/notes/n5_media");
    server.seed("/NoteBerg/notebooks/nb-a/notes/n5_media/f5.png", {
      isCollection: false,
      content: "DATA",
    });

    // getNote() populates _fileLocationCache (with ext) via _cacheFileLocations, without touching _fileCache
    await storage.getNote("n5");
    const blob = await storage.getFile("f5");
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("DATA");
  });
});

// ── davGet JSON-parse error handling ────────────────────────────────────────────

describe("davGet malformed JSON (WebDAV)", () => {
  it("getNotebook returns null (not a throw) when the stored JSON is malformed", async () => {
    server.seed("/NoteBerg/notebooks/nb-a/_notebook.json", {
      isCollection: false,
      content: "{not valid json",
    });

    const nb = await storage.getNotebook("nb-a");
    expect(nb).toBeNull();
  });
});

// ── Settings persistence ──────────────────────────────────────────────────────
//
// These lived in a module-level object and were silently lost on every reload,
// which made the recognition backend impossible to configure on Nextcloud: each
// page load reset it to the sidecar default, which does not exist there.
describe("settings", () => {
  it("survives a reload", async () => {
    await storage.setSetting("recognition_backend", "replicate");

    // A fresh module instance is what a page reload actually produces.
    vi.resetModules();
    const reloaded = await import("./storage.webdav.js");

    expect(await reloaded.getSetting("recognition_backend")).toBe("replicate");
  });

  it("round-trips non-string values", async () => {
    // maxTokens and the boolean toggles must not come back as strings — a
    // stringified `false` is truthy, and a stringified number breaks arithmetic.
    await storage.setSetting("recognition_max_tokens", 8000);
    await storage.setSetting("encrypt_local_data", false);

    expect(await storage.getSetting("recognition_max_tokens")).toBe(8000);
    expect(await storage.getSetting("encrypt_local_data")).toBe(false);
  });

  it("returns null for an unset key", async () => {
    // Callers rely on null to apply their own default.
    expect(await storage.getSetting("never_set")).toBeNull();
  });

  it("namespaces keys so it cannot collide with Nextcloud's own storage", async () => {
    await storage.setSetting("theme", "dark");
    expect(localStorage.getItem("theme")).toBeNull();
    expect(localStorage.getItem("noteberg_setting_theme")).toBe('"dark"');
  });

  it("survives a corrupt stored value", async () => {
    localStorage.setItem("noteberg_setting_broken", "{not json");
    expect(await storage.getSetting("broken")).toBeNull();
  });
});

// ── Recognition jobs ──────────────────────────────────────────────────────────
describe("recognition jobs", () => {
  const job = (id, over = {}) => ({ id, noteId: "n1", state: "queued", ...over });

  it("persists a job across a reload", async () => {
    // The point of the store: an interrupted job resumes rather than restarting.
    await storage.saveRecognitionJob(job("j1", { bandIndex: 2 }));

    vi.resetModules();
    const reloaded = await import("./storage.webdav.js");

    const stored = await reloaded.getRecognitionJobs();
    expect(stored).toHaveLength(1);
    expect(stored[0].bandIndex).toBe(2);
  });

  it("replaces a job with the same id rather than duplicating it", async () => {
    // Every checkpoint re-saves the same job; appending would grow without bound.
    await storage.saveRecognitionJob(job("j1", { bandIndex: 0 }));
    await storage.saveRecognitionJob(job("j1", { bandIndex: 3 }));

    const stored = await storage.getRecognitionJobs();
    expect(stored).toHaveLength(1);
    expect(stored[0].bandIndex).toBe(3);
  });

  it("deletes one job without disturbing the others", async () => {
    await storage.saveRecognitionJob(job("j1"));
    await storage.saveRecognitionJob(job("j2"));

    await storage.deleteRecognitionJob("j1");

    const stored = await storage.getRecognitionJobs();
    expect(stored.map((j) => j.id)).toEqual(["j2"]);
  });

  it("reports an empty queue when nothing is stored", async () => {
    expect(await storage.getRecognitionJobs()).toEqual([]);
  });

  it("survives a corrupt store rather than throwing on startup", async () => {
    // Resume runs during app init; a parse error here must not break launch.
    localStorage.setItem("noteberg_recognition_jobs", "{not json");
    expect(await storage.getRecognitionJobs()).toEqual([]);
  });
});

// ── Concurrent writers ────────────────────────────────────────────────────────
// Two people (or two tabs) editing one note: each save is read-modify-write of
// the whole JSON file, so without merging the last PUT would silently replace
// the other's strokes and text.

describe("concurrent writers (WebDAV)", () => {
  const NOTE_PATH = "/NoteBerg/notebooks/nb-a/notes/n1.json";
  const readNote = () => JSON.parse(server.files.get(NOTE_PATH).content);
  const strokeIds = () => readNote().strokes.map((s) => s.id);

  /** Another client writes the note: new content, new etag, as the server would. */
  function foreignWrite(changes) {
    const current = readNote();
    server.seed(NOTE_PATH, {
      isCollection: false,
      content: JSON.stringify({ ...current, ...changes, version: (current.version || 0) + 1 }),
    });
  }

  const stroke = (id) => ({ id, x: [1], y: [1] });

  function seedSharedNote(extra = {}) {
    server.seedJson(NOTE_PATH, {
      id: "n1",
      notebookId: "nb-a",
      title: "Shared",
      content: "<p>one</p><p>two</p>",
      strokes: [stroke("s1")],
      deletedStrokes: [],
      modified: 1000,
      version: 1,
      ...extra,
    });
  }

  function datachangeSources() {
    const sources = [];
    const listener = (e) => sources.push(e.detail?.source);
    window.addEventListener("datachange", listener);
    return { sources, stop: () => window.removeEventListener("datachange", listener) };
  }

  /** A second writer lands between this client's GET and its PUT, once. */
  function raceOnce(changes) {
    const base = fetchImpl;
    let raced = false;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/n1.json") && !raced) {
        raced = true;
        foreignWrite(changes);
      }
      return base(url, options);
    };
    return () => raced;
  }

  it("a single writer is unaffected: strokes are replaced, the write is conditional and local", async () => {
    seedSharedNote();
    const events = datachangeSources();
    const putHeaders = [];
    const base = fetchImpl;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/n1.json")) putHeaders.push(options.headers);
      return base(url, options);
    };
    await storage.getNote("n1");

    await storage.updateNote("n1", { strokes: [stroke("s2")] });
    await storage.updateNote("n1", { strokes: [stroke("s3")] });
    events.stop();

    expect(strokeIds()).toEqual(["s3"]);
    expect(putHeaders).toHaveLength(2);
    expect(putHeaders.every((h) => h["If-Match"])).toBe(true);
    expect(events.sources).toEqual(["local", "local"]);
  });

  it("stamps every write with the signed-in user", async () => {
    seedSharedNote();
    await storage.updateNote("n1", { title: "Renamed" });
    expect(readNote().lastModifiedBy).toBe("testuser");
  });

  it("keeps the other writer's strokes when this editor saves its own, and tells the editor", async () => {
    seedSharedNote();
    await storage.getNote("n1"); // the editor opens the note
    foreignWrite({ strokes: [stroke("s1"), stroke("s-other")] });
    const events = datachangeSources();

    // The editor only knows s1 and its own new stroke
    await storage.updateNoteCoalesced("n1", {
      strokes: [stroke("s1"), stroke("s-mine")],
      deletedStrokes: [],
    });
    events.stop();

    expect(strokeIds().sort()).toEqual(["s-mine", "s-other", "s1"]);
    // Not "local": the open editor must adopt what it has not seen
    expect(events.sources).toEqual(["merge"]);
  });

  it("respects an erase made in the editor while merging in the other side's strokes", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    foreignWrite({ strokes: [stroke("s1"), stroke("s-other")] });

    await storage.updateNoteCoalesced("n1", { strokes: [], deletedStrokes: ["s1"] });

    expect(strokeIds()).toEqual(["s-other"]);
    expect(readNote().deletedStrokes).toEqual(["s1"]);
  });

  it("keeps merging until the editor re-reads, so the next stroke-only save cannot drop theirs", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    foreignWrite({ strokes: [stroke("s1"), stroke("s-other")] });
    await storage.updateNoteCoalesced("n1", {
      strokes: [stroke("s1"), stroke("s-a")],
      deletedStrokes: [],
    });

    // The editor still has no s-other and sends its next snapshot
    await storage.updateNoteCoalesced("n1", {
      strokes: [stroke("s1"), stroke("s-a"), stroke("s-b")],
      deletedStrokes: [],
    });

    expect(strokeIds().sort()).toEqual(["s-a", "s-b", "s-other", "s1"]);
  });

  it("is not fooled by another reader refreshing the note before the editor saves", async () => {
    // Recognition and live updates read the note around the time it is closed. If a
    // plain read moved the mark, the editor's save would think nobody else had written.
    seedSharedNote();
    await storage.getNote("n1", { track: true }); // the editor opens the note
    foreignWrite({ strokes: [stroke("s1"), stroke("s-other")] }); // the other user closes theirs
    await storage.getNote("n1"); // recognition reads the note

    await storage.updateNoteCoalesced("n1", {
      strokes: [stroke("s1"), stroke("s-mine")],
      deletedStrokes: [],
    });

    expect(strokeIds().sort()).toEqual(["s-mine", "s-other", "s1"]);
  });

  it("measures saves against the latest editor load, not an older one", async () => {
    seedSharedNote();
    await storage.getNote("n1", { track: true });
    foreignWrite({ strokes: [stroke("s1"), stroke("s-other")] });
    await storage.getNote("n1", { track: true }); // the note is reopened and now includes s-other

    const events = datachangeSources();
    await storage.updateNoteCoalesced("n1", {
      strokes: [stroke("s1"), stroke("s-other"), stroke("s-mine")],
      deletedStrokes: [],
    });
    events.stop();

    expect(events.sources).toEqual(["local"]);
    expect(strokeIds().sort()).toEqual(["s-mine", "s-other", "s1"]);
  });

  it("merges independent text edits against the editor's baseline", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    foreignWrite({ content: "<p>one</p><p>TWO by them</p>" });

    await storage.updateNote("n1", { content: "<p>ONE by me</p><p>two</p>" });

    expect(readNote().content).toBe("<p>ONE by me</p><p>TWO by them</p>");
  });

  it("keeps both versions of a block edited on both sides and marks the duplicate", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    foreignWrite({ content: "<p>one</p><p>theirs</p>", lastModifiedBy: "bob" });

    await storage.updateNote("n1", { content: "<p>one</p><p>mine</p>" });

    const { content } = readNote();
    expect(content).toContain("mine");
    expect(content).toContain("theirs");
    expect(content).toContain('class="merge-hint"');
  });

  it("keeps the editor's lineage as the text baseline, so their text survives later saves", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    foreignWrite({ content: "<p>one</p><p>two</p><p>from them</p>" });
    await storage.updateNote("n1", { content: "<p>ONE</p><p>two</p>" });
    expect(readNote().content).toContain("from them");

    // The editor never saw "from them"; its next save must not read that as a deletion
    await storage.updateNote("n1", { content: "<p>ONE!</p><p>two</p>" });

    expect(readNote().content).toContain("from them");
    expect(readNote().content).toContain("ONE!");
  });

  it("retries a PUT that loses the race and merges the writer that won", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    const raced = raceOnce({ strokes: [stroke("s1"), stroke("s-race")] });

    await storage.updateNoteCoalesced("n1", {
      strokes: [stroke("s1"), stroke("s-mine")],
      deletedStrokes: [],
    });

    expect(raced()).toBe(true);
    expect(strokeIds().sort()).toEqual(["s-mine", "s-race", "s1"]);
  });

  it("merges after a lost race even when this client never read the note before", async () => {
    seedSharedNote();
    const raced = raceOnce({ strokes: [stroke("s1"), stroke("s-race")] });

    await storage.updateNote("n1", { strokes: [stroke("s-mine")] });

    expect(raced()).toBe(true);
    expect(strokeIds().sort()).toEqual(["s-mine", "s-race", "s1"]);
  });

  it("gives up with the 412 after repeated races instead of looping", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    const base = fetchImpl;
    let puts = 0;
    fetchImpl = (url, options) => {
      if (options?.method === "PUT" && url.includes("/n1.json")) {
        puts++;
        foreignWrite({ title: `raced ${puts}` });
      }
      return base(url, options);
    };

    await expect(storage.updateNote("n1", { title: "Mine" })).rejects.toMatchObject({
      status: 412,
    });
    expect(puts).toBe(3);
  });

  it("applies last-write-wins fields as the editor sent them, never unioning tags back in", async () => {
    seedSharedNote({ tags: ["a", "b"] });
    await storage.getNote("n1");
    foreignWrite({ tags: ["a", "b", "c"] });

    await storage.updateNote("n1", { tags: ["a"] });

    expect(readNote().tags).toEqual(["a"]);
  });

  it("forgets a note's sync state when it is permanently deleted", async () => {
    seedSharedNote();
    await storage.getNote("n1");
    foreignWrite({ strokes: [stroke("s1"), stroke("s-other")] });
    await storage.updateNote("n1", { title: "merged once" }); // needsMerge is now set
    await storage.permanentlyDeleteNote("n1");
    server.seedFolder("/NoteBerg/notebooks/nb-a/notes");
    server.seedJson(NOTE_PATH, {
      id: "n1",
      notebookId: "nb-a",
      title: "Recreated",
      strokes: [stroke("s-fresh")],
      modified: 1,
    });

    // No stale merge state from the previous life of this id: plain replace
    await storage.updateNote("n1", { strokes: [stroke("s-new")] });

    expect(strokeIds()).toEqual(["s-new"]);
  });
});

describe("notebook writes and local-only sharing fields (WebDAV)", () => {
  it("never PUTs sharing fields, whether they come from the caller or an annotated record", async () => {
    await storage.updateNotebook("nb-a", {
      title: "Renamed",
      origin: "shared",
      sharePermissions: 7,
      ownerUid: "alice",
      strandedNoteIds: ["n1"],
    });

    const saved = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/_notebook.json").content);
    expect(saved.title).toBe("Renamed");
    expect(saved).not.toHaveProperty("origin");
    expect(saved).not.toHaveProperty("sharePermissions");
    expect(saved).not.toHaveProperty("ownerUid");
    expect(saved).not.toHaveProperty("strandedNoteIds");
  });

  it("strips them on soft delete and restore as well", async () => {
    await storage.deleteNotebook("nb-a");
    await storage.restoreNotebook("nb-a");
    const saved = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/_notebook.json").content);
    expect(Object.keys(saved)).not.toContain("origin");
    expect(saved.deleted).toBe(false);
  });
});

describe("etags of compressed responses (WebDAV)", () => {
  it("saves a note when the server's GET etag carries a -gzip suffix", async () => {
    // Apache's mod_deflate appends "-gzip" to the etag of a compressed body; the
    // file's real etag (what If-Match is compared with) does not have it.
    server.seedJson("/NoteBerg/notebooks/nb-a/notes/n1.json", {
      id: "n1",
      notebookId: "nb-a",
      title: "Old",
      modified: 1,
    });
    const base = fetchImpl;
    fetchImpl = async (url, options) => {
      const res = await base(url, options);
      if ((options?.method ?? "GET") !== "GET" || !res.headers) return res;
      const etag = res.headers.get("etag");
      return {
        ...res,
        headers: {
          get: (n) => (n.toLowerCase() === "etag" ? etag?.replace(/"$/, '-gzip"') : null),
        },
      };
    };

    await storage.getNote("n1");
    await storage.updateNote("n1", { title: "New" });

    const saved = JSON.parse(server.files.get("/NoteBerg/notebooks/nb-a/notes/n1.json").content);
    expect(saved.title).toBe("New");
  });

  it("strips quotes, the weak marker and compression suffixes", async () => {
    const { bareEtag } = await import("./storage.webdav.js");
    expect(bareEtag('"abc"')).toBe("abc");
    expect(bareEtag('W/"abc"')).toBe("abc");
    expect(bareEtag('"abc-gzip"')).toBe("abc");
    expect(bareEtag('"abc-br"')).toBe("abc");
    expect(bareEtag(null)).toBeUndefined();
  });
});

// Review P4, 4.7 / 4.9: the open note's saves and live take-ins run in the
// note-file worker (inline here, the same code) and carry little.
describe("the open note's work off the main thread (WebDAV)", () => {
  const stroke = (id, v, y = 1) => ({ id, x: [1, 2], y: [y, y + 1], v });
  const NOTE = "/NoteBerg/notebooks/nb-a/notes/n1.json";
  const stored = () => JSON.parse(server.files.get(NOTE).content);

  beforeEach(() => {
    server.seedJson(NOTE, {
      id: "n1",
      notebookId: "nb-a",
      title: "Note 1",
      content: "<p>a</p>",
      strokes: [stroke("s1", "000000001-000-x"), stroke("s2", "000000002-000-x")],
      deletedStrokes: [],
      modified: 1000,
      version: 1,
    });
  });

  it("merges a save of only the unconfirmed strokes with the ones on the server", async () => {
    await storage.getNote("n1", { track: true });
    await storage.updateNote("n1", {
      strokes: [stroke("s3", "000000009-000-me")],
      strokesPartial: true,
      deletedStrokes: ["s1"],
    });

    expect(
      stored()
        .strokes.map((s) => s.id)
        .sort(),
    ).toEqual(["s2", "s3"]);
    expect(stored().deletedStrokes).toEqual(["s1"]);
    expect(stored()).not.toHaveProperty("strokesPartial");
  });

  it("hands back the written note without its strokes", async () => {
    await storage.getNote("n1", { track: true });
    const written = await storage.updateNote("n1", { title: "Renamed" });
    expect(written.title).toBe("Renamed");
    expect(written).not.toHaveProperty("strokes");
  });

  it("takes the server's version in as a delta against what the editor holds", async () => {
    await storage.getNote("n1", { track: true });
    // Someone else drew a stroke and changed the text
    const theirs = stored();
    theirs.strokes.push(stroke("s9", "000000005-000-other"));
    theirs.content = "<p>a</p><p>theirs</p>";
    server.seedJson(NOTE, theirs);

    const view = {
      held: [
        ["s1", "000000001-000-x"],
        ["s2", "000000002-000-x"],
      ],
      soft: [],
      changed: [],
      deletedStrokes: [],
      media: [],
      deletedMedia: [],
      tasks: [],
      deletedTasks: [],
      recordings: [],
      deletedRecordings: [],
      content: "<p>a</p>",
      title: "Note 1",
    };
    const read = await storage.takeInStoredNote("n1", view, {
      baseline: "<p>a</p>",
      editorText: "<p>a</p><p>mine</p>",
    });

    expect(read.delta.strokes.added.map((s) => s.id)).toEqual(["s9"]);
    expect(read.delta.strokes.changed).toEqual([]);
    expect(read.text.remote).toBe("<p>a</p><p>theirs</p>");
    expect(read.text.merged).toContain("mine");
    expect(read.text.merged).toContain("theirs");
    expect(read.etag).toBeTruthy();
  });

  it("reads only the text for LiveText", async () => {
    await storage.getNote("n1", { track: true });
    await expect(storage.readStoredNoteText("n1")).resolves.toEqual({
      content: "<p>a</p>",
      author: undefined,
    });
  });
});
