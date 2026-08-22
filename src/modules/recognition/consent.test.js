/**
 * Covers consent for sending handwriting off the device.
 *
 * This is the control standing between a configured cloud endpoint and an
 * upload the user never agreed to, so its edge cases are the point: which
 * destinations count as remote, and what happens when the endpoint changes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let settings = {};

vi.mock("../storage.js", () => ({
  getSetting: async (key) => settings[key] ?? null,
  setSetting: async (key, value) => {
    settings[key] = value;
  },
}));

let consent;

beforeEach(async () => {
  settings = {};
  vi.resetModules();
  consent = await import("./consent.js");
});

describe("destinationHost", () => {
  it("names the host for a remote endpoint", () => {
    expect(consent.destinationHost({ backend: "openai", endpoint: "https://api.x.com/v1" })).toBe(
      "api.x.com",
    );
  });

  it("reports no destination for a model on the user's own machine", () => {
    // Nothing leaves the device, so there is nothing to disclose.
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        consent.destinationHost({ backend: "openai", endpoint: `http://${host}:1234/v1` }),
      ).toBeNull();
    }
  });

  it("treats Replicate as remote regardless of endpoint", () => {
    // Replicate has a fixed API host and no local variant.
    expect(consent.destinationHost({ backend: "replicate", model: "o/n" })).toBe(
      "api.replicate.com",
    );
  });

  it("reports no destination for an unusable endpoint", () => {
    expect(consent.destinationHost({ backend: "openai", endpoint: "" })).toBeNull();
    expect(consent.destinationHost({})).toBeNull();
  });
});

describe("hasConsent", () => {
  const remote = { backend: "openai", endpoint: "https://api.x.com/v1" };

  it("withholds consent that was never given", async () => {
    expect(await consent.hasConsent(remote)).toBe(false);
  });

  it("grants it once recorded for that host", async () => {
    await consent.grantConsent(remote);
    expect(await consent.hasConsent(remote)).toBe(true);
  });

  it("asks again when the endpoint moves to a different host", async () => {
    // Agreeing to send ink to one service is not agreement to send it to the
    // next one configured.
    await consent.grantConsent(remote);
    const moved = { backend: "openai", endpoint: "https://api.other.com/v1" };
    expect(await consent.hasConsent(moved)).toBe(false);
  });

  it("does not ask again for a different path on the same host", async () => {
    await consent.grantConsent(remote);
    expect(
      await consent.hasConsent({ backend: "openai", endpoint: "https://api.x.com/v2/custom" }),
    ).toBe(true);
  });

  it("needs no consent at all for a local endpoint", async () => {
    expect(
      await consent.hasConsent({ backend: "openai", endpoint: "http://localhost:1234/v1" }),
    ).toBe(true);
  });

  it("stops consenting once revoked", async () => {
    await consent.grantConsent(remote);
    await consent.revokeConsent();
    expect(await consent.hasConsent(remote)).toBe(false);
  });

  it("records nothing for a local endpoint, so a later remote one still asks", async () => {
    await consent.grantConsent({ backend: "openai", endpoint: "http://localhost:1234/v1" });
    expect(await consent.hasConsent(remote)).toBe(false);
  });
});
