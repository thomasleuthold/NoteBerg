/**
 * Recognition service — backend selection, orchestration and normalization.
 *
 * Owns everything that must be true regardless of which backend ran:
 * rasterization, band coordinate mapping, stitching, and tagging every word
 * with its `precision`. Backends never write geometry into a note, so the
 * guarantee that stored coordinates are in content space lives in exactly one
 * place (DESIGN §3.4).
 *
 * Two backend shapes exist on purpose:
 *   - `recognizeStrokes` — sidecar: strokes in, exact word boxes out.
 *   - `transcribePage`   — AI: rendered band images in, text + approximate
 *                          boxes out, which this module maps back to content
 *                          space.
 */

import * as sidecarBackend from "./backends/sidecarBackend.js";
import { isBreak, makeBreak, renderFullText } from "./breaks.js";
import { hasConsent } from "./consent.js";
import {
  getRecognitionConfig,
  isAiMethod,
  isRecognitionReady,
  METHOD_AI,
  METHOD_WINDOWS_INK,
} from "./recognitionSettings.js";

/** Precision tiers stored on each recognized word (DESIGN §2.1). */
export const PRECISION_EXACT = "exact";
export const PRECISION_APPROXIMATE = "approximate";

/**
 * Normalize one backend-reported word into the stored shape.
 *
 * The canvas reader is tolerant of several box shapes for legacy reasons
 * (`boundingRect || boundingBox || rect || word`, `x`-or-`left`), but that
 * tolerance is a safety net for old data, not an interface. Everything written
 * from here on normalizes to `boundingRect` so new data has exactly one shape.
 *
 * @param {Object} word - raw word from a backend
 * @param {string} precision - PRECISION_EXACT | PRECISION_APPROXIMATE
 * @returns {{text: string, precision: string, boundingRect: Object}|null}
 */
function normalizeWord(word, precision) {
  // A break carries structure, not text, and has no geometry to normalize.
  if (isBreak(word)) return makeBreak(word.break);
  if (!word || typeof word.text !== "string") return null;

  const box = word.boundingRect || word.boundingBox || word.rect || word;
  const x = box.x !== undefined ? box.x : box.left;
  const y = box.y !== undefined ? box.y : box.top;
  const width = box.width !== undefined ? box.width : box.w;
  const height = box.height !== undefined ? box.height : box.h;

  // A word without usable geometry still contributes to fullText — search must
  // find it even when it cannot be highlighted (DESIGN §3.1, merged words).
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return { text: word.text, precision, boundingRect: null };
  }

  return { text: word.text, precision, boundingRect: { x, y, width, height } };
}

/**
 * Assemble the stored recognition object from normalized words.
 *
 * @param {Array} words
 * @param {string} engine - engine identifier, for cross-device disambiguation
 * @returns {{fullText: string, engine: string, words: Array}}
 */
function buildResult(words, engine) {
  const clean = words.filter(Boolean);
  return {
    fullText: renderFullText(clean),
    engine,
    words: clean,
  };
}

/**
 * Which backend should run, given current configuration.
 *
 * Deliberately does NOT fall back from a configured backend to a different one.
 * Silently sending strokes somewhere the user did not choose is precisely the
 * privacy failure this feature must avoid (DESIGN §6). An unavailable backend
 * returns null, recognition no-ops, and the next catch-up scan retries.
 *
 * @param {{ automatic?: boolean }} [opts]
 *   automatic — this run was triggered by the app (debounce, note close,
 *   catch-up scan) rather than by the user. AI backends are then refused; see
 *   below.
 * @returns {Promise<{id: string, config: Object}|null>}
 */
export async function selectBackend({ automatic = false } = {}) {
  const config = await getRecognitionConfig();

  if (isAiMethod(config.method)) {
    // AI backends are user-initiated only. A page takes minutes and costs money
    // per call, so an automatic trigger must never start one: closing a note
    // would stall on the request, and the startup catch-up scan would bill the
    // user for every unrecognized note at once, unprompted.
    //
    // Refusing here rather than at each call site keeps the rule in the same
    // place as the consent check — one gate every request passes through.
    // `hasRecognition` stays false, so the note remains a candidate for a
    // manual run later; nothing is written and nothing is lost.
    if (automatic) return null;
    // Both halves of the configuration must hold: a reachable provider and a
    // vision model to run on it. Either missing is "not set up", not an error.
    if (!isRecognitionReady(config)) return null;
    // Consent is checked here rather than at the call sites because this is the
    // one place every request passes through. A configured backend the user has
    // not agreed to send handwriting to is treated exactly like an unconfigured
    // one: recognition no-ops rather than uploading first and asking later
    // (DESIGN §6).
    if (!(await hasConsent(config))) return null;
    return { id: METHOD_AI, config };
  }

  if (await sidecarBackend.isAvailable()) {
    return { id: METHOD_WINDOWS_INK, config };
  }

  return null;
}

