/**
 * MarkTaskCommand - Command for marking strokes/text as one or more tasks
 *
 * Accepts a single task object or an array of task objects.
 * Undo: Remove the task(s) from note.tasks
 * Redo: Re-add the task(s) to note.tasks
 */
export class MarkTaskCommand {
  /**
   * @param {Object|Object[]} tasks - One task or an array of tasks that were created
   */
  constructor(tasks) {
    this.tasks = Array.isArray(tasks) ? tasks.map((t) => ({ ...t })) : [{ ...tasks }];
  }

  /**
   * Redo: Add the task(s) back
   * @param {NoteCanvas} noteCanvas
   */
  redo(noteCanvas) {
    for (const task of this.tasks) {
      noteCanvas.noteData.tasks.push({ ...task });
    }
    noteCanvas._saveTasks();
    noteCanvas._updateTaskCheckboxes();
    noteCanvas._updateNavigatorSubjects();
  }

  /**
   * Undo: Remove the task(s)
   * @param {NoteCanvas} noteCanvas
   */
  undo(noteCanvas) {
    const ids = new Set(this.tasks.map((t) => t.id));
    noteCanvas.noteData.tasks = noteCanvas.noteData.tasks.filter((t) => !ids.has(t.id));
    noteCanvas._saveTasks();
    noteCanvas._updateTaskCheckboxes();
    noteCanvas._updateNavigatorSubjects();
  }

  cleanup() {
    // No resources to clean up
  }
}
