import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getMarkerPalette, getThemePalette } from "../../utils/noteRenderer.js";
import jQuery from "./jquerySetup.js";
import "trumbowyg";
import "./textColorPlugin.js";
import { applyFormatting, colorTagHandler } from "./textColorPlugin.js";

describe("textColorPlugin", () => {
  it("registers color plugin with foreColor and backColor button definitions", () => {
    const mockTrumbowyg = {
      btnsDef: {},
      addBtnDef(name, def) {
        this.btnsDef[name] = def;
      },
      o: { prefix: "trumbowyg-" },
    };

    jQuery.trumbowyg.plugins.color.init(mockTrumbowyg);

    expect(mockTrumbowyg.btnsDef.foreColor).toBeDefined();
    expect(mockTrumbowyg.btnsDef.foreColor.dropdown).toHaveLength(15);
    expect(mockTrumbowyg.btnsDef.foreColor.dropdown[0]).toBe("foreColor_clear");
    expect(mockTrumbowyg.btnsDef.foreColor.dropdown[1]).toBe("foreColor_1");
    expect(mockTrumbowyg.btnsDef.foreColor.dropdown[14]).toBe("foreColor_14");

    expect(mockTrumbowyg.btnsDef.backColor).toBeDefined();
    expect(mockTrumbowyg.btnsDef.backColor.dropdown).toHaveLength(11);
    expect(mockTrumbowyg.btnsDef.backColor.dropdown[0]).toBe("backColor_clear");
    expect(mockTrumbowyg.btnsDef.backColor.dropdown[1]).toBe("backColor_0");
    expect(mockTrumbowyg.btnsDef.backColor.dropdown[10]).toBe("backColor_9");
  });

  describe("colorTagHandler", () => {
    it("detects text color and highlight variables", () => {
      const el = document.createElement("span");
      el.style.color = "var(--nb-pen-color-5)";
      el.style.backgroundColor = "var(--nb-marker-color-4)";
      expect(colorTagHandler(el)).toEqual(["foreColor_5", "backColor_4"]);
    });

    it("returns empty array for elements without color formatting", () => {
      expect(colorTagHandler(document.createElement("p"))).toEqual([]);
      expect(colorTagHandler(null)).toEqual([]);
    });
  });

  describe("applyFormatting", () => {
    const setup = (html, makeRange, doc = document) => {
      const editor = document.createElement("div");
      editor.innerHTML = html;
      const range = document.createRange();
      makeRange(range, editor);
      const trumbowyg = {
        $ed: jQuery(editor),
        $c: jQuery(document.createElement("div")),
        $btnPane: jQuery(document.createElement("div")),
        range,
        doc,
        o: { prefix: "trumbowyg-" },
        saveRange: vi.fn(),
        restoreRange: vi.fn(),
        syncCode: vi.fn(),
        checkState: vi.fn(),
      };
      return { editor, trumbowyg };
    };
    const caretIn = (selector, offset) => (range, editor) => {
      range.setStart(editor.querySelector(selector).firstChild, offset);
      range.collapse(true);
    };

    it("recolors and clears the span holding a collapsed caret", () => {
      const { editor, trumbowyg } = setup(
        '<p><span style="color: var(--nb-pen-color-1);">Hello</span></p>',
        caretIn("span", 2),
      );
      const span = editor.querySelector("span");

      applyFormatting(trumbowyg, "foreColor", 3);
      expect(span.style.color).toBe("var(--nb-pen-color-3)");

      applyFormatting(trumbowyg, "foreColor", null);
      expect(editor.querySelector("span")).toBeNull();
      expect(editor.textContent).toBe("Hello");
    });

    it("keeps a span's other formatting when clearing one property", () => {
      const { editor, trumbowyg } = setup(
        '<p><span style="color: var(--nb-pen-color-1); background-color: var(--nb-marker-color-0);">Hi</span></p>',
        caretIn("span", 1),
      );

      applyFormatting(trumbowyg, "backColor", null);
      const span = editor.querySelector("span");
      expect(span.style.backgroundColor).toBe("");
      expect(span.style.color).toBe("var(--nb-pen-color-1)");
    });

    it("does not run execCommand for a caret with no word, so no placeholder color leaks", () => {
      const doc = { execCommand: vi.fn(() => true) };
      const { trumbowyg } = setup("<p> </p>", caretIn("p", 0), doc);

      applyFormatting(trumbowyg, "foreColor", 2);
      applyFormatting(trumbowyg, "backColor", null);
      expect(doc.execCommand).not.toHaveBeenCalled();
      expect(trumbowyg.syncCode).toHaveBeenCalledTimes(2);
    });

    it("rewrites execCommand's placeholder span to the theme variable", () => {
      const doc = {
        execCommand: vi.fn((cmd, _ui, val) => {
          if (cmd === "styleWithCSS") return true;
          doc.editor.innerHTML = `<p><span style="background-color: ${val};">already</span></p>`;
          return true;
        }),
      };
      const { editor, trumbowyg } = setup(
        "<p>already</p>",
        (range, ed) => {
          range.selectNodeContents(ed.firstChild);
        },
        doc,
      );
      doc.editor = editor;

      applyFormatting(trumbowyg, "backColor", 0);
      expect(doc.execCommand).toHaveBeenCalledWith("hiliteColor", false, "#010204");
      expect(editor.querySelector("span").style.backgroundColor).toBe("var(--nb-marker-color-0)");
    });

    it("wraps the selection itself when execCommand is unavailable", () => {
      const { editor, trumbowyg } = setup("<p>text</p>", (range, ed) => {
        range.selectNodeContents(ed.firstChild);
      });

      applyFormatting(trumbowyg, "foreColor", 2);
      expect(editor.querySelector("span").style.color).toBe("var(--nb-pen-color-2)");
    });
  });

  describe("theme palettes", () => {
    const hex = (c) => c.replace("#", "").toLowerCase();
    const cssVars = (theme) => {
      const css = readFileSync(`src/styles/themes/${theme}.css`, "utf8");
      return Object.fromEntries(
        [...css.matchAll(/(--nb-(?:pen|marker)-color-\d+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
      );
    };
    const toHex = (rgba) => {
      const [r, g, b] = rgba.match(/\d+/g).map(Number);
      return [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
    };

    it.each(["light", "dark"])("%s theme CSS variables match the canvas palettes", (theme) => {
      const vars = cssVars(theme);
      getThemePalette(theme).forEach((color, i) => {
        if (i > 0) expect(hex(vars[`--nb-pen-color-${i}`])).toBe(hex(color));
      });
      getMarkerPalette(theme).forEach((color, i) => {
        expect(toHex(vars[`--nb-marker-color-${i}`])).toBe(hex(color));
      });
    });
  });
});
