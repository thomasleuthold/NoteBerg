/**
 * Text boxes inside a note's HTML (documentation/text_boxes_design.md §3).
 *
 * A box is a top-level wrapper in `note.content`:
 *
 *   <div class="text-box" data-box-id="tb_…" data-x="640" data-y="312" data-w="400">…</div>
 *
 * Every top-level node before the first box is the implicit main box: today's
 * unwrapped text, with no attributes. A note without boxes is therefore stored
 * exactly as before, and every function here returns such a note unchanged,
 * byte for byte.
 *
 * Pure: no editor, no storage. Needs an HTML parser (htmlParser.js) only for
 * content that holds boxes.
 */

import { parseHtmlBody } from "./htmlParser.js";

export const TEXT_BOX_CLASS = "text-box";

/** Width of the content space boxes are placed in (the 1200 px strokes use). */
export const PAGE_WIDTH = 1200;
/** Width of a new box, and the narrowest one a tap near the right edge creates. */
export const DEFAULT_BOX_WIDTH = 400;
export const MIN_CREATE_WIDTH = 200;
/** Narrowest a box can be resized to. */
export const MIN_BOX_WIDTH = 80;

/** Padding of a box's text (content px); keep in step with TextLayer.css. */
export const BOX_PADDING = { top: 4, right: 8, bottom: 4, left: 8 };
/**
 * Where the implicit main box's text sits, as the single editor had it: its
 * padding was 15px 20px 20px 46px, below the 1 px Trumbowyg's hidden textarea
 * took above it, so the text started 16 px down.
 */
export const MAIN_PADDING = { top: 16, right: 20, bottom: 20, left: 46 };

/**
 * Geometry that keeps the implicit main box's text where it is once wrapped
 * (DESIGN §3.1): same text origin, same text column width.
 */
export const MAIN_BOX_GEOMETRY = Object.freeze({
  x: MAIN_PADDING.left - BOX_PADDING.left,
  y: MAIN_PADDING.top - BOX_PADDING.top,
  w: PAGE_WIDTH - MAIN_PADDING.left - MAIN_PADDING.right + BOX_PADDING.left + BOX_PADDING.right,
});

