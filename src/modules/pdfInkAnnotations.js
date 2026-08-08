/**
 * PDF Ink Annotations
 *
 * Emits strokes as real PDF `/Ink` annotation objects (PDF 32000-1, 12.5.6.13)
 * instead of painting them into the page content stream.
 *
 * Used only for notes built on an imported PDF, where ink genuinely annotates a
 * source document. Plain notes keep the content-stream path in pdfExport.js —
 * there the ink *is* the document, not a comment on it.
 *
 * Every annotation carries an appearance stream (`/AP`). Viewers are not
 * required to synthesise an appearance from `/InkList`, and many (Chrome's
 * built-in viewer, macOS Preview) draw nothing at all without `/AP`. Since
 * annotated PDFs are the ones most likely to be sent to other people, the
 * appearance stream is mandatory here, not an optimisation.
 *
 * Marker strokes use `/Ink` with constant alpha (`/CA`) rather than
 * `/Highlight`: `/Highlight` geometry is `/QuadPoints` (axis-aligned rectangles),
 * which cannot represent a freehand sweep without turning curves into a
 * staircase. `/Ink` reproduces the path that was actually drawn.
 */

import { PDFName, PDFString } from "pdf-lib";
import { getMarkerPalette, getThemePalette, MARKER_ALPHA } from "../utils/noteRenderer.js";

/** Author shown in viewer annotation sidebars. */
const ANNOT_AUTHOR = "NoteBerg";

/** `/F` annotation flag bit 3 (value 4) = Print. Without it, ink is screen-only. */
const ANNOT_FLAG_PRINT = 4;

/**
 * Convert a stroke's points into cubic bezier segments in a caller-defined
 * coordinate space.
 *
 * This is the same midpoint-quadratic scheme used by buildSvgPath() in
 * pdfExport.js, elevated to cubics, but returns structured segments rather than
 * a formatted string so the caller can emit either SVG or PDF operators.
 *
 * @param {Object} stroke - stroke with x[]/y[] in content space
 * @param {(cx: number) => number} tx - content X → target space X
 * @param {(cy: number) => number} ty - content Y → target space Y
 * @returns {{ start: {x: number, y: number}, segments: Array<{cp1: {x,y}, cp2: {x,y}, end: {x,y}}> }|null}
 */
function buildBezierSegments(stroke, tx, ty) {
  const xs = stroke.x;
  const ys = stroke.y;
  const count = xs?.length ?? 0;
  if (count < 2) return null;

  const start = { x: tx(xs[0]), y: ty(ys[0]) };
  const segments = [];

  if (count === 2) {
    // A straight line expressed as a degenerate cubic, so downstream emitters
    // only ever have to handle one segment shape.
    const end = { x: tx(xs[1]), y: ty(ys[1]) };
    segments.push({ cp1: { ...start }, cp2: { ...end }, end });
    return { start, segments };
  }

  let p0 = { ...start };
  for (let i = 1; i < count - 1; i++) {
    const qcp = { x: tx(xs[i]), y: ty(ys[i]) };
    const end = {
      x: (tx(xs[i]) + tx(xs[i + 1])) / 2,
      y: (ty(ys[i]) + ty(ys[i + 1])) / 2,
    };
    segments.push(elevateQuadratic(p0, qcp, end));
    p0 = end;
  }

  // Final segment: last midpoint → the actual last point
  const li = count - 1;
  const qcp = { x: tx(xs[li - 1]), y: ty(ys[li - 1]) };
  const end = { x: tx(xs[li]), y: ty(ys[li]) };
  segments.push(elevateQuadratic(p0, qcp, end));

  return { start, segments };
}

/**
 * Elevate a quadratic bezier to a cubic.
 * CP1 = P0 + 2/3*(Qcp - P0), CP2 = Pend + 2/3*(Qcp - Pend)
 */
function elevateQuadratic(p0, qcp, end) {
  return {
    cp1: { x: p0.x + (2 / 3) * (qcp.x - p0.x), y: p0.y + (2 / 3) * (qcp.y - p0.y) },
    cp2: { x: end.x + (2 / 3) * (qcp.x - end.x), y: end.y + (2 / 3) * (qcp.y - end.y) },
    end,
  };
}

