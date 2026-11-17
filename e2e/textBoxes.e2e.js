import { buildCorpus, IDS } from "./fixtures/corpus.js";
import { textPdf } from "./fixtures/media.js";
import {
  createQuickNote,
  insertFromMenu,
  openNote,
  readNotes,
  readQuickNotes,
  reloadApp,
  restoreFromSettings,
  scrollNote,
} from "./support/app.js";
import { expect, test } from "./support/fixtures.js";
import { pdfTextItems, visibleTextOperators } from "./support/pdfText.js";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// Text boxes (documentation/text_boxes_design.md) in the real app:
// creating, typing, moving, resizing and reloading; the toolbar on the active
// box; the legacy main box; snapping; boxes on PDF pages.

/** Client coordinates of a point in content px (the 1200 px page). */
async function clientPoint(page, x, y) {
  const layer = await page.locator(".note-canvas__text-editor-layer").boundingBox();
  const zoom = layer.width / 1200;
  return { x: layer.x + x * zoom, y: layer.y + y * zoom };
}

async function clickContent(page, x, y) {
  const p = await clientPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}

/** Drag from the centre of an element by (dx, dy) screen px, in steps. */
async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

/** A note's stored text: by id, or the only quick note's. */
const content = async (page, id) =>
  (id ? (await readNotes(page)).find((n) => n.id === id) : (await readQuickNotes(page))[0])
    ?.content ?? "";

/** Geometry of every stored box, in content order. */
function boxesIn(html) {
  return [...html.matchAll(/data-box-id="([^"]+)" data-x="(\d+)" data-y="(\d+)" data-w="(\d+)"/g)].map(
    ([, id, x, y, w]) => ({ id, x: Number(x), y: Number(y), w: Number(w) }),
  );
}

/** Where a word's first letter is on screen. */
function letterRect(page, word) {
  return page.evaluate((word) => {
    const layer = document.querySelector(".note-canvas__text-editor-layer");
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const { left, top } = range.getBoundingClientRect();
      return { left, top };
    }
    return null;
  }, word);
}

