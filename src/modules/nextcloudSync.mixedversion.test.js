/**
 * src/modules/nextcloudSync.mixedversion.test.js
 *
 * Devices of one account are not updated at the same time. This is the sync of
 * the current app against what an older app (before versioned elements) leaves
 * on the server; the older app's behaviour is recorded from `main` in
 * __fixtures__/olderApp.main.golden.json, not modelled by hand.
 *
 * Re-recording (see nextcloudSync.equivalence.test.js for the steps):
 *   RECORD_OLDER_APP_GOLDEN=<path> npx vitest run src/modules/nextcloudSync.mixedversion.test.js
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetch } from "@tauri-apps/plugin-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { NEWER_APP_NOTE, runOlderAppRoundTrip } from "./__fixtures__/syncScenarios.js";
import { fullSync } from "./nextcloudSync.js";

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

vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  saveFile: vi.fn(async () => "file-id"),
  getFile: vi.fn(async () => new Blob(["test"], { type: "text/plain" })),
  checkFileExists: vi.fn(async () => false),
  deleteFile: vi.fn(async () => {}),
  permanentlyDeleteNote: vi.fn(),
  permanentlyDeleteNotebook: vi.fn(),
  permanentlyDeleteNotesInNotebook: vi.fn(),
  getSetting: vi.fn(async () => null),
  getStorageVersion: vi.fn(async () => 1),
  isLocalEncryptionEnabled: vi.fn(async () => false),
  initStorage: vi.fn(async () => {}),
  updateNote: vi.fn(async () => {}),
  saveNote: vi.fn(async () => {}),
  getNote: vi.fn(async () => null),
  getRawNote: vi.fn(async () => null),
}));

const GOLDEN_PATH = join(process.cwd(), "src/modules/__fixtures__/olderApp.main.golden.json");
const recording = Boolean(process.env.RECORD_OLDER_APP_GOLDEN);

function newServer() {
  const server = new MockWebDAVServer();
  wireMockServer(fetch, server);
  return server;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
  secrets.clear();
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: "https://cloud.example.com",
      loginName: "testuser",
      appPassword: "app-password-123",
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recording of the older app", () => {
  it.runIf(recording)("writes what the older app leaves on the server", async () => {
    const trip = await runOlderAppRoundTrip({ newServer, fullSync });
    writeFileSync(process.env.RECORD_OLDER_APP_GOLDEN, `${JSON.stringify(trip, null, 2)}\n`);
  });

  it.skipIf(recording)("is the round trip of the story below", () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
    expect(golden.onServerBefore).toEqual(NEWER_APP_NOTE);
  });
});

// ─── The current app syncing after the older app ──────────────────────────────

const NB = "nb1";
const NOTE_PATH = `/NoteBerg/notebooks/${NB}/notes/n1.json`;

const stroke = (id, x, v) => ({
  id,
  time: [x],
  x: [x, x + 1],
  y: [x, x + 2],
  pressure: [0.5, 0.5],
  ...(v ? { v } : {}),
});

/**
 * The older app has uploaded its edit (recorded from `main`); this app, which
 * had the note as the newer app wrote it, has edits of its own and syncs.
 * `modified` decides which side's edit is the more recent one.
 */
async function currentAppSyncs({ modified }) {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
  const server = newServer();
  server.seedNotebook(NB, { title: "Work", modified: 10 });
  server.seedNote(NB, golden.onServerAfter);
  const notebook = {
    id: NB,
    title: "Work",
    created: 1,
    modified: 10,
    synced: true,
    lastSyncedEtag: server.files.get(`/NoteBerg/notebooks/${NB}/_notebook.json`).etag,
  };

  // What this app holds: the note as it last synced, plus its own edits
  const mine = {
    ...NEWER_APP_NOTE,
    title: "Meeting (renamed by the current app)",
    content: "<p>Agenda</p><p>from the current app</p>",
    strokes: [
      ...NEWER_APP_NOTE.strokes.filter((s) => s.id !== "s4"),
      stroke("new-e", 7, "0000000b0-000-devnew"),
    ],
    deletedStrokes: ["s3", "s4"],
    tombstones: { ...NEWER_APP_NOTE.tombstones, s4: "0000000b1-000-devnew" },
    fieldVersions: {
      title: "0000000b3-000-devnew",
      content: "0000000b2-000-devnew",
    },
    modified,
    version: 6,
    synced: false,
    lastSyncedEtag: "etag-the-note-had-when-last-synced",
  };

  const result = await fullSync([notebook], [mine]);
  const onServer = JSON.parse(server.files.get(NOTE_PATH).content);
  return { result, onServer, server, notebook, mine };
}

