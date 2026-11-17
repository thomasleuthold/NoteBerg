/**
 * src/modules/textMerge.property.test.js
 * The text merge's guarantees (DESIGN §10.3 B) on random edits of a note with
 * paragraphs and a table: two writers start from one version and change it
 * independently (edit, insert or delete paragraphs; edit cells, add or delete
 * rows). Checked on every pair:
 *
 *  - convergent: both writers merging get the same text
 *  - idempotent: merging the result against either input adds nothing
 *  - lossless: every text either writer typed is still there
 *
 * Seeded, so a failure names the seed that reproduces it.
 */

import { describe, expect, it } from "vitest";
import { mergeContent } from "./textMerge.js";

// Each history parses HTML a dozen times (slow in jsdom): raise locally to stress (1,000 passed)
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

/** A note: paragraphs, then a table (rows of cells), then paragraphs. */
function render({ before, rows, after }) {
  const p = (t) => `<p>${t}</p>`;
  const table = rows.length
    ? `<table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : "";
  return before.map(p).join("") + table + after.map(p).join("");
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
  const steps = 1 + rnd.int(3);
  for (let s = 0; s < steps; s++) {
    const list = rnd.next() < 0.5 ? n.before : n.after;
    switch (rnd.int(6)) {
      case 0:
        if (list.length) list[rnd.int(list.length)] = fresh();
        break;
      case 1:
        list.splice(rnd.int(list.length + 1), 0, fresh());
        break;
      case 2:
        if (list.length) list.splice(rnd.int(list.length), 1);
        break;
      case 3:
        if (n.rows.length) {
          const row = n.rows[rnd.int(n.rows.length)];
          row[rnd.int(row.length)] = fresh();
        }
        break;
      case 4:
        if (n.rows.length) n.rows.splice(rnd.int(n.rows.length + 1), 0, [fresh(), fresh()]);
        break;
      default:
        if (n.rows.length > 1) n.rows.splice(rnd.int(n.rows.length), 1);
    }
  }
  return { note: n, typed };
}

/** Texts deleted by the other writer may go; text a writer typed and kept must stay. */
function stillThere(merged, typed, survivors) {
  return typed.filter((t) => survivors.includes(t) && !merged.includes(t));
}

// Writer A merging (A is local), and writer B merging the same notes (B is local)
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
    before: ["p1", "p2", "p3"].slice(0, 1 + rnd.int(3)),
    rows: [
      ["c1", "c2"],
      ["c3", "c4"],
      ["c5", "c6"],
    ].slice(0, 1 + rnd.int(3)),
    after: ["q1", "q2"].slice(0, rnd.int(3)),
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

describe("text merge laws on random edits (paragraphs and a table)", { timeout: 120_000 }, () => {
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
});
