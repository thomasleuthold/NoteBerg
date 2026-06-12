/**
 * PDF Export
 *
 * Exports a note to a PDF file.
 * - Notes without an imported PDF: creates a fresh A4 document.
 * - Notes with an imported PDF: copies the original pages and overlays strokes.
 *   Strokes that extend beyond the last PDF page are placed on additional pages
 *   that match the size of the last PDF page.
 */

import html2canvas from "html2canvas";
import { LineCapStyle, PDFDocument, rgb } from "pdf-lib";
import { getMarkerPalette, getThemePalette, MARKER_ALPHA } from "../utils/noteRenderer.js";
import { sanitizeNoteHtml } from "../utils/sanitizeHtml.js";
import { getFile } from "./storage.js";

// A4 dimensions in PDF points (72 pt/inch)
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// Content width used by the note canvas (px in content space)
const CONTENT_WIDTH = 1200;

// Text editor layout constants (must match notebookEditor.css / TextEditorLayer.js)
const TEXT_PADDING_LEFT = 60; // px
const TEXT_PADDING_RIGHT = 20; // px
const TEXT_PADDING_TOP = 20; // px
const TEXT_FONT_SIZE = 16; // px
const TEXT_LINE_HEIGHT = 1.6;

/**
 * Render note HTML content to a canvas using html2canvas.
 * Returns a canvas element whose pixel height tells us the total text height in content space.
 * The canvas is rendered at `scale` times content resolution for sharpness.
 *
 * @param {string} html - note.content HTML string
 * @param {number} scale - render scale factor (2 = 2× for retina sharpness)
 * @returns {Promise<HTMLCanvasElement|null>}
 */
async function renderTextToCanvas(html, scale = 2) {
  if (!html) return null;
  // Untrusted synced HTML written into a same-origin iframe via document.write —
  // which, unlike innerHTML, even executes <script> tags. Sanitize first.
  html = sanitizeNoteHtml(html);
  // Strip all tags and check if there's any visible text content
  const textOnly = html.replace(/<[^>]*>/g, "").trim();
  if (!textOnly) return null;

  // Use an iframe for full rendering isolation — this prevents the page background
  // from bleeding into the html2canvas output and ensures a transparent result.
  const iframe = document.createElement("iframe");
  Object.assign(iframe.style, {
    position: "fixed",
    top: "-99999px",
    left: "-99999px",
    width: `${CONTENT_WIDTH}px`,
    height: "10px", // will grow with content
    border: "none",
    visibility: "hidden",
  });
  document.body.appendChild(iframe);

  // Write content into iframe with isolated styles
  const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
  iframeDoc.open();
  iframeDoc.write(`<!DOCTYPE html><html><head><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: transparent !important; }
    body {
      width: ${CONTENT_WIDTH}px;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: ${TEXT_FONT_SIZE}px;
      line-height: ${TEXT_LINE_HEIGHT};
      color: #000;
      padding: ${TEXT_PADDING_TOP}px ${TEXT_PADDING_RIGHT}px 20px ${TEXT_PADDING_LEFT}px;
      overflow: visible;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    h1 { font-size: 2em; font-weight: 700; margin: 0.5em 0; }
    h2 { font-size: 1.5em; font-weight: 600; margin: 0.5em 0; }
    h3 { font-size: 1.25em; font-weight: 600; margin: 0.5em 0; }
    p  { margin: 0.5em 0; }
    ul, ol { margin: 0.5em 0; padding-left: 2em; }
    li { margin: 0.25em 0; }
    strong { font-weight: 700; }
    em { font-style: italic; }
    table { border-collapse: collapse; width: 80%; margin: 8px 0; }
    td, th { border: 1px solid #000; padding: 6px 10px; }
    th { font-weight: 600; }
    input[type="checkbox"] { display: none; }
  </style></head><body>${html}</body></html>`);
  iframeDoc.close();

  // Resize iframe to fit content
  const bodyEl = iframeDoc.body;
  iframe.style.height = `${bodyEl.scrollHeight}px`;

  try {
    const canvas = await html2canvas(bodyEl, {
      scale,
      useCORS: true,
      backgroundColor: null,
      logging: false,
      width: CONTENT_WIDTH,
      windowWidth: CONTENT_WIDTH,
    });
    return canvas;
  } finally {
    document.body.removeChild(iframe);
  }
}

