import { generateId } from "../../modules/storage.js";

const CHECKMARK_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block; margin:1px auto;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

const BLOCK_TAGS = /^(p|div|li|blockquote|h[1-6]|ul|ol|table|pre|hr)$/i;

/**
 * Wrap bare inline lines at the editor root into <div> blocks.
 *
 * Contenteditable does not guarantee that every line lives in a block element:
 * the first typed line, and lines produced by Chromium when a list is converted
 * back to normal text, sit as bare text/inline nodes (separated by <br>)
 * directly under the editor. All block-based operations (mark/unmark task,
 * indent) silently no-op on such lines. Normalizing them into <div>s first
 * makes those operations work uniformly.
 *
 * The current selection is preserved across the re-parenting.
 *
 * @param {HTMLElement} editorElement
 * @returns {boolean} Whether the DOM was changed
 */
export function normalizeBareLines(editorElement) {
  if (!editorElement) return false;

  const isBlock = (n) => n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.test(n.tagName);
  const isBr = (n) => n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() === "br";
  const isWhitespace = (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length === 0;

  const needsWrap = Array.from(editorElement.childNodes).some(
    (n) => !isBlock(n) && !isWhitespace(n),
  );
  if (!needsWrap) return false;

  const saved = _saveSelection(editorElement);

  let run = [];
  const wrapRun = (refNode, extraNode) => {
    const div = document.createElement("div");
    editorElement.insertBefore(div, refNode);
    for (const n of run) div.appendChild(n);
    if (extraNode) div.appendChild(extraNode);
    run = [];
  };

  for (const child of Array.from(editorElement.childNodes)) {
    if (isBlock(child)) {
      if (run.some((n) => !isWhitespace(n))) wrapRun(child);
      run = [];
    } else if (isBr(child)) {
      if (run.some((n) => !isWhitespace(n))) {
        // Non-empty line: the wrapping <div> replaces the <br> as line break
        wrapRun(child);
        child.remove();
      } else {
        // Empty line: keep the <br> as the line's placeholder inside its block
        wrapRun(child, child);
      }
    } else {
      run.push(child);
    }
  }
  if (run.some((n) => !isWhitespace(n))) wrapRun(null);

  _restoreSelection(saved);
  return true;
}

/** @private Capture the current selection as plain container/offset values. */
function _saveSelection(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  return {
    sel,
    startContainer: r.startContainer,
    startOffset: r.startOffset,
    endContainer: r.endContainer,
    endOffset: r.endOffset,
  };
}

/** @private Best-effort restore of a selection captured by _saveSelection. */
function _restoreSelection(saved) {
  if (!saved) return;
  const clamp = (container, offset) =>
    Math.min(
      offset,
      container.nodeType === Node.TEXT_NODE
        ? container.textContent.length
        : container.childNodes.length,
    );
  try {
    const range = document.createRange();
    range.setStart(saved.startContainer, clamp(saved.startContainer, saved.startOffset));
    range.setEnd(saved.endContainer, clamp(saved.endContainer, saved.endOffset));
    saved.sel.removeAllRanges();
    saved.sel.addRange(range);
  } catch (_e) {
    // Selection restoration is best-effort
  }
}

export class TextTaskManager {
  /**
   * @param {HTMLElement} editorElement - The contenteditable editor element
   * @param {Object} callbacks - Callbacks for events
   * @param {Function} callbacks.onTaskCreate - (taskId) => void
   * @param {Function} callbacks.onTaskToggle - (taskId, checked) => void
   * @param {Function} callbacks.triggerChange - () => void (Trigger editor change event)
   */
  constructor(editorElement, callbacks) {
    this.editorElement = editorElement;
    this.callbacks = callbacks;
  }

  /**
   * Check if the given node is inside a task span
   * @param {Node} node - DOM node to check
   * @returns {boolean}
   */
  isInTask(node) {
    if (!node || !this.editorElement) return false;
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== this.editorElement) {
      if (el.classList?.contains("task-text") && el.dataset.taskId) return true;
      el = el.parentElement;
    }
    return false;
  }

  /**
   * Toggle task status on the current selection.
   *
   * A "line" is a <br>-delimited segment of a block; only lines the selection
   * actually touches are affected. Mode follows the usual toggle convention:
   * if every selected line is already a task, remove; otherwise add tasks to
   * the selected lines that don't have one yet.
   * @param {Object} trumbowygInstance - Trumbowyg instance
   */
  toggleTaskOnSelection(trumbowygInstance) {
    // Ensure editor has focus before executing command (execCommand requires focus)
    if (this.editorElement) {
      this.editorElement.focus();
    }

    // Restore range if saved by Trumbowyg (do this AFTER focus to ensure selection sticks)
    if (trumbowygInstance) {
      trumbowygInstance.restoreRange();
    }

    // Lines without a block wrapper (first typed line, Chromium's list→text
    // conversion) resolve to no block below and the toggle would no-op.
    normalizeBareLines(this.editorElement);

    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);

    if (!this.editorElement?.contains(range.commonAncestorContainer)) return;

    // Collect all blocks that intersect the selection
    const blocks = this._getBlocksInRange(range);
    if (blocks.length === 0) return;

    // Plan all blocks before mutating anything: DOM changes adjust live ranges,
    // which would skew the intersection checks for later blocks.
    const plans = blocks.map((block) => this._planSegments(block, range));

    const selectedSegments = plans.flat().filter((s) => s.selected && s.hasContent);
    if (selectedSegments.length === 0) return;
    const isRemoveMode = selectedSegments.every((s) => s.hasTask);

    for (let i = 0; i < blocks.length; i++) {
      if (isRemoveMode) {
        this._removeTasksFromSegments(blocks[i], plans[i]);
      } else {
        this._addTasksToSegments(blocks[i], plans[i]);
      }
    }

    // Trigger change event
    if (this.callbacks.triggerChange) {
      this.callbacks.triggerChange();
    }
  }

  /**
   * Find the closest block-level ancestor of a node within the editor.
   * @param {Node} node
   * @returns {HTMLElement|null}
   * @private
   */
  _getBlock(node) {
    if (!node) return null;
    if (node === this.editorElement) return null;

    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== this.editorElement) {
      if (/^(p|div|li|blockquote|h[1-6])$/i.test(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Climb from a node to the top-level element that is a direct child of the
   * editor. Used so the multi-block sibling walk iterates at the editor's own
   * child level, where list containers (ul/ol) appear as single units to be
   * expanded rather than raw siblings to be wrapped.
   * @param {Node} node
   * @returns {HTMLElement|null}
   * @private
   */
  _topLevelAncestor(node) {
    let el = node;
    while (el?.parentElement && el.parentElement !== this.editorElement) {
      el = el.parentElement;
    }
    return el?.parentElement === this.editorElement ? el : null;
  }

  /**
   * Expand an element into the leaf blocks a task may be applied to.
   * A leaf block (p, li, div, heading, …) yields itself. A list container
   * (ul/ol) — or any element that holds block-level children — yields its
   * child leaf blocks instead of itself, so we never wrap a whole <ul> (which
   * would move its <li>s into a span and corrupt the markup — see C-01).
   * @param {HTMLElement} el
   * @returns {HTMLElement[]}
   * @private
   */
  _expandToLeafBlocks(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return [];

    if (/^(ul|ol)$/i.test(el.tagName)) {
      const items = [];
      for (const li of el.children) {
        items.push(...this._expandToLeafBlocks(li));
      }
      return items;
    }

    // A leaf block that itself contains a nested list: wrap only its own
    // inline content is out of scope — treat it as a leaf so its text becomes
    // a task, but pull out any nested list items so they aren't swallowed.
    if (/^(p|div|li|blockquote|h[1-6])$/i.test(el.tagName)) {
      return [el];
    }

    // Unknown wrapper — descend into element children looking for leaf blocks.
    const collected = [];
    for (const child of el.children) {
      collected.push(...this._expandToLeafBlocks(child));
    }
    return collected;
  }

  /**
   * Resolve a range boundary (container + offset) to the actual node inside it.
   * When the container is the editor element, offset is a child index.
   * @param {Node} container
   * @param {number} offset
   * @returns {Node|null}
   * @private
   */
  _resolveRangeNode(container, offset) {
    if (container === this.editorElement) {
      // Offset is a child index; clamp to valid range
      const children = container.childNodes;
      if (children.length === 0) return null;
      const idx = Math.min(offset, children.length - 1);
      return children[idx];
    }
    return container;
  }

  /**
   * Resolve a range boundary node to a leaf block.
   * First tries climbing up (the node lives inside a block). If that finds
   * nothing — which happens when the boundary lands on a list container
   * (`ul`/`ol`) or the editor itself, e.g. when the whole list is selected —
   * descend into the node and take its first (or last) leaf block instead.
   * Without this, selecting an entire list resolves to no block and the whole
   * operation silently no-ops.
   * @param {Node} node
   * @param {boolean} preferLast - When descending, pick the last leaf block
   * @returns {HTMLElement|null}
   * @private
   */
  _resolveToBlock(node, preferLast) {
    const climbed = this._getBlock(node);
    if (climbed) return climbed;
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const leaves = this._expandToLeafBlocks(node);
    if (leaves.length === 0) return null;
    return preferLast ? leaves[leaves.length - 1] : leaves[0];
  }

  /**
   * Get all block elements that intersect the given range.
   * For a collapsed cursor, returns the single block containing the cursor.
   * @param {Range} range
   * @returns {HTMLElement[]}
   * @private
   */
  _getBlocksInRange(range) {
    const startNode = this._resolveRangeNode(range.startContainer, range.startOffset);
    let startBlock = this._resolveToBlock(startNode, false);

    // Collapsed cursor — just use the start block
    if (range.collapsed) {
      return startBlock ? [startBlock] : [];
    }

    // Triple-click often places the start at the very end of the previous
    // paragraph's text node (offset === textContent.length). That block isn't
    // meaningfully selected — advance to the next sibling block.
    if (
      startBlock &&
      range.startContainer.nodeType === Node.TEXT_NODE &&
      range.startOffset >= range.startContainer.textContent.length
    ) {
      const nextBlock = startBlock.nextElementSibling;
      if (nextBlock && this.editorElement.contains(nextBlock)) {
        startBlock = this._getBlock(nextBlock) || startBlock;
      }
    }

    const endNode = this._resolveRangeNode(range.endContainer, range.endOffset);
    const endBlock = this._resolveToBlock(endNode, true);

    // Triple-click: range ends at offset 0 of the next block — exclude it
    if (range.endOffset === 0 && endBlock && endBlock !== startBlock) {
      return startBlock ? [startBlock] : [];
    }

    // Same block
    if (startBlock && startBlock === endBlock) {
      return [startBlock];
    }

    // Different blocks — collect siblings from start to end.
    // startBlock/endBlock are leaf blocks (never a ul/ol, since _getBlock skips
    // list containers). Their common walk happens at the sibling level of
    // whichever ancestor chain they share; when a sibling is a list container
    // we expand it into its <li> leaves so each item becomes its own task
    // rather than wrapping the entire <ul> (C-01).
    if (startBlock && endBlock) {
      // Walk at the top level shared by both boundaries: climb each boundary to
      // the child of their nearest common walk level (direct children of the
      // editor, or of a shared list container).
      const startTop = this._topLevelAncestor(startBlock);
      const endTop = this._topLevelAncestor(endBlock);

      const blocks = [];
      let curr = startTop;
      while (curr) {
        blocks.push(...this._expandToLeafBlocks(curr));
        if (curr === endTop) break;
        curr = curr.nextElementSibling;
        if (!curr || !this.editorElement.contains(curr)) break;
      }

      // Trim to the actual selected leaves: drop any leaf before startBlock and
      // after endBlock (the expansion of the first/last container may include
      // siblings outside the selection).
      const startIdx = blocks.indexOf(startBlock);
      const endIdx = blocks.indexOf(endBlock);
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        return blocks.slice(startIdx, endIdx + 1);
      }
      return blocks;
    }

    // Fallback: at least the start block
    return startBlock ? [startBlock] : [];
  }

  /**
   * Split a block into its <br>-delimited line segments and annotate each with
   * what the toggle needs to know. A block may hold several visual lines \u2014
   * this is what a browser produces when a list is converted back to normal
   * text \u2014 and each line is marked/unmarked independently.
   * @param {HTMLElement} block
   * @param {Range} range - The current selection
   * @returns {{nodes: Node[], hasContent: boolean, hasTask: boolean, selected: boolean}[]}
   * @private
   */
  _planSegments(block, range) {
    const segments = this._splitBlockByBr(block).map((nodes) => ({
      nodes,
      hasContent: nodes.some(
        (n) => n.nodeType !== Node.TEXT_NODE || n.textContent.trim().length > 0,
      ),
      hasTask: nodes.some(
        (n) =>
          n.nodeType === Node.ELEMENT_NODE &&
          (n.matches(".task-text[data-task-id], .task-text-checkbox") ||
            !!n.querySelector(".task-text[data-task-id]")),
      ),
      selected: nodes.some((n) => range.intersectsNode(n)),
    }));

    // A block reached via container expansion (whole list selected) or a caret
    // sitting exactly on a segment boundary may intersect no node \u2014 treat the
    // whole block as selected rather than silently no-oping.
    if (!segments.some((s) => s.selected)) {
      for (const s of segments) s.selected = true;
    }
    return segments;
  }

  /**
   * Remove task markup from the selected segments of a block.
   * @param {HTMLElement} block
   * @param {ReturnType<TextTaskManager['_planSegments']>} segments
   * @private
   */
  _removeTasksFromSegments(block, segments) {
    for (const seg of segments) {
      if (!seg.selected) continue;
      for (const node of seg.nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const els = node.matches(".task-text, .task-text-checkbox") ? [node] : [];
        els.push(...node.querySelectorAll(".task-text, .task-text-checkbox"));
        for (const el of els) {
          if (el.classList.contains("task-text-checkbox")) {
            el.remove();
          } else {
            this._unwrapTaskSpan(el);
          }
        }
      }
    }
    block.normalize();
  }

  /**
   * Unwrap a task span, also dropping the single non-breaking space that was
   * appended after it at creation time (otherwise every mark/unmark cycle
   * leaks one \u00A0 into the text).
   * @param {HTMLElement} span
   * @private
   */
  _unwrapTaskSpan(span) {
    const next = span.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE && next.textContent.startsWith("\u00A0")) {
      next.textContent = next.textContent.slice(1);
      if (next.textContent.length === 0) next.remove();
    }
    while (span.firstChild) {
      span.parentNode.insertBefore(span.firstChild, span);
    }
    span.remove();
  }

  /**
   * Rebuild a block, wrapping each selected task-less line in task markup.
   * Unselected lines, empty lines, and lines that are already tasks are
   * re-appended unchanged (with their <br> separators).
   * @param {HTMLElement} block
   * @param {ReturnType<TextTaskManager['_planSegments']>} segments
   * @private
   */
  _addTasksToSegments(block, segments) {
    // Never wrap a list container or a block containing its own block children:
    // moving <li>/<ul>/<ol> into a <span> produces invalid markup that the
    // browser discards on the next parse, blanking the note (C-01). Callers
    // should have expanded to leaf blocks already; this is a safety net.
    if (/^(ul|ol)$/i.test(block.tagName) || block.querySelector("li, ul, ol")) {
      return;
    }

    while (block.firstChild) block.removeChild(block.firstChild);

    segments.forEach((seg, i) => {
      if (i > 0) block.appendChild(document.createElement("br"));

      if (!seg.selected || !seg.hasContent || seg.hasTask) {
        // Leave this line as-is (preserving stray whitespace on empty lines)
        for (const n of seg.nodes) block.appendChild(n);
        return;
      }

      const taskId = generateId();

      const textSpan = document.createElement("span");
      textSpan.className = "task-text";
      textSpan.dataset.taskId = taskId;
      for (const n of seg.nodes) {
        // Drop stray checkbox remnants (their span was destroyed by editing)
        // instead of nesting them inside the new task span.
        if (n.nodeType === Node.ELEMENT_NODE && n.classList.contains("task-text-checkbox")) {
          continue;
        }
        textSpan.appendChild(n);
      }

      const checkbox = document.createElement("span");
      checkbox.className = "task-text-checkbox";
      checkbox.dataset.taskId = taskId;
      checkbox.contentEditable = "false";

      block.appendChild(checkbox);
      block.appendChild(textSpan);
      block.appendChild(document.createTextNode("\u00A0"));

      if (this.callbacks.onTaskCreate) {
        this.callbacks.onTaskCreate(taskId);
      }
    });
  }

  /**
   * Split a block's direct children into line segments delimited by top-level
   * <br> elements. Returns an array of arrays of nodes (the <br>s themselves
   * are dropped). A block with no <br> yields a single segment holding all of
   * its children.
   * @param {HTMLElement} block
   * @returns {Node[][]}
   * @private
   */
  _splitBlockByBr(block) {
    const segments = [[]];
    for (const child of Array.from(block.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "br") {
        segments.push([]);
      } else {
        segments[segments.length - 1].push(child);
      }
    }
    return segments;
  }

  /**
   * Render checkboxes for text tasks in the editor DOM
   * @param {Array} tasks - All tasks (will filter to text type)
   */
  renderCheckboxes(tasks) {
    if (!this.editorElement) return;

    this._dedupeTaskMarkup();

    const textTasks = tasks.filter((t) => t.type === "text");
    const activeTaskIds = new Set(textTasks.map((t) => t.id));

    // 1. Sync state and attach listeners for active tasks
    for (const task of textTasks) {
      let checkbox = this.editorElement.querySelector(
        `.task-text-checkbox[data-task-id="${task.id}"]`,
      );
      const span = this.editorElement.querySelector(`.task-text[data-task-id="${task.id}"]`);

      // If checkbox is missing but span exists, restore it
      if (!checkbox && span) {
        checkbox = document.createElement("span");
        checkbox.className = "task-text-checkbox";
        checkbox.dataset.taskId = task.id;
        checkbox.contentEditable = "false";
        span.parentNode.insertBefore(checkbox, span);
      }

      if (checkbox) {
        // Render checked state
        if (task.checked) {
          checkbox.classList.add("task-text-checkbox--checked");
          checkbox.innerHTML = CHECKMARK_SVG;
        } else {
          checkbox.classList.remove("task-text-checkbox--checked");
          checkbox.innerHTML = "";
        }

        // Update styling on text span
        if (span) {
          if (task.checked) span.classList.add("task-text--done");
          else span.classList.remove("task-text--done");
        }

        // Re-attach listeners by cloning (removes old listeners)
        const newCheckbox = checkbox.cloneNode(true);
        newCheckbox.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.callbacks.onTaskToggle) {
            this.callbacks.onTaskToggle(task.id, !task.checked);
          }
        });
        newCheckbox.addEventListener("mousedown", (e) => e.stopPropagation());

        checkbox.parentNode.replaceChild(newCheckbox, checkbox);
      }
    }

    // 2. Cleanup orphaned checkboxes
    const allCheckboxes = this.editorElement.querySelectorAll(".task-text-checkbox");
    for (const cb of allCheckboxes) {
      if (!activeTaskIds.has(cb.dataset.taskId)) {
        cb.remove();
      }
    }
  }

  /**
   * Browser editing (Enter inside a task line, execCommand list conversions)
   * can split/clone a task span, leaving several spans with the same task id.
   * Only the first can be managed; the clones would linger as task-styled
   * zombie text. Keep the first span per id and unwrap the rest to plain text;
   * drop surplus checkboxes the same way.
   * @private
   */
  _dedupeTaskMarkup() {
    const seenSpans = new Set();
    for (const span of this.editorElement.querySelectorAll(".task-text[data-task-id]")) {
      if (seenSpans.has(span.dataset.taskId)) {
        while (span.firstChild) span.parentNode.insertBefore(span.firstChild, span);
        span.remove();
      } else {
        seenSpans.add(span.dataset.taskId);
      }
    }

    const seenCheckboxes = new Set();
    for (const cb of this.editorElement.querySelectorAll(".task-text-checkbox[data-task-id]")) {
      if (seenCheckboxes.has(cb.dataset.taskId)) {
        cb.remove();
      } else {
        seenCheckboxes.add(cb.dataset.taskId);
      }
    }
  }

  /**
   * Remove tasks whose spans no longer exist in the editor DOM
   * @param {Array} tasks - Current tasks array (will be modified in place)
   * @returns {boolean} Whether any orphans were removed
   */
  cleanupOrphans(tasks) {
    if (!this.editorElement || !tasks) return false;

    const existingTaskIds = new Set(
      Array.from(this.editorElement.querySelectorAll(".task-text[data-task-id]")).map(
        (el) => el.dataset.taskId,
      ),
    );

    const before = tasks.length;
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i].type === "text" && !existingTaskIds.has(tasks[i].id)) {
        tasks.splice(i, 1);
      }
    }

    return tasks.length !== before;
  }
}
