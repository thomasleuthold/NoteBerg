/**
 * A notebook's color as it may be put into markup. The value comes from the
 * notebook file, which for a notebook shared with the user another user wrote:
 * anything that is not a plain hex color is replaced, so it can never break out
 * of the `style` attribute it is interpolated into.
 */

export const DEFAULT_NOTEBOOK_COLOR = "#3b82f6";

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** @returns {string} `color` when it is a hex color, otherwise the default */
export function safeNotebookColor(color) {
  return typeof color === "string" && HEX_COLOR.test(color) ? color : DEFAULT_NOTEBOOK_COLOR;
}
