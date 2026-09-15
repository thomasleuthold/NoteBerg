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
      .mockResolvedValueOnce(completion('{"words":[{"text":"hi","region":"green"}]}'));

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
      completion('{"words":[{"text":"a","region":"blue"},{"text":"a"', {
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

describe("request timeout", () => {
  const WORDS = '{"words":[{"text":"test","region":"blue"}]}';

  /** A completion that never arrives until the returned function is called. */
  function hangingFetch() {
    let settle;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((resolve, reject) => {
          settle = resolve;
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    return () => settle?.({ ok: true, status: 200, text: async () => "{}" });
  }

  it("gives up on a model that never answers, naming the setting to raise", async () => {
    // kimi-k2.6 through OpenRouter: a working model that is simply slower than
    // the budget. The message has to point at the timeout, because "use a faster
    // model" is not the only remedy and often not the right one.
    vi.useFakeTimers();
    hangingFetch();

    const promise = transcribeBand(band, { ...config, timeoutSeconds: 30 });
    const assertion = expect(promise).rejects.toThrow(/did not respond within 30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    vi.useRealTimers();
  });

  it("reports a caller's cancellation as a cancellation, not as a timeout", async () => {
    // The two are the same DOMException. Telling a user who cancelled to raise
    // their timeout would be nonsense.
    hangingFetch();

    const controller = new AbortController();
    const promise = transcribeBand(
      band,
      { ...config, timeoutSeconds: 30 },
      { signal: controller.signal },
    );

    // Wait until the request is genuinely in flight. transcribeBand encodes the
    // image and resolves a client before it calls fetch, so aborting straight
    // away would land before the request existed and prove nothing.
    for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    controller.abort();

    const err = await promise.catch((e) => e);
    expect(err.message).not.toMatch(/did not respond within/);
  });

  it("sends the budget to the proxy, which does the waiting server-side", async () => {
    // On Nextcloud the wait happens in PHP. A client-side abort cannot lengthen
    // a cap enforced there, so the number has to travel with the request.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: WORDS }, finish_reason: "stop" }],
        }),
    });

    await transcribeBand(band, { ...config, timeoutSeconds: 240 });

    expect(fetchMock.mock.calls[0][1].timeoutSeconds).toBe(240);
  });

  it("falls back to a workable default when no timeout is configured", async () => {
    // An existing configuration saved before this setting existed has no value
    // stored, and must not end up with a zero or absent budget.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: WORDS }, finish_reason: "stop" }],
        }),
    });

    await transcribeBand(band, config);

    expect(fetchMock.mock.calls[0][1].timeoutSeconds).toBe(120);
  });
});

describe("message shapes", () => {
  /** A completion whose message is built by the caller, not just `content`. */
  function messageResponse(message, finishReason = "stop") {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }),
    };
  }

  const WORDS = '{"words":[{"text":"test","region":"blue"}]}';

  it("reads the transcription from `reasoning` when content is null", async () => {
    // OpenRouter routes some model ids to reasoning models, which return their
    // output in `reasoning` and leave `content` null. Seen in the wild as a test
    // that failed with 350 completion tokens and finish_reason "stop" — the
    // model had answered, just not where the spec puts the answer.
    fetchMock.mockResolvedValue(messageResponse({ content: null, reasoning: WORDS }));

    await expect(transcribeBand(band, config)).resolves.toEqual([{ text: "test", region: "blue" }]);
  });

  it("reads `reasoning_content` too, for gateways that name it that way", async () => {
    fetchMock.mockResolvedValue(messageResponse({ content: null, reasoning_content: WORDS }));

    await expect(transcribeBand(band, config)).resolves.toEqual([{ text: "test", region: "blue" }]);
  });

  it("prefers content over reasoning when a model returns both", async () => {
    // Reasoning is the model's thinking; content is its answer. Taking the
    // thinking in preference would transcribe the model's deliberation.
    fetchMock.mockResolvedValue(
      messageResponse({ content: WORDS, reasoning: '{"words":[{"text":"thinking"}]}' }),
    );

    await expect(transcribeBand(band, config)).resolves.toEqual([{ text: "test", region: "blue" }]);
  });

  it("joins typed content parts rather than keeping only the first", async () => {
    // Splitting the answer across parts is legal, and taking one part would
    // truncate the transcription with nothing to show it had happened.
    fetchMock.mockResolvedValue(
      messageResponse({
        content: [
          { type: "text", text: '{"words":[{"text":"te' },
          { type: "text", text: 'st","region":"blue"}]}' },
        ],
      }),
    );

    await expect(transcribeBand(band, config)).resolves.toEqual([{ text: "test", region: "blue" }]);
  });

  it("surfaces a refusal as a refusal rather than as missing content", async () => {
    fetchMock.mockResolvedValue(
      messageResponse({ content: null, refusal: "I cannot process images of people." }),
    );

    await expect(transcribeBand(band, config)).rejects.toThrow(/declined to transcribe/);
  });

  it("names finish_reason and the message when there is genuinely no content", async () => {
    // The old message sliced the raw body, which for a pretty-printed response
    // is 200 characters of indentation — it showed the user blank lines and hid
    // the field that would have explained the failure.
    fetchMock.mockResolvedValue(messageResponse({ content: null }, "content_filter"));

    const err = await transcribeBand(band, config).catch((e) => e);
    // Names why it stopped, and shows the message object that lacked content.
    expect(err.message).toMatch(/content_filter/);
    expect(err.message).toMatch(/"content":null/);
  });
});

describe("mapWordToContent", () => {
  it("passes a break through instead of discarding it as an unusable word", async () => {
    // Breaks share the words array with words and carry no text, so the guard
    // that drops textless entries has to let them past or the layout is lost
    // before it reaches the stitcher.
    const { mapWordToContent } = await import("./openAiBackend.js");
    expect(mapWordToContent({ break: 1 })).toEqual({ break: 1 });
    expect(mapWordToContent({ break: 2 })).toEqual({ break: 2 });
  });
});
