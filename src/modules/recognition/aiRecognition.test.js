/**
 * Covers band stitching and the model-response handling that turns unreliable
 * VL output into stored words.
 *
 * The mocked model responses model real VL behaviour rather than an idealised
 * API: missing bands, prose around the JSON, and words repeated on a page.
 */

import { describe, expect, it, vi } from "vitest";
import { stitchBands } from "./aiRecognition.js";
import { mapWordToContent, parseModelResponse } from "./backends/openAiBackend.js";
import { countWords, isBreak, renderFullText } from "./breaks.js";

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
    // The join between two pages carries a line break, so the words either side
    // do not run together into one line.
    expect(result.filter((w) => !isBreak(w)).map((w) => w.region)).toEqual(["blue-0", "blue-1"]);
  });

  it("preserves reading order across pages", () => {
    const second = { contentY: 600, contentHeight: 600 };
    const result = stitchBands([
      { words: [word("first", "blue-0"), word("second", "green-0")], band: IMAGE },
      { words: [word("third", "blue-1", second)], band: second },
    ]);
    expect(result.filter((w) => !isBreak(w)).map((w) => w.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
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

  it("separates two bands with a line break so their text does not run together", () => {
    const second = { contentY: 600, contentHeight: 600 };
    const result = stitchBands([
      { words: [word("end", "blue-0")], band: IMAGE },
      { words: [word("start", "blue-1", second)], band: second },
    ]);

    expect(result.map((e) => (isBreak(e) ? "|" : e.text))).toEqual(["end", "|", "start"]);
  });

  it("drops the breaks a model leaves at the edges of a band", () => {
    // Each band is its own request, so a model told to end every line with a
    // break ends the band that way too. Kept, those would land at every join
    // and put a blank line at each sixth of the page.
    const second = { contentY: 600, contentHeight: 600 };
    const result = stitchBands([
      { words: [{ break: 1 }, word("end", "blue-0"), { break: 1 }], band: IMAGE },
      { words: [{ break: 1 }, word("start", "blue-1", second)], band: second },
    ]);

    expect(result.map((e) => (isBreak(e) ? "|" : e.text))).toEqual(["end", "|", "start"]);
  });

  it("keeps the breaks inside a band, which are the ones the writer made", () => {
    const result = stitchBands([
      { words: [word("first", "blue-0"), { break: 2 }, word("second", "blue-0")], band: IMAGE },
    ]);

    expect(result.map((e) => (isBreak(e) ? `|${e.break}` : e.text))).toEqual([
      "first",
      "|2",
      "second",
    ]);
  });

  it("adds no break for a band the model read as blank", () => {
    // An empty band contributes nothing, so it must not leave a gap behind
    // either — the text either side of it is continuous.
    const second = { contentY: 600, contentHeight: 600 };
    const result = stitchBands([
      { words: [word("only", "blue-0")], band: IMAGE },
      { words: [], band: second },
    ]);

    expect(result.map((e) => (isBreak(e) ? "|" : e.text))).toEqual(["only"]);
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

describe("recognizeWithAi keeps the layout the model reported", () => {
  /**
   * Run a full recognition over one page whose model response is given verbatim.
   *
   * The real mapWordToContent is used rather than a stub. The break-losing bug
   * this covers lived *between* the stitcher and the stored result — every unit
   * on either side passed — so a test that mocks the middle cannot see it.
   */
  async function recognizeResponse(entries, config = {}) {
    vi.resetModules();

    vi.doMock("./pageRasterizer.js", () => ({
      rasterizeNote: async () => [
        {
          index: 0,
          png: new Blob([]),
          width: 800,
          height: 600,
          scale: 1,
          contentY: 0,
          contentHeight: 600,
        },
      ],
    }));

    const actual = await vi.importActual("./backends/openAiBackend.js");
    vi.doMock("./backends/openAiBackend.js", () => ({
      ...actual,
      ENGINE_PREFIX: "openai",
      transcribeBand: async () => entries,
    }));

    const { recognizeWithAi } = await import("./aiRecognition.js");
    // breaks: true explicitly — this block is about layout being preserved, and
    // recording layout is opt-in now that models place the markers unreliably.
    return recognizeWithAi(
      [{ x: [0], y: [0] }],
      { maxImageEdge: 1600, model: "m", breaks: true, ...config },
      {},
    );
  }

  it("renders the model's line breaks into the stored text", async () => {
    const result = await recognizeResponse([
      { text: "Security", region: "blue" },
      { text: "flow", region: "blue" },
      { break: 1 },
      { text: "Hallo,", region: "yellow" },
      { text: "this", region: "yellow" },
    ]);

    expect(result.fullText).toBe("Security flow\nHallo, this");
  });

  it("keeps the break entries in the stored words array", async () => {
    // fullText is derived from these, so a break lost here is lost from every
    // later re-render too.
    const result = await recognizeResponse([
      { text: "one", region: "blue" },
      { break: 1 },
      { text: "two", region: "blue" },
    ]);

    expect(result.words.filter((w) => w.break > 0)).toHaveLength(1);
  });

  it("counts only words, so a break does not inflate the reported total", async () => {
    const result = await recognizeResponse([
      { text: "one", region: "blue" },
      { break: 1 },
      { text: "two", region: "blue" },
    ]);

    expect(countWords(result.words)).toBe(2);
  });
});

describe("a model that reports a break as a word", () => {
  /**
   * Observed in real output: the transcript came back reading
   * "So, jetzt schreiben break 2.Line wir mal was, und break 3. ..." — the
   * marker written out as text where a line ending belonged.
   *
   * isBreak() cannot be loosened to catch it. It requires a break to carry no
   * text precisely because every other consumer of `words` — highlight boxes,
   * both region-search matchers, the band shifter, the task labeller — skips
   * entries without text. A break carrying text would become a searchable,
   * highlightable word everywhere else in the pipeline. So the repair lives at
   * the boundary where model output is normalized instead.
   */
  it("turns the bare marker into a real break", () => {
    expect(mapWordToContent({ text: "break" })).toEqual({ break: 1 });
  });

  it("keeps the break when the marker also carries the count", () => {
    // {"break":2,"text":"break"} — the model got the entry right and then
    // filled in the text as well. Honouring the count keeps the paragraph.
    expect(mapWordToContent({ break: 2, text: "break" })).toEqual({ break: 2 });
  });

  it("ignores a region attached to the marker", () => {
    // A break records layout, not a position on the page, so a band reported
    // alongside it is meaningless and must not turn it back into a word.
    expect(mapWordToContent({ text: "break", region: "green" })).toEqual({ break: 1 });
  });

  it("tolerates the marker's casing and stray whitespace", () => {
    expect(mapWordToContent({ text: "Break" })).toEqual({ break: 1 });
    expect(mapWordToContent({ text: " BREAK " })).toEqual({ break: 1 });
  });

  it("still transcribes break as a word when it is part of a sentence", () => {
    // The repair must not eat real handwriting. A page that says "coffee break"
    // reaches here as ordinary words, and losing one to an over-eager match
    // would be a worse bug than the one being fixed.
    expect(mapWordToContent({ text: "coffee", region: "green" })).toEqual({
      text: "coffee",
      region: 1,
    });
    expect(mapWordToContent({ text: "break!", region: "green" })).toEqual({
      text: "break!",
      region: 1,
    });
    expect(mapWordToContent({ text: "breaks", region: "green" })).toEqual({
      text: "breaks",
      region: 1,
    });
  });

  it("puts a line ending in the stored text where the marker was", () => {
    // End to end: the symptom the user saw was the word in the transcript, so
    // the assertion is about the transcript, not the intermediate shape.
    const entries = [
      { text: "Hello", region: "green" },
      { text: "break" },
      { text: "Berlin", region: "green" },
    ];
    const mapped = entries.map(mapWordToContent).filter(Boolean);

    expect(renderFullText(mapped)).toBe("Hello\nBerlin");
    expect(countWords(mapped)).toBe(2);
  });
});

describe("stitchBands at a page boundary", () => {
  const IMG = { contentY: 0, contentHeight: 600, scale: 1, height: 600 };
  const w = (text) => ({ text, region: null, yRange: null });

  it("joins two pages with a line break when recording layout", () => {
    // A band boundary always falls between two lines, so the last line of one
    // page and the first of the next must not run together.
    const out = stitchBands(
      [
        { words: [w("first")], band: IMG },
        { words: [w("second")], band: IMG },
      ],
      { breaks: true },
    );

    expect(out).toHaveLength(3);
    expect(isBreak(out[1])).toBe(true);
  });

  it("joins them with nothing when layout is off", () => {
    // This break is ours, not the model's — inserted because the page was split
    // for transcription. A transcript asked to carry no layout must not gain a
    // newline at every page boundary through the back door.
    const out = stitchBands(
      [
        { words: [w("first")], band: IMG },
        { words: [w("second")], band: IMG },
      ],
      { breaks: false },
    );

    expect(out.map((e) => e.text)).toEqual(["first", "second"]);
    expect(out.some(isBreak)).toBe(false);
  });

  it("still joins pages for a caller that says nothing", () => {
    // stitchBands is exported and called directly in tests; its own default
    // stays the historical one so the change lives in the caller that knows
    // about the setting.
    const out = stitchBands([
      { words: [w("first")], band: IMG },
      { words: [w("second")], band: IMG },
    ]);

    expect(out.some(isBreak)).toBe(true);
  });
});

describe("recognizeWithAi with layout recording switched off", () => {
  /**
   * The default. Models place break markers unreliably — missed line endings,
   * the marker emitted as the word "break", disagreement about paragraphs — so
   * the layout is opt-in and the plain word stream is what a run produces
   * unless asked otherwise.
   */
  async function recognizeWithoutBreaks(entries) {
    vi.resetModules();

    vi.doMock("./pageRasterizer.js", () => ({
      rasterizeNote: async () => [
        {
          index: 0,
          png: new Blob([]),
          width: 800,
          height: 600,
          scale: 1,
          contentY: 0,
          contentHeight: 600,
        },
      ],
    }));

    const actual = await vi.importActual("./backends/openAiBackend.js");
    vi.doMock("./backends/openAiBackend.js", () => ({
      ...actual,
      ENGINE_PREFIX: "openai",
      transcribeBand: async () => entries,
    }));

    const { recognizeWithAi } = await import("./aiRecognition.js");
    return recognizeWithAi([{ x: [0], y: [0] }], { maxImageEdge: 1600, model: "m" }, {});
  }

  it("drops break entries the model volunteered anyway", async () => {
    // The prompt forbids them, but the unreliability that made this a setting
    // cuts both ways: a model that ignores the instruction must not be able to
    // put the layout back in. The setting is honoured whatever the model does.
    const result = await recognizeWithoutBreaks([
      { text: "Hello", region: "green" },
      { break: 1 },
      { text: "Berlin", region: "green" },
    ]);

    expect(result.fullText).toBe("Hello Berlin");
    expect(result.words.every((w) => !isBreak(w))).toBe(true);
  });

  it("drops the marker even when it arrives as the word break", async () => {
    // mapWordToContent repairs {"text":"break"} into a real break; with layout
    // off that repaired entry has to be dropped too, or the setting would be
    // defeated by the very output it was meant to clean up.
    const result = await recognizeWithoutBreaks([
      { text: "Hello", region: "green" },
      { text: "break" },
      { text: "Berlin", region: "green" },
    ]);

    expect(result.fullText).toBe("Hello Berlin");
  });

  it("keeps every real word", async () => {
    // Dropping layout must cost no text. The words are the point.
    const result = await recognizeWithoutBreaks([
      { text: "one", region: "green" },
      { break: 2 },
      { text: "two", region: "green" },
    ]);

    expect(countWords(result.words)).toBe(2);
    expect(result.fullText).toBe("one two");
  });
});
