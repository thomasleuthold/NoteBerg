/**
 * src/modules/liveTakeIn.test.js
 * A take-in computed from the editor's compact view (liveTakeIn.js, run in a
 * worker) must give the editor exactly what merging its whole note with the
 * stored one gave (mergeNoteParts, which the editor ran itself before). Checked
 * on random multi-device histories, then on the cases that matter one by one.
 */

import { describe, expect, it } from "vitest";
import { clone, World } from "./__fixtures__/mergeReplicas.js";
import { computeTakeIn, editorView } from "./liveTakeIn.js";
import { mergeNoteParts } from "./noteMerge.js";

const keyOf = (s) => s.id;
const show = (strokes) =>
  strokes
    .filter((s) => !s._deleted)
    .map((s) => `${s.id}@${s.v ?? ""}:${s.y.join(",")}`)
    .sort();

/** The editor's strokes after applying a delta, as NoteCanvas._applyTakeIn does. */
function applyStrokes(strokes, delta) {
  const { added, changed, order } = delta.strokes;
  if (order) {
    const byId = new Map(strokes.map((s) => [keyOf(s), s]));
    for (const s of [...added, ...changed]) byId.set(keyOf(s), s);
    return order.map((id) => byId.get(id)).filter(Boolean);
  }
  const next = [...strokes];
  const at = new Map(next.map((s, i) => [keyOf(s), i]));
  for (const s of changed) if (at.has(keyOf(s))) next[at.get(keyOf(s))] = s;
  return [...next, ...added];
}

/** Strokes storage holds as the editor holds them: confirmed, not sent again. */
function unconfirmed(editor, stored) {
  const storedV = new Map(stored.strokes.map((s) => [s.id, s.v ?? null]));
  return editor.strokes.filter((s) => !s._deleted && storedV.get(s.id) !== (s.v ?? null));
}

/** A small seeded random generator (mulberry32). */
function random(seed) {
  let t = seed >>> 0;
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}

describe("a take-in computed from the editor's compact view", () => {
  it("gives the editor what merging its whole note gave, on random histories", () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = random(seed);
      const world = new World();
      const editor = world.addDevice("aaaa");
      const others = [world.addDevice("bbbb", { skew: 4_000 }), world.addDevice("cccc")];
      for (let step = 0; step < 50; step++) {
        const d = rnd.int(3) === 0 ? editor : rnd.pick(others);
        const live = d.live().map((s) => s.id);
        const roll = rnd.int(9);
        if (roll < 3) d.draw(rnd.int(400), { height: 5 + rnd.int(20) });
        else if (roll === 3 && live.length) d.erase(rnd.pick(live));
        else if (roll === 4) d.undoErase();
        else if (roll === 5 && live.length) d.move(rnd.pick(live), rnd.int(10), rnd.int(40) - 20);
        else if (roll === 6) d.insertSpace(rnd.int(300), 10 + rnd.int(40));
        else if (roll === 7) d.setField("title", `t${rnd.int(4)}`);
        else d.sync();
        world.tick(rnd.int(2_000));

        if (step % 5 !== 4) continue;
        // The editor takes in what the server holds
        const mine = editor.saved();
        const stored = clone(world.server);
        const expected = mergeNoteParts(mine, stored).parts;
        const delta = computeTakeIn(editorView(mine, unconfirmed(mine, stored)), stored);
        expect(show(applyStrokes(mine.strokes, delta)), `seed ${seed} step ${step}`).toEqual(
          show(expected.strokes),
        );
        expect(delta.parts.deletedStrokes.sort()).toEqual([...expected.deletedStrokes].sort());
        expect(delta.parts.title).toBe(expected.title);
        expect(delta.parts.shifts).toEqual(expected.shifts);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("what comes back", () => {
  function setup() {
    const world = new World();
    const editor = world.addDevice("aaaa");
    const other = world.addDevice("bbbb");
    editor.draw(10, { id: "s1" });
    editor.draw(50, { id: "s2" });
    editor.sync();
    other.sync();
    return { world, editor, other };
  }
  const takeIn = (editor, world) => {
    const mine = editor.saved();
    const stored = clone(world.server);
    return computeTakeIn(editorView(mine, unconfirmed(mine, stored)), stored);
  };

  it("only what arrived, when strokes only arrived", () => {
    const { world, editor, other } = setup();
    other.draw(90, { id: "s3" });
    other.sync();
    const delta = takeIn(editor, world);
    expect(delta.strokes.added.map(keyOf)).toEqual(["s3"]);
    expect(delta.strokes.changed).toEqual([]);
    expect(delta.strokes.order).toBeNull();
    expect(delta.strokesChanged).toBe(false);
  });

  it("the stroke someone else moved, in place", () => {
    const { world, editor, other } = setup();
    other.move("s1", 0, 100);
    other.sync();
    const delta = takeIn(editor, world);
    expect(delta.strokes.changed.map(keyOf)).toEqual(["s1"]);
    expect(delta.strokes.order).toBeNull();
    expect(delta.strokesChanged).toBe(true);
  });

  it("the list in its new order when someone else erased a stroke", () => {
    const { world, editor, other } = setup();
    other.erase("s1");
    other.sync();
    const delta = takeIn(editor, world);
    expect(delta.strokes.removed).toEqual(["s1"]);
    expect(delta.strokes.order).toEqual(["s2"]);
  });

  it("nothing of the editor's own unsaved stroke, which is still to be written", () => {
    const { world, editor } = setup();
    editor.draw(120, { id: "mine" });
    const delta = takeIn(editor, world);
    expect(delta.strokes.added).toEqual([]);
    expect(delta.strokes.removed).toEqual([]);
    expect(delta.strokesAhead).toBe(true);
  });

  it("a stroke storage lost without deleting it, to be saved again", () => {
    const { world, editor } = setup();
    // Storage confirmed s2 earlier, so the editor does not send it again
    const mine = editor.saved();
    world.server.strokes = world.server.strokes.filter((s) => s.id !== "s2");
    const delta = computeTakeIn(editorView(mine, []), clone(world.server));
    expect(delta.strokes.missing).toEqual(["s2"]);
    expect(delta.strokes.removed).toEqual([]);
    expect(delta.strokesAhead).toBe(true);
  });

  it("carries no stroke data for strokes the editor holds as stored", () => {
    const { world, editor } = setup();
    const mine = editor.saved();
    const view = editorView(mine, unconfirmed(mine, clone(world.server)));
    expect(view.changed).toEqual([]);
    expect(view.held).toEqual([
      ["s1", expect.any(String)],
      ["s2", expect.any(String)],
    ]);
  });
});
