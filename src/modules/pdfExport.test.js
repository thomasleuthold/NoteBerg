/**
 * src/modules/pdfExport.test.js
 * Unit tests for pdfExport.js.
 *
 * Heavy DOM-dependent paths (html2canvas, iframe) are mocked; pdf-lib is used
 * for real so we can assert on the resulting document structure.
 */

import { inflateSync } from "node:zlib";
import { degrees, PDFDocument, PDFName } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMarkerPalette, getThemePalette } from "../utils/noteRenderer.js";
import { downloadPdfBytes, exportNoteToPdf } from "./pdfExport.js";
import { hexToRgb, resolveStrokeStyle, strokeOverlapsPage } from "./pdfInkAnnotations.js";

// ── Mock html2canvas ──────────────────────────────────────────────────────────
// Returns a fake canvas-like object. jsdom's canvas.getContext("2d") returns
// null, so we build a minimal stub that satisfies the drawTextSliceOnPage path.

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeFakeCanvas(width = 1200, height = 200) {
  const fakeCtx = { drawImage: vi.fn() };
  return {
    width,
    height,
    getContext: () => fakeCtx,
    toDataURL: () => `data:image/png;base64,${TINY_PNG_B64}`,
  };
}

vi.mock("html2canvas", () => ({
  default: vi.fn(async () => makeFakeCanvas()),
}));

// ── Mock storage.getFile ──────────────────────────────────────────────────────
vi.mock("./storage.js", () => ({
  getFile: vi.fn(() => Promise.resolve(null)),
}));

// ── Mock @tauri-apps/api/core (invoke) ────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNote(overrides = {}) {
  return {
    id: "note-1",
    title: "Test note",
    strokes: [],
    media: [],
    pdfSource: null,
    background: "none",
    content: null,
    modified: Date.now(),
    ...overrides,
  };
}

function makeStroke(xs, ys, overrides = {}) {
  return {
    id: "s1",
    type: "pen",
    colorIndex: 0,
    width: 2,
    x: xs,
    y: ys,
    pressure: xs.map(() => 0.5),
    ...overrides,
  };
}

// ── exportNoteToPdf ───────────────────────────────────────────────────────────