test.describe("on a new note", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await createQuickNote(page, "Boxes");
    await page.click("#nc-tool-text");
  });

  test("a click starts a box; typed, moved, resized, it keeps its place after a reload", async ({
    page,
  }) => {
    await clickContent(page, 300, 200);
    await page.locator(".trumbowyg-editor:focus").waitFor();
    await page.keyboard.type("First box");
    await expect.poll(() => content(page)).toContain("First box");
    const [created] = boxesIn(await content(page));
    // Snapped on a plain page: text origin 304/192, the box around it
    expect(created).toMatchObject({ x: 296, y: 188, w: 400 });

    await dragBy(page, page.locator(".text-box__handle"), 160, 120);
    await expect.poll(async () => boxesIn(await content(page))[0].y).toBeGreaterThan(created.y + 60);
    const moved = boxesIn(await content(page))[0];
    expect(moved.x).toBeGreaterThan(created.x + 100);

    await dragBy(page, page.locator(".text-box__resize"), -120, 0);
    await expect.poll(async () => boxesIn(await content(page))[0].w).toBeLessThan(320);
    const resized = boxesIn(await content(page))[0];
    expect(resized).toMatchObject({ x: moved.x, y: moved.y });

    await reloadApp(page);
    await openNote(page, "Boxes");
    const el = page.locator(`.text-box[data-box-id="${resized.id}"]`);
    await expect(el).toContainText("First box");
    expect(await el.evaluate((e) => [e.style.left, e.style.top, e.style.width])).toEqual([
      `${resized.x}px`,
      `${resized.y}px`,
      `${resized.w}px`,
    ]);
  });

  test("with two boxes the toolbar formats only the active one", async ({ page }) => {
    await clickContent(page, 200, 200);
    await page.keyboard.type("alpha");
    await page.keyboard.press("Control+A");
    await page.click(".trumbowyg-bold-button");

    await clickContent(page, 700, 600); // leaves the first box
    await clickContent(page, 700, 600); // starts the second
    await page.keyboard.type("beta");

    await expect.poll(() => content(page)).toContain("beta");
    const html = await content(page);
    expect(html).toMatch(/<(b|strong)>alpha<\/(b|strong)>/);
    expect(html).not.toMatch(/<(b|strong)>beta/);
    expect(boxesIn(html)).toHaveLength(2);
  });

  test("the table button opens its grid in a box away from the page origin, and inserts there", async ({
    page,
  }) => {
    await clickContent(page, 600, 300);
    await page.keyboard.type("Grid:");
    await page.click(".note-canvas__trumbowyg-toolbar .trumbowyg-table-button");

    const grid = page.locator(".trumbowyg-dropdown-table");
    await expect(grid).toBeVisible();
    // On screen, beside the toolbar (not shifted by the box's position)
    const toolbar = await page.locator(".note-canvas__trumbowyg-toolbar").boundingBox();
    const viewport = page.viewportSize();
    const at = await grid.boundingBox();
    expect(Math.abs(at.x - (toolbar.x + toolbar.width))).toBeLessThan(4);
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.y + 20).toBeLessThan(viewport.height);

    // 2 x 2
    await grid.locator("tr").nth(1).locator("td").nth(1).click();
    await expect.poll(() => content(page)).toMatch(/<table[\s\S]*<\/table>/);
    const [boxed] = boxesIn(await content(page));
    expect(boxed).toMatchObject({ x: 592 });
    // The grid cell picked: 2 columns, a header row and 2 rows
    expect((await content(page)).match(/<tr/g)).toHaveLength(3);
    expect((await content(page)).match(/<t[hd][ >]/g)).toHaveLength(6);
  });

  test("the table size can be marked by dragging over the grid, with a mouse and a finger", async ({
    page,
  }) => {
    const pickByDrag = async (kind) => {
      await page.click(".note-canvas__trumbowyg-toolbar .trumbowyg-table-button");
      const rows = page.locator(".trumbowyg-dropdown-table tr");
      const from = await rows.nth(0).locator("td").nth(0).boundingBox();
      const to = await rows.nth(1).locator("td").nth(2).boundingBox();
      const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      if (kind === "mouse") {
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 6 });
        await expect(page.locator(".trumbowyg-table-size")).toHaveText("3x2");
        await page.mouse.up();
      } else {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
        for (let i = 1; i <= 6; i++) {
          const p = { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 };
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      }
    };

    await clickContent(page, 300, 200);
    await page.keyboard.type("Mouse:");
    await pickByDrag("mouse");
    await expect.poll(() => content(page)).toMatch(/<table/);
    // 3 columns; a header row and 2 rows
    let html = await content(page);
    expect(html.match(/<tr/g)).toHaveLength(3);
    expect(html.match(/<t[hd][ >]/g)).toHaveLength(9);

    await page.keyboard.press("Control+End");
    await page.keyboard.type("Finger:");
    await pickByDrag("touch");
    await expect.poll(async () => (await content(page)).match(/<table/g)?.length ?? 0).toBe(2);
    html = await content(page);
    expect(html.match(/<tr/g)).toHaveLength(6);
    expect(html.match(/<t[hd][ >]/g)).toHaveLength(18);
  });

  test("a finger adds a row with the table button's action, and the box stays in edit", async ({
    page,
  }) => {
    const tap = async ({ x, y, width, height }) => {
      const cdp = await page.context().newCDPSession(page);
      const p = { x: x + width / 2, y: y + height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    };
    await clickContent(page, 300, 200);
    await page.keyboard.type("Rows:");
    await page.click(".note-canvas__trumbowyg-toolbar .trumbowyg-table-button");
    await page.locator(".trumbowyg-dropdown-table tr").nth(0).locator("td").nth(1).click();
    await expect.poll(() => content(page)).toMatch(/<table/);
    // Caret into the first body cell, then the table button: its actions
    await page.locator(".trumbowyg-editor tbody td").first().click();
    await tap(await page.locator(".note-canvas__trumbowyg-toolbar .trumbowyg-table-button").boundingBox());
    const addRow = page.locator(".trumbowyg-tableAddRow-dropdown-button");
    await expect(addRow).toBeVisible();

    // The list is longer than the menu: a finger drag on a button scrolls it
    // and runs nothing
    const menu = page.locator(".note-canvas__trumbowyg-toolbar .trumbowyg-dropdown-table");
    const scrollTop = () => menu.evaluate((el) => el.scrollTop);
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const start = await addRow.boundingBox();
    const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let dy = 10; dy <= 120; dy += 10) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x, y: from.y - dy }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect.poll(scrollTop).toBeGreaterThan(40);
    await page.waitForTimeout(300);
    expect((await content(page)).match(/<tr/g)).toHaveLength(2);
    await expect(menu).toBeVisible();

    await addRow.scrollIntoViewIfNeeded();
    await tap(await addRow.boundingBox());

    // A header row and now 2 rows; still editing that box
    await expect.poll(async () => (await content(page)).match(/<tr/g)?.length ?? 0).toBe(3);
    await expect(page.locator(".text-box--active .trumbowyg-editor")).toHaveCount(1);
    await expect(page.locator(".trumbowyg-editor:focus")).toHaveCount(1);
  });

  test("a finger can resize a box by its right edge", async ({ page }) => {
    await clickContent(page, 300, 200);
    await page.keyboard.type("Wide");
    await expect.poll(() => content(page)).toContain("Wide");
    const before = boxesIn(await content(page))[0];
    const edge = await page.locator(".text-box__resize").boundingBox();
    // A finger lands a little off the drawn bar, inside the grab area
    const x = edge.x + edge.width * 0.25;
    const y = edge.y + edge.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let dx = 10; dx <= 120; dx += 10) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - dx, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect.poll(async () => boxesIn(await content(page))[0].w).toBeLessThan(before.w - 60);
    expect(boxesIn(await content(page))[0].x).toBe(before.x);
  });

  test("a box is deleted from its options menu, not by a press on the bar", async ({ page }) => {
    await clickContent(page, 300, 200);
    await page.keyboard.type("Doomed");
    await expect.poll(() => content(page)).toContain("Doomed");
    await page.click(".text-box__options");
    await expect(page.locator(".text-box")).toHaveCount(1);
    await page.locator(".context-floating-menu__btn", { hasText: "Delete" }).click();
    await expect(page.locator(".text-box")).toHaveCount(0);
    await expect.poll(() => content(page)).toBe("");
  });

  test("near the right edge a box shrinks to the room left, down to 200 px", async ({ page }) => {
    await clickContent(page, 1150, 300);
    await page.keyboard.type("edge");
    await expect.poll(() => content(page)).toContain("edge");
    expect(boxesIn(await content(page))[0]).toMatchObject({ x: 1000, w: 200 });
  });

  test("handles stay large enough to grab when zoomed out", async ({ page }) => {
    await clickContent(page, 300, 200);
    await page.keyboard.type("small");
    // Ctrl + wheel down to the minimum zoom
    await page.evaluate(() => {
      const viewport = document.querySelector(".virtual-scroll-container__viewport");
      const r = viewport.getBoundingClientRect();
      for (let i = 0; i < 12; i++) {
        viewport.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 100,
            ctrlKey: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    });

    const layer = await page.locator(".note-canvas__text-editor-layer").boundingBox();
    expect(layer.width / 1200).toBeLessThan(0.75);
    await expect
      .poll(async () => (await page.locator(".text-box__handle").boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(23);
    const handle = await page.locator(".text-box__handle").boundingBox();
    expect(handle.height).toBeLessThan(26);
  });

  test("exported text can be selected and searched, where it is seen", async ({ page }) => {
    await page.evaluate(() => {
      window.__tauriHandlers.save_pdf = (args) => {
        window.__savedPdf = args;
        return "C:/e2e/Boxes.pdf";
      };
    });
    await clickContent(page, 300, 200);
    await page.keyboard.type("Searchable Zażółć Привет");
    await clickContent(page, 900, 400); // leaves the box
    await clickContent(page, 700, 500);
    await page.keyboard.type("Second box");
    await expect.poll(() => content(page)).toContain("Second box");
    await page.click("#nc-tool-pan");

    await page.click("#nc-tool-options");
    await page.click("#nc-export-pdf-btn");
    await expect
      .poll(() => page.evaluate(() => window.__savedPdf?.suggestedName ?? null), { timeout: 30_000 })
      .toBe("Boxes.pdf");
    const bytes = Uint8Array.from(await page.evaluate(() => window.__savedPdf.bytes));

    const [first, ...rest] = await pdfTextItems(bytes);
    const text = first.map((item) => item.str).join(" ");
    expect(text).toContain("Searchable");
    expect(text).toContain("Zażółć");
    expect(text).toContain("Привет");
    expect(text).toContain("Second box");
    // Where the text is seen: content (304, 192..) on an A4 page 1200 px wide
    const s = A4_WIDTH / 1200;
    const word = first.find((item) => item.str.includes("Searchable"));
    expect(word.x).toBeCloseTo(304 * s, -1);
    expect(A4_HEIGHT - word.y).toBeGreaterThan(192 * s);
    expect(A4_HEIGHT - word.y).toBeLessThan(220 * s);
    const second = first.find((item) => item.str.includes("Second"));
    expect(second.x).toBeCloseTo(704 * s, -1);
    // Nothing twice, nothing on a page it is not on
    expect(text.match(/Searchable/g)).toHaveLength(1);
    expect(rest.flat()).toEqual([]);
    // Invisible: the picture shows the text, the text layer draws nothing
    expect(await visibleTextOperators(bytes)).toEqual(new Array(rest.length + 1).fill(0));
  });

  test("a box on a PDF page, and the PDF's own text still selects in pan mode", async ({ page }) => {
    await insertFromMenu(page, "insert-pdf", await textPdf("Contract terms"));
    await expect
      .poll(async () => (await readQuickNotes(page))[0]?.media?.filter((m) => m.type === "pdf-page").length)
      .toBe(1);
    const [pdfPage] = (await readQuickNotes(page))[0].media;
    // The PDF's text layer is laid on once the view moves
    await scrollNote(page, 40);
    await scrollNote(page, -40);
    const span = page.locator(".note-canvas__text-layer span", { hasText: "Contract" }).first();
    await span.waitFor({ state: "attached" });
    const onText = await span.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    // In text mode a click right on the PDF's text starts a box there
    await page.click("#nc-tool-text");
    await page.mouse.click(onText.x, onText.y);
    await page.locator(".trumbowyg-editor:focus").waitFor();
    await page.keyboard.type("Signed");
    await expect.poll(() => content(page)).toContain("Signed");
    const [onPdf] = boxesIn(await content(page));
    expect(onPdf.y).toBeGreaterThan(pdfPage.y);
    expect(onPdf.y).toBeLessThan(pdfPage.y + pdfPage.height);

    // In pan mode the PDF's text is what a press there reaches (to select it)
    await page.click("#nc-tool-pan");
    const hit = await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".note-canvas__text-layer")),
      onText,
    );
    expect(hit).toBe(true);
  });
});

