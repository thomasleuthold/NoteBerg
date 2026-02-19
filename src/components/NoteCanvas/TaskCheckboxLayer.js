/**
 * TaskCheckboxLayer - Manages positioned DOM checkboxes for stroke-type tasks
 *
 * Renders one checkbox per stroke task, positioned to the left of the task's
 * stroke bounding box. The layer itself has pointer-events: none, but individual
 * checkboxes have pointer-events: auto for click handling.
 */
import { t } from "../../i18n/index.js";

export class TaskCheckboxLayer {
  /**
   * @param {HTMLElement} viewportElement - The scroller viewport element
   * @param {Object} callbacks
   * @param {function(string, boolean)} callbacks.onToggle - Called with (taskId, checked) when toggled
   * @param {function(string)} callbacks.onTaskClick - Called with (taskId) when bounding box is clicked
   */
  constructor(viewportElement, callbacks) {
    this.viewportElement = viewportElement;
    this.callbacks = callbacks;
    this.container = document.createElement("div");
    this.container.className = "note-canvas__task-checkbox-layer";
    viewportElement.appendChild(this.container);
    this.taskElements = new Map(); // taskId -> { checkbox, boundingBox }
  }

  /**
   * Update checkbox positions and visibility
   * @param {Array} tasks - Stroke-type tasks
   * @param {Array} strokes - All strokes in the note
   * @param {number} zoom - Current zoom scale
   * @param {number} scrollLeft - Horizontal scroll offset
   * @param {number} scrollTop - Vertical scroll offset
   * @param {number} offsetX - Horizontal centering offset
   */
  update(tasks, strokes, zoom, scrollLeft, scrollTop, offsetX) {
    const activeTasks = new Set();

    for (const task of tasks) {
      activeTasks.add(task.id);

      // Compute bounding box from referenced strokes
      const bounds = this._getTaskBounds(task, strokes);
      if (!bounds) {
        // All strokes deleted, hide checkbox
        this._removeTaskElements(task.id);
        continue;
      }

      // Position: left of the bounding box, vertically centered
      const checkboxSize = 22;
      const margin = 8;
      const contentX = bounds.minX - checkboxSize - margin;
      const contentY = (bounds.minY + bounds.maxY) / 2 - checkboxSize / 2;

      // Convert to screen coordinates
      const screenX = contentX * zoom - scrollLeft + offsetX;
      const screenY = contentY * zoom - scrollTop;

      // Scale the checkbox with zoom
      const scaledSize = checkboxSize * Math.min(zoom, 2); // Cap scaling at 2x

      // Calculate bounding box screen coordinates
      const boxX = bounds.minX * zoom - scrollLeft + offsetX;
      const boxY = bounds.minY * zoom - scrollTop;
      const boxW = (bounds.maxX - bounds.minX) * zoom;
      const boxH = (bounds.maxY - bounds.minY) * zoom;

      // Create or update elements
      let entry = this.taskElements.get(task.id);
      if (!entry) {
        entry = this._createTaskElements(task.id);
      }

      entry.checkbox.checked = task.checked;
      entry.checkbox.style.left = `${screenX}px`;
      entry.checkbox.style.top = `${screenY}px`;
      entry.checkbox.style.width = `${scaledSize}px`;
      entry.checkbox.style.height = `${scaledSize}px`;
      entry.checkbox.style.display = "block";

      entry.boundingBox.style.left = `${boxX}px`;
      entry.boundingBox.style.top = `${boxY}px`;
      entry.boundingBox.style.width = `${boxW}px`;
      entry.boundingBox.style.height = `${boxH}px`;
      entry.boundingBox.style.display = "block";
    }

    // Remove checkboxes for tasks that no longer exist
    for (const [taskId] of this.taskElements) {
      if (!activeTasks.has(taskId)) {
        this._removeTaskElements(taskId);
      }
    }
  }

  /**
   * Get bounding box for a task's strokes
   * @private
   */
  _getTaskBounds(task, strokes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasValid = false;

    for (const strokeId of task.strokeIds) {
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

  /**
   * Create DOM elements for a task (checkbox + bounding box)
   * @private
   */
  _createTaskElements(taskId) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "note-canvas__task-checkbox";
    checkbox.dataset.taskId = taskId;
    checkbox.addEventListener("pointerdown", (e) => e.stopPropagation());
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      this.callbacks.onToggle(taskId, checkbox.checked);
    });

    const boundingBox = document.createElement("div");
    boundingBox.className = "note-canvas__task-bounding-box";
    boundingBox.dataset.taskId = taskId;
    boundingBox.title = t("toolbar.tasks.selectStrokes");
    boundingBox.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.callbacks.onTaskClick) {
        this.callbacks.onTaskClick(taskId);
      }
    });

    this.container.appendChild(boundingBox);
    this.container.appendChild(checkbox);

    const entry = { checkbox, boundingBox };
    this.taskElements.set(taskId, entry);
    return entry;
  }

  /**
   * Remove task elements
   * @private
   */
  _removeTaskElements(taskId) {
    const entry = this.taskElements.get(taskId);
    if (entry) {
      entry.checkbox.remove();
      entry.boundingBox.remove();
      this.taskElements.delete(taskId);
    }
  }

  destroy() {
    this.container.remove();
    this.taskElements.clear();
  }
}
