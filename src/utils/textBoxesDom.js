/**
 * A note's text as static boxes at their positions, for places that show the
 * page without the editor: the overview thumbnail and the PDF export (text
 * boxes DESIGN §8). The same elements and classes the editor's text layer
 * renders, laid out by src/styles/textBoxes.css, without frames or handles;
 * with the task checkboxes the editor shows (text tasks in the text, stroke
 * tasks beside their ink).
 */

import { MAIN_BOX_GEOMETRY, parseContent } from "../modules/textBoxes.js";
import { sanitizeNoteHtml } from "./sanitizeHtml.js";
import { strokeTaskCheckboxes } from "./taskCheckboxes.js";

/** One text line (16 px × 1.5); a box without a place goes this far below the lowest. */
const LINE_HEIGHT = 24;

/** A text task's checkbox before its text, and its text struck through when done. */
function addTextTaskCheckboxes(root, tasks) {
  const textTasks = new Map(
    (tasks ?? []).filter((task) => task.type === "text").map((task) => [task.id, task]),
  );
  if (textTasks.size === 0) return;
  for (const span of root.querySelectorAll(".task-text[data-task-id]")) {
    const task = textTasks.get(span.dataset.taskId);
    if (!task) continue;
    const checkbox = root.ownerDocument.createElement("span");
    checkbox.className = task.checked
      ? "task-text-checkbox task-text-checkbox--checked"
      : "task-text-checkbox";
    span.parentNode.insertBefore(checkbox, span);
    span.classList.toggle("task-text--done", Boolean(task.checked));
  }
}

/**
 * Fill `root` (a `.text-boxes` element, already in a document so it can be
 * laid out) with the note's text boxes and task checkboxes.
 * @param {HTMLElement} root - its owner document is used to create elements
 * @param {string} html - note.content (untrusted; sanitized here)
 * @param {{tasks?: Array, strokes?: Array}} [note] - for the task checkboxes
 * @returns {number} the height the boxes and checkboxes take, in content px
 */
export function renderStaticTextBoxes(root, html, { tasks = [], strokes = [] } = {}) {
  const doc = root.ownerDocument;
  const { main, boxes } = parseContent(sanitizeNoteHtml(html || ""));
  root.replaceChildren();
  root.classList.add("text-boxes", "text-boxes--static");

  const make = (className, inner) => {
    const box = doc.createElement("div");
    box.className = className;
    const content = doc.createElement("div");
    content.className = "text-box__content";
    content.innerHTML = inner;
    addTextTaskCheckboxes(content, tasks);
    box.appendChild(content);
    root.appendChild(box);
    return box;
  };

  let lowest = 0;
  if (main !== "") lowest = make("text-box text-box--main", main).offsetHeight;
  const unplaced = [];
  for (const model of boxes) {
    const el = make("text-box", model.html);
    el.style.left = `${model.x}px`;
    el.style.width = `${model.w}px`;
    if (model.y === null) {
      unplaced.push(el);
      continue;
    }
    el.style.top = `${model.y}px`;
    lowest = Math.max(lowest, model.y + el.offsetHeight);
  }
  // Missing or broken geometry: below the lowest content, as the editor places it
  for (const el of unplaced) {
    const y = lowest + LINE_HEIGHT;
    el.style.top = `${y}px`;
    if (!el.style.left) el.style.left = `${MAIN_BOX_GEOMETRY.x}px`;
    lowest = y + el.offsetHeight;
  }

  // Stroke tasks: their checkbox left of the ink, as in the editor
  for (const checkbox of strokeTaskCheckboxes(tasks, strokes)) {
    const el = doc.createElement("div");
    el.className = "text-boxes__stroke-task";
    el.setAttribute("aria-checked", String(checkbox.checked));
    Object.assign(el.style, {
      left: `${checkbox.x}px`,
      top: `${checkbox.y}px`,
      width: `${checkbox.size}px`,
      height: `${checkbox.size}px`,
    });
    root.appendChild(el);
    lowest = Math.max(lowest, checkbox.y + checkbox.size);
  }
  return lowest;
}

/** Whether a note shows anything renderStaticTextBoxes draws: text, or a stroke task. */
export function hasStaticTextBoxes(note) {
  return Boolean(note?.content) || strokeTaskCheckboxes(note?.tasks, note?.strokes).length > 0;
}