/**
 * Draw a horizontal slice of a source canvas onto a pdf-lib page as a PNG image.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {import('pdf-lib').PDFPage} pdfPage
 * @param {HTMLCanvasElement} srcCanvas - full rendered text canvas
 * @param {number} scale - render scale used when creating srcCanvas
 * @param {number} sliceContentY - top of this slice in content space (px)
 * @param {number} sliceContentH - height of this slice in content space (px)
 * @param {number} pdfPageW - PDF page width in pts
 * @param {number} pdfPageH - PDF page height in pts
 */
async function drawTextSliceOnPage(
  pdfDoc,
  pdfPage,
  srcCanvas,
  scale,
  sliceContentY,
  sliceContentH,
  pdfPageW,
  pdfPageH,
) {
  const srcY = Math.round(sliceContentY * scale);
  const srcH = Math.round(sliceContentH * scale);
  const canvasH = srcCanvas.height;

  // Clamp to actual canvas bounds
  const clampedSrcY = Math.max(0, srcY);
  const clampedSrcH = Math.min(srcH, canvasH - clampedSrcY);
  if (clampedSrcH <= 0) return;

  // Extract slice into an offscreen canvas
  const slice = document.createElement("canvas");
  slice.width = srcCanvas.width;
  slice.height = clampedSrcH;
  const ctx = slice.getContext("2d");
  ctx.drawImage(
    srcCanvas,
    0,
    clampedSrcY,
    srcCanvas.width,
    clampedSrcH,
    0,
    0,
    srcCanvas.width,
    clampedSrcH,
  );

  // Convert to PNG bytes
  const pngDataUrl = slice.toDataURL("image/png");
  const base64 = pngDataUrl.split(",")[1];
  const pngBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  const embedded = await pdfDoc.embedPng(pngBytes);

  // The slice covers the full content width; draw it at x=0, full page width
  // Y in PDF space: the slice top maps to the page top (pdfPageH), bottom to (pdfPageH - sliceH)
  const drawnH = (clampedSrcH / scale) * (pdfPageW / CONTENT_WIDTH);
  pdfPage.drawImage(embedded, {
    x: 0,
    y: pdfPageH - drawnH,
    width: pdfPageW,
    height: drawnH,
  });
}

/**
 * Parse a hex color string ("#rrggbb") to an rgb() value usable by pdf-lib.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/**
 * Build an SVG path string from a stroke using quadratic bezier curves,
 * in SVG coordinate space (origin top-left, Y increases downward).
 *
 * pdf-lib's drawSvgPath internally applies scale(1, -1) to flip Y into PDF
 * space, so we must NOT pre-flip Y here — just translate and scale relative
 * to the page's top-left corner.
 *
 * @param {Object} stroke
 * @param {number} offsetX - content X of the page's left edge
 * @param {number} offsetY - content Y of the page's top edge
 * @param {number} scaleX - content px → PDF pt scale for X
 * @param {number} scaleY - content px → PDF pt scale for Y
 * @returns {string} SVG path string, or empty string if not enough points
 */
