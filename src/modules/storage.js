/**
 * Storage Module
 * IndexedDB wrapper for notes, notebooks, and settings
 */

import { openDB } from 'idb';

const DB_NAME = 'oneJournal';
const DB_VERSION = 1;

let db = null;

/**
 * Initialize the database
 */
export async function initStorage() {
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // Create notebooks store
      if (!database.objectStoreNames.contains('notebooks')) {
        const notebookStore = database.createObjectStore('notebooks', { keyPath: 'id' });
        notebookStore.createIndex('created', 'created');
        notebookStore.createIndex('modified', 'modified');
      }

      // Create notes store
      if (!database.objectStoreNames.contains('notes')) {
        const noteStore = database.createObjectStore('notes', { keyPath: 'id' });
        noteStore.createIndex('notebookId', 'notebookId');
        noteStore.createIndex('created', 'created');
        noteStore.createIndex('modified', 'modified');
      }

      // Create settings store
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }

      // Create sync queue store
      if (!database.objectStoreNames.contains('syncQueue')) {
        const syncStore = database.createObjectStore('syncQueue', {
          keyPath: 'id',
          autoIncrement: true,
        });
        syncStore.createIndex('timestamp', 'timestamp');
      }
    },
  });

  console.log('Storage initialized');
  return db;
}

/**
 * Generate a UUID v4
 */
function generateId() {
  return crypto.randomUUID();
}

// ========== Notebook Operations ==========

/**
 * Create a new notebook
 */
export async function createNotebook({ title, description = '', color = '#3b82f6' }) {
  const notebook = {
    id: generateId(),
    title,
    description,
    color,
    created: Date.now(),
    modified: Date.now(),
    synced: false,
    deleted: false,
  };

  await db.put('notebooks', notebook);
  console.log('Notebook created:', notebook.id);
  return notebook;
}

/**
 * Get all notebooks (non-deleted)
 */
