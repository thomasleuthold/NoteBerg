import { IDS, buildCorpus } from "./fixtures/corpus.js";
import {
  confirmDialog,
  createQuickNote,
  drawStroke,
  openBackupSettings,
  readKeys,
  readNotes,
  readQuickNotes,
  readStore,
  restoreFromSettings,
} from "./support/app.js";
import { bootApp } from "./support/fixtures.js";
import { expect, test } from "./support/fixtures.js";

test.describe("restore into an empty app", () => {
  test.use({ archive: buildCorpus() });

  test("brings back every notebook, note and image, ready for sync", async ({ page }) => {
    await restoreFromSettings(page);

    // Overview shows the restored corpus.
    await expect(page.locator(".notebook-card")).toHaveCount(2);
    await expect(page.locator(".notebook-card")).toContainText(["Work Projects", "Home"]);
    await expect(page.locator(".quick-notes-list .note-card")).toHaveCount(2);

    // Storage holds exactly the corpus (the recycle-bin note included).
    const notes = await readNotes(page);
    expect(notes.map((n) => n.title).sort()).toEqual([
      "Groceries",
      "Old plans",
      "Roadmap",
      "Sketch",
    ]);
    expect(notes.find((n) => n.id === IDS.notes.old).deleted).toBe(true);
    expect(notes.find((n) => n.id === IDS.notes.sketch).strokes).toHaveLength(2);
    expect(notes.find((n) => n.id === IDS.notes.groceries).content).toContain("Milk and eggs");
    expect(await readKeys(page, "files")).toContain(IDS.file);

    // Every restored note re-enters sync as a fresh local edit (design §5.6).
    for (const n of notes) {
      expect(n.synced, n.title).toBe(false);
      expect(n.lastSyncedEtag, n.title).toBeNull();
      expect(n.version, n.title).toBe(4); // archive version 3, bumped
      expect(n.restoredAt, n.title).toBeTruthy();
    }
    const notebooks = await readStore(page, "notebooks");
    expect(notebooks.map((nb) => nb.title).sort()).toEqual(["Home", "Work Projects"]);
  });

  test("a restored note opens in the editor and renders its strokes", async ({ page }) => {
    await restoreFromSettings(page);

    // Control first: a note without strokes leaves the canvas blank, so a
    // non-blank canvas below can only come from the restored strokes.
    await page.locator(`.note-card[data-note-id="${IDS.notes.groceries}"]`).click();
    await expect(page.locator(".note-canvas__overlay")).toBeVisible();
    expect(await inkedPixels(page)).toBe(0);

    await page.click("#nav-overview");
    await page.locator(`.note-card[data-note-id="${IDS.notes.sketch}"]`).click();
    await expect(page.locator(".note-canvas__overlay")).toBeVisible();
    await expect.poll(() => inkedPixels(page)).toBeGreaterThan(100);
  });
});

test.describe("restore over existing data", () => {
  test.use({ archive: buildCorpus() });

  test("a newer backup replaces the note; the old version goes to the recycle bin", async ({
    page,
  }) => {
    await restoreFromSettings(page);

    // A second backup in which "Groceries" is newer and different.
    await page.evaluate(
      (entries) => window.__fakeArchive.load(entries),
      buildCorpus({
        notes: {
          [IDS.notes.groceries]: {
            title: "Groceries v2",
            content: "<p>Oat milk</p>",
            modified: Date.now() + 3_600_000,
            version: 9,
          },
        },
      }),
    );

    await openBackupSettings(page);
    await page.click("#backup-restore-btn");
    // A genuine conflict, so the mode dialog appears; its default is "keep
    // replaced notes in the recycle bin".
    await expect(page.locator('input[name="restore-mode"][value="preferBackup"]')).toBeChecked();
    await confirmDialog(page);
    await page.click("#restore-open-bin-btn"); // completion dialog → straight to the bin

    const binTitles = page.locator(".recycle-item-title");
    await expect(binTitles).toHaveCount(2);
    expect((await binTitles.allTextContents()).map((t) => t.trim()).sort()).toEqual([
      "Groceries (replaced)",
      "Old plans",
    ]);

    const notes = await readNotes(page);
    const live = notes.find((n) => n.id === IDS.notes.groceries);
    expect(live.title).toBe("Groceries v2");
    expect(live.deleted).toBe(false);
    expect(live.content).toContain("Oat milk");
    // The displaced copy is a separate record holding the old content.
    const displaced = notes.find((n) => n.title === "Groceries (replaced)");
    expect(displaced.id).not.toBe(IDS.notes.groceries);
    expect(displaced.deleted).toBe(true);
    expect(displaced.content).toContain("Milk and eggs");
  });
});

test("backup then restore on a fresh install reproduces the notes", async ({
  page,
  browser,
  baseURL,
}) => {
  // Build a note through the UI, back it up through the UI.
  await createQuickNote(page, "Round trip");
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.2, 0.2],
    [0.5, 0.4],
    [0.7, 0.2],
  ]);
  await expect.poll(async () => (await readQuickNotes(page))[0]?.strokes?.length ?? 0).toBe(1);

  await openBackupSettings(page);
  await page.click("#backup-create-btn");
  await confirmDialog(page); // completion dialog's OK

  const written = await page.evaluate(() => window.__fakeArchive.written);
  expect(Object.keys(written)).toContain("manifest.json");
  expect(JSON.parse(written["manifest.json"].text).counts.notes).toBe(1);
  const original = (await readQuickNotes(page))[0];

  // A different device: new context, empty storage, the captured archive as source.
  const context = await browser.newContext({ baseURL });
  try {
    const fresh = await context.newPage();
    const errors = await bootApp(fresh, { archive: written });
    expect(await readNotes(fresh)).toEqual([]);

    await restoreFromSettings(fresh);

    const [restored] = await readQuickNotes(fresh);
    expect(restored.id).toBe(original.id);
    expect(restored.title).toBe("Round trip");
    expect(restored.strokes).toEqual(original.strokes);
    expect(errors, "uncaught errors in the page").toEqual([]);
  } finally {
    await context.close();
  }
});

/** Count pixels on the note's drawing canvas that differ from its paper colour. */
function inkedPixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".sliding-buffer-canvas");
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const [r, g, b] = data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b) n++;
    }
    return n;
  });
}
