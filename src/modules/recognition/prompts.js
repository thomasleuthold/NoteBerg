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
 * Placeholder replaced with the configured language hint.
 *
 * A token rather than a prefix bolted on by the backend: before this existed,
 * the Replicate path prepended the language to the prompt and the OpenAI path
 * ignored it entirely, so the two providers were not sent the same instructions
 * and a prompt comparison between them was not measuring the same thing. A
 * token also puts the hint where the user editing the prompt can see and move
 * it, instead of somewhere invisible above it.
 */
const LANGUAGE_TOKEN = "{{language}}";

/** The `language` value meaning "no hint"; mirrors LANGUAGE_AUTO. */
const LANGUAGE_AUTO = "auto";

/**
 * Placeholder replaced with the punctuation instruction.
 *
 * A per-run choice rather than a setting: whether punctuation belongs in the
 * result depends on the page, not on a preference. Prose wants the full stops
 * and commas that were written; a list of keywords, a set of labels or a page of
 * figures reads better as bare words, and the stray marks a model finds in
 * handwriting are noise there. Made a token for the same reason as the language
 * hint: a user who has taken the prompt over can see where the instruction lands
 * and move it.
 *
 * Neither mode lets the model invent punctuation. The choice is whether marks
 * that are actually on the page are transcribed or dropped — adding punctuation
 * the writer did not write would be the invention the rest of the prompt spends
 * most of its rules forbidding.
 */
const PUNCTUATION_TOKEN = "{{punctuation}}";

/**
 * Placeholder replaced with the line-break instruction.
 *
 * Per-run for the same reason as punctuation, and off by default for a
 * different one: models place break markers unreliably. They miss line endings,
 * emit the marker as the word "break", and disagree about what counts as a
 * paragraph — so asking for layout costs accuracy on the text itself, which is
 * what the transcription is for. A user who wants the shape of the page can
 * switch it on for the notes where it matters.
 */
const BREAKS_TOKEN = "{{breaks}}";

/**
 * The response shape, which changes with the break setting.
 *
 * Kept beside the token because the example and the rules have to agree: an
 * example showing {"break":1} while the rules forbid breaks is a contradiction,
 * and a model resolving it either way produces output the parser did not ask
 * for.
 */
const SHAPE_TOKEN = "{{shape}}";

/**
 * English names for the languages the settings screen offers.
 *
 * Deliberately not the i18n catalogue: those names are translated to whatever
 * the *interface* is set to, and the prompt is written in English throughout —
 * a German UI must not produce "The handwriting is most likely in Deutsch"
 * inside an otherwise English instruction.
 *
 * Naming the language also beats interpolating the raw tag. "de-DE" reads as a
 * code in a prompt made of prose, and the region half is noise for this purpose;
 * "zh-CN" in particular asks the model to infer a script from a region code
 * rather than simply being told "Chinese (Simplified)".
 *
 * An unlisted tag falls back to the tag itself, which is still a usable hint.
 */
const LANGUAGE_NAMES = {
  "en-US": "English",
  "de-DE": "German",
  "fr-FR": "French",
  "es-ES": "Spanish",
  "it-IT": "Italian",
  "ja-JP": "Japanese",
  "zh-CN": "Chinese (Simplified)",
};

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

${LANGUAGE_TOKEN}

Return ONLY a JSON object of this exact shape, with no prose and no code fence:
${SHAPE_TOKEN}

Rules:
- Transcribe ONLY words you can actually see in the image. Never infer, complete,
  or invent text. If you are unsure what a word says, omit it.
- Do not use the conversation or any prior context to guess the content. The image
  is the only source.
- One entry per word, in natural reading order.
${BREAKS_TOKEN}
- "region" is the colour of the band the word sits on. Report the colour you can
  actually see behind the word — do not calculate it from a position.
- If a word straddles two bands, use the band containing most of it.
- Transcribing the word matters more than its band. If you cannot tell which band
  a word is on, still include the word and omit its "region" — never drop a word
  because you are unsure of its colour.
- Transcribe exactly what is written. Do not correct spelling.
- ${PUNCTUATION_TOKEN}
- Never translate. Transcribe each word in the language it is written in, even
  where that is not the language named above.
