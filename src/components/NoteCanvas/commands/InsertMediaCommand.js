/**
 * InsertMediaCommand - Command for inserting media items (images or PDF pages)
 *
 * For PDF: A single command captures all pages inserted together.
 *
 * Undo: Remove media items (soft delete)
 * Redo: Restore media items
 */
export class InsertMediaCommand {
  /**
   * @param {Array<Object>} mediaItems - Array of media items that were inserted
   * @param {string|null} pdfSourceFileId - Set if this was a PDF insert
   */
  constructor(mediaItems, pdfSourceFileId = null) {
    // Store copies of item data for recreation
    this.mediaItems = mediaItems.map((item) => ({
      id: item.id,
      type: item.type,
      fileId: item.fileId,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      rotation: item.rotation || 0,
      // PDF-specific
      pageIndex: item.pageIndex,
      pdfFileId: item.pdfFileId,
    }));
    this.pdfSourceFileId = pdfSourceFileId;
  }

  /**
   * Redo: Restore the media items
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    this.mediaItems.forEach((item) => {
      // Re-add item to media manager
      noteCanvas.mediaManager.addItem({ ...item });

      // Remove from deletedMedia if present
      const delIdx = noteCanvas.noteData.deletedMedia.indexOf(item.id);
      if (delIdx !== -1) {
        noteCanvas.noteData.deletedMedia.splice(delIdx, 1);
      }
    });

    // Restore PDF source reference if this was a PDF insert
    if (this.pdfSourceFileId) {
      noteCanvas.noteData.pdfSource = this.pdfSourceFileId;
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._renderPdfControls();
  }

  /**
   * Undo: Remove the media items (soft delete)
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    this.mediaItems.forEach((item) => {
      // Add to deletedMedia tracking
      noteCanvas.noteData.deletedMedia.push(item.id);
      // Remove from media manager
      noteCanvas.mediaManager.removeItem(item.id);
    });

    // Clear PDF source if this was a PDF insert
    if (this.pdfSourceFileId) {
      noteCanvas.noteData.pdfSource = null;
    }

    // Clear selection if one of these items was selected
    if (this.mediaItems.some((item) => item.id === noteCanvas.selectedMediaId)) {
      noteCanvas.selectedMediaId = null;
      noteCanvas.renderer.setSelectedMedia(null);
      noteCanvas.mediaOverlay?.hide();
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._renderPdfControls();
  }

  cleanup() {
    // Note: We intentionally do NOT delete actual binary files on cleanup
    // They remain in storage to prevent sync conflicts
    // Orphaned files are cleaned up separately
  }
}
