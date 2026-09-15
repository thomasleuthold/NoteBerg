/**
 * The proxy's own refusals, as distinct from an upstream provider's failures.
 *
 * A quota or model rejection comes from this app rather than from the AI
 * service, so nothing about the endpoint, the model or the network is wrong.
 * The generic "Recognition proxy returned 429: …" would send a user to check a
 * provider account that is working perfectly well.
 *
 * Lives in the .nextcloud suite because proxyFetch is only reachable when
 * VITE_PLATFORM is nextcloud; on the native builds these paths do not exist.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => {
  throw new Error("not running under Tauri");
});

const band = {
  png: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  width: 100,
  height: 100,
  contentX: 0,
  contentY: 0,
  scale: 1,
};

const config = { endpoint: "https://ai.example.com/v1", model: "m", apiKey: "" };

/** A proxy refusing with one of the app's own error codes. */
function refuseWith(status, code) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status,
      text: async () => JSON.stringify({ error: code }),
    })),
  );
}

describe("the app's own refusals get their own message", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { origin: "https://cloud.example.com" }, OC: undefined });
  });

  it("names the monthly allowance rather than a rate limit", async () => {
    refuseWith(429, "quota-exceeded");
    const backend = await import("./openAiBackend.js");

    await expect(backend.transcribeBand(band, config)).rejects.toThrow(
      /monthly recognition allowance/,
    );
  });

  it("says the model is not the administrator's, not that the request failed", async () => {
    refuseWith(403, "model-not-permitted");
    const backend = await import("./openAiBackend.js");

    await expect(backend.transcribeBand(band, config)).rejects.toThrow(/administrator configured/);
  });

  it("still reports an unrecognised proxy failure with its status", async () => {
    // The fallback must survive: a refusal this code does not know about should
    // not be swallowed into one of the two messages above.
    refuseWith(500, "something-else");
    const backend = await import("./openAiBackend.js");

    await expect(backend.transcribeBand(band, config)).rejects.toThrow(/returned 500/);
  });
});
