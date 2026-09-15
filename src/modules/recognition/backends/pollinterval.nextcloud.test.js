/**
 * The Nextcloud build polls Replicate less often than the native ones.
 *
 * There a poll is not a direct GET: it goes through the app's own proxy, whose
 * dispatch route is rate-limited per user (60 per 300s). At the native 1.5s
 * cadence a single band's polling spends that budget after 90 seconds — inside
 * the 5-minute poll window — and the prediction it was collecting is one already
 * dispatched and paid for.
 *
 * Lives in the .nextcloud suite because the interval is chosen at build time
 * from VITE_PLATFORM, which only that config defines. Asserted through observed
 * poll timing rather than by exporting the constant: the constant is an
 * implementation detail, the cadence is the thing that must hold.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => {
  throw new Error("not running under Tauri");
});

/** The proxy envelope a synchronous /dispatch reply carries. */
function envelope(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ async: false, status: 200, body: JSON.stringify(body) }),
  };
}

describe("poll interval on Nextcloud", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  it("waits longer between polls than the native builds do", async () => {
    const backend = await import("./replicateBackend.js");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "https://cloud.example.com" }, OC: undefined });

    fetchMock
      .mockResolvedValueOnce(envelope({ status: "processing" }))
      .mockResolvedValue(envelope({ status: "succeeded", output: '{"words":[{"text":"hi"}]}' }));

    const promise = backend.resumePrediction("https://api.replicate.com/v1/predictions/abc", {
      model: "a/b",
      apiKey: "",
    });

    // The first collect has happened; a native-cadence wait must not have
    // produced a second one.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the Nextcloud interval, polling resumes.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await promise;
  });
});
