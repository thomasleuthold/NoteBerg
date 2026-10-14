import { test as base, expect } from "@playwright/test";
import { installFakeArchive } from "./fakeArchive.js";
import { installFakeKeyring } from "./fakeKeyring.js";
import { installTauriMock } from "./tauriMock.js";

/**
 * Boot the real app as a native (Tauri) client on `page`:
 * - Tauri runtime faked before any app script runs (see tauriMock.js)
 * - Rust zip commands faked over `archive` entries (see fakeArchive.js)
 * - OS keychain faked, surviving reloads (see fakeKeyring.js)
 * - uncaught page errors are collected into the returned array
 */
/** Mirrors HELP_IDS in src/modules/helpGuidance.js. */
const HELP_IDS = [
  "first_note",
  "mode_pan",
  "mode_draw",
  "mode_text",
  "mode_eraser",
  "mode_lasso",
  "first_image",
  "mark_as_task",
];

export async function bootApp(
  page,
  { tauriResponses = {}, archive = {}, firstRunHelp = false, theme = "light" } = {},
) {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await installTauriMock(page, tauriResponses);
  await installFakeArchive(page, archive);
  await installFakeKeyring(page);
  // Same key theme.js persists to; the app reads it before first paint.
  await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
  if (!firstRunHelp) {
    // First-run tours open an overlay that intercepts clicks, as it should for a
    // new user. Tests that are not about the tours start as if they were done.
    await page.addInitScript((ids) => {
      for (const id of ids) localStorage.setItem(`noteberg_help_seen_${id}`, "1");
    }, HELP_IDS);
  }
  // "domcontentloaded", not "load": main.js is a module with top-level awaits
  // and its dynamic imports are tracked, so readiness is signalled by the app.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__noteberg?.initialized === true);
  return pageErrors;
}

/**
 * `page` that is already booted, in a fresh context (empty IndexedDB). Any
 * uncaught page error fails the test instead of scrolling past in a log.
 *
 * Per-test options (`test.use({...})`):
 *   tauriResponses  override/extend the mocked command table
 *   archive         entries served as the restore source (default: none)
 *   firstRunHelp    true to leave the first-run tours enabled (default: seen)
 *   theme           "light" (default) | "dark"
 */
export const test = base.extend({
  tauriResponses: [{}, { option: true }],
  archive: [{}, { option: true }],
  firstRunHelp: [false, { option: true }],
  theme: ["light", { option: true }],

  page: async ({ page, tauriResponses, archive, firstRunHelp, theme }, use) => {
    const pageErrors = await bootApp(page, { tauriResponses, archive, firstRunHelp, theme });
    await use(page);
    expect(pageErrors, "uncaught errors in the page").toEqual([]);
  },
});

export { expect };
