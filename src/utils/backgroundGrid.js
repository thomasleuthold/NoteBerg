/**
 * Line and grid spacing of the note backgrounds, in content px. One table for
 * everything that has to agree with the lines the user sees: the canvas
 * (drawBackgroundPattern in noteRenderer.js), the PDF export, and the snapping
 * of text boxes (text boxes DESIGN §5).
 */

export const BACKGROUND_SPACING = Object.freeze({
  "ruled-narrow": 20,
  "ruled-medium": 30,
  "ruled-wide": 40,
  "grid-small": 20,
  "grid-medium": 30,
  "grid-large": 40,
});

/** Whether a background draws vertical lines too (a grid, not only rules). */
export function isGridBackground(backgroundType) {
  return typeof backgroundType === "string" && backgroundType.startsWith("grid");
}

/** Snapping on a page without lines: the 24 px text line, 8 px across. */
const PLAIN_SNAP = Object.freeze({ x: 8, y: 24 });

/**
 * The grid text boxes snap to on a background: ruled pages snap vertically to
 * their lines, grid pages both ways to their squares, plain pages to the text
 * line height and 8 px.
 * @param {string} [backgroundType]
 * @returns {{x: number, y: number}}
 */
export function snapGrid(backgroundType) {
  const spacing = BACKGROUND_SPACING[backgroundType];
  if (!spacing) return PLAIN_SNAP;
  return isGridBackground(backgroundType)
    ? { x: spacing, y: spacing }
    : { x: PLAIN_SNAP.x, y: spacing };
}
