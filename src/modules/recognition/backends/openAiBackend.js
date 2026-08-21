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
    return Array.isArray(parsed?.words) ? parsed.words.map(repairEntry) : null;
  } catch (_e) {
    // Truncated output is worth salvaging rather than discarding. A reply cut
    // off by the token limit is valid JSON right up to the cut, so every
    // complete entry before it is usable — losing a whole page because its last
    // word was clipped is a far worse outcome than a slightly short one.
    const salvaged = salvageCompleteEntries(text);
    return salvaged.length > 0 ? salvaged : null;
  }
}

/**
 * Extract every complete {"text": ..., "box": [...]} object from a partial
 * response.
 *
 * Deliberately narrow: it matches only fully-formed entries, so a half-written
 * final entry is dropped rather than guessed at. Coordinates are parsed as
 * numbers here and normalised later, exactly as for a well-formed reply.
 *
 * @param {string} text
 * @returns {Array} complete entries, possibly empty
 */
export function salvageCompleteEntries(text) {
  if (typeof text !== "string") return [];

  const entries = [];
  // Match a text field followed by a 4-number box, under any of the key names
  // models use. Anchored on the closing bracket so a truncated box is skipped.
  const pattern = new RegExp(
    String.raw`\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,` +
      String.raw`\s*"(?:box|box_2d|bbox)"\s*:\s*\[` +
      String.raw`\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]`,
    "g",
  );

  for (const m of text.matchAll(pattern)) {
    entries.push({
      text: m[1],
      box: [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
    });
  }

  return entries;
}

/**
 * Repair an entry mangled by the model emitting a duplicate "text" key.
 *
 * Observed output: {"text": "with", "text": "67, 41, 100, 129]}. JSON keeps the
 * last value for a duplicate key, so the word is replaced by a fragment of its
 * own coordinates and is lost entirely. The fragment is recognisable — it parses
 * as a comma-separated number list — so the geometry can be recovered even
 * though the word text cannot.
 *
 * The word is dropped rather than guessed: a made-up word in `fullText` would
 * make search return the wrong note.
 *
 * @param {Object} entry
 * @returns {Object}
 */
function repairEntry(entry) {
  if (!entry || typeof entry.text !== "string") return entry;

  // A "text" value that is really a coordinate list, e.g. "67, 41, 100, 129]".
  const numbers = entry.text
    .replace(/[\][]/g, "")
    .split(",")
    .map((p) => Number(p.trim()));
  const looksLikeBox = numbers.length === 4 && numbers.every((n) => Number.isFinite(n));

  if (looksLikeBox && entry.box === undefined) {
    return { text: "", box: numbers, _recovered: true };
  }

  return entry;
}

/**
 * Map one model word entry onto content-space geometry.
 *
 * @param {Object} entry - {text, box:[x0,y0,x1,y1]} in normalized image coords
 * @param {{width, height, contentX, contentY, scale}} band
 * @returns {{text: string, boundingRect: Object|null}|null}
 */
export function mapWordToContent(entry) {
  if (!entry || typeof entry.text !== "string" || !entry.text.trim()) return null;

  // Words carry a colour band, not coordinates. Coordinates were tried and did
  // not work: models emit a plausible layout rather than a measured one, and
  // the drift exceeded a line height. See regions.js.
  //
  // A word whose band cannot be read still contributes its text, so search finds
  // it even when it cannot be located.
  const region = parseRegionId(entry.region ?? entry.band ?? entry.color);
  return { text: entry.text, boundingRect: null, region: region >= 0 ? region : null };
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

  const post = (payload) =>
    httpFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: opts.signal,
    });

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

  const content = json?.choices?.[0]?.message?.content;

  if (finishReason === "length") {
    // Hitting the cap means the model was not producing the compact JSON asked
    // for. Say so plainly: the same symptom from a truncated 3000-token ramble
    // and from a genuinely huge page needs different fixes.
    throw new Error(
      `Model hit the ${body.max_tokens}-token output limit without completing its JSON. It is likely looping or narrating rather than transcribing. Response began: ${String(content).slice(0, 200)}`,
    );
  }

  if (typeof content !== "string") {
    throw new Error(
      `Recognition endpoint returned no message content. Received: ${raw.slice(0, 200)}`,
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
