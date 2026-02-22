/**
 * DeleteMediaCommand - Command for deleting media items
 *
 * Stores full item data for restoration on undo.
 *
 * Undo: Restore media items
 * Redo: Delete media items again
 */
export class DeleteMediaCommand {
  /**
   * @param {Array<Object>} deletedItems - Array of deleted media items
   * @param {boolean} wasPdfDelete - Whether this was a full PDF delete operation
   * @param {string|null} pdfSourceFileId - The PDF source file ID if wasPdfDelete is true
   */
  constructor(deletedItems, wasPdfDelete = false, pdfSourceFileId = null) {
    // Store copies of item data for restoration
    this.deletedItems = deletedItems.map((item) => ({
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
    this.wasPdfDelete = wasPdfDelete;
    this.pdfSourceFileId = pdfSourceFileId;
  }

  /**
   * Redo: Delete the media items again
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    this.deletedItems.forEach((item) => {
      noteCanvas.noteData.deletedMedia.push(item.id);
      noteCanvas.mediaManager.removeItem(item.id);
    });

    if (this.wasPdfDelete) {
      noteCanvas.noteData.pdfSource = null;
    }

    // Clear selection if deleted item was selected
    if (this.deletedItems.some((item) => item.id === noteCanvas.selectedMediaId)) {
      noteCanvas.selectedMediaId = null;
      noteCanvas.renderer.setSelectedMedia(null);
      noteCanvas.mediaOverlay?.hide();
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.showA4PageBreaks =
      !noteCanvas.noteData.pdfSource &&
      !noteCanvas.mediaManager.getItems().some((i) => i.type === "pdf-page");
    noteCanvas.renderer.forceRedraw();
    noteCanvas._renderPdfControls();
  }

  /**
   * Undo: Restore the media items
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    this.deletedItems.forEach((item) => {
      // Re-add item to media manager
      noteCanvas.mediaManager.addItem({ ...item });

      // Remove from deletedMedia
      const delIdx = noteCanvas.noteData.deletedMedia.indexOf(item.id);
      if (delIdx !== -1) {
        noteCanvas.noteData.deletedMedia.splice(delIdx, 1);
      }
    });

    // Restore PDF source if this was a PDF delete
    if (this.wasPdfDelete && this.pdfSourceFileId) {
      noteCanvas.noteData.pdfSource = this.pdfSourceFileId;
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.showA4PageBreaks =
      !noteCanvas.noteData.pdfSource &&
      !noteCanvas.mediaManager.getItems().some((i) => i.type === "pdf-page");
    noteCanvas.renderer.forceRedraw();
    noteCanvas._renderPdfControls();
  }

  cleanup() {
    // No resources to clean up
    // Binary files remain in storage
  }
}
