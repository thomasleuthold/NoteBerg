/**
 * src/modules/textMerge.boxes.property.test.js
 * The text merge's guarantees (textMerge.property.test.js) on notes with text
 * boxes (text boxes DESIGN §6): two writers start from one version and change
 * it independently — edit main text, move or resize a box, edit, insert or
 * delete paragraphs in a box, delete a box, add a box. Checked on every pair:
 *
 *  - convergent: both writers merging get the same text
 *  - idempotent: merging the result against either input adds nothing
 *  - lossless: every text either writer typed is still there
 *  - one box per id: a box both sides changed is never kept twice
 *
 * Seeded, so a failure names the seed that reproduces it.
 */

import { describe, expect, it } from "vitest";
import { parseContent } from "./textBoxes.js";
import { mergeContent } from "./textMerge.js";

const SEEDS = 60;

function random(seed) {
  let t = seed >>> 0;
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}

/** A note: main paragraphs, then boxes of paragraphs. */
function render({ main, boxes }) {
  const p = (t) => `<p>${t}</p>`;
  return (
    main.map(p).join("") +
    boxes
      .map(
        (b) =>
          `<div class="text-box" data-box-id="${b.id}" data-x="${b.x}" data-y="${b.y}" data-w="${b.w}">${b.paras.map(p).join("")}</div>`,
      )
      .join("")
  );
}

/** Edit a copy of the note; returns it with the texts this writer typed. */
function edit(note, rnd, who) {
  const n = structuredClone(note);
  const typed = [];
  let counter = 0;
  const fresh = () => {
    const text = `${who}${++counter}x`;
    typed.push(text);
    return text;
  };
  const anyBox = () => (n.boxes.length ? n.boxes[rnd.int(n.boxes.length)] : null);
  const steps = 1 + rnd.int(3);
  for (let s = 0; s < steps; s++) {
    const target = anyBox();
    switch (rnd.int(8)) {
      case 0:
        if (n.main.length) n.main[rnd.int(n.main.length)] = fresh();
        break;
      case 1:
        if (target) {
          target.x = 8 * rnd.int(80);
          target.y = 24 * rnd.int(100);
        }
        break;
      case 2:
        if (target) target.w = 80 + 8 * rnd.int(40);
        break;
      case 3:
        if (target?.paras.length) target.paras[rnd.int(target.paras.length)] = fresh();
        break;
      case 4:
        if (target) target.paras.splice(rnd.int(target.paras.length + 1), 0, fresh());
        break;
      case 5:
        if (target && target.paras.length > 1) target.paras.splice(rnd.int(target.paras.length), 1);
        break;
      case 6:
        if (target) n.boxes.splice(n.boxes.indexOf(target), 1);
        break;
      default:
        n.boxes.push({ id: `tb_${who}${counter}`, x: 600, y: 2400, w: 400, paras: [fresh()] });
    }
  }
  return { note: n, typed };
}

/** Texts deleted by the other writer may go; text a writer typed and kept must stay. */
function stillThere(merged, typed, survivors) {
  return typed.filter((t) => survivors.includes(t) && !merged.includes(t));
}

const byA = (lm, rm) => ({
  localModified: lm,
  remoteModified: rm,
  localAuthor: "a",
  remoteAuthor: "b",
});
const byB = (lm, rm) => ({
  localModified: lm,
  remoteModified: rm,
  localAuthor: "b",
  remoteAuthor: "a",
});

function play(seed) {
  const rnd = random(seed);
  const base = {
    main: ["m1", "m2"].slice(0, rnd.int(3)),
    boxes: [
      { id: "tb_1", x: 600, y: 120, w: 400, paras: ["b1", "b2"] },
      { id: "tb_2", x: 80, y: 960, w: 320, paras: ["c1"] },
      { id: "tb_3", x: 640, y: 1440, w: 400, paras: ["d1", "d2", "d3"] },
    ].slice(0, 1 + rnd.int(3)),
  };
  const a = edit(base, rnd, "A");
  const b = edit(base, rnd, "B");
  return {
    base: render(base),
    a: render(a.note),
    b: render(b.note),
    typedA: a.typed,
    typedB: b.typed,
  };
}

describe("text merge laws on random edits (text boxes)", { timeout: 120_000 }, () => {
  it("gives both writers the same text", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { base, a, b } = play(seed);
      expect(mergeContent(base, b, a, byB(1000, 2000)), `seed ${seed}`).toBe(
        mergeContent(base, a, b, byA(2000, 1000)),
      );
    }
  });

  it("adds nothing when the result is merged against either input", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { base, a, b } = play(seed);
      const m = mergeContent(base, a, b, byA(2000, 1000));
      expect(mergeContent(base, a, m, byA(2000, 3000)), `seed ${seed} (a)`).toBe(m);
      expect(mergeContent(base, b, m, byB(1000, 3000)), `seed ${seed} (b)`).toBe(m);
    }
  });

  it("loses no text a writer typed and kept", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { base, a, b, typedA, typedB } = play(seed);
      const m = mergeContent(base, a, b, byA(2000, 1000));
      expect(stillThere(m, typedA, a), `seed ${seed} (a)`).toEqual([]);
      expect(stillThere(m, typedB, b), `seed ${seed} (b)`).toEqual([]);
    }
  });

  it("keeps every box once, at the top level", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { base, a, b } = play(seed);
      const m = mergeContent(base, a, b, byA(2000, 1000));
      const ids = [...m.matchAll(/data-box-id="([^"]+)"/g)].map((x) => x[1]);
      expect(new Set(ids).size, `seed ${seed}: ${m}`).toBe(ids.length);
      // Parsing finds the same boxes: none nested, none unwrapped text after them
      expect(
        parseContent(m).boxes.map((x) => x.id),
        `seed ${seed}`,
      ).toEqual(ids);
    }
  });
});
