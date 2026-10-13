import { bootApp } from "./support/fixtures.js";
import { createQuickNote, drawStroke, openNote, readQuickNotes } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

/** The first stroke of the only quick note, as stored. */
async function storedStroke(page) {
  const [note] = await readQuickNotes(page);
  return note?.strokes?.[0] ?? null;
}

test("a lasso-moved stroke is stored moved, and undo/redo replay the move", async ({ page }) => {
  await createQuickNote(page, "Lasso");
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.3, 0.3],
    [0.4, 0.35],
  ]);
  await expect.poll(() => storedStroke(page)).not.toBeNull();
  const originalX = (await storedStroke(page)).x[0];

  // Lasso around the stroke, then drag the selection to the right.
  await page.click("#nc-tool-lasso");
  await drawStroke(page, [
    [0.25, 0.25],
    [0.45, 0.25],
    [0.45, 0.4],
    [0.25, 0.4],
    [0.25, 0.25],
  ]);
  await drawStroke(page, [
    [0.35, 0.325],
    [0.55, 0.325],
  ]);

  await expect.poll(async () => (await storedStroke(page)).x[0]).toBeGreaterThan(originalX + 50);
  const movedX = (await storedStroke(page)).x[0];

  await page.click("#nc-tool-undo");
  await expect.poll(async () => (await storedStroke(page)).x[0]).toBeCloseTo(originalX, 0);

  await page.click("#nc-tool-redo");
  await expect.poll(async () => (await storedStroke(page)).x[0]).toBeCloseTo(movedX, 0);
});

test("ink and text survive the app being backgrounded and then killed", async ({
  page,
  context,
}) => {
  await createQuickNote(page, "Closed");
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.3, 0.5],
    [0.5, 0.6],
  ]);
  await page.click("#nc-tool-text");
  await page.locator(".trumbowyg-editor").click();
  await page.keyboard.type("Written just before closing");

  // Backgrounding (Home on Android, minimising on Windows) hides the page.
  // Typed text is saved on a 500 ms debounce; the app must flush it on hide
  // instead, so it is stored well before the debounce would have fired.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await readQuickNotes(page))[0]?.content ?? "", { timeout: 300 })
    .toContain("Written just before closing");

  // Then the OS kills it.
  await page.close();

  const reopened = await context.newPage();
  const errors = await bootApp(reopened);
  await openNote(reopened, "Closed");
  const [note] = await readQuickNotes(reopened);
  expect(note.strokes).toHaveLength(1);
  expect(note.content).toContain("Written just before closing");
  expect(errors, "uncaught errors in the page").toEqual([]);
});
