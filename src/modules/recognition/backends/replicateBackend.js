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
 * This used to prepend the configured language itself. It no longer does: the
 * hint is a {{language}} token inside the prompt template, so both providers now
 * send byte-identical instructions and a prompt comparison between them is
 * actually comparing the same input. Prepending here also put the hint outside
 * the user-editable prompt, where nobody could see or reorder it.
 *
 * @param {Object} config
 * @returns {string}
 */
function buildPrompt(config) {
  return buildSystemPrompt(config);
}

/** Identifies which engine produced a stored recognition (DESIGN §9). */
export const ENGINE_PREFIX = "replicate";

/** Replicate's API host. Used to recognize a Replicate endpoint. */
export const REPLICATE_HOST = "api.replicate.com";

/**
 * Whether the credential is this side's responsibility.
 *
 * On Nextcloud it is not: the key is stored per user on the server and attached
 * by the proxy, and is deliberately never sent to the browser. So `config.apiKey`
 * is empty there by design, and treating that as "unconfigured" would refuse
 * every request on a correctly set up instance.
 */
const CLIENT_HOLDS_KEY = import.meta.env.VITE_PLATFORM !== "nextcloud";

/**
 * Authorization header for a Replicate call, or nothing.
 *
 * Omitted entirely where the proxy owns the credential — the proxy discards
 * client headers and attaches its own, so sending "Bearer " with an empty key
 * would be dead weight that reads like a bug in the logs.
 *
 * @param {Object} config
 * @returns {Object}
 */
function authHeader(config) {
  return CLIENT_HOLDS_KEY && config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

/** Ceiling on how long to keep polling a prediction that outlived `Prefer: wait`. */
const POLL_TIMEOUT_MS = 300000; // 5 minutes

/**
 * How often to ask whether a prediction has finished.
 *
 * Longer on Nextcloud, because there a poll is not a cheap direct GET: every
 * request goes through the app's own proxy, and that route is rate-limited per
 * user (RecognitionController::dispatch, 60 per 300s). At 1.5s a single band's
 * polling exhausts that budget after 90 seconds — well inside POLL_TIMEOUT_MS —
 * and the prediction it was collecting is one already dispatched and paid for.
 *
 * 5s keeps a 5-minute poll inside the budget with room for the dispatch and
 * schema requests beside it. The cost is up to 5s of extra latency on a result
 * that took minutes to produce, which is not a trade worth optimising.
 *
 * The native builds call Replicate directly with no such limit, so they keep
 * the responsive interval.
 *
 * This raises the threshold rather than removing it: a long enough run can still
 * reach the limit, which is why a 429 is also retried rather than fatal — see
 * pollPrediction.
 */
const POLL_INTERVAL_MS = import.meta.env.VITE_PLATFORM === "nextcloud" ? 5000 : 1500;

/**
 * How long to wait out a rate limit before asking again.
 *
 * Deliberately longer than the poll interval: a 429 means the budget is spent,
 * so polling at the normal cadence would only spend the next window's on
 * refusals too.
 */
const RATE_LIMIT_BACKOFF_MS = 30000;

/**
 * The per-request budget, in seconds, for the Nextcloud proxy.
 *
 * Read by proxyFetch and forwarded to the server, which clamps it and applies it
 * to the upstream call. Without it every Replicate request fell back to the
 * proxy's own 55-second default, so a user who raised "Recognition timeout" for
 * a slow model was told by the resulting error to raise the very setting that
 * was already raised and not being consulted.
 *
 * Inert off Nextcloud: the native builds call Replicate directly and the Tauri
 * client ignores an init key it does not know, so this changes nothing there.
 *
 * Note this is the budget for one HTTP call, which is a different thing from
 * POLL_TIMEOUT_MS — that bounds how long we keep asking about a prediction that
 * is already running server-side, and each individual poll is a fast round trip.
 *
 * @param {Object} config
 * @returns {number}
 */
function timeoutSecondsFor(config) {
  return Math.max(1, Number(config?.timeoutSeconds) || 120);
}

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
 *
 * A rate limit is waited out rather than treated as a failure. What is being
 * polled is a prediction that is already running and already paid for, so
 * abandoning it because we asked about it too often loses the very thing the
 * poll exists to collect — and both places a 429 can come from are transient:
 * Replicate's own per-account limit, and on Nextcloud the proxy's per-user one.
 * The deadline below still bounds the whole wait, so this cannot spin forever.
 */
async function pollPrediction(httpFetch, url, headers, opts, timeoutSeconds) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let rateLimited = false;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Recognition cancelled");

    await new Promise((resolve) =>
      setTimeout(resolve, rateLimited ? RATE_LIMIT_BACKOFF_MS : POLL_INTERVAL_MS),
    );

    const res = await httpFetch(url, {
      method: "GET",
      headers,
      signal: opts.signal,
      timeoutSeconds,
    });

    if (res.status === 429) {
      // Back off and keep waiting. Logged because a run that quietly takes
      // minutes longer than usual should say why.
      if (!rateLimited) {
        console.log(
          "[Replicate] Polling is rate limited; backing off. The prediction is still running.",
        );
      }
      rateLimited = true;
      continue;
    }
    rateLimited = false;

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
    headers: authHeader(config),
    signal: opts.signal,
    timeoutSeconds: timeoutSecondsFor(config),
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
  if (CLIENT_HOLDS_KEY && !config.apiKey) {
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
    ...authHeader(config),
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
    // The dispatch carries `Prefer: wait`, so this is the call that can actually
    // occupy the full budget while the model runs.
    timeoutSeconds: timeoutSecondsFor(config),
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

    // Hand the URL up BEFORE polling, not after. A prediction runs server-side
    // whether or not anyone is listening, and it has already been paid for — so
    // if the app dies during the poll below, this is the only thing that lets a
    // later session collect the result instead of paying for it twice.
    await opts.onPredictionStarted?.(pollUrl);

    prediction = await pollPrediction(httpFetch, pollUrl, headers, opts, timeoutSecondsFor(config));
  }

  return predictionToWords(prediction, config);
}

