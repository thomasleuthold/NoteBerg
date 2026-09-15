/**
 * End-to-end check that a recognition result survives the write/read round-trip
 * and is then findable by search.
 *
 * Each piece of this chain is tested elsewhere; this covers the seams between
 * them, which is where "recognition ran but search finds nothing" would live.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stores = { notes: new Map(), noteContent: new Map() };

vi.mock("../storage.js", () => ({
  getNote: async (id) => {
    const index = stores.notes.get(id);
    const content = stores.noteContent.get(id);
    if (!index) return null;
    return { ...index, ...content };
  },
  updateNote: async (id, updates) => {
    const index = stores.notes.get(id) ?? { id };
    const content = stores.noteContent.get(id) ?? {};
    // Mirror the real updateNote: any write marks the note unsynced so
    // syncOnNoteClose picks it up.

    // Mirror _saveNoteSplit: heavy fields live in noteContent, and the derived
    // hasRecognition flag is recomputed on the index.
    const merged = { ...index, ...content, ...updates };
    const { recognition, strokes, ...indexFields } = merged;

    stores.noteContent.set(id, { recognition, strokes });
    stores.notes.set(id, {
      ...indexFields,
      synced: false,
      hasRecognition:
        recognition != null &&
        typeof recognition.fullText === "string" &&
        recognition.fullText.length > 0,
    });
    return merged;
  },
  getAllNotes: async () => [...stores.notes.values()],
  getSetting: async () => null,
}));

let recognitionService;

beforeEach(async () => {
  vi.resetModules();
  stores.notes.clear();
  stores.noteContent.clear();
  recognitionService = await import("./recognitionService.js");
});

describe("recognition persistence", () => {
  it("stores fullText that search can match against", async () => {
    const { updateNote, getNote } = await import("../storage.js");

    const words = [
      {
        text: "Hello",
        precision: "approximate",
        boundingRect: { x: 1, y: 1, width: 1, height: 1 },
      },
      { text: "world", precision: "approximate", boundingRect: null },
    ];
    const result = recognitionService.buildResult(words, "test-engine");

    await updateNote("n1", { id: "n1", recognition: result });

    const stored = await getNote("n1");
    expect(stored.recognition.fullText).toBe("Hello world");
    // A word whose geometry was dropped must still be searchable.
    expect(stored.recognition.fullText).toContain("world");
  });

  it("sets hasRecognition so the catch-up scan stops reprocessing the note", async () => {
    const { updateNote } = await import("../storage.js");
    const result = recognitionService.buildResult(
      [{ text: "found", precision: "approximate", boundingRect: null }],
      "test-engine",
    );

    await updateNote("n1", { id: "n1", recognition: result });

    expect(stores.notes.get("n1").hasRecognition).toBe(true);
  });

  it("does not lose recognition when strokes are saved afterwards", async () => {
    // Stroke saves patch only the strokes field; recognition written earlier
    // must survive, or every edit after recognition would silently clear it.
    const { updateNote, getNote } = await import("../storage.js");
    const result = recognitionService.buildResult(
      [{ text: "persisted", precision: "approximate", boundingRect: null }],
      "test-engine",
    );

    await updateNote("n1", { id: "n1", recognition: result });
    await updateNote("n1", { strokes: [{ id: "s1", x: [0], y: [0] }] });

    const stored = await getNote("n1");
    expect(stored.recognition?.fullText).toBe("persisted");
  });

  it("produces fullText with single spaces, so multi-word queries match", async () => {
    // Words arrive per-entry; a join that introduced newlines or double spaces
    // would break a substring search for a phrase the user actually wrote.
    const result = recognitionService.buildResult(
      ["This", "is", "a", "note"].map((text) => ({
        text,
        precision: "approximate",
        boundingRect: null,
      })),
      "test-engine",
    );

    expect(result.fullText).toBe("This is a note");
  });

  it("keeps punctuation attached to words rather than splitting it out", async () => {
    const result = recognitionService.buildResult(
      [
        { text: "Hello", precision: "approximate", boundingRect: null },
        { text: "world!", precision: "approximate", boundingRect: null },
      ],
      "test-engine",
    );

    expect(result.fullText).toBe("Hello world!");
  });
});

describe("sync marking", () => {
  it("marks the note unsynced so it is pushed on close", async () => {
    // syncOnNoteClose skips a note whose index still reads synced !== false,
    // so a recognition write that did not clear the flag would never reach
    // the server.
    const { updateNote } = await import("../storage.js");
    stores.notes.set("n1", { id: "n1", synced: true });

    const result = recognitionService.buildResult(
      [{ text: "recognized", precision: "approximate", boundingRect: null }],
      "test-engine",
    );
    await updateNote("n1", { recognition: result });

    expect(stores.notes.get("n1").synced).toBe(false);
  });
});
