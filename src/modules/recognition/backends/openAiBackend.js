/**
 * OpenAI-compatible vision backend.
 *
 * Targets any endpoint exposing `/v1/chat/completions` with image input —
 * LM Studio, Ollama, OpenAI, OpenRouter — so a user can point recognition at
 * local inference or a cloud model without a code change.
 *
 * Returns text plus a colour band per word. Coordinates are not requested:
 * models emit a plausible layout rather than a measured one, drifting by more
 * than a line height, so words are localized to a visible colour band instead —
 * a question models answer reliably. See regions.js.
 */

import { BREAK_LINE, isBreak, makeBreak } from "../breaks.js";
import { assertAllowedDestination, normalizeEndpoint } from "../endpointValidation.js";
import { buildSystemPrompt } from "../prompts.js";
import { parseRegionId } from "../regions.js";
import { blobToDataUrl, getFetch } from "./backendTransport.js";

/** Identifies which engine produced a stored recognition (DESIGN §9). */
export const ENGINE_PREFIX = "openai";

/**
 * Structured-output schema for the transcription reply.
 *
 * `region` is deliberately NOT required. Under `strict: true` a required field
 * forces the model to produce a value for every word, and a model unsure which
 * band a word sits on then has two options: invent a colour, or omit the word
 * entirely. Constrained decoding makes omission the easier path, so requiring
 * the field measurably cost transcribed words.
 *
 * Text is what matters most — a word with no band is still searchable, whereas
 * a word that was dropped is gone. So the field is optional and localization is
 * best-effort, matching what region mode actually claims to deliver.
 */
const REGION_RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "handwriting_regions",
    // Not strict: a strict schema in this shape suppresses words.
    strict: false,
    schema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, region: { type: "string" } },
            required: ["text"],
          },
        },
      },
      required: ["words"],
    },
  },
};

/**
 * Pull the assistant's text out of a chat message, whatever shape it arrived in.
 *
 * `message.content` is a plain string in the OpenAI spec, but three variants
 * reach us in practice and all three are legitimate:
 *
 *   - An array of typed parts ({type:"text", text:"..."}), returned by several
 *     OpenAI-compatible servers and by Anthropic-style gateways.
 *   - `null` content alongside a populated `reasoning` field, which is what
 *     OpenRouter returns when it routes to a reasoning model. The transcription
 *     JSON is genuinely in there — the model answered, the text just is not
 *     where the spec puts it. This is a real failure seen against OpenRouter:
 *     350 completion tokens, finish_reason "stop", and no content.
 *   - The spec's plain string.
 *
 * Reasoning is used only as a fallback, never in preference to content: when a
 * model emits both, the reasoning is its thinking and the content is its answer.
 *
 * @param {unknown} message - `choices[0].message`
 * @returns {string|null} the text, or null when there is none to be had
 */
export function extractMessageContent(message) {
  if (!message) return null;

  const { content } = message;
  if (typeof content === "string" && content.trim() !== "") return content;

  // Typed content parts. Concatenated rather than taking the first: a model may
  // split its answer across several text parts, and keeping only one would
  // truncate the transcription without any sign that it happened.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .filter((part) => typeof part === "string" && part !== "")
      .join("");
    if (text.trim() !== "") return text;
  }

  // Reasoning-model fallback. Some gateways nest it, so both shapes are read.
  const reasoning = message.reasoning ?? message.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim() !== "") return reasoning;

  return null;
}

/**
 * Extract the JSON object from a model response.
 *
 * Models wrap JSON in prose or code fences despite instructions, so this is
 * tolerant by design — but it never *guesses* structure: anything that does not
 * parse into a words array is rejected rather than salvaged, because a partial
 * parse would silently drop text.
 *
 * @param {string} content
 * @returns {Array|null} raw word entries, or null if unparseable
 */
export function parseModelResponse(content) {
  if (typeof content !== "string") return null;

  let text = content.trim();

  // Strip a markdown code fence if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // Fall back to the outermost braces if the model added prose around it.
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.words) ? parsed.words : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Map one model word entry onto the shape the pipeline stores.
 *
 * Words carry a colour band, not coordinates. Coordinates were tried and did not
 * work: models emit a plausible layout rather than a measured one, and the drift
 * exceeded a line height. See regions.js.
 *
 * A word whose band cannot be read still contributes its text, so search finds
 * it even when it cannot be located.
 *
 * A model reporting a break as the word "break" is repaired here rather than
 * stored as text; see the comment on that branch.
 *
 * @param {Object} entry - {text, region} from the model, or a break entry
 * @returns {{text: string, region: number|null}|{break: number}|null} null for
 *   an unusable entry
 */