function buildSvgPath(stroke, offsetX, offsetY, scaleX, scaleY) {
  const xs = stroke.x;
  const ys = stroke.y;
  const count = xs.length;
  if (count < 2) return "";

  // Transform content-space point to page-local SVG space (top-left origin, Y down)
  const tx = (cx) => (cx - offsetX) * scaleX;
  const ty = (cy) => (cy - offsetY) * scaleY;

  const parts = [];
  parts.push(`M ${tx(xs[0]).toFixed(3)} ${ty(ys[0]).toFixed(3)}`);

  if (count === 2) {
    parts.push(`L ${tx(xs[1]).toFixed(3)} ${ty(ys[1]).toFixed(3)}`);
  } else {
    // Use cubic beziers (C) elevated from quadratic (Q) for better cross-renderer compatibility.
    // Chained Q segments cause visible gaps in LibreOffice due to per-segment cap rendering.
    // Elevation formula: CP1 = P0 + 2/3*(Qcp - P0), CP2 = Pend + 2/3*(Qcp - Pend)
    let p0x = tx(xs[0]);
    let p0y = ty(ys[0]);

    for (let i = 1; i < count - 1; i++) {
      const qcpx = tx(xs[i]);
      const qcpy = ty(ys[i]);
      const endx = (tx(xs[i]) + tx(xs[i + 1])) / 2;
      const endy = (ty(ys[i]) + ty(ys[i + 1])) / 2;

      const cp1x = p0x + (2 / 3) * (qcpx - p0x);
      const cp1y = p0y + (2 / 3) * (qcpy - p0y);
      const cp2x = endx + (2 / 3) * (qcpx - endx);
      const cp2y = endy + (2 / 3) * (qcpy - endy);

      parts.push(
        `C ${cp1x.toFixed(3)} ${cp1y.toFixed(3)} ${cp2x.toFixed(3)} ${cp2y.toFixed(3)} ${endx.toFixed(3)} ${endy.toFixed(3)}`,
      );
      p0x = endx;
      p0y = endy;
    }

    // Final segment: from last midpoint to the actual last point
    const li = count - 1;
    const qcpx = tx(xs[li - 1]);
    const qcpy = ty(ys[li - 1]);
    const endx = tx(xs[li]);
    const endy = ty(ys[li]);
    const cp1x = p0x + (2 / 3) * (qcpx - p0x);
    const cp1y = p0y + (2 / 3) * (qcpy - p0y);
    const cp2x = endx + (2 / 3) * (qcpx - endx);
    const cp2y = endy + (2 / 3) * (qcpy - endy);
    parts.push(
      `C ${cp1x.toFixed(3)} ${cp1y.toFixed(3)} ${cp2x.toFixed(3)} ${cp2y.toFixed(3)} ${endx.toFixed(3)} ${endy.toFixed(3)}`,
    );
  }

  return parts.join(" ");
}

/**
 * Draw the note's background pattern (ruled lines or grid) onto a PDF page.
 *
 * Spacing values match drawBackgroundPattern() in noteRenderer.js (20/30/40 px in content space).
 * The pattern color defaults to #e5e7eb (same as the CSS variable fallback).
 *
 * @param {import('pdf-lib').PDFPage} pdfPage
 * @param {string} backgroundType - e.g. "ruled-narrow", "grid-medium", "none"
 * @param {number} pdfPageW - PDF page width in pts
 * @param {number} pdfPageH - PDF page height in pts
 * @param {number} contentPageW - Page width in content space (px)
 * @param {number} contentPageH - Page height in content space (px)
 */
function drawBackgroundPatternOnPage(
  pdfPage,
  backgroundType,
  pdfPageW,
  pdfPageH,
  contentPageW,
  contentPageH,
) {
  if (!backgroundType || backgroundType === "none") return;

  const scaleX = pdfPageW / contentPageW;
  const scaleY = pdfPageH / contentPageH;

  // Pattern color — matches CSS variable fallback used in noteRenderer.js
  const { r, g, b } = hexToRgb("#e5e7eb");
  const color = rgb(r, g, b);

  const spacingMap = {
    "ruled-narrow": 20,
    "ruled-medium": 30,
    "ruled-wide": 40,
    "grid-small": 20,
    "grid-medium": 30,
    "grid-large": 40,
  };
  const spacing = spacingMap[backgroundType];
  if (!spacing) return;

  const isGrid = backgroundType.startsWith("grid");
  const spacingPtY = spacing * scaleY;
  const spacingPtX = spacing * scaleX;

  // Horizontal lines (ruled + grid)
  // PDF Y-up: first line is near the top of the page (pdfPageH - spacingPtY)
  for (let yPt = pdfPageH - spacingPtY; yPt > 0; yPt -= spacingPtY) {
    pdfPage.drawLine({
      start: { x: 0, y: yPt },
      end: { x: pdfPageW, y: yPt },
      thickness: 0.5,
      color,
      opacity: 1,
    });
  }

  // Vertical lines (grid only)
  if (isGrid) {
    for (let xPt = spacingPtX; xPt < pdfPageW; xPt += spacingPtX) {
      pdfPage.drawLine({
        start: { x: xPt, y: 0 },
        end: { x: xPt, y: pdfPageH },
        thickness: 0.5,
        color,
        opacity: 1,
      });
    }
  }
}

