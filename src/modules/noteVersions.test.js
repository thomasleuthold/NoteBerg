/**
 * src/modules/noteVersions.test.js
 * Stamping the user's edits (DESIGN §10.7 B, C): exactly what changed since
 * the editor last took in a stored version gets a fresh version, deletions get
 * stamps, undone deletions are marked as restoring them, media stacking order
 * becomes `z` keys, and storage updates merge the bookkeeping.
 */

import { describe, expect, it } from "vitest";
import { createClock } from "./hlc.js";
import {
  assignStackingOrder,
  knownShifts,
  NoteVersioner,
  versionedUpdates,
} from "./noteVersions.js";

function setup(note) {
  const clock = createClock({ device: "me", wall: () => 1_000 });
  const versions = new NoteVersioner({ clock });
  versions.adopt(note);
  return { clock, versions };
}

const stroke = (id, y = 10) => ({
  id,
  x: [1, 2, 3],
  y: [y, y + 1, y + 2],
  colorIndex: 0,
  width: 2,
});

describe("NoteVersioner", () => {
  it("stamps new and changed strokes only", () => {
    const note = {
      strokes: [stroke("kept"), stroke("moved"), stroke("recoloured")],
      deletedStrokes: [],
    };
    const { versions } = setup(note);
    note.strokes[1].y[1] += 30; // a move changes the points in place
    note.strokes[2].colorIndex = 3;
    note.strokes.push(stroke("new"));

    expect(versions.stamp(note)).toBe(true);
    const v = Object.fromEntries(note.strokes.map((s) => [s.id, s.v]));
    expect(v.kept).toBeUndefined();
    expect(v.moved).toBeTruthy();
    expect(v.recoloured).toBeTruthy();
    expect(v.new).toBeTruthy();

    // Nothing changed since: nothing is stamped again
    expect(versions.stamp(note)).toBe(false);
  });

  it("ignores soft-deleted strokes (kept in memory for undo)", () => {
    const note = { strokes: [stroke("s")], deletedStrokes: [] };
    const { versions } = setup(note);
    note.strokes[0]._deleted = true;
    note.deletedStrokes.push("s");
    versions.stamp(note);
    expect(note.strokes[0].v).toBeUndefined();
  });

  it("stamps a new deletion, and marks an undone one as restoring it", () => {
    const note = { strokes: [stroke("s")], deletedStrokes: [] };
    const { versions } = setup(note);
    note.strokes[0]._deleted = true;
    note.deletedStrokes.push("s");
    versions.stamp(note);
    const tombstone = note.tombstones.s;
    expect(tombstone).toBeTruthy();

    // Undo: the stroke is back, its deletion gone from the list
    note.strokes[0]._deleted = false;
    note.deletedStrokes.length = 0;
    versions.stamp(note);
    expect(note.strokes[0].restores).toBe(tombstone);
    expect(note.strokes[0].v > tombstone).toBe(true);
  });

  it("records deleted recordings by their file", () => {
    const note = { recordings: [{ id: "r", fileId: "f" }], deletedRecordings: [] };
    const { versions } = setup(note);
    note.recordings = [];
    note.deletedRecordings = ["f"];
    versions.stamp(note, { kinds: ["recordings"], fields: [] });
    expect(Object.keys(note.tombstones)).toEqual(["f"]);
  });

  it("does not count what a stored version brought as the user's edit", () => {
    const note = { strokes: [stroke("s")], deletedStrokes: [] };
    const { versions } = setup(note);
    // A take-in replaced the stroke with the other side's moved copy
    note.strokes[0] = { ...stroke("s", 99), v: "000000005-000-other" };
    versions.adopt(note);
    expect(versions.stamp(note)).toBe(false);
    expect(note.strokes[0].v).toBe("000000005-000-other");
  });

  it("stamps an element it was asked to although it did not change (insert-space decisions)", () => {
    const note = { strokes: [stroke("s")], deletedStrokes: [] };
    const { versions } = setup(note);
    versions.touch(note.strokes[0]);
    versions.stamp(note);
    expect(note.strokes[0].v).toBeTruthy();
  });

  it("records a shift, and stamps elements with every shift the note knows", () => {
    const note = { strokes: [stroke("s", 200)], deletedStrokes: [] };
    const { versions } = setup(note);
    const shift = versions.recordShift(note, { y: 100, delta: 30 });
    expect(note.shifts).toEqual([shift]);
    note.strokes[0].y = note.strokes[0].y.map((y) => y + 30);
    versions.stamp(note);
    expect(note.strokes[0].seen).toEqual({ me: shift.v });
    expect(knownShifts(note)).toEqual({ me: shift.v });
  });

  it("stamps only the fields a save writes", () => {
    const note = { title: "a", background: "none", penPresets: [] };
    const { versions } = setup(note);
    note.title = "b";
    note.background = "lines";
    versions.stamp(note, { kinds: [], fields: ["background"] });
    expect(Object.keys(note.fieldVersions)).toEqual(["background"]);
    versions.stamp(note, { kinds: [], fields: ["title"] });
    expect(Object.keys(note.fieldVersions).sort()).toEqual(["background", "title"]);
  });

  it("does not count the renderer's fields on a media item as a change", () => {
    const note = { media: [{ id: "p", type: "pdf-page", y: 0, z: 0 }], deletedMedia: [] };
    const { versions } = setup(note);
    Object.assign(note.media[0], { renderable: {}, loading: false, renderableScale: 2 });
    expect(versions.stamp(note)).toBe(false);
  });

  it("turns a change of stacking order into `z` keys, stamping only the item that moved", () => {
    const note = {
      media: [
        { id: "a", y: 0, z: 1 },
        { id: "b", y: 0, z: 2 },
        { id: "c", y: 0, z: 3 },
      ],
      deletedMedia: [],
    };
    const { versions } = setup(note);
    note.media.push(note.media.shift()); // bring "a" to the front
    versions.stamp(note);
    expect(note.media.map((m) => m.z)).toEqual([2, 3, 4]);
    expect(note.media.filter((m) => m.v).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("assignStackingOrder", () => {
  it("numbers items without keys in their order", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assignStackingOrder(items);
    expect(items.map((i) => i.z)).toEqual([0, 1, 2]);
  });

  it("keeps the longest run in order and fits the others between their neighbours", () => {
    const items = [
      { id: "x", z: 5 }, // sent to the back: out of order
      { id: "a", z: 1 },
      { id: "b", z: 2 },
      { id: "c", z: 3 },
    ];
    const changed = assignStackingOrder(items);
    expect([...changed]).toEqual(["x"]);
    expect(items[0].z).toBeLessThan(items[1].z);
  });

  it("places an item moved between two others between their keys", () => {
    const items = [
      { id: "a", z: 1 },
      { id: "m", z: 9 },
      { id: "b", z: 2 },
      { id: "c", z: 3 },
    ];
    assignStackingOrder(items);
    expect(items.map((i) => i.z)).toEqual([1, 1.5, 2, 3]);
  });

  it("numbers every item afresh when the gap between its neighbours is used up", () => {
    const lower = 1;
    const upper = lower + Number.EPSILON; // the next number after it
    const items = [
      { id: "a", z: lower },
      { id: "m" }, // between two keys with no number left between them
      { id: "b", z: upper },
    ];
    const changed = assignStackingOrder(items);
    const zs = items.map((i) => i.z);
    expect(zs[0]).toBeLessThan(zs[1]);
    expect(zs[1]).toBeLessThan(zs[2]);
    expect(changed.has("m")).toBe(true);
  });
});

describe("versionedUpdates", () => {
  const clock = () => createClock({ device: "me", wall: () => 5_000 });

  it("stamps a field changed outside the editor, above the stamp it replaces", () => {
    const existing = { title: "Old", fieldVersions: { title: "00000zzzz-000-other" } };
    const out = versionedUpdates(existing, { title: "New" }, clock());
    expect(out.fieldVersions.title > existing.fieldVersions.title).toBe(true);
  });

  it("keeps a field stamp the editor sent", () => {
    const out = versionedUpdates(
      {},
      { background: "x", fieldVersions: { background: "f1" } },
      clock(),
    );
    expect(out.fieldVersions).toEqual({ background: "f1" });
  });

  it("merges deletion stamps, field stamps and shifts with what is stored", () => {
    const existing = {
      tombstones: { a: "t2" },
      fieldVersions: { title: "f2" },
      shifts: [{ v: "s1", y: 0, delta: 1 }],
    };
    const out = versionedUpdates(
      existing,
      {
        tombstones: { a: "t1", b: "t1" },
        shifts: [{ v: "s2", y: 0, delta: 1 }],
        fieldVersions: {},
      },
      clock(),
    );
    expect(out.tombstones).toEqual({ a: "t2", b: "t1" });
    expect(out.fieldVersions).toEqual({ title: "f2" });
    expect(out.shifts.map((s) => s.v)).toEqual(["s1", "s2"]);
  });

  it("leaves an update without bookkeeping alone", () => {
    expect(versionedUpdates({}, { content: "x" }, clock())).toEqual({ content: "x" });
  });
});
