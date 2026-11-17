import { buildCorpus, IDS } from "./fixtures/corpus.js";
import { openNote, readQuickNotes, restoreFromSettings } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

// Guard for the text layer refactor (text boxes PLAN phase 2): with the
// editor mounted only on the box being edited, a tap into text written before
// boxes existed must still put the caret where it lands, with every input,
// and a finger drag over the text must still pan instead of editing.

test.use({
  hasTouch: true,
  archive: buildCorpus({
    notes: {
      [IDS.notes.groceries]: {
        content: "<p>Alpha beta gamma delta</p><p>Second line here</p>",
      },
    },
  }),
});

test.beforeEach(async ({ page }) => {
  await restoreFromSettings(page);
  await openNote(page, "Groceries");
  await page.click("#nc-tool-text");
});

const storedContent = async (page) =>
  (await readQuickNotes(page)).find((n) => n.id === IDS.notes.groceries)?.content ?? "";

/** Client coordinates of the left edge of `word`'s first letter, mid-line. */
function letterEdge(page, word) {
  return page.evaluate((word) => {
    const layer = document.querySelector(".note-canvas__text-editor-layer");
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`"${word}" is not on the page`);
  }, word);
}

/** A tap at client coordinates with a mouse, a pen or a finger, through the browser's input pipeline. */
async function tap(page, kind, { x, y }) {
  if (kind === "mouse") {
    await page.mouse.click(x, y);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  if (kind === "pen") {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
        pointerType: "pen",
        force: 0.5,
      });
    }
  } else {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await cdp.detach();
}

for (const kind of ["mouse", "pen", "touch"]) {
  test(`a ${kind} tap in the text puts the caret where it lands`, async ({ page }) => {
    await tap(page, kind, await letterEdge(page, "gamma"));
    await page.keyboard.type("X");
    await expect.poll(() => storedContent(page)).toContain("Alpha beta Xgamma delta");
    expect(await storedContent(page)).toContain("Second line here");
  });
}

test("a finger drag over the text pans and leaves the text alone", async ({ page }) => {
  const scrollTop = () =>
    page.evaluate(() => document.querySelector(".virtual-scroll-container").scrollTop);
  const start = await letterEdge(page, "Second");
  const before = await scrollTop();

  const cdp = await page.context().newCDPSession(page);
  const point = (dy) => [{ x: start.x, y: start.y - dy }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
  for (let dy = 10; dy <= 150; dy += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(dy) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();

  await expect.poll(scrollTop).toBeGreaterThan(before + 50);
  await page.keyboard.type("Y");
  await page.waitForTimeout(800);
  expect(await storedContent(page)).toBe("<p>Alpha beta gamma delta</p><p>Second line here</p>");
});