/**
 * Draw all strokes that overlap a page's Y range onto the given pdf-lib PDFPage.
 *
 * @param {import('pdf-lib').PDFPage} pdfPage - Target page
 * @param {Object[]} strokes - Active strokes in content space
 * @param {number} contentPageX - Content X of page left edge (usually 0)
 * @param {number} contentPageY - Content Y of page top edge
 * @param {number} contentPageW - Page width in content space (px)
 * @param {number} contentPageH - Page height in content space (px)
 * @param {number} pdfPageW - PDF page width in pts
 * @param {number} pdfPageH - PDF page height in pts
 */
function drawStrokesOnPage(
  pdfPage,
  strokes,
  contentPageX,
  contentPageY,
  contentPageW,
  contentPageH,
  pdfPageW,
  pdfPageH,
) {
  const scaleX = pdfPageW / contentPageW;
  const scaleY = pdfPageH / contentPageH;

  const penPalette = getThemePalette();
  const markerPalette = getMarkerPalette();

  const pageBottom = contentPageY + contentPageH;

  for (const stroke of strokes) {
    if (!stroke.x || stroke.x.length < 2) continue;

    // Only draw strokes that overlap this page's Y range
    let strokeMinY = stroke.y[0];
    let strokeMaxY = stroke.y[0];
    for (let k = 1; k < stroke.y.length; k++) {
      if (stroke.y[k] < strokeMinY) strokeMinY = stroke.y[k];
      if (stroke.y[k] > strokeMaxY) strokeMaxY = stroke.y[k];
    }
    if (strokeMaxY < contentPageY || strokeMinY > pageBottom) continue;

    const isMarker = stroke.type === "marker";
    const palette = isMarker ? markerPalette : penPalette;
    const colorIndex = stroke.colorIndex ?? 0;
    const hexColor = palette[Math.min(colorIndex, palette.length - 1)] ?? "#000000";
    const { r, g, b } = hexToRgb(hexColor);
    const opacity = isMarker ? MARKER_ALPHA : 1.0;
    const lineWidth = (stroke.width || 2) * Math.min(scaleX, scaleY);

    const svgPath = buildSvgPath(stroke, contentPageX, contentPageY, scaleX, scaleY);
    if (!svgPath) continue;

    // x=0, y=pdfPageH positions the SVG origin at the page's top-left corner.
    // pdf-lib's drawSvgPath applies scale(1,-1) internally, so SVG Y-down
    // coordinates correctly map to PDF Y-up space.
    pdfPage.drawSvgPath(svgPath, {
      x: 0,
      y: pdfPageH,
      borderColor: rgb(r, g, b),
      borderWidth: lineWidth,
      borderOpacity: opacity,
      borderLineCap: LineCapStyle.Round,
      color: undefined,
    });
  }
}

/**
 * Embed an image media item onto a pdf-lib page.
 * Supports JPEG and PNG (detected by magic bytes). Silently skips on error.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {import('pdf-lib').PDFPage} pdfPage
 * @param {Object} imgItem - media item {fileId, x, y, width, height, rotation}
 * @param {number} contentPageX - content X of page left edge
 * @param {number} contentPageY - content Y of page top edge
 * @param {number} scaleX - content px → PDF pt
 * @param {number} scaleY - content px → PDF pt
 * @param {number} pdfPageH - PDF page height in pts
 */
