/**
 * AI recognition orchestration.
 *
 * Rasterizes a note into bands, transcribes each, maps model coordinates back
 * into content space, and stitches the bands into one word list.
 *
 * Kept separate from recognitionService.js so the sidecar path never loads the
 * rasterizer or an HTTP client it does not need.
 */

import { mapWordToContent } from "./backends/openAiBackend.js";
import { rasterizeNote } from "./pageRasterizer.js";
import { buildResult, PRECISION_APPROXIMATE } from "./recognitionService.js";
import { BACKEND_REPLICATE } from "./recognitionSettings.js";
import { encodeRegion } from "./regions.js";

/**
 * Resolve the transcription function and engine label for a provider.
 *
 * Providers are loaded lazily and independently: Replicate speaks a predictions
 * API rather than chat/completions, so the two share the surrounding pipeline
 * (rasterize → transcribe → map coordinates) but not the request code.
 *
 * @param {Object} config
 * @returns {Promise<{transcribe: Function, engine: string}>}
 */
async function resolveProvider(config) {
  if (config.backend === BACKEND_REPLICATE) {
    const mod = await import("./backends/replicateBackend.js");
    return {
      transcribe: mod.transcribeBand,
      engine: `${mod.ENGINE_PREFIX}:${config.model}`,
    };
  }
  const mod = await import("./backends/openAiBackend.js");
  return {
    transcribe: mod.transcribeBand,
    engine: `${mod.ENGINE_PREFIX}:${config.model}`,
  };
}

/**
 * Concatenate per-page word lists into one, in reading order.
 *
 * There is nothing to de-duplicate. Images are aligned to the note's virtual
 * page breaks and do not overlap, so each word is transcribed exactly once and
 * every entry a page reports is a distinct occurrence.
 *
 * An earlier version de-duplicated by text plus band, from a previous scheme
 * where images overlapped. Once overlap was removed that check could only ever
 * fire on genuine repeats: "the the" written on one line collapsed to a single
 * "the", losing the word from fullText and therefore from search. Words are
 * localized to a band rather than a point, so no positional test can separate a
 * repeat from a duplicate — which is the other reason not to attempt one.
 *
 * Pages are transcribed top to bottom and each model returns its words in
 * reading order, so appending in order preserves it.
 *
 * @param {Array<{words: Array, band: Object}>} bandResults
 * @returns {Array} every transcribed word, in reading order
 */
export function stitchBands(bandResults) {
  return bandResults.flatMap(({ words }) => words);
}

/**
 * Recognize a note's strokes using a configured AI vision backend.
 *
 * @param {Array} strokes - active strokes in content space
 * @param {Object} config - from getRecognitionConfig()
 * @param {{signal?: AbortSignal, onProgress?: Function}} [opts] - onProgress is
 *   (phase, current, total, detail?) where detail carries `words`, the running
 *   transcribed word count.
 * @returns {Promise<Object|null>} stored recognition object, or null on failure
 */
export async function recognizeWithAi(strokes, config, opts = {}) {
  const bands = await rasterizeNote(
    strokes,
    {
      maxImageEdge: config.maxImageEdge,
    },
    opts.onProgress,
  );

  if (bands.length === 0) return null;

  const { transcribe, engine } = await resolveProvider(config);

  const bandResults = [];
  let wordsSoFar = 0;

  for (const band of bands) {
    if (opts.signal?.aborted) return null;

    // Reported before the page is sent as well as after it completes: the
    // "before" tick moves the page counter as soon as work starts, and carries
    // the count from earlier pages so the figure never blanks mid-run.
    opts.onProgress?.("transcribe", band.index + 1, bands.length, { words: wordsSoFar });

    const smallText = band.smallestText ?? 0;
    console.log(
      `[Recognition] Band ${band.index}: ${band.width}x${band.height}px, ` +
        `${(band.png.size / 1024).toFixed(1)}KB, ink coverage ${
          band.inkRatio < 0 ? "unknown" : `${(band.inkRatio * 100).toFixed(2)}%`
        }, smallest text ~${smallText.toFixed(0)}px` +
        (smallText > 0 && smallText < 20
          ? " — below ~20px, fine print will likely be missed; raise Max image size"
          : ""),
    );

    // Expose the exact image being sent. Ink coverage says *whether* something
    // was drawn; this shows *what*, which is the only way to tell a correct
    // render from a mangled one. Reading it costs nothing until inspected.
    //
    // The previous URL is revoked first: each one pins a full-page PNG in memory
    // until the document unloads, so a multi-page note recognized repeatedly
    // leaked one image per page per run.
    if (typeof window !== "undefined") {
      if (window.__lastRecognitionImage) URL.revokeObjectURL(window.__lastRecognitionImage);
      window.__lastRecognitionImage = URL.createObjectURL(band.png);
      console.log(`[Recognition] Inspect the image sent: open window.__lastRecognitionImage`);
    }

    let raw;
    try {
      raw = await transcribe(band, config, opts);
    } catch (err) {
      // A failed band fails the whole note: a partial transcription stored as
      // complete would make the note look recognized and stop the catch-up scan
      // from ever retrying it.
      console.error(`[Recognition] Band ${band.index} failed:`, err);
      return null;
    }

    // The content-space slice this image covers. Used downstream by the search
    // highlighter, to place a band without re-deriving how the note was split.
    // Shared by reference across the page's words: it is identical for all of
    // them and is never mutated.
    const imageBounds = {
      contentY: band.contentY,
      contentHeight: band.height / band.scale,
    };

    const words = raw.map((entry) => mapWordToContent(entry)).filter(Boolean);
    for (const w of words) {
      if (w.region == null) continue;
      w.region = encodeRegion(band.index, w.region);
      w.imageBounds = imageBounds;
    }

    bandResults.push({ words, band: imageBounds });

    // Report the running word count as each page lands. A page can take minutes
    // on a local model, so a count that only appears at the very end leaves the
    // user with no evidence that the pages already done found anything.
    wordsSoFar += words.length;
    opts.onProgress?.("transcribe", band.index + 1, bands.length, { words: wordsSoFar });
  }

  opts.onProgress?.("stitch", 1, 1);

  const merged = stitchBands(bandResults);

  const located = merged.filter((w) => w.region != null).length;
  console.log(
    `[Recognition] Region mode — ${merged.length} words, ${located} localized to a band ` +
      `(${merged.length ? Math.round((located / merged.length) * 100) : 0}%). ` +
      "Words without a band are still searchable.",
  );

  const stitched = merged.map((w) => ({
    text: w.text,
    precision: PRECISION_APPROXIMATE,
    // Vision models do not report usable coordinates, so a word is located to a
    // band or not at all (regions.js). Kept null so the field's absence of
    // meaning is explicit rather than implied.
    boundingRect: null,
    // Present only when the model named a band; readers treat its absence as
    // "no region". imageBounds travels with the region so a highlight can be
    // placed without re-deriving how the note was split at recognition time.
    ...(w.region != null ? { region: w.region, imageBounds: w.imageBounds } : {}),
  }));

  return buildResult(stitched, engine);
}
