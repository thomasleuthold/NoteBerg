import { buildCorpus } from "./fixtures/corpus.js";
import {
  confirmDialog,
  createQuickNote,
  drawStroke,
  openBackupSettings,
  readQuickNotes,
  restoreFromSettings,
} from "./support/app.js";
import { bootApp, expect, test } from "./support/fixtures.js";

// The archive itself is the fake's (fakeArchive.js); what these pin is the
// flow around it: the pickers, the progress dialog's Cancel, the password
// dialogs and what the section reports afterwards. Unit tests drive those
// pieces one at a time with the archive mocked out.

/** Every native command the page has issued so far, by name. */
const calledCommands = (page) => page.evaluate(() => window.__tauriCalls.map((c) => c.cmd));

const PASSWORD = "Correct-Horse-Battery-42";

test("cancelling either file picker starts nothing and reports nothing", async ({ page }) => {
  await page.evaluate(() => {
    window.__tauriHandlers.backup_choose_destination = () => null;
    window.__tauriHandlers.restore_choose_source = () => null;
  });
  await openBackupSettings(page);

  await page.click("#backup-create-btn");
  await page.click("#backup-restore-btn");

  // Both pickers were asked; neither run went past them.
  await expect.poll(() => calledCommands(page)).toContain("restore_choose_source");
  const cmds = await calledCommands(page);
  expect(cmds).toContain("backup_choose_destination");
  expect(cmds).not.toContain("backup_begin");
  expect(cmds).not.toContain("restore_open");
  await expect(page.locator("#modal-overlay")).toHaveCount(0);
  await expect(page.locator("#backup-status")).toHaveText("");
  await expect(page.locator("#restore-status")).toHaveText("");
});

test.describe("with notes to back up", () => {
  test.use({ archive: buildCorpus() });

  test("cancelling a running backup deletes the partial file and records no backup", async ({
    page,
  }) => {
    await restoreFromSettings(page);
    await page.evaluate(() => {
      window.__fakeArchive.writeDelayMs = 300;
    });

    await openBackupSettings(page);
    await expect(page.locator(".settings-dialog")).toContainText("Never backed up");
    await page.click("#backup-create-btn");
    await page.click("#modal-progress-cancel");

    await expect(page.locator("#backup-status")).toHaveText(
      "Backup cancelled. No file was left behind.",
    );
    expect(await calledCommands(page)).toContain("backup_abort");
    expect(await calledCommands(page)).not.toContain("backup_finish");
    expect(await page.evaluate(() => window.__fakeArchive.written)).toEqual({});
    await expect(page.locator(".settings-dialog")).toContainText("Never backed up");
  });
});

test("a password-protected backup restores only with its password", async ({
  page,
  browser,
  baseURL,
}) => {
  await createQuickNote(page, "Secret");
  await page.click("#nc-tool-draw");
  await drawStroke(page, [
    [0.2, 0.2],
    [0.5, 0.4],
  ]);
  await expect.poll(async () => (await readQuickNotes(page))[0]?.strokes?.length ?? 0).toBe(1);

  await openBackupSettings(page);
  // The checkbox is visually hidden behind its slider, which is what a user clicks.
  await page.locator(".toggle-switch:has(#backup-encrypt-toggle)").click();
  await expect(page.locator("#backup-encrypt-toggle")).toBeChecked();
  await page.click("#backup-create-btn");
  await page.fill("#backup-password", PASSWORD);
  await page.fill("#backup-password-confirm", PASSWORD);
  await confirmDialog(page); // password dialog
  await confirmDialog(page); // completion dialog's OK

  const { written, writtenPassword } = await page.evaluate(() => ({
    written: window.__fakeArchive.written,
    writtenPassword: window.__fakeArchive.writtenPassword,
  }));
  expect(writtenPassword).toBe(PASSWORD);
  expect(JSON.parse(written["manifest.json"].text).encrypted).toBe(true);
  await expect(page.locator(".settings-dialog")).toContainText("password protected");

  // Another device restores it.
  const context = await browser.newContext({ baseURL });
  try {
    const fresh = await context.newPage();
    const errors = await bootApp(fresh);
    await fresh.evaluate(
      ([entries, pw]) => window.__fakeArchive.load(entries, pw),
      [written, PASSWORD],
    );

    await openBackupSettings(fresh);
    await fresh.click("#backup-restore-btn");
    await fresh.fill("#restore-password", "not the password");
    await confirmDialog(fresh);
    await expect(fresh.locator("#modal-overlay:not(.modal-closing) .modal-error")).toHaveText(
      "Incorrect password. Please try again.",
    );
    expect(await readQuickNotes(fresh)).toEqual([]);

    await fresh.fill("#restore-password", PASSWORD);
    await confirmDialog(fresh); // password prompt
    await confirmDialog(fresh); // "restore N notes?"
    await confirmDialog(fresh); // completion dialog's OK

    const [restored] = await readQuickNotes(fresh);
    expect(restored.title).toBe("Secret");
    expect(restored.strokes).toHaveLength(1);
    expect(errors, "uncaught errors in the page").toEqual([]);
  } finally {
    await context.close();
  }
});
