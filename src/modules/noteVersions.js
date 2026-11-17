/**
 * Stamping the user's edits with versions (DESIGN §10.7 B, C).
 *
 * The merge (noteMerge.js) decides between two copies of an element by its
 * version `v`, so every change the user makes must carry a fresh stamp. Rather
 * than every edit path (draw, erase, part erase, lasso move, resize, insert
 * space, paste, undo, redo, media, tasks...) remembering to stamp, the editor
 * keeps the state it last saw from storage (adopt()) and, just before each
 * save, stamps whatever differs from it (stamp()). What differs is the user's
 * own doing by construction: storage's changes reach the editor through
 * adopt(). This also covers what has no element to stamp:
 *  - a new deletion records its stamp in `note.tombstones`
 *  - a deletion that disappeared (an undo) marks the element as restoring that
 *    deletion (`restores`), so the merge does not delete it again
 *  - a change of media stacking order sets the items' `z` keys
 *
 * Comparing a stroke costs a few number comparisons (its point count and three
 * sample points), so a save while drawing stays cheap.
 *
 * Main thread only: stamps come from this app's clock (hlc.js).
 */

import { getClock, stampDevice } from "./hlc.js";
import { ELEMENT_KINDS, mergeVersionFields, SCALAR_FIELDS, storedMedia } from "./noteMerge.js";

const VERSION_FIELDS = new Set(["v", "seen", "restores"]);
const list = (value) => (Array.isArray(value) ? value : []);
const keyOf = (item) => item.id ?? JSON.stringify(item);

/**
 * What a stroke draws, cheaply: enough to notice a move, resize, recolour or shift.
 * It samples three points, so it relies on every edit the app makes changing at
 * least one of them (or an attribute): move, scale, shift and recolour all do, and
 * the part eraser makes new ids. A new kind of in-place stroke edit that leaves
 * its first, middle and last point alone must change something sampled here.
 */
function strokeShape(stroke) {
  const x = list(stroke.x);
  const y = list(stroke.y);
  const n = x.length;
  const mid = n >> 1;
  return [
    n,
    x[0],
    y[0],
    x[mid],
    y[mid],
    x[n - 1],
    y[n - 1],
    stroke.colorIndex,
    stroke.color,
    stroke.width,
    stroke.type,
  ];
}

