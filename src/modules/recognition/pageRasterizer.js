/**
 * Page rasterizer — strokes to band images for AI recognition.
 *
 * Renders a note's ink as one PNG image per virtual A4 page. The binding
 * constraint is legibility rather than context size: downscaled handwriting is
 * where vision model accuracy collapses, so each page is rendered at the
 * configured resolution rather than the note being squeezed into one image
 * (DESIGN §3.2).
 *
 * Images align to the page breaks drawn on the canvas, so a user who avoids
 * writing across a visible break can rely on no word being split between two
 * images. An earlier scheme used overlapping slices at arbitrary offsets, which
 * needed de-duplication afterwards; alignment removes the need for both.
 *
 * Rendering parameters are deliberately exposed rather than baked in: stroke
 * width, contrast and resolution are a tuning surface we control completely,
 * and are expected to move accuracy more than prompt wording does (DESIGN §3.3).
 */

import { pagesInRange } from "../pageGeometry.js";
import { REGION_COLORS, REGION_COUNT } from "./regions.js";

/** Default rendering parameters. Swept during PLAN Phase 3 measurement. */
export const DEFAULT_RENDER_OPTS = {
  /** Longest edge of a rendered band, in image pixels. */
  maxImageEdge: 1600,
  /**
   * Page width in content px. Matches NoteCanvas's maxContentWidth so the
   * rendered page is exactly the one the user writes on.
   */
  pageWidth: 1200,
  /**
   * Minimum stroke width in *image* px. Thin strokes disappear when a page is
   * scaled down, which reads to the model as missing letters rather than as
   * faint ones.
   */
  minStrokeWidthPx: 2,
  /** Ink colour. Recognition renders mono regardless of the note's palette. */
  inkColor: "#000000",
  /** Background colour. */
  backgroundColor: "#ffffff",
};

/**
 * Bounding box of a set of strokes in content space.
 *
 * @param {Array} strokes
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function strokeBounds(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const s of strokes) {
    if (!s?.x?.length) continue;
    for (let i = 0; i < s.x.length; i++) {
      if (s.x[i] < minX) minX = s.x[i];
      if (s.x[i] > maxX) maxX = s.x[i];
      if (s.y[i] < minY) minY = s.y[i];
      if (s.y[i] > maxY) maxY = s.y[i];
    }
  }

  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Pixels-per-content-unit for rendering.
 *
 * @param {number} contentWidth
 * @param {Object} opts - render options
 * @returns {number}
 */
export function computeScale(contentWidth, opts) {
  if (!(contentWidth > 0)) return 1;

  // Every page is scaled to exactly the configured image size — up as well as
  // down.
  //
  // A previous 1:1 cap made the setting inert for any page narrower than it,
  // which is the common case: a 1200px page asked to render at 1600 still came
  // out 1200 wide. That mattered for small handwriting — text at a fifth of
  // normal height renders under 10px, which no vision model reads — and left no
  // way to fix it from settings.
  //
  // Upscaling adds no detail, but it does give the model more pixels per stroke,
  // which is what its patch-based encoder actually consumes.
  return opts.maxImageEdge / contentWidth;
}

/**
 * Split a content-space Y range into one entry per virtual page.
 *
 * Images align to the note's A4 page breaks — the same dashed lines drawn on
 * the canvas — rather than to an arbitrary slice height. A user who avoids
 * writing across a visible page break can then rely on no word being split
 * between two images, which is what those lines imply.
 *
 * This replaces the previous overlapping-slice scheme. Overlap existed precisely
 * because slice boundaries fell in arbitrary places and could cut a line of text
 * in half; aligning to page breaks removes the reason for it, and with it the
 * duplicate transcriptions the overlap produced.
 *
 * @param {{minY: number, maxY: number}} bounds - ink extent in content space
 * @param {number} contentWidth - note content width
 * @returns {Array<{index: number, contentY: number, contentHeight: number}>}
 */
export function planBands(bounds, contentWidth) {
  const pages = pagesInRange(bounds.minY, bounds.maxY, contentWidth);

  // A note shorter than one page still renders as a single image covering that
  // page, so page-relative positions stay meaningful.
  if (pages.length === 0) {
    return [{ index: 0, contentY: bounds.minY, contentHeight: bounds.maxY - bounds.minY }];
  }

  return pages.map((page, i) => ({
    // Numbered from zero for this render, so the first image is index 0 whether
    // or not the note happens to start on page 1.
    index: i,
    contentY: page.top,
    contentHeight: page.bottom - page.top,
  }));
}

/**
 * Paint the coloured localization bands across a band image.
 *
 * Colours span the *whole note*, not the rendered slice, so a word's band is
 * the same regardless of how the note was split for rendering — otherwise the
 * second image of a tall note would restart at the first colour.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width - image width in px
 * @param {number} height - image height in px
 * @param {{contentY: number, contentHeight: number}} span - the rendered image
 */
