import { createQuickNote } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";
import { expectVisiblySelected } from "./support/styles.js";

// The class that marks a control selected is set by JS (unit-tested). That it
// LOOKS selected is CSS, which only a real browser applies — and which has
// broken before while every unit test stayed green. Each theme has its own
// rules (e.g. `.theme-dark` overrides), so both are covered.
for (const theme of ["light", "dark"]) {
  test.describe(`selected state is visible (${theme} theme)`, () => {
    test.use({ theme });

    test.beforeEach(async ({ page }) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await createQuickNote(page, "Toolbar");
    });

    test("mode buttons", async ({ page }) => {
      const pan = page.locator("#nc-tool-pan");
      for (const id of ["draw", "text", "lasso", "eraser"]) {
        const tool = page.locator(`#nc-tool-${id}`);
        await tool.click();
        await expectVisiblySelected(tool, pan, `${id} mode button`);
      }
    });

    test("pen presets", async ({ page }) => {
      await page.click("#nc-tool-draw");
      const presets = page.locator(".note-canvas-toolbar__preset-btn");
      await expect(presets.first()).toBeVisible();
      await expect(presets.first()).toHaveClass(/preset-btn--active/);

      await presets.nth(2).click();
      await expect(presets.nth(2)).toHaveClass(/preset-btn--active/);

      await expectVisiblySelected(
        presets.nth(2),
        presets.nth(0),
        "selected pen preset vs previous",
      );
      await expectVisiblySelected(presets.nth(2), presets.nth(1), "selected pen preset vs other");
    });

    test("pen colour swatches", async ({ page }) => {
      await page.click("#nc-tool-draw");
      await page.click(".note-canvas-toolbar__expand-btn"); // swatches live in the expanded panel
      const swatches = page.locator(".note-canvas-toolbar__color-swatch");
      await expect(swatches.first()).toBeVisible();

      await swatches.nth(1).click();
      await expect(swatches.nth(1)).toHaveClass(/color-swatch--active/);
      await expectVisiblySelected(swatches.nth(1), swatches.nth(2), "selected colour swatch");
    });

    test("eraser modes", async ({ page }) => {
      await page.click("#nc-tool-eraser");
      const modes = page.locator(".note-canvas-toolbar__eraser-mode-btn");
      await expect(modes.first()).toBeVisible();

      await modes.nth(1).click();
      await expect(modes.nth(1)).toHaveClass(/eraser-mode-btn--active/);
      await expectVisiblySelected(modes.nth(1), modes.nth(0), "selected eraser mode");
    });

    test("page backgrounds", async ({ page }) => {
      await page.click("#nc-tool-options");
      const backgrounds = page.locator(".background-option");
      await expect(backgrounds.first()).toBeVisible();

      await backgrounds.nth(2).click();
      await expect(backgrounds.nth(2)).toHaveClass(/option-btn--active/);
      await expectVisiblySelected(backgrounds.nth(2), backgrounds.nth(1), "selected background");
    });
  });
}
