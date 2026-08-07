/**
 * EraseStrokePartsCommand - Command for the part eraser tool
 *
 * When a stroke is partially erased, the original stroke is deleted and
 * replaced by one or more sub-strokes covering the non-erased regions.
 *
 * A single gesture may touch multiple strokes; all operations are grouped
 * into one command so the entire gesture is undone/redone as a single step.
 *
 * Undo: Restore all original strokes, delete all sub-strokes
 * Redo: Delete all original strokes, restore all sub-strokes
 */
export class EraseStrokePartsCommand {
  /**
   * @param {Array<{
   *   originalIndex: number,
   *   originalId: string,
   *   subStrokes: Array<{ stroke: object, index: number }>
   * }>} operations
   */
  constructor(operations) {
    this.operations = operations;
  }

  /**
   * Redo: delete originals, restore sub-strokes
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    for (const { originalIndex, originalId, subStrokes } of this.operations) {
      // Delete original
      const original = noteCanvas.noteData.strokes[originalIndex];
      if (original && !original._deleted) {
        original._deleted = true;
        // The spatial index tracks live strokes only — keep it in step with
        // _deleted on every flip, or queries return strokes that aren't drawn.
        noteCanvas.spatialIndex?.remove(originalIndex);
        if (originalId && !noteCanvas.noteData.deletedStrokes.includes(originalId)) {
          noteCanvas.noteData.deletedStrokes.push(originalId);
        }
      }

      // Restore sub-strokes
      for (const { stroke, index } of subStrokes) {
        const s = noteCanvas.noteData.strokes[index];
        if (s) {
          s._deleted = false;
          noteCanvas.spatialIndex?.insert(s, index);
          const delIdx = noteCanvas.noteData.deletedStrokes.indexOf(stroke.id);
          if (delIdx !== -1) {
            noteCanvas.noteData.deletedStrokes.splice(delIdx, 1);
          }
        }
      }
    }

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  /**
   * Undo: restore originals, delete sub-strokes
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    for (const { originalIndex, originalId, subStrokes } of this.operations) {
      // Restore original
      const original = noteCanvas.noteData.strokes[originalIndex];
      if (original?._deleted) {
        original._deleted = false;
        // _deleted is cleared first so insert() accepts the stroke.
        noteCanvas.spatialIndex?.insert(original, originalIndex);
        if (originalId) {
          const delIdx = noteCanvas.noteData.deletedStrokes.indexOf(originalId);
          if (delIdx !== -1) {
            noteCanvas.noteData.deletedStrokes.splice(delIdx, 1);
          }
        }
      }

      // Delete sub-strokes
      for (const { stroke, index } of subStrokes) {
        const s = noteCanvas.noteData.strokes[index];
        if (s && !s._deleted) {
          s._deleted = true;
          noteCanvas.spatialIndex?.remove(index);
          if (stroke.id && !noteCanvas.noteData.deletedStrokes.includes(stroke.id)) {
            noteCanvas.noteData.deletedStrokes.push(stroke.id);
          }
        }
      }
    }

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  cleanup() {
    // No resources to clean up
  }
}