function drawRegionBands(ctx, width, height) {
  // Bands divide *this image*, not the whole note.
  //
  // Spanning the note would make a band cover hundreds of lines on a long note,
  // so "which colour is this word on" would locate it no better than "somewhere
  // in the top half". Per-image bands keep each colour a constant fraction of
  // one screenful regardless of note length; the caller records which image a
  // word came from, so the pair (image, colour) stays unambiguous.
  const bandHeight = height / REGION_COUNT;

  for (let i = 0; i < REGION_COUNT; i++) {
    ctx.fillStyle = REGION_COLORS[i].fill;
    ctx.fillRect(0, i * bandHeight, width, bandHeight);
  }
}

/**
 * Draw strokes into a canvas context for one band.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} strokes
 * @param {{contentX: number, contentY: number, scale: number}} transform
 * @param {Object} opts
 */
function drawStrokes(ctx, strokes, transform, opts) {
  const { contentX, contentY, scale } = transform;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = opts.inkColor;

  for (const s of strokes) {
    if (!s?.x?.length || s.x.length < 1) continue;

    // Marker strokes are rendered as ordinary ink: the model only needs the
    // glyph shapes, and translucent overlapping sweeps reduce contrast.
    const width = Math.max(opts.minStrokeWidthPx, (s.width ?? 2) * scale);
    ctx.lineWidth = width;

    ctx.beginPath();
    const px = (s.x[0] - contentX) * scale;
    const py = (s.y[0] - contentY) * scale;

    if (s.x.length === 1) {
      // A single point renders as a dot — important for i/j dots and full stops.
      ctx.arc(px, py, width / 2, 0, Math.PI * 2);
      ctx.fillStyle = opts.inkColor;
      ctx.fill();
      continue;
    }

    ctx.moveTo(px, py);
    // Midpoint-quadratic smoothing, matching how strokes are drawn on canvas
    // and exported to PDF, so the model sees the same letterforms the user did.
    for (let i = 1; i < s.x.length - 1; i++) {
      const cx = (s.x[i] - contentX) * scale;
      const cy = (s.y[i] - contentY) * scale;
      const mx = ((s.x[i] + s.x[i + 1]) / 2 - contentX) * scale;
      const my = ((s.y[i] + s.y[i + 1]) / 2 - contentY) * scale;
      ctx.quadraticCurveTo(cx, cy, mx, my);
    }
    const li = s.x.length - 1;
    ctx.lineTo((s.x[li] - contentX) * scale, (s.y[li] - contentY) * scale);
    ctx.stroke();
  }
}

/**
 * Create a canvas, preferring OffscreenCanvas so rasterization stays off the
 * main thread's paint path. Falls back to a DOM canvas where unavailable.
 */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Convert a canvas to a PNG blob, handling both canvas flavours. */
