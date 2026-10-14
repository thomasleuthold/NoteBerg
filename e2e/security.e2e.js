import { closeSettings, createQuickNote, readNotes, reloadApp } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

// Master password + local encryption across restarts. The keychain is the
// stateful fake (support/fakeKeyring.js): it survives a reload like the OS
// keychain does, and a test can make it "lose" the stored password.

const PASSWORD = "Correct-Horse-Battery-42";
const SECRET = "Dear diary, nobody may read this";

/** Turn on local encryption with a fresh master password, then write a note. */
async function encryptAndWrite(page) {
  await page.click("#nav-settings");
  await page.click('.settings-nav__item[data-target="security"]');
  await page.locator(".toggle-switch:has(#encrypt-local-toggle)").click();
  await page.fill("#setup-password", PASSWORD);
  await page.fill("#setup-password-confirm", PASSWORD);
  await page.fill("#setup-password-hint", "the battery one");
  await page.click("#setup-confirm-btn");
  await page.locator("#modal-overlay:not(.modal-closing) .modal-confirm").click(); // "enabled" notice
  await closeSettings(page);

  await createQuickNote(page, "Diary");
  await page.click("#nc-tool-text");
  await page.locator(".trumbowyg-editor").click();
  await page.keyboard.type(SECRET);
  await page.click("#nav-overview"); // closing the note saves it
}

/** What the editor shows for the note, after opening it. */
async function shownText(page, title) {
  await page.locator(".note-card", { hasText: title }).click();
  return page.locator(".trumbowyg-editor").innerText();
}

test("notes are encrypted at rest and open without a prompt after a restart", async ({ page }) => {
  await encryptAndWrite(page);

  await expect.poll(async () => (await readNotes(page))[0]?.encrypted).toBe(true);
  expect(JSON.stringify(await readNotes(page))).not.toContain(SECRET);
  expect(await page.evaluate(() => window.__fakeKeyring.entries())).toHaveProperty(
    "master_password",
  );

  // The keychain holds the password, so a restart unlocks silently.
  await reloadApp(page);
  await expect(page.locator("#unlock-modal")).toHaveCount(0);
  await expect.poll(() => shownText(page, "Diary")).toContain(SECRET);
});

test("without the keychain entry, the app asks for the password and rejects a wrong one", async ({
  page,
}) => {
  await encryptAndWrite(page);
  await page.evaluate(() => window.__fakeKeyring.delete("master_password"));

  await page.reload({ waitUntil: "domcontentloaded" });
  const unlock = page.locator("#unlock-modal");
  await expect(unlock).toBeVisible();
  await expect(unlock).toContainText("the battery one");

  await page.fill("#unlock-password", "not the password");
  await page.click("#unlock-confirm-btn");
  await expect(unlock.locator(".modal-error")).toBeVisible();
  await expect(unlock).toBeVisible();

  await page.fill("#unlock-password", PASSWORD);
  await page.click("#unlock-confirm-btn");
  await expect(unlock).toHaveCount(0);
  await page.waitForFunction(() => window.__noteberg?.initialized === true);

  await expect.poll(() => shownText(page, "Diary")).toContain(SECRET);
  // A successful manual unlock puts the password back in the keychain.
  expect(await page.evaluate(() => window.__fakeKeyring.entries())).toHaveProperty(
    "master_password",
  );
});
