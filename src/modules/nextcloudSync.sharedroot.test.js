/**
 * src/modules/nextcloudSync.sharedroot.test.js
 * Syncing a notebook another user shared with this one (DESIGN §5.3-5.5).
 *
 * Runs as "bob", the recipient, against a mock Nextcloud where "alice" owns the
 * notebook. The share is mounted into bob's tree and every request is checked
 * against the permission bits it grants, so these tests catch an engine that
 * writes where the share does not allow.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "./__fixtures__/mockOcsServer.js";
import { fullSync, SharedRootMissingError, syncSharedNotebook } from "./nextcloudSync.js";
import { clearSharedNotebookBases, setSharedNotebookBases } from "./storagePaths.js";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("./encryption.js", () => ({ decryptObject: vi.fn() }));

const secrets = new Map();
vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));

const mockNoteStore = new Map();
vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  saveFile: vi.fn(async () => "file-id"),
  getFile: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
  checkFileExists: vi.fn(async () => false),
  deleteFile: vi.fn(),
  permanentlyDeleteNote: vi.fn(),
  permanentlyDeleteNotebook: vi.fn(),
  permanentlyDeleteNotesInNotebook: vi.fn(),
  getSetting: vi.fn(async () => null),
  isLocalEncryptionEnabled: vi.fn(async () => false),
  initStorage: vi.fn(),
  saveNote: vi.fn(async () => {}),
  getNoteBase: vi.fn(async () => null),
  getNote: vi.fn(async (id) => mockNoteStore.get(id) ?? null),
  getRawNote: vi.fn(async (id) => mockNoteStore.get(id) ?? null),
}));

const WRITE_METHODS = ["PUT", "MKCOL", "DELETE", "MOVE", "COPY"];
const NOTEBOOK = "nb1";
const MOUNT = "/nb1"; // where Nextcloud mounts the share in bob's tree

let nc;
let alice;
let bob;
let share;

const writes = (server) => server.requests.filter((r) => WRITE_METHODS.includes(r.method));
const readAlice = (path) => JSON.parse(alice.files.get(path).content);
const aliceNotePath = (id) => `/NoteBerg/notebooks/${NOTEBOOK}/notes/${id}.json`;

/** Bob's local record of the shared notebook, with the permissions the share grants. */
function localNotebook(overrides = {}) {
  return {
    id: NOTEBOOK,
    title: "Recipes",
    modified: 1000,
    origin: "shared",
    remoteBasePath: MOUNT,
    sharePermissions: share.permissions,
    synced: true,
    lastSyncedEtag: null,
    ...overrides,
  };
}

/** A note bob has synced before, in step with what alice's tree holds. */
function syncedLocalNote(id, overrides = {}) {
  const remote = readAlice(aliceNotePath(id));
  return {
    id,
    notebookId: NOTEBOOK,
    title: remote.title,
    content: remote.content,
    modified: remote.modified,
    version: remote.version,
    synced: true,
    lastSyncedEtag: alice.files.get(aliceNotePath(id)).etag,
    ...overrides,
  };
}

async function shareWithBob(permissions) {
  const created = await nc.share("alice", `/NoteBerg/notebooks/${NOTEBOOK}`, "bob", permissions);
  share = { id: created.id, permissions: created.permissions };
  setSharedNotebookBases(new Map([[NOTEBOOK, bob.mounts.get(share.id).path]]));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockNoteStore.clear();
  clearSharedNotebookBases();

  nc = new MockNextcloud();
  nc.addUser("alice");
  nc.addUser("bob");
  alice = nc.dav("alice");
  bob = nc.dav("bob");
  wireMockNextcloud(fetch, nc);
  secrets.clear();
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: nc.baseUrl,
      loginName: "bob",
      appPassword: "app-password-123",
      userId: "bob",
    }),
  );

  alice.seedNotebook(NOTEBOOK, { title: "Recipes", modified: 1000 });
  alice.seedNote(NOTEBOOK, {
    id: "n1",
    notebookId: NOTEBOOK,
    title: "Soup",
    content: "<p>carrots</p>",
    modified: 1000,
    version: 1,
  });
  alice.seedNote(NOTEBOOK, {
    id: "n2",
    notebookId: NOTEBOOK,
    title: "Bread",
    content: "<p>flour</p>",
    modified: 1000,
    version: 1,
  });
  await shareWithBob(7);
});

