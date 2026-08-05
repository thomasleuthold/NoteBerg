/**
 * EraseStrokesCommand - Command for erasing one or more strokes
 *
 * Used by both the eraser tool and scratch-out gesture.
 * Supports batching multiple strokes erased in a single drag gesture.
 *
 * Undo: Restore all erased strokes
 * Redo: Delete the strokes again
 */
export class EraseStrokesCommand {
  /**
   * @param {Array<{index: number, id: string}>} erasedStrokes - Array of erased stroke info
   */
  constructor(erasedStrokes) {
    // Store array of { index, id } for each erased stroke
    this.erasedStrokes = erasedStrokes;
  }

  /**
   * Create command from array of stroke indices
   * @param {NoteCanvas} noteCanvas
   * @param {number[]} indices - Array of stroke indices
   * @returns {EraseStrokesCommand}
   */
  static fromIndices(noteCanvas, indices) {
    const erasedStrokes = indices.map((index) => {
      const stroke = noteCanvas.noteData.strokes[index];
      return {
        index,
        id: stroke?.id || null,
      };
    });
    return new EraseStrokesCommand(erasedStrokes);
  }

  /**
   * Redo: Delete the strokes again
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    this.erasedStrokes.forEach(({ index, id }) => {
      const stroke = noteCanvas.noteData.strokes[index];
      if (stroke && !stroke._deleted) {
        stroke._deleted = true;
        // The index holds live strokes only, so a soft delete must drop the
        // entry — otherwise every query keeps paying for erased content.
        noteCanvas.spatialIndex?.remove(index);
        if (id && !noteCanvas.noteData.deletedStrokes.includes(id)) {
          noteCanvas.noteData.deletedStrokes.push(id);
        }
      }
    });

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
  }

  /**
   * Undo: Restore all erased strokes
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    this.erasedStrokes.forEach(({ index, id }) => {
      const stroke = noteCanvas.noteData.strokes[index];
      if (stroke?._deleted) {
        stroke._deleted = false;
        // Restore the index entry redo() dropped — _deleted is cleared first so
        // insert() accepts it.
        noteCanvas.spatialIndex?.insert(stroke, index);
        if (id) {
          const delIdx = noteCanvas.noteData.deletedStrokes.indexOf(id);
          if (delIdx !== -1) {
            noteCanvas.noteData.deletedStrokes.splice(delIdx, 1);
          }
        }
      }
    });

    noteCanvas.strokesChanged = true;
    noteCanvas.strokeManager.markDirty();
    noteCanvas.strokeManager.forceSave();
    noteCanvas.renderer.forceRedraw();
    noteCanvas._updateTaskCheckboxes();
    noteCanvas._updateNavigatorSubjects();
  }

  cleanup() {
    // No resources to clean up
  }
}
