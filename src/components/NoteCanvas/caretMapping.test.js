/**
 * src/components/NoteCanvas/caretMapping.test.js
 * Where the caret goes when the editor's text is replaced by a merged version.
 */

import { describe, expect, it } from "vitest";
import { mapCaretOffset } from "./caretMapping.js";

// The caret is marked "|" in `before`
function map(before, after) {
  const offset = before.indexOf("|");
  return mapCaretOffset(before.replace("|", ""), after, offset);
}
const show = (text, offset) => `${text.slice(0, offset)}|${text.slice(offset)}`;

describe("mapCaretOffset", () => {
  it("keeps the caret where nothing changed", () => {
    expect(show("hello", map("hel|lo", "hello"))).toBe("hel|lo");
  });

  it("keeps the caret where text arrived after it", () => {
    expect(show("hello world", map("hel|lo", "hello world"))).toBe("hel|lo world");
  });

  it("moves the caret with its text when text arrived before it", () => {
    expect(show("bob wrote this. hello", map("hel|lo", "bob wrote this. hello"))).toBe(
      "bob wrote this. hel|lo",
    );
  });

  it("moves the caret back when text before it was removed", () => {
    expect(show("hello", map("gone. hel|lo", "hello"))).toBe("hel|lo");
  });

  it("finds its text again when changes surround it", () => {
    const before = "first line. my sentence is here. last line.";
    const offset = before.indexOf("sentence");
    const after = "FIRST LINE! my sentence is here. LAST LINE!";
    expect(show(after, mapCaretOffset(before, after, offset))).toBe(
      "FIRST LINE! my |sentence is here. LAST LINE!",
    );
  });

  it("stays within the new text when its place is gone", () => {
    expect(mapCaretOffset("abcdef", "xy", 5)).toBeLessThanOrEqual(2);
  });
});
