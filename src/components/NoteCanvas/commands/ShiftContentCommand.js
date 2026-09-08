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
   * @param {number} [startY] - The insertion point. Recognition bands below it
   *   move with the ink they describe; omitted, they are left alone.
   */
  constructor(yShift, strokeIds, mediaIds, startY) {
    this.yShift = yShift;
    this.strokeIds = strokeIds;
    this.mediaIds = mediaIds;
    this.startY = startY;
  }

  /**
   * Move recognition bands along with the content they describe.
   *
   * A recognized word is localized to a content-space Y range. Shifting the ink
   * without shifting the range would leave every highlight below the insertion
   * point pointing at whatever moved into its place — silently wrong, and only
   * visible when the user next searches.
   *
   * This is the reason bands are stored as a Y range rather than as a band
   * index: an index names a slice of the page, and no arithmetic on it can
   * express "everything below this point moved down".
   *
   * The comparison uses the band's top so a band straddling the insertion point
   * moves only if it begins below it — matching how strokes are selected, by
   * their own minY.
   *
   * @private
   */
  _shiftRecognitionBands(noteCanvas, yDelta) {
    if (this.startY === undefined) return;
    const words = noteCanvas.noteData?.recognition?.words;
    if (!Array.isArray(words)) return;

    let moved = 0;
    for (const word of words) {
      const range = word?.yRange;
      if (!range || typeof range.top !== "number") continue;
      if (range.top <= this.startY) continue;
      range.top += yDelta;
      range.bottom += yDelta;
      moved++;
    }

    // Recognition lives on the note record, not with the strokes, so a changed
    // range only reaches storage if the note is saved. The stroke save below
    // covers that — this just records that there is something to save.
    if (moved > 0) noteCanvas.strokesChanged = true;
  }

  /**
   * Helper to perform the shift
   * @private
   */
  _shift(noteCanvas, yDelta) {
    this._shiftRecognitionBands(noteCanvas, yDelta);

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