async function drawImageOnPage(
  pdfDoc,
  pdfPage,
  imgItem,
  contentPageX,
  contentPageY,
  scaleX,
  scaleY,
  pdfPageH,
) {
  try {
    const blob = await getFile(imgItem.fileId);
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Detect format by magic bytes
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!isJpeg && !isPng) return;

    const embedded = isJpeg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);

    const pdfW = imgItem.width * scaleX;
    const pdfH = imgItem.height * scaleY;

    // Image center in PDF space (Y-up, origin bottom-left of page)
    const centerX = (imgItem.x - contentPageX + imgItem.width / 2) * scaleX;
    const centerY = pdfPageH - (imgItem.y - contentPageY + imgItem.height / 2) * scaleY;

    const rotation = imgItem.rotation || 0;

    let pdfX, pdfY;
    if (rotation === 0) {
      // Fast path: no rotation, anchor is simply the bottom-left of the image
      pdfX = centerX - pdfW / 2;
      pdfY = centerY - pdfH / 2;
    } else {
      // pdf-lib rotates counterclockwise around (x, y) = the image's bottom-left corner.
      // Canvas stores rotation in clockwise degrees around the image center.
      // We need: after rotating by -rotation degrees (CCW), the image center stays at (centerX, centerY).
      //
      // If the bottom-left anchor is (ax, ay), the center of the unrotated image relative to
      // the anchor is (+pdfW/2, +pdfH/2). After a CCW rotation of angle θ, that offset becomes:
      //   centerX = ax + cos(θ)*pdfW/2 - sin(θ)*pdfH/2
      //   centerY = ay + sin(θ)*pdfW/2 + cos(θ)*pdfH/2
      // Solve for (ax, ay):
      const theta = (-rotation * Math.PI) / 180; // CCW radians
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      pdfX = centerX - (cosT * pdfW) / 2 + (sinT * pdfH) / 2;
      pdfY = centerY - (sinT * pdfW) / 2 - (cosT * pdfH) / 2;
    }

    pdfPage.drawImage(embedded, {
      x: pdfX,
      y: pdfY,
      width: pdfW,
      height: pdfH,
      rotate: rotation ? { type: "degrees", angle: -rotation } : undefined,
    });
  } catch (_err) {
    // Skip images that can't be embedded (unsupported format, missing file, etc.)
  }
}

/**
 * Export a note to a PDF Uint8Array.
 *
 * @param {Object} note - Note data (strokes, pdfSource, background, etc.)
 * @param {Object[]} mediaItems - Current media items from MediaManager
 * @param {(current: number, total: number) => void} [onProgress] - Optional progress callback
 * @returns {Promise<Uint8Array>} PDF file bytes
 */
