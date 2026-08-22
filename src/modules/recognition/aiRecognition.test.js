/**
 * Covers band stitching and the model-response handling that turns unreliable
 * VL output into stored words.
 *
 * The mocked model responses model real VL behaviour rather than an idealised
 * API: missing bands, prose around the JSON, and words repeated on a page.
 */

import { describe, expect, it, vi } from "vitest";
import { stitchBands } from "./aiRecognition.js";
import { parseModelResponse } from "./backends/openAiBackend.js";

describe("parseModelResponse", () => {
  it("parses a clean JSON object", () => {
    const words = parseModelResponse('{"words":[{"text":"hi","region":"green"}]}');
    expect(words).toHaveLength(1);
    expect(words[0].text).toBe("hi");
  });

  it("strips a markdown code fence, which models add despite instructions", () => {
    const words = parseModelResponse('```json\n{"words":[{"text":"hi","region":"blue"}]}\n```');
    expect(words).toHaveLength(1);
  });

  it("recovers JSON wrapped in explanatory prose", () => {
    const words = parseModelResponse(
      'Here is the transcription:\n{"words":[{"text":"hi","region":"blue"}]}\nHope that helps!',
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
  /**
   * Region mode is the only mode production runs: mapWordToContent never returns
   * coordinates, so every stitched word carries a band and a null boundingRect.
   * An earlier version of these tests built words with boundingRects, which no
   * backend produces — so they exercised a dead branch and passed while the live
   * one silently dropped repeated words.
   */

  const IMAGE = { contentY: 0, contentHeight: 600 };
  const word = (text, region, imageBounds = IMAGE) => ({
    text,
    region,
    imageBounds,
    boundingRect: null,
  });

  it("keeps a word genuinely written twice on the same band", () => {
    // The regression this file exists for. A band spans several lines, so "the
    // the" lands twice on one band; collapsing them loses the word from
    // fullText and therefore from search.
    const result = stitchBands([
      { words: [word("the", "blue-0"), word("the", "blue-0")], band: IMAGE },
    ]);
    expect(result.map((w) => w.text)).toEqual(["the", "the"]);
  });

  it("keeps every occurrence of a word repeated across bands", () => {
    const result = stitchBands([
      { words: [word("total", "blue-0"), word("total", "green-0")], band: IMAGE },
    ]);
    expect(result.map((w) => w.text)).toEqual(["total", "total"]);
  });

  it("keeps the same word seen on two different pages", () => {
    // Pages are page-break aligned and do not overlap, so this is two genuine
    // occurrences rather than one word transcribed twice.
    const second = { contentY: 600, contentHeight: 600 };
    const result = stitchBands([
      { words: [word("summary", "blue-0")], band: IMAGE },
      { words: [word("summary", "blue-1", second)], band: second },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.region)).toEqual(["blue-0", "blue-1"]);
  });

  it("preserves reading order across pages", () => {
    const second = { contentY: 600, contentHeight: 600 };
    const result = stitchBands([
      { words: [word("first", "blue-0"), word("second", "green-0")], band: IMAGE },
      { words: [word("third", "blue-1", second)], band: second },
    ]);
    expect(result.map((w) => w.text)).toEqual(["first", "second", "third"]);
  });

  it("keeps words the model could not place on a band", () => {
    // Text matters more than localization: an unplaced word is still searchable,
    // whereas a dropped one is gone.
    const result = stitchBands([
      { words: [word("placed", "blue-0"), { text: "orphan", boundingRect: null }], band: IMAGE },
    ]);
    expect(result.map((w) => w.text)).toEqual(["placed", "orphan"]);
  });

  it("returns nothing for a page the model read as blank", () => {
    expect(stitchBands([{ words: [], band: IMAGE }])).toEqual([]);
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
