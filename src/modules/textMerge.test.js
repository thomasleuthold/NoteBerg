/**
 * src/modules/textMerge.test.js
 * Three-way block merge of note HTML (DESIGN §10.3 B).
 */

import { describe, expect, it, vi } from "vitest";
import { MERGE_HINT_CLASS, mergeContent, segmentBlocks } from "./textMerge.js";

const p = (t) => `<p>${t}</p>`;
const doc = (...ts) => ts.map(p).join("");
const hintCount = (html) =>
  (html.match(new RegExp(`class="${MERGE_HINT_CLASS}"`, "g")) || []).length;
const texts = (html) => segmentBlocks(html).map((b) => b.key);
// Alice is "local" with modified lm; Bob is "remote" with modified rm
const opts = (lm = 2000, rm = 1000) => ({
  localModified: lm,
  remoteModified: rm,
  localAuthor: "alice",
  remoteAuthor: "bob",
});
// The same two notes seen from Bob's side (he is local there)
const optsSeenByBob = (aliceModified = 2000, bobModified = 1000) => ({
  localModified: bobModified,
  remoteModified: aliceModified,
  localAuthor: "bob",
  remoteAuthor: "alice",
});

describe("segmentBlocks", () => {
  it("splits top-level elements and list items into blocks", () => {
    const blocks = segmentBlocks("<p>a</p><ul><li>x</li><li>y</li></ul><h1>t</h1>");
    expect(blocks.map((b) => b.html)).toEqual([
      "<p>a</p>",
      "<li>x</li>",
      "<li>y</li>",
      "<h1>t</h1>",
    ]);
  });

  it("groups contiguous bare text and inline nodes into one pseudo-block", () => {
    const blocks = segmentBlocks("hello <b>bold</b><br>world<p>para</p>");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].html).toContain("<b>bold</b>");
  });

  it("ignores merge-hint spans when computing the comparison key", () => {
    const hinted = `<p>a<span class="${MERGE_HINT_CLASS}" contenteditable="false" data-conflict="x"></span></p>`;
    expect(texts(hinted)).toEqual(texts("<p>a</p>"));
  });

  it("ignores whitespace-only runs between blocks", () => {
    expect(segmentBlocks("<p>a</p>\n  \n<p>b</p>")).toHaveLength(2);
  });
});

