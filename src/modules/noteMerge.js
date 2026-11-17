/**
 * Note merge: pure, storage- and network-free (DESIGN §10.7).
 *
 * The one place two versions of a note are combined: the native sync
 * (nextcloudSync.js, sync.js), the Nextcloud app's write path
 * (storage.webdav.js), the open editor taking in a stored version (NoteCanvas)
 * and the native storage worker's saves. Every field merges on its own, so a
 * text divergence never costs the other side its strokes, media or tasks.
 *
 * Elements (strokes, media, tasks, recordings) merge one by one:
 *  - an id on one side only is kept
 *  - an id deleted on either side is deleted: delete wins over any concurrent
 *    change, unless the surviving copy explicitly restores that deletion (an
 *    undo, `restores` >= the deletion's stamp)
 *  - an id on both sides: the copy with the larger version `v` (hlc.js);
 *    copies without versions (notes written before versions) fall back to the
 *    newer note, as before
 * Scalar fields (title, background, pen presets, PDF source) take the value
 * with the larger stamp in `fieldVersions`. Insert-space operations recorded in
 * `shifts` are replayed on elements that had not seen them (normalize()).
 *
 * The result does not depend on which side is "local": merge(a, b) and
 * merge(b, a) give the same note, and merging a merge result again changes
 * nothing. The property tests in noteMerge.property.test.js hold it to that.
 * Merging never makes a stamp, so whoever merges gets the same result.
 */

import { stampDevice } from "./hlc.js";
import { mergeContent } from "./textMerge.js";

/** How each kind of element is stored, and what its deletions record. */
export const ELEMENT_KINDS = {
  strokes: { list: "strokes", deleted: "deletedStrokes", deadKey: (item) => item.id },
  media: { list: "media", deleted: "deletedMedia", deadKey: (item) => item.id },
  tasks: { list: "tasks", deleted: "deletedTasks", deadKey: (item) => item.id },
  // A deleted recording is recorded by its file
  recordings: { list: "recordings", deleted: "deletedRecordings", deadKey: (item) => item.fileId },
};

/** Fields that take the value with the larger stamp. */
export const SCALAR_FIELDS = ["title", "background", "penPresets", "pdfSource"];

/** Set on media items while a note is open (rendered PDF pages); never stored. */
const RUNTIME_MEDIA_FIELDS = [
  "renderable",
  "renderableScale",
  "loading",
  "error",
  "renderAttempts",
];

const list = (value) => (Array.isArray(value) ? value : []);
const keyOf = (item) => item.id ?? JSON.stringify(item);

