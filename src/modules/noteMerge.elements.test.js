/**
 * src/modules/noteMerge.elements.test.js
 * What two writers' concurrent edits of one note merge to (DESIGN §10.7):
 * per-element versions, delete wins, undo restores, insert space replayed on
 * what its author had not seen, fields by their own stamps, media stacking.
 * The writers are modelled devices (__fixtures__/mergeReplicas.js) using the
 * real clock, stamper and merge.
 */

import { describe, expect, it } from "vitest";
import { canonical, mergeState, World } from "./__fixtures__/mergeReplicas.js";
import { attemptMerge, mergeNoteParts } from "./noteMerge.js";

function twoWriters() {
  const world = new World();
  const a = world.addDevice("aaaa");
  const b = world.addDevice("bbbb");
  return { world, a, b };
}

const top = (note, id) => Math.min(...note.strokes.find((s) => s.id === id).y);
const ids = (note) => note.strokes.map((s) => s.id).sort();

describe("strokes and media by version", () => {
  it("keeps a lasso move against the other side's older copy, whoever saves last", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    b.sync();

    a.move(s, 0, 50);
    a.sync();
    // B saves later, with its untouched copy
    b.draw(300);
    b.sync();
    a.sync();

    expect(top(a.note, s)).toBe(150);
    expect(top(b.note, s)).toBe(150);
  });

  it("takes the later of two concurrent moves of the same stroke, on both sides", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    b.sync();
    a.move(s, 0, 10);
    b.move(s, 0, 20); // later
    a.sync();
    b.sync();
    a.sync();
    expect(top(a.note, s)).toBe(120);
    expect(canonical(a.note)).toEqual(canonical(b.note));
  });

  it("keeps a media move against the other side's older copy", () => {
    const { a, b } = twoWriters();
    const m = a.addMedia(100);
    a.sync();
    b.sync();
    a.moveMedia(m, 40);
    a.sync();
    b.draw(10);
    b.sync();
    expect(b.note.media.find((x) => x.id === m).y).toBe(140);
  });

  it("follows the stacking order of the side that changed it last", () => {
    const { a, b } = twoWriters();
    const m1 = a.addMedia(0);
    const m2 = a.addMedia(0);
    a.sync();
    b.sync();
    b.bringToFront(m1);
    b.sync();
    a.addMedia(50); // A saves later without having seen the reorder
    a.sync();
    b.sync();
    const order = a.note.media.map((x) => x.id);
    expect(order.indexOf(m1)).toBeGreaterThan(order.indexOf(m2));
    expect(b.note.media.map((x) => x.id)).toEqual(order);
  });
});

describe("deletions", () => {
  it("delete wins over a concurrent move of the same stroke", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    b.sync();
    a.erase(s);
    b.move(s, 0, 30); // later, but a move does not bring a deleted stroke back
    a.sync();
    b.sync();
    a.sync();
    expect(ids(a.note)).toEqual([]);
    expect(ids(b.note)).toEqual([]);
  });

  it("delete wins over a concurrent part erase's pieces only for the original", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    b.sync();
    // B part-erases: the original is deleted, two pieces are new strokes
    b.erase(s);
    b.draw(100, { id: "piece-1" });
    b.draw(105, { id: "piece-2" });
    a.move(s, 0, 40);
    b.sync();
    a.sync();
    expect(ids(a.note)).toEqual(["piece-1", "piece-2"]);
    expect(top(a.note, "piece-1")).toBe(100); // the pieces stay where they were cut
  });

  it("brings back a stroke whose erase was undone, although the erase was already synced", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    a.erase(s);
    a.sync();
    b.sync(); // B has the deletion
    a.undoErase();
    a.sync();
    b.sync();
    expect(ids(a.note)).toEqual([s]);
    expect(ids(b.note)).toEqual([s]);
  });

  it("deletes again after an undone erase is erased once more", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.erase(s);
    a.sync();
    a.undoErase();
    a.sync();
    b.sync();
    b.erase(s);
    b.sync();
    a.sync();
    expect(ids(a.note)).toEqual([]);
  });

  it("an undone erase does not undo the other side's own erase of the stroke", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    b.sync();
    a.erase(s);
    a.undoErase();
    b.erase(s); // B's erase is later than A's (undone) one
    a.sync();
    b.sync();
    a.sync();
    expect(ids(a.note)).toEqual([]);
  });
});

