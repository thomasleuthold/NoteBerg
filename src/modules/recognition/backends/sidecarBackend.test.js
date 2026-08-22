/**
 * Covers the Windows sidecar backend.
 *
 * This is the shipped, default recognition path on Windows, so its request shape
 * is a contract with a service we do not change in lockstep: the note is only
 * recognized correctly if strokes arrive in the form and order InkAnalyzer
 * expects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args) => fetchMock(...args) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => invokeMock(...args) }));

/** Two strokes, each two points, in the order they were drawn. */
const STROKES = [
  { id: "a", x: [1, 2], y: [3, 4], pressure: [0.4, 0.6] },
  { id: "b", x: [5], y: [6] },
];

function ok(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

async function load() {
  vi.resetModules();
  return import("./sidecarBackend.js");
}

beforeEach(() => {
  fetchMock.mockReset();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("http://localhost:5000");
});

describe("availability", () => {
  it("is unavailable when the sidecar command is not there", async () => {
    // This is how Android and the Nextcloud build end up with no sidecar.
    invokeMock.mockRejectedValue(new Error("no such command"));
    const { isAvailable } = await load();
    expect(await isAvailable()).toBe(false);
  });

  it("is unavailable when the sidecar reports no URL", async () => {
    invokeMock.mockResolvedValue(null);
    const { isAvailable } = await load();
    expect(await isAvailable()).toBe(false);
  });

  it("resolves the URL once and reuses it", async () => {
    const { isAvailable } = await load();
    await isAvailable();
    await isAvailable();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after the cache is invalidated", async () => {
    const { isAvailable, invalidateUrl } = await load();
    await isAvailable();
    invalidateUrl();
    await isAvailable();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("recognizeStrokes", () => {
  it("sends strokes as points in the order they were drawn", async () => {
    // InkAnalyzer groups strokes into words itself; reordering them here breaks
    // stroke-to-character association and produces garbled text.
    fetchMock.mockResolvedValue(ok([{ text: "hi" }]));
    const { recognizeStrokes } = await load();
    await recognizeStrokes(STROKES);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((s) => s.id)).toEqual(["a", "b"]);
    expect(body[0].points).toEqual([
      { x: 1, y: 3, pressure: 0.4 },
      { x: 2, y: 4, pressure: 0.6 },
    ]);
  });

  it("supplies a default pressure for strokes recorded without one", async () => {
    fetchMock.mockResolvedValue(ok([]));
    const { recognizeStrokes } = await load();
    await recognizeStrokes(STROKES);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[1].points[0].pressure).toBe(0.5);
  });

  it("escapes the language so it cannot append query parameters of its own", async () => {
    fetchMock.mockResolvedValue(ok([]));
    const { recognizeStrokes } = await load();
    await recognizeStrokes(STROKES, { language: "en-US&admin=1" });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("language=en-US%26admin%3D1");
    expect(url).not.toContain("&admin=1");
  });

  it("returns null on a service error rather than throwing", async () => {
    // A failed run must leave hasRecognition false so the catch-up scan retries,
    // not surface as an unhandled rejection in the editor.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "err",
      text: async () => "",
    });
    const { recognizeStrokes } = await load();
    expect(await recognizeStrokes(STROKES)).toBeNull();
  });

  it("returns null when the service cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { recognizeStrokes } = await load();
    expect(await recognizeStrokes(STROKES)).toBeNull();
  });

  it("returns null without calling out when no sidecar is available", async () => {
    invokeMock.mockResolvedValue(null);
    const { recognizeStrokes } = await load();
    expect(await recognizeStrokes(STROKES)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
