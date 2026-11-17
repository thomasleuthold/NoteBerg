/**
 * src/components/NoteCanvas/mergeHints.test.js
 * Render-time label of the merge conflict hint; stored HTML keeps only attributes.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n/index.js", () => ({
  t: (key, opts) => (opts?.user ? `${key}:${opts.user}` : key),
}));

import { MERGE_HINT_ICON, renderMergeHints, stripMergeHintLabels } from "./mergeHints.js";

function editor(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const HINT = '<span class="merge-hint" data-conflict="c1" data-by="bob"></span>';

describe("renderMergeHints", () => {
  it("renders a warning triangle with the author message on hover/touch and makes the hint non-editable", () => {
    const el = editor(`<p>text${HINT}</p>`);
    renderMergeHints(el);
    const hint = el.querySelector(".merge-hint");
    expect(hint.textContent).toBe(MERGE_HINT_ICON);
    expect(hint.getAttribute("data-hint")).toBe("canvas.mergeHint:bob");
    expect(hint.getAttribute("aria-label")).toBe("canvas.mergeHint:bob");
    expect(hint.getAttribute("contenteditable")).toBe("false");
  });

  it("uses the generic message when the author is unknown", () => {
    const el = editor('<p>x<span class="merge-hint" data-conflict="c1"></span></p>');
    renderMergeHints(el);
    const hint = el.querySelector(".merge-hint");
    expect(hint.textContent).toBe(MERGE_HINT_ICON);
    expect(hint.getAttribute("data-hint")).toBe("canvas.mergeHintUnknown");
  });

  it("toggles the message on touch/pointerdown and closes it when tapping outside", () => {
    const el = editor(`<p>text${HINT}</p>`);
    document.body.appendChild(el);
    renderMergeHints(el);
    const hint = el.querySelector(".merge-hint");

    hint.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(hint.classList.contains("merge-hint--open")).toBe(true);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(hint.classList.contains("merge-hint--open")).toBe(false);
    el.remove();
  });

  it("tolerates a missing root", () => {
    expect(() => renderMergeHints(null)).not.toThrow();
  });
});

describe("stripMergeHintLabels", () => {
  it("empties the icon and tooltip attributes but keeps the attributes that carry the conflict", () => {
    const el = editor(`<p>text${HINT}</p>`);
    renderMergeHints(el);
    const hint = el.querySelector(".merge-hint");
    hint.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    stripMergeHintLabels(el);
    expect(hint.textContent).toBe("");
    expect(hint.getAttribute("data-hint")).toBeNull();
    expect(hint.getAttribute("aria-label")).toBeNull();
    expect(hint.classList.contains("merge-hint--open")).toBe(false);
    expect(hint.getAttribute("data-conflict")).toBe("c1");
    expect(hint.getAttribute("data-by")).toBe("bob");
  });

  it("round-trips: render then strip restores the stored form", () => {
    const stored = `<p>text${HINT}</p>`;
    const el = editor(stored);
    renderMergeHints(el);
    stripMergeHintLabels(el);
    expect(el.querySelector(".merge-hint").outerHTML).toContain('data-conflict="c1"');
    expect(el.textContent).toBe("text");
  });
});
