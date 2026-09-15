/**
 * Virtual page geometry.
 *
 * A note is one continuous scroll, but it is divided into A4-sized pages for
 * export, for the dashed page-break lines drawn on the canvas, and for
 * recognition. Those three must agree: a user who avoids writing across a
 * visible page break expects that to mean something, and it only does if every
 * consumer computes the boundary the same way.
 *
 * Previously each place derived it independently from the same magic numbers,
 * so a change in one would silently desynchronise the others.
 */

/** A4 dimensions in PDF points. */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

/**
 * Height of one virtual page in content pixels.
 *
 * The note's content width maps to A4's width, so the page height follows from
 * A4's aspect ratio: a page is as tall, relative to the note's width, as A4 is
 * tall relative to its own.
 *
 * @param {number} contentWidth - note content width in px (NoteCanvas maxContentWidth)
 * @returns {number} page height in content px
 */
export function pageHeight(contentWidth) {
  return A4_HEIGHT_PT / (A4_WIDTH_PT / contentWidth);
}

/**
 * Every virtual page overlapping a content-space Y range.
 *
 * Used to split a note into page-aligned images: recognition renders one image
 * per page so a word never straddles two images, which is what the page-break
 * lines promise the user.
 *
 * @param {number} minY - top of the range
 * @param {number} maxY - bottom of the range
 * @param {number} contentWidth
 * @returns {Array<{index: number, top: number, bottom: number}>}
 */
export function pagesInRange(minY, maxY, contentWidth) {
  const height = pageHeight(contentWidth);
  if (!(height > 0) || !(maxY > minY)) return [];

  // Pages are not clamped at zero. Content can sit above the origin — undoing an
  // "insert space" shift moves strokes up with no clamp — and clamping here
  // dropped that ink from every page, so recognition rendered a blank image and
  // reported no handwriting. A negative index is a page above the origin, which
  // is exactly what such a note has.
  const first = Math.floor(minY / height);
  const last = Math.floor(Math.max(minY, maxY - 1e-6) / height);

  const pages = [];
  for (let i = first; i <= last; i++) {
    pages.push({ index: i, top: i * height, bottom: (i + 1) * height });
  }
  return pages;
}