export async function getAllNotebooks() {
  const notebooks = await db.getAll('notebooks');
  return notebooks.filter(n => !n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get a notebook by ID
 */
export async function getNotebook(id) {
  return db.get('notebooks', id);
}

/**
 * Update a notebook
 */
export async function updateNotebook(id, updates) {
  const notebook = await db.get('notebooks', id);
  if (!notebook) throw new Error('Notebook not found');

  const updated = {
    ...notebook,
    ...updates,
    modified: Date.now(),
    synced: false,
  };

  await db.put('notebooks', updated);
  console.log('Notebook updated:', id);
  return updated;
}

/**
 * Delete a notebook (soft delete) and all its notes
 */
export async function deleteNotebook(id) {
  const notebook = await db.get('notebooks', id);
  if (!notebook) throw new Error('Notebook not found');

  // Mark notebook as deleted
  notebook.deleted = true;
  notebook.modified = Date.now();
  notebook.synced = false;

  await db.put('notebooks', notebook);

  // Also delete all notes in this notebook
  const notes = await db.getAllFromIndex('notes', 'notebookId', id);
  const timestamp = Date.now();

  for (const note of notes) {
    if (!note.deleted) {
      note.deleted = true;
      note.modified = timestamp;
      note.synced = false;
      await db.put('notes', note);
    }
  }

  console.log(`Notebook deleted: ${id} (with ${notes.length} notes)`);
  return notebook;
}

// ========== Note Operations ==========

/**
 * Create a new note
 */
export async function createNote({ title, notebookId = null }) {
  const note = {
    id: generateId(),
    notebookId,
    title,
    textContent: '',
    strokes: [],
    canvasData: null,
    created: Date.now(),
    modified: Date.now(),
    synced: false,
    deleted: false,
    tags: [],
  };

  await db.put('notes', note);
  console.log('Note created:', note.id);
  return note;
}

/**
 * Get all notes (non-deleted)
 */
export async function getAllNotes() {
  const notes = await db.getAll('notes');
  return notes.filter(n => !n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get notes by notebook ID
 */
export async function getNotesByNotebook(notebookId) {
  const notes = await db.getAllFromIndex('notes', 'notebookId', notebookId);
  return notes.filter(n => !n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get quick notes (notes without a notebook)
 */
export async function getQuickNotes() {
  // Get all notes and filter for those without a notebook
  const allNotes = await db.getAll('notes');
  const quickNotes = allNotes.filter(n => !n.deleted && n.notebookId === null);
  return quickNotes.sort((a, b) => b.modified - a.modified);
}

/**
 * Get a note by ID
 */
export async function getNote(id) {
  return db.get('notes', id);
}

/**
 * Update a note
 */
export async function updateNote(id, updates) {
  const note = await db.get('notes', id);
  if (!note) throw new Error('Note not found');

  const updated = {
    ...note,
    ...updates,
    modified: Date.now(),
    synced: false,
  };

  await db.put('notes', updated);
  console.log('Note updated:', id);
  return updated;
}

/**
 * Delete a note (soft delete)
 */
export async function deleteNote(id) {
  const note = await db.get('notes', id);
  if (!note) throw new Error('Note not found');

  note.deleted = true;
  note.modified = Date.now();
  note.synced = false;

  await db.put('notes', note);
  console.log('Note deleted:', id);
  return note;
}

// ========== Recycle Bin Operations ==========

/**
 * Get all deleted notebooks
 */
export async function getDeletedNotebooks() {
  const allNotebooks = await db.getAll('notebooks');
  return allNotebooks.filter(n => n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Get all deleted notes
 */
export async function getDeletedNotes() {
  const allNotes = await db.getAll('notes');
  return allNotes.filter(n => n.deleted).sort((a, b) => b.modified - a.modified);
}

/**
 * Restore a deleted notebook
 */
export async function restoreNotebook(id) {
  const notebook = await db.get('notebooks', id);
  if (!notebook) throw new Error('Notebook not found');

  notebook.deleted = false;
  notebook.modified = Date.now();
  notebook.synced = false;

  await db.put('notebooks', notebook);
  console.log('Notebook restored:', id);
  return notebook;
}

/**
 * Restore a deleted note
 */
export async function restoreNote(id) {
  const note = await db.get('notes', id);
  if (!note) throw new Error('Note not found');

  note.deleted = false;
  note.modified = Date.now();
  note.synced = false;

  await db.put('notes', note);
  console.log('Note restored:', id);
  return note;
}

/**
 * Permanently delete a notebook (hard delete)
 */
export async function permanentlyDeleteNotebook(id) {
  await db.delete('notebooks', id);
  console.log('Notebook permanently deleted:', id);
}

/**
 * Permanently delete a note (hard delete)
 */
export async function permanentlyDeleteNote(id) {
  await db.delete('notes', id);
  console.log('Note permanently deleted:', id);
}

/**
 * Empty recycle bin (permanently delete all deleted items)
 */
export async function emptyRecycleBin() {
  const deletedNotebooks = await getDeletedNotebooks();
  const deletedNotes = await getDeletedNotes();

  for (const notebook of deletedNotebooks) {
    await db.delete('notebooks', notebook.id);
  }

  for (const note of deletedNotes) {
    await db.delete('notes', note.id);
  }

  console.log(`Recycle bin emptied: ${deletedNotebooks.length} notebooks, ${deletedNotes.length} notes`);
  return {
    notebooksDeleted: deletedNotebooks.length,
    notesDeleted: deletedNotes.length,
  };
}

// ========== Settings Operations ==========

/**
 * Get a setting value
 */
export async function getSetting(key) {
  const setting = await db.get('settings', key);
  return setting ? setting.value : null;
}

/**
 * Set a setting value
 */
export async function setSetting(key, value) {
  await db.put('settings', { key, value });
  console.log('Setting saved:', key);
}

// ========== Utility Functions ==========

/**
 * Get storage statistics
 */
export async function getStorageStats() {
  const notebooks = await getAllNotebooks();
  const notes = await getAllNotes();

  return {
    notebookCount: notebooks.length,
    noteCount: notes.length,
    quickNoteCount: notes.filter(n => !n.notebookId).length,
  };
}

/**
 * Clear all data (for debugging/testing)
 */
export async function clearAllData() {
  await db.clear('notebooks');
  await db.clear('notes');
  await db.clear('settings');
  await db.clear('syncQueue');
  console.log('All data cleared');
}
