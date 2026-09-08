/**
 * Covers the shared transport helpers.
 *
 * Both are small and both failed loudly in earlier versions: the encoder blew
 * the argument limit on a real page image, and the client resolution ran a
 * dynamic import per request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./backendTransport.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("@tauri-apps/plugin-http");
});

describe("blobToDataUrl", () => {
  it("produces a PNG data URL that round-trips the bytes", async () => {
    const { blobToDataUrl } = await load();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const url = await blobToDataUrl(new Blob([bytes], { type: "image/png" }));

    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const decoded = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([...bytes]);
  });

  it("encodes an image larger than the engine's argument limit", async () => {
    // A full page PNG has far more bytes than String.fromCharCode.apply accepts
    // in one call, which is why the encoder chunks. A page-sized input is the
    // only input that proves it.
    const { blobToDataUrl } = await load();
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const url = await blobToDataUrl(new Blob([bytes], { type: "image/png" }));

    const decoded = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[299_999]).toBe(bytes[299_999]);
  });

  it("handles an empty image without producing a malformed URL", async () => {
    const { blobToDataUrl } = await load();
    expect(await blobToDataUrl(new Blob([]))).toBe("data:image/png;base64,");
  });
});

describe("getFetch", () => {
  it("prefers Tauri's client, which is not subject to CORS", async () => {
    const tauriFetch = vi.fn();
    vi.doMock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }));

    const { getFetch } = await load();
    expect(await getFetch()).toBe(tauriFetch);
  });

  it("falls back to the platform fetch outside Tauri", async () => {
    vi.doMock("@tauri-apps/plugin-http", () => {
      throw new Error("not bundled");
    });

    const { getFetch } = await load();
    const resolved = await getFetch();
    expect(typeof resolved).toBe("function");
    expect(resolved).not.toBe(globalThis.fetch);
  });

  it("resolves the client once and reuses it", async () => {
    // Which client applies cannot change during a session, and a multi-page run
    // otherwise re-entered the dynamic import for every request.
    let imports = 0;
    const tauriFetch = vi.fn();
    vi.doMock("@tauri-apps/plugin-http", () => {
      imports++;
      return { fetch: tauriFetch };
    });

    const { getFetch } = await load();
    await getFetch();
    await getFetch();
    await getFetch();
    expect(imports).toBe(1);
  });
});

describe("Nextcloud proxy transport", () => {
  /**
   * The NC build reaches vision endpoints only through the app's PHP
   * passthrough. These tests pin the envelope both sides agree on — a mismatch
   * here fails at runtime on NC only, which is the build hardest to notice.
   */
  let fetchMock;

  async function loadAsNextcloud() {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", "nextcloud");
    // Faithful to the real NC bundle: Vite resolves and bundles
    // @tauri-apps/plugin-http, so the import SUCCEEDS. Its fetch only fails
    // later, reaching for window.__TAURI_INTERNALS__. Mocking the import as
    // throwing would model a build that does not exist and would hide the bug
    // this suite exists to catch.
    vi.doMock("@tauri-apps/plugin-http", () => ({
      fetch: () => {
        throw new TypeError(
          'can\'t access property "invoke", window.__TAURI_INTERNALS__ is undefined',
        );
      },
    }));
    return import("./backendTransport.js");
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    globalThis.window = globalThis.window || {};
    window.OC = { requestToken: "tok", generateUrl: (p) => `/nc${p}` };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A dispatch reply from a server that could NOT detach the work, so it did
   * the upstream call inline and the result is already here. This is the shape
   * every non-fpm (or cache-less) Nextcloud returns.
   */
  function envelope(status, body) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ async: false, status, body }),
      text: async () => "",
    };
  }

  /** A dispatch reply that detached the work and handed back a token. */
  function dispatched(token = "a".repeat(32)) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ async: true, token }),
      text: async () => "",
    };
  }

  /** A collect reply. */
  function collected(slot) {
    return { ok: true, status: 200, json: async () => slot, text: async () => "" };
  }

  it("does not use the Tauri client even though the module imports cleanly", async () => {
    // The bug this guards: @tauri-apps/plugin-http is present in the NC bundle,
    // so a try/catch around its import proves nothing. Resolution must key off
    // the build target, or every recognition call on Nextcloud dies inside the
    // Tauri fetch with "__TAURI_INTERNALS__ is undefined".
    fetchMock.mockResolvedValue(envelope(200, "{}"));
    const { getFetch } = await loadAsNextcloud();

    const f = await getFetch();
    await expect(
      f("https://api.replicate.com/v1/predictions", { body: "{}" }),
    ).resolves.toBeTruthy();

    // Routed through the proxy, not the Tauri client.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/recognition/dispatch"),
      expect.anything(),
    );
  });

  it("posts to the proxy route with a CSRF token", async () => {
    fetchMock.mockResolvedValue(envelope(200, '{"ok":true}'));
    const { getFetch } = await loadAsNextcloud();

    const f = await getFetch();
    await f("https://api.replicate.com/v1/predictions", {
      method: "POST",
      body: JSON.stringify({ input: 1 }),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/nc/apps/noteberg/api/recognition/dispatch");
    expect(init.headers.requesttoken).toBe("tok");
    expect(init.credentials).toBe("same-origin");

    const sent = JSON.parse(init.body);
    expect(sent.method).toBe("POST");
    // The body travels as structured JSON, not a re-encoded string.
    expect(sent.body).toEqual({ input: 1 });
  });

  it("polls until a detached transcription completes", async () => {
    // The reason this path exists: dispatch answers at once, so the browser
    // connection closes long before the model does. Nothing in the web server
    // can time out a request that is no longer open.
    fetchMock
      .mockResolvedValueOnce(dispatched())
      .mockResolvedValueOnce(collected({ state: "pending" }))
      .mockResolvedValueOnce(collected({ state: "done", status: 200, body: '{"ok":true}' }));

    const { getFetch } = await loadAsNextcloud();
    const f = await getFetch();
    const res = await f("https://api.openai.com/v1/chat/completions", { body: "{}" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // One dispatch, then collects — and the collects carry the token.
    const routes = fetchMock.mock.calls.map(([u]) => u);
    expect(routes[0]).toContain("/dispatch");
    expect(routes.slice(1).every((u) => u.includes("/collect"))).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).token).toBe("a".repeat(32));
  });

  it("surfaces an error reported through the collected slot", async () => {
    // A detached call fails into the slot rather than into a live request, so
    // the message has to survive the round trip to remain diagnosable.
    fetchMock
      .mockResolvedValueOnce(dispatched())
      .mockResolvedValueOnce(
        collected({ state: "done", error: "Could not reach the recognition endpoint." }),
      );

    const { getFetch } = await loadAsNextcloud();
    const f = await getFetch();

    await expect(f("https://api.openai.com/v1/chat/completions", { body: "{}" })).rejects.toThrow(
      /Could not reach/,
    );
  });

  it("stops polling when the caller aborts", async () => {
    // The work is already detached and cannot be recalled; what must stop is
    // this client waiting for it, so a cancelled job does not poll forever.
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(dispatched()).mockImplementation(async () => {
      controller.abort();
      return collected({ state: "pending" });
    });

    const { getFetch } = await loadAsNextcloud();
    const f = await getFetch();

    await expect(
      f("https://api.openai.com/v1/chat/completions", { body: "{}", signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
  });

  it("passes the caller's timeout budget to the server", async () => {
    // The server does the waiting on the async path too, so it needs the budget:
    // a client-side abort cannot lengthen a cap enforced in PHP.
    fetchMock.mockResolvedValue(envelope(200, "{}"));

    const { getFetch } = await loadAsNextcloud();
    const f = await getFetch();
    await f("https://api.openai.com/v1/chat/completions", { body: "{}", timeoutSeconds: 300 });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).timeoutSeconds).toBe(300);
  });

  it("sends only a path, never a destination", async () => {
    // The server resolves the endpoint from the caller's stored config. If the
    // client could name a host, the proxy would be an open fetcher — an SSRF
    // primitive reaching anything the Nextcloud server can.
    fetchMock.mockResolvedValue(envelope(200, "{}"));
    const { getFetch } = await loadAsNextcloud();

    await (await getFetch())("https://api.replicate.com/v1/predictions", { body: "{}" });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.path).toBe("/v1/predictions");
    expect(sent.url).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("api.replicate.com");
  });

  it("never forwards a credential", async () => {
    // The API key is held server-side and attached there. A client that could
    // supply one would keep the browser-storage exposure alive.
    fetchMock.mockResolvedValue(envelope(200, "{}"));
    const { getFetch } = await loadAsNextcloud();

    await (await getFetch())("https://api.example.com/v1/chat", {
      headers: { Authorization: "Bearer leaked" },
      body: "{}",
    });

    const raw = fetchMock.mock.calls[0][1].body;
    expect(raw).not.toContain("leaked");
    expect(JSON.parse(raw).headers).toBeUndefined();
  });

  it("preserves the query string, which Replicate polling relies on", async () => {
    fetchMock.mockResolvedValue(envelope(200, "{}"));
    const { getFetch } = await loadAsNextcloud();

    await (await getFetch())("https://api.replicate.com/v1/predictions/abc?x=1", {
      method: "GET",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).path).toBe("/v1/predictions/abc?x=1");
  });

  it("unwraps the upstream status so backends see the real reply", async () => {
    // A 401 from the provider must reach the backend as a 401, not as a 200
    // carrying an error — the backends branch on res.ok.
    fetchMock.mockResolvedValue(envelope(401, '{"error":"bad token"}'));
    const { getFetch } = await loadAsNextcloud();

    const res = await (await getFetch())("https://api.example.com/v1/chat", { body: "{}" });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"bad token"}');
  });

  it("exposes json() over the upstream body", async () => {
    fetchMock.mockResolvedValue(envelope(200, '{"status":"succeeded"}'));
    const { getFetch } = await loadAsNextcloud();

    const res = await (await getFetch())("https://api.replicate.com/v1/x", { method: "GET" });

    expect(await res.json()).toEqual({ status: "succeeded" });
  });

  it("fails loudly when the proxy itself rejects the call", async () => {
    // Distinguishable from an upstream error: this one never reached the
    // provider, so retrying the same request will not help.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      text: async () => "too large",
      json: async () => ({}),
    });
    const { getFetch } = await loadAsNextcloud();

    await expect((await getFetch())("https://api.example.com/v1", { body: "{}" })).rejects.toThrow(
      /413/,
    );
  });

  it("handles a GET with no body", async () => {
    // Replicate polling is a GET; JSON.parse(undefined) would throw.
    fetchMock.mockResolvedValue(envelope(200, "{}"));
    const { getFetch } = await loadAsNextcloud();

    await (await getFetch())("https://api.replicate.com/v1/predictions/abc", { method: "GET" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).toBeNull();
  });
});