const BOX_MARKER = /class\s*=\s*["'][^"']*\btext-box\b/i;

/** Whether the HTML may hold a box (cheap; no parsing). */
export function mayHaveBoxes(html) {
  return typeof html === "string" && BOX_MARKER.test(html);
}

/** A new random box id, like stroke ids. */
export function newBoxId() {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += (b % 36).toString(36);
  return `tb_${id}`;
}

function isBoxElement(node) {
  return node?.nodeType === 1 && node.classList?.contains(TEXT_BOX_CLASS);
}

function escapeText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function nodeHtml(node) {
  if (node.nodeType === 3) return escapeText(node.textContent);
  if (node.nodeType === 1) return node.outerHTML;
  return "";
}

function isBlankText(node) {
  return node.nodeType === 3 && node.textContent.trim() === "";
}

function readInt(element, name) {
  const raw = element.getAttribute(name);
  if (raw === null || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return null;
  return Math.round(Number(raw));
}

/** A box's geometry from its attributes, or null when it is missing or makes no sense. */
function readGeometry(element) {
  const x = readInt(element, "data-x");
  const y = readInt(element, "data-y");
  const w = readInt(element, "data-w");
  if (x === null || y === null || w === null) return null;
  if (x < 0 || y < 0 || w < MIN_BOX_WIDTH || x + w > PAGE_WIDTH) return null;
  return { x, y, w };
}

/** Replace an element with its children. */
function unwrap(element) {
  const parent = element.parentNode;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/** Boxes below the top level (nested, or inside another element): their content stays, the wrapper goes. */
function unwrapInnerBoxes(body) {
  for (const element of [...body.querySelectorAll(`.${TEXT_BOX_CLASS}`)]) {
    if (element.parentNode !== body) unwrap(element);
  }
}

/**
 * @typedef {object} TextBoxModel
 * @property {string} id
 * @property {number} x - content px, left edge of the box
 * @property {number|null} y - content px, top edge; null while it needs a place (invalid geometry)
 * @property {number} w - content px, width
 * @property {string} html - the box's inner HTML
 */

/**
 * @typedef {object} ParsedContent
 * @property {string} main - the implicit main box's HTML
 * @property {TextBoxModel[]} boxes - in DOM (creation) order
 */

/**
 * Split note HTML into the implicit main box and the boxes, normalized
 * (DESIGN §3.1): boxes below the top level are unwrapped, unwrapped nodes after
 * a box join that box, duplicate or missing ids get a new id, and a box whose
 * geometry is missing or invalid keeps its text and gets `y: null` (placed
 * below the lowest content by whoever lays it out).
 *
 * Without boxes `main` is the input, unchanged.
 * @param {string} html
 * @param {{newId?: (id: string) => string}} [options] - newId: the id for a box
 *   whose id is missing ("") or taken by an earlier box; random by default (a
 *   merge passes a deterministic one, so both writers agree)
 * @returns {ParsedContent}
 */
export function parseContent(html, { newId = () => newBoxId() } = {}) {
  const source = html ?? "";
  if (!mayHaveBoxes(source)) return { main: source, boxes: [] };
  const doc = parseHtmlBody(source);
  const body = doc.body;
  if (!body.querySelector(`.${TEXT_BOX_CLASS}`)) return { main: source, boxes: [] };

  unwrapInnerBoxes(body);

  let main = "";
  const boxes = [];
  const seen = new Set();
  for (const node of [...body.childNodes]) {
    if (isBoxElement(node)) {
      let id = node.getAttribute("data-box-id")?.trim() ?? "";
      if (!id || seen.has(id)) id = newId(id);
      seen.add(id);
      const geometry = readGeometry(node);
      boxes.push({
        id,
        x: geometry?.x ?? MAIN_BOX_GEOMETRY.x,
        y: geometry?.y ?? null,
        w: geometry?.w ?? DEFAULT_BOX_WIDTH,
        html: node.innerHTML,
      });
    } else if (boxes.length === 0) {
      main += nodeHtml(node);
    } else if (!isBlankText(node)) {
      // Text an old client typed "at the end" continues the box its user saw last
      boxes[boxes.length - 1].html += nodeHtml(node);
    }
  }
  return { main, boxes };
}

/** The wrapper of one box, attributes from the model. */
export function boxHtml(box) {
  const geometry =
    box.y === null || box.y === undefined
      ? ""
      : ` data-x="${Math.round(box.x)}" data-y="${Math.round(box.y)}" data-w="${Math.round(box.w)}"`;
  return `<div class="${TEXT_BOX_CLASS}" data-box-id="${escapeAttr(box.id)}"${geometry}>${box.html}</div>`;
}

/**
 * Note HTML from the main box and the boxes.
 * @param {ParsedContent} parsed
 * @returns {string}
 */
export function serializeContent({ main, boxes }) {
  let out = main ?? "";
  for (const box of boxes ?? []) out += boxHtml(box);
  return out;
}

/** parseContent then serializeContent: the normalized form (unchanged without boxes). */
export function normalizeContent(html) {
  const parsed = parseContent(html);
  return parsed.boxes.length === 0 ? parsed.main : serializeContent(parsed);
}

/**
 * The implicit main box as an ordinary box at the geometry that keeps its text
 * in place (first move or resize, DESIGN §3.1). It goes first, where its text
 * already is in DOM order.
 * @param {ParsedContent} parsed
 * @param {string} [id]
 * @returns {{parsed: ParsedContent, box: TextBoxModel}}
 */
export function wrapMainBox(parsed, id = newBoxId()) {
  const box = { id, ...MAIN_BOX_GEOMETRY, html: parsed.main };
  return { parsed: { main: "", boxes: [box, ...parsed.boxes] }, box };
}

/** Boxes by reading order: top to bottom, then left to right (unplaced ones last). */
export function readingOrder(boxes) {
  const top = (box) => (box.y === null || box.y === undefined ? Number.POSITIVE_INFINITY : box.y);
  return [...boxes].sort((a, b) => top(a) - top(b) || a.x - b.x);
}

/**
 * The note's text in reading order, as one HTML string without box wrappers:
 * the implicit main box, then every box by reading order (DESIGN §8). For text
 * outputs (previews, MCP, search snippets); unchanged without boxes.
 * @param {string} html
 * @returns {string}
 */
export function readingOrderHtml(html) {
  const parsed = parseContent(html);
  if (parsed.boxes.length === 0) return parsed.main;
  return [parsed.main, ...readingOrder(parsed.boxes).map((box) => box.html)]
    .filter((part) => part !== "")
    .join("");
}

/**
 * The note HTML with its boxes in reading order, wrappers and geometry kept:
 * for readers of the HTML itself (MCP, conflict previews), where the creation
 * order of boxes would scramble the text. Unchanged without boxes.
 * @param {string} html
 * @returns {string}
 */
export function inReadingOrder(html) {
  const parsed = parseContent(html);
  if (parsed.boxes.length === 0) return parsed.main;
  return serializeContent({ main: parsed.main, boxes: readingOrder(parsed.boxes) });
}

const BLOCK_TAG = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre|hr)\b[^>]*>/gi;
const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * The words a note's text holds, for search: no markup (a box's attributes,
 * class names and the like are not text), blocks apart, boxes in reading
 * order. No parser needed, so it is cheap over many notes.
 * @param {string} html
 * @returns {string}
 */
export function searchableText(html) {
  if (!html) return "";
  const ordered = mayHaveBoxes(html) ? readingOrderHtml(html) : html;
  return ordered
    .replace(BLOCK_TAG, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
}

/**
 * HTML pasted from another note or app, without box wrappers (their content
 * stays). Unchanged when it holds none.
 * @param {string} html
 * @returns {string}
 */
export function stripBoxWrappers(html) {
  if (!mayHaveBoxes(html)) return html;
  const body = parseHtmlBody(html).body;
  for (const element of [...body.querySelectorAll(`.${TEXT_BOX_CLASS}`)]) unwrap(element);
  return body.innerHTML;
}

/**
 * Width and position of a box created at a point (DESIGN §5): the default
 * width, shrunk to the space left before the page edge down to the minimum,
 * and only then moved left.
 * @param {number} x - left edge wanted
 * @returns {{x: number, w: number}}
 */
export function fitNewBox(x) {
  const left = Math.max(0, Math.round(x));
  const room = PAGE_WIDTH - left;
  if (room >= DEFAULT_BOX_WIDTH) return { x: left, w: DEFAULT_BOX_WIDTH };
  if (room >= MIN_CREATE_WIDTH) return { x: left, w: room };
  return { x: PAGE_WIDTH - MIN_CREATE_WIDTH, w: MIN_CREATE_WIDTH };
}

/** Keep a box on the page: 0 ≤ x, x + w ≤ page width, y ≥ 0, w ≥ minimum. */
export function clampBox({ x, y, w }) {
  const width = Math.max(MIN_BOX_WIDTH, Math.min(PAGE_WIDTH, Math.round(w)));
  return {
    x: Math.max(0, Math.min(PAGE_WIDTH - width, Math.round(x))),
    y: Math.max(0, Math.round(y)),
    w: width,
  };
}