/** Compare versions; a missing version is the lowest. */
function compareStamps(a, b) {
  const x = typeof a === "string" ? a : "";
  const y = typeof b === "string" ? b : "";
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Which of two notes counts as the newer one, for what has no version of its
 * own. The same answer from both sides: by `modified`, then `version`, then the
 * text, so neither side's "local" role decides.
 * @returns {boolean} whether `a` is the newer one
 */
function isNewerNote(a, b) {
  const byModified = (a.modified || 0) - (b.modified || 0);
  if (byModified !== 0) return byModified > 0;
  const byVersion = (a.version || 0) - (b.version || 0);
  if (byVersion !== 0) return byVersion > 0;
  const ca = String(a.content ?? "");
  const cb = String(b.content ?? "");
  if (ca !== cb) return ca > cb;
  // A full tie (rare): the whole notes decide, so both sides still agree
  return JSON.stringify(a) >= JSON.stringify(b);
}

/** Whether an element has seen a recorded shift. */
function hasSeen(item, shift) {
  const device = stampDevice(shift.v);
  return compareStamps(item.seen?.[device], shift.v) >= 0;
}

/** Which of two `seen` records knows more: more devices, then larger stamps. */
function compareSeen(a = {}, b = {}) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return ka.length - kb.length;
  const ja = JSON.stringify(ka.sort().map((k) => a[k]));
  const jb = JSON.stringify(kb.sort().map((k) => b[k]));
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

/**
 * The deletion stamps of both sides, the larger per id. A deletion recorded
 * without a stamp (before versions) counts as the lowest.
 */
export function mergeTombstones(a = {}, b = {}) {
  const merged = { ...a };
  for (const [id, stamp] of Object.entries(b)) {
    if (compareStamps(stamp, merged[id]) > 0) merged[id] = stamp;
  }
  return merged;
}

/**
 * The version bookkeeping of a save laid over what storage holds: deletion
 * stamps and field stamps, the larger per key; recorded shifts, both sides'.
 * A save must never replace these, or it would forget the other side's.
 * @returns {object} only the fields either side has
 */
export function mergeVersionFields(stored = {}, incoming = {}) {
  const out = {};
  if (stored.tombstones || incoming.tombstones) {
    out.tombstones = mergeTombstones(stored.tombstones, incoming.tombstones);
  }
  if (stored.fieldVersions || incoming.fieldVersions) {
    out.fieldVersions = mergeTombstones(stored.fieldVersions, incoming.fieldVersions);
  }
  if (stored.shifts?.length || incoming.shifts?.length) {
    out.shifts = mergeShifts(stored.shifts, incoming.shifts);
  }
  return out;
}

/** Recorded shifts of both sides, by stamp, oldest first. */
export function mergeShifts(a, b) {
  const byStamp = new Map();
  for (const shift of [...list(a), ...list(b)]) {
    if (shift && typeof shift.v === "string") byStamp.set(shift.v, shift);
  }
  return Array.from(byStamp.values()).sort((x, y) => compareStamps(x.v, y.v));
}

/**
 * Merge one kind of element.
 * @param {"strokes"|"media"|"tasks"|"recordings"} kind
 * @param {{items: Array, deleted: Array, tombstones?: Object}} a
 * @param {{items: Array, deleted: Array, tombstones?: Object}} b
 * @param {{aIsNewer: boolean, tombstones?: Object}} context - which note is newer
 *   (for elements without versions) and the merged deletion stamps
 * @returns {{items: Array, deleted: Array}}
 */
export function mergeElements(kind, a, b, { aIsNewer, tombstones = {} }) {
  const { deadKey } = ELEMENT_KINDS[kind];
  const deleted = new Set([...list(a.deleted), ...list(b.deleted)]);
  const older = aIsNewer ? b : a;
  const newer = aIsNewer ? a : b;

  // key -> { item, index, restores } where index is the position in the side
  // it came from, and restores the largest deletion any copy undoes: an undo
  // counts whichever copy wins the element (a copy edited without having seen
  // the undo would otherwise take it away again)
  const chosen = new Map();
  const consider = (item, index, fromNewer) => {
    if (!item || (kind === "recordings" && item.deleted)) return;
    const key = keyOf(item);
    const current = chosen.get(key);
    if (!current) {
      chosen.set(key, { item, index, restores: item.restores });
      return;
    }
    if (compareStamps(item.restores, current.restores) > 0) current.restores = item.restores;
    const order = compareStamps(item.v, current.item.v);
    let takeThis = order > 0;
    if (order === 0 && typeof item.v !== "string") {
      // Neither copy has a version: as before versions, the newer note wins
      // (tasks: the newer note's copy unless it is older by its own clock)
      takeThis =
        fromNewer && (kind !== "tasks" || (item.modified || 0) >= (current.item.modified || 0));
    } else if (order === 0) {
      // The same edit; one copy may have checked more shifts already (normalize)
      takeThis = compareSeen(item.seen, current.item.seen) > 0;
    }
    // Same position as before: the older side's order, updated in place
    if (takeThis) chosen.set(key, { ...current, item });
  };
  for (const [i, item] of list(older.items).entries()) consider(item, i, false);
  for (const [i, item] of list(newer.items).entries()) consider(item, i, true);

  const alive = [];
  const restored = new Set();
  for (const entry of chosen.values()) {
    const dead = deadKey(entry.item);
    if (dead !== undefined && deleted.has(dead)) {
      const { restores } = entry;
      // An undo restores exactly the deletion it undid; a later deletion wins again
      if (typeof restores !== "string" || compareStamps(restores, tombstones[dead]) < 0) continue;
      restored.add(dead);
    }
    if (typeof entry.restores === "string" && entry.item.restores !== entry.restores) {
      entry.item = { ...entry.item, restores: entry.restores };
    }
    alive.push(entry);
  }

  if (kind === "strokes") {
    // Temporal order (handwriting recognition depends on it), then id
    alive.sort((x, y) => {
      const byTime = (x.item.time?.[0] ?? 0) - (y.item.time?.[0] ?? 0);
      return byTime !== 0 ? byTime : String(keyOf(x.item)) < String(keyOf(y.item)) ? -1 : 1;
    });
  } else if (kind === "media") {
    // Stacking order: the `z` key, then id (items from before `z`: their position)
    alive.sort((x, y) => {
      const byZ = (x.item.z ?? x.index) - (y.item.z ?? y.index);
      return byZ !== 0 ? byZ : String(x.item.id) < String(y.item.id) ? -1 : 1;
    });
  }

  return {
    items: alive.map((entry) => entry.item),
    deleted: Array.from(deleted).filter((id) => !restored.has(id)),
  };
}

/** A position moved by `delta`; rounded so that undoing and redoing a move lands on the same number. */
const shifted = (y, delta) => Math.round((y + delta) * 1e6) / 1e6;

/**
 * Replay recorded shifts on elements that had not seen them (§10.7 D): an
 * element whose top edge (a media item's `y`) is below a shift's line moves by
 * its delta. PDF pages never move.
 *
 * The result depends only on the element's own edit and the set of shifts, never
 * on the order in which shifts reached it, so merges of three or more versions
 * agree however they are grouped. The element as edited (its base) is recovered
 * from its version: a moved element's version is `<edit stamp>+<shift>+<shift>`,
 * the shifts applied since the edit. Every shift the edit had not seen is then
 * replayed on the base, oldest first. A shift the element already lists as
 * applied counts as applied whatever its `seen` says (versions written before
 * `seen` stopped changing). Its `seen` records what the edit had seen and is
 * left alone. A moved element's version grows by the shifts' stamps, so the
 * moved copy wins over the unmoved one wherever the two meet. Returns new
 * objects for changed elements only.
 * @param {"strokes"|"media"} kind
 * @param {Array} items
 * @param {Array} shifts - oldest first (mergeShifts)
 */
export function normalize(kind, items, shifts) {
  if (!shifts?.length) return items;
  const byStamp = new Map(shifts.map((shift) => [shift.v, shift]));
  const topOf = (y) => {
    if (kind !== "strokes") return typeof y === "number" ? y : Number.NaN;
    let top = Number.POSITIVE_INFINITY;
    for (const value of y) if (value < top) top = value;
    return top;
  };
  const move = (y, delta) =>
    kind === "strokes" ? y.map((value) => shifted(value, delta)) : shifted(y, delta);

  return items.map((item) => {
    if (kind === "media" && item.type === "pdf-page") return item;
    if (kind === "strokes" ? list(item.y).length === 0 : typeof item.y !== "number") return item;
    const [edit, ...applied] = typeof item.v === "string" ? item.v.split("+") : [undefined];
    // A shift this version names but the note does not hold: left as it is
    if (applied.some((stamp) => !byStamp.has(stamp))) return item;

    let y = item.y;
    for (const stamp of applied) y = move(y, -byStamp.get(stamp).delta);
    const done = new Set(applied);
    const nowApplied = [];
    for (const shift of shifts) {
      if (!done.has(shift.v) && hasSeen(item, shift)) continue;
      if (!(topOf(y) > shift.y)) continue;
      y = move(y, shift.delta);
      nowApplied.push(shift.v);
    }
    if (nowApplied.join("+") === applied.join("+")) return item;
    const v = nowApplied.length > 0 ? `${edit ?? ""}+${nowApplied.join("+")}` : edit;
    const out = { ...item, y };
    if (v === undefined || v === "") delete out.v;
    else out.v = v;
    return out;
  });
}

/**
 * A save that carries only the strokes storage has not confirmed
 * (`strokesPartial`, review P4, 4.9) laid over the strokes stored: merged by
 * element, as the native storage worker merges every save. Other updates pass
 * through unchanged.
 * @param {object} stored - the note as stored
 * @param {object} updates
 * @returns {object} updates whose `strokes` / `deletedStrokes` are whole lists
 */
export function resolvePartialStrokes(stored, updates) {
  if (!updates?.strokesPartial) return updates;
  const { strokesPartial: _partial, ...rest } = updates;
  const tombstones = mergeTombstones(stored?.tombstones, updates.tombstones);
  const shifts = mergeShifts(stored?.shifts, updates.shifts);
  const merged = mergeElements(
    "strokes",
    {
      items: list(updates.strokes),
      deleted: updates.deletedStrokes ?? list(stored?.deletedStrokes),
    },
    { items: list(stored?.strokes), deleted: list(stored?.deletedStrokes) },
    // Strokes written before versions: the editor's copy wins, as a save always did
    { aIsNewer: true, tombstones },
  );
  return {
    ...rest,
    strokes: normalize("strokes", merged.items, shifts),
    deletedStrokes: merged.deleted,
  };
}

/** Scalar fields: per field, the value with the larger stamp. */
function mergeScalars(a, b, aIsNewer) {
  const values = {};
  const fieldVersions = {};
  for (const field of SCALAR_FIELDS) {
    const va = a.fieldVersions?.[field];
    const vb = b.fieldVersions?.[field];
    const order = compareStamps(va, vb);
    // Without stamps on either side the newer note wins, as before
    const fromA = order > 0 || (order === 0 && aIsNewer);
    values[field] = fromA ? a[field] : b[field];
    const stamp = fromA ? va : vb;
    if (typeof stamp === "string") fieldVersions[field] = stamp;
  }
  return { values, fieldVersions };
}

/**
 * Resolve the text of two note versions. With a baseline the blocks are merged
 * three-way (textMerge.js). Without one, the old containment heuristic still
 * applies — it is exact for plain appends — before the lossless two-way block
 * merge takes over.
 */
function mergeNoteText(local, remote, { base, localAuthor, remoteAuthor } = {}) {
  const localContent = local.content || "";
  const remoteContent = remote.content || "";
  if (localContent === remoteContent) return localContent;
  if (typeof base !== "string") {
    if (remoteContent.includes(localContent)) return remoteContent;
    if (localContent.includes(remoteContent)) return localContent;
  }
  return mergeContent(base, localContent, remoteContent, {
    localModified: local.modified || 0,
    remoteModified: remote.modified || 0,
    localAuthor,
    remoteAuthor: remoteAuthor ?? remote.lastModifiedBy,
  });
}

/** The ids and versions of a stroke list, to tell whether two lists are the same ink. */
function inkSignature(strokes) {
  return list(strokes)
    .map((s) => `${keyOf(s)}@${s.v ?? ""}`)
    .sort()
    .join("|");
}

/** Media items as stored: without what the renderer adds while a note is open. */
export function storedMedia(items) {
  return list(items).map((item) => {
    if (!RUNTIME_MEDIA_FIELDS.some((field) => field in item)) return item;
    const copy = { ...item };
    for (const field of RUNTIME_MEDIA_FIELDS) delete copy[field];
    return copy;
  });
}

/**
 * Merge the elements, shifts, scalar fields and recognition of two note
 * versions. Text is left to the caller (mergeNotes, or the editor's LiveText).
 */
export function mergeNoteParts(a, b) {
  const aIsNewer = isNewerNote(a, b);
  const tombstones = mergeTombstones(a.tombstones, b.tombstones);
  const shifts = mergeShifts(a.shifts, b.shifts);
  const parts = { tombstones, shifts };
  for (const kind of Object.keys(ELEMENT_KINDS)) {
    const { list: field, deleted } = ELEMENT_KINDS[kind];
    const merged = mergeElements(
      kind,
      { items: kind === "media" ? storedMedia(a[field]) : a[field], deleted: a[deleted] },
      { items: kind === "media" ? storedMedia(b[field]) : b[field], deleted: b[deleted] },
      { aIsNewer, tombstones },
    );
    parts[field] =
      kind === "strokes" || kind === "media" ? normalize(kind, merged.items, shifts) : merged.items;
    parts[deleted] = merged.deleted;
  }
  const { values, fieldVersions } = mergeScalars(a, b, aIsNewer);
  Object.assign(parts, values, { fieldVersions });

  // Recognition describes ink: kept while the ink is one side's exactly, else
  // dropped so the existing triggers recognize the merged ink again (§10.7 E)
  const ink = inkSignature(parts.strokes);
  const newerNote = aIsNewer ? a : b;
  const olderNote = aIsNewer ? b : a;
  const sameInk = [newerNote, olderNote].find(
    (n) => n.recognition && inkSignature(n.strokes) === ink,
  );
  parts.recognition = sameInk?.recognition ?? null;
  parts.hasRecognition = Boolean(sameInk?.recognition);
  return { parts, aIsNewer };
}

/**
 * Merge two versions of a note. Every field is merged independently, so a text
 * divergence never costs the other side its strokes, media or tasks.
 *
 * @param {Object} local
 * @param {Object} remote
 * @param {{base?: string|null, localAuthor?: string, remoteAuthor?: string}} [opts]
 *   base: HTML text both sides last agreed on (enables the three-way text merge)
 * @returns {Object|null} the merged note, or null when a side is structurally
 *   unmergeable (encrypted blobs, unloaded stub)
 */
export function attemptMerge(local, remote, opts = {}) {
  // If the local note is encrypted (worker cannot decrypt), merging is not possible.
  // Return null so the caller treats this as a conflict to be resolved on the main thread.
  if (local.encrypted) return null;

  // Guard against encrypted content blobs (e.g. index.encrypted flag may be stale).
  // If strokes or content are encrypted objects rather than expected types, abort merge.
  for (const field of ["strokes", "tags", "media"]) {
    if (local[field] !== undefined && !Array.isArray(local[field])) return null;
    if (remote[field] !== undefined && !Array.isArray(remote[field])) return null;
  }

  // Guard against a stub local: index says strokes exist but the content record wasn't loaded
  // (e.g. StorageWorker write still in-flight). Merging with strokes=undefined would treat
  // the local as empty and silently discard its strokes into the merged result.
  if (local.strokes === undefined && local.hasStrokes) return null;

  const { parts, aIsNewer: localIsNewer } = mergeNoteParts(local, remote);
  const newerNote = localIsNewer ? local : remote;

  return {
    id: local.id, // Keep original ID
    notebookId: local.notebookId, // Keep original notebook ID
    created: local.created, // Keep original creation timestamp

    ...parts,
    content: mergeNoteText(local, remote, opts),
    // Merge tags by taking the union of both sets.
    tags: [...new Set([...list(local.tags), ...list(remote.tags)])],
    deleted: local.deleted || remote.deleted, // If deleted on either side, it's deleted

    formatVersion: newerNote.formatVersion, // Use format from newer note
    modified: Date.now(), // Set a new modification time for the merged version
    version: Math.max(local.version || 0, remote.version || 0) + 1, // Increment version
    synced: false, // Mark as unsynced to trigger upload
    lastSyncedEtag: remote._currentFileEtag || remote.lastSyncedEtag, // Use current file ETag for If-Match
  };
}