/**
 * Flat `[x1 y1 x2 y2 ...]` point list for `/InkList`, in PDF page space.
 *
 * `/InkList` is the machine-readable geometry: viewers that let a user select,
 * move or delete the annotation operate on these points, and pdf-lib's
 * scaleAnnot() rewrites them when a page is scaled. It intentionally holds the
 * raw sampled points, not the bezier control points — the smoothed rendering
 * lives in the appearance stream.
 *
 * @param {Object} stroke
 * @param {(cx: number, cy: number) => {x: number, y: number}} toPdf
 * @returns {number[]}
 */
function buildInkList(stroke, toPdf) {
  const out = [];
  for (let i = 0; i < stroke.x.length; i++) {
    const p = toPdf(stroke.x[i], stroke.y[i]);
    out.push(round(p.x), round(p.y));
  }
  return out;
}

/** Round to 3dp to keep the PDF compact without visible precision loss. */
function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Coordinate passthrough, used when curve building happens before mapping. */
function identity(v) {
  return v;
}

/**
 * Parse a hex color string ("#rrggbb") to normalised components.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/**
 * Resolve a stroke's colour, opacity and line width for PDF output.
 *
 * Shared by both emitters on purpose: the annotation path and the
 * content-stream path must render the same stroke identically, so any drift
 * between two copies of this logic would be a silent visual mismatch between
 * ink on an imported page and ink on an overflow page of the same note.
 *
 * @param {Object} stroke
 * @param {number} scaleX - content px → PDF pt
 * @param {number} scaleY - content px → PDF pt
 * @returns {{ isMarker: boolean, color: {r: number, g: number, b: number},
 *             opacity: number, lineWidth: number }}
 */
export function resolveStrokeStyle(stroke, scaleX, scaleY) {
  const isMarker = stroke.type === "marker";
  // PDF pages are always white regardless of the app's live theme — use the
  // light palette so exported ink stays legible when exporting in dark mode.
  const palette = isMarker ? getMarkerPalette("light") : getThemePalette("light");
  // Clamp both ends. Guarding only the upper bound let a negative colorIndex
  // miss the palette entirely and fall through to the default below, turning a
  // coloured stroke black. The default now only applies to an empty palette.
  const rawIndex = stroke.colorIndex ?? 0;
  const colorIndex = Math.min(Math.max(rawIndex, 0), palette.length - 1);
  const hexColor = palette[colorIndex] ?? "#000000";
  // `?? 2` rather than `|| 2` so an explicit width of 0 stays hairline-thin
  // instead of silently becoming the default width.
  const width = stroke.width ?? 2;

  return {
    isMarker,
    color: hexToRgb(hexColor),
    opacity: isMarker ? MARKER_ALPHA : 1.0,
    lineWidth: width * Math.min(scaleX, scaleY),
  };
}

/**
 * Whether a stroke has any point inside a page's vertical range.
 *
 * @param {Object} stroke
 * @param {number} contentPageY - content Y of the page's top edge
 * @param {number} pageBottom - content Y of the page's bottom edge
 * @returns {boolean}
 */
export function strokeOverlapsPage(stroke, contentPageY, pageBottom) {
  let minY = stroke.y[0];
  let maxY = stroke.y[0];
  for (let k = 1; k < stroke.y.length; k++) {
    if (stroke.y[k] < minY) minY = stroke.y[k];
    if (stroke.y[k] > maxY) maxY = stroke.y[k];
  }
  return maxY >= contentPageY && minY <= pageBottom;
}

/**
 * Build the appearance stream operators for one stroke.
 *
 * Coordinates are absolute PDF page coordinates; the form XObject's /BBox is
 * given in the same space with an identity /Matrix, so no local translation is
 * needed. Line width, cap and join are baked in so the appearance matches the
 * on-canvas rendering regardless of viewer defaults.
 *
 * @param {{start: Object, segments: Array}} path
 * @param {{r: number, g: number, b: number}} color
 * @param {number} lineWidth
 * @param {number} opacity - constant alpha; applied via the GS0 ExtGState
 * @returns {string} content stream operators
 */
