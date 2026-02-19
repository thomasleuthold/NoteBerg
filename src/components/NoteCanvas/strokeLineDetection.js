/**
 * strokeLineDetection.js
 *
 * Detects text lines within a set of selected strokes by computing a vertical
 * stroke-density histogram and finding low-density valleys between lines.
 */

const BIN_SIZE = 3; // px per histogram bin (content coordinates)
const SMOOTHING_WINDOW = 3; // bins on each side for moving average (~30px total)
const VALLEY_THRESHOLD_RATIO = 0.25; // bin must be below this fraction of peak to count as valley
const MIN_LINE_HEIGHT_PX = 20; // minimum height of a text band to be considered a real line
const MIN_INDENT_PX = 25; // minimum X offset from leftmost line to count as indented

/**
 * Detect horizontal line separators within a set of strokes.
 *
 * @param {Array} strokes - Full strokes array (noteData.strokes)
 * @param {Set<number>} selectedIndices - Indices of selected strokes
 * @returns {{ separatorYs: number[], lineGroups: Array<Set<number>> }}
 *   separatorYs  - Y positions (content coords) of detected line boundaries (midpoints of valleys)
 *   lineGroups   - One Set<strokeIndex> per detected text line, top-to-bottom order
 */
export function detectStrokeLines(strokes, selectedIndices) {
  if (selectedIndices.size === 0) return { separatorYs: [], lineGroups: [] };

  // --- 1. Collect selected strokes and their Y extents ---
  const selected = [];
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;

  for (const idx of selectedIndices) {
    const stroke = strokes[idx];
    if (!stroke || stroke._deleted || stroke.isDeleted) continue;

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < stroke.y.length; i++) {
      if (stroke.y[i] < minY) minY = stroke.y[i];
      if (stroke.y[i] > maxY) maxY = stroke.y[i];
    }
    if (minY === Infinity) continue;

    selected.push({ idx, stroke, minY, maxY });
    if (minY < globalMinY) globalMinY = minY;
    if (maxY > globalMaxY) globalMaxY = maxY;
  }

  if (selected.length === 0) return { separatorYs: [], lineGroups: [] };

  // --- 2. Build density histogram (raw point count per bin) ---
  // Raw counts work well: dots/accents have genuinely few points and sit
  // well below the threshold without normalization. Normalization by span
  // caused dots to spike (tiny span → artificially high density/px).
  const numBins = Math.ceil((globalMaxY - globalMinY) / BIN_SIZE) + 1;
  const histogram = new Float32Array(numBins);

  for (const { stroke } of selected) {
    for (let i = 0; i < stroke.y.length; i++) {
      const bin = Math.floor((stroke.y[i] - globalMinY) / BIN_SIZE);
      if (bin >= 0 && bin < numBins) histogram[bin]++;
    }
  }

  // --- 3. Smooth with a moving average ---
  const smoothed = new Float32Array(numBins);
  for (let b = 0; b < numBins; b++) {
    let sum = 0;
    let count = 0;
    for (let d = -SMOOTHING_WINDOW; d <= SMOOTHING_WINDOW; d++) {
      const nb = b + d;
      if (nb >= 0 && nb < numBins) {
        sum += histogram[nb];
        count++;
      }
    }
    smoothed[b] = sum / count;
  }

  // --- 4. Find valleys (regions below threshold) ---
  const peak = Math.max(...smoothed);
  if (peak === 0) return { separatorYs: [], lineGroups: [] };
  const threshold = peak * VALLEY_THRESHOLD_RATIO;

  // Collect contiguous below-threshold regions
  const valleys = []; // [{startBin, endBin}]
  let inValley = false;
  let valleyStart = 0;

  for (let b = 0; b < numBins; b++) {
    if (smoothed[b] <= threshold) {
      if (!inValley) {
        inValley = true;
        valleyStart = b;
      }
    } else {
      if (inValley) {
        inValley = false;
        // Ignore valleys at the very start — those are just the top margin
        if (valleyStart > 0) {
          valleys.push({ startBin: valleyStart, endBin: b - 1 });
        }
      }
    }
  }
  // Don't push a trailing valley — it's just the bottom margin

  // Filter out valleys where the text band above or below is too narrow to
  // be a real line (e.g. the gap between a dot-of-i and the letter body).
  const minBands = MIN_LINE_HEIGHT_PX / BIN_SIZE;
  const validValleys = valleys.filter(({ startBin, endBin }) => {
    const bandAbove = startBin; // bins from top to valley start
    const bandBelow = numBins - 1 - endBin; // bins from valley end to bottom
    return bandAbove >= minBands && bandBelow >= minBands;
  });

  if (validValleys.length === 0) {
    // Single line — all strokes in one group
    return {
      separatorYs: [],
      lineGroups: [new Set(selected.map((s) => s.idx))],
    };
  }

  // --- 5. Convert valley midpoints to content Y coordinates ---
  const separatorYs = validValleys.map(({ startBin, endBin }) => {
    const midBin = (startBin + endBin) / 2;
    return globalMinY + midBin * BIN_SIZE;
  });

  // --- 6. Assign each stroke to a line group based on its vertical midpoint ---
  const lineGroupCount = separatorYs.length + 1;
  const lineGroups = Array.from({ length: lineGroupCount }, () => new Set());

  for (const { idx, minY, maxY } of selected) {
    const strokeMidY = (minY + maxY) / 2;
    let group = 0;
    for (let s = 0; s < separatorYs.length; s++) {
      if (strokeMidY > separatorYs[s]) group = s + 1;
    }
    lineGroups[group].add(idx);
  }

  // Remove empty groups (can happen if a separator lands oddly)
  const nonEmpty = lineGroups.filter((g) => g.size > 0);

  return { separatorYs, lineGroups: nonEmpty };
}

/**
 * Detect indentation level for each line group.
 * A line is considered indented if its leftmost X is significantly greater
 * than the leftmost X across all lines.
 *
 * @param {Array} strokes - Full strokes array
 * @param {Array<Set<number>>} lineGroups - Output from detectStrokeLines
 * @param {number} indentThreshold - Min X offset (content px) to count as indented
 * @returns {number[]} indentation level per line group (0 = base, 1 = indented)
 */
export function detectLineIndentation(strokes, lineGroups, indentThreshold = MIN_INDENT_PX) {
  const leftmostX = lineGroups.map((group) => {
    let minX = Infinity;
    for (const idx of group) {
      const stroke = strokes[idx];
      if (!stroke) continue;
      for (let i = 0; i < stroke.x.length; i++) {
        if (stroke.x[i] < minX) minX = stroke.x[i];
      }
    }
    return minX === Infinity ? 0 : minX;
  });

  // Compare each line against the previous line, not the global minimum.
  // This prevents cumulative X drift across lines from being detected as indentation.
  return leftmostX.map((x, i) => {
    if (i === 0) return 0; // first line is always the baseline
    return x - leftmostX[i - 1] > indentThreshold ? 1 : 0;
  });
}
