/**
 * Several writers editing one note, for merge tests (DESIGN §10.7 H).
 *
 * Each Device holds the note as its editor would, with its own clock and
 * stamper (noteVersions.js), and edits it the way the editor does: strokes are
 * changed in place, deletions recorded in the deletion lists, an insert space
 * moves what is below its line and records the shift. sync() stamps the edits
 * and merges with a shared "server" copy through the real merge, as the native
 * sync and the Nextcloud writer do; mergeWith() merges two devices directly, as
 * a sync through another path would.
 */

import { createClock } from "../hlc.js";
import { mergeNoteParts } from "../noteMerge.js";
import { NoteVersioner } from "../noteVersions.js";

export const clone = (value) => structuredClone(value);

/** One version merged with another, elements and fields (text is untouched). */
export function mergeState(a, b) {
  return { ...a, ...mergeNoteParts(a, b).parts };
}

/** What a note shows, for comparing two of them. */
export function canonical(note) {
  const live = (items) => (Array.isArray(items) ? items.filter((i) => !i._deleted) : []);
  return {
    strokes: live(note.strokes)
      .map((s) => `${s.id}:${s.y.join(",")}:${s.x.join(",")}`)
      .sort(),
    media: live(note.media).map((m) => `${m.id}:${m.x},${m.y}`),
    tasks: live(note.tasks)
      .map((t) => `${t.id}:${t.checked}`)
      .sort(),
    deletedStrokes: [...(note.deletedStrokes ?? [])].sort(),
    deletedMedia: [...(note.deletedMedia ?? [])].sort(),
    title: note.title,
    background: note.background,
    shifts: (note.shifts ?? []).map((s) => s.v),
  };
}

export function emptyNote() {
  return {
    id: "n1",
    title: "Note",
    content: "",
    background: "none",
    modified: 1,
    version: 1,
    strokes: [],
    deletedStrokes: [],
    media: [],
    deletedMedia: [],
    tasks: [],
    deletedTasks: [],
    recordings: [],
    deletedRecordings: [],
  };
}

export class World {
  constructor() {
    this.time = 1_700_000_000_000;
    this.server = emptyNote();
    this.devices = [];
  }

  /** Advance every wall clock a little; skew lets devices disagree about the time. */
  tick(ms = 1) {
    this.time += ms;
  }

  addDevice(name, { skew = 0 } = {}) {
    const device = new Device(this, name, skew);
    this.devices.push(device);
    return device;
  }
}

export class Device {
  constructor(world, name, skew) {
    this.world = world;
    this.name = name;
    this.clock = createClock({ device: name, wall: () => world.time + skew });
    this.versions = new NoteVersioner({ clock: this.clock });
    this.note = clone(world.server);
    this.versions.adopt(this.note);
    this.counter = 0;
    this.erased = []; // undo history of erases: the stroke objects
  }

  _edited() {
    this.note.modified = this.world.time;
    this.world.tick();
  }

  live() {
    return this.note.strokes.filter((s) => !s._deleted);
  }

  stroke(id) {
    return this.note.strokes.find((s) => s.id === id && !s._deleted);
  }

  /** Draw a stroke whose top edge is at `top`. */
  draw(top, { id, x = 10, height = 10 } = {}) {
    const stroke = {
      id: id ?? `${this.name}-s${++this.counter}`,
      x: [x, x + 5],
      y: [top, top + height],
      pressure: [0.5, 0.5],
      time: [this.world.time],
      width: 2,
    };
    this.note.strokes.push(stroke);
    this._edited();
    return stroke.id;
  }

  erase(id) {
    const stroke = this.stroke(id);
    if (!stroke) return false;
    stroke._deleted = true;
    this.note.deletedStrokes.push(id);
    this.erased.push(stroke);
    this._edited();
    return true;
  }

  /** Undo the last erase (the editor's undo restores the very stroke object). */
  undoErase() {
    const stroke = this.erased.pop();
    if (!stroke) return null;
    const i = this.note.deletedStrokes.indexOf(stroke.id);
    if (i === -1) return null;
    this.note.deletedStrokes.splice(i, 1);
    // The merge may have replaced the object meanwhile: restore what is there
    const there = this.note.strokes.find((s) => s.id === stroke.id);
    if (there) there._deleted = false;
    else this.note.strokes.push({ ...stroke, _deleted: false });
    this._edited();
    return stroke.id;
  }

  /** A lasso move: the stroke's points change in place. */
  move(id, dx, dy) {
    const stroke = this.stroke(id);
    if (!stroke) return false;
    for (let i = 0; i < stroke.y.length; i++) {
      stroke.x[i] += dx;
      stroke.y[i] += dy;
    }
    this._edited();
    return true;
  }

  /** Insert space as the editor does: what starts below the line moves down. */
  insertSpace(line, delta) {
    const moved = [];
    for (const stroke of this.live()) {
      if (Math.min(...stroke.y) > line) {
        for (let i = 0; i < stroke.y.length; i++) stroke.y[i] += delta;
        moved.push(stroke.id);
      }
    }
    for (const item of this.note.media) {
      if (item.type !== "pdf-page" && item.y > line) item.y += delta;
    }
    this.versions.recordShift(this.note, { y: line, delta });
    this._edited();
    return moved;
  }

  /** Undo of an insert space: the moved strokes go back, the rest is decided to stay. */
  undoInsertSpace(line, delta, moved) {
    const movedIds = new Set(moved);
    for (const stroke of this.live()) {
      if (movedIds.has(stroke.id)) {
        for (let i = 0; i < stroke.y.length; i++) stroke.y[i] -= delta;
      } else if (Math.min(...stroke.y) > line) {
        this.versions.touch(stroke);
      }
    }
    this.versions.recordShift(this.note, { y: line, delta: -delta });
    this._edited();
  }

  addMedia(y, { id, type = "image" } = {}) {
    const item = {
      id: id ?? `${this.name}-m${++this.counter}`,
      type,
      x: 0,
      y,
      width: 10,
      height: 10,
    };
    this.note.media.push(item);
    this._edited();
    return item.id;
  }

  moveMedia(id, dy) {
    const item = this.note.media.find((m) => m.id === id);
    if (!item) return false;
    item.y += dy;
    this._edited();
    return true;
  }

  bringToFront(id) {
    const i = this.note.media.findIndex((m) => m.id === id);
    if (i === -1) return false;
    this.note.media.push(...this.note.media.splice(i, 1));
    this._edited();
    return true;
  }

  deleteMedia(id) {
    const i = this.note.media.findIndex((m) => m.id === id);
    if (i === -1) return false;
    this.note.media.splice(i, 1);
    this.note.deletedMedia.push(id);
    this._edited();
    return true;
  }

  setField(field, value) {
    this.note[field] = value;
    this._edited();
  }

  /** The version this device would save now (its edits stamped). */
  saved() {
    this.versions.stamp(this.note);
    const copy = clone(this.note);
    copy.strokes = copy.strokes.filter((s) => !s._deleted);
    return copy;
  }

  /** Take in a stored version the way the editor does: merge, then show the result. */
  takeIn(stored) {
    const merged = mergeState(this.saved(), stored);
    this.note = clone(merged);
    this.versions.adopt(this.note);
    return merged;
  }

  /** Sync with the server copy: both end with the merge. */
  sync() {
    const merged = this.takeIn(this.world.server);
    this.world.server = clone(merged);
    this.world.tick();
    return merged;
  }
}
