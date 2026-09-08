/**
 * Covers the recognition prompt.
 *
 * The prompt asks for text plus a colour band. Coordinates were tried first and
 * did not work — models emit a plausible layout rather than a measured one — so
 * the shape the parser depends on is the band, not a box.
 */

import { describe, expect, it } from "vitest";
import {
  breaksHint,
  buildSystemPrompt,
  checkPrompt,
  languageHint,
  punctuationHint,
  resolvePrompt,
  SYSTEM_PROMPT,
  shapeHint,
} from "./prompts.js";

describe("resolvePrompt", () => {
  it("substitutes the band colour list rather than hard-coding it", () => {
    const out = resolvePrompt("bands: {{regionList}}");
    expect(out).toContain("blue");
    expect(out).not.toContain("{{regionList}}");
  });

  it("passes a prompt without placeholders through unchanged", () => {
    const plain = "Just transcribe the words as JSON.";
    expect(resolvePrompt(plain)).toBe(plain);
  });

  it("handles an empty or missing template without throwing", () => {
    expect(resolvePrompt("")).toBe("");
    expect(resolvePrompt(null)).toBe("");
  });
});

describe("buildSystemPrompt", () => {
  it("asks for a region, not a box", () => {
    const out = buildSystemPrompt({});
    expect(out).toContain('"region"');
    expect(out).not.toContain("[x0,y0,x1,y1]");
  });

  it("names the colour bands so the model knows what to look for", () => {
    expect(buildSystemPrompt({})).toContain("colour bands");
  });

  it("uses a custom prompt when one is set", () => {
    const out = buildSystemPrompt({ systemPrompt: "Custom instructions here." });
    expect(out).toContain("Custom instructions here.");
    expect(out).not.toContain("You transcribe handwritten notes");
  });

  it("falls back to the default for a whitespace-only custom prompt", () => {
    // Otherwise clearing the box would send an empty instruction and the model
    // would answer in whatever shape it liked.
    expect(buildSystemPrompt({ systemPrompt: "   " })).toContain(
      "You transcribe handwritten notes",
    );
  });

  it("substitutes the colour list in a custom prompt too", () => {
    const out = buildSystemPrompt({ systemPrompt: "Bands are {{regionList}}." });
    expect(out).toContain("blue");
  });

  it("tells the model text matters more than the band", () => {
    // A model unsure of a colour must include the word anyway; requiring the
    // band measurably cost transcribed words.
    expect(SYSTEM_PROMPT).toContain("matters more than its band");
  });
});

describe("checkPrompt", () => {
  it("accepts the built-in prompt", () => {
    expect(checkPrompt(SYSTEM_PROMPT)).toEqual([]);
  });

  it("asks for the break entries the parser reads when breaks are on", () => {
    // The shape in the prompt and the shape the pipeline stores have to agree:
    // a break is {"break":n} with no text, because every consumer of the words
    // array identifies it by the absence of text.
    //
    // Asserted on the resolved prompt rather than the template: the rules are
    // behind {{breaks}} now, so the template itself no longer names a shape.
    const out = buildSystemPrompt({ breaks: true });
    expect(out).toContain('{"break":1}');
    expect(out).toContain('{"break":2}');
  });

  it("flags an empty prompt", () => {
    expect(checkPrompt("")).toEqual(["empty"]);
    expect(checkPrompt("   ")).toEqual(["empty"]);
  });

  it("flags a prompt that never mentions JSON", () => {
    // The most damaging edit: the model answers in prose, parsing fails, and the
    // note is stored with no recognition at all.
    expect(checkPrompt("Transcribe the words and where they are.")).toContain("noJson");
  });

  it("flags a prompt with no region instruction", () => {
    expect(checkPrompt("Return JSON: words[] each with text.")).toContain("noRegion");
  });

  it("warns when a custom prompt drops the line-break instruction", () => {
    // Not a parse failure like a missing JSON instruction: the text still
    // transcribes, it just comes back as one long line with its layout lost.
    expect(checkPrompt("Return JSON: words[] with text and band. {{language}}")).toContain(
      "noBreak",
    );
  });

  it("accepts an unconventional phrasing that still names what matters", () => {
    // Advisory, not prescriptive: a prompt that works must not be rejected for
    // wording it differently.
    // Not toEqual([]): this phrasing has no {{language}} token, which is its own
    // (non-blocking) warning. What matters here is that the shape rules pass.
    const warnings = checkPrompt("Reply in JSON: words[] with text and colour band.");
    expect(warnings).not.toContain("noJson");
    expect(warnings).not.toContain("noWordsKey");
    expect(warnings).not.toContain("noRegion");
  });
});

