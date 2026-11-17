/**
 * Task details, derived from the note.
 *
 * A task is a marked headline; whatever the user wrote right below it is its
 * detail. Nothing is stored: the detail stays in the note, where it can be
 * drawn, edited, searched and exported, and the overview list only *shows* it.
 *
 *  - Text tasks: the lines after the headline's line; indentation and the next
 *    task decide whether there are any (see textDetailsFor).
 *  - Stroke tasks: the ink below the headline that is not part of any task,
 *    in the headline's column, up to the first vertical gap larger than a
 *    line, the next task's ink, or a height limit.
 */

const BLOCK_TAGS = new Set([
  "DIV",
  "P",
  "LI",
  "UL",
  "OL",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "TABLE",
  "TR",
  "TD",
  "TH",
]);

export const DEFAULT_DETAIL_LINES = 3;

/** Indentation added by one level of list nesting, in the same px as margin-left. */
const LIST_INDENT_STEP = 24;

/**
 * Flatten note HTML into visual lines: `{ text, taskIds, indent, listItem }`.
 *
 * A `<br>` always ends a line (so a blank line survives as an empty entry); a
 * block boundary ends one only when it holds something. `indent` is the sum of
 * the `margin-left` the editor's indent button sets on blocks, plus
 * LIST_INDENT_STEP per list nesting level, so only differences are meaningful.
 */
export function buildTextLines(html) {
  if (!html || typeof html !== "string") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = [];
  const fresh = () => ({ text: "", taskIds: new Set(), indent: 0, listItem: false });
  let line = fresh();
  let indent = 0;
  let inListItem = 0;

  const touch = () => {
    line.indent = indent;
    line.listItem = inListItem > 0;
  };
  const push = (force) => {
    if (force || line.text.trim() !== "" || line.taskIds.size > 0) lines.push(line);
    line = fresh();
  };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        line.text += child.data;
        if (child.data.trim() !== "") touch();
      } else if (child.nodeType === 1) {
        if (child.matches(".task-checkbox, .task-text-checkbox")) continue;
        if (child.tagName === "BR") {
          push(true);
        } else if (BLOCK_TAGS.has(child.tagName)) {
          push(false);
          const margin = Number.parseFloat(child.style?.marginLeft) || 0;
          const isList = child.tagName === "UL" || child.tagName === "OL";
          indent += margin + (isList ? LIST_INDENT_STEP : 0);
          if (child.tagName === "LI") inListItem++;
          walk(child);
          push(false);
          if (child.tagName === "LI") inListItem--;
          indent -= margin + (isList ? LIST_INDENT_STEP : 0);
        } else {
          if (child.matches(".task-text[data-task-id]")) {
            line.taskIds.add(child.dataset.taskId);
            touch();
          }
          walk(child);
        }
      }
    }
  };
  walk(doc.body);
  push(false);
  return lines;
}

/**
 * The detail lines following the line that holds `taskId`.
 *
 * Whether a detail exists is judged from the note's own structure:
 *  - the next line is blank, or is itself a task: no detail;
 *  - the next line is indented deeper than the headline: a detail, which lasts
 *    until the indentation is back at the headline's level (one blank line
 *    inside the indented run is part of it);
 *  - otherwise the lines that follow *may* be detail: they are taken up to the
 *    first blank line, next task, outdent, or (in a list) next peer item.
 *
 * @param {{text:string, taskIds:Set<string>, indent:number, listItem:boolean}[]} lines
 * @returns {string[]}
 */
export function textDetailsFor(lines, taskId, maxLines = DEFAULT_DETAIL_LINES) {
  const start = lines.findIndex((l) => l.taskIds.has(taskId));
  if (start < 0) return [];
  const head = lines[start];
  const isBlank = (l) => l.text.trim() === "";

  const first = lines[start + 1];
  if (!first || isBlank(first) || first.taskIds.size > 0) return [];
  const indented = first.indent > head.indent;

  const out = [];
  for (let i = start + 1; i < lines.length && out.length < maxLines; i++) {
    const l = lines[i];
    if (isBlank(l)) {
      const after = lines[i + 1];
      if (!indented || !after || isBlank(after) || after.taskIds.size > 0) break;
      if (after.indent <= head.indent) break;
      continue;
    }
    if (l.taskIds.size > 0) break;
    if (indented) {
      if (l.indent <= head.indent) break;
    } else {
      if (l.indent < head.indent) break;
      // A peer list item is a sibling, not a detail of the item above it.
      if (head.listItem && l.listItem && l.indent <= head.indent) break;
    }
    out.push(l.text.replace(/\s+/g, " ").trim());
  }
  return out;
}

