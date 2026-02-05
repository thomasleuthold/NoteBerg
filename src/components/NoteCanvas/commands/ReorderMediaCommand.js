/**
 * ReorderMediaCommand - Command for changing z-order of media items
 *
 * Tracks the original array index to restore on undo.
 *
 * Undo: Restore to original position
 * Redo: Move to front/back again
 */
export class ReorderMediaCommand {
  /**
   * @param {string} mediaId - ID of the media item
   * @param {'front'|'back'} direction - Direction of reorder
   * @param {number} originalIndex - Original index in the media array
   */
  constructor(mediaId, direction, originalIndex) {
    this.mediaId = mediaId;
    this.direction = direction;
    this.originalIndex = originalIndex;
  }

  /**
   * Redo: Move to front or back
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    if (this.direction === "front") {
      noteCanvas.mediaManager.moveItemToFront(this.mediaId);
    } else {
      noteCanvas.mediaManager.moveItemToBack(this.mediaId);
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
  }

  /**
   * Undo: Restore to original position
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    const items = noteCanvas.mediaManager.getItems();
    const currentIndex = items.findIndex((i) => i.id === this.mediaId);

    if (currentIndex !== -1 && currentIndex !== this.originalIndex) {
      // Remove from current position
      const [item] = items.splice(currentIndex, 1);
      // Insert at original position
      items.splice(this.originalIndex, 0, item);
    }

    noteCanvas.mediaChanged = true;
    noteCanvas._saveMediaChanges();
    noteCanvas.renderer.forceRedraw();
  }

  cleanup() {
    // No resources to clean up
  }
}
