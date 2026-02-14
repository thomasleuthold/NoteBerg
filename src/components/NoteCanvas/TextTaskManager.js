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

    // 1. Helper to check if a node is a supported block element
    const isBlock = (node) => {
      return node && node.nodeType === 1 && /^(p|div|li|blockquote|h[1-6])$/i.test(node.tagName);
    };

    // Helper to find the block for a given container/offset
    const getBlock = (node, offset) => {
      if (node === this.editorElement) {
        // If container is editor, look at the child node at offset
        if (offset < node.childNodes.length) {
          node = node.childNodes[offset];
        } else {
          return null;
        }
      }

      // Walk up
      while (node && node !== this.editorElement) {
        if (isBlock(node)) return node;
        node = node.parentNode;
      }
      return null;
    };

    const startBlock = getBlock(range.startContainer, range.startOffset);
    const endBlock = getBlock(range.endContainer, range.endOffset);

    // 2. Collect Blocks to Convert
    const blocksToConvert = [];

    if (startBlock && endBlock) {
      if (startBlock === endBlock) {
        blocksToConvert.push(startBlock);
      } else {
        // Collect siblings from start to end
        let curr = startBlock;
        while (curr) {
          let shouldConvert = true;

          // Check for significant selection overlap
          if (curr === startBlock) {
            try {
              const blockRange = document.createRange();
              blockRange.selectNodeContents(curr);
              const intersection = range.cloneRange();
              intersection.setEnd(blockRange.endContainer, blockRange.endOffset);
              if (!intersection.toString().trim()) {
                shouldConvert = false;
              }
            } catch (_e) {
              // Ignore range errors
            }
          } else if (curr === endBlock) {
            try {
              const blockRange = document.createRange();
              blockRange.selectNodeContents(curr);
              const intersection = range.cloneRange();
              intersection.setStart(blockRange.startContainer, blockRange.startOffset);
              if (!intersection.toString().trim()) {
                shouldConvert = false;
              }
            } catch (_e) {
              // Ignore range errors
            }
          }

          if (shouldConvert) {
            if (isBlock(curr)) {
              blocksToConvert.push(curr);
            }
          }

          if (curr === endBlock) break;
          curr = curr.nextElementSibling;
          if (!curr || !this.editorElement.contains(curr)) break;
        }
      }
    } else if (startBlock) {
      blocksToConvert.push(startBlock);
    } else {
      // No blocks found (e.g. text at root). Wrap selection in a div.
      const wrapper = document.createElement("div");
      try {
        range.surroundContents(wrapper);
      } catch (_e) {
        const content = range.extractContents();
        wrapper.appendChild(content);
        range.insertNode(wrapper);
      }
      blocksToConvert.push(wrapper);
    }

    // 3. Convert Each Block
    // Determine mode: If the first block already has a task, we toggle OFF (remove).
    const firstBlock = blocksToConvert[0];
    const isRemoveMode = firstBlock && !!firstBlock.querySelector(".task-text[data-task-id]");

    for (const block of blocksToConvert) {
      if (isRemoveMode) {
        // Remove task(s) from this block
        const checkboxes = block.querySelectorAll(".task-text-checkbox");
        checkboxes.forEach((cb) => {
          cb.remove();
        });

        const textSpans = block.querySelectorAll(".task-text");
        textSpans.forEach((span) => {
          // Unwrap content
          while (span.firstChild) {
            span.parentNode.insertBefore(span.firstChild, span);
          }
          span.remove();
        });
      } else {
        // Add task
        if (block.querySelector("[data-task-id]")) continue;

        const taskId = generateId();

        // Move content to fragment
        const contentFrag = document.createDocumentFragment();
        while (block.firstChild) {
          contentFrag.appendChild(block.firstChild);
        }

        // Create Task Structure
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
    }

    // Trigger change event
    if (this.callbacks.triggerChange) {
      this.callbacks.triggerChange();
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