export function mapWordToContent(entry) {
  // A break describes the layout between words rather than a word, so it has no
  // band to resolve and passes straight through.
  if (isBreak(entry)) return makeBreak(entry.break);
  if (!entry || typeof entry.text !== "string" || !entry.text.trim()) return null;

  // Models routinely report a break as a word: either {"break":1,"text":"break"}
  // — the marker filled in with the key's own name — or a bare {"text":"break"}.
  // isBreak() rejects both, because it requires a break to carry no text, and
  // that requirement is load-bearing for every consumer of `words`. So the
  // repair belongs here, at the boundary where model output is normalized,
  // rather than in isBreak.
  //
  // Left alone the word "break" lands in the transcript where a line ending
  // should be, which is both a wrong word and a lost line.
  //
  // An explicit break count is honoured when present, so a paragraph marker
  // that also carried text still separates paragraphs.
  //
  // The comparison is deliberately exact after trimming and lowercasing: only
  // the bare marker is converted. A page that genuinely says "break" — "coffee
  // break", "break glass" — reaches here as normal prose with punctuation or
  // neighbouring words, and the risk of dropping a real word is worse than the
  // risk of a stray marker surviving.
  if (entry.text.trim().toLowerCase() === "break") {
    return makeBreak(entry.break ?? BREAK_LINE);
  }

  const region = parseRegionId(entry.region ?? entry.band ?? entry.color);
  return { text: entry.text, region: region >= 0 ? region : null };
}

/**
 * Transcribe one rendered band.
 *
 * @param {Object} band - from rasterizeNote()
 * @param {Object} config - recognition config (endpoint, model, apiKey, language)
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Array>} raw model word entries
 * @throws on transport or API failure, so the caller can leave the note unrecognized
 */
