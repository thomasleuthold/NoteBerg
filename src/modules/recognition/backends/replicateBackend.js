/**
 * Replicate vision backend.
 *
 * Replicate is not OpenAI-compatible: it exposes a *predictions* API where a
 * model is invoked with a free-form `input` object and returns an `output`
 * whose shape is defined by the model, not by a shared spec. So this cannot
 * reuse openAiBackend — only the surrounding pipeline (rasterize → transcribe →
 * map coordinates) is shared.
 *
 * Two request forms exist:
 *   POST /v1/predictions                                 (with a version id)
 *   POST /v1/models/{owner}/{name}/predictions           (official models only)
 *
 * Community models — including lucataco/qwen3-vl-8b-instruct — generally
 * require the version id, so it is a configurable field rather than an
 * assumption.
 *
 * `Prefer: wait` makes the call synchronous, which keeps this backend the same
 * shape as the others. It has a server-side timeout (~60s), after which the
 * prediction is still running and must be polled — handled below.
 */

import { assertAllowedDestination } from "../endpointValidation.js";
import { buildSystemPrompt } from "../prompts.js";
import { blobToDataUrl, getFetch } from "./backendTransport.js";
import { parseModelResponse } from "./openAiBackend.js";

/**
 * Build the single prompt Replicate models take.
 *
 * Replicate has no system/user split, so the instructions and the task are
 * combined. Shares buildSystemPrompt() with the OpenAI backend so a rule added
 * for one provider applies to both.
 *
 * @param {Object} config
 * @returns {string}
 */
function buildPrompt(config) {
  const languageHint = config.language ? `The handwriting is in ${config.language}. ` : "";
  return `${languageHint}${buildSystemPrompt(config)}`;
}

/** Identifies which engine produced a stored recognition (DESIGN §9). */
export const ENGINE_PREFIX = "replicate";

/** Replicate's API host. Used to recognize a Replicate endpoint. */
export const REPLICATE_HOST = "api.replicate.com";

/** Ceiling on how long to keep polling a prediction that outlived `Prefer: wait`. */
const POLL_TIMEOUT_MS = 300000; // 5 minutes
const POLL_INTERVAL_MS = 1500;

/**
 * Normalize a model's `output` into a single string.
 *
 * Language models on Replicate typically stream token fragments, so `output` is
 * commonly an array of strings that must be concatenated — joining with a
 * separator would corrupt words split across fragments.
 *
 * @param {unknown} output
 * @returns {string|null}
 */
export function outputToText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    if (!output.every((part) => typeof part === "string")) return null;
    return output.join("");
  }
  return null;
}

/** Base URL every Replicate request must sit beneath. */
export const REPLICATE_BASE = `https://${REPLICATE_HOST}/v1`;

/**
 * Replicate model reference: "owner/name", each a conservative slug.
 *
 * The model is a free-text setting interpolated into a request path, so it is
 * validated rather than trusted: a value of "../../x" escapes /v1/models/ and
 * rewrites which endpoint is called, and one containing "?" or "#" truncates the
 * path entirely. Matching Replicate's own naming keeps this a whitelist.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** Version ids are hex digests; anything else is not a version. */
const VERSION_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * Validate a model reference, throwing with a usable message if it is not one.
 *
 * @param {string} model
 * @throws {Error}
 */
export function assertValidModel(model) {
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    throw new Error(
      `"${model}" is not a valid Replicate model. Use the owner/name form, for example "lucataco/qwen3-vl-8b-instruct".`,
    );
  }
}

/**
 * Validate a version id, throwing if it could alter the request path.
 *
 * @param {string} version
 * @throws {Error}
 */
