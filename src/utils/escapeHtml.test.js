/**
 * src/utils/escapeHtml.test.js
 * One escaping helper for every place text is interpolated into markup: element
 * text, a <textarea>, and quoted attribute values. Values from other users (a
 * shared notebook's title, a display name) reach all three.
 */

import { describe, expect, it } from "vitest";
import { escapeHtml } from "./escapeHtml.js";

describe("escapeHtml", () => {
  it("escapes double and single quotes, which would otherwise close an attribute", () => {
    expect(escapeHtml(`a"b'c`)).toBe("a&quot;b&#39;c");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes ampersands before other entities, so escaping is not double-applied", () => {
    expect(escapeHtml("&quot;")).toBe("&amp;quot;");
  });

  it("neutralizes an attribute-breakout payload", () => {
    const payload = `" onfocus="alert(1)" x='`;
    const el = document.createElement("div");
    el.innerHTML = `<input value="${escapeHtml(payload)}" /><input value='${escapeHtml(payload)}' />`;
    for (const input of el.querySelectorAll("input")) {
      expect(input.getAttribute("value")).toBe(payload);
      expect(input.hasAttribute("onfocus")).toBe(false);
    }
  });

  it("keeps a textarea closed and shows the original text inside it", () => {
    const payload = `</textarea><img src=x>"quoted"`;
    const el = document.createElement("div");
    el.innerHTML = `<textarea>${escapeHtml(payload)}</textarea>`;
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("textarea").value).toBe(payload);
  });

  it("keeps element text as text", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p>${escapeHtml("<b>Alice</b> & Bob")}</p>`;
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toBe("<b>Alice</b> & Bob");
  });

  it("leaves ordinary values unchanged", () => {
    expect(escapeHtml("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    expect(escapeHtml("qwen2.5-vl-7b-instruct")).toBe("qwen2.5-vl-7b-instruct");
  });

  it("renders null and undefined as an empty string rather than the literal words", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});
