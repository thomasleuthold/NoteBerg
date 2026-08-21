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
 * Whether two words are near enough, and similar enough, to be the same word
 * seen in two overlapping bands.
 *
 * Position tolerance scales with the words' own height so it adapts to
 * handwriting size instead of assuming a pixel scale.
 */
function isSameWord(a, b) {
  if (a.text !== b.text) return false;

  // Region mode has no coordinates to compare, so overlap duplicates are matched
  // on text plus band. Regions encode the image they came from, so the same
  // colour on two different images does not collide — which is exactly the case
  // band overlap produces.
  if (a.region != null && b.region != null) return a.region === b.region;

  if (!a.boundingRect || !b.boundingRect) return false;

  const tolerance = Math.max(a.boundingRect.height, b.boundingRect.height, 8) * 1.5;
  const dx = Math.abs(a.boundingRect.x - b.boundingRect.x);
  const dy = Math.abs(a.boundingRect.y - b.boundingRect.y);
  return dx <= tolerance && dy <= tolerance;
}

/**
 * Distance from a word to the nearest horizontal edge of its band.
 *
 * Used to pick which copy of a duplicated word to keep: a word close to a cut
 * may be clipped in that band, so the copy further from an edge is the one more
 * likely to have been read correctly.
 */
function edgeDistance(word, band) {
  if (!word.boundingRect) return 0;
  const top = word.boundingRect.y - band.contentY;
  const bottom = band.contentY + band.contentHeight - word.boundingRect.y;
  return Math.min(top, bottom);
}

/**
 * Merge per-band word lists into one, removing duplicates from band overlap.
 *
 * Only words at close-to-identical positions are treated as duplicates. A word
 * genuinely written twice ("the the") sits far apart and is kept twice — the
 * de-duplication is positional, never purely textual.
 *
 * @param {Array<{words: Array, band: Object}>} bandResults
 * @returns {Array} merged words, in reading order
 */
export function stitchBands(bandResults) {
  const merged = [];

  for (const { words, band } of bandResults) {
    for (const word of words) {
      const existingIndex = merged.findIndex((m) => isSameWord(m.word, word));

      if (existingIndex === -1) {
        merged.push({ word, band });
        continue;
      }

      // Keep whichever copy sat further from a band edge.
      const existing = merged[existingIndex];
      if (edgeDistance(word, band) > edgeDistance(existing.word, existing.band)) {
        merged[existingIndex] = { word, band };
      }
    }
  }

  // Reading order: top to bottom, then left to right. Words without geometry
  // keep their relative order at the end rather than being dropped.
  const withBox = merged.filter((m) => m.word.boundingRect);
  const withoutBox = merged.filter((m) => !m.word.boundingRect);

  withBox.sort((a, b) => {
    const ay = a.word.boundingRect.y;
    const by = b.word.boundingRect.y;
    const lineTolerance = Math.max(a.word.boundingRect.height, b.word.boundingRect.height) * 0.6;
    if (Math.abs(ay - by) > lineTolerance) return ay - by;
    return a.word.boundingRect.x - b.word.boundingRect.x;
  });

  return [...withBox, ...withoutBox].map((m) => m.word);
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
    if (typeof window !== "undefined") {
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

    // The content-space slice this image covers. Only these two fields are used
    // downstream — by edge-distance scoring during stitching, and by the search
    // highlighter to place a band without re-deriving how the note was split.
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

  // Extent correction was removed with cropped rendering: it stretched reported
  // boxes to fill the ink extent, which was only sound because cropping
  // guaranteed ink touched all four edges. Page-aligned images have margins by
  // design, so stretching would manufacture error rather than remove it.
  const located = merged.filter((w) => w.region != null).length;
  console.log(
    `[Recognition] Region mode — ${merged.length} words, ${located} localized to a band ` +
      `(${merged.length ? Math.round((located / merged.length) * 100) : 0}%). ` +
      "Words without a band are still searchable.",
  );

  const stitched = merged.map((w) => ({
    text: w.text,
    precision: PRECISION_APPROXIMATE,
    boundingRect: w.boundingRect,
    // Present only in region mode; readers treat its absence as "no region".
    // imageBounds travels with the region so a highlight can be placed without
    // re-deriving how the note was split at recognition time.
    ...(w.region != null ? { region: w.region, imageBounds: w.imageBounds } : {}),
  }));

  return buildResult(stitched, engine);
}
