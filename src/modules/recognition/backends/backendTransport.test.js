/**
 * Covers the shared transport helpers.
 *
 * Both are small and both failed loudly in earlier versions: the encoder blew
 * the argument limit on a real page image, and the client resolution ran a
 * dynamic import per request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