export async function exportNoteToPdf(note, mediaItems, onProgress) {
  const activeStrokes = (note.strokes || []).filter((s) => !s._deleted && !s.isDeleted);

  const pdfPages = (mediaItems || [])
    .filter((m) => m.type === "pdf-page")
    .sort((a, b) => a.pageIndex - b.pageIndex);

  // Images are non-pdf-page media items
  const imageItems = (mediaItems || []).filter((m) => m.type === "image");

  // Render text content to an offscreen canvas (2× scale for sharpness)
  const TEXT_SCALE = 2;
  let textCanvas = null;
  try {
    textCanvas = note.content ? await renderTextToCanvas(note.content, TEXT_SCALE) : null;
  } catch (textErr) {
    console.warn("[PDFExport] Text rendering failed, skipping text layer:", textErr);
  }
  // textCanvas height / TEXT_SCALE = total text height in content-space pixels
  const textContentH = textCanvas ? textCanvas.height / TEXT_SCALE : 0;

  let pdfDoc;

  if (pdfPages.length > 0) {
    // ── Case A: Note has an imported PDF ──────────────────────────────────
    // pdfSource may be null for older notes; fall back to the fileId of the first pdf-page item
    const pdfFileId = note.pdfSource || pdfPages[0].fileId;
    const blob = await getFile(pdfFileId);
    if (!blob) throw new Error("PDF source file not found in storage");
    const originalBytes = await blob.arrayBuffer();

    const srcDoc = await PDFDocument.load(originalBytes);
    pdfDoc = await PDFDocument.create();

    // Copy all original pages
    const pageCount = srcDoc.getPageCount();
    const copiedPages = await pdfDoc.copyPages(
      srcDoc,
      Array.from({ length: pageCount }, (_, i) => i),
    );
    for (const page of copiedPages) {
      pdfDoc.addPage(page);
    }

    // Total pages = original PDF pages + any extra overflow pages (calculated later)
    // We'll report progress as we go; use pdfPages.length as the known minimum total
    const extraPageCount = (() => {
      let globalMaxY = 0;
      for (const s of activeStrokes) {
        for (let k = 0; k < s.y.length; k++) {
          if (s.y[k] > globalMaxY) globalMaxY = s.y[k];
        }
      }
      for (const img of imageItems) {
        if (img.y + img.height > globalMaxY) globalMaxY = img.y + img.height;
      }
      if (textContentH > globalMaxY) globalMaxY = textContentH;
      const lastPg = pdfPages[pdfPages.length - 1];
      const lastBottom = lastPg.y + lastPg.height;
      return globalMaxY > lastBottom ? Math.ceil((globalMaxY - lastBottom) / lastPg.height) : 0;
    })();
    const totalPages = pdfPages.length + extraPageCount;

    // Draw text, strokes and images on each original page
    for (let i = 0; i < pdfPages.length; i++) {
      onProgress?.(i + 1, totalPages);
      const mediaPg = pdfPages[i]; // media item (content coords)
      const pdfPg = pdfDoc.getPage(i); // the exported page
      const { width: pdfW, height: pdfH } = pdfPg.getSize();
      const scaleX = pdfW / mediaPg.width;
      const scaleY = pdfH / mediaPg.height;
      const pageBottom = mediaPg.y + mediaPg.height;

      // Draw background pattern underneath everything else
      drawBackgroundPatternOnPage(
        pdfPg,
        note.background,
        pdfW,
        pdfH,
        mediaPg.width,
        mediaPg.height,
      );

      // Draw text slice that overlaps this page's Y range
      if (textCanvas && textContentH > mediaPg.y) {
        await drawTextSliceOnPage(
          pdfDoc,
          pdfPg,
          textCanvas,
          TEXT_SCALE,
          mediaPg.y,
          mediaPg.height,
          pdfW,
          pdfH,
        );
      }

      // Draw images that overlap this page
      for (const img of imageItems) {
        if (img.y + img.height >= mediaPg.y && img.y < pageBottom) {
          await drawImageOnPage(pdfDoc, pdfPg, img, mediaPg.x, mediaPg.y, scaleX, scaleY, pdfH);
        }
      }

      drawStrokesOnPage(
        pdfPg,
        activeStrokes,
        mediaPg.x,
        mediaPg.y,
        mediaPg.width,
        mediaPg.height,
        pdfW,
        pdfH,
      );
    }

    // Append extra pages for strokes/images/text beyond the last PDF page
    if (extraPageCount > 0) {
      const lastMediaPg = pdfPages[pdfPages.length - 1];
      const lastPageBottom = lastMediaPg.y + lastMediaPg.height;
      const lastPdfPg = pdfDoc.getPage(pdfPages.length - 1);
      const { width: extraW, height: extraH } = lastPdfPg.getSize();
      const extraContentH = lastMediaPg.height;
      const scaleX = extraW / lastMediaPg.width;
      const scaleY = extraH / lastMediaPg.height;

      for (let ep = 0; ep < extraPageCount; ep++) {
        onProgress?.(pdfPages.length + ep + 1, totalPages);
        const extraPage = pdfDoc.addPage([extraW, extraH]);
        const pageContentY = lastPageBottom + ep * extraContentH;
        const pageBottom = pageContentY + extraContentH;

        // Draw background pattern underneath everything else
        drawBackgroundPatternOnPage(
          extraPage,
          note.background,
          extraW,
          extraH,
          lastMediaPg.width,
          lastMediaPg.height,
        );

        // Draw text slice for this extra page
        if (textCanvas && textContentH > pageContentY) {
          await drawTextSliceOnPage(
            pdfDoc,
            extraPage,
            textCanvas,
            TEXT_SCALE,
            pageContentY,
            extraContentH,
            extraW,
            extraH,
          );
        }

        for (const img of imageItems) {
          if (img.y + img.height >= pageContentY && img.y < pageBottom) {
            await drawImageOnPage(
              pdfDoc,
              extraPage,
              img,
              lastMediaPg.x,
              pageContentY,
              scaleX,
              scaleY,
              extraH,
            );
          }
        }

        drawStrokesOnPage(
          extraPage,
          activeStrokes,
          lastMediaPg.x,
          pageContentY,
          lastMediaPg.width,
          lastMediaPg.height,
          extraW,
          extraH,
        );
      }
    }
  } else {
    // ── Case B: Note has no imported PDF — create A4 document ────────────
    pdfDoc = await PDFDocument.create();

    const scaleX = A4_WIDTH / CONTENT_WIDTH;
    const scaleY = scaleX;
    const contentPageH = A4_HEIGHT / scaleY;

    // Determine total content height from text, strokes and images
    let totalContentH = Math.max(contentPageH, textContentH + 50);
    for (const s of activeStrokes) {
      for (let k = 0; k < s.y.length; k++) {
        if (s.y[k] + 50 > totalContentH) totalContentH = s.y[k] + 50;
      }
    }
    for (const img of imageItems) {
      const bottom = img.y + img.height + 50;
      if (bottom > totalContentH) totalContentH = bottom;
    }

    const pageCount = Math.ceil(totalContentH / contentPageH);

    for (let p = 0; p < pageCount; p++) {
      onProgress?.(p + 1, pageCount);
      const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
      const contentPageY = p * contentPageH;
      const pageBottom = contentPageY + contentPageH;

      // Draw background pattern underneath everything else
      drawBackgroundPatternOnPage(
        page,
        note.background,
        A4_WIDTH,
        A4_HEIGHT,
        CONTENT_WIDTH,
        contentPageH,
      );

      // Draw text slice for this page
      if (textCanvas && textContentH > contentPageY) {
        await drawTextSliceOnPage(
          pdfDoc,
          page,
          textCanvas,
          TEXT_SCALE,
          contentPageY,
          contentPageH,
          A4_WIDTH,
          A4_HEIGHT,
        );
      }

      // Draw images that overlap this page
      for (const img of imageItems) {
        if (img.y + img.height >= contentPageY && img.y < pageBottom) {
          await drawImageOnPage(pdfDoc, page, img, 0, contentPageY, scaleX, scaleY, A4_HEIGHT);
        }
      }

      drawStrokesOnPage(
        page,
        activeStrokes,
        0,
        contentPageY,
        CONTENT_WIDTH,
        contentPageH,
        A4_WIDTH,
        A4_HEIGHT,
      );
    }
  }

  // Write document metadata
  if (note.title) pdfDoc.setTitle(note.title);
  pdfDoc.setCreator("NoteBerg (pdf-lib)");
  pdfDoc.setProducer("NoteBerg (pdf-lib)");
  if (note.modified) pdfDoc.setModificationDate(new Date(note.modified));

  return pdfDoc.save();
}

