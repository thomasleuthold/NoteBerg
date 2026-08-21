/**
 * src/modules/autoRecognition.test.js
 * Covers URL resolution/caching, debounce scheduling, stroke filtering,
 * temporal-order preservation (per project convention: strokes must NOT be
 * spatially sorted before sending), and the unchanged-data skip check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args) => fetchMock(...args),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args) => invokeMock(...args),
}));

const getAllNotes = vi.fn();
const getNote = vi.fn();
const getSetting = vi.fn();
const updateNote = vi.fn();
vi.mock("./storage.js", () => ({
  getAllNotes: (...args) => getAllNotes(...args),
  getNote: (...args) => getNote(...args),
  getSetting: (...args) => getSetting(...args),
  updateNote: (...args) => updateNote(...args),
}));

let autoRecognition;

function stroke(id, points) {
  return {
    id,
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    pressure: points.map((p) => p[2] ?? 0.5),
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  getSetting.mockResolvedValue("en-US");
  window.dispatchEvent = vi.fn();
  autoRecognition = await import("./autoRecognition.js");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recognition URL resolution", () => {
  it("returns 0 unprocessed notes processed when the sidecar is unavailable", async () => {
    invokeMock.mockRejectedValue(new Error("not in Tauri"));
    const processed = await autoRecognition.recognizeUnprocessedNotes();
    expect(processed).toBe(0);
    expect(getAllNotes).not.toHaveBeenCalled();
  });

  it("caches the resolved URL across calls (invoke called once)", async () => {
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
    getAllNotes.mockResolvedValue([]);

    await autoRecognition.recognizeUnprocessedNotes();
    await autoRecognition.recognizeUnprocessedNotes();

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after invalidateRecognitionUrl()", async () => {
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
    getAllNotes.mockResolvedValue([]);

    await autoRecognition.recognizeUnprocessedNotes();
    autoRecognition.invalidateRecognitionUrl();
    await autoRecognition.recognizeUnprocessedNotes();

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("recognizeUnprocessedNotes", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
  });

  it("filters to notes with strokes, no recognition, and not deleted", async () => {
    getAllNotes.mockResolvedValue([
      { id: "a", hasStrokes: true, hasRecognition: false, deleted: false },
      { id: "b", hasStrokes: false, hasRecognition: false, deleted: false }, // no strokes
      { id: "c", hasStrokes: true, hasRecognition: true, deleted: false }, // already recognized
      { id: "d", hasStrokes: true, hasRecognition: false, deleted: true }, // deleted
    ]);
    getNote.mockResolvedValue({
      id: "a",
      strokes: [stroke("s1", [[0, 0]])],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ text: "hi" }],
    });

    const processed = await autoRecognition.recognizeUnprocessedNotes();

    // Called once to read strokes for candidate filtering, once inside
    // performRecognition to re-fetch before applying the update.
    expect(getNote).toHaveBeenCalledWith("a");
    expect(getNote.mock.calls.every(([id]) => id === "a")).toBe(true);
    expect(processed).toBe(1);
  });

  it("skips a note whose only strokes are soft-deleted", async () => {
    getAllNotes.mockResolvedValue([
      { id: "a", hasStrokes: true, hasRecognition: false, deleted: false },
    ]);
    getNote.mockResolvedValue({
      id: "a",
      strokes: [stroke("s1", [[0, 0]])].map((s) => ({ ...s, _deleted: true })),
    });

    const processed = await autoRecognition.recognizeUnprocessedNotes();
    expect(processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues processing remaining notes when one fails", async () => {
    getAllNotes.mockResolvedValue([
      { id: "a", hasStrokes: true, hasRecognition: false, deleted: false },
      { id: "b", hasStrokes: true, hasRecognition: false, deleted: false },
    ]);
    getNote
      .mockRejectedValueOnce(new Error("db error"))
      .mockResolvedValueOnce({ id: "b", strokes: [stroke("s1", [[0, 0]])] });
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ text: "hi" }] });

    const processed = await autoRecognition.recognizeUnprocessedNotes();
    expect(processed).toBe(1);
  });
});

describe("scheduleRecognition debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ text: "hi" }] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });
  });

  it("does not fire recognition before the debounce window elapses", () => {
    autoRecognition.scheduleRecognition("n1", [stroke("s1", [[0, 0]])]);
    vi.advanceTimersByTime(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires recognition after the debounce window", async () => {
    autoRecognition.scheduleRecognition("n1", [stroke("s1", [[0, 0]])]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("resets the debounce timer on repeated scheduling (only the last call fires)", async () => {
    autoRecognition.scheduleRecognition("n1", [stroke("s1", [[0, 0]])]);
    vi.advanceTimersByTime(2000);
    autoRecognition.scheduleRecognition("n1", [stroke("s2", [[1, 1]])]); // resets timer
    vi.advanceTimersByTime(2000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("forceRecognition", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
  });

  it("cancels a pending scheduled recognition and runs immediately", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ text: "hi" }] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    autoRecognition.scheduleRecognition("n1", [stroke("s1", [[0, 0]])]);
    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The debounced call should not fire a second time later.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when strokes are empty", async () => {
    await autoRecognition.forceRecognition("n1", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("performRecognition request/response handling", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
  });

  it("sends strokes in the given (temporal) order without re-sorting", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ text: "hi" }] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    const strokes = [stroke("late-but-left", [[0, 0]]), stroke("early-but-right", [[100, 0]])];
    await autoRecognition.forceRecognition("n1", strokes);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((s) => s.id)).toEqual(["late-but-left", "early-but-right"]);
  });

  it("formats stroke points with x/y/pressure, defaulting missing pressure to 0.5", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    const s = { id: "s1", x: [1, 2], y: [3, 4], pressure: [0.8] }; // pressure[1] missing
    await autoRecognition.forceRecognition("n1", [s]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].points).toEqual([
      { x: 1, y: 3, pressure: 0.8 },
      { x: 2, y: 4, pressure: 0.5 },
    ]);
  });

  it("includes the resolved recognition_language in the request URL", async () => {
    getSetting.mockResolvedValue("de-DE");
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(fetchMock.mock.calls[0][0]).toContain("language=de-DE");
  });

  it("defaults to en-US when no language setting is stored", async () => {
    getSetting.mockResolvedValue(null);
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(fetchMock.mock.calls[0][0]).toContain("language=en-US");
  });

  it("does not update the note when the service call fails", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("does not update the note when the response is not ok", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
    });
    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("updates the note with flattened fullText and word list on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ text: "hello" }, { text: "world" }],
    });
    getNote.mockResolvedValue({ id: "n1", recognition: null });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    // Sidecar results are tagged exact and carry the engine id so a note
    // recognized by two different engines can be told apart across devices.
    expect(updateNote).toHaveBeenCalledWith("n1", {
      recognition: {
        fullText: "hello world",
        engine: "sidecar-uwp",
        words: [
          { text: "hello", precision: "exact", boundingRect: null },
          { text: "world", precision: "exact", boundingRect: null },
        ],
      },
    });
  });

  it("skips the update when recognition data is unchanged", async () => {
    const existing = { fullText: "hello world", words: [{ text: "hello" }, { text: "world" }] };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ text: "hello" }, { text: "world" }],
    });
    getNote.mockResolvedValue({ id: "n1", recognition: existing });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(updateNote).not.toHaveBeenCalled();
  });

  it("dispatches recognition-start then recognition-end around the call", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    const types = window.dispatchEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(["recognition-start", "recognition-end"]);
  });

  it("still dispatches recognition-end when the call throws unexpectedly", async () => {
    getSetting.mockRejectedValue(new Error("settings read failed"));

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    const types = window.dispatchEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(["recognition-start", "recognition-end"]);
  });
});

describe("forced re-recognition", () => {
  it("writes the result even when it matches what is already stored", async () => {
    // A user who explicitly asks to recognize again expects the stored result
    // to be replaced — including when a different backend produces the same
    // text. Without this, re-running with a new model appears to do nothing.
    const existing = {
      fullText: "hello world",
      engine: "sidecar-uwp",
      words: [
        { text: "hello", precision: "exact", boundingRect: null },
        { text: "world", precision: "exact", boundingRect: null },
      ],
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ text: "hello" }, { text: "world" }],
    });
    getNote.mockResolvedValue({ id: "n1", recognition: existing });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])], { force: true });

    expect(updateNote).toHaveBeenCalled();
  });

  it("still skips the write for a background pass with unchanged data", async () => {
    // The churn guard must survive: several devices recognizing the same note
    // would otherwise ping-pong writes at each other through sync.
    const existing = {
      fullText: "hello world",
      engine: "sidecar-uwp",
      words: [
        { text: "hello", precision: "exact", boundingRect: null },
        { text: "world", precision: "exact", boundingRect: null },
      ],
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ text: "hello" }, { text: "world" }],
    });
    getNote.mockResolvedValue({ id: "n1", recognition: existing });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(updateNote).not.toHaveBeenCalled();
  });
});