function sameShape(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Media items, tasks and recordings are small: compared as JSON, without versions. */
function itemShape(item) {
  return JSON.stringify(item, (key, value) => (VERSION_FIELDS.has(key) ? undefined : value));
}

/** The newest shift of each device a note records, as an element's `seen`. */
export function knownShifts(note) {
  const shifts = list(note?.shifts);
  if (shifts.length === 0) return null;
  const known = {};
  for (const shift of shifts) {
    const device = stampDevice(shift.v);
    if (device && !(known[device] >= shift.v)) known[device] = shift.v;
  }
  return known;
}

/**
 * Give media items `z` keys that follow their array order (the stacking order
 * the editor shows), changing as few as possible: the longest run already in
 * order keeps its keys, the others get keys between their neighbours.
 * @returns {Set<string>} ids whose key changed
 */
export function assignStackingOrder(items) {
  const changed = new Set();
  const n = items.length;
  if (n === 0) return changed;
  // Longest strictly increasing run of existing keys (O(n²); a note has few media)
  const len = new Array(n).fill(0);
  const prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (typeof items[i].z !== "number") continue;
    len[i] = 1;
    for (let j = 0; j < i; j++) {
      if (typeof items[j].z === "number" && items[j].z < items[i].z && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (best === -1 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i !== -1; i = prev[i]) keep.add(i);

  let lower = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (keep.has(i)) {
      lower = items[i].z;
      continue;
    }
    let upper = Number.POSITIVE_INFINITY;
    for (let j = i + 1; j < n; j++) {
      if (keep.has(j)) {
        upper = items[j].z;
        break;
      }
    }
    let z;
    if (lower === Number.NEGATIVE_INFINITY && upper === Number.POSITIVE_INFINITY) z = i;
    else if (lower === Number.NEGATIVE_INFINITY) z = upper - 1;
    else if (upper === Number.POSITIVE_INFINITY) z = lower + 1;
    else z = (lower + upper) / 2;
    if (z === lower || z === upper) {
      // The gap is used up (about 50 reorders into the same one): number them all afresh
      for (let k = 0; k < n; k++) {
        if (items[k].z === k) continue;
        items[k].z = k;
        changed.add(items[k].id);
      }
      return changed;
    }
    items[i].z = z;
    lower = z;
    changed.add(items[i].id);
  }
  return changed;
}

export class NoteVersioner {
  /** @param {{clock?: ReturnType<import("./hlc.js").createClock>}} [options] */
  constructor({ clock } = {}) {
    this._clock = clock ?? null;
    this._shapes = {}; // kind -> Map(key -> shape)
    this._deleted = {}; // kind -> Set(dead keys)
    this._scalars = {}; // field -> JSON
    this._forced = new Set(); // keys to stamp at the next save although unchanged
  }

  get clock() {
    if (!this._clock) this._clock = getClock();
    return this._clock;
  }

  /**
   * The editor now shows this stored version: what it holds is not the user's
   * doing, and the clock must not stamp below anything in it.
   * @param {object} note
   */
  adopt(note) {
    this.clock.observeNote(note);
    for (const kind of Object.keys(ELEMENT_KINDS)) this._remember(note, kind);
    for (const field of SCALAR_FIELDS) this._scalars[field] = JSON.stringify(note[field] ?? null);
    this._forced.clear();
  }

  _remember(note, kind) {
    const { list: field, deleted } = ELEMENT_KINDS[kind];
    const shapes = new Map();
    for (const item of list(note[field])) {
      if (!item || item._deleted) continue;
      shapes.set(keyOf(item), this._shapeOf(kind, item));
    }
    this._shapes[kind] = shapes;
    this._deleted[kind] = new Set(list(note[deleted]));
  }

  _shapeOf(kind, item) {
    if (kind === "strokes") return strokeShape(item);
    return itemShape(kind === "media" ? storedMedia([item])[0] : item);
  }

  /** Stamp an element at the next save although it did not change (an insert-space decision). */
  touch(item) {
    if (item) this._forced.add(keyOf(item));
  }

  /**
   * Record an insert space (§10.7 D). Call before the moved elements are saved:
   * they are stamped as having seen it.
   * @returns {object} the recorded shift
   */
  recordShift(note, { y, delta }) {
    const shift = { v: this.clock.now(), y, delta };
    note.shifts = [...list(note.shifts), shift];
    return shift;
  }

  /**
   * Stamp what the user changed since adopt() or the previous stamp().
   * A save stamps only what it writes: a field stamped but not sent would let
   * its stored, older value win under the new stamp.
   * @param {object} note - the editor's note (changed in place)
   * @param {{kinds?: Array<string>, fields?: Array<string>}} [what] - element
   *   kinds and scalar fields to look at; all of both by default
   * @returns {boolean} whether anything was stamped
   */
  stamp(note, { kinds = Object.keys(ELEMENT_KINDS), fields = SCALAR_FIELDS } = {}) {
    let stamped = false;
    for (const kind of kinds) stamped = this._stampKind(note, kind) || stamped;
    return this._stampScalars(note, fields) || stamped;
  }

  _stampKind(note, kind) {
    const { list: field, deleted: deletedField, deadKey } = ELEMENT_KINDS[kind];
    const items = list(note[field]);
    const shapes = this._shapes[kind] ?? new Map();
    const known = knownShifts(note);
    let stamped = false;
    const stampItem = (item) => {
      item.v = this.clock.now();
      if (known) item.seen = { ...known };
      stamped = true;
    };

    if (kind === "media") {
      // Stacking order is the array order: give it keys the merge can sort by
      const reordered = assignStackingOrder(items.filter((item) => !item.pending));
      for (const id of reordered) this._forced.add(id);
    }

    // Deletions: new ones get a stamp, vanished ones are undos of a deletion
    const before = this._deleted[kind] ?? new Set();
    const now = new Set(list(note[deletedField]));
    for (const id of now) {
      if (before.has(id)) continue;
      note.tombstones = { ...note.tombstones, [id]: this.clock.now() };
      stamped = true;
    }
    if (before.size > 0) {
      for (const item of items) {
        if (!item || item._deleted) continue;
        const dead = deadKey(item);
        if (dead === undefined || !before.has(dead) || now.has(dead)) continue;
        item.restores = note.tombstones?.[dead] ?? "";
        this._forced.add(keyOf(item));
      }
    }
    this._deleted[kind] = now;

    for (const item of items) {
      if (!item || item._deleted || item.pending) continue;
      const key = keyOf(item);
      const shape = this._shapeOf(kind, item);
      const previous = shapes.get(key);
      const changed =
        previous === undefined ||
        (kind === "strokes" ? !sameShape(previous, shape) : previous !== shape);
      if (changed || this._forced.has(key)) {
        stampItem(item);
        this._forced.delete(key);
      }
      shapes.set(key, shape);
    }
    this._shapes[kind] = shapes;
    return stamped;
  }

  _stampScalars(note, fields) {
    let stamped = false;
    for (const field of fields) {
      const value = JSON.stringify(note[field] ?? null);
      if (value === this._scalars[field]) continue;
      note.fieldVersions = { ...note.fieldVersions, [field]: this.clock.now() };
      this._scalars[field] = value;
      stamped = true;
    }
    return stamped;
  }
}

/**
 * An update of a stored note, as the storage layers apply it: its version
 * bookkeeping merged with what storage holds (never replaced), and a field
 * changed without a stamp of its own (a rename outside the editor) stamped now.
 * @param {object} existing - the stored note
 * @param {object} updates
 * @param {object} [clock]
 */
export function versionedUpdates(existing, updates, clock = getClock()) {
  const out = { ...updates, ...mergeVersionFields(existing ?? {}, updates) };
  for (const field of SCALAR_FIELDS) {
    if (!(field in updates) || typeof updates.fieldVersions?.[field] === "string") continue;
    clock.observe(existing?.fieldVersions?.[field]);
    out.fieldVersions = { ...out.fieldVersions, [field]: clock.now() };
  }
  return out;
}