describe("reading a shared notebook", () => {
  it.each([
    ["Depth: infinity", () => {}],
    ["the per-folder fallback", () => alice.rejectDepthInfinity()],
  ])("downloads the notebook and its notes from the sharer's tree (%s)", async (_label, setup) => {
    setup();

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "stale" }), []);

    expect(result.downloaded.notebooks.map((n) => n.id)).toEqual([NOTEBOOK]);
    expect(result.downloaded.notes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(result.downloaded.notes.find((n) => n.id === "n1").content).toBe("<p>carrots</p>");
    expect(result.rootMissing).toBeUndefined();
  });

  it("reads through the registered base, wherever Nextcloud mounted the share", async () => {
    // The user (or the app) moved the mount; the base follows
    const newBase = "/Shared_NoteBerg/alice_Recipes";
    bob.files.set("/Shared_NoteBerg", { isCollection: true, mtime: new Date() });
    bob.mounts.get(share.id).path = newBase;
    setSharedNotebookBases(new Map([[NOTEBOOK, newBase]]));

    const result = await syncSharedNotebook(localNotebook({ remoteBasePath: newBase }), []);

    expect(result.downloaded.notes).toHaveLength(2);
  });

  it("only reads: a first sync of a clean notebook issues no write request", async () => {
    await syncSharedNotebook(localNotebook(), []);
    expect(writes(bob)).toEqual([]);
  });

  it("never touches the own tree", async () => {
    await syncSharedNotebook(localNotebook(), []);
    expect(bob.requests.filter((r) => r.path.startsWith("/NoteBerg"))).toEqual([]);
  });

  it("ignores a note file that does not describe the note it is named", async () => {
    alice.seedNote(NOTEBOOK, { id: "n3", notebookId: NOTEBOOK, title: "Honest", modified: 1 });
    alice.files.set(aliceNotePath("n3"), {
      content: JSON.stringify({ id: "someone-elses-note", notebookId: NOTEBOOK, modified: 1 }),
      etag: "e3",
      mtime: new Date(),
    });
    alice.files.set(aliceNotePath("n4"), {
      content: JSON.stringify({ id: "n4", notebookId: "another-notebook", modified: 1 }),
      etag: "e4",
      mtime: new Date(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncSharedNotebook(localNotebook(), []);

    expect(result.downloaded.notes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    warn.mockRestore();
  });

  it("ignores a note whose id is not safe to put into paths and markup", async () => {
    // Named after its id, so only the id check can catch it
    const id = 'x" data-evil="1';
    alice.files.set(aliceNotePath(id), {
      content: JSON.stringify({ id, notebookId: NOTEBOOK, modified: 1 }),
      etag: "e5",
      mtime: new Date(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncSharedNotebook(localNotebook(), []);

    expect(result.downloaded.notes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    warn.mockRestore();
  });

  it("ignores a notebook file that claims another notebook's id", async () => {
    alice.files.get(`/NoteBerg/notebooks/${NOTEBOOK}/_notebook.json`).content = JSON.stringify({
      id: "my-own-notebook",
      title: "Hijack",
      modified: 5000,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "stale" }), []);

    expect(result.downloaded.notebooks).toEqual([]);
    warn.mockRestore();
  });
});

describe("a shared root that is gone", () => {
  it("reports it and does nothing else when the share was revoked (404)", async () => {
    await nc.handleRequest(
      `${nc.baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares/${share.id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: alice._basicAuthFor(),
          "OCS-APIRequest": "true",
        },
      },
    );
    bob.requests.length = 0;

    const dirty = { id: "n1", notebookId: NOTEBOOK, modified: 5000, synced: false };
    mockNoteStore.set("n1", { ...dirty, content: "<p>offline edit</p>" });
    const result = await syncSharedNotebook(localNotebook(), [dirty]);

    expect(result.rootMissing).toBe(true);
    expect(result.uploaded.notes.uploaded).toBe(0);
    expect(writes(bob)).toEqual([]);
    // ...and nothing was recreated in the own tree either
    expect(bob.requests.filter((r) => r.path.startsWith("/NoteBerg"))).toEqual([]);
    expect([...bob.files.keys()].some((p) => p.includes(NOTEBOOK))).toBe(false);
  });

  it("treats a forbidden root the same way", async () => {
    bob.failEvery({ pathMatch: MOUNT, status: 403 });

    const result = await syncSharedNotebook(localNotebook(), []);

    expect(result.rootMissing).toBe(true);
  });

  it("throws SharedRootMissingError from fullSync itself, before classifying anything", async () => {
    bob.removeMount(share.id);
    const dirty = { id: "n1", notebookId: NOTEBOOK, modified: 5000, synced: false };
    mockNoteStore.set("n1", dirty);

    await expect(
      fullSync([localNotebook()], [dirty], { shared: { notebookId: NOTEBOOK, canEdit: true } }),
    ).rejects.toBeInstanceOf(SharedRootMissingError);
    expect(writes(bob)).toEqual([]);
  });

  it("does not mistake a failing server for a missing root", async () => {
    bob.failEvery({ pathMatch: MOUNT, status: 503 });
    await expect(syncSharedNotebook(localNotebook(), [])).rejects.not.toBeInstanceOf(
      SharedRootMissingError,
    );
  });

  it("skips a notebook whose _notebook.json is missing instead of creating it", async () => {
    alice.files.delete(`/NoteBerg/notebooks/${NOTEBOOK}/_notebook.json`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncSharedNotebook(localNotebook({ synced: false }), []);

    expect(result.notebooksToUpload).toEqual([]);
    expect(writes(bob)).toEqual([]);
    warn.mockRestore();
  });
});

describe("a collaborator (read, update, create)", () => {
  it("uploads an edited note into the sharer's tree, conditionally and attributed", async () => {
    const synced = syncedLocalNote("n1");
    const edited = {
      ...synced,
      content: "<p>carrots and leeks</p>",
      modified: 2000,
      version: 2,
      synced: false,
    };
    mockNoteStore.set("n1", edited);

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [edited]);

    expect(result.uploaded.notes.uploadedIds).toEqual(["n1"]);
    const stored = readAlice(aliceNotePath("n1"));
    expect(stored.content).toBe("<p>carrots and leeks</p>");
    expect(stored.lastModifiedBy).toBe("bob");
    const put = bob.requests.find((r) => r.method === "PUT" && r.path.endsWith("/n1.json"));
    expect(put.headers["If-Match"]).toBeTruthy();
    // The uploaded text becomes the next merge baseline
    expect(result.uploaded.notes.metadata.n1.baseContent).toBe("<p>carrots and leeks</p>");
  });

  it("uploads a note the collaborator created", async () => {
    const created = {
      id: "n-new",
      notebookId: NOTEBOOK,
      title: "Cake",
      content: "<p>sugar</p>",
      modified: 3000,
      version: 1,
      synced: false,
      lastSyncedEtag: null,
    };
    mockNoteStore.set("n-new", created);

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [created]);

    expect(result.uploaded.notes.uploadedIds).toEqual(["n-new"]);
    expect(readAlice(aliceNotePath("n-new")).title).toBe("Cake");
  });

  it("uploads a note's media into a media folder it creates", async () => {
    const withMedia = {
      id: "n-media",
      notebookId: NOTEBOOK,
      title: "Photo",
      modified: 3000,
      version: 1,
      synced: false,
      lastSyncedEtag: null,
      media: [{ id: "m1", fileId: "f1", type: "image" }],
    };
    mockNoteStore.set("n-media", withMedia);

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [withMedia]);

    expect(result.uploaded.notes.uploadedIds).toEqual(["n-media"]);
    expect([...alice.files.keys()].some((p) => p.includes(`/notes/n-media_media/f1`))).toBe(true);
  });

  it("never creates the notebook's own folders", async () => {
    const edited = { ...syncedLocalNote("n1"), modified: 2000, version: 2, synced: false };
    mockNoteStore.set("n1", edited);

    await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [edited]);

    const mkcols = bob.requests.filter((r) => r.method === "MKCOL").map((r) => r.path);
    expect(mkcols).not.toContain(MOUNT);
    expect(mkcols).not.toContain(`${MOUNT}/notes`);
  });

  it("never issues a DELETE or writes a tombstone, even when media was removed from a note", async () => {
    alice.seedMedia(NOTEBOOK, "n1", "old-file");
    const stale = { id: "n1", notebookId: NOTEBOOK, modified: 2000, version: 2, synced: false };
    mockNoteStore.set("n1", {
      ...stale,
      title: "Soup",
      content: "<p>carrots</p>",
      media: [],
      deletedMedia: ["old-file"],
    });

    await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [
      { ...stale, lastSyncedEtag: "x" },
    ]);

    expect(bob.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(writes(bob).some((r) => r.path.includes("_tombstones"))).toBe(false);
    // The orphaned binary stays until the sharer's client cleans it up
    expect([...alice.files.keys()].some((p) => p.endsWith("/old-file.bin"))).toBe(true);
  });

  it("uploads a rename of the notebook without any sharing field", async () => {
    const renamed = localNotebook({ title: "Family recipes", modified: 3000, synced: false });
    renamed.lastSyncedEtag = alice.files.get(`/NoteBerg/notebooks/${NOTEBOOK}/_notebook.json`).etag;

    const result = await syncSharedNotebook(renamed, []);

    expect(result.uploaded.notebooks.uploadedIds).toEqual([NOTEBOOK]);
    const stored = readAlice(`/NoteBerg/notebooks/${NOTEBOOK}/_notebook.json`);
    expect(stored.title).toBe("Family recipes");
    for (const field of ["origin", "remoteBasePath", "sharePermissions", "ownerUid", "shareId"]) {
      expect(stored).not.toHaveProperty(field);
    }
  });

  it("merges instead of overwriting when the sharer edited the same note meanwhile", async () => {
    const synced = syncedLocalNote("n1");
    // The sharer edits after bob's last sync...
    const current = readAlice(aliceNotePath("n1"));
    alice.files.set(aliceNotePath("n1"), {
      content: JSON.stringify({
        ...current,
        content: "<p>carrots</p><p>from alice</p>",
        modified: 1500,
        version: 2,
      }),
      etag: "alice-edit",
      mtime: new Date(),
    });
    // ...while bob edited a different block locally
    const edited = {
      ...synced,
      content: "<p>CARROTS</p>",
      modified: 2000,
      version: 2,
      synced: false,
    };
    mockNoteStore.set("n1", edited);

    await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [edited]);

    const stored = readAlice(aliceNotePath("n1"));
    expect(stored.content).toContain("from alice");
    expect(stored.content).toContain("CARROTS");
  });

  it("heals a note missing on the server by uploading it again", async () => {
    const synced = syncedLocalNote("n2");
    mockNoteStore.set("n2", synced);
    alice.files.delete(aliceNotePath("n2"));

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [synced]);

    expect(result.uploaded.notes.uploadedIds).toEqual(["n2"]);
    expect(alice.files.has(aliceNotePath("n2"))).toBe(true);
  });

  it("keeps an unsynced edit when the server refuses the write (permissions changed underneath)", async () => {
    // The client still believes it may edit; the server has reduced the share
    nc.dav("bob").setMountPermissions(share.id, 1);
    const edited = { ...syncedLocalNote("n1"), content: "<p>x</p>", modified: 2000, synced: false };
    mockNoteStore.set("n1", edited);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [edited]);

    expect(result.uploaded.notes.failed).toBe(1);
    expect(result.uploaded.notes.uploadedIds).toEqual([]);
    expect(readAlice(aliceNotePath("n1")).content).toBe("<p>carrots</p>");
    error.mockRestore();
  });
});

describe("a read-only recipient", () => {
  beforeEach(async () => {
    clearSharedNotebookBases();
    bob.removeMount(share.id);
    nc.shares.delete(share.id);
    await shareWithBob(1);
  });

  it("downloads new and changed notes", async () => {
    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "stale" }), []);
    expect(result.downloaded.notes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
  });

  it("never issues a write request of any kind", async () => {
    const dirty = {
      ...syncedLocalNote("n1"),
      content: "<p>sneaky</p>",
      modified: 2000,
      synced: false,
    };
    mockNoteStore.set("n1", dirty);

    await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x", synced: false }), [dirty]);

    expect(writes(bob)).toEqual([]);
  });

  it("strands a locally changed note and does not overwrite it with the remote copy", async () => {
    const dirty = {
      ...syncedLocalNote("n1"),
      content: "<p>mine</p>",
      modified: 2000,
      synced: false,
    };
    // The sharer also changed it
    const current = readAlice(aliceNotePath("n1"));
    alice.files.set(aliceNotePath("n1"), {
      content: JSON.stringify({ ...current, content: "<p>theirs</p>", modified: 3000, version: 2 }),
      etag: "newer",
      mtime: new Date(),
    });

    const result = await syncSharedNotebook(localNotebook(), [dirty]);

    expect(result.strandedNoteIds).toEqual(["n1"]);
    expect(result.downloaded.notes.map((n) => n.id)).not.toContain("n1");
    expect(result.notesToUpload).toEqual([]);
  });

  it("does not mark notes for re-upload when their media is missing on the server", async () => {
    const synced = {
      ...syncedLocalNote("n1"),
      media: [{ id: "m1", fileId: "f-missing", type: "image" }],
    };

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [synced]);

    expect(result.strandedNoteIds).toEqual([]);
    expect(writes(bob)).toEqual([]);
  });

  it("is treated as read-only when only UPDATE (no CREATE) is granted", async () => {
    clearSharedNotebookBases();
    bob.removeMount(share.id);
    nc.shares.delete(share.id);
    await shareWithBob(3);
    const dirty = { ...syncedLocalNote("n1"), content: "<p>x</p>", modified: 2000, synced: false };

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [dirty]);

    expect(result.strandedNoteIds).toEqual(["n1"]);
    expect(writes(bob)).toEqual([]);
  });
});

describe("permission drop: collaborator becomes read-only", () => {
  it("strands the notes that held unsynced changes", async () => {
    const dirty = { ...syncedLocalNote("n1"), content: "<p>x</p>", modified: 2000, synced: false };
    const clean = syncedLocalNote("n2");

    // The discovery pass has stored the reduced permissions on the record
    const result = await syncSharedNotebook(
      localNotebook({ sharePermissions: 1, lastSyncedEtag: "x" }),
      [dirty, clean],
    );

    expect(result.strandedNoteIds).toEqual(["n1"]);
    expect(writes(bob)).toEqual([]);
  });

  it("takes the owner's notebook back over a rename it can no longer upload", async () => {
    // Renamed while writing was allowed, unsynced when the share became view only;
    // the owner has not touched the notebook since
    const etag = alice.files.get(`/NoteBerg/notebooks/${NOTEBOOK}/_notebook.json`).etag;
    const renamed = localNotebook({
      title: "Family recipes",
      modified: 3000,
      synced: false,
      sharePermissions: 1,
      lastSyncedEtag: etag,
    });

    const result = await syncSharedNotebook(renamed, []);

    expect(writes(bob)).toEqual([]);
    // Downloaded, so the record is in step with the owner again (not unsynced for good)
    expect(result.downloaded.notebooks).toEqual([
      expect.objectContaining({ id: NOTEBOOK, title: "Recipes" }),
    ]);
    expect(result.downloaded.notebooks[0].synced).not.toBe(false);
  });

  it("lets stranded notes through normal classification again once writing is allowed", async () => {
    const dirty = { ...syncedLocalNote("n1"), content: "<p>x</p>", modified: 2000, synced: false };
    mockNoteStore.set("n1", dirty);

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [dirty]);

    expect(result.strandedNoteIds).toEqual([]);
    expect(result.uploaded.notes.uploadedIds).toEqual(["n1"]);
  });
});

describe("the sharer purges a note", () => {
  beforeEach(() => {
    alice.files.delete(aliceNotePath("n1"));
    alice.seedTombstone(NOTEBOOK, { notes: [{ id: "n1", deletedAt: Date.now() }], media: [] });
  });

  it("beats the recipient's unsynced edit: stranded, not resurrected", async () => {
    const dirty = {
      id: "n1",
      notebookId: NOTEBOOK,
      content: "<p>edited offline</p>",
      modified: 2000,
      synced: false,
      lastSyncedEtag: "e-old",
    };
    mockNoteStore.set("n1", dirty);

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [dirty]);

    expect(result.strandedNoteIds).toEqual(["n1"]);
    expect(result.notesToDelete).toEqual([]);
    expect(result.notesToUpload).toEqual([]);
    expect(alice.files.has(aliceNotePath("n1"))).toBe(false);
    expect(writes(bob)).toEqual([]);
  });

  it("removes a clean local copy", async () => {
    const clean = {
      id: "n1",
      notebookId: NOTEBOOK,
      modified: 1000,
      synced: true,
      lastSyncedEtag: "e",
    };

    const result = await syncSharedNotebook(localNotebook({ lastSyncedEtag: "x" }), [clean]);

    expect(result.notesToDelete).toEqual(["n1"]);
    expect(result.strandedNoteIds).toEqual([]);
  });
});

describe("the own pass", () => {
  it("never sees a shared notebook: its notes are not 'missing' in /NoteBerg", async () => {
    bob.seedNotebook("own1", { title: "Mine" });
    bob.seedNote("own1", { id: "own-note", notebookId: "own1", content: "x", modified: 1 });

    // The caller (sync.js) hands the own pass only what is own
    const result = await fullSync(
      [{ id: "own1", title: "Mine", modified: 1, synced: true, lastSyncedEtag: null }],
      [],
    );

    expect(result.downloaded.notebooks.map((n) => n.id)).toEqual(["own1"]);
    expect([...bob.files.keys()].filter((p) => p.includes(NOTEBOOK))).toEqual([]);
    expect(bob.requests.filter((r) => r.path.startsWith(MOUNT))).toEqual([]);
  });

  it("is unchanged when no share exists at all", async () => {
    clearSharedNotebookBases();
    const lone = new MockNextcloud();
    lone.addUser("bob");
    wireMockNextcloud(fetch, lone);
    lone.dav("bob").seedNotebook("own1", { title: "Mine" });

    const result = await fullSync([], []);

    expect(result.downloaded.notebooks.map((n) => n.id)).toEqual(["own1"]);
    expect(
      lone.dav("bob").requests.every((r) => r.path.startsWith("/NoteBerg") || r.path === "/"),
    ).toBe(true);
    expect(result.strandedNoteIds).toEqual([]);
  });
});
