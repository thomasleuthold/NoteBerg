/**
 * Covers band stitching and the model-response handling that turns unreliable
 * VL output into stored words.
 *
 * The mocked model responses model real VL behaviour rather than an idealised
 * API: coordinates outside 0..1, missing boxes, merged words, prose around the
 * JSON, and duplicated words across overlapping bands.
 */

import { describe, expect, it, vi } from "vitest";
import { stitchBands } from "./aiRecognition.js";
import { parseModelResponse } from "./backends/openAiBackend.js";

describe("parseModelResponse", () => {
  it("parses a clean JSON object", () => {
    const words = parseModelResponse('{"words":[{"text":"hi","box":[0,0,0.1,0.1]}]}');
    expect(words).toHaveLength(1);
    expect(words[0].text).toBe("hi");
  });

  it("strips a markdown code fence, which models add despite instructions", () => {
    const words = parseModelResponse('```json\n{"words":[{"text":"hi","box":[0,0,1,1]}]}\n```');
    expect(words).toHaveLength(1);
  });

  it("recovers JSON wrapped in explanatory prose", () => {
    const words = parseModelResponse(
      'Here is the transcription:\n{"words":[{"text":"hi","box":[0,0,1,1]}]}\nHope that helps!',
    );
    expect(words).toHaveLength(1);
  });

  it("returns an empty list when the model reports no handwriting", () => {
    expect(parseModelResponse('{"words":[]}')).toEqual([]);
  });

  it("returns null for unparseable output rather than guessing structure", () => {
    // A partial salvage would silently drop text, which looks like successful
    // recognition of a shorter note.
    expect(parseModelResponse("I cannot read this image.")).toBeNull();
    expect(parseModelResponse('{"words": [broken')).toBeNull();
    expect(parseModelResponse('{"result":"hi"}')).toBeNull();
    expect(parseModelResponse(null)).toBeNull();
  });
});

describe("stitchBands", () => {
  const geom = (contentY) => ({ contentY, contentHeight: 400 });

  const word = (text, x, y, height = 20) => ({
    text,
    boundingRect: { x, y, width: 40, height },
  });

  it("returns a single band's words unchanged", () => {
    const result = stitchBands([{ words: [word("hello", 0, 10)], band: geom(0) }]);
    expect(result.map((w) => w.text)).toEqual(["hello"]);
  });

  it("de-duplicates a word seen in two overlapping bands", () => {
    const result = stitchBands([
      { words: [word("overlap", 100, 380)], band: geom(0) },
      { words: [word("overlap", 100, 380)], band: geom(300) },
    ]);
    expect(result.map((w) => w.text)).toEqual(["overlap"]);
  });

  it("keeps a genuinely repeated word written twice on the page", () => {
    // Positional de-duplication, never purely textual: "the the" is legitimate.
    const result = stitchBands([
      { words: [word("the", 100, 10), word("the", 300, 10)], band: geom(0) },
    ]);
    expect(result.map((w) => w.text)).toEqual(["the", "the"]);
  });

  it("prefers the copy further from a band edge, which is less likely clipped", () => {
    // Same word: near the bottom edge of band A, comfortably inside band B.
    const nearEdge = word("word", 100, 395);
    const inside = word("word", 102, 395);
    const result = stitchBands([
      { words: [nearEdge], band: geom(0) },
      { words: [inside], band: geom(300) },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].boundingRect.x).toBe(102);
  });

  it("orders words top to bottom, then left to right", () => {
    const result = stitchBands([
      {
        words: [word("third", 10, 200), word("second", 300, 10), word("first", 10, 10)],
        band: geom(0),
      },
    ]);
    expect(result.map((w) => w.text)).toEqual(["first", "second", "third"]);
  });

  it("treats words on the same line as one line despite small baseline jitter", () => {
    const result = stitchBands([{ words: [word("b", 300, 12), word("a", 10, 10)], band: geom(0) }]);
    expect(result.map((w) => w.text)).toEqual(["a", "b"]);
  });

  it("keeps box-less words rather than dropping them from the transcription", () => {
    const result = stitchBands([
      {
        words: [word("placed", 10, 10), { text: "orphan", boundingRect: null }],
        band: geom(0),
      },
    ]);
    expect(result.map((w) => w.text)).toContain("orphan");
  });
});

describe("recognizeWithAi progress reporting", () => {
  /**
   * The progress dialog is the only feedback during a run that can take minutes
   * per page on a local model, so what it is told matters as much as the result.
   */

  const PAGES = 3;

  function band(index) {
    return {
      index,
      width: 800,
      height: 1131,
      contentX: 0,
      contentY: index * 1696.7,
      scale: 1,
      // A real Blob: the pipeline hands it to URL.createObjectURL for the
      // debug hook, which rejects a plain object.
      png: new Blob(["x"], { type: "image/png" }),
      inkRatio: 0.05,
      smallestText: 30,
    };
  }

  async function runWithPages(wordsPerPage) {
    vi.resetModules();

    vi.doMock("./pageRasterizer.js", () => ({
      rasterizeNote: async () => wordsPerPage.map((_, i) => band(i)),
    }));

    vi.doMock("./backends/openAiBackend.js", () => ({
      ENGINE_PREFIX: "openai",
      // One entry per word this page is meant to yield.
      transcribeBand: async (b) =>
        Array.from({ length: wordsPerPage[b.index] }, (_, i) => ({
          text: `w${b.index}-${i}`,
          region: "green",
        })),
      mapWordToContent: (entry) => ({ text: entry.text, boundingRect: null, region: 1 }),
    }));

    const { recognizeWithAi } = await import("./aiRecognition.js");

    const calls = [];
    await recognizeWithAi(
      [{ x: [0], y: [0] }],
      { maxImageEdge: 1600, model: "m" },
      {
        onProgress: (phase, current, total, detail) =>
          calls.push({ phase, current, total, ...detail }),
      },
    );
    return calls;
  }

  it("reports a running word count as each page completes", async () => {
    // Without this the user sees a count only at the very end, so a long run
    // gives no evidence that the finished pages found anything at all.
    const calls = await runWithPages([4, 3, 2]);
    const after = calls.filter((c) => c.phase === "transcribe" && c.current === c.total);
    expect(after.at(-1).words).toBe(9);
  });

  it("accumulates the count across pages rather than resetting per page", async () => {
    const calls = await runWithPages([4, 3, 2]);
    const counts = calls.filter((c) => c.phase === "transcribe").map((c) => c.words);
    // Monotonic: a count that dropped would read as words being lost.
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts.at(-1)).toBe(9);
  });

  it("carries a word count on every transcribe tick, so the figure never blanks", async () => {
    const calls = await runWithPages([4, 3, 2]);
    for (const c of calls.filter((x) => x.phase === "transcribe")) {
      expect(typeof c.words).toBe("number");
    }
  });

  it("never reports a zero total, which would collapse the progress bar", async () => {
    // The dialog computes percent as current/total and renders 0% when total is
    // 0, so any tick with total 0 empties the bar mid-run.
    const calls = await runWithPages([1, 1, 1]);
    for (const c of calls) {
      expect(c.total).toBeGreaterThan(0);
    }
  });

  it("advances the page counter to the last page", async () => {
    const calls = await runWithPages(Array(PAGES).fill(1));
    const transcribe = calls.filter((c) => c.phase === "transcribe");
    expect(Math.max(...transcribe.map((c) => c.current))).toBe(PAGES);
    expect(transcribe.every((c) => c.total === PAGES)).toBe(true);
  });
});