describe("language hint", () => {
  it("tells the model to detect the language when none is chosen", () => {
    // Auto-detect is the default, so this is the path most runs take.
    const out = languageHint("auto");
    expect(out.toLowerCase()).toContain("detect");
  });

  it("treats a missing language as auto-detect rather than asserting one", () => {
    expect(languageHint("")).toBe(languageHint("auto"));
    expect(languageHint(undefined)).toBe(languageHint("auto"));
  });

  it("names a chosen language without asserting it as fact", () => {
    // A bare assertion makes models rewrite foreign words into the named
    // language, which is exactly the invention the prompt forbids elsewhere.
    const out = languageHint("de-DE");
    expect(out.toLowerCase()).toContain("do not assume");
  });

  it("names the language in prose rather than as a locale code", () => {
    // "de-DE" reads as a code inside a prompt written in prose, and the region
    // half is noise here. "zh-CN" is the sharpest case: a region code asks the
    // model to infer the script rather than being told which one.
    expect(languageHint("de-DE")).toContain("German");
    expect(languageHint("de-DE")).not.toContain("de-DE");
    expect(languageHint("zh-CN")).toContain("Chinese (Simplified)");
  });

  it("names the language in English whatever the interface language is", () => {
    // The prompt is English throughout, so a German UI must not yield
    // "most likely in Deutsch" inside it. This is why the names are a fixed map
    // here rather than a lookup in the translated i18n catalogue.
    expect(languageHint("fr-FR")).toContain("French");
    expect(languageHint("ja-JP")).toContain("Japanese");
  });

  it("falls back to the tag for a language it has no name for", () => {
    // Still a usable hint, and better than dropping the setting silently.
    expect(languageHint("nl-NL")).toContain("nl-NL");
  });

  it("substitutes the configured language into the default prompt", () => {
    const out = buildSystemPrompt({ language: "fr-FR" });
    expect(out).toContain("French");
    expect(out).not.toContain("{{language}}");
  });

  it("reaches the model for every provider, not just one", () => {
    // Regression guard: the language used to be prepended by the Replicate
    // backend alone, so the OpenAI path silently ignored it and the two
    // providers were not being sent the same instructions.
    expect(buildSystemPrompt({ language: "ja-JP" })).toContain("Japanese");
  });

  it("leaves a custom prompt without the token untouched", () => {
    // The user has taken the prompt over; appending text they cannot see is the
    // mistake the token replaced.
    const out = buildSystemPrompt({ systemPrompt: "Transcribe it.", language: "de-DE" });
    expect(out).toBe("Transcribe it.");
  });

  it("warns when a custom prompt drops the language token", () => {
    expect(checkPrompt("Return JSON words[] with text and band.")).toContain("noLanguage");
  });

  it("does not warn when the token is present", () => {
    expect(checkPrompt("Return JSON words[] with text and band. {{language}}")).not.toContain(
      "noLanguage",
    );
  });
});

describe("punctuationHint", () => {
  it("transcribes the punctuation on the page by default", () => {
    // The option is an opt-out: every run before it existed transcribed
    // punctuation, and the default must not quietly change that.
    const out = punctuationHint(true);
    expect(out).toMatch(/include punctuation you can actually see/i);
  });

  it("asks for words only when punctuation is switched off", () => {
    const out = punctuationHint(false);
    expect(out).toMatch(/words only, without punctuation/i);
  });

  it("keeps the word when dropping a mark attached to it", () => {
    // Told merely to omit punctuation, models drop the whole token often
    // enough to lose words — and losing a word to a comma is a worse result
    // than the comma would have been.
    expect(punctuationHint(false)).toMatch(/never drop\s+the word itself/i);
  });

  it("never invents punctuation in either mode", () => {
    // The choice is transcribe-or-drop, not transcribe-or-compose. Neither
    // mode may write marks the page does not have.
    expect(punctuationHint(true)).toMatch(/never add/i);
    expect(punctuationHint(false)).toMatch(/do not add punctuation/i);
  });
});

describe("punctuation in the built prompt", () => {
  it("leaves no placeholder in the text sent to the model", () => {
    expect(buildSystemPrompt({})).not.toContain("{{punctuation}}");
    expect(buildSystemPrompt({ punctuation: false })).not.toContain("{{punctuation}}");
  });

  it("sends a different instruction for each choice", () => {
    // The whole point of the per-run option: if both produced the same prompt
    // the toggle would be decoration.
    const on = buildSystemPrompt({ punctuation: true });
    const off = buildSystemPrompt({ punctuation: false });
    expect(on).not.toBe(off);
    expect(on).toMatch(/include punctuation/i);
    expect(off).toMatch(/words only/i);
  });

  it("keeps punctuation for a config that does not mention it", () => {
    // getRecognitionConfig() carries no punctuation flag of its own — it only
    // ever arrives as a per-run override — so a stored configuration must
    // still resolve to the long-standing behaviour rather than to words-only.
    expect(buildSystemPrompt({ language: "de-DE" })).toMatch(/include punctuation/i);
  });
});