test.describe("pictures of the page", () => {
  // A box far down and to the right, its text in capitals so it inks a lot
  test.use({
    archive: buildCorpus({
      notes: {
        [IDS.notes.groceries]: {
          content:
            '<p>Top line</p><div class="text-box" data-box-id="tb_far" data-x="700" data-y="1200" data-w="400"><p>WWWWWWWWWW</p></div>',
          // A ticked stroke task: its checkbox goes left of the ink, at 270/509
          strokes: [
            {
              id: "s-task",
              x: [300, 350, 400],
              y: [500, 520, 540],
              pressure: [0.5, 0.5, 0.5],
              time: [0, 10, 20],
              colorIndex: 0,
              width: 2,
              type: "pen",
            },
          ],
          tasks: [{ id: "t-ink", type: "stroke", strokeIds: ["s-task"], checked: true }],
        },
      },
    }),
  });

  test("the overview thumbnail shows a box at its position on the page", async ({ page }) => {
    test.slow();
    await restoreFromSettings(page);
    const canvas = page.locator('.note-preview-canvas[data-note-id="note-groceries"]');
    await canvas.waitFor();

    // Inked (not white) pixels in a region of the 360 x 500 thumbnail (content
    // px × 0.3); text that small is anti-aliased to grey
    const inkIn = (x, y, w, h) =>
      canvas.evaluate(
        (el, r) => {
          const scale = el.width / 360;
          const data = el
            .getContext("2d")
            .getImageData(r.x * scale, r.y * scale, r.w * scale, r.h * scale).data;
          let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0 && data[i] + data[i + 1] + data[i + 2] < 700) n++;
          }
          return n;
        },
        { x, y, w, h },
      );
    // The box: x 700..1100, its line at y 1204..1228 → thumbnail 210..330, 361..369
    await expect.poll(() => inkIn(205, 355, 130, 20), { timeout: 15_000 }).toBeGreaterThan(20);
    // Not stacked under the main text at the left, as without boxes
    // The main line itself: x 46.., y 16..40 → thumbnail 14.., 5..12
    expect(await inkIn(10, 4, 60, 9)).toBeGreaterThan(0);
    // Below it, where the box's text would be without its position, nothing
    expect(await inkIn(0, 14, 200, 30)).toBe(0);
    // The stroke task's ticked checkbox: content 270..292, 509..531 → 81..88, 153..159
    expect(await inkIn(81, 153, 6, 6)).toBeGreaterThan(15);
    expect(await inkIn(60, 150, 15, 12)).toBe(0); // nothing left of it
  });
});

