/**
 * src/utils/sanitizeHtml.test.js
 * Note content is untrusted synced HTML — verify the sanitizer strips active
 * content while preserving everything the editor legitimately produces.
 */

import { describe, expect, it } from "vitest";
import { sanitizeNoteHtml } from "./sanitizeHtml.js";

describe("sanitizeNoteHtml", () => {
  it("strips event-handler attributes (the innerHTML XSS vector)", () => {
    const out = sanitizeNoteHtml('<img src="x" onerror="alert(1)"><p onclick="x()">hi</p>');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).toContain("hi");
  });

  it("strips script tags", () => {
    const out = sanitizeNoteHtml("<p>before</p><script>alert(1)</script><p>after</p>");
    expect(out).not.toContain("<script");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips javascript: URLs", () => {
    const out = sanitizeNoteHtml('<a href="javascript:alert(1)">link</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("link");
  });

  it("preserves editor formatting, classes, and task spans (data-* attributes)", () => {
    const html =
      "<h1>Title</h1><p><strong>bold</strong> <em>italic</em></p>" +
      "<ul><li>item</li></ul>" +
      '<p><span class="task-text" data-task-id="t1">Task 1</span></p>' +
      "<table><tr><td>cell</td></tr></table>";
    const out = sanitizeNoteHtml(html);
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<li>item</li>");
    expect(out).toContain('class="task-text"');
    expect(out).toContain('data-task-id="t1"');
    expect(out).toContain("<td>cell</td>");
  });

  it("returns empty string for falsy input", () => {
    expect(sanitizeNoteHtml(null)).toBe("");
    expect(sanitizeNoteHtml(undefined)).toBe("");
    expect(sanitizeNoteHtml("")).toBe("");
  });
});
