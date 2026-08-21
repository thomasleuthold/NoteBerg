/**
 * Covers attribute escaping for settings values that round-trip through the
 * rendered form.
 *
 * The recognition endpoint and model are user-supplied strings interpolated
 * into `value="..."` attributes. The escapeHtml() helper used elsewhere in the
 * codebase builds on textContent/innerHTML, which does not escape quotes — so
 * these values need their own escaping, and it needs to actually hold.
 */

import { describe, expect, it } from "vitest";
import { escapeAttr } from "./settingsMode.js";

describe("escapeAttr", () => {
  it("escapes double quotes, which would otherwise close the attribute", () => {
    expect(escapeAttr('a"b')).toBe("a&quot;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeAttr("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes ampersands before other entities, so escaping is not double-applied", () => {
    expect(escapeAttr("&quot;")).toBe("&amp;quot;");
  });

  it("neutralizes an attribute-breakout payload", () => {
    // The concrete attack this guards: a stored endpoint that closes the value
    // attribute and injects an event handler.
    const payload = '" onfocus="alert(1)" x="';
    const escaped = escapeAttr(payload);
    expect(escaped).not.toContain('"');

    // Parsed back, the whole payload must remain the attribute's value rather
    // than becoming markup.
    const el = document.createElement("div");
    el.innerHTML = `<input value="${escaped}" />`;
    const input = el.querySelector("input");
    expect(input.getAttribute("value")).toBe(payload);
    expect(input.hasAttribute("onfocus")).toBe(false);
  });

  it("leaves ordinary endpoint and model values unchanged", () => {
    expect(escapeAttr("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    expect(escapeAttr("qwen2.5-vl-7b-instruct")).toBe("qwen2.5-vl-7b-instruct");
  });

  it("renders null and undefined as an empty string rather than the literal words", () => {
    expect(escapeAttr(null)).toBe("");
    expect(escapeAttr(undefined)).toBe("");
  });
});
