/**
 * src/modules/textBoxes.test.js
 * The text box model in note HTML (text boxes DESIGN §3.1): parsing,
 * normalization of what old clients and merges leave behind, serialization,
 * wrapping the implicit main box, reading order, and paste clean-up.
 */

import { describe, expect, it } from "vitest";
import {
  boxHtml,
  clampBox,
  fitNewBox,
  inReadingOrder,
  MAIN_BOX_GEOMETRY,
  mayHaveBoxes,
  normalizeContent,
  PAGE_WIDTH,
  parseContent,
  readingOrder,
  readingOrderHtml,
  searchableText,
  serializeContent,
  stripBoxWrappers,
  wrapMainBox,
} from "./textBoxes.js";

const box = (id, x, y, w, inner) =>
  `<div class="text-box" data-box-id="${id}" data-x="${x}" data-y="${y}" data-w="${w}">${inner}</div>`;

// Notes as the editor stores them today, including the odd shapes browsers leave
const LEGACY_NOTES = [
  "",
  "<p>One</p>",
  "Bare first line<br><div>second</div>",
  '<p>Hi <span class="task-text" data-task-id="t1">task</span>&nbsp;</p>',
  "<ul><li>a</li><li>b</li></ul><table><tbody><tr><td>x</td></tr></tbody></table>",
  "<p>a &amp; b &lt; c</p>   <p>spaced</p>\n",
  '<p><img src="data:image/png;base64,AAAA"></p>',
  '<div class="text-boxes-are-not-this">look-alike class</div>',
];

describe("notes without boxes", () => {
  it("parse, normalize and serialize to the same bytes", () => {
    for (const html of LEGACY_NOTES) {
      const parsed = parseContent(html);
      expect(parsed.boxes).toEqual([]);
      expect(parsed.main).toBe(html);
      expect(serializeContent(parsed)).toBe(html);
      expect(normalizeContent(html)).toBe(html);
      expect(readingOrderHtml(html)).toBe(html);
      expect(stripBoxWrappers(html)).toBe(html);
    }
  });

  it("are recognized without parsing", () => {
    expect(mayHaveBoxes("<p>x</p>")).toBe(false);
    expect(mayHaveBoxes(box("tb_1", 0, 0, 400, "<p>x</p>"))).toBe(true);
  });
});

describe("parseContent", () => {
  it("splits the main box from the boxes, in DOM order", () => {
    const html = `<p>Main</p>${box("tb_a", 640, 312, 400, "<p>A</p>")}${box("tb_b", 80, 1440, 320, "<p>B</p>")}`;
    const parsed = parseContent(html);
    expect(parsed.main).toBe("<p>Main</p>");
    expect(parsed.boxes).toEqual([
      { id: "tb_a", x: 640, y: 312, w: 400, html: "<p>A</p>" },
      { id: "tb_b", x: 80, y: 1440, w: 320, html: "<p>B</p>" },
    ]);
    expect(serializeContent(parsed)).toBe(html);
  });

  it("moves text an old client typed after a box into that box", () => {
    const html = `<p>Main</p>${box("tb_a", 0, 400, 400, "<p>A</p>")}<p>typed at the end</p>`;
    const parsed = parseContent(html);
    expect(parsed.main).toBe("<p>Main</p>");
    expect(parsed.boxes[0].html).toBe("<p>A</p><p>typed at the end</p>");
  });

  it("drops whitespace between boxes", () => {
    const html = `${box("tb_a", 0, 0, 400, "<p>A</p>")}\n  ${box("tb_b", 0, 200, 400, "<p>B</p>")}`;
    expect(parseContent(html).boxes.map((b) => b.html)).toEqual(["<p>A</p>", "<p>B</p>"]);
  });

  it("gives the second of two boxes with one id (an old client's merge) a new id", () => {
    const html = `${box("tb_a", 0, 0, 400, "<p>moved</p>")}${box("tb_a", 0, 0, 400, "<p>edited</p>")}`;
    const [first, second] = parseContent(html).boxes;
    expect(first.id).toBe("tb_a");
    expect(second.id).not.toBe("tb_a");
    expect(second.id).toMatch(/^tb_/);
    expect(second.html).toBe("<p>edited</p>");
  });

  it("gives a box without an id one", () => {
    const html = '<div class="text-box" data-x="10" data-y="20" data-w="300"><p>x</p></div>';
    expect(parseContent(html).boxes[0].id).toMatch(/^tb_/);
  });

  it("keeps the text of a box whose geometry was stripped or damaged, and marks it unplaced", () => {
    for (const attrs of [
      "",
      'data-x="a" data-y="1" data-w="400"',
      'data-x="-5" data-y="1" data-w="400"',
      'data-x="1000" data-y="1" data-w="400"',
      'data-x="0" data-y="1" data-w="10"',
    ]) {
      const html = `<div class="text-box" data-box-id="tb_d" ${attrs}><p>kept</p></div>`;
      const [parsed] = parseContent(html).boxes;
      expect(parsed.html, attrs).toBe("<p>kept</p>");
      expect(parsed.y, attrs).toBeNull();
      expect(parsed.w, attrs).toBe(400);
    }
  });

  it("unwraps a box nested in another box or element", () => {
    const html = box("tb_o", 0, 0, 400, `<p>outer</p>${box("tb_i", 10, 10, 200, "<p>inner</p>")}`);
    const parsed = parseContent(html);
    expect(parsed.boxes).toHaveLength(1);
    expect(parsed.boxes[0].html).toBe("<p>outer</p><p>inner</p>");

    const inList = `<ul><li>${box("tb_x", 0, 0, 400, "x")}</li></ul>`;
    expect(parseContent(inList)).toEqual({ main: "<ul><li>x</li></ul>", boxes: [] });
  });
});

