/**
 * src/modules/textMerge.boxes.test.js
 * The merge of text boxes (text boxes DESIGN §6): a box both sides changed is
 * merged as a unit (geometry per attribute by the side that changed it, inner
 * HTML by the block merge), instead of being kept twice with a conflict hint.
 */

import { describe, expect, it } from "vitest";
import { parseContent } from "./textBoxes.js";
import { mergeContent } from "./textMerge.js";

const box = (id, x, y, w, inner) =>
  `<div class="text-box" data-box-id="${id}" data-x="${x}" data-y="${y}" data-w="${w}">${inner}</div>`;

const LOCAL_NEWER = { localModified: 2000, remoteModified: 1000, remoteAuthor: "Bob" };
const REMOTE_NEWER = { localModified: 1000, remoteModified: 2000, remoteAuthor: "Bob" };

const boxesOf = (html) => parseContent(html).boxes;

describe("box merge", () => {
  const base = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one</p><p>two</p>")}`;

  it("keeps a move on one side and an edit on the other in one box", () => {
    const moved = `<p>Main</p>${box("tb_a", 300, 500, 400, "<p>one</p><p>two</p>")}`;
    const edited = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one</p><p>two!</p>")}`;
    for (const opts of [LOCAL_NEWER, REMOTE_NEWER]) {
      const merged = mergeContent(base, moved, edited, opts);
      expect(merged).not.toContain("merge-hint");
      expect(boxesOf(merged)).toEqual([
        { id: "tb_a", x: 300, y: 500, w: 400, html: "<p>one</p><p>two!</p>" },
      ]);
    }
  });

  it("keeps a move on one side and a resize on the other", () => {
    const moved = `<p>Main</p>${box("tb_a", 300, 500, 400, "<p>one</p><p>two</p>")}`;
    const resized = `<p>Main</p>${box("tb_a", 100, 200, 250, "<p>one</p><p>two</p>")}`;
    const merged = mergeContent(base, moved, resized, LOCAL_NEWER);
    expect(boxesOf(merged)[0]).toMatchObject({ x: 300, y: 500, w: 250 });
  });

  it("keeps an insert-space on one device and an edit of the box on the other", () => {
    const shifted = `<p>Main</p>${box("tb_a", 100, 320, 400, "<p>one</p><p>two</p>")}`;
    const edited = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one</p><p>two, edited</p>")}`;
    for (const [a, b] of [
      [shifted, edited],
      [edited, shifted],
    ]) {
      expect(boxesOf(mergeContent(base, a, b, LOCAL_NEWER))).toEqual([
        { id: "tb_a", x: 100, y: 320, w: 400, html: "<p>one</p><p>two, edited</p>" },
      ]);
    }
  });

  it("takes the later move when both moved the box", () => {
    const a = `<p>Main</p>${box("tb_a", 300, 500, 400, "<p>one</p><p>two</p>")}`;
    const b = `<p>Main</p>${box("tb_a", 700, 900, 400, "<p>one</p><p>two</p>")}`;
    expect(boxesOf(mergeContent(base, a, b, LOCAL_NEWER))[0]).toMatchObject({ x: 300, y: 500 });
    expect(boxesOf(mergeContent(base, a, b, REMOTE_NEWER))[0]).toMatchObject({ x: 700, y: 900 });
    // Both writers get the same result
    expect(mergeContent(base, b, a, REMOTE_NEWER)).toBe(mergeContent(base, a, b, LOCAL_NEWER));
  });

  it("merges edits of different paragraphs in one box", () => {
    const a = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>ONE</p><p>two</p>")}`;
    const b = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one</p><p>TWO</p>")}`;
    expect(boxesOf(mergeContent(base, a, b, LOCAL_NEWER))[0].html).toBe("<p>ONE</p><p>TWO</p>");
  });

  it("keeps both versions of one paragraph edited on both sides inside the box", () => {
    const a = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one A</p><p>two</p>")}`;
    const b = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one B</p><p>two</p>")}`;
    const merged = mergeContent(base, a, b, LOCAL_NEWER);
    const boxes = boxesOf(merged);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].html).toContain("one A");
    expect(boxes[0].html).toContain("one B");
    expect(boxes[0].html).toContain("merge-hint");
    // Nothing outside the box
    expect(parseContent(merged).main).toBe("<p>Main</p>");
  });

  it("keeps a box deleted on one side and edited on the other", () => {
    const deleted = "<p>Main</p>";
    const edited = `<p>Main</p>${box("tb_a", 100, 200, 400, "<p>one</p><p>two!</p>")}`;
    const merged = mergeContent(base, deleted, edited, LOCAL_NEWER);
    expect(boxesOf(merged).map((b) => b.html)).toEqual(["<p>one</p><p>two!</p>"]);
  });

  it("deletes a box deleted on one side and untouched on the other", () => {
    const deleted = "<p>Main</p>";
    const other = `<p>Main!</p>${box("tb_a", 100, 200, 400, "<p>one</p><p>two</p>")}`;
    expect(mergeContent(base, deleted, other, LOCAL_NEWER)).toBe("<p>Main!</p>");
  });

  it("keeps new boxes from both sides", () => {
    const a = `${base}${box("tb_n1", 0, 900, 400, "<p>from A</p>")}`;
    const b = `${base}${box("tb_n2", 600, 900, 400, "<p>from B</p>")}`;
    const ids = boxesOf(mergeContent(base, a, b, LOCAL_NEWER)).map((x) => x.id);
    expect(ids.sort()).toEqual(["tb_a", "tb_n1", "tb_n2"]);
  });

  it("merges a box changed on both sides next to other changes", () => {
    const tail = (inner) => box("tb_t", 0, 1200, 400, inner);
    const base2 = `<p>p1</p><p>p2</p>${box("tb_a", 100, 200, 400, "<p>one</p>")}${tail("<p>tail</p>")}`;
    const a = `<p>p1 A</p><p>p2</p>${box("tb_a", 100, 600, 400, "<p>one</p>")}${tail("<p>tail</p>")}`;
    const b = `<p>p1</p><p>p2</p>${box("tb_a", 100, 200, 400, "<p>one B</p>")}${tail("<p>tail B</p>")}`;
    const merged = mergeContent(base2, a, b, LOCAL_NEWER);
    expect(merged).not.toContain("merge-hint");
    expect(parseContent(merged).main).toBe("<p>p1 A</p><p>p2</p>");
    expect(boxesOf(merged)).toEqual([
      { id: "tb_a", x: 100, y: 600, w: 400, html: "<p>one B</p>" },
      { id: "tb_t", x: 0, y: 1200, w: 400, html: "<p>tail B</p>" },
    ]);
  });

  it("is idempotent: the result merged against either input adds nothing", () => {
    const a = `<p>Main</p>${box("tb_a", 300, 500, 400, "<p>one</p><p>two</p>")}`;
    const b = `<p>Main</p>${box("tb_a", 100, 200, 250, "<p>one</p><p>two!</p>")}`;
    const m = mergeContent(base, a, b, LOCAL_NEWER);
    expect(mergeContent(base, a, m, { localModified: 2000, remoteModified: 3000 })).toBe(m);
    expect(mergeContent(base, b, m, { localModified: 1000, remoteModified: 3000 })).toBe(m);
  });

  it("deletes a box on one side and edits a paragraph next to it on the other, without a conflict", () => {
    // In the HTML the box sits right after the paragraph; the two changes touch
    // neighbouring blocks, which the flow merge alone could only keep twice
    const base2 = `<p>m1</p><p>m2</p>${box("tb_1", 600, 120, 400, "<p>b1</p>")}${box("tb_2", 80, 960, 320, "<p>c1</p>")}`;
    const a = `<p>m1</p><p>m2</p>${box("tb_2", 80, 960, 320, "<p>c1 A</p>")}`;
    const b = `<p>m1</p><p>m2 B</p>${box("tb_1", 600, 120, 400, "<p>b1</p>")}${box("tb_2", 80, 960, 160, "<p>c1</p>")}`;
    const merged = mergeContent(base2, a, b, LOCAL_NEWER);
    expect(merged).not.toContain("merge-hint");
    expect(parseContent(merged)).toEqual({
      main: "<p>m1</p><p>m2 B</p>",
      boxes: [{ id: "tb_2", x: 80, y: 960, w: 160, html: "<p>c1 A</p>" }],
    });
  });

  it("merges an edit of the main text into the main box the other side wrapped", () => {
    const legacy = "<p>one</p><p>two</p>";
    const wrapped = box("tb_m", 38, 300, 1150, "<p>one</p><p>two</p>");
    const edited = "<p>one</p><p>two, edited</p>";
    for (const [x, y] of [
      [wrapped, edited],
      [edited, wrapped],
    ]) {
      const merged = mergeContent(legacy, x, y, LOCAL_NEWER);
      expect(parseContent(merged)).toEqual({
        main: "",
        boxes: [{ id: "tb_m", x: 38, y: 300, w: 1150, html: "<p>one</p><p>two, edited</p>" }],
      });
    }
  });

  it("gives the same ids to boxes an old client duplicated, on both writers", () => {
    const base2 = box("tb_a", 0, 0, 400, "<p>x</p>");
    const dup = `${box("tb_a", 0, 0, 400, "<p>x</p>")}${box("tb_a", 0, 0, 400, "<p>x y</p>")}`;
    const other = box("tb_a", 0, 0, 400, "<p>x</p><p>z</p>");
    const m1 = mergeContent(base2, dup, other, LOCAL_NEWER);
    const m2 = mergeContent(base2, other, dup, REMOTE_NEWER);
    expect(m1).toBe(m2);
    expect(boxesOf(m1).map((b) => b.id)).toEqual(["tb_a", "tb_a~2"]);
  });

  it("leaves notes without boxes to the merge as it was", () => {
    // Same answers as before boxes existed (textMerge.test.js holds the rest)
    expect(mergeContent("<p>a</p><p>b</p>", "<p>A</p><p>b</p>", "<p>a</p><p>B</p>")).toBe(
      "<p>A</p><p>B</p>",
    );
  });
});
