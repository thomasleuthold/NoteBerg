/**
 * CropImageCommand - Command for cropping an image
 *
 * Cropping creates a new file with a new fileId, so we need to track both
 * the original and cropped file references.
 *
 * Undo: Restore original fileId and dimensions
 * Redo: Apply cropped fileId and dimensions
 */
export class CropImageCommand {
  /**
   * @param {string} mediaId - ID of the media item
   * @param {string} originalFileId - Original file ID before crop
   * @param {Object} originalDimensions - Original { width, height }
   * @param {string} newFileId - New file ID after crop
   * @param {Object} newDimensions - New { width, height }
   */
  constructor(mediaId, originalFileId, originalDimensions, newFileId, newDimensions) {
    this.mediaId = mediaId;
    this.originalFileId = originalFileId;
    this.originalDimensions = { ...originalDimensions };
    this.newFileId = newFileId;
    this.newDimensions = { ...newDimensions };
  }

  /**
   * Redo: Apply cropped fileId and dimensions
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    noteCanvas.mediaManager.updateItem(this.mediaId, {
      fileId: this.newFileId,
      width: this.newDimensions.width,
      height: this.newDimensions.height,
    });

    // Also update the in-memory noteData.media reference
    const mediaItem = noteCanvas.noteData.media.find((m) => m.id === this.mediaId);
    if (mediaItem) {
      mediaItem.fileId = this.newFileId;
      mediaItem.width = this.newDimensions.width;
      mediaItem.height = this.newDimensions.height;
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._updateMediaOverlay();
  }

  /**
   * Undo: Restore original fileId and dimensions
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    noteCanvas.mediaManager.updateItem(this.mediaId, {
      fileId: this.originalFileId,
      width: this.originalDimensions.width,
      height: this.originalDimensions.height,
    });

    // Also update the in-memory noteData.media reference
    const mediaItem = noteCanvas.noteData.media.find((m) => m.id === this.mediaId);
    if (mediaItem) {
      mediaItem.fileId = this.originalFileId;
      mediaItem.width = this.originalDimensions.width;
      mediaItem.height = this.originalDimensions.height;
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._updateMediaOverlay();
  }

  cleanup() {
    // Note: We intentionally do NOT delete the cropped file on cleanup
    // It remains in storage and can be cleaned up separately if needed
  }
}