function buildAppearanceOperators(path, color, lineWidth, opacity) {
  const ops = [];
  // Select the ExtGState declared in the form's /Resources so marker strokes
  // render translucent. /CA on the annotation dict alone does not affect an
  // explicit appearance stream.
  if (opacity < 1) ops.push("/GS0 gs");
  // Round cap (1) and round join (1) — matches LineCapStyle.Round used by the
  // content-stream path, and keeps chained segments gap-free.
  ops.push(`${round(color.r)} ${round(color.g)} ${round(color.b)} RG`);
  ops.push(`${round(lineWidth)} w`);
  ops.push("1 J");
  ops.push("1 j");
  ops.push(`${round(path.start.x)} ${round(path.start.y)} m`);
  for (const seg of path.segments) {
    ops.push(
      `${round(seg.cp1.x)} ${round(seg.cp1.y)} ${round(seg.cp2.x)} ${round(seg.cp2.y)} ` +
        `${round(seg.end.x)} ${round(seg.end.y)} c`,
    );
  }
  ops.push("S");
  return ops.join("\n");
}

/**
 * Bounding box of a bezier path, padded by half the line width plus a small
 * margin so round caps are never clipped by /Rect or /BBox.
 *
 * Control points are included rather than solving for true curve extrema: a
 * cubic is contained within its control polygon's hull, so this is a safe
 * over-estimate. An over-large box is harmless; a tight one risks clipping.
 */
function computeBounds(path, lineWidth) {
  let minX = path.start.x;
  let maxX = path.start.x;
  let minY = path.start.y;
  let maxY = path.start.y;

  const visit = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };

  for (const seg of path.segments) {
    visit(seg.cp1);
    visit(seg.cp2);
    visit(seg.end);
  }

  const pad = lineWidth / 2 + 1;
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

/**
 * Build the content-space → unrotated-PDF-space point transform for a page.
 *
 * Two coordinate mismatches have to be reconciled:
 *
 * 1. **Y direction.** Content space is Y-down from the page top; PDF space is
 *    Y-up from the page bottom. (drawSvgPath flips internally, but annotation
 *    geometry is absolute, so the flip happens here.)
 *
 * 2. **Page rotation.** `/Rotate` is a *display* instruction: the viewer turns
 *    the page, but annotation `/Rect` and `/InkList` — like all page geometry —
 *    stay in unrotated MediaBox space. Our content coordinates come from
 *    pdf.js `getViewport()`, which has already applied `/Rotate`, so they are in
 *    *displayed* space. On a 90°/270° page the displayed axes are transposed
 *    relative to the MediaBox, which is why un-rotated output lands at right
 *    angles to the ink as drawn.
 *
 * The returned transform maps a displayed-space point onto the MediaBox by
 * inverting the viewer's rotation.
 *
 * @param {Object} p
 * @param {number} p.offsetX - content X of the page's left edge
 * @param {number} p.offsetY - content Y of the page's top edge
 * @param {number} p.scaleX - content px → PDF pt along the displayed X axis
 * @param {number} p.scaleY - content px → PDF pt along the displayed Y axis
 * @param {number} p.dispW - displayed page width in pts
 * @param {number} p.dispH - displayed page height in pts
 * @param {number} p.rotation - page /Rotate in degrees (0/90/180/270)
 * @returns {(cx: number, cy: number) => {x: number, y: number}}
 */
function makePointTransform({
  offsetX,
  offsetY,
  scaleX,
  scaleY,
  dispH,
  rotation,
  boxX,
  boxY,
  boxW,
  boxH,
}) {
  return (cx, cy) => {
    // Displayed-space point, Y-up, origin at the displayed page's bottom-left
    const dx = (cx - offsetX) * scaleX;
    const dy = dispH - (cy - offsetY) * scaleY;

    // Undo the viewer's rotation to land in unrotated page-box space.
    //
    // /Rotate N displays the page rotated N degrees CLOCKWISE. Taking the
    // forward map (box point -> where it appears) and inverting it gives:
    //
    //   90:  forward dx = y, dy = boxW - x   =>  x = boxW - dy, y = dx
    //   180: forward dx = boxW - x, dy = boxH - y  =>  x = boxW - dx, y = boxH - dy
    //   270: forward dx = boxH - y, dy = x   =>  x = dy, y = boxH - dx
    //
    // Note a mapping and its 180-degree opposite both keep every point inside
    // the box, so bounds checks cannot distinguish them — only the corner
    // correspondence can.
    let ux;
    let uy;
    switch (((rotation % 360) + 360) % 360) {
      case 90:
        ux = boxW - dy;
        uy = dx;
        break;
      case 180:
        ux = boxW - dx;
        uy = boxH - dy;
        break;
      case 270:
        ux = dy;
        uy = boxH - dx;
        break;
      default:
        ux = dx;
        uy = dy;
        break;
    }

    // Page boxes need not start at the origin — scanned documents often carry a
    // non-zero MediaBox/CropBox offset. getSize() reports width/height only, so
    // the offset has to be re-applied here or every annotation is translated.
    return { x: ux + boxX, y: uy + boxY };
  };
}

