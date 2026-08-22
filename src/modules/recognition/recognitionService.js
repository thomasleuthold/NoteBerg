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
import { hasConsent } from "./consent.js";
import {
  BACKEND_OPENAI,
  BACKEND_REPLICATE,
  BACKEND_SIDECAR,
  getRecognitionConfig,
  isAiBackend,
  isAiConfigured,
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
    fullText: clean
      .map((w) => w.text)
      .join(" ")
      .trim(),
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
 * @returns {Promise<{id: string, config: Object}|null>}
 */
export async function selectBackend() {
  const config = await getRecognitionConfig();

  if (isAiBackend(config.backend)) {
    if (!isAiConfigured(config)) return null;
    // Consent is checked here rather than at the call sites because this is the
    // one place every request passes through. A configured backend the user has
    // not agreed to send handwriting to is treated exactly like an unconfigured
    // one: recognition no-ops rather than uploading first and asking later
    // (DESIGN §6).
    if (!(await hasConsent(config))) return null;
    return { id: config.backend, config };
  }

  if (await sidecarBackend.isAvailable()) {
    return { id: BACKEND_SIDECAR, config };
  }

  return null;
}

/**
 * Whether any recognition backend can run right now.
 * @returns {Promise<boolean>}
 */
export async function isRecognitionAvailable() {
  return (await selectBackend()) !== null;
}

/**
 * Recognize a note's strokes with whichever backend is configured.
 *
 * @param {Array} strokes - active strokes in content space, temporal order
 * @param {{ signal?: AbortSignal, onProgress?: Function }} [opts]
 * @returns {Promise<{fullText: string, engine: string, words: Array}|null>}
 *   null when no backend is available or the call failed — callers leave
 *   `hasRecognition` false so the note is retried later.
 */
export async function recognize(strokes, opts = {}) {
  if (!strokes || strokes.length === 0) return null;

  const selected = await selectBackend();
  if (!selected) return null;

  const { id, config } = selected;

  if (id === BACKEND_SIDECAR) {
    const raw = await sidecarBackend.recognizeStrokes(strokes, { language: config.language });
    if (!raw) return null;
    const words = raw.map((w) => normalizeWord(w, PRECISION_EXACT));
    return buildResult(words, sidecarBackend.ENGINE_ID);
  }

  if (id === BACKEND_OPENAI || id === BACKEND_REPLICATE) {
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
