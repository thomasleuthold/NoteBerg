import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { A4, colourPdf, colourPng } from "./fixtures/media.js";
import {
  countCanvasPixels,
  createQuickNote,
  drawStroke,
  insertFromMenu,
  openNote,
  readKeys,
  readQuickNotes,
  reloadApp,
  scrollNote,
} from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

// Real pdf.js (WASM), real image decoding and the real canvas: the parts unit
// tests replace with mocks. Pages and images are flat colours (fixtures/media.js),
// so "this page is on screen" is a pixel count, not a screenshot comparison.

const RED = [220, 40, 40];
const GREEN = [40, 170, 70];
const BLUE = [40, 80, 220];
const MAGENTA = [200, 30, 160];

/** A visible share of the canvas, not a few anti-aliased edge pixels. */
const ON_SCREEN = 5000;

/** The note's media items as stored, once every pending placeholder has resolved. */
async function storedMedia(page) {
  const [note] = await readQuickNotes(page);
  return note?.media ?? [];
}

test("an inserted image is stored, drawn, and still there after a restart", async ({ page }) => {
  await createQuickNote(page, "Photo");
  await insertFromMenu(page, "insert-image", await colourPng(page, MAGENTA));

  await expect
    .poll(async () => (await storedMedia(page)).filter((m) => m.type === "image" && !m.pending))
    .toHaveLength(1);
  const [image] = await storedMedia(page);
  expect(await readKeys(page, "files")).toContain(image.fileId);
  await expect.poll(() => countCanvasPixels(page, MAGENTA)).toBeGreaterThan(ON_SCREEN);

  await reloadApp(page);
  await openNote(page, "Photo");
  await expect.poll(() => countCanvasPixels(page, MAGENTA)).toBeGreaterThan(ON_SCREEN);
});

test("every page of an imported PDF renders, and an annotation on the last page persists", async ({
  page,
}) => {
  await createQuickNote(page, "Paper");
  await insertFromMenu(page, "insert-pdf", await colourPdf([RED, GREEN, BLUE]));

  await expect
    .poll(async () => (await storedMedia(page)).filter((m) => m.type === "pdf-page"))
    .toHaveLength(3);
  const pages = (await storedMedia(page)).filter((m) => m.type === "pdf-page");
  expect(pages.map((p) => p.pageIndex)).toEqual([1, 2, 3]);
  expect(await readKeys(page, "files")).toContain(pages[0].fileId);

  // Scroll down until each page's colour has filled the canvas at least once.
  const seen = new Set();
  await expect
    .poll(
      async () => {
        for (const [name, colour] of Object.entries({ RED, GREEN, BLUE })) {
          if ((await countCanvasPixels(page, colour)) > ON_SCREEN) seen.add(name);
        }
        if (!seen.has("BLUE")) await scrollNote(page, 400);
        return [...seen].sort();
      },
      { intervals: [250], timeout: 30_000 },
    )
    .toEqual(["BLUE", "GREEN", "RED"]);

  // Scroll on until the last page fills the screen, then annotate it.
  await expect
    .poll(
      async () => {
        const blue = await countCanvasPixels(page, BLUE);
        const others =
          (await countCanvasPixels(page, GREEN)) + (await countCanvasPixels(page, RED));
        if (others > 0) await scrollNote(page, 300);
        return others === 0 && blue > ON_SCREEN;
      },
      { intervals: [250], timeout: 30_000 },
    )
    .toBe(true);
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.3, 0.3],
    [0.6, 0.35],
  ]);
  await expect.poll(async () => (await readQuickNotes(page))[0]?.strokes?.length ?? 0).toBe(1);
  const [{ strokes }] = await readQuickNotes(page);
  const last = pages[2];
  const strokeY = strokes[0].y[0];
  expect(strokeY).toBeGreaterThan(last.y);
  expect(strokeY).toBeLessThan(last.y + last.height);

  await reloadApp(page);
  await openNote(page, "Paper");
  const [reopened] = await readQuickNotes(page);
  expect(reopened.strokes).toHaveLength(1);
  expect(reopened.media.filter((m) => m.type === "pdf-page")).toHaveLength(3);
  await expect.poll(() => countCanvasPixels(page, RED)).toBeGreaterThan(ON_SCREEN);
});

test("Export PDF hands a valid A4 PDF with the note's content to the native save", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__tauriHandlers.save_pdf = (args) => {
      window.__savedPdf = args;
      return "C:/e2e/Export.pdf";
    };
  });

  await createQuickNote(page, "Export");
  await page.click("#nc-tool-options");
  await page.locator(".background-option").nth(2).click(); // a ruled background
  await page.keyboard.press("Escape");
  await insertFromMenu(page, "insert-image", await colourPng(page, MAGENTA));
  await expect
    .poll(async () => (await storedMedia(page)).filter((m) => m.type === "image" && !m.pending))
    .toHaveLength(1);
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.2, 0.2],
    [0.6, 0.3],
  ]);
  await expect.poll(async () => (await readQuickNotes(page))[0]?.strokes?.length ?? 0).toBe(1);

  await page.click("#nc-tool-options");
  await page.click("#nc-export-pdf-btn");
  await expect
    .poll(() => page.evaluate(() => window.__savedPdf?.suggestedName ?? null), { timeout: 30_000 })
    .toBe("Export.pdf");

  const bytes = Uint8Array.from(await page.evaluate(() => window.__savedPdf.bytes));
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  const first = pdf.getPage(0);
  expect(first.getWidth()).toBeCloseTo(A4.width, 0);
  expect(first.getHeight()).toBeCloseTo(A4.height, 0);

  // The inserted image is embedded, not dropped.
  const xObjects = first.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
  expect(xObjects?.keys().length ?? 0).toBeGreaterThan(0);
});
