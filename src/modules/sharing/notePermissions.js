/**
 * Permission questions about a note, answered from storage: for code that has a
 * note or notebook id rather than a notebook record at hand (background writers,
 * the editor). Everything is a pure function of the notebook record
 * (sharePermissions.js); this module only looks the record up.
 */

import { getNotebook, getNoteIndex } from "../storage.js";
import { canEdit, canManage } from "./sharePermissions.js";

/** What the user may do in a notebook: edit its content, and manage (delete, move, copy, share) it. */
export async function getNotebookPermissions(notebookId) {
  const notebook = notebookId ? await getNotebook(notebookId) : null;
  return { canEdit: canEdit(notebook), canManage: canManage(notebook), notebook };
}

/** Whether a note's content may be changed. Unknown notes and quick notes are the user's own. */
export async function canEditNote(noteId) {
  const index = await getNoteIndex(noteId);
  if (!index?.notebookId) return true;
  return (await getNotebookPermissions(index.notebookId)).canEdit;
}