async function canvasToPng(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * Fraction of sampled pixels that differ from the background.
 *
 * Sampled on a grid rather than per-pixel: this runs on every band, on mobile
 * hardware, and an exact count would cost more than it is worth. The value is
 * only used to distinguish "some ink" from "none".
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {string} backgroundColor
 * @returns {number} 0 when nothing was drawn
 */
export function measureInkCoverage(ctx, width, height, backgroundColor) {
  let data;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch (_e) {
    // getImageData can be unavailable (tainted canvas, or a stub in tests).
    // Return a non-zero value so a missing capability never blocks a request.
    return -1;
  }

  // The background is a known flat colour, so any pixel differing from it is ink.
  const bg = backgroundColor === "#ffffff" ? 255 : null;
  const step = 4 * 7; // sample every 7th pixel
  let inked = 0;
  let sampled = 0;

  for (let i = 0; i < data.length; i += step) {
    sampled++;
    if (bg === null) {
      if (data[i + 3] !== 0) inked++;
    } else if (data[i] !== bg || data[i + 1] !== bg || data[i + 2] !== bg) {
      inked++;
    }
  }

  return sampled === 0 ? 0 : inked / sampled;
}

/**
 * Vertical extent of one stroke.
 *
 * Shared because three callers needed it and each carried its own copy of the
 * loop: page assignment, the small-text diagnostic, and the overall bounds.
 *
 * @param {Object} stroke
 * @returns {{minY: number, maxY: number}|null} null for a stroke with no points
 */
function strokeYExtent(stroke) {
  if (!stroke?.y?.length) return null;
  let minY = stroke.y[0];
  let maxY = stroke.y[0];
  for (let i = 1; i < stroke.y.length; i++) {
    if (stroke.y[i] < minY) minY = stroke.y[i];
    if (stroke.y[i] > maxY) maxY = stroke.y[i];
  }
  return { minY, maxY };
}

/**
 * Height of the smallest text-like stroke group, in image pixels.
 *
 * Reported so a page whose fine print will not survive rasterization is visible
 * before a slow, paid recognition run rather than after. Vision models need
 * roughly 20px of glyph height to read reliably; below that, small handwriting
 * is silently skipped while the rest of the page transcribes fine — which reads
 * as the model being bad rather than the image being too small.
 *
 * Uses a low percentile rather than the true minimum: dots, accents and stray
 * marks are legitimately tiny and would otherwise dominate the figure.
 *
 * @param {Array} strokes
 * @param {number} scale - content px to image px
 * @returns {number} height in image px, or 0 when there is nothing to measure
 */
export function smallestTextHeight(strokes, scale) {
  const heights = [];
  for (const s of strokes || []) {
    const extent = strokeYExtent(s);
    if (!extent) continue;
    const h = extent.maxY - extent.minY;
    // Ignore dots and specks, which are tiny by nature rather than by scale.
    if (h > 2) heights.push(h);
  }

  if (heights.length === 0) return 0;

  heights.sort((a, b) => a - b);
  const percentile = heights[Math.floor(heights.length * 0.1)];
  return percentile * scale;
}

/**
 * Rasterize a note's strokes into one or more band images.
 *
 * Each band records the transform used to produce it, so the caller can map
 * model-reported image coordinates back into content space.
 *
 * @param {Array} strokes - active strokes in content space
 * @param {Object} [options] - overrides for DEFAULT_RENDER_OPTS
 * @param {Function} [onProgress] - (phase, current, total)
 * @returns {Promise<Array<{
 *   index: number, png: Blob, width: number, height: number,
 *   contentX: number, contentY: number, scale: number
 * }>>}
 */
export async function rasterizeNote(strokes, options = {}, onProgress) {
  const opts = { ...DEFAULT_RENDER_OPTS, ...options };
  const bounds = strokeBounds(strokes);
  if (!bounds) return [];

  // Always the note's real page box: the full width the user writes on, and
  // whole virtual pages vertically.
  //
  // Cropping to the ink is gone: it made image boundaries depend on where the
  // strokes happened to fall, so the same handwriting could land in different
  // places across two runs, and there was no boundary the user could see or
  // write around. Page-aligned images are the ones the dashed page-break lines
  // already promise.
  const padded = {
    minX: 0,
    minY: 0,
    maxX: opts.pageWidth,
    maxY: bounds.maxY,
  };

  const contentWidth = padded.maxX - padded.minX;
  const scale = computeScale(contentWidth, opts);
  const plan = planBands(padded, contentWidth);

  // Each stroke's vertical extent, computed once. Page assignment needs it for
  // every page, and recomputing it per page walked every point of every stroke
  // once per page — a long note turned that into tens of thousands of scans of
  // data that cannot change while rendering.
  const strokeExtents = strokes.map((s) => {
    const extent = strokeYExtent(s);
    return extent && { stroke: s, ...extent };
  });

  const bands = [];
  for (const band of plan) {
    onProgress?.("rasterize", band.index + 1, plan.length);

    const width = Math.max(1, Math.round(contentWidth * scale));
    const height = Math.max(1, Math.round(band.contentHeight * scale));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    // Only strokes overlapping this page are drawn. A stroke crossing a page
    // break appears in both — rare, since the break is visible and users write
    // around it, and drawing it whole in each is better than clipping it in one.
    const bandTop = band.contentY;
    const bandBottom = band.contentY + band.contentHeight;
    const bandStrokes = strokeExtents
      .filter((e) => e && e.maxY >= bandTop && e.minY <= bandBottom)
      .map((e) => e.stroke);

    // Bands first, then ink on top.
    drawRegionBands(ctx, width, height);

    drawStrokes(ctx, bandStrokes, { contentX: padded.minX, contentY: bandTop, scale }, opts);

    // Verify ink actually landed on the canvas.
    //
    // A blank image is the single most confusing failure in this pipeline: the
    // request succeeds, the model dutifully reports "no handwriting", and the
    // result is indistinguishable from a model that cannot read. Sampling the
    // rendered pixels turns that into a loud, specific error instead.
    const inkRatio = measureInkCoverage(ctx, width, height, opts.backgroundColor);
    if (bandStrokes.length > 0 && inkRatio === 0) {
      throw new Error(
        `Rasterizer produced a blank ${width}x${height} image from ${bandStrokes.length} stroke(s). ` +
          "Recognition would report no handwriting, so the request was not sent.",
      );
    }

    bands.push({
      smallestText: smallestTextHeight(bandStrokes, scale),
      inkRatio,
      index: band.index,
      png: await canvasToPng(canvas),
      width,
      height,
      contentX: padded.minX,
      contentY: bandTop,
      scale,
    });
  }

  return bands;
}
