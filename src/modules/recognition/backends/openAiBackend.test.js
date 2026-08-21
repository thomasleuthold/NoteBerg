/**
 * Covers the request/response handling of the OpenAI-compatible backend.
 *
 * Mocked responses model behaviour observed from real servers rather than an
 * idealised API: LM Studio rejects `response_format: json_object` with a 400,
 * a wrong base URL returns 200 with a non-JSON body, and small quantized models
 * hit the output cap while looping instead of transcribing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The backend prefers Tauri's HTTP client and falls back to global fetch.
// Failing the import selects the fallback, which the tests then control.
vi.mock("@tauri-apps/plugin-http", () => {
  throw new Error("not running under Tauri");
});

let transcribeBand;
let fetchMock;

const band = {
  png: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  width: 800,
  height: 400,
  contentX: 0,
  contentY: 0,
  scale: 1,
};

const config = {
  endpoint: "http://localhost:1234/v1",
  model: "qwen3-vl-4b",
  apiKey: "",
  language: "en-US",
  maxTokens: 1500,
};

/** Build a successful chat-completions response carrying `content`. */
function completion(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: extra.finishReason ?? "stop" }],
        usage: extra.usage,
      }),
  };
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  ({ transcribeBand } = await import("./openAiBackend.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request shape", () => {
  it("posts to the endpoint's chat/completions route", async () => {
    fetchMock.mockResolvedValue(completion('{"words":[]}'));
    await transcribeBand(band, config);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("adds the missing version segment rather than hitting a route that does not exist", async () => {
    // A bare server root previously produced POST /chat/completions, which
    // LM Studio answers 200 with a non-JSON body — a confusing failure.
    fetchMock.mockResolvedValue(completion('{"words":[]}'));
    await transcribeBand(band, { ...config, endpoint: "http://localhost:1234" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("caps the reply length so a looping model cannot run until the context fills", async () => {
    fetchMock.mockResolvedValue(completion('{"words":[]}'));
    await transcribeBand(band, config);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(1500);
  });

  it("sends an Authorization header only when a key is configured", async () => {
    fetchMock.mockResolvedValue(completion('{"words":[]}'));

    await transcribeBand(band, config);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    await transcribeBand(band, { ...config, apiKey: "secret" });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer secret");
  });

  it("never sends the image when the destination check fails", async () => {
    // The allowlist is coarse; this check is what confines the request to the
    // configured endpoint, so it must fire before any network call.
    const { assertAllowedDestination } = await import("../endpointValidation.js");
    expect(() =>
      assertAllowedDestination("https://evil.example.com/v1/chat/completions", config.endpoint),
    ).toThrow(/Refusing to send/);
  });
});

describe("structured output negotiation", () => {
  it("requests a json_schema, which constrains the reply shape", async () => {
    fetchMock.mockResolvedValue(completion('{"words":[]}'));
    await transcribeBand(band, config);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format.type).toBe("json_schema");
  });

  it("retries without the constraint when the server rejects it", async () => {
    // Observed from LM Studio: 400 "'response_format.type' must be
    // 'json_schema' or 'text'". A hard failure here would make the backend
    // unusable against servers with partial structured-output support.
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "{\"error\":\"'response_format.type' must be 'json_schema' or 'text'\"}",
      })
      .mockResolvedValueOnce(completion('{"words":[{"text":"hi","box":[0,0,1,1]}]}'));

    const words = await transcribeBand(band, config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format).toBeUndefined();
    expect(words).toHaveLength(1);
  });

  it("does not retry a 400 that is unrelated to structured output", async () => {
    // Retrying a genuine request error would hide the real cause and double the
    // wait on slow local inference.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"model not found"}',
    });

    await expect(transcribeBand(band, config)).rejects.toThrow(/model not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("response handling", () => {
  it("reports a non-JSON body as a likely wrong URL, naming the URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "Unexpected endpoint or method.",
    });

    await expect(transcribeBand(band, config)).rejects.toThrow(
      /did not return JSON.*chat\/completions/s,
    );
  });

  it("reports hitting the output cap as looping, not as a parse failure", async () => {
    fetchMock.mockResolvedValue(
      completion('{"words":[{"text":"a","box":[0,0,1,1]},{"text":"a"', {
        finishReason: "length",
      }),
    );

    await expect(transcribeBand(band, config)).rejects.toThrow(/token output limit/);
  });

  it("distinguishes a model that answered in the wrong shape from a wrong URL", async () => {
    fetchMock.mockResolvedValue(completion("I can see handwriting but cannot transcribe it."));
    await expect(transcribeBand(band, config)).rejects.toThrow(/did not return the expected JSON/);
  });

  it("accepts an empty word list as a valid answer", async () => {
    fetchMock.mockResolvedValue(completion('{"words":[]}'));
    await expect(transcribeBand(band, config)).resolves.toEqual([]);
  });
});
