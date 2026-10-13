import { createQuickNote, drawStroke, readQuickNotes } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

test("starts empty and shows the overview", async ({ page }) => {
  await expect(page.locator("#new-quick-note-btn")).toBeVisible();
  await expect(page.locator(".quick-notes-section .empty-state")).toBeVisible();
});

test("creates a quick note and lists it in the overview", async ({ page }) => {
  await createQuickNote(page, "Groceries");

  await page.click("#nav-overview");
  await expect(page.locator(".quick-notes-list .note-card")).toHaveCount(1);

  const notes = await readQuickNotes(page);
  expect(notes.map((n) => n.title)).toEqual(["Groceries"]);
});

test("a drawn stroke is saved and survives a reload", async ({ page }) => {
  await createQuickNote(page, "Sketch");
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.2, 0.2],
    [0.4, 0.3],
    [0.6, 0.2],
  ]);

  await expect.poll(async () => (await readQuickNotes(page))[0]?.strokes?.length ?? 0).toBe(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__noteberg?.initialized === true);

  const [note] = await readQuickNotes(page);
  expect(note.strokes).toHaveLength(1);
  expect(note.strokes[0].x.length).toBeGreaterThan(2);
});

test("native mode talks to the (mocked) Tauri backend", async ({ page }) => {
  const cmds = await page.evaluate(() => window.__tauriCalls.map((c) => c.cmd));
  expect(cmds).toContain("mcp_set_config");
});
