import { describeRegions } from "./regions.js";

/**
 * Recognition prompts.
 *
 * Kept in one place because both backends send the same instructions and must
 * stay in step — a rule that improves accuracy on one provider is not worth
 * having only on the other.
 *
 * The prompt is user-editable, since different models respond to different
 * phrasings and whoever is comparing them is better placed to tune it than a
 * fixed default.
 */

/** Placeholder replaced with the band colours, so the list stays in one place. */
const REGION_LIST_TOKEN = "{{regionList}}";

/**
 * The default prompt.
 *
 * Asks only for text and a colour band. Coordinates were tried first and did not
 * work: models emit a plausible layout rather than a measured one, drifting by
 * more than a line height — enough to highlight the wrong text. Naming a visible
 * colour is perception rather than measurement, which models do reliably.
 */
export const SYSTEM_PROMPT = `You transcribe handwritten notes. You are given one image containing handwriting.

The page is painted in six horizontal colour bands, top to bottom: ${REGION_LIST_TOKEN}.

Return ONLY a JSON object of this exact shape, with no prose and no code fence:
{"words":[{"text":"word","region":"green"}]}

Rules:
- Transcribe ONLY words you can actually see in the image. Never infer, complete,
  or invent text. If you are unsure what a word says, omit it.
- Do not use the conversation or any prior context to guess the content. The image
  is the only source.
- One entry per word, in natural reading order.
- "region" is the colour of the band the word sits on. Report the colour you can
  actually see behind the word — do not calculate it from a position.
- If a word straddles two bands, use the band containing most of it.
- Transcribing the word matters more than its band. If you cannot tell which band
  a word is on, still include the word and omit its "region" — never drop a word
  because you are unsure of its colour.
- Transcribe exactly what is written. Do not correct spelling or add punctuation.
- If the image is blank, unreadable, or contains no handwriting, return exactly
  {"words":[]}. An empty result is correct and expected in that case — it is far
  better than inventing text.`;

/**
 * Substitute placeholders in a prompt.
 *
 * Only the band-colour list, so a prompt never hard-codes colours that
 * regions.js might change.
 *
 * @param {string} template
 * @returns {string}
 */
export function resolvePrompt(template) {
  return String(template ?? "").replace(REGION_LIST_TOKEN, describeRegions());
}

/**
 * Assemble the full system prompt for a request.
 *
 * @param {Object} config - recognition config
 * @returns {string}
 */
export function buildSystemPrompt(config = {}) {
  const template =
    typeof config.systemPrompt === "string" && config.systemPrompt.trim()
      ? config.systemPrompt
      : SYSTEM_PROMPT;

  return resolvePrompt(template);
}

/**
 * Check that a custom prompt still asks for the shape the parser needs.
 *
 * A prompt is free-form on purpose — different models respond to different
 * phrasings — but the response format is not a preference: dropping the JSON
 * instruction produces prose that fails to parse, and the note is stored with
 * no recognition at all. Warning at edit time is far kinder than discovering it
 * after a slow, paid recognition run.
 *
 * Returns warnings rather than blocking: an unusual phrasing that still works
 * should not be rejected because it did not use the expected words.
 *
 * @param {string} prompt
 * @returns {string[]} warning keys, empty when the prompt looks usable
 */
export function checkPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return ["empty"];

  const resolved = resolvePrompt(prompt).toLowerCase();
  const warnings = [];

  if (!resolved.includes("json")) warnings.push("noJson");
  if (!resolved.includes("words")) warnings.push("noWordsKey");
  if (!resolved.includes("region") && !resolved.includes("band")) warnings.push("noRegion");

  return warnings;
}
