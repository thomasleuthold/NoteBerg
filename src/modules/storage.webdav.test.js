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
  it("getSetting/setSetting round-trip through the in-memory store", async () => {
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