/**
 * Save PDF bytes to disk / open for viewing.
 * - Desktop Tauri: native Save dialog via the `save_pdf` Rust command.
 * - Mobile Tauri (Android/iOS): write to app cache dir via Rust (returns file path),
 *   then open the file with openPath() from tauri-plugin-opener.
 *   On Android, openPath() uses a FileProvider URI + ACTION_VIEW intent, which hands
 *   the file off to the system PDF viewer. blob: URLs are not valid Android intents.
 * - Plain browser: trigger a blob download via a hidden anchor.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
export async function downloadPdfBytes(bytes, filename) {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isTauri =
    typeof window !== "undefined" &&
    (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined);
  const isAndroid = ua.includes("Android");
  const isIos = /iPad|iPhone|iPod/.test(ua);

  if (isTauri && !isAndroid && !isIos) {
    // Desktop Tauri (Windows/macOS/Linux): native Save dialog
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_pdf", { bytes: Array.from(bytes), suggestedName: filename });
    return;
  }

  if (isTauri && (isAndroid || isIos)) {
    // Write PDF to app cache dir and open it — done entirely in Rust to avoid
    // an Android Jackson deserialization bug when calling openPath() from JS.
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_pdf", {
      bytes: Array.from(bytes),
      suggestedName: filename,
    });
    return;
  }

  // Plain browser fallback: trigger download directly
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