- If the image is blank, unreadable, or contains no handwriting, return exactly
  {"words":[]}. An empty result is correct and expected in that case — it is far
  better than inventing text.`;

/**
 * Render the language hint for a configured language.
 *
 * Auto-detect is a real instruction rather than an empty string: a model given
 * no guidance at all tends to assume the interface language, whereas being told
 * to detect it makes the choice explicit. The hedge on the named-language form
 * is deliberate — a bare assertion ("the handwriting is in English") makes
 * models rewrite foreign words into that language, which is the invention the
 * rest of the prompt forbids.
 *
 * @param {string} language - BCP-47 tag, or LANGUAGE_AUTO. Named in English via
 *   LANGUAGE_NAMES; an unlisted tag is used verbatim.
 * @returns {string}
 */
export function languageHint(language) {
  if (!language || language === LANGUAGE_AUTO) {
    return "The handwriting may be in any language. Detect it from the writing itself.";
  }
  const name = LANGUAGE_NAMES[language] || language;
  return `The handwriting is most likely in ${name}, but do not assume it: transcribe what is actually written.`;
}

/**
 * Render the punctuation instruction for a run.
 *
 * Both modes forbid invented punctuation; they differ only in what happens to
 * marks that really are on the page — transcribed, or dropped so the result is
 * bare words.
 *
 * The words-only mode has to say what to do with a mark attached to a word
 * ("word," → "word") rather than only "omit punctuation": told merely to leave
 * punctuation out, models drop the whole token often enough to lose words, and
 * losing a word to a comma is a worse result than the comma.
 *
 * @param {boolean} punctuation - transcribe punctuation that is written
 * @returns {string}
 */
export function punctuationHint(punctuation) {
  if (punctuation) {
    return (
      "Include punctuation you can actually see — full stops, commas, question " +
      "marks, dashes — as part of the word it is attached to. Never add " +
      "punctuation that is not written on the page."
    );
  }
  return (
    "Transcribe the words only, without punctuation. Where a word carries a " +
    "punctuation mark, transcribe the word and leave the mark out — never drop " +
    "the word itself. Do not add punctuation either."
  );
}

/**
 * Render the response-shape example for a run.
 *
 * @param {boolean} breaks - whether break entries are asked for
 * @returns {string}
 */
export function shapeHint(breaks) {
  return breaks
    ? '{"words":[{"text":"word","region":"green"},{"break":1}]}'
    : '{"words":[{"text":"word","region":"green"}]}';
}

/**
 * Render the line-break instruction for a run.
 *
 * With breaks off the prompt does not merely omit the rule — it forbids the
 * marker outright. Silence is not enough: the shape example is the model's
 * strongest cue, but models still volunteer break entries from habit, and one
 * arriving unasked would reach a pipeline that is no longer expecting it.
 *
 * The "break" word is called out in both modes, for opposite reasons. Asked for
 * layout, models write the marker as text ({"text":"break"}); told to leave
 * layout out, they write it as text just as readily. mapWordToContent repairs
 * that either way, but the prompt is the cheaper place to prevent it.
 *
 * @param {boolean} breaks
 * @returns {string}
 */
export function breaksHint(breaks) {
  if (breaks) {
    return `- Mark where lines end so the layout is preserved. Between the last word of a
  line and the first word of the next, emit {"break":1}. Where a blank line
  separates two paragraphs, emit {"break":2} instead.
- A break entry has no "text" and no "region" — it records the layout between
  words, not a word. Never emit the word "break" as text: {"text":"break"} is
  wrong, {"break":1} is correct. Only write "break" as text if that word is
  literally handwritten on the page.`;
  }
  return `- Do not report the layout. Emit no break entries and no line or paragraph
  markers of any kind — just the words, in reading order.
- Never emit the word "break" as text. Only write "break" if that word is
  literally handwritten on the page.`;
}

/**
 * Substitute placeholders in a prompt.
 *
 * The band-colour list, so a prompt never hard-codes colours that regions.js
 * might change, the language hint, and the punctuation and line-break
 * instructions.
 *
 * A custom prompt without {{language}} gets no hint appended. That is the
 * intended behaviour: the user has taken the prompt over, and silently adding
 * text they cannot see is the mistake this token replaced. checkPrompt() warns
 * about the omission instead.
 *
 * @param {string} template
 * @param {Object} [config] - recognition config, for the language hint
 * @returns {string}
 */
export function resolvePrompt(template, config = {}) {
  return String(template ?? "")
    .replace(REGION_LIST_TOKEN, describeRegions())
    .replace(LANGUAGE_TOKEN, languageHint(config.language))
    .replace(PUNCTUATION_TOKEN, punctuationHint(config.punctuation ?? true))
    .replace(SHAPE_TOKEN, shapeHint(config.breaks ?? false))
    .replace(BREAKS_TOKEN, breaksHint(config.breaks ?? false));
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

  return resolvePrompt(template, config);
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
  const hasLanguageToken = String(prompt).includes(LANGUAGE_TOKEN);
  const hasPunctuationToken = String(prompt).includes(PUNCTUATION_TOKEN);
  const hasBreaksToken = String(prompt).includes(BREAKS_TOKEN);
  const hasShapeToken = String(prompt).includes(SHAPE_TOKEN);
  const warnings = [];

  // The response-shape example. Unlike the other tokens this one is a parse
  // concern: it is the model's strongest cue for the JSON it should produce, and
  // it is what keeps the example and the break rules from contradicting each
  // other — a prompt showing {"break":1} while the rules forbid the marker
  // returns entries the pipeline did not ask for.
  //
  // A prompt that spells out its own example instead is fine, which is why this
  // warns rather than blocks, like everything else here.
  if (!hasShapeToken) warnings.push("noShape");

  if (!resolved.includes("json")) warnings.push("noJson");
  if (!resolved.includes("words")) warnings.push("noWordsKey");
  if (!resolved.includes("region") && !resolved.includes("band")) warnings.push("noRegion");
  // Like the language token, not a parse failure: without it the text still
  // transcribes, it just comes back as one long line with its layout lost.
  //
  // Checked on the token rather than the resolved text: with breaks switched
  // off the resolved prompt contains the word "break" in a rule forbidding the
  // marker, which would satisfy a substring test while meaning the opposite.
  if (!hasBreaksToken) warnings.push("noBreak");
  // Not a parse failure like the others — the prompt still works, the language
  // setting just stops reaching the model. Worth saying, not worth blocking.
  if (!hasLanguageToken) warnings.push("noLanguage");
  // Same class of problem: the prompt still runs, but the punctuation choice in
  // the recognition dialog silently stops reaching the model — an option that
  // appears to do something and does nothing is worse than one that is absent.
  if (!hasPunctuationToken) warnings.push("noPunctuation");

  return warnings;
}
