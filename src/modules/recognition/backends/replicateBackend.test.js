/**
 * Covers the Replicate predictions API adapter.
 *
 * Replicate differs from OpenAI-compatible servers in ways that each have a
 * failure mode worth pinning: output arrives as an array of token fragments,
 * `Prefer: wait` can return a still-running prediction, and inline images are
 * limited to roughly 1MB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => {
  throw new Error("not running under Tauri");
});

let backend;
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
  backend: "replicate",
  model: "lucataco/qwen3-vl-8b-instruct",
  replicateVersion: "abc123",
  apiKey: "r8_token",
  language: "en-US",
  maxTokens: 1500,
};

const WORDS_JSON = '{"words":[{"text":"hi","box":[0,0,1,1]}]}';

/**
 * The schema lookup that precedes every prediction (see fetchInputSchema).
 * Declaring the real field names keeps the tests honest about what is sent.
 */
function schemaResponse(
  properties = {
    image: { type: "string" },
    prompt: { type: "string" },
    max_new_tokens: { type: "integer" },
    temperature: { type: "number" },
  },
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      openapi_schema: {
        components: { schemas: { Input: { properties } } },
      },
    }),
  };
}

function prediction(fields) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "succeeded", ...fields }),
    json: async () => ({ status: "succeeded", ...fields }),
  };
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  backend = await import("./replicateBackend.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("buildPredictionUrl", () => {
  it("uses the version endpoint when a version is configured", () => {
    // Community models — including the qwen3-vl one — cannot be run by name.
    expect(backend.buildPredictionUrl(config)).toBe("https://api.replicate.com/v1/predictions");
  });

  it("uses the owner/name endpoint when no version is given", () => {
    expect(backend.buildPredictionUrl({ ...config, replicateVersion: "" })).toBe(
      "https://api.replicate.com/v1/models/lucataco/qwen3-vl-8b-instruct/predictions",
    );
  });
});

describe("outputToText", () => {
  it("concatenates streamed fragments without inserting separators", () => {
    // Replicate language models emit token fragments; joining with a space
    // would corrupt any word split across two fragments.
    expect(backend.outputToText(['{"words":', '[{"text":"hi"']).length).toBeGreaterThan(0);
    expect(backend.outputToText(["ab", "cd"])).toBe("abcd");
  });

  it("passes a plain string through", () => {
    expect(backend.outputToText("hello")).toBe("hello");
  });

  it("rejects shapes it cannot interpret rather than coercing them", () => {
    expect(backend.outputToText({ text: "hi" })).toBeNull();
    expect(backend.outputToText([1, 2])).toBeNull();
    expect(backend.outputToText(undefined)).toBeNull();
  });
});

describe("transcribeBand", () => {
  it("sends the token as a bearer header and asks for a synchronous result", async () => {
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));
    await backend.transcribeBand(band, config);

    // Call 0 is the schema lookup; call 1 is the prediction.
    const [, init] = fetchMock.mock.calls[1];
    expect(init.headers.Authorization).toBe("Bearer r8_token");
    expect(init.headers.Prefer).toBe("wait");
  });

  it("passes the version and the image in the prediction input", async () => {
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));
    await backend.transcribeBand(band, config);

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.version).toBe("abc123");
    expect(body.input.image).toMatch(/^data:image\/png;base64,/);
    expect(body.input.prompt).toMatch(/"words"/);
  });

  it("omits the version field when running an official model by name", async () => {
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));
    await backend.transcribeBand(band, { ...config, replicateVersion: "" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).version).toBeUndefined();
  });

  it("parses fragmented output into words", async () => {
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(
        prediction({ output: ['{"words":[{"text":"hi",', '"box":[0,0,1,1]}]}'] }),
      );
    const words = await backend.transcribeBand(band, config);
    expect(words).toEqual([{ text: "hi", box: [0, 0, 1, 1] }]);
  });

  it("polls when Prefer: wait returns a still-running prediction", async () => {
    // The sync header gives up after ~60s; without polling a slow cold boot
    // would surface as an empty result rather than as a transcription.
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "processing",
            urls: { get: "https://api.replicate.com/v1/predictions/xyz" },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "succeeded", output: WORDS_JSON }),
      });

    const promise = backend.transcribeBand(band, config);
    await vi.advanceTimersByTimeAsync(2000);
    const words = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].method).toBe("GET");
    expect(words).toHaveLength(1);
  });

  it("surfaces a failed prediction rather than treating it as empty", async () => {
    fetchMock.mockResolvedValueOnce(schemaResponse()).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "failed", error: "CUDA OOM" }),
    });
    await expect(backend.transcribeBand(band, config)).rejects.toThrow(/failed.*CUDA OOM/);
  });

  it("requires a token, which Replicate always needs", async () => {
    await expect(backend.transcribeBand(band, { ...config, apiKey: "" })).rejects.toThrow(
      /requires an API token/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an image beyond the inline data-URI limit with an actionable message", async () => {
    // Replicate recommends data URIs only under ~1MB; a larger one needs a
    // separate upload step, so fail with the setting to change rather than
    // sending a request that will be rejected.
    const big = {
      ...band,
      png: new Blob([new Uint8Array(1_200_000)], { type: "image/png" }),
    };
    await expect(backend.transcribeBand(big, config)).rejects.toThrow(/Max image size/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an HTTP error with the response body", async () => {
    fetchMock.mockResolvedValueOnce(schemaResponse()).mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => '{"detail":"Insufficient credit"}',
    });
    await expect(backend.transcribeBand(band, config)).rejects.toThrow(/402.*Insufficient credit/);
  });

  it("distinguishes a non-JSON model reply from a transport failure", async () => {
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(prediction({ output: "I cannot read this image." }));
    await expect(backend.transcribeBand(band, config)).rejects.toThrow(
      /did not return the expected JSON/,
    );
  });
});

