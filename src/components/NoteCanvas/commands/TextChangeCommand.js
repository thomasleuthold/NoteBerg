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
    if (!noteCanvas.textEditorLayer) return;
    noteCanvas.textEditorLayer.setContentSilently(this.afterHtml);
    noteCanvas._onTextContentChange(this.afterHtml);
  }

  /**
   * Undo: Restore the previous HTML state
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    if (!noteCanvas.textEditorLayer) return;
    noteCanvas.textEditorLayer.setContentSilently(this.beforeHtml);
    noteCanvas._onTextContentChange(this.beforeHtml);
  }

  cleanup() {
    // No resources to clean up
  }
}
