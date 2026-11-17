/**
 * src/utils/notebookColor.test.js
 * A notebook's color goes into a style attribute; for a notebook shared with the
 * user another user chose it.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_NOTEBOOK_COLOR, safeNotebookColor } from "./notebookColor.js";

describe("safeNotebookColor", () => {
  it("keeps hex colors in every length CSS accepts", () => {
    for (const color of ["#abc", "#abcd", "#3b82f6", "#3B82F6CC"]) {
      expect(safeNotebookColor(color)).toBe(color);
    }
  });

  it("replaces anything that could leave the attribute or the property", () => {
    for (const color of [
      'red"><img src=x>',
      "red; background-image: url(https://example.com/x)",
      "expression(alert(1))",
      "#12345",
      "",
    ]) {
      expect(safeNotebookColor(color)).toBe(DEFAULT_NOTEBOOK_COLOR);
    }
  });

  it("replaces a missing or non-string color", () => {
    expect(safeNotebookColor(undefined)).toBe(DEFAULT_NOTEBOOK_COLOR);
    expect(safeNotebookColor(null)).toBe(DEFAULT_NOTEBOOK_COLOR);
    expect(safeNotebookColor(0x3b82f6)).toBe(DEFAULT_NOTEBOOK_COLOR);
  });
});