describe("exportNoteToPdf", () => {
  let createElementSpy;

  beforeEach(() => {
    // jsdom's canvas.getContext("2d") returns null — patch createElement so that
    // every canvas element we create during export has a working stub context.
    const origCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag, ...args) => {
      if (tag === "canvas") return makeFakeCanvas();
      return origCreate(tag, ...args);
    });
  });

  afterEach(() => {
    createElementSpy?.mockRestore();
  });

  it("returns a non-empty Uint8Array for a blank note", async () => {
    const bytes = await exportNoteToPdf(makeNote(), []);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("creates a single A4 page for an empty note", async () => {
    const bytes = await exportNoteToPdf(makeNote(), []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("calls onProgress for each page", async () => {
    const progress = vi.fn();
    await exportNoteToPdf(makeNote(), [], progress);
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it("filters out deleted strokes", async () => {
    const note = makeNote({
      strokes: [
        makeStroke([10, 20], [100, 200], { _deleted: true }),
        makeStroke([30, 40], [300, 400]),
      ],
    });

    // Should not throw; deleted strokes are silently excluded
    const bytes = await exportNoteToPdf(note, []);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("creates multiple pages when strokes extend beyond one page", async () => {
    // A4 content height ≈ 1697 px (841.89 / (595.28/1200))
    // Put a stroke at Y=5000 → forces a second page
    const note = makeNote({
      strokes: [makeStroke([10, 20], [5000, 5100])],
    });

    const bytes = await exportNoteToPdf(note, []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("sets document title from note.title", async () => {
    const bytes = await exportNoteToPdf(makeNote({ title: "My Journal" }), []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("My Journal");
  });

  it("embeds text content when note.content is provided", async () => {
    const note = makeNote({ content: "<p>Hello world</p>" });
    // html2canvas mock returns a canvas, so the text slice path runs
    const bytes = await exportNoteToPdf(note, []);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("handles note with pdf-page media items (Case A)", async () => {
    const { getFile } = await import("./storage.js");

    // Create a minimal valid PDF to serve as the source
    const srcDoc = await PDFDocument.create();
    srcDoc.addPage([595, 841]);
    const srcBytes = await srcDoc.save();

    // jsdom Blob may lack arrayBuffer(); provide a plain object with it
    getFile.mockResolvedValue({ arrayBuffer: () => Promise.resolve(srcBytes.buffer) });

    const pdfPageItem = {
      type: "pdf-page",
      fileId: "pdf-source",
      pageIndex: 0,
      x: 0,
      y: 0,
      width: 1200,
      height: 1697,
    };

    const note = makeNote({ pdfSource: "pdf-source" });
    const bytes = await exportNoteToPdf(note, [pdfPageItem]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("appends extra pages when strokes overflow the last PDF page (Case A)", async () => {
    const { getFile } = await import("./storage.js");

    const srcDoc = await PDFDocument.create();
    srcDoc.addPage([595, 841]);
    const srcBytes = await srcDoc.save();

    getFile.mockResolvedValue({ arrayBuffer: () => Promise.resolve(srcBytes.buffer) });

    const pdfPageItem = {
      type: "pdf-page",
      fileId: "pdf-source",
      pageIndex: 0,
      x: 0,
      y: 0,
      width: 1200,
      height: 1697,
    };

    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([10, 20], [5000, 5100])],
    });

    const bytes = await exportNoteToPdf(note, [pdfPageItem]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

// ── Ink annotations (Case A only) ────────────────────────────────────────────

describe("stroke output mode", () => {
  let createElementSpy;

  beforeEach(() => {
    const origCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag, ...args) => {
      if (tag === "canvas") return makeFakeCanvas();
      return origCreate(tag, ...args);
    });
  });

  afterEach(() => {
    createElementSpy?.mockRestore();
  });

  /** Build a single-page source PDF and point getFile() at it. */
  async function mockSourcePdf(configure) {
    const { getFile } = await import("./storage.js");
    const srcDoc = await PDFDocument.create();
    const page = srcDoc.addPage([595, 841]);
    configure?.(srcDoc, page);
    const srcBytes = await srcDoc.save();
    getFile.mockResolvedValue({ arrayBuffer: () => Promise.resolve(srcBytes.buffer) });
  }

  const pdfPageItem = {
    type: "pdf-page",
    fileId: "pdf-source",
    pageIndex: 0,
    x: 0,
    y: 0,
    width: 1200,
    height: 1697,
  };

  /** Read the /Annots array of a page as plain dictionaries. */
  function getAnnots(doc, pageIndex) {
    const annots = doc.getPage(pageIndex).node.Annots();
    if (!annots) return [];
    const out = [];
    for (let i = 0; i < annots.size(); i++) {
      out.push(annots.lookup(i));
    }
    return out;
  }

  it("emits strokes on an imported PDF page as /Ink annotations", async () => {
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200, 300], [100, 150, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const annots = getAnnots(doc, 0);

    expect(annots).toHaveLength(1);
    expect(annots[0].lookup(PDFName.of("Subtype")).asString()).toBe("/Ink");
  });

  it("gives each annotation an /AP appearance stream", async () => {
    // Without /AP, Chrome's viewer and macOS Preview render nothing at all.
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200, 300], [100, 150, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const ap = getAnnots(doc, 0)[0].lookup(PDFName.of("AP"));

    expect(ap).toBeDefined();
    expect(ap.get(PDFName.of("N"))).toBeDefined();
  });

  it("records /InkList geometry with one point pair per sampled point", async () => {
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200, 300], [100, 150, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const inkList = getAnnots(doc, 0)[0].lookup(PDFName.of("InkList"));

    expect(inkList.size()).toBe(1);
    // 3 points → 6 numbers
    expect(inkList.lookup(0).size()).toBe(6);
  });

  it("flips stroke Y into PDF space (Y-up) rather than copying content Y", async () => {
    // Content Y=100 near the page top must land near the PDF page top (y≈841),
    // not near y=100. A missing flip is otherwise invisible in structural tests.
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [100, 100])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const points = getAnnots(doc, 0)[0].lookup(PDFName.of("InkList")).lookup(0);
    const firstY = points.lookup(1).asNumber();

    // scaleY = 841/1697 ≈ 0.4956 → y ≈ 841 - 49.6 ≈ 791
    expect(firstY).toBeGreaterThan(700);
  });

  it("marks marker strokes with constant alpha and pen strokes as opaque", async () => {
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [
        makeStroke([100, 200], [100, 120], { id: "pen", type: "pen" }),
        makeStroke([100, 200], [300, 320], { id: "mark", type: "marker" }),
      ],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const alphas = getAnnots(doc, 0).map((a) => a.lookup(PDFName.of("CA")).asNumber());

    expect(alphas).toContain(1);
    expect(alphas.some((a) => a > 0 && a < 1)).toBe(true);
  });

  it("sets the Print flag so annotations survive printing", async () => {
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [100, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const flags = getAnnots(doc, 0)[0].lookup(PDFName.of("F")).asNumber();

    // Bit 3 (value 4) = Print
    expect(flags & 4).toBe(4);
  });

  it("appends to /Annots when the source PDF already has annotations", async () => {
    // Real-world imported PDFs often arrive with form fields or existing
    // comments; ours must not replace them.
    await mockSourcePdf((srcDoc, page) => {
      const existing = srcDoc.context.register(
        srcDoc.context.obj({
          Type: "Annot",
          Subtype: "Square",
          Rect: srcDoc.context.obj([10, 10, 50, 50]),
          F: 4,
        }),
      );
      page.node.addAnnot(existing);
    });

    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [100, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const subtypes = getAnnots(doc, 0).map((a) => a.lookup(PDFName.of("Subtype")).asString());

    expect(subtypes).toContain("/Square");
    expect(subtypes).toContain("/Ink");
  });

  it("does NOT create annotations for a plain note without an imported PDF", async () => {
    // Case B: the ink is the document, not a comment on it.
    const note = makeNote({ strokes: [makeStroke([100, 200, 300], [100, 150, 120])] });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, []));

    expect(getAnnots(doc, 0)).toHaveLength(0);
  });

  it("does NOT annotate overflow pages appended past the imported PDF", async () => {
    // Overflow pages are blank NoteBerg pages — nothing there to annotate.
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [
        makeStroke([100, 200], [100, 120], { id: "on-pdf" }),
        makeStroke([100, 200], [5000, 5100], { id: "overflow" }),
      ],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));

    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(getAnnots(doc, 0)).toHaveLength(1);
    expect(getAnnots(doc, 1)).toHaveLength(0);
  });

  it("skips strokes that do not overlap the page's Y range", async () => {
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [100, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    expect(getAnnots(doc, 0)).toHaveLength(1);

    // Same stroke moved well below the page bottom (content height 1697)
    const offPage = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [100, 120])],
    });
    offPage.strokes[0].y = [1_000_000, 1_000_020];

    const doc2 = await PDFDocument.load(await exportNoteToPdf(offPage, [pdfPageItem]));
    expect(getAnnots(doc2, 0)).toHaveLength(0);
  });

  /**
   * Export a single tiny stroke placed at a known corner of the *displayed*
   * page, and return where its first point landed in MediaBox space.
   *
   * `frac` is a fractional position within the displayed page: {fx, fy} with
   * fx/fy in 0..1 measured from the displayed top-left, Y-down (content space).
   */
  async function annotPointForDisplayedFraction(angle, frac) {
    await mockSourcePdf((_doc, page) => page.setRotation(degrees(angle)));

    // MediaBox is always 595x841; /Rotate 90|270 makes the displayed page 841x595.
    const swapped = angle === 90 || angle === 270;
    const dispW = swapped ? 841 : 595;
    const dispH = swapped ? 595 : 841;

    const contentW = 1200;
    const contentH = contentW * (dispH / dispW);
    const item = { ...pdfPageItem, width: contentW, height: contentH };

    const cx = frac.fx * contentW;
    const cy = frac.fy * contentH;
    // Two nearly-coincident points: enough for a valid stroke, small enough
    // that the first point is effectively the location under test.
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([cx, cx + 1], [cy, cy + 1])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [item]));
    const pts = getAnnots(doc, 0)[0].lookup(PDFName.of("InkList")).lookup(0);
    return { x: pts.lookup(0).asNumber(), y: pts.lookup(1).asNumber() };
  }

  // MediaBox corners in PDF space (Y-up), for a 595x841 page.
  const MEDIA_CORNERS = {
    bottomLeft: { x: 0, y: 0 },
    bottomRight: { x: 595, y: 0 },
    topLeft: { x: 0, y: 841 },
    topRight: { x: 595, y: 841 },
  };

  // Which MediaBox corner the DISPLAYED top-left maps back to, per /Rotate.
  //
  // Derived by inverting the forward map — /Rotate N displays the page rotated
  // N degrees clockwise, so a MediaBox point (x,y) appears at:
  //   90:  (y, mw - x)      180: (mw - x, mh - y)      270: (mh - y, x)
  // Solving each for the corner that lands on displayed (0, dispH) gives the
  // table below.
  //
  // These corner identities are what distinguish the correct mapping from its
  // 180-degree opposite — a bounds check cannot, since both keep every point
  // inside the box.
  const displayedTopLeftLandsAt = {
    0: "topLeft",
    90: "bottomLeft",
    180: "bottomRight",
    270: "topRight",
  };

  for (const angle of [0, 90, 180, 270]) {
    it(`anchors the displayed top-left corner correctly at /Rotate ${angle}`, async () => {
      // Near the displayed top-left, but inset so the result is unambiguous.
      const got = await annotPointForDisplayedFraction(angle, { fx: 0.02, fy: 0.02 });
      const expected = MEDIA_CORNERS[displayedTopLeftLandsAt[angle]];

      // Within ~12% of the page diagonal of the expected corner.
      expect(Math.abs(got.x - expected.x)).toBeLessThan(120);
      expect(Math.abs(got.y - expected.y)).toBeLessThan(160);
    });
  }

  it("keeps a displayed-horizontal stroke horizontal on an unrotated page", async () => {
    // Control case: with /Rotate 0 the displayed and MediaBox axes agree.
    const a = await annotPointForDisplayedFraction(0, { fx: 0.1, fy: 0.5 });
    const b = await annotPointForDisplayedFraction(0, { fx: 0.8, fy: 0.5 });

    expect(Math.abs(a.y - b.y)).toBeLessThan(5);
    expect(b.x - a.x).toBeGreaterThan(100);
  });

  it("turns a displayed-horizontal stroke into a MediaBox-vertical one at /Rotate 90", async () => {
    // The reported bug: a highlight drawn horizontally across a landscape page.
    // Under /Rotate 90 it must become vertical in MediaBox space, and must run
    // in the direction that maps back to left-to-right on screen.
    const left = await annotPointForDisplayedFraction(90, { fx: 0.1, fy: 0.5 });
    const right = await annotPointForDisplayedFraction(90, { fx: 0.8, fy: 0.5 });

    // Vertical in MediaBox space: X barely moves, Y spans a large distance.
    expect(Math.abs(left.x - right.x)).toBeLessThan(5);
    expect(Math.abs(left.y - right.y)).toBeGreaterThan(300);

    // Direction check — this is the assertion that catches a 180-degree flip.
    // Displayed left-to-right maps to increasing MediaBox Y under /Rotate 90.
    expect(right.y).toBeGreaterThan(left.y);
  });

  it("offsets annotations by a non-zero page box origin", async () => {
    // Scanned PDFs often carry a MediaBox/CropBox that does not start at (0,0).
    // getSize() reports width/height only, so without re-applying the origin
    // every annotation is translated by the offset.
    const OX = 20;
    const OY = 30;
    await mockSourcePdf((_doc, page) => {
      page.setMediaBox(OX, OY, 595, 841);
      page.setCropBox(OX, OY, 595, 841);
    });

    const item = { ...pdfPageItem, width: 1200, height: 1200 * (841 / 595) };
    // Stroke at the very top-left of the displayed page
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([0, 1], [0, 1])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [item]));
    const pts = getAnnots(doc, 0)[0].lookup(PDFName.of("InkList")).lookup(0);
    const x = pts.lookup(0).asNumber();
    const y = pts.lookup(1).asNumber();

    // Displayed top-left on an unrotated page = box top-left = (OX, OY + 841)
    expect(Math.abs(x - OX)).toBeLessThan(2);
    expect(Math.abs(y - (OY + 841))).toBeLessThan(2);
  });

  it("keeps annotations inside the MediaBox for every /Rotate value", async () => {
    for (const angle of [0, 90, 180, 270]) {
      const got = await annotPointForDisplayedFraction(angle, { fx: 0.35, fy: 0.6 });
      expect(got.x, `x within MediaBox at /Rotate ${angle}`).toBeGreaterThanOrEqual(-1);
      expect(got.x, `x within MediaBox at /Rotate ${angle}`).toBeLessThanOrEqual(596);
      expect(got.y, `y within MediaBox at /Rotate ${angle}`).toBeGreaterThanOrEqual(-1);
      expect(got.y, `y within MediaBox at /Rotate ${angle}`).toBeLessThanOrEqual(842);
    }
  });

  it("carries marker transparency in the appearance stream's ExtGState", async () => {
    // /CA on the annotation dict does not affect an explicit appearance
    // stream — without GS0 in the form's /Resources a marker prints opaque,
    // covering the text it was meant to highlight.
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [100, 120], { type: "marker" })],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const form = getAnnots(doc, 0)[0].lookup(PDFName.of("AP")).lookup(PDFName.of("N"));
    const gs = form.dict
      .lookup(PDFName.of("Resources"))
      .lookup(PDFName.of("ExtGState"))
      .lookup(PDFName.of("GS0"));

    const ca = gs.lookup(PDFName.of("CA")).asNumber();
    expect(ca).toBeGreaterThan(0);
    expect(ca).toBeLessThan(1);
    // Stroking alpha is what matters for ink, but both are set so a viewer
    // that fills the path also honours the transparency.
    expect(gs.lookup(PDFName.of("ca")).asNumber()).toBe(ca);
  });

  it("uses the same colour and width as the content-stream emitter", async () => {
    // The two emitters must agree: a note whose ink spans an imported page and
    // an overflow page would otherwise change appearance mid-document.
    await mockSourcePdf();
    const stroke = makeStroke([100, 200], [100, 120], { colorIndex: 2, width: 5 });
    const note = makeNote({ pdfSource: "pdf-source", strokes: [stroke] });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    const annot = getAnnots(doc, 0)[0];

    // scaleX/scaleY the exporter derives for this page (595x841 over 1200x1697).
    const expected = resolveStrokeStyle(stroke, 595 / 1200, 841 / 1697);

    const c = annot.lookup(PDFName.of("C"));
    expect(c.lookup(0).asNumber()).toBeCloseTo(expected.color.r, 2);
    expect(c.lookup(1).asNumber()).toBeCloseTo(expected.color.g, 2);
    expect(c.lookup(2).asNumber()).toBeCloseTo(expected.color.b, 2);

    const bs = annot.lookup(PDFName.of("BS")).lookup(PDFName.of("W")).asNumber();
    expect(bs).toBeCloseTo(expected.lineWidth, 2);
  });

  it("excludes deleted strokes from annotations", async () => {
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [
        makeStroke([100, 200], [100, 120], { id: "gone", _deleted: true }),
        makeStroke([100, 200], [300, 320], { id: "kept" }),
      ],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [pdfPageItem]));
    expect(getAnnots(doc, 0)).toHaveLength(1);
  });
});

// ── Shared stroke styling ────────────────────────────────────────────────────
//
// resolveStrokeStyle() is the single source of truth for both emitters. These
// tests exercise it directly for the edge cases, then assert that both output
// paths actually agree — the property that makes sharing it worthwhile.

describe("resolveStrokeStyle", () => {
  const penPalette = getThemePalette("light");
  const markerPalette = getMarkerPalette("light");

  it("uses the light palette regardless of the active theme", () => {
    // Exported pages are always white, so dark-theme ink would be illegible.
    const { color } = resolveStrokeStyle({ type: "pen", colorIndex: 0 }, 1, 1);
    expect(color).toEqual(hexToRgb(penPalette[0]));
  });

  it("keeps an explicit width of 0 instead of substituting the default", () => {
    // `|| 2` treated 0 as missing and silently drew a 2pt line.
    const { lineWidth } = resolveStrokeStyle({ type: "pen", width: 0 }, 1, 1);
    expect(lineWidth).toBe(0);
  });

  it("defaults width only when it is actually absent", () => {
    expect(resolveStrokeStyle({ type: "pen" }, 1, 1).lineWidth).toBe(2);
    expect(resolveStrokeStyle({ type: "pen", width: undefined }, 1, 1).lineWidth).toBe(2);
  });

  it("scales line width by the smaller axis scale", () => {
    expect(resolveStrokeStyle({ type: "pen", width: 4 }, 0.5, 2).lineWidth).toBe(2);
  });

  it("clamps a negative colorIndex to the first palette entry", () => {
    // Math.min() alone let a negative index miss the palette and fall through
    // to the "#000000" default, silently losing the stroke's colour.
    //
    // Deliberately a marker: the pen palette starts at #000000, so on a pen the
    // bug and the fix produce the same black and the test could not fail.
    const { color } = resolveStrokeStyle({ type: "marker", colorIndex: -5 }, 1, 1);
    expect(color).toEqual(hexToRgb(markerPalette[0]));
    expect(color).not.toEqual(hexToRgb("#000000"));
  });

  it("clamps an out-of-range colorIndex to the last palette entry", () => {
    const { color } = resolveStrokeStyle({ type: "pen", colorIndex: 999 }, 1, 1);
    expect(color).toEqual(hexToRgb(penPalette[penPalette.length - 1]));
  });

  it("gives markers the marker palette and partial alpha", () => {
    const marker = resolveStrokeStyle({ type: "marker", colorIndex: 0 }, 1, 1);
    expect(marker.isMarker).toBe(true);
    expect(marker.color).toEqual(hexToRgb(markerPalette[0]));
    expect(marker.opacity).toBeGreaterThan(0);
    expect(marker.opacity).toBeLessThan(1);
  });

  it("gives pens full opacity", () => {
    expect(resolveStrokeStyle({ type: "pen", colorIndex: 0 }, 1, 1).opacity).toBe(1);
  });
});

describe("strokeOverlapsPage", () => {
  const stroke = { y: [100, 200] };

  it("accepts a stroke fully inside the page", () => {
    expect(strokeOverlapsPage(stroke, 0, 500)).toBe(true);
  });

  it("accepts a stroke straddling the page boundary", () => {
    expect(strokeOverlapsPage(stroke, 150, 500)).toBe(true);
  });

  it("rejects a stroke entirely above or below the page", () => {
    expect(strokeOverlapsPage(stroke, 300, 500)).toBe(false);
    expect(strokeOverlapsPage(stroke, 0, 50)).toBe(false);
  });

  it("treats a stroke touching the page edge as overlapping", () => {
    // Boundary behaviour matches the original inline test it replaced; a
    // stroke exactly on the seam must appear rather than vanish.
    expect(strokeOverlapsPage(stroke, 200, 400)).toBe(true);
    expect(strokeOverlapsPage(stroke, 0, 100)).toBe(true);
  });

  it("handles unordered points, not just monotonic ones", () => {
    // Real strokes double back; min/max must scan every point.
    expect(strokeOverlapsPage({ y: [400, 50, 380] }, 0, 100)).toBe(true);
  });
});

// ── Page geometry: content stream vs annotations ─────────────────────────────
//
// Ink is written as annotations (absolute page-box coordinates, mapped per
// point) while background/text/images are written into the content stream
// (displayed coordinates, mapped by a cm). The two use different mechanisms and
// must still agree — asserting either layer alone cannot catch them drifting
// apart, which is exactly how rotated/cropped pages were misaligned before.

describe("page geometry", () => {
  let createElementSpy;

  beforeEach(() => {
    const origCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag, ...args) => {
      if (tag === "canvas") return makeFakeCanvas();
      return origCreate(tag, ...args);
    });
  });

  afterEach(() => {
    createElementSpy?.mockRestore();
  });

  async function mockSourcePdf(configure) {
    const { getFile } = await import("./storage.js");
    const srcDoc = await PDFDocument.create();
    const page = srcDoc.addPage([595, 841]);
    configure?.(srcDoc, page);
    const srcBytes = await srcDoc.save();
    getFile.mockResolvedValue({ arrayBuffer: () => Promise.resolve(srcBytes.buffer) });
  }

  /** Decompress a page's content stream to inspect its operators. */
  function contentStreamText(page) {
    let raw = page.node.Contents();
    if (raw.constructor.name === "PDFArray") raw = raw.lookup(0);
    const buf = Buffer.from(raw.getContents());
    try {
      return inflateSync(buf).toString("latin1");
    } catch {
      return buf.toString("latin1");
    }
  }

  /** A pdf-page media item sized to the given displayed aspect ratio. */
  function itemForDisplayed(dispW, dispH) {
    const width = 1200;
    return {
      type: "pdf-page",
      fileId: "pdf-source",
      pageIndex: 0,
      x: 0,
      y: 0,
      width,
      height: width * (dispH / dispW),
    };
  }

  // The cm that maps displayed space onto the page box, per /Rotate. Derived by
  // inverting the same forward map the annotation transform uses, so a change to
  // one that is not mirrored in the other fails here.
  const EXPECTED_CM = {
    0: "1 0 0 1 0 0 cm",
    90: "0 1 -1 0 595 0 cm",
    180: "-1 0 0 -1 595 841 cm",
    270: "0 -1 1 0 0 841 cm",
  };

  for (const angle of [0, 90, 180, 270]) {
    it(`maps content-stream drawing into page-box space at /Rotate ${angle}`, async () => {
      await mockSourcePdf((_d, page) => page.setRotation(degrees(angle)));
      const swapped = angle === 90 || angle === 270;
      const item = itemForDisplayed(swapped ? 841 : 595, swapped ? 595 : 841);

      const note = makeNote({
        pdfSource: "pdf-source",
        background: "grid-medium",
        strokes: [makeStroke([100, 200], [10, 20])],
      });

      const doc = await PDFDocument.load(await exportNoteToPdf(note, [item]));
      const text = contentStreamText(doc.getPage(0));

      expect(text).toContain(EXPECTED_CM[angle]);
    });
  }

  it("leaves the graphics state balanced so page content is not corrupted", async () => {
    // An unbalanced q/Q would leak the transform into anything drawn later and
    // is the classic failure mode of hand-emitted operators.
    await mockSourcePdf((_d, page) => page.setRotation(degrees(90)));
    const note = makeNote({
      pdfSource: "pdf-source",
      background: "grid-medium",
      content: "<p>text</p>",
      strokes: [makeStroke([100, 200], [10, 20])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [itemForDisplayed(841, 595)]));
    const text = contentStreamText(doc.getPage(0));

    const pushes = (text.match(/^q$/gm) || []).length;
    const pops = (text.match(/^Q$/gm) || []).length;
    expect(pushes).toBeGreaterThan(0);
    expect(pops).toBe(pushes);
  });

  it("anchors both layers to the CropBox origin, not the MediaBox", async () => {
    // A CropBox inset inside the MediaBox: viewers show only the crop, and
    // pdf.js getViewport() measures it, so both layers must offset by its
    // origin. getSize() reports 595x841 and would put them 50pt apart.
    await mockSourcePdf((_d, page) => {
      page.setMediaBox(0, 0, 595, 841);
      page.setCropBox(50, 50, 400, 700);
    });

    const note = makeNote({
      pdfSource: "pdf-source",
      background: "ruled-medium",
      strokes: [makeStroke([0, 10], [0, 10])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [itemForDisplayed(400, 700)]));
    const page = doc.getPage(0);

    // Content stream is translated to the crop origin.
    expect(contentStreamText(page)).toContain("1 0 0 1 50 50 cm");

    // Ink at content (0,0) lands at the crop's top-left = (50, 50 + 700).
    const rect = page.node.Annots().lookup(0).lookup(PDFName.of("Rect"));
    const midX = (rect.lookup(0).asNumber() + rect.lookup(2).asNumber()) / 2;
    const midY = (rect.lookup(1).asNumber() + rect.lookup(3).asNumber()) / 2;
    expect(Math.abs(midX - 50)).toBeLessThan(5);
    expect(Math.abs(midY - 750)).toBeLessThan(5);
  });

  it("sizes overflow pages to match the last page as displayed", async () => {
    // A /Rotate 90 landscape source previously produced portrait overflow
    // pages with no rotation, squashing their ink to the wrong aspect.
    await mockSourcePdf((_d, page) => page.setRotation(degrees(90)));

    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([100, 200], [5000, 5010])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [itemForDisplayed(841, 595)]));
    expect(doc.getPageCount()).toBeGreaterThan(1);

    // Page 0 displays 841x595 (595x841 rotated); overflow must match.
    const overflow = doc.getPage(1).getSize();
    expect(Math.round(overflow.width)).toBe(841);
    expect(Math.round(overflow.height)).toBe(595);
  });

  it("does not transform pages of an unrotated, origin-anchored PDF", async () => {
    // The common case must stay a plain identity translate — this guards
    // against the fix quietly changing output for ordinary documents.
    await mockSourcePdf();
    const note = makeNote({
      pdfSource: "pdf-source",
      background: "ruled-medium",
      strokes: [makeStroke([100, 200], [100, 120])],
    });

    const doc = await PDFDocument.load(await exportNoteToPdf(note, [itemForDisplayed(595, 841)]));
    expect(contentStreamText(doc.getPage(0))).toContain("1 0 0 1 0 0 cm");
  });
});

// ── downloadPdfBytes ─────────────────────────────────────────────────────────

describe("downloadPdfBytes", () => {
  const fakeBytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"

  beforeEach(() => {
    // Reset Tauri globals
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers a browser download (anchor click) when not in Tauri", async () => {
    const createObjectURL = vi.fn(() => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window, "URL", {
      value: { createObjectURL, revokeObjectURL },
      writable: true,
      configurable: true,
    });

    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation(() => {});
    const removeSpy = vi.spyOn(document.body, "removeChild").mockImplementation(() => {});
    const clickSpy = vi.fn();

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === "a") el.click = clickSpy;
      return el;
    });

    await downloadPdfBytes(fakeBytes, "test.pdf");

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");

    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("calls Tauri invoke('save_pdf') on desktop Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};

    const { invoke } = await import("@tauri-apps/api/core");
    invoke.mockResolvedValue(undefined);

    await downloadPdfBytes(fakeBytes, "note.pdf");

    expect(invoke).toHaveBeenCalledWith("save_pdf", {
      bytes: Array.from(fakeBytes),
      suggestedName: "note.pdf",
    });
  });
});
