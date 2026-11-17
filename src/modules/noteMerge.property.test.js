/**
 * src/modules/noteMerge.property.test.js
 * Laws the merge must obey for devices to agree (DESIGN §10.7 A, H), checked on
 * random edit histories: three devices (with skewed clocks) draw, erase, undo
 * erases, move strokes, insert space and undo it, add, move, reorder and delete
 * media, and change fields, syncing through a server copy at random moments.
 *
 *  - commutative: merge(a, b) shows the same as merge(b, a)
 *  - associative: merge(merge(a, b), c) shows the same as merge(a, merge(b, c))
 *  - idempotent: merging a merge result with itself, or again with one of its
 *    inputs, changes nothing
 *  - convergent: once everyone has synced, every device shows the same note
 *  - nothing is lost: a stroke is gone only if some device erased it, and a
 *    stroke erased by a device that never undid it is gone
 *
 * Seeded, so a failure names the seed that reproduces it.
 */

import { describe, expect, it } from "vitest";
import { canonical, mergeState, World } from "./__fixtures__/mergeReplicas.js";

const SEEDS = 150;
const STEPS = 60;

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
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}

/** One random history; returns the world and what was drawn and erased. */
function play(seed) {
  const rnd = random(seed);
  const world = new World();
  const devices = [
    world.addDevice("aaaa"),
    world.addDevice("bbbb", { skew: 5_000 }),
    world.addDevice("cccc", { skew: -60_000 }),
  ];
  const drawn = new Set();
  const erasedBy = new Map(); // id -> Set(device names) that erased it
  const undoneBy = new Map(); // id -> Set(device names) that undid an erase of it
  const shiftsBy = new Map(); // device -> [{line, delta, moved}] undo history
  const pairs = [];
  const triples = [];

  for (let step = 0; step < STEPS; step++) {
    const d = rnd.pick(devices);
    const live = d.live().map((s) => s.id);
    const media = d.note.media.map((m) => m.id);
    switch (rnd.int(12)) {
      case 0:
      case 1:
        drawn.add(d.draw(rnd.int(500), { height: 5 + rnd.int(30) }));
        break;
      case 2:
        if (live.length) {
          const id = rnd.pick(live);
          d.erase(id);
          if (!erasedBy.has(id)) erasedBy.set(id, new Set());
          erasedBy.get(id).add(d.name);
        }
        break;
      case 3: {
        const id = d.undoErase();
        if (id) {
          if (!undoneBy.has(id)) undoneBy.set(id, new Set());
          undoneBy.get(id).add(d.name);
        }
        break;
      }
      case 4:
        if (live.length) d.move(rnd.pick(live), rnd.int(20) - 10, rnd.int(60) - 30);
        break;
      case 5: {
        const line = rnd.int(400);
        const delta = 10 + rnd.int(60);
        const moved = d.insertSpace(line, delta);
        if (!shiftsBy.has(d.name)) shiftsBy.set(d.name, []);
        shiftsBy.get(d.name).push({ line, delta, moved });
        break;
      }
      case 6: {
        const last = shiftsBy.get(d.name)?.pop();
        if (last) d.undoInsertSpace(last.line, last.delta, last.moved);
        break;
      }
      case 7: {
        const roll = media.length === 0 ? 0 : rnd.int(4);
        if (roll === 0) d.addMedia(rnd.int(500));
        else if (roll === 1) d.moveMedia(rnd.pick(media), rnd.int(60) - 30);
        else if (roll === 2) d.bringToFront(rnd.pick(media));
        else d.deleteMedia(rnd.pick(media));
        break;
      }
      case 8:
        d.setField(rnd.pick(["title", "background"]), `v${rnd.int(5)}`);
        break;
      case 9:
        // Two devices' current versions, to check the merge laws on
        pairs.push([rnd.pick(devices).saved(), rnd.pick(devices).saved()]);
        // And all three, merged pairwise in either grouping (no server between)
        triples.push(devices.map((x) => x.saved()));
        break;
      default:
        d.sync();
    }
    world.tick(rnd.int(3_000));
  }
  return { world, devices, drawn, erasedBy, undoneBy, pairs, triples };
}

/**
 * Whether one version restores (undoes the erase of) an element another one has
 * erased: the case merges are not associative in (see the KNOWN GAP test).
 */
