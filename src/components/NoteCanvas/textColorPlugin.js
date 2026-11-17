/**
 * Trumbowyg Theme-Adaptive Color & Highlight Plugin
 *
 * Replaces Trumbowyg's default 66-color grid with a curated, theme-adaptive palette:
 * - Text colors: "Default" (theme-inheriting) + 14 pen colors (--nb-pen-color-1..14)
 * - Text highlights: "No highlight" + 10 marker colors (--nb-marker-color-0..9)
 *
 * Spans carry `color: var(--nb-pen-color-N)` / `background-color: var(--nb-marker-color-N)`,
 * so they follow the active theme (the variables live in styles/themes/*.css).
 */

import { t } from "../../i18n/index.js";
import jQuery from "./jquerySetup.js";

// execCommand can only apply literal colors; these placeholders mark the
// elements it created so they can be rewritten to the theme variable.
const FORMATS = {
  foreColor: {
    cmd: "foreColor",
    prop: "color",
    varName: "--nb-pen-color-",
    temp: ["#010203", "rgb(1, 2, 3)"],
  },
  backColor: {
    cmd: "hiliteColor",
    prop: "backgroundColor",
    varName: "--nb-marker-color-",
    temp: ["#010204", "rgb(1, 2, 4)"],
  },
};

const PEN_COLORS = 14;
const MARKER_COLORS = 10;

function closeDropdowns(trumbowyg) {
  const prefix = trumbowyg.o.prefix;
  // The button pane and its dropdowns share a parent, wherever TextLayer mounts them
  trumbowyg.$btnPane.parent().find(`.${prefix}dropdown`).hide();
  trumbowyg.$btnPane.find(`.${prefix}active`).removeClass(`${prefix}active`);
}

function expandRangeToWord(range) {
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const text = node.data;
  let start = range.startOffset;
  let end = range.endOffset;

  if (
    (start > 0 && /\S/.test(text[start - 1])) ||
    (start < text.length && /\S/.test(text[start]))
  ) {
    while (start > 0 && /\S/.test(text[start - 1])) start--;
    while (end < text.length && /\S/.test(text[end])) end++;
    range.setStart(node, start);
    range.setEnd(node, end);
  }
}

/** Sets (or, for a null value, clears) the span's color; drops spans left bare. */
function setSpanFormat(span, prop, value) {
  span.style[prop] = value ?? "";
  if (!span.getAttribute("style")) span.removeAttribute("style");
  if (!span.attributes.length) jQuery(span).contents().unwrap();
}

/**
 * Applies pen color / marker `colorIndex` (null clears it) to the selection.
 * A collapsed caret formats the word under it, or the whole span it sits in.
 */
export function applyFormatting(trumbowyg, type, colorIndex) {
  trumbowyg.$ed.focus();
  trumbowyg.saveRange();
  const range = trumbowyg.range;
  if (!range) {
    closeDropdowns(trumbowyg);
    return;
  }

  const { cmd, prop, varName, temp } = FORMATS[type];
  const value = colorIndex === null ? null : `var(${varName}${colorIndex})`;

  const finish = () => {
    trumbowyg.restoreRange();
    trumbowyg.syncCode();
    trumbowyg.checkState();
    trumbowyg.$c.trigger("tbwchange");
    closeDropdowns(trumbowyg);
  };

  if (range.collapsed) {
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const span = el?.closest("span");
    if (span && trumbowyg.$ed[0].contains(span) && span.style[prop]) {
      setSpanFormat(span, prop, value);
      return finish();
    }
    expandRangeToWord(range);
    // No word to format: execCommand would only set a pending style that
    // leaks its placeholder color into whatever is typed next.
    if (range.collapsed) return finish();
  }

  let execOk = false;
  try {
    trumbowyg.doc.execCommand("styleWithCSS", false, true);
    execOk = trumbowyg.doc.execCommand(cmd, false, temp[0]);
  } catch (_) {}

  if (execOk) {
    trumbowyg.$ed.find("span").each(function () {
      if (temp.includes(this.style[prop])) setSpanFormat(this, prop, value);
    });
  } else if (value) {
    // execCommand unsupported (e.g. jsdom)
    try {
      const span = trumbowyg.doc.createElement("span");
      span.style[prop] = value;
      span.appendChild(range.extractContents());
      range.insertNode(span);
      range.selectNode(span);
    } catch (_) {}
  }

  finish();
}

export function colorTagHandler(element) {
  const tags = [];
  const color = element?.style?.color?.match(/--nb-pen-color-(\d+)/);
  if (color) tags.push(`foreColor_${color[1]}`);
  const highlight = element?.style?.backgroundColor?.match(/--nb-marker-color-(\d+)/);
  if (highlight) tags.push(`backColor_${highlight[1]}`);
  return tags;
}

function swatch(modifier, colorVar) {
  const style = colorVar ? ` style="background-color: var(${colorVar});"` : "";
  return `<span class="note-color-swatch${modifier}"${style}></span>`;
}

/** Registers the dropdown's buttons and returns their names. */
function buildDropdown(trumbowyg, type, { clearTitle, clearSwatch, first, count, title }) {
  const clear = `${type}_clear`;
  trumbowyg.addBtnDef(clear, {
    fn: () => applyFormatting(trumbowyg, type, null),
    hasIcon: false,
    title: clearTitle,
    text: `${clearSwatch}<span>${clearTitle}</span>`,
    class: "note-color-btn note-color-btn--header",
  });

  const names = [clear];
  for (let i = first; i < first + count; i++) {
    const name = `${type}_${i}`;
    trumbowyg.addBtnDef(name, {
      fn: () => applyFormatting(trumbowyg, type, i),
      hasIcon: false,
      title: title(i),
      text: swatch("", `${FORMATS[type].varName}${i}`),
      class: "note-color-btn",
    });
    names.push(name);
  }
  return names;
}

jQuery.trumbowyg = jQuery.trumbowyg || { plugins: {}, langs: {} };
jQuery.extend(true, jQuery.trumbowyg, {
  plugins: {
    color: {
      init: (trumbowyg) => {
        trumbowyg.addBtnDef("foreColor", {
          title: t("toolbar.color.foreColor"),
          ico: "fore-color",
          dropdown: buildDropdown(trumbowyg, "foreColor", {
            clearTitle: t("toolbar.color.defaultText"),
            clearSwatch: swatch(" note-color-swatch--auto"),
            first: 1,
            count: PEN_COLORS,
            title: (i) => t("toolbar.penDialog.colorTitle", { num: i + 1 }),
          }),
        });

        trumbowyg.addBtnDef("backColor", {
          title: t("toolbar.color.backColor"),
          ico: "back-color",
          dropdown: buildDropdown(trumbowyg, "backColor", {
            clearTitle: t("toolbar.color.removeHighlight"),
            clearSwatch: swatch(" note-color-swatch--none"),
            first: 0,
            count: MARKER_COLORS,
            title: (i) => t("toolbar.color.highlightTitle", { num: i + 1 }),
          }),
        });
      },
      tagHandler: colorTagHandler,
    },
  },
});
