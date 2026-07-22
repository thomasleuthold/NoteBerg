/**
 * TextChangeCommand - Command for text editor content changes (unified undo/redo)
 *
 * Stores before/after HTML snapshots of the Trumbowyg editor content.
 *
 * Undo: Restore the previous HTML state
 * Redo: Apply the new HTML state
 */
export class TextChangeCommand {
  /**
   * @param {string} beforeHtml - HTML content before the change
   * @param {string} afterHtml - HTML content after the change
   */
  constructor(beforeHtml, afterHtml) {
    this.beforeHtml = beforeHtml;
    this.afterHtml = afterHtml;
  }

  /**
   * Redo: Apply the new HTML state
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    this._apply(noteCanvas, this.afterHtml);
  }

  /**
   * Undo: Restore the previous HTML state
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    this._apply(noteCanvas, this.beforeHtml);
  }

  /**
   * Swap the editor HTML. Task records are left untouched (skipTaskCleanup):
   * they are owned by the paired MarkTaskCommand on the history stack, and
   * cleaning them here would make redo unable to restore a consistent state.
   * Checkboxes are re-rendered because persisted HTML doesn't contain them.
   * @private
   */
  _apply(noteCanvas, html) {
    if (!noteCanvas.textEditorLayer) return;
    noteCanvas.textEditorLayer.setContentSilently(html);
    noteCanvas._onTextContentChange(html, { skipTaskCleanup: true });
    noteCanvas.textEditorLayer.renderTaskCheckboxes(noteCanvas.noteData.tasks);
  }

  cleanup() {
    // No resources to clean up
  }
}