describe("mergeContent — non-conflicting cases", () => {
  it("returns identical content untouched", () => {
    expect(mergeContent("x", doc("a"), doc("a"))).toBe(doc("a"));
  });

  it("takes the only side that changed", () => {
    const base = doc("a", "b");
    expect(mergeContent(base, doc("a", "b", "c"), base)).toBe(doc("a", "b", "c"));
    expect(mergeContent(base, base, doc("a", "b", "c"))).toBe(doc("a", "b", "c"));
  });

  it("accepts identical edits from both sides without a hint", () => {
    const merged = mergeContent(doc("a", "b"), doc("a", "B"), doc("a", "B"), opts());
    expect(texts(merged)).toEqual(texts(doc("a", "B")));
    expect(hintCount(merged)).toBe(0);
  });

  it("keeps inserts made in different places", () => {
    const base = doc("a", "b", "c");
    const merged = mergeContent(base, doc("x", "a", "b", "c"), doc("a", "b", "c", "y"), opts());
    expect(texts(merged)).toEqual(texts(doc("x", "a", "b", "c", "y")));
    expect(hintCount(merged)).toBe(0);
  });

  it("merges edits to different blocks", () => {
    const base = doc("one", "two", "three");
    const merged = mergeContent(
      base,
      doc("ONE", "two", "three"),
      doc("one", "two", "THREE"),
      opts(),
    );
    expect(texts(merged)).toEqual(texts(doc("ONE", "two", "THREE")));
    expect(hintCount(merged)).toBe(0);
  });

  it("merges edits to adjacent blocks one by one", () => {
    const base = doc("one", "two");
    const merged = mergeContent(base, doc("ONE", "two"), doc("one", "TWO"), opts());
    expect(texts(merged)).toEqual(texts(doc("ONE", "TWO")));
    expect(hintCount(merged)).toBe(0);
  });

  it("keeps both blocks when both sides insert at the same place", () => {
    const base = doc("a", "b");
    const merged = mergeContent(base, doc("a", "L", "b"), doc("a", "R", "b"), opts());
    expect(texts(merged).sort()).toEqual(texts(doc("a", "L", "R", "b")).sort());
    expect(hintCount(merged)).toBe(0);
    expect(texts(merged)[0]).toBe("<p>a</p>");
    expect(texts(merged).at(-1)).toBe("<p>b</p>");
  });

  it("deletes a block removed on one side and untouched on the other", () => {
    const base = doc("a", "b", "c");
    expect(texts(mergeContent(base, doc("a", "c"), base, opts()))).toEqual(texts(doc("a", "c")));
    expect(texts(mergeContent(base, base, doc("a", "c"), opts()))).toEqual(texts(doc("a", "c")));
  });

  it("applies a deletion on one side next to an edit on the other, with nothing in common", () => {
    expect(mergeContent(doc("a", "b"), doc("b"), doc("a", "B"), opts())).toBe(doc("B"));
    // A deleted block the other side edited stays
    expect(mergeContent(doc("a", "b"), doc("b"), doc("A", "b"), opts())).toBe(doc("A", "b"));
  });

  it("keeps the edit when one side deletes and the other edits the block", () => {
    const base = doc("a", "b", "c");
    const merged = mergeContent(base, doc("a", "c"), doc("a", "B!", "c"), opts());
    expect(texts(merged)).toEqual(texts(doc("a", "B!", "c")));
    expect(hintCount(merged)).toBe(0);
  });

  it("works at list-item granularity and rebuilds the list", () => {
    const base = "<ul><li>a</li><li>b</li></ul>";
    const merged = mergeContent(
      base,
      "<ul><li>A</li><li>b</li></ul>",
      "<ul><li>a</li><li>B</li></ul>",
      opts(),
    );
    expect(merged).toBe("<ul><li>A</li><li>B</li></ul>");
  });

  it("handles bare text without block elements", () => {
    const merged = mergeContent("hello", "hello world", "hello", opts());
    expect(merged).toBe("hello world");
  });

  it("does not throw on malformed HTML", () => {
    expect(() => mergeContent("<p>a", "<p>a<b>x", "<div><p>y</span>", opts())).not.toThrow();
  });
});

describe("mergeContent — conflicts", () => {
  const base = doc("a", "b", "c");
  const local = doc("a", "local edit", "c");
  const remote = doc("a", "remote edit", "c");

  it("keeps both versions of a block edited on both sides and marks the duplicate", () => {
    const merged = mergeContent(base, local, remote, opts(2000, 1000));
    expect(texts(merged)).toEqual(texts(doc("a", "local edit", "remote edit", "c")));
    expect(hintCount(merged)).toBe(1);
  });

  it("puts the later-modified version in place (primary) and attributes the other", () => {
    const merged = mergeContent(base, local, remote, opts(2000, 1000));
    expect(merged.indexOf("local edit")).toBeLessThan(merged.indexOf("remote edit"));
    expect(merged).toContain('data-by="bob"');
    expect(merged).toContain('contenteditable="false"');

    const flipped = mergeContent(base, local, remote, opts(1000, 2000));
    expect(flipped.indexOf("remote edit")).toBeLessThan(flipped.indexOf("local edit"));
    expect(flipped).toContain('data-by="alice"');
  });

  it("omits the author attribute when unknown", () => {
    const merged = mergeContent(base, local, remote, { localModified: 2, remoteModified: 1 });
    expect(merged).not.toContain("data-by");
  });

  it("uses a deterministic conflict id", () => {
    const id = (html) => html.match(/data-conflict="([^"]+)"/)[1];
    expect(id(mergeContent(base, local, remote, opts()))).toBe(
      id(mergeContent(base, remote, local, optsSeenByBob(2000, 1000))),
    );
  });

  it("keeps both blocks when the edited blocks differ in count", () => {
    const merged = mergeContent(doc("a", "b"), doc("a", "b1", "b2"), doc("a", "bx"), opts());
    expect(merged).toContain("b1");
    expect(merged).toContain("b2");
    expect(merged).toContain("bx");
    expect(hintCount(merged)).toBe(1);
  });

  it("keeps the hint of a duplicated list item inside the item", () => {
    const merged = mergeContent(
      "<ul><li>a</li></ul>",
      "<ul><li>L</li></ul>",
      "<ul><li>R</li></ul>",
      opts(),
    );
    expect(merged).toMatch(
      /^<ul><li>L<\/li><li>R<span class="merge-hint"[^>]*><\/span><\/li><\/ul>$/,
    );
  });

  it("puts the hint beside a table kept twice instead of inside it", () => {
    // Merged cells: a table the row/cell merge does not line up is kept whole twice
    const spanned = (x) => `<table><tr><td colspan="2">${x}</td></tr></table>`;
    const merged = mergeContent(spanned("a"), spanned("L"), spanned("R"), opts());
    expect(merged).toMatch(/<\/table><div><span class="merge-hint"/);
  });

  it.each([
    "figure",
    "details",
    "svg",
  ])("puts the hint beside a <%s> block instead of inside it", (tag) => {
    const block = (x) => `<${tag}>${x}</${tag}>`;
    const merged = mergeContent(block("a"), block("L"), block("R"), opts());
    expect(merged).toMatch(new RegExp(`</${tag}><div><span class="merge-hint"`));
  });
});

