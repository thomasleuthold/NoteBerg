/**
 * ShiftContentCommand - Command for shifting content down to insert space
 *
 * This command stores the IDs of all affected strokes and media items,
 * and the vertical distance they were shifted.
 */
export class ShiftContentCommand {
  /**
   * @param {number} yShift - The vertical distance to shift content by
   * @param {Array<string>} strokeIds - IDs of strokes that were moved
   * @param {Array<string>} mediaIds - IDs of media items that were moved
   */
  constructor(yShift, strokeIds, mediaIds) {
    this.yShift = yShift;
    this.strokeIds = strokeIds;
    this.mediaIds = mediaIds;
  }

  /**
   * Helper to perform the shift
   * @private
   */
  _shift(noteCanvas, yDelta) {
    // Shift strokes
    for (const strokeId of this.strokeIds) {
      const stroke = noteCanvas.noteData.strokes.find((s) => s.id === strokeId);
      if (stroke) {
        for (let i = 0; i < stroke.y.length; i++) {
          stroke.y[i] += yDelta;
        }
      }
    }

    // Shift media
    for (const mediaId of this.mediaIds) {
      const media = noteCanvas.noteData.media.find((m) => m.id === mediaId);
      if (media) {
        media.y += yDelta;
      }
    }

    // Re-build spatial index and redraw
    noteCanvas.spatialIndex.build(noteCanvas.noteData.strokes);
    noteCanvas.renderer.forceRedraw();

    if (this.strokeIds.length > 0) {
      noteCanvas.strokesChanged = true;
      noteCanvas.strokeManager.markDirty();
      noteCanvas.strokeManager.forceSave();
    }
    if (this.mediaIds.length > 0) {
      noteCanvas.mediaChanged = true;
      noteCanvas._saveMediaChanges();
    }
  }

  /**
   * Redo: Shift content down
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    this._shift(noteCanvas, this.yShift);
  }

  /**
   * Undo: Shift content up
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    this._shift(noteCanvas, -this.yShift);
  }

  cleanup() {
    // No resources to clean up
  }
}
