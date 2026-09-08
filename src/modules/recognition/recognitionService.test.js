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

/** Captures the config the AI path is actually run with. */
const recognizeWithAi = vi.fn(async () => null);
vi.mock("./aiRecognition.js", () => ({
  recognizeWithAi: (...args) => recognizeWithAi(...args),
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
  // Call history too, not just the fake stores: assertions about what the AI
  // path was handed are meaningless if a previous test's calls are still there.
  recognizeWithAi.mockClear();
});

describe("selectBackend", () => {
  it("uses the sidecar when nothing is configured", async () => {
    const { selectBackend } = await load();
    expect((await selectBackend())?.id).toBe("windowsInk");
  });

  it("refuses to fall back to the sidecar when an AI backend is chosen", async () => {
    // The privacy guarantee: choosing a backend that turns out to be
    // unconfigured must disable recognition, never silently route strokes to a
    // different engine than the one the user picked.
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "";
    sidecarAvailable = true;

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("refuses to fall back to an AI backend when the sidecar is missing", async () => {
    // The mirror case: no sidecar must mean no recognition, not an opportunistic
    // upload to whatever endpoint happens to be stored.
    sidecarAvailable = false;
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("selects a fully configured and consented AI backend", async () => {
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.example.com";

    const { selectBackend } = await load();
    expect((await selectBackend())?.id).toBe("ai");
  });

  it("treats a remote backend without consent as unavailable", async () => {
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    // No recognition_consent_host recorded.

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("does not accept consent given for a different host", async () => {
    // Consent is per destination: agreeing to send ink to one service is not
    // agreement to send it to the next one configured.
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.previous.com";

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();
  });

  it("needs no consent for a model running on the user's own machine", async () => {
    // Nothing leaves the device, so there is no disclosure to make — and
    // prompting anyway would train users to dismiss the dialog that matters.
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "http://localhost:1234/v1";
    settings.recognition_model = "vision";

    const { selectBackend } = await load();
    expect((await selectBackend())?.id).toBe("ai");
  });

  it("refuses an AI backend for an app-triggered run", async () => {
    // AI recognition costs money per call and takes minutes. Only a person may
    // start one — closing a note or the startup catch-up scan must not.
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.example.com";

    const { selectBackend } = await load();
    // Fully configured and consented: the only thing withholding it is that
    // the user did not ask.
    expect((await selectBackend())?.id).toBe("ai");
    expect(await selectBackend({ automatic: true })).toBeNull();
  });

  it("does not silently fall back to the sidecar when AI is refused automatically", async () => {
    // Refusing an AI backend must disable this run, not reroute the strokes to
    // an engine the user did not select — the same guarantee as an unconfigured
    // backend, which the automatic gate must not weaken.
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.example.com";
    sidecarAvailable = true;

    const { selectBackend } = await load();
    expect(await selectBackend({ automatic: true })).toBeNull();
  });

  it("still runs the local sidecar for an app-triggered run", async () => {
    // The gate is about cost and latency, not about automation: the local
    // engine is free and fast, so background recognition keeps working.
    const { selectBackend } = await load();
    expect((await selectBackend({ automatic: true }))?.id).toBe("windowsInk");
  });

  it("requires a token for Replicate, which cannot run without one", async () => {
    settings.recognition_method = "ai";
    settings.ai_provider = "replicate";
    settings.recognition_model = "owner/name";
    settings.recognition_consent_host = "api.replicate.com";

    const { selectBackend } = await load();
    expect(await selectBackend()).toBeNull();

    credentials["ai_api_key:replicate"] = "r8_token";
    const { selectBackend: again } = await load();
    expect((await again())?.id).toBe("ai");
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

  it("does not call an AI backend for an app-triggered run", async () => {
    // As with consent, the guarantee is "the request is never made" — not that
    // a result is discarded after the user has already been billed for it.
    settings.recognition_method = "ai";
    settings.ai_provider = "replicate";
    settings.recognition_model = "owner/name";
    settings.recognition_consent_host = "api.replicate.com";
    credentials["ai_api_key:replicate"] = "r8_token";

    const transcribeBand = vi.fn();
    vi.doMock("./backends/replicateBackend.js", () => ({
      ENGINE_PREFIX: "replicate",
      transcribeBand,
    }));

    const { recognize } = await load();
    expect(await recognize(STROKES, { automatic: true })).toBeNull();
    expect(transcribeBand).not.toHaveBeenCalled();
  });

  it("does not call a backend for an unconsented remote endpoint", async () => {
    // The strongest form of the guarantee: not "the result is discarded" but
    // "the request is never made".
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
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

describe("engineDisplayName", () => {
  it("names the Windows sidecar in words a user recognizes", async () => {
    const { engineDisplayName } = await load();
    expect(engineDisplayName("sidecar-uwp")).toBe("Windows Ink");
  });

  it("reduces an AI engine id to the model that produced the text", async () => {
    // The provider is a delivery detail the user already chose in settings; the
    // model is what distinguishes one run's output from another's.
    const { engineDisplayName } = await load();
    expect(engineDisplayName("openai:qwen2.5-vl")).toBe("qwen2.5-vl");
    expect(engineDisplayName("replicate:some/model:abc123")).toBe("some/model:abc123");
  });

  it("returns null when the result predates the engine field", async () => {
    // Old notes get no engine line at all rather than a placeholder that would
    // assert something about them that is not known.
    const { engineDisplayName } = await load();
    expect(engineDisplayName(undefined)).toBeNull();
    expect(engineDisplayName("")).toBeNull();
  });

  it("falls back to the raw id rather than showing nothing", async () => {
    // An id in some future shape is still more informative than an absent line.
    const { engineDisplayName } = await load();
    expect(engineDisplayName("future-engine")).toBe("future-engine");
    expect(engineDisplayName("openai:")).toBe("openai:");
  });
});

describe("stored text keeps the shape of the handwriting", () => {
  it("renders break entries as newlines in fullText", async () => {
    // fullText is what the user reads and what search matches against, so the
    // layout has to survive into it rather than living only in the words array.
    const { buildResult } = await load();
    const word = (text) => ({ text, precision: "approximate", boundingRect: null });

    const result = buildResult([word("shopping"), { break: 1 }, word("list")], "test");

    expect(result.fullText).toBe("shopping\nlist");
  });

  it("keeps breaks in the words array so the layout survives a re-render", async () => {
    const { buildResult } = await load();
    const word = (text) => ({ text, precision: "approximate", boundingRect: null });

    const result = buildResult([word("a"), { break: 2 }, word("b")], "test");

    expect(result.words).toHaveLength(3);
    expect(result.words[1]).toEqual({ break: 2 });
  });
});

describe("per-run configuration overrides", () => {
  /** A configured, consented AI backend — the only path overrides apply to. */
  function configureAi() {
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    settings.recognition_consent_host = "api.example.com";
  }

  it("layers a run's choices over the stored configuration", async () => {
    // The punctuation choice is made per run in the confirmation dialog, not in
    // settings, so it has to reach the backend without being stored anywhere.
    configureAi();
    const { recognize } = await load();

    await recognize(STROKES, { configOverride: { punctuation: false } });

    expect(recognizeWithAi.mock.calls[0][1].punctuation).toBe(false);
  });

  it("leaves the stored settings untouched", async () => {
    // A per-run choice that wrote itself into settings would silently become
    // permanent — the sticky licence the dialog exists to avoid.
    configureAi();
    const { recognize } = await load();

    await recognize(STROKES, { configOverride: { punctuation: false } });

    expect(settings.recognition_punctuation).toBeUndefined();
    expect(recognizeWithAi.mock.calls[0][1].model).toBe("vision");
  });

  it("cannot use an override to reach a backend consent would refuse", async () => {
    // Overrides are applied after selectBackend precisely so they can tune a run
    // the user approved, never widen it. If an override could supply an endpoint
    // it would route handwriting somewhere consent was never given for.
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://api.example.com/v1";
    settings.recognition_model = "vision";
    // No recognition_consent_host recorded — this host is not consented.
    const { recognize } = await load();

    const result = await recognize(STROKES, {
      configOverride: { endpoint: "https://api.elsewhere.com/v1" },
    });

    expect(result).toBeNull();
    expect(recognizeWithAi).not.toHaveBeenCalled();
  });
});
