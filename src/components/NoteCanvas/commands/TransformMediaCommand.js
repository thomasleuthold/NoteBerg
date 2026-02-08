/**
 * TransformMediaCommand - Command for transforming a media item (move/resize/rotate)
 *
 * Stores initial and final state of the transform properties.
 *
 * Undo: Apply initial state
 * Redo: Apply final state
 */
export class TransformMediaCommand {
  /**
   * @param {string} mediaId - ID of the media item
   * @param {Object} initialState - Initial transform state { x, y, width, height, rotation }
   * @param {Object} finalState - Final transform state { x, y, width, height, rotation }
   */
  constructor(mediaId, initialState, finalState) {
    this.mediaId = mediaId;
    // Store only the transform-related properties
    this.initialState = {
      x: initialState.x,
      y: initialState.y,
      width: initialState.width,
      height: initialState.height,
      rotation: initialState.rotation || 0,
    };
    this.finalState = {
      x: finalState.x,
      y: finalState.y,
      width: finalState.width,
      height: finalState.height,
      rotation: finalState.rotation || 0,
    };
  }

  /**
   * Check if the transform actually changed anything
   * @returns {boolean}
   */
  hasChanges() {
    return (
      this.initialState.x !== this.finalState.x ||
      this.initialState.y !== this.finalState.y ||
      this.initialState.width !== this.finalState.width ||
      this.initialState.height !== this.finalState.height ||
      this.initialState.rotation !== this.finalState.rotation
    );
  }

  /**
   * Redo: Apply final state
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    noteCanvas.mediaManager.updateItem(this.mediaId, { ...this.finalState });
    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._updateMediaOverlay();
  }

  /**
   * Undo: Apply initial state
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    noteCanvas.mediaManager.updateItem(this.mediaId, { ...this.initialState });
    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._updateMediaOverlay();
  }

  cleanup() {
    // No resources to clean up
  }
}
