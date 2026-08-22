/**
 * Covers backend selection — which is a privacy control, not a convenience.
 *
 * Two guarantees live here and nowhere else: recognition never falls back to a
 * backend the user did not choose, and it never sends handwriting to a remote
 * host the user has not agreed to. Both fail silently if broken — handwriting
 * simply goes somewhere unintended — so neither is safe to leave untested.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Settings the fake store answers with. Rewritten per test. */
let settings = {};
/** Credentials the fake secure store answers with. */
let credentials = {};
/** Whether the Windows sidecar reports itself available. */
let sidecarAvailable = true;

vi.mock("../storage.js", () => ({
  getSetting: async (key) => settings[key] ?? null,
  setSetting: async (key, value) => {
    settings[key] = value;
  },
}));

vi.mock("../secureStorage.js", () => ({
  getSecureCredential: async (key) => credentials[key] ?? null,
  saveSecureCredential: async (key, value) => {
    credentials[key] = value;
  },
}));

vi.mock("./backends/sidecarBackend.js", () => ({
  ENGINE_ID: "sidecar-uwp",
  isAvailable: async () => sidecarAvailable,
  invalidateUrl: () => {},
  recognizeStrokes: async () => [
    { text: "hello", boundingRect: { x: 1, y: 2, width: 3, height: 4 } },
  ],
}));

/** A stroke with a single point — enough to be non-empty. */
const STROKES = [{ id: "s1", x: [0], y: [0] }];

async function load() {
  vi.resetModules();
  return import("./recognitionService.js");
}

beforeEach(() => {
  settings = {};
  credentials = {};
  sidecarAvailable = true;
});

describe("selectBackend", () => {
  it("uses the sidecar when nothing is configured", async () => {
    const { selectBackend } = await load();
    expect((await selectBackend())?.id).toBe("sidecar");
  });

  it("refuses to fall back to the sidecar when an AI backend is chosen", async () => {
    // The privacy guarantee: choosing a backend that turns out to be
    // unconfigured must disable recognition, never silently route strokes to a
    // different engine than the one the user picked.
    settings.recognition_backend = "openai";
    settings.recognition_endpoint = "";
    sidecarAvailable = true;

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("refuses to fall back to an AI backend when the sidecar is missing", async () => {
    // The mirror case: no sidecar must mean no recognition, not an opportunistic
    // upload to whatever endpoint happens to be stored.
    sidecarAvailable = false;
    settings.recognition_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("selects a fully configured and consented AI backend", async () => {
    settings.recognition_backend = "openai";
    settings.recognition_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.example.com";

    const { selectBackend } = await load();
    expect((await selectBackend())?.id).toBe("openai");
  });

  it("treats a remote backend without consent as unavailable", async () => {
    settings.recognition_backend = "openai";
    settings.recognition_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    // No recognition_consent_host recorded.

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("does not accept consent given for a different host", async () => {
    // Consent is per destination: agreeing to send ink to one service is not
    // agreement to send it to the next one configured.
    settings.recognition_backend = "openai";
    settings.recognition_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.previous.com";

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("needs no consent for a model running on the user's own machine", async () => {
    // Nothing leaves the device, so there is no disclosure to make — and
    // prompting anyway would train users to dismiss the dialog that matters.
    settings.recognition_backend = "openai";
    settings.recognition_endpoint = "http://localhost:1234/v1";
    settings.recognition_model = "vision";

    const { selectBackend } = await load();
    expect((await selectBackend())?.id).toBe("openai");
  });

  it("requires a token for Replicate, which cannot run without one", async () => {
    settings.recognition_backend = "replicate";
    settings.recognition_model = "owner/name";
    settings.recognition_consent_host = "api.replicate.com";

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();

    credentials.recognition_api_key = "r8_token";
    const { selectBackend: again } = await load();
    expect((await again())?.id).toBe("replicate");
  });
});

describe("recognize", () => {
  it("tags sidecar words as exact, so highlights stay crisp", async () => {
    const { recognize, PRECISION_EXACT } = await load();
    const result = await recognize(STROKES);

    expect(result.fullText).toBe("hello");
    expect(result.engine).toBe("sidecar-uwp");
    expect(result.words[0].precision).toBe(PRECISION_EXACT);
    expect(result.words[0].boundingRect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("returns null rather than running anything when no backend is available", async () => {
    sidecarAvailable = false;
    const { recognize } = await load();
    expect(await recognize(STROKES)).toBeNull();
  });

  it("returns null for a note with no strokes", async () => {
    const { recognize } = await load();
    expect(await recognize([])).toBeNull();
  });

  it("does not call a backend for an unconsented remote endpoint", async () => {
    // The strongest form of the guarantee: not "the result is discarded" but
    // "the request is never made".
    settings.recognition_backend = "openai";
    settings.recognition_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";

    const transcribeBand = vi.fn();
    vi.doMock("./backends/openAiBackend.js", () => ({
      ENGINE_PREFIX: "openai",
      transcribeBand,
      mapWordToContent: (e) => e,
    }));

    const { recognize } = await load();
    expect(await recognize(STROKES)).toBeNull();
    expect(transcribeBand).not.toHaveBeenCalled();
  });
});
