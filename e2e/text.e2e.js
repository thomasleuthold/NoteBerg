import { colourPng } from "./fixtures/media.js";
import { createQuickNote, readQuickNotes } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

// Pasting goes through the real system clipboard and the browser's own paste
// event, neither of which jsdom has.

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createQuickNote(page, "Pasted");
  await page.click("#nc-tool-text");
  await page.locator(".trumbowyg-editor").click();
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

test("formatted text pastes with its formatting and without active content", async ({ page }) => {
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
  expect(await page.evaluate(() => window.__pasted ?? null)).toBeNull();
});

test("a pasted image is inserted into the text", async ({ page }) => {
  const png = await colourPng(page, [30, 120, 200], { width: 1600, height: 400 });
  await copyToClipboard(page, { "image/png": { base64: png.buffer.toString("base64") } });
  await page.keyboard.press("Control+V");

  await expect.poll(() => storedContent(page)).toMatch(/<img[^>]+src="data:image\/png;base64,/);
  // Downscaled on the way in (MAX_WIDTH 800), not stored at full size.
  const width = await page.evaluate(
    () => document.querySelector(".trumbowyg-editor img").naturalWidth,
  );
  expect(width).toBe(800);
});
