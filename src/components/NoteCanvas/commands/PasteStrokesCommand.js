/**
 * PasteStrokesCommand - Command for pasting strokes onto the canvas
 *
 * Undo: Mark pasted strokes as deleted, remove from spatial index
 * Redo: Restore pasted strokes, re-insert into spatial index
 */
export class PasteStrokesCommand {
  /**
   * @param {Object[]} strokes - The stroke objects that were pasted (already in noteData.strokes)
   * @param {number[]} indices - Their indices in noteData.strokes
   */
  constructor(strokes, indices) {
    this.strokes = strokes;
    this.indices = indices;
  }

  /**
   * Redo: re-add pasted strokes
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    for (let i = 0; i < this.indices.length; i++) {
      const index = this.indices[i];
      const stroke = noteCanvas.noteData.strokes[index];
      if (stroke?._deleted) {
        stroke._deleted = false;
        const delIdx = noteCanvas.noteData.deletedStrokes.indexOf(stroke.id);
        if (delIdx !== -1) {
          noteCanvas.noteData.deletedStrokes.splice(delIdx, 1);
        }
        noteCanvas.spatialIndex.insert(stroke, index);
      }
    }

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  /**
   * Undo: mark pasted strokes as deleted
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    for (const index of this.indices) {
      const stroke = noteCanvas.noteData.strokes[index];
      if (stroke && !stroke._deleted) {
        stroke._deleted = true;
        if (!noteCanvas.noteData.deletedStrokes.includes(stroke.id)) {
          noteCanvas.noteData.deletedStrokes.push(stroke.id);
        }
      }
    }

    // Clear selection if these strokes were selected
    noteCanvas.renderer.setSelectedStrokes(new Set(), null);
    noteCanvas.selectionOverlay?.hide();

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  cleanup() {
    // No resources to clean up
  }
}
