/**
 * Search wildcard semantics.
 *
 * These rules are user-facing and are now shared by every search surface —
 * recognised handwriting, the text layer, PDF text. Each place used to build the
 * expression itself, so the same query could behave differently depending on
 * where the text lived. These tests pin the behaviour that all of them inherit.
 */

import { describe, expect, it } from "vitest";
import { searchRegex } from "./searchPattern.js";

const matches = (query, text) => {
  const re = searchRegex(query);
  re.lastIndex = 0;
  return re.test(text);
};

describe("searchRegex", () => {
  it("matches a plain query regardless of case", () => {
    expect(matches("stroke", "Stroke")).toBe(true);
    expect(matches("STROKE", "stroke")).toBe(true);
  });

  it("finds the query inside a longer word", () => {
    // Recognition returns whole words including punctuation, so "stroke" has to
    // find "strokes." or a search over handwriting misses most of its hits.
    expect(matches("stroke", "strokes.")).toBe(true);
  });

  it("treats * as any run of characters", () => {
    expect(matches("str*ke", "strike")).toBe(true);
    expect(matches("str*ke", "stroooooke")).toBe(true);
  });

  it("treats ? as exactly one character", () => {
    expect(matches("str?ke", "stroke")).toBe(true);
    expect(matches("str?ke", "strke")).toBe(false);
  });

  it("treats regex punctuation in a query as literal text", () => {
    // Without escaping, a query containing "." or "(" would either match the
    // wrong thing or throw while compiling.
    expect(matches("a.b", "a.b")).toBe(true);
    expect(matches("a.b", "axb")).toBe(false);
    expect(matches("cost (net)", "the cost (net) today")).toBe(true);
  });

  it("does not throw on a query of only regex metacharacters", () => {
    expect(() => searchRegex("[(+")).not.toThrow();
    expect(matches("[(+", "x [(+ y")).toBe(true);
  });

  it("is global, so one line can yield several matches", () => {
    const re = searchRegex("ab");
    expect("abab".match(re)).toHaveLength(2);
  });

  it("wraps the pattern in a group when asked, for callers that split on it", () => {
    // The text and PDF layers split on the match to wrap it in <mark>, which
    // only keeps the matched text if the pattern is a capture group.
    const parts = "a stroke here".split(searchRegex("stroke", { capture: true }));
    expect(parts).toContain("stroke");
  });

  it("keeps the match out of the split result without capture", () => {
    const parts = "a stroke here".split(searchRegex("stroke"));
    expect(parts).not.toContain("stroke");
  });
});