describe("insert space", () => {
  it("moves the other side's strokes drawn below the line before seeing it, exactly once", () => {
    const { a, b } = twoWriters();
    const above = a.draw(50);
    const below = a.draw(200);
    a.sync();
    b.sync();

    a.insertSpace(100, 80);
    const bNew = b.draw(300); // below the line, drawn without knowing the shift
    const bAbove = b.draw(60);
    a.sync();
    b.sync();
    a.sync();
    b.sync();

    expect(top(a.note, above)).toBe(50);
    expect(top(a.note, below)).toBe(280);
    expect(top(a.note, bNew)).toBe(380);
    expect(top(a.note, bAbove)).toBe(60);
    expect(canonical(a.note)).toEqual(canonical(b.note));
  });

  it("is not undone by the other side saving its stale copies afterwards", () => {
    const { a, b } = twoWriters();
    const below = a.draw(200);
    const m = a.addMedia(150);
    a.sync();
    b.sync();
    a.insertSpace(100, 80);
    a.sync();
    b.draw(20); // B saves later with copies from before the shift
    b.sync();
    expect(top(b.note, below)).toBe(280);
    expect(b.note.media.find((x) => x.id === m).y).toBe(230);
  });

  it("does not move a stroke crossing the line, nor PDF pages", () => {
    const { a, b } = twoWriters();
    a.sync();
    b.sync();
    a.insertSpace(100, 80);
    const crossing = b.draw(90, { height: 40 });
    const page = b.addMedia(500, { type: "pdf-page" });
    b.sync();
    a.sync();
    expect(top(a.note, crossing)).toBe(90);
    expect(a.note.media.find((x) => x.id === page).y).toBe(500);
  });

  it("does not move what the other side drew after seeing the shift", () => {
    const { a, b } = twoWriters();
    a.insertSpace(100, 80);
    a.sync();
    b.sync();
    const after = b.draw(150); // into the inserted space, knowingly
    b.sync();
    a.sync();
    expect(top(a.note, after)).toBe(150);
  });

  it("moves an offline stroke back with the undo of the shift: net nothing", () => {
    const { a, b } = twoWriters();
    a.draw(200);
    a.sync();
    b.sync();
    const moved = a.insertSpace(100, 80);
    const gap = a.draw(120); // into the gap, before the undo
    a.undoInsertSpace(100, 80, moved);
    const offline = b.draw(300);
    a.sync();
    b.sync();
    a.sync();
    expect(top(a.note, offline)).toBe(300);
    expect(top(a.note, gap)).toBe(120); // the undo did not move it, and neither does the merge
    expect(canonical(a.note)).toEqual(canonical(b.note));
  });

  it("places a stroke the same however three versions with older and newer shifts are grouped", () => {
    // The stroke has seen neither shift. Met by the newer shift first, it used
    // to be checked against the older one from where the newer had put it
    const world = new World();
    const [drawer, older, newer] = ["bbbb", "dddd", "aaaa"].map((n) => world.addDevice(n));
    for (const d of [drawer, older, newer]) d.sync();
    const s = drawer.draw(150);
    world.tick(1_000);
    older.insertSpace(175, 100); // above the stroke's top: does not move it
    world.tick(1_000);
    newer.insertSpace(100, 50); // moves it to 200, below the older line
    const [b, d, a] = [drawer.saved(), older.saved(), newer.saved()];

    const oneWay = mergeState(mergeState(b, a), d);
    const otherWay = mergeState(b, mergeState(a, d));
    expect(top(oneWay, s)).toBe(top(otherWay, s));
    expect(canonical(oneWay)).toEqual(canonical(otherWay));
  });

  it("lets a later move of a stroke win, then places it by the shifts it had not seen", () => {
    const { a, b } = twoWriters();
    const s = a.draw(50);
    a.sync();
    b.sync();
    a.insertSpace(100, 80);
    b.move(s, 0, 150); // B moves it below the line without knowing the shift
    a.sync();
    b.sync();
    a.sync();
    // Placed among content that the shift moved down: it moves with it
    expect(top(a.note, s)).toBe(280);
    expect(canonical(a.note)).toEqual(canonical(b.note));
  });
});

