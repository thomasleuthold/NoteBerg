/**
 * Covers the provider reachability check.
 *
 * The point of this check is that it is *free*: it must never run inference, or
 * it becomes a button people avoid pressing. Several tests below assert on the
 * request shape for that reason, not just on the outcome.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let fetchMock;

vi.mock("./backends/backendTransport.js", () => ({
  getFetch: async () => fetchMock,
}));

const load = async () => {
  vi.resetModules();
  return import("./providerCheck.js");
};

/** A canned HTTP response. */
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  fetchMock = vi.fn(async () => reply(200, { data: [{ id: "a" }, { id: "b" }] }));
});

describe("the check costs nothing", () => {
  it("asks for a listing rather than running the model", async () => {
    // A test that bills the user is a test they learn not to press.
    const { checkProvider } = await load();
    await checkProvider({ provider: "openai", endpoint: "http://localhost:1234/v1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(url).toContain("/models");
    expect(url).not.toContain("chat/completions");
    expect(init.body).toBeUndefined();
  });

  it("uses Replicate's listing rather than a prediction", async () => {
    const { checkProvider } = await load();
    await checkProvider({ provider: "replicate", apiKey: "r8_x" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.replicate.com/v1/models");
    expect(init.method).toBe("GET");
    expect(url).not.toContain("predictions");
  });
});

describe("outcomes", () => {
  it("reports success and how many models were listed", async () => {
    const { checkProvider, CHECK_OK } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "http://localhost:1234/v1",
    });

    expect(result.outcome).toBe(CHECK_OK);
    expect(result.modelCount).toBe(2);
  });

  it("reads Replicate's listing shape too", async () => {
    fetchMock.mockResolvedValue(reply(200, { results: [{ name: "one" }] }));

    const { checkProvider } = await load();
    expect((await checkProvider({ provider: "replicate", apiKey: "r8_x" })).modelCount).toBe(1);
  });

  it("treats a missing listing as success, not failure", async () => {
    // /models is near-universal among OpenAI-compatible servers but not
    // guaranteed. A server that routes completions fine may simply not
    // implement it, and calling that a broken connection would send the user
    // hunting for a fault that is not there.
    fetchMock.mockResolvedValue(reply(404, {}));

    const { checkProvider, CHECK_OK_NO_LISTING } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-x",
    });

    expect(result.outcome).toBe(CHECK_OK_NO_LISTING);
  });

  it("distinguishes a rejected credential from an unreachable host", async () => {
    // The two need different fixes — one is the key, the other the address —
    // so collapsing them into "failed" would send the user to the wrong field.
    fetchMock.mockResolvedValue(reply(401, {}));

    const { checkProvider, CHECK_UNAUTHORIZED } = await load();
    expect((await checkProvider({ provider: "replicate", apiKey: "r8_bad" })).outcome).toBe(
      CHECK_UNAUTHORIZED,
    );
  });

  it("reports an unreachable endpoint with the underlying reason", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const { checkProvider, CHECK_UNREACHABLE } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "http://localhost:9/v1",
    });

    expect(result.outcome).toBe(CHECK_UNREACHABLE);
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("reports a server error with its status", async () => {
    fetchMock.mockResolvedValue(reply(500, {}));

    const { checkProvider, CHECK_FAILED } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-x",
    });

    expect(result.outcome).toBe(CHECK_FAILED);
    expect(result.status).toBe(500);
  });

  it("still succeeds when a 200 is not JSON", async () => {
    // The endpoint answered, which is what was being asked. The count is a
    // nicety, not the result.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });

    const { checkProvider, CHECK_OK } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "http://localhost:1234/v1",
    });

    expect(result.outcome).toBe(CHECK_OK);
    expect(result.modelCount).toBeNull();
  });
});

describe("unconfigured states never reach the network", () => {
  it("refuses with no provider selected", async () => {
    const { checkProvider, CHECK_NOT_CONFIGURED } = await load();
    expect((await checkProvider({ provider: "" })).outcome).toBe(CHECK_NOT_CONFIGURED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an OpenAI provider with no endpoint", async () => {
    const { checkProvider, CHECK_NOT_CONFIGURED } = await load();
    expect((await checkProvider({ provider: "openai", endpoint: "" })).outcome).toBe(
      CHECK_NOT_CONFIGURED,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses Replicate with no token, which it cannot run without", async () => {
    const { checkProvider, CHECK_NOT_CONFIGURED } = await load();
    expect((await checkProvider({ provider: "replicate", apiKey: "" })).outcome).toBe(
      CHECK_NOT_CONFIGURED,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts Replicate when the server holds the key", async () => {
    // On Nextcloud the credential lives on the server and never reaches the
    // browser, so only its existence is knowable here.
    const { checkProvider, CHECK_OK } = await load();
    const result = await checkProvider({ provider: "replicate", apiKey: "", hasApiKey: true });

    expect(result.outcome).toBe(CHECK_OK);
  });
});

describe("credentials", () => {
  it("sends the key as a bearer token when the client holds one", async () => {
    const { checkProvider } = await load();
    await checkProvider({ provider: "replicate", apiKey: "r8_secret" });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer r8_secret");
  });

  it("sends no auth header when the client has no key to send", async () => {
    // A local model server needs no credential, and "Bearer " with nothing
    // after it reads like a bug in the server's logs.
    const { checkProvider } = await load();
    await checkProvider({ provider: "openai", endpoint: "http://localhost:1234/v1" });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("does not call a keyless remote endpoint connected", async () => {
    // OpenRouter serves /models without authentication, so this check answered
    // "Connected. 396 models available." for a configuration whose every real
    // request returns 401 — a green light that sent the user looking anywhere
    // but at the credential.
    fetchMock.mockResolvedValue(reply(200, { data: [{ id: "m" }] }));

    const { checkProvider, CHECK_KEY_REQUIRED } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "https://openrouter.ai/api/v1",
    });

    expect(result.outcome).toBe(CHECK_KEY_REQUIRED);
    // Never asked: the configuration is incomplete on its face.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts a local server with no credential", async () => {
    // LM Studio and Ollama legitimately need no key, and demanding one would
    // break the setups this check exists to confirm.
    fetchMock.mockResolvedValue(reply(200, { data: [{ id: "m" }] }));

    const { checkProvider, CHECK_OK } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "http://localhost:1234/v1",
    });

    expect(result.outcome).toBe(CHECK_OK);
  });

  it("accepts a stored key it cannot read, as Nextcloud holds one", async () => {
    // On NC the proxy attaches the credential and the browser never sees it, so
    // hasApiKey is the only evidence a key exists. Treating that as unconfigured
    // would refuse every correctly set up instance.
    fetchMock.mockResolvedValue(reply(200, { data: [{ id: "m" }] }));

    const { checkProvider, CHECK_OK } = await load();
    const result = await checkProvider({
      provider: "openai",
      endpoint: "https://openrouter.ai/api/v1",
      hasApiKey: true,
    });

    expect(result.outcome).toBe(CHECK_OK);
  });
});
