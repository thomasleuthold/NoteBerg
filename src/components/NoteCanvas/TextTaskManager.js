import { generateId } from "../../modules/storage.js";

const CHECKMARK_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block; margin:1px auto;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

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
   * Toggle task status on the current selection
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

    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);

    if (!this.editorElement?.contains(range.commonAncestorContainer)) return;

    // Collect all blocks that intersect the selection
    const blocks = this._getBlocksInRange(range);
    if (blocks.length === 0) return;

    // Determine mode: if the first block already has a task, remove all; otherwise add
    const isRemoveMode = !!blocks[0].querySelector(".task-text[data-task-id]");

    for (const block of blocks) {
      if (isRemoveMode) {
        this._removeTaskFromBlock(block);
      } else {
        this._addTaskToBlock(block);
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
   * Get all block elements that intersect the given range.
   * For a collapsed cursor, returns the single block containing the cursor.
   * @param {Range} range
   * @returns {HTMLElement[]}
   * @private
   */
  _getBlocksInRange(range) {
    const startNode = this._resolveRangeNode(range.startContainer, range.startOffset);
    let startBlock = this._getBlock(startNode);

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
    const endBlock = this._getBlock(endNode);

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
   * Remove task markup from a block element
   * @param {HTMLElement} block
   * @private
   */
  _removeTaskFromBlock(block) {
    const checkboxes = block.querySelectorAll(".task-text-checkbox");
    for (const cb of checkboxes) {
      cb.remove();
    }

    const textSpans = block.querySelectorAll(".task-text");
    for (const span of textSpans) {
      // Unwrap: move children before span, then remove span
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      span.remove();
    }

    // Clean up trailing non-breaking spaces left from task creation
    block.normalize();
  }

  /**
   * Add task markup to a block element
   * @param {HTMLElement} block
   * @private
   */
  _addTaskToBlock(block) {
    // Skip if already a task
    if (block.querySelector("[data-task-id]")) return;

    // Never wrap a list container or a block containing its own block children:
    // moving <li>/<ul>/<ol> into a <span> produces invalid markup that the
    // browser discards on the next parse, blanking the note (C-01). Callers
    // should have expanded to leaf blocks already; this is a safety net.
    if (/^(ul|ol)$/i.test(block.tagName) || block.querySelector("li, ul, ol")) {
      return;
    }

    const taskId = generateId();

    // Move existing content to a fragment
    const contentFrag = document.createDocumentFragment();
    while (block.firstChild) {
      contentFrag.appendChild(block.firstChild);
    }

    // Create task structure
    const textSpan = document.createElement("span");
    textSpan.className = "task-text";
    textSpan.dataset.taskId = taskId;
    textSpan.appendChild(contentFrag);

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
  }

  /**
   * Render checkboxes for text tasks in the editor DOM
   * @param {Array} tasks - All tasks (will filter to text type)
   */
  renderCheckboxes(tasks) {
    if (!this.editorElement) return;

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
