/**
 * Covers the line-break entries that give recognized text its shape.
 *
 * The rendering rules exist because models place break markers inconsistently:
 * some end every line including the last, some emit runs of them, some open a
 * response with one. Each of those would put blank lines into the text where
 * the page has none, so the renderer is deliberately tolerant and these tests
 * describe what it tolerates.
 */

import { describe, expect, it } from "vitest";
import {
  BREAK_LINE,
  BREAK_PARAGRAPH,
  countWords,
  isBreak,
  makeBreak,
  renderFullText,
} from "./breaks.js";

/** A transcribed word as the pipeline stores it. */
const w = (text) => ({ text, precision: "approximate", boundingRect: null });
const br = (n = BREAK_LINE) => ({ break: n });

describe("isBreak", () => {
  it("recognizes a break entry", () => {
    expect(isBreak({ break: 1 })).toBe(true);
    expect(isBreak({ break: 2 })).toBe(true);
  });

  it("does not mistake a word for a break", () => {
    // The load-bearing case: every consumer of `words` skips entries without
    // text, so a break must never carry any.
    expect(isBreak(w("hello"))).toBe(false);
    expect(isBreak({ text: "\n" })).toBe(false);
  });

  it("rejects malformed entries rather than guessing", () => {
    expect(isBreak(null)).toBe(false);
    expect(isBreak(undefined)).toBe(false);
    expect(isBreak({})).toBe(false);
    expect(isBreak({ break: 0 })).toBe(false);
  });
});

describe("makeBreak", () => {
  it("keeps the counts that mean something", () => {
    expect(makeBreak(1)).toEqual({ break: BREAK_LINE });
    expect(makeBreak(2)).toEqual({ break: BREAK_PARAGRAPH });
  });

  it("clamps an exaggerated gap to a paragraph", () => {
    // A model reporting five blank lines means "new paragraph"; honouring it
    // literally would put a hole in the page.
    expect(makeBreak(9)).toEqual({ break: BREAK_PARAGRAPH });
  });

  it("falls back to a single line break for nonsense", () => {
    expect(makeBreak(0)).toEqual({ break: BREAK_LINE });
    expect(makeBreak(-3)).toEqual({ break: BREAK_LINE });
    expect(makeBreak("x")).toEqual({ break: BREAK_LINE });
    expect(makeBreak(undefined)).toEqual({ break: BREAK_LINE });
  });
});

describe("countWords", () => {
  it("counts words and ignores the breaks between them", () => {
    // The count reaches the user as "Recognized N words"; counting layout would
    // claim the page holds more than it does.
    expect(countWords([w("a"), br(), w("b"), br(2), w("c")])).toBe(3);
  });

  it("is zero for a list of nothing but breaks", () => {
    expect(countWords([br(), br()])).toBe(0);
  });

  it("tolerates a missing list", () => {
    expect(countWords(undefined)).toBe(0);
    expect(countWords(null)).toBe(0);
  });
});

describe("renderFullText", () => {
  it("joins words with spaces when there are no breaks", () => {
    expect(renderFullText([w("hello"), w("world")])).toBe("hello world");
  });

  it("starts a new line at a break", () => {
    expect(renderFullText([w("first"), br(), w("second")])).toBe("first\nsecond");
  });

  it("leaves a blank line between paragraphs", () => {
    expect(renderFullText([w("one"), br(BREAK_PARAGRAPH), w("two")])).toBe("one\n\ntwo");
  });

  it("drops a trailing break so the text does not end in blank lines", () => {
    // A model told to end every line with a break ends the last one too.
    expect(renderFullText([w("only"), br()])).toBe("only");
  });

  it("drops a leading break so the text does not start with a blank line", () => {
    expect(renderFullText([br(), w("first")])).toBe("first");
  });

  it("collapses a run of breaks into the largest gap it names", () => {
    // Repeated markers describe one gap, not one gap each: a model emitting a
    // line-end marker twice between the same two lines means a line break, not
    // a paragraph. The size of the gap comes from the largest marker in the run.
    expect(renderFullText([w("a"), br(), br(), w("b")])).toBe("a\nb");
    expect(renderFullText([w("a"), br(), br(), br(), w("b")])).toBe("a\nb");
    expect(renderFullText([w("a"), br(), br(BREAK_PARAGRAPH), w("b")])).toBe("a\n\nb");
  });

  it("keeps a single line break single", () => {
    expect(renderFullText([w("a"), br(BREAK_LINE), w("b")])).toBe("a\nb");
  });

  it("returns nothing for a list holding only breaks", () => {
    expect(renderFullText([br(), br(2)])).toBe("");
  });

  it("skips words with no usable text rather than emitting stray spaces", () => {
    expect(renderFullText([w("a"), { text: "" }, null, w("b")])).toBe("a b");
  });

  it("tolerates a missing list", () => {
    expect(renderFullText(undefined)).toBe("");
    expect(renderFullText(null)).toBe("");
  });
});