describe("mergeContent — convergence and idempotency", () => {
  const scenarios = {
    "same-block conflict": [doc("a", "b", "c"), doc("a", "L", "c"), doc("a", "R", "c")],
    "different blocks": [doc("a", "b", "c"), doc("A", "b", "c"), doc("a", "b", "C")],
    "same-gap inserts": [doc("a", "b"), doc("a", "L", "b"), doc("a", "R", "b")],
    "delete vs edit": [doc("a", "b", "c"), doc("a", "c"), doc("a", "B", "c")],
    "delete one, edit the other": [doc("a", "b"), doc("b"), doc("a", "B")],
    "no baseline": [null, doc("a", "L", "c"), doc("a", "R", "c")],
    "list conflict": [
      "<ul><li>a</li></ul>",
      "<ul><li>L</li></ul>",
      "<ul><li>R</li><li>z</li></ul>",
    ],
  };

  for (const [name, [base, a, b]] of Object.entries(scenarios)) {
    it(`converges regardless of who merges (${name})`, () => {
      const mergedByA = mergeContent(base, a, b, opts(2000, 1000));
      const mergedByB = mergeContent(base, b, a, optsSeenByBob(2000, 1000));
      expect(mergedByB).toBe(mergedByA);
    });

    it(`is idempotent: merging the result against either input adds nothing (${name})`, () => {
      const m = mergeContent(base, a, b, opts(2000, 1000));
      // The side that produced `m` and the other side both see no new conflict
      expect(texts(mergeContent(base, b, m, opts(1000, 3000)))).toEqual(texts(m));
      expect(texts(mergeContent(base, a, m, opts(2000, 3000)))).toEqual(texts(m));
      expect(hintCount(mergeContent(base, b, m, opts(1000, 3000)))).toBe(hintCount(m));
    });
  }

  it("deduplicates a conflict block that two merges both produced", () => {
    const base = doc("a", "b");
    const m = mergeContent(base, doc("a", "L"), doc("a", "R"), opts(2000, 1000));
    // Another client's identical merge result arrives and is merged with ours
    const again = mergeContent(base, m, m.replace("</p>", "</p>"), opts(3000, 3000));
    expect(hintCount(again)).toBe(1);
  });

  it("does not duplicate on a second round trip with a fresh baseline", () => {
    const m = mergeContent(doc("a", "b"), doc("a", "L"), doc("a", "R"), opts());
    expect(mergeContent(m, m, m, opts())).toBe(m);
  });
});

describe("mergeContent — no baseline", () => {
  it("is lossless: blocks present on one side only are kept", () => {
    const merged = mergeContent(
      null,
      doc("a", "only-local", "c"),
      doc("a", "c", "only-remote"),
      opts(),
    );
    expect(merged).toContain("only-local");
    expect(merged).toContain("only-remote");
    expect(hintCount(merged)).toBe(0);
  });

  it("flags differing blocks in the same gap as a conflict", () => {
    const merged = mergeContent(undefined, doc("a", "L", "c"), doc("a", "R", "c"), opts());
    expect(merged).toContain("L");
    expect(merged).toContain("R");
    expect(hintCount(merged)).toBe(1);
  });

  it("treats an empty-string baseline as a real baseline", () => {
    const merged = mergeContent("", doc("L"), doc("R"), opts());
    expect(texts(merged).sort()).toEqual(texts(doc("L", "R")).sort());
    expect(hintCount(merged)).toBe(0);
  });
});

