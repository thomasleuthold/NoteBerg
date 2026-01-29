/**
 * Tombstone Management Module
 * Handles tracking of deleted items for sync
 *
 * Tombstone structure per notebook:
 * {
 *   "notes": [
 *     {
 *       "id": "note-id",
 *       "deletedAt": "2025-01-15T10:30:00Z"
 *     }
 *   ],
 *   "media": [
 *     {
 *       "noteId": "note-id",
 *       "filename": "image1.jpg",
 *       "deletedAt": "2025-01-15T10:30:00Z"
 *     }
 *   ]
 * }
 */

const TOMBSTONE_RETENTION_DAYS = 90; // Keep tombstones for 90 days

/**
 * Create an empty tombstone structure
 */
export function createEmptyTombstone() {
  return {
    notes: [],
    media: [],
    notebooks: [],
  };
}

/**
 * Add a deleted note to tombstone
 */
export function addNoteTombstone(tombstone, noteId) {
  if (!tombstone.notes) {
    tombstone.notes = [];
  }

  // Check if already exists
  const existing = tombstone.notes.find((t) => t.id === noteId);
  if (existing) {
    return tombstone;
  }

  tombstone.notes.push({
    id: noteId,
    deletedAt: new Date().toISOString(),
  });

  return tombstone;
}

/**
 * Add a deleted media file to tombstone
 */
export function addMediaTombstone(tombstone, noteId, filename) {
  if (!tombstone.media) {
    tombstone.media = [];
  }

  // Check if already exists
  const existing = tombstone.media.find((t) => t.noteId === noteId && t.filename === filename);
  if (existing) {
    return tombstone;
  }

  tombstone.media.push({
    noteId,
    filename,
    deletedAt: new Date().toISOString(),
  });

  return tombstone;
}

/**
 * Add a deleted notebook to tombstone
 */
export function addNotebookTombstone(tombstone, notebookId) {
  if (!tombstone.notebooks) {
    tombstone.notebooks = [];
  }

  const existing = tombstone.notebooks.find((t) => t.id === notebookId);
  if (existing) {
    return tombstone;
  }

  tombstone.notebooks.push({
    id: notebookId,
    deletedAt: new Date().toISOString(),
  });

  return tombstone;
}

/**
 * Remove a note from tombstone (e.g., after successful cleanup)
 */
export function removeNoteTombstone(tombstone, noteId) {
  if (!tombstone.notes) {
    return tombstone;
  }

  tombstone.notes = tombstone.notes.filter((t) => t.id !== noteId);
  return tombstone;
}

/**
 * Remove a media file from tombstone
 */
export function removeMediaTombstone(tombstone, noteId, filename) {
  if (!tombstone.media) {
    return tombstone;
  }

  tombstone.media = tombstone.media.filter(
    (t) => !(t.noteId === noteId && t.filename === filename),
  );
  return tombstone;
}

/**
 * Clean up old tombstones (older than retention period)
 */
export function cleanupOldTombstones(tombstone) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - TOMBSTONE_RETENTION_DAYS);
  const cutoffTime = cutoffDate.toISOString();

  if (tombstone.notes) {
    tombstone.notes = tombstone.notes.filter((t) => t.deletedAt > cutoffTime);
  }

  if (tombstone.media) {
    tombstone.media = tombstone.media.filter((t) => t.deletedAt > cutoffTime);
  }

  if (tombstone.notebooks) {
    tombstone.notebooks = tombstone.notebooks.filter((t) => t.deletedAt > cutoffTime);
  }

  return tombstone;
}

/**
 * Check if a note is in the tombstone
 */
export function isNoteDeleted(tombstone, noteId) {
  if (!tombstone.notes) {
    return false;
  }
  return tombstone.notes.some((t) => t.id === noteId);
}

/**
 * Check if a media file is in the tombstone
 */
export function isMediaDeleted(tombstone, noteId, filename) {
  if (!tombstone.media) {
    return false;
  }
  return tombstone.media.some((t) => t.noteId === noteId && t.filename === filename);
}

/**
 * Get all note IDs in tombstone
 */
export function getTombstonedNoteIds(tombstone) {
  if (!tombstone.notes) {
    return [];
  }
  return tombstone.notes.map((t) => t.id);
}

/**
 * Get all media files in tombstone for a specific note
 */
export function getTombstonedMediaForNote(tombstone, noteId) {
  if (!tombstone.media) {
    return [];
  }
  return tombstone.media.filter((t) => t.noteId === noteId).map((t) => t.filename);
}

/**
 * Merge two tombstone structures (for sync)
 * Keeps the union of all tombstones
 */
export function mergeTombstones(local, remote) {
  const merged = createEmptyTombstone();

  // Merge notes - create a map by ID to avoid duplicates
  const noteMap = new Map();

  if (local.notes) {
    for (const note of local.notes) {
      noteMap.set(note.id, note);
    }
  }

  if (remote.notes) {
    for (const note of remote.notes) {
      const existing = noteMap.get(note.id);
      // Keep the one with the latest deletion time
      if (!existing || note.deletedAt > existing.deletedAt) {
        noteMap.set(note.id, note);
      }
    }
  }

  merged.notes = Array.from(noteMap.values());

  // Merge media - create a map by noteId+filename
  const mediaMap = new Map();

  if (local.media) {
    for (const media of local.media) {
      const key = `${media.noteId}:${media.filename}`;
      mediaMap.set(key, media);
    }
  }

  if (remote.media) {
    for (const media of remote.media) {
      const key = `${media.noteId}:${media.filename}`;
      const existing = mediaMap.get(key);
      // Keep the one with the latest deletion time
      if (!existing || media.deletedAt > existing.deletedAt) {
        mediaMap.set(key, media);
      }
    }
  }

  merged.media = Array.from(mediaMap.values());

  // Merge notebooks
  const notebookMap = new Map();
  if (local.notebooks) {
    local.notebooks.forEach((n) => {
      notebookMap.set(n.id, n);
    });
  }
  if (remote.notebooks) {
    remote.notebooks.forEach((n) => {
      const existing = notebookMap.get(n.id);
      if (!existing || n.deletedAt > existing.deletedAt) {
        notebookMap.set(n.id, n);
      }
    });
  }
  merged.notebooks = Array.from(notebookMap.values());

  return merged;
}
