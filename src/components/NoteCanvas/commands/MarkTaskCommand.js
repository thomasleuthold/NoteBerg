/**
 * MarkTaskCommand - Command for marking strokes/text as a task
 *
 * Undo: Remove the task from note.tasks
 * Redo: Re-add the task to note.tasks
 */
export class MarkTaskCommand {
  /**
   * @param {Object} task - The task that was created
   */
  constructor(task) {
    this.task = { ...task };
  }

  /**
   * Redo: Add the task back
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    noteCanvas.noteData.tasks.push({ ...this.task });
    noteCanvas._saveTasks();
    noteCanvas._updateTaskCheckboxes();
    noteCanvas._updateNavigatorSubjects();
  }

  /**
   * Undo: Remove the task
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    const idx = noteCanvas.noteData.tasks.findIndex((t) => t.id === this.task.id);
    if (idx !== -1) {
      noteCanvas.noteData.tasks.splice(idx, 1);
    }
    noteCanvas._saveTasks();
    noteCanvas._updateTaskCheckboxes();
    noteCanvas._updateNavigatorSubjects();
  }

  cleanup() {
    // No resources to clean up
  }
}