export async function transcribeBand(band, config, opts = {}) {
  const httpFetch = await getFetch();
  const dataUrl = await blobToDataUrl(band.png);

  // Normalize here as well as at save time: a config stored before endpoint
  // normalization existed, or written directly, would otherwise silently lose
  // the /v1 segment and hit a route the server does not serve.
  const base = normalizeEndpoint(config.endpoint);
  const url = `${base}/chat/completions`;

  // The Tauri allowlist permits any https host and any localhost port; this is
  // what actually confines the request to the endpoint the user configured.
  assertAllowedDestination(url, base);

  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const languageHint = config.language ? `The handwriting is in ${config.language}. ` : "";

  // The prompt adapts to what was actually rendered — see prompts.js. The crop
  // hint in particular is conditional: "ink touches all four edges" is
  // guaranteed by cropping, but false in full-page mode where the ink may
  // genuinely occupy a corner.
  const systemPrompt = buildSystemPrompt(config);

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: `${languageHint}Transcribe this handwriting.` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    // Deterministic output: transcription is not a creative task, and sampling
    // variation would make the same note produce different text on each run,
    // defeating the compare-before-write that prevents sync churn.
    temperature: 0,
    // Cap the response. A page of handwriting is a few hundred tokens of JSON;
    // small quantized models can instead loop or narrate, generating thousands
    // of tokens that will never parse. Without a cap that runs until the
    // context fills — on slow local inference, minutes of pure waste.
    max_tokens: config.maxTokens ?? 8000,
    // Repetition at temperature 0 is a known failure mode of small quants and
    // is what turns a stuck generation into a very long one.
    repetition_penalty: 1.05,
    // Constrain the output shape where the server supports it.
    //
    // `json_schema` rather than `json_object`: LM Studio rejects the latter
    // outright ("must be 'json_schema' or 'text'"), and a schema is the better
    // tool anyway — it stops the model narrating or looping instead of
    // transcribing, which is what produced multi-thousand-token replies.
    //
    // Servers that do not implement structured output may 400 on this too, so
    // the caller retries once without it rather than failing the note.
    response_format: REGION_RESPONSE_SCHEMA,
  };

  // Bound the wait. Without this the only limit was whatever the transport
  // happened to impose — nothing at all under Tauri, and the Nextcloud proxy's
  // server-side cap on NC, which the client could neither see nor influence.
  const timeoutMs = Math.max(1, Number(config.timeoutSeconds) || 120) * 1000;
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);

  /**
   * Send one request under the timeout.
   *
   * The controller is per attempt: the structured-output retry below is a second
   * request and deserves its own full budget rather than the remainder of the
   * first one's.
   *
   * Chained to the caller's signal rather than replacing it, so cancelling a job
   * still aborts immediately instead of waiting the timeout out.
   */
  const post = async (payload) => {
    const attempt = new AbortController();
    const onCallerAbort = () => attempt.abort();
    if (opts.signal?.aborted) attempt.abort();
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, timeoutMs);

    try {
      return await httpFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: attempt.signal,
        // Read by the Nextcloud proxy, which does the waiting on the server side
        // and so needs the budget itself: a client-side abort cannot lengthen a
        // cap enforced in PHP.
        timeoutSeconds,
      });
    } catch (err) {
      // An abort is reported as the reason it happened. "The user cancelled" and
      // "the model took too long" are the same DOMException, and only one of
      // them is worth naming a setting to change.
      if (timedOut && !opts.signal?.aborted) {
        throw new Error(
          `The model did not respond within ${timeoutSeconds} seconds. ` +
            "Raise Recognition timeout, or use a faster model.",
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  };

  let response = await post(body);

  // Structured output is not universally implemented, and servers disagree on
  // which forms they accept — LM Studio takes json_schema but rejects
  // json_object, others support neither. Rather than probe capabilities, retry
  // once without the constraint; the prompt alone still asks for the same JSON,
  // and the parser already tolerates prose and code fences around it.
  if (response.status === 400 && body.response_format) {
    const errorBody = await response.text().catch(() => "");
    if (/response_format/i.test(errorBody)) {
      console.log("[Recognition] Endpoint rejected structured output; retrying without it.");
      const { response_format, ...withoutSchema } = body;
      response = await post(withoutSchema);
    } else {
      throw new Error(`Recognition API returned 400: ${errorBody.slice(0, 300)}`);
    }
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Recognition API returned ${response.status}: ${errorBody.slice(0, 300)}`);
  }

  // Read as text first. A server that does not serve this route may answer 200
  // with an HTML or plain-text body, and response.json() would throw a bare
  // syntax error that says nothing about what actually went wrong.
  const raw = await response.text();

  let json;
  try {
    json = JSON.parse(raw);
  } catch (_e) {
    throw new Error(
      `Recognition endpoint did not return JSON (is ${url} correct?). Received: ${raw.slice(0, 200)}`,
    );
  }

  const finishReason = json?.choices?.[0]?.finish_reason;
  const usage = json?.usage;
  if (usage) {
    console.log(
      `[Recognition] ${usage.prompt_tokens ?? "?"} prompt + ${usage.completion_tokens ?? "?"} completion tokens (finish: ${finishReason ?? "?"})`,
    );
  }

  const message = json?.choices?.[0]?.message;
  const content = extractMessageContent(message);

  if (finishReason === "length") {
    // Hitting the cap means the model was not producing the compact JSON asked
    // for. Say so plainly: the same symptom from a truncated 3000-token ramble
    // and from a genuinely huge page needs different fixes.
    throw new Error(
      `Model hit the ${body.max_tokens}-token output limit without completing its JSON. It is likely looping or narrating rather than transcribing. Response began: ${String(content).slice(0, 200)}`,
    );
  }

  if (typeof content !== "string") {
    // The message itself, not the raw body. Providers that pretty-print their
    // JSON put ~200 characters of indentation before anything meaningful, so
    // slicing the raw text showed a wall of blank lines and hid the very field
    // that explains the failure.
    const refusal = typeof message?.refusal === "string" ? message.refusal : "";
    throw new Error(
      refusal
        ? `Model declined to transcribe the image: ${refusal.slice(0, 200)}`
        : `Recognition endpoint returned no message content (finish_reason: ${
            finishReason ?? "none"
          }). Message was: ${JSON.stringify(message ?? null).slice(0, 300)}`,
    );
  }

  const words = parseModelResponse(content);

  if (words === null) {
    // The model answered but not in the requested shape — a different failure
    // from a wrong URL, and worth distinguishing so the fix is obvious.
    throw new Error(`Model did not return the expected JSON. It replied: ${content.slice(0, 200)}`);
  }

  return words;
}
