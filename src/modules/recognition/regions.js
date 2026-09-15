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
 * Chosen to be unmistakable from one another rather than pretty, and separated
 * by measured RGB distance rather than by position on the hue wheel.
 *
 * That distinction is the whole point of this palette's second version. The
 * first one picked hues far apart on the wheel and then made them very pale
 * (~8% saturation, ~95% lightness) on the theory that distant hues stay
 * distinct. They do not: at that lightness every colour is crushed into a small
 * corner of RGB space, and the six ended up as little as 8 units apart out of a
 * possible 441 — closer to each other than to white by any useful margin.
 *
 * The observed failure was pink read as purple (hues 335° and 260°, a wheel
 * apart, but 14 units apart in RGB): two lines of a note were placed a whole
 * band below where they were written. Pink is now red, which sits further from
 * purple, and every colour is darker and more saturated, which is what actually
 * buys separation. The closest pair is now ~15 units, and the pair that failed
 * is ~38.
 *
 * Still pale enough that handwriting is by far the darkest thing in the image —
 * the lightest channel of any band is above 200, against near-zero ink. The
 * colour is a label, not decoration.
 *
 * When changing these, measure the worst pair rather than trusting the names:
 * "red" and "orange" sound distinct and are the closest pair here.
 */
export const REGION_COLORS = [
  { id: "blue", fill: "#dbe7fb", name: "blue" },
  { id: "green", fill: "#dcf3df", name: "green" },
  { id: "yellow", fill: "#fbf3cf", name: "yellow" },
  { id: "orange", fill: "#fbe0cc", name: "orange" },
  { id: "red", fill: "#fbd9d9", name: "red" },
  { id: "purple", fill: "#e6dcf8", name: "purple" },
];

/**
 * Alternative names a model might use for each band, in band order.
 *
 * Kept parallel to REGION_COLORS rather than folded into it, so the list the
 * prompt offers stays exactly the six canonical names — an alias is something to
 * accept on the way in, not something to suggest.
 */
const REGION_ALIASES = [
  // Nothing for blue or green: every plausible alternative ("light blue",
  // "mint green") contains the canonical name and is matched by the pass above.
  [],
  [],
  ["cream", "beige"],
  ["peach"],
  ["pink", "salmon"],
  ["violet", "lavender"],
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
  if (index >= 0) return index;

  // A colour a model may reasonably call by another name. `red` is a pale pink
  // in fact (#fbd9d9), and a model describing what it sees rather than matching
  // the offered list is answering correctly — dropping that answer would lose a
  // word's placement over vocabulary.
  //
  // Checked after the exact names so an alias can never shadow a real one.
  return REGION_ALIASES.findIndex((names) => names.some((n) => text.includes(n)));
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
 * Resolve a band a model named into a content-space Y range.
 *
 * Done once, at recognition time, rather than stored as an index and resolved
 * on every read. Two reasons, and the second is the load-bearing one:
 *
 *   - An index is meaningless without the band scheme that produced it. Reading
 *     it back through whatever REGION_COUNT happens to be current silently
 *     reinterprets older results — adding a seventh band would have shifted
 *     every stored region with no error.
 *   - An index cannot be corrected when content moves. Inserting space shifts
 *     everything below a point downward; "the third of six slices" has no
 *     arithmetic expressing that, while a Y range is corrected by the same
 *     addition already applied to strokes.
 *
 * The result is still a band's worth of vertical extent — roughly two or three
 * lines — not a measurement. It must keep travelling with
 * `precision: "approximate"`.
 *
 * @param {number} index - band index within the image
 * @param {{contentY: number, contentHeight: number}} image - the rendered slice
 * @returns {{top: number, bottom: number}|null} null when unresolvable, in
 *   which case the word stays searchable but cannot be placed
 */
export function regionToContentRange(index, image) {
  return regionBounds(index, image);
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