describe("checkPrompt punctuation warning", () => {
  it("warns when a custom prompt drops the punctuation placeholder", () => {
    // Without the token the dialog still offers the toggle but the choice
    // never reaches the model — an option that appears to work and does not.
    expect(checkPrompt("Return JSON with words, region, break, {{language}}")).toContain(
      "noPunctuation",
    );
  });

  it("stays quiet when the placeholder is present", () => {
    const ok = "Return JSON with words, region, break, {{language}}, {{punctuation}}";
    expect(checkPrompt(ok)).not.toContain("noPunctuation");
  });

  it("does not warn about the default prompt", () => {
    expect(checkPrompt(SYSTEM_PROMPT)).toEqual([]);
  });
});

describe("breaksHint", () => {
  it("asks for the markers when layout is recorded", () => {
    expect(breaksHint(true)).toContain('{"break":1}');
    expect(breaksHint(true)).toContain('{"break":2}');
  });

  it("forbids them outright when layout is off", () => {
    // Silence is not enough: the shape example is the strongest cue, but models
    // volunteer break entries from habit, and one arriving unasked reaches a
    // pipeline no longer expecting it.
    const out = breaksHint(false);
    expect(out).toMatch(/do not report the layout/i);
    expect(out).toMatch(/emit no break entries/i);
  });

  it("warns against the literal word in both modes", () => {
    // The observed failure — the marker written out as text — happens whether
    // or not layout was asked for.
    expect(breaksHint(true)).toMatch(/never emit the word "break" as text/i);
    expect(breaksHint(false)).toMatch(/never emit the word "break" as text/i);
  });
});

describe("shapeHint", () => {
  it("shows a break in the example only when breaks are on", () => {
    // The example and the rules have to agree. An example showing {"break":1}
    // beside a rule forbidding breaks is a contradiction, and a model resolving
    // it either way produces output the parser did not ask for.
    expect(shapeHint(true)).toContain('{"break":1}');
    expect(shapeHint(false)).not.toContain("break");
  });
});

describe("layout in the built prompt", () => {
  it("defaults to not recording the layout", () => {
    // Off by default: models place the markers unreliably, and asking for the
    // layout costs accuracy on the text, which is what the run is for.
    const out = buildSystemPrompt({});
    expect(out).toMatch(/emit no break entries/i);
    expect(out).not.toContain('{"break":1}');
  });

  it("asks for the layout when the run requested it", () => {
    const out = buildSystemPrompt({ breaks: true });
    expect(out).toContain('{"break":1}');
    expect(out).not.toMatch(/emit no break entries/i);
  });

  it("leaves no placeholder in either mode", () => {
    for (const breaks of [true, false]) {
      const out = buildSystemPrompt({ breaks });
      expect(out).not.toContain("{{breaks}}");
      expect(out).not.toContain("{{shape}}");
    }
  });
});

describe("checkPrompt break warning", () => {
  it("warns when a custom prompt drops the breaks placeholder", () => {
    expect(checkPrompt("Return JSON with words, {{language}}, {{punctuation}}")).toContain(
      "noBreak",
    );
  });

  it("stays quiet when the placeholder is present", () => {
    const ok = "Return JSON with words, {{breaks}}, {{language}}, {{punctuation}}";
    expect(checkPrompt(ok)).not.toContain("noBreak");
  });

  it("is not satisfied by the word break appearing in a rule that forbids it", () => {
    // The check moved off the resolved text for exactly this reason: with
    // layout off the resolved prompt says "emit no break entries", which a
    // substring test would read as the layout instruction being present.
    const withoutToken = "Return JSON with words, {{language}}, {{punctuation}}";
    expect(resolvePrompt(withoutToken)).not.toContain("{{breaks}}");
    expect(checkPrompt(withoutToken)).toContain("noBreak");
  });
});

describe("checkPrompt shape warning", () => {
  it("warns when a custom prompt drops the response-shape placeholder", () => {
    // The shape example is the model's strongest cue for the JSON it should
    // produce, and it is what keeps the example from contradicting the break
    // rules. Every other token was already checked; this one was not.
    expect(
      checkPrompt("Return JSON with words and region, {{breaks}}, {{language}}, {{punctuation}}"),
    ).toContain("noShape");
  });

  it("stays quiet when the placeholder is present", () => {
    const ok =
      "Return JSON with words and region: {{shape}} {{breaks}} {{language}} {{punctuation}}";
    expect(checkPrompt(ok)).not.toContain("noShape");
  });
});
