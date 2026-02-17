import { generateId } from "../../modules/storage.js";

const CHECKBOX_STYLE =
  "display:inline-block; width:16px; height:16px; vertical-align:middle; margin-right:6px; user-select:none; cursor:pointer; border:1px solid currentColor; border-radius:3px;";
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
   * Get all block elements that intersect the given range.
   * For a collapsed cursor, returns the single block containing the cursor.
   * @param {Range} range
   * @returns {HTMLElement[]}
   * @private
   */
  _getBlocksInRange(range) {
    const startBlock = this._getBlock(range.startContainer);

    // Collapsed cursor — just use the start block
    if (range.collapsed) {
      return startBlock ? [startBlock] : [];
    }

    // When the range end is at offset 0 of a block (common with triple-click),
    // the selection doesn't actually include that block — use the previous one.
    const endNode = range.endContainer;
    if (range.endOffset === 0) {
      const endBlock = this._getBlock(endNode);
      if (endBlock && endBlock !== startBlock) {
        // The selection ends right at the start of the next block — exclude it
        return startBlock ? [startBlock] : [];
      }
    }

    const endBlock = this._getBlock(endNode);

    // Same block
    if (startBlock && startBlock === endBlock) {
      return [startBlock];
    }

    // Different blocks — collect siblings from start to end
    if (startBlock && endBlock) {
      const blocks = [];
      let curr = startBlock;
      while (curr) {
        blocks.push(curr);
        if (curr === endBlock) break;
        curr = curr.nextElementSibling;
        if (!curr || !this.editorElement.contains(curr)) break;
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
    checkbox.style.cssText = CHECKBOX_STYLE;

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
        checkbox.style.cssText = CHECKBOX_STYLE;
        span.parentNode.insertBefore(checkbox, span);
      }

      if (checkbox) {
        // Render checked state
        if (task.checked) {
          checkbox.style.backgroundColor = "#3b82f6";
          checkbox.style.borderColor = "#3b82f6";
          checkbox.innerHTML = CHECKMARK_SVG;
        } else {
          checkbox.style.backgroundColor = "transparent";
          checkbox.style.borderColor = "currentColor";
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
