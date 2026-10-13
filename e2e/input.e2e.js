import { createQuickNote, readQuickNotes } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";
import { contentWidth, penStroke, touchGesture } from "./support/input.js";

// Real PointerEvents from Chromium's input pipeline (support/input.js), the
// way a digitiser or touchscreen delivers them. Unit tests feed InputHandler
// hand-built event objects; the e2e drawing test uses a mouse.

test.use({ hasTouch: true });

const strokeCount = async (page) => (await readQuickNotes(page))[0]?.strokes?.length ?? 0;

/** Strokes are written when they end; give a stroke that should not exist time to show up. */
const settle = (page) => page.waitForTimeout(500);

test("pen pressure reaches the stored stroke", async ({ page }) => {
  await createQuickNote(page, "Pressure");

  // Starts in pan mode: a pen must draw anyway.
  await penStroke(
    page,
    Array.from({ length: 12 }, (_, i) => [0.2 + i * 0.04, 0.4, 0.1 + i * 0.07]),
  );

  await expect.poll(() => strokeCount(page)).toBe(1);
  const [{ strokes }] = await readQuickNotes(page);
  const pressure = strokes[0].pressure;
  expect(Math.min(...pressure)).toBeLessThan(0.3);
  expect(Math.max(...pressure)).toBeGreaterThan(0.7);
});

test("once a pen has been used, a finger navigates instead of drawing", async ({ page }) => {
  await createQuickNote(page, "Palm");
  await page.click("#nc-tool-draw");
  const fingerDrag = [[[0.3, 0.6]], [[0.4, 0.62]], [[0.5, 0.64]]];

  // Control: before any pen input, a finger in draw mode draws.
  await touchGesture(page, fingerDrag);
  await expect.poll(() => strokeCount(page)).toBe(1);

  await penStroke(page, [
    [0.2, 0.3, 0.5],
    [0.4, 0.3, 0.5],
  ]);
  await expect.poll(() => strokeCount(page)).toBe(2);

  await touchGesture(page, fingerDrag);
  await settle(page);
  expect(await strokeCount(page)).toBe(2);
});

test("a pinch zooms, and the stroke its first finger began is dropped", async ({ page }) => {
  await createQuickNote(page, "Pinch");
  await page.click("#nc-tool-draw");
  const before = await contentWidth(page);

  await touchGesture(page, [
    // First finger lands and starts drawing...
    [[0.45, 0.5]],
    [[0.46, 0.5]],
    [[0.47, 0.5]],
    // ...then a second finger joins and the two spread apart.
    [
      [0.47, 0.5],
      [0.55, 0.5],
    ],
    [
      [0.42, 0.5],
      [0.6, 0.5],
    ],
    [
      [0.36, 0.5],
      [0.66, 0.5],
    ],
    [
      [0.3, 0.5],
      [0.72, 0.5],
    ],
  ]);

  await expect.poll(() => contentWidth(page)).toBeGreaterThan(before * 1.2);
  await settle(page);
  expect(await strokeCount(page)).toBe(0);
});