export function assertValidVersion(version) {
  if (version && !VERSION_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a valid Replicate version id.`);
  }
}

/**
 * Build the prediction request URL.
 *
 * @param {Object} config
 * @returns {string}
 */
export function buildPredictionUrl(config) {
  // A version id identifies an exact build and works for any model, including
  // community ones. Without it, only Replicate's own official models resolve.
  if (config.replicateVersion) {
    assertValidVersion(config.replicateVersion);
    return `${REPLICATE_BASE}/predictions`;
  }
  assertValidModel(config.model);
  return `${REPLICATE_BASE}/models/${config.model}/predictions`;
}

/**
 * Poll a prediction until it leaves a running state.
 *
 * `Prefer: wait` returns early if the model outruns the server-side timeout, so
 * a slow first-token or a cold boot would otherwise surface as an empty output
 * rather than as a result.
 */
async function pollPrediction(httpFetch, url, headers, opts) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Recognition cancelled");

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const res = await httpFetch(url, { method: "GET", headers, signal: opts.signal });
    if (!res.ok) {
      throw new Error(`Replicate poll failed with ${res.status}`);
    }
    const prediction = await res.json();

    if (prediction.status === "succeeded") return prediction;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(`Replicate prediction ${prediction.status}: ${prediction.error ?? ""}`);
    }
  }

  throw new Error("Replicate prediction did not complete within the timeout");
}

/**
 * Candidate input field names for the image, most common first.
 *
 * Replicate models declare their own input schema, and vision models disagree
 * on what the image field is called. Critically, **Replicate ignores unknown
 * input fields rather than rejecting them**, so guessing wrong does not fail —
 * the model simply runs with no image and answers as if the page were blank.
 * That is indistinguishable from a bad transcription, which is why the schema
 * is fetched rather than assumed (see fetchInputSchema).
 */
const IMAGE_FIELD_CANDIDATES = ["image", "media", "images", "image_input", "input_image"];

/** Candidate field names for the text prompt. */
const PROMPT_FIELD_CANDIDATES = ["prompt", "text", "question", "instruction"];

/** Candidate field names for the output-length cap. */
const MAX_TOKEN_FIELD_CANDIDATES = ["max_new_tokens", "max_tokens", "max_length"];

/**
 * Read a model's declared input schema from Replicate.
 *
 * Requires the user's token. Used to resolve field names rather than guessing,
 * because a wrong guess fails silently (see IMAGE_FIELD_CANDIDATES).
 *
 * Returns the full property definitions rather than just names: field *types*
 * matter as much as field names. Models disagree on whether an image input is a
 * single URI or an array of them, and sending the wrong shape is a hard 422.
 *
 * @param {Object} config
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Object|null>} declared input properties keyed by name, or null
 */
export async function fetchInputSchema(config, opts = {}) {
  const httpFetch = await getFetch();
  // Both segments land in the request path, so both are validated before use.
  assertValidModel(config.model);
  assertValidVersion(config.replicateVersion);

  const url = config.replicateVersion
    ? `${REPLICATE_BASE}/models/${config.model}/versions/${config.replicateVersion}`
    : `${REPLICATE_BASE}/models/${config.model}`;

  // The widened Tauri allowlist permits any https host, so the destination is
  // confirmed to be Replicate here rather than assumed from the literal prefix.
  assertAllowedDestination(url, REPLICATE_BASE);

  const res = await httpFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: opts.signal,
  });

  if (!res.ok) return null;

  const body = await res.json();
  const schema =
    body?.openapi_schema?.components?.schemas?.Input?.properties ??
    body?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties;

  return schema ?? null;
}

/**
 * Pick the first candidate the model actually declares.
 * Falls back to the first candidate when the schema is unavailable, preserving
 * previous behaviour rather than refusing to run.
 *
 * @param {string[]} candidates
 * @param {Object|null} declared - input properties keyed by name
 * @returns {string}
 */
function pickField(candidates, declared) {
  if (!declared) return candidates[0];
  return candidates.find((name) => name in declared) ?? candidates[0];
}

/**
 * Coerce a value to the type the model declares for that field.
 *
 * Replicate rejects a type mismatch outright (422), and models genuinely differ:
 * some take an image as a single URI string, others as an array of them. The
 * schema is the authority, so the value is shaped to match rather than guessed.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {Object|null} declared
 * @returns {unknown}
 */
export function coerceToDeclaredType(value, field, declared) {
  const type = declared?.[field]?.type;
  if (type === "array" && !Array.isArray(value)) return [value];
  if (type !== "array" && Array.isArray(value)) return value[0];
  return value;
}

/**
 * Whether a reply looks cut off rather than malformed.
 *
 * A truncated JSON response starts correctly and simply stops: braces and
 * brackets are left unclosed. Telling this apart from a model that answered in
 * prose matters because the fixes are completely different — raise the token
 * limit versus change the model or prompt.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksTruncated(text) {
  if (typeof text !== "string" || text.trim() === "") return false;

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;

  // Count unclosed structure, ignoring braces inside string literals.
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const ch of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
  }

  // Unclosed structure, or ending inside a string, both mean "stopped early".
  return depth > 0 || inString;
}

/**
 * Transcribe one rendered band via Replicate.
 *
 * @param {Object} band - from rasterizeNote()
 * @param {Object} config - recognition config
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Array>} raw model word entries
 */
export async function transcribeBand(band, config, opts = {}) {
  if (!config.apiKey) {
    throw new Error("Replicate requires an API token. Add it in settings.");
  }

  const httpFetch = await getFetch();
  const dataUrl = await blobToDataUrl(band.png);

  // Replicate recommends data URIs only below ~1MB. Above that the image must
  // be uploaded first, which needs a second round-trip; flag it clearly rather
  // than sending a request that will be rejected downstream.
  const approxBytes = (dataUrl.length * 3) / 4;
  if (approxBytes > 1_000_000) {
    throw new Error(
      `Rendered image is ${Math.round(approxBytes / 1024)}KB, above Replicate's ~1MB inline limit. Reduce "Max image size" in settings.`,
    );
  }

  const url = buildPredictionUrl(config);
  assertAllowedDestination(url, REPLICATE_BASE);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    // Ask for a synchronous response so this backend behaves like the others.
    Prefer: "wait",
  };

  // Resolve field names from the model's own schema. A wrong image field name
  // is silently dropped by Replicate, producing an empty transcription that
  // looks like a model failure — so this is worth an extra request.
  let declared = null;
  try {
    declared = await fetchInputSchema(config, opts);
  } catch (_e) {
    // Schema unavailable; fall back to the conventional names below.
  }

  const imageField = pickField(IMAGE_FIELD_CANDIDATES, declared);
  const promptField = pickField(PROMPT_FIELD_CANDIDATES, declared);
  const maxTokensField = pickField(MAX_TOKEN_FIELD_CANDIDATES, declared);

  if (declared && !(imageField in declared)) {
    throw new Error(
      `Model "${config.model}" declares no image input field. Available inputs: ${Object.keys(declared).join(", ")}`,
    );
  }

  const input = {
    // Shape each value to the declared type — see coerceToDeclaredType().
    [imageField]: coerceToDeclaredType(dataUrl, imageField, declared),
    [promptField]: coerceToDeclaredType(buildPrompt(config), promptField, declared),
  };

  // Optional tuning fields are sent only when declared. Models on Replicate vary
  // widely — a hosted GPT wrapper exposes a different set from a self-contained
  // vision model — and an undeclared field is at best ignored, at worst a 422.
  if (!declared || maxTokensField in declared) {
    input[maxTokensField] = config.maxTokens ?? 8000;
  }
  if (!declared || "temperature" in declared) {
    input.temperature = 0;
  }
  // Some wrappers expose the system prompt separately; use it when offered so
  // the formatting rules are not buried in the user turn.
  if (declared && "system_prompt" in declared) {
    input.system_prompt = "You transcribe handwriting from images and reply only with JSON.";
  }

  console.log(
    `[Recognition] Replicate input fields: ${Object.keys(input).join(", ")}${
      declared ? ` (declared: ${Object.keys(declared).join(", ")})` : " (schema unavailable)"
    }`,
  );

  const body = { input };
  if (config.replicateVersion) body.version = config.replicateVersion;

  const response = await httpFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Replicate returned ${response.status}: ${raw.slice(0, 300)}`);
  }

  let prediction;
  try {
    prediction = JSON.parse(raw);
  } catch (_e) {
    throw new Error(`Replicate did not return JSON. Received: ${raw.slice(0, 200)}`);
  }

  // `Prefer: wait` gives up after ~60s and returns a still-running prediction.
  if (prediction.status && prediction.status !== "succeeded") {
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(`Replicate prediction ${prediction.status}: ${prediction.error ?? ""}`);
    }
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) {
      throw new Error("Replicate prediction is still running but returned no polling URL");
    }
    // The polling URL comes from the response body and is followed with the
    // user's API token attached, so it is confirmed to point back at Replicate
    // rather than trusted because the previous response looked genuine.
    assertAllowedDestination(pollUrl, REPLICATE_BASE);
    prediction = await pollPrediction(httpFetch, pollUrl, headers, opts);
  }

  const text = outputToText(prediction.output);
  if (text === null) {
    throw new Error(
      `Replicate returned an unexpected output shape. Received: ${JSON.stringify(prediction.output).slice(0, 200)}`,
    );
  }

  const words = parseModelResponse(text);
  if (words === null) {
    // Distinguish a truncated reply from a model that answered in the wrong
    // shape. Replicate reports no finish_reason, so truncation is inferred from
    // the text itself: valid JSON that simply stops mid-structure.
    if (looksTruncated(text)) {
      throw new Error(
        `Model output was cut off after ${text.length} characters — the note produced more ` +
          'words than the response limit allows. Raise "Max response length" in settings ' +
          `(currently ${config.maxTokens ?? 8000}); a page of handwriting needs roughly ` +
          "16 tokens per word.",
      );
    }
    throw new Error(`Model did not return the expected JSON. It replied: ${text.slice(0, 200)}`);
  }

  return words;
}
