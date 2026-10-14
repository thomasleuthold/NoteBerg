import { expect } from "@playwright/test";

/**
 * Computed-style helpers. Unit tests run under jsdom without the app's CSS, so
 * "the selected state is actually visible" can only be checked here.
 *
 * Deliberately compares one element to another instead of asserting colours:
 * a theme tweak should not break these tests, a missing or losing CSS rule
 * should.
 */

/** Properties through which a "selected" state is conveyed. */
const LOOK_PROPS = [
  "backgroundColor",
  "borderTopColor",
  "boxShadow",
  "outlineStyle",
  "outlineColor",
  "color",
  "transform",
  "opacity",
  "fontWeight",
];

/** Snapshot of the properties that make a control look selected. */
export function lookOf(locator) {
  return locator.evaluate((el, props) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs[p]]));
  }, LOOK_PROPS);
}

/**
 * Assert that `selected` looks different from `unselected` (a sibling control of
 * the same kind that is not selected). Polls so CSS transitions can settle, and
 * names the properties compared when it fails.
 */
export async function expectVisiblySelected(selected, unselected, what = "control") {
  // The pointer and keyboard focus sit on the control that was just clicked;
  // hover and focus styles must not be mistaken for (or mask) the selected
  // styling.
  await selected.page().mouse.move(0, 0);
  await selected.page().evaluate(() => document.activeElement?.blur());

  await expect
    .poll(
      async () => {
        const [a, b] = await Promise.all([lookOf(selected), lookOf(unselected)]);
        return LOOK_PROPS.filter((p) => a[p] !== b[p]);
      },
      {
        message: `${what}: selected state is not visually distinguishable from the unselected one (computed styles identical — CSS for the selected state is missing or overridden)`,
      },
    )
    .not.toEqual([]);
}