describe("what insert spaces cost (DESIGN §10.7 D, growth)", () => {
  it("adds one shift per insert space, and one stamp per shift to what it moves unseen", () => {
    const { a, b } = twoWriters();
    a.sync();
    b.sync();
    const s = b.draw(5_000); // far below every line, drawn offline
    const SHIFTS = 100;
    for (let i = 0; i < SHIFTS; i++) a.insertSpace(10 + i, 1);
    a.sync();
    b.sync();

    const stroke = b.note.strokes.find((x) => x.id === s);
    expect(b.note.shifts).toHaveLength(SHIFTS);
    expect(top(b.note, s)).toBe(5_000 + SHIFTS);
    // `<edit stamp>+<shift stamp>` once per shift it was moved by: linear growth
    const [edit, ...applied] = stroke.v.split("+");
    expect(applied).toHaveLength(SHIFTS);
    expect(stroke.v.length).toBe(edit.length + applied.reduce((n, x) => n + x.length + 1, 0));
    expect(JSON.stringify(b.note.shifts).length / SHIFTS).toBeLessThan(80);

    // Edited again, the stroke carries a plain stamp: the growth ends there
    b.move(s, 1, 0);
    b.sync();
    expect(b.note.strokes.find((x) => x.id === s).v).not.toContain("+");
  });
});

describe("fields and derived data", () => {
  it("takes each field from the side that changed it last", () => {
    const { a, b } = twoWriters();
    a.setField("title", "From A");
    b.setField("background", "lines");
    a.sync();
    b.sync();
    a.sync();
    expect(a.note.title).toBe("From A");
    expect(a.note.background).toBe("lines");
    expect(canonical(b.note)).toEqual(canonical(a.note));
  });

  it("keeps recognition while the ink is one side's, and drops it for merged ink", () => {
    const { a, b } = twoWriters();
    a.draw(10);
    a.sync();
    b.sync();
    const recognized = { ...b.saved(), recognition: { text: "hi" }, hasRecognition: true };
    expect(mergeState(a.saved(), recognized).recognition).toEqual({ text: "hi" });

    a.draw(50);
    const merged = mergeState(a.saved(), recognized);
    expect(merged.recognition).toBeNull();
    expect(merged.hasRecognition).toBe(false);
  });
});

describe("notes without versions (written before them)", () => {
  it("still lets the newer note win a stroke both sides changed", () => {
    const stroke = (y) => ({ id: "s", x: [1, 2], y: [y, y + 1], time: [1] });
    const local = { id: "n", modified: 2, version: 2, strokes: [stroke(50)] };
    const remote = { id: "n", modified: 1, version: 1, strokes: [stroke(10)] };
    expect(attemptMerge(local, remote).strokes[0].y[0]).toBe(50);
    expect(attemptMerge(remote, local).strokes[0].y[0]).toBe(50);
  });

  it("keeps fields it does not merge itself out of the result, as before, but carries the scalar ones", () => {
    const local = { id: "n", modified: 2, version: 1, penPresets: [1], pdfSource: "f" };
    const remote = { id: "n", modified: 1, version: 1 };
    const merged = attemptMerge(local, remote);
    expect(merged.penPresets).toEqual([1]);
    expect(merged.pdfSource).toBe("f");
  });

  it("merges a version-less side with a versioned one by the versions it has", () => {
    const { a } = twoWriters();
    const s = a.draw(10);
    const versioned = a.saved();
    const legacy = {
      id: "n1",
      modified: 9e15,
      strokes: [{ id: s, x: [10, 15], y: [99, 109], time: [1] }],
    };
    expect(mergeNoteParts(versioned, legacy).parts.strokes[0].y[0]).toBe(10);
  });
});

describe("tasks and recordings by version", () => {
  const note = (fields) => ({ id: "n", modified: 1, version: 1, ...fields });

  it("takes the later edit of the same task, whichever note is newer", () => {
    const older = note({ modified: 9, tasks: [{ id: "t", checked: true, v: "000000001-000-a" }] });
    const newer = note({ modified: 1, tasks: [{ id: "t", checked: false, v: "000000002-000-b" }] });
    expect(mergeNoteParts(older, newer).parts.tasks[0].checked).toBe(false);
    expect(mergeNoteParts(newer, older).parts.tasks[0].checked).toBe(false);
  });

  it("keeps the old per-task clock for tasks without versions", () => {
    const newerNote = note({ modified: 9, tasks: [{ id: "t", checked: true, modified: 1 }] });
    const olderNote = note({ modified: 1, tasks: [{ id: "t", checked: false, modified: 5 }] });
    // The newer note's copy is older by the task's own clock: the other one stays
    expect(mergeNoteParts(newerNote, olderNote).parts.tasks[0].checked).toBe(false);
  });

  it("takes the later version of a recording, and deletes recordings by their file", () => {
    const a = note({
      recordings: [
        { id: "r1", fileId: "f1", name: "old", v: "000000001-000-a" },
        { id: "r2", fileId: "f2", v: "000000001-000-a" },
      ],
    });
    const b = note({
      recordings: [{ id: "r1", fileId: "f1", name: "renamed", v: "000000002-000-b" }],
      deletedRecordings: ["f2"],
    });
    const { recordings, deletedRecordings } = mergeNoteParts(a, b).parts;
    expect(recordings).toEqual([expect.objectContaining({ id: "r1", name: "renamed" })]);
    expect(deletedRecordings).toEqual(["f2"]);
  });
});

