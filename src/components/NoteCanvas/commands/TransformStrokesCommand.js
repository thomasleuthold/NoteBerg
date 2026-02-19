/**
 * TransformStrokesCommand - Command for transforming selected strokes (move/resize/rotate)
 *
 * Stores initial and final coordinates for each affected stroke.
 *
 * Undo: Apply initial coordinates
 * Redo: Apply final coordinates
 */
export class TransformStrokesCommand {
  /**
   * @param {number[]} strokeIndices - Array of stroke indices that were transformed
   * @param {Array<{x: number[], y: number[]}>} initialCoords - Initial coordinates for each stroke
   * @param {Array<{x: number[], y: number[]}>} finalCoords - Final coordinates for each stroke
   */
  constructor(strokeIndices, initialCoords, finalCoords) {
    this.strokeIndices = strokeIndices;
    this.initialCoords = initialCoords;
    this.finalCoords = finalCoords;
  }

  /**
   * Check if the transform actually changed anything
   * @returns {boolean}
   */
  hasChanges() {
    return this.initialCoords.some((initial, i) => {
      const final = this.finalCoords[i];
      return initial.x.some((x, j) => x !== final.x[j] || initial.y[j] !== final.y[j]);
    });
  }

  /**
   * Redo: Apply final coordinates
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    this._applyCoords(noteCanvas, this.finalCoords);
  }

  /**
   * Undo: Apply initial coordinates
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    this._applyCoords(noteCanvas, this.initialCoords);
    // Clear selection since strokes moved back to original position
    noteCanvas.renderer.setSelectedStrokes(new Set(), null);
    noteCanvas.selectionOverlay?.hide();
  }

  /**
   * Apply coordinates to strokes
   * @private
   * @param {NoteCanvas} noteCanvas
   * @param {Array<{x: number[], y: number[]}>} coords
   */
  _applyCoords(noteCanvas, coords) {
    this.strokeIndices.forEach((strokeIndex, i) => {
      const stroke = noteCanvas.noteData.strokes[strokeIndex];
      if (stroke) {
        // Replace coordinates with copies
        stroke.x = coords[i].x.slice();
        stroke.y = coords[i].y.slice();

        // Update spatial index
        noteCanvas.spatialIndex.remove(strokeIndex);
        noteCanvas.spatialIndex.insert(stroke, strokeIndex);
      }
    });

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  cleanup() {
    // Could clear coordinate arrays to free memory, but they're small
  }
}
