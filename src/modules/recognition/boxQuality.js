/**
 * Box-quality metrics for comparing recognition backends.
 *
 * Word-box accuracy is the hardest thing to judge by eye: a highlight that
 * lands one line away looks like a small error, but it is the difference
 * between a usable and a misleading highlight. These metrics turn "the boxes
 * feel off" into numbers that can be compared across models (PLAN Phase 3).
 *
 * The reference is the note's own strokes, which are exact. No ground-truth
 * transcription is needed — only whether each reported box actually sits on ink.
 */

/** Bounding box of a single stroke, in content space. */
function boundsOf(stroke) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < stroke.x.length; i++) {
    if (stroke.x[i] < minX) minX = stroke.x[i];
    if (stroke.x[i] > maxX) maxX = stroke.x[i];
    if (stroke.y[i] < minY) minY = stroke.y[i];
    if (stroke.y[i] > maxY) maxY = stroke.y[i];
  }
  return { minX, minY, maxX, maxY };
}

/** Whether a stroke's bounds overlap a reported word box at all. */
function overlaps(b, rect) {
  return (
    b.maxX >= rect.x &&
    b.minX <= rect.x + rect.width &&
    b.maxY >= rect.y &&
    b.minY <= rect.y + rect.height
  );
}

/**
 * Score how well a recognition result's boxes sit on the note's actual ink.
 *
 * Two numbers matter, and they fail differently:
 *
 * - `emptyBoxRatio` — boxes containing no ink at all. These are the visible
 *   failures: a highlight drawn over blank paper.
 * - `medianDriftY` — how far boxes sit from the nearest ink vertically. A
 *   consistent non-zero drift means a systematic offset (correctable); scattered
 *   values mean the model is guessing per-word (not correctable without better
 *   geometry).
 *
 * @param {Array} words - stored recognition words with boundingRect
 * @param {Array} strokes - the note's active strokes, content space
 * @returns {{boxCount: number, emptyBoxRatio: number, medianDriftY: number,
 *            medianDriftX: number, gridLikeness: number}}
 */
export function scoreBoxes(words, strokes) {
  const boxed = (words || []).filter((w) => w?.boundingRect);
  if (boxed.length === 0 || !strokes?.length) {
    return {
      boxCount: 0,
      emptyBoxRatio: 1,
      medianDriftY: Number.NaN,
      medianDriftX: Number.NaN,
      gridLikeness: Number.NaN,
    };
  }

  const strokeBoxes = strokes.filter((s) => s?.x?.length).map(boundsOf);

  let empty = 0;
  const driftsY = [];
  const driftsX = [];

  for (const word of boxed) {
    const rect = word.boundingRect;
    const hit = strokeBoxes.some((b) => overlaps(b, rect));
    if (!hit) empty++;

    // Distance from the box centre to the nearest stroke centre. Signed on Y so
    // a consistent offset is distinguishable from scatter.
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;

    let bestDist = Infinity;
    let bestDy = 0;
    let bestDx = 0;
    for (const b of strokeBoxes) {
      const sx = (b.minX + b.maxX) / 2;
      const sy = (b.minY + b.maxY) / 2;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < bestDist) {
        bestDist = d;
        bestDy = cy - sy;
        bestDx = cx - sx;
      }
    }
    driftsY.push(bestDy);
    driftsX.push(bestDx);
  }

  return {
    boxCount: boxed.length,
    emptyBoxRatio: empty / boxed.length,
    medianDriftY: median(driftsY),
    medianDriftX: median(driftsX),
    gridLikeness: gridLikeness(boxed),
  };
}

/**
 * How closely the reported row positions fall on a single uniform pitch.
 *
 * A model that measures real text produces irregular row spacing, because real
 * notes have irregular line spacing. A model that *invents* a layout emits an
 * evenly-spaced grid. A value near 1 means "suspiciously regular", which is the
 * signature of guessed rather than observed geometry — and it means no amount of
 * prompt tuning will help.
 *
 * @param {Array} boxed - words with boundingRect
 * @returns {number} 0..1
 */
export function gridLikeness(boxed) {
  const tops = [...new Set(boxed.map((w) => Math.round(w.boundingRect.y * 100) / 100))].sort(
    (a, b) => a - b,
  );
  if (tops.length < 3) return Number.NaN;

  const gaps = [];
  for (let i = 1; i < tops.length; i++) gaps.push(tops[i] - tops[i - 1]);

  // Fraction of gaps equal to the most common gap.
  const counts = new Map();
  for (const g of gaps) {
    const key = Math.round(g * 1000);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const mode = Math.max(...counts.values());
  return mode / gaps.length;
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