describe.skipIf(recording).each([
  ["the current app's edit is the more recent", 4000],
  ["the older app's edit is the more recent", 2500],
])("the current app syncs after the older app, and %s", (_label, modified) => {
  it("merges without a conflict and uploads the result", async () => {
    const { result } = await currentAppSyncs({ modified });
    expect(result.conflicts.notes).toHaveLength(0);
    expect(result.uploaded.notes.uploaded).toBe(1);
  });

  it("keeps what both added, and what neither deleted", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    const ids = onServer.strokes.map((s) => s.id).sort();
    // old-d: drawn by the older app (no version stamp). new-e: drawn here. s2: untouched by both
    expect(ids).toEqual(["new-e", "old-d", "s2"]);
  });

  it("deletes what either side erased, the older app's erasure included", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    // s1: erased by the older app, which only knows `deletedStrokes`. s4: erased here.
    // s3: erased earlier by the newer app
    expect(onServer.strokes.map((s) => s.id)).not.toContain("s1");
    expect(onServer.strokes.map((s) => s.id)).not.toContain("s4");
    expect(onServer.strokes.map((s) => s.id)).not.toContain("s3");
  });

  it("writes erasures where both generations of the app read them", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    // The older app reads `deletedStrokes`, this one reads `tombstones` too:
    // every erased stroke is in the list, so neither brings it back
    for (const id of ["s1", "s3", "s4"]) {
      expect(onServer.deletedStrokes).toContain(id);
    }
    for (const id of Object.keys(onServer.tombstones ?? {})) {
      expect(onServer.deletedStrokes).toContain(id);
    }
  });

  it("keeps the text both sides added", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    expect(onServer.content).toContain("from the older app");
    expect(onServer.content).toContain("from the current app");
  });

  // KNOWN GAP (DESIGN §10.7 H): an older app moves a stroke and leaves its version
  // stamp as it was. Both copies then carry the same stamp, and the merge cannot
  // tell which one was changed: it keeps the older note's copy, whichever that
  // is. The stroke itself is never lost or doubled, only its position may be the
  // old one. Telling them apart would need a fingerprint of the drawing stored
  // with every stroke.
  it("keeps exactly one copy of a stroke the older app moved without a new stamp", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    const copies = onServer.strokes.filter((s) => s.id === "s2");
    expect(copies).toHaveLength(1);
    // Moved by 100 in the older app (x 102), or as this app had it (x 2)
    expect([2, 102]).toContain(copies[0].x[0]);
  });

  it("settles on one of the two titles", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    expect([
      "Meeting (renamed by the older app)",
      "Meeting (renamed by the current app)",
    ]).toContain(onServer.title);
  });

  it("leaves the file readable by the older app", async () => {
    const { onServer } = await currentAppSyncs({ modified });
    // What the older app needs to open a note and draw it
    expect(onServer).toMatchObject({ id: "n1", notebookId: NB });
    expect(Array.isArray(onServer.strokes)).toBe(true);
    for (const s of onServer.strokes) {
      expect([s.id, Array.isArray(s.x), Array.isArray(s.y)]).toEqual([s.id, true, true]);
    }
    expect(typeof onServer.content).toBe("string");
    expect(onServer.version).toBeGreaterThan(golden().onServerAfter.version);
  });

  it("settles: the next sync finds nothing to do, and a second device gets the same note", async () => {
    const { server, notebook, onServer } = await currentAppSyncs({ modified });
    const synced = {
      ...onServer,
      synced: true,
      lastSyncedEtag: server.files.get(NOTE_PATH).etag,
    };

    const again = await fullSync([notebook], [synced]);
    expect(again.uploaded.notes.uploaded).toBe(0);
    expect(again.downloaded.notes).toHaveLength(0);

    const other = await fullSync([notebook], []);
    const theirs = other.downloaded.notes.find((n) => n.id === "n1");
    expect(theirs.strokes.map((s) => s.id).sort()).toEqual(
      onServer.strokes.map((s) => s.id).sort(),
    );
    expect(theirs.content).toBe(onServer.content);
    expect(theirs.title).toBe(onServer.title);
  });
});

function golden() {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
}
