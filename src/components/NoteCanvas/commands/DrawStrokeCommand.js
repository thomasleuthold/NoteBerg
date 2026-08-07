/**
 * DrawStrokeCommand - Command for drawing a new stroke
 *
 * Undo: Soft-delete the stroke (mark as _deleted)
 * Redo: Restore the stroke (unmark _deleted)
 */
export class DrawStrokeCommand {
  /**
   * @param {Object} stroke - The stroke that was drawn
   * @param {number} strokeIndex - Index of the stroke in noteData.strokes
   */
  constructor(stroke, strokeIndex) {
    this.strokeId = stroke.id;
    this.strokeIndex = strokeIndex;
  }

  /**
   * Redo: Restore the stroke
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    const stroke = noteCanvas.noteData.strokes[this.strokeIndex];
    if (!stroke) return;

    stroke._deleted = false;

    // Remove from deletedStrokes if present
    const delIdx = noteCanvas.noteData.deletedStrokes.indexOf(this.strokeId);
    if (delIdx !== -1) {
      noteCanvas.noteData.deletedStrokes.splice(delIdx, 1);
    }

    // Re-add to spatial index
    noteCanvas.spatialIndex.insert(stroke, this.strokeIndex);

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  /**
   * Undo: Soft-delete the stroke
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    const stroke = noteCanvas.noteData.strokes[this.strokeIndex];
    if (!stroke) return;

    stroke._deleted = true;
    noteCanvas.noteData.deletedStrokes.push(this.strokeId);

    // The spatial index holds live strokes only, so a soft delete must drop the
    // entry — mirroring the insert() in redo(). Leaving it indexed is invisible
    // (the renderer filters _deleted) but makes every later query pay for a
    // stroke that is never drawn.
    noteCanvas.spatialIndex?.remove(this.strokeIndex);

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  cleanup() {
    // No resources to clean up
  }
}