describe("cases the random histories found", () => {
  it("of two copies with the same version, keeps the one that checked more shifts", () => {
    const shift = { v: "000000005-000-s", y: 100, delta: 50 };
    const unchecked = { id: "s", x: [1], y: [10], v: "000000001-000-a" };
    const checked = { ...unchecked, seen: { s: shift.v } };
    const a = { id: "n", modified: 1, shifts: [shift], strokes: [unchecked] };
    const b = { id: "n", modified: 1, shifts: [shift], strokes: [checked] };
    expect(mergeNoteParts(a, b).parts.strokes[0].seen).toEqual({ s: shift.v });
    expect(mergeNoteParts(b, a).parts.strokes[0].seen).toEqual({ s: shift.v });
  });

  it("does not check a shift again after a later shift moved the element across its line", () => {
    // Checked first: above the first line, so not moved. The second shift then
    // moves it below the first line: checking the first again would move it too.
    const first = { v: "000000002-000-a", y: 120, delta: -30 };
    const second = { v: "000000003-000-b", y: 50, delta: 60 };
    const note = {
      id: "n",
      modified: 1,
      shifts: [first, second],
      strokes: [{ id: "s", x: [1], y: [100], v: "000000001-000-c" }],
    };
    const once = mergeState(note, note);
    expect(once.strokes[0].y).toEqual([160]);
    expect(mergeState(once, once).strokes[0].y).toEqual([160]);
    expect(mergeState(once, note).strokes[0].y).toEqual([160]);
  });

  it("keeps an undone erase when the other side's newer copy never saw the undo", () => {
    const { a, b } = twoWriters();
    const s = a.draw(100);
    a.sync();
    b.sync();
    a.erase(s);
    a.undoErase();
    b.move(s, 0, 20); // later than the undo, but without knowing of it
    a.sync();
    b.sync();
    a.sync();
    expect(ids(a.note)).toEqual([s]);
    expect(top(a.note, s)).toBe(120); // the later move stays
    expect(canonical(a.note)).toEqual(canonical(b.note));
  });

  it("brings two writers' concurrent insert spaces to the same note", () => {
    const { a, b } = twoWriters();
    const top1 = a.draw(100);
    const mid = a.draw(300);
    const low = a.draw(500);
    a.sync();
    b.sync();
    a.insertSpace(200, 40);
    b.insertSpace(400, 70);
    a.sync();
    b.sync();
    a.sync();
    expect(canonical(a.note)).toEqual(canonical(b.note));
    expect(top(a.note, top1)).toBe(100);
    expect(top(a.note, mid)).toBe(340);
    expect(top(a.note, low)).toBe(610);
  });
});

describe("order and guards", () => {
  it("orders strokes by when they were started, then by id", () => {
    const s = (id, t) => ({ id, x: [1], y: [1], time: [t], v: "000000001-000-a" });
    const merged = mergeNoteParts(
      { id: "n", strokes: [s("late", 3), s("b", 1)] },
      { id: "n", strokes: [s("early", 0), s("a", 1)] },
    ).parts.strokes;
    expect(merged.map((x) => x.id)).toEqual(["early", "a", "b", "late"]);
  });

  it("keeps the stacking order of media from before `z` keys", () => {
    const m = (id) => ({ id, y: 0 });
    const merged = mergeNoteParts(
      { id: "n", modified: 2, media: [m("back"), m("front")] },
      { id: "n", modified: 1, media: [m("back"), m("front")] },
    ).parts.media;
    expect(merged.map((x) => x.id)).toEqual(["back", "front"]);
  });

  it("refuses to merge an encrypted note or encrypted strokes", () => {
    expect(attemptMerge({ id: "n", encrypted: true }, { id: "n" })).toBeNull();
    expect(attemptMerge({ id: "n" }, { id: "n", strokes: { data: "x", iv: "y" } })).toBeNull();
    expect(attemptMerge({ id: "n", hasStrokes: true }, { id: "n", strokes: [] })).toBeNull();
  });
});