function strokeBounds(stroke) {
  const xs = stroke.x;
  const ys = stroke.y;
  if (!xs || !ys || xs.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  return { minX, maxX, minY, maxY };
}

function unionBounds(items) {
  let b = null;
  for (const it of items) {
    if (!b) b = { ...it };
    else {
      b.minX = Math.min(b.minX, it.minX);
      b.maxX = Math.max(b.maxX, it.maxX);
      b.minY = Math.min(b.minY, it.minY);
      b.maxY = Math.max(b.maxY, it.maxY);
    }
  }
  return b;
}

const MIN_HEADLINE_HEIGHT = 20;
/** Largest vertical gap, in headline heights, that still belongs to the detail. */
const MAX_GAP_FACTOR = 1.5;
const MIN_GAP = 30;
/** How far below the headline the detail may reach, in headline heights. */
const MAX_EXTENT_FACTOR = 5;
/** How far left of the headline a detail stroke may start (indentation tolerance). */
const LEFT_TOLERANCE_FACTOR = 2;
const MIN_COLUMN_WIDTH = 800;

/**
 * Index a note's ink once so every task in it can be resolved cheaply.
 * @param {object[]} strokes - the note's strokes
 * @param {object[]} tasks - the note's live tasks (their strokeIds mark ink as taken)
 */
export function createStrokeDetailsIndex(strokes, tasks) {
  const owner = new Map();
  for (const task of tasks || []) {
    for (const id of task.strokeIds || []) owner.set(id, task.id);
  }
  const items = [];
  for (const stroke of strokes || []) {
    if (stroke._deleted || stroke.isDeleted) continue;
    const b = strokeBounds(stroke);
    if (b) items.push({ stroke, owner: owner.get(stroke.id) || null, ...b });
  }
  items.sort((a, b) => a.minY - b.minY);
  return { items };
}

/**
 * The strokes written directly below a stroke task's headline.
 * @param {ReturnType<typeof createStrokeDetailsIndex>} index
 * @param {string} taskId
 * @returns {object[]} strokes, possibly empty
 */
export function strokeDetailsFor(index, taskId) {
  const own = index.items.filter((it) => it.owner === taskId);
  const head = unionBounds(own);
  if (!head) return [];

  const height = Math.max(head.maxY - head.minY, MIN_HEADLINE_HEIGHT);
  const maxGap = Math.max(height * MAX_GAP_FACTOR, MIN_GAP);
  const maxBottom = head.maxY + height * MAX_EXTENT_FACTOR;
  const left = head.minX - height * LEFT_TOLERANCE_FACTOR;
  const right = head.minX + Math.max((head.maxX - head.minX) * 3, MIN_COLUMN_WIDTH);

  const out = [];
  let bottom = head.maxY;
  for (const it of index.items) {
    // Only ink that starts below the headline, in its column.
    if ((it.minY + it.maxY) / 2 <= head.maxY) continue;
    if (it.minX < left || it.minX > right) continue;
    if (it.owner) break; // the next task starts here
    if (it.minY - bottom > maxGap) break;
    if (it.maxY > maxBottom) break;
    out.push(it.stroke);
    bottom = Math.max(bottom, it.maxY);
  }
  return out;
}

const DIALOG_DETAIL_LINES = 8;

/**
 * Everything the properties dialog needs to show a task's details.
 * @param {{strokes?: object[], tasks?: object[], deletedTasks?: string[], content?: string}} note
 * @param {{id: string, type?: string, strokeIds?: string[]}} task
 * @returns {{text: string[], strokes: object[], referenceHeight: number|null}}
 */
export function deriveTaskDetails(note, task) {
  const empty = { text: [], strokes: [], referenceHeight: null };
  if (!note || !task) return empty;
  const deleted = new Set(Array.isArray(note.deletedTasks) ? note.deletedTasks : []);
  const live = (Array.isArray(note.tasks) ? note.tasks : []).filter((t) => !deleted.has(t.id));
  const isStroke = (task.type || (task.strokeIds?.length ? "stroke" : "text")) === "stroke";

  if (!isStroke) {
    const lines = buildTextLines(note.content);
    return { ...empty, text: textDetailsFor(lines, task.id, DIALOG_DETAIL_LINES) };
  }
  const index = createStrokeDetailsIndex(note.strokes, live);
  const head = unionBounds(index.items.filter((it) => it.owner === task.id));
  return {
    ...empty,
    strokes: strokeDetailsFor(index, task.id),
    referenceHeight: head ? head.maxY - head.minY : null,
  };
}

/**
 * Derive a human-readable label for a task (from extractTasksFromNote's output):
 * for a "text" task, the plain text of the matching <span data-task-id> in the
 * note's HTML content; for a "stroke" task, the recognized words whose
 * strokeIds overlap the task's strokeIds, joined. Returns "" if no label could
 * be derived (caller decides the fallback — see renderTaskItem below).
 * Exported so the MCP bridge (get_task_markers) can reuse the same derivation
 * instead of duplicating it.
 * @param {object} task
 * @returns {string}
 */
export function deriveTaskLabel(task) {
  if (task.customTitle) return task.customTitle;
  if (task.type === "text") {
    if (task.text) return task.text;
    if (task.noteContent) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(task.noteContent, "text/html");
      const span = doc.querySelector(`[data-task-id="${task.id}"]`);
      return span?.textContent || "";
    }
  }
  if (task.type === "stroke" && task.recognition?.words && task.strokeIds?.length > 0) {
    const taskStrokeIds = new Set(task.strokeIds);
    const matchedWords = task.recognition.words.filter((word) =>
      word.strokeIds?.some((id) => taskStrokeIds.has(id)),
    );
    if (matchedWords.length > 0) {
      return matchedWords.map((w) => w.text).join(" ");
    }
  }
  return "";
}

/**
 * The text recognition (or the note's own text) already holds for a task, offered
 * as the dialog's default title. Raw note tasks carry no label, so it is derived
 * the same way the task list derives one.
 * @returns {string}
 */
export function deriveSuggestedTitle(note, task) {
  if (!note || !task) return "";
  let recognition = note.recognition;
  if (typeof recognition === "string") {
    try {
      recognition = JSON.parse(recognition);
    } catch (_e) {
      recognition = null;
    }
  }
  const type = task.type || (task.strokeIds?.length ? "stroke" : "text");
  return deriveTaskLabel({
    ...task,
    type,
    customTitle: "",
    text: "",
    recognition,
    noteContent: note.content || "",
  }).trim();
}