/**
 * Create one `/Ink` annotation (with `/AP`) and attach it to a page.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {import('pdf-lib').PDFPage} pdfPage
 * @param {Object} stroke
 * @param {Object} opts
 * @param {number} opts.offsetX - content X of the page's left edge
 * @param {number} opts.offsetY - content Y of the page's top edge
 * @param {number} opts.scaleX - content px → PDF pt
 * @param {number} opts.scaleY - content px → PDF pt
 * @param {number} opts.dispW - displayed page width in pts
 * @param {number} opts.dispH - displayed page height in pts
 * @param {number} opts.rotation - page /Rotate in degrees
 * @param {Date} [opts.modified] - timestamp recorded on the annotation
 * @returns {boolean} true if an annotation was added
 */
function addInkAnnotation(pdfDoc, pdfPage, stroke, opts) {
  const { scaleX, scaleY, modified } = opts;

  const toPdf = makePointTransform(opts);
  // Build the curve in raw content space, then map every point. The content →
  // PDF mapping is affine (scale, flip, and rotation by a multiple of 90°), so
  // transforming the control points is equivalent to transforming the curve.
  const rawPath = buildBezierSegments(stroke, identity, identity);
  if (!rawPath) return false;

  const mapPoint = (p) => toPdf(p.x, p.y);
  const path = {
    start: mapPoint(rawPath.start),
    segments: rawPath.segments.map((seg) => ({
      cp1: mapPoint(seg.cp1),
      cp2: mapPoint(seg.cp2),
      end: mapPoint(seg.end),
    })),
  };

  const { isMarker, color, opacity, lineWidth } = resolveStrokeStyle(stroke, scaleX, scaleY);

  const bounds = computeBounds(path, lineWidth);
  const rect = [round(bounds.minX), round(bounds.minY), round(bounds.maxX), round(bounds.maxY)];

  const { context } = pdfDoc;

  // Appearance stream. /BBox is in the same absolute page space as the drawing
  // operators, with an identity /Matrix, so the form maps 1:1 onto the page.
  //
  // Built with context.stream() rather than context.formXObject(): the latter
  // expects an array of pdf-lib PDFOperator instances, whereas we emit the
  // operator source directly.
  const apStream = context.stream(buildAppearanceOperators(path, color, lineWidth, opacity), {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: context.obj(rect),
    Matrix: context.obj([1, 0, 0, 1, 0, 0]),
    Resources: context.obj({
      // ExtGState carries the constant alpha for stroking (CA) so the marker's
      // transparency is part of the appearance, not only the annotation dict.
      ExtGState: context.obj({
        GS0: context.obj({ Type: "ExtGState", CA: opacity, ca: opacity }),
      }),
    }),
  });
  const apRef = context.register(apStream);

  const annotDict = {
    Type: "Annot",
    Subtype: "Ink",
    Rect: context.obj(rect),
    InkList: context.obj([context.obj(buildInkList(stroke, toPdf))]),
    C: context.obj([round(color.r), round(color.g), round(color.b)]),
    CA: opacity,
    BS: context.obj({ W: round(lineWidth), S: PDFName.of("S") }),
    F: ANNOT_FLAG_PRINT,
    T: PDFString.of(ANNOT_AUTHOR),
    Contents: PDFString.of(isMarker ? "Highlight" : "Pen stroke"),
    AP: context.obj({ N: apRef }),
  };

  if (modified instanceof Date && !Number.isNaN(modified.getTime())) {
    annotDict.M = PDFString.fromDate(modified);
  }

  const annotRef = context.register(context.obj(annotDict));
  // addAnnot() normalises /Annots, creating it when absent and appending when
  // the source PDF already carries annotations (form fields, existing comments).
  pdfPage.node.addAnnot(annotRef);
  return true;
}

