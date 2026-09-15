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

const getSecureCredential = vi.fn();
vi.mock("./secureStorage.js", () => ({
  getSecureCredential: (...args) => getSecureCredential(...args),
  saveSecureCredential: vi.fn(),
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
  getSecureCredential.mockResolvedValue(null);
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

describe("AI backends are never started automatically", () => {
  /**
   * Configure a fully valid, consented Replicate backend. Nothing about it is
   * broken: the only reason a run may be refused is that the user did not ask
   * for it.
   */
  function configureAi() {
    getSetting.mockImplementation(
      async (key) =>
        ({
          recognition_method: "ai",
          ai_provider: "replicate",
          recognition_model: "owner/name",
          recognition_consent_host: "api.replicate.com",
          recognition_language: "en-US",
        })[key] ?? null,
    );
  }

  /** Reject if the AI pipeline was entered at all — see the note below. */
  let rasterizeNote;

  beforeEach(() => {
    configureAi();
    // A real token, so the backend is genuinely runnable. Without it Replicate
    // is merely unconfigured, and these tests would pass whether or not the
    // automatic gate exists.
    getSecureCredential.mockResolvedValue("r8_token");
    // A reachable sidecar as well, so a failure to gate shows up as the wrong
    // engine running rather than as nothing happening at all.
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
  });

  /**
   * Rasterization is the first thing the AI path does, and the only boundary
   * crossed before any network call. Asserting on fetch alone would prove
   * nothing here: under jsdom the rasterizer throws for lack of a canvas, so a
   * note that reached the AI pipeline still makes no request and still writes
   * nothing. Spying here separates "refused" from "tried and failed".
   */
  async function spyOnRasterizer() {
    const mod = await import("./recognition/pageRasterizer.js");
    rasterizeNote = vi.spyOn(mod, "rasterizeNote").mockResolvedValue([]);
    return rasterizeNote;
  }

  it("skips the startup catch-up scan without loading any note", async () => {
    // The expensive failure: billing the user for every unrecognized note in
    // the library at app start, unprompted.
    getAllNotes.mockResolvedValue([{ id: "n1", hasStrokes: true, hasRecognition: false }]);

    const processed = await autoRecognition.recognizeUnprocessedNotes();

    expect(processed).toBe(0);
    expect(getAllNotes).not.toHaveBeenCalled();
    expect(getNote).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not recognize on note close", async () => {
    // destroy() takes this path; navigation and the sync after it must not
    // stall on a call that can take minutes.
    const raster = await spyOnRasterizer();
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])], { automatic: true });

    expect(raster).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("does not recognize on the drawing debounce", async () => {
    const raster = await spyOnRasterizer();
    vi.useFakeTimers();
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    autoRecognition.scheduleRecognition("n1", [stroke("s1", [[0, 0]])]);
    await vi.advanceTimersByTimeAsync(2500);

    expect(raster).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("still runs an AI backend when the user asks for it", async () => {
    // The gate must withhold automatic runs only. If it also blocked manual
    // ones the tests above would pass with the feature entirely broken.
    const raster = await spyOnRasterizer();
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])], { force: true });

    expect(raster).toHaveBeenCalled();
  });

  it("leaves the note unrecognized so a manual run is still offered", async () => {
    // Refusing must not mark the note done — it stays a candidate for the
    // toolbar action and for the queue that will replace this gate later.
    await spyOnRasterizer();
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])], { automatic: true });

    expect(updateNote).not.toHaveBeenCalled();
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

  it("defaults to auto-detect when no language setting is stored", async () => {
    // Not en-US: naming a language the user never chose makes the model rewrite
    // foreign words into it. The sidecar ignores the value either way — it uses
    // the Windows system recognizer — but the two paths must agree on what the
    // stored default means.
    getSetting.mockResolvedValue(null);
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    getNote.mockResolvedValue({ id: "n1", strokes: [] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(fetchMock.mock.calls[0][0]).toContain("language=auto");
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

describe("concurrent runs for one note", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue("http://127.0.0.1:5000");
    getNote.mockResolvedValue({ id: "n1", recognition: null });
  });

  /**
   * A backend call that does not resolve until released, so a second call can
   * be made while the first is genuinely still in flight. Resolving the first
   * immediately would let the second start legitimately and prove nothing.
   */
  function pendingFetch() {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    fetchMock.mockImplementation(async () => {
      await gate;
      return { ok: true, json: async () => [{ text: "hi" }] };
    });
    return () => release();
  }

  /**
   * Wait until the in-flight run has actually reached the backend.
   *
   * Several awaits sit between forceRecognition() and the request — resolving
   * the service URL, reading settings — so asserting on fetch straight after
   * the call observes a run that has started but not yet sent anything, and
   * every one of these tests would pass with the guard removed.
   */
  async function untilFetched(count) {
    for (let i = 0; i < 50 && fetchMock.mock.calls.length < count; i++) {
      await Promise.resolve();
    }
  }

  it("does not send a second request while the same note is in flight", async () => {
    // The failure this prevents: on Nextcloud each request holds the session
    // lock for the length of the upstream call, so the duplicate blocked until
    // the web server killed the connection — a bare NetworkError in the browser.
    const release = pendingFetch();

    const first = autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    const second = autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    await untilFetched(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives the joining caller the same result as the run it joined", async () => {
    // The queue decides a job succeeded or failed from this return value, so a
    // joiner receiving null would report a good run as a failure.
    const release = pendingFetch();

    const first = autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    const second = autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it("allows a new run for the same note once the previous one finished", async () => {
    // The guard must be released on completion, or a note becomes permanently
    // unrecognizable for the rest of the session.
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ text: "hi" }] });

    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when the run fails", async () => {
    // A failed run must not poison the note either — the user's retry is the
    // whole recovery path for a transient backend failure.
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    const failed = await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    expect(failed).toBeNull();

    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ text: "hi" }] });
    const ok = await autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);

    expect(ok).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serialize recognition of two different notes", async () => {
    // The lock is per note. Making it global would stall the catch-up scan and
    // the queue behind whichever note happens to be running.

    const release = pendingFetch();

    const a = autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    const b = autoRecognition.forceRecognition("n2", [stroke("s2", [[1, 1]])]);

    await untilFetched(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    release();
    await Promise.all([a, b]);
  });

  it("joins rather than duplicating when note close races the drawing debounce", async () => {
    // The real-world trigger: the debounce fires, then the user navigates away
    // and destroy() forces a run for the same note before the first returns.
    vi.useFakeTimers();
    const release = pendingFetch();

    autoRecognition.scheduleRecognition("n1", [stroke("s1", [[0, 0]])]);
    // Advances past the debounce and drains the awaits between the timer firing
    // and the request actually being sent, so the run below races a request
    // that is genuinely in flight.
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const closed = autoRecognition.forceRecognition("n1", [stroke("s1", [[0, 0]])]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    await closed;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