describe("serialize", () => {
  it("writes geometry as integer attributes, never as style", () => {
    const html = boxHtml({ id: "tb_1", x: 10.4, y: 20.6, w: 300, html: "<p>x</p>" });
    expect(html).toBe(
      '<div class="text-box" data-box-id="tb_1" data-x="10" data-y="21" data-w="300"><p>x</p></div>',
    );
    expect(html).not.toContain("style");
  });

  it("normalizes a note once and then leaves it alone", () => {
    const html = `<p>M</p>${box("tb_a", 0, 400, 400, "<p>A</p>")}<p>tail</p>${box("tb_a", 0, 900, 400, "<p>B</p>")}`;
    const once = normalizeContent(html);
    expect(normalizeContent(once)).toBe(once);
  });
});

describe("wrapMainBox", () => {
  it("wraps the main text first, at the geometry that keeps its text in place", () => {
    const parsed = parseContent(`<p>Main</p>${box("tb_a", 640, 312, 400, "<p>A</p>")}`);
    const { parsed: wrapped, box: main } = wrapMainBox(parsed, "tb_m");
    expect(main).toEqual({ id: "tb_m", ...MAIN_BOX_GEOMETRY, html: "<p>Main</p>" });
    expect(wrapped.main).toBe("");
    expect(wrapped.boxes.map((b) => b.id)).toEqual(["tb_m", "tb_a"]);
    // Text origin 46/16 and text column 1134 px wide, as the main box had
    expect(MAIN_BOX_GEOMETRY).toEqual({ x: 38, y: 12, w: 1150 });
  });
});

describe("reading order", () => {
  it("is top to bottom, then left to right, main text first", () => {
    const boxes = [
      { id: "c", x: 600, y: 100, w: 300 },
      { id: "a", x: 0, y: 100, w: 300 },
      { id: "b", x: 0, y: 50, w: 300 },
      { id: "u", x: 0, y: null, w: 300 },
    ];
    expect(readingOrder(boxes).map((b) => b.id)).toEqual(["b", "a", "c", "u"]);
    const html = `<p>M</p>${box("tb_2", 0, 500, 400, "<p>second</p>")}${box("tb_1", 0, 100, 400, "<p>first</p>")}`;
    expect(readingOrderHtml(html)).toBe("<p>M</p><p>first</p><p>second</p>");
  });
});

describe("text outputs", () => {
  const html = `<p>Main &amp; more</p>${box("tb_2", 0, 500, 400, "<p>second</p>")}${box("tb_1", 640, 100, 400, "<p>first</p>")}`;

  it("lists boxes in reading order with their wrappers and positions (MCP, previews)", () => {
    expect(inReadingOrder(html)).toBe(
      `<p>Main &amp; more</p>${box("tb_1", 640, 100, 400, "<p>first</p>")}${box("tb_2", 0, 500, 400, "<p>second</p>")}`,
    );
    for (const legacy of LEGACY_NOTES) expect(inReadingOrder(legacy)).toBe(legacy);
  });

  it("gives search the words only: no markup, no box positions, blocks apart", () => {
    const text = searchableText(html);
    expect(text).toContain("Main & more");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text).not.toMatch(/text-box|data-|640|400|<|>/);
    expect(searchableText("<p>one</p><p>two</p>")).toMatch(/one\s+two/);
    expect(searchableText("<p>bo<b>ld</b></p>")).toContain("bold");
    expect(
      searchableText('<p><span class="task-text" data-task-id="t1">x</span></p>'),
    ).not.toContain("task");
  });
});

describe("pasted HTML", () => {
  it("loses box wrappers, keeps their text", () => {
    const html = `<p>a</p>${box("tb_1", 0, 0, 400, "<p>b</p>")}`;
    expect(stripBoxWrappers(html)).toBe("<p>a</p><p>b</p>");
  });
});

describe("placement", () => {
  it("shrinks a new box near the right edge before moving it left", () => {
    expect(fitNewBox(100)).toEqual({ x: 100, w: 400 });
    expect(fitNewBox(PAGE_WIDTH - 400)).toEqual({ x: 800, w: 400 });
    expect(fitNewBox(PAGE_WIDTH - 300)).toEqual({ x: 900, w: 300 });
    expect(fitNewBox(PAGE_WIDTH - 200)).toEqual({ x: 1000, w: 200 });
    expect(fitNewBox(PAGE_WIDTH - 50)).toEqual({ x: 1000, w: 200 });
  });

  it("keeps a box on the page", () => {
    expect(clampBox({ x: -20, y: -5, w: 300 })).toEqual({ x: 0, y: 0, w: 300 });
    expect(clampBox({ x: 1100, y: 10, w: 300 })).toEqual({ x: 900, y: 10, w: 300 });
    expect(clampBox({ x: 0, y: 0, w: 20 })).toEqual({ x: 0, y: 0, w: 80 });
  });
});
