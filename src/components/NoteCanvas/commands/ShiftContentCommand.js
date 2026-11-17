/**
 * ShiftContentCommand - Command for shifting content down to insert space
 *
 * This command stores the IDs of all affected strokes, media items and text
 * boxes, and the vertical distance they were shifted. The boxes move through
 * the text layer, so the ink and the text are one undo step.
 */
/** The smallest value, without spreading a long array into arguments. */
function minOf(values) {
  let min = Number.POSITIVE_INFINITY;
  for (const v of values) if (v < min) min = v;
  return min;
}

export class ShiftContentCommand {
  /**
   * @param {number} yShift - The vertical distance to shift content by
   * @param {Array<string>} strokeIds - IDs of strokes that were moved
   * @param {Array<string>} mediaIds - IDs of media items that were moved
   * @param {number} [startY] - The insertion point. Recognition bands below it
   *   move with the ink they describe; omitted, they are left alone.
   * @param {Array<string>} [boxIds] - IDs of text boxes that were moved
   */
  constructor(yShift, strokeIds, mediaIds, startY, boxIds = []) {
    this.yShift = yShift;
    this.strokeIds = strokeIds;
    this.mediaIds = mediaIds;
    this.startY = startY;
    this.boxIds = boxIds;
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
   * Record the shift in the note, so a merge moves what the other side drew
   * below the line without having seen it (DESIGN §10.7 D). What lies below the
   * line but is deliberately left in place (an undo moves back only what the
   * insert moved, not what was drawn into the gap since) is stamped too: the
   * merge would move it otherwise.
   * @returns {{recorded: boolean, touchedMedia: boolean}} whether a shift was
   *   recorded, and whether media left in place was stamped (it needs a save)
   * @private
   */
  _recordShift(noteCanvas, yDelta) {
    const { versions, noteData } = noteCanvas;
    if (!versions || this.startY === undefined || !noteData) {
      return { recorded: false, touchedMedia: false };
    }
    const strokeIds = new Set(this.strokeIds);
    for (const stroke of noteData.strokes ?? []) {
      if (stroke._deleted || strokeIds.has(stroke.id) || !stroke.y?.length) continue;
      if (minOf(stroke.y) > this.startY) versions.touch(stroke);
    }
    const mediaIds = new Set(this.mediaIds);
    let touchedMedia = false;
    for (const item of noteData.media ?? []) {
      if (item.type === "pdf-page" || mediaIds.has(item.id)) continue;
      if (item.y > this.startY) {
        versions.touch(item);
        touchedMedia = true;
      }
    }
    versions.recordShift(noteData, { y: this.startY, delta: yDelta });
    return { recorded: true, touchedMedia };
  }

  /**
   * Helper to perform the shift
   * @private
   */
  _shift(noteCanvas, yDelta) {
    const { recorded, touchedMedia } = this._recordShift(noteCanvas, yDelta);
    this._shiftRecognitionBands(noteCanvas, yDelta);

    // Shift strokes
    const strokeIds = new Set(this.strokeIds);
    for (const stroke of noteCanvas.noteData.strokes) {
      if (!strokeIds.has(stroke.id)) continue;
      for (let i = 0; i < stroke.y.length; i++) {
        stroke.y[i] += yDelta;
      }
    }

    // Shift media
    const mediaIds = new Set(this.mediaIds);
    for (const media of noteCanvas.noteData.media ?? []) {
      if (mediaIds.has(media.id)) media.y += yDelta;
    }

    // Shift text boxes (their geometry is part of the text, saved with it)
    if (this.boxIds.length > 0) noteCanvas.textEditorLayer?.moveBoxes(this.boxIds, yDelta);

    // Re-build spatial index and redraw
    noteCanvas.spatialIndex.build(noteCanvas.noteData.strokes);
    noteCanvas.renderer.forceRedraw();

    // A recorded shift is saved even when nothing here moved: the other side's
    // strokes below the line may still have to (DESIGN §10.7 D)
    if (this.strokeIds.length > 0 || recorded) {
      noteCanvas.strokesChanged = true;
      noteCanvas.strokeManager.markDirty();
      noteCanvas.strokeManager.forceSave();
    }
    // Media left in place was stamped as having seen the shift: saved with it
    if (this.mediaIds.length > 0 || touchedMedia) {
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
