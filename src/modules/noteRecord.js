/**
 * How a note is kept in IndexedDB: a small index record (listed often, never
 * encrypted) and a content record (strokes, text, media...). Pure, so the
 * storage worker assembles and splits notes exactly as storage.js does.
 */

// ─── Index field list ─────────────────────────────────────────────────────────
// Fields stored in the "notes" index store (never encrypted).
export const INDEX_FIELDS = new Set([
  "id",
  "notebookId",
  "title",
  "created",
  "modified",
  "version",
  "synced",
  "lastSyncedEtag",
  "deleted",
  "purged",
  "previousNotebookId",
  "restoredAt", // set by a backup restore; cleared once the note is uploaded
  "encrypted",
  "background",
  "formatVersion",
  "tags",
  "hasStrokes",
  "hasContent",
  "hasRecognition",
  "media", // metadata-only snapshot — see splitNote()
  "recordings", // metadata-only snapshot — see splitNote()
]);

// ─── Schema helpers ───────────────────────────────────────────────────────────

/**
 * Split a full note object into { index, content } for storage.
 * The index entry gets a lightweight media snapshot (no blobs, no positions).
 */
export function splitNote(note) {
  const index = {};
  const content = { id: note.id };

  for (const [key, value] of Object.entries(note)) {
    if (key === "media") {
      // Index: metadata only (for sync decisions)
      index.media = Array.isArray(value)
        ? value.map(({ id, name, type, size, deleted }) => ({ id, name, type, size, deleted }))
        : [];
      // Content: full objects (fileId, positions, etc.)
      content.media = value ?? [];
    } else if (key === "recordings") {
      // Index: metadata only (no fileId)
      index.recordings = Array.isArray(value)
        ? value.map(({ id, name, duration, deleted }) => ({ id, name, duration, deleted }))
        : [];
      // Content: full objects (fileId, etc.)
      content.recordings = value ?? [];
    } else if (INDEX_FIELDS.has(key)) {
      index[key] = value;
    } else {
      content[key] = value;
    }
  }

  // Derived flags so overview never needs to load content
  index.hasStrokes = Array.isArray(note.strokes) ? note.strokes.length > 0 : false;
  index.hasContent = typeof note.content === "string" ? note.content.trim().length > 0 : false;
  index.hasRecognition =
    note.recognition != null &&
    typeof note.recognition.fullText === "string" &&
    note.recognition.fullText.length > 0;

  return { index, content };
}

/**
 * Merge an index entry and a content record back into a single note object.
 * Content fields win when both sides have the same key.
 */
export function mergeNote(index, content) {
  if (!index) return null;
  // Use full recordings/media from content (have fileIds); index copies are metadata-only
  return {
    ...index,
    ...(content ?? {}),
    media: content?.media ?? index.media ?? [],
    recordings: content?.recordings ?? index.recordings ?? [],
  };
}