describe("input schema adaptation", () => {
  it("uses the image field name the model declares, not a guessed one", async () => {
    // openai/gpt-5-mini declares image_input, not image. Sending the wrong name
    // is silently ignored by Replicate, so the model runs blind.
    fetchMock
      .mockResolvedValueOnce(
        schemaResponse({
          image_input: { type: "array" },
          prompt: { type: "string" },
        }),
      )
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));

    await backend.transcribeBand(band, config);

    const input = JSON.parse(fetchMock.mock.calls[1][1].body).input;
    expect(input.image_input).toBeDefined();
    expect(input.image).toBeUndefined();
  });

  it("wraps the image in an array when the model declares an array type", async () => {
    // Observed 422: "input.image_input: Invalid type. Expected: array, given: string".
    fetchMock
      .mockResolvedValueOnce(
        schemaResponse({
          image_input: { type: "array" },
          prompt: { type: "string" },
        }),
      )
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));

    await backend.transcribeBand(band, config);

    const input = JSON.parse(fetchMock.mock.calls[1][1].body).input;
    expect(Array.isArray(input.image_input)).toBe(true);
    expect(input.image_input[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("keeps the image a bare string when no array type is declared", async () => {
    fetchMock
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));

    await backend.transcribeBand(band, config);

    const input = JSON.parse(fetchMock.mock.calls[1][1].body).input;
    expect(typeof input.image).toBe("string");
  });

  it("omits tuning fields the model does not declare", async () => {
    // A hosted GPT wrapper exposes a different field set from a vision model;
    // sending undeclared fields risks another 422.
    fetchMock
      .mockResolvedValueOnce(
        schemaResponse({ image_input: { type: "array" }, prompt: { type: "string" } }),
      )
      .mockResolvedValueOnce(prediction({ output: WORDS_JSON }));

    await backend.transcribeBand(band, config);

    const input = JSON.parse(fetchMock.mock.calls[1][1].body).input;
    expect(input.max_new_tokens).toBeUndefined();
    expect(input.temperature).toBeUndefined();
  });

  it("fails with the available field list when no image input exists at all", async () => {
    fetchMock.mockResolvedValueOnce(
      schemaResponse({ prompt: { type: "string" }, seed: { type: "integer" } }),
    );

    await expect(backend.transcribeBand(band, config)).rejects.toThrow(
      /declares no image input field.*prompt, seed/s,
    );
  });
});

describe("coerceToDeclaredType", () => {
  it("wraps a scalar for an array field", () => {
    expect(backend.coerceToDeclaredType("x", "f", { f: { type: "array" } })).toEqual(["x"]);
  });

  it("unwraps an array for a scalar field", () => {
    expect(backend.coerceToDeclaredType(["x"], "f", { f: { type: "string" } })).toBe("x");
  });

  it("leaves the value alone when the schema is unavailable", () => {
    expect(backend.coerceToDeclaredType("x", "f", null)).toBe("x");
  });
});
