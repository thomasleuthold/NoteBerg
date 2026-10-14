/**
 * Known-content backup archive for e2e seeding.
 *
 * Built in the archive layout (backup_restore_design.md §3), so restoring it is
 * the supported way to put a known corpus into the app — no dependency on the
 * IndexedDB schema beyond what restore itself guarantees.
 *
 *   Notebook "Work Projects" (nb-work)
 *     └ "Roadmap"   typed text + one image            (note-roadmap)
 *   Notebook "Home" (nb-home)
 *     └ "Old plans" in the recycle bin                (note-old)
 *   Quick notes
 *     ├ "Groceries" typed text                        (note-groceries)
 *     └ "Sketch"    two strokes                       (note-sketch)
 *
 * Timestamps are fixed so tests are deterministic. `overrides` patches notes by
 * id, e.g. to make a backup newer than what is already in the app.
 */

export const BASE_TIME = 1_750_000_000_000;

/** A 1x1 PNG. */
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const IDS = {
  notebooks: { work: "nb-work", home: "nb-home" },
  notes: {
    roadmap: "note-roadmap",
    old: "note-old",
    groceries: "note-groceries",
    sketch: "note-sketch",
  },
  file: "file-pixel",
};

const stroke = (id, points) => ({
  id,
  x: points.map((p) => p[0]),
  y: points.map((p) => p[1]),
  pressure: points.map(() => 0.5),
  time: points.map((_, i) => BASE_TIME + i * 10),
  colorIndex: 0,
  width: 2,
  pointerType: "pen",
  type: "pen",
});

function note({ id, notebookId = null, title, ...rest }) {
  return {
    id,
    notebookId,
    title,
    content: "",
    strokes: [],
    media: [],
    deletedMedia: [],
    formatVersion: 1,
    background: "none",
    created: BASE_TIME,
    modified: BASE_TIME,
    version: 3,
    deleted: false,
    tags: [],
    tasks: [],
    penPresets: null,
    pdfSource: null,
    recognition: null,
    deletedStrokes: [],
    recordings: [],
    deletedRecordings: [],
    ...rest,
  };
}

function notebook({ id, title, description = "", color = "#3b82f6", ...rest }) {
  return {
    id,
    title,
    description,
    color,
    created: BASE_TIME,
    modified: BASE_TIME,
    version: 2,
    deleted: false,
    ...rest,
  };
}

const notePath = (n) =>
  n.notebookId ? `notebooks/${n.notebookId}/notes/${n.id}` : `quickNotes/${n.id}`;

/**
 * @param {{ notes?: Record<string, object> }} [options] per-note field overrides, by note id
 * @returns {Record<string, {text: string} | {base64: string}>} archive entries
 */
export function buildCorpus({ notes: overrides = {} } = {}) {
  const notebooks = [
    notebook({ id: IDS.notebooks.work, title: "Work Projects", color: "#ef4444" }),
    notebook({ id: IDS.notebooks.home, title: "Home" }),
  ];

  const notes = [
    note({
      id: IDS.notes.roadmap,
      notebookId: IDS.notebooks.work,
      title: "Roadmap",
      content: "<p>Ship the restore tests</p>",
      media: [
        {
          id: "media-pixel",
          type: "image",
          fileId: IDS.file,
          x: 100,
          y: 100,
          width: 64,
          height: 64,
          rotation: 0,
        },
      ],
    }),
    note({
      id: IDS.notes.old,
      notebookId: IDS.notebooks.home,
      title: "Old plans",
      deleted: true,
    }),
    note({ id: IDS.notes.groceries, title: "Groceries", content: "<p>Milk and eggs</p>" }),
    note({
      id: IDS.notes.sketch,
      title: "Sketch",
      strokes: [
        stroke("stroke-1", [
          [100, 100],
          [200, 150],
          [300, 100],
        ]),
        stroke("stroke-2", [
          [100, 300],
          [300, 300],
        ]),
      ],
    }),
  ].map((n) => ({ ...n, ...overrides[n.id] }));

  const entries = {};
  const add = (name, value) => {
    entries[name] = { text: JSON.stringify(value, null, 2) };
  };

  for (const nb of notebooks) add(`notebooks/${nb.id}/_notebook.json`, nb);
  for (const n of notes) add(`${notePath(n)}.json`, n);
  entries[`${notePath(notes[0])}_media/${IDS.file}.png`] = { base64: PIXEL_PNG_BASE64 };

  const byteSize = (e) => (e.text !== undefined ? new TextEncoder().encode(e.text).length : 68);
  entries["manifest.json"] = {
    text: JSON.stringify({
      schema: 1,
      appVersion: "e2e",
      dbVersion: 5,
      createdAt: BASE_TIME,
      encrypted: false,
      counts: { notebooks: notebooks.length, notes: notes.length, files: 1 },
      totalBytes: Object.values(entries).reduce((n, e) => n + byteSize(e), 0),
    }),
  };

  return entries;
}
