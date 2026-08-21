/**
 * Covers the recognition prompt.
 *
 * The prompt asks for text plus a colour band. Coordinates were tried first and
 * did not work — models emit a plausible layout rather than a measured one — so
 * the shape the parser depends on is the band, not a box.
 */

import { describe, expect, it } from "vitest";
import { buildSystemPrompt, checkPrompt, resolvePrompt, SYSTEM_PROMPT } from "./prompts.js";

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

  it("accepts an unconventional phrasing that still names what matters", () => {
    // Advisory, not prescriptive: a prompt that works must not be rejected for
    // wording it differently.
    expect(checkPrompt("Reply in JSON: words[] with text and colour band.")).toEqual([]);
  });
});
