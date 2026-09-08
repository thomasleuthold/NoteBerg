/**
 * NoteBerg loading indicator — the app mark as a waiting animation.
 *
 * The sun rises from behind the ground line, arcs over the massif and sets
 * behind it again. The occlusion is the whole point: the sun is painted first
 * and the artwork over it, so the horizon and the peaks genuinely hide it
 * rather than it fading in and out.
 *
 * The artwork is imported as raw SVG markup so the geometry stays in
 * `img/app-dark-s.svg` — the single source of truth for the mark — instead of
 * being duplicated as a string in here. All colour comes from CSS classes
 * (see `nbLoader.css`), so the mark follows `currentColor` and inverts in dark
 * mode; the source file's own inline fills are stripped at import time.
 */

import markup from "../../img/app-dark-s.svg?raw";

/** Ellipse the sun travels, tuned so a radius-13 disc crosses the horizon and
 *  clears the summit without leaving the (widened) viewBox. */
const SUN_ARC = "M 3.65 75.00 A 30 55 0 1 1 60.35 75.00";
const SUN_RADIUS = 13;

/** The artwork is a 64×64 mark; the viewBox is widened so the sun has room to
 *  rise and set outside it. Everything scales together. */
const VIEW_BOX = { x: -12, y: -12, w: 88, h: 76 };
/** Clip height: below this the sun is hidden, so the ground line occludes it. */
const CLIP_H = 74;

let cachedPaths = null;
let instanceSeq = 0;

/**
 * Pull the `<path>` geometry out of the source SVG, tagging each as ink or
 * paper so CSS can colour it. Inkscape writes `fill:#ffffff` on the paper
 * faces and `fill:#000000` on the ink; that is the only distinction we need.
 */
function extractPaths() {
  if (cachedPaths) return cachedPaths;

  const paths = [];

  for (const match of markup.matchAll(/<path\b([\s\S]*?)\/>/g)) {
    const attrs = match[1];
    const d = (attrs.match(/\sd="([^"]+)"/) || [])[1];
    if (!d) continue;

    const style = (attrs.match(/style="([^"]*)"/) || [])[1] || "";
    const fill = (style.match(/(?:^|;)\s*fill:\s*([^;]+)/) || [])[1] || "";
    const role = fill.trim().toLowerCase() === "#ffffff" ? "paper" : "ink";

    paths.push({ role, d });
  }

  cachedPaths = paths;
  return paths;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the loader's SVG markup.
 *
 * Paint order matters and is the mechanism of the effect:
 *   1. the sun, clipped at the ground line so the horizon cuts it;
 *   2. the artwork, which therefore occludes the sun behind the peaks.
 *
 * @param {string} clipId Unique per instance — SVG ids are document-global, so
 *   a shared id would break once the first instance is removed from the DOM.
 */
function buildSvg(clipId) {
  const { x, y, w, h } = VIEW_BOX;
  const art = extractPaths()
    .map((p) => `<path class="nb-loader__${p.role}" d="${escapeAttr(p.d)}"/>`)
    .join("");

  return (
    `<svg class="nb-loader__svg" viewBox="${x} ${y} ${w} ${h}" aria-hidden="true" focusable="false">` +
    `<defs><clipPath id="${clipId}">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${CLIP_H}"/>` +
    `</clipPath></defs>` +
    `<g clip-path="url(#${clipId})">` +
    `<circle class="nb-loader__sun" cx="0" cy="0" r="${SUN_RADIUS}" ` +
    `style="offset-path:path(&quot;${SUN_ARC}&quot;)"/>` +
    `</g>` +
    art +
    `</svg>`
  );
}

/**
 * Create a loading indicator element.
 *
 * @param {object}  [options]
 * @param {string}  [options.label]  Visible text beside the mark. Omit for the
 *   mark alone.
 * @param {string}  [options.size]   Any CSS length, e.g. "40px". Defaults to
 *   the stylesheet's own size.
 * @param {boolean} [options.block]  Lay out as a centred block (a whole empty
 *   panel) rather than an inline row.
 * @returns {HTMLElement}
 */
export function createLoadingIndicator({ label, size, block = false } = {}) {
  const root = document.createElement("div");
  root.className = `nb-loader${block ? " nb-loader--block" : ""}`;

  // A progressbar with no value is the ARIA idiom for indeterminate progress.
  root.setAttribute("role", "progressbar");
  if (label) root.setAttribute("aria-label", label);
  if (size) root.style.setProperty("--nb-loader-size", size);

  root.innerHTML = buildSvg(`nb-loader-clip-${++instanceSeq}`);

  if (label) {
    const text = document.createElement("span");
    text.className = "nb-loader__label";
    text.textContent = label;
    root.appendChild(text);
  }

  return root;
}

/**
 * Replace a container's contents with a loading indicator.
 * Convenience for the common `innerHTML = "<div>Loading…</div>"` case.
 *
 * @returns {HTMLElement} the indicator, for callers that want to adjust it.
 */
export function showLoadingIndicator(container, options) {
  const indicator = createLoadingIndicator(options);
  container.replaceChildren(indicator);
  return indicator;
}