/**
 * Read a page's geometry as the viewer actually displays it.
 *
 * `getSize()` is deliberately not used anywhere that maps content coordinates
 * onto a page: it reports the MediaBox width/height only, discarding both the
 * box origin and `/Rotate`. Content coordinates come from pdf.js
 * `getViewport()`, which applies both, so the two disagree on exactly the
 * documents where it matters — cropped scans and rotated landscape pages.
 *
 * `dispW`/`dispH` are the page as displayed (axes swapped on 90°/270°);
 * `boxX`/`boxY`/`boxW`/`boxH` describe the underlying unrotated box that
 * absolute geometry — annotation `/Rect`, `/InkList` — must be expressed in.
 *
 * @param {import('pdf-lib').PDFPage} pdfPage
 * @returns {{boxX: number, boxY: number, boxW: number, boxH: number,
 *            dispW: number, dispH: number, rotation: number}}
 */
export function getDisplayedPageGeometry(pdfPage) {
  // The CropBox, not getSize(): the CropBox is what viewers display and what
  // pdf.js getViewport() measures, and unlike getSize() it preserves the box
  // origin, which scanned documents often set to something other than (0,0).
  // pdf-lib defaults the CropBox to the MediaBox when a page omits one.
  const box = pdfPage.getCropBox();
  const rotation = ((pdfPage.getRotation().angle % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;

  return {
    boxX: box.x,
    boxY: box.y,
    boxW: box.width,
    boxH: box.height,
    dispW: swapped ? box.height : box.width,
    dispH: swapped ? box.width : box.height,
    rotation,
  };
}

/**
 * Build the `cm` matrix that maps displayed-page space onto unrotated page-box
 * space, for content drawn into a page's content stream.
 *
 * This is the forward counterpart of the inverse mapping makePointTransform()
 * applies to annotation points: content-stream drawing keeps working in
 * displayed coordinates and is transformed by the graphics state, whereas
 * annotation geometry is absolute and must be mapped per point. Both must agree
 * or ink and background land in different places on the same page.
 *
 * Returned as [a, b, c, d, e, f] for pdf-lib's concatTransformationMatrix.
 *
 * @param {{boxX: number, boxY: number, boxW: number, boxH: number, rotation: number}} geom
 * @returns {[number, number, number, number, number, number]}
 */
export function buildPageContentMatrix({ boxX, boxY, boxW, boxH, rotation }) {
  switch (rotation) {
    case 90:
      return [0, 1, -1, 0, boxX + boxW, boxY];
    case 180:
      return [-1, 0, 0, -1, boxX + boxW, boxY + boxH];
    case 270:
      return [0, -1, 1, 0, boxX, boxY + boxH];
    default:
      return [1, 0, 0, 1, boxX, boxY];
  }
}

/**
 * Emit every stroke overlapping a page's Y range as an `/Ink` annotation.
 *
 * Unlike drawStrokesOnPage() in pdfExport.js, this takes no page dimensions:
 * annotation geometry lives in unrotated page-box space, so the box is read
 * from the page itself rather than passed in.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {import('pdf-lib').PDFPage} pdfPage
 * @param {Object[]} strokes - active strokes in content space
 * @param {number} contentPageX - content X of page left edge
 * @param {number} contentPageY - content Y of page top edge
 * @param {number} contentPageW - page width in content space (px)
 * @param {number} contentPageH - page height in content space (px)
 * @param {Date} [modified] - timestamp recorded on each annotation
 * @returns {number} count of annotations added
 */
export function addStrokeAnnotationsOnPage(
  pdfDoc,
  pdfPage,
  strokes,
  contentPageX,
  contentPageY,
  contentPageW,
  contentPageH,
  modified,
) {
  const { boxX, boxY, boxW, boxH, dispW, dispH, rotation } = getDisplayedPageGeometry(pdfPage);

  const scaleX = dispW / contentPageW;
  const scaleY = dispH / contentPageH;
  const pageBottom = contentPageY + contentPageH;

  let added = 0;

  for (const stroke of strokes) {
    if (!stroke.x || stroke.x.length < 2) continue;
    if (!strokeOverlapsPage(stroke, contentPageY, pageBottom)) continue;

    if (
      addInkAnnotation(pdfDoc, pdfPage, stroke, {
        offsetX: contentPageX,
        offsetY: contentPageY,
        scaleX,
        scaleY,
        dispH,
        rotation,
        boxX,
        boxY,
        boxW,
        boxH,
        modified,
      })
    ) {
      added++;
    }
  }

  return added;
}
