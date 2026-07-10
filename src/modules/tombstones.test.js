/**
 * src/modules/tombstones.test.js
 * Pure functions over plain tombstone objects — no mocking required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMediaTombstone,
  addNotebookTombstone,
  addNoteTombstone,
  cleanupOldTombstones,
  createEmptyTombstone,
  getTombstonedMediaForNote,
  getTombstonedNoteIds,
  isMediaDeleted,
  isNoteDeleted,
  removeMediaTombstone,
  removeNoteTombstone,
} from "./tombstones.js";

describe("createEmptyTombstone", () => {
  it("creates an empty structure with notes, media, notebooks arrays", () => {
    expect(createEmptyTombstone()).toEqual({ notes: [], media: [], notebooks: [] });
  });
});

describe("addNoteTombstone", () => {
  it("adds a note with an ISO deletedAt timestamp", () => {
    const t = addNoteTombstone(createEmptyTombstone(), "note-1");
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0].id).toBe("note-1");
    expect(new Date(t.notes[0].deletedAt).toISOString()).toBe(t.notes[0].deletedAt);
  });

  it("does not duplicate an already-tombstoned note", () => {
    let t = addNoteTombstone(createEmptyTombstone(), "note-1");
    const firstTimestamp = t.notes[0].deletedAt;
    t = addNoteTombstone(t, "note-1");
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0].deletedAt).toBe(firstTimestamp);
  });

  it("initializes notes array when missing on the input object", () => {
    const t = addNoteTombstone({}, "note-1");
    expect(t.notes).toHaveLength(1);
  });
});

describe("addMediaTombstone", () => {
  it("adds a media entry keyed by noteId + filename", () => {
    const t = addMediaTombstone(createEmptyTombstone(), "note-1", "img.png");
    expect(t.media).toEqual([expect.objectContaining({ noteId: "note-1", filename: "img.png" })]);
  });

  it("does not duplicate the same noteId+filename pair", () => {
    let t = addMediaTombstone(createEmptyTombstone(), "note-1", "img.png");
    t = addMediaTombstone(t, "note-1", "img.png");
    expect(t.media).toHaveLength(1);
  });

  it("treats the same filename under a different note as distinct", () => {
    let t = addMediaTombstone(createEmptyTombstone(), "note-1", "img.png");
    t = addMediaTombstone(t, "note-2", "img.png");
    expect(t.media).toHaveLength(2);
  });

  it("initializes media array when missing on the input object", () => {
    const t = addMediaTombstone({}, "note-1", "img.png");
    expect(t.media).toHaveLength(1);
  });
});

describe("addNotebookTombstone", () => {
  it("adds a notebook with an ISO deletedAt timestamp", () => {
    const t = addNotebookTombstone(createEmptyTombstone(), "nb-1");
    expect(t.notebooks).toEqual([expect.objectContaining({ id: "nb-1" })]);
  });

  it("does not duplicate an already-tombstoned notebook", () => {
    let t = addNotebookTombstone(createEmptyTombstone(), "nb-1");
    t = addNotebookTombstone(t, "nb-1");
    expect(t.notebooks).toHaveLength(1);
  });

  it("initializes notebooks array when missing on the input object", () => {
    const t = addNotebookTombstone({}, "nb-1");
    expect(t.notebooks).toHaveLength(1);
  });
});

describe("removeNoteTombstone", () => {
  it("removes a matching note", () => {
    let t = addNoteTombstone(createEmptyTombstone(), "note-1");
    t = addNoteTombstone(t, "note-2");
    t = removeNoteTombstone(t, "note-1");
    expect(t.notes.map((n) => n.id)).toEqual(["note-2"]);
  });

  it("is a no-op when notes array is missing", () => {
    expect(removeNoteTombstone({}, "note-1")).toEqual({});
  });

  it("is a no-op when the note isn't present", () => {
    const t = addNoteTombstone(createEmptyTombstone(), "note-1");
    const result = removeNoteTombstone(t, "does-not-exist");
    expect(result.notes).toHaveLength(1);
  });
});

describe("removeMediaTombstone", () => {
  it("removes a matching noteId+filename pair", () => {
    let t = addMediaTombstone(createEmptyTombstone(), "note-1", "a.png");
    t = addMediaTombstone(t, "note-1", "b.png");
    t = removeMediaTombstone(t, "note-1", "a.png");
    expect(t.media).toEqual([expect.objectContaining({ filename: "b.png" })]);
  });

  it("is a no-op when media array is missing", () => {
    expect(removeMediaTombstone({}, "note-1", "a.png")).toEqual({});
  });
});

describe("cleanupOldTombstones", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes entries older than the 90-day retention window", () => {
    const old = new Date("2026-01-01T00:00:00.000Z").toISOString(); // >90 days before mocked now
    const recent = new Date("2026-07-01T00:00:00.000Z").toISOString(); // within 90 days
    const tombstone = {
      notes: [
        { id: "old-note", deletedAt: old },
        { id: "recent-note", deletedAt: recent },
      ],
      media: [{ noteId: "n", filename: "old.png", deletedAt: old }],
      notebooks: [{ id: "old-nb", deletedAt: old }],
    };

    const result = cleanupOldTombstones(tombstone);

    expect(result.notes.map((n) => n.id)).toEqual(["recent-note"]);
    expect(result.media).toHaveLength(0);
    expect(result.notebooks).toHaveLength(0);
  });

  it("keeps entries at exactly the retention boundary excluded (strict greater-than)", () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const tombstone = { notes: [{ id: "boundary", deletedAt: cutoff.toISOString() }] };

    const result = cleanupOldTombstones(tombstone);
    expect(result.notes).toHaveLength(0);
  });

  it("handles missing arrays without throwing", () => {
    expect(cleanupOldTombstones({})).toEqual({});
  });
});

describe("isNoteDeleted", () => {
  it("returns true for a tombstoned note", () => {
    const t = addNoteTombstone(createEmptyTombstone(), "note-1");
    expect(isNoteDeleted(t, "note-1")).toBe(true);
  });

  it("returns false for a note not in the tombstone", () => {
    expect(isNoteDeleted(createEmptyTombstone(), "note-1")).toBe(false);
  });

  it("returns false when notes array is missing", () => {
    expect(isNoteDeleted({}, "note-1")).toBe(false);
  });
});

describe("isMediaDeleted", () => {
  it("returns true for a tombstoned noteId+filename pair", () => {
    const t = addMediaTombstone(createEmptyTombstone(), "note-1", "img.png");
    expect(isMediaDeleted(t, "note-1", "img.png")).toBe(true);
  });

  it("returns false for a different filename under the same note", () => {
    const t = addMediaTombstone(createEmptyTombstone(), "note-1", "img.png");
    expect(isMediaDeleted(t, "note-1", "other.png")).toBe(false);
  });

  it("returns false when media array is missing", () => {
    expect(isMediaDeleted({}, "note-1", "img.png")).toBe(false);
  });
});

describe("getTombstonedNoteIds", () => {
  it("returns all tombstoned note ids", () => {
    let t = addNoteTombstone(createEmptyTombstone(), "note-1");
    t = addNoteTombstone(t, "note-2");
    expect(getTombstonedNoteIds(t)).toEqual(["note-1", "note-2"]);
  });

  it("returns an empty array when notes is missing", () => {
    expect(getTombstonedNoteIds({})).toEqual([]);
  });
});

describe("getTombstonedMediaForNote", () => {
  it("returns filenames tombstoned for the given note only", () => {
    let t = addMediaTombstone(createEmptyTombstone(), "note-1", "a.png");
    t = addMediaTombstone(t, "note-1", "b.png");
    t = addMediaTombstone(t, "note-2", "c.png");
    expect(getTombstonedMediaForNote(t, "note-1")).toEqual(["a.png", "b.png"]);
  });

  it("returns an empty array when media is missing", () => {
    expect(getTombstonedMediaForNote({}, "note-1")).toEqual([]);
  });
});