test.describe("on notes written before boxes", () => {
  test.use({
    archive: buildCorpus({
      notes: {
        [IDS.notes.groceries]: { content: "<p>Milk and eggs</p><p>Bread</p>" },
        [IDS.notes.sketch]: { background: "ruled-medium" },
        [IDS.notes.roadmap]: { background: "grid-large" },
      },
    }),
  });

  test.beforeEach(async ({ page }) => {
    // Restoring the corpus first takes much of the default timeout under load
    test.slow();
    await restoreFromSettings(page);
  });

  test("the main text does not move when edited, and moves only by its drag", async ({ page }) => {
    await openNote(page, "Groceries");
    await page.click("#nc-tool-text");
    const still = await letterRect(page, "Milk");

    // Mounting the editor on it moves no line
    await page.mouse.click(still.left + 2, still.top + 8);
    await page.locator(".trumbowyg-editor:focus").waitFor();
    const active = await letterRect(page, "Milk");
    expect(Math.abs(active.left - still.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(active.top - still.top)).toBeLessThanOrEqual(0.5);

    // Dragged straight down: wrapped into a box, its text at the same x
    await dragBy(page, page.locator(".text-box__handle"), 0, 96);
    await expect.poll(() => content(page, IDS.notes.groceries)).toMatch(/^<div class="text-box"/);
    const after = await letterRect(page, "Milk");
    expect(Math.abs(after.left - still.left)).toBeLessThanOrEqual(0.5);
    expect(after.top - still.top).toBeGreaterThan(48);
    expect(await content(page, IDS.notes.groceries)).toContain("<p>Milk and eggs</p><p>Bread</p>");

    // Undo puts it back where it was, unwrapped
    await page.click("#nc-tool-undo");
    await expect.poll(() => content(page, IDS.notes.groceries)).toBe("<p>Milk and eggs</p><p>Bread</p>");
    const undone = await letterRect(page, "Milk");
    expect(Math.abs(undone.top - still.top)).toBeLessThanOrEqual(0.5);
  });

  test("a click right of the main text's widest line starts a box beside it", async ({ page }) => {
    await openNote(page, "Groceries");
    await page.click("#nc-tool-text");
    await clickContent(page, 700, 30);
    await page.keyboard.type("beside");
    await expect.poll(() => content(page, IDS.notes.groceries)).toContain("beside");
    const html = await content(page, IDS.notes.groceries);
    expect(html.startsWith("<p>Milk and eggs</p><p>Bread</p>")).toBe(true);
    expect(boxesIn(html)[0].x).toBeGreaterThan(600);
  });

  test("boxes snap to the lines of a ruled page and to the squares of a grid page", async ({
    page,
  }) => {
    await openNote(page, "Sketch");
    await page.click("#nc-tool-text");
    await clickContent(page, 333, 347);
    await page.keyboard.type("ruled");
    await expect.poll(() => content(page, IDS.notes.sketch)).toContain("ruled");
    const [ruled] = boxesIn(await content(page, IDS.notes.sketch));
    expect((ruled.y + 4) % 30).toBe(0); // its text starts on a line
    expect((ruled.x + 8) % 8).toBe(0);

    await page.click("#nav-overview");
    await page.locator(".notebook-card", { hasText: "Work Projects" }).click();
    await openNote(page, "Roadmap");
    await page.click("#nc-tool-text");
    await clickContent(page, 533, 547);
    await page.keyboard.type("grid");
    await expect.poll(() => content(page, IDS.notes.roadmap)).toContain("grid");
    const [grid] = boxesIn(await content(page, IDS.notes.roadmap));
    expect((grid.y + 4) % 40).toBe(0);
    expect((grid.x + 8) % 40).toBe(0);
  });
});
