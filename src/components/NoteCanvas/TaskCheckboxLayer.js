/**
 * TaskCheckboxLayer - Manages positioned DOM checkboxes for stroke-type tasks
 *
 * Renders one checkbox per stroke task, positioned to the left of the task's
 * stroke bounding box. The layer itself has pointer-events: none, but individual
 * checkboxes have pointer-events: auto for click handling.
 */
export class TaskCheckboxLayer {
  /**
   * @param {HTMLElement} viewportElement - The scroller viewport element
   * @param {Object} callbacks
   * @param {function(string, boolean)} callbacks.onToggle - Called with (taskId, checked) when toggled
   */
  constructor(viewportElement, callbacks) {
    this.viewportElement = viewportElement;
    this.callbacks = callbacks;
    this.container = document.createElement("div");
    this.container.className = "note-canvas__task-checkbox-layer";
    viewportElement.appendChild(this.container);
    this.checkboxElements = new Map(); // taskId -> { wrapper, checkbox }
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
        this._removeCheckbox(task.id);
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

      // Create or update checkbox element
      let entry = this.checkboxElements.get(task.id);
      if (!entry) {
        entry = this._createCheckbox(task.id);
      }

      entry.checkbox.checked = task.checked;
      entry.wrapper.style.left = `${screenX}px`;
      entry.wrapper.style.top = `${screenY}px`;
      entry.wrapper.style.width = `${scaledSize}px`;
      entry.wrapper.style.height = `${scaledSize}px`;
      entry.wrapper.style.display = "block";
    }

    // Remove checkboxes for tasks that no longer exist
    for (const [taskId] of this.checkboxElements) {
      if (!activeTasks.has(taskId)) {
        this._removeCheckbox(taskId);
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
   * Create a checkbox DOM element for a task
   * @private
   */
  _createCheckbox(taskId) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "note-canvas__task-checkbox";
    checkbox.dataset.taskId = taskId;
    checkbox.addEventListener("pointerdown", (e) => e.stopPropagation());
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      this.callbacks.onToggle(taskId, checkbox.checked);
    });

    this.container.appendChild(checkbox);
    const entry = { wrapper: checkbox, checkbox };
    this.checkboxElements.set(taskId, entry);
    return entry;
  }

  /**
   * Remove a checkbox element
   * @private
   */
  _removeCheckbox(taskId) {
    const entry = this.checkboxElements.get(taskId);
    if (entry) {
      entry.wrapper.remove();
      this.checkboxElements.delete(taskId);
    }
  }

  destroy() {
    this.container.remove();
    this.checkboxElements.clear();
  }
}
