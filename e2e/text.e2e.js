import { colourPng } from "./fixtures/media.js";
import { createQuickNote, readQuickNotes, startTyping } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

// Pasting goes through the real system clipboard and the browser's own paste
// event, neither of which jsdom has.

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createQuickNote(page, "Pasted");
  await page.click("#nc-tool-text");
  await startTyping(page);
});

const storedContent = async (page) => (await readQuickNotes(page))[0]?.content ?? "";

/** Put entries ({ mimeType: string | base64 }) on the clipboard, as a copy in another app would. */
function copyToClipboard(page, entries) {
  return page.evaluate(async (entries) => {
    const blobs = {};
    for (const [type, { text, base64 }] of Object.entries(entries)) {
      blobs[type] =
        base64 != null
          ? new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type })
          : new Blob([text], { type });
    }
    await navigator.clipboard.write([new ClipboardItem(blobs)]);
  }, entries);
}

test("formatted text pastes with its formatting and without active content or images", async ({
  page,
}) => {
  await copyToClipboard(page, {
    "text/html": {
      text:
        '<p>Plain <b>bold</b> text</p><script>window.__pasted = "script"</script>' +
        '<img src="x" onerror="window.__pasted = \'onerror\'">',
    },
    "text/plain": { text: "Plain bold text" },
  });
  await page.keyboard.press("Control+V");

  await expect.poll(() => storedContent(page)).toMatch(/<(b|strong)>bold<\/(b|strong)>/);
  const content = await storedContent(page);
  expect(content).not.toContain("<script");
  expect(content).not.toContain("onerror");
  // Images in pasted HTML are dropped (text boxes DESIGN §12.3)
  expect(content).not.toContain("<img");
  expect(await page.evaluate(() => window.__pasted ?? null)).toBeNull();
});

test("a pasted image is placed on the page at the caret, selected, and the text is unchanged", async ({
  page,
}) => {
  await page.keyboard.type("Above the picture");
  await expect.poll(() => storedContent(page)).toContain("Above the picture");
  const textBefore = await storedContent(page);

  const png = await colourPng(page, [30, 120, 200], { width: 1600, height: 400 });
  await copyToClipboard(page, { "image/png": { base64: png.buffer.toString("base64") } });
  await page.keyboard.press("Control+V");

  // A page image (media item), like the insert button makes, not base64 in the text
  await expect.poll(async () => (await readQuickNotes(page))[0]?.media?.length ?? 0).toBe(1);
  const [note] = await readQuickNotes(page);
  expect(note.content).toBe(textBefore);
  expect(note.content).not.toContain("<img");
  const [image] = note.media;
  expect(image.type).toBe("image");
  // At the caret: the box's text column, just below the typed line
  const boxX = Number(note.content.match(/data-x="(\d+)"/)[1]);
  const boxY = Number(note.content.match(/data-y="(\d+)"/)[1]);
  expect(image.x).toBeCloseTo(boxX + 8, -1);
  expect(image.y).toBeGreaterThan(boxY);
  expect(image.y).toBeLessThan(boxY + 60);
  // The app stays in text mode
  await expect(page.locator(".note-canvas--text-mode")).toHaveCount(1);
});
