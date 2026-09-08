/**
 * AI recognition orchestration.
 *
 * Rasterizes a note into bands, transcribes each, maps model coordinates back
 * into content space, and stitches the bands into one word list.
 *
 * Kept separate from recognitionService.js so the sidecar path never loads the
 * rasterizer or an HTTP client it does not need.
 */

import { PROVIDER_REPLICATE } from "./aiProvider.js";
import { mapWordToContent } from "./backends/openAiBackend.js";
import { BREAK_LINE, countWords, isBreak, makeBreak } from "./breaks.js";
import { rasterizeNote } from "./pageRasterizer.js";
import { buildResult, PRECISION_APPROXIMATE } from "./recognitionService.js";
import { regionToContentRange } from "./regions.js";

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
  if (config.provider === PROVIDER_REPLICATE) {
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
 * @param {{breaks?: boolean}} [opts] - breaks: whether the run records layout.
 *   Defaults to true, which is what every caller wanted before the setting
 *   existed.
 * @returns {Array} every transcribed word, in reading order
 */
export function stitchBands(bandResults, opts = {}) {
  const breaks = opts.breaks ?? true;
  const stitched = [];

  for (const { words } of bandResults) {
    const trimmed = trimEdgeBreaks(words);
    if (trimmed.length === 0) continue;

    // One break at every join. A band boundary is an artefact of how the page
    // was split for transcription, not something the writer did, and it always
    // falls between two lines — so the lines either side must not run together,
    // and must not gain a paragraph gap that is not on the page either.
    //
    // Suppressed when the run is not recording layout: this break is ours, not
    // the model's, so leaving it in would put a newline at every page boundary
    // in a transcript the user asked to have none.
    if (breaks && stitched.length > 0) stitched.push(makeBreak(BREAK_LINE));
    stitched.push(...trimmed);
  }

  return stitched;
}

/**
 * Drop break entries from both ends of one band's words.
 *
 * Each band is transcribed by its own request, so each comes back with its own
 * idea of where the text starts and stops: a model asked to end every line with
 * a break duly ends the last one too. Kept, those edge breaks would land at
 * every band join and put a blank line at each sixth of the page.
 *
 * @param {Array} words
 * @returns {Array} the same entries with leading and trailing breaks removed
 */
function trimEdgeBreaks(words) {
  if (!Array.isArray(words)) return [];

  let start = 0;
  let end = words.length;
  while (start < end && isBreak(words[start])) start++;
  while (end > start && isBreak(words[end - 1])) end--;

  return words.slice(start, end);
}

/**
 * Recognize a note's strokes using a configured AI vision backend.
 *
 * @param {Array} strokes - active strokes in content space
 * @param {Object} config - from getRecognitionConfig()
 * @param {{
 *   signal?: AbortSignal,
 *   onProgress?: Function,
 *   startBand?: number,
 *   priorBands?: Array,
 *   onBandComplete?: Function,
 *   onResetBands?: Function,
 *   onError?: Function,
 *   onPredictionStarted?: Function,
 *   resumePrediction?: string|null,
 * }} [opts]
 *   onProgress — (phase, current, total, detail?) where detail carries `words`,
 *   the running transcribed word count.
 *   startBand / priorBands — resume state: begin at this band, with these
 *   already-transcribed results in front. Bands before startBand are still
 *   rasterized (page geometry depends on the whole note) but not re-sent.
 *   onBandComplete — (bandIndex, words) after each band lands, so a caller can
 *   checkpoint. Awaited: losing the checkpoint defeats the point of having one.
 *   onResetBands — the resume state was unusable and the run is starting over;
 *   discard any checkpoint held for it. Awaited, for the same reason.
 *   onError — (err) the failure that ended the run, so a caller can show why.
 *   onPredictionStarted — passed through to the backend; called with a
 *   resumable handle before any long wait (Replicate only).
 *   resumePrediction — a handle from a previous session to collect instead of
 *   re-sending the first band.
 * @returns {Promise<Object|null>} stored recognition object, or null on failure
 */
export async function recognizeWithAi(strokes, config, opts = {}) {
  let bands;
  try {
    bands = await rasterizeNote(
      strokes,
      {
        maxImageEdge: config.maxImageEdge,
      },
      opts.onProgress,
    );
  } catch (err) {
    // The blank-render guard raises here, and its message is the whole value of
    // having the guard — it distinguishes "the geometry is wrong" from "the
    // model cannot read", which look identical from the outside.
    console.error("[Recognition] Rasterization failed:", err);
    opts.onError?.(err);
    return null;
  }

  if (bands.length === 0) return null;

  const { transcribe, engine } = await resolveProvider(config);

  // Resume state. Bands already transcribed in an earlier session are carried
  // in rather than re-sent — that is the whole saving, since transcription is
  // essentially all of the elapsed time and all of the cost.
  const startBand = opts.startBand ?? 0;
  const bandResults = [...(opts.priorBands ?? [])];
  let wordsSoFar = bandResults.reduce((n, b) => n + countWords(b.words), 0);
  let resumeHandle = opts.resumePrediction ?? null;

  // The note may have shrunk since the job was created — recognizing fewer
  // pages than we have results for would stitch words onto pages that no longer
  // exist, so start over rather than guess.
  if (startBand > bands.length) {
    console.warn(
      `[Recognition] Resume state names band ${startBand} but the note now has ` +
        `${bands.length}. Starting over.`,
    );
    // Tell the caller to drop its checkpoint too, before recursing.
    //
    // The recursion clears `priorBands` for its own accounting, but
    // onBandComplete is the caller's closure over a separate copy of the same
    // results. Left alone it would append the restarted run's bands onto the
    // stale ones, and an interruption mid-restart would then resume by stitching
    // words describing ink the note no longer has — the exact staleness the
    // restart exists to avoid.
    await opts.onResetBands?.();
    return recognizeWithAi(strokes, config, {
      ...opts,
      startBand: 0,
      priorBands: [],
      resumePrediction: null,
    });
  }

  for (const band of bands) {
    if (opts.signal?.aborted) return null;

    // Already done in a previous session.
    if (band.index < startBand) continue;

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
      // A prediction dispatched before the app died is already paid for, so
      // collect it rather than sending this band again. Only ever applies to
      // the first band of a resumed run; a miss falls through to a normal send.
      if (resumeHandle) {
        const handle = resumeHandle;
        resumeHandle = null;
        const { resumePrediction } = await import("./backends/replicateBackend.js");
        raw = await resumePrediction(handle, config, opts);
        if (raw)
          console.log(`[Recognition] Collected in-flight band ${band.index} from a previous run.`);
      }

      if (!raw) {
        raw = await transcribe(band, config, {
          ...opts,
          onPredictionStarted: (url) => opts.onPredictionStarted?.(band.index, url),
        });
      }
    } catch (err) {
      // A failed band fails the whole note. A partial transcription must never
      // be stored on the note as complete: hasRecognition derives from
      // recognition.fullText, so a partial write would mark the note done and
      // hide it from every retry path. Partial work lives in the job store.
      console.error(`[Recognition] Band ${band.index} failed:`, err);
      // Reported before returning null: the backends raise messages that name
      // the setting to change ("raise Max response length", "reduce Max image
      // size"), and a bare null reduces every one of them to "failed".
      //
      // Handed to the caller rather than rethrown because performRecognition
      // catches everything on its way out — deliberately, so the automatic and
      // sidecar paths can never surface an error — which would swallow a throw
      // before the queue ever saw it.
      opts.onError?.(err);
      return null;
    }

    // The content-space slice this image covers.
    const imageBounds = {
      contentY: band.contentY,
      contentHeight: band.height / band.scale,
    };

    // The band a model names is resolved to a content-space Y range *here*,
    // once, rather than stored as an index to be resolved on every read.
    //
    // An index only means anything alongside the band scheme that produced it,
    // so changing REGION_COUNT silently reinterpreted every result already
    // stored. More importantly, an index cannot be corrected: when the user
    // inserts space, everything below a point moves down, and "the third of six
    // slices" has no arithmetic that expresses that. A Y range does — it is the
    // same shift already applied to strokes (ShiftContentCommand).
    // A model told not to report layout still volunteers break entries from
    // habit — the same unreliability that made this a setting. Dropping them
    // here means the stored result honours the choice whatever the model did,
    // rather than the setting being a request the model may decline.
    const keepBreaks = config.breaks ?? false;
    const words = raw
      .map((entry) => mapWordToContent(entry))
      .filter((w) => Boolean(w) && (keepBreaks || !isBreak(w)));
    for (const w of words) {
      // Breaks describe the space between words and have no band to resolve.
      if (isBreak(w)) continue;
      if (w.region == null) continue;
      w.yRange = regionToContentRange(w.region, imageBounds);
      w.region = null;
    }

    bandResults.push({ words, band: imageBounds });

    // Checkpoint before moving on, so an interruption costs at most this one
    // page. Awaited deliberately: a checkpoint that races the next request can
    // be lost exactly when it is needed.
    await opts.onBandComplete?.(band.index, words, imageBounds);

    // Report the running word count as each page lands. A page can take minutes
    // on a local model, so a count that only appears at the very end leaves the
    // user with no evidence that the pages already done found anything.
    wordsSoFar += countWords(words);
    opts.onProgress?.("transcribe", band.index + 1, bands.length, { words: wordsSoFar });
  }

  opts.onProgress?.("stitch", 1, 1);

  const merged = stitchBands(bandResults, { breaks: config.breaks ?? false });

  // Counted rather than measured by array length: the list also holds the line
  // breaks that carry the layout, and those are not words.
  const total = countWords(merged);
  const located = merged.filter((w) => w.yRange).length;
  console.log(
    `[Recognition] Region mode — ${total} words, ${located} localized to a band ` +
      `(${total ? Math.round((located / total) * 100) : 0}%). ` +
      "Words without a band are still searchable.",
  );

  const stitched = merged.map((w) =>
    // A break carries no text and no geometry, so the word shape below would
    // strip it down to an entry that is neither a word nor a break. It is
    // already in its stored form and passes through untouched.
    isBreak(w)
      ? w
      : {
          text: w.text,
          precision: PRECISION_APPROXIMATE,
          // Vision models do not report usable coordinates, so a word is located to a
          // band or not at all (regions.js). Kept null so the field's absence of
          // meaning is explicit rather than implied.
          boundingRect: null,
          // Present only when the model named a band. A content-space Y range, in the
          // same space strokes live in — which is what lets edits that move content
          // move the range with it. Still a band's worth of vertical extent, never a
          // measurement: precision stays "approximate".
          ...(w.yRange ? { yRange: w.yRange } : {}),
        },
  );

  return buildResult(stitched, engine);
}