describe("mergeContent — degraded environments", () => {
  it("keeps both versions whole when no HTML parser is available", () => {
    vi.stubGlobal("DOMParser", undefined);
    try {
      const merged = mergeContent(doc("a"), doc("local"), doc("remote"), opts());
      expect(merged).toContain("local");
      expect(merged).toContain("remote");
      expect(hintCount(merged)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("mergeContent - two people typing in the same document", () => {
  const bare = (t) => t; // a bare line: no block element, as the editor's first line is

  it("applies one side's keystrokes to the line the other side merely added next to", () => {
    // Base: the line as Admin last saved it. Alice's merge added her line next to it;
    // Admin kept typing in his line.
    const base = bare("Hello her");
    const remote = `${bare("Hello her")}<p>Hello here is Alice!</p>`;
    const local = bare("Hello here is Admin!");

    const merged = mergeContent(base, local, remote, opts());

    expect(merged).not.toContain("Hello her<");
    expect(merged.match(/Hello here is Admin!/g)).toHaveLength(1);
    expect(merged).toContain("Hello here is Alice!");
  });

  it("gives the same result whichever side merges", () => {
    const base = "<p>old</p>";
    const typed = "<p>old and new</p>";
    const added = "<p>old</p><p>their line</p>";
    const byTyper = mergeContent(base, typed, added, opts());
    const byAdder = mergeContent(base, added, typed, optsSeenByBob());
    expect(texts(byAdder)).toEqual(texts(byTyper));
    expect(texts(byTyper)).toEqual(texts("<p>old and new</p><p>their line</p>"));
  });

  it("does not pile up stale versions over a long typing session", () => {
    let server = "";
    let adminBase = "";
    let aliceBase = "";
    const aliceLine = "<p>Hello here is Alice!</p>";
    for (const admin of ["Hello", "Hello her", "Hello here is", "Hello here is Admin!"]) {
      // Admin saves his line; the server holds whatever merged so far
      server = mergeContent(adminBase, admin, server, optsSeenByBob(2000, 3000));
      adminBase = admin;
      // Alice saves hers
      server = mergeContent(aliceBase, aliceLine, server, opts(3000, 2000));
      aliceBase = aliceLine;
    }
    expect(server.match(/Hello here is Admin!/g)).toHaveLength(1);
    expect(server.match(/Hello here is Alice!/g)).toHaveLength(1);
    expect(server).not.toMatch(/Hello(?: her| here is)?(?!e| is Admin)</);
  });
});

describe("mergeContent — tables", () => {
  // A table as the editor writes it: rows of cells in a tbody
  const table = (...rows) =>
    `<table class="table"><tbody>${rows
      .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  const cellsOf = (html) => {
    const docu = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    return [...docu.querySelectorAll("tr")].map((tr) =>
      [...tr.children].map((td) => {
        const clone = td.cloneNode(true);
        for (const h of clone.querySelectorAll(`.${MERGE_HINT_CLASS}`)) h.remove();
        return clone.textContent;
      }),
    );
  };
  const tableCount = (html) => (html.match(/<table/g) || []).length;
  const base = table(["a", "b"], ["c", "d"]);

  it("merges edits to different cells of the same row", () => {
    const merged = mergeContent(
      base,
      table(["A", "b"], ["c", "d"]),
      table(["a", "B"], ["c", "d"]),
      opts(),
    );
    expect(tableCount(merged)).toBe(1);
    expect(cellsOf(merged)).toEqual([
      ["A", "B"],
      ["c", "d"],
    ]);
    expect(hintCount(merged)).toBe(0);
  });

  it("merges edits to different rows", () => {
    const merged = mergeContent(
      base,
      table(["A", "b"], ["c", "d"]),
      table(["a", "b"], ["c", "D"]),
      opts(),
    );
    expect(cellsOf(merged)).toEqual([
      ["A", "b"],
      ["c", "D"],
    ]);
  });

  it("keeps a row added on one side while the other edits a cell", () => {
    const merged = mergeContent(
      base,
      table(["a", "b"], ["c", "d"], ["e", "f"]),
      table(["a", "B"], ["c", "d"]),
      opts(),
    );
    expect(cellsOf(merged)).toEqual([
      ["a", "B"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("deletes a row removed on one side while the other edits another row", () => {
    const merged = mergeContent(base, table(["c", "d"]), table(["a", "b"], ["c", "D"]), opts());
    expect(cellsOf(merged)).toEqual([["c", "D"]]);
  });

  it("keeps a row deleted on one side and edited on the other (lossless)", () => {
    const merged = mergeContent(base, table(["c", "d"]), table(["A", "b"], ["c", "d"]), opts());
    expect(cellsOf(merged)).toEqual([
      ["A", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps both rows inserted at the same place", () => {
    const merged = mergeContent(
      base,
      table(["a", "b"], ["L", "l"], ["c", "d"]),
      table(["a", "b"], ["R", "r"], ["c", "d"]),
      opts(),
    );
    expect(cellsOf(merged)).toEqual([
      ["a", "b"],
      ["L", "l"],
      ["R", "r"],
      ["c", "d"],
    ]);
  });

  it("takes an identical cell edit once", () => {
    const edited = table(["X", "b"], ["c", "d"]);
    expect(mergeContent(base, edited, edited.replace("table", "table"), opts())).toBe(edited);
    const merged = mergeContent(
      base,
      table(["X", "b"], ["c", "d"]),
      table(["X", "B"], ["c", "d"]),
      opts(),
    );
    expect(cellsOf(merged)[0]).toEqual(["X", "B"]);
  });

  it("keeps both texts in a cell both sides changed differently, and marks the other", () => {
    const merged = mergeContent(
      base,
      table(["L", "b"], ["c", "d"]),
      table(["R", "b"], ["c", "D"]),
      opts(),
    );
    expect(tableCount(merged)).toBe(1);
    expect(hintCount(merged)).toBe(1);
    // Alice (local) is the later one: her text first, Bob's marked after it
    expect(merged).toMatch(/<td>L<div>R<span class="merge-hint"[^>]*data-by="bob"/);
    expect(cellsOf(merged)[1]).toEqual(["c", "D"]);
  });

  it("does not take a number for an edit of another (10 vs 1)", () => {
    const merged = mergeContent(table(["5"]), table(["10"]), table(["1"]), opts());
    expect(hintCount(merged)).toBe(1);
    expect(cellsOf(merged)).toEqual([["101"]]);
  });

  it("keeps the edit when one side empties a cell the other changed", () => {
    const merged = mergeContent(
      base,
      table(["", "b"], ["c", "d"]),
      table(["A!", "b"], ["c", "d"]),
      opts(),
    );
    expect(cellsOf(merged)[0]).toEqual(["A!", "b"]);
  });

  it("ignores attributes: a restyled cell does not conflict with an edit", () => {
    const styled = base.replace("<td>a</td>", '<td style="width: 40px">a</td>');
    const merged = mergeContent(base, styled, table(["A", "b"], ["c", "d"]), opts());
    expect(tableCount(merged)).toBe(1);
    expect(hintCount(merged)).toBe(0);
    expect(cellsOf(merged)[0]).toEqual(["A", "b"]);
  });

  it("keeps header rows in their section", () => {
    const withHead = (h, b1) =>
      `<table><thead><tr><th>${h}</th><th>Qty</th></tr></thead><tbody><tr><td>${b1}</td><td>1</td></tr></tbody></table>`;
    const merged = mergeContent(
      withHead("Item", "x"),
      withHead("Thing", "x"),
      withHead("Item", "y"),
      opts(),
    );
    expect(merged).toContain("<thead><tr><th>Thing</th><th>Qty</th></tr></thead>");
    expect(merged).toContain("<tbody><tr><td>y</td><td>1</td></tr></tbody>");
  });

  it("merges the table among other blocks that changed too", () => {
    const merged = mergeContent(
      p("intro") + base,
      p("Intro!") + table(["A", "b"], ["c", "d"]),
      p("intro") + table(["a", "b"], ["c", "D"]),
      opts(),
    );
    expect(merged.startsWith("<p>Intro!</p>")).toBe(true);
    expect(cellsOf(merged)).toEqual([
      ["A", "b"],
      ["c", "D"],
    ]);
  });

  describe("without a baseline", () => {
    it("merges two versions of one table cell by cell", () => {
      const merged = mergeContent(
        null,
        table(["a", "b"], ["L", "d"]),
        table(["a", "b"], ["R", "d"]),
        opts(),
      );
      expect(tableCount(merged)).toBe(1);
      expect(hintCount(merged)).toBe(1);
    });

    it("keeps two unrelated tables whole", () => {
      const merged = mergeContent(null, table(["x"]), table(["y"]), opts());
      expect(tableCount(merged)).toBe(2);
    });
  });

  describe("shapes it does not line up keep both tables whole", () => {
    it("a column added on one side while the other edits", () => {
      const merged = mergeContent(
        base,
        table(["a", "b", "+"], ["c", "d", "+"]),
        table(["A", "b"], ["c", "d"]),
        opts(),
      );
      expect(tableCount(merged)).toBe(2);
      expect(merged).toMatch(/<\/table><div><span class="merge-hint"/);
    });

    it("merged cells", () => {
      const spanned = (x) =>
        `<table><tbody><tr><td colspan="2">${x}</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>`;
      const merged = mergeContent(spanned("a"), spanned("L"), spanned("R"), opts());
      expect(tableCount(merged)).toBe(2);
    });

    it("a table inside a cell", () => {
      const nested = (x) =>
        `<table><tbody><tr><td><table><tbody><tr><td>${x}</td></tr></tbody></table></td></tr></tbody></table>`;
      const merged = mergeContent(nested("a"), nested("L"), nested("R"), opts());
      expect(tableCount(merged)).toBe(4);
    });
  });
});

describe("mergeContent — tables: convergence and idempotency", () => {
  const table = (...rows) =>
    `<table><tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const scenarios = {
    "different cells": [table(["a", "b"]), table(["A", "b"]), table(["a", "B"])],
    "same cell": [
      table(["a", "b"], ["c", "d"]),
      table(["L", "b"], ["c", "d"]),
      table(["R", "b"], ["c", "D"]),
    ],
    "row added vs cell edit": [
      table(["a"], ["b"]),
      table(["a"], ["b"], ["n"]),
      table(["A"], ["b"]),
    ],
    "rows inserted at one place": [
      table(["a"], ["b"]),
      table(["a"], ["L"], ["b"]),
      table(["a"], ["R"], ["b"]),
    ],
    "row deleted vs other row edited": [table(["a"], ["b"]), table(["b"]), table(["a"], ["B"])],
    "no baseline": [null, table(["s"], ["L"]), table(["s"], ["R"])],
  };

  for (const [name, [base, a, b]] of Object.entries(scenarios)) {
    it(`converges regardless of who merges (${name})`, () => {
      expect(mergeContent(base, b, a, optsSeenByBob(2000, 1000))).toBe(
        mergeContent(base, a, b, opts(2000, 1000)),
      );
    });

    it(`is idempotent: merging the result against either input adds nothing (${name})`, () => {
      const m = mergeContent(base, a, b, opts(2000, 1000));
      expect(mergeContent(base, b, m, opts(1000, 3000))).toBe(m);
      expect(mergeContent(base, a, m, opts(2000, 3000))).toBe(m);
      expect(mergeContent(m, m, m, opts())).toBe(m);
    });
  }
});

describe("mergeContent - the same conflict in two places", () => {
  const table = (...rows) =>
    `<table class="table"><tbody>${rows
      .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;

  it("keeps every row when two rows get the same conflicting cell edit", () => {
    const base = table(["Task A", "TBD"], ["Task B", "TBD"]);
    const merged = mergeContent(
      base,
      table(["Task A", "Yes"], ["Task B", "Yes"]),
      table(["Task A", "No"], ["Task B", "No"]),
      opts(),
    );
    expect(merged).toContain("Task A");
    expect(merged).toContain("Task B");
    expect((merged.match(/<tr/g) || []).length).toBe(2);
    expect(hintCount(merged)).toBe(2);
  });

  it("keeps both versions of two separate blocks edited alike", () => {
    const base = doc("TODO", "middle", "TODO");
    const merged = mergeContent(
      base,
      doc("Done", "middle", "Done"),
      doc("Deferred", "middle", "Deferred"),
      opts(),
    );
    expect(texts(merged)).toEqual([
      p("Done"),
      p("Deferred"),
      p("middle"),
      p("Done"),
      p("Deferred"),
    ]);
    expect(hintCount(merged)).toBe(2);
  });
});
