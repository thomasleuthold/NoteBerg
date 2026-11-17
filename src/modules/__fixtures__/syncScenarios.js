/**
 * The sync story that nextcloudSync.equivalence.test.js records and compares.
 *
 * One account, one server, several syncs in a row: first upload, nothing to do,
 * a download, a merge of both sides' edits, deletions. Each step is recorded as
 * the requests it made. Written with nothing but what a build without
 * notebook sharing also has (fullSync, the mock WebDAV server), so the same file
 * can be run on `main` to record what the released app does.
 */

const stroke = (id, x) => ({ id, time: [x], x: [x, x + 1], y: [x, x + 2], pressure: [0.5, 0.5] });

const NB = "nb1";
const notePath = (id) => `/NoteBerg/notebooks/${NB}/notes/${id}.json`;
const notebookPath = `/NoteBerg/notebooks/${NB}/_notebook.json`;

/** A local copy of what the server holds for a file, as the app stores it after a sync. */
function synced(local, server, path) {
  return { ...local, synced: true, lastSyncedEtag: server.files.get(path).etag };
}

/** The requests since `from`, reduced to what a build without sharing must still send. */
function seen(server, from) {
  return server.requests.slice(from).map((r) => {
    const h = Object.fromEntries(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const entry = {
      method: r.method,
      path: r.path,
      depth: h.depth ?? null,
      conditional: [h["if-match"] ? "if-match" : null, h["if-none-match"] ? "if-none-match" : null]
        .filter(Boolean)
        .join(","),
      contentType: h["content-type"] ?? null,
    };
    if (r.method === "PROPFIND") entry.propfind = r.body ?? null;
    if (r.method === "PUT" && r.path.endsWith(".json") && typeof r.body === "string") {
      try {
        entry.json = JSON.parse(r.body);
      } catch {
        entry.json = null;
      }
    }
    return entry;
  });
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.newServer - a fresh mock server, wired to fetch
 * @param {Function} ctx.fullSync
 * @param {Function} ctx.hasRemoteChanges
 * @returns {Promise<Array<{step: string, requests: object[], summary: object}>>}
 */
export async function runStory({ newServer, fullSync, hasRemoteChanges }) {
  const server = newServer();
  const steps = [];
  let mark = 0;
  const record = (step, summary) => {
    steps.push({ step, requests: seen(server, mark), summary });
    mark = server.requests.length;
  };
  const counts = (r) => ({
    uploadedNotes: r.uploaded.notes.uploaded,
    uploadedNotebooks: r.uploaded.notebooks.uploaded,
    downloadedNotes: r.downloaded.notes.map((n) => n.id).sort(),
    downloadedNotebooks: r.downloaded.notebooks.map((n) => n.id).sort(),
    notesToDelete: [...(r.notesToDelete ?? [])].sort(),
    conflicts: r.conflicts.notes.length,
  });

  let notebook = {
    id: NB,
    title: "Work",
    color: "#336699",
    created: 1,
    modified: 10,
    synced: false,
  };
  let n1 = {
    id: "n1",
    notebookId: NB,
    title: "Meeting",
    content: "<p>Agenda</p>",
    strokes: [stroke("s1", 1), stroke("s2", 2)],
    deletedStrokes: [],
    media: [],
    created: 1,
    modified: 20,
    version: 1,
    synced: false,
  };
  let n2 = {
    id: "n2",
    notebookId: NB,
    title: "Todo",
    content: "<p>Milk</p>",
    strokes: [],
    deletedStrokes: [],
    media: [],
    created: 1,
    modified: 30,
    version: 1,
    synced: false,
  };
  let quick = {
    id: "q1",
    notebookId: null,
    title: "Quick",
    content: "<p>Idea</p>",
    strokes: [stroke("q-s1", 5)],
    deletedStrokes: [],
    media: [],
    created: 1,
    modified: 40,
    version: 1,
    synced: false,
  };

  // 1. First sync: everything is new and goes up
  let r = await fullSync([notebook], [n1, n2, quick]);
  record("first sync uploads everything", counts(r));
  notebook = synced(notebook, server, notebookPath);
  n1 = synced(n1, server, notePath("n1"));
  n2 = synced(n2, server, notePath("n2"));
  quick = synced(quick, server, "/NoteBerg/quickNotes/q1.json");

  // 2. Nothing changed anywhere
  r = await fullSync([notebook], [n1, n2, quick]);
  record("second sync finds nothing to do", counts(r));

  // 3. The cheap change check of a notebook
  const changed = await hasRemoteChanges(NB, [n1, n2]);
  record("change check of an unchanged notebook", { changed });

  // 4. Another device adds a stroke to n1; this device downloads it
  const remote1 = JSON.parse(server.files.get(notePath("n1")).content);
  server.seedNote(
    NB,
    {
      ...remote1,
      strokes: [...remote1.strokes, stroke("s3-remote", 3)],
      modified: 50,
      version: 2,
    },
    {},
  );
  const changedNow = await hasRemoteChanges(NB, [n1, n2]);
  record("change check after another device's edit", { changed: changedNow });
  r = await fullSync([notebook], [n1, n2, quick]);
  record("download of another device's edit", counts(r));
  n1 = {
    ...n1,
    strokes: [...n1.strokes, stroke("s3-remote", 3)],
    modified: 50,
    version: 2,
    synced: true,
    lastSyncedEtag: server.files.get(notePath("n1")).etag,
  };

  // 5. Both devices edit n2: this one adds a stroke, the other changes the text
  const remote2 = JSON.parse(server.files.get(notePath("n2")).content);
  server.seedNote(
    NB,
    { ...remote2, content: "<p>Milk</p><p>Bread</p>", modified: 60, version: 2 },
    {},
  );
  n2 = {
    ...n2,
    strokes: [stroke("s4-local", 4)],
    modified: 70,
    version: 2,
    synced: false,
  };
  r = await fullSync([notebook], [n1, n2, quick]);
  record("both devices edited the same note", counts(r));
  n2 = {
    ...n2,
    synced: true,
    lastSyncedEtag: server.files.get(notePath("n2")).etag,
  };

  // 6. A note goes to the recycle bin here
  n1 = { ...n1, deleted: true, deletedAt: 80, modified: 80, version: 3, synced: false };
  r = await fullSync([notebook], [n1, n2, quick]);
  record("a note is moved to the recycle bin", counts(r));
  n1 = synced(n1, server, notePath("n1"));

  // 7. ... and purged for good
  n1 = { id: "n1", notebookId: NB, purged: true, deleted: true, synced: false };
  r = await fullSync([notebook], [n1, n2, quick]);
  record("a note is purged", counts(r));

  // 8. Another device purges n2: the tombstone reaches this device
  server.seedTombstone(NB, {
    notes: [{ id: "n2", deletedAt: 90 }],
    notebooks: [],
  });
  server.files.delete(notePath("n2"));
  r = await fullSync([notebook], [n2, quick]);
  record("another device purged a note", counts(r));

  return steps;
}

// ─── An older app and a newer one on the same account ─────────────────────────

/**
 * A note as an app with versioned elements writes it: every stroke has a version
 * stamp, an erased stroke is in `tombstones`, and `shifts` and `fieldVersions`
 * are there. (The stamps have the shape hlc.js makes: time, counter, device.)
 */
export const NEWER_APP_NOTE = {
  id: "n1",
  notebookId: NB,
  title: "Meeting",
  content: "<p>Agenda</p>",
  strokes: [
    { ...stroke("s1", 1), v: "0000000a0-000-devnew" },
    { ...stroke("s2", 2), v: "0000000a1-000-devnew" },
    { ...stroke("s4", 4), v: "0000000a2-000-devnew", seen: { devnew: "0000000a5-000-devnew" } },
  ],
  deletedStrokes: ["s3"],
  tombstones: { s3: "0000000a3-000-devnew" },
  shifts: [{ y: 100, delta: 50, v: "0000000a5-000-devnew" }],
  fieldVersions: { title: "0000000a0-000-devnew", content: "0000000a4-000-devnew" },
  media: [],
  tasks: [],
  recordings: [],
  deletedRecordings: [],
  created: 1,
  modified: 2000,
  version: 5,
};

/**
 * What an app without versioned elements (main, before this work) does with a
 * note the newer app wrote: it downloads it, the user draws a stroke, erases
 * another and adds a paragraph, and it uploads the result. The server's state
 * after that is what the newer app finds the next time it syncs.
 *
 * Run on `main`, this records what the released app really leaves behind; the
 * newer app's tests (nextcloudSync.mixedversion.test.js) start from it.
 * @returns {Promise<{onServerBefore: object, downloadedByApp: object, onServerAfter: object}>}
 */
export async function runOlderAppRoundTrip({ newServer, fullSync }) {
  const server = newServer();
  server.seedNotebook(NB, { title: "Work", modified: 10 });
  server.seedNote(NB, NEWER_APP_NOTE);
  const notebook = {
    id: NB,
    title: "Work",
    created: 1,
    modified: 10,
    synced: true,
    lastSyncedEtag: server.files.get(notebookPath).etag,
  };

  const first = await fullSync([notebook], []);
  const downloaded = first.downloaded.notes.find((n) => n.id === "n1");
  const downloadedByApp = JSON.parse(JSON.stringify(downloaded));

  // It knows nothing of versions: a moved stroke keeps its stamp, a new one has
  // none, an erased one only goes into `deletedStrokes`, a new title has no stamp
  const moved = (s) => (s.id === "s2" ? { ...s, x: s.x.map((x) => x + 100) } : s);
  const edited = {
    ...downloaded,
    title: "Meeting (renamed by the older app)",
    strokes: [...downloaded.strokes.filter((s) => s.id !== "s1").map(moved), stroke("old-d", 9)],
    deletedStrokes: [...(downloaded.deletedStrokes ?? []), "s1"],
    content: `${downloaded.content}<p>from the older app</p>`,
    modified: 3000,
    version: (downloaded.version ?? 0) + 1,
    synced: false,
    lastSyncedEtag: server.files.get(notePath("n1")).etag,
  };
  await fullSync([notebook], [edited]);

  return {
    onServerBefore: NEWER_APP_NOTE,
    downloadedByApp,
    onServerAfter: JSON.parse(server.files.get(notePath("n1")).content),
  };
}
