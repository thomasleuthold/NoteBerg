/**
 * src/components/NoteCanvas/penPresets.test.js
 * Pen presets come from the note file (in a shared notebook another user wrote
 * it) and end up in the toolbar's markup: only well-formed presets are used.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_PEN_PRESETS, normalizePenPresets } from "./penPresets.js";

const pen = (width, colorIndex) => ({ width, colorIndex, type: "pen" });
const marker = (width, colorIndex) => ({ width, colorIndex, type: "marker" });

describe("normalizePenPresets", () => {
  it("uses the defaults for a note without presets", () => {
    expect(normalizePenPresets(undefined)).toEqual(DEFAULT_PEN_PRESETS);
    expect(normalizePenPresets(null)).toEqual(DEFAULT_PEN_PRESETS);
  });

  it("keeps a note's own well-formed presets as they are", () => {
    const stored = [pen(1, 2), marker(30, 1)];
    expect(normalizePenPresets(stored)).toEqual(stored);
  });

  it("adds the marker presets to a note from before markers existed", () => {
    const presets = normalizePenPresets([pen(1, 0)]);
    expect(presets[0]).toEqual(pen(1, 0));
    expect(presets.filter((p) => p.type === "marker")).toHaveLength(3);
  });

  it("treats a preset without a type as a pen, as before", () => {
    expect(normalizePenPresets([{ width: 2, colorIndex: 1 }, marker(25, 0)])[0]).toEqual(pen(2, 1));
  });

  it("drops presets that are not plain numbers, so nothing reaches the markup", () => {
    const presets = normalizePenPresets([
      { width: '2"><img src=x>', colorIndex: 0, type: "pen" },
      { width: 2, colorIndex: "1<b>", type: "pen" },
      { width: -1, colorIndex: 0 },
      { width: 1e9, colorIndex: 0 },
      { width: 2, colorIndex: 1.5 },
      null,
      pen(3, 1),
      marker(20, 2),
    ]);
    expect(presets).toEqual([pen(3, 1), marker(20, 2)]);
  });

  it("uses the defaults when nothing usable is left, or the value is not a list", () => {
    expect(normalizePenPresets([{ width: "x", colorIndex: 0 }])).toEqual(DEFAULT_PEN_PRESETS);
    expect(normalizePenPresets("<script>")).toEqual(DEFAULT_PEN_PRESETS);
  });

  it("never hands out the shared defaults themselves", () => {
    const presets = normalizePenPresets(undefined);
    presets[0].width = 99;
    expect(DEFAULT_PEN_PRESETS[0].width).toBe(1.5);
  });
});
