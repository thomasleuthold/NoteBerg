/**
 * Where a stroke task's checkbox goes: left of its strokes, vertically
 * centred on them, in content px. One rule for the editor's checkbox layer
 * (TaskCheckboxLayer), the overview thumbnail and the PDF export, so the
 * pictures of a note show the checkboxes where the note does.
 */

/** Checkbox size and gap to the strokes, in content px (at zoom 1). */
export const STROKE_CHECKBOX_SIZE = 22;
const STROKE_CHECKBOX_MARGIN = 8;

/**
 * Bounding box of a task's strokes that still exist, or null when none does.
 * @param {{strokeIds?: string[]}} task
 * @param {Array} strokes
 */
export function strokeTaskBounds(task, strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasValid = false;

  for (const strokeId of task.strokeIds ?? []) {
    const stroke = strokes.find((s) => s.id === strokeId);
    if (!stroke || stroke._deleted || stroke.isDeleted) continue;

    for (let i = 0; i < stroke.x.length; i++) {
      minX = Math.min(minX, stroke.x[i]);
      maxX = Math.max(maxX, stroke.x[i]);
      minY = Math.min(minY, stroke.y[i]);
      maxY = Math.max(maxY, stroke.y[i]);
    }
    hasValid = true;
  }

  return hasValid ? { minX, minY, maxX, maxY } : null;
}

/** Top-left corner of a stroke task's checkbox, from its strokes' bounds. */
export function strokeCheckboxOrigin(bounds) {
  return {
    x: bounds.minX - STROKE_CHECKBOX_SIZE - STROKE_CHECKBOX_MARGIN,
    y: (bounds.minY + bounds.maxY) / 2 - STROKE_CHECKBOX_SIZE / 2,
  };
}

/**
 * Checkboxes of a note's stroke tasks, in content px.
 * @param {Array} tasks - all of the note's tasks (other types are skipped)
 * @param {Array} strokes
 * @returns {{id: string, x: number, y: number, size: number, checked: boolean}[]}
 */
export function strokeTaskCheckboxes(tasks, strokes) {
  const out = [];
  for (const task of tasks ?? []) {
    if (task.type !== "stroke") continue;
    const bounds = strokeTaskBounds(task, strokes ?? []);
    if (!bounds) continue;
    out.push({
      id: task.id,
      ...strokeCheckboxOrigin(bounds),
      size: STROKE_CHECKBOX_SIZE,
      checked: Boolean(task.checked),
    });
  }
  return out;
}