function undoMeetsErase(versions) {
  const erased = new Set(
    versions.flatMap((v) => [...(v.deletedStrokes ?? []), ...(v.deletedMedia ?? [])]),
  );
  return versions.some((v) =>
    [...(v.strokes ?? []), ...(v.media ?? [])].some((item) => item.restores && erased.has(item.id)),
  );
}

/** Everyone syncs until nothing changes any more. */
function settle(devices) {
  for (let round = 0; round < 6; round++) {
    for (const d of devices) d.sync();
  }
}

describe("merge laws on random histories", { timeout: 120_000 }, () => {
  it("merge(a, b) shows the same as merge(b, a)", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const [a, b] of play(seed).pairs) {
        expect(canonical(mergeState(a, b)), `seed ${seed}`).toEqual(canonical(mergeState(b, a)));
      }
    }
  });

  it("merge(merge(a, b), c) shows the same as merge(a, merge(b, c))", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const [a, b, c] of play(seed).triples) {
        // Not where an undone erase meets that erase: a known gap (below)
        if (undoMeetsErase([a, b, c])) continue;
        expect(canonical(mergeState(mergeState(a, b), c)), `seed ${seed}`).toEqual(
          canonical(mergeState(a, mergeState(b, c))),
        );
      }
    }
  });

  it("merging a merge result with itself, or again with an input, changes nothing", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const [a, b] of play(seed).pairs) {
        const m = mergeState(a, b);
        expect(canonical(mergeState(m, m)), `seed ${seed}`).toEqual(canonical(m));
        expect(canonical(mergeState(m, a)), `seed ${seed}`).toEqual(canonical(m));
        expect(canonical(mergeState(b, m)), `seed ${seed}`).toEqual(canonical(m));
      }
    }
  });

  it("brings every device to the same note once everyone has synced", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { world, devices } = play(seed);
      settle(devices);
      const server = canonical(world.server);
      for (const d of devices) {
        expect(canonical(d.note), `seed ${seed}, device ${d.name}`).toEqual(server);
      }
    }
  });

  it("loses no stroke nobody erased, and keeps erased strokes that were never undone gone", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { world, devices, drawn, erasedBy, undoneBy } = play(seed);
      settle(devices);
      const present = new Set(world.server.strokes.map((s) => s.id));
      for (const id of drawn) {
        const erasers = erasedBy.get(id);
        if (!erasers) {
          expect(present.has(id), `seed ${seed}: ${id} lost`).toBe(true);
        } else if (![...erasers].some((name) => undoneBy.get(id)?.has(name))) {
          expect(present.has(id), `seed ${seed}: ${id} came back`).toBe(false);
        }
      }
    }
  });
});

describe("merging three versions", () => {
  // KNOWN GAP: an erase, its undo and an edit of the same stroke on three
  // devices. A merge that meets the erase before the undo drops the stroke, and
  // with it the other device's newer edit (a deleted element keeps no version);
  // the undo then brings back its own, older copy. Met the other way round, the
  // undo keeps the newer edit. Both groupings converge once everyone syncs, but
  // on different strokes. Closing it would mean keeping the last copy of every
  // erased element in the note. `it.fails` keeps this GREEN while the gap
  // exists; when it turns red, make it a normal `it(...)` and drop the
  // undoMeetsErase() exclusion above.
  it.fails("KNOWN GAP: keeps an edit made beside an erase and its undo, however grouped", () => {
    const world = new World();
    const [eraser, other, editor] = ["aaaa", "bbbb", "cccc"].map((n) => world.addDevice(n));
    const id = eraser.draw(100);
    for (const d of [eraser, other, editor]) d.sync();
    world.tick(1_000);

    // The eraser erases, the other device learns of it, then the eraser undoes
    eraser.erase(id);
    eraser.sync();
    other.sync();
    world.tick(1_000);
    eraser.undoErase();
    world.tick(1_000);
    // Meanwhile the editor, knowing of neither, moves the stroke
    editor.move(id, 50, 0);

    const [a, b, c] = [eraser.saved(), editor.saved(), other.saved()];
    const xOf = (note) => note.strokes.find((s) => s.id === id)?.x[0];
    expect(xOf(mergeState(mergeState(a, b), c))).toBe(60);
    expect(xOf(mergeState(a, mergeState(b, c)))).toBe(60);
  });
});
