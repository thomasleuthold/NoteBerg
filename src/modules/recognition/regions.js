/**
 * Region-based localization.
 *
 * Vision models do not produce trustworthy word coordinates. Measured across
 * several models, reported rows land on an invented uniform pitch and drift by
 * more than a line height — enough that a highlight lands on the wrong text,
 * and far too coarse to associate a word with the strokes that formed it.
 *
 * Rather than keep correcting bad coordinates, this asks a question models
 * answer reliably: "which coloured band is this word on?" That is perception,
 * not measurement. The result is deliberately imprecise — a band, not a box —
 * so nothing downstream can overstate what is known.
 *
 * Bands run horizontally because notes are much taller than wide and text spans
 * the full width: on a 15-line page, six bands put ~2.5 lines in each, whereas
 * a 2x3 grid would put ~5 lines in a region half as wide.
 */

/** Number of horizontal bands a page is divided into. */
export const REGION_COUNT = 6;

/**
 * Band colours, top to bottom.
 *
 * Chosen to be unmistakable from one another rather than pretty: adjacent hues
 * are far apart on the colour wheel, so a model confusing two bands has to
 * confuse, say, blue with orange rather than two shades of the same colour.
 *
 * Very pale (roughly 8% saturation) so handwriting stays the most legible thing
 * in the image — the colour is a label, not decoration.
 */
export const REGION_COLORS = [
  { id: "blue", fill: "#e8f0fb", name: "blue" },
  { id: "green", fill: "#e8f7ec", name: "green" },
  { id: "yellow", fill: "#fdf6e0", name: "yellow" },
  { id: "orange", fill: "#fdefe4", name: "orange" },
  { id: "pink", fill: "#fbeaf1", name: "pink" },
  { id: "purple", fill: "#f0ebfa", name: "purple" },
];

/**
 * Look up a band by the id a model reported.
 *
 * Tolerant of how models phrase it: an index, a colour name, or a name with
 * surrounding words ("the green band"). A model that answers usefully but not
 * in the exact requested form should not lose its answer.
 *
 * @param {unknown} reported
 * @returns {number} band index, or -1 when unrecognised
 */
export function parseRegionId(reported) {
  if (typeof reported === "number" && Number.isInteger(reported)) {
    return reported >= 0 && reported < REGION_COUNT ? reported : -1;
  }
  if (typeof reported !== "string") return -1;

  const text = reported.trim().toLowerCase();
  if (text === "") return -1;

  // A bare number, possibly 1-based as a person would write it.
  const asNumber = Number(text);
  if (Number.isInteger(asNumber)) {
    if (asNumber >= 0 && asNumber < REGION_COUNT) return asNumber;
    if (asNumber >= 1 && asNumber <= REGION_COUNT) return asNumber - 1;
    return -1;
  }

  const index = REGION_COLORS.findIndex((c) => text.includes(c.name));
  return index;
}

/**
 * Content-space Y bounds of one band on one rendered image.
 *
 * Bands divide a single image, not the whole note: on a long note a
 * note-spanning band would cover hundreds of lines and locate nothing. The
 * image is identified separately, so a band is only meaningful together with
 * the image it came from.
 *
 * @param {number} index - band index within the image
 * @param {{contentY: number, contentHeight: number}} image - the rendered slice
 * @returns {{top: number, bottom: number}|null}
 */
export function regionBounds(index, image) {
  if (!image || index < 0 || index >= REGION_COUNT) return null;
  if (!(image.contentHeight > 0)) return null;

  const bandHeight = image.contentHeight / REGION_COUNT;
  return {
    top: image.contentY + index * bandHeight,
    bottom: image.contentY + (index + 1) * bandHeight,
  };
}

/**
 * Encode a band and the image it was seen on as one stored value.
 *
 * A colour alone is ambiguous once a note spans several images — every image
 * repeats the same six colours. Pairing them keeps a stored region resolvable
 * back to a unique place in the note.
 *
 * @param {number} imageIndex
 * @param {number} regionIndex
 * @returns {string}
 */
export function encodeRegion(imageIndex, regionIndex) {
  return `${REGION_COLORS[regionIndex].name}-${imageIndex}`;
}

/**
 * Decode a stored region back into its image and band.
 *
 * Accepts the bare colour of older data, treating it as image 0 — the common
 * case, since a note short enough to render as one image has no ambiguity.
 *
 * @param {unknown} stored
 * @returns {{imageIndex: number, regionIndex: number}|null}
 */
export function decodeRegion(stored) {
  if (typeof stored === "number") {
    return stored >= 0 && stored < REGION_COUNT ? { imageIndex: 0, regionIndex: stored } : null;
  }
  if (typeof stored !== "string") return null;

  const [namePart, imagePart] = stored.split("-");
  const regionIndex = parseRegionId(namePart);
  if (regionIndex < 0) return null;

  const imageIndex = Number(imagePart);
  return {
    imageIndex: Number.isInteger(imageIndex) && imageIndex >= 0 ? imageIndex : 0,
    regionIndex,
  };
}

/**
 * Which band a content-space Y coordinate falls in.
 *
 * Used to derive a region for results that already carry exact geometry — the
 * Windows sidecar — so region search behaves identically regardless of which
 * engine produced the recognition.
 *
 * @param {number} y
 * @param {{contentY: number, contentHeight: number}} image
 * @returns {number} band index, or -1
 */
export function regionForY(y, image) {
  if (!image || typeof y !== "number") return -1;
  if (!(image.contentHeight > 0)) return -1;

  const fraction = (y - image.contentY) / image.contentHeight;
  // Clamp rather than reject: a stroke a pixel outside the computed bounds
  // belongs to the nearest band, not to nothing.
  const index = Math.floor(Math.min(0.999999, Math.max(0, fraction)) * REGION_COUNT);
  return index;
}

/**
 * Describe the bands for a prompt, top to bottom.
 *
 * @returns {string}
 */
export function describeRegions() {
  return REGION_COLORS.map((c, i) => `${i + 1}. ${c.name}`).join(", ");
}

/**
 * Merge overlapping or adjacent highlight bands into contiguous spans.
 *
 * Two matches in neighbouring bands cover one continuous region of the page, so
 * they should read as a single highlight. Painting them as separate rectangles
 * leaves a hairline seam between them that looks like a rendering fault.
 *
 * Merging by geometry rather than by word identity is deliberate: the same word
 * may legitimately appear twice in one span, and two *different* matching words
 * in adjacent bands should also merge into one highlight rather than two
 * abutting ones.
 *
 * @param {Array<{y: number, h: number, region: number}>} bands
 * @returns {Array<{y: number, h: number, region: number}>} sorted, non-overlapping
 */
export function mergeAdjacentBands(bands) {
  if (!Array.isArray(bands) || bands.length === 0) return [];

  // Copy each band, not just the array: merging widens the accumulating band in
  // place, which would otherwise reach back and corrupt the caller's data.
  const sorted = bands.map((b) => ({ ...b })).sort((a, b) => a.y - b.y);
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    const lastBottom = last.y + last.h;

    // Touching counts as overlapping: two abutting bands are one visual span,
    // and leaving a hairline seam between them looks like a rendering fault.
    if (current.y <= lastBottom) {
      const bottom = Math.max(lastBottom, current.y + current.h);
      last.h = bottom - last.y;
      continue;
    }

    merged.push({ ...current });
  }

  return merged;
}