/**
 * Turn a succeeded prediction into the word list a band result needs.
 *
 * Split out so a resumed prediction — collected by resumePrediction() after the
 * app restarted — is parsed by exactly the same code as a fresh one. Two
 * parsers would eventually disagree, and the disagreement would only show up on
 * the resume path, which is the harder one to test.
 *
 * @param {Object} prediction
 * @param {Object} config
 * @returns {Array}
 */
function predictionToWords(prediction, config) {
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

/**
 * Collect a prediction that was dispatched by an earlier session.
 *
 * The whole reason Replicate can be resumed: a prediction runs server-side
 * whether or not a client is listening, and its result is retained for a while
 * after it finishes. So an app that died mid-poll can come back and pick up
 * work it has already paid for.
 *
 * Returns null when the prediction is gone (retention expired) or was cancelled
 * server-side — the caller then re-sends that band rather than failing the note.
 *
 * @param {string} pollUrl - persisted at dispatch time
 * @param {Object} config
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Array|null>} words, or null when it cannot be collected
 */
export async function resumePrediction(pollUrl, config, opts = {}) {
  if (!pollUrl) return null;
  if (CLIENT_HOLDS_KEY && !config.apiKey) return null;

  // The URL comes out of local storage rather than a live response, so it is
  // re-validated exactly as a freshly received one would be — persisted state
  // is not a reason to trust a destination.
  assertAllowedDestination(pollUrl, REPLICATE_BASE);

  const httpFetch = await getFetch();
  const headers = {
    "Content-Type": "application/json",
    ...authHeader(config),
  };

  try {
    const res = await httpFetch(pollUrl, {
      method: "GET",
      headers,
      signal: opts.signal,
      timeoutSeconds: timeoutSecondsFor(config),
    });
    if (res.status === 404) return null; // retention expired
    // A rate limit says nothing about the prediction, which is still running and
    // already paid for. Returning null here would send the caller off to re-send
    // the band and pay a second time, so hand over to the polling loop instead —
    // it waits the limit out under the same deadline as any other slow poll.
    if (res.status === 429) {
      return predictionToWords(
        await pollPrediction(httpFetch, pollUrl, headers, opts, timeoutSecondsFor(config)),
        config,
      );
    }
    if (!res.ok) return null;

    const prediction = await res.json();
    if (prediction.status === "failed" || prediction.status === "canceled") return null;

    // Still running: wait for it, same as the original dispatch would have.
    const settled =
      prediction.status === "succeeded"
        ? prediction
        : await pollPrediction(httpFetch, pollUrl, headers, opts, timeoutSecondsFor(config));

    return predictionToWords(settled, config);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    console.warn("[Replicate] Could not resume prediction:", err);
    return null;
  }
}