/**
 * Whether any recognition backend can run right now.
 *
 * @param {{ automatic?: boolean }} [opts] - see selectBackend(). Callers doing
 *   background work should pass `automatic: true` so they skip their scan
 *   entirely rather than discovering per note that nothing may run.
 * @returns {Promise<boolean>}
 */
export async function isRecognitionAvailable(opts = {}) {
  return (await selectBackend(opts)) !== null;
}

/**
 * Recognize a note's strokes with whichever backend is configured.
 *
 * @param {Array} strokes - active strokes in content space, temporal order
 * @param {{ signal?: AbortSignal, onProgress?: Function, automatic?: boolean,
 *           configOverride?: Object }} [opts]
 *   automatic — app-triggered rather than user-requested; restricts the run to
 *   backends that are free and local (see selectBackend).
 *   configOverride — per-run values layered over the stored configuration, for
 *   choices made in the confirmation dialog rather than in settings. Applied
 *   after selectBackend so it cannot influence which backend is chosen or
 *   whether consent holds: it tunes the run the user already approved, and must
 *   never be able to widen it.
 * @returns {Promise<{fullText: string, engine: string, words: Array}|null>}
 *   null when no backend is available or the call failed — callers leave
 *   `hasRecognition` false so the note is retried later.
 */
export async function recognize(strokes, opts = {}) {
  if (!strokes || strokes.length === 0) return null;

  const selected = await selectBackend({ automatic: opts.automatic });
  if (!selected) return null;

  const { id, config: storedConfig } = selected;
  const config = opts.configOverride ? { ...storedConfig, ...opts.configOverride } : storedConfig;

  if (id === METHOD_WINDOWS_INK) {
    const raw = await sidecarBackend.recognizeStrokes(strokes, { language: config.language });
    if (!raw) return null;
    const words = raw.map((w) => normalizeWord(w, PRECISION_EXACT));
    return buildResult(words, sidecarBackend.ENGINE_ID);
  }

  if (id === METHOD_AI) {
    // Imported lazily so the sidecar path never pulls in the rasterizer, and so
    // platforms without an AI backend configured never load that code at all.
    const { recognizeWithAi } = await import("./aiRecognition.js");
    return recognizeWithAi(strokes, config, opts);
  }

  return null;
}

/** Force re-resolution of backend availability (e.g. after a settings change). */
export function invalidateBackends() {
  sidecarBackend.invalidateUrl();
}

// Exposed for the AI path, which builds its own words but must store them in
// the same normalized shape.
export { buildResult, normalizeWord };

/**
 * Human-readable name of the engine that produced a stored result.
 *
 * Lives here because this module writes the `engine` field: the two halves of
 * that format — the sidecar's bare id and the AI path's `prefix:model` — are
 * decided in this file and in aiRecognition.js, so decoding them anywhere else
 * would put the format in two places.
 *
 * Returns null rather than a placeholder for results stored before the field
 * existed. The caller omits the line entirely; inventing "Unknown engine" would
 * state something about old notes that is not known.
 *
 * @param {string|undefined} engine - the stored `recognition.engine`
 * @returns {string|null} display name, or null when unknown
 */
export function engineDisplayName(engine) {
  if (typeof engine !== "string" || engine === "") return null;
  if (engine === sidecarBackend.ENGINE_ID) return "Windows Ink";

  // AI results are `<provider>:<model>`. The model is what distinguishes one
  // run from another — the provider is a delivery detail the user already chose
  // in settings — so only the model is shown.
  const separator = engine.indexOf(":");
  if (separator === -1) return engine;

  const model = engine.slice(separator + 1).trim();
  return model === "" ? engine : model;
}
