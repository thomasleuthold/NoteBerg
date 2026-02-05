/**
 * HistoryManager - Manages undo/redo operations for NoteCanvas
 *
 * Uses command pattern with inverse operations for memory efficiency.
 * Each command stores the data needed to redo and undo the action.
 */
export class HistoryManager {
  /**
   * @param {Object} options
   * @param {number} options.maxHistory - Maximum number of commands to store (default: 50)
   * @param {Function} options.onStateChange - Callback when undo/redo availability changes
   */
  constructor(options = {}) {
    this.maxHistory = options.maxHistory || 50;
    this.undoStack = []; // Array<Command>
    this.redoStack = []; // Array<Command>

    // Reference to NoteCanvas for applying commands
    this.noteCanvas = null;

    // Callback for UI updates (enable/disable buttons)
    this.onStateChange = options.onStateChange || null;
  }

  /**
   * Initialize with NoteCanvas reference
   * @param {NoteCanvas} noteCanvas
   */
  setNoteCanvas(noteCanvas) {
    this.noteCanvas = noteCanvas;
  }

  /**
   * Record a new action (clears redo stack)
   * @param {Command} command - The command to record
   */
  push(command) {
    if (!command) return;

    this.undoStack.push(command);
    this.redoStack = []; // New action invalidates redo history

    // Enforce max history limit
    while (this.undoStack.length > this.maxHistory) {
      const oldCommand = this.undoStack.shift();
      oldCommand.cleanup?.(); // Allow commands to cleanup resources
    }

    this._notifyStateChange();
  }

  /**
   * Undo the last action
   * @returns {boolean} Whether undo was performed
   */
  undo() {
    if (!this.canUndo()) return false;

    // Don't allow undo while actively drawing
    if (this.noteCanvas?.inputHandler?.isDrawing) {
      return false;
    }

    const command = this.undoStack.pop();
    try {
      command.undo(this.noteCanvas);
      this.redoStack.push(command);
    } catch (error) {
      console.error("[HistoryManager] Undo failed:", error);
      // Put command back on stack if undo failed
      this.undoStack.push(command);
      return false;
    }

    this._notifyStateChange();
    return true;
  }

  /**
   * Redo the last undone action
   * @returns {boolean} Whether redo was performed
   */
  redo() {
    if (!this.canRedo()) return false;

    // Don't allow redo while actively drawing
    if (this.noteCanvas?.inputHandler?.isDrawing) {
      return false;
    }

    const command = this.redoStack.pop();
    try {
      command.redo(this.noteCanvas);
      this.undoStack.push(command);
    } catch (error) {
      console.error("[HistoryManager] Redo failed:", error);
      // Put command back on stack if redo failed
      this.redoStack.push(command);
      return false;
    }

    this._notifyStateChange();
    return true;
  }

  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available
   * @returns {boolean}
   */
  canRedo() {
    return this.redoStack.length > 0;
  }

  /**
   * Get current history state (for debugging/UI)
   * @returns {{ undoCount: number, redoCount: number }}
   */
  getState() {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }

  /**
   * Clear all history (e.g., when loading new note or after sync)
   */
  clear() {
    // Cleanup any resources held by commands
    for (const cmd of [...this.undoStack, ...this.redoStack]) {
      cmd.cleanup?.();
    }
    this.undoStack = [];
    this.redoStack = [];
    this._notifyStateChange();
  }

  /**
   * Notify listeners of state change
   * @private
   */
  _notifyStateChange() {
    this.onStateChange?.({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.clear();
    this.noteCanvas = null;
    this.onStateChange = null;
  }
}
